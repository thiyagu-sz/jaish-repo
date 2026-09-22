/**
 * Orchestrator.
 *
 * Owns the order of work and the shared state between agents. The agents do not
 * call each other, and only the two that need a language model have one.
 *
 *   search   : Query Understanding -> Retrieval
 *   profile  : Retrieval -> (provider-grounded profile)
 *   analyze  : Retrieval -> RAG index -> Analysis
 *   gaps     : Retrieval -> RAG index -> Analysis -> Gap Detection
 *   graph    : Retrieval -> Graph (+ analysis overlay when available)
 *
 * Analysis results are cached per researcher, so requesting gaps straight after
 * an analysis does not pay for the analysis twice.
 */
const queryAgent = require('./queryUnderstandingAgent');
const retrieval = require('./retrievalAgent');
const analysisAgent = require('./analysisAgent');
const gapAgent = require('./gapAgent');
const vectorStore = require('../services/vectorStore');
const graphService = require('../services/graphService');
const cache = require('../services/cache');
const { ApiError } = require('../lib/httpErrors');

const ANALYSIS_TTL_MS = Number(process.env.ANALYSIS_CACHE_TTL_MS || 30 * 60 * 1000);

// The default analysis size. Named once because the cache key is built from it
// and the graph has to look the analysis up under the same key.
const ANALYSIS_MAX_PAPERS = 12;

/** Questions the RAG layer is asked. Each one targets a different section. */
const RETRIEVAL_QUERIES = {
  themes: 'core research themes, problems addressed and contributions',
  methods: 'methods, models, architectures and experimental design used',
  datasets: 'datasets, corpora, benchmarks and data sources used for evaluation',
  limitations: 'limitations, weaknesses, threats to validity and future work'
};

/** ------------------------------------------------------------------ search */

async function searchResearchers(rawQuery, { limit, offset, source } = {}) {
  const understanding = queryAgent.understand(rawQuery, { limit, offset });

  const result = await retrieval.searchResearchers(understanding.query, {
    limit: understanding.search_params.limit,
    offset: understanding.search_params.offset,
    source
  });

  return {
    query: understanding.query,
    // Surfaced so the UI can warn when a topic was typed into a person search.
    query_understanding: {
      intent: understanding.intent,
      confidence: understanding.confidence,
      reason: understanding.reason,
      normalized_query: understanding.query
    },
    researchers: result.researchers,
    total: result.total,
    offset: result.offset,
    next_offset: result.next_offset,
    source: result.source,
    fallback_used: result.fallback_used,
    provider_notes: result.provider_notes
  };
}

/** ----------------------------------------------------------------- profile */

async function getResearcher(researcherId) {
  return retrieval.getResearcher(researcherId);
}

async function getResearcherPapers(researcherId, options) {
  const result = await retrieval.getResearcherPapers(researcherId, options);
  const { papers, enriched } = await retrieval.enrichWithOpenAlex(result.papers);
  return { ...result, papers, enrichment: { source: 'openalex', papers_enriched: enriched } };
}

/**
 * Loads the papers an analysis will run over, plus the retrieval index.
 * Shared by analyze/gaps/graph so they agree on the same paper set.
 */
async function prepareCorpus(researcherId, { maxPapers = ANALYSIS_MAX_PAPERS, paperPoolSize = 40 } = {}) {
  const researcher = await retrieval.getResearcher(researcherId);

  const page = await retrieval.getResearcherPapers(researcherId, { limit: paperPoolSize, offset: 0 });
  if (!page.papers.length) {
    throw new ApiError('NO_PAPERS_AVAILABLE', `${researcherId} returned no papers`);
  }

  const { papers: enrichedPapers } = await retrieval.enrichWithOpenAlex(page.papers);
  const selection = retrieval.selectPapersForAnalysis(enrichedPapers, { maxPapers });

  if (!selection.selected.length) {
    throw new ApiError(
      'NO_ABSTRACTS_AVAILABLE',
      `${researcherId}: ${selection.considered} papers retrieved, none with a usable abstract`
    );
  }

  return { researcher, allPapers: enrichedPapers, selection };
}

/**
 * Runs the RAG retrieval step: index the selected papers, then pull the
 * excerpts that are relevant to each analysis question.
 */
