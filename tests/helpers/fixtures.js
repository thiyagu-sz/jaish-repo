/**
 * Provider response fixtures.
 *
 * These are trimmed copies of real Semantic Scholar and OpenAlex payloads, kept
 * so the adapters are tested against the field names the APIs actually use.
 * They are test fixtures only and are never served by the application.
 */

const S2_AUTHOR_SEARCH = {
  total: 2,
  offset: 0,
  next: 2,
  data: [
    {
      authorId: '1751762',
      externalIds: { DBLP: ['Test Author'] },
      url: 'https://www.semanticscholar.org/author/1751762',
      name: 'Test Author',
      affiliations: ['Test University'],
      homepage: null,
      paperCount: 3,
      citationCount: 120,
      hIndex: 4
    },
    {
      authorId: '2211024206',
      externalIds: {},
      url: 'https://www.semanticscholar.org/author/2211024206',
      name: 'T. Author',
      affiliations: [],
      homepage: null,
      paperCount: 1,
      citationCount: 2,
      hIndex: 1
    }
  ]
};

const S2_AUTHOR = {
  authorId: '1751762',
  externalIds: { DBLP: ['Test Author'] },
  url: 'https://www.semanticscholar.org/author/1751762',
  name: 'Test Author',
  affiliations: ['Test University'],
  homepage: null,
  paperCount: 3,
  citationCount: 120,
  hIndex: 4
};

/**
 * Three papers: two with substantial abstracts that share a stated limitation,
 * and one with no abstract, so selection and chunking are both exercised.
 */
const S2_AUTHOR_PAPERS = {
  offset: 0,
  next: null,
  data: [
    {
      paperId: 'paper-one',
      externalIds: { DOI: '10.1000/one' },
      url: 'https://www.semanticscholar.org/paper/paper-one',
      title: 'Graph Retrieval for Scientific Question Answering',
      venue: 'Test Venue',
      year: 2024,
      publicationDate: '2024-03-01',
      referenceCount: 40,
      citationCount: 90,
      openAccessPdf: { url: 'https://example.org/one.pdf', status: 'GREEN' },
      fieldsOfStudy: ['Computer Science'],
      authors: [{ authorId: '1751762', name: 'Test Author' }],
      abstract:
        'We combine dense passage retrieval with a domain knowledge graph for scientific question answering. ' +
        'The hybrid retriever improves multi-hop answer accuracy over a dense-only baseline on three benchmarks. ' +
        'Evaluation is limited to a single scientific domain, and we do not measure performance on long documents.'
    },
    {
      paperId: 'paper-two',
      externalIds: { DOI: '10.1000/two' },
      url: 'https://www.semanticscholar.org/paper/paper-two',
      title: 'Benchmarking Retrieval Augmented Generation',
      venue: 'Another Venue',
      year: 2023,
      publicationDate: '2023-06-01',
      referenceCount: 30,
      citationCount: 45,
      openAccessPdf: { url: '', status: 'CLOSED' },
      fieldsOfStudy: ['Computer Science'],
      authors: [{ authorId: '1751762', name: 'Test Author' }],
      abstract:
        'We benchmark retrieval augmented generation systems across four public corpora. ' +
        'Reported gains depend heavily on chunk size and on the choice of embedding model. ' +
        'Our evaluation uses a single domain and short queries only, so generalisation is not established.'
    },
    {
      paperId: 'paper-three',
      externalIds: {},
      url: 'https://www.semanticscholar.org/paper/paper-three',
      title: 'A Paper Without An Abstract',
      venue: '',
      year: 2022,
      publicationDate: null,
      referenceCount: 0,
      citationCount: 1,
      openAccessPdf: null,
      fieldsOfStudy: null,
      authors: [{ authorId: '1751762', name: 'Test Author' }],
      abstract: null
    }
  ]
};

