# Account vault browser and emulator validation

## Direct existing-account follow-up — 2026-10-16

The user confirmed the missing recovery screen occurred after opening IOU directly. The standalone connection/import correction below therefore does not explain that report. No direct fresh-sign-in bypass was found in the current authentication, vault-state or render-gate code. All 139 focused sign-in/recovery unit tests passed.

The user further confirmed that accounts or a sheet opened normally, rather than remaining on sign-in or merely missing the provider's save popup. A source/receipt comparison found a relevant historical exception: release `5f86395` accepted a saved same-host PRF backup **or** an exact-origin verified manager backup once the root was available. Release `0c870fa` removed that alternative; `1babcfb` retains the identical manager-only gate and adds automatic preparation. Their successful October 15 asset-sync completion times were respectively 16:47:52, 17:15:41 and 18:50:18 Cairo time. These publication receipts do not establish which JavaScript version the earlier user tab executed. An already-loaded document can retain earlier code across publication, but this remains a possible explanation, not an established cause. No new runtime change or paid recovery was performed on that basis.

One additional real-browser regression passed in 21.4 seconds against a fresh isolated local backend. It seeds a synthetic existing vault with a remembered root, an encrypted PRF-shaped compatibility backup and a sheet before mounting authenticated UI. Direct `/sign-in`, `/pairs`, sheet navigation and reload all require manager setup, automatically reuse the same recovery candidate and preserve the existing root and backup. It observed zero paid-capable calls, external requests or uncaught page errors. The node TypeScript check passed. This is current-code compatibility coverage, not an actual historical-build upgrade, Internet Identity login or Microsoft synchronization test. Two earlier attempts failed in the test harness before seeding; their logs are retained separately.

Safe observation of the existing mainnet capture tab found `/sign-in`, the published `main-CqFnPO7x.js` bundle, the **Save your recovery entry** heading and a generated password control. No input values, credentials or private storage were read. This confirms automatic preparation is visible now, not why the earlier screen was absent. Preparation is automatic; saving to a password manager and verifying the saved entry are separate explicit actions. Verification does not independently prove a provider has synchronized its copy.

No runtime code or deployment changed during this direct-route investigation. The disposable fixture was stopped; normal local services and the user's Edge session remain intact. Evidence is under `F:/Temp/OpenChat-IOU/direct-recovery-gate-20261016/`. The earlier omission remains unreproduced, and the real-user mainnet recovery-cost capture remains incomplete.

## Standalone sign-in route coverage — 2026-10-16

The published October 15 build gated normal IOU pages immediately after authentication, but standalone `/openchat/connect` and `/openchat/import` mounted the recovery gate only after a pending setup request or one encrypted draft arrived. Signed-in waiting states could therefore omit recovery setup. This is a current-build coverage gap, not an assumption about an old service-worker cache. The user subsequently confirmed opening IOU directly, so this separate route fix does not explain the reported omission. Sheet access and active connect/import contents were already gated.

The scoped correction moves the existing gate around each session's rendered UI while leaving transport/session hooks mounted above it. No recovery cryptography, Internet Identity flow, paid endpoint, app contract, backend or OpenChat client changes are included.

Five of seven new executing route-render tests failed against the previous placement; all seven passed with the correction. The complete canonical suite passed 4,149 tests across 188 files, both TypeScript configurations passed, and independent security review found no blocking regression. Two isolated Chrome journeys passed (import 25.1 seconds; standalone connect HTML 21.4 seconds). Each made only one initial local-test account bootstrap, reused the same recovery candidate and encrypted vault revision across routes/reload, retained pending connection metadata across verification, and sent no automatic setup reply. No external request, plaintext recovery-secret request leak or uncaught page error was observed. These tests do not claim real Microsoft cloud sync, physical-device verification or new coverage of queued ciphertext/sign-out/expiry transitions.

