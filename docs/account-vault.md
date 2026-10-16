# IOU account keys and recovery

IOU production mode uses one deterministic account root, locally generated sheet keys, and encrypted online backups. The normal paid operation is the first account-root bootstrap for an IOU principal and backend. Reloading, reopening a browser, creating another sheet, and connecting OpenChat do not derive another VetKey.

This changes IOU's frontend and backend only. OpenChat continues to use the existing generic app connection, reviewed card and encrypted inbox delivery interfaces. No official OpenChat canister change or model prompt change is required.

The password-manager recovery update uses that existing backend protocol and changes only the IOU frontend. The normal UI now offers only a verified ordinary password-manager recovery credential for free cross-device recovery; encryption-passkey enrollment and unlock controls have been removed at the user's request. Internet Identity passkey sign-in is unchanged. Existing PRF backup data is preserved, but no longer offered as an alternative in the UI or accepted alone as completed recovery setup. No backend upgrade or OpenChat APK rebuild is required. The manager-only frontend is active locally and on mainnet; see the [2026-10-15 publication record](../deployments/mainnet-20261015-manager-only.json) and [validation report](account-vault-browser-validation.md#manager-only-recovery-ui--2026-10-15).

## User workflow

1. Sign in with the existing Internet Identity. For a new encrypted account, IOU starts the one-time account-root bootstrap automatically and saves a protected device copy. There is no separate initial setup confirmation. An interrupted or uncertain request is reconciled rather than replaced with another paid request.
2. IOU automatically prepares a missing or unverified **IOU encryption recovery** entry once the account is unlocked. There is no initial Prepare button or Settings detour. Save that entry in the existing password manager, then retrieve it in the separate verification step. IOU generates a random 256-bit secret; this is not a password chosen or memorized by the user. Only after the retrieved secret decrypts the persisted backup of the original root does this method satisfy recovery setup. An unlocked account with only a legacy encryption-passkey backup must now save and verify the manager entry; doing so reuses its root and incurs no VetKD derivation. An already verified backup is not automatically regenerated or offered for resaving.
3. Continue using the normal accounts, sheets and entries UI. Each new sheet generates an independent random key on the device and stores only recipient-bound encrypted copies online.
4. Reloading or restarting the browser restores its valid sign-in and protected root. There is no inactivity logout. The actual Internet Identity delegation can still expire; authenticating again does not itself incur a VetKD derivation if the device key remains available.
5. On another device, open the same IOU origin and sign in to the same Internet Identity. Retrieve or explicitly autofill the saved recovery credential from the password manager. IOU downloads the encrypted vault, decrypts and validates its original root locally, then remembers a protected device copy. Existing sheet keys are downloaded as ciphertext and opened locally. This does not derive another VetKey.
6. If the saved recovery credential and remembered device keys are all unavailable, **Recover encryption access (paid VetKD)** remains an explicit last resort after signing in to the same identity. It re-derives the original account root, not a replacement root or a new sheet key. It is never selected automatically because a password-manager save or unlock failed. Verify the manager backup before returning to normal use.
7. Explicit sign-out removes this account's protected local root and pending recovery transport, and clears session key material. It does not delete the online encrypted backup or entries. Same-origin tabs receive a principal-scoped logout signal. Delegation expiry clears in-memory access but retains protected device recovery data.

This is **Internet Identity sign-in plus a separately saved recovery credential**, not II-only or passkey-only recovery. Microsoft Password Manager can retain the ordinary credential without providing WebAuthn PRF. Actual saving, retrieval, synchronization and availability depend on the password manager and browser; see the verification limits below.

### Password-manager setup, verification and failures

Creating this backup requires access to the existing account root on an unlocked device. IOU seals that root with the generated recovery secret and writes only the encrypted backup online. A separately encrypted copy of the secret, protected by the account root, lets the same unlocked account resume saving the original credential after a reload. This does not make the secret recoverable from Internet Identity authentication alone: a locked device still needs the saved credential, another unlocked session, or explicit paid emergency recovery.

Preparation is automatic, but opening the password-manager save prompt and verifying the saved entry remain explicit actions. Cancelling stops the current view; a manual retry or a later visit resumes the same encrypted candidate. A failure does not start a retry loop or paid recovery. Concurrent mounted views share one preparation operation, and account/session changes discard stale UI results. A locked device only reads the existing recovery descriptor; it does not generate a new secret.

The same check applies after authentication on standalone OpenChat connection/import pages, including when no connection request or encrypted draft has arrived yet. Transport listeners remain mounted while the recovery screen is visible, so completing recovery does not discard a pending request. Anonymous sign-in and anonymous card/processor surfaces remain unchanged. This closes a route-coverage gap in the initial automatic-preparation release; it is not evidence that a particular past login used one of those routes.

