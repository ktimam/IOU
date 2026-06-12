# IOU — Security & Privacy (v2)

> Threat model, encryption architecture, authorization, and the
> guarantees we make to users. The product is small, so the security
> model is small — but **explicit**, because shipping to mainnet means
> the data is on a public chain and there's no take-back.

---

## 1. Threat model

### 1.1 What we trust
- The IC's boundary nodes (TLS termination, request routing).
- The IC's consensus and the security of the canister's code and storage.
- Internet Identity's WebAuthn-based authentication and delegation model.
- The IC's `vetkd` system API (verifiable encryption of threshold keys).
- The WebCrypto API in the user's browser.

### 1.2 What we don't trust
- The frontend running in the user's browser (a user could run a modified client).
- The other party in the pair (a shared ledger implies mutual distrust on
  arithmetic).
- The OS / device the user is currently on.
- **The canister's node operator** — by design. They can see
  cleartext pair/sheet/entry IDs and principals; they cannot see any
  sensitive field.

### 1.3 Adversaries we design for
| Adversary | Goal | Capability |
|-----------|------|------------|
| **Canister node operator** | Read other people's entries | Full read access to stable memory; we defend by storing only ciphertext |
| **Curious network observer** | Identify users, infer amount of activity | Sees encrypted traffic to boundary nodes only; metadata leakage limited by II's session model |
| **Compromised browser** | Read entries of an active session | Limited to the current principal's sessions; cannot decrypt other sheets |
| **Partner gone rogue** | Falsify entries, deny the other party | Can call canister endpoints as themselves; cannot impersonate the other principal; can mark entries for the other party's POV |
| **Stolen device, unlocked** | Read entries, create entries | Same as "compromised browser" |
| **Stolen device, locked** | None — II requires WebAuthn unlock | None |

### 1.4 What we explicitly accept
- **Both members losing access = data loss.** This is a property of the
  threat model. v1.1 adds an opt-in printable recovery key.
- **A determined nation-state with subpoena access to the canister's
  storage** would get ciphertext and metadata (entry counts, principal
  IDs, sheet IDs, when entries were created). They cannot read content.
- **II's recovery flow** is owned by the DFINITY Foundation, not by us.
  If II is compromised at the root, every II-anchored identity on the IC
  is at risk. We don't mitigate this; we just note it.

