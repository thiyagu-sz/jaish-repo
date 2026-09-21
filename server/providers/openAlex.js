/**
 * OpenAlex provider.
 *
 * Endpoints used (verified against the live API):
 *   GET /authors?search=&per_page=&page=   -> {meta:{count,page,per_page}, results[]}
 *   GET /authors/{id}                      -> author object
 *   GET /works?filter=author.id:{id},...   -> {meta, results[]}
 *
 * No key is required. OpenAlex asks for a contact email (`mailto`) to join the
 * faster "polite pool"; OPENALEX_API_KEY is supported for premium accounts.
 *
 * OpenAlex is the secondary source. Its value here is the `topics` taxonomy
 * (topic / field / domain) and institution data on authorships - real provider
 * metadata that grounds the knowledge graph without a language model. Note that
 * many OpenAlex works no longer carry `abstract_inverted_index`, which is why
 * Semantic Scholar remains the primary source for abstracts.
 */
const { getJson } = require('../lib/httpClient');
const { ApiError } = require('../lib/httpErrors');
const { SOURCES, Researcher, Paper } = require('../models/schemas');

const BASE_URL = 'https://api.openalex.org';
const SOURCE = SOURCES.OPENALEX;
const MAX_PER_PAGE = 100;

function baseParams() {
  const params = {};
  if (process.env.CONTACT_EMAIL) params.mailto = process.env.CONTACT_EMAIL;
  if (process.env.OPENALEX_API_KEY) params.api_key = process.env.OPENALEX_API_KEY;
  return params;
}

function request(path, params = {}) {
  const url = `${BASE_URL}${path}?${new URLSearchParams({ ...baseParams(), ...params }).toString()}`;
  return getJson(url, { notFoundCode: 'RESEARCHER_NOT_FOUND', source: SOURCE });
}

/** OpenAlex ids are full URLs; we store only the short key (e.g. A5086198262). */
function shortId(value) {
  return String(value || '').split('/').pop();
}

/** OpenAlex stores abstracts as an inverted index; rebuild the plain text. */
function rebuildAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue;
    positions.forEach((position) => {
      words[position] = word;
    });
  }
  return words.join(' ').trim();
}

/** ------------------------------------------------------------ normalizing */
function toResearcher(author) {
  // `affiliations` is the historical list; `last_known_institutions` is current.
  const institutions = [
    ...(author.last_known_institutions || []).map((i) => i?.display_name),
    ...(author.affiliations || []).map((a) => a?.institution?.display_name)
  ].filter(Boolean);

  return Researcher({
    source: SOURCE,
    sourceId: shortId(author.id),
    name: author.display_name,
    affiliations: [...new Set(institutions)],
    homepage: null,
    paperCount: author.works_count,
    citationCount: author.cited_by_count,
    hIndex: author.summary_stats?.h_index,
    externalIds: { ORCID: author.orcid || null, OpenAlex: author.id || null },
    url: author.id
  });
}

function toPaper(work) {
  const authorships = work.authorships || [];
  const institutions = authorships.flatMap((a) => (a.institutions || []).map((i) => i.display_name));

  return Paper({
    source: SOURCE,
    sourceId: shortId(work.id),
    title: work.display_name || work.title,
    abstract: rebuildAbstract(work.abstract_inverted_index),
    year: work.publication_year,
    publicationDate: work.publication_date,
    authors: authorships.map((a) => a.author?.display_name),
    venue: work.primary_location?.source?.display_name,
    url: work.doi || work.primary_location?.landing_page_url || work.id,
    doi: work.doi || null,
    citationCount: work.cited_by_count,
    referenceCount: work.referenced_works_count,
    openAccessUrl: work.best_oa_location?.pdf_url || null,
    topics: (work.topics || []).map((t) => t.display_name),
    // OpenAlex nests a topic inside a field inside a domain; both levels are
    // useful, so keep the coarse ones as "fields".
    fields: [
      ...new Set((work.topics || []).flatMap((t) => [t.field?.display_name, t.domain?.display_name]))
    ].filter(Boolean),
    institutions: [...new Set(institutions)]
  });
}

/** ------------------------------------------------------------ public API */

async function searchResearchers(query, { limit = 10, offset = 0 } = {}) {
  const perPage = Math.min(limit, MAX_PER_PAGE);
  // OpenAlex paginates by page number, not offset.
  const page = Math.floor(offset / perPage) + 1;

  const data = await request('/authors', { search: query, per_page: String(perPage), page: String(page) });

  if (!data || !Array.isArray(data.results)) {
    throw new ApiError('PROVIDER_MALFORMED_RESPONSE', '/authors returned no results array');
  }

  const total = data.meta?.count ?? data.results.length;
  const consumed = offset + data.results.length;

  return {
    researchers: data.results.map(toResearcher),
    total,
    offset,
    next_offset: consumed < total ? consumed : null
  };
}

async function getResearcher(sourceId) {
  const author = await request(`/authors/${encodeURIComponent(sourceId)}`);
  if (!author || !author.id) {
    throw new ApiError('PROVIDER_MALFORMED_RESPONSE', 'author detail missing id');
  }
  return toResearcher(author);
}

async function getResearcherPapers(sourceId, { limit = 25, offset = 0, yearFrom, yearTo } = {}) {
  const perPage = Math.min(limit, MAX_PER_PAGE);
  const page = Math.floor(offset / perPage) + 1;

  const filters = [`author.id:${sourceId}`];
  if (yearFrom) filters.push(`from_publication_date:${yearFrom}-01-01`);
  if (yearTo) filters.push(`to_publication_date:${yearTo}-12-31`);

  const data = await request('/works', {
    filter: filters.join(','),
    per_page: String(perPage),
    page: String(page),
    sort: 'cited_by_count:desc'
  });

  if (!data || !Array.isArray(data.results)) {
    throw new ApiError('PROVIDER_MALFORMED_RESPONSE', '/works returned no results array');
  }

  const total = data.meta?.count ?? data.results.length;
  const consumed = offset + data.results.length;

  return {
    papers: data.results.map(toPaper),
    total,
    offset,
    next_offset: consumed < total ? consumed : null
  };
}

async function getPaper(sourceId) {
  const work = await request(`/works/${encodeURIComponent(sourceId)}`);
  if (!work || !work.id) throw new ApiError('PAPER_NOT_FOUND', 'work detail missing id');
  return toPaper(work);
}

async function searchPapers(query, { limit = 20 } = {}) {
  const data = await request('/works', { search: query, per_page: String(Math.min(limit, MAX_PER_PAGE)) });
  if (!data || !Array.isArray(data.results)) {
    throw new ApiError('PROVIDER_MALFORMED_RESPONSE', '/works search returned no results array');
  }
  return { papers: data.results.map(toPaper), total: data.meta?.count ?? data.results.length };
}

/**
 * Batch DOI lookup, used to enrich papers retrieved from another source.
 * OpenAlex accepts pipe-separated values as an OR filter, so one request
 * covers the whole batch. Returns the raw payload: the caller merges selected
 * fields into papers it already holds rather than replacing them.
 */
async function getWorksByDois(dois) {
  const list = (dois || []).filter(Boolean).slice(0, 50);
  if (!list.length) return { results: [] };

  return request('/works', {
    filter: `doi:${list.join('|')}`,
    per_page: String(list.length)
  });
}

module.exports = {
  source: SOURCE,
  name: 'OpenAlex',
  getWorksByDois,
  searchResearchers,
  getResearcher,
  getResearcherPapers,
  getPaper,
  searchPapers,
  rebuildAbstract
};
