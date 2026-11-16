export function isAiFinding(finding) {
  const origin = String(finding?.origin || '').toLocaleLowerCase();
  const provider = String(finding?.aiProvider || '').toLocaleLowerCase();
  return origin === 'ai' || origin === 'codex' || origin === 'ollama'
    || provider === 'codex' || provider === 'ollama'
    || finding?.aiConfidence != null || finding?.aiRationale != null;
}

export function aiConfidenceLevel(value) {
  const confidence = String(value || '').toLocaleLowerCase().replace(/[ _]+/gu, '-');
  if (confidence === 'high' || confidence.includes('высок')) return 'high';
  if (confidence === 'medium' || confidence.includes('средн')) return 'medium';
  if (confidence === 'low' || confidence.includes('низк')) return 'low';
  if (['likely-false', 'likely-false-positive', 'false', 'false-positive-likely', 'вероятно-ложный'].includes(confidence)) {
    return 'likely-false';
  }
  return 'unknown';
}

export function findingConfidenceLevel(finding) {
  if (!isAiFinding(finding)) return 'possible';
  const confidence = aiConfidenceLevel(finding.aiConfidence);
  return confidence === 'likely-false' && !hasValidRejectionReason(finding) ? 'low' : confidence;
}

export function isRejectedFinding(finding) {
  return findingConfidenceLevel(finding) === 'likely-false';
}

function hasValidRejectionReason(finding) {
  if (finding?.aiError || finding?.aiErrorKind) return false;
  const rawReason = String(finding?.aiRejectionReason || '').trim().toLocaleLowerCase('ru-RU');
  const reason = rawReason
    .replace(/^(?:причина(?: отсева)?|reason)\s*:\s*/u, '')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .trim();
  return reason !== '' && ![
    'none', 'null', 'n/a', 'na', 'no reason', 'no reason provided', 'not provided', 'not specified',
    'нет', 'н/д', 'нд', 'пусто', 'нет причины', 'не указано', 'не указана', 'неизвестно',
    'отсутствует', 'причина отсутствует',
  ].includes(reason);
}
