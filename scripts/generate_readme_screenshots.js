const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const screenshotsDir = path.join(projectRoot, 'docs', 'screenshots');

const defaultSettings = {
  downloadDirectory: '/Users/leo/Downloads/Papers',
  zoteroUserId: '1234567',
  zoteroApiKey: '***',
  zoteroLibraryType: 'users',
  vpnLoginUrl: 'https://vpn.zjnu.edu.cn/',
  libraryHomeUrl: 'https://lib.zjnu.edu.cn/',
  googleScholarUrl: 'https://scholar.google.com/scholar?q={query}',
  cnkiUrl: 'https://kns.cnki.net/kns8s/defaultresult/index?kw={query}',
  webOfScienceUrl: 'https://www.webofscience.com/wos/woscc/basic-search?query={query}',
  openScholarUrl: 'https://www.semanticscholar.org/search?q={query}',
};

const sampleResults = [
  {
    id: 'demo-1',
    source: 'OpenAlex',
    title: 'Large Language Models in Higher Education: Opportunities and Risks',
    titleZh: '高等教育中的大语言模型：机遇与风险',
    titleEn: 'Large Language Models in Higher Education: Opportunities and Risks',
    abstractZh:
      '本研究系统梳理了大语言模型在高校教学、科研辅助与学术写作中的应用场景，并讨论了可信性、偏差控制与学术伦理等关键问题。',
    abstractEn:
      'This study reviews practical uses of large language models in university teaching, research support, and scholarly writing, and discusses reliability, bias mitigation, and academic ethics.',
    authors: ['Li Wei', 'Chen Ming', 'Wang Yu'],
    year: 2025,
    citationCount: 186,
    doi: '10.1000/demo.2025.001',
    journal: 'Computers & Education',
    url: 'https://example.org/paper1',
    pdfUrl: 'https://example.org/paper1.pdf',
    downloadCandidates: ['https://example.org/paper1.pdf'],
    sourceLinks: {
      googleScholar: 'https://scholar.google.com/scholar?q=Large%20Language%20Models%20in%20Higher%20Education',
      cnki: 'https://kns.cnki.net/kns8s/defaultresult/index?kw=%E5%A4%A7%E8%AF%AD%E8%A8%80%E6%A8%A1%E5%9E%8B',
      webOfScience: 'https://www.webofscience.com/wos/woscc/basic-search?query=Large%20Language%20Models',
      openScholar: 'https://www.semanticscholar.org/search?q=Large%20Language%20Models',
    },
  },
  {
    id: 'demo-2',
    source: 'arXiv',
    title: 'Adaptive Learning Path Recommendation with Knowledge Graphs',
    titleZh: '基于知识图谱的自适应学习路径推荐',
    titleEn: 'Adaptive Learning Path Recommendation with Knowledge Graphs',
    abstractZh:
      '文章提出一种融合知识图谱与学习行为序列的推荐框架，可在课程学习中动态生成个性化路径，并显著提升学习效率。',
    abstractEn:
      'We propose a recommendation framework that combines knowledge graphs with learning behavior sequences to dynamically generate personalized learning paths and improve learning efficiency.',
    authors: ['Zhao Ling', 'Sun Hao'],
    year: 2024,
    citationCount: 72,
    doi: '10.1000/demo.2024.010',
    journal: 'IEEE Transactions on Learning Technologies',
    url: 'https://example.org/paper2',
    pdfUrl: 'https://example.org/paper2.pdf',
    downloadCandidates: ['https://example.org/paper2.pdf'],
    sourceLinks: {
      googleScholar: 'https://scholar.google.com/scholar?q=Adaptive%20Learning%20Path%20Recommendation',
      cnki: 'https://kns.cnki.net/kns8s/defaultresult/index?kw=%E7%9F%A5%E8%AF%86%E5%9B%BE%E8%B0%B1',
      webOfScience: 'https://www.webofscience.com/wos/woscc/basic-search?query=Adaptive%20Learning%20Path',
      openScholar: 'https://www.semanticscholar.org/search?q=Adaptive%20Learning%20Path',
    },
  },
];

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureTo(window, filename) {
  const image = await window.webContents.capturePage();
  await fs.writeFile(path.join(screenshotsDir, filename), image.toPNG());
}

async function registerMockIpcHandlers() {
  ipcMain.handle('app:get-settings', async () => defaultSettings);
  ipcMain.handle('app:save-settings', async (_event, partial) => ({ ...defaultSettings, ...(partial || {}) }));
  ipcMain.handle('app:pick-download-directory', async () => ({
    canceled: false,
    directory: '/Users/leo/Downloads/Papers',
  }));
  ipcMain.handle('app:open-external', async () => ({ ok: true }));
  ipcMain.handle('app:search-literature', async (_event, payload) => ({
    query: payload?.query || 'demo',
    total: sampleResults.length,
    warnings: [],
    results: sampleResults,
  }));
  ipcMain.handle('app:download-pdf', async () => ({
    canceled: false,
    filePath: '/Users/leo/Downloads/Papers/demo.pdf',
    usedUrl: 'https://example.org/paper.pdf',
  }));

  ipcMain.handle('zotero:test-connection', async () => ({
    ok: true,
    userId: '1234567',
    writeEnabled: true,
    message: 'Zotero 连接成功（User ID: 1234567，可写入）',
  }));
  ipcMain.handle('zotero:get-collections', async () => ({
    ok: true,
    userId: '1234567',
    collections: [
      { key: 'COLL1', name: 'AI 教育', path: '科研 / AI 教育' },
      { key: 'COLL2', name: '教学改革', path: '科研 / 教学改革' },
      { key: 'COLL3', name: '方法论', path: '科研 / 方法论' },
    ],
  }));
  ipcMain.handle('zotero:save-item', async () => ({
    ok: true,
    userId: '1234567',
    itemKey: 'ABCD1234',
    attachmentLinked: true,
    warning: '',
  }));
}

async function main() {
  await fs.mkdir(screenshotsDir, { recursive: true });
  await registerMockIpcHandlers();

  const win = new BrowserWindow({
    width: 1460,
    height: 960,
    show: false,
    webPreferences: {
      preload: path.join(projectRoot, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadFile(path.join(projectRoot, 'src', 'index.html'));
  await wait(700);

  await captureTo(win, '01-home.png');

  await win.webContents.executeJavaScript(`
    document.getElementById('searchInput').value = 'large language model education';
    document.getElementById('searchForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  `);
  await wait(900);
  await captureTo(win, '02-results.png');

  await win.webContents.executeJavaScript(`
    document.querySelector('.settings-panel').setAttribute('open', 'open');
  `);
  await wait(500);
  await captureTo(win, '03-settings.png');

  await win.close();
}

app.whenReady().then(async () => {
  try {
    await main();
    app.quit();
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
