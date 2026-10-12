# Account vault implementation validation

Validated locally on 2026-10-13. No mainnet calls, funding, deployment, user credentials, existing-canister resets, or recovered-replica changes were performed.

## Automated checks

- Full frontend suite: **3,925 passed, zero failed or skipped**; `pnpm run typecheck` passed.
- Existing CI coverage gate passed without lowering thresholds: statements/lines **78.74%**, branches **87.25%**, functions **89.66%**.
- Production-crypto frontend and service-worker build passed with `VITE_IOU_PROD_VETKD=1`, local network configuration, and an isolated output directory; no running frontend was replaced. The existing large-chunk warning is nonfatal.
- `cargo fmt --check` and `cargo test --all-targets --locked --quiet`: formatting clean, **134 passed**.
- `pnpm run test:mainnet`: **27 deployment-plan/publication guard tests passed**, without a deployment or network transaction.
- `cargo test --lib --no-default-features --quiet`: **134 passed**.
- `cargo test --lib --features mainnet --quiet`: **134 passed**. This tests the compilation configuration; it does not contact mainnet.
- `pnpm exec vitest run src/backend/declarations.security.test.ts`: **9 passed**.
- `git diff --check` on the owned backend/declaration changes: clean.

Unit coverage includes vault CAS and owner separation, bounded storage, stable-memory reopen, wrapping-key publication and rejected replacement, token-bucket admission across many principals, request/transport pinning, timestamp replay protection after receipt pruning, emergency cooldown, unresolved requests, and late callbacks. Sheet tests cover authenticated membership, immutable key schemes, creation idempotency, deleted-ID tombstones, context-bound envelopes, recipient repair without overwrite, and invitation cleanup.

## Real old-to-new upgrade

The test is [scripts/live/account-vault-upgrade.ts](../scripts/live/account-vault-upgrade.ts). It requires an explicit loopback HTTP gateway and SHA-256-pinned old/new Wasm inputs, generates a synthetic controller only in memory, and always creates its own fresh canister. It never accepts an existing target canister ID. The isolated PocketIC subnet uses `dfx_test_key`; its cycles and threshold derivations are local test activity, not paid mainnet fees.

Artifacts used:

| Artifact | Source | SHA-256 |
| --- | --- | --- |
| Old schema 19 | Commit `8f5d048b1faf2a87254e0447885dab450b759e94`, built offline in a separate temporary source export | `F073AE3F48B1CB3448CAE07580401212A7C2C1271CB0AE01A1DB0F662F1515DE` |
| New schema 20 | Current local default-feature release build | `09B6C92B048B69486E2496D8AC4F0DCCE06149F6ED52C129A6AA578B2D1295E8` |

The old source export contained `Cargo.toml`, `Cargo.lock`, `src/lib.rs`, and `src/durable_inbox.rs`; no working-tree checkout or reset was used. Its build command was:

```powershell
cargo build --manifest-path F:/Temp/OpenChat-IOU/account-vault-isolated-20261014-0135/iou-vault-upgrade-baseline-8f5d048-20261013/Cargo.toml --target wasm32-unknown-unknown --release --no-default-features --locked --offline
```

Reproduction invocation from the IOU repository root, using the same verified baseline after consolidating it under the project temporary folder:

```powershell
pnpm exec tsx scripts/live/account-vault-upgrade.ts http://127.0.0.1:49175 F:/Temp/OpenChat-IOU/account-vault-isolated-20261014-0135/iou-vault-upgrade-baseline-8f5d048-20261013/target/wasm32-unknown-unknown/release/iou_backend.wasm F073AE3F48B1CB3448CAE07580401212A7C2C1271CB0AE01A1DB0F662F1515DE target/wasm32-unknown-unknown/release/iou_backend.wasm 09B6C92B048B69486E2496D8AC4F0DCCE06149F6ED52C129A6AA578B2D1295E8
```

That gateway is an isolated test process, not a permanent project configuration. A rerun needs the explicitly chosen fresh isolated gateway, the required application subnet, and the exact pinned artifacts; rebuilds require reviewing updated hashes. Neither Wasm files nor temporary browser profiles belong in the commit.

Result: **passed** on newly created synthetic canister `7uieb-cx777-77776-qaaaq-cai`, with two actual management-canister upgrades: schema 19 → 20 and then 20 → 20. The test:

1. Installs the real old Wasm and seeds actual VetKD-derived consumer and sheet keys, an encrypted profile, encrypted sheet name, entry plus edited history, and a real P-256 OpenChat delivery keypair in the existing encrypted wire format.
2. Upgrades without resetting stable memory and compares all seeded records byte-for-byte. The stored VetKD key name/public key remain unchanged; legacy sheets are identified as `vetkd-v1`.
3. Explicitly acquires the account root and derives the legacy sheet key. Both match the original bytes. Migrating the sheet stores a recipient envelope without changing the profile, entry/history ciphertext, or delivery private/public key and mutation epoch.
4. Performs a second real upgrade. The vault, wrapping registry, and cached root receipt survive. Recovery-code unlock recovers the same root without another derivation; the migrated envelope decrypts the original sheet name, current entry, and historical entry. The unchanged consumer ciphertext opens to the original private JWK and public SPKI.
5. Checks stale CAS rejection, matching-request cached replay, changed-transport rejection, the 24-hour emergency limit, idempotent random-sheet creation, and rejection of legacy VetKD fallback for a `random-v2` sheet.

