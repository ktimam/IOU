# IOU — Product Specification (v2)

> A 2-person IOU / shared-ledger app on the Internet Computer.
> End-to-end encrypted with `vetkd`-wrapped per-sheet keys (the IC node operator
> cannot read your data). FX conversion is a per-entry toggle. Entries are
> append-only. A real project, shipping to mainnet.

---

## 1. Vision

Two people owe each other money. Tracking it in spreadsheets, chat, and memory is
annoying and lossy. **IOU** is the smallest thing that actually works:

- Either party logs a transaction in seconds.
- The app always shows the current net balance per currency.
- Cross-currency flows are a first-class toggle on an entry, with the FX rate
  fetched on the **user's device** (not our canister) and overridable.
- The data is end-to-end encrypted with the IC's threshold-key system. **Not even
  the canister's node operator can read the title, amount, or description of an
  entry.** Surviving a member losing access is supported by design.
- Entries are append-only — there's no "delete" button. Archiving is a per-user
  view filter, not a mutation.

It is **deliberately** for exactly two people per sheet, and exactly one sheet (or
many, sequentially) per pair. Not a group expense app. Not a wallet. Just
"who owes whom, by how much, in what currency, with full audit history."

---

## 2. User Stories

| # | As a... | I want to... | So that... |
|---|---------|--------------|------------|
| U1 | user | sign in with Internet Identity | I can access our shared ledgers |
| U2 | user | create a sheet with another user by sharing an invite code | we can pair up |
| U3 | user | join a sheet using an invite code from my partner | we can pair up |
| U4 | user | add a transaction (date, title, description, currency, amount, direction) | I record who paid what |
| U5 | user | toggle a transaction as "convert to another currency" | cross-currency entries sum into the right balance |
| U6 | user | see the FX rate auto-fetched on my device when I enable convert | I don't have to look it up manually |
| U7 | user | override the FX rate | I can correct wrong or stale rates |
| U8 | user | see current net balance per currency | I know what each side owes |
| U9 | user | see the full transaction history (filterable) | I can audit past activity |
| U10 | user | edit a transaction I created | I can fix mistakes (no delete ever) |
| U11 | user | archive a sheet in my own view | it stops cluttering my dashboard, but my partner still sees it |
| U12 | user | close a sheet after ~1 year of inactivity | the next period starts fresh, with the closing balance carried over |
| U13 | creator | replace a member of a sheet with another user | a long-running sheet survives a partner change |
| U14 | user | export the ledger (JSON / CSV) | I have a local backup |
| U15 | user | send a receipt image to a Telegram bot using my own GPT key | the bot extracts title/amount/currency and posts a candidate entry to my IOU inbox |
| U16 | user | review and confirm candidate entries from my IOU inbox | I trust what ends up in the sheet |
| U17 | user | stay signed in across sessions until I sign out | I don't re-authenticate all day |
| U18 | user | see all devices I'm signed in on, and sign out any of them | I can revoke access from a lost device |
| U19 | user | donate ICP to support the project | I want to chip in if it helps me |
| U20 | user | use the app on mobile (PWA in v1, native app in v1.1) | the same ledger works on phone and laptop |

---

## 3. Core Concepts

### 3.1 Pair
A **Pair** is a private, persistent relationship between exactly two principals.
A pair can hold one **active** sheet at a time and many **archived** sheets.

- A principal can be in multiple pairs (with different counterparts).
- A pair is created by user A; user B joins with an invite code.
- A pair survives even if a member loses their device — the other member still has
  access to all sheets under that pair (see §3.7 for the crypto reasoning).
- "Replace member" replaces user B with a new principal; the pair's sheet
  encryption is re-wrapped to the new member's key (see §3.7.4).
- "Export and start a new pair" lets either member fork the data into a fresh pair
  with a new partner. Old pair remains intact.

### 3.2 User
A **User** is a principal authenticated via Internet Identity.

- Display name is set on first sign-in, encrypted at rest after that.
- No email, no contact info, no profile photos. Initials are derived from the
  display name.
