const express = require('express');
const { generateInsight, isConfigured, agentStatus, AGENT_TYPES } = require('../services/aiService');

const router = express.Router();

/**
 * POST /api/ai
 * Body: { type: "summary" | "gap" | "idea", title, abstract, authors?, year? }
 * Each type is handled by its own agent, with its own model.
 */
router.post('/', async (req, res) => {
  const { type, title, abstract, authors, year } = req.body || {};

  if (!AGENT_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${AGENT_TYPES.join(', ')}` });
  }
  if (!title && !abstract) {
    return res.status(400).json({ error: 'A paper title or abstract is required.' });
  }

  try {
    const result = await generateInsight(type, {
      title: String(title || '').slice(0, 500),
      abstract: String(abstract || '').slice(0, 6000),
      authors: Array.isArray(authors) ? authors.join(', ') : String(authors || ''),
      year: year || ''
    });
    res.json(result);
  } catch (error) {
    console.error('[ai] unexpected error:', error.message);
    res.status(500).json({ error: 'Unable to generate an AI response right now.' });
  }
});

/**
 * Lets the frontend show which agent runs on which model, and whether each one
 * is live or in Demo Mode. Never exposes an API key.
 */
router.get('/status', (_req, res) => {
  res.json({ aiConfigured: isConfigured(), agents: agentStatus() });
});

module.exports = router;
