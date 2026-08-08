// AUTOMATED live journey (P0-30/32 class): pairing → propose → confirm → confirmer deposit, asserted.
//
//   manager (browser :19241, IOU tab same profile)  ──┐ direct chat
//   father  (desktop OC :19222, IOU tab :19231)    ──┘
//
// Steps (each asserted; exit 1 on any failure):
//   1. Resolve the manager↔father direct chat + both OC user ids from the chat URLs.
//   2. Ensure BOTH signed-in IOU profiles have an authenticated inbox selector; any member missing
//      one is paired live via the real UI: OC AI-apps → Connect → read the claim token → IOU
//      /settings → claim. (The connect flow itself is part of the journey.)
//   3. Snapshot both members' action_inbox fingerprint buckets.
//   4. manager sends a fresh chat message and proposes via the DETERMINISTIC manual-JSON path
//      (browser clients prompt for the extraction JSON — no on-device model, no nondeterminism).
//   5. father (the NON-proposer) confirms the card.
//   6. Assert ONE confirm deposited exactly +1 envelope into the confirmer's own bucket and did not
//      leak a copy into the non-confirmer's account.
//   7. On the confirmer's IOU page, follow the draft's authoritative chat route, press
//      "Review & add", submit the prefilled EntryForm, and assert this run's nonce in History.
//      The exact nonce-scoped entry is soft-deleted afterwards so repeated runs do not affect
//      balances (the canister intentionally retains its audit tombstone).
//
// Repeatable: assertions are relative to the before-counts. Requires the live env (replica :8080,
// OC :5003, IOU :3000, CDP 19241/19222/19231 — local untracked launch.ps1 + restore-all.sh).
//
//   pnpm exec tsx scripts/live/journey-fanout.ts
import {
  chromium,
  type Frame,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";
import { Actor, HttpAgent } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { CDP_PORTS } from "./cdpPorts";
import {
  assertAcceptedVisionExtraction,
  classifySentImageResource,
  isImmediateStableSuccessor,
  journeySourceText,
  matchesExactImageContentEvidence,
  matchesRunCardCandidate,
  matchesStableDraftMessageBoundary,
  retainsNonceBoundCardEvidence,
  sameStableMessage,
  selectFreshOwnedSourceCandidate,
  shouldRetryExactMessageDeletion,
  type ExactImageContentEvidence,
  type FreshSourceCandidate,
  type StableDraftMessageBoundary,
  type StableMessageRef,
} from "./journeySafety";
import { OPENCHAT_MESSAGE_TEXT_SELECTOR } from "./openChatArtifactCleanup";
import {
  installManualPromptOverride,
  readManualPromptProbe,
  removeManualPromptOverride,
  type ManualPromptOverrideHandle,
} from "./temporaryBrowserTab";

const require = createRequire(import.meta.url);
const { Packr } = require("C:/Kiko/MyProjects/Blockchain/ICP/open-chat-cycle/frontend/node_modules/msgpackr");
const packer = new Packr({ useRecords: false, skipValues: [null, undefined], largeBigIntToString: true });

const HOST = "http://127.0.0.1:8080";
const IOU_BASE = "http://127.0.0.1:3000";
// A paired card has two independently bounded asynchronous phases after its public fields render:
// the host mints a 30s private-context capability, then the IOU frame has 30s to hydrate and return
// the exact capability-bound ready status. Give both phases one bounded live-journey window.
const HOST_ADD_HYDRATION_TIMEOUT_MS = 65_000;

// Current canister ids from IOU's .env.local — never hardcode (they change on every clean redeploy).
function envIds(): { userIndex: string; inbox: string } {
  const env = readFileSync("C:/Kiko/MyProjects/IOU/.env.local", "utf8");
  const get = (k: string) => new RegExp(`${k}=([a-z0-9-]+)`).exec(env)?.[1];
  const userIndex = get("VITE_OC_USER_INDEX_CANISTER_ID");
  const inbox = get("VITE_ACTION_INBOX_CANISTER_ID");
  if (!userIndex || !inbox) throw new Error(".env.local missing user_index / action_inbox ids");
  return { userIndex, inbox };
}
const IDS = envIds();

let failures = 0;
function check(cond: boolean, label: string): void {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) failures++;
}

function cleanupCheck(cond: boolean, label: string): void {
  try {
    check(cond, label);
  } catch (error) {
    failures++;
    console.error(`[cleanup] assertion reporting failed (${label}): ${(error as Error).message}`);
  }
}

async function proposalFailureText(page: Page): Promise<string | null> {
  const toast = page.locator(".toast .message.failure").last();
  if (!(await toast.isVisible().catch(() => false))) return null;
  const text = (await toast.innerText().catch(() => "")).trim();
  if (!text) return null;
  // Failure messages should not contain credentials, but keep diagnostics safe if a backend ever
  // starts echoing a URL, claim code, or opaque identifier into one.
  return text
    .replace(/([?&](?:token|code|claim|credential)[^=]*)=[^\s&]+/gi, "$1=<redacted>")
    .replace(/\b[a-z0-9]{5}(?:-[a-z0-9]{3,5}){2,}\b/gi, "<id>")
    .slice(0, 240);
}

type ImageModelReadiness = {
  available: boolean;
  canInfer: boolean;
  selectedModelId?: string;
  selectedModalities: string[];
};

async function waitForImageModelReady(
  page: Page,
  timeoutMs = 60_000,
): Promise<ImageModelReadiness> {
  if (new URL(page.url()).searchParams.has("manualExtract")) {
    throw new Error("real-model journey refuses a manualExtract URL");
  }
  const deadline = Date.now() + timeoutMs;
  let last: ImageModelReadiness | null = null;
  while (Date.now() < deadline) {
    last = (await page.evaluate(`(async () => {
      const inference = await import("/src/utils/onDeviceInference.ts");
      const capability = inference.onDeviceInferenceCapability();
      return {
        available: capability.available === true,
        canInfer: inference.canInferOnDevice() === true,
        selectedModelId: capability.selectedModelId,
        selectedModalities: Array.isArray(capability.selectedModalities)
          ? [...capability.selectedModalities]
          : [],
      };
    })()`)) as ImageModelReadiness;
    if (
      last.available &&
      last.canInfer &&
      last.selectedModalities.includes("image")
    ) {
      return last;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    `local image model was not ready before chat mutation: ${JSON.stringify(last)}`,
  );
}

async function requireExactlyOneCardControl(
  frame: FrameLocator,
  label: string,
): Promise<Locator> {
  const control = frame.getByLabel(label, { exact: true });
  const count = await control.count();
  if (count !== 1) {
    throw new Error(`IOU card expected exactly one ${label} control, found ${count}`);
  }
  return control;
}

async function hasAuthoritativeIouIdentity(card: Locator): Promise<boolean> {
  const appName = card.locator(".app-name");
  return (
    (await appName.count().catch(() => 0)) === 1 &&
    (await appName.innerText().catch(() => "")).trim().toLocaleLowerCase("en-US") === "iou"
  );
}

async function assertTrustedIouCardChrome(loaded: LoadedRunCard): Promise<void> {
  if (!(await hasAuthoritativeIouIdentity(loaded.card))) {
    throw new Error("trusted card did not render the authoritative IOU app name");
  }

  const logo = loaded.card.locator("img.app-icon");
  await logo.waitFor({ state: "visible", timeout: 10_000 });
  const expectedLogo = `${IOU_BASE}/favicon.svg`;
  const logoSource = await logo.getAttribute("src");
  if (logoSource !== expectedLogo) {
    throw new Error(`trusted card logo was ${logoSource ?? "missing"}; expected ${expectedLogo}`);
  }

  const exactUrl = `${IOU_BASE}/openchat/card`;
  const url = loaded.card.locator(".card-url");
  if ((await url.count()) !== 1 || (await url.innerText()).trim() !== exactUrl) {
    throw new Error("trusted card did not keep its exact registered card URL visible");
  }

  for (const obsolete of ["Load app card", "Share app context"] as const) {
    if (
      await loaded.card
        .getByRole("button", { name: obsolete, exact: true })
        .isVisible()
        .catch(() => false)
    ) {
      throw new Error(`trusted card unexpectedly requires ${obsolete}`);
    }
  }
  const explanation = loaded.card
    .getByText(
      /Loading contacts this external origin|If you separately grant private context|Capabilities never enter this URL/i,
    )
    .first();
  if (await explanation.isVisible().catch(() => false)) {
    throw new Error("trusted card still renders obsolete protocol explanation text");
  }

  const type = await requireExactlyOneCardControl(loaded.frame, "Type");
  await requireExactlyOneCardControl(loaded.frame, "Saved type");
  await requireExactlyOneCardControl(loaded.frame, "Date");
  if ((await type.inputValue()) !== "iou") {
    throw new Error("trusted card did not expose the extracted public Type from first render");
  }
}

async function agent(): Promise<HttpAgent> {
  const a = new HttpAgent({ host: HOST });
  await a.fetchRootKey();
  return a;
}

async function msgpackQuery(a: HttpAgent, canisterId: string, method: string, args: unknown): Promise<any> {
  const resp = await a.query(Principal.fromText(canisterId), {
    methodName: `${method}_msgpack`,
    arg: new Uint8Array(packer.pack(args)),
  });
  if (resp.status !== "replied") throw new Error(`${method}_msgpack rejected`);
  return packer.unpack(new Uint8Array((resp as any).reply.arg));
}

async function iouAppId(a: HttpAgent): Promise<number> {
  const resp = await msgpackQuery(a, IDS.userIndex, "ai_apps", {});
  const iou = (resp?.Success?.apps ?? []).find((x: any) => x?.manifest?.name === "iou");
  if (!iou) throw new Error("iou app not registered on the user_index");
  return Number(iou.id);
}

const inboxIdl = ({ IDL: idl }: any) => {
  const Args = idl.Record({ max_results: idl.Nat32, consumer_key_fingerprint: idl.Vec(idl.Nat8), since_id: idl.Nat64 });
  const StoredAction = idl.Record({
    id: idl.Nat64, ciphertext: idl.Vec(idl.Nat8), ephemeral_public_key: idl.Vec(idl.Nat8),
    created_at: idl.Nat64, oc_signature: idl.Vec(idl.Nat8),
  });
  return idl.Service({
    actions: idl.Func([Args], [idl.Variant({ Success: idl.Record({ actions: idl.Vec(StoredAction) }) })], []),
  });
};

async function bucketCount(a: HttpAgent, fp: Uint8Array): Promise<number> {
  const actor: any = Actor.createActor(inboxIdl, { agent: a, canisterId: IDS.inbox });
  const resp = await actor.actions({ max_results: 500, consumer_key_fingerprint: Array.from(fp), since_id: 0n });
  return resp.Success.actions.length;
}

// ONE CDP connection per port keeps page identity and authenticated state stable across the journey.
const connections = new Map<number, ReturnType<typeof chromium.connectOverCDP>>();
async function attach(port: number, urlPart: string): Promise<Page> {
  if (!connections.has(port)) connections.set(port, chromium.connectOverCDP(`http://127.0.0.1:${port}`));
  const browser = await connections.get(port)!;
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes(urlPart)) ?? ctx.pages()[0];
  if (!page) throw new Error(`no page on :${port}`);
  return page;
}

type InboxPairingState = {
  selector: Uint8Array | null;
  current: boolean;
  bindingRevision: string | null;
  configuredRevision: string | null;
};

async function actionInboxState(page: Page): Promise<InboxPairingState> {
  // Keep this browser-native: tsx/esbuild's keepNames transform injects its Node-side __name helper
  // into nested callbacks, but Playwright serializes only the callback body into the page.
  const state = (await page.evaluate(`(async () => {
    const inbox = await import("/src/features/openchat/actionInboxClient.ts");
    const auth = await import("/src/features/auth/AuthProvider.tsx");
    const declarations = await import("/src/backend/declarations.ts");
    const identity = auth.loadDevIdentityForDiagnostics();
    if (!identity) throw new Error("signed-in local development identity is required");
    const actor = declarations.createActor(await auth.buildAgent(identity));
    const config = await inbox.getActionInboxConfig(actor);
    const binding = (await actor.get_openchat_binding())[0];
    const configured = (await actor.get_config()).ai_app_verification_binding[0];
    const samePrincipal = (left, right) => left?.toText() === right?.toText();
    const selector = config ? Array.from(config.consumerKeySelector) : null;
    const selectorMatches =
      selector !== null &&
      binding !== undefined &&
      selector.length === binding.consumer_queue_selector.length &&
      selector.every((byte, index) => byte === binding.consumer_queue_selector[index]);
    const current = Boolean(
      config &&
      binding &&
      configured &&
      binding.app_id === configured.app_id &&
      binding.app_revision === configured.app_revision &&
      samePrincipal(binding.app_canister_id, configured.app_canister_id) &&
      samePrincipal(binding.user_index_canister_id, configured.user_index_canister_id) &&
      selectorMatches
    );
    return {
      selector,
      current,
      bindingRevision: binding?.app_revision?.toString() ?? null,
      configuredRevision: configured?.app_revision?.toString() ?? null,
    };
  })()`)) as {
    selector: number[] | null;
    current: boolean;
    bindingRevision: string | null;
    configuredRevision: string | null;
  };
  return {
    ...state,
    selector: state.selector === null ? null : Uint8Array.from(state.selector),
  };
}

type LoadedRunCard = {
  card: Locator;
  frame: FrameLocator;
  observerId: string;
  loadedAutomatically: boolean;
  message: ChatMessageRef;
};

type ChatMessageRef = StableMessageRef;

type StableMessageBaseline = Readonly<{
  messageIds: ReadonlySet<string>;
  maxMessageIndex: number;
  maxEventIndex: number;
}>;

type RunCardCorrelation = Readonly<{
  expectedSource?: ChatMessageRef;
  expectedMessage?: ChatMessageRef;
  requireSenderOwned?: boolean;
}>;

type SourceMessageEvidence =
  | { kind: "text"; exactText: string }
  | {
      kind: "image";
      exactContent: ExactImageContentEvidence;
      exactDraftUrl: string;
    };

type ExactDraftSelectionBoundary = Readonly<{
  footerMarker: string;
  messageBoundary: StableDraftMessageBoundary;
}>;

type ExactPartialDraftBinding = ExactDraftSelectionBoundary &
  Readonly<{
    draftUrl: string;
  }>;

type ExactDraftImageBinding = ExactPartialDraftBinding &
  Readonly<{
    exactContent: ExactImageContentEvidence;
  }>;

type ExactOptimisticSourceBinding = Readonly<{
  boundMessage: ChatMessageRef;
  boundDraftUrl: string;
}>;

type ExactSourceMessageEvidence = Readonly<{
  kind: "source";
  evidence: SourceMessageEvidence;
  optimisticBinding?: ExactOptimisticSourceBinding;
}>;

type ExactCardMessageEvidence = Readonly<{
  kind: "card";
  observerId: string;
  boundMessage: ChatMessageRef;
  boundExactNote: string;
}>;

type ExactMessageEvidence =
  | ExactSourceMessageEvidence
  | ExactCardMessageEvidence;

type ExactMessageDeletionTarget = Readonly<{
  message: ChatMessageRef;
  evidence: ExactMessageEvidence;
}>;

type NonceBoundRunCard = LoadedRunCard &
  Readonly<{
    deletionEvidence: ExactCardMessageEvidence;
  }>;

const MESSAGE_WRAPPER_SELECTOR = '[data-id][data-index][id^="event-"]';
const ATTACHMENT_IMAGE_SELECTOR =
  '.img-wrapper > img.unzoomed:not(.draft), .regular_image_content img.image:not(.draft)';
const MESSAGE_DELETED_TEXT = /^Message deleted by .+ on .+$/i;
const DRAFT_FOOTER_MARKER_ATTRIBUTE = "data-iou-journey-draft-footer";
const CLOSE_ICON_PATH =
  "M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z";

function exactMessageWrapper(page: Page, message: ChatMessageRef): Locator {
  return page.locator(
    `[data-id="${message.messageId}"][data-index="${message.messageIndex}"][id="event-${message.eventIndex}"]`,
  );
}

async function messageRefFromWrapper(wrapper: Locator, label: string): Promise<ChatMessageRef> {
  const count = await wrapper.count();
  if (count !== 1) throw new Error(`${label}: expected one exact message wrapper, found ${count}`);
  const [messageId, rawMessageIndex, rawEventId] = await Promise.all([
    wrapper.getAttribute("data-id"),
    wrapper.getAttribute("data-index"),
    wrapper.getAttribute("id"),
  ]);
  const eventMatch = /^event-(\d+)$/.exec(rawEventId ?? "");
  if (!/^\d+$/.test(messageId ?? "") || !/^\d+$/.test(rawMessageIndex ?? "") || !eventMatch) {
    throw new Error(`${label}: message wrapper has invalid stable coordinates`);
  }
  return {
    messageId: messageId!,
    messageIndex: Number(rawMessageIndex),
    eventIndex: Number(eventMatch[1]),
  };
}

