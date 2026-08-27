<#
.SYNOPSIS
Starts or verifies the complete preserved OpenChat + IOU phone-development environment.

.DESCRIPTION
This is the one normal entry point after a reboot. It is deliberately fail-closed:

* the authoritative recovered PocketIC manager must validate the exact three-subnet topology and
  deployed canisters;
* an anonymous UserIndex `ai_apps` query must find the exact published IOU registration;
* both Windows Vite servers, OpenChat's ordinary/background workers, the all-WebGPU runtime assets,
  the configured pinned processor/graph routes, and one immutable restored image must answer with their expected shape;
* the two phone-facing Tailscale HTTPS origins must reach the matching local service.

Generic startup never cleans, deploys, registers, publishes, upgrades, or repairs state. If strict
PocketIC reopen reports incomplete state, use the separate, explicit `repair` action documented by
`pocketic-recovered.ps1` only after reviewing its timestamped backup plan.

.EXAMPLE
pwsh -File scripts/live/start-environment.ps1 -EnvironmentConfigPath scripts/live/start-environment.local.json
pwsh -File scripts/live/start-environment.ps1 -Action Status -EnvironmentConfigPath scripts/live/start-environment.local.json
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('Start', 'Status', 'ValidateConfig')]
  [string]$Action = 'Start',

  [Parameter(Mandatory)]
  [ValidateNotNullOrEmpty()]
  [string]$EnvironmentConfigPath,

  [ValidateRange(30, 600)]
  [int]$TimeoutSeconds = 240,

  [switch]$RestartFrontends,

  [switch]$SkipTailscaleConfiguration
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Capture a caller-supplied relative path while the process is still in the caller's directory.
# All later script/helper location changes must use this immutable absolute path.
. (Join-Path $PSScriptRoot 'environment-config.ps1')
$EnvironmentConfigPath = Resolve-EnvironmentConfigPath -Path $EnvironmentConfigPath

$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$RecoveredManager = Join-Path $PSScriptRoot 'pocketic-recovered.ps1'
$AiAppChecker = Join-Path $PSScriptRoot 'check-openchat-ai-app.ts'
$IouEnvFile = Join-Path $RepoRoot '.env.local'
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Tsx = Join-Path $RepoRoot 'node_modules\.bin\tsx.cmd'

$OpenChatOrigin = 'http://127.0.0.1:5003'
$IouOrigin = 'http://127.0.0.1:3000'

function Write-Step([string]$Message) {
  Write-Host "[environment] $Message"
}

function Assert-File([string]$Path, [string]$Description) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Description is missing: $Path"
  }
}

function Get-RequiredConfigString(
  [Collections.IDictionary]$Config,
  [string]$Name
) {
  if (-not $Config.Contains($Name)) {
    throw "Environment config is missing required key '$Name'"
  }
  $value = "$($Config[$Name])".Trim()
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Environment config key '$Name' must not be empty"
  }
  $value
}

function Get-RequiredConfigInt64(
  [Collections.IDictionary]$Config,
  [string]$Name
) {
  $text = Get-RequiredConfigString -Config $Config -Name $Name
  $value = 0L
  if (-not [int64]::TryParse($text, [ref]$value) -or $value -le 0) {
    throw "Environment config key '$Name' must be a positive integer"
  }
  $value
}

function Get-RequiredConfigMap(
  [Collections.IDictionary]$Config,
  [string]$Name
) {
  if (-not $Config.Contains($Name) -or
      $Config[$Name] -isnot [Collections.IDictionary]) {
    throw "Environment config key '$Name' must be a JSON object"
  }
  $Config[$Name]
}

function Get-RequiredConfigStringArray(
  [Collections.IDictionary]$Config,
  [string]$Name
) {
  if (-not $Config.Contains($Name) -or
      $Config[$Name] -is [string] -or
      $Config[$Name] -isnot [Collections.IEnumerable]) {
    throw "Environment config key '$Name' must be a JSON array of strings"
  }
  $values = @($Config[$Name])
  if ($values.Count -lt 1) {
    throw "Environment config key '$Name' must contain at least one string"
  }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($value in $values) {
    if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value)) {
      throw "Environment config key '$Name' must contain only non-empty strings"
    }
    $normalized = $value.Trim()
    if (-not $seen.Add($normalized)) {
      throw "Environment config key '$Name' must not contain duplicate strings"
    }
    $normalized
  }
}

