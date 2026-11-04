import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import './style.css';

const isTauri = Boolean(window.__TAURI_INTERNALS__);
const THEME_STORAGE_KEY = 'norman-color-theme';

const state = {
  screen: 'start',
  tabs: [],
  activeId: null,
  document: null,
  findings: [],
  checklist: [],
  selectedId: null,
  sourceLoading: false,
  analysis: 'idle',
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
  openOriginal: document.querySelector('#openOriginal'),
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
  findingsMessage: document.querySelector('#findingsMessage'),
  retryAnalysis: document.querySelector('#retryAnalysis'),
  findingList: document.querySelector('#findingList'),
  checklistSection: document.querySelector('#checklistSection'),
  checklist: document.querySelector('#checklist'),
};

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
  const button = ui.findingList.querySelector(`[data-finding-id="${CSS.escape(key)}"]`);
  if (!panel || !button) return;

  const item = button.closest('li') || button;
  const panelRect = panel.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const visibleTop = panelRect.top + panel.clientTop + 8;
  const visibleBottom = panelRect.top + panel.clientTop + panel.clientHeight - 8;
  if (itemRect.top < visibleTop) panel.scrollTop -= visibleTop - itemRect.top;
  else if (itemRect.bottom > visibleBottom) panel.scrollTop += itemRect.bottom - visibleBottom;
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
  tab.checklist = state.checklist;
  tab.selectedId = state.selectedId;
  tab.analysis = state.analysis;
  tab.analysisError = state.analysisError;
  tab.progress = state.progress;
}

function activateTab(tab) {
  state.activeId = tab.id;
  state.screen = 'analysis';
  state.document = tab.document;
  state.findings = tab.findings;
  state.checklist = tab.checklist;
  state.selectedId = tab.selectedId;
  state.analysis = tab.analysis;
  state.analysisError = tab.analysisError;
  state.progress = tab.progress;
  clearPageFrame();
  state.loadError = '';
}

function createDocumentTab(document) {
  return {
    id: `document-${nextTabId++}`,
    document,
    findings: [],
    checklist: [],
    selectedId: null,
    analysis: 'idle',
    analysisError: '',
    analysisToken: 0,
    progress: null,
  };
}

function showUploadScreen() {
  state.activeId = null;
  state.screen = 'start';
  state.document = null;
  state.findings = [];
  state.checklist = [];
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
  return String(finding.id || finding.ruleId + '-' + finding.start + '-' + index);
}

function appendFindings(findings, target = state) {
  const known = new Set(target.findings.map((finding) => finding.id));
  for (const finding of findings) {
    if (!known.has(finding.id)) {
      known.add(finding.id);
      target.findings.push(finding);
    }
  }
  target.findings.sort((left, right) => left.start - right.start || left.end - right.end || left.ruleId.localeCompare(right.ruleId));
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
    ui.pagePanel.hidden = true;
    ui.textPanel.hidden = true;
    clearPageFrame();
    return;
  }

  ui.documentTitle.textContent = doc.title || 'Документ без названия';
  ui.documentFormat.textContent = String(doc.format || 'ТЕКСТ').toUpperCase();
  const hasPage = Boolean(doc.url);
  const selectedFinding = state.findings.find((finding, index) => findingKey(finding, index) === state.selectedId);
  const showTextPreview = !hasPage || Boolean(selectedFinding && isValidFinding(selectedFinding));
  ui.pagePanel.hidden = !hasPage || showTextPreview;
  ui.textPanel.hidden = !showTextPreview;
  if (hasPage && !showTextPreview) renderPageFrame(doc.url);
  else if (!hasPage) clearPageFrame();
  renderSourceText();
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function renderPageFrame(value) {
  const url = safeHttpUrl(value);
  if (!url) {
    state.frameUrl = '';
    state.frameState = 'error';
    ui.pageFrame.hidden = true;
    ui.pageLoading.hidden = true;
    ui.pageError.hidden = false;
    ui.openOriginal.hidden = !state.document?.url;
    return;
  }

  if (state.frameUrl !== url) {
    state.frameUrl = url;
    state.frameState = 'loading';
    ui.pageFrame.title = state.document?.title || 'Исходная страница';
    ui.pageFrame.hidden = false;
    ui.pageFrame.src = url;
  }

  ui.pageFrame.hidden = false;
  ui.pageLoading.hidden = state.frameState !== 'loading';
  ui.pageError.hidden = state.frameState !== 'error';
  ui.openOriginal.hidden = state.frameState !== 'error';
}

function clearPageFrame() {
  if (ui.pageFrame.hasAttribute('src')) ui.pageFrame.removeAttribute('src');
  ui.pageFrame.hidden = true;
  ui.pageLoading.hidden = true;
  ui.pageError.hidden = true;
  ui.openOriginal.hidden = true;
  state.frameUrl = '';
  state.frameState = 'idle';
}

function pluralFindings(count) {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return count + ' сигналов';
  if (mod10 === 1) return count + ' сигнал';
  if (mod10 >= 2 && mod10 <= 4) return count + ' сигнала';
  return count + ' сигналов';
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
  ui.analysisStatus.hidden = state.analysis !== 'running';
}

function confidenceLevel(value) {
  const confidence = String(value || '').toLocaleLowerCase();
  if (confidence.includes('высок') || confidence === 'high') return 'high';
  if (confidence.includes('средн') || confidence === 'medium') return 'medium';
  if (confidence.includes('низк') || confidence === 'low') return 'low';
  return 'unknown';
}

