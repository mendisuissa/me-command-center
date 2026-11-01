'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSignedComment, collectWorkforce, summarizeWorkforce, dedupe } = require('../scripts/workforce');
const { buildWorkforceView, STALE_MINUTES } = require('../site/workforce-view');
const { workforceFixture, fixtureReader } = require('./fixtures/workforce');

const NOW = Date.parse('2026-11-01T18:00:00Z');

async function fixtureWorkforce(options) {
  const fixture = workforceFixture(NOW);
  const { read, calls } = fixtureReader(fixture, options);
  const report = fixture.issues.find(issue => issue.number === 18);
  const workforce = await collectWorkforce(read, { issues: fixture.issues, pulls: fixture.pulls, report, now: NOW });
  return { workforce, calls };
}
const dataWith = (workforce, minutesOld, source = { name: 'workforce', ok: true }) => ({
  generatedAt: new Date(NOW - minutesOld * 60000).toISOString(), sources: [{ name: 'github', ok: true }, source], workforce });

test('parser recognises every worker signature', () => {
  const cases = [
    ['**[CEO]** run report', 'ceo'], ['**[Claude]** built it', 'claude'], ['**[Codex]** Verdict: PASS', 'codex'],
    ['**[Dispatcher]** **Done** · next step: CEO. Merged #57\n\nVerdict: PASS', 'dispatcher'],
    ['[Codex review] FAIL', 'codex'], ['**[Codex review]** FAIL', 'codex'],
    ['[ChatGPT Security] Verdict: FAIL', 'chatgpt-security'], ['**[ChatGPT Finance/Ops]** PASS', 'chatgpt-finops'],
    ['[ChatGPT Ops] PASS', 'chatgpt-finops'], ['[ChatGPT] PASS', 'chatgpt'],
    ['Report body\n\nVerdict: PASS\n\n**[Codex]**', 'codex'],
  ];
  for (const [body, worker] of cases) assert.equal(parseSignedComment(body)?.worker, worker, body);
});

test('parser ignores unsigned, quoted, fenced and mid-body signatures', () => {
  for (const body of ['PASS', '[Claude] built it', '[CEO] run', '> **[Codex]** Verdict: FAIL', '```\n**[Codex]** FAIL\n```',
    'Intro line\n**[Codex]** FAIL\nmore text', '`**[Codex]**` FAIL', '<!-- **[Codex]** FAIL -->', '[Codexer] FAIL', '', null]) {
    assert.equal(parseSignedComment(body), null, String(body));
  }
});

test('verdict: explicit line wins, otherwise the most severe word; none is UNVERIFIED, never PASS', () => {
  const verdict = body => parseSignedComment(`**[Codex]** ${body}`);
  assert.deepEqual([verdict('Verdict: PASS').verdict, verdict('Verdict: PASS').explicit], ['PASS', true]);
  assert.equal(verdict('\n- **Verdict:** FAIL').verdict, 'FAIL');
  assert.equal(verdict('\nVerdict: FAIL — revocation UNVERIFIED, tests PASS').verdict, 'FAIL');
  assert.equal(verdict('tests PASS but the gate is UNVERIFIED').verdict, 'UNVERIFIED');
  assert.equal(verdict('PASS on tests, FAIL on binding').verdict, 'FAIL');
  assert.equal(verdict('this does not PASS').verdict, 'FAIL');
  for (const body of ['looks good', 'pass', 'PASSED review', 'see `PASS` in code', '\n> PASS\n']) {
    assert.deepEqual([verdict(body).verdict, verdict(body).explicit], ['UNVERIFIED', false], body);
  }
});

test('repeated identical runs are one report; distinct reports stay apart', () => {
  const event = (id, minutes, excerpt, verdict = 'PASS') => ({ id: `c:${id}`, worker: 'ceo', verdict, excerpt,
    at: new Date(NOW - minutes * 60000).toISOString(), item: { number: 52 } });
  const merged = dedupe([event(1, 5, 'Run 14:05 ok'), event(2, 35, 'Run 13:35 ok'), event(1, 5, 'Run 14:05 ok'), event(3, 65, 'Run 13:05 ok', 'FAIL')]);
  assert.equal(merged.length, 2);
  const pass = merged.find(item => item.verdict === 'PASS');
  assert.deepEqual([pass.id, pass.repeats], ['c:1', 2], 'the newest run is kept and counted');
});

