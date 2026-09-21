/**
 * API tests for the researcher endpoints.
 *
 * Every external call is mocked. No test depends on Semantic Scholar, OpenAlex
 * or a language model being reachable, and an unmocked call is an error rather
 * than a slow pass.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { MockFetch, jsonResponse, errorResponse, timeoutRejection, networkRejection, chatCompletion } =
  require('./helpers/mockFetch');
const fixtures = require('./helpers/fixtures');
const { startTestServer, resetCache } = require('./helpers/server');

// Set before the app is required, so the analysis agents count as configured.
process.env.OPENROUTER_API_KEY = 'test-key-not-real';
process.env.OPENROUTER_MODEL = 'openai/gpt-4o-mini';
// Retrieval must not depend on an embeddings endpoint being reachable.
process.env.EMBEDDINGS_PROVIDER = 'local';

const S2 = /api\.semanticscholar\.org/;
const OPENALEX = /api\.openalex\.org/;
const LLM = /chat\/completions/;

let app;

test.before(async () => {
  app = await startTestServer();
});

test.after(async () => {
  await app.close();
});

/** Installs a mock with the happy-path provider responses already wired. */
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

/** ------------------------------------------------------------------ health */

test('GET /api/health reports providers and agent configuration without leaking keys', async () => {
  const { status, body } = await app.request('/api/health');

  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.deepEqual(
    body.providers.map((provider) => provider.source).sort(),
    ['openalex', 'semantic_scholar']
  );
  assert.equal(body.agents.length, 2);
  assert.ok(body.agents.every((agent) => agent.configured === true));

  const serialised = JSON.stringify(body);
  assert.ok(!serialised.includes('test-key-not-real'), 'health must never echo an API key');
});

/** ------------------------------------------------------------------ search */

test('GET /api/researchers/search returns normalized researchers', async () => {
  await withMock(mockProviders(), async () => {
    const { status, body } = await app.request('/api/researchers/search?q=Test%20Author&limit=2');

    assert.equal(status, 200);
    assert.equal(body.count, 2);
    assert.equal(body.source, 'semantic_scholar');

    const [first] = body.researchers;
    assert.equal(first.id, 's2:1751762');
    assert.equal(first.name, 'Test Author');
    assert.equal(first.h_index, 4);
    assert.deepEqual(first.affiliations, ['Test University']);
    assert.equal(body.query_understanding.intent, 'researcher_search');
  });
});

test('GET /api/researchers/search rejects a missing query with 400', async () => {
  const { status, body } = await app.request('/api/researchers/search');

  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_QUERY');
  assert.ok(body.error.request_id);
});

test('GET /api/researchers/search rejects an out-of-range limit with 400', async () => {
  const { status, body } = await app.request('/api/researchers/search?q=x&limit=500');

  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_PARAMETER');
});

test('GET /api/researchers/search returns 200 with an empty list when nobody matches', async () => {
  const mock = new MockFetch()
    .on(/author\/search/, jsonResponse({ total: 0, offset: 0, data: [] }))
    .on(/openalex\.org\/authors/, jsonResponse({ meta: { count: 0 }, results: [] }));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/search?q=Nobody%20Here');

    assert.equal(status, 200);
    assert.equal(body.count, 0);
    assert.deepEqual(body.researchers, []);
  });
});

test('search falls back to the secondary provider when the primary is rate limited', async () => {
  const mock = new MockFetch()
    .on(/author\/search/, errorResponse(429))
    .on(/openalex\.org\/authors/, jsonResponse(fixtures.OPENALEX_AUTHORS));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/search?q=Test%20Author');

    assert.equal(status, 200);
    assert.equal(body.source, 'openalex');
    assert.equal(body.researchers[0].id, 'openalex:A5086198262');
    // Notes are shown to the user, so they name the provider readably.
    assert.ok(
      body.provider_notes.some((note) => note.includes('Semantic Scholar')),
      'the fallback must be reported, not silent'
    );
    assert.ok(
      body.provider_notes.some((note) => note.includes('rate limited')),
      'the reason for the fallback should be stated'
    );
  });
});

test('search returns 429 when every provider is rate limited', async () => {
  const mock = new MockFetch()
    .on(/author\/search/, errorResponse(429))
    .on(/openalex\.org\/authors/, errorResponse(429));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/search?q=Test');

    assert.equal(status, 429);
    assert.equal(body.error.code, 'PROVIDER_RATE_LIMITED');
  });
});

