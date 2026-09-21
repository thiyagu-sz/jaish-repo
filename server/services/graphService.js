/**
 * Knowledge graph service.
 *
 * Entities:      Researcher, Paper, Topic, Method, Dataset, Institution, Domain
 * Relationships: AUTHORED, HAS_TOPIC, USES_METHOD, USES_DATASET,
 *                AFFILIATED_WITH, BELONGS_TO, CITES
 *
 * Two layers of provenance are kept apart on purpose:
 *
 *   provenance "provider" - built from real provider metadata (authorships,
 *                           OpenAlex topic/field/domain taxonomy, institutions).
 *                           Available with no language model at all.
 *   provenance "llm"      - methods and datasets extracted by the analysis
 *                           agent, only added when an analysis has been run.
 *
 * The graph is returned as plain nodes/edges, which is what the frontend draws
 * and also what a Neo4j write would iterate over. GraphStore is the seam: an
 * InMemoryGraphStore ships now, and a Neo4jGraphStore implementing the same
 * addNode/addEdge/toJSON contract can replace it without touching callers.
 */

const NODE_TYPES = {
  RESEARCHER: 'Researcher',
  PAPER: 'Paper',
  TOPIC: 'Topic',
  METHOD: 'Method',
  DATASET: 'Dataset',
  INSTITUTION: 'Institution',
  DOMAIN: 'Domain',
  RESEARCH_GAP: 'ResearchGap'
};

const EDGE_TYPES = {
  AUTHORED: 'AUTHORED',
  HAS_TOPIC: 'HAS_TOPIC',
  USES_METHOD: 'USES_METHOD',
  USES_DATASET: 'USES_DATASET',
  AFFILIATED_WITH: 'AFFILIATED_WITH',
  BELONGS_TO: 'BELONGS_TO',
  CITES: 'CITES',
  SUPPORTS: 'SUPPORTS'
};

/** Stable, collision-resistant node key for a label within a type. */
function nodeKey(type, label) {
  return `${type}:${String(label).toLowerCase().replace(/\s+/g, '-').slice(0, 80)}`;
}

class InMemoryGraphStore {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
  }

  /**
   * Upserts a node. Repeated mentions raise `weight`, which the frontend uses
   * to size a node - so weight is a real count, not a decorative number.
   */
  addNode({ id, type, label, provenance = 'provider', properties = {} }) {
    const key = id || nodeKey(type, label);
    const existing = this.nodes.get(key);

    if (existing) {
      existing.weight += 1;
      Object.assign(existing.properties, properties);
      // A node seen from both sources is reported as provider-grounded.
      if (existing.provenance !== 'provider' && provenance === 'provider') {
        existing.provenance = 'provider';
      }
      return existing;
    }

    const node = { id: key, type, label: String(label), provenance, weight: 1, properties };
    this.nodes.set(key, node);
    return node;
  }

  addEdge({ from, to, type, provenance = 'provider' }) {
    if (!from || !to || from === to) return null;
    if (!this.nodes.has(from) || !this.nodes.has(to)) return null;

    const key = `${from}|${type}|${to}`;
    const existing = this.edges.get(key);
    if (existing) {
      existing.weight += 1;
      return existing;
    }

    const edge = { id: key, from, to, type, provenance, weight: 1 };
    this.edges.set(key, edge);
    return edge;
  }

  toJSON() {
    return { nodes: [...this.nodes.values()], edges: [...this.edges.values()] };
  }
}

/** Counts per node type, so the UI can show what the graph is made of. */
function summarize(graph) {
  const byType = {};
  graph.nodes.forEach((node) => {
    byType[node.type] = (byType[node.type] || 0) + 1;
  });
  return {
    node_count: graph.nodes.length,
    edge_count: graph.edges.length,
    nodes_by_type: byType,
    llm_derived_nodes: graph.nodes.filter((n) => n.provenance === 'llm').length
  };
}

/**
 * Builds the graph.
 *
 * @param {object}   input
 * @param {object}   input.researcher  normalized Researcher
 * @param {Array}    input.papers      normalized Paper list
 * @param {object=}  input.analysis    optional ResearchAnalysis, adds methods/datasets
 * @param {object=}  input.options     { maxPapers, store }
 */