async function captureStableMessageBaseline(page: Page): Promise<StableMessageBaseline> {
  const observed = await page.locator(MESSAGE_WRAPPER_SELECTOR).evaluateAll((wrappers) => {
    const records: Array<{ messageId: string; messageIndex: number; eventIndex: number }> = [];
    let invalid = 0;
    for (const wrapper of wrappers) {
      const messageId = wrapper.getAttribute("data-id") ?? "";
      const rawMessageIndex = wrapper.getAttribute("data-index") ?? "";
      const event = /^event-(\d+)$/.exec(wrapper.getAttribute("id") ?? "");
      if (!/^\d+$/.test(messageId) || !/^\d+$/.test(rawMessageIndex) || event === null) {
        invalid++;
        continue;
      }
      const messageIndex = Number(rawMessageIndex);
      const eventIndex = Number(event[1]);
      if (!Number.isSafeInteger(messageIndex) || !Number.isSafeInteger(eventIndex)) {
        invalid++;
        continue;
      }
      records.push({ messageId, messageIndex, eventIndex });
    }
    return { records, invalid };
  });
  if (observed.invalid !== 0) {
    throw new Error(`source baseline contains ${observed.invalid} invalid stable message wrapper(s)`);
  }
  return {
    messageIds: new Set(observed.records.map((record) => record.messageId)),
    maxMessageIndex: observed.records.reduce(
      (maximum, record) => Math.max(maximum, record.messageIndex),
      -1,
    ),
    maxEventIndex: observed.records.reduce(
      (maximum, record) => Math.max(maximum, record.eventIndex),
      -1,
    ),
  };
}

async function captureStableDraftMessageBoundary(
  page: Page,
): Promise<StableDraftMessageBoundary> {
  const observed = await page.locator(MESSAGE_WRAPPER_SELECTOR).evaluateAll(
    (wrappers, { textSelector, attachmentSelector }) => {
      const records: Array<{
        messageId: string;
        messageIndex: number;
        eventIndex: number;
        stableEvidence: string;
      }> = [];
      let invalid = 0;
      for (const wrapper of wrappers as HTMLElement[]) {
        const messageId = wrapper.dataset.id ?? "";
        const rawMessageIndex = wrapper.dataset.index ?? "";
        const event = /^event-(\d+)$/.exec(wrapper.id);
        if (!/^\d+$/.test(messageId) || !/^\d+$/.test(rawMessageIndex) || event === null) {
          invalid++;
          continue;
        }
        const messageIndex = Number(rawMessageIndex);
        const eventIndex = Number(event[1]);
        if (!Number.isSafeInteger(messageIndex) || !Number.isSafeInteger(eventIndex)) {
          invalid++;
          continue;
        }
        const texts: string[] = [];
        for (const node of wrapper.querySelectorAll<HTMLElement>(textSelector)) {
          const normalized = node.innerText.replace(/\s+/g, " ").trim();
          if (normalized !== "") texts.push(normalized);
        }
        texts.sort();

        const attachmentImageCount = wrapper.querySelectorAll(attachmentSelector).length;

        const cardIdentities: string[] = [];
        for (const card of wrapper.querySelectorAll<HTMLElement>(".action-card")) {
          const title = card.querySelector(".title")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
          const appName =
            card.querySelector(".app-name")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
          cardIdentities.push(`${title}\u0000${appName}`);
        }
        cardIdentities.sort();

        records.push({
          messageId,
          messageIndex,
          eventIndex,
          stableEvidence: JSON.stringify({
            senderOwned:
              wrapper.classList.contains("me") ||
              (wrapper.classList.contains("container") &&
                getComputedStyle(wrapper).justifyContent === "flex-end"),
            texts,
            attachmentImageCount,
            cardIdentities,
          }),
        });
      }
      records.sort(
        (left, right) =>
          left.messageIndex - right.messageIndex || left.eventIndex - right.eventIndex,
      );
      return { records, invalid };
    },
    {
      textSelector: OPENCHAT_MESSAGE_TEXT_SELECTOR,
      attachmentSelector: ATTACHMENT_IMAGE_SELECTOR,
    },
  );
  if (observed.invalid !== 0) {
    throw new Error(`draft boundary contains ${observed.invalid} invalid stable wrapper(s)`);
  }
  const records = await Promise.all(
    observed.records.map(async ({ stableEvidence, ...message }) => {
      const bytes = new TextEncoder().encode(stableEvidence);
      const hash = new Uint8Array(await webcrypto.subtle.digest("SHA-256", bytes));
      return {
        ...message,
        evidenceDigest: [...hash]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
      };
    }),
  );
  const boundary: StableDraftMessageBoundary = {
    maxMessageIndex: records.reduce(
      (maximum, record) => Math.max(maximum, record.messageIndex),
      -1,
    ),
    maxEventIndex: records.reduce(
      (maximum, record) => Math.max(maximum, record.eventIndex),
      -1,
    ),
    records,
  };
  if (!matchesStableDraftMessageBoundary(boundary, boundary)) {
    throw new Error("draft boundary contains ambiguous stable message coordinates");
  }
  return boundary;
}

async function assertStableDraftMessageBoundary(
  page: Page,
  expected: StableDraftMessageBoundary,
  label: string,
): Promise<void> {
  const observed = await captureStableDraftMessageBoundary(page);
  if (!matchesStableDraftMessageBoundary(expected, observed)) {
    throw new Error(label);
  }
}

