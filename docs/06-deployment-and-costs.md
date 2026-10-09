# IOU — Deployment & Costs (v2)

> Single backend canister + asset canister. Why single, what it costs,
> how we keep it topped up, and the path to multi-canister when scale
> demands it.

---

## 1. The decision: single backend canister for v1

### Mainnet preparation and recoverable administration (2026-10-09)

The mainnet project is `icp.yaml`: **IOU backend + IOU assets only**. It does not
deploy Internet Identity, modify official OpenChat canisters, or add a separate
inbox canister. The durable inbox stays in the IOU backend. `dfx.json` and the
running local/Tailscale environment remain separate and unchanged.

**Current stage: preparation, not deployment.** `pnpm mainnet:check` and the old
`pnpm deploy:ic` entry point perform only an offline configuration check. They
do not create identities/canisters, convert ICP, change controllers or publish
assets. The old wallet deployment path was removed because its second frontend
build lost production flags and its backend used the local encryption key.

#### 1. Establish recovery before funding

Use a dedicated production Internet Identity. Register passkeys usable on two
devices, keep an independent hardware-key/recovery method, and keep recovery
material offline, outside source control, temp folders and chat. A synced
passkey is convenient but is not an independent backup if its provider account
is lost. Do not reuse the emulator's simulated identity or testing PIN.

With reviewed **ICP CLI 1.6.0**, link the identity on each computer:

```sh
icp identity link web iou-production --storage keyring
icp identity principal --identity iou-production
```

Sign in to the **same Internet Identity using the default CLI origin** on the
second computer and verify that the principal matches exactly. Do not use
`--app nns.ic0.app`: deployment administration need not share the treasury's
NNS principal. Use password-protected session storage if the operating system
has no usable keyring; never fall back silently to plaintext. Expired delegated
sessions are renewed with `icp identity reauth iou-production`, not by exporting
and copying a long-lived deployment key. Linking and recovery verification
require the owner's interaction; automation must not receive recovery secrets.

See the official [web-linked identity guide](https://cli.internetcomputer.org/1.5/guides/managing-identities/).

#### 2. Approve exact deployment coordinates

Before creating/funding anything, review the production principal, recovery
check, source commit, cycle budget and controllers. Prefer direct installation
by that principal: IOU records the authenticated installer as creator; a
wallet/proxy-mediated install may record the proxy instead. Additional
controllers each have full control; adding two controllers is **not** multisig.

After approved creation of the two empty canisters (or verifying existing
canisters), copy `scripts/mainnet.config.example.json` to the ignored
`scripts/mainnet.config.local.json`. Fill in the **public** deployment principal
and canister IDs. No passwords/keys belong in this file. Preserve these public
coordinates in the release record for use on other computers.

Set `IOU_MAINNET_CONFIG` to that file and run:

```sh
pnpm mainnet:check
pnpm mainnet:identity
icp project show
```

`mainnet:identity` compares the named CLI identity to the expected principal; it
does not prove controller access or second-device recovery. Neither command
changes account/canister state. Use `IOU_ICP_CLI` for an explicitly located CLI
binary. Use `icp canister link <name> <principal> -e ic` to record verified
existing IDs on a second computer; do not force-replace mappings or create
replacement canisters. Check both controller lists independently.

#### 3. Build and verify before installing

Only build a reviewed source revision; the checker reports a dirty workspace
as a release blocker. Existing model/reconnect experiments must not silently
enter a production build. No dependency audit or dependency upgrade is part of
this preparation.

```sh
pnpm test:mainnet
icp build -e ic
```

- New backend installs are built with `--no-default-features --features mainnet`,
  selecting vetKD `key_1`. The normal local build still selects `dfx_test_key`.
  Upgrades **preserve the stored key name**, even if it differs from the build
  default. Never rotate it implicitly or reinstall a data-bearing canister.
- Rust mainnet output lives under `target/mainnet`, separate from the local
  WASM. On Windows the build wrapper uses the existing Ubuntu WSL Rust
  toolchain; CLI identity keys are not passed to WSL.
- Frontend output is isolated under `.icp/mainnet-build/dist`. Every build
  explicitly uses the mainnet API, real backend ID and production vetKD;
  `.env.local` and inherited development `VITE_*` settings are not loaded;
  `NODE_ENV=production` is forced so development sign-in paths stay disabled.
- Published discovery URLs use the assets canister's certified HTTPS origin;
  the inbox route points to the IOU backend on `https://icp-api.io`. The exact
  checked-in processor bytes and action definitions are retained, and catalog
  integrity hashes are regenerated. Local `public/` assets are not modified.
- The staged response policy removes local replica connectivity but preserves
  the existing framing restrictions. Additional unofficial-client embedding
  origins need explicit review; this workflow does not open framing to everyone.

Do not use bare `icp deploy` (its implicit environment is local). Actual install
or upgrade remains a separate, owner-approved step, using explicit `-e ic`,
`--identity iou-production`, verified ID mappings and `--no-create`. Before
upgrading any existing backend, inspect `get_vetkd_key_name`, preserve its data
and verify compatibility. The feature flag does not migrate an existing local
encryption key to a production key.

After deployment, verify certified delivery, `get_vetkd_key_name == key_1`,
both controller lists, real-II login on two devices, encrypted sheet creation
and recovery, app discovery/connection, and encrypted inbox receipt plus
approval. These mainnet checks are not replaced by local unit tests. Keep
mainnet IDs/origin stable: moving local test data requires an explicit migration,
not copying local encrypted state into a new canister. Update the fork's app
directory configuration separately; no official OpenChat backend change is needed.

The cost figures below are historical planning estimates, not an approved
deployment funding amount. Recheck live cycle pricing and agree a budget before
any ICP conversion/top-up.

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
```sh
icp cycles balance -n ic --identity iou-production
icp canister status iou_backend -e ic --identity iou-production
icp canister status iou_assets -e ic --identity iou-production
```

These are status checks. Agree an explicit conversion/top-up amount before
running any funding command; the preparation scripts never spend funds.

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
