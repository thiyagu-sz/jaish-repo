/**
 * Starts the Express app on an ephemeral port for the duration of a test file.
 *
 * The app is required lazily so a test can set environment variables (an LLM
 * key, for example) before any module reads them.
 */
const cache = require('../../server/services/cache');
const providerHealth = require('../../server/lib/providerHealth');

async function startTestServer() {
  const app = require('../../server/app');

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  /** Small request helper returning both status and parsed body. */
  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
      body: options.body
    });

    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body, headers: response.headers };
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, baseUrl, request, close };
}

/**
 * Cached provider responses would hide a mock change between tests, and a
 * cooldown recorded by a 429 test would make later tests skip that provider.
 */
function resetCache() {
  cache.clear();
  providerHealth.reset();
}

module.exports = { startTestServer, resetCache };
