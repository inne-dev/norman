import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import packageInfo from '../package.json';
import { aiConfidenceLevel, findingConfidenceLevel, isAiFinding } from './finding-confidence.js';
import { enhanceCustomSelects, makeProviderIcon } from './custom-select.js';
import { allModelsForRecommendation, OLLAMA_RAM_THRESHOLD_BYTES, recommendationForMemory } from './ollama-recommendations.js';
import { generateReportPdf } from './report-pdf.js';
import './style.css';

const isTauri = Boolean(window.__TAURI_INTERNALS__);
const isBrowserOllamaDev = !isTauri && import.meta.env.DEV;
const releaseTag = import.meta.env.VITE_APP_VERSION || '';
const displayedAppVersion = releaseTag || packageInfo.version;
const THEME_STORAGE_KEY = 'norman-color-theme';
const CODEX_STORAGE_KEY = 'norman-codex-settings';
const WELCOME_STORAGE_KEY = 'norman-welcome-shown';
const DEFAULT_CODEX_SETTINGS = Object.freeze({
  enabled: false,
  provider: 'codex',
  model: 'gpt-6-luna',
  reasoningEffort: 'high',
  claudeModel: 'sonnet',
  claudeReasoningEffort: 'high',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaModel: '',
  cloudRuModel: '',
  yandexFolderId: '',
  yandexModel: '',
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
  aiFailure: null,
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
let claudeStatus = { checked: false, installed: false, authenticated: false, version: '', message: '' };
let claudeStatusRequest = null;
let ollamaStatus = { checked: false, installed: false, available: false, models: [], message: '' };
let ollamaStatusRequestId = 0;
let ollamaStarting = false;
let cloudRuStatus = { checked: false, available: false, models: [], message: '' };
let cloudRuStatusRequestId = 0;
let cloudRuApiKey = '';
let yandexStatus = { checked: false, available: false, models: [], message: '' };
let yandexStatusRequestId = 0;
let yandexApiKey = '';
let welcomeRecommendation = null;
let welcomeInstallInProgress = false;
let welcomeInstallComplete = false;
let ollamaInstallInProgress = false;
let ollamaInstallCancellationRequested = false;
let ollamaBrowserInstallController = null;
let settingsOllamaMemoryChecked = false;
let settingsOllamaMemoryBytes = null;
let settingsOllamaRecommendation = null;
let pageFrameDocumentRef = null;
let pageFrameBoundDocument = null;
let pageFrameLoadToken = 0;
let pageFrameFilterAds = null;
const findingDetailsAnimations = new WeakMap();

const ui = {
  tabBar: document.querySelector('#tabBar'),
  tabList: document.querySelector('#tabList'),
  startScreen: document.querySelector('#startScreen'),
  openWelcome: document.querySelector('#openWelcome'),
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
  welcomeDialog: document.querySelector('#welcomeDialog'),
  closeWelcome: document.querySelector('#closeWelcome'),
  continueWithoutAi: document.querySelector('#continueWithoutAi'),
  welcomeOpenSettings: document.querySelector('#welcomeOpenSettings'),
  welcomeOllama: document.querySelector('#welcomeOllama'),
  welcomeMemory: document.querySelector('#welcomeMemory'),
  welcomeModel: document.querySelector('#welcomeModel'),
  welcomeModelNote: document.querySelector('#welcomeModelNote'),
  welcomeInstallerNote: document.querySelector('#welcomeInstallerNote'),
  welcomeInstallOllama: document.querySelector('#welcomeInstallOllama'),
  welcomeProgress: document.querySelector('#welcomeProgress'),
  welcomeInstallStatus: document.querySelector('#welcomeInstallStatus'),
  settingsDialog: document.querySelector('#settingsDialog'),
  closeSettings: document.querySelector('#closeSettings'),
  openOllamaSetup: document.querySelector('#openOllamaSetup'),
  ollamaSetupDialog: document.querySelector('#ollamaSetupDialog'),
  closeOllamaSetup: document.querySelector('#closeOllamaSetup'),
  openAppInfo: document.querySelector('#openAppInfo'),
  appInfoDialog: document.querySelector('#appInfoDialog'),
  closeAppInfo: document.querySelector('#closeAppInfo'),
  appVersion: document.querySelector('#appVersion'),
  ollamaDownloadStatus: document.querySelector('#ollamaDownloadStatus'),
  ollamaDownloadLabel: document.querySelector('#ollamaDownloadLabel'),
  ollamaDownloadProgress: document.querySelector('#ollamaDownloadProgress'),
  ollamaDownloadPercent: document.querySelector('#ollamaDownloadPercent'),
  headerAiStatus: document.querySelector('#headerAiStatus'),
  headerAiProviderIcon: document.querySelector('#headerAiProviderIcon'),
  headerAiReasoning: document.querySelector('#headerAiReasoning'),
  aiReviewDialog: document.querySelector('#aiReviewDialog'),
  aiReviewTitle: document.querySelector('#aiReviewTitle'),
  closeAiReview: document.querySelector('#closeAiReview'),
  aiReviewSingleContent: document.querySelector('#aiReviewSingleContent'),
  aiReviewLiveStatus: document.querySelector('#aiReviewLiveStatus'),
  aiReviewLiveMessages: document.querySelector('#aiReviewLiveMessages'),
  aiReviewLiveTyping: document.querySelector('#aiReviewLiveTyping'),
  aiReviewResultSection: document.querySelector('#aiReviewResultSection'),
  aiReviewResultsList: document.querySelector('#aiReviewResultsList'),
  aiReviewExcerpt: document.querySelector('#aiReviewExcerpt'),
  aiReviewRuleSection: document.querySelector('#aiReviewRuleSection'),
  aiReviewRuleExplanation: document.querySelector('#aiReviewRuleExplanation'),
  aiReviewConfidence: document.querySelector('#aiReviewConfidence'),
  aiReviewConfidenceMarker: document.querySelector('#aiReviewConfidenceMarker'),
  aiReviewDecision: document.querySelector('#aiReviewDecision'),
  codexEnabled: document.querySelector('#codexEnabled'),
  filterAdsInPreview: document.querySelector('#filterAdsInPreview'),
  codexOptions: document.querySelector('#codexOptions'),
  codexProvider: document.querySelector('#codexProvider'),
  codexProviderOptions: document.querySelector('#codexProviderOptions'),
  codexModel: document.querySelector('#codexModel'),
  codexReasoning: document.querySelector('#codexReasoning'),
  claudeOptions: document.querySelector('#claudeOptions'),
  claudeModel: document.querySelector('#claudeModel'),
  claudeReasoning: document.querySelector('#claudeReasoning'),
  claudeStatus: document.querySelector('#claudeStatus'),
  checkClaudeStatus: document.querySelector('#checkClaudeStatus'),
  ollamaOptions: document.querySelector('#ollamaOptions'),
  ollamaBaseUrl: document.querySelector('#ollamaBaseUrl'),
  ollamaAddressControl: document.querySelector('#ollamaAddressControl'),
  ollamaAddressCheck: document.querySelector('#ollamaAddressCheck'),
  ollamaModel: document.querySelector('#ollamaModel'),
  ollamaStatus: document.querySelector('#ollamaStatus'),
  startOllama: document.querySelector('#startOllama'),
  checkOllamaStatus: document.querySelector('#checkOllamaStatus'),
  ollamaSetup: document.querySelector('#ollamaSetup'),
  ollamaSetupMemory: document.querySelector('#ollamaSetupMemory'),
  ollamaSetupModel: document.querySelector('#ollamaSetupModel'),
  ollamaSetupNote: document.querySelector('#ollamaSetupNote'),
  ollamaSetupProgress: document.querySelector('#ollamaSetupProgress'),
  ollamaSetupStatus: document.querySelector('#ollamaSetupStatus'),
  installOllamaFromSettings: document.querySelector('#installOllamaFromSettings'),
  cancelOllamaSetup: document.querySelector('#cancelOllamaSetup'),
  cloudRuOptions: document.querySelector('#cloudRuOptions'),
  cloudRuApiKey: document.querySelector('#cloudRuApiKey'),
  cloudRuModel: document.querySelector('#cloudRuModel'),
  cloudRuStatus: document.querySelector('#cloudRuStatus'),
  checkCloudRuStatus: document.querySelector('#checkCloudRuStatus'),
  yandexOptions: document.querySelector('#yandexOptions'),
  yandexApiKey: document.querySelector('#yandexApiKey'),
  yandexFolderId: document.querySelector('#yandexFolderId'),
  yandexModel: document.querySelector('#yandexModel'),
  yandexStatus: document.querySelector('#yandexStatus'),
  checkYandexStatus: document.querySelector('#checkYandexStatus'),
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
  analysisPauseButton: document.querySelector('#analysisPauseButton'),
  analysisPauseStatus: document.querySelector('#analysisPauseStatus'),
  analysisProgress: document.querySelector('#analysisProgress'),
  analysisProgressBar: document.querySelector('#analysisProgressBar'),
  analysisProgressFill: document.querySelector('#analysisProgressFill'),
  analysisProgressSteps: document.querySelector('#analysisProgressSteps'),
  analysisSlowWarning: document.querySelector('#analysisSlowWarning'),
  findingsMessage: document.querySelector('#findingsMessage'),
  aiAnalysisNote: document.querySelector('#aiAnalysisNote'),
  aiAnalysisMessage: document.querySelector('#aiAnalysisMessage'),
  showPartialAiReview: document.querySelector('#showPartialAiReview'),
  retryAiAnalysis: document.querySelector('#retryAiAnalysis'),
  retryAnalysis: document.querySelector('#retryAnalysis'),
  findingList: document.querySelector('#findingList'),
  exportReportPdf: document.querySelector('#exportReportPdf'),
};
const customSelects = enhanceCustomSelects(document);

function setAppVersion(version) {
  ui.appVersion.textContent = version;
}

setAppVersion(displayedAppVersion);

const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent;
const currentPlatform = /win/i.test(platform) ? 'windows'
  : /mac|darwin/i.test(platform) ? 'macos'
    : /linux/i.test(platform) ? 'linux' : '';

if (isTauri && currentPlatform === 'macos') {
  document.documentElement.classList.add('macos-titlebar-overlay');
  document.addEventListener('mousedown', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (event.button !== 0 || event.clientY > 40 || target?.closest('button, a, input, select, textarea')) return;
    void getCurrentWindow().startDragging().catch(() => {});
  });
}

function loadCodexSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(CODEX_STORAGE_KEY) || '{}');
    return {
      ...DEFAULT_CODEX_SETTINGS,
      ...saved,
      enabled: saved.enabled === true,
      filterAdsInPreview: saved.filterAdsInPreview !== false,
      provider: ['claude', 'ollama', 'cloudru', 'yandex'].includes(saved.provider) ? saved.provider : 'codex',
      model: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'].includes(saved.model)
        ? saved.model
        : DEFAULT_CODEX_SETTINGS.model,
      reasoningEffort: ['low', 'medium', 'high'].includes(saved.reasoningEffort)
        ? saved.reasoningEffort
        : DEFAULT_CODEX_SETTINGS.reasoningEffort,
      claudeModel: ['sonnet', 'opus', 'haiku'].includes(saved.claudeModel)
        ? saved.claudeModel
        : DEFAULT_CODEX_SETTINGS.claudeModel,
      claudeReasoningEffort: ['low', 'medium', 'high'].includes(saved.claudeReasoningEffort)
        ? saved.claudeReasoningEffort
        : DEFAULT_CODEX_SETTINGS.claudeReasoningEffort,
      ollamaBaseUrl: typeof saved.ollamaBaseUrl === 'string' && saved.ollamaBaseUrl.trim()
        ? saved.ollamaBaseUrl.trim()
        : DEFAULT_CODEX_SETTINGS.ollamaBaseUrl,
      ollamaModel: typeof saved.ollamaModel === 'string' ? saved.ollamaModel : '',
      cloudRuModel: typeof saved.cloudRuModel === 'string' ? saved.cloudRuModel : '',
      yandexFolderId: typeof saved.yandexFolderId === 'string' ? saved.yandexFolderId : '',
      yandexModel: typeof saved.yandexModel === 'string' ? saved.yandexModel : '',
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
  ui.codexProviderOptions.hidden = codexSettings.provider !== 'codex';
  ui.codexModel.value = codexSettings.model;
  ui.codexReasoning.value = codexSettings.reasoningEffort;
  ui.claudeOptions.hidden = codexSettings.provider !== 'claude';
  ui.claudeModel.value = codexSettings.claudeModel;
  ui.claudeReasoning.value = codexSettings.claudeReasoningEffort;
  renderClaudeStatus();
  ui.ollamaOptions.hidden = codexSettings.provider !== 'ollama';
  ui.ollamaBaseUrl.value = codexSettings.ollamaBaseUrl;
  renderOllamaStatus();
  ui.cloudRuOptions.hidden = codexSettings.provider !== 'cloudru';
  renderCloudRuStatus();
  ui.yandexOptions.hidden = codexSettings.provider !== 'yandex';
  ui.yandexFolderId.value = codexSettings.yandexFolderId;
  renderYandexStatus();
  ui.parallelProcesses.value = String(codexSettings.parallelProcesses);
  renderCodexStatus();
  renderAiAnalysisNote();
  customSelects.refresh();
  renderHeaderAiStatus();
}

