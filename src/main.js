import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import './style.css';

const isTauri = Boolean(window.__TAURI_INTERNALS__);
const THEME_STORAGE_KEY = 'norman-color-theme';
const CODEX_STORAGE_KEY = 'norman-codex-settings';
const DEFAULT_CODEX_SETTINGS = Object.freeze({
  enabled: false,
  provider: 'codex',
  model: 'gpt-6-luna',
  reasoningEffort: 'high',
  filterAdsInPreview: true,
  parallelProcesses: 1,
});

const state = {
  screen: 'start',
  tabs: [],
  activeId: null,
  document: null,
  findings: [],
  selectedId: null,
  sourceLoading: false,
  analysis: 'idle',
  aiAnalysis: 'idle',
  aiAnalysisMessage: '',
  aiProgress: null,
  progress: null,
  loadError: '',
  analysisError: '',
  frameUrl: '',
  frameState: 'idle',
};

let nextTabId = 1;
let renderedTabsSignature = '';
let analysisQueue = Promise.resolve();
let sourceMarks = [];
let followedFindingId = null;
let sourceSyncFrame = 0;
let pageFrameSoftTimeout = 0;
let rejectedFindingsSection = null;
let rejectedFindingsList = null;
let rejectedFindingsCount = null;
let renderedFindingsOrderSignature = '';
let codexStatus = { checked: false, installed: false, authenticated: false, version: '', message: '' };
let codexStatusRequest = null;
let pageFrameDocumentRef = null;
let pageFrameBoundDocument = null;
let pageFrameLoadToken = 0;
let pageFrameFilterAds = null;
const findingDetailsAnimations = new WeakMap();

const ui = {
  tabBar: document.querySelector('#tabBar'),
  tabList: document.querySelector('#tabList'),
  startScreen: document.querySelector('#startScreen'),
  analysisScreen: document.querySelector('#analysisScreen'),
  openUrlDialog: document.querySelector('#openUrlDialog'),
  urlDialog: document.querySelector('#urlDialog'),
  closeUrlDialog: document.querySelector('#closeUrlDialog'),
  cancelUrlDialog: document.querySelector('#cancelUrlDialog'),
  urlForm: document.querySelector('#urlForm'),
  urlInput: document.querySelector('#urlInput'),
  urlSubmit: document.querySelector('#urlSubmit'),
  urlError: document.querySelector('#urlError'),
  openFileDialog: document.querySelector('#openFileDialog'),
  fileDialog: document.querySelector('#fileDialog'),
  closeFileDialog: document.querySelector('#closeFileDialog'),
  fileDropzone: document.querySelector('#fileDropzone'),
  openFilePicker: document.querySelector('#openFilePicker'),
  browserFileInput: document.querySelector('#browserFileInput'),
  fileError: document.querySelector('#fileError'),
  startLoading: document.querySelector('#startLoading'),
  errorBanner: document.querySelector('#errorBanner'),
  errorText: document.querySelector('#errorText'),
  dismissError: document.querySelector('#dismissError'),
  newDocument: document.querySelector('#newDocument'),
  openSettings: document.querySelector('#openSettings'),
  settingsDialog: document.querySelector('#settingsDialog'),
  closeSettings: document.querySelector('#closeSettings'),
  aiReviewDialog: document.querySelector('#aiReviewDialog'),
  closeAiReview: document.querySelector('#closeAiReview'),
  aiReviewMode: document.querySelector('#aiReviewMode'),
  aiReviewSourceName: document.querySelector('#aiReviewSourceName'),
  aiReviewRule: document.querySelector('#aiReviewRule'),
  aiReviewFactor: document.querySelector('#aiReviewFactor'),
  aiReviewRuleReason: document.querySelector('#aiReviewRuleReason'),
  aiReviewExcerpt: document.querySelector('#aiReviewExcerpt'),
  aiReviewContextLabel: document.querySelector('#aiReviewContextLabel'),
  aiReviewContext: document.querySelector('#aiReviewContext'),
  aiReviewDocumentDetails: document.querySelector('#aiReviewDocumentDetails'),
  aiReviewDocumentSummary: document.querySelector('#aiReviewDocumentSummary'),
  aiReviewDocumentText: document.querySelector('#aiReviewDocumentText'),
  aiReviewRationale: document.querySelector('#aiReviewRationale'),
  aiReviewResult: document.querySelector('#aiReviewResult'),
  aiReviewConfidenceMark: document.querySelector('#aiReviewConfidenceMark'),
  aiReviewConfidence: document.querySelector('#aiReviewConfidence'),
  aiReviewDecision: document.querySelector('#aiReviewDecision'),
  codexEnabled: document.querySelector('#codexEnabled'),
  filterAdsInPreview: document.querySelector('#filterAdsInPreview'),
  codexOptions: document.querySelector('#codexOptions'),
  codexProvider: document.querySelector('#codexProvider'),
  codexModel: document.querySelector('#codexModel'),
  codexReasoning: document.querySelector('#codexReasoning'),
  parallelProcesses: document.querySelector('#parallelProcesses'),
  codexStatus: document.querySelector('#codexStatus'),
  checkCodexStatus: document.querySelector('#checkCodexStatus'),
  openOriginal: document.querySelector('#openOriginal'),
  readerFrame: document.querySelector('#readerFrame'),
  pagePanel: document.querySelector('#pagePanel'),
  textPanel: document.querySelector('#textPanel'),
  pageFrame: document.querySelector('#pageFrame'),
  pageLoading: document.querySelector('#pageLoading'),
  pageError: document.querySelector('#pageError'),
  documentFormat: document.querySelector('#documentFormat'),
  documentTitle: document.querySelector('#documentTitle'),
  documentText: document.querySelector('#documentText'),
  resultCount: document.querySelector('#resultCount'),
  analysisStatus: document.querySelector('#analysisStatus'),
  analysisProgress: document.querySelector('#analysisProgress'),
  analysisProgressBar: document.querySelector('#analysisProgressBar'),
  analysisProgressFill: document.querySelector('#analysisProgressFill'),
  analysisProgressSteps: document.querySelector('#analysisProgressSteps'),
  findingsMessage: document.querySelector('#findingsMessage'),
  aiAnalysisNote: document.querySelector('#aiAnalysisNote'),
  retryAiAnalysis: document.querySelector('#retryAiAnalysis'),
  retryAnalysis: document.querySelector('#retryAnalysis'),
  findingList: document.querySelector('#findingList'),
};

function loadCodexSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(CODEX_STORAGE_KEY) || '{}');
    return {
      ...DEFAULT_CODEX_SETTINGS,
      ...saved,
      enabled: saved.enabled === true,
      filterAdsInPreview: saved.filterAdsInPreview !== false,
      provider: 'codex',
      model: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'].includes(saved.model)
        ? saved.model
        : DEFAULT_CODEX_SETTINGS.model,
      reasoningEffort: ['low', 'medium', 'high'].includes(saved.reasoningEffort)
        ? saved.reasoningEffort
        : DEFAULT_CODEX_SETTINGS.reasoningEffort,
      parallelProcesses: [1, 2, 3, 4].includes(Number(saved.parallelProcesses))
        ? Number(saved.parallelProcesses)
        : DEFAULT_CODEX_SETTINGS.parallelProcesses,
    };
  } catch {
    return { ...DEFAULT_CODEX_SETTINGS };
  }
}

const codexSettings = loadCodexSettings();

function saveCodexSettings() {
  try {
    localStorage.setItem(CODEX_STORAGE_KEY, JSON.stringify(codexSettings));
  } catch {
    // Settings still apply for this session when storage is unavailable.
  }
}

function syncCodexSettingsUI() {
  ui.codexEnabled.checked = codexSettings.enabled;
  ui.filterAdsInPreview.checked = codexSettings.filterAdsInPreview;
  ui.codexOptions.hidden = !codexSettings.enabled;
  ui.codexProvider.value = codexSettings.provider;
  ui.codexModel.value = codexSettings.model;
  ui.codexReasoning.value = codexSettings.reasoningEffort;
  ui.parallelProcesses.value = String(codexSettings.parallelProcesses);
  renderCodexStatus();
  renderAiAnalysisNote();
}

let sourceTargets = new Map();

function getSavedTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function setTheme(theme) {
  const selectedTheme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = selectedTheme;
  for (const input of ui.settingsDialog.querySelectorAll('input[name="theme"]')) {
    input.checked = input.value === selectedTheme;
  }

  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = selectedTheme === 'light' ? '#f4f6f8' : '#15191d';
  try {
    localStorage.setItem(THEME_STORAGE_KEY, selectedTheme);
  } catch {
    // The selected theme still applies for this session if storage is unavailable.
  }
}

setTheme(getSavedTheme());
syncCodexSettingsUI();

function setFollowedFinding(key, activeMark = null) {
  followedFindingId = key;
  for (const mark of sourceMarks) {
    mark.classList.toggle('is-followed', mark === activeMark);
    if (mark === activeMark) mark.setAttribute('aria-current', 'location');
    else mark.removeAttribute('aria-current');
  }
  for (const button of ui.findingList.querySelectorAll('[data-finding-id]')) {
    const isFollowed = button.dataset.findingId === key;
    button.classList.toggle('is-following-source', isFollowed);
    if (isFollowed) button.setAttribute('aria-current', 'location');
    else button.removeAttribute('aria-current');
  }
}

function keepFindingVisible(key) {
  if (!key) return;
  const panel = ui.findingList.parentElement;
  if (!panel) return;
  const button = panel.querySelector(`[data-finding-id="${CSS.escape(key)}"]`);
  if (!button) return;

  const rejectedSection = button.closest('details.rejected-findings');
  if (rejectedSection) rejectedSection.open = true;
  const item = button.closest('li') || button;
  const panelRect = panel.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const visibleTop = panelRect.top + panel.clientTop + 8;
  const visibleBottom = panelRect.top + panel.clientTop + panel.clientHeight - 8;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (itemRect.top < visibleTop) {
    panel.scrollTo({ top: panel.scrollTop - (visibleTop - itemRect.top), behavior: reducedMotion ? 'auto' : 'smooth' });
  } else if (itemRect.bottom > visibleBottom) {
    panel.scrollTo({ top: panel.scrollTop + (itemRect.bottom - visibleBottom), behavior: reducedMotion ? 'auto' : 'smooth' });
  }
}

function selectFinding(key, { scrollPreview = true } = {}) {
  if (!key || !state.findings.some((finding, index) => findingKey(finding, index) === key)) return;
  state.selectedId = key;
  render();
  keepFindingVisible(key);
  if (scrollPreview && state.document?.url) scrollPageFindingIntoView(key);
}

