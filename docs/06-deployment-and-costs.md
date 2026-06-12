# IOU — Deployment & Costs (v2)

> Single backend canister + asset canister. Why single, what it costs,
> how we keep it topped up, and the path to multi-canister when scale
> demands it.

---

## 1. The decision: single backend canister for v1

| Aspect | Single canister (v1) | Multi-canister (v2+) |
|---|---|---|
| Storage | All stable memory in one place | Sharded, but cross-canister calls add latency and cycles |
| Cycles for storage | ~0.46 SDR/GB/month regardless | Same |
| Cycles for compute | Update ~5B/call ≈ $0.0002 | Higher per request (cross-canister calls ~5–10B each) |
| Canister scale limit | 4 GB stable per canister (extendable to many GB with `stable_memory` extension; ~4M entries at 1 KB) | Effectively unlimited |
| Upgrade risk | One upgrade touches everything | Canisters upgrade independently |
| Code complexity | Low | Higher (router, share types) |
| Cost at <50K active pairs | **Cheaper** | Only cheaper past ~50K |
| Recommended for v1 | ✅ | No — defer |

**v1 ships one backend canister. Done.**

---

## 2. Cost math (mainnet, 2026)

IC pricing (approximate, from the IC dashboard):

| Resource | Cost |
|---|---|
| 1 GB stable storage | ~0.46 SDR / month (~$0.60) |
| 1 update call | ~5B cycles (~$0.00018) |
| 1 query call | Free up to ~1M/day per canister |
| Asset canister serving (frontend) | ~$0.10–0.50 / month depending on traffic |
| Inter-canister call (we use one, to II) | ~5B cycles per call |

### 2.1 Per-user footprint

A typical active user has:
- 1 user record: ~150 bytes
- 1–2 active pairs: ~200 bytes
- 1 active sheet: ~250 bytes
- ~500 entries, ~600 bytes each (ciphertext + metadata): ~300 KB
- Wrapped sheet keys: ~256 bytes
- Inbox: ~10 KB

**Total: ~310 KB per active user.**

10,000 active users → **~3 GB** → **~$1.80 / month storage**.

### 2.2 Per-action cost

| Action | Cycles | USD |
|---|---|---|
| Sign-in (II delegation fetch) | ~5B | $0.00018 |
| `getSheet` | ~free (query) | $0 |
| `addEntry` (with ciphertext upload) | ~10B | $0.00036 |
| `listEntries` (200 entries) | ~free (query) | $0 |
| FX rate fetch (user-side) | $0 to us | $0 |
| Telegram bot image-to-inbox | ~10B | $0.00036 |
| Donate-ICP button | ~10B (ledger transfer) | $0.00036 + the donated ICP |

A typical user does ~50 actions/day → **~$0.01/day per user**.

### 2.3 v1 budget (rough)

Assuming **1,000 active users** in the first 6 months of v1:
- Storage: ~310 MB → **~$0.20 / month**
- Compute: 50K actions/day × $0.0004 × 30 = **~$600 / month** (cycles are real money at scale)
- Asset canister + misc: **~$5 / month**

**Total: ~$605 / month** at 1K active users. That's the worst case
because most users won't hit 50 actions/day; the typical user is more
like 5–10 actions/day, putting the number closer to **$150 / month at
1K users**.

At **10K active users**, ~$1,500 / month. Still cheap.

The donate-ICP button is a soft offset, not a funding plan. Real funding
comes from the developer topping up cycles; if the product grows past
10K active users, the conversation shifts to a sponsor or to a paid
tier.

---

## 3. Cycle top-up strategy

### 3.1 v1 (manual)
- The developer (you) holds the canister controller keys (or a multisig
  of them).
- A small CLI script (`scripts/topup.sh`) queries the cycle balance via
  `dfx canister status` and tops up from a pre-funded cycles wallet if
  the balance drops below 1 SDR.
- Soft alarm: 0.5 SDR remaining. Hard alarm: 0.1 SDR.

### 3.2 v1.1 (automated)
- The `cycles-manager` IC service: a separate controller-side service
  that monitors cycle balance and tops up automatically from a pre-funded
  wallet. We deploy this as a separate small canister and point our
  IOU canister at it.
- Alternatively, a tiny cron canister that runs once a day and tops up
  if needed. The cron is in our control; we trust ourselves more than
  a third party.

### 3.3 Mainnet top-up workflow
```
dfx ledger --network ic balance                # check ICP balance
dfx cycles convert --amount 5                 # convert ICP to cycles
dfx canister status iou_backend               # check canister cycle balance
dfx canister deposit-cycles iou_backend 1000  # top up
```

We wrap these in a script with sane defaults and a `--dry-run` flag.

---

## 4. Local dev

```bash
# one-time
dfx start --background                  # local replica with vetkd
pnpm install

# every session
pnpm deploy:local                        # dfx deploy
pnpm dev                                 # vite dev server
```

