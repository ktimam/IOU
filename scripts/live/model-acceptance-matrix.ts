// Real browser-model qualification for IOU's production prompt/parser/card pipeline.
//
// Default is deliberately cached-only. Large public GGUF downloads happen only with the explicit
// --download-missing switch. The runner never posts a chat message, calls a canister, clears model
// storage, or logs user content: every case is synthetic and run directly through production
// runAiAction + webInfer in a fresh scratch page.
//
// Example:
//   pnpm exec tsx scripts/live/model-acceptance-matrix.ts --port 19241 --models all --runs 3
//   pnpm exec tsx scripts/live/model-acceptance-matrix.ts --models qwen3-vl-2b-instruct-q4 --cases portrait-date-image --runs 1
//   pnpm exec tsx scripts/live/model-acceptance-matrix.ts --cached-attach-timeout-ms 600000
//   pnpm exec tsx scripts/live/model-acceptance-matrix.ts --port 19243 --models qwen2.5-1.5b-instruct-q4 --download-missing
import { chromium, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  MODEL_ACCEPTANCE_CASES,
  scoreModelAcceptanceCase,
  type ModelAcceptanceCase,
  type ModelAcceptanceObservation,
} from "../../src/features/openchat/modelAcceptanceCases";
import {
  buildIouOutputSchema,
  buildIouRules,
  iouActionManifest,
} from "../../src/features/openchat/actionManifest";
import {
  EXTRACT_BUNDLE,
  buildExtractChat,
  routeExtractCase,
  type ExtractChat,
  type ExtractModel,
} from "./extract-bundle-contract";
import { CDP_PORTS } from "./cdpPorts";

type CatalogFile = { url: string; sha256: string; bytes: number };
type TransformersRuntimeAsset =
  | {
      kind: "worker";
      path: string;
      minimumBytes: number;
      maximumBytes: number;
    }
  | { kind: "pinned"; path: string; bytes: number; sha256: string };
type TransformersDeviceMap = {
  embed_tokens: "webgpu";
  vision_encoder: "webgpu";
  decoder_model_merged: "webgpu";
};
type CatalogEntry = {
  id: string;
  name: string;
  description: string;
  modalities: ("text" | "image")[];
  runtime: string;
  files: CatalogFile[];
  sizeBytes: number;
  fingerprint: string;
  repository?: string;
  revision?: string;
  runtimeAssets?: TransformersRuntimeAsset[];
  deviceMap?: TransformersDeviceMap;
};

type CacheRecord = {
  originalURL: string;
  originalSize: number;
  sha256?: string;
  actualSize: number;
};

type RuntimeEvent = {
  elapsedMs: number;
  status: string;
  generation?: { stage: string; phase: string; chunks: number };
};

type InferCall = {
  durationMs: number;
  kind: string;
  outputChars: number;
  output?: string;
  error?: string;
};

type CaseRun = {
  id: string;
  run: number;
  warmup: boolean;
  observation: ModelAcceptanceObservation;
  score: ReturnType<typeof scoreModelAcceptanceCase>;
  infer: InferCall[];
  events: RuntimeEvent[];
};

type Args = {
  port: number;
  modelIds: "all" | string[];
  caseIds: "all" | ModelAcceptanceCase["id"][];
  runs: number;
  cachedAttachTimeoutMs: number;
  downloadMissing: boolean;
  profile: "desktop" | "mobile-emulated";
  extractBundle: boolean;
  output?: string;
};