async function digestImageResource(
  page: Page,
  url: string,
  requireUploaded: boolean,
  label: string,
): Promise<ExactImageContentEvidence> {
  if (requireUploaded) {
    if (url.startsWith("blob:")) {
      throw new Error(`${label}: image is still using its draft blob URL`);
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${label}: uploaded image URL is invalid`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`${label}: uploaded image URL uses an unsupported protocol`);
    }
  } else if (!url.startsWith("blob:")) {
    throw new Error(`${label}: draft image did not expose a blob URL`);
  }

  try {
    return await page.evaluate(async (resourceUrl) => {
      const response = await fetch(resourceUrl, {
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength === 0) throw new Error("empty image body");
      const mimeType = (response.headers.get("content-type") ?? "")
        .split(";", 1)[0]
        .trim()
        .toLocaleLowerCase("en-US");
      if (!mimeType.startsWith("image/")) throw new Error("missing image MIME type");
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      return {
        sha256: [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
        byteLength: bytes.byteLength,
        mimeType,
      };
    }, url);
  } catch (error) {
    throw new Error(`${label}: exact image bytes could not be verified: ${(error as Error).message}`);
  }
}

async function digestUploadedAttachmentImage(
  page: Page,
  url: string,
  label: string,
): Promise<ExactImageContentEvidence> {
  return digestImageResource(page, url, true, label);
}

async function assertNoPreexistingDraftAttachment(page: Page, composer: Locator): Promise<void> {
  const visibleDraftMedia = await visibleMatches(
    page.locator(
      ".footer img.draft, .footer video.draft, .footer audio.draft, .footer a.draft, .footer .draft-container .msg-preview",
    ),
  );
  const visibleAttachmentStates = await visibleMatches(
    page.locator(".footer .message_entry_wrapper.has_attachment"),
  );
  if (visibleDraftMedia.length !== 0 || visibleAttachmentStates.length !== 0) {
    throw new Error(
      `image journey refuses to replace a pre-existing draft attachment (${visibleDraftMedia.length} media/${visibleAttachmentStates.length} mobile states)`,
    );
  }
  if ((await composer.innerText()).replace(/\s+/g, " ").trim() !== "") {
    throw new Error("image journey requires an empty composer before selecting its attachment");
  }
}

async function prepareExactDraftAttachmentSelection(
  page: Page,
  composer: Locator,
  footerMarker: string,
): Promise<ExactDraftSelectionBoundary> {
  await assertNoPreexistingDraftAttachment(page, composer);
  if (!/^[a-z0-9-]+$/i.test(footerMarker)) {
    throw new Error("image journey draft footer marker is invalid");
  }
  if ((await page.locator(`[${DRAFT_FOOTER_MARKER_ATTRIBUTE}]`).count()) !== 0) {
    throw new Error("image journey found a pre-existing draft footer marker");
  }
  const footer = composer.locator(
    'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " footer ")][1]',
  );
  if ((await footer.count()) !== 1 || !(await footer.isVisible())) {
    throw new Error("image journey composer is not attached to one visible footer");
  }
  const composers = await visibleMatches(footer.locator(".ProseMirror"));
  if (composers.length !== 1) {
    throw new Error(`image journey footer contains ${composers.length} visible composers`);
  }
  const expectedComposer = await composer.elementHandle();
  if (expectedComposer === null) throw new Error("image journey composer detached before binding");
  let sameComposer = false;
  try {
    sameComposer = await composers[0].evaluate((node, expected) => node === expected, expectedComposer);
  } finally {
    await expectedComposer.dispose();
  }
  if (!sameComposer) throw new Error("image journey selected composer changed exact footer identity");

  const messageBoundary = await captureStableDraftMessageBoundary(page);
  await footer.evaluate(
    (node, { attribute, footerMarker }) => {
      if (node.hasAttribute(attribute)) throw new Error("draft footer marker already exists");
      node.setAttribute(attribute, footerMarker);
    },
    { attribute: DRAFT_FOOTER_MARKER_ATTRIBUTE, footerMarker },
  );
  return { footerMarker, messageBoundary };
}

async function installExactDraftBlobCapture(page: Page): Promise<void> {
  // A blob URL can be rendered by an <img> while fetch(blobUrl) from an automation evaluation
  // realm is rejected. Capture the exact processed Blob at its creation point instead. This hook
  // is installed only around file selection and is restored before the message is sent.
  const installed = await page.evaluate<boolean>(`(() => {
    const root = globalThis;
    if (root.__iouExactDraftBlobCapture !== undefined) return false;
    const originalCreateObjectURL = URL.createObjectURL;
    const captured = new Map();
    const state = {
      active: true,
      originalCreateObjectURL,
      captureCreateObjectURL: undefined,
      captured,
    };
    const captureCreateObjectURL = function (object) {
      const url = originalCreateObjectURL.call(URL, object);
      if (state.active && object instanceof Blob) captured.set(url, object);
      return url;
    };
    state.captureCreateObjectURL = captureCreateObjectURL;
    root.__iouExactDraftBlobCapture = state;
    URL.createObjectURL = captureCreateObjectURL;
    if (URL.createObjectURL !== captureCreateObjectURL) {
      state.active = false;
      captured.clear();
      delete root.__iouExactDraftBlobCapture;
      return false;
    }
    return true;
  })()`);
  if (!installed) throw new Error("image journey draft Blob capture was already installed");
}

async function retainExactPartialDraftBinding(
  page: Page,
  binding: ExactDraftSelectionBoundary,
): Promise<ExactPartialDraftBinding> {
  const exactDraft = await exactlyOneVisible(
    page.locator('img.draft[src^="blob:"]'),
    "image journey draft attachment",
    15_000,
  );
  const draftUrl = await exactDraft.evaluate((node) => (node as HTMLImageElement).src);
  if (!draftUrl.startsWith("blob:")) throw new Error("selected image draft URL is not a blob URL");
  const markedFooters = await visibleMatches(
    page.locator(
      `[${DRAFT_FOOTER_MARKER_ATTRIBUTE}=${JSON.stringify(binding.footerMarker)}]`,
    ),
  );
  if (markedFooters.length !== 1) {
    throw new Error(`selected image draft has ${markedFooters.length} exact marked footers`);
  }
  const footer = exactDraft.locator(
    `xpath=ancestor::*[@${DRAFT_FOOTER_MARKER_ATTRIBUTE}=${JSON.stringify(binding.footerMarker)}][1]`,
  );
  if ((await footer.count()) !== 1 || !(await footer.isVisible())) {
    throw new Error("selected image draft left its exact marked footer");
  }
  const composers = await visibleMatches(footer.locator(".ProseMirror"));
  if (
    composers.length !== 1 ||
    (await composers[0].innerText()).replace(/\s+/g, " ").trim() !== ""
  ) {
    throw new Error("selected image draft does not share one empty composer in its exact footer");
  }
  return { ...binding, draftUrl };
}

async function captureExactDraftImageContent(
  page: Page,
  binding: ExactPartialDraftBinding,
): Promise<ExactDraftImageBinding> {
  const images = await visibleMatches(page.locator('img.draft[src^="blob:"]'));
  const exactImages: Locator[] = [];
  for (const image of images) {
    if ((await image.evaluate((node) => (node as HTMLImageElement).src)) === binding.draftUrl) {
      exactImages.push(image);
    }
  }
  if (exactImages.length !== 1) {
    throw new Error(
      `image journey exact draft attachment is ambiguous (${exactImages.length} matches)`,
    );
  }
  await exactImages[0].evaluate((node) => (node as HTMLImageElement).decode());
  const draftUrl = binding.draftUrl;
  try {
    const exactContent = await page.evaluate<ExactImageContentEvidence>(`(async () => {
      const resourceUrl = ${JSON.stringify(draftUrl)};
      const state = globalThis.__iouExactDraftBlobCapture;
      if (state === undefined) throw new Error("draft Blob capture is unavailable");
      const blob = state.captured.get(resourceUrl);
      if (!(blob instanceof Blob)) throw new Error("visible draft URL was not captured exactly");
      const bytes = await blob.arrayBuffer();
      if (bytes.byteLength === 0) throw new Error("empty image body");
      const mimeType = blob.type.split(";", 1)[0].trim().toLocaleLowerCase("en-US");
      if (!mimeType.startsWith("image/")) throw new Error("missing image MIME type");
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      return {
        sha256: [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
        byteLength: bytes.byteLength,
        mimeType,
      };
    })()`);
    return { ...binding, exactContent };
  } catch (error) {
    throw new Error(
      `image journey draft attachment: exact processed image bytes could not be verified: ${(error as Error).message}`,
    );
  }
}

async function removeExactDraftBlobCapture(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const root = globalThis;
    const state = root.__iouExactDraftBlobCapture;
    if (state === undefined) return "missing";
    const ownsHook = URL.createObjectURL === state.captureCreateObjectURL;
    state.active = false;
    if (ownsHook) URL.createObjectURL = state.originalCreateObjectURL;
    state.captured.clear();
    delete root.__iouExactDraftBlobCapture;
    return ownsHook ? "restored" : "detached";
  })()`);
}

async function clearExactUnsentDraftAttachment(
  page: Page,
  binding: ExactPartialDraftBinding,
): Promise<boolean> {
  if (
    !/^blob:/.test(binding.draftUrl) ||
    !/^[a-z0-9-]+$/i.test(binding.footerMarker) ||
    !matchesStableDraftMessageBoundary(binding.messageBoundary, binding.messageBoundary)
  ) {
    throw new Error("exact unsent draft binding is invalid");
  }
  const exactVisibleDrafts = async (): Promise<Locator[]> => {
    const candidates = await visibleMatches(page.locator('img.draft[src^="blob:"]'));
    const matches: Locator[] = [];
    for (const candidate of candidates) {
      if ((await candidate.evaluate((node) => (node as HTMLImageElement).src)) === binding.draftUrl) {
        matches.push(candidate);
      }
    }
    return matches;
  };
  const drafts = await exactVisibleDrafts();
  if (drafts.length > 1) {
    throw new Error(`exact unsent image draft is ambiguous (${drafts.length} visible matches)`);
  }
  const allImageDrafts = await visibleMatches(page.locator('img.draft[src^="blob:"]'));
  if (drafts.length === 1 && allImageDrafts.length !== 1) {
    throw new Error(
      `exact unsent image draft is not the sole visible image draft (${allImageDrafts.length} total)`,
    );
  }

  const markedFooters = await visibleMatches(
    page.locator(
      `[${DRAFT_FOOTER_MARKER_ATTRIBUTE}=${JSON.stringify(binding.footerMarker)}]`,
    ),
  );
  if (markedFooters.length !== 1) {
    throw new Error(`exact unsent image draft has ${markedFooters.length} marked footers`);
  }
  const footer = markedFooters[0];
  const composers = await visibleMatches(footer.locator(".ProseMirror"));
  if (composers.length !== 1) {
    throw new Error(
      `exact image draft and composer are not in the same exact footer (${composers.length} composers)`,
    );
  }
  if ((await composers[0].innerText()).replace(/\s+/g, " ").trim() !== "") {
    throw new Error("image draft composer is not empty; refusing attachment-only cleanup");
  }

  await assertStableDraftMessageBoundary(
    page,
    binding.messageBoundary,
    "stable message boundary changed after the exact image draft was bound",
  );
  if (drafts.length === 0) return false;

  const exactDraft = drafts[0];
  const exactMarkedFooter = exactDraft.locator(
    `xpath=ancestor::*[@${DRAFT_FOOTER_MARKER_ATTRIBUTE}=${JSON.stringify(binding.footerMarker)}][1]`,
  );
  if ((await exactMarkedFooter.count()) !== 1) {
    throw new Error("exact unsent image draft is not attached to its same exact footer");
  }
  const mobileContainer = exactDraft.locator(
    'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " message_entry_wrapper ") and contains(concat(" ", normalize-space(@class), " "), " has_attachment ")][1]',
  );
  const visibleMobileContainers = await visibleMatches(mobileContainer);
  if (visibleMobileContainers.length > 1) {
    throw new Error("exact unsent image draft has ambiguous mobile attachment containers");
  }
  const mobileControls =
    visibleMobileContainers.length === 1
      ? await visibleMatches(
          visibleMobileContainers[0].locator(".close > button.icon_button[type=button]"),
        )
      : [];
  const classicControls = await visibleMatches(
    footer.locator(".open-draw > div[role=button]"),
  );
  const controls = [...mobileControls, ...classicControls];
  if (controls.length !== 1) {
    throw new Error(
      `expected one exact draft-removal control, found ${mobileControls.length} mobile/${classicControls.length} classic`,
    );
  }
  const exactClosePath = controls[0].locator(
    `:scope > svg > path[d="${CLOSE_ICON_PATH}"]`,
  );
  if (
    (await exactClosePath.count()) !== 1 ||
    (await controls[0].locator(":scope > svg > path").count()) !== 1
  ) {
    throw new Error("exact draft-removal control does not contain only the canonical Close icon");
  }
  await controls[0].click({ timeout: 10_000 });

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const remainingDrafts = await exactVisibleDrafts();
    const mobileAttachmentState = await visibleMatches(
      footer.locator(".message_entry_wrapper.has_attachment"),
    );
    if (remainingDrafts.length === 0 && mobileAttachmentState.length === 0) break;
    await page.waitForTimeout(100);
  }
  if (
    (await exactVisibleDrafts()).length !== 0 ||
    (await visibleMatches(footer.locator(".message_entry_wrapper.has_attachment"))).length !== 0
  ) {
    throw new Error("unsent draft attachment remained visible after exact removal");
  }
  const afterComposers = await visibleMatches(footer.locator(".ProseMirror"));
  if (
    afterComposers.length !== 1 ||
    (await afterComposers[0].innerText()).replace(/\s+/g, " ").trim() !== ""
  ) {
    throw new Error("same-footer composer changed while removing an unsent draft");
  }
  await assertStableDraftMessageBoundary(
    page,
    binding.messageBoundary,
    "stable message boundary changed while removing an unsent draft",
  );
  return true;
}

async function removeExactDraftFooterMarker(
  page: Page,
  boundary: ExactDraftSelectionBoundary,
): Promise<void> {
  const marked = page.locator(
    `[${DRAFT_FOOTER_MARKER_ATTRIBUTE}=${JSON.stringify(boundary.footerMarker)}]`,
  );
  const count = await marked.count();
  if (count === 0) return;
  if (count !== 1) throw new Error(`draft footer marker is ambiguous (${count} matches)`);
  await marked.evaluate(
    (node, { attribute, footerMarker }) => {
      if (node.getAttribute(attribute) !== footerMarker) {
        throw new Error("draft footer marker identity changed");
      }
      node.removeAttribute(attribute);
    },
    { attribute: DRAFT_FOOTER_MARKER_ATTRIBUTE, footerMarker: boundary.footerMarker },
  );
}

async function sendJourneySource(
  page: Page,
  composer: Locator,
  sourceText: string | undefined,
): Promise<void> {
  await composer.click();
  if (sourceText === undefined) {
    const visibleComposerText = (await composer.innerText()).replace(/\s+/g, " ").trim();
    if (visibleComposerText !== "") {
      throw new Error("image journey refuses to send an attachment with visible caption text");
    }
  } else {
    await page.keyboard.type(sourceText);
  }
  await page.keyboard.press("Enter");
}

type FreshSourceScanCandidate = FreshSourceCandidate &
  Readonly<{
    exactOptimisticBindingMatches: number;
  }>;

type SentImageDomState = Readonly<{
  attributeSrc: string;
  src: string;
  currentSrc: string;
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
}>;

async function freshSourceCandidates(
  page: Page,
  evidence: SourceMessageEvidence,
  baseline: StableMessageBaseline,
): Promise<FreshSourceScanCandidate[]> {
  const domCandidates = await page.locator(MESSAGE_WRAPPER_SELECTOR).evaluateAll(
    (wrappers, { evidence, textSelector, attachmentSelector }) => {
      const candidates: Array<
        FreshSourceCandidate & {
          attachmentStates: SentImageDomState[];
          captionTextCount: number;
          exactOptimisticBindingMatches: number;
        }
      > = [];
      for (const wrapper of wrappers as HTMLElement[]) {
        const messageId = wrapper.dataset.id ?? "";
        const rawMessageIndex = wrapper.dataset.index ?? "";
        const eventMatch = /^event-(\d+)$/.exec(wrapper.id);
        let exactEvidenceMatches = 0;
        if (evidence.kind === "text") {
          const normalizedExpected = evidence.exactText.replace(/\s+/g, " ").trim();
          for (const node of wrapper.querySelectorAll<HTMLElement>(textSelector)) {
            if (
              node.classList.contains("markdown-wrapper") &&
              node.closest(".message_text") !== null
            )
              continue;
            if (node.innerText.replace(/\s+/g, " ").trim() === normalizedExpected) {
              exactEvidenceMatches++;
            }
          }
        }
        let captionTextCount = 0;
        if (evidence.kind === "image") {
          for (const node of wrapper.querySelectorAll<HTMLElement>(textSelector)) {
            if (
              node.classList.contains("markdown-wrapper") &&
              node.closest(".message_text") !== null
            )
              continue;
            if (node.innerText.replace(/\s+/g, " ").trim() !== "") captionTextCount++;
          }
        }
        const classicOwned =
          wrapper.classList.contains("message") && wrapper.classList.contains("me");
        const mobileOwned =
          wrapper.classList.contains("container") &&
          getComputedStyle(wrapper).justifyContent === "flex-end";
        const attachmentStates =
          evidence.kind === "image"
            ? [...wrapper.querySelectorAll<HTMLImageElement>(attachmentSelector)].map((image) => {
                const rawAttributeSrc = image.getAttribute("src") ?? "";
                let attributeSrc = "";
                if (rawAttributeSrc !== "") {
                  try {
                    attributeSrc = new URL(rawAttributeSrc, document.baseURI).href;
                  } catch {
                    attributeSrc = rawAttributeSrc;
                  }
                }
                return {
                  attributeSrc,
                  src: image.src,
                  currentSrc: image.currentSrc,
                  complete: image.complete,
                  naturalWidth: image.naturalWidth,
                  naturalHeight: image.naturalHeight,
                };
              })
            : [];
        candidates.push({
          messageId,
          messageIndex: Number(rawMessageIndex),
          eventIndex: Number(eventMatch?.[1]),
          senderOwned: classicOwned || mobileOwned,
          attachmentStates,
          captionTextCount,
          exactEvidenceMatches,
          exactOptimisticBindingMatches:
            evidence.kind === "image" &&
            attachmentStates.length === 1 &&
            attachmentStates[0].attributeSrc === evidence.exactDraftUrl &&
            attachmentStates[0].src === evidence.exactDraftUrl &&
            attachmentStates[0].currentSrc === evidence.exactDraftUrl &&
            attachmentStates[0].complete &&
            attachmentStates[0].naturalWidth > 0 &&
            attachmentStates[0].naturalHeight > 0
              ? 1
              : 0,
        });
      }
      return candidates;
    },
    {
      evidence,
      textSelector: OPENCHAT_MESSAGE_TEXT_SELECTOR,
      attachmentSelector: ATTACHMENT_IMAGE_SELECTOR,
    },
  );

  const candidates: FreshSourceScanCandidate[] = [];
  for (const candidate of domCandidates) {
    if (baseline.messageIds.has(candidate.messageId)) continue;
    if (candidate.messageIndex <= baseline.maxMessageIndex) continue;
    if (candidate.eventIndex <= baseline.maxEventIndex) continue;
    if (!candidate.senderOwned) continue;
    if (evidence.kind === "text") {
      candidates.push({
        messageId: candidate.messageId,
        messageIndex: candidate.messageIndex,
        eventIndex: candidate.eventIndex,
        senderOwned: candidate.senderOwned,
        exactEvidenceMatches: candidate.exactEvidenceMatches,
        exactOptimisticBindingMatches: 0,
      });
      continue;
    }
    if (candidate.captionTextCount !== 0) {
      candidates.push({
        messageId: candidate.messageId,
        messageIndex: candidate.messageIndex,
        eventIndex: candidate.eventIndex,
        senderOwned: true,
        exactEvidenceMatches: 0,
        exactOptimisticBindingMatches: 0,
      });
      continue;
    }
    if (candidate.attachmentStates.length > 1) {
      throw new Error("fresh source has multiple attachment images; refusing ambiguity");
    }
    if (candidate.attachmentStates.length === 0) {
      candidates.push({
        messageId: candidate.messageId,
        messageIndex: candidate.messageIndex,
        eventIndex: candidate.eventIndex,
        senderOwned: true,
        exactEvidenceMatches: 0,
        exactOptimisticBindingMatches: 0,
      });
      continue;
    }
    const readiness = classifySentImageResource(candidate.attachmentStates[0]);
    if (readiness.kind === "pending") {
      candidates.push({
        messageId: candidate.messageId,
        messageIndex: candidate.messageIndex,
        eventIndex: candidate.eventIndex,
        senderOwned: true,
        exactEvidenceMatches: 0,
        exactOptimisticBindingMatches: candidate.exactOptimisticBindingMatches,
      });
      continue;
    }
    const observed = await digestUploadedAttachmentImage(
      page,
      readiness.url,
      `fresh source ${candidate.messageId}`,
    );
    if (!matchesExactImageContentEvidence(evidence.exactContent, observed)) {
      throw new Error(
        `fresh source ${candidate.messageId}: uploaded image bytes do not match the exact draft`,
      );
    }
    candidates.push({
      messageId: candidate.messageId,
      messageIndex: candidate.messageIndex,
      eventIndex: candidate.eventIndex,
      senderOwned: true,
      exactEvidenceMatches: 1,
      exactOptimisticBindingMatches: candidate.exactOptimisticBindingMatches,
    });
  }
  return candidates;
}

async function captureFreshSourceMessage(
  page: Page,
  evidence: SourceMessageEvidence,
  baseline: StableMessageBaseline,
  who: string,
  timeoutMs = 15_000,
  onExactOptimisticBinding?: (message: ChatMessageRef) => void,
): Promise<ChatMessageRef> {
  const deadline = Date.now() + timeoutMs;
  let exactOptimisticMessage: ChatMessageRef | null = null;
  while (Date.now() < deadline) {
    const candidates = await freshSourceCandidates(page, evidence, baseline);
    if (evidence.kind === "image") {
      let optimistic: ChatMessageRef | null;
      try {
        optimistic = selectFreshOwnedSourceCandidate({
          candidates: candidates.map((candidate) => ({
            ...candidate,
            exactEvidenceMatches: candidate.exactOptimisticBindingMatches,
          })),
          baselineMessageIds: baseline.messageIds,
          baselineMaxMessageIndex: baseline.maxMessageIndex,
          baselineMaxEventIndex: baseline.maxEventIndex,
        });
      } catch (error) {
        throw new Error(`[${who}] ${(error as Error).message}; refusing optimistic ambiguity`);
      }
      if (optimistic !== null) {
        if (
          exactOptimisticMessage !== null &&
          !sameStableMessage(exactOptimisticMessage, optimistic)
        ) {
          throw new Error(`[${who}] exact optimistic source coordinates changed`);
        }
        exactOptimisticMessage = optimistic;
        onExactOptimisticBinding?.(optimistic);
      }
    }
    let message: ChatMessageRef | null;
    try {
      message = selectFreshOwnedSourceCandidate({
        candidates,
        baselineMessageIds: baseline.messageIds,
        baselineMaxMessageIndex: baseline.maxMessageIndex,
        baselineMaxEventIndex: baseline.maxEventIndex,
      });
    } catch (error) {
      throw new Error(`[${who}] ${(error as Error).message}; refusing ambiguity`);
    }
    if (message !== null) {
      if (
        exactOptimisticMessage !== null &&
        !sameStableMessage(exactOptimisticMessage, message)
      ) {
        throw new Error(`[${who}] uploaded source differs from its exact optimistic binding`);
      }
      if ((await exactMessageWrapper(page, message).count()) !== 1) {
        throw new Error(`[${who}] fresh Journey message coordinates are not unique`);
      }
      return message;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`[${who}] fresh Journey message never acquired stable message coordinates`);
}

async function captureCardMessage(card: Locator, observerId: string, who: string): Promise<ChatMessageRef> {
  const wrapper = card.locator(
    'xpath=ancestor::*[@data-id and @data-index and starts-with(@id,"event-")][1]',
  );
  const message = await messageRefFromWrapper(wrapper, `[${who}] nonce-scoped card`);
  const exactCard = exactMessageWrapper(card.page(), message).locator(
    `.action-card[data-iou-journey-card-id="${observerId}"]`,
  );
  if ((await exactCard.count()) !== 1) {
    throw new Error(`[${who}] nonce-scoped card is not uniquely contained by its captured message`);
  }
  return message;
}

async function messageOwnedByCurrentUser(
  page: Page,
  message: ChatMessageRef,
): Promise<boolean> {
  const wrapper = exactMessageWrapper(page, message);
  if ((await wrapper.count()) !== 1) return false;
  return wrapper.evaluate((node) => {
    const classicOwned =
      node.classList.contains("message") && node.classList.contains("me");
    const mobileOwned =
      node.classList.contains("container") &&
      getComputedStyle(node).justifyContent === "flex-end";
    return classicOwned || mobileOwned;
  });
}

type InboxRunLookup = {
  found: boolean;
  linkedSheet: string | null;
  matched: number;
  acknowledged: number;
};

function messageRefKey(message: ChatMessageRef): string {
  return `${message.messageId}/${message.messageIndex}/${message.eventIndex}`;
}

function rememberRunCards<T extends LoadedRunCard>(
  tracked: Map<string, T>,
  cards: readonly T[],
  who: string,
): void {
  for (const card of cards) {
    const key = messageRefKey(card.message);
    const existing = tracked.get(key);
    if (existing && existing.observerId !== card.observerId) {
      throw new Error(
        `[${who}] two observed cards occupy the same stable message coordinates; refusing ambiguity`,
      );
    }
    tracked.set(key, card);
  }
}

type CurrentCardEvidence = "match" | "mismatch" | "unavailable";

async function cardLocatorExactRunNoteState(
  card: Locator,
  exactNote: string,
): Promise<CurrentCardEvidence> {
  const publicRows = card.locator("table.rows tr");
  const publicRowCount = await publicRows.count();
  let publicNoteRows = 0;
  let publicMatches = 0;
  for (let index = 0; index < publicRowCount; index++) {
    const row = publicRows.nth(index);
    const label = (await row.locator(".label").innerText().catch(() => "")).trim();
    const value = (await row.locator(".value").innerText().catch(() => "")).trim();
    if (label === "Note") {
      publicNoteRows++;
      if (value === exactNote) publicMatches++;
    }
  }
  if (publicNoteRows > 0) {
    if (publicNoteRows > 1) throw new Error("card has ambiguous public Note rows");
    return publicMatches === 1 ? "match" : "mismatch";
  }

  const iframeCount = await card.locator("iframe").count();
  if (iframeCount !== 1) return "unavailable";
  const note = card.frameLocator("iframe").getByLabel("Note", { exact: true });
  if ((await note.count().catch(() => 0)) !== 1) return "unavailable";
  return (await note.inputValue().catch(() => "")) === exactNote ? "match" : "mismatch";
}

async function cardLocatorHasExactRunNote(card: Locator, exactNote: string): Promise<boolean> {
  return (await cardLocatorExactRunNoteState(card, exactNote)) === "match";
}

async function cardHasExactRunNote(card: LoadedRunCard, exactNote: string): Promise<boolean> {
  return cardLocatorHasExactRunNote(card.card, exactNote);
}

async function rememberNonceBoundRunCards(
  tracked: Map<string, NonceBoundRunCard>,
  cards: readonly LoadedRunCard[],
  exactNote: string,
  who: string,
): Promise<void> {
  for (const card of cards) {
    if (!(await cardHasExactRunNote(card, exactNote))) {
      console.warn(
        `[${who}] card ${card.message.messageId} left untracked because its exact run note is unavailable`,
      );
      continue;
    }
    const deletionEvidence: ExactCardMessageEvidence = {
      kind: "card",
      observerId: card.observerId,
      boundMessage: { ...card.message },
      boundExactNote: exactNote,
    };
    rememberRunCards(tracked, [{ ...card, deletionEvidence }], who);
  }
}

function uniqueTrackedRunCard<T extends LoadedRunCard>(
  tracked: ReadonlyMap<string, T>,
  who: string,
): T | null {
  if (tracked.size > 1) {
    throw new Error(`[${who}] ${tracked.size} nonce-exact run cards were found; refusing confirmation`);
  }
  return tracked.values().next().value ?? null;
}

// Observe cards that are added after this point and retain each card's presentation transitions.
// The exact sender card is identified later from the nonce inside its isolated iframe; the observer
// id then lets the journey prove that same DOM card moved from optimistic/unverified to the
// backend-verified directory binding without a page reload.
async function installNewCardObserver(page: Page, tag: string): Promise<void> {
  await page.evaluate(`(() => {
    const observerTag = ${JSON.stringify(tag)};
    const root = globalThis;
    if (root.__iouJourneyCardObserver) {
      root.__iouJourneyCardObserver.observer.disconnect();
    }
    const stableCardKey = (card) => {
      const wrapper = card.closest('[data-id][data-index][id^="event-"]');
      const messageId = wrapper?.getAttribute("data-id") ?? "";
      const messageIndex = wrapper?.getAttribute("data-index") ?? "";
      const eventId = wrapper?.getAttribute("id") ?? "";
      if (!/^\\d+$/.test(messageId) || !/^\\d+$/.test(messageIndex) || !/^event-\\d+$/.test(eventId)) {
        return null;
      }
      return messageId + "/" + messageIndex + "/" + eventId;
    };
    const initialCards = [...document.querySelectorAll(".action-card")];
    const state = {
      tag: observerTag,
      nextId: 0,
      baselineKeys: new Set(initialCards.map(stableCardKey).filter(Boolean)),
      idsByStableKey: {},
      records: {},
      observer: null,
    };
    const sample = () => {
      for (const card of document.querySelectorAll(".action-card")) {
        const stableKey = stableCardKey(card);
        if (!stableKey || state.baselineKeys.has(stableKey)) continue;
        let id = state.idsByStableKey[stableKey] ?? card.dataset.iouJourneyCardId;
        if (!id) {
          id = observerTag + "-" + state.nextId++;
        }
        state.idsByStableKey[stableKey] = id;
        card.dataset.iouJourneyCardId = id;
        const text = card.innerText.replace(/\\s+/g, " ").trim();
        const records = (state.records[id] ??= []);
        if (records.at(-1) !== text) records.push(text);
      }
    };
    const observer = new MutationObserver(sample);
    state.observer = observer;
    root.__iouJourneyCardObserver = state;
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    sample();
  })()`);
}

async function observedCardTransitions(page: Page, observerId: string): Promise<string[]> {
  return page.evaluate((id) => {
    const root = globalThis as typeof globalThis & {
      __iouJourneyCardObserver?: { records: Record<string, string[]> };
    };
    return [...(root.__iouJourneyCardObserver?.records[id] ?? [])];
  }, observerId);
}

async function observedRunCardCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = globalThis as typeof globalThis & {
      __iouJourneyCardObserver?: { records: Record<string, string[]> };
    };
    return Object.keys(root.__iouJourneyCardObserver?.records ?? {}).length;
  });
}