function syncFindingToSourceScroll() {
  if (ui.textPanel.hidden || !sourceMarks.length) {
    setFollowedFinding(null);
    return;
  }

  const panelRect = ui.textPanel.getBoundingClientRect();
  const center = panelRect.top + panelRect.height / 2;
  let closest = null;

  for (const mark of sourceMarks) {
    const rect = mark.getBoundingClientRect();
    if (rect.bottom <= panelRect.top || rect.top >= panelRect.bottom) continue;

    const visibleCenter = (Math.max(rect.top, panelRect.top) + Math.min(rect.bottom, panelRect.bottom)) / 2;
    const ids = mark.dataset.findingIds.split(' ');
    const key = ids.includes(state.selectedId) ? state.selectedId : ids[0];
    const distance = Math.abs(visibleCenter - center);
    if (key && (!closest || distance < closest.distance)) closest = { key, mark, distance };
  }

  setFollowedFinding(closest?.key || null, closest?.mark || null);
  keepFindingVisible(closest?.key);
}

function scheduleFindingToSourceScroll() {
  if (sourceSyncFrame) return;
  sourceSyncFrame = window.requestAnimationFrame(() => {
    sourceSyncFrame = 0;
    syncFindingToSourceScroll();
  });
}

function tabById(id) {
  return state.tabs.find((tab) => tab.id === id) || null;
}

function saveActiveTab() {
  const tab = tabById(state.activeId);
  if (!tab) return;
  tab.document = state.document;
  tab.findings = state.findings;
  tab.selectedId = state.selectedId;
  tab.analysis = state.analysis;
  tab.analysisError = state.analysisError;
  tab.progress = state.progress;
  tab.aiAnalysis = state.aiAnalysis;
  tab.aiAnalysisMessage = state.aiAnalysisMessage;
  tab.aiProgress = state.aiProgress;
}

function activateTab(tab) {
  state.activeId = tab.id;
  state.screen = 'analysis';
  state.document = tab.document;
  state.findings = tab.findings;
  state.selectedId = tab.selectedId;
  state.analysis = tab.analysis;
  state.analysisError = tab.analysisError;
  state.progress = tab.progress;
  state.aiAnalysis = tab.aiAnalysis || 'idle';
  state.aiAnalysisMessage = tab.aiAnalysisMessage || '';
  state.aiProgress = tab.aiProgress || null;
  clearPageFrame();
  state.loadError = '';
}

function createDocumentTab(document) {
  return {
    id: `document-${nextTabId++}`,
    document,
    findings: [],
    selectedId: null,
    analysis: 'idle',
    analysisError: '',
    analysisToken: 0,
    progress: null,
    aiAnalysis: 'idle',
    aiAnalysisMessage: '',
    aiProgress: null,
  };
}

function showUploadScreen() {
  state.activeId = null;
  state.screen = 'start';
  state.document = null;
  state.findings = [];
  state.selectedId = null;
  state.analysis = 'idle';
  state.analysisError = '';
  state.progress = null;
  state.loadError = '';
  state.frameUrl = '';
  state.frameState = 'idle';
  ui.urlInput.value = '';
}

function renderDocumentTabs() {
  ui.tabBar.hidden = state.tabs.length === 0;
  const signature = JSON.stringify({
    activeId: state.activeId,
    sourceLoading: state.sourceLoading,
    tabs: state.tabs.map((tab) => [tab.id, tab.document.title, tab.analysis]),
  });
  if (signature === renderedTabsSignature) return;
  renderedTabsSignature = signature;

  ui.tabList.replaceChildren(...state.tabs.map((tab) => {
    const title = tab.document.title || 'Документ';
    const item = document.createElement('div');
    item.className = tab.id === state.activeId ? 'app-tab is-active' : 'app-tab';
    item.setAttribute('role', 'presentation');

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'app-tab-select';
    select.dataset.selectTab = tab.id;
    select.setAttribute('role', 'tab');
    select.setAttribute('aria-selected', String(tab.id === state.activeId));
    select.setAttribute('aria-controls', 'analysisScreen');
    select.tabIndex = tab.id === state.activeId ? 0 : -1;
    select.textContent = title;
    select.title = tab.analysis === 'running' ? `${title} · Проверка выполняется` : title;
    select.disabled = state.sourceLoading;

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'app-tab-close';
    close.dataset.closeTab = tab.id;
    close.setAttribute('aria-label', `Закрыть вкладку «${title}»`);
    close.title = 'Закрыть вкладку';
    close.disabled = state.sourceLoading;
    close.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>';

    item.append(select, close);
    if (tab.analysis === 'running') {
      const indicator = document.createElement('span');
      indicator.className = 'app-tab-indicator';
      indicator.setAttribute('aria-hidden', 'true');
      item.prepend(indicator);
    }
    return item;
  }));
}

function startNewTab() {
  if (state.sourceLoading) return;
  saveActiveTab();
  showUploadScreen();
  render();
}

function focusDocumentTab(id) {
  const tabButton = Array.from(ui.tabList.querySelectorAll('[data-select-tab]'))
    .find((button) => button.dataset.selectTab === id);
  tabButton?.focus();
}

function selectDocumentTab(id) {
  if (state.sourceLoading || state.activeId === id) return;
  const tab = tabById(id);
  if (!tab) return;
  saveActiveTab();
  activateTab(tab);
  render();
  focusDocumentTab(id);
}

function closeDocumentTab(id) {
  if (state.sourceLoading) return;
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  if (state.activeId === id) saveActiveTab();
  const [closedTab] = state.tabs.splice(index, 1);
  closedTab.analysisToken += 1;

  if (state.activeId === id) {
    state.activeId = null;
    if (state.tabs.length) {
      activateTab(state.tabs[Math.min(index, state.tabs.length - 1)]);
    } else {
      showUploadScreen();
    }
  }
  render();
  if (state.activeId) focusDocumentTab(state.activeId);
  else ui.openUrlDialog.focus();
}

function messageFrom(error) {
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Неизвестная ошибка.';
  }
}

function findingKey(finding, index) {
  return String(finding.id || `${finding.ruleId || finding.origin || 'finding'}-${finding.start ?? 'na'}-${finding.end ?? index}`);
}

function sameFinding(left, right) {
  if (left.id && right.id && left.id === right.id) return true;
  return Number.isInteger(left.start)
    && Number.isInteger(left.end)
    && Boolean(left.ruleId)
    && left.start === right.start
    && left.end === right.end
    && String(left.ruleId || '') === String(right.ruleId || '');
}

function mergeFindings(existing, incoming) {
  const merged = [...existing];
  for (const finding of incoming) {
    if (!finding || typeof finding !== 'object') continue;
    const index = merged.findIndex((item) => sameFinding(item, finding));
    if (index >= 0) merged[index] = { ...merged[index], ...finding };
    else merged.push(finding);
  }
  merged.sort((left, right) => (left.start ?? Number.MAX_SAFE_INTEGER) - (right.start ?? Number.MAX_SAFE_INTEGER)
    || (left.end ?? Number.MAX_SAFE_INTEGER) - (right.end ?? Number.MAX_SAFE_INTEGER)
    || String(left.ruleId || '').localeCompare(String(right.ruleId || '')));
  return merged;
}

function appendFindings(findings, target = state) {
  target.findings = mergeFindings(target.findings, findings);
}

function isValidFinding(finding) {
  return Number.isInteger(finding.start)
    && Number.isInteger(finding.end)
    && finding.start >= 0
    && finding.end > finding.start
    && finding.end <= (state.document?.text.length || 0);
}

function articleAndPart(text, start, end) {
  const prefix = text.slice(0, start);
  const articles = Array.from(prefix.matchAll(/Статья\s+(\d+(?:\.\d+)?)/giu));
  const parts = Array.from(prefix.matchAll(/(?:^|\n)\s*(\d{1,3})\.\s/gu));
  const article = articles.length ? articles[articles.length - 1][1] : '';
  const partMatch = parts.length ? parts[parts.length - 1] : null;
  let clauseStart = text.lastIndexOf('\n', start) + 1;

  if (partMatch) {
    const matchText = partMatch[0];
    clauseStart = partMatch.index + (matchText.lastIndexOf('\n') + 1);
  }

  const locator = [];
  if (article) locator.push('Ст. ' + article);
  if (partMatch) locator.push('ч. ' + partMatch[1]);
  if (article || partMatch) {
    const first = Math.max(1, start - clauseStart + 1);
    const last = Math.max(first, end - clauseStart);
    locator.push('фрагмент ' + first + '–' + last);
  } else {
    locator.push('симв. ' + (start + 1) + '–' + end);
  }
  return locator.join(' · ');
}

function renderSourceText() {
  const text = state.document?.text || '';
  const ranges = state.findings
    .map((finding, index) => ({ finding, index, key: findingKey(finding, index) }))
    .filter(({ finding }) => isValidFinding(finding))
    .sort((left, right) => left.finding.start - right.finding.start || left.finding.end - right.finding.end);
  const boundaries = new Set([0, text.length]);

  for (const { finding } of ranges) {
    boundaries.add(finding.start);
    boundaries.add(finding.end);
  }

  const ordered = Array.from(boundaries).sort((left, right) => left - right);
  const fragment = document.createDocumentFragment();
  sourceTargets = new Map();
  sourceMarks = [];

  for (let index = 0; index < ordered.length - 1; index += 1) {
    const start = ordered[index];
    const end = ordered[index + 1];
    if (end <= start) continue;

    const active = ranges.filter(({ finding }) => finding.start < end && finding.end > start);
    if (!active.length) {
      fragment.append(document.createTextNode(text.slice(start, end)));
      continue;
    }

    const mark = document.createElement('mark');
    mark.className = 'source-hit';
    mark.tabIndex = -1;
    mark.dataset.findingIds = active.map(({ key }) => key).join(' ');
    mark.dataset.sourceStart = String(start);
    mark.textContent = text.slice(start, end);
    if (active.some(({ key }) => key === state.selectedId)) mark.classList.add('is-selected');
    sourceMarks.push(mark);
    for (const { key } of active) {
      if (!sourceTargets.has(key)) sourceTargets.set(key, mark);
    }
    fragment.append(mark);
  }

  ui.documentText.replaceChildren(fragment);
}