Evidence is under `F:/Temp/OpenChat-IOU/recovery-route-gate-20261016/`, `standalone-recovery-gate-20261016/` and `recovery-route-gate-mainnet-20261016/`. Mainnet publication is not complete: the existing `iou-production` delegation expired. No automatic reauthentication, paid mainnet recovery or user credential read was performed. The current user capture tab was confirmed to run the October 15 main bundle and show recovery setup; the earlier direct-login omission is not explained by the standalone-route fix, and real recovery cost remains unmeasured.

The offline production build and 27 deployment guards passed. Its full suite passed 4,149 tests with only the same three inherited model-profile failures as the published baseline; no model source/configuration or those tests were changed. Local/Tailscale activation used verified backups, and both changed modules were verified over HTTP on ports 3000/3001 and the configured HTTPS endpoint. The disposable test fixture was stopped while normal services remained running. See the [candidate/local activation record](../deployments/mainnet-20261016-recovery-route-gate.json); this is not a mainnet publication receipt.

## Automatic preparation and incomplete-date review — 2026-10-15

Unlocked accounts now automatically prepare missing/unverified password-manager recovery entries. Saving and separate verification remain explicit, verified backups are not regenerated, cancellation stops the current view, and retries/reloads reuse the same candidate. Locked accounts do not prepare a new entry or trigger paid recovery. Independent security review checked scoped single-flight preparation, cancellation, stale-session invalidation and preserved existing keys.

All 4,141 canonical unit tests across 187 files passed, along with both TypeScript configurations. Six isolated real-crypto browser cases passed: manager recovery across fresh Edge contexts (35.1 seconds), original older-sheet migration (54.8 seconds), cancellation/setup/fresh storage/restart/shared logout/emergency (1.5 minutes), dated inbox review (46.8 seconds), missing-date inbox correction (50.7 seconds), and shared/successor sheets (1.1 minutes). No uncaught browser errors or external requests were observed. Ordinary recovery and reconnect paths made no additional paid-capable calls; deliberate historical/emergency tests used only the owned disposable test-key backend.

The missing-date case opened the existing review form with a blank date, rejected incomplete submission without writing or acknowledging, retained the same pending receipt across Cancel/reload, and saved exactly one entry with the explicitly corrected date. Encryption, destination binding, Type validation, strict final payload checks and replay protection remain unchanged. Batch correction retains every row and requires its missing date before saving. No real pending item was saved by these tests.

The browser harness uses synthetic authentication and synthetic password autofill; it is not proof of Microsoft cloud synchronization. Fixture and inbox logs are under `F:/Temp/OpenChat-IOU/auto-recovery-review-20261015/`; unit/type and release receipts are under `F:/Temp/OpenChat-IOU/auto-recovery-review-mainnet-20261015/receipts/`. The owned fixture was stopped after testing, leaving the user's local backend running.

Both local/Tailscale frontends were activated after verified backups and served the new modules with HTTP 200. The [frontend-only mainnet publication](../deployments/mainnet-20261015-auto-recovery-review.json) completed once; all 28 public asset hashes match the tested build, with unchanged backend/module/controller configuration. The signed-out Edge smoke check observed no page/console errors or failed requests. No real pending entry was saved and no paid mainnet recovery was invoked during verification.

The production-preserving candidate retains the same three inherited model-profile assertion failures. Its first run also failed an existing assertion searching random encoded ciphertext for short text fragments; the actual matching bytes were not retained. The unchanged focused encryption suite passed all 22 tests and the unchanged full diagnostic rerun passed 4,141 with only the three exact inherited model failures. Both receipts and the baseline hash comparison are retained; no test, encryption source or model profile was changed to obtain the rerun result.

Real-user recovery capture is prepared separately. The observer records only method counts and aggregate balances, never credentials, RPC arguments or storage contents; a balance window is not an exact per-user billing record. This is not yet a completed mainnet recovery-cost measurement.

## Manager-only recovery UI — 2026-10-15

