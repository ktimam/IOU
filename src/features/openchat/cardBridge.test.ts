import { describe, expect, it } from "vitest";
import {
  CARD_INIT_VERSION,
  CARD_MSG,
  CARD_RECIPIENT_KEY_SCHEME,
  MAX_CARD_ENTRIES,
  buildCancel,
  buildConfirm,
  buildConfirmPayload,
  buildMultiConfirmPayload,
  buildPrivateContextReady,
  buildReady,
  buildResize,
  currencyStatedIn,
  initEntries,
  initToFormState,
  parseBootstrap,
  cardParentTargetOrigin,
  parseBusy,
  parseInit,
  parsePrivateContextRequest,
  type CardFormState,
} from "./cardBridge";
import { baseWithDefaultCurrency, batchSummary, parseDraft, parseDraftBatch } from "../entries/draft";
import { TEMPLATE_REF_PREFIX } from "./templateRef";

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const FRAME_NONCE = base64Url(new Uint8Array(32).fill(1));
const OTHER_NONCE = base64Url(new Uint8Array(32).fill(9));
const CAPABILITY = base64Url(new Uint8Array(32).fill(3));
const RECIPIENT_PUBLIC_KEY = base64Url(new Uint8Array(48).fill(2));
const APP_SUBJECT = base64Url(new Uint8Array(32).fill(4));
const CHAT_HANDLE = base64Url(new Uint8Array(32).fill(5));
const MESSAGE_HANDLE = base64Url(new Uint8Array(32).fill(6));

const SAFE_CONTEXT = {
  contextVersion: 1,
  appSubject: APP_SUBJECT,
  chatHandle: CHAT_HANDLE,
  messageHandle: MESSAGE_HANDLE,
  appId: 23,
  appRevision: 5n,
  actionId: "iou.entry.import",
};

const VALID_CONTEXT = {
  appId: 23,
  appRevision: 5n,
  actionId: "iou.entry.import",
  theme: "light",
  readonly: false,
  privateContext: {
    capability: CAPABILITY,
    expiresAt: 9_999_999_999_999n,
    context: SAFE_CONTEXT,
  },
};

function validInit(
  data: unknown = {},
  contextOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: CARD_MSG.init,
    version: CARD_INIT_VERSION,
    frameNonce: FRAME_NONCE,
    data,
    context: { ...VALID_CONTEXT, ...contextOverrides },
  };
}

function structuralTemplateRef(seed: number): string {
  return TEMPLATE_REF_PREFIX + base64Url(new Uint8Array(29).fill(seed));
}