async function removeNewCardObserver(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const root = globalThis as typeof globalThis & {
        __iouJourneyCardObserver?: {
          observer: MutationObserver;
          tag: string;
        };
      };
      const state = root.__iouJourneyCardObserver;
      state?.observer.disconnect();
      if (state) {
        for (const card of document.querySelectorAll<HTMLElement>(
          ".action-card[data-iou-journey-card-id]",
        )) {
          if (card.dataset.iouJourneyCardId?.startsWith(`${state.tag}-`)) {
            delete card.dataset.iouJourneyCardId;
          }
        }
      }
      delete root.__iouJourneyCardObserver;
    })
    .catch(() => {});
}

async function findAndLoadRunCards(
  page: Page,
  note: string,
  who: string,
  timeoutMs = 35_000,
  failOnProposalToast = false,
  correlation: RunCardCorrelation = {},
): Promise<LoadedRunCard[]> {
  const found = new Map<string, LoadedRunCard>();
  let firstFoundAt: number | null = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cards = page.locator(".action-card[data-iou-journey-card-id]");
    const count = await cards.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      const card = cards.nth(index);
      if (!(await card.isVisible().catch(() => false))) continue;
      const observerId = await card.getAttribute("data-iou-journey-card-id");
      if (!observerId) continue;

      // Do not inspect an arbitrary external origin. Only a newly added card whose authoritative
      // directory identity has resolved to IOU may expose an app iframe.
      const isIou = await hasAuthoritativeIouIdentity(card);
      if (!isIou) continue;
      const hasUntrustedWarning = await card
        .getByText(/card content is untrusted|Untrusted card text/i)
        .first()
        .isVisible()
        .catch(() => false);
      if (hasUntrustedWarning) continue;

      const message = await captureCardMessage(card, observerId, who);
      const senderOwned = await messageOwnedByCurrentUser(page, message);

      if ((await card.locator("iframe").count()) === 0) {
        const obsoleteLoad = card.getByRole("button", { name: "Load app card", exact: true });
        if (await obsoleteLoad.isVisible().catch(() => false)) {
          throw new Error(`[${who}] manual Load app card gate is a regression`);
        }
      }

      if ((await card.locator("iframe").count()) === 0) continue;
      const frame = card.frameLocator("iframe");
      await frame.locator("input").first().waitFor({ timeout: 4_000 }).catch(() => {});
      const inputs = frame.locator("input");
      const inputCount = await inputs.count().catch(() => 0);
      const values: string[] = [];
      for (let input = 0; input < inputCount; input++) {
        values.push(await inputs.nth(input).inputValue().catch(() => ""));
      }
      if (matchesRunCardCandidate({
        candidate: message,
        senderOwned,
        exactNoteMatch: values.includes(note),
        expectedSource: correlation.expectedSource,
        expectedMessage: correlation.expectedMessage,
        requireSenderOwned: correlation.requireSenderOwned ?? false,
      })) {
        const loaded: LoadedRunCard = {
          card,
          frame,
          observerId,
          loadedAutomatically: true,
          message,
        };
        const key = messageRefKey(message);
        const existing = found.get(key);
        if (existing && existing.observerId !== observerId) {
          throw new Error(
            `[${who}] two nonce-exact cards occupy the same stable message coordinates`,
          );
        }
        found.set(key, loaded);
        firstFoundAt ??= Date.now();
      }
    }
    // Continue briefly after the first match so a duplicate created by a raced retry is inventoried
    // and cleaned instead of being hidden by an early return.
    if (firstFoundAt !== null && Date.now() - firstFoundAt >= 800) return [...found.values()];
    if (failOnProposalToast && found.size === 0) {
      const failure = await proposalFailureText(page);
      if (failure) throw new Error(`proposal UI failure: ${failure}`);
    }
    await page.waitForTimeout(400);
  }
  return [...found.values()];
}

async function waitForHostAddEnabled(
  loaded: LoadedRunCard,
  add: Locator,
  timeoutMs = HOST_ADD_HYDRATION_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await add.isEnabled().catch(() => false)) return;
    await loaded.card.page().waitForTimeout(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  if (await add.isEnabled().catch(() => false)) return;

  const hostStatuses = await loaded.card.getByRole("status").allInnerTexts().catch(() => []);
  const hostAlerts = await loaded.card.getByRole("alert").allInnerTexts().catch(() => []);
  const restore = loaded.card.getByRole("button", { name: "Restore app data", exact: true });
  const restoreCount = await restore.count().catch(() => 0);
  const restoreState =
    restoreCount === 1
      ? `${(await restore.isVisible().catch(() => false)) ? "visible" : "hidden"}/${
          (await restore.isEnabled().catch(() => false)) ? "enabled" : "disabled"
        }`
      : `${restoreCount} matches`;
  const appSignals = await loaded.frame
    .locator('[role="status"], [role="alert"]')
    .allInnerTexts()
    .catch(() => []);
  const summarize = (values: string[]): string =>
    values.length === 0
      ? "none"
      : values
          .map((value) =>
            value
              .replace(/\s+/g, " ")
              .replace(/([?&](?:token|code|claim|credential)[^=]*)=[^\s&]+/gi, "$1=<redacted>")
              .replace(/\b[a-z0-9]{5}(?:-[a-z0-9]{3,5}){2,}\b/gi, "<id>")
              .slice(0, 160),
          )
          .slice(0, 4)
          .join(" | ");
  throw new Error(
    `the nonce-scoped host Add to IOU button stayed disabled for ${timeoutMs}ms after public card load ` +
      `(host status: ${summarize(hostStatuses)}; host alerts: ${summarize(hostAlerts)}; ` +
      `app signals: ${summarize(appSignals)}; Restore app data: ${restoreState})`,
  );
}

async function approveRunCardConfirmation(
  loaded: LoadedRunCard,
  note: string,
  currency: string,
): Promise<void> {
  const add = loaded.card.getByRole("button", { name: "Add to IOU", exact: true });
  await add.waitFor({ state: "visible", timeout: 10_000 });
  await waitForHostAddEnabled(loaded, add);
  if ((await loaded.frame.getByRole("button").count()) !== 0) {
    throw new Error("the external card iframe unexpectedly owns an action button");
  }
  const noteControl = loaded.frame.getByLabel("Note", { exact: true });
  const amountControl = loaded.frame.getByLabel("Amount", { exact: true });
  const currencyControl = loaded.frame.getByLabel("Currency", { exact: true });
  if (
    (await noteControl.inputValue()) !== note ||
    (await amountControl.inputValue()) !== "350" ||
    (currency !== "" && (await currencyControl.inputValue()) !== currency)
  ) {
    throw new Error("host confirmation is not targeting this run's exact visible card values");
  }
  const disclosure = loaded.card.getByRole("checkbox");
  const disclosureCount = await disclosure.count();
  check(disclosureCount === 0, "IOU card has no redundant disclosure checkbox");
  if (disclosureCount !== 0) {
    throw new Error("IOU host action unexpectedly requires a redundant disclosure checkbox");
  }
  await add.click({ timeout: 10_000 });
  if ((await loaded.card.getByRole("button", { name: "Confirm request", exact: true }).count()) !== 0) {
    throw new Error("one host Add click unexpectedly opened a second approval step");
  }
}

async function cancelRunCard(loaded: LoadedRunCard): Promise<boolean> {
  const cancel = loaded.card.getByRole("button", { name: "Cancel", exact: true });
  if (!(await cancel.isVisible().catch(() => false))) return false;
  await cancel.click({ timeout: 8_000 });
  return true;
}

async function visibleMatches(locator: Locator): Promise<Locator[]> {
  const matches: Locator[] = [];
  const count = await locator.count();
  for (let index = 0; index < count; index++) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) matches.push(candidate);
  }
  return matches;
}

async function exactlyOneVisible(locator: Locator, label: string, timeoutMs = 5_000): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = await visibleMatches(locator);
    if (matches.length > 1) {
      throw new Error(`${label}: expected one visible match, found ${matches.length}`);
    }
    if (matches.length === 1) return matches[0];
    await locator.page().waitForTimeout(100);
  }
  throw new Error(`${label}: no visible match appeared`);
}

async function blockingOpenChatOverlayCount(page: Page): Promise<number> {
  return page.evaluate(`(() => [...document.querySelectorAll(".overlay")].filter((overlay) => {
    const rect = overlay.getBoundingClientRect();
    return getComputedStyle(overlay).pointerEvents !== "none" && rect.width > 0 && rect.height > 0;
  }).length)()`);
}

async function dismissOpenChatOverlay(page: Page): Promise<void> {
  let remainingBlockingOverlays = await blockingOpenChatOverlayCount(page);
  for (let attempt = 0; remainingBlockingOverlays > 0 && attempt < 8; attempt++) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(250);
    remainingBlockingOverlays = await blockingOpenChatOverlayCount(page);
  }
  if (remainingBlockingOverlays > 0) {
    throw new Error(
      `${remainingBlockingOverlays} blocking OpenChat overlay(s) could not be dismissed`,
    );
  }
}

async function exactMessageEvidencePresent(
  page: Page,
  message: ChatMessageRef,
  evidence: ExactMessageEvidence,
): Promise<boolean> {
  const wrapper = exactMessageWrapper(page, message);
  const wrapperCount = await wrapper.count();
  if (wrapperCount > 1) throw new Error(`message ${message.messageId}: stable coordinates are ambiguous`);
  if (wrapperCount === 0) return false;
  if (evidence.kind === "source") {
    if (evidence.evidence.kind === "image") {
      const captionTextCount = await wrapper.locator(OPENCHAT_MESSAGE_TEXT_SELECTOR).evaluateAll(
        (nodes) => {
          let count = 0;
          for (const node of nodes as HTMLElement[]) {
            if (
              node.classList.contains("markdown-wrapper") &&
              node.closest(".message_text") !== null
            )
              continue;
            if (node.innerText.replace(/\s+/g, " ").trim() !== "") count++;
          }
          return count;
        },
      );
      if (captionTextCount !== 0) return false;
      const attachmentStates = await wrapper
        .locator(ATTACHMENT_IMAGE_SELECTOR)
        .evaluateAll((nodes) =>
          (nodes as HTMLImageElement[]).map((image) => {
            const rawAttributeSrc = image.getAttribute("src") ?? "";
            let attributeSrc = "";
            if (rawAttributeSrc !== "") {
              try {
                attributeSrc = new URL(rawAttributeSrc, document.baseURI).href;
              } catch {
                attributeSrc = rawAttributeSrc;
              }
            }
            return {
              attributeSrc,
              src: image.src,
              currentSrc: image.currentSrc,
              complete: image.complete,
              naturalWidth: image.naturalWidth,
              naturalHeight: image.naturalHeight,
            };
          }),
        );
      if (attachmentStates.length !== 1) {
        throw new Error(
          `message ${message.messageId}: expected one exact attachment image, found ${attachmentStates.length}`,
        );
      }
      const readiness = classifySentImageResource(attachmentStates[0]);
      if (readiness.kind === "pending") {
        const binding = evidence.optimisticBinding;
        const renderedBlobUrls = [
          attachmentStates[0].attributeSrc,
          attachmentStates[0].src,
          attachmentStates[0].currentSrc,
        ].filter((url) => url.startsWith("blob:"));
        return (
          binding !== undefined &&
          binding.boundDraftUrl.startsWith("blob:") &&
          binding.boundDraftUrl === evidence.evidence.exactDraftUrl &&
          renderedBlobUrls.every((url) => url === binding.boundDraftUrl) &&
          sameStableMessage(message, binding.boundMessage) &&
          (await messageOwnedByCurrentUser(page, message))
        );
      }
      const observed = await digestUploadedAttachmentImage(
        page,
        readiness.url,
        `message ${message.messageId}`,
      );
      return matchesExactImageContentEvidence(evidence.evidence.exactContent, observed);
    }
    const matches = await wrapper.locator(OPENCHAT_MESSAGE_TEXT_SELECTOR).evaluateAll(
      (nodes, exact) => {
        let count = 0;
        for (const node of nodes as HTMLElement[]) {
          if (
            node.classList.contains("markdown-wrapper") &&
            node.closest(".message_text") !== null
          )
            continue;
          if (node.innerText.replace(/\s+/g, " ").trim() === exact) count++;
        }
        return count;
      },
      evidence.evidence.exactText.replace(/\s+/g, " ").trim(),
    );
    if (matches > 1) throw new Error(`message ${message.messageId}: source evidence is ambiguous`);
    return matches === 1;
  }

  const cards = wrapper.locator(".action-card");
  const cardCount = await cards.count();
  if (cardCount > 1) throw new Error(`message ${message.messageId}: card evidence is ambiguous`);
  let currentIdentity: CurrentCardEvidence = "unavailable";
  let currentNote: CurrentCardEvidence = "unavailable";
  if (cardCount === 1) {
    const card = cards.first();
    const currentObserverId = await card.getAttribute("data-iou-journey-card-id");
    if (currentObserverId !== null && currentObserverId !== evidence.observerId) return false;
    const identity = await card.evaluate((node) => ({
      title: node.querySelector(".title")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      appName: node.querySelector(".app-name")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    }));
    currentIdentity =
      identity.title === "Add to IOU" &&
      identity.appName.toLocaleLowerCase("en-US") === "iou"
        ? "match"
        : "mismatch";
    if (currentIdentity === "match") {
      currentNote = await cardLocatorExactRunNoteState(card, evidence.boundExactNote);
    }
  }
  return retainsNonceBoundCardEvidence({
    target: message,
    boundMessage: evidence.boundMessage,
    senderOwned: await messageOwnedByCurrentUser(page, message),
    boundExactNote: evidence.boundExactNote,
    currentIdentity,
    currentNote,
  });
}

async function exactMessageDeletionProven(
  page: Page,
  message: ChatMessageRef,
): Promise<boolean> {
  const wrapper = exactMessageWrapper(page, message);
  const wrapperCount = await wrapper.count();
  if (wrapperCount > 1) {
    throw new Error(`message ${message.messageId}: stable coordinates are ambiguous after deletion`);
  }
  if (wrapperCount === 0) return true;
  const classicTombstones = await wrapper.locator(".deleted").count();
  if (classicTombstones > 1) {
    throw new Error(`message ${message.messageId}: deletion tombstone is ambiguous`);
  }
  if (classicTombstones === 1) return true;
  const text = (await wrapper.innerText()).replace(/\s+/g, " ").trim();
  return MESSAGE_DELETED_TEXT.test(text);
}

async function waitForExactDeletionProof(
  page: Page,
  message: ChatMessageRef,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await exactMessageDeletionProven(page, message)) return;
    await page.waitForTimeout(300);
  }
  throw new Error(`message ${message.messageId}: wrapper or tombstone did not prove deletion`);
}

async function openOwnedMobileMessageMenu(page: Page, message: ChatMessageRef): Promise<Locator> {
  const wrapper = exactMessageWrapper(page, message);
  if ((await wrapper.count()) !== 1) {
    throw new Error(`message ${message.messageId}: exact mobile wrapper is unavailable`);
  }
  const ownedByAlignment = await wrapper.evaluate(
    (node) => node.classList.contains("container") && getComputedStyle(node).justifyContent === "flex-end",
  );
  if (!ownedByAlignment) throw new Error(`message ${message.messageId}: mobile message is not sender-owned`);
  const trigger = wrapper.locator(".message_bubble_wrapper > .menu-trigger");
  if ((await trigger.count()) !== 1) {
    throw new Error(`message ${message.messageId}: exact mobile menu trigger is ambiguous`);
  }
  await trigger.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);

  for (let attempt = 0; attempt < 3; attempt++) {
    await dismissOpenChatOverlay(page);
    await trigger.dispatchEvent("click").catch(() => {});
    await page.waitForTimeout(500);
    let menus = await visibleMatches(page.locator(".message_bubble_menu.second"));
    if (menus.length === 0) {
      const box = await trigger.boundingBox();
      if (!box) throw new Error(`message ${message.messageId}: mobile trigger has no bounds`);
      await dismissOpenChatOverlay(page);
      const session = await page.context().newCDPSession(page);
      try {
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
        await page.waitForTimeout(750);
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } finally {
        await session.detach().catch(() => {});
      }
      await page.waitForTimeout(500);
      menus = await visibleMatches(page.locator(".message_bubble_menu.second"));
    }
    if (menus.length > 1) {
      throw new Error(`message ${message.messageId}: multiple mobile message menus opened`);
    }
    if (menus.length === 1) {
      if (!(await menus[0].evaluate((node) => node.classList.contains("me")))) {
        throw new Error(`message ${message.messageId}: opened mobile menu is not sender-owned`);
      }
      return menus[0];
    }
    await page.waitForTimeout(1_200);
  }
  throw new Error(`message ${message.messageId}: exact mobile message menu did not open`);
}

