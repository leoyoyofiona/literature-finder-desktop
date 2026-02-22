const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const { searchLiterature } = require('./src/services/searchService');
const {
  testZoteroConnection,
  fetchZoteroCollections,
  savePaperToZotero,
} = require('./src/services/zoteroService');

let mainWindow;
let settingsPath;

const DEFAULT_SETTINGS = {
  downloadDirectory: '',
  zoteroUserId: '',
  zoteroApiKey: '',
  zoteroLibraryType: 'users',
  vpnLoginUrl: '',
  libraryHomeUrl: '',
  googleScholarUrl: 'https://scholar.google.com/scholar?q={query}',
  cnkiUrl: 'https://kns.cnki.net/kns8s/defaultresult/index?kw={query}',
  webOfScienceUrl: 'https://www.webofscience.com/wos/woscc/basic-search?query={query}',
  openScholarUrl: 'https://www.semanticscholar.org/search?q={query}',
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 900,
    minWidth: 980,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src/index.html'));
}

function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180);
}

function uniqueUrls(urls) {
  const seen = new Set();
  const output = [];

  urls.forEach((item) => {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) {
      return;
    }

    if (!/^https?:\/\//i.test(value)) {
      return;
    }

    seen.add(value);
    output.push(value);
  });

  return output;
}

function looksLikePdfUrl(url) {
  const value = String(url || '').toLowerCase();
  return (
    value.includes('.pdf') ||
    value.includes('/pdf') ||
    value.includes('content/pdf') ||
    value.includes('download')
  );
}

function bufferLooksLikePdf(buffer) {
  return buffer && buffer.length > 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

function resolveUrlMaybe(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return '';
  }
}

function extractPdfLinksFromHtml(html, baseUrl) {
  const candidates = [];

  const metaPattern =
    /<meta[^>]+(?:name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["']|content=["']([^"']+)["'][^>]+name=["']citation_pdf_url["'])[^>]*>/gi;
  let metaMatch = metaPattern.exec(html);
  while (metaMatch) {
    const raw = metaMatch[1] || metaMatch[2] || '';
    const resolved = resolveUrlMaybe(raw, baseUrl);
    if (resolved) {
      candidates.push(resolved);
    }
    metaMatch = metaPattern.exec(html);
  }

  const hrefPattern = /href=["']([^"']+)["']/gi;
  let hrefMatch = hrefPattern.exec(html);
  while (hrefMatch) {
    const raw = hrefMatch[1] || '';
    if (looksLikePdfUrl(raw)) {
      const resolved = resolveUrlMaybe(raw, baseUrl);
      if (resolved) {
        candidates.push(resolved);
      }
    }
    hrefMatch = hrefPattern.exec(html);
  }

  return uniqueUrls(candidates);
}

async function fetchWithTimeout(url, options, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function buildDownloadHeaders(referer) {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'application/pdf,text/html;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...(referer ? { Referer: referer } : {}),
  };
}

async function fetchDownloadCandidate(url, referer) {
  const response = await fetchWithTimeout(
    url,
    {
      method: 'GET',
      redirect: 'follow',
      headers: buildDownloadHeaders(referer),
    },
    60000,
  );

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      reason: `HTTP ${response.status}`,
      url,
      discovered: [],
    };
  }

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());

  if (contentType.includes('pdf') || bufferLooksLikePdf(buffer)) {
    return {
      ok: true,
      url,
      buffer,
      discovered: [],
    };
  }

  if (contentType.includes('html') || contentType.includes('text/')) {
    const html = buffer.toString('utf8');
    return {
      ok: false,
      url,
      reason: '返回的是网页而非 PDF',
      discovered: extractPdfLinksFromHtml(html, url),
    };
  }

  return {
    ok: false,
    url,
    reason: `内容类型不是 PDF（${contentType || 'unknown'}）`,
    discovered: [],
  };
}

async function resolveUniquePath(basePath) {
  let candidate = basePath;
  let counter = 1;

  while (true) {
    try {
      await fs.access(candidate);
      const parsed = path.parse(basePath);
      candidate = path.join(parsed.dir, `${parsed.name}-${counter}${parsed.ext}`);
      counter += 1;
    } catch {
      return candidate;
    }
  }
}

async function readSettings() {
  try {
    const content = await fs.readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(content);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(partial) {
  const current = await readSettings();
  const merged = { ...current, ...partial };
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

async function pickTargetPath(fileName, preferredDir) {
  const settings = await readSettings();

  if (settings.downloadDirectory) {
    return resolveUniquePath(path.join(preferredDir, fileName));
  }

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '保存 PDF',
    defaultPath: path.join(preferredDir, fileName),
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
  });

  if (canceled || !filePath) {
    return null;
  }

  return filePath;
}

async function downloadPdf(paper) {
  const settings = await readSettings();
  const name = sanitizeFileName(`${paper.title || 'paper'}.pdf`);
  const preferredDir = settings.downloadDirectory || app.getPath('downloads');
  const targetPath = await pickTargetPath(name, preferredDir);

  if (!targetPath) {
    return { canceled: true };
  }

  const doiUrl = paper.doi ? `https://doi.org/${paper.doi}` : '';
  const queue = uniqueUrls([
    paper.pdfUrl,
    ...((Array.isArray(paper.downloadCandidates) ? paper.downloadCandidates : [])),
    paper.url,
    doiUrl,
  ]);

  if (!queue.length) {
    throw new Error('没有可用下载链接');
  }

  const visited = new Set();
  const failures = [];

  while (queue.length && visited.size < 14) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);

    try {
      const result = await fetchDownloadCandidate(current, paper.url || undefined);

      if (result.ok) {
        await fs.writeFile(targetPath, result.buffer);
        return {
          canceled: false,
          filePath: targetPath,
          usedUrl: current,
        };
      }

      failures.push(`${current} -> ${result.reason || '失败'}`);
      if (result.discovered?.length) {
        queue.push(...result.discovered);
      }
    } catch (error) {
      failures.push(`${current} -> ${error.message}`);
    }
  }

  throw new Error(
    `下载失败：已尝试 ${visited.size} 个链接。可能原因：站点反爬、需校园 VPN、或原站点限制直接下载。`,
  );
}

app.whenReady().then(async () => {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');

  ipcMain.handle('app:get-settings', async () => {
    return readSettings();
  });

  ipcMain.handle('app:save-settings', async (_, partial) => {
    return writeSettings(partial || {});
  });

  ipcMain.handle('app:pick-download-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择默认下载目录',
    });

    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true };
    }

    const settings = await writeSettings({ downloadDirectory: result.filePaths[0] });
    return { canceled: false, directory: settings.downloadDirectory };
  });

  ipcMain.handle('app:open-external', async (_, url) => {
    if (!url) {
      throw new Error('URL 不能为空');
    }

    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('app:search-literature', async (_, payload) => {
    return searchLiterature(payload || {});
  });

  ipcMain.handle('app:download-pdf', async (_, paper) => {
    if (!paper?.pdfUrl) {
      throw new Error('该文献没有可下载 PDF 链接');
    }

    return downloadPdf(paper);
  });

  ipcMain.handle('zotero:test-connection', async (_, config) => {
    return testZoteroConnection(config || {});
  });

  ipcMain.handle('zotero:get-collections', async (_, config) => {
    return fetchZoteroCollections(config || {});
  });

  ipcMain.handle('zotero:save-item', async (_, payload) => {
    return savePaperToZotero(payload || {});
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