describe("card bootstrap and init protocol v2", () => {
  it("targets the exact parent origin when available and only falls back for opaque origins", () => {
    expect(cardParentTargetOrigin("https://chat.example")).toBe("https://chat.example");
    expect(cardParentTargetOrigin("http://127.0.0.1:5003")).toBe("http://127.0.0.1:5003");
    expect(cardParentTargetOrigin("null")).toBe("*");
    expect(cardParentTargetOrigin("")).toBe("*");
  });

  it("accepts only a canonical nonce from the host bootstrap", () => {
    expect(
      parseBootstrap({
        type: CARD_MSG.bootstrap,
        version: CARD_INIT_VERSION,
        frameNonce: FRAME_NONCE,
      }),
    ).toEqual({ frameNonce: FRAME_NONCE });
    expect(parseBootstrap({ type: CARD_MSG.bootstrap, version: 1, frameNonce: FRAME_NONCE })).toBeNull();
    expect(parseBootstrap({ type: CARD_MSG.bootstrap, version: CARD_INIT_VERSION, frameNonce: "short" })).toBeNull();
    expect(
      parseBootstrap({
        type: CARD_MSG.bootstrap,
        version: CARD_INIT_VERSION,
        frameNonce: FRAME_NONCE.slice(0, -1) + "B",
      }),
    ).toBeNull();
  });

  it("accepts a fully bound init and normalizes presentation fields", () => {
    const parsed = parseInit(
      validInit({
        kind: "iou",
        amount: 42.5,
        currency: "eur",
        direction: "debt",
        note: "rent",
      }),
      FRAME_NONCE,
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.data.amount).toBe(42.5);
    expect(parsed?.context).toMatchObject({
      appId: 23,
      appRevision: 5n,
      actionId: "iou.entry.import",
      theme: "light",
      readonly: false,
    });
    expect(parsed?.context.privateContext?.capability).toBe(CAPABILITY);
    expect(parsed?.context.privateContext?.context).toEqual(SAFE_CONTEXT);
    expect(parsed?.context).not.toHaveProperty("chat");
    expect(parsed?.context).not.toHaveProperty("messageId");
    expect(parsed?.context).not.toHaveProperty("threadRootMessageIndex");
  });

  it("defaults only optional presentation fields while retaining app coordinates", () => {
    const parsed = parseInit(validInit({ amount: 1 }, { theme: undefined, readonly: undefined }), FRAME_NONCE);
    expect(parsed?.context.theme).toBe("dark");
    expect(parsed?.context.readonly).toBe(false);
    expect(parsed?.context.appRevision).toBe(5n);
    expect(parsed?.data.amount).toBe(1);
  });

  it("accepts public init without viewer-private pseudonyms", () => {
    expect(parseInit(validInit({}, { privateContext: undefined }), FRAME_NONCE)?.context).toEqual({
      appId: 23,
      appRevision: 5n,
      actionId: "iou.entry.import",
      theme: "light",
      readonly: false,
    });
  });

  it("coerces missing or non-object data to an empty object", () => {
    const missing = validInit();
    delete missing.data;
    expect(parseInit(missing, FRAME_NONCE)?.data).toEqual({});
    expect(parseInit(validInit([1, 2, 3]), FRAME_NONCE)?.data).toEqual({});
  });

  it("rejects foreign, wrong-version, wrong-nonce, and incomplete init messages", () => {
    for (const value of [null, undefined, 42, "oc:card:init", []]) {
      expect(parseInit(value, FRAME_NONCE)).toBeNull();
    }
    expect(parseInit({ ...validInit(), type: CARD_MSG.confirm }, FRAME_NONCE)).toBeNull();
    expect(parseInit({ ...validInit(), version: 1 }, FRAME_NONCE)).toBeNull();
    expect(parseInit({ ...validInit(), frameNonce: OTHER_NONCE }, FRAME_NONCE)).toBeNull();
    const missingContext = validInit();
    delete missingContext.context;
    expect(parseInit(missingContext, FRAME_NONCE)).toBeNull();
    expect(parseInit(validInit(), OTHER_NONCE)).toBeNull();
  });

  it("rejects malformed, wrong-size, and non-canonical private capability tokens", () => {
    const privateContext = (capability: string) => ({
      capability,
      expiresAt: 1n,
      context: SAFE_CONTEXT,
    });
    expect(
      parseInit(validInit({}, { privateContext: privateContext("short") }), FRAME_NONCE),
    ).toBeNull();
    expect(
      parseInit(
        validInit({}, { privateContext: privateContext(base64Url(new Uint8Array(31))) }),
        FRAME_NONCE,
      ),
    ).toBeNull();
    const nonCanonical = CAPABILITY.slice(0, -1) + (CAPABILITY.endsWith("w") ? "x" : "B");
    expect(
      parseInit(validInit({}, { privateContext: privateContext(nonCanonical) }), FRAME_NONCE),
    ).toBeNull();
  });

  it("rejects malformed or non-canonical app-scoped handles", () => {
    for (const handle of [
      "",
      base64Url(new Uint8Array(31)),
      base64Url(new Uint8Array(33)),
      APP_SUBJECT + "=",
      APP_SUBJECT.slice(0, -1) + "B",
    ]) {
      expect(
        parseInit(
          validInit({}, {
            privateContext: {
              ...VALID_CONTEXT.privateContext,
              context: { ...SAFE_CONTEXT, appSubject: handle },
            },
          }),
          FRAME_NONCE,
        ),
      ).toBeNull();
    }
  });

  it("rejects raw OpenChat identifiers and mismatched app coordinates fail closed", () => {
    for (const raw of [
      { chat: { kind: "group", groupId: "aaaaa-aa" } },
      { chatKey: "group:aaaaa-aa" },
      { chat_key: "group:aaaaa-aa" },
      { messageId: 42n },
      { message_id: "42" },
      { confirmedBy: "aaaaa-aa" },
      { user_id: "aaaaa-aa" },
    ]) {
      expect(parseInit(validInit({}, raw), FRAME_NONCE)).toBeNull();
    }
    for (const mismatch of [
      { appId: 24 },
      { appRevision: 6n },
      { actionId: "other.action" },
    ]) {
      expect(
        parseInit(
          validInit({}, {
            privateContext: {
              ...VALID_CONTEXT.privateContext,
              context: { ...SAFE_CONTEXT, ...mismatch },
            },
          }),
          FRAME_NONCE,
        ),
      ).toBeNull();
    }
  });

  it("rejects out-of-range app coordinates", () => {
    expect(parseInit(validInit({}, { appId: -1 }), FRAME_NONCE)).toBeNull();
    expect(parseInit(validInit({}, { appRevision: -1n }), FRAME_NONCE)).toBeNull();
  });
});

