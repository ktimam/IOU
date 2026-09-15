# Fixture-only behavioral tests: no real key, APK, Gradle, SDK, device or network is used.
[CmdletBinding()] param([string]$GradleLib)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-apk-identity.ps1')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('local-apk-profile-selftest-' + [Guid]::NewGuid().ToString('N'))
$repo = Join-Path $testRoot 'source'
$android = Join-Path $repo 'frontend/src-tauri/gen/android'
$gradle = Join-Path $android 'app/build.gradle.kts'
$manifestPath = Join-Path $android 'app/src/main/AndroidManifest.xml'
$tauri = Join-Path $repo 'frontend/src-tauri/tauri.conf.json'
$key = Join-Path $testRoot 'fixture-existing-debug.keystore'
$script:checks = 0
function Put([string]$Path, [string]$Text) {
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
  [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}
function Check([bool]$Condition, [string]$Label) {
  if (-not $Condition) { throw "FAIL: $Label" }
  $script:checks++
}
function Reject([scriptblock]$Action, [string]$Message) {
  $rejected = $false
  try { & $Action | Out-Null } catch {
    if ($_.Exception.Message -notmatch $Message) { throw }
    $rejected = $true
  }
  Check $rejected "expected rejection: $Message"
}
$sourceGradle = "android {`n    namespace = `"com.example.source`"`n    defaultConfig {`n        applicationId = `"com.example.source`"`n    }`n}"
Put $gradle $sourceGradle
Put $tauri '{"identifier":"com.example.source","version":"0.1.0"}'
$sourceManifest = @'
<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:name=".Application"><activity android:name=".MainActivity"/><service android:name="com.example.source.NotificationService"/><receiver android:name=".DismissReceiver"/><provider android:name="androidx.core.content.FileProvider" android:authorities="${applicationId}.fileprovider"/></application></manifest>
'@
Put $manifestPath $sourceManifest
Put (Join-Path $repo 'frontend/tauri-plugin-oc/android/src/main/java/IntentsManager.kt') 'fun registerComponents() { /* fixture */ }'
Put (Join-Path $android 'app/src/main/java/com/example/source/Application.kt') 'IntentsManager.registerComponents(/* fixture */)'
Put $key 'THIS IS A TEST FIXTURE, NOT A KEYSTORE'
Put (Join-Path $repo 'frontend/node_modules/@tauri-apps/cli/tauri.js') '// CLI path fixture, never executed'
Reject { Set-LocalAndroidTauriCli $repo } 'missing its installed Tauri CLI'
Put (Join-Path $repo 'frontend/node_modules/.bin/tauri.cmd') 'CLI path fixture, never executed'
$env:OPENCHAT_TAURI_JS = 'unrelated-checkout'
$env:OPENCHAT_TAURI_CMD = 'unrelated-checkout'
Set-LocalAndroidTauriCli $repo
Check ($env:OPENCHAT_TAURI_JS -ceq (Join-Path $repo 'frontend/node_modules/@tauri-apps/cli/tauri.js')) 'native Tauri wrapper uses exactly the selected checkout'
Check ($env:OPENCHAT_TAURI_CMD -ceq (Join-Path $repo 'frontend/node_modules/.bin/tauri.cmd')) 'command Tauri wrapper uses exactly the selected checkout'
$certificate = (@('AA') * 32) -join ':'
$config = @{
  androidBuild = @{
    sdkRoot = (Join-Path $testRoot 'sdk'); buildToolsVersion = '35.0.0'
    localIdentityProfile = @{
      enabled = $true; tempRoot = $testRoot; taskDirectory = 'task-home'
      minimumVersionCode = 1000; signing = @{ kind = 'existing-debug'; keystorePath = $key }
    }
  }
  openChat = @{ androidLink = @{ packageName = 'com.example.local'; certificateSha256 = $certificate } }
}
$settings = $config.androidBuild.localIdentityProfile
$script:toolCalls = [Collections.Generic.List[object]]::new()
$script:toolFailure = $false
$script:signerDigest = 'AA' * 32
$script:keyDigest = $certificate
# Installed apkanalyzer's default --defined-only rows: kind, defined/reference,
# then three integer counts and the fully qualified class name. No -h output.
$script:dex = "P d 160`t160`t18789`tcom.example.source`n" + ((@(
  'com.example.source.Application', 'com.example.source.MainActivity',
  'com.example.source.NotificationService', 'com.example.source.DismissReceiver'
) | ForEach-Object { "C d 6`t6`t1929`t$_" }) -join "`n")
$script:binaryManifest = $sourceManifest.Replace('<manifest ', '<manifest package="com.example.local" android:versionCode="1000" android:versionName="0.1.0" ')
$script:binaryManifest = $script:binaryManifest.Replace('android:name=".', 'android:name="com.example.source.').Replace('${applicationId}', 'com.example.local')
function Invoke-LocalApkTool([string]$Executable, [string[]]$Arguments) {
  $script:toolCalls.Add(@{ executable = $Executable; arguments = $Arguments })
  if ($script:toolFailure) { throw 'fixture verification tool failed' }
  if ($Executable -eq 'keytool.exe') { return "SHA256: $script:keyDigest" }
  if ($Arguments[0] -eq 'verify') { return "Signer #1 certificate SHA-256 digest: $script:signerDigest" }
  if ($Arguments[0] -eq 'manifest') { return $script:binaryManifest }
  if ($Arguments[0] -eq 'dex') { return $script:dex }
  throw 'Unexpected fixture tool invocation'
}

Check ($null -eq (Get-LocalApkIdentityProfile @{} $repo $testRoot)) 'profile is absent by default'
$settings.enabled = $false
Check ($null -eq (Get-LocalApkIdentityProfile $config $repo $testRoot)) 'explicit false leaves source unchanged'
$settings.enabled = 'true'
Reject { Get-LocalApkIdentityProfile $config $repo $testRoot } 'explicit boolean'
$settings.enabled = $true
$profile = Get-LocalApkIdentityProfile $config $repo $testRoot
Check ($profile.applicationId -ceq 'com.example.local') 'installed ID comes from androidLink'
Check ($profile.namespace -ceq 'com.example.source') 'source namespace remains upstream'
Check ($profile.versionCode -eq 1000 -and $profile.versionName -ceq '0.1.0') 'default Tauri native version is preserved'
Check ($script:toolCalls.Count -eq 0) 'configuration validation does not read a key or invoke tools'
Put (Join-Path $repo 'frontend/tauri-plugin-oc/android/src/main/java/IntentsManager.kt') 'Class.forName(context.packageName + ".MainActivity")'
Reject { Get-LocalApkIdentityProfile $config $repo $testRoot } 'notification component prerequisite'
Put (Join-Path $repo 'frontend/tauri-plugin-oc/android/src/main/java/IntentsManager.kt') 'fun registerComponents() { /* fixture */ }'
$settings.applicationId = 'com.example.other'
Reject { Get-LocalApkIdentityProfile $config $repo $testRoot } 'Unknown local identity profile field'
$settings.Remove('applicationId')
$config.openChat.androidLink.packageName = 'invalid-package'
Reject { Get-LocalApkIdentityProfile $config $repo $testRoot } 'Invalid linked Android package'
$config.openChat.androidLink.packageName = 'com.example.local'
$config.openChat.androidLink.certificateSha256 = 'AA:BB'
Reject { Get-LocalApkIdentityProfile $config $repo $testRoot } 'Invalid linked Android certificate'
$config.openChat.androidLink.certificateSha256 = $certificate
$settings.signing.keystorePath = (Join-Path $testRoot 'missing.keystore')
Reject { Get-LocalApkIdentityProfile $config $repo $testRoot } 'no key will be generated'
$settings.signing.keystorePath = $key
$settings.signing.kind = 'generate-debug'
Reject { Get-LocalApkIdentityProfile $config $repo $testRoot } 'existing-debug'
$settings.signing.kind = 'existing-debug'
$settings.minimumVersionCode = 1001
Reject { Get-LocalApkIdentityProfile $config $repo $testRoot } 'downgrade'
$settings.versionCode = 1001
Check ((Get-LocalApkIdentityProfile $config $repo $testRoot).versionCode -eq 1001) 'explicit nondowngrade code is accepted'
$settings.Remove('versionCode'); $settings.minimumVersionCode = 1000
$settings.versionName = '2.0.0-local-webgpu'
Reject { Get-LocalApkIdentityProfile $config $repo $testRoot } 'not WebsiteVersion'
$settings.Remove('versionName')
$settings.taskDirectory = '../outside'
Reject { Get-LocalApkIdentityProfile $config $repo $testRoot } 'strictly inside'
$settings.taskDirectory = 'task-home'
$redirectTarget = Join-Path $testRoot 'junction-target'
[IO.Directory]::CreateDirectory($redirectTarget) | Out-Null
New-Item -ItemType Junction -Path (Join-Path $testRoot 'junction-parent') -Target $redirectTarget | Out-Null
$settings.taskDirectory = 'junction-parent/forbidden-task'
Reject { Get-LocalApkIdentityProfile $config $repo $testRoot } 'reparse points'
Check (-not (Test-Path -LiteralPath (Join-Path $redirectTarget 'forbidden-task'))) 'a redirected task path is rejected before any profile write'
$settings.taskDirectory = 'task-home'
foreach ($name in @('OC_ANDROID_KEYSTORE_PATH', 'OC_ANDROID_KEYSTORE_PASSWORD', 'OC_ANDROID_KEY_ALIAS', 'OC_ANDROID_KEY_PASSWORD', 'OC_ANDROID_REQUIRE_RELEASE_SIGNING', 'OC_ANDROID_VERSION_NAME', 'TAURI_CONFIG')) {
  [Environment]::SetEnvironmentVariable($name, 'fixture', 'Process')
  try { Reject { Get-LocalApkIdentityProfile $config $repo $testRoot } "ambient $name" }
  finally { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
}
Put (Join-Path $android 'keystore.properties') 'fixture configuration, not credentials'
Reject { Get-LocalApkIdentityProfile $config $repo $testRoot } 'ambient keystore.properties'
# This test-created file is moved within its fixture directory, never removed from user state.
Move-Item -LiteralPath (Join-Path $android 'keystore.properties') -Destination (Join-Path $testRoot 'unused-fixture.properties')
Put $gradle ($sourceGradle.Replace('namespace = "com.example.source"', 'namespace = "com.example.changed"'))
Reject { Get-LocalApkIdentityProfile $config $repo $testRoot } 'namespace and Tauri identifier'
Put $gradle $sourceGradle
Assert-LocalApkSigningCertificate $profile
Check ($script:toolCalls.Count -eq 1) 'explicit existing key certificate is checked through the stubbed tool'
$script:keyDigest = (@('BB') * 32) -join ':'
Reject { Assert-LocalApkSigningCertificate $profile } 'certificate does not match'
$script:keyDigest = $certificate
$cache = Join-Path $testRoot 'cache'
Put (Join-Path $cache 'modules-2/fixture') 'dependency-cache fixture'
$wrapperCache = Join-Path $testRoot 'existing-wrapper/dists'
Put (Join-Path $wrapperCache 'fixture/gradle.zip') 'wrapper-cache fixture'
$settings.readOnlyDependencyCache = $cache
$settings.wrapperCacheDirectory = $wrapperCache
$profile = Get-LocalApkIdentityProfile $config $repo $testRoot
$sourceBefore = (Get-FileHash -LiteralPath $gradle -Algorithm SHA256).Hash
$gradleHome = Initialize-LocalApkIdentityProfile $profile
Check ($env:GRADLE_USER_HOME -ceq $gradleHome) 'both child build routes inherit the scoped Gradle home'
Check ($env:GRADLE_RO_DEP_CACHE -ceq $cache) 'dependency cache is reused through the explicit read-only mechanism'
Check (Test-Path -LiteralPath (Join-Path $gradleHome 'wrapper/dists/fixture/gradle.zip')) 'wrapper cache is copied into the task home'
Check (Test-Path -LiteralPath (Join-Path $wrapperCache 'fixture/gradle.zip')) 'source wrapper cache is retained'
Check ((Initialize-LocalApkIdentityProfile $profile) -ceq $gradleHome) 'matching scoped profile is reusable'
Check ((Get-FileHash -LiteralPath $gradle -Algorithm SHA256).Hash -ceq $sourceBefore) 'source Gradle file is never edited'
$profile.versionCode = 1001
Check ((Initialize-LocalApkIdentityProfile $profile) -cne $gradleHome) 'profile inputs invalidate the Gradle configuration home'
$profile.versionCode = 1000
Put (Join-Path $gradleHome 'init.d/unexpected.gradle') '// unexpected fixture'
Reject { Initialize-LocalApkIdentityProfile $profile } 'unknown or modified identity profile'

$apk = Join-Path $testRoot 'fixture.apk'
$native = Join-Path $testRoot 'libapp_lib.so'
Put $native 'synthetic ARM64 library fixture, not an executable'
$zip = [IO.Compression.ZipFile]::Open($apk, [IO.Compression.ZipArchiveMode]::Create)
try {
  $entry = $zip.CreateEntry('lib/arm64-v8a/libapp_lib.so')
  $stream = $entry.Open()
  try { $bytes = [IO.File]::ReadAllBytes($native); $stream.Write($bytes, 0, $bytes.Length) }
  finally { $stream.Dispose() }
} finally { $zip.Dispose() }
Check ((Assert-LocalApkArtifact $profile $apk $native).ApplicationId -ceq 'com.example.local') 'stub-decoded binary identity/classes/provider/certificate/native hash pass together'
$originalManifest = $script:binaryManifest
foreach ($change in @(
  @('package="com.example.local"', 'package="com.example.wrong"', 'Binary APK package'),
  @('android:versionCode="1000"', 'android:versionCode="999"', 'downgrade'),
  @('android:versionName="0.1.0"', 'android:versionName="9.9.9"', 'stale'),
  @('com.example.source.MainActivity', 'com.example.local.MainActivity', 'component class'),
  @('com.example.local.fileprovider', 'com.example.wrong.fileprovider', 'FileProvider')
)) {
  $script:binaryManifest = $originalManifest.Replace($change[0], $change[1])
  Reject { Assert-LocalApkArtifact $profile $apk $native } $change[2]
}
$script:binaryManifest = $originalManifest
$script:signerDigest = 'BB' * 32
Reject { Assert-LocalApkArtifact $profile $apk $native } 'signer certificate'
$script:signerDigest = 'AA' * 32
$originalDex = $script:dex; $script:dex = "C d 6`t6`t1929`tcom.example.source.OtherClass"
Reject { Assert-LocalApkArtifact $profile $apk $native } 'DEX definitions'
foreach ($row in @(
  "P d 6`t6`t1929`tcom.example.source.Application",
  "C r 6`t6`t1929`tcom.example.source.Application",
  'com.example.source.Application',
  "C d 6`t6`t1929`tcom.example.source.application",
  "C d 6`t6`t1929`tcom.example.source.ApplicationExtra",
  "C d 6`t6`t1929`ncom.example.source.Application"
)) {
  $script:dex = $originalDex.Replace("C d 6`t6`t1929`tcom.example.source.Application", $row)
  Reject { Assert-LocalApkArtifact $profile $apk $native } 'DEX definitions'
}
$script:dex = $originalDex
Put $native 'changed native fixture'
Reject { Assert-LocalApkArtifact $profile $apk $native } 'freshly compiled native library'
$readiness = Get-LocalApkReadiness $profile $repo
Check (-not $readiness.Verified -and -not $readiness.InstalledStateVerified) 'missing APK is explicit unverified evidence, not a service-start failure'
$expectedApk = Join-Path $android 'app/build/outputs/apk/universal/release/openchat-release.apk'
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($expectedApk)) | Out-Null
Copy-Item -LiteralPath $apk -Destination $expectedApk
Put (Join-Path $android 'app/src/main/jniLibs/arm64-v8a/libapp_lib.so') 'synthetic ARM64 library fixture, not an executable'
Check ((Get-LocalApkReadiness $profile $repo).Verified) 'a verified local artifact can be reported separately from installed state'
$script:signerDigest = 'BB' * 32
$readiness = Get-LocalApkReadiness $profile $repo
Check (-not $readiness.Verified -and $readiness.Reason -match 'signer certificate') 'a present wrong APK is explicitly unverified, never treated as a fallback'
$script:signerDigest = 'AA' * 32
$script:toolFailure = $true
Reject { Assert-LocalApkArtifact $profile $apk $native } 'fixture verification tool failed'
$script:toolFailure = $false

# Execute the actual startup identity-validation block with fixture configuration.
# Its service/PocketIC startup is intentionally not invoked by these local tests.
function Get-RequiredConfigString($Config, [string]$Name) { [string](Get-LocalApkValue $Config $Name) }
function Get-OptionalConfigMap($Config, [string]$Name) { if ($Config.Contains($Name)) { $Config[$Name] } else { $null } }
function Assert-File([string]$Path, [string]$Description) { if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Description missing" } }
$startup = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'start-environment.ps1') -Raw
$start = $startup.IndexOf('$LocalApkIdentityProfile = Get-LocalApkIdentityProfile')
$end = $startup.IndexOf('$aiAppConfig =', $start)
Check ($start -ge 0 -and $end -gt $start) 'actual startup identity block remains testable'
$startupIdentity = [scriptblock]::Create($startup.Substring($start, $end - $start) + '; $LocalApkIdentityProfile')
$EnvironmentConfig = $config
$OpenChatRepo = $repo
$configDirectory = $testRoot
$openChatConfig = $config.openChat
$toolCount = $script:toolCalls.Count
Check (($null -ne (& $startupIdentity)) -and $script:toolCalls.Count -eq $toolCount) 'explicit profile allows server config before APK/signing tools are invoked'
$settings.enabled = $false
Reject { & $startupIdentity } 'does not match'
$config.openChat.androidLink.packageName = 'com.example.source'
Check ($null -eq (& $startupIdentity)) 'no-profile matching source identity keeps existing startup behavior'
$config.openChat.androidLink.packageName = 'com.example.local'
$settings.enabled = $true

$tokens = $null; $parseErrors = $null
$builderAst = [Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $PSScriptRoot 'build-openchat-android.ps1'), [ref]$tokens, [ref]$parseErrors
)
Check ($parseErrors.Count -eq 0) 'builder parses after metadata path changes'
foreach ($mode in @('DryRun', 'ValidateOnly')) {
  $condition = '$' + $mode
  $gates = @($builderAst.FindAll({ param($node)
    $node -is [Management.Automation.Language.IfStatementAst] -and
      $node.Clauses[0].Item1.Extent.Text -ceq $condition
  }, $true))
  Check ($gates.Count -eq 1) "unique actual builder $mode gate"
  $exits = @($gates[0].FindAll({ param($node) $node -is [Management.Automation.Language.ExitStatementAst] }, $true))
  Check ($exits.Count -eq 0) "$mode must not terminate the host before metadata is flushed"
  $probe = 'Set-StrictMode -Version Latest; ' + $condition + '=$true; $v=@{fixture="value"}; $tauri="fixture command"; $fallback="fixture fallback"; $profilePlan=$null; ' +
    $gates[0].Extent.Text + '; throw "validation did not return before the build"'
  $metadata = @(& pwsh.exe -NoProfile -Command $probe)
  Check ($LASTEXITCODE -eq 0 -and ($metadata -join "`n") -match $mode -and ($metadata -join "`n") -match 'True') "$mode returns visible metadata without starting a build"
}

$gradleFixture = $false
if ($GradleLib) {
  if (-not (Test-Path -LiteralPath $GradleLib -PathType Container)) { throw 'Explicit Gradle library directory is missing' }
  & java.exe -cp (Join-Path $GradleLib '*') groovy.ui.GroovyMain `
    (Join-Path $PSScriptRoot 'local-apk-identity.init.selftest.groovy') `
    (Join-Path $PSScriptRoot 'local-apk-identity.init.gradle')
  if ($LASTEXITCODE -ne 0) { throw 'Actual init-script lifecycle fixture failed' }
  $gradleFixture = $true
}
[pscustomobject]@{ Valid = $true; Checks = $script:checks; GradleLifecycleFixtureRan = $gradleFixture; FixturesOnly = $true; RealKeysRead = $false; RealApkBuilt = $false; FixtureDirectory = $testRoot }