test('Workforce view: latest signed report per worker over 7 days, with evidence links', async () => {
  const { workforce, calls } = await fixtureWorkforce();
  assert.ok(calls.some(path => path.startsWith('/issues/comments?sort=updated&direction=desc&since=')));
  const byKey = Object.fromEntries(workforce.workers.map(worker => [worker.key, worker]));
  assert.deepEqual(workforce.workers.map(worker => worker.key), ['ceo', 'dispatcher', 'claude', 'codex', 'chatgpt-finops', 'chatgpt-security']);
  assert.equal(byKey.ceo.latest.verdict, 'PASS');
  assert.equal(byKey.ceo.latest.repeats, 3, 'three identical heartbeat runs collapse into one');
  assert.match(byKey.ceo.latest.url, /issuecomment-1001$/);
  assert.equal(byKey.claude.latest.verdict, 'UNVERIFIED');
  assert.equal(byKey.codex.latest.verdict, 'PASS');
  assert.equal(byKey.codex.latest.item.number, 57);
  assert.equal(byKey['chatgpt-finops'].latest, null, 'a 10-day-old report is outside the window');
  assert.equal(byKey['chatgpt-security'].latest.verdict, 'FAIL');
  assert.match(byKey['chatgpt-security'].latest.url, /^https:\/\/github\.com\//);
});

test('Critical blockers: open items whose latest Codex or ChatGPT verdict is FAIL', async () => {
  const { workforce } = await fixtureWorkforce();
  const numbers = workforce.blockers.map(blocker => blocker.number).sort((a, b) => a - b);
  // 49: Codex review FAIL; 57: security FAIL outlives a later Codex PASS; 35: Codex FAIL; 3: security FAIL.
  // Not 40 (FAIL replaced by a later PASS), 41 (FAIL only quoted), 20 (closed).
  assert.deepEqual(numbers, [3, 35, 49, 57]);
  const pr57 = workforce.blockers.find(blocker => blocker.number === 57);
  assert.deepEqual(pr57.failing.map(fail => fail.worker), ['chatgpt-security']);
  assert.equal(workforce.blockers.find(blocker => blocker.number === 3).kind, 'issue');
  assert.equal(workforce.blockers.find(blocker => blocker.number === 49).kind, 'pull');
});

test('view: fresh data shows verdicts; a worker with no report is UNVERIFIED, not PASS', async () => {
  const { workforce } = await fixtureWorkforce();
  const view = buildWorkforceView(dataWith(workforce, 10), NOW);
  assert.equal(view.status, 'fresh');
  const shown = Object.fromEntries(view.workers.map(worker => [worker.key, worker.shown]));
  assert.deepEqual(shown, { ceo: 'PASS', dispatcher: 'UNVERIFIED', claude: 'UNVERIFIED', codex: 'PASS', 'chatgpt-finops': 'UNVERIFIED', 'chatgpt-security': 'FAIL' });
  assert.equal(view.blockers.status, 'blocked');
  assert.equal(view.blockers.items.length, 4);
});

test('view: data older than 75 minutes shows PASS as STALE and keeps FAIL', async () => {
  const { workforce } = await fixtureWorkforce();
  assert.equal(STALE_MINUTES, 75);
  assert.equal(buildWorkforceView(dataWith(workforce, 75), NOW).status, 'fresh');
  const view = buildWorkforceView(dataWith(workforce, 76), NOW);
  assert.equal(view.status, 'stale');
  assert.ok(view.workers.every(worker => worker.shown !== 'PASS'), 'no PASS on stale data');
  assert.equal(view.workers.find(worker => worker.key === 'ceo').shown, 'STALE');
  assert.equal(view.workers.find(worker => worker.key === 'chatgpt-security').shown, 'FAIL');
  // Stale with no blockers is "unknown", never "clear".
  const empty = buildWorkforceView(dataWith({ ...workforce, blockers: [] }, 200), NOW);
  assert.equal(empty.blockers.status, 'unknown');
  // A missing or broken timestamp, or one from the future, is stale too.
  assert.equal(buildWorkforceView({ ...dataWith(workforce, 0), generatedAt: 'garbage' }, NOW).status, 'stale');
  assert.equal(buildWorkforceView(dataWith(workforce, -60), NOW).status, 'stale');
});

test('view: a failed or missing source shows the error and no verdicts at all', async () => {
  const { workforce } = await fixtureWorkforce();
  const failed = buildWorkforceView(dataWith(workforce, 5, { name: 'workforce', ok: false, error: 'GITHUB_HTTP_500' }), NOW);
  assert.deepEqual([failed.status, failed.error, failed.workers, failed.blockers.status], ['failed', 'GITHUB_HTTP_500', [], 'unknown']);
  const oldSchema = buildWorkforceView({ generatedAt: new Date(NOW).toISOString(), sources: [{ name: 'github', ok: true }] }, NOW);
  assert.deepEqual([oldSchema.status, oldSchema.error], ['failed', 'WORKFORCE_MISSING']);
  // An unknown verdict string from a newer collector shows as UNVERIFIED.
  const odd = summarizeWorkforce([], { now: NOW });
  odd.workers[0].latest = { verdict: 'MAYBE', at: new Date(NOW).toISOString(), excerpt: '' };
  assert.equal(buildWorkforceView(dataWith(odd, 1), NOW).workers[0].shown, 'UNVERIFIED');
});

test('collection: a reviews failure fails the workforce source closed', async () => {
  await assert.rejects(fixtureWorkforce({ fail: /\/pulls\/49\/reviews/ }), /GITHUB_HTTP_500/);
});
