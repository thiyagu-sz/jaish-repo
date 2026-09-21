/**
 * Retrieval layer for the RAG flow.
 *
 *   paper abstract -> chunk -> embedding -> vector index -> similarity search -> LLM
 *
 * Two embedders sit behind one interface:
 *
 *   openrouter - real dense embeddings via the OpenRouter /embeddings endpoint,
 *                used when a key is configured.
 *   lexical    - a deterministic hashed bag-of-words vector computed locally.
 *
 * The lexical embedder exists so the retrieval step genuinely runs in the demo
 * without a key or a vector database. It is lexical, not semantic, and the API
 * reports which one produced a result rather than implying they are equal.
 *
 * The index is per-request and in-memory. VectorIndex is the seam a persistent
 * store (Chroma, pgvector) would slot into: it only needs add/search.
 */
const { ApiError } = require('../lib/httpErrors');
const openRouter = require('./openRouter');

const EMBEDDING_DIMS = 512;
const CHUNK_TARGET_CHARS = 700;

/** ------------------------------------------------------------- chunking */

/** Splits on sentence boundaries, then packs sentences up to the target size. */
function chunkText(text, targetChars = CHUNK_TARGET_CHARS) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= targetChars) return [clean];

  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if (current && (current + sentence).length > targetChars) {
      chunks.push(current.trim());
      current = '';
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * Turns papers into retrievable chunks. Every chunk keeps the identity of the
 * paper it came from, which is what makes evidence traceable later.
 */
function chunkPapers(papers) {
  const chunks = [];
  papers.forEach((paper) => {
    if (!paper.abstract) return;
    chunkText(paper.abstract).forEach((part, index) => {
      chunks.push({
        id: `${paper.id}#${index}`,
        paper_id: paper.id,
        title: paper.title,
        source: paper.source,
        year: paper.year,
        url: paper.url,
        text: part
      });
    });
  });
  return chunks;
}

/** ------------------------------------------------------------ embedders */

const STOP_WORDS = new Set(
  ('a an the of and or to in for on with we our this that these those is are was were be been by as at from ' +
   'it its their there which can could may might will would also such using used use based show shows shown ' +
   'propose proposed present presents paper study results method methods approach').split(' ')
);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

/** Stable 32-bit string hash (FNV-1a) so vectors are reproducible across runs. */
function hashToken(token) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function normalize(vector) {
  let magnitude = 0;
  for (const value of vector) magnitude += value * value;
  magnitude = Math.sqrt(magnitude);
  if (!magnitude) return vector;
  return vector.map((value) => value / magnitude);
}

/** Hashed bag-of-words with sub-linear term weighting, L2 normalised. */
function lexicalEmbed(text) {
  const counts = new Map();
  tokenize(text).forEach((token) => counts.set(token, (counts.get(token) || 0) + 1));

  const vector = new Array(EMBEDDING_DIMS).fill(0);
  for (const [token, count] of counts) {
    const hash = hashToken(token);
    const bucket = hash % EMBEDDING_DIMS;
    // Sign bucketing reduces the damage from hash collisions.
    const sign = (hash >>> 31) === 0 ? 1 : -1;
    vector[bucket] += sign * (1 + Math.log(count));
  }
  return normalize(vector);
}

function embeddingConfig() {
  // EMBEDDINGS_PROVIDER=local forces the local embedder even when a key is
  // present - useful for offline runs and for tests, which should not depend
  // on an embeddings endpoint being reachable.
  const forceLocal = String(process.env.EMBEDDINGS_PROVIDER || '').toLowerCase() === 'local';

  // OpenRouter exposes an OpenAI-shaped /embeddings endpoint, so the same key
  // and gateway cover retrieval as well as chat. Model ids there carry a vendor
  // prefix ("openai/text-embedding-3-small"), unlike the direct OpenAI API.
  return {
    apiKey: forceLocal ? '' : process.env.EMBEDDING_API_KEY || openRouter.apiKey(),
    model: process.env.EMBEDDING_MODEL || 'openai/text-embedding-3-small',
    baseUrl: process.env.EMBEDDING_BASE_URL || openRouter.baseUrl()
  };
}

async function remoteEmbed(texts) {
  const config = embeddingConfig();
  const response = await fetch(`${config.baseUrl}/embeddings`, {
    method: 'POST',
    headers: openRouter.headers(config.apiKey),
    body: JSON.stringify({ model: config.model, input: texts }),
    signal: AbortSignal.timeout(Number(process.env.EMBEDDING_TIMEOUT_MS || 20000))
  });

  if (!response.ok) throw new Error(`embeddings request failed (${response.status})`);

  const data = await response.json();
  if (!Array.isArray(data.data) || data.data.length !== texts.length) {
    throw new Error('embeddings response did not match the input length');
  }
  return data.data.map((item) => normalize(item.embedding));
}

/**
 * Embeds a batch. Falls back to the lexical embedder if the remote one fails,
 * so a retrieval outage degrades ranking quality rather than breaking the
 * request. The embedder actually used is reported back to the caller.
 */
async function embedBatch(texts) {
  const config = embeddingConfig();

  if (config.apiKey) {
    try {
      return { vectors: await remoteEmbed(texts), embedder: `openrouter:${config.model}` };
    } catch (error) {
      console.warn('[rag] embedding request failed, using local lexical vectors:', error.message);
    }
  }
  return { vectors: texts.map(lexicalEmbed), embedder: 'local-lexical' };
}

/** ---------------------------------------------------------- vector index */

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) dot += a[i] * b[i];
  return dot; // both sides are L2 normalised
}

class VectorIndex {
  constructor() {
    this.entries = [];
    this.embedder = null;
  }

  get size() {
    return this.entries.length;
  }

  async add(chunks) {
    if (!chunks.length) return this;
    const { vectors, embedder } = await embedBatch(chunks.map((chunk) => chunk.text));
    this.embedder = embedder;
    chunks.forEach((chunk, index) => this.entries.push({ ...chunk, vector: vectors[index] }));
    return this;
  }

  /**
   * Similarity search. perPaperLimit stops one prolific paper taking every
   * slot, so retrieved evidence spans the whole selection.
   */
  async search(query, { k = 8, perPaperLimit = 2, minScore = 0 } = {}) {
    if (!this.entries.length) return [];

    const { vectors } = await embedBatch([query]);
    const queryVector = vectors[0];

    const scored = this.entries
      .map((entry) => ({ ...entry, score: cosine(queryVector, entry.vector) }))
      .filter((entry) => entry.score > minScore)
      .sort((a, b) => b.score - a.score);

    const perPaper = new Map();
    const selected = [];

    for (const entry of scored) {
      const used = perPaper.get(entry.paper_id) || 0;
      if (used >= perPaperLimit) continue;
      perPaper.set(entry.paper_id, used + 1);
      // Drop the vector - callers only need the text and its provenance.
      const { vector, ...rest } = entry;
      selected.push(rest);
      if (selected.length >= k) break;
    }

    return selected;
  }
}

/** Builds an index over a set of papers in one step. */
async function buildIndex(papers) {
  const chunks = chunkPapers(papers);
  if (!chunks.length) {
    throw new ApiError('NO_ABSTRACTS_AVAILABLE', 'no paper in the selection has an abstract');
  }
  const index = new VectorIndex();
  await index.add(chunks);
  return index;
}

module.exports = {
  VectorIndex,
  buildIndex,
  chunkText,
  chunkPapers,
  lexicalEmbed,
  embedBatch,
  tokenize,
  cosine,
  EMBEDDING_DIMS
};
