/**
 * Express application.
 *
 * Kept separate from server.js so tests can mount the app without binding a
 * port. server.js remains the entry point that `npm start` runs.
 */
const path = require('path');
const express = require('express');

const researchRoutes = require('./routes/research');
const aiRoutes = require('./routes/ai');
const researcherRoutes = require('./routes/researchers');

const { newRequestId, sendError, ApiError } = require('./lib/httpErrors');
const { listProviders } = require('./providers');
const providerHealth = require('./lib/providerHealth');
const llmClient = require('./services/llmClient');
const openRouter = require('./services/openRouter');
const cache = require('./services/cache');

const app = express();

// Every request carries an id, so an error the user sees can be matched to a
// server log line without exposing anything about the failure itself.
app.use((req, res, next) => {
  res.locals.requestId = newRequestId();
  res.setHeader('X-Request-Id', res.locals.requestId);
  next();
});

app.use(express.json({ limit: '1mb' }));

// A body that is not valid JSON is a client error, not a 500.
app.use((error, req, res, next) => {
  if (error && error.type === 'entity.parse.failed') {
    return sendError(res, new ApiError('VALIDATION_FAILED', 'request body was not valid JSON'));
  }
  if (error && error.type === 'entity.too.large') {
    return sendError(res, new ApiError('VALIDATION_FAILED', 'request body exceeded the size limit'));
  }
  return next(error);
});

app.use(express.static(path.join(__dirname, '..', 'public')));

/**
 * GET /api/health
 *
 * Reports which providers are registered, which language model gateway is in
 * use, and which analysis agents have a key. It never reports the key itself,
 * only whether one is present.
 */
app.get('/api/health', (_req, res) => {
  const agents = llmClient.agentStatus();

  res.json({
    status: 'ok',
    providers: listProviders(),
    // Which scholarly sources are usable right now. A source that rate limited
    // us reports how long it is being skipped for.
    provider_health: providerHealth.status(),
    llm: {
      provider: openRouter.PROVIDER_NAME,
      base_url: openRouter.baseUrl(),
      default_model: process.env.OPENROUTER_MODEL || openRouter.DEFAULT_MODEL,
      configured: openRouter.isConfigured()
    },
    agents,
    // Named explicitly so the frontend can disable the analysis actions up
    // front instead of discovering it through a failed request.
    analysis_available: agents.every((agent) => agent.configured),
    cache: cache.stats()
  });
});

app.use('/api/research', researchRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/researchers', researcherRoutes);

// Unknown API routes should return JSON, not the HTML index page.
app.use('/api', (_req, res) => {
  sendError(res, new ApiError('ENDPOINT_NOT_FOUND', 'no route matched'));
});

// Last-resort handler. Anything reaching here is a bug, so the detail is logged
// and a generic 500 is returned.
// eslint-disable-next-line no-unused-vars
app.use((error, _req, res, _next) => {
  sendError(res, error);
});

module.exports = app;
