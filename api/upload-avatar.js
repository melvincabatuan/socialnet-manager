// api/upload-avatar.js
// ================================================================
// Vercel Serverless Function — Avatar Upload with Busboy + Sharp
//
// WHY THIS FILE EXISTS ON THE SERVER (NOT IN THE BROWSER)
// ─────────────────────────────────────────────────────────
// 1. BLOB_READ_WRITE_TOKEN is a secret. If it were in browser code
//    anyone could open DevTools, copy it, and upload unlimited files
//    to your Vercel Blob storage at your expense.
// 2. sharp uses native C++ bindings (libvips). Browsers cannot run
//    native binaries — this code must run on a Node.js server.
// 3. Server-side validation is the only place you can truly trust
//    file content. A browser could lie about MIME type.
//
// REQUEST EXPECTED
// ─────────────────
//   POST /api/upload-avatar
//   Content-Type: multipart/form-data  (set automatically by the browser)
//   Body field "file": the raw image file
//
// RESPONSE
// ─────────
//   200 { url: "https://..." }           — success, Blob public URL
//   400 { error: "reason" }              — bad request (wrong type, etc.)
//   405 { error: "Method not allowed" }  — not a POST
//   413 { error: "File too large" }      — exceeds 10 MB
//   415 { error: "Unsupported type" }    — not an allowed image format
//   500 { error: "Server error: ..." }   — unexpected failure
//
// PIPELINE
// ─────────
//   Browser file  →  busboy parse  →  sharp compress  →  Vercel Blob  →  URL
// ================================================================

// busboy is a streaming multipart/form-data parser.
// It processes the request as a stream, never writing temp files to disk,
// and correctly handles all edge cases in the multipart format spec:
// boundary variations, quoted strings, multi-line headers, encoding
// declarations, and partial chunks split across TCP packets.
import Busboy from "busboy";

// put() uploads a Buffer to Vercel Blob and returns { url }.
// It reads BLOB_READ_WRITE_TOKEN from the environment automatically.
import { put } from "@vercel/blob";

// sharp is a high-performance Node.js image processing library built
// on top of the C library libvips. It runs 4-5x faster than ImageMagick
// for the resize+convert operations we need.
import sharp from "sharp";

// ── Configuration ────────────────────────────────────────────────
// These constants are defined at the top so a student can adjust
// them without reading through the function logic.

const MAX_DIMENSION = 256; // Output avatar: max 256 × 256 px (aspect ratio preserved)
const WEBP_QUALITY = 80; // WebP quality 0–100. 80 = visually close to lossless, ~4× smaller than JPEG
const WEBP_EFFORT = 6; // Compression effort 0–6. 6 = smallest file, ~10% slower to encode. Fine for server-side.
const ALPHA_QUALITY = 80; // Quality for the WebP alpha (transparency) channel
const MAX_INPUT_MB = 10;
const MAX_INPUT_BYTES = MAX_INPUT_MB * 1024 * 1024;

// Allowed input MIME types. busboy gives us the MIME type declared
// by the browser; sharp provides the second layer of validation by
// refusing to decode non-image data regardless of the declared type.
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/jpg", // some browsers send this variant
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
]);

// ── Vercel route configuration ───────────────────────────────────
// bodyParser: false — Vercel must NOT pre-parse the request body.
//   If bodyParser is left enabled, Vercel consumes and discards the
//   raw stream before our code runs, leaving busboy with nothing to read.
// sizeLimit: "10mb" — Vercel enforces this at the network edge before
//   the function even starts, protecting against very large payloads
//   that would waste compute time.
export const config = {
  api: {
    bodyParser: false,
    sizeLimit: "10mb",
  },
};

