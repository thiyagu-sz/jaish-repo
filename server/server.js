require('dotenv').config();

const path = require('path');
const express = require('express');

const researchRoutes = require('./routes/research');
const aiRoutes = require('./routes/ai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/research', researchRoutes);
app.use('/api/ai', aiRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Unknown API routes should return JSON, not the HTML index page.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }));

app.listen(PORT, () => {
  console.log(`ResearchAI running at http://localhost:${PORT}`);
  if (!process.env.OPENAI_API_KEY) {
    console.log('No OPENAI_API_KEY found - AI insights will use Demo Mode.');
  }
});
