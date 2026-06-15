#!/usr/bin/env node
// scripts/patch-vetkeys-esm.mjs
//
// Workaround for a packaging bug in @dfinity/vetkeys 0.4.0:
// the package's `exports.".".import` resolves to `dist/lib/index.es.js`,
// but the package has no `"type": "module"` field, so Node treats
// that file as CJS — which then crashes on the `import` statement
// inside it. Vite handles this fine because Vite has its own ESM
// resolver. tsx + plain Node don't.
//
// Fix: drop a `dist/lib/package.json` containing `{"type": "module"}`
// inside the package's dist/lib directory. This is the canonical
// per-directory "this folder is ESM" override in Node. Idempotent;
// we just overwrite the file each install.
//
// Run automatically via the `postinstall` script in package.json.
// Also safe to run by hand after a clean `pnpm install`.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function findVetkeysDistLib() {
  // Walk node_modules/.pnpm looking for the @dfinity+vetkeys@* dir,
  // then into @dfinity/vetkeys/dist/lib.
  const pnpmRoot = join(repoRoot, "node_modules", ".pnpm");
  if (!existsSync(pnpmRoot)) return null;
  for (const entry of readdirSync(pnpmRoot)) {
    if (entry.startsWith("@dfinity+vetkeys@")) {
      const distLib = join(pnpmRoot, entry, "node_modules", "@dfinity", "vetkeys", "dist", "lib");
      if (existsSync(distLib)) return distLib;
    }
  }
  return null;
}

const target = findVetkeysDistLib();
if (!target) {
  // vetkeys isn't installed (e.g. the install only fetched devDeps,
  // or the user has pruned it). Nothing to do.
  process.exit(0);
}

const marker = join(target, "package.json");
const wanted = '{\n  "type": "module"\n}\n';

if (existsSync(marker)) {
  const existing = readFileSync(marker, "utf8");
  if (existing === wanted) {
    console.log("[patch-vetkeys] already patched:", marker);
    process.exit(0);
  }
}

writeFileSync(marker, wanted, "utf8");
console.log("[patch-vetkeys] wrote", marker);