async function refreshExactOpenChatDeletionBoundary(
  page: Page,
  targets: readonly ExactMessageDeletionTarget[],
): Promise<void> {
  if (targets.length === 0) return;
  const exactChatUrl = page.url();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .locator(".ProseMirror")
    .first()
    .waitFor({ state: "visible", timeout: 20_000 });
  if (page.url() !== exactChatUrl) {
    throw new Error("OpenChat cleanup reload left the exact chat route");
  }

  for (const target of targets) {
    const deadline = Date.now() + 20_000;
    let revalidated = false;
    while (Date.now() < deadline) {
      if (await exactMessageEvidencePresent(page, target.message, target.evidence)) {
        const observed = await messageRefFromWrapper(
          exactMessageWrapper(page, target.message),
          `message ${target.message.messageId}: refreshed deletion target`,
        );
        const senderOwned = await messageOwnedByCurrentUser(page, target.message);
        if (sameStableMessage(target.message, observed) && senderOwned) {
          revalidated = true;
          break;
        }
      }
      await page.waitForTimeout(250);
    }
    if (!revalidated) {
      throw new Error(
        `message ${target.message.messageId}: refreshed exact deletion evidence or ownership is unavailable`,
      );
    }
  }
}

async function deleteExactMessageViaUi(
  page: Page,
  message: ChatMessageRef,
  evidence: ExactMessageEvidence,
): Promise<void> {
  const maxDeleteAttempts = 3;
  for (let attempt = 0; attempt < maxDeleteAttempts; attempt++) {
    await dismissOpenChatOverlay(page);
    if (!(await exactMessageEvidencePresent(page, message, evidence))) {
      throw new Error(`message ${message.messageId}: exact deletion evidence is unavailable`);
    }
    const wrapper = exactMessageWrapper(page, message);
    const observed = await messageRefFromWrapper(
      wrapper,
      `message ${message.messageId}: exact deletion target`,
    );
    const senderOwned = await messageOwnedByCurrentUser(page, message);
    if (!sameStableMessage(message, observed) || !senderOwned) {
      throw new Error(
        `message ${message.messageId}: exact deletion target is not the sender-owned message`,
      );
    }

    try {
      const classic = await wrapper.evaluate((node) => node.classList.contains("message"));
      if (classic) {
        const bubble = wrapper.locator(".bubble-wrapper");
        if ((await bubble.count()) !== 1) {
          throw new Error(`message ${message.messageId}: exact classic bubble is ambiguous`);
        }
        await dismissOpenChatOverlay(page);
        await bubble.hover();
        const menuIcons = bubble.locator(".menu-icon");
        let visibleMenuIcons = await visibleMatches(menuIcons);
        for (let menuAttempt = 0; visibleMenuIcons.length === 0 && menuAttempt < 4; menuAttempt++) {
          await page.waitForTimeout(100);
          visibleMenuIcons = await visibleMatches(menuIcons);
        }
        if (visibleMenuIcons.length > 1) {
          throw new Error(`message ${message.messageId}: exact classic menu is ambiguous`);
        }
        if (visibleMenuIcons.length === 1) {
          await dismissOpenChatOverlay(page);
          await visibleMenuIcons[0].click({ timeout: 10_000 });
        } else {
          if ((await menuIcons.count()) !== 1) {
            throw new Error(
              `message ${message.messageId}: responsive classic menu icon is not uniquely attached`,
            );
          }
          const hiddenByResponsiveCss = await menuIcons.evaluate((node) => {
            const menu = node.closest(".menu");
            return node.isConnected && menu !== null && getComputedStyle(menu).display === "none";
          });
          if (!hiddenByResponsiveCss) {
            throw new Error(
              `message ${message.messageId}: classic menu is neither visible nor responsively hidden`,
            );
          }
          await dismissOpenChatOverlay(page);
          await menuIcons.dispatchEvent("click");
        }
      } else {
        const menu = await openOwnedMobileMessageMenu(page, message);
        const more = await exactlyOneVisible(
          menu.locator(".menu-btn button"),
          "mobile more-options button",
        );
        await more.click({ timeout: 10_000 });
      }

      const deleteMenuDeadline = Date.now() + 10_000;
      let deleteDispatched = false;
      while (Date.now() < deleteMenuDeadline) {
        const deleteForMe = await visibleMatches(
          page.getByRole("menuitem", { name: "Delete for me", exact: true }),
        );
        if (deleteForMe.length !== 0) {
          throw new Error(
            `message ${message.messageId}: UI offered Delete for me instead of sender deletion`,
          );
        }
        const senderDelete = await visibleMatches(
          page.getByRole("menuitem", { name: "Delete", exact: true }),
        );
        if (senderDelete.length > 1) {
          throw new Error(`message ${message.messageId}: sender Delete menu item is ambiguous`);
        }
        if (senderDelete.length === 1) {
          await senderDelete[0].dispatchEvent("click", undefined, { timeout: 2_000 });
          deleteDispatched = true;
          break;
        }
        await page.waitForTimeout(100);
      }
      if (!deleteDispatched) {
        throw new Error(`message ${message.messageId}: sender Delete menu item did not appear`);
      }

      const confirmation = page.getByRole("button", { name: "Yes please", exact: true });
      const confirmationDeadline = Date.now() + 2_000;
      while (Date.now() < confirmationDeadline) {
        const confirmations = await visibleMatches(confirmation);
        if (confirmations.length > 1) {
          throw new Error(`message ${message.messageId}: multiple delete confirmations are visible`);
        }
        if (confirmations.length === 1) {
          await confirmations[0].click({ timeout: 10_000 });
          break;
        }
        if (await exactMessageDeletionProven(page, message)) return;
        await page.waitForTimeout(100);
      }
      await waitForExactDeletionProof(page, message);
      return;
    } catch (error) {
      // A click may dispatch before Playwright reports that Svelte replaced the menu node. Absence of
      // this exact evidence means the requested deletion already completed; otherwise retry only if
      // the identical sender-owned target survived and the error is recognized DOM detach churn.
      if (await exactMessageDeletionProven(page, message)) return;
      const evidencePresent = await exactMessageEvidencePresent(page, message, evidence);
      const retryWrapper = exactMessageWrapper(page, message);
      const retryObserved = await messageRefFromWrapper(
        retryWrapper,
        `message ${message.messageId}: retry deletion target`,
      );
      const retrySenderOwned = await messageOwnedByCurrentUser(page, message);
      if (!shouldRetryExactMessageDeletion({
        attempt,
        maxAttempts: maxDeleteAttempts,
        error,
        target: message,
        observed: retryObserved,
        evidencePresent,
        senderOwned: retrySenderOwned,
      })) {
        throw error;
      }
      console.log(
        `[cleanup] message ${message.messageId}: exact Delete control rerendered; retrying ${attempt + 2}/${maxDeleteAttempts}`,
      );
      await page.waitForTimeout(250);
    }
  }
  throw new Error(`message ${message.messageId}: exact Delete retry limit exhausted`);
}

async function deleteExactMessagePersistentlyViaUi(
  page: Page,
  target: ExactMessageDeletionTarget,
): Promise<void> {
  const maxPersistenceAttempts = 3;
  const backendDeleteSettleMs = 5_000;
  const exactChatUrl = page.url();
  for (let attempt = 0; attempt < maxPersistenceAttempts; attempt++) {
    await deleteExactMessageViaUi(page, target.message, target.evidence);
    // OpenChat renders its local tombstone before the asynchronous backend delete has settled.
    // Keep the document alive briefly so the in-flight update is not aborted by verification.
    await page.waitForTimeout(backendDeleteSettleMs);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .locator(".ProseMirror")
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
    if (page.url() !== exactChatUrl) {
      throw new Error("OpenChat persistence reload left the exact chat route");
    }

    const reappearanceDeadline = Date.now() + 5_000;
    let reappeared = false;
    while (Date.now() < reappearanceDeadline) {
      const wrapper = exactMessageWrapper(page, target.message);
      const wrapperCount = await wrapper.count();
      if (wrapperCount > 1) {
        throw new Error(
          `message ${target.message.messageId}: stable coordinates are ambiguous after persistence reload`,
        );
      }
      if (wrapperCount === 0) {
        await page.waitForTimeout(250);
        continue;
      }
      if (await exactMessageDeletionProven(page, target.message)) return;
      if (!(await exactMessageEvidencePresent(page, target.message, target.evidence))) {
        await page.waitForTimeout(250);
        continue;
      }
      const observed = await messageRefFromWrapper(
        wrapper,
        `message ${target.message.messageId}: persisted deletion target`,
      );
      const senderOwned = await messageOwnedByCurrentUser(page, target.message);
      if (!sameStableMessage(target.message, observed)) {
        throw new Error(`message ${target.message.messageId}: persisted target coordinates changed`);
      }
      if (!senderOwned) {
        await page.waitForTimeout(250);
        continue;
      }
      reappeared = true;
      break;
    }
    if (await exactMessageDeletionProven(page, target.message)) return;
    if (!reappeared) {
      throw new Error(
        `message ${target.message.messageId}: persistence reload did not prove deletion or exact evidence`,
      );
    }
    if (attempt + 1 >= maxPersistenceAttempts) {
      throw new Error(
        `message ${target.message.messageId}: exact deletion reappeared after ${maxPersistenceAttempts} attempts`,
      );
    }
    console.log(
      `[cleanup] message ${target.message.messageId}: exact deletion reappeared after reload; retrying ${attempt + 2}/${maxPersistenceAttempts}`,
    );
  }
}

async function verifyDeletedAfterReload(
  page: Page,
  deleted: ReadonlyArray<{ message: ChatMessageRef; evidence: ExactMessageEvidence }>,
): Promise<void> {
  if (deleted.length === 0) return;
  const deadline = Date.now() + 20_000;
  let remaining = [...deleted];
  while (Date.now() < deadline) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".ProseMirror").first().waitFor({ state: "visible", timeout: 20_000 });
    const notProvenDeleted = [];
    for (const item of remaining) {
      if (!(await exactMessageDeletionProven(page, item.message))) {
        notProvenDeleted.push(item);
      }
    }
    remaining = notProvenDeleted;
    if (remaining.length === 0) return;
    await page.waitForTimeout(1_000);
  }
  throw new Error(
    `message ${remaining.map((item) => item.message.messageId).join(", ")}: deletion did not survive reload`,
  );
}

async function lookupInboxRun(
  page: Page,
  note: string,
  acknowledge: boolean,
): Promise<InboxRunLookup> {
  const input = JSON.stringify({ exactNote: note, shouldAcknowledge: acknowledge });
  return (await page.evaluate(`(async ({ exactNote, shouldAcknowledge }) => {
      // Execute as browser-native JavaScript: this callback has recursive/nested helpers that must
      // not inherit tsx/esbuild's Node-side keepNames implementation.
      const inbox = await import("/src/features/openchat/actionInboxClient.ts");
      const auth = await import("/src/features/auth/AuthProvider.tsx");
      const declarations = await import("/src/backend/declarations.ts");
      const routing = await import("/src/features/openchat/chatSheetLinks.ts");
      const identity = auth.loadDevIdentityForDiagnostics();
      if (!identity) throw new Error("signed-in local development identity is required");
      const actor = declarations.createActor(await auth.buildAgent(identity));
      const config = await inbox.getActionInboxConfig(actor);
      if (!config) throw new Error("OpenChat binding is not configured");
      const containsNote = (value) => {
        if (Array.isArray(value)) return value.some(containsNote);
        return (
          typeof value === "object" &&
          value !== null &&
          "note" in value &&
          value.note === exactNote
        );
      };
      const drafts = await inbox.pollActionInbox({
        config,
        identity,
        maxResults: 120,
      });
      const matches = drafts.filter((candidate) => containsNote(candidate.draft));
      const links = await routing.fetchChatSheetLinks(
        actor,
        identity.getPrincipal().toText(),
      );
      const linkedSheets = new Set(
        matches
          .map((match) => links[match.context.chatHandle])
          .filter((sheet) =>
            typeof sheet === "string" && sheet.length > 0,
          ),
      );
      let acknowledged = 0;
      // A nonce should identify one envelope. Never mutate an ambiguous set: cleanup must leave
      // duplicates intact for diagnosis rather than sweeping every partial match.
      if (shouldAcknowledge && matches.length === 1) {
        const match = matches[0];
        const result = await inbox.acknowledgeActionInbox({
          config,
          identity,
          throughId: match.id,
          acknowledgementSecret: match.acknowledgementSecret,
        });
        acknowledged += result.acknowledged;
      }
      return {
        found: matches.length === 1,
        linkedSheet: matches.length === 1 && linkedSheets.size === 1 ? [...linkedSheets][0] : null,
        matched: matches.length,
        acknowledged,
      };
    })(${input})`)) as InboxRunLookup;
}

async function accountDefaultCurrency(page: Page): Promise<string> {
  return page.evaluate(`(async () => {
    const auth = await import("/src/features/auth/AuthProvider.tsx");
    const preferences = await import("/src/features/settings/usePreferences.ts");
    const identity = auth.loadDevIdentityForDiagnostics();
    if (!identity) throw new Error("signed-in local development identity is required");
    return preferences.loadPreferences(identity.getPrincipal().toText()).defaultCurrency;
  })()`);
}

async function exactHistoryRows(page: Page, exactNote: string): Promise<Locator[]> {
  const rows = page.locator("section.history > ul > li");
  const matches: Locator[] = [];
  const count = await rows.count();
  for (let index = 0; index < count; index++) {
    const row = rows.nth(index);
    const noteField = row.locator(".row-1 > strong");
    if ((await noteField.count()) !== 1) continue;
    const renderedNote = (await noteField.innerText()).replace(/\s+/g, " ").trim();
    if (renderedNote === exactNote.replace(/\s+/g, " ").trim()) matches.push(row);
  }
  return matches;
}

async function exactPendingRows(page: Page, exactSummary: string): Promise<Locator[]> {
  const section = page.locator("section.card").filter({
    has: page.getByRole("heading", { name: /Pending from chat/i }),
  });
  const rows = section.locator(":scope > ul > li");
  const matches: Locator[] = [];
  const normalizedExpected = exactSummary.replace(/\s+/g, " ").trim();
  const count = await rows.count();
  for (let index = 0; index < count; index++) {
    const row = rows.nth(index);
    const summary = row.locator(":scope > span.small");
    if ((await summary.count()) !== 1) continue;
    // The OpenChat provenance cue is a nested span. Compare only the direct summary text node, which
    // is generated from the parsed draft, against the full expected summary.
    const renderedSummary = await summary.evaluate((node) =>
      [...node.childNodes]
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => child.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    if (renderedSummary === normalizedExpected) matches.push(row);
  }
  return matches;
}

async function waitForUniqueExactRow(
  page: Page,
  findRows: () => Promise<Locator[]>,
  label: string,
  timeoutMs: number,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await findRows();
    if (rows.length > 1) throw new Error(`${label}: found ${rows.length} exact matches; refusing ambiguity`);
    if (rows.length === 1) return rows[0];
    await page.waitForTimeout(250);
  }
  return null;
}

async function cleanupIouRun(
  page: Page,
  note: string,
  knownSheet: string | null,
  who: string,
  waitForImportedEntry: boolean,
): Promise<{ sheet: string | null; deletedEntries: number; acknowledged: number }> {
  await page.goto(`${IOU_BASE}/pairs`, { waitUntil: "domcontentloaded" }).catch(() => {});
  let lookup: InboxRunLookup = { found: false, linkedSheet: null, matched: 0, acknowledged: 0 };
  const lookupAttempts = knownSheet === null ? 10 : 1;
  for (let attempt = 0; attempt < lookupAttempts && lookup.matched === 0; attempt++) {
    lookup = await lookupInboxRun(page, note, false);
    if (lookup.matched === 0 && attempt + 1 < lookupAttempts) await page.waitForTimeout(1_500);
  }
  if (lookup.matched > 1) {
    throw new Error(
      `[${who}] ${lookup.matched} inbox envelopes exactly match this nonce; refusing cleanup mutation`,
    );
  }
  const sheet = knownSheet ?? lookup.linkedSheet;
  let exactEntries: Locator[] = [];
  if (sheet) {
    await page.goto(`${IOU_BASE}/sheet/${sheet}`, { waitUntil: "domcontentloaded" });
    const dialog = page.getByRole("dialog");
    if (await dialog.isVisible().catch(() => false)) {
      const dialogNote = await dialog
        .getByLabel("Note", { exact: true })
        .inputValue()
        .catch(() => "");
      if (dialogNote === note) {
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click().catch(() => {});
      }
    }

    if (waitForImportedEntry) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        exactEntries = await exactHistoryRows(page, note);
        if (exactEntries.length !== 0) break;
        await page.waitForTimeout(250);
      }
    } else {
      exactEntries = await exactHistoryRows(page, note);
    }
    if (exactEntries.length > 1) {
      throw new Error(
        `[${who}] ${exactEntries.length} History rows have this exact nonce; refusing cleanup mutation`,
      );
    }
  }

  // The per-delivery acknowledgement secret authorizes removal of only this exact signed inbox
  // envelope. Do this for both users so fan-out QC does not grow either persistent bucket.
  const acknowledged = await lookupInboxRun(page, note, true);
  if (acknowledged.matched > 1) {
    throw new Error(
      `[${who}] ${acknowledged.matched} inbox envelopes exactly match this nonce; none were acknowledged`,
    );
  }

  let deletedEntries = 0;
  if (exactEntries.length === 1) {
    const row = exactEntries[0];
    const remove = row.getByRole("button", { name: "delete", exact: true });
    if (!(await remove.isVisible().catch(() => false))) {
      throw new Error(`[${who}] exact nonce entry is visible but has no delete action`);
    }
    await remove.click({ timeout: 8_000 });
    await row.waitFor({ state: "hidden", timeout: 15_000 });
    deletedEntries = 1;
  }
  return { sheet, deletedEntries, acknowledged: acknowledged.acknowledged };
}

