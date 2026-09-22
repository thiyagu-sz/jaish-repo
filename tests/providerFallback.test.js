/**
 * Scholarly provider rate limiting and fallback.
 *
 * Covers what happens when Semantic Scholar returns 429: that it is recognised
 * as a rate limit rather than a generic failure, that Retry-After is honoured,
 * that OpenAlex takes over for both search and paper retrieval, and that the
 * application never hammers a provider that told it to back off.
 *
 * No live API is contacted. An unmatched request throws.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { MockFetch, jsonResponse, errorResponse, rateLimitedResponse, networkRejection } =
  require('./helpers/mockFetch');
const fixtures = require('./helpers/fixtures');
const { startTestServer, resetCache } = require('./helpers/server');

process.env.EMBEDDINGS_PROVIDER = 'local';
// Short cooldowns keep the suite fast while still exercising the real logic.
process.env.PROVIDER_COOLDOWN_MS = '400';
process.env.PROVIDER_MAX_RETRY_WAIT_MS = '150';
process.env.PROVIDER_RETRIES = '1';

const providerHealth = require('../server/lib/providerHealth');

const S2 = /api\.semanticscholar\.org/;
const OPENALEX = /api\.openalex\.org/;
const S2_PAPERS = /author\/1751762\/papers/;

let app;

test.before(async () => {
  app = await startTestServer();
});

test.after(async () => {
  await app.close();
});

/** OpenAlex author + works, for when it has to serve as the fallback. */
const OPENALEX_AUTHOR_WORKS = {
  meta: { count: 2, page: 1, per_page: 25 },
  results: [
    {
      id: 'https://openalex.org/W1',
      doi: 'https://doi.org/10.1000/one',
      display_name: 'Graph Retrieval for Scientific Question Answering',
      publication_year: 2024,
      publication_date: '2024-03-01',
      cited_by_count: 90,
      referenced_works_count: 40,
      topics: [
        {
          display_name: 'Knowledge Graphs and Retrieval',
          field: { display_name: 'Computer Science' },
          domain: { display_name: 'Physical Sciences' }
        }
      ],
      authorships: [{ author: { display_name: 'Test Author' }, institutions: [{ display_name: 'Test University' }] }],
      abstract_inverted_index: { We: [0], combine: [1], retrieval: [2] }
    },
    {
      id: 'https://openalex.org/W2',
      doi: 'https://doi.org/10.1000/two',
      display_name: 'Benchmarking Retrieval Augmented Generation',
      publication_year: 2023,
      publication_date: '2023-06-01',
      cited_by_count: 45,
      referenced_works_count: 30,
      topics: [],
      authorships: [{ author: { display_name: 'Test Author' }, institutions: [] }],
      abstract_inverted_index: null
    }
  ]
};

function baseMock() {
  return new MockFetch()
    .on(/author\/search/, jsonResponse(fixtures.S2_AUTHOR_SEARCH))
    .on(S2_PAPERS, jsonResponse(fixtures.S2_AUTHOR_PAPERS))
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

/** ------------------------------------ 1. successful Semantic Scholar request */

test('a successful Semantic Scholar search is served by Semantic Scholar alone', async () => {
  await withMock(baseMock(), async (mock) => {
    const { status, body } = await app.request('/api/researchers/search?q=Test%20Author');

    assert.equal(status, 200);
    assert.equal(body.source, 'semantic_scholar');
    assert.equal(body.count, 2);
    assert.equal(body.fallback_used, undefined);
    assert.deepEqual(body.provider_notes, []);

    // No fallback means OpenAlex should not have been asked at all.
    assert.equal(mock.callsMatching(/openalex\.org\/authors/).length, 0);
    assert.equal(providerHealth.isCoolingDown('semantic_scholar'), false);
  });
});

test('a successful paper retrieval reports Semantic Scholar as the server', async () => {
  await withMock(baseMock(), async () => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/papers');

    assert.equal(status, 200);
    assert.equal(body.count, 3);
    assert.equal(body.served_by, 'semantic_scholar');
    assert.equal(body.fallback, null);
  });
});

/** ----------------------------------------------- 2. Semantic Scholar 429 */

