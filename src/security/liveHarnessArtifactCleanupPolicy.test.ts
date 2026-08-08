import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function liveHarness(name: string): string {
  return readFileSync(path.join(process.cwd(), "scripts/live", name), "utf8");
}

const migratedHarnesses = [
  "verify-nomodel-guide.ts",
  "verify-app-card-edit.ts",
  "verify-app-card-multi.ts",
  "verify-default-currency.ts",
  "verify-extraction-gate.ts",
  "verify-multi-entry.ts",
  "verify-routed-card-types.ts",
] as const;

const exactProducerHarnesses = migratedHarnesses.filter(
  (name) => name !== "verify-nomodel-guide.ts",
);

const depositingHarnesses = [
  "verify-app-card-edit.ts",
  "verify-app-card-multi.ts",
  "verify-default-currency.ts",
] as const;

describe("live card harness artifact-cleanup policy", () => {
  for (const name of migratedHarnesses) {
    it(`${name} finalizes exact cleanup before closing every disposable tab scope`, () => {
      const source = liveHarness(name);
      expect(source).toContain("new OpenChatArtifactScope(");
      expect(source).toContain("await artifactScope.begin()");

      const beforeEachClose = source.split("await tabs.close()");
      expect(beforeEachClose.length).toBeGreaterThan(1);
      for (const segment of beforeEachClose.slice(0, -1)) {
        expect(segment).toContain("finalizeOpenChatArtifactCleanup(");
      }
    });
  }

  for (const name of exactProducerHarnesses) {
    it(`${name} binds cleanup to run-unique source and card evidence`, () => {
      const source = liveHarness(name);
      expect(source).toContain("artifactScope.expectExactText(");
      expect(source).toContain("artifactScope.expectCardInputs(");
    });
  }

  it("migrated harnesses have no mobile-only capture selector", () => {
    for (const name of migratedHarnesses) {
      const source = liveHarness(name);
      const directMobileSelectors = source.match(/locator\(["']\.message_text["']\)/g) ?? [];
      expect(directMobileSelectors, `${name} has a stale mobile-only capture selector`).toEqual([]);
    }
  });

  it("the routed-card and browser-model QC gesture only on exact fresh stable coordinates", () => {
    for (const name of ["verify-routed-card-types.ts", "v2-browser-model-e2e.ts"] as const) {
      const source = liveHarness(name);
      expect(source).toContain("await artifactScope.begin()");
      expect(source).toContain("waitForExactTextMessage(");
      expect(source).toContain("exactOpenChatMessageWrapper(");
      expect(source).toContain(".locator(OPENCHAT_MESSAGE_TEXT_SELECTOR)");
      expect(source).not.toMatch(/\.message_text[\s\S]{0,80}\.last\(\)/);
    }
  });

  it("tracked batch-7 negative message evidence uses the cross-tree selector", () => {
    const source = liveHarness("verify-batch7-oc.ts");
    expect(source).toContain(".locator(OPENCHAT_MESSAGE_TEXT_SELECTOR)");
    expect(source).not.toContain('.locator(".message_text")');
  });

  it("the per-chat routing journey never navigates or retains the user's existing tabs", () => {
    const source = liveHarness("verify-per-chat-routing.ts");
    expect(source).toContain("new TemporaryTabScope()");
    expect(source).toContain("await tabs.open(");
    expect(source).toContain("routingPages.add(routingPage)");
    expect(source).toContain("await routingPage.close(");
    expect(source).toContain("finally {");
    expect(source).toContain("await tabs.close()");
    expect(source).toContain("const openchat = await tabs.open(openchatSource,");
    expect(source).not.toContain("await openchatSource.goto(");
  });

  it("the no-model boundary binds cleanup to each exact fresh source and never guesses at a card", () => {
    const source = liveHarness("verify-nomodel-guide.ts");
    expect(source).not.toContain("expectSingleFreshCard");
    expect(source).toContain("artifactScope.expectExactText(text)");
    expect(source.match(/await sendFreshSource\(page, artifactScope,/g)).toHaveLength(2);
    expect(source.match(/await proposeExactMessage\(page, sourceMessage\)/g)).toHaveLength(2);
    expect(source).toContain("exactOpenChatMessageWrapper(page, source.message)");
    expect(source).toContain("freshness alone cannot prove");
    expect(source).toContain('node.classList.contains("me")');
    expect(source).not.toContain("proposeExistingMessage");
    expect(source).not.toMatch(/getByText\("Propose action"[\s\S]{0,100}\.last\(\)/);
    expect(source).not.toContain("no existing message with a Propose action menu");
  });

  it("the routed private-type proof no longer leaves a pending card for inspection", () => {
    const source = liveHarness("verify-routed-card-types.ts");
    expect(source).toContain("await artifactScope.trackExactCard(loaded.card, [note])");
    expect(source).not.toMatch(/pending card can be inspected later/i);
  });

  for (const name of depositingHarnesses) {
    it(`${name} acknowledges both fan-out envelopes by exact payload after the test`, () => {
      const source = liveHarness(name);
      expect(source).toContain("new ActionInboxArtifactScope(");
      expect(source).toContain("await inboxScope.begin()");
      expect(source).toContain("inboxScope.arm()");
      expect(source).toContain('label: "father"');
      expect(source).toContain('label: "manager"');
      const inboxFinalize = source.lastIndexOf("finalizeActionInboxArtifactCleanup(");
      const chatFinalize = source.lastIndexOf("finalizeOpenChatArtifactCleanup(");
      const close = source.lastIndexOf("await tabs.close()");
      expect(inboxFinalize).toBeGreaterThanOrEqual(0);
      expect(chatFinalize).toBeGreaterThan(inboxFinalize);
      expect(close).toBeGreaterThan(chatFinalize);
    });
  }

  it("the end-to-end multi-entry proof cleans both recipient and proposer fan-out envelopes", () => {
    const source = liveHarness("verify-multi-entry.ts");
    expect(source).toContain("cleanupIouBatch(confirmerIOU, expected");
    expect(source).toContain("new ActionInboxArtifactScope(");
    expect(source).toContain("await inboxScope.begin()");
    expect(source).toContain("inboxScope.arm()");
    expect(source).toContain("finalizeActionInboxArtifactCleanup(");
  });

  it("the shared helper refuses recipient-only and unbound deletion paths", () => {
    const source = liveHarness("openChatArtifactCleanup.ts");
    expect(source).toContain("candidate.owned");
    expect(source).toContain("waitForExactTextMessage(exactText");
    expect(source).toContain('node.closest(".message_text") === null');
    expect(source).toContain("unsupported cleanup expectation");
    expect(source).toContain('name: "Delete for me", exact: true');
    expect(source).toContain('name: "Delete", exact: true');
    expect(source).toContain("deletion did not survive reload");
    expect(source).not.toContain("single_fresh_card");
    expect(source).not.toContain("expectSingleFreshCard");
  });

  it("the inbox helper baselines ids and refuses ambiguous acknowledgement", () => {
    const source = liveHarness("actionInboxArtifactCleanup.ts");
    expect(source).toContain("excluded.has(candidate.id.toString())");
    expect(source).toContain("matches.length === 1");
    expect(source).toContain("acknowledgementSecret: match.acknowledgementSecret");
    expect(source).toContain("refusing ambiguous acknowledgement");
  });
});
