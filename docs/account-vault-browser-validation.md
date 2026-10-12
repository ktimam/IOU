# Account vault browser and emulator validation

Validated on 2026-10-13. The final combined Playwright run passed with exit code 0 in 2.5 minutes. This was real browser cryptography and a real local PocketIC backend, not mocked VetKD or mocked storage. No mainnet calls, funding, production deployment, phone interaction, existing-profile clearing, or restart of the existing local services occurred.

## Tested environment

- Latest default/dev Wasm SHA-256: `09B6C92B048B69486E2496D8AC4F0DCCE06149F6ED52C129A6AA578B2D1295E8`.
- Fresh local test canister: `75lp5-u7777-77776-qaaba-cai`; gateway `http://127.0.0.1:49175`.
- Separate frontend: `http://localhost:4310`, with production crypto enabled and synthetic development identities. The test verifies the selected canister and rejects unexpected canister targets before submitting requests.
- New PocketIC 11 server: control `http://127.0.0.1:45687`, instance `2`, fiduciary plus application subnets, with `dfx_test_key`. The older/recovered replica and frontend on port 3000 were not changed.
- Dedicated new desktop Chrome profile, plus Android emulator `emulator-5554` running Chrome 154. The emulator test creates and closes only its own tab at the new test origin; it does not close the browser or clear existing profiles.
- Actual WebAuthn PRF enrollment and unlock in desktop Chrome using a CDP virtual authenticator with resident-key and user-verification support.

## Successful acceptance checks

1. Fresh sign-in performs no paid derivation automatically. The explicit setup button submits exactly one `acquire_account_root` request, whose real VetKD response is verified and decrypted by the production adapter.
2. A recovery-code backup and a PRF-backed passkey backup are published. The recovery code is kept in test-process memory only and hidden before further UI work; credentials, PRF outputs and private keys are not logged.
3. Two new bookkeeping accounts/sheets are created using local random keys. An entry is encrypted, saved, read and read again after reload. No additional paid-key endpoint is called.
4. A clean second desktop context receives only the synthetic sign-in identity and recovery code, not IndexedDB or vault keys. It unlocks the same account and decrypts the saved entry without VetKD.
5. A new Android Chrome tab unlocks with the same recovery code, decrypts that entry, reloads and decrypts again. Explicit sign-out removes access; restoring only authentication leaves encryption locked. No paid-key endpoint is called on Android.
6. Desktop explicit sign-out clears the local vault. The previously enrolled PRF passkey unlocks it without VetKD.
7. The dedicated desktop Chrome process is actually closed and reopened with its test profile. Authentication and protected device storage restore the original encrypted entry without another derivation.
8. Signing out in one tab removes the decrypted entry from a second tab. Reauthentication alone leaves the vault locked. Auth unit tests additionally cover a late cross-tab IndexedDB write, account switching during purge, and purge failure remaining locked.
9. An explicit emergency request is rejected by the real backend's 24-hour cooldown. Only the owned isolated PocketIC instance is advanced by 24 hours plus one minute, and only the dedicated desktop context's clock is aligned. A second explicit click on the **same page**, without logout or reload, succeeds and decrypts the original ciphertext.

Observed paid-capable RPCs across this journey were one successful bootstrap, one cooldown-rejected emergency request, and one successful emergency retry. The rejected request does not dispatch a threshold derivation by backend admission logic. No sheet or consumer legacy derivation was observed. The test does not instrument the management canister's internal call counter, and local test cycles are not mainnet spending.

The final run blocked no external requests. Earlier harness runs exposed an invalid bare-IP WebAuthn RP ID, stale form/copy selectors, a transient PocketIC clock `409 Busy` response, and an Android asset-loading wait. The successful harness uses `localhost`, current selectors, bounded retries only for the isolated clock API, and a focused mobile test tab with a bounded 60-second visibility assertion. Paid canister calls are never automatically retried by this harness.

## Reproduction

