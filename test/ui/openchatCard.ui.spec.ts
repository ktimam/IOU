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
// That mattered: the four defects these guard (buttons escaping a narrow frame, Cancel leaving "Add"
// on screen, the Type/Template fields vanishing, the card growing back) were all found BY HAND,
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
    __ocMsgs?: { type?: string; height?: number; payload?: unknown }[];
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
  note: "deposit",
  message: "Reservation deposit 1000 EGP",
};

/** Three entries where only the FIRST was routed: the other two must gain nothing they never had. */
const MULTI_ROUTED = {
  entries: [
    { kind: "iou", amount: 1000, template: "Reservation", note: "deposit" },
    { amount: 150, note: "food" },
    { amount: 300, note: "fee" },
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
      const m = e.data as { type?: string; height?: number; payload?: unknown };
      window.__ocMsgs!.push(m);
      if (m?.type === "oc:card:resize" && typeof m.height === "number") window.__ocHeights!.push(m.height);
      if (m?.type === "oc:card:confirm") window.__ocConfirm = m.payload;
    });
  });
});

/** Load the card and wait for `oc:card:ready`, which is posted from the same effect that installs the
 *  page's own message listener — so it is the exact moment an init can land, with no sleep. */
async function openCard(page: Page): Promise<void> {
  await page.goto("/openchat/card");
  await page.waitForFunction(() => (window.__ocMsgs ?? []).some((m) => m?.type === "oc:card:ready"));
}

/** Self-post an init, exactly as the host would. `parent === self` here, so the page accepts it. */
async function postInit(page: Page, data: unknown, readonly = false): Promise<void> {
  await page.evaluate(
    ({ data, readonly }) => {
      window.postMessage(
        { type: "oc:card:init", version: 1, data, context: { theme: "dark", readonly } },
        "*",
      );
    },
    { data, readonly },
  );
}

/** Wait until the card has actually rendered the init (never a sleep): a MULTI card is identified by
 *  its "Add all N entries" button, a SINGLE card by the amount landing in the field. */
async function awaitRendered(page: Page, data: { entries?: unknown[] } & Record<string, unknown>) {
  if (Array.isArray(data.entries)) {
    await expect(page.getByRole("button", { name: `Add all ${data.entries.length} entries` })).toBeVisible();
  } else {
    await expect(page.getByLabel("Amount", { exact: true })).toHaveValue(String(data.amount));
  }
}

async function initCard(page: Page, data: Record<string, unknown>): Promise<void> {
  await openCard(page);
  await postInit(page, data);
  await awaitRendered(page, data);
}

// ── D3: the buttons stay inside the card, at every width, in every phase ─────────────────────────

// The host sizes IOU's iframe `width: 420px; max-width: 100%`, so in a narrow bubble the frame is far
// below its preference — a v2/mobile bubble measured ~250px. A flex row cannot shrink a button below
// its own text, and the row is `justify-content: flex-end`, so the excess overflows the START edge:
// the buttons slide out of the card to the LEFT, where scrollWidth cannot even see them (which is why
// this kept being reported as "outside the window" while every scroll metric looked clean). Measured
// before the fix: 69px outside at a 240px frame.
const WIDTHS = [420, 300, 240, 200, 160];

/** Every button's offset inside the CARD's box. verify-card-fits measured `row.left - btn.left` only,
 *  so a button overflowing the RIGHT edge — or overflowing `.card` while sitting inside its row —
 *  scored a clean zero there. Both edges, against the card, is the assertion that actually holds. */
async function buttonInsets(page: Page) {
  return page.evaluate(() => {
    const card = document.querySelector(".card") as HTMLElement | null;
    if (!card) return [];
    const cr = card.getBoundingClientRect();
    return [...card.querySelectorAll("button")]
      .filter((b) => (b as HTMLElement).offsetParent !== null)
      .map((b) => {
        const r = b.getBoundingClientRect();
        return {
          label: (b as HTMLElement).innerText.trim().slice(0, 24),
          leftInset: r.left - cr.left,
          rightInset: cr.right - r.right,
        };
      });
  });
}