function renderHeaderAiStatus() {
  ui.headerAiStatus.hidden = !codexSettings.enabled;
  if (!codexSettings.enabled) return;

  const icon = makeProviderIcon(codexSettings.provider, 'custom-select-icon');
  ui.headerAiProviderIcon.replaceChildren(...(icon ? [icon] : []));

  const reasoningControl = codexSettings.provider === 'codex'
    ? ui.codexReasoning
    : codexSettings.provider === 'claude' ? ui.claudeReasoning : null;
  const reasoning = reasoningControl?.selectedOptions[0]?.textContent?.trim() || '';
  ui.headerAiReasoning.hidden = !reasoning;
  ui.headerAiReasoning.textContent = reasoning;

  const description = [
    aiProviderLabel(codexSettings.provider),
    ...(reasoning ? [`Уровень рассуждения: ${reasoning}`] : []),
  ];
  ui.headerAiStatus.title = description.join(' · ');
  ui.headerAiStatus.setAttribute('aria-label', description.join('. '));
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
  customSelects.refresh();
  renderHeaderAiStatus();
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
void showWelcome();

async function showWelcome(force = false) {
  if (!force) {
    try {
      if (localStorage.getItem(WELCOME_STORAGE_KEY) === 'shown') return;
    } catch {
      // Storage restrictions should not prevent the welcome from appearing.
    }
  }

  let totalMemoryBytes = null;
  if (isTauri) {
    try {
      const result = await invoke('get_system_memory_bytes');
      if (Number.isFinite(result) && result > 0) totalMemoryBytes = result;
    } catch {
      // The general welcome still works when the platform cannot report memory.
    }
  }

  welcomeRecommendation = recommendationForMemory(totalMemoryBytes);
  const canOfferOllama = totalMemoryBytes >= OLLAMA_RAM_THRESHOLD_BYTES && Boolean(welcomeRecommendation);
  ui.welcomeOllama.hidden = !canOfferOllama;
  if (canOfferOllama) {
    const memoryGb = Math.round(totalMemoryBytes / 1_000_000_000);
    ui.welcomeMemory.textContent = `Обнаружено около ${memoryGb} ГБ оперативной памяти.`;
    ui.welcomeMemory.hidden = false;
    const models = allModelsForRecommendation(welcomeRecommendation);
    ui.welcomeModel.replaceChildren(...models.map(({ name, tag, size }) => {
      const option = new Option(`${name} · ${size}`, tag);
      return option;
    }));
    ui.welcomeModel.value = welcomeRecommendation.recommended.tag;
    ui.welcomeInstallerNote.textContent = ollamaInstallerNote(currentPlatform);
    ui.welcomeInstallOllama.hidden = !isTauri;
    renderWelcomeModelNote();
    customSelects.refresh();
  }

  if (!force) {
    try {
      localStorage.setItem(WELCOME_STORAGE_KEY, 'shown');
    } catch {
      // Keep the welcome usable for this session if storage is unavailable.
    }
  }
  ui.welcomeDialog.showModal();
}

function closeWelcome() {
  if (welcomeInstallInProgress) return;
  if (ui.welcomeDialog.open) ui.welcomeDialog.close();
}

function openSettingsFromWelcome() {
  closeWelcome();
  syncCodexSettingsUI();
  ui.settingsDialog.showModal();
  if (codexSettings.provider === 'ollama') void prepareOllamaSettings();
  else if (codexSettings.enabled) void refreshSelectedAiProviderStatus();
  requestAnimationFrame(() => ui.codexEnabled.focus());
}

function ollamaInstallerNote(selectedPlatform) {
  const selected = allModelsForRecommendation(welcomeRecommendation)
    .find((model) => model.tag === ui.welcomeModel.value) || welcomeRecommendation?.recommended;
  const installSize = selectedPlatform === 'windows' ? 'около 1,6 ГБ'
    : selectedPlatform === 'macos' ? 'около 219 МБ'
      : selectedPlatform === 'linux' ? 'около 1,4–1,5 ГБ'
        : 'не поддерживается в этой системе';
  const platformNote = selectedPlatform === 'linux'
    ? 'Ollama установится в папку пользователя без изменения системных пакетов; для распаковки нужен zstd.'
    : 'Будет загружена официальная сборка Ollama.';
  const modelNote = selected ? `Модель займёт примерно ${selected.size}; ` : '';
  return `${modelNote}загрузка Ollama — ${installSize}. ${platformNote} Скачается только выбранная модель.`;
}

function renderWelcomeModelNote() {
  const selected = allModelsForRecommendation(welcomeRecommendation)
    .find((model) => model.tag === ui.welcomeModel.value);
  if (!selected) return;
  ui.welcomeModelNote.textContent = `Тег Ollama: ${selected.tag}. Размер весов: ${selected.size}. Модели и контекст могут требовать дополнительную память и место на диске.`;
  ui.welcomeInstallerNote.textContent = ollamaInstallerNote(currentPlatform);
  if (!welcomeInstallInProgress && !welcomeInstallComplete) {
    ui.welcomeInstallOllama.textContent = `Установить Ollama и скачать ${selected.name}`;
  }
}

function formatDownloadedBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '';
  const gib = value / 1024 ** 3;
  return gib < 0.1 ? `${Math.round(value / 1024 ** 2)} МБ` : `${gib.toFixed(1)} ГБ`;
}

function installStatus(message, stateName = 'loading') {
  ui.welcomeInstallStatus.textContent = message;
  ui.welcomeInstallStatus.dataset.state = stateName;
  ui.welcomeInstallStatus.hidden = false;
}

function ollamaInstallFailureMessage(error) {
  const detail = messageFrom(error);
  return `Не удалось настроить Ollama и загрузить модель. ${detail} Нажмите «Повторить установку»: приложение проверит состояние Ollama и повторит загрузку модели. Если ошибка повторится, проверьте подключение к интернету и свободное место.`;
}

function setWelcomeInstallBusy(busy) {
  welcomeInstallInProgress = busy;
  ui.welcomeInstallOllama.disabled = busy;
  if (busy) ui.welcomeInstallOllama.textContent = 'Настраиваем Ollama…';
  else if (!welcomeInstallComplete && ui.welcomeInstallStatus.dataset.state === 'error') {
    ui.welcomeInstallOllama.textContent = 'Повторить установку';
  }
  ui.welcomeOpenSettings.disabled = busy;
  ui.continueWithoutAi.disabled = busy;
  ui.closeWelcome.disabled = busy;
  ui.welcomeModel.disabled = busy;
  ui.welcomeProgress.hidden = !busy;
  ui.welcomeProgress.removeAttribute('value');
  ui.welcomeProgress.value = 0;
}

function humanizeOllamaPullStatus(status) {
  const labels = {
    'pulling manifest': 'Подготавливаем модель…',
    'verifying sha256 digest': 'Проверяем целостность модели…',
    'writing manifest': 'Сохраняем модель…',
    reconnecting: 'Соединение прервалось, переподключаемся…',
    success: 'Модель загружена.',
  };
  return labels[status] || 'Загружаем модель…';
}

function renderOllamaDownloadStatus(model, payload = {}) {
  const reconnecting = payload.status === 'reconnecting';
  const total = Number(payload.total);
  const completed = Number(payload.completed);
  const percent = payload.status === 'success'
    ? 100
    : Number.isFinite(total) && total > 0 && Number.isFinite(completed)
      ? Math.floor(Math.min(100, Math.max(0, completed / total * 100)))
      : 0;

  ui.ollamaDownloadLabel.textContent = reconnecting ? 'Переподключаемся к Ollama…' : `Скачиваем ${model.name}`;
  if (!reconnecting) {
    ui.ollamaDownloadProgress.value = percent;
    ui.ollamaDownloadPercent.textContent = `${percent}%`;
  }
  ui.ollamaDownloadStatus.hidden = false;
}

function hideOllamaDownloadStatus() {
  ui.ollamaDownloadStatus.hidden = true;
}