### 1.5 Out of scope (v1)
- Side-channel attacks on the user's device.
- Differential privacy over entry counts (the operator can see "this
  sheet has 87 entries" but not what they say).
- Resistance to a malicious II canister (out of our control).

---

## 2. Authentication

- **Mechanism:** Internet Identity (II). No passwords, no email, no
  "remember me" beyond what the agent stores in IndexedDB.
- **Anchor:** the II canister returns a `Delegation` for the user's
  principal after WebAuthn verification; the agent attaches this to
  every canister call.
- **Principal derivation:** the canister extracts `msg.caller` and
  uses it as the user id.
- **Session length:** 30 days (we ask II for a 30-day delegation). The
  user can sign out per-device or everywhere at any time.
- **Sign out:** clears the local `authClient` storage and calls II to
  revoke the specific delegation.

---

## 3. Encryption at rest

This is the heart of the system.

### 3.1 What's stored cleartext
- `pairId`, `sheetId`, `entryId` — needed for indexing and authz.
- `createdBy` principal — needed for authz (only the creator can edit).
- Server-side `createdAtServer` / `updatedAtServer` — needed for
  ordering and rate limiting.
- Sheet-level: `enabledCurrencies`, `closingWindowDays`, `state`,
  `lastEntryAt`, `closingBalances` (if closed).

### 3.2 What's stored encrypted
For each entry, an AES-256-GCM ciphertext blob sealed under the
per-sheet symmetric key, containing:
- `createdAt` (user-meaningful timestamp)
- `updatedAt` (user-meaningful)
- `direction` (debt/credit)
- `title`
- `description`
- `currency`
- `amount`
- `convertTo` (target currency, rate, rateSource, rateFetchedAt)

For each sheet:
- `wrappedKeyA` — sealed to user A's `vetkd` public key
- `wrappedKeyB` — sealed to user B's `vetkd` public key

### 3.3 The per-sheet key model
- `K_sheet` is a 256-bit symmetric key, generated client-side using
  `crypto.getRandomValues` when the sheet is created.
- `K_sheet` is wrapped using IC `vetkd`. The IC exposes
  `vetkd_derive_key` which produces a public key bound to a
  `(caller_principal, derivation_context)` pair. The user's wallet
  derives the corresponding private key locally.
- The user wraps `K_sheet` under their own `vetkd` public key to
  produce `wrap_self`, and also wraps it under the partner's `vetkd`
  public key to produce `wrap_partner`. (Both public keys are fetched
  by querying the IC.)
- Both wrapped copies are uploaded to the canister. The canister
  never sees the unwrapped `K_sheet`.

### 3.4 Read path
1. User authenticates with II on their device.
2. `getSheetWrappedKey(sheetId)` returns the copy sealed to the caller.
3. The user's wallet derives the private key corresponding to their
   `vetkd` public key (locally).
4. The browser unwraps → `K_sheet`.
5. `listEntries(sheetId)` returns the ciphertext blobs (plus cleartext
   metadata). The browser decrypts each blob.
6. Renders.

### 3.5 Edit path
Same as read for unwrapping. On edit:
1. Decrypt the old entry.
2. Modify plaintext.
3. Re-encrypt with a fresh IV; the canister stores the new ciphertext
   and bumps `updatedAtServer` (cleartext).
4. The `updatedAt` (user-meaningful) is part of the new ciphertext.

### 3.6 Replace member
The leaving member produces a fresh `K_sheet'` and re-wraps to:
- The **staying** member's `vetkd` public key.
- The **new** member's `vetkd` public key.

This requires the leaving member to:
- Decrypt all entries with old `K_sheet`.
- Re-encrypt all entries with `K_sheet'`.
- Sign an authorization message (verified server-side).

The new member is given access via the standard pair-invite flow.

### 3.7 Why `vetkd`
`vetkd` is the only on-chain primitive that:
- Lets the canister produce a public key derived from the chain key,
  with a transcript binding it to a specific `(principal, context)` pair.
- Lets the user's wallet derive the corresponding private key locally
  (the private key never leaves the device).
- Has a stable API on the IC mainnet as of 2026.

It avoids the two failure modes of the alternatives:
- **Passphrases** are a UX nightmare and the user will choose bad ones.
- **Pure client-side keys** (no threshold) make the developer the
  single point of failure for recovery.

### 3.8 Recovery (v1.1 candidate, not v1)
A printable "recovery key" is a third wrapped copy of `K_sheet`,
sealed to a recovery key derived from a random 256-bit value the user
prints and stores offline. The recovery key is itself derived at
recovery time and used to unwrap `K_sheet`. **In v1, this is not
implemented.** The threat-model property holds: losing both members
= data loss, and we document that loudly.

### 3.9 What we never do
- Never store the II anchor's WebAuthn credential or biometric data.
- Never store secrets in the asset canister (the frontend).
- Never log raw `title` / `description` / `amount` to console or to
  a third-party service.
- Never call out to the FX API server-side.
- Never call out to any external service that could log decrypted data.
- Never use a custom crypto primitive. AES-GCM-256 + IC `vetkd` only.

---

## 4. Authorization (server-side, every endpoint)

| Endpoint | Authorization check |
|----------|---------------------|
| `whoami` | None |
| `getMyUser` | `msg.caller` |
| `setDisplayName` | Authenticated |
| `listMyDevices` | Authenticated; calls II canister |
| `revokeDevice` | Authenticated; matches the user's II delegation |
| `createPair` | Authenticated |
| `joinPair(code)` | Authenticated; code valid, unused, unexpired |
| `getMyPairs` / `getPair` | Member of the pair |
| `replaceMember` | Leaving member's signature + new member's signature, both verified by canister |
| `createSheet` | Both members of pair authorized the sheet creation (signed messages) |
| `getSheet` / `addCurrency` / `closeSheet` / `startNewSheet` | Member of the sheet's pair |
| `addEntry` | Member of the sheet's pair; rate limit not exceeded |
| `editEntry` | `entry.createdBy == msg.caller`; rate limit not exceeded |
| `listEntries` / `getEntry` | Member of the sheet's pair |
| `getSheetWrappedKey` | Member of the sheet's pair; returns the copy sealed to caller |
| `addInboxItem` | Authenticated; rate limit not exceeded |
| `listInbox` | `msg.caller == item.principal` |
| `promoteInboxItem` | `msg.caller == item.principal`; rate limit not exceeded |
| `dismissInboxItem` | `msg.caller == item.principal` |

All checks run **server-side**. The frontend may hide buttons the user
can't use, but that's UX, not security.

---

## 5. Input validation (server-side only)

| Field | Rule |
|-------|------|
| `displayName` (ciphertext) | 1..=32 bytes plaintext (post-decryption) |
| `title` (ciphertext) | 1..=120 bytes plaintext |
| `description` (ciphertext) | 0..=2000 bytes plaintext |
| `currency` (ciphertext) | regex `^[A-Z]{3}$` plaintext |
| `amount` (ciphertext) | > 0, fits in `nat64` minor units plaintext |
| `direction` (ciphertext) | enum: `debt` or `credit` |
| `convertTo.targetCurrency` | regex `^[A-Z]{3}$`; must be in the sheet's enabled list and ≠ entry currency |
| `convertTo.rate` | > 0 finite number |
| `convertTo.rateSource` | one of `"frankfurter"`, `"user"`, `"manual:<provider>"` |
| `closingWindowDays` | 30..=730 |
| `inviteCode` | 8 chars, base32 (no ambiguous glyphs) |
| Per-sheet enabled currencies | ≤ 16 |

---

## 6. Rate limits (server-enforced)

Sliding window, per principal, per endpoint class:

| Endpoint | Limit |
|----------|-------|
| `addEntry` | 60 / min |
| `editEntry` | 30 / min |
| `createPair` / `joinPair` / `replaceMember` | 5 / hour |
| `addInboxItem` | 120 / min |
| `addCurrency` | 10 / hour |

The canister returns `RateLimited { retryAfter }` as a result variant,
never a trap. The PWA reads `getRateLimits()` to display a "slow down"
hint before the user hits the limit.

---

## 7. Common canister traps to avoid

- **Panic vs. return result:** all "expected" failures (bad invite
  code, wrong principal, etc.) come back as result variants. Reserve
  `throw` / trap for truly exceptional conditions.
- **Stable memory growth:** the only unbounded data structures are
  entries per sheet. Rate limits (above) bound the write side. Read
  paths use pagination.
- **Time-of-check / time-of-use:** `getSheet` + `addEntry` are
  separate calls. In v1 we accept the race; a 2-user app where both
  members are honest won't see it. v1.1 may add a nonces cache for
  close-sheet operations.
- **Upgrade behavior:** `preupgrade` snapshots stable data;
  `postupgrade` re-validates. The data shape is append-only, so a
  v1→v2 migration is a `forEach` rewrite, not a copy.
- **Side-channel on ciphertext length:** an entry's ciphertext length
  reveals the plaintext length (because AES-GCM ciphertext length =
  plaintext length + 16). We accept this; for typical titles and
  descriptions it's not a meaningful leak.

---

## 8. Privacy guarantees we make to users

1. **No emails or contact info collected.** No profile photos. No
   device fingerprints.
2. **No analytics, no third-party scripts** in the asset canister.
3. **No data shared with other canisters** — except II (for
   authentication and device listing) and a single outgoing call to
   fetch delegation metadata. The IOU canister does not call the FX
   API; that's done in the user's browser.
4. **No telemetry of titles, amounts, or descriptions** — not
   client-side, not server-side.
5. **Export is member-only** — only members of the pair can export
   their sheet. The export runs on the user's device after decryption.
6. **The canister cannot read your data.** This is a verifiable claim:
   we publish the source code, and the canister's behavior depends only
   on public IC APIs.
7. **Closing a sheet is permanent** — once closed, it can't be reopened
   (closing is a one-way state transition). Closed sheets remain
   readable by their members.
8. **No deletion endpoint exists for entries** — entries are
   append-only / edit-only. The audit trail is the point.

---

## 9. Open security questions

- Q-S1: Should the dev claim "we can't read your data" be backed by a
  public third-party audit? (Default: yes, post-mainnet, before any
  real users.)
- Q-S2: Do we want rate limits per (principal, IP) instead of just per
  principal? (Default: no — II doesn't expose IP; principal-only is
  good enough at 2 users per sheet.)
- Q-S3: Should we ship the printable recovery key in v1, given that
  losing both members is unrecoverable? (Default: defer to v1.1; v1
  ships a clear "if you lose both devices, the data is gone" notice in
  the settings page.)