function valueAfter(argv: string[], name: string): string | undefined {
  const exact = argv.findIndex((arg) => arg === name);
  if (exact >= 0) return argv[exact + 1];
  return argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

function parseArgs(argv: string[]): Args {
  const port = Number(valueAfter(argv, "--port") ?? CDP_PORTS.manager);
  const runs = Number(valueAfter(argv, "--runs") ?? 3);
  const cachedAttachTimeoutMs = Number(
    valueAfter(argv, "--cached-attach-timeout-ms") ?? 10 * 60_000,
  );
  const models = valueAfter(argv, "--models") ?? "all";
  const cases = valueAfter(argv, "--cases") ?? "all";
  const profile = valueAfter(argv, "--profile") ?? "desktop";
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error("invalid --port");
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10)
    throw new Error("--runs must be 1..10");
  if (
    !Number.isSafeInteger(cachedAttachTimeoutMs) ||
    cachedAttachTimeoutMs < 30_000 ||
    cachedAttachTimeoutMs > 20 * 60_000
  ) {
    throw new Error("--cached-attach-timeout-ms must be 30000..1200000");
  }
  if (profile !== "desktop" && profile !== "mobile-emulated") {
    throw new Error("--profile must be desktop or mobile-emulated");
  }
  const extractBundle = argv.includes("--extract-bundle");
  if (extractBundle && runs !== 1) {
    throw new Error("the Extract bundle gate is deliberately bounded to --runs 1");
  }
  const modelIds =
    models === "all"
      ? "all"
      : models
          .split(",")
          .map((model) => model.trim())
          .filter(Boolean);
  if (modelIds !== "all" && modelIds.length === 0)
    throw new Error("--models is empty");
  const caseIds =
    cases === "all"
      ? "all"
      : cases
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
  if (caseIds !== "all") {
    if (caseIds.length === 0) throw new Error("--cases is empty");
    const known = new Set(MODEL_ACCEPTANCE_CASES.map(({ id }) => id));
    const unknown = caseIds.filter((id) => !known.has(id as ModelAcceptanceCase["id"]));
    if (unknown.length > 0)
      throw new Error(`unknown --cases id(s): ${unknown.join(", ")}`);
    if (new Set(caseIds).size !== caseIds.length)
      throw new Error("--cases contains duplicate ids");
  }
  return {
    port,
    modelIds,
    caseIds: caseIds as Args["caseIds"],
    runs,
    cachedAttachTimeoutMs,
    downloadMissing: argv.includes("--download-missing"),
    profile,
    extractBundle,
    output: valueAfter(argv, "--output"),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const PLAYWRIGHT_EVALUATE_NAME_HELPER =
  "globalThis.__name ??= (target, value) => Object.defineProperty(target, 'name', { value, configurable: true });";

const PHONE_QWEN3_VL_2B_MODEL_ID = "qwen3-vl-2b-instruct-q4";

// These served sources collectively choose, verify, prepare input for, and execute the pinned
// browser runtime under qualification. Keep the manifest/readiness modules in this digest: a
// result must become stale when its ONNX revision, artifact hashes, cache proof, WebGPU layout, or
// runtime settings change even if IOU's prompt and parser do not.
const QUALIFICATION_RUNTIME_SOURCE_URLS = [
  "/src/utils/modelCatalog.ts",
  "/src/utils/webInference.ts",
  "/src/utils/inferenceImage.ts",
  "/src/utils/onDeviceInference.ts",
  "/src/utils/aiActionRunner.ts",
  "/src/utils/transformersWebGpuProtocol.ts",
  "/src/utils/transformersWebGpuInference.ts",
  "/src/utils/transformersWebGpuImageLayout.ts",
  "/src/utils/transformersWebGpuProcessorConfig.ts",
  "/src/utils/transformersWebGpuDevRuntimeVersion.ts",
  "/src/stores/transformersWebGpuSettings.ts",
  "/transformersWebGpuFeatureFlag.mjs",
  "/src/workers/transformersWebGpuInference.worker.ts",
  // Hash the exact executable bundle too. Its build transform and bundled runtime dependencies can
  // change behavior even when the TypeScript entry point itself is unchanged.
  "/transformers_webgpu_worker.js",
] as const;

// OpenChat no longer ships the old acceptance-only modelQualification module. Keep the execution
// identity canonical here so the gate can run against the current app without weakening the
// fingerprint: these are exactly the catalog fields that can alter loading or inference.
function modelArtifactFingerprint(entry: CatalogEntry): string {
  return sha256(
    JSON.stringify({
      id: entry.id,
      runtime: entry.runtime,
      repository: entry.repository,
      revision: entry.revision,
      modalities: entry.modalities,
      files: entry.files.map(({ url, sha256: digest, bytes }) => ({
        url,
        sha256: digest,
        bytes,
      })),
      runtimeAssets: entry.runtimeAssets,
      deviceMap: entry.deviceMap,
      sizeBytes: entry.sizeBytes,
    }),
  );
}

function isTransformersWebGpuQwen(entry: CatalogEntry): boolean {
  return (
    entry.id === PHONE_QWEN3_VL_2B_MODEL_ID &&
    entry.runtime === "transformers-webgpu" &&
    typeof entry.repository === "string" &&
    typeof entry.revision === "string" &&
    entry.files.length > 0
  );
}

function modelResultProvenance(entry: CatalogEntry) {
  return {
    id: entry.id,
    name: entry.name,
    runtime: entry.runtime,
    fingerprint: entry.fingerprint,
    artifacts: entry.files,
    modalities: entry.modalities,
    sizeBytes: entry.sizeBytes,
    ...(entry.repository === undefined
      ? {}
      : { repository: entry.repository }),
    ...(entry.revision === undefined ? {} : { revision: entry.revision }),
    ...(entry.runtimeAssets === undefined
      ? {}
      : { runtimeArtifacts: entry.runtimeAssets }),
    ...(entry.deviceMap === undefined ? {} : { deviceMap: entry.deviceMap }),
  };
}

function actionDefinition() {
  return {
    name: iouActionManifest.id,
    description: "IOU real-model acceptance",
    promptTemplate: iouActionManifest.prompt,
    responseSchema: buildIouOutputSchema([]),
    card: {
      title: iouActionManifest.title,
      rows: iouActionManifest.card.fields.map(({ key, label }) => ({
        valueKey: key,
        label,
      })),
      confirmLabel: "Add to IOU",
      cancelLabel: "Cancel",
    },
    endpoint: "https://invalid.example/acceptance-only",
    recipientScope: iouActionManifest.recipientScope,
    rules: buildIouRules([]),
    acceptsImage: iouActionManifest.acceptsImage,
  };
}

async function findOpenChatPage(port: number): Promise<{
  context: ReturnType<(typeof chromium)["connectOverCDP"]> extends Promise<
    infer B
  >
    ? B extends { contexts(): (infer C)[] }
      ? C
      : never
    : never;
  page: Page;
}> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error(`CDP ${port} has no browser context`);
  const page = context
    .pages()
    .find((candidate) =>
      /(?:localhost:5003|\.ts\.net)(?:\/|$)/i.test(candidate.url()),
    );
  if (!page) throw new Error(`CDP ${port} has no OpenChat page`);
  return { context: context as never, page };
}

async function liveQualification(page: Page): Promise<{
  models: CatalogEntry[];
  runtimeDigest: string;
}> {
  const live = await page.evaluate(async (sourceUrls) => {
    const catalog = await import("/src/utils/modelCatalog.ts");
    const protocol = await import("/src/utils/transformersWebGpuProtocol.ts");
    const sources: Record<string, string> = {};
    for (const url of sourceUrls) {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok)
        throw new Error(`served source ${url} returned ${response.status}`);
      sources[url] = await response.text();
    }
    const runnerSource = sources["/src/utils/aiActionRunner.ts"];
    const sharedSpecifier = runnerSource.match(
      /import\s*\{[\s\S]*?\brunAiAction\b[\s\S]*?\}\s*from\s*["']([^"']+)["']/,
    )?.[1];
    if (sharedSpecifier === undefined) {
      throw new Error("served aiActionRunner has no discoverable shared runAiAction import");
    }
    const sharedUrl = new URL(sharedSpecifier, location.origin).href;
    const sharedResponse = await fetch(sharedUrl, { cache: "no-store" });
    if (!sharedResponse.ok) {
      throw new Error(`served shared runtime ${sharedUrl} returned ${sharedResponse.status}`);
    }
    sources[sharedUrl] = await sharedResponse.text();
    const domainSpecifier = sources[sharedUrl].match(
      /from\s*["']([^"']*\/domain\/index\.ts[^"']*)["']/,
    )?.[1];
    if (domainSpecifier === undefined) {
      throw new Error("served shared runtime has no discoverable domain index import");
    }
    const domainUrl = new URL(domainSpecifier, location.origin).href;
    const domainResponse = await fetch(domainUrl, { cache: "no-store" });
    if (!domainResponse.ok)
      throw new Error(`served shared domain ${domainUrl} returned ${domainResponse.status}`);
    sources[domainUrl] = await domainResponse.text();
    const actionSpecifier = sources[domainUrl].match(
      /from\s*["']([^"']*\/domain\/aiAction\.ts[^"']*)["']/,
    )?.[1];
    if (actionSpecifier === undefined) {
      throw new Error("served shared domain has no discoverable aiAction import");
    }
    const actionUrl = new URL(actionSpecifier, location.origin).href;
    const actionResponse = await fetch(actionUrl, { cache: "no-store" });
    if (!actionResponse.ok)
      throw new Error(`served aiAction runtime ${actionUrl} returned ${actionResponse.status}`);
    sources[actionUrl] = await actionResponse.text();
    const encode = (value: string) => new TextEncoder().encode(value);
    const hex = (bytes: ArrayBuffer) =>
      [...new Uint8Array(bytes)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    const sourceDigests: Record<string, string> = {};
    for (const url of [...sourceUrls, sharedUrl, domainUrl, actionUrl]) {
      sourceDigests[url] = hex(
        await crypto.subtle.digest("SHA-256", encode(sources[url])),
      );
    }
    const catalogModels = catalog.webEligibleModels(catalog.defaultModelCatalog.models);
    const qwenCatalog = catalogModels.find(
      (entry) => entry.id === protocol.PHONE_QWEN3_VL_2B_MODEL_ID,
    );
    if (qwenCatalog === undefined) {
      throw new Error("served catalog omits the pinned all-WebGPU Qwen model");
    }
    const qwenArtifactBytes = protocol.TRANSFORMERS_QWEN_ARTIFACTS.reduce(
      (total, artifact) => total + artifact.bytes,
      0,
    );
    if (qwenArtifactBytes !== protocol.TRANSFORMERS_QWEN_ARTIFACT_BYTES) {
      throw new Error("served all-WebGPU Qwen artifact total is inconsistent");
    }
    const qwenDeviceMap = protocol.TRANSFORMERS_QWEN_DEVICE_MAP;
    if (
      JSON.stringify(Object.keys(qwenDeviceMap).sort()) !==
        JSON.stringify(["decoder_model_merged", "embed_tokens", "vision_encoder"]) ||
      qwenDeviceMap.embed_tokens !== "webgpu" ||
      qwenDeviceMap.vision_encoder !== "webgpu" ||
      qwenDeviceMap.decoder_model_merged !== "webgpu"
    ) {
      throw new Error("served Qwen session device map is not exactly all-WebGPU");
    }
    const qwen = {
      ...qwenCatalog,
      runtime: "transformers-webgpu",
      repository: protocol.TRANSFORMERS_QWEN_MODEL_ID,
      revision: protocol.TRANSFORMERS_QWEN_REVISION,
      files: protocol.TRANSFORMERS_QWEN_ARTIFACTS.map((artifact) => ({
        // This is the exact production route, including audited local graph overrides. A direct
        // upstream URL would falsely claim that its bytes necessarily match the served hashes.
        url: `${protocol.TRANSFORMERS_WEBGPU_MODEL_PROXY_BASE}${protocol.TRANSFORMERS_QWEN_MODEL_ID}/resolve/${protocol.TRANSFORMERS_QWEN_REVISION}/${artifact.path}`,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
      })),
      runtimeAssets: protocol.TRANSFORMERS_WEBGPU_RUNTIME_ASSETS.map((asset) => ({
        ...asset,
      })),
      deviceMap: { ...qwenDeviceMap },
      sizeBytes: protocol.TRANSFORMERS_QWEN_ARTIFACT_BYTES,
    };
    return {
      models: catalogModels.map((entry) =>
        entry.id === protocol.PHONE_QWEN3_VL_2B_MODEL_ID ? qwen : entry,
      ),
      runtimeDigest: hex(
        await crypto.subtle.digest(
          "SHA-256",
          encode(JSON.stringify(sourceDigests)),
        ),
      ),
    };
  }, [...QUALIFICATION_RUNTIME_SOURCE_URLS]);
  return {
    models: live.models.map((entry: CatalogEntry) => ({
      ...entry,
      fingerprint: modelArtifactFingerprint(entry),
    })),
    runtimeDigest: live.runtimeDigest,
  };
}

async function readCache(page: Page): Promise<CacheRecord[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    let cache: FileSystemDirectoryHandle;
    try {
      cache = await root.getDirectoryHandle("cache");
    } catch {
      return [];
    }
    const result: CacheRecord[] = [];
    for await (const [name, handle] of cache.entries()) {
      if (handle.kind !== "file" || !name.startsWith("__metadata__")) continue;
      try {
        const metadata = JSON.parse(await (await handle.getFile()).text()) as {
          originalURL?: unknown;
          originalSize?: unknown;
          sha256?: unknown;
        };
        if (
          typeof metadata.originalURL !== "string" ||
          !Number.isSafeInteger(metadata.originalSize)
        ) {
          continue;
        }
        const dataName = name.slice("__metadata__".length);
        const data = await cache.getFileHandle(dataName);
        result.push({
          originalURL: metadata.originalURL,
          originalSize: Number(metadata.originalSize),
          sha256:
            typeof metadata.sha256 === "string" ? metadata.sha256 : undefined,
          actualSize: (await data.getFile()).size,
        });
      } catch {
        // Ignore malformed/unpaired entries. Qualification never clears them or treats them as valid.
      }
    }
    return result;
  });
}

