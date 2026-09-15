# Durable live OpenChat + IOU profiles

Four users, each with an **OpenChat** surface + an **IOU** surface, all **CDP-controllable** and
**restorable after a restart** (the original setup broke because the OpenChat WebAuthn credentials
were ephemeral virtual-authenticator keys — lost on restart). This toolkit fixes that by **exporting
each credential's private key at signup** and re-injecting it on restore.

## Profiles / ports

| user | OpenChat | IOU | CDP port(s) |
|------|----------|-----|-------------|
| father | **desktop app** (`open-chat.exe`, WebView2 `com.oc.app`) | Chrome `father-iou` | OC 9222, IOU 9231 |
| manager | Chrome `manager` (tab :5003) | same Chrome (tab :3000) | 9241 |
| mother | Chrome `mother` | same Chrome | 9242 |
| child | Chrome `child` | same Chrome | 9243 |

Persistent Chrome user-data-dirs: `<live-profile-root>\profiles\<user>`.
Durable OpenChat credentials (incl. private key): `<live-profile-root>\creds\<user>.json`.

## Start the complete environment

Use one fail-closed entry point after a reboot instead of starting PocketIC, the two Vite servers,
and Tailscale routes independently:

```powershell
Copy-Item scripts/live/start-environment.config.example.json scripts/live/start-environment.local.json
# Fill every machine/state-specific value in the git-ignored local JSON, then:
pwsh -NoProfile -File scripts/live/start-environment.ps1 `
  -EnvironmentConfigPath scripts/live/start-environment.local.json
pwsh -NoProfile -File scripts/live/start-environment.ps1 -Action Status `
  -EnvironmentConfigPath scripts/live/start-environment.local.json
pwsh -NoProfile -File scripts/live/start-environment.ps1 -Action ValidateConfig `
  -EnvironmentConfigPath scripts/live/start-environment.local.json
pwsh -NoProfile -File scripts/live/start-environment.ps1 -Action FrontendRestart `
  -EnvironmentConfigPath scripts/live/start-environment.local.json
pwsh -NoProfile -File scripts/live/start-environment.ps1 -Action OpenChatFrontendRestart `
  -EnvironmentConfigPath scripts/live/start-environment.local.json
