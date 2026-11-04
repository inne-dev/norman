import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineConfig } from 'vite';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_BYTES = 15 * 1024 * 1024;
const MAX_URL_BYTES = 4 * 1024 * 1024;
const MAX_URL_REDIRECTS = 5;
const MAX_URL_TIME_MS = 15_000;
const MAX_CONVERTER_TIME_MS = 20_000;
const URL_PATH = '/__norman/load-url';
const FILE_PATH = '/__norman/load-file';

class AdapterError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(value));
}

function normalizeText(input) {
  return input
    .replaceAll('\0', '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n+/g, '\n')
    .trim();
}

function checkText(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
    throw new AdapterError(413, 'Извлечённый текст превышает лимит 15 МБ.');
  }
  if (!text.trim()) throw new AdapterError(422, 'Не найден текст для просмотра и анализа.');
  return text;
}

function readRequest(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (tooLarge) reject(new AdapterError(413, 'Файл превышает лимит 25 МБ.'));
      else resolve(Buffer.concat(chunks, size));
    });
    req.on('error', reject);
  });
}

function validateUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new AdapterError(400, 'Введите корректную ссылку HTTP или HTTPS.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new AdapterError(400, 'Поддерживаются только ссылки HTTP и HTTPS.');
  }
  if (url.username || url.password) {
    throw new AdapterError(400, 'В ссылке нельзя указывать имя пользователя или пароль.');
  }
  return url;
}

function decodeBytes(bytes, contentType) {
  const charset = contentType.match(/(?:^|;)\s*charset\s*=\s*["']?([^;"']+)/i)?.[1]?.trim();
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function decodeEntities(value) {
  const named = {
    amp: '&', apos: "'", gt: '>', lt: '<', quot: '"', nbsp: ' ',
    copy: '©', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  };
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z][\da-z]+);/gi, (entity, body) => {
    if (body[0] !== '#') return named[body.toLowerCase()] ?? entity;
    const hex = body[1]?.toLowerCase() === 'x';
    const number = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(number) && number > 0 && number <= 0x10ffff
      ? String.fromCodePoint(number)
      : '\uFFFD';
  });
}

function htmlTitle(html) {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? '';
  return normalizeText(decodeEntities(title.replace(/<[^>]*>/g, '')));
}

function validateFilename(value) {
  let filename;
  try {
    filename = decodeURIComponent(value);
  } catch {
    throw new AdapterError(400, 'Не удалось прочитать имя файла.');
  }
  if (
    typeof value !== 'string' || !filename || Buffer.byteLength(filename, 'utf8') > 255 ||
    filename !== filename.trim() || /[\x00-\x1f\x7f/\\]/.test(filename) ||
    path.posix.basename(filename) !== filename || path.win32.basename(filename) !== filename
  ) {
    throw new AdapterError(400, 'Не удалось прочитать имя файла.');
  }
  return filename;
}

function runCommand(program, args, timeoutMs = MAX_CONVERTER_TIME_MS) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(program, args, { stdio: 'ignore', windowsHide: true });
    } catch (error) {
      if (error.code === 'ENOENT') resolve(null);
      else reject(error);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new AdapterError(422, 'Преобразование документа превысило лимит времени 20 секунд.'));
    }, timeoutMs);
    const finish = (error, success) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(success);
    };
    child.once('error', (error) => {
      if (error.code === 'ENOENT') finish(null, null);
      else finish(error);
    });
    child.once('close', (code) => finish(null, code === 0));
  });
}

async function runConverter(programs, argsFor, timeoutMs) {
  let found = false;
  for (const program of programs) {
    const success = await runCommand(program, argsFor(program), timeoutMs);
    if (success === null) continue;
    found = true;
    if (success) return;
  }
  if (!found) throw new AdapterError(422, `Не найден локальный конвертер: ${programs.join(' или ')}.`);
  throw new AdapterError(422, 'Конвертер не смог прочитать файл. Возможно, он зашифрован, повреждён или не поддерживается.');
}

async function readConvertedText(outputPath) {
  let info;
  try {
    info = await stat(outputPath);
  } catch {
    throw new AdapterError(422, 'Конвертер не создал текстовый файл.');
  }
  if (info.size > MAX_TEXT_BYTES) throw new AdapterError(413, 'Извлечённый текст превышает лимит 15 МБ.');
  const bytes = await readFile(outputPath);
  if (bytes.length > MAX_TEXT_BYTES) throw new AdapterError(413, 'Извлечённый текст превышает лимит 15 МБ.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AdapterError(422, 'Конвертер создал текст в неподдерживаемой кодировке.');
  }
}

