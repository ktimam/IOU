<#
.SYNOPSIS
Starts or verifies the complete preserved OpenChat + IOU phone-development environment.

.DESCRIPTION
This is the one normal entry point after a reboot. It is deliberately fail-closed:

* the authoritative recovered PocketIC manager must validate the exact three-subnet topology and
  deployed canisters;
* an anonymous UserIndex `ai_apps` query must find the exact published IOU registration, response
  schema, and backend verification binding;
* both Windows Vite servers, OpenChat's ordinary/background workers, the all-WebGPU runtime assets,
  the configured pinned processor/graph routes, and one immutable restored image must answer with
  their expected shape, then an ephemeral browser must complete worker init and anonymous auth;
* the two phone-facing Tailscale HTTPS origins must reach the matching local service.

This proves service and app-level readiness only. An anonymous startup check cannot prove that a
signed-in account's per-user IOU link is pinned to the current manifest revision, so the final status
states that account-link readiness is unchecked rather than claiming end-to-end proposal readiness.

Generic startup never cleans, deploys, registers, publishes, upgrades, or repairs state. If strict
PocketIC reopen reports incomplete state, use the separate, explicit `repair` action documented by
`pocketic-recovered.ps1` only after reviewing its timestamped backup plan.

.EXAMPLE
pwsh -File scripts/live/start-environment.ps1 -EnvironmentConfigPath scripts/live/start-environment.local.json
pwsh -File scripts/live/start-environment.ps1 -Action Status -EnvironmentConfigPath scripts/live/start-environment.local.json
pwsh -File scripts/live/start-environment.ps1 -Action FrontendRestart -EnvironmentConfigPath scripts/live/start-environment.local.json
pwsh -File scripts/live/start-environment.ps1 -Action OpenChatFrontendRestart -EnvironmentConfigPath scripts/live/start-environment.local.json
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('Start', 'Status', 'ValidateConfig', 'FrontendRestart', 'OpenChatFrontendRestart')]
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
$OpenChatBrowserChecker = Join-Path $PSScriptRoot 'check-openchat-browser-readiness.ts'
$OpenChatRegistration = Join-Path $RepoRoot 'docs\openchat-registration.json'
$IouEnvFile = Join-Path $RepoRoot '.env.local'
$OpenChatEnvironmentFingerprintPath = Join-Path $RepoRoot '.codex-openchat-vite.environment.sha256'
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

function Get-OptionalConfigMap(
  [Collections.IDictionary]$Config,
  [string]$Name
) {
  if (-not $Config.Contains($Name)) { return $null }
  if ($Config[$Name] -isnot [Collections.IDictionary]) {
    throw "Environment config key '$Name' must be a JSON object"
  }
  $Config[$Name]
}