test('search returns 504 when every provider times out', async () => {
  const mock = new MockFetch()
    .on(/author\/search/, () => timeoutRejection())
    .on(/openalex\.org\/authors/, () => timeoutRejection());

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/search?q=Test');

    assert.equal(status, 504);
    assert.equal(body.error.code, 'PROVIDER_TIMEOUT');
  });
});

test('search returns 502 when the provider is unreachable', async () => {
  const mock = new MockFetch()
    .on(/author\/search/, () => networkRejection())
    .on(/openalex\.org\/authors/, () => networkRejection());

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/search?q=Test');

    assert.equal(status, 502);
    assert.equal(body.error.code, 'RESEARCH_PROVIDER_UNAVAILABLE');
  });
});

test('search returns 502 when the provider response is malformed', async () => {
  const mock = new MockFetch()
    .on(/author\/search/, jsonResponse({ unexpected: 'shape' }))
    .on(/openalex\.org\/authors/, jsonResponse({ also: 'wrong' }));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/search?q=Test');

    assert.equal(status, 502);
    assert.equal(body.error.code, 'PROVIDER_MALFORMED_RESPONSE');
  });
});

/** ------------------------------------------------------- researcher detail */

test('GET /api/researchers/:id returns a normalized researcher', async () => {
  await withMock(mockProviders(), async () => {
    const { status, body } = await app.request('/api/researchers/s2:1751762');

    assert.equal(status, 200);
    assert.equal(body.researcher.id, 's2:1751762');
    assert.equal(body.researcher.citation_count, 120);
    assert.equal(body.researcher.source, 'semantic_scholar');
  });
});

test('GET /api/researchers/:id returns 404 when the provider has no such author', async () => {
  const mock = new MockFetch().on(/author\//, errorResponse(404, { error: 'not found' }));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/s2:0000000');

    assert.equal(status, 404);
    assert.equal(body.error.code, 'RESEARCHER_NOT_FOUND');
  });
});

test('GET /api/researchers/:id rejects an unparseable id before calling a provider', async () => {
  const mock = new MockFetch();

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/not-a-valid-id');

    assert.equal(status, 400);
    assert.equal(body.error.code, 'INVALID_RESEARCHER_ID');
    assert.equal(mock.calls.length, 0, 'a malformed id must never reach a provider');
  });
});

test('a researcher id cannot be used to reshape the provider URL', async () => {
  const mock = new MockFetch();

  await withMock(mock, async () => {
    const { status } = await app.request(`/api/researchers/${encodeURIComponent('s2:../../evil')}`);

    assert.equal(status, 400);
    assert.equal(mock.calls.length, 0);
  });
});

/** ------------------------------------------------------------------ papers */

test('GET /api/researchers/:id/papers returns papers enriched from OpenAlex', async () => {
  await withMock(mockProviders(), async (mock) => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/papers?limit=10');

    assert.equal(status, 200);
    assert.equal(body.count, 3);

    const first = body.papers.find((paper) => paper.id === 's2:paper-one');
    assert.equal(first.title, 'Graph Retrieval for Scientific Question Answering');
    assert.equal(first.doi, 'https://doi.org/10.1000/one');
    assert.equal(first.open_access_url, 'https://example.org/one.pdf');
    // Topic taxonomy comes from OpenAlex, merged onto the Semantic Scholar record.
    assert.deepEqual(first.topics, ['Knowledge Graphs and Retrieval']);
    assert.equal(first.enriched_from, 'openalex');
    assert.equal(body.enrichment.papers_enriched, 2);

    // A CLOSED openAccessPdf has an empty url string, which must become null.
    const second = body.papers.find((paper) => paper.id === 's2:paper-two');
    assert.equal(second.open_access_url, null);

    assert.ok(mock.callsMatching(OPENALEX).length > 0, 'enrichment should call OpenAlex');
  });
});

test('paper retrieval still succeeds when the enrichment source fails', async () => {
  const mock = new MockFetch()
    .on(/author\/1751762\/papers/, jsonResponse(fixtures.S2_AUTHOR_PAPERS))
    .on(/author\/1751762(\?|$)/, jsonResponse(fixtures.S2_AUTHOR))
    .on(OPENALEX, errorResponse(500));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/papers');

    assert.equal(status, 200, 'a failed enrichment must not fail the request');
    assert.equal(body.count, 3);
    assert.equal(body.enrichment.papers_enriched, 0);
  });
});

