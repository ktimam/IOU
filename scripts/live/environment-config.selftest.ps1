[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'environment-config.ps1')

$originalDirectory = (Get-Location).Path
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = [IO.Path]::GetFullPath((
  Join-Path $tempBase ("iou-environment-config-selftest-{0}" -f [Guid]::NewGuid().ToString('N'))
))
$otherDirectory = Join-Path $testRoot 'other'
$configPath = Join-Path $testRoot 'config.json'

try {
  [IO.Directory]::CreateDirectory($otherDirectory) | Out-Null
  [IO.File]::WriteAllText(
    $configPath,
    '{"top":{"single":[{"name":"one"}],"empty":[],"flag":true,"number":42,"nothing":null}}',
    [Text.UTF8Encoding]::new($false)
  )

  Set-Location -LiteralPath $testRoot
  $capturedAbsolutePath = Resolve-EnvironmentConfigPath -Path 'config.json'
  Set-Location -LiteralPath $otherDirectory
  $config = Read-EnvironmentConfigFile -Path $capturedAbsolutePath

  if ($config -isnot [Collections.IDictionary] -or
      $config['top'] -isnot [Collections.IDictionary]) {
    throw 'Nested JSON objects were not converted to dictionaries'
  }
  $single = $config['top']['single']
  $empty = $config['top']['empty']
  if ($single -isnot [array] -or $single.Count -ne 1 -or
      $single[0] -isnot [Collections.IDictionary] -or
      $single[0]['name'] -ne 'one') {
    throw 'A one-element object array was not preserved'
  }
  if ($empty -isnot [array] -or $empty.Count -ne 0) {
    throw 'An empty JSON array was not preserved'
  }
  if ($config['top']['flag'] -ne $true -or $config['top']['number'] -ne 42 -or
      $null -ne $config['top']['nothing']) {
    throw 'JSON scalar values were not preserved'
  }

  [pscustomobject]@{
    Valid = $true
    PowerShellVersion = $PSVersionTable.PSVersion.ToString()
    AbsolutePathSurvivedLocationChange = $true
    RecursiveDictionaryConversion = $true
    JsonArraysPreserved = $true
  }
} finally {
  Set-Location -LiteralPath $originalDirectory
  if (Test-Path -LiteralPath $testRoot) {
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    $expectedPrefix = [IO.Path]::GetFullPath($tempBase)
    if (-not $resolvedTestRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedTestRoot) -notlike 'iou-environment-config-selftest-*') {
      throw "Refusing to remove unexpected self-test directory: $resolvedTestRoot"
    }
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
  }
}
