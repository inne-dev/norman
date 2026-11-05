const ERROR_PREFIX = 'Браузерный режим доступен через локальный npm run dev. ';
const URL_LOAD_TIMEOUT_MS = 20_000;

async function post(path, body, headers = {}, timeoutMs = 0) {
  const controller = timeoutMs ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  let response;
  try {
    try {
      response = await fetch(path, {
        method: 'POST',
        body,
        headers,
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch {
      if (controller?.signal.aborted) {
        throw new Error('Загрузка по ссылке не завершилась за 20 секунд. Попробуйте ещё раз.');
      }
      throw new Error(ERROR_PREFIX + 'Не удалось связаться с локальным обработчиком.');
    }
    let result;
    try {
      result = await response.json();
    } catch {
      if (controller?.signal.aborted) {
        throw new Error('Загрузка по ссылке не завершилась за 20 секунд. Попробуйте ещё раз.');
      }
      result = {};
    }
    if (!response.ok) throw new Error(result.error || `Ошибка обработки (${response.status}).`);
    return result;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function normalizeText(input) {
  let output = '';
  for (const ch of input.replaceAll('\0', '')) {
    if (ch === '\r' || ch === '\n') {
      output = output.replace(/ +$/u, '');
      if (!output.endsWith('\n')) output += '\n';
    } else if (/\s/u.test(ch)) {
      if (!output.endsWith(' ') && !output.endsWith('\n')) output += ' ';
    } else {
      output += ch;
    }
  }
  return output.trim();
}

export async function loadUrlInBrowser(url) {
  const result = await post('/__norman/load-url', JSON.stringify({ url }), {
    'content-type': 'application/json',
  }, URL_LOAD_TIMEOUT_MS);
  const text = typeof result.text === 'string'
    ? normalizeText(result.text)
    : extractHtmlText(result.html || '');
  if (!text) throw new Error('На странице не найден текст для анализа.');
  return {
    title: result.title || 'Документ без названия',
    url: result.url || url,
    format: result.format || 'HTML',
    text,
    previewHtml: typeof result.html === 'string' ? result.html : '',
  };
}

function extractHtmlText(html) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  // Analyze the article body, not navigation or other surrounding page chrome.
  const contentRoot = [
    '#doc_content',
    '#document-content',
    '[itemprop="articleBody"]',
    '.document-content',
  ].map((selector) => parsed.querySelector(selector)).find(Boolean)
    || parsed.querySelector('article')
    || parsed.querySelector('[role="main"]')
    || parsed.querySelector('main')
    || parsed.body;

  if (!contentRoot) return '';

  contentRoot.querySelectorAll([
    'script', 'style', 'template', 'noscript', 'svg', 'iframe', 'object', 'embed',
    '[hidden]', '[aria-hidden="true"]', '.hide', '.hidden', '.invisible',
    '[style*="display:none" i]', '[style*="display: none" i]',
    '[style*="visibility:hidden" i]', '[style*="visibility: hidden" i]',
    '[data-ad-slot]', '[data-google-query-id]', '[id*="google_ads" i]',
    '[id*="yandex_rtb" i]', '[class*="yandex-rtb" i]',
    '[class*="advertisement" i]', '[id*="advertisement" i]',
    '[class*="advertising" i]', '[id*="advertising" i]',
    '[class*="ad-container" i]', '[id*="ad-container" i]',
    '[class*="ad-banner" i]', '[id*="ad-banner" i]',
    '[class*="reklama" i]', '[id*="reklama" i]',
  ].join(', ')).forEach((node) => node.remove());

  return normalizeText(contentRoot.innerText || contentRoot.textContent || '');
}

export async function loadFileInBrowser(file) {
  if (file.size > 25 * 1024 * 1024) throw new Error('Файл превышает лимит 25 МБ.');
  const result = await post('/__norman/load-file', file, {
    'content-type': 'application/octet-stream',
    'x-filename': encodeURIComponent(file.name),
  });
  return { ...result, text: normalizeText(result.text || '') };
}

function createRuleWorker(text) {
  const worker = new Worker(new URL('./browser-analysis-worker.js', import.meta.url), { type: 'module' });
  let resolveReady;
  let rejectReady;
  let pendingScan = null;
  let readySettled = false;
  let workerError = null;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});

  const fail = (error) => {
    workerError = error;
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    if (pendingScan) {
      pendingScan.reject(error);
      pendingScan = null;
    }
  };

  worker.onmessage = ({ data }) => {
    if (data.type === 'ready') {
      if (readySettled) return fail(new Error('Рабочий поток прислал повторный ответ.'));
      readySettled = true;
      resolveReady(data);
    } else if (data.type === 'rule-result') {
      if (!pendingScan || data.ruleIndex !== pendingScan.ruleIndex || !Array.isArray(data.findings)) {
        return fail(new Error('Рабочий поток вернул неверный результат.'));
      }
      const { resolve } = pendingScan;
      pendingScan = null;
      resolve(data.findings);
    } else if (data.type === 'error') {
      fail(new Error(data.error || 'Не удалось выполнить анализ.'));
    } else {
      fail(new Error('Рабочий поток вернул неизвестный ответ.'));
    }
  };
  worker.onerror = () => fail(new Error('Не удалось выполнить анализ в браузере.'));

  try {
    worker.postMessage({ type: 'init', text });
  } catch {
    fail(new Error('Не удалось передать текст рабочему потоку.'));
  }

  return {
    ready,
    scan(ruleIndex, matchLimit) {
      if (workerError) return Promise.reject(workerError);
      if (pendingScan) return Promise.reject(new Error('Рабочий поток уже занят.'));
      return new Promise((resolve, reject) => {
        pendingScan = { ruleIndex, resolve, reject };
        try {
          worker.postMessage({ type: 'scan-rule', ruleIndex, matchLimit });
        } catch {
          fail(new Error('Не удалось передать правило рабочему потоку.'));
        }
      });
    },
    terminate() {
      if (!readySettled || pendingScan) fail(new Error('Рабочий поток остановлен.'));
      worker.terminate();
    },
  };
}

export async function analyzeTextInBrowser(text, onProgress, parallelProcesses = 1) {
  if (!Number.isInteger(parallelProcesses) || parallelProcesses < 1 || parallelProcesses > 4) {
    throw new Error('Число параллельных процессов должно быть от 1 до 4.');
  }
  const cores = Math.max(1, Math.floor(Number(globalThis.navigator?.hardwareConcurrency) || 1));
  const workers = [];
  try {
    workers.push(createRuleWorker(text));
    const firstReady = await workers[0].ready;
    const firstReadyRuleCount = firstReady?.totalRules;
    if (!Number.isInteger(firstReadyRuleCount) || firstReadyRuleCount < 1) {
      throw new Error('Рабочий поток не загрузил каталог правил.');
    }
    const workerCount = Math.min(parallelProcesses, cores, firstReadyRuleCount);
    for (let index = 1; index < workerCount; index += 1) workers.push(createRuleWorker(text));
    const ready = [firstReady, ...await Promise.all(workers.slice(1).map((worker) => worker.ready))];
    const { totalRules, maxFindings, maxFindingsPerRule } = ready[0] || {};
    if (
      !Number.isInteger(totalRules) || totalRules < 1 ||
      !Number.isInteger(maxFindings) || maxFindings < 1 ||
      !Number.isInteger(maxFindingsPerRule) || maxFindingsPerRule < 1 ||
      ready.some((value) => value.totalRules !== totalRules || value.maxFindings !== maxFindings
        || value.maxFindingsPerRule !== maxFindingsPerRule)
    ) {
      throw new Error('Рабочие потоки получили разные версии каталога правил.');
    }

    const findings = [];
    let nextRule = 0;
    while (nextRule < totalRules) {
      const remaining = maxFindings - findings.length;
      if (remaining === 0) {
        for (let ruleIndex = nextRule; ruleIndex < totalRules; ruleIndex += 1) {
          onProgress({ completedRules: ruleIndex + 1, totalRules, findings: [] });
        }
        break;
      }

      const batchSize = Math.min(workers.length, totalRules - nextRule);
      const canParallelize = workers.length > 1
        && batchSize * maxFindingsPerRule <= remaining;
      const batchFindings = canParallelize
        ? await Promise.all(workers.slice(0, batchSize).map((worker, offset) => (
          worker.scan(nextRule + offset, maxFindingsPerRule)
        )))
        : [await workers[0].scan(nextRule, Math.min(maxFindingsPerRule, remaining))];

      for (const added of batchFindings) {
        findings.push(...added);
        onProgress({ completedRules: nextRule + 1, totalRules, findings: added });
        nextRule += 1;
      }
    }

    return {
      findings: findings.sort((left, right) => (
        left.start - right.start || left.end - right.end || left.ruleId.localeCompare(right.ruleId)
      )),
      checklist: [
        'Проверьте орган издания и его полномочия по первичному источнику.',
        'Проверьте дату вступления в силу и сведения об официальном опубликовании.',
        'Сопоставьте положения со связанными актами и проверьте компетенцию.',
        'Проверьте полноту процедуры с учетом связанных актов и материалов.',
      ],
    };
  } finally {
    workers.forEach((worker) => worker.terminate());
  }
}
