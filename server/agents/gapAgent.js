/**
 * Research Gap Detection Agent.
 *
 * Compares papers against each other to propose candidate research gaps:
 * limitations that recur, combinations that appear underexplored, and
 * directions the work itself points at.
 *
 * The output is deliberately called a *candidate* gap. Nothing here establishes
 * that a gap is unfilled in the wider literature - only this researcher body of
 * work was read. `confidence` measures how well the evidence in that set
 * supports the statement, and is not a novelty score.
 */
const { completeJson } = require('../services/llmClient');
const { Evidence, INSUFFICIENT_EVIDENCE } = require('../models/schemas');

const GAP_TYPES = ['recurring_limitation', 'underexplored_combination', 'methodological', 'evaluation', 'application_domain'];

const SYSTEM_PROMPT = [
  'You are the Research Gap Detection Agent in a research intelligence system.',
  'You are given excerpts from several papers by one researcher, and a summary',
  'of what a previous agent extracted from them.',
  '',
  'Propose candidate research gaps that follow from comparing these papers with',
  'each other. A gap is worth reporting when it is visible in the excerpts: a',
  'limitation stated in more than one paper, an evaluation that is repeatedly',
  'narrow, or a combination of a method and a domain that the work approaches',
  'but never joins.',
  '',
  'Hard rules:',
  '- Use only the excerpts. Do not use outside knowledge of the literature.',
  '- Do not claim a gap is novel or unaddressed elsewhere. You have only read',
  '  these papers. Phrase each gap as what this body of work leaves open.',
  '- Every gap must cite at least two paper ids from the excerpts.',
  '- Never invent a paper id.',
  '- If the excerpts do not support any gap, return an empty array.',
  '',
  'Schema:',
  '{',
  '  "gaps": [{',
  '    "title": string,',
  '    "description": string,',
  '    "type": one of ' + JSON.stringify(GAP_TYPES) + ',',
  '    "related_topics": [string],',
  '    "supporting_papers": [string],',
  '    "reasoning": string',
  '  }]',
  '}'
].join('\n');

function buildUserPrompt({ researcher, chunks, analysis }) {
  const excerpts = chunks
    .map(
      (chunk, index) =>
        `[${index + 1}] paper_id: ${chunk.paper_id}\n` +
        `    title: ${chunk.title}\n` +
        `    year: ${chunk.year ?? 'unknown'}\n` +
        `    excerpt: ${chunk.text}`
    )
    .join('\n\n');

  const names = (items) => (items || []).map((item) => item.name).filter(Boolean).join(', ') || 'none extracted';

  const priorAnalysis = analysis
    ? [
        '',
        'Previously extracted from these same papers:',
        `- themes: ${names(analysis.research_themes)}`,
        `- methods: ${names(analysis.methods)}`,
        `- datasets: ${names(analysis.datasets)}`,
        `- domains: ${names(analysis.domains)}`,
        `- stated limitations: ${names(analysis.limitations)}`
      ].join('\n')
    : '';

  return [
    `Researcher: ${researcher.name}`,
    priorAnalysis,
    '',
    `Excerpts (${chunks.length}):`,
    excerpts
  ]
    .filter(Boolean)
    .join('\n');
}

function validateShape(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'top level value must be a JSON object' };
  }
  if (!Array.isArray(parsed.gaps)) {
    return { ok: false, error: '"gaps" must be an array' };
  }

  const gaps = [];
  for (const gap of parsed.gaps) {
    if (!gap || typeof gap !== 'object') {
      return { ok: false, error: 'every entry in "gaps" must be an object' };
    }
    if (typeof gap.title !== 'string' || !gap.title.trim()) {
      return { ok: false, error: 'a gap is missing a non-empty "title"' };
    }
    if (typeof gap.description !== 'string' || !gap.description.trim()) {
      return { ok: false, error: `gap "${gap.title}" is missing a non-empty "description"` };
    }

    gaps.push({
      title: gap.title.trim(),
      description: gap.description.trim(),
      // An unrecognised type is corrected rather than rejected - it is a label,
      // not a claim, and is not worth spending the retry on.
      type: GAP_TYPES.includes(gap.type) ? gap.type : 'recurring_limitation',
      related_topics: Array.isArray(gap.related_topics)
        ? gap.related_topics.filter((topic) => typeof topic === 'string' && topic.trim()).map((t) => t.trim())
        : [],
      supporting_papers: Array.isArray(gap.supporting_papers)
        ? gap.supporting_papers.filter((id) => typeof id === 'string')
        : [],
      reasoning: typeof gap.reasoning === 'string' ? gap.reasoning.trim() : ''
    });
  }

  return { ok: true, value: { gaps } };
}

