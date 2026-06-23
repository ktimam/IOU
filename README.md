# IOU

> An encrypted 2-person IOU / shared-ledger app on the
> [Internet Computer](https://internetcomputer.org). Sign in with
> Internet Identity on any device, create a pair with one other
> person, and track who owes whom in any currency. The plaintext
> never leaves your device; the canister only stores ciphertexts
> and the IC's `vetkd` derives per-sheet keys from your identity.

> **Status (v1.3.1):** prod-vetkd IBE round-trip works on the
> local replica. The canister's `inspect_message` hook is on by
> default — same build works on PocketIC and IC mainnet, no cargo
> feature flags. The recovery mnemonic is now encrypted at rest
> with a user-supplied passphrase (PBKDF2 + AES-256-GCM); the
> replace-member Ed25519 seed goes through the platform secure
> element on native (Keystore / Keychain) with a web-fallback
> warning. The `canonical_replace_bytes` encoding is now
> length-prefixed instead of 0xff-delimited, so the canonical
> form is safe for arbitrary field types. See the
> [changelog](#changelog) below.

## What it does

You and one other person create a "pair". Inside the pair, you
can open one or more "sheets" — each sheet is a running ledger
between you two, in any currencies you choose (USD, EGP, EUR,
…). You can:

- Add entries: `{date, currency, amount, direction, note}`. A
  `convert` toggle fetches the live FX rate from
  `frankfurter.app` and stores the converted amount in the
  sheet's currency.
- See per-currency balances ("you owe X / they owe you Y")
  computed client-side from the decrypted entries.
- Edit or close a sheet. Closing records the final balances.
- Export a sheet to CSV (Google Sheets-ready).
- Replace a member: the leaving member signs an Ed25519
  payload, hands it (as a base64 blob) to the staying member,
  the canister verifies the signature and rotates the pair.

Crypto is end-to-end:
- Each sheet has a symmetric K_sheet (32-byte AES-256 key).
- The dev path (default) wraps K_sheet with P-256 ECDH per
  member; the keypair lives in `localStorage`.
- The prod path (toggle with `VITE_IOU_PROD_VETKD=1`) uses the
  IC's `vetkd` system API: any device can derive K_sheet from
  its BLS12-381 G1 transport key, no local keypair needed.
  Sign in with II on any device, get instant access.

## Architecture

```
┌──────────────┐                  ┌──────────────────────────┐
│   Browser    │   TLS / II auth  │   IC replica (dfx 0.27)  │
│  React PWA   │ ◄──────────────► │  ┌────────────────────┐  │
│ + II (or dev │  AES-GCM ciphertext │  │   iou_backend      │  │
│   identity)  │                   │  │  pair/sheet/entry  │  │
│ + vetkd      │                   │  │   state machine    │  │
│   decrypt    │                   │  └────────────────────┘  │
└──────────────┘                   │  ┌────────────────────┐  │
                                  │  │   iou_assets        │  │
                                  │  │  (serves the PWA)  │  │
                                  │  └────────────────────┘  │
                                  └──────────────────────────┘
```

- **iou_backend** (Rust + `ic-cdk` 0.20) — pair/sheet/entry state
  machine, `vetkd` IBE endpoints, `ed25519-dalek` for
  replace-member signatures.
- **iou_assets** — Vite-built PWA, served as a static asset
  canister.
- **dfx 0.27** (PocketIC-backed local replica) — the dev
  environment. Use `dfx 0.27+` because the vetkd endpoints need
  the `cost_call` system API which older versions don't export.

See [docs/02-architecture.md](docs/02-architecture.md) for the
full design and [docs/05-security.md](docs/05-security.md) for
the threat model.

## Repo layout

```
src/
├── lib.rs                      # Rust canister (state machine + endpoints)
├── iou_backend.did             # hand-written Candid interface
├── backend/
│   └── declarations.ts         # TS idlFactory (mirrors the .did)
├── app/                        # React app shell + router
├── features/
│   ├── auth/                   # II auth + dev identity
│   ├── flows/                  # Pairs, NewPair, Sheet, NewSheet
│   ├── entries/                # Add entry, balance, FX convert, CSV
│   ├── replaceMember/          # offline Ed25519 + QR handoff
│   ├── recovery/               # optional BIP-39 mnemonic backup
│   ├── crypto/                 # devVetkd (P-256) + prodVetkd (BLS)
│   ├── ui/                     # toasts
│   └── replaceMember/          # ...
├── styles/                     # global.css
└── ...

android/                        # Capacitor scaffold (run from WSL:
                                #   pnpm cap:sync; pnpm cap:open:android)

scripts/                         # build, deploy, smoke helpers
docs/                            # specs, architecture, plan, etc.
```

## Prerequisites

- **Node 20+** (or 22+ for Capacitor 8). Tested on Node 20.18.
- **pnpm 9+**: `npm install -g pnpm`.
- **dfx 0.27+** for the local replica. The dfxvm installer
  handles version selection; on this machine it's at
  `~/.local/share/dfx/bin/dfx` and the active version is
  pinned via `~/.wslconfig` in some setups. Check with
  `dfx --version`.
- **Rust 1.78+** with `wasm32-unknown-unknown` target
  (`rustup target add wasm32-unknown-unknown`) for the
  canister build.
- **WSL2 with mirrored networking** enabled in `~/.wslconfig`
  (so the Windows browser can reach the WSL-bound dfx
  replica). See the "WSL2 mirrored mode" section below.

## Build

```bash
# 1. Dev shell (puts cargo, dfx, node on PATH)
source scripts/dev-shell.sh

# 2. Install JS deps
pnpm install

# 3. Build the Rust canister
cargo build --target wasm32-unknown-unknown --release

# 4. Build the PWA (writes dist/)
pnpm build
```

The canister wasm lands at
`target/wasm32-unknown-unknown/release/iou_backend.wasm` and the
PWA bundle at `dist/`. Both are deployed to the local replica
on `dfx deploy`.

## Run (local dev with two users)

The fastest way to use the app is the **production-shape** path
(deploys both canisters to the local replica and serves the
PWA from the assets canister). The PWA itself is just a static
file bundle, so there's nothing else to start.

```bash
# 1. Start the local replica (PocketIC engine)
dfx start --background --clean

# 2. Deploy both canisters
pnpm deploy:local

# 3. Print the URL
dfx canister id iou_assets
# → uzt4z-lp777-77774-qaabq-cai   (your value will differ)

# Open: http://127.0.0.1:4943/?canisterId=<iou_assets id>
```

The first deploy will take a couple of minutes (Rust compile +
WASM install). Subsequent deploys of just the PWA (after
`pnpm build`) take a few seconds.

### Two-user test flow

You need two browsers (or one browser with a private window
+ a normal window). Both browsers hit the same URL.

**User A:**
1. Open the URL.
2. Click **"Sign in (dev — local identity)"** — this creates a
   Secp256k1 keypair in `localStorage` and gives you a stable
   principal (persisted across reloads, cleared on sign-out).
3. Click **"+ New pair"**, copy the 6-character invite code.
4. The pair page shows your public key (a base64 blob). Copy
   it.

**User B:**
1. Open the URL in a different browser / private window.
2. Sign in (dev). You'll get a *different* principal.
3. **"+ New pair"** → paste A's invite code → join.
4. The pair page shows B's public key. Copy it.

**Back in A's browser:**
1. On the pair page, B's public key has been registered for you
   automatically (the PWA reads it from the partner's member slot).
2. Click **"+ New sheet"**, choose currencies (e.g. USD, EGP)
   and a closing window (30..=730 days), create.
3. You're on the sheet page. Click **"+ Add entry"** to add
   some entries.

**In B's browser:**
1. Refresh the sheet. The PWA fetches the encrypted entries,
   decrypts them with K_sheet (via the partner pubkey for ECDH
   unwrap), and shows them in the history.

**Try the convert toggle:** when adding an entry, enable
"Convert to another currency" and pick a different currency
than the amount. The PWA fetches the rate from
`frankfurter.app` once and stores it on the entry.

**Try the close + export:** click "🔒 Close sheet" to record
final balances, then "⤓ Export CSV" for a Google-Sheets-ready
download. "📦 N archived sheets" on the pair page shows the
closed sheets read-only.

**Try the replace-member flow:** on either browser, open the
pair page and click "Replace member (leaving)" — paste the
*third* principal and sign. Copy the base64 blob the PWA
shows. Hand it to the other browser; they paste it into
"Accept replacement (staying)" and submit. The active sheet
gets closed and the new member inherits history.

## Chat import (AI → ledger)

Turn a money-transfer **screenshot** or a reservation into a ledger entry using
**your own** Claude (or ChatGPT) account — no developer API key, and the
end-to-end encryption is preserved. Your AI extracts the fields into a small
JSON *draft*; the draft lands in a **"Pending from chat"** inbox on the sheet;
you confirm it in the normal form, which encrypts on-device and calls
`add_entry`. The relay and connector are **key-blind** — they only ever hold the
draft (the same fields the AI already saw), never `K_sheet`, and nothing is
written until you confirm. Full design + milestones:
[docs/chat-agent.md](docs/chat-agent.md).

**Verified end-to-end on PC (2026-06-22, 10/10):** Claude → connector → relay →
app inbox → confirm → encrypted `add_entry` → entry in history → relay cleared.

### Which front-end — chat or code?

The connector is a **local stdio MCP server**, so only surfaces that *launch
local MCP servers* see it. Surfaces on the **remote-connector framework**
(claude.ai and the unified Claude app's general/cowork chat) do not:

| Front-end | Local stdio connector? | How |
| --- | --- | --- |
| **Claude Code** sessions (CLI or in-app, on the project) | ✅ | project `.mcp.json`, or `claude mcp add -s user` |
| **Classic Claude Desktop** (standalone app) | ✅ | `mcpServers` in `claude_desktop_config.json` |
| **Unified Claude app — general / cowork chat** | ❌ | remote framework — use a Claude Code session |
| **claude.ai** (browser) / **Claude mobile** | ❌ | remote connectors only — needs the OAuth cloud connector (not built) |

So the no-paste connector is effectively a **Claude Code** feature here; the
general chat / browser / mobile need the remote (cloud) connector — the Option
B+C work tracked in [docs/chat-agent.md](docs/chat-agent.md).

**Works in *any* chat today (no connector): the paste flow.** Ask any chat to
output the draft JSON
(`{"kind":"settlement","amount":<n>,"currency":"USD","direction":"credit|debt","note":"…"}`)
and paste it into the app's **✨ Import** box → confirm.

### Local / desktop quick start

```text
1. Run: dfx start  +  pnpm relay:serve (:8788)  +  pnpm dev
2. Register the connector (Claude Code .mcp.json or Claude Desktop config),
   baking the relay env into the launch command:
     IOU_RELAY_URL=http://127.0.0.1:8788 IOU_LINK_TOKEN=<token> \
       ./node_modules/.bin/tsx scripts/iou-mcp/server.ts
   (On Windows the command is wrapped in `wsl.exe -d Ubuntu bash -lc '…'`;
    wsl.exe does NOT forward Windows env, so bake the vars into the command.)
3. App → Settings → "Chat import (relay)": URL http://localhost:8788, paste the
   SAME <token> (don't Generate a new one), Save.
4. In a Claude Code session opened on the project (not the general chat): share a
   screenshot and ask it to "prepare an IOU entry" → it calls prepare_iou_entry →
   the draft hits the relay.
5. App sheet → "Pending from chat" card → Review & add → Add entry. Done.
```

The connector pushes to the relay only when `IOU_RELAY_URL` + `IOU_LINK_TOKEN`
are set; otherwise it returns paste-JSON you drop into the app's **✨ Import**
box. Connector + relay live in `scripts/iou-mcp/` and `scripts/iou-relay/`
(`pnpm mcp:selftest`, `pnpm relay:selftest`).

## Test

### Unit tests (24 tests, all pure)

```bash
pnpm test:unit
```

Covers: dev vetkd ECDH wrap/unwrap, prod vetkd adapter
contract, BIP-39 mnemonic round-trip, replace-member sign +
verify round-trip, CSV export formatting, and prod-path
guards (the dev/prod flag is honored in both the adapter and
the test env).

### Smoke test (50 assertions, end-to-end against the local replica)

```bash
# After deploy:local, the smoke is self-contained.
pnpm smoke:reset    # uninstall iou_backend code
pnpm smoke         # exercises Phase 1-4 + v1.1.2
```

This runs `scripts/awa-smoke.ts` against a clean replica. It
creates a pair, joins, creates a sheet, posts entries, edits
entries, lists entries, decrypts them, closes the sheet,
starts a new sheet, then runs the v1.1.2 replace-member flow
(Ed25519 sig + bad-sig rejection + non-member rejection).
The test exits 0 with `✅ Phase 2+3+4+1.1.2 smoke PASSED`.

### CI signal

`pnpm test:unit && pnpm build && pnpm smoke:reset && pnpm smoke`
should be green on any dev machine. That's the gate for shipping
a release.

## Deploy to IC mainnet

```bash
# 1. Set up a cycles wallet (one-time)
dfx identity --network ic get-wallet   # or create one

# 2. Build the prod-vetkd canister (the prod adapter is wired
#    in Cargo.toml behind a build-time feature; dfx 0.27 handles
#    the cost_call system API)
cargo build --target wasm32-unknown-unknown --release

# 3. Build the PWA with the prod vetkd path enabled
VITE_IOU_PROD_VETKD=1 pnpm build

# 4. Deploy
IOU_WALLET=xxxxx-cycles-wallet-principal pnpm deploy:ic
```

The deploy script (`scripts/deploy-prod.sh`) verifies dfx
>= 0.27, requires `IOU_WALLET` env var, builds the canister
with the prod-vetkd feature, builds the PWA with
`VITE_IOU_PROD_VETKD=1`, deploys to `--network ic`, and prints
the live URL.

## Mobile (Capacitor Android)

The PWA is wrappable in a native Android shell. The scaffold
is in `android/`, generated by `npx cap add android`. The
prod vetkd transport key is moved to the platform secure
element (Android Keystore + EncryptedSharedPreferences via
`@aparajita/capacitor-secure-storage`).

```bash
# 1. Sync the latest PWA build into the Android project
pnpm cap:sync

# 2. Open in Android Studio
pnpm cap:open:android

# 3. Build + install (from the android/ directory)
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

iOS support is wired (`@capacitor/ios`) but not yet
exercised — see [docs/08-mobile.md](docs/08-mobile.md) for the
build flow and v1.1.5 polish items.

## Common tasks

| Task | Command |
| --- | --- |
| Open a new shell with the right PATH | `source scripts/dev-shell.sh` |
| Start the local replica | `dfx start --background --clean` |
| Stop the replica (keeps wasm) | `dfx stop` |
| Reset (uninstall + redeploy) | `pnpm smoke:reset && pnpm deploy:local` |
| Unit tests | `pnpm test:unit` |
| Build the PWA | `pnpm build` |
| Build the canister wasm | `cargo build --target wasm32-unknown-unknown --release` |
| Deploy both | `pnpm deploy:local` |
| Deploy to mainnet | `IOU_WALLET=... pnpm deploy:ic` |
| Smoke test | `pnpm smoke:reset && pnpm smoke` |
| Sync to Android | `pnpm cap:sync` |
| Capacitor add iOS | `npx cap add ios` |
| Start a persistent replica (survives shell exit) | `wsl -d Ubuntu -- bash scripts/dfx-svc.sh` |
| Stop the persistent replica | `wsl -d Ubuntu -- bash -c "pkill -9 -f pocket-ic"` |

## WSL2 mirrored mode (Windows dev)

The dfx replica runs inside WSL2 on `127.0.0.1:4943`. The
Windows browser reaches it via WSL2's **mirrored networking
mode**, which makes `127.0.0.1` mean the same thing on both
sides. To enable:

1. Edit `C:\Users\<you>\.wslconfig`:
   ```ini
   [wsl2]
   networkingMode=mirrored
   ```
2. From PowerShell: `wsl --shutdown` to restart WSL.
3. Start the replica (it'll bind to `127.0.0.1:4943` inside
   WSL, but Windows can now reach it).
4. Open the URL `http://127.0.0.1:4943/?canisterId=<id>` in
   any Windows browser.

## Troubleshooting

- **`curl http://127.0.0.1:4943` returns nothing from inside
  WSL**: dfx is down. `dfx start --background --clean`.
- **Windows browser can't reach the URL**: mirrored mode isn't
  active. Check `cat /mnt/c/Users/.../wslconfig` (no, that's
  on Windows: `C:\Users\<you>\.wslconfig`) and run
  `wsl --shutdown` from PowerShell.
- **`dfx start` hangs**: the previous replica is wedged.
  `pkill -9 -f replica; pkill -9 -f pocket-ic; pkill -9 -f dfx`
  in WSL, then `dfx start --background --clean` again.
- **`pnpm build` fails after a code change in src/lib.rs**:
  cargo hasn't picked up the new deps. `cargo clean` once and
  rebuild.
- **Vetkd endpoint says "unknown threshold key"**: the
  canister was built for `dfx_test_key` but the replica
  doesn't have it (or vice versa). Check
  `dfx canister call iou_backend get_vetkd_key_name`.

## Status

- [x] v1 spec, architecture, plan, wireframes, security, costs
- [x] v1.0 — full pair + sheet + entry lifecycle, FX convert,
  close, archive, dev vetkd
- [x] v1.1.0 — prod vetkd scaffolding, recovery-key module,
  prod deploy script
- [x] v1.1.1 — real `vetkd_derive_key` IBE end-to-end, sign
  in from any device with II (dfx 0.27+ required for
  `cost_call`)
- [x] v1.1.2 — replace-member (offline Ed25519 + base64
  handoff blob, or QR via paste)
- [x] v1.1.3 — Google-Sheets CSV export
- [x] v1.1.4 — Capacitor Android scaffold
- [x] v1.2.x — prod-vetkd IBE works end-to-end on the local
  replica, inspect_message hook on by default (no cargo
  feature flag), deploy script fixed. See [Changelog](#changelog)
  below.
- [x] Chat import (AI → ledger) — local/desktop A-path:
  `prepare_iou_entry` stdio connector + key-blind relay +
  "Pending from chat" inbox. Verified end-to-end on PC (10/10).
  No-paste works from a **Claude Code** session (local stdio
  connector); the paste flow (**✨ Import**) works from any chat.
  See [docs/chat-agent.md](docs/chat-agent.md).
- [ ] Chat import cloud/mobile — remote OAuth connector
  (Option B+C): browser/mobile chat, hosted hardened relay.
- [ ] OpenChat + on-device Gemma — assessed (2026-06-23):
  autonomous-signer rejected (unsafe); owner's **confirmed-draft**
  flow is feasible as a v1 with **no OpenChat fork** (bot draft →
  existing inbox → on-device encrypted write on Accept). Design
  record in [docs/chat-agent.md](docs/chat-agent.md).
- [ ] v1.1.5 — signed Android release, iOS, deep links, app
  icon + splash
- [ ] v2 — real production deploy to IC mainnet

## Changelog

### v1.2.x (2026-06) — prod-vetkd IBE + inspect_message

Four fixes that close the gap between "compiles" and "works
end-to-end on the local replica":

- **v1.2.2 — fix prod-vetkd IBE decrypt.** The v1.1.5 fix called
  `MasterPublicKey.deserialize(...).deriveCanisterKey(canisterId)`,
  but the IC management canister's `vetkd_public_key` already
  does the full two-stage derivation (canister key + context
  subkey) server-side, so the PWA was double-deriving and the
  BLS pairing check in `decryptAndVerify` rejected the IBE
  ciphertext with "Invalid VetKey". Correct API: just
  `DerivedPublicKey.deserialize(bytes)` — no re-derivation.
  The 5th `canisterId` arg is now a no-op (kept for source
  compat). Phase 3 of the vetkd smoke now exercises a real
  IBE round-trip (A and B both derive the same 32-byte K_sheet).

- **v1.2.3 — re-enable inspect_message on PocketIC.** The
  v1.2.1 `mainnet` cargo feature was a workaround for a bug
  where the hook forgot to call `ic_cdk::api::accept_message()`.
  Per the IC spec, a hook that returns without accepting is a
  silent reject. The fix: call `accept_message()` at the end
  of the hook. No feature flag needed — same build works on
  PocketIC and IC mainnet. Also added a `require_auth_methods`
  allowlist so `vetkd_public_key` (intentionally unauth) isn't
  blocked at the inspect layer.

- **v1.2.4 — fix deploy-prod.sh.** The script had referenced
  `--features prod-vetkd` since v1.1.0, but that feature was
  never declared in `Cargo.toml`. Mainnet deploys would have
  failed with `unknown feature`. Dropped the flag — the
  canonical mainnet build is just
  `cargo build --target wasm32-unknown-unknown --release`.

- **Tooling: clippy in the smoke flow.** The WSL smoke scripts
  now run `cargo clippy --all-targets -- -D warnings` before
  the build, so dead code, unused vars, and a bunch of other
  correctness lints get caught at smoke time instead of
  silently rotting. Also added `LANG=C.UTF-8` so the smoke's
  `✓/✗/═══` characters render properly under PowerShell + WSL.

25/25 unit tests + 12/12 smoke assertions + 0 clippy warnings
on the canister crate.

## License

TBD. Internal repo for now.