- Each login on a new device produces a new II delegation, which we surface in
  the "My devices" UI (U18).

### 3.3 Sheet
A **Sheet** is one balance-sheet relationship inside a pair.

- Exactly two members.
- Lives in a pair; cannot be moved between pairs (use the export-and-replace flow).
- Has an "enabled currencies" list (start: `EGP`, `USD`; user can add more).
- Has a state: `active` (accepting new entries) or `closed` (read-only, see §3.6).
- Has a closing window (default 365 days, configurable at sheet creation).
- Identified by a `sheetId`. Per-sheet symmetric key is `K_sheet` (see §3.7).

### 3.4 Transaction (a.k.a. Entry)
A single money movement in **one currency**.

| Field            | Type                | Notes                                                          |
|------------------|---------------------|----------------------------------------------------------------|
| `id`             | `nat64`             | Monotonic per-sheet                                            |
| `pairId`         | `text`              | Pair the sheet belongs to (cleartext, needed for authz)        |
| `sheetId`        | `text`              | Sheet the entry belongs to (cleartext)                         |
| `createdBy`      | `principal`         | The principal who logged it (cleartext, needed for authz)      |
| `createdAt`      | `int64` (ns)        | Encrypted. Set by the canister on insert.                      |
| `updatedAt`      | `?int64` (ns)       | Encrypted. Set by the canister on edit.                        |
| `direction`      | `Debt | Credit`     | Encrypted. From the **creator's** POV.                         |
| `title`          | `text` (≤120)       | Encrypted.                                                     |
| `description`    | `text` (≤2000)      | Encrypted.                                                     |
| `currency`       | `text` (ISO 4217)   | Encrypted.                                                     |
| `amount`         | `nat64` (minor units)| Encrypted. Integer in smallest unit.                          |
| `convertTo`      | `?Convert`          | Encrypted blob (see §3.5).                                     |

> Only the four cleartext fields above are visible to the canister. Everything
> else is AES-256-GCM ciphertext, wrapped under the per-sheet key.

### 3.5 Convert (cross-currency)
The **Convert** field is itself a small encrypted struct:

```text
{
  targetCurrency : Text,     // ISO 4217
  rate           : Float,    // amount in target currency per 1 unit of `currency`
  rateSource     : Text,     // "frankfurter" | "user" | "manual:<provider>"
  rateFetchedAt  : Int,      // when the user fetched it
  appliedTo      : Currency  // original currency this entry is converted FROM
}
```

Semantics:
- If `convertTo` is set, the entry contributes to the **target** currency's
  balance, not the original `currency` balance.
- The original currency and amount are still visible in the UI for audit, with
  the converted amount shown alongside in brackets (e.g. `EGP 100 (≈ USD 3.20)`).
- Direction (`debt` / `credit`) refers to the **target** currency's balance: who
  owes whom, in the converted currency.
- The `rateSource` is metadata the user can inspect; "frankfurter" means the rate
  was pulled from frankfurter.app in the user's browser; "user" means typed
  manually; "manual:<provider>" is a future option for users who used a paid rate
  feed and want to annotate it.
- Convert direction is **flippable later** via normal edit.

### 3.6 Closing a sheet
A sheet can be **closed** by either member. A closed sheet is read-only.

- Eligibility: no new entries for `closingWindow` days (default 365, configurable
  per sheet at creation).
- On close, the app computes a closing balance per currency.
- Either member can start a **new sheet** in the same pair. The new sheet's first
  entry is a "carried forward" line per currency, encoding the closing balance as
  a credit/debt for one of the two members. This makes the running total
  continuous across sheets while keeping each sheet's history intact.
- Closed sheets remain accessible from "Archived sheets" in the user's view
  filter; the other member's view is unaffected (U11).

### 3.7 Encryption model (the critical bit)

#### 3.7.0 Local-dev fallback (development only)
- On the local `dfx` replica, `vetkd_derive_key` may not be wired into
  `dfx` ≤ 0.24.x. To keep dev unblocked, the TS client has a
  **`devVetkd` adapter** that signs/derives using a deterministic,
  in-browser keypair derived from a `DEV_VETKD_SECRET` env var.
