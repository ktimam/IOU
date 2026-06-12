# IOU — Phase 1 status

What's done, what's verified, what runs on your machine.

---

## ✅ Verified in this session

- `pnpm install` — installs 460 packages, no errors.
- `pnpm exec tsc -b` — TypeScript compiles cleanly.
- `pnpm exec vite build` — produces a 341 KB JS bundle + PWA service worker.
- The Motoko skeleton is syntactically valid (will compile on `dfx build`).
- The PWA shell renders in dev (Vite serves it on `localhost:5173`).

## ⚠️ NOT yet verified (blocked on local replica boot)

- `dfx start --background` on the **local** replica — hung twice in this
  session. Likely cause: first-run `pocket-ic` download + slow `/mnt/c/`
  filesystem on Windows. Needs to run in your dev shell where it can
  take 3–5 minutes uninterrupted.
- `dfx deploy iou_backend` (depends on a running replica).
- `dfx generate iou_backend` (regenerates TS declarations; will overwrite
  the stub at `src/backend/declarations.ts`).
- `pnpm deploy:local` end-to-end.
- Phase 1.6 (vetkd verification on local replica).

## 🟡 What's stubbed

- `src/backend/declarations.ts` is a **hand-written stub** that matches
  the Motoko `idlFactory` shape. The first `dfx generate` overwrites
  it with the real generated code. The stub is `any`-typed intentionally
  to be replaced; do not hand-edit it after a real generate run.
- `src/features/auth/SetDisplayName.tsx` calls `console.warn` instead
  of actually round-tripping to the canister. The real call is one
  `await createActor(state.identity).setDisplayName(...)` away, but
  it'll only work after the canister is deployed. Phase 1.5 wires it.

## 🚀 What to run on your machine

```bash
# 1. Open the project dev shell
source scripts/dev-shell.sh

# 2. (First time only, or after a clean) install deps
pnpm install

# 3. Boot the local replica. FIRST RUN TAKES 3–5 MINUTES — dfx downloads
#    pocket-ic + II wasm. Don't interrupt. Use --clean if it gets stuck.
dfx start --background --clean

# 4. Confirm the replica is up
dfx ping

# 5. Build + deploy the backend
dfx deploy iou_backend

# 6. Generate the real TS declarations (overwrites the stub)
dfx generate iou_backend

# 7. Wire SetDisplayName to call the real actor
#    (see the comment in src/features/auth/SetDisplayName.tsx)

# 8. Build the PWA + deploy the asset canister
pnpm build
dfx deploy iou_assets

# 9. Run the PWA
pnpm dev
# → http://localhost:5173
```

## 📋 What's left for "Phase 1 done"

- [ ] `dfx start --background --clean` runs to completion (user side).
- [ ] `dfx deploy iou_backend` succeeds.
- [ ] `dfx generate iou_backend` regenerates the TS declarations.
- [ ] `SetDisplayName` calls the real `setDisplayName` actor method.
- [ ] PWA signs in via local II, sets a name, name persists across reload.
- [ ] `dfx canister call iou_backend whoami` returns the principal.
- [ ] `tests/crypto/prod-path.test.ts` exists and passes (Phase 1.2).
- [ ] One Playwright smoke test passes (signs in + sets name + reloads).

## ⏭ Next phase (when Phase 1.5–1.6 are done)

Phase 2: pair lifecycle (`createPair`, `joinPair`, `replaceMember`) +
the `vetkd` wrap/unwrap helpers in `src/features/crypto/`. This is the
first place real crypto lands; that's also the riskiest piece.
