/**
 * Knowledge graph built from the analysis JSON.
 *
 * Covers graph generation, the node and edge relationships, de-duplication,
 * evidence preservation and an empty analysis.
 *
 * Two levels are tested: the pure builder in services/graphService.js, which
 * needs no network at all, and the endpoint, whose providers and model are
 * mocked. Nothing here contacts a live API.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { MockFetch, jsonResponse, errorResponse, chatCompletion } = require('./helpers/mockFetch');
const fixtures = require('./helpers/fixtures');
const { startTestServer, resetCache } = require('./helpers/server');

process.env.OPENROUTER_API_KEY = 'test-key-not-real';
process.env.OPENROUTER_MODEL = 'openai/gpt-4o-mini';
process.env.EMBEDDINGS_PROVIDER = 'local';

const graphService = require('../server/services/graphService');

const LLM = /chat\/completions/;

let app;

test.before(async () => {
  app = await startTestServer();
});

test.after(async () => {
  await app.close();
});

/** ------------------------------------------------------------- fixtures */

function evidence(paperId, title) {
  return {
    paper_id: paperId,
    title,
    source: 'openalex',
    excerpt: `Excerpt taken from ${title}.`,
    year: 2024,
    url: `https://openalex.org/${paperId}`
  };
}

const RESEARCHER = {
  id: 'openalex:A5086198262',
  name: 'Test Author',
  source: 'openalex',
  affiliations: ['Test University'],
  paper_count: 2,
  citation_count: 130,
  h_index: 5,
  url: 'https://openalex.org/A5086198262'
};

// Paper ids are reused exactly as the provider gave them.
const PAPERS_ANALYZED = [
  { id: 'openalex:W1', title: 'Paper One', year: 2024, source: 'openalex', url: 'u1', citation_count: 90 },
  { id: 'openalex:W2', title: 'Paper Two', year: 2023, source: 'openalex', url: 'u2', citation_count: 45 }
];

function analysisFixture(overrides = {}) {
  return {
    researcher_id: RESEARCHER.id,
    research_themes: [
      { name: 'Retrieval augmented generation', description: 'Grounding answers in retrieved text.',
        supporting_papers: ['openalex:W1', 'openalex:W2'],
        evidence: [evidence('openalex:W1', 'Paper One'), evidence('openalex:W2', 'Paper Two')], confidence: 0.69 }
    ],
    topics: [
      { name: 'Question answering', description: '', supporting_papers: ['openalex:W1'],
        evidence: [evidence('openalex:W1', 'Paper One')], confidence: 0.57 }
    ],
    methods: [
      { name: 'Dense passage retrieval', description: '', supporting_papers: ['openalex:W1', 'openalex:W2'],
        evidence: [evidence('openalex:W1', 'Paper One'), evidence('openalex:W2', 'Paper Two')], confidence: 0.69 }
    ],
    datasets: [
      { name: 'Four public corpora', description: '', supporting_papers: ['openalex:W2'],
        evidence: [evidence('openalex:W2', 'Paper Two')], confidence: 0.57 }
    ],
    domains: [
      { name: 'Computer Science', description: '', supporting_papers: ['openalex:W1'],
        evidence: [evidence('openalex:W1', 'Paper One')], confidence: 0.57 }
    ],
    limitations: [],
    recurring_patterns: [],
    institutions: [{ name: 'Test University', paper_count: 2, source: 'provider_metadata' }],
    evidence: [],
    notes: null,
    meta: { agent: 'Research Analysis Agent', provider: 'OpenRouter', model: 'openai/gpt-4o-mini', attempts: 1 },
    ...overrides
  };
}

const GAPS = [
  {
    title: 'Cross-domain evaluation is not established',
    description: 'Both papers evaluate within a single domain.',
    type: 'evaluation',
    related_topics: ['evaluation'],
    supporting_papers: ['openalex:W1', 'openalex:W2'],
    evidence: [evidence('openalex:W1', 'Paper One'), evidence('openalex:W2', 'Paper Two')],
    reasoning: 'Both abstracts state a single-domain evaluation.',
    confidence: 0.74
  }
];

function build(overrides = {}) {
  return graphService.buildAnalysisGraph({
    researcher: RESEARCHER,
    analysis: analysisFixture(),
    papersAnalyzed: PAPERS_ANALYZED,
    gaps: [],
    ...overrides
  });
}

