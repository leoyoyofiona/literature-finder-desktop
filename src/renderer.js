const state = {
  settings: null,
  results: [],
  collections: [],
};

const TOAST_DURATION_MS = 3600;
let toastTimer = null;

const els = {
  searchForm: document.getElementById('searchForm'),
  searchInput: document.getElementById('searchInput'),
  sortSelect: document.getElementById('sortSelect'),
  limitSelect: document.getElementById('limitSelect'),
  searchBtn: document.getElementById('searchBtn'),
  openVpnQuickBtn: document.getElementById('openVpnQuickBtn'),
  openLibraryQuickBtn: document.getElementById('openLibraryQuickBtn'),
  openCnkiQuickBtn: document.getElementById('openCnkiQuickBtn'),
  openWosQuickBtn: document.getElementById('openWosQuickBtn'),

  downloadDir: document.getElementById('downloadDir'),
  pickDirBtn: document.getElementById('pickDirBtn'),

  zoteroUserId: document.getElementById('zoteroUserId'),
  zoteroApiKey: document.getElementById('zoteroApiKey'),
  zoteroLibraryType: document.getElementById('zoteroLibraryType'),

  vpnLoginUrl: document.getElementById('vpnLoginUrl'),
  openVpnBtn: document.getElementById('openVpnBtn'),
  libraryHomeUrl: document.getElementById('libraryHomeUrl'),
  googleScholarUrl: document.getElementById('googleScholarUrl'),
  cnkiUrl: document.getElementById('cnkiUrl'),
  webOfScienceUrl: document.getElementById('webOfScienceUrl'),
  openScholarUrl: document.getElementById('openScholarUrl'),

  saveSettingsBtn: document.getElementById('saveSettingsBtn'),
  testZoteroBtn: document.getElementById('testZoteroBtn'),
  loadCollectionsBtn: document.getElementById('loadCollectionsBtn'),
  collectionSelect: document.getElementById('collectionSelect'),

  statusBox: document.getElementById('statusBox'),
  warningBox: document.getElementById('warningBox'),
  results: document.getElementById('results'),
};

function ensureToastElement() {
  let toast = document.getElementById('actionToast');
  if (toast) {
    return toast;
  }

  toast = document.createElement('div');
  toast.id = 'actionToast';
  toast.className = 'action-toast hidden';
  document.body.appendChild(toast);
  return toast;
}

function showLocalStatus(anchorEl, text, kind = 'info') {
  if (!anchorEl || typeof anchorEl.getBoundingClientRect !== 'function') {
    return;
  }

  const toast = ensureToastElement();
  const rect = anchorEl.getBoundingClientRect();

  toast.textContent = text;
  toast.classList.remove('hidden', 'ok', 'error');
  if (kind === 'ok') {
    toast.classList.add('ok');
  }
  if (kind === 'error') {
    toast.classList.add('error');
  }

  const top = Math.min(window.innerHeight - 12, Math.max(12, rect.bottom + 8));
  const left = Math.min(window.innerWidth - 16, Math.max(16, rect.left + 4));
  toast.style.top = `${top}px`;
  toast.style.left = `${left}px`;

  if (toastTimer) {
    clearTimeout(toastTimer);
  }
  toastTimer = setTimeout(() => {
    toast.classList.add('hidden');
    toastTimer = null;
  }, TOAST_DURATION_MS);
}

function setStatus(text, kind = 'info', anchorEl = null) {
  els.statusBox.textContent = text;
  els.statusBox.classList.remove('ok', 'error');
  if (kind === 'ok') {
    els.statusBox.classList.add('ok');
  }
  if (kind === 'error') {
    els.statusBox.classList.add('error');
  }

  if (anchorEl) {
    showLocalStatus(anchorEl, text, kind);
  }
}

function getZoteroConfigFromInputs() {
  return {
    userId: els.zoteroUserId.value.trim(),
    apiKey: els.zoteroApiKey.value.trim(),
    libraryType: els.zoteroLibraryType.value,
  };
}

function getLinkConfigFromInputs() {
  return {
    googleScholarUrl: els.googleScholarUrl.value.trim(),
    cnkiUrl: els.cnkiUrl.value.trim(),
    webOfScienceUrl: els.webOfScienceUrl.value.trim(),
    openScholarUrl: els.openScholarUrl.value.trim(),
  };
}

async function openConfiguredUrl(url, emptyMessage, okMessage, anchorEl = null) {
  const target = String(url || '').trim();
  if (!target) {
    setStatus(emptyMessage, 'error', anchorEl);
    return;
  }

  try {
    await window.desktopAPI.openExternal(target);
    setStatus(okMessage, 'ok', anchorEl);
  } catch (error) {
    setStatus(`打开失败：${error.message}`, 'error', anchorEl);
  }
}