function renderControls() {
  const busy = state.sourceLoading || state.analysis === 'running';
  ui.openUrlDialog.disabled = busy;
  ui.openFileDialog.disabled = busy;
  ui.urlInput.disabled = busy;
  ui.urlSubmit.disabled = busy;
  ui.openFilePicker.disabled = busy;
  ui.startLoading.hidden = !state.sourceLoading;
  ui.newDocument.disabled = state.sourceLoading;
}

function renderError() {
  ui.errorBanner.hidden = !state.loadError;
  ui.errorText.textContent = state.loadError;
}

function renderDocument() {
  const doc = state.document;
  ui.startScreen.hidden = state.screen !== 'start';
  ui.analysisScreen.hidden = state.screen !== 'analysis';

  if (!doc || state.screen !== 'analysis') {
    sourceMarks = [];
    sourceTargets.clear();
    ui.readerFrame.classList.remove('is-page-preview');
    ui.pagePanel.hidden = true;
    ui.textPanel.hidden = true;
    clearPageFrame();
    return;
  }

  ui.documentTitle.textContent = doc.title || 'Документ без названия';
  ui.documentFormat.textContent = String(doc.format || 'ТЕКСТ').toUpperCase();
  const hasPage = Boolean(doc.url);
  ui.readerFrame.classList.toggle('is-page-preview', hasPage);
  ui.pagePanel.hidden = !hasPage;
  ui.textPanel.hidden = hasPage;
  if (hasPage) {
    sourceMarks = [];
    sourceTargets.clear();
    renderPageFrame(doc.url);
  } else {
    clearPageFrame();
    renderSourceText();
  }
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

const previewBlockTags = 'ADDRESS, ARTICLE, BLOCKQUOTE, BR, DD, DIV, DL, DT, FIELDSET, FIGCAPTION, FIGURE, FOOTER, FORM, H1, H2, H3, H4, H5, H6, HEADER, HR, LI, MAIN, NAV, OL, P, SECTION, TABLE, TBODY, TD, TFOOT, TH, THEAD, TR, UL';

function buildPagePreviewHtml(source, url, { filterAds = true } = {}) {
  if (typeof source !== 'string' || !source.trim()) return '';
  const parsed = new DOMParser().parseFromString(source, 'text/html');

  if (filterAds) {
    const adSelectors = [
      '.adsbygoogle',
      '[id^="google_ads"]',
      '[id^="div-gpt-ad"]',
      '[id*="yandex_rtb" i]',
      '[class*="yandex-rtb" i]',
      '[data-ad-slot]',
      '[data-google-query-id]',
      '[class~="advertisement" i]',
      '[id~="advertisement" i]',
      '[class~="advertising" i]',
      '[id~="advertising" i]',
      '[class*="ad-container" i]',
      '[id*="ad-container" i]',
      '[class*="ad-banner" i]',
      '[id*="ad-banner" i]',
      '[class*="reklama" i]',
      '[id*="reklama" i]',
      '[class*="реклама" i]',
      '[id*="реклама" i]',
    ].join(', ');
    parsed.querySelectorAll(adSelectors).forEach((element) => element.remove());
  }

  parsed.querySelectorAll('script, iframe, frame, frameset, object, embed, portal, template, [srcdoc], link[rel~="preload"]').forEach((element) => element.remove());
  parsed.querySelectorAll('meta[http-equiv], base').forEach((element) => element.remove());
  for (const element of parsed.querySelectorAll('*')) {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/iu.test(attribute.name) || ['ping', 'autofocus', 'srcdoc'].includes(attribute.name.toLowerCase())) {
        element.removeAttribute(attribute.name);
      }
    }
    for (const attribute of ['href', 'src', 'action', 'formaction', 'xlink:href']) {
      const value = element.getAttribute(attribute);
      if (value && /^\s*javascript:/iu.test(value)) element.removeAttribute(attribute);
    }
    if (element.hasAttribute('target')) element.removeAttribute('target');
  }

  for (const anchor of parsed.querySelectorAll('a[href]')) anchor.removeAttribute('href');

  const policy = parsed.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; form-action 'none'; base-uri http: https:; style-src 'unsafe-inline' http: https:; img-src data: blob: http: https:; font-src data: http: https:; media-src http: https:";
  const base = parsed.createElement('base');
  base.href = url;
  const highlightStyle = parsed.createElement('style');
  highlightStyle.textContent = [
    'mark.norman-source-finding { color: inherit !important; background: rgba(230, 201, 95, .38) !important; border-radius: .16em; box-decoration-break: clone; -webkit-box-decoration-break: clone; outline: 1px solid rgba(230, 201, 95, .9); text-decoration: underline; text-decoration-color: rgba(150, 118, 25, .9); text-decoration-style: dotted; scroll-margin-block-start: 5rem; cursor: pointer; }',
    'mark.norman-source-finding[data-confidence="high"] { background: rgba(231, 121, 112, .34) !important; outline-color: rgba(231, 121, 112, .9); text-decoration-color: #b7463d; }',
    'mark.norman-source-finding[data-confidence="medium"] { background: rgba(229, 160, 82, .36) !important; outline-color: rgba(229, 160, 82, .92); text-decoration-color: #a66320; }',
    'mark.norman-source-finding[data-confidence="low"], mark.norman-source-finding[data-confidence="possible"] { background: rgba(230, 201, 95, .38) !important; outline-color: rgba(230, 201, 95, .92); text-decoration-color: #967619; }',
    'mark.norman-source-finding[data-confidence="likely-false"] { background: rgba(154, 164, 170, .28) !important; outline-color: rgba(120, 130, 136, .86); text-decoration-color: #77838a; }',
    'mark.norman-source-finding.is-followed { outline-width: 2px; box-shadow: 0 0 0 2px rgba(20, 115, 230, .22); }',
  ].join('\n');
  parsed.head.prepend(policy, base);
  parsed.head.append(highlightStyle);
  return `<!doctype html>${parsed.documentElement.outerHTML}`;
}

const previewContentSelectors = [
  '#doc_content',
  '#document-content',
  '[itemprop="articleBody"]',
  '.document-content',
  'article',
  '[role="main"]',
  'main',
];
const previewIgnoredTextSelector = [
  'script', 'style', 'noscript', 'svg', 'template', 'iframe', 'object', 'embed',
  '[hidden]', '[aria-hidden="true"]', '.hide', '.hidden', '.invisible',
  '[style*="display:none" i]', '[style*="display: none" i]',
  '[style*="visibility:hidden" i]', '[style*="visibility: hidden" i]',
].join(', ');

function excerptOccurrenceAtOffset(text, excerpt, offset) {
  const needle = String(excerpt || '').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ru-RU');
  if (!needle) return 0;
  const prefix = String(text || '').slice(0, Math.max(0, offset)).replace(/\s+/gu, ' ').toLocaleLowerCase('ru-RU');
  let count = 0;
  let cursor = 0;
  while ((cursor = prefix.indexOf(needle, cursor)) >= 0) {
    count += 1;
    cursor += needle.length;
  }
  return count;
}

function findPreviewRange(sourceDocument, excerpt, occurrence = 0) {
  const needle = String(excerpt || '').replace(/\s+/gu, ' ').trim();
  if (!needle || !sourceDocument.body) return null;
  // Keep preview navigation in the same article region used by link analysis.
  const contentRoot = previewContentSelectors
    .map((selector) => sourceDocument.querySelector(selector))
    .find(Boolean)
    || sourceDocument.body;
  const walker = sourceDocument.createTreeWalker(contentRoot, NodeFilter.SHOW_TEXT);
  const segments = [];
  let previousBlock = null;
  let joined = '';
  let node;

  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest(previewIgnoredTextSelector)) continue;
    const block = parent.closest(previewBlockTags);
    const normalized = node.data.replace(/\s+/gu, ' ');
    if (!normalized.trim()) continue;
    if (joined && block !== previousBlock && !joined.endsWith(' ') && !normalized.startsWith(' ')) joined += ' ';
    const start = joined.length;
    joined += normalized;
    segments.push({ node, normalized, start, end: joined.length });
    previousBlock = block;
  }

  const haystack = joined.toLocaleLowerCase('ru-RU');
  const searchNeedle = needle.toLocaleLowerCase('ru-RU');
  let index = -1;
  let cursor = 0;
  for (let matchIndex = 0; matchIndex <= occurrence; matchIndex += 1) {
    index = haystack.indexOf(searchNeedle, cursor);
    if (index < 0) return null;
    cursor = index + searchNeedle.length;
  }
  const endIndex = index + needle.length;
  const startSegment = segments.find((segment) => index >= segment.start && index < segment.end);
  const endSegment = segments.find((segment) => endIndex > segment.start && endIndex <= segment.end);
  if (!startSegment || !endSegment) return null;

  function rawOffset(segment, normalizedOffset, atEnd = false) {
    const target = normalizedOffset - segment.start;
    let visibleIndex = 0;
    const text = segment.node.data;
    for (let offset = 0; offset < text.length;) {
      const character = String.fromCodePoint(text.codePointAt(offset));
      const width = character.length;
      if (/\s/u.test(character)) {
        let runEnd = offset + width;
        while (runEnd < text.length) {
          const next = String.fromCodePoint(text.codePointAt(runEnd));
          if (!/\s/u.test(next)) break;
          runEnd += next.length;
        }
        if (visibleIndex === target) return atEnd ? runEnd : offset;
        visibleIndex += 1;
        offset = runEnd;
      } else {
        if (visibleIndex === target) return offset;
        visibleIndex += width;
        offset += width;
      }
    }
    return text.length;
  }

  const range = sourceDocument.createRange();
  range.setStart(startSegment.node, rawOffset(startSegment, index));
  range.setEnd(endSegment.node, rawOffset(endSegment, endIndex, true));
  return range;
}

function syncPageFrameHighlights(sourceDocument = ui.pageFrame.contentDocument) {
  if (!sourceDocument?.body) return;
  const findingsByKey = new Map(state.findings.map((finding, index) => [findingKey(finding, index), finding]));
  const existingKeys = new Set();

  for (const mark of sourceDocument.querySelectorAll('mark.norman-source-finding[data-finding-id]')) {
    const key = mark.dataset.findingId;
    const finding = findingsByKey.get(key);
    if (!finding) {
      mark.replaceWith(...mark.childNodes);
      continue;
    }
    existingKeys.add(key);
    mark.dataset.confidence = findingConfidenceLevel(finding);
    mark.classList.toggle('is-followed', key === state.selectedId);
  }

  for (const [key, finding] of findingsByKey) {
    if (existingKeys.has(key) || !finding.excerpt) continue;
    const occurrence = excerptOccurrenceAtOffset(state.document?.text, finding.excerpt, finding.start);
    const range = findPreviewRange(sourceDocument, finding.excerpt, occurrence);
    if (!range) continue;

    const highlight = sourceDocument.createElement('mark');
    highlight.className = 'norman-source-finding';
    highlight.dataset.findingId = key;
    highlight.dataset.confidence = findingConfidenceLevel(finding);
    highlight.tabIndex = 0;
    highlight.setAttribute('role', 'button');
    highlight.setAttribute('aria-label', `Показать сигнал: ${finding.title || finding.ruleTitle || 'найденный фрагмент'}`);
    highlight.classList.toggle('is-followed', key === state.selectedId);
    highlight.append(range.extractContents());
    range.insertNode(highlight);
  }
}

