/**
 * Thin wrapper around the backend API.
 * The browser only ever talks to our own server - never to a third-party API
 * directly - so no keys are exposed here.
 */
const API = (() => {
  async function searchPapers({ query, source = 'all', year = '', sort = 'relevance' }) {
    const params = new URLSearchParams({ q: query, source, sort });
    if (year) params.set('year', year);

    const response = await fetch(`/api/research?${params.toString()}`);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || 'Unable to retrieve papers.');
    }
    return data;
  }

  async function requestInsight(type, paper) {
    const response = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type,
        title: paper.title,
        abstract: paper.abstract,
        authors: paper.authors,
        year: paper.year
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'Unable to generate an AI response right now.');
    }
    return data;
  }

  return { searchPapers, requestInsight };
})();