const OPENALEX_AUTHORS = {
  meta: { count: 1, page: 1, per_page: 10 },
  results: [
    {
      id: 'https://openalex.org/A5086198262',
      orcid: 'https://orcid.org/0000-0002-0000-0000',
      display_name: 'Test Author',
      works_count: 3,
      cited_by_count: 130,
      summary_stats: { h_index: 5, i10_index: 2 },
      ids: { openalex: 'https://openalex.org/A5086198262' },
      affiliations: [{ institution: { display_name: 'Test University' }, years: [2023] }],
      last_known_institutions: [{ display_name: 'Test University' }]
    }
  ]
};

const OPENALEX_WORKS_BY_DOI = {
  meta: { count: 2, page: 1, per_page: 2 },
  results: [
    {
      id: 'https://openalex.org/W1',
      doi: 'https://doi.org/10.1000/one',
      display_name: 'Graph Retrieval for Scientific Question Answering',
      publication_year: 2024,
      topics: [
        {
          display_name: 'Knowledge Graphs and Retrieval',
          field: { display_name: 'Computer Science' },
          domain: { display_name: 'Physical Sciences' }
        }
      ],
      authorships: [{ author: { display_name: 'Test Author' }, institutions: [{ display_name: 'Test University' }] }]
    },
    {
      id: 'https://openalex.org/W2',
      doi: 'https://doi.org/10.1000/two',
      display_name: 'Benchmarking Retrieval Augmented Generation',
      publication_year: 2023,
      topics: [
        {
          display_name: 'Information Retrieval Evaluation',
          field: { display_name: 'Computer Science' },
          domain: { display_name: 'Physical Sciences' }
        }
      ],
      authorships: [{ author: { display_name: 'Test Author' }, institutions: [] }]
    }
  ]
};

/** A well-formed analysis, citing only paper ids that exist in the fixtures. */
const VALID_ANALYSIS_OUTPUT = {
  research_themes: [
    {
      name: 'Retrieval augmented generation',
      description: 'Grounding generated answers in retrieved scientific text.',
      supporting_papers: ['s2:paper-one', 's2:paper-two']
    }
  ],
  topics: [{ name: 'Question answering', supporting_papers: ['s2:paper-one'] }],
  methods: [{ name: 'Dense passage retrieval', supporting_papers: ['s2:paper-one', 's2:paper-two'] }],
  datasets: [{ name: 'Four public corpora', supporting_papers: ['s2:paper-two'] }],
  domains: [{ name: 'Computer Science', supporting_papers: ['s2:paper-one'] }],
  limitations: [
    {
      name: 'Single-domain evaluation',
      description: 'Both papers evaluate within one scientific domain.',
      supporting_papers: ['s2:paper-one', 's2:paper-two']
    }
  ],
  recurring_patterns: [
    {
      name: 'Narrow evaluation scope',
      description: 'Evaluation is repeatedly limited in domain and query length.',
      supporting_papers: ['s2:paper-one', 's2:paper-two']
    }
  ]
};

/** Two gaps: one properly evidenced, one citing a paper that was never sent. */
const GAP_OUTPUT_WITH_ONE_HALLUCINATED = {
  gaps: [
    {
      title: 'Cross-domain evaluation of hybrid retrieval',
      description: 'Both papers evaluate in a single domain, leaving cross-domain behaviour untested.',
      type: 'evaluation',
      related_topics: ['retrieval', 'evaluation'],
      supporting_papers: ['s2:paper-one', 's2:paper-two'],
      reasoning: 'Both abstracts state a single-domain evaluation.'
    },
    {
      title: 'A gap attributed to a paper that was never retrieved',
      description: 'This cites an identifier that was not part of the prompt.',
      type: 'methodological',
      related_topics: [],
      supporting_papers: ['s2:does-not-exist', 's2:also-fake'],
      reasoning: 'Fabricated attribution, which the agent must drop.'
    }
  ]
};

module.exports = {
  S2_AUTHOR_SEARCH,
  S2_AUTHOR,
  S2_AUTHOR_PAPERS,
  OPENALEX_AUTHORS,
  OPENALEX_WORKS_BY_DOI,
  VALID_ANALYSIS_OUTPUT,
  GAP_OUTPUT_WITH_ONE_HALLUCINATED
};