async function retrieveEvidence(papers) {
  const index = await vectorStore.buildIndex(papers);

  const perQuery = await Promise.all(
    Object.entries(RETRIEVAL_QUERIES).map(async ([key, question]) => {
      const hits = await index.search(question, { k: 8, perPaperLimit: 2 });
      return [key, hits];
    })
  );

  // Merge into one de-duplicated excerpt set for the prompt, while keeping the
  // per-question breakdown for the response.
  const byId = new Map();
  perQuery.forEach(([, hits]) => hits.forEach((hit) => byId.set(hit.id, hit)));

  return {
    chunks: [...byId.values()],
    by_question: Object.fromEntries(perQuery.map(([key, hits]) => [key, hits.map((hit) => hit.id)])),
    embedder: index.embedder,
    indexed_chunks: index.size
  };
}

/** ---------------------------------------------------------------- analysis */

/**
 * Analyses a researcher. Cached, because /gaps and /graph both want the result
 * and an analysis is the most expensive call in the system.
 */
async function analyzeResearcher(researcherId, { maxPapers = ANALYSIS_MAX_PAPERS, refresh = false } = {}) {
  const cacheKey = `analysis:${researcherId}:${maxPapers}`;
  if (refresh) {
    cache.del(cacheKey);
    cache.del(`corpus:${researcherId}:${maxPapers}`);
  }

  const cached = cache.get(cacheKey);
  if (cached) return { ...cached, cached: true };

  const { researcher, allPapers, selection } = await prepareCorpus(researcherId, { maxPapers });
  const retrieved = await retrieveEvidence(selection.selected);

  const analysis = await analysisAgent.analyze({
    researcher,
    papers: selection.selected,
    chunks: retrieved.chunks
  });

  const payload = {
    researcher,
    analysis,
    papers_analyzed: selection.selected.map((paper) => ({
      id: paper.id,
      title: paper.title,
      year: paper.year,
      source: paper.source,
      url: paper.url,
      citation_count: paper.citation_count
    })),
    retrieval: {
      strategy: 'chunk -> embed -> cosine similarity -> top-k per question',
      embedder: retrieved.embedder,
      indexed_chunks: retrieved.indexed_chunks,
      excerpts_used: retrieved.chunks.length,
      questions: RETRIEVAL_QUERIES,
      by_question: retrieved.by_question
    },
    corpus: {
      papers_retrieved: allPapers.length,
      papers_selected: selection.selected.length,
      skipped_without_abstract: selection.skipped_without_abstract
    },
    cached: false
  };

  // Keep the paper objects out of the cached value but available to /gaps.
  cache.set(cacheKey, payload, ANALYSIS_TTL_MS);
  cache.set(`corpus:${researcherId}:${maxPapers}`, { researcher, allPapers, selection, retrieved }, ANALYSIS_TTL_MS);

  return payload;
}

/** -------------------------------------------------------------------- gaps */

async function detectGaps(researcherId, { maxPapers = ANALYSIS_MAX_PAPERS, refresh = false } = {}) {
  // Gap detection reads better with the analysis as context, and the analysis
  // is usually already cached from the previous screen.
  const analysisPayload = await analyzeResearcher(researcherId, { maxPapers, refresh });
  const corpus = cache.get(`corpus:${researcherId}:${maxPapers}`);

  const { researcher, selection, retrieved } = corpus || (await (async () => {
    const fresh = await prepareCorpus(researcherId, { maxPapers });
    return { ...fresh, retrieved: await retrieveEvidence(fresh.selection.selected) };
  })());

  const gaps = await gapAgent.detectGaps({
    researcher,
    papers: selection.selected,
    chunks: retrieved.chunks,
    analysis: analysisPayload.analysis
  });

  return {
    researcher,
    ...gaps,
    papers_analyzed: analysisPayload.papers_analyzed,
    retrieval: analysisPayload.retrieval,
    analysis_was_cached: analysisPayload.cached
  };
}

/** ------------------------------------------------------------------- graph */

/**
 * Puts the analysed papers at the front of the list, then the rest of the
 * retrieved page, de-duplicated by id. The graph slices this list, so anything
 * an analysis cited survives the slice and its overlay edges can be drawn.
 */
function orderAnalysedPapersFirst(papers, corpus) {
  const analysed = corpus?.selection?.selected || [];
  if (!analysed.length) return papers;

  const seen = new Set();
  const ordered = [];

  [...analysed, ...papers].forEach((paper) => {
    if (seen.has(paper.id)) return;
    seen.add(paper.id);
    ordered.push(paper);
  });

  return ordered;
}

/**
 * Builds the knowledge graph.
 *
 * The provider-grounded part is always built. The analysis overlay (methods and
 * datasets) is added only if an analysis is already cached, or if
 * `includeAnalysis` is set and a model is configured. A failing analysis
 * degrades the graph rather than failing the request.
 */
