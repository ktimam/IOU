# IOU — Architecture (v2)

> Single Motoko backend canister + a Vite/React PWA + a Telegram bot (in v1)
> for image-based entry. End-to-end encryption with `vetkd`-wrapped per-sheet
> keys. Single canister for v1; multi-canister deferred to v2+ (see
> `06-deployment-and-costs.md`).

---

## 1. System Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  User's devices                                                 │
│                                                                  │
│  ┌─────────────────────┐   ┌─────────────────────┐                │
│  │ PWA (browser/mobile)│   │ Telegram bot        │                │
│  │ - React + TS        │   │ - user-owned        │                │
│  │ - agent / II client │   │ - user-funded GPT   │                │
│  │ - AES-GCM crypto    │   │ - HTTPS → inbox     │                │
│  └──────────┬──────────┘   └──────────┬──────────┘                │
│             │                        │                            │
│             │ HTTPS / @dfinity/agent │ HTTPS (over II)            │
│             ▼                        ▼                            │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│              Internet Computer (IC)                              │
│                                                                  │
│  ┌─────────────────────┐  ┌──────────────────────┐  ┌──────────┐ │
│  │ Internet Identity   │  │  IOU backend         │  │ Asset    │ │
│  │ (rdmx6-jaaaa-...)   │  │  canister (Motoko)   │  │ canister │ │
│  │ - WebAuthn anchors  │◄─┤  - pair / sheet /    │  │ (PWA)    │ │
│  │ - delegations       │  │    entry state       │  │          │ │
│  │ - vetkd derivation  │  │  - wrapped K_sheet   │  │          │ │
│  └─────────────────────┘  │  - encrypted blobs   │  └──────────┘ │
│         ▲                 │  - rate limits        │               │
│         │ inter-canister  │  - inbox              │               │
│         └─────────────────└──────────────────────┘               │
└──────────────────────────────────────────────────────────────────┘
```

Three deployed canisters: II (provided by IC), the IOU backend (we ship), the
asset canister (we ship, holds the PWA).

The Telegram bot is **not** on-chain. It runs on the user's machine (or a
free-tier host they pay for), uses the user's own GPT API key, and posts
candidate entries to the IOU backend over the public IC agent (signed by the
user's principal). We pay nothing for it; the user pays for GPT and hosting.

---

## 2. Crypto architecture

### 2.1 Per-sheet key lifecycle

```
                ┌─────────────────────────────────────────────┐
                │ User A's browser        User B's browser   │
                │ (WebAuthn + II)         (WebAuthn + II)     │
                └──────────┬──────────────────────┬───────────┘
                           │                      │
              1. Both fetch their vetkd pub key   │
                 for (principal, sheetId)         │
                           │                      │
              2. A generates K_sheet (CSPRNG)     │
                           │                      │
              3. A wraps K_sheet → wrap_A         │
                 A wraps K_sheet → wrap_B         │
                           │                      │
              4. A uploads (wrap_A, wrap_B)       │
                 to canister as part of           │
                 createSheet                      │
                           │                      │
                           ▼                      ▼
              ┌─────────────────────────────────────────────┐
              │ IOU canister (Motoko)                       │
              │ - stores wrap_A, wrap_B                     │
              │ - never sees K_sheet                        │
              └─────────────────────────────────────────────┘
