# IOU account keys and recovery

IOU production mode uses one deterministic account root, locally generated sheet keys, and encrypted online backups. The normal paid operation is the first account-root bootstrap for an IOU principal and backend. Reloading, reopening a browser, creating another sheet, and connecting OpenChat do not derive another VetKey.

This changes IOU's frontend and backend only. OpenChat continues to use the existing generic app connection, reviewed card and encrypted inbox delivery interfaces. No official OpenChat canister change or model prompt change is required.

## User workflow

1. Sign in with the existing Internet Identity. For a new encrypted account, choose **Set up account encryption**. IOU explicitly requests the root once and saves a protected device copy.
2. Add an **IOU encryption passkey**, or create and privately save a recovery code. The encryption passkey is separate from the Internet Identity sign-in passkey. A provider without WebAuthn PRF support is rejected clearly; use the recovery code instead. No weaker password-derived replacement is silently installed.
3. Continue using the normal accounts, sheets and entries UI. Each new sheet generates an independent random key on the device and stores only recipient-bound encrypted copies online.
4. Reloading or restarting the browser restores its valid sign-in and protected root. There is no inactivity logout. The actual Internet Identity delegation can still expire; authenticating again does not itself incur a VetKD derivation if the device key remains available.
5. On another device, sign in to the same identity, then unlock encryption using the same synced IOU encryption passkey or the recovery code. Existing sheet keys are downloaded as ciphertext and opened locally. An already-unlocked device can create a code to transfer access without a paid recovery.
6. If all free unlock methods and remembered device keys are lost, use **Recover encryption access (paid VetKD)** after signing in to the same identity. This re-derives the original account root, not a replacement root or a new sheet key.
7. Explicit sign-out removes this account's protected local root and pending recovery transport, and clears session key material. It does not delete the online encrypted backup or entries. Same-origin tabs receive a principal-scoped logout signal. Delegation expiry clears in-memory access but retains protected device recovery data.

Creating another recovery code replaces the previous code. Keep the displayed code even if an interrupted update reports an uncertain outcome. Up to eight encryption passkey backups are supported. Passkeys are tied to the IOU relying-party domain; a different domain needs an existing-device/code unlock or explicit emergency recovery.

## Costs

| Operation | VetKD derivations |
| --- | --- |
| First account-root setup | One |
| Normal reload or browser restart with remembered keys | Zero |
| New sheet, entry, or account pair under the same IOU user | Zero |
| New device using an encryption passkey or recovery code | Zero |
| OpenChat connect or reconnect and encrypted inbox delivery | Zero |
| Explicit emergency recovery after losing free methods | One account root |
| Explicit migration of an older unmigrated sheet key | One per older sheet |

