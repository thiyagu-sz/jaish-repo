/**
 * Page wiring for ResearchAI.
 * The landing page only needs to hand the query to the research page;
 * the research page does the searching, rendering and AI calls.
 */
document.addEventListener('DOMContentLoaded', () => {
  setupLandingPage();
  setupResearchPage();
});

/* -------------------------------------------------------------- landing page */
function setupLandingPage() {
  const form = document.getElementById('hero-search');
  if (!form) return;

  const input = document.getElementById('hero-query');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) {
      input.focus();
      return;
    }
    window.location.href = `research.html?q=${encodeURIComponent(query)}`;
  });

  const examples = document.getElementById('examples');
  if (examples) {
    examples.addEventListener('click', (event) => {
      const chip = event.target.closest('.chip');
      if (!chip) return;
      input.value = chip.textContent.trim();
      form.requestSubmit();
    });
  }
}

/* ------------------------------------------------------------- research page */
function setupResearchPage() {
  const form = document.getElementById('search-form');
  if (!form) return;

  const input = document.getElementById('query');
  const results = document.getElementById('results');
  const bannerSlot = document.getElementById('banner-slot');
  const resultsHead = document.getElementById('results-head');
  const resultsTitle = document.getElementById('results-title');
  const resultsCount = document.getElementById('results-count');
  const demoBadge = document.getElementById('demo-badge');

  const sourceSelect = document.getElementById('filter-source');
  const yearSelect = document.getElementById('filter-year');
  const sortSelect = document.getElementById('filter-sort');

  const overlay = document.getElementById('overlay');
  const panel = document.getElementById('detail-panel');
  const detailBody = document.getElementById('detail-body');

  let papers = [];
  let activePaper = null;

  /** ------------------------------------------------------------- search */
  async function runSearch(query) {
    const trimmed = query.trim();
    if (!trimmed) {
      input.focus();
      return;
    }

    resultsHead.hidden = false;
    resultsTitle.textContent = trimmed;
    resultsCount.textContent = '';
    demoBadge.hidden = true;
    UI.renderBanner(bannerSlot, '');
    UI.renderState(results, { title: 'Searching research papers...', loading: true });

    // Keep the URL shareable without reloading the page.
    const params = new URLSearchParams({ q: trimmed });
    window.history.replaceState({}, '', `research.html?${params.toString()}`);

    try {
      const data = await API.searchPapers({
        query: trimmed,
        source: sourceSelect.value,
        year: yearSelect.value,
        sort: sortSelect.value
      });

      papers = data.papers || [];
      demoBadge.hidden = !data.demoMode;

      if (data.demoMode) {
        UI.renderBanner(bannerSlot, 'Unable to retrieve papers. Showing demo results.');
      }

      if (!papers.length) {
        resultsCount.textContent = '';
        UI.renderState(results, {
          title: 'No research papers found.',
          message: 'Try another query, or widen the year and source filters.'
        });
        return;
      }

      resultsCount.textContent = `${papers.length} paper${papers.length === 1 ? '' : 's'} found`;
      UI.renderPapers(results, papers);
    } catch (error) {
      papers = [];
      UI.renderBanner(bannerSlot, 'Unable to retrieve papers. Please check that the server is running.');
      UI.renderState(results, {
        title: 'Search failed.',
        message: error.message
      });
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    runSearch(input.value);
  });

  // Re-run the current search whenever a filter changes.
  [sourceSelect, yearSelect, sortSelect].forEach((select) => {
    select.addEventListener('change', () => {
      if (input.value.trim()) runSearch(input.value);
    });
  });

  /** ------------------------------------------------------- detail panel */
  function openDetail(paper) {
    activePaper = paper;
    detailBody.innerHTML = UI.detailMarkup(paper);
    detailBody.scrollTop = 0;
    overlay.hidden = false;
    // Next frame, so the CSS transition has a starting state to animate from.
    requestAnimationFrame(() => {
      overlay.classList.add('open');
      panel.classList.add('open');
    });
    panel.setAttribute('aria-hidden', 'false');
  }

  function closeDetail() {
    overlay.classList.remove('open');
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    activePaper = null;
    setTimeout(() => {
      overlay.hidden = true;
    }, 250);
  }

  async function showInsight(type) {
    if (!activePaper) return;

    const slot = document.getElementById('insight-slot');
    slot.innerHTML = UI.insightLoading(type);

    try {
      const result = await API.requestInsight(type, activePaper);
      slot.innerHTML = UI.insightResult(result);
    } catch (error) {
      slot.innerHTML = UI.insightError(error.message);
    }
  }

  results.addEventListener('click', (event) => {
    const openTarget = event.target.closest('[data-open]');
    if (openTarget) {
      openDetail(papers[Number(openTarget.dataset.open)]);
      return;
    }

    const insightBtn = event.target.closest('[data-insight]');
    if (insightBtn) {
      openDetail(papers[Number(insightBtn.dataset.index)]);
      showInsight(insightBtn.dataset.insight);
    }
  });

  detailBody.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-detail-insight]');
    if (btn) showInsight(btn.dataset.detailInsight);
  });

  document.getElementById('close-detail').addEventListener('click', closeDetail);
  overlay.addEventListener('click', closeDetail);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel.classList.contains('open')) closeDetail();
  });

  /** ------------------------------------------------- initial page state */
  const initialQuery = new URLSearchParams(window.location.search).get('q');
  if (initialQuery) {
    input.value = initialQuery;
    runSearch(initialQuery);
  } else {
    input.focus();
    UI.renderState(results, {
      title: 'Start with a research topic.',
      message: 'For example: "knowledge graphs for research" or "AI in healthcare".'
    });
  }
}
