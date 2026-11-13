# Windows download warnings

## What is known

The Windows package workflow currently builds an NSIS installer. The downloaded v0.1.3-beta.8 installer has no embedded Authenticode signature: its PE certificate-table offset and size are both zero. Its locally calculated SHA-256 matches the GitHub release digest. For example, the `norman-0.1.3-beta.8-windows-x64-setup.exe` asset had SHA-256 `5c6e3d8eff8b293d2b174d861344ed0109f1ffe32f99c5f7508eae5c06c6443c`.

A report that Windows “blocked” a download does not identify which Windows feature acted. SmartScreen reputation warnings and Microsoft Defender Antivirus detections are separate behaviors. The reporter identified the v0.1.3-beta.8 installer, but provided no exact detection name or Defender history entry, so the cause of the reported block is unconfirmed. The macOS build host cannot reproduce Windows Defender behavior.

Microsoft says SmartScreen considers both publisher and file-hash reputation. An unsigned new build starts without publisher reputation; signing provides a verified publisher identity, but does not guarantee that a new download avoids a SmartScreen prompt. EV certificates no longer bypass that reputation process. [Microsoft: SmartScreen reputation for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)

## VirusTotal check, 2026-11-13

The exact public release file was downloaded, its SHA-256 verified, and submitted to VirusTotal after a hash lookup returned no existing report. The completed analysis reported **2/71** detections: DeepInstinct (`MALICIOUS`) and SecureAge (`Malicious`). Microsoft reported **Undetected**. [VirusTotal file report](https://www.virustotal.com/gui/file/5c6e3d8eff8b293d2b174d861344ed0109f1ffe32f99c5f7508eae5c06c6443c)

This does not reproduce a Defender Antivirus detection, establish SmartScreen reputation, prove the file harmless, or establish that the two detections are false positives. The generic labels do not identify a confirmed code-level cause. Investigate vendor feedback using the exact hash and file before changing runtime behavior to chase heuristic results. New builds require their own checks.

## Release safeguards

The Windows workflow can sign the app executable and NSIS installer using Authenticode and SHA-256 file digests with a timestamp. Signing is optional until the project maintainer provisions a code-signing certificate. Without both secrets, packages remain unsigned. If only one secret is configured, or signing is configured but fails, the Windows release job fails instead of silently publishing a partially signed package. CI writes a temporary Tauri config with the imported certificate thumbprint. Tauri uses Windows SDK SignTool to sign the app and installer with SHA-256 and an RFC 3161 timestamp. Signing credentials are imported for the job and removed in an `always()` cleanup step.

The current CI integration imports a PFX with a private key. This is a limited integration path, not a recommendation for obtaining a new public certificate. Modern public code-signing providers normally keep private keys on a token or HSM, so their keys cannot be exported to this secret. Token/HSM or managed signing requires a provider-specific integration or a suitably provisioned Windows signing runner. Select a provider and confirm eligibility before configuring CI. See [issuance restrictions for a Russia-resident individual](windows-signing-russia.md).

For a certificate whose private key is legitimately available as an importable PFX, add repository or environment secrets:

- `WINDOWS_CERTIFICATE`: base64-encoded PFX bytes, without `certutil`'s BEGIN/END text wrapper.
- `WINDOWS_CERTIFICATE_PASSWORD`: PFX export password.

The certificate must be valid for code signing and contain its private key. The CI runner installs it into the current-user certificate store. Tauri invokes its built-in signing support for bundle executables; the Windows evidence step then requires valid signatures on both the app executable and installer. Tauri's Windows signing configuration supports SHA-256 digests and RFC 3161 timestamping. [Tauri: Windows code signing](https://v2.tauri.app/distribute/sign/windows/)

Before packaging evidence, the workflow updates Microsoft Defender security intelligence, checks that the Defender antivirus service is enabled, and runs a custom scan on the unpacked application executable and NSIS installer. Missing Defender, disabled protection, update failures, scan errors, detections, or invalid configured signatures fail the Windows package job. A separate `norman-windows-security-evidence` workflow artifact records scanner versions, scan output, signatures, signer identity, and file SHA-256 hashes. Release assets also include `SHA256SUMS.txt`; the evidence JSON is not published as an installer or attached to the release.

GitHub's Windows runner image configuration disables real-time monitoring and adds broad path exclusions. The release gate therefore runs an explicit on-demand scan, records the real-time protection state, and does not depend on background scanning. This is not a reproduction of a Windows browser download. [GitHub runner image configuration](https://github.com/actions/runner-images/blob/main/images/windows/scripts/build/Configure-WindowsDefender.ps1)

The custom scan uses `-DisableRemediation`: it scans archives and ignores file exclusions without changing protection settings. Microsoft documents that these detections appear in command output, rather than the event log. Nonzero scan results stop publication.

Defender's command-line scanner is `MpCmdRun.exe`; Microsoft documents custom file scans and signature updates. [Microsoft: MpCmdRun command-line tool](https://learn.microsoft.com/en-us/defender-endpoint/command-line-arguments-microsoft-defender-antivirus)

## Limits and reporting

- Authenticode signing can improve publisher trust and preserve reputation across releases, but cannot guarantee SmartScreen silence or prevent a third-party antivirus detection.
- The CI scan checks Microsoft Defender on the Windows hosted runner, at the time the package is built. It cannot reproduce every user's policy, Defender cloud result, or third-party antivirus engine.
- The evidence is diagnostic, not a Microsoft clean bill of health. A passing local scan does not establish that a user report is false positive.
- Windows' SmartScreen UI, Defender Antivirus quarantine/history, enterprise policy, and third-party AV can all produce different blocks. Ask the reporter for the exact product/UI, detection name, Windows version, source URL, and the affected file's SHA-256. Do not ask users to disable protection or add exclusions.
- For a suspected Microsoft Defender false positive, submit the exact file as a software developer through [Microsoft Security Intelligence file submission](https://www.microsoft.com/en-us/wdsi/filesubmission), and include the detection name and scan context. Microsoft accepts files reported as incorrectly classified; submission outcome is Microsoft's decision.

## Maintainer setup

The signing secrets above are optional. Keep the same publisher identity for releases where possible. A Windows release job requires a Windows-hosted GitHub Actions runner with Defender cmdlets and `MpCmdRun.exe` available and the antivirus service enabled. If the hosted image does not meet these requirements, the job stops; use a suitable Windows runner rather than skipping the scan. Review the `norman-windows-security-evidence` artifact for each workflow run. This project does not currently ship a Microsoft Store package, EV/OV certificate, or an independently reproduced SmartScreen reputation result.

## Verification

Run `pwsh -NoProfile -File scripts/test-windows-release-evidence.ps1` to check the gate with mocked Windows APIs and scanner results. It covers clean files, required signatures, signer mismatch, detections, unavailable protection, update errors, and missing files. These tests also run on Windows CI; they do not replace the actual package scan.

Prepared vendor review requests are in [windows-vendor-review-requests.md](windows-vendor-review-requests.md). They have not been sent.