function buildGraph({ researcher, papers = [], analysis = null, options = {} }) {
  const { maxPapers = 30 } = options;
  const store = options.store || new InMemoryGraphStore();

  const researcherNode = store.addNode({
    id: `Researcher:${researcher.id}`,
    type: NODE_TYPES.RESEARCHER,
    label: researcher.name,
    properties: {
      source: researcher.source,
      paper_count: researcher.paper_count,
      citation_count: researcher.citation_count,
      h_index: researcher.h_index,
      url: researcher.url
    }
  });

  // Researcher -[AFFILIATED_WITH]-> Institution
  researcher.affiliations.forEach((affiliation) => {
    const institution = store.addNode({
      type: NODE_TYPES.INSTITUTION,
      label: affiliation
    });
    store.addEdge({ from: researcherNode.id, to: institution.id, type: EDGE_TYPES.AFFILIATED_WITH });
  });

  const selected = papers.slice(0, maxPapers);
  const paperNodeIds = new Map();

  selected.forEach((paper) => {
    const paperNode = store.addNode({
      id: `Paper:${paper.id}`,
      type: NODE_TYPES.PAPER,
      label: paper.title,
      properties: {
        year: paper.year,
        venue: paper.venue,
        citation_count: paper.citation_count,
        url: paper.url,
        source: paper.source,
        has_abstract: Boolean(paper.abstract)
      }
    });
    paperNodeIds.set(paper.id, paperNode.id);

    store.addEdge({ from: researcherNode.id, to: paperNode.id, type: EDGE_TYPES.AUTHORED });

    // Paper -[HAS_TOPIC]-> Topic   (OpenAlex topics, or S2 fieldsOfStudy)
    paper.topics.forEach((topic) => {
      const topicNode = store.addNode({ type: NODE_TYPES.TOPIC, label: topic });
      store.addEdge({ from: paperNode.id, to: topicNode.id, type: EDGE_TYPES.HAS_TOPIC });
    });

    // Paper -[BELONGS_TO]-> Domain (OpenAlex field/domain levels)
    paper.fields.forEach((field) => {
      const domainNode = store.addNode({ type: NODE_TYPES.DOMAIN, label: field });
      store.addEdge({ from: paperNode.id, to: domainNode.id, type: EDGE_TYPES.BELONGS_TO });
    });

    // Institutions credited on the paper itself.
    paper.institutions.forEach((institutionName) => {
      const institution = store.addNode({ type: NODE_TYPES.INSTITUTION, label: institutionName });
      store.addEdge({ from: researcherNode.id, to: institution.id, type: EDGE_TYPES.AFFILIATED_WITH });
    });
  });

  // Paper -[CITES]-> Paper, only where both ends are in this selection. The
  // providers we use do not return reference lists in the paper payload, so
  // this stays empty unless a caller supplies `references`.
  selected.forEach((paper) => {
    (paper.references || []).forEach((referencedId) => {
      const target = paperNodeIds.get(referencedId);
      if (target) {
        store.addEdge({ from: paperNodeIds.get(paper.id), to: target, type: EDGE_TYPES.CITES });
      }
    });
  });

  // ------------------------------------------------ language model overlay
  // Methods and datasets are not provided by either scholarly API, so they can
  // only come from analysis. They are marked so the UI can distinguish them.
  if (analysis) {
    const attach = (items, type, edgeType) => {
      (items || []).forEach((item) => {
        const label = typeof item === 'string' ? item : item.name;
        if (!label) return;

        const node = store.addNode({ type, label, provenance: 'llm' });
        const supporting = (typeof item === 'object' && item.supporting_papers) || [];

        // Link to the specific papers the extraction cited; if the model gave
        // none, the node stays unlinked rather than being attached at random.
        supporting.forEach((paperId) => {
          const paperNodeId = paperNodeIds.get(paperId);
          if (paperNodeId) {
            store.addEdge({ from: paperNodeId, to: node.id, type: edgeType, provenance: 'llm' });
          }
        });
      });
    };

    attach(analysis.methods, NODE_TYPES.METHOD, EDGE_TYPES.USES_METHOD);
    attach(analysis.datasets, NODE_TYPES.DATASET, EDGE_TYPES.USES_DATASET);
  }

  const graph = store.toJSON();
  return {
    ...graph,
    summary: summarize(graph),
    store_type: options.store ? 'custom' : 'in_memory',
    // Set when a Neo4j-backed store is wired in; kept explicit so the frontend
    // can say where the graph came from.
    persisted: false
  };
}

