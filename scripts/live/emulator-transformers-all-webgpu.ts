// Isolated Android-Chrome acceptance harness for direct Qwen3-VL 2B image inference.
// It deliberately has no OCR imports or text-extraction fallback. All three ONNX sessions are
// explicitly mapped to WebGPU and the worker is terminated after one bounded attempt. Pass the
// OpenChat frontend with --openchat-frontend or OC_LIVE_OPENCHAT_FRONTEND; the harness validates
// the exact Transformers browser module below that root before connecting to Chrome.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { resolveOpenChatViteFsModule } from "./openChatFrontendDependency";

type DType = "q4" | "q4f16";

const MODEL_ID = "onnx-community/Qwen3-VL-2B-Instruct-ONNX";
const MODEL_REVISION = "3e4136ea66ae6e07c110e64fe07da2e029517ab5";
const MODULE_URL = resolveOpenChatViteFsModule(
  "node_modules/@huggingface/transformers/dist/transformers.web.min.js",
);
const ORT_ASSET_BASE = "/assets/transformers-webgpu/ort-1.26.0-dev.20260416-b7804b056c";
const MODEL_PROXY_BASE = "/hf-model/";

const MODEL_BYTES = {
  q4: 1_520_859_938,
  q4f16: 1_373_092_553,
} as const;

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const dtype = arg("--dtype", "q4f16") as DType;
if (dtype !== "q4" && dtype !== "q4f16") throw new Error("--dtype must be q4 or q4f16");
const visionDtype = arg("--vision-dtype", dtype) as DType;
if (visionDtype !== "q4" && visionDtype !== "q4f16") {
  throw new Error("--vision-dtype must be q4 or q4f16");
}
const imagePath = arg("--image");
if (imagePath === undefined) throw new Error("--image is required");
const cdp = arg("--cdp", "http://127.0.0.1:9231")!;
const origin = arg("--origin", "http://127.0.0.1:5003")!;
const timeoutMs = Number(arg("--timeout-ms", dtype === "q4" ? "3600000" : "120000"));
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 3_600_000) {
  throw new Error("--timeout-ms must be an integer between 30000 and 3600000");
}
const minNewTokens = Number(arg("--min-new-tokens", "0"));
if (!Number.isSafeInteger(minNewTokens) || minNewTokens < 0 || minNewTokens > 95) {
  throw new Error("--min-new-tokens must be an integer between 0 and 95");
}
const maxNewTokens = Number(arg("--max-new-tokens", "96"));
if (!Number.isSafeInteger(maxNewTokens) || maxNewTokens < 1 || maxNewTokens > 96) {
  throw new Error("--max-new-tokens must be an integer between 1 and 96");
}
if (minNewTokens >= maxNewTokens) {
  throw new Error("--min-new-tokens must be smaller than --max-new-tokens");
}
const debugOutput = process.argv.includes("--debug-output");
const diagnosticFingerprints = process.argv.includes("--diagnostic-fingerprints");
const diagnosticOnly = process.argv.includes("--diagnostic-only");
const decoderStageFingerprints = process.argv.includes("--decoder-stage-fingerprints");
const textOnly = process.argv.includes("--text-only");
const dateDetail = process.argv.includes("--date-detail");
const imageWidth = Number(arg("--image-width", "320"));
const imageHeight = Number(arg("--image-height", "576"));
if (
  !Number.isSafeInteger(imageWidth) || imageWidth < 28 || imageWidth > 2048 ||
  !Number.isSafeInteger(imageHeight) || imageHeight < 28 || imageHeight > 2048
) {
  throw new Error("--image-width and --image-height must be integers between 28 and 2048");
}
const outputPath = resolve(
  arg(
    "--output",
    `output/playwright/emulator-qwen3vl2b-onnx-allgpu-${dtype}-exact-b93fbf.json`,
  )!,
);
const imageBytes = readFileSync(resolve(imagePath));
const imageSha256 = createHash("sha256").update(imageBytes).digest("hex");