“Zero” here means no threshold-key derivation, not free hosting, storage or update execution. The production key's published derivation fee is 26,153,846,153 cycles, approximately USD0.036 using the documentation's conversion rate. The canister pays; the USD approximation varies with the XDR rate. See the [ICP cycle-cost reference](https://docs.internetcomputer.org/references/cycle-costs/#vetkeys).

An interrupted call may already have spent its fee. Normal retry reuses the same protected request and cached encrypted response. Only a separately labelled new emergency action abandons that request and may pay again; a 24-hour cooldown applies. A definite cooldown/budget refusal happens before dispatch, clears only that unadmitted request, and requires another manual click later; it never retries automatically. This is not a promise of a single charge for the entire lifetime of an account regardless of loss or failure.

## Key hierarchy and existing data

- The root is exactly the historical consumer wrap key: VetKD input `iou-consumer:` plus the principal, followed by the existing `iou-consumer-key-v1:` HKDF. This preserves the current OpenChat consumer private-key ciphertext and profile-name ciphertext.
- The vault contains a locally generated P-256 wrapping keypair. Its private key is encrypted under a domain-separated root-derived AES-GCM key; the public key and fingerprint are registered only after its private counterpart is backed up.
- Each new sheet uses a fresh 32-byte CSPRNG key and an immutable random key identifier, created before the backend assigns its sheet ID.
- A member's envelope uses ephemeral P-256 ECDH, HKDF and AES-GCM. Authenticated context includes the pair, immutable key ID, recipient principal and recipient wrapping-key ID. A copied envelope cannot be opened as another recipient or another sheet.
- Account-vault writes use compare-and-swap revisions. Concurrent initializers retain the winning canonical private key rather than overwriting it. New-sheet creation stores the encrypted name and both member envelopes atomically and is idempotent for the same key ID and body.
- New-sheet keys are never derived by the legacy VetKD sheet endpoint. Missing or corrupt envelopes fail closed; the client does not create a substitute key.

Legacy sheets retain their old key and ciphertext. **Settings → Encryption recovery → Migrate older sheet keys** first performs a read-only scan, displays the number and estimated cost, then performs only the explicitly selected migration. Successful keys are retained if a later migration fails. There is no automatic paid fallback on a sheet read, and no automatic retry of an ambiguous migration.

Older personal Types used a device-local pre-vault key. Their read-only migration source uses that original key when available; a missing key is reported instead of generating a different one. Current account-scoped Types use their sheet keys.

## OpenChat and invitations

OpenChat receives only IOU's public delivery key and approved app configuration. The existing consumer keypair is recovered from its original encrypted backup using the cached account root. Reconnecting does not rotate that key or invalidate pending entries.

The user reviews the proposed card in OpenChat. OpenChat encrypts the reviewed fields to the IOU recipient, and the existing inbox stores ciphertext. IOU decrypts with its delivery key and normal sheet key, then presents the existing pending-entry review and save workflow. Model and OCR prompts, card UI, and official OpenChat authentication are outside this change.

For a new sheet invitation, IOU encrypts the existing sheet key under an independent random invitation secret. Only the encrypted envelope is stored against the expiring one-use code; the secret stays in the link fragment, not its query or the server request. The signed-in recipient decrypts locally and submits a copy sealed to their own vault key while accepting the invitation. Old keyless production invitations must be recreated after any necessary explicit migration. Link holders can gain the invited access: share the link privately.

Membership changes remove a departing member's stored envelope; this cannot revoke plaintext or keys that member already copied. A current authorized member can supply a recipient-bound copy for a missing current-recipient slot. No automatic whole-history re-encryption or stronger retroactive revocation is claimed.

## Device protection and authentication

The device root and unfinished paid-request secret are AES-GCM ciphertexts in IndexedDB, each with a nonextractable WebCrypto protector and authenticated account/deployment context. The protector and ciphertext are committed atomically. Production root and wrapping private-key plaintext are not placed in localStorage or sessionStorage.

This is software/browser-local protection, not a hardware-keystore guarantee. Same-origin malicious JavaScript can ask an available key handle to decrypt, and an unlocked compromised device may access all data authorized to that identity. A stolen device is not automatically safe merely because the UI has a lock screen. Keep the existing CSP and secure deployment protections.

The login uses the SDK's persisted delegation, requests up to 30 days, disables idle logout, and respects the shortest actual delegation expiry. Client logout clears local SDK state; it does not claim to revoke an already-issued delegation everywhere.

Recovery codes contain random high-entropy material, not user-chosen passwords. Passkey backups require user verification and the actual PRF result, not merely a provider feature claim. PRF results must never be logged or included in serialized credentials; the [WebAuthn PRF specification](https://www.w3.org/TR/webauthn-3/#prf-extension) defines the extension.

The vault's versioned scope currently includes the configured RPC host, backend canister and IOU principal. Keep the production RPC host pinned across releases and devices. Changing that host, even to another gateway for the same canister, requires a reviewed scope migration rather than silently changing configuration. Frontend domain changes also affect passkey availability.

## Backend and recovery request boundaries

The backend stores opaque vaults, public wrapping keys, encrypted sheet/invitation envelopes and bounded root-request receipts. Existing memory IDs 0–37 are unchanged; the new storage uses 38–44. Existing VetKD key names are preserved across upgrades.

Each paid root request has a timestamped unique ID and pinned transport public key. The client saves its transport secret encrypted before dispatch; a browser restart can resume the same request. Known results are cached. Pending or unknown requests are never automatically re-dispatched.

New explicit emergencies can supersede an older unknown/pending request after 24 hours, while preserving its receipt for a late response. There are at most eight retained receipts with a monotonic admission watermark; completed/unknown receipts can be pruned, but eight genuinely pending requests require reconciliation rather than unbounded allocation. Paid calls share global 32 and per-principal 8 burst budgets with one-token-per-hour refill. Budget rejection does not waive authorization or cause an automatic retry.

Vaults are limited to 64 KiB and 10,000 registered accounts; invitation envelopes are limited to 4 KiB. There is no controller endpoint to read plaintext roots. A trusted canister upgrade and client distribution remain part of the security model.

## Local verification and deployment

Run `pnpm test`, `pnpm run typecheck`, the Rust tests in both default and `mainnet` configurations, and the browser/emulator account-vault acceptance harness. The harness uses a separate local PocketIC instance with test threshold keys, synthetic identities and a separate frontend origin. It must not fund or call production canisters or clear an existing browser/emulator profile.

See the [validation report](account-vault-validation.md) and [browser/emulator report](account-vault-browser-validation.md) for the actual results, pinned artifacts, reproduction commands and test limitations.

Mainnet activation requires an IOU backend upgrade before the matching frontend is served. Do not reset stable state, rotate the consumer keypair, or reinstall the backend. OpenChat requires no rebuild for this key-storage protocol itself. The local implementation and tests are not evidence that the deployed mainnet frontend/backend already contain it.