function scrollPageFindingIntoView(key) {
  if (!key || pageFrameDocumentRef !== state.document) return;
  let sourceDocument;
  try {
    sourceDocument = ui.pageFrame.contentDocument;
  } catch {
    return;
  }
  if (!sourceDocument?.body) return;
  const mark = Array.from(sourceDocument.querySelectorAll('mark.norman-source-finding[data-finding-id]'))
    .find((candidate) => candidate.dataset.findingId === key);
  if (!mark) return;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  mark.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
}

function markPageFrameReady(url, documentRef, loadToken) {
  if (loadToken !== pageFrameLoadToken
    || state.document !== documentRef
    || pageFrameDocumentRef !== documentRef
    || state.frameUrl !== url
    || safeHttpUrl(state.document?.url) !== url) return;

  if (pageFrameSoftTimeout) window.clearTimeout(pageFrameSoftTimeout);
  pageFrameSoftTimeout = 0;
  state.frameState = 'loaded';
  ui.pageLoading.hidden = true;
  ui.pageError.hidden = true;
  ui.openOriginal.hidden = true;
  try {
    const sourceDocument = ui.pageFrame.contentDocument;
    if (!sourceDocument?.body) return;
    if (pageFrameBoundDocument !== sourceDocument) {
      pageFrameBoundDocument = sourceDocument;
      sourceDocument.addEventListener('click', (event) => {
        const mark = event.target?.closest?.('mark.norman-source-finding[data-finding-id]');
        if (mark) {
          event.preventDefault();
          selectFinding(mark.dataset.findingId, { scrollPreview: false });
          return;
        }
        if (event.target?.closest?.('a[href]')) event.preventDefault();
      });
      sourceDocument.addEventListener('keydown', (event) => {
        const mark = event.target?.closest?.('mark.norman-source-finding[data-finding-id]');
        if (!mark || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        selectFinding(mark.dataset.findingId, { scrollPreview: false });
      });
      sourceDocument.addEventListener('submit', (event) => event.preventDefault());
    }
    syncPageFrameHighlights(sourceDocument);
    if (state.selectedId) scrollPageFindingIntoView(state.selectedId);
  } catch {
    // The source snapshot stays visible even if the WebView blocks DOM access.
  }
}

function renderPageFrame(value) {
  const url = safeHttpUrl(value);
  if (!url) {
    state.frameUrl = '';
    pageFrameDocumentRef = null;
    state.frameState = 'error';
    ui.pageFrame.hidden = true;
    ui.pageLoading.hidden = true;
    ui.pageError.hidden = false;
    ui.openOriginal.hidden = !state.document?.url;
    return;
  }

  if (typeof state.document?.previewHtml !== 'string' || !state.document.previewHtml.trim()) {
    state.frameUrl = url;
    pageFrameDocumentRef = null;
    state.frameState = 'error';
    ui.pageFrame.hidden = true;
    ui.pageLoading.hidden = true;
    ui.pageError.hidden = false;
    ui.openOriginal.hidden = false;
    return;
  }

  if (state.frameUrl !== url
    || pageFrameDocumentRef !== state.document
    || pageFrameFilterAds !== codexSettings.filterAdsInPreview) {
    if (pageFrameSoftTimeout) window.clearTimeout(pageFrameSoftTimeout);
    state.frameUrl = url;
    pageFrameDocumentRef = state.document;
    pageFrameBoundDocument = null;
    pageFrameFilterAds = codexSettings.filterAdsInPreview;
    const loadToken = ++pageFrameLoadToken;
    state.frameState = 'loading';
    ui.pageFrame.title = state.document?.title || 'Исходная страница';
    ui.pageFrame.hidden = false;
    const parsed = new DOMParser().parseFromString(buildPagePreviewHtml(state.document.previewHtml, url, {
      filterAds: codexSettings.filterAdsInPreview,
    }), 'text/html');
    syncPageFrameHighlights(parsed);
    ui.pageFrame.srcdoc = `<!doctype html>${parsed.documentElement.outerHTML}`;
    pageFrameSoftTimeout = window.setTimeout(() => {
      if (state.frameState !== 'loading') return;
      markPageFrameReady(url, pageFrameDocumentRef, loadToken);
    }, 1400);
  } else if (state.frameState === 'loaded') {
    syncPageFrameHighlights();
  }

  ui.pageFrame.hidden = false;
  ui.pageLoading.hidden = state.frameState !== 'loading';
  ui.pageError.hidden = state.frameState !== 'error';
  ui.openOriginal.hidden = state.frameState !== 'error';
}

function clearPageFrame() {
  if (pageFrameSoftTimeout) window.clearTimeout(pageFrameSoftTimeout);
  pageFrameLoadToken += 1;
  pageFrameSoftTimeout = 0;
  if (ui.pageFrame.hasAttribute('src')) ui.pageFrame.removeAttribute('src');
  if (ui.pageFrame.hasAttribute('srcdoc')) ui.pageFrame.removeAttribute('srcdoc');
  ui.pageFrame.hidden = true;
  ui.pageLoading.hidden = true;
  ui.pageError.hidden = true;
  ui.openOriginal.hidden = true;
  state.frameUrl = '';
  state.frameState = 'idle';
  pageFrameDocumentRef = null;
  pageFrameBoundDocument = null;
  pageFrameFilterAds = null;
}

function pluralFindings(count) {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return count + ' сигналов';
  if (mod10 === 1) return count + ' сигнал';
  if (mod10 >= 2 && mod10 <= 4) return count + ' сигнала';
  return count + ' сигналов';
}

function renderCodexStatus() {
  const available = codexStatus.checked && codexPayloadIsAvailable(codexStatus) && !codexStatus.checking;
  ui.codexModel.disabled = !available;
  ui.codexReasoning.disabled = !available;
  if (codexStatus.checking) {
    ui.codexStatus.textContent = 'Проверяем доступность Codex…';
    ui.codexStatus.dataset.state = 'loading';
  } else if (!codexStatus.checked) {
    ui.codexStatus.textContent = isTauri
      ? 'Статус Codex ещё не проверен.'
      : 'Проверка идёт через адаптер Vite.';
    ui.codexStatus.dataset.state = 'idle';
  } else if (codexStatus.error) {
    ui.codexStatus.textContent = codexStatus.message || 'Не удалось проверить Codex.';
    ui.codexStatus.dataset.state = 'error';
  } else if (!codexStatus.installed) {
    ui.codexStatus.textContent = codexStatus.message || 'Codex CLI не найден.';
    ui.codexStatus.dataset.state = 'error';
  } else if (!codexStatus.authenticated) {
    ui.codexStatus.textContent = codexStatus.message || 'Войдите в Codex CLI.';
    ui.codexStatus.dataset.state = 'error';
  } else {
    const version = codexStatus.version ? ` · ${codexStatus.version}` : '';
    ui.codexStatus.textContent = codexStatus.message || `Codex подключён${version}.`;
    ui.codexStatus.dataset.state = 'ready';
  }
  ui.checkCodexStatus.disabled = Boolean(codexStatus.checking);
  ui.checkCodexStatus.textContent = codexStatus.checking ? 'Проверяем…' : 'Проверить';
}

async function refreshCodexStatus() {
  if (codexStatusRequest) return codexStatusRequest;
  codexStatus = { ...codexStatus, checking: true, error: false };
  renderCodexStatus();
  codexStatusRequest = (async () => {
    try {
      let result;
      if (isTauri) {
        result = await invoke('get_codex_status');
      } else {
        const response = await fetch('/__norman/codex/status', { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        result = await response.json();
      }
      codexStatus = {
        checked: true,
        installed: result?.installed === true,
        authenticated: result?.authenticated === true,
        version: String(result?.version || ''),
        message: String(result?.message || ''),
        checking: false,
        error: false,
      };
    } catch (error) {
      const detail = messageFrom(error);
      codexStatus = {
        checked: true,
        installed: false,
        authenticated: false,
        version: '',
        message: isTauri
          ? 'Не удалось проверить Codex. Повторите проверку.'
          : `Адаптер Codex недоступен в браузере разработки. Запустите приложение Норман или проверьте Vite-адаптер (${detail}).`,
        checking: false,
        error: true,
      };
    }
    renderCodexStatus();
    return codexStatus;
  })().finally(() => {
    codexStatusRequest = null;
  });
  return codexStatusRequest;
}

function renderAiAnalysisNote() {
  let message = '';
  if (state.aiAnalysis === 'error' || state.aiAnalysis === 'unavailable') message = state.aiAnalysisMessage;
  ui.aiAnalysisNote.textContent = message;
  ui.aiAnalysisNote.dataset.state = state.aiAnalysis;
  ui.aiAnalysisNote.hidden = !message;
  const retryable = state.aiAnalysis === 'error' || state.aiAnalysis === 'unavailable';
  const retrying = state.aiAnalysis === 'checking' || state.aiAnalysis === 'running';
  ui.retryAiAnalysis.hidden = state.analysis !== 'done' || (!retryable && !retrying);
  ui.retryAiAnalysis.disabled = retrying || !codexSettings.enabled;
}

function renderFindingsMessage() {
  ui.retryAnalysis.hidden = state.analysis !== 'error';

  if (state.analysis === 'error') {
    ui.findingsMessage.textContent = 'Не удалось выполнить локальную проверку. ' + state.analysisError;
  } else if (state.analysis === 'done' && !state.findings.length) {
    ui.findingsMessage.textContent = 'Совпадений не найдено. Это не подтверждает отсутствие вопросов для экспертной проверки.';
  } else {
    ui.findingsMessage.textContent = '';
  }
}

function renderProgress() {
  const codexBusy = state.aiAnalysis === 'checking' || state.aiAnalysis === 'running';
  ui.analysisStatus.hidden = state.analysis !== 'running' && !codexBusy;

  const showCodexProgress = codexSettings.enabled
    && Boolean(state.document)
    && state.analysis !== 'idle'
    && (state.analysis === 'running' || state.aiAnalysis !== 'idle');
  ui.analysisProgress.hidden = !showCodexProgress;
  if (ui.analysisProgress.hidden) return;

  const aiProgress = state.aiProgress || {};
  const phase = aiProgress.phase;
  const ruleProgress = state.progress || {};
  const completedRules = Number(ruleProgress.completedRules ?? ruleProgress.completed_rules);
  const totalRules = Number(ruleProgress.totalRules ?? ruleProgress.total_rules);
  const completed = Number(aiProgress.completed);
  const total = Number(aiProgress.total);
  const localDone = state.analysis === 'done' || state.aiAnalysis !== 'idle';
  const localStatus = localDone
    ? 'complete'
    : state.analysis === 'error' ? 'error' : state.analysis === 'running' ? 'running' : 'pending';
  const contextStatus = state.aiAnalysis === 'error' || state.aiAnalysis === 'unavailable'
    ? phase === 'discover' ? 'complete' : 'error'
    : state.aiAnalysis === 'done' || phase === 'discover'
      ? 'complete'
      : state.aiAnalysis === 'checking' || phase === 'verify' ? 'running' : 'pending';
  const globalStatus = state.aiAnalysis === 'done'
    ? 'complete'
    : state.aiAnalysis === 'error' || state.aiAnalysis === 'unavailable'
      ? phase === 'discover' ? 'error' : 'skipped'
      : phase === 'discover' ? 'running' : 'pending';
  const stages = [
    {
      label: 'Текст',
      description: 'Текст документа проверяется по локальному каталогу правил.',
      status: localStatus,
      progress: Number.isFinite(completedRules) && totalRules > 0 ? Math.min(1, completedRules / totalRules) : 0.05,
    },
    {
      label: 'Контекст',
      description: 'Проверяется контекст каждого найденного сигнала.',
      status: contextStatus,
      progress: Number.isFinite(completed) && total > 0 ? Math.min(1, completed / total) : state.aiAnalysis === 'checking' ? 0.03 : 0.05,
    },
    {
      label: 'Весь текст',
      description: 'Документ целиком проверяется на дополнительные сигналы.',
      status: globalStatus,
      progress: Number.isFinite(completed) && total > 0 ? Math.min(1, completed / total) : 0.05,
    },
  ];

  const terminal = (status) => status === 'complete' || status === 'error' || status === 'skipped';
  let fraction = stages.filter((stage) => terminal(stage.status)).length;
  const active = stages.find((stage) => stage.status === 'running');
  if (active) fraction += active.progress;
  const percentage = Math.round((fraction / stages.length) * 100);
  ui.analysisProgress.dataset.state = stages.every((stage) => stage.status === 'complete') ? 'complete' : 'running';
  ui.analysisProgressBar.setAttribute('aria-valuenow', String(percentage));
  ui.analysisProgressBar.setAttribute('aria-valuetext', `${percentage}%`);
  ui.analysisProgressFill.style.width = '100%';
  ui.analysisProgressFill.replaceChildren(...stages.map((stage) => {
    const segment = document.createElement('span');
    segment.className = 'analysis-progress-segment';
    segment.dataset.state = stage.status;
    segment.setAttribute('aria-hidden', 'true');
    return segment;
  }));
  const focusedStep = ui.analysisProgressSteps.contains(document.activeElement)
    ? Array.from(ui.analysisProgressSteps.children).indexOf(document.activeElement)
    : -1;
  const statusLabels = {
    complete: 'Завершено',
    running: 'Выполняется',
    pending: 'Ожидает',
    error: 'Ошибка',
    skipped: 'Пропущено',
  };
  ui.analysisProgressSteps.replaceChildren(...stages.map((stage, index) => {
    const item = document.createElement('li');
    item.className = 'analysis-step';
    item.dataset.state = stage.status;
    item.tabIndex = 0;
    item.setAttribute('aria-label', `${stage.label}: ${statusLabels[stage.status]}`);
    const tooltipId = `analysisStepTooltip${index + 1}`;
    item.setAttribute('aria-describedby', tooltipId);
    const mark = document.createElement('span');
    mark.className = 'analysis-step-mark';
    mark.setAttribute('aria-hidden', 'true');
    if (index < stages.length - 1) {
      mark.dataset.state = stage.status === 'complete' ? 'complete' : 'pending';
    } else {
      mark.hidden = true;
    }
    const label = document.createElement('span');
    label.className = 'analysis-step-label';
    label.textContent = stage.label;
    const tooltip = document.createElement('span');
    tooltip.className = 'analysis-step-tooltip';
    tooltip.id = tooltipId;
    tooltip.setAttribute('role', 'tooltip');
    tooltip.textContent = stage.description;
    item.append(mark, label, tooltip);
    return item;
  }));
  if (focusedStep >= 0) ui.analysisProgressSteps.children[focusedStep]?.focus({ preventScroll: true });
}

function isAiFinding(finding) {
  const origin = String(finding.origin || '').toLocaleLowerCase();
  return origin === 'ai' || origin === 'codex' || finding.aiConfidence != null || finding.aiRationale != null;
}

function aiConfidenceLevel(value) {
  const confidence = String(value || '').toLocaleLowerCase().replace(/[ _]+/gu, '-');
  if (confidence === 'high' || confidence.includes('высок')) return 'high';
  if (confidence === 'medium' || confidence.includes('средн')) return 'medium';
  if (confidence === 'low' || confidence.includes('низк')) return 'low';
  if (['likely-false', 'likely-false-positive', 'false', 'false-positive-likely', 'вероятно-ложный'].includes(confidence)) {
    return 'likely-false';
  }
  return 'unknown';
}

function aiConfidenceLabel(value) {
  return ({
    high: 'высокая',
    medium: 'средняя',
    low: 'низкая',
    'likely-false': 'вероятно ложный сигнал',
    unknown: 'не указана',
  })[aiConfidenceLevel(value)];
}

function findingConfidenceLevel(finding) {
  return isAiFinding(finding) ? aiConfidenceLevel(finding.aiConfidence) : 'possible';
}

function findingConfidenceMarker(confidence) {
  return ({ high: 'А', medium: 'Б', low: 'В', possible: 'В', 'likely-false': '×' })[confidence] || '?';
}

function findingRowData(finding) {
  const aiFinding = isAiFinding(finding);
  const fullTitle = finding.title || finding.factor || 'Возможный сигнал';
  const shortTitle = fullTitle
    .replace(/^Возможн(?:ое|ая)\s+/u, '')
    .replace(/^./u, (character) => character.toLocaleUpperCase('ru-RU'));
  const location = state.document && isValidFinding(finding)
    ? articleAndPart(state.document.text, finding.start, finding.end)
    : 'Источник';
  const rejectedByAi = aiConfidenceLevel(finding.aiConfidence) === 'likely-false';
  const rejectionReason = rejectedByAi
    ? String(finding.aiRejectionReason || finding.aiRationale || '').trim()
    : '';
  const reason = rejectionReason
    ? `Причина отсева: ${rejectionReason}`
    : (aiFinding && finding.aiRationale) || finding.reason || 'Совпадение правила требует проверки в контексте.';
  return {
    aiFinding,
    fullTitle,
    shortTitle,
    location,
    reason,
    confidence: findingConfidenceLevel(finding),
    origin: String(finding.origin || (finding.aiConfidence != null ? 'algorithm' : 'codex')).toLocaleLowerCase(),
    signature: JSON.stringify([
      fullTitle, location, finding.factor || '', finding.excerpt || '', reason,
      aiFinding, finding.confidence || '', finding.aiConfidence || '', finding.origin || '',
    ]),
  };
}

function findingContextWindow(finding, padding = 800) {
  const text = state.document?.text || '';
  if (!isValidFinding(finding) || text.slice(finding.start, finding.end) !== finding.excerpt) return finding.excerpt || '';

  let start = finding.start;
  let leftCount = 0;
  while (start > 0 && leftCount < padding) {
    start -= 1;
    const current = text.charCodeAt(start);
    if (current >= 0xdc00 && current <= 0xdfff && start > 0) {
      const previous = text.charCodeAt(start - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) start -= 1;
    }
    leftCount += 1;
  }

  let end = finding.end;
  let rightCount = 0;
  while (end < text.length && rightCount < padding) {
    const codePoint = text.codePointAt(end);
    end += codePoint > 0xffff ? 2 : 1;
    rightCount += 1;
  }
  return text.slice(start, end);
}

function aiReviewConfidenceLabel(value) {
  return ({
    high: 'Вероятнее всего нарушение',
    medium: 'Вероятно нарушение',
    low: 'Возможно нарушение',
    'likely-false': 'Сигнал отсеян',
    unknown: 'Уровень не указан',
  })[aiConfidenceLevel(value)];
}

function openAiReview(key) {
  const index = state.findings.findIndex((finding, itemIndex) => findingKey(finding, itemIndex) === key);
  if (index < 0) return;
  const finding = state.findings[index];
  const globalAnalysis = String(finding.origin || '').toLocaleLowerCase() === 'codex';
  const confidence = aiConfidenceLevel(finding.aiConfidence);
  const sourceText = state.document?.text || '';
  const documentTextLimit = 20_000;

  ui.aiReviewMode.textContent = globalAnalysis
    ? 'Глобальный анализ всего текста для поиска новых сигналов.'
    : 'Проверка найденного сигнала по фрагменту, контексту и правилу.';
  ui.aiReviewSourceName.textContent = state.document?.title || state.document?.url || 'Источник';
  ui.aiReviewRule.textContent = finding.ruleId || 'Не указано';
  ui.aiReviewFactor.textContent = finding.factor || 'Не указан';
  ui.aiReviewRuleReason.textContent = finding.reason || 'Не указано';
  ui.aiReviewExcerpt.textContent = finding.excerpt || 'Фрагмент не сохранён.';

  const context = globalAnalysis ? '' : findingContextWindow(finding);
  ui.aiReviewContextLabel.hidden = !context || context === finding.excerpt;
  ui.aiReviewContextLabel.textContent = 'Контекст источника (до 800 символов до и после фрагмента)';
  ui.aiReviewContext.hidden = !context || context === finding.excerpt;
  ui.aiReviewContext.textContent = context;

  ui.aiReviewDocumentDetails.hidden = !globalAnalysis || !sourceText;
  ui.aiReviewDocumentDetails.open = globalAnalysis;
  ui.aiReviewDocumentSummary.textContent = sourceText.length > documentTextLimit
    ? `Текст документа · показано ${documentTextLimit.toLocaleString('ru-RU')} из ${sourceText.length.toLocaleString('ru-RU')} символов`
    : `Текст документа · ${sourceText.length.toLocaleString('ru-RU')} символов`;
  ui.aiReviewDocumentText.textContent = sourceText.length > documentTextLimit
    ? `${sourceText.slice(0, documentTextLimit)}\n…`
    : sourceText;

  ui.aiReviewRationale.textContent = finding.aiRationale || 'Краткое обоснование не сохранено.';
  ui.aiReviewResult.dataset.confidence = confidence;
  ui.aiReviewConfidenceMark.textContent = findingConfidenceMarker(confidence);
  ui.aiReviewConfidence.textContent = aiReviewConfidenceLabel(finding.aiConfidence);
  ui.aiReviewDecision.textContent = confidence === 'likely-false'
    ? `Сигнал отсеян. ${finding.aiRejectionReason || ''}`.trim()
    : 'Сигнал оставлен для экспертной проверки.';
  ui.aiReviewDialog.showModal();
}

function findingAriaLabel(finding, data, verifyStatus) {
  return [
    data.fullTitle,
    data.location,
    `Уровень ${findingConfidenceMarker(data.confidence)}`,
    data.aiFinding ? `Уверенность Codex ${aiConfidenceLabel(finding.aiConfidence)}` : 'Возможно нарушение',
    verifyStatus === 'active' ? 'Проверяется' : verifyStatus === 'queued' ? 'В очереди' : '',
  ].filter(Boolean).join('. ');
}

function setFindingVerifyStatus(item, finding, data, verifyStatus) {
  const button = item.querySelector('.finding-summary');
  if (verifyStatus) item.dataset.verifyStatus = verifyStatus;
  else delete item.dataset.verifyStatus;
  button.setAttribute('aria-label', findingAriaLabel(finding, data, verifyStatus));
}

function setFindingDetailsExpanded(details, expanded) {
  const previousAnimation = findingDetailsAnimations.get(details);
  const wasHidden = details.hidden;
  const currentHeight = wasHidden ? 0 : details.getBoundingClientRect().height;
  const currentOpacity = wasHidden ? 0 : Number.parseFloat(window.getComputedStyle(details).opacity) || 1;
  previousAnimation?.cancel();
  findingDetailsAnimations.delete(details);

  details.inert = !expanded;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || typeof details.animate !== 'function') {
    details.hidden = !expanded;
    return;
  }

  if (expanded) details.hidden = false;
  const targetHeight = expanded ? details.getBoundingClientRect().height : 0;
  const animation = details.animate([
    { height: `${currentHeight}px`, opacity: currentOpacity, clipPath: 'inset(0 0 0)' },
    { height: `${targetHeight}px`, opacity: expanded ? 1 : 0, clipPath: expanded ? 'inset(0 0 0)' : 'inset(0 0 100%)' },
  ], {
    duration: expanded ? 220 : 150,
    easing: expanded ? 'cubic-bezier(0.2, 0.7, 0.2, 1)' : 'ease-in',
    fill: 'both',
  });
  findingDetailsAnimations.set(details, animation);
  animation.addEventListener('finish', () => {
    if (findingDetailsAnimations.get(details) !== animation) return;
    findingDetailsAnimations.delete(details);
    if (!expanded) details.hidden = true;
    animation.cancel();
  }, { once: true });
  animation.addEventListener('cancel', () => {
    if (findingDetailsAnimations.get(details) === animation) findingDetailsAnimations.delete(details);
  }, { once: true });
}

function syncFindingRow(item, finding, verifyStatus) {
  const expanded = item.dataset.findingKey === state.selectedId;
  const wasExpanded = item.dataset.expanded === 'true';
  const button = item.querySelector('.finding-summary');
  item.dataset.expanded = String(expanded);
  button.setAttribute('aria-expanded', String(expanded));
  if (wasExpanded !== expanded) {
    setFindingDetailsExpanded(item.querySelector('.finding-details'), expanded);
  }
  setFindingVerifyStatus(item, finding, findingRowData(finding), verifyStatus);
}

function createFindingRow(finding, key, verifyStatus, data = findingRowData(finding)) {
  const item = document.createElement('li');
  item.className = 'finding-card';
  item.dataset.findingKey = key;
  item.dataset.renderSignature = data.signature;
  item.dataset.confidence = data.confidence;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'finding-summary';
  button.dataset.findingId = key;
  if (data.aiFinding) {
    item.dataset.origin = data.origin;
    item.dataset.aiConfidence = aiConfidenceLevel(finding.aiConfidence);
  }
  const expanded = key === state.selectedId;
  item.dataset.expanded = String(expanded);
  button.setAttribute('aria-expanded', String(expanded));

  const details = document.createElement('div');
  details.className = 'finding-details';
  details.id = `finding-details-${encodeURIComponent(key)}`;
  details.hidden = !expanded;
  button.setAttribute('aria-controls', details.id);

  const location = document.createElement('span');
  location.className = 'finding-location';
  location.textContent = data.location;
  const meta = document.createElement('div');
  meta.className = 'finding-meta';
  meta.append(location);
  if (data.aiFinding) {
    const origin = document.createElement('button');
    origin.type = 'button';
    origin.className = 'finding-origin';
    origin.dataset.aiReviewFinding = key;
    origin.setAttribute('aria-haspopup', 'dialog');
    origin.setAttribute('aria-label', 'Показать данные проверки ChatGPT (Codex)');
    origin.title = 'Показать входные данные и результат проверки';
    origin.textContent = 'Codex';
    meta.append(origin);
  }

  const title = document.createElement('strong');
  title.className = 'finding-title';
  title.textContent = data.shortTitle;
  const indicator = document.createElement('span');
  indicator.className = 'confidence-indicator';
  indicator.setAttribute('aria-hidden', 'true');
  indicator.textContent = findingConfidenceMarker(data.confidence);
  button.append(title, indicator);

  const factor = document.createElement('span');
  factor.className = 'finding-factor';
  factor.textContent = finding.factor || '';

  const excerpt = document.createElement('blockquote');
  excerpt.className = 'finding-excerpt';
  excerpt.textContent = finding.excerpt || '';

  const reason = document.createElement('span');
  reason.className = 'finding-reason';
  reason.textContent = data.reason;

  details.append(meta);
  if (finding.factor) details.append(factor);
  if (finding.excerpt) details.append(excerpt);
  details.append(reason);
  item.append(button, details);
  setFindingVerifyStatus(item, finding, data, verifyStatus);
  return item;
}

function ensureRejectedFindingsSection() {
  if (rejectedFindingsSection) return;
  rejectedFindingsSection = document.createElement('details');
  rejectedFindingsSection.className = 'rejected-findings';
  const summary = document.createElement('summary');
  summary.className = 'rejected-findings-summary';
  const title = document.createElement('span');
  title.textContent = 'Отсеянное';
  rejectedFindingsCount = document.createElement('span');
  rejectedFindingsCount.className = 'result-count rejected-findings-count';
  summary.append(title, rejectedFindingsCount);
  rejectedFindingsList = document.createElement('ol');
  rejectedFindingsList.className = 'finding-list rejected-findings-list';
  rejectedFindingsSection.append(summary, rejectedFindingsList);
  ui.findingList.after(rejectedFindingsSection);
}

function findingVerificationStatuses(entries) {
  const progress = state.aiProgress || {};
  const verifying = (state.aiAnalysis === 'checking' || state.aiAnalysis === 'running')
    && progress.phase === 'verify';
  if (!verifying) return new Map();

  const algorithmFindings = entries
    .filter(({ finding }) => String(finding.origin || '').toLocaleLowerCase() === 'algorithm' || !isAiFinding(finding))
    .sort((left, right) => (left.finding.start ?? Number.MAX_SAFE_INTEGER) - (right.finding.start ?? Number.MAX_SAFE_INTEGER)
      || (left.finding.end ?? Number.MAX_SAFE_INTEGER) - (right.finding.end ?? Number.MAX_SAFE_INTEGER)
      || String(left.finding.ruleId || '').localeCompare(String(right.finding.ruleId || '')));
  const pendingFindings = algorithmFindings.filter(({ finding }) => !finding.aiConfidence);
  if (Array.isArray(progress.activeFindingIds)) {
    const activeIds = new Set(progress.activeFindingIds.map(String));
    return new Map(pendingFindings.map(({ key, finding }) => [
      key,
      activeIds.has(String(finding.id || '')) ? 'active' : 'queued',
    ]));
  }
  const completedValue = Number(progress.completed);
  const completed = Number.isFinite(completedValue) ? Math.max(0, Math.floor(completedValue)) : 0;
  return new Map(algorithmFindings.slice(completed).map(({ key }, index) => [key, index === 0 ? 'active' : 'queued']));
}

function renderFindingRows(list, entries, existingNodes, statuses, desiredNodes, enteringNodes, renderedIndices) {
  entries.forEach(({ finding, key }, position) => {
    const existing = existingNodes.get(key);
    const data = findingRowData(finding);
    const item = existing?.dataset.renderSignature === data.signature
      ? existing
      : createFindingRow(finding, key, statuses.get(key), data);
    if (item === existing) {
      syncFindingRow(item, finding, statuses.get(key));
    } else if (!existing) {
      enteringNodes.set(item, position);
    }
    desiredNodes.add(item);
    renderedIndices.set(key, { list, index: position, item });
    const current = list.children[position];
    if (current !== item) list.insertBefore(item, current || null);
  });
}

function animateFindingChanges(oldOrder, oldPositions, renderedIndices, enteringNodes, orderChanged, reducedMotion) {
  if (reducedMotion) return;

  for (const [item, position] of enteringNodes) {
    if (!item.getClientRects().length) continue;
    item.style.setProperty('--finding-entry-delay', `${Math.min(position, 4) * 22}ms`);
    item.classList.add('is-entering');
    const finishEntry = (event) => {
      if (event.target !== item) return;
      item.classList.remove('is-entering');
      item.style.removeProperty('--finding-entry-delay');
      item.removeEventListener('animationend', finishEntry);
    };
    item.addEventListener('animationend', finishEntry);
  }
  if (!orderChanged) return;

  for (const [key, current] of renderedIndices) {
    const previous = oldOrder.get(key);
    const oldTop = oldPositions.get(key);
    if (!previous || !Number.isFinite(oldTop) || previous.list === current.list && previous.index === current.index) continue;
    const newRect = current.item.getBoundingClientRect();
    if (!newRect.height) continue;
    const delta = oldTop - newRect.top;
    if (Math.abs(delta) < 1) continue;
    current.item.animate([
      { transform: `translateY(${delta}px)`, opacity: 0.84 },
      { transform: 'translateY(0)', opacity: 1 },
    ], { duration: 180, easing: 'ease-out' });
  }
}

function renderFindings() {
  ensureRejectedFindingsSection();
  const entries = state.findings.map((finding, index) => ({ finding, index, key: findingKey(finding, index), confidence: findingConfidenceLevel(finding) }));
  const priority = { high: 0, medium: 1, low: 2, possible: 3, unknown: 4, 'likely-false': 5 };
  entries.sort((left, right) => priority[left.confidence] - priority[right.confidence] || left.index - right.index);
  const rejected = entries.filter(({ confidence }) => confidence === 'likely-false');
  const visible = entries.filter(({ confidence }) => confidence !== 'likely-false');
  ui.resultCount.textContent = state.analysis === 'idle' && !state.document ? '—' : String(visible.length);
  const statuses = findingVerificationStatuses(entries);
  const orderSignature = JSON.stringify([visible.map(({ key }) => key), rejected.map(({ key }) => key)]);
  const orderChanged = orderSignature !== renderedFindingsOrderSignature;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const existingNodes = new Map();
  const oldOrder = new Map();
  const oldPositions = new Map();
  for (const list of [ui.findingList, rejectedFindingsList]) {
    Array.from(list.children).forEach((item, index) => {
      const key = item.dataset.findingKey;
      if (!key) return;
      existingNodes.set(key, item);
      oldOrder.set(key, { list, index });
      if (orderChanged && !reducedMotion) {
        const rect = item.getBoundingClientRect();
        if (rect.height) oldPositions.set(key, rect.top);
      }
    });
  }
  const desiredNodes = new Set();
  const enteringNodes = new Map();
  const renderedIndices = new Map();
  renderFindingRows(ui.findingList, visible, existingNodes, statuses, desiredNodes, enteringNodes, renderedIndices);
  renderFindingRows(rejectedFindingsList, rejected, existingNodes, statuses, desiredNodes, enteringNodes, renderedIndices);
  for (const item of ui.findingList.parentElement.querySelectorAll('.finding-card')) {
    if (!desiredNodes.has(item)) item.remove();
  }
  rejectedFindingsCount.textContent = String(rejected.length);
  rejectedFindingsSection.hidden = rejected.length === 0;
  renderedFindingsOrderSignature = orderSignature;
  animateFindingChanges(oldOrder, oldPositions, renderedIndices, enteringNodes, orderChanged, reducedMotion);
  renderFindingsMessage();
  renderAiAnalysisNote();
  renderProgress();
}

function codexPayloadIsAvailable(status) {
  return status?.installed === true && status?.authenticated === true;
}

function updateCodexProgress(tab, token, progress) {
  if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
  tab.aiProgress = progress || null;
  reflectAnalysisTab(tab);
}

function updateCodexFinding(tab, token, finding) {
  if (tabById(tab.id) !== tab || token !== tab.analysisToken || !finding) return;
  appendFindings([finding], tab);
  reflectAnalysisTab(tab);
}

async function analyzeCodexInBrowser(input, onProgress, onFinding) {
  const response = await fetch('/__norman/codex/analyze', {
    method: 'POST',
    cache: 'no-store',
    headers: {
      Accept: 'application/x-ndjson',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `HTTP ${response.status}`);
  }

  let complete = null;
  const handleLine = (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error('Ответ адаптера Codex имеет неверный формат.');
    }
    if (event.type === 'progress') onProgress(event.payload || {});
    else if (event.type === 'finding') onFinding(event.payload?.finding);
    else if (event.type === 'complete') complete = event.payload || {};
    else if (event.type === 'error') throw new Error(event.payload?.message || 'Проверка Codex не завершилась.');
  };

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) handleLine(line);
      if (done) break;
    }
    if (pending.trim()) handleLine(pending);
  } else {
    const body = await response.text();
    for (const line of body.split('\n')) handleLine(line);
  }

  if (!complete || !Array.isArray(complete.findings)) {
    throw new Error('Адаптер Codex завершил поток без итогового списка сигналов.');
  }
  return complete;
}

