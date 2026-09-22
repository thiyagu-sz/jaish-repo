/**
 * Entry point. Loads configuration, then starts the HTTP server.
 * The application itself lives in app.js so it can be tested without a port.
 */
require('dotenv').config();

const app = require('./app');
const { listProviders } = require('./providers');
const llmClient = require('./services/llmClient');
const openRouter = require('./services/openRouter');
const { agentStatus: paperAgentStatus } = require('./services/aiService');

const PORT = process.env.PORT || 3000;

/**
 * Prints one agent as provider / model / availability.
 * The key itself is never printed - only whether one was found.
 */
function printAgent({ agent, provider, model, configured }) {
  console.log(`  ${agent}`);
  console.log(`      ${provider}`);
  console.log(`      ${model}`);
  console.log(`      ${configured ? 'available' : 'unavailable'}`);
}

app.listen(PORT, () => {
  console.log(`ResearchAI running at http://localhost:${PORT}`);

  console.log('\nResearch providers:');
  listProviders().forEach(({ source, name }) => {
    console.log(`  ${name.padEnd(20)} ${source}`);
  });

  console.log(`\nLanguage model gateway: ${openRouter.PROVIDER_NAME} (${openRouter.baseUrl()})`);

  const researcherAgents = llmClient.agentStatus();
  const paperAgents = paperAgentStatus();

  console.log('\nResearcher agents (/api/researchers):');
  researcherAgents.forEach(printAgent);

  console.log('\nPaper agents (/api/ai):');
  paperAgents.forEach(printAgent);

  if (!openRouter.isConfigured()) {
    console.log(
      '\nNo OPENROUTER_API_KEY found.\n' +
      'Researcher search, paper retrieval and the knowledge graph work without one.\n' +
      'Analysis and gap detection return HTTP 503 until a key is set in .env.\n' +
      'Get a key at https://openrouter.ai/keys'
    );
  }

  // A model id copied from an OpenAI setup will not resolve on OpenRouter,
  // which addresses models as "<vendor>/<model>". Worth saying at boot rather
  // than leaving it to a confusing 4xx on the first analysis request.
  const unprefixed = [...researcherAgents, ...paperAgents]
    .filter((entry) => openRouter.looksUnprefixed(entry.model))
    .map((entry) => `${entry.agent} -> ${entry.model}`);

  if (unprefixed.length) {
    console.log(
      `\nWarning: ${openRouter.PROVIDER_NAME} expects model ids as "<vendor>/<model>",\n` +
      'for example "openai/gpt-4o-mini". These look unprefixed and will likely fail:\n' +
      unprefixed.map((line) => `  ${line}`).join('\n')
    );
  }

  console.log('');
});
