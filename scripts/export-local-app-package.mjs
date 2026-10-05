// Explicit local export only. No uploads, model downloads, account access, or production writes.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createLocalAppPublicDirectory, verifyCatalogOnlyProcessor } from "./lib/local-app-publication.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argument = process.argv.slice(2);
const usage = () => { throw new Error("Usage: node scripts/export-local-app-package.mjs --destination <import URL> [--catalog-only] [--output-directory <staging directory>]"); };
if (argument.length < 2 || argument[0] !== "--destination" || !argument[1]) usage();
let catalogOnly = false;
const publicOutput = path.join(root, "public/openchat");
let output = publicOutput;
let outputSpecified = false;
for (let index = 2; index < argument.length; index++) {
  if (argument[index] === "--catalog-only" && !catalogOnly) catalogOnly = true;
  else if (argument[index] === "--output-directory" && !outputSpecified && argument[index + 1]) {
    output = path.resolve(argument[++index]); outputSpecified = true;
  } else usage();
}
// Use the already installed Vite dependency; do not fetch/install a new bundler.
const requireFromVite = createRequire(import.meta.resolve("vite"));
const { build } = requireFromVite("esbuild");
const common = { bundle: true, write: false, minify: true, sourcemap: false, target: "es2022",
  define: { "import.meta.env": "{}" }, logLevel: "silent" };
let source;
let metadata;
let retainedMetadataBytes;
if (catalogOnly) {
  source = readFileSync(path.join(publicOutput, "local-processor-v1.js"));
  retainedMetadataBytes = readFileSync(path.join(publicOutput, "local-processor-v1.sha256.json"));
  metadata = verifyCatalogOnlyProcessor({ processorBytes: source, metadataBytes: retainedMetadataBytes,
    catalogBytes: readFileSync(path.join(publicOutput, "local-app-v1.json")),
    directoryBytes: readFileSync(path.join(publicOutput, "apps-v1.json")),
  });
} else {
  const built = await build({ ...common, entryPoints: [path.join(root, "src/features/openchat/localProcessorArtifact.worker.ts")], format: "iife", platform: "browser" });
  source = built.outputFiles[0].contents;
  metadata = { version: 1, sha256: createHash("sha256").update(source).digest("hex"), byteLength: source.byteLength, protocol: "oc:local-process:request" };
}
const generator = await build({ ...common, entryPoints: [path.join(root, "src/features/openchat/localAppPackage.ts")], format: "cjs", platform: "node" });
const context = vm.createContext({ module: { exports: {} }, URL, TextEncoder });
vm.runInContext(generator.outputFiles[0].text, context, { timeout: 1000 });
const catalog = context.module.exports.createIouLocalAppPackage(argument[1], { sha256: metadata.sha256, byteLength: metadata.byteLength });
const catalogBytes = Buffer.from(JSON.stringify(catalog, null, 2) + "\n");
const directory = createLocalAppPublicDirectory(catalog, catalogBytes, metadata);
mkdirSync(output, { recursive: true });
// Catalog-only writes never replace a served processor. A staging directory
// receives an exact copy solely to let reviewers verify a complete publication.
if (!catalogOnly || output !== publicOutput) {
  writeFileSync(path.join(output, "local-processor-v1.js"), source);
  writeFileSync(path.join(output, "local-processor-v1.sha256.json"), retainedMetadataBytes ?? JSON.stringify(metadata, null, 2) + "\n");
}
writeFileSync(path.join(output, "local-app-v1.json"), catalogBytes);
writeFileSync(path.join(output, "apps-v1.json"), JSON.stringify(directory, null, 2) + "\n");
console.log(`IOU local ${catalogOnly ? "catalog-only" : "package"} export: ${output}; processor ${source.byteLength} bytes; SHA-256 ${metadata.sha256}`);
