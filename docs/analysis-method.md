# Algorithmic review method

This note maps the supplied review algorithm to checks that a first release can perform without AI. It is a search aid, not a legal opinion. The source algorithm is the attached DOCX "Алгоритм проведения антикоррупционной экспертизы с признаками нарушений норм права". Its worked example is the attached conclusion about part 12 of article 162 of the Housing Code.

## Checks the application can perform

| Source step or factor | First-release behavior |
| --- | --- |
| Structure, document form, sections | Extract headings, numbered clauses, article references, and visible document title. |
| Issuing authority, date, publication, subject, addressee | Show extracted candidates when present. Report missing or uncertain values as review prompts, never verified facts. |
| High-risk regulatory areas | Match a small, editable vocabulary for tax, procurement, antimonopoly, bankruptcy, advertising, customs, and currency-control language. |
| Broad discretion | Flag phrases such as "вправе", "по усмотрению", and "может" as possible discretion signals. Context matters, so every hit needs human review. |
| Selective exceptions | Flag phrases such as "в исключительных случаях", "как правило", "за исключением", and "в отдельных случаях". |
| Subordinate-rule references | Flag open references such as "в установленном порядке" or "согласно установленным правилам" when the source does not identify the rule in the same clause. |
| Incomplete administrative procedure | Detect explicit procedure markers and missing dates only as checklist prompts; text search cannot establish that a procedure is absent from related acts. |
| Noncompetitive allocation | Flag mentions of a sole supplier or grant of a right without a competition, especially near funding or procurement terms. |
| Elevated or unclear requirements | Flag vague, difficult-to-verify, or burdensome terms such as "иные документы", "разумный срок", and "при наличии достаточных оснований". |
| Legal-linguistic uncertainty | Flag vague terms, residual categories ("иные", "прочие"), discretionary verbs, and undefined terms as candidate issues. |
| Competence, delegated lawmaking, gaps, collisions, responsibility, effect over time | Provide explicit human-review checklist items. A single document cannot reliably establish these facts without linked source acts and legal context. |
| Sequence, language, clarity, enforceability | Offer cautious wording and structure signals. Do not label grammatical or legal defects conclusively. |

## Rule output

Every hit must retain the exact excerpt, character range, rule ID, factor name, short reason, and a conservative confidence label. Multiple rules may point to the same phrase. Findings must link to the source text so a reviewer can inspect context.

The example conclusion identifies "При этом договором управления многоквартирным домом может быть предусмотрено иное распределение полученной управляющей организацией экономии" as a candidate for discretionary authority and undefined requirements. This phrase is the acceptance example for the rule catalog.

## Limits

- A keyword hit does not prove a corruption factor exists.
- Absence of a keyword does not prove a provision is safe.
- Issuing authority, publication, competence, validity, cross-act conflicts, and missing procedural elements require external evidence or expert review.
- Scanned PDFs and unsupported formats need an extraction error or a clearly marked local-converter requirement. Never return an empty analysis as if parsing succeeded.
- The first release does not call an AI service.