function expectAllInside(insets: { label: string; leftInset: number; rightInset: number }[], where: string) {
  expect(insets.length, `${where}: no buttons found — the card did not render`).toBeGreaterThan(0);
  for (const b of insets) {
    // Half a pixel of slack for sub-pixel layout; a real escape is tens of pixels.
    expect(b.leftInset, `${where}: "${b.label}" escapes the card's LEFT edge`).toBeGreaterThanOrEqual(-0.5);
    expect(b.rightInset, `${where}: "${b.label}" escapes the card's RIGHT edge`).toBeGreaterThanOrEqual(-0.5);
  }
}

for (const mode of ["single", "multi"] as const) {
  const data = mode === "single" ? SINGLE_PLAIN : MULTI_PLAIN;
  test(`D3 ${mode}: buttons stay inside the card at every width, idle and cancelling`, async ({ page }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await initCard(page, data);

      expectAllInside(await buttonInsets(page), `${width}px idle`);

      // Cancelling is the WIDEST state: it is the one label that GROWS ("Cancel" → spinner +
      // "Cancelling…") where confirm shrinks to "Adding…". No oc:card:busy is ever posted back, so
      // the phase sticks and can be measured at leisure.
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByText("Cancelling…")).toBeVisible();
      expectAllInside(await buttonInsets(page), `${width}px cancelling`);
    }
  });
}

// ── D4: pressing Cancel takes "Add" off the card ─────────────────────────────────────────────────

