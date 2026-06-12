---
name: dfx-ic
description: |
  Working with the Internet Computer from this project — dfx, Motoko canisters,
  IC mainnet, vetkd, vetkd fallback, cycle management. Load this skill for any
  dfx / canister / IC / vetkd / cycle / II / Internet Identity work in IOU.
---

# dfx + Internet Computer (project-local)

> Scope: IOU project. If you came here from another project, this skill is
> tailored to IOU's choices — Motoko backend, single canister, `vetkd`-wrapped
> per-sheet keys, PWA on the asset canister. Adjust before reusing.

---

## 0. Project conventions

- **Build target:** WSL Ubuntu. You edit on Windows; you build in WSL.
- **Source-of-truth Node:** `/home/kiko/.local/node20/bin/` (Node 20.18.0).
  Don't use Windows-side Node; the PATH collision breaks `dfx` and Vite.
- **Project entry point:** `scripts/dev-shell.sh`. Always `source` it (or
  run it) before any `pnpm` / `dfx` / `npm` command.
- **Node version manager:** none. Node 20 is in `~/.local/node20`. If you
  ever need a different version, install another tarball there.
- **Package manager:** `pnpm@9` (installed via `npm install -g pnpm@9` from
  the Node 20 prefix).

---

## 1. The dev loop (TL;DR)

```bash
# 1. open the dev shell
source /mnt/c/Kiko/MyProjects/IOU/scripts/dev-shell.sh

# 2. one-time per shell session
pnpm install
dfx start --background

# 3. every code change
pnpm deploy:local        # dfx deploy iou_backend + iou_assets
pnpm dev                 # vite dev server on http://localhost:5173

# 4. stop the replica when done
dfx stop
```

---

## 2. dfx essentials (IOU-relevant)

### 2.1 Version
- `dfx 0.24.3` is what this project is built and tested against. Higher
  versions should work; older versions (≤ 0.20) may lack the vetkd
  enablement for the local replica.

### 2.2 The local replica and vetkd
- The local replica (`dfx start --background`) **may or may not** expose
  `vetkd_derive_key` depending on the dfx version. As of `dfx 0.24.3`
  there's no `--enable-vetkd` flag in `dfx start --help`, so we treat
  it as **not available on the local replica** by default.
- **We ship a `devVetkd` adapter** that uses an in-browser keypair keyed
  by `DEV_VETKD_SECRET` env var. The canister doesn't see the
  difference; the code path is identical.
- **Production builds fail** if the dev adapter is imported. See
  `tests/crypto/prod-path.test.ts`. Don't remove that test.
- To use real `vetkd` locally (advanced): start the replica with
  `dfx start --enable-vetkd` (if your version supports it). If that
  works, the dev adapter code path still works — it just isn't used.
  Verify in `dfx canister call` output and the PWA dev console.

### 2.3 Internet Identity locally vs. mainnet
- **Local replica:** the II canister is at
  `rdmx6-jaaaa-aaaaa-aaadq-cai` (deterministic on every local replica).
  The PWA picks this up via `VITE_II_CANISTER_ID` (see
  `src/features/auth/config.ts`).
- **Mainnet:** II is at `rdmx6-jaaaa-aaaaa-aaadq-cai`. Same id. We
  default to that.

### 2.4 Canister ids in this project
- `iou_backend` — the Motoko canister, holds all state.
- `iou_assets` — the asset canister, holds the built PWA.

### 2.5 dfx commands you will use
```
dfx start --background              # start the local replica
dfx stop                             # stop it
dfx deploy                           # deploy both canisters
dfx deploy iou_backend               # deploy only the backend
dfx deploy iou_assets                # deploy only the assets
dfx canister call iou_backend <fn>   # call a backend function
dfx canister status iou_backend      # see cycle balance, module hash
dfx cycles balance                   # see your cycles wallet balance
dfx ledger balance                   # see your ICP balance
dfx cycles convert --amount 5        # convert ICP to cycles
dfx canister deposit-cycles iou_backend 1000   # top up the canister
dfx identity list                    # list your local identities
dfx identity use icsoccer-ed25519    # switch identity
dfx generate                          # regenerate the type declarations
```

### 2.6 The `--network ic` flag
Every mainnet-bound command needs it. Local replica commands don't.
CI uses it. We pin the mainnet deploy behind a confirm prompt to
prevent accidental deploys.

---

## 3. Cycles — the part everyone gets wrong

### 3.1 What cycles are
- A fungible unit of computation and storage on the IC.
- You buy them with ICP via `dfx cycles convert`.
- They live in either your **cycles wallet** (an ICP-controlled
  account) or directly in a canister.
- Canisters **spend** cycles for execution, storage, and inter-canister
  calls.

### 3.2 The flow
1. Buy ICP on an exchange, withdraw to your `dfx identity`'s principal.
   Use the ICP ledger or `dfx ledger balance` to confirm.
2. `dfx cycles convert --amount 5` (5 ICP) → moves cycles to your
   wallet.
3. `dfx cycles transfer <amount> <canister-id>` (or `dfx canister
   deposit-cycles <canister> <amount>`) → top up the canister.

### 3.3 The IOU top-up script
`scripts/topup.sh` is the project's official top-up workflow. It:
- Reads the canister id from `.dfx/local/canister_ids.json` (or
  `ic`/canister_ids.json on mainnet).
