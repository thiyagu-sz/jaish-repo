/**
 * Internal normalized models.
 *
 * Provider adapters convert their own responses into these shapes; everything
 * downstream (agents, graph, routes, frontend) works only with these. Adding a
 * provider therefore never changes the rest of the application.
 *
 * Researcher ids are namespaced as "<source>:<sourceId>" (e.g. "s2:1751762",
 * "openalex:A5086198262") so an id is self-describing and round-trips through a
 * URL without a lookup table.
 */

const SOURCES = { SEMANTIC_SCHOLAR: 'semantic_scholar', OPENALEX: 'openalex' };

/** Short prefix used inside composite ids. */
const SOURCE_PREFIX = { [SOURCES.SEMANTIC_SCHOLAR]: 's2', [SOURCES.OPENALEX]: 'openalex' };
const PREFIX_SOURCE = Object.fromEntries(Object.entries(SOURCE_PREFIX).map(([k, v]) => [v, k]));

function makeId(source, sourceId) {
  return `${SOURCE_PREFIX[source] || source}:${sourceId}`;
}

/** Parses "s2:1751762" -> { source, sourceId }. Returns null when unparseable. */
function parseId(compositeId) {
  const raw = String(compositeId || '');
  const separator = raw.indexOf(':');
  if (separator < 1) return null;

  const prefix = raw.slice(0, separator);
  const sourceId = raw.slice(separator + 1);
  const source = PREFIX_SOURCE[prefix];

  if (!source || !sourceId) return null;
  // Guard against anything that could be used to reshape a provider URL.
  if (!/^[A-Za-z0-9._-]+$/.test(sourceId)) return null;

  return { source, sourceId };
}

function text(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function toNumberOrNull(value) {
  // Number(null) and Number('') are both 0, which would silently turn "the
  // provider did not supply this" into a real-looking zero.
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @typedef {object} Researcher
 * Fields are null (not absent, not invented) when a provider does not supply them.
 */
function Researcher({
  source,
  sourceId,
  name,
  affiliations = [],
  homepage = null,
  paperCount = null,
  citationCount = null,
  hIndex = null,
  externalIds = {},
  url = null
}) {
  return {
    id: makeId(source, sourceId),
    name: text(name) || 'Unknown researcher',
    affiliations: affiliations.map(text).filter(Boolean),
    homepage: homepage || null,
    paper_count: toNumberOrNull(paperCount),
    citation_count: toNumberOrNull(citationCount),
    h_index: toNumberOrNull(hIndex),
    source,
    source_id: String(sourceId),
    external_ids: externalIds || {},
    url: url || null
  };
}

/**
 * @typedef {object} Paper
 */
function Paper({
  source,
  sourceId,
  title,
  abstract = '',
  year = null,
  publicationDate = null,
  authors = [],
  venue = null,
  url = null,
  doi = null,
  citationCount = null,
  referenceCount = null,
  openAccessUrl = null,
  topics = [],
  fields = [],
  institutions = []
}) {
  return {
    id: makeId(source, sourceId),
    title: text(title) || 'Untitled',
    abstract: text(abstract),
    year: toNumberOrNull(year),
    publication_date: publicationDate || null,
    authors: authors.map(text).filter(Boolean),
    venue: text(venue) || null,
    url: url || null,
    doi: doi || null,
    citation_count: toNumberOrNull(citationCount),
    reference_count: toNumberOrNull(referenceCount),
    open_access_url: openAccessUrl || null,
    // Provider-supplied taxonomy (OpenAlex topics/fields/domains). This is real
    // metadata, not model output, and is kept separate from LLM-derived terms.
    topics: topics.map(text).filter(Boolean),
    fields: fields.map(text).filter(Boolean),
    institutions: institutions.map(text).filter(Boolean),
    source,
    source_id: String(sourceId)
  };
}

/**
 * A single evidence item. Every generated claim must carry at least one.
 */
function Evidence({ paperId, title, source, excerpt, year = null, url = null }) {
  return {
    paper_id: paperId,
    title: text(title),
    source,
    excerpt: text(excerpt).slice(0, 600),
    year: toNumberOrNull(year),
    url: url || null
  };
}

const INSUFFICIENT_EVIDENCE = 'Insufficient evidence.';

module.exports = {
  SOURCES,
  SOURCE_PREFIX,
  makeId,
  parseId,
  text,
  Researcher,
  Paper,
  Evidence,
  INSUFFICIENT_EVIDENCE
};