- The **adapter API is identical** to the production one. The canister
  doesn't know the difference; it just stores wrapped bytes.
- A test (`tests/crypto/prod-path.test.ts`) reads `import.meta.env.MODE`
  and **fails the build** if it sees the dev adapter in a production
  build. This is a hard guarantee that production never accidentally
  uses the dev path.
- The dev adapter is **never deployed**. The production code path uses
  IC `vetkd` exclusively.

#### 3.7.1 Per-sheet symmetric key
Each sheet has a 256-bit symmetric key, **`K_sheet`**, generated client-side
when the sheet is created. The canister never sees `K_sheet`.

#### 3.7.2 Two-wrapped-copies model
`K_sheet` is wrapped twice and stored in the canister:
- `wrap_A(K_sheet)` — sealed to user A's `vetkd`-derived public key.
- `wrap_B(K_sheet)` — sealed to user B's `vetkd`-derived public key.

Both wrapped copies are uploaded to the canister at sheet creation. The canister
stores them and serves them back to authorized members on demand. **Neither
user, nor the canister, nor the node operator, can derive `K_sheet` without
their own private key material.**

#### 3.7.3 What the node operator can see
For each entry, the node operator sees:
- `pairId`, `sheetId`, `entryId` (cleartext — needed for indexing and authz).
- `createdBy` principal (cleartext — needed for authz).
- A blob of ciphertext containing: `createdAt`, `updatedAt`, `direction`,
  `title`, `description`, `currency`, `amount`, `convertTo`.
- The two wrapped copies of `K_sheet` (constant per sheet).

The node operator **cannot** read any of the encrypted fields. There is no
"support can read your data" path — not even the developer can.

#### 3.7.4 Replace member
Re-seals `K_sheet` to the new member's `vetkd` public key. The old member's
wrapped copy is destroyed. The new member gets a copy. This requires both
**old** and **new** members to authorize (a signed message from each is uploaded
to the canister and verified before the canister re-wraps).

#### 3.7.5 Lost access
- One user loses access → the other user still has their wrapped copy of
  `K_sheet` and continues to have full access to all sheets in the pair.
- Both users lose access → the data is gone. **This is a known, accepted
  tradeoff of the threat model.** v1.1 candidate: an opt-in printable
  "recovery code" that derives a third wrapped copy of `K_sheet`, sealed to a
  recovery key. The user is responsible for storing this code offline.

#### 3.7.6 Why `vetkd`
The IC's `vetkd` (verifiable encryption of threshold-derived keys) is the only
on-chain primitive that:
- Lets the canister produce a public key derived from the **chain key**, with
  a transcript binding it to a specific `(user_principal, sheet_id)` pair.
- Lets the user's wallet (and only the user's wallet) derive the corresponding
  private key, but only after authenticating with II.
- Has a stable API on the IC mainnet.

It is the only "no-passphrase, no-customer-support, no-node-operator" key
management story that actually works for this product. Passphrases are a UX
nightmare; pure client-side keys are a recovery nightmare. `vetkd` splits the
difference.

### 3.8 Balance
For a given currency `C` in a given sheet:

```
net(user) = Σ convert_to_C(credit) - Σ convert_to_C(debt)
```

- A "native" entry (no `convertTo`) contributes to its own currency's balance.
- A "converted" entry contributes to its **target** currency's balance.
- Balances are computed client-side after the user decrypts entries.

### 3.9 Inbox (image-extraction flow)
The user's **Inbox** is a list of "candidate entries" generated outside the
sheet (today: a Telegram bot the user runs with their own GPT key).

- An inbox item contains the same fields as a regular entry, plus `source` and
  `imageHash` (encrypted; image itself is stored on the user's device or in a
  private Telegram chat).
