import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");

// Only what the extension actually loads at runtime. Tests, the Tailwind
// source, the docs and node_modules are deliberately absent: everything in
// this list ships to users, so the list is opt-in rather than opt-out.
const runtimeFiles = [
  "manifest.json",
  "background.js",
  "content-script.js",
  "extractor.js",
  "popup.html",
  "popup.js",
  "utils.js",
  "tailwind.output.css",
  "icons/run-16.png",
  "icons/run-48.png",
  "icons/run-128-logo.png",
  "icons/info-128.png",
];

await rm(output, { recursive: true, force: true });

for (const file of runtimeFiles) {
  const destination = resolve(output, file);
  await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(root, file), destination);
}

/**
 * Fail the build if the bundle references a file it does not contain.
 *
 * A missing icon or script only shows up as a broken popup after upload, so
 * it is worth catching here: the runtime list above is maintained by hand.
 */
const manifest = JSON.parse(await readFile(resolve(output, "manifest.json"), "utf8"));
const references = new Set();

const collect = (value) => {
  if (typeof value === "string") {
    if (/\.(js|css|html|png|svg|json)$/.test(value)) references.add(value);
  } else if (value && typeof value === "object") {
    Object.values(value).forEach(collect);
  }
};
collect(manifest);

const popup = await readFile(resolve(output, "popup.html"), "utf8");
for (const [, href] of popup.matchAll(/(?:src|href)="([^"]+)"/g)) {
  if (!/^https?:/.test(href)) references.add(href);
}

const missing = [...references].filter((file) => !existsSync(resolve(output, file)));
if (missing.length) {
  console.error(`Bundle references files it does not contain:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

// Chrome Web Store expects manifest.json at the root of the archive, so zip
// from inside dist/ rather than zipping the directory itself.
const zipName = `strava-segment-comparator-${manifest.version}.zip`;
const zipPath = resolve(root, zipName);
await rm(zipPath, { force: true });

try {
  execFileSync("zip", ["-r", "-q", "-X", zipPath, ".", "-x", ".*"], { cwd: output });
} catch (error) {
  console.error(`Could not create ${zipName}: ${error.message}`);
  process.exit(1);
}

const { size } = await stat(zipPath);
console.log(`Built ${runtimeFiles.length} files in dist/`);
console.log(`Packaged ${zipName} (${(size / 1024).toFixed(1)} KB) for upload`);