/** Use the production all-WebGPU cache verifier with an explicit base URL so every qualification
 * call performs a fresh revision/hash/body proof instead of reusing its per-page memoized result. */
async function transformersWebGpuCacheReady(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const runtime = await import("/src/utils/transformersWebGpuInference.ts");
    const options = { baseUrl: location.href };
    return (
      (await runtime.transformersWebGpuModelDownloaded(options)) &&
      (await runtime.transformersWebGpuRuntimeAvailableOffline(options))
    );
  });
}

function cachedEvaluationEntry(
  entry: CatalogEntry,
  cache: CacheRecord[],
): {
  entry?: CatalogEntry;
  aliases: { catalogUrl: string; cachedUrl: string }[];
  missing: CatalogFile[];
} {
  const aliases: { catalogUrl: string; cachedUrl: string }[] = [];
  const missing: CatalogFile[] = [];
  const files = entry.files.map((file) => {
    const exact = cache.find(
      (candidate) =>
        candidate.originalSize === file.bytes &&
        candidate.actualSize === file.bytes &&
        candidate.originalURL === file.url,
    );
    // Exact immutable URL + exact bytes is a safe preflight hit; useWebModelFromUrl performs the
    // authoritative full SHA-256 check before loading. A different (legacy /resolve/main/) URL is
    // reusable only when its stored digest also matches the catalog artifact.
    const alias = cache.find(
      (candidate) =>
        candidate.originalSize === file.bytes &&
        candidate.actualSize === file.bytes &&
        candidate.sha256?.toLowerCase() === file.sha256.toLowerCase(),
    );
    const found = exact ?? alias;
    if (!found) {
      missing.push(file);
      return file;
    }
    if (found.originalURL !== file.url) {
      aliases.push({ catalogUrl: file.url, cachedUrl: found.originalURL });
    }
    return { ...file, url: found.originalURL };
  });
  return {
    entry: missing.length === 0 ? { ...entry, files } : undefined,
    aliases,
    missing,
  };
}