function Resolve-ConfiguredPath([string]$Path, [string]$BaseDirectory) {
  if ([IO.Path]::IsPathRooted($Path)) {
    return [IO.Path]::GetFullPath($Path)
  }
  [IO.Path]::GetFullPath((Join-Path $BaseDirectory $Path))
}

function Get-DotEnvValue([string]$Path, [string]$Name) {
  Assert-File -Path $Path -Description '.env.local'
  $pattern = '^\s*{0}=(.*)$' -f [regex]::Escape($Name)
  $lines = @(Get-Content -LiteralPath $Path | Where-Object { $_ -match $pattern })
  if ($lines.Count -ne 1) {
    throw "Expected exactly one $Name entry in $Path"
  }
  if ($lines[0] -notmatch $pattern) { throw "Could not parse $Name from $Path" }
  $value = $Matches[1].Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  if ([string]::IsNullOrWhiteSpace($value)) { throw "$Name is empty in $Path" }
  $value
}

function Invoke-Http([string]$Uri, [string]$Method = 'Get', [int]$RequestTimeout = 15) {
  Invoke-WebRequest -Uri $Uri -Method $Method -UseBasicParsing -TimeoutSec $RequestTimeout
}

function Test-Http([string]$Uri, [string]$Method = 'Get') {
  try {
    $response = Invoke-Http -Uri $Uri -Method $Method -RequestTimeout 4
    $response.StatusCode -eq 200
  } catch {
    $false
  }
}

function Wait-Http([string]$Uri, [string]$Description, [string]$Method = 'Get') {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastError = $null
  do {
    try {
      $response = Invoke-Http -Uri $Uri -Method $Method -RequestTimeout 5
      if ($response.StatusCode -eq 200) { return $response }
      $lastError = "HTTP $($response.StatusCode)"
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 750
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "$Description did not become ready at $Uri within $TimeoutSeconds seconds: $lastError"
}

function Assert-HttpShape(
  [string]$Uri,
  [string]$Description,
  [string]$Method = 'Get',
  [int64]$MinimumBytes = 0,
  [int64]$ExpectedContentLength = -1,
  [string]$ExpectedContentType = '',
  [string]$ExpectedSha256 = '',
  [string[]]$Contains = @()
) {
  $response = Invoke-Http -Uri $Uri -Method $Method -RequestTimeout 30
  if ($response.StatusCode -ne 200) { throw "$Description returned HTTP $($response.StatusCode)" }
  if ($Method -eq 'Get' -and $response.RawContentLength -lt $MinimumBytes) {
    throw "$Description is unexpectedly small ($($response.RawContentLength) bytes)"
  }
  if ($ExpectedContentLength -ge 0) {
    $lengthText = "$($response.Headers['Content-Length'])"
    if ([string]::IsNullOrWhiteSpace($lengthText) -and $Method -eq 'Get') {
      $lengthText = "$($response.RawContentLength)"
    }
    $length = 0L
    if (-not [int64]::TryParse($lengthText, [ref]$length) -or $length -ne $ExpectedContentLength) {
      throw "$Description Content-Length mismatch: expected $ExpectedContentLength, got '$lengthText'"
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedContentType)) {
    $contentType = "$($response.Headers['Content-Type'])"
    if ($contentType -notmatch ('^{0}(?:\s*;|$)' -f [regex]::Escape($ExpectedContentType))) {
      throw "$Description Content-Type mismatch: expected $ExpectedContentType, got '$contentType'"
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedSha256)) {
    if ($Method -ne 'Get') { throw "$Description SHA-256 validation requires a GET request" }
    $bytes = if ($response.Content -is [byte[]]) {
      $response.Content
    } elseif ($response.Content -is [string]) {
      [Text.Encoding]::UTF8.GetBytes([string]$response.Content)
    } else {
      throw "$Description returned an unsupported body type for SHA-256 validation"
    }
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
      $actualSha256 = ([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
      $sha256.Dispose()
    }
    if ($actualSha256 -ne $ExpectedSha256.ToLowerInvariant()) {
      throw "$Description SHA-256 mismatch: expected $ExpectedSha256, got $actualSha256"
    }
  }
  if ($Contains.Count -gt 0) {
    $content = "$($response.Content)"
    foreach ($needle in $Contains) {
      if (-not $content.Contains($needle)) { throw "$Description does not contain '$needle'" }
    }
  }
  $response
}

function Test-LoopbackPort([int]$Port) {
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(500)) { return $false }
    $client.EndConnect($pending)
    $client.Connected
  } catch {
    $false
  } finally {
    $client.Dispose()
  }
}

function Get-LoopbackListenerPid([int]$Port) {
  $listenerPids = @()
  foreach ($line in @(& netstat.exe -ano -p tcp)) {
    if ($line -match ('^\s*TCP\s+127\.0\.0\.1:{0}\s+\S+\s+LISTENING\s+(\d+)\s*$' -f $Port)) {
      $listenerPids += [int]$Matches[1]
    }
  }
  $unique = @($listenerPids | Sort-Object -Unique)
  if ($unique.Count -eq 0) { return $null }
  if ($unique.Count -ne 1) { throw "Expected one 127.0.0.1:$Port listener, found $($unique -join ', ')" }
  $unique[0]
}

function Get-ExactViteListener([int]$Port) {
  $pidValue = Get-LoopbackListenerPid -Port $Port
  if ($null -eq $pidValue) { return $null }
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue"
  } catch {
    throw "Cannot inspect port $Port owner PID $pidValue; rerun from an elevated PowerShell"
  }
  if ($null -eq $process -or $process.Name -ne 'node.exe' -or
      $process.CommandLine -notmatch '(?i)\bvite(?:\.js)?\b' -or
      $process.CommandLine -notmatch ("(?i)--port\s+$Port(?:\s|$)") -or
      $process.CommandLine -notmatch '(?i)--host\s+127\.0\.0\.1(?:\s|$)' -or
      $process.CommandLine -notmatch '(?i)--strictPort\b') {
    $command = if ($null -eq $process) { '<missing>' } else { $process.CommandLine }
    throw "Port $Port is not owned by the exact expected loopback Vite process (PID $pidValue): $command"
  }
  $started = (Get-Process -Id $pidValue -ErrorAction Stop).StartTime
  [pscustomobject]@{ Pid = $pidValue; Started = $started; CommandLine = $process.CommandLine }
}