const nodesOfType = (graph, type) => graph.nodes.filter((node) => node.type === type);
const edgesOfType = (graph, type) => graph.edges.filter((edge) => edge.type === type);

/** ------------------------------------------------------ graph generation */

test('the graph is generated from the analysis JSON alone', () => {
  const graph = build();

  assert.equal(graph.meta.source, 'analysis');
  assert.equal(graph.meta.node_count, graph.nodes.length);
  assert.equal(graph.meta.edge_count, graph.edges.length);
  assert.equal(graph.meta.papers_analyzed, 2);

  assert.equal(nodesOfType(graph, 'Researcher').length, 1);
  assert.equal(nodesOfType(graph, 'Paper').length, 2);
  assert.equal(nodesOfType(graph, 'Topic').length, 1);
  assert.equal(nodesOfType(graph, 'Method').length, 1);
  assert.equal(nodesOfType(graph, 'Dataset').length, 1);
  assert.equal(nodesOfType(graph, 'Domain').length, 1);
});

test('only the specified node types are produced', () => {
  const graph = build({ gaps: GAPS });
  const allowed = new Set(['Researcher', 'Paper', 'Topic', 'Method', 'Dataset', 'Domain', 'ResearchGap']);

  graph.nodes.forEach((node) => {
    assert.ok(allowed.has(node.type), `unexpected node type "${node.type}"`);
  });

  // Research themes carry evidence but are not one of the requested entities,
  // so they must not appear as nodes.
  assert.equal(graph.nodes.some((node) => node.label === 'Retrieval augmented generation'), false);
});

test('paper ids from the provider are reused unchanged', () => {
  const graph = build();

  const papers = nodesOfType(graph, 'Paper');
  assert.deepEqual(papers.map((node) => node.properties.paper_id).sort(), ['openalex:W1', 'openalex:W2']);
  assert.deepEqual(papers.map((node) => node.id).sort(), ['Paper:openalex:W1', 'Paper:openalex:W2']);
});

/** ------------------------------------------------- node/edge relationships */

test('every requested relationship is produced with the right direction', () => {
  const graph = build({ gaps: GAPS });

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const relation = (type) =>
    edgesOfType(graph, type).map((edge) => [byId.get(edge.from).type, byId.get(edge.to).type]);

  relation('AUTHORED').forEach((pair) => assert.deepEqual(pair, ['Researcher', 'Paper']));
  relation('HAS_TOPIC').forEach((pair) => assert.deepEqual(pair, ['Paper', 'Topic']));
  relation('USES_METHOD').forEach((pair) => assert.deepEqual(pair, ['Paper', 'Method']));
  relation('USES_DATASET').forEach((pair) => assert.deepEqual(pair, ['Paper', 'Dataset']));
  relation('BELONGS_TO').forEach((pair) => assert.deepEqual(pair, ['Paper', 'Domain']));
  relation('SUPPORTS').forEach((pair) => assert.deepEqual(pair, ['Paper', 'ResearchGap']));

  assert.equal(edgesOfType(graph, 'AUTHORED').length, 2);
  assert.equal(edgesOfType(graph, 'USES_METHOD').length, 2, 'the method cites both papers');
  assert.equal(edgesOfType(graph, 'SUPPORTS').length, 2, 'the gap cites both papers');
});

test('an edge is only created for a paper that is actually in the graph', () => {
  const graph = build({
    analysis: analysisFixture({
      methods: [
        { name: 'Real method', supporting_papers: ['openalex:W1'], evidence: [evidence('openalex:W1', 'Paper One')], confidence: 0.57 },
        { name: 'Method citing a missing paper', supporting_papers: ['openalex:NOT_RETRIEVED'], evidence: [], confidence: 0.5 }
      ]
    })
  });

  const orphan = graph.nodes.find((node) => node.label === 'Method citing a missing paper');
  assert.ok(orphan, 'the node is still reported');
  assert.equal(
    graph.edges.filter((edge) => edge.to === orphan.id).length,
    0,
    'a relationship to a paper we do not hold must never be invented'
  );
  assert.equal(edgesOfType(graph, 'USES_METHOD').length, 1);
});