async function createScratchPage(
  context: Awaited<ReturnType<typeof findOpenChatPage>>["context"],
  origin: string,
  profile: Args["profile"],
): Promise<Page> {
  const page = await (context as any).newPage();
  // tsx/esbuild preserves nested function names with a tiny `__name` helper. Playwright serializes
  // evaluate callbacks without the module prelude that defines it, so make the standard helper
  // available only in this disposable acceptance page.
  await page.addInitScript({
    content: PLAYWRIGHT_EVALUATE_NAME_HELPER,
  });
  if (profile === "mobile-emulated") {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "userAgent", {
        configurable: true,
        get: () =>
          "Mozilla/5.0 (Linux; Android 14; acceptance-emulation) AppleWebKit/537.36 Chrome/150 Mobile Safari/537.36",
      });
      try {
        Object.defineProperty(Navigator.prototype, "userAgentData", {
          configurable: true,
          get: () => ({ mobile: true, platform: "Android", brands: [] }),
        });
      } catch {
        // UA regex remains sufficient for the production mobile branch.
      }
    });
  }
  await page.goto(`${origin}/communities`, {
    waitUntil: "domcontentloaded",
    // A real Android Chrome tab can spend substantially longer compiling the unbundled Vite
    // module graph than desktop Chrome, especially when the source origin is reached through the
    // public HTTPS Funnel. Keep the desktop fail-fast behavior while allowing the emulated mobile
    // runtime to finish its cold navigation before model download or inference begins.
    timeout: profile === "mobile-emulated" ? 120_000 : 30_000,
  });
  return page;
}

