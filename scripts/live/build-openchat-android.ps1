<# Run with pwsh -File so process-scoped build variables cannot leak into an interactive shell. #>
[CmdletBinding()]param([Parameter(Mandatory)][string]$EnvironmentConfigPath,[string]$OpenChatRepo,[string]$WebsiteVersion=("2.0.0-local-webgpu-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss')),[switch]$DryRun,[switch]$ValidateOnly)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';. (Join-Path $PSScriptRoot 'environment-config.ps1')
. (Join-Path $PSScriptRoot 'local-apk-identity.ps1')
if ($env:OC_LOCAL_APK_IDENTITY_PROFILE) {
  throw 'Do not inherit a local identity init profile; start this builder in a clean child process with explicit config'
}
function Need($m,[string]$n){if($m-isnot[Collections.IDictionary]-or-not$m.Contains($n)-or[string]::IsNullOrWhiteSpace([string]$m[$n])){throw "Missing config field: $n"};[string]$m[$n]}
$configPath=Resolve-EnvironmentConfigPath $EnvironmentConfigPath;$configDirectory=Split-Path -Parent $configPath;$c=Read-EnvironmentConfigFile -Path $configPath;$candidate=if($OpenChatRepo){$OpenChatRepo}else{Need $c 'openChatRepo'};$repo=[IO.Path]::GetFullPath($candidate)
if([IO.Path]::GetPathRoot($repo)-eq$repo){throw 'Unsafe repository path'};foreach($e in @('.git','frontend/package.json','frontend/app/build_android.sh','frontend/src-tauri/Cargo.toml')){if(-not(Test-Path(Join-Path $repo $e))){throw "OpenChatRepo missing $e"}}
if((Get-Content(Join-Path $repo 'frontend/src-tauri/Cargo.toml')-Raw)-notmatch'(?m)^transformers-webgpu-android\s*='){throw 'Missing all-WebGPU feature'}
$identityProfile = Get-LocalApkIdentityProfile -Config $c -Repo $repo -ConfigDirectory $configDirectory
if ($null -eq $identityProfile -and $c['openChat'].Contains('androidLink')) {
  $sourceIdentity = Get-LocalApkSourceIdentity $repo
  if ((Need $c['openChat']['androidLink'] 'packageName') -cne $sourceIdentity.applicationId) {
    throw 'Configured androidLink package differs from source applicationId; use an explicit reviewed localIdentityProfile'
  }
}
$a=$c['androidBuild'];$o=$c['openChat'];$p=$c['pocketIc'];$sdk=[IO.Path]::GetFullPath((Need $a 'sdkRoot'));$ndk=Join-Path $sdk (Join-Path 'ndk'(Need $a 'ndkVersion'));if(-not(Test-Path $ndk)){throw 'NDK unavailable'};$h=Need $c 'tailnetHost';$origin="https://$h";$port=[int](Need $p 'gatewayPort');$ii=Need $o 'internetIdentityCanisterId'
$v=[ordered]@{ANDROID_HOME=$sdk;ANDROID_SDK_ROOT=$sdk;NDK_HOME=$ndk;ANDROID_NDK_HOME=$ndk;ANDROID_NDK_ROOT=$ndk;OC_BUILD_ENV='development';OC_NODE_ENV='development';OC_DFX_NETWORK='local';OC_WSL_DISTRO=(Need $p 'distro');OC_IC_URL=$origin;OC_BASE_ORIGIN=$origin;OC_II_DERIVATION_ORIGIN=$origin;OC_CANISTER_URL_PATH="http://{canisterId}.localhost:$port";OC_BLOB_URL_PATTERN="http://{canisterId}.raw.localhost:$port/{blobType}";OC_INTERNET_IDENTITY_CANISTER_ID=$ii;OC_INTERNET_IDENTITY_URL="http://$ii.localhost:$port";OC_NFID_URL="http://$ii.localhost:$port";OC_WEBAUTHN_ORIGIN='localhost';OC_DEV_ALLOWED_HOST=$h;OC_ANDROID_RP_ID=$h;OC_VAPID_PUBLIC_KEY=(Need $o 'vapidPublicKey');OC_WALLET_CONNECT_PROJECT_ID=(Need $o 'walletConnectProjectId');OC_BITCOIN_MAINNET_ENABLED='false';OC_ACCOUNT_LINKING_CODES_ENABLED='true';OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE='true';OC_LOCAL_AI_APP_CARDS_ENABLED='true';OC_LOCAL_AI_APP_CONTENT_ATTESTATION_ENABLED='true';OC_LOCAL_AI_APP_FINAL_CONFIRMATION_ENABLED='true';OC_LOCAL_AI_APP_PRIVATE_CONTEXT_ENABLED='true';OC_ANDROID_OTA_UPDATES='none';OC_WEBSITE_VERSION=$WebsiteVersion;NODE_OPTIONS='--max-old-space-size=8192'}
$link=$o['androidLink'];if($link-is[Collections.IDictionary]){$v.OC_ANDROID_LINK_PACKAGE=Need $link 'packageName';$v.OC_ANDROID_LINK_CERT_SHA256=Need $link 'certificateSha256'};$idsSetting=Need $o 'canisterIdsFile';$idsPath=if([IO.Path]::IsPathRooted($idsSetting)){$idsSetting}else{Join-Path $configDirectory $idsSetting};$ids=Read-EnvironmentConfigFile -Path([IO.Path]::GetFullPath($idsPath));$aliases=[ordered]@{OC_STORAGE_INDEX_CANISTER='storage_index';OC_GROUP_INDEX_CANISTER='group_index';OC_NOTIFICATIONS_CANISTER='notifications_index';OC_IDENTITY_CANISTER='identity';OC_ONLINE_CANISTER='online_users';OC_USER_INDEX_CANISTER='user_index';OC_TRANSLATIONS_CANISTER='translations';OC_REGISTRY_CANISTER='registry';OC_PROPOSALS_BOT_CANISTER='proposals_bot';OC_MARKET_MAKER_CANISTER='market_maker';OC_SIGN_IN_WITH_EMAIL_CANISTER='sign_in_with_email';OC_SIGN_IN_WITH_ETHEREUM_CANISTER='sign_in_with_ethereum';OC_SIGN_IN_WITH_SOLANA_CANISTER='sign_in_with_solana'};foreach($x in $aliases.GetEnumerator()){$entry=$ids[$x.Value];$v[$x.Key]=Need $entry 'local'};$v.OC_ONESEC_FORWARDER_CANISTER=Need $o 'oneSecForwarderCanisterId';$v.OC_ONESEC_MINTER_CANISTER=Need $o 'oneSecMinterCanisterId';foreach($x in $v.GetEnumerator()){[Environment]::SetEnvironmentVariable($x.Key,[string]$x.Value,'Process')};foreach($n in @('OC_APP_STORE','OC_DEVTOOLS')){[Environment]::SetEnvironmentVariable($n,$null,'Process')}
$git=(Get-Command git.exe -ErrorAction Stop).Source;$gitRoot=Split-Path -Parent(Split-Path -Parent $git);$gitBash=Join-Path $gitRoot 'bin/bash.exe';if(-not(Test-Path $gitBash)){throw 'Git Bash unavailable'};$env:PATH=((@((Need $a 'toolPath'),(Need $a 'mingwBinPath'),(Split-Path -Parent $gitBash),$env:PATH))-join[IO.Path]::PathSeparator)
Set-LocalAndroidTauriCli $repo
$v.OPENCHAT_TAURI_JS = $env:OPENCHAT_TAURI_JS
$v.OPENCHAT_TAURI_CMD = $env:OPENCHAT_TAURI_CMD
$tauriArgs = @('tauri','android','build','--target','aarch64','--apk','--ci','--features','transformers-webgpu-android')
$tauri = 'npx.cmd ' + ($tauriArgs -join ' ')
$fallback = '.\gradlew.bat assembleUniversalRelease -PabiList=arm64-v8a -ParchList=arm64 -PtargetList=aarch64 -x rustBuildArm64Release --warn'
$profilePlan = if ($null -ne $identityProfile) {
  [pscustomobject]@{ ApplicationId = $identityProfile.applicationId; Namespace = $identityProfile.namespace; VersionCode = $identityProfile.versionCode; SigningVerified = $false; ArtifactVerified = $false }
} else { $null }
if ($DryRun) {
  [pscustomobject]@{ Valid = $true; Mode = 'DryRun'; EnvironmentVariables = @($v.Keys); Command = $tauri; ConditionalFallback = $fallback; LocalIdentityProfile = $profilePlan }
  return
}
foreach ($tool in @('npx.cmd','java.exe','rustup.exe','wsl.exe','bash.exe')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Missing tool $tool" }
}
if ((Get-Command bash.exe).Source -ne $gitBash) { throw 'PATH did not select Git Bash' }
Push-Location $repo
try { $installedTargets = @(rustup target list --installed); $rustupExit = $LASTEXITCODE }
finally { Pop-Location }
if ($rustupExit -ne 0) { throw 'Unable to query installed Rust targets' }
if ($installedTargets -notcontains 'aarch64-linux-android') { throw 'Missing Rust ARM64 target' }
if ($ValidateOnly) {
  [pscustomobject]@{ Valid = $true; Mode = 'ValidateOnly'; Command = $tauri; ConditionalFallback = $fallback; LocalIdentityProfile = $profilePlan }
  # Return to the caller normally so PowerShell flushes its formatting/output pipeline.
  return
}
if ($null -ne $identityProfile) {
  foreach ($tool in @($identityProfile.apksigner, $identityProfile.apkanalyzer)) {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw 'Local APK binary verification tools are missing from the configured SDK' }
  }
  Assert-LocalApkSigningCertificate $identityProfile
  # Both the normal Tauri subprocess and guarded direct-Gradle fallback inherit this
  # one task-scoped user home. No global init script or Tauri identifier is changed.
  Initialize-LocalApkIdentityProfile $identityProfile | Out-Null
}
$start = Get-Date
Push-Location (Join-Path $repo 'frontend')
try {
  & npx.cmd @tauriArgs 2>&1 | Tee-Object -Variable tauriOutput
  $tauriExit = $LASTEXITCODE
  if ($tauriExit) {
    $failure = $tauriOutput | Out-String
    $knownRustBuildFailure = ($failure -match '(?i)rustBuildArm64Release') -and (
      (($failure -match '(?i)cargo(?:\.exe)?\s+tauri') -and ($failure -match '(?i)not recognized|not found|cannot find|could not find')) -or
      ($failure -match '(?i)no such command:\s*[\x27\x22]?tauri') -or
      ($failure -match '(?i)problem occurred starting process.{0,160}cargo\.cmd')
    )
    if (-not $knownRustBuildFailure) { throw "Tauri build failed $tauriExit" }
    $lib = Join-Path $repo 'frontend/src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/libapp_lib.so'
    if (-not (Test-Path -LiteralPath $lib) -or (Get-Item -LiteralPath $lib).LastWriteTime -le $start) {
      throw 'Tauri fallback refused: ARM64 library was not freshly compiled'
    }
    Push-Location (Join-Path $repo 'frontend/src-tauri/gen/android')
    try {
      & .\gradlew.bat assembleUniversalRelease '-PabiList=arm64-v8a' '-ParchList=arm64' '-PtargetList=aarch64' -x rustBuildArm64Release --warn
      if ($LASTEXITCODE) { throw "Gradle fallback failed $LASTEXITCODE" }
    } finally { Pop-Location }
  }
} finally { Pop-Location }
$b = Join-Path $repo 'frontend/app/build'
$w = Join-Path $b 'transformers_webgpu_worker.js'
if (-not (Test-Path -LiteralPath $w) -or (Get-Item -LiteralPath $w).Length -lt 500000) { throw 'Packaged WebGPU worker missing' }
$text = Get-Content -LiteralPath $w -Raw
$markers = @($c['model']['workerRequiredMarkers']) + @('[webgpu-shader] neutralized Gemma smooth-softmax routing marker', 'The pinned Gemma decoder attention graph changed; refusing an unverified FlashAttention bypass.')
foreach ($m in $markers) { if ($text.IndexOf([string]$m) -lt 0) { throw 'Worker marker missing' } }
if ((Get-Content (Join-Path $b 'ota-policy.json') -Raw | ConvertFrom-Json).strategy -ne 'none') { throw 'OTA mismatch' }
if ((Get-Content (Join-Path $b 'android-rp-id') -Raw).Trim() -ne $h) { throw 'RP ID mismatch' }
$apk = Join-Path $repo 'frontend/src-tauri/gen/android/app/build/outputs/apk/universal/release/openchat-release.apk'
if (-not (Test-Path -LiteralPath $apk) -or (Get-Item -LiteralPath $apk).LastWriteTime -le $start) { throw 'Fresh release APK was not produced' }
$artifactIdentity = $null
if ($null -ne $identityProfile) {
  $native = Join-Path $repo 'frontend/src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/libapp_lib.so'
  $artifactIdentity = Assert-LocalApkArtifact $identityProfile $apk $native
}
[pscustomobject]@{ Valid = $true; Apk = $apk; LocalIdentityProfile = ($null -ne $identityProfile); VerifiedArtifactIdentity = $artifactIdentity }
