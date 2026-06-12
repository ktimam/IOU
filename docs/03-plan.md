# IOU — Build Plan (v2)

> Plan-then-execute roadmap. Phases 1–4 ship v1.0; Phase 5+ are post-launch.
> This is a real product that will ship to IC mainnet. Sizing is honest.

---

## 0. Conventions

- One feature per branch. PRs ≤ 400 LOC.
- All Motoko types in `src/types.motoko`; the Candid declarations are
  generated and committed.
- `tests/` has Motoko unit tests for endpoints, and a separate
  `e2e/` folder with Playwright tests for the PWA.
- Docs in `docs/` are updated in the same PR as any behavior change.
- The Telegram bot lives in `bot/`, a separate workspace inside this repo.
  We **do not** deploy it; the user does.

---

## Phase 1 — Skeleton & auth (no ledger yet)

**Goal:** deployable canister that signs in via II + an empty PWA shell.

| # | Task | Notes |
|---|------|-------|
| 1.1 | Initialize `dfx` project | `dfx new iou --no-frontend`; add frontend later |
| 1.2 | Skeleton Motoko canister with `whoami`, `getMyUser`, `setDisplayName` | Display name encrypted at rest from day one (vetkd wrap on client) |
| 1.3 | Wire II in the agent (mainnet + local II canister id switch) | `II_CANISTER_ID` env |
| 1.4 | PWA with "Sign in" button + display-name form | Vite + `vite-plugin-pwa`, installable |
| 1.5 | `pnpm dev` script that runs `dfx deploy` then `vite` | `npm-run-all` |
| 1.6 | Test: sign in II, set name, refresh, name persists | Manual + Playwright smoke |

**Risk in this phase:** the `vetkd` API on the local replica. **Verify it
works on `dfx start --background` before committing to it.** If it doesn't
on the local `dfx` (as of `dfx` 0.24.3, the flag is not exposed), use the
**`devVetkd` adapter** (a deterministic in-browser keypair keyed by a
`DEV_VETKD_SECRET` env var) so that the *code path* on dev matches prod.
A test fails the prod build if the dev adapter is ever imported into a
production bundle.

**Exit criteria:** running `pnpm dev` lands on a page that says "hello,
<name>" with your principal shown, and a "Sign out" button.

---

## Phase 2 — Pair + sheet lifecycle

**Goal:** two users can pair up and create a sheet.