test('a Semantic Scholar 429 is recognised as a rate limit, not a generic failure', async () => {
  const mock = new MockFetch()
    .on(/author\/search/, rateLimitedResponse(null))
    .on(/openalex\.org\/authors/, errorResponse(500));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/search?q=Test%20Author');

    // Not a 500: the caller is told this is a rate limit.
    assert.notEqual(status, 500);
    assert.equal(status, 502, 'OpenAlex failing last determines the final code');
    assert.ok(body.error.code);
    assert.ok(!('stack' in body.error), 'no stack trace may be exposed');
  });
});

test('a 429 records a cooldown so the provider is not asked again', async () => {
  const mock = baseMock().prepend(/author\/search/, rateLimitedResponse(null));

  await withMock(mock, async (mock2) => {
    await app.request('/api/researchers/search?q=Test%20Author');
    assert.equal(providerHealth.isCoolingDown('semantic_scholar'), true);

    const callsAfterFirst = mock2.callsMatching(/author\/search/).length;

    // A second search must skip the cooling provider entirely.
    await app.request('/api/researchers/search?q=Another%20Person');

    assert.equal(
      mock2.callsMatching(/author\/search/).length,
      callsAfterFirst,
      'a cooling-down provider must not be contacted again'
    );
  });
});

test('the cooldown expires and the provider is used again', async () => {
  await withMock(baseMock(), async () => {
    providerHealth.markRateLimited('semantic_scholar', 60);
    assert.equal(providerHealth.isCoolingDown('semantic_scholar'), true);

    await providerHealth.sleep(120);

    assert.equal(providerHealth.isCoolingDown('semantic_scholar'), false);
  });
});

test('the application does not crash on a 429 and never returns a generic 500', async () => {
  const mock = baseMock().prepend(S2, rateLimitedResponse(null));

  await withMock(mock, async () => {
    const results = await Promise.all([
      app.request('/api/researchers/search?q=Test%20Author'),
      app.request('/api/researchers/s2:1751762/papers'),
      app.request('/api/health')
    ]);

    results.forEach((result) => {
      assert.notEqual(result.status, 500, 'a rate limit must never surface as an internal error');
    });
    // The process is still serving.
    assert.equal(results[2].status, 200);
  });
});

/** ------------------------------------------------------- 3. Retry-After */

test('Retry-After given in seconds is parsed', () => {
  assert.equal(providerHealth.parseRetryAfter('3'), 3000);
  assert.equal(providerHealth.parseRetryAfter('0'), 0);
  assert.equal(providerHealth.parseRetryAfter(null), null);
  assert.equal(providerHealth.parseRetryAfter('not-a-number'), null);
});

test('Retry-After given as an HTTP date is parsed', () => {
  const inFiveSeconds = new Date(Date.now() + 5000).toUTCString();
  const parsed = providerHealth.parseRetryAfter(inFiveSeconds);

  assert.ok(parsed > 3000 && parsed <= 6000, `expected about 5000ms, got ${parsed}`);

  // A date already in the past means retry now, not a negative wait.
  assert.equal(providerHealth.parseRetryAfter(new Date(Date.now() - 10000).toUTCString()), 0);
});

test('a short Retry-After is waited out and the request is retried once', async () => {
  let attempts = 0;
  const mock = baseMock().prepend(/author\/search/, () => {
    attempts += 1;
    // 0 seconds is short enough to be worth waiting for.
    return attempts === 1 ? rateLimitedResponse(0) : jsonResponse(fixtures.S2_AUTHOR_SEARCH);
  });

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/search?q=Test%20Author');

    assert.equal(status, 200);
    assert.equal(attempts, 2, 'a short Retry-After should be honoured with one retry');
    assert.equal(body.source, 'semantic_scholar');
    assert.equal(providerHealth.isCoolingDown('semantic_scholar'), false);
  });
});

test('a long Retry-After is not waited out; it becomes a cooldown and a fallback', async () => {
  let attempts = 0;
  const mock = baseMock().prepend(/author\/search/, () => {
    attempts += 1;
    return rateLimitedResponse(120); // two minutes
  });

  await withMock(mock, async () => {
    const started = Date.now();
    const { status, body } = await app.request('/api/researchers/search?q=Test%20Author');
    const elapsed = Date.now() - started;

    assert.equal(status, 200);
    assert.equal(attempts, 1, 'a long Retry-After must not be slept through');
    assert.ok(elapsed < 2000, `the request should fail over quickly, took ${elapsed}ms`);
    assert.equal(body.source, 'openalex');
    assert.ok(providerHealth.cooldownRemainingMs('semantic_scholar') > 1000);
  });
});

