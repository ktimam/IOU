# Build-only identity profile. Dot-sourcing this file never reads a key or starts a tool.
Set-StrictMode -Version Latest

function Set-LocalAndroidTauriCli([string]$Repo) {
  $paths = [ordered]@{
    OPENCHAT_TAURI_JS = Join-Path $Repo 'frontend/node_modules/@tauri-apps/cli/tauri.js'
    OPENCHAT_TAURI_CMD = Join-Path $Repo 'frontend/node_modules/.bin/tauri.cmd'
  }
  foreach ($entry in $paths.GetEnumerator()) {
    if (-not (Test-Path -LiteralPath $entry.Value -PathType Leaf)) {
      throw 'The selected checkout is missing its installed Tauri CLI; restore its exact dependencies before building'
    }
  }
  foreach ($entry in $paths.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, [IO.Path]::GetFullPath($entry.Value), 'Process')
  }
}

function Get-LocalApkValue([Collections.IDictionary]$Map, [string]$Name) {
  if ($null -eq $Map -or -not $Map.Contains($Name) -or
      [string]::IsNullOrWhiteSpace([string]$Map[$Name])) { throw "Missing local APK setting: $Name" }
  $Map[$Name]
}

function Resolve-LocalApkPath([string]$Path, [string]$BaseDirectory) {
  if (-not [IO.Path]::IsPathRooted($Path)) { $Path = Join-Path $BaseDirectory $Path }
  [IO.Path]::GetFullPath($Path)
}

function Assert-LocalApkChildPath([string]$Path, [string]$Parent) {
  $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  if (-not [IO.Path]::GetFullPath($Path).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Local APK task path must be strictly inside the configured temporary root'
  }
  $ancestor = [IO.Path]::GetFullPath($Path)
  while ($ancestor) {
    if ((Test-Path -LiteralPath $ancestor) -and
        ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'Local APK task paths must not traverse reparse points'
    }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
  }
}

function ConvertFrom-LocalApkXml([string]$Text) {
  $settings = [Xml.XmlReaderSettings]::new()
  $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver = $null
  $reader = [Xml.XmlReader]::Create([IO.StringReader]::new($Text), $settings)
  try {
    $document = [Xml.XmlDocument]::new()
    $document.XmlResolver = $null
    $document.Load($reader)
    return ,$document
  } finally { $reader.Dispose() }
}

function Get-LocalApkAttribute([Xml.XmlElement]$Element, [string]$Name) {
  $Element.GetAttribute($Name, 'http://schemas.android.com/apk/res/android')
}

