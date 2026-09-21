/**
 * Research Analysis Agent.
 *
 * Reads the abstracts of selected papers and extracts themes, topics, methods,
 * datasets, domains, institutions, recurring patterns and stated limitations.
 *
 * Two rules shape this module:
 *
 *   1. Structured output only. The model is asked for JSON against a fixed
 *      schema and the result is validated before anything is returned.
 *   2. Evidence is verified, not trusted. Every item the model returns names
 *      the papers it came from; any id that is not in the set we actually sent
 *      is dropped, and an item left with no evidence is discarded. The model
 *      therefore cannot attribute a claim to a paper that was never retrieved.
 */
const { completeJson } = require('../services/llmClient');
const { Evidence, INSUFFICIENT_EVIDENCE } = require('../models/schemas');

const EXTRACTION_FIELDS = ['research_themes', 'topics', 'methods', 'datasets', 'domains', 'limitations'];

const SYSTEM_PROMPT = [
  'You are the Research Analysis Agent in a research intelligence system.',
  'You are given numbered excerpts from the abstracts of one researcher.',
  '',
  'Extract only what the excerpts actually state. Do not use outside knowledge',
  'about the researcher or the field. If something is not present in the',
  'excerpts, omit it rather than guessing.',
  '',
  'Every item you return must list the paper ids it is supported by, using only',
  'the ids shown in the excerpts. Never invent an id.',
  '',
  'Schema:',
  '{',
  '  "research_themes": [{"name": string, "description": string, "supporting_papers": [string]}],',
  '  "topics":          [{"name": string, "supporting_papers": [string]}],',
  '  "methods":         [{"name": string, "supporting_papers": [string]}],',
  '  "datasets":        [{"name": string, "supporting_papers": [string]}],',
  '  "domains":         [{"name": string, "supporting_papers": [string]}],',
  '  "limitations":     [{"name": string, "description": string, "supporting_papers": [string]}],',
  '  "recurring_patterns": [{"name": string, "description": string, "supporting_papers": [string]}]',
  '}',
  '',
  'Rules for specific fields:',
  '- "datasets" means a named dataset or corpus. If none is named, return [].',
  '- "methods" means a named technique, model family or study design.',
  '- "limitations" must be limitations the excerpts state or clearly imply,',
  '  not generic caveats that could apply to any paper.',
  '- "recurring_patterns" are observations that hold across several papers, so',
  '  each one should cite at least two paper ids.'
].join('\n');

/** Renders the retrieved chunks as a numbered, id-tagged prompt block. */
function buildUserPrompt(researcher, chunks) {
  const excerpts = chunks
    .map(
      (chunk, index) =>
        `[${index + 1}] paper_id: ${chunk.paper_id}\n` +
        `    title: ${chunk.title}\n` +
        `    year: ${chunk.year ?? 'unknown'}\n` +
        `    excerpt: ${chunk.text}`
    )
    .join('\n\n');

  return [
    `Researcher: ${researcher.name}`,
    researcher.affiliations.length ? `Affiliations: ${researcher.affiliations.join('; ')}` : '',
    '',
    `Excerpts (${chunks.length}):`,
    excerpts
  ]
    .filter(Boolean)
    .join('\n');
}

/** Shape check. Content correctness is enforced separately by grounding. */
function validateShape(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'top level value must be a JSON object' };
  }

  const value = {};
  const allFields = [...EXTRACTION_FIELDS, 'recurring_patterns'];

  for (const field of allFields) {
    const items = parsed[field];
    if (items === undefined || items === null) {
      value[field] = [];
      continue;
    }
    if (!Array.isArray(items)) {
      return { ok: false, error: `"${field}" must be an array` };
    }

    const normalized = [];
    for (const item of items) {
      if (typeof item === 'string') {
        normalized.push({ name: item, description: '', supporting_papers: [] });
        continue;
      }
      if (!item || typeof item !== 'object') {
        return { ok: false, error: `every entry in "${field}" must be an object with a "name"` };
      }
      if (typeof item.name !== 'string' || !item.name.trim()) {
        return { ok: false, error: `an entry in "${field}" is missing a non-empty "name"` };
      }
      normalized.push({
        name: item.name.trim(),
        description: typeof item.description === 'string' ? item.description.trim() : '',
        supporting_papers: Array.isArray(item.supporting_papers)
          ? item.supporting_papers.filter((id) => typeof id === 'string')
          : []
      });
    }
    value[field] = normalized;
  }

  return { ok: true, value };
}

