$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$originalThumbprint = $env:WINDOWS_CERTIFICATE_THUMBPRINT
$evidenceScript = Join-Path $PSScriptRoot 'windows-release-evidence.ps1'
New-Item -ItemType Directory -Path $testRoot | Out-Null

# Mock only Windows APIs and the scanner; use real files, hashes, and JSON output.
function Get-MpComputerStatus {
  if ($testCase -eq 'status-error') { throw 'Status unavailable' }
  [pscustomobject]@{
    AMServiceEnabled = $testCase -ne 'disabled'
    AntivirusEnabled = $true
    RealTimeProtectionEnabled = $testCase -ne 'on-demand-only'
    AMProductVersion = 'test-platform'
    AMEngineVersion = 'test-engine'
    AntivirusSignatureVersion = 'test-signatures'
    AntivirusSignatureLastUpdated = [DateTime]::Now
  }
}
function Get-ChildItem {
  if ($testCase -ne 'missing-scanner') { [pscustomobject]@{ FullName = $fakeScanner } }
}
function Get-AuthenticodeSignature {
  [pscustomobject]@{
    Status = if ($testCase -in @('signed', 'wrong-signer')) { 'Valid' } else { 'NotSigned' }
    SignerCertificate = [pscustomobject]@{
      Subject = 'Test publisher'
      Thumbprint = if ($testCase -eq 'wrong-signer') { 'OTHER' } else { 'TEST' }
    }
  }
}

try {
  $fakeScanner = Join-Path $testRoot 'scanner.ps1'
  @'
if ($args -contains '-SignatureUpdate') {
  $global:LASTEXITCODE = if ($testCase -eq 'update-error') { 2 } else { 0 }
  'Signature update output'
} else {
  if ($args -notcontains '-DisableRemediation' -or $args -notcontains '-File' -or $args -notcontains '-ScanType' -or $args -notcontains 3) {
    throw 'Expected an explicit custom scan that ignores exclusions and scans archives'
  }
  $global:LASTEXITCODE = if ($testCase -eq 'detection') { 2 } else { 0 }
  'Scan output'
}
'@ | Set-Content $fakeScanner
  $app = Join-Path $testRoot 'app with spaces.exe'
  $installer = Join-Path $testRoot 'setup.exe'
  'app fixture' | Set-Content $app
  'installer fixture' | Set-Content $installer

  foreach ($testCase in @('unsigned', 'signed', 'on-demand-only', 'detection', 'disabled', 'status-error', 'missing-scanner', 'update-error', 'unsigned-when-required', 'wrong-signer', 'missing-app')) {
    $env:WINDOWS_CERTIFICATE_THUMBPRINT = if ($testCase -in @('signed', 'unsigned-when-required', 'wrong-signer')) { 'TEST' } else { '' }
    $reportPath = Join-Path $testRoot "$testCase.json"
    $appPath = if ($testCase -eq 'missing-app') { Join-Path $testRoot 'missing.exe' } else { $app }
    $failure = $null
    try {
      & $evidenceScript -InstallerPath $installer -AppPath $appPath -EvidencePath $reportPath
    } catch { $failure = $_ }
    $shouldPass = $testCase -in @('unsigned', 'signed', 'on-demand-only')
    if ($shouldPass -eq [bool]$failure) { throw "Unexpected result for ${testCase}: $failure" }
    $report = Get-Content $reportPath -Raw | ConvertFrom-Json
    if ($shouldPass) {
      if ($report.files.Count -ne 2 -or $report.files[0].sha256 -ne (Get-FileHash $app -Algorithm SHA256).Hash.ToLowerInvariant()) {
        throw "Missing file hashes for $testCase"
      }
      if (-not $report.defender.scannedUtc) { throw "Missing scan completion for $testCase" }
    } elseif (-not $report.failure) { throw "Missing failure evidence for $testCase" }
    if ($testCase -eq 'detection' -and ($report.files[0].scanExitCode -ne 2 -or $report.files[0].scanOutput -ne 'Scan output')) {
      throw 'Detection evidence was lost'
    }
    Write-Host "PASS $testCase"
  }
} finally {
  $env:WINDOWS_CERTIFICATE_THUMBPRINT = $originalThumbprint
  Remove-Item $testRoot -Recurse -Force
}
