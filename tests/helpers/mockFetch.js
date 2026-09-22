/**
 * Replaces global fetch so tests never reach Semantic Scholar, OpenAlex or a
 * language model provider.
 *
 * Handlers are matched in order against the request URL. Anything unmatched
 * throws, which makes an accidental live call a visible test failure rather
 * than a slow, flaky pass.
 */

/**
 * @param {object} body
 * @param {number} status
 * @param {object} headers response headers, e.g. { 'retry-after': '3' }
 */
function jsonResponse(body, status = 200, headers = {}) {
  // Header lookups are case-insensitive in the real Headers API.
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)])
  );

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function errorResponse(status, body = { error: 'upstream failure' }, headers = {}) {
  return jsonResponse(body, status, headers);
}

/** A 429 carrying a Retry-After header. */
function rateLimitedResponse(retryAfter) {
  const headers = retryAfter == null ? {} : { 'Retry-After': String(retryAfter) };
  return errorResponse(429, { error: 'Too Many Requests' }, headers);
}

/** A rejection shaped like the one AbortSignal.timeout produces. */
function timeoutRejection() {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  return error;
}

function networkRejection(message = 'fetch failed') {
  return new TypeError(message);
}

class MockFetch {
  constructor() {
    this.handlers = [];
    this.calls = [];
    this.original = globalThis.fetch;
  }

  /**
   * @param {RegExp|string} matcher matched against the request URL
   * @param {function|object} responder response object, or (url, init) => response
   */
  on(matcher, responder) {
    this.handlers.push({ matcher, responder });
    return this;
  }

  /**
   * Registers a handler ahead of the existing ones. Handlers match in order, so
   * this is how a test overrides one response from a shared happy-path mock.
   */
  prepend(matcher, responder) {
    this.handlers.unshift({ matcher, responder });
    return this;
  }

  install() {
    globalThis.fetch = async (url, init) => {
      const target = String(url);

      // The test client talks to the app over a real loopback socket, so those
      // requests must reach the original fetch rather than a handler.
      if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(target)) {
        return this.original(url, init);
      }

      this.calls.push({ url: target, init });

      for (const { matcher, responder } of this.handlers) {
        const matched = matcher instanceof RegExp ? matcher.test(target) : target.includes(matcher);
        if (!matched) continue;

        const result = typeof responder === 'function' ? await responder(target, init) : responder;
        if (result instanceof Error) throw result;
        return result;
      }

      throw new Error(`MockFetch: no handler for ${target}`);
    };
    return this;
  }

  restore() {
    globalThis.fetch = this.original;
  }

  /** Requests made to a host, for asserting a provider was or was not called. */
  callsMatching(matcher) {
    return this.calls.filter((call) =>
      matcher instanceof RegExp ? matcher.test(call.url) : call.url.includes(matcher)
    );
  }
}

/** Builds an OpenAI-style chat completion wrapping `content`. */
function chatCompletion(content) {
  return jsonResponse({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] });
}

module.exports = {
  MockFetch,
  jsonResponse,
  errorResponse,
  rateLimitedResponse,
  timeoutRejection,
  networkRejection,
  chatCompletion
};
