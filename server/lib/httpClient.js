/**
 * Outbound HTTP for provider adapters.
 *
 * Every failure mode an external scholarly API can produce is translated into a
 * typed ApiError here, so provider adapters and routes never have to guess what
 * a raw fetch rejection meant.
 *
 * Rate limiting is handled deliberately rather than by blind retrying:
 *
 *   - a 429 records a cooldown for that provider (see lib/providerHealth.js),
 *     so the next request skips it instead of asking again immediately;
 *   - Retry-After is honoured, but only retried inline when the wait is short.
 *     A long Retry-After means "use another source", not "block the user";
 *   - transient failures (5xx, timeout, socket errors) get one short backoff
 *     retry, which is enough for a blip and far from hammering.
 */
const { ApiError } = require('./httpErrors');
const providerHealth = require('./providerHealth');

const DEFAULT_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS || 12000);

/** One retry for transient failures. Rate limits are handled separately. */
const DEFAULT_RETRIES = Number(process.env.PROVIDER_RETRIES || 1);
const BASE_BACKOFF_MS = Number(process.env.PROVIDER_BACKOFF_MS || 400);

/** Statuses worth retrying: the provider is briefly unwell, not wrong. */
const RETRYABLE_STATUSES = new Set([500, 502, 503]);

/**
 * Exponential backoff with jitter. Jitter matters because our own parallel
 * calls would otherwise retry in lockstep and arrive as a burst.
 */
function backoffMs(attempt) {
  const exponential = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

/** Strips the query string so keys in parameters can never reach a log line. */
function safeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'provider';
  }
}

/**
 * GET JSON with a timeout, bounded retries and rate-limit awareness.
 *
 * @param {string} url
 * @param {object} options
 * @param {object} [options.headers]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.notFoundCode]  error code to raise on a 404
 * @param {string} [options.source]        provider key, for cooldown tracking
 * @param {number} [options.retries]       transient-failure retries
 */
async function getJson(url, options = {}) {
  const {
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    notFoundCode,
    source = null,
    retries = DEFAULT_RETRIES
  } = options;

  // A provider that told us to back off is not asked again until it expires.
  // The caller is expected to have a fallback; if it does not, this still fails
  // fast with the right code instead of earning another 429.
  if (source && providerHealth.isCoolingDown(source)) {
    providerHealth.logSkipped(source);
    throw new ApiError(
      'PROVIDER_RATE_LIMITED',
      `${providerHealth.displayName(source)} is cooling down for another ` +
        `${providerHealth.cooldownRemainingMs(source)}ms`
    );
  }

  let attempt = 0;

  // attempt 0 is the first try; `retries` further attempts are allowed.
  for (;;) {
    attempt += 1;

    let response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      // AbortSignal.timeout rejects with TimeoutError; everything else here is
      // a DNS/socket/TLS failure, i.e. the provider is unreachable.
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';

      if (attempt <= retries) {
        await providerHealth.sleep(backoffMs(attempt));
        continue;
      }

      if (timedOut) {
        throw new ApiError('PROVIDER_TIMEOUT', `${safeUrl(url)} timed out after ${timeoutMs}ms`);
      }
      throw new ApiError('RESEARCH_PROVIDER_UNAVAILABLE', `${safeUrl(url)}: ${error?.message}`);
    }

    /** ------------------------------------------------------ rate limited */
    if (response.status === 429) {
      const retryAfterMs = providerHealth.parseRetryAfter(response.headers?.get?.('retry-after'));

      // Honour a short Retry-After once: the provider has told us exactly how
      // long to wait, and waiting a moment is better than failing over.
      if (attempt <= retries && providerHealth.isWorthWaiting(retryAfterMs)) {
        await providerHealth.sleep(retryAfterMs);
        continue;
      }

      const cooldown = source
        ? providerHealth.markRateLimited(source, retryAfterMs)
        : retryAfterMs || providerHealth.DEFAULT_COOLDOWN_MS;

      if (source) providerHealth.logRateLimited(source, cooldown);

      const error = new ApiError(
        'PROVIDER_RATE_LIMITED',
        `${safeUrl(url)} returned 429` +
          (retryAfterMs != null ? ` (Retry-After ${Math.round(retryAfterMs / 1000)}s)` : '')
      );
      error.retryAfterMs = retryAfterMs;
      error.cooldownMs = cooldown;
      throw error;
    }

    if (response.status === 404) {
      throw new ApiError(notFoundCode || 'RESEARCH_PROVIDER_UNAVAILABLE', `${safeUrl(url)} returned 404`);
    }

    if (!response.ok) {
      if (attempt <= retries && RETRYABLE_STATUSES.has(response.status)) {
        await providerHealth.sleep(backoffMs(attempt));
        continue;
      }
      throw new ApiError('RESEARCH_PROVIDER_UNAVAILABLE', `${safeUrl(url)} returned ${response.status}`);
    }

    /** ------------------------------------------------------------ success */
    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw new ApiError('PROVIDER_MALFORMED_RESPONSE', `${safeUrl(url)}: ${error?.message}`);
    }

    // A success clears any previous cooldown for this provider.
    if (source && providerHealth.isCoolingDown(source)) providerHealth.logRecovered(source);
    if (source) providerHealth.markHealthy(source);

    return body;
  }
}

module.exports = { getJson, safeUrl, backoffMs, DEFAULT_TIMEOUT_MS, DEFAULT_RETRIES };
