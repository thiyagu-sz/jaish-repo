/**
 * Research Retrieval Agent.
 *
 * The only module that talks to providers. It resolves a namespaced researcher
 * id to the right adapter, caches per-researcher results for the session, and
 * performs the one piece of cross-source work this MVP needs: enriching
 * Semantic Scholar papers with the OpenAlex topic taxonomy.
 *
 * Why enrich: Semantic Scholar has the abstracts, OpenAlex has a real
 * topic/field/domain classification. Combining them gives the knowledge graph
 * grounded subject nodes without asking a language model to invent any.
 */
const { getProvider, DEFAULT_SOURCE, SOURCES } = require('../providers');
const { parseId } = require('../models/schemas');
const { ApiError } = require('../lib/httpErrors');
const providerHealth = require('../lib/providerHealth');
const cache = require('../services/cache');
const openAlex = require('../providers/openAlex');

/** Resolves "s2:123" to { source, sourceId, provider }. */
function resolveResearcherId(compositeId) {
  const parsed = parseId(compositeId);
  if (!parsed) {
    throw new ApiError('INVALID_RESEARCHER_ID', `could not parse "${compositeId}"`);
  }
  return { ...parsed, provider: getProvider(parsed.source) };
}

/**
 * Searches researchers. Semantic Scholar is primary; OpenAlex is used as a
 * fallback so a rate limit on one source does not end the demo. A fallback is
 * always reported in `provider_notes` rather than being silent.
 */
async function searchResearchers(query, { limit = 10, offset = 0, source } = {}) {
  const notes = [];
  // An explicit `source` is honoured, but a rate-limited one still falls back:
  // returning an error when a working source exists helps nobody.
  const order = source
    ? [source, ...[DEFAULT_SOURCE, SOURCES.OPENALEX].filter((s) => s !== source)]
    : [DEFAULT_SOURCE, SOURCES.OPENALEX];

  let lastError = null;

  for (const candidate of order) {
    const isFallback = candidate !== order[0];
    const isLast = candidate === order[order.length - 1];

    // Skip a provider that already told us to back off, rather than spending a
    // request to be told again.
    if (providerHealth.isCoolingDown(candidate) && !isLast) {
      providerHealth.logSkipped(candidate);
      notes.push(`${providerHealth.displayName(candidate)} is rate limited; using another source`);
      continue;
    }

    if (isFallback) providerHealth.logFallback(candidate);

    const cacheKey = `researchers:search:${candidate}:${query}:${limit}:${offset}`;
    try {
      const result = await cache.wrap(cacheKey, () =>
        getProvider(candidate).searchResearchers(query, { limit, offset })
      );

      // An empty result from the primary is a real answer, but it is worth
      // trying the secondary before telling the user nobody matched.
      if (!result.researchers.length && !isLast) {
        notes.push(`${providerHealth.displayName(candidate)} returned no matches; trying the next source`);
        continue;
      }

      return {
        ...result,
        source: candidate,
        fallback_used: isFallback || undefined,
        provider_notes: notes
      };
    } catch (error) {
      lastError = error;

      if (error.code === 'PROVIDER_RATE_LIMITED') {
        notes.push(`${providerHealth.displayName(candidate)} is rate limited`);
      } else {
        notes.push(`${providerHealth.displayName(candidate)} unavailable (${error.code || 'error'})`);
      }
      console.warn(`[retrieval] ${candidate} search failed:`, error.detail || error.message);
    }
  }

  throw lastError || new ApiError('RESEARCH_PROVIDER_UNAVAILABLE', 'no provider returned a result');
}

async function getResearcher(compositeId) {
  const { sourceId, provider } = resolveResearcherId(compositeId);
  return cache.wrap(`researcher:${compositeId}`, () => provider.getResearcher(sourceId));
}

/**
 * Normalizes a personal name for comparison across providers: case, accents,
 * punctuation and spacing all differ between Semantic Scholar and OpenAlex.
 */