describe("initToFormState and currency evidence", () => {
  it("seeds every public editable field from the extraction", () => {
    expect(
      initToFormState({
        kind: "iou",
        amount: 1000,
        currency: "egp",
        direction: "debt",
        note: "Reservation 1000 EGP",
        date: "2026-08-01",
      }),
    ).toEqual<CardFormState>({
      kind: "iou",
      amount: "1000",
      currency: "EGP",
      direction: "debt",
      note: "Reservation 1000 EGP",
      date: "2026-08-01",
    });
  });

  it("leaves an absent or model-invented currency to the importing IOU user", () => {
    expect(initToFormState({ amount: 5 }).currency).toBe("");
    const state = initToFormState({
      amount: 300,
      currency: "USD",
      direction: "debt",
      note: "Owe 300 uber",
    });
    expect(state.currency).toBe("");
    const payload = buildConfirmPayload(state);
    expect("currency" in payload).toBe(false);
    const egp = parseDraft(payload, baseWithDefaultCurrency(undefined, "EGP"));
    const usd = parseDraft(payload, baseWithDefaultCurrency(undefined, "USD"));
    expect(egp.ok && egp.value.initial.currency).toBe("EGP");
    expect(usd.ok && usd.value.initial.currency).toBe("USD");
  });

  it("honours an explicitly stated code or symbol, using word boundaries", () => {
    expect(currencyStatedIn("Owe 300 USD for uber", "USD")).toBe(true);
    expect(currencyStatedIn("paid $300", "USD")).toBe(true);
    expect(currencyStatedIn("paid £20", "GBP")).toBe(true);
    expect(currencyStatedIn("usduber", "USD")).toBe(false);
    expect(currencyStatedIn("crusade", "USD")).toBe(false);
    expect(initToFormState({ amount: 300, currency: "usd", note: "Owe 300 USD" }).currency).toBe("USD");
  });

  it("uses the configured app currency only when the message left currency unstated", () => {
    expect(initToFormState({ amount: 300, note: "Owe 300 uber" }, " egp ").currency).toBe("EGP");
    expect(
      initToFormState({ amount: 300, currency: "USD", note: "Owe 300 USD uber" }, "EGP").currency,
    ).toBe("USD");
  });
});

describe("confirm payloads", () => {
  const baseState: CardFormState = {
    kind: "iou",
    amount: "42.50",
    currency: "usd",
    direction: "credit",
    note: "dinner",
    date: "2026-06-24",
  };

  it("emits an EntryDraft accepted by the existing importer", () => {
    const payload = buildConfirmPayload(baseState);
    expect(payload).toMatchObject({
      kind: "iou",
      amount: 42.5,
      currency: "USD",
      direction: "credit",
      note: "dinner",
      date: "2026-06-24",
    });
    const result = parseDraft(payload);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.initial.amount_minor).toBe(4250);
  });

  it("keeps an invalid amount raw so downstream validation reports it", () => {
    const payload = buildConfirmPayload({ ...baseState, amount: "" });
    expect(payload.amount).toBe("");
    expect(parseDraft(payload).ok).toBe(false);
  });

  it("preserves evidence text but omits empty optional fields", () => {
    const payload = buildConfirmPayload({
      ...baseState,
      kind: "",
      currency: "",
      date: "",
      message: "Dinner 42.50",
    });
    expect(payload.message).toBe("Dinner 42.50");
    expect("kind" in payload).toBe(false);
    expect("currency" in payload).toBe(false);
    expect("date" in payload).toBe(false);
  });
});

