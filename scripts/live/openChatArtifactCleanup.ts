import type { Locator, Page } from "@playwright/test";

export type OpenChatMessageRef = {
  messageId: string;
  messageIndex: number;
  eventIndex: number;
};

export type OpenChatArtifactBaseline = {
  messageIds: string[];
  maxMessageIndex: number;
};

export type OpenChatArtifactCandidate = {
  message: OpenChatMessageRef;
  owned: boolean;
  exactTexts: string[];
  cardCount: number;
  iframeInputValues: string[];
};

export type OpenChatArtifactExpectation =
  | { kind: "text"; exactText: string }
  | { kind: "card_inputs"; exactInputValues: string[] };

export type OpenChatArtifactSelection = {
  matches: OpenChatArtifactCandidate[];
  error?: string;
};

export type OpenChatArtifactCleanupReport = {
  deleted: OpenChatMessageRef[];
  errors: string[];
};

export interface OpenChatArtifactCleaner {
  cleanup(): Promise<OpenChatArtifactCleanupReport>;
}

type TrackedArtifact = {
  message: OpenChatMessageRef;
  evidence: { kind: "text"; exactText: string } | { kind: "card" };
};

const MESSAGE_WRAPPER_SELECTOR = '[data-id][data-index][id^="event-"]';
export const OPENCHAT_MESSAGE_TEXT_SELECTOR = ".message_text, .markdown-wrapper";

async function renderedMessageTexts(wrapper: Locator): Promise<string[]> {
  return wrapper.locator(OPENCHAT_MESSAGE_TEXT_SELECTOR).evaluateAll((nodes) =>
    (nodes as HTMLElement[])
      // Mobile nests Markdown inside `.message_text`; count that rendered message once. Classic has
      // no `.message_text`, so its top-level `.markdown-wrapper` remains the evidence node.
      .filter(
        (node) =>
          !node.classList.contains("markdown-wrapper") || node.closest(".message_text") === null,
      )
      .map((node) => node.innerText),
  );
}

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function messageKey(message: OpenChatMessageRef): string {
  return `${message.messageId}/${message.messageIndex}/${message.eventIndex}`;
}

function isFresh(
  baseline: OpenChatArtifactBaseline,
  candidate: OpenChatArtifactCandidate,
): boolean {
  return (
    candidate.owned &&
    candidate.message.messageIndex > baseline.maxMessageIndex &&
    !baseline.messageIds.includes(candidate.message.messageId)
  );
}

/** Pure fail-closed selector used by both the live helper and its unit tests. */
export function selectExactOpenChatArtifacts(
  baseline: OpenChatArtifactBaseline,
  candidates: readonly OpenChatArtifactCandidate[],
  expectation: OpenChatArtifactExpectation,
): OpenChatArtifactSelection {
  const fresh = candidates.filter((candidate) => isFresh(baseline, candidate));
  if (expectation.kind === "text") {
    const exact = normalized(expectation.exactText);
    if (!exact) return { matches: [], error: "refusing empty exact-text cleanup evidence" };
    return {
      matches: fresh.filter(
        (candidate) =>
          candidate.exactTexts.filter((value) => normalized(value) === exact).length === 1,
      ),
    };
  }
  if (expectation.kind === "card_inputs") {
    const wanted = expectation.exactInputValues.map(normalized);
    if (wanted.length === 0 || wanted.some((value) => !value)) {
      return { matches: [], error: "refusing empty iframe-input cleanup evidence" };
    }
    return {
      matches: fresh.filter(
        (candidate) =>
          candidate.cardCount === 1 &&
          wanted.every((value) =>
            candidate.iframeInputValues.some((candidateValue) => normalized(candidateValue) === value),
          ),
      ),
    };
  }

  // Defensive runtime guard for stale compiled harnesses or untyped JavaScript callers. A card is
  // never safe to delete merely because it is the only fresh sender-owned card: another tab or the
  // user may have posted it after our baseline. Every supported expectation above carries exact,
  // run-specific evidence.
  const unsupported = expectation as { kind?: unknown };
  return {
    matches: [],
    error: `unsupported cleanup expectation: ${String(unsupported.kind ?? "missing kind")}`,
  };
}

export function exactOpenChatMessageWrapper(page: Page, message: OpenChatMessageRef): Locator {
  return page.locator(
    `[data-id="${message.messageId}"][data-index="${message.messageIndex}"][id="event-${message.eventIndex}"]`,
  );
}

