# ResearchAI — Research Innovation Discovery System

A research intelligence prototype that takes you from a **researcher's name** to a set of
**evidence-backed candidate research gaps**, by way of their real publications, a
retrieval step, language-model analysis, and a knowledge graph.

## What problem does this solve?

Before choosing a research direction you normally have to read a large number of papers,
hold them all in your head, and spot what they collectively leave unanswered. That is
slow, and it is easy to miss a pattern that only appears across several papers at once.

This system does the mechanical part of that work. Give it a researcher's name and it
will:

1. find that person in a scholarly database,
2. retrieve their real publications,
3. pull out the passages that matter,
4. summarise the themes, methods and datasets that recur across their work,
5. draw the relationships as a knowledge graph,
6. propose **candidate** research gaps — always showing which papers and which exact
   sentences each suggestion came from.

The emphasis throughout is **traceability**. Every generated statement names the papers
behind it, and anything the system cannot trace back to a retrieved paper is discarded
rather than displayed.

> **This is a dissertation prototype, not a production research tool.** Candidate gaps
> are drawn only from the papers the system actually read. They are starting points for
> investigation, not evidence that a gap is unaddressed in the wider literature.

---

## Table of contents

- [What the project does](#what-the-project-does)
- [Real data vs demo / test data](#real-data-vs-demo--test-data)
- [Features](#features)
- [Tech stack](#tech-stack)
- [System architecture](#system-architecture)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Frontend pages](#frontend-pages)
- [API reference](#api-reference)
- [Error handling](#error-handling)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Planned / not implemented](#planned--not-implemented)

---

## What the project does

```text
                    User
                      |
                      v
            Researcher Search            "Yoshua Bengio"
                      |
                      v
            Scholarly Provider           Semantic Scholar -> OpenAlex fallback
                      |
                      v
             Paper Retrieval             up to 40 real publications
                      |
                      v
             Paper Selection             keep papers that have abstracts,
                      |                  rank by citations then recency
                      v
                  Chunking               abstracts split into ~700-char passages
                      |
                      v
                Embeddings               OpenRouter /embeddings
                      |                  (local fallback if unavailable)
                      v
      Vector Similarity Retrieval        cosine similarity, top-k per question
                      |
                      v
                     RAG                 only retrieved passages enter the prompt
                      |
                      v
          LLM Research Analysis          OpenRouter chat completions, JSON output
                      |
                      v
        Candidate Gap Detection          compares papers against one another
                      |
                      v
             Knowledge Graph             nodes + edges built from the analysis
                      |
                      v
          Evidence / Visualization       every claim linked to papers + excerpts
```

### Each stage in plain language

**1. Researcher search.** You type a name. A small rule-based agent decides whether the
text looks like a person or a topic, strips titles such as "Dr.", and normalises it. This
step uses **no** language model — deciding that "Yoshua Bengio" is a name does not need
one.

**2. Scholarly provider.** The backend calls a real scholarly API and converts the
response into the project's own internal format, so nothing downstream depends on a
particular provider's field names.

**3. Paper retrieval.** The selected researcher's publications are fetched — titles,
authors, years, venues, citation counts, DOIs, open-access links and abstracts.

**4. Paper selection.** Only papers with a usable abstract can be analysed, so papers
without one are excluded and counted. The rest are ranked by citation count, then by
recency, and the top 12 (default) are kept.

**5. Chunking.** Each abstract is split on sentence boundaries into passages of roughly
700 characters. Every passage remembers which paper it came from — this is what makes
evidence traceable later.

**6. Embeddings.** Each passage is turned into a numeric vector. With an OpenRouter key
configured this calls OpenRouter's `/embeddings` endpoint. If that is unavailable the
system falls back to a locally computed lexical vector and **says so** in the response.

**7. Vector similarity retrieval.** Four questions are put to the index — about themes,
methods, datasets and limitations. For each, the most similar passages are retrieved,
capped per paper so one prolific paper cannot dominate.

**8. RAG.** Only those retrieved passages go into the prompt. The model is never shown
the whole corpus, and never shown text the system invented.

**9. LLM research analysis.** A language model extracts themes, topics, methods,
datasets, domains, stated limitations and recurring patterns. It must return JSON
matching a fixed schema, and must name the supporting papers for every item.

**10. Candidate gap detection.** A second agent compares the papers against each other
and proposes candidate gaps — recurring limitations, narrow evaluations, combinations the
work approaches but never joins.

**11. Knowledge graph.** The result is projected into nodes and edges. Two graphs are
available: one built from provider metadata (works without any AI), and one built from
the analysis output (includes methods, datasets and candidate gaps).

**12. Evidence / visualization.** The frontend shows each claim with the papers and exact
excerpts it came from.

### How the pieces differ

| Concept | What it means here |
|---|---|
| **Retrieval from providers** | Network calls to scholarly APIs for real bibliographic records |
| **RAG** | Chunking + embedding + similarity search, so the model only sees relevant real passages |
| **LLM generation** | The only step that produces new text; constrained to JSON and to citing retrieved papers |
| **Knowledge graph** | A structural projection. Generates no new claims — only rearranges what earlier stages produced |
| **Candidate gap detection** | A separate LLM pass that reasons *across* papers rather than within one |

### Evidence verification

Every extracted item names the papers it came from. Before anything is returned:

- a paper id the model cites that was **not** in the prompt is dropped;
- an item left with no verifiable evidence is discarded entirely;
- a "recurring pattern" needs at least **two** supporting papers;
- a candidate gap needs at least **two** supporting papers.

Responses report how many items were discarded (`items_dropped_unverifiable`,
`gaps_dropped_unverifiable`). When nothing survives, the response says
`"notes": "Insufficient evidence."` rather than filling the space.

---

## Real data vs demo / test data

This section is deliberately blunt, because "the UI shows something" is not proof that
the something is real.

### What uses real external APIs

| Data | Source | How it can be verified |
|---|---|---|
| Researcher records (name, affiliations, paper count, citations, h-index) | OpenAlex or Semantic Scholar | Namespaced provider ids (`openalex:A…`, `s2:…`) resolve directly at the provider |
| Publications (title, authors, year, venue, DOI, citations, open-access URL) | OpenAlex or Semantic Scholar | Paper ids re-fetched independently return the same titles |
| Abstracts and evidence excerpts | OpenAlex `abstract_inverted_index`, Semantic Scholar `abstract` | An excerpt used as evidence can be found verbatim in the provider's own abstract |
| Topic / field / domain taxonomy | OpenAlex `topics` | Merged onto Semantic Scholar records by DOI match |
| Embeddings | OpenRouter `/embeddings` | Response reports `retrieval.embedder`, e.g. `openrouter:openai/text-embedding-3-small` |
| Research analysis, candidate gaps | OpenRouter chat completions | Output is field-specific per researcher; provider and model reported in `meta` |

### Which provider serves which flow

| Provider | Used by | Notes |
|---|---|---|
| **Semantic Scholar** | Researcher flow (primary), legacy topic flow | Rate-limits anonymous traffic aggressively — see below |
| **OpenAlex** | Researcher flow (fallback + enrichment), legacy topic flow | No key required |
| **arXiv** | **Legacy topic flow only** (`GET /api/research`) | Not part of the researcher pipeline |

> **Important, and easily misread:** Semantic Scholar is configured as the *primary*
> provider for researcher search, but without a `SEMANTIC_SCHOLAR_API_KEY` it commonly
> returns HTTP 429 on the first call. The system then records a cooldown, logs it, and
> serves the request from **OpenAlex** — reporting `"source": "openalex"`,
> `"fallback_used": true` and a provider note. In practice, with no key, most results
> come from OpenAlex.

### Demo / sample data that exists in this repository

There **is** hardcoded sample data here. This is exactly where it lives, and whether
production can reach it.

| Location | What it is | Reachable in production? |
|---|---|---|
| `server/services/demoData.js` | 6 fabricated papers (`demo-1` … `demo-6`) | **Yes** — served by `GET /api/research` **only when every provider fails**. Flagged `demoMode: true`; the UI shows a "Demo Mode" badge |
| `server/services/aiService.js` (`demoInsight`) | Hardcoded summary / gap / idea prose | **Yes** — returned by `POST /api/ai` when no model is configured or the call fails. Text is prefixed "Demo Mode: …" |
| `tests/helpers/fixtures.js` | Fake authors, papers and LLM responses | **No** — imported only by files under `tests/` |
| `tests/helpers/mockFetch.js` | Replaces global `fetch` during tests | **No** — test-only |

**The researcher pipeline contains no demo data.** A dependency trace of every module
reachable from `server/routes/researchers.js` (18 files) shows that neither
`demoData.js` nor `aiService.js` is among them. The demo fallbacks belong exclusively to
the older topic-search flow, reachable from the "Papers" navigation link.

### Test fixtures are not production data

`tests/helpers/fixtures.js` contains records named "Test Author", "Paper One" and so on.
These are **only** loaded by the test runner. The mock also throws on any unmatched
request, so a test cannot silently reach a live API — and a live request cannot reach a
fixture.

### How to verify real data yourself

```bash
npm start

# 1. Search a researcher; note the provider and the returned id
curl -s "http://localhost:3000/api/researchers/search?q=Fei-Fei%20Li&limit=1"

# 2. Take a paper id from /papers and resolve it at the provider directly.
#    If the title matches, the record genuinely came from OpenAlex.
curl -s "https://api.openalex.org/works/W2108598243" | grep -o '"display_name":"[^"]*"'

# 3. Check which embedder actually ran
curl -s -X POST http://localhost:3000/api/researchers/<id>/analyze \
  -H "Content-Type: application/json" -d '{"max_papers":6}' \
  | grep -o '"embedder":"[^"]*"'

# 4. See which providers are healthy right now
curl -s http://localhost:3000/api/health
```

Two further checks that are hard to fake:

- **Search unrelated researchers.** A computer-vision researcher, a biochemist and an
  immunologist should produce completely different methods and datasets. If the outputs
  look similar, investigate.
- **Watch the server log.** Real provider behaviour appears there —
  `Semantic Scholar: rate limited (backing off 60s)`, `Falling back to OpenAlex`.

### Example researchers to try

These are **not** hardcoded anywhere in the codebase. They are simply well-indexed people
who demonstrate the system clearly; any published author should work.

- Yoshua Bengio
- Geoffrey Hinton
- Fei-Fei Li
- Andrew Ng

Searching across different fields is the clearest demonstration that the output is
dynamic rather than canned.

---

## Features

| Feature | Status | Description |
|---|---|---|
| Researcher search | Implemented | Name search with rule-based query understanding; reports intent and confidence |
| Provider fallback | Implemented | Semantic Scholar → OpenAlex on rate limit or failure, reported honestly in the response |
| Rate-limit handling | Implemented | Honours `Retry-After`, records a per-provider cooldown, skips cooling providers |
| Paper retrieval | Implemented | Paginated, with optional `year_from` / `year_to` filtering |
| Cross-source enrichment | Implemented | OpenAlex topic/domain metadata merged onto Semantic Scholar papers by DOI |
| Paper fallback by identity | Implemented | If the owning provider is rate limited, the same person is matched on the other provider by ORCID or exact name; refuses to guess |
| Chunking | Implemented | Sentence-aware, ~700 characters, paper identity preserved |
| Embeddings | Implemented | OpenRouter `/embeddings`; deterministic local lexical fallback, reported in the response |
| Vector retrieval | Implemented | In-memory index, cosine similarity, top-k per question, capped per paper |
| Research analysis | Implemented | Themes, topics, methods, datasets, domains, limitations, recurring patterns |
| Evidence extraction | Implemented | Every item carries paper ids, titles, excerpts, source and confidence |
| Evidence verification | Implemented | Unverifiable attributions dropped before the response is built |
| Candidate gap detection | Implemented | Cross-paper comparison, typed, minimum two supporting papers |
| Knowledge graph (provider) | Implemented | Built from scholarly metadata; needs no AI |
| Knowledge graph (analysis) | Implemented | Built from the analysis JSON; includes candidate gaps |
| Graph visualization | Implemented | SVG, deterministic radial layout, click-for-evidence |
| Frontend researcher interface | Implemented | Search page plus a profile page with five tabs |
| Caching | Implemented | In-memory TTL + LRU, with concurrent request de-duplication |
| Structured LLM output | Implemented | JSON schema enforced, one repair retry, then a controlled error |
| Error handling | Implemented | Typed error codes mapped to HTTP status codes; no key or stack-trace leakage |
| Automated tests | Implemented | 125 tests, all external calls mocked |
| Topic paper search (legacy) | Implemented | Earlier flow across OpenAlex / Semantic Scholar / arXiv, with demo fallback |
| Per-paper AI insights (legacy) | Implemented | Summary / gap / idea per paper, with demo fallback |
| Persistent storage | **Not implemented** | No database; all state is in memory and lost on restart |
| Neo4j graph database | **Not implemented** | Interface is Neo4j-shaped; only an in-memory store exists |
| Vector database | **Not implemented** | No Chroma / pgvector; the index is per-request |
| `CITES` paper-to-paper edges | **Not implemented** | Edge type is defined but never populated — no provider call currently fetches reference lists |
| Authentication / accounts | **Not implemented** | Deliberately out of scope |
| Search history / export | **Not implemented** | Deliberately out of scope |

---

## Tech stack

Verified against `package.json` and the source. Nothing here is aspirational.

| Layer | Technology | Purpose |
|---|---|---|
| Runtime | Node.js `>=18` (developed on v22.18.0) | Server runtime; uses built-in `fetch` and `AbortSignal.timeout` |
| Backend | Express `^5.2.1` | HTTP routing and static file serving |
| Configuration | dotenv `^16.4.5` | Loads `.env` |
| Frontend | HTML, CSS, vanilla JavaScript | No framework, no build step, no bundler |
| Graph visualization | Hand-written inline SVG | No charting library |
| Scholarly data | Semantic Scholar Academic Graph, OpenAlex | Researcher and paper retrieval |
| Scholarly data (legacy flow) | OpenAlex, Semantic Scholar, arXiv | Topic-based paper search only |
| LLM gateway | OpenRouter | All chat-completion calls |
| LLM model | `openai/gpt-4o-mini` (default, configurable) | Analysis and gap detection |
| Embeddings | OpenRouter `/embeddings` | Default `openai/text-embedding-3-small` |
| Embedding fallback | Local hashed bag-of-words, 512 dimensions | Keeps retrieval running with no key; lexical, not semantic |
| Vector storage | In-process `VectorIndex` class | Per-request; not persisted |
| Knowledge graph | In-process `InMemoryGraphStore` | Per-request; not persisted |
| Caching | In-process `Map` with TTL + LRU | Provider responses and analyses |
| Testing | `node:test` (built in) | 125 tests, zero test dependencies |

**Total runtime dependencies: two.** There is no database, no message queue, no Redis, no
vector database and no graph database.

---

## System architecture

```text
                                   User
                                     |
                                     v
                     Frontend  (public/, vanilla JS)
             researchers.html          researcher.html
                                     |
                                     |  fetch /api/...
                                     v
                       Express app  (server/app.js)
                                     |
          +--------------------------+--------------------------+
          |                          |                          |
          v                          v                          v
  /api/researchers/*          /api/research               /api/ai
   (researcher flow)       (legacy topic flow)      (legacy per-paper AI)
          |                          |                          |
          v                          v                          v
    Orchestrator             researchApi.js              aiService.js
 (agents/orchestrator.js)    OpenAlex / S2 / arXiv       OpenRouter
          |                          |                          |
          |                          v                          v
          |                  demoData.js fallback        demoInsight fallback
          |                  (only if ALL fail)          (only if LLM absent)
          |
          +--> Query Understanding Agent        rule-based, no LLM
          |
          +--> Research Retrieval Agent ---> Provider registry
          |                                     |            |
          |                                     v            v
          |                     SemanticScholarProvider    OpenAlexProvider
          |                                     |            |
          |                                     +-----+------+
          |                                           v
          |                                Scholarly APIs (network)
          |                                           |
          |                                           v
          |                                 Cache (TTL + LRU)
          |
          +--> Vector store (RAG)
          |      chunk -> embed -> cosine similarity -> top-k
          |                    |
          |                    v
          |            OpenRouter /embeddings
          |
          +--> Research Analysis Agent ----+
          +--> Gap Detection Agent --------+--> OpenRouter /chat/completions
          |                                       (JSON schema + validation)
          |
          +--> Graph service
                 provider graph  |  analysis graph (+ candidate gaps)
                                 |
                                 v
                          Frontend SVG renderer
```

### Agents

Four agents, coordinated by an orchestrator. They do not call each other, and only the
two that genuinely need a model have one.

| Agent | File | Uses LLM | Responsibility |
|---|---|---|---|
| Query Understanding | `agents/queryUnderstandingAgent.js` | No | Classify person vs topic, normalise, strip titles |
| Research Retrieval | `agents/retrievalAgent.js` | No | Call providers, cache, enrich, select papers |
| Research Analysis | `agents/analysisAgent.js` | Yes | Extract themes, methods, datasets, limitations |
| Gap Detection | `agents/gapAgent.js` | Yes | Compare papers, propose candidate gaps |

### Knowledge graph model

| Node type | Source |
|---|---|
| `Researcher` | Provider metadata |
| `Paper` | Provider metadata |
| `Topic` | Provider taxonomy (provider graph) or LLM analysis (analysis graph) |
| `Domain` | Provider taxonomy or LLM analysis |
| `Institution` | Provider metadata — **provider graph only** |
| `Method` | LLM analysis only |
| `Dataset` | LLM analysis only |
| `ResearchGap` | LLM gap detection — **analysis graph only** |

| Edge type | Direction | Populated? |
|---|---|---|
| `AUTHORED` | Researcher → Paper | Yes |
| `HAS_TOPIC` | Paper → Topic | Yes |
| `USES_METHOD` | Paper → Method | Yes |
| `USES_DATASET` | Paper → Dataset | Yes |
| `BELONGS_TO` | Paper → Domain | Yes |
| `AFFILIATED_WITH` | Researcher → Institution | Yes (provider graph) |
| `SUPPORTS` | Paper → ResearchGap | Yes (analysis graph) |
| `CITES` | Paper → Paper | **Never** — see [Known limitations](#known-limitations) |

Every node carries a `provenance` field of either `provider` or `llm`, so a reader can
always tell which layer produced it.

---

## Getting started

### Requirements

- Node.js **18 or newer** (`engines.node: ">=18"`); developed and tested on v22.18.0
- An internet connection — the scholarly providers are live services
- Optionally, an OpenRouter API key for the AI features

### Install and run

```bash
git clone <repository-url>
cd research-ai
npm install

# Windows
copy .env.example .env
# macOS / Linux
cp .env.example .env

npm start
```

Then open **<http://localhost:3000>** and click **Researchers**.

| Command | What it does |
|---|---|
| `npm start` | Runs `node server/server.js` |
| `npm run dev` | **Identical to `npm start`** — there is no watch mode or hot reload |
| `npm test` | Runs `node --test "tests/*.test.js"` |

The port is `3000` unless `PORT` is set.

### Getting an OpenRouter key

1. Sign in at <https://openrouter.ai> and create a key at <https://openrouter.ai/keys>.
2. Add it to `.env` as `OPENROUTER_API_KEY`.
3. Add credit at <https://openrouter.ai/credits> if your chosen model is paid.

**Model ids need a vendor prefix.** `gpt-4o-mini` will not resolve on OpenRouter;
`openai/gpt-4o-mini` will. The server prints a warning at startup if a configured model
id contains no `/`.

### Running without an OpenRouter key

The application starts and most of it works. It does **not** substitute fabricated
research data in the researcher flow.

| Feature | Without a key |
|---|---|
| Researcher search | Works |
| Researcher profile | Works |
| Paper retrieval | Works |
| Knowledge graph (`source=provider`) | Works |
| Research analysis | `503 LLM_NOT_CONFIGURED` |
| Candidate gap detection | `503 LLM_NOT_CONFIGURED` |
| Knowledge graph (`source=analysis`) | `503 LLM_NOT_CONFIGURED` |
| RAG embeddings | Falls back to the local lexical embedder, reported in the response |
| Legacy `/api/ai` | Returns clearly-labelled "Demo Mode" text |

> `SETUP.md` in this repository states that the app "runs without any API keys". That was
> written for an earlier version and is now only partly accurate: it holds for search,
> papers and the provider graph, but analysis and gap detection require an OpenRouter
> key. `SETUP.md` has not been modified.

### Startup output

The server prints which providers are registered and which agents have a key:

```text
ResearchAI running at http://localhost:3000

Research providers:
  Semantic Scholar     semantic_scholar
  OpenAlex             openalex

Language model gateway: OpenRouter (https://openrouter.ai/api/v1)

Researcher agents (/api/researchers):
  Research Analysis Agent
      OpenRouter
      openai/gpt-4o-mini
      available
  ...
```

---

## Environment variables

All variables are optional; the application starts with an empty `.env`.

### OpenRouter

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | — | The only key needed for AI features. Blank ⇒ all agents unavailable |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Override for a proxy or gateway |
| `OPENROUTER_MODEL` | `openai/gpt-4o-mini` | Default model for every agent |
| `OPENROUTER_SITE_URL` | — | Optional; sent as `HTTP-Referer` for OpenRouter attribution |
| `OPENROUTER_APP_NAME` | — | Optional; sent as `X-Title` |

### Per-agent model overrides

Each agent uses `OPENROUTER_MODEL` unless given its own override. There is **no**
per-agent key or base URL — one gateway needs one key.

| Variable | Agent | Endpoint |
|---|---|---|
| `ANALYSIS_MODEL` | Research Analysis Agent | `POST /api/researchers/:id/analyze` |
| `GAP_DETECTION_MODEL` | Research Gap Detection Agent | `POST /api/researchers/:id/gaps` |
| `SUMMARY_MODEL` | Summarization Agent | `POST /api/ai` (legacy) |
| `GAP_MODEL` | Gap Analysis Agent | `POST /api/ai` (legacy) |
| `IDEA_MODEL` | Innovation Agent | `POST /api/ai` (legacy) |

### Scholarly providers

| Variable | Default | Purpose |
|---|---|---|
| `SEMANTIC_SCHOLAR_API_KEY` | — | Raises the rate limit. Without it, expect HTTP 429 and fallback to OpenAlex |
| `CONTACT_EMAIL` | — | Sent to OpenAlex as `mailto` for its faster "polite pool". Recommended |
| `OPENALEX_API_KEY` | — | Only for OpenAlex premium accounts |

### Retrieval and embeddings

| Variable | Default | Purpose |
|---|---|---|
| `EMBEDDINGS_PROVIDER` | — | Set to `local` to force the local embedder even when a key exists |
| `EMBEDDING_MODEL` | `openai/text-embedding-3-small` | Embedding model id |
| `EMBEDDING_API_KEY` | falls back to `OPENROUTER_API_KEY` | Key for the embeddings endpoint |
| `EMBEDDING_BASE_URL` | falls back to `OPENROUTER_BASE_URL` | Embeddings endpoint |
| `EMBEDDING_TIMEOUT_MS` | `20000` | Embedding request timeout |

### Timeouts, retries and caching

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `PROVIDER_TIMEOUT_MS` | `12000` | Scholarly API request timeout |
| `PROVIDER_RETRIES` | `1` | Retries for transient (non-429) failures |
| `PROVIDER_BACKOFF_MS` | `400` | Base backoff, doubled per attempt with jitter |
| `PROVIDER_COOLDOWN_MS` | `60000` | Cooldown when a 429 gives no `Retry-After` |
| `PROVIDER_MAX_COOLDOWN_MS` | `300000` | Cap on any `Retry-After` |
| `PROVIDER_MAX_RETRY_WAIT_MS` | `2000` | Longest inline wait before failing over |
| `LLM_TIMEOUT_MS` | `45000` | Chat completion timeout |
| `CACHE_TTL_MS` | `600000` (10 min) | Provider response cache lifetime |
| `CACHE_MAX_ENTRIES` | `500` | LRU capacity |
| `ANALYSIS_CACHE_TTL_MS` | `1800000` (30 min) | Analysis result cache lifetime |

> **Note:** `CACHE_MAX_ENTRIES`, `PROVIDER_RETRIES`, `PROVIDER_BACKOFF_MS`,
> `PROVIDER_COOLDOWN_MS`, `PROVIDER_MAX_COOLDOWN_MS` and `PROVIDER_MAX_RETRY_WAIT_MS` are
> read by the code but are **not** listed in `.env.example`. They still work if added
> manually. `.env.example` has not been modified.

### Security

The API key is read server-side from `process.env` only. It is never sent to the browser,
never included in an API response, and never written to a log line. Upstream error bodies
are logged server-side but never forwarded to the client.

`.gitignore` covers `.env` and `.env.local`. It does **not** cover `.env.example` — keep
that file free of real keys.

---

## Frontend pages

No build step. The Express server serves `public/` statically.

| URL | File | Purpose |
|---|---|---|
| `/` or `/index.html` | `index.html` | Landing page |
| `/researchers.html` | `researchers.html` | **Researcher search** — the main entry point |
| `/researcher.html?id=<id>` | `researcher.html` | **Researcher profile** — five tabs |
| `/research.html` | `research.html` | Legacy topic paper search |

### Researcher profile tabs

| Tab | Shows |
|---|---|
| **Publications** | Retrieved papers with year, venue, citations, DOI, open-access link; year filters |
| **Research intelligence** | Themes, methods, datasets, domains, topics, limitations, recurring patterns — each with supporting papers |
| **Candidate gaps** | Typed candidate gaps with reasoning, confidence and evidence |
| **Knowledge graph** | Interactive SVG; switch between *Provider metadata* and *Analysis*; optionally include candidate gaps |
| **Evidence** | Every claim currently on screen, with its papers and excerpts |

The graph is deterministic: the researcher sits at the centre, papers on the first ring,
topics/methods/datasets/domains on the second, candidate gaps on the outermost ring drawn
as diamonds. Clicking any node shows its evidence.

Each tab loads independently, so a failure in one does not take the page down.

### Frontend data sources

Every network call in production frontend JavaScript targets this application's own API:
`/api/health`, `/api/researchers/search`, `/api/researchers/…`, `/api/research`,
`/api/ai`. There are no hardcoded researcher objects, paper arrays, topics or graph nodes
in the frontend.

---

## API reference

### `GET /api/health`

Reports registered providers, the LLM gateway, per-agent configuration, provider
rate-limit state and cache statistics. Never includes a key.

```json
{
  "status": "ok",
  "providers": [{ "source": "semantic_scholar", "name": "Semantic Scholar" }],
  "llm": {
    "provider": "OpenRouter",
    "base_url": "https://openrouter.ai/api/v1",
    "default_model": "openai/gpt-4o-mini",
    "configured": true
  },
  "provider_health": {
    "semantic_scholar": { "name": "Semantic Scholar", "state": "rate_limited",
                          "cooldown_remaining_ms": 45884, "rate_limit_hits": 1 },
    "openalex":         { "name": "OpenAlex", "state": "ok",
                          "cooldown_remaining_ms": 0, "rate_limit_hits": 0 }
  },
  "agents": [{ "agent": "Research Analysis Agent", "provider": "OpenRouter",
               "model": "openai/gpt-4o-mini", "configured": true }],
  "analysis_available": true,
  "cache": { "entries": 3, "capacity": 500, "ttl_ms": 600000 }
}
```

### `GET /api/researchers/search`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `q` | string | — | **Required.** Max 200 characters |
| `limit` | int | `10` | 1–50 |
| `offset` | int | `0` | 0–10000 |
| `source` | string | auto | `semantic_scholar` or `openalex` |

Returns `researchers[]`, `total`, `offset`, `next_offset`, `source`, `fallback_used`,
`provider_notes`, `query_understanding`, `count`, `request_id`.

Researcher ids are namespaced `<source>:<providerId>` — `s2:1751762`,
`openalex:A5086198262` — so an id is self-describing. Fields the provider does not supply
are `null`, never `0`.

### `GET /api/researchers/{id}`

Returns `{ "researcher": {…}, "request_id": "…" }`. `404` if no such author.

### `GET /api/researchers/{id}/papers`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `limit` | int | `25` | 1–100 |
| `offset` | int | `0` | 0–10000 |
| `year_from` | int | — | Four-digit year |
| `year_to` | int | — | Must not precede `year_from` |

Returns `papers[]`, `count`, `total`, `next_offset`, `year_filter_applied`
(`provider` \| `client` \| `none`), `served_by`, `fallback`, `enrichment`.

### `POST /api/researchers/{id}/analyze`

Body optional: `{ "max_papers": 2–30 (default 12), "refresh": boolean }`.
Returns `200`, not `201` — the analysis is computed and returned, not stored.

Response contains `analysis` (themes, topics, methods, datasets, domains, limitations,
recurring patterns, institutions, evidence, notes, meta), `papers_analyzed`, `retrieval`
(strategy, embedder, chunk counts, per-question breakdown), `corpus` and `cached`.

### `POST /api/researchers/{id}/gaps`

Same body. Runs the analysis first (reusing the cache when present) and passes it to the
gap agent as context.

Response contains `gaps[]` (title, description, type, related topics, supporting papers,
evidence, reasoning, confidence), `notes`, `disclaimer` and `meta`.

`type` is one of `recurring_limitation`, `underexplored_combination`, `methodological`,
`evaluation`, `application_domain`.

### `GET /api/researchers/{id}/graph`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `source` | string | `provider` | `provider` or `analysis` |
| `max_papers` | int | `30` (provider) / `12` (analysis) | 2–60 / 2–30 |
| `include_analysis` | boolean | `false` | `provider` source only — adds method/dataset nodes |
| `include_gaps` | boolean | `false` | `analysis` source only — adds candidate gap nodes |
| `refresh` | boolean | `false` | `analysis` source only |

Returns `researcher`, `nodes[]`, `edges[]`, `summary`, `meta` and `provenance`.
`meta.source` is `provider` or `analysis`.

### Legacy endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/research?q=&source=&year=&sort=` | Topic paper search across OpenAlex / Semantic Scholar / arXiv. Falls back to demo papers when every provider fails (`demoMode: true`) |
| `POST /api/ai` | Per-paper summary / gap / idea. Body: `{ type, title, abstract, authors?, year? }`. Falls back to "Demo Mode" text |
| `GET /api/ai/status` | Per-agent configuration for the legacy flow |

### Example curl commands

```bash
curl http://localhost:3000/api/health

curl "http://localhost:3000/api/researchers/search?q=Fei-Fei%20Li&limit=3"

curl http://localhost:3000/api/researchers/openalex:A5100450462

curl "http://localhost:3000/api/researchers/openalex:A5100450462/papers?limit=10&year_from=2018"

curl -X POST http://localhost:3000/api/researchers/openalex:A5100450462/analyze \
  -H "Content-Type: application/json" -d '{"max_papers": 8}'

curl -X POST http://localhost:3000/api/researchers/openalex:A5100450462/gaps \
  -H "Content-Type: application/json" -d '{"max_papers": 8}'

curl "http://localhost:3000/api/researchers/openalex:A5100450462/graph?source=analysis&include_gaps=true"
```

---

## Error handling

Every error uses one envelope:

```json
{
  "error": {
    "code": "RESEARCH_PROVIDER_UNAVAILABLE",
    "message": "The research provider could not be reached.",
    "request_id": "0a909e5b-7729-4c51-bcfe-523c1df14a47"
  }
}
```

The `request_id` is also returned as the `X-Request-Id` header and written to the server
log beside the real cause.

| Status | Codes |
|---|---|
| `400` | `INVALID_QUERY`, `INVALID_PARAMETER`, `INVALID_RESEARCHER_ID` |
| `404` | `RESEARCHER_NOT_FOUND`, `PAPER_NOT_FOUND`, `ENDPOINT_NOT_FOUND` |
| `422` | `VALIDATION_FAILED`, `NO_PAPERS_AVAILABLE`, `NO_ABSTRACTS_AVAILABLE` |
| `429` | `PROVIDER_RATE_LIMITED` |
| `502` | `RESEARCH_PROVIDER_UNAVAILABLE`, `PROVIDER_MALFORMED_RESPONSE`, `LLM_UNAVAILABLE`, `LLM_INVALID_OUTPUT` |
| `503` | `LLM_NOT_CONFIGURED`, `GRAPH_UNAVAILABLE`\*, `VECTOR_STORE_UNAVAILABLE`\* |
| `504` | `PROVIDER_TIMEOUT`, `LLM_TIMEOUT` |
| `500` | `INTERNAL_ERROR` |

\* `GRAPH_UNAVAILABLE` and `VECTOR_STORE_UNAVAILABLE` are defined in
`server/lib/httpErrors.js` but are **never thrown** anywhere in the current code.

`201` is deliberately unused — nothing in this prototype creates a persistent resource.

### Degradation behaviour

| If this fails | This still works |
|---|---|
| Semantic Scholar | Search and papers fall back to OpenAlex |
| OpenAlex enrichment | Papers return without topic metadata |
| Embedding endpoint | Retrieval uses the local lexical embedder |
| LLM analysis | Search, profile, papers and the provider graph |
| Gap detection (in the analysis graph) | The rest of the graph renders, with a note |
| All scholarly providers (legacy flow only) | Demo papers, flagged `demoMode: true` |

---

## Project structure

```text
research-ai/
├── public/                       Frontend (no build step)
│   ├── index.html                Landing page
│   ├── researchers.html          Researcher search
│   ├── researcher.html           Researcher profile (5 tabs)
│   ├── research.html             Legacy topic search
│   ├── css/style.css             Design tokens and all styling
│   └── js/
│       ├── researchApi.js        Client for /api/researchers
│       ├── researchUI.js         Cards, evidence, states, errors
│       ├── graphView.js          SVG graph + deterministic radial layout
│       ├── researchers.js        Search page wiring
│       ├── researcher.js         Profile page wiring
│       └── app.js, search.js, ui.js    Legacy topic-search page
├── server/
│   ├── server.js                 Entry point: config + listen
│   ├── app.js                    Express app (separate so tests need no port)
│   ├── lib/
│   │   ├── httpErrors.js         Error codes, status mapping, envelope
│   │   ├── httpClient.js         Outbound HTTP, timeouts, retries, 429 handling
│   │   └── providerHealth.js     Per-provider cooldowns, Retry-After parsing
│   ├── models/schemas.js         Researcher, Paper, Evidence, id namespacing
│   ├── providers/
│   │   ├── index.js              Registry + interface validation
│   │   ├── semanticScholar.js    Semantic Scholar adapter
│   │   └── openAlex.js           OpenAlex adapter
│   ├── agents/
│   │   ├── orchestrator.js       Coordinates the agents
│   │   ├── queryUnderstandingAgent.js
│   │   ├── retrievalAgent.js
│   │   ├── analysisAgent.js
│   │   └── gapAgent.js
│   ├── routes/
│   │   ├── researchers.js        /api/researchers/*
│   │   ├── research.js           /api/research   (legacy)
│   │   └── ai.js                 /api/ai         (legacy)
│   └── services/
│       ├── openRouter.js         OpenRouter config: key, base URL, model, headers
│       ├── llmClient.js          Structured JSON output, validation, one retry
│       ├── vectorStore.js        Chunking, embeddings, similarity search
│       ├── graphService.js       Knowledge graph builders
│       ├── cache.js              TTL + LRU cache, single-flight
│       ├── researchApi.js        Legacy topic search (OpenAlex/S2/arXiv)
│       ├── aiService.js          Legacy per-paper agents
│       └── demoData.js           6 sample papers — legacy fallback only
├── tests/
│   ├── api.test.js               API surface
│   ├── openRouter.test.js        OpenRouter integration
│   ├── providerFallback.test.js  Rate limiting and fallback
│   ├── analysisGraph.test.js     Analysis-derived knowledge graph
│   └── helpers/                  mockFetch, fixtures, test server
├── .env.example
├── SETUP.md                      Beginner setup guide (partly outdated — see above)
├── LICENSE                       MIT
└── package.json
```

### Provider adapter interface

Business logic is never coupled to a specific scholarly API. Every provider implements:

```js
searchResearchers(query, { limit, offset })
getResearcher(sourceId)
getResearcherPapers(sourceId, { limit, offset, yearFrom, yearTo })
getPaper(sourceId)
searchPapers(query, { limit })
```

`server/providers/index.js` validates at boot that every registered adapter implements
all five, so an incomplete adapter fails at startup rather than at request time.

### Caching

| | |
|---|---|
| What | Provider responses, analyses, corpora |
| Where | In-memory `Map`, process-local |
| TTL | Provider 10 min; analysis 30 min |
| Capacity | 500 entries, least-recently-used eviction |
| Failures cached? | No — a rejected promise is removed so the next caller may retry |
| Concurrency | Identical concurrent requests share one provider call |

The cache is only ever written by the producer function that fetched the data, so a
cached value is always previously-real provider or model output. **Cached data is not
demo data.** All state is lost on restart.

---

## Testing

```bash
npm test
```

**125 tests across four files**, using Node's built-in `node:test` runner. No test
framework dependency.

| File | Covers |
|---|---|
| `tests/api.test.js` | API surface: success, invalid input, empty results, provider failures, malformed responses, evidence grounding, key leakage |
| `tests/openRouter.test.js` | OpenRouter configuration, missing key, successful request, provider failure, rate limit, timeout, malformed output |
| `tests/providerFallback.test.js` | Semantic Scholar 429, `Retry-After` in both formats, fallback to OpenAlex, both providers down, call de-duplication |
| `tests/analysisGraph.test.js` | Graph generation, node/edge relationships, duplicate prevention, evidence preservation, empty analysis |

**Every external call is mocked.** Semantic Scholar, OpenAlex and OpenRouter are all
replaced by a fetch mock that *throws* on any unmatched request, so a test cannot silently
reach a live API and no test consumes OpenRouter credit.

---

## Known limitations

Real constraints of the current implementation, not bugs.

1. **Candidate gaps are not novelty-checked.** Gaps come only from the selected
   researcher's papers. Nothing verifies whether a gap has already been addressed
   elsewhere. `confidence` measures how well the analysed papers support the statement —
   it is **not** a novelty score. Every gap response carries a disclaimer saying so.
2. **Analysis reads abstracts only**, not full text. A method used but not named in the
   abstract will not be extracted.
3. **Abstract coverage is limited.** Many indexed records have no abstract, so of ~40
   retrieved papers only around 12 are typically analysable. The response reports
   `skipped_without_abstract`.
4. **`CITES` edges are never populated.** The edge type exists in the graph model, but no
   current provider call requests reference lists.
5. **Nothing is persisted.** Graph, vector index and cache are all in memory and lost on
   restart. There is no database.
6. **The local embedding fallback is lexical, not semantic.** Retrieval quality is
   noticeably lower without a working embeddings endpoint. The active embedder is always
   reported in `retrieval.embedder`.
7. **Semantic Scholar rarely serves without a key.** It is configured as primary but
   typically returns 429, so OpenAlex handles most requests in practice.
8. **Author disambiguation is the provider's.** Semantic Scholar sometimes splits one
   person across several author records; search returns them as separate results.
9. **The cross-provider paper fallback uses name matching.** If the owning provider is
   rate limited, the same person is matched on the other provider by ORCID or exact
   normalised name. Where no confident match exists it refuses and returns the rate limit
   rather than guessing. It also requires the profile to be cached already.
10. **Gap titles can look templated.** The model tends to echo the category name
    (`underexplored_combination`) into gap titles, so distinct gaps can read as formulaic
    even though the content differs.
11. **Analysis output varies in completeness.** For some researchers the model returns no
    themes or domains at all. When that happens `items_dropped_unverifiable` is `0` —
    meaning nothing was filtered out; the model simply produced none.
12. **The legacy flows fabricate content on total failure.** `/api/research` serves six
    hardcoded papers and `/api/ai` serves hardcoded prose when their providers are
    unavailable. Both are labelled "Demo Mode" in the UI. The researcher flow never does
    this.
13. **The cache is process-local**, so it does not survive a restart or span instances.
14. **No authentication, accounts, history or export.**

---

## Troubleshooting

**`429 PROVIDER_RATE_LIMITED` on almost every request.**
Semantic Scholar rate-limits anonymous traffic hard. The app handles this by recording a
cooldown and serving from OpenAlex. You only see a 429 when *every* source is
unavailable. Request a free key at <https://www.semanticscholar.org/product/api> and set
`SEMANTIC_SCHOLAR_API_KEY`. `GET /api/health` shows which providers are cooling down.

**`503 LLM_NOT_CONFIGURED` on analyze, gaps, or the analysis graph.**
Expected with no model key. Set `OPENROUTER_API_KEY` in `.env` and restart.

**OpenRouter returns 400 or "model not found".**
Model ids need a vendor prefix: `openai/gpt-4o-mini`, not `gpt-4o-mini`. The server warns
at startup when a configured id looks unprefixed.

**`502 LLM_UNAVAILABLE` immediately with a valid-looking key.**
Usually a `401` from OpenRouter, mapped to `502` so the credential problem is not echoed
to the browser. Check the server log for the real status, confirm the key, and check your
credit balance.

**`502 LLM_INVALID_OUTPUT` repeatedly.**
The chosen model is not following the JSON schema. Smaller and open-weights models often
struggle with `response_format: json_object`. Try `openai/gpt-4o-mini`.

**`422 NO_ABSTRACTS_AVAILABLE`.**
None of the retrieved papers have abstracts, so there is nothing to analyse. Try a
researcher with more indexed abstracts, or raise `max_papers`.

**`retrieval.embedder` says `local-lexical` although a key is set.**
Either `EMBEDDINGS_PROVIDER=local` is set, or the embeddings call failed and the local
embedder took over. The server logs the reason.

**The graph looks sparse.**
Small paper counts and missing DOIs both reduce enrichment. Raise `max_papers` and set
`CONTACT_EMAIL` for faster, more reliable OpenAlex responses.

**Port already in use.**
Set `PORT` in `.env`.

---

## Planned / not implemented

Documented so a reviewer can tell intent from reality. None of these exist in the code.

| Item | Status | Note |
|---|---|---|
| Neo4j knowledge graph | **Planned / Not Implemented** | `graphService.js` exposes an `addNode` / `addEdge` / `toJSON` interface a Neo4j store could implement. Only `InMemoryGraphStore` exists |
| Vector database (Chroma, pgvector) | **Planned / Not Implemented** | `VectorIndex` needs only `add` and `search`, which is the seam such a store would fill |
| Full-text paper analysis | **Planned / Not Implemented** | Currently abstracts only |
| `CITES` citation edges | **Planned / Not Implemented** | Edge type defined; requires a second per-paper provider call |
| Novelty verification for gaps | **Planned / Not Implemented** | Would require a literature-wide search |
| Persistent storage / database | **Planned / Not Implemented** | No database of any kind |
| Redis or shared cache | **Planned / Not Implemented** | Cache is process-local |
| Authentication, accounts, roles | **Planned / Not Implemented** | Deliberately out of scope |
| Search history, PDF export | **Planned / Not Implemented** | Deliberately out of scope |
| Proposal generation workflow | **Planned / Not Implemented** | Out of scope for this prototype |
| Watch mode / hot reload | **Not Implemented** | `npm run dev` is identical to `npm start` |
| CI pipeline, linter, formatter | **Not Implemented** | No configuration files present |
| Docker / deployment config | **Not Implemented** | No Dockerfile or deployment manifests |

---

## Disclaimer

Research results and generated insights are intended for research assistance and should
be verified independently against the original papers. Extracted themes, limitations and
candidate research gaps are hypotheses derived from a limited set of abstracts. They are
not established findings and are not claimed to be novel.

## License

MIT — see [LICENSE](LICENSE).
