// IOU-only candidate qualification. This module has no file, network, model or account effects.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

export const SMALL_QWEN_ID = "qwen3-vl-2b-instruct-q4";
export const QUALIFICATION_PINS = Object.freeze({
  activePrompt: "2d73ebab0701a7adb4256072ef4625c30964b46766172bae05602bc72e045cc8",
  candidatePrompt: "68b1260da41324b9e1ba11b275faf148a1ea3aea886dcf06697cdde4eaf9b514",
  fixture: "126c3b451b55ddcd0ba42a4b989d4e7bc235266f6a9562aef43e2a98f36938aa",
  policy: "4c0cae4300f71df01309bc596cb3a44024a6da3e2937c3a1fe9ea8357f829e28",
  originalPlan: "057396f099e63e7776e7963c3d89f0f53a521a39b4e2c7d1d645568e708110ae",
  worker: "04ebc7bcb6a5385745a095ace2ba87e3e474775775dbae31f74d165433b39bd8",
});
export const QUALIFICATION_PROFILES = Object.freeze({
  v21: Object.freeze({ candidateId: "v21", promptSha256: QUALIFICATION_PINS.candidatePrompt,
    promptFile: "qwen3-vl-2b-upper-heading-v21-image.txt", outputPrefix: "small-qwen-upper-heading-v21",
    promptMode: "IOU-only-v21-candidate-clone-of-current-small-Qwen-profile" }),
  "v20-baseline": Object.freeze({ candidateId: "v20-baseline", promptSha256: QUALIFICATION_PINS.activePrompt,
    promptFile: "qwen3-vl-2b-total-row-image.txt", outputPrefix: "small-qwen-v20-baseline",
    promptMode: "IOU-unchanged-active-v20-baseline-on-current-cleanup-worker" }),
});
export function smallQwenQualificationProfile(candidateId: unknown) {
  assert(typeof candidateId === "string" && Object.hasOwn(QUALIFICATION_PROFILES, candidateId), "Unknown qualification profile");
  return QUALIFICATION_PROFILES[candidateId as keyof typeof QUALIFICATION_PROFILES];
}
export const QUALIFICATION_IDS = Object.freeze([
  "dev-real-arabic-transfer", "dev-real-payout-range", "dev-real-english-transfer",
  "holdout-synthetic-missing-evidence", "dev-synthetic-paper-owed",
  "dev-synthetic-workshop-range", "holdout-synthetic-spanish-paid", "holdout-synthetic-unpaid-hire",
]);
export const qualificationHash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Node owns this timer; a stalled renderer cannot defer it. The signal prevents a late
// renderer reply from updating case evidence after the deadline has already failed.
export async function withQualificationDeadline<T>(name: string, milliseconds: number,
  action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  assert(Number.isSafeInteger(milliseconds) && milliseconds > 0, "A finite positive deadline is required");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${name}: Node deadline exceeded (${milliseconds}ms)`);
          controller.abort(error); reject(error);
        }, milliseconds);
      }),
      Promise.resolve().then(() => action(controller.signal)),
    ]);
  } finally { clearTimeout(timer); }
}

export async function boundedQualificationCleanup(name: string, milliseconds: number,
  close: () => Promise<void>, force?: () => Promise<void>) {
  const result = { closed: false, forced: false, forceCompleted: false, errors: [] as string[] };
  try { await withQualificationDeadline(`${name} cleanup`, milliseconds, close); result.closed = true; }
  catch (error) {
    result.errors.push(String(error));
    if (force) {
      result.forced = true;
      try { await withQualificationDeadline(`${name} forced cleanup`, milliseconds, force); result.forceCompleted = true; }
      catch (forcedError) { result.errors.push(String(forcedError)); }
    }
  }
  // A forced shutdown is never clean qualification, even when process termination succeeds.
  return result;
}

// The complete reviewed first-party set is bound before any of its modules are imported.
// Checks surround import execution and the same immutable bindings are checked at completion.
export async function importQualificationSources<T>(paths: string[], bind: (path: string) => Promise<unknown>,
  verify: (paths: string[]) => Promise<void>, load: () => Promise<T>) {
  assert(paths.length > 0 && new Set(paths).size === paths.length, "Unique source paths required");
  for (const path of paths) await bind(path);
  await verify(paths);
  try { return await load(); }
  finally { await verify(paths); }
}

export function parseSmallQwenQualificationArgs(args: string[]) {
  assert(args.length === 4 || (args.length === 5 && args[4] === "--baseline-v20"),
    "Supply --plan or --run, absolute host checkout, evidence root and local worker file; optional final --baseline-v20 only");
  const [mode, hostRoot, evidenceRoot, workerPath] = args;
  assert(["--plan", "--run"].includes(mode), "Only explicit plan or ten-request run is supported");
  for (const path of [hostRoot, evidenceRoot, workerPath]) assert(isAbsolute(path), "Absolute local paths required");
  return { mode, hostRoot, evidenceRoot, workerPath, candidateId: args.length === 5 ? "v20-baseline" : "v21" };
}

export function assertQualificationBytes(bytes: string | Uint8Array, expected: string) {
  assert.equal(qualificationHash(bytes), expected, "Qualification input identity changed");
}

function assertActiveSmallQwenProfile(definition: any, activeProfile: any, activePrompt: string) {
  assertQualificationBytes(activePrompt, QUALIFICATION_PINS.activePrompt);
  const active = { template: activePrompt, includeRuleGuidance: false, output: "app" };
  assert.deepEqual(activeProfile, active, "Actual small-Qwen registered profile must remain v20");
  const key = "x-openchat-image-prompt-by-model";
  assert.deepEqual(definition.responseSchema[key]?.templates?.[SMALL_QWEN_ID], active);
  return { active, key };
}

export function stageUpperHeadingCandidate(definition: any, activeProfile: any, candidate: string, activePrompt: string) {
  const { active, key } = assertActiveSmallQwenProfile(definition, activeProfile, activePrompt);
  assertQualificationBytes(candidate, QUALIFICATION_PINS.candidatePrompt);
  const before = JSON.stringify(definition);
  const staged = structuredClone(definition);
  staged.responseSchema[key].templates[SMALL_QWEN_ID] = { ...active, template: candidate };
  assert.equal(JSON.stringify(definition), before, "The registered definition cannot be mutated");
  return staged;
}

export function stageSmallQwenQualification(definition: any, activeProfile: any, prompt: string,
  activePrompt: string, candidateId: unknown) {
  const profile = smallQwenQualificationProfile(candidateId);
  assertQualificationBytes(prompt, profile.promptSha256);
  if (candidateId === "v21") return stageUpperHeadingCandidate(definition, activeProfile, prompt, activePrompt);
  assertActiveSmallQwenProfile(definition, activeProfile, activePrompt);
  assert.equal(prompt, activePrompt, "Baseline must use the byte-identical active v20 prompt");
  const baseline = structuredClone(definition);
  assert.deepEqual(baseline, definition, "Baseline cannot substitute any registered field");
  return baseline;
}

export function assertSmallQwenModel(spec: any, frozenSpec: any) {
  assert.deepEqual(spec, frozenSpec, "All current model artifacts and generation defaults must match the frozen small-model spec");
  assert.equal(spec.id, SMALL_QWEN_ID);
  assert.equal(spec.revision, "3e4136ea66ae6e07c110e64fe07da2e029517ab5");
  assert.equal(spec.artifactBytes, 1836691582);
  assert.deepEqual(spec.sessionDtypes, { embed_tokens: "q4", vision_encoder: "q4", decoder_model_merged: "q4" });
}

export function buildSmallQwenCases(policy: any, fixture: any) {
  assert.equal(fixture.modelId, SMALL_QWEN_ID);
  assert.equal(fixture.promptSha256, QUALIFICATION_PINS.activePrompt);
  assert.equal(fixture.cases.length, 10);
  assert.deepEqual(policy.cases.map((row: any) => row.id), QUALIFICATION_IDS);
  assert.deepEqual(fixture.cases.map((row: any) => row.imageId), [...QUALIFICATION_IDS, ...QUALIFICATION_IDS.slice(0, 2)]);
  const cases = policy.cases.map((source: any, index: number) => {
    const row = fixture.cases[index];
    assert.equal(row.repeated, false);
    assert.equal(source.image.sha256, row.imageSha256);
    assert.equal(Date.parse(source.sourceTimestamp), Date.parse(row.sourceTimestamp));
    assert(Number.isFinite(Date.parse(row.sourceTimestamp)));
    if (index < 2) {
      const repeat = fixture.cases[index + 8];
      assert.equal(repeat.repeated, true);
      assert.equal(repeat.imageSha256, row.imageSha256);
      assert.equal(repeat.sourceTimestamp, row.sourceTimestamp);
      assert.deepEqual(repeat.expectedAppForm, row.expectedAppForm);
    }
    return { id: source.id, image: structuredClone(source.image), sourceTimestamp: source.sourceTimestamp,
      expected: structuredClone(row.expectedAppForm) };
  });
  return cases;
}

export function smallQwenSequence(cases: any[]) {
  assert.deepEqual(cases.map((row) => row.id), QUALIFICATION_IDS);
  return [...cases, cases[0], cases[1]];
}

export function smallQwenQualificationPassed(report: any) {
  if (!Object.hasOwn(QUALIFICATION_PROFILES, report.candidateId)) return false;
  const profile = smallQwenQualificationProfile(report.candidateId);
  return report.promptSha256 === profile.promptSha256 && report.cases.length === 10 && report.cases.every((row: any, index: number) =>
    row.imageId === [...QUALIFICATION_IDS, ...QUALIFICATION_IDS.slice(0, 2)][index] &&
    row.repeated === (index >= 8) && row.calls === 1 && row.candidateId === profile.candidateId && row.promptSha256 === profile.promptSha256 &&
    row.runtimePassed === true && row.cardPassed === true) &&
    report.errors.length === 0 && report.sourceUnchanged === true &&
    report.cleanup.browserClosed === true && report.cleanup.serverClosed === true;
}
