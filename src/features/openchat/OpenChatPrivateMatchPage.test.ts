import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { uniquePrivateKeywordMatch } from "./privateMatchContext";
import { privateMatchPersistedMessageEvidence } from "./OpenChatPrivateMatchPage";

describe("IOU private matcher isolation", () => {
  const page = readFileSync(resolve(__dirname, "OpenChatPrivateMatchPage.tsx"), "utf8");
  const context = readFileSync(resolve(__dirname, "privateMatchContext.ts"), "utf8");
  const templatesManager = readFileSync(
    resolve(__dirname, "../templates/TemplatesManager.tsx"),
    "utf8",
  );

  it("binds one parent WindowProxy/origin/attempt and returns no metadata", () => {
    expect(page).toContain("event.source !== parentWindow");
    expect(page).toContain("event.origin !== parentOrigin");
    expect(page).toContain("buildPrivateMatchResult(binding, matched)");
    expect(page).toContain("error.definitiveNoMatch");
    expect(page).toContain("finish(false)");
    expect(page).toContain("const FRAME_LIFETIME_MS = 31_000");
    expect(page).not.toMatch(/postMessage\([^)]*(?:template|keyword|count|error)/s);
    expect(page).not.toMatch(/localStorage|sessionStorage|console\./);
  });

  it("proves the linked context before requesting text, then verifies it before matching", () => {
    expect(page.indexOf("preparePrivateMatchContext(request.capability, session)")).toBeGreaterThan(-1);
    expect(page.indexOf("preparePrivateMatchContext(request.capability, session)")).toBeLessThan(
      page.indexOf("buildPrivateMatchSourceReady(authorizedBinding)"),
    );
    expect(page.indexOf("buildPrivateMatchSourceReady(authorizedBinding)")).toBeLessThan(
      page.indexOf("parsePrivateMatchSource(event.data, binding)"),
    );
    expect(page.indexOf("verifyPrivateMatchSource(context, exactMessageText)")).toBeLessThan(
      page.indexOf("uniquePrivateKeywordMatch(context.keywordSets, persistedEvidence)"),
    );
    expect(context).toContain("context.sheetKey.fill(0)");
    expect(context).toContain("context.sourceBinding.fill(0)");
    expect(context).toContain('keywords.fill("")');
    expect(context).toContain("Reflect.deleteProperty(record, key)");
    expect(context).toContain("zeroRawBytes(raw.source_binding)");
    expect(context).toContain('slotA.dismissed.fill("")');
  });

  it("matches only the exact 200-character evidence the final IOU card persists", () => {
    const withinBoundary = `  School ${"x".repeat(300)}  `;
    const afterBoundary = `${"x".repeat(200)} school`;
    expect(privateMatchPersistedMessageEvidence(withinBoundary)).toHaveLength(200);
    expect(privateMatchPersistedMessageEvidence(withinBoundary).startsWith("School ")).toBe(true);
    expect(
      uniquePrivateKeywordMatch(
        [["school"]],
        privateMatchPersistedMessageEvidence(withinBoundary),
      ),
    ).toBe(true);
    expect(
      uniquePrivateKeywordMatch(
        [["school"]],
        privateMatchPersistedMessageEvidence(afterBoundary),
      ),
    ).toBe(false);
  });

  it("verifies the full exact source before deriving persisted matcher evidence", () => {
    expect(page.indexOf("verifyPrivateMatchSource(context, exactMessageText)")).toBeLessThan(
      page.indexOf("const persistedEvidence = privateMatchPersistedMessageEvidence(exactMessageText)"),
    );
  });

  it("explains explicit Trigger words and the required OpenChat account link", () => {
    expect(templatesManager).toContain("type name is not an automatic");
    expect(templatesManager).toContain("add the name here too if you want it to match");
    expect(templatesManager).toContain("connect IOU for a");
    expect(templatesManager).toContain("direct chat");
    expect(templatesManager).toContain("have an admin enable it there");
    expect(templatesManager).toContain("link that exact chat to this IOU account");
    expect(templatesManager).toMatch(/Keep\s+auto-propose suggestions on and that chat unmuted/);
    expect(templatesManager).toMatch(/new text\s+messages observed while that chat is open/);
  });
});