test('no edge is created between two nodes that the analysis did not connect', () => {
  const graph = build();
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));

  // "Four public corpora" is supported only by W2, so W1 must not link to it.
  const dataset = graph.nodes.find((node) => node.type === 'Dataset');
  const linkedPapers = graph.edges
    .filter((edge) => edge.to === dataset.id)
    .map((edge) => byId.get(edge.from).properties.paper_id);

  assert.deepEqual(linkedPapers, ['openalex:W2']);
});

/** ------------------------------------------------------ duplicate prevention */

test('a repeated item name collapses onto one node and raises its weight', () => {
  const graph = build({
    analysis: analysisFixture({
      topics: [
        { name: 'Question answering', supporting_papers: ['openalex:W1'], evidence: [evidence('openalex:W1', 'Paper One')], confidence: 0.57 },
        { name: 'Question Answering', supporting_papers: ['openalex:W2'], evidence: [evidence('openalex:W2', 'Paper Two')], confidence: 0.57 }
      ]
    })
  });

  const topics = nodesOfType(graph, 'Topic');
  assert.equal(topics.length, 1, 'the same topic must not appear twice');
  assert.equal(topics[0].weight, 2);
  assert.equal(edgesOfType(graph, 'HAS_TOPIC').length, 2, 'both papers still link to it');
});

test('the same paper cited twice by one item produces a single edge', () => {
  const graph = build({
    analysis: analysisFixture({
      methods: [
        { name: 'Dense passage retrieval', supporting_papers: ['openalex:W1', 'openalex:W1'],
          evidence: [evidence('openalex:W1', 'Paper One')], confidence: 0.57 }
      ]
    })
  });

  assert.equal(edgesOfType(graph, 'USES_METHOD').length, 1);
});

test('node ids are unique across the whole graph', () => {
  const graph = build({ gaps: GAPS });
  const ids = graph.nodes.map((node) => node.id);

  assert.equal(new Set(ids).size, ids.length);

  const edgeIds = graph.edges.map((edge) => edge.id);
  assert.equal(new Set(edgeIds).size, edgeIds.length);
});

test('a topic and a domain of the same name stay separate nodes', () => {
  const graph = build({
    analysis: analysisFixture({
      topics: [{ name: 'Computer Science', supporting_papers: ['openalex:W1'], evidence: [evidence('openalex:W1', 'Paper One')], confidence: 0.5 }]
    })
  });

  assert.equal(nodesOfType(graph, 'Topic').length, 1);
  assert.equal(nodesOfType(graph, 'Domain').length, 1);
  assert.notEqual(nodesOfType(graph, 'Topic')[0].id, nodesOfType(graph, 'Domain')[0].id);
});

/** -------------------------------------------------- evidence preservation */

test('extracted nodes keep the excerpts the analysis returned', () => {
  const graph = build({ gaps: GAPS });

  const extracted = graph.nodes.filter((node) =>
    ['Topic', 'Method', 'Dataset', 'Domain', 'ResearchGap'].includes(node.type)
  );
  assert.ok(extracted.length > 0);

  extracted.forEach((node) => {
    const items = node.properties.evidence;
    assert.ok(Array.isArray(items) && items.length > 0, `${node.label} lost its evidence`);

    items.forEach((item) => {
      assert.ok(item.paper_id.startsWith('openalex:'));
      assert.ok(item.excerpt.length > 0);
      assert.equal(item.source, 'openalex');
      assert.ok(item.title);
    });
  });
});

test('paper nodes carry the excerpts they contributed, de-duplicated', () => {
  const graph = build();
  const paperOne = graph.nodes.find((node) => node.properties.paper_id === 'openalex:W1');

  const excerpts = paperOne.properties.evidence.map((item) => item.excerpt);
  assert.ok(excerpts.length > 0);
  assert.equal(new Set(excerpts).size, excerpts.length, 'the same excerpt must not repeat');
  excerpts.forEach((excerpt) => assert.ok(excerpt.includes('Paper One')));
});

test('supporting_papers is preserved on the node so evidence can be traced', () => {
  const graph = build({ gaps: GAPS });
  const gap = nodesOfType(graph, 'ResearchGap')[0];

  assert.deepEqual(gap.properties.supporting_papers, ['openalex:W1', 'openalex:W2']);
  assert.equal(gap.properties.evidence.length, 2);
});

/** ----------------------------------------------------------- candidate gaps */