There were **four intentionally dispatched derivations**: old consumer root, old sheet key, new explicit account-root acquisition, and explicit legacy-sheet migration. Matching receipt replays and negative admission tests do not dispatch another derivation by backend control flow. This harness does not instrument the management canister's internal call counter. Consumer compatibility is exercised through the exact existing HKDF/AES-GCM wire format and verifies both original key components; full browser/UI behavior is a separate acceptance check.

## Reviewed bounds and limitations

- Vault payload: 65,536 bytes; at most 10,000 vault/root/principal-budget records per corresponding map. Wrapping public keys are immutable once published; rotation needs an explicit migration protocol.
- Global paid admission: burst 32, refill one per hour. Per-principal admission: burst 8, refill one per hour. All five paid entry points share this budget, including the four retained legacy endpoints. Admission is debited before the cross-canister await and is not refunded after dispatch.
- Root history retains eight receipts, not eight lifetime recoveries. Different requests require explicit emergency mode and a 24-hour cooldown. Pruned IDs cannot dispatch again because the timestamp watermark persists. Eight genuinely pending requests require manual reconciliation; completed/unknown receipts may be pruned. An uncertain original call may already have incurred a fee.
- Random-sheet creation receipts/tombstones are bounded at 10,000; invitation envelopes at 4,096 records of at most 4,096 bytes. These are explicit deployment-capacity choices, not an unbounded-growth claim.
- New random-sheet keys never silently fall back to legacy derivation. Legacy DEV-simulation sheets must not be confused with actual production VetKD legacy sheets when validating migration.
- One initial paid account derivation is the normal setup path, not an unconditional lifetime guarantee. A clean device needs an independent retained recovery method; explicit emergency recovery may derive again. Existing ciphertext recipients cannot be made to forget keys they previously obtained.
- This is local compatibility/security regression evidence, not mainnet deployment approval or a substitute for independent review.

## Live encrypted inbox and two-member invitation acceptance

The dedicated specs are `test/ui/accountVaultInbox.local.spec.ts` and `test/ui/accountVaultInvite.local.spec.ts`. Both ran successfully against the new-schema Wasm SHA-256 `09B6C92B048B69486E2496D8AC4F0DCCE06149F6ED52C129A6AA578B2D1295E8`, freshly installed on isolated synthetic canister `75lp5-u7777-77776-qaaba-cai` at `http://127.0.0.1:49175`. The frontend was `http://localhost:4310`, with production encryption and synthetic local development identities. The specs require an explicit canonical `IOU_TEST_VAULT_CANISTER`, check that the running frontend uses it, and block requests outside those two exact loopback origins or to another canister. This ID/gateway is a temporary local fixture, not a deployment target.

Exact successful invocations from the repository root:

```powershell
$env:IOU_TEST_VAULT_CANISTER = '75lp5-u7777-77776-qaaba-cai'
pnpm exec playwright test --config test/ui/accountVaultInbox.local.config.ts
pnpm exec playwright test --config test/ui/accountVaultInvite.local.config.ts
```

- **Inbox: 1 passed (12.9 seconds).** A fresh account bootstraps its root, creates a random-key sheet, uses the actual vault-backed consumer keypair, creates and reconnects generic durable-inbox grants, and deposits a locally encrypted synthetic delivery through the actual actor endpoint. The test verifies pending decryption, reloads to discard session-only keys, saves through the real review/add-entry UI, reloads again, decrypts the persisted ledger ciphertext, and checks the already-saved receipt via an idempotent acknowledgement replay. Reconnect preserves the consumer public key and mutation epoch.
- **Invitation and next shared sheet: 1 passed (19.4 seconds).** Two fresh accounts each bootstrap once. The creator's real invite UI uploads an encrypted sheet-key envelope; only an independent invitation secret travels in the URL fragment. The recipient accepts through the real UI and decrypts the sheet name and existing entry, including after reload. Closing and starting a new sheet creates a distinct `random-v2` key ID with both recipient envelopes; both accounts decrypt its next entry. The recipient can still decrypt the archived original.
- CBOR-decoded request monitoring observes **exactly one `acquire_account_root` call per synthetic user**, with no subsequent `acquire_account_root`, `vetkd_wrap_consumer_key`, `vetkd_wrap_sheet_key`, `openchat_card_context`, or `openchat_private_match_context` calls in these scenarios. This counts actual application RPCs, not management-canister internal calls or mainnet fees.
- Browser identities, private keys, PRF outputs and recovery codes are not exported or logged. The synthetic invitation capability is transferred only in memory; traces, screenshots and video are disabled. No real OpenChat messages, existing user accounts, mainnet canisters or recovered replica data are involved. The tests retain their synthetic ledger history and do not delete existing data.
- These tests cover the generic encrypted delivery/inbox protocol locally, not a live OpenChat APK service connection or a guarantee of Google Password Manager synchronization. The four spec/config files also pass a separate TypeScript check.