function Test-ViteConfigStale([int]$Port, [string]$ConfigPath) {
  if (-not (Test-LoopbackPort -Port $Port)) { return $false }
  $listener = Get-ExactViteListener -Port $Port
  Assert-File -Path $ConfigPath -Description 'Vite configuration'
  (Get-Item -LiteralPath $ConfigPath).LastWriteTime -gt $listener.Started
}

function Stop-ExactViteListener([int]$Port) {
  $listener = Get-ExactViteListener -Port $Port
  if ($null -eq $listener) { return }
  Write-Step "stopping exact Vite PID $($listener.Pid) on port $Port"
  try {
    # Stop-Process intermittently throws an internal NullReferenceException for a still-live
    # background Node process on this Windows host. The listener has already passed the exact
    # executable/command-line/port checks above, so terminate that one PID through Process.Kill.
    $target = [Diagnostics.Process]::GetProcessById([int]$listener.Pid)
    $target.Kill()
  } catch {
    if (Test-LoopbackPort -Port $Port) {
      throw "Failed to stop exact Vite PID $($listener.Pid) on port $Port`: $($_.Exception.Message)"
    }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    if (-not (Test-LoopbackPort -Port $Port)) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Exact Vite PID $($listener.Pid) did not release port $Port"
}

function Start-NodeDevServer(
  [string]$WorkingDirectory,
  [string]$ViteScript,
  [int]$Port,
  [string]$StdoutLog,
  [string]$StderrLog
) {
  if (Test-LoopbackPort -Port $Port) {
    throw "Port $Port is occupied but its expected service is unhealthy; refusing to replace an unknown process"
  }
  Assert-File -Path $ViteScript -Description 'Vite entry point'
  Write-Step "starting Vite on 127.0.0.1:$Port"
  $process = Start-Process -FilePath $Node `
    -ArgumentList @($ViteScript, '--host', '127.0.0.1', '--port', "$Port", '--strictPort') `
    -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog
  if ($null -eq $process) { throw "Failed to start Vite on port $Port" }
}

function Start-OpenChatVite {
  $appDir = Join-Path $OpenChatRepo 'frontend\app'
  $vite = Join-Path $OpenChatRepo 'frontend\node_modules\vite\bin\vite.js'
  $settings = @{
    NODE_OPTIONS = '--max-old-space-size=8192'
    NODE_ENV = 'development'
    OC_CANISTER_URL_PATH = "http://{canisterId}.localhost:$GatewayPort"
    OC_BITCOIN_MAINNET_ENABLED = 'false'
    OC_ACCOUNT_LINKING_CODES_ENABLED = 'true'
    OC_BLOB_URL_PATTERN = "http://{canisterId}.raw.localhost:$GatewayPort/{blobType}"
    OC_BUILD_ENV = 'development'
    OC_WEBAUTHN_ORIGIN = 'localhost'
    OC_DEV_PORT = '5003'
    OC_DFX_NETWORK = 'local'
    OC_INTERNET_IDENTITY_CANISTER_ID = $InternetIdentityCanisterId
    OC_INTERNET_IDENTITY_URL = "http://$InternetIdentityCanisterId.localhost:$GatewayPort"
    OC_NFID_URL = "http://$InternetIdentityCanisterId.localhost:$GatewayPort"
    OC_NODE_ENV = 'development'
    OC_VAPID_PUBLIC_KEY = $OpenChatVapidPublicKey
    OC_VIDEO_BRIDGE_URL = 'http://localhost:5050'
    OC_WALLET_CONNECT_PROJECT_ID = $WalletConnectProjectId
    OC_BASE_ORIGIN = 'http://localhost:5003'
    OC_DEV_ALLOWED_HOST = $TailnetHost
    OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE = 'true'
  }
  $saved = @{}
  foreach ($name in $settings.Keys) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $settings[$name], 'Process')
  }
  try {
    Start-NodeDevServer -WorkingDirectory $appDir -ViteScript $vite -Port 5003 `
      -StdoutLog (Join-Path $RepoRoot '.codex-openchat-vite.stdout.log') `
      -StderrLog (Join-Path $RepoRoot '.codex-openchat-vite.stderr.log')
  } finally {
    foreach ($name in $settings.Keys) {
      [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
    }
  }
}