async function waitForLocalOllama(onStatus = installStatus) {
  const attempts = 120;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfOllamaSetupCancelled();
    const status = await invoke('get_ollama_status', { baseUrl: 'http://127.0.0.1:11434' });
    throwIfOllamaSetupCancelled();
    if (status?.available === true) return status;
    onStatus(`Запускаем Ollama… ${attempt + 1} из ${attempts}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Ollama установлена, но локальный сервер не запустился. Попробуйте открыть Ollama вручную и повторить загрузку модели.');
}

function throwIfOllamaSetupCancelled() {
  if (!ollamaInstallCancellationRequested) return;
  const error = new Error('Установка Ollama отменена.');
  error.name = 'AbortError';
  throw error;
}

async function installOllamaModelInBrowser(selected, onStatus, onProgress) {
  const baseUrl = codexSettings.ollamaBaseUrl.trim() || DEFAULT_CODEX_SETTINGS.ollamaBaseUrl;
  const controller = new AbortController();
  ollamaBrowserInstallController = controller;
  try {
    onStatus('Запускаем локальную Ollama…');
    await requestBrowserOllama('/__norman/ollama/start', { baseUrl }, controller.signal);
    throwIfOllamaSetupCancelled();
    onStatus(`Скачиваем ${selected.name} (${selected.size})…`);
    renderOllamaDownloadStatus(selected);
    const response = await fetch('/__norman/ollama/pull', {
      method: 'POST',
      cache: 'no-store',
      headers: { Accept: 'application/x-ndjson', 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, model: selected.tag }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.error || `HTTP ${response.status}`);
    }
    const handleLine = (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { throw new Error('Поток загрузки Ollama имеет неверный формат.'); }
      if (event.type === 'error') throw new Error(event.payload?.message || 'Не удалось загрузить модель Ollama.');
      if (event.type !== 'progress' && event.type !== 'complete') return;
      const payload = event.payload || {};
      onProgress(payload, 'pull');
      renderOllamaDownloadStatus(selected, payload);
      onStatus(Number.isFinite(payload.total) && payload.total > 0
        ? `${humanizeOllamaPullStatus(payload.status)} ${formatDownloadedBytes(payload.completed)} из ${formatDownloadedBytes(payload.total)}`
        : humanizeOllamaPullStatus(payload.status));
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
      for (const line of (await response.text()).split('\n')) handleLine(line);
    }
    throwIfOllamaSetupCancelled();
    const installedStatus = await requestBrowserOllama('/__norman/ollama/status', { baseUrl });
    if (!Array.isArray(installedStatus.models) || !installedStatus.models.includes(selected.tag)) {
      throw new Error('Загрузка завершилась, но модель не появилась в списке Ollama. Повторите загрузку.');
    }
    return installedStatus;
  } catch (error) {
    if (ollamaInstallCancellationRequested || error?.name === 'AbortError') throwIfOllamaSetupCancelled();
    throw error;
  } finally {
    if (ollamaBrowserInstallController === controller) ollamaBrowserInstallController = null;
  }
}

async function installOllamaModel(selected, onStatus, onProgress) {
  if ((!isTauri && !isBrowserOllamaDev) || ollamaInstallInProgress) throw new Error('Установка Ollama уже выполняется.');
  ollamaInstallInProgress = true;
  ollamaInstallCancellationRequested = false;
  if (!isTauri) {
    try {
      return await installOllamaModelInBrowser(selected, onStatus, onProgress);
    } finally {
      hideOllamaDownloadStatus();
      ollamaInstallInProgress = false;
    }
  }
  let stopInstallListening = () => {};
  let stopPullListening = () => {};
  try {
    await invoke('begin_ollama_setup');
    throwIfOllamaSetupCancelled();
    stopInstallListening = await listen('ollama-install-progress', (event) => {
      if (ollamaInstallCancellationRequested) return;
      const payload = event.payload || {};
      onProgress(payload, 'install');
      if (payload.message) onStatus(payload.message);
    });
    stopPullListening = await listen('ollama-pull-progress', (event) => {
      if (ollamaInstallCancellationRequested) return;
      const payload = event.payload || {};
      if (payload.error) {
        if (!ollamaInstallCancellationRequested) onStatus(String(payload.error), 'error');
        return;
      }
      onProgress(payload, 'pull');
      renderOllamaDownloadStatus(selected, payload);
      onStatus(Number.isFinite(payload.total) && payload.total > 0
        ? `${humanizeOllamaPullStatus(payload.status)} ${formatDownloadedBytes(payload.completed)} из ${formatDownloadedBytes(payload.total)}`
        : humanizeOllamaPullStatus(payload.status));
    });

    onStatus('Проверяем локальную Ollama…');
    const localStatus = await invoke('get_ollama_status', { baseUrl: 'http://127.0.0.1:11434' });
    throwIfOllamaSetupCancelled();
    if (localStatus?.available !== true) {
      onStatus('Скачиваем и устанавливаем Ollama…');
      await invoke('install_ollama');
      throwIfOllamaSetupCancelled();
    }
    await waitForLocalOllama(onStatus);

    onStatus(`Скачиваем ${selected.name} (${selected.size})…`);
    renderOllamaDownloadStatus(selected);
    await invoke('pull_ollama_model', { model: selected.tag });
    const installedStatus = await invoke('get_ollama_status', { baseUrl: 'http://127.0.0.1:11434' });
    if (!Array.isArray(installedStatus?.models) || !installedStatus.models.includes(selected.tag)) {
      throw new Error('Загрузка завершилась, но модель не появилась в списке локальных моделей.');
    }
    return installedStatus;
  } catch (error) {
    if (ollamaInstallCancellationRequested) throwIfOllamaSetupCancelled();
    throw error;
  } finally {
    hideOllamaDownloadStatus();
    stopInstallListening();
    stopPullListening();
    ollamaInstallInProgress = false;
  }
}

async function installOllamaFromWelcome() {
  if (!isTauri || !welcomeRecommendation || welcomeInstallInProgress || ollamaInstallInProgress) return;
  const selected = allModelsForRecommendation(welcomeRecommendation)
    .find((model) => model.tag === ui.welcomeModel.value);
  if (!selected) return;

  setWelcomeInstallBusy(true);
  try {
    const installedStatus = await installOllamaModel(selected, installStatus, (payload, type) => {
      if (type === 'install' && Number.isFinite(payload.total) && payload.total > 0 && Number.isFinite(payload.completed)) {
        ui.welcomeProgress.hidden = false;
        ui.welcomeProgress.value = Math.min(100, Math.max(0, payload.completed / payload.total * 100));
      } else if (type === 'install') {
        ui.welcomeProgress.removeAttribute('value');
      } else if (type === 'pull' && Number.isFinite(payload.total) && payload.total > 0) {
        ui.welcomeProgress.value = Math.min(100, Math.max(0, payload.completed / payload.total * 100));
      } else if (type === 'pull') {
        ui.welcomeProgress.removeAttribute('value');
      }
    });
    ollamaStatus = { checked: true, installed: true, available: true, models: installedStatus.models, message: installedStatus.message || '' };
    codexSettings.provider = 'ollama';
    codexSettings.ollamaBaseUrl = 'http://127.0.0.1:11434';
    codexSettings.ollamaModel = selected.tag;
    saveCodexSettings();
    renderOllamaStatus();
    customSelects.refresh();
    welcomeInstallComplete = true;
    ui.welcomeInstallOllama.textContent = 'Открыть настройки';
    ui.welcomeProgress.value = 100;
    installStatus(`${selected.name} установлена. ИИ пока выключен; включить его можно в настройках.`, 'ready');
  } catch (error) {
    installStatus(ollamaInstallFailureMessage(error), 'error');
  } finally {
    setWelcomeInstallBusy(false);
    if (welcomeInstallComplete) {
      ui.welcomeProgress.hidden = false;
      ui.welcomeProgress.value = 100;
      ui.welcomeInstallOllama.textContent = 'Открыть настройки';
    }
  }
}

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

function keepFindingVisible(key, { alignTop = false } = {}) {
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
  if (alignTop) {
    panel.scrollTo({ top: panel.scrollTop + itemRect.top - visibleTop, behavior: reducedMotion ? 'auto' : 'smooth' });
  } else if (itemRect.top < visibleTop) {
    panel.scrollTo({ top: panel.scrollTop - (visibleTop - itemRect.top), behavior: reducedMotion ? 'auto' : 'smooth' });
  } else if (itemRect.bottom > visibleBottom) {
    panel.scrollTo({ top: panel.scrollTop + (itemRect.bottom - visibleBottom), behavior: reducedMotion ? 'auto' : 'smooth' });
  }
}

function keepExpandedFindingVisible(key) {
  const panel = ui.findingList.parentElement;
  const item = Array.from(panel?.querySelectorAll('.finding-card[data-finding-key]') || [])
    .find((candidate) => candidate.dataset.findingKey === key);
  const animation = item && findingDetailsAnimations.get(item.querySelector('.finding-details'));
  const reveal = () => requestAnimationFrame(() => keepFindingVisible(key, { alignTop: true }));
  if (animation) animation.addEventListener('finish', reveal, { once: true });
  else reveal();
}

function selectFinding(key, { scrollPreview = true, focusFinding = false } = {}) {
  if (!key || !state.findings.some((finding, index) => findingKey(finding, index) === key)) return;
  state.selectedId = key;
  render();
  if (focusFinding) keepExpandedFindingVisible(key);
  else keepFindingVisible(key);
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
  tab.aiFailure = state.aiFailure;
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
  state.aiFailure = tab.aiFailure || null;
  state.aiProgress = tab.aiProgress || null;
  clearPageFrame();
  state.loadError = '';
}

function createDocumentTab(document) {
  return {
    id: `document-${nextTabId++}`,
    document,
    findings: [],
    aiReviewUpdates: new Map(),
    aiReviewStreams: new Map(),
    aiReviewOutputs: new Map(),
    aiReviewStepStartedAt: new Map(),
    aiReviewDurations: new Map(),
    aiReviewAbortController: null,
    selectedId: null,
    analysis: 'idle',
    analysisError: '',
    analysisToken: 0,
    slowAnalysisWarning: false,
    slowAnalysisTimer: null,
    slowAnalysisTimerStartedAt: 0,
    slowAnalysisRemainingMs: 3 * 60_000,
    progress: null,
    aiAnalysis: 'idle',
    aiAnalysisMessage: '',
    aiFailure: null,
    aiProgress: null,
    pauseState: 'running',
    analysisPauseId: null,
    pauseController: null,
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
  resetSlowAnalysisWarning(closedTab);
  closedTab.aiReviewAbortController?.abort();
  closedTab.aiReviewAbortController = null;
  void cancelAiAnalysis(closedTab).finally(() => releaseAnalysisPause(closedTab));
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
        const selector = 'mark.norman-source-finding[data-finding-id]';
        const mark = event.composedPath?.().find((target) => target?.matches?.(selector))
          || event.target?.closest?.(selector);
        if (mark) {
          event.preventDefault();
          selectFinding(mark.dataset.findingId, { scrollPreview: false, focusFinding: true });
          return;
        }
        if (event.target?.closest?.('a[href]')) event.preventDefault();
      }, { capture: true });
      sourceDocument.addEventListener('keydown', (event) => {
        const mark = event.target?.closest?.('mark.norman-source-finding[data-finding-id]');
        if (!mark || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        selectFinding(mark.dataset.findingId, { scrollPreview: false, focusFinding: true });
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

function renderClaudeStatus() {
  const available = claudeStatus.checked
    && claudeStatus.installed
    && claudeStatus.authenticated
    && !claudeStatus.checking;
  ui.claudeModel.disabled = !available;
  ui.claudeReasoning.disabled = !available;
  if (claudeStatus.checking) {
    ui.claudeStatus.textContent = 'Проверяем доступность Claude Code…';
    ui.claudeStatus.dataset.state = 'loading';
  } else if (!isTauri) {
    ui.claudeStatus.textContent = 'Claude Code CLI доступен в настольном приложении.';
    ui.claudeStatus.dataset.state = 'idle';
  } else if (!claudeStatus.checked) {
    ui.claudeStatus.textContent = 'Статус Claude Code ещё не проверен.';
    ui.claudeStatus.dataset.state = 'idle';
  } else if (claudeStatus.error || !claudeStatus.installed || !claudeStatus.authenticated) {
    ui.claudeStatus.textContent = claudeStatus.message || 'Проверьте установку и вход в Claude Code CLI.';
    ui.claudeStatus.dataset.state = 'error';
  } else {
    const version = claudeStatus.version ? ` · ${claudeStatus.version}` : '';
    ui.claudeStatus.textContent = claudeStatus.message || `Claude Code подключён${version}.`;
    ui.claudeStatus.dataset.state = 'ready';
  }
  ui.checkClaudeStatus.disabled = !isTauri || Boolean(claudeStatus.checking);
  ui.checkClaudeStatus.textContent = claudeStatus.checking ? 'Проверяем…' : 'Проверить';
  customSelects.refresh();
}

async function refreshClaudeStatus() {
  if (claudeStatusRequest) return claudeStatusRequest;
  if (!isTauri) {
    claudeStatus = {
      checked: false,
      installed: false,
      authenticated: false,
      version: '',
      message: 'Claude Code CLI доступен в настольном приложении.',
    };
    renderClaudeStatus();
    return claudeStatus;
  }

  claudeStatus = { ...claudeStatus, checking: true, error: false };
  renderClaudeStatus();
  claudeStatusRequest = (async () => {
    try {
      const result = await invoke('get_claude_status');
      claudeStatus = {
        checked: true,
        installed: result?.installed === true,
        authenticated: result?.authenticated === true,
        version: String(result?.version || ''),
        message: String(result?.message || ''),
        checking: false,
        error: false,
      };
    } catch (error) {
      claudeStatus = {
        checked: true,
        installed: false,
        authenticated: false,
        version: '',
        message: `Не удалось проверить Claude Code. ${messageFrom(error)}`,
        checking: false,
        error: true,
      };
    }
    renderClaudeStatus();
    return claudeStatus;
  })().finally(() => {
    claudeStatusRequest = null;
  });
  return claudeStatusRequest;
}

function renderOllamaStatus() {
  const models = ollamaStatus.models;
  const addressConnected = ollamaStatus.checked && ollamaStatus.available && !ollamaStatus.checking;
  ui.ollamaAddressControl.dataset.state = addressConnected ? 'ready' : 'idle';
  ui.ollamaAddressCheck.hidden = !addressConnected;
  const selectedModel = models.includes(codexSettings.ollamaModel)
    ? codexSettings.ollamaModel
    : (!ollamaStatus.checked && codexSettings.ollamaModel ? codexSettings.ollamaModel : '');
  const options = models.length
    ? models.map((model) => {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      return option;
    })
    : [new Option(
      ollamaStatus.checked && ollamaStatus.available ? 'Нет установленных моделей' : 'Проверьте подключение',
      '',
      true,
      true,
    )];
  if (selectedModel && !models.includes(selectedModel)) {
    const savedOption = document.createElement('option');
    savedOption.value = selectedModel;
    savedOption.textContent = selectedModel;
    options.unshift(savedOption);
  }
  ui.ollamaModel.replaceChildren(...options);
  ui.ollamaModel.value = selectedModel;
  ui.ollamaModel.disabled = Boolean(ollamaStatus.checking)
    || !ollamaStatus.checked
    || !ollamaStatus.available
    || models.length === 0;

  const canStartOllama = (isTauri || isBrowserOllamaDev)
    && ollamaStatus.installed
    && !ollamaStatus.available
    && isDefaultOllamaBaseUrl(codexSettings.ollamaBaseUrl);
  ui.startOllama.hidden = !canStartOllama;
  ui.startOllama.disabled = ollamaStarting || ollamaStatus.checking;
  ui.checkOllamaStatus.hidden = canStartOllama || ollamaStarting;

  if (ollamaStarting && !ollamaStatus.available) {
    ui.ollamaStatus.textContent = 'Запускаем Ollama…';
    ui.ollamaStatus.dataset.state = 'loading';
  } else if (ollamaStatus.checking) {
    ui.ollamaStatus.textContent = 'Проверяем Ollama…';
    ui.ollamaStatus.dataset.state = 'loading';
  } else if (!ollamaStatus.checked) {
    ui.ollamaStatus.textContent = isTauri || isBrowserOllamaDev
      ? 'Подключение ещё не проверено.'
      : 'Проверка и анализ Ollama доступны в настольном приложении.';
    ui.ollamaStatus.dataset.state = 'idle';
  } else if (!ollamaStatus.available && ollamaStatus.installed && isDefaultOllamaBaseUrl(codexSettings.ollamaBaseUrl)) {
    ui.ollamaStatus.textContent = 'Ollama установлена, но сервер не запущен.';
    ui.ollamaStatus.dataset.state = 'idle';
  } else if (!ollamaStatus.available || ollamaStatus.error) {
    ui.ollamaStatus.textContent = ollamaStatus.message || 'Не удалось подключиться к Ollama.';
    ui.ollamaStatus.dataset.state = 'error';
  } else if (!models.length) {
    ui.ollamaStatus.textContent = ollamaStatus.message || 'Ollama доступна, установленные модели не найдены.';
    ui.ollamaStatus.dataset.state = 'error';
  } else {
    ui.ollamaStatus.textContent = ollamaStatus.message || `Подключено · моделей: ${models.length}`;
    ui.ollamaStatus.dataset.state = 'ready';
  }
  ui.checkOllamaStatus.disabled = Boolean(ollamaStatus.checking);
  ui.checkOllamaStatus.textContent = ollamaStatus.checking ? 'Проверяем…' : 'Проверить';
  renderOllamaSetup();
}

function isLocalOllamaBaseUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return ['localhost', '127.0.0.1', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

function isDefaultOllamaBaseUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return url.protocol === 'http:'
      && ['localhost', '127.0.0.1'].includes(hostname)
      && url.port === '11434'
      && url.pathname === '/'
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function renderOllamaSetup() {
  if (codexSettings.provider !== 'ollama') {
    ui.openOllamaSetup.hidden = true;
    if (ui.ollamaSetupDialog.open) ui.ollamaSetupDialog.close();
    return;
  }
  const canOpenSetup = (isTauri || isBrowserOllamaDev) && isLocalOllamaBaseUrl(codexSettings.ollamaBaseUrl);
  ui.openOllamaSetup.hidden = !canOpenSetup;
  if (!canOpenSetup && !ui.ollamaSetupDialog.open) return;

  if (!settingsOllamaMemoryChecked) {
    ui.ollamaSetupMemory.textContent = 'Определяем объём оперативной памяти…';
    ui.ollamaSetupModel.replaceChildren();
    ui.ollamaSetupNote.textContent = '';
    ui.ollamaSetupNote.hidden = true;
    ui.installOllamaFromSettings.disabled = true;
    customSelects.refresh();
    return;
  }

  if (settingsOllamaMemoryBytes) {
    const memoryGb = Math.round(settingsOllamaMemoryBytes / 1_000_000_000);
    ui.ollamaSetupMemory.textContent = `Память: около ${memoryGb} ГБ.`;
  } else {
    ui.ollamaSetupMemory.textContent = 'Объём памяти не определён.';
  }

  const recommendedModels = allModelsForRecommendation(settingsOllamaRecommendation);
  const previousSelection = ui.ollamaSetupModel.value;
  ui.ollamaSetupModel.replaceChildren(...recommendedModels.map(({ name, tag, size, comparison }) => {
    const option = new Option(`${name} · ${size}`, tag);
    option.dataset.description = comparison;
    return option;
  }));
  if (recommendedModels.some(({ tag }) => tag === previousSelection)) ui.ollamaSetupModel.value = previousSelection;
  else if (settingsOllamaRecommendation) ui.ollamaSetupModel.value = settingsOllamaRecommendation.recommended.tag;

  const selected = recommendedModels.find(({ tag }) => tag === ui.ollamaSetupModel.value);
  const selectedIsInstalled = selected && ollamaStatus.models.includes(selected.tag);
  ui.ollamaSetupModel.disabled = !selected || ollamaInstallInProgress || !canOpenSetup;
  const retryAvailable = !ui.ollamaSetupStatus.hidden && ui.ollamaSetupStatus.dataset.state === 'error';
  ui.installOllamaFromSettings.disabled = !selected || ollamaInstallInProgress || !canOpenSetup || (selectedIsInstalled && !retryAvailable);
  if (retryAvailable && selected) {
    ui.installOllamaFromSettings.textContent = `Повторить установку ${selected.name}`;
  } else if (selectedIsInstalled) {
    ui.installOllamaFromSettings.textContent = `${selected.name} уже установлена`;
  } else if (selected && ollamaStatus.installed) {
    ui.installOllamaFromSettings.textContent = `Скачать ${selected.name}`;
  } else if (selected) {
    ui.installOllamaFromSettings.textContent = `Установить Ollama и скачать ${selected.name}`;
  } else {
    ui.installOllamaFromSettings.textContent = 'Установить Ollama и скачать модель';
  }
  ui.ollamaSetupNote.textContent = selected
    ? ''
    : settingsOllamaMemoryBytes
      ? 'Нет подходящих моделей для этого устройства.'
      : 'Не удалось подобрать модель.';
  ui.ollamaSetupNote.hidden = Boolean(selected);
  customSelects.refresh();
}

function setSettingsOllamaInstallBusy(busy) {
  ui.installOllamaFromSettings.disabled = busy || !allModelsForRecommendation(settingsOllamaRecommendation).length;
  ui.ollamaSetupModel.disabled = busy || !allModelsForRecommendation(settingsOllamaRecommendation).length;
  ui.closeOllamaSetup.disabled = busy;
  ui.cancelOllamaSetup.hidden = !busy;
  ui.cancelOllamaSetup.disabled = ollamaInstallCancellationRequested;
  ui.ollamaSetupProgress.hidden = !busy;
  ui.ollamaSetupProgress.removeAttribute('value');
  ui.ollamaSetupProgress.value = 0;
}

function settingsOllamaInstallStatus(message, stateName = 'loading') {
  ui.ollamaSetupStatus.textContent = message;
  ui.ollamaSetupStatus.dataset.state = stateName;
  ui.ollamaSetupStatus.hidden = false;
}

async function cancelOllamaSetupFromSettings() {
  if (!ollamaInstallInProgress || ollamaInstallCancellationRequested) return;
  ollamaInstallCancellationRequested = true;
  ui.cancelOllamaSetup.disabled = true;
  settingsOllamaInstallStatus('Останавливаем скачивание и установку…');
  if (!isTauri && isBrowserOllamaDev) {
    ollamaBrowserInstallController?.abort();
    return;
  }
  try {
    await invoke('cancel_ollama_setup');
  } catch (error) {
    ollamaInstallCancellationRequested = false;
    ui.cancelOllamaSetup.disabled = false;
    settingsOllamaInstallStatus(`Не удалось отменить установку: ${messageFrom(error)}`, 'error');
  }
}

async function loadSettingsOllamaRecommendation() {
  if ((!isTauri && !isBrowserOllamaDev) || settingsOllamaMemoryChecked) return;
  try {
    const result = isTauri
      ? await invoke('get_system_memory_bytes')
      : await fetch('/__norman/ollama/memory', { cache: 'no-store' })
        .then((response) => response.json())
        .then((value) => value.totalMemoryBytes);
    if (Number.isFinite(result) && result > 0) {
      settingsOllamaMemoryBytes = result;
      settingsOllamaRecommendation = recommendationForMemory(result);
    }
  } catch {
    // The settings offer stays unavailable when device memory cannot be read.
  }
  settingsOllamaMemoryChecked = true;
  renderOllamaSetup();
}

async function prepareOllamaSettings() {
  await Promise.all([loadSettingsOllamaRecommendation(), refreshOllamaStatus()]);
}

async function installOllamaFromSettings() {
  if ((!isTauri && !isBrowserOllamaDev) || ollamaInstallInProgress || !isLocalOllamaBaseUrl(codexSettings.ollamaBaseUrl)) return;
  const selected = allModelsForRecommendation(settingsOllamaRecommendation)
    .find((model) => model.tag === ui.ollamaSetupModel.value);
  if (!selected) return;

  ollamaInstallCancellationRequested = false;
  setSettingsOllamaInstallBusy(true);
  ui.ollamaSetupStatus.hidden = true;
  try {
    const installedStatus = await installOllamaModel(selected, settingsOllamaInstallStatus, (payload, type) => {
      ui.ollamaSetupProgress.hidden = false;
      if ((type === 'install' || type === 'pull') && Number.isFinite(payload.total) && payload.total > 0 && Number.isFinite(payload.completed)) {
        ui.ollamaSetupProgress.value = Math.min(100, Math.max(0, payload.completed / payload.total * 100));
      } else {
        ui.ollamaSetupProgress.removeAttribute('value');
      }
    });
    codexSettings.provider = 'ollama';
    codexSettings.ollamaBaseUrl = 'http://127.0.0.1:11434';
    codexSettings.ollamaModel = selected.tag;
    saveCodexSettings();
    ollamaStatus = {
      checked: true,
      installed: true,
      available: true,
      models: installedStatus.models,
      message: installedStatus.message || '',
      checking: false,
      error: false,
    };
    renderOllamaStatus();
    customSelects.refresh();
    settingsOllamaInstallStatus(`Ollama и ${selected.name} готовы. ИИ-анализ не запускается сам; при включённом ИИ новые документы будут обрабатываться локально.`, 'ready');
    ui.ollamaSetupProgress.hidden = false;
    ui.ollamaSetupProgress.value = 100;
  } catch (error) {
    if (ollamaInstallCancellationRequested || error?.name === 'AbortError') {
      settingsOllamaInstallStatus('Операция остановлена. Ollama могла успеть установиться; модель можно скачать повторно.', 'cancelled');
    } else {
      settingsOllamaInstallStatus(ollamaInstallFailureMessage(error), 'error');
    }
  } finally {
    setSettingsOllamaInstallBusy(false);
    renderOllamaSetup();
  }
}

async function requestBrowserOllama(path, payload = {}, signal) {
  if (!isBrowserOllamaDev) throw new Error('Проверка Ollama доступна в настольном приложении.');
  const response = await fetch(path, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

async function refreshOllamaStatus() {
  const requestId = ++ollamaStatusRequestId;
  if (!isTauri && !isBrowserOllamaDev) {
    ollamaStatus = {
      checked: false,
      installed: false,
      available: false,
      models: [],
      message: 'Проверка и анализ Ollama доступны в настольном приложении.',
    };
    renderOllamaStatus();
    return ollamaStatus;
  }

  ollamaStatus = { ...ollamaStatus, checking: true, error: false };
  renderOllamaStatus();
  try {
    const result = isTauri
      ? await invoke('get_ollama_status', { baseUrl: codexSettings.ollamaBaseUrl.trim() || null })
      : await requestBrowserOllama('/__norman/ollama/status', { baseUrl: codexSettings.ollamaBaseUrl.trim() || null });
    if (requestId !== ollamaStatusRequestId) return ollamaStatus;
    const models = Array.isArray(result?.models)
      ? result.models.filter((model) => typeof model === 'string' && model.trim()).map((model) => model.trim())
      : [];
    const selectedModel = models.includes(codexSettings.ollamaModel)
      ? codexSettings.ollamaModel
      : (models[0] || '');
    const modelChanged = selectedModel !== codexSettings.ollamaModel;
    codexSettings.ollamaModel = selectedModel;
    ollamaStatus = {
      checked: true,
      installed: result?.installed === true,
      available: result?.available === true,
      models,
      message: String(result?.message || ''),
      checking: false,
      error: false,
    };
    if (modelChanged) saveCodexSettings();
  } catch (error) {
    if (requestId !== ollamaStatusRequestId) return ollamaStatus;
    ollamaStatus = {
      checked: true,
      installed: ollamaStatus.installed,
      available: false,
      models: [],
      message: `Не удалось подключиться к Ollama. ${messageFrom(error)}`,
      checking: false,
      error: true,
    };
  }
  renderOllamaStatus();
  return ollamaStatus;
}

async function startOllamaFromSettings() {
  if ((!isTauri && !isBrowserOllamaDev) || ollamaStarting || !isDefaultOllamaBaseUrl(codexSettings.ollamaBaseUrl)) return;
  ollamaStarting = true;
  ollamaStatus = { ...ollamaStatus, checking: true, error: false };
  renderOllamaStatus();
  try {
    if (isTauri) await invoke('start_ollama');
    else await requestBrowserOllama('/__norman/ollama/start', { baseUrl: codexSettings.ollamaBaseUrl });
    const startupDeadline = Date.now() + 15_000;
    while (Date.now() < startupDeadline) {
      const status = await refreshOllamaStatus();
      if (status.available) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    ollamaStatus = {
      ...ollamaStatus,
      checking: false,
      error: true,
      message: 'Ollama не запустилась за 15 секунд. Проверьте приложение и повторите попытку.',
    };
  } catch (error) {
    ollamaStatus = {
      ...ollamaStatus,
      checking: false,
      available: false,
      error: true,
      message: messageFrom(error),
    };
  } finally {
    ollamaStarting = false;
    renderOllamaStatus();
  }
}

function renderCloudRuStatus() {
  const models = cloudRuStatus.models;
  const savedModel = codexSettings.cloudRuModel;
  const selectedModel = models.includes(savedModel)
    ? savedModel
    : (!cloudRuStatus.checked && savedModel ? savedModel : '');
  const options = models.length
    ? models.map((model) => new Option(model, model))
    : [new Option(
      cloudRuStatus.checked && cloudRuStatus.available ? 'Модели не найдены' : 'Проверьте подключение',
      '',
      true,
      true,
    )];
  if (selectedModel && !models.includes(selectedModel)) options.unshift(new Option(selectedModel, selectedModel));
  ui.cloudRuModel.replaceChildren(...options);
  ui.cloudRuModel.value = selectedModel;
  ui.cloudRuModel.disabled = Boolean(cloudRuStatus.checking)
    || !cloudRuStatus.checked
    || !cloudRuStatus.available
    || models.length === 0;

  if (cloudRuStatus.checking) {
    ui.cloudRuStatus.textContent = 'Проверяем Cloud.ru…';
    ui.cloudRuStatus.dataset.state = 'loading';
  } else if (!isTauri) {
    ui.cloudRuStatus.textContent = 'Проверка и анализ Cloud.ru доступны в настольном приложении.';
    ui.cloudRuStatus.dataset.state = 'idle';
  } else if (!cloudRuApiKey.trim()) {
    ui.cloudRuStatus.textContent = 'Введите API-ключ Cloud.ru.';
    ui.cloudRuStatus.dataset.state = 'idle';
  } else if (!cloudRuStatus.checked) {
    ui.cloudRuStatus.textContent = 'Ключ введён. Проверьте подключение.';
    ui.cloudRuStatus.dataset.state = 'idle';
  } else if (!cloudRuStatus.available || cloudRuStatus.error) {
    ui.cloudRuStatus.textContent = cloudRuStatus.message || 'Не удалось подключиться к Cloud.ru.';
    ui.cloudRuStatus.dataset.state = 'error';
  } else if (!models.length) {
    ui.cloudRuStatus.textContent = cloudRuStatus.message || 'Cloud.ru доступен, модели не найдены.';
    ui.cloudRuStatus.dataset.state = 'error';
  } else {
    ui.cloudRuStatus.textContent = cloudRuStatus.message || `Подключено · моделей: ${models.length}`;
    ui.cloudRuStatus.dataset.state = 'ready';
  }
  ui.checkCloudRuStatus.disabled = Boolean(cloudRuStatus.checking);
  ui.checkCloudRuStatus.textContent = cloudRuStatus.checking ? 'Проверяем…' : 'Проверить';
}

function redactProviderSecret(message, secret = '') {
  const text = String(message || 'Неизвестная ошибка.');
  return secret ? text.split(secret).join('[скрыт]') : text;
}

function refreshSelectedAiProviderStatus() {
  if (codexSettings.provider === 'ollama') return refreshOllamaStatus();
  if (codexSettings.provider === 'cloudru') return refreshCloudRuStatus();
  if (codexSettings.provider === 'yandex') return refreshYandexStatus();
  if (codexSettings.provider === 'claude') return refreshClaudeStatus();
  return refreshCodexStatus();
}

async function refreshCloudRuStatus() {
  const requestId = ++cloudRuStatusRequestId;
  const apiKey = cloudRuApiKey.trim();
  if (!isTauri) {
    cloudRuStatus = {
      checked: false,
      available: false,
      models: [],
      message: 'Проверка и анализ Cloud.ru доступны в настольном приложении.',
    };
    renderCloudRuStatus();
    return cloudRuStatus;
  }
  if (!apiKey) {
    cloudRuStatus = {
      checked: true,
      available: false,
      models: [],
      message: 'Введите API-ключ Cloud.ru.',
      error: true,
    };
    renderCloudRuStatus();
    return cloudRuStatus;
  }

  cloudRuStatus = { ...cloudRuStatus, checking: true, error: false };
  renderCloudRuStatus();
  try {
    const result = await invoke('get_cloudru_status', { apiKey });
    if (requestId !== cloudRuStatusRequestId) return cloudRuStatus;
    const models = Array.isArray(result?.models)
      ? result.models.filter((model) => typeof model === 'string' && model.trim()).map((model) => model.trim())
      : [];
    const selectedModel = models.includes(codexSettings.cloudRuModel)
      ? codexSettings.cloudRuModel
      : (models[0] || '');
    const modelChanged = selectedModel !== codexSettings.cloudRuModel;
    codexSettings.cloudRuModel = selectedModel;
    cloudRuStatus = {
      checked: true,
      available: result?.available === true,
      models,
      message: redactProviderSecret(result?.message, apiKey),
      checking: false,
      error: result?.available !== true,
    };
    if (modelChanged) saveCodexSettings();
  } catch (error) {
    if (requestId !== cloudRuStatusRequestId) return cloudRuStatus;
    cloudRuStatus = {
      checked: true,
      available: false,
      models: [],
      message: `Не удалось подключиться к Cloud.ru. ${redactProviderSecret(messageFrom(error), apiKey)}`,
      checking: false,
      error: true,
    };
  }
  renderCloudRuStatus();
  return cloudRuStatus;
}

function renderYandexStatus() {
  const models = yandexStatus.models;
  const savedModel = codexSettings.yandexModel;
  const selectedModel = models.includes(savedModel)
    ? savedModel
    : (!yandexStatus.checked && savedModel ? savedModel : '');
  const options = models.length
    ? models.map((model) => new Option(model, model))
    : [new Option(
      yandexStatus.checked && yandexStatus.available ? 'Модели не найдены' : 'Проверьте подключение',
      '',
      true,
      true,
    )];
  if (selectedModel && !models.includes(selectedModel)) options.unshift(new Option(selectedModel, selectedModel));
  ui.yandexModel.replaceChildren(...options);
  ui.yandexModel.value = selectedModel;
  ui.yandexModel.disabled = Boolean(yandexStatus.checking)
    || !yandexStatus.checked
    || !yandexStatus.available
    || models.length === 0;

  if (yandexStatus.checking) {
    ui.yandexStatus.textContent = 'Проверяем Yandex AI Studio…';
    ui.yandexStatus.dataset.state = 'loading';
  } else if (!isTauri) {
    ui.yandexStatus.textContent = 'Проверка и анализ Yandex AI Studio доступны в настольном приложении.';
    ui.yandexStatus.dataset.state = 'idle';
  } else if (!yandexApiKey.trim() || !codexSettings.yandexFolderId.trim()) {
    ui.yandexStatus.textContent = !yandexApiKey.trim()
      ? 'Введите API-ключ Yandex AI Studio.'
      : 'Введите ID каталога Yandex Cloud.';
    ui.yandexStatus.dataset.state = 'idle';
  } else if (!yandexStatus.checked) {
    ui.yandexStatus.textContent = 'Данные введены. Проверьте подключение.';
    ui.yandexStatus.dataset.state = 'idle';
  } else if (!yandexStatus.available || yandexStatus.error) {
    ui.yandexStatus.textContent = yandexStatus.message || 'Не удалось подключиться к Yandex AI Studio.';
    ui.yandexStatus.dataset.state = 'error';
  } else if (!models.length) {
    ui.yandexStatus.textContent = yandexStatus.message || 'Yandex AI Studio доступна, модели не найдены.';
    ui.yandexStatus.dataset.state = 'error';
  } else {
    ui.yandexStatus.textContent = yandexStatus.message || `Подключено · моделей: ${models.length}`;
    ui.yandexStatus.dataset.state = 'ready';
  }
  ui.checkYandexStatus.disabled = Boolean(yandexStatus.checking);
  ui.checkYandexStatus.textContent = yandexStatus.checking ? 'Проверяем…' : 'Проверить';
}

async function refreshYandexStatus() {
  const requestId = ++yandexStatusRequestId;
  const apiKey = yandexApiKey.trim();
  const folderId = codexSettings.yandexFolderId.trim();
  if (!isTauri) {
    yandexStatus = {
      checked: false,
      available: false,
      models: [],
      message: 'Проверка и анализ Yandex AI Studio доступны в настольном приложении.',
    };
    renderYandexStatus();
    return yandexStatus;
  }
  if (!apiKey || !folderId) {
    yandexStatus = {
      checked: true,
      available: false,
      models: [],
      message: !apiKey ? 'Введите API-ключ Yandex AI Studio.' : 'Введите ID каталога Yandex Cloud.',
      error: true,
    };
    renderYandexStatus();
    return yandexStatus;
  }

  yandexStatus = { ...yandexStatus, checking: true, error: false };
  renderYandexStatus();
  try {
    const result = await invoke('get_yandex_status', { apiKey, folderId });
    if (requestId !== yandexStatusRequestId) return yandexStatus;
    const models = Array.isArray(result?.models)
      ? result.models.filter((model) => typeof model === 'string' && model.trim()).map((model) => model.trim())
      : [];
    const selectedModel = models.includes(codexSettings.yandexModel)
      ? codexSettings.yandexModel
      : (models[0] || '');
    const modelChanged = selectedModel !== codexSettings.yandexModel;
    codexSettings.yandexModel = selectedModel;
    yandexStatus = {
      checked: true,
      available: result?.available === true,
      models,
      message: redactProviderSecret(result?.message, apiKey),
      checking: false,
      error: result?.available !== true,
    };
    if (modelChanged) saveCodexSettings();
  } catch (error) {
    if (requestId !== yandexStatusRequestId) return yandexStatus;
    yandexStatus = {
      checked: true,
      available: false,
      models: [],
      message: `Не удалось подключиться к Yandex AI Studio. ${redactProviderSecret(messageFrom(error), apiKey)}`,
      checking: false,
      error: true,
    };
  }
  renderYandexStatus();
  return yandexStatus;
}

function renderAiAnalysisNote() {
  let message = '';
  if (state.aiAnalysis === 'error' || state.aiAnalysis === 'unavailable') message = state.aiAnalysisMessage;
  ui.aiAnalysisMessage.textContent = message;
  ui.aiAnalysisNote.dataset.state = state.aiAnalysis;
  ui.aiAnalysisNote.hidden = !message;
  ui.showPartialAiReview.hidden = state.aiAnalysis !== 'error'
    || state.aiProgress?.phase !== 'discover'
    || !state.findings.some(isAiFinding);
  const canRetryAiAnalysis = state.analysis === 'done'
    && (state.aiAnalysis === 'error' || state.aiAnalysis === 'unavailable')
    && codexSettings.enabled;
  ui.retryAiAnalysis.hidden = !canRetryAiAnalysis;
  ui.retryAiAnalysis.disabled = !canRetryAiAnalysis;
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

function analysisIsBusy(tab) {
  return Boolean(tab && (tab.analysis === 'running'
    || tab.aiAnalysis === 'checking' || tab.aiAnalysis === 'running'));
}

function setAnalysisPauseState(tab, pauseState) {
  const wasPaused = tab.pauseState === 'paused';
  if (pauseState === 'paused') pauseSlowAnalysisWarning(tab);
  else if (wasPaused && pauseState === 'running') startSlowAnalysisWarning(tab);
  tab.pauseState = pauseState;
  if (tabById(tab.id) === tab && state.activeId === tab.id) reflectAnalysisTab(tab);
  else renderDocumentTabs();
}

function createAnalysisPauseController(tab) {
  let requested = false;
  let resume = null;
  return {
    pause() {
      requested = true;
      setAnalysisPauseState(tab, 'pause-requested');
    },
    resume() {
      requested = false;
      const release = resume;
      resume = null;
      if (release) release();
      setAnalysisPauseState(tab, 'running');
    },
    async checkpoint() {
      if (!requested) return;
      while (requested) {
        setAnalysisPauseState(tab, 'paused');
        await new Promise((resolve) => {
          resume = resolve;
          if (!requested) {
            resume = null;
            resolve();
          }
        });
      }
      setAnalysisPauseState(tab, 'running');
    },
  };
}

function renderAnalysisPauseControl() {
  const tab = tabById(state.activeId);
  const busy = analysisIsBusy(tab);
  const isResuming = tab?.pauseState === 'pause-requested' || tab?.pauseState === 'paused';
  ui.analysisPauseButton.hidden = !busy;
  ui.analysisPauseButton.setAttribute('aria-pressed', String(Boolean(busy && isResuming)));
  const label = isResuming ? 'Возобновить анализ' : 'Приостановить анализ';
  ui.analysisPauseButton.setAttribute('aria-label', label);
  ui.analysisPauseButton.title = label;
  ui.analysisPauseButton.querySelector('[data-pause-icon]').hidden = isResuming;
  ui.analysisPauseButton.querySelector('[data-resume-icon]').hidden = !isResuming;

  const waiting = tab?.pauseState === 'pause-requested';
  const paused = tab?.pauseState === 'paused';
  const pauseError = tab?.pauseMessage;
  ui.analysisPauseStatus.hidden = !busy || paused || (!waiting && !pauseError);
  ui.analysisPauseStatus.textContent = pauseError
    ? `Пауза недоступна: ${pauseError}`
    : waiting
    ? 'Ожидание безопасной точки паузы'
    : '';
}

async function setBrowserCodexPause(analysisId, paused, release = false) {
  const response = await fetch('/__norman/codex/pause', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ analysisId, paused, release }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `Не удалось изменить состояние паузы (${response.status}).`);
  }
}

async function toggleAnalysisPause() {
  const tab = tabById(state.activeId);
  if (!analysisIsBusy(tab) || !tab.analysisPauseId) return;
  tab.pauseMessage = '';

  const shouldPause = tab.pauseState !== 'pause-requested' && tab.pauseState !== 'paused';
  if (!shouldPause) {
    const previousPauseState = tab.pauseState;
    setAnalysisPauseState(tab, 'running');
    try {
      if (isTauri) {
        await invoke('set_analysis_paused', { analysisId: tab.analysisPauseId, paused: false });
      } else if (tab.aiAnalysis === 'checking' || tab.aiAnalysis === 'running') {
        await setBrowserCodexPause(tab.analysisPauseId, false);
      } else {
        tab.pauseController?.resume();
      }
    } catch (error) {
      tab.pauseMessage = messageFrom(error);
      setAnalysisPauseState(tab, previousPauseState);
    }
    return;
  }

  setAnalysisPauseState(tab, 'pause-requested');
  try {
    if (isTauri) {
      await invoke('set_analysis_paused', { analysisId: tab.analysisPauseId, paused: true });
    } else if (tab.aiAnalysis === 'checking' || tab.aiAnalysis === 'running') {
      await setBrowserCodexPause(tab.analysisPauseId, true);
    } else {
      tab.pauseController?.pause();
    }
  } catch (error) {
    tab.pauseMessage = messageFrom(error);
    setAnalysisPauseState(tab, 'running');
  }
}

async function releaseAnalysisPause(tab, analysisId = tab.analysisPauseId) {
  if (!analysisId) return;
  tab.pauseController?.resume();
  if (isTauri) {
    await invoke('release_analysis_pause', { analysisId }).catch(() => {});
  } else {
    await setBrowserCodexPause(analysisId, false, true).catch(() => {});
  }
  if (tab.analysisPauseId === analysisId) {
    tab.analysisPauseId = null;
    tab.pauseController = null;
    tab.pauseState = 'running';
    tab.pauseMessage = '';
  }
}

async function cancelAiAnalysis(tab, analysisId = tab.analysisPauseId) {
  if (!analysisId || !isTauri) return;
  await invoke('cancel_ai_analysis', { analysisId }).catch(() => {});
}

function renderProgress() {
  renderAiReviewDialog();
  const codexBusy = state.aiAnalysis === 'checking' || state.aiAnalysis === 'running';
  const activeTab = tabById(state.activeId);
  const paused = activeTab?.pauseState === 'paused';
  ui.analysisStatus.hidden = paused || (state.analysis !== 'running' && !codexBusy);

  const showCodexProgress = codexSettings.enabled
    && Boolean(state.document)
    && state.analysis !== 'idle'
    && (state.analysis === 'running' || state.aiAnalysis !== 'idle');
  ui.analysisProgress.hidden = !showCodexProgress;
  ui.analysisProgress.dataset.paused = String(paused);
  ui.analysisSlowWarning.hidden = !activeTab?.slowAnalysisWarning
    || (state.analysis !== 'running' && !codexBusy);
  renderAnalysisPauseControl();
  if (ui.analysisProgress.hidden) return;

  const aiProgress = state.aiProgress || {};
  const phase = aiProgress.phase;
  const ruleProgress = state.progress || {};
  const completedRules = Number(ruleProgress.completedRules ?? ruleProgress.completed_rules);
  const totalRules = Number(ruleProgress.totalRules ?? ruleProgress.total_rules);
  const completed = Number(aiProgress.completed);
  const total = Number(aiProgress.total);
  const ruleFraction = Number.isFinite(completedRules) && totalRules > 0
    ? Math.max(0, Math.min(1, completedRules / totalRules))
    : 0;
  const aiFraction = Number.isFinite(completed) && total > 0
    ? Math.max(0, Math.min(1, completed / total))
    : 0;
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
      progress: localStatus === 'complete' ? 1 : ruleFraction,
    },
    {
      label: 'Контекст',
      description: 'Проверяется контекст каждого найденного сигнала.',
      status: contextStatus,
      progress: contextStatus === 'complete' ? 1 : phase === 'verify' ? aiFraction : 0,
    },
    {
      label: 'Весь текст',
      description: 'Документ целиком проверяется на дополнительные сигналы.',
      status: globalStatus,
      progress: globalStatus === 'complete' ? 1 : phase === 'discover' ? aiFraction : 0,
    },
  ];

  const percentage = Math.round(stages.reduce((sum, stage) => sum + stage.progress, 0) / stages.length * 100);
  const hasError = stages.some((stage) => stage.status === 'error');
  ui.analysisProgress.dataset.state = stages.every((stage) => stage.status === 'complete')
    ? 'complete'
    : hasError ? 'error' : 'running';
  ui.analysisProgressBar.setAttribute('aria-valuenow', String(percentage));
  ui.analysisProgressBar.setAttribute('aria-valuetext', `${percentage}%`);
  const focusedStep = ui.analysisProgressSteps.contains(document.activeElement)
    ? Array.from(ui.analysisProgressSteps.children).indexOf(document.activeElement)
    : -1;
  let segments = Array.from(ui.analysisProgressFill.children);
  if (segments.length !== stages.length) {
    segments = stages.map(() => {
      const segment = document.createElement('span');
      segment.className = 'analysis-progress-segment';
      segment.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('span');
      fill.className = 'analysis-progress-segment-fill';
      segment.append(fill);
      return segment;
    });
    ui.analysisProgressFill.replaceChildren(...segments);
  }
  stages.forEach((stage, index) => {
    segments[index].dataset.state = stage.status;
    segments[index].firstElementChild.style.width = `${stage.progress * 100}%`;
  });

  const statusLabels = {
    complete: 'Завершено',
    running: 'Выполняется',
    pending: 'Ожидает',
    error: 'Ошибка',
    skipped: 'Пропущено',
  };
  let steps = Array.from(ui.analysisProgressSteps.children);
  if (steps.length !== stages.length) {
    steps = stages.map((stage, index) => {
      const item = document.createElement('li');
      item.className = 'analysis-step';
      item.tabIndex = 0;
      const mark = document.createElement('span');
      mark.className = 'analysis-step-mark';
      mark.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'analysis-step-label';
      const tooltip = document.createElement('span');
      tooltip.className = 'analysis-step-tooltip';
      tooltip.id = `analysisStepTooltip${index + 1}`;
      tooltip.setAttribute('role', 'tooltip');
      item.append(mark, label, tooltip);
      item.dataset.initialized = 'false';
      item.dataset.completed = String(stage.status === 'complete');
      return item;
    });
    ui.analysisProgressSteps.replaceChildren(...steps);
  }
  stages.forEach((stage, index) => {
    const item = steps[index];
    const [mark, label, tooltip] = item.children;
    const isComplete = stage.status === 'complete';
    const wasComplete = item.dataset.completed === 'true';
    if (item.dataset.initialized === 'true' && isComplete && !wasComplete) {
      mark.classList.remove('is-completing');
      void mark.offsetWidth;
      mark.classList.add('is-completing');
    } else if (!isComplete) {
      mark.classList.remove('is-completing');
    }
    item.dataset.state = stage.status;
    item.dataset.completed = String(isComplete);
    item.dataset.initialized = 'true';
    item.setAttribute('aria-label', `${stage.label}: ${statusLabels[stage.status]}`);
    item.setAttribute('aria-describedby', tooltip.id);
    mark.dataset.state = isComplete ? 'complete' : 'pending';
    label.textContent = stage.label;
    tooltip.textContent = stage.description;
  });
  if (focusedStep >= 0) ui.analysisProgressSteps.children[focusedStep]?.focus({ preventScroll: true });
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
  const standardReason = String(finding.reason || '').trim();
  const aiRationale = aiFinding && !rejectedByAi
    ? String(finding.aiRationale || '').trim()
    : '';
  const reason = rejectedByAi
    ? `Причина отсева: ${rejectionReason}`
    : standardReason && standardReason !== aiRationale
      ? standardReason
      : aiRationale ? '' : standardReason || 'Совпадение правила требует проверки в контексте.';
  return {
    aiFinding,
    aiRationale,
    aiProvider: String(finding.aiProvider || (String(finding.origin || '').toLocaleLowerCase() === 'ollama' ? 'ollama' : 'codex')),
    fullTitle,
    shortTitle,
    location,
    reason,
    rejectedByAi,
    confidence: findingConfidenceLevel(finding),
    origin: String(finding.origin || (finding.aiConfidence != null ? 'algorithm' : 'codex')).toLocaleLowerCase(),
    signature: JSON.stringify([
      fullTitle, location, finding.factor || '', finding.excerpt || '', reason, aiRationale,
      aiFinding, finding.confidence || '', finding.aiConfidence || '', finding.origin || '', finding.aiProvider || '',
    ]),
  };
}

function aiReviewConfidenceLabel(value) {
  return ({
    high: 'Высокая уверенность',
    medium: 'Средняя уверенность',
    low: 'Низкая уверенность',
    'likely-false': 'Сигнал не подтверждён',
    unknown: 'Уверенность не указана',
  })[aiConfidenceLevel(value)];
}

function findingVerifyStatus(key) {
  const entries = state.findings.map((finding, index) => ({ finding, key: findingKey(finding, index) }));
  return findingVerificationStatuses(entries).get(key) || null;
}

function openAiReview(key) {
  if (!state.findings.some((finding, index) => findingKey(finding, index) === key)) return;
  const activeTab = tabById(state.activeId);
  const finding = state.findings.find((item, index) => findingKey(item, index) === key);
  const failed = Boolean(finding?.id && activeTab?.aiFailure?.findingIds?.includes(String(finding.id)));
  ui.aiReviewSingleContent.hidden = false;
  ui.aiReviewResultsList.hidden = true;
  ui.aiReviewResultsList.replaceChildren();
  ui.aiReviewLiveStatus.dataset.findingKey = key;
  ui.aiReviewLiveStatus.dataset.watching = String(failed || ['active', 'queued'].includes(findingVerifyStatus(key)));
  ui.aiReviewLiveStatus.dataset.lastStage = '';
  ui.aiReviewLiveMessages.replaceChildren();
  ui.aiReviewDialog.showModal();
  renderAiReviewDialog();
}

function recordAiReviewDuration(tab, findingId, reviewNumber) {
  const startedAt = tab.aiReviewStepStartedAt.get(findingId);
  if (startedAt === undefined) return null;

  const durationMs = Math.max(0, performance.now() - startedAt);
  const durations = tab.aiReviewDurations.get(findingId) || new Map();
  durations.set(reviewNumber, durationMs);
  tab.aiReviewDurations.set(findingId, durations);
  tab.aiReviewStepStartedAt.delete(findingId);
  return durationMs;
}

function updateAiReviewProgress(tab, token, payload = {}) {
  if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
  if (payload.analysisId !== `${tab.id}:${token}`) return;

  const findingId = String(payload.findingId || '');
  const reviewNumber = Number(payload.reviewNumber);
  const summary = String(payload.summary || '').trim();
  if (!findingId || ![1, 2, 3].includes(reviewNumber) || !summary) return;
  if (typeof payload.signalSupported !== 'boolean') return;

  recordAiReviewDuration(tab, findingId, reviewNumber);
  const updates = tab.aiReviewUpdates.get(findingId) || new Map();
  updates.set(reviewNumber, {
    reviewNumber,
    signalSupported: payload.signalSupported,
    summary: summary.length > 500 ? `${summary.slice(0, 497)}…` : summary,
  });
  tab.aiReviewUpdates.set(findingId, updates);
  const streams = tab.aiReviewStreams.get(findingId);
  const stream = streams?.get(reviewNumber);
  if (stream) stream.complete = true;

  if (ui.aiReviewDialog.open && ui.aiReviewLiveStatus.dataset.findingKey === findingId) {
    renderAiReviewDialog();
  }
}

let aiReviewStreamRenderTimer = null;

function scheduleAiReviewStreamRender() {
  if (aiReviewStreamRenderTimer !== null) return;
  aiReviewStreamRenderTimer = window.setTimeout(() => {
    aiReviewStreamRenderTimer = null;
    const activeTab = tabById(state.activeId);
    const key = ui.aiReviewLiveStatus.dataset.findingKey;
    if (ui.aiReviewDialog.open && (activeTab?.aiReviewStreams.has(key) || activeTab?.aiReviewOutputs.has(key))) {
      renderAiReviewDialog();
    }
  }, 100);
}

function updateAiReviewStream(tab, token, payload = {}) {
  if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
  if (payload.analysisId !== `${tab.id}:${token}`) return;

  const findingId = String(payload.findingId || '');
  const reviewNumber = Number(payload.reviewNumber);
  if (!findingId || ![1, 2, 3].includes(reviewNumber)) return;
  const delta = typeof payload.text === 'string' ? payload.text : '';
  if (!delta && payload.reset !== true) return;

  if (payload.channel === 'answer') {
    const outputs = tab.aiReviewOutputs.get(findingId) || new Map();
    const previous = outputs.get(reviewNumber) || { text: '', pendingText: '' };
    let text = payload.reset === true ? '' : `${previous.text}${delta}`;
    if (text.length > 64_000) text = text.slice(-48_000);
    let pendingText = payload.reset === true ? '' : `${previous.pendingText || ''}${delta}`;
    if (pendingText.length > 64_000) pendingText = text;
    outputs.set(reviewNumber, { text, pendingText });
    tab.aiReviewOutputs.set(findingId, outputs);
    if (ui.aiReviewDialog.open && ui.aiReviewLiveStatus.dataset.findingKey === findingId) {
      scheduleAiReviewStreamRender();
    }
    return;
  }
  if (payload.channel !== 'thinking') return;

  const streams = tab.aiReviewStreams.get(findingId) || new Map();
  const previous = streams.get(reviewNumber) || { text: '', pendingText: '', complete: false, reset: true };
  let text = payload.reset === true ? '' : `${previous.text}${delta}`;
  if (text.length > 64_000) {
    const trimTo = text.length - 48_000;
    const nextLine = text.indexOf('\n', trimTo);
    text = text.slice(nextLine >= 0 ? nextLine + 1 : trimTo);
  }
  let pendingText = payload.reset === true ? '' : `${previous.pendingText || ''}${delta}`;
  let reset = payload.reset === true || previous.reset === true;
  if (pendingText.length > 64_000) {
    pendingText = text;
    reset = true;
  }
  streams.set(reviewNumber, {
    text,
    pendingText,
    reset,
    complete: false,
  });
  tab.aiReviewStreams.set(findingId, streams);

  if (ui.aiReviewDialog.open && ui.aiReviewLiveStatus.dataset.findingKey === findingId) {
    scheduleAiReviewStreamRender();
  }
}

function appendAiReviewMarkdownInline(target, text) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*]+\*|_[^_]+_)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      target.append(document.createTextNode(text.slice(cursor, index)));
    }
    const token = match[0];
    const delimiter = token.startsWith('**') || token.startsWith('__')
      ? 2
      : token.startsWith('~~') || token.startsWith('`') ? 1 : 1;
    const content = token.slice(delimiter, -delimiter);
    const element = token.startsWith('`')
      ? document.createElement('code')
      : token.startsWith('~~')
        ? document.createElement('del')
        : delimiter === 2
          ? document.createElement('strong')
          : document.createElement('em');
    element.textContent = content;
    target.append(element);
    cursor = index + token.length;
  }
  if (cursor < text.length) {
    target.append(document.createTextNode(text.slice(cursor)));
  }
}

