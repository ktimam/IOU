# IOU — Security Memo (2026-06-16)

> Advisory security review. **No code was changed.** Findings were verified against source
> (`src/lib.rs`, `src/features/replaceMember/replaceMember.ts`) and cross-checked by an
> independent adversarial pass. Companion: [REVIEW-2026-06-16.md](REVIEW-2026-06-16.md).
>
> Each item lists: severity, location, what's wrong, a concrete exploit/repro, and a fix
> sketch (illustrative — not applied).

## Severity summary

| # | Severity | Title | Area |
|---|---|---|---|
| **V1** | **High** | Replace-member signature authenticates nothing — signing key is unbound and unregistered | Auth bypass |
| **V2** | **High** | Advertised replay protection for replace-member is not implemented | Replay |
| **V3** | **High** | Invite codes & entity IDs are predictable (time-seeded, no `raw_rand`) | Predictable secrets |
| **V4** | **High** | All state is in-memory with no upgrade hooks → data lost on canister upgrade | Data durability |
| V5 | Low | `now_id()` ID collisions; no existence check before insert | Correctness |
| V6 | Low | `vetkd_public_key` is an anonymous-callable `update` (cycles drain) | DoS / cost |
| V7 | Low | `canonical_replace_bytes` uses `0xff` delimiters (fragile if a field becomes binary) | Crypto hygiene |
| V8 | Low | `add_currency` uppercases ISO codes but `create_sheet` does not → duplicate currencies | Validation drift |
| V9 | Med | Secret material stored in plaintext at rest on the client | Client secret storage |

---

## V1 — Replace-member signature authenticates nothing (High)

**Location:** `src/lib.rs:1068-1157` (`submit_replace_member`), `:1177-1192`
(`verify_replace_signature`); client `src/features/replaceMember/replaceMember.ts:43-71`.

**What's wrong.** The replace-member flow is designed so the *leaving* member (Alice) signs a
`ReplaceRequest` offline and the *staying* member (Bob) submits it. The canister is supposed to
prove "Alice authorized her own replacement." It does not:

1. `verify_replace_signature` verifies `signed.signature` against `signed.signer_pubkey` — a
   value taken **verbatim from the request that Bob submits**. Nothing ties `signer_pubkey` to
   `req.leaving_principal`. No principal is derived from the key; no comparison is made.
2. There is **no on-chain registry** mapping a principal to a signing key (a grep of `lib.rs`
   and the `.did` finds no `register_*`/recovery-key method — `signer_pubkey` only appears as a
   struct field, a length check, and the verify call).
3. The client signs with a **random app-local Ed25519 keypair persisted in `localStorage`**
   (`iou:replace:ed25519:v1`, seed from `crypto.getRandomValues`, `replaceMember.ts:50-71`) —
   **not** Alice's II delegation key as the canister comment at `lib.rs:1031` claims. So there
   isn't even an intended cryptographic link to Alice's identity.

Net: the signature proves only "whoever generated `signer_pubkey` signed these bytes," and Bob
generates `signer_pubkey`. The only real gate is the membership check.

**Exploit / repro.** Bob (a legitimate member of a pair with Alice) wants to evict Alice and seize
both slots without her consent:

1. Build `ReplaceRequest { pair_id, leaving_principal = Alice, new_principal = Bob2, ts_ms,
   nonce }` where `Bob2` is a second principal Bob controls (not currently a member).
2. Generate a fresh Ed25519 keypair `(sk_x, pk_x)`.
3. `signature = sign(sk_x, canonical_replace_bytes(req))`.
4. Call `submit_replace_member({ request, signature, signer_pubkey: pk_x })` authenticated as Bob.
5. All checks pass (Alice is a member ✓, caller Bob is a member ✓, caller ≠ leaving ✓, Bob2 not a
   member ✓) and the signature verifies under `pk_x`. **Alice is removed; Bob2 takes her slot; any
   active sheet is force-closed (`lib.rs:1148-1151`).**