function Start-IouVite {
  $vite = Join-Path $RepoRoot 'node_modules\vite\bin\vite.js'
  Start-NodeDevServer -WorkingDirectory $RepoRoot -ViteScript $vite -Port 3000 `
    -StdoutLog (Join-Path $RepoRoot '.codex-iou-vite.stdout.log') `
    -StderrLog (Join-Path $RepoRoot '.codex-iou-vite.stderr.log')
}

function Assert-PublishedIouApp {
  Assert-File -Path $AiAppChecker -Description 'AI app readiness checker'
  Assert-File -Path $Tsx -Description 'tsx command (run pnpm install if dependencies are absent)'
  $userIndex = Get-DotEnvValue -Path $IouEnvFile -Name 'VITE_OC_USER_INDEX_CANISTER_ID'
  $appCanister = Get-DotEnvValue -Path $IouEnvFile -Name 'VITE_IOU_BACKEND_CANISTER_ID'
  $inbox = Get-DotEnvValue -Path $IouEnvFile -Name 'VITE_ACTION_INBOX_CANISTER_ID'
  if ($userIndex -ne $ExpectedUserIndex -or $appCanister -ne $ExpectedAppCanister -or
      $inbox -ne $ExpectedInbox) {
    throw '.env.local canister ids do not match the explicit environment config'
  }
  $arguments = @(
    $AiAppChecker,
    '--host', $ReplicaOrigin,
    '--user-index', $ExpectedUserIndex,
    '--app-name', $AiAppName,
    '--expected-app-id', "$AiAppId",
    '--expected-app-canister', $ExpectedAppCanister,
    '--expected-inbox', $ExpectedInbox,
    '--expected-surface-origin', $ExpectedSurfaceOrigin
  )
  $output = @(& $Tsx @arguments 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Published IOU app readiness failed (no registration was changed): $($output -join [Environment]::NewLine)"
  }
  $line = ($output | ForEach-Object { "$_" }) -join ''
  try {
    $result = $line | ConvertFrom-Json
  } catch {
    throw "AI app readiness checker returned invalid JSON: $line"
  }
  if ($result.ready -ne $true) { throw "AI app readiness checker did not report ready" }
  Write-Step "published IOU app #$($result.app.id) revision $($result.app.revision) is visible anonymously"
}

