// IOU owns this cross-repository contract test. No app-specific fixture enters OpenChat.
// Check (never auto-update) the exact initial payload BEFORE the app's editable card projection.
// Usage: pnpm exec tsx scripts/live/verify-initial-card-contract.ts --openchat-repo <checkout>
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import fixtures from "../../src/features/openchat/fixtures/initial-card-content-v1.json";
import { processIouRequest } from "../../src/features/openchat/localProcessorBridge";
import { buildManifestWire } from "../../src/features/openchat/registerAiApp";
import { buildIouRules, iouActionManifest } from "../../src/features/openchat/actionManifest";

const args = process.argv.slice(2);
const repo = args[args.indexOf("--openchat-repo") + 1];
assert(args.includes("--openchat-repo") && repo, "--openchat-repo is required; no deployment path is hardcoded");
const host = await import(pathToFileURL(resolve(repo, "frontend/openchat-shared/src/domain/aiAction.ts")).href);
const wire = (buildManifestWire("") as { actions: Record<string, any>[] }).actions[0];
const definition = {
  ...host.aiActionDefinitionFromWire({ ...wire, card: { ...wire.card, disclosure: wire.card.disclosure[0] }, rules: [] }),
  rules: buildIouRules([]),
};
const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
const actual = fixtures.map((fixture) => {
  const result = processIouRequest({ type: "oc:app-process:request", version: 1, ...binding,
    actionId: iouActionManifest.id, input: fixture.input }, binding);
  assert.equal(result.kind, "candidates", fixture.name);
  if (result.kind !== "candidates") throw new Error("expected app candidates");
  const candidates = result.candidates.map((candidate) => host.applyRulesPostPass(
    definition.rules, candidate, fixture.input.text, definition.responseSchema,
    { hasImage: fixture.input.modality === "image", rulesAlreadyResolved: true },
  ));
  for (const candidate of candidates) assert.deepEqual(host.missingRequired(candidate, definition.responseSchema), [], fixture.name);
  const card = candidates.length === 1
    ? host.buildActionCardContent(definition, candidates[0], "test-only-key")
    : host.buildMultiActionCardContent(definition, candidates, "test-only-key");
  return { ...fixture, content: {
    title: card.title, rows: card.rows, confirm_label: card.confirmLabel,
    cancel_label: card.cancelLabel, action_id: card.actionId,
    disclosure: card.disclosure ?? null, expires_at: card.expiresAt ?? null,
    confirm_payload: Array.from(card.confirmPayload as Uint8Array),
  } };
});
if (args.includes("--print-fixtures")) {
  // Deliberately prints only. A reviewed fixture edit must be made explicitly, never blessed by a run.
  console.log(JSON.stringify(actual, null, 2));
} else {
  assert.deepEqual(actual, fixtures, "Initial card contract drifted before app attestation");
  console.log(`PASS ${fixtures.length} actual IOU processor -> generic OpenChat initial card fixtures; next run: cargo test --lib tests::app_local_candidates_built_by_openchat_pass_exact_card_attestation -- --exact (expect 1 test, not 0).`);
}
