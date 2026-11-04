# Rust backend

## Command interface

- `load_file({ path })` reads a user-selected file and returns `{ title, url, format, text }`. The UI opens the system file picker through `@tauri-apps/plugin-dialog` and passes the selected path.
- `load_url({ url })` fetches only an entered HTTP(S) URL and returns `{ title, url, format, text }`. `text` is readable plain text; scripts and non-visible HTML sections are excluded.
- `analyze_text({ text })` returns `{ findings, checklist }`. Findings have `{ id, ruleId, factor, title, excerpt, start, end, reason, confidence }`. The command emits `analysis-progress` events with `{ completedRules, totalRules, findings }` as rules finish. Finding offsets are zero-based, end-exclusive UTF-16 code units into returned `text`.
- `get_rule_catalog()` returns stable rule IDs and display metadata.

All analysis runs in the reusable Rust library, with no AI or provider calls. Rule definitions live in `../data/rules.json`. Excerpts and offsets refer to extracted preview text after whitespace normalization.

Rust hosts can reuse `import_file`, `import_url`, `analyze_document`, and `analyze_document_with_progress` from `norman_lib`; Tauri commands are thin IPC wrappers around those functions.

Limits: files up to 25 MiB; extracted text up to 15 MiB; URL response up to 4 MiB, 15-second request timeout, at most five redirects. Password-protected documents are rejected. Scanned PDFs return a clear no-selectable-text error; OCR is unavailable. DOCX, DOCM, DOTX, and DOTM read their OOXML body locally. Legacy `.doc` and `.dot` are read with office_oxide, then fall back to local LibreOffice/soffice conversion when needed. Unsupported formats fail explicitly.

The external-browser link uses `@tauri-apps/plugin-opener` with HTTP(S)-only URL scope. Its browser extension behavior depends on the user's system browser and installed extensions.
