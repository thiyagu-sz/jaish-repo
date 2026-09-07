/**
 * Research paper retrieval.
 *
 * Every provider returns the same normalized shape so the frontend never sees
 * API-specific structures:
 *   { id, title, authors, year, abstract, source, url }
 *
 * Adding a new source = write a fetch function and register it in PROVIDERS.
 */
const { getDemoPapers } = require('./demoData');

const REQUEST_TIMEOUT_MS = 9000;
const RESULT_LIMIT = 20;

/** Small fetch wrapper with a timeout so a slow API can never hang the server. */
async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
  return response.text();
}

/** OpenAlex stores abstracts as an inverted index; rebuild the plain text. */
function rebuildAbstract(invertedIndex) {
  if (!invertedIndex) return '';
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    positions.forEach((position) => {
      words[position] = word;
    });
  }
  return words.join(' ').trim();
}

function clean(text = '') {
  return String(text).replace(/\s+/g, ' ').trim();
}

/** ---------------------------------------------------------------- OpenAlex */
async function searchOpenAlex(query, { year } = {}) {
  const params = new URLSearchParams({
    search: query,
    per_page: String(RESULT_LIMIT)
  });
  if (year) params.set('filter', `publication_year:${year}`);
  // OpenAlex asks for a contact email to join their faster "polite pool".
  if (process.env.CONTACT_EMAIL) params.set('mailto', process.env.CONTACT_EMAIL);

  const data = await fetchJson(`https://api.openalex.org/works?${params.toString()}`);

  return (data.results || []).map((work) => ({
    id: work.id,
    title: clean(work.display_name) || 'Untitled',
    authors: (work.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
    year: work.publication_year || null,
    abstract: clean(rebuildAbstract(work.abstract_inverted_index)),
    source: 'OpenAlex',
    url: work.doi || work.primary_location?.landing_page_url || work.id
  }));
}

/** ------------------------------------------------------- Semantic Scholar */
async function searchSemanticScholar(query, { year } = {}) {
  const params = new URLSearchParams({
    query,
    limit: String(RESULT_LIMIT),
    fields: 'title,abstract,year,authors,externalIds,url'
  });
  if (year) params.set('year', String(year));

  // The API works without a key (lower rate limit); the key is used when present.
  const headers = process.env.SEMANTIC_SCHOLAR_API_KEY
    ? { 'x-api-key': process.env.SEMANTIC_SCHOLAR_API_KEY }
    : {};

  const data = await fetchJson(
    `https://api.semanticscholar.org/graph/v1/paper/search?${params.toString()}`,
    headers
  );

  return (data.data || []).map((paper) => ({
    id: paper.paperId,
    title: clean(paper.title) || 'Untitled',
    authors: (paper.authors || []).map((a) => a.name).filter(Boolean),
    year: paper.year || null,
    abstract: clean(paper.abstract),
    source: 'Semantic Scholar',
    url: paper.url || `https://www.semanticscholar.org/paper/${paper.paperId}`
  }));
}

/** -------------------------------------------------------------------- arXiv */
function pickTag(xml, tag) {
  // [^] matches any character including newlines - arXiv wraps long titles
  // and summaries across several lines.
  const match = xml.match(new RegExp(`<${tag}[^>]*>([^]*?)</${tag}>`));
  return match ? clean(match[1]) : '';
}

async function searchArxiv(query) {
  const params = new URLSearchParams({
    search_query: `all:${query}`,
    start: '0',
    max_results: String(RESULT_LIMIT)
  });
  const xml = await fetchText(`https://export.arxiv.org/api/query?${params.toString()}`);

  // The arXiv API returns Atom XML. The feed is simple and regular enough that a
  // small extractor is preferable to pulling in an XML dependency.
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];

  return entries.map((entry) => {
    const published = pickTag(entry, 'published');
    const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => clean(m[1]));
    const link = pickTag(entry, 'id');
    return {
      id: link,
      title: pickTag(entry, 'title') || 'Untitled',
      authors,
      year: published ? Number(published.slice(0, 4)) : null,
      abstract: pickTag(entry, 'summary'),
      source: 'arXiv',
      url: link
    };
  });
}

const PROVIDERS = {
  openalex: searchOpenAlex,
  semanticscholar: searchSemanticScholar,
  arxiv: searchArxiv
};

/** Same paper can appear in several sources - keep the first occurrence. */
function dedupeByTitle(papers) {
  const seen = new Set();
  return papers.filter((paper) => {
    const key = paper.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applyFilters(papers, { year, sort }) {
  let results = papers.filter((paper) => paper.title);
  if (year) results = results.filter((paper) => String(paper.year) === String(year));

  if (sort === 'newest') {
    results = results.sort((a, b) => (b.year || 0) - (a.year || 0));
  } else {
    // Many records come back without an abstract, which makes the AI actions
    // useless. Keep provider relevance order, but show usable papers first.
    results = results.sort((a, b) => Number(Boolean(b.abstract)) - Number(Boolean(a.abstract)));
  }

  return results.slice(0, RESULT_LIMIT);
}

/**
 * Searches papers across one or all sources.
 * Falls back to demo data when every provider fails (offline, rate limited, etc).
 */
async function searchPapers(query, { source = 'all', year = '', sort = 'relevance' } = {}) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return { papers: [], demoMode: false, source };

  const selected = PROVIDERS[source] ? [source] : Object.keys(PROVIDERS);

  const settled = await Promise.allSettled(
    selected.map((name) => PROVIDERS[name](trimmed, { year }))
  );

  const papers = settled
    .filter((result) => result.status === 'fulfilled')
    .flatMap((result) => result.value);

  const failedAll = settled.every((result) => result.status === 'rejected');

  if (failedAll) {
    settled.forEach((result, index) => {
      console.warn(`[research] ${selected[index]} failed:`, result.reason?.message || result.reason);
    });
    return {
      papers: applyFilters(getDemoPapers(trimmed), { year: '', sort }),
      demoMode: true,
      source
    };
  }

  return { papers: applyFilters(dedupeByTitle(papers), { year, sort }), demoMode: false, source };
}

module.exports = { searchPapers };
