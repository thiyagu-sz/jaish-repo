const express = require('express');
const { generateInsight, isConfigured } = require('../services/aiService');

const router = express.Router();

const VALID_TYPES = ['summary', 'gap', 'idea'];

/**
 * POST /api/ai
 * Body: { type: "summary" | "gap" | "idea", title, abstract, authors?, year? }
 */
router.post('/', async (req, res) => {
  const { type, title, abstract, authors, year } = req.body || {};

  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
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

/** Lets the frontend show a Demo Mode badge without exposing any key. */
router.get('/status', (_req, res) => {
  res.json({ aiConfigured: isConfigured() });
});

module.exports = router;
