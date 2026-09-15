function Assert-BrowserPasskeyEnvironment([string]$Module, [string]$ExpectedRpId) {
  # Inspect only public build configuration. Never request a credential or inspect account storage.
  # Vite may put application statements immediately after the assignment on the same line.
  $assignments = [regex]::Matches($Module, '(?m)^import\.meta\.env\s*=\s*(\{[^\r\n]*?\})\s*;')
  if ($assignments.Count -ne 1) {
    throw 'OpenChat entry module must expose exactly one Vite environment assignment for passkey readiness'
  }
  $environment = $assignments[0].Groups[1].Value | ConvertFrom-Json
  $property = $environment.PSObject.Properties['OC_WEBAUTHN_ORIGIN']
  if ($null -eq $property -or $property.Value -isnot [string] -or
      [string]::IsNullOrWhiteSpace($ExpectedRpId) -or $property.Value -cne $ExpectedRpId) {
    throw 'OpenChat browser passkey RP ID does not match the configured phone-facing hostname'
  }
}