function appendAiReviewMarkdownLine(thought, line) {
  const trimmed = line.trim();
  if (thought.dataset.inCodeFence === 'true') {
    if (/^```/.test(trimmed)) {
      thought.dataset.inCodeFence = 'false';
      thought.dataset.lastBlock = '';
      return;
    }
    let pre = thought.lastElementChild;
    if (!pre?.classList.contains('ai-review-markdown-code')) {
      pre = document.createElement('pre');
      pre.className = 'ai-review-markdown-code';
      const code = document.createElement('code');
      pre.append(code);
      thought.append(pre);
    }
    pre.querySelector('code').append(document.createTextNode(`${line}\n`));
    return;
  }

  if (/^```/.test(trimmed)) {
    thought.dataset.inCodeFence = 'true';
    thought.dataset.lastBlock = 'code';
    return;
  }
  if (!trimmed) {
    thought.dataset.lastBlock = '';
    return;
  }

  const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
  if (heading) {
    const element = document.createElement(`h${heading[1].length + 1}`);
    element.className = 'ai-review-markdown-heading ai-review-markdown-enter';
    appendAiReviewMarkdownInline(element, heading[2]);
    thought.append(element);
    thought.dataset.lastBlock = 'heading';
    return;
  }

  const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
  const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
  if (unordered || ordered) {
    const tagName = unordered ? 'ul' : 'ol';
    let list = thought.dataset.lastBlock === tagName ? thought.lastElementChild : null;
    if (!list || list.tagName.toLowerCase() !== tagName) {
      list = document.createElement(tagName);
      list.className = 'ai-review-markdown-list';
      thought.append(list);
    }
    const item = document.createElement('li');
    item.className = 'ai-review-markdown-enter';
    appendAiReviewMarkdownInline(item, (unordered || ordered)[1]);
    list.append(item);
    thought.dataset.lastBlock = tagName;
    return;
  }

  const quote = trimmed.match(/^>\s?(.*)$/);
  if (quote) {
    let blockquote = thought.dataset.lastBlock === 'blockquote' ? thought.lastElementChild : null;
    if (!blockquote || blockquote.tagName !== 'BLOCKQUOTE') {
      blockquote = document.createElement('blockquote');
      blockquote.className = 'ai-review-markdown-quote';
      thought.append(blockquote);
    }
    const paragraph = document.createElement('p');
    paragraph.className = 'ai-review-markdown-enter';
    appendAiReviewMarkdownInline(paragraph, quote[1]);
    blockquote.append(paragraph);
    thought.dataset.lastBlock = 'blockquote';
    return;
  }

  const paragraph = document.createElement('p');
  paragraph.className = 'ai-review-markdown-paragraph ai-review-markdown-enter';
  appendAiReviewMarkdownInline(paragraph, line);
  thought.append(paragraph);
  thought.dataset.lastBlock = 'paragraph';
}

function trimAiReviewMarkdownHistory(thought) {
  while (thought.textContent.length > 48_000) {
    const first = thought.firstElementChild;
    if (!first) break;
    if (['UL', 'OL', 'BLOCKQUOTE'].includes(first.tagName) && first.firstElementChild) {
      first.firstElementChild.remove();
      if (!first.firstElementChild) first.remove();
      continue;
    }
    if (first === thought.lastElementChild) break;
    first.remove();
  }
}

function updateAiReviewMarkdownStream(thought, added, complete) {
  const finalizePendingLine = () => {
    const line = thought.dataset.pendingLine || '';
    thought.lastElementChild?.classList.contains('ai-review-markdown-pending')
      && thought.lastElementChild.remove();
    thought.dataset.pendingLine = '';
    appendAiReviewMarkdownLine(thought, line);
  };

  const segments = added.split('\n');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment) {
      let pending = thought.lastElementChild;
      if (!pending?.classList.contains('ai-review-markdown-pending')) {
        pending = document.createElement('p');
        pending.className = 'ai-review-markdown-pending';
        pending.append(document.createTextNode(''));
        thought.append(pending);
      }
      let pendingLine = `${thought.dataset.pendingLine || ''}${segment}`;
      if (pendingLine.length > 48_000) pendingLine = `…${pendingLine.slice(-47_999)}`;
      thought.dataset.pendingLine = pendingLine;
      pending.firstChild.nodeValue = thought.dataset.pendingLine;
    }
    if (index < segments.length - 1) finalizePendingLine();
  }
  if (complete && thought.dataset.pendingLine) finalizePendingLine();
  trimAiReviewMarkdownHistory(thought);
  if (thought.dataset.followLatest !== 'false') thought.scrollTop = thought.scrollHeight;
}