function normalizeName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function orcidOf(researcher) {
  const raw = researcher?.external_ids?.ORCID;
  if (!raw) return null;
  // Providers give either the bare identifier or the orcid.org URL.
  const match = String(raw).match(/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Finds the same person on another provider, so paper retrieval can fail over
 * when the primary is rate limited.
 *
 * Identity is only accepted on evidence: a matching ORCID, or an exact match of
 * the normalized name. A "close enough" match is refused, because returning one
 * researcher's publications under another's name is a worse failure than the
 * rate limit we are working around.
 *
 * @returns {Promise<{provider: object, researcher: object, matchedBy: string}|null>}
 */
async function resolveOnFallbackProvider(compositeId, failedSource) {
  const fallbackSource = failedSource === SOURCES.SEMANTIC_SCHOLAR
    ? SOURCES.OPENALEX
    : SOURCES.SEMANTIC_SCHOLAR;

  if (providerHealth.isCoolingDown(fallbackSource)) {
    providerHealth.logSkipped(fallbackSource);
    return null;
  }

  // Identity comes from the cached profile: the search and the profile screen
  // both populate it before papers are ever requested. Asking the rate-limited
  // provider who this is would just earn another 429, so if we have never seen
  // this researcher we decline to fall back rather than guessing.
  let known = cache.get(`researcher:${compositeId}`);

  if (!known) {
    if (providerHealth.isCoolingDown(failedSource)) {
      console.warn(
        `[retrieval] ${compositeId} is not cached and ${failedSource} is rate limited; cannot identify for fallback`
      );
      return null;
    }
    try {
      known = await getResearcher(compositeId);
    } catch (error) {
      console.warn(
        `[retrieval] cannot identify ${compositeId} for fallback:`,
        error.detail || error.message
      );
      return null;
    }
  }

  const fallbackProvider = getProvider(fallbackSource);
  const targetOrcid = orcidOf(known);
  const targetName = normalizeName(known.name);

  let candidates;
  try {
    const found = await cache.wrap(`researchers:search:${fallbackSource}:${targetName}:10:0`, () =>
      fallbackProvider.searchResearchers(known.name, { limit: 10, offset: 0 })
    );
    candidates = found.researchers;
  } catch (error) {
    console.warn(
      `[retrieval] ${fallbackSource} could not be searched for a fallback match:`,
      error.detail || error.message
    );
    return null;
  }

  // An ORCID is an identifier, so it wins over any name similarity.
  if (targetOrcid) {
    const byOrcid = candidates.find((candidate) => orcidOf(candidate) === targetOrcid);
    if (byOrcid) return { provider: fallbackProvider, researcher: byOrcid, matchedBy: 'orcid' };
  }

  const byName = candidates.filter((candidate) => normalizeName(candidate.name) === targetName);

  // Several people share a name; picking one of them would be a guess.
  if (byName.length === 1) {
    return { provider: fallbackProvider, researcher: byName[0], matchedBy: 'exact_name' };
  }

  console.warn(
    `[retrieval] no confident ${fallbackSource} match for "${known.name}" ` +
      `(${byName.length} exact-name candidates); not falling back`
  );
  return null;
}

/**
 * Retrieves a page of the researcher papers.
 *
 * Semantic Scholar has no year filter on the author/papers endpoint, so the
 * year range is applied after normalization. OpenAlex filters server-side.
 *
 * If the owning provider is rate limited, the same person is looked up on the
 * other provider and their publications are served from there instead. The
 * response says so in `fallback`, because papers retrieved that way come from a
 * different index and should not be presented as though nothing had changed.
 */
async function getResearcherPapers(compositeId, { limit = 25, offset = 0, yearFrom, yearTo } = {}) {
  const { source, sourceId, provider } = resolveResearcherId(compositeId);

  // Over-fetch when filtering client-side, otherwise a year filter could empty
  // an otherwise full page.
  const needsClientFilter = source === SOURCES.SEMANTIC_SCHOLAR && (yearFrom || yearTo);
  const fetchLimit = needsClientFilter ? Math.min(limit * 4, 100) : limit;

  const fetchPage = (activeProvider, activeId) =>
    cache.wrap(
      `papers:${activeProvider.source}:${activeId}:${fetchLimit}:${offset}:${yearFrom || ''}:${yearTo || ''}`,
      () => activeProvider.getResearcherPapers(activeId, { limit: fetchLimit, offset, yearFrom, yearTo })
    );

  let result;
  let servedBy = source;
  let fallback = null;

  const cooling = providerHealth.isCoolingDown(source);

  try {
    if (cooling) {
      providerHealth.logSkipped(source);
      throw new ApiError('PROVIDER_RATE_LIMITED', `${source} is cooling down`);
    }
    result = await fetchPage(provider, sourceId);
  } catch (error) {
    // Only a rate limit is worth failing over. A 404 means this researcher does
    // not exist, and pretending otherwise by searching another provider for a
    // similar name would be worse than the error.
    if (error.code !== 'PROVIDER_RATE_LIMITED') throw error;

    const alternative = await resolveOnFallbackProvider(compositeId, source);
    if (!alternative) throw error;

    providerHealth.logFallback(alternative.provider.source);
    result = await fetchPage(alternative.provider, alternative.researcher.source_id);

    servedBy = alternative.provider.source;
    fallback = {
      from: source,
      to: alternative.provider.source,
      reason: 'rate_limited',
      matched_by: alternative.matchedBy,
      matched_researcher: {
        id: alternative.researcher.id,
        name: alternative.researcher.name
      }
    };
  }

  let papers = result.papers;

  // The client-side year filter is only needed for Semantic Scholar; if we fell
  // back to OpenAlex the filter was already applied by the provider.
  const filteredClientSide = needsClientFilter && servedBy === SOURCES.SEMANTIC_SCHOLAR;

  if (filteredClientSide) {
    papers = papers.filter((paper) => {
      if (paper.year == null) return false;
      if (yearFrom && paper.year < yearFrom) return false;
      if (yearTo && paper.year > yearTo) return false;
      return true;
    });
  }

  return {
    papers: papers.slice(0, limit),
    total: result.total,
    offset: result.offset,
    next_offset: result.next_offset,
    year_filter_applied: filteredClientSide ? 'client' : (yearFrom || yearTo ? 'provider' : 'none'),
    served_by: servedBy,
    fallback
  };
}

/**
 * Adds OpenAlex topic/field/institution metadata to papers that lack it.
 *
 * Matched on DOI, which is the only identifier both sources share reliably.
 * Papers without a DOI, or with no OpenAlex record, are returned untouched -
 * partial enrichment is expected and is not an error.
 */
async function enrichWithOpenAlex(papers, { maxLookups = 25 } = {}) {
  const candidates = papers.filter((paper) => paper.doi && !paper.topics.length).slice(0, maxLookups);
  if (!candidates.length) return { papers, enriched: 0, attempted: 0 };

  // OpenAlex accepts an OR-joined filter, so one request covers the batch.
  const dois = candidates.map((paper) => paper.doi.replace(/^https?:\/\/doi\.org\//i, ''));

  const byDoi = new Map();
  try {
    const result = await cache.wrap(`openalex:dois:${dois.join('|')}`, () =>
      openAlex.getWorksByDois(dois)
    );

    (result.results || []).forEach((work) => {
      const doi = String(work.doi || '').replace(/^https?:\/\/doi\.org\//i, '').toLowerCase();
      if (doi) byDoi.set(doi, work);
    });
  } catch (error) {
    // Enrichment is an optimisation. Losing it must not fail the request.
    console.warn('[retrieval] OpenAlex enrichment unavailable:', error.detail || error.message);
    return { papers, enriched: 0, attempted: candidates.length };
  }

  let enriched = 0;
  const merged = papers.map((paper) => {
    if (!paper.doi) return paper;
    const key = paper.doi.replace(/^https?:\/\/doi\.org\//i, '').toLowerCase();
    const work = byDoi.get(key);
    if (!work) return paper;

    const topics = (work.topics || []).map((t) => t.display_name).filter(Boolean);
    const fields = [
      ...new Set((work.topics || []).flatMap((t) => [t.field?.display_name, t.domain?.display_name]))
    ].filter(Boolean);
    const institutions = [
      ...new Set((work.authorships || []).flatMap((a) => (a.institutions || []).map((i) => i.display_name)))
    ].filter(Boolean);

    if (!topics.length && !fields.length && !institutions.length) return paper;
    enriched += 1;

    return {
      ...paper,
      topics: paper.topics.length ? paper.topics : topics,
      fields: paper.fields.length ? paper.fields : fields,
      institutions: paper.institutions.length ? paper.institutions : institutions,
      // Record that part of this record came from a second source.
      enriched_from: 'openalex'
    };
  });

  return { papers: merged, enriched, attempted: candidates.length };
}

/**
 * Chooses which papers are worth analysing.
 *
 * An abstract is required - there is nothing to extract from a title alone -
 * and the rest is ranked by citation count and recency so a large body of work
 * is represented by its most substantial entries.
 */
function selectPapersForAnalysis(papers, { maxPapers = 12 } = {}) {
  const withAbstract = papers.filter((paper) => paper.abstract && paper.abstract.length > 120);

  const ranked = [...withAbstract].sort((a, b) => {
    const citations = (b.citation_count || 0) - (a.citation_count || 0);
    if (citations !== 0) return citations;
    return (b.year || 0) - (a.year || 0);
  });

  return {
    selected: ranked.slice(0, maxPapers),
    considered: papers.length,
    skipped_without_abstract: papers.length - withAbstract.length
  };
}

module.exports = {
  resolveResearcherId,
  normalizeName,
  orcidOf,
  resolveOnFallbackProvider,
  searchResearchers,
  getResearcher,
  getResearcherPapers,
  enrichWithOpenAlex,
  selectPapersForAnalysis
};
