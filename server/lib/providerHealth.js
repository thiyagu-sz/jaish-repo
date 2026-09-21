/**
 * Per-provider rate-limit state.
 *
 * A 429 is not a one-off failure: the provider is telling us to stop for a
 * while. Retrying inside the same request would be hammering, and so would the
 * next request starting from scratch a second later. This module remembers that
 * a provider is cooling down, so every caller can skip it and go straight to a
 * working source until the cooldown expires.
 *
 * The state is process-local and intentionally small. It is shared by both the
 * researcher provider layer and the older topic-search layer, so a 429 seen by
 * one is respected by the other.
 */

/** Cooldown used when the provider gives no Retry-After header. */
const DEFAULT_COOLDOWN_MS = Number(process.env.PROVIDER_COOLDOWN_MS || 60_000);

/** Never trust an absurd Retry-After; a long one just means "use the fallback". */
const MAX_COOLDOWN_MS = Number(process.env.PROVIDER_MAX_COOLDOWN_MS || 5 * 60_000);

/**
 * The longest we will block an in-flight request waiting to retry. Anything
 * longer is not worth a user waiting for when another provider can answer now.
 */
const MAX_INLINE_RETRY_WAIT_MS = Number(process.env.PROVIDER_MAX_RETRY_WAIT_MS || 2000);

/** Display names for logs, covering both layers' source keys. */
const DISPLAY_NAMES = {
  semantic_scholar: 'Semantic Scholar',
  semanticscholar: 'Semantic Scholar',
  openalex: 'OpenAlex',
  arxiv: 'arXiv'
};

function displayName(source) {
  return DISPLAY_NAMES[source] || source;
}

/** source -> { until: epochMs, reason: string, hits: number } */
const cooldowns = new Map();

function now() {
  return Date.now();
}

/**
 * Parses a Retry-After header. The spec allows either a number of seconds or an
 * HTTP date, and both appear in the wild.
 *
 * @returns {number|null} milliseconds to wait, or null when absent/unparseable
 */
function parseRetryAfter(value) {
  if (value == null || value === '') return null;

  const raw = String(value).trim();

  // delta-seconds
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }

  // HTTP-date
  const timestamp = Date.parse(raw);
  if (Number.isFinite(timestamp)) {
    // A date in the past means "retry now", not "wait a negative time".
    return Math.max(0, timestamp - now());
  }

  return null;
}

/**
 * Records that a provider rate limited us.
 *
 * @param {string} source
 * @param {number|null} retryAfterMs from the Retry-After header, if any
 * @returns {number} the cooldown actually applied, in ms
 */
function markRateLimited(source, retryAfterMs = null) {
  const requested = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : DEFAULT_COOLDOWN_MS;
  const cooldown = Math.min(requested, MAX_COOLDOWN_MS);

  const previous = cooldowns.get(source);
  cooldowns.set(source, {
    until: now() + cooldown,
    reason: 'rate_limited',
    retry_after_ms: Number.isFinite(retryAfterMs) ? retryAfterMs : null,
    hits: (previous?.hits || 0) + 1
  });

  return cooldown;
}

/** Clears the cooldown after a successful call. */
function markHealthy(source) {
  cooldowns.delete(source);
}

function cooldownRemainingMs(source) {
  const entry = cooldowns.get(source);
  if (!entry) return 0;

  const remaining = entry.until - now();
  if (remaining <= 0) {
    cooldowns.delete(source);
    return 0;
  }
  return remaining;
}

function isCoolingDown(source) {
  return cooldownRemainingMs(source) > 0;
}

/**
 * Whether it is worth waiting out this cooldown inside the current request.
 * Short waits are fine; long ones mean the caller should use a fallback.
 */
function isWorthWaiting(waitMs) {
  // 0 is a valid Retry-After meaning "retry immediately", so it counts as
  // worth waiting; null (no header) does not.
  return Number.isFinite(waitMs) && waitMs >= 0 && waitMs <= MAX_INLINE_RETRY_WAIT_MS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ---------------------------------------------------------------- logging */

/**
 * The provider status lines. Kept here so both layers log the same wording and
 * a reader of the console sees one consistent story.
 */
function logRateLimited(source, cooldownMs) {
  const seconds = Math.ceil(cooldownMs / 1000);
  console.warn(`${displayName(source)}: rate limited (backing off ${seconds}s)`);
}

function logSkipped(source) {
  const seconds = Math.ceil(cooldownRemainingMs(source) / 1000);
  console.warn(`${displayName(source)}: rate limited (cooling down, ${seconds}s left) - skipping`);
}

function logFallback(toSource) {
  console.warn(`Falling back to ${displayName(toSource)}`);
}

function logRecovered(source) {
  console.log(`${displayName(source)}: recovered`);
}

/** ----------------------------------------------------------------- status */

/** Snapshot for /api/health. Contains no credentials. */
function status() {
  const result = {};
  for (const source of Object.keys(DISPLAY_NAMES)) {
    // Only report canonical keys, not the legacy alias.
    if (source === 'semanticscholar') continue;

    const remaining = cooldownRemainingMs(source);
    const entry = cooldowns.get(source);
    result[source] = {
      name: displayName(source),
      state: remaining > 0 ? 'rate_limited' : 'ok',
      cooldown_remaining_ms: remaining,
      rate_limit_hits: entry?.hits || 0
    };
  }
  return result;
}

function reset() {
  cooldowns.clear();
}

module.exports = {
  DEFAULT_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  MAX_INLINE_RETRY_WAIT_MS,
  displayName,
  parseRetryAfter,
  markRateLimited,
  markHealthy,
  cooldownRemainingMs,
  isCoolingDown,
  isWorthWaiting,
  sleep,
  logRateLimited,
  logSkipped,
  logFallback,
  logRecovered,
  status,
  reset
};