test('a research gap is labelled a candidate and never claims novelty', () => {
  const graph = build({ gaps: GAPS, gapDisclaimer: 'Candidate gaps are drawn only from these papers.' });
  const gap = nodesOfType(graph, 'ResearchGap')[0];

  assert.equal(gap.properties.candidate, true);
  assert.equal(gap.properties.status, 'candidate');
  assert.equal(gap.properties.confidence, 0.74);
  assert.ok(
    gap.properties.confidence_meaning.toLowerCase().includes('not evidence that the gap is'),
    'the gap node must say that confidence is not evidence of novelty'
  );
  assert.ok(gap.properties.disclaimer.includes('drawn only from'));

  const serialised = JSON.stringify(gap).toLowerCase();
  assert.ok(!serialised.includes('novel'), 'a gap node must not assert novelty');
});

test('confidence on every extracted node states what it means', () => {
  const graph = build({ gaps: GAPS });

  graph.nodes
    .filter((node) => node.properties.confidence != null)
    .forEach((node) => {
      assert.ok(
        node.properties.confidence_meaning.includes('Not') || node.properties.confidence_meaning.includes('not'),
        `${node.label} does not say what its confidence means`
      );
    });
});

/** --------------------------------------------------- empty analysis handling */

test('an analysis with no extracted items yields the researcher and papers only', () => {
  const graph = build({
    analysis: analysisFixture({
      research_themes: [], topics: [], methods: [], datasets: [], domains: []
    })
  });

  assert.equal(graph.meta.source, 'analysis');
  assert.equal(nodesOfType(graph, 'Researcher').length, 1);
  assert.equal(nodesOfType(graph, 'Paper').length, 2);
  assert.equal(edgesOfType(graph, 'AUTHORED').length, 2);
  assert.equal(nodesOfType(graph, 'Topic').length, 0);
  assert.equal(graph.meta.edge_count, 2);
});

test('an empty analysis with no papers yields just the researcher, not an error', () => {
  const graph = graphService.buildAnalysisGraph({
    researcher: RESEARCHER,
    analysis: { topics: [], methods: [], datasets: [], domains: [] },
    papersAnalyzed: [],
    gaps: []
  });

  assert.equal(graph.meta.node_count, 1);
  assert.equal(graph.meta.edge_count, 0);
  assert.equal(graph.meta.papers_analyzed, 0);
  assert.equal(graph.nodes[0].type, 'Researcher');
});

test('missing analysis arrays are tolerated rather than throwing', () => {
  const graph = graphService.buildAnalysisGraph({
    researcher: RESEARCHER,
    analysis: {},
    papersAnalyzed: PAPERS_ANALYZED
  });

  assert.equal(graph.meta.node_count, 3);
  assert.equal(graph.meta.candidate_gaps, 0);
});

/** --------------------------------------------------------------- endpoint */

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

/** Routes each agent to the right canned output based on its system prompt. */
function agentAwareLlm() {
  return (url, init) => {
    const body = JSON.parse(init.body);
    const isGapAgent = body.messages[0].content.includes('Gap Detection Agent');
    return chatCompletion(
      isGapAgent ? fixtures.GAP_OUTPUT_WITH_ONE_HALLUCINATED : fixtures.VALID_ANALYSIS_OUTPUT
    );
  };
}

test('GET /graph?source=analysis returns the analysis-derived graph', async () => {
  const mock = mockProviders().on(LLM, chatCompletion(fixtures.VALID_ANALYSIS_OUTPUT));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/graph?source=analysis');

    assert.equal(status, 200);
    assert.equal(body.meta.source, 'analysis');
    assert.equal(body.meta.node_count, body.nodes.length);
    assert.equal(body.meta.edge_count, body.edges.length);
    assert.ok(body.researcher.id);

    const types = new Set(body.nodes.map((node) => node.type));
    assert.ok(types.has('Researcher'));
    assert.ok(types.has('Paper'));
    assert.ok(types.has('Method'));

    const edgeTypes = new Set(body.edges.map((edge) => edge.type));
    assert.ok(edgeTypes.has('AUTHORED'));
    assert.ok(edgeTypes.has('USES_METHOD'));
  });
});