function applyResolvedUserId(userId) {
  const value = String(userId || '').trim();
  if (!value) {
    return;
  }
  els.zoteroUserId.value = value;
}

function renderWarnings(warnings) {
  const list = Array.isArray(warnings) ? warnings.filter(Boolean) : [];

  if (!list.length) {
    els.warningBox.classList.add('hidden');
    els.warningBox.innerHTML = '';
    return;
  }

  const ul = document.createElement('ul');
  list.forEach((warning) => {
    const li = document.createElement('li');
    li.textContent = warning;
    ul.appendChild(li);
  });

  els.warningBox.innerHTML = '';
  els.warningBox.appendChild(ul);
  els.warningBox.classList.remove('hidden');
}

function paperMetaText(paper) {
  const chunks = [];

  if (paper.year) {
    chunks.push(`年份：${paper.year}`);
  }

  chunks.push(`被引：${paper.citationCount || 0}`);
  chunks.push(`来源：${paper.source || '未知'}`);

  if (paper.journal) {
    chunks.push(`刊物：${paper.journal}`);
  }

  if (Array.isArray(paper.authors) && paper.authors.length) {
    chunks.push(`作者：${paper.authors.slice(0, 8).join('，')}`);
  }

  if (paper.doi) {
    chunks.push(`DOI：${paper.doi}`);
  }

  return chunks.join(' ｜ ');
}