/** ===================================================================
 *  Analysis-derived graph
 *  ===================================================================
 *
 * Builds the graph from the analysis JSON that /analyze already returned,
 * rather than from raw provider metadata. Nothing here calls a provider or a
 * model: it is a projection of data the caller already holds.
 *
 *   Researcher -[AUTHORED]-----> Paper
 *   Paper      -[HAS_TOPIC]----> Topic
 *   Paper      -[USES_METHOD]--> Method
 *   Paper      -[USES_DATASET]-> Dataset
 *   Paper      -[BELONGS_TO]---> Domain
 *   Paper      -[SUPPORTS]-----> ResearchGap
 *
 * Every edge comes from an item's own `supporting_papers` list, which the
 * analysis agent has already verified against the papers actually retrieved.
 * Nothing is inferred: an item that cites no paper in the set contributes no
 * edge, and a paper is never connected to something that did not name it.
 */

/** Groups the excerpts that mention each paper, so a Paper node carries evidence too. */
function collectPaperEvidence(analysis) {
  const byPaper = new Map();

  const absorb = (items) => {
    (items || []).forEach((item) => {
      (item.evidence || []).forEach((evidence) => {
        if (!evidence?.paper_id) return;
        const existing = byPaper.get(evidence.paper_id) || [];
        // The same excerpt is reused across items; keep one copy of each.
        if (!existing.some((entry) => entry.excerpt === evidence.excerpt)) {
          existing.push(evidence);
        }
        byPaper.set(evidence.paper_id, existing);
      });
    });
  };

  [
    analysis.research_themes,
    analysis.topics,
    analysis.methods,
    analysis.datasets,
    analysis.domains,
    analysis.limitations,
    analysis.recurring_patterns
  ].forEach(absorb);

  return byPaper;
}

/**
 * @param {object}  input
 * @param {object}  input.researcher       normalized Researcher
 * @param {object}  input.analysis         the `analysis` object from /analyze
 * @param {Array}   input.papersAnalyzed   the `papers_analyzed` list from /analyze
 * @param {Array=}  input.gaps             the `gaps` list from /gaps, if run
 * @param {string=} input.gapDisclaimer    the disclaimer that came with them
 */
