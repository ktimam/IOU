Set-StrictMode -Version Latest

function Resolve-EnvironmentConfigPath {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$Path
  )

  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function ConvertTo-EnvironmentConfigValue {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $false)]
    [AllowNull()]
    [object]$Value
  )

  if ($null -eq $Value) { return $null }

  if ($Value -is [Collections.IDictionary]) {
    $map = [Collections.Specialized.OrderedDictionary]::new([StringComparer]::Ordinal)
    foreach ($key in $Value.Keys) {
      $name = [string]$key
      if ($map.Contains($name)) {
        throw "Environment config contains duplicate object key '$name'"
      }
      $map.Add($name, (ConvertTo-EnvironmentConfigValue -Value $Value[$key]))
    }
    return ,$map
  }

  if ($Value -is [Management.Automation.PSCustomObject]) {
    $map = [Collections.Specialized.OrderedDictionary]::new([StringComparer]::Ordinal)
    foreach ($property in $Value.PSObject.Properties) {
      if ($map.Contains($property.Name)) {
        throw "Environment config contains duplicate object key '$($property.Name)'"
      }
      $map.Add(
        $property.Name,
        (ConvertTo-EnvironmentConfigValue -Value $property.Value)
      )
    }
    return ,$map
  }

  if ($Value -is [Collections.IEnumerable] -and $Value -isnot [string]) {
    $items = [Collections.Generic.List[object]]::new()
    foreach ($item in $Value) {
      $items.Add((ConvertTo-EnvironmentConfigValue -Value $item))
    }
    return ,([object[]]$items.ToArray())
  }

  $Value
}

function Read-EnvironmentConfigFile {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$Path
  )

  $parsed = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  ConvertTo-EnvironmentConfigValue -Value $parsed
}