function Assert-ReplicaReady {
  Assert-HttpShape -Uri "$ReplicaOrigin/api/v2/status" -Description 'PocketIC status' `
    -MinimumBytes 1 | Out-Null
  # This is the decisive gate. A fresh/empty PocketIC also returns status=200 but fails the exact
  # UserIndex/app query; generic startup must never accept that false positive again.
  Assert-PublishedIouApp
}

function Assert-OpenChatReady([string]$Origin) {
  Assert-HttpShape -Uri "$Origin/" -Description "OpenChat frontend at $Origin" `
    -MinimumBytes 1000 | Out-Null
  Assert-HttpShape -Uri "$Origin/worker.js" -Description 'OpenChat background worker' `
    -MinimumBytes 500000 | Out-Null
  $requiredWorkerMarkers = @($OrtPrefix, $OrtLoaderFile, $OrtWasmFile, $ModelRevision) +
    @($ModelWorkerRequiredMarkers)
  Assert-HttpShape -Uri "$Origin/transformers_webgpu_worker.js" `
    -Description 'OpenChat Transformers all-WebGPU worker' -MinimumBytes 500000 `
    -Contains $requiredWorkerMarkers | Out-Null
  Assert-HttpShape -Uri "$Origin$OrtPrefix/$OrtLoaderFile" `
    -Description 'pinned ONNX Runtime WebGPU loader' `
    -ExpectedContentLength $OrtLoaderBytes -ExpectedContentType 'text/javascript' `
    -ExpectedSha256 $OrtLoaderSha256 | Out-Null
  Assert-HttpShape -Uri "$Origin$OrtPrefix/$OrtWasmFile" `
    -Description 'matched ONNX Runtime WebGPU WASM' `
    -ExpectedContentLength $OrtWasmBytes -ExpectedContentType 'application/wasm' `
    -ExpectedSha256 $OrtWasmSha256 | Out-Null
  Assert-HttpShape -Uri "$Origin/src/utils/transformersWebGpuProtocol.ts" `
    -Description 'all-WebGPU device-map source' -MinimumBytes 1000 `
    -Contains @('decoder_model_merged', 'webgpu', $ModelRevision) | Out-Null
  Assert-HttpShape -Uri "$Origin$ModelPrefix/preprocessor_config.json" `
    -Description 'pinned model preprocessor route' -Method Head `
    -ExpectedContentLength $ModelProcessorBytes | Out-Null
  Assert-HttpShape -Uri "$Origin$ModelPrefix/processor_config.json" `
    -Description 'pinned model processor runtime route' `
    -ExpectedContentLength $ModelProcessorRuntimeBytes `
    -ExpectedSha256 $ModelProcessorRuntimeSha256 | Out-Null
  Assert-HttpShape -Uri "$Origin$ModelPrefix/onnx/vision_encoder_q4.onnx" `
    -Description 'patched model vision graph route' -Method Head `
    -ExpectedContentLength $ModelVisionGraphBytes | Out-Null
  Assert-HttpShape -Uri "$Origin$ModelPrefix/onnx/decoder_model_merged_q4.onnx" `
    -Description 'patched model decoder graph route' `
    -ExpectedContentLength $ModelDecoderGraphBytes `
    -ExpectedContentType 'application/octet-stream' `
    -ExpectedSha256 $ModelDecoderGraphSha256 | Out-Null
  # Probe one immutable image from the preserved replica. This catches a missing local-image proxy,
  # an empty/wrong PocketIC state, or Vite's HTML fallback masquerading as a successful response.
  # HEAD avoids transferring the receipt on every status check; exact type and length distinguish
  # the original 1080x1748 PNG from a thumbnail or index.html without decoding user content.
  Assert-HttpShape -Uri "$Origin$ImageProbePath" -Description 'restored original-image proxy' `
    -Method Head -ExpectedContentLength $ImageProbeBytes `
    -ExpectedContentType $ImageProbeContentType | Out-Null
  Assert-HttpShape -Uri "$Origin/api/v2/status" -Description 'OpenChat replica proxy' `
    -MinimumBytes 1 | Out-Null
}

function Assert-IouReady([string]$Origin) {
  Assert-HttpShape -Uri "$Origin/" -Description "IOU frontend at $Origin" -MinimumBytes 500 | Out-Null
  Assert-HttpShape -Uri "$Origin/api/v2/status" -Description 'IOU replica proxy' `
    -MinimumBytes 1 | Out-Null
}

function Test-TailscaleRoutes {
  try {
    Assert-OpenChatReady -Origin $TailOpenChatOrigin
    Assert-IouReady -Origin $TailIouOrigin
    $true
  } catch {
    Write-Verbose "Tailscale readiness failed: $($_.Exception.Message)"
    $false
  }
}

