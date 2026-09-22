/**
 * OpenRouter configuration.
 *
 * Every language model call in the application goes through OpenRouter, so this
 * is the single place that reads the credentials and decides which model an
 * agent runs on. Both llmClient.js (researcher agents) and aiService.js (paper
 * agents) resolve their configuration here.
 *
 * Environment:
 *   OPENROUTER_API_KEY   the only key needed; blank means every agent is unavailable
 *   OPENROUTER_BASE_URL  defaults to https://openrouter.ai/api/v1
 *   OPENROUTER_MODEL     default model for every agent
 *   <PREFIX>_MODEL       per-agent override, so one agent can run a different model
 *
 * There is no per-agent key or base URL any more: OpenRouter is a single
 * gateway in front of many providers, so one key and one endpoint cover all of
 * them, and the per-agent choice that still matters is the model.
 *
 * The key is read from the environment on every call and is never returned by
 * any function here, so it cannot reach a response body, a log line or the
 * browser.
 */

const PROVIDER_NAME = 'OpenRouter';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'openai/gpt-4o-mini';

function apiKey() {
  return process.env.OPENROUTER_API_KEY || '';
}

function baseUrl() {
  // Trailing slashes would produce a double slash in the request path.
  return (process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** True when a key is present. Nothing is validated against the API here. */
function isConfigured() {
  return Boolean(apiKey());
}

/**
 * Resolves one agent.
 *
 * @param {string} envPrefix e.g. "ANALYSIS" -> ANALYSIS_MODEL
 * @returns {{provider: string, model: string, baseUrl: string, apiKey: string}}
 */
function resolveAgent(envPrefix) {
  return {
    provider: PROVIDER_NAME,
    model: process.env[`${envPrefix}_MODEL`] || process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
    baseUrl: baseUrl(),
    apiKey: apiKey()
  };
}

/**
 * Request headers.
 *
 * HTTP-Referer and X-Title are OpenRouter's optional app attribution headers.
 * They are sent only when configured, and neither carries anything sensitive.
 */
function headers(key) {
  const result = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key || apiKey()}`
  };

  if (process.env.OPENROUTER_SITE_URL) result['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL;
  if (process.env.OPENROUTER_APP_NAME) result['X-Title'] = process.env.OPENROUTER_APP_NAME;

  return result;
}

/** Chat completions endpoint. OpenRouter mirrors the OpenAI request schema. */
function chatCompletionsUrl() {
  return `${baseUrl()}/chat/completions`;
}

/** Embeddings endpoint, used by the retrieval layer. */
function embeddingsUrl() {
  return `${baseUrl()}/embeddings`;
}

/**
 * Whether a model id looks like it is missing its OpenRouter vendor prefix.
 *
 * OpenRouter addresses models as "<vendor>/<model>" ("openai/gpt-4o-mini"),
 * while the direct OpenAI API uses the bare name. A bare name is the most
 * likely mistake when migrating a .env from OpenAI, and it fails at request
 * time with an unhelpful upstream error, so it is worth warning about at boot.
 */
function looksUnprefixed(model) {
  return Boolean(model) && !model.includes('/');
}

module.exports = {
  PROVIDER_NAME,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  apiKey,
  baseUrl,
  isConfigured,
  resolveAgent,
  headers,
  chatCompletionsUrl,
  embeddingsUrl,
  looksUnprefixed
};