// ================================================================
// parseBusboy — wraps busboy's event-based API in a Promise so we
// can use async/await instead of callbacks.
//
// WHY BUSBOY INSTEAD OF MANUAL PARSING
// ──────────────────────────────────────
// The multipart/form-data format (RFC 7578) has many edge cases that
// a hand-rolled parser would miss or mishandle:
//
//   • Boundary strings can be quoted or unquoted
//   • Headers within each part can be folded across multiple lines
//   • Content-Transfer-Encoding can be base64, quoted-printable, or 8bit
//   • Chunk boundaries in the TCP stream do not align with part boundaries
//   • Filenames can contain escaped characters or be UTF-8 encoded
//
// busboy handles all of these correctly and is the same parser used
// by Express (multer), Fastify, and Next.js internally.
//
// Returns a Promise that resolves to { fileBuffer, filename, mimetype }
// or rejects with an Error if no file field is found or parsing fails.
// ================================================================
function parseBusboy(req) {
  return new Promise((resolve, reject) => {
    // Busboy is initialised with the request headers so it can find
    // the boundary string embedded in Content-Type, e.g.:
    //   multipart/form-data; boundary=----WebKitFormBoundaryXYZ
    const bb = Busboy({
      headers: req.headers,
      limits: {
        // fileSize: reject files larger than our limit AT THE STREAM LEVEL.
        // This means busboy stops reading after MAX_INPUT_BYTES and emits
        // the "limit" event — we never buffer a 1 GB file into RAM.
        fileSize: MAX_INPUT_BYTES,
        // files: 1 — reject requests that try to upload more than one file.
        files: 1,
        // fields: 0 — we do not expect any non-file form fields.
        // Setting this to 0 means extra fields are silently discarded.
        fields: 0,
      },
    });

    // These variables are populated as busboy emits events
    let fileBuffer = null;
    let filename = "avatar";
    let mimetype = "application/octet-stream";
    let fileTooLarge = false;

    // ── "file" event ─────────────────────────────────────────────
    // Fired once for each file field in the form. We expect exactly
    // one file field named "file" (matching formData.append("file", ...) in app.js).
    //
    // "file"    — the field name from the HTML form
    // "stream"  — a Readable stream of the file's raw bytes
    // "info"    — object containing { filename, encoding, mimeType }
    bb.on("file", (fieldname, stream, info) => {
      filename = info.filename || "avatar";
      mimetype = info.mimeType || "application/octet-stream";

      // Collect the stream chunks into an array of Buffers.
      // Buffer.concat() at the end combines them into one contiguous
      // block of memory that sharp can read.
      const chunks = [];

      stream.on("data", (chunk) => {
        chunks.push(chunk);
      });

      // The "limit" event fires if busboy hit the fileSize limit.
      // We set a flag here and check it in the "close" event below.
      stream.on("limit", () => {
        fileTooLarge = true;
        // Resume and drain the stream so busboy can clean up properly.
        // If we do not drain it, the underlying TCP socket may stall.
        stream.resume();
      });

      stream.on("end", () => {
        // Only assemble the buffer if we did not exceed the size limit.
        // If fileTooLarge is true the chunks array is partial — we discard it.
        if (!fileTooLarge) {
          fileBuffer = Buffer.concat(chunks);
        }
      });

      stream.on("error", reject); // propagate stream errors to the outer catch
    });

    // ── "close" event ─────────────────────────────────────────────
    // Fired when busboy has finished parsing the entire request body.
    // At this point all "file" events and their streams have completed.
    bb.on("close", () => {
      if (fileTooLarge) {
        reject(new RangeError(`FILE_TOO_LARGE`));
        return;
      }
      if (!fileBuffer) {
        reject(new TypeError("NO_FILE_FOUND"));
        return;
      }
      resolve({ fileBuffer, filename, mimetype });
    });

    bb.on("error", reject); // propagate busboy-level parse errors

    // Pipe the raw HTTP request body into busboy.
    // busboy reads the stream, fires the events above, and then closes.
    req.pipe(bb);
  });
}