function renderAiReviewDialog() {
  if (!ui.aiReviewDialog.open) return;
  const key = ui.aiReviewLiveStatus.dataset.findingKey;
  if (!key) return;
  const index = state.findings.findIndex((finding, itemIndex) => findingKey(finding, itemIndex) === key);
  if (index < 0) return;
  const finding = state.findings[index];
  const activeTab = tabById(state.activeId);
  const failure = activeTab?.aiFailure;
  const failed = Boolean(finding.id && failure?.findingIds?.includes(String(finding.id)));
  const reviewUpdates = [...(activeTab?.aiReviewUpdates?.get(key)?.values() || [])]
    .sort((left, right) => left.reviewNumber - right.reviewNumber);
  const reviewStreams = activeTab?.aiReviewStreams?.get(key) || new Map();
  const reviewOutputs = activeTab?.aiReviewOutputs?.get(key) || new Map();
  const verifyStatus = findingVerifyStatus(key);
  const isChecking = verifyStatus === 'active' || verifyStatus === 'queued';
  const watching = ui.aiReviewLiveStatus.dataset.watching === 'true';
  const providerLabel = aiProviderLabel(finding.aiProvider || codexSettings.provider);
  const confidence = aiConfidenceLevel(finding.aiConfidence);
  const hasResult = finding.aiConfidence != null || Boolean(finding.aiRationale || finding.aiRejectionReason);
  ui.aiReviewTitle.textContent = `${failed ? 'Сбой проверки' : isChecking ? 'Проверка' : 'Оценка'} · ${providerLabel}`;
  ui.aiReviewExcerpt.textContent = finding.excerpt || 'Фрагмент не сохранён.';
  const ruleExplanation = String(finding.reason || '').trim();
  ui.aiReviewRuleExplanation.textContent = ruleExplanation;
  ui.aiReviewRuleSection.hidden = !ruleExplanation;
  ui.aiReviewResultSection.hidden = !hasResult;
  ui.aiReviewConfidenceMarker.textContent = findingConfidenceMarker(confidence);
  ui.aiReviewResultSection.querySelector('.ai-review-result').dataset.confidence = confidence;
  ui.aiReviewConfidence.textContent = hasResult ? aiReviewConfidenceLabel(finding.aiConfidence) : 'Проверяется';
  ui.aiReviewDecision.textContent = !hasResult
    ? 'Ожидайте завершения проверки сигнала.'
    : confidence === 'likely-false'
      ? `${providerLabel} не подтвердил сигнал; при необходимости его можно проверить вручную.`
      : 'Возможный сигнал; требуется экспертная проверка.';
  const rationaleText = String((confidence === 'likely-false' && finding.aiRejectionReason)
    || finding.aiRationale || '').trim();

  const pauseRequested = activeTab?.pauseState === 'pause-requested';
  const paused = activeTab?.pauseState === 'paused';
  let message = '';
  let stage = '';
  if (verifyStatus === 'queued') {
    stage = 'queued';
    message = 'Сигнал ожидает свободного процесса проверки.';
  } else if (verifyStatus === 'active' && pauseRequested) {
    stage = 'pause-requested';
    message = 'Пауза запрошена. Текущая проверка завершится перед остановкой.';
  } else if (isChecking && paused) {
    stage = 'paused';
    message = 'Анализ приостановлен и продолжится после возобновления.';
  } else if (verifyStatus === 'active') {
    stage = '';
  } else if (watching && hasResult && reviewUpdates.length === 0) {
    stage = 'complete';
    message = 'Проверка завершена. Результат показан ниже.';
  } else if (watching && state.aiAnalysis === 'running' && !hasResult) {
    stage = 'waiting';
    message = 'Ожидаю результат проверки сигнала.';
  } else if (failed) {
    stage = 'error';
    message = `Проверка сигнала прервана: ${failure.message}`;
  } else if (watching && ['error', 'unavailable'].includes(state.aiAnalysis)) {
    stage = 'error';
    message = 'Проверка прервана до получения результата. Локальный сигнал сохранён.';
  }
  if (hasResult) {
    const waitingMessage = [...ui.aiReviewLiveMessages.children]
      .find((entry) => entry.dataset.stage === 'waiting'
        || entry.textContent === 'Ожидаю результат проверки сигнала.');
    waitingMessage?.remove();
    if (ui.aiReviewLiveStatus.dataset.lastStage === 'waiting') {
      ui.aiReviewLiveStatus.dataset.lastStage = '';
    }
  }
  if (stage && ui.aiReviewLiveStatus.dataset.lastStage !== stage) {
    const entry = document.createElement('li');
    entry.className = 'ai-review-chat-message';
    entry.dataset.stage = stage;
    entry.textContent = message;
    ui.aiReviewLiveMessages.append(entry);
    ui.aiReviewLiveStatus.dataset.lastStage = stage;
  }
  const reviewNumbers = [...new Set([
    ...reviewUpdates.map((update) => update.reviewNumber),
    ...reviewStreams.keys(),
    ...reviewOutputs.keys(),
  ])].sort((left, right) => left - right);
  for (const reviewNumber of reviewNumbers) {
    const update = reviewUpdates.find((item) => item.reviewNumber === reviewNumber);
    const stream = reviewStreams.get(reviewNumber);
    const selector = `[data-review-number="${reviewNumber}"]`;
    let entry = ui.aiReviewLiveMessages.querySelector(selector);
    if (!entry) {
      entry = document.createElement('li');
      entry.className = 'ai-review-chat-message ai-review-chat-review';
      entry.dataset.reviewNumber = String(reviewNumber);
      const details = document.createElement('details');
      details.className = 'ai-review-chat-details';
      details.open = false;
      const detailsLabel = document.createElement('summary');
      detailsLabel.textContent = 'Рассуждение ИИ';
      const thought = document.createElement('div');
      thought.className = 'ai-review-chat-review-stream';
      thought.dataset.followLatest = 'true';
      thought.addEventListener('scroll', () => {
        const distanceToBottom = thought.scrollHeight - thought.clientHeight - thought.scrollTop;
        thought.dataset.followLatest = String(distanceToBottom <= 18);
      });
      details.addEventListener('toggle', () => {
        if (details.open && thought.dataset.followLatest !== 'false') {
          requestAnimationFrame(() => {
            if (details.open && thought.dataset.followLatest !== 'false') {
              thought.scrollTop = thought.scrollHeight;
            }
          });
        }
      });
      const summary = document.createElement('p');
      summary.className = 'ai-review-chat-review-summary';
      details.append(detailsLabel, thought, summary);
      entry.append(details);
      ui.aiReviewLiveMessages.append(entry);
    }
    const details = entry.querySelector('.ai-review-chat-details');
    const detailsLabel = details.querySelector('summary');
    const thought = entry.querySelector('.ai-review-chat-review-stream');
    const summary = entry.querySelector('.ai-review-chat-review-summary');
    const complete = Boolean(stream?.complete || update);
    detailsLabel.textContent = complete ? 'Показать ход рассуждения' : 'Модель рассуждает';
    const durationMs = activeTab?.aiReviewDurations.get(key)?.get(reviewNumber);
    if ((complete || failed) && Number.isFinite(durationMs)) {
      const elapsedSeconds = Math.max(1, Math.round(durationMs / 1000));
      const duration = document.createElement('span');
      duration.className = 'ai-review-chat-duration';
      duration.textContent = elapsedSeconds >= 60
        ? `${Math.floor(elapsedSeconds / 60)} мин ${elapsedSeconds % 60} с`
        : `${elapsedSeconds} с`;
      detailsLabel.append(duration);
    }
    const nextThought = stream?.text || (complete ? '' : 'Ожидаю текст рассуждения…');
    if (stream && (stream.reset || thought.dataset.initialized !== 'true')) {
      const shouldFollowLatest = thought.dataset.followLatest !== 'false';
      thought.replaceChildren();
      thought.dataset.pendingLine = '';
      thought.dataset.inCodeFence = 'false';
      thought.dataset.lastBlock = '';
      thought.dataset.followLatest = String(shouldFollowLatest);
      updateAiReviewMarkdownStream(thought, stream.text, complete);
      thought.dataset.initialized = 'true';
      stream.pendingText = '';
      stream.reset = false;
    } else if (stream?.pendingText) {
      const added = stream.pendingText;
      stream.pendingText = '';
      updateAiReviewMarkdownStream(thought, added, complete);
    } else if (complete) {
      updateAiReviewMarkdownStream(thought, '', true);
    } else if (!stream && thought.dataset.initialized !== 'true' && nextThought) {
      thought.replaceChildren(document.createTextNode(nextThought));
      thought.dataset.initialized = 'true';
    }
    thought.classList.toggle('is-streaming', !complete && Boolean(stream?.text));
    thought.hidden = !stream?.text;
    summary.textContent = update?.summary || '';
    summary.hidden = !update?.summary;

    let answer = entry.querySelector('.ai-review-chat-answer');
    if (!answer) {
      answer = document.createElement('div');
      answer.className = 'ai-review-chat-answer';
      const answerLabel = document.createElement('strong');
      answerLabel.className = 'ai-review-chat-answer-label';
      const answerText = document.createElement('pre');
      answerText.className = 'ai-review-chat-answer-text';
      answer.append(answerLabel, answerText);
      entry.append(answer);
    }
    const output = reviewOutputs.get(reviewNumber);
    const answerText = answer.querySelector('.ai-review-chat-answer-text');
    answer.querySelector('.ai-review-chat-answer-label').textContent = failed
      ? 'Ответ, полученный до сбоя'
      : 'Ответ модели';
    answerText.textContent = output?.text
      || (failed ? 'Модель не успела передать структурированный ответ. Сохранён доступный ход рассуждений.' : '');
    answer.hidden = !output?.text && !failed;
    if (output?.pendingText) output.pendingText = '';
  }
  let rationaleEntry = ui.aiReviewLiveMessages.querySelector('.ai-review-chat-rationale');
  if (hasResult && rationaleText) {
    if (!rationaleEntry) {
      rationaleEntry = document.createElement('li');
      rationaleEntry.className = 'ai-review-chat-message ai-review-chat-rationale';
      const label = document.createElement('strong');
      label.className = 'ai-review-chat-rationale-label';
      label.textContent = 'Обоснование результата';
      const text = document.createElement('p');
      text.className = 'ai-review-rationale';
      rationaleEntry.append(label, text);
    }
    rationaleEntry.querySelector('.ai-review-rationale').textContent = rationaleText;
    if (ui.aiReviewLiveMessages.lastElementChild !== rationaleEntry) {
      ui.aiReviewLiveMessages.append(rationaleEntry);
    }
  } else {
    rationaleEntry?.remove();
  }
  const hasReviewHistory = reviewNumbers.length > 0 || Boolean(hasResult && rationaleText);
  ui.aiReviewLiveStatus.hidden = !isChecking && !hasReviewHistory
    && !(watching && (hasResult || stage || failed));
  ui.aiReviewLiveTyping.hidden = verifyStatus !== 'active' || paused;
  const typingLabel = ui.aiReviewLiveTyping.querySelector('.ai-review-typing-label');
  if (reviewUpdates.length === 0) {
    typingLabel.textContent = 'Модель готовит первую оценку';
  } else {
    typingLabel.textContent = 'Модель завершает оценку';
  }
}

