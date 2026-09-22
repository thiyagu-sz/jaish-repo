/**
 * Structured language model access for the research agents.
 *
 * All model calls are routed through OpenRouter; see services/openRouter.js for
 * how an agent resolves its model and credentials. An agent picks up
 * OPENROUTER_MODEL unless it has its own <PREFIX>_MODEL override.
 *
 * Unlike aiService, nothing here falls back to written demo text. These agents
 * produce research claims, so an unavailable model is reported as an error and
 * never replaced by plausible-looking output.
 *
 * Every call goes through completeJson(), which asks for JSON, parses it and
 * runs a caller-supplied validator. Malformed or invalid output is retried once
 * with the validation error fed back, then raised as LLM_INVALID_OUTPUT.
 */
const { ApiError } = require('../lib/httpErrors');
const openRouter = require('./openRouter');

const REQUEST_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 45000);

/** Agent registry. `env` is the environment variable prefix for that agent. */
const AGENTS = {
  analysis: {
    key: 'analysis',
    name: 'Research Analysis Agent',
    env: 'ANALYSIS',
    temperature: 0.2,
    maxTokens: 2000
  },
  gap_detection: {
    key: 'gap_detection',
    name: 'Research Gap Detection Agent',
    env: 'GAP_DETECTION',
    temperature: 0.3,
    maxTokens: 2000
  }
};

function resolve(agentKey) {
  const agent = AGENTS[agentKey];
  if (!agent) throw new ApiError('INTERNAL_ERROR', `unknown agent "${agentKey}"`);

  return { ...agent, ...openRouter.resolveAgent(agent.env) };
}

function isAgentConfigured(agentKey) {
  return Boolean(resolve(agentKey).apiKey);
}

/** Per-agent status for /api/health. Reports presence of a key, never the key. */
function agentStatus() {
  return Object.keys(AGENTS).map((key) => {
    const config = resolve(key);
    return {
      agent: config.name,
      key,
      provider: config.provider,
      model: config.model,
      configured: Boolean(config.apiKey)
    };
  });
}

/** ------------------------------------------------------------- transport */

async function chat(config, messages) {
  let response;

  try {
    response = await fetch(openRouter.chatCompletionsUrl(), {
      method: 'POST',
      headers: openRouter.headers(config.apiKey),
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        // Ask for machine-readable output rather than parsing prose. Providers
        // that do not support this parameter still get the instruction in the
        // system prompt below.
        response_format: { type: 'json_object' },
        messages
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ApiError('LLM_TIMEOUT', `${config.name} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw new ApiError('LLM_UNAVAILABLE', `${config.name}: ${error?.message}`);
  }

  if (response.status === 429) {
    throw new ApiError('PROVIDER_RATE_LIMITED', `${config.name}: ${config.provider} rate limited the request`);
  }

  // OpenRouter returns 408/504 when an upstream model provider stalls, which is
  // a timeout rather than a generic failure and deserves the same code as our
  // own client-side timeout.
  if (response.status === 408 || response.status === 504) {
    throw new ApiError('LLM_TIMEOUT', `${config.name}: ${config.provider} returned ${response.status}`);
  }

  if (!response.ok) {
    // The upstream body can echo configuration detail, so it is logged by the
    // error handler but never returned to the browser.
    const detail = await response.text().catch(() => '');
    throw new ApiError(
      'LLM_UNAVAILABLE',
      `${config.name}: ${config.provider} returned ${response.status}: ${detail.slice(0, 300)}`
    );
  }

  const data = await response.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;

  if (!content || !content.trim()) {
    throw new ApiError('LLM_INVALID_OUTPUT', `${config.name} returned an empty message`);
  }
  return content.trim();
}

/**
 * Tolerant JSON extraction. Models occasionally wrap JSON in a fenced block
 * even when asked not to; that is recoverable and not worth a retry.
 */
function parseJson(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();

  try {
    return JSON.parse(candidate);
  } catch {
    // Last resort: the outermost object in the string.
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(candidate.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Runs an agent and returns validated structured output.
 *
 * @param {string}   agentKey
 * @param {object}   options
 * @param {string}   options.system     system prompt
 * @param {string}   options.user       user prompt
 * @param {function} options.validate   (parsed) => ({ ok, value } | { ok:false, error })
 * @returns {Promise<{data: object, meta: object}>}
 */
async function completeJson(agentKey, { system, user, validate }) {
  const config = resolve(agentKey);

  if (!config.apiKey) {
    throw new ApiError(
      'LLM_NOT_CONFIGURED',
      `${config.name} has no ${config.provider} key (set OPENROUTER_API_KEY)`
    );
  }

  const systemPrompt =
    `${system}\n\n` +
    'Respond with a single valid JSON object and nothing else. No prose, no markdown fence.';

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: user }
  ];

  let lastError = '';

  // One attempt, then one repair attempt that is told what was wrong.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const raw = await chat(config, messages);
    const parsed = parseJson(raw);

    if (parsed === null) {
      lastError = 'response was not parseable JSON';
    } else {
      const result = validate(parsed);
      if (result.ok) {
        return {
          data: result.value,
          meta: { agent: config.name, provider: config.provider, model: config.model, attempts: attempt }
        };
      }
      lastError = result.error;
    }

    if (attempt === 1) {
      console.warn(`[llm] ${config.name} output rejected (${lastError}); retrying once`);
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content:
          `That response was rejected: ${lastError}. ` +
          'Return the corrected JSON object only, matching the schema exactly.'
      });
    }
  }

  throw new ApiError('LLM_INVALID_OUTPUT', `${config.name} failed validation twice: ${lastError}`);
}

module.exports = { AGENTS, resolve, isAgentConfigured, agentStatus, completeJson, parseJson };
