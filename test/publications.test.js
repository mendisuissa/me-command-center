'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchPublications, sanitize } = require('../scripts/publications');

const FLEET = JSON.stringify([
  { name: 'Site', url: 'https://site.example/' },
  { name: 'Bot', url: 'https://bot.example/health' },
]);
const BODY = {
  ok: true, weekStart: '2026-11-14T22:00:00.000Z',
  week: { whatsNew: 2, articles: 0, linkedin: 1 }, last7d: { whatsNew: 3, articles: 0, linkedin: 1 },
  target: { whatsNew: 3, articles: 1 }, onTrack: false,
  lastPublished: { whatsNew: '2026-11-17T06:00:00.000Z', articles: null, linkedin: '2026-11-17T05:00:00.000Z' },
};

test('reads /api/publications from the host of the /health system only', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => BODY }; };
  const out = await fetchPublications(FLEET, { fetchImpl, now: () => Date.parse('2026-11-17T12:00:00Z') });
  assert.deepEqual(calls, ['https://bot.example/api/publications']);
  assert.equal(out.checkedAt, '2026-11-17T12:00:00.000Z');
  assert.deepEqual(out.week, { whatsNew: 2, articles: 0, linkedin: 1 });
  assert.equal(out.onTrack, false);
});

test('keeps only numbers and dates; anything else from the endpoint is dropped', () => {
  const out = sanitize({ ...BODY, week: { whatsNew: '7', articles: -1, linkedin: 2, extra: 'x' }, secret: 'nope', lastPublished: { whatsNew: '<script>' } });
  assert.deepEqual(out.week, { whatsNew: 0, articles: 0, linkedin: 2 });
  assert.equal(out.lastPublished.whatsNew, null);
  assert.equal(JSON.stringify(out).includes('nope'), false);
  assert.equal(sanitize({ ok: false }), null);
});

test('an unreachable or malformed endpoint is reported, not thrown', async () => {
  assert.deepEqual(await fetchPublications(FLEET, { fetchImpl: async () => { throw new Error('down'); } }), { error: 'PUBLICATIONS_UNAVAILABLE' });
  assert.deepEqual(await fetchPublications(FLEET, { fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }) }), { error: 'PUBLICATIONS_UNAVAILABLE' });
  assert.deepEqual(await fetchPublications('[]'), { error: 'PUBLICATIONS_UNAVAILABLE' });
});