function openAiReviewResults() {
  ui.aiReviewLiveStatus.dataset.findingKey = '';
  ui.aiReviewLiveStatus.dataset.watching = 'false';
  ui.aiReviewLiveStatus.hidden = true;
  ui.aiReviewLiveTyping.hidden = true;
  const findings = state.findings.filter(isAiFinding);
  if (!findings.length) return;

  ui.aiReviewResultsList.replaceChildren(...findings.map((finding) => {
    const data = findingRowData(finding);
    const confidence = aiConfidenceLevel(finding.aiConfidence);
    const item = document.createElement('li');
    item.className = 'ai-review-result-card';

    const title = document.createElement('h3');
    title.className = 'ai-review-result-title';
    title.textContent = data.shortTitle;

    const excerpt = document.createElement('blockquote');
    excerpt.className = 'ai-review-excerpt';
    excerpt.textContent = finding.excerpt || 'Фрагмент не сохранён.';

    const result = document.createElement('div');
    result.className = 'ai-review-result';
    const resultLabel = document.createElement('strong');
    resultLabel.textContent = aiReviewConfidenceLabel(finding.aiConfidence);
    const decision = document.createElement('p');
    decision.className = 'ai-review-decision';
    decision.textContent = confidence === 'likely-false'
      ? `${aiProviderLabel(finding.aiProvider)} не подтвердил сигнал; при необходимости его можно проверить вручную.`
      : 'Возможный сигнал; требуется экспертная проверка.';
    result.append(resultLabel, decision);

    const reasoning = document.createElement('details');
    reasoning.className = 'ai-review-reasoning';
    const summary = document.createElement('summary');
    summary.textContent = 'Рассуждение ИИ';
    const rationale = document.createElement('p');
    rationale.className = 'ai-review-rationale';
    rationale.textContent = (confidence === 'likely-false' && finding.aiRejectionReason)
      || finding.aiRationale
      || 'Рассуждение не сохранено.';
    reasoning.append(summary, rationale);

    item.append(title, excerpt, result, reasoning);
    return item;
  }));
  ui.aiReviewSingleContent.hidden = true;
  ui.aiReviewResultsList.hidden = false;
  ui.aiReviewTitle.textContent = 'Результаты проверки ИИ';
  ui.aiReviewDialog.showModal();
}