async function loadFile(req) {
  const filename = validateFilename(req.headers['x-filename']);
  const extension = path.extname(filename).slice(1).toLowerCase();
  const fileFormats = new Set(['doc', 'dot', 'docx', 'docm', 'dotx', 'dotm', 'odt', 'rtf', 'pdf', 'txt', 'text', 'md', 'csv']);
  if (!fileFormats.has(extension)) {
    throw new AdapterError(415, 'Этот формат файла не поддерживается.');
  }
  const bytes = await readRequest(req, MAX_FILE_BYTES);
  if (!bytes.length) throw new AdapterError(422, 'Выбранный файл пуст.');
  const title = filename.slice(0, -(path.extname(filename).length)) || filename;
  const format = ['txt', 'text', 'md', 'csv'].includes(extension)
    ? 'txt'
    : ['doc', 'dot', 'docx', 'docm', 'dotx', 'dotm', 'odt', 'rtf', 'pdf'].includes(extension)
      ? extension
      : 'txt';

  if (['txt', 'text', 'md', 'csv'].includes(extension)) {
    let text;
    try {
      const source = bytes.subarray(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0);
      text = new TextDecoder('utf-8', { fatal: true }).decode(source);
    } catch {
      throw new AdapterError(422, 'Текстовый файл должен быть сохранён в UTF-8.');
    }
    return { title, url: '', format, text: checkText(normalizeText(text)) };
  }

  const directory = await mkdtemp(path.join(tmpdir(), 'norman-vite-'));
  try {
    const inputPath = path.join(directory, `source.${extension}`);
    const outputPath = path.join(directory, 'source.txt');
    await writeFile(inputPath, bytes, { flag: 'wx', mode: 0o600 });
    if (extension === 'pdf') {
      await runConverter(['pdftotext'], () => ['-enc', 'UTF-8', '-nopgbrk', inputPath, outputPath]);
    } else {
      const profile = pathToFileURL(path.join(directory, 'profile')).href;
      await runConverter(['soffice', 'libreoffice'], () => [
        '--headless', `-env:UserInstallation=${profile}`, '--convert-to', 'txt:Text', '--outdir', directory, inputPath,
      ]);
    }
    let text;
    try {
      text = await readConvertedText(outputPath);
    } catch (error) {
      if (extension === 'pdf' && error instanceof AdapterError && error.message === 'Конвертер не создал текстовый файл.') {
        throw new AdapterError(422, 'В PDF нет доступного текста. Для сканов нужен OCR, которого пока нет.');
      }
      throw error;
    }
    const normalized = normalizeText(text);
    if (extension === 'pdf' && !normalized) {
      throw new AdapterError(422, 'В PDF нет доступного текста. Для сканов нужен OCR, которого пока нет.');
    }
    return { title, url: '', format, text: checkText(normalized) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readUrl(url) {
  const deadline = AbortSignal.timeout(MAX_URL_TIME_MS);
  let current = validateUrl(url);
  for (let redirects = 0; redirects <= MAX_URL_REDIRECTS; redirects += 1) {
    let response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: deadline,
        headers: {
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
          'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
          'user-agent': 'Norman/0.1 dev adapter',
        },
      });
    } catch (error) {
      if (deadline.aborted || error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw new AdapterError(408, 'Загрузка страницы превысила лимит времени 15 секунд.');
      }
      throw new AdapterError(502, `Не удалось загрузить страницу: ${error.message}`);
    }
    if (response.status >= 300 && response.status < 400) {
      if (redirects === MAX_URL_REDIRECTS) {
        await response.body?.cancel();
        throw new AdapterError(400, 'Страница перенаправила слишком много раз.');
      }
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new AdapterError(400, 'Страница вернула некорректное перенаправление.');
      try {
        current = validateUrl(new URL(location, current).href);
      } catch (error) {
        if (error instanceof AdapterError) throw error;
        throw new AdapterError(400, 'Страница вернула некорректное перенаправление.');
      }
      continue;
    }
    if (!response.ok) throw new AdapterError(502, `Сервер вернул ошибку HTTP ${response.status}.`);

    const contentType = response.headers.get('content-type') ?? '';
    const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
    if (!['text/html', 'application/xhtml+xml', 'text/plain'].includes(mediaType)) {
      await response.body?.cancel();
      throw new AdapterError(415, 'Тип страницы не поддерживается. Нужен HTML, XHTML или обычный текст.');
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_URL_BYTES) {
      await response.body?.cancel();
      throw new AdapterError(413, 'Страница превышает лимит 4 МБ.');
    }
    const chunks = [];
    let size = 0;
    try {
      if (response.body) {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > MAX_URL_BYTES) {
            throw new AdapterError(413, 'Страница превышает лимит 4 МБ.');
          }
          chunks.push(chunk);
        }
      }
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      if (deadline.aborted || error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw new AdapterError(408, 'Загрузка страницы превысила лимит времени 15 секунд.');
      }
      throw new AdapterError(502, `Не удалось прочитать страницу: ${error.message}`);
    }
    const page = decodeBytes(Buffer.concat(chunks, size), contentType);
    if (mediaType === 'text/plain') {
      const text = checkText(normalizeText(page));
      return { url: current.href, format: 'ТЕКСТ', text };
    }
    if (Buffer.byteLength(page, 'utf8') > MAX_TEXT_BYTES) {
      throw new AdapterError(413, 'Текст страницы превышает лимит 15 МБ.');
    }
    return { url: current.href, format: 'HTML', html: page, title: htmlTitle(page) };
  }
  throw new AdapterError(400, 'Страница перенаправила слишком много раз.');
}

async function handleRequest(req, res, pathname) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Поддерживаются только POST-запросы.' });
  }
  if (pathname === URL_PATH) {
    let payload;
    try {
      payload = JSON.parse((await readRequest(req, 64 * 1024)).toString('utf8'));
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError(400, 'Запрос должен содержать ссылку.');
    }
    if (typeof payload?.url !== 'string') throw new AdapterError(400, 'Запрос должен содержать ссылку.');
    return json(res, 200, await readUrl(payload.url));
  }
  return json(res, 200, await loadFile(req));
}

const devLoadAdapter = {
  name: 'norman-dev-load-adapter',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      let pathname;
      try {
        pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        return next();
      }
      if (pathname !== URL_PATH && pathname !== FILE_PATH) return next();
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
        return json(res, 403, { error: 'Загрузка доступна только из этого окна Нормана.' });
      }
      void handleRequest(req, res, pathname).catch((error) => {
        const status = error instanceof AdapterError ? error.status : 500;
        const message = error instanceof AdapterError ? error.message : 'Не удалось обработать источник.';
        if (!res.writableEnded) json(res, status, { error: message });
      });
    });
  },
};

export default defineConfig({
  clearScreen: false,
  plugins: [devLoadAdapter],
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
});