// Offering "Add" after the user pressed Cancel is misleading — the action is already decided — and
// dropping it is also what keeps the widest state inside a narrow frame (one button, not two).
// The button block is DUPLICATED in the source (once for MULTI, once for SINGLE), so a fix applied to
// one branch only is a live regression; both are driven here.
for (const mode of ["single", "multi"] as const) {
  const data = mode === "single" ? SINGLE_PLAIN : MULTI_PLAIN;
  const addName = mode === "single" ? "Add to IOU" : "Add all 3 entries";
  test(`D4 ${mode}: Cancel hides the Add button and shows Cancelling…`, async ({ page }) => {
    await initCard(page, data);
    await expect(page.getByRole("button", { name: addName })).toBeVisible();

    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await expect(page.getByRole("button", { name: /^Add (to IOU|all)/ })).toHaveCount(0);
    await expect(page.getByText("Cancelling…")).toBeVisible();
  });

  // The tags section was deleted in fde1f36 and nothing anywhere pinned its absence, so a re-added
  // control would compile and ship green. It is one line to keep it gone.
  test(`D4 ${mode}: the card carries no tags control`, async ({ page }) => {
    await initCard(page, data);
    await expect(page.getByLabel(/tag/i)).toHaveCount(0);
    expect(await page.locator(".card").innerText()).not.toMatch(/tags/i);
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

// ── D8: the Type and Template fields render, and survive confirm ─────────────────────────────────

// Both were DECLARED card rows that OpenChat's classic table used to draw (docs/openchat-registration
// .json: {"label":"Type","valueKey":"kind"} and {"label":"Template","valueKey":"template"}). The
// iframe replaced that table wholesale and IOU's own card never rendered either, so they vanished the
// day the app took over the pixels. The type is the half that MATTERS: the confirm payload REPLACES
// the stored extraction rather than merging with it, so a field the card drops is destroyed —
// SheetPage's resolveTemplateBase looks `template` up by name to seed the fee %, due schedule and
// default currency/note/direction, and dropping it meant every chat import silently landed without
// them. The PAYLOAD half is covered by cardBridge.test.ts; the RENDER half is only visible here.

/** Read Type/Template by LABEL, never by index: Template and Note are both type="text", so a
 *  positional selector silently edits the wrong field (it did, on the harness's first run). And they
 *  are EDITABLE, so what they show lives in a control's value, not in innerText. */
async function typeFields(page: Page) {
  const kinds = await page
    .getByLabel("Type", { exact: true })
    .evaluateAll((els) => els.map((e) => (e as HTMLSelectElement).value));
  const templates = await page
    .getByLabel("Template", { exact: true })
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  return { kinds, templates };
}

async function confirmAndRead(page: Page, name: RegExp | string) {
  await page.getByRole("button", { name }).click();
  await page.waitForFunction(() => window.__ocConfirm !== undefined);
  return page.evaluate(() => window.__ocConfirm);
}

test("D8 single: the routed Type and Template are shown, and survive confirm", async ({ page }) => {
  await initCard(page, SINGLE_ROUTED);

  await expect(page.getByLabel("Type", { exact: true })).toHaveValue("iou");
  await expect(page.getByLabel("Template", { exact: true })).toHaveValue("Reservation");

  const payload = (await confirmAndRead(page, "Add to IOU")) as { kind?: string; template?: string };
  expect(payload.kind).toBe("iou");
  expect(payload.template).toBe("Reservation");
});

test("D8 single: edits to Type and Template reach the payload", async ({ page }) => {
  await initCard(page, SINGLE_ROUTED);

  await page.getByLabel("Type", { exact: true }).selectOption("settlement");
  await page.getByLabel("Template", { exact: true }).fill("Manager expense");

  const payload = (await confirmAndRead(page, "Add to IOU")) as { kind?: string; template?: string };
  expect(payload.kind).toBe("settlement");
  expect(payload.template).toBe("Manager expense");
});

test("D8 single: no type routed → the Template field starts empty and adds nothing", async ({ page }) => {
  await initCard(page, { amount: 50, direction: "debt", note: "coffee", message: "coffee 50" });

  // The field is always present now that it is editable, so the guarantee moved: it must start EMPTY
  // and contribute nothing, rather than be absent.
  const { templates } = await typeFields(page);
  expect(templates[0]).toBe("");

  const payload = (await confirmAndRead(page, "Add to IOU")) as Record<string, unknown>;
  expect("template" in payload).toBe(false);
});

test("D8 multi: each row keeps its OWN type", async ({ page }) => {
  await initCard(page, MULTI_ROUTED);

  const { templates } = await typeFields(page);
  expect(templates[0]).toBe("Reservation");
  expect(templates[1]).toBe("");
  expect(templates[2]).toBe("");

  const rows = (await confirmAndRead(page, "Add all 3 entries")) as { template?: string }[];
  expect(Array.isArray(rows)).toBe(true);
  expect(rows).toHaveLength(3);
  expect(rows[0].template).toBe("Reservation");
  expect(rows[1].template).toBeUndefined();
  expect(rows[2].template).toBeUndefined();
});

test("D8 multi: the routed type is offered to the rows that lack one", async ({ page }) => {
  await initCard(page, MULTI_ROUTED);

  // The account's saved-type roster is unreachable from this frame (it is an AES-GCM blob under the
  // sheet key, and the frame is storage-partitioned with no session), so the only suggestions the card
  // can offer are the names it already carries. A message that routed ONE entry usually wants its
  // siblings on the same type, and copying it should not mean retyping it.
  const suggestions = await page.evaluate(() =>
    [...document.querySelectorAll("datalist option")].map((o) => (o as HTMLOptionElement).value),
  );
  expect(suggestions).toContain("Reservation");

  await page.getByLabel("Template", { exact: true }).nth(1).fill("Reservation");
  const rows = (await confirmAndRead(page, "Add all 3 entries")) as { template?: string }[];
  expect(rows[0].template).toBe("Reservation");
  expect(rows[1].template).toBe("Reservation");
  expect(rows[2].template).toBeUndefined(); // an untouched row gains nothing
});

test("D8 readonly: a consumed card still names its Type and Template", async ({ page }) => {
  // ReadonlyView is a wholly separate code path — it re-lists the rows itself, so dropping Type or
  // Template there would be invisible to every assertion above.
  await openCard(page);
  await postInit(page, SINGLE_ROUTED, true);
  await expect(page.locator(".card")).toContainText("View only");

  await expect(page.locator(".card")).toContainText("Type");
  await expect(page.locator(".card")).toContainText("Template");
  await expect(page.locator(".card")).toContainText("Reservation");
});