**Impact (scoped fairly).** Bob already had access to the sheets he's a member of (E2E-encrypted,
Bob holds those keys), so this is not key exfiltration. The harm is **unilateral membership
takeover / lockout**: Bob removes Alice's future access and substitutes a principal he controls,
with zero authorization from Alice — defeating the entire purpose of the offline-signature scheme.

**Fix sketch.** Establish a registered, principal-bound signing key and verify against it:

- Add `register_recovery_pubkey(pubkey: vec nat8)` (II-authenticated) that stores
  `principal → pubkey` in a (stable) map at setup/join time.
- In `submit_replace_member`, ignore any caller-supplied `signer_pubkey`; look up the stored
  pubkey for `req.leaving_principal` and verify the signature against **that**. Reject if the
  leaving member never registered one.
- Alternatively (harder), require a verifiable II delegation chain proving the signer speaks for
  `leaving_principal`. The registered-recovery-key approach is simpler and robust.

Until fixed, treat replace-member as "any member can replace the other member unilaterally."

---

## V2 — Replay protection is advertised but not implemented (High)

**Location:** `src/lib.rs:1042-1043` (comment), `:1048-1157` (`submit_replace_member`).

**What's wrong.** The header comment promises "The `(pair_id, leaving_principal)` pair is unique
(replay protection)" and `ReplaceRequest` carries `ts_ms` + a 32-byte `nonce`. But the nonce is
only length-checked (`:1079`), never stored or compared against a seen-set, and `ts_ms` is never
validated for freshness. There is no nonce store anywhere in the file.

**Exploit / repro.** A captured `SignedReplaceRequest` remains valid indefinitely. If pair state is
ever restored to a shape matching the request (e.g. after the V4 upgrade wipe re-creates a pair, or
a membership is reverted), the same signed payload can be replayed to re-apply the change. Combined
with V1 (Bob controls the whole payload anyway), V2 mainly matters once V1 is fixed — at which point
replay of a genuine Alice-signed request becomes the next attack.

**Fix sketch.**
- Maintain a stable set of consumed identifiers (e.g. `(pair_id, nonce)` or the full request hash);
  reject duplicates.
- Validate `ts_ms` against `ic_cdk::api::time()` within a bounded window (e.g. ±5 min) so signed
  requests expire.

---

## V3 — Predictable invite codes and IDs (High)

**Location:** `src/lib.rs:137-165` (`gen_invite_code`), `:173-181` (`now_id`), `:384-411`
(`join_pair`).

**What's wrong.** `gen_invite_code()` derives an 8-char code purely from `ic_cdk::api::time()` fed
through a deterministic LCG (the comment at `:140-141` self-identifies it as a `raw_rand`
placeholder). `now_id()` likewise hashes `time() + caller`. Both are predictable to anyone who can
estimate the creation timestamp. `join_pair` (`:384-411`) gates becoming member B **solely on
knowing the invite code** — it authenticates the joiner but does not bind the invite to a specific
invitee.

**Exploit / repro.** An attacker who learns the approximate pair-creation time (e.g. from a shared
link timestamp, a screenshot, or side-channel) reconstructs the LCG seed space. The effective
entropy collapses from the nominal 32⁸ to the attacker's uncertainty about the nanosecond
timestamp; narrowing it to a millisecond leaves ~10⁶ candidates — enumerable offline, then sprayed
at `join_pair` to hijack the pending pair before the intended partner joins.

**Fix sketch.** Use `ic_cdk::management_canister::raw_rand()` for invite codes and entity IDs (it's
async; collect entropy in an `init`/timer-seeded CSPRNG pool, or make the create path async). Until
then, treat invite codes as guessable. Optionally bind the invite to the intended principal.

---

## V4 — No stable storage / no upgrade hooks → data lost on upgrade (High, correctness)

**Location:** `src/lib.rs:16` (misleading comment), `:102-121`, `:706-713`, `:943-950`.