```

The start command reopens only the authoritative recovered PocketIC state, starts the exact OpenChat
and IOU Vite processes, and verifies the published IOU app, background/model workers, all-WebGPU
model routes, a restored original image, and both phone-facing Tailscale origins. An ephemeral
headless browser also loads OpenChat through loopback and Tailscale and requires successful
`worker.js` init plus anonymous-auth responses; it never opens a durable user profile. Set
`browserProbe.channel` to an installed `chrome` or `msedge` channel, or to `chromium` after running
`pnpm exec playwright install chromium`. The launcher and
PocketIC manager receive the same explicit JSON; neither script embeds a machine path, Tailnet host,
canister/app coordinate, topology fingerprint, model revision, or image blob identity. The local JSON
is ignored by git; the checked-in example contains placeholders only. Startup does not clean,
deploy, register, publish, reset, or repair canister state. Use `-RestartFrontends` when a Vite config
has changed. If the existing replica is healthy but its WSL process-manager context is temporarily
unavailable, `-Action FrontendRestart` first verifies the live replica and exact published IOU app,
then replaces only the two exact Vite processes. Crash-incomplete PocketIC repair remains a separate
explicit recovery action.
Use `-Action OpenChatFrontendRestart` only for scoped OpenChat browser/account-link diagnostics: it
still verifies the live replica, restarts only the exact OpenChat Vite process, and reports the IOU
registration as unchecked instead of treating an unrelated registration mismatch as link readiness.

This phone-facing launcher sets the browser passkey RP ID to the configured `tailnetHost` and
checks the served Vite environment before reporting readiness. Use the Tailscale HTTPS address
for browser passkey sign-in, including on desktop; loopback probes do not establish passkey
readiness for `localhost`. Passkeys previously created for `localhost` or a production domain
cannot be moved to this hostname by changing configuration. Keep those credentials and use the
normal account-linking flow if this hostname has no existing passkey. This does not change APK
identity settings or reset any stored credentials. The read-only regression checks run with
`pwsh -NoProfile -File scripts/live/browser-passkey-environment.selftest.ps1`.

Set `openChat.canisterIdsFile` to the exact deployment's `.dfx/local/canister_ids.json`. Startup
requires every local canister alias consumed by both OpenChat roots (including `identity`) and passes
those values to Vite; it also requires the two external OneSec canister principals as explicit config
values. The browser readiness probe rejects a worker whose `init` payload omits Identity or contains a
different Identity principal, so a responsive anonymous worker can no longer hide this configuration
error.

The optional `openChat.androidLink` object supplies the Android package name and colon-separated
SHA-256 signing-certificate fingerprint as `OC_ANDROID_LINK_PACKAGE` and
`OC_ANDROID_LINK_CERT_SHA256`. Omit the whole object for browser-only startup; no package or signing
identity is inferred from the current machine.

### Optional local APK update identity

The upstream Android code namespace and Tauri identifier are not the installed application ID.
To produce a local in-place update for an already linked package, explicitly enable
`androidBuild.localIdentityProfile` in the ignored local config. The example leaves it disabled.
The installed package and expected signer come **only** from `openChat.androidLink`; do not put a
second application ID or certificate in the profile, and do not override the Tauri identifier.

Supply an absolute project-specific `tempRoot` (referred to as `<project-temp>`), a child `taskDirectory`, the independently
checked installed `minimumVersionCode`, and `signing: { "kind": "existing-debug", "keystorePath":
"C:\\path\\to\\existing\\debug.keystore" }`. This is the existing Android debug signer, not a
publisher key. No key is generated or guessed. A different certificate, missing key, ambient
release-signing variables/`keystore.properties`, or lower version fails. `versionName` and
`versionCode` are optional explicit native overrides; otherwise Tauri's numeric source version is
preserved (`0.1.0` yields `1000`). The timestamped `WebsiteVersion` is never used as a native version.
The builder requires configured SDK build-tools (`buildToolsVersion`) and command-line tools
`latest/bin/apkanalyzer.bat` for artifact inspection.

```powershell
pwsh -NoProfile -File scripts/live/build-openchat-android.ps1 `
  -EnvironmentConfigPath scripts/live/start-environment.local.json -DryRun
# After reviewing the plan and explicitly selecting the existing signer:
pwsh -NoProfile -File scripts/live/build-openchat-android.ps1 `
  -EnvironmentConfigPath scripts/live/start-environment.local.json
