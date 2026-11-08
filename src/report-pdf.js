import pdfMake from 'pdfmake/build/pdfmake.js';
import pdfFonts from 'pdfmake/build/vfs_fonts.js';
import { isRejectedFinding } from './finding-confidence.js';

const REPORT_NOTE = 'Сформировано программой «Норман АЭ». Не является экспертным заключением.';

pdfMake.vfs = pdfFonts;
pdfMake.fonts = {
  Roboto: {
    normal: 'Roboto-Regular.ttf',
    bold: 'Roboto-Medium.ttf',
    italics: 'Roboto-Italic.ttf',
    bolditalics: 'Roboto-MediumItalic.ttf',
  },
};

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

function reportRows(documentData, findings) {
  if (!findings.length) {
    return [[
      {
        text: 'Для этого документа сигналы не сохранены.',
        colSpan: 4,
        alignment: 'center',
        color: '#53636c',
      },
      {},
      {},
      {},
    ]];
  }

  return findings.map((finding) => [
    locationFromText(documentData.text || '', finding),
    excerptFrom(documentData, finding),
    [
      { text: `${textValue(finding.ruleId, 'ID правила не указан')}\n`, style: 'ruleId' },
      textValue(finding.factor || finding.title, 'Фактор не указан'),
    ],
    textValue(finding.aiRationale),
  ]);
}

function reportDefinition(documentData, findings) {
  const title = textValue(documentData.title, 'Документ без названия');
  const source = textValue(documentData.url, 'Источник: локальный документ');
  const created = new Date().toLocaleString('ru-RU');

  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [28, 30, 28, 36],
    info: {
      title: `Отчёт Норман АЭ — ${title}`,
      author: 'Норман АЭ',
      subject: 'Результаты первичного анализа',
    },
    defaultStyle: {
      font: 'Roboto',
      fontSize: 8,
      lineHeight: 1.25,
      color: '#1d2830',
    },
    content: [
      { text: title, style: 'title' },
      { text: source, style: 'meta' },
      { text: `Отчёт подготовлен: ${created} · Сигналов: ${findings.length}`, style: 'meta' },
      { text: REPORT_NOTE, style: 'note' },
      {
        table: {
          headerRows: 1,
          widths: [90, 170, 120, 340],
          body: [
            [
              'Местоположение в акте',
              'Точная цитата',
              'Фактор / ID правила',
              'Обоснование ИИ',
            ].map((text) => ({ text, style: 'tableHeader' })),
            ...reportRows(documentData, findings),
          ],
        },
        layout: {
          hLineColor: () => '#c8d2d7',
          vLineColor: () => '#c8d2d7',
          hLineWidth: () => 0.6,
          vLineWidth: () => 0.6,
          paddingLeft: () => 5,
          paddingRight: () => 5,
          paddingTop: () => 5,
          paddingBottom: () => 5,
          fillColor: (rowIndex) => (rowIndex === 0 ? '#eaf0f2' : null),
        },
      },
    ],
    styles: {
      title: { fontSize: 17, bold: true, margin: [0, 0, 0, 5] },
      meta: { fontSize: 8, color: '#53636c', margin: [0, 2, 0, 0], characterSpacing: 0.05 },
      note: { fontSize: 8, bold: true, fillColor: '#f4f7f8', margin: [0, 10, 0, 10] },
      tableHeader: { fontSize: 8, bold: true, color: '#26353d' },
      ruleId: { fontSize: 7, bold: true, color: '#53636c' },
    },
    footer: (currentPage, pageCount) => ({
      text: `${currentPage} / ${pageCount}`,
      alignment: 'right',
      margin: [0, 8, 28, 0],
      fontSize: 7,
      color: '#53636c',
    }),
  };
}

function reportFileName(title) {
  const safeTitle = textValue(title, 'Документ')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_ -]/gu, '')
    .trim()
    .replace(/\s+/gu, '-')
    .slice(0, 80);
  return `Отчёт-Норман-АЭ-${safeTitle || 'Документ'}.pdf`;
}

/** Build a PDF buffer. The caller chooses the native or browser download destination. */
export async function generateReportPdf(documentData, findings = []) {
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
  const buffer = await new Promise((resolve, reject) => {
    try {
      pdfMake.createPdf(reportDefinition(safeDocument, safeFindings)).getBuffer(resolve);
    } catch (error) {
      reject(error);
    }
  });
  const bytes = new Uint8Array(buffer);
  return {
    bytes,
    fileName: reportFileName(safeDocument.title),
  };
}

export function downloadReportPdf(bytes, fileName) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
