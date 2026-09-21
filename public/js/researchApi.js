/**
 * Client for the researcher endpoints.
 *
 * The browser only ever talks to our own server, so no provider key is ever
 * present in the page. Errors arrive as { error: { code, message, request_id } }
 * and are re-thrown as an Error carrying the code, so the UI can react to the
 * kind of failure rather than parsing a message string.
 */
const ResearchAPI = (() => {
  class ApiClientError extends Error {
    constructor(message, code, requestId, status) {
      super(message);
      this.name = 'ApiClientError';
      this.code = code || 'UNKNOWN';
      this.requestId = requestId || null;
      this.status = status;
    }
  }

  async function call(path, options = {}) {
    let response;

    try {
      response = await fetch(path, options);
    } catch {
      throw new ApiClientError(
        'Could not reach the server. Check that it is running.',
        'NETWORK_ERROR',
        null,
        0
      );
    }

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const error = (data && data.error) || {};
      throw new ApiClientError(
        error.message || 'The request failed.',
        error.code,
        error.request_id,
        response.status
      );
    }

    return data;
  }

  function postJson(path, body) {
    return call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  return {
    ApiClientError,

    health: () => call('/api/health'),

    searchResearchers: (query, { limit = 10 } = {}) =>
      call(`/api/researchers/search?q=${encodeURIComponent(query)}&limit=${limit}`),

    getResearcher: (id) => call(`/api/researchers/${encodeURIComponent(id)}`),

    getPapers: (id, { limit = 25, yearFrom, yearTo } = {}) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (yearFrom) params.set('year_from', String(yearFrom));
      if (yearTo) params.set('year_to', String(yearTo));
      return call(`/api/researchers/${encodeURIComponent(id)}/papers?${params.toString()}`);
    },

    analyze: (id, options) => postJson(`/api/researchers/${encodeURIComponent(id)}/analyze`, options),

    gaps: (id, options) => postJson(`/api/researchers/${encodeURIComponent(id)}/gaps`, options),

    graph: (id, { maxPapers = 30, includeAnalysis = false } = {}) =>
      call(
        `/api/researchers/${encodeURIComponent(id)}/graph` +
          `?max_papers=${maxPapers}&include_analysis=${includeAnalysis}`
      ),

    /**
     * The knowledge graph projected from the analysis JSON, with candidate
     * research gaps when asked for. Reuses the cached analysis, so opening it
     * after the intelligence tab costs nothing extra.
     */
    analysisGraph: (id, { includeGaps = false, maxPapers = 12 } = {}) =>
      call(
        `/api/researchers/${encodeURIComponent(id)}/graph` +
          `?source=analysis&max_papers=${maxPapers}&include_gaps=${includeGaps}`
      )
  };
})();