async function executeCodexReview(tab, token, parallelProcesses) {
  tab.aiAnalysis = 'checking';
  tab.aiAnalysisMessage = '';
  tab.aiProgress = null;
  reflectAnalysisTab(tab);

  const status = await refreshCodexStatus();
  if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
  if (!codexSettings.enabled) {
    tab.aiAnalysis = 'idle';
    tab.aiAnalysisMessage = '';
    return;
  }
  if (!codexPayloadIsAvailable(status) || ui.codexModel.disabled || ui.codexReasoning.disabled) {
    tab.aiAnalysis = 'unavailable';
    tab.aiAnalysisMessage = status.message || (!status.installed
      ? 'Codex CLI не найден. Локальные результаты сохранены.'
      : 'Войдите в Codex CLI. Локальные результаты сохранены.');
    return;
  }

  tab.aiAnalysis = 'running';
  tab.aiAnalysisMessage = '';
  tab.aiProgress = null;
  reflectAnalysisTab(tab);

  const onProgress = (progress) => updateCodexProgress(tab, token, progress);
  const onFinding = (finding) => updateCodexFinding(tab, token, finding);
  const unlisten = [];
  try {
    let result;
    const input = {
      text: tab.document.text,
      findings: tab.findings,
      model: codexSettings.model,
      reasoningEffort: codexSettings.reasoningEffort,
      parallelProcesses,
    };
    if (isTauri) {
      try {
        unlisten.push(await listen('ai-analysis-progress', (event) => onProgress(event.payload || {})));
        unlisten.push(await listen('ai-finding', (event) => onFinding(event.payload?.finding)));
      } catch {
        // Final invoke result still supplies all findings if event listening is unavailable.
      }
      result = await invoke('analyze_with_codex', input);
    } else {
      result = await analyzeCodexInBrowser(input, onProgress, onFinding);
    }
    if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
    const resultFindings = Array.isArray(result) ? result : result?.findings;
    if (!Array.isArray(resultFindings)) throw new Error('Codex не вернул итоговый список сигналов.');
    tab.findings = mergeFindings(tab.findings, resultFindings);
    tab.aiAnalysis = 'done';
    tab.aiProgress = null;
    tab.aiAnalysisMessage = '';
  } catch (error) {
    if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
    tab.aiAnalysis = 'error';
    tab.aiAnalysisMessage = `Проверка Codex не завершилась. Локальные результаты сохранены. ${messageFrom(error)}`;
  } finally {
    for (const stop of unlisten) stop();
  }
}

