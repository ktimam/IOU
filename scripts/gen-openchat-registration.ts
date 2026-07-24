// Regenerate docs/openchat-registration.json from the SOURCE OF TRUTH (actionManifest.ts).
//
// The registration JSON is a human-reference "paste JSON": the fields the manifest owns
// (promptTemplate, responseSchema, rules, perUserKeys) are copied here so a human can paste them into
// OpenChat's registration UI, but actionManifest.ts is authoritative — buildManifestWire() always
// registers the manifest's prompt/schema/rules regardless, and warns when this file has drifted. Run
// this to re-sync the copy (the base manifest = no per-user templates, exactly what the Node CLI
// registers). Paste-only fields (name, description, card, endpoint) are preserved verbatim.
//
//   pnpm exec tsx scripts/gen-openchat-registration.ts
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { iouActionManifest, buildIouOutputSchema, buildIouRules } from "../src/features/openchat/actionManifest";

const here = dirname(fileURLToPath(import.meta.url));
const docPath = join(here, "..", "docs", "openchat-registration.json");

const doc = JSON.parse(readFileSync(docPath, "utf8")) as Record<string, unknown>;

// Manifest-authoritative fields — the base manifest ([] templates), matching what the Node registrar
// sends. Everything else in the doc (name/description/card/endpoint) is paste-only and left as-is.
const regenerated = {
  ...doc,
  promptTemplate: iouActionManifest.prompt,
  responseSchema: buildIouOutputSchema([]),
  perUserKeys: iouActionManifest.perUserKeys,
  rules: buildIouRules([]),
};

const before = JSON.stringify(doc);
const out = JSON.stringify(regenerated, null, 2) + "\n";
writeFileSync(docPath, out, "utf8");

const changed = JSON.stringify(regenerated) !== before;
console.log(changed ? "✅ regenerated docs/openchat-registration.json (drift resynced)" : "✅ docs/openchat-registration.json already in sync (no change)");
for (const k of ["promptTemplate", "responseSchema", "perUserKeys", "rules"] as const) {
  const differed = JSON.stringify((doc as any)[k]) !== JSON.stringify((regenerated as any)[k]);
  if (differed) console.log(`   • ${k}: updated`);
}
