// batch_upload_avatars.js
// ================================================================
// LOCAL BATCH UPLOAD SCRIPT
// Run once from your project root to upload all profile images
// from resources/images/ to Vercel Blob.
//
// USAGE
// ──────
//   node batch_upload_avatars.js
//
// PREREQUISITES
// ──────────────
//   1. Install dependencies if not already done:
//        npm install
//      (this installs @vercel/blob, and sharp from package.json)
//
//   2. Set your Vercel Blob write token in the terminal before running:
//
//      Windows Command Prompt:
//        set BLOB_READ_WRITE_TOKEN=your_token_here
//
//      Windows PowerShell:
//        $env:BLOB_READ_WRITE_TOKEN="your_token_here"
//
//      macOS / Linux / Git Bash:
//        export BLOB_READ_WRITE_TOKEN=your_token_here
//
//      Where to find your token:
//        Vercel Dashboard → your project → Storage → your Blob store
//        → ".env.local" tab → copy the BLOB_READ_WRITE_TOKEN value
//
//   3. Run:
//        node upload_avatars.js
//
// WHAT THE SCRIPT DOES
// ─────────────────────
//   For every .png / .jpg / .jpeg / .gif / .webp / .bmp / .tiff
//   file found in INPUT_FOLDER:
//
//     1. Read the raw image file from disk into memory
//     2. Pass it through sharp:
//          - Auto-rotate based on EXIF orientation (fixes phone photos)
//          - Resize to fit within 256 × 256 px (preserves aspect ratio,
//            never enlarges a small image)
//          - Convert to WebP at quality 80 with effort 6
//     3. Upload the compressed WebP to Vercel Blob at:
//            avatars/<original-name-without-extension>.webp
//        e.g.  resources/images/ada.png  →  avatars/ada.webp
//     4. Print the resulting public URL
//
//   After all files are processed a summary table is printed showing
//   the original size, compressed size, savings percentage, and the
//   Blob URL for each file.
//
// OUTPUT IN SUPABASE
// ───────────────────
//   After the script finishes, run the SQL in update_picture_urls.sql
//   (printed at the end of this script's output) to update the picture
//   column in Supabase with the new Blob URLs.
//
// ================================================================

import { put } from "@vercel/blob";
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";

// ── Configuration ────────────────────────────────────────────────
// Change INPUT_FOLDER if your images live somewhere else.
// All other constants mirror the serverless function so output
// quality is identical whether images are uploaded via the UI
// or via this batch script.

const INPUT_FOLDER = "../resources/images"; // relative to project js folder
const MAX_DIMENSION = 256; // max width or height in pixels
const WEBP_QUALITY = 80; // 0–100, higher = larger file
const WEBP_EFFORT = 6; // 0–6, higher = smaller file, slower
const ALPHA_QUALITY = 80; // transparency channel quality
const CONCURRENT = 5; // files processed in parallel per batch
// lower this if you hit Blob rate limits

// File extensions this script will process (case-insensitive)
const SUPPORTED = /\.(png|jpg|jpeg|gif|webp|bmp|tiff?)$/i;

// ── Utility: left-pad a string for aligned table output ──────────
function pad(str, width) {
  return String(str).padStart(width);
}