describe("outbound bridge messages", () => {
  it("binds every message to version 2 and the exact frame nonce", () => {
    expect(buildReady(FRAME_NONCE)).toEqual({
      type: CARD_MSG.ready,
      version: CARD_INIT_VERSION,
      frameNonce: FRAME_NONCE,
    });
    expect(buildPrivateContextReady(FRAME_NONCE, RECIPIENT_PUBLIC_KEY)).toEqual({
      type: CARD_MSG.privateContextReady,
      version: CARD_INIT_VERSION,
      frameNonce: FRAME_NONCE,
      privateContext: {
        recipientKeyScheme: CARD_RECIPIENT_KEY_SCHEME,
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
      },
    });
    expect(buildResize(FRAME_NONCE, 320)).toEqual({
      type: CARD_MSG.resize,
      version: CARD_INIT_VERSION,
      frameNonce: FRAME_NONCE,
      height: 320,
    });
    const payload = { amount: 1, currency: "USD", direction: "credit" as const };
    expect(buildConfirm(FRAME_NONCE, payload)).toEqual({
      type: CARD_MSG.confirm,
      version: CARD_INIT_VERSION,
      frameNonce: FRAME_NONCE,
      payload,
    });
    expect(buildCancel(FRAME_NONCE)).toEqual({
      type: CARD_MSG.cancel,
      version: CARD_INIT_VERSION,
      frameNonce: FRAME_NONCE,
    });
    expect(() => buildReady("bad")).toThrow();
    expect(() => buildPrivateContextReady(FRAME_NONCE, "bad")).toThrow();
  });

  it("accepts only the nonce-bound host private-context request", () => {
    expect(
      parsePrivateContextRequest(
        {
          type: CARD_MSG.privateContextRequest,
          version: CARD_INIT_VERSION,
          frameNonce: FRAME_NONCE,
        },
        FRAME_NONCE,
      ),
    ).toBe(true);
    expect(
      parsePrivateContextRequest(
        {
          type: CARD_MSG.privateContextRequest,
          version: CARD_INIT_VERSION,
          frameNonce: OTHER_NONCE,
        },
        FRAME_NONCE,
      ),
    ).toBe(false);
    expect(parsePrivateContextRequest({ type: CARD_MSG.ready }, FRAME_NONCE)).toBe(false);
  });

  it("uses the same confirm envelope for a multi-entry array", () => {
    const payload = [
      { amount: 1, currency: "USD", direction: "credit" as const },
      { amount: 2, currency: "EUR", direction: "debt" as const },
    ];
    expect(buildConfirm(FRAME_NONCE, payload).payload).toEqual(payload);
  });
});

describe("host busy signal", () => {
  it("accepts only a versioned, nonce-bound boolean", () => {
    expect(
      parseBusy(
        { type: CARD_MSG.busy, version: CARD_INIT_VERSION, frameNonce: FRAME_NONCE, busy: true },
        FRAME_NONCE,
      ),
    ).toEqual({ busy: true });
    expect(
      parseBusy(
        { type: CARD_MSG.busy, version: CARD_INIT_VERSION, frameNonce: OTHER_NONCE, busy: true },
        FRAME_NONCE,
      ),
    ).toBeNull();
    expect(parseBusy({ type: CARD_MSG.busy, version: 1, frameNonce: FRAME_NONCE, busy: true }, FRAME_NONCE)).toBeNull();
    expect(
      parseBusy(
        { type: CARD_MSG.busy, version: CARD_INIT_VERSION, frameNonce: FRAME_NONCE, busy: "yes" },
        FRAME_NONCE,
      ),
    ).toBeNull();
    expect(parseBusy(null, FRAME_NONCE)).toBeNull();
  });
});