function createFindingRow(finding, index) {
  const key = findingKey(finding, index);
  const fullTitle = finding.title || finding.factor || 'Возможный сигнал';
  const shortTitle = fullTitle
    .replace(/^Возможн(?:ое|ая)\s+/u, '')
    .replace(/^./u, (character) => character.toLocaleUpperCase('ru-RU'));
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'finding finding-summary';
  button.dataset.findingId = key;
  button.dataset.confidence = confidenceLevel(finding.confidence);
  const expanded = key === state.selectedId;
  button.setAttribute('aria-expanded', String(expanded));

  const details = document.createElement('div');
  details.className = 'finding-details';
  details.id = `finding-details-${index}`;
  details.hidden = !expanded;
  button.setAttribute('aria-controls', details.id);

  const rule = document.createElement('span');
  rule.className = 'rule-id';
  rule.textContent = finding.ruleId || 'Правило';
  const location = document.createElement('span');
  location.className = 'finding-location';
  location.textContent = state.document && isValidFinding(finding)
    ? articleAndPart(state.document.text, finding.start, finding.end)
    : 'Источник';
  const meta = document.createElement('div');
  meta.className = 'finding-meta';
  meta.append(rule, location);

  const title = document.createElement('strong');
  title.className = 'finding-title';
  title.textContent = shortTitle;
  const indicator = document.createElement('span');
  indicator.className = 'confidence-indicator';
  indicator.setAttribute('aria-hidden', 'true');
  button.setAttribute('aria-label', [
    fullTitle,
    location.textContent,
    finding.confidence ? 'Уверенность ' + finding.confidence : 'Уверенность не указана',
  ].join('. '));
  button.append(title, indicator);

  const factor = document.createElement('span');
  factor.className = 'finding-factor';
  factor.textContent = finding.factor || '';

  const excerpt = document.createElement('q');
  excerpt.className = 'finding-excerpt';
  excerpt.textContent = finding.excerpt || '';

  const reason = document.createElement('span');
  reason.className = 'finding-reason';
  reason.textContent = finding.reason || 'Совпадение правила требует проверки в контексте.';

  details.append(meta);
  if (finding.factor) details.append(factor);
  if (finding.excerpt) details.append(excerpt);
  details.append(reason);
  item.append(button, details);
  return item;
}

function checklistText(item) {
  if (typeof item === 'string') return { title: item, detail: '' };
  if (!item || typeof item !== 'object') return { title: String(item), detail: '' };
  const title = item.title || item.label || item.text || item.name || 'Проверка';
  const detail = item.reason && item.reason !== title ? item.reason : item.status || '';
  return { title: String(title), detail: String(detail) };
}

function renderChecklist() {
  const items = Array.isArray(state.checklist) ? state.checklist : [];
  ui.checklistSection.hidden = !items.length;
  ui.checklist.replaceChildren();

  for (const item of items) {
    const parts = checklistText(item);
    const row = document.createElement('li');
    const title = document.createElement('span');
    title.textContent = parts.title;
    row.append(title);
    if (parts.detail) {
      const detail = document.createElement('small');
      detail.textContent = parts.detail;
      row.append(detail);
    }
    ui.checklist.append(row);
  }
}

function renderFindings() {
  const count = state.findings.length;
  ui.resultCount.textContent = state.analysis === 'idle' && !state.document ? '—' : String(count);
  ui.findingList.replaceChildren(...state.findings.map(createFindingRow));
  renderFindingsMessage();
  renderProgress();
  renderChecklist();
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
      ? await invoke('analyze_text', { text: tab.document.text })
      : await (await import('./browser-runtime.js')).analyzeTextInBrowser(tab.document.text, (payload) => {
        if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
        tab.progress = payload;
        if (Array.isArray(payload.findings)) appendFindings(payload.findings, tab);
        reflectAnalysisTab(tab);
      });
    if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
    tab.findings = Array.isArray(result?.findings) ? result.findings : [];
    tab.checklist = Array.isArray(result?.checklist) ? result.checklist : [];
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
  state.checklist = tab.checklist;
  state.selectedId = tab.selectedId;
  state.progress = tab.progress;
  render();
}

function runAnalysis(tabId = state.activeId) {
  const tab = tabById(tabId);
  if (!tab || !tab.document || tab.analysis === 'running') return Promise.resolve();

  const token = ++tab.analysisToken;
  tab.analysis = 'running';
  tab.analysisError = '';
  tab.findings = [];
  tab.checklist = [];
  tab.selectedId = null;
  tab.progress = null;
  reflectAnalysisTab(tab);

  const job = analysisQueue.then(
    () => executeAnalysis(tab, token),
    () => executeAnalysis(tab, token),
  );
  analysisQueue = job.catch(() => {});
  return job;
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
ui.openSettings.addEventListener('click', () => ui.settingsDialog.showModal());
ui.closeSettings.addEventListener('click', () => ui.settingsDialog.close());
ui.settingsDialog.addEventListener('click', (event) => {
  if (event.target === ui.settingsDialog) ui.settingsDialog.close();
});
ui.settingsDialog.addEventListener('change', (event) => {
  if (event.target.matches('input[name="theme"]')) setTheme(event.target.value);
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
  if (!state.document?.url || state.frameUrl !== safeHttpUrl(state.document.url)) return;
  state.frameState = 'loaded';
  ui.pageLoading.hidden = true;
  ui.pageError.hidden = true;
  ui.openOriginal.hidden = true;
});

ui.pageFrame.addEventListener('error', () => {
  if (!state.document?.url || state.frameUrl !== safeHttpUrl(state.document.url)) return;
  state.frameState = 'error';
  ui.pageLoading.hidden = true;
  ui.pageError.hidden = false;
  ui.openOriginal.hidden = false;
});

ui.findingList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-finding-id]');
  if (!button) return;
  state.selectedId = state.selectedId === button.dataset.findingId ? null : button.dataset.findingId;
  render();
  const target = sourceTargets.get(state.selectedId);
  if (target) {
    target.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    target.focus({ preventScroll: true });
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
