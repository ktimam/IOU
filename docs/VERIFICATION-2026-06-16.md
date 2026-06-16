# IOU — Fix Verification (2026-06-16, post-fix)

> Follow-up to [REVIEW-2026-06-16.md](REVIEW-2026-06-16.md) and
> [SECURITY-MEMO-2026-06-16.md](SECURITY-MEMO-2026-06-16.md). This doc verifies the fixes
> committed in **b06f740** ("v1.3.0: Security audit fixes (V1-V8 + I1, I5)") against the actual
> code. **Read-only** — no code changed. Every high-severity verdict was re-checked by hand;
> finding-level checks were run by a 12-agent verification pass.

## Verdict

The core security fixes (**V1, V2, V3, V5, V6, V8**) are **correct and well-implemented**. But the
stable-storage migration (**V4/I1**) introduced **one CRITICAL data-corruption regression** and the
`raw_rand` async conversion (**V3**) introduced **two HIGH concurrency regressions**. Several
frontend findings were out of the commit's scope and remain open.

**Build status:** `cargo build` (wasm), `clippy -D warnings`, and `vitest` (25) all **pass** — but
the green build does **not** exercise multiple sheets or concurrent calls, which is exactly why the
regressions below slip through.

## Per-finding status

| ID | Finding | Status |
|---|---|---|
| V1 | Replace-member signature authenticated nothing | ✅ **Fixed** — `register_recovery_pubkey` stores a per-principal key; `verify_replace_signature` (lib.rs:1584) verifies against `RECOVERY_KEYS[leaving_principal]`, ignores `signer_pubkey`, traps if unregistered |
| V2 | Replay protection claimed but absent | ✅ **Fixed** — `CONSUMED_NONCES` checked (lib.rs:1470) + inserted (1514); `ts_ms` freshness ±5min with correct ms→ns (1474-1481) |
| V3 | Predictable invite codes / IDs | ✅ **Fixed** — `raw_rand` (lib.rs:459, 494). ⚠️ *but the async conversion caused R2/R3 below* |
| V4 / I1 | No stable storage / lost on upgrade | 🔴 **Regressed** — most maps correctly migrated, but **entry storage is broken** (R1 below) |
| V5 | `now_id()` collisions / no existence check | ✅ **Fixed** for id-collision (raw_rand + check at lib.rs:706). ⚠️ *membership invariant now has a TOCTOU — R2/R3* |
| V6 | `vetkd_public_key` cycles drain | ✅ **Fixed** — master pubkey cached (`VETKD_PUBKEY_CACHE`, MemoryId 9) |
| V7 | `0xff` delimiter fragility | ☑️ **Deferred (ok)** — kept as `0xff`; safe (pair_id is UTF-8) and client `canonicalReplaceBytes` still byte-matches |
| V8 | Currency normalization drift | ✅ **Fixed** — `create_sheet` now normalizes ISO codes |
| I5 | `createActor` un-awaited `fetchRootKey` | ❌ **Not addressed** — commit claims "I5" but `declarations.ts:195-214 createActor` is unchanged (still synchronous, fires `fetchRootKey()` un-awaited). Changelog overstates scope |
| I2 | Dev sign-in button shown in prod | ❌ **Not addressed** — `SignIn.tsx:32-45` still renders it unconditionally |
| I3 | `signOut()` no `AuthClient.logout()` | ❌ **Not addressed** — `AuthProvider.tsx:109-117` unchanged |
| I4 | Inline local II URL | ❌ **Not addressed** — `AuthProvider.tsx:78` still inlines `http://127.0.0.1:4943` |
| I6 | `smoke-reset.sh` hardening | ⚠️ **Partial** — has `set -e` but not `set -euo pipefail` / no `command -v dfx` guard |
| V9 | Plaintext client secrets at rest | ❌ **Not addressed** (deferred) — mnemonic still plaintext in IndexedDB; `mnemonic.ts:32` "v1.1.x will encrypt it" TODO now stale at v1.3.0 |