async function handleDownload(paper, button) {
  button.disabled = true;
  const oldText = button.textContent;
  button.textContent = '下载中...';

  try {
    const result = await window.desktopAPI.downloadPdf(paper);
    if (result?.canceled) {
      setStatus('取消下载', 'info', button);
      return;
    }

    const channel = result?.usedUrl ? `（来源链接：${result.usedUrl}）` : '';
    setStatus(`下载完成：${result.filePath}${channel}`, 'ok', button);
  } catch (error) {
    setStatus(`下载失败：${error.message}`, 'error', button);
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

async function handleSaveToZotero(paper, button) {
  const config = getZoteroConfigFromInputs();
  if (!config.apiKey) {
    setStatus('请先在设置中填写 Zotero API Key', 'error', button);
    return;
  }

  button.disabled = true;
  const oldText = button.textContent;
  button.textContent = '写入中...';

  try {
    const result = await window.desktopAPI.saveToZotero({
      paper,
      collectionKey: els.collectionSelect.value || undefined,
      config,
    });

    applyResolvedUserId(result.userId);

    if (result.warning) {
      setStatus(`已写入 Zotero（${result.itemKey}），但有提醒：${result.warning}`, 'info', button);
      return;
    }

    setStatus(`已写入 Zotero：${result.itemKey}`, 'ok', button);
  } catch (error) {
    setStatus(`写入 Zotero 失败：${error.message}`, 'error', button);
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

function createSourceJumpButton(label, url) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'link-chip';
  btn.textContent = label;

  if (!url) {
    btn.disabled = true;
    btn.title = '未配置入口地址';
    return btn;
  }

  btn.addEventListener('click', async () => {
    try {
      await window.desktopAPI.openExternal(url);
    } catch (error) {
      setStatus(`打开外部链接失败：${error.message}`, 'error', btn);
    }
  });
  return btn;
}

function renderResults() {
  els.results.innerHTML = '';

  if (!state.results.length) {
    const empty = document.createElement('article');
    empty.className = 'paper-card';
    empty.textContent = '没有检索到符合条件的可下载文献，请换关键词再试。';
    els.results.appendChild(empty);
    return;
  }

  state.results.forEach((paper) => {
    const card = document.createElement('article');
    card.className = 'paper-card';

    const titleZh = document.createElement('h3');
    titleZh.className = 'paper-title';
    titleZh.textContent = paper.titleZh || paper.title || '';

    const titleEn = document.createElement('div');
    titleEn.className = 'paper-title-en';
    titleEn.textContent = paper.titleEn || paper.title || '';

    const meta = document.createElement('div');
    meta.className = 'paper-meta';
    meta.textContent = paperMetaText(paper);

    const abstractGrid = document.createElement('section');
    abstractGrid.className = 'abstract-grid';

    const zhBlock = document.createElement('div');
    zhBlock.className = 'abstract-block';
    const zhTitle = document.createElement('h4');
    zhTitle.textContent = '摘要（中文）';
    const zhText = document.createElement('p');
    zhText.textContent = paper.abstractZh || '暂无';
    zhBlock.appendChild(zhTitle);
    zhBlock.appendChild(zhText);

    const enBlock = document.createElement('div');
    enBlock.className = 'abstract-block';
    const enTitle = document.createElement('h4');
    enTitle.textContent = 'Abstract (English)';
    const enText = document.createElement('p');
    enText.textContent = paper.abstractEn || 'N/A';
    enBlock.appendChild(enTitle);
    enBlock.appendChild(enText);

    abstractGrid.appendChild(zhBlock);
    abstractGrid.appendChild(enBlock);

    const actions = document.createElement('div');
    actions.className = 'paper-actions';

    const zoteroBtn = document.createElement('button');
    zoteroBtn.type = 'button';
    zoteroBtn.textContent = '保存到 Zotero';
    zoteroBtn.addEventListener('click', () => handleSaveToZotero(paper, zoteroBtn));

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'warn';
    downloadBtn.textContent = '下载 PDF';
    downloadBtn.addEventListener('click', () => handleDownload(paper, downloadBtn));

    const scholarBtn = createSourceJumpButton('Google Scholar', paper.sourceLinks.googleScholar);
    const cnkiBtn = createSourceJumpButton('CNKI', paper.sourceLinks.cnki);
    const wosBtn = createSourceJumpButton('Web of Science', paper.sourceLinks.webOfScience);
    const openScholarBtn = createSourceJumpButton('OpenScholar', paper.sourceLinks.openScholar);

    actions.appendChild(zoteroBtn);
    actions.appendChild(downloadBtn);
    actions.appendChild(scholarBtn);
    actions.appendChild(cnkiBtn);
    actions.appendChild(wosBtn);
    actions.appendChild(openScholarBtn);

    card.appendChild(titleZh);
    card.appendChild(titleEn);
    card.appendChild(meta);
    card.appendChild(abstractGrid);
    card.appendChild(actions);

    els.results.appendChild(card);
  });
}

function renderCollections() {
  els.collectionSelect.innerHTML = '';

  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = '不指定（保存到根目录）';
  els.collectionSelect.appendChild(defaultOption);

  state.collections.forEach((collection) => {
    const option = document.createElement('option');
    option.value = collection.key;
    option.textContent = collection.path;
    els.collectionSelect.appendChild(option);
  });
}

async function saveSettingsFromInputs(anchorEl = null) {
  const payload = {
    downloadDirectory: els.downloadDir.value.trim(),
    zoteroUserId: els.zoteroUserId.value.trim(),
    zoteroApiKey: els.zoteroApiKey.value.trim(),
    zoteroLibraryType: els.zoteroLibraryType.value,
    vpnLoginUrl: els.vpnLoginUrl.value.trim(),
    libraryHomeUrl: els.libraryHomeUrl.value.trim(),
    googleScholarUrl: els.googleScholarUrl.value.trim(),
    cnkiUrl: els.cnkiUrl.value.trim(),
    webOfScienceUrl: els.webOfScienceUrl.value.trim(),
    openScholarUrl: els.openScholarUrl.value.trim(),
  };

  const saved = await window.desktopAPI.saveSettings(payload);
  state.settings = saved;
  setStatus('设置已保存', 'ok', anchorEl);
}

async function loadCollections(anchorEl = null) {
  const config = getZoteroConfigFromInputs();
  if (!config.apiKey) {
    setStatus('请先填写 Zotero API Key，再加载分类', 'error', anchorEl);
    return;
  }

  setStatus('正在加载 Zotero 分类...', 'info', anchorEl);
  const result = await window.desktopAPI.getZoteroCollections(config);
  applyResolvedUserId(result.userId);
  state.collections = result.collections || [];
  renderCollections();
  setStatus(`已加载 ${state.collections.length} 个 Zotero 分类`, 'ok', anchorEl);
}

async function runSearch() {
  const query = els.searchInput.value.trim();
  if (!query) {
    setStatus('请输入检索关键词', 'error', els.searchBtn);
    return;
  }

  const payload = {
    query,
    sort: els.sortSelect.value,
    limit: Number(els.limitSelect.value),
    linkConfig: getLinkConfigFromInputs(),
  };

  els.searchBtn.disabled = true;
  const oldText = els.searchBtn.textContent;
  els.searchBtn.textContent = '检索中...';
  setStatus('正在检索并翻译摘要，请稍候...', 'info', els.searchBtn);

  try {
    const response = await window.desktopAPI.searchLiterature(payload);
    state.results = response.results || [];
    renderWarnings(response.warnings || []);
    renderResults();
    setStatus(`检索完成：返回 ${state.results.length} 条可下载文献`, 'ok', els.searchBtn);
  } catch (error) {
    setStatus(`检索失败：${error.message}`, 'error', els.searchBtn);
  } finally {
    els.searchBtn.disabled = false;
    els.searchBtn.textContent = oldText;
  }
}

async function bootstrap() {
  els.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    runSearch();
  });

  els.pickDirBtn.addEventListener('click', async () => {
    try {
      const result = await window.desktopAPI.pickDownloadDirectory();
      if (!result.canceled) {
        els.downloadDir.value = result.directory || '';
        setStatus(`默认下载目录已更新：${result.directory}`, 'ok', els.pickDirBtn);
      }
    } catch (error) {
      setStatus(`选择目录失败：${error.message}`, 'error', els.pickDirBtn);
    }
  });

  els.openVpnBtn.addEventListener('click', async () => {
    await openConfiguredUrl(
      els.vpnLoginUrl.value,
      '请先填写学校 VPN 登录地址',
      '已打开 VPN 登录页，请在浏览器完成登录',
      els.openVpnBtn,
    );
  });

  els.openVpnQuickBtn.addEventListener('click', async () => {
    await openConfiguredUrl(
      els.vpnLoginUrl.value,
      '请先在设置中填写学校 VPN 登录地址',
      '已打开 VPN 登录页，请先完成登录再访问数据库',
      els.openVpnQuickBtn,
    );
  });

  els.openLibraryQuickBtn.addEventListener('click', async () => {
    await openConfiguredUrl(
      els.libraryHomeUrl.value,
      '请先在设置中填写学校图书馆入口地址',
      '已打开学校图书馆入口',
      els.openLibraryQuickBtn,
    );
  });

  els.openCnkiQuickBtn.addEventListener('click', async () => {
    await openConfiguredUrl(
      els.cnkiUrl.value,
      '请先在设置中填写学校 CNKI 入口地址',
      '已打开学校 CNKI 入口',
      els.openCnkiQuickBtn,
    );
  });

  els.openWosQuickBtn.addEventListener('click', async () => {
    await openConfiguredUrl(
      els.webOfScienceUrl.value,
      '请先在设置中填写学校 Web of Science 入口地址',
      '已打开学校 Web of Science 入口',
      els.openWosQuickBtn,
    );
  });

  els.saveSettingsBtn.addEventListener('click', async () => {
    try {
      await saveSettingsFromInputs(els.saveSettingsBtn);
    } catch (error) {
      setStatus(`保存设置失败：${error.message}`, 'error', els.saveSettingsBtn);
    }
  });

  els.testZoteroBtn.addEventListener('click', async () => {
    try {
      const config = getZoteroConfigFromInputs();
      const result = await window.desktopAPI.testZoteroConnection(config);
      applyResolvedUserId(result.userId);
      await saveSettingsFromInputs(els.testZoteroBtn);
      if (result.writeEnabled) {
        setStatus(result.message || 'Zotero 连接成功', 'ok', els.testZoteroBtn);
      } else {
        setStatus(
          `${result.message}。请到 zotero.org/settings/keys 开启写入权限后再试。`,
          'error',
          els.testZoteroBtn,
        );
      }
    } catch (error) {
      setStatus(`Zotero 连接失败：${error.message}`, 'error', els.testZoteroBtn);
    }
  });

  els.loadCollectionsBtn.addEventListener('click', async () => {
    const oldText = els.loadCollectionsBtn.textContent;
    els.loadCollectionsBtn.disabled = true;
    els.loadCollectionsBtn.textContent = '加载中...';
    try {
      await loadCollections(els.loadCollectionsBtn);
      await saveSettingsFromInputs(els.loadCollectionsBtn);
    } catch (error) {
      setStatus(`加载分类失败：${error.message}`, 'error', els.loadCollectionsBtn);
    } finally {
      els.loadCollectionsBtn.disabled = false;
      els.loadCollectionsBtn.textContent = oldText;
    }
  });

  const settings = await window.desktopAPI.getSettings();
  state.settings = settings;

  els.downloadDir.value = settings.downloadDirectory || '';
  els.zoteroUserId.value = settings.zoteroUserId || '';
  els.zoteroApiKey.value = settings.zoteroApiKey || '';
  els.zoteroLibraryType.value = settings.zoteroLibraryType || 'users';

  els.vpnLoginUrl.value = settings.vpnLoginUrl || '';
  els.libraryHomeUrl.value = settings.libraryHomeUrl || '';
  els.googleScholarUrl.value = settings.googleScholarUrl || '';
  els.cnkiUrl.value = settings.cnkiUrl || '';
  els.webOfScienceUrl.value = settings.webOfScienceUrl || '';
  els.openScholarUrl.value = settings.openScholarUrl || '';

  renderCollections();

  if (settings.zoteroApiKey) {
    try {
      await loadCollections();
    } catch {
      setStatus('已加载本地设置。你可以点击“测试 Zotero 连接”检查配置。');
    }
  }
}

bootstrap().catch((error) => {
  setStatus(`初始化失败：${error.message}`, 'error');
});
