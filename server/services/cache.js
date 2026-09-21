/**
 * Process-local TTL cache.
 *
 * Purpose is narrow: stop the app calling a scholarly API twice for the same
 * researcher inside one session. It is deliberately in-memory - the project has
 * no database, and adding Redis for a single-process demo would be overkill.
 *
 * The interface (get/set/wrap) is what a Redis or SQLite backing would also
 * expose, so replacing the store later does not touch any caller.
 */
const DEFAULT_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 500);

const store = new Map();

function isExpired(entry) {
  return entry.expiresAt <= Date.now();
}

function get(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (isExpired(entry)) {
    store.delete(key);
    return undefined;
  }
  // Refresh insertion order so the eviction below is least-recently-used.
  store.delete(key);
  store.set(key, entry);
  return entry.value;
}

function set(key, value, ttlMs = DEFAULT_TTL_MS) {
  if (store.has(key)) store.delete(key);
  store.set(key, { value, expiresAt: Date.now() + ttlMs });

  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
  return value;
}

/**
 * In-flight producers, keyed the same way as the cache.
 *
 * The cache alone only de-duplicates sequential calls. Concurrent ones would
 * each miss and each hit the provider, which is both wasteful and a good way
 * to earn a rate limit. Sharing the promise means N callers cause one request.
 */
const inFlight = new Map();

/**
 * Runs `producer` only on a miss, and only once for concurrent callers.
 * Failures are never cached, so a provider outage does not get pinned for the
 * whole TTL, and a failed promise is removed so the next caller may retry.
 */
async function wrap(key, producer, ttlMs = DEFAULT_TTL_MS) {
  const hit = get(key);
  if (hit !== undefined) return hit;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = (async () => producer())()
    .then((value) => set(key, value, ttlMs))
    .finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return promise;
}

/** Number of requests currently sharing a producer. Used by tests. */
function inFlightCount() {
  return inFlight.size;
}

function del(key) {
  return store.delete(key);
}

function clear() {
  store.clear();
  inFlight.clear();
}

function stats() {
  let live = 0;
  for (const entry of store.values()) if (!isExpired(entry)) live += 1;
  return { entries: live, capacity: MAX_ENTRIES, ttl_ms: DEFAULT_TTL_MS };
}

module.exports = { get, set, del, wrap, clear, stats, inFlightCount, DEFAULT_TTL_MS };
