const ERROR_PREFIX = 'Браузерный режим доступен через локальный npm run dev. ';

async function post(path, body, headers = {}) {
  let response;
  try {
    response = await fetch(path, { method: 'POST', body, headers });
  } catch {
    throw new Error(ERROR_PREFIX + 'Не удалось связаться с локальным обработчиком.');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Ошибка обработки (${response.status}).`);
  return result;
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
  });
  const text = typeof result.text === 'string'
    ? normalizeText(result.text)
    : extractHtmlText(result.html || '');
  if (!text) throw new Error('На странице не найден текст для анализа.');
  return { title: result.title || 'Документ без названия', url: result.url || url, format: result.format || 'HTML', text };
}

function extractHtmlText(html) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed.querySelectorAll('script, style, template, noscript, svg, iframe, object, embed').forEach((node) => node.remove());
  return normalizeText(parsed.body?.innerText || parsed.body?.textContent || '');
}

export async function loadFileInBrowser(file) {
  if (file.size > 25 * 1024 * 1024) throw new Error('Файл превышает лимит 25 МБ.');
  const result = await post('/__norman/load-file', file, {
    'content-type': 'application/octet-stream',
    'x-filename': encodeURIComponent(file.name),
  });
  return { ...result, text: normalizeText(result.text || '') };
}

export function analyzeTextInBrowser(text, onProgress) {
  const worker = new Worker(new URL('./browser-analysis-worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        onProgress(data.progress);
      } else if (data.type === 'result') {
        worker.terminate();
        resolve(data.result);
      } else {
        worker.terminate();
        reject(new Error(data.error || 'Не удалось выполнить анализ.'));
      }
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error('Не удалось выполнить анализ в браузере.'));
    };
    worker.postMessage({ text });
  });
}
