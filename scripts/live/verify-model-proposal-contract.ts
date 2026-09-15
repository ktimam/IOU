// Desktop entrypoint; same browser-safe integration suite runs in the emulator APK WebView.
// Usage: node --import tsx scripts/live/verify-model-proposal-contract.ts --openchat-repo <checkout>
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runModelProposalContract, type ModelProposalHost } from "./modelProposalContract";
import fixtures from "../../src/features/openchat/fixtures/model-proposal-contract-v1.json";

const args = process.argv.slice(2);
const index = args.indexOf("--openchat-repo");
const repo = index < 0 ? undefined : args[index + 1];
assert(repo && !repo.startsWith("--"), "--openchat-repo is required; no deployment path is hardcoded");
const host = await import(pathToFileURL(resolve(repo, "frontend/openchat-shared/src/domain/aiAction.ts")).href) as ModelProposalHost;
const report = await runModelProposalContract(host);
console.log(JSON.stringify(report, null, 2));
assert.deepEqual(report.cases.map(({ id }) => id), fixtures.cases.map(({ id }) => id),
  "Desktop replay must execute every recorded case and synthetic control");
assert(report.pass, "Recorded phone model output failed the desktop proposal contract");