const workerSource = String.raw`
import {
  env,
  Qwen2Tokenizer,
  Qwen2VLImageProcessor,
  Qwen3VLForConditionalGeneration,
  Qwen3VLProcessor,
  RawImage,
  Tensor,
} from "${MODULE_URL}";

const MODEL_ID = ${JSON.stringify(MODEL_ID)};
const MODEL_REVISION = ${JSON.stringify(MODEL_REVISION)};
const ORT_ASSET_BASE = ${JSON.stringify(ORT_ASSET_BASE)};
const MODEL_PROXY_BASE = ${JSON.stringify(MODEL_PROXY_BASE)};
const scope = globalThis;

function post(type, data = {}) {
  scope.postMessage({ type, ...data });
}

function disposeTensors(values) {
  const disposed = new Set();
  for (const value of values) {
    if (value instanceof Tensor && !disposed.has(value)) {
      disposed.add(value);
      try { value.dispose(); } catch {}
    }
  }
}

function tensorFingerprint(label, tensor) {
  if (
    !tensor ||
    !Array.isArray(tensor.dims) ||
    !ArrayBuffer.isView(tensor.data)
  ) {
    throw new Error(label + " did not return a readable tensor");
  }
  const data = tensor.data;
  let sum = 0;
  let sumAbs = 0;
  let sumSquares = 0;
  let minimum = Infinity;
  let maximum = -Infinity;
  let nonFinite = 0;
  let zeros = 0;
  for (let index = 0; index < data.length; index += 1) {
    const value = Number(data[index]);
    if (!Number.isFinite(value)) {
      nonFinite += 1;
      continue;
    }
    sum += value;
    sumAbs += Math.abs(value);
    sumSquares += value * value;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    if (value === 0) zeros += 1;
  }
  const sampleIndices = Array.from({ length: 16 }, (_, index) =>
    Math.min(data.length - 1, Math.floor((index * data.length) / 16)),
  );
  let finalRow;
  const rowWidth = Number(tensor.dims.at(-1));
  if (tensor.dims.length === 3 && Number.isSafeInteger(rowWidth) && rowWidth > 0 && rowWidth <= data.length) {
    let rowSum = 0;
    let rowSumAbs = 0;
    let rowSumSquares = 0;
    let rowMinimum = Infinity;
    let rowMaximum = -Infinity;
    let rowNonFinite = 0;
    let rowZeros = 0;
    const rowStart = data.length - rowWidth;
    for (let index = rowStart; index < data.length; index += 1) {
      const value = Number(data[index]);
      if (!Number.isFinite(value)) {
        rowNonFinite += 1;
        continue;
      }
      rowSum += value;
      rowSumAbs += Math.abs(value);
      rowSumSquares += value * value;
      rowMinimum = Math.min(rowMinimum, value);
      rowMaximum = Math.max(rowMaximum, value);
      if (value === 0) rowZeros += 1;
    }
    finalRow = {
      length: rowWidth,
      sum: rowSum,
      sumAbs: rowSumAbs,
      sumSquares: rowSumSquares,
      minimum: rowMinimum,
      maximum: rowMaximum,
      nonFinite: rowNonFinite,
      zeros: rowZeros,
      samples: Array.from({ length: 16 }, (_, index) =>
        Number(data[rowStart + Math.min(rowWidth - 1, Math.floor((index * rowWidth) / 16))]),
      ),
    };
  }
  let finalQuery;
  if (tensor.dims.length === 4) {
    const heads = Number(tensor.dims.at(-3));
    const queries = Number(tensor.dims.at(-2));
    const width = Number(tensor.dims.at(-1));
    if (
      Number.isSafeInteger(heads) && heads > 0 &&
      Number.isSafeInteger(queries) && queries > 0 &&
      Number.isSafeInteger(width) && width > 0 &&
      heads * queries * width <= data.length
    ) {
      let querySum = 0;
      let querySumAbs = 0;
      let querySumSquares = 0;
      let queryMinimum = Infinity;
      let queryMaximum = -Infinity;
      let queryNonFinite = 0;
      let queryZeros = 0;
      const queryLength = heads * width;
      const querySamples = [];
      for (let head = 0; head < heads; head += 1) {
        const queryStart = (head * queries + queries - 1) * width;
        for (let offset = 0; offset < width; offset += 1) {
          const value = Number(data[queryStart + offset]);
          if (!Number.isFinite(value)) {
            queryNonFinite += 1;
            continue;
          }
          querySum += value;
          querySumAbs += Math.abs(value);
          querySumSquares += value * value;
          queryMinimum = Math.min(queryMinimum, value);
          queryMaximum = Math.max(queryMaximum, value);
          if (value === 0) queryZeros += 1;
        }
      }
      for (let sample = 0; sample < 16; sample += 1) {
        const flat = Math.min(queryLength - 1, Math.floor((sample * queryLength) / 16));
        const head = Math.floor(flat / width);
        const offset = flat % width;
        querySamples.push(Number(data[(head * queries + queries - 1) * width + offset]));
      }
      finalQuery = {
        length: queryLength,
        sum: querySum,
        sumAbs: querySumAbs,
        sumSquares: querySumSquares,
        minimum: queryMinimum,
        maximum: queryMaximum,
        nonFinite: queryNonFinite,
        zeros: queryZeros,
        samples: querySamples,
      };
    }
  }
  post("tensor-fingerprint", {
    label,
    dims: tensor.dims,
    tensorType: tensor.type,
    length: data.length,
    sum,
    sumAbs,
    sumSquares,
    minimum,
    maximum,
    nonFinite,
    zeros,
    samples: sampleIndices.map((index) => Number(data[index])),
    finalRow,
    finalQuery,
  });
}

function postTopLogits(tensor) {
  if (!tensor || !ArrayBuffer.isView(tensor.data) || !Array.isArray(tensor.dims)) return;
  const data = tensor.data;
  const rowWidth = Number(tensor.dims.at(-1));
  if (!Number.isSafeInteger(rowWidth) || rowWidth < 1 || rowWidth > data.length) return;
  const rowStart = data.length - rowWidth;
  const top = [];
  for (let token = 0; token < rowWidth; token += 1) {
    const value = Number(data[rowStart + token]);
    if (!Number.isFinite(value)) continue;
    if (top.length < 16 || value > top[top.length - 1].value) {
      top.push({ token, value });
      top.sort((a, b) => b.value - a.value);
      if (top.length > 16) top.pop();
    }
  }
  post("logits-topk", {
    dims: tensor.dims,
    tensorType: tensor.type,
    top,
    tracked: [198, 73594].map((token) => ({ token, value: Number(data[rowStart + token]) })),
  });
}

scope.addEventListener("message", (event) => {
  if (event.data?.type !== "run") return;
  void run(event.data).catch((error) => {
    post("error", {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  });
});

async function run(message) {
  const started = performance.now();
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const adapterFeatures = Array.from(adapter.features);
  post("preflight", {
    adapterFeatures,
    adapterLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
    },
    elapsedMs: Math.round(performance.now() - started),
  });
  if ((message.dtype === "q4f16" || message.visionDtype === "q4f16") && !adapter.features.has("shader-f16")) {
    throw new Error("The WebGPU adapter does not support fp16 (missing shader-f16).");
  }

  const onnx = env.backends.onnx;
  if (!onnx?.wasm || !onnx?.webgpu) throw new Error("Pinned ONNX WebGPU backend unavailable");
  env.useWasmCache = false;
  env.useBrowserCache = true;
  env.cacheKey = "codex-qwen3vl2b-all-webgpu-v4.2.0-" + message.dtype;
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.remoteHost = MODEL_PROXY_BASE;
  env.remotePathTemplate = "{model}/resolve/{revision}/";
  onnx.wasm.wasmPaths = {
    mjs: ORT_ASSET_BASE + "/ort-wasm-simd-threaded.asyncify.mjs",
    wasm: ORT_ASSET_BASE + "/ort-wasm-simd-threaded.asyncify.wasm",
  };
  onnx.wasm.numThreads = 1;
  onnx.wasm.proxy = false;
  onnx.webgpu.powerPreference = "high-performance";
  onnx.webgpu.adapter = adapter;

  const progressState = new Map();
  const progress_callback = (update) => {
    if (!update || typeof update !== "object") return;
    const file = typeof update.file === "string" ? update.file.split("/").at(-1) : undefined;
    const raw = typeof update.progress === "number" && Number.isFinite(update.progress)
      ? update.progress
      : undefined;
    // Transformers.js reports file progress as a percentage in the 0..100 range.
    const progress = raw === undefined ? undefined : Math.max(0, Math.min(1, raw / 100));
    const bucket = progress === undefined ? -1 : Math.floor(progress * 10);
    const key = String(update.status) + ":" + String(file);
    if (progressState.get(key) === bucket) return;
    progressState.set(key, bucket);
    post("progress", {
      status: typeof update.status === "string" ? update.status : "loading",
      file,
      progress,
      elapsedMs: Math.round(performance.now() - started),
    });
  };

  let model;
  let outputs;
  let completion;
  let inputs;
  let resultText = "";
  try {
    post("phase", { phase: "processor-load", elapsedMs: Math.round(performance.now() - started) });
    // Transformers.js 4.2's tokenizer metadata probe does not forward the configured model proxy,
    // so its generic from_pretrained path sees no tokenizer files in this same-origin mobile setup.
    // Build the official Qwen processor components from the same pinned revision instead.
    const modelBase = MODEL_PROXY_BASE + MODEL_ID + "/resolve/" + MODEL_REVISION + "/";
    const getJson = async (name) => {
      const response = await fetch(modelBase + name);
      if (!response.ok) throw new Error("Failed to load " + name + " (HTTP " + response.status + ")");
      return response.json();
    };
    const getText = async (name) => {
      const response = await fetch(modelBase + name);
      if (!response.ok) throw new Error("Failed to load " + name + " (HTTP " + response.status + ")");
      return response.text();
    };
    const [tokenizerJson, tokenizerConfig, preprocessorConfig, chatTemplate] = await Promise.all([
      getJson("tokenizer.json"),
      getJson("tokenizer_config.json"),
      getJson("preprocessor_config.json"),
      getText("chat_template.jinja"),
    ]);
    const tokenizer = new Qwen2Tokenizer(tokenizerJson, tokenizerConfig);
    const imageProcessor = new Qwen2VLImageProcessor(preprocessorConfig);
    const processor = new Qwen3VLProcessor(
      {},
      { image_processor: imageProcessor, tokenizer },
      chatTemplate,
    );
    post("phase", { phase: "model-load", elapsedMs: Math.round(performance.now() - started) });
    const sessionMap = {
      embed_tokens: "webgpu",
      vision_encoder: "webgpu",
      decoder_model_merged: "webgpu",
    };
    const dtypeMap = {
      embed_tokens: message.dtype,
      vision_encoder: message.visionDtype,
      decoder_model_merged: message.dtype,
    };
    model = await Qwen3VLForConditionalGeneration.from_pretrained(MODEL_ID, {
      revision: MODEL_REVISION,
      device: sessionMap,
      dtype: dtypeMap,
      progress_callback,
    });
    post("loaded", {
      requestedSessions: sessionMap,
      requestedDtypes: dtypeMap,
      sessionKeys: Object.keys(model.sessions ?? {}).sort(),
      elapsedMs: Math.round(performance.now() - started),
    });

    if (message.decoderStageFingerprints) {
      const decoderSession = model.sessions?.decoder_model_merged;
      if (!decoderSession || typeof decoderSession.run !== "function") {
        throw new Error("Decoder session is unavailable for stage diagnostics");
      }
      const originalRun = decoderSession.run.bind(decoderSession);
      let capturedPrefill = false;
      decoderSession.run = async (...args) => {
        const result = await originalRun(...args);
        if (!capturedPrefill) {
          capturedPrefill = true;
          if (result.logits) {
            tensorFingerprint("__codex_debug/logits", result.logits);
            postTopLogits(result.logits);
          }
          for (const [name, value] of Object.entries(result)) {
            if (!name.startsWith("__codex_debug/")) continue;
            tensorFingerprint(name, value);
            try { value.dispose(); } catch {}
            delete result[name];
          }
        }
        return result;
      };
    }

    let images;
    if (!message.textOnly) {
      const rawImage = await RawImage.read(new Blob([message.image]));
      const fullImage = await rawImage.resize(message.imageWidth, message.imageHeight);
      images = [fullImage];
      if (message.dateDetail) {
        const detail = await rawImage.crop([
          Math.round(rawImage.width * 0.04),
          Math.round(rawImage.height * 0.745),
          Math.round(rawImage.width * 0.62),
          Math.round(rawImage.height * 0.83),
        ]);
        const detailImage = await detail.resize(640, 160);
        const compositeWidth = 640;
        const compositeHeight = message.imageHeight + 160;
        const canvas = new OffscreenCanvas(compositeWidth, compositeHeight);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("2D canvas unavailable for model image composition");
        context.fillStyle = "white";
        context.fillRect(0, 0, compositeWidth, compositeHeight);
        context.drawImage(
          fullImage.toCanvas(),
          Math.floor((compositeWidth - message.imageWidth) / 2),
          0,
        );
        context.drawImage(detailImage.toCanvas(), 0, message.imageHeight);
        images = [RawImage.fromCanvas(canvas)];
      }
    }
    const conversation = [{
      role: "user",
      content: message.textOnly
        ? [{ type: "text", text: message.prompt }]
        : [
            ...images.map(() => ({ type: "image" })),
            { type: "text", text: message.prompt },
          ],
    }];
    const formatted = processor.apply_chat_template(conversation, {
      add_generation_prompt: true,
      tokenize: false,
      enable_thinking: false,
    });
    if (typeof formatted !== "string") throw new Error("Processor returned no prompt text");
    inputs = message.textOnly ? await processor(formatted) : await processor(formatted, images);
    const inputIds = inputs.input_ids;
    if (!(inputIds instanceof Tensor)) throw new Error("Processor returned no input IDs");
    if (message.diagnosticFingerprints) {
      let textFeatures;
      let imageFeatures;
      let syntheticPixels;
      let syntheticFeatures;
      try {
        tensorFingerprint("pixel-values", inputs.pixel_values);
        textFeatures = await model.encode_text({ input_ids: inputIds });
        tensorFingerprint("text-embeddings", textFeatures);
        imageFeatures = await model.encode_image({
          pixel_values: inputs.pixel_values,
          image_grid_thw: inputs.image_grid_thw,
        });
        tensorFingerprint("vision-embeddings", imageFeatures);
        const syntheticData = new Float32Array(inputs.pixel_values.data.length);
        for (let index = 0; index < syntheticData.length; index += 1) {
          syntheticData[index] = ((index * 17) % 257) / 256;
        }
        syntheticPixels = new Tensor("float32", syntheticData, inputs.pixel_values.dims);
        syntheticFeatures = await model.encode_image({
          pixel_values: syntheticPixels,
          image_grid_thw: inputs.image_grid_thw,
        });
        tensorFingerprint("synthetic-vision-embeddings", syntheticFeatures);
      } finally {
        try { textFeatures?.dispose(); } catch {}
        try { imageFeatures?.dispose(); } catch {}
        try { syntheticPixels?.dispose(); } catch {}
        try { syntheticFeatures?.dispose(); } catch {}
      }
    }
    if (message.diagnosticOnly) {
      post("diagnostic-complete", { elapsedMs: Math.round(performance.now() - started) });
    } else {
      post("phase", {
        phase: "inference",
        inputTokens: inputIds.dims.at(-1),
        elapsedMs: Math.round(performance.now() - started),
      });
      outputs = await model.generate({
        ...inputs,
        max_new_tokens: message.maxNewTokens,
        min_new_tokens: message.minNewTokens,
        do_sample: false,
      });
      if (!(outputs instanceof Tensor)) throw new Error("Model returned no generated token tensor");
      const inputLength = inputIds.dims.at(-1);
      completion = outputs.slice(null, [inputLength, outputs.dims[1]]);
      const generatedTokenCount = outputs.dims[1] - inputLength;
      post("generation", {
        generatedTokenCount,
        firstGeneratedToken: generatedTokenCount > 0 ? Number(outputs.data[inputLength]) : undefined,
        elapsedMs: Math.round(performance.now() - started),
      });
      resultText = processor.batch_decode(completion, { skip_special_tokens: true })[0]?.trim() ?? "";
    }
  } finally {
    try { completion?.dispose(); } catch {}
    try { outputs?.dispose(); } catch {}
    if (inputs) disposeTensors(Object.values(inputs));
    if (model) await model.dispose().catch(() => undefined);
    post("disposed", { elapsedMs: Math.round(performance.now() - started) });
  }
  post("result", { text: resultText, elapsedMs: Math.round(performance.now() - started) });
}
`;

