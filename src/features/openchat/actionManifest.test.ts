import { describe, it, expect } from "vitest";
import {
  iouActionManifest,
  renderManifestJson,
  IOU_EXTRACTION_PROMPT,
  buildIouRules,
  buildIouOutputSchema,
} from "./actionManifest";
import { parseDraft } from "../entries/draft";
import registration from "../../../docs/openchat-registration.json";

describe("template routing", () => {
  const templates = [
    { id: "z9-abc123", name: "Reservation", keywords: ["reservation", "booking"] },
    { id: "y8-def456", name: "No Triggers", keywords: [] },
  ];

  it("routes by template NAME (not id) so it reads on the action card", () => {
    const rules = buildIouRules(templates);
    const km = rules.find((r) => r.kind === "keyword_map" && r.field === "template");
    expect(km, "a keyword_map on the `template` field").toBeDefined();
    if (km && km.kind === "keyword_map") {
      // The trigger-word-bearing template routes; its VALUE is the human name, and the keyword-less
      // one is omitted (nothing to route).
      expect(km.map).toEqual([{ value: "Reservation", keywords: ["reservation", "booking"] }]);
    }
  });

  it("folds every account's types into one per-USER manifest by design; containment is resolveTemplateBase", () => {
    // The user's report: "Reservation is proposed in the child chat despite that there is no
    // Reservation type in the linked account." This is that, pinned rather than fixed.
    //
    // OpenChat registers ONE manifest per app+user and has no per-chat rule set, so
    // ManifestTypesSync folds loadAllSharedTemplates — EVERY account the user is in — into a single
    // roster (ManifestTypesSync.tsx, via loadAllSharedTemplates). House's "Reservation" therefore
    // routes deterministically in the child chat, and always will until a chat→account gate exists
    // at propose time. What stops that from doing damage is IMPORT-side containment: a name this
    // account does not own seeds no fee, no schedule, no currency (resolveTemplateBase.test.ts).
    //
    // Pinned here so that adding scoping is a deliberate edit to this test, not a silent drift.
    const twoAccounts = [
      { id: "house-1", name: "Reservation", keywords: ["reservation", "booking"] }, // House account
      { id: "child-1", name: "Allowance", keywords: ["allowance"] }, // the child account
    ];
    const rules = buildIouRules(twoAccounts);
    const km = rules.find((r) => r.kind === "keyword_map" && r.field === "template");
    expect(km && km.kind === "keyword_map" && km.map.map((m) => m.value)).toEqual([
      "Reservation",
      "Allowance",
    ]);
    // The image/vision path skips the keyword_map post-pass and picks from the roster instruction,
    // so the leak is the same size there. (Which name the MODEL picks is not deterministic and is
    // deliberately not asserted — only the offered roster and the keyword post-pass are.)
    const roster = rules.find((r) => r.kind === "instruction" && /saved types/.test(r.text));
    expect(roster && roster.kind === "instruction" && roster.text).toContain("Reservation");
    expect(roster && roster.kind === "instruction" && roster.text).toContain("Allowance");
  });

  it("advertises the `template` field in the schema only when something is routable", () => {
    expect((buildIouOutputSchema(templates).properties as Record<string, unknown>).template).toEqual({
      type: "string",
    });
    // No routable templates -> no `template` property (nothing would ever set it).
    expect(
      (buildIouOutputSchema([{ id: "x", name: "X", keywords: [] }]).properties as Record<string, unknown>)
        .template,
    ).toBeUndefined();
  });
});