test('Retry-After is capped so an absurd value cannot disable a provider for ever', () => {
  providerHealth.reset();
  const applied = providerHealth.markRateLimited('semantic_scholar', 24 * 60 * 60 * 1000);

  assert.equal(applied, providerHealth.MAX_COOLDOWN_MS);
  providerHealth.reset();
});

/** -------------------------------------------------- 4. fallback to OpenAlex */

test('researcher search falls back to OpenAlex when Semantic Scholar is rate limited', async () => {
  const mock = baseMock().prepend(/author\/search/, rateLimitedResponse(60));

  await withMock(mock, async (mock2) => {
    const { status, body } = await app.request('/api/researchers/search?q=Test%20Author');

    assert.equal(status, 200);
    assert.equal(body.source, 'openalex');
    assert.equal(body.fallback_used, true);
    assert.equal(body.researchers[0].id, 'openalex:A5086198262');
    assert.ok(body.provider_notes.some((note) => note.includes('Semantic Scholar')));
    assert.ok(body.provider_notes.some((note) => note.includes('rate limited')));
    assert.ok(mock2.callsMatching(/openalex\.org\/authors/).length > 0);
  });
});

test('paper retrieval falls back to OpenAlex for the same person', async () => {
  const mock = baseMock()
    .prepend(/openalex\.org\/works/, jsonResponse(OPENALEX_AUTHOR_WORKS))
    .prepend(S2_PAPERS, rateLimitedResponse(60));

  await withMock(mock, async () => {
    // The profile screen loads the researcher before its publications, which is
    // what tells the fallback who this person is.
    await app.request('/api/researchers/s2:1751762');

    const { status, body } = await app.request('/api/researchers/s2:1751762/papers');

    assert.equal(status, 200);
    assert.equal(body.served_by, 'openalex');
    assert.ok(body.papers.length > 0);

    // The switch is declared, not silent: these papers come from another index.
    assert.equal(body.fallback.from, 'semantic_scholar');
    assert.equal(body.fallback.to, 'openalex');
    assert.equal(body.fallback.reason, 'rate_limited');
    assert.equal(body.fallback.matched_by, 'exact_name');
    assert.equal(body.fallback.matched_researcher.name, 'Test Author');
    assert.ok(body.papers.every((paper) => paper.source === 'openalex'));
  });
});

test('paper fallback prefers an ORCID match over a name match', async () => {
  const s2AuthorWithOrcid = { ...fixtures.S2_AUTHOR, externalIds: { ORCID: '0000-0002-0000-0000' } };

  // Two OpenAlex candidates share the name; only one shares the ORCID.
  const candidates = {
    meta: { count: 2, page: 1, per_page: 10 },
    results: [
      { ...fixtures.OPENALEX_AUTHORS.results[0], id: 'https://openalex.org/A_WRONG', orcid: null },
      { ...fixtures.OPENALEX_AUTHORS.results[0], id: 'https://openalex.org/A_RIGHT' }
    ]
  };

  const mock = baseMock()
    .prepend(/openalex\.org\/works/, jsonResponse(OPENALEX_AUTHOR_WORKS))
    .prepend(/openalex\.org\/authors/, jsonResponse(candidates))
    .prepend(/author\/1751762(\?|$)/, jsonResponse(s2AuthorWithOrcid))
    .prepend(S2_PAPERS, rateLimitedResponse(60));

  await withMock(mock, async () => {
    await app.request('/api/researchers/s2:1751762');

    const { status, body } = await app.request('/api/researchers/s2:1751762/papers');

    assert.equal(status, 200);
    assert.equal(body.fallback.matched_by, 'orcid');
    assert.equal(body.fallback.matched_researcher.id, 'openalex:A_RIGHT');
  });
});