`pnpm deploy:local` does:
1. `dfx deploy iou_backend --argument '(record {})'`
2. `pnpm build` (Vite → dist)
3. `dfx deploy iou_assets` (asset canister picks up dist/)

The local replica has `vetkd` as of `dfx` 0.20+. If it doesn't, our
crypto code has a clearly-labeled fallback path for dev only.

---

## 5. Mainnet deploy

### 5.1 First deploy
```bash
dfx deploy --network ic
```

The first deploy is **the most expensive** (canister creation + initial
cycles allocation). Subsequent `dfx deploy` calls are cheap.

### 5.2 Subsequent deploys
```bash
dfx deploy iou_backend --network ic       # canister upgrade (preserves state)
dfx deploy iou_assets --network ic       # asset upload
```

We pin Candid types early; only bump them when we deploy a new version
to mainnet, with an explicit migration in `postupgrade`.

### 5.3 Custom domain (v1.1)
- `*.iou.app` (or whatever TBD) → canister-id mapping via `dfx` or
  Boundary node config.
- v1 uses the default `*.icp0.io` URL.

### 5.4 Pre-mainnet checklist
- [ ] `pnpm test` passes (unit + e2e)
- [ ] `pnpm build` clean, no warnings
- [ ] Local load test: 1K entries per sheet, 100 active pairs
- [ ] `tests/crypto/` round-trips a sample sheet key
- [ ] Canister-side inspection confirms all sensitive fields are ciphertext
- [ ] Cycle balance > 5 SDR before first deploy
- [ ] `docs/` reflect the shipped behavior
- [ ] Top-up script tested in dry-run mode
- [ ] README explains `dfx deploy` from a fresh clone

---

## 6. When to shard (multi-canister)

We shard when **at least two** of these are true:
- Stable memory > 50% of the 4 GB soft cap
- Update-call latency p99 > 1s
- We're paying > 1 SDR / month just for the active user base
- We have a feature that needs to scale independently (e.g. a public
  read API)

**Sharding plan (v2+):**
- **Router canister**: stateless, holds the `pairId → shardId` map.
- **Shard canisters**: each holds a subset of pairs; partitioned by
  `hash(pairId) mod N`.
- **FX oracle sidecar** (if we ever move FX server-side).
- **Image storage sidecar** (if we ever store receipts).

Sharding is a v2+ problem. For v1, a single canister is the right call
in every dimension: simplicity, cost, latency, and code clarity.

---

## 7. Inactive user cost (your specific question)

**In the single-canister model:** yes, you carry the cost of every
user's data as long as the canister has cycles. If you stop paying, the
canister dies and *everyone's* data is at risk.

**Cost per inactive user:** ~310 KB × 0.46 SDR/GB/month ≈ **$0.00014 / user / month**.

**At 100K inactive users, that's ~$14 / month.** Cheap, but it does
grow linearly.

**In a multi-canister model:** an inactive user's data could live in a
"cold" canister you stop topping up. After the IC's ~30-day grace
period, the cold canister is garbage-collected and the data is gone.
The user is gone, and the cost is gone. **But you have to migrate
data to cold canisters explicitly — there's no automatic "archive
this" mechanism.**

**v1 plan:** don't migrate. Carry the cost. At expected v1 scale, it's
$14/month for 100K inactive users, which is fine. In v1.1, add an
"archive this user" admin tool that exports the data as JSON, gives
it to the user, and clears the canister's data for that user (with
their consent).

**v1.1+ plan:** when inactive user count > 10K, build a
"cold-storage" feature that moves closed sheets (read-only, no
crypto-key changes needed) into a separate canister. The user keeps
access; the active canister's storage shrinks.

---

## 8. Decision summary (v1.0)

| Decision | Choice | Why |
|---|---|---|
| Single vs multi canister | **Single** | Cheaper, simpler, fast enough at our scale |
| Backend language | **Motoko** | Readable, fast on-ramp; Rust port path open if needed |
| Frontend | **Vite + React PWA** | Mobile-first, installable, no app store |
| Auth | **Internet Identity** | No passwords; device-aware via vetkd |
| Encryption | **vetkd + per-sheet AES-GCM** | No node operator read, no passphrase UX |
| FX | **Client-side Frankfurter.app** | $0 cost to us |
| Image ingestion | **User-owned Telegram bot** | $0 inference cost to us |
| Storage cost at 1K users | **~$0.20/month** | Sustainable |
| Storage cost at 10K users | **~$1.80/month** | Still fine |
| Compute cost at 1K users | **~$150/month** | Largest line item; mitigated by rate limits |
| Cycle top-up | **Manual in v1, automated in v1.1** | |
| Inactive user cost | **Carried; archive tool in v1.1** | |
| Custom domain | **v1.1** | |