describe("invalid-draft guardrails (schema ↔ parseDraft lock-step)", () => {
  // Live-reproduced 2026-07-22: the on-device model turned the message "hi" into
  // {"kind":"settlement","amount":0,"currency":"USD","note":"hi"}; OpenChat posted+deposited it and
  // IOU could only render "invalid draft". The registered schema must DECLARE what parseDraft
  // enforces so OpenChat's post-generation schema check drops such extractions (no_extraction)
  // before a card ever posts.

  it("schema requires amount but NOT currency (currency defaults to the user's IOU setting)", () => {
    // amount is unrecoverable → required (a degenerate amount-0/absent extraction must be dropped).
    // currency IS recoverable: IOU fills a missing currency from prefs.defaultCurrency on import
    // (baseWithDefaultCurrency), so requiring it would wrongly BLOCK a no-currency message at the
    // OpenChat gate before IOU can default it (live 2026-07-23: "paid 120 for groceries" → no card).
    const required = iouActionManifest.outputSchema.required as string[];
    expect(required).toContain("amount");
    expect(required).not.toContain("currency");
    // The template-enriched schema (the one actually registered) carries the same requirement.
    expect(buildIouOutputSchema([]).required as string[]).toContain("amount");
    expect(buildIouOutputSchema([]).required as string[]).not.toContain("currency");
  });

  it("schema declares amount > 0 via draft-07 numeric exclusiveMinimum", () => {
    const amount = (iouActionManifest.outputSchema.properties as Record<string, unknown>)
      .amount as Record<string, unknown>;
    expect(amount.type).toBe("number");
    expect(amount.exclusiveMinimum).toBe(0);
    // Survives the deep clone into the registered (template-enriched) schema too.
    const enriched = (buildIouOutputSchema([]).properties as Record<string, unknown>)
      .amount as Record<string, unknown>;
    expect(enriched.exclusiveMinimum).toBe(0);
  });

  it("parseDraft rejects a draft missing amount or with amount 0 (the manifest constraints are real)", () => {
    // Exactly the live "hi" extraction: amount 0 must NOT parse.
    const zero = parseDraft({ kind: "settlement", amount: 0, currency: "USD", note: "hi" });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.errors[0]).toMatch(/amount/i);
    // Missing amount must NOT parse either (schema `required` mirrors this).
    const missing = parseDraft({ kind: "settlement", currency: "USD", note: "hi" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.join(" ")).toMatch(/amount/i);
    // Negative amounts are equally out (exclusiveMinimum, not minimum).
    expect(parseDraft({ amount: -5, currency: "USD" }).ok).toBe(false);
  });
});