At the user's request, setup, Settings and locked-account screens no longer expose encryption-passkey save/add/check/unlock actions. The recovery gate requires a manager backup verified for the exact origin; a saved PRF record alone no longer bypasses it. An unlocked PRF-only account can create that manager backup with its existing root and without a new derivation. A locked account without a manager entry or any remembered device can still explicitly request paid emergency recovery. No paid fallback starts automatically, and Internet Identity passkey sign-in is unchanged. Existing encrypted PRF records and low-level compatibility functions remain intact.

All 4,116 canonical-worktree unit tests passed, including 166 focused UI/onboarding/compatibility assertions. Both TypeScript configurations, the production build, 27 deployment guards and independent security review passed. The exact production-preserving snapshot passed 4,116 tests with the same three inherited model-profile assertions documented below; models and their tests were not changed in this release.

All five existing browser regressions were updated to use the manager-only UI and passed on a fresh isolated PocketIC backend: manager recovery across fresh Edge contexts (37.9 seconds), historical-key migration (55.0 seconds), cancellation/setup/fresh-storage/restart/shared-logout/explicit-emergency recovery (1.5 minutes), encrypted inbox reconnect/review/save (48.7 seconds), and shared/successor sheets (1.1 minutes). Every test asserts zero uncaught page errors and zero external requests. Normal recovery/reload/reconnect made no extra derivation; the deliberate historical and emergency cases retained explicit paid-call assertions. Tests use synthetic autofill and authentication, not real Microsoft synchronization. Legacy low-level PRF unit coverage remains; no browser path relies on the removed controls.

Local activation checked every frozen-source hash, backed up changed files and manifests, and updated only the existing local/Tailscale frontends. Both loopback servers and the configured Tailscale endpoint served the new controls with HTTP 200; a Playwright CLI Edge smoke check showed the normal Internet Identity sign-in page without console errors. The real local backend was not reset, upgraded or stopped.

The same tested frontend was published to mainnet via a single assets-only sync. All 28 public files matched their expected SHA-256 hashes, and the shipped code contains the manager controls but none of the four removed button labels. Both canisters remain Running with unchanged module hashes, controllers, stored VetKD key and public backend configuration. The signed-out Edge landing page and direct connection guard passed with no runtime/console errors or failed requests. No user recovery or save was performed on mainnet by deployment verification. No APK, registry, model or OpenChat change was required.

See the [manager-only publication record](../deployments/mainnet-20261015-manager-only.json). Evidence is under `F:/Temp/OpenChat-IOU/manager-only-mainnet-20261015/receipts/` and `F:/Temp/OpenChat-IOU/manager-only-recovery-20261015/`. Local activation backup/receipt are `manager-only-before/` and `manager-only-activation.json` under `F:/Temp/OpenChat-IOU/local-env-20261014/`. Refresh or close/reopen IOU, without clearing site data or signing out, to load the new UI.

## Mainnet frontend publication — 2026-10-15

The tested recovery frontend is published at `https://ouvuc-3iaaa-aaaag-azekq-cai.icp0.io`. The [deployment record](../deployments/mainnet-20261015-recovery-frontend.json) identifies the exact standalone release snapshot, production target and preserved hashes. Only the existing assets canister was synchronized: no backend upgrade, new canister, funding, OpenChat/APK change, registry change or model update occurred. The local/Tailscale environment remains unchanged.

The release retains the prior published model profile and app contracts and applies exactly 30 approved recovery source/test/documentation overlays. The clean candidate passed 293 focused recovery tests, 27 deployment guards, both TypeScript checks and the production build. Its full suite passed 4,115 tests and reproduced three existing model-profile assertion failures identically on the untouched published baseline. Those failures were not waived by changing tests or model configuration; no new recovery failure occurred. The earlier fully passing canonical-worktree result below used the canonical model profile, not this production-preserving snapshot.

