const express = require('express');
const { searchPapers } = require('../services/researchApi');

const router = express.Router();

/**
 * GET /api/research?q=...&source=all&year=2025&sort=relevance
 */
router.get('/', async (req, res) => {
  const query = String(req.query.q || '').trim();

  if (!query) {
    return res.status(400).json({ error: 'Please provide a search query.', papers: [] });
  }

  try {
    const result = await searchPapers(query, {
      source: String(req.query.source || 'all').toLowerCase(),
      year: String(req.query.year || '').trim(),
      sort: String(req.query.sort || 'relevance').toLowerCase()
    });

    res.json({ query, count: result.papers.length, ...result });
  } catch (error) {
    console.error('[research] unexpected error:', error.message);
    res.status(500).json({ error: 'Unable to retrieve papers.', papers: [], demoMode: false });
  }
});

module.exports = router;
