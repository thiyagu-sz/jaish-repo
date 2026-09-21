/**
 * Query Understanding Agent.
 *
 * Decides whether a query names a person or describes a topic, normalizes it,
 * and prepares provider search parameters.
 *
 * This agent is deliberately rule-based. Classifying "Yoshua Bengio" as a name
 * does not need a language model, and routing every search through one would
 * add cost and latency to the first step of the demo for no gain.
 */
const { ApiError } = require('../lib/httpErrors');

const MAX_QUERY_LENGTH = 200;

// Titles and honorifics that should not be searched as part of a name.
const TITLES = new Set(['dr', 'dr.', 'prof', 'prof.', 'professor', 'mr', 'mr.', 'mrs', 'mrs.', 'ms', 'ms.', 'phd']);

// Words that indicate the user described a subject rather than a person.
const TOPIC_MARKERS = new Set([
  'using', 'for', 'with', 'based', 'learning', 'network', 'networks', 'model', 'models',
  'system', 'systems', 'analysis', 'detection', 'generation', 'research', 'algorithm',
  'algorithms', 'data', 'ai', 'ml', 'llm', 'llms', 'in', 'of', 'and', 'the', 'on', 'survey'
]);

/** Strips punctuation the providers do not index and collapses whitespace. */
function normalize(raw) {
  return String(raw || '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTitles(query) {
  return query
    .split(' ')
    .filter((word) => !TITLES.has(word.toLowerCase()))
    .join(' ');
}

/**
 * Heuristic person-name classification with a stated confidence, so the UI can
 * explain why it searched for a person rather than a topic.
 */
function classify(query) {
  const words = query.split(' ').filter(Boolean);
  const lower = words.map((word) => word.toLowerCase());

  if (!words.length) return { intent: 'unknown', confidence: 0, reason: 'empty query' };

  if (lower.some((word) => TOPIC_MARKERS.has(word))) {
    return {
      intent: 'topic_search',
      confidence: 0.8,
      reason: 'the query contains words that describe a subject rather than a person'
    };
  }

  if (words.length > 5) {
    return { intent: 'topic_search', confidence: 0.7, reason: 'the query is longer than a personal name' };
  }

  // An ORCID is unambiguous.
  if (/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(query)) {
    return { intent: 'researcher_search', confidence: 1, reason: 'the query is an ORCID identifier' };
  }

  const capitalisedWords = words.filter((word) => /^[A-Z]/.test(word)).length;
  // "Y. Bengio" style initials are a strong signal in author records.
  const hasInitial = words.some((word) => /^[A-Z]\.?$/.test(word));

  if (words.length >= 2 && capitalisedWords >= 2) {
    return {
      intent: 'researcher_search',
      confidence: hasInitial ? 0.9 : 0.85,
      reason: 'the query looks like a personal name'
    };
  }

  if (words.length === 1) {
    return {
      intent: 'researcher_search',
      confidence: 0.4,
      reason: 'a single word may be a surname; searching authors first'
    };
  }

  return {
    intent: 'researcher_search',
    confidence: 0.5,
    reason: 'the query has no subject words, so it is treated as a name'
  };
}

/**
 * @param {string} rawQuery
 * @param {{limit?: number, offset?: number}} options
 * @returns {{query: string, original: string, intent: string, confidence: number,
 *            reason: string, search_params: object}}
 */
function understand(rawQuery, { limit = 10, offset = 0 } = {}) {
  const original = String(rawQuery || '');
  const normalized = normalize(original);

  if (!normalized) {
    throw new ApiError('INVALID_QUERY', 'query was empty after normalization');
  }
  if (normalized.length > MAX_QUERY_LENGTH) {
    throw new ApiError('INVALID_QUERY', `query exceeds ${MAX_QUERY_LENGTH} characters`);
  }

  const query = stripTitles(normalized) || normalized;
  const classification = classify(query);

  return {
    query,
    original,
    ...classification,
    search_params: { query, limit, offset }
  };
}

module.exports = { understand, normalize, classify, stripTitles, MAX_QUERY_LENGTH };