const prompt =
  (dateDetail
    ? "The image is a composite: the complete receipt is centered at the top and a magnified crop of its date row is at the bottom. Use the bottom crop to read the exact date digits. "
    : "") +
  'Read only the visible transaction receipt. Return exactly one JSON object and no prose: ' +
  '{"amount":number,"currency":string,"transactionKind":"settlement","direction":"credit","date":"YYYY-MM-DD"}. ' +
  "Do not infer or invent any missing value.";

const browser = await chromium.connectOverCDP(cdp, { timeout: 120_000 });
const context = browser.contexts()[0];
if (context === undefined) throw new Error("No Android Chrome context is available.");
const page = await context.newPage();
const events: Array<Record<string, unknown>> = [];
const network = { modelRequests: 0, ocrRequests: 0 };
const startedAt = Date.now();
let outputText = "";
let terminalError: { name: string; message: string; stack?: string } | undefined;
let timedOut = false;

page.on("console", (message) => {
  const text = message.text();
  const prefix = "__CODEX_QWEN_EVENT__";
  if (!text.startsWith(prefix)) return;
  try {
    const event = JSON.parse(text.slice(prefix.length)) as Record<string, unknown>;
    events.push(event);
    const type = typeof event.type === "string" ? event.type : "event";
    const file = typeof event.file === "string" ? ` ${event.file}` : "";
    const progress =
      typeof event.progress === "number" ? ` ${Math.round(event.progress * 100)}%` : "";
    process.stdout.write(`[${type}]${file}${progress}\n`);
  } catch {
    // Ignore unrelated or malformed browser console output.
  }
});