Saving and verification are separate actions. A successful `navigator.credentials.store(...)` call, a dismissed browser prompt, or the presence of the original root in this browser is not proof of a usable password-manager backup. Verification retrieves the exact account/deployment-specific credential, or accepts its explicit password-manager autofill, and decrypts the persisted root backup. IOU checks the original root and wrapping keypair before recording success. It does not rotate the root, sheet keys, delivery keys, existing recovery codes or PRF backups.

If saving is cancelled, the browser API is unsupported, the wrong credential is returned, verification fails, or a vault update cannot be confirmed, recovery setup remains incomplete. Retain the protected account root and any pending bootstrap request. Retry using the same candidate rather than generating another secret or purchasing recovery. Do not clear site data, sign out or delete the original credential merely to restart setup. An uncertain online outcome is reconciled by reading the stored record; it is not permission to overwrite a concurrently updated backup.

The remembered root belongs to the same browser profile and IOU origin, not every browser on that device. Switching browsers before a free recovery method has been verified does not transfer that copy. Explicit sign-out removes the local root as described above, but does not delete the separately saved password-manager credential or encrypted online backup.

Credential retrieval is origin-bound. Use the same HTTPS IOU origin on the devices being tested; a different scheme, host or port is not assumed to share credentials. An account/deployment-specific username prevents selecting another account's saved secret. Changing the frontend origin requires making the same credential available and verifying it at that origin while the account can still be unlocked. The implementation does not bypass password-manager origin restrictions or promise that a credential saved for localhost will autofill at a production or Tailscale address.

After paid emergency recovery, a marker in the existing protected device record requires a confirmed free backup. Reloading and ordinary key restoration preserve the marker; an old inaccessible backup record cannot bypass it. Successful retrieval/decryption of the matching committed manager backup clears it in the normal UI. Existing server-side backups are retained.

Successful verification proves that the credential can decrypt this vault through the tested browser flow. It does **not** prove that Microsoft has synchronized it, that another device has received it, or that every provider/browser combination supports the APIs. Cross-device acceptance requires a separate signed-in device/profile with no remembered IOU root to retrieve the same credential and open the existing encrypted data. No new Microsoft cloud-sync acceptance is claimed solely by adding this implementation or passing mocked/isolated tests.

### Preserved legacy PRF backup data

The UI no longer offers saving, adding, checking or unlocking with an IOU encryption passkey. Existing encrypted PRF records and low-level compatibility code remain unchanged so this UI cleanup does not delete backups or rotate keys. They do not bypass the manager-verification gate. The Internet Identity login passkey is separate and remains usable for sign-in.

Before losing an unlocked session, users with only a PRF backup should save and verify the ordinary manager entry from that device. If all remembered devices and manager entries are unavailable, the normal UI offers only explicit paid emergency recovery. It does not silently invoke an older passkey or purchase recovery.

Historical low-level PRF validation requires a credential-get result for the same credential and salt and verifies the encrypted root round trip; merely saving a credential is not sufficient. These compatibility checks remain covered by unit tests but are not exposed as a recovery option.

The preserved low-level compatibility implementation retains its existing credential IDs, salts, ciphertext and authenticated context. No provider switch, automatic paid recovery, key replacement or backend change is part of removing the controls. Microsoft's observed missing PRF result is not claimed to be fixed.

Legacy recovery-code payloads and existing encrypted data are preserved for compatibility. The ordinary password-manager backup is a separate optional vault field; it does not overwrite an older recovery-code envelope. The normal workflow saves and retrieves a generated manager credential, not a human-chosen password or a code that the user must memorize. Previously generated legacy codes are not re-labelled as new manager backups.

## Costs

| Operation | VetKD derivations |
| --- | --- |
| First account-root setup | One |
| Normal reload or browser restart with remembered keys | Zero |
| New sheet, entry, or account pair under the same IOU user | Zero |
| New device retrieving the saved password-manager recovery credential | Zero |
| Creating, saving, verifying or re-saving a manager backup with the retained account root | Zero |
| OpenChat connect or reconnect and encrypted inbox delivery | Zero |
| Explicit emergency recovery after losing free methods | One account root |
| Automatic migration with an available original older-sheet key | Zero |
| Explicit recovery of a missing older-sheet key | One per older sheet |