// Pair one member with IOU via the REAL Connect UI: OC AI-apps directory → Connect → claim token →
// IOU /settings → claim. (The stageA3 flow, hardened.)
async function pairViaUi(oc: Page, iou: Page, who: string): Promise<void> {
  console.log(`[${who}] pairing via the Connect UI…`);
  await oc.goto("http://localhost:5003/communities", { waitUntil: "domcontentloaded" });
  await oc.waitForTimeout(2500);
  await oc.getByText("AI apps", { exact: true }).first().click({ timeout: 15000 });
  await oc.waitForTimeout(1500);
  await oc.locator("div,a,li").filter({ hasText: /^iou$/i }).first().click({ timeout: 15000 }).catch(async () => {
    await oc.getByText(/iou/i).first().click({ timeout: 10000 });
  });
  await oc.waitForTimeout(1500);
  await oc.getByRole("button", { name: /^(Connect|Reconnect)$/ }).first().click({ timeout: 15000 });
  await oc.locator("code.code").first().waitFor({ timeout: 20000 });
  const code = (await oc.locator("code.code").first().innerText()).trim();
  if (!/^[0-9a-f]{64}$/.test(code)) throw new Error(`[${who}] malformed claim token`);
  console.log(`[${who}] received one-time claim token (${code.length} hex chars; redacted)`);

  await iou.goto(`${IOU_BASE}/settings`, { waitUntil: "domcontentloaded" });
  await iou.getByRole("heading", { name: /OpenChat action inbox/i }).waitFor({ timeout: 20000 });
  await iou.locator('input[placeholder="64-character claim token"]').fill(code);
  await iou.getByRole("button", { name: /^Connect$/ }).click();
  await iou.getByText(/Connected —/i).first().waitFor({ timeout: 30000 });
  console.log(`[${who}] paired`);
  // Close the OC modal (best-effort: Check connection resumes / dismiss).
  await oc.getByRole("button", { name: /Check connection/i }).first().click({ timeout: 5000 }).catch(() => {});
  await oc.keyboard.press("Escape").catch(() => {});
}

// ── Role parameters (the v1/v2 UI matrix) ──────────────────────────────────────────────────────
// The two OpenChat UI trees (v1 classic `components/`, v2 mobile `components_mobile/` — selected in
// main.ts by OC_MOBILE_LAYOUT=v2 + a below-breakpoint window at boot) are FULL parallel
// implementations, so each direction of the journey exercises a different propose/confirm UI. Roles
// are `user:ocPort:iouPort`; defaults = the original manager(v1-wide)→father(v2-exe) direction.
//   pnpm exec tsx scripts/live/journey-fanout.ts \
//     --proposer mother:19242:19242 --confirmer manager:19241:19241 # v2 proposes, v1 confirms
type Role = { user: string; ocPort: number; iouPort: number };
function roleArg(name: string, def: Role): Role {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) return def;
  const [user, oc, iou] = process.argv[i + 1].split(":");
  if (!user || !oc || !iou) throw new Error(`--${name} must be user:ocPort:iouPort`);
  return { user, ocPort: Number(oc), iouPort: Number(iou) };
}
const PROPOSER = roleArg("proposer", {
  user: "manager",
  ocPort: CDP_PORTS.manager,
  iouPort: CDP_PORTS.manager,
});
const CONFIRMER = roleArg("confirmer", {
  user: "father",
  ocPort: CDP_PORTS.fatherOpenChat,
  iouPort: CDP_PORTS.fatherIou,
});

function optionalArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

// Optional image/schema regression mode. It uploads real image bytes but keeps extraction
// deterministic through the existing manualExtract QC seam, so the run exercises the production
// image capability gate, schema post-pass, exact app attestation, card, delivery, and IOU import
// without making the result depend on a particular downloaded local model.
const SOURCE_IMAGE_PATH = optionalArg("image");
const REAL_MODEL = process.argv.includes("--real-model");
if (REAL_MODEL && SOURCE_IMAGE_PATH === undefined) {
  throw new Error("--real-model requires --image <path>");
}