page.on("request", (request) => {
  const url = request.url();
  if (url.includes("/hf-model/")) network.modelRequests++;
  if (/tesseract|traineddata|ocr/i.test(url)) network.ocrRequests++;
});

try {
  await page.route(`${origin}/__codex_qwen3vl_allgpu__`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><meta charset=utf-8><title>Qwen3-VL all-WebGPU test</title>",
    });
  });
  await page.route(`${origin}/__codex_qwen3vl_allgpu_worker__.js`, async (route) => {
    await route.fulfill({ status: 200, contentType: "text/javascript", body: workerSource });
  });
  await page.goto(`${origin}/__codex_qwen3vl_allgpu__`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  // Android Chrome may create CDP tabs in the background. Keep this GPU-heavy acceptance
  // target foregrounded so lifecycle throttling cannot invalidate its WebGPU worker/device.
  await page.bringToFront();
  const wakeLockActive = await page.evaluate(async () => {
    const navigatorWithWakeLock = navigator as Navigator & {
      wakeLock?: { request(type: "screen"): Promise<unknown> };
    };
    if (navigatorWithWakeLock.wakeLock === undefined) return false;
    const wakeLock = await navigatorWithWakeLock.wakeLock.request("screen");
    (globalThis as unknown as Record<string, unknown>).__codexWakeLock = wakeLock;
    return true;
  });
  events.push({ type: "wake-lock", active: wakeLockActive, elapsedMs: Date.now() - startedAt });

  const outcome = await page.evaluate(
    ({ workerUrl, dtype, visionDtype, image, prompt, timeoutMs, minNewTokens, maxNewTokens, imageWidth, imageHeight, dateDetail, diagnosticFingerprints, diagnosticOnly, decoderStageFingerprints, textOnly }) =>
      new Promise<{
        text?: string;
        error?: { name: string; message: string; stack?: string };
        timedOut?: boolean;
      }>(
        (resolveOutcome) => {
          const worker = new Worker(workerUrl, { type: "module", name: "codex-qwen3vl-all-webgpu" });
          const timeout = window.setTimeout(() => {
            worker.terminate();
            resolveOutcome({ timedOut: true });
          }, timeoutMs);
          worker.addEventListener("message", (event) => {
            const data = event.data as Record<string, unknown>;
              const safe = { ...data };
              delete safe.text;
              delete safe.stack;
            console.info(`__CODEX_QWEN_EVENT__${JSON.stringify(safe)}`);
            if (data.type === "result") {
              window.clearTimeout(timeout);
              const text = typeof data.text === "string" ? data.text : "";
              worker.terminate();
              resolveOutcome({ text });
            } else if (data.type === "error") {
              window.clearTimeout(timeout);
              worker.terminate();
              resolveOutcome({
                error: {
                  name: typeof data.name === "string" ? data.name : "Error",
                  message: typeof data.message === "string" ? data.message : "Unknown worker error",
                  stack: typeof data.stack === "string" ? data.stack : undefined,
                },
              });
            }
          });
          worker.addEventListener("error", (event) => {
            window.clearTimeout(timeout);
            worker.terminate();
            resolveOutcome({ error: { name: "WorkerError", message: event.message } });
          });
          const bytes = Uint8Array.from(image).buffer;
          worker.postMessage({
            type: "run",
            dtype,
            visionDtype,
            image: bytes,
            prompt,
            minNewTokens,
            maxNewTokens,
            imageWidth,
            imageHeight,
            dateDetail,
            diagnosticFingerprints,
            diagnosticOnly,
            decoderStageFingerprints,
            textOnly,
          }, [bytes]);
        },
      ),
    {
      workerUrl: `${origin}/__codex_qwen3vl_allgpu_worker__.js`,
      dtype,
      visionDtype,
      image: Array.from(imageBytes),
      prompt,
      timeoutMs,
      minNewTokens,
      maxNewTokens,
      imageWidth,
      imageHeight,
      dateDetail,
      diagnosticFingerprints,
      diagnosticOnly,
      decoderStageFingerprints,
      textOnly,
    },
  );
  outputText = outcome.text ?? "";
  terminalError = outcome.error;
  timedOut = outcome.timedOut === true;
} finally {
  await page.close();
  await browser.close();
}