“Zero” here means no threshold-key derivation, not free hosting, storage or update execution. The production key's published derivation fee is 26,153,846,153 cycles, approximately USD0.036 using the documentation's conversion rate. The canister pays; the USD approximation varies with the XDR rate. See the [ICP cycle-cost reference](https://docs.internetcomputer.org/references/cycle-costs/#vetkeys).

An interrupted call may already have spent its fee. Normal retry reuses the same protected request and cached encrypted response. Only a separately labelled new emergency action abandons that request and may pay again; a 24-hour cooldown applies. A definite cooldown/budget refusal happens before dispatch, clears only that unadmitted request, and requires another manual click later; it never retries automatically. This is not a promise of a single charge for the entire lifetime of an account regardless of loss or failure.

## Key hierarchy and existing data

- The root is exactly the historical consumer wrap key: VetKD input `iou-consumer:` plus the principal, followed by the existing `iou-consumer-key-v1:` HKDF. This preserves the current OpenChat consumer private-key ciphertext and profile-name ciphertext.
- The vault contains a locally generated P-256 wrapping keypair. Its private key is encrypted under a domain-separated root-derived AES-GCM key; the public key and fingerprint are registered only after its private counterpart is backed up.
- A managed recovery record contains an immutable random identifier, the original root encrypted with an independent 32-byte random recovery secret, the secret encrypted with a separately domain-separated root-derived key, and bounded origin verification metadata. The plaintext secret goes only to the user's password manager or explicit local autofill control, never into the online vault. Origin metadata records completed verification; it is not proof of cloud synchronization.
- Each new sheet uses a fresh 32-byte CSPRNG key and an immutable random key identifier, created before the backend assigns its sheet ID.
- A member's envelope uses ephemeral P-256 ECDH, HKDF and AES-GCM. Authenticated context includes the pair, immutable key ID, recipient principal and recipient wrapping-key ID. A copied envelope cannot be opened as another recipient or another sheet.
- Account-vault writes use compare-and-swap revisions. Concurrent initializers retain the winning canonical private key rather than overwriting it. New-sheet creation stores the encrypted name and both member envelopes atomically and is idempotent for the same key ID and body.
- New-sheet keys are never derived by the legacy VetKD sheet endpoint. Missing or corrupt envelopes fail closed; the client does not create a substitute key.

Legacy sheets retain their old key and ciphertext. Opening a sheet first reads its existing vault envelope. If it has none, IOU automatically backs up an available original key: either a validated live-session key or one decrypted with the device's original legacy keypair. This does not generate a replacement key or call VetKD. The encrypted backup is read back and verified before migration is considered complete.

Some historical production creation flows supplied a temporary self-wrapped key to satisfy the older backend API, while subsequent entries used the deterministic VetKD key. Such a wrapper (or a name encrypted under it) is not proof of the entry key. Migration checks original entry ciphertext first when entries exist, including for keys recovered from old wrappers; a mismatched placeholder is never installed as the new vault key. The existing wrapped slot is replaced only by an authenticated envelope of the verified actual key. Development-mode sheets that really used the old wrapped key remain recoverable.

If no original key is available, the sheet itself offers **Recover this sheet (paid VetKD)** followed by **Confirm paid recovery for this sheet**. Opening, reloading, checking for an available key, or cancelling never authorizes a paid request. Opening the same sheet on a device that still has its original key is the free alternative. Confirmation is scoped to the current sheet and signed-in account. A damaged modern envelope is an error, not permission to derive a substitute key.

Explicit recovery rechecks the free path first, makes at most one legacy derivation attempt, validates the result against existing authenticated sheet content, and backs up that same key. If a backup write cannot be verified, the recovered key is retained in the current session so **Retry securing this sheet (no VetKD)** does not pay again. Signing out or closing/reloading that session loses this unfinished in-memory key; a later explicit recovery might then charge again. An ambiguous derivation is never retried automatically. The durable request receipts described above apply to account-root recovery, not to the older sheet endpoint.

**Settings → Encryption recovery → Migrate older sheet keys** remains an optional bulk workflow. Its check can migrate available keys for free; it lists only the remaining missing keys before the explicit paid bulk action. Legacy metadata alone is not proof that an old development key was VetKD-derived: an unrelated derived key must never replace encrypted data, and recovery fails closed when it cannot authenticate existing content.

Older personal Types used a device-local pre-vault key. Their read-only migration source uses that original key when available; a missing key is reported instead of generating a different one. Current account-scoped Types use their sheet keys.

## OpenChat and invitations

OpenChat receives only IOU's public delivery key and approved app configuration. The existing consumer keypair is recovered from its original encrypted backup using the cached account root. Reconnecting does not rotate that key or invalidate pending entries.

The user reviews the proposed card in OpenChat. OpenChat encrypts the reviewed fields to the IOU recipient, and the existing inbox stores ciphertext. IOU decrypts with its delivery key and normal sheet key, then presents the existing pending-entry review and save workflow. Model and OCR prompts, card UI, and official OpenChat authentication are outside this change.

A missing date in a pending draft does not prevent opening IOU's existing review dialog. The date remains blank for correction rather than defaulting to today. Required-field validation still applies before saving, including every row in a batch; merely opening or cancelling review does not remove the pending delivery or save an entry.

For a new sheet invitation, IOU encrypts the existing sheet key under an independent random invitation secret. Only the encrypted envelope is stored against the expiring one-use code; the secret stays in the link fragment, not its query or the server request. The signed-in recipient decrypts locally and submits a copy sealed to their own vault key while accepting the invitation. Old keyless production invitations must be recreated after any necessary explicit migration. Link holders can gain the invited access: share the link privately.

Membership changes remove a departing member's stored envelope; this cannot revoke plaintext or keys that member already copied. A current authorized member can supply a recipient-bound copy for a missing current-recipient slot. No automatic whole-history re-encryption or stronger retroactive revocation is claimed.

## Device protection and authentication

The device root and unfinished paid-request secret are AES-GCM ciphertexts in IndexedDB, each with a nonextractable WebCrypto protector and authenticated account/deployment context. The protector and ciphertext are committed atomically. Production root and wrapping private-key plaintext are not placed in localStorage or sessionStorage.

This is software/browser-local protection, not a hardware-keystore guarantee. Same-origin malicious JavaScript can ask an available key handle to decrypt, and an unlocked compromised device may access all data authorized to that identity. A stolen device is not automatically safe merely because the UI has a lock screen. Keep the existing CSP and secure deployment protections.

The login uses the SDK's persisted delegation, requests up to 30 days, disables idle logout, and respects the shortest actual delegation expiry. Client logout clears local SDK state; it does not claim to revoke an already-issued delegation everywhere.

Password-manager recovery relies on the manager's protection and synchronization of an ordinary high-entropy credential. It is not a passkey assertion and does not inherit passkeys' phishing resistance: a user can disclose or autofill the secret to a malicious page, and same-origin malicious code can read it while it is available. Do not put the secret in URLs, logs, analytics, native form requests, localStorage or sessionStorage. Do not serialize credential objects. The online backup remains encrypted and cannot be decrypted with an ordinary Internet Identity assertion alone. Browser API success must not be represented as verified Microsoft cloud synchronization.

Optional passkey backups require user verification and the actual PRF result, not merely a provider feature claim. PRF results must never be logged or included in serialized credentials; the [WebAuthn PRF specification](https://www.w3.org/TR/webauthn-3/#prf-extension) defines the extension. A synthetic or virtual-authenticator test is not evidence that a physical provider flow or cross-device sync has been verified. Existing legacy recovery-code envelopes contain random high-entropy material and remain stored unchanged.

The vault's versioned scope currently includes the configured RPC host, backend canister and IOU principal. Keep the production RPC host pinned across releases and devices. Changing that host, even to another gateway for the same canister, requires a reviewed scope migration rather than silently changing configuration. Frontend origin changes also affect password-manager credential and passkey availability.

## Backend and recovery request boundaries

The backend stores opaque vaults, public wrapping keys, encrypted sheet/invitation envelopes and bounded root-request receipts. Existing memory IDs 0–37 are unchanged; the new storage uses 38–44. Existing VetKD key names are preserved across upgrades.

Each paid root request has a timestamped unique ID and pinned transport public key. The client saves its transport secret encrypted before dispatch; a browser restart can resume the same request. Known results are cached. Pending or unknown requests are never automatically re-dispatched.

New explicit emergencies can supersede an older unknown/pending request after 24 hours, while preserving its receipt for a late response. There are at most eight retained receipts with a monotonic admission watermark; completed/unknown receipts can be pruned, but eight genuinely pending requests require reconciliation rather than unbounded allocation. Paid calls share global 32 and per-principal 8 burst budgets with one-token-per-hour refill. Budget rejection does not waive authorization or cause an automatic retry.

Vaults are limited to 64 KiB and 10,000 registered accounts; invitation envelopes are limited to 4 KiB. There is no controller endpoint to read plaintext roots. A trusted canister upgrade and client distribution remain part of the security model.

## Local verification and deployment

Run `pnpm test`, `pnpm run typecheck`, the Rust tests in both default and `mainnet` configurations, and the browser/emulator account-vault acceptance harness. The harness uses a separate local PocketIC instance with test threshold keys, synthetic identities and a separate frontend origin. It must not fund or call production canisters or clear an existing browser/emulator profile.

See the [validation report](account-vault-validation.md) and [browser/emulator report](account-vault-browser-validation.md) for the actual results, pinned artifacts, reproduction commands and test limitations.

Initial activation of the account-vault protocol requires an IOU backend upgrade before the matching frontend is served. Once that protocol is installed, the password-manager recovery follow-up needs only an IOU frontend publication. The existing opaque, revision-controlled vault endpoint accepts the additional encrypted record; no new canister or IOU-operated key-storage service is introduced. Do not reset stable state, rotate the consumer keypair, or reinstall the backend. OpenChat requires no rebuild for this key-storage protocol itself. Local implementation and tests are not evidence that the deployed frontend contains the follow-up or that a real password-manager sync has passed.
