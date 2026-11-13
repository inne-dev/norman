# Windows download warnings

## Findings

The released v0.1.3-beta.8 NSIS installer is unsigned. Its SHA-256 matches the GitHub release digest. A VirusTotal scan reported 2/71 detections (DeepInstinct and SecureAge); Microsoft reported Undetected. No exact Microsoft Defender block or detection name was reproduced, so the cause of the reported block remains unconfirmed. These results do not establish that detections are false positives or guarantee future builds will have zero detections.

SmartScreen reputation warnings and Microsoft Defender Antivirus detections are different behaviors. Microsoft says SmartScreen considers publisher and file-hash reputation; signing does not guarantee a new download avoids a warning. [Microsoft: SmartScreen reputation for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)

## Build gate

The Packages workflow runs on relevant pull requests, manual dispatch, and pushed tags. Pull requests build macOS, Windows, and Linux packages but never publish a release. Windows CI runs the locked Rust test suite before packaging, then updates Defender intelligence and scans the app executable and NSIS installer on the hosted runner. Missing or disabled Defender, update errors, scan errors/detections, and Authenticode statuses other than `NotSigned` or `Valid` fail the Windows job. Unsigned releases are allowed; code signing and certificate secrets are outside this workflow's scope.

The `norman-windows-security-evidence` artifact records Defender versions and state, scan output, Authenticode status, and SHA-256 hashes. GitHub releases include `SHA256SUMS.txt`. Evidence is diagnostic: a passing runner scan does not reproduce browser download behavior or establish how another user's Defender, SmartScreen, enterprise policy, or third-party antivirus will classify a file.

The workflow uses an explicit on-demand Defender scan because GitHub's Windows runner image disables real-time monitoring and adds path exclusions. The scan uses `MpCmdRun.exe -Scan -ScanType 3 -DisableRemediation`; Microsoft documents the [command-line scanner](https://learn.microsoft.com/en-us/defender-endpoint/command-line-arguments-microsoft-defender-antivirus) and its custom file scans. The CI gate does not change protection settings or add exclusions.

## Local gate tests

Run `pwsh -NoProfile -File scripts/test-windows-release-evidence.ps1` to exercise the evidence gate with mocked Windows APIs and scanner results. Tests cover unsigned and validly signed files, invalid signatures, detections, unavailable protection, update errors, and missing files. Windows CI also runs these cases; they do not replace the actual package scan.

For a reported block, collect the exact product/UI, detection name, Windows version, source URL, and affected file SHA-256. Do not ask users to disable protection or add exclusions. A suspected Microsoft Defender false positive can be submitted through [Microsoft Security Intelligence file submission](https://www.microsoft.com/en-us/wdsi/filesubmission); Microsoft decides the outcome.