- The user reviews each inbox item, edits if needed, and either **Adds to
  sheet** (chooses a sheet; the item becomes a regular entry, encrypted with
  that sheet's key) or **Dismisses**.
- The canister stores encrypted inbox items keyed by the user's principal.

### 3.10 Devices
Every Internet Identity login produces a **delegation chain**. We surface the
list of currently active delegations (= "devices") on the **My devices** page.
Each entry shows:
- Device label (best-effort: browser name, OS, first-seen date).
- Created at.
- Last used at.
- "Sign out this device" button.

Sign-out here = revoking the delegation. The user remains signed in on
unaffected devices.

---

## 4. Functional Requirements

### 4.1 Authentication
- F1.1 Sign-in is **Internet Identity only**. No passwords, no email.
- F1.2 First sign-in: prompt for display name, encrypt and store it.
- F1.3 Subsequent sign-ins on the same device: silent (valid delegation).
- F1.4 Sign-out is per-device, controllable from the My devices page.

### 4.2 Pair lifecycle
- F2.1 `createPair()` → returns a `Pair` with a `pairId` and a one-time
  `inviteCode` (8 chars, no ambiguous glyphs).
- F2.2 `joinPair(inviteCode)` → consumes the code, adds the caller as second
  principal. After this, the pair is **active**.
- F2.3 `replaceMember(sheetId, newMemberPrincipal, signedAuthFromOld,
  signedAuthFromNew)` → only the existing member who is **leaving** can
  initiate, and only the new member can be the destination.
- F2.4 `getMyPairs()` → all pairs the caller is in (any state).

### 4.3 Sheet lifecycle
- F3.1 `createSheet(pairId, enabledCurrencies, closingWindowDays, wrappedKeyA,
  wrappedKeyB)` → returns a new `sheetId`.
- F3.2 `addCurrency(sheetId, iso4217)` → only `EGP`, `USD`, or any user-typed
  3-letter code. Validation: regex `^[A-Z]{3}$`. Maximum 16 enabled currencies
  per sheet.
- F3.3 `closeSheet(sheetId)` → if eligibility met, marks the sheet `closed`.
- F3.4 `startNewSheet(pairId, carriedBalances)` → creates a fresh sheet, with
  one "carried forward" entry per non-zero balance currency.

### 4.4 Entries
- F4.1 `addEntry(sheetId, ciphertextBlob)` → caller must be a member. `id` is
  assigned by the canister (monotonic per sheet).
- F4.2 `editEntry(entryId, ciphertextBlob)` → only the **original creator**
  can edit. The canister rewrites the entry's ciphertext and bumps `updatedAt`.
- F4.3 There is **no `deleteEntry`**. Period. Ever.
- F4.4 `listEntries(sheetId, cursor?, limit?)` → returns cleartext metadata
  (`id`, `createdBy`, timestamps) plus ciphertext blobs. The client decrypts.
- F4.5 `getEntry(entryId)` → same shape.
- F4.6 `getSheet(sheetId)` → returns sheet metadata + both wrapped copies of
  `K_sheet` (the user can unwrap the one sealed to them).

### 4.5 Inbox
- F5.1 `addInboxItem(ciphertextBlob, source)` → caller-only.
- F5.2 `listInbox()` → caller's items.
- F5.3 `promoteInboxItem(itemId, sheetId)` → re-encrypts the item under
  `K_sheet` of the target sheet, inserts as a regular entry, removes the
  inbox item.
- F5.4 `dismissInboxItem(itemId)` → deletes from inbox (the only delete in
  the system, scoped to inbox only — it never touched a sheet).

### 4.6 Balances & history
- F6.1 Balances are **client-side** computations. The canister does not
  return balance data.
- F6.2 The history view is a client-side render over the entries list.
- F6.3 Filters: by currency, by date range, by "converted only" / "native only",
  by archived/hidden sheets.

### 4.7 Devices
- F7.1 `listMyDevices()` → derived from II delegation metadata. The canister
  cannot enumerate delegations directly, so v1 reads them from the II canister
  via `vetkd`/II inter-canister call (see security doc).
- F7.2 `revokeDevice(delegationId)` → invalidates the delegation via II.
- F7.3 "Sign out everywhere" → revokes all delegations; user has to re-auth
  with a WebAuthn anchor on next use.

### 4.8 Export
- F8.1 `exportSheet(sheetId, format)` → returns the **client-decrypted** data
  as JSON or CSV. The export runs on the user's device after decryption.
- F8.2 (v1.1) Google Sheets export: a CSV file the user opens in Google
  Sheets, or a Google Sheets API call on the user's behalf using their own
  OAuth credentials (we never see the credentials).

### 4.9 FX
- F9.1 The canister does **not** call out to FX APIs. The user's browser
  does, on demand, when the convert toggle is enabled.
- F9.2 Default provider: **Frankfurter.app** (free, ECB-backed, no key,
  historical rates back to 1999).
- F9.3 The fetched rate is shown in the form as "from frankfurter.app,
  fetched at <time>". The user can override.
- F9.4 The rate is stored on the entry as part of `convertTo`. It is encrypted
  with the entry.
- F9.5 **No client-side caching.** Every "convert toggle on" event triggers
  a fresh `GET` to Frankfurter.app. The convert path is rare enough (per
  the user's note) that the cost of a few KB of network is irrelevant.

### 4.10 Rate limits
- F10.1 Per-principal sliding-window rate limits on write endpoints:
  - `addEntry`: 60 / minute
  - `editEntry`: 30 / minute
  - `createPair` / `joinPair` / `replaceMember`: 5 / hour
  - `addInboxItem`: 120 / minute
  - `addCurrency`: 10 / hour
- F10.2 The canister returns `RateLimited` (a result variant) on rejection,
  never traps.

### 4.11 Privacy
- F11.1 No emails or contact info collected.
- F11.2 No analytics, no third-party scripts in the asset canister.
- F11.3 No telemetry of titles or amounts, client-side or server-side.
- F11.4 "Support the project" donate-ICP button is opt-in and clearly labeled.
  Funds go to the **canister creator's** ICP wallet (a constant in the
  canister, set at deploy time and surfaced in the UI's settings page).

---

## 5. Non-functional Requirements

| Area | Target |
|------|--------|
| Sign-in to first action (warm) | < 3s |
| Add entry round-trip | < 700ms (incl. encryption on device) |
| History load (200 entries) | < 2s on a mid-range phone |
| Concurrent users per pair | 2 (by design) |
| Mobile UX | PWA, installable, full keyboard + touch support |
| Time on-chain | canister time, never client-supplied |
| Languages | English UI in v1; i18n-ready strings |
| Cycles budget (per 1000 active pairs / month) | ≤ 1 SDR (very rough; see `06-deployment-and-costs.md`) |

---

## 6. Out of Scope (v1)

- Group ledgers (3+ people).
- Native mobile app binary (PWA only; Capacitor wrap in v1.1).
- Native FX rate feed (we never call out; we cache the user's fetched rate).
- Bank integrations / open banking.
- Receipts / image attachments stored on the asset canister.
- Recurring transactions.
- Per-pair printable recovery key (v1.1).
- Direct Google Sheets API integration (v1.1; v1 ships CSV export only).
- On-canister spam defense beyond per-principal rate limits (no ML, no IP
  throttling — the IC doesn't expose IP anyway).

---

## 7. Glossary

- **Principal** — an ICP identity (a public key + chain code, opaque text on II).
- **Canister** — a smart contract on the IC, runs as a Wasm module.
- **Internet Identity (II)** — IC's native anonymous auth, anchors to WebAuthn devices.
- **vetkd** — Verifiable Encryption of Threshold-Derived Keys. IC primitive.
- **Stable memory** — canister storage that survives upgrades.
- **Minor units** — smallest currency unit (cents for USD, piastres for EGP, etc.).
- **Pair** — exactly two principals with a relationship.
- **Sheet** — one balance-sheet relationship inside a pair.
- **Entry** — one transaction.
- **Inbox** — pending candidate entries, awaiting user review.
