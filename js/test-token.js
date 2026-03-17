import { list } from "@vercel/blob";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

async function fullDiagnostic() {
  console.log("VERCEL BLOB DIAGNOSTIC TOOL");
  console.log("==============================\n");

  // 1. Environment info
  console.log("ENVIRONMENT INFO:");
  console.log(`Node version: ${process.version}`);
  console.log(`Platform: ${process.platform}`);

  // 2. Package.json check
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "package.json"), "utf8"),
    );
    console.log(
      `@vercel/blob version: ${pkg.dependencies?.["@vercel/blob"] || pkg.devDependencies?.["@vercel/blob"] || "not found"}`,
    );
  } catch (e) {
    console.log("Could not read package.json");
  }

  // 3. Token check
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  console.log(`\n TOKEN CHECK:`);
  console.log(`Token exists: ${!!token}`);
  if (token) {
    console.log(`Token length: ${token.length}`);
    console.log(`Token starts with: ${token.substring(0, 10)}...`);
    console.log(
      `Token format: ${token.includes("vercel_blob") ? "vercel_blob format" : "unknown format"}`,
    );
  }

  // 4. Test connection
  console.log(`\n TESTING CONNECTION:`);
  try {
    const result = await list();
    console.log(` SUCCESS! Found ${result.blobs.length} blobs`);
    if (result.blobs.length > 0) {
      console.log(`Sample blob: ${result.blobs[0].pathname}`);
    }
  } catch (error) {
    console.error(`  FAILED: ${error.message}`);

    // More specific token format check
    const isRealBlobToken =
      token && token.startsWith("vercel_blob_rw_") && token.length > 80;
    const isApiToken =
      token &&
      token.startsWith("vercel_") &&
      !token.startsWith("vercel_blob_rw_");

    if (isApiToken) {
      console.log(
        "TOKEN TYPE: This looks like a Vercel API token, NOT a Blob token.",
      );
      console.log(
        "  Vercel API tokens start with 'vercel_' and are ~64 chars.",
      );
      console.log(
        "  Blob tokens start with 'vercel_blob_rw_' and are 100+ chars.",
      );
      console.log(
        "  Go to: Vercel Dashboard -> your project -> Storage -> your Blob store -> .env.local tab",
      );
    } else if (isRealBlobToken) {
      console.log(
        "TOKEN TYPE: Correct format (vercel_blob_rw_..., 100+ chars).",
      );
    } else {
      console.log("TOKEN TYPE: Unrecognized format.");
    }
  }
}

fullDiagnostic();