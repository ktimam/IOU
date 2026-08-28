# Launch all durable profiles with CDP debug ports + persistent user-data directories.
# Re-running is safe: healthy profiles are reused and only an exact unhealthy profile is replaced.
# Every machine-specific path is explicit so this helper can be shared without embedding a user,
# profile root, checkout, or installation identity.
[CmdletBinding()]
param(
  [switch]$NoDesktop,
  [switch]$DesktopOnly,

  [Parameter(Mandatory)]
  [ValidateNotNullOrEmpty()]
  [string]$ChromeExecutable,

  [Parameter(Mandatory)]
  [ValidateNotNullOrEmpty()]
  [string]$ProfileRoot,

  [string]$DesktopExecutable
)

if ($NoDesktop -and $DesktopOnly) {
  throw '-NoDesktop and -DesktopOnly cannot be combined'
}

$chromePath = [IO.Path]::GetFullPath($ChromeExecutable)
$profilesPath = [IO.Path]::GetFullPath($ProfileRoot)
if (-not (Test-Path -LiteralPath $chromePath -PathType Leaf)) {
  throw "Configured Chrome executable is missing: $chromePath"
}

$desktopPath = $null
if (-not $NoDesktop) {
  if ([string]::IsNullOrWhiteSpace($DesktopExecutable)) {
    throw '-DesktopExecutable is required unless -NoDesktop is used'
  }
  $desktopPath = [IO.Path]::GetFullPath($DesktopExecutable)
  if (-not (Test-Path -LiteralPath $desktopPath -PathType Leaf)) {
    throw "Configured OpenChat desktop executable is missing: $desktopPath"
  }
}

$cdpPorts = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'cdp-ports.json') -Raw |
  ConvertFrom-Json
[IO.Directory]::CreateDirectory($profilesPath) | Out-Null

function Test-CdpHealthy([int]$Port) {
  try {
    Invoke-WebRequest "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 -UseBasicParsing |
      Out-Null
    return $true
  } catch {
    return $false
  }
}

function Assert-CdpPortBindable([int]$Port) {
  $listener = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    $Port
  )
  try {
    $listener.Start()
  } catch {
    throw "CDP port $Port is occupied or reserved by Windows. Choose a free port in cdp-ports.json."
  } finally {
    $listener.Stop()
  }
}

function Wait-CdpHealthy([int]$Port, [string]$Name) {
  foreach ($attempt in 1..30) {
    if (Test-CdpHealthy $Port) {
      "  $Name :$Port UP"
      return
    }
    Start-Sleep -Milliseconds 500
  }
  throw "$Name did not expose CDP on port $Port"
}

function Stop-ExactChromeProfile([string]$UserDataDir) {
  $profileNeedle = [regex]::Escape($UserDataDir)
  $processes = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $profileNeedle }
  foreach ($process in $processes) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($processes) {
    Start-Sleep -Seconds 2
  }
}

$profiles = @(
  @{ name = 'manager'; port = [int]$cdpPorts.manager; urls = @('http://localhost:5003/', 'http://127.0.0.1:3000/') },
  @{ name = 'mother'; port = [int]$cdpPorts.mother; urls = @('http://localhost:5003/', 'http://127.0.0.1:3000/') },
  @{ name = 'child'; port = [int]$cdpPorts.child; urls = @('http://localhost:5003/', 'http://127.0.0.1:3000/') },
  @{ name = 'father-iou'; port = [int]$cdpPorts.fatherIou; urls = @('http://127.0.0.1:3000/') }
)

if (-not $DesktopOnly) {
  foreach ($profile in $profiles) {
    if (Test-CdpHealthy $profile.port) {
      "reusing $($profile.name) on :$($profile.port)"
      continue
    }

    $userDataDir = Join-Path $profilesPath $profile.name
    [IO.Directory]::CreateDirectory($userDataDir) | Out-Null
    Stop-ExactChromeProfile $userDataDir
    Get-ChildItem -LiteralPath $userDataDir -Filter 'Singleton*' -Force -ErrorAction SilentlyContinue |
      Remove-Item -Force -ErrorAction SilentlyContinue
    Assert-CdpPortBindable $profile.port

    $chromeArgs = @(
      "--remote-debugging-port=$($profile.port)",
      "--user-data-dir=$userDataDir",
      '--no-first-run',
      '--no-default-browser-check',
      '--restore-last-session=false'
    ) + $profile.urls
    Start-Process -FilePath $chromePath -ArgumentList $chromeArgs
    Wait-CdpHealthy $profile.port $profile.name
  }
}

if (-not $NoDesktop) {
  $desktopPort = [int]$cdpPorts.fatherOpenChat
  if (Test-CdpHealthy $desktopPort) {
    "reusing father OpenChat desktop app on :$desktopPort"
  } else {
    $existingDesktop = Get-CimInstance Win32_Process |
      Where-Object { $_.ExecutablePath -eq $desktopPath }
    foreach ($desktop in $existingDesktop) {
      Stop-Process -Id $desktop.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if ($existingDesktop) {
      Start-Sleep -Seconds 2
    }
    Assert-CdpPortBindable $desktopPort

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $desktopPath
    $startInfo.WorkingDirectory = Split-Path -Parent $desktopPath
    $startInfo.UseShellExecute = $false
    $startInfo.EnvironmentVariables['OC_DEV_EXTERNAL_BROWSER_EXE'] = $chromePath
    $startInfo.EnvironmentVariables['OC_DEV_EXTERNAL_BROWSER_USER_DATA_DIR'] =
      Join-Path $profilesPath 'father-iou'
    $startInfo.EnvironmentVariables['OC_DEV_EXTERNAL_BROWSER_PROFILE'] = 'Default'
    $startInfo.EnvironmentVariables['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] =
      "--remote-debugging-port=$desktopPort"
    $desktopProcess = [System.Diagnostics.Process]::Start($startInfo)
    if (-not $desktopProcess) {
      throw "Failed to launch $desktopPath"
    }
    Wait-CdpHealthy $desktopPort 'father OpenChat desktop app'
  }
}
