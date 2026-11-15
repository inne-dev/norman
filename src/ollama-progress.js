const STALL_TIMEOUT_MS = 5000;

export function estimateRemainingSeconds({ total, completed, now, status, layer, previous }) {
  if (status === 'reconnecting' || !Number.isFinite(total) || total <= 0
    || !Number.isFinite(completed) || completed < 0) {
    return { seconds: null, next: null };
  }

  const changedLayer = previous && (layer !== previous.layer || completed < previous.completed || total !== previous.total);
  const baseline = changedLayer ? null : previous;
  if (!baseline) return { seconds: null, next: { total, completed, now, layer } };
  if (completed <= baseline.completed) {
    return { seconds: null, next: baseline };
  }
  if (now <= baseline.now) return { seconds: null, next: { total, completed, now, layer } };
  const elapsed = now - baseline.now;
  if (elapsed > STALL_TIMEOUT_MS) return { seconds: null, next: { total, completed, now, layer } };
  const bytesPerSecond = (completed - baseline.completed) / (elapsed / 1000);
  const seconds = bytesPerSecond > 0 ? Math.max(0, (total - completed) / bytesPerSecond) : null;
  return { seconds: Number.isFinite(seconds) ? seconds : null, next: { total, completed, now, layer } };
}

export function formatRemainingTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Время неизвестно';
  const minutes = Math.ceil(seconds / 60);
  return `Файл: ~${Math.max(1, minutes)} мин.`;
}

export function renderOllamaProgressFeedback(header, dialog, update) {
  const { percent, eta } = update;
  if ('percent' in update) {
    for (const target of [header, dialog]) {
      target.progress.hidden = false;
      if (Number.isFinite(percent)) target.progress.value = percent;
      else target.progress.removeAttribute('value');
    }
    header.percent.textContent = Number.isFinite(percent) ? `${Math.floor(percent)}%` : '';
  }
  if ('eta' in update) {
    header.eta.textContent = eta;
    dialog.eta.textContent = eta;
  }
}
