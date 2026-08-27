<#
.SYNOPSIS
Safely manages the recovered, stateful three-subnet OpenChat PocketIC instance.

.DESCRIPTION
This wrapper is intentionally separate from dfx. It must never be replaced with `dfx start`,
`dfx stop`, or OpenChat's six-subnet local-up scripts: that topology cannot reopen this recovered
state. Start either launches PocketIC from the pinned strict reopen request in the explicit local
environment config or, once, enrolls an
already-running process after fully validating it. Stop checkpoints through stop_progress + DELETE
before sending SIGTERM to the exact recorded Linux PID.

Runtime metadata is written mode 0600 at the WSL path supplied by the environment config. It
contains no credentials.

.EXAMPLE
pwsh -File scripts/live/pocketic-recovered.ps1 status -EnvironmentConfigPath scripts/live/start-environment.local.json
pwsh -File scripts/live/pocketic-recovered.ps1 start -EnvironmentConfigPath scripts/live/start-environment.local.json
pwsh -File scripts/live/pocketic-recovered.ps1 stop -EnvironmentConfigPath scripts/live/start-environment.local.json
pwsh -File scripts/live/pocketic-recovered.ps1 repair -EnvironmentConfigPath scripts/live/start-environment.local.json -ConfirmIncompleteStateRecovery
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet("start", "stop", "status", "repair", "validate-config")]
  [string]$Action = "status",

  [Parameter(Mandatory)]
  [ValidateNotNullOrEmpty()]
  [string]$EnvironmentConfigPath,

  [ValidateRange(10, 600)]
  [int]$TimeoutSeconds = 180,

  [switch]$ConfirmIncompleteStateRecovery
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = 'SilentlyContinue'

# Preserve the caller's path before any later helper can change the process working directory.
. (Join-Path $PSScriptRoot 'environment-config.ps1')
$EnvironmentConfigPath = Resolve-EnvironmentConfigPath -Path $EnvironmentConfigPath

$HelperWindowsPath = Join-Path $PSScriptRoot 'pocketic-recovered-wsl.sh'
$HelperWslPath = $null
$AiAppChecker = Join-Path $PSScriptRoot 'check-openchat-ai-app.ts'
$Tsx = Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))) `
  'node_modules\.bin\tsx.cmd'

function Get-RequiredMap([Collections.IDictionary]$Map, [string]$Name, [string]$Context) {
  if (-not $Map.Contains($Name) -or $Map[$Name] -isnot [Collections.IDictionary]) {
    throw "$Context.$Name must be a JSON object"
  }
  $Map[$Name]
}

function Get-RequiredString([Collections.IDictionary]$Map, [string]$Name, [string]$Context) {
  if (-not $Map.Contains($Name)) {
    throw "$Context.$Name is required"
  }
  $value = "$($Map[$Name])".Trim()
  if ([string]::IsNullOrWhiteSpace($value)) { throw "$Context.$Name must not be empty" }
  $value
}

function Get-RequiredPositiveInt([Collections.IDictionary]$Map, [string]$Name, [string]$Context) {
  $text = Get-RequiredString -Map $Map -Name $Name -Context $Context
  $value = 0
  if (-not [int]::TryParse($text, [ref]$value) -or $value -le 0) {
    throw "$Context.$Name must be a positive integer"
  }
  $value
}

if (-not (Test-Path -LiteralPath $EnvironmentConfigPath -PathType Leaf)) {
  throw "Environment config is missing: $EnvironmentConfigPath"
}
try {
  $EnvironmentConfig = Read-EnvironmentConfigFile -Path $EnvironmentConfigPath
} catch {
  throw "Could not load environment config $EnvironmentConfigPath`: $($_.Exception.Message)"
}
if ($EnvironmentConfig -isnot [Collections.IDictionary]) {
  throw "Environment config must contain one JSON object: $EnvironmentConfigPath"
}
$PocketIcConfig = Get-RequiredMap -Map $EnvironmentConfig -Name 'pocketIc' `
  -Context 'environment'
$AiAppConfig = Get-RequiredMap -Map $EnvironmentConfig -Name 'aiApp' `
  -Context 'environment'

$Distro = Get-RequiredString -Map $PocketIcConfig -Name 'distro' -Context 'pocketIc'
$PocketIcBinary = Get-RequiredString -Map $PocketIcConfig -Name 'binary' -Context 'pocketIc'
$StateDir = Get-RequiredString -Map $PocketIcConfig -Name 'stateDir' -Context 'pocketIc'
$ControlPortFile = Get-RequiredString -Map $PocketIcConfig -Name 'controlPortFile' -Context 'pocketIc'
$MetadataFile = Get-RequiredString -Map $PocketIcConfig -Name 'metadataFile' -Context 'pocketIc'
$LogFile = Get-RequiredString -Map $PocketIcConfig -Name 'logFile' -Context 'pocketIc'
$GatewayPort = Get-RequiredPositiveInt -Map $PocketIcConfig -Name 'gatewayPort' -Context 'pocketIc'
$PocketIcTtlSeconds = Get-RequiredPositiveInt -Map $PocketIcConfig -Name 'ttlSeconds' -Context 'pocketIc'
$PocketIcLogLevels = Get-RequiredString -Map $PocketIcConfig -Name 'logLevels' -Context 'pocketIc'
$ArtificialDelayMs = Get-RequiredPositiveInt -Map $PocketIcConfig -Name 'artificialDelayMs' -Context 'pocketIc'
$DefaultEffectiveCanisterId = Get-RequiredString -Map $PocketIcConfig `
  -Name 'defaultEffectiveCanisterId' -Context 'pocketIc'
$StrictReopenRequest = Get-RequiredMap -Map $PocketIcConfig -Name 'strictReopenRequest' `
  -Context 'pocketIc'
$StrictReopenRequestSha256 = Get-RequiredString -Map $PocketIcConfig `
  -Name 'strictReopenRequestSha256' -Context 'pocketIc'
$RuntimeConfigSha256 = Get-RequiredString -Map $PocketIcConfig `
  -Name 'runtimeConfigSha256' -Context 'pocketIc'