## 🔴 New regressions introduced by the fixes

### R1 (CRITICAL) — entry storage corrupts/leaks across sheets
**`src/lib.rs:339-358` (`sheet_entries_id`), `:1052-1060` (`next_entry_id`), `:1134-1135` (`add_entry`), `:1196` (`get_entry`), `:1211-1214` (`list_entries`)**

The V4 migration shards entries into only **4 memory regions**: `sheet_entries_id()` returns
`11 + (h % 4)` unconditionally. Its own comment describes a "check if the slot is free, else
allocate a fresh one (from `SHEET_ENTRIES_IDS` starting at 16)" scheme that is **not implemented** —
`SHEET_ENTRIES_IDS` (MemoryId 15) is initialized but never read or incremented. Entry ids come from
`next_entry_id`, which is **per-sheet, starting at 1**. Consequences for any two sheets hashing to
the same shard (~25% per pair; **guaranteed once >4 sheets exist**):

- **Data loss** — `add_entry` does `entries_map.insert(entry.id, ...)`; sheet B's entry id=1 silently
  **overwrites** sheet A's entry id=1.
- **Cross-sheet / cross-pair leak** — `list_entries`/`get_entry` read the shared region with **no
  `sheet_id` filter**, so one pair's members receive another pair's entries. (The blobs are
  E2E-encrypted so they can't be decrypted, but cleartext metadata — `created_by`, timestamps,
  `sheet_id` — leaks, and the functional corruption is real.)

This is arguably worse than the upgrade-data-loss bug V4 was meant to fix, because it corrupts data
during normal operation without any upgrade.

**Fix:** replace the per-shard maps with **one** `StableBTreeMap` keyed by a composite
`(sheet_id, entry_id)` (e.g. a tuple `Storable` key, or `format!("{sheet_id}:{entry_id:020}")`),
and enumerate a sheet's entries with a **range scan over the `sheet_id` prefix** in `list_entries`.

### R2 (HIGH) — async TOCTOU breaks "one active pair per principal"
**`src/lib.rs:687-718`**

`create_pair` became `async` (for `raw_rand`). The "already in an active pair" guard runs at
lib.rs:692-698, then there are **two `await` points** (`now_id().await` 699, `gen_invite_code().await`
700) before the insert at 717. On the IC an inter-canister `await` yields the canister to other
ingress messages, so two `create_pair` calls from the same caller can **both** pass the membership
check before either inserts → the user ends up in **two active pairs**. The V5 existence-check at
706 only guards id collision, not membership.

**Fix:** generate randomness **first** (await `raw_rand` at the top), then do the membership check
**and** the insert in a single synchronous `PAIRS.with` block with no `await` in between.

### R3 (HIGH) — same TOCTOU in `create_sheet`
**`src/lib.rs:828-899`** (and `start_new_sheet` at ~1021, which delegates)

Identical pattern: the "only one active sheet per pair" guard (868-877) runs before `now_id().await`
(878) and the insert (899) → two concurrent calls can create two active sheets for one pair.
**Fix:** same as R2 — randomness first, then atomic check+insert.

## Other notes

- **Invite codes** are now high-entropy (`raw_rand`) but remain **unbound bearer tokens** — `create_pair`
  stores the pending slot as `Principal::anonymous()` and `join_pair` admits any caller with the code
  (lib.rs:712, 724-753). Optional defense-in-depth: add `invitee: opt principal` + single-use TTL.
- **0 backend cargo tests** still — adding PocketIC integration tests that create **≥5 sheets** and
  fire **concurrent** create calls would have caught R1-R3.

## Priority actions
1. **R1 (critical):** rewrite entry storage to a single composite-keyed map — before any multi-sheet use.
2. **R2 / R3 (high):** fix both async TOCTOUs (randomness first, then atomic check+insert).
3. I2 / I3 / I4 (frontend auth) and V9 (encrypt secrets at rest) — still open from the original audit.
4. Correct the changelog's "I5" claim (it was not actually fixed).
