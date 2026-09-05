// /openchat/card — the app-rendered confirmable card, under CI at last.
//
// Every assertion below was already WRITTEN, in three hand-run CDP harnesses (scripts/live/
// verify-card-fits.ts, verify-card-compact.ts, verify-card-type-row.ts). They were hand-run only
// because they were authored while chasing a live OpenChat bubble — nothing in them ever needed one.
// The card route is mounted OUTSIDE AuthedApp (src/app/App.tsx), so it has no session, touches no
// canister and reads no identity; it is driven entirely over postMessage; and the page's inbound
// guard (`event.source !== window.parent`) self-delivers when the page is opened top-level, because
// then `window.parent === window`. So the whole surface is reachable with a plain `page.goto` and a
// self-post — no sign-in, no replica, no OpenChat, no CDP.
//
// That mattered: the defects these guard (controls escaping a narrow frame, the Type/Template
// fields vanishing, the card growing back, and payload collection without a host click) were found BY HAND,
// twice, while `pnpm test` stayed green. jsdom cannot replace this — it has no layout engine and
// getBoundingClientRect returns zeros, so a component test passes happily with a button 69px outside
// the card.
//
// The numbers here are MEASURED, not guessed. Where one came from a harness, its provenance comment
// came with it.

import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    // Everything the card posted at us (it posts to window.parent, which is us).
    __ocMsgs?: {
      type?: string;
      version?: number;
      frameNonce?: string;
      requestNonce?: string;
      height?: number;
      payload?: unknown;
    }[];
    __ocHeights?: number[];
    __ocConfirm?: unknown;
  }
}

// ── the init payloads, carried over verbatim from the harnesses ──────────────────────────────────

/** Three bare entries — the shape verify-card-fits drove, and the widest button label ("Add all 3"). */
const MULTI_PLAIN = {
  entries: [
    { amount: 300, note: "uber" },
    { amount: 150, note: "food" },
    { amount: 500, note: "movies" },
  ],
};

/** One bare entry: the SINGLE-mode button row is a SEPARATE copy in the source, so it needs its own pass. */
const SINGLE_PLAIN = { amount: 300, note: "uber" };

/** A single entry routed to a saved type — the case that lost `kind` and `template` when IOU took over
 *  the pixels from OpenChat's classic table. */
const SINGLE_ROUTED = {
  kind: "iou",
  amount: 1000,
  currency: "EGP",
  template: "Reservation",
  direction: "credit",
  date: "2026-08-08",
  note: "deposit",
  message: "Reservation deposit 1000 EGP",
};

/** Three entries where only the FIRST was routed: the other two must gain nothing they never had. */
const MULTI_ROUTED = {
  entries: [
    { kind: "iou", amount: 1000, template: "Reservation", date: "2026-08-08", note: "deposit" },
    { amount: 150, date: "2026-08-09", note: "food" },
    { amount: 300, date: "2026-08-10", note: "fee" },
  ],
};

// ── driving the card ─────────────────────────────────────────────────────────────────────────────

/** Record the card's outbound bridge traffic from document start — the FIRST resize fires on mount,
 *  before any in-page evaluate could attach a listener. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__ocMsgs = [];
    window.__ocHeights = [];
    window.__ocConfirm = undefined;
    window.addEventListener("message", (e: MessageEvent) => {
      const m = e.data as {
        type?: string;
        version?: number;
        frameNonce?: string;
        requestNonce?: string;
        height?: number;
        payload?: unknown;
      };
      window.__ocMsgs!.push(m);
      if (m?.type === "oc:card:resize" && typeof m.height === "number") window.__ocHeights!.push(m.height);
      if (m?.type === "oc:card:confirm-collected") window.__ocConfirm = m.payload;
    });
  });
});

/** Protocol v2 is host-first: post a fresh bootstrap nonce and wait for the matching ready reply. */
const FRAME_NONCE = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI";
const ROTATED_FRAME_NONCE = "Q0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0M";
const COLLECT_NONCE = "REREREREREREREREREREREREREREREREREREREREREQ";

async function bootstrapCard(page: Page, frameNonce = FRAME_NONCE): Promise<void> {
  await expect
    .poll(async () => {
      await page.evaluate((nonce) => {
        window.postMessage(
          { type: "oc:card:bootstrap", version: 2, frameNonce: nonce },
          "*",
        );
      }, frameNonce);
      return page.evaluate(
        (nonce) =>
          (window.__ocMsgs ?? []).some(
            (m) =>
              m?.type === "oc:card:ready" &&
              m.version === 2 &&
              m.frameNonce === nonce,
          ),
        frameNonce,
      );
    })
    .toBe(true);
}