async function main() {
  const a = await agent();
  const appId = await iouAppId(a);
  console.log(`[env] user_index=${IDS.userIndex} inbox=${IDS.inbox} appId=${appId}`);
  console.log(`[roles] proposer=${PROPOSER.user}(oc:${PROPOSER.ocPort}) confirmer=${CONFIRMER.user}(oc:${CONFIRMER.ocPort})`);

  let proposerOC = await attach(PROPOSER.ocPort, "localhost:5003");
  const confirmerOC = await attach(CONFIRMER.ocPort, "localhost:5003");
  const proposerIOU = await attach(PROPOSER.iouPort, "127.0.0.1:3000");
  const confirmerIOU = await attach(CONFIRMER.iouPort, "127.0.0.1:3000");
  const proposerRow = new RegExp(CONFIRMER.user, "i"); // the row the proposer clicks = the OTHER member
  const confirmerRow = new RegExp(PROPOSER.user, "i");

  // 1. Open the direct chat on both sides; ids come from the chat URLs. The rail row is the
  //    `.chat-summary` (web) / `.chat_summary` (mobile tree) container.
  await proposerOC.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" });
  await proposerOC.waitForTimeout(3000);
  await proposerOC.locator(".chat-summary, .chat_summary").filter({ hasText: proposerRow }).first().click({ timeout: 15000 });
  await proposerOC.waitForTimeout(2500);
  const confirmerId = /user\/([a-z0-9-]+)/.exec(proposerOC.url())?.[1];
  check(!!confirmerId, `${PROPOSER.user} side: ${CONFIRMER.user}'s user id resolved (${confirmerId})`);

  await confirmerOC.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" }).catch(() => {});
  await confirmerOC.waitForTimeout(3000);
  await confirmerOC.locator(".chat-summary, .chat_summary").filter({ hasText: confirmerRow }).first().click({ timeout: 15000 });
  await confirmerOC.waitForTimeout(2500);
  const proposerId = /user\/([a-z0-9-]+)/.exec(confirmerOC.url())?.[1];
  check(!!proposerId, `${CONFIRMER.user} side: ${PROPOSER.user}'s user id resolved (${proposerId})`);
  if (!confirmerId || !proposerId) throw new Error("could not resolve both user ids");

  // 2. The cross-user key lookup is intentionally C2C-only. Each signed-in IOU profile exposes
  //    only its own caller-private selector through its authenticated backend binding, which is
  //    exactly what this journey needs to address and count that user's inbox bucket.
  let proposerState = await actionInboxState(proposerIOU);
  let confirmerState = await actionInboxState(confirmerIOU);
  if (!proposerState.current) {
    console.log(
      `[${PROPOSER.user}] reconnecting stale/missing OpenChat link (${proposerState.bindingRevision ?? "none"} -> ${proposerState.configuredRevision ?? "unknown"})`,
    );
    await pairViaUi(proposerOC, proposerIOU, PROPOSER.user);
  }
  if (!confirmerState.current) {
    console.log(
      `[${CONFIRMER.user}] reconnecting stale/missing OpenChat link (${confirmerState.bindingRevision ?? "none"} -> ${confirmerState.configuredRevision ?? "unknown"})`,
    );
    await pairViaUi(confirmerOC, confirmerIOU, CONFIRMER.user);
  }
  proposerState = await actionInboxState(proposerIOU);
  confirmerState = await actionInboxState(confirmerIOU);
  const proposerSelector = proposerState.selector;
  const confirmerSelector = confirmerState.selector;
  check(
    proposerState.current && !!proposerSelector,
    `${PROPOSER.user} has a current-revision authenticated per-user IOU inbox selector`,
  );
  check(
    confirmerState.current && !!confirmerSelector,
    `${CONFIRMER.user} has a current-revision authenticated per-user IOU inbox selector`,
  );
  if (!proposerSelector || !confirmerSelector) throw new Error("pairing failed");

  // Re-open the direct chat on BOTH sides (pairing navigates each paired member's OC page away to
  // /communities — the confirm gate polls the confirmer's page, so their chat must be open too).
  for (const [page, rowRx] of [[proposerOC, proposerRow], [confirmerOC, confirmerRow]] as const) {
    await page.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.locator(".chat-summary, .chat_summary").filter({ hasText: rowRx }).first().click({ timeout: 15000 });
    await page.waitForTimeout(2000);
  }

  // 3. Bucket snapshot.
  const fpProposer = proposerSelector;
  const fpConfirmer = confirmerSelector;
  const before = { proposer: await bucketCount(a, fpProposer), confirmer: await bucketCount(a, fpConfirmer) };
  console.log("[inbox] before:", before);

  const nonce = `${Date.now()}-${webcrypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  const note = `journey ${nonce}`;
  const imageScenario = SOURCE_IMAGE_PATH !== undefined;
  const extraction = JSON.stringify({
    kind: "iou",
    amount: 350,
    // These are representative vision-model mistakes from OpenChat #102. In image mode both must
    // be removed by the deterministic schema post-pass before exact app attestation; the isolated
    // IOU card then supplies the deployment currency and leaves the invalid date empty.
    currency: imageScenario ? "$$$" : "EGP",
    direction: "credit",
    ...(imageScenario ? { date: "2026-02-30" } : {}),
    note,
    ...(imageScenario
      ? {}
      : { message: journeySourceText({ imagePath: SOURCE_IMAGE_PATH, nonce })! }),
  });
  let proposerQcPage: Page | null = null;
  let proposerObserverInstalled = false;
  let confirmerObserverInstalled = false;
  let promptOverrideHandle: ManualPromptOverrideHandle | null = null;
  let navigationListenerInstalled = false;
  let senderMainFrameNavigations = 0;
  let sourceBaseline: StableMessageBaseline | null = null;
  let sourceSendAttempted = false;
  let sourceSendProven = false;
  let draftBlobCaptureInstalled = false;
  let draftAttachmentSelectionStarted = false;
  let exactDraftSelectionBoundary: ExactDraftSelectionBoundary | null = null;
  let exactPartialDraftBinding: ExactPartialDraftBinding | null = null;
  let exactDraftImageBinding: ExactDraftImageBinding | null = null;
  let sourceEvidence: SourceMessageEvidence | null = null;
  let sourceMessage: ChatMessageRef | null = null;
  let exactOptimisticSourceBinding: ExactOptimisticSourceBinding | null = null;
  let senderCard: LoadedRunCard | null = null;
  let confirmerCard: LoadedRunCard | null = null;
  const senderCandidateCards = new Map<string, LoadedRunCard>();
  const confirmerCandidateCards = new Map<string, LoadedRunCard>();
  const senderRunCards = new Map<string, NonceBoundRunCard>();
  const confirmerRunCards = new Map<string, NonceBoundRunCard>();
  let confirmerLinkedSheet: string | null = null;
  let confirmationAttempted = false;
  let entrySubmissionAttempted = false;
  let deliveryObserved = false;
  let journeyBodyCompleted = false;
  const documentMarker = `iou-card-journey-${nonce}`;
  const draftFooterMarker = `${documentMarker}-draft-footer`;
  const onSenderNavigation = (frame: Frame) => {
    if (frame === proposerOC.mainFrame()) senderMainFrameNavigations++;
  };
  const retainExactOptimisticSourceBinding = (message: ChatMessageRef) => {
    if (sourceEvidence?.kind !== "image") {
      throw new Error("exact optimistic image binding appeared without image source evidence");
    }
    const next: ExactOptimisticSourceBinding = {
      boundMessage: { ...message },
      boundDraftUrl: sourceEvidence.exactDraftUrl,
    };
    if (
      exactOptimisticSourceBinding !== null &&
      (!sameStableMessage(exactOptimisticSourceBinding.boundMessage, next.boundMessage) ||
        exactOptimisticSourceBinding.boundDraftUrl !== next.boundDraftUrl)
    ) {
      throw new Error("exact optimistic image binding changed stable source identity");
    }
    exactOptimisticSourceBinding = next;
  };
  const currentExactOptimisticSourceBinding = (): ExactOptimisticSourceBinding | null =>
    exactOptimisticSourceBinding;

  try {

  // 4. The proposer sends a message and proposes. The normal mode uses the deterministic manual-QC
  // seam; --real-model stays on the ordinary URL and exercises the selected local vision model.
  // Issue 1 test seam: with no on-device model, REAL users are now guided to set one up instead of a
  // raw JSON prompt. The automated journey opts in only on a temporary tab whose URL carries the
  // one-shot QC query. The user's normal OpenChat tab and persistent storage are never modified.
  const regularProposerPage = proposerOC;
  const qcUrl = new URL(regularProposerPage.url());
  if (REAL_MODEL) {
    qcUrl.searchParams.delete("manualExtract");
    if (regularProposerPage.url() !== qcUrl.toString()) {
      await regularProposerPage.goto(qcUrl.toString(), { waitUntil: "domcontentloaded" });
      await regularProposerPage.waitForTimeout(2_500);
    }
    const readiness = await waitForImageModelReady(proposerOC);
    console.log(
      `[${PROPOSER.user}] local image model ready: ${readiness.selectedModelId ?? "selected model"}`,
    );
  } else {
    qcUrl.searchParams.set("manualExtract", "1");
    proposerQcPage = await regularProposerPage.context().newPage();
    await proposerQcPage.goto(qcUrl.toString(), { waitUntil: "domcontentloaded" });
    await proposerQcPage.waitForTimeout(2_500);
    proposerOC = proposerQcPage;
  }
  await installNewCardObserver(proposerOC, `sender-${nonce}`);
  proposerObserverInstalled = true;
  await installNewCardObserver(confirmerOC, `recipient-${nonce}`);
  confirmerObserverInstalled = true;
  await proposerOC.evaluate((marker) => {
    (globalThis as typeof globalThis & { __iouJourneyDocumentMarker?: string })
      .__iouJourneyDocumentMarker = marker;
  }, documentMarker);
  proposerOC.on("framenavigated", onSenderNavigation);
  navigationListenerInstalled = true;
  // Only the disposable manualExtract tab replaces the browser primitive. The product's ordinary
  // runProposeFlow still calls parseManualExtractionPrompt; this override merely returns its exact
  // deterministic JSON synchronously so Playwright cannot race and auto-dismiss the native prompt.
  if (!REAL_MODEL) {
    promptOverrideHandle = await installManualPromptOverride(proposerOC, extraction);
  }
  // Dismiss any open modal/sheet overlay first (a leftover #masked_overlay — e.g. an open chat menu
  // from a prior aborted run — silently intercepts ALL pointer events on the v2 tree).
  for (let i = 0; i < 3; i++) {
    const blocked = await proposerOC.evaluate(
      `(() => { const ov = document.querySelector('#masked_overlay'); return !!ov && ov.className.includes('visible'); })()`,
    );
    if (!blocked) break;
    await proposerOC.keyboard.press("Escape").catch(() => {});
    await proposerOC.waitForTimeout(500);
    await proposerOC.locator("#masked_overlay").click({ position: { x: 10, y: 10 }, timeout: 3000 }).catch(() => {});
    await proposerOC.waitForTimeout(500);
  }
  sourceBaseline = await captureStableMessageBaseline(proposerOC);
  const composer = proposerOC.locator(".ProseMirror").first();
  await composer.waitFor({ timeout: 15000 });
  if (SOURCE_IMAGE_PATH !== undefined) {
    const fileInputs = proposerOC.locator('input[type="file"]');
    const imageFileInputs = proposerOC.locator('input[type="file"][accept*="image"]');
    const inputCount = await fileInputs.count();
    const imageInputCount = await imageFileInputs.count();
    const exactFileInput =
      imageInputCount === 1
        ? imageFileInputs.first()
        : imageInputCount === 0 && inputCount === 1
          ? fileInputs.first()
          : null;
    if (exactFileInput === null) {
      throw new Error(
        `image journey expected one exact image input, found ${imageInputCount} image/${inputCount} total`,
      );
    }
    exactDraftSelectionBoundary = await prepareExactDraftAttachmentSelection(
      proposerOC,
      composer,
      draftFooterMarker,
    );
    await installExactDraftBlobCapture(proposerOC);
    draftBlobCaptureInstalled = true;
    draftAttachmentSelectionStarted = true;
    try {
      await exactFileInput.setInputFiles(SOURCE_IMAGE_PATH);
      exactPartialDraftBinding = await retainExactPartialDraftBinding(
        proposerOC,
        exactDraftSelectionBoundary,
      );
      await assertStableDraftMessageBoundary(
        proposerOC,
        exactPartialDraftBinding.messageBoundary,
        "stable message boundary changed while binding the selected image draft",
      );
      exactDraftImageBinding = await captureExactDraftImageContent(
        proposerOC,
        exactPartialDraftBinding,
      );
    } finally {
      await removeExactDraftBlobCapture(proposerOC);
      draftBlobCaptureInstalled = false;
    }
  }
  const sourceText = journeySourceText({ imagePath: SOURCE_IMAGE_PATH, nonce });
  sourceEvidence =
    exactDraftImageBinding === null
      ? { kind: "text", exactText: sourceText! }
      : {
          kind: "image",
          exactContent: exactDraftImageBinding.exactContent,
          exactDraftUrl: exactDraftImageBinding.draftUrl,
        };
  sourceSendAttempted = true;
  await sendJourneySource(proposerOC, composer, sourceText);
  console.log(
    sourceText === undefined
      ? `[${PROPOSER.user}] sent image-only attachment`
      : `[${PROPOSER.user}] sent text: ${sourceText}`,
  );
  sourceMessage = await captureFreshSourceMessage(
    proposerOC,
    sourceEvidence,
    sourceBaseline,
    PROPOSER.user,
    15_000,
    retainExactOptimisticSourceBinding,
  );
  const optimisticBindingAfterCapture = currentExactOptimisticSourceBinding();
  if (
    optimisticBindingAfterCapture !== null &&
    !sameStableMessage(sourceMessage, optimisticBindingAfterCapture.boundMessage)
  ) {
    throw new Error("uploaded source differs from the retained exact optimistic binding");
  }
  sourceSendProven = true;
  check(
    true,
    `${PROPOSER.user} fresh Journey source is sender-owned and captured as message ${sourceMessage.messageId}/${sourceMessage.messageIndex}/${sourceMessage.eventIndex}`,
  );

  // The propose entry is the message menu ("Propose action"): hover the just-sent bubble to reveal
  // its menu icon, open it, click the item — the manual-JSON prompt then fires and the override
  // above answers it deterministically. Propose is clicked at most once; slow model work extends the
  // observation window instead. Success = OUR card's confirm button visible on the CONFIRMER side.
  // The confirm button
  // carries the MANIFEST's confirm_label — for the live iou app "Add to IOU".
  //
  // Confirm targeting is scoped to THIS RUN'S card, never the last card on the page. The sender-side
  // card must be sender-owned and the unique immediate stable successor of the captured source. The
  // recipient may load only the exact message id/index/event coordinates selected on the sender.
  // Deterministic mode's nonce remains secondary evidence. Real-model mode sends only the image
  // bytes and validates the model-owned iframe values before any downstream edit.
  // v1 vs v2 propose UI: the classic tree has .bubble-wrapper + a hover menu with a text item. The
  // v2 (components_mobile) tree first opens a sender-owned icon toolbar; open its exact More control
  // and select Propose action from the accessible full menu rather than depending on an SVG path.
  const isV2 = (await proposerOC.locator(".bubble-wrapper").count()) === 0;
  console.log(`[${PROPOSER.user}] propose UI tree: ${isV2 ? "v2 (mobile)" : "v1 (classic)"}`);
  let posted = false;
  let proposalCardObserved = false;
  const maxProposalAttempts = 1;
  for (let attempt = 1; attempt <= maxProposalAttempts && !posted; attempt++) {
    // Propose is a mutation, so this journey is deliberately one-shot. A slow card/backend must
    // extend the observation wait, never trigger another click that can post a duplicate card.
    try {
      proposalCardObserved ||= (await observedRunCardCount(proposerOC)) > 0;
      if (!proposalCardObserved) {
      await proposerOC.locator(".toast .close").last().click({ timeout: 1_000 }).catch(() => {});
      if (
        sourceEvidence === null ||
        !(await exactMessageEvidencePresent(proposerOC, sourceMessage!, {
          kind: "source",
          evidence: sourceEvidence,
        }))
      ) {
        throw new Error("Journey source evidence changed before Propose; refusing mutation");
      }
      if (isV2) {
        const ownedMenu = await openOwnedMobileMessageMenu(proposerOC, sourceMessage!);
        const more = await exactlyOneVisible(
          ownedMenu.locator(".menu-btn button"),
          "sender-owned mobile full menu",
        );
        // openOwnedMobileMessageMenu already opened the exact sender-owned message's v2 sheet using
        // its stable wrapper and the device-appropriate gesture; do not run a second gesture path.
        proposalCardObserved ||= (await observedRunCardCount(proposerOC)) > 0;
        if (proposalCardObserved) {
          throw new Error("a card appeared while opening the v2 action sheet; refusing another Propose click");
        }
        await more.click({ timeout: 8_000 });
        const propose = await exactlyOneVisible(
          proposerOC.getByRole("menuitem", { name: "Propose action", exact: true }),
          "sender-owned Propose action",
        );
        await propose.click({ timeout: 12_000 });
      } else {
        const wrapper = exactMessageWrapper(proposerOC, sourceMessage!);
        if (!(await wrapper.evaluate((node) => node.classList.contains("me")))) {
          throw new Error("classic Journey source is not sender-owned");
        }
        const bubble = wrapper.locator(".bubble-wrapper");
        if ((await bubble.count()) !== 1) throw new Error("classic Journey source bubble is ambiguous");
        await bubble.hover();
        await proposerOC.waitForTimeout(500);
        const menuIcon = await exactlyOneVisible(bubble.locator(".menu-icon"), "classic source menu");
        await menuIcon.click({ timeout: 12000 });
        const propose = await exactlyOneVisible(
          proposerOC.getByRole("menuitem", { name: "Propose action", exact: true }),
          "classic sender-owned Propose action",
        );
        proposalCardObserved ||= (await observedRunCardCount(proposerOC)) > 0;
        if (proposalCardObserved) {
          throw new Error("a card appeared while opening the classic menu; refusing another Propose click");
        }
        await propose.click({ timeout: 12000 });
      }
      console.log(
        `[${PROPOSER.user}] proposed (attempt ${attempt}, ${
          REAL_MODEL ? "local vision model" : "manual JSON — no model"
        })`,
      );
      }
      if (proposalCardObserved) {
        console.log(
          `[${PROPOSER.user}] an observed card already exists; attempt ${attempt} only waits and never clicks Propose again`,
        );
      }
      const foundSenderCards = await findAndLoadRunCards(
        proposerOC,
        note,
        PROPOSER.user,
        REAL_MODEL ? 600_000 : 60_000,
        true,
        { expectedSource: sourceMessage!, requireSenderOwned: true },
      );
      rememberRunCards(senderCandidateCards, foundSenderCards, PROPOSER.user);
      proposalCardObserved ||= (await observedRunCardCount(proposerOC)) > 0;
      senderCard = uniqueTrackedRunCard(senderCandidateCards, PROPOSER.user);
      if (senderCard) {
        // A sender-side card proves the post succeeded. Do not post a duplicate merely because the
        // other browser is still catching up; wait for its authoritative hydration instead.
        const foundConfirmerCards = await findAndLoadRunCards(
          confirmerOC,
          note,
          CONFIRMER.user,
          35_000,
          false,
          { expectedMessage: senderCard.message },
        );
        rememberRunCards(confirmerCandidateCards, foundConfirmerCards, CONFIRMER.user);
        confirmerCard = uniqueTrackedRunCard(confirmerCandidateCards, CONFIRMER.user);
      }
      posted = senderCard !== null && confirmerCard !== null;
      if (!posted) {
        const failure = await proposalFailureText(proposerOC);
        if (failure) console.log(`[${PROPOSER.user}] proposal failure: ${failure}`);
      }
    } catch (e) {
      console.log(`[${PROPOSER.user}] propose attempt ${attempt} failed: ${(e as Error).message.slice(0, 90)}`);
      proposalCardObserved ||= (await observedRunCardCount(proposerOC).catch(() => 0)) > 0;
    }
    if (!posted) {
      // Clear any leftover sheet/overlay before teardown. There is intentionally no retry.
      await proposerOC.keyboard.press("Escape").catch(() => {});
      await proposerOC.locator("#masked_overlay").click({ position: { x: 10, y: 10 }, timeout: 2000 }).catch(() => {});
      await proposerOC.waitForTimeout(1000);
    }
  }
  senderCard = uniqueTrackedRunCard(senderCandidateCards, PROPOSER.user);
  confirmerCard = uniqueTrackedRunCard(confirmerCandidateCards, CONFIRMER.user);
  posted = senderCard !== null && confirmerCard !== null;
  if (!REAL_MODEL) {
    if (promptOverrideHandle === null) {
      throw new Error("manual prompt override handle was not retained");
    }
    const promptProbe = await readManualPromptProbe(proposerOC, promptOverrideHandle);
    const promptMessage = promptProbe.prompts[0] ?? "";
    console.log(
      `[${PROPOSER.user}] manual extraction prompt calls=${promptProbe.promptCalls}, message=${JSON.stringify(promptMessage.slice(0, 160))}`,
    );
    const exactlyOnePrompt = promptProbe.promptCalls === 1 && promptProbe.prompts.length === 1;
    const isExtractionPrompt = exactlyOnePrompt && /JSON/i.test(promptMessage);
    check(exactlyOnePrompt, `runProposeFlow opened exactly one manual extraction prompt`);
    check(isExtractionPrompt, `parseManualExtractionPrompt received the expected JSON prompt`);
    if (!exactlyOnePrompt || !isExtractionPrompt) {
      throw new Error("manual extraction prompt count/message did not match this run");
    }
    // Restore while this disposable tab is still on the exact page that owns the hook. Cleanup later
    // reloads the proposer to prove deletions persist; retaining the handle until then would turn a
    // successful run into a false "override state was missing" teardown failure.
    await removeManualPromptOverride(proposerOC, promptOverrideHandle);
    promptOverrideHandle = null;
  }
  check(posted, `the nonce-scoped trusted action card auto-loaded for both participants`);
  if (!posted) throw new Error("card never posted");

  const sameCardMessage = sameStableMessage(senderCard!.message, confirmerCard!.message);
  const cardFollowsSource =
    sourceMessage !== null &&
    isImmediateStableSuccessor(sourceMessage, senderCard!.message);
  check(sameCardMessage, "sender and confirmer resolved the nonce-scoped card to the same stable message");
  check(cardFollowsSource, "the captured card message follows this run's captured Journey source");
  if (!sameCardMessage || !cardFollowsSource) {
    throw new Error("nonce-scoped card message coordinates did not cross-check; refusing confirmation");
  }

  check(
    senderCard!.loadedAutomatically,
    "sender's freshly proposed attested card loaded automatically",
  );
  check(confirmerCard!.loadedAutomatically, "recipient's trusted card loaded automatically");
  const senderTransitions = await observedCardTransitions(proposerOC, senderCard!.observerId);
  const sawOptimistic = senderTransitions.some((value) => value.includes("Unverified card binding"));
  const sawVerified = senderTransitions.some((value) => /^iou\s+Add to IOU\b/i.test(value));
  const markerSurvived = await proposerOC.evaluate(
    (marker) =>
      (globalThis as typeof globalThis & { __iouJourneyDocumentMarker?: string })
        .__iouJourneyDocumentMarker === marker,
    documentMarker,
  );
  check(sawOptimistic, "sender card was observed in its optimistic/unverified state");
  check(sawVerified, "the same sender card became directory-bound and actionable");
  check(
    markerSurvived && senderMainFrameNavigations === 0,
    "sender optimistic→verified transition completed in-place without reload/navigation",
  );
  if (!sawOptimistic || !sawVerified || !markerSurvived || senderMainFrameNavigations !== 0) {
    throw new Error("sender card did not transition from optimistic to verified in place");
  }

  // 5. The confirmer (the NON-proposer) confirms through the nonce-scoped card's host-owned action.
  //    Belt-and-braces before clicking: the matched iframe must carry this run's amount 350 in one of
  //    its inputs (a mis-scoped or stale card fails here instead of getting confirmed). The app-owned
  //    card has no redundant disclosure or iframe action: one OpenChat-owned "Add to IOU" click
  //    challenges the frame for its exact current values, grants those bytes, and submits directly.
  const outerCard = confirmerCard!.card;
  const frame = confirmerCard!.frame;
  await assertTrustedIouCardChrome(confirmerCard!);
  const outerText = await outerCard.innerText();
  const staleDirectoryWarning = outerText.includes("Directory binding only; card content is untrusted");
  const staleTextWarning = outerText.includes("Untrusted card text");
  check(!staleDirectoryWarning, "backend-attested card omits the stale untrusted-content warning");
  check(!staleTextWarning, "backend-attested card omits the stale untrusted-text warning");
  if (staleDirectoryWarning || staleTextWarning) {
    throw new Error("backend-attested card still renders stale untrusted-content copy");
  }
  if (REAL_MODEL) {
    // Validate the model-owned semantic fields before editing anything. The source has no visible
    // text, so a text-only path or wrong extraction fails here. Only downstream test correlation
    // fields are normalized after acceptance; the fixture-owned Type, amount, currency, direction,
    // and absent Date remain untouched.
    const entryCount = await frame.getByLabel("Type", { exact: true }).count();
    const transaction = await requireExactlyOneCardControl(frame, "Type");
    const amount = await requireExactlyOneCardControl(frame, "Amount");
    const currency = await requireExactlyOneCardControl(frame, "Currency");
    const direction = await requireExactlyOneCardControl(frame, "Direction");
    const noteControl = await requireExactlyOneCardControl(frame, "Note");
    const accountType = await requireExactlyOneCardControl(frame, "Saved type");
    const date = await requireExactlyOneCardControl(frame, "Date");
    const accepted = assertAcceptedVisionExtraction({
      entryCount,
      kind: await transaction.inputValue(),
      amount: await amount.inputValue(),
      currency: await currency.inputValue(),
      direction: await direction.inputValue(),
      date: await date.inputValue(),
    });
    check(
      accepted.entryCount === 1 &&
        accepted.kind === "iou" &&
        accepted.amount === 350 &&
        accepted.currency === "EGP" &&
        accepted.direction === "credit" &&
        accepted.date === "",
      "the image-only model produced one IOU/350 EGP/credit/no-date entry before card editing",
    );

    const senderHostAdd = senderCard!.card.getByRole("button", {
      name: "Add to IOU",
      exact: true,
    });
    const confirmerHostAdd = confirmerCard!.card.getByRole("button", {
      name: "Add to IOU",
      exact: true,
    });
    await Promise.all([
      waitForHostAddEnabled(senderCard!, senderHostAdd),
      waitForHostAddEnabled(confirmerCard!, confirmerHostAdd),
    ]);
    await noteControl.fill(note);
    const senderNoteControl = await requireExactlyOneCardControl(senderCard!.frame, "Note");
    await senderNoteControl.fill(note);
    await accountType.selectOption("");
  }
  const [senderNonceBound, confirmerNonceBound] = await Promise.all([
    cardHasExactRunNote(senderCard!, note),
    cardHasExactRunNote(confirmerCard!, note),
  ]);
  if (!senderNonceBound || !confirmerNonceBound) {
    throw new Error("card did not acquire exact run-note evidence; refusing confirmation and cleanup mutation");
  }
  await rememberNonceBoundRunCards(senderRunCards, [senderCard!], note, PROPOSER.user);
  await rememberNonceBoundRunCards(confirmerRunCards, [confirmerCard!], note, CONFIRMER.user);
  const inputVals: string[] = [];
  const fin = frame.locator("input");
  const finCount = await fin.count().catch(() => 0);
  for (let i = 0; i < finCount; i++) inputVals.push(await fin.nth(i).inputValue().catch(() => ""));
  const exactAmount = await frame.getByLabel("Amount", { exact: true }).inputValue();
  const cardIsOurs = Number(exactAmount) === 350;
  check(cardIsOurs, `the matched card carries this run's amount 350 (${JSON.stringify(inputVals)})`);
  if (!cardIsOurs) throw new Error("matched card is not this run's draft — refusing to confirm");
  const cardCurrency = await frame.getByLabel("Currency", { exact: true }).inputValue();
  const invalidImageCurrencySurvived = cardCurrency === "$$$";
  const expectedCardCurrency = imageScenario && !REAL_MODEL ? "" : "EGP";
  check(
    cardCurrency === expectedCardCurrency,
    imageScenario && !REAL_MODEL
      ? "the invalid image currency was removed and deferred to the importing IOU account"
      : "the matched card preserves this run's stated EGP currency",
  );
  if (cardCurrency !== expectedCardCurrency) {
    throw new Error(
      `matched card currency was ${cardCurrency || "default"}; expected ${expectedCardCurrency || "default"}`,
    );
  }
  if (imageScenario && !REAL_MODEL) {
    check(
      !inputVals.includes("2026-02-30") && !invalidImageCurrencySurvived,
      "invalid optional image extraction fields were stripped before exact app attestation",
    );
    if (inputVals.includes("2026-02-30") || invalidImageCurrencySurvived) {
      throw new Error("image schema post-pass retained an invalid optional field");
    }
  }
  confirmationAttempted = true;
  await approveRunCardConfirmation(confirmerCard!, note, expectedCardCurrency);
  console.log(`[${CONFIRMER.user}] confirmed with one host-owned Add to IOU click`);
  await confirmerOC.waitForTimeout(6000);

  // 6. Per-user delivery: ONE confirm → +1 envelope for the authoritative confirmer only. The
  //    non-confirmer's own key must not receive a copy (OpenChat's card route is confirmer-bound).
  const after = { proposer: await bucketCount(a, fpProposer), confirmer: await bucketCount(a, fpConfirmer) };
  console.log("[inbox] after:", after);
  check(after.proposer === before.proposer, `${PROPOSER.user} non-confirmer bucket unchanged (${before.proposer})`);
  check(after.confirmer === before.confirmer + 1, `${CONFIRMER.user} bucket +1 (${before.confirmer} → ${after.confirmer})`);
  deliveryObserved = after.proposer === before.proposer && after.confirmer === before.confirmer + 1;

  // 7. Continue through the IOU consumer UI. Resolve this exact delivery's opaque chat handle from
  //    the verified inbox envelope, then resolve that handle through the authenticated user's
  //    canister-backed chat→sheet map. Do not guess from a raw OpenChat user id or a legacy
  //    localStorage key: v4 routes are app-scoped 32-byte handles.
  await confirmerIOU.goto(`${IOU_BASE}/pairs`, { waitUntil: "domcontentloaded" });
  let route: InboxRunLookup = { found: false, linkedSheet: null, matched: 0, acknowledged: 0 };
  for (let i = 0; i < 10 && !route.found; i++) {
    route = await lookupInboxRun(confirmerIOU, note, false);
    if (!route.found) await confirmerIOU.waitForTimeout(2000);
  }
  check(route.found, `the verified IOU inbox contains this run's draft (${note})`);
  check(!!route.linkedSheet, `this chat's app-scoped route resolves to one IOU sheet`);
  if (!route.found || !route.linkedSheet) {
    throw new Error("this run's verified draft or authoritative chat→sheet route is unavailable");
  }
  confirmerLinkedSheet = route.linkedSheet;

  await confirmerIOU.goto(`${IOU_BASE}/sheet/${confirmerLinkedSheet}`, {
    waitUntil: "domcontentloaded",
  });
  const importCurrency =
    expectedCardCurrency || (await accountDefaultCurrency(confirmerIOU));
  const resolvedDraftDate = new Date().toISOString().slice(0, 10);
  const pendingSummary = `IOU 350.00 ${importCurrency} \u00b7 owed to you \u00b7 ${resolvedDraftDate} \u00b7 ${note}`;
  // Let SheetPage's authenticated ActionInbox effect finish. Repeated short reloads cancel that
  // effect and can starve a healthy poll forever; use one uninterrupted wait, then one fallback
  // reload for a genuinely missed mount.
  let pendingCard = await waitForUniqueExactRow(
    confirmerIOU,
    () => exactPendingRows(confirmerIOU, pendingSummary),
    "pending IOU draft",
    30_000,
  );
  if (pendingCard === null) {
    await confirmerIOU.reload({ waitUntil: "domcontentloaded" });
    pendingCard = await waitForUniqueExactRow(
      confirmerIOU,
      () => exactPendingRows(confirmerIOU, pendingSummary),
      "pending IOU draft after reload",
      30_000,
    );
  }
  check(pendingCard !== null, `this run's exact draft summary appears under Pending from chat`);
  if (pendingCard === null) throw new Error("this run's pending IOU draft did not render");

  await pendingCard.getByRole("button", { name: /Review & add/i }).click({ timeout: 10000 });
  const entryDialog = confirmerIOU.getByRole("dialog");
  await entryDialog.getByRole("heading", { name: "Add entry", exact: true }).waitFor({ timeout: 10000 });
  const formValues = {
    // EntryForm uses wrapping labels without explicit htmlFor/id pairs. Keep these selectors aligned
    // with test/ui/flows.ts: the transaction currency is the first select and the transaction
    // amount is the first number input (later controls belong to optional fee/schedule sections).
    amount: await entryDialog.locator('input[type="number"]').first().inputValue(),
    date: await entryDialog.locator('input[type="date"]').first().inputValue(),
    currency: await entryDialog.locator("select").first().inputValue(),
    note: await entryDialog.locator('input[placeholder="lunch, taxi, etc."]').inputValue(),
    credit: await entryDialog
      .locator("fieldset")
      .filter({ hasText: "Direction" })
      .locator('input[type="radio"]')
      .first()
      .isChecked(),
  };
  const formMatches =
    Number(formValues.amount) === 350 &&
    formValues.date === resolvedDraftDate &&
    formValues.currency === importCurrency &&
    formValues.note === note &&
    formValues.credit;
  if (!formMatches) {
    console.error("[form] observed prefill:", JSON.stringify(formValues));
  }
  check(formMatches, "Review & add opens a prefilled EntryForm with this card's exact values");
  if (!formMatches) throw new Error("prefilled EntryForm does not match this run's card");

  entrySubmissionAttempted = true;
  await entryDialog.getByRole("button", { name: "Add entry", exact: true }).click({ timeout: 10000 });
  await entryDialog.waitFor({ state: "hidden", timeout: 30000 });
  const createdEntry = await waitForUniqueExactRow(
    confirmerIOU,
    () => exactHistoryRows(confirmerIOU, note),
    "created History entry",
    30_000,
  );
  if (createdEntry === null) throw new Error("the exact submitted History entry did not render");
  check(await createdEntry.isVisible(), `the submitted entry is present in .history with nonce ${nonce}`);
  check(!(await pendingCard.isVisible().catch(() => false)), "the consumed Pending from chat card is gone");
  journeyBodyCompleted = true;
  } finally {
    try {
    try {
      if (navigationListenerInstalled) proposerOC.off("framenavigated", onSenderNavigation);
    } catch (error) {
      failures++;
      console.error(`[cleanup] navigation-listener teardown failed: ${(error as Error).message}`);
    }

    if (draftBlobCaptureInstalled) {
      try {
        await removeExactDraftBlobCapture(proposerOC);
        draftBlobCaptureInstalled = false;
      } catch (error) {
        failures++;
        console.error(`[cleanup] draft Blob capture teardown failed: ${(error as Error).message}`);
      }
    }

    // Enter may have succeeded even if the immediate coordinate capture then failed. Recover only a
    // unique sender-owned message carrying this run's exact text/blob evidence and absent message id;
    // ambiguity is reported and left untouched.
    if (
      sourceSendAttempted &&
      sourceMessage === null &&
      sourceBaseline !== null &&
      sourceEvidence !== null
    ) {
      try {
        sourceMessage = await captureFreshSourceMessage(
          proposerOC,
          sourceEvidence,
          sourceBaseline,
          PROPOSER.user,
          3_000,
          retainExactOptimisticSourceBinding,
        );
        const optimisticBindingAfterRecovery = currentExactOptimisticSourceBinding();
        if (
          optimisticBindingAfterRecovery !== null &&
          !sameStableMessage(sourceMessage, optimisticBindingAfterRecovery.boundMessage)
        ) {
          throw new Error("recovered source differs from the retained exact optimistic binding");
        }
        sourceSendProven = true;
        console.log(`[cleanup] recovered exact Journey source message ${sourceMessage.messageId}`);
      } catch (error) {
        failures++;
        console.error(`[cleanup] exact Journey source recovery failed: ${(error as Error).message}`);
      }
    }

    if (
      draftAttachmentSelectionStarted &&
      !sourceSendProven &&
      exactPartialDraftBinding !== null
    ) {
      try {
        const removed = await clearExactUnsentDraftAttachment(
          proposerOC,
          exactPartialDraftBinding,
        );
        cleanupCheck(
          true,
          removed
            ? "cleanup removed exact unsent image draft"
            : "cleanup proved the exact bound image draft was already absent",
        );
      } catch (error) {
        failures++;
        console.error(`[cleanup] exact unsent image draft removal failed: ${(error as Error).message}`);
      }
    }
    if (exactDraftSelectionBoundary !== null) {
      try {
        await removeExactDraftFooterMarker(proposerOC, exactDraftSelectionBoundary);
      } catch (error) {
        failures++;
        console.error(`[cleanup] exact draft footer marker removal failed: ${(error as Error).message}`);
      }
    }

    // A failed run must not leave its still-pending chat action behind. Re-identify only the
    // sender-owned immediate successor of this run's captured source. A late real-model completion
    // gets one additional nonce-bound observation window here; this never retries Propose. If source
    // capture failed, leave the chat untouched rather than weakening cleanup identity.
    if (proposerObserverInstalled && sourceMessage !== null) {
      try {
        await rememberNonceBoundRunCards(
          senderRunCards,
          await findAndLoadRunCards(
            proposerOC,
            note,
            PROPOSER.user,
            REAL_MODEL ? 60_000 : 5_000,
            false,
            { expectedSource: sourceMessage, requireSenderOwned: true },
          ),
          note,
          PROPOSER.user,
        );
      } catch (error) {
        failures++;
        console.error(`[cleanup] OpenChat sender-card inventory failed: ${(error as Error).message}`);
      }
    }
    const cleanupSenderCard =
      senderRunCards.size === 1 ? senderRunCards.values().next().value : undefined;
    if (confirmerObserverInstalled && cleanupSenderCard !== undefined) {
      try {
        await rememberNonceBoundRunCards(
          confirmerRunCards,
          await findAndLoadRunCards(
            confirmerOC,
            note,
            CONFIRMER.user,
            5_000,
            false,
            { expectedMessage: cleanupSenderCard.message },
          ),
          note,
          CONFIRMER.user,
        );
      } catch (error) {
        failures++;
        console.error(`[cleanup] OpenChat recipient-card inventory failed: ${(error as Error).message}`);
      }
    }
    if (!deliveryObserved) {
      for (const trackedCard of [...senderRunCards.values()].sort(
        (left, right) => right.message.messageIndex - left.message.messageIndex,
      )) {
        try {
          const cancelled = await cancelRunCard(trackedCard);
          console.log(
            cancelled
              ? `[cleanup] cancelled nonce-scoped pending OpenChat card ${trackedCard.message.messageId}`
              : `[cleanup] nonce card ${trackedCard.message.messageId} was no longer cancellable`,
          );
        } catch (error) {
          failures++;
          console.error(
            `[cleanup] OpenChat card ${trackedCard.message.messageId} cancellation failed: ${(error as Error).message}`,
          );
        }
      }
    }

    let confirmerCleanup:
      | { sheet: string | null; deletedEntries: number; acknowledged: number }
      | undefined;
    if (confirmationAttempted || deliveryObserved || confirmerLinkedSheet !== null) {
      try {
        confirmerCleanup = await cleanupIouRun(
          confirmerIOU,
          note,
          confirmerLinkedSheet,
          CONFIRMER.user,
          entrySubmissionAttempted,
        );
        console.log(
          `[cleanup] ${CONFIRMER.user}: deleted=${confirmerCleanup.deletedEntries}, acknowledged=${confirmerCleanup.acknowledged}`,
        );
      } catch (error) {
        failures++;
        console.error(`[cleanup] ${CONFIRMER.user} IOU cleanup failed: ${(error as Error).message}`);
      }
      try {
        const proposerCleanup = await cleanupIouRun(
          proposerIOU,
          note,
          null,
          PROPOSER.user,
          false,
        );
        console.log(
          `[cleanup] ${PROPOSER.user}: deleted=${proposerCleanup.deletedEntries}, acknowledged=${proposerCleanup.acknowledged}`,
        );
      } catch (error) {
        failures++;
        console.error(`[cleanup] ${PROPOSER.user} IOU cleanup failed: ${(error as Error).message}`);
      }
    }

    if (journeyBodyCompleted) {
      cleanupCheck(
        confirmerCleanup?.deletedEntries === 1,
        `cleanup soft-deleted exactly this run's imported History entry`,
      );
    }
    if (deliveryObserved) {
      try {
      let finalBuckets = {
        proposer: await bucketCount(a, fpProposer),
        confirmer: await bucketCount(a, fpConfirmer),
      };
      for (
        let attempt = 0;
        attempt < 8 &&
        (finalBuckets.proposer !== before.proposer || finalBuckets.confirmer !== before.confirmer);
        attempt++
      ) {
        await confirmerIOU.waitForTimeout(1_000);
        finalBuckets = {
          proposer: await bucketCount(a, fpProposer),
          confirmer: await bucketCount(a, fpConfirmer),
        };
      }
      cleanupCheck(
        finalBuckets.proposer === before.proposer && finalBuckets.confirmer === before.confirmer,
        `cleanup returned both action-inbox buckets to their pre-run counts`,
      );
      } catch (error) {
        failures++;
        console.error(`[cleanup] action-inbox bucket verification failed: ${(error as Error).message}`);
      }
    }

    // Remove every uniquely nonce-proven card message before the exact source. Normal OpenChat sender
    // UI is used so backend authorization remains identical to a real user deletion.
    const proposerDeleted: Array<{
      message: ChatMessageRef;
      evidence: ExactMessageEvidence;
    }> = [];
    const deletedCardKeys = new Set<string>();
    const exactCardDeletionTargets: ExactMessageDeletionTarget[] = [];
    for (const trackedCard of [...senderRunCards.values()].sort(
      (left, right) => right.message.messageIndex - left.message.messageIndex,
    )) {
      const evidence = trackedCard.deletionEvidence;
      exactCardDeletionTargets.push({ message: trackedCard.message, evidence });
    }
    const optimisticBindingForCleanup = currentExactOptimisticSourceBinding();
    const sourceCleanupMessage =
      sourceMessage ?? optimisticBindingForCleanup?.boundMessage ?? null;
    const exactSourceDeletionTarget: ExactMessageDeletionTarget | null =
      sourceCleanupMessage !== null && sourceEvidence !== null
        ? {
            message: sourceCleanupMessage,
            evidence: {
              kind: "source",
              evidence: sourceEvidence,
              ...(optimisticBindingForCleanup === null
                ? {}
                : { optimisticBinding: optimisticBindingForCleanup }),
            },
          }
        : null;
    let openChatDeletionBoundaryReady = true;
    try {
      await refreshExactOpenChatDeletionBoundary(proposerOC, [
        ...exactCardDeletionTargets,
        ...(exactSourceDeletionTarget === null ? [] : [exactSourceDeletionTarget]),
      ]);
    } catch (error) {
      failures++;
      openChatDeletionBoundaryReady = false;
      console.error(
        `[cleanup] OpenChat deletion boundary refresh failed; exact chat deletion will be skipped: ${(error as Error).message}`,
      );
    }

    if (openChatDeletionBoundaryReady) {
      for (const trackedCard of exactCardDeletionTargets) {
        const evidence = trackedCard.evidence;
        try {
          await deleteExactMessagePersistentlyViaUi(proposerOC, trackedCard);
          proposerDeleted.push({ message: trackedCard.message, evidence });
          deletedCardKeys.add(messageRefKey(trackedCard.message));
          cleanupCheck(
            true,
            `cleanup deleted exact OpenChat card message ${trackedCard.message.messageId}`,
          );
        } catch (error) {
          failures++;
          console.error(
            `[cleanup] exact OpenChat card ${trackedCard.message.messageId}/${trackedCard.message.messageIndex}/${trackedCard.message.eventIndex} was not deleted: ${(error as Error).message}`,
          );
        }
      }
      if (exactSourceDeletionTarget !== null) {
        const evidence = exactSourceDeletionTarget.evidence;
        try {
          await deleteExactMessagePersistentlyViaUi(proposerOC, exactSourceDeletionTarget);
          proposerDeleted.push({ message: exactSourceDeletionTarget.message, evidence });
          cleanupCheck(
            true,
            `cleanup deleted exact Journey source message ${exactSourceDeletionTarget.message.messageId}`,
          );
        } catch (error) {
          failures++;
          console.error(
            `[cleanup] exact Journey source ${exactSourceDeletionTarget.message.messageId}/${exactSourceDeletionTarget.message.messageIndex}/${exactSourceDeletionTarget.message.eventIndex} was not deleted: ${(error as Error).message}`,
          );
        }
      }

      if (proposerDeleted.length > 0) {
        try {
          await verifyDeletedAfterReload(proposerOC, proposerDeleted);
          cleanupCheck(true, "exact OpenChat message deletions survived proposer reload");
        } catch (error) {
          failures++;
          console.error(`[cleanup] proposer reload verification failed: ${(error as Error).message}`);
        }
      }
      const confirmerDeleted = [...confirmerRunCards.entries()]
        .filter(([key]) => deletedCardKeys.has(key))
        .map(([, card]) => ({
          message: card.message,
          evidence: card.deletionEvidence,
        }));
      if (confirmerDeleted.length > 0) {
        try {
          await verifyDeletedAfterReload(confirmerOC, confirmerDeleted);
          cleanupCheck(
            true,
            "exact card deletion propagated to the confirmer and survived reload",
          );
        } catch (error) {
          failures++;
          console.error(`[cleanup] confirmer reload verification failed: ${(error as Error).message}`);
        }
      }
    } else {
      console.error(
        "[cleanup] OpenChat message deletion was skipped; IOU and inbox cleanup continued",
      );
    }

    } finally {
      // This teardown is deliberately nested: no cleanup/query/delete failure may retain listeners,
      // MutationObservers, the document marker, or the temporary manual-extraction tab.
      try {
        if (navigationListenerInstalled) proposerOC.off("framenavigated", onSenderNavigation);
      } catch (error) {
        console.error(`[teardown] navigation listener detach failed: ${(error as Error).message}`);
      }
      if (promptOverrideHandle !== null) {
        const handleToRemove = promptOverrideHandle;
        try {
          await removeManualPromptOverride(proposerOC, handleToRemove);
          promptOverrideHandle = null;
        } catch (error) {
          failures++;
          console.error(`[teardown] manual prompt restore failed: ${(error as Error).message}`);
        }
      }
      if (proposerObserverInstalled) await removeNewCardObserver(proposerOC).catch(() => {});
      if (confirmerObserverInstalled) await removeNewCardObserver(confirmerOC).catch(() => {});
      await proposerOC
        .evaluate((marker) => {
          const root = globalThis as typeof globalThis & { __iouJourneyDocumentMarker?: string };
          if (root.__iouJourneyDocumentMarker === marker) delete root.__iouJourneyDocumentMarker;
        }, documentMarker)
        .catch(() => {});
      await proposerQcPage?.close().catch(() => {});
    }
  }

  if (failures > 0) {
    console.error(`\nJOURNEY FAILED — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n🏁 JOURNEY PASSED: chat send → one host Add to IOU → confirmer delivery → Review & add → IOU History");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
});
