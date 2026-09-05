// Keep app-specific behavior out of the host checkout, including examples and regression fixtures.
// Run: node --import tsx scripts/live/audit-openchat-app-boundary.ts --repo <OpenChat checkout>
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const repoIndex = process.argv.indexOf("--repo");
if (repoIndex < 0 || !process.argv[repoIndex + 1]) throw new Error("--repo is required");
const repo = resolve(process.argv[repoIndex + 1]);
if (!existsSync(join(repo, "frontend/openchat-shared/src/domain/aiAction.ts"))) throw new Error("Not an OpenChat checkout");
const files = execFileSync("git", ["-c", `safe.directory=${repo.replaceAll("\\", "/")}`, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).split("\0").filter(Boolean);
const textExtensions = new Set([".rs", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".txt", ".html", ".svelte", ".toml", ".yaml", ".yml", ".sh", ".ps1", ".did", ".svg", ".css", ".scss"]);
const prohibited = /\biou\b|sourceGroundedActionParser|(?:parse|supports)SourceGroundedTransactions|x-openchat-(?:source-grounded-transactions|date-from-text|date-from-message-timestamp-keywords|normalize-date|text-sequence|delimited-text-sequence)/i;
const domainRoles = /\b(?:amountField|currencyField|kindField|directionField|dateField|noteField|fallbackKind|hasUnsupportedSettlementViewpoint)\b/;
const findings: { file: string; line: number; reason: string }[] = [];
let checked = 0;
for (const file of new Set(files)) {
  if (!textExtensions.has(extname(file)) || !existsSync(join(repo, file))) continue;
  const text = readFileSync(join(repo, file), "utf8");
  checked++;
  const aiImplementation = /frontend\/(?:app\/src\/utils|openchat-shared\/src\/domain)\//.test(file);
  text.split(/\r?\n/).forEach((line, index) => {
    if (prohibited.test(line)) findings.push({ file, line: index + 1, reason: "app reference or removed host interpretation contract" });
    if (aiImplementation && domainRoles.test(line)) findings.push({ file, line: index + 1, reason: "transaction-specific host field role" });
  });
}
console.log(JSON.stringify({ passed: findings.length === 0, checkedTextFiles: checked, findings }, null, 2));
if (findings.length) process.exitCode = 1;
