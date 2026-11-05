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

function validateInput(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Нет текста для анализа.');
  if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) throw new Error('Текст превышает лимит 15 МБ.');
  if (catalog.version !== 1 || !Array.isArray(catalog.rules) || !catalog.rules.length) {
    throw new Error('Не удалось загрузить каталог правил.');
  }
}

function analyzeRule(text, rule, matchLimit) {
  const added = [];
  const seen = new Set();
  for (const source of rule.patterns) {
    const pattern = compilePattern(source);
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      const key = `${start}:${end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const finding = {
        id: `${rule.id}:${start}:${end}`,
        ruleId: rule.id,
        factor: rule.factor,
        title: rule.title,
        excerpt: match[0],
        start,
        end,
        reason: rule.reason,
        confidence: rule.confidence,
      };
      const overlapIndexes = [];
      for (let itemIndex = 0; itemIndex < added.length; itemIndex += 1) {
        if (start < added[itemIndex].end && added[itemIndex].start < end) overlapIndexes.push(itemIndex);
      }
      if (!overlapIndexes.length) added.push(finding);
      else {
        let longest = finding;
        for (const itemIndex of overlapIndexes) {
          if (added[itemIndex].excerpt.length > longest.excerpt.length) longest = added[itemIndex];
        }
        for (const itemIndex of overlapIndexes.reverse()) added.splice(itemIndex, 1);
        added.push(longest);
      }
      if (added.length >= matchLimit) break;
    }
    if (added.length >= matchLimit) break;
  }
  return added;
}

function createResult(findings) {
  return {
    findings: findings.sort(compareFindings),
    checklist: [
      'Проверьте орган издания и его полномочия по первичному источнику.',
      'Проверьте дату вступления в силу и сведения об официальном опубликовании.',
      'Сопоставьте положения со связанными актами и проверьте компетенцию.',
      'Проверьте полноту процедуры с учетом связанных актов и материалов.',
    ],
  };
}

let activeText = null;

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      validateInput(data.text);
      activeText = data.text;
      self.postMessage({
        type: 'ready',
        totalRules: catalog.rules.length,
        maxFindings: MAX_FINDINGS,
        maxFindingsPerRule: MAX_FINDINGS_PER_RULE,
      });
      return;
    }

    if (data.type === 'scan-rule') {
      if (activeText === null) throw new Error('Рабочий поток не инициализирован.');
      if (!Number.isInteger(data.ruleIndex) || data.ruleIndex < 0 || data.ruleIndex >= catalog.rules.length) {
        throw new Error('Получен неверный индекс правила.');
      }
      const matchLimit = Number.isInteger(data.matchLimit)
        ? Math.max(0, Math.min(MAX_FINDINGS_PER_RULE, data.matchLimit))
        : MAX_FINDINGS_PER_RULE;
      const findings = matchLimit ? analyzeRule(activeText, catalog.rules[data.ruleIndex], matchLimit) : [];
      self.postMessage({ type: 'rule-result', ruleIndex: data.ruleIndex, findings });
      return;
    }

    validateInput(data.text);
    const findings = [];
    const totalRules = catalog.rules.length;
    for (let index = 0; index < totalRules; index += 1) {
      const matchLimit = Math.min(MAX_FINDINGS_PER_RULE, MAX_FINDINGS - findings.length);
      const added = matchLimit ? analyzeRule(data.text, catalog.rules[index], matchLimit) : [];
      findings.push(...added);
      self.postMessage({
        type: 'progress',
        progress: { completedRules: index + 1, totalRules, findings: added.sort(compareFindings) },
      });
    }
    self.postMessage({ type: 'result', result: createResult(findings) });
  } catch (error) {
    self.postMessage({ type: 'error', error: error?.message || 'Не удалось выполнить анализ.' });
  }
};