function render() {
  renderDocumentTabs();
  renderControls();
  renderError();
  renderDocument();
  renderFindings();
  saveActiveTab();
  scheduleFindingToSourceScroll();
}

async function executeAnalysis(tab, token) {
  if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
  const parallelProcesses = codexSettings.parallelProcesses;
  let stopListening = null;
  if (isTauri) {
    try {
      stopListening = await listen('analysis-progress', (event) => {
        if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
        const payload = event.payload || {};
        tab.progress = payload;
        if (Array.isArray(payload.findings)) appendFindings(payload.findings, tab);
        reflectAnalysisTab(tab);
      });
    } catch {
      stopListening = null;
    }
  }

  try {
    const result = isTauri
      ? await invoke('analyze_text', { text: tab.document.text, parallelProcesses })
      : await (await import('./browser-runtime.js')).analyzeTextInBrowser(tab.document.text, (payload) => {
        if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
        tab.progress = payload;
        if (Array.isArray(payload.findings)) appendFindings(payload.findings, tab);
        reflectAnalysisTab(tab);
      }, parallelProcesses);
    if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
    tab.findings = mergeFindings(tab.findings, Array.isArray(result?.findings) ? result.findings : []);
    if (codexSettings.enabled) await executeCodexReview(tab, token, parallelProcesses);
    tab.analysis = 'done';
    tab.progress = null;
  } catch (error) {
    if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
    tab.analysis = 'error';
    tab.analysisError = messageFrom(error);
  } finally {
    if (stopListening) stopListening();
    if (tabById(tab.id) === tab && token === tab.analysisToken) reflectAnalysisTab(tab);
  }
}