test('GET /api/researchers/:id/papers applies a year filter', async () => {
  await withMock(mockProviders(), async () => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/papers?year_from=2024');

    assert.equal(status, 200);
    assert.equal(body.year_filter_applied, 'client');
    assert.ok(body.papers.every((paper) => paper.year >= 2024));
    assert.equal(body.papers.length, 1);
  });
});

test('GET /api/researchers/:id/papers rejects an inverted year range', async () => {
  const { status, body } = await app.request('/api/researchers/s2:1751762/papers?year_from=2024&year_to=2020');

  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_PARAMETER');
});

test('GET /api/researchers/:id/papers rejects a non-numeric year', async () => {
  const { status, body } = await app.request('/api/researchers/s2:1751762/papers?year_from=recent');

  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_PARAMETER');
});

/** ---------------------------------------------------------------- analysis */

test('POST /api/researchers/:id/analyze returns structured, evidence-backed analysis', async () => {
  const mock = mockProviders().on(LLM, chatCompletion(fixtures.VALID_ANALYSIS_OUTPUT));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/analyze', {
      method: 'POST',
      body: JSON.stringify({})
    });

    assert.equal(status, 200);

    const { analysis } = body;
    assert.equal(analysis.researcher_id, 's2:1751762');
    assert.equal(analysis.research_themes.length, 1);
    assert.equal(analysis.methods[0].name, 'Dense passage retrieval');

    // Every returned item must carry verifiable evidence.
    const items = [
      ...analysis.research_themes, ...analysis.topics, ...analysis.methods,
      ...analysis.datasets, ...analysis.domains, ...analysis.limitations,
      ...analysis.recurring_patterns
    ];
    assert.ok(items.length > 0);
    items.forEach((item) => {
      assert.ok(item.evidence.length > 0, `"${item.name}" must carry evidence`);
      item.evidence.forEach((evidence) => {
        assert.ok(evidence.paper_id.startsWith('s2:'));
        assert.ok(evidence.excerpt.length > 0);
        assert.equal(evidence.source, 'semantic_scholar');
      });
    });

    // The paper with no abstract cannot be analysed and must be excluded.
    assert.ok(!body.papers_analyzed.some((paper) => paper.id === 's2:paper-three'));
    assert.equal(body.corpus.skipped_without_abstract, 1);
    assert.equal(body.retrieval.embedder, 'local-lexical');
  });
});

test('analysis drops items attributed to papers that were never retrieved', async () => {
  const polluted = {
    ...fixtures.VALID_ANALYSIS_OUTPUT,
    methods: [
      { name: 'Real method', supporting_papers: ['s2:paper-one'] },
      { name: 'Fabricated method', supporting_papers: ['s2:never-retrieved'] }
    ]
  };
  const mock = mockProviders().on(LLM, chatCompletion(polluted));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/analyze', {
      method: 'POST',
      body: JSON.stringify({})
    });

    assert.equal(status, 200);

    const names = body.analysis.methods.map((method) => method.name);
    assert.deepEqual(names, ['Real method']);
    assert.ok(body.analysis.meta.items_dropped_unverifiable >= 1);
  });
});

test('recurring patterns supported by a single paper are dropped', async () => {
  const output = {
    ...fixtures.VALID_ANALYSIS_OUTPUT,
    recurring_patterns: [{ name: 'Not actually recurring', description: 'x', supporting_papers: ['s2:paper-one'] }]
  };
  const mock = mockProviders().on(LLM, chatCompletion(output));

  await withMock(mock, async () => {
    const { body } = await app.request('/api/researchers/s2:1751762/analyze', {
      method: 'POST',
      body: JSON.stringify({})
    });

    assert.deepEqual(body.analysis.recurring_patterns, []);
  });
});

test('malformed model output is retried once, then accepted when valid', async () => {
  let call = 0;
  const mock = mockProviders().on(LLM, () => {
    call += 1;
    return call === 1
      ? chatCompletion('this is prose, not JSON at all')
      : chatCompletion(fixtures.VALID_ANALYSIS_OUTPUT);
  });

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/analyze', {
      method: 'POST',
      body: JSON.stringify({})
    });

    assert.equal(status, 200);
    assert.equal(call, 2, 'the agent should retry exactly once');
    assert.equal(body.analysis.meta.attempts, 2);
  });
});