async function openCard(page: Page, frameNonce = FRAME_NONCE): Promise<void> {
  await page.goto("/openchat/card");
  await bootstrapCard(page, frameNonce);
}

type InitWireOverrides = {
  version?: number;
  frameNonce?: string | null;
};

/** Self-post an init, exactly as the host would. `parent === self` here, so the page accepts it. */
async function postInit(
  page: Page,
  data: unknown,
  readonly = false,
  overrides: InitWireOverrides = {},
): Promise<void> {
  const version = overrides.version ?? 2;
  const frameNonce =
    overrides.frameNonce === undefined ? FRAME_NONCE : overrides.frameNonce;
  await page.evaluate(
    ({ data, readonly, version, frameNonce }) => {
      const message: Record<string, unknown> = {
        type: "oc:card:init",
        version,
        data,
        context: {
          appId: 1,
          appRevision: 1n,
          actionId: "iou.entry.import",
          theme: "dark",
          readonly,
        },
      };
      if (frameNonce !== null) message.frameNonce = frameNonce;
      window.postMessage(
        message,
        "*",
      );
    },
    { data, readonly, version, frameNonce },
  );
}

async function flushBridgeMessages(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/** Wait until the card has actually rendered the init (never a sleep): a MULTI card is identified by
 *  its N amount fields, a SINGLE card by the amount landing in its one field. */
async function awaitRendered(page: Page, data: { entries?: unknown[] } & Record<string, unknown>) {
  if (Array.isArray(data.entries)) {
    await expect(page.getByLabel("Amount", { exact: true })).toHaveCount(data.entries.length);
  } else {
    await expect(page.getByLabel("Amount", { exact: true })).toHaveValue(String(data.amount));
  }
}

async function initCard(page: Page, data: Record<string, unknown>): Promise<void> {
  await openCard(page);
  await postInit(page, data);
  await awaitRendered(page, data);
}

// Credentialless fixtures have no viewer default currency. Complete missing required values
// through real user controls; never make collection tests depend on invented defaults.
async function completeRequiredFields(page: Page): Promise<void> {
  for (const select of await page.getByLabel("Type", { exact: true }).all()) {
    if (await select.inputValue() === "") await select.selectOption("iou");
  }
  for (const select of await page.getByLabel("Currency", { exact: true }).all()) {
    if (await select.inputValue() === "") await select.selectOption("EGP");
  }
}

for (const [name, overrides] of [
  ["v1", { version: 1 }],
  ["missing nonce", { frameNonce: null }],
  ["wrong nonce", { frameNonce: ROTATED_FRAME_NONCE }],
] as const) {
  test("bridge v2 fails closed for a " + name + " init", async ({ page }) => {
    await openCard(page);
    await postInit(page, SINGLE_PLAIN, false, overrides);
    await flushBridgeMessages(page);

    await expect(page.getByLabel("Amount", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add to IOU" })).toHaveCount(0);
  });
}

test("bridge v2 rotates the document nonce and rejects stale replay", async ({ page }) => {
  await openCard(page);
  await postInit(page, { amount: 111, note: "first" });
  await awaitRendered(page, { amount: 111 });

  await bootstrapCard(page, ROTATED_FRAME_NONCE);
  await expect(page.getByLabel("Amount", { exact: true })).toHaveCount(0);

  await postInit(page, { amount: 999, note: "stale" });
  await flushBridgeMessages(page);
  await expect(page.getByLabel("Amount", { exact: true })).toHaveCount(0);

  await postInit(
    page,
    { amount: 222, note: "rotated" },
    false,
    { frameNonce: ROTATED_FRAME_NONCE },
  );
  await awaitRendered(page, { amount: 222 });
});

test("bridge v2 never emits a payload without an exact host collection challenge", async ({ page }) => {
  await initCard(page, SINGLE_PLAIN);
  await page.evaluate(() => {
    window.postMessage(
      {
        type: "oc:card:collect-confirm",
        version: 2,
        frameNonce: "Q0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0M",
        requestNonce: "REREREREREREREREREREREREREREREREREREREREREQ",
      },
      "*",
    );
    window.postMessage(
      {
        type: "oc:card:confirm",
        version: 2,
        frameNonce: "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI",
        payload: { amount: 999 },
      },
      "*",
    );
  });
  await flushBridgeMessages(page);
  expect(await page.evaluate(() => window.__ocConfirm)).toBeUndefined();

  await completeRequiredFields(page);
  const payload = (await collectAndRead(page)) as Record<string, unknown>;
  expect(payload.amount).toBe(300);
  expect(
    await page.evaluate((requestNonce) =>
      (window.__ocMsgs ?? []).some(
        (message) =>
          message.type === "oc:card:confirm-collected" &&
          message.frameNonce === "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI" &&
          message.requestNonce === requestNonce,
      ),
      COLLECT_NONCE,
    ),
  ).toBe(true);
});

test("host busy freezes the edited values until exact-byte submission finishes", async ({ page }) => {
  await initCard(page, SINGLE_PLAIN);
  await page.evaluate(() => {
    window.postMessage(
      {
        type: "oc:card:busy",
        version: 2,
        frameNonce: "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI",
        busy: true,
      },
      "*",
    );
  });
  await expect
    .poll(() =>
      page
        .locator(".card input, .card select")
        .evaluateAll((controls) => controls.length > 0 && controls.every((control) => (control as HTMLInputElement).disabled)),
    )
    .toBe(true);
  await page.evaluate(() => {
    window.postMessage(
      {
        type: "oc:card:busy",
        version: 2,
        frameNonce: "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI",
        busy: false,
      },
      "*",
    );
  });
  await expect(page.getByLabel("Amount", { exact: true })).toBeEnabled();
});

test("missing Type/currency stay visibly empty and cannot be collected until explicitly chosen", async ({ page }) => {
  await initCard(page, SINGLE_PLAIN);
  await expect(page.getByLabel("Type", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Currency", { exact: true })).toHaveValue("");
  await page.evaluate(({ frameNonce, requestNonce }) => {
    window.postMessage({ type: "oc:card:collect-confirm", version: 2, frameNonce, requestNonce }, "*");
  }, { frameNonce: FRAME_NONCE, requestNonce: COLLECT_NONCE });
  await flushBridgeMessages(page);
  expect(await page.evaluate(() => window.__ocConfirm)).toBeUndefined();
  await expect(page.locator(".card")).toContainText("Check the amount, currency, Type, direction, and Note before adding.");
  await completeRequiredFields(page);
  const payload = (await collectAndRead(page)) as Record<string, unknown>;
  expect(payload).toMatchObject({ kind: "iou", currency: "EGP", amount: 300 });
});

// ── D3: editable controls stay inside the card; action controls stay host-owned ──────────────────

// The host sizes IOU's iframe `width: 420px; max-width: 100%`, so a mobile bubble can be much
// narrower. The iframe owns editable values only; Cancel/Add live in OpenChat's trusted host chrome.
const WIDTHS = [420, 300, 240, 200, 160];

/** Every editable control's offset inside the card's box, checking both edges. */
async function controlInsets(page: Page) {
  return page.evaluate(() => {
    const card = document.querySelector(".card") as HTMLElement | null;
    if (!card) return [];
    const cr = card.getBoundingClientRect();
    return [...card.querySelectorAll("input, select")]
      .filter((control) => (control as HTMLElement).offsetParent !== null)
      .map((control) => {
        const r = control.getBoundingClientRect();
        return {
          label: control.getAttribute("aria-label") ?? control.tagName,
          leftInset: r.left - cr.left,
          rightInset: cr.right - r.right,
        };
      });
  });
}

function expectAllInside(insets: { label: string; leftInset: number; rightInset: number }[], where: string) {
  expect(insets.length, `${where}: no editable controls found — the card did not render`).toBeGreaterThan(0);
  for (const control of insets) {
    // Half a pixel of slack for sub-pixel layout; a real escape is tens of pixels.
    expect(control.leftInset, `${where}: "${control.label}" escapes the card's LEFT edge`).toBeGreaterThanOrEqual(-0.5);
    expect(control.rightInset, `${where}: "${control.label}" escapes the card's RIGHT edge`).toBeGreaterThanOrEqual(-0.5);
  }
}

for (const mode of ["single", "multi"] as const) {
  const data = mode === "single" ? SINGLE_PLAIN : MULTI_PLAIN;
  test(`D3 ${mode}: fields stay inside the card and no iframe action button exists`, async ({ page }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await initCard(page, data);

      expectAllInside(await controlInsets(page), `${width}px`);
      await expect(page.locator(".card").getByRole("button")).toHaveCount(0);
    }
  });
}

// ── D4: iframe presentation stays compact and explanation-free ───────────────────────────────────

for (const mode of ["single", "multi"] as const) {
  const data = mode === "single" ? SINGLE_PLAIN : MULTI_PLAIN;
  // The tags section was deleted in fde1f36 and nothing anywhere pinned its absence, so a re-added
  // control would compile and ship green. It is one line to keep it gone.
  test(`D4 ${mode}: the card carries no tags control`, async ({ page }) => {
    await initCard(page, data);
    await expect(page.getByLabel(/tag/i)).toHaveCount(0);
    expect(await page.locator(".card").innerText()).not.toMatch(/tags/i);
  });

  test(`D4 ${mode}: the card shows values without explanatory copy`, async ({ page }) => {
    await initCard(page, data);

    await expect(page.locator(".card")).not.toContainText(/Review and edit|before adding to your ledger/i);
  });
}

// ── D12: smaller, but still tappable ─────────────────────────────────────────────────────────────

// The two halves pull against each other, so they are asserted TOGETHER and cannot be traded off:
// shrinking the type and the padding alone would drag the hit areas down with them (8px padding on a
// 0.875rem font is a ~33px control). `minHeight: TOUCH_TARGET` pins every interactive control at 44px
// — the WCAG 2.5.5 / Apple HIG target — while the font and the gaps do the shrinking.
const TOUCH_TARGET = 44;

// Measured on the PREVIOUS build (read-only meta line, 1rem type, 12px gaps) at a 420px viewport, plus
// a little headroom: the new card must stay under these while carrying MORE controls. Today it comes
// in at 379 / 924. They are ceilings at 420px ONLY — the frame width the host prefers. A narrower
// bubble legitimately wraps taller (609 / 1594 at 240px), which is a layout fact, not a regression.
const HEIGHT_CEILING = { single: 460, multi: 1080 };

/** The smallest interactive control on the card, and the height the card last ASKED the host for. */
async function cardMetrics(page: Page) {
  return page.evaluate(() => {
    const card = document.querySelector(".card") as HTMLElement;
    const controls = [...card.querySelectorAll("input, select, button")] as HTMLElement[];
    const heights = controls.map((c) => c.getBoundingClientRect().height);
    // The element the ResizeObserver watches is the card's parent (the page root).
    const root = card.parentElement as HTMLElement;
    return {
      minControl: heights.length ? Math.min(...heights) : 0,
      controlCount: controls.length,
      measuredRoot: Math.ceil(root.getBoundingClientRect().height),
      lastResize: window.__ocHeights?.[window.__ocHeights.length - 1] ?? 0,
    };
  });
}

for (const mode of ["single", "multi"] as const) {
  const data = mode === "single" ? SINGLE_ROUTED : MULTI_ROUTED;
  test(`D12 ${mode}: compact enough, tappable everywhere`, async ({ page }) => {
    for (const width of [420, 240]) {
      await page.setViewportSize({ width, height: 900 });
      await initCard(page, data);
      await completeRequiredFields(page);

      // The observer is async; wait until the reported height has caught up with the real one, which
      // also proves the bridge is REPORTING (a dead ResizeObserver must not pass by saying nothing).
      await expect
        .poll(async () => {
          const m = await cardMetrics(page);
          return m.lastResize === m.measuredRoot ? m.lastResize : -1;
        })
        .toBeGreaterThan(0);

      const m = await cardMetrics(page);
      expect(m.controlCount, `${width}px: the card rendered no controls`).toBeGreaterThan(0);
      expect(
        m.minControl,
        `${width}px: a control shrank below the ${TOUCH_TARGET}px touch target`,
      ).toBeGreaterThanOrEqual(TOUCH_TARGET);

      if (width === 420) {
        expect(m.lastResize, `the card grew back past its ${mode} baseline`).toBeLessThanOrEqual(
          HEIGHT_CEILING[mode],
        );
      }
    }
  });
}

// ── D8: public transaction vs viewer-authorized private account type ──────────────────────────────

// Transaction Type and Date are public. Saved account-type names are private and must appear only after the
// viewer-approved private-context exchange; an untrusted plaintext template in init is ignored.
// These top-level browser cases pin the public/no-private-context half. The authorized roster/render
// half is covered by OpenChatCardPage.test.ts and the cryptographic handoff suites.
async function cardTypeFields(page: Page) {
  const types = await page
    .getByLabel("Type", { exact: true })
    .evaluateAll((els) => els.map((e) => (e as HTMLSelectElement).value));
  const savedTypes = await page
    .getByLabel("Saved type", { exact: true })
    .evaluateAll((els) => els.map((e) => (e as HTMLSelectElement).value));
  const dates = await page
    .getByLabel("Date", { exact: true })
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  return { types, savedTypes, dates };
}

async function collectAndRead(page: Page) {
  await page.evaluate((nonce) => {
    window.__ocConfirm = undefined;
    window.postMessage(
      {
        type: "oc:card:collect-confirm",
        version: 2,
        frameNonce: "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI",
        requestNonce: nonce,
      },
      "*",
    );
  }, COLLECT_NONCE);
  await page.waitForFunction(() => window.__ocConfirm !== undefined);
  return page.evaluate(() => window.__ocConfirm);
}

test("D8 single: public Type and Date stay visible while plaintext saved Type stays private", async ({ page }) => {
  await initCard(page, SINGLE_ROUTED);

  await expect(page.getByLabel("Type", { exact: true })).toHaveValue("iou");
  await expect(page.getByLabel("Date", { exact: true })).toHaveValue("2026-08-08");
  await expect(page.getByLabel("Saved type", { exact: true })).toHaveValue("");
  await expect(page.locator(".card")).not.toContainText("Reservation");

  const payload = (await collectAndRead(page)) as Record<string, unknown>;
  expect(payload.kind).toBe("iou");
  expect(payload.date).toBe("2026-08-08");
  expect("template" in payload).toBe(false);
  expect("template_ref" in payload).toBe(false);
});

test("D8 single: public Type and Date edits reach the payload without a private type leak", async ({ page }) => {
  await initCard(page, SINGLE_ROUTED);

  await page.getByLabel("Type", { exact: true }).selectOption("settlement");
  await page.getByLabel("Date", { exact: true }).fill("2026-08-11");
  await expect(page.getByLabel("Saved type", { exact: true })).toHaveValue("");

  const payload = (await collectAndRead(page)) as Record<string, unknown>;
  expect(payload.kind).toBe("settlement");
  expect(payload.date).toBe("2026-08-11");
  expect("template" in payload).toBe(false);
  expect("template_ref" in payload).toBe(false);
});

test("D8 single: no private roster means Saved type starts empty and adds nothing", async ({ page }) => {
  await initCard(page, { amount: 50, direction: "debt", note: "coffee", message: "coffee 50" });

  const { savedTypes } = await cardTypeFields(page);
  expect(savedTypes[0]).toBe("");

  await completeRequiredFields(page);
  const payload = (await collectAndRead(page)) as Record<string, unknown>;
  expect("template" in payload).toBe(false);
  expect("template_ref" in payload).toBe(false);
});

test("D8 multi: public Type and Date stay row-local and plaintext saved Types stay private", async ({ page }) => {
  await initCard(page, MULTI_ROUTED);

  const { types, savedTypes, dates } = await cardTypeFields(page);
  expect(types).toEqual(["iou", "", ""]);
  expect(savedTypes).toEqual(["", "", ""]);
  expect(dates).toEqual(["2026-08-08", "2026-08-09", "2026-08-10"]);
  await expect(page.locator(".card")).not.toContainText("Reservation");

  await completeRequiredFields(page);
  const rows = (await collectAndRead(page)) as Record<string, unknown>[];
  expect(Array.isArray(rows)).toBe(true);
  expect(rows).toHaveLength(3);
  // Missing public Types were visibly empty above and became valid only after the explicit choices.
  expect(rows.map((row) => row.kind)).toEqual(["iou", "iou", "iou"]);
  expect(rows.map((row) => row.date)).toEqual(["2026-08-08", "2026-08-09", "2026-08-10"]);
  expect(rows.every((row) => !("template" in row) && !("template_ref" in row))).toBe(true);
});

test("D8 multi: a host-supplied plaintext type is never offered to another row", async ({ page }) => {
  await initCard(page, MULTI_ROUTED);

  const options = await page
    .getByLabel("Saved type", { exact: true })
    .evaluateAll((selects) =>
      selects.map((select) =>
        [...(select as HTMLSelectElement).options].map((option) => option.text),
      ),
  );
  expect(options).toEqual([["None"], ["None"], ["None"]]);

  await completeRequiredFields(page);
  const rows = (await collectAndRead(page)) as Record<string, unknown>[];
  expect(rows.every((row) => !("template" in row) && !("template_ref" in row))).toBe(true);
});

test("D8 readonly: public Type and Date remain visible without exposing an unshared saved Type", async ({ page }) => {
  await openCard(page);
  await postInit(page, SINGLE_ROUTED, true);
  await expect(page.locator(".card")).not.toContainText("View only");
  await expect(page.locator(".card").getByRole("button")).toHaveCount(0);

  await expect(page.locator(".card")).toContainText("Type");
  await expect(page.locator(".card")).toContainText("IOU");
  await expect(page.locator(".card")).toContainText("Date");
  await expect(page.locator(".card")).toContainText("2026-08-08");
  await expect(page.locator(".card")).not.toContainText("Saved type");
  await expect(page.locator(".card")).not.toContainText("Reservation");
});
