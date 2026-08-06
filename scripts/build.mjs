import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");
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

console.log(`Built ${runtimeFiles.length} extension files in dist/`);
