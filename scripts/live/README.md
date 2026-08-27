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
```

The start command reopens only the authoritative recovered PocketIC state, starts the exact OpenChat
and IOU Vite processes, and verifies the published IOU app, background/model workers, all-WebGPU
model routes, a restored original image, and both phone-facing Tailscale origins. The launcher and
PocketIC manager receive the same explicit JSON; neither script embeds a machine path, Tailnet host,
canister/app coordinate, topology fingerprint, model revision, or image blob identity. The local JSON
is ignored by git; the checked-in example contains placeholders only. Startup does not clean,
deploy, register, publish, reset, or repair canister state. Use `-RestartFrontends` when a Vite config
has changed; crash-incomplete PocketIC repair remains a separate explicit recovery action.

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

## First-time provisioning (fresh replica)

```
# after the replica + OC/IOU canisters are up and :5003/:3000 vite are serving:
powershell -File scripts/live/launch.ps1                       # launch all profiles + desktop
# OpenChat signups (durable creds saved):
pnpm exec tsx scripts/live/oc-provision.ts --port 9241 --user manager --out <live-profile-root>/creds/manager.json
pnpm exec tsx scripts/live/oc-provision.ts --port 9242 --user mother  --out <live-profile-root>/creds/mother.json
pnpm exec tsx scripts/live/oc-provision.ts --port 9243 --user child   --out <live-profile-root>/creds/child.json
pnpm exec tsx scripts/live/oc-provision.ts --port 9222 --user father  --out <live-profile-root>/creds/father.json
# IOU dev sign-ins:
for p in 9241 9242 9243 9231; do pnpm exec tsx scripts/live/iou-signin.ts --port $p; done
```

## Restore after a restart

```
pwsh -NoProfile -File scripts/live/start-environment.ps1 -EnvironmentConfigPath scripts/live/start-environment.local.json
powershell -File scripts/live/launch.ps1     # relaunch browsers + desktop from persistent profiles
bash scripts/live/restore-all.sh             # re-establish every OpenChat + IOU session
```
