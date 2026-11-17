'use strict';

// Publications per week (#160, item D): the number at the top of the board. The bot publishes counts at
// /api/publications on the same host as its /health check, so the address comes from the CC_FLEET secret and
// never appears in this public repository. Only numbers and dates are kept; the result is published encrypted.
const { parseFleet } = require('./fleet');

const KEYS = ['whatsNew', 'articles', 'linkedin'];
const count = value => (Number.isInteger(value) && value >= 0 && value < 1000 ? value : 0);
const isoOrNull = value => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);

function sanitize(body) {
  if (!body || body.ok !== true || !body.week || typeof body.week !== 'object') return null;
  const counts = source => Object.fromEntries(KEYS.map(key => [key, count(source?.[key])]));
  return {
    weekStart: isoOrNull(body.weekStart),
    week: counts(body.week),
    last7d: counts(body.last7d),
    target: { whatsNew: count(body.target?.whatsNew), articles: count(body.target?.articles) },
    onTrack: body.onTrack === true,
    lastPublished: Object.fromEntries(KEYS.map(key => [key, isoOrNull(body.lastPublished?.[key])])),
  };
}

async function fetchPublications(raw, { fetchImpl = globalThis.fetch, timeoutMs = 15_000, now = () => Date.now() } = {}) {
  const candidates = parseFleet(raw).map(system => new URL(system.url)).filter(url => url.pathname === '/health')
    .map(url => `${url.origin}/api/publications`);
  for (const url of candidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { method: 'GET', signal: controller.signal, headers: { 'user-agent': 'me-command-center-probe' } });
      if (!response.ok) continue;
      const clean = sanitize(await response.json());
      if (clean) return { checkedAt: new Date(now()).toISOString(), ...clean };
    } catch { /* try the next system */ } finally { clearTimeout(timeout); }
  }
  return { error: 'PUBLICATIONS_UNAVAILABLE' };
}

module.exports = { fetchPublications, sanitize };