The scripts are [the local install/serve helper](../scripts/live/account-vault-isolated.mjs), [the test](../test/ui/accountVault.local.spec.ts), and [its separate configuration](../test/ui/accountVault.local.config.ts). They are separate from the existing port-3000 UI suite.

First create a **fresh, owned** isolated PocketIC instance at real time. For PocketIC 11, include a fiduciary subnet for `dfx_test_key` and an application subnet. Later PocketIC versions have different threshold-key subnet configuration. Use an unused loopback gateway and verify the exact target before any clock administration. The recorded test configuration uses gateway 49175 and frontend 4310; these must not point at an existing user environment.

Install the hash-pinned local artifact and use the returned fresh canister ID:

```powershell
node scripts/live/account-vault-isolated.mjs install http://127.0.0.1:49175 target/wasm32-unknown-unknown/release/iou_backend.wasm 09B6C92B048B69486E2496D8AC4F0DCCE06149F6ED52C129A6AA578B2D1295E8
node scripts/live/account-vault-isolated.mjs serve http://127.0.0.1:49175 <fresh-local-canister-id>
```

The helper sets `VITE_IOU_PROD_VETKD=1`, local-network configuration and `VITE_DFX_PORT`. It leaves `VITE_IC_URL` empty because that separate setting accepts development HTTPS LAN origins, not HTTP loopback. Open the helper server in a separate terminal or hidden process; do not restart existing services.

For the optional emulator branch, forward only the selected new test ports on the authorized emulator and open the test origin in Chrome. Do not clear app data or stop existing apps:

```powershell
adb -s emulator-5554 reverse tcp:4310 tcp:4310
adb -s emulator-5554 reverse tcp:49175 tcp:49175
adb -s emulator-5554 shell am start -a android.intent.action.VIEW -d http://localhost:4310 -p com.android.chrome
adb -s emulator-5554 forward tcp:49310 localabstract:chrome_devtools_remote
```

Exact successful final test invocation (replace the canister/control/instance values only with the newly verified owned fixture):

```powershell
$env:IOU_TEST_VAULT_CANISTER='75lp5-u7777-77776-qaaba-cai'
$env:IOU_TEST_POCKETIC_CONTROL_URL='http://127.0.0.1:45687'
$env:IOU_TEST_POCKETIC_INSTANCE='2'
$env:IOU_TEST_EMULATOR_CDP='http://127.0.0.1:49310'
$env:IOU_TEST_ADVANCE_CLOCK='1'
node node_modules/@playwright/test/cli.js test --config test/ui/accountVault.local.config.ts
```

Do not run another test against the same instance while this test advances its clock. **The recorded fixture is now more than 24 hours ahead.** Future runs should create a fresh isolated instance or deliberately align all test clocks; ordinary real-time clients must not reuse the advanced fixture as if it were unchanged. Never advance or reset an existing user replica to make this test pass.

The successful nonsecret log is a temporary artifact at `F:/Temp/OpenChat-IOU/account-vault-isolated-20261014-0135/browser-final.log`. Traces, screenshots and videos are disabled. New synthetic browser profiles and test outputs are temporary artifacts, not repository inputs.

## Scope and limitations

- Browser authentication in this test is the existing synthetic DEV identity path. Real Internet Identity delegation persistence/expiry is covered by source-level lifecycle tests, not by a live II sign-in or a physical authenticator in this run.
- PRF results are produced by Chrome's actual WebAuthn implementation with a virtual test authenticator. Physical Google Password Manager/iCloud/provider synchronization, hardware protection and physical-phone prompts are not established by this test.
- Android coverage is Chrome on the authorized emulator, not the native IOU secure-storage adapter and not a rebuilt OpenChat APK. The unchanged generic OpenChat delivery and invitation flows have separate successful tests in [the main validation report](account-vault-validation.md).
- Nonextractable IndexedDB protectors are software/browser-local protection, not an XSS or hardware-keystore boundary.
- This report proves local behavior against the pinned artifact. It does not claim that mainnet has been upgraded.