// ── processOne ───────────────────────────────────────────────────
// Reads one image file, compresses it with sharp, uploads it to
// Vercel Blob, and returns a result object for the summary table.
//
// Parameters
//   filePath  — full path to the source image, e.g. "resources/images/ada.png"
//
// Returns
//   { file, inputBytes, outputBytes, url }  on success
//   { file, error }                         on failure
// ────────────────────────────────────────────────────────────────
async function processOne(filePath) {
  // The original filename without its folder prefix, e.g. "ada.png"
  const originalName = path.basename(filePath);

  // The filename without extension, used as the Blob storage key, e.g. "ada"
  const baseName = path.parse(filePath).name;

  try {
    // ── Step 1: Read the raw file from disk ───────────────────────
    // fs.readFile returns a Node Buffer (binary data in memory).
    // sharp can accept a Buffer directly — no temp files needed.
    const inputBuffer = await fs.readFile(filePath);

    // ── Step 2: Compress and convert with sharp ───────────────────
    //
    // .rotate()
    //   Reads the EXIF orientation tag and physically rotates pixels
    //   so the image appears upright regardless of what software views it.
    //   This is especially important for photos taken on phones, which
    //   embed orientation in EXIF rather than rotating the actual pixels.
    //
    // .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
    //   "inside" means the image is scaled down until BOTH width AND
    //   height fit within the 256×256 box, keeping the original aspect
    //   ratio. A landscape 400×200 becomes 256×128. A portrait 200×400
    //   becomes 128×256. A tiny 50×50 stays 50×50 (withoutEnlargement).
    //
    // .webp({ quality, effort, alphaQuality })
    //   Converts to WebP format. Typical savings vs JPEG: 25–35%.
    //   effort: 6 uses the maximum number of compression passes and
    //   produces the smallest file at the cost of ~10% more CPU time —
    //   acceptable for a one-time batch script.
    //
    // .toBuffer()
    //   Executes the pipeline entirely in memory and returns the result
    //   as a Buffer ready to pass directly to put().
    const outputBuffer = await sharp(inputBuffer)
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

    // ── Step 3: Upload to Vercel Blob ─────────────────────────────
    // The Blob path determines how the file is organized in storage
    // and forms part of the public URL.
    //
    // avatars/ada.webp  →  https://xxxx.public.blob.vercel-storage.com/avatars/ada.webp
    //
    // addRandomSuffix: false  — keep the filename clean and predictable
    //   so re-running the script with the same file produces the same
    //   URL (Blob will overwrite the existing object at that path).
    //
    // put() reads BLOB_READ_WRITE_TOKEN from process.env automatically.
    // If the variable is not set it throws immediately with a clear error.
    const blobPath = `avatars/${baseName}.webp`;

    const blob = await put(blobPath, outputBuffer, {
      access: "public", // URL is reachable without authentication
      contentType: "image/webp",
      addRandomSuffix: false, // deterministic URL per filename
    });

    return {
      file: originalName,
      inputBytes: inputBuffer.byteLength,
      outputBytes: outputBuffer.byteLength,
      url: blob.url,
    };
  } catch (err) {
    // Return an error record so the batch continues and other files
    // are not blocked by one bad file.
    return {
      file: originalName,
      error: err.message,
    };
  }
}

