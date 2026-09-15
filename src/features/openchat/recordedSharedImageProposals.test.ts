import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/recorded-shared-image-proposals-20260909.json";
import { checkPackagedResponse, parsePackagedExpectation } from "../../../scripts/live/packagedTransformersAcceptance";
import { permittedImageCurrencyOutputs } from "./currencyEvidencePolicy";
import { processIouRequest } from "./localProcessorBridge";
import { iouActionManifest } from "./actionManifest";
import { buildConfirmPayload, initToFormState } from "./cardBridge";

// These are immutable RECORDED regressions. They do not run a model, read a local capture path,
// or qualify the OpenChat host parser/GPU/APK/phone. Only the exact recorded fence wrapper is
// removed to supply its decoded object to IOU's real normalization and editable-card code.
// Separate pinned offline-host receipts in the fixture document the historical full-host replay.
type CardFields = { amount: number; currency: string | null; kind: string; date: string | null; note: string };
type Source = {
  id: string;
  raw: Record<string, string | number>;
  permittedRawCurrency: string[];
  card: CardFields;
  sourceTimestamp: string;
  sourceCurrencyPresent: boolean;
  sourceDatePresent: boolean;
  visibleDateBeforePolicy?: string;
};
const sources = new Map(fixture.sources.map(source => [source.id, source as Source]));
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const capture = (id: string) => {
  const result = fixture.captures.find(item => item.id === id);
  if (!result) throw new Error(`Missing recorded capture: ${id}`);
  return result;
};
const sourceFor = (item: typeof fixture.captures[number]) => {
  const source = sources.get(item.sourceId);
  if (!source) throw new Error("Missing independent source transcription");
  return source;
};
function decodedText(item: typeof fixture.captures[number]) {
  if (item.wrapper === "object") return item.raw;
  if (item.wrapper !== "json-fence" || !item.raw.startsWith("```json\n") || !item.raw.endsWith("\n```")) {
    throw new Error("Unsupported recorded wrapper; this is not a copied host parser");
  }
  return item.raw.slice("```json\n".length, -"\n```".length);
}
function packagedExpectation(source: Source, fullVisibleTimestamp = false) {
  const raw = { ...source.raw, ...(!source.sourceCurrencyPresent ? { currency: null } : {}),
    ...(fullVisibleTimestamp && source.visibleDateBeforePolicy ? { printed_date: source.visibleDateBeforePolicy } : {}) };
  const projected = { currency: source.card.currency, date: source.card.date, note: source.card.note };
  return parsePackagedExpectation({ version: 1, sourceTimestamp: source.sourceTimestamp, raw,
    card: projected, confirmed: projected,
    ...(source.permittedRawCurrency.length > 1 ? { currencyPolicy: { version: 1, mode: "literal-or-declared-symbol" } } : {}) });
}

// A value-only source gate: canonical output is permitted only by the existing forward mapping
// from an independently transcribed symbol. No code-to-symbol inversion or unknown-field credit.
// checkPackagedResponse supplies its existing bounded/duplicate-key JSON validation, not its
// projected-field success, so the raw and projection gates remain independent.
function sourceIssues(text: string, source: Source, allowPrintedTimestamp = true) {
  if (!checkPackagedResponse(text, packagedExpectation(source)).completeJsonObject) return ["json-object"];
  const value = JSON.parse(text) as Record<string, unknown>;
  const issues = new Set<string>();
  for (const key of Object.keys(value)) if (!Object.hasOwn(source.raw, key)) issues.add(key);
  for (const [key, expected] of Object.entries(source.raw)) {
    const allowed = key === "currency" ? permittedImageCurrencyOutputs(expected)
      : key === "printed_date" && allowPrintedTimestamp && source.visibleDateBeforePolicy
        ? [expected, source.visibleDateBeforePolicy] : [expected];
    if (!Object.hasOwn(value, key) || !allowed.some(item => item === value[key])) issues.add(key);
  }
  return [...issues].sort();
}
function project(value: Record<string, unknown>, source: Source) {
  const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
  const normalized = processIouRequest({ type: "oc:app-process:request", version: 1, ...binding,
    actionId: iouActionManifest.id, input: { operation: "normalize", modality: "image",
      sourceTimestamp: Date.parse(source.sourceTimestamp), candidates: [value] } }, binding);
  if (normalized.kind !== "candidates" || normalized.candidates.length !== 1) throw new Error("Expected one recorded app candidate");
  const candidate = normalized.candidates[0];
  const form = initToFormState(candidate, new Date(source.sourceTimestamp));
  const confirmed = buildConfirmPayload(form);
  const card = { amount: Number(form.amount), currency: form.currency || null, kind: form.kind, date: form.date || null, note: form.note };
  const confirmation = { amount: confirmed.amount, currency: confirmed.currency ?? null, kind: confirmed.kind,
    date: confirmed.date ?? null, note: confirmed.note ?? "" };
  return { candidate, form, confirmed, card, confirmation };
}
const sameFields = (actual: Record<string, unknown>, expected: CardFields) =>
  Object.entries(expected).every(([key, value]) => actual[key] === value);

