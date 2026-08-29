import { describe, it, expect } from "vitest";
import {
  iouActionManifest,
  renderManifestJson,
  IOU_EXTRACTION_PROMPT,
  IOU_IMAGE_DATE_EXTRACTION_PROMPT,
  IOU_IMAGE_EXTRACTION_PROMPT,
  buildIouRules,
  buildIouOutputSchema,
  IOU_CURRENCY_EVIDENCE_MAP,
  IOU_MIN_MAJOR_AMOUNT,
} from "./actionManifest";
import { parseDraft } from "../entries/draft";
import registration from "../../../docs/openchat-registration.json";

describe("private account templates", () => {
  const templates = [
    {
      id: "z9-abc123",
      name: "Reservation",
      keywords: ["private-reservation-trigger"],
    },
    { id: "y8-def456", name: "No Triggers", keywords: [] },
  ];

  it("never serializes template names or keywords into public rules", () => {
    const rules = buildIouRules(templates);
    const km = rules.find(
      (r) => r.kind === "keyword_map" && r.field === "template",
    );
    expect(km).toBeUndefined();
    expect(JSON.stringify(rules)).not.toContain("Reservation");
    expect(JSON.stringify(rules)).not.toContain("private-reservation-trigger");
  });

  it("uses only neutral ledger-intent cues for public kind matching", () => {
    const publicKindRule = buildIouRules([]).find(
      (rule) => rule.kind === "keyword_map" && rule.field === "kind",
    );
    expect(publicKindRule?.kind).toBe("keyword_map");
    if (!publicKindRule || publicKindRule.kind !== "keyword_map") return;

    const publicIouKeywords = publicKindRule.map.find(
      (entry) => entry.value === "iou",
    )?.keywords;
    expect(publicIouKeywords).toEqual([
      "due",
      "owed",
      "owes",
      "owe",
      "i owe",
      "you owe",
      "we owe",
      "they owe",
      "owe me",
      "owe you",
      "owe him",
      "owe her",
      "owe them",
      "instalment",
      "installment",
    ]);

    // These are plausible private Saved-type names, not evidence of ledger intent by themselves.
    // They must not become public triggers simply because one account happens to use that type.
    expect(publicIouKeywords).not.toEqual(
      expect.arrayContaining([
        "reservation",
        "booking",
        "rent",
        "school",
        "family expense",
      ]),
    );

    expect(
      publicKindRule.map.find((entry) => entry.value === "settlement")
        ?.keywords,
    ).toEqual([
      "paid",
      "sent",
      "transferred",
      "settled",
      "received",
      "transaction successful",
      "transaction was successful",
      "payment successful",
      "payment was successful",
      "transfer successful",
      "transfer was successful",
      "تمت العملية",
      "تمت العملية بنجاح",
      "تمت المعاملة بنجاح",
      "تم التحويل بنجاح",
      "تم الدفع بنجاح",
    ]);
    expect(
      publicKindRule.map.find((entry) => entry.value === "settlement")
        ?.keywords,
    ).not.toEqual(expect.arrayContaining(["بنجاح", "ناجح"]));

    expect(
      IOU_CURRENCY_EVIDENCE_MAP.find((entry) => entry.value === "EGP")
        ?.keywords,
    ).toEqual(expect.arrayContaining(["cp", "ecp", "tcp"]));

    const documentedRules =
      registration.rules as typeof iouActionManifest.rules;
    const documentedKindRule = documentedRules.find(
      (rule) => rule.kind === "keyword_map" && rule.field === "kind",
    );
    expect(documentedKindRule).toEqual(publicKindRule);
  });

  it("does not combine every account's types into one public per-user roster", () => {
    // Reproduces the former cross-account roster: neither account's private
    // values may appear in a public, user-global OpenChat manifest.
    const twoAccounts = [
      {
        id: "house-1",
        name: "Reservation",
        keywords: ["reservation", "booking"],
      }, // House account
      { id: "child-1", name: "Allowance", keywords: ["allowance"] }, // the child account
    ];
    const rules = buildIouRules(twoAccounts);
    const km = rules.find(
      (r) => r.kind === "keyword_map" && r.field === "template",
    );
    expect(km).toBeUndefined();
    // The vision path must not receive a private roster instruction either.
    const roster = rules.find(
      (r) => r.kind === "instruction" && /saved types/.test(r.text),
    );
    expect(roster).toBeUndefined();
    expect(JSON.stringify(rules)).not.toContain("Reservation");
    expect(JSON.stringify(rules)).not.toContain("Allowance");
  });

  it("never advertises a template field sourced from private account data", () => {
    expect(
      (buildIouOutputSchema(templates).properties as Record<string, unknown>)
        .template,
    ).toBeUndefined();
    // No routable templates -> no `template` property (nothing would ever set it).
    expect(
      (
        buildIouOutputSchema([{ id: "x", name: "X", keywords: [] }])
          .properties as Record<string, unknown>
      ).template,
    ).toBeUndefined();
  });

  it("publishes the safe transaction kind as Type without publishing saved account types", () => {
    expect(iouActionManifest.card.fields).toContainEqual({
      key: "kind",
      label: "Type",
    });

    const publicCard = JSON.stringify(iouActionManifest.card);
    expect(publicCard).not.toContain("Reservation");
    expect(publicCard).not.toContain("private-reservation-trigger");
    expect(
      iouActionManifest.card.fields.map((field) => field.key),
    ).not.toContain("template");
    expect(
      iouActionManifest.card.fields.map((field) => field.key),
    ).not.toContain("template_ref");
  });

  it("keeps the TS card fields byte-for-field aligned with the documented and registered rows", async () => {
    const documented = (
      registration as {
        card: { rows: { label: string; valueKey: string }[] };
      }
    ).card.rows.map((row) => ({ key: row.valueKey, label: row.label }));
    const { buildManifestWire } = await import("./registerAiApp");
    const registered = (
      buildManifestWire("") as unknown as {
        actions: { card: { rows: { field: string; label: string }[] } }[];
      }
    ).actions[0].card.rows.map((row) => ({ key: row.field, label: row.label }));

    expect(iouActionManifest.card.fields).toEqual(documented);
    expect(iouActionManifest.card.fields).toEqual(registered);
  });
});

