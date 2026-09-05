/**
 * Run IOU's shared recorded-model proposal contract INSIDE the running Android emulator WebView.
 * This bundles actual OpenChat checkout + IOU source for replay; it does not test packaged UI event
 * handlers, GPU inference, app attestation, or chat posting. Neither auth nor model caches are reset.
 *
 * pnpm exec tsx scripts/live/verify-emulator-model-proposal-contract.ts \
 *   --openchat-repo <checkout> --adb <adb-executable> --emulator emulator-5554 \
 *   --output output/playwright/emulator-model-proposal-contract.json
 *
 * APK must already be running. The runner verifies ro.kernel.qemu=1, forwards only that emulator's
 * com.oc.app WebView CDP endpoint on an ephemeral local port, and removes its own forward afterward.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUTPUT_ROOT = resolve(ROOT, "output/playwright");
const packageRequire = createRequire(import.meta.url);
const viteRequire = createRequire(packageRequire.resolve("vite/package.json"));
const { build } = viteRequire("esbuild") as {
  build(options: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
};

function argumentsFor(argv: string[]) {
  const allowed = ["--openchat-repo", "--adb", "--emulator", "--output"];
  if (argv.length !== allowed.length * 2) throw new Error("invalid arguments");
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.includes(name) || values.has(name) || !value || value.startsWith("--")) {
      throw new Error("invalid arguments");
    }
    values.set(name, value);
  }
  const emulator = values.get("--emulator")!;
  if (!/^emulator-\d{4,5}$/.test(emulator)) throw new Error("emulator serial required");
  const output = resolve(ROOT, values.get("--output")!);
  const outputRelative = relative(OUTPUT_ROOT, output);
  if (!outputRelative || outputRelative.startsWith("..") || isAbsolute(outputRelative) ||
      extname(output).toLowerCase() !== ".json") throw new Error("invalid output path");
  return {
    repo: resolve(values.get("--openchat-repo")!),
    adb: values.get("--adb")!,
    emulator,
    output,
  };
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  const adb = (...args: string[]) => execFileSync(options.adb, ["-s", options.emulator, ...args], {
    encoding: "utf8", timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (adb("shell", "getprop", "ro.kernel.qemu") !== "1") throw new Error("target is not an emulator");
  const pid = adb("shell", "pidof", "com.oc.app");
  if (!/^\d+$/.test(pid)) throw new Error("start the APK on the emulator first");

  const hostPath = resolve(options.repo, "frontend/openchat-shared/src/domain/aiAction.ts");
  const replayPath = resolve(ROOT, "scripts/live/modelProposalContract.ts");
  const fixturePath = resolve(ROOT, "src/features/openchat/fixtures/model-proposal-contract-v1.json");
  const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const bundle = await build({
    stdin: {
      contents: `import * as host from ${JSON.stringify(hostPath)};\n` +
        `import { runModelProposalContract } from ${JSON.stringify(replayPath)};\n` +
        "export async function run() { return runModelProposalContract(host); }",
      resolveDir: ROOT,
      sourcefile: "iou-emulator-proposal-contract-entry.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "browser",
    target: "es2022",
    format: "iife",
    globalName: "iouRecordedModelContract",
    define: { "import.meta.env": "{}", "import.meta.hot": "undefined" },
    logLevel: "silent",
  });
  const code = bundle.outputFiles[0]?.text;
  if (!code || code.length > 4 * 1024 * 1024) throw new Error("invalid replay bundle");

  let forwardedPort: string | undefined;
  let result: Record<string, unknown> | undefined;
  const started = Date.now();
  try {
    forwardedPort = adb("forward", "tcp:0", `localabstract:webview_devtools_remote_${pid}`);
    if (!/^\d{1,5}$/.test(forwardedPort)) throw new Error("invalid emulator CDP forward");
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${forwardedPort}`, { timeout: 15_000 });
    const pages = browser.contexts().flatMap((context) => context.pages()).filter((page) => {
      try { return !page.isClosed() && new URL(page.url()).origin === "http://tauri.localhost"; }
      catch { return false; }
    });
    if (pages.length !== 1) throw new Error("expected exactly one emulator APK WebView");
    const page = pages[0];
    // The bundle is scoped to this invocation; no helpers or model hooks remain on the APK window.
    result = await page.evaluate(`(async () => {
      const snapshot = () => JSON.stringify({ local: {...localStorage}, session: {...sessionStorage} });
      const before = snapshot();
      const beforeUrl = location.href;
      const androidWebView = /Android/.test(navigator.userAgent) && /;\\s*wv\\)/.test(navigator.userAgent);
      if (!androidWebView) throw new Error("expected Android WebView");
      ${code}
      const suite = await iouRecordedModelContract.run();
      return {
        suite,
        androidWebView,
        secureContext: isSecureContext,
        storageUnchanged: before === snapshot(),
        pageUnchanged: beforeUrl === location.href
      };
    })()`);
    // Never browser.close(): CDP browser ownership remains with the user's running emulator.
  } finally {
    if (forwardedPort !== undefined && /^\d{1,5}$/.test(forwardedPort)) {
      adb("forward", "--remove", `tcp:${forwardedPort}`);
    }
  }

  const suite = result?.suite as { pass?: boolean } | undefined;
  const pass = suite?.pass === true && result?.storageUnchanged === true && result?.pageUnchanged === true;
  const report = {
    format: "iou-emulator-recorded-model-proposal-contract-v1",
    pass,
    execution: {
      emulatorVerifiedByAdb: true,
      insideAndroidWebView: result?.androidWebView === true,
      actualCheckoutSourceBundled: true,
      hostSourceSha256: hash(readFileSync(hostPath)),
      fixtureSha256: hash(readFileSync(fixturePath)),
      bundleSha256: hash(code),
      recordedInferenceOnly: true,
      realGpuInferencePerformed: false,
      packagedUiProposalPerformed: false,
      backendAttestationPerformed: false,
      chatPosted: false,
      accountReset: false,
      ownCdpForwardRemoved: true,
    },
    checks: result,
    elapsedMs: Date.now() - started,
  };
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, JSON.stringify(report, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify({ pass, emulatorWebView: true, recordedInferenceOnly: true, elapsedMs: report.elapsedMs }) + "\n");
  process.exitCode = pass ? 0 : 1;
}

void main().then(() => process.exit(process.exitCode ?? 0)).catch(() => {
  // Do not print full CDP/app errors, which can contain user data or deployment identifiers.
  process.stderr.write("Emulator proposal replay could not complete. Check the running APK, explicit checkout/ADB paths, and emulator serial.\n");
  process.exit(1);
});
