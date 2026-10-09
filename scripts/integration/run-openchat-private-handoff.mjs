#!/usr/bin/env node
// Optional cross-checkout integration; never installs dependencies or starts an app/backend.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const usage = "node scripts/integration/run-openchat-private-handoff.mjs --openchat-checkout <checkout> --work-dir <project-temp-directory>";
const argv = process.argv.slice(2);
if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
  console.log(usage);
  process.exit(0);
}
const args = new Map();
for (let index = 0; index < argv.length; index += 2) {
  const key = argv[index];
  const value = argv[index + 1];
  if (!["--openchat-checkout", "--work-dir"].includes(key) || args.has(key) || !value || value.startsWith("--")) {
    throw new Error(`Invalid arguments. Usage: ${usage}`);
  }
  args.set(key, value);
}
if (!args.has("--openchat-checkout") || !args.has("--work-dir")) {
  throw new Error(`Both paths are required; this test never reports skipped work as a pass. Usage: ${usage}`);
}
const scriptDir = dirname(fileURLToPath(import.meta.url));
const iouRoot = resolve(scriptDir, "../..");
const ocRoot = resolve(args.get("--openchat-checkout"));
const frontend = join(ocRoot, "frontend");
const modules = join(frontend, "node_modules");
const required = [
  join(frontend, "app/vitest.config.ts"),
  join(frontend, "app/src/utils/aiActionRunner.ts"),
  join(frontend, "app/src/utils/localAppCatalog.ts"),
  join(frontend, "tauri-plugin-oc/guest-js/index.ts"),
  join(modules, "vitest/vitest.mjs"),
  join(modules, "vite/dist/node/index.js"),
  join(modules, "svelte/package.json"),
  join(iouRoot, "node_modules"),
];
for (const file of required) {
  if (!existsSync(file)) throw new Error(`Required existing source/dependency is missing: ${file}. No packages were installed; no tests ran.`);
}
const workRoot = resolve(args.get("--work-dir"));
mkdirSync(workRoot, { recursive: true });
const runDir = mkdtempSync(join(workRoot, "iou-openchat-private-"));
const slash = (value) => value.replaceAll("\\", "/");
const quoted = (value) => JSON.stringify(slash(value));
const config = `
import base from ${quoted(join(frontend, "app/vitest.config.ts"))};
import { mergeConfig } from ${quoted(join(modules, "vite/dist/node/index.js"))};
import { readFileSync } from "node:fs";
const svelteRoot = ${quoted(join(modules, "svelte"))};
const packageExports = JSON.parse(readFileSync(svelteRoot + "/package.json", "utf8")).exports;
const svelteAliases = Object.entries(packageExports).flatMap(([key, value]) => {
  const target = typeof value === "string" ? value : value.browser ?? value.default;
  return typeof target === "string" ? [{
    find: key === "." ? "svelte" : "svelte/" + key.slice(2),
    replacement: svelteRoot + "/" + target,
  }] : [];
}).sort((left, right) => right.find.length - left.find.length);
export default mergeConfig(base, {
  root: ${quoted(iouRoot)},
  envDir: false,
  cacheDir: ${quoted(join(runDir, ".vite"))},
  resolve: { alias: [
    ...svelteAliases,
    { find: /^@oc-test\\/(.*)$/, replacement: ${quoted(join(frontend, "app/src/utils/$1"))} },
    { find: /^@oc-test-store\\/(.*)$/, replacement: ${quoted(join(frontend, "app/src/stores/$1"))} },
    { find: "vitest", replacement: ${quoted(join(modules, "vitest/dist/index.js"))} },
    { find: /^tauri-plugin-oc-api\\/(.*)$/, replacement: ${quoted(join(frontend, "tauri-plugin-oc/guest-js/$1"))} },
    { find: "tauri-plugin-oc-api", replacement: ${quoted(join(frontend, "tauri-plugin-oc/guest-js/index.ts"))} },
  ] },
  define: {
    "import.meta.env.VITE_IC_URL": "undefined",
    "import.meta.env.VITE_IOU_PROD_VETKD": JSON.stringify("0"),
  },
  test: {
    include: ["scripts/integration/openchat-private-handoff.spec.ts", "scripts/integration/local-import-readiness.spec.tsx", "scripts/integration/local-connect-readiness.spec.tsx", "scripts/integration/local-delivery-key-provider.spec.tsx", "scripts/integration/durable-inbox-hook.spec.tsx", "scripts/integration/durable-inbox-routing.spec.tsx", "scripts/integration/sheet-sign-in.spec.tsx"],
    maxWorkers: 1,
    minWorkers: 1,
    env: { VITE_IOU_PROD_VETKD: "0", VITE_IC_URL: "" },
  },
});
`;
const configPath = join(runDir, "vitest.config.mts");
writeFileSync(configPath, config, { flag: "wx" });
console.log(`Cross-package integration configuration/cache: ${runDir}`);
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) {
  if (key.startsWith("OC_") || key.startsWith("VITE_")) delete childEnv[key];
}
childEnv.VITE_IOU_PROD_VETKD = "0";
childEnv.VITE_IC_URL = "";
const result = spawnSync(process.execPath, [join(modules, "vitest/vitest.mjs"), "run", "--config", configPath], {
  cwd: iouRoot,
  env: childEnv,
  shell: false,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.signal) throw new Error(`Integration process terminated by ${result.signal}`);
process.exitCode = result.status ?? 1;