function Get-RequiredConfigBoolean(
  [Collections.IDictionary]$Config,
  [string]$Name
) {
  if (-not $Config.Contains($Name) -or $Config[$Name] -isnot [bool]) {
    throw "Environment config key '$Name' must be a JSON boolean"
  }
  [bool]$Config[$Name]
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

function Get-RequiredOpenChatCanisterEnvironment([string]$CanisterIdsPath) {
  Assert-File -Path $CanisterIdsPath -Description 'local OpenChat canister IDs file'
  try {
    $canisterIds = Read-EnvironmentConfigFile -Path $CanisterIdsPath
  } catch {
    throw "Could not load local OpenChat canister IDs from $CanisterIdsPath`: $($_.Exception.Message)"
  }
  if ($canisterIds -isnot [Collections.IDictionary]) {
    throw "Local OpenChat canister IDs file must contain one JSON object: $CanisterIdsPath"
  }

  # These are the local canister-backed fields passed by both App.svelte roots into OpenChat.
  # Keep only stable canister aliases here; every deployment-specific principal comes from the
  # configured canister_ids.json source and is validated before either frontend can start.
  $required = [ordered]@{
    OC_STORAGE_INDEX_CANISTER = 'storage_index'
    OC_GROUP_INDEX_CANISTER = 'group_index'
    OC_NOTIFICATIONS_CANISTER = 'notifications_index'
    OC_IDENTITY_CANISTER = 'identity'
    OC_ONLINE_CANISTER = 'online_users'
    OC_USER_INDEX_CANISTER = 'user_index'
    OC_TRANSLATIONS_CANISTER = 'translations'
    OC_REGISTRY_CANISTER = 'registry'
    OC_PROPOSALS_BOT_CANISTER = 'proposals_bot'
    OC_MARKET_MAKER_CANISTER = 'market_maker'
    OC_SIGN_IN_WITH_EMAIL_CANISTER = 'sign_in_with_email'
    OC_SIGN_IN_WITH_ETHEREUM_CANISTER = 'sign_in_with_ethereum'
    OC_SIGN_IN_WITH_SOLANA_CANISTER = 'sign_in_with_solana'
  }
  $environment = [ordered]@{}
  foreach ($entry in $required.GetEnumerator()) {
    $canister = Get-RequiredConfigMap -Config $canisterIds -Name $entry.Value
    $canisterId = Get-RequiredConfigString -Config $canister -Name 'local'
    if ($canisterId -notmatch '^[a-z0-9-]+$') {
      throw (
        "Local OpenChat canister '$($entry.Value).local' is not a valid canister id in " +
        $CanisterIdsPath
      )
    }
    $environment[$entry.Key] = $canisterId
  }
  return ,$environment
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

function Get-OpenChatEnvironmentFingerprint {
  $material = @(
    (Get-FileHash -LiteralPath $EnvironmentConfigPath -Algorithm SHA256).Hash
    (Get-FileHash -LiteralPath $OpenChatCanisterIdsPath -Algorithm SHA256).Hash
    (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
  ) -join "`n"
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    ([BitConverter]::ToString(
        $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($material))
      )).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Test-OpenChatEnvironmentStale {
  if (-not (Test-Path -LiteralPath $OpenChatEnvironmentFingerprintPath -PathType Leaf)) {
    return $true
  }
  try {
    $stored = Get-Content -LiteralPath $OpenChatEnvironmentFingerprintPath -Raw |
      ConvertFrom-Json -AsHashtable
    $listenerPid = Get-LoopbackListenerPid -Port 5003
    if ($null -eq $listenerPid -or [int]$stored['processId'] -ne $listenerPid) { return $true }
    $process = Get-Process -Id $listenerPid -ErrorAction Stop
    $storedStartTime = $stored['startTimeUtc']
    if ($null -eq $storedStartTime) { return $true }
    # PowerShell 7.5+ deserializes an ISO-8601 JSON value into DateTime. Comparing its default
    # locale-formatted interpolation with ToString('O') makes every healthy restarted listener look
    # stale. Normalize both values to UTC ticks so string and DateTime deserializers behave equally.
    $storedStartTimeUtc = if ($storedStartTime -is [DateTime]) {
      $storedStartTime.ToUniversalTime()
    } else {
      [DateTime]::Parse(
        "$storedStartTime",
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind
      ).ToUniversalTime()
    }
    "$($stored['fingerprint'])" -cne $OpenChatEnvironmentFingerprint -or
      $storedStartTimeUtc.Ticks -ne $process.StartTime.ToUniversalTime().Ticks
  } catch {
    $true
  }
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

function Wait-OpenChatApplicationModules([string]$Origin) {
  # A Vite root document can answer before its Svelte transform pipeline is usable. Warm the
  # browser client, the real entry point, and the phone root explicitly; a transient transform 502
  # is retried inside the normal environment timeout instead of being followed by a false READY.
  $probes = @(
    [pscustomobject]@{
      Path = '/@vite/client'
      Description = 'Vite browser client'
      MinimumBytes = 10000L
      Contains = @('createHotContext', 'WebSocket')
    },
    [pscustomobject]@{
      Path = '/src/main.ts'
      Description = 'OpenChat application entry module'
      MinimumBytes = 1000L
      Contains = @('components_mobile/App.svelte', 'ensureWebModelRestored')
    },
    [pscustomobject]@{
      Path = '/src/components_mobile/App.svelte'
      Description = 'OpenChat mobile Svelte root module'
      MinimumBytes = 5000L
      Contains = @('components_mobile/Router.svelte')
    }
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  foreach ($probe in $probes) {
    $uri = "$Origin$($probe.Path)"
    $lastError = $null
    do {
      try {
        Assert-HttpShape -Uri $uri -Description $probe.Description `
          -MinimumBytes $probe.MinimumBytes -ExpectedContentType 'text/javascript' `
          -Contains $probe.Contains | Out-Null
        $lastError = $null
        break
      } catch {
        $lastError = $_.Exception.Message
      }
      Start-Sleep -Milliseconds 750
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($null -ne $lastError) {
      throw "$($probe.Description) did not become ready at $uri within $TimeoutSeconds seconds: $lastError"
    }
  }
}

function Assert-OpenChatPublicKeyRoute([string]$Origin) {
  $response = Assert-HttpShape -Uri "$Origin/public-key" `
    -Description "OpenChat public key at $Origin" -MinimumBytes 100
  $content = if ($response.Content -is [byte[]]) {
    [Text.Encoding]::UTF8.GetString($response.Content)
  } else {
    "$($response.Content)"
  }
  $content = $content.Replace("`r`n", "`n")
  if ($content.Length -gt 4096 -or
      $content -notmatch '(?s)^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n?$') {
    throw "OpenChat public key at $Origin is not a valid non-empty PEM public key"
  }
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

function Test-ExactViteProcess(
  [object]$Process,
  [string]$ViteScript,
  [int]$Port
) {
  if ($null -eq $Process -or $Process.Name -ine 'node.exe' -or
      [string]::IsNullOrWhiteSpace("$($Process.CommandLine)")) {
    return $false
  }
  $nodePattern = [regex]::Escape([IO.Path]::GetFullPath($Node))
  $vitePattern = [regex]::Escape([IO.Path]::GetFullPath($ViteScript))
  $commandPattern = (
    '^\s*(?:"{0}"|{0})\s+(?:"{1}"|{1})\s+' +
    '--host\s+127\.0\.0\.1\s+--port\s+{2}\s+--strictPort\s*$'
  ) -f $nodePattern, $vitePattern, $Port
  [regex]::IsMatch(
    "$($Process.CommandLine)",
    $commandPattern,
    [Text.RegularExpressions.RegexOptions]::IgnoreCase -bor
      [Text.RegularExpressions.RegexOptions]::CultureInvariant
  )
}

function Get-ExactViteProcesses([string]$ViteScript, [int]$Port) {
  try {
    $nodeProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'")
  } catch {
    throw "Cannot inspect Node processes for exact Vite port $Port cleanup; rerun from an elevated PowerShell"
  }
  foreach ($process in $nodeProcesses) {
    if (Test-ExactViteProcess -Process $process -ViteScript $ViteScript -Port $Port) {
      $process
    }
  }
}

function Get-ExactViteListener([int]$Port, [string]$ViteScript) {
  $pidValue = Get-LoopbackListenerPid -Port $Port
  if ($null -eq $pidValue) { return $null }
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue"
  } catch {
    throw "Cannot inspect port $Port owner PID $pidValue; rerun from an elevated PowerShell"
  }
  if (-not (Test-ExactViteProcess -Process $process -ViteScript $ViteScript -Port $Port)) {
    $command = if ($null -eq $process) { '<missing>' } else { $process.CommandLine }
    throw "Port $Port is not owned by the exact expected loopback Vite process (PID $pidValue): $command"
  }
  $started = (Get-Process -Id $pidValue -ErrorAction Stop).StartTime
  [pscustomobject]@{ Pid = $pidValue; Started = $started; CommandLine = $process.CommandLine }
}

function Test-ViteConfigStale([int]$Port, [string]$ConfigPath, [string]$ViteScript) {
  if (-not (Test-LoopbackPort -Port $Port)) { return $false }
  $listener = Get-ExactViteListener -Port $Port -ViteScript $ViteScript
  Assert-File -Path $ConfigPath -Description 'Vite configuration'
  (Get-Item -LiteralPath $ConfigPath).LastWriteTime -gt $listener.Started
}

function Stop-ExactViteProcesses([string]$ViteScript, [int]$Port) {
  if (Test-LoopbackPort -Port $Port) {
    $listener = Get-ExactViteListener -Port $Port -ViteScript $ViteScript
    if ($null -eq $listener) {
      throw "Port $Port is occupied without the exact expected loopback Vite listener; refusing cleanup"
    }
  }

  $processes = @(Get-ExactViteProcesses -ViteScript $ViteScript -Port $Port)
  if ($processes.Count -eq 0) { return }
  $processIds = @($processes | ForEach-Object { [int]$_.ProcessId })
  Write-Step "stopping $($processIds.Count) exact Vite process(es) on port $Port`: $($processIds -join ', ')"
  foreach ($processId in $processIds) {
    try {
      # Stop-Process intermittently throws an internal NullReferenceException on this Windows
      # host. Re-read the PID immediately before Process.Kill so PID reuse can never widen cleanup.
      $current = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
      if ($null -eq $current) { continue }
      if (-not (Test-ExactViteProcess -Process $current -ViteScript $ViteScript -Port $Port)) {
        throw "PID $processId no longer has the exact expected Vite command line"
      }
      $target = [Diagnostics.Process]::GetProcessById($processId)
      $target.Kill()
    } catch {
      $remaining = @(Get-ExactViteProcesses -ViteScript $ViteScript -Port $Port |
        Where-Object { $_.ProcessId -eq $processId })
      if ($remaining.Count -gt 0) {
        throw "Failed to stop exact Vite PID $processId on port $Port`: $($_.Exception.Message)"
      }
    }
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $remaining = @(Get-ExactViteProcesses -ViteScript $ViteScript -Port $Port)
    if ($remaining.Count -eq 0) {
      if (Test-LoopbackPort -Port $Port) {
        throw "Port $Port remained occupied after exact Vite cleanup; refusing to stop its new owner"
      }
      return
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  $remainingPids = @($remaining | ForEach-Object { $_.ProcessId })
  throw "Exact Vite process(es) did not exit on port $Port`: $($remainingPids -join ', ')"
}

function Start-NodeDevServer(
  [string]$WorkingDirectory,
  [string]$ViteScript,
  [int]$Port,
  [string]$StdoutLog,
  [string]$StderrLog
) {
  Assert-File -Path $ViteScript -Description 'Vite entry point'
  # A prior Vite can close its HTTP server while file watchers keep Node alive. Remove every
  # process with this exact singleton launch command before starting; unknown Node processes and
  # unknown port owners are rejected above and are never terminated.
  Stop-ExactViteProcesses -ViteScript $ViteScript -Port $Port
  if (Test-LoopbackPort -Port $Port) {
    throw "Port $Port is occupied but its expected service is unhealthy; refusing to replace an unknown process"
  }
  Write-Step "starting Vite on 127.0.0.1:$Port"
  $process = Start-Process -FilePath $Node `
    -ArgumentList @($ViteScript, '--host', '127.0.0.1', '--port', "$Port", '--strictPort') `
    -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog
  if ($null -eq $process) { throw "Failed to start Vite on port $Port" }
  $process
}

function Start-OpenChatVite {
  $appDir = Join-Path $OpenChatRepo 'frontend\app'
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
    OC_WSL_DISTRO = $PocketIcDistro
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
    OC_LOCAL_AI_APP_CARDS_ENABLED = 'true'
    OC_LOCAL_AI_APP_CONTENT_ATTESTATION_ENABLED = 'true'
    OC_LOCAL_AI_APP_FINAL_CONFIRMATION_ENABLED = 'true'
    OC_LOCAL_AI_APP_PRIVATE_CONTEXT_ENABLED = 'true'
    OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE = 'true'
  }
  foreach ($entry in $OpenChatCanisterEnvironment.GetEnumerator()) {
    $settings[$entry.Key] = $entry.Value
  }
  if ($null -ne $AndroidLinkPackage) {
    $settings['OC_ANDROID_LINK_PACKAGE'] = $AndroidLinkPackage
    $settings['OC_ANDROID_LINK_CERT_SHA256'] = $AndroidLinkCertSha256
    $settings['OC_ANDROID_RP_ID'] = $TailnetHost
  }
  $saved = @{}
  foreach ($name in $settings.Keys) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $settings[$name], 'Process')
  }
  try {
    $process = Start-NodeDevServer -WorkingDirectory $appDir `
      -ViteScript $OpenChatViteScript -Port 5003 `
      -StdoutLog (Join-Path $RepoRoot '.codex-openchat-vite.stdout.log') `
      -StderrLog (Join-Path $RepoRoot '.codex-openchat-vite.stderr.log')
    [ordered]@{
      fingerprint = $OpenChatEnvironmentFingerprint
      processId = $process.Id
      startTimeUtc = $process.StartTime.ToUniversalTime().ToString('O')
    } | ConvertTo-Json -Compress | Set-Content `
      -LiteralPath $OpenChatEnvironmentFingerprintPath -NoNewline
  } finally {
    foreach ($name in $settings.Keys) {
      [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
    }
  }
}

function Start-IouVite {
  $null = Start-NodeDevServer -WorkingDirectory $RepoRoot -ViteScript $IouViteScript -Port 3000 `
    -StdoutLog (Join-Path $RepoRoot '.codex-iou-vite.stdout.log') `
    -StderrLog (Join-Path $RepoRoot '.codex-iou-vite.stderr.log')
}

function Assert-PublishedIouApp {
  Assert-File -Path $AiAppChecker -Description 'AI app readiness checker'
  Assert-File -Path $OpenChatRegistration -Description 'OpenChat registration contract'
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
    '--expected-surface-origin', $ExpectedSurfaceOrigin,
    '--expected-response-schema-file', $OpenChatRegistration,
    '--verify-app-binding', 'true'
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
  if ($result.app.responseSchemaVerified -ne $true -or $result.app.appBindingVerified -ne $true) {
    throw 'AI app readiness checker did not verify the response schema and backend binding'
  }
  if ($result.endToEndReady -ne $false -or $result.accountConnection.checked -ne $false) {
    throw 'Anonymous readiness checker did not explicitly report the account connection as unchecked'
  }
  Write-Step "published IOU app #$($result.app.id) revision $($result.app.revision) has exact schema + binding (signed-in account link not checked)"
}

function Assert-ReplicaReady([bool]$RequirePublishedIouApp = $true) {
  Assert-HttpShape -Uri "$ReplicaOrigin/api/v2/status" -Description 'PocketIC status' `
    -MinimumBytes 1 | Out-Null
  # This is the decisive gate. A fresh/empty PocketIC also returns status=200 but fails the exact
  # UserIndex/app query; generic startup must never accept that false positive again.
  if ($RequirePublishedIouApp) { Assert-PublishedIouApp }
}

function Assert-OpenChatReady([string]$Origin) {
  Assert-HttpShape -Uri "$Origin/" -Description "OpenChat frontend at $Origin" `
    -MinimumBytes 1000 | Out-Null
  Assert-OpenChatPublicKeyRoute -Origin $Origin
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

function Assert-OpenChatBrowserReady([string]$Origin) {
  Assert-File -Path $OpenChatBrowserChecker -Description 'OpenChat browser readiness checker'
  Assert-File -Path $Tsx -Description 'tsx command (run pnpm install if dependencies are absent)'
  $probeTimeoutMs = [Math]::Max(30000, [Math]::Min(120000, $TimeoutSeconds * 1000))
  $arguments = @(
    $OpenChatBrowserChecker,
    '--origin', $Origin,
    '--browser-channel', $BrowserProbeChannel,
    '--timeout-ms', "$probeTimeoutMs",
    '--expected-identity-canister', $ExpectedIdentityCanister
  )
  $output = @(& $Tsx @arguments 2>&1)
  $line = ($output | ForEach-Object { "$_" }) -join ''
  try {
    $result = $line | ConvertFrom-Json
  } catch {
    throw "OpenChat browser readiness checker returned invalid JSON for $Origin`: $line"
  }
  if ($LASTEXITCODE -ne 0 -or $result.ready -ne $true) {
    $cause = if ($result.PSObject.Properties.Name -contains 'error') {
      $result.error
    } else {
      $line
    }
    throw (
      "OpenChat app/background-worker readiness failed at $Origin. Configure browserProbe.channel " +
      "as an installed Playwright channel (chrome or msedge), or use chromium after running " +
      "'pnpm exec playwright install chromium'. No persistent profile was opened. Cause: $cause"
    )
  }
  if ($result.backgroundWorker.initResolved -ne $true -or
      $result.backgroundWorker.authResolved -ne $true) {
    throw "OpenChat browser checker did not prove init + anonymous auth worker responses at $Origin"
  }
  Write-Step "OpenChat app + background worker completed init/auth in an ephemeral $BrowserProbeChannel browser at $Origin"
}

function Confirm-ConfiguredAndroidDevice {
  if ($null -eq $AndroidDeviceConfig) {
    return [pscustomobject]@{ Configured = $false; Ready = $false; Required = $false }
  }

  $issue = $null
  $output = @()
  if (-not (Test-Path -LiteralPath $AdbExecutable -PathType Leaf)) {
    $issue = "configured ADB executable is missing: $AdbExecutable"
  } else {
    try {
      $output = @(& $AdbExecutable -s $AndroidDeviceSerial get-state 2>&1)
      if ($LASTEXITCODE -ne 0 -or
          (@($output | ForEach-Object { ("$($_)").Trim() }) -notcontains 'device')) {
        $issue = "ADB did not report state=device: $($output -join ' ')"
      }
    } catch {
      $issue = $_.Exception.Message
    }
  }

  if ($null -eq $issue) {
    Write-Step "configured Android device is connected through ADB"
    return [pscustomobject]@{ Configured = $true; Ready = $true; Required = $AndroidDeviceRequired }
  }

  $guidance = (
    "Configured Android device is not ready through ADB ($issue). Connect USB, unlock the phone, " +
    "enable USB debugging, and accept the RSA authorization prompt. Then run: " +
    "& '$AdbExecutable' kill-server; & '$AdbExecutable' start-server; " +
    "& '$AdbExecutable' devices -l; & '$AdbExecutable' -s '$AndroidDeviceSerial' get-state. " +
    "If it says unauthorized, revoke USB debugging authorizations on the phone and reconnect. " +
    "This environment command will not open a switch-selection or device-selection window."
  )
  if ($AndroidDeviceRequired) { throw $guidance }
  Write-Warning $guidance
  [pscustomobject]@{ Configured = $true; Ready = $false; Required = $false }
}

function Assert-IouReady([string]$Origin) {
  Assert-HttpShape -Uri "$Origin/" -Description "IOU frontend at $Origin" -MinimumBytes 500 | Out-Null
  Assert-HttpShape -Uri "$Origin/api/v2/status" -Description 'IOU replica proxy' `
    -MinimumBytes 1 | Out-Null
}

function Assert-AndroidAssetLinks([string]$Origin) {
  if ($null -eq $AndroidLinkPackage) { return }
  $uri = "$Origin/.well-known/assetlinks.json"
  $response = Assert-HttpShape -Uri $uri -Description 'Android app-link association' `
    -MinimumBytes 100 -ExpectedContentType 'application/json'
  $finalUri = "$($response.BaseResponse.RequestMessage.RequestUri.AbsoluteUri)"
  if ($finalUri -cne $uri) {
    throw "Android app-link association must be served directly at $uri (resolved to $finalUri)"
  }
  try {
    $statements = @($response.Content | ConvertFrom-Json -AsHashtable)
  } catch {
    throw "Android app-link association at $uri is not valid JSON: $($_.Exception.Message)"
  }
  if ($statements.Count -ne 1) {
    throw "Android app-link association at $uri must contain exactly one statement"
  }
  $relations = @($statements[0]['relation'])
  if ($relations -notcontains 'delegate_permission/common.get_login_creds') {
    throw "Android app-link association at $uri does not authorize passkey credentials"
  }
  $target = $statements[0]['target']
  if ($target -isnot [Collections.IDictionary] -or
      "$($target['namespace'])" -ne 'android_app' -or
      "$($target['package_name'])" -ne $AndroidLinkPackage) {
    throw "Android app-link association at $uri does not match package $AndroidLinkPackage"
  }
  $fingerprints = @($target['sha256_cert_fingerprints'])
  if ($fingerprints.Count -ne 1 -or "$($fingerprints[0])" -ne $AndroidLinkCertSha256) {
    throw "Android app-link association at $uri does not match the configured signing certificate"
  }
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
$PocketIcDistro = Get-RequiredConfigString -Config $pocketIcConfig -Name 'distro'
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

$BrowserProbeChannel = 'chrome'
$browserProbeConfig = Get-OptionalConfigMap -Config $EnvironmentConfig -Name 'browserProbe'
if ($null -ne $browserProbeConfig) {
  $BrowserProbeChannel = Get-RequiredConfigString -Config $browserProbeConfig -Name 'channel'
}
if ($BrowserProbeChannel -notmatch '^(chrome|msedge|chromium)$') {
  throw "Environment config key 'browserProbe.channel' must be chrome, msedge, or chromium"
}

$AndroidDeviceConfig = Get-OptionalConfigMap -Config $EnvironmentConfig -Name 'androidDevice'
$AdbExecutable = $null
$AndroidDeviceSerial = $null
$AndroidDeviceRequired = $false
if ($null -ne $AndroidDeviceConfig) {
  $AdbExecutable = Resolve-ConfiguredPath `
    -Path (Get-RequiredConfigString -Config $AndroidDeviceConfig -Name 'adbExecutable') `
    -BaseDirectory $configDirectory
  $AndroidDeviceSerial = Get-RequiredConfigString -Config $AndroidDeviceConfig -Name 'serial'
  if ($AndroidDeviceSerial -notmatch '^[A-Za-z0-9._:-]+$') {
    throw "Environment config key 'androidDevice.serial' contains unsafe characters"
  }
  $AndroidDeviceRequired = Get-RequiredConfigBoolean `
    -Config $AndroidDeviceConfig -Name 'requiredForReady'
}

$openChatConfig = Get-RequiredConfigMap -Config $EnvironmentConfig -Name 'openChat'
$OpenChatCanisterIdsPath = Resolve-ConfiguredPath `
  -Path (Get-RequiredConfigString -Config $openChatConfig -Name 'canisterIdsFile') `
  -BaseDirectory $configDirectory
$OpenChatCanisterEnvironment = Get-RequiredOpenChatCanisterEnvironment `
  -CanisterIdsPath $OpenChatCanisterIdsPath
$OpenChatCanisterEnvironment['OC_ONESEC_FORWARDER_CANISTER'] = Get-RequiredConfigString `
  -Config $openChatConfig -Name 'oneSecForwarderCanisterId'
$OpenChatCanisterEnvironment['OC_ONESEC_MINTER_CANISTER'] = Get-RequiredConfigString `
  -Config $openChatConfig -Name 'oneSecMinterCanisterId'
foreach ($name in @('OC_ONESEC_FORWARDER_CANISTER', 'OC_ONESEC_MINTER_CANISTER')) {
  if ($OpenChatCanisterEnvironment[$name] -notmatch '^[a-z0-9-]+$') {
    throw "Environment config value for $name is not a valid canister id"
  }
}
$ExpectedIdentityCanister = $OpenChatCanisterEnvironment['OC_IDENTITY_CANISTER']
$InternetIdentityCanisterId = Get-RequiredConfigString `
  -Config $openChatConfig -Name 'internetIdentityCanisterId'
if ($InternetIdentityCanisterId -notmatch '^[a-z0-9-]+$') {
  throw "Environment config key 'openChat.internetIdentityCanisterId' is not a valid canister id"
}
$OpenChatVapidPublicKey = Get-RequiredConfigString `
  -Config $openChatConfig -Name 'vapidPublicKey'
$WalletConnectProjectId = Get-RequiredConfigString `
  -Config $openChatConfig -Name 'walletConnectProjectId'
$AndroidLinkPackage = $null
$AndroidLinkCertSha256 = $null
$androidLinkConfig = Get-OptionalConfigMap -Config $openChatConfig -Name 'androidLink'
if ($null -ne $androidLinkConfig) {
  $AndroidLinkPackage = Get-RequiredConfigString -Config $androidLinkConfig -Name 'packageName'
  if ($AndroidLinkPackage -notmatch '^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$') {
    throw "Environment config key 'openChat.androidLink.packageName' is not a valid Android package name"
  }
  $AndroidLinkCertSha256 = Get-RequiredConfigString `
    -Config $androidLinkConfig -Name 'certificateSha256'
  if ($AndroidLinkCertSha256 -notmatch '^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$') {
    throw (
      "Environment config key 'openChat.androidLink.certificateSha256' must be a canonical " +
      'colon-separated SHA-256 certificate fingerprint'
    )
  }
  $AndroidLinkCertSha256 = $AndroidLinkCertSha256.ToUpperInvariant()
  $androidGradlePath = Join-Path $OpenChatRepo 'frontend\src-tauri\gen\android\app\build.gradle.kts'
  Assert-File -Path $androidGradlePath -Description 'OpenChat Android Gradle build'
  $androidGradle = Get-Content -LiteralPath $androidGradlePath -Raw
  $applicationIdMatches = @([regex]::Matches(
      $androidGradle,
      '(?m)^\s*applicationId\s*=\s*"([A-Za-z][A-Za-z0-9_.]*)"\s*$'
    ))
  if ($applicationIdMatches.Count -ne 1) {
    throw "Expected exactly one literal Android applicationId in $androidGradlePath"
  }
  $AndroidApplicationId = $applicationIdMatches[0].Groups[1].Value
  if ($AndroidLinkPackage -cne $AndroidApplicationId) {
    throw (
      "Environment config openChat.androidLink.packageName '$AndroidLinkPackage' does not match " +
      "the APK applicationId '$AndroidApplicationId'"
    )
  }
}

$aiAppConfig = Get-RequiredConfigMap -Config $EnvironmentConfig -Name 'aiApp'
$AiAppName = Get-RequiredConfigString -Config $aiAppConfig -Name 'name'
$AiAppId = Get-RequiredConfigInt64 -Config $aiAppConfig -Name 'id'
$ExpectedUserIndex = Get-RequiredConfigString -Config $aiAppConfig -Name 'userIndexCanisterId'
$ExpectedAppCanister = Get-RequiredConfigString -Config $aiAppConfig -Name 'appCanisterId'
$ExpectedInbox = Get-RequiredConfigString -Config $aiAppConfig -Name 'inboxCanisterId'
$ExpectedSurfaceOrigin = Get-RequiredConfigString -Config $aiAppConfig -Name 'surfaceOrigin'
if ($OpenChatCanisterEnvironment['OC_USER_INDEX_CANISTER'] -ne $ExpectedUserIndex) {
  throw (
    "Environment config aiApp.userIndexCanisterId does not match user_index.local in " +
    $OpenChatCanisterIdsPath
  )
}
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
if ($Action -in @('FrontendRestart', 'OpenChatFrontendRestart')) {
  # This recovery path is intentionally narrower than Start. It is useful when the already-running
  # replica is reachable but the WSL process-manager context is temporarily unavailable. The exact
  # replica/app checks below still run before either frontend is touched.
  Write-Step 'using the existing replica only after its exact app state passes readiness checks'
} else {
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
}

Assert-ReplicaReady -RequirePublishedIouApp ($Action -ne 'OpenChatFrontendRestart')

$openChatViteConfig = Join-Path $OpenChatRepo 'frontend\app\vite.config.ts'
$iouViteConfig = Join-Path $RepoRoot 'vite.config.ts'
$OpenChatViteScript = Join-Path $OpenChatRepo 'frontend\node_modules\vite\bin\vite.js'
$IouViteScript = Join-Path $RepoRoot 'node_modules\vite\bin\vite.js'
$OpenChatEnvironmentFingerprint = Get-OpenChatEnvironmentFingerprint
$openChatStale = (Test-ViteConfigStale -Port 5003 -ConfigPath $openChatViteConfig `
    -ViteScript $OpenChatViteScript) -or (Test-OpenChatEnvironmentStale)
$iouStale = Test-ViteConfigStale -Port 3000 -ConfigPath $iouViteConfig `
  -ViteScript $IouViteScript
if ($Action -eq 'Status' -and ($openChatStale -or $iouStale)) {
  throw "A Vite config is newer than its listener (OpenChat=$openChatStale, IOU=$iouStale); run Start -RestartFrontends"
}
$mayRestartFrontends = $Action -in @('Start', 'FrontendRestart', 'OpenChatFrontendRestart')
$forceOpenChatRestart = $RestartFrontends -or $Action -in @('FrontendRestart', 'OpenChatFrontendRestart')
$forceIouRestart = $RestartFrontends -or $Action -eq 'FrontendRestart'
if ($mayRestartFrontends -and ($forceOpenChatRestart -or $openChatStale)) {
  Stop-ExactViteProcesses -ViteScript $OpenChatViteScript -Port 5003
}
if ($mayRestartFrontends -and ($forceIouRestart -or $iouStale)) {
  Stop-ExactViteProcesses -ViteScript $IouViteScript -Port 3000
}

if (-not (Test-Http "$OpenChatOrigin/transformers_webgpu_worker.js")) {
  if ($Action -eq 'Status') { throw 'OpenChat all-WebGPU Vite server is not healthy on port 5003' }
  Start-OpenChatVite
  Wait-Http -Uri "$OpenChatOrigin/transformers_webgpu_worker.js" `
    -Description 'OpenChat all-WebGPU Vite server' | Out-Null
}
Wait-OpenChatApplicationModules -Origin $OpenChatOrigin
Assert-OpenChatReady -Origin $OpenChatOrigin
Assert-OpenChatBrowserReady -Origin $OpenChatOrigin
Write-Step 'OpenChat application modules + background worker + all-WebGPU model + original-image routes are healthy'

if (-not (Test-Http "$IouOrigin/")) {
  if ($Action -eq 'Status') { throw 'IOU Vite server is not healthy on port 3000' }
  Start-IouVite
  Wait-Http -Uri "$IouOrigin/" -Description 'IOU Vite server' | Out-Null
}
Assert-IouReady -Origin $IouOrigin
Write-Step 'IOU Vite + replica proxy are healthy'

Ensure-TailscaleRoutes
Wait-OpenChatApplicationModules -Origin $TailOpenChatOrigin
Assert-OpenChatBrowserReady -Origin $TailOpenChatOrigin
Assert-AndroidAssetLinks -Origin $TailOpenChatOrigin
Write-Step 'OpenChat application + background worker are healthy through the Tailscale HTTPS route'

$androidStatus = Confirm-ConfiguredAndroidDevice

Write-Host ''
Write-Host 'Environment services READY (account link not verified)'
Write-Host "  OpenChat: $TailOpenChatOrigin"
Write-Host "  IOU:      $TailIouOrigin"
Write-Host "  Model $ModelId`: embed_tokens=webgpu, vision_encoder=webgpu, decoder_model_merged=webgpu"
if ($Action -eq 'OpenChatFrontendRestart') {
  Write-Host '  Registration: NOT CHECKED by the scoped OpenChat-only restart'
} else {
  Write-Host '  Registration: published IOU app verified read-only; no registration/revision was changed'
}
Write-Host '  Account link: NOT VERIFIED; after any manifest revision change, reconnect the signed-in account before end-to-end action QC'
if (-not $androidStatus.Configured) {
  Write-Host '  Android: NOT CHECKED; add androidDevice to the local config to verify one exact ADB serial'
} elseif ($androidStatus.Ready) {
  Write-Host '  Android: configured device connected through ADB'
} else {
  Write-Host '  Android: configured optional device is disconnected; reconnect guidance was printed above'
}