| # | Task |
|---|------|
| 2.1 | `createPair`, `joinPair(code)`, `getMyPairs`, `replaceMember` |
| 2.2 | Invite code = 8-char base32, hashed in stable map |
| 2.3 | `createSheet` (with both members' wrapped `K_sheet` from the start), `getSheet`, `getSheetWrappedKey`, `addCurrency` |
| 2.4 | `closeSheet` (eligibility check), `startNewSheet` (with carried balances) |
| 2.5 | Pair + sheet UI: create / join / replace / close / start-new states |
| 2.6 | **Crypto glue**: `wrapSheetKey` / `unwrapSheetKey` helpers in the PWA, with unit tests |
| 2.7 | Tests: creator sees invite; joiner with right code joins; wrong code rejected; replace-member requires both signatures |

**Exit criteria:** two browser windows (different II identities) can pair
up, create a sheet, add a currency, and see the sheet on both sides — both
sides have an unwrapped `K_sheet` in memory (verify in the PWA devtools).

---

## Phase 3 — Entries (the core)

**Goal:** add, edit, list, view entries. No delete.

| # | Task |
|---|------|
| 3.1 | Endpoints: `addEntry`, `editEntry`, `listEntries`, `getEntry` |
| 3.2 | `crypto/encryptEntry`, `crypto/decryptEntry` helpers + unit tests |
| 3.3 | Currency validation (3-letter regex, ≤16 enabled per sheet) |
| 3.4 | Entry form: title, description, currency, amount, direction, **convert toggle** |
| 3.5 | Convert flow: enable toggle → form calls `fx.fetchRate()` → auto-fills rate with "from frankfurter" badge → user can override |
| 3.6 | Entry list: time-desc, grouped by date, with edit affordance (owner only). Converted entries show target currency + original in brackets. |
| 3.7 | Pagination: cursor by entry id, 50 per page |
| 3.8 | Tests: encryption round-trip, owner-only edit, balance recomputation on edit, convert-to flipped later |

**Exit criteria:** I can add a debt + a credit, see them in history, edit
one, refresh — and history is consistent. The decrypted contents match
what I typed. (Verify by reading the canister's stable memory in a dev
script: it should be ciphertext only.)

---

## Phase 4 — Balances, inbox, export, devices, donate

**Goal:** the product is usable end-to-end.

| # | Task |
|---|------|
| 4.1 | Client-side balance computation + dashboard cards |
| 4.2 | Inbox: list / promote / dismiss endpoints + PWA page |
| 4.3 | Telegram bot repo (`bot/`): image → GPT-4o-mini → encrypted inbox item |
| 4.4 | JSON / CSV export from the device |
| 4.5 | "My devices" page (v1: this-device only; v1.1: multi-device) + sign-out |
| 4.6 | Donate-ICP button (settings, opt-in, calls the II ledger transfer) |
| 4.7 | Per-principal rate limits on all write endpoints |
| 4.8 | PWA install prompt + offline shell (read-only offline) |
| 4.9 | Tests: full end-to-end happy path with two principals on local; image-injection happy path |

**Exit criteria:** I can use the app as my only record of "Alice owes Bob"
in EGP and USD, with a USD→EGP convert entry, an inbox entry promoted
from a Telegram-shared image, an exported CSV, and donate-ICP button.
Both members see identical data. Node-operator-side inspection shows
ciphertext only.

---

## Phase 5 — Hardening (pre-mainnet)

| # | Task |
|---|------|
| 5.1 | Cycle top-up automation |
| 5.2 | Load test (1K entries, 100 active pairs in the local replica) |
| 5.3 | Inter-canister II call for full multi-device listing |
| 5.4 | Audit log on the canister (entry created / edited, immutable) |
| 5.5 | Accessibility pass (axe, keyboard nav) |
| 5.6 | Penetration test: confirm the canister cannot derive plaintexts |
| 5.7 | Bug-bounty program (small, focused on the crypto path) |

---

## Phase 6 — v1.1 features

| # | Task |
|---|------|
| 6.1 | Per-sheet printable recovery key (third wrapped copy) |
| 6.2 | Native mobile app via Capacitor |
| 6.3 | Google Sheets API export (user OAuth) |
| 6.4 | i18n (extract strings, ship en + ar) |
| 6.5 | Multi-device view + per-device sign-out (already partly done) |
| 6.6 | One-click deploy of the Telegram bot to a free host (optional) |

---

## Phase 7 — Growth (only if validated)

| # | Task |
|---|------|
| 7.1 | Multi-pair per user (already supported) but the UI needs a "Pairs" list view |
| 7.2 | N-person group ledgers (requires a new resource model — out of scope for v1) |
| 7.3 | Sharded canisters (multi-canister) at >50K active pairs |
| 7.4 | Sponsor / donate flow as a real feature, not just a button |

---

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `vetkd` API changes / bugs in `dfx` | Med | High | Phase 1.6 explicitly verifies it on the local replica. Fall back to display-name cleartext if needed. |
| Stable memory layout changes mid-dev, breaks upgrades | Med | High | Pin Candid types early; only bump after deployment, with explicit migration in `postupgrade`. |
| Telegram bot UX is awkward for non-technical users | High | Med | v1.1 adds a "deploy to fly.io" one-click. v1 ships a clear README. |
| User loses both devices = data loss | Low | Critical | v1: documented limitation. v1.1: printable recovery key. |
| FX rate provider goes down | Med | Low | Form shows "Provider unavailable" and the user types the rate. No canister-side dependency. |
| Cycles run out | Low | Critical | Phase 5 automation; alarm at 0.5 SDR remaining. |
| Spam from misbehaving client | Low | Med | Per-principal rate limits (F10). |
| Pair replaced mid-sheet without both consents | Low | High | Both signatures required (server-verified) before canister re-keys. |

---

## Effort sizing (rough, v1.0 only)

| Phase | Estimate | Why |
|-------|----------|-----|
| 1 | 2–3 days | II + vetkd wiring eats time |
| 2 | 3–4 days | Crypto glue + replace-member signing is non-trivial |
| 3 | 4–5 days | Entry form, validation, pagination, convert UX, FX |
| 4 | 4–5 days | Inbox + bot + balance + export + devices + donate |
| **Total v1.0** | **~3 weeks** | Realistic; halve for an experienced IC dev |

---

## Definition of Done (v1.0)

- [ ] Deployed to IC mainnet with a unique canister id.
- [ ] All endpoints have a passing Motoko test.
- [ ] README explains how to `dfx deploy` from a fresh clone.
- [ ] `tests/crypto/` round-trips a sample sheet key.
- [ ] No `git grep TODO` hits in `src/` or `bot/`.
- [ ] `pnpm build` produces a deployable PWA bundle with no warnings.
- [ ] Lighthouse PWA score ≥ 90.
- [ ] Two-test principals can complete the full happy path on mainnet.
- [ ] A canister-side inspection confirms all sensitive fields are
      ciphertext.
- [ ] `tests/crypto/prod-path.test.ts` passes (dev adapter is *not* in
      the production bundle).
- [ ] Canister creator's principal is set in the canister config
      (for the donate-ICP button).
- [ ] `docs/` reflect the shipped behavior (no stale diagrams).
- [ ] Phase 5 cycle automation is at least scaffolded, even if not enabled.