test('model output that never validates returns 502 rather than partial data', async () => {
  const mock = mockProviders().on(LLM, chatCompletion({ research_themes: 'not an array' }));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/analyze', {
      method: 'POST',
      body: JSON.stringify({})
    });

    assert.equal(status, 502);
    assert.equal(body.error.code, 'LLM_INVALID_OUTPUT');
  });
});

test('a model timeout returns 504', async () => {
  const mock = mockProviders().on(LLM, () => timeoutRejection());

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/analyze', {
      method: 'POST',
      body: JSON.stringify({})
    });

    assert.equal(status, 504);
    assert.equal(body.error.code, 'LLM_TIMEOUT');
  });
});

test('analysis returns 422 when no retrieved paper has an abstract', async () => {
  const noAbstracts = {
    offset: 0,
    next: null,
    data: fixtures.S2_AUTHOR_PAPERS.data.map((paper) => ({ ...paper, abstract: null }))
  };
  const mock = mockProviders().prepend(/author\/1751762\/papers/, jsonResponse(noAbstracts));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/analyze', {
      method: 'POST',
      body: JSON.stringify({})
    });

    assert.equal(status, 422);
    assert.equal(body.error.code, 'NO_ABSTRACTS_AVAILABLE');
  });
});

test('analysis returns 422 when the researcher has no papers', async () => {
  const mock = mockProviders().prepend(/author\/1751762\/papers/, jsonResponse({ offset: 0, data: [] }));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/analyze', {
      method: 'POST',
      body: JSON.stringify({})
    });

    assert.equal(status, 422);
    assert.equal(body.error.code, 'NO_PAPERS_AVAILABLE');
  });
});

test('analysis rejects a malformed JSON body with 422', async () => {
  const { status, body } = await app.request('/api/researchers/s2:1751762/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not valid json'
  });

  assert.equal(status, 422);
  assert.equal(body.error.code, 'VALIDATION_FAILED');
});

test('analysis rejects an out-of-range max_papers with 400', async () => {
  const { status, body } = await app.request('/api/researchers/s2:1751762/analyze', {
    method: 'POST',
    body: JSON.stringify({ max_papers: 500 })
  });

  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_PARAMETER');
});

/** -------------------------------------------------------------------- gaps */

test('POST /api/researchers/:id/gaps returns evidence-backed candidate gaps', async () => {
  const mock = mockProviders().on(LLM, (url, init) => {
    const body = JSON.parse(init.body);
    const isGapAgent = body.messages[0].content.includes('Gap Detection Agent');
    return chatCompletion(isGapAgent ? fixtures.GAP_OUTPUT_WITH_ONE_HALLUCINATED : fixtures.VALID_ANALYSIS_OUTPUT);
  });

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/gaps', {
      method: 'POST',
      body: JSON.stringify({})
    });

    assert.equal(status, 200);

    // The fabricated gap cites only non-existent papers and must be removed.
    assert.equal(body.gaps.length, 1);
    assert.equal(body.gaps[0].title, 'Cross-domain evaluation of hybrid retrieval');
    assert.equal(body.meta.gaps_dropped_unverifiable, 1);

    body.gaps.forEach((gap) => {
      assert.ok(gap.evidence.length >= 2, 'a gap must cite at least two papers');
      assert.ok(gap.confidence > 0 && gap.confidence <= 0.9);
      gap.evidence.forEach((evidence) => {
        assert.ok(['s2:paper-one', 's2:paper-two'].includes(evidence.paper_id));
      });
    });

    assert.ok(body.disclaimer.includes('not evidence that the gap is unaddressed'));
  });
});

test('gaps reports insufficient evidence rather than inventing one', async () => {
  const mock = mockProviders().on(LLM, (url, init) => {
    const requestBody = JSON.parse(init.body);
    const isGapAgent = requestBody.messages[0].content.includes('Gap Detection Agent');
    return chatCompletion(isGapAgent ? { gaps: [] } : fixtures.VALID_ANALYSIS_OUTPUT);
  });

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/gaps', {
      method: 'POST',
      body: JSON.stringify({})
    });

    assert.equal(status, 200);
    assert.deepEqual(body.gaps, []);
    assert.equal(body.notes, 'Insufficient evidence.');
  });
});

/** ------------------------------------------------------------------- graph */