function Ensure-TailscaleRoutes {
  if (Test-TailscaleRoutes) {
    Write-Step 'existing Tailscale HTTPS routes are healthy'
    return
  }
  if ($SkipTailscaleConfiguration -or $Action -eq 'Status') {
    throw 'Tailscale HTTPS routes are not healthy; configuration was not changed'
  }
  Assert-File -Path $Tailscale -Description 'Tailscale CLI'
  Write-Step 'configuring only HTTPS :443 -> OpenChat and :8443 -> IOU (no reset)'
  & $Tailscale serve --bg --yes --https=443 $OpenChatOrigin
  if ($LASTEXITCODE -ne 0) { throw 'Failed to configure Tailscale OpenChat HTTPS route (run elevated)' }
  & $Tailscale serve --bg --yes --https=8443 $IouOrigin
  if ($LASTEXITCODE -ne 0) { throw 'Failed to configure Tailscale IOU HTTPS route (run elevated)' }

  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    if (Test-TailscaleRoutes) {
      Write-Step 'Tailscale HTTPS routes are healthy'
      return
    }
    Start-Sleep -Milliseconds 750
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Tailscale routes were configured but did not pass end-to-end readiness'
}

Assert-File -Path $EnvironmentConfigPath -Description 'environment config'
try {
  $EnvironmentConfig = Read-EnvironmentConfigFile -Path $EnvironmentConfigPath
} catch {
  throw "Could not load environment config $EnvironmentConfigPath`: $($_.Exception.Message)"
}
if ($EnvironmentConfig -isnot [Collections.IDictionary]) {
  throw "Environment config must contain one JSON object: $EnvironmentConfigPath"
}
$configDirectory = Split-Path -Parent $EnvironmentConfigPath
$pocketIcConfig = Get-RequiredConfigMap -Config $EnvironmentConfig -Name 'pocketIc'
$GatewayPort = Get-RequiredConfigInt64 -Config $pocketIcConfig -Name 'gatewayPort'
if ($GatewayPort -gt 65535) {
  throw "Environment config key 'pocketIc.gatewayPort' must be at most 65535"
}
$ReplicaOrigin = "http://127.0.0.1:$GatewayPort"

$OpenChatRepo = Resolve-ConfiguredPath `
  -Path (Get-RequiredConfigString -Config $EnvironmentConfig -Name 'openChatRepo') `
  -BaseDirectory $configDirectory
$Tailscale = Resolve-ConfiguredPath `
  -Path (Get-RequiredConfigString -Config $EnvironmentConfig -Name 'tailscaleExecutable') `
  -BaseDirectory $configDirectory
$TailnetHost = Get-RequiredConfigString -Config $EnvironmentConfig -Name 'tailnetHost'
if ($TailnetHost -notmatch '^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$') {
  throw "Environment config key 'tailnetHost' is not a valid Tailscale HTTPS host"
}
$TailOpenChatOrigin = "https://$TailnetHost"
$TailIouOrigin = "https://$TailnetHost`:8443"

$openChatConfig = Get-RequiredConfigMap -Config $EnvironmentConfig -Name 'openChat'
$InternetIdentityCanisterId = Get-RequiredConfigString `
  -Config $openChatConfig -Name 'internetIdentityCanisterId'
if ($InternetIdentityCanisterId -notmatch '^[a-z0-9-]+$') {
  throw "Environment config key 'openChat.internetIdentityCanisterId' is not a valid canister id"
}
$OpenChatVapidPublicKey = Get-RequiredConfigString `
  -Config $openChatConfig -Name 'vapidPublicKey'
