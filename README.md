# IOU

> Encrypted 2-person IOU / shared-ledger app on the Internet Computer.
> See [docs/01-specification.md](docs/01-specification.md) for the product
> spec and [docs/02-architecture.md](docs/02-architecture.md) for the
> architecture.

## Quick start (local dev)

```bash
# 1. Open the project dev shell
source scripts/dev-shell.sh

# 2. Install deps + start the local replica
pnpm install
dfx start --background

# 3. Deploy both canisters
pnpm deploy:local

# 4. Run the PWA
pnpm dev
```

Open http://localhost:5173 and click "Sign in with Internet Identity".

## Layout

- `src/backend/` — Motoko canister code.
- `src/` (at the root, no folder prefix) — the PWA (Vite + React + TS).
- `bot/` — the user-owned Telegram bot (separate workspace, ships in v1).
- `tests/` — Motoko unit tests + TS crypto tests + Playwright e2e.
- `docs/` — product spec, architecture, plan, wireframes, security, costs.
- `scripts/` — dev shell, top-up, etc.
- `.harness/skills/dfx-ic/` — the dfx/IC working skill (load it before
  doing canister work).

## Status

- [x] v2 spec, architecture, plan, wireframes, security, costs
- [x] Dev environment (Node 20, pnpm, dfx) and `dfx-ic` skill
- [ ] Phase 1 — skeleton canister + II auth + PWA shell
- [ ] Phase 2 — pair + sheet lifecycle
- [ ] Phase 3 — entries + convert + FX
- [ ] Phase 4 — inbox + balances + export + devices + donate
- [ ] Phase 5 — hardening + mainnet deploy