test('GET /graph?source=analysis&include_gaps=true adds candidate gap nodes', async () => {
  const mock = mockProviders().on(LLM, agentAwareLlm());

  await withMock(mock, async () => {
    const { status, body } = await app.request(
      '/api/researchers/s2:1751762/graph?source=analysis&include_gaps=true'
    );

    assert.equal(status, 200);
    assert.equal(body.meta.gaps_included, true);
    assert.equal(body.meta.candidate_gaps, 1);

    const gap = body.nodes.find((node) => node.type === 'ResearchGap');
    assert.ok(gap);
    assert.equal(gap.properties.candidate, true);

    const supports = body.edges.filter((edge) => edge.type === 'SUPPORTS');
    assert.ok(supports.length >= 2);
    assert.ok(body.provenance.note.includes('not evidence of novelty'));
  });
});

test('the graph reuses the cached analysis rather than paying for it twice', async () => {
  const mock = mockProviders().on(LLM, chatCompletion(fixtures.VALID_ANALYSIS_OUTPUT));

  await withMock(mock, async (mock2) => {
    await app.request('/api/researchers/s2:1751762/analyze', { method: 'POST', body: JSON.stringify({}) });
    const afterAnalyze = mock2.callsMatching(LLM).length;

    const { status, body } = await app.request('/api/researchers/s2:1751762/graph?source=analysis');

    assert.equal(status, 200);
    assert.equal(body.meta.analysis_cached, true);
    assert.equal(mock2.callsMatching(LLM).length, afterAnalyze, 'no second analysis call');
  });
});

test('the graph still renders when gap detection fails', async () => {
  let call = 0;
  const mock = mockProviders().on(LLM, (url, init) => {
    call += 1;
    const body = JSON.parse(init.body);
    if (body.messages[0].content.includes('Gap Detection Agent')) return errorResponse(500);
    return chatCompletion(fixtures.VALID_ANALYSIS_OUTPUT);
  });

  await withMock(mock, async () => {
    const { status, body } = await app.request(
      '/api/researchers/s2:1751762/graph?source=analysis&include_gaps=true'
    );

    assert.equal(status, 200, 'a failed gap pass must not lose the rest of the graph');
    assert.equal(body.meta.candidate_gaps, 0);
    assert.ok(body.meta.gaps_note.includes('unavailable'));
    assert.ok(body.nodes.length > 1);
    assert.ok(call > 0);
  });
});

test('source=analysis returns 503 when no model is configured', async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;

  try {
    await withMock(mockProviders(), async () => {
      const { status, body } = await app.request('/api/researchers/s2:1751762/graph?source=analysis');

      assert.equal(status, 503);
      assert.equal(body.error.code, 'LLM_NOT_CONFIGURED');
    });
  } finally {
    process.env.OPENROUTER_API_KEY = previous;
  }
});

test('an unknown source is rejected with 400', async () => {
  const { status, body } = await app.request('/api/researchers/s2:1751762/graph?source=guesswork');

  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_PARAMETER');
});

/** --------------------------------------------- existing behaviour preserved */

test('the default graph is unchanged and still needs no model', async () => {
  await withMock(mockProviders(), async (mock) => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/graph');

    assert.equal(status, 200);
    assert.equal(mock.callsMatching(LLM).length, 0);

    // The previous response shape is intact.
    assert.ok(body.summary);
    assert.equal(typeof body.summary.node_count, 'number');
    assert.equal(body.store_type, 'in_memory');
    assert.ok(body.nodes.every((node) => node.provenance === 'provider'));

    // Institutions are part of the provider graph and absent from the analysis one.
    assert.ok(body.nodes.some((node) => node.type === 'Institution'));

    // `meta` is additive.
    assert.equal(body.meta.source, 'provider');
    assert.equal(body.meta.node_count, body.summary.node_count);
  });
});

test('include_analysis on the provider graph still works as before', async () => {
  const mock = mockProviders().on(LLM, chatCompletion(fixtures.VALID_ANALYSIS_OUTPUT));

  await withMock(mock, async () => {
    const { status, body } = await app.request('/api/researchers/s2:1751762/graph?include_analysis=true');

    assert.equal(status, 200);
    assert.equal(body.meta.source, 'provider');
    assert.ok(body.summary.llm_derived_nodes > 0);
    assert.equal(body.nodes.some((node) => node.type === 'ResearchGap'), false);
  });
});
