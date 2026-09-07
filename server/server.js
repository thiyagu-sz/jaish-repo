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

const { agentStatus } = require('./services/aiService');

app.listen(PORT, () => {
  console.log(`ResearchAI running at http://localhost:${PORT}`);

  // Show which agent runs on which model, so config mistakes are obvious.
  console.log('\nAgents:');
  agentStatus().forEach(({ agent, model, configured }) => {
    console.log(`  ${agent.padEnd(22)} ${model.padEnd(16)} ${configured ? 'live' : 'Demo Mode (no key)'}`);
  });

  if (!agentStatus().some((a) => a.configured)) {
    console.log('\nAdd OPENAI_API_KEY to .env to enable real AI responses.');
  }
  console.log('');
});