```

### 2.2 Read path
1. User authenticates with II on their device.
2. The agent attaches the user's delegation. `msg.caller` is the user's
   principal.
3. User calls `getSheet(sheetId)`. Canister returns sheet metadata + `wrap_X`
   (the copy sealed to the caller).
4. The user's wallet derives the private key corresponding to their `vetkd`
   public key (this is done locally on the device; the private key never
   leaves it).
5. The browser unwraps `wrap_X` → `K_sheet`.
6. The browser fetches entries for the sheet, decrypts each ciphertext blob
   with `K_sheet` using AES-256-GCM.
7. Renders the history, computes balances, draws charts.

### 2.3 Edit path
Same as read for unwrapping. On edit:
1. The browser decrypts the old entry, modifies the plaintext.
2. Re-encrypts with `K_sheet` (a fresh IV per write).
3. Uploads the new ciphertext. The canister assigns a new `updatedAt` (which
   the browser also encrypts and re-uploads).

### 2.4 Replace member
The leaving member produces a fresh `K_sheet'` and re-wraps it to:
- The **staying** member's `vetkd` pub key (under `(staying_principal, sheetId)`).
- The **new** member's `vetkd` pub key (under `(new_principal, sheetId)`).
- (The old member's wrapped copy is destroyed.)

This requires the leaving member to:
- Re-decrypt all entries (they already had `K_sheet`).
- Re-encrypt each with `K_sheet'`.
- Upload all-new ciphertexts.
- Sign an authorization message (verified by canister).

The new member is given the wrapped `K_sheet'` via the existing pair-invite
flow, except with sheet data instead of empty.

This is the most expensive operation in the system; for a few hundred entries
it takes a few seconds, which is fine.

### 2.5 What the canister sees
For a sheet, the canister stores:
- `sheetId`, `pairId`, `state`, `enabledCurrencies`, `closingWindowDays`.
- A list of entries: each `entryId` paired with `(createdBy, createdAtServer,
  updatedAtServer, ciphertext, iv)`.
- The two wrapped copies of `K_sheet`.

The canister **does not** see plaintext for any of: title, description,
amount, currency, direction, convertTo, the user-encrypted timestamps,
`updatedAt`. It can correlate the volume of activity in a sheet (by counting
entries) but cannot read content.

### 2.6 The `vetkd` integration on the IC
The IC exposes `vetkd_derive_key` as a system API. Both canisters (II and
the user's wallet/agent) coordinate to produce a key bound to
`(caller_principal, canister_id, derivation_context)`. The derivation
context we use is `("iou", sheetId)` so that the same principal gets a
different key per sheet.

Implementation reference (2026): `@dfinity/vetkd` JS package, or direct
management-canister call. We use the JS package in the PWA; the canister
itself doesn't need to call `vetkd` — it just stores the wrapped keys that
the user produces.

---

## 3. Backend Canister

### 3.1 Motoko
Picked over Rust for v1 to keep type definitions readable and on-ramp fast.
If we hit a perf wall (we won't, at this scale), Rust is a v2 port.

### 3.2 State shape
```motoko
stable var users : TrieMap<Principal, UserRecord>;
stable var pairs : TrieMap<PairId, Pair>;
stable var sheets : TrieMap<SheetId, Sheet>;
stable var entries : TrieMap<SheetId, [Entry]>;  // sorted by id
stable var inbox : TrieMap<Principal, [InboxItem]>;
stable var invites : TrieMap<InviteCode, PairId>;
stable var rateLimits : TrieMap<Principal, RateWindow>;
```

All state is in stable memory. `postupgrade` rebuilds in-memory indices.

> ⚠️ **MemoryId discipline (shipped Rust backend).** The backend that ships is
> Rust on `ic-stable-structures` (not the Motoko sketch above), where every
> map/cell lives in a numbered `MemoryId` region that persists across upgrades
> and stores that region's key/value-type header. **Never re-`init` an existing
> `MemoryId` under a changed key/value type** — the stored header is
> incompatible and `init` can trap in `post_upgrade`, failing the in-place
> upgrade (or mis-reading data). When a structure's shape changes, allocate a
> **fresh `MemoryId`** and leave the old one orphaned, or write an explicit
> migration. This bit us in v1.3.2: the entries map switched from a `u64` key
> to a composite `String` key but reused MemoryId 11 — fresh deploys were fine,
> but an in-place upgrade over pre-v1.3.2 data could trap. **Fixed in v1.3.3**
> by moving `ENTRIES` to a fresh `MemoryId` 16 and leaving 11-15 orphaned.
> Trade-off: any v1.3.2 entries on MemoryId 11 are no longer accessible
> (consistent with the pre-v1.3.2 → v1.3.2 data-wipe trade-off). The orphaned
> MemoryIds 11-15 are now off-limits — don't re-`init` them with new
> key/value types either. See the lib.rs stable-state comment block and the
> `entries_lives_on_dedicated_memory_id` / `schema_version_bumped_for_memory_id_move`
> tests for the in-code contract.

### 3.3 Type sketch
```motoko
type UserRecord = {
  principal : Principal;
  wrappedDisplayName : Blob;     // encrypted at rest
  createdAt : Int;
};

type Pair = {
  id : PairId;
  members : [Principal];         // length 1 (pending) or 2 (active)
  inviteCode : ?Text;            // set while pending
  createdAt : Int;
};

type Sheet = {
  id : SheetId;
  pairId : PairId;
  state : { #active | #closed };
  enabledCurrencies : [Text];
  closingWindowDays : Nat;
  lastEntryAt : ?Int;
  wrappedKeyA : ?Blob;           // sealed to member A's vetkd pub key
  wrappedKeyB : ?Blob;           // sealed to member B's vetkd pub key
  memberA : Principal;
  memberB : Principal;
  createdAt : Int;
  closedAt : ?Int;
  closingBalances : ?[{ currency : Text; amountMinor : Nat64;
                        direction : { #debt | #credit } }];
};

type Entry = {
  id : Nat64;
  sheetId : SheetId;
  createdBy : Principal;
  createdAtServer : Int;         // cleartext: canister's timestamp
  updatedAtServer : ?Int;
  ciphertext : Blob;
  iv : Blob;
};

type InboxItem = {
  id : Nat64;
  ciphertext : Blob;
  iv : Blob;
  source : Text;                 // "telegram-bot:<chat-id>" etc.
  createdAt : Int;
};
```

### 3.4 Candid endpoints
```
// auth / user
whoami() : () -> ?Principal;
getMyUser() : () -> ?UserRecord;
setDisplayName(ciphertext : Blob, iv : Blob) : () -> UserRecord;
listMyDevices() : () -> [DeviceInfo];   // fetched from II canister
revokeDevice(delegationId : Text) : () -> ();

// pair
createPair() : () -> { pairId : PairId; inviteCode : Text };
joinPair(inviteCode : Text) : () -> Pair;
getMyPairs() : () -> [Pair];
getPair(pairId : PairId) : () -> ?Pair;
replaceMember(pairId : PairId, newMember : Principal,
              signedAuthOld : Blob, signedAuthNew : Blob) : () -> ();

// sheet
createSheet(req : CreateSheetReq) : () -> Sheet;
getSheet(sheetId : SheetId) : () -> ?Sheet;
getSheetWrappedKey(sheetId : SheetId) : () -> ?Blob;  // returns the copy sealed to caller
addCurrency(sheetId : SheetId, iso : Text) : () -> ();
closeSheet(sheetId : SheetId) : () -> ();
startNewSheet(pairId : PairId, carried : [CarriedBalance]) : () -> Sheet;
listMySheets(opts : ListSheetsOpts) : () -> [SheetSummary];

// entries
addEntry(req : AddEntryReq) : () -> Entry;
editEntry(req : EditEntryReq) : () -> Entry;
listEntries(sheetId : SheetId, cursor : ?Nat64, limit : Nat8) : () -> [Entry];
getEntry(entryId : Nat64) : () -> ?Entry;

// inbox
addInboxItem(ciphertext : Blob, iv : Blob, source : Text) : () -> InboxItem;
listInbox() : () -> [InboxItem];
promoteInboxItem(itemId : Nat64, sheetId : SheetId) : () -> Entry;
dismissInboxItem(itemId : Nat64) : () -> ();

// rates & telemetry
getRateLimits() : () -> RateLimits;     // for UI to display "slow down"
```

### 3.5 Authorization

| Endpoint | Rule |
|----------|------|
| `whoami` | none |
| `getMyUser` | `msg.caller == self.principal` |
| `setDisplayName` | authenticated |
| `listMyDevices` | authenticated, calls II canister |
| `revokeDevice` | authenticated |
| `createPair` / `joinPair` | authenticated |
| `getMyPairs` / `getPair` | member of the pair |
| `replaceMember` | leaving member's signature + new member's signature, both verified by canister |
| `createSheet` | both members of pair have agreed (signed sheet-creation message) |
| `getSheet` / `addCurrency` / `closeSheet` / `startNewSheet` | member of the sheet's pair |
| `addEntry` / `editEntry` | member of the sheet's pair; `editEntry` requires `entry.createdBy == msg.caller` |
| `listEntries` / `getEntry` | member of the sheet's pair |
| `getSheetWrappedKey` | member of the sheet's pair; returns the copy sealed to caller |
| `addInboxItem` | authenticated |
| `listInbox` / `promoteInboxItem` / `dismissInboxItem` | `msg.caller == item.principal` |

### 3.6 Rate limits
A simple sliding window in stable memory, per principal, per endpoint class.
The window resets on read; a class hit returns `RateLimited { retryAfter }`
without trap. Configurable defaults (see spec §4.10).

### 3.7 Replace member flow (canister-side)
- The canister checks both signatures against the principal's public key
  (available via `vetkd` chain-key).
- If valid, the canister re-keys the sheet: it stores new `wrappedKeyA` /
  `wrappedKeyB` from the leaving member's payload, and destroys the old
  copies.
- The new member is added to the pair. The old member is removed.

### 3.8 Cycles
- Single canister, no timers, no heartbeat.
- Cycle top-up is automated via the `cycles-manager` external service in v1.1.
  For v1, manual top-up by the developer via `dfx ledger ... balance` and
  `dfx cycles transfer`.
- Soft alarm at 0.5 SDR remaining; hard alarm at 0.1 SDR.

---

## 4. Frontend (PWA)

### 4.1 Stack
- **Vite + React 18 + TypeScript**.
- `@dfinity/agent`, `@dfinity/auth-client`, `@dfinity/vetkd`.
- `crypto.subtle` for AES-GCM; `tweetnacl`-style libs not needed (WebCrypto
  is fine).
- Plain CSS modules. No Tailwind, no shadcn. v1 ships a single small
  design system in `ui/`.
- `vite-plugin-pwa` to add a manifest + service worker so the app is
  installable to a phone home screen.

### 4.2 Folder layout
```
src/
  app/                # router, providers, PWA registration
  features/
    auth/             # II login, useIdentity, device list
    pair/             # create / join / replace
    sheet/            # create / list / close / start-new
    entries/          # add / edit / list / filter
    inbox/            # Telegram-fed candidate entries
    balances/         # per-currency summary cards
    export/           # local JSON / CSV download
    settings/         # devices, donate ICP, sign out
    crypto/           # vetkd wrap / unwrap, AES-GCM helpers
  ui/                 # shared components, design tokens
  lib/
    candid.ts         # generated declarations
    actor.ts          # authenticated actor factory
    fx.ts             # frankfurter.app fetcher
    format.ts         # currency / date formatting
  styles/
  workers/
    service-worker.ts # offline cache for PWA shell
```

### 4.3 Auth & devices
- On first sign-in: derive `vetkd` pub key for `(caller, derivationContext = "iou-display-name")`, encrypt display name with a key derived from the principal's WebAuthn-bound seed, store ciphertext.
- On every login, request a fresh delegation from II. The agent stores it
  in `IndexedDB`.
- The "My devices" page calls `listMyDevices()`, which does an
  inter-canister read of the II canister to enumerate active delegations.
  (In v1, we may simply show "this device" and a "sign out" button; the
  full multi-device view is v1.1.)

### 4.4 Crypto helpers (TypeScript)
- `wrapSheetKey(K_sheet, vetkdPub)` — uses the IC vetkd system to wrap.
- `unwrapSheetKey(wrap, vetkdPriv)` — local only.
- `encryptField(plaintext, K_sheet)` → `{ ciphertext, iv }`.
- `decryptField({ ciphertext, iv }, K_sheet)` → `plaintext`.
- `encryptEntry(entry, K_sheet)` and the reverse.

These are in `src/features/crypto/`. They are unit-tested in `tests/`.

### 4.5 FX integration
- `lib/fx.ts` exposes `fetchRate(from, to, date)`. Calls
  `https://api.frankfurter.app/{date}?from={from}&to={to}`.
- Caches per (date, from, to) in `IndexedDB` for 24h.
- Returns `{ rate, fetchedAt, source: "frankfurter" }`.
- On network failure, throws a typed error that the form converts to
  "Provider unavailable, please enter the rate manually".

### 4.6 State
- v1: small per-page state with `useState` / `useReducer`. No Redux, no
  React Query. The data volume is too small and the state too local.

### 4.7 PWA
- `vite-plugin-pwa` registers a service worker.
- Caches the app shell and the last N entries per active sheet for offline
  view (read-only; can't add offline in v1).
- The PWA is installable on iOS Safari and Android Chrome.

### 4.8 Telegram bot (separate repo, not on ICP)
- A small Node script the user runs locally or on a free host. We
  **do not** deploy it; the user does.
- The bot uses the user's `TELEGRAM_BOT_TOKEN` and `OPENAI_API_KEY`.
- The bot uses the user's **own** IOU principal (the user runs `pnpm auth`
  in the bot repo to log in with II and produce a delegation file).
- The bot listens for image messages, calls GPT-4o-mini vision with a
  prompt that produces the candidate-entry JSON, encrypts it with the
  user's principal-bound inbox key, and posts to `addInboxItem`.
- The PWA surfaces the inbox item; the user reviews and either promotes
  it to a sheet or dismisses.
- **Cost to us: $0.** Cost to the user: their OpenAI usage + their bot
  hosting (or just runs it on their laptop).

This is the lowest-cost path that meets the "image → entry" use case
without us paying for inference or holding a third-party API key.

### 4.9 Local backup & export
- "Export" button in settings → decrypts active sheet on the device, formats
  as JSON or CSV, triggers a browser download. No canister roundtrip beyond
  fetching entries.
- v1.1: Google Sheets export, done by uploading a CSV the user can open in
  Google Sheets (or by using the user's Google OAuth token to call the
  Sheets API — TBD based on user preference).

---

## 5. Data model relationships (cleartext-only view)

```
   ┌────────┐ N   N ┌──────┐ 1   N ┌──────────┐
   │  User  │───────│ Pair │───────│  Sheet   │
   └────────┘       └──────┘       └──────────┘
                                          │ 1
                                          │
                                          ▼ N
                                    ┌──────────┐
                                    │  Entry   │   (ciphertext)
                                    └──────────┘

   ┌────────┐ 1   N ┌────────────┐
   │  User  │───────│ InboxItem  │   (ciphertext; promotes → Entry)
   └────────┘       └────────────┘
```

A pair holds many sheets over its lifetime; a sheet holds many entries; a
user has its own inbox.

---

## 6. Single vs multi-canister

(Detailed cost math is in `06-deployment-and-costs.md`.)

**v1: single backend canister.** This is the right answer at our scale and
keeps cross-canister call costs off the hot path.

**v2+ candidates (only if scale demands):**
- **Shard by `pairId`** when active-pair count > ~50K. Each shard is a
  separate canister, fronted by a router.
- **Sidecar** for image storage if we ever start storing receipts on the
  asset canister (we don't in v1).
- **Sidecar** for the FX oracle if we ever move FX to the canister side
  (we don't in v1).

---

## 7. Deployment

### 7.1 Local dev
- `dfx start --background` (with the `vetkd` system API available; the
  local replica has it as of `dfx` 0.20+).
- `pnpm deploy:local` runs `dfx deploy` for the backend and the asset
  canister, then `vite build && dfx deploy asset_canister`.
- Internet Identity in local mode uses the local II canister
  (`rdmx6-jaaaa-aaaaa-aaadq-cai` analogue).

### 7.2 Mainnet
- `dfx deploy --network ic` from CI.
- Cycle top-up: manual for v1, automated (via `cycles-manager` or a small
  cron canister) for v1.1.
- Asset canister URL is the public URL of the PWA.
- Domain: optional custom domain via `dfx` canister-controller mapping in
  v1.1; v1 uses the `*.icp0.io` URL.

---

## 8. Open architecture questions (now substantially smaller)

- Q1: Where does the user anchor their II? (Default: WebAuthn on each
  device; recovery via II's built-in flow. No special handling needed.)
- Q2: Do we want per-sheet printable recovery keys in v1, or defer to v1.1?
  (Default: defer.)
- Q3: Telegram bot is "bring your own bot" — do we want a one-click deploy
  to a free-tier host in v1.1? (Default: ship a Dockerfile and a clear
  README; no one-click deploy.)
