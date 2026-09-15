// Offline integration using the current registered manifest, real host parser/runner and IOU
// processor/card functions. Inference returns retained captures: no GPU, account or delivery claim.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fixtures = [
  ["qwen-q4-v20-app-replay.json", "126c3b451b55ddcd0ba42a4b989d4e7bc235266f6a9562aef43e2a98f36938aa", 10],
  ["gemma-v15-app-replay.json", "14f9ad07b2b66b75accaf424e22ba5f3bb8f8ae6cd9ecbe09ef573f3455dcae1", 8],
] as const;

// Registration uses Candid option/enum objects; the host consumes the server's msgpack shapes.
// Convert only that serialization, retaining and checking every authored rule.
function registeredRules(rules: any[]) {
  return rules.map((rule) => {
    assert.equal(Object.keys(rule).length, 1);
    const [kind, raw] = Object.entries<any>(rule)[0], value = structuredClone(raw);
    if (kind === "keyword_map") value.mode = Object.keys(value.mode)[0];
    else if (kind === "normalize") value.ops = value.ops.map((op: object) => Object.keys(op)[0]);
    else if (kind === "context") value.provide = value.provide.map((p: object) => Object.keys(p)[0]);
    else if (kind === "from_message") value.max_length = value.max_length[0];
    else assert.equal(kind, "instruction");
    return { [kind]: value };
  });
}

