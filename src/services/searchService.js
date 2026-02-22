const { XMLParser } = require('fast-xml-parser');
const { toBilingualAbstract, toBilingualText } = require('./translator');

const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};
const pdfReachabilityCache = new Map();
const DEFAULT_LINK_CONFIG = {
  googleScholarUrl: 'https://scholar.google.com/scholar?q={query}',
  cnkiUrl: 'https://kns.cnki.net/kns8s/defaultresult/index?kw={query}',
  webOfScienceUrl: 'https://www.webofscience.com/wos/woscc/basic-search?query={query}',
  openScholarUrl: 'https://www.semanticscholar.org/search?q={query}',
};

function ensureArray(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function reconstructOpenAlexAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') {
    return '';
  }

  const words = [];
  Object.entries(invertedIndex).forEach(([word, positions]) => {
    ensureArray(positions).forEach((position) => {
      const index = Number(position);
      if (Number.isInteger(index) && index >= 0) {
        words[index] = word;
      }
    });
  });

  return words.filter(Boolean).join(' ').trim();
}

function normalizeDoi(doi) {
  if (!doi) {
    return '';
  }

  return doi
    .replace(/^https?:\/\/doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .trim();
}

function buildSearchUrl(template, query) {
  const rawTemplate = String(template || '').trim();
  if (!rawTemplate) {
    return '';
  }

  const encoded = encodeURIComponent(query);
  if (rawTemplate.includes('{query}')) {
    return rawTemplate.replaceAll('{query}', encoded);
  }

  if (rawTemplate.includes('%s')) {
    return rawTemplate.replaceAll('%s', encoded);
  }

  return rawTemplate;
}

function buildSourceLinks(query, linkConfig = {}) {
  const config = { ...DEFAULT_LINK_CONFIG, ...(linkConfig || {}) };
  const q = query || '';

  return {
    googleScholar: buildSearchUrl(config.googleScholarUrl, q),
    cnki: buildSearchUrl(config.cnkiUrl, q),
    webOfScience: buildSearchUrl(config.webOfScienceUrl, q),
    openScholar: buildSearchUrl(config.openScholarUrl, q),
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
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

function isLikelyPdfUrl(url) {
  if (!url) {
    return false;
  }

  const value = String(url).toLowerCase();
  return (
    value.includes('.pdf') ||
    value.includes('/pdf') ||
    value.includes('content/pdf') ||
    value.includes('download')
  );
}

function collectOpenAlexPdfCandidates(work) {
  const candidates = [];
  const bestLocation = work.best_oa_location || {};
  const primaryLocation = work.primary_location || {};

  if (bestLocation.pdf_url) {
    candidates.push(bestLocation.pdf_url);
  }

  if (primaryLocation.pdf_url) {
    candidates.push(primaryLocation.pdf_url);
  }

  ensureArray(work.locations).forEach((location) => {
    if (location?.pdf_url) {
      candidates.push(location.pdf_url);
    }
  });

  if (work.open_access?.oa_url) {
    candidates.push(work.open_access.oa_url);
  }

  return Array.from(new Set(candidates.filter((url) => isLikelyPdfUrl(url))));
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(
    url,
    {
      headers: REQUEST_HEADERS,
    },
    20000,
  );

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

async function fetchText(url) {
  const response = await fetchWithTimeout(
    url,
    {
      headers: REQUEST_HEADERS,
    },
    20000,
  );

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
}

async function fetchWithFallback(url, method = 'HEAD') {
  const headers =
    method === 'GET'
      ? {
          ...REQUEST_HEADERS,
          Range: 'bytes=0-1023',
        }
      : { ...REQUEST_HEADERS };

  return fetchWithTimeout(
    url,
    {
      method,
      redirect: 'follow',
      headers,
    },
    6000,
  );
}

async function isDownloadablePdf(url) {
  if (!url) {
    return false;
  }

  if (pdfReachabilityCache.has(url)) {
    return pdfReachabilityCache.get(url);
  }

  let downloadable = false;

  try {
    const head = await fetchWithFallback(url, 'HEAD');
    const headType = String(head.headers.get('content-type') || '').toLowerCase();

    if (head.ok && headType.includes('pdf')) {
      downloadable = true;
    } else if (head.ok && head.status !== 405) {
      downloadable = false;
    } else {
      const partial = await fetchWithFallback(url, 'GET');
      const partialType = String(partial.headers.get('content-type') || '').toLowerCase();

      if (partial.ok && partialType.includes('pdf')) {
        downloadable = true;
      } else if (partial.ok) {
        const chunk = Buffer.from(await partial.arrayBuffer()).toString('latin1');
        downloadable = chunk.includes('%PDF-');
      }
    }
  } catch {
    downloadable = false;
  }

  pdfReachabilityCache.set(url, downloadable);
  return downloadable;
}

async function chooseFirstDownloadableCandidate(paper) {
  const candidates = Array.from(
    new Set([paper.pdfUrl, ...ensureArray(paper.downloadCandidates)].filter(Boolean)),
  );

  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await isDownloadablePdf(candidate);
    if (ok) {
      return candidate;
    }
  }

  return '';
}

async function filterGuaranteedDownloadable(results, limit) {
  const candidateCount = Math.max(limit * 5, 50);
  const candidates = results.slice(0, candidateCount);

  const checked = await mapWithConcurrency(
    candidates,
    async (paper) => {
      const selectedUrl = await chooseFirstDownloadableCandidate(paper);
      return {
        paper: selectedUrl ? { ...paper, pdfUrl: selectedUrl } : paper,
        ok: Boolean(selectedUrl),
      };
    },
    6,
  );

  return checked
    .filter((entry) => entry.ok)
    .map((entry) => entry.paper)
    .slice(0, limit);
}

async function searchOpenAlex(query, perPage = 35) {
  const params = new URLSearchParams({
    search: query,
    'per-page': String(perPage),
    filter: 'has_abstract:true,open_access.is_oa:true',
  });

  const data = await fetchJson(`https://api.openalex.org/works?${params.toString()}`);
  const works = ensureArray(data?.results);

  return works
    .map((work, index) => {
      const doi = normalizeDoi(work.doi);
      const abstract = reconstructOpenAlexAbstract(work.abstract_inverted_index);
      const downloadCandidates = collectOpenAlexPdfCandidates(work);
      const pdfUrl = downloadCandidates[0] || '';
      const url = work.primary_location?.landing_page_url || work.id || '';

      return {
        id: `openalex:${work.id || index}`,
        source: 'OpenAlex',
        title: (work.title || '').trim(),
        abstract,
        authors: ensureArray(work.authorships)
          .map((authorShip) => authorShip?.author?.display_name)
          .filter(Boolean),
        year: work.publication_year || null,
        citationCount: work.cited_by_count || 0,
        doi,
        journal: work.primary_location?.source?.display_name || '',
        url,
        pdfUrl,
        downloadCandidates,
        relevanceScore: 1000 - index * 3 + Math.min(work.cited_by_count || 0, 800) / 8,
      };
    })
    .filter((paper) => paper.title && paper.abstract && paper.pdfUrl);
}

async function searchSemanticScholar(query, limit = 35) {
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    fields:
      'title,abstract,year,citationCount,authors,url,externalIds,openAccessPdf,publicationVenue',
  });

  const data = await fetchJson(
    `https://api.semanticscholar.org/graph/v1/paper/search?${params.toString()}`,
  );

  const papers = ensureArray(data?.data);

  return papers
    .map((paper, index) => {
      const doi = normalizeDoi(paper?.externalIds?.DOI || '');
      const rawPdfUrl = paper?.openAccessPdf?.url || '';
      const pdfUrl = isLikelyPdfUrl(rawPdfUrl) ? rawPdfUrl : '';
      const url = paper?.url || (doi ? `https://doi.org/${doi}` : '');

      return {
        id: `semanticscholar:${paper.paperId || index}`,
        source: 'Semantic Scholar',
        title: (paper.title || '').trim(),
        abstract: (paper.abstract || '').trim(),
        authors: ensureArray(paper.authors)
          .map((author) => author?.name)
          .filter(Boolean),
        year: paper.year || null,
        citationCount: paper.citationCount || 0,
        doi,
        journal: paper.publicationVenue?.name || '',
        url,
        pdfUrl,
        downloadCandidates: pdfUrl ? [pdfUrl] : [],
        relevanceScore: 980 - index * 3 + Math.min(paper.citationCount || 0, 800) / 8,
      };
    })
    .filter((paper) => paper.title && paper.abstract && paper.pdfUrl);
}

function extractArxivPdfUrl(links) {
  const list = ensureArray(links);

  const explicitPdf = list.find((link) => link.title === 'pdf');
  if (explicitPdf?.href) {
    return explicitPdf.href;
  }

  const byType = list.find((link) => (link.type || '').includes('pdf'));
  if (byType?.href) {
    return byType.href;
  }

  return '';
}

async function searchArxiv(query, maxResults = 25) {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodedQuery}&start=0&max_results=${maxResults}`;

  const xml = await fetchText(url);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    trimValues: true,
  });

  const parsed = parser.parse(xml);
  const entries = ensureArray(parsed?.feed?.entry);

  return entries
    .map((entry, index) => {
      const title = (entry.title || '').replace(/\s+/g, ' ').trim();
      const abstract = (entry.summary || '').replace(/\s+/g, ' ').trim();
      const authors = ensureArray(entry.author)
        .map((author) => author?.name)
        .filter(Boolean);
      const pdfUrl = extractArxivPdfUrl(entry.link);
      const id = entry.id || `arxiv-${index}`;
      const doi = normalizeDoi(entry['arxiv:doi'] || '');
      const year = entry.published ? Number(String(entry.published).slice(0, 4)) : null;

      return {
        id: `arxiv:${id}`,
        source: 'arXiv',
        title,
        abstract,
        authors,
        year,
        citationCount: 0,
        doi,
        journal: 'arXiv',
        url: entry.id || '',
        pdfUrl,
        downloadCandidates: pdfUrl ? [pdfUrl] : [],
        relevanceScore: 930 - index * 3,
      };
    })
    .filter((paper) => paper.title && paper.abstract && paper.pdfUrl);
}

function mergeAndDeduplicate(papers) {
  const seen = new Map();

  papers.forEach((paper) => {
    const key = paper.doi
      ? `doi:${paper.doi.toLowerCase()}`
      : `title:${paper.title.toLowerCase().replace(/\s+/g, ' ').trim()}`;

    if (!seen.has(key)) {
      seen.set(key, {
        ...paper,
        downloadCandidates: Array.from(new Set(ensureArray(paper.downloadCandidates))),
      });
      return;
    }

    const existing = seen.get(key);
    const better = (paper.citationCount || 0) > (existing.citationCount || 0) ? paper : existing;
    const mergedCandidates = Array.from(
      new Set([...ensureArray(existing.downloadCandidates), ...ensureArray(paper.downloadCandidates)]),
    );

    seen.set(key, {
      ...better,
      downloadCandidates: mergedCandidates,
      pdfUrl: better.pdfUrl || mergedCandidates[0] || '',
    });
  });

  return Array.from(seen.values());
}

function sortResults(results, sortBy) {
  const sorted = [...results];

  if (sortBy === 'year_desc') {
    sorted.sort((a, b) => (b.year || 0) - (a.year || 0));
    return sorted;
  }

  if (sortBy === 'year_asc') {
    sorted.sort((a, b) => (a.year || 0) - (b.year || 0));
    return sorted;
  }

  if (sortBy === 'citations_desc') {
    sorted.sort((a, b) => (b.citationCount || 0) - (a.citationCount || 0));
    return sorted;
  }

  if (sortBy === 'citations_asc') {
    sorted.sort((a, b) => (a.citationCount || 0) - (b.citationCount || 0));
    return sorted;
  }

  sorted.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
  return sorted;
}

async function mapWithConcurrency(items, worker, concurrency = 4) {
  if (!items.length) {
    return [];
  }

  const output = new Array(items.length);
  let currentIndex = 0;

  async function runWorker() {
    while (true) {
      const index = currentIndex;
      currentIndex += 1;

      if (index >= items.length) {
        break;
      }

      output[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker());
  await Promise.all(workers);

  return output;
}

async function enrichBilingual(results, linkConfig) {
  return mapWithConcurrency(
    results,
    async (paper) => {
      const [titleBilingual, abstractBilingual] = await Promise.all([
        toBilingualText(paper.title || ''),
        toBilingualAbstract(paper.abstract || ''),
      ]);
      const queryForLinks = paper.doi || paper.title;
      return {
        ...paper,
        titleZh: titleBilingual.zh,
        titleEn: titleBilingual.en,
        ...abstractBilingual,
        sourceLinks: buildSourceLinks(queryForLinks, linkConfig),
      };
    },
    4,
  );
}

async function searchLiterature({ query, sort = 'relevance', limit = 20, linkConfig = {} }) {
  const text = (query || '').trim();
  if (!text) {
    throw new Error('请输入检索内容');
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 20, 5), 50);

  const [openAlex, arxiv] = await Promise.allSettled([searchOpenAlex(text, 40), searchArxiv(text, 30)]);

  const warnings = [];
  const collected = [];

  if (openAlex.status === 'fulfilled') {
    collected.push(...openAlex.value);
  } else {
    warnings.push(`OpenAlex 检索失败：${openAlex.reason?.message || '未知错误'}`);
  }

  if (arxiv.status === 'fulfilled') {
    collected.push(...arxiv.value);
  } else {
    warnings.push(`arXiv 检索失败：${arxiv.reason?.message || '未知错误'}`);
  }

  const merged = mergeAndDeduplicate(collected);
  const sorted = sortResults(merged, sort);
  const guaranteed = await filterGuaranteedDownloadable(sorted, safeLimit);
  const enriched = await enrichBilingual(guaranteed, linkConfig);

  if (guaranteed.length < safeLimit) {
    warnings.push(
      `为保证“可下载”，已过滤掉不可直接下载项，当前仅返回 ${guaranteed.length} 条。`,
    );
  }

  return {
    query: text,
    total: enriched.length,
    warnings,
    results: enriched,
  };
}

module.exports = {
  searchLiterature,
};