async function messageRefFromWrapper(
  wrapper: Locator,
  label: string,
): Promise<OpenChatMessageRef> {
  if ((await wrapper.count()) !== 1) throw new Error(`${label}: message wrapper is not unique`);
  const [messageId, rawMessageIndex, rawEventId] = await Promise.all([
    wrapper.getAttribute("data-id"),
    wrapper.getAttribute("data-index"),
    wrapper.getAttribute("id"),
  ]);
  const event = /^event-(\d+)$/.exec(rawEventId ?? "");
  if (!/^\d+$/.test(messageId ?? "") || !/^\d+$/.test(rawMessageIndex ?? "") || !event) {
    throw new Error(`${label}: invalid stable message coordinates`);
  }
  return {
    messageId: messageId!,
    messageIndex: Number(rawMessageIndex),
    eventIndex: Number(event[1]),
  };
}

async function senderOwned(wrapper: Locator): Promise<boolean> {
  return wrapper.evaluate((node) => {
    if (node.classList.contains("message")) return node.classList.contains("me");
    return (
      node.classList.contains("container") && getComputedStyle(node).justifyContent === "flex-end"
    );
  });
}

async function readCandidate(wrapper: Locator): Promise<OpenChatArtifactCandidate> {
  const message = await messageRefFromWrapper(wrapper, "artifact candidate");
  const exactTexts = await renderedMessageTexts(wrapper);
  const cards = wrapper.locator(".action-card");
  const cardCount = await cards.count();
  const iframeInputValues: string[] = [];
  if (cardCount === 1 && (await cards.first().locator("iframe").count()) === 1) {
    const inputs = cards.first().frameLocator("iframe").locator("input");
    const inputCount = await inputs.count().catch(() => 0);
    for (let index = 0; index < inputCount; index++) {
      iframeInputValues.push(await inputs.nth(index).inputValue().catch(() => ""));
    }
  }
  return {
    message,
    owned: await senderOwned(wrapper),
    exactTexts,
    cardCount,
    iframeInputValues,
  };
}

async function visibleMatches(locator: Locator): Promise<Locator[]> {
  const result: Locator[] = [];
  const count = await locator.count();
  for (let index = 0; index < count; index++) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) result.push(candidate);
  }
  return result;
}

async function exactlyOneVisible(
  locator: Locator,
  label: string,
  timeoutMs = 5_000,
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = await visibleMatches(locator);
    if (matches.length > 1) throw new Error(`${label}: ${matches.length} visible matches`);
    if (matches.length === 1) return matches[0];
    await locator.page().waitForTimeout(100);
  }
  throw new Error(`${label}: no visible match`);
}

async function dismissOverlay(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const visible = await page.locator("#masked_overlay.visible").isVisible().catch(() => false);
    if (!visible) return;
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(250);
  }
  if (await page.locator("#masked_overlay.visible").isVisible().catch(() => false)) {
    throw new Error("an existing OpenChat overlay could not be dismissed");
  }
}

async function openOwnedMobileMenu(page: Page, wrapper: Locator): Promise<Locator> {
  const trigger = wrapper.locator(".message_bubble_wrapper > .menu-trigger");
  if ((await trigger.count()) !== 1) throw new Error("mobile message trigger is not unique");
  await trigger.scrollIntoViewIfNeeded();
  for (let attempt = 0; attempt < 3; attempt++) {
    await dismissOverlay(page);
    await trigger.dispatchEvent("click").catch(() => undefined);
    await page.waitForTimeout(400);
    let menus = await visibleMatches(page.locator(".message_bubble_menu.second.me"));
    if (menus.length === 0) {
      const box = await trigger.boundingBox();
      if (!box) throw new Error("mobile message trigger has no bounds");
      const session = await page.context().newCDPSession(page);
      try {
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await session.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [point],
        });
        await page.waitForTimeout(750);
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } finally {
        await session.detach().catch(() => undefined);
      }
      await page.waitForTimeout(400);
      menus = await visibleMatches(page.locator(".message_bubble_menu.second.me"));
    }
    if (menus.length > 1) throw new Error("multiple owned mobile message menus opened");
    if (menus.length === 1) return menus[0];
  }
  throw new Error("owned mobile message menu did not open");
}

async function evidencePresent(
  page: Page,
  artifact: TrackedArtifact,
): Promise<boolean> {
  const wrapper = exactOpenChatMessageWrapper(page, artifact.message);
  const count = await wrapper.count();
  if (count > 1) throw new Error(`${messageKey(artifact.message)}: wrapper became ambiguous`);
  if (count === 0) return false;
  if (artifact.evidence.kind === "card") {
    const cards = await wrapper.locator(".action-card").count();
    if (cards > 1) throw new Error(`${messageKey(artifact.message)}: card became ambiguous`);
    return cards === 1;
  }
  const exact = normalized(artifact.evidence.exactText);
  const texts = await renderedMessageTexts(wrapper);
  const matches = texts.filter((value) => normalized(value) === exact).length;
  if (matches > 1) throw new Error(`${messageKey(artifact.message)}: source text became ambiguous`);
  return matches === 1;
}

