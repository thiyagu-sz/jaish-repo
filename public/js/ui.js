/**
 * UI helpers: rendering papers, states and AI insight panels.
 * Exposed as a single global so the other scripts can stay small.
 */
const UI = (() => {
  const DISCLAIMER = 'AI-generated research insights should be verified against the original research.';

  const LOADING_TEXT = {
    summary: 'Analyzing paper...',
    gap: 'Identifying possible research gaps...',
    idea: 'Exploring research directions...'
  };

  // Mirrors the agent names in server/services/aiService.js, so the loading
  // state can name the agent before the response arrives.
  const AGENT_NAMES = {
    summary: 'Summarization Agent',
    gap: 'Gap Analysis Agent',
    idea: 'Innovation Agent'
  };

  /** Always escape API text before putting it in innerHTML. */
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatAuthors(authors = []) {
    if (!authors.length) return 'Unknown authors';
    if (authors.length <= 3) return authors.join(', ');
    return `${authors.slice(0, 3).join(', ')} +${authors.length - 3} more`;
  }

  function shorten(text, limit = 320) {
    if (!text) return 'No abstract available for this paper.';
    return text.length > limit ? `${text.slice(0, limit).trim()}...` : text;
  }

  /** Turns the model's plain text into simple, safe HTML (bullets + paragraphs). */
  function formatInsight(text) {
    const lines = String(text || '').split('\n');
    const html = [];
    let inList = false;

    const closeList = () => {
      if (inList) {
        html.push('</ul>');
        inList = false;
      }
    };

    lines.forEach((rawLine) => {
      const line = rawLine.trim();
      if (!line) {
        closeList();
        return;
      }

      const bullet = line.match(/^(?:[-*]|\d+[.)])\s+(.*)$/);
      const content = escapeHtml(bullet ? bullet[1] : line).replace(
        /\*\*(.+?)\*\*/g,
        '<strong>$1</strong>'
      );

      if (bullet) {
        if (!inList) {
          html.push('<ul>');
          inList = true;
        }
        html.push(`<li>${content}</li>`);
      } else {
        closeList();
        html.push(`<p>${content}</p>`);
      }
    });

    closeList();
    return html.join('');
  }

  /** --------------------------------------------------------- paper cards */
  function paperCard(paper, index) {
    const year = paper.year ? escapeHtml(paper.year) : 'Year unknown';
    return `
      <article class="paper-card">
        <h3 class="paper-title" data-open="${index}">${escapeHtml(paper.title)}</h3>
        <div class="paper-meta">
          <span>${escapeHtml(formatAuthors(paper.authors))}</span>
          <span>${year}</span>
          <span class="source-pill">${escapeHtml(paper.source)}</span>
        </div>
        <p class="paper-abstract">${escapeHtml(shorten(paper.abstract))}</p>
        <div class="paper-actions">
          <a class="btn btn-sm" href="${escapeHtml(paper.url || '#')}" target="_blank" rel="noopener">View Paper</a>
          <button class="btn btn-sm btn-ghost" data-insight="summary" data-index="${index}">Summarize</button>
          <button class="btn btn-sm btn-ghost" data-insight="gap" data-index="${index}">Research Gap</button>
          <button class="btn btn-sm btn-ghost" data-insight="idea" data-index="${index}">Research Idea</button>
        </div>
      </article>`;
  }

  function renderPapers(container, papers) {
    container.innerHTML = papers.map((paper, index) => paperCard(paper, index)).join('');
  }

  /** ------------------------------------------------------------- states */
  function renderState(container, { title, message, loading = false }) {
    container.innerHTML = `
      <div class="state">
        ${loading ? '<span class="spinner"></span>' : ''}
        <strong>${escapeHtml(title)}</strong>
        ${message ? `<span>${escapeHtml(message)}</span>` : ''}
      </div>`;
  }

  function renderBanner(container, message) {
    container.innerHTML = message ? `<div class="banner">${escapeHtml(message)}</div>` : '';
  }

  /** ------------------------------------------------------- detail panel */
  function detailMarkup(paper) {
    const year = paper.year ? escapeHtml(paper.year) : 'Year unknown';
    return `
      <h2>${escapeHtml(paper.title)}</h2>
      <div class="paper-meta">
        <span>${escapeHtml(formatAuthors(paper.authors))}</span>
        <span>${year}</span>
        <span class="source-pill">${escapeHtml(paper.source)}</span>
      </div>

      <h4>Abstract</h4>
      <p class="abstract">${escapeHtml(paper.abstract || 'No abstract available for this paper.')}</p>

      <p><a href="${escapeHtml(paper.url || '#')}" target="_blank" rel="noopener">Open original paper &rarr;</a></p>

      <div class="detail-actions">
        <button class="btn btn-sm btn-primary" data-detail-insight="summary">Summarize Paper</button>
        <button class="btn btn-sm" data-detail-insight="gap">Find Research Gaps</button>
        <button class="btn btn-sm" data-detail-insight="idea">Generate Research Ideas</button>
      </div>

      <div id="insight-slot"></div>
      <p class="disclaimer">${DISCLAIMER}</p>`;
  }

  function insightLoading(type) {
    const agent = AGENT_NAMES[type];
    return `
      <div class="insight" data-insight-type="${type}">
        <div class="insight-head">
          <h4>${escapeHtml(LOADING_TEXT[type] || 'Working...')}</h4>
          ${agent ? `<span class="agent-chip">${escapeHtml(agent)}</span>` : ''}
        </div>
        <p class="insight-body"><span class="spinner"></span></p>
      </div>`;
  }

  function insightResult(result) {
    // Shows which agent answered and which model it used, so the multi-agent
    // setup is visible rather than hidden in config.
    const agent = result.agent ? `<span class="agent-chip">${escapeHtml(result.agent)}</span>` : '';
    const model = result.model ? `<span class="model-chip">${escapeHtml(result.model)}</span>` : '';
    const demo = result.demoMode ? '<span class="badge-demo">Demo Mode</span>' : '';

    return `
      <div class="insight" data-insight-type="${escapeHtml(result.type)}">
        <div class="insight-head">
          <h4>${escapeHtml(result.label)}</h4>
          ${agent}${model}${demo}
        </div>
        <div class="insight-body">${formatInsight(result.text)}</div>
      </div>`;
  }

  function insightError(message) {
    return `
      <div class="insight">
        <div class="insight-head"><h4>Something went wrong</h4></div>
        <div class="insight-body"><p>${escapeHtml(message)}</p></div>
      </div>`;
  }

  return {
    escapeHtml,
    formatInsight,
    renderPapers,
    renderState,
    renderBanner,
    detailMarkup,
    insightLoading,
    insightResult,
    insightError
  };
})();