describe("recorded shared-image source regressions (IOU only; no inference)", () => {
  it("pins the complete independent fixture, source transcriptions and exact capture inventory", () => {
    expect(sha(JSON.stringify(fixture))).toBe("5b7f00d1b121b4c57729e0118573aa04753a709d674e70ee12ff039c8938eb07");
    expect(fixture.version).toBe(1);
    expect(fixture.mode).toBe("recorded-shared-image-proposal-regressions");
    expect(fixture.sourceCorpus).toMatchObject({ oraclesFrozenBeforeInference: true,
      sha256: "d8b63be981cdb22d286f59aebadbc08a2f419a6daa3cb174321382650f040798" });
    expect(fixture.captures).toHaveLength(14);
    expect(fixture.sources).toHaveLength(7);
    expect(fixture.runs).toHaveLength(3);
    expect(fixture.prompts).toHaveLength(2);
    expect(fixture.captures.filter(item => !item.expected.sourceValuesAccepted).map(item => item.id)).toEqual([
      "gemma-proof-synthetic-missing-evidence", "qwen-proof-real-english-transfer",
      "qwen-proof-synthetic-workshop-range", "qwen-proof-synthetic-missing-evidence", "qwen-empty-synthetic-unpaid-hire",
    ]);
    expect(fixture.captures.filter(item => item.expected.sourceValuesAccepted)).toHaveLength(9);
    for (const prompt of fixture.prompts) expect(sha(prompt.text)).toBe(prompt.sha256);
    for (const source of fixture.sources) {
      expect(source.image.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(source.image.bytes).toBeGreaterThan(0);
      expect(source.permittedRawCurrency).toEqual(permittedImageCurrencyOutputs(source.raw.currency));
      expect(source.sourceCurrencyPresent).toBe(Object.hasOwn(source.raw, "currency"));
      expect(source.sourceDatePresent).toBe(Object.hasOwn(source.raw, "printed_date"));
    }
  });

  it.each(fixture.captures)("preserves raw/result/model/prompt/image provenance: $id", item => {
    expect(sha(item.raw)).toBe(item.rawSha256);
    const run = fixture.runs.find(run => run.id === item.runId)!;
    const prompt = fixture.prompts.find(prompt => prompt.sha256 === run.promptSha256)!;
    expect(prompt).toBeDefined();
    expect(run.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(run.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(run.modelRevision).toMatch(/^[a-f0-9]{40}$/);
    expect(run.recordedRuntimePassed).toBe(true);
    expect(run.recordedSourceUnchanged).toBe(true);
    expect(run.recordedPhysicalPhoneVerified).toBe(false);
    expect(run.offlineActualHostReplay.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(item.requestId).toBeGreaterThan(0);
    expect(item.requestId).toBeLessThanOrEqual(run.completedRequests);
    expect(item.maxTokens).toBe(96);
    expect(sourceFor(item)).toBeDefined();
  });

  it.each(fixture.captures)("keeps strict format, calendar-only and visible-source values separate: $id", item => {
    const source = sourceFor(item), text = decodedText(item);
    expect(checkPackagedResponse(item.raw, packagedExpectation(source)).completeJsonObject).toBe(item.expected.strictObject);
    expect(sourceIssues(text, source, false).length === 0).toBe(item.expected.calendarOnlyValuesAccepted);
    expect(sourceIssues(text, source).length === 0).toBe(item.expected.sourceValuesAccepted);
    // A fenced positive is still NOT a strict raw JSON pass; source-value credit is separate.
    if (item.wrapper === "json-fence") expect(checkPackagedResponse(item.raw, packagedExpectation(source)).exact).toBe(false);
  });

  it.each(fixture.captures)("replays actual IOU normalization/card/confirmation without repairing bad evidence: $id", item => {
    const source = sourceFor(item), value = JSON.parse(decodedText(item));
    const result = project(value, source);
    expect(result.card).toEqual(item.observedCard);
    expect(result.confirmation).toEqual(item.observedConfirmation);
    expect(sameFields(result.card, source.card)).toBe(item.expected.cardMatchesSource);
    expect(sameFields(result.confirmation, source.card)).toBe(item.expected.confirmedMatchesSource);
    for (const key of ["printed_date", "printed_end_date"]) expect(result.candidate).not.toHaveProperty(key);
    for (const key of ["printed_date", "printed_end_date", "interval_start", "interval_end"]) {
      expect(result.form).not.toHaveProperty(key); expect(result.confirmed).not.toHaveProperty(key);
    }
  });

  it("rejects invented currency on both models even though each produces a normal editable card", () => {
    for (const id of ["gemma-proof-synthetic-missing-evidence", "qwen-proof-synthetic-missing-evidence"]) {
      const item = capture(id), source = sourceFor(item), text = decodedText(item);
      expect(source.raw).not.toHaveProperty("currency");
      expect(source.raw).not.toHaveProperty("printed_date");
      expect(sourceIssues(text, source)).toEqual(["currency", "printed_date", "printed_end_date"]);
      const result = project(JSON.parse(text), source);
      expect(result.card.currency).toBe("USD"); expect(result.confirmation.currency).toBe("USD");
      expect(result.card.date).toBeNull(); expect(result.confirmation.date).toBeNull();
      expect(source.card.currency).toBeNull();
    }
  });

  it("keeps wrong memo selection negative beside the correct heading from the other model", () => {
    const bad = capture("qwen-proof-real-english-transfer"), good = capture("gemma-proof-real-english-transfer");
    expect(bad.sourceId).toBe(good.sourceId);
    expect(JSON.parse(decodedText(bad)).note).toBe("Living Expenses");
    expect(sourceFor(bad).raw.note).toBe("Your transaction was successful");
    expect(sourceIssues(decodedText(bad), sourceFor(bad))).toEqual(["note"]);
    expect(sourceIssues(decodedText(good), sourceFor(good))).toEqual([]);
  });

  it("does not let USD normalization conceal changing the printed code into an unprinted symbol", () => {
    const bad = capture("qwen-proof-synthetic-workshop-range"), good = capture("gemma-proof-synthetic-workshop-range");
    const source = sourceFor(bad), text = decodedText(bad);
    expect(source.raw.currency).toBe("USD");
    expect(JSON.parse(text).currency).toBe("$");
    expect(sourceIssues(text, source)).toEqual(["currency"]);
    expect(checkPackagedResponse(text, packagedExpectation(source))).toMatchObject({ currencyAccepted: false, exact: false,
      projected: { currency: "USD", confirmedCurrency: "USD" } });
    expect(project(JSON.parse(text), source).card).toEqual(source.card);
    expect(sourceIssues(decodedText(good), sourceFor(good))).toEqual([]);
  });

  it("pins the lost decimal point beside a correct same-image capture and a positive in the failing run", () => {
    const bad = capture("qwen-empty-synthetic-unpaid-hire"), good = capture("qwen-proof-synthetic-unpaid-hire");
    const sameRunPositive = capture("qwen-empty-synthetic-paper-owed");
    expect(bad.sourceId).toBe(good.sourceId);
    expect(bad.runId).toBe(sameRunPositive.runId);
    expect(sourceFor(bad).raw.amount).toBe(842.65);
    expect(JSON.parse(decodedText(bad)).amount).toBe(84265);
    expect(sourceIssues(decodedText(bad), sourceFor(bad))).toEqual(["amount"]);
    expect(project(JSON.parse(decodedText(bad)), sourceFor(bad)).confirmation.amount).toBe(84265);
    expect(sourceIssues(decodedText(good), sourceFor(good))).toEqual([]);
    expect(sourceIssues(decodedText(sameRunPositive), sourceFor(sameRunPositive))).toEqual([]);
  });

  it("does not qualify a shared prompt merely because the two familiar seed images pass", () => {
    const proofRuns = fixture.runs.filter(run => run.id.endsWith("-proof"));
    expect(proofRuns.map(run => run.modelId)).toEqual(["gemma-4-e2b-it-q4", "qwen3-vl-2b-instruct-q4"]);
    expect(new Set(proofRuns.map(run => run.promptSha256))).toEqual(new Set(["384c3fae9474a0a6bb996e63b7f106194fa954d53c6e4f4b2289f81bf3c1f2f6"]));
    for (const run of proofRuns) {
      const rows = fixture.captures.filter(item => item.runId === run.id);
      const seedPair = rows.filter(item => item.sourceId === "dev-real-arabic-transfer" || item.sourceId === "dev-real-payout-range");
      expect(seedPair).toHaveLength(2);
      expect(seedPair.every(item => sourceIssues(decodedText(item), sourceFor(item)).length === 0 && item.expected.cardMatchesSource)).toBe(true);
      expect(rows.every(item => sourceIssues(decodedText(item), sourceFor(item)).length === 0)).toBe(false);
    }
  });

  it.each(["14 Jul 2026", "13 Aug 2026", "14 Aug 2025", "14 Aug 2026 09:48 PM"])(
    "never widens the calendar/timestamp source oracle to %s", date => {
      const item = capture("qwen-proof-real-arabic-transfer"), source = sourceFor(item);
      const value = { ...JSON.parse(decodedText(item)), printed_date: date };
      expect(sourceIssues(JSON.stringify(value), source)).toContain("printed_date");
    },
  );

  it("retains exact empty endpoint and missing-field rules instead of retroactively relaxing omissions", () => {
    const item = capture("gemma-proof-real-arabic-transfer"), source = sourceFor(item), value = JSON.parse(item.raw);
    for (const end of [undefined, null, "09:47 PM", "14 Aug 2026"]) {
      expect(sourceIssues(JSON.stringify({ ...value, printed_end_date: end }), source)).toContain("printed_end_date");
    }
    const missing = sourceFor(capture("gemma-proof-synthetic-missing-evidence"));
    for (const field of ["currency", "printed_date", "printed_end_date"]) for (const present of ["", null, "USD"]) {
      expect(sourceIssues(JSON.stringify({ ...missing.raw, [field]: present }), missing)).toContain(field);
    }
  });

  it("rejects duplicate keys, unknown fields, truncation and stringified amounts in the source gate", () => {
    const item = capture("gemma-proof-real-arabic-transfer"), source = sourceFor(item), value = JSON.parse(item.raw);
    for (const raw of [item.raw.slice(0, -1), item.raw.replace('"amount": 12900.00', '"amount": 1, "amount": 12900.00'),
      JSON.stringify({ ...value, amount: "12900" }), JSON.stringify({ ...value, arbitrary: "ignored" })]) {
      expect(sourceIssues(raw, source).length).toBeGreaterThan(0);
    }
  });
});
