/**
 * Researcher profile page.
 *
 * Owns the five sections: publications, research intelligence, candidate gaps,
 * knowledge graph and evidence.
 *
 * Each section loads independently, so one failure does not take the page with
 * it: if analysis is unavailable, publications and the graph still work. That
 * mirrors how the backend degrades.
 */
document.addEventListener('DOMContentLoaded', () => {
  const profileSlot = document.getElementById('profile-header-slot');
  if (!profileSlot) return;

  const researcherId = new URLSearchParams(window.location.search).get('id');

  const slots = {
    papers: document.getElementById('papers-slot'),
    papersNotice: document.getElementById('papers-notice'),
    analysis: document.getElementById('analysis-slot'),
    gaps: document.getElementById('gaps-slot'),
    graph: document.getElementById('graph-slot'),
    graphLegend: document.getElementById('graph-legend'),
    graphNotice: document.getElementById('graph-notice'),
    graphDetail: document.getElementById('graph-detail'),
    evidence: document.getElementById('evidence-slot')
  };

  // Everything generated in this session, so the Evidence tab can show the
  // provenance of every claim currently on screen.
  const state = {
    researcher: null,
    analysis: null,
    gaps: null,
    analysisAvailable: true
  };

  if (!researcherId) {
    ResearchUI.renderState(profileSlot, {
      title: 'No researcher selected.',
      message: 'Open this page from the researcher search.'
    });
    return;
  }

  /** ---------------------------------------------------------------- tabs */

  const tabs = [...document.querySelectorAll('.tab')];
  const panels = [...document.querySelectorAll('.tab-panel')];

  function activateTab(name) {
    tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
    panels.forEach((panel) => panel.classList.toggle('active', panel.id === `panel-${name}`));

    const url = new URL(window.location.href);
    url.searchParams.set('tab', name);
    window.history.replaceState({}, '', url);

    // The graph needs a laid-out container to measure, so it is drawn the
    // first time its panel becomes visible rather than on page load.
    if (name === 'graph' && !slots.graph.dataset.loaded) loadGraph();
  }

  tabs.forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));

  /** ------------------------------------------------------------- profile */

  async function loadProfile() {
    try {
      const { researcher } = await ResearchAPI.getResearcher(researcherId);
      state.researcher = researcher;
      ResearchUI.renderProfileHeader(profileSlot, researcher);
      document.title = `${researcher.name} - ResearchAI`;
    } catch (error) {
      ResearchUI.renderError(profileSlot, error, { retryLabel: 'Retry' });
      profileSlot.querySelector('[data-retry]')?.addEventListener('click', loadProfile);
    }
  }

  /** -------------------------------------------------------- publications */

  async function loadPapers() {
    const limit = Number(document.getElementById('papers-limit').value);
    const yearFrom = document.getElementById('papers-year-from').value;
    const yearTo = document.getElementById('papers-year-to').value;
    const sub = document.getElementById('papers-sub');

    ResearchUI.renderNotice(slots.papersNotice, '');
    ResearchUI.renderStages(slots.papers, ['Retrieving publications...'], 0);

    try {
      const data = await ResearchAPI.getPapers(researcherId, { limit, yearFrom, yearTo });

      if (!data.papers.length) {
        sub.textContent = '';
        ResearchUI.renderState(slots.papers, {
          title: 'No publications matched.',
          message: 'Try widening the year range.'
        });
        return;
      }

      const withoutAbstract = data.papers.filter((paper) => !paper.abstract).length;
      sub.textContent =
        `${data.papers.length} publications retrieved` +
        (data.enrichment.papers_enriched
          ? `, ${data.enrichment.papers_enriched} enriched with OpenAlex topics`
          : '') +
        (withoutAbstract ? `. ${withoutAbstract} have no abstract and cannot be analysed.` : '.');

      // Papers served from the other provider come from a different index and
      // were matched to this person by ORCID or name, so say so rather than
      // presenting them as though nothing had changed.
      if (data.fallback) {
        ResearchUI.renderNotice(
          slots.papersNotice,
          `${ResearchUI.sourceLabel(data.fallback.from)} is rate limited, so these publications ` +
            `come from ${ResearchUI.sourceLabel(data.fallback.to)}, matched to ` +
            `"${data.fallback.matched_researcher.name}" by ` +
            `${data.fallback.matched_by === 'orcid' ? 'ORCID' : 'exact name'}.`,
          'warn'
        );
      } else {
        ResearchUI.renderNotice(slots.papersNotice, '');
      }

      ResearchUI.renderPapers(slots.papers, data.papers);
    } catch (error) {
      sub.textContent = '';
      ResearchUI.renderError(slots.papers, error, { retryLabel: 'Retry' });
      slots.papers.querySelector('[data-retry]')?.addEventListener('click', loadPapers);
    }
  }

  document.getElementById('papers-apply').addEventListener('click', loadPapers);
  document.getElementById('papers-limit').addEventListener('change', loadPapers);

  /** ------------------------------------------------------------ analysis */

  const ANALYSIS_STAGES = [
    'Retrieving publications...',
    'Selecting papers with abstracts...',
    'Building the retrieval index...',
    'Analyzing research themes...'
  ];

  /**
   * Advances the stage display on a timer.
   *
   * The backend performs these steps but does not stream progress, so the
   * display is time-based and deliberately stops at the final stage rather
   * than showing a percentage it cannot know.
   */
  function runStages(container, stages) {
    let index = 0;
    ResearchUI.renderStages(container, stages, 0);

    const timer = setInterval(() => {
      if (index < stages.length - 1) {
        index += 1;
        ResearchUI.renderStages(container, stages, index);
      }
    }, 1400);

    return () => clearInterval(timer);
  }

  function renderAnalysis(payload) {
    const { analysis } = payload;

    const header = `
      <div class="result-meta">
        <span>${analysis.meta.papers_analyzed} papers analysed</span>
        <span>${analysis.meta.excerpts_used} excerpts retrieved</span>
        <span>${ResearchUI.escapeHtml(payload.retrieval.embedder)} embeddings</span>
        <span>${ResearchUI.escapeHtml(analysis.meta.model)}</span>
        ${payload.cached ? '<span>cached result</span>' : ''}
        ${
          analysis.meta.items_dropped_unverifiable
            ? `<span class="meta-warn">${analysis.meta.items_dropped_unverifiable} unverifiable items discarded</span>`
            : ''
        }
      </div>`;

    slots.analysis.innerHTML = `
      ${header}
      ${ResearchUI.extractionSection('Research themes', analysis.research_themes)}
      ${ResearchUI.extractionSection('Methods', analysis.methods)}
      ${ResearchUI.extractionSection('Datasets', analysis.datasets, {
        note: 'Only datasets named in an abstract are listed. Many abstracts name none.'
      })}
      ${ResearchUI.extractionSection('Domains', analysis.domains)}
      ${ResearchUI.extractionSection('Topics', analysis.topics)}
      ${ResearchUI.extractionSection('Stated limitations', analysis.limitations)}
      ${ResearchUI.extractionSection('Recurring patterns', analysis.recurring_patterns, {
        note: 'Each pattern must be supported by at least two of the analysed papers.'
      })}
      ${ResearchUI.institutionSection(analysis.institutions)}

      <details class="papers-analysed">
        <summary>The ${payload.papers_analyzed.length} papers this analysis is based on</summary>
        <ul class="plain-list">
          ${payload.papers_analyzed
            .map(
              (paper) =>
                `<li><a href="${ResearchUI.escapeHtml(paper.url || '#')}" target="_blank" rel="noopener">${ResearchUI.escapeHtml(
                  paper.title
                )}</a><span class="muted-count">${paper.year ?? ''}</span></li>`
            )
            .join('')}
        </ul>
      </details>`;
  }

  async function runAnalysis() {
    const button = document.getElementById('run-analysis');
    button.disabled = true;
    const stopStages = runStages(slots.analysis, ANALYSIS_STAGES);

    try {
      const payload = await ResearchAPI.analyze(researcherId, {});
      state.analysis = payload;
      renderAnalysis(payload);
      renderEvidence();
      button.textContent = 'Re-run analysis';
    } catch (error) {
      if (error.code === 'LLM_NOT_CONFIGURED') state.analysisAvailable = false;
      ResearchUI.renderError(slots.analysis, error, { retryLabel: 'Try again' });
      slots.analysis.querySelector('[data-retry]')?.addEventListener('click', runAnalysis);
    } finally {
      stopStages();
      button.disabled = false;
    }
  }

  document.getElementById('run-analysis').addEventListener('click', runAnalysis);

  /** ---------------------------------------------------------------- gaps */

  const GAP_STAGES = [
    'Retrieving publications...',
    'Analyzing research themes...',
    'Comparing papers against each other...',
    'Detecting candidate research gaps...'
  ];

  function renderGaps(payload) {
    const meta = `
      <div class="result-meta">
        <span>${payload.meta.papers_analyzed} papers compared</span>
        <span>${payload.meta.gaps_proposed} proposed</span>
        <span>${payload.gaps.length} retained after evidence checks</span>
        ${
          payload.meta.gaps_dropped_unverifiable
            ? `<span class="meta-warn">${payload.meta.gaps_dropped_unverifiable} discarded as unverifiable</span>`
            : ''
        }
        <span>${ResearchUI.escapeHtml(payload.meta.model)}</span>
      </div>`;

    if (!payload.gaps.length) {
      slots.gaps.innerHTML = `
        ${meta}
        <div class="state">
          <strong>Insufficient evidence.</strong>
          <span>
            The analysed papers did not support a candidate gap that could be traced to at
            least two of them. Nothing has been generated in place of that.
          </span>
        </div>`;
      return;
    }

    slots.gaps.innerHTML = `
      ${meta}
      <div class="disclaimer-panel">${ResearchUI.escapeHtml(payload.disclaimer)}</div>
      <div class="gap-list">${payload.gaps.map((gap, index) => ResearchUI.gapCard(gap, index)).join('')}</div>`;
  }

  async function runGaps() {
    const button = document.getElementById('run-gaps');
    button.disabled = true;
    const stopStages = runStages(slots.gaps, GAP_STAGES);

    try {
      const payload = await ResearchAPI.gaps(researcherId, {});
      state.gaps = payload;
      renderGaps(payload);
      renderEvidence();
      button.textContent = 'Re-run detection';
    } catch (error) {
      if (error.code === 'LLM_NOT_CONFIGURED') state.analysisAvailable = false;
      ResearchUI.renderError(slots.gaps, error, { retryLabel: 'Try again' });
      slots.gaps.querySelector('[data-retry]')?.addEventListener('click', runGaps);
    } finally {
      stopStages();
      button.disabled = false;
    }
  }

  document.getElementById('run-gaps').addEventListener('click', runGaps);

  /** --------------------------------------------------------------- graph */

  function showNodeDetail(node, connected) {
    const grouped = connected.reduce((accumulator, entry) => {
      (accumulator[entry.type] = accumulator[entry.type] || []).push(entry.other);
      return accumulator;
    }, {});

    const relations = Object.entries(grouped)
      .map(
        ([type, others]) => `
          <div class="relation-group">
            <span class="relation-type">${ResearchUI.escapeHtml(type)}</span>
            <ul class="plain-list">
              ${others
                .slice(0, 12)
                .map((other) => `<li><span>${ResearchUI.escapeHtml(other.label)}</span><span class="muted-count">${ResearchUI.escapeHtml(other.type)}</span></li>`)
                .join('')}
            </ul>
            ${others.length > 12 ? `<p class="muted-count">and ${others.length - 12} more</p>` : ''}
          </div>`
      )
      .join('');

    const properties = node.properties || {};
    const isGap = node.type === 'ResearchGap';

    // Evidence is the point of the graph: a node that came from the analysis
    // carries the excerpts it was drawn from, and a gap carries the papers that
    // support it. Both are shown here rather than left in the JSON.
    const evidence = Array.isArray(properties.evidence) ? properties.evidence : [];

    const evidenceBlock = evidence.length
      ? `<div class="relation-group">
           <span class="relation-type">${isGap ? 'SUPPORTING PAPERS' : 'EVIDENCE'}</span>
           <ul class="evidence-list">${evidence.map(ResearchUI.evidenceItem).join('')}</ul>
         </div>`
      : `<p class="unknown">No excerpt is attached to this node.</p>`;

    const gapHeader = isGap
      ? `<span class="badge-candidate">Candidate gap</span>
         <p class="gap-description">${ResearchUI.escapeHtml(properties.description || '')}</p>
         ${properties.reasoning ? `<p class="gap-reasoning"><strong>Why this follows from the papers:</strong> ${ResearchUI.escapeHtml(properties.reasoning)}</p>` : ''}
         ${properties.disclaimer ? `<div class="disclaimer-panel">${ResearchUI.escapeHtml(properties.disclaimer)}</div>` : ''}`
      : properties.description
        ? `<p class="extracted-description">${ResearchUI.escapeHtml(properties.description)}</p>`
        : '';

    const confidence = properties.confidence != null
      ? `<div class="detail-confidence">
           ${ResearchUI.confidenceBar(properties.confidence)}
           <span class="confidence-note">${ResearchUI.escapeHtml(properties.confidence_meaning || '')}</span>
         </div>`
      : '';

    slots.graphDetail.hidden = false;
    slots.graphDetail.innerHTML = `
      <div class="graph-detail-head">
        <div>
          <span class="origin-badge ${node.provenance === 'llm' ? 'origin-llm' : 'origin-provider'}">
            ${node.provenance === 'llm' ? 'Model-extracted' : 'Provider metadata'}
          </span>
          <h3>${ResearchUI.escapeHtml(node.label)}</h3>
          <span class="gap-type">${ResearchUI.escapeHtml(node.type)} &middot; appears ${node.weight} time${node.weight === 1 ? '' : 's'}</span>
        </div>
        ${
          properties.url
            ? `<a class="btn btn-sm" href="${ResearchUI.escapeHtml(properties.url)}" target="_blank" rel="noopener">Open source</a>`
            : ''
        }
      </div>
      ${gapHeader}
      ${confidence}
      ${node.type === 'Researcher' ? '' : evidenceBlock}
      ${relations || '<p class="unknown">This node has no recorded relationships.</p>'}`;

    slots.graphDetail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function loadGraph() {
    const source = document.getElementById('graph-source').value;
    const includeGaps = document.getElementById('graph-include-gaps').checked;
    const includeAnalysis = document.getElementById('graph-include-analysis').checked;
    const isAnalysis = source === 'analysis';

    // The two graphs answer different questions, so their controls differ.
    document.getElementById('graph-gaps-field').hidden = !isAnalysis;
    document.getElementById('graph-analysis-field').hidden = isAnalysis;

    slots.graphDetail.hidden = true;
    slots.graphLegend.hidden = true;

    const stages = isAnalysis
      ? ['Analyzing research themes...']
          .concat(includeGaps ? ['Detecting candidate research gaps...'] : [])
          .concat(['Building knowledge graph...'])
      : ['Retrieving publications...']
          .concat(includeAnalysis ? ['Analyzing research themes...'] : [])
          .concat(['Building knowledge graph...']);

    const stopStages = runStages(slots.graph, stages);

    try {
      const graph = isAnalysis
        ? await ResearchAPI.analysisGraph(researcherId, { includeGaps })
        : await ResearchAPI.graph(researcherId, { maxPapers: 30, includeAnalysis });

      slots.graph.dataset.loaded = 'true';

      const sub = document.getElementById('graph-sub');
      const counts = graph.meta || graph.summary;
      sub.textContent =
        `${counts.node_count} entities and ${counts.edge_count} relationships` +
        (isAnalysis ? ` from the analysis of ${graph.meta.papers_analyzed} papers` : '') +
        `. ${graph.provenance.note || 'Built from provider metadata only.'}`;

      // A gap pass that failed should be said out loud, not left as an absence.
      ResearchUI.renderNotice(
        slots.graphNotice,
        isAnalysis && graph.meta.gaps_note ? `Candidate gaps: ${graph.meta.gaps_note}` : '',
        'warn'
      );

      slots.graphLegend.hidden = false;
      GraphView.renderLegend(slots.graphLegend, graph);
      GraphView.render(slots.graph, graph, {
        onSelect: showNodeDetail,
        // The analysis graph is small and hierarchical, so concentric rings
        // read better than a force layout.
        layout: isAnalysis ? 'radial' : 'force'
      });
    } catch (error) {
      ResearchUI.renderNotice(slots.graphNotice, '');
      ResearchUI.renderError(slots.graph, error, { retryLabel: 'Retry' });
      slots.graph.querySelector('[data-retry]')?.addEventListener('click', loadGraph);
    } finally {
      stopStages();
    }
  }

  document.getElementById('reload-graph').addEventListener('click', loadGraph);
  document.getElementById('graph-include-analysis').addEventListener('change', loadGraph);
  document.getElementById('graph-include-gaps').addEventListener('change', loadGraph);
  document.getElementById('graph-source').addEventListener('change', loadGraph);

  /** ------------------------------------------------------------ evidence */

  /**
   * Collects every claim currently displayed, with its evidence. Nothing is
   * generated here - this view only re-presents what the agents returned.
   */
  function renderEvidence() {
    const claims = [];

    if (state.analysis) {
      const { analysis } = state.analysis;
      const collect = (items, kind) =>
        items.forEach((item) =>
          claims.push({
            kind,
            claim: item.description || item.name,
            name: item.name,
            evidence: item.evidence,
            confidence: item.confidence
          })
        );

      collect(analysis.research_themes, 'Research theme');
      collect(analysis.limitations, 'Stated limitation');
      collect(analysis.recurring_patterns, 'Recurring pattern');
      collect(analysis.methods, 'Method');
      collect(analysis.datasets, 'Dataset');
    }

    if (state.gaps) {
      state.gaps.gaps.forEach((gap) =>
        claims.push({
          kind: 'Candidate research gap',
          claim: gap.description,
          name: gap.title,
          evidence: gap.evidence,
          confidence: gap.confidence
        })
      );
    }

    if (!claims.length) {
      ResearchUI.renderState(slots.evidence, {
        title: 'Nothing has been generated yet.',
        message: 'Run the analysis or gap detection first; every claim will appear here with its sources.'
      });
      return;
    }

    slots.evidence.innerHTML = `
      <div class="result-meta"><span>${claims.length} claims currently displayed</span></div>
      <div class="evidence-claims">
        ${claims
          .map(
            (entry) => `
              <article class="evidence-claim">
                <div class="evidence-claim-head">
                  <span class="gap-type">${ResearchUI.escapeHtml(entry.kind)}</span>
                  ${ResearchUI.confidenceBar(entry.confidence)}
                </div>
                <h3>${ResearchUI.escapeHtml(entry.name)}</h3>
                ${entry.claim && entry.claim !== entry.name ? `<p>${ResearchUI.escapeHtml(entry.claim)}</p>` : ''}
                <ul class="evidence-list">${entry.evidence.map(ResearchUI.evidenceItem).join('')}</ul>
              </article>`
          )
          .join('')}
      </div>`;
  }

  /** ----------------------------------------------------------- page start */

  /** Disables the analysis actions up front when no model is configured. */
  async function checkCapabilities() {
    try {
      const health = await ResearchAPI.health();
      if (health.analysis_available) return;

      state.analysisAvailable = false;
      const message =
        'No language model is configured, so analysis and gap detection are unavailable. ' +
        'Publications and the knowledge graph work without one. ' +
        'Set OPENROUTER_API_KEY in .env and restart the server to enable them.';

      ['run-analysis', 'run-gaps'].forEach((id) => {
        const button = document.getElementById(id);
        button.disabled = true;
        button.title = message;
      });

      ResearchUI.renderNotice(slots.analysis, message, 'warn');
      ResearchUI.renderNotice(slots.gaps, message, 'warn');
    } catch {
      // A failed capability check is not worth blocking the page for; the
      // actions themselves will report the real error if one is hit.
    }
  }

  loadProfile();
  loadPapers();
  checkCapabilities();
  renderEvidence();

  const initialTab = new URLSearchParams(window.location.search).get('tab');
  if (initialTab && tabs.some((tab) => tab.dataset.tab === initialTab)) activateTab(initialTab);
});
