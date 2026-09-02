/**
 * Privacy-safe acceptance for the packaged Android WebView Transformers.js worker.
 *
 * The APK must already be running with its WebView CDP endpoint forwarded. This attaches to the
 * existing page without navigating or closing it, creates a fresh packaged module worker per run,
 * and never persists the image, its path, the page origin, raw model output, or runtime identifiers.
 *
 * Usage:
 *   pnpm exec tsx scripts/live/packaged-transformers-receipt-acceptance.ts \
 *     --cdp http://127.0.0.1:9222 \
 *     --image <receipt-image> \
 *     --model qwen3-vl-2b-instruct-q4 \
 *     --runs 2 \
 *     --output output/playwright/packaged-transformers-receipt.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page, type Request } from "@playwright/test";
import { IOU_IMAGE_EXTRACTION_PROMPT } from "../../src/features/openchat/actionManifest";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUTPUT_ROOT = resolve(REPOSITORY_ROOT, "output/playwright");
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOKENS = 96;
const WORKER_TIMEOUT_MS = 30 * 60_000;
const DISPOSE_GRACE_MS = 60_000;

const MODEL_IDS = ["gemma-4-e2b-it-q4", "qwen3-vl-2b-instruct-q4"] as const;
type ModelId = (typeof MODEL_IDS)[number];

const EXPECTED = Object.freeze({
  amount: 12_900,
  currency: "EGP",
  kind: "settlement",
  date: "2026-08-14",
});

type Options = {
  cdp: string;
  imagePath: string;
  model: ModelId;
  runs: 1 | 2;
  outputPath: string;
};

type SanitizedFields = {
  amount: number | null;
  currency: string | null;
  kind: "settlement" | "iou" | null;
  date: string | null;
};

type WorkerStatus =
  | "result"
  | "worker_error"
  | "worker_unavailable"
  | "worker_timeout"
  | "page_error";

type WorkerEvaluation =
  | { status: "result"; text: string }
  | { status: Exclude<WorkerStatus, "result"> };

type RunEvidence = {
  run: number;
  status: WorkerStatus;
  elapsedMs: number;
  observed: SanitizedFields;
  exact: boolean;
  ocrRequests: number;
};

type SetupStatus =
  | "ready"
  | "input_error"
  | "cdp_error"
  | "page_unavailable"
  | "preflight_failed";

function requiredArgument(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined || value.trim() === "") throw new Error("missing argument");
  return value;
}

function parseArguments(argv: string[]): Options {
  const supported = new Set(["--cdp", "--image", "--model", "--runs", "--output"]);
  if (argv.length !== supported.size * 2) throw new Error("invalid arguments");

  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !supported.has(name) ||
      value.startsWith("--") ||
      values.has(name)
    ) {
      throw new Error("invalid arguments");
    }
    values.set(name, value);
  }

  const cdpUrl = new URL(requiredArgument(values, "--cdp"));
  if (
    !["http:", "https:", "ws:", "wss:"].includes(cdpUrl.protocol) ||
    cdpUrl.username !== "" ||
    cdpUrl.password !== ""
  ) {
    throw new Error("invalid CDP endpoint");
  }

  const model = requiredArgument(values, "--model");
  if (!MODEL_IDS.includes(model as ModelId)) throw new Error("invalid model");

  const rawRuns = requiredArgument(values, "--runs");
  if (rawRuns !== "1" && rawRuns !== "2") throw new Error("invalid runs");

  const outputPath = resolve(REPOSITORY_ROOT, requiredArgument(values, "--output"));
  const outputRelative = relative(OUTPUT_ROOT, outputPath);
  if (
    outputRelative === "" ||
    outputRelative.startsWith("..") ||
    isAbsolute(outputRelative) ||
    extname(outputPath).toLowerCase() !== ".json"
  ) {
    throw new Error("invalid output");
  }

  return {
    cdp: cdpUrl.href.replace(/\/$/, ""),
    imagePath: resolve(requiredArgument(values, "--image")),
    model: model as ModelId,
    runs: Number(rawRuns) as 1 | 2,
    outputPath,
  };
}

function emptyFields(): SanitizedFields {
  return { amount: null, currency: null, kind: null, date: null };
}

function extractBalancedObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) {
      try {
        const parsed: unknown = JSON.parse(text.slice(start, index + 1));
        return typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>)
          : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function isStrictCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

function sanitizeResponse(text: string): SanitizedFields {
  const parsed = extractBalancedObject(text);
  const rawAmount = parsed?.amount;
  const compactAmount = typeof rawAmount === "string" ? rawAmount.trim().replace(/[,\s]/g, "") : "";
  const amountMatch = /^([+-]?\d+(?:\.\d+)?)([kKmM])?/.exec(compactAmount);
  const parsedAmount =
    typeof rawAmount === "number"
      ? rawAmount
      : amountMatch === null
        ? Number.NaN
        : Number.parseFloat(amountMatch[1]!) *
          (amountMatch[2]?.toLowerCase() === "k"
            ? 1e3
            : amountMatch[2]?.toLowerCase() === "m"
              ? 1e6
              : 1);
  const amount =
    Number.isFinite(parsedAmount) &&
    parsedAmount >= 0 &&
    parsedAmount <= 1_000_000_000_000
      ? parsedAmount
      : null;
  const rawCurrency =
    typeof parsed?.currency === "string" ? parsed.currency.trim().toUpperCase() : "";
  const currency = /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : null;
  const rawKind = typeof parsed?.kind === "string" ? parsed.kind.trim().toLowerCase() : "";
  const kind = rawKind === "settlement" || rawKind === "iou" ? rawKind : null;
  const rawDate = typeof parsed?.date === "string" ? parsed.date.trim() : "";
  const date = isStrictCalendarDate(rawDate) ? rawDate : null;
  return { amount, currency, kind, date };
}

function exactExpected(observed: SanitizedFields): boolean {
  return (
    observed.amount === EXPECTED.amount &&
    observed.currency === EXPECTED.currency &&
    observed.kind === EXPECTED.kind &&
    observed.date === EXPECTED.date
  );
}

function isOcrRequest(request: Request): boolean {
  try {
    const path = decodeURIComponent(new URL(request.url()).pathname).toLowerCase();
    return /(^|[/._-])(tesseract|traineddata|browserocr|ocrimage|ocr)([/._-]|$)/.test(
      path,
    );
  } catch {
    return false;
  }
}

function existingWebViewPage(pages: Page[]): Page | undefined {
  return (
    pages.find((page) => !page.isClosed() && /^https?:/i.test(page.url())) ??
    pages.find((page) => !page.isClosed())
  );
}

async function evaluateWorker(
  page: Page,
  imageBase64: string,
  modelId: ModelId,
): Promise<WorkerEvaluation> {
  return page.evaluate(
    async ({ encodedImage, model, prompt, maxTokens, timeoutMs }) => {
      const binary = atob(encodedImage);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
      }
      const image = bytes.buffer;
      let worker: Worker | undefined;
      try {
        worker = new Worker(
          `/transformers_webgpu_worker.js?v=${encodeURIComponent(crypto.randomUUID())}`,
          { type: "module" },
        );
      } catch {
        return { status: "worker_error" as const };
      }

      return new Promise<WorkerEvaluation>((resolveWorker) => {
        let settled = false;
        let disposeGrace: ReturnType<typeof globalThis.setTimeout> | undefined;
        const finish = (result: WorkerEvaluation) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timeout);
          if (disposeGrace !== undefined) globalThis.clearTimeout(disposeGrace);
          worker?.terminate();
          resolveWorker(result);
        };
        const timeout = globalThis.setTimeout(
          () => {
            try {
              worker?.postMessage({ kind: "dispose", requestId: 2 });
              disposeGrace = globalThis.setTimeout(
                () => finish({ status: "worker_timeout" }),
                DISPOSE_GRACE_MS,
              );
            } catch {
              finish({ status: "worker_timeout" });
            }
          },
          timeoutMs,
        );
        worker.addEventListener("error", (event) => {
          event.preventDefault();
          finish({ status: "worker_error" });
        });
        worker.addEventListener("message", (event: MessageEvent<unknown>) => {
          if (typeof event.data !== "object" || event.data === null) return;
          const message = event.data as Record<string, unknown>;
          if (message.kind === "runtime_error") {
            finish({ status: "worker_error" });
            return;
          }
          if (message.kind === "disposed" && message.requestId === 2) {
            finish({ status: "worker_timeout" });
            return;
          }
          if (message.requestId !== 1) return;
          if (message.kind === "result" && typeof message.text === "string") {
            finish({ status: "result", text: message.text });
          } else if (message.kind === "unavailable") {
            finish({ status: "worker_unavailable" });
          } else if (message.kind === "error") {
            finish({ status: "worker_error" });
          }
        });
        worker.postMessage(
          {
            kind: "infer",
            requestId: 1,
            modelId: model,
            prompt,
            image,
            maxTokens,
          },
          [image],
        );
      });
    },
    {
      encodedImage: imageBase64,
      model: modelId,
      prompt: IOU_IMAGE_EXTRACTION_PROMPT,
      maxTokens: MAX_TOKENS,
      timeoutMs: WORKER_TIMEOUT_MS,
    },
  );
}

async function releaseWakeLock(page: Page | undefined): Promise<void> {
  if (page === undefined || page.isClosed()) return;
  await page
    .evaluate(async () => {
      const root = globalThis as typeof globalThis & {
        __iouPackagedAcceptanceWakeLock?: { release(): Promise<void> };
      };
      await root.__iouPackagedAcceptanceWakeLock?.release().catch(() => undefined);
      delete root.__iouPackagedAcceptanceWakeLock;
    })
    .catch(() => undefined);
}

async function run(options: Options): Promise<boolean> {
  const startedAt = Date.now();
  let setupStatus: SetupStatus = "ready";
  let page: Page | undefined;
  let attachedExistingPage = false;
  let hadNameHelper = true;
  let ocrRequests = 0;
  const attempts: RunEvidence[] = [];
  const onRequest = (request: Request) => {
    if (isOcrRequest(request)) ocrRequests++;
  };

  try {
    let imageBase64: string;
    try {
      const image = readFileSync(options.imagePath);
      if (image.byteLength < 1 || image.byteLength > MAX_IMAGE_BYTES) {
        throw new Error("invalid image size");
      }
      imageBase64 = image.toString("base64");
    } catch {
      setupStatus = "input_error";
      throw new Error("setup failed");
    }

    let browser;
    try {
      browser = await chromium.connectOverCDP(options.cdp, { timeout: 120_000 });
    } catch {
      setupStatus = "cdp_error";
      throw new Error("setup failed");
    }

    const pages = browser.contexts().flatMap((context) => context.pages());
    page = existingWebViewPage(pages);
    if (page === undefined) {
      setupStatus = "page_unavailable";
      throw new Error("setup failed");
    }
    attachedExistingPage = true;
    page.on("request", onRequest);
    await page.bringToFront();

    hadNameHelper = await page.evaluate("Object.hasOwn(globalThis, '__name')");
    if (!hadNameHelper) {
      await page.evaluate("globalThis.__name = (target) => target");
    }
    const preflight = await page.evaluate(async () => {
      const webViewNavigator = navigator as Navigator & {
        gpu?: unknown;
        wakeLock?: {
          request(type: "screen"): Promise<{ release(): Promise<void> }>;
        };
      };
      let wakeLockActive = false;
      try {
        const lock = await webViewNavigator.wakeLock?.request("screen");
        if (lock !== undefined) {
          (
            globalThis as typeof globalThis & {
              __iouPackagedAcceptanceWakeLock?: { release(): Promise<void> };
            }
          ).__iouPackagedAcceptanceWakeLock = lock;
          wakeLockActive = true;
        }
      } catch {
        // Foreground execution is the fallback when the WebView denies Wake Lock.
      }
      return {
        android: /Android/i.test(navigator.userAgent),
        webView: /;\s*wv\)/i.test(navigator.userAgent),
        worker: typeof Worker === "function",
        webGpu: webViewNavigator.gpu !== undefined,
        wakeLockActive,
      };
    });
    if (!preflight.android || !preflight.webView || !preflight.worker || !preflight.webGpu) {
      setupStatus = "preflight_failed";
      throw new Error("setup failed");
    }

    for (let runNumber = 1; runNumber <= options.runs; runNumber++) {
      const runStartedAt = Date.now();
      const ocrBefore = ocrRequests;
      let evaluation: WorkerEvaluation;
      try {
        evaluation = await evaluateWorker(page, imageBase64, options.model);
      } catch {
        evaluation = { status: "page_error" };
      }
      const observed = evaluation.status === "result" ? sanitizeResponse(evaluation.text) : emptyFields();
      const runOcrRequests = ocrRequests - ocrBefore;
      const exact = evaluation.status === "result" && exactExpected(observed);
      attempts.push({
        run: runNumber,
        status: evaluation.status,
        elapsedMs: Date.now() - runStartedAt,
        observed,
        exact,
        ocrRequests: runOcrRequests,
      });
      process.stdout.write(
        `${JSON.stringify({ run: runNumber, status: evaluation.status, exact, ocrRequests: runOcrRequests })}\n`,
      );
    }
  } catch {
    // The report records only the bounded setup status; raw runtime errors stay in memory.
  } finally {
    if (page !== undefined) {
      page.off("request", onRequest);
      await releaseWakeLock(page);
      if (!hadNameHelper && !page.isClosed()) {
        await page.evaluate("delete globalThis.__name").catch(() => undefined);
      }
    }
  }

  const exact =
    attempts.length === options.runs &&
    attempts.every((attempt) => attempt.status === "result" && attempt.exact);
  const pass = setupStatus === "ready" && exact && ocrRequests === 0;
  const report = {
    format: "iou-packaged-transformers-receipt-acceptance-v1",
    pass,
    privacy: {
      rawImagePersisted: false,
      rawModelOutputPersisted: false,
      imagePathPersisted: false,
      pageOriginPersisted: false,
      cdpEndpointPersisted: false,
      runtimeIdentifiersPersisted: false,
      personalIdentifiersPersisted: false,
    },
    execution: {
      attachedExistingAndroidWebViewPage: attachedExistingPage,
      freshPackagedModuleWorkerPerRun: true,
      actualInferProtocol: true,
      model: options.model,
      maxTokens: MAX_TOKENS,
      requestedRuns: options.runs,
      ocrImported: false,
      ocrEnabled: false,
    },
    setupStatus,
    expected: EXPECTED,
    inference: {
      completedRuns: attempts.length,
      exact,
      attempts,
    },
    network: {
      ocrRequests,
      noOcrRequests: ocrRequests === 0,
    },
    elapsedMs: Date.now() - startedAt,
  };

  mkdirSync(dirname(options.outputPath), { recursive: true });
  writeFileSync(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ pass, setupStatus, completedRuns: attempts.length, exact, ocrRequests })}\n`,
  );
  return pass;
}

let options: Options;
try {
  options = parseArguments(process.argv.slice(2));
} catch {
  process.stderr.write(
    "Usage: provide --cdp, --image, --model (gemma-4-e2b-it-q4 or qwen3-vl-2b-instruct-q4), --runs (1 or 2), and a JSON --output under output/playwright.\n",
  );
  process.exit(2);
}

void run(options)
  .then((pass) => process.exit(pass ? 0 : 1))
  .catch(() => {
    process.stderr.write("Packaged worker acceptance could not write its privacy-safe report.\n");
    process.exit(1);
  });