- Reads the cycle balance.
- If below 1 SDR (configurable), tops up from the cycles wallet.
- Supports `--dry-run`.

### 3.4 What it costs at our scale
- 1K active users: ~$150/month cycles. Mostly the
  update-call × active-user-day metric.
- 10K active users: ~$1,500/month cycles. We don't worry about this
  for v1; we worry about it in v1.1 when we add a sponsor or paid tier.

---

## 4. Internet Identity (II)

- **What it is:** the IC's native auth layer, anchored to WebAuthn
  devices. Each anchor maps to a single principal; you can have many
  anchors on one device.
- **What we use it for:** authentication. The canister trusts the
  `msg.caller` returned by the agent.
- **What we don't use it for:** display names, profile data. Those go
  in the IOU canister, encrypted.
- **The agent:** `@dfinity/auth-client` handles the II flow. It
  stores the delegation in IndexedDB. v1 requests 30-day delegations.
- **Devices:** the `listMyDevices()` endpoint calls the II canister
  inter-canister to enumerate active delegations. (In v1 we may
  simplify to "this device only" + "sign out everywhere" — see
  `04-wireframes.md` §11.)
- **Sign out:** we call `authClient.logout()` per device and also
  revoke the delegation via II.

---

## 5. vetkd (and the dev fallback)

### 5.1 What `vetkd` does
The IC's `vetkd_derive_key` system call produces a public key derived
from the chain key, bound to a `(caller_principal, derivation_context)`
pair. The user's wallet derives the corresponding private key locally.
The keypair is non-extractable from the device.

In IOU, we use it to **wrap** a per-sheet symmetric key so the
canister can store two copies (one per member) without ever seeing the
plaintext key.

### 5.2 The dev fallback (`devVetkd` adapter)
For local dev when `vetkd_derive_key` isn't available on the replica:
- The TS client uses a deterministic keypair derived from
  `import.meta.env.DEV_VETKD_SECRET` (set in `.env.local`).
- The key format matches what the production path produces.
- The canister doesn't know the difference — it just stores wrapped
  bytes.
- **Production builds fail** if this adapter is imported. This is
  enforced by `tests/crypto/prod-path.test.ts`. The test fails the
  build if `src/features/crypto/devVetkd.ts` is reachable from
  `src/features/crypto/index.ts` in a production bundle.

### 5.3 To use real `vetkd` locally (advanced)
If your `dfx` version supports `--enable-vetkd`:
```bash
dfx stop
dfx start --background --enable-vetkd
pnpm dev
```
You should see in the browser console: `crypto: vetkd (real)`. If
you see `crypto: vetkd (dev)`, the fallback is still active and you
should investigate before trusting your local dev.

---

## 6. Common pitfalls

- **PATH collision:** Windows-side Node (and any /mnt/c/* node tools)
  will appear earlier in `$PATH` than our WSL Node 20 unless you
  `source scripts/dev-shell.sh`. Symptoms: `node --version` returns
  v12, `pnpm` not found, `dfx` build fails with `wasm-bindgen`
  errors.
- **Line endings:** if you commit CRLF, Motoko will reject the build.
  Set `.gitattributes` to `* text=auto eol=lf` (project does this).
- **`dfx.json` canister paths:** the `dfx deploy` command runs from
  the directory containing `dfx.json`. Don't `cd` into a subdirectory
  and expect `dfx deploy` to find it.
- **Candid pinning:** Candid type changes require careful canister
  upgrade. v1 → v1.x migrations go in `postupgrade`. Don't bump
  Candid casually.
- **Cycle wallet exhaustion:** if your cycles wallet is at 0, *all*
  `dfx` commands that need cycles will fail with a confusing error.
  Check `dfx cycles balance` first.
- **Internet Identity popup blocked:** some browsers block the II
  popup. v1 shows a clear "allow popups for this site" hint.
- **WSL clock drift:** if you see odd timestamp errors after the
  laptop sleeps, run `wsl --shutdown` and `wsl -d Ubuntu` to
  re-sync.

---

## 7. The non-negotiable checks before deploying to mainnet

- [ ] `pnpm test` passes (unit + crypto + e2e)
- [ ] `pnpm build` is clean
- [ ] `tests/crypto/prod-path.test.ts` passes (no dev adapter in prod)
- [ ] Cycle balance > 5 SDR
- [ ] `dfx canister status iou_backend` on local replica shows no
      errors
- [ ] Two-test-principal happy path works on the local replica
- [ ] The canister's stable memory is inspected and contains only
      ciphertext for sensitive fields
- [ ] `dfx.json` is committed with the right network config
- [ ] The canister creator's principal is set (for the donate-ICP
      button)

If any of those fail, don't deploy. The IC mainnet is permanent.

---

## 8. Useful one-liners

```bash
# See all the principals in your local dfx
dfx identity list

# See the canister id of the local backend
dfx canister id iou_backend

# See the current caller's principal
dfx identity get-principal

# Check the cycles balance of a canister
dfx canister status iou_backend --network ic

# See your ICP balance
dfx ledger --network ic balance

# Get a fresh 30-day delegation
dfx identity --network ic renew icsoccer-ed25519  # pseudo — see II docs
```

(For the II-specific commands, see the II skill; out of scope for
this skill.)