function Get-LocalApkSourceIdentity([string]$Repo) {
  $gradlePath = Join-Path $Repo 'frontend/src-tauri/gen/android/app/build.gradle.kts'
  $tauriPath = Join-Path $Repo 'frontend/src-tauri/tauri.conf.json'
  $manifestPath = Join-Path $Repo 'frontend/src-tauri/gen/android/app/src/main/AndroidManifest.xml'
  $gradle = Get-Content -LiteralPath $gradlePath -Raw
  $tauri = Get-Content -LiteralPath $tauriPath -Raw | ConvertFrom-Json
  $values = @{}
  foreach ($name in @('applicationId', 'namespace')) {
    $matches = @([regex]::Matches($gradle, "(?m)^\s*$name\s*=\s*`"([A-Za-z][A-Za-z0-9_.]*)`"\s*$"))
    if ($matches.Count -ne 1) { throw "Expected exactly one literal Android $name" }
    $values[$name] = $matches[0].Groups[1].Value
  }
  if ($values.namespace -cne $tauri.identifier -or $values.applicationId -cne $values.namespace) {
    throw 'Source Android applicationId, namespace and Tauri identifier must agree; do not override Tauri identity'
  }
  $manifest = ConvertFrom-LocalApkXml (Get-Content -LiteralPath $manifestPath -Raw)
  $components = @($manifest.SelectNodes('/manifest/application | /manifest/application/activity | /manifest/application/service | /manifest/application/receiver')) |
    ForEach-Object {
      $name = Get-LocalApkAttribute $_ 'name'
      if (-not $name) { throw 'Source Android component has no declared class' }
      if ($name.StartsWith('.')) { $name = $values.namespace + $name }
      elseif (-not $name.Contains('.')) { $name = $values.namespace + '.' + $name }
      [ordered]@{ kind = $_.LocalName; name = $name }
    }
  if (@($components).Count -lt 4) { throw 'Source Android component contract is incomplete' }
  $values.versionName = [string]$tauri.version
  $values.components = @($components)
  $values.sourceDigests = @($gradlePath, $tauriPath, $manifestPath) | ForEach-Object {
    (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash
  }
  $values
}

function Get-LocalApkIdentityProfile {
  [CmdletBinding()]
  param([Collections.IDictionary]$Config, [string]$Repo, [string]$ConfigDirectory)
  if (-not $Config.Contains('androidBuild')) { return $null }
  $build = $Config['androidBuild']
  if ($build -isnot [Collections.IDictionary] -or -not $build.Contains('localIdentityProfile')) { return $null }
  $settings = $build['localIdentityProfile']
  if ($settings -isnot [Collections.IDictionary] -or -not $settings.Contains('enabled') -or
      $settings['enabled'] -isnot [bool]) { throw 'localIdentityProfile.enabled must be an explicit boolean' }
  if (-not $settings['enabled']) { return $null }
  $known = @('enabled', 'tempRoot', 'taskDirectory', 'minimumVersionCode', 'versionCode', 'versionName', 'signing', 'readOnlyDependencyCache', 'wrapperCacheDirectory')
  foreach ($name in $settings.Keys) {
    if ($name -notin $known) { throw "Unknown local identity profile field: $name" }
  }
  $source = Get-LocalApkSourceIdentity $Repo
  $intentsPath = Join-Path $Repo 'frontend/tauri-plugin-oc/android/src/main/java/IntentsManager.kt'
  $applicationClass = @($source.components | Where-Object { $_.kind -ceq 'application' })[0].name
  $applicationPath = Join-Path $Repo ('frontend/src-tauri/gen/android/app/src/main/java/' + $applicationClass.Replace('.', '/') + '.kt')
  $intents = Get-Content -LiteralPath $intentsPath -Raw
  $application = Get-Content -LiteralPath $applicationPath -Raw
  if ($intents -notmatch '\bfun\s+registerComponents\s*\(' -or $intents -match 'Class\.forName\s*\(' -or
      $application -notmatch 'IntentsManager\.registerComponents\s*\(') {
    throw 'Source is missing the generic application-registered notification component prerequisite'
  }
  $source.sourceDigests += @($intentsPath, $applicationPath) | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }
  $openChat = Get-LocalApkValue $Config 'openChat'
  $link = Get-LocalApkValue $openChat 'androidLink'
  $package = [string](Get-LocalApkValue $link 'packageName')
  $certificate = [string](Get-LocalApkValue $link 'certificateSha256')
  if ($package -cnotmatch '^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$') { throw 'Invalid linked Android package name' }
  if ($certificate -notmatch '^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$') { throw 'Invalid linked Android certificate SHA-256' }
  $signing = Get-LocalApkValue $settings 'signing'
  if ($signing -isnot [Collections.IDictionary] -or (Get-LocalApkValue $signing 'kind') -cne 'existing-debug') {
    throw 'Only explicitly selected existing-debug signing is supported by this local profile'
  }
  foreach ($name in $signing.Keys) {
    if ($name -notin @('kind', 'keystorePath')) { throw "Unsupported local signing field: $name" }
  }
  $key = Resolve-LocalApkPath (Get-LocalApkValue $signing 'keystorePath') $ConfigDirectory
  if (-not (Test-Path -LiteralPath $key -PathType Leaf)) { throw 'Explicit existing debug keystore is missing; no key will be generated' }
  foreach ($name in @('OC_ANDROID_KEYSTORE_PATH', 'OC_ANDROID_KEYSTORE_PASSWORD', 'OC_ANDROID_KEY_ALIAS', 'OC_ANDROID_KEY_PASSWORD', 'OC_ANDROID_REQUIRE_RELEASE_SIGNING', 'OC_ANDROID_VERSION_NAME', 'TAURI_CONFIG')) {
    if (-not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($name, 'Process'))) {
      throw "Local APK identity profile conflicts with ambient $name; use a clean child process"
    }
  }
  $androidRoot = Join-Path $Repo 'frontend/src-tauri/gen/android'
  if (Test-Path -LiteralPath (Join-Path $androidRoot 'keystore.properties')) {
    throw 'Local APK profile refuses an ambient keystore.properties signing configuration'
  }
  $minimum = 0L
  if (-not [long]::TryParse([string](Get-LocalApkValue $settings 'minimumVersionCode'), [ref]$minimum) -or
      $minimum -lt 1 -or $minimum -gt 2100000000) { throw 'minimumVersionCode must be a positive supported Android version code' }
  $versionName = if ($settings.Contains('versionName')) { [string]$settings['versionName'] } else { $source.versionName }
  if ($versionName -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'Local native versionName must be numeric major.minor.patch, not WebsiteVersion' }
  $parts = $versionName.Split('.') | ForEach-Object { [long]$_ }
  if ($parts[0] -gt 2000 -or $parts[1] -gt 999 -or $parts[2] -gt 999) { throw 'Local native version is outside the supported Tauri version range' }
  $versionCode = $parts[0] * 1000000 + $parts[1] * 1000 + $parts[2]
  if ($settings.Contains('versionCode')) {
    if (-not [long]::TryParse([string]$settings['versionCode'], [ref]$versionCode)) { throw 'Invalid local versionCode' }
  }
  if ($versionCode -lt $minimum -or $versionCode -gt 2100000000) { throw 'Local APK versionCode would downgrade the configured installed version' }
  $tempRoot = Resolve-LocalApkPath (Get-LocalApkValue $settings 'tempRoot') $ConfigDirectory
  $taskDirectory = Resolve-LocalApkPath (Get-LocalApkValue $settings 'taskDirectory') $tempRoot
  Assert-LocalApkChildPath $taskDirectory $tempRoot
  if ($taskDirectory.StartsWith([IO.Path]::GetFullPath($Repo), [StringComparison]::OrdinalIgnoreCase)) { throw 'Local Gradle profile must not be placed in the source checkout' }
  $sdk = Resolve-LocalApkPath (Get-LocalApkValue $build 'sdkRoot') $ConfigDirectory
  $buildTools = [string](Get-LocalApkValue $build 'buildToolsVersion')
  if ($buildTools -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid Android buildToolsVersion' }
  $result = [ordered]@{
    schemaVersion = 1; androidRoot = [IO.Path]::GetFullPath($androidRoot); namespace = $source.namespace
    applicationId = $package; certificateSha256 = $certificate.Replace(':', '').ToUpperInvariant()
    keystorePath = $key; minimumVersionCode = $minimum; versionCode = $versionCode; versionName = $versionName
    components = $source.components; sourceDigests = $source.sourceDigests; taskDirectory = $taskDirectory
    apksigner = Join-Path $sdk "build-tools/$buildTools/apksigner.bat"
    apkanalyzer = Join-Path $sdk 'cmdline-tools/latest/bin/apkanalyzer.bat'
    readOnlyDependencyCache = $null; wrapperCacheDirectory = $null
  }
  foreach ($name in @('readOnlyDependencyCache', 'wrapperCacheDirectory')) {
    if ($settings.Contains($name)) {
      $path = Resolve-LocalApkPath ([string]$settings[$name]) $ConfigDirectory
      if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw "Configured $name is missing" }
      if ($name -eq 'readOnlyDependencyCache' -and -not (Test-Path -LiteralPath (Join-Path $path 'modules-2') -PathType Container)) { throw 'Read-only Gradle dependency cache must contain modules-2' }
      if ($name -eq 'wrapperCacheDirectory' -and [IO.Path]::GetFileName($path.TrimEnd('\', '/')) -cne 'dists') { throw 'Wrapper cache reuse must explicitly name the wrapper/dists directory' }
      if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cache reuse cannot traverse a reparse point' }
      $result[$name] = $path
    }
  }
  return $result
}

function Invoke-LocalApkTool([string]$Executable, [string[]]$Arguments) {
  $output = & $Executable @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Local APK verification tool failed: $([IO.Path]::GetFileName($Executable)) ($LASTEXITCODE)" }
  ($output | Out-String)
}

function Assert-LocalApkSigningCertificate([Collections.IDictionary]$Profile) {
  $output = Invoke-LocalApkTool 'keytool.exe' @('-J-Duser.language=en', '-J-Duser.country=US', '-list', '-v', '-keystore', $Profile.keystorePath, '-alias', 'androiddebugkey', '-storepass', 'android')
  $matches = @([regex]::Matches($output, '(?m)^\s*SHA256:\s*((?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2})\s*$'))
  if ($matches.Count -ne 1 -or $matches[0].Groups[1].Value.Replace(':', '').ToUpperInvariant() -cne $Profile.certificateSha256) {
    throw 'Existing debug key certificate does not match openChat.androidLink; no APK build was started'
  }
}

function Initialize-LocalApkIdentityProfile([Collections.IDictionary]$Profile) {
  $initSource = Join-Path $PSScriptRoot 'local-apk-identity.init.gradle'
  $payload = [ordered]@{}
  foreach ($entry in $Profile.GetEnumerator()) { $payload[$entry.Key] = $entry.Value }
  $payload.initSha256 = (Get-FileHash -LiteralPath $initSource -Algorithm SHA256).Hash
  $payload.helperSha256 = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'local-apk-identity.ps1') -Algorithm SHA256).Hash
  $json = $payload | ConvertTo-Json -Depth 12 -Compress
  $fingerprint = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($json)))
  $gradleHome = Join-Path $Profile.taskDirectory $fingerprint.ToLowerInvariant()
  Assert-LocalApkChildPath $gradleHome $Profile.taskDirectory
  $profilePath = Join-Path $gradleHome 'local-identity.json'
  $initDirectory = Join-Path $gradleHome 'init.d'
  $initPath = Join-Path $initDirectory 'local-identity.gradle'
  Assert-LocalApkChildPath $profilePath $gradleHome
  Assert-LocalApkChildPath $initPath $gradleHome
  if (Test-Path -LiteralPath $gradleHome) {
    if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf) -or
        (Get-Content -LiteralPath $profilePath -Raw) -cne $json -or
        -not (Test-Path -LiteralPath $initPath -PathType Leaf) -or
        (Get-FileHash -LiteralPath $initPath -Algorithm SHA256).Hash -cne $payload.initSha256 -or
        @(Get-ChildItem -LiteralPath $initDirectory -Force).Count -ne 1 -or
        (Test-Path -LiteralPath (Join-Path $gradleHome 'init.gradle')) -or
        (Test-Path -LiteralPath (Join-Path $gradleHome 'init.gradle.kts'))) { throw 'Existing task Gradle home has an unknown or modified identity profile' }
  } else {
    [IO.Directory]::CreateDirectory($initDirectory) | Out-Null
    [IO.File]::WriteAllText($profilePath, $json, [Text.UTF8Encoding]::new($false))
    Copy-Item -LiteralPath $initSource -Destination $initPath
    if ($Profile.wrapperCacheDirectory) {
      $cacheEntries = @(Get-ChildItem -LiteralPath $Profile.wrapperCacheDirectory -Recurse -Force)
      if ($cacheEntries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Wrapper cache contains a reparse point; no cache link traversal is allowed' }
      $wrapper = Join-Path $gradleHome 'wrapper'
      [IO.Directory]::CreateDirectory($wrapper) | Out-Null
      Copy-Item -LiteralPath $Profile.wrapperCacheDirectory -Destination (Join-Path $wrapper 'dists') -Recurse
    }
  }
  [Environment]::SetEnvironmentVariable('GRADLE_USER_HOME', $gradleHome, 'Process')
  [Environment]::SetEnvironmentVariable('GRADLE_RO_DEP_CACHE', $Profile.readOnlyDependencyCache, 'Process')
  [Environment]::SetEnvironmentVariable('OC_LOCAL_APK_IDENTITY_PROFILE', $profilePath, 'Process')
  $gradleHome
}

function Assert-LocalApkArtifact([Collections.IDictionary]$Profile, [string]$Apk, [string]$NativeLibrary) {
  if (-not (Test-Path -LiteralPath $Apk -PathType Leaf)) { throw 'Profile APK is missing; build and verify it before installing the linked app' }
  $signature = Invoke-LocalApkTool $Profile.apksigner @('verify', '--verbose', '--print-certs', $Apk)
  $certificates = @([regex]::Matches($signature, '(?m)^Signer #\d+ certificate SHA-256 digest:\s*([A-Fa-f0-9]{64})\s*$'))
  if ($certificates.Count -ne 1 -or $certificates[0].Groups[1].Value.ToUpperInvariant() -cne $Profile.certificateSha256) { throw 'APK signer certificate does not match the configured linked account identity' }
  $manifest = ConvertFrom-LocalApkXml (Invoke-LocalApkTool $Profile.apkanalyzer @('manifest', 'print', $Apk))
  if ($manifest.DocumentElement.GetAttribute('package') -cne $Profile.applicationId) { throw 'Binary APK package does not match openChat.androidLink' }
  $code = Get-LocalApkAttribute $manifest.DocumentElement 'versionCode'
  $versionName = Get-LocalApkAttribute $manifest.DocumentElement 'versionName'
  if ($code -notmatch '^\d+$' -or [long]$code -ne $Profile.versionCode -or [long]$code -lt $Profile.minimumVersionCode -or $versionName -cne $Profile.versionName) { throw 'Binary APK version is stale, mismatched or would downgrade the installed app' }
  $dex = Invoke-LocalApkTool $Profile.apkanalyzer @('dex', 'packages', '--defined-only', $Apk)
  foreach ($component in $Profile.components) {
    $nodes = if ($component.kind -eq 'application') { @($manifest.SelectNodes('/manifest/application')) } else { @($manifest.SelectNodes("/manifest/application/$($component.kind)")) }
    if (@($nodes | Where-Object { (Get-LocalApkAttribute $_ 'name') -ceq $component.name }).Count -ne 1) { throw 'Binary APK component class differs from the unchanged source namespace' }
    # Default apkanalyzer output has C d plus three integer counts for a defined
    # class. Package/reference rows and loose tokens do not prove a class exists.
    $classRow = '(?m)^[\t ]*C[\t ]+d[\t ]+\d+[\t ]+\d+[\t ]+\d+[\t ]+' +
      [regex]::Escape($component.name) + '[\t ]*\r?$'
    if ($dex -cnotmatch $classRow) { throw 'Declared APK component class is missing from DEX definitions' }
  }
  $providers = @($manifest.SelectNodes('/manifest/application/provider') | Where-Object { (Get-LocalApkAttribute $_ 'name') -ceq 'androidx.core.content.FileProvider' })
  if ($providers.Count -ne 1 -or (Get-LocalApkAttribute $providers[0] 'authorities') -cne ($Profile.applicationId + '.fileprovider')) { throw 'Binary APK FileProvider authority does not match its installed application ID' }
  $archive = [IO.Compression.ZipFile]::OpenRead($Apk)
  try {
    $entry = $archive.GetEntry('lib/arm64-v8a/libapp_lib.so')
    if ($null -eq $entry -or $entry.Length -eq 0) { throw 'APK is missing the ARM64 native library' }
    $stream = $entry.Open()
    try { $nativeHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)) }
    finally { $stream.Dispose() }
    if (-not (Test-Path -LiteralPath $NativeLibrary -PathType Leaf) -or
        $nativeHash -cne (Get-FileHash -LiteralPath $NativeLibrary -Algorithm SHA256).Hash) { throw 'APK does not contain the freshly compiled native library' }
  } finally { $archive.Dispose() }
  [pscustomobject]@{ ApplicationId = $Profile.applicationId; VersionCode = [long]$code; CertificateSha256 = $Profile.certificateSha256; NativeSha256 = $nativeHash }
}

function Get-LocalApkReadiness([Collections.IDictionary]$Profile, [string]$Repo) {
  # Service startup is needed before the first APK's real public-key query. Artifact
  # readiness is separate evidence and never blocks that prerequisite or proves install state.
  if ($null -eq $Profile) { return [pscustomobject]@{ Verified = $false; Reason = 'No local identity profile requested'; InstalledStateVerified = $false } }
  $apk = Join-Path $Repo 'frontend/src-tauri/gen/android/app/build/outputs/apk/universal/release/openchat-release.apk'
  $native = Join-Path $Repo 'frontend/src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/libapp_lib.so'
  try {
    Assert-LocalApkArtifact $Profile $apk $native | Out-Null
    [pscustomobject]@{ Verified = $true; Reason = 'Local artifact identity verified; installed account/model retention is not checked'; InstalledStateVerified = $false }
  } catch {
    [pscustomobject]@{ Verified = $false; Reason = $_.Exception.Message; InstalledStateVerified = $false }
  }
}