// ── main ─────────────────────────────────────────────────────────
// Entry point. Scans the input folder, processes files in batches,
// prints a summary table, and outputs the SQL UPDATE statement.
// ────────────────────────────────────────────────────────────────
async function main() {
  // ── Guard: BLOB_READ_WRITE_TOKEN must be set ──────────────────
  // Fail fast with a clear message instead of letting put() throw
  // a confusing network error.
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error(
      "\n[ERROR] BLOB_READ_WRITE_TOKEN environment variable is not set.",
    );
    console.error(
      "        Set it before running this script. See the usage instructions at the top of this file.\n",
    );
    process.exit(1);
  }

  // ── Scan the input folder ─────────────────────────────────────
  let allFiles;
  try {
    allFiles = await fs.readdir(INPUT_FOLDER);
  } catch {
    console.error(`\n[ERROR] Could not read folder: "${INPUT_FOLDER}"`);
    console.error(
      `        Create the folder and add your images, then try again.\n`,
    );
    process.exit(1);
  }

  // Keep only files whose extension matches the supported list
  const imageFiles = allFiles
    .filter((f) => SUPPORTED.test(f))
    .map((f) => path.join(INPUT_FOLDER, f)); // build full paths

  if (imageFiles.length === 0) {
    console.log(
      `\n[INFO] No supported image files found in "${INPUT_FOLDER}". Nothing to do.\n`,
    );
    process.exit(0);
  }

  console.log(
    `\nFound ${imageFiles.length} image(s) in "${INPUT_FOLDER}". Starting upload...\n`,
  );

  // ── Process in batches ────────────────────────────────────────
  // Processing all files simultaneously risks hitting Vercel Blob's
  // rate limit (typically 100 requests/second on the free tier).
  // Batching with CONCURRENT = 5 keeps us well within that limit
  // while still being much faster than sequential processing.
  const results = [];

  for (let i = 0; i < imageFiles.length; i += CONCURRENT) {
    const batch = imageFiles.slice(i, i + CONCURRENT);
    const batchNumber = Math.floor(i / CONCURRENT) + 1;
    const totalBatches = Math.ceil(imageFiles.length / CONCURRENT);

    process.stdout.write(
      `  Batch ${batchNumber}/${totalBatches}: processing ${batch.length} file(s)...`,
    );

    // Promise.all runs all files in the batch concurrently.
    // processOne never throws (it catches internally), so Promise.all
    // always resolves even if individual files fail.
    const batchResults = await Promise.all(batch.map(processOne));
    results.push(...batchResults);

    const batchSuccesses = batchResults.filter((r) => !r.error).length;
    console.log(` done (${batchSuccesses}/${batchResults.length} succeeded)`);
  }

  // ── Print summary table ───────────────────────────────────────
  const successes = results.filter((r) => !r.error);
  const failures = results.filter((r) => r.error);

  console.log("\n" + "─".repeat(90));
  console.log(
    pad("FILE", 28),
    pad("ORIGINAL", 10),
    pad("COMPRESSED", 12),
    pad("SAVINGS", 9),
    "  URL",
  );
  console.log("─".repeat(90));

  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.file.padEnd(26)} [FAILED] ${r.error}`);
    } else {
      const origKB = (r.inputBytes / 1024).toFixed(1);
      const compKB = (r.outputBytes / 1024).toFixed(1);
      const savedPct = (
        ((r.inputBytes - r.outputBytes) / r.inputBytes) *
        100
      ).toFixed(0);
      console.log(
        pad(r.file, 28),
        pad(origKB + " KB", 10),
        pad(compKB + " KB", 12),
        pad(savedPct + "%", 9),
        " ",
        r.url,
      );
    }
  }

  console.log("─".repeat(90));

  // Totals row
  const totalOrigBytes = successes.reduce((s, r) => s + r.inputBytes, 0);
  const totalCompBytes = successes.reduce((s, r) => s + r.outputBytes, 0);
  const totalSaved =
    totalOrigBytes > 0
      ? (((totalOrigBytes - totalCompBytes) / totalOrigBytes) * 100).toFixed(0)
      : 0;

  console.log(
    pad("TOTAL (" + successes.length + " files)", 28),
    pad((totalOrigBytes / 1024).toFixed(1) + " KB", 10),
    pad((totalCompBytes / 1024).toFixed(1) + " KB", 12),
    pad(totalSaved + "%", 9),
  );
  console.log("─".repeat(90));

  if (failures.length > 0) {
    console.log(
      `\n[WARNING] ${failures.length} file(s) failed to upload (see FAILED rows above).`,
    );
  }

  // ── Generate SQL UPDATE statements ───────────────────────────
  // After uploading, run these statements in the Supabase SQL Editor
  // to update the picture column for each seeded profile.
  if (successes.length > 0) {
    console.log("\n" + "=".repeat(90));
    console.log("NEXT STEP: run the following SQL in your Supabase SQL Editor");
    console.log("           to update the picture column for each profile.");
    console.log("=".repeat(90) + "\n");

    // One UPDATE per file, matching on the base filename convention
    // used in the seed script (e.g. ada.png → Ada Lovelace's picture).
    // The WHERE clause uses the Blob URL pattern so only rows that
    // still point to the old local path are updated.
    console.log("-- Update picture URLs to Vercel Blob");
    console.log(
      "-- Run this entire block at once in the Supabase SQL Editor\n",
    );

    for (const r of successes) {
      // Derive the old local path from the original filename
      // e.g.  ada.png  →  resources/images/ada.png
      const oldPath = "resources/images/" + r.file;

      // Escape single quotes in the URL (Blob URLs should never have
      // them, but this keeps the SQL safe regardless)
      const safeUrl = r.url.replace(/'/g, "''");

      console.log(`UPDATE profiles SET picture = '${safeUrl}'`);
      console.log(`  WHERE picture = '${oldPath}';`);
    }

    // Also update the column DEFAULT so new profiles get the Blob URL
    // of default.webp rather than the old local path.
    const defaultResult = successes.find((r) => r.file.startsWith("default"));
    if (defaultResult) {
      const safeDefaultUrl = defaultResult.url.replace(/'/g, "''");
      console.log(`\n-- Update the column default for new profiles`);
      console.log(`ALTER TABLE profiles`);
      console.log(`  ALTER COLUMN picture SET DEFAULT '${safeDefaultUrl}';`);
    }

    console.log(
      "\n-- Verify: these rows should still use old local paths after running the above",
    );
    console.log(
      "SELECT id, name, picture FROM profiles WHERE picture NOT LIKE 'https://%' ORDER BY name;\n",
    );
  }

  // Exit with code 1 if any uploads failed so CI/CD pipelines can detect it
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n[FATAL] Unexpected error:", err.message);
  process.exit(1);
});