describe("invalid attested-card guardrails", () => {
  // Live-reproduced 2026-07-22: the on-device model turned the message "hi" into
  // {"kind":"settlement","amount":0,"currency":"USD","note":"hi"}; OpenChat posted+deposited it and
  // IOU could only render "invalid draft". The registered schema and canister attester require the
  // exact public ledger semantics so OpenChat drops bad model output before a card posts. The local
  // paste/legacy parser is deliberately more permissive and may infer defaults outside this trust
  // boundary.

  it("schema requires ledger semantics but NOT currency or model-authored source evidence", () => {
    // amount/kind are unrecoverable without inventing ledger meaning. Direction stays required but
    // can be satisfied by the app-declared visible editable fallback for genuinely ambiguous input.
    // currency IS recoverable: IOU fills a missing currency from prefs.defaultCurrency on import
    // (baseWithDefaultCurrency), so requiring it would wrongly BLOCK a no-currency message at the
    // OpenChat gate before IOU can default it (live 2026-07-23: "paid 120 for groceries" → no card).
    const required = iouActionManifest.outputSchema.required as string[];
    expect(required).toEqual(["amount", "kind", "direction"]);
    expect(required).not.toContain("currency");
    expect(required).not.toContain("message");
    // The template-enriched schema (the one actually registered) carries the same requirement.
    expect(buildIouOutputSchema([]).required as string[]).toEqual([
      "amount",
      "kind",
      "direction",
    ]);
    expect(buildIouOutputSchema([]).required as string[]).not.toContain(
      "currency",
    );
    expect(buildIouOutputSchema([]).required as string[]).not.toContain(
      "message",
    );
  });

  it("declares a visible editable debt fallback when the model omits an ambiguous direction", () => {
    const direction = (
      iouActionManifest.outputSchema.properties as Record<string, unknown>
    ).direction as Record<string, unknown>;
    expect(direction).toMatchObject({
      enum: ["credit", "debt"],
      default: "debt",
    });
    expect(
      (
        (
          registration as {
            responseSchema: { properties: Record<string, unknown> };
          }
        ).responseSchema.properties.direction as Record<string, unknown>
      ).default,
    ).toBe("debt");
  });

  it("requires image kind to be explicit and ships only the proven target-field aliases", async () => {
    const { buildManifestWire } = await import("./registerAiApp");
    const wireSchema = JSON.parse(
      (
        buildManifestWire("") as unknown as {
          actions: { response_schema: string }[];
        }
      ).actions[0].response_schema,
    ) as { properties: Record<string, Record<string, unknown>> };
    const schemas = [
      iouActionManifest.outputSchema,
      registration.responseSchema,
      buildIouOutputSchema([]),
      wireSchema,
    ] as { properties: Record<string, Record<string, unknown>> }[];
    for (const schema of schemas) {
      expect(schema.properties.kind).toMatchObject({
        type: "string",
        enum: ["settlement", "iou"],
        default: "iou",
        "x-openchat-enum-aliases": {
          settlement: ["paid", "payment", "transfer"],
        },
        "x-openchat-require-explicit-for-image-only": true,
      });
    }
  });

  it("keeps concrete date values out of the vision instructions", () => {
    expect(IOU_EXTRACTION_PROMPT).toContain(
      "Put the visibly printed year first, the visible month second",
    );
    expect(IOU_EXTRACTION_PROMPT).not.toMatch(/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/);
    expect(IOU_EXTRACTION_PROMPT).not.toMatch(
      /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}\b/i,
    );
  });

  it("schema starts at the exact value that rounds to one minor unit", () => {
    const amount = (
      iouActionManifest.outputSchema.properties as Record<string, unknown>
    ).amount as Record<string, unknown>;
    expect(amount.type).toBe("number");
    expect(amount.minimum).toBe(IOU_MIN_MAJOR_AMOUNT);
    expect(amount.exclusiveMinimum).toBeUndefined();
    // Survives the deep clone into the registered (template-enriched) schema too.
    const enriched = (
      buildIouOutputSchema([]).properties as Record<string, unknown>
    ).amount as Record<string, unknown>;
    expect(enriched.minimum).toBe(IOU_MIN_MAJOR_AMOUNT);
    expect(enriched.exclusiveMinimum).toBeUndefined();
  });

  it("parseDraft rejects a draft missing amount or with amount 0 (the manifest constraints are real)", () => {
    // Exactly the live "hi" extraction: amount 0 must NOT parse.
    const zero = parseDraft({
      kind: "settlement",
      amount: 0,
      currency: "USD",
      note: "hi",
    });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.errors[0]).toMatch(/amount/i);
    // Missing amount must NOT parse either (schema `required` mirrors this).
    const missing = parseDraft({
      kind: "settlement",
      currency: "USD",
      note: "hi",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.join(" ")).toMatch(/amount/i);
    // Negative amounts and positive values that still round to zero minor units are equally out.
    expect(parseDraft({ amount: -5, currency: "USD" }).ok).toBe(false);
    expect(parseDraft({ amount: 0.0049, currency: "USD" }).ok).toBe(false);
    expect(
      parseDraft({ amount: IOU_MIN_MAJOR_AMOUNT, currency: "USD" }).ok,
    ).toBe(true);
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
    expect(Object.keys(iouActionManifest.card.directionLabels).sort()).toEqual([
      "credit",
      "debt",
    ]);
    // both directions parse
    expect(
      parseDraft({ amount: 1, currency: "USD", direction: "credit" }).ok,
    ).toBe(true);
    expect(
      parseDraft({ amount: 1, currency: "USD", direction: "debt" }).ok,
    ).toBe(true);
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

  it("publishes a per-invocation opaque-token chat-routing surface", () => {
    const routing = iouActionManifest.surfaces.find(
      (x) => x.kind === "chat_link",
    );
    expect(routing).toBeDefined();
    expect(routing!.display).toBe("external");
    expect(routing!.url).toMatch(
      /^https?:\/\/[^/]+\/settings#openchat-routing\/\{chatLinkToken\}$/,
    );
    for (const surface of iouActionManifest.surfaces) {
      expect(surface.url).not.toMatch(/\{(?:chatKey|messageId|userId)\}/);
      expect(
        surface.url
          .replaceAll("{appId}", "1")
          .replaceAll(
            "{chatLinkToken}",
            "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg",
          ),
      ).not.toMatch(/[{}]/);
    }
  });

  it("declares a connect surface pointing at the pairing-code entry anchor", () => {
    const s = iouActionManifest.surfaces.find((x) => x.kind === "connect");
    expect(s).toBeDefined();
    // The code entry needs the user's signed-in session.
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

  it("declares a metadata-free private matcher surface", () => {
    const s = iouActionManifest.surfaces.find(
      (x) => x.kind === "private_match",
    );
    expect(s).toBeDefined();
    expect(s!.display).toBe("sheet");
    expect(s!.url).toMatch(/^https?:\/\/[^/]+\/openchat\/private-match$/);
    expect(s!.url).not.toMatch(/[?#]/);
    expect(JSON.stringify(s)).not.toMatch(
      /school|reservation|saved.?type|keyword/i,
    );
  });

  it("every declared surface URL parses after public app-id substitution", () => {
    for (const surface of iouActionManifest.surfaces) {
      expect(
        () => new URL(surface.url.replaceAll("{appId}", "7")),
      ).not.toThrow();
    }
  });
});

// The TS manifest is authoritative for schema, rules, and the compact public rows. The generator
// keeps the pasteable registration JSON synchronized, and buildManifestWire reads the same TS row
// list directly. `message` deliberately survives only in the stored payload/schema: it must not be
// repeated as public description text in every classic multi-entry summary.
describe("registered wire — schema evidence stays private and public rows stay compact", () => {
  it("declares the image-only direction fallback consistently in source, docs, and wire", async () => {
    const sourceSchema = iouActionManifest.outputSchema as {
      properties?: Record<string, Record<string, unknown>>;
    };
    const documentedSchema = registration.responseSchema as typeof sourceSchema;
    const { buildManifestWire } = await import("./registerAiApp");
    const wireSchema = JSON.parse(
      (
        buildManifestWire("") as unknown as {
          actions: { response_schema: string }[];
        }
      ).actions[0].response_schema,
    ) as typeof sourceSchema;

    for (const schema of [sourceSchema, documentedSchema, wireSchema]) {
      expect(schema.properties?.direction).toMatchObject({
        type: "string",
        enum: ["credit", "debt"],
        default: "debt",
        "x-openchat-default-for-image-only": "credit",
      });
    }
  });

  it("declares accelerated selected-model first with a bounded source-grounded fallback", async () => {
    const expected = {
      version: 1,
      primary: "selected_model",
      requireAcceleration: true,
      fallback: "source_grounded",
    };
    const sourceSchema = iouActionManifest.outputSchema as {
      "x-openchat-browser-image-strategy"?: unknown;
    };
    const documentedSchema = registration.responseSchema as typeof sourceSchema;
    const { buildManifestWire } = await import("./registerAiApp");
    const wireSchema = JSON.parse(
      (
        buildManifestWire("") as unknown as {
          actions: { response_schema: string }[];
        }
      ).actions[0].response_schema,
    ) as typeof sourceSchema;

    for (const schema of [sourceSchema, documentedSchema, wireSchema]) {
      expect(schema["x-openchat-browser-image-strategy"]).toEqual(expected);
    }
  });

  it("ships the bounded model-only image passes consistently in source, docs, and wire", async () => {
    const expectedPrimary = {
      version: 1,
      template: IOU_IMAGE_EXTRACTION_PROMPT,
      includeRuleGuidance: false,
    };
    const expectedFocused = {
      version: 3,
      primaryFields: ["amount", "currency", "kind"],
      primaryMaxTokens: 64,
      passes: [
        {
          template: IOU_IMAGE_DATE_EXTRACTION_PROMPT,
          fields: ["date"],
          includeRuleGuidance: false,
          includeMessage: false,
          maxTokens: 24,
          imageRegion: "detail_card",
        },
      ],
    };
    const sourceSchema = iouActionManifest.outputSchema as {
      "x-openchat-image-prompt-template"?: unknown;
      "x-openchat-image-focused-passes"?: unknown;
    };
    const documentedSchema = registration.responseSchema as typeof sourceSchema;
    const { buildManifestWire } = await import("./registerAiApp");
    const wireSchema = JSON.parse(
      (
        buildManifestWire("") as unknown as {
          actions: { response_schema: string }[];
        }
      ).actions[0].response_schema,
    ) as typeof sourceSchema;

    for (const schema of [sourceSchema, documentedSchema, wireSchema]) {
      expect(schema["x-openchat-image-prompt-template"]).toEqual(
        expectedPrimary,
      );
      expect(schema["x-openchat-image-focused-passes"]).toEqual(
        expectedFocused,
      );
    }
    for (const pass of [expectedPrimary, ...expectedFocused.passes]) {
      expect(pass.template.trim()).toBe(pass.template);
      expect(
        new TextEncoder().encode(pass.template).byteLength,
      ).toBeLessThanOrEqual(4_096);
      expect(pass.template).not.toContain("\n\nRules:");
    }
    expect([
      ...expectedFocused.primaryFields,
      ...expectedFocused.passes.flatMap((pass) => pass.fields),
    ]).toEqual(["amount", "currency", "kind", "date"]);
  });

  it("opts into the generic source-grounded text/OCR transaction parser in source, docs, and wire", async () => {
    const expected = {
      version: 1,
      amountField: "amount",
      currencyField: "currency",
      kindField: "kind",
      directionField: "direction",
      dateField: "date",
      noteField: "note",
      sourceField: "message",
      fallbackKind: "iou",
      ocrDefaultDirection: "credit",
      requireOcrEvidenceFields: ["kind"],
      maximumItems: 16,
      authoritativeAmountLabels: ["amount due", "total", "transfer amount"],
      dateLabels: ["due date", "date"],
      noteLabels: ["note", "description", "memo"],
      ignoredLineLabels: ["reference"],
      titleLineKeywords: [
        "receipt",
        "request",
        "transaction successful",
        "transaction was successful",
        "powered by",
      ],
      relationshipLabelPrefixes: ["status", "direction"],
    };
    const sourceSchema = iouActionManifest.outputSchema as {
      "x-openchat-source-grounded-transactions"?: unknown;
    };
    const documentedSchema = registration.responseSchema as typeof sourceSchema;
    const { buildManifestWire } = await import("./registerAiApp");
    const wireSchema = JSON.parse(
      (
        buildManifestWire("") as unknown as {
          actions: { response_schema: string }[];
        }
      ).actions[0].response_schema,
    ) as typeof sourceSchema;

    for (const schema of [sourceSchema, documentedSchema, wireSchema]) {
      expect(schema["x-openchat-source-grounded-transactions"]).toEqual(
        expected,
      );
    }
  });

  it("opts into the bounded generic amount/label text-sequence fallback in source, docs, and wire", async () => {
    const expected = {
      numberField: "amount",
      labelField: "note",
      minimumItems: 2,
      anchors: ["owe me", "owe"],
      unanchoredMode: "whole_message",
      unanchoredLabels: ["food", "uber", "shopping"],
    };
    const sourceSchema = iouActionManifest.outputSchema as {
      properties?: Record<string, { type?: unknown; default?: unknown }>;
      required?: unknown;
      "x-openchat-text-sequence"?: unknown;
    };
    const documentedSchema = registration.responseSchema as typeof sourceSchema;
    const { buildManifestWire } = await import("./registerAiApp");
    const wireSchema = JSON.parse(
      (
        buildManifestWire("") as unknown as {
          actions: { response_schema: string }[];
        }
      ).actions[0].response_schema,
    ) as typeof sourceSchema;

    for (const schema of [sourceSchema, documentedSchema, wireSchema]) {
      expect(schema["x-openchat-text-sequence"]).toEqual(expected);
      expect(schema.properties?.amount?.type).toBe("number");
      expect(schema.properties?.note?.type).toBe("string");
      expect(schema.properties?.kind).toMatchObject({
        type: "string",
        default: "iou",
      });
      expect(schema.required).toContain("amount");
    }
  });

  it("opts into the strict semicolon label/amount/currency fast path in source, docs, and wire", async () => {
    const expected = {
      delimiter: "semicolon",
      numberField: "amount",
      labelField: "note",
      currencyField: "currency",
      minimumItems: 2,
    };
    const sourceSchema = iouActionManifest.outputSchema as {
      properties?: Record<string, { type?: unknown }>;
      required?: unknown;
      "x-openchat-delimited-text-sequence"?: unknown;
    };
    const documentedSchema = registration.responseSchema as typeof sourceSchema;
    const { buildManifestWire } = await import("./registerAiApp");
    const wireSchema = JSON.parse(
      (
        buildManifestWire("") as unknown as {
          actions: { response_schema: string }[];
        }
      ).actions[0].response_schema,
    ) as typeof sourceSchema;

    for (const schema of [sourceSchema, documentedSchema, wireSchema]) {
      expect(schema["x-openchat-delimited-text-sequence"]).toEqual(expected);
      expect(schema.properties?.amount?.type).toBe("number");
      expect(schema.properties?.currency?.type).toBe("string");
      expect(schema.properties?.note?.type).toBe("string");
      expect(schema.required).toContain("amount");
    }
  });

  it("contains no unbounded JSON Schema pattern keyword at any depth", async () => {
    const collectKeyPaths = (
      value: unknown,
      forbidden: string,
      path = "$",
    ): string[] => {
      if (Array.isArray(value)) {
        return value.flatMap((entry, index) =>
          collectKeyPaths(entry, forbidden, `${path}[${index}]`),
        );
      }
      if (value === null || typeof value !== "object") return [];
      return Object.entries(value as Record<string, unknown>).flatMap(
        ([key, entry]) => [
          ...(key === forbidden ? [`${path}.${key}`] : []),
          ...collectKeyPaths(entry, forbidden, `${path}.${key}`),
        ],
      );
    };

    const { buildManifestWire } = await import("./registerAiApp");
    const responseSchema = JSON.parse(
      (
        buildManifestWire("") as unknown as {
          actions: { response_schema: string }[];
        }
      ).actions[0].response_schema,
    ) as unknown;
    const documentedSchema = (registration as { responseSchema: unknown })
      .responseSchema;

    expect(collectKeyPaths(responseSchema, "pattern")).toEqual([]);
    expect(collectKeyPaths(documentedSchema, "pattern")).toEqual([]);
  });

  it("keeps from_message evidence in the payload schema but off the public card rows", async () => {
    const { buildManifestWire } = await import("./registerAiApp");
    const wire = buildManifestWire("") as unknown as {
      actions: {
        response_schema: string;
        rules: unknown[];
        card: { rows: { field: string; label: string }[] };
      }[];
    };
    const action = wire.actions[0];
    const schema = JSON.parse(action.response_schema) as {
      properties?: Record<string, unknown>;
    };
    const fromMessageFields = buildIouRules([])
      .filter(
        (r): r is Extract<typeof r, { kind: "from_message" }> =>
          r.kind === "from_message",
      )
      .map((r) => r.field);

    expect(fromMessageFields.length).toBeGreaterThan(0);
    for (const field of fromMessageFields) {
      expect(Object.keys(schema.properties ?? {})).toContain(field);
      expect(action.card.rows.map((r) => r.field)).not.toContain(field);
    }
  });

  it("declares only the compact user-reviewed fields as public card rows", async () => {
    // Pin the complete public list and explicitly exclude private/redundant channels.
    const { buildManifestWire } = await import("./registerAiApp");
    const rows = (
      buildManifestWire("") as unknown as {
        actions: { card: { rows: { field: string }[] } }[];
      }
    ).actions[0].card.rows;
    expect(rows.map((r) => r.field)).toEqual([
      "amount",
      "currency",
      "kind",
      "direction",
      "date",
      "note",
    ]);
  });

  it("stamps the raw message on `message`, never on `note`", () => {
    // note is the model's own per-entry description now; stamping the message over it gave every row
    // of a multi-transaction card the whole message.
    const fromMessage = buildIouRules([]).filter(
      (r) => r.kind === "from_message",
    );
    expect(fromMessage.map((r) => (r as { field: string }).field)).toEqual([
      "message",
    ]);
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
    expect(p).toMatch(/never merge two\s+amounts[^.]*distinct transactions/i);
    expect(p).toMatch(/never leave an amount\s+out[^.]*distinct transaction/i);
  });

  it("ships that guidance in the REGISTERED wire, not just the local constant", () => {
    // The model only ever sees what was registered on-chain; a prompt edit that is not re-registered
    // changes nothing (this cost a full round of live testing to learn).
    const doc = registration as { promptTemplate?: string };
    expect(doc.promptTemplate ?? "").toMatch(
      /one LINE can hold several\s+transactions/i,
    );
  });

  it("forbids repeating one observed transaction as duplicate output", () => {
    const p = IOU_EXTRACTION_PROMPT;
    expect(p).toMatch(/never (?:repeat|emit) the same transaction twice/i);
    expect(p).toMatch(/one amount occurrence[^.]*exactly one object/i);
  });

  it("ships the duplicate-output guard in the registered wire", () => {
    const doc = registration as { promptTemplate?: string };
    const prompt = doc.promptTemplate ?? "";
    expect(prompt).toMatch(/never (?:repeat|emit) the same transaction twice/i);
    expect(prompt).toMatch(/one amount occurrence[^.]*exactly one object/i);
  });

  it("puts a numeric-occurrence cardinality check before classification and repeats it last", () => {
    const p = IOU_EXTRACTION_PROMPT;
    const normalized = p.replace(/\s+/g, " ");
    const cardinality = p.indexOf(
      "CARDINALITY — APPLY THIS BEFORE CLASSIFICATION",
    );
    const kind = p.indexOf('- "kind"');
    const finalCheck = p.lastIndexOf("FINAL COUNT CHECK");

    expect(cardinality).toBeGreaterThanOrEqual(0);
    expect(kind).toBeGreaterThan(cardinality);
    expect(finalCheck).toBeGreaterThan(kind);
    expect(p).toMatch(
      /exactly one distinct transaction amount[\s\S]*exactly\s+ONE JSON\s+object/i,
    );
    expect(normalized).toMatch(
      /never create separate debtor and creditor views/i,
    );
    expect(normalized).toMatch(
      /number of output objects[^.]*number of distinct transactions/i,
    );
    expect(normalized).toMatch(/one transaction[^.]*object, not an array/i);
  });

  it("pins concrete direction phrases and forbids inventing today's date", () => {
    const p = IOU_EXTRACTION_PROMPT;
    const normalized = p.replace(/\s+/g, " ");
    expect(p).toMatch(/"owed to you"[^.]*"credit"/i);
    expect(p).toMatch(/"you owe me"[^.]*"credit"/i);
    expect(p).toMatch(/"I owe"[^.]*"debt"/i);
    expect(p).toMatch(/bare shorthand "owe 200 uber"[^.]*"debt"/i);
    expect(normalized).toMatch(
      /output the literal JSON value "credit" or "debt"/i,
    );
    expect(normalized).toMatch(/never copy a source phrase into "direction"/i);
    expect(p).toMatch(/host calendar anchor[^.]*reference\s+context only/i);
    expect(normalized).toMatch(
      /never output today's date unless the source itself says "today"/i,
    );
    expect(normalized).toMatch(
      /no visible date digits or date words[^.]*omit "date"/i,
    );
    expect(iouActionManifest.rules).toContainEqual({
      kind: "keyword_map",
      field: "direction",
      mode: "override",
      map: [
        {
          value: "credit",
          keywords: [
            "owed to you",
            "you are owed",
            "due to you",
            "payable to you",
            "you owe",
            "owe me",
            "owes me",
          ],
        },
        {
          value: "debt",
          keywords: [
            "i owe",
            "we owe",
            "owe you",
            "owe him",
            "owe her",
            "owe them",
            "owed by you",
            "due from you",
            "payable by you",
            "owe",
          ],
        },
      ],
    });
  });

  it("requires a literal object boundary for a one-amount source", () => {
    const normalized = IOU_EXTRACTION_PROMPT.replace(/\s+/g, " ");
    expect(normalized).toMatch(
      /one distinct transaction amount[^.]*first non-whitespace output character[^.]*\{/i,
    );
    expect(normalized).toMatch(/last non-whitespace output character[^.]*\}/i);
    expect(normalized).toMatch(/do not wrap that object in \[\]/i);
  });

  it("does not turn receipt totals/components or a repeated total into extra transactions", () => {
    const normalized = IOU_EXTRACTION_PROMPT.replace(/\s+/g, " ");
    expect(normalized).toMatch(
      /line-item prices[^.]*subtotal[^.]*tax[^.]*tip[^.]*change[^.]*balance/i,
    );
    expect(normalized).toMatch(
      /repeated displays? of (?:the same transaction|its) total[^.]*not (?:a )?separate/i,
    );
    expect(normalized).toMatch(
      /equal amounts[^.]*distinct transaction descriptions[^.]*separate/i,
    );
    expect(normalized).toMatch(
      /dates[^.]*times[^.]*IDs[^.]*quantities[^.]*percentages[^.]*exchange rates/i,
    );
  });

  it("separates core financial fields from the language-independent date pass", () => {
    const corePrompt = IOU_IMAGE_EXTRACTION_PROMPT.replace(/\s+/g, " ");
    const datePrompt = IOU_IMAGE_DATE_EXTRACTION_PROMPT.replace(/\s+/g, " ");

    expect(corePrompt).toMatch(
      /authoritative[^.]*paid[^.]*transferred[^.]*total/i,
    );
    expect(corePrompt).toMatch(
      /ignore[^.]*IDs[^.]*accounts[^.]*references[^.]*dates[^.]*times/i,
    );
    expect(corePrompt).toMatch(/settlement[^.]*completed moving/i);
    expect(corePrompt).toMatch(/iou[^.]*future[^.]*due[^.]*requested/i);
    expect(corePrompt).toMatch(/currency[^.]*exact visible[^.]*three-letter/i);
    expect(corePrompt).toMatch(/compare all three printed letters/i);
    expect(corePrompt).toMatch(/receipt or total alone[^.]*not proof of payment/i);
    expect(corePrompt).toMatch(/ignore[^.]*parties[^.]*descriptions/i);
    expect(corePrompt).not.toMatch(/explicitly labelled Note/i);
    expect(corePrompt).not.toMatch(/"direction"|"date"\s*:/i);

    expect(datePrompt).toMatch(/label may be written in any language or script/i);
    expect(datePrompt).toContain("التاريخ means Date");
    expect(datePrompt).toMatch(/exactly the JSON key "date"/i);
    expect(datePrompt).toMatch(/do not return a note or any other field/i);
    expect(datePrompt).toMatch(/transcribe[^.]*instead of[^.]*calendar conversion/i);
    expect(datePrompt).toMatch(
      /English month name[^.]*copy the visible day[^.]*month word[^.]*four-digit year/i,
    );
    expect(datePrompt).toMatch(/do not translate[^.]*or reorder/i);
    expect(datePrompt).toMatch(/already strict YYYY-MM-DD[^.]*unchanged/i);
    expect(datePrompt).toMatch(/numeric-only date[^.]*ambiguous[^.]*omit "date"/i);
    expect(datePrompt).toMatch(/compare every copied date token[^.]*image/i);
    expect(datePrompt).toMatch(/four year digits[^.]*printed shapes[^.]*final digit/i);
    expect(datePrompt).toMatch(/month word is printed[^.]*retain[^.]*never output month digits/i);
    expect(datePrompt).not.toMatch(/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/);
    expect(datePrompt).not.toMatch(
      /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}\b/i,
    );
    expect(datePrompt).toMatch(/English month name[^.]*omit the time/i);
    expect(datePrompt).toMatch(
      /complete visible date[^.]*calendar conversion/i,
    );
    expect(datePrompt).not.toMatch(/"note"\s*:/i);
    expect(datePrompt).toMatch(/never infer/i);
    expect(IOU_IMAGE_EXTRACTION_PROMPT).not.toMatch(/"amount"\s*:\s*-?\d/u);
    // A weak vision signal must not let greedy decoding echo a numeric instruction literal as the
    // transaction amount. Spell normalization semantics without any concrete numeric example.
    expect(IOU_IMAGE_EXTRACTION_PROMPT).not.toMatch(/\b\d[\d,.]*\b/u);
    const lowerPrompt = IOU_IMAGE_EXTRACTION_PROMPT.toLocaleLowerCase();
    for (const { value, keywords } of IOU_CURRENCY_EVIDENCE_MAP) {
      for (const concreteCurrency of [value, ...keywords]) {
        expect(lowerPrompt).not.toContain(concreteCurrency.toLocaleLowerCase());
      }
    }
  });

  it("ships the cardinality, direction, and date guards in the registered wire", () => {
    const prompt =
      (registration as { promptTemplate?: string }).promptTemplate ?? "";
    expect(prompt).toContain("CARDINALITY — APPLY THIS BEFORE CLASSIFICATION");
    expect(prompt).toContain("FINAL COUNT CHECK");
    expect(prompt).toMatch(/"owed to you"[^.]*"credit"/i);
    expect(prompt).toMatch(/literal JSON value "credit" or "debt"/i);
    expect(prompt).toMatch(
      /host calendar anchor[^.]*reference\s+context only/i,
    );
    expect(prompt.replace(/\s+/g, " ")).toMatch(
      /no visible date digits or date words[^.]*omit "date"/i,
    );
    expect(prompt).toBe(IOU_EXTRACTION_PROMPT);

    const finalRule = iouActionManifest.rules.at(-1);
    expect(iouActionManifest.rules).toContainEqual({
      kind: "context",
      provide: ["today"],
    });
    expect(finalRule).toEqual({
      kind: "instruction",
      text: 'FINAL FORMAT CHECK: map visible phrases like "YOU OWE ME" to exactly "direction":"credit" and "I OWE YOU" to exactly "direction":"debt"; bare shorthand like "OWE 200 UBER" means "debt"; never use the phrase itself as the direction value. For image input, copy only the exact visible relationship phrase into "message" as transient evidence, never a title or description. Any host calendar anchor is reference only: for a source date range use its start and its missing year only; remove "date" unless the source visibly states a date or relative-date phrase. One transaction must be one object, never an array.',
    });
    expect((registration.rules as unknown[]).at(-1)).toEqual(finalRule);
  });

  it("uses transient image message text only for an exact visible relationship phrase", () => {
    const p = IOU_EXTRACTION_PROMPT;
    expect(p).toMatch(
      /"message"[\s\S]*?plain-text input[\s\S]*?image input[\s\S]*?exact visible relationship phrase/i,
    );
    expect(p).toMatch(/do not copy[^.]*title[^.]*description/i);
    expect(p).toMatch(/omit[^.]*no such phrase is visible/i);
    expect(iouActionManifest.outputSchema.required as string[]).not.toContain(
      "message",
    );
  });

  it("keeps image dates reviewable while omitting only model-authored image message text", () => {
    const prompt =
      (registration as { promptTemplate?: string }).promptTemplate ?? "";
    expect(prompt).toMatch(
      /"message"[\s\S]*?plain-text input[\s\S]*?image input[\s\S]*?exact visible relationship phrase/i,
    );
    const registeredSchema = registration.responseSchema as {
      required?: string[];
      properties?: Record<string, Record<string, unknown>>;
    };
    const sourceProperties = iouActionManifest.outputSchema
      .properties as Record<string, Record<string, unknown>>;
    expect(sourceProperties.date).toMatchObject({
      "x-openchat-date-from-text": true,
      "x-openchat-property-aliases": [
        "due_date",
        "transaction_date",
        "payment_date",
        "booking_date",
        "Date",
        "TransactionDate",
        "PaymentDate",
        "BookingDate",
      ],
    });
    expect(registeredSchema.required).not.toContain("message");
    expect(sourceProperties.date).not.toHaveProperty(
      "x-openchat-omit-for-image-only",
    );
    expect(sourceProperties.message).toMatchObject({
      "x-openchat-omit-for-image-only": true,
    });
    expect(registeredSchema.properties?.date).not.toHaveProperty(
      "x-openchat-omit-for-image-only",
    );
    expect(registeredSchema.properties?.date).toMatchObject({
      "x-openchat-date-from-text": true,
      "x-openchat-property-aliases": [
        "due_date",
        "transaction_date",
        "payment_date",
        "booking_date",
        "Date",
        "TransactionDate",
        "PaymentDate",
        "BookingDate",
      ],
    });
    expect(registeredSchema.properties?.message).toMatchObject({
      "x-openchat-omit-for-image-only": true,
    });
  });

  it("ships the generic plain-text currency evidence contract and its exact aliases", async () => {
    const sourceCurrency = (
      iouActionManifest.outputSchema.properties as Record<
        string,
        Record<string, unknown>
      >
    ).currency;
    const documentedCurrency = (
      registration.responseSchema as {
        properties?: Record<string, Record<string, unknown>>;
      }
    ).properties?.currency;
    const { buildManifestWire } = await import("./registerAiApp");
    const action = (
      buildManifestWire("") as unknown as {
        actions: { response_schema: string; rules: unknown[] }[];
      }
    ).actions[0];
    const registeredCurrency = (
      JSON.parse(action.response_schema) as {
        properties?: Record<string, Record<string, unknown>>;
      }
    ).properties?.currency;
    const expectedRule = {
      kind: "keyword_map",
      field: "currency",
      mode: "hint",
      map: IOU_CURRENCY_EVIDENCE_MAP,
    };

    expect(sourceCurrency?.["x-openchat-require-text-evidence"]).toBe(true);
    expect(documentedCurrency?.["x-openchat-require-text-evidence"]).toBe(true);
    expect(registeredCurrency?.["x-openchat-require-text-evidence"]).toBe(true);
    expect(buildIouRules([])).toContainEqual(expectedRule);
    expect(registration.rules).toContainEqual(expectedRule);
  });
});
