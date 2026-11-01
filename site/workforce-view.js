'use strict';

// Turns the decrypted data into what the Workforce panel and the blocker strip show. Shared by the
// browser and the tests. Fail-visible rules:
// - a failed or missing workforce source shows an error and no verdicts at all;
// - data older than STALE_MINUTES shows every PASS as STALE (a FAIL stays FAIL);
// - a worker with no signed report in the window is UNVERIFIED; nothing is PASS by default.
(function (root) {
  const STALE_MINUTES = 75;
  const KNOWN = new Set(['PASS', 'FAIL', 'UNVERIFIED']);
  const TONE = { PASS: 'ok', FAIL: 'bad', UNVERIFIED: 'warn', STALE: 'warn' };
  const NAMES = { ceo: 'CEO', claude: 'Claude', codex: 'Codex', 'chatgpt-finops': 'ChatGPT Finance/Ops',
    'chatgpt-security': 'ChatGPT Security', chatgpt: 'ChatGPT' };
  const githubLink = value => (typeof value === 'string' && value.startsWith('https://github.com/') ? value : null);

  function freshness(data, now) {
    const source = (data?.sources || []).find(item => item.name === 'workforce');
    const ageMinutes = (now - Date.parse(data?.generatedAt)) / 60000;
    if (!source?.ok || !data?.workforce) {
      return { status: 'failed', error: source?.error || 'WORKFORCE_MISSING', ageMinutes };
    }
    // NaN (no or bad timestamp) counts as stale, as does a clock that says the data is from the future.
    if (!(ageMinutes <= STALE_MINUTES) || ageMinutes < -5) return { status: 'stale', error: null, ageMinutes };
    return { status: 'fresh', error: null, ageMinutes };
  }

  function display(verdict, stale) {
    const known = KNOWN.has(verdict) ? verdict : 'UNVERIFIED';
    const shown = stale && known === 'PASS' ? 'STALE' : known;
    return { verdict: known, shown, tone: TONE[shown] };
  }

  function buildWorkforceView(data, now = Date.now()) {
    const fresh = freshness(data, now);
    if (fresh.status === 'failed') {
      return { ...fresh, windowDays: 7, workers: [], blockers: { status: 'unknown', items: [] }, truncated: false };
    }
    const stale = fresh.status === 'stale';
    const workforce = data.workforce;
    const workers = (workforce.workers || []).map(worker => {
      const latest = worker.latest;
      const shownVerdict = display(latest ? latest.verdict : 'UNVERIFIED', stale);
      return {
        key: worker.key, name: String(worker.name || NAMES[worker.key] || worker.key),
        ...shownVerdict,
        at: latest?.at || null, url: githubLink(latest?.url), excerpt: latest?.excerpt || '',
        explicit: Boolean(latest?.explicit), repeats: latest?.repeats || 0,
        item: latest?.item || null, author: latest?.author || null, reports: worker.reports || 0,
        note: latest ? null : `no signed report in ${workforce.windowDays || 7} days`,
      };
    });
    const items = (workforce.blockers || []).map(blocker => ({
      number: blocker.number, kind: blocker.kind, title: String(blocker.title || ''), url: githubLink(blocker.url),
      priority: blocker.priority || null,
      failing: (blocker.failing || []).map(fail => ({ worker: NAMES[fail.worker] || fail.worker, at: fail.at,
        url: githubLink(fail.url), excerpt: fail.excerpt || '' })),
    }));
    return { ...fresh, windowDays: workforce.windowDays || 7, blockerWindowDays: workforce.blockerWindowDays || null,
      truncated: Boolean(workforce.truncated), workers,
      blockers: { status: items.length ? 'blocked' : stale ? 'unknown' : 'clear', items } };
  }

  const api = Object.freeze({ STALE_MINUTES, buildWorkforceView });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MeWorkforce = api;
})(globalThis);