function reflectAnalysisTab(tab) {
  if (state.activeId !== tab.id) {
    renderDocumentTabs();
    return;
  }
  state.analysis = tab.analysis;
  state.analysisError = tab.analysisError;
  state.findings = tab.findings;
  state.selectedId = tab.selectedId;
  state.progress = tab.progress;
  state.aiAnalysis = tab.aiAnalysis || 'idle';
  state.aiAnalysisMessage = tab.aiAnalysisMessage || '';
  state.aiProgress = tab.aiProgress || null;
  render();
}

function runAnalysis(tabId = state.activeId) {
  const tab = tabById(tabId);
  if (!tab || !tab.document || tab.analysis === 'running'
    || tab.aiAnalysis === 'checking' || tab.aiAnalysis === 'running') return Promise.resolve();

  const token = ++tab.analysisToken;
  tab.analysis = 'running';
  tab.analysisError = '';
  tab.findings = [];
  tab.selectedId = null;
  tab.progress = null;
  tab.aiAnalysis = 'idle';
  tab.aiAnalysisMessage = '';
  tab.aiProgress = null;
  reflectAnalysisTab(tab);

  const job = analysisQueue.then(
    () => executeAnalysis(tab, token),
    () => executeAnalysis(tab, token),
  );
  analysisQueue = job.catch(() => {});
  return job;
}

async function retryCodexAnalysis(tabId = state.activeId) {
  const tab = tabById(tabId);
  if (!tab || !tab.document || tab.analysis !== 'done'
    || (tab.aiAnalysis !== 'error' && tab.aiAnalysis !== 'unavailable')
    || !codexSettings.enabled) return;

  // A retry is a new full run: local rules and every AI stage start again without cached answers.
  return runAnalysis(tab.id);
}