**What's wrong.** `USERS`, `CONFIG`, `PAIRS`, `SHEETS`, `INVITES`, `ENTRY_COUNTERS`, `ENTRIES`, and
`VETKD_KEY_NAME` are all plain `thread_local! RefCell<BTreeMap>` (verified: **no
`ic-stable-structures` dependency in `Cargo.toml`, no `#[pre_upgrade]`/`#[post_upgrade]`
functions**). The comment at line 16 ("Storage: stable BTreeMaps") and line 114 ("Phase 2: pair and
sheet state. Stable across upgrades.") are false.

**Exploit / repro.** Any in-place `dfx canister install --mode upgrade` (or `dfx deploy` over an
existing canister) drops every pair, sheet, entry, invite, counter, and user record. (`post_upgrade`
is even listed in the `inspect_message` whitelist, but no such function exists.) This is a
data-durability bug, not an attacker exploit — but it is a production-critical one and the comments
actively mislead.

**Fix sketch.** Adopt the ICTemplate pattern: `MemoryManager` + `StableBTreeMap`/`StableCell` for
all persistent maps, **or** add `#[pre_upgrade]`/`#[post_upgrade]` that serialize/deserialize the
in-memory maps to a stable region. The template's `src/lib.rs` is a correct reference. At minimum,
correct the comments so the storage guarantee isn't overstated.

---

## V5-V8 — Lower-severity

- **V5 — `now_id()` collisions (Low).** `now_id()` is constant within a message tick; two
  `create_pair`/`create_sheet` calls resolving to the same `time()` produce identical IDs, and
  there is **no existence check before `insert`** (`lib.rs:378`, `:543`), so the later record
  silently overwrites the earlier. Fix with `raw_rand` (V3) and/or a monotonic counter, plus a
  pre-insert existence check.
- **V6 — `vetkd_public_key` anonymous cycles drain (Low).** `lib.rs:965-977` is an
  `#[ic_cdk::update]` deliberately not in `require_auth_methods`, so anonymous callers trigger an
  inter-canister management call on every invocation. The key is constant per canister+context —
  cache it in a `thread_local` after first derivation and serve from there (and consider whether it
  can become a query once cached).
- **V7 — `0xff` delimiter fragility (Low).** `canonical_replace_bytes` (`lib.rs:1162-1175`)
  separates fields with a single `0xff` byte. Safe today because `pair_id` is UTF-8 Text (a `0xff`
  byte can't appear), but the scheme relies on that invariant. Prefer length-prefixed encoding
  before reusing this as a generic primitive.
- **V8 — currency normalization drift (Low).** `add_currency` (`lib.rs:603-631`) uppercases ISO
  codes; `create_sheet` (`lib.rs:497-501`) stores them verbatim. A sheet created with `["usd"]`
  then `add_currency("USD")` yields both — duplicate logical currencies consuming two of the 16
  slots. Normalize in one shared helper used by all writers.

## V9 — Plaintext secret material at rest on the client (Med)

**Location:** `src/features/recovery/mnemonic.ts:32,42`;
`src/features/replaceMember/replaceMember.ts:67-73`; dev paths in `devVetkd.ts` / `AuthProvider`.

**What's wrong.** The 24-word BIP-39 recovery phrase is stored unencrypted in IndexedDB (the file's
own TODO at `:32` says "v1.1.x will encrypt it"); the 32-byte Ed25519 replace-member seed is stored
as a plain JSON array in `localStorage`; dev keypairs (P-256 JWK, Secp256k1 identity) are also
plaintext in `localStorage`. The dev paths are acceptable (dev-only, gated), but the recovery
mnemonic and replace seed are production secrets.

**Fix sketch.** Route secret-at-rest material through `mobileSecureStorage` (Keystore/Keychain) on
native; on web, encrypt under a user-derived wrapping key or clearly document the threat. Don't ship
recovery secrets in plaintext.

---

## Suggested remediation order

1. **V4** (data durability — affects every user the moment you upgrade).
2. **V1 + V2** (replace-member auth + replay — fix together; register principal-bound keys).
3. **V3** (predictable invites — move to `raw_rand`).
4. **V9** (encrypt client secrets at rest), then V5-V8 cleanups.
