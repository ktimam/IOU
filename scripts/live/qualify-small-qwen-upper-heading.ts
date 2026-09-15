// IOU-only v21 candidate or explicit unchanged-v20 baseline. Never registers or downloads.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, realpathSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { freemem } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
const IOU = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const importFile = (file: string) => import(pathToFileURL(file).href);
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (file: string, value: any) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const bindings = new Map<string, any>();
async function bind(path: string, expected?: any) {
  const sha = createHash('sha256');
  for await (const bytes of createReadStream(path)) sha.update(bytes);
  const value = { path, bytes: statSync(path).size, sha256: sha.digest('hex') };
  if (expected?.bytes !== undefined) assert.equal(value.bytes, expected.bytes, path);
  if (expected?.sha256 !== undefined) assert.equal(value.sha256, expected.sha256, path);
  if (bindings.has(path)) assert.deepEqual(value, bindings.get(path), 'Previously bound input changed: ' + path);
  else bindings.set(path, Object.freeze(value));
  return value;
}
async function verifyBindings(paths = [...bindings.keys()]) {
  for (const path of paths) { assert(bindings.has(path), 'Unbound input: ' + path); await bind(path, bindings.get(path)); }
}
// Only Node built-ins precede this bootstrap. The helper is measured before its dynamic
// import, and immediately afterward; this entry file records its own observed bytes.
await bind(fileURLToPath(import.meta.url));
const contractPath = IOU + '/scripts/live/qwenSmallQualificationContract.ts';
await bind(contractPath);
const { assertQualificationBytes, assertSmallQwenModel, boundedQualificationCleanup, buildSmallQwenCases,
  importQualificationSources, parseSmallQwenQualificationArgs, QUALIFICATION_PINS, SMALL_QWEN_ID,
  smallQwenQualificationPassed, smallQwenQualificationProfile, smallQwenSequence,
  stageSmallQwenQualification, withQualificationDeadline } = await importFile(contractPath);
await verifyBindings();
const options = parseSmallQwenQualificationArgs(process.argv.slice(2));
const qualification = smallQwenQualificationProfile(options.candidateId);
const ROOT = realpathSync(options.evidenceRoot);
const REPO = realpathSync(options.hostRoot);
const APP = REPO + '/frontend/app';
const ID = SMALL_QWEN_ID;
for (const repository of [IOU, REPO]) {
  const rel = relative(realpathSync(repository), ROOT);
  assert(isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep), 'Evidence root must be outside both source repositories');
}
const mode = options.mode;
function differences(actual: any, expected: any) {
  return Object.fromEntries(Object.entries(expected).filter(([key, value]) => actual[key] !== value)
    .map(([key, value]) => [key, { expected: value, actual: actual[key] ?? null }]));
}
assert.deepEqual(differences({ amount: '12900', date: '' }, { amount: '12900', date: '2026-08-14' }),
  { date: { expected: '2026-08-14', actual: '' } });
assert.equal(Object.keys(differences({ amount: '129000' }, { amount: '12900' })).length, 1);
assert.deepEqual(differences({ amount: '12900' }, { amount: '12900' }), {});

