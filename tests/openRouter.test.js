/**
 * OpenRouter integration tests.
 *
 * Covers how the application talks to OpenRouter: configuration, the request it
 * actually sends, and every failure mode mapped onto our HTTP semantics.
 *
 * The real OpenRouter API is never called. Global fetch is replaced, and an
 * unmatched request throws, so a test cannot quietly reach the network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { MockFetch, jsonResponse, errorResponse, timeoutRejection, networkRejection, chatCompletion } =
  require('./helpers/mockFetch');
const fixtures = require('./helpers/fixtures');
const { startTestServer, resetCache } = require('./helpers/server');

const TEST_KEY = 'sk-or-v1-test-key-not-real';

// Retrieval must not depend on an embeddings endpoint being reachable.
process.env.EMBEDDINGS_PROVIDER = 'local';
process.env.OPENROUTER_API_KEY = TEST_KEY;

const openRouter = require('../server/services/openRouter');
const llmClient = require('../server/services/llmClient');
const aiService = require('../server/services/aiService');

const LLM = /chat\/completions/;

let app;

test.before(async () => {
  app = await startTestServer();
});

test.after(async () => {
  await app.close();
});

/** Restores the key after a test that clears it. */
function withKey(value, fn) {
  const previous = process.env.OPENROUTER_API_KEY;
  if (value === null) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = value;

  return Promise.resolve(fn()).finally(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  });
}

function mockProviders() {
  return new MockFetch()
    .on(/author\/search/, jsonResponse(fixtures.S2_AUTHOR_SEARCH))
    .on(/author\/1751762\/papers/, jsonResponse(fixtures.S2_AUTHOR_PAPERS))
    .on(/author\/1751762(\?|$)/, jsonResponse(fixtures.S2_AUTHOR))
    .on(/openalex\.org\/works/, jsonResponse(fixtures.OPENALEX_WORKS_BY_DOI))
    .on(/openalex\.org\/authors/, jsonResponse(fixtures.OPENALEX_AUTHORS));
}

function withMock(mock, fn) {
  resetCache();
  mock.install();
  return Promise.resolve(fn(mock)).finally(() => {
    mock.restore();
    resetCache();
  });
}

