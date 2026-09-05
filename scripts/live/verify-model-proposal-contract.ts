// Desktop entrypoint; same browser-safe integration suite runs in the emulator APK WebView.
// Usage: node --import tsx scripts/live/verify-model-proposal-contract.ts --openchat-repo <checkout>
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runModelProposalContract, type ModelProposalHost } from "./modelProposalContract";

const args = process.argv.slice(2);
const index = args.indexOf("--openchat-repo");
const repo = index < 0 ? undefined : args[index + 1];
assert(repo && !repo.startsWith("--"), "--openchat-repo is required; no deployment path is hardcoded");
const host = await import(pathToFileURL(resolve(repo, "frontend/openchat-shared/src/domain/aiAction.ts")).href) as ModelProposalHost;
const report = await runModelProposalContract(host);
console.log(JSON.stringify(report, null, 2));
assert(report.cases.length === 4 && report.pass, "Recorded phone model output failed the desktop proposal contract");