The sync completed once and all 28 public files matched the candidate's SHA-256 values over the production gateway. Both canisters remained Running with unchanged module hashes, controllers, stored VetKD key and public backend configuration. Using the Playwright skill, an isolated signed-out Edge session displayed the Internet Identity sign-in button and the normal guarded connection page. It observed zero uncaught page errors, console errors, failed requests or localhost/Tailscale requests. This smoke check did not authenticate or perform a mainnet recovery, paid derivation, or entry mutation.

Integration review confirms that ordinary connection/reconnection, sheet setup, inbox decryption and entry save reuse the account vault, existing consumer delivery key and encrypted sheet-key envelopes. Routine reconnect preserves chat-to-sheet bindings. Explicit disconnect/reset is different and intentionally removes the local delivery key. Legacy missing-key recovery remains an explicit action on the affected sheet, not an automatic per-connect charge. Manager recovery and inbox reconnect/save have separate local acceptance coverage; no combined real-Microsoft-sync-to-inbox journey is claimed.

Refresh or close and reopen IOU to load the published frontend. Do not clear site data to update: that can remove protected local keys. Ordinary storage/transaction cycles still apply even when no VetKD derivation occurs. Full nonsecret receipts are under `F:/Temp/OpenChat-IOU/account-vault-mainnet-20261015/receipts/`.

## Automatic older-sheet migration — 2026-10-15

Opening an older sheet now automatically backs up an available, authenticated original key. Missing keys are handled on the sheet with a separate paid-recovery confirmation, not a Settings detour. This is an IOU frontend-only change: no canister upgrade, mainnet operation, OpenChat change, APK rebuild, or real-user paid recovery was needed.

The full unit suite passed **4,115 tests across 186 files**, including 32 sheet lifecycle tests and 20 original-device key recovery tests. Both TypeScript configurations and the production/PWA build passed. Scoped security review caught and verified the fix for historical production placeholders: wrapper/name key A must not override entries encrypted with key B. Candidates are checked against every bounded page of current entries and history before using name-only evidence. Corrupt modern envelopes, mixed keys, invalid pagination and excessive scans fail closed; no replacement key is invented.

The added repeatable case in `test/ui/accountVault.local.spec.ts` passed against a fresh, isolated PocketIC backend with real cryptography and synthetic authentication. It verified a genuine original development key auto-migrates with no sheet VetKD call, preserves the original ciphertext digest and opens after reload. A historical production fixture retained placeholder wrapper/name A and actual VetKD entry B: opening, cancelling, free rechecking and navigating away from confirmation made zero additional paid calls. Explicit sheet confirmation made exactly one additional `vetkd_wrap_sheet_key` call, preserved the original ledger ciphertext, and reload made no further paid call. Initial synthetic account setup and the deliberate old-data fixture derivation are counted separately. The manager-backed fresh-context recovery regression also passed. Both observed zero external requests and zero uncaught page errors.

An independent headed Edge CLI check blocked the synthetic `set_sheet_wrapped_key` write. The sheet displayed **Finish securing this sheet** with only **Retry securing this sheet (no VetKD)**. Restoring connectivity, clicking that button and reloading opened the sheet with zero paid sheet requests, zero external requests and zero uncaught page errors. Expected network-abort console errors were caused by the deliberate failure injection, not ignored runtime errors. The recovered key remained session-only until its encrypted backup was verified.

Fixture metadata and unit report: `F:/Temp/OpenChat-IOU/legacy-sheet-migration-20261015/`. The temporary frontend uses port 4310, the fresh local gateway 49175, and PocketIC control 45310 instance 0. This does not reuse or reset the user's running local backend on port 8080. No phone/emulator was connected in this run (`adb devices` was empty); this is desktop-browser acceptance, not a device or real Microsoft-sync claim.

Final regression run: all three vault browser cases passed again in 2.9 minutes (manager recovery 34.7 seconds, historical-key migration 52.8 seconds, optional PRF/restart/logout/emergency recovery 1.4 minutes). Encrypted-inbox and shared-invitation regressions passed separately in 42.4 and 59.7 seconds. All five flows assert zero uncaught page errors and zero external requests. Only the disposable fixture clock was advanced for the 24-hour cooldown check; do not treat that fixture as real time afterward.

