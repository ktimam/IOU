import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string =>
  readFileSync(path.join(root, relative), "utf8");

describe("local ActionInbox deployment policy", () => {
  it("derives the deploy interface from canonical PR2 Candid and rejects stale Wasm", () => {
    const script = read("scripts/deploy-openchat-inbox.sh");

    expect(script).toContain(
      "backend/canisters/action_inbox/api/can.did",
    );
    expect(script).toContain("didc check");
    expect(script).toContain("-newer \"$WASM\"");
    expect(script).toContain("actions : (Args_1) -> (Response_1);");
    expect(script).toContain("idempotency_key : blob;");
    expect(script).toContain("signature_version : nat16;");
    expect(script).toContain("ActionInbox actions must be a replicated update");
    expect(script).toContain('{ sub(/\\r$/, "") }');
    expect(script).toContain("-e '1s/^\\xEF\\xBB\\xBF//'");
    expect(script).toContain("-e 's/\\r$//'");
  });

  it("makes validation non-mutating and upgrades existing canisters in place", () => {
    const script = read("scripts/deploy-openchat-inbox.sh");
    const provision = read("scripts/deploy-openchat-canisters.sh");

    expect(script).toContain("--check|--dry-run");
    expect(script).toContain("ACTION_INBOX_CHECK_ONLY=true");
    expect(script).toContain("--mode install");
    expect(script).toContain("--mode upgrade");
    expect(script).not.toContain("--mode reinstall");
    expect(script).not.toContain("dfx deploy action_inbox");
    expect(script).toContain(
      "rerun with --upgrade for an explicit in-place upgrade",
    );
    expect(script).toContain(
      "refusing to discard its state or allocate a replacement",
    );
    expect(provision).not.toMatch(
      /rm -rf [^\n]*\.openchat-inbox[^\n]*\.dfx/,
    );
    expect(provision).toContain("OC_CYCLES_DISPENSER_CANISTER_ID");
    expect(provision).toContain("ACTION_INBOX_CANDID");
  });

  it("documents and exposes the check and explicit-upgrade commands", () => {
    const pkg = JSON.parse(read("package.json")) as {
      scripts?: Record<string, string>;
    };
    const runbook = read("docs/local-dev-runbook.md");

    expect(pkg.scripts?.["deploy:inbox:check"]).toContain("--check");
    expect(pkg.scripts?.["deploy:inbox:upgrade"]).toContain("--upgrade");
    expect(runbook).toContain("./scripts/generate-wasm.sh action_inbox");
    expect(runbook).toContain("OC_CYCLES_DISPENSER_CANISTER_ID");
    expect(runbook).toContain("never reinstalls, recreates, or deletes");
  });
});
