'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { probeFleet, parseFleet } = require('../scripts/fleet');
const { parseCeoReport } = require('../scripts/collect');

const FLEET = JSON.stringify([
  { name: 'Bot', url: 'https://bot.example.test/health' },
  { name: 'App', url: 'https://app.example.test/' },
  { name: 'Slow', url: 'https://slow.example.test/' },
]);

test('fleet probes report up, HTTP errors and timeouts without leaking URLs', async () => {
  const fetchImpl = async (url, init) => {
    if (url.includes('slow')) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' }))));
    return { status: url.includes('app.') ? 503 : 200, text: async () => 'ok' };
  };
  const result = await probeFleet(FLEET, { fetchImpl, timeoutMs: 50 });
  assert.deepEqual(result.systems.map(s => [s.name, s.ok, s.status, s.error || null]),
    [['Bot', true, 200, null], ['App', false, 503, null], ['Slow', false, null, 'TIMEOUT']]);
  assert.equal(JSON.stringify(result).includes('example.test'), false);
});

test('fleet list must be https and well formed; empty means no fleet', async () => {
  assert.equal(await probeFleet(''), null);
  assert.throws(() => parseFleet('not json'), /CC_FLEET_INVALID/);
  assert.throws(() => parseFleet(JSON.stringify([{ name: 'x', url: 'http://plain.test/' }])), /CC_FLEET_INVALID/);
  assert.throws(() => parseFleet(JSON.stringify([{ name: '', url: 'https://a.test/' }])), /CC_FLEET_INVALID/);
});

test('CEO report is reduced to its verdict and section bullets as plain text', () => {
  const body = [
    '# דוח CEO',
    '**ריצה אחרונה:** 30.10.2026 00:10 · ה-`Webapp` לא מגיב',
    '',
    '## מחכה להחלטה שלך',
    '- #20: שאלה',
    '',
    '## מה זז מאז הריצה הקודמת',
    '- **PR #15**: בדיקה עצמאית PASS',
    '- נפתח #20',
    '',
    '## תקוע, ומה הדרך לעקוף',
    '- אין',
    '',
    '<!-- ceo-state: {"lastRun":"x","notes":["- hidden bullet"]} -->',
  ].join('\n');
  assert.deepEqual(parseCeoReport(body), {
    verdict: '30.10.2026 00:10 · ה-Webapp לא מגיב',
    sections: [
      { title: 'מה זז מאז הריצה הקודמת', items: ['PR #15: בדיקה עצמאית PASS', 'נפתח #20'] },
      { title: 'תקוע, ומה הדרך לעקוף', items: ['אין'] },
    ],
  });
  assert.deepEqual(parseCeoReport(''), { verdict: null, sections: [] });
});