/**
 * Confidence from verifiable evidence only.
 *
 * Three inputs: how many of the analysed papers support the gap, how much of
 * the analysed set that represents, and whether the gap restates a limitation
 * the papers stated themselves (which is better grounded than an inference).
 */
function scoreConfidence({ supportCount, analysedCount, echoesStatedLimitation }) {
  const breadth = analysedCount ? supportCount / analysedCount : 0;
  const base = 0.3 + Math.min(0.3, 0.1 * supportCount) + Math.min(0.2, breadth * 0.4);
  const score = base + (echoesStatedLimitation ? 0.12 : 0);
  return Number(Math.min(0.9, score).toFixed(2));
}

/**
 * @param {object} input
 * @param {object} input.researcher
 * @param {Array}  input.papers     papers that were analysed
 * @param {Array}  input.chunks     retrieved excerpts
 * @param {object} input.analysis   optional prior analysis, used as context
 */
async function detectGaps({ researcher, papers, chunks, analysis = null }) {
  const papersById = new Map(papers.map((paper) => [paper.id, paper]));
  const chunksByPaper = new Map();
  chunks.forEach((chunk) => {
    if (!chunksByPaper.has(chunk.paper_id)) chunksByPaper.set(chunk.paper_id, []);
    chunksByPaper.get(chunk.paper_id).push(chunk);
  });

  const statedLimitations = ((analysis && analysis.limitations) || []).map((item) =>
    `${item.name} ${item.description}`.toLowerCase()
  );

  const { data, meta } = await completeJson('gap_detection', {
    system: SYSTEM_PROMPT,
    user: buildUserPrompt({ researcher, chunks, analysis }),
    validate: validateShape
  });

  const dropped = [];

  const gaps = data.gaps
    .map((gap) => {
      const validIds = [...new Set(gap.supporting_papers)].filter((id) => papersById.has(id));

      // A gap standing on one paper is an observation about that paper, not a
      // pattern across the work, so it is not reported as a gap.
      if (validIds.length < 2) {
        dropped.push({
          title: gap.title,
          reason: validIds.length ? 'cited fewer than two verifiable papers' : 'cited no verifiable paper'
        });
        return null;
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

      const haystack = `${gap.title} ${gap.description}`.toLowerCase();
      const echoesStatedLimitation = statedLimitations.some((limitation) => {
        const words = limitation.split(/\s+/).filter((word) => word.length > 5);
        return words.length > 0 && words.some((word) => haystack.includes(word));
      });

      return {
        title: gap.title,
        description: gap.description,
        type: gap.type,
        related_topics: gap.related_topics,
        supporting_papers: validIds,
        evidence,
        reasoning: gap.reasoning,
        confidence: scoreConfidence({
          supportCount: validIds.length,
          analysedCount: papers.length,
          echoesStatedLimitation
        })
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence);

  return {
    researcher_id: researcher.id,
    gaps,
    notes: gaps.length ? null : INSUFFICIENT_EVIDENCE,
    // Stated on every response so the wording is never left to the frontend.
    disclaimer:
      'Candidate gaps are derived only from the papers listed above. ' +
      'Confidence describes how well those papers support the statement; ' +
      'it is not evidence that the gap is unaddressed in the wider literature.',
    meta: {
      ...meta,
      papers_analyzed: papers.length,
      excerpts_used: chunks.length,
      gaps_proposed: data.gaps.length,
      gaps_dropped_unverifiable: dropped.length,
      dropped_detail: dropped.slice(0, 10)
    }
  };
}

module.exports = { detectGaps, validateShape, scoreConfidence, buildUserPrompt, GAP_TYPES, SYSTEM_PROMPT };
