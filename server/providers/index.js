/**
 * Provider registry.
 *
 * Every provider implements the same ResearchProvider interface:
 *   searchResearchers(query, { limit, offset })
 *   getResearcher(sourceId)
 *   getResearcherPapers(sourceId, { limit, offset, yearFrom, yearTo })
 *   getPaper(sourceId)
 *   searchPapers(query, { limit })
 *
 * Business logic resolves a provider by source name and never imports an
 * adapter directly, so swapping or adding a source is a one-line change here.
 */
const semanticScholar = require('./semanticScholar');
const openAlex = require('./openAlex');
const { SOURCES } = require('../models/schemas');
const { ApiError } = require('../lib/httpErrors');

const REQUIRED_METHODS = [
  'searchResearchers', 'getResearcher', 'getResearcherPapers', 'getPaper', 'searchPapers'
];

const PROVIDERS = {
  [SOURCES.SEMANTIC_SCHOLAR]: semanticScholar,
  [SOURCES.OPENALEX]: openAlex
};

// Fail at boot rather than at request time if an adapter is incomplete.
for (const [source, provider] of Object.entries(PROVIDERS)) {
  const missing = REQUIRED_METHODS.filter((method) => typeof provider[method] !== 'function');
  if (missing.length) {
    throw new Error(`Provider "${source}" does not implement: ${missing.join(', ')}`);
  }
}

/** Semantic Scholar is primary: it is the only one with reliable abstracts. */
const DEFAULT_SOURCE = SOURCES.SEMANTIC_SCHOLAR;

function getProvider(source) {
  const provider = PROVIDERS[source];
  if (!provider) throw new ApiError('INVALID_PARAMETER', `unknown source "${source}"`);
  return provider;
}

function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({ source: p.source, name: p.name }));
}

module.exports = { getProvider, listProviders, PROVIDERS, DEFAULT_SOURCE, SOURCES };