Local activation was backup-first and verified every prior frozen-source hash. Receipt: `F:/Temp/OpenChat-IOU/local-env-20261014/legacy-sheet-migration-activation.json`; previous files and manifests: sibling `legacy-sheet-migration-before/`. Ports 3000/3001 and the existing Tailscale HTTPS route each returned HTTP 200 for the updated sheet recovery UI and verified-entry migration module. Refresh IOU before opening the affected sheet. Existing user data, account keys, backend IDs and running backend state were not reset, and no mainnet deployment or real-user paid recovery was performed.

## Password-manager recovery follow-up — 2026-10-14

The user approved an ordinary password-manager entry as an alternative to PRF. Internet Identity still authenticates the user; it does not itself supply the encryption secret. IOU prepares one random 256-bit recovery secret, saves only its encrypted backup online, and reuses that same secret on retries. A separate manager-retrieval/autofill and original-root decryption check is required. Existing PRF and legacy backups remain intact. This is frontend-only and does not deploy a canister or change OpenChat.

The final unit suite passes all 4,076 tests across 185 files, including 310 authentication/crypto tests across 19 files. Both TypeScript configurations and a production/PWA build pass. A repeatable manager-recovery journey was added to the existing `test/ui/accountVault.local.spec.ts` and passed in 35.2 seconds in fresh Edge contexts. It explicitly identifies its input as synthetic autofill, not a real Microsoft synchronization result.

The isolated Edge CLI journey used production WebCrypto and the real local backend with synthetic authentication. It verified cancel/reload/retry preserves the candidate; the verification field starts blank; wrong credentials stay locked; and a correct synthetic autofill unlocks the account. A normal sheet and encrypted entry were then created. A completely fresh browser context received only the synthetic authentication identity, not IndexedDB or root keys: it remained locked, rejected a wrong secret, decrypted the original entry with the correct one, and retained access after reload. The first context made one `acquire_account_root` call for setup; fresh-context unlock/reload made **zero** paid-capable calls. The test observed no plaintext recovery secret in requests, localStorage or sessionStorage, and no external requests. Secrets stayed in test-process memory; this is not a Microsoft sync test.

Edge exposed the actual `PasswordCredential` API and accepted the explicit store request. The subsequent required-mediation get returned no credential in the isolated profile; IOU reported that nothing was unlocked or changed. This confirms that store completion alone is not treated as verified recovery, **not** that Microsoft saved or synced the entry. Real Microsoft Password Manager save, sync, and autofill on a second device remain acceptance steps. No existing user profile or passkey was read, cleared or replaced.

Existing encrypted-inbox and shared-invitation browser regressions also passed (43.2 and 59.8 seconds). They retain the original delivery key, show and save Pending entries, decrypt shared/successor sheets, and observe no additional derivation beyond initial account setup. The updated UI still supports the optional PRF path. No phone or emulator was connected (`adb devices` returned an empty list), so no device test is claimed.

The optional PRF/restart/logout/emergency journey passed again in 1.4 minutes on stable source with a new strict assertion of zero uncaught page errors. An earlier run encountered development hot-reload AuthProvider errors while a source edit was in flight; its nominal success is not the clean acceptance result. The test now fails rather than merely logging runtime errors. Only the synthetic PocketIC clock was advanced for cooldown testing; this fixture must not be reused as real time. Fresh test pages explicitly align to its owned clock.

The approved overlay is active on the existing local frontends (ports 3000/3001) and the configured Tailscale HTTPS route; all three served the new recovery module with HTTP 200. Frozen-source hashes were checked before copying, prior files/manifests backed up, and manifests updated. Receipt: `F:/Temp/OpenChat-IOU/local-env-20261014/manager-recovery-activation.json`. No user keys, backend state, production deployment, APK, models or OpenChat code changed. Refresh the IOU page before testing. Enrollment must first happen in a browser that can already unlock the original account root.

