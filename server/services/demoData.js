/**
 * Sample research papers used when a scholarly API is unavailable.
 * Keeps the app demonstrable before any keys or network access are configured.
 */
const DEMO_PAPERS = [
  {
    id: 'demo-1',
    title: 'Large Language Models for Educational Applications: A Systematic Review',
    authors: ['A. Ramesh', 'K. Patel', 'L. Moreau'],
    year: 2025,
    source: 'Demo',
    abstract:
      'Large language models are increasingly used to support tutoring, assessment and content generation in higher education. This review analyses 128 studies published between 2020 and 2025, grouping them by pedagogical task, evaluation method and deployment context. We find strong reported gains in student engagement and drafting support, but weak evidence on long-term learning outcomes. Most evaluations are short-term, single-institution and rely on self-reported satisfaction rather than measured achievement.',
    url: 'https://openalex.org/'
  },
  {
    id: 'demo-2',
    title: 'Knowledge Graph Enhanced Retrieval-Augmented Generation for Scientific Question Answering',
    authors: ['M. Ito', 'S. Bhattacharya', 'D. Okonkwo'],
    year: 2025,
    source: 'Demo',
    abstract:
      'Retrieval-augmented generation reduces hallucination by grounding model output in retrieved documents, but flat vector retrieval loses the relational structure of scientific literature. We propose a hybrid pipeline that combines dense passage retrieval with a domain knowledge graph linking entities, methods and datasets. On three scientific QA benchmarks the hybrid retriever improves answer accuracy over dense-only retrieval, with the largest gains on multi-hop questions requiring reasoning across several papers.',
    url: 'https://openalex.org/'
  },
  {
    id: 'demo-3',
    title: 'Multi-Agent Systems for Automated Research Discovery and Hypothesis Generation',
    authors: ['P. Novak', 'R. Iyer', 'T. Lindqvist', 'C. Wu'],
    year: 2024,
    source: 'Demo',
    abstract:
      'We present an agent-based framework in which specialised language model agents perform literature retrieval, summarisation, gap detection and hypothesis drafting, coordinated by a planner agent. Across two domains the framework produced candidate research questions that domain experts rated as plausible in a majority of cases, though novelty ratings were substantially lower. We discuss failure modes including redundant retrieval, agent drift and over-confident gap claims.',
    url: 'https://arxiv.org/'
  },
  {
    id: 'demo-4',
    title: 'Machine Learning Approaches for Network Intrusion Detection: Benchmarks and Pitfalls',
    authors: ['H. Al-Farsi', 'J. Kim'],
    year: 2024,
    source: 'Demo',
    abstract:
      'Supervised and unsupervised learning methods are widely applied to network intrusion detection, yet reported accuracy rarely transfers to production traffic. We benchmark eleven models on four public datasets and show that class imbalance handling, temporal data leakage and outdated attack distributions explain much of the reported performance. We recommend evaluation protocols based on time-ordered splits and cost-sensitive metrics.',
    url: 'https://arxiv.org/'
  },
  {
    id: 'demo-5',
    title: 'Artificial Intelligence in Clinical Decision Support: Adoption Barriers in Hospital Settings',
    authors: ['E. Fernandes', 'N. Sharma', 'O. Adeyemi'],
    year: 2023,
    source: 'Demo',
    abstract:
      'Clinical decision support systems using machine learning have shown diagnostic performance comparable to clinicians in controlled studies, but adoption in hospitals remains limited. Through interviews with 42 clinicians and administrators across six hospitals, we identify workflow integration, unclear accountability, limited interpretability and validation on non-local populations as the dominant barriers. Technical accuracy was rarely the deciding factor.',
    url: 'https://openalex.org/'
  },
  {
    id: 'demo-6',
    title: 'Vector Databases for Scholarly Search: An Empirical Comparison of Embedding Strategies',
    authors: ['V. Petrova', 'G. Santos'],
    year: 2023,
    source: 'Demo',
    abstract:
      'Semantic search over scholarly corpora depends heavily on how documents are chunked and embedded. We compare title-only, abstract-level and passage-level embeddings across three open embedding models on a corpus of 200,000 abstracts. Passage-level embeddings improve recall for specific method queries, while abstract-level embeddings remain stronger for broad topical queries. Index size and query latency trade-offs are reported for each configuration.',
    url: 'https://openalex.org/'
  }
];

/**
 * Returns demo papers, loosely filtered by the query so the results feel relevant.
 */
function getDemoPapers(query = '') {
  const terms = String(query).toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (!terms.length) return DEMO_PAPERS;

  const matches = DEMO_PAPERS.filter((paper) => {
    const haystack = `${paper.title} ${paper.abstract}`.toLowerCase();
    return terms.some((term) => haystack.includes(term));
  });

  // Never return an empty demo list - the point of demo mode is that something shows up.
  return matches.length ? matches : DEMO_PAPERS;
}

module.exports = { DEMO_PAPERS, getDemoPapers };
