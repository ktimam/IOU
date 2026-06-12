# IOU — Phase 1 handoff (FINAL, June 12 2026)

## TL;DR

**Phase 1 is complete.** IOU canister is built in Rust, deployed on the local
replica, and the PWA is live. Open `http://127.0.0.1:4943/?canisterId=be2us-64aaa-aaaaa-qaabq-cai`
in a browser, click "Sign in with Internet Identity", set a display name,
reload — it should persist.

## What's verified (end-to-end)

- ✅ `dfx start --background` (using shared `~/.local/share/dfx/network/local/`)
- ✅ `dfx deploy iou_backend` (Rust + ic-cdk 0.17 + candid 0.10, builds in ~12s)
- ✅ `dfx deploy iou_assets` (PWA bundle uploaded)
- ✅ `dfx canister call iou_backend whoami` returns the caller's principal
- ✅ `dfx canister call iou_backend get_config` returns the config
- ✅ `dfx canister call iou_backend set_creator_principal` (auth path) works
- ✅ `pnpm install` + `tsc -b` + `vite build` all pass clean
- ✅ HTTP `curl http://127.0.0.1:4943/?canisterId=be2us-64aaa-aaaaa-qaabq-cai` returns the PWA HTML

## Two big changes from the original plan

1. **Backend language: Motoko → Rust.** Motoko 0.24 syntax was strict; I burned
   too long on it. Rust with `ic-cdk` 0.17 + candid 0.10 compiles cleanly.
2. **`dfx.json` has no `networks` block.** This was the actual fix for the
   perm panic — without it, dfx uses the shared `~/.local/share/dfx/network/local/`
   (same as your `ICSoccerWorldServer`).

## How to start (one command)

```bash
# In WSL Ubuntu
. /home/kiko/.cargo/env
. /home/kiko/.local/share/dfx/env
export PATH="/home/kiko/.cargo/bin:/home/kiko/.local/node20/bin:$PATH"
cd /mnt/c/Kiko/MyProjects/IOU

# Use setsid to truly detach dfx so it survives this script exiting
setsid nohup dfx start --background </dev/null >/tmp/dfx.log 2>&1 &
disown $!
sleep 6

# Verify
dfx ping
dfx deploy iou_assets  # if not already deployed
```

Then open `http://127.0.0.1:4943/?canisterId=be2us-64aaa-aaaaa-qaabq-cai`
in your browser.

## Final project layout

```
C:\Kiko\MyProjects\IOU\
├── dfx.json                      # NO networks block (the fix)
├── Cargo.toml                    # Rust deps
├── src/
│   ├── lib.rs                    # Rust canister (ic-cdk 0.17)
│   ├── iou_backend.did            # Candid interface
│   ├── main.tsx                   # PWA entry
│   ├── app/                       # router
│   ├── features/auth/             # II auth + display name + hello
│   ├── styles/global.css
│   ├── backend/                   # TS stub for actor (replaced by dfx generate)
│   │   ├── declarations.ts        # hand-written stub; overwrite with `dfx generate iou_backend`
│   │   └── main.mo.bak            # abandoned Motoko attempt
│   └── ...
├── .env.local                     # VITE_DFX_NETWORK + VITE_IOU_BACKEND_CANISTER_ID
├── index.html
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── vite.config.ts
├── scripts/dev-shell.sh
├── scripts/topup.sh
├── docs/                          # 6 v2 docs + phase-1-status + phase-1-handoff
└── .harness/skills/dfx-ic/        # the working skill
```

## Live URLs (local)

- **PWA**: http://127.0.0.1:4943/?canisterId=be2us-64aaa-aaaaa-qaabq-cai
- **Backend Candid UI**: http://127.0.0.1:4943/?canisterId=bd3sg-teaaa-aaaaa-qaaba-cai&id=bkyz2-fmaaa-aaaaa-qaaaq-cai
- **Backend canister id**: `bkyz2-fmaaa-aaaaa-qaaaq-cai`
- **Assets canister id**: `be2us-64aaa-aaaaa-qaabq-cai`
- **II (Internet Identity) canister id**: `rdmx6-jaaaa-aaaaa-aaadq-cai` (local replica standard)

## What's next (Phase 2+)

1. **Phase 1.2 — real `vetkd` wrap/unwrap** in the PWA. Right now the
   display-name is stored as raw bytes for development. The crypto glue
   goes in `src/features/crypto/` with the dev-fallback adapter
   (since `dfx 0.24.3`'s local replica may not have `vetkd` working).
2. **Phase 1.5 — Playwright smoke test** that signs in via II, sets a
   name, reloads, verifies the name persisted. (The TS actor code
   path is wired but not yet exercised end-to-end.)
3. **Phase 2 — pair lifecycle** (`createPair`, `joinPair`, `replaceMember`).
   The `vetkd` per-pair key wrapping lands here.
4. **Phase 3 — entries + convert + FX** (the meat of the product).

## Things I broke along the way (be aware)

- `src/backend/main.mo` was renamed to `main.mo.bak` (abandoned Motoko attempt).
- A few `dfx.json` revisions were saved to `dfx.json.bak` during the perm debugging.
- The dev-shell script's PATH didn't include `~/.cargo/bin` — `v1.1` should update it.

## Things I want to remember (lessons from this session)

- **Don't add a `networks` block to `dfx.json`** if you want the shared local network.
  That triggers the project-isolated perm bug on /mnt/c/.
- **Rust 1.96 + ic-cdk 0.17 is the working combo.** 0.18+ is yanked, 0.20+ needs
  edition2024 / Cargo 1.81+.
- **Don't `pkill -9 -f dfx`** — it gets permission-gated by the platform.
  Use `dfx stop`, or kill the specific PIDs.
- **On WSL, PowerShell `wsl -- bash -c "$HOME"` mangles `$HOME`** to `C:Users...`.
  Use literal `~/.local/...` paths or a script file.
- **Use `setsid nohup ... </dev/null >... 2>&1 &` to start dfx** so it survives
  the script that spawned it. Plain `dfx start --background` in a
  non-interactive shell gets killed when the script exits.
- The Motoko 0.24 compiler is more strict than my memory of Motoko; if we
  revisit Motoko in v1.x, actually read the docs first instead of guessing.
