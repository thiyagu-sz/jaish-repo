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
const providerHealth = require('../lib/providerHealth');

const REQUEST_TIMEOUT_MS = 9000;
const RESULT_LIMIT = 20;

/**
 * A rate limit carries a code so callers can tell "slow down" apart from
 * "broken", and a cooldown so the next search skips this source entirely
 * rather than asking again and being refused again.
 */
class RateLimitedError extends Error {
  constructor(source, retryAfterMs) {
    super(`${providerHealth.displayName(source)} rate limited the request`);
    this.name = 'RateLimitedError';
    this.code = 'PROVIDER_RATE_LIMITED';
    this.source = source;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Shared handling so a 429 is treated identically by every source here. */
function handleResponse(response, source) {
  if (response.status === 429) {
    const retryAfterMs = providerHealth.parseRetryAfter(response.headers?.get?.('retry-after'));
    const cooldown = providerHealth.markRateLimited(source, retryAfterMs);
    providerHealth.logRateLimited(source, cooldown);
    throw new RateLimitedError(source, retryAfterMs);
  }

  if (!response.ok) throw new Error(`Request failed with status ${response.status}`);

  if (providerHealth.isCoolingDown(source)) providerHealth.logRecovered(source);
  providerHealth.markHealthy(source);
}

/** Small fetch wrapper with a timeout so a slow API can never hang the server. */
async function fetchJson(url, headers = {}, source = null) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  handleResponse(response, source);
  return response.json();
}

async function fetchText(url, source = null) {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  handleResponse(response, source);
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

  const data = await fetchJson(`https://api.openalex.org/works?${params.toString()}`, {}, 'openalex');

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
    headers,
    'semanticscholar'
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
  const xml = await fetchText(`https://export.arxiv.org/api/query?${params.toString()}`, 'arxiv');

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
 *
 * A source that is currently rate limited is skipped rather than asked again.
 * If the one source the caller picked is rate limited, the others are used
 * instead: real results from another index beat sample data.
 *
 * Demo data remains the last resort, only when no source can answer at all.
 */
async function searchPapers(query, { source = 'all', year = '', sort = 'relevance' } = {}) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return { papers: [], demoMode: false, source };

  const requested = PROVIDERS[source] ? [source] : Object.keys(PROVIDERS);
  const notes = [];

  let selected = requested.filter((name) => {
    if (!providerHealth.isCoolingDown(name)) return true;
    providerHealth.logSkipped(name);
    notes.push(`${providerHealth.displayName(name)} is rate limited`);
    return false;
  });

  // The caller asked for one source and it is cooling down: use the rest.
  let fallbackUsed = false;
  if (!selected.length) {
    selected = Object.keys(PROVIDERS).filter((name) => !providerHealth.isCoolingDown(name));
    fallbackUsed = selected.length > 0;
    if (fallbackUsed) providerHealth.logFallback(selected[0]);
  }

  const settled = selected.length
    ? await Promise.allSettled(selected.map((name) => PROVIDERS[name](trimmed, { year })))
    : [];

  settled.forEach((result, index) => {
    if (result.status !== 'rejected') return;

    const name = selected[index];
    if (result.reason?.code === 'PROVIDER_RATE_LIMITED') {
      // providerHealth already logged the rate limit and the cooldown.
      notes.push(`${providerHealth.displayName(name)} is rate limited`);
    } else {
      console.warn(`[research] ${name} failed:`, result.reason?.message || result.reason);
      notes.push(`${providerHealth.displayName(name)} unavailable`);
    }
  });

  const papers = settled
    .filter((result) => result.status === 'fulfilled')
    .flatMap((result) => result.value);

  const anySucceeded = settled.some((result) => result.status === 'fulfilled');

  if (!anySucceeded) {
    // Every source is unavailable or cooling down. Only now is sample data the
    // best available answer, and it is labelled as such.
    const rateLimited = selected.length === 0 ||
      settled.every((result) => result.reason?.code === 'PROVIDER_RATE_LIMITED');

    return {
      papers: applyFilters(getDemoPapers(trimmed), { year: '', sort }),
      demoMode: true,
      source,
      rateLimited,
      providerNotes: notes
    };
  }

  return {
    papers: applyFilters(dedupeByTitle(papers), { year, sort }),
    demoMode: false,
    source,
    fallbackUsed: fallbackUsed || undefined,
    providerNotes: notes
  };
}

module.exports = { searchPapers };
