# IOU Chat Agent — design & feasibility

Status: **design / feasibility — not yet built.** This doc is the first
deliverable. The thin prototype is gated on confirming two decisions with
the owner (platform + the identity/K_sheet model — see §10).

Author note: grounded in the v1.4.0 canister (`src/lib.rs`), the crypto
adapters (`src/features/crypto/{devVetkd,prodVetkd}.ts`), the entry payload
(`src/features/entries/types.ts`), templates
(`src/features/templates/TemplatesContext.tsx`), and the Node→canister call
pattern in `scripts/awa-smoke-vetkd.ts` / `scripts/awa-smoke-solo.ts`.

---

> **⚠️ Direction update (2026-06-21) — supersedes the developer-API / server-bot framing below.**
> The owner's constraint: **no developer LLM API key — the user processes the screenshot on their own
> ChatGPT / Claude account.** The authoritative architecture is now
> **[§ User-side (bring-your-own LLM) architecture](#user-side-bring-your-own-llm-architecture)** (inserted
> after the TL;DR). Sections 1–10 are retained as background on the dumb-transport + developer-API model,
> now **deprecated for the processing role** — Telegram / WhatsApp / OpenChat have no built-in LLM, so the
> user cannot "use their own account to process the data" on them. The E2E key-access analysis in §4
> still holds and is the foundation of the new section.
> **Mobile + exact end-user steps** are in the two sections immediately after it.
> A fully **on-device LLM** alternative (max privacy — *nothing*, not even the screenshot, leaves the device) is in **[§ On-device LLM option (Gemma & friends)](#on-device-llm-option-gemma--friends)**.
> The chosen mobile mechanism (**silent background write + tap fallback**) and its **ordered build plan** are in **§ Mobile bridge: silent background write (push-woken) + tap fallback**.

---

## 1. What we're building

A bot that lives in a chat shared by the two members of an IOU **account
(pair)** and turns shared content into ledger **entries** automatically:

1. **Transfer screenshot** (someone posts an image of a money transfer)
   → a **Settlement** (`txn_type: "settlement"`, no due date) for the
   correct amount/currency, in the direction sender → receiver.
2. **Reservation details** (someone posts booking info)
   → an **IOU** (`txn_type: "iou"`) built from that user's **"Reservation"
   template** (apply its fee + due schedule), from the first sender to the
   second user.

Every auto-created entry is **confirmed in-chat before it is written**
(inline buttons). The bot never silently mutates the ledger.

---

## 2. TL;DR recommendation

| Decision | Recommendation | Why |
|---|---|---|
| **Prototype platform** | **Telegram Bot API** (free) | 2-minute setup, no public webhook (long-polling), reads group photos+text **passively**, inline confirm buttons. Fastest way to de-risk the extraction→entry pipeline. The prompt explicitly allows Telegram for the first cut. |
| **Production platform** | **All three documented (Telegram, WhatsApp, OpenChat) — decide after the prototype** | Telegram = passive watch + widest-reach-with-least-friction; WhatsApp Cloud = best reach but heavy + can't watch a private chat; OpenChat = ICP-native (own principal, II) but command-triggered + small reach. Each is a swappable surface over the same core. |
| **OpenChat** | **Strong fit for an ICP-native audience — but verify the image path** | Bot has an ICP principal (→ native Option B identity), no ToS/eavesdrop risk, open-source/self-hostable. **But** bots receive *command arguments*, not a passive message feed — the "auto-watch screenshots" UX becomes "invoke a command (possibly on a message)", and image-as-input must be confirmed against the SDK (see §3.5). |
| **ChatGPT** | **Not a fit** for the "watch a shared chat" model | A custom GPT is a single-user surface; there is no shared 2-person thread for it to watch. Only viable as a per-user "forward me your screenshot" assistant, which loses the shared-chat magic. |
| **Identity / key access** | **Prototype (Telegram): Option A** (bot acts under a member's delegated identity, derives K_sheet via vetKD). **Production hardening / OpenChat: Option B** (dedicated bot principal + absolute-direction payload). | Option A needs **zero canister changes** and keeps `direction` correct. Option B is least-privilege; on OpenChat it is **native** — the bot's existing ICP principal is the agent principal. |
| **Extraction** | **Claude with vision**, forced to emit a typed JSON object via tool-use, with a `confidence` field + mandatory in-chat confirm | Robust against OCR ambiguity; the confirm gate covers low confidence and wrong-direction guesses. |

The crux is **§4 (E2E key access)** — read that before approving any build.

---

## User-side (bring-your-own LLM) architecture

This section re-architects the IOU chat-agent around a hard product constraint: **we do NOT use a developer LLM API key. The screenshot is processed on the USER's own ChatGPT or Claude account.** Our job is the bridge that turns the user's AI-extracted transfer fields into an IOU ledger entry while keeping IOU's end-to-end encryption intact.

### 1. The model, and why dumb transports are deprecated for the processing role

The flow is always: the user pastes a money-transfer screenshot into an AI chat they already pay for → the AI does vision/OCR and extracts `{amount, currency, counterparty, date, memo, direction}` → that structured data is handed to a tool → the tool encrypts and writes an IOU entry.

The processing surface must itself contain a multimodal LLM. **Telegram, WhatsApp, and OpenChat are dumb chat transports with no built-in LLM**, so they cannot satisfy "the user uses their own account to process the data" — there is nothing on those surfaces that reads the screenshot. They are therefore **deprecated for the processing role**. The only viable processing surfaces are **ChatGPT** and **Claude**, each in two flavors (a remote/cloud tool path and a local/on-device tool path).

The single invariant that governs everything (verified against the IOU source): **to write an entry, the writer must hold `K_sheet`.** The canister stores ciphertext only — `add_entry` takes `{sheet_id, entry_key, iv, ciphertext}` (no plaintext path), `caller_owns_sheet` is the sole gate, and the vetKD-derived `K_sheet` is bound to `(canister, sheet_id)` (not to the principal), so **any principal the canister accepts as a member derives the identical 32-byte key.** Consequently the entire E2E question reduces to one thing: **WHERE does the `@dfinity/agent` + `K_sheet`-derivation code run — on the user's device, or on a remote server?** Who pays for the LLM is orthogonal to this; paying for tokens does not move `K_sheet`.

### 2. Per-surface verdicts

**A. ChatGPT Custom GPT with Actions (OpenAPI HTTP tools).**
- *User-pays-LLM:* Yes. The GPT runs inside the user's ChatGPT plan; vision/OCR and inference consume the user's subscription, with **no developer OpenAI API key** for the conversation. The developer pays only to host the Action's HTTPS backend. (Sub-claim verified: classic OpenAPI Actions remain creatable in the 2026 GPT builder per OpenAI's own docs; a third-party "deprecated" blog is incorrect.)
- *Vision:* Yes, native ChatGPT vision. The Action receives only the model's extracted JSON by default (the raw image is not passed, though the optional `openaiFileIdRefs` feature can pass conversation files as short-lived download URLs — so "no image to the action" is the default, not an absolute guarantee).
- *Identity:* OAuth maps the ChatGPT user to an account in your system; with API-key auth no individual user is identified. Even with OAuth, the canister sees **your server's** principal unless you engineer per-user delegation.
- *K_sheet custody:* **Server-side → E2E broken.** The screenshot is processed in OpenAI's cloud and the Action is a server-to-server call to the developer's bridge; the user's device is never in the request path. To encrypt, `K_sheet` (plus a member identity) must live on the bridge, widening the trust boundary to the bridge and to OpenAI (which already saw the plaintext screenshot). E2E survives only if the Action does NOT hold `K_sheet` — i.e. it returns an unencrypted draft and the user's on-device IOU client performs the encrypted write.

**B. ChatGPT Apps SDK / Developer-Mode remote MCP connectors.**
- *User-pays-LLM:* Yes (Plus/Pro/Business/Enterprise/Edu; not Free). Developer hosts the MCP server; no LLM key supplied to ChatGPT.
- *Vision:* Yes; the image can be passed into the tool by reference (`_meta["openai/fileParams"]` → `download_url`/`file_id`), not as inline base64 (MCP responses are size-capped ~1MB).
- *Identity:* OAuth 2.1 + PKCE; **no guaranteed stable `sub` claim** — the MCP server must run its own login and mint/map the ICP principal.
- *K_sheet custody:* **Server-side by default → E2E weakened.** OpenAI invokes the public MCP server from its cloud, so a server that encrypts holds `K_sheet`. The **Secure MCP Tunnel** appears to offer an on-device escape hatch, and the on-device execution architecture is real (an outbound-only `tunnel-client` polls OpenAI and forwards to a local stdio/HTTP MCP server). **However, two load-bearing claims were REFUTED on verification:** (a) the tunnel provides **network isolation, not cryptographic confidentiality** — request/response JSON-RPC payloads still transit OpenAI's hosted tunnel endpoint in plaintext, and the often-quoted line "your application logic, encryption keys, and data processing remain local" does **not** appear in OpenAI's docs and should not be cited as a vendor guarantee; and (b) `tunnel-client` is a **developer/operator tool** (CLI, multiple API keys, optional mTLS, daemon lifecycle, plus admin-enabled Developer Mode), not something a non-technical IOU user can realistically run. `K_sheet` stays off OpenAI only if the local server is *designed* never to emit the key or any key-derived plaintext through the tunnel — a developer design property, not something the tunnel itself provides. Net: not a clean E2E path for end users.

**C. Claude.ai remote custom connector (web / Desktop, remote MCP).**
- *User-pays-LLM:* Yes — the Claude.ai consumer connector path bills the user's Pro/Max/Team/Enterprise subscription with **no developer Anthropic API key**. (Verified, and explicitly distinct from the API-side "MCP connector," which IS billed per-token against a developer's Anthropic API key on the Claude API/AWS/Foundry — an easy-to-conflate, different surface.) Caveat: "zero developer cost" covers inference only; the developer still hosts the MCP server, and each user is capped by their own plan limits.
- *Vision:* Yes, native multimodal vision in-chat (JPEG/PNG/GIF/WebP, ~32MB/image) before the tool call.
- *Identity:* OAuth 2.1 + PKCE per user; the MCP server maps the OAuth subject → ICP principal. The interactive Claude.ai session never signs IC calls itself.
- *K_sheet custody:* **Server-side → E2E weakened.** Anthropic connects to the remote MCP server from its cloud, "rather than from your local device." If that connector encrypts IOU data it must hold a sheet-member key + transport key server-side, so the operator/host sees plaintext and the key — exactly the project's own invariant (`docs/chat-agent.md` §4.5: a server-side write-agent MUST hold key access). E2E is preserved only by keeping `K_sheet` off the server (do all crypto client-side; the server relays opaque ciphertext) — which makes the server-side tool pointless for the encrypt step.

**D. Claude Desktop / Claude Code local stdio MCP (on-device).**
- *User-pays-LLM:* Yes — billed to the user's Claude subscription, **provided `ANTHROPIC_API_KEY` is unset and the API-credit prompt is declined** (otherwise Claude Code silently bills the API). Developer ships only the local server; $0 inference cost.
- *Vision:* Yes, native Claude vision. **MCP tool ARGUMENTS are JSON-only** (verified against the MCP schema: `CallToolRequest.arguments` is a JSON object; `ImageContent` is a result-only content block, never an argument; `inputSchema` cannot declare image inputs). So the model OCRs the screenshot and emits structured JSON; the raw image is never piped to the tool. This is ideal for IOU — but it means entry integrity depends on the model's extraction accuracy, so a **confirm-before-write** step is advisable (the MCP spec itself recommends surfacing tool inputs for confirmation). Windows caveat: clipboard-paste of a screenshot into the Claude Code terminal is currently unreliable (open issues); copy/drag a saved image file instead. Claude Desktop paste/drag works normally.
- *Identity:* The user's own II delegation, or a local Secp256k1/Ed25519 dev identity, held entirely inside the local process; the ICP principal is derived on-device and is decoupled from the Claude login.
- *K_sheet custody:* **On-device → true E2E preserved.** The local server replicates IOU's existing crypto exactly: prod vetKD (`vetkd_public_key` → `vetkd_wrap_sheet_key(sheet_id, transport_pubkey)` → `@dfinity/vetkeys` `decryptAndVerify` → HKDF) or dev P-256 ECDH unwrap; it encrypts the `EntryPayload` locally and submits only ciphertext. The model sees the plaintext fields (it had to read the screenshot) but **never sees `K_sheet`**, and the canister never sees plaintext.