Fixture: `F:/Temp/OpenChat-IOU/manager-recovery-20261014/fixture.json`; frontend `http://localhost:4310`, gateway `http://127.0.0.1:49175`, PocketIC 11 control `http://127.0.0.1:45309` instance 0, synthetic local canister `7tjcv-pp777-77776-qaaaa-cai`, pinned dev Wasm `09b6c92b048b69486e2496d8ac4f0dcce06149f6ed52c129a6aa578b2d1295e8`. No mainnet calls or funding. Logs are in that project-specific temp directory; CLI artifacts are under `output/playwright`.

The PRF failures below are retained as historical evidence. This alternative does not claim to repair Microsoft's missing PRF result.

The manager test passed a second time in 36.1 seconds after the isolated clock advances, using explicit clock alignment in both fresh contexts. The disposable frontend and PocketIC processes were then identity-checked and stopped; test state/logs remain under the project temp folder. The user's local/Tailscale services remain running.

## PRF request compatibility follow-up — 2026-10-14

A physical Microsoft Password Manager attempt returned a matching passkey without PRF output. This is not a sign-in/routing failure and does not establish that every Microsoft provider version lacks PRF. IOU previously used `eval` at enrollment but always `evalByCredential` at unlock, including a single credential. Both are standard, but Chromium maps them to distinct native Windows API fields.

The frontend now uses `eval` for a single eligible credential, and at most one exact-selected-credential `eval` after a successful multi-credential selection omits PRF. It never retries denial, malformed output, a wrong credential or failed decryption. Enrollment requires a real follow-up assertion, matching create/get output when supplied, and an encrypted-backup round trip before publication. Existing ciphertext, credential IDs, salts, scope and user-verification requirements are unchanged. No backend upgrade, key reset, provider switch or paid recovery is involved.

The focused PRF unit suite passed 31 tests, including a provider that only responds to plain `eval`, bounded multi-credential fallback, rejection boundaries, create/get mismatch, and offset `DataView`/typed-array PRF outputs. The isolated Edge 154.0.4258.62 check on Windows 11 build 26200 passed actual WebAuthn enrollment plus subsequent unlock using a disposable virtual PRF authenticator and synthetic in-memory keys. It made no IOU backend calls and used no user account; the only console error was the fixture's missing favicon. This is **not Microsoft Password Manager acceptance**. The user retried the deployed change with the existing Microsoft passkey and reported "the selected passkey returned no encryption result". **Physical Microsoft acceptance failed; this compatibility change is not a verified fix for that path.**

That error is reached only after the returned credential ID matches the saved backup, but `prf.results.first` is absent. The user confirmed direct selection of a Microsoft-synced passkey on this device, not a QR/other-device handoff. The diagnostic returned `output=results-absent; attachment=platform` in normal Edge and again in Edge InPrivate opened from the existing profile. Thus a PRF object is present without results; the failure precedes root decryption and persists with isolated site storage. This does not distinguish Edge, the Windows adapter, the selected credential, or Microsoft's provider implementation, and `platform` alone does not name a provider. The original enrollment provider has not been independently verified. Chromium forwards standard PRF inputs to Windows and only exposes the secret when Windows returns one; neither an ordinary authentication signature nor the public credential ID can replace it. No key reset, provider switch, paid recovery, or encryption-design fallback was performed after either failed retry.

The follow-up diagnostic keeps the existing failure code and adds only allowlisted response shape (`prf-absent`, `results-absent`, or `first-absent`) and normalized attachment (`platform`, `cross-platform`, or `unknown`) to the error. It never serializes a credential or extension object and adds no request, retry, logging, persistent diagnostic storage, or capability probe. Missing PRF support confirmation at enrollment is described as an observed response, not proof that every version of a provider is unsupported. These diagnostics are not a compatibility fix; a real Microsoft unlock and successful decryption are still required.

