/**
 * Researcher-centric API.
 *
 *   GET  /api/researchers/search?q=&limit=&offset=&source=
 *   GET  /api/researchers/:id
 *   GET  /api/researchers/:id/papers?limit=&offset=&year_from=&year_to=
 *   POST /api/researchers/:id/analyze
 *   POST /api/researchers/:id/gaps
 *   GET  /api/researchers/:id/graph?include_analysis=
 *
 * Unlike the older /api/research topic search, these endpoints never substitute
 * sample data for a failed call. A provider or model failure is reported with
 * the matching status code so the caller knows the difference between "no
 * result" and "we could not ask".
 */
const express = require('express');
const orchestrator = require('../agents/orchestrator');
const { ApiError, route } = require('../lib/httpErrors');
const { parseId } = require('../models/schemas');
const { SOURCES } = require('../providers');

const router = express.Router();

/** ---------------------------------------------------------- parsing helpers */

function parseIntParam(value, { name, min, max, fallback }) {
  if (value === undefined || value === '') return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new ApiError('INVALID_PARAMETER', `${name} must be an integer`);
  }
  if (parsed < min || parsed > max) {
    throw new ApiError('INVALID_PARAMETER', `${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseYear(value, name) {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1800 || parsed > 2200) {
    throw new ApiError('INVALID_PARAMETER', `${name} must be a four digit year`);
  }
  return parsed;
}

/** Rejects an unparseable id before it can reach a provider URL. */
function requireResearcherId(req) {
  const id = req.params.id;
  if (!parseId(id)) {
    throw new ApiError('INVALID_RESEARCHER_ID', `"${id}" is not a "<source>:<id>" identifier`);
  }
  return id;
}

/** Bodies are optional on POST, but a malformed one is a 422 not a crash. */
function parseAnalyzeBody(req) {
  const body = req.body || {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError('VALIDATION_FAILED', 'request body must be a JSON object');
  }

  const maxPapers = parseIntParam(body.max_papers, { name: 'max_papers', min: 2, max: 30, fallback: 12 });

  if (body.refresh !== undefined && typeof body.refresh !== 'boolean') {
    throw new ApiError('VALIDATION_FAILED', 'refresh must be a boolean');
  }

  return { maxPapers, refresh: Boolean(body.refresh) };
}

/** -------------------------------------------------------------- researchers */

/**
 * GET /api/researchers/search
 * 200 with an empty array when nobody matches; 400 when the query is missing.
 */
router.get(
  '/search',
  route(async (req, res) => {
    const query = String(req.query.q || '').trim();
    if (!query) {
      throw new ApiError('INVALID_QUERY', 'q is required');
    }

    const limit = parseIntParam(req.query.limit, { name: 'limit', min: 1, max: 50, fallback: 10 });
    const offset = parseIntParam(req.query.offset, { name: 'offset', min: 0, max: 10000, fallback: 0 });

    const source = req.query.source ? String(req.query.source) : undefined;
    if (source && !Object.values(SOURCES).includes(source)) {
      throw new ApiError('INVALID_PARAMETER', `source must be one of: ${Object.values(SOURCES).join(', ')}`);
    }

    const result = await orchestrator.searchResearchers(query, { limit, offset, source });
    res.json({ ...result, count: result.researchers.length, request_id: res.locals.requestId });
  })
);

/** GET /api/researchers/:id */
router.get(
  '/:id',
  route(async (req, res) => {
    const researcherId = requireResearcherId(req);
    const researcher = await orchestrator.getResearcher(researcherId);
    res.json({ researcher, request_id: res.locals.requestId });
  })
);

/** GET /api/researchers/:id/papers */
router.get(
  '/:id/papers',
  route(async (req, res) => {
    const researcherId = requireResearcherId(req);

    const limit = parseIntParam(req.query.limit, { name: 'limit', min: 1, max: 100, fallback: 25 });
    const offset = parseIntParam(req.query.offset, { name: 'offset', min: 0, max: 10000, fallback: 0 });
    const yearFrom = parseYear(req.query.year_from, 'year_from');
    const yearTo = parseYear(req.query.year_to, 'year_to');

    if (yearFrom && yearTo && yearFrom > yearTo) {
      throw new ApiError('INVALID_PARAMETER', 'year_from must not be later than year_to');
    }

    const result = await orchestrator.getResearcherPapers(researcherId, { limit, offset, yearFrom, yearTo });

    res.json({
      researcher_id: researcherId,
      count: result.papers.length,
      papers: result.papers,
      total: result.total,
      offset: result.offset,
      next_offset: result.next_offset,
      year_filter_applied: result.year_filter_applied,
      served_by: result.served_by,
      fallback: result.fallback,
      enrichment: result.enrichment,
      request_id: res.locals.requestId
    });
  })
);

/**
 * POST /api/researchers/:id/analyze
 * Body (optional): { max_papers?: number, refresh?: boolean }
 *
 * 200, not 201: the analysis is computed and returned, not stored as a new
 * addressable resource.
 */
router.post(
  '/:id/analyze',
  route(async (req, res) => {
    const researcherId = requireResearcherId(req);
    const { maxPapers, refresh } = parseAnalyzeBody(req);

    const result = await orchestrator.analyzeResearcher(researcherId, { maxPapers, refresh });
    res.json({ ...result, request_id: res.locals.requestId });
  })
);

/** POST /api/researchers/:id/gaps */
router.post(
  '/:id/gaps',
  route(async (req, res) => {
    const researcherId = requireResearcherId(req);
    const { maxPapers, refresh } = parseAnalyzeBody(req);

    const result = await orchestrator.detectGaps(researcherId, { maxPapers, refresh });
    res.json({ ...result, request_id: res.locals.requestId });
  })
);

/**
 * GET /api/researchers/:id/graph
 *
 * Two graphs are available, chosen with `source`:
 *
 *   provider (default) - built from scholarly metadata: authorship, OpenAlex
 *                        topics and domains, institutions. Needs no model, so
 *                        it works with no OPENROUTER_API_KEY set.
 *                        `include_analysis=true` adds method/dataset nodes.
 *
 *   analysis           - built from the JSON that /analyze returns: topics,
 *                        methods, datasets and domains with their evidence,
 *                        plus candidate research gaps when `include_gaps=true`.
 *
 * The default is unchanged, so existing callers keep the graph they had.
 */
const GRAPH_SOURCES = ['provider', 'analysis'];

router.get(
  '/:id/graph',
  route(async (req, res) => {
    const researcherId = requireResearcherId(req);

    const source = String(req.query.source || 'provider');
    if (!GRAPH_SOURCES.includes(source)) {
      throw new ApiError('INVALID_PARAMETER', `source must be one of: ${GRAPH_SOURCES.join(', ')}`);
    }

    if (source === 'analysis') {
      const maxPapers = parseIntParam(req.query.max_papers, { name: 'max_papers', min: 2, max: 30, fallback: 12 });
      const includeGaps = String(req.query.include_gaps || '') === 'true';
      const refresh = String(req.query.refresh || '') === 'true';

      const result = await orchestrator.buildAnalysisGraph(researcherId, { maxPapers, includeGaps, refresh });
      return res.json({ ...result, request_id: res.locals.requestId });
    }

    const maxPapers = parseIntParam(req.query.max_papers, { name: 'max_papers', min: 2, max: 60, fallback: 30 });
    const includeAnalysis = String(req.query.include_analysis || '') === 'true';

    const result = await orchestrator.buildGraph(researcherId, { maxPapers, includeAnalysis });

    // `meta` is additive: `summary` is unchanged for anything already reading it.
    return res.json({
      ...result,
      meta: {
        node_count: result.summary.node_count,
        edge_count: result.summary.edge_count,
        source: 'provider',
        nodes_by_type: result.summary.nodes_by_type
      },
      request_id: res.locals.requestId
    });
  })
);

module.exports = router;
