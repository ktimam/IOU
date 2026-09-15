import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../../../test/fixtures/openchat/model-acceptance/qwen-q4-v20-app-replay.json";
import config from "./modelImageProfiles.json";
import { assertQualificationBytes, assertSmallQwenModel, boundedQualificationCleanup, buildSmallQwenCases, importQualificationSources,
  parseSmallQwenQualificationArgs, QUALIFICATION_IDS, QUALIFICATION_PINS,
  qualificationHash, SMALL_QWEN_ID, smallQwenQualificationPassed, smallQwenQualificationProfile, smallQwenSequence,
  stageSmallQwenQualification, stageUpperHeadingCandidate, withQualificationDeadline } from "../../../scripts/live/qwenSmallQualificationContract";

const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
const activePrompt = read("docs/model-prompts/qwen3-vl-2b-total-row-image.txt");
const candidate = read("docs/model-prompts/qwen3-vl-2b-upper-heading-v21-image.txt");
const extension = "x-openchat-image-prompt-by-model";
const definition = () => ({ rules: [{ instruction: "unchanged app rule" }], responseSchema: {
  required: ["amount", "kind", "direction"],
  [extension]: { version: 2, templates: structuredClone(config.templates) },
} });
const policy = () => ({ cases: fixture.cases.slice(0, 8).map(row => ({
  id: row.imageId, sourceTimestamp: row.sourceTimestamp,
  image: { path: `/fixture/${row.imageId}.png`, sha256: row.imageSha256 },
})) });
const frozenSpec = { id: SMALL_QWEN_ID, revision: "3e4136ea66ae6e07c110e64fe07da2e029517ab5",
  artifactBytes: 1836691582, sessionDtypes: { embed_tokens: "q4", vision_encoder: "q4", decoder_model_merged: "q4" },
  artifacts: [{ path: "frozen", sha256: "a".repeat(64) }], generation: { maxNewTokens: 96 } };
const passingReport = (candidateId = "v21") => ({ candidateId, promptSha256: smallQwenQualificationProfile(candidateId).promptSha256,
  cases: [...QUALIFICATION_IDS, ...QUALIFICATION_IDS.slice(0, 2)].map((id, index) => ({
  imageId: id, candidateId, repeated: index >= 8, calls: 1, promptSha256: smallQwenQualificationProfile(candidateId).promptSha256,
  runtimePassed: true, cardPassed: true,
})), errors: [], sourceUnchanged: true, cleanup: { browserClosed: true, serverClosed: true } });