function aiProviderLabel(provider) {
  switch (String(provider || '').toLocaleLowerCase()) {
    case 'ollama': return 'Ollama';
    case 'claude': return 'Claude Code';
    case 'cloudru': return 'Cloud.ru';
    case 'yandex': return 'Yandex AI Studio';
    default: return 'ChatGPT (Codex)';
  }
}

function findingAriaLabel(finding, data, verifyStatus) {
  return [
    data.fullTitle,
    data.location,
    `Уровень ${findingConfidenceMarker(data.confidence)}`,
    data.aiFinding ? `Уверенность ${data.aiProvider} ${aiConfidenceLabel(finding.aiConfidence)}` : 'Возможно нарушение',
    verifyStatus === 'active' ? 'Проверяется' : verifyStatus === 'queued' ? 'В очереди' : '',
    verifyStatus === 'error' ? 'Проверка ИИ прервана, сигнал отмечен как сбойный' : '',
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
  const data = findingRowData(finding);
  syncFindingReviewControl(item, item.dataset.findingKey, finding, data, verifyStatus);
  setFindingVerifyStatus(item, finding, data, verifyStatus);
}

function syncFindingReviewControl(item, key, finding, data, verifyStatus) {
  const meta = item.querySelector('.finding-meta');
  let control = meta.querySelector('.finding-origin');
  const failed = verifyStatus === 'error';
  const show = data.aiFinding || verifyStatus === 'active' || failed;
  if (!show) {
    control?.remove();
    return;
  }
  if (!control) {
    control = document.createElement('button');
    control.type = 'button';
    control.className = 'finding-origin';
    control.dataset.aiReviewFinding = key;
    control.setAttribute('aria-haspopup', 'dialog');
    meta.append(control);
  }
  const providerLabel = aiProviderLabel(data.aiProvider || codexSettings.provider);
  control.textContent = failed ? 'Ошибка' : data.aiFinding
    ? providerLabel === 'ChatGPT (Codex)' ? 'Codex' : providerLabel
    : 'Проверяется';
  control.title = failed
    ? 'Показать сохранённый ответ модели и ход рассуждений до сбоя'
    : data.aiFinding
    ? 'Показать входные данные и результат проверки'
    : 'Показать ход проверки сигнала';
  control.setAttribute('aria-label', failed
    ? `Показать ответ модели и ход рассуждений до сбоя на сигнале «${data.fullTitle}»`
    : data.aiFinding
    ? `Показать данные проверки ${providerLabel}`
    : 'Показать ход проверки сигнала');
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
  if (data.reason && !(data.aiRationale && !data.rejectedByAi)) details.append(reason);
  if (data.aiRationale) {
    const aiExplanation = document.createElement('div');
    aiExplanation.className = 'finding-ai-explanation';
    const label = document.createElement('span');
    label.className = 'finding-explanation-label';
    label.textContent = 'Обоснование AI';
    const rationale = document.createElement('span');
    rationale.className = 'finding-ai-rationale';
    rationale.textContent = data.aiRationale;
    aiExplanation.append(label, rationale);
    details.append(aiExplanation);
  }
  item.append(button, details);
  syncFindingReviewControl(item, key, finding, data, verifyStatus);
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
  const failedIds = new Set((state.aiFailure?.findingIds || []).map(String));
  if (state.aiAnalysis === 'error' && failedIds.size) {
    return new Map(entries
      .filter(({ finding }) => failedIds.has(String(finding.id || '')))
      .map(({ key }) => [key, 'error']));
  }

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
  ui.exportReportPdf.hidden = !(codexSettings.enabled && state.aiAnalysis === 'done' && state.document);
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
  const activeFindingIds = progress?.phase === 'verify'
    ? new Set((progress.activeFindingIds || []).map(String))
    : new Set();
  const previousActiveFindingIds = tab.aiProgress?.phase === 'verify'
    ? (tab.aiProgress.activeFindingIds || []).map(String)
    : [];
  for (const findingId of previousActiveFindingIds) {
    if (!activeFindingIds.has(findingId)) recordAiReviewDuration(tab, findingId, 1);
  }
  for (const findingId of activeFindingIds) {
    if (!tab.aiReviewStepStartedAt.has(findingId)
      && !tab.aiReviewDurations.get(findingId)?.has(1)) {
      tab.aiReviewStepStartedAt.set(findingId, performance.now());
    }
  }
  tab.aiProgress = progress || null;
  reflectAnalysisTab(tab);
}

function updateAiFinding(tab, token, finding, provider) {
  if (tabById(tab.id) !== tab || token !== tab.analysisToken || !finding) return;
  appendFindings([{ ...finding, aiProvider: provider }], tab);
  reflectAnalysisTab(tab);
}

async function analyzeAiInBrowser(path, providerLabel, input, onProgress, onFinding, onPauseState, onReviewStream, signal) {
  const response = await fetch(path, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      Accept: 'application/x-ndjson',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
    signal,
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
      throw new Error(`Ответ адаптера ${providerLabel} имеет неверный формат.`);
    }
    if (event.type === 'progress') onProgress(event.payload || {});
    else if (event.type === 'finding') onFinding(event.payload?.finding);
    else if (event.type === 'pause') onPauseState(Boolean(event.payload?.paused));
    else if (event.type === 'review-stream') onReviewStream(event.payload || {});
    else if (event.type === 'review-update') onReviewStream({ ...event.payload, complete: true });
    else if (event.type === 'complete') complete = event.payload || {};
    else if (event.type === 'error') {
      const error = new Error(event.payload?.message || `Проверка ${providerLabel} не завершилась.`);
      if (typeof event.payload?.findingId === 'string') error.findingId = event.payload.findingId;
      throw error;
    }
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
    throw new Error(`Адаптер ${providerLabel} завершил поток без итогового списка сигналов.`);
  }
  return complete;
}

async function executeAiReview(tab, token, parallelProcesses) {
  tab.aiReviewUpdates.clear();
  tab.aiReviewStreams.clear();
  tab.aiReviewOutputs.clear();
  tab.aiReviewStepStartedAt.clear();
  tab.aiReviewDurations.clear();
  tab.aiFailure = null;
  tab.aiReviewAbortController?.abort();
  const requestController = new AbortController();
  tab.aiReviewAbortController = requestController;
  tab.aiAnalysis = 'checking';
  tab.aiAnalysisMessage = '';
  tab.aiProgress = null;
  reflectAnalysisTab(tab);

  const provider = codexSettings.provider;
  const providerLabel = aiProviderLabel(provider);
  const status = provider === 'ollama'
    ? await refreshOllamaStatus()
    : provider === 'cloudru' ? await refreshCloudRuStatus()
      : provider === 'yandex' ? await refreshYandexStatus()
        : provider === 'claude' ? await refreshClaudeStatus() : await refreshCodexStatus();
  if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
  if (!codexSettings.enabled) {
    tab.aiAnalysis = 'idle';
    tab.aiAnalysisMessage = '';
    return;
  }
  const codexAvailable = codexPayloadIsAvailable(status);
  const claudeAvailable = status?.checked === true
    && status.installed === true
    && status.authenticated === true;
  const ollamaAvailable = status?.checked === true
    && status.available === true
    && status.models.includes(codexSettings.ollamaModel);
  const cloudRuAvailable = status?.checked === true
    && status.available === true
    && status.models.includes(codexSettings.cloudRuModel);
  const yandexAvailable = status?.checked === true
    && status.available === true
    && status.models.includes(codexSettings.yandexModel);
  if ((provider === 'codex' && !codexAvailable)
    || (provider === 'claude' && !claudeAvailable)
    || (provider === 'ollama' && !ollamaAvailable)
    || (provider === 'cloudru' && !cloudRuAvailable)
    || (provider === 'yandex' && !yandexAvailable)) {
    tab.aiAnalysis = 'unavailable';
    tab.aiAnalysisMessage = status.message || (provider === 'ollama'
      ? 'Выберите установленную модель Ollama. Локальные результаты сохранены.'
      : provider === 'cloudru'
        ? 'Проверьте API-ключ и модель Cloud.ru. Локальные результаты сохранены.'
        : provider === 'yandex'
          ? 'Проверьте API-ключ, ID каталога и модель Yandex AI Studio. Локальные результаты сохранены.'
          : provider === 'claude'
            ? !status.installed
              ? 'Claude Code CLI не найден. Локальные результаты сохранены.'
              : 'Войдите в Claude Code CLI. Локальные результаты сохранены.'
          : !status.installed
            ? 'Codex CLI не найден. Локальные результаты сохранены.'
            : 'Войдите в Codex CLI. Локальные результаты сохранены.');
    return;
  }

  tab.aiAnalysis = 'running';
  tab.aiAnalysisMessage = '';
  tab.aiProgress = null;
  reflectAnalysisTab(tab);

  const onProgress = (progress) => updateCodexProgress(tab, token, progress);
  const onFinding = (finding) => updateAiFinding(tab, token, finding, provider);
  const onPauseState = (paused) => {
    if (paused && tab.pauseState === 'pause-requested') {
      tab.pauseMessage = '';
      setAnalysisPauseState(tab, 'paused');
    } else if (!paused && tab.pauseState === 'paused') {
      setAnalysisPauseState(tab, 'running');
    }
  };
  const unlisten = [];
  try {
    let result;
    const input = provider === 'ollama'
      ? {
        baseUrl: codexSettings.ollamaBaseUrl.trim() || null,
        text: tab.document.text,
        findings: tab.findings,
        model: codexSettings.ollamaModel,
        parallelProcesses,
      }
      : provider === 'cloudru'
        ? {
          apiKey: cloudRuApiKey.trim(),
          text: tab.document.text,
          findings: tab.findings,
          model: codexSettings.cloudRuModel,
          reasoningEffort: null,
          parallelProcesses,
        }
        : provider === 'yandex'
          ? {
            apiKey: yandexApiKey.trim(),
            folderId: codexSettings.yandexFolderId.trim(),
            text: tab.document.text,
            findings: tab.findings,
            model: codexSettings.yandexModel,
            parallelProcesses,
          }
          : provider === 'claude'
            ? {
              text: tab.document.text,
              findings: tab.findings,
              model: codexSettings.claudeModel,
              reasoningEffort: codexSettings.claudeReasoningEffort,
              parallelProcesses,
            }
          : {
            text: tab.document.text,
            findings: tab.findings,
            model: codexSettings.model,
            reasoningEffort: codexSettings.reasoningEffort,
            parallelProcesses,
          };
    input.analysisId = tab.analysisPauseId;
    if (isTauri) {
      try {
        unlisten.push(await listen('ai-analysis-progress', (event) => onProgress(event.payload || {})));
        unlisten.push(await listen('ai-finding', (event) => onFinding(event.payload?.finding)));
        unlisten.push(await listen('ai-review-update', (event) => updateAiReviewProgress(tab, token, event.payload || {})));
        unlisten.push(await listen('ai-review-stream', (event) => updateAiReviewStream(tab, token, event.payload || {})));
      } catch {
        // Final invoke result still supplies all findings if event listening is unavailable.
      }
      const command = provider === 'ollama' ? 'analyze_with_ollama'
        : provider === 'cloudru' ? 'analyze_with_cloudru'
          : provider === 'yandex' ? 'analyze_with_yandex'
            : provider === 'claude' ? 'analyze_with_claude' : 'analyze_with_codex';
      result = await invoke(command, input);
    } else {
      if (provider === 'codex') {
        result = await analyzeAiInBrowser('/__norman/codex/analyze', 'Codex', input, onProgress, onFinding, onPauseState, (payload) => {
          if (payload.complete) updateAiReviewProgress(tab, token, payload);
          else updateAiReviewStream(tab, token, payload);
        }, requestController.signal);
      } else if (provider === 'ollama' && isBrowserOllamaDev) {
        result = await analyzeAiInBrowser('/__norman/ollama/analyze', 'Ollama', input, onProgress, onFinding, onPauseState, (payload) => {
          if (payload.complete) updateAiReviewProgress(tab, token, payload);
          else updateAiReviewStream(tab, token, payload);
        }, requestController.signal);
      } else {
        throw new Error(`Проверка ${providerLabel} доступна только в настольном приложении.`);
      }
    }
    if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
    const resultFindings = Array.isArray(result) ? result : result?.findings;
    if (!Array.isArray(resultFindings)) throw new Error(`${providerLabel} не вернул итоговый список сигналов.`);
    tab.findings = mergeFindings(tab.findings, resultFindings.map((finding) => ({ ...finding, aiProvider: provider })));
    tab.aiAnalysis = 'done';
    tab.aiProgress = null;
    tab.aiAnalysisMessage = '';
  } catch (error) {
    if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
    tab.aiAnalysis = 'error';
    tab.aiAnalysisMessage = formatAiReviewError(error);
    const activeFindingIds = tab.aiProgress?.phase === 'verify'
      ? (tab.aiProgress.activeFindingIds || []).map(String)
      : [];
    const failedFindingIds = [...new Set([
      ...(typeof error.findingId === 'string' ? [error.findingId] : []),
      ...(!error.findingId ? activeFindingIds : []),
    ])];
    for (const findingId of failedFindingIds) {
      const reviewNumbers = [
        ...(tab.aiReviewStreams.get(findingId)?.keys() || []),
        ...(tab.aiReviewOutputs.get(findingId)?.keys() || []),
      ];
      for (const reviewNumber of new Set(reviewNumbers.length ? reviewNumbers : [1])) {
        recordAiReviewDuration(tab, findingId, reviewNumber);
      }
    }
    if (failedFindingIds.length) {
      const failedFinding = tab.findings.find((finding) => failedFindingIds.includes(String(finding.id || '')));
      tab.aiFailure = {
        findingIds: failedFindingIds,
        provider,
        message: messageFrom(error),
      };
      if (failedFinding) {
        tab.aiAnalysisMessage += ` Сбой на сигнале «${failedFinding.title || failedFinding.factor || failedFinding.excerpt || 'Без названия'}».`;
      }
    }
  } finally {
    if (tab.aiReviewAbortController === requestController) tab.aiReviewAbortController = null;
    for (const stop of unlisten) stop();
  }
}

