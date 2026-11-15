import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme, savedThemePreference } from '../src/ui-state.js';
import { estimateRemainingSeconds, formatRemainingTime, renderOllamaProgressFeedback } from '../src/ollama-progress.js';
import { recommendationForMemory } from '../src/ollama-recommendations.js';
import { memoryGiB } from '../src/ui-state.js';

test('theme defaults to system and explicit choices override it', () => {
  assert.equal(savedThemePreference(null), 'system');
  assert.equal(savedThemePreference('light'), 'light');
  assert.equal(savedThemePreference('dark'), 'dark');
  assert.equal(resolveTheme('system', 'light'), 'light');
  assert.equal(resolveTheme('system', 'dark'), 'dark');
  assert.equal(resolveTheme('light', 'dark'), 'light');
});

test('RAM display and recommendation thresholds use binary GiB', () => {
  const sixteenGiB = 16 * 1024 ** 3;
  assert.equal(Math.round(memoryGiB(sixteenGiB)), 16);
  assert.equal(recommendationForMemory(sixteenGiB).minRamGb, 16);
  assert.equal(recommendationForMemory(16_000_000_000).minRamGb, 8);
});

test('download ETA uses byte rate and resets across layers, reconnects and stalls', () => {
  const first = estimateRemainingSeconds({ total: 1000, completed: 100, now: 1000, layer: 'a' });
  const next = estimateRemainingSeconds({ total: 1000, completed: 300, now: 3000, layer: 'a', previous: first.next });
  assert.equal(next.seconds, 7);
  assert.equal(formatRemainingTime(next.seconds), 'Файл: ~1 мин.');
  const reset = estimateRemainingSeconds({ total: 1000, completed: 50, now: 4000, layer: 'b', previous: next.next });
  assert.equal(reset.seconds, null);
  const resumed = estimateRemainingSeconds({ total: 1000, completed: 150, now: 5000, layer: 'b', previous: reset.next });
  assert.equal(resumed.seconds, 8.5);
  const stalled = estimateRemainingSeconds({ total: 1000, completed: 150, now: 12000, layer: 'b', previous: resumed.next });
  assert.equal(stalled.seconds, null);
  const reconnecting = estimateRemainingSeconds({ total: 1000, completed: 160, now: 13000, status: 'reconnecting', layer: 'b', previous: stalled.next });
  assert.equal(reconnecting.seconds, null);
});

test('progress and ETA stay current after dismissing and reopening setup dialog', () => {
  const progress = () => ({ value: 0, removeAttribute(name) { if (name === 'value') this.value = null; } });
  const header = { progress: progress(), percent: { textContent: '' }, eta: { textContent: '' } };
  const dialog = { open: true, progress: progress(), eta: { textContent: '' } };
  renderOllamaProgressFeedback(header, dialog, { percent: 30, eta: 'Файл: ~2 мин.' });
  dialog.open = false;
  renderOllamaProgressFeedback(header, dialog, { percent: 65, eta: 'Файл: ~1 мин.' });
  assert.equal(header.percent.textContent, '65%');
  dialog.open = true;
  assert.equal(dialog.progress.value, 65);
  assert.equal(dialog.eta.textContent, 'Файл: ~1 мин.');
});
