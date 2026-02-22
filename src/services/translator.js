const cache = new Map();

function hasChinese(text) {
  return /[\u4E00-\u9FFF]/.test(text);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

async function translateViaGoogle(text, targetLang) {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: 'auto',
    tl: targetLang,
    dt: 't',
    q: text,
  });

  const url = `https://translate.googleapis.com/translate_a/single?${params.toString()}`;
  const data = await fetchJson(url);

  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('Google 翻译返回格式异常');
  }

  return data[0]
    .map((segment) => (Array.isArray(segment) ? segment[0] : ''))
    .join('')
    .trim();
}

async function translateViaMyMemory(text, targetLang) {
  const langPair = targetLang === 'zh-CN' ? 'auto|zh-CN' : 'auto|en';
  const params = new URLSearchParams({
    q: text,
    langpair: langPair,
  });

  const url = `https://api.mymemory.translated.net/get?${params.toString()}`;
  const data = await fetchJson(url);
  const translated = data?.responseData?.translatedText;

  if (!translated || typeof translated !== 'string') {
    throw new Error('MyMemory 翻译返回为空');
  }

  return translated.trim();
}

async function translate(text, targetLang) {
  const value = (text || '').trim();
  if (!value) {
    return '';
  }

  const key = `${targetLang}:${value}`;
  if (cache.has(key)) {
    return cache.get(key);
  }

  const compact = value.slice(0, 1000);

  try {
    const translated = await translateViaGoogle(compact, targetLang);
    cache.set(key, translated);
    return translated;
  } catch {
    try {
      const translated = await translateViaMyMemory(compact, targetLang);
      cache.set(key, translated);
      return translated;
    } catch {
      cache.set(key, value);
      return value;
    }
  }
}

async function toBilingualAbstract(abstract) {
  const text = (abstract || '').trim();
  if (!text) {
    return {
      abstractZh: '',
      abstractEn: '',
    };
  }

  if (hasChinese(text)) {
    const abstractEn = await translate(text, 'en');
    return {
      abstractZh: text,
      abstractEn,
    };
  }

  const abstractZh = await translate(text, 'zh-CN');
  return {
    abstractZh,
    abstractEn: text,
  };
}

async function toBilingualText(text) {
  const value = (text || '').trim();
  if (!value) {
    return {
      zh: '',
      en: '',
    };
  }

  if (hasChinese(value)) {
    return {
      zh: value,
      en: await translate(value, 'en'),
    };
  }

  return {
    zh: await translate(value, 'zh-CN'),
    en: value,
  };
}

module.exports = {
  toBilingualAbstract,
  toBilingualText,
};
