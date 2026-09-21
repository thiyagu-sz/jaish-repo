/**
 * Researcher search screen.
 *
 * Handles one job: take a name, show matching researchers, and link each one to
 * its profile. The heavier work happens on the profile page.
 */
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('researcher-search-form');
  if (!form) return;

  const input = document.getElementById('researcher-query');
  const results = document.getElementById('researcher-results');
  const noticeSlot = document.getElementById('notice-slot');
  const resultsHead = document.getElementById('results-head');
  const resultsTitle = document.getElementById('results-title');
  const resultsCount = document.getElementById('results-count');
  const sourcePill = document.getElementById('source-pill');
  const intentHint = document.getElementById('intent-hint');

  async function runSearch(rawQuery) {
    const query = rawQuery.trim();
    if (!query) {
      input.focus();
      return;
    }

    resultsHead.hidden = false;
    resultsTitle.textContent = query;
    resultsCount.textContent = '';
    sourcePill.hidden = true;
    intentHint.hidden = true;
    ResearchUI.renderNotice(noticeSlot, '');
    ResearchUI.renderStages(results, ['Searching researchers...'], 0);

    window.history.replaceState({}, '', `researchers.html?q=${encodeURIComponent(query)}`);

    try {
      const data = await ResearchAPI.searchResearchers(query, { limit: 10 });

      // The query understanding agent runs before the provider call, so it can
      // warn when a topic was typed into a person search.
      if (data.query_understanding.intent === 'topic_search') {
        intentHint.hidden = false;
        intentHint.innerHTML =
          `That looks like a topic rather than a person (${ResearchUI.escapeHtml(
            data.query_understanding.reason
          )}). ` + 'Author results are shown below; to search papers by topic use the ' +
          '<a href="research.html">Papers</a> page.';
      }

      if (data.provider_notes && data.provider_notes.length) {
        ResearchUI.renderNotice(noticeSlot, data.provider_notes.join('. '), 'warn');
      }

      sourcePill.hidden = false;
      sourcePill.textContent = `via ${ResearchUI.sourceLabel(data.source)}`;

      if (!data.researchers.length) {
        resultsCount.textContent = '';
        ResearchUI.renderState(results, {
          title: 'No researcher matched that name.',
          message: 'Check the spelling, or try the full published name rather than initials.'
        });
        return;
      }

      const shown = data.researchers.length;
      const total = data.total != null ? ` of ${ResearchUI.number(data.total)}` : '';
      resultsCount.textContent = `Showing ${shown}${total} matching author records`;

      ResearchUI.renderResearchers(results, data.researchers);
    } catch (error) {
      resultsCount.textContent = '';
      ResearchUI.renderError(results, error, { retryLabel: 'Try again' });
      results.querySelector('[data-retry]')?.addEventListener('click', () => runSearch(query));
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    runSearch(input.value);
  });

  const initialQuery = new URLSearchParams(window.location.search).get('q');
  if (initialQuery) {
    input.value = initialQuery;
    runSearch(initialQuery);
  } else {
    input.focus();
    ResearchUI.renderState(results, {
      title: 'Search for a researcher to begin.',
      message: 'Enter a published author name, for example "Yoshua Bengio".'
    });
  }
});
