'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { collect, summarizeRuns } = require('../scripts/collect');
const { nextActionFromBody } = require('../scripts/next-action');

const REPO = 'owner/private-repo';
const TOKEN = 'ghp_TEST_TOKEN_DO_NOT_LEAK';

function fakeGitHub(overrides = {}) {
  const calls = [];
  const routes = {
    '': { default_branch: 'master' },
    '/issues': [
      { id: 1, number: 11, title: 'Command Center', html_url: 'https://github.com/owner/private-repo/issues/11',
        labels: [{ name: 'P1' }], assignee: { login: 'menahem' }, updated_at: '2026-10-29T10:00:00Z',
        body: '## Next action\n- Approve the staging budget' },
      { id: 2, number: 12, title: 'PR shown in issues', pull_request: {}, labels: [] },
    ],
    '/pulls': [{ id: 3, number: 12, title: 'Auth boundary', html_url: 'https://github.com/owner/private-repo/pull/12',
      draft: true, head: { sha: 'abc123' }, user: { login: 'codex' }, updated_at: '2026-10-29T11:00:00Z' }],
    'head_sha=abc123': { workflow_runs: [
      { name: 'Security', status: 'completed', conclusion: 'failure', created_at: '2026-10-29T09:00:00Z', html_url: 'https://github.com/x/1' },
      { name: 'Security', status: 'completed', conclusion: 'success', created_at: '2026-10-29T10:00:00Z', html_url: 'https://github.com/x/2' },
    ] },
    'branch=master': { workflow_runs: [
      { name: 'Deploy', status: 'completed', conclusion: 'failure', created_at: '2026-10-29T08:00:00Z', html_url: 'javascript:alert(1)' },
    ] },
    ...overrides,
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const path = url.replace(`https://api.github.com/repos/${REPO}`, '');
    const key = Object.keys(routes).sort((a, b) => b.length - a.length)
      .find(route => (route === '' ? path === '' : path.includes(route)));
    const body = routes[key];
    if (body instanceof Error) return { ok: false, status: Number(body.message), json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls };
}

test('collects issues, PR CI and main-branch CI with read-only authenticated GETs', async () => {
  const { fetchImpl, calls } = fakeGitHub();
  const data = await collect({ token: TOKEN, repo: REPO, fetchImpl, now: () => Date.parse('2026-10-29T12:00:00Z') });
  assert.deepEqual(data.sources, [{ name: 'github', ok: true, fetchedAt: '2026-10-29T12:00:00.000Z' }]);
  assert.equal(data.issues.length, 1);
  assert.equal(data.issues[0].priority, 'P1');
  assert.equal(data.issues[0].nextAction, 'Approve the staging budget');
  assert.equal(data.pulls[0].ci.state, 'success', 'a re-run that passed supersedes the older failure');
  assert.equal(data.mainBranch.state, 'failure');
  assert.equal(data.mainBranch.workflows[0].url, null, 'non-GitHub links are dropped');
  for (const call of calls) {
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.headers.authorization, `Bearer ${TOKEN}`);
    assert.ok(call.url.startsWith(`https://api.github.com/repos/${REPO}`));
  }
  assert.equal(JSON.stringify(data).includes(TOKEN), false);
});

test('a GitHub failure is published as an error code with no stale task data', async () => {
  const { fetchImpl } = fakeGitHub({ '/issues': new Error('401') });
  const data = await collect({ token: TOKEN, repo: REPO, fetchImpl });
  assert.equal(data.sources[0].ok, false);
  assert.equal(data.sources[0].error, 'GITHUB_HTTP_401');
  assert.deepEqual([data.issues, data.pulls, data.mainBranch], [[], [], null]);
});

test('pagination fails closed instead of presenting a truncated or duplicated queue', async () => {
  const issuesPage = (url, idFor) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return { ok: true, status: 200, json: async () => Array.from({ length: 100 },
      (_, index) => ({ id: idFor(page, index), number: index + 1, title: 't', labels: [] })) };
  };
  const { fetchImpl } = fakeGitHub();
  const run = idFor => collect({ token: TOKEN, repo: REPO,
    fetchImpl: async (url, init) => (url.includes('/issues?') ? issuesPage(url, idFor) : fetchImpl(url, init)) });

  const tooMany = await run((page, index) => (page * 1000) + index);
  assert.equal(tooMany.sources[0].error, 'GITHUB_PAGINATION_LIMIT');
  const repeated = await run((page, index) => index);
  assert.equal(repeated.sources[0].error, 'GITHUB_PAGINATION_INCONSISTENT');
  assert.deepEqual(repeated.issues, []);
});

test('invalid configuration is rejected before any request', async () => {
  await assert.rejects(collect({ token: '', repo: REPO, fetchImpl: async () => assert.fail('no request') }));
  await assert.rejects(collect({ token: TOKEN, repo: 'bad repo', fetchImpl: async () => assert.fail('no request') }));
});

test('run summary prefers failure, then pending', () => {
  assert.equal(summarizeRuns([]).state, 'none');
  assert.equal(summarizeRuns([{ name: 'a', status: 'in_progress', created_at: '2026-01-01' },
    { name: 'b', status: 'completed', conclusion: 'success', created_at: '2026-01-01' }]).state, 'pending');
  assert.equal(summarizeRuns([{ name: 'a', status: 'in_progress', created_at: '2026-01-01' },
    { name: 'b', status: 'completed', conclusion: 'timed_out', created_at: '2026-01-01' }]).state, 'failure');
});

test('next-action parser copy keeps the PR #12 behaviour, including the linear-time fix', () => {
  assert.equal(nextActionFromBody('## Immediate next action\n- Validate owner SSO in staging\n'), 'Validate owner SSO in staging');
  assert.equal(nextActionFromBody('## Next action\n- Deploy staging\n  ONLY after owner approval.'), null);
  const started = process.hrtime.bigint();
  assert.equal(nextActionFromBody(`## Next action${' \t'.repeat(32_500)}x`), null);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 250);
});