test('GET /api/researchers/:id/graph builds a graph from provider metadata alone', async () => {
  await withMock(mockProviders(), async (mock) => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/graph');

    assert.equal(status, 200);
    assert.ok(body.summary.node_count > 0);
    assert.equal(body.summary.llm_derived_nodes, 0);
    assert.equal(mock.callsMatching(LLM).length, 0, 'the base graph must not call a model');

    const types = new Set(body.nodes.map((node) => node.type));
    assert.ok(types.has('Researcher'));
    assert.ok(types.has('Paper'));
    assert.ok(types.has('Topic'));
    assert.ok(types.has('Institution'));

    const edgeTypes = new Set(body.edges.map((edge) => edge.type));
    assert.ok(edgeTypes.has('AUTHORED'));
    assert.ok(edgeTypes.has('HAS_TOPIC'));
    assert.ok(edgeTypes.has('AFFILIATED_WITH'));

    assert.ok(body.nodes.every((node) => node.provenance === 'provider'));
  });
});

test('graph adds method and dataset nodes when analysis is requested', async () => {
  const mock = mockProviders().on(LLM, chatCompletion(fixtures.VALID_ANALYSIS_OUTPUT));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/graph?include_analysis=true');

    assert.equal(status, 200);
    assert.ok(body.summary.llm_derived_nodes > 0);

    const methodNode = body.nodes.find((node) => node.type === 'Method');
    assert.ok(methodNode, 'an analysis overlay should contribute Method nodes');
    assert.equal(methodNode.provenance, 'llm');
  });
});

test('graph overlay nodes are connected to the papers they cite', async () => {
  // Regression: the graph slices papers in provider order while the analysis
  // ranks them by citations, so an overlay node could name a paper the graph
  // had dropped and end up rendered with no edges at all.
  const mock = mockProviders().on(LLM, chatCompletion(fixtures.VALID_ANALYSIS_OUTPUT));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/graph?include_analysis=true');

    assert.equal(status, 200);

    const llmNodes = body.nodes.filter((node) => node.provenance === 'llm');
    assert.ok(llmNodes.length > 0);

    llmNodes.forEach((node) => {
      const degree = body.edges.filter((edge) => edge.from === node.id || edge.to === node.id).length;
      assert.ok(degree > 0, `"${node.label}" was added to the graph with no edges`);
    });

    const edgeTypes = new Set(body.edges.map((edge) => edge.type));
    assert.ok(edgeTypes.has('USES_METHOD'));
    assert.ok(edgeTypes.has('USES_DATASET'));
  });
});

test('graph still renders when the analysis overlay fails', async () => {
  const mock = mockProviders().on(LLM, errorResponse(500));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/graph?include_analysis=true');

    assert.equal(status, 200, 'a failed overlay must degrade, not fail the request');
    assert.equal(body.summary.llm_derived_nodes, 0);
    assert.ok(body.provenance.note.includes('unavailable'));
  });
});

test('graph returns 422 when the researcher has no papers', async () => {
  const mock = mockProviders().prepend(/author\/1751762\/papers/, jsonResponse({ offset: 0, data: [] }));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/graph');

    assert.equal(status, 422);
    assert.equal(body.error.code, 'NO_PAPERS_AVAILABLE');
  });
});

/** --------------------------------------------------------------- behaviour */

test('provider responses are cached within a session', async () => {
  await withMock(mockProviders(), async (mock) => {
    await app.request('/api/researchers/s2:1751762');
    const afterFirst = mock.callsMatching(/author\/1751762/).length;

    await app.request('/api/researchers/s2:1751762');
    const afterSecond = mock.callsMatching(/author\/1751762/).length;

    assert.equal(afterFirst, afterSecond, 'the second request should be served from cache');
  });
});

test('error responses never leak provider detail or keys', async () => {
  const mock = new MockFetch()
    .on(/author\/search/, errorResponse(500, { message: 'secret internal detail', key: 'test-key-not-real' }))
    .on(/openalex\.org\/authors/, errorResponse(500, { message: 'secret internal detail' }));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/search?q=Test');

    assert.equal(status, 502);
    const serialised = JSON.stringify(body);
    assert.ok(!serialised.includes('secret internal detail'));
    assert.ok(!serialised.includes('test-key-not-real'));
    assert.ok(!serialised.includes('semanticscholar.org'));
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'request_id']);
  });
});

test('unknown API routes return a JSON 404, not the HTML page', async () => {
  const { status, body } = await app.request('/api/does-not-exist');

  assert.equal(status, 404);
  assert.equal(body.error.code, 'ENDPOINT_NOT_FOUND');
});
