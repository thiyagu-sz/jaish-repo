# ResearchAI

**Search. Understand. Discover.**

An AI-powered research discovery assistant. Search research papers by topic, read
AI-generated summaries, ask for possible research gaps, and explore new research
directions — all from one search box.

This is a working MVP prototype. It is a deliberately simplified version of a larger
research concept (a Multi-Agent Research Innovation Discovery System combining LLMs,
retrieval-augmented generation, knowledge graphs and multi-agent systems).

---

## Features

- **Research paper search** across OpenAlex, Semantic Scholar and arXiv
- **AI paper summaries** — problem, method, findings, takeaway
- **Research gap analysis** — possible limitations and unexplored areas
- **Research idea generation** — three possible directions to explore
- **Filters** — source, publication year, and relevance/newest sorting
- **Per-agent models** — each AI action can run on a different model, or a different provider
- **Demo mode** — the app works fully without any API keys

---

## Architecture

```
Browser  (public/)
   |  fetch /api/research  and  /api/ai
   v
Simple API server  (server/ - Express)
   |
   +--> Research API  (OpenAlex / Semantic Scholar / arXiv)
   |
   +--> Agents        each with its own prompt and model
         |
         +--> Summarization Agent  --> LLM (SUMMARY_MODEL)
         +--> Gap Analysis Agent   --> LLM (GAP_MODEL)
         +--> Innovation Agent     --> LLM (IDEA_MODEL)
```

The browser never calls a third-party API directly and never sees an API key.
All external calls happen on the server, using values from `.env`.

If a call fails or a key is missing, the server returns clearly-labelled demo
content instead of an error, so the app never breaks during a demonstration.

---

## Tech Stack

| Layer     | Technology                                  |
| --------- | ------------------------------------------- |
| Frontend  | HTML, CSS, vanilla JavaScript (no framework) |
| Backend   | Node.js, Express                            |
| Research  | OpenAlex, Semantic Scholar, arXiv           |
| AI        | OpenAI-compatible chat completions API      |
| Config    | dotenv                                      |

Only two runtime dependencies: `express` and `dotenv`.

---

## Installation

```bash
git clone <repository-url>
cd research-ai

npm install

# Windows
copy .env.example .env
# macOS / Linux
cp .env.example .env
```

Add your API keys to `.env` (optional — see Demo Mode), then:

```bash
npm start
```

Open <http://localhost:3000>.

Requires **Node.js 18 or newer** (the server uses the built-in `fetch`).

A beginner-friendly, step-by-step version of this is in [SETUP.md](SETUP.md).

---

## Agents and models

The three AI actions are handled by three small agents. Each one has its own prompt,
its own temperature, and **its own model** — and can even point at a different provider.

| Action | Agent | Temperature | Env prefix |
| --- | --- | --- | --- |
| Summarize Paper | Summarization Agent | 0.3 (factual) | `SUMMARY_` |
| Find Research Gaps | Gap Analysis Agent | 0.5 | `GAP_` |
| Generate Research Ideas | Innovation Agent | 0.7 (exploratory) | `IDEA_` |

Give each agent a different model in `.env`:

```bash
OPENAI_API_KEY=your-key
OPENAI_MODEL=gpt-4o-mini     # shared default

SUMMARY_MODEL=gpt-4o         # stronger model for reading comprehension
GAP_MODEL=o4-mini            # reasoning model for critique
IDEA_MODEL=gpt-4.1           # creative model for brainstorming
```

An agent can also use a **different provider** entirely, as long as it speaks the
OpenAI chat-completions format (Groq, Together, OpenRouter, a local Ollama, …):

```bash
IDEA_BASE_URL=https://api.groq.com/openai/v1
IDEA_API_KEY=your-groq-key
IDEA_MODEL=llama-3.3-70b-versatile
```

Resolution order per agent — the first value that is set wins:

```
<PREFIX>_MODEL     ->  OPENAI_MODEL     ->  gpt-4o-mini
<PREFIX>_BASE_URL  ->  OPENAI_BASE_URL  ->  https://api.openai.com/v1
<PREFIX>_API_KEY   ->  OPENAI_API_KEY   ->  (none, so that agent runs in Demo Mode)
```

Agents are independent: if only `IDEA_API_KEY` is set, the Innovation Agent runs live
while the other two stay in Demo Mode. The UI shows which agent answered and which
model it used, next to each result.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in what you need. Every variable is optional —
the app starts and runs without any of them.

