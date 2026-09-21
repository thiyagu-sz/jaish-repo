/**
 * Semantic Scholar Academic Graph provider.
 *
 * Endpoints used (verified against the live API):
 *   GET /graph/v1/author/search?query=&limit=&offset=&fields=  -> {total, offset, next, data[]}
 *   GET /graph/v1/author/{authorId}?fields=                    -> author object, 404 when unknown
 *   GET /graph/v1/author/{authorId}/papers?limit=&offset=&fields= -> {offset, next, data[]}
 *   GET /graph/v1/paper/{paperId}?fields=                      -> paper object
 *
 * The key is optional (it raises the rate limit) and is sent as `x-api-key`.
 * The author/papers endpoint returns no `total`, only a `next` offset.
 */
const { getJson } = require('../lib/httpClient');
const { ApiError } = require('../lib/httpErrors');
const { SOURCES, Researcher, Paper } = require('../models/schemas');

const BASE_URL = 'https://api.semanticscholar.org/graph/v1';
const SOURCE = SOURCES.SEMANTIC_SCHOLAR;

const AUTHOR_FIELDS = 'authorId,name,affiliations,homepage,paperCount,citationCount,hIndex,externalIds,url';
const PAPER_FIELDS = [
  'paperId', 'title', 'abstract', 'year', 'publicationDate', 'venue', 'url',
  'externalIds', 'citationCount', 'referenceCount', 'openAccessPdf', 'authors', 'fieldsOfStudy'
].join(',');

// The author/papers endpoint caps limit at 1000, author/search at 1000.
const MAX_LIMIT = 100;

function headers() {
  const key = process.env.SEMANTIC_SCHOLAR_API_KEY;
  return key ? { 'x-api-key': key } : {};
}

function request(path, params, notFoundCode) {
  const url = `${BASE_URL}${path}?${new URLSearchParams(params).toString()}`;
  // `source` lets the HTTP layer record a cooldown for this provider when it
  // rate limits us, so other callers skip it instead of earning another 429.
  return getJson(url, { headers: headers(), notFoundCode, source: SOURCE });
}

/** ------------------------------------------------------------ normalizing */
function toResearcher(author) {
  return Researcher({
    source: SOURCE,
    sourceId: author.authorId,
    name: author.name,
    affiliations: author.affiliations || [],
    homepage: author.homepage,
    paperCount: author.paperCount,
    citationCount: author.citationCount,
    hIndex: author.hIndex,
    externalIds: author.externalIds || {},
    url: author.url || `https://www.semanticscholar.org/author/${author.authorId}`
  });
}

function toPaper(paper) {
  const openAccessUrl = paper.openAccessPdf?.url || null;
  return Paper({
    source: SOURCE,
    sourceId: paper.paperId,
    title: paper.title,
    abstract: paper.abstract || '',
    year: paper.year,
    publicationDate: paper.publicationDate,
    authors: (paper.authors || []).map((a) => a.name),
    venue: paper.venue,
    url: paper.url || `https://www.semanticscholar.org/paper/${paper.paperId}`,
    doi: paper.externalIds?.DOI ? `https://doi.org/${paper.externalIds.DOI}` : null,
    citationCount: paper.citationCount,
    referenceCount: paper.referenceCount,
    // status CLOSED still returns an empty url string, so guard on truthiness.
    openAccessUrl: openAccessUrl || null,
    fields: paper.fieldsOfStudy || []
  });
}

/** ------------------------------------------------------------ public API */

async function searchResearchers(query, { limit = 10, offset = 0 } = {}) {
  const data = await request('/author/search', {
    query,
    limit: String(Math.min(limit, MAX_LIMIT)),
    offset: String(offset),
    fields: AUTHOR_FIELDS
  });

  if (!data || !Array.isArray(data.data)) {
    throw new ApiError('PROVIDER_MALFORMED_RESPONSE', 'author/search returned no data array');
  }

  return {
    researchers: data.data.map(toResearcher),
    total: typeof data.total === 'number' ? data.total : data.data.length,
    offset: data.offset ?? offset,
    next_offset: typeof data.next === 'number' ? data.next : null
  };
}

async function getResearcher(sourceId) {
  const author = await request(`/author/${encodeURIComponent(sourceId)}`, { fields: AUTHOR_FIELDS }, 'RESEARCHER_NOT_FOUND');

  if (!author || !author.authorId) {
    throw new ApiError('PROVIDER_MALFORMED_RESPONSE', 'author detail missing authorId');
  }
  return toResearcher(author);
}

async function getResearcherPapers(sourceId, { limit = 25, offset = 0 } = {}) {
  const data = await request(
    `/author/${encodeURIComponent(sourceId)}/papers`,
    { limit: String(Math.min(limit, MAX_LIMIT)), offset: String(offset), fields: PAPER_FIELDS },
    'RESEARCHER_NOT_FOUND'
  );

  if (!data || !Array.isArray(data.data)) {
    throw new ApiError('PROVIDER_MALFORMED_RESPONSE', 'author/papers returned no data array');
  }

  return {
    papers: data.data.filter((p) => p && p.paperId).map(toPaper),
    // This endpoint reports no total; `next` is the offset of the next page.
    total: null,
    offset: data.offset ?? offset,
    next_offset: typeof data.next === 'number' ? data.next : null
  };
}

async function getPaper(sourceId) {
  const paper = await request(`/paper/${encodeURIComponent(sourceId)}`, { fields: PAPER_FIELDS }, 'PAPER_NOT_FOUND');
  if (!paper || !paper.paperId) {
    throw new ApiError('PROVIDER_MALFORMED_RESPONSE', 'paper detail missing paperId');
  }
  return toPaper(paper);
}

async function searchPapers(query, { limit = 20 } = {}) {
  const data = await request('/paper/search', {
    query,
    limit: String(Math.min(limit, MAX_LIMIT)),
    fields: PAPER_FIELDS
  });
  if (!data || !Array.isArray(data.data)) {
    throw new ApiError('PROVIDER_MALFORMED_RESPONSE', 'paper/search returned no data array');
  }
  return { papers: data.data.map(toPaper), total: data.total ?? data.data.length };
}

module.exports = {
  source: SOURCE,
  name: 'Semantic Scholar',
  searchResearchers,
  getResearcher,
  getResearcherPapers,
  getPaper,
  searchPapers
};