describe("unselected small-Qwen upper-heading candidate", () => {
  afterEach(() => vi.useRealTimers());
  it("bounds a renderer evaluate that never resolves and aborts late evidence writes", async () => {
    vi.useFakeTimers();
    let reply!: (value: string) => void; let wroteEvidence = false; let signal!: AbortSignal;
    const pending = withQualificationDeadline("image fetch/inference/disposal", 195000, async active => {
      signal = active; await new Promise<string>(resolve => { reply = resolve; });
      active.throwIfAborted(); wroteEvidence = true;
    });
    const rejected = expect(pending).rejects.toThrow("Node deadline exceeded (195000ms)");
    await vi.advanceTimersByTimeAsync(195000); await rejected;
    expect(signal.aborted).toBe(true);
    reply("late renderer result"); await Promise.resolve(); await Promise.resolve();
    expect(wroteEvidence).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it("clears the host deadline for successful and immediately rejected operations", async () => {
    vi.useFakeTimers();
    await expect(withQualificationDeadline("resolved", 100, async () => 42)).resolves.toBe(42);
    await expect(withQualificationDeadline("rejected", 100, async () => { throw new Error("original error"); })).rejects.toThrow("original error");
    expect(vi.getTimerCount()).toBe(0);
    await expect(withQualificationDeadline("unbounded", Infinity, async () => 42)).rejects.toThrow("finite positive deadline");
  });
  it("bounds hanging browser close, attempts exact owned kill, and never marks it clean", async () => {
    vi.useFakeTimers(); const kill = vi.fn(async () => {});
    const cleanup = boundedQualificationCleanup("Browser", 10000, () => new Promise(() => {}), kill);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await cleanup).toEqual({ closed: false, forced: true, forceCompleted: true,
      errors: ["Error: Browser cleanup: Node deadline exceeded (10000ms)"] });
    expect(kill).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds hanging forced kill and still allows the independent server cleanup", async () => {
    vi.useFakeTimers(); const hanging = () => new Promise<void>(() => {});
    const cleanup = boundedQualificationCleanup("Browser", 10000, hanging, hanging);
    await vi.advanceTimersByTimeAsync(20000);
    const result = await cleanup;
    expect(result).toMatchObject({ closed: false, forced: true, forceCompleted: false });
    expect(result.errors).toHaveLength(2);
    await expect(boundedQualificationCleanup("Loopback server", 10000, async () => {})).resolves.toEqual({
      closed: true, forced: false, forceCompleted: false, errors: [],
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not force kill a clean browser, but retains immediate cleanup failures", async () => {
    const force = vi.fn(async () => {});
    expect(await boundedQualificationCleanup("Browser", 100, async () => {}, force)).toMatchObject({ closed: true, forced: false });
    expect(force).not.toHaveBeenCalled();
    expect(await boundedQualificationCleanup("Server", 100, async () => { throw new Error("failed close"); })).toMatchObject({
      closed: false, forced: false, errors: ["Error: failed close"],
    });
  });
  it.each(["stable", "before-import", "during-import", "after-import", "import-rejection"])("binds sources before loading and rejects %s drift", async changed => {
    const files = new Map([["app.ts", "app v1"], ["catalog.ts", "catalog v1"], ["transform.mjs", "transform v1"]]);
    const baseline = new Map<string, string>(); const events: string[] = [];
    const bind = async (path: string) => { baseline.set(path, qualificationHash(files.get(path)!)); events.push("bind:" + path); };
    const verify = async (paths: string[]) => {
      if (changed === "before-import" && !events.includes("verify")) files.set("catalog.ts", "changed");
      events.push("verify"); for (const path of paths) assertQualificationBytes(files.get(path)!, baseline.get(path)!);
    };
    const load = vi.fn(async () => {
      expect(events).toEqual(["bind:app.ts", "bind:catalog.ts", "bind:transform.mjs", "verify"]);
      if (changed === "during-import") files.set("transform.mjs", "changed");
      if (changed === "import-rejection") throw new Error("import rejected");
      return "loaded";
    });
    const pending = importQualificationSources([...files.keys()], bind, verify, load);
    if (["before-import", "during-import"].includes(changed)) await expect(pending).rejects.toThrow("Qualification input identity changed");
    else if (changed === "import-rejection") await expect(pending).rejects.toThrow("import rejected");
    else await expect(pending).resolves.toBe("loaded");
    if (changed === "before-import") expect(load).not.toHaveBeenCalled();
    else expect(events.filter(event => event === "verify")).toHaveLength(2);
    if (changed === "after-import") {
      files.set("app.ts", "changed after import");
      await expect(verify([...files.keys()])).rejects.toThrow("Qualification input identity changed");
    }
    expect(baseline.get("transform.mjs")).toBe(qualificationHash("transform v1"));
  });
  it("changes only the v20 heading instruction, preserving every other byte and no image-specific literal", () => {
    assertQualificationBytes(activePrompt, QUALIFICATION_PINS.activePrompt);
    assertQualificationBytes(candidate, QUALIFICATION_PINS.candidatePrompt);
    const heading = (text: string) => text.split("\n").find(line => line.startsWith('"heading":'))!;
    expect(candidate.replace(heading(candidate), heading(activePrompt))).toBe(activePrompt);
    expect(heading(candidate)).toContain("Never join vertically stacked lines");
    expect(candidate).not.toMatch(/RIVER|MARKET|SERVICE RECEIPT|12900|1,912|Reservation|Workshop/u);
    expect(Buffer.byteLength(candidate)).toBeLessThanOrEqual(4096);
    expect(config.templates[SMALL_QWEN_ID].template).toBe(activePrompt);
    expect(config.processorOptions).toEqual({ rawImageMoneyFormat: "total-row" });
  });
  it("stages one candidate only in memory, preserving every registered rule and all other model profiles", () => {
    const original = definition(); const before = JSON.stringify(original);
    const staged = stageUpperHeadingCandidate(original, config.templates[SMALL_QWEN_ID], candidate, activePrompt);
    expect(staged.responseSchema[extension].templates[SMALL_QWEN_ID]).toEqual({ template: candidate, includeRuleGuidance: false, output: "app" });
    staged.responseSchema[extension].templates[SMALL_QWEN_ID].template = activePrompt;
    expect(staged).toEqual(original);
    expect(JSON.stringify(original)).toBe(before);
  });
  it("selects the byte-identical active v20 baseline only by explicit bounded selector", () => {
    const paths = [resolve("host"), resolve("evidence"), resolve("worker.js")];
    for (const mode of ["--plan", "--run"]) {
      expect(parseSmallQwenQualificationArgs([mode, ...paths]).candidateId).toBe("v21");
      expect(parseSmallQwenQualificationArgs([mode, ...paths, "--baseline-v20"]).candidateId).toBe("v20-baseline");
    }
    for (const args of [["--plan", ...paths, "--baseline"], ["--plan", ...paths, "v20-baseline"],
      ["--plan", ...paths, "--baseline-v20", "--baseline-v20"], ["--plan", "--baseline-v20", ...paths]])
      expect(() => parseSmallQwenQualificationArgs(args)).toThrow();
    const baselineProfile = smallQwenQualificationProfile("v20-baseline");
    expect(baselineProfile.promptSha256).toBe(QUALIFICATION_PINS.activePrompt);
    expect(baselineProfile.outputPrefix).toBe("small-qwen-v20-baseline");
    expect(smallQwenQualificationProfile("v21").outputPrefix).toBe("small-qwen-upper-heading-v21");
    const original = definition(); const before = JSON.stringify(original);
    const baseline = stageSmallQwenQualification(original, config.templates[SMALL_QWEN_ID], activePrompt, activePrompt, "v20-baseline");
    expect(baseline).toEqual(original); expect(baseline).not.toBe(original);
    expect(baseline.responseSchema[extension].templates[SMALL_QWEN_ID].template).toBe(activePrompt);
    baseline.responseSchema[extension].templates[SMALL_QWEN_ID].template += "clone-only mutation";
    expect(JSON.stringify(original)).toBe(before);
    expect(stageSmallQwenQualification(original, config.templates[SMALL_QWEN_ID], candidate, activePrompt, "v21"))
      .toEqual(stageUpperHeadingCandidate(original, config.templates[SMALL_QWEN_ID], candidate, activePrompt));
  });
  it.each(["prompt", "active", "profile", "schema", "identity"])("rejects %s drift for the unchanged v20 baseline", changed => {
    const original = definition(); const profile = structuredClone(config.templates[SMALL_QWEN_ID]);
    if (changed === "profile") profile.includeRuleGuidance = true;
    if (changed === "schema") original.responseSchema[extension].templates[SMALL_QWEN_ID].template = candidate;
    expect(() => stageSmallQwenQualification(original, profile, changed === "prompt" ? candidate : activePrompt,
      changed === "active" ? activePrompt + "changed" : activePrompt, changed === "identity" ? "v22" : "v20-baseline")).toThrow();
  });
  it("never accepts baseline evidence under a candidate label or vice versa", () => {
    for (const id of ["v21", "v20-baseline"]) {
      const baseline = passingReport(id); expect(smallQwenQualificationPassed(baseline)).toBe(true);
      const other = id === "v21" ? "v20-baseline" : "v21";
      for (const mutate of [
        (r: any) => r.candidateId = other, (r: any) => r.candidateId = "v22",
        (r: any) => delete r.candidateId, (r: any) => r.promptSha256 = smallQwenQualificationProfile(other).promptSha256,
        (r: any) => r.cases[4].candidateId = other,
        (r: any) => r.cases[4].promptSha256 = smallQwenQualificationProfile(other).promptSha256,
        (r: any) => r.cases[4].cardPassed = false, (r: any) => r.cases.pop(),
      ]) { const report = passingReport(id); mutate(report); expect(smallQwenQualificationPassed(report)).toBe(false); }
    }
  });
  it.each(["candidate", "active", "profile", "schema"])("rejects changed %s binding before inference", changed => {
    const original = definition();
    if (changed === "schema") original.responseSchema[extension].templates[SMALL_QWEN_ID].template += "changed";
    const profile = structuredClone(config.templates[SMALL_QWEN_ID]);
    if (changed === "profile") profile.includeRuleGuidance = true;
    expect(() => stageUpperHeadingCandidate(original, profile,
      candidate + (changed === "candidate" ? "changed" : ""), activePrompt + (changed === "active" ? "changed" : ""))).toThrow();
  });
  it("binds the unchanged historical all-q4 captures and retains the known receipt failure", () => {
    assertQualificationBytes(read("test/fixtures/openchat/model-acceptance/qwen-q4-v20-app-replay.json"), QUALIFICATION_PINS.fixture);
    const receipt = fixture.cases.find(row => row.imageId === "dev-synthetic-paper-owed")!;
    expect(receipt.expectedAppForm.note).toBe("RIVER MARKET");
    expect(receipt.knownMismatch).toEqual({ field: "note", actual: "RIVER MARKET SERVICE RECEIPT" });
    expect(qualificationHash(readFileSync(new URL("../../../test/fixtures/openchat/model-acceptance/receipt-photo.png", import.meta.url))))
      .toBe(receipt.imageSha256);
  });
  it("freezes eight source cases and exactly the original first-two repeats", () => {
    const inputs = policy(); const before = JSON.stringify({ inputs, fixture });
    const cases = buildSmallQwenCases(inputs, fixture);
    expect(cases.map((row: any) => row.id)).toEqual(QUALIFICATION_IDS);
    expect(smallQwenSequence(cases).map(row => row.id)).toEqual([...QUALIFICATION_IDS, ...QUALIFICATION_IDS.slice(0, 2)]);
    cases[0].expected.note = "changed only a returned copy";
    expect(JSON.stringify({ inputs, fixture })).toBe(before);
  });
  it.each(["removed", "reordered", "image", "timestamp", "repeat", "oracle", "identity"])("rejects %s matrix drift", changed => {
    const inputs = policy(); const retained = structuredClone(fixture);
    if (changed === "removed") inputs.cases.pop();
    if (changed === "reordered") inputs.cases.reverse();
    if (changed === "image") inputs.cases[0].image.sha256 = "0".repeat(64);
    if (changed === "timestamp") inputs.cases[0].sourceTimestamp = "invalid";
    if (changed === "repeat") retained.cases[8].repeated = false;
    if (changed === "oracle") retained.cases[8].expectedAppForm.note = "relaxed";
    if (changed === "identity") retained.modelId = "another-model";
    expect(() => buildSmallQwenCases(inputs, retained)).toThrow();
  });
  it.each(["identity", "revision", "bytes", "precision", "artifact", "generation"])("rejects changed model %s", changed => {
    const spec = structuredClone(frozenSpec);
    if (changed === "identity") spec.id = "another-model";
    if (changed === "revision") spec.revision = "0".repeat(40);
    if (changed === "bytes") spec.artifactBytes++;
    if (changed === "precision") spec.sessionDtypes.embed_tokens = "fp16";
    if (changed === "artifact") spec.artifacts[0].sha256 = "b".repeat(64);
    if (changed === "generation") spec.generation.maxNewTokens = 192;
    expect(() => assertSmallQwenModel(spec, frozenSpec)).toThrow();
  });
  it("requires explicit bounded invocation and exact local input identities", () => {
    const paths = [resolve("host"), resolve("evidence"), resolve("worker.js")];
    expect(parseSmallQwenQualificationArgs(["--plan", ...paths]).mode).toBe("--plan");
    expect(parseSmallQwenQualificationArgs(["--run", ...paths]).mode).toBe("--run");
    for (const args of [[], ["--run-v20", ...paths], ["--run", "relative", ...paths.slice(1)], ["--plan", ...paths, "extra"]])
      expect(() => parseSmallQwenQualificationArgs(args)).toThrow();
    assertSmallQwenModel(frozenSpec, structuredClone(frozenSpec));
    expect(() => assertQualificationBytes("different worker", QUALIFICATION_PINS.worker)).toThrow();
  });
  it("accepts only complete clean10/10 evidence, never known-mismatch characterization", () => {
    expect(smallQwenQualificationPassed(passingReport())).toBe(true);
    const mutations = [
      (r: any) => r.cases.pop(), (r: any) => r.cases.reverse(),
      (r: any) => r.cases[4].cardPassed = false, (r: any) => r.cases[0].runtimePassed = false,
      (r: any) => r.cases[0].calls = 2, (r: any) => r.cases[9].repeated = false,
      (r: any) => r.cases[0].promptSha256 = QUALIFICATION_PINS.activePrompt,
      (r: any) => r.errors.push("transport warning"), (r: any) => r.sourceUnchanged = false,
      (r: any) => r.cleanup.browserClosed = false, (r: any) => r.cleanup.serverClosed = false,
    ];
    for (const mutate of mutations) { const report = passingReport(); mutate(report); expect(smallQwenQualificationPassed(report)).toBe(false); }
  });
  it("wires current profiles, pinned local worker, lazy transport and clean bounded execution without retired model lookup", () => {
    const runner = read("scripts/live/qualify-small-qwen-upper-heading.ts");
    expect(runner).toContain("stageSmallQwenQualification(registeredDefinition, selected,");
    expect(runner).toContain("smallQwenQualificationProfile(options.candidateId)");
    expect(runner).toContain("candidateId: qualification.candidateId");
    expect(runner).toContain("assert.equal(row.promptSha256, qualification.promptSha256)");
    expect(runner).toContain("qualification.outputPrefix + '-plan-'");
    expect(runner).toContain("await bind(workerPath, { sha256: QUALIFICATION_PINS.worker })");
    expect(runner).toContain("catalog-cache-fixture-v2.mjs");
    expect(runner).toContain("smallQwenSequence(p.cases)");
    expect(runner).toContain("maxTokens: 96");
    expect(runner).toContain("smallQwenQualificationPassed(report)");
    expect(runner).toContain("importQualificationSources(executionSources, bind, verifyBindings, async () =>");
    expect(runner).toContain("transformersWebGpuArtifactTransform.ts");
    expect(runner).toContain("webGpuModelCatalog.ts");
    expect(runner).toContain("'MropeGraph', 'QwenVisionGeometry'");
    expect(runner).toContain("browserServer.kill()");
    expect(runner).toContain("browserServer.close()");
    expect(runner).toContain("plan.nodeCaseDeadlineMs");
    expect(runner).toContain("signal.throwIfAborted()");
    expect(runner).toContain("Previously bound input changed:");
    expect(runner).not.toContain("await browser?.close()");
    expect(runner).toContain("if (mode === '--run')");
    expect(runner).not.toMatch(/qwen3-vl-2b-q4-head-f16-diagnostic|useMixedPrompt|--run-v20|workerResponse|registerAiApp\(/u);
  });
});
