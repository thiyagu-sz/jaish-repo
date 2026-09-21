/**
 * Rendering helpers for the researcher screens.
 *
 * Two conventions run through this file:
 *   - every value from the API is escaped before it reaches innerHTML;
 *   - anything derived from a language model is labelled as such, and anything
 *     that comes from a provider is labelled too, so a reader can always tell
 *     where a statement on screen came from.
 */
const ResearchUI = (() => {
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const SOURCE_LABELS = {
    semantic_scholar: 'Semantic Scholar',
    openalex: 'OpenAlex'
  };

  function sourceLabel(source) {
    return SOURCE_LABELS[source] || source || 'unknown source';
  }

  function number(value) {
    return value == null ? null : Number(value).toLocaleString('en-US');
  }

  /** Renders a metric only when the provider supplied it. */
  function metric(label, value) {
    const formatted = number(value);
    if (formatted === null) return '';
    return `
      <div class="metric">
        <span class="metric-value">${escapeHtml(formatted)}</span>
        <span class="metric-label">${escapeHtml(label)}</span>
      </div>`;
  }

  function formatAuthors(authors = []) {
    if (!authors.length) return 'Unknown authors';
    if (authors.length <= 3) return authors.join(', ');
    return `${authors.slice(0, 3).join(', ')} and ${authors.length - 3} more`;
  }

  /** ------------------------------------------------------------- states */

  /**
   * Stage-based loading. There is no percentage here on purpose: the backend
   * cannot report real progress, and a made-up bar would be a false signal.
   */
  function renderStages(container, stages, activeIndex) {
    container.innerHTML = `
      <div class="stage-list" role="status" aria-live="polite">
        ${stages
          .map((stage, index) => {
            const state = index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'pending';
            const marker =
              state === 'done' ? '&#10003;' : state === 'active' ? '<span class="spinner"></span>' : '';
            return `
              <div class="stage stage-${state}">
                <span class="stage-marker">${marker}</span>
                <span>${escapeHtml(stage)}</span>
              </div>`;
          })
          .join('')}
      </div>`;
  }

  function renderState(container, { title, message, loading = false }) {
    container.innerHTML = `
      <div class="state">
        ${loading ? '<span class="spinner"></span>' : ''}
        <strong>${escapeHtml(title)}</strong>
        ${message ? `<span>${escapeHtml(message)}</span>` : ''}
      </div>`;
  }

  /**
   * Error panel. Shows the request id so a failure on screen can be matched to
   * a server log line, and adapts the suggested action to the error code.
   */
  function renderError(container, error, { retryLabel } = {}) {
    const GUIDANCE = {
      LLM_NOT_CONFIGURED:
        'Add an OpenRouter key as OPENROUTER_API_KEY in your .env file and restart the server. ' +
        'Search, publications and the knowledge graph work without one.',
      PROVIDER_RATE_LIMITED:
        'The scholarly provider is rate limiting anonymous requests. Wait a moment, or add a ' +
        'SEMANTIC_SCHOLAR_API_KEY to raise the limit.',
      PROVIDER_TIMEOUT: 'The provider did not respond in time. This is usually temporary.',
      RESEARCH_PROVIDER_UNAVAILABLE: 'The scholarly provider could not be reached.',
      NO_ABSTRACTS_AVAILABLE:
        'None of the retrieved publications include an abstract, so there is nothing to analyse. ' +
        'Try a researcher with more indexed abstracts.',
      NO_PAPERS_AVAILABLE: 'No publications could be retrieved for this researcher.',
      LLM_INVALID_OUTPUT: 'The model returned output that failed validation twice, so nothing was shown.',
      NETWORK_ERROR: 'Check that the server is running.'
    };

    const guidance = GUIDANCE[error.code] || '';

    container.innerHTML = `
      <div class="error-panel">
        <div class="error-head">
          <strong>${escapeHtml(error.message)}</strong>
          <span class="error-code">${escapeHtml(error.code)}</span>
        </div>
        ${guidance ? `<p>${escapeHtml(guidance)}</p>` : ''}
        ${error.requestId ? `<p class="error-meta">Request id: ${escapeHtml(error.requestId)}</p>` : ''}
        ${retryLabel ? `<button class="btn btn-sm" data-retry>${escapeHtml(retryLabel)}</button>` : ''}
      </div>`;
  }

  function renderNotice(container, message, tone = 'info') {
    container.innerHTML = message
      ? `<div class="notice notice-${escapeHtml(tone)}">${escapeHtml(message)}</div>`
      : '';
  }

  /** ------------------------------------------------------ researcher cards */

  function researcherCard(researcher) {
    const affiliation = researcher.affiliations.length
      ? escapeHtml(researcher.affiliations.slice(0, 2).join(' / '))
      : '<span class="unknown">Affiliation not listed by the provider</span>';

    return `
      <article class="paper-card researcher-card">
        <div class="researcher-card-main">
          <h3 class="paper-title">
            <a href="researcher.html?id=${encodeURIComponent(researcher.id)}">${escapeHtml(researcher.name)}</a>
          </h3>
          <p class="researcher-affiliation">${affiliation}</p>
          <div class="paper-meta">
            <span class="source-pill">${escapeHtml(sourceLabel(researcher.source))}</span>
            ${researcher.paper_count != null ? `<span>${escapeHtml(number(researcher.paper_count))} publications</span>` : ''}
            ${researcher.citation_count != null ? `<span>${escapeHtml(number(researcher.citation_count))} citations</span>` : ''}
            ${researcher.h_index != null ? `<span>h-index ${escapeHtml(number(researcher.h_index))}</span>` : ''}
          </div>
        </div>
        <a class="btn btn-sm btn-primary" href="researcher.html?id=${encodeURIComponent(researcher.id)}">
          Open profile
        </a>
      </article>`;
  }

  function renderResearchers(container, researchers) {
    container.innerHTML = researchers.map(researcherCard).join('');
  }

  /** ------------------------------------------------------------- profile */

  function renderProfileHeader(container, researcher) {
    const affiliations = researcher.affiliations.length
      ? researcher.affiliations.map((name) => `<span class="tag">${escapeHtml(name)}</span>`).join('')
      : '<span class="unknown">No affiliation listed by the provider</span>';

    const externalIds = Object.entries(researcher.external_ids || {})
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`);

    container.innerHTML = `
      <h1>${escapeHtml(researcher.name)}</h1>
      <div class="tag-list profile-affiliations">${affiliations}</div>

      <div class="metric-row">
        ${metric('Publications', researcher.paper_count)}
        ${metric('Citations', researcher.citation_count)}
        ${metric('h-index', researcher.h_index)}
      </div>

      <p class="provenance-line">
        Profile data from <strong>${escapeHtml(sourceLabel(researcher.source))}</strong>
        ${researcher.url ? `&middot; <a href="${escapeHtml(researcher.url)}" target="_blank" rel="noopener">view on provider</a>` : ''}
        ${externalIds.length ? `&middot; ${escapeHtml(externalIds.join(' &middot; '))}` : ''}
      </p>`;
  }

  /** ---------------------------------------------------------- publications */

  function paperRow(paper) {
    const year = paper.year != null ? escapeHtml(paper.year) : 'Year not recorded';
    const topics = paper.topics
      .slice(0, 4)
      .map((topic) => `<span class="chip-static">${escapeHtml(topic)}</span>`)
      .join('');

    return `
      <article class="paper-card">
        <h3 class="paper-title">
          <a href="${escapeHtml(paper.url || '#')}" target="_blank" rel="noopener">${escapeHtml(paper.title)}</a>
        </h3>
        <div class="paper-meta">
          <span>${escapeHtml(formatAuthors(paper.authors))}</span>
          <span>${year}</span>
          ${paper.venue ? `<span>${escapeHtml(paper.venue)}</span>` : ''}
          ${paper.citation_count != null ? `<span>${escapeHtml(number(paper.citation_count))} citations</span>` : ''}
          <span class="source-pill">${escapeHtml(sourceLabel(paper.source))}</span>
          ${paper.enriched_from ? '<span class="source-pill">topics via OpenAlex</span>' : ''}
        </div>
        ${
          paper.abstract
            ? `<p class="paper-abstract">${escapeHtml(paper.abstract)}</p>`
            : '<p class="paper-abstract unknown">No abstract is available from the provider for this record, so it cannot be analysed.</p>'
        }
        ${topics ? `<div class="chip-row">${topics}</div>` : ''}
        <div class="paper-actions">
          ${paper.open_access_url ? `<a class="btn btn-sm" href="${escapeHtml(paper.open_access_url)}" target="_blank" rel="noopener">Open access PDF</a>` : ''}
          ${paper.doi ? `<a class="btn btn-sm btn-ghost" href="${escapeHtml(paper.doi)}" target="_blank" rel="noopener">DOI</a>` : ''}
        </div>
      </article>`;
  }

  function renderPapers(container, papers) {
    container.innerHTML = papers.map(paperRow).join('');
  }

  /** ------------------------------------------------- analysis presentation */

  /** One evidence item: which paper, which excerpt, which source. */
  function evidenceItem(evidence) {
    return `
      <li class="evidence-item">
        <a class="evidence-title" href="${escapeHtml(evidence.url || '#')}" target="_blank" rel="noopener">
          ${escapeHtml(evidence.title)}
        </a>
        <div class="evidence-meta">
          <span class="source-pill">${escapeHtml(sourceLabel(evidence.source))}</span>
          ${evidence.year != null ? `<span>${escapeHtml(evidence.year)}</span>` : ''}
          <span class="mono">${escapeHtml(evidence.paper_id)}</span>
        </div>
        <blockquote class="evidence-excerpt">${escapeHtml(evidence.excerpt)}</blockquote>
      </li>`;
  }

  function confidenceBar(confidence) {
    const percent = Math.round((confidence || 0) * 100);
    return `
      <span class="confidence" title="How well the analysed papers support this statement. Not a measure of novelty.">
        <span class="confidence-track"><span class="confidence-fill" style="width:${percent}%"></span></span>
        <span class="confidence-value">${percent}% evidence support</span>
      </span>`;
  }

  /**
   * An extracted item with its evidence collapsed behind a disclosure, so the
   * list stays readable but the evidence is always one click away.
   */
  function extractedItem(item, { showConfidence = true } = {}) {
    return `
      <li class="extracted-item">
        <div class="extracted-head">
          <span class="extracted-name">${escapeHtml(item.name)}</span>
          ${showConfidence ? confidenceBar(item.confidence) : ''}
        </div>
        ${item.description ? `<p class="extracted-description">${escapeHtml(item.description)}</p>` : ''}
        <details class="evidence-details">
          <summary>${item.evidence.length} supporting ${item.evidence.length === 1 ? 'paper' : 'papers'}</summary>
          <ul class="evidence-list">${item.evidence.map(evidenceItem).join('')}</ul>
        </details>
      </li>`;
  }

  /** A section of extracted items, or an explicit statement that there were none. */
  function extractionSection(title, items, { note, llmDerived = true } = {}) {
    const badge = llmDerived
      ? '<span class="origin-badge origin-llm">Model-extracted</span>'
      : '<span class="origin-badge origin-provider">Provider metadata</span>';

    if (!items.length) {
      return `
        <section class="analysis-section">
          <div class="analysis-section-head"><h3>${escapeHtml(title)}</h3>${badge}</div>
          <p class="unknown">Insufficient evidence in the analysed papers.</p>
        </section>`;
    }

    return `
      <section class="analysis-section">
        <div class="analysis-section-head"><h3>${escapeHtml(title)}</h3>${badge}</div>
        ${note ? `<p class="section-note">${escapeHtml(note)}</p>` : ''}
        <ul class="extracted-list">${items.map((item) => extractedItem(item)).join('')}</ul>
      </section>`;
  }

  /** Provider-supplied institutions, which carry a count rather than evidence. */
  function institutionSection(institutions) {
    if (!institutions.length) {
      return `
        <section class="analysis-section">
          <div class="analysis-section-head"><h3>Institutions</h3><span class="origin-badge origin-provider">Provider metadata</span></div>
          <p class="unknown">No institution was listed on these records.</p>
        </section>`;
    }

    return `
      <section class="analysis-section">
        <div class="analysis-section-head"><h3>Institutions</h3><span class="origin-badge origin-provider">Provider metadata</span></div>
        <ul class="plain-list">
          ${institutions
            .map(
              (institution) =>
                `<li><span>${escapeHtml(institution.name)}</span><span class="muted-count">${escapeHtml(
                  institution.paper_count
                )} record${institution.paper_count === 1 ? '' : 's'}</span></li>`
            )
            .join('')}
        </ul>
      </section>`;
  }

  /** ------------------------------------------------------------------ gaps */

  const GAP_TYPE_LABELS = {
    recurring_limitation: 'Recurring limitation',
    underexplored_combination: 'Underexplored combination',
    methodological: 'Methodological',
    evaluation: 'Evaluation',
    application_domain: 'Application domain'
  };

  function gapCard(gap, index) {
    return `
      <article class="gap-card">
        <div class="gap-head">
          <span class="gap-index">${index + 1}</span>
          <div>
            <h3>${escapeHtml(gap.title)}</h3>
            <span class="gap-type">${escapeHtml(GAP_TYPE_LABELS[gap.type] || gap.type)}</span>
          </div>
          ${confidenceBar(gap.confidence)}
        </div>

        <p class="gap-description">${escapeHtml(gap.description)}</p>
        ${gap.reasoning ? `<p class="gap-reasoning"><strong>Why this follows from the papers:</strong> ${escapeHtml(gap.reasoning)}</p>` : ''}

        ${
          gap.related_topics.length
            ? `<div class="chip-row">${gap.related_topics
                .map((topic) => `<span class="chip-static">${escapeHtml(topic)}</span>`)
                .join('')}</div>`
            : ''
        }

        <details class="evidence-details" open>
          <summary>Evidence: ${gap.evidence.length} papers</summary>
          <ul class="evidence-list">${gap.evidence.map(evidenceItem).join('')}</ul>
        </details>
      </article>`;
  }

  return {
    escapeHtml,
    sourceLabel,
    number,
    formatAuthors,
    renderStages,
    renderState,
    renderError,
    renderNotice,
    renderResearchers,
    renderProfileHeader,
    renderPapers,
    paperRow,
    evidenceItem,
    confidenceBar,
    extractedItem,
    extractionSection,
    institutionSection,
    gapCard
  };
})();
