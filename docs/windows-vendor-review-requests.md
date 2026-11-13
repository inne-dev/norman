# Requests to review suspected false positives

Prepared 2026-11-13. These drafts have **not been sent**. The sender must supply their own name and reply address. The request asks for review; it does not claim that a vendor has confirmed a false positive.

VirusTotal instructs developers to dispute detections with each detecting vendor. VirusTotal cannot remove vendor verdicts itself. [Official instructions](https://docs.virustotal.com/docs/false-positive)

## SecureAge

Use the **False Positive** section on the [official contact page](https://www.secureage.com/contact-us). SecureAge recommends compressing submitted samples. [Submission instructions](https://knowledgebase.secureage.com/secureaplus/en-us/Content/technical-information/reporting-false-positives-to-secureaplus.htm)

Subject: Suspected false positive: Norman v0.1.3-beta.8 Windows NSIS installer

Hello SecureAge analysis team,

Please review a suspected false positive for our public Windows desktop application, Norman. On 13 November 2026 your VirusTotal engine reported `Malicious` for the installer identified below.

Norman is a Tauri/Rust desktop application for local first-pass review of legal documents. Its deterministic analysis runs locally. Optional AI integrations contact a provider selected by the user; optional model setup can download and run Ollama's installer following the user's setup action. The distributed Windows installer is an unsigned NSIS package.

File: norman-0.1.3-beta.8-windows-x64-setup.exe
SHA-256: 5c6e3d8eff8b293d2b174d861344ed0109f1ffe32f99c5f7508eae5c06c6443c
Download: https://github.com/inne-dev/norman/releases/download/v0.1.3-beta.8/norman-0.1.3-beta.8-windows-x64-setup.exe
Source repository: https://github.com/inne-dev/norman
VirusTotal: https://www.virustotal.com/gui/file/5c6e3d8eff8b293d2b174d861344ed0109f1ffe32f99c5f7508eae5c06c6443c

The completed VirusTotal scan reported two detections out of 71 engines; Microsoft reported Undetected. We understand that this does not establish that your detection is incorrect.

Please reassess this exact sample. If a security issue or unwanted behavior causes the detection, please provide the affected component and actionable technical details so we can fix it. If you determine it is a false positive, please correct the engine verdict and let us know when to reanalyze the file.

Thank you.

## Deep Instinct

Use the false-positive contact listed through [VirusTotal's false-positive contacts directory](https://docs.virustotal.com/docs/false-positive-contacts), or request routing through the [official Deep Instinct contact page](https://www.deepinstinct.com/contact-us). Verify the destination before sending; no specialized public submission endpoint has been independently confirmed on the vendor's own site.

Use the same draft above, replacing the addressee with “Deep Instinct analysis team” and the detection name with `MALICIOUS`.

## After vendor responses

Retain the case IDs and the exact file hash. Reanalyze the same file after the vendors confirm a correction. A rebuilt or signed installer has a different hash and must be checked separately. Do not change the executable solely to hide the current detection or promise a permanent 0/71 result.
