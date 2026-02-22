const BASE_URL = 'https://api.zotero.org';

function normalizeUserId(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    return '';
  }

  if (/^\d+$/.test(raw)) {
    return raw;
  }

  const match = raw.match(/(\d{3,})/);
  return match ? match[1] : raw;
}

async function zoteroRequestByUrl(url, apiKey, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  const response = await fetch(url, {
    method,
    headers: {
      'Zotero-API-Key': apiKey,
      'Zotero-API-Version': '3',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Zotero API 失败 (${response.status})${text ? `: ${text.slice(0, 220)}` : ''}`,
    );
  }

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function fetchCurrentKeyInfo(apiKey) {
  return zoteroRequestByUrl(`${BASE_URL}/keys/current`, apiKey, { method: 'GET' });
}

function isAccessEnabled(accessNode, requireWrite) {
  if (accessNode === true) {
    return true;
  }

  if (!accessNode || typeof accessNode !== 'object') {
    return false;
  }

  if (requireWrite) {
    if (accessNode.write === true) {
      return true;
    }
    if (accessNode.library === true && accessNode.write !== false) {
      return true;
    }
    return false;
  }

  return accessNode.library === true || accessNode.read === true || accessNode.write === true;
}

function pickGroupId(groupsAccess, { requireWrite = false } = {}) {
  if (!groupsAccess || typeof groupsAccess !== 'object') {
    return '';
  }

  const candidates = Object.entries(groupsAccess).filter(([groupId]) => /^\d+$/.test(groupId));
  const preferred = candidates.find(([, access]) => isAccessEnabled(access, requireWrite));

  if (preferred) {
    return preferred[0];
  }

  const fallback = candidates.find(([, access]) => isAccessEnabled(access, false));
  return fallback ? fallback[0] : '';
}

function hasWritePermission(keyInfo, libraryType, userId) {
  if (libraryType === 'users') {
    return isAccessEnabled(keyInfo?.access?.user, true);
  }

  const groups = keyInfo?.access?.groups;
  if (!groups || typeof groups !== 'object') {
    return false;
  }

  if (userId && isAccessEnabled(groups[userId], true)) {
    return true;
  }

  if (isAccessEnabled(groups.all, true)) {
    return true;
  }

  return false;
}

function buildWriteDeniedMessage(libraryType, userId) {
  if (libraryType === 'groups') {
    return `当前 API Key 对群组库 ${userId || '(未识别)'} 无写权限。请在 zotero.org/settings/keys 重新创建/编辑 key，勾选对应群组的 Write 权限，或切换为个人库 (users)。`;
  }

  return '当前 API Key 没有个人库写权限。请在 zotero.org/settings/keys 重新创建/编辑 key，并勾选 Allow library write access。';
}

async function resolveConfig(rawConfig) {
  const apiKey = String(rawConfig?.apiKey || '').trim();
  const libraryType = rawConfig?.libraryType === 'groups' ? 'groups' : 'users';

  if (!apiKey) {
    throw new Error('请填写 Zotero API Key');
  }

  const keyInfo = await fetchCurrentKeyInfo(apiKey);
  let userId = normalizeUserId(rawConfig?.userId);

  const currentUserId = String(keyInfo?.userID || '').trim();
  const groupsAccess =
    keyInfo?.access?.groups && typeof keyInfo.access.groups === 'object' ? keyInfo.access.groups : {};

  if (libraryType === 'users') {
    // users 库始终与 key 所属账号一致，避免手填错误 ID。
    userId = currentUserId;
  } else {
    const providedUsable = /^\d+$/.test(userId) && isAccessEnabled(groupsAccess[userId], false);
    if (!providedUsable) {
      userId = pickGroupId(groupsAccess, { requireWrite: false }) || '';
    }
  }

  if (!userId || !/^\d+$/.test(userId)) {
    if (libraryType === 'groups') {
      throw new Error('当前 API Key 没有关联可访问的群组库，请切换为个人库(users)或更换具备群组权限的 Key。');
    }
    throw new Error('无法识别 Zotero User ID，请先在 zotero.org 登录并确认账号有效。');
  }

  return {
    userId,
    apiKey,
    libraryType,
    base: `${BASE_URL}/${libraryType}/${userId}`,
    keyInfo,
  };
}

async function zoteroRequest(config, pathname, options = {}) {
  return zoteroRequestByUrl(`${config.base}${pathname}`, config.apiKey, options);
}

function formatCollectionPath(collectionMap, key) {
  const names = [];
  let current = collectionMap.get(key);

  while (current) {
    names.unshift(current.name);
    if (!current.parentCollection) {
      break;
    }
    current = collectionMap.get(current.parentCollection);
  }

  return names.join(' / ');
}

function toCreator(fullName) {
  const name = String(fullName || '').trim();
  if (!name) {
    return null;
  }

  const parts = name.split(/\s+/);
  if (parts.length === 1) {
    return {
      creatorType: 'author',
      firstName: '',
      lastName: parts[0],
    };
  }

  return {
    creatorType: 'author',
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts[parts.length - 1],
  };
}

function compactObject(input) {
  const output = {};

  Object.entries(input).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      if (value.length) {
        output[key] = value;
      }
      return;
    }

    if (value !== null && value !== undefined && value !== '') {
      output[key] = value;
    }
  });

  return output;
}

async function testZoteroConnection(rawConfig) {
  const config = await resolveConfig(rawConfig);

  await zoteroRequest(config, '/items/top?limit=1');
  const writeEnabled = hasWritePermission(config.keyInfo, config.libraryType, config.userId);

  return {
    ok: true,
    userId: config.userId,
    writeEnabled,
    message: writeEnabled
      ? `Zotero 连接成功（User ID: ${config.userId}，可写入）`
      : `Zotero 连接成功（User ID: ${config.userId}，但 API Key 无写入权限）`,
  };
}

async function fetchZoteroCollections(rawConfig) {
  const config = await resolveConfig(rawConfig);

  const collections = await zoteroRequest(config, '/collections?limit=200');
  const list = Array.isArray(collections) ? collections : [];

  const map = new Map();
  list.forEach((collection) => {
    map.set(collection.key, {
      key: collection.key,
      name: collection?.data?.name || collection.key,
      parentCollection: collection?.data?.parentCollection || '',
    });
  });

  const output = list
    .map((collection) => {
      const key = collection.key;
      return {
        key,
        name: collection?.data?.name || key,
        path: formatCollectionPath(map, key),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));

  return {
    ok: true,
    userId: config.userId,
    collections: output,
  };
}

async function savePaperToZotero({ paper, collectionKey, config: rawConfig }) {
  if (!paper?.title) {
    throw new Error('缺少文献信息，无法写入 Zotero');
  }

  const config = await resolveConfig(rawConfig);
  const writeEnabled = hasWritePermission(config.keyInfo, config.libraryType, config.userId);
  if (!writeEnabled) {
    throw new Error(buildWriteDeniedMessage(config.libraryType, config.userId));
  }

  const creators = Array.isArray(paper.authors)
    ? paper.authors.map(toCreator).filter(Boolean)
    : [];

  const item = compactObject({
    itemType: 'journalArticle',
    title: paper.titleEn || paper.title || '',
    creators,
    abstractNote: paper.abstractEn || paper.abstract || '',
    publicationTitle: paper.journal || '',
    date: paper.year ? String(paper.year) : '',
    DOI: paper.doi || '',
    url: paper.url || paper.pdfUrl || '',
    tags: [{ tag: `source:${paper.source || 'unknown'}` }],
    collections: collectionKey ? [collectionKey] : [],
  });

  let creationResult;
  try {
    creationResult = await zoteroRequest(config, '/items', {
      method: 'POST',
      body: [item],
    });
  } catch (error) {
    const text = String(error?.message || '');
    if (text.includes('(403)') || /write access denied/i.test(text)) {
      throw new Error(buildWriteDeniedMessage(config.libraryType, config.userId));
    }
    throw error;
  }

  const created = creationResult?.successful?.['0'];
  if (!created?.key) {
    throw new Error('文献已请求写入 Zotero，但未收到条目 key');
  }

  let attachmentLinked = false;
  let warning = '';

  if (paper.pdfUrl) {
    const attachment = compactObject({
      itemType: 'attachment',
      parentItem: created.key,
      linkMode: 'linked_url',
      title: 'PDF',
      url: paper.pdfUrl,
      contentType: 'application/pdf',
      collections: collectionKey ? [collectionKey] : [],
    });

    try {
      await zoteroRequest(config, '/items', {
        method: 'POST',
        body: [attachment],
      });
      attachmentLinked = true;
    } catch (error) {
      warning = `条目已保存，但 PDF 附件链接失败：${error.message}`;
    }
  }

  return {
    ok: true,
    userId: config.userId,
    itemKey: created.key,
    attachmentLinked,
    warning,
  };
}

module.exports = {
  testZoteroConnection,
  fetchZoteroCollections,
  savePaperToZotero,
};