$WalletConnectProjectId = Get-RequiredConfigString `
  -Config $openChatConfig -Name 'walletConnectProjectId'

$aiAppConfig = Get-RequiredConfigMap -Config $EnvironmentConfig -Name 'aiApp'
$AiAppName = Get-RequiredConfigString -Config $aiAppConfig -Name 'name'
$AiAppId = Get-RequiredConfigInt64 -Config $aiAppConfig -Name 'id'
$ExpectedUserIndex = Get-RequiredConfigString -Config $aiAppConfig -Name 'userIndexCanisterId'
$ExpectedAppCanister = Get-RequiredConfigString -Config $aiAppConfig -Name 'appCanisterId'
$ExpectedInbox = Get-RequiredConfigString -Config $aiAppConfig -Name 'inboxCanisterId'
$ExpectedSurfaceOrigin = Get-RequiredConfigString -Config $aiAppConfig -Name 'surfaceOrigin'
if ($ExpectedSurfaceOrigin -ne $TailIouOrigin) {
  throw "Environment config aiApp.surfaceOrigin must equal the configured Tailscale IOU origin"
}

$modelConfig = Get-RequiredConfigMap -Config $EnvironmentConfig -Name 'model'
$ModelId = Get-RequiredConfigString -Config $modelConfig -Name 'id'
if ($ModelId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$') {
  throw "Environment config key 'model.id' must contain two safe URL path segments"
}
$ModelRevision = Get-RequiredConfigString -Config $modelConfig -Name 'revision'
if ($ModelRevision -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
  throw "Environment config key 'model.revision' must be one safe URL path segment"
}
$ModelPrefix = "/hf-model/$ModelId/resolve/$ModelRevision"
$OrtPrefix = Get-RequiredConfigString -Config $modelConfig -Name 'ortAssetPrefix'
if ($OrtPrefix -notmatch '^/[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*$') {
  throw "Environment config key 'model.ortAssetPrefix' must be an absolute safe URL path"
}
$OrtLoaderFile = Get-RequiredConfigString -Config $modelConfig -Name 'ortLoaderFile'
if ($OrtLoaderFile -notmatch '^([A-Za-z0-9][A-Za-z0-9._-]*)\.jspi\.mjs$') {
  throw "Environment config key 'model.ortLoaderFile' must be a plain .jspi.mjs filename"
}
$OrtRuntimeStem = $Matches[1]
$OrtWasmFile = Get-RequiredConfigString -Config $modelConfig -Name 'ortWasmFile'
if ($OrtWasmFile -notmatch '^([A-Za-z0-9][A-Za-z0-9._-]*)\.jspi\.wasm$') {
  throw "Environment config key 'model.ortWasmFile' must be a plain .jspi.wasm filename"
}
if ($Matches[1] -ne $OrtRuntimeStem) {
  throw "Environment config ONNX Runtime loader and WASM must have the same JSPI basename"
}
$OrtLoaderBytes = Get-RequiredConfigInt64 -Config $modelConfig -Name 'ortLoaderBytes'
$OrtWasmBytes = Get-RequiredConfigInt64 -Config $modelConfig -Name 'ortWasmBytes'
$OrtLoaderSha256 = Get-RequiredConfigString -Config $modelConfig -Name 'ortLoaderSha256'
if ($OrtLoaderSha256 -notmatch '^[a-fA-F0-9]{64}$') {
  throw "Environment config key 'model.ortLoaderSha256' must be a 64-character SHA-256"
}
$OrtWasmSha256 = Get-RequiredConfigString -Config $modelConfig -Name 'ortWasmSha256'
if ($OrtWasmSha256 -notmatch '^[a-fA-F0-9]{64}$') {
  throw "Environment config key 'model.ortWasmSha256' must be a 64-character SHA-256"
}
$ModelProcessorBytes = Get-RequiredConfigInt64 `
  -Config $modelConfig -Name 'processorBytes'
$ModelProcessorRuntimeBytes = Get-RequiredConfigInt64 `
  -Config $modelConfig -Name 'processorRuntimeBytes'
$ModelProcessorRuntimeSha256 = Get-RequiredConfigString `
  -Config $modelConfig -Name 'processorRuntimeSha256'
if ($ModelProcessorRuntimeSha256 -notmatch '^[a-fA-F0-9]{64}$') {
  throw "Environment config key 'model.processorRuntimeSha256' must be a 64-character SHA-256"
}
$ModelVisionGraphBytes = Get-RequiredConfigInt64 `
  -Config $modelConfig -Name 'visionGraphBytes'
$ModelDecoderGraphBytes = Get-RequiredConfigInt64 `
  -Config $modelConfig -Name 'decoderGraphBytes'
$ModelDecoderGraphSha256 = Get-RequiredConfigString `
  -Config $modelConfig -Name 'decoderGraphSha256'
if ($ModelDecoderGraphSha256 -notmatch '^[a-fA-F0-9]{64}$') {
  throw "Environment config key 'model.decoderGraphSha256' must be a 64-character SHA-256"
}
$ModelWorkerRequiredMarkers = @(
  Get-RequiredConfigStringArray -Config $modelConfig -Name 'workerRequiredMarkers'
)

$imageProbeConfig = Get-RequiredConfigMap -Config $EnvironmentConfig -Name 'imageProbe'
$ImageProbePath = Get-RequiredConfigString -Config $imageProbeConfig -Name 'path'
if ($ImageProbePath -notmatch '^/__oc-local-image/[a-z0-9-]+/blobs/[0-9]+$') {
  throw (
    "Environment config key 'imageProbe.path' must match " +
    "'/__oc-local-image/<canister-id>/blobs/<blob-id>'"
  )
}
$ImageProbeBytes = Get-RequiredConfigInt64 -Config $imageProbeConfig -Name 'bytes'
$ImageProbeContentType = Get-RequiredConfigString `
  -Config $imageProbeConfig -Name 'contentType'