function analyze(body = {}) {
  return app.request('/api/researchers/s2:1751762/analyze', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

/** ------------------------------------------------- 1. client configuration */

test('OpenRouter is configured with the documented base URL and model defaults', () => {
  assert.equal(openRouter.PROVIDER_NAME, 'OpenRouter');
  assert.equal(openRouter.DEFAULT_BASE_URL, 'https://openrouter.ai/api/v1');
  assert.equal(openRouter.DEFAULT_MODEL, 'openai/gpt-4o-mini');
  assert.equal(openRouter.chatCompletionsUrl(), 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(openRouter.embeddingsUrl(), 'https://openrouter.ai/api/v1/embeddings');
});

test('the base URL comes from the environment and tolerates a trailing slash', () => {
  const previous = process.env.OPENROUTER_BASE_URL;
  process.env.OPENROUTER_BASE_URL = 'https://proxy.example.com/api/v1/';

  try {
    assert.equal(openRouter.baseUrl(), 'https://proxy.example.com/api/v1');
    assert.equal(openRouter.chatCompletionsUrl(), 'https://proxy.example.com/api/v1/chat/completions');
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_BASE_URL;
    else process.env.OPENROUTER_BASE_URL = previous;
  }
});

test('the API key is read from the environment and never hardcoded', () => {
  const source = require('fs').readFileSync(require.resolve('../server/services/openRouter.js'), 'utf8');

  assert.ok(source.includes('process.env.OPENROUTER_API_KEY'));
  assert.ok(!/sk-or-[A-Za-z0-9]/.test(source), 'no key literal may appear in the source');
  assert.equal(openRouter.apiKey(), TEST_KEY);
});

test('the model is read from the environment and never hardcoded per agent', () => {
  const previous = process.env.OPENROUTER_MODEL;
  process.env.OPENROUTER_MODEL = 'anthropic/claude-3.5-haiku';

  try {
    assert.equal(llmClient.resolve('analysis').model, 'anthropic/claude-3.5-haiku');
    assert.equal(llmClient.resolve('gap_detection').model, 'anthropic/claude-3.5-haiku');
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = previous;
  }
});

test('a per-agent model override wins over OPENROUTER_MODEL', () => {
  process.env.ANALYSIS_MODEL = 'google/gemini-flash-1.5';

  try {
    assert.equal(llmClient.resolve('analysis').model, 'google/gemini-flash-1.5');
    // The other agent is unaffected.
    assert.notEqual(llmClient.resolve('gap_detection').model, 'google/gemini-flash-1.5');
  } finally {
    delete process.env.ANALYSIS_MODEL;
  }
});

test('every agent reports OpenRouter as its provider', () => {
  const agents = [...llmClient.agentStatus(), ...aiService.agentStatus()];

  assert.equal(agents.length, 5, 'two researcher agents and three paper agents');
  agents.forEach((agent) => {
    assert.equal(agent.provider, 'OpenRouter', `${agent.agent} should route through OpenRouter`);
    assert.equal(agent.configured, true);
  });
});

test('request headers carry the bearer token and the optional attribution headers', () => {
  process.env.OPENROUTER_SITE_URL = 'http://localhost:3000';
  process.env.OPENROUTER_APP_NAME = 'ResearchAI';

  try {
    const headers = openRouter.headers();
    assert.equal(headers.Authorization, `Bearer ${TEST_KEY}`);
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers['HTTP-Referer'], 'http://localhost:3000');
    assert.equal(headers['X-Title'], 'ResearchAI');
  } finally {
    delete process.env.OPENROUTER_SITE_URL;
    delete process.env.OPENROUTER_APP_NAME;
  }
});

test('attribution headers are omitted when not configured', () => {
  const headers = openRouter.headers();
  assert.ok(!('HTTP-Referer' in headers));
  assert.ok(!('X-Title' in headers));
});

test('a model id missing its vendor prefix is detected', () => {
  assert.equal(openRouter.looksUnprefixed('gpt-4o-mini'), true);
  assert.equal(openRouter.looksUnprefixed('openai/gpt-4o-mini'), false);
});

/** -------------------------------------------- 2. missing OPENROUTER_API_KEY */

test('with no OPENROUTER_API_KEY every agent reports unavailable', async () => {
  await withKey(null, () => {
    assert.equal(openRouter.isConfigured(), false);
    assert.equal(llmClient.isAgentConfigured('analysis'), false);
    assert.equal(llmClient.isAgentConfigured('gap_detection'), false);
    assert.equal(aiService.isConfigured(), false);

    llmClient.agentStatus().forEach((agent) => assert.equal(agent.configured, false));
  });
});

test('with no key /api/health still responds and reports the gateway', async () => {
  await withKey(null, async () => {
    const { status, body } = await app.request('/api/health');

    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.llm.provider, 'OpenRouter');
    assert.equal(body.llm.base_url, 'https://openrouter.ai/api/v1');
    assert.equal(body.llm.configured, false);
    assert.equal(body.analysis_available, false);
  });
});

test('with no key analysis returns 503 and never invents a result', async () => {
  await withKey(null, async () => {
    await withMock(mockProviders(), async (mock) => {
      const { status, body } = await analyze();

      assert.equal(status, 503);
      assert.equal(body.error.code, 'LLM_NOT_CONFIGURED');
      assert.equal(mock.callsMatching(LLM).length, 0, 'no request should be attempted without a key');
      assert.ok(!('analysis' in body));
    });
  });
});

test('with no key gap detection returns 503', async () => {
  await withKey(null, async () => {
    await withMock(mockProviders(), async () => {
      const { status, body } = await app.request('/api/researchers/s2:1751762/gaps', {
        method: 'POST',
        body: JSON.stringify({})
      });

      assert.equal(status, 503);
      assert.equal(body.error.code, 'LLM_NOT_CONFIGURED');
    });
  });
});

test('with no key researcher search, papers and the graph all still work', async () => {
  await withKey(null, async () => {
    await withMock(mockProviders(), async (mock) => {
      const search = await app.request('/api/researchers/search?q=Test%20Author');
      assert.equal(search.status, 200);
      assert.equal(search.body.count, 2);

      const papers = await app.request('/api/researchers/s2:1751762/papers');
      assert.equal(papers.status, 200);
      assert.equal(papers.body.count, 3);

      const graph = await app.request('/api/researchers/s2:1751762/graph');
      assert.equal(graph.status, 200);
      assert.ok(graph.body.summary.node_count > 0);

      assert.equal(mock.callsMatching(LLM).length, 0, 'none of these should need a model');
    });
  });
});

test('with no key the paper agents fall back to labelled demo text', async () => {
  await withKey(null, async () => {
    const { status, body } = await app.request('/api/ai', {
      method: 'POST',
      body: JSON.stringify({ type: 'summary', title: 'A paper', abstract: 'An abstract.' })
    });

    assert.equal(status, 200);
    assert.equal(body.demoMode, true);
    assert.equal(body.provider, 'OpenRouter');
    assert.ok(body.text.includes('Demo Mode'), 'demo output must say that it is demo output');
  });
});

/** ------------------------------------------------- 3. successful request */

test('a successful analysis sends an OpenAI-shaped request to OpenRouter', async () => {
  const mock = mockProviders().on(LLM, chatCompletion(fixtures.VALID_ANALYSIS_OUTPUT));

  await withMock(mock, async () => {
    const { status, body } = await analyze();

    assert.equal(status, 200);
    assert.equal(body.analysis.meta.provider, 'OpenRouter');
    assert.equal(body.analysis.meta.model, 'openai/gpt-4o-mini');
    assert.ok(body.analysis.research_themes.length > 0);

    const [call] = mock.callsMatching(LLM);
    assert.ok(call, 'the model should have been called');

    // Correct endpoint.
    assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(call.init.method, 'POST');

    // Correct credentials, taken from the environment.
    assert.equal(call.init.headers.Authorization, `Bearer ${TEST_KEY}`);

    // Correct body: the model from config, and OpenAI-compatible messages.
    const sent = JSON.parse(call.init.body);
    assert.equal(sent.model, 'openai/gpt-4o-mini');
    assert.ok(Array.isArray(sent.messages));
    assert.equal(sent.messages[0].role, 'system');
    assert.equal(sent.messages[1].role, 'user');
    assert.deepEqual(sent.response_format, { type: 'json_object' });
  });
});

test('the request model follows OPENROUTER_MODEL rather than a hardcoded value', async () => {
  const previous = process.env.OPENROUTER_MODEL;
  process.env.OPENROUTER_MODEL = 'meta-llama/llama-3.1-70b-instruct';

  const mock = mockProviders().on(LLM, chatCompletion(fixtures.VALID_ANALYSIS_OUTPUT));

  try {
    await withMock(mock, async () => {
      const { status, body } = await analyze();

      assert.equal(status, 200);
      assert.equal(body.analysis.meta.model, 'meta-llama/llama-3.1-70b-instruct');

      const sent = JSON.parse(mock.callsMatching(LLM)[0].init.body);
      assert.equal(sent.model, 'meta-llama/llama-3.1-70b-instruct');
    });
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = previous;
  }
});

test('the paper agents also call OpenRouter', async () => {
  const mock = new MockFetch().on(LLM, chatCompletion('A plain text summary.'));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/ai', {
      method: 'POST',
      body: JSON.stringify({ type: 'summary', title: 'A paper', abstract: 'An abstract.' })
    });

    assert.equal(status, 200);
    assert.equal(body.demoMode, false);
    assert.equal(body.provider, 'OpenRouter');
    assert.equal(body.model, 'openai/gpt-4o-mini');
    assert.equal(mock.callsMatching(LLM)[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  });
});