async function prepare() {
  assert(freemem() >= 8 * 1024 ** 3, 'Need 8 GiB free RAM; no memory allocation or model download attempted');
  const hostPath = REPO + '/frontend/openchat-shared/src/domain/aiAction.ts';
  const executionSources = [
    IOU + '/docs/openchat-registration.json', hostPath, APP + '/src/utils/aiActionRunner.ts', APP + '/public/model-catalog.json',
    ...['actionManifest.ts', 'registerAiApp.ts', 'modelImageProfiles.ts', 'modelImageProfiles.json',
      'localProcessorBridge.ts', 'rawImageEvidence.ts', 'rawImageTotalRow.ts', 'localExtraction.ts',
      'sourceInterval.ts', 'cardBridge.ts', 'currencyEvidencePolicy.ts', 'templateRef.ts',
      'localExtractionConfig.ts', 'imageCurrency.ts', 'imageHeading.ts', 'localExtractionSemantics.ts',
      'sourceGroundedActionParser.ts'].map(x => IOU + '/src/features/openchat/' + x),
    IOU + '/src/config/devLanQcRuntime.ts', IOU + '/src/config/devLanQc.ts', IOU + '/src/features/settings/currencies.ts',
    APP + '/src/utils/webGpuModelCatalog.ts', APP + '/src/utils/transformersWebGpuArtifactTransform.ts',
    ...['DecoderGraph', 'DeepStackGraph', 'QwenGenerationGraph', 'QwenVisionGraph', 'MropeGraph', 'QwenVisionGeometry']
      .map(x => APP + '/transformersWebGpu' + x + '.mjs'),
    IOU + '/package.json', IOU + '/pnpm-lock.yaml', REPO + '/frontend/package.json', REPO + '/frontend/package-lock.json',
    REPO + '/frontend/node_modules/onnxruntime-web/lib/onnxjs/ort-schema/protobuf/onnx.js',
  ];
  const { host, manifest, registration, processor, cards, profiles, catalog, transforms, decoder, deep, generation, vision } =
    await importQualificationSources(executionSources, bind, verifyBindings, async () => {
  const host = await importFile(hostPath);
  const manifest = await importFile(IOU + '/src/features/openchat/actionManifest.ts');
  const registration = await importFile(IOU + '/src/features/openchat/registerAiApp.ts');
  const processor = await importFile(IOU + '/src/features/openchat/localProcessorBridge.ts');
  const cards = await importFile(IOU + '/src/features/openchat/cardBridge.ts');
  const profiles = await importFile(IOU + '/src/features/openchat/modelImageProfiles.ts');
  const catalog = await importFile(APP + '/src/utils/webGpuModelCatalog.ts');
  const transforms = await importFile(APP + '/src/utils/transformersWebGpuArtifactTransform.ts');
  const decoder = await importFile(APP + '/transformersWebGpuDecoderGraph.mjs');
  const deep = await importFile(APP + '/transformersWebGpuDeepStackGraph.mjs');
  const generation = await importFile(APP + '/transformersWebGpuQwenGenerationGraph.mjs');
  const vision = await importFile(APP + '/transformersWebGpuQwenVisionGraph.mjs');
  return { host, manifest, registration, processor, cards, profiles, catalog, transforms, decoder, deep, generation, vision };
  });
  const spec = catalog.parseWebGpuModelCatalog(JSON.parse(readFileSync(APP + '/public/model-catalog.json', 'utf8'))).models.find((x: any) => x.id === ID);
  const originalPlanPath = ROOT + '/output/playwright/qwen-q4-current-6gRiIm/plan.json';
  await bind(originalPlanPath, { sha256: QUALIFICATION_PINS.originalPlan });
  const originalPlan = JSON.parse(readFileSync(originalPlanPath, 'utf8'));
  assertSmallQwenModel(spec, originalPlan.model);
  assert.deepEqual(profiles.iouImageProcessorOptions, { rawImageMoneyFormat: 'total-row' });
  const wire = registration.buildManifestWire('').actions[0];
  const rules = wire.rules.map((rule: any) => {
    const [kind, raw]: any = Object.entries(rule)[0], value = structuredClone(raw);
    if (kind === 'keyword_map') value.mode = Object.keys(value.mode)[0];
    else if (kind === 'normalize') value.ops = value.ops.map((op: any) => Object.keys(op)[0]);
    else if (kind === 'context') value.provide = value.provide.map((op: any) => Object.keys(op)[0]);
    else if (kind === 'from_message') value.max_length = value.max_length[0];
    else assert.equal(kind, 'instruction');
    return { [kind]: value };
  });
  const registeredDefinition = host.aiActionDefinitionFromWire({ ...wire, rules,
    card: { ...wire.card, disclosure: wire.card.disclosure[0] },
    consumer_public_key: wire.consumer_public_key[0],
    recipient_scope: wire.recipient_scope.length ? Object.keys(wire.recipient_scope[0])[0] : undefined });
  const activePromptPath = IOU + '/docs/model-prompts/qwen3-vl-2b-total-row-image.txt';
  const promptPath = IOU + '/docs/model-prompts/' + qualification.promptFile;
  await bind(activePromptPath, { sha256: QUALIFICATION_PINS.activePrompt });
  await bind(promptPath, { sha256: qualification.promptSha256 });
  const selected = host.imagePromptTemplateForModel(registeredDefinition.responseSchema, ID);
  assert.deepEqual(selected, profiles.iouImagePromptByModel.templates[ID]);
  const definition = stageSmallQwenQualification(registeredDefinition, selected,
    readFileSync(promptPath, 'utf8'), readFileSync(activePromptPath, 'utf8'), options.candidateId);
  const candidate = host.imagePromptTemplateForModel(definition.responseSchema, ID);
  assertQualificationBytes(candidate.template, qualification.promptSha256);
  const policyPath = ROOT + '/admin/new-model-prompts-20260910/qwen-image-v20.policy.json';
  await bind(policyPath, { sha256: QUALIFICATION_PINS.policy });
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  const fixturePath = IOU + '/test/fixtures/openchat/model-acceptance/qwen-q4-v20-app-replay.json';
  await bind(fixturePath, { sha256: QUALIFICATION_PINS.fixture });
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const cases = buildSmallQwenCases(policy, fixture);
  for (const row of cases) await bind(row.image.path, row.image);
  // A Cache.match metadata probe must not eagerly open a weight-file HTTP body.
  // Import the standalone, tiny-tested transport; do not depend on mixed-model tooling.
  const transportPath = ROOT + '/admin/new-model-prompts-20260910/catalog-cache-fixture-v2.mjs';
  await bind(transportPath, { sha256: '3febd697be7a1f5ff72145f14ab7e25dbaaa7a42b9593d5390f86035a271f77d' });
  const transport = await importQualificationSources([transportPath], bind, verifyBindings, () => importFile(transportPath));
  const observerPath = ROOT + '/admin/qwen-integrated-worker-observer-20260910.mjs';
  await bind(observerPath, { sha256: 'd2c28169425f75f3aa3424be1b9e63915b538329de3d7402fb72393c87869158' });
  const observer = await importQualificationSources([observerPath], bind, verifyBindings, () => importFile(observerPath));
  const graphs = new Map<string, Buffer>();
  graphs.set('onnx/decoder_model_merged_q4.onnx', Buffer.from(generation.patchQwen3Vl2bGenerationGraph(
    deep.patchQwen3Vl2bDeepStackDecoderGraph(decoder.patchQwen3Vl2bDecoderGraph(
      readFileSync(APP + '/model-overrides/qwen3vl2b/onnx/decoder_model_merged_q4.onnx'))), { scope: 'generation-only' })));
  graphs.set('onnx/vision_encoder_q4.onnx', Buffer.from(vision.patchQwen3Vl2bVisionGeometryGraph(
    deep.patchQwen3Vl2bDeepStackVisionGraph(readFileSync(APP + '/model-overrides/qwen3vl2b/onnx/vision_encoder_q4.onnx')))));
  const files = new Map<string, string>(); let derived: any;
  for (const artifact of spec.artifacts) {
    if (graphs.has(artifact.path)) {
      assert.equal(hash(graphs.get(artifact.path)!), artifact.sha256);
      assert.equal(graphs.get(artifact.path)!.length, artifact.bytes);
    } else if (artifact.source) {
      derived = { artifact, path: ROOT + '/output/qwen-deepstack-bf16-fixed-20260909-QkCaBK/deepstack-bf16.bin' };
      await bind(derived.path, artifact.source);
    } else {
      const path = ROOT + '/model-cache/qwen3vl2b-' + spec.revision + '/' + artifact.path;
      await bind(path, artifact); files.set(artifact.path, path);
    }
  }
  const workerPath = realpathSync(options.workerPath);
  await bind(workerPath, { sha256: QUALIFICATION_PINS.worker });
  const worker = readFileSync(workerPath, 'utf8'); assert(worker.length > 500000);
  const runtime = new Map<string, string>();
  const prefix = '/assets/transformers-webgpu/ort-1.29.0-dev.20260723-1b1e1db7bc/';
  for (const [name, sha256] of [
    ['ort-wasm-simd-threaded.jspi.mjs', '630c7cbb6eedffdd465f815d14051918ad4c9c6c7cc221190ca2fbe560b289eb'],
    ['ort-wasm-simd-threaded.jspi.wasm', 'a4aebeebccc554f21641e348b76135a2b7a06151765fa71fd40a38bbb249962e']]) {
    const file = REPO + '/frontend/node_modules/onnxruntime-web/dist/' + name;
    await bind(file, { sha256 }); runtime.set(prefix + name, file);
  }
  const support = 'globalThis.__name ??= (target, value) => Object.defineProperty(target, "name", {value, configurable:true});' +
    '(' + observer.installObservation.toString() + ')();(' + transport.cacheFixture.toString() + ')(' + JSON.stringify(spec) + ');';
  async function appRun(row: any, infer: any) {
    const sourceTimestamp = Date.parse(row.sourceTimestamp), image = new Uint8Array(readFileSync(row.image.path));
    const binding = { frameNonce: 'a'.repeat(48), requestNonce: 'b'.repeat(48) };
    let rawNormalized = false;
    const ready = await host.runAiAction(definition, { image, modelId: ID, sourceTimestamp }, 'offline-no-recipient', infer,
      undefined, undefined, undefined, undefined, {
        normalize: (candidates: any[]) => { rawNormalized = true; return processor.processIouRequest({ type: 'oc:app-process:request', version: 1,
          ...binding, actionId: manifest.iouActionManifest.id,
          input: { operation: 'normalize_raw', modality: 'image', sourceTimestamp, candidates } }, binding, profiles.iouImageProcessorOptions); },
      });
    // Mirror the browser orchestrator's canonical-output normalizeWithApp branch. The raw-output
    // branch above already normalizes before card construction and must never run this twice.
    if (rawNormalized || ready.kind !== 'ready') return ready;
    const normalized = processor.processIouRequest({ type: 'oc:app-process:request', version: 1,
      ...binding, actionId: manifest.iouActionManifest.id,
      input: { operation: 'normalize', modality: 'image', sourceTimestamp, candidates: [ready.extracted] } },
      binding, profiles.iouImageProcessorOptions);
    if (normalized.kind !== 'candidates') return { kind: 'no_extraction', raw: '' };
    assert.equal(normalized.candidates.length, 1);
    // The single-candidate path of current buildManualCard, using the actual shared functions.
    const extracted = host.postProcessAiActionCandidate(definition, normalized.candidates[0],
      { hasImage: true, rulesAlreadyResolved: true });
    const missingFields = host.missingRequired(extracted, definition.responseSchema);
    if (missingFields.length) return { kind: 'incomplete_extraction', missingFields };
    return { kind: 'ready', extracted, card: host.buildActionCardContent(definition, extracted, 'offline-no-recipient') };
  }
  for (const row of cases) {
    let requests = 0;
    await appRun(row, async (request: any) => { requests++; row.prompt = request.prompt; return { kind: 'error', error: 'Read-only prompt planning' }; });
    assert.equal(requests, 1); assert(row.prompt); row.promptSha256 = hash(row.prompt);
    assert.equal(row.promptSha256, qualification.promptSha256);
  }
  return { spec, cases, graphs, files, derived, worker, support, observer, transforms, runtime, appRun, cards };
}