async function closeScratchPage(page: Page): Promise<void> {
  // A crashed renderer can leave Playwright's close acknowledgement pending forever. Sending close
  // is still important because it terminates healthy Wllama workers, but cleanup must never prevent
  // the runner from writing the failure evidence it already collected.
  await Promise.race([
    page.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

async function pageEnvironment(page: Page) {
  return page.evaluate(async (sourceUrls) => {
    const sources: Record<string, string> = {};
    for (const url of sourceUrls) {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok)
        throw new Error(`served source ${url} returned ${response.status}`);
      sources[url] = await response.text();
    }
    const runnerSource = sources["/src/utils/aiActionRunner.ts"];
    const sharedSpecifier = runnerSource.match(
      /import\s*\{[\s\S]*?\brunAiAction\b[\s\S]*?\}\s*from\s*["']([^"']+)["']/,
    )?.[1];
    if (sharedSpecifier === undefined) {
      throw new Error("served aiActionRunner has no discoverable shared runAiAction import");
    }
    const sharedUrl = new URL(sharedSpecifier, location.origin).href;
    const sharedResponse = await fetch(sharedUrl, { cache: "no-store" });
    if (!sharedResponse.ok)
      throw new Error(`served shared runtime ${sharedUrl} returned ${sharedResponse.status}`);
    sources[sharedUrl] = await sharedResponse.text();
    const domainSpecifier = sources[sharedUrl].match(
      /from\s*["']([^"']*\/domain\/index\.ts[^"']*)["']/,
    )?.[1];
    if (domainSpecifier === undefined) {
      throw new Error("served shared runtime has no discoverable domain index import");
    }
    const domainUrl = new URL(domainSpecifier, location.origin).href;
    const domainResponse = await fetch(domainUrl, { cache: "no-store" });
    if (!domainResponse.ok)
      throw new Error(`served shared domain ${domainUrl} returned ${domainResponse.status}`);
    sources[domainUrl] = await domainResponse.text();
    const actionSpecifier = sources[domainUrl].match(
      /from\s*["']([^"']*\/domain\/aiAction\.ts[^"']*)["']/,
    )?.[1];
    if (actionSpecifier === undefined) {
      throw new Error("served shared domain has no discoverable aiAction import");
    }
    const actionUrl = new URL(actionSpecifier, location.origin).href;
    const actionResponse = await fetch(actionUrl, { cache: "no-store" });
    if (!actionResponse.ok)
      throw new Error(`served aiAction runtime ${actionUrl} returned ${actionResponse.status}`);
    sources[actionUrl] = await actionResponse.text();
    // Import the production leaf rather than the package barrel. The barrel eagerly pulls browser
    // modules unrelated to action execution and can fail in a disposable mobile-emulated page even
    // though the exact aiAction leaf is served and runnable.
    const shared = await import(/* @vite-ignore */ actionUrl);
    const encode = (value: string) => new TextEncoder().encode(value);
    const hex = (bytes: ArrayBuffer) =>
      [...new Uint8Array(bytes)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    const sourceDigests: Record<string, string> = {};
    for (const [url, source] of Object.entries(sources)) {
      sourceDigests[url] = hex(
        await crypto.subtle.digest("SHA-256", encode(source)),
      );
    }
    return {
      origin: location.origin,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: (navigator as Navigator & { deviceMemory?: number })
        .deviceMemory,
      crossOriginIsolated: globalThis.crossOriginIsolated,
      sourceDigests,
      sourceMarkers: {
        // Qwen's all-WebGPU worker reconstructs the one-turn conversation and processor inputs for
        // every request, then disposes those tensors. The retired wllama `cache_prompt` marker made
        // this gate reject the current production engine before any model inference could run.
        independentPromptState:
          sources["/src/utils/webInference.ts"].includes(
            "transformersWebGpuInfer({",
          ) &&
          sources[
            "/src/workers/transformersWebGpuInference.worker.ts"
          ].includes("const conversation = [") &&
          sources[
            "/src/workers/transformersWebGpuInference.worker.ts"
          ].includes("const inputs = await processor(formatted, image)") &&
          sources[
            "/src/workers/transformersWebGpuInference.worker.ts"
          ].includes("disposeTensors(Object.values(inputs))"),
        productionRunner:
          typeof shared.runAiAction === "function" &&
          runnerSource.includes("runAiAction(") &&
          sources[actionUrl].includes("function runAiAction"),
        productionImageRegion:
          sources["/src/utils/onDeviceInference.ts"].includes(
            "prepareImageRegionForInference(",
          ) &&
          sources["/src/utils/onDeviceInference.ts"].includes(
            'request.imageRegion !== "detail_card"',
          ) &&
          sources["/src/utils/inferenceImage.ts"].includes(
            "function detailCardCrop(",
          ) &&
          sources["/src/utils/inferenceImage.ts"].includes(
            'region === "detail_card"',
          ) &&
          sources["/src/utils/inferenceImage.ts"].includes(
            "dimensions.height * 58 / 100",
          ) &&
          sources["/src/utils/inferenceImage.ts"].includes(
            "dimensions.height * 86 / 100",
          ) &&
          sources["/src/utils/inferenceImage.ts"].includes(
            "async function canvasRegionCrop(",
          ) &&
          sources[actionUrl].includes("extensionVersion !== 3") &&
          sources[actionUrl].includes('pass.imageRegion !== "detail_card"'),
        pinnedTransformersManifest:
          sources["/src/utils/transformersWebGpuProtocol.ts"].includes(
            "TRANSFORMERS_QWEN_ARTIFACTS",
          ) &&
          sources["/src/utils/transformersWebGpuProtocol.ts"].includes(
            "TRANSFORMERS_QWEN_REVISION",
          ),
        productionTransformersCacheReadiness:
          sources["/src/utils/transformersWebGpuInference.ts"].includes(
            "export async function transformersWebGpuModelDownloaded(",
          ) &&
          sources["/src/utils/transformersWebGpuInference.ts"].includes(
            "TRANSFORMERS_WEBGPU_CACHE_KEY",
          ),
      },
    };
  }, [...QUALIFICATION_RUNTIME_SOURCE_URLS]);
}

async function attachModel(page: Page, entry: CatalogEntry, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`model attachment exceeded ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  const operation = page.evaluate(async (model) => {
    const web = await import("/src/utils/webInference.ts");
    const events: RuntimeEvent[] = [];
    const started = performance.now();
    const unsubscribe = web.webModelStatus.subscribe((status: any) => {
      events.push({
        elapsedMs: performance.now() - started,
        status: status.status,
        generation: status.generation,
      });
    });
    try {
      const error = await web.useWebModelFromUrl(model, {
        purpose: "acceptance-runner",
      });
      return {
        error,
        durationMs: performance.now() - started,
        events,
        label: web.webModelLabel(),
        modalities: web.webModelModalities(),
      };
    } finally {
      unsubscribe();
    }
  }, entry);
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function catalogEntryFromExtract(model: ExtractModel): CatalogEntry {
  return {
    id: model.id,
    name: model.name,
    description: model.description,
    modalities: [...model.modalities],
    runtime: model.runtime,
    files: model.files.map((file) => ({ ...file })),
    sizeBytes: model.sizeBytes,
    fingerprint: "",
  };
}

async function fingerprintEntry(_page: Page, entry: CatalogEntry): Promise<string> {
  return modelArtifactFingerprint(entry);
}

async function loadExtractRuntime(page: Page, entry: CatalogEntry, needsImage: boolean) {
  return page.evaluate(
    async ({ model, image }) => {
      const extract = await import("/src/utils/extractBundleAcceptanceRuntime.ts");
      return extract.loadExtractAcceptanceModel(model, image);
    },
    { model: entry, image: needsImage },
  );
}

async function disposeExtractRuntime(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const extract = await import("/src/utils/extractBundleAcceptanceRuntime.ts");
    return extract.disposeExtractAcceptanceRuntime();
  });
}

async function runCase(
  page: Page,
  definition: ReturnType<typeof actionDefinition>,
  testCase: ModelAcceptanceCase,
  modelId: string,
  imageBytes?: number[],
  extractChat?: ExtractChat,
): Promise<{
  observation: ModelAcceptanceObservation;
  infer: InferCall[];
  events: RuntimeEvent[];
}> {
  return page.evaluate(
    async ({
      definition: def,
      testCase: candidate,
      modelId: selectedModelId,
      imageBytes: fixedImageBytes,
      extractChat: modelSpecificChat,
    }) => {
      const web = await import("/src/utils/webInference.ts");
      const runnerResponse = await fetch("/src/utils/aiActionRunner.ts", {
        cache: "no-store",
      });
      if (!runnerResponse.ok) {
        throw new Error(
          `served aiActionRunner returned ${runnerResponse.status}`,
        );
      }
      const runnerSource = await runnerResponse.text();
      const sharedSpecifier = runnerSource.match(
        /import\s*\{[\s\S]*?\brunAiAction\b[\s\S]*?\}\s*from\s*["']([^"']+)["']/,
      )?.[1];
      if (sharedSpecifier === undefined) {
        throw new Error(
          "served aiActionRunner has no discoverable shared runAiAction import",
        );
      }
      const sharedUrl = new URL(sharedSpecifier, location.origin).href;
      const sharedSource = await (await fetch(sharedUrl, { cache: "no-store" })).text();
      const domainSpecifier = sharedSource.match(
        /from\s*["']([^"']*\/domain\/index\.ts[^"']*)["']/,
      )?.[1];
      if (domainSpecifier === undefined) {
        throw new Error("served shared runtime has no discoverable domain index import");
      }
      const domainUrl = new URL(domainSpecifier, location.origin).href;
      const domainSource = await (await fetch(domainUrl, { cache: "no-store" })).text();
      const actionSpecifier = domainSource.match(
        /from\s*["']([^"']*\/domain\/aiAction\.ts[^"']*)["']/,
      )?.[1];
      if (actionSpecifier === undefined) {
        throw new Error("served shared domain has no discoverable aiAction import");
      }
      const ai = await import(
        /* @vite-ignore */ new URL(actionSpecifier, location.origin).href
      );
      const device =
        modelSpecificChat === undefined
          ? await import("/src/utils/onDeviceInference.ts")
          : undefined;
      const extract =
        modelSpecificChat === undefined
          ? undefined
          : await import("/src/utils/extractBundleAcceptanceRuntime.ts");

      const image =
        fixedImageBytes === undefined
          ? undefined
          : new Uint8Array(fixedImageBytes);

      const events: RuntimeEvent[] = [];
      const infer: InferCall[] = [];
      const started = performance.now();
      const unsubscribe = web.webModelStatus.subscribe((status: any) => {
        events.push({
          elapsedMs: performance.now() - started,
          status: status.status,
          generation: status.generation,
        });
      });

      const NativeDate = Date;
      let dateRestored = candidate.promptNowIso === undefined;
      const restoreDate = () => {
        if (dateRestored) return;
        dateRestored = true;
        (globalThis as any).Date = NativeDate;
      };
      if (candidate.promptNowIso !== undefined) {
        const fixed = new NativeDate(candidate.promptNowIso).getTime();
        class PromptDate extends NativeDate {
          constructor(...args: ConstructorParameters<typeof Date>) {
            super(...((args.length === 0 ? [fixed] : args) as [number]));
          }
          static now() {
            return fixed;
          }
        }
        (globalThis as any).Date = PromptDate;
      }

      try {
        const result = await ai.runAiAction(
          def,
          {
            modelId: selectedModelId,
            ...(candidate.text === undefined ? {} : { text: candidate.text }),
            ...(image === undefined ? {} : { image }),
          },
          "-----BEGIN PUBLIC KEY-----\nACCEPTANCE\n-----END PUBLIC KEY-----\n",
          async (request: any) => {
            // runAiAction has already constructed its Today/message/rules prompt synchronously.
            // Restore the native clock before Wllama, timers, and timing measurements execute.
            restoreDate();
            const callStarted = performance.now();
            const response =
              extract === undefined
                ? await device!.inferOnDevice(request)
                : await extract.inferWithExtractAcceptanceModel({
                    modelId: selectedModelId,
                    systemPrompt: modelSpecificChat.systemPrompt,
                    userPrompt: modelSpecificChat.userPrompt,
                    image: request.image,
                    maxTokens: request.maxTokens,
                  });
            infer.push({
              durationMs: performance.now() - callStarted,
              kind: response.kind,
              outputChars: response.kind === "ok" ? response.text.length : 0,
              output:
                response.kind === "ok"
                  ? response.text.slice(0, 4_096)
                  : undefined,
              error: response.kind === "error" ? response.error : undefined,
            });
            return response;
          },
        );
        restoreDate();
        const isReady =
          result.kind === "ready" || result.kind === "ready_multi";
        const extracted = isReady
          ? Array.isArray(result.extracted)
            ? result.extracted
            : [result.extracted]
          : [];
        let confirmPayload: unknown;
        if (isReady && result.card.confirmPayload !== undefined) {
          try {
            confirmPayload = JSON.parse(
              new TextDecoder().decode(result.card.confirmPayload),
            );
          } catch {
            confirmPayload = "<invalid-json>";
          }
        }
        return {
          observation: {
            resultKind: result.kind,
            extracted,
            cardRows: isReady ? result.card.rows : [],
            confirmPayload,
            inferCalls: infer.length,
            actionMs: performance.now() - started,
          },
          infer,
          events,
        };
      } finally {
        restoreDate();
        unsubscribe();
      }
    },
    { definition, testCase, modelId, imageBytes, extractChat },
  );
}

function loadAcceptanceImage(
  testCase: ModelAcceptanceCase,
): number[] | undefined {
  const fixture = testCase.imageFixture;
  if (fixture === undefined) return undefined;
  const bytes = readFileSync(join(process.cwd(), fixture.path));
  if (bytes.byteLength !== fixture.bytes) {
    throw new Error(
      `${testCase.id} fixture expected ${fixture.bytes} bytes, observed ${bytes.byteLength}`,
    );
  }
  const digest = sha256(bytes);
  if (digest !== fixture.sha256) {
    throw new Error(
      `${testCase.id} fixture SHA-256 expected ${fixture.sha256}, observed ${digest}`,
    );
  }
  return Array.from(bytes);
}

async function extractRuntimeSourceEvidence(page: Page): Promise<{
  url: string;
  sha256: string;
  developmentOnly: boolean;
}> {
  return page.evaluate(async () => {
    const url = "/src/utils/extractBundleAcceptanceRuntime.ts";
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`served source ${url} returned ${response.status}`);
    const source = await response.text();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    return {
      url,
      sha256: [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
      developmentOnly:
        source.includes('"DEV": true') &&
        source.includes("disabled outside a development build"),
    };
  });
}

async function runExtractBundleGate(input: {
  args: Args;
  cases: readonly ModelAcceptanceCase[];
  context: Awaited<ReturnType<typeof findOpenChatPage>>["context"];
  existingPage: Page;
  origin: string;
  definition: ReturnType<typeof actionDefinition>;
  initialCache: CacheRecord[];
  checkpoint(result: any): void;
}): Promise<any> {
  const { args, cases, context, existingPage, origin, definition, initialCache, checkpoint } = input;
  const textEntry = catalogEntryFromExtract(EXTRACT_BUNDLE.text);
  const visionEntry = catalogEntryFromExtract(EXTRACT_BUNDLE.vision);
  textEntry.fingerprint = await fingerprintEntry(existingPage, textEntry);
  visionEntry.fingerprint = await fingerprintEntry(existingPage, visionEntry);

  const result: any = {
    id: EXTRACT_BUNDLE.id,
    name: "LFM text + vision Extract bundle (acceptance only)",
    status: "running",
    license: EXTRACT_BUNDLE.license,
    licenseUrl: EXTRACT_BUNDLE.licenseUrl,
    sizeBytes: EXTRACT_BUNDLE.sizeBytes,
    fingerprint: sha256(`${textEntry.fingerprint}:${visionEntry.fingerprint}`),
    models: [
      {
        id: textEntry.id,
        fingerprint: textEntry.fingerprint,
        artifacts: textEntry.files,
        sizeBytes: textEntry.sizeBytes,
      },
      {
        id: visionEntry.id,
        fingerprint: visionEntry.fingerprint,
        artifacts: visionEntry.files,
        sizeBytes: visionEntry.sizeBytes,
      },
    ],
    stages: [],
    cases: [] as (CaseRun & { route: string; modelId: string })[],
  };
  const scratch = await createScratchPage(context, origin, args.profile);
  try {
    result.environment = await pageEnvironment(scratch);
    result.extractRuntimeSource = await extractRuntimeSourceEvidence(scratch);
    if (
      result.environment.sourceMarkers.independentPromptState !== true ||
      result.environment.sourceMarkers.productionRunner !== true ||
      result.extractRuntimeSource.developmentOnly !== true
    ) {
      throw new Error("live page is not serving the expected production and Extract acceptance sources");
    }

    const stageDefinitions = [
      {
        route: "text" as const,
        entry: textEntry,
        needsImage: false,
        cases: cases.filter((candidate) => candidate.modality === "text"),
      },
      {
        route: "vision" as const,
        entry: visionEntry,
        needsImage: true,
        cases: cases.filter((candidate) => candidate.modality === "image"),
      },
    ].filter((stage) => stage.cases.length > 0);

    let failed = false;
    for (let stageIndex = 0; stageIndex < stageDefinitions.length && !failed; stageIndex += 1) {
      const stageDefinition = stageDefinitions[stageIndex];
      const model = stageDefinition.entry;
      const cached = cachedEvaluationEntry(model, initialCache);
      let evaluationEntry = cached.entry;
      const stage: any = {
        route: stageDefinition.route,
        modelId: model.id,
        fingerprint: model.fingerprint,
        cacheAliases: cached.aliases,
        missingBefore: cached.missing,
        coldDownload: cached.entry === undefined,
      };
      result.stages.push(stage);
      checkpoint(result);

      if (!evaluationEntry && !args.downloadMissing) {
        result.status = "missing_cache";
        result.failureReasons = [
          `${model.id} is missing ${cached.missing.length} immutable artifact(s)`,
        ];
        return result;
      }
      if (!evaluationEntry) {
        const estimate = await existingPage.evaluate(() => navigator.storage.estimate());
        const requiredDownloadBytes = model.sizeBytes;
        const available = (estimate.quota ?? 0) - (estimate.usage ?? 0);
        if (available < Math.ceil(requiredDownloadBytes * 1.15)) {
          throw new Error(
            `${model.id} needs ${requiredDownloadBytes} download bytes but storage estimate has ${available} free`,
          );
        }
        evaluationEntry = model;
      }

      const switchStarted = performance.now();
      stage.disposePreviousMs = await disposeExtractRuntime(scratch);
      stage.attach = await attachModel(
        scratch,
        evaluationEntry,
        cached.entry === undefined ? 20 * 60_000 : 2 * 60_000,
      );
      if (stage.attach.error !== undefined) {
        throw new Error(`${model.id} attach failed: ${stage.attach.error}`);
      }
      stage.runtimeLoad = await loadExtractRuntime(scratch, evaluationEntry, stageDefinition.needsImage);
      stage.modelSwapMs = performance.now() - switchStarted;
      console.log(
        `\n[extract:${stageDefinition.route}] ${model.id}: attach/verify ${Math.round(
          stage.attach.durationMs,
        )} ms, runtime load ${Math.round(stage.runtimeLoad.durationMs)} ms` +
          (stageIndex === 0 ? "" : `, full swap ${Math.round(stage.modelSwapMs)} ms`),
      );
      checkpoint(result);

      const schedule = [
        { testCase: stageDefinition.cases[0], run: 0, warmup: true },
        ...stageDefinition.cases.map((testCase) => ({ testCase, run: 1, warmup: false })),
      ];
      for (const scheduled of schedule) {
        const { testCase, run, warmup } = scheduled;
        const route = routeExtractCase(testCase);
        if (route !== "deterministic" && route !== stageDefinition.route) {
          throw new Error(`${testCase.id} routed to ${route} during ${stageDefinition.route} stage`);
        }
        console.log(`  ${warmup ? "warmup" : "run 1"}: ${testCase.id} (${route})`);
        const measured = await runCase(
          scratch,
          definition,
          testCase,
          model.id,
          loadAcceptanceImage(testCase),
          route === "deterministic" ? undefined : buildExtractChat(testCase),
        );
        const score = scoreModelAcceptanceCase(testCase, measured.observation, {
          enforceLatency: !warmup,
        });
        const record = {
          id: testCase.id,
          run,
          warmup,
          route,
          modelId: route === "deterministic" ? "none" : model.id,
          observation: measured.observation,
          score,
          infer: measured.infer,
          events: measured.events,
        };
        result.cases.push(record);
        console.log(
          `    ${score.pass ? "PASS" : "FAIL"} ${Math.round(measured.observation.actionMs)} ms, ` +
            `${measured.observation.inferCalls} inference call(s)` +
            (score.pass ? "" : `: ${score.reasons.join("; ")}`),
        );
        checkpoint(result);
        if (!score.pass) {
          failed = true;
          break;
        }
      }
    }

    const expectedCaseCount = stageDefinitions.length + cases.length;
    result.status =
      !failed && result.cases.length === expectedCaseCount ? "passed" : "failed";
    result.failureReasons = result.cases.flatMap((record: CaseRun) =>
      record.score.reasons.map((reason) => `${record.id}#${record.run}: ${reason}`),
    );
    return result;
  } catch (error) {
    result.status = "error";
    result.failureReasons = [error instanceof Error ? error.message : String(error)];
    return result;
  } finally {
    result.finalDisposeMs = await disposeExtractRuntime(scratch).catch(() => undefined);
    await closeScratchPage(scratch);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { context, page: existingPage } = await findOpenChatPage(args.port);
  const existingUrl = new URL(existingPage.url());
  const origin = existingUrl.origin;
  // Unlike disposable scratch pages, the signed-in source page already exists, so addInitScript
  // cannot help its first callback. Install the same tsx serialization helper temporarily and
  // remove it in the outer finally block if the page did not already define one.
  const installedSourceNameHelper = await existingPage.evaluate(
    "typeof globalThis.__name !== 'function'",
  );
  if (installedSourceNameHelper) {
    await existingPage.evaluate(PLAYWRIGHT_EVALUATE_NAME_HELPER);
  }
  const originalSelection = await existingPage.evaluate(() =>
    localStorage.getItem("openchat_web_model_url"),
  );
  const definition = actionDefinition();
  const selectedCases: readonly ModelAcceptanceCase[] =
    args.caseIds === "all"
      ? MODEL_ACCEPTANCE_CASES
      : args.caseIds.map((id) => {
          const testCase = MODEL_ACCEPTANCE_CASES.find((candidate) => candidate.id === id);
          if (testCase === undefined) throw new Error(`unknown --cases id ${id}`);
          return testCase;
        });
  const live = await liveQualification(existingPage);
  if (!/^[0-9a-f]{64}$/.test(live.runtimeDigest)) {
    throw new Error("served qualification module has no valid runtime digest");
  }
  const allModels = live.models;
  const selectedModels =
    args.extractBundle
      ? []
      : args.modelIds === "all"
      ? allModels
      : args.modelIds.map((id) => {
          const model = allModels.find((candidate) => candidate.id === id);
          if (!model) throw new Error(`unknown/non-browser model ${id}`);
          return model;
        });
  // Qwen's production browser path never reads Wllama's GGUF OPFS cache. Avoid even consulting it
  // when Qwen is the only selected model; mixed/Extract runs retain the existing GGUF preflight for
  // their non-Transformers stages.
  const needsGgufCache =
    args.extractBundle ||
    selectedModels.some((model) => !isTransformersWebGpuQwen(model));
  const initialCache = needsGgufCache ? await readCache(existingPage) : [];
  const results: any = {
    format: args.extractBundle
      ? "iou-extract-bundle-acceptance-v1"
      : "iou-real-model-acceptance-v1",
    startedAt: new Date().toISOString(),
    args,
    profile: args.profile,
    runsPerCase: args.runs,
    manifestDigest: sha256(JSON.stringify(definition)),
    casesDigest: sha256(JSON.stringify(selectedCases)),
    runtimeDigest: live.runtimeDigest,
    models: [],
  };
  const output =
    args.output ??
    join(
      process.cwd(),
      "test-results",
      "model-acceptance",
      `${new Date().toISOString().replaceAll(":", "-")}-${
        args.extractBundle ? "extract-bundle" : `port-${args.port}`
      }.json`,
    );
  const persistResults = (): void => {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  };

  try {
    if (args.extractBundle) {
      const bundleResult = await runExtractBundleGate({
        args,
        cases: selectedCases,
        context,
        existingPage,
        origin,
        definition,
        initialCache,
        checkpoint(current) {
          results.models = [current];
          results.checkpointedAt = new Date().toISOString();
          persistResults();
        },
      });
      results.models = [bundleResult];
    } else for (const model of selectedModels) {
      console.log(
        `\n[model] ${model.id} (${Math.round(model.sizeBytes / 1024 / 1024)} MiB)`,
      );
      const transformersQwen = isTransformersWebGpuQwen(model);
      const cached = transformersQwen
        ? { entry: undefined, aliases: [], missing: [] }
        : cachedEvaluationEntry(model, initialCache);
      const transformersReadyBefore = transformersQwen
        ? await transformersWebGpuCacheReady(existingPage)
        : undefined;
      let evaluationEntry = transformersReadyBefore === true ? model : cached.entry;
      if (!evaluationEntry && !args.downloadMissing) {
        if (transformersQwen) {
          console.log(
            "  SKIP: pinned all-WebGPU ONNX manifest/runtime did not pass cache readiness",
          );
          results.models.push({
            ...modelResultProvenance(model),
            cacheReady: false,
            status: "missing_cache",
            requiredArtifacts: model.files,
          });
        } else {
          const missingBytes = cached.missing.reduce(
            (sum, file) => sum + file.bytes,
            0,
          );
          console.log(
            `  SKIP: ${cached.missing.length} artifact(s), ${missingBytes} bytes not cached`,
          );
          results.models.push({
            ...modelResultProvenance(model),
            status: "missing_cache",
            missing: cached.missing,
          });
        }
        continue;
      }
      if (!evaluationEntry) {
        const estimate = await existingPage.evaluate(() =>
          navigator.storage.estimate(),
        );
        const missingBytes = transformersQwen
          ? model.sizeBytes
          : cached.missing.reduce((sum, file) => sum + file.bytes, 0);
        // Browser model pairs are transactional: if either weights or projector is incomplete,
        // production preflight deletes both exact entries before retrying. Budget the whole pair,
        // not only the member that the metadata scan happened to report missing. The Transformers
        // path likewise owns one revision-keyed manifest and redownloads through Model Manager.
        const requiredDownloadBytes =
          transformersQwen || model.files.length > 1
            ? model.sizeBytes
            : missingBytes;
        const available = (estimate.quota ?? 0) - (estimate.usage ?? 0);
        if (available < Math.ceil(requiredDownloadBytes * 1.15)) {
          throw new Error(
            `${model.id} needs ${requiredDownloadBytes} download bytes but storage estimate has ${available} free`,
          );
        }
        console.log(
          `  downloading up to ${requiredDownloadBytes} bytes from the immutable ${
            transformersQwen ? "all-WebGPU ONNX manifest" : "catalog URLs"
          }`,
        );
        evaluationEntry = model;
      } else if (!transformersQwen && cached.aliases.length > 0) {
        console.log(
          `  reusing ${cached.aliases.length} SHA-matched legacy cache URL(s)`,
        );
      }

      const scratch = await createScratchPage(context, origin, args.profile);
      const modelResult: any = {
        ...modelResultProvenance(model),
        cacheAliases: cached.aliases,
        ...(transformersReadyBefore === undefined
          ? {}
          : { cacheReadyBefore: transformersReadyBefore }),
        status: "running",
        cases: [] as CaseRun[],
      };
      results.models.push(modelResult);
      try {
        modelResult.environment = await pageEnvironment(scratch);
        if (
          modelResult.environment.sourceMarkers.independentPromptState !==
            true ||
          modelResult.environment.sourceMarkers.productionRunner !== true ||
          modelResult.environment.sourceMarkers.productionImageRegion !== true ||
          (transformersQwen &&
            (modelResult.environment.sourceMarkers.pinnedTransformersManifest !== true ||
              modelResult.environment.sourceMarkers
                .productionTransformersCacheReadiness !== true))
        ) {
          throw new Error(
            "live page is not serving the expected production inference/runner source",
          );
        }
        const attached = await attachModel(
          scratch,
          evaluationEntry,
          (transformersQwen
            ? transformersReadyBefore !== true
            : cached.entry === undefined)
            ? 20 * 60_000
            : args.cachedAttachTimeoutMs,
        );
        modelResult.attach = attached;
        if (attached.error !== undefined)
          throw new Error(`attach failed: ${attached.error}`);
        if (transformersQwen) {
          modelResult.cacheReadyAfter = await transformersWebGpuCacheReady(scratch);
          if (modelResult.cacheReadyAfter !== true) {
            throw new Error(
              "the pinned all-WebGPU ONNX manifest failed production cache verification after attachment",
            );
          }
        }
        console.log(
          `  attached/verified in ${Math.round(attached.durationMs)} ms`,
        );

        const runAndScore = async (
          testCase: ModelAcceptanceCase,
          run: number,
          warmup: boolean,
        ) => {
          console.log(`  ${warmup ? "warmup" : `run ${run}`}: ${testCase.id}`);
          const measured = await runCase(
            scratch,
            definition,
            testCase,
            model.id,
            loadAcceptanceImage(testCase),
          );
          const score = scoreModelAcceptanceCase(
            testCase,
            measured.observation,
            {
              enforceLatency: !warmup,
            },
          );
          const record: CaseRun = {
            id: testCase.id,
            run,
            warmup,
            observation: measured.observation,
            score,
            infer: measured.infer,
            events: measured.events,
          };
          modelResult.cases.push(record);
          console.log(
            `    ${score.pass ? "PASS" : "FAIL"} ${Math.round(measured.observation.actionMs)} ms, ` +
              `${measured.observation.inferCalls} inference call(s)` +
              (score.pass ? "" : `: ${score.reasons.join("; ")}`),
          );
        };

        const textCases = selectedCases.filter(
          (candidate) => candidate.modality === "text",
        );
        const imageCases = selectedCases.filter(
          (candidate) => candidate.modality === "image",
        );
        if (textCases.length === 0 && !model.modalities.includes("image")) {
          throw new Error(`${model.id} does not support any selected --cases`);
        }
        if (textCases.length > 0) await runAndScore(textCases[0], 0, true);
        for (const testCase of textCases) {
          for (let run = 1; run <= args.runs; run += 1)
            await runAndScore(testCase, run, false);
        }
        if (model.modalities.includes("image") && imageCases.length > 0) {
          await runAndScore(imageCases[0], 0, true);
          for (const testCase of imageCases) {
            for (let run = 1; run <= args.runs; run += 1)
              await runAndScore(testCase, run, false);
          }
        }
        const expectedCaseCount =
          (textCases.length > 0 ? 1 : 0) +
          textCases.length * args.runs +
          (model.modalities.includes("image") && imageCases.length > 0
            ? 1 + imageCases.length * args.runs
            : 0);
        const passed =
          modelResult.cases.length === expectedCaseCount &&
          modelResult.cases.every((record: CaseRun) => record.score.pass);
        modelResult.status = passed ? "passed" : "failed";
        modelResult.failureReasons = modelResult.cases.flatMap(
          (record: CaseRun) =>
            record.score.reasons.map(
              (reason) => `${record.id}#${record.run}: ${reason}`,
            ),
        );
      } catch (error) {
        modelResult.status = "error";
        modelResult.failureReasons = [
          error instanceof Error ? error.message : String(error),
        ];
        console.error(`  ERROR: ${modelResult.failureReasons[0]}`);
      } finally {
        results.checkpointedAt = new Date().toISOString();
        persistResults();
        await closeScratchPage(scratch);
      }
    }
  } finally {
    await existingPage.evaluate((selection) => {
      if (selection === null) localStorage.removeItem("openchat_web_model_url");
      else localStorage.setItem("openchat_web_model_url", selection);
    }, originalSelection);
    if (installedSourceNameHelper) {
      await existingPage.evaluate("delete globalThis.__name");
    }
  }

  results.finishedAt = new Date().toISOString();
  results.pass =
    results.models.length === (args.extractBundle ? 1 : selectedModels.length) &&
    results.models.every((model: any) => model.status === "passed");
  persistResults();
  console.log(`\n[result] ${results.pass ? "PASS" : "FAIL"}: ${output}`);
  // A connectOverCDP transport keeps Node's event loop alive. Exit only this harness process; never
  // call browser.close(), which would close the user's durable signed-in Chrome profile.
  process.exit(results.pass ? 0 : 1);
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