describe("iouActionManifest", () => {
  it("declares an output the IOU draft parser accepts", () => {
    // A sample draft shaped exactly per the manifest's outputSchema.
    const sample = {
      kind: "settlement",
      amount: 42.5,
      currency: "USD",
      direction: "credit",
      date: "2026-06-24",
      note: "dinner",
    };
    const r = parseDraft(sample);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.initial.amount_minor).toBe(4250);
      expect(r.value.initial.direction).toBe("credit");
    }
  });

  it("card direction labels cover exactly the parser's directions", () => {
    expect(Object.keys(iouActionManifest.card.directionLabels).sort()).toEqual(["credit", "debt"]);
    // both directions parse
    expect(parseDraft({ amount: 1, currency: "USD", direction: "credit" }).ok).toBe(true);
    expect(parseDraft({ amount: 1, currency: "USD", direction: "debt" }).ok).toBe(true);
  });

  it("forwards to the relay's OpenChat ingestion path with provenance auth", () => {
    expect(iouActionManifest.callback.path).toBe("/v1/openchat/drafts");
    expect(iouActionManifest.callback.auth).toBe("openchat-provenance");
  });

  it("renders valid JSON carrying the extraction prompt", () => {
    const json = renderManifestJson();
    const parsed = JSON.parse(json);
    expect(parsed.id).toBe("iou.entry.import");
    expect(parsed.prompt).toBe(IOU_EXTRACTION_PROMPT);
  });

  it("prompt instructs a JSON ARRAY for multiple transactions, a single object otherwise", () => {
    // Issue 2: one card can carry several entries; the model must emit an array when the message
    // describes multiple distinct transactions. The schema still validates a single object shape —
    // OpenChat validates each array element against it (see the schema tests above).
    expect(IOU_EXTRACTION_PROMPT).toMatch(/array/i);
    expect(IOU_EXTRACTION_PROMPT).toMatch(/multiple/i);
    // The single-object path stays the default (backward compatible).
    expect(IOU_EXTRACTION_PROMPT).toMatch(/single/i);
  });

  it("declares a chat_link surface pointing at the /openchat/link-chat page", () => {
    const s = iouActionManifest.surfaces.find((x) => x.kind === "chat_link");
    expect(s).toBeDefined();
    // External so the linking page runs first-party (its own IOU session/sheets); an embedded
    // iframe would be storage-partitioned by the OpenChat host origin.
    expect(s!.display).toBe("external");
    // Absolute origin (resolvable at registration time) + the app route + the {chatKey}
    // placeholder OpenChat substitutes with the canonical chat key.
    expect(s!.url).toMatch(/^https?:\/\/[^/]+\/openchat\/link-chat\?chat=\{chatKey\}$/);
  });

  it("declares a connect surface pointing at the pairing-code entry anchor", () => {
    const s = iouActionManifest.surfaces.find((x) => x.kind === "connect");
    expect(s).toBeDefined();
    // Same first-party reasoning as chat_link: the code entry needs the user's signed-in session.
    expect(s!.display).toBe("external");
    // The #openchat-connect hash scrolls to / focuses the code input in ActionInboxSettings.
    expect(s!.url).toMatch(/^https?:\/\/[^/]+\/settings#openchat-connect$/);
  });

  it("declares a home surface (the app's webpage, embedded in OpenChat)", () => {
    const s = iouActionManifest.surfaces.find((x) => x.kind === "home");
    expect(s).toBeDefined();
    // Embedded in OpenChat's in-window browser; needs no session (shows the landing state).
    expect(s!.display).toBe("sheet");
    expect(s!.url).toMatch(/^https?:\/\/[^/]+$/);
  });

  it("declares a card surface (IOU's app-rendered confirmable card, embedded in the chat bubble)", () => {
    const s = iouActionManifest.surfaces.find((x) => x.kind === "card");
    expect(s).toBeDefined();
    // Embedded (display "sheet") — the card renderer is storage-partitioned but needs no session;
    // it only renders + collects over the postMessage bridge (fork-notes/08-app-rendered-cards.md).
    expect(s!.display).toBe("sheet");
    // Absolute origin (resolvable at registration time) + the /openchat/card renderer route.
    expect(s!.url).toMatch(/^https?:\/\/[^/]+\/openchat\/card$/);
  });

  it("surface URL parses once the placeholder is substituted", () => {
    const s = iouActionManifest.surfaces.find((x) => x.kind === "chat_link")!;
    const substituted = s.url.replace("{chatKey}", "group:aaaaa-aa");
    const url = new URL(substituted);
    expect(url.pathname).toBe("/openchat/link-chat");
    expect(url.searchParams.get("chat")).toBe("group:aaaaa-aa");
  });
});

