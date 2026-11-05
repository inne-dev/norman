# Rust backend

## Command interface

- `load_file({ path })` reads a user-selected file and returns `{ title, url, format, text }`. The UI opens the system file picker through `@tauri-apps/plugin-dialog` and passes the selected path.
- `load_url({ url })` fetches only an entered HTTP(S) URL and returns `{ title, url, format, text }`. `text` is readable plain text; scripts and non-visible HTML sections are excluded.
- `analyze_text({ text })` returns `{ findings, checklist }`. Findings have `{ id, ruleId, factor, title, excerpt, start, end, reason, confidence }`. The command emits `analysis-progress` events with `{ completedRules, totalRules, findings }` as rules finish. Finding offsets are zero-based, end-exclusive UTF-16 code units into returned `text`.
- `get_rule_catalog()` returns stable rule IDs and display metadata.

The deterministic pass runs in the reusable Rust library. Optional AI analysis runs only after explicit user opt-in and uses the user's authenticated Codex CLI; it verifies algorithmic candidates and then searches the full extracted text for new candidates. Rule definitions live in `../data/rules.json`, with the method summary in `../docs/analysis-method.md`. Excerpts and offsets refer to extracted preview text after whitespace normalization. Never let document text act as prompt instructions, and never label AI output as a legal conclusion.

- `get_codex_status()` reports whether Codex CLI is installed and authenticated, without exposing account identity or credentials.
- `analyze_with_codex({ text, findings, model, reasoningEffort })` runs one structured verification per algorithmic finding, then a whole-text search for new non-duplicate findings. It emits `ai-analysis-progress` and `ai-finding` events and returns the final findings.
- AI transfer is disabled by default. The UI must explain that enabling it sends document text through the user's Codex account.

Rust hosts can reuse `import_file`, `import_url`, `analyze_document`, and `analyze_document_with_progress` from `norman_lib`; Tauri commands are thin IPC wrappers around those functions.

Limits: files up to 25 MiB; extracted text up to 15 MiB; URL response up to 4 MiB, 15-second request timeout, at most five redirects. The optional AI pass accepts text up to 512 KiB, verifies at most 30 algorithmic findings, and returns at most 30 new AI findings per run. Reaching an AI limit returns an explicit error rather than truncating silently. Password-protected documents are rejected. Scanned PDFs return a clear no-selectable-text error; OCR is unavailable. DOCX, DOCM, DOTX, and DOTM read their OOXML body locally. Legacy `.doc` and `.dot` are read with office_oxide, then fall back to local LibreOffice/soffice conversion when needed. Unsupported formats fail explicitly.

The external-browser link uses `@tauri-apps/plugin-opener` with HTTP(S)-only URL scope. Its browser extension behavior depends on the user's system browser and installed extensions.