if ($StrictReopenRequestSha256 -notmatch '^[a-f0-9]{64}$' -or
    $RuntimeConfigSha256 -notmatch '^[a-f0-9]{64}$') {
  throw 'PocketIC config SHA-256 values must be 64 lowercase hexadecimal characters'
}
$ExpectedTopology = Get-RequiredMap -Map $PocketIcConfig -Name 'expectedTopology' `
  -Context 'pocketIc'
if (-not $PocketIcConfig.Contains('expectedCanisters') -or
    @($PocketIcConfig['expectedCanisters']).Count -lt 1) {
  throw 'pocketIc.expectedCanisters must be a non-empty JSON array'
}
$ExpectedCanisters = @($PocketIcConfig['expectedCanisters'])
foreach ($canister in $ExpectedCanisters) {
  if ($canister -isnot [Collections.IDictionary]) {
    throw 'Every pocketIc.expectedCanisters entry must be a JSON object'
  }
  foreach ($field in @('role', 'id', 'version', 'commit')) {
    Get-RequiredString -Map $canister -Name $field -Context 'pocketIc.expectedCanisters[]' | Out-Null
  }
}

$ExpectedPublishedApp = @{
  user_index = Get-RequiredString -Map $AiAppConfig -Name 'userIndexCanisterId' -Context 'aiApp'
  name = Get-RequiredString -Map $AiAppConfig -Name 'name' -Context 'aiApp'
  app_id = Get-RequiredPositiveInt -Map $AiAppConfig -Name 'id' -Context 'aiApp'
  app_canister = Get-RequiredString -Map $AiAppConfig -Name 'appCanisterId' -Context 'aiApp'
  inbox = Get-RequiredString -Map $AiAppConfig -Name 'inboxCanisterId' -Context 'aiApp'
  surface_origin = Get-RequiredString -Map $AiAppConfig -Name 'surfaceOrigin' -Context 'aiApp'
}
$ExpectedCommandLine =
  "$PocketIcBinary --port-file $ControlPortFile --ttl $PocketIcTtlSeconds --log-levels $PocketIcLogLevels"

function Invoke-Wsl {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [switch]$AllowFailure
  )

  $output = @(& wsl.exe -d $Distro -- @Arguments 2>&1)
  $exitCode = $LASTEXITCODE
  if (-not $AllowFailure -and $exitCode -ne 0) {
    $detail = ($output | ForEach-Object { "$_" }) -join [Environment]::NewLine
    throw "WSL command failed with exit code $exitCode`: $detail"
  }
  [pscustomobject]@{ ExitCode = $exitCode; Output = $output }
}

function Test-WslPath {
  param([Parameter(Mandatory = $true)][string]$Path, [string]$Mode = "-e")
  (Invoke-Wsl -Arguments @("test", $Mode, $Path) -AllowFailure).ExitCode -eq 0
}

function Get-WslText {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  ((Invoke-Wsl -Arguments $Arguments).Output | ForEach-Object { "$_" }) -join "`n"
}