/** ----------------------------------------------------- 4. provider failure */

test('an OpenRouter 500 becomes 502 upstream provider failure', async () => {
  const mock = mockProviders().on(LLM, errorResponse(500, { error: { message: 'internal upstream failure' } }));

  await withMock(mock, async () => {
    const { status, body } = await analyze();

    assert.equal(status, 502);
    assert.equal(body.error.code, 'LLM_UNAVAILABLE');
  });
});

test('an OpenRouter 401 becomes 502 rather than surfacing the credential problem', async () => {
  const mock = mockProviders().on(LLM, errorResponse(401, { error: { message: 'No auth credentials found' } }));

  await withMock(mock, async () => {
    const { status, body } = await analyze();

    assert.equal(status, 502);
    assert.equal(body.error.code, 'LLM_UNAVAILABLE');
  });
});

test('an unreachable OpenRouter becomes 502', async () => {
  const mock = mockProviders().on(LLM, () => networkRejection('getaddrinfo ENOTFOUND openrouter.ai'));

  await withMock(mock, async () => {
    const { status, body } = await analyze();

    assert.equal(status, 502);
    assert.equal(body.error.code, 'LLM_UNAVAILABLE');
  });
});

/** --------------------------------------------------------- 5. rate limit */

test('an OpenRouter 429 becomes 429 upstream rate limit', async () => {
  const mock = mockProviders().on(LLM, errorResponse(429, { error: { message: 'rate limit exceeded' } }));

  await withMock(mock, async () => {
    const { status, body } = await analyze();

    assert.equal(status, 429);
    assert.equal(body.error.code, 'PROVIDER_RATE_LIMITED');
  });
});

/** ------------------------------------------------------------ 6. timeout */

