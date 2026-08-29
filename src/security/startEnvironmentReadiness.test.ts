import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  resolve(process.cwd(), "scripts/live/start-environment.ps1"),
  "utf8",
);
const appChecker = readFileSync(
  resolve(process.cwd(), "scripts/live/check-openchat-ai-app.ts"),
  "utf8",
);
const browserChecker = readFileSync(
  resolve(
    process.cwd(),
    "scripts/live/check-openchat-browser-readiness.ts",
  ),
  "utf8",
);
const profileLauncher = readFileSync(
  resolve(process.cwd(), "scripts/live/launch.ps1"),
  "utf8",
);
const exampleConfig = readFileSync(
  resolve(
    process.cwd(),
    "scripts/live/start-environment.config.example.json",
  ),
  "utf8",
);

describe("live environment readiness contract", () => {
  it("does not promote anonymous app publication to signed-in end-to-end readiness", () => {
    expect(appChecker).toContain('scope: "anonymous-published-registration"');
    expect(appChecker).toContain("endToEndReady: false");
    expect(appChecker).toContain("accountConnection: {");
    expect(appChecker).toContain("checked: false");
    expect(appChecker).toContain("exact-current-revision app link");
    expect(script).not.toContain("Write-Host 'Environment READY'");
  });

  it("warms representative Vite application modules over loopback and HTTPS before READY", () => {
    expect(script).toContain("function Wait-OpenChatApplicationModules");
    expect(script).toContain("'/@vite/client'");
    expect(script).toContain("'/src/main.ts'");
    expect(script).toContain("'/src/components_mobile/App.svelte'");
    expect(script).toContain("-ExpectedContentType 'text/javascript'");
    expect(script).toContain(
      "Contains = @('components_mobile/App.svelte', 'ensureWebModelRestored')",
    );
    expect(script).not.toContain(
      "Contains = @('components_mobile/App.svelte', 'restoreWebModel')",
    );

    const localWarmup = script.indexOf(
      "Wait-OpenChatApplicationModules -Origin $OpenChatOrigin",
    );
    const tailscaleRoutes = script.indexOf(
      "Ensure-TailscaleRoutes",
      localWarmup,
    );
    const httpsWarmup = script.indexOf(
      "Wait-OpenChatApplicationModules -Origin $TailOpenChatOrigin",
      tailscaleRoutes,
    );
    const ready = script.indexOf(
      "Write-Host 'Environment services READY (account link not verified)'",
      httpsWarmup,
    );

    expect(localWarmup).toBeGreaterThanOrEqual(0);
    expect(tailscaleRoutes).toBeGreaterThan(localWarmup);
    expect(httpsWarmup).toBeGreaterThan(tailscaleRoutes);
    expect(ready).toBeGreaterThan(httpsWarmup);
  });

  it("executes OpenChat and proves background-worker init plus anonymous auth before READY", () => {
    expect(browserChecker).toContain('workerUrl.pathname === "/worker.js"');
    expect(browserChecker).toContain('kind === "init"');
    expect(browserChecker).toContain('kind === "setAuthIdentity"');
    expect(browserChecker).toContain('data.requestKind === "init"');
    expect(browserChecker).toContain(
      'data.requestKind === "setAuthIdentity"',
    );
    expect(browserChecker).toContain("await chromium.launch");
    expect(browserChecker).not.toContain("launchPersistentContext");
    expect(browserChecker).not.toContain("userDataDir");
    expect(browserChecker).toContain(
      'argument("--expected-identity-canister")',
    );
    expect(browserChecker).toContain("identityCanisterPresent");
    expect(browserChecker).toContain("identityCanisterMatched");
    expect(browserChecker).toContain(
      "identityCanister === expectedIdentityCanister",
    );
    expect(browserChecker).toContain(
      "OpenChat worker init did not contain the exact configured local Identity canister",
    );
    expect(script).toContain(
      "'--expected-identity-canister', $ExpectedIdentityCanister",
    );

    const localModules = script.indexOf(
      "Wait-OpenChatApplicationModules -Origin $OpenChatOrigin",
    );
    const localBrowser = script.indexOf(
      "Assert-OpenChatBrowserReady -Origin $OpenChatOrigin",
      localModules,
    );
    const httpsModules = script.indexOf(
      "Wait-OpenChatApplicationModules -Origin $TailOpenChatOrigin",
      localBrowser,
    );
    const httpsBrowser = script.indexOf(
      "Assert-OpenChatBrowserReady -Origin $TailOpenChatOrigin",
      httpsModules,
    );
    const ready = script.indexOf(
      "Write-Host 'Environment services READY (account link not verified)'",
      httpsBrowser,
    );
    expect(localBrowser).toBeGreaterThan(localModules);
    expect(httpsModules).toBeGreaterThan(localBrowser);
    expect(httpsBrowser).toBeGreaterThan(httpsModules);
    expect(ready).toBeGreaterThan(httpsBrowser);
  });

  it("loads and validates every App.svelte canister setting from config", () => {
    const parsed = JSON.parse(exampleConfig) as {
      openChat?: {
        canisterIdsFile?: string;
        oneSecForwarderCanisterId?: string;
        oneSecMinterCanisterId?: string;
      };
    };
    expect(parsed.openChat?.canisterIdsFile).toBe(
      "C:\\path\\to\\openchat-deployment\\.dfx\\local\\canister_ids.json",
    );
    expect(parsed.openChat?.oneSecForwarderCanisterId).toBe(
      "one-sec-forwarder-canister-id",
    );
    expect(parsed.openChat?.oneSecMinterCanisterId).toBe(
      "one-sec-minter-canister-id",
    );

    const localCanisterBindings = {
      OC_STORAGE_INDEX_CANISTER: "storage_index",
      OC_GROUP_INDEX_CANISTER: "group_index",
      OC_NOTIFICATIONS_CANISTER: "notifications_index",
      OC_IDENTITY_CANISTER: "identity",
      OC_ONLINE_CANISTER: "online_users",
      OC_USER_INDEX_CANISTER: "user_index",
      OC_TRANSLATIONS_CANISTER: "translations",
      OC_REGISTRY_CANISTER: "registry",
      OC_PROPOSALS_BOT_CANISTER: "proposals_bot",
      OC_MARKET_MAKER_CANISTER: "market_maker",
      OC_SIGN_IN_WITH_EMAIL_CANISTER: "sign_in_with_email",
      OC_SIGN_IN_WITH_ETHEREUM_CANISTER: "sign_in_with_ethereum",
      OC_SIGN_IN_WITH_SOLANA_CANISTER: "sign_in_with_solana",
    } as const;
    for (const [environmentName, canisterAlias] of Object.entries(
      localCanisterBindings,
    )) {
      expect(script).toContain(`${environmentName} = '${canisterAlias}'`);
    }
    for (const environmentName of [
      ...Object.keys(localCanisterBindings),
      "OC_ONESEC_FORWARDER_CANISTER",
      "OC_ONESEC_MINTER_CANISTER",
    ]) {
      expect(script).not.toMatch(
        new RegExp(`${environmentName}\\s*=\\s*['\"][a-z0-9-]+-cai['\"]`),
      );
    }

    expect(script).toContain("function Get-RequiredOpenChatCanisterEnvironment");
    expect(script).toContain("-Name 'canisterIdsFile'");
    expect(script).toContain(
      "$OpenChatCanisterEnvironment['OC_ONESEC_FORWARDER_CANISTER']",
    );
    expect(script).toContain(
      "$OpenChatCanisterEnvironment['OC_ONESEC_MINTER_CANISTER']",
    );
    expect(script).toContain(
      "foreach ($entry in $OpenChatCanisterEnvironment.GetEnumerator())",
    );
    expect(script).toContain(
      "$ExpectedIdentityCanister = $OpenChatCanisterEnvironment['OC_IDENTITY_CANISTER']",
    );
    expect(script).toContain(
      "aiApp.userIndexCanisterId does not match user_index.local",
    );
  });

  it("optionally passes configured Android device-link association values to Vite", () => {
    const parsed = JSON.parse(exampleConfig) as {
      openChat?: {
        androidLink?: { packageName?: string; certificateSha256?: string };
      };
    };
    expect(parsed.openChat?.androidLink).toEqual({
      packageName: "com.example.openchat",
      certificateSha256:
        "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00",
    });
    expect(script).toContain(
      "Get-OptionalConfigMap -Config $openChatConfig -Name 'androidLink'",
    );
    expect(script).toContain("if ($null -ne $AndroidLinkPackage)");
    expect(script).toContain(
      "$settings['OC_ANDROID_LINK_PACKAGE'] = $AndroidLinkPackage",
    );
    expect(script).toContain("$settings['OC_ANDROID_RP_ID'] = $TailnetHost");
    expect(script).toContain("applicationIdMatches");
    expect(script).toContain("the APK applicationId");
    expect(script).toContain("Assert-AndroidAssetLinks -Origin $TailOpenChatOrigin");
    expect(script).toContain("sha256_cert_fingerprints");
    expect(script).toContain("Get-OpenChatEnvironmentFingerprint");
    expect(script).toContain("Test-OpenChatEnvironmentStale");
    expect(script).toContain(".codex-openchat-vite.environment.sha256");
    expect(script).toContain("startTimeUtc");
    expect(script).toContain("processId = $process.Id");
    expect(script).toContain("$storedStartTimeUtc.Ticks");
    expect(script).toContain(
      "$process.StartTime.ToUniversalTime().Ticks",
    );
    expect(script).not.toContain(
      '"$($stored[\'startTimeUtc\'])" -cne $startTimeUtc',
    );
    expect(script).toContain("BaseResponse.RequestMessage.RequestUri.AbsoluteUri");
    expect(script).toContain("delegate_permission/common.get_login_creds");
    expect(script).toContain(
      "$settings['OC_ANDROID_LINK_CERT_SHA256'] = $AndroidLinkCertSha256",
    );
    expect(script).toContain("(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}");
  });

  it("keeps host, browser, and optional Android device identities in config", () => {
    const parsed = JSON.parse(exampleConfig) as {
      tailnetHost?: string;
      browserProbe?: { channel?: string };
      androidDevice?: {
        adbExecutable?: string;
        serial?: string;
        requiredForReady?: boolean;
      };
    };
    expect(parsed.tailnetHost).toBe("device-name.tailnet-name.ts.net");
    expect(parsed.browserProbe?.channel).toBe("chrome");
    expect(parsed.androidDevice).toEqual({
      adbExecutable: "C:\\path\\to\\adb.exe",
      serial: "configured-device-serial",
      requiredForReady: false,
    });
    expect(script).toContain("$TailnetHost = Get-RequiredConfigString");
    expect(script).toContain("$AndroidDeviceSerial = Get-RequiredConfigString");
    expect(script).toContain("$BrowserProbeChannel = Get-RequiredConfigString");
    expect(script).not.toMatch(/[A-Za-z]:\\Users\\[^'"\s]+/);
    expect(script).not.toMatch(/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net/i);
  });

  it("requires every profile-launcher machine path explicitly", () => {
    expect(profileLauncher).toContain("[string]$ChromeExecutable");
    expect(profileLauncher).toContain("[string]$ProfileRoot");
    expect(profileLauncher).toContain("[string]$DesktopExecutable");
    expect(profileLauncher).toContain(
      "'-DesktopExecutable is required unless -NoDesktop is used'",
    );
    expect(profileLauncher).not.toMatch(/[A-Za-z]:\\Users\\[^'"\s]+/);
    expect(profileLauncher).not.toMatch(/[A-Za-z]:\\[^'"\r\n]*\\MyProjects\\/i);
    expect(profileLauncher).not.toMatch(/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net/i);
  });

  it("reports exact ADB reconnect commands and never opens a selection UI", () => {
    expect(script).toContain("& $AdbExecutable -s $AndroidDeviceSerial get-state");
    expect(script).toContain("& '$AdbExecutable' kill-server");
    expect(script).toContain("& '$AdbExecutable' start-server");
    expect(script).toContain("& '$AdbExecutable' devices -l");
    expect(script).toContain("switch-selection or device-selection window");
    expect(script).not.toMatch(/Start-Process[^\n]*(?:adb|scrcpy|device|switch)/i);
  });

  it("rejects an empty or malformed served OpenChat public key", () => {
    expect(script).toContain("function Assert-OpenChatPublicKeyRoute");
    expect(script).toContain(
      '-Description "OpenChat public key at $Origin" -MinimumBytes 100',
    );
    expect(script).toContain("-----BEGIN PUBLIC KEY-----");
    expect(script).toContain("-----END PUBLIC KEY-----");

    const openChatGate = script.indexOf("function Assert-OpenChatReady");
    const publicKeyGate = script.indexOf(
      "Assert-OpenChatPublicKeyRoute -Origin $Origin",
      openChatGate,
    );
    expect(publicKeyGate).toBeGreaterThan(openChatGate);
  });

  it("passes the configured PocketIC WSL distro to the OpenChat build hook", () => {
    expect(script).toContain(
      "$PocketIcDistro = Get-RequiredConfigString -Config $pocketIcConfig -Name 'distro'",
    );
    expect(script).toContain("OC_WSL_DISTRO = $PocketIcDistro");
    expect(script).not.toMatch(/OC_WSL_DISTRO\s*=\s*['\"][^$]/);
  });

  it("arms only the four exact local AI app verification flags", () => {
    const openChatStart = script.indexOf("function Start-OpenChatVite");
    const iouStart = script.indexOf("function Start-IouVite", openChatStart);
    expect(openChatStart).toBeGreaterThanOrEqual(0);
    expect(iouStart).toBeGreaterThan(openChatStart);

    const openChatLauncher = script.slice(openChatStart, iouStart);
    const localAiAppFlags = [
      ...openChatLauncher.matchAll(
        /^\s+(OC_LOCAL_AI_APP_[A-Z0-9_]+)\s*=\s*(.+?)\s*$/gm,
      ),
    ].map(([, name, value]) => [name, value]);

    expect(localAiAppFlags).toEqual([
      ["OC_LOCAL_AI_APP_CARDS_ENABLED", "'true'"],
      ["OC_LOCAL_AI_APP_CONTENT_ATTESTATION_ENABLED", "'true'"],
      ["OC_LOCAL_AI_APP_FINAL_CONFIRMATION_ENABLED", "'true'"],
      ["OC_LOCAL_AI_APP_PRIVATE_CONTEXT_ENABLED", "'true'"],
    ]);
  });

  it("requires the live published schema and backend binding to match before READY", () => {
    expect(script).toContain(
      "$OpenChatRegistration = Join-Path $RepoRoot 'docs\\openchat-registration.json'",
    );
    expect(script).toContain(
      "'--expected-response-schema-file', $OpenChatRegistration",
    );
    expect(script).toContain("'--verify-app-binding', 'true'");
    expect(script).toContain("$result.app.responseSchemaVerified -ne $true");
    expect(script).toContain("$result.app.appBindingVerified -ne $true");
    expect(script).toContain("$result.endToEndReady -ne $false");
    expect(script).toContain("$result.accountConnection.checked -ne $false");
    expect(script).toContain(
      "Account link: NOT VERIFIED; after any manifest revision change, reconnect the signed-in account before end-to-end action QC",
    );

    const exactGate = script.indexOf(
      "published IOU app #$($result.app.id) revision $($result.app.revision) has exact schema + binding",
    );
    const replicaReady = script.indexOf("function Assert-ReplicaReady");
    expect(exactGate).toBeGreaterThanOrEqual(0);
    expect(replicaReady).toBeGreaterThan(exactGate);
  });

  it("removes only exact singleton Vite commands before frontend starts and restarts", () => {
    expect(script).toContain("function Test-ExactViteProcess");
    expect(script).toContain("$Process.Name -ine 'node.exe'");
    expect(script).toContain("[regex]::Escape([IO.Path]::GetFullPath($Node))");
    expect(script).toContain(
      "[regex]::Escape([IO.Path]::GetFullPath($ViteScript))",
    );
    expect(script).toContain(
      "--host\\s+127\\.0\\.0\\.1\\s+--port\\s+{2}\\s+--strictPort",
    );
    expect(script).toContain(
      "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\"",
    );
    expect(script).not.toMatch(/Get-Process\s+-Name\s+node/i);

    const starter = script.indexOf("function Start-NodeDevServer");
    const preStartCleanup = script.indexOf(
      "Stop-ExactViteProcesses -ViteScript $ViteScript -Port $Port",
      starter,
    );
    const processStart = script.indexOf(
      "Start-Process -FilePath $Node",
      starter,
    );
    expect(preStartCleanup).toBeGreaterThan(starter);
    expect(processStart).toBeGreaterThan(preStartCleanup);

    expect(script).toContain(
      "Stop-ExactViteProcesses -ViteScript $OpenChatViteScript -Port 5003",
    );
    expect(script).toContain(
      "Stop-ExactViteProcesses -ViteScript $IouViteScript -Port 3000",
    );
    expect(script).toContain(
      "PID $processId no longer has the exact expected Vite command line",
    );
  });

  it("can restart only the frontends after proving the existing replica and app state", () => {
    expect(script).toContain(
      "[ValidateSet('Start', 'Status', 'ValidateConfig', 'FrontendRestart', 'OpenChatFrontendRestart')]",
    );
    expect(script).toContain(
      "if ($Action -in @('FrontendRestart', 'OpenChatFrontendRestart')) {",
    );
    expect(script).toContain(
      "$mayRestartFrontends = $Action -in @('Start', 'FrontendRestart', 'OpenChatFrontendRestart')",
    );
    expect(script).toContain(
      "$forceOpenChatRestart = $RestartFrontends -or $Action -in @('FrontendRestart', 'OpenChatFrontendRestart')",
    );
    expect(script).toContain(
      "$forceIouRestart = $RestartFrontends -or $Action -eq 'FrontendRestart'",
    );

    const frontendRecovery = script.indexOf(
      "if ($Action -in @('FrontendRestart', 'OpenChatFrontendRestart')) {",
    );
    const replicaGate = script.indexOf("Assert-ReplicaReady", frontendRecovery);
    const exactOpenChatStop = script.indexOf(
      "Stop-ExactViteProcesses -ViteScript $OpenChatViteScript -Port 5003",
      replicaGate,
    );
    const exactIouStop = script.indexOf(
      "Stop-ExactViteProcesses -ViteScript $IouViteScript -Port 3000",
      replicaGate,
    );

    expect(replicaGate).toBeGreaterThan(frontendRecovery);
    expect(exactOpenChatStop).toBeGreaterThan(replicaGate);
    expect(exactIouStop).toBeGreaterThan(replicaGate);
  });

  it("isolates OpenChat account-link restart from an unrelated IOU registration mismatch", () => {
    expect(script).toContain(
      "Assert-ReplicaReady -RequirePublishedIouApp ($Action -ne 'OpenChatFrontendRestart')",
    );
    expect(script).toContain(
      "Registration: NOT CHECKED by the scoped OpenChat-only restart",
    );
  });
});