// Console events are deliberately collected after worker output has been stripped from them.
// Playwright receives them synchronously while page.evaluate is running.
function extractBalancedJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try {
        const parsed = JSON.parse(text.slice(start, index + 1));
        return typeof parsed === "object" && parsed !== null ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const parsed = extractBalancedJson(outputText);
const observed =
  parsed === undefined
    ? undefined
    : {
        amount: parsed.amount,
        currency: parsed.currency,
        transactionKind: parsed.transactionKind,
        direction: parsed.direction,
        date: parsed.date,
      };
const expected = {
  amount: 12_900,
  currency: "EGP",
  transactionKind: "settlement",
  direction: "credit",
  date: "2026-08-14",
};
const exact = observed !== undefined && JSON.stringify(observed) === JSON.stringify(expected);
const preflight = events.find((event) => event.type === "preflight");
const loaded = events.find((event) => event.type === "loaded");

const report = {
  format: "iou-qwen3vl2b-transformersjs-all-webgpu-v1",
  productionSourceModified: false,
  directImageModelOnly: true,
  ocrEnabled: false,
  model: {
    id: MODEL_ID,
    revision: MODEL_REVISION,
    dtypes: {
      embed_tokens: dtype,
      vision_encoder: visionDtype,
      decoder_model_merged: dtype,
    },
    generation: { maxNewTokens, minNewTokens, doSample: false },
    diagnosticFingerprints,
    diagnosticOnly,
    decoderStageFingerprints,
    textOnly,
    artifactBytes: visionDtype === dtype ? MODEL_BYTES[dtype] : undefined,
  },
  requestedDeviceMap: {
    embed_tokens: "webgpu",
    vision_encoder: "webgpu",
    decoder_model_merged: "webgpu",
  },
  input: {
    sha256: imageSha256,
    bytes: imageBytes.byteLength,
    resized: [imageWidth, imageHeight],
    dateDetail,
    dateDetailCropRatios: dateDetail ? [0.04, 0.745, 0.62, 0.83] : undefined,
    dateDetailResized: dateDetail ? [640, 160] : undefined,
    compositeResized: dateDetail ? [640, imageHeight + 160] : undefined,
  },
  expected,
  observed,
  exact,
  output: {
    chars: outputText.length,
    sha256: outputText === "" ? undefined : createHash("sha256").update(outputText).digest("hex"),
  },
  runtime: {
    preflight,
    loaded,
    terminalError,
    timedOut,
    elapsedMs: Date.now() - startedAt,
  },
  network,
  events,
};

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (debugOutput) {
  process.stdout.write(`[debug-output]\n${outputText}\n[/debug-output]\n`);
}
process.stdout.write(
  `${JSON.stringify({ outputPath, dtype, visionDtype, exact, terminalError, timedOut, events, network }, null, 2)}\n`,
);
process.exitCode = exact ? 0 : 1;