if ($ImageProbeContentType -notmatch '^image/[a-z0-9.+-]+$') {
  throw "Environment config key 'imageProbe.contentType' must be an image MIME type"
}

Assert-File -Path $RecoveredManager -Description 'strict recovered PocketIC manager'
if (-not (Test-Path -LiteralPath $OpenChatRepo -PathType Container)) {
  throw "OpenChat all-WebGPU checkout is missing: $OpenChatRepo"
}

Write-Step "action=$Action"
if ($Action -eq 'ValidateConfig') {
  $managerValidation = & $RecoveredManager validate-config `
    -EnvironmentConfigPath $EnvironmentConfigPath -TimeoutSeconds $TimeoutSeconds
  if ($null -eq $managerValidation -or $managerValidation.Valid -ne $true) {
    throw 'PocketIC manager did not accept the environment config'
  }
  [pscustomobject]@{ Valid = $true }
  return
}
try {
  if ($Action -eq 'Start') {
    Write-Step 'starting/reusing the strict recovered OpenChat PocketIC state'
    & $RecoveredManager start -EnvironmentConfigPath $EnvironmentConfigPath `
      -TimeoutSeconds $TimeoutSeconds | Out-Host
  } else {
    $status = & $RecoveredManager status -EnvironmentConfigPath $EnvironmentConfigPath `
      -TimeoutSeconds $TimeoutSeconds
    $healthy = @($status | Where-Object { $_.PSObject.Properties.Name -contains 'Healthy' })
    if ($healthy.Count -ne 1 -or $healthy[0].Healthy -ne $true) {
      throw 'strict recovered PocketIC state is not running and healthy'
    }
    $status | Out-Host
  }
} catch {
  throw (
    "Strict recovered PocketIC readiness failed. Generic startup did not clean, deploy, or repair " +
    "state. Review the error, then use the explicit 'repair' action of $RecoveredManager only if " +
    "crash-incomplete recovery is intended. Cause: $($_.Exception.Message)"
  )
}

Assert-ReplicaReady

$openChatViteConfig = Join-Path $OpenChatRepo 'frontend\app\vite.config.ts'
$iouViteConfig = Join-Path $RepoRoot 'vite.config.ts'
$openChatStale = Test-ViteConfigStale -Port 5003 -ConfigPath $openChatViteConfig
$iouStale = Test-ViteConfigStale -Port 3000 -ConfigPath $iouViteConfig
if ($Action -eq 'Status' -and ($openChatStale -or $iouStale)) {
  throw "A Vite config is newer than its listener (OpenChat=$openChatStale, IOU=$iouStale); run Start -RestartFrontends"
}
if ($Action -eq 'Start' -and ($RestartFrontends -or $openChatStale)) {
  Stop-ExactViteListener -Port 5003
}
if ($Action -eq 'Start' -and ($RestartFrontends -or $iouStale)) {
  Stop-ExactViteListener -Port 3000
}

if (-not (Test-Http "$OpenChatOrigin/transformers_webgpu_worker.js")) {
  if ($Action -eq 'Status') { throw 'OpenChat all-WebGPU Vite server is not healthy on port 5003' }
  Start-OpenChatVite
  Wait-Http -Uri "$OpenChatOrigin/transformers_webgpu_worker.js" `
    -Description 'OpenChat all-WebGPU Vite server' | Out-Null
}
Assert-OpenChatReady -Origin $OpenChatOrigin
Write-Step 'OpenChat Vite + background worker + all-WebGPU model + original-image routes are healthy'

if (-not (Test-Http "$IouOrigin/")) {
  if ($Action -eq 'Status') { throw 'IOU Vite server is not healthy on port 3000' }
  Start-IouVite
  Wait-Http -Uri "$IouOrigin/" -Description 'IOU Vite server' | Out-Null
}
Assert-IouReady -Origin $IouOrigin
Write-Step 'IOU Vite + replica proxy are healthy'

Ensure-TailscaleRoutes

Write-Host ''
Write-Host 'Environment READY'
Write-Host "  OpenChat: $TailOpenChatOrigin"
Write-Host "  IOU:      $TailIouOrigin"
Write-Host "  Model $ModelId`: embed_tokens=webgpu, vision_encoder=webgpu, decoder_model_merged=webgpu"
Write-Host '  Registration: published IOU app verified read-only; no registration/revision was changed'
