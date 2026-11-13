param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$AppPath,
  [Parameter(Mandatory = $true)][string]$EvidencePath
)

$ErrorActionPreference = 'Stop'
$signedBuild = -not [string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_THUMBPRINT)
$metadata = [ordered]@{
  generatedUtc = [DateTime]::UtcNow.ToString('o')
  signingConfigured = $signedBuild
  defender = $null
  files = @()
}

try {
  $paths = @((Resolve-Path $AppPath).Path, (Resolve-Path $InstallerPath).Path)
  $status = Get-MpComputerStatus -ErrorAction Stop
  if (-not $status.AMServiceEnabled -or -not $status.AntivirusEnabled) {
    throw 'Microsoft Defender Antivirus is unavailable or disabled on this runner.'
  }
  $mpCmd = @(
    "$env:ProgramData\Microsoft\Windows Defender\Platform\*\MpCmdRun.exe",
    "$env:ProgramFiles\Windows Defender\MpCmdRun.exe"
  ) | ForEach-Object { Get-ChildItem $_ -ErrorAction SilentlyContinue } | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
  if (-not $mpCmd) { throw 'MpCmdRun.exe was not found.' }

  $updateOutput = & $mpCmd -SignatureUpdate 2>&1
  $updateExitCode = $LASTEXITCODE
  if ($updateExitCode -ne 0) { throw "Defender signature update failed ($updateExitCode): $($updateOutput -join ' ')" }
  $status = Get-MpComputerStatus -ErrorAction Stop
  $metadata.defender = [ordered]@{
    platformVersion = $status.AMProductVersion
    engineVersion = $status.AMEngineVersion
    realTimeProtectionEnabled = $status.RealTimeProtectionEnabled
    securityIntelligenceVersion = $status.AntivirusSignatureVersion
    securityIntelligenceUpdatedUtc = $status.AntivirusSignatureLastUpdated.ToUniversalTime().ToString('o')
  }

  foreach ($path in $paths) {
    $signature = Get-AuthenticodeSignature -FilePath $path
    if ($signedBuild -and $signature.Status -ne 'Valid') {
      throw "Expected a valid Authenticode signature for $path; got $($signature.Status)."
    }
    if ($signedBuild -and $signature.SignerCertificate.Thumbprint -ne $env:WINDOWS_CERTIFICATE_THUMBPRINT) {
      throw "Unexpected signing certificate for $path."
    }
    if (-not $signedBuild -and $signature.Status -notin @('NotSigned', 'Valid')) {
      throw "Unexpected Authenticode status for $path`: $($signature.Status)."
    }

    $scanOutput = & $mpCmd -Scan -ScanType 3 -File $path -DisableRemediation 2>&1
    $scanExitCode = $LASTEXITCODE

    $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $path
    $metadata.files += [ordered]@{
      name = [IO.Path]::GetFileName($path)
      sha256 = $hash.Hash.ToLowerInvariant()
      signatureStatus = $signature.Status.ToString()
      signer = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
      scanExitCode = $scanExitCode
      scanOutput = ($scanOutput | ForEach-Object { "$($_)" }) -join "`n"
    }
    if ($scanExitCode -ne 0) { throw "Defender scan failed for $path ($scanExitCode): $($scanOutput -join ' ')" }
  }

  $metadata.defender.scannedUtc = [DateTime]::UtcNow.ToString('o')
} catch {
  $metadata.failure = $_.Exception.Message
  throw
} finally {
  $metadata | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $EvidencePath -Encoding utf8
  Write-Host "Windows release evidence written to $EvidencePath"
}
