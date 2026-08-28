/**
 * Read-only OpenChat browser/bootstrap readiness probe.
 *
 * It launches an ephemeral headless browser context, observes only the ordinary `/worker.js`
 * request/response envelope, and proves that both `init` and anonymous `setAuthIdentity` finish.
 * No persistent profile, signed-in account, model cache, or app state is opened or changed.
 */

import { chromium, type Browser, type LaunchOptions } from "@playwright/test";

type WorkerProbeState = {
  workersCreated: number;
  workerUrl?: string;
  initPosted: boolean;
  initResolved: boolean;
  authPosted: boolean;
  authResolved: boolean;
  identityCanisterPresent: boolean;
  identityCanisterMatched: boolean;
  errors: string[];
};

type BrowserProbeResult = {
  ready: true;
  origin: string;
  documentReadyState: string;
  backgroundWorker: WorkerProbeState;
  pageErrors: string[];
};

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing required ${name}`);
  }
  return value;
}

function positiveIntegerArgument(name: string): number {
  const value = Number(argument(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function launchOptions(channel: string): LaunchOptions {
  if (!/^(?:chrome|msedge|chromium)$/.test(channel)) {
    throw new Error("--browser-channel must be chrome, msedge, or chromium");
  }
  return channel === "chromium"
    ? { headless: true }
    : { channel: channel as "chrome" | "msedge", headless: true };
}

async function probe(
  origin: string,
  channel: string,
  timeoutMs: number,
  expectedIdentityCanister: string,
): Promise<BrowserProbeResult> {
  let browser: Browser | undefined;
  const pageErrors: string[] = [];
  try {
    browser = await chromium.launch(launchOptions(channel));
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.addInitScript(({ expectedIdentityCanister }) => {
      const state: WorkerProbeState = {
        workersCreated: 0,
        initPosted: false,
        initResolved: false,
        authPosted: false,
        authResolved: false,
        identityCanisterPresent: false,
        identityCanisterMatched: false,
        errors: [],
      };
      Object.defineProperty(window, "__openChatWorkerReadinessProbe", {
        value: state,
        configurable: false,
        enumerable: false,
        writable: false,
      });

      const NativeWorker = window.Worker;
      window.Worker = new Proxy(NativeWorker, {
        construct(target, args) {
          const worker = Reflect.construct(target, args) as Worker;
          let isOpenChatWorker = false;
          try {
            const workerUrl = new URL(String(args[0]), window.location.href);
            isOpenChatWorker = workerUrl.pathname === "/worker.js";
            if (isOpenChatWorker) {
              state.workersCreated += 1;
              state.workerUrl = workerUrl.origin + workerUrl.pathname;
            }
          } catch (error) {
            state.errors.push(`invalid worker URL: ${String(error)}`);
          }
          if (!isOpenChatWorker) return worker;

          const nativePostMessage = worker.postMessage.bind(worker);
          worker.postMessage = ((message: unknown, transferOrOptions?: unknown) => {
            if (typeof message === "object" && message !== null && "kind" in message) {
              const kind = String((message as { kind?: unknown }).kind);
              if (kind === "init") {
                state.initPosted = true;
                const identityCanister = (message as { identityCanister?: unknown })
                  .identityCanister;
                state.identityCanisterPresent =
                  typeof identityCanister === "string" && identityCanister.length > 0;
                state.identityCanisterMatched =
                  identityCanister === expectedIdentityCanister;
              }
              if (kind === "setAuthIdentity") state.authPosted = true;
            }
            if (transferOrOptions === undefined) nativePostMessage(message);
            else {
              (nativePostMessage as (value: unknown, options: unknown) => void)(
                message,
                transferOrOptions,
              );
            }
          }) as Worker["postMessage"];

          worker.addEventListener("message", (event) => {
            const data = event.data as
              | { kind?: unknown; requestKind?: unknown; final?: unknown }
              | undefined;
            if (data?.kind !== "worker_response" || data.final !== true) return;
            if (data.requestKind === "init") state.initResolved = true;
            if (data.requestKind === "setAuthIdentity") state.authResolved = true;
          });
          worker.addEventListener("error", (event) => {
            state.errors.push(event.message || "OpenChat worker error");
          });
          worker.addEventListener("messageerror", () => {
            state.errors.push("OpenChat worker returned an unreadable message");
          });
          return worker;
        },
      });
    }, { expectedIdentityCanister });

    const response = await page.goto(origin, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    if (response === null || !response.ok()) {
      throw new Error(`OpenChat navigation failed with HTTP ${response?.status() ?? "unknown"}`);
    }

    await page.waitForFunction(
      () => {
        const state = (
          window as Window & { __openChatWorkerReadinessProbe?: WorkerProbeState }
        ).__openChatWorkerReadinessProbe;
        const startupFailure = document.body.innerText.includes(
          "OpenChat could not finish loading its background worker",
        );
        return (
          startupFailure ||
          (state !== undefined &&
            (state.errors.length > 0 || (state.initResolved && state.authResolved)))
        );
      },
      undefined,
      { timeout: timeoutMs },
    );

    const state = await page.evaluate(
      () =>
        (
          window as Window & { __openChatWorkerReadinessProbe?: WorkerProbeState }
        ).__openChatWorkerReadinessProbe,
    );
    if (state === undefined) throw new Error("OpenChat worker probe was not installed");
    if (state.errors.length > 0) {
      throw new Error(`OpenChat background worker failed: ${state.errors.join("; ")}`);
    }
    if (!state.initPosted || !state.initResolved || !state.authPosted || !state.authResolved) {
      throw new Error(
        `OpenChat background worker startup was incomplete: ${JSON.stringify(state)}`,
      );
    }
    if (!state.identityCanisterPresent || !state.identityCanisterMatched) {
      throw new Error(
        "OpenChat worker init did not contain the exact configured local Identity canister",
      );
    }
    const startupFailureVisible = await page.getByRole("alert").filter({
      hasText: "OpenChat could not finish loading its background worker",
    }).count();
    if (startupFailureVisible > 0) {
      throw new Error("OpenChat displayed its background-worker startup failure UI");
    }

    return {
      ready: true,
      origin,
      documentReadyState: await page.evaluate(() => document.readyState),
      backgroundWorker: state,
      pageErrors,
    };
  } finally {
    await browser?.close();
  }
}

async function main(): Promise<void> {
  const origin = new URL(argument("--origin")).origin;
  const channel = argument("--browser-channel");
  const timeoutMs = positiveIntegerArgument("--timeout-ms");
  const expectedIdentityCanister = argument("--expected-identity-canister");
  const result = await probe(origin, channel, timeoutMs, expectedIdentityCanister);
  process.stdout.write(JSON.stringify(result));
}

main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      ready: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