/**
 * Keeps only items whose cited paper ids were actually in the prompt, and
 * attaches the excerpt each id contributed.
 *
 * `minEvidence` is 2 for recurring patterns, since a pattern across one paper
 * is not a pattern.
 */
function groundItems(items, { papersById, chunksByPaper, minEvidence = 1 }) {
  const kept = [];
  const dropped = [];

  items.forEach((item) => {
    const validIds = [...new Set(item.supporting_papers)].filter((id) => papersById.has(id));

    if (validIds.length < minEvidence) {
      dropped.push({ name: item.name, reason: validIds.length ? 'not enough supporting papers' : 'no verifiable supporting paper' });
      return;
    }

    const evidence = validIds.map((paperId) => {
      const paper = papersById.get(paperId);
      const chunk = (chunksByPaper.get(paperId) || [])[0];
      return Evidence({
        paperId,
        title: paper.title,
        source: paper.source,
        excerpt: chunk ? chunk.text : paper.abstract,
        year: paper.year,
        url: paper.url
      });
    });

    kept.push({
      name: item.name,
      description: item.description,
      supporting_papers: validIds,
      evidence,
      // Confidence reflects how much of the analysed set supports the item.
      // It is an evidence measure, not a claim about novelty or correctness.
      confidence: Number(Math.min(0.95, 0.45 + 0.12 * validIds.length).toFixed(2))
    });
  });

  return { kept, dropped };
}

/**
 * Runs the analysis.
 *
 * @param {object} researcher normalized Researcher
 * @param {Array}  papers     the papers that were selected for analysis
 * @param {Array}  chunks     retrieved chunks from the vector index
 */
async function analyze({ researcher, papers, chunks }) {
  const papersById = new Map(papers.map((paper) => [paper.id, paper]));
  const chunksByPaper = new Map();
  chunks.forEach((chunk) => {
    if (!chunksByPaper.has(chunk.paper_id)) chunksByPaper.set(chunk.paper_id, []);
    chunksByPaper.get(chunk.paper_id).push(chunk);
  });

  const { data, meta } = await completeJson('analysis', {
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(researcher, chunks),
    validate: validateShape
  });

  const grounding = { kept: 0, dropped: [] };
  const result = {};

  const groundField = (field, minEvidence = 1) => {
    const { kept, dropped } = groundItems(data[field] || [], { papersById, chunksByPaper, minEvidence });
    grounding.kept += kept.length;
    dropped.forEach((entry) => grounding.dropped.push({ field, ...entry }));
    return kept;
  };

  result.research_themes = groundField('research_themes');
  result.topics = groundField('topics');
  result.methods = groundField('methods');
  result.datasets = groundField('datasets');
  result.domains = groundField('domains');
  result.limitations = groundField('limitations');
  result.recurring_patterns = groundField('recurring_patterns', 2);

  // Institutions are not asked of the model: the providers already supply them
  // as real metadata, so they are read straight off the papers.
  const institutionCounts = new Map();
  papers.forEach((paper) => {
    paper.institutions.forEach((name) => institutionCounts.set(name, (institutionCounts.get(name) || 0) + 1));
  });
  researcher.affiliations.forEach((name) => {
    institutionCounts.set(name, (institutionCounts.get(name) || 0) + 1);
  });

  result.institutions = [...institutionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name, count]) => ({ name, paper_count: count, source: 'provider_metadata' }));

  const everyFieldEmpty = EXTRACTION_FIELDS.every((field) => !(result[field] || []).length);

  return {
    researcher_id: researcher.id,
    ...result,
    // Flat evidence list for the Evidence screen.
    evidence: [
      ...result.research_themes,
      ...result.limitations,
      ...result.recurring_patterns
    ].map((item) => ({
      claim: item.description || item.name,
      evidence: item.evidence,
      confidence: item.confidence
    })),
    notes: everyFieldEmpty ? INSUFFICIENT_EVIDENCE : null,
    meta: {
      ...meta,
      papers_analyzed: papers.length,
      excerpts_used: chunks.length,
      items_kept: grounding.kept,
      items_dropped_unverifiable: grounding.dropped.length,
      dropped_detail: grounding.dropped.slice(0, 10)
    }
  };
}

module.exports = { analyze, validateShape, groundItems, buildUserPrompt, SYSTEM_PROMPT };