test('paper fallback is refused when the identity cannot be established', async () => {
  // OpenAlex knows nobody by that name, so there is no one to fall back to.
  const mock = baseMock()
    .prepend(/openalex\.org\/authors/, jsonResponse({ meta: { count: 0 }, results: [] }))
    .prepend(S2_PAPERS, rateLimitedResponse(60));

  await withMock(mock, async () => {
    await app.request('/api/researchers/s2:1751762');
    const { status, body } = await app.request('/api/researchers/s2:1751762/papers');

    assert.equal(status, 429, 'an honest rate limit beats another researcher papers');
    assert.equal(body.error.code, 'PROVIDER_RATE_LIMITED');
  });
});

test('paper fallback is refused when several people share the name', async () => {
  const ambiguous = {
    meta: { count: 2, page: 1, per_page: 10 },
    results: [
      { ...fixtures.OPENALEX_AUTHORS.results[0], id: 'https://openalex.org/A_ONE', orcid: null },
      { ...fixtures.OPENALEX_AUTHORS.results[0], id: 'https://openalex.org/A_TWO', orcid: null }
    ]
  };

  const mock = baseMock()
    .prepend(/openalex\.org\/authors/, jsonResponse(ambiguous))
    .prepend(S2_PAPERS, rateLimitedResponse(60));

  await withMock(mock, async () => {
    await app.request('/api/researchers/s2:1751762');
    const { status, body } = await app.request('/api/researchers/s2:1751762/papers');

    assert.equal(status, 429, 'guessing between namesakes would be worse than the error');
    assert.equal(body.error.code, 'PROVIDER_RATE_LIMITED');
  });
});

test('no fallback is attempted for a researcher that has never been identified', async () => {
  const mock = baseMock().prepend(S2_PAPERS, rateLimitedResponse(60));

  await withMock(mock, async (mock2) => {
    // No profile load first, so the cache has no name to match on.
    const { status, body } = await app.request('/api/researchers/s2:1751762/papers');

    assert.equal(status, 429);
    assert.equal(body.error.code, 'PROVIDER_RATE_LIMITED');
    assert.equal(
      mock2.callsMatching(/openalex\.org\/authors/).length,
      0,
      'an unidentified researcher must not be matched by guesswork'
    );
  });
});

test('a 404 does not trigger a fallback, because the researcher simply does not exist', async () => {
  const mock = baseMock().prepend(S2_PAPERS, errorResponse(404, { error: 'not found' }));

  await withMock(mock, async (mock2) => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/papers');

    assert.equal(status, 404);
    assert.equal(body.error.code, 'RESEARCHER_NOT_FOUND');
    assert.equal(
      mock2.callsMatching(/openalex\.org\/authors/).length,
      0,
      'a missing researcher must not be substituted from another provider'
    );
  });
});

/** ------------------------------------------ 5. both providers unavailable */

test('both providers rate limited returns 429, not 500', async () => {
  const mock = new MockFetch()
    .on(/author\/search/, rateLimitedResponse(30))
    .on(/openalex\.org\/authors/, rateLimitedResponse(30));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/search?q=Test%20Author');

    assert.equal(status, 429);
    assert.equal(body.error.code, 'PROVIDER_RATE_LIMITED');
    assert.ok(body.error.request_id);
  });
});

test('both providers unreachable returns 502, not 500', async () => {
  const mock = new MockFetch()
    .on(/author\/search/, () => networkRejection())
    .on(/openalex\.org\/authors/, () => networkRejection());

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/search?q=Test%20Author');

    assert.equal(status, 502);
    assert.equal(body.error.code, 'RESEARCH_PROVIDER_UNAVAILABLE');
  });
});

test('an error response never leaks the provider URL or internals', async () => {
  const mock = new MockFetch()
    .on(/author\/search/, rateLimitedResponse(30))
    .on(/openalex\.org\/authors/, rateLimitedResponse(30));

  await withMock(mock, async () => {
    const { body } = await app.request('/api/researchers/search?q=Test%20Author');
    const serialised = JSON.stringify(body);

    assert.ok(!serialised.includes('semanticscholar.org'));
    assert.ok(!serialised.includes('openalex.org'));
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'request_id']);
  });
});

/** ------------------------------------------- no duplicate external calls */