async function receiveDocument(load) {
  state.sourceLoading = true;
  state.loadError = '';
  render();
  try {
    const doc = await load();
    if (!doc || typeof doc.text !== 'string') {
      throw new Error('Источник не вернул текст для просмотра.');
    }
    const documentData = {
      title: doc.title || 'Документ без названия',
      url: doc.url || '',
      format: doc.format || 'ТЕКСТ',
      text: doc.text,
      previewHtml: typeof doc.previewHtml === 'string' ? doc.previewHtml : (typeof doc.html === 'string' ? doc.html : ''),
    };
    const tab = createDocumentTab(documentData);
    state.tabs.push(tab);
    activateTab(tab);
    state.loadError = '';
  } catch (error) {
    state.loadError = 'Не удалось загрузить источник. ' + messageFrom(error);
  } finally {
    state.sourceLoading = false;
    render();
  }
  const activeTab = tabById(state.activeId);
  if (activeTab?.analysis === 'idle' && !state.loadError) await runAnalysis(activeTab.id);
}

function showDialogError(element, message) {
  element.textContent = message;
  element.hidden = !message;
}

function isSupportedFilePath(path) {
  const extension = path.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase();
  return ['doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'odt', 'pdf', 'rtf', 'txt', 'text', 'md', 'csv']
    .includes(extension);
}

ui.openUrlDialog.addEventListener('click', () => {
  state.loadError = '';
  renderError();
  showDialogError(ui.urlError, '');
  ui.urlInput.value = '';
  ui.urlDialog.showModal();
  ui.urlInput.focus();
});

ui.closeUrlDialog.addEventListener('click', () => ui.urlDialog.close());
ui.cancelUrlDialog.addEventListener('click', () => ui.urlDialog.close());
ui.urlDialog.addEventListener('click', (event) => {
  if (event.target === ui.urlDialog) ui.urlDialog.close();
});

ui.urlForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  let url;
  try {
    url = new URL(ui.urlInput.value.trim());
  } catch {
    showDialogError(ui.urlError, 'Введите корректную ссылку.');
    return;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    showDialogError(ui.urlError, 'Поддерживаются ссылки HTTP и HTTPS.');
    return;
  }
  showDialogError(ui.urlError, '');
  ui.urlDialog.close();
  await receiveDocument(() => isTauri
    ? invoke('load_url', { url: url.href })
    : import('./browser-runtime.js').then(({ loadUrlInBrowser }) => loadUrlInBrowser(url.href)));
});

ui.openFileDialog.addEventListener('click', () => {
  state.loadError = '';
  renderError();
  showDialogError(ui.fileError, '');
  ui.fileDialog.showModal();
});

ui.closeFileDialog.addEventListener('click', () => ui.fileDialog.close());
ui.fileDialog.addEventListener('click', (event) => {
  if (event.target === ui.fileDialog) ui.fileDialog.close();
});

async function loadFilePath(path) {
  if (!isSupportedFilePath(path)) {
    showDialogError(ui.fileError, 'Этот формат файла не поддерживается.');
    return;
  }
  state.loadError = '';
  renderError();
  ui.fileDialog.close();
  await receiveDocument(() => invoke('load_file', { path }));
}

async function loadBrowserFile(file) {
  if (!isSupportedFilePath(file.name)) {
    showDialogError(ui.fileError, 'Этот формат файла не поддерживается.');
    return;
  }
  state.loadError = '';
  renderError();
  ui.fileDialog.close();
  await receiveDocument(() => import('./browser-runtime.js').then(({ loadFileInBrowser }) => loadFileInBrowser(file)));
}

ui.openFilePicker.addEventListener('click', async () => {
  if (!isTauri) {
    ui.browserFileInput.click();
    return;
  }
  if (state.sourceLoading) return;
  state.sourceLoading = true;
  render();
  try {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: 'Документы',
          extensions: ['doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'odt', 'pdf', 'rtf', 'txt', 'text', 'md', 'csv'],
        },
      ],
    });
    const path = Array.isArray(selected) ? selected[0] : selected;
    state.sourceLoading = false;
    render();
    if (!path) return;
    await loadFilePath(path);
  } catch (error) {
    state.sourceLoading = false;
    showDialogError(ui.fileError, 'Не удалось открыть файл. ' + messageFrom(error));
    render();
  }
});

ui.browserFileInput.addEventListener('change', async () => {
  const file = ui.browserFileInput.files?.[0];
  if (!file) return;
  try {
    await loadBrowserFile(file);
  } finally {
    ui.browserFileInput.value = '';
  }
});

ui.fileDropzone.addEventListener('dragover', (event) => {
  if (isTauri) return;
  event.preventDefault();
  ui.fileDropzone.classList.add('is-dragging');
});

ui.fileDropzone.addEventListener('dragleave', () => {
  if (!isTauri) ui.fileDropzone.classList.remove('is-dragging');
});

ui.fileDropzone.addEventListener('drop', (event) => {
  if (isTauri) return;
  event.preventDefault();
  ui.fileDropzone.classList.remove('is-dragging');
  const file = event.dataTransfer?.files[0];
  if (file) void loadBrowserFile(file);
});

if (isTauri) {
  void getCurrentWebview().onDragDropEvent((event) => {
    if (!ui.fileDialog.open) return;
    const { type, paths = [] } = event.payload;
    if (type === 'enter' || type === 'over') {
      ui.fileDropzone.classList.add('is-dragging');
    } else if (type === 'leave') {
      ui.fileDropzone.classList.remove('is-dragging');
    } else if (type === 'drop') {
      ui.fileDropzone.classList.remove('is-dragging');
      if (paths[0]) void loadFilePath(paths[0]);
    }
  }).catch(() => {});
}

ui.newDocument.addEventListener('click', startNewTab);
ui.openSettings.addEventListener('click', () => {
  syncCodexSettingsUI();
  ui.settingsDialog.showModal();
  if (codexSettings.enabled) void refreshCodexStatus();
});
ui.closeSettings.addEventListener('click', () => ui.settingsDialog.close());
ui.closeAiReview.addEventListener('click', () => ui.aiReviewDialog.close());
ui.aiReviewDialog.addEventListener('click', (event) => {
  if (event.target === ui.aiReviewDialog) ui.aiReviewDialog.close();
});
ui.checkCodexStatus.addEventListener('click', () => void refreshCodexStatus());
ui.settingsDialog.addEventListener('click', (event) => {
  if (event.target === ui.settingsDialog) ui.settingsDialog.close();
});
ui.settingsDialog.addEventListener('change', (event) => {
  if (event.target.matches('input[name="theme"]')) setTheme(event.target.value);
  if (event.target === ui.filterAdsInPreview) {
    codexSettings.filterAdsInPreview = ui.filterAdsInPreview.checked;
    saveCodexSettings();
    state.frameUrl = '';
    render();
  }
  if (event.target === ui.codexEnabled) {
    codexSettings.enabled = ui.codexEnabled.checked;
    syncCodexSettingsUI();
    render();
  }
  if (event.target === ui.codexModel) codexSettings.model = ui.codexModel.value;
  if (event.target === ui.codexReasoning) codexSettings.reasoningEffort = ui.codexReasoning.value;
  if (event.target === ui.parallelProcesses) {
    const selected = Number(ui.parallelProcesses.value);
    codexSettings.parallelProcesses = [1, 2, 3, 4].includes(selected) ? selected : 1;
  }
  if (event.target === ui.codexEnabled || event.target === ui.codexModel || event.target === ui.codexReasoning || event.target === ui.parallelProcesses) {
    saveCodexSettings();
  }
  if (event.target === ui.codexEnabled && codexSettings.enabled) void refreshCodexStatus();
});

ui.tabList.addEventListener('click', (event) => {
  const closeButton = event.target.closest('[data-close-tab]');
  if (closeButton) {
    closeDocumentTab(closeButton.dataset.closeTab);
    return;
  }
  const selectButton = event.target.closest('[data-select-tab]');
  if (selectButton) selectDocumentTab(selectButton.dataset.selectTab);
});
ui.tabList.addEventListener('keydown', (event) => {
  const current = event.target.closest('[data-select-tab]');
  if (!current || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
  const tabs = Array.from(ui.tabList.querySelectorAll('[data-select-tab]'));
  const index = tabs.indexOf(current);
  const delta = event.key === 'ArrowRight' ? 1 : -1;
  const next = tabs[(index + delta + tabs.length) % tabs.length];
  event.preventDefault();
  selectDocumentTab(next.dataset.selectTab);
});

ui.pageFrame.addEventListener('load', () => {
  const url = safeHttpUrl(state.document?.url);
  if (!url || !pageFrameDocumentRef) return;
  markPageFrameReady(url, pageFrameDocumentRef, pageFrameLoadToken);
});

ui.pageFrame.addEventListener('error', () => {
  if (!state.document?.url || state.frameUrl !== safeHttpUrl(state.document.url)) return;
  if (pageFrameSoftTimeout) window.clearTimeout(pageFrameSoftTimeout);
  pageFrameSoftTimeout = 0;
  state.frameState = 'error';
  ui.pageLoading.hidden = true;
  ui.pageError.hidden = false;
  ui.openOriginal.hidden = false;
});

ui.findingList.parentElement.addEventListener('click', (event) => {
  const reviewButton = event.target.closest('[data-ai-review-finding]');
  if (reviewButton) {
    event.preventDefault();
    event.stopPropagation();
    openAiReview(reviewButton.dataset.aiReviewFinding);
    return;
  }
  const button = event.target.closest('[data-finding-id]');
  if (!button) return;
  state.selectedId = state.selectedId === button.dataset.findingId ? null : button.dataset.findingId;
  render();
  if (state.selectedId) {
    if (state.document?.url) scrollPageFindingIntoView(state.selectedId);
    else {
      const target = sourceTargets.get(state.selectedId);
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        target.focus({ preventScroll: true });
      }
    }
  }
  keepFindingVisible(state.selectedId || followedFindingId);
});

ui.documentText.addEventListener('click', (event) => {
  const mark = event.target.closest('.source-hit');
  if (!mark) return;
  const key = mark.dataset.findingIds.split(' ')[0];
  if (!key) return;
  state.selectedId = key;
  render();
  sourceTargets.get(key)?.focus({ preventScroll: true });
  keepFindingVisible(key);
});

ui.textPanel.addEventListener('scroll', scheduleFindingToSourceScroll, { passive: true });

ui.retryAnalysis.addEventListener('click', () => runAnalysis());
ui.retryAiAnalysis.addEventListener('click', () => { void retryCodexAnalysis(); });
ui.dismissError.addEventListener('click', () => {
  state.loadError = '';
  renderError();
});

ui.openOriginal.addEventListener('click', async () => {
  const url = state.document?.url;
  if (!url) return;
  try {
    if (isTauri) await openUrl(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  } catch (error) {
    state.loadError = 'Не удалось открыть ссылку в браузере. ' + messageFrom(error);
    renderError();
  }
});

render();