async function deleteExactArtifact(page: Page, artifact: TrackedArtifact): Promise<boolean> {
  if (!(await evidencePresent(page, artifact))) return false;
  const wrapper = exactOpenChatMessageWrapper(page, artifact.message);
  if (!(await senderOwned(wrapper))) {
    throw new Error(`${messageKey(artifact.message)}: artifact is no longer sender-owned`);
  }
  await dismissOverlay(page);
  if (await wrapper.evaluate((node) => node.classList.contains("message"))) {
    const bubble = wrapper.locator(".bubble-wrapper");
    if ((await bubble.count()) !== 1) throw new Error("classic artifact bubble is not unique");
    await bubble.hover();
    await (await exactlyOneVisible(bubble.locator(".menu-icon"), "classic message menu")).click({
      timeout: 10_000,
    });
  } else {
    const menu = await openOwnedMobileMenu(page, wrapper);
    await (await exactlyOneVisible(menu.locator(".menu-btn button"), "mobile more menu")).click({
      timeout: 10_000,
    });
  }

  if (
    (await visibleMatches(page.getByRole("menuitem", { name: "Delete for me", exact: true })))
      .length > 0
  ) {
    throw new Error(`${messageKey(artifact.message)}: refusing Delete for me`);
  }
  await (
    await exactlyOneVisible(
      page.getByRole("menuitem", { name: "Delete", exact: true }),
      "sender Delete menu item",
    )
  ).click({ timeout: 10_000 });

  const confirmation = page.getByRole("button", { name: "Yes please", exact: true });
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const matches = await visibleMatches(confirmation);
    if (matches.length > 1) throw new Error("multiple delete confirmations are visible");
    if (matches.length === 1) {
      await matches[0].click({ timeout: 10_000 });
      break;
    }
    if (!(await evidencePresent(page, artifact))) return true;
    await page.waitForTimeout(100);
  }
  const absentDeadline = Date.now() + 20_000;
  while (Date.now() < absentDeadline) {
    if (!(await evidencePresent(page, artifact))) return true;
    await page.waitForTimeout(250);
  }
  throw new Error(`${messageKey(artifact.message)}: evidence remained after deletion`);
}

export class OpenChatArtifactScope implements OpenChatArtifactCleaner {
  private baseline: OpenChatArtifactBaseline | undefined;
  private readonly expectations: OpenChatArtifactExpectation[] = [];
  private readonly tracked = new Map<string, TrackedArtifact>();

  constructor(
    private readonly page: Page,
    private readonly label: string,
  ) {}

  async begin(): Promise<void> {
    const wrappers = this.page.locator(MESSAGE_WRAPPER_SELECTOR);
    const ids: string[] = [];
    let maxMessageIndex = -1;
    const count = await wrappers.count();
    for (let index = 0; index < count; index++) {
      const wrapper = wrappers.nth(index);
      const id = await wrapper.getAttribute("data-id");
      const rawIndex = await wrapper.getAttribute("data-index");
      if (/^\d+$/.test(id ?? "") && /^\d+$/.test(rawIndex ?? "")) {
        ids.push(id!);
        maxMessageIndex = Math.max(maxMessageIndex, Number(rawIndex));
      }
    }
    this.baseline = { messageIds: ids, maxMessageIndex };
  }

  expectExactText(exactText: string): void {
    this.expectations.push({ kind: "text", exactText });
  }

  expectCardInputs(exactInputValues: string[]): void {
    this.expectations.push({ kind: "card_inputs", exactInputValues: [...exactInputValues] });
  }

  async waitForExactTextMessage(exactText: string): Promise<OpenChatMessageRef> {
    const selection = await this.resolveExpectation({ kind: "text", exactText });
    if (selection.error) throw new Error(`${this.label}: ${selection.error}`);
    if (selection.matches.length !== 1) {
      throw new Error(
        `${this.label}: expected one fresh sender-owned exact-text message, found ${selection.matches.length}`,
      );
    }
    return selection.matches[0].message;
  }

  async trackExactCard(card: Locator, exactInputValues: string[]): Promise<void> {
    const baseline = this.requireBaseline();
    const wrapper = card.locator(
      'xpath=ancestor::*[@data-id and @data-index and starts-with(@id,"event-")][1]',
    );
    const candidate = await readCandidate(wrapper);
    const selected = selectExactOpenChatArtifacts(baseline, [candidate], {
      kind: "card_inputs",
      exactInputValues,
    });
    if (selected.matches.length !== 1) {
      throw new Error(`${this.label}: exact card is not fresh, owned, and evidence-bound`);
    }
    this.trackCandidate(selected.matches[0], { kind: "card" });
  }

