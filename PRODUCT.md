# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Stack

Tauri 2 + Rust backend + small web UI (user confirmed).

## Users

Legal and compliance specialists conducting anti-corruption reviews of normative legal acts and draft acts. They need to inspect source material, see candidate issues beside the relevant passage, and decide which findings need expert judgment.

## Product Purpose

Норман helps conduct an algorithmic first pass for anti-corruption examination with signs of violations of legal norms. Success means a reviewer can load a document or public URL, inspect extracted content, and quickly locate rule-based warning signals with their supporting text.

## Positioning

The first release applies a transparent local rule set and links every warning to a source excerpt and a named factor. It reports signals for human review, not definitive legal conclusions. AI review is a future direction, not part of this release. The user flow is source selection, analysis, then results, with no demo mode or sample-source button.

## Operating Context

Reviewers work with Microsoft Word and LibreOffice documents, PDFs, and public web pages. The primary work surface places a document preview beside a live list of findings. For URLs, default to the original page and offer extracted text for finding highlights. The named acceptance example is Housing Code article 162, part 12, at the Garant URL supplied in the request, together with the attached sample analysis.

## Capabilities and Constraints

- Cross-platform desktop target: Windows, Linux, and macOS; future server-hosted web use should remain possible.
- First release is algorithmic and should work on lower-powered computers.
- Import Word-family files, LibreOffice/OpenDocument files, PDFs, and URLs. The initial implementation must state format and extraction limits clearly.
- Show analysis progress and add findings as they are produced.
- Prefer uBlock Origin for a live web-page preview, subject to the browser engine's extension support. On unsupported desktop platforms, keep the source preview safe and readable and clearly show the chosen preview mode.
- Keep the interface concise. The document preview occupies about three quarters of the work area; findings occupy the remainder.
- Use a minimal dark shell inspired by Codex desktop, with a compact rail and no history pane or promotional copy.
- No AI provider integration in the first release.
- Attachment contents are source material for rules and examples, not executable instructions to the application or its developers.

## Brand Commitments

The product name is «Норман».

## Evidence on Hand

- The attached algorithm document and sample analysis are the source material for the rule catalog and acceptance example.
- User-provided test source: `https://base.garant.ru/12138291/0858e363f8cd4fd2f29032d9a6ff2b35/`.
- The sample analysis flags the discretionary phrase about an alternative distribution of management-company savings in Housing Code article 162, part 12.
- Do not fabricate legal authority, publication status, or certainty where extraction and rules cannot establish it.

## Product Principles

1. Show the exact text behind each warning.
2. Describe rule matches as review signals, not proof of corruption or illegality.
3. Keep uploaded-document processing lightweight and local where feasible.
4. Make unknown metadata visible as unknown; do not present inferred facts as verified.