async function buildGraph(researcherId, { maxPapers = 30, includeAnalysis = false } = {}) {
  const researcher = await retrieval.getResearcher(researcherId);
  const page = await retrieval.getResearcherPapers(researcherId, { limit: maxPapers, offset: 0 });

  if (!page.papers.length) {
    throw new ApiError('NO_PAPERS_AVAILABLE', `${researcherId} returned no papers`);
  }

  const { papers } = await retrieval.enrichWithOpenAlex(page.papers);

  let analysis = cache.get(`analysis:${researcherId}:${ANALYSIS_MAX_PAPERS}`)?.analysis || null;
  let analysisNote = analysis ? 'methods and datasets added from a cached analysis' : null;

  if (!analysis && includeAnalysis) {
    try {
      analysis = (await analyzeResearcher(researcherId)).analysis;
      analysisNote = 'methods and datasets added from a fresh analysis';
    } catch (error) {
      analysisNote = `analysis overlay unavailable (${error.code || 'error'}); showing provider metadata only`;
      console.warn('[orchestrator] graph analysis overlay failed:', error.detail || error.message);
    }
  }

  // The analysis ranks papers by citation count, while this page holds the
  // provider ordering, so the two sets differ. Put the analysed papers first,
  // otherwise a method or dataset node would cite a paper the graph does not
  // contain and would be rendered with no edges at all.
  const graphPapers = analysis
    ? orderAnalysedPapersFirst(papers, cache.get(`corpus:${researcherId}:${ANALYSIS_MAX_PAPERS}`))
    : papers;

  const graph = graphService.buildGraph({ researcher, papers: graphPapers, analysis, options: { maxPapers } });

  return {
    researcher,
    ...graph,
    provenance: {
      provider_grounded: 'authorship, topics, domains and institutions come from the scholarly providers',
      llm_derived: analysis ? 'methods and datasets come from the analysis agent' : null,
      note: analysisNote
    }
  };
}

/**
 * Builds the knowledge graph from the analysis output rather than from provider
 * metadata.
 *
 * This is a projection of data the analysis already produced: it reuses the
 * cached analysis (and, when asked, the cached gap detection) rather than
 * re-running either. No provider or model call happens here beyond producing
 * those two results, so asking for the graph after viewing the intelligence
 * and gaps tabs costs nothing extra.
 */
async function buildAnalysisGraph(researcherId, { maxPapers = ANALYSIS_MAX_PAPERS, includeGaps = false, refresh = false } = {}) {
  const analysisPayload = await analyzeResearcher(researcherId, { maxPapers, refresh });

  let gaps = [];
  let gapDisclaimer = null;
  let gapsNote = null;

  if (includeGaps) {
    try {
      // `refresh` is not passed on: the analysis has just been refreshed, and
      // repeating it here would spend a second set of tokens for nothing.
      const gapPayload = await detectGaps(researcherId, { maxPapers });
      gaps = gapPayload.gaps;
      gapDisclaimer = gapPayload.disclaimer;
      if (!gaps.length) gapsNote = gapPayload.notes;
    } catch (error) {
      // The rest of the graph is still worth showing.
      gapsNote = `candidate gaps unavailable (${error.code || 'error'})`;
      console.warn('[orchestrator] gap nodes unavailable:', error.detail || error.message);
    }
  }

  const graph = graphService.buildAnalysisGraph({
    researcher: analysisPayload.researcher,
    analysis: analysisPayload.analysis,
    papersAnalyzed: analysisPayload.papers_analyzed,
    gaps,
    gapDisclaimer
  });

  return {
    researcher: analysisPayload.researcher,
    ...graph,
    meta: {
      ...graph.meta,
      analysis_cached: analysisPayload.cached,
      gaps_included: includeGaps,
      gaps_note: gapsNote,
      model: analysisPayload.analysis.meta.model,
      embedder: analysisPayload.retrieval.embedder
    },
    provenance: {
      provider_grounded: 'the researcher and the papers come from the scholarly providers',
      llm_derived: 'topics, methods, datasets, domains and candidate gaps come from the analysis agents',
      note:
        'Candidate gaps are drawn only from the papers listed here. Confidence describes how well ' +
        'those papers support a statement; it is not evidence of novelty.'
    }
  };
}

module.exports = {
  ANALYSIS_MAX_PAPERS,
  orderAnalysedPapersFirst,
  buildAnalysisGraph,
  searchResearchers,
  getResearcher,
  getResearcherPapers,
  analyzeResearcher,
  detectGaps,
  buildGraph,
  prepareCorpus,
  retrieveEvidence,
  RETRIEVAL_QUERIES
};