  async cleanup(): Promise<OpenChatArtifactCleanupReport> {
    const report: OpenChatArtifactCleanupReport = { deleted: [], errors: [] };
    if (!this.baseline) return report;
    for (const expectation of this.expectations) {
      try {
        const selection = await this.resolveExpectation(expectation);
        if (selection.error) {
          report.errors.push(`${this.label}: ${selection.error}`);
          continue;
        }
        for (const candidate of selection.matches) {
          this.trackCandidate(
            candidate,
            expectation.kind === "text"
              ? { kind: "text", exactText: expectation.exactText }
              : { kind: "card" },
          );
        }
      } catch (error) {
        report.errors.push(`${this.label}: artifact resolution failed: ${errorMessage(error)}`);
      }
    }

    const artifacts = [...this.tracked.values()].sort((left, right) =>
      left.evidence.kind === right.evidence.kind ? 0 : left.evidence.kind === "card" ? -1 : 1,
    );
    for (const artifact of artifacts) {
      try {
        if (await deleteExactArtifact(this.page, artifact)) report.deleted.push(artifact.message);
      } catch (error) {
        report.errors.push(
          `${this.label}: ${messageKey(artifact.message)} cleanup failed: ${errorMessage(error)}`,
        );
      }
    }

    if (report.deleted.length > 0) {
      try {
        await this.page.reload({ waitUntil: "domcontentloaded" });
        await this.page.waitForTimeout(1_000);
        for (const artifact of artifacts) {
          if (
            report.deleted.some(
              (deleted) => messageKey(deleted) === messageKey(artifact.message),
            ) &&
            (await evidencePresent(this.page, artifact))
          ) {
            report.errors.push(
              `${this.label}: ${messageKey(artifact.message)} deletion did not survive reload`,
            );
          }
        }
      } catch (error) {
        report.errors.push(`${this.label}: reload verification failed: ${errorMessage(error)}`);
      }
    }
    return report;
  }

  private requireBaseline(): OpenChatArtifactBaseline {
    if (!this.baseline) throw new Error(`${this.label}: cleanup baseline was not captured`);
    return this.baseline;
  }

  private async candidates(): Promise<OpenChatArtifactCandidate[]> {
    const wrappers = this.page.locator(MESSAGE_WRAPPER_SELECTOR);
    const result: OpenChatArtifactCandidate[] = [];
    const count = await wrappers.count();
    for (let index = 0; index < count; index++) {
      const wrapper = wrappers.nth(index);
      try {
        result.push(await readCandidate(wrapper));
      } catch {
        // A concurrently re-rendered wrapper is not safe cleanup evidence; skip it this pass.
      }
    }
    return result;
  }

  private async resolveExpectation(
    expectation: OpenChatArtifactExpectation,
  ): Promise<OpenChatArtifactSelection> {
    const baseline = this.requireBaseline();
    for (let attempt = 0; attempt < 12; attempt++) {
      const selection = selectExactOpenChatArtifacts(
        baseline,
        await this.candidates(),
        expectation,
      );
      if (selection.error || selection.matches.length > 0) return selection;
      await this.page.waitForTimeout(250);
    }
    // No artifact is a valid result: the operation may have failed before creating it.
    return { matches: [] };
  }

  private trackCandidate(
    candidate: OpenChatArtifactCandidate,
    evidence: TrackedArtifact["evidence"],
  ): void {
    const key = messageKey(candidate.message);
    const existing = this.tracked.get(key);
    // If the source text and card share one wrapper, exact text remains valid after a confirmed
    // card collapses or drops its iframe. Deleting that wrapper still removes the attached card.
    if (!existing || (existing.evidence.kind === "card" && evidence.kind === "text")) {
      this.tracked.set(key, { message: candidate.message, evidence });
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Cleanup failures fail an otherwise-passing harness, but never replace its original failure.
 * The caller must put tab closure in an outer finally around this function.
 */
export async function finalizeOpenChatArtifactCleanup(
  cleaner: OpenChatArtifactCleaner | undefined,
  primaryFailed: boolean,
  label: string,
): Promise<void> {
  if (!cleaner) return;
  let report: OpenChatArtifactCleanupReport;
  try {
    report = await cleaner.cleanup();
  } catch (error) {
    report = { deleted: [], errors: [`${label}: cleanup crashed: ${errorMessage(error)}`] };
  }
  if (report.deleted.length > 0) {
    console.log(`[cleanup] ${label}: deleted ${report.deleted.length} exact OpenChat artifact(s)`);
  }
  if (report.errors.length === 0) return;
  const failure = new Error(report.errors.join("; "));
  console.error(`[cleanup] ${failure.message}`);
  if (!primaryFailed) throw failure;
}