const p = await prepare();
await verifyBindings();
const plan = { model: p.spec, workerSha256: hash(p.worker), supportSha256: hash(p.support),
  cases: p.cases, sourceBindings: [...bindings.values()], maximumRequests: 10, maxTokens: 96,
  candidateId: qualification.candidateId, promptMode: qualification.promptMode,
  promptFile: qualification.promptFile, promptSha256: qualification.promptSha256,
  activePromptSha256: QUALIFICATION_PINS.activePrompt, candidatePromptSha256: qualification.promptSha256,
  productionProfileChanged: false, modelDownloads: false,
  modelFilesWritten: false, accountOrDeliveryOperations: false, cpuFallback: false,
  cacheQualification: false, transportVersion: 2,
  transport: 'read-only verified files through isolated lazy loopback fixture; unused metadata responses open no HTTP body',
  phoneQualification: false, privateTypeOrDirectionQualification: false,
  sourceBindingScope: 'Reviewed first-party import closure and explicit inputs; entry-file bytes observed after bootstrap',
  wholeThirdPartyRuntimeSourceCoverage: false,
  nodeCaseDeadlineMs: 195000, cleanupDeadlineMs: 10000 };
console.log(JSON.stringify({ phase: 'prepared', candidateId: qualification.candidateId, model: p.spec.id, bytes: p.spec.artifactBytes,
  workerSha256: plan.workerSha256, cases: p.cases.length, planSha256: hash(JSON.stringify(plan)) }));
