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
  return isAiFinding(finding) ? aiConfidenceLevel(finding.aiConfidence) : 'possible';
}

export function isRejectedFinding(finding) {
  return findingConfidenceLevel(finding) === 'likely-false';
}