test('a client-side timeout becomes 504', async () => {
  const mock = mockProviders().on(LLM, () => timeoutRejection());

  await withMock(mock, async () => {
    const { status, body } = await analyze();

    assert.equal(status, 504);
    assert.equal(body.error.code, 'LLM_TIMEOUT');
  });
});

test('an OpenRouter 504 from a stalled upstream model also becomes 504', async () => {
  const mock = mockProviders().on(LLM, errorResponse(504, { error: { message: 'upstream timed out' } }));

  await withMock(mock, async () => {
    const { status, body } = await analyze();

    assert.equal(status, 504);
    assert.equal(body.error.code, 'LLM_TIMEOUT');
  });
});

test('an OpenRouter 408 is treated as a timeout, not a generic failure', async () => {
  const mock = mockProviders().on(LLM, errorResponse(408));

  await withMock(mock, async () => {
    const { status, body } = await analyze();

    assert.equal(status, 504);
    assert.equal(body.error.code, 'LLM_TIMEOUT');
  });
});

/** -------------------------------------------- 7. invalid/malformed response */

test('non-JSON model output is retried once, then accepted when valid', async () => {
  let calls = 0;
  const mock = mockProviders().on(LLM, () => {
    calls += 1;
    return calls === 1
      ? chatCompletion('Here are the themes I found, written as prose.')
      : chatCompletion(fixtures.VALID_ANALYSIS_OUTPUT);
  });

  await withMock(mock, async () => {
    const { status, body } = await analyze();

    assert.equal(status, 200);
    assert.equal(calls, 2);
    assert.equal(body.analysis.meta.attempts, 2);
  });
});

test('output that never validates returns 502 rather than partial data', async () => {
  const mock = mockProviders().on(LLM, chatCompletion({ research_themes: 'not an array' }));

  await withMock(mock, async () => {
    const { status, body } = await analyze();

    assert.equal(status, 502);
    assert.equal(body.error.code, 'LLM_INVALID_OUTPUT');
  });
});

test('an empty message from OpenRouter returns 502', async () => {
  const mock = mockProviders().on(LLM, jsonResponse({ choices: [{ message: { content: '   ' } }] }));

  await withMock(mock, async () => {
    const { status, body } = await analyze();

    assert.equal(status, 502);
    assert.equal(body.error.code, 'LLM_INVALID_OUTPUT');
  });
});

test('a response with no choices array returns 502', async () => {
  const mock = mockProviders().on(LLM, jsonResponse({ id: 'gen-123', model: 'openai/gpt-4o-mini' }));

  await withMock(mock, async () => {
    const { status, body } = await analyze();

    assert.equal(status, 502);
    assert.equal(body.error.code, 'LLM_INVALID_OUTPUT');
  });
});

test('JSON wrapped in a markdown fence is recovered without a retry', async () => {
  let calls = 0;
  const mock = mockProviders().on(LLM, () => {
    calls += 1;
    return chatCompletion('```json\n' + JSON.stringify(fixtures.VALID_ANALYSIS_OUTPUT) + '\n```');
  });

  await withMock(mock, async () => {
    const { status, body } = await analyze();

    assert.equal(status, 200);
    assert.equal(calls, 1, 'a fenced block is recoverable and should not cost a retry');
    assert.equal(body.analysis.meta.attempts, 1);
  });
});

/** ------------------------------------------------------- key confidentiality */

test('the API key never appears in a successful response', async () => {
  const mock = mockProviders().on(LLM, chatCompletion(fixtures.VALID_ANALYSIS_OUTPUT));

  await withMock(mock, async () => {
    const { body } = await analyze();
    assert.ok(!JSON.stringify(body).includes(TEST_KEY));
  });
});

test('the API key never appears in an error response, even when upstream echoes it', async () => {
  const mock = mockProviders().on(
    LLM,
    errorResponse(500, { error: { message: `invalid key ${TEST_KEY}`, metadata: { key: TEST_KEY } } })
  );

  await withMock(mock, async () => {
    const { status, body } = await analyze();

    assert.equal(status, 502);
    const serialised = JSON.stringify(body);
    assert.ok(!serialised.includes(TEST_KEY), 'the upstream body must not be forwarded');
    assert.ok(!serialised.includes('openrouter.ai'));
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'request_id']);
  });
});

test('/api/health reports the gateway but never the key', async () => {
  const { status, body } = await app.request('/api/health');

  assert.equal(status, 200);
  assert.equal(body.llm.provider, 'OpenRouter');
  assert.equal(body.llm.configured, true);
  assert.equal(body.llm.default_model, 'openai/gpt-4o-mini');
  assert.ok(!JSON.stringify(body).includes(TEST_KEY));
});
