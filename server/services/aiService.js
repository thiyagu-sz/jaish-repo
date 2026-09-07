/**
 * AI insight generation, organised as three small "agents".
 *
 * Each agent has its own prompt, temperature and model, and can even point at a
 * different provider. This is the simple, single-process ancestor of the
 * multi-agent architecture described in the project specification.
 *
 * Model resolution per agent (first value that is set wins):
 *   <PREFIX>_MODEL     ->  OPENAI_MODEL     ->  'gpt-4o-mini'
 *   <PREFIX>_BASE_URL  ->  OPENAI_BASE_URL  ->  OpenAI
 *   <PREFIX>_API_KEY   ->  OPENAI_API_KEY   ->  (none, so Demo Mode)
 *
 * Falls back to written demo text when a key is missing or a call fails, so the
 * app is always demonstrable.
 */
const REQUEST_TIMEOUT_MS = 30000;

const FALLBACK_MODEL = 'gpt-4o-mini';
const FALLBACK_BASE_URL = 'https://api.openai.com/v1';

const AGENTS = {
  summary: {
    agent: 'Summarization Agent',
    label: 'AI Summary',
    env: 'SUMMARY',
    temperature: 0.3,
    prompt:
      'Summarize this research paper for a university student. Give: 1. Problem, 2. Method, ' +
      '3. Main findings, 4. Important takeaway. Use short plain-text sections with dash bullets. ' +
      'If the abstract is missing information, say so instead of inventing details.'
  },
  gap: {
    agent: 'Gap Analysis Agent',
    label: 'Research Gap',
    env: 'GAP',
    temperature: 0.5,
    prompt:
      'Analyze the provided paper information and identify potential research limitations, ' +
      'unexplored areas, or possible research gaps. Give 3 to 4 dash bullets. Clearly state that ' +
      'these are AI-generated hypotheses that should be verified against the original paper.'
  },
  idea: {
    agent: 'Innovation Agent',
    label: 'Research Idea',
    env: 'IDEA',
    temperature: 0.7,
    prompt:
      'Based on the paper and its likely limitations, suggest 3 possible research directions. ' +
      'For each, give a one-line direction and a one-line reason it is worth exploring. ' +
      'Do not claim that they are guaranteed novel.'
  }
};

const AGENT_TYPES = Object.keys(AGENTS);

/** Resolves one agent's model, endpoint and key from the environment. */
function resolveAgent(type) {
  const agent = AGENTS[type];
  const prefix = agent.env;

  return {
    ...agent,
    type,
    model: process.env[`${prefix}_MODEL`] || process.env.OPENAI_MODEL || FALLBACK_MODEL,
    baseUrl: process.env[`${prefix}_BASE_URL`] || process.env.OPENAI_BASE_URL || FALLBACK_BASE_URL,
    apiKey: process.env[`${prefix}_API_KEY`] || process.env.OPENAI_API_KEY || ''
  };
}

/** True when at least one agent has a usable key. */
function isConfigured() {
  return AGENT_TYPES.some((type) => Boolean(resolveAgent(type).apiKey));
}

/**
 * Per-agent status for the UI. Never includes keys - only whether one is present.
 */
function agentStatus() {
  return AGENT_TYPES.map((type) => {
    const { agent, label, model } = resolveAgent(type);
    return { type, agent, label, model, configured: Boolean(resolveAgent(type).apiKey) };
  });
}

function buildUserMessage({ title, abstract, authors, year }) {
  return [
    `Title: ${title || 'Unknown'}`,
    authors ? `Authors: ${authors}` : '',
    year ? `Year: ${year}` : '',
    `Abstract: ${abstract || 'No abstract available.'}`
  ]
    .filter(Boolean)
    .join('\n');
}

async function callLlm(config, paper) {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature,
      max_tokens: 600,
      messages: [
        {
          role: 'system',
          content:
            `You are the ${config.agent} in a research assistance system. ` +
            'Be concise, factual and plain-spoken. ' +
            'Never invent findings that are not supported by the provided text.'
        },
        { role: 'user', content: `${config.prompt}\n\n${buildUserMessage(paper)}` }
      ]
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`LLM request failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('LLM returned an empty response.');
  return text;
}

/** Written fallback text so Demo Mode still shows a meaningful, honest response. */
function demoInsight(type, { title = 'this paper', abstract = '' }) {
  const topic = title.length > 90 ? `${title.slice(0, 90)}...` : title;
  const hasAbstract = abstract.trim().length > 0;

  if (type === 'summary') {
    return [
      'Key Points',
      `- Problem: "${topic}" addresses a gap between reported results and practical use in its field.`,
      '- Method: the authors combine a literature/benchmark study with an evaluation on public data.',
      '- Main findings: measurable improvements are reported, but they depend heavily on setup and dataset choice.',
      '- Takeaway: the direction is promising, though evaluation conditions limit how far the results generalise.',
      '',
      hasAbstract
        ? 'Demo Mode: this summary is sample text, not a real model output. Read the abstract above for the actual content.'
        : 'Demo Mode: this summary is sample text. No abstract was available for this record.'
    ].join('\n');
  }

  if (type === 'gap') {
    return [
      'Potential limitation or unexplored area:',
      '- Evaluation appears limited to a small number of datasets or a single institutional context.',
      '- Long-term or real-world outcomes are not measured; most evidence is short-term.',
      '- Generalisation across domains, languages or populations is not established.',
      '- Reproducibility details (data splits, hyper-parameters, cost) may be incomplete.',
      '',
      'Demo Mode: these are sample AI-generated hypotheses, not verified findings. Confirm them against the original paper.'
    ].join('\n');
  }

  return [
    'Possible direction:',
    '1. Replicate the study on an independent, time-ordered dataset to test whether the reported gains hold.',
    '2. Extend the approach to a second domain and report where performance degrades and why.',
    '3. Add a cost and latency analysis so the method can be compared against simpler baselines fairly.',
    '',
    'Demo Mode: these are sample directions and are not claimed to be novel.'
  ].join('\n');
}

/**
 * Runs one agent. Always resolves - callers never need a try/catch for
 * "the key is missing" or "the provider is down".
 */
async function generateInsight(type, paper) {
  const validType = AGENTS[type] ? type : 'summary';
  const config = resolveAgent(validType);

  const base = { type: validType, agent: config.agent, label: config.label };

  if (!config.apiKey) {
    return { ...base, model: null, text: demoInsight(validType, paper), demoMode: true };
  }

  try {
    const text = await callLlm(config, paper);
    return { ...base, model: config.model, text, demoMode: false };
  } catch (error) {
    console.warn(`[ai] ${config.agent} (${config.model}) failed, using demo response:`, error.message);
    return { ...base, model: null, text: demoInsight(validType, paper), demoMode: true };
  }
}

module.exports = { generateInsight, isConfigured, agentStatus, AGENT_TYPES };