```

The profile uses an input-hashed, isolated `GRADLE_USER_HOME` below the configured task directory.
Both Tauri and the guarded direct-Gradle fallback inherit that same profile. Its init script changes
only the app module's installed ID, explicit version and selected local signing config; namespace,
Kotlin/JNI classes, backend/RP origin, all-WebGPU flags and OTA `none` are preserved. The source must
already contain application-level registration of notification components; the profile does not
rewrite classes or patch OpenChat. Existing task homes with unexpected init scripts are rejected.
The fallback still requires a freshly compiled ARM64 library; it cannot reuse a stale native build.

For optional cache reuse, `readOnlyDependencyCache` names an existing cache directory containing
`modules-2` and is passed as `GRADLE_RO_DEP_CACHE`. `wrapperCacheDirectory` may name an existing
`wrapper/dists` directory; its contents are copied, never moved or linked, into a new task home.
Without these settings, the first Gradle invocation may need to populate its isolated caches.
Neither option installs a global init script or modifies the original caches.

Dry-run/config validation does not read the key, build an APK or prove Android readiness. A real
profile build checks the selected certificate before starting, then verifies the APK signature,
binary manifest ID/version/component classes, DEX class definitions, FileProvider authority and
the packaged ARM64 library hash before returning `Valid=true`. The existing worker, RP-ID, OTA and
fresh-artifact gates also remain active. These checks do not prove physical-device inference or
retention of account/model data.

Servers may start before the first profile APK because the build needs their public-key query.
Startup preserves the no-profile source-ID mismatch guard. With an explicit profile it reports
missing, stale or wrong APK evidence as **unverified**, with build guidance, rather than blocking
the servers or claiming the installed app matches. A built artifact check never verifies installed
state. Review the actual artifact and installed ID/certificate/version before separately authorizing
an in-place update; do not uninstall or clear storage to bypass a mismatch.

Fixture-only regressions: `pwsh -NoProfile -File scripts/live/local-apk-identity.selftest.ps1`.
They use synthetic ZIPs and stubbed verification output, not real keystores or an Android build.
To also execute the actual Gradle init script against lifecycle fixtures, pass
`-GradleLib C:\path\to\existing\gradle\lib`; this uses the already installed Groovy jars and
does not start Gradle, resolve dependencies or read the signing key.

The optional `androidDevice` config names one exact ADB executable and device serial. With
`requiredForReady: true`, startup fails until that device reports `state=device`; with `false`, it
reports the device separately without weakening service readiness. A disconnected or unauthorized
device produces copyable `adb kill-server`, `start-server`, `devices -l`, and `get-state` guidance.
The environment script never launches a switch-selection/device-selection window.

## Durability mechanism

- **OpenChat session (normal restart)**: OpenChat stores its II delegation in **localStorage** (key
  in `openchat_db_*` / `oc-auth-db`), which lives in the persistent user-data-dir — so simply
  relaunching the browser/app keeps the user **signed in with no re-auth**. `oc-restore.ts` detects
  this and no-ops.
- **OpenChat credential fallback (session lost/expired)**: `WebAuthn.getCredentials` after signup
  exports `{credentialId, privateKey (PKCS#8), rpId, userHandle}` to `creds/<user>.json`. If the
  session is gone, `oc-restore.ts` re-installs it via `WebAuthn.addVirtualAuthenticator` +
  `WebAuthn.addCredential`, clicks **"Sign in with Passkey"**, and the virtual authenticator answers
  the assertion — signing back in as the **same** user. Proven end-to-end even after a *total* storage
  wipe (localStorage + IndexedDB + Service Worker). Works for the desktop WebView2 too.
- **Signed-in check**: evaluated on the **/communities** app route, not root `/` (root serves the
  marketing landing page whose feature copy false-trips a naive "chats" regex). Discriminator:
  signed-OUT shows the *"Tap here to create account or sign in"* banner; signed-IN never does.
- **IOU**: a local dev identity in the profile's localStorage — durable as long as the Chrome
  user-data-dir persists; `iou-signin.ts` re-establishes it if missing. (Note: there is **no**
  saved-credential fallback for IOU — wiping a profile's localStorage loses that dev principal, unlike
  the OpenChat WebAuthn credential which is recoverable from `creds/<user>.json`.)
- **Replica lifecycle**: the supported recovered local environment is persistent. Use
  `start-environment.ps1` for ordinary startup/status; it delegates strict replica management to
  `pocketic-recovered.ps1`, which checkpoints and reopens the NNS, Internet Identity, and System
  subnet state while preserving canister ids and users. Do **not** run ordinary `dfx start`, `dfx
  stop`, or the obsolete six-subnet lifecycle against that recovered state. A deliberately disposable
  clean PocketIC/dfx deployment can still start empty; that is a different workflow.

## Test helpers

- `oc-clear-session.ts --port <p>` — simulate session expiry in-browser (clears localStorage +
  sessionStorage + IndexedDB + service workers), so the credential-reauth path can be exercised
  **without** killing Chrome. Follow with `oc-restore.ts` to re-auth.
- `clear-sw-cache.ts --port <p>` — clear only OpenChat's service worker/CacheStorage and reload
  the current app bundle without removing the signed-in session.
- `reload-iou.ts --port <p>` — perform a full IOU navigation so a durable profile fetches the
  current Vite module graph without changing its dev identity.
- `emulator-transformers-all-webgpu.ts` and artifact-seeding runs of
  `emulator-image-regression.ts` require `--openchat-frontend <absolute-path>` or
  `OC_LIVE_OPENCHAT_FRONTEND`. They validate the required browser module exists below that frontend
  before connecting to Chrome; there is no machine-specific repository fallback.

## First-time provisioning (fresh replica)

```powershell
# after the replica + OC/IOU canisters are up and :5003/:3000 vite are serving:
$liveRoot = 'C:\path\to\durable-live-state'
$openChatFrontend = 'C:\path\to\open-chat\frontend'
$launchArgs = @{
  ChromeExecutable = 'C:\path\to\chrome.exe'
  ProfileRoot = Join-Path $liveRoot 'profiles'
  DesktopExecutable = 'C:\path\to\open-chat.exe'
}
pwsh -NoProfile -File scripts/live/launch.ps1 @launchArgs      # launch all profiles + desktop
# OpenChat signups (durable creds saved):
pnpm exec tsx scripts/live/oc-provision.ts --openchat-frontend $openChatFrontend --port 9241 --user manager --out <live-profile-root>/creds/manager.json
pnpm exec tsx scripts/live/oc-provision.ts --openchat-frontend $openChatFrontend --port 9242 --user mother  --out <live-profile-root>/creds/mother.json
pnpm exec tsx scripts/live/oc-provision.ts --openchat-frontend $openChatFrontend --port 9243 --user child   --out <live-profile-root>/creds/child.json
pnpm exec tsx scripts/live/oc-provision.ts --openchat-frontend $openChatFrontend --port 9222 --user father  --out <live-profile-root>/creds/father.json
# IOU dev sign-ins:
for p in 9241 9242 9243 9231; do pnpm exec tsx scripts/live/iou-signin.ts --port $p; done
```

All machine-specific launcher paths are required inputs. For browser profiles without the desktop
app, pass `-NoDesktop` and omit `DesktopExecutable`. `-DesktopOnly` still requires all three paths
because the desktop app opens external surfaces in the configured Chrome profile.

The CDP healer uses the same paths, passed explicitly or through environment variables. The profile
root is the directory that directly contains `manager`, `mother`, `child`, and `father-iou`:

```powershell
$env:OC_LIVE_CHROME_EXECUTABLE = $launchArgs.ChromeExecutable
$env:OC_LIVE_PROFILE_ROOT = $launchArgs.ProfileRoot
$env:OC_LIVE_DESKTOP_EXECUTABLE = $launchArgs.DesktopExecutable
pnpm exec tsx scripts/live/heal-cdp.ts 19241 19242
```

The healer refuses relative/missing paths and never creates a replacement durable profile. CLI
options `--chrome-executable`, `--profile-root`, and `--desktop-executable` override the matching
environment values for a one-off run.

## Restore after a restart

```powershell
pwsh -NoProfile -File scripts/live/start-environment.ps1 -EnvironmentConfigPath scripts/live/start-environment.local.json
$liveRoot = 'C:\path\to\durable-live-state'
$launchArgs = @{
  ChromeExecutable = 'C:\path\to\chrome.exe'
  ProfileRoot = Join-Path $liveRoot 'profiles'
  DesktopExecutable = 'C:\path\to\open-chat.exe'
}
pwsh -NoProfile -File scripts/live/launch.ps1 @launchArgs
$env:OC_LIVE_CREDS_DIR = Join-Path $liveRoot 'creds'
$env:OC_LIVE_OPENCHAT_FRONTEND = 'C:\path\to\open-chat\frontend'
bash scripts/live/restore-all.sh             # re-establish every OpenChat + IOU session
```

`restore-all.sh` has no machine-specific fallback. Pass both `--creds-dir <absolute-path>` and
`--openchat-frontend <absolute-path>`, or set `OC_LIVE_CREDS_DIR` and
`OC_LIVE_OPENCHAT_FRONTEND`. It validates all four credential files plus the frontend's pinned `ws`
dependency before changing any browser session.