// The wire is assembled from TWO sources that no single script keeps in step: the rules and the
// response schema are regenerated into docs/openchat-registration.json by
// scripts/gen-openchat-registration.ts, but `card.rows` is HAND-EDITED there and left untouched by
// that script (registerAiApp.ts reads the rows straight from the paste JSON). So a `from_message`
// rule can silently lose the schema property or the card row it depends on, and nothing would fail.
//
// That matters because of how the evidence reaches a RECEIVED card: reverseMapRows rebuilds the
// extraction from the card's visible rows, so a field with no row simply is not there for the
// partner — currency verification and date recovery would quietly fall back. This is the invariant
// that catches it.
describe("registered wire — every from_message field survives to the card", () => {
  it("declares each from_message field in BOTH the response schema and the card rows", async () => {
    const { buildManifestWire } = await import("./registerAiApp");
    const wire = buildManifestWire("") as unknown as {
      actions: { response_schema: string; rules: unknown[]; card: { rows: { field: string; label: string }[] } }[];
    };
    const action = wire.actions[0];
    const schema = JSON.parse(action.response_schema) as { properties?: Record<string, unknown> };
    const fromMessageFields = buildIouRules([])
      .filter((r): r is Extract<typeof r, { kind: "from_message" }> => r.kind === "from_message")
      .map((r) => r.field);

    expect(fromMessageFields.length).toBeGreaterThan(0);
    for (const field of fromMessageFields) {
      expect(Object.keys(schema.properties ?? {})).toContain(field);
      expect(action.card.rows.map((r) => r.field)).toContain(field);
    }
  });

  it("declares a card row for every field the confirm payload carries", async () => {
    // This is the guard that keeps cardBridge.test.ts's "no declared row may be dropped" armed.
    // That test loops over the REGISTERED rows and checks buildConfirmPayload keeps each one — but
    // the rows come from docs/openchat-registration.json, which is HAND-EDITED and untouched by
    // gen-openchat-registration.ts. Deleting the {label:"Template", valueKey:"template"} row there
    // disarms it silently: the loop just iterates one row fewer and still passes. Then Template
    // stops rendering on the card and stops riding the confirm payload, and the entry lands with
    // none of its type's defaults — with the whole suite green.
    const { buildManifestWire } = await import("./registerAiApp");
    const rows = (buildManifestWire("") as unknown as {
      actions: { card: { rows: { field: string }[] } }[];
    }).actions[0].card.rows;
    expect(rows.map((r) => r.field)).toEqual(
      expect.arrayContaining([
        "amount",
        "currency",
        "kind",
        "template",
        "direction",
        "date",
        "note",
        "message",
      ]),
    );
  });

  it("stamps the raw message on `message`, never on `note`", () => {
    // note is the model's own per-entry description now; stamping the message over it gave every row
    // of a multi-transaction card the whole message.
    const fromMessage = buildIouRules([]).filter((r) => r.kind === "from_message");
    expect(fromMessage.map((r) => (r as { field: string }).field)).toEqual(["message"]);
  });
});

// The prompt is the ONLY lever we have over how the model splits a message, and the split it gets
// wrong is the one a human writes most naturally: two amounts on one line.
//
// Verified live against Qwen3-VL 2B in the child profile. Without this guidance the model returned
// TWO objects for "Owe me 300 uber 150 food\n\n500 movies" — it merged "300 uber 150 food" into a
// single 300 and dropped the 150 — and the card duly showed two entries. With it, three. The rest of
// the pipeline was innocent throughout: it faithfully carried whatever the model emitted.
//
// This asserts the INSTRUCTION survives, not the model's behaviour (which no unit test can pin). If
// it is ever reworded, reword this too — and re-run the live check, because the wording is load-bearing.
describe("the extraction prompt tells the model a single line can hold several transactions", () => {
  // \s+ not a literal space: the prompt is a wrapped template literal, so these phrases
  // straddle newlines in the actual string.
  it("says one object per amount, and forbids merging or dropping one", () => {
    const p = IOU_EXTRACTION_PROMPT;
    expect(p).toMatch(/one LINE can hold several\s+transactions/i);
    expect(p).toMatch(/one object for\s+EACH/i);
    expect(p).toMatch(/never merge two\s+amounts/i);
    expect(p).toMatch(/never leave an amount\s+out/i);
  });

  it("ships that guidance in the REGISTERED wire, not just the local constant", () => {
    // The model only ever sees what was registered on-chain; a prompt edit that is not re-registered
    // changes nothing (this cost a full round of live testing to learn).
    const doc = registration as { promptTemplate?: string };
    expect(doc.promptTemplate ?? "").toMatch(/one LINE can hold several\s+transactions/i);
  });
});
