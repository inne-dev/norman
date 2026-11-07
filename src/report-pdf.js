import { isRejectedFinding } from './finding-confidence.js';

const REPORT_NOTE = 'Сформировано программой «Норман АЭ». Не является экспертным заключением.';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function textValue(value, fallback = 'Не указано') {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function isValidRange(text, finding) {
  return Number.isInteger(finding?.start)
    && Number.isInteger(finding?.end)
    && finding.start >= 0
    && finding.end > finding.start
    && finding.end <= text.length;
}

function locationFromText(text, finding) {
  if (typeof finding.location === 'string' && finding.location.trim()) return finding.location;
  if (typeof finding.actLocation === 'string' && finding.actLocation.trim()) return finding.actLocation;
  if (!isValidRange(text, finding)) return 'Местоположение не определено';

  const prefix = text.slice(0, finding.start);
  const articles = Array.from(prefix.matchAll(/Статья\s+(\d+(?:\.\d+)?)/giu));
  const parts = Array.from(prefix.matchAll(/(?:^|\n)\s*(\d{1,3})\.\s/gu));
  const article = articles.length ? articles[articles.length - 1][1] : '';
  const partMatch = parts.length ? parts[parts.length - 1] : null;
  let clauseStart = text.lastIndexOf('\n', finding.start) + 1;

  if (partMatch) {
    const matchText = partMatch[0];
    clauseStart = partMatch.index + matchText.lastIndexOf('\n') + 1;
  }

  const locator = [];
  if (article) locator.push(`Ст. ${article}`);
  if (partMatch) locator.push(`ч. ${partMatch[1]}`);
  if (article || partMatch) {
    const first = Math.max(1, finding.start - clauseStart + 1);
    const last = Math.max(first, finding.end - clauseStart);
    locator.push(`фрагмент ${first}–${last}`);
  } else {
    locator.push(`симв. ${finding.start + 1}–${finding.end}`);
  }
  return locator.join(' · ');
}

function excerptFrom(documentData, finding) {
  if (typeof finding.excerpt === 'string' && finding.excerpt.length) return finding.excerpt;
  if (isValidRange(documentData.text || '', finding)) {
    return documentData.text.slice(finding.start, finding.end);
  }
  return 'Точная цитата не сохранена';
}

function proposalFrom(finding) {
  return textValue(
    finding.expertProposal
      || finding.expert_proposal
      || finding.proposal
      || finding.recommendation,
  );
}

function reportRows(documentData, findings) {
  if (!findings.length) {
    return '<tr><td class="empty" colspan="5">Для этого документа сигналы не сохранены.</td></tr>';
  }

  return findings.map((finding) => {
    const ruleId = textValue(finding.ruleId, 'ID правила не указан');
    const factor = textValue(finding.factor || finding.title, 'Фактор не указан');
    return `<tr>
      <td>${escapeHtml(locationFromText(documentData.text || '', finding))}</td>
      <td class="excerpt">${escapeHtml(excerptFrom(documentData, finding))}</td>
      <td><span class="rule-id">${escapeHtml(ruleId)}</span>${escapeHtml(factor)}</td>
      <td>${escapeHtml(textValue(finding.aiRationale))}</td>
      <td>${escapeHtml(proposalFrom(finding))}</td>
    </tr>`;
  }).join('');
}

function reportHtml(documentData, findings) {
  const title = textValue(documentData.title, 'Документ без названия');
  const source = textValue(documentData.url, 'Источник: локальный документ');
  const created = new Date().toLocaleString('ru-RU');

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Отчёт Норман АЭ — ${escapeHtml(title)}</title>
  <style>
    @page { size: A4 landscape; margin: 12mm; }
    * { box-sizing: border-box; }
    html { color-scheme: light; }
    body { margin: 0; color: #1d2830; background: #fff; font: 10pt/1.42 Arial, "Helvetica Neue", sans-serif; }
    main { max-width: 1600px; margin: 0 auto; padding: 22px; }
    h1 { margin: 0 0 5px; font-size: 19pt; line-height: 1.2; font-weight: 650; }
    .source, .created { margin: 3px 0; color: #53636c; font-size: 9pt; overflow-wrap: anywhere; }
    .note { margin: 15px 0 12px; padding: 8px 10px; border: 1px solid #c8d2d7; background: #f4f7f8; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    col.location { width: 15%; }
    col.excerpt { width: 27%; }
    col.factor { width: 18%; }
    col.rationale { width: 21%; }
    col.proposal { width: 19%; }
    thead { display: table-header-group; }
    th, td { padding: 7px; border: 1px solid #c8d2d7; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { background: #eaf0f2; color: #26353d; font-size: 8.5pt; font-weight: 700; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    .excerpt { white-space: pre-wrap; }
    .rule-id { display: block; margin-bottom: 3px; color: #53636c; font-size: 8pt; font-weight: 700; }
    .empty { padding: 18px; text-align: center; color: #53636c; }
    @media screen {
      body { background: #e9edef; }
      main { min-height: 100vh; background: #fff; box-shadow: 0 2px 18px #17232a18; }
    }
    @media print {
      body { font-size: 8.5pt; }
      main { max-width: none; padding: 0; }
      th, td { padding: 5px; }
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p class="source">${escapeHtml(source)}</p>
    <p class="created">Отчёт подготовлен: ${escapeHtml(created)} · Сигналов: ${findings.length}</p>
    <p class="note">${REPORT_NOTE}</p>
    <table aria-label="Таблица сигналов первичного анализа">
      <colgroup><col class="location"><col class="excerpt"><col class="factor"><col class="rationale"><col class="proposal"></colgroup>
      <thead><tr>
        <th scope="col">Местоположение в акте</th>
        <th scope="col">Точная цитата</th>
        <th scope="col">Фактор / ID правила</th>
        <th scope="col">Обоснование ИИ</th>
        <th scope="col">Предложение эксперту</th>
      </tr></thead>
      <tbody>${reportRows(documentData, findings)}</tbody>
    </table>
  </main>
</body>
</html>`;
}

/** Open native print dialog; choose “Save as PDF” to export the report. */
export function generateReportPdf(documentData, findings = []) {
  if (!documentData || typeof documentData !== 'object') {
    throw new TypeError('Для отчёта нужен объект документа.');
  }
  if (!Array.isArray(findings)) {
    throw new TypeError('Список сигналов должен быть массивом.');
  }
  const safeDocument = {
    title: textValue(documentData.title, 'Документ без названия'),
    url: typeof documentData.url === 'string' ? documentData.url : '',
    text: typeof documentData.text === 'string' ? documentData.text : '',
  };
  const safeFindings = findings.filter((finding) => (
    finding && typeof finding === 'object' && !isRejectedFinding(finding)
  ));
  const reportWindow = window.open('', '_blank');
  if (!reportWindow) throw new Error('Не удалось открыть отчёт. Разрешите новое окно и повторите экспорт.');

  reportWindow.opener = null;
  reportWindow.document.open();
  reportWindow.document.write(reportHtml(safeDocument, safeFindings));
  reportWindow.document.close();
  reportWindow.focus();
  reportWindow.setTimeout(() => reportWindow.print(), 250);
  return reportWindow;
}
