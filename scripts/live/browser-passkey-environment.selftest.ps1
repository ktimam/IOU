[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'browser-passkey-environment.ps1')

$passed = 0
foreach ($case in @(
  @{ Name = 'configured hostname'; Rp = 'machine.tail-example.ts.net'; Value = 'machine.tail-example.ts.net'; Pass = $true },
  @{ Name = 'another configured hostname'; Rp = 'second.tail-other.ts.net'; Value = 'second.tail-other.ts.net'; Pass = $true },
  @{ Name = 'regression: localhost on phone'; Rp = 'machine.tail-example.ts.net'; Value = 'localhost'; Pass = $false },
  @{ Name = 'APK production domain on phone'; Rp = 'machine.tail-example.ts.net'; Value = 'oc.app'; Pass = $false },
  @{ Name = 'different tailnet'; Rp = 'machine.tail-example.ts.net'; Value = 'second.tail-other.ts.net'; Pass = $false },
  @{ Name = 'URL instead of RP hostname'; Rp = 'machine.tail-example.ts.net'; Value = 'https://machine.tail-example.ts.net'; Pass = $false },
  @{ Name = 'null RP'; Rp = 'machine.tail-example.ts.net'; Value = $null; Pass = $false },
  @{ Name = 'empty expected RP'; Rp = ''; Value = ''; Pass = $false }
)) {
  $module = 'import.meta.env = ' + (@{ OC_WEBAUTHN_ORIGIN = $case.Value } | ConvertTo-Json -Compress) + ';'
  $accepted = $true
  try { Assert-BrowserPasskeyEnvironment -Module $module -ExpectedRpId $case.Rp }
  catch { $accepted = $false }
  if ($accepted -ne $case.Pass) { throw "Incorrect acceptance: $($case.Name)" }
  $passed++
}
Assert-BrowserPasskeyEnvironment -ExpectedRpId 'machine.tail-example.ts.net' -Module (
  'import.meta.env = {"OC_WEBAUTHN_ORIGIN":"machine.tail-example.ts.net"};' +
  'BigInt.prototype.toJSON = function () { return this.toString(); };'
)
$passed++
foreach ($module in @(
  '',
  'import.meta.env = {};',
  'import.meta.env = {broken};',
  "import.meta.env = {};`nimport.meta.env = {};"
)) {
  $rejected = $false
  try { Assert-BrowserPasskeyEnvironment -Module $module -ExpectedRpId 'machine.tail-example.ts.net' }
  catch { $rejected = $true }
  if (-not $rejected) { throw 'Malformed or missing build configuration was accepted' }
  $passed++
}

# Check the real launcher binding without executing its process/network operations.
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $PSScriptRoot 'start-environment.ps1'), [ref]$tokens, [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) { throw 'Environment launcher has syntax errors' }
$settings = $ast.FindAll({ param($node)
  $node -is [Management.Automation.Language.HashtableAst]
}, $true)
$bindings = @($settings.KeyValuePairs | Where-Object { $_.Item1.Extent.Text -eq 'OC_WEBAUTHN_ORIGIN' })
if ($bindings.Count -ne 1 -or $bindings[0].Item2.Extent.Text -cne '$TailnetHost') {
  throw 'Browser launcher must derive its passkey domain from the configured TailnetHost'
}
$passed++
[pscustomobject]@{ Passed = $passed; CredentialRequests = 0; ServerChanges = 0 }