async function main() {
  const [hostPath, policyPath, policySha256, reportPath, attestationFixturePath, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0);
  if (attestationFixturePath !== undefined) assert(isAbsolute(attestationFixturePath));
  const attestationCases: unknown[] = [];
  for (const path of [hostPath, policyPath, reportPath]) assert(isAbsolute(path), "Supply absolute host, image-policy and report paths");
  const policyBytes = readFileSync(policyPath);
  assert.equal(hash(policyBytes), policySha256, "Image-policy identity");
  const policy = JSON.parse(policyBytes.toString());
  const tracked = [
    hostPath, fileURLToPath(import.meta.url),
    ...["docs/openchat-registration.json", "src/features/settings/currencies.ts",
      "src/features/entries/draft.ts", "src/features/entries/directionLabels.ts"]
      .map((path) => resolve(repository, path)),
    ...["actionManifest.ts", "registerAiApp.ts", "modelImageProfiles.ts", "modelImageProfiles.json",
      "OpenChatLocalProcessorPage.tsx", "localProcessorBridge.ts", "rawImageEvidence.ts", "rawImageTotalRow.ts",
      "localExtraction.ts", "sourceInterval.ts", "cardBridge.ts", "currencyEvidencePolicy.ts"]
      .map((path) => resolve(repository, "src/features/openchat", path)),
  ];
  const sourceBindings = tracked.map((path) => ({ path, sha256: hash(readFileSync(path)) }));
  const report: any = { passed: false, evidence: "current-registered-manifest-captured-output-offline-integration",
    sourceBindings, imagePolicy: { path: policyPath, sha256: policySha256 }, cases: [], negativeControls: [],
    promptInjection: false, modelInferencePerformed: false, phoneQualified: false,
    liveRegistrationPerformed: false, attestationOrDeliveryPerformed: false };
  const previousFetch = globalThis.fetch;
  let networkAttempts = 0;
  globalThis.fetch = async () => { networkAttempts++; throw new Error("Network forbidden in offline integration"); };
  try {
    const host = await import(pathToFileURL(hostPath).href);
    const manifest = await import("../../src/features/openchat/actionManifest");
    const registration = await import("../../src/features/openchat/registerAiApp");
    const profiles = await import("../../src/features/openchat/modelImageProfiles");
    const processor = await import("../../src/features/openchat/localProcessorBridge");
    const cards = await import("../../src/features/openchat/cardBridge");
    const wire = (registration.buildManifestWire("") as any).actions[0];
    const definition = host.aiActionDefinitionFromWire({ ...wire,
      card: { ...wire.card, disclosure: wire.card.disclosure[0] },
      consumer_public_key: wire.consumer_public_key[0],
      recipient_scope: wire.recipient_scope.length ? Object.keys(wire.recipient_scope[0])[0] : undefined,
      rules: registeredRules(wire.rules),
    });
    assert.deepEqual(definition.rules, manifest.buildIouRules([]));
    assert.deepEqual(definition.responseSchema, JSON.parse(wire.response_schema));
    const originalDefinition = JSON.stringify(definition);
    report.responseSchemaBytes = Buffer.byteLength(wire.response_schema);
    const sources = new Map(policy.cases.map((row: any) => [row.id, row]));
    for (const [fixtureFile, fixtureSha, expectedCases] of fixtures) {
      const fixtureBytes = readFileSync(resolve(repository, "test/fixtures/openchat/model-acceptance", fixtureFile));
      assert.equal(hash(fixtureBytes), fixtureSha);
      const fixture = JSON.parse(fixtureBytes.toString());
      const selected = host.imagePromptTemplateForModel(definition.responseSchema, fixture.modelId);
      assert(selected && selected.output === "app");
      assert.equal(hash(selected.template), fixture.promptSha256);
      assert.deepEqual(selected, profiles.iouImagePromptByModel!.templates[fixture.modelId]);
      assert.equal(fixture.cases.length, expectedCases);
      for (const row of fixture.cases) {
        const source: any = sources.get(row.imageId);
        assert(source, row.imageId);
        assert.equal(source.image.sha256, row.imageSha256);
        assert.equal(Date.parse(source.sourceTimestamp), Date.parse(row.sourceTimestamp));
        const image = new Uint8Array(readFileSync(source.image.path));
        assert.equal(hash(image), row.imageSha256);
        const sourceTimestamp = Date.parse(row.sourceTimestamp);
        let inferenceCallbacks = 0, normalizationCalls = 0;
        const ready = await host.runAiAction(definition, { image, modelId: fixture.modelId, sourceTimestamp },
          "offline-no-real-recipient", async (request: any) => {
            assert.equal(++inferenceCallbacks, 1);
            assert.equal(request.prompt, selected.template);
            assert.equal(request.image, image);
            assert.equal(request.modelId, fixture.modelId);
            assert.equal(request.responseMode, "json");
            assert.equal(request.text, undefined);
            return { kind: "ok", text: row.raw };
          }, undefined, undefined, undefined, undefined, {
            normalize: async (candidates: any[]) => {
              assert.equal(++normalizationCalls, 1);
              assert.equal(inferenceCallbacks, 1);
              assert.deepEqual(candidates, host.parseCompleteAppActionOutput(row.raw));
              const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
              return processor.processIouRequest({ type: "oc:app-process:request", version: 1,
                ...binding, actionId: manifest.iouActionManifest.id,
                input: { operation: "normalize_raw", modality: "image", sourceTimestamp, candidates },
              }, binding, profiles.iouImageProcessorOptions);
            },
          });
        assert.equal(ready.kind, "ready", JSON.stringify(ready));
        assert.equal(inferenceCallbacks, 1); assert.equal(normalizationCalls, 1);
        assert.deepEqual(host.missingRequired(ready.extracted, definition.responseSchema), []);
        const payloadText = new TextDecoder().decode(ready.card.confirmPayload);
        // JSON intentionally does not preserve the host's null-prototype object container.
        // Compare the exact serialized payload, then all canonical fields below.
        assert.equal(payloadText, JSON.stringify(ready.extracted));
        const payload = JSON.parse(payloadText);
        const form = cards.initToFormState(payload, new Date(sourceTimestamp));
        const actual = Object.fromEntries(Object.keys(row.expectedAppForm).map((key) => [key, (form as any)[key]]));
        const mismatches = Object.keys(row.expectedAppForm)
          .filter((key) => actual[key] !== row.expectedAppForm[key])
          .map((field) => ({ field, expected: row.expectedAppForm[field], actual: actual[field] }));
        const confirmation = cards.buildConfirmPayload(form);
        assert.equal(Number(confirmation.amount), Number(row.expectedAppForm.amount));
        assert.equal(confirmation.note, actual.note);
        for (const key of ["total_text", "total_row", "currency_text", "amount_text", "date_text", "sourceIndexes"])
          assert(!Object.hasOwn(payload, key));
        for (const key of ["printed_date", "printed_end_date", "image_heading", "sourceIndexes"])
          assert(!Object.hasOwn(confirmation, key));
        attestationCases.push({ modelId: fixture.modelId, imageId: row.imageId,
          promptSha256: fixture.promptSha256,
          card: { title: ready.card.title, rows: ready.card.rows,
            confirm_label: ready.card.confirmLabel, cancel_label: ready.card.cancelLabel,
            action_id: ready.card.actionId, confirm_payload_json: payloadText },
          confirmation_json: JSON.stringify(confirmation) });
        report.cases.push({ modelId: fixture.modelId, imageId: row.imageId, imageSha256: row.imageSha256,
          fixtureSha256: fixtureSha, promptSha256: fixture.promptSha256, repeated: row.repeated === true,
          fields: actual, expected: row.expectedAppForm, mismatches, inferenceCallbacks, normalizationCalls,
          integrationPassed: true, passed: mismatches.length === 0 });
      }
    }
    const smallerQwenProfile = host.imagePromptTemplateForModel(definition.responseSchema, "qwen3-vl-2b-instruct-q4");
    assert.deepEqual(smallerQwenProfile, profiles.iouImagePromptByModel!.templates["qwen3-vl-2b-instruct-q4"]);
    assert.equal(hash(smallerQwenProfile.template), "2d73ebab0701a7adb4256072ef4625c30964b46766172bae05602bc72e045cc8");
    report.smallerQwenProfileVerified = true;
    // Mixed-precision captures remain in separate historical fixtures, never relabelled as Q4.
    for (const id of ["qwen3-vl-2b-q4-head-f16-diagnostic", "unconfigured-compatible-model"]) {
      assert.equal(host.imagePromptTemplateForModel(definition.responseSchema, id), undefined);
      report.negativeControls.push({ kind: "no-implicit-profile", modelId: id, passed: true });
    }
    for (const raw of ['{"amount":1,"amount":2}', '{"heading":', '{"a":1}{"a":2}']) {
      assert.equal(host.parseCompleteAppActionOutput(raw), undefined);
      report.negativeControls.push({ kind: "invalid-output-envelope", passed: true });
    }
    assert.equal(JSON.stringify(definition), originalDefinition);
    assert.equal(networkAttempts, 0);
    for (const source of sourceBindings) assert.equal(hash(readFileSync(source.path)), source.sha256);
    report.integrationPassed = report.cases.length === 18;
    report.cardAccuracyPassed = report.cases.every((row: any) => row.passed);
    report.passed = report.integrationPassed && report.cardAccuracyPassed;
  } catch (error) { report.error = String(error); }
  finally { globalThis.fetch = previousFetch; }
  report.networkAttempts = networkAttempts;
  // Optional generated cross-language regression corpus. No credentials, endpoints or host paths.
  // The Rust tests consume the exact card payload, not just the later editable form projection.
  if (report.passed && attestationFixturePath !== undefined) {
    writeFileSync(attestationFixturePath, JSON.stringify({ schemaVersion: 1,
      scope: "Exact current host/app cards from retained model captures; not live phone attestation",
      cases: attestationCases }, null, 2) + "\n", { flag: "wx" });
    report.attestationFixture = { path: attestationFixturePath,
      sha256: hash(readFileSync(attestationFixturePath)) };
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ reportPath, sha256: hash(readFileSync(reportPath)), passed: report.passed,
    integrationPassed: report.integrationPassed, cardAccuracyPassed: report.cardAccuracyPassed,
    cardFailures: report.cases.filter((row: any) => !row.passed).map((row: any) => ({ modelId: row.modelId, imageId: row.imageId, mismatches: row.mismatches })),
    cases: report.cases.length, negativeControls: report.negativeControls.length, error: report.error }));
  if (!report.passed) process.exitCode = 1;
}
await main();