### 3. The central E2E finding (and its tradeoff)

| Surface | Where `K_sheet` lives | E2E status |
|---|---|---|
| D — Claude local stdio MCP | User's device | **True E2E** (key never leaves the machine) |
| A — ChatGPT Action | Developer bridge | Broken (server in trust boundary) |
| B — ChatGPT remote MCP / Apps | Developer server (or behind tunnel, but payloads transit OpenAI) | Weakened |
| C — Claude.ai remote connector | Developer server | Weakened |

**Only surface D keeps `K_sheet` on the user's device and preserves true E2E.** This is not a limitation of the agent/vetKeys stack — IOU's own headless Node smoke tests already prove the full path runs outside a browser: `scripts/awa-smoke-vetkd.ts` runs the complete vetKD IBE round-trip and asserts that **both members derive an identical 32-byte `K_sheet`**, and `scripts/awa-smoke-solo.ts` calls `add_entry`, both using `@dfinity/agent` `HttpAgent` + `Ed25519KeyIdentity` + a `node:crypto` WebCrypto polyfill, no browser. (Two honest qualifications on the smoke proof: it exercises headless *derivation* using `newTransportKey()` with no storage — the persisted on-device custody an MCP needs requires swapping `prodVetkd.ts`'s IndexedDB shim, and `devVetkd.ts`'s localStorage, for a local file, a trivial change; and `@dfinity/vetkeys@0.4.0` has an ESM packaging defect requiring the repo's `scripts/patch-vetkeys-esm.mjs` postinstall patch, so the path is feasible but not zero-config.)

**The tradeoff for surfaces A/B/C** is explicit and unavoidable: any remote server that *meaningfully composes-and-encrypts* an entry must hold `K_sheet` (or material to derive it) and joins the trust boundary — it can read and forge every entry in that sheet for as long as it holds the key. The corollary "remote surfaces cannot preserve E2E without making the server-side tool degenerate" holds, with two qualifications that are not counterexamples: (a) even a key-blind ciphertext relay still sees the **plaintext entry content** whenever the LLM composes it from natural language on the server (a separate E2E concern from key custody); and (b) a TEE/confidential-computing enclave with attestation could in theory run the derivation off-device without persisting `K_sheet`, but that relocates trust to the enclave + attestation chain rather than preserving the IC's native "only the two members can read" guarantee, so it is not E2E in the sense IOU means.

Two further custody hazards for remote surfaces, both grounded in the IOU model: (1) a server holding the user's II delegation holds **long-lived authority over every sheet that principal can reach**, not just one entry — blast radius is the whole account. (2) `EntryPayload.direction` (credit/debt) is interpreted **relative to `created_by`**; if a remote server writes under a shared/service principal, `created_by` no longer identifies the real author and credit/debt signs **invert** for one party. Correct direction therefore *requires* the agent to call `add_entry` as the acting user's own principal — which a local on-device agent (D) does naturally and a shared-principal remote server does not. (Note: the pair is a hard 2 slots, `members:[Principal;2]`; an agent acting under its own principal consumes the partner's slot, so it must act AS the human via that human's delegation.)

### 4. Recommended path + thin prototype (no developer API key)

**Primary: ship a local stdio MCP server for Claude Desktop / Claude Code (surface D).** It is the only surface that satisfies BOTH the product constraint (user's subscription pays for vision/LLM; no developer API key) AND IOU's E2E invariant (`K_sheet` stays on-device).

Thin prototype (no developer LLM key, builds on code that already exists in-repo):
1. Package a small Node MCP server exposing one tool, e.g. `create_iou_entry({ sheet_id, amount, currency, counterparty, date, memo, direction })`.
2. Inside the tool, reuse IOU's existing crypto verbatim — `prodVetkd.ts` (vetKD path) or `devVetkd.ts` (dev ECDH path) — swapping the IndexedDB/localStorage shim for a local encrypted file / OS keychain to persist the transport secret key. Derive `K_sheet`, `encryptEntryPayload`, and call `add_entry` with `@dfinity/agent` + the user's II delegation or local identity, exactly as `awa-smoke-solo.ts` already does headless. Pin `@dfinity/vetkeys@0.4.0` and apply `scripts/patch-vetkeys-esm.mjs`.
3. Register it: Claude Desktop via `claude_desktop_config.json` (or a `.mcpb` Desktop Extension); Claude Code via `claude mcp add --transport stdio iou -- node server.js`.
4. UX: the user pastes a transfer screenshot, Claude OCRs it and proposes the JSON; **show the extracted fields for explicit confirmation** before the tool encrypts and writes (mitigates OCR error and the direction-sign hazard).

**Fallback (for ChatGPT-only or web-only users): a draft-generator.** Use a remote MCP/Action/connector that returns an **unencrypted draft** (`{amount, counterparty, date, direction, …}`) and **does NOT hold `K_sheet`**; the user's on-device IOU client (the PWA, which already holds `K_sheet` in-memory) performs the encrypted `add_entry`. This keeps the remote LLM as a convenience extractor while the encryption stays on-device — the only way these surfaces avoid weakening E2E. Note this still exposes the plaintext screenshot/fields to the remote provider; it protects the *key* and the at-rest ledger, not the content the user chose to paste.

### 5. Residual unknowns
- Whether a non-technical IOU end user can realistically install and run a local stdio MCP server (manual JSON config / `.mcpb`), and how Free-tier connector limits and Windows clipboard-paste quirks affect onboarding.
- The on-device MCP server introduces a new at-rest secret (the BLS12-381 transport key); the right cross-platform secure-storage story (OS keychain vs. encrypted file) is unspecified.
- Supply-chain trust: a local MCP server runs with the Claude app's full OS permissions; how the binary/script is signed and distributed needs a trust model.
- `@dfinity/vetkeys` API churn (0.4.x has already broken constructors and a double-derive bug fixed in v1.2.2 per `prodVetkd.ts` comments); an independent MCP reimplementation must pin the exact version to avoid re-introducing "Invalid VetKey" failures.

### 6. At-a-glance surface comparison

| Capability | ChatGPT Actions (Custom GPT) | ChatGPT Apps / remote MCP (Dev Mode) | Claude.ai remote connector | Claude Desktop/Code local MCP |
|---|---|---|---|---|
| User-pays-LLM (no dev API key) | Yes — runs on user's ChatGPT plan; dev only hosts the Action backend (no OpenAI inference key) | Yes — inference on user's ChatGPT plan (Plus/Pro/Business/Ent/Edu, not Free); dev hosts MCP server only | Yes — Claude.ai consumer connector bills the user's Pro/Max/Team/Ent subscription; distinct from the API "MCP connector" (which IS dev-API-key-billed) | Yes — billed to user's Claude subscription IF `ANTHROPIC_API_KEY` is unset and the API-credit option is declined; dev ships only the local server |
| Vision / screenshot OCR | Yes — native ChatGPT vision; Action receives only extracted JSON (raw image not passed by default; optional `openaiFileIdRefs` can pass short-lived file URLs) | Yes — native vision; image passable to the tool by reference via `_meta["openai/fileParams"]` (download_url/file_id), not inline base64 | Yes — native Claude multimodal vision in-chat before the tool call; JPEG/PNG/GIF/WebP, ~32MB/image | Yes — native Claude vision; tool ARGUMENTS are JSON-only (no image in CallToolRequest; ImageContent only in results), so the model OCRs and emits JSON |
| On-device K_sheet (true E2E) | No — OpenAI cloud + dev bridge do all work; K_sheet lives server-side ⇒ E2E broken (unless used as draft-only) | No by default. "Secure MCP Tunnel" CAN run the server on-device, but payloads still transit OpenAI in plaintext (network isolation ≠ confidentiality) and it's an operator-grade CLI, not end-user-runnable | No — connector runs on Anthropic-reachable cloud; if it encrypts, K_sheet is server-side ⇒ E2E weakened (unless ciphertext-relay/draft-only) | YES — local stdio process derives/holds K_sheet on-device, encrypts locally, submits only ciphertext; K_sheet never leaves the machine ⇒ true E2E (proven headless in-repo) |
| Identity → ICP principal | OAuth maps the ChatGPT user to your account; canister sees YOUR server's principal unless you engineer per-user delegation (API-key auth identifies no one) | OAuth 2.1 + PKCE; no guaranteed stable `sub`; MCP server must mint/map the ICP principal; canister sees the server's identity | OAuth 2.1 + PKCE per user; server maps OAuth subject → ICP principal; interactive Claude.ai session never signs IC calls itself | User's own II delegation or local Secp256k1 dev identity, held in the local process; principal derived on-device, decoupled from the Claude login |
| Maturity (2026) | GA; building a Custom GPT needs a paid plan, using one is broader; OpenAPI Actions still creatable per OpenAI docs (third-party "deprecated" claim is wrong) | Beta but broadly available on web (not Free); admin must enable Developer Mode; tunnel available but operator-oriented | GA on Free/Pro/Max/Team/Ent (Free = 1 connector); web + Cowork + Claude Desktop | GA on both; local stdio MCP via config JSON / `.mcpb` (Desktop) and `claude mcp add` (Code); subscription-covers-cost is GA on Pro/Max |

---

## Mobile usage & exact end-user steps

This section covers whether the bring-your-own-LLM (BYO-LLM) IOU chat-agent works on mobile, how E2E is preserved there, and the exact steps an end user follows. "E2E" here has IOU's specific meaning: **K_sheet never leaves the user's device + entries are ciphertext-only at rest.** It does **not** mean the screenshot's contents are hidden from the AI provider — they are not (see the plaintext caveat below).

### Can it run on mobile?

| Surface | LLM/vision | Who encrypts | E2E (key-never-leaves-device + ciphertext-at-rest) | Built today? |
|---|---|---|---|---|
| **Desktop — local stdio MCP** (Claude Desktop / Claude Code) | User's own Claude account | Local MCP / IOU client on the same machine | **Yes** | The desktop pattern (`docs/chat-agent.md`); the MCP write tool itself is not in-repo |
| **Mobile M1 — AI app → deep/universal link → IOU app writes** | User's own ChatGPT/Claude mobile account | **IOU mobile app, on-device** | **Yes** | **No — not built.** No deep-link/App-Link receiver exists; `@capacitor/app` is not a direct dependency |
| **Mobile M2 — AI app → copy-paste / share into IOU "Import from AI" → IOU app writes** | User's own ChatGPT/Claude mobile account | **IOU mobile app, on-device** | **Yes** | **No — Import field not built**, but needs zero new platform plumbing once added |
| **Mobile M3 — remote connector/server encrypts & writes** | User's own account | A server | **No — REJECTED** (server takes custody of K_sheet) | n/a |

### Why the desktop local-MCP pattern does not port to mobile

Phones **cannot run a local stdio MCP subprocess inside the Claude or ChatGPT mobile app.** Verified for 2026:

- **Claude mobile (iOS + Android)** supports only **remote** MCP / web connectors (the same ones added on claude.ai web, which then sync to mobile). Anthropic states "Mobile apps cannot run local scripts, so only remote MCP is available," and "Desktop extensions run locally and are only available in Claude Desktop and Claude Code — not on web or mobile." You also cannot *add* a connector from inside the mobile app (add it on web first; adding-on-mobile is in beta).
- **ChatGPT mobile** likewise supports **remote HTTPS MCP only** (no local stdio on any platform), and additionally **disables/blocks MCP *write* (mutating) tool calls on mobile** ("MCP write action is temporarily disabled", triggered at mobile widths). On **Android** specifically, destructive/write tools are blocked **client-side before the call reaches the MCP server**; iOS/web show a confirmation modal and the call goes through. This is a reported, unresolved limitation (not a published spec) as of mid-2026 and should be re-verified on the user's actual app versions.

Consequently the desktop "local stdio MCP keeps K_sheet on device" mechanism (surface D in `docs/chat-agent.md`) has **no mobile equivalent inside the AI app.** Note: even on mobile, real on-device *execution* still happens — but in the **IOU app's own WebView** (`@dfinity/agent` + vetKD/ECDH crypto + `add_entry`), not inside the AI app.

### The E2E-preserving mobile pattern (handoff)

Because the IOU mobile app itself holds K_sheet on-device and already runs the full ciphertext-only `add_entry`, the mobile pattern is the **inverse** of the desktop one: the AI app is used **only as a remote extractor** that produces an **unencrypted DRAFT**, and the **IOU app does the encrypted write on-device.**

- **K_sheet custody:** `add_entry` takes only `{sheet_id, entry_key, iv, ciphertext}` (ciphertext-only at rest), gated solely by `caller_owns_sheet`; K_sheet is derived in-memory in `SheetKeyContext` and is never persisted to disk. The write happens as the **logged-in user's own Internet Identity principal**, so credit/debt direction is stamped correctly (`created_by = caller`) regardless of what the AI claims.
- **Reaching the existing pipeline is cheap:** a draft only needs to become a `Partial<EntryPayload>` handed to `EntryForm` as `initial` — exactly the seam the existing **template** flow already uses (`templateToInitial` → `openAdd` → `EntryForm initial` → `onSubmit` → `encryptEntryPayload` → `add_entry`). Crypto and `add_entry` are untouched; the only new code is a draft→`Partial<EntryPayload>` mapper plus a draft entry point.
- **Reservation case:** keep the draft minimal (amount = **gross/face value**, currency, date, memo, direction-hint) and let the user's saved template supply fee + due-schedule via `templateToInitial`; net `amount_minor` is recomputed client-side (`netAfterFee`). A draft that fully specifies fee/schedule would bypass the user's template — don't.

**Plaintext caveat (honest, identical for M1 and M2 and inherent to BYO-LLM):** the screenshot **and** the extracted draft fields (amount, currency, counterparty, date, memo, direction) **transit the user's chosen AI provider's cloud** (OpenAI/Anthropic). These flows protect the **key** and the **at-rest ciphertext ledger**, not the content the user voluntarily handed to their AI. Do not market this as full content-confidentiality.

**Security requirements (mandatory):** the inbound draft is **untrusted input** (a malicious link/clipboard payload or a prompt-injected screenshot could inject a wrong amount/counterparty/direction). The IOU app MUST parse defensively, validate fields/types/currency, treat direction as a **hint** the user confirms/flips, and **require explicit confirm-before-write** — never auto-write from an inbound link or paste. For the link path, prefer **Android App Links / iOS Universal Links (verified https host)** over a raw `iou://` custom scheme, which is hijackable by any app that registers the same scheme and can silently fail when IOU is not installed. **Never** put K_sheet, a transport key, or any secret in a link or the clipboard.

### Chat-driven on mobile: how "send a message → it reaches the canister" actually works

The owner's target: on a **phone**, send a message (with a transfer screenshot) in the
**Claude or ChatGPT app**, have it extract the data and get it to the canister — no
developer API key. This is achievable, but a hard constraint dictates the shape:

> **On mobile, the chat app can only call a *remote* tool** (no local MCP on a phone —
> see above). A remote tool cannot run the user's on-device crypto, so **if the remote
> tool encrypts the entry, the remote server must hold K_sheet** — and a server that holds
> K_sheet can read and forge every entry in that sheet (E2E broken). **The only way to
> keep K_sheet on the phone is to let the IOU app do the encrypted write.** Therefore, on
> mobile, the chat can *extract and trigger*, but the *encrypted write* belongs in the IOU
> app. "Chat writes directly to the canister, on mobile, with E2E" is impossible by
> construction — you pick one of the two below.

**Option 1 — E2E-preserving (recommended): chat extracts → hands a draft to the IOU app →
app confirms, encrypts, writes.** The user adds a thin **remote connector** to their
mobile Claude/ChatGPT (added once on web; Claude syncs it to mobile). On a screenshot,
the chat does the vision and calls the connector tool, which returns/queues a **draft**
(amount, currency, counterparty, date, direction, note — *never* K_sheet). The IOU mobile
app receives that draft, shows a **confirm screen**, and only then derives K_sheet
on-device, encrypts, and calls `add_entry`. The connector/relay only ever sees the draft
plaintext (which the AI already saw); the **key and the at-rest ledger never leave the
phone** — identical E2E posture to the BYO-LLM model (content exposed to the user's AI
provider; key + ledger protected). Three handoff variants, in increasing infra cost:
- **(a) Deep link / Universal Link (recommended first):** the tool returns a tappable
  `https://<iou-host>/draft?d=<compact draft>` (Android App Link / iOS Universal Link).
  Tapping opens the IOU app to the prefilled confirm screen. **Stateless — no server
  stores anything.** Sidesteps ChatGPT-mobile's write-tool block because the tool merely
  *returns content* (a link), it does not mutate. Caveat: a link tapped inside the chat
  app's in-app browser can fail to open a third app (esp. iOS) → use an "Open in IOU"
  interstitial.
- **(b) Draft relay + push:** the connector stores a short-lived pending draft (plaintext
  fields only, keyed to the user) and sends a push to the IOU app; tapping the push opens
  the confirm screen. More reliable than deep links; needs a tiny relay + Capacitor push +
  a "pending drafts" fetch. (A mutating tool here *may* hit ChatGPT-mobile's write block →
  best on Claude mobile.)
- **(c) Pull/inbox:** no push — the IOU app shows a "Pending from chat" inbox it fetches on
  open. Simplest, least magical.

**UX — how it feels on the phone (the transparency question):** After you send the
message in chat, Option 1 is **one tap + a confirm** — *not* a manual copy/share, and
*not* fully transparent:
- The chat replies with an **"Add to IOU"** link/button. You **tap it once**; the link
  *carries the draft*, so you do **not** copy/paste or "share to IOU" manually.
- The IOU app opens **pre-filled**; you **confirm** (review amount/who/direction); it
  encrypts on-device and writes.
- *Fully transparent* (zero taps, "it just appears") is **not** possible while preserving
  E2E with a confirm gate: a mobile chat app can't silently launch another app, and a
  no-confirm background write of a money entry is unsafe (a mis-read amount/direction would
  hit the ledger silently). Zero-tap "it just appears" is exactly what **Option 2** buys —
  at the cost of the server holding K_sheet. (A transparent-yet-E2E variant — a silent
  push-woken background write in the IOU app — is technically possible but drops the
  confirm gate and is unreliable on mobile; not recommended for financial writes.)
- The manual **copy/share** step is only the **fallback** if link-tapping proves
  unreliable on a given device/OS (the M2 paste path).

**Option 2 — direct (chat/server writes to the canister itself), E2E trade-off.** A remote
connector holds the user's identity + K_sheet and performs the encrypted write. Simplest
chat UX ("it just appears"), works on Claude mobile, but the server is now in the trust
boundary (it can read/forge that sheet). Mitigations if chosen: let the user **self-host**
the connector (their own infra, not a third party); use a **dedicated agent principal**
granted per-sheet (modelled on `grant_partner_access`) rather than the user's full
delegation; short-TTL credentials; mandatory confirm. Note ChatGPT-mobile disables MCP
**write** tools (client-side on Android), so Option 2 is effectively **Claude-mobile-only**.

**Platform specifics (mobile, verified earlier):** Claude mobile = remote connectors work
(add on web, syncs to mobile) — the better host for either option. ChatGPT mobile =
remote MCP works but **write tools are blocked/disabled on mobile**, so on ChatGPT prefer
**Option 1 variant (a)** (a non-mutating, link-returning tool). Both: the user's own
subscription pays for the vision; no developer LLM API key.

**What must be built for Option 1 (recommended):** (1) the shared **draft →
`Partial<EntryPayload>` → confirm → encrypt → `add_entry`** import feature in the IOU app
(the same piece every path needs; plugs into the existing `templateToInitial → EntryForm →
onSubmit` seam); (2) a mobile **draft receiver** — a deep-link/Universal-Link handler
(variant a) or relay+push (variant b); (3) a thin **connector** the chat calls (variant a:
a stateless link-builder; variant b: a relay that stores the draft + pushes), with **OAuth
mapping the chat user → their IOU account** so drafts route correctly. Crypto and
`add_entry` are untouched.

**Decision required before building:** Option 1 (E2E-preserving; chat triggers, IOU app
writes — recommended) vs Option 2 (chat/server writes directly; E2E trade-off). And, if
Option 1, confirm the deep-link variant (a) as the first cut.

### What is actually built vs. what is required (repo at v1.4.0)

Be explicit: **the mobile handoff is largely unbuilt.**

- **Built / shipping (verified):** ciphertext-only `add_entry`; `caller_owns_sheet` gate; K_sheet held in-memory only (`SheetKeyContext`); on-device dev (P-256 ECDH unwrap) and prod (vetKD IBE via `@dfinity/vetkeys` + HKDF) derivation; the Capacitor Android shell loading the same `dist/` bundle (WebCrypto/IndexedDB/localStorage all available in the WebView).
- **NOT built / corrected from the optimistic framing:**
  - **Keystore-backed transport-key custody is NOT wired.** Despite the convenient "transport key in Android Keystore / iOS Keychain" claim, at v1.4.0 `prodVetkd.ts` still calls `loadOrCreateTransportKey()` against **IndexedDB unconditionally** and has **zero reference to `mobileSecureStorage`**. The secure-storage adapter exists but its only consumer is `replaceMember.ts` (an Ed25519 signing seed, **not** the vetKD transport key). The prodVetkd integration was a v1.1.5 item that never landed. On the web/WebView path the transport key currently lives in IndexedDB, not the device keystore. (K_sheet itself is still in-memory-only; the encryption design is sound — but do **not** cite keystore custody of the transport key as verified.)
  - **M1 deep/universal-link receiver does not exist.** `AndroidManifest.xml` has only the `MAIN/LAUNCHER` intent-filter (no `VIEW`/`BROWSABLE`, no `<data scheme>`, no `autoVerify`); the `custom_url_scheme` string in `strings.xml` is inert; `@capacitor/app` is only transitive in `pnpm-lock.yaml`, not a declared dependency; routing is `BrowserRouter` with no scheme route and no `appUrlOpen` listener. Deep links are an explicit v1.1.5 TODO (`docs/08-mobile.md`, `README.md`).
  - **M2 share/paste receiver does not exist.** No `ACTION_SEND` share-target, no iOS Share Extension, no Web Share Target, and no "Import from AI" field/route.
  - **iOS is doubly unbuilt:** no iOS target (`cap add ios` pending), no Associated Domains entitlement, no `apple-app-site-association`; and no `assetlinks.json` is hosted for Android App Link verification.

### Reliability gotcha (load-bearing, untested for IOU)

Even once M1 is built, **tapping a link from inside the AI app's in-app browser/WebView frequently does NOT open the third app** — the WebView swallows the tap and the OS loads the web fallback instead (iOS in particular; JS redirects also don't count as the user-initiated tap iOS requires). Whether ChatGPT/Claude mobile render an outbound handoff link as a native tappable link (reliable) vs. inside an in-app browser (often fails) is **not publicly documented and must be tested per app, per OS, per version.** Mitigation: an "Open in IOU" interstitial with a real user-tapped anchor, **plus** share-sheet and clipboard fallbacks. This is exactly why **M2 (copy-paste) is the recommended first ship** — it is the zero-platform-risk path.

### Billing

In every mobile path the **user's own ChatGPT/Claude subscription** (or free tier where vision is included) bears the LLM/vision cost; **no developer API key** is involved (ChatGPT/Claude *subscriptions* and the OpenAI/Anthropic *API* are separate billing systems). The handoff (link/share/clipboard) costs nothing; IOU's only cost is the normal ICP `add_entry` update call.

### Recommendation

Ship **M2 (paste/share into an "Import from AI" field + confirm-before-write)** first — it works against any AI mobile app today and needs no new native platform plumbing beyond the import UI on top of the existing on-device crypto. Add **M1 (App Links / Universal Links)** later as a pure UX upgrade once the import + confirm pipeline is proven; M1 and M2 are the **same trust model**. **Reject M3** (any server-side encrypt/write) — it necessarily puts K_sheet in the server's trust boundary and breaks E2E, matching the project's own §4.5 invariant.

---

## Exact end-user steps

Legend: **[E2E]** = step keeps K_sheet on your device. **[plaintext→AI]** = at this step the screenshot and/or extracted fields leave your device to your AI provider's cloud (inherent to BYO-LLM; the *key* still never leaves). **[BUILD]** = depends on IOU functionality that is **not yet built** at v1.4.0.

---

### Path A — Desktop, local-MCP (Claude Desktop / Claude Code) — full E2E, most automated

*This is the established desktop path; included for comparison. It has no mobile equivalent.*

**Prerequisites:** a computer (not a phone); Claude Desktop or Claude Code; a paid Claude plan (Pro/Max) on your own account; the IOU local MCP/agent configured so K_sheet derivation + `add_entry` run on your machine; you are signed in to IOU with your Internet Identity.

1. On your computer, open Claude Desktop (or Claude Code).
2. Drag in or paste the money-transfer screenshot and ask Claude to add it to your IOU sheet. **[plaintext→AI]** (the screenshot goes to Anthropic for vision)
3. Claude calls the **local** IOU MCP tool running on your machine. The tool derives K_sheet locally, encrypts the entry, and submits ciphertext-only `add_entry`. **[E2E]** (K_sheet stays on your machine; the canister only ever sees ciphertext)
4. **Confirmation:** the entry appears in your IOU sheet; verify amount, counterparty, date, and direction.

---

### Path B — Mobile, AI app → deep/universal link → IOU app writes (M1) — E2E, smoothest mobile UX **[BUILD]**

**Prerequisites:** an iPhone or Android phone; the ChatGPT or Claude **mobile app**, signed in to **your own** paid subscription (Claude Pro/Max or ChatGPT Plus; free tiers may include limited vision); the **IOU mobile app installed and signed in** with your Internet Identity, on a sheet you own. **[BUILD]** IOU must first ship the deep-link/App-Link receiver, draft validation, and confirm-before-write screen (none exist at v1.4.0).

1. Open your ChatGPT/Claude mobile app.
2. Tap the camera/photo icon and take or upload the transfer screenshot. **[plaintext→AI]** (the image goes to your AI provider for vision/OCR)
3. The AI reads the screenshot and produces a short **draft** (amount, currency, counterparty, date, memo, direction hint), surfaced as a tappable **"Add to IOU"** link (an https App Link / Universal Link carrying only those plaintext fields). **[plaintext→AI]** (the draft fields are plaintext; they never include your key)
4. Tap the link. If an **"Open in IOU"** interstitial appears, tap its button (a real tap is required to route reliably). *Note: if the AI shows the link in its in-app browser it may instead open a web page — if so, use Path C.*
5. The IOU app opens to a **confirmation screen** pre-filled with the draft (and, for a Reservation, your saved template's fee + due-schedule). **[E2E]**
6. **Review every field** — especially amount and whether it's money owed *to* you vs. *by* you — and edit/flip direction if needed. The draft is only a suggestion. **[E2E]**
7. Tap **Confirm/Save.** Only now does IOU derive K_sheet in memory, encrypt the entry, and submit ciphertext-only `add_entry` as *your* principal. **[E2E]** (K_sheet never entered the AI app, the link, or any server)
8. **Confirmation:** the new entry shows in your sheet with the correct credit/debt sign.

---

### Path C — Mobile / any AI app, copy-paste fallback (M2) — E2E, zero new infrastructure **[BUILD: Import field only]**

*Recommended first path. Works with any AI mobile app today; the only IOU piece needed is the Import field + confirm screen (no deep-link/native plumbing).*

**Prerequisites:** any phone with any ChatGPT/Claude mobile app on **your own** account; the **IOU mobile app installed and signed in** on a sheet you own. **[BUILD]** IOU must add an **"Import from AI"** paste field + draft validation + confirm-before-write screen.

1. Open your ChatGPT/Claude mobile app.
2. Take or upload the transfer screenshot. **[plaintext→AI]**
3. Ask: *"Extract this as JSON for IOU: amount (gross), currency, counterparty, date, memo, direction."* The AI returns a small JSON/text draft. **[plaintext→AI]**
4. **Long-press the draft and Copy** (or use the AI app's Share action).
5. Switch to the **IOU app**, open **Add entry → "Import from AI"**, and **Paste** (or pick IOU from the share sheet). **[E2E]** (only plaintext fields cross over — never your key)
6. IOU parses and validates the draft and shows the **confirmation screen** pre-filled (with your template's fee/schedule for a Reservation). **[E2E]**
7. **Review and correct** amount, counterparty, date, and direction. **[E2E]**
8. Tap **Confirm/Save** — IOU derives K_sheet on-device, encrypts, and submits ciphertext-only `add_entry` as your principal. **[E2E]**
9. **Confirmation:** the entry appears in your sheet.

---

### Not offered: server-side write (M3) — REJECTED

A "just point ChatGPT/Claude at a remote IOU connector that saves the entry for you" flow is **deliberately not provided.** Any server that encrypts/writes must hold K_sheet (or material to derive it), which would let that server read and forge every entry in the sheet — breaking E2E. (It is also blocked in practice on ChatGPT mobile, where MCP write tools are disabled/Android-blocked.) Always let the **IOU app on your own device** do the encryption.

---

## Mobile bridge: silent background write (push-woken) + tap fallback

**Status: design. Owner chose the silent-background-write target, Claude mobile first, and explicitly accepts falling back to a tap "Add to IOU" button. This section reflects the honest feasibility: the silent write is a best-effort *accelerator*, the tap is the dependable mechanism.**

### Goal
After the user sends a transfer screenshot in the **Claude mobile app** (their own subscription, no developer API key), Claude does vision, calls a **remote connector tool** with the extracted draft `{amount, currency, counterparty, date, direction, note}`, a push backend pings the user's IOU app, and the IOU app **re-derives K_sheet on-device, encrypts the `EntryPayload`, and calls `add_entry`** — ideally with no tap. The connector / relay / push backend / Google / Apple **never hold K_sheet**.

### Feasibility per OS (do not overstate)

| Case | Android | iOS |
|---|---|---|
| Backgrounded, process alive, well-behaved device | High-priority FCM data message **can** wake ~10s of code and run the write — but **best-effort**, throttled by Doze / App Standby / per-app wake quota, and **deprioritized by FCM because a silent write produces no notification** | content-available:1 push **may** wake ~30s — but Apple says delivery is **"not guaranteed,"** low-priority, throttled to **~1-2 silent pushes/hour device-wide across all apps**, suppressed under Low Power Mode / Background App Refresh off |
| Swiped from Recents | **Device-dependent** — stock/Pixel keeps FCM; **Xiaomi/Huawei/Samsung/OnePlus force-stop on swipe** → no delivery | n/a today |
| Force-quit / Force Stop | **No delivery** until manual relaunch (`FLAG_EXCLUDE_STOPPED_PACKAGES`; Android 15 also cancels PendingIntents) | **Never woken** by push after force-quit (Apple DTS) — flag cleared only on next manual launch |
| iOS target exists? | — | **No** — `cap add ios` pending, no entitlements, no `apple-app-site-association` |

**Verdict:** On **iOS the silent write is effectively non-viable** and the visible-tap fallback is **mandatory**. On **Android it is a best-effort optimization** that fails a meaningful (not rare) fraction of the time and is impossible after Force Stop / OEM swipe-kill. Therefore **the tap "Add to IOU" notification + a pending-drafts inbox is the dependable primary path; the silent write is layered on top (Android only).**

### Architecture
Four key-blind server pieces + an on-device receiver:
1. **Remote MCP connector** (HTTPS, added once on claude.ai web, syncs to mobile): OAuth 2.1 + PKCE; maps the Claude user → an IOU user record holding device push token(s) + target `{pair, active sheet_id}`; accepts the draft. **Holds no IC identity, no key material.**
2. **Wake-and-fetch relay** (co-host with the connector): stores a short-lived, per-user pending draft keyed by a **deterministic `entry_key`**; served over TLS authenticated by the **on-device IC identity** (signed challenge). The push carries only an **opaque pointer**, so Google/Apple see an opaque ping, not the draft.
3. **Push backend** (FCM HTTP v1 now; APNs key later): for each draft sends a **user-visible "Add to IOU" notification** (reliable trigger) and — **Android only** — also a high-priority **data** message attempting the silent write.
4. **On-device write** in the IOU app: re-derive K_sheet from the on-device transport key + identity, encrypt, call `add_entry` **as the user's own principal** (so `created_by = caller` and credit/debt direction is correct).

### K_sheet / draft custody
- **K_sheet never leaves the device** in every path: derived only inside the IOU app (prod = vetKD: transport key in IndexedDB → `vetkd_wrap_sheet_key` → `@dfinity/vetkeys` `decryptAndVerify` → HKDF; dev = P-256 ECDH). It is **in-memory only** (`SheetKeyContext`), so a cold/headless wake **must fully re-derive** it.
- **Draft plaintext** is the same content the user already handed to Claude. With wake-and-fetch, only the connector/relay see it; with draft-in-push it additionally transits FCM/APNs. **Prefer wake-and-fetch.** Never put K_sheet, a transport key, or any secret in a push payload or link.

### What IOU must build
- Add `@capacitor/push-notifications` for token registration (note: it will **not** run code when the app is killed and has **no iOS silent push**).
- For the silent attempt: a **custom `FirebaseMessagingService`** or **`@capacitor/background-runner`** to receive data-only messages. The Background Runner is a **headless JS engine, not a WebView — no DOM, no IndexedDB, no localStorage, only CapacitorKV** — so the **transport key + identity custody must be migrated off IndexedDB/localStorage** into CapacitorKV (or OS keychain) and `deriveSheetKey` + `@dfinity/agent` `add_entry` **re-ported** against the runner API with an **injected `fetch` shim** (`getDefaultFetch` throws without `window/global/self.fetch`, and the runner's fetch drops the `Request` object). Verify the runner's `crypto.subtle` covers HKDF / AES-GCM / BLS used by `@dfinity/vetkeys`. **This is a real port, not "reuse the existing code."**
- On Android 12+, start a foreground service **promptly** on high-priority receipt (else `ForegroundServiceStartNotAllowedException`); move >10s work to WorkManager.
- **OEM survival kit:** request battery-unrestricted + autostart (dontkillmyapp helper); educate users (settings reset on OS updates).
- The **dependable path:** a visible "Add to IOU" notification + tap handler + a **"Pending from chat" inbox** the app drains on every foreground — both reusing the existing `draft → Partial<EntryPayload> → EntryForm → onSubmit → encryptEntryPayload → add_entry` seam (crypto + `add_entry` untouched).
- **Exactly-once:** a **deterministic `entry_key`** so silent-wake, tap, and inbox-drain converge to one ledger entry.

### The fallback (and how silent degrades into it)
Send a **visible** "Add to IOU" notification carrying the opaque draft pointer. On tap, the app cold-launches (clearing any Android stopped-state / triggering iOS interactive relaunch), pulls the draft, shows a **prefilled confirm screen**, and on confirm derives K_sheet in-memory and writes as the user's own principal. A **pending-drafts inbox** drained on foreground catches everything the push missed. Degradation chain: *silent data push fires (Android, well-behaved) → opportunistic write; else visible notification → one tap → in-app confirm + write; else next foreground → inbox drain → confirm + write.* The tap path also re-triggers an expired II delegation re-login (the headless path cannot) and lets the user fix a mis-read amount or flipped direction before a money entry is written.

### Repo reality (v1.4.0)
- **No** `@capacitor/push-notifications`, `firebase`, or `background-runner` deps (`package.json`).
- `AndroidManifest.xml` has only `MAIN/LAUNCHER` + `INTERNET` — no FCM service, no push/foreground-service/wake permissions, no deep-link receiver.
- **No iOS target** (`cap add ios` pending; no entitlements).
- `prodVetkd.ts` `loadOrCreateTransportKey()` **throws if `indexedDB` is undefined**; transport key lives in IndexedDB (`iou-vetkd` / `iou:vetkd:transport:v1`).
- K_sheet is **in-memory only** (`SheetKeyContext`); the secure-storage adapter (`mobileSecureStorage.ts`) is **unwired** into the vetKD load path (only `replaceMember.ts` uses it).
- `docs/chat-agent.md` already classifies the silent push-woken write as *"technically possible but drops the confirm gate and is unreliable on mobile; not recommended for financial writes."*

### Ordered build plan

**Guiding principle:** build the dependable tap path first; treat the silent write as an Android-only optimization added last, behind the same idempotent substrate so it can never produce a duplicate or a lost entry.

**Milestone 0 (MINIMAL FIRST MILESTONE) — On-device draft → confirm → write, no push, no server.**

> ✅ **Built (2026-06-21).** `src/features/entries/draft.ts` — `parseDraft` validates an
> untrusted draft → `Partial<EntryPayload>` + a deterministic idempotency `draft_id`, and
> `isDuplicateDraft` dedupes re-imports; `draft.test.ts` (15/15 pass). An optional `draft_id`
> was added to `EntryPayload` (`types.ts`) and threaded through `EntryForm` on submit. A
> **"✨ From AI draft"** paste entry point + confirm modal in `SheetPage.tsx` reuses the
> existing `openAdd → EntryForm → onSubmit → encryptEntryPayload → add_entry` seam (crypto +
> canister untouched). Typecheck clean for these files. Idempotency is realized as `draft_id`
> on the payload (the canister doesn't key on `entry_key`), so silent/tap/inbox paths in M1/M2
> dedupe on it. Not yet built: the connector + deep-link/push receivers (M1/M2).

- Build the shared **`draft → Partial<EntryPayload>` mapper** + a draft entry point that plugs into the existing `templateToInitial → EntryForm → onSubmit → encryptEntryPayload → add_entry` seam. Defensive validation (types, currency, amount); **direction is a hint the user confirms/flips**; **confirm-before-write mandatory**.
- Adopt a **deterministic idempotency key** (`draft_id` on the payload) so any later silent/tap/inbox path dedupes to one entry.
- *Verified by:* the in-app crypto + `add_entry` path already ships; this milestone is pure UI + a mapper, zero native plumbing, zero crypto changes. **Lowest risk, unblocks every later path.**
- *Test on a real device:* sideload the Android build, manually paste a draft JSON into the new field, confirm, and verify the entry appears in the sheet with correct amount/direction.

**Milestone 1 — Connector + relay + tap notification (the dependable mechanism).**

> 🟡 **Connector core built (2026-06-21); relay/push/app-inbox + OAuth deferred (security
> decisions to confirm).** `scripts/iou-mcp/` — `draftResult.ts` (key-blind core:
> `buildDraftResult` validates the chat-extracted fields → a canonical draft + `draft_id`,
> reusing the app's `parseDraft` so connector/app can't drift; never touches K_sheet or the
> canister), `server.ts` (a **local stdio** MCP server exposing `prepare_iou_entry`, works in
> Claude Desktop/Code today), `selftest.ts` (16/16 pass), `README.md`. `package.json` gains
> `mcp:serve`/`mcp:selftest` + the `@modelcontextprotocol/sdk` dep (run `pnpm install`).
>
> **Relay backend built (2026-06-22).** `scripts/iou-relay/server.ts` — a **key-blind**
> draft relay (Node `http`, no deps): `POST /v1/drafts` (connector pushes), `GET /v1/drafts`
> (app polls), `DELETE /v1/drafts/:id` (app clears after writing), keyed by an opaque **link
> token**, with TTL + per-token cap + token isolation. It only ever holds the plaintext draft
> (never K_sheet). `selftest.ts` (8/8). The **connector now pushes** to it when
> `IOU_RELAY_URL` + `IOU_LINK_TOKEN` are set (verified end-to-end: `prepare_iou_entry` →
> relay receives the draft + `draft_id`, 6/6), falling back to paste-JSON otherwise.
> `package.json` gains `relay:serve`/`relay:selftest`.
>
> **App inbox + relay settings built (2026-06-22).** `src/features/relay/relay.ts` — the
> app-side relay client (`getRelayConfig`/`setRelayConfig`, `generateToken` → `iou_`+48 hex,
> `fetchPending`/`deletePending`; localStorage `iou:relay:url` + `iou:relay:token`).
> `src/features/relay/RelaySettings.tsx` — a Settings card to set the relay URL, generate/copy
> the link token, and show the `IOU_RELAY_URL`/`IOU_LINK_TOKEN` env block to paste into the
> connector. `SheetPage.tsx` — a **"✨ Pending from chat"** card that polls `GET /v1/drafts`
> every 15 s, lists each draft's summary, and on **Review & add** runs the *same* M0 seam
> (`parseDraft → openAdd → EntryForm → onSubmit → encryptEntryPayload → add_entry`) then
> `DELETE`s the draft from the relay; a dismiss "✕" clears without writing; dedup skips drafts
> already in the sheet. The relay never holds K_sheet — the encrypted write is on-device.
> **Verified end-to-end on PC (2026-06-22) — the complete A-path cycle, in a real browser.**
> Drove Chromium (Playwright, in WSL) through the running app against the live local replica +
> relay: dev sign-in → create solo account/sheet → configure relay in Settings (token
> generated) → connector POSTs a draft to the relay → app inbox shows
> `Settlement 42.50 USD · owed to you · dinner split from chat` → **Review & add** → EntryForm
> opens prefilled (amount 42.50, note) → **Add entry** → encrypted `add_entry` → balance shows
> "your partner owes you 42.50 USD" + the history row → **draft auto-cleared from the relay**,
> inbox card removed. **10/10 assertions, 0 console errors** (`scripts/e2e-drive.mjs`,
> screenshots in `.e2e-shots/`). The earlier relay-client HTTP round-trip (connector POST →
> `fetchPending` → `deletePending` → token isolation) also passed 7/7 standalone.
>
> **Still to build — routing/auth for mobile + the cloud connector (see options below):** the
> link token is a single-secret prototype good for the local/desktop stdio connector. For
> **mobile / Claude.ai remote** the round trip splits into two legs that need **B + C together**
> — **C** (OAuth, Claude-user → IOU-principal) so the cloud connector routes a draft to the
> right user without a shared secret (push leg), and **B** (signed-challenge with the on-device
> identity) so the app authenticates its fetch/clear (pull leg); the relay's
> store/serve/delete-by-key core is unchanged. Also still to build: a **hosted, hardened**
> relay (the current one is localhost), and the push/tap notification so the inbox surfaces
> without the app already being open.

#### Routing / auth options (how a pushed draft reaches the right user's app)

The relay stores drafts under a **routing key** and the app fetches by the same key. The round
trip has **two legs**, and they're authenticated separately:

- **Push leg** — *AI → connector → relay* (`POST /v1/drafts`): who may deposit a draft, and
  **for which user**? This is a **routing** question.
- **Pull leg** — *relay → IOU app* (`GET`/`DELETE`): who may fetch/clear that user's drafts?
  This is a **pull-auth** question.

The options below each answer one or both legs. The relay's `POST`/`GET`/`DELETE` core is
identical across all of them — only the auth in front changes:

- **Option A — Link token (BUILT, prototype).** *Covers both legs with one shared secret.* A
  random token the user generates in Settings and pastes once into the connector
  (`IOU_LINK_TOKEN`); the connector pushes under it (push leg) and the app fetches under it
  (pull leg). Whoever holds the token can read/clear that token's drafts, so it's a bearer
  password — fine for a **local/desktop stdio connector the same user runs**, where the secret
  never leaves their machine. *Limits:* manual copy step; no per-user identity; a leaked token
  leaks future drafts until rotated. Mitigated by ≥24-char random tokens, 1 h TTL, per-token
  cap, and on-device dedup. **Use for: local / desktop today.**

- **Option B — IC-principal + signed challenge (the PULL leg).** Key the relay by the user's
  **IOU IC principal** instead of a random token; the app authenticates each `GET`/`DELETE` by
  signing a server nonce with its on-device II/dev identity (the key it already holds — still
  never leaves the device). Removes the bearer-secret weakness on the read side (no password to
  leak) and ties drafts to a real identity. **This secures the pull leg; it does not by itself
  tell a remote connector which principal to push to** — that's the push leg (A's pairing, or
  C's OAuth). **Use for: a hardened self-hosted relay; the pull-side half of the production
  cycle.**

- **Option C — OAuth 2.1 + PKCE (the PUSH leg; required for Claude.ai cloud / mobile).** When
  the connector is a **remote** MCP server added on claude.ai (which syncs to Claude mobile),
  there's no local process and no place to paste a token. The connector runs an OAuth login
  mapping the **Claude user → an IOU user record** (which holds the routing key — the user's
  IOU principal — + target `{pair, active sheet_id}`), and pushes drafts for that mapped user.
  The relay/connector remain **key-blind** — they hold the draft and the routing mapping, never
  K_sheet or an IC identity. *Risk to resolve:* OAuth gives **no guaranteed stable
  cross-provider `sub`**, so the connector must persist its own subject→IOU-user mapping (a
  trusted-but-key-blind state store; abuse/rotation story still to design). **Use for: the
  push-side half of the production cycle (mobile + cloud connector).**

**The complete cloud/mobile cycle needs B *and* C together** — they secure different legs:

| Leg | Question | Mechanism |
|---|---|---|
| Push (connector → relay) | *which user does this draft belong to?* | **C** (OAuth maps Claude-user → IOU principal) |
| Pull (relay → app) | *is this really that user's app asking?* | **B** (app signs a challenge with its on-device identity) |

Because C makes the **routing key = the user's IOU principal**, the natural, secure way for the
app to claim drafts under that key is to prove it owns that principal — i.e. Option B. (You
*could* run C with an A-style bearer token on the pull leg and skip B, but that reintroduces the
exact bearer-secret weakness B exists to remove, so it's not the target design.)

Build order: **A → B + C**. A unblocks desktop today (single secret, both legs). For the
"send a screenshot in Claude **mobile** and it lands in your IOU inbox" cycle, ship **B and C
together** — C so the cloud connector routes to the right user, B so the app authenticates its
pull by identity. Both ride on the same hosted, hardened relay; the `POST`/`GET`/`DELETE` core
never changes.

**Cost of the Option-C cloud connector (researched & verified 2026-06-22, official Anthropic
sources):** Anthropic charges **nothing** to build, add, OAuth-authenticate, or use a custom
remote MCP connector — on any plan, Free included. The only costs are **ours**: hosting the
hardened relay + remote MCP server (compute, domain, TLS) and IOU's own OAuth 2.1 + PKCE
authorization server (needed because IOU handles private data) — both can start near-$0 on
hobby tiers. Two caveats: (1) **plan caps, not fees** — Free is limited to *one* custom
connector; Pro/Max/Team/Enterprise lift that; a public Connectors-Directory *listing* (which we
don't need — ours is private) requires Team/Enterprise. (2) **token budget is the real marginal
cost** — connector tool calls are token-heavy and count against the user's plan usage limit, so
keep draft payloads and tool-call counts lean. Mobile adds no extra fee, but **installing**
connectors on mobile is still beta — design onboarding so the user adds/authorizes the
connector **once on web/Desktop**, after which it syncs to their phone. (Date-sensitive — these
are beta-era facts; re-verify against support.claude.com / claude.com/pricing before shipping
any user-facing pricing claim.)

#### Try it now — local / desktop runbook (the BUILT A-path)

This is the cycle verified end-to-end on PC (10/10, 2026-06-22). It runs entirely on one
machine: the connector and the IOU app share **one link token**, the relay is localhost, the
encrypted write happens on-device.

**Which front-ends work — chat vs. code:** the connector is a **local stdio MCP server**, so it
works with any AI client that can launch a local MCP server:

| Front-end | Works? | How it's registered |
|---|---|---|
| **Claude Code** (CLI / "code") | ✅ | project `.mcp.json` |
| **Claude Desktop** (the chat app) | ✅ | `claude_desktop_config.json` (`%APPDATA%\Claude\` on Windows) — *this is chat, not code* |
| **claude.ai** in a browser | ❌ | remote connectors only → needs Option B+C (not built) |
| **Claude mobile app** | ❌ | remote connectors only → needs Option B+C (not built) |

So locally you can use **either Claude Code or the Claude Desktop chat app** — you do *not* have
to use the CLI. The browser/mobile chat is the only thing that needs the cloud connector.

**One-time setup**

1. Run the stack: local replica (`dfx start`), the relay (`pnpm relay:serve`, listens `:8788`),
   and the app (`pnpm dev`, or deploy the asset canister).
2. Register the connector with the relay env baked in. Same server block for either client
   (Windows→WSL form shown; on a native box drop the `wsl.exe`/`bash -lc` wrapper):
   ```json
   {
     "mcpServers": {
       "iou": {
         "command": "wsl.exe",
         "args": ["-d","Ubuntu","bash","-lc",
           "cd /mnt/c/Kiko/MyProjects/IOU && IOU_RELAY_URL=http://127.0.0.1:8788 IOU_LINK_TOKEN=<your-link-token> exec ./node_modules/.bin/tsx scripts/iou-mcp/server.ts"]
       }
     }
   }
   ```
   — Claude Code reads `.mcp.json` in the project; Claude Desktop reads `claude_desktop_config.json`.
   The connector only pushes to the relay when `IOU_RELAY_URL` + `IOU_LINK_TOKEN` are set;
   without them it falls back to returning paste-JSON. (Note: `wsl.exe` does **not** forward
   Windows env vars into WSL — bake them into the `bash -lc` command, not a JSON `env` block.)
3. In the app: sign in → open a sheet → **Settings → Chat import (relay)** → set URL
   `http://localhost:8788`, **paste the same `<your-link-token>`** (don't *Generate* a new one,
   or it won't match the connector) → **Save**.

**Each use**

4. In Claude Code or Claude Desktop, share a transfer screenshot (or just describe it) and ask
   it to *prepare an IOU entry*. It calls `prepare_iou_entry` → the connector pushes a validated
   draft to the relay → replies "Sent to your IOU app's Pending from chat inbox."
5. In the app sheet, the **"📋 Pending from chat"** card appears within ~15 s (or refresh) →
   **Review & add** → the EntryForm opens prefilled → **Add entry** → encrypted `add_entry`, and
   the draft is cleared from the relay.

The AI only ever sees the draft fields (the same screenshot it already processed); it never
touches K_sheet, and nothing is written until you confirm in the form.

- Stand up the **remote MCP connector** (OAuth 2.1 + PKCE; Claude-user → IOU-user mapping; token + `{pair, sheet_id}` custody; key-blind) and the **wake-and-fetch relay** (short-lived pending drafts keyed by `draft_id`, TLS auth by on-device IC identity).
- Add `@capacitor/push-notifications` + FCM project; push backend sends a **visible "Add to IOU" notification** with an opaque pointer.
- App: tap handler pulls the draft → Milestone-0 confirm screen; add the **"Pending from chat" inbox** drained on foreground.
- *Verified vs risky:* server pieces are standard/verified; the **only** in-app addition is registration + pull, both run in the live WebView (verified-capable). *Risky:* OAuth subject→principal mapping (no stable `sub`) — connector must persist its own mapping.
- *Test on a real device:* from Claude mobile, send a screenshot → connector tool fires → confirm the visible notification arrives → tap → app opens prefilled → confirm → entry written. Then kill the app and verify the **inbox** still surfaces the draft on next open.

**Milestone 2 — Android opportunistic silent write (the optimization).**
- Add a **custom `FirebaseMessagingService`** or `@capacitor/background-runner`; push backend additionally sends a high-priority **data** message (Android only).
- **Port** transport-key + identity custody off IndexedDB/localStorage into CapacitorKV (or OS keychain); re-port `deriveSheetKey` + `@dfinity/agent` `add_entry` to the runner API with an **injected fetch shim**; verify runner `crypto.subtle` covers HKDF/AES-GCM/BLS.
- Start a foreground service promptly (Android 12+); WorkManager for >10s; add OEM battery-unrestricted/autostart prompts + manifest permissions.
- Idempotency (deterministic `entry_key`) guarantees the silent write and the still-queued notification/inbox converge to one entry.
- *Risky / may not pan out:* runner `crypto.subtle` BLS coverage is **unverified**; reliability is best-effort (Doze/quota/deprioritization/Force-Stop/OEM-kill). If it underperforms, **ship M0+M1 and stop** — the owner already accepts the tap fallback.
- *Test on a real device:* on a stock Pixel, app backgrounded (not killed), send a screenshot and confirm the entry appears with **no tap**; then repeat after swipe-from-Recents and after Force Stop and confirm it correctly **falls back** to the visible notification / inbox (no duplicate, no loss). Repeat on an OEM device (Xiaomi/Samsung) to characterize the real failure rate.

**iOS:** deferred until `cap add ios` lands; when added, ship **M0+M1 (visible tap + inbox) only** — silent (content-available) is non-viable and the tap fallback is mandatory there.

### Residual unknowns

- Whether the Background Runner's exposed crypto.subtle fully covers the SubtleCrypto operations @dfinity/vetkeys needs (HKDF, AES-GCM, and the BLS12-381 pairing used in decryptAndVerify) — unverified and must be tested in the runtime before committing to the silent path.
- Real-world Android silent-delivery success rate per OEM (Xiaomi/Huawei/Samsung/OnePlus) and per Android version, including how often swipe-from-Recents becomes a force-stop — must be measured on physical devices, not assumed.
- The size and correctness of the actual port of identity + transport-key custody from IndexedDB/localStorage to CapacitorKV (or OS keychain) and re-wiring deriveSheetKey/add_entry with an injected fetch shim — scoped as a real rewrite, effort not yet estimated.
- II delegation expiry in the background: a headless silent write cannot do an interactive re-login, so behavior after delegation expiry (currently 30-day maxTimeToLive) is unhandled and only the tap path can recover it.
- OAuth subject → IOU principal mapping has no guaranteed stable cross-provider sub; the connector must persist its own mapping — a new key-blind but trusted state store whose abuse/rotation story is unspecified.
- iOS is entirely unbuilt (no cap add ios, no entitlements, no apple-app-site-association); all iOS conclusions rest on Apple docs/DTS, not on this repo, and the silent path there should be treated as non-viable until empirically disproven.
- The relay holds short-lived plaintext drafts — a new provider-class exposure surface needing short TTL, per-user scoping, and delete-after-fetch; its hardening is not yet designed.
- Whether the mobileSecureStorage.ts adapter (today only used by replaceMember.ts) is the right home for the transport key, vs CapacitorKV, for both the foreground and Background Runner paths.

---

## On-device LLM option (Gemma & friends)

This is the **maximum-privacy** alternative to the BYO-LLM architecture above. Instead
of the user's *cloud* ChatGPT/Claude doing the vision, a small **vision LLM runs on the
user's own device** and extracts the draft locally. It's the only option where **nothing
— not even the screenshot — ever leaves the device**: full *content*-confidentiality on
top of IOU's existing *key*-custody E2E, with no developer API key and no BYO
subscription. The price is real engineering and a real accuracy hit.

> Research-stage: the facts below are web-sourced (mid-2026) but the adversarial
> verification pass for this option was cut short by a session limit. The **integration
> claim was verified against the repo** (the draft plugs into the existing
> `templateToInitial → EntryForm → onSubmit → encryptEntryPayload → add_entry` seam with
> zero crypto/canister changes); the **accuracy claim should be piloted** on real IOU
> screenshots before committing.

### 1. Verdict
**Yes — feasible, target-specific, and uniquely private.** It closes the one leak the
BYO-LLM paths can't (the screenshot + fields transiting OpenAI/Anthropic). But on-device
*vision* on phones needs a **native plugin** (WebGPU is unavailable in Capacitor's
WebView), models are **multi-GB downloads**, latency is **seconds**, and small-model
**extraction accuracy is materially below cloud vision** — so confirm-before-write (which
IOU already mandates) is non-negotiable. Best framed as an **optional tier**, not a
replacement for the BYO path.

### 2. Models & runtimes
- **Gemma 3** 4B/12B/27B are multimodal (SigLIP); **Gemma 3 1B/270M are text-only.**
- **Gemma 3n E2B/E4B** are the mobile-optimized, natively multimodal (text+image+audio)
  line — ~2 GB / ~3 GB effective RAM.
- **Runtime gotcha:** `llama.cpp` supports Gemma 3n **text-only** (its vision encoder
  isn't implemented). Gemma 3n *vision* needs **transformers / MLX / transformers.js /
  Ollama / Google AI Edge LiteRT-LM**. Gemma 3 (non-n) vision *does* work in llama.cpp via
  a separate `mmproj` file.
- **Smaller phone-friendly VLMs:** SmolVLM2 (256M/500M/2.2B), **Qwen2.5-VL-3B / Qwen3-VL-2B**
  (strong multilingual OCR, llama.cpp vision-capable), Moondream2 (~1.9B), **MiniCPM-V
  4.5/4.6** (best small-tier OCR; official iOS/Android code), Phi-3.5-vision, Apple FastVLM.
  For OCR/field extraction, **MiniCPM-V and Qwen-VL lead** the small tier.

### 3. Feasibility by target

| Target | How | On-device feasible? |
|---|---|---|
| **Desktop / PWA** | In-tab **WebGPU** (`transformers.js` — working VLM runtime; WebLLM vision is broken/unmaintained, text-only), **or** a local **Ollama / LM Studio** HTTP endpoint (stronger model) | **Yes, solid.** WebGPU is GA in desktop browsers (Nov 2025). |
| **Android app** | A **native Capacitor plugin** wrapping **Google AI Edge LiteRT-LM** (Gemma 3n, Kotlin GA) or llama.cpp/MLC. **Not** in the WebView — Capacitor's Android System WebView + iOS WKWebView don't expose WebGPU ([capacitor#8044](https://github.com/ionic-team/capacitor/issues/8044)). | **Yes, via native plugin** (gate on device RAM). No mature off-the-shelf vision plugin exists yet → custom. |
| **iOS app** | Native via MLX / LiteRT-LM (Swift early-preview) | **Real but least-ready** — IOU has no iOS target yet (`cap add ios` pending). |

**Footprint/latency (Gemma 3n E2B, int4, on a 2024-25 flagship):** ~2.9 GB model,
~2.7–3.4 GB peak RAM, time-to-first-token ~6.7 s (CPU) / ~12.7 s (GPU); **one screenshot
extraction ≈ 2–15 s**. Comfortable on 8–12 GB flagships, **borderline/OOM on 6–8 GB
mid-range**, E4B is flagship-only. The model **can't be bundled in the APK** — it's a
one-time on-first-use download. (`MediaPipe LLM Inference` is now maintenance-only →
target **LiteRT-LM**.)

### 4. Accuracy — the load-bearing weakness
Small on-device VLMs are **materially worse** than cloud frontier vision at reliable
structured extraction. Data points: Gemma 3 27B scored **~43%** on a 1,000-doc JSON
extraction benchmark; gemma-3-4b ~46% on clean invoices vs **~96%** for GPT-5-class; the
best *open* models that match GPT-4o (~75%) are 32B+ server-class. The dangerous failure
modes are exactly the costly ones for a ledger: **hallucinated/dropped digits, wrong
currency, swapped counterparty/date, flipped direction, and run-to-run non-determinism
even at temp 0.** MiniCPM-V/Qwen-VL narrow the gap on *clean, high-contrast* transfer
screenshots. Mitigation = IOU's mandatory **confirm-before-write** (the existing
`EntryForm` is the confirmation surface; direction is a user-flipped radio), plus a tight
forced-JSON schema and a `confidence` field. **Pilot a measured per-field accuracy number
on real IOU screenshots before building the plugin.**

### 5. Privacy win (and honest caveats)
The *only* path with **no inference network call** — screenshot, extracted fields, and key
all stay on-device; canister sees ciphertext only. Caveats: (a) model **weights are
downloaded once** (not user content); (b) the runtime must be **no-telemetry** (verify the
chosen lib makes no analytics calls); (c) "on-device" is relative to *IOU's network
boundary* — the OS, keyboard, and screenshot store still handle the image as for any local
app; (d) confidentiality ≠ accuracy, so confirm-before-write still applies.

### 6. Integration — direct-in-IOU wins; OpenChat/Telegram add nothing
The on-device extractor only produces an **unencrypted draft**; IOU's existing on-device
crypto does the write unchanged: `draft → Partial<EntryPayload> → EntryForm initial →
onSubmit → encryptEntryPayload → add_entry` (`SheetPage.tsx:36/281/591`, verified). New
code = the model bridge + a draft→`Partial<EntryPayload>` mapper + a draft entry point +
defensive validation. For Reservations, keep the draft to **gross/face value** and let the
saved template supply fee + schedule.

**OpenChat / Telegram are the wrong host:** both are dumb transports with no built-in LLM,
so an on-device model could only reach them by running a **local bot/userbot on the user's
own device** — strictly more moving parts, and it would *still* have to call IOU's
on-device crypto. For a 2-person ledger where both members already run the IOU app, that's
pure overhead (and a Telegram userbot watching a private chat is ToS-grey). **Ranking:
direct-in-IOU ≫ (nothing) > OpenChat local bot > Telegram userbot.**

### 7. Recommendation & what's built
- **Ship M2 (paste/share + confirm) first** — universal, zero new native code, the import
  UI is the only piece needed (shared with the BYO path).
- **Add the on-device VLM as an optional "max-privacy" tier:** desktop/PWA via
  `transformers.js` WebGPU (or local Ollama/LM Studio for a stronger model); Android via a
  **custom LiteRT-LM native plugin**, gated on a device-RAM check with fallback to the
  paste/BYO path. iOS waits on the iOS target.
- **Keep the cloud BYO path** for users who want maximum extraction accuracy and accept
  the content-exposure trade-off.
- **Built today (v1.4.0):** the on-device crypto + `add_entry` write path and the
  `templateToInitial/EntryForm` seam. **Not built:** the draft entry point + mapper (shared
  with M2), any on-device model bridge/plugin, and the iOS target.

### 8. Exact end-user steps (on-device tier) — all **[BUILD]**

Legend: **[offline]** no network at all · **[1×net]** one-time model download · **[BUILD]** not yet implemented.

**Desktop — in-app, zero install (transformers.js / WebGPU):**
1. In IOU (desktop browser/PWA), Settings → enable **"On-device AI (max privacy)"**. First enable downloads the model (~hundreds MB–GB, cached). **[1×net]**
2. Add entry → **"Extract from screenshot (on-device)"** → drop/choose the transfer image. **[offline]**
3. The model runs locally; IOU shows the **pre-filled confirm screen**. **[offline]**
4. Review/fix amount, currency, counterparty, date, **direction** → **Save** → IOU encrypts on-device and writes `add_entry`. **[offline]**

**Desktop — stronger local model (Ollama / LM Studio):**
1. One-time: install Ollama or LM Studio, pull a vision model (e.g. `qwen2.5-vl` / `gemma3:4b`), enable CORS for IOU's origin (Ollama: `OLLAMA_ORIGINS` + restart; LM Studio: CORS toggle). **[1×net]**
2. In IOU → **"On-device AI (advanced)"**, point it at the local endpoint (`http://localhost:11434` / `:1234`). *(Chrome 142 adds a one-time Local Network Access prompt; Windows Ollama CORS can be finicky.)*
3. Then per-screenshot: same as steps 2–4 above. **[offline]** after setup.

**Mobile (Android) — native plugin:**
1. Install the IOU app (with the on-device model plugin). First use downloads a ~2–3 GB model over Wi-Fi; needs ~4 GB free RAM (offered only on capable devices, else falls back to paste/BYO). **[1×net]**
2. Add entry → **"Scan screenshot (on-device)"** → choose the image. **[offline]**
3. The on-device model extracts (~2–15 s); IOU shows the **confirm screen**. **[offline]**
4. Review/fix fields incl. direction → **Save** → on-device encrypt + `add_entry`. **[offline]**

**iOS:** not yet — no iOS Capacitor target. Use the desktop tier or the BYO mobile paste path.

### 9. Residual unknowns
- Real per-field extraction accuracy of a phone-class VLM on IOU's actual transfer
  screenshots (must be piloted; especially `amount_minor`, currency, direction).
- LiteRT-LM iOS Swift vision is early-preview with open image-feeding issues; Android is GA.
- Whether mid-range phones (6–8 GB) can run E2B without OOM/thermal throttling alongside
  IOU's WebView (needs a device-capability gate).
- Model-download integrity/supply-chain (verify model hash/source on first fetch).
- The draft is untrusted input (prompt-injection via screenshot text) — the mapper must
  validate types/currency/amount and treat direction as a hint.

---

## 3. Platform feasibility (evaluate in priority order)

### 3.1 WhatsApp — **Cloud API (official)**
- **What it is:** Meta's hosted API. Needs a Meta Business account, a
  *verified* business, a dedicated phone number for the bot, and a public
  HTTPS webhook server. Inbound messages (text + media) are delivered to
  your webhook; you download images via the media endpoint.
- **The product-shaping constraint:** a Cloud API business number is a
  **participant you talk to**, not an invisible observer. The natural,
  fully-supported topology is *both humans message the bot* (each in their
  own 1:1 thread) or *a group that contains the bot's number*. The Cloud
  API does **not** let a bot passively eavesdrop an existing private
  2-person chat the way a person would. Group support via Cloud API is
  comparatively new and gated. **This changes the UX** ("add our assistant
  to the chat" / "forward to the assistant") and must be acceptable to the
  owner.
- **Media:** transfer screenshots arrive as image messages → downloadable →
  feed to vision. ✓
- **Cost/friction:** business verification + number provisioning + webhook
  hosting + (likely) a use-case review. **Feasibility: medium**, best as a
  *production* target, poor as a *first* prototype.

### 3.2 WhatsApp — **whatsapp-web.js (unofficial)**
- Drives a real WhatsApp Web session via Puppeteer; *can* transparently
  read an existing 2-person chat or group incl. media.
- **Against WhatsApp ToS**, real ban risk, brittle (breaks on WA Web
  updates), needs a long-lived browser pinned to a phone. Acceptable for a
  throwaway demo only — **not** a product foundation. **Feasibility for a
  shipped product: rejected.**

### 3.3 ChatGPT (custom GPT / Action)
- An Action calls your webhook, and a custom GPT can be told to invoke it
  on every turn. Vision parsing of uploaded screenshots is strong.
- **But** a GPT conversation is **one user ↔ the GPT**. There is no shared
  2-person chat to watch; both members would each use the GPT separately,
  collapsing the feature to a per-user forwarding assistant. The
  "watch a chat between the two members" requirement does not map.
  **Feasibility for the stated feature: low.** Keep only as a fallback
  "forward your screenshot to the assistant" surface.

### 3.4 Telegram (Bot API) — **prototype winner**
- `@BotFather` → token in minutes. Add the bot to a group with the two
  humans; with **privacy mode off** (or bot = admin) it receives every
  message incl. photos. **Long-polling (`getUpdates`) needs no public
  webhook/HTTPS** — ideal behind WSL for local dev. Photos download via
  `getFile`; **inline keyboards** give us the confirm UX for free; stable
  numeric user IDs make participant mapping trivial.
- **Feasibility: high** — and a perfectly good product surface too, not
  just a toy.
- **Cost:** the Telegram Bot API is **free** — no per-message or hosting
  fees from Telegram (only your own server). The paid features (Telegram
  Stars, Premium) are unrelated to a read/send bot.

### 3.5 OpenChat (ICP-native) — **best architectural fit, different UX**
OpenChat is an open-source, fully on-chain messenger that runs *on the
Internet Computer* — the same platform as IOU. Its bot framework
(`open-chat-labs/open-chat-bots`, SDKs in Rust/TS/Motoko) is the most
*aligned* option, with real trade-offs:

- **Identity is native and clean.** An OpenChat **bot has its own ICP
  principal**, derived from a private key the bot holds, which it uses to
  identify itself to the OpenChat backend. That same principal can be the
  IOU **agent principal** (§4.4 Option B) — no delegated human key, no
  KMS-held member identity. Users authenticate with Internet Identity, so
  the OpenChat-user → IOU-principal mapping can be made native (potentially
  a verifiable link to the same II), removing the fragile `/link` step.
- **Trigger model is command-driven, not passive.** Bots are **Command**
  (user invokes a `/` command), **Integration** (external/webhook), or
  **Autonomous** (act proactively with an install-time API key + their own
  principal). OpenChat issues a **JWT signed by OpenChat's private key**
  carrying scope + permissions + the invoking user, which the bot verifies
  with OpenChat's public key. Per the current docs, a bot receives
  **command arguments and event notifications — not a passive stream of all
  chat messages/images.** So the "share a screenshot and it just happens"
  UX becomes **"invoke `/iou` (ideally from a message's context menu) and
  confirm."** Arguably *better* for a financial action (explicit consent),
  but a different interaction than Telegram's silent watch.
- **⚠️ Open feasibility question — the image path.** Command parameter
  types appear to be scalars (string/number/user/…); whether a **screenshot
  can be passed to the bot** (as an attachment parameter, or by invoking a
  command *on* an image message and having the bot fetch that message's
  media with read permission + autonomous API access) is **unconfirmed and
  must be verified against the SDK before committing.** If images can't
  reach the bot, the screenshot flow degrades to manual text entry on
  OpenChat.
- **Permissions** are granted by the group/community owner at install; the
  bot only gets what it's granted. **No ToS/eavesdrop risk** (unlike
  whatsapp-web.js) and it's self-hostable.
- **Reach is small** (crypto/ICP-native users), which is the main product
  caveat vs Telegram/WhatsApp. For a dogfooding or ICP-native audience this
  is acceptable — even on-brand for an on-chain E2E IOU app.
- **Feasibility: high for an ICP-native product**, pending the image-path
  check. Heavier to stand up than Telegram (run + register a bot server,
  both members need OpenChat), lighter on the identity/trust side.

**Conclusion:** build the prototype on **Telegram** now to de-risk the
platform-agnostic core (extraction → K_sheet → `add_entry`); the extractor,
canister client, and entry-builder are reused verbatim when porting the
*surface* to **OpenChat (Option B)** or WhatsApp for production. Choose the
production surface *after* the pipeline is proven, with the §3.1 topology
constraint and the §3.5 image-path check on the table.

---

## 4. The hard problem — E2E encryption & key authorization

### 4.1 How keys work today (recap)
- Each **sheet** has a symmetric **K_sheet** (AES-256-GCM). Entries are
  **ciphertext-only** on the canister: the client encrypts an
  `EntryPayload` under a per-entry key derived from K_sheet and ships only
  `{entry_key, iv, ciphertext}` (`add_entry`, `src/lib.rs:1466`).
- **Dev path** (`devVetkd.ts`): K_sheet is random 32 bytes generated at
  sheet creation, wrapped to each member via P-256 ECDH and stored as
  `wrapped_key_a/b` on the `Sheet`. A member fetches their blob
  (`get_sheet_wrapped_key`) and unwraps it with their local P-256 key.
- **Prod path** (`prodVetkd.ts`, vetKD): K_sheet = HKDF of the IBE vetKey
  derived for `(canister, "iou-sheet:"+sheet_id)`. A member calls
  `vetkd_wrap_sheet_key(sheet_id, transport_pubkey)` and decrypts the IBE
  ciphertext with a device transport key. **Critically, the derived
  K_sheet is identical for everyone** — it is bound to `(canister,
  sheet_id)`, *not* to the principal. The only gate is the canister's
  per-sheet membership check `caller_owns_sheet` (`src/lib.rs:1428`).

**The consequence that makes the bot possible:** in the vetKD model,
**any principal that the canister recognises as a sheet member can derive
K_sheet** by calling `vetkd_wrap_sheet_key` with a freshly-generated
transport key. There is no extra per-member secret. So "authorize the bot"
reduces to "make the canister accept a principal the bot controls as a
member."

### 4.2 The structural constraint: exactly 2 members
`Pair.members: [Principal; 2]` and `Sheet.member_a/member_b` are a hard
2-slot model. There is **no third slot for a bot.** This forces the choice
below.

### 4.3 Option A — bot acts under a member's identity *(recommended for prototype; viable for prod)*
The bot holds an identity that **is** one of the two members:
- **Prototype:** the bot literally holds member A's `Ed25519`/`Secp256k1`
  key (same as the smoke scripts generate identities). It is member A.
- **Production:** member A grants the bot a **scoped, expiring Internet
  Identity delegation** to a bot-held session key (II supports
  canister-target-scoped, time-boxed delegations). The bot then makes
  canister calls *as A* until the delegation expires.

To write entries from *either* human correctly, **each** member links once,
so the bot can act as whichever member shared the content.

**Pros**
- **Zero canister changes.** Works against the current v1.4.0 backend today.
- **`direction` stays correct for free.** `add_entry` records
  `created_by = caller`; `direction` is interpreted relative to the author.
  Because the bot writes *as the actual sharer*, a "credit"/"debt" means
  exactly what it means when that human writes it from their own device.
- Matches an existing trust primitive (II delegation).

**Cons / trust cost (state these plainly)**
- A delegation-holding bot can do **everything that human can**: read all
  their sheets/accounts, write entries attributed to them. The bot server
  becomes part of the trust boundary.
- E2E is preserved *cryptographically* (the canister still never sees
  plaintext; only member devices + the bot can derive K_sheet) but the set
  of parties who can read plaintext grows to include the bot host.
- Mitigations: short delegation TTL; canister-scoped delegation; bot key in
  a KMS/HSM, never logged; per-link revocation (human re-links / revokes);
  rate-limit + audit every bot-authored call.

### 4.4 Option B — dedicated bot principal *(production hardening)*
Give the bot its **own** principal and make the canister grant it
sheet-scoped access — modelled on the existing
`grant_partner_access(pair_id, expected_partner, rewraps)` flow
(`src/lib.rs:1862`), which is already the template for "owner explicitly
authorizes another principal to a specific sheet."

Requires three changes:
1. **Canister:** an explicit "agent" authorization per sheet (either a new
   optional `agent: Option<Principal>` slot honoured by `caller_owns_sheet`,
   or generalising membership). Owner-initiated, revocable, idempotent —
   reuse the `grant_partner_access` security guards (recipient-bound,
   atomic, Active-only).
2. **Payload:** `direction` is **relative to `created_by`**, so a
   bot-authored entry (author ∉ {A,B}) is uninterpretable. Add **absolute**
   direction to `EntryPayload`, e.g. `debtor`/`creditor` (or
   `from`/`to`) principals. This is an *additive, client-side* schema
   change — the canister stores ciphertext and doesn't care.
3. **Frontend:** balance computation must handle absolute-direction
   (bot-authored) entries alongside legacy relative ones.

**Pros:** least-privilege (bot can't impersonate a human), entries clearly
attributed to the bot, clean revocation, auditable. **Cons:** real
canister + payload + frontend work; a MemoryId-discipline review if storage
changes (see `stable-memory-memoryid-discipline`).

**OpenChat makes Option B native.** On OpenChat the bot *already* has its
own ICP principal (§3.5), so there is no extra identity to mint — that
principal is the agent principal granted per-sheet, and (if the bot is or
fronts a canister) the grant + `add_entry` can even be canister-to-canister.
This is the "better ICP-style identity option": the bot is a first-class
ICP actor rather than a server holding a human's delegated key.

### 4.5 Recommendation
Prototype with **Option A + the vetKD path** (mirrors production: the bot
controls a member principal and derives K_sheet via
`vetkd_wrap_sheet_key`, exactly like `awa-smoke-vetkd.ts`). Ship **Option
B** as the hardening once the pipeline is proven and the owner accepts the
canister/payload changes.

> **Whichever option: a server-side agent that turns chat content into
> encrypted ledger entries MUST hold key access — there is no way around
> some server-side party being able to derive K_sheet.** The honest design
> question is *how scoped and revocable* that access is, not whether it
> exists.

---

## 5. Participant → member mapping

Bot-side state (small store — SQLite or a JSON file for the prototype):

```
member_link:  (platform, chat_user_id)  -> { principal, member_slot, identity_ref }
                                            identity_ref = how the bot acts as them
                                            (dev: key handle; prod: delegation handle)
chat_link:    (platform, group_chat_id) -> { pair_id, active_sheet_id }
```

**Onboarding**
1. Each human DMs the bot `/link` → bot walks them through auth
   (prototype: bind to a test identity; prod: an II delegation web flow) and
   records `chat_user_id -> principal (+ slot)`.
2. One member runs `/linkpair <pair_id|invite>` in the group → bot resolves
   the pair, finds the active sheet, writes `group_chat_id -> pair_id`.
3. Bot verifies both linked principals are exactly `pair.members[0]` and
   `[1]` before it will write anything.

**Direction resolution** (decided by *who shared*, confirmed before write):
- **Transfer screenshot, sender = A → receiver = B:** record **as A**, a
  settlement whose net effect moves the balance in A's favour by `amount`
  (A paid/credited B). Author = A ⇒ `direction: "credit"`.
- **Reservation shared by A (A fronts it):** IOU **as A**, `direction:
  "credit"` (B owes their share), `txn_type: "iou"`, fee + schedule from
  **A's "Reservation" template**, gross = the reservation amount.

The exact sender→direction convention (esp. "I paid you" vs "you owe me")
is the one product detail to confirm; the **confirm gate makes it
self-correcting** regardless.

---

## 6. Extraction pipeline

```
inbound message (text and/or image)
        │
        ▼
[1] gate: is the chat linked? is the sender a linked member?     → else ignore/prompt /link
        │
        ▼
[2] classify intent  (Claude, cheap/fast model)
        │   { transfer_screenshot | reservation | other }
        ▼
[3] extract  (Claude w/ vision, forced tool-use → typed JSON + confidence)
        │   transfer  → { amount_minor, currency, sender_hint, receiver_hint, ts }
        │   reservation → { gross_amount_minor, currency, template_hint, ts, fields… }
        ▼
[4] map → principals + direction (§5) + select template (reservation)
        │
        ▼
[5] CONFIRM in chat  (inline buttons: ✅ create / ✏️ edit / ❌ cancel)
        │   low confidence or ambiguity ⇒ ask a clarifying question first
        ▼
[6] write: derive K_sheet → encrypt EntryPayload → add_entry  (as the sharer)
        │
        ▼
[7] reply with a receipt (entry id, decoded summary, running balance)
```

**How the image is "scanned" — there is no separate OCR step.** The bot
downloads the image from the chat platform (Telegram `getFile` → bytes),
base64-encodes it, and sends it to **Claude's vision API** as an `image`
content block alongside the prompt + a forced structured-output schema
(`output_config.format`, or strict tool use). Claude reads the screenshot
directly — it does OCR *and* semantic understanding in one call (it natively
parses bank / Venmo / PayPal / Revolut / wallet transfer confirmations and
reservation emails), and returns typed JSON. No Tesseract, no separate OCR
engine.

**Extraction contract.** Force Claude to emit a `record_entry` object whose
JSON schema mirrors the relevant slice of `EntryPayload`
(`src/features/entries/types.ts`): `currency` (ISO-4217, upper),
`amount_minor` (integer minor units), `txn_type`, and for reservations the
gross amount so the template fee math runs client-side. Always include
`confidence: number` and `reasoning: string`. Never write below a
confidence threshold without explicit confirmation.

**Model & cost (it is *not* free — the Claude API is pay-per-token).** Per
the `claude-api` reference, default to **Opus 4.8** (`claude-opus-4-8`,
$5 / $25 per 1M input/output tokens) — the most capable on messy real-world
screenshots. A screenshot bills as input tokens by size (~1.6K standard,
up to ~4.8K at Opus high-res), plus a small prompt and a small JSON output.
Ballpark **per screenshot**:

| Model | $/1M in · out | ≈ per screenshot |
|---|---|---|
| Opus 4.8 (`claude-opus-4-8`, default) | $5 · $25 | ~$0.03–0.05 |
| Sonnet 4.6 (`claude-sonnet-4-6`) | $3 · $15 | ~$0.01–0.02 |
| Haiku 4.5 (`claude-haiku-4-5`) | $1 · $5 | ~$0.005 |

So a few cents per screenshot at most; cents-to-fractions if you pick a
cheaper tier. Model choice is the owner's call — Opus 4.8 is the quality
default; Sonnet/Haiku trade some accuracy on hard images for ~3–10× lower
cost. (Confirm current IDs/pricing via the `claude-api` skill before wiring.)

**Template application** mirrors the PWA: net `amount_minor = gross −
gross*fee_percent/100 − fee_fixed_minor`; build `schedule[]` from the
template's relative portions (`in_days` / `start_of_next_month`), percents
summing to 100; fee deducted from the final installment.

**Template application** mirrors the PWA: net `amount_minor = gross −
gross*fee_percent/100 − fee_fixed_minor`; build `schedule[]` from the
template's relative portions (`in_days` / `start_of_next_month`), percents
summing to 100; fee deducted from the final installment.

---

## 7. Architecture

```
 ┌──────────────┐   photos/text    ┌───────────────────────────────────────┐
 │  Chat group  │ ───────────────▶ │           Chat-Agent server            │
 │  A + B + bot │ ◀─── confirm ──── │  (Node/TS)                             │
 └──────────────┘   buttons        │                                        │
   Telegram (proto)                │  ┌──────────────┐   ┌────────────────┐ │
   WhatsApp Cloud (prod)           │  │ platform      │   │ mapping store  │ │
                                   │  │ adapter       │   │ (chat/member   │ │
                                   │  │ (long-poll /  │   │  links)        │ │
                                   │  │  webhook)     │   └────────────────┘ │
                                   │  └──────┬───────┘                       │
                                   │         ▼                               │
                                   │  ┌──────────────┐   ┌────────────────┐ │
                                   │  │ extractor     │   │ identity/key   │ │
                                   │  │ (Claude       │   │ vault          │ │
                                   │  │  vision +     │   │ (member ident/ │ │
                                   │  │  tool-use)    │   │  delegation;   │ │
                                   │  └──────┬───────┘   │  KMS in prod)  │ │
                                   │         ▼           └───────┬────────┘ │
                                   │  ┌─────────────────────────────────┐  │
                                   │  │ canister client (@dfinity/agent)│  │
                                   │  │  derive K_sheet (vetKD) →       │  │
                                   │  │  encryptEntryPayload → add_entry│  │
                                   │  └──────────────┬──────────────────┘  │
                                   └─────────────────┼─────────────────────┘
                                                     ▼
                                          ┌─────────────────────┐
                                          │  iou_backend canister│
                                          │  (ICP, :40436 local) │
                                          │  ciphertext-only     │
                                          └─────────────────────┘
```

The **identity/key vault** is the sensitive component (§4 trust cost). Keep
it isolated, KMS-backed in prod, never log key material, audit every call.

---

## 8. Prototype plan (post-confirmation)

Goal: receive a message → parse → write the correct entry to the **local**
canister for a test account, end-to-end, then verify by reading it back as
the other member.

- **Location:** `scripts/chat-agent/` (Node/TS, `tsx`, ESM — matches the
  smoke harness). Reuse `idlFactory` from `src/backend/declarations.ts`,
  `encryptEntryPayload`/`encodeEntry`, and the vetKD `deriveSheetKey` flow
  from `awa-smoke-vetkd.ts`.
- **Platform:** Telegram via long-polling (propose `grammy` for photos +
  inline keyboards; or raw Bot API over `fetch` to avoid the dep).
- **Identity:** Option A — the bot holds the test member identities (created
  in a setup step that mirrors `awa-smoke-vetkd.ts`: A `create_pair`, B
  `join_pair`, A `create_sheet`). For the demo the bot controls A's
  identity and writes as A.
- **Extractor:** `@anthropic-ai/sdk` (new dep) + `ANTHROPIC_API_KEY`,
  vision + forced tool-use → typed JSON. First cut may accept a pasted
  transfer image *or* a text line (`"sent 25.00 USD to B"`) to de-risk OCR
  before adding vision.
- **Flow demonstrated:**
  1. Telegram photo/text → 2. classify+extract → 3. map+confirm
  (inline ✅) → 4. `vetkd_wrap_sheet_key` → `deriveSheetKey` →
  `encryptEntryPayload` → `add_entry` as A → 5. verify by `list_entries` +
  decrypt as B and print the decoded `EntryPayload`.
- **Run targets:** local replica on `127.0.0.1:40436`
  (`VITE_IOU_BACKEND_CANISTER_ID` from `.env.local`); add an
  `agent:proto` script alongside the `smoke:*` scripts.
- **Proves:** the encryption/identity model works against the real canister;
  the extraction → entry mapping is correct; confirmation UX is sound.

Heavier build-out (real onboarding, II delegation flow, WhatsApp Cloud
adapter, Option B canister changes) is **explicitly out of scope for the
first cut** and gated on the prototype's results.

---

## 9. Security checklist & non-goals
- [ ] Key material (member identity / delegation) never logged; KMS in prod.
- [ ] Delegations short-TTL + canister-scoped; per-link revocation path.
- [ ] Bot writes **only** after explicit in-chat confirmation.
- [ ] Verify both linked principals == `pair.members` before any write.
- [ ] Rate-limit + audit-log every bot-authored canister call.
- [ ] Treat all chat images as untrusted input to the vision model.
- [ ] If Option B: MemoryId discipline review (`stable-memory-memoryid-discipline`).
- **Non-goals (v1):** group chats >2 humans; editing/deleting entries via
  chat; cross-account routing; offline message backfill.

---

## 10. Decisions to confirm before building (the pause)
1. **Prototype platform:** Telegram (recommended — free, passive image
   read, no canister change) to de-risk the platform-agnostic core. The
   production *surface* (OpenChat / WhatsApp / Telegram) is a separate,
   later choice once the pipeline is proven.
2. **Production surface — all three stay documented (Telegram, WhatsApp,
   OpenChat); decide after the prototype.** They are swappable surfaces over
   the same core. OpenChat + Option B is the ICP-native end state (verify the
   §3.5 image path); WhatsApp Cloud is the mainstream-reach end state. None of
   this blocks the Telegram prototype.
3. **Identity/key model for the prototype:** Option A (bot acts under a
   member identity, no canister change) — confirming you accept that the
   bot host can derive K_sheet for linked sheets — with Option B as the
   documented prod hardening (native on OpenChat).
4. **Direction convention — CONFIRMED:** transfer A→B = **credit for A**
   (balance moves in A's favour by the amount). Locked in §5.