// ================================================================
// handler — the main function Vercel calls for every HTTP request
// to /api/upload-avatar.
// ================================================================
export default async function handler(req, res) {
  // ── Method guard ─────────────────────────────────────────────
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  try {
    // ── Step 1: Parse the multipart body with busboy ──────────────
    // All the streaming complexity is encapsulated in parseBusboy().
    // If anything goes wrong (no file, too large, malformed request)
    // it rejects with a typed error that we catch below.
    let fileBuffer, filename, mimetype;

    try {
      ({ fileBuffer, filename, mimetype } = await parseBusboy(req));
    } catch (parseErr) {
      // Translate typed errors from parseBusboy into HTTP responses
      if (
        parseErr instanceof RangeError &&
        parseErr.message.startsWith("FILE_TOO_LARGE")
      ) {
        return res.status(413).json({
          error: `File too large. Maximum allowed size is 10 MB.`,
        });
      }
      if (
        parseErr instanceof TypeError &&
        parseErr.message === "NO_FILE_FOUND"
      ) {
        return res.status(400).json({
          error:
            'No file received. Send the image as a form field named "file".',
        });
      }
      // Re-throw anything else (e.g. missing boundary in Content-Type)
      throw parseErr;
    }

    // ── Step 2: Validate MIME type ────────────────────────────────
    // The browser-supplied MIME type is a first filter. sharp provides
    // the definitive check by attempting to decode the actual bytes.
    if (!ALLOWED_TYPES.has(mimetype)) {
      return res.status(415).json({
        error: `Unsupported file type "${mimetype}". Allowed: JPEG, PNG, GIF, WebP, BMP, TIFF.`,
      });
    }

    // ── Step 3: Compress and convert with sharp ───────────────────
    //
    // .rotate()
    //   Read EXIF orientation data and physically rotate the pixels.
    //   Without this, a photo taken in portrait mode on most phones
    //   will appear rotated 90° because EXIF orientation is normally
    //   applied by the viewer — Vercel Blob does not apply it.
    //
    // .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
    //   Shrink the image so BOTH dimensions fit within the box while
    //   preserving the original aspect ratio.
    //   - fit: "inside"  →  a 600×400 image becomes 256×171 (not cropped)
    //   - withoutEnlargement  →  a 50×50 image stays 50×50 (never scaled up)
    //
    // .webp({ quality, effort, alphaQuality })
    //   Convert to WebP. WebP is ~30% smaller than JPEG at equivalent
    //   quality. effort: 6 is the maximum compression pass count —
    //   it adds ~10% CPU time but reduces file size by another ~5-8%.
    //   alphaQuality preserves PNG transparency channels.
    //
    // .toBuffer()
    //   Run the pipeline in memory and return the result as a Buffer.
    //   Nothing is written to disk (Vercel's filesystem is read-only
    //   in production anyway).
    const processedBuffer = await sharp(fileBuffer)
      .rotate()
      .resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({
        quality: WEBP_QUALITY,
        effort: WEBP_EFFORT,
        alphaQuality: ALPHA_QUALITY,
      })
      .toBuffer();

    // ── Step 4: Build a unique Blob path ──────────────────────────
    // We derive a sanitized base name from the original filename,
    // append a timestamp + random suffix to prevent collisions, and
    // place it in the "avatars/" prefix folder inside Blob storage.
    //
    // Sanitization rules:
    //   - Remove the file extension (we always output .webp)
    //   - Keep only alphanumeric characters, hyphens, and underscores
    //   - Replace spaces and special characters with underscores
    //   - Cap the name at 60 characters to stay well within URL limits
    //   - Fall back to "avatar" if nothing safe remains after sanitization
    const rawBase = (filename || "avatar").replace(/\.[^.]+$/, ""); // strip extension
    const safeName =
      rawBase
        .replace(/\s+/g, "_") // spaces → underscores
        .replace(/[^a-zA-Z0-9_-]/g, "") // remove everything else unsafe
        .slice(0, 60) || // cap length
      "avatar"; // fallback

    // Collision-resistant suffix: millisecond timestamp + 9-digit random integer
    const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
    const blobPath = `avatars/${safeName}_${uniqueSuffix}.webp`;

    // ── Step 5: Upload to Vercel Blob ─────────────────────────────
    // put() reads BLOB_READ_WRITE_TOKEN from process.env automatically.
    // We never reference the token directly in code — it stays in
    // Vercel's encrypted environment variable store.
    //
    // access: "public"  →  the returned URL is reachable by any browser
    //                       without authentication, required for <img src>.
    // addRandomSuffix: false  →  we already added our own unique suffix above;
    //                            disabling Blob's own suffix keeps the URL clean.
    const blob = await put(blobPath, processedBuffer, {
      access: "public",
      contentType: "image/webp",
      addRandomSuffix: false,
    });

    // ── Step 6: Log and respond ───────────────────────────────────
    const inputKB = (fileBuffer.byteLength / 1024).toFixed(1);
    const outputKB = (processedBuffer.byteLength / 1024).toFixed(1);
    console.log(
      `[upload-avatar] ${filename} | ${inputKB} KB → ${outputKB} KB (WebP) | ${blob.url}`,
    );

    return res.status(200).json({
      url: blob.url,
      sizeKB: Number(outputKB),
      message: "Avatar uploaded and compressed successfully.",
    });
  } catch (err) {
    // Catch-all: sharp decode failure (corrupt file), Blob network error, etc.
    console.error("[upload-avatar] Unexpected error:", err);

    // Expose the error message in development to help with debugging,
    // but hide it in production so internal details are not leaked.
    const detail =
      process.env.NODE_ENV === "development" ? err.message : undefined;

    return res.status(500).json({
      error: "Server error while processing the upload.",
      details: detail,
    });
  }
}