test('concurrent identical searches cause only one external call', async () => {
  await withMock(baseMock(), async (mock) => {
    const [a, b, c] = await Promise.all([
      app.request('/api/researchers/search?q=Test%20Author'),
      app.request('/api/researchers/search?q=Test%20Author'),
      app.request('/api/researchers/search?q=Test%20Author')
    ]);

    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(c.status, 200);
    assert.equal(
      mock.callsMatching(/author\/search/).length,
      1,
      'three concurrent identical requests should share one provider call'
    );
  });
});

test('a failed call is not cached, so a later request may retry', async () => {
  let attempts = 0;
  const mock = baseMock().prepend(/author\/search/, () => {
    attempts += 1;
    return attempts === 1 ? errorResponse(500) : jsonResponse(fixtures.S2_AUTHOR_SEARCH);
  });

  await withMock(mock, async () => {
    // PROVIDER_RETRIES=1 means the first request itself retries once.
    const first = await app.request('/api/researchers/search?q=Test%20Author');
    assert.equal(first.status, 200);
    assert.ok(attempts >= 2, 'the transient 500 should have been retried');
  });
});

/** --------------------------------------------------- provider health report */

test('/api/health reports which providers are rate limited', async () => {
  const mock = baseMock().prepend(/author\/search/, rateLimitedResponse(60));

  await withMock(mock, async () => {
    const before = await app.request('/api/health');
    assert.equal(before.body.provider_health.semantic_scholar.state, 'ok');

    await app.request('/api/researchers/search?q=Test%20Author');

    const after = await app.request('/api/health');
    assert.equal(after.body.provider_health.semantic_scholar.state, 'rate_limited');
    assert.ok(after.body.provider_health.semantic_scholar.cooldown_remaining_ms > 0);
    assert.equal(after.body.provider_health.semantic_scholar.rate_limit_hits, 1);
    assert.equal(after.body.provider_health.openalex.state, 'ok');
  });
});

/** ------------------------------------------- legacy topic search (/api/research) */

test('the topic search survives a Semantic Scholar 429 using the other sources', async () => {
  const mock = new MockFetch()
    .on(/semanticscholar\.org/, rateLimitedResponse(60))
    .on(/openalex\.org/, jsonResponse({ results: [
      { id: 'https://openalex.org/W9', display_name: 'A real paper', publication_year: 2024,
        authorships: [], abstract_inverted_index: { Real: [0], abstract: [1] } }
    ] }))
    .on(/export\.arxiv\.org/, jsonResponse({}));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/research?q=knowledge%20graphs');

    assert.equal(status, 200);
    assert.equal(body.demoMode, false, 'real results from another source beat demo data');
    assert.ok(body.papers.length > 0);
    assert.ok(body.providerNotes.some((note) => note.includes('Semantic Scholar')));
  });
});

test('the topic search falls back when the single chosen source is rate limited', async () => {
  const mock = new MockFetch()
    .on(/semanticscholar\.org/, rateLimitedResponse(60))
    .on(/openalex\.org/, jsonResponse({ results: [
      { id: 'https://openalex.org/W9', display_name: 'A real paper', publication_year: 2024,
        authorships: [], abstract_inverted_index: { Real: [0] } }
    ] }))
    .on(/export\.arxiv\.org/, jsonResponse({}));

  await withMock(mock, async () => {
    // Prime the cooldown, then ask for that source explicitly.
    providerHealth.markRateLimited('semanticscholar', 60_000);

    const { status, body } = await app.request('/api/research?q=test&source=semanticscholar');

    assert.equal(status, 200);
    assert.equal(body.demoMode, false);
    assert.equal(body.fallbackUsed, true);
    assert.ok(body.papers.length > 0);
  });
});

test('the topic search only uses demo data when nothing at all can answer', async () => {
  const mock = new MockFetch()
    .on(/semanticscholar\.org/, rateLimitedResponse(60))
    .on(/openalex\.org/, rateLimitedResponse(60))
    .on(/export\.arxiv\.org/, rateLimitedResponse(60));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/research?q=test');

    assert.equal(status, 200, 'the page must still render rather than erroring');
    assert.equal(body.demoMode, true);
    assert.equal(body.rateLimited, true);
    assert.ok(body.papers.length > 0);
  });
});
