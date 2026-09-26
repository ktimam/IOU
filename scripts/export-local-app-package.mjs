// Explicit local export only. No uploads, model downloads, account access, or production writes.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argument = process.argv.slice(2);
if (argument.length !== 2 || argument[0] !== "--destination") {
  throw new Error("Usage: node scripts/export-local-app-package.mjs --destination http://localhost:3000/openchat/import");
}
// Use the already installed Vite dependency; do not fetch/install a new bundler.
const requireFromVite = createRequire(import.meta.resolve("vite"));
const { build } = requireFromVite("esbuild");
const common = { bundle: true, write: false, minify: true, sourcemap: false, target: "es2022",
  define: { "import.meta.env": "{}" }, logLevel: "silent" };
const built = await build({ ...common, entryPoints: [path.join(root, "src/features/openchat/localProcessorArtifact.worker.ts")], format: "iife", platform: "browser" });
const source = built.outputFiles[0].contents;
const sha256 = createHash("sha256").update(source).digest("hex");
const generator = await build({ ...common, entryPoints: [path.join(root, "src/features/openchat/localAppPackage.ts")], format: "cjs", platform: "node" });
const context = vm.createContext({ module: { exports: {} }, URL, TextEncoder });
vm.runInContext(generator.outputFiles[0].text, context, { timeout: 1000 });
const metadata = { version: 1, sha256, byteLength: source.byteLength, protocol: "oc:local-process:request" };
const catalog = context.module.exports.createIouLocalAppPackage(argument[1], { sha256, byteLength: source.byteLength });
const output = path.join(root, "public/openchat");
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, "local-processor-v1.js"), source);
writeFileSync(path.join(output, "local-processor-v1.sha256.json"), JSON.stringify(metadata, null, 2) + "\n");
writeFileSync(path.join(output, "local-app-v1.json"), JSON.stringify(catalog, null, 2) + "\n");
console.log(`IOU local package generated: ${source.byteLength} bytes; SHA-256 ${sha256}`);
