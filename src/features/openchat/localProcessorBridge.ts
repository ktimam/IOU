import { iouActionManifest } from "./actionManifest";
import { extractIouLocalCandidates, postProcessIouCandidate } from "./localExtraction";

const PREFIX = "oc:app-process:";
const MAX_BYTES = 64 * 1024;
type Binding = { frameNonce: string; requestNonce: string };
type Result = { kind: "candidates"; candidates: Record<string, unknown>[] } | { kind: "none" | "ambiguous" | "error" };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function bounded(value: unknown): boolean {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_BYTES; }
  catch { return false; }
}
function safeJson(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 256 && value.every((item) => safeJson(item, depth + 1));
  return record(value) && Object.keys(value).length <= 128 && Object.entries(value).every(
    ([key, item]) => !["__proto__", "constructor", "prototype"].includes(key) && safeJson(item, depth + 1),
  );
}
export function parseProcessorBootstrap(value: unknown): Binding | undefined {
  if (!record(value) || value.type !== PREFIX + "bootstrap" || value.version !== 1 ||
    Object.keys(value).length !== 4 || typeof value.frameNonce !== "string" ||
    typeof value.requestNonce !== "string" || !/^[a-f0-9]{48}$/.test(value.frameNonce) ||
    !/^[a-f0-9]{48}$/.test(value.requestNonce)) return undefined;
  return { frameNonce: value.frameNonce, requestNonce: value.requestNonce };
}

export function processIouRequest(value: unknown, binding: Binding): Result {
  if (!record(value) || value.type !== PREFIX + "request" || value.version !== 1 ||
    value.frameNonce !== binding.frameNonce || value.requestNonce !== binding.requestNonce ||
    value.actionId !== iouActionManifest.id || Object.keys(value).length !== 6 ||
    !record(value.input) || !safeJson(value.input) || !bounded(value)) return { kind: "error" };
  const input = value.input;
  if (Object.keys(input).some((key) => !["operation", "modality", "text", "ocrTranscripts", "sourceTimestamp", "candidates"].includes(key)) ||
    !["text", "image", "audio"].includes(String(input.modality)) ||
    (input.text !== undefined && (typeof input.text !== "string" || new TextEncoder().encode(input.text).byteLength > 32 * 1024)) ||
    (input.sourceTimestamp !== undefined && (typeof input.sourceTimestamp !== "number" || !Number.isFinite(input.sourceTimestamp) || Math.abs(input.sourceTimestamp) > 8.64e15))) return { kind: "error" };
  const text = typeof input.text === "string" ? input.text : undefined;
  const sourceTimestamp = typeof input.sourceTimestamp === "number" ? input.sourceTimestamp : undefined;
  try {
    if (input.operation === "extract" && input.modality === "image" && input.candidates === undefined && Array.isArray(input.ocrTranscripts)) {
      const transcripts = input.ocrTranscripts;
      if (transcripts.length !== 2 || !transcripts.every((item) => record(item) &&
        Object.keys(item).length === 2 && typeof item.profile === "string" && typeof item.text === "string") ||
        new Set(transcripts.map((item) => item.profile)).size !== 2) return { kind: "error" };
      const primary = transcripts.find((item) => item.profile === "eng");
      const semantic = transcripts.find((item) => item.profile === "ara+eng");
      if (!primary || !semantic) return { kind: "error" };
      const result = extractIouLocalCandidates({ source: "ocr", text: primary.text,
        ocrSemanticText: semantic.text, ...(text === undefined ? {} : { messageText: text }),
        ...(sourceTimestamp === undefined ? {} : { now: new Date(sourceTimestamp) }) });
      return result.kind === "candidates" ? { kind: "candidates", candidates: result.candidates }
        : { kind: result.kind === "ambiguous" ? "ambiguous" : "none" };
    }
    if (input.operation === "extract" && input.candidates === undefined && text !== undefined) {
      const result = extractIouLocalCandidates({ source: input.modality === "image" ? "ocr" : "text", text,
        ...(sourceTimestamp === undefined ? {} : { now: new Date(sourceTimestamp) }) });
      return result.kind === "candidates" ? { kind: "candidates", candidates: result.candidates }
        : { kind: result.kind === "ambiguous" ? "ambiguous" : "none" };
    }
    if (input.operation === "normalize" && Array.isArray(input.candidates) &&
      input.candidates.length > 0 && input.candidates.length <= 16 && input.candidates.every(record)) {
      const candidates = input.candidates.map((candidate) => postProcessIouCandidate(candidate, {
        text, sourceTimestamp, modality: input.modality as "text" | "image" | "audio",
        candidateCount: (input.candidates as unknown[]).length,
      }));
      return { kind: "candidates", candidates };
    }
  } catch { return { kind: "error" }; }
  return { kind: "error" };
}

/** Pure local app code; this frame never loads an account, requests keys, or calls a backend. */
export function attachIouLocalProcessor(target: Window = window): () => void {
  let binding: Binding | undefined;
  let parentOrigin: string | undefined;
  let completed = false;
  const receive = (event: MessageEvent) => {
    if (completed || target.parent === target || event.source !== target.parent) return;
    if (binding === undefined) {
      const bootstrap = parseProcessorBootstrap(event.data);
      if (bootstrap === undefined) return;
      try {
        const origin = new URL(event.origin);
        if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "tauri.localhost"].includes(origin.hostname)) && origin.protocol !== "tauri:") return;
      } catch { return; }
      binding = bootstrap;
      parentOrigin = event.origin;
      target.parent.postMessage({ type: PREFIX + "ready", version: 1, ...binding }, parentOrigin);
      return;
    }
    if (event.origin !== parentOrigin || !record(event.data) || event.data.type !== PREFIX + "request") return;
    completed = true;
    const result = processIouRequest(event.data, binding);
    target.parent.postMessage({ type: PREFIX + "result", version: 1, ...binding, ...result }, parentOrigin!);
  };
  target.addEventListener("message", receive);
  return () => { completed = true; binding = undefined; parentOrigin = undefined; target.removeEventListener("message", receive); };
}