describe("multi-entry cards", () => {
  it("filters non-object rows and caps an oversized init", () => {
    const many = Array.from({ length: 5000 }, (_, index) => ({ amount: index + 1 }));
    expect(parseInit(validInit({ entries: many }), FRAME_NONCE)?.data.entries).toHaveLength(MAX_CARD_ENTRIES);
    expect(
      parseInit(validInit({ entries: [{ amount: 1 }, 5, null, "x", { amount: 2 }] }), FRAME_NONCE)
        ?.data.entries,
    ).toHaveLength(2);
  });

  it("seeds each row independently and keeps the single path unchanged", () => {
    const states = initEntries({
      entries: [
        { amount: 100, currency: "EGP", direction: "debt", note: "rent 100 EGP" },
        { amount: 5, currency: "USD", direction: "credit", note: "lunch 5 USD" },
      ],
    });
    expect(states).toHaveLength(2);
    expect(states?.[0].currency).toBe("EGP");
    expect(states?.[1]).toEqual(
      initToFormState({ amount: 5, currency: "USD", direction: "credit", note: "lunch 5 USD" }),
    );
    expect(initEntries({ amount: 5 })).toBeNull();
    expect(initEntries({ entries: [] })).toBeNull();
  });

  it("round-trips each row through the existing batch parser", () => {
    const payload = buildMultiConfirmPayload([
      { kind: "", amount: "10", currency: "", direction: "credit", note: "a", date: "" },
      { kind: "", amount: "20", currency: "eur", direction: "debt", note: "b", date: "" },
    ]);
    expect(Array.isArray(payload)).toBe(true);
    expect("currency" in payload[0]).toBe(false);
    const result = parseDraftBatch(payload, undefined, "EGP");
    expect(result.errors).toEqual([]);
    expect(result.drafts.map((draft) => draft.initial.currency)).toEqual(["EGP", "EUR"]);
    expect(batchSummary(result)).toContain("2 entries");
  });
});

describe("registered card fields survive init to confirm", () => {
  it("carries every public registered row without reintroducing private type metadata", async () => {
    const { buildManifestWire } = await import("./registerAiApp");
    const wire = buildManifestWire("") as unknown as {
      actions: { card: { rows: { field: string; label: string }[] } }[];
    };
    const rows = wire.actions[0].card.rows;
    expect(rows.length).toBeGreaterThan(0);
    const payload = buildConfirmPayload(
      initToFormState({
        kind: "iou",
        amount: 250,
        currency: "EUR",
        direction: "debt",
        date: "2026-07-30",
        note: "deposit",
        message: "Reservation deposit 250 EUR",
        template: "Reservation",
      }),
    ) as Record<string, unknown>;
    for (const row of rows) {
      expect(payload[row.field], "registered row was dropped: " + row.label).toBeDefined();
    }
    expect("template" in payload).toBe(false);
    expect("template_ref" in payload).toBe(false);
  });
});

describe("private account type handoff", () => {
  const state: CardFormState = {
    ...initToFormState({ amount: 1000, note: "reservation deposit" }),
    templateId: "private-template-id",
  };

  it("never trusts or round-trips a plaintext type from extraction data", () => {
    const fromHost = initToFormState({
      amount: 1000,
      note: "deposit",
      template: "Reservation",
    });
    expect(fromHost.templateId).toBeUndefined();
    const payload = buildConfirmPayload(fromHost) as Record<string, unknown>;
    expect("template" in payload).toBe(false);
    expect("template_ref" in payload).toBe(false);
  });

  it("emits only a structurally valid opaque encrypted reference", () => {
    const reference = structuralTemplateRef(5);
    const payload = buildConfirmPayload(state, reference) as Record<string, unknown>;
    expect(payload.template_ref).toBe(reference);
    expect("template" in payload).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("private-template-id");
    expect(JSON.stringify(payload)).not.toContain("Reservation");
  });

  it("rejects accidental plaintext or malformed references", () => {
    expect("template_ref" in buildConfirmPayload(state, "Reservation")).toBe(false);
    expect("template_ref" in buildConfirmPayload(state, TEMPLATE_REF_PREFIX + "not-canonical=")).toBe(false);
    expect("template_ref" in buildConfirmPayload(state)).toBe(false);
  });

  it("keeps encrypted selections independent across multi-entry rows", () => {
    const states: CardFormState[] = [
      { ...state, templateId: "private-a" },
      { ...state, templateId: undefined, amount: "200" },
      { ...state, templateId: "private-b", amount: "300" },
    ];
    const references = [structuralTemplateRef(6), undefined, structuralTemplateRef(7)];
    const payload = buildMultiConfirmPayload(states, references);
    expect(payload.map((entry) => entry.template_ref)).toEqual(references);
    const json = JSON.stringify(payload);
    expect(json).not.toContain("private-a");
    expect(json).not.toContain("private-b");
  });
});
