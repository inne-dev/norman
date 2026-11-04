import catalog from '../data/rules.json';

const MAX_TEXT_BYTES = 15 * 1024 * 1024;
const MAX_FINDINGS = 500;
const MAX_FINDINGS_PER_RULE = 40;
const WORD = '[\\p{L}\\p{N}\\p{M}\\p{Pc}\\u200C\\u200D]';

function compilePattern(pattern) {
  let source = pattern;
  if (source.startsWith('\\b')) source = `(?<!${WORD})${source.slice(2)}`;
  if (source.endsWith('\\b')) source = `${source.slice(0, -2)}(?!${WORD})`;
  if (source.includes('\\b')) throw new Error('Каталог правил содержит неподдерживаемую границу слова.');
  return new RegExp(source, 'giu');
}

function compareFindings(left, right) {
  return left.start - right.start || left.end - right.end || left.ruleId.localeCompare(right.ruleId);
}

self.onmessage = ({ data }) => {
  try {
    const { text } = data;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Нет текста для анализа.');
    if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) throw new Error('Текст превышает лимит 15 МБ.');
    if (catalog.version !== 1 || !Array.isArray(catalog.rules) || !catalog.rules.length) {
      throw new Error('Не удалось загрузить каталог правил.');
    }

    const findings = [];
    const totalRules = catalog.rules.length;
    for (let index = 0; index < totalRules; index += 1) {
      const rule = catalog.rules[index];
      const added = [];
      const seen = new Set();
      if (findings.length < MAX_FINDINGS) {
        for (const source of rule.patterns) {
          const pattern = compilePattern(source);
          for (const match of text.matchAll(pattern)) {
            const start = match.index;
            const end = start + match[0].length;
            const key = `${start}:${end}`;
            if (!seen.has(key)) {
              seen.add(key);
              added.push({
                id: `${rule.id}:${start}:${end}`,
                ruleId: rule.id,
                factor: rule.factor,
                title: rule.title,
                excerpt: match[0],
                start,
                end,
                reason: rule.reason,
                confidence: rule.confidence,
              });
              if (added.length >= MAX_FINDINGS_PER_RULE || findings.length + added.length >= MAX_FINDINGS) break;
            }
          }
          if (added.length >= MAX_FINDINGS_PER_RULE || findings.length + added.length >= MAX_FINDINGS) break;
        }
      }
      findings.push(...added);
      self.postMessage({
        type: 'progress',
        progress: {
          completedRules: index + 1,
          totalRules,
          findings: added.sort(compareFindings),
        },
      });
    }

    self.postMessage({
      type: 'result',
      result: {
        findings: findings.sort(compareFindings),
        checklist: [
          'Проверьте орган издания и его полномочия по первичному источнику.',
          'Проверьте дату вступления в силу и сведения об официальном опубликовании.',
          'Сопоставьте положения со связанными актами и проверьте компетенцию.',
          'Проверьте полноту процедуры с учетом связанных актов и материалов.',
        ],
      },
    });
  } catch (error) {
    self.postMessage({ type: 'error', error: error?.message || 'Не удалось выполнить анализ.' });
  }
};