if (mode === '--plan') {
  const output = mkdtempSync(ROOT + '/output/playwright/' + qualification.outputPrefix + '-plan-');
  await verifyBindings();
  json(output + '/plan.json', { ...plan, modelInferencePerformed: false, sourceUnchanged: true,
    candidateSelectedOrRegistered: false, qualificationPassed: false });
  console.log(JSON.stringify({ phase: 'offline-plan', candidateId: qualification.candidateId, output, modelInferencePerformed: false,
    planSha256: hash(readFileSync(output + '/plan.json')) }));
}
if (mode === '--run') {
const output = mkdtempSync(ROOT + '/output/playwright/' + qualification.outputPrefix + '-'); json(output + '/plan.json', plan);
const report: any = { modelId: ID, candidateId: qualification.candidateId, promptFile: qualification.promptFile,
  promptSha256: qualification.promptSha256, promptMode: qualification.promptMode,
  output, planSha256: hash(JSON.stringify(plan)), cases: [], errors: [], cleanup: {}, passed: false };
let browser: any, browserServer: any, listening = false;
const server = createServer(async (req, res) => {
  const requestPath = new URL(req.url!, 'http://127.0.0.1').pathname;
  try {
    assert.equal(req.method, 'GET'); const path = new URL(req.url!, 'http://127.0.0.1').pathname;
    for (const [key, value] of Object.entries({ 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' })) res.setHeader(key, value);
    if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Qwen Q4 current checks</title><link rel="icon" href="data:,"><p>Local model-only test; nothing will be saved to IOU.</p>'); }
    else if (path === '/worker.mjs') { res.setHeader('Content-Type', 'text/javascript'); res.end('import "/support.mjs";\n' + p.worker); }
    else if (path === '/support.mjs') { res.setHeader('Content-Type', 'text/javascript'); res.end(p.support); }
    else if (p.runtime.has(path)) { const file = p.runtime.get(path)!; res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); await pipeline(createReadStream(file), res); }
    else if (path.startsWith('/image/')) { const row = p.cases.find((x: any) => x.id === path.slice(7)); assert(row); await pipeline(createReadStream(row.image.path), res); }
    else if (path.startsWith('/fixture/')) {
      const name = decodeURIComponent(path.slice(9)), artifact = p.spec.artifacts.find((a: any) => a.path === name); assert(artifact);
      res.setHeader('content-length', artifact.bytes); res.setHeader('x-content-sha256', artifact.sha256); res.setHeader('x-openchat-model-revision', p.spec.revision);
      if (p.graphs.has(name)) res.end(p.graphs.get(name));
      else if (p.files.has(name)) await pipeline(createReadStream(p.files.get(name)!), res);
      else {
        assert.equal(name, p.derived.artifact.path); const source = artifact.source;
        const response = new Response(Readable.toWeb(createReadStream(p.derived.path)) as any, { status: 206, headers: {
          'content-length': String(source.bytes), 'content-range': `bytes ${source.range.start}-${source.range.end}/${source.range.totalBytes}` } });
        const expanded = await p.transforms.transformTransformersWebGpuArtifactResponse(response, artifact);
        await pipeline(Readable.fromWeb(expanded.body), res);
      }
    } else throw Error('Unlisted route ' + path);
  } catch (error) {
    // Preserve transport failures, with enough detail to distinguish canceled metadata reads later.
    (report.transportEvents ??= []).push({ path: requestPath, error: String(error),
      requestAborted: req.aborted, responseFinished: res.writableFinished, responseDestroyed: res.destroyed });
    report.errors.push(String(error)); res.destroy();
  }
});
try {
  await withQualificationDeadline('Loopback server startup', 5000,
    () => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }));
  listening = true;
  const origin = 'http://127.0.0.1:' + (server.address() as any).port;
  const require = createRequire(IOU + '/package.json');
  const { chromium } = require('@playwright/test');
  // Retain the exact process-owning public handle: a hanging renderer cannot prevent a
  // bounded graceful close followed by best-effort termination of only this browser.
  browserServer = await chromium.launchServer({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
    host: '127.0.0.1', timeout: 30000,
    env: { ...process.env, TEMP: ROOT + '/tmp', TMP: ROOT + '/tmp' }, args: ['--disable-background-networking', '--disable-component-update'] });
  report.browserProcessId = browserServer.process().pid;
  const page = await withQualificationDeadline('Browser setup and adapter', 30000, async (signal: AbortSignal) => {
  browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 15000 });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  // tsx preserves names using this helper in functions serialized by Playwright. Test transport only.
  await context.addInitScript('globalThis.__name ??= (target, value) => Object.defineProperty(target, "name", {value, configurable:true});');
  await context.route('**/*', (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : (report.errors.push('Outbound request refused'), route.abort()));
  const page = await context.newPage();
  page.on('pageerror', (error: any) => report.errors.push(String(error)));
  page.on('console', (message: any) => {
    if (['warning', 'error'].includes(message.type())) {
      (report.consoleEvents ??= []).push({ type: message.type(), text: message.text() });
      report.errors.push('Browser ' + message.type() + ': ' + message.text());
    }
  });
  await page.goto(origin); report.pageSnapshot = await page.locator('body').innerText();
  report.adapter = await page.evaluate(async () => {
    const adapter = await (navigator as any).gpu?.requestAdapter(); return adapter ? { info: adapter.info, features: [...adapter.features] } : null;
  });
  signal.throwIfAborted();
  assert(report.adapter && !report.adapter.info.isFallbackAdapter, 'No hardware WebGPU adapter; inference not attempted');
  return page;
  });
  for (const [index, row] of smallQwenSequence(p.cases).entries()) {
    const record: any = { index, candidateId: qualification.candidateId, imageId: row.id, repeated: index >= 8,
      promptSha256: row.promptSha256, expected: row.expected, calls: 0 };
    const started = Date.now();
    report.cases.push(record);
    try {
    const ready = await withQualificationDeadline('Image ' + row.id + ' fetch/inference/disposal', plan.nodeCaseDeadlineMs,
      (signal: AbortSignal) => p.appRun(row, async (request: any) => {
      signal.throwIfAborted();
      assert.equal(++record.calls, 1, 'Unexpected second image pass'); assert.equal(hash(request.prompt), row.promptSha256);
      const execution = await page.evaluate(async ({ spec, prompt, imageId }: any) => {
        const image = await (await fetch('/image/' + imageId)).arrayBuffer();
        return new Promise(resolve => {
          const worker = new Worker('/worker.mjs', { type: 'module' }); const gpu: any[] = [];
          let result: any, done = false;
          const finish = (extra: any) => { if (done) return; done = true; clearTimeout(timer); worker.terminate(); resolve({ result, gpu, ...extra }); };
          const timer = setTimeout(() => finish({ error: '180-second worker deadline' }), 180000);
          worker.onerror = event => finish({ error: event.message });
          worker.onmessage = ({ data }) => {
            if (data.kind === 'harness_gpu') { gpu.push(data); if (gpu.length > 1024) finish({ error: 'Observer overflow' }); }
            else if (data.kind === 'disposed') finish({ disposed: true });
            else if (['result', 'error', 'unavailable'].includes(data.kind)) { result = data; worker.postMessage({ kind: 'dispose', requestId: 100 }); }
          };
          worker.postMessage({ kind: 'infer', requestId: 1, modelId: spec.id, modelSpec: spec, prompt, image, maxTokens: 96 }, [image]);
        });
      }, { spec: p.spec, prompt: request.prompt, imageId: row.id });
      signal.throwIfAborted();
      record.execution = execution; record.raw = execution.result?.text;
      if (execution.error || execution.result?.kind !== 'result') return { kind: 'error', error: execution.error || JSON.stringify(execution.result) };
      record.retirement = p.observer.validateBufferRetirement(execution.gpu, { requestIds: [1], disposeRequestId: 100 });
      assert(execution.disposed && execution.gpu.some((x: any) => x.event === 'device'));
      assert(execution.gpu.filter((x: any) => x.event === 'device').every((x: any) => x.hardware));
      record.runtimePassed = true; return { kind: 'ok', text: record.raw };
    }));
    record.elapsedMs = Date.now() - started; record.hostResultKind = ready.kind;
    if (ready.kind === 'ready') {
      const form = p.cards.initToFormState(JSON.parse(new TextDecoder().decode(ready.card.confirmPayload)), new Date(row.sourceTimestamp));
      record.fields = Object.fromEntries(Object.keys(row.expected).map(key => [key, form[key]]));
      record.differences = differences(record.fields, row.expected);
      record.cardPassed = Object.keys(record.differences).length === 0;
    } else { record.cardPassed = false; record.hostError = ready.error; }
    console.log(JSON.stringify({ phase: 'case', candidateId: qualification.candidateId, output, index, imageId: row.id, elapsedMs: record.elapsedMs,
      runtimePassed: record.runtimePassed ?? false, cardPassed: record.cardPassed, fields: record.fields, error: record.hostError }));
    } catch (error) {
      record.elapsedMs = Date.now() - started; record.cardPassed = false;
      record.hostError = String(error); throw error; // No retry or subsequent image after a host deadline.
    } finally { json(output + '/case-' + index + '.json', record); }
  }
  // Acceptance is evaluated only after source stability and cleanup checks below.
} catch (error) { report.errors.push(String((error as any)?.stack ?? error)); }
finally {
  const browserCleanup = await boundedQualificationCleanup('Browser', plan.cleanupDeadlineMs,
    async () => { if (browserServer) await browserServer.close(); },
    browserServer ? async () => { await browserServer.kill(); } : undefined);
  report.cleanup.browser = browserCleanup;
  report.cleanup.browserClosed = browserCleanup.closed;
  report.errors.push(...browserCleanup.errors);
  const serverCleanup = await boundedQualificationCleanup('Loopback server', plan.cleanupDeadlineMs, async () => {
    server.closeAllConnections();
    if (listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    else server.close();
  });
  report.cleanup.server = serverCleanup;
  report.cleanup.serverClosed = serverCleanup.closed;
  report.errors.push(...serverCleanup.errors);
  try {
    await verifyBindings();
    report.sourceUnchanged = true;
  } catch (error) { report.errors.push('Input identity changed: ' + String(error)); }
  report.passed = smallQwenQualificationPassed(report);
  json(output + '/result.json', report);
  console.log(JSON.stringify({ phase: 'complete', candidateId: qualification.candidateId, output, passed: report.passed, cases: report.cases.length,
    runtimePasses: report.cases.filter((x: any) => x.runtimePassed).length,
    cardPasses: report.cases.filter((x: any) => x.cardPassed).length, errors: report.errors }));
}
process.exitCode = report.passed ? 0 : 1;
// Preserve the failed receipt even if a failed cleanup left process handles alive.
// The exact owned browser server has already received its bounded kill attempt.
if (!report.cleanup.browserClosed || !report.cleanup.serverClosed) process.exit(1);
}