| Variable                    | Required | Purpose                                                                                     |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`            | No       | Shared key for all agents. Without it, AI responses run in Demo Mode.                        |
| `OPENAI_MODEL`              | No       | Shared default model. Defaults to `gpt-4o-mini`.                                             |
| `OPENAI_BASE_URL`           | No       | Shared endpoint for an OpenAI-compatible provider. Defaults to `https://api.openai.com/v1`.  |
| `SUMMARY_MODEL` / `_BASE_URL` / `_API_KEY` | No | Per-agent override for the Summarization Agent.                              |
| `GAP_MODEL` / `_BASE_URL` / `_API_KEY`     | No | Per-agent override for the Gap Analysis Agent.                               |
| `IDEA_MODEL` / `_BASE_URL` / `_API_KEY`    | No | Per-agent override for the Innovation Agent.                                 |
| `SEMANTIC_SCHOLAR_API_KEY`  | No       | Raises the Semantic Scholar rate limit. Without it that source is often rate-limited (429).  |
| `CONTACT_EMAIL`             | No       | Sent to OpenAlex to join their faster "polite pool".                                          |
| `PORT`                      | No       | Server port. Defaults to `3000`.                                                             |

**OpenAlex needs no key at all**, which is why it is the primary search source.

`.env` is listed in `.gitignore` and must never be committed.

---

## Demo Mode

The app is designed to be demonstrable before any keys are configured.

**AI insights** fall back to sample text when an agent has no key *or* when its LLM
call fails. This is decided **per agent**, so one agent can run live while another stays
in Demo Mode. **Paper search** falls back to six built-in sample papers when every
scholarly source fails (offline, rate-limited, or blocked).

Demo content is always labelled with a **Demo Mode** badge in the interface, and demo
search results show the banner *"Unable to retrieve papers. Showing demo results."*

To leave demo mode: add a valid `OPENAI_API_KEY` (or a per-agent `*_API_KEY`) to `.env`
and restart the server.
Paper search leaves demo mode automatically as soon as a source responds.

---

## API Endpoints

### `GET /api/research`

| Query param | Values                                                 | Default     |
| ----------- | ------------------------------------------------------ | ----------- |
| `q`         | search text (required)                                 | —           |
| `source`    | `all`, `openalex`, `semanticscholar`, `arxiv`          | `all`       |
| `year`      | a four-digit year                                      | any         |
| `sort`      | `relevance`, `newest`                                  | `relevance` |

```jsonc
{
  "query": "knowledge graphs",
  "count": 20,
  "papers": [
    {
      "title": "...",
      "authors": ["..."],
      "year": 2024,
      "abstract": "...",
      "source": "OpenAlex",
      "url": "https://doi.org/..."
    }
  ],
  "demoMode": false,
  "source": "all"
}
```

### `POST /api/ai`

```jsonc
// request
{ "type": "summary", "title": "...", "abstract": "..." }
// type: "summary" | "gap" | "idea" - each routed to its own agent

// response
{
  "type": "summary",
  "agent": "Summarization Agent",
  "label": "AI Summary",
  "model": "gpt-4o",        // null in Demo Mode, since no model ran
  "text": "...",
  "demoMode": false
}
```

### `GET /api/ai/status`

Reports every agent and the model it is configured to use. Never exposes a key or an
endpoint URL.

```jsonc
{
  "aiConfigured": true,
  "agents": [
    { "type": "summary", "agent": "Summarization Agent", "label": "AI Summary",   "model": "gpt-4o",  "configured": true },
    { "type": "gap",     "agent": "Gap Analysis Agent",  "label": "Research Gap",  "model": "o4-mini", "configured": true },
    { "type": "idea",    "agent": "Innovation Agent",    "label": "Research Idea", "model": "gpt-4.1", "configured": true }
  ]
}
```

### `GET /api/health`

Returns `{ "status": "ok" }`.

---

## Project Structure

```
research-ai/
├── public/
│   ├── index.html          Landing page (hero, features, how it works, about)
│   ├── research.html       Search page, results and paper detail panel
│   ├── css/
│   │   └── style.css       All styling and design tokens
│   └── js/
│       ├── app.js          Page wiring, search flow, detail panel
│       ├── search.js       Calls to our own backend API
│       └── ui.js           Rendering helpers and HTML escaping
├── server/
│   ├── server.js           Express app and static file serving
│   ├── routes/
│   │   ├── research.js     GET  /api/research
│   │   └── ai.js           POST /api/ai
│   └── services/
│       ├── researchApi.js  OpenAlex / Semantic Scholar / arXiv + normalization
│       ├── aiService.js    LLM prompts and demo fallbacks
│       └── demoData.js     Sample papers for demo mode
├── .env.example
├── .gitignore
├── package.json
├── README.md
├── SETUP.md
└── LICENSE
```

---

## Future Scope

Not implemented in this MVP. These are the next steps toward the full system:

- True multi-agent orchestration: agents that plan, call each other and share memory
  (this MVP has three independent single-shot agents, each with its own model)
- A full RAG pipeline over paper full text
- Vector database for embeddings (ChromaDB)
- Neo4j knowledge graph of papers, authors, methods and datasets
- User accounts and saved searches
- Search history
- PDF export
- Automated research proposal generation
- More scholarly APIs (Papers with Code, CORE, Crossref)
- Citation analysis and impact metrics

---

## Disclaimer

Research results and AI-generated insights are intended for research assistance and
should be independently verified. AI-generated summaries, research gaps and research
ideas are hypotheses, not established findings, and are not claimed to be novel.

---

## License

MIT — see [LICENSE](LICENSE).
