/**
 * Error codes, HTTP status mapping and the single error envelope used by every
 * /api/researchers endpoint.
 *
 * The frontend only ever sees { error: { code, message, request_id } }. Provider
 * URLs, API keys, stack traces and upstream response bodies stay on the server.
 */
const { randomUUID } = require('crypto');

/** code -> [httpStatus, safeMessage] */
const ERRORS = {
  INVALID_QUERY: [400, 'The search query is missing or invalid.'],
  INVALID_PARAMETER: [400, 'One or more query parameters are invalid.'],
  INVALID_RESEARCHER_ID: [400, 'The researcher id is not in a recognised format.'],
  VALIDATION_FAILED: [422, 'The request body failed validation.'],
  RESEARCHER_NOT_FOUND: [404, 'No researcher exists with that id.'],
  PAPER_NOT_FOUND: [404, 'No paper exists with that id.'],
  ENDPOINT_NOT_FOUND: [404, 'Unknown API endpoint.'],
  NO_PAPERS_AVAILABLE: [422, 'This researcher has no retrievable papers to analyse.'],
  NO_ABSTRACTS_AVAILABLE: [422, 'None of the retrieved papers include an abstract, so there is nothing to analyse.'],
  PROVIDER_RATE_LIMITED: [429, 'The research provider is rate limiting requests. Please retry shortly.'],
  RESEARCH_PROVIDER_UNAVAILABLE: [502, 'The research provider could not be reached.'],
  PROVIDER_MALFORMED_RESPONSE: [502, 'The research provider returned a response we could not read.'],
  PROVIDER_TIMEOUT: [504, 'The research provider did not respond in time.'],
  LLM_NOT_CONFIGURED: [503, 'No language model is configured, so analysis is unavailable.'],
  LLM_UNAVAILABLE: [502, 'The language model provider could not be reached.'],
  LLM_TIMEOUT: [504, 'The language model did not respond in time.'],
  LLM_INVALID_OUTPUT: [502, 'The language model returned output that failed validation.'],
  GRAPH_UNAVAILABLE: [503, 'The knowledge graph service is unavailable.'],
  VECTOR_STORE_UNAVAILABLE: [503, 'The retrieval index is unavailable.'],
  INTERNAL_ERROR: [500, 'An unexpected internal error occurred.']
};

/**
 * An error that is safe to surface. `detail` is logged server-side only.
 */
class ApiError extends Error {
  constructor(code, detail) {
    const [status, message] = ERRORS[code] || ERRORS.INTERNAL_ERROR;
    super(message);
    this.name = 'ApiError';
    this.code = ERRORS[code] ? code : 'INTERNAL_ERROR';
    this.status = status;
    this.detail = detail || '';
  }
}

function newRequestId() {
  return randomUUID();
}

/** Writes the error envelope. Always logs the unsafe detail, never sends it. */
function sendError(res, error) {
  const apiError = error instanceof ApiError ? error : new ApiError('INTERNAL_ERROR', error?.message);
  const requestId = res.locals.requestId || newRequestId();

  console.error(
    `[api] ${apiError.code} (${apiError.status}) request_id=${requestId}` +
      (apiError.detail ? ` detail=${apiError.detail}` : '')
  );

  res.status(apiError.status).json({
    error: {
      code: apiError.code,
      message: apiError.message,
      request_id: requestId
    }
  });
}

/** Wraps an async route so a rejected promise becomes a clean error envelope. */
function route(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => sendError(res, error));
  };
}

module.exports = { ApiError, ERRORS, newRequestId, sendError, route };