function buildAnalysisGraph({
  researcher,
  analysis,
  papersAnalyzed = [],
  gaps = [],
  gapDisclaimer = null,
  options = {}
}) {
  const store = options.store || new InMemoryGraphStore();

  const researcherNode = store.addNode({
    id: `Researcher:${researcher.id}`,
    type: NODE_TYPES.RESEARCHER,
    label: researcher.name,
    provenance: 'provider',
    properties: {
      source: researcher.source,
      paper_count: researcher.paper_count,
      citation_count: researcher.citation_count,
      h_index: researcher.h_index,
      url: researcher.url,
      affiliations: researcher.affiliations
    }
  });

  /** Paper ids exactly as the providers gave them, so they round-trip. */
  const paperNodeIds = new Map();
  const paperEvidence = collectPaperEvidence(analysis);

  papersAnalyzed.forEach((paper) => {
    const node = store.addNode({
      id: `Paper:${paper.id}`,
      type: NODE_TYPES.PAPER,
      label: paper.title,
      provenance: 'provider',
      properties: {
        paper_id: paper.id,
        year: paper.year,
        url: paper.url,
        source: paper.source,
        citation_count: paper.citation_count,
        // The excerpts this paper contributed to the analysis.
        evidence: paperEvidence.get(paper.id) || []
      }
    });

    paperNodeIds.set(paper.id, node.id);
    store.addEdge({ from: researcherNode.id, to: node.id, type: EDGE_TYPES.AUTHORED, provenance: 'provider' });
  });

  /**
   * Adds one extracted category. A repeated name collapses onto one node and
   * raises its weight rather than creating a duplicate.
   */
  function attach(items, type, edgeType) {
    let linked = 0;

    (items || []).forEach((item) => {
      if (!item?.name) return;

      const node = store.addNode({
        type,
        label: item.name,
        provenance: 'llm',
        properties: {
          description: item.description || '',
          confidence: item.confidence ?? null,
          supporting_papers: item.supporting_papers || [],
          evidence: item.evidence || [],
          // Stated on the node so a consumer of the JSON cannot mistake an
          // evidence measure for a claim about correctness or novelty.
          confidence_meaning:
            'How much of the analysed set supports this item. Not a measure of novelty or correctness.'
        }
      });

      (item.supporting_papers || []).forEach((paperId) => {
        const paperNodeId = paperNodeIds.get(paperId);
        if (!paperNodeId) return; // never invent a link to a paper we do not have
        if (store.addEdge({ from: paperNodeId, to: node.id, type: edgeType, provenance: 'llm' })) {
          linked += 1;
        }
      });
    });

    return linked;
  }

  attach(analysis.topics, NODE_TYPES.TOPIC, EDGE_TYPES.HAS_TOPIC);
  attach(analysis.methods, NODE_TYPES.METHOD, EDGE_TYPES.USES_METHOD);
  attach(analysis.datasets, NODE_TYPES.DATASET, EDGE_TYPES.USES_DATASET);
  attach(analysis.domains, NODE_TYPES.DOMAIN, EDGE_TYPES.BELONGS_TO);

  // ------------------------------------------------------- candidate gaps
  // A gap node is labelled a candidate everywhere it appears. The graph shows
  // which papers the statement was drawn from; it says nothing about whether
  // the gap is unaddressed in the wider literature.
  gaps.forEach((gap) => {
    const node = store.addNode({
      type: NODE_TYPES.RESEARCH_GAP,
      label: gap.title,
      provenance: 'llm',
      properties: {
        candidate: true,
        status: 'candidate',
        description: gap.description,
        gap_type: gap.type,
        reasoning: gap.reasoning || '',
        related_topics: gap.related_topics || [],
        supporting_papers: gap.supporting_papers || [],
        evidence: gap.evidence || [],
        confidence: gap.confidence ?? null,
        confidence_meaning:
          'How well the analysed papers support this statement. Not evidence that the gap is ' +
          'unaddressed in the wider literature.',
        disclaimer: gapDisclaimer
      }
    });

    // Paper -[SUPPORTS]-> ResearchGap
    (gap.supporting_papers || []).forEach((paperId) => {
      const paperNodeId = paperNodeIds.get(paperId);
      if (!paperNodeId) return;
      store.addEdge({ from: paperNodeId, to: node.id, type: EDGE_TYPES.SUPPORTS, provenance: 'llm' });
    });
  });

  const graph = store.toJSON();
  const summary = summarize(graph);

  return {
    ...graph,
    summary,
    meta: {
      node_count: summary.node_count,
      edge_count: summary.edge_count,
      source: 'analysis',
      nodes_by_type: summary.nodes_by_type,
      papers_analyzed: papersAnalyzed.length,
      candidate_gaps: gaps.length,
      // Nodes with no evidence attached, so a reader can judge completeness.
      nodes_without_evidence: graph.nodes.filter(
        (node) =>
          node.type !== NODE_TYPES.RESEARCHER &&
          !(node.properties.evidence || []).length
      ).length
    },
    store_type: options.store ? 'custom' : 'in_memory',
    persisted: false
  };
}

module.exports = {
  NODE_TYPES,
  EDGE_TYPES,
  InMemoryGraphStore,
  buildGraph,
  buildAnalysisGraph,
  collectPaperEvidence,
  summarize,
  nodeKey
};