function Get-WslHelperPath {
  if ($null -ne $script:HelperWslPath) { return $script:HelperWslPath }
  if (-not (Test-Path -LiteralPath $HelperWindowsPath -PathType Leaf)) {
    throw ('PocketIC WSL helper is missing: {0}' -f $HelperWindowsPath)
  }
  $fullPath = [IO.Path]::GetFullPath($HelperWindowsPath)
  $pathMatch = [regex]::Match($fullPath, '^([A-Za-z]):\\(.*)$')
  if (-not $pathMatch.Success) {
    throw 'The PocketIC WSL helper must be on a Windows drive mounted under /mnt'
  }
  $converted = '/mnt/{0}/{1}' -f $pathMatch.Groups[1].Value.ToLowerInvariant(),
    $pathMatch.Groups[2].Value.Replace('\', '/')
  if ($converted -match '\s' -or -not (Test-WslPath -Path $converted -Mode '-f')) {
    throw 'Could not resolve the checked-in PocketIC WSL helper'
  }
  $script:HelperWslPath = $converted
  $converted
}

function Invoke-WslHelper {
  param([Parameter(Mandatory = $true)][string[]]$Arguments, [switch]$AllowFailure)
  $helper = Get-WslHelperPath
  Invoke-Wsl -Arguments (@('bash', $helper) + $Arguments) -AllowFailure:$AllowFailure
}

function Get-Config {
  $raw = $StrictReopenRequest | ConvertTo-Json -Depth 30 -Compress
  try {
    $config = $raw | ConvertFrom-Json
  } catch {
    throw "Configured strict reopen request is not valid JSON: $($_.Exception.Message)"
  }

  if (-not ($config.PSObject.Properties.Name -contains "incomplete_state") -or
      $null -ne $config.incomplete_state) {
    throw "Refusing non-strict reopen: incomplete_state must be present and null"
  }
  if ($config.state_dir -ne $StateDir) {
    throw "Unexpected state_dir in strict reopen request: $($config.state_dir)"
  }
  if ($config.http_gateway_config.ip_addr -ne "127.0.0.1" -or
      [int]$config.http_gateway_config.port -ne $GatewayPort) {
    throw "The recovered gateway must bind only to 127.0.0.1:$GatewayPort"
  }

  $subnets = $config.subnet_config_set
  if ($null -ne $subnets.sns -or $null -ne $subnets.fiduciary -or
      $null -ne $subnets.bitcoin -or @($subnets.application).Count -ne 0 -or
      @($subnets.verified_application).Count -ne 0 -or @($subnets.system).Count -ne 1 -or
      $subnets.nns.state_config -ne "New" -or $subnets.ii.state_config -ne "New" -or
      $subnets.system[0].state_config -ne "New") {
    throw "Refusing to reopen with anything except the tested NNS + II + one System topology"
  }
  if ([int]$config.initial_time.AutoProgress.artificial_delay_ms -ne $ArtificialDelayMs) {
    throw "Unexpected auto-progress configuration"
  }

  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $hashBytes = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($raw))
    $hash = ([BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
  if ($hash -ne $StrictReopenRequestSha256) {
    throw 'Configured strict reopen request does not match its pinned SHA-256 fingerprint'
  }

  [pscustomobject]@{
    Raw = $raw
    # Keep the runtime identity explicit so the currently enrolled process remains manageable
    # when the same request moves from a standalone JSON file into this environment config.
    Sha256 = $RuntimeConfigSha256
  }
}

function Get-PocketIcProcesses {
  $lines = (Invoke-Wsl -Arguments @("ps", "-ww", "-eo", "pid=,args=")).Output
  $matchingProcesses = @()
  $portFileOwners = @()
  foreach ($lineValue in $lines) {
    $line = "$lineValue"
    if ($line -notmatch '^\s*(\d+)\s+(.+)$') { continue }
    $pidValue = [int]$Matches[1]
    $commandLine = $Matches[2].Trim()
    if ($commandLine -eq $ExpectedCommandLine) {
      $matchingProcesses += [pscustomobject]@{ Pid = $pidValue; CommandLine = $commandLine }
    } elseif ($commandLine.StartsWith("$PocketIcBinary ") -and
              $commandLine.Contains("--port-file $ControlPortFile")) {
      $portFileOwners += [pscustomobject]@{ Pid = $pidValue; CommandLine = $commandLine }
    }
  }
  if ($portFileOwners.Count -gt 0) {
    throw "A PocketIC process uses the reserved port file with an unexpected command line; refusing to manage it"
  }
  @($matchingProcesses)
}

function Get-ProcessIdentity {
  param([Parameter(Mandatory = $true)][int]$PidValue)

  if (-not (Test-WslPath -Path "/proc/$PidValue" -Mode "-d")) {
    throw "Linux PID $PidValue no longer exists"
  }
  $exe = (Get-WslText -Arguments @("readlink", "-f", "/proc/$PidValue/exe")).Trim()
  $stat = (Get-WslText -Arguments @("cat", "/proc/$PidValue/stat")).Trim()
  $closeParen = $stat.LastIndexOf(")")
  if ($closeParen -lt 0) { throw "Could not parse /proc/$PidValue/stat" }
  $fieldsAfterComm = @($stat.Substring($closeParen + 2).Split(" ", [StringSplitOptions]::RemoveEmptyEntries))
  if ($fieldsAfterComm.Count -lt 20) { throw "Incomplete /proc/$PidValue/stat" }
  $startTicks = $fieldsAfterComm[19]
  $binaryHashLine = (Get-WslText -Arguments @("sha256sum", "/proc/$PidValue/exe")).Trim()
  $binaryHash = ($binaryHashLine -split '\s+')[0].ToLowerInvariant()

  [pscustomobject]@{
    Pid = $PidValue
    Exe = $exe
    StartTicks = "$startTicks"
    BinarySha256 = $binaryHash
  }
}

function Get-ControlPort {
  if (-not (Test-WslPath -Path $ControlPortFile -Mode "-f")) {
    throw "PocketIC control port file is missing: $ControlPortFile"
  }
  $text = (Get-WslText -Arguments @("cat", $ControlPortFile)).Trim()
  $port = 0
  if (-not [int]::TryParse($text, [ref]$port) -or $port -lt 1024 -or $port -gt 65535) {
    throw "Invalid PocketIC control port file content"
  }
  $port
}

function Assert-ProcessOwnsPort {
  param([Parameter(Mandatory = $true)][int]$PidValue,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$Purpose)
  $result = Invoke-WslHelper -Arguments @('owns-port', $PidValue, $Port) -AllowFailure
  if ($result.ExitCode -ne 0) {
    throw ('Linux PID {0} does not own the 127.0.0.1:{1} {2} listener' -f $PidValue, $Port, $Purpose)
  }
}

function Invoke-ControlRequest {
  param(
    [Parameter(Mandatory = $true)][int]$ControlPort,
    [Parameter(Mandatory = $true)][string]$Path,
    [ValidateSet("Get", "Post", "Delete")][string]$Method = "Get",
    [AllowNull()][string]$Body = $null,
    [int]$RequestTimeoutSeconds = 30
  )

  $params = @{
    Uri = "http://127.0.0.1:$ControlPort$Path"
    Method = $Method
    UseBasicParsing = $true
    TimeoutSec = $RequestTimeoutSeconds
  }
  if ($PSBoundParameters.ContainsKey('Body')) {
    $params.Body = $Body
    $params.ContentType = "application/json"
  }
  Invoke-WebRequest @params
}

function Get-InstanceStatuses {
  param([Parameter(Mandatory = $true)][int]$ControlPort)
  $response = Invoke-ControlRequest -ControlPort $ControlPort -Path "/instances"
  $parsed = $response.Content | ConvertFrom-Json
  @($parsed)
}

function Wait-OnlyAvailableInstanceId {
  param(
    [Parameter(Mandatory = $true)][int]$ControlPort,
    [ValidateRange(-1, [int]::MaxValue)][int]$ExpectedInstanceId = -1
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastStatusSummary = '<none>'
  do {
    $statuses = @(Get-InstanceStatuses -ControlPort $ControlPort)
    $active = @()
    $available = @()
    $descriptions = @()
    for ($index = 0; $index -lt $statuses.Count; $index++) {
      $state = "$($statuses[$index])"
      $descriptions += ('{0}={1}' -f $index, $state)
      if ($state -ne 'Deleted') { $active += $index }
      if ($state -eq 'Available') { $available += $index }
    }
    $lastStatusSummary = if ($descriptions.Count -eq 0) {
      '<none>'
    } else {
      $descriptions -join ', '
    }

    # AutoProgress temporarily exposes the sole instance as Busy. More than one non-deleted
    # instance is never a transient condition this recovered-state wrapper may accept.
    if ($active.Count -gt 1) {
      throw "Expected at most one active PocketIC instance; observed $lastStatusSummary"
    }
    if ($available.Count -eq 1) {
      $instanceId = [int]$available[0]
      if ($ExpectedInstanceId -ge 0 -and $instanceId -ne $ExpectedInstanceId) {
        throw "Available PocketIC instance $instanceId does not match recorded instance $ExpectedInstanceId"
      }
      return $instanceId
    }

    if ([DateTime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Milliseconds 250
  } while ($true)

  throw "Expected exactly one Available PocketIC instance within $TimeoutSeconds seconds; observed $lastStatusSummary"
}

function Assert-Topology {
  param([Parameter(Mandatory = $true)]$Topology)
  $actual = @($Topology.subnet_configs.PSObject.Properties)
  if ($actual.Count -ne $ExpectedTopology.Count) {
    throw "Recovered topology mismatch: expected 3 subnets, found $($actual.Count)"
  }
  foreach ($property in $actual) {
    if (-not $ExpectedTopology.Contains($property.Name)) {
      throw "Recovered topology contains unexpected subnet $($property.Name)"
    }
    $expected = $ExpectedTopology[$property.Name]
    $value = $property.Value
    $seed = -join ($value.subnet_seed | ForEach-Object { ([byte]$_).ToString("x2") })
    if ($value.subnet_kind -ne $expected.kind -or
        $value.instruction_config -ne "Production" -or
        $seed -ne $expected.seed -or
        ((@($value.canister_ranges | ForEach-Object {
          '{0}|{1}' -f $_.start.canister_id, $_.end.canister_id
        })) -join ',') -ne (@($expected.ranges) -join ',')) {
      throw "Recovered topology fingerprint mismatch for subnet $($property.Name)"
    }
  }
  if ($Topology.default_effective_canister_id.canister_id -ne $DefaultEffectiveCanisterId) {
    throw "Unexpected default effective canister ID in recovered topology"
  }
}

function Get-Topology {
  param([Parameter(Mandatory = $true)][int]$ControlPort,
        [Parameter(Mandatory = $true)][int]$InstanceId)
  $response = Invoke-ControlRequest -ControlPort $ControlPort -Path "/instances/$InstanceId/read/topology"
  $topology = $response.Content | ConvertFrom-Json
  Assert-Topology -Topology $topology
  $topology
}

function Get-WasmVersionString {
  param($Metrics)
  "{0}.{1}.{2}" -f [int]$Metrics.wasm_version.major,
    [int]$Metrics.wasm_version.minor, [int]$Metrics.wasm_version.patch
}

function Assert-CanistersAvailable {
  $statusResponse = Invoke-WebRequest -Uri "http://127.0.0.1:$GatewayPort/api/v2/status" `
    -UseBasicParsing -TimeoutSec 20
  if ($statusResponse.StatusCode -ne 200 -or $statusResponse.RawContentLength -lt 1) {
    throw "PocketIC gateway status endpoint is unavailable"
  }

  foreach ($canister in $ExpectedCanisters) {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$GatewayPort/metrics" `
      -Headers @{ Host = "$($canister.id).raw.localhost" } -UseBasicParsing -TimeoutSec 20
    if ($response.StatusCode -ne 200) {
      throw "$($canister.role) canister $($canister.id) returned HTTP $($response.StatusCode)"
    }
    try {
      $metrics = $response.Content | ConvertFrom-Json
    } catch {
      throw "$($canister.role) canister $($canister.id) returned invalid metrics JSON"
    }
    $version = Get-WasmVersionString -Metrics $metrics
    if ($version -ne $canister.version -or $metrics.git_commit_id -ne $canister.commit) {
      throw "$($canister.role) canister does not match recovered PR2 deployment (got $version)"
    }
  }
}

function Wait-RecoveredState {
  param([Parameter(Mandatory = $true)][int]$ControlPort,
        [Parameter(Mandatory = $true)][int]$InstanceId)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastError = $null
  do {
    try {
      Get-Topology -ControlPort $ControlPort -InstanceId $InstanceId | Out-Null
      Assert-CanistersAvailable
      return
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds 750
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Recovered state did not become healthy within $TimeoutSeconds seconds: $($lastError.Exception.Message)"
}

function Read-Metadata {
  if (-not (Test-WslPath -Path $MetadataFile -Mode "-f")) { return $null }
  $raw = Get-WslText -Arguments @("cat", $MetadataFile)
  try {
    $metadata = $raw | ConvertFrom-Json
  } catch {
    throw "Runtime metadata is invalid JSON; refusing to manage the process"
  }
  if ([int]$metadata.schema_version -ne 1) {
    throw "Unsupported runtime metadata schema; refusing to manage the process"
  }
  $metadata
}

function Write-Metadata {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)]$Identity,
    [Parameter(Mandatory = $true)][int]$ControlPort,
    [Parameter(Mandatory = $true)][int]$InstanceId,
    [Parameter(Mandatory = $true)][string]$ConfigSha256,
    [Parameter(Mandatory = $true)][bool]$AdoptedExisting
  )
  $metadata = [ordered]@{
    schema_version = 1
    recorded_at_utc = [DateTime]::UtcNow.ToString("o")
    adopted_existing = $AdoptedExisting
    pid = [int]$Process.Pid
    proc_start_ticks = $Identity.StartTicks
    binary = $PocketIcBinary
    binary_sha256 = $Identity.BinarySha256
    command_line = $Process.CommandLine
    control_port_file = $ControlPortFile
    control_port = $ControlPort
    instance_id = $InstanceId
    gateway_port = $GatewayPort
    state_dir = $StateDir
    config_sha256 = $ConfigSha256
  }
  $json = $metadata | ConvertTo-Json -Depth 5
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  Invoke-WslHelper -Arguments @('write-metadata', $encoded, $MetadataFile) | Out-Null
}

function Assert-ProcessMatchesMetadata {
  param([Parameter(Mandatory = $true)]$Process,
        [Parameter(Mandatory = $true)]$Metadata,
        [switch]$AllowClosedGateway)
  if ([int]$Process.Pid -ne [int]$Metadata.pid -or
      $Process.CommandLine -ne $ExpectedCommandLine -or
      $Metadata.command_line -ne $ExpectedCommandLine -or
      $Metadata.binary -ne $PocketIcBinary -or
      $Metadata.control_port_file -ne $ControlPortFile -or
      $Metadata.state_dir -ne $StateDir -or [int]$Metadata.gateway_port -ne $GatewayPort) {
    throw "Runtime metadata does not identify the exact recovered PocketIC process"
  }
  $identity = Get-ProcessIdentity -PidValue ([int]$Process.Pid)
  if ($identity.Exe -ne $PocketIcBinary -or
      $identity.StartTicks -ne "$($Metadata.proc_start_ticks)" -or
      $identity.BinarySha256 -ne $Metadata.binary_sha256) {
    throw "PocketIC PID identity changed; refusing to manage it"
  }
  $controlPort = Get-ControlPort
  if ($controlPort -ne [int]$Metadata.control_port) {
    throw "PocketIC control port no longer matches runtime metadata"
  }
  Assert-ProcessOwnsPort -PidValue ([int]$Process.Pid) -Port $controlPort -Purpose 'control'
  if (-not $AllowClosedGateway) {
    Assert-ProcessOwnsPort -PidValue ([int]$Process.Pid) -Port $GatewayPort -Purpose 'gateway'
  }
  $identity
}

function Get-ManagedStatus {
  param([switch]$RequireMetadata)
  $config = Get-Config
  $processes = @(Get-PocketIcProcesses)
  $metadata = Read-Metadata
  if ($processes.Count -eq 0) {
    if ($RequireMetadata) { throw "The recovered PocketIC process is not running" }
    return [pscustomobject]@{
      State = "stopped"
      Managed = $false
      Healthy = $false
      Note = $(if ($null -ne $metadata) { "stale runtime metadata retained" } else { "not running" })
    }
  }
  if ($processes.Count -ne 1) {
    throw "Expected one exact recovered PocketIC process, found $($processes.Count)"
  }
  $process = $processes[0]
  $controlPort = Get-ControlPort
  Assert-ProcessOwnsPort -PidValue ([int]$process.Pid) -Port $controlPort -Purpose 'control'
  Assert-ProcessOwnsPort -PidValue ([int]$process.Pid) -Port $GatewayPort -Purpose 'gateway'
  $instanceId = if ($null -eq $metadata) {
    Wait-OnlyAvailableInstanceId -ControlPort $controlPort
  } else {
    Wait-OnlyAvailableInstanceId -ControlPort $controlPort `
      -ExpectedInstanceId ([int]$metadata.instance_id)
  }
  Wait-RecoveredState -ControlPort $controlPort -InstanceId $instanceId

  if ($null -eq $metadata) {
    if ($RequireMetadata) {
      throw "The process is healthy but not enrolled; run 'start' once before it can be stopped safely"
    }
    return [pscustomobject]@{
      State = "running-unmanaged"
      Managed = $false
      Healthy = $true
      Pid = $process.Pid
      ControlPort = $controlPort
      GatewayPort = $GatewayPort
      InstanceId = $instanceId
      Note = "run 'start' once to enroll this exact process"
    }
  }

  Assert-ProcessMatchesMetadata -Process $process -Metadata $metadata | Out-Null
  if ([int]$metadata.instance_id -ne $instanceId -or
      $metadata.config_sha256 -ne $config.Sha256) {
    throw "Active instance/config no longer matches runtime metadata"
  }
  [pscustomobject]@{
    State = "running"
    Managed = $true
    Healthy = $true
    Pid = $process.Pid
    ControlPort = $controlPort
    GatewayPort = $GatewayPort
    InstanceId = $instanceId
  }
}

function Stop-ExactEmptyServerAfterRejectedCreate {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)]$Identity,
    [Parameter(Mandatory = $true)][int]$ControlPort
  )
  $statuses = @(Get-InstanceStatuses -ControlPort $ControlPort)
  if ($statuses.Count -ne 0) {
    throw "Rejected PocketIC create left an instance; refusing automatic process cleanup"
  }
  Assert-ProcessOwnsPort -PidValue ([int]$Process.Pid) -Port $ControlPort -Purpose 'control'
  Invoke-WslHelper -Arguments @(
    'signal-term', "$($Process.Pid)", "$($Identity.StartTicks)"
  ) | Out-Null
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    if (-not (Test-WslPath -Path "/proc/$($Process.Pid)" -Mode '-d')) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  if (Test-WslPath -Path "/proc/$($Process.Pid)" -Mode '-d') {
    throw "Empty PocketIC server did not exit after rejected create"
  }
  Invoke-Wsl -Arguments @('rm', '-f', '--', $ControlPortFile) | Out-Null
}

function Invoke-PublishedAiAppCheck {
  if (-not (Test-Path -LiteralPath $AiAppChecker -PathType Leaf)) {
    throw "Published AI app checker is missing: $AiAppChecker"
  }
  if (-not (Test-Path -LiteralPath $Tsx -PathType Leaf)) {
    throw "tsx is missing: $Tsx"
  }
  $output = @(& $Tsx $AiAppChecker `
    '--host' "http://127.0.0.1:$GatewayPort" `
    '--user-index' $ExpectedPublishedApp.user_index `
    '--app-name' $ExpectedPublishedApp.name `
    '--expected-app-id' "$($ExpectedPublishedApp.app_id)" `
    '--expected-app-canister' $ExpectedPublishedApp.app_canister `
    '--expected-inbox' $ExpectedPublishedApp.inbox `
    '--expected-surface-origin' $ExpectedPublishedApp.surface_origin 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Published IOU app validation failed: $($output -join [Environment]::NewLine)"
  }
  $json = ($output | ForEach-Object { "$_" }) -join ''
  try {
    $result = $json | ConvertFrom-Json
  } catch {
    throw "Published IOU app checker returned invalid JSON: $json"
  }
  if ($result.ready -ne $true -or [int]$result.app.id -ne $ExpectedPublishedApp.app_id) {
    throw "Published IOU app checker did not validate the immutable app coordinates"
  }
  $result
}

function Start-RecoveredPocketIc {
  $config = Get-Config
  if (-not (Test-WslPath -Path $PocketIcBinary -Mode "-x")) {
    throw "PocketIC binary is missing or not executable: $PocketIcBinary"
  }
  if (-not (Test-WslPath -Path $StateDir -Mode "-d")) {
    throw "Recovered state directory is missing: $StateDir"
  }

  $processes = @(Get-PocketIcProcesses)
  if ($processes.Count -gt 1) {
    throw "Expected at most one exact recovered PocketIC process, found $($processes.Count)"
  }
  if ($processes.Count -eq 1) {
    $process = $processes[0]
    $metadata = Read-Metadata
    if ($null -ne $metadata) {
      return (Get-ManagedStatus -RequireMetadata)
    }
    $identity = Get-ProcessIdentity -PidValue $process.Pid
    if ($identity.Exe -ne $PocketIcBinary) {
      throw "Existing process executable does not match $PocketIcBinary"
    }
    $controlPort = Get-ControlPort
    Assert-ProcessOwnsPort -PidValue ([int]$process.Pid) -Port $controlPort -Purpose 'control'
    Assert-ProcessOwnsPort -PidValue ([int]$process.Pid) -Port $GatewayPort -Purpose 'gateway'
    $instanceId = Wait-OnlyAvailableInstanceId -ControlPort $controlPort
    Wait-RecoveredState -ControlPort $controlPort -InstanceId $instanceId
    Write-Metadata -Process $process -Identity $identity -ControlPort $controlPort `
      -InstanceId $instanceId -ConfigSha256 $config.Sha256 -AdoptedExisting $true
    return (Get-ManagedStatus -RequireMetadata)
  }

  $gatewayProbe = [Net.Sockets.TcpClient]::new()
  try {
    $connect = $gatewayProbe.BeginConnect("127.0.0.1", $GatewayPort, $null, $null)
    if ($connect.AsyncWaitHandle.WaitOne(500) -and $gatewayProbe.Connected) {
      throw "TCP port $GatewayPort is already in use by an unrelated process"
    }
  } finally {
    $gatewayProbe.Dispose()
  }

  # No exact process owns the unique port file, so an old file can only be stale.
  if (Test-WslPath -Path $MetadataFile -Mode '-f') {
    $staleMetadata = '{0}.stale.{1}' -f $MetadataFile,
      [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
    Invoke-Wsl -Arguments @('mv', '--', $MetadataFile, $staleMetadata) | Out-Null
  }
  Invoke-Wsl -Arguments @('rm', '-f', '--', $ControlPortFile) | Out-Null
  Invoke-WslHelper -Arguments @(
    'launch', $PocketIcBinary, $ControlPortFile, $LogFile,
    "$PocketIcTtlSeconds", $PocketIcLogLevels
  ) | Out-Null

  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 250
    $processes = @(Get-PocketIcProcesses)
    if ($processes.Count -eq 1 -and (Test-WslPath -Path $ControlPortFile -Mode "-f")) { break }
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($processes.Count -ne 1 -or -not (Test-WslPath -Path $ControlPortFile -Mode "-f")) {
    throw "PocketIC server did not publish its control port; inspect $LogFile"
  }

  $process = $processes[0]
  $identity = Get-ProcessIdentity -PidValue $process.Pid
  $controlPort = Get-ControlPort
  Assert-ProcessOwnsPort -PidValue ([int]$process.Pid) -Port $controlPort -Purpose 'control'
  try {
    $createResponse = Invoke-ControlRequest -ControlPort $controlPort -Path "/instances" `
      -Method Post -Body $config.Raw -RequestTimeoutSeconds $TimeoutSeconds
  } catch {
    $createFailure = $_
    try {
      Stop-ExactEmptyServerAfterRejectedCreate -Process $process -Identity $identity `
        -ControlPort $controlPort
    } catch {
      throw "PocketIC strict reopen was rejected and empty-server cleanup also failed: $($_.Exception.Message)"
    }
    throw $createFailure
  }
  $createdEnvelope = $createResponse.Content | ConvertFrom-Json
  if (-not ($createdEnvelope.PSObject.Properties.Name -contains "Created")) {
    $message = if ($createdEnvelope.PSObject.Properties.Name -contains "Error") {
      $createdEnvelope.Error.message
    } else {
      $createResponse.Content
    }
    Stop-ExactEmptyServerAfterRejectedCreate -Process $process -Identity $identity `
      -ControlPort $controlPort
    throw "PocketIC strict reopen failed without creating an instance: $message"
  }
  $instanceId = [int]$createdEnvelope.Created.instance_id

  # Record identity before health validation. If validation fails, Stop still has enough exact
  # metadata to checkpoint and terminate safely; this wrapper never kills an unrecorded PID.
  Write-Metadata -Process $process -Identity $identity -ControlPort $controlPort `
    -InstanceId $instanceId -ConfigSha256 $config.Sha256 -AdoptedExisting $false
  Wait-OnlyAvailableInstanceId -ControlPort $controlPort `
    -ExpectedInstanceId $instanceId | Out-Null
  Assert-Topology -Topology $createdEnvelope.Created.topology
  Wait-RecoveredState -ControlPort $controlPort -InstanceId $instanceId
  Get-ManagedStatus -RequireMetadata
}

function Stop-RecoveredPocketIc {
  $config = Get-Config
  $processes = @(Get-PocketIcProcesses)
  if ($processes.Count -eq 0) {
    return [pscustomobject]@{ State = "stopped"; Managed = $false; Healthy = $false; Note = "not running" }
  }
  if ($processes.Count -ne 1) {
    throw "Expected one exact recovered PocketIC process, found $($processes.Count)"
  }
  $metadata = Read-Metadata
  if ($null -eq $metadata) {
    throw "No runtime metadata exists; run 'start' once to validate and enroll the process"
  }
  $process = $processes[0]
  Assert-ProcessMatchesMetadata -Process $process -Metadata $metadata `
    -AllowClosedGateway | Out-Null
  if ($metadata.config_sha256 -ne $config.Sha256) {
    throw "Strict reopen config changed since startup; refusing shutdown until it is restored"
  }
  $controlPort = [int]$metadata.control_port
  $instanceId = [int]$metadata.instance_id
  $statuses = @(Get-InstanceStatuses -ControlPort $controlPort)
  if ($instanceId -lt 0 -or $instanceId -ge $statuses.Count) {
    throw "Recorded instance ID is absent from the exact PocketIC server"
  }

  if ("$($statuses[$instanceId])" -ne "Deleted") {
    if ("$($statuses[$instanceId])" -ne "Available") {
      throw "Recorded PocketIC instance is not Available; refusing an unsafe shutdown"
    }
    Invoke-ControlRequest -ControlPort $controlPort `
      -Path "/instances/$instanceId/stop_progress" -Method Post -Body '""' | Out-Null
    Invoke-ControlRequest -ControlPort $controlPort `
      -Path "/instances/$instanceId" -Method Delete -RequestTimeoutSeconds $TimeoutSeconds | Out-Null

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
      Start-Sleep -Milliseconds 500
      $statuses = @(Get-InstanceStatuses -ControlPort $controlPort)
      if ($instanceId -lt $statuses.Count -and "$($statuses[$instanceId])" -eq "Deleted") { break }
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($instanceId -ge $statuses.Count -or "$($statuses[$instanceId])" -ne "Deleted") {
      throw "PocketIC did not finish its state checkpoint; the server was deliberately left running"
    }
  }

  # Re-check every PID invariant after the checkpoint and immediately before signalling.
  Assert-ProcessMatchesMetadata -Process $process -Metadata $metadata `
    -AllowClosedGateway | Out-Null
  Invoke-WslHelper -Arguments @(
    'signal-term', "$($process.Pid)", "$($metadata.proc_start_ticks)"
  ) | Out-Null
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    if (-not (Test-WslPath -Path "/proc/$($process.Pid)" -Mode "-d")) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  if (Test-WslPath -Path "/proc/$($process.Pid)" -Mode "-d") {
    throw "Exact PocketIC PID did not exit after SIGTERM; metadata was retained and SIGKILL was not used"
  }
  Invoke-Wsl -Arguments @("rm", "-f", "--", $MetadataFile, $ControlPortFile) | Out-Null
  [pscustomobject]@{
    State = "stopped"
    Managed = $false
    Healthy = $false
    CheckpointedInstanceId = $instanceId
    TerminatedPid = $process.Pid
  }
}

function Assert-GatewayPortFree {
  $probe = [Net.Sockets.TcpClient]::new()
  try {
    $connect = $probe.BeginConnect('127.0.0.1', $GatewayPort, $null, $null)
    if ($connect.AsyncWaitHandle.WaitOne(500) -and $probe.Connected) {
      throw "TCP port $GatewayPort is already in use; refusing recovery"
    }
  } finally {
    $probe.Dispose()
  }
}

function New-TimestampedStateBackup {
  if (-not (Test-WslPath -Path $StateDir -Mode '-d')) {
    throw "Recovered state directory is missing: $StateDir"
  }
  $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
  $backup = "$StateDir.pre-incomplete-repair-$stamp"
  if (Test-WslPath -Path $backup) { throw "Recovery backup path already exists: $backup" }

  Write-Host "Creating full timestamped backup: $backup"
  Invoke-Wsl -Arguments @('cp', '-a', '--reflink=auto', '--', $StateDir, $backup) | Out-Null
  $verification = Invoke-WslHelper -Arguments @('verify-backup', $StateDir, $backup) -AllowFailure
  if ($verification.ExitCode -ne 0) {
    throw "Timestamped state backup differs from its source; recovery was not started"
  }
  $inventoryRaw = Get-WslText -Arguments @(
    'bash', (Get-WslHelperPath), 'state-inventory', $backup
  )
  try {
    $inventory = $inventoryRaw | ConvertFrom-Json
  } catch {
    throw "Could not parse backup inventory: $inventoryRaw"
  }
  if ([int64]$inventory.files -lt 1 -or [int64]$inventory.bytes -lt 1) {
    throw "Timestamped state backup inventory is empty"
  }
  [pscustomobject]@{
    Path = $backup
    Files = [int64]$inventory.files
    Bytes = [int64]$inventory.bytes
  }
}

function Get-IncompleteRecoveryConfig {
  $strict = Get-Config
  $parsed = $strict.Raw | ConvertFrom-Json
  # Get-Config has already fingerprinted every topology/state/gateway setting and required this
  # field to be null. The one-time recovery request differs in exactly this one explicit property.
  $parsed.incomplete_state = 'Enabled'
  $raw = $parsed | ConvertTo-Json -Depth 20
  $roundTrip = $raw | ConvertFrom-Json
  if ($roundTrip.incomplete_state -ne 'Enabled' -or $roundTrip.state_dir -ne $StateDir) {
    throw "Could not construct the bounded incomplete-state recovery request"
  }
  $raw
}

function Start-ExactPocketIcServer {
  $processes = @(Get-PocketIcProcesses)
  if ($processes.Count -ne 0) {
    throw "Recovery requires no existing exact PocketIC process; found $($processes.Count)"
  }
  Assert-GatewayPortFree
  Invoke-Wsl -Arguments @('rm', '-f', '--', $ControlPortFile) | Out-Null
  Invoke-WslHelper -Arguments @(
    'launch', $PocketIcBinary, $ControlPortFile, $LogFile,
    "$PocketIcTtlSeconds", $PocketIcLogLevels
  ) | Out-Null

  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 250
    $processes = @(Get-PocketIcProcesses)
    if ($processes.Count -eq 1 -and (Test-WslPath -Path $ControlPortFile -Mode '-f')) { break }
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($processes.Count -ne 1 -or -not (Test-WslPath -Path $ControlPortFile -Mode '-f')) {
    throw "PocketIC recovery server did not publish its control port; inspect $LogFile"
  }
  $process = $processes[0]
  $identity = Get-ProcessIdentity -PidValue $process.Pid
  $controlPort = Get-ControlPort
  Assert-ProcessOwnsPort -PidValue ([int]$process.Pid) -Port $controlPort -Purpose 'control'
  [pscustomobject]@{
    Process = $process
    Identity = $identity
    ControlPort = $controlPort
  }
}

function Wait-InstanceDeleted([int]$ControlPort, [int]$InstanceId) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $statuses = @(Get-InstanceStatuses -ControlPort $ControlPort)
    if ($InstanceId -lt $statuses.Count -and "$($statuses[$InstanceId])" -eq 'Deleted') { return }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "PocketIC recovery instance did not finish its clean checkpoint/delete"
}

function Stop-DeletedRecoveryServer($Server, [int]$InstanceId) {
  $statuses = @(Get-InstanceStatuses -ControlPort $Server.ControlPort)
  if ($InstanceId -ge $statuses.Count -or "$($statuses[$InstanceId])" -ne 'Deleted') {
    throw "Recovery instance is not Deleted; refusing to terminate PocketIC"
  }
  Assert-ProcessOwnsPort -PidValue ([int]$Server.Process.Pid) `
    -Port ([int]$Server.ControlPort) -Purpose 'control'
  Invoke-WslHelper -Arguments @(
    'signal-term', "$($Server.Process.Pid)", "$($Server.Identity.StartTicks)"
  ) | Out-Null
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    if (-not (Test-WslPath -Path "/proc/$($Server.Process.Pid)" -Mode '-d')) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  if (Test-WslPath -Path "/proc/$($Server.Process.Pid)" -Mode '-d') {
    throw "Checkpointed recovery PocketIC process did not exit after SIGTERM"
  }
  Invoke-Wsl -Arguments @('rm', '-f', '--', $ControlPortFile) | Out-Null
}

function Repair-IncompleteRecoveredState {
  if (-not $ConfirmIncompleteStateRecovery) {
    throw (
      "Recovery is intentionally opt-in. Re-run with action 'repair' and " +
      '-ConfirmIncompleteStateRecovery after reviewing the timestamped backup and checkpoint flow.'
    )
  }
  if (-not (Test-WslPath -Path $PocketIcBinary -Mode '-x')) {
    throw "PocketIC binary is missing or not executable: $PocketIcBinary"
  }
  if (-not (Test-Path -LiteralPath $AiAppChecker -PathType Leaf) -or
      -not (Test-Path -LiteralPath $Tsx -PathType Leaf)) {
    throw "Read-only published-app validator dependencies are missing; recovery was not started"
  }
  if (@(Get-PocketIcProcesses).Count -ne 0) {
    throw "Stop the exact recovered PocketIC process before incomplete-state recovery"
  }

  $recoveryConfig = Get-IncompleteRecoveryConfig
  $backup = New-TimestampedStateBackup
  Write-Host "Backup verified: $($backup.Files) files, $($backup.Bytes) bytes"

  $server = Start-ExactPocketIcServer
  try {
    $response = Invoke-ControlRequest -ControlPort $server.ControlPort -Path '/instances' `
      -Method Post -Body $recoveryConfig -RequestTimeoutSeconds $TimeoutSeconds
  } catch {
    $createFailure = $_
    try {
      Stop-ExactEmptyServerAfterRejectedCreate -Process $server.Process `
        -Identity $server.Identity -ControlPort $server.ControlPort
    } catch {
      throw (
        "Incomplete-state create failed after backup $($backup.Path), and empty-server cleanup " +
        "also failed: $($_.Exception.Message)"
      )
    }
    throw $createFailure
  }
  $created = $response.Content | ConvertFrom-Json
  if (-not ($created.PSObject.Properties.Name -contains 'Created')) {
    Stop-ExactEmptyServerAfterRejectedCreate -Process $server.Process `
      -Identity $server.Identity -ControlPort $server.ControlPort
    $message = if ($created.PSObject.Properties.Name -contains 'Error') {
      $created.Error.message
    } else {
      $response.Content
    }
    throw "Incomplete-state reopen failed without creating an instance: $message"
  }
  $instanceId = [int]$created.Created.instance_id

  # Freeze progression before validation so timers/XNet cannot run away during the one-time repair.
  Wait-OnlyAvailableInstanceId -ControlPort $server.ControlPort `
    -ExpectedInstanceId $instanceId | Out-Null
  Invoke-ControlRequest -ControlPort $server.ControlPort `
    -Path "/instances/$instanceId/stop_progress" -Method Post -Body '""' | Out-Null
  Assert-Topology -Topology $created.Created.topology
  Get-Topology -ControlPort $server.ControlPort -InstanceId $instanceId | Out-Null
  Assert-CanistersAvailable

  # DELETE after stop_progress is PocketIC's clean checkpoint operation. Never signal the process
  # until the exact instance reports Deleted.
  Invoke-ControlRequest -ControlPort $server.ControlPort -Path "/instances/$instanceId" `
    -Method Delete -RequestTimeoutSeconds $TimeoutSeconds | Out-Null
  Wait-InstanceDeleted -ControlPort $server.ControlPort -InstanceId $instanceId
  Stop-DeletedRecoveryServer -Server $server -InstanceId $instanceId

  $strict = Start-RecoveredPocketIc
  $app = Invoke-PublishedAiAppCheck
  [pscustomobject]@{
    State = 'repaired-running-strict'
    Healthy = $true
    BackupPath = $backup.Path
    BackupFiles = $backup.Files
    BackupBytes = $backup.Bytes
    StrictRuntime = $strict
    PublishedAppId = [int]$app.app.id
    PublishedAppRevision = "$($app.app.revision)"
  }
}

switch ($Action.ToLowerInvariant()) {
  "start" { Start-RecoveredPocketIc }
  "stop" { Stop-RecoveredPocketIc }
  "status" { Get-ManagedStatus }
  "repair" { Repair-IncompleteRecoveredState }
  "validate-config" {
    Get-Config | Out-Null
    [pscustomobject]@{ Valid = $true }
  }
}