The diagnostic follow-up passed 235 auth/crypto unit tests across 18 files (36 PRF cases), both TypeScript configurations, and diff checks. The two real Microsoft attempts above remain failed acceptance results regardless of those automated passes. Edge automation was unavailable for the real InPrivate test: the normal browser window was launched without a new profile, and the user performed authentication and reported the result. No Microsoft credentials were exported, copied, or replaced.

The diagnostic fixture is outside the app, under `F:/Temp/OpenChat-IOU/local-env-20261014/prf-compat-check`; it is not a release page. Browser artifacts are under `output/playwright`. No existing browser profile or passkey was cleared.

## Mandatory-passkey follow-up — 2026-10-14

At this historical checkpoint, IOU automatically initialized a confirmed new encrypted account and required a verified encryption-passkey backup before normal access. The manager-backed recovery follow-up above supersedes this PRF-only gate. The October 13 journey below is historical evidence for the original protocol, not the current onboarding UI.

The frontend-only follow-up passed all 3,976 Vitest tests across 184 files, both TypeScript configurations, and a production/PWA build. The final desktop account-vault acceptance run passed in 43.4 seconds using real WebAuthn PRF, browser storage, and the real local PocketIC backend. It covers two locally generated sheet keys, encrypted entry reads, reload, a real browser-process restart, logout, passkey unlock, and explicit emergency recovery followed by mandatory replacement-passkey enrollment that remains required after reload. A clean second browser context stays locked rather than silently paying for recovery.

A separate Playwright CLI check used the actual frontend and local backend to exercise failures: cancelled credential creation, a virtual authenticator without PRF, reload before enrollment, and an online backup write whose readback was deliberately blocked. All remained gated. Restoring connectivity and choosing **Check saved passkey** confirmed the committed backup without creating another credential. The journey made exactly one `acquire_account_root` request, no legacy sheet/consumer derivation, no external requests, and no uncaught page errors. The cancellation test injected one `NotAllowedError`; unsupported PRF used the browser's actual virtual authenticator; the uncertain-write test forwarded the actual write before blocking its verification queries.

The encrypted-inbox acceptance also passed (13.6 seconds): reconnect retained the delivery key, ciphertext reached Pending, the normal UI saved the entry, its encrypted data persisted, and its Saved receipt was idempotent, with exactly one bootstrap and no extra paid derivation. Shared invitations and successor sheets passed separately (21.7 seconds). These checks use the same production encryption code and real local backend, not mocked crypto or response assertions.

The isolated fixture used frontend `http://localhost:4310`, local canister `7tjcv-pp777-77776-qaaaa-cai`, gateway `http://127.0.0.1:49175`, PocketIC 11 control `http://127.0.0.1:45835` instance `0`, and the same hash-pinned dev Wasm listed below. Only this owned fixture's clock was advanced for cooldown tests. Fresh test pages align their clock to the owned backend; ordinary clients must not reuse it as real time. Logs and generated builds are under `F:/Temp/OpenChat-IOU/mandatory-passkey-20261014`; successful logs are `account-vault-desktop-acceptance-2.log`, `account-vault-inbox-acceptance-3.log`, and `account-vault-invite-acceptance.log`.

No phone or emulator was connected for this follow-up. The virtual credential provider is retained for the free-unlock test while only its disposable synthetic account's vault IndexedDB is cleared: this proves recovery without a remembered root, **not** physical Google Password Manager synchronization. Physical-provider and emulator verification remain unperformed for this UI change. No mainnet calls, funding, publication, backend upgrade, APK rebuild, or changes to existing user profiles/services occurred.

## Historical protocol validation — 2026-10-13

The original combined Playwright run passed with exit code 0 in 2.5 minutes. This was real browser cryptography and a real local PocketIC backend, not mocked VetKD or mocked storage. No mainnet calls, funding, production deployment, phone interaction, existing-profile clearing, or restart of the existing local services occurred.

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