function formatAiReviewError(error) {
  const provider = codexSettings.provider;
  const rawMessage = messageFrom(error);
  const detail = provider === 'cloudru'
    ? redactProviderSecret(rawMessage, cloudRuApiKey.trim())
    : provider === 'yandex' ? redactProviderSecret(rawMessage, yandexApiKey.trim()) : rawMessage;
  return `Проверка ${aiProviderLabel(provider)} не завершилась. Локальные результаты сохранены. ${detail}`;
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
  const analysisId = tab.analysisPauseId;
  startSlowAnalysisWarning(tab);
  const parallelProcesses = codexSettings.parallelProcesses;
  const stopListening = [];
  if (isTauri) {
    try {
      stopListening.push(await listen('analysis-progress', (event) => {
        if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
        const payload = event.payload || {};
        tab.progress = payload;
        if (Array.isArray(payload.findings)) appendFindings(payload.findings, tab);
        reflectAnalysisTab(tab);
      }));
      stopListening.push(await listen('analysis-pause-state', (event) => {
        if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
        const payload = event.payload || {};
        if (payload.analysisId !== analysisId) return;
        if (payload.paused && tab.pauseState === 'pause-requested') setAnalysisPauseState(tab, 'paused');
        else if (!payload.paused && tab.pauseState === 'paused') setAnalysisPauseState(tab, 'running');
      }));
    } catch {
      // Invoke results still provide findings if event listening is unavailable.
    }
  }

  try {
    const result = isTauri
      ? await invoke('analyze_text', { analysisId, text: tab.document.text, parallelProcesses })
      : await (await import('./browser-runtime.js')).analyzeTextInBrowser(tab.document.text, (payload) => {
        if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
        tab.progress = payload;
        if (Array.isArray(payload.findings)) appendFindings(payload.findings, tab);
        reflectAnalysisTab(tab);
      }, parallelProcesses, tab.pauseController);
    if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
    tab.findings = mergeFindings(tab.findings, Array.isArray(result?.findings) ? result.findings : []);
    tab.analysis = 'done';
    tab.progress = null;
    if (codexSettings.enabled) {
      try {
        await executeAiReview(tab, token, parallelProcesses);
      } catch (error) {
        if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
        tab.aiAnalysis = 'error';
        tab.aiAnalysisMessage = formatAiReviewError(error);
      }
    }
  } catch (error) {
    if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
    tab.analysis = 'error';
    tab.analysisError = messageFrom(error);
  } finally {
    stopListening.forEach((stop) => stop());
    await releaseAnalysisPause(tab, analysisId);
    if (tabById(tab.id) === tab && token === tab.analysisToken) {
      resetSlowAnalysisWarning(tab);
      reflectAnalysisTab(tab);
    }
  }
}

function resetSlowAnalysisWarning(tab) {
  clearTimeout(tab.slowAnalysisTimer);
  tab.slowAnalysisTimer = null;
  tab.slowAnalysisTimerStartedAt = 0;
  tab.slowAnalysisRemainingMs = 3 * 60_000;
  tab.slowAnalysisWarning = false;
}

function startSlowAnalysisWarning(tab) {
  if (tab.slowAnalysisWarning || tab.slowAnalysisTimer || !analysisIsBusy(tab)) return;
  tab.slowAnalysisTimerStartedAt = performance.now();
  tab.slowAnalysisTimer = window.setTimeout(() => {
    tab.slowAnalysisTimer = null;
    tab.slowAnalysisTimerStartedAt = 0;
    tab.slowAnalysisRemainingMs = 0;
    if (tabById(tab.id) !== tab || !analysisIsBusy(tab)) return;
    tab.slowAnalysisWarning = true;
    if (state.activeId === tab.id) reflectAnalysisTab(tab);
  }, tab.slowAnalysisRemainingMs);
}

function pauseSlowAnalysisWarning(tab) {
  if (!tab.slowAnalysisTimer) return;
  clearTimeout(tab.slowAnalysisTimer);
  tab.slowAnalysisTimer = null;
  tab.slowAnalysisRemainingMs = Math.max(
    0,
    tab.slowAnalysisRemainingMs - (performance.now() - tab.slowAnalysisTimerStartedAt),
  );
  tab.slowAnalysisTimerStartedAt = 0;
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
  state.aiFailure = tab.aiFailure || null;
  state.aiProgress = tab.aiProgress || null;
  render();
}

function runAnalysis(tabId = state.activeId) {
  const tab = tabById(tabId);
  if (!tab || !tab.document || tab.analysis === 'running'
    || tab.aiAnalysis === 'checking' || tab.aiAnalysis === 'running') return Promise.resolve();

  const token = ++tab.analysisToken;
  tab.analysisPauseId = `${tab.id}:${token}`;
  tab.pauseState = 'running';
  tab.pauseMessage = '';
  tab.pauseController = isTauri ? null : createAnalysisPauseController(tab);
  resetSlowAnalysisWarning(tab);
  tab.analysis = 'running';
  tab.analysisError = '';
  tab.findings = [];
  tab.selectedId = null;
  tab.progress = null;
  tab.aiAnalysis = 'idle';
  tab.aiAnalysisMessage = '';
  tab.aiProgress = null;
  reflectAnalysisTab(tab);

  return enqueueAnalysisJob(() => executeAnalysis(tab, token));
}

function enqueueAnalysisJob(run) {
  const job = analysisQueue.then(run, run);
  analysisQueue = job.catch(() => {});
  return job;
}

async function retryAiAnalysis(tabId = state.activeId) {
  const tab = tabById(tabId);
  if (!tab || !tab.document || tab.analysis !== 'done'
    || (tab.aiAnalysis !== 'error' && tab.aiAnalysis !== 'unavailable')
    || !codexSettings.enabled) return;

  const token = ++tab.analysisToken;
  const analysisId = `${tab.id}:${token}`;
  tab.analysisPauseId = analysisId;
  tab.pauseState = 'running';
  tab.pauseMessage = '';
  tab.pauseController = isTauri ? null : createAnalysisPauseController(tab);
  resetSlowAnalysisWarning(tab);
  tab.aiAnalysis = 'checking';
  tab.aiAnalysisMessage = '';
  tab.aiProgress = null;
  reflectAnalysisTab(tab);

  return enqueueAnalysisJob(async () => {
    if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
    startSlowAnalysisWarning(tab);
    try {
      await executeAiReview(tab, token, codexSettings.parallelProcesses);
    } catch (error) {
      if (tabById(tab.id) !== tab || token !== tab.analysisToken) return;
      tab.aiAnalysis = 'error';
      tab.aiAnalysisMessage = formatAiReviewError(error);
    } finally {
      await releaseAnalysisPause(tab, analysisId);
      if (tabById(tab.id) === tab && token === tab.analysisToken) {
        resetSlowAnalysisWarning(tab);
        reflectAnalysisTab(tab);
      }
    }
  });
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
ui.exportReportPdf.addEventListener('click', () => {
  if (!codexSettings.enabled || state.aiAnalysis !== 'done' || !state.document) return;
  const reportFindings = state.findings.filter((finding) => findingConfidenceLevel(finding) !== 'likely-false');
  try {
    generateReportPdf(state.document, reportFindings);
  } catch (error) {
    state.loadError = messageFrom(error);
    renderError();
  }
});
ui.openAppInfo.addEventListener('click', () => {
  setAppVersion(displayedAppVersion);
  ui.appInfoDialog.showModal();
  if (isTauri && !releaseTag) void getVersion().then(setAppVersion).catch(() => {});
});
ui.closeAppInfo.addEventListener('click', () => ui.appInfoDialog.close());
ui.appInfoDialog.addEventListener('click', (event) => {
  if (event.target === ui.appInfoDialog) ui.appInfoDialog.close();
});
ui.openSettings.addEventListener('click', () => {
  syncCodexSettingsUI();
  ui.settingsDialog.showModal();
  if (codexSettings.provider === 'ollama') void prepareOllamaSettings();
  else if (codexSettings.enabled) void refreshSelectedAiProviderStatus();
});
ui.openOllamaSetup.addEventListener('click', async () => {
  ui.ollamaSetupDialog.showModal();
  await loadSettingsOllamaRecommendation();
  renderOllamaSetup();
});
ui.closeOllamaSetup.addEventListener('click', () => ui.ollamaSetupDialog.close());
ui.ollamaSetupDialog.addEventListener('click', (event) => {
  if (event.target === ui.ollamaSetupDialog && !ui.closeOllamaSetup.disabled) ui.ollamaSetupDialog.close();
});
ui.ollamaSetupDialog.addEventListener('cancel', (event) => {
  if (ui.closeOllamaSetup.disabled || ollamaInstallInProgress) event.preventDefault();
});
ui.closeWelcome.addEventListener('click', closeWelcome);
ui.openWelcome.addEventListener('click', () => void showWelcome(true));
ui.continueWithoutAi.addEventListener('click', closeWelcome);
ui.welcomeOpenSettings.addEventListener('click', openSettingsFromWelcome);
ui.welcomeModel.addEventListener('change', renderWelcomeModelNote);
ui.welcomeInstallOllama.addEventListener('click', () => {
  if (welcomeInstallComplete) openSettingsFromWelcome();
  else void installOllamaFromWelcome();
});
ui.welcomeDialog.addEventListener('click', (event) => {
  if (event.target === ui.welcomeDialog) closeWelcome();
});
ui.closeSettings.addEventListener('click', () => ui.settingsDialog.close());
ui.closeAiReview.addEventListener('click', () => ui.aiReviewDialog.close());
ui.aiReviewDialog.addEventListener('close', () => {
  ui.aiReviewLiveStatus.dataset.findingKey = '';
  ui.aiReviewLiveStatus.dataset.watching = 'false';
  ui.aiReviewLiveStatus.dataset.lastStage = '';
  ui.aiReviewLiveStatus.hidden = true;
  ui.aiReviewLiveTyping.hidden = true;
  ui.aiReviewLiveMessages.replaceChildren();
});
ui.showPartialAiReview.addEventListener('click', openAiReviewResults);
ui.aiReviewDialog.addEventListener('click', (event) => {
  if (event.target === ui.aiReviewDialog) ui.aiReviewDialog.close();
});
ui.checkCodexStatus.addEventListener('click', () => void refreshCodexStatus());
ui.checkClaudeStatus.addEventListener('click', () => void refreshClaudeStatus());
ui.checkOllamaStatus.addEventListener('click', () => void refreshOllamaStatus());
ui.ollamaBaseUrl.addEventListener('input', () => {
  ollamaStatusRequestId += 1;
  ollamaStatus = {
    ...ollamaStatus,
    checked: false,
    available: false,
    models: [],
    message: '',
    checking: false,
    error: false,
  };
  renderOllamaStatus();
});
ui.startOllama.addEventListener('click', () => void startOllamaFromSettings());
ui.installOllamaFromSettings.addEventListener('click', () => void installOllamaFromSettings());
ui.cancelOllamaSetup.addEventListener('click', () => void cancelOllamaSetupFromSettings());
ui.ollamaSetupModel.addEventListener('change', () => {
  ui.ollamaSetupStatus.hidden = true;
  renderOllamaSetup();
});
ui.checkCloudRuStatus.addEventListener('click', () => void refreshCloudRuStatus());
ui.checkYandexStatus.addEventListener('click', () => void refreshYandexStatus());
ui.cloudRuApiKey.addEventListener('input', () => {
  cloudRuApiKey = ui.cloudRuApiKey.value;
  cloudRuStatusRequestId += 1;
  cloudRuStatus = { checked: false, available: false, models: [], message: '' };
  renderCloudRuStatus();
});
ui.yandexApiKey.addEventListener('input', () => {
  yandexApiKey = ui.yandexApiKey.value;
  yandexStatusRequestId += 1;
  yandexStatus = { checked: false, available: false, models: [], message: '' };
  renderYandexStatus();
});
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
  if (event.target === ui.codexProvider) {
    codexSettings.provider = ['claude', 'ollama', 'cloudru', 'yandex'].includes(ui.codexProvider.value) ? ui.codexProvider.value : 'codex';
    saveCodexSettings();
    syncCodexSettingsUI();
    if (codexSettings.provider === 'ollama') void prepareOllamaSettings();
    else if (codexSettings.enabled) void refreshSelectedAiProviderStatus();
  }
  if (event.target === ui.ollamaBaseUrl) {
    codexSettings.ollamaBaseUrl = ui.ollamaBaseUrl.value.trim() || DEFAULT_CODEX_SETTINGS.ollamaBaseUrl;
    ui.ollamaBaseUrl.value = codexSettings.ollamaBaseUrl;
    ollamaStatusRequestId += 1;
    ollamaStatus = { ...ollamaStatus, checked: false, available: false, models: [], message: '', checking: false, error: false };
    saveCodexSettings();
    renderOllamaStatus();
    if (codexSettings.provider === 'ollama') void refreshOllamaStatus();
  }
  if (event.target === ui.ollamaModel) codexSettings.ollamaModel = ui.ollamaModel.value;
  if (event.target === ui.cloudRuModel) codexSettings.cloudRuModel = ui.cloudRuModel.value;
  if (event.target === ui.yandexFolderId) {
    codexSettings.yandexFolderId = ui.yandexFolderId.value.trim();
    yandexStatusRequestId += 1;
    yandexStatus = { checked: false, available: false, models: [], message: '' };
    saveCodexSettings();
    renderYandexStatus();
    if (codexSettings.enabled && codexSettings.provider === 'yandex') void refreshYandexStatus();
  }
  if (event.target === ui.yandexModel) codexSettings.yandexModel = ui.yandexModel.value;
  if (event.target === ui.codexModel) codexSettings.model = ui.codexModel.value;
  if (event.target === ui.claudeModel) codexSettings.claudeModel = ui.claudeModel.value;
  if (event.target === ui.claudeReasoning) {
    codexSettings.claudeReasoningEffort = ui.claudeReasoning.value;
    renderHeaderAiStatus();
  }
  if (event.target === ui.codexReasoning) {
    codexSettings.reasoningEffort = ui.codexReasoning.value;
    renderHeaderAiStatus();
  }
  if (event.target === ui.parallelProcesses) {
    const selected = Number(ui.parallelProcesses.value);
    codexSettings.parallelProcesses = [1, 2, 3, 4].includes(selected) ? selected : 1;
  }
  if ([ui.codexEnabled, ui.codexProvider, ui.ollamaBaseUrl, ui.ollamaModel, ui.cloudRuModel, ui.yandexModel, ui.codexModel, ui.codexReasoning, ui.claudeModel, ui.claudeReasoning, ui.parallelProcesses].includes(event.target)) {
    saveCodexSettings();
  }
  if (event.target === ui.codexEnabled && codexSettings.enabled) {
    if (codexSettings.provider === 'ollama') void prepareOllamaSettings();
    else void refreshSelectedAiProviderStatus();
  }
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
    keepExpandedFindingVisible(state.selectedId);
    if (state.document?.url) scrollPageFindingIntoView(state.selectedId);
    else {
      const target = sourceTargets.get(state.selectedId);
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        target.focus({ preventScroll: true });
      }
    }
  }
  if (!state.selectedId) keepFindingVisible(followedFindingId);
});

ui.documentText.addEventListener('click', (event) => {
  const mark = event.target.closest('.source-hit');
  if (!mark) return;
  const key = mark.dataset.findingIds.split(' ')[0];
  if (!key) return;
  state.selectedId = key;
  render();
  sourceTargets.get(key)?.focus({ preventScroll: true });
  keepExpandedFindingVisible(key);
});

ui.textPanel.addEventListener('scroll', scheduleFindingToSourceScroll, { passive: true });

ui.retryAnalysis.addEventListener('click', () => runAnalysis());
ui.retryAiAnalysis.addEventListener('click', () => { void retryAiAnalysis(); });
ui.analysisPauseButton.addEventListener('click', () => { void toggleAnalysisPause(); });
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
