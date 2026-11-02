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
  assert.deepEqual(data.sources, [{ name: 'github', ok: true, fetchedAt: '2026-10-29T12:00:00.000Z' },
    { name: 'workforce', ok: true, fetchedAt: '2026-10-29T12:00:00.000Z' }]);
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

test('the CEO report issue becomes the CEO heartbeat, not a task; role labels are kept', async () => {
  const { fetchImpl } = fakeGitHub({ '/issues': [
    { id: 1, number: 11, title: 'Task', labels: [{ name: 'driver:claude' }, { name: 'needs-owner' }], body: '' },
    { id: 9, number: 18, title: 'דוח CEO', labels: [{ name: 'ceo' }], updated_at: '2026-10-29T22:00:00Z',
      html_url: 'https://github.com/owner/private-repo/issues/18', body: '## Next action\n- CEO: report' },
  ] });
  const data = await collect({ token: TOKEN, repo: REPO, fetchImpl });
  assert.deepEqual(data.issues.map(issue => issue.number), [11]);
  assert.deepEqual(data.issues[0].labels, ['driver:claude', 'needs-owner']);
  assert.deepEqual(data.manager, { number: 18, url: 'https://github.com/owner/private-repo/issues/18',
    updatedAt: '2026-10-29T22:00:00Z', verdict: null, sections: [] });
});

test('a GitHub failure is published as an error code with no stale task data', async () => {
  const { fetchImpl } = fakeGitHub({ '/issues': new Error('401') });
  const data = await collect({ token: TOKEN, repo: REPO, fetchImpl });
  assert.equal(data.sources[0].ok, false);
  assert.equal(data.sources[0].error, 'GITHUB_HTTP_401');
  assert.deepEqual([data.issues, data.pulls, data.mainBranch, data.workforce], [[], [], null, null]);
  assert.deepEqual(data.sources[1], { name: 'workforce', ok: false, fetchedAt: data.sources[0].fetchedAt, error: 'GITHUB_UNAVAILABLE' });
});

test('workforce reports are collected from signed comments and reviews; blockers name open items', async () => {
  const { fetchImpl, calls } = fakeGitHub({
    '/issues/comments': [{ id: 70, body: '**[Codex]** Verdict: FAIL', updated_at: '2026-10-29T11:30:00Z',
      html_url: 'https://github.com/owner/private-repo/pull/12#issuecomment-70', issue_url: 'https://api.github.com/repos/owner/private-repo/issues/12' }],
    '/pulls/12/reviews': [{ id: 80, body: '[ChatGPT Security] Verdict: PASS', submitted_at: '2026-10-29T11:40:00Z',
      html_url: 'https://github.com/owner/private-repo/pull/12#pullrequestreview-80' }],
  });
  const data = await collect({ token: TOKEN, repo: REPO, fetchImpl, now: () => Date.parse('2026-10-29T12:00:00Z') });
  assert.ok(calls.some(call => call.url.includes('/issues/comments?sort=updated&direction=desc&since=2026-07-31')));
  assert.equal(data.workforce.workers.find(worker => worker.key === 'codex').latest.verdict, 'FAIL');
  assert.equal(data.workforce.workers.find(worker => worker.key === 'chatgpt-security').latest.verdict, 'PASS');
  assert.deepEqual(data.workforce.blockers.map(blocker => [blocker.number, blocker.kind, blocker.title]), [[12, 'pull', 'Auth boundary']]);
  for (const call of calls) assert.equal(call.init.method, 'GET');
});

test('a workforce read failure is its own failed source and leaves the tasks intact', async () => {
  const { fetchImpl } = fakeGitHub({ '/issues/comments': new Error('502') });
  const data = await collect({ token: TOKEN, repo: REPO, fetchImpl });
  assert.equal(data.sources.find(source => source.name === 'github').ok, true);
  assert.deepEqual(data.sources.find(source => source.name === 'workforce'),
    { name: 'workforce', ok: false, fetchedAt: data.generatedAt, error: 'GITHUB_HTTP_502' });
  assert.equal(data.workforce, null);
  assert.equal(data.issues.length, 1);
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

test('a thematic break ends the next-action section, so a "Generated by" footer does not hide the action', () => {
  const footer = '\n\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_';
  assert.equal(nextActionFromBody(`## Next action\n- CEO: build the post bank${footer}`), 'CEO: build the post bank');
  assert.equal(nextActionFromBody(`## Next action\n- Owner: answer #23\n- Claude: verify${footer}`), 'Owner: answer #23');
  for (const rule of ['***', '___', '- - -', '-----', '* * *']) {
    assert.equal(nextActionFromBody(`## Next action\n- Do it\n\n${rule}\ntrailer`), 'Do it', rule);
  }
  // A rule indented into the item belongs to the item (setext underline or in-item rule): fail closed.
  for (const rule of ['  ---', '  ***', ' ---', '   ___']) {
    assert.equal(nextActionFromBody(`## Next action\n- Deploy production\n${rule}\n  ONLY after owner approval.`), null, rule);
    assert.equal(nextActionFromBody(`## Next action\n- Deploy production\n\n${rule}\n\n  ONLY after owner approval.`), null, rule);
  }
  // A nested item's rule at the parent's indentation still ends the section.
  assert.equal(nextActionFromBody(`## Next action\n  - Nested action\n  ---\ntrailer`), 'Nested action');
  // Still not a break: too few markers, mixed markers, or other text on the line.
  assert.equal(nextActionFromBody('## Next action\n- Deploy\n--\nONLY after approval'), null);
  assert.equal(nextActionFromBody('## Next action\n- Deploy\n-*-\nONLY after approval'), null);
  assert.equal(nextActionFromBody('## Next action\n- Deploy\n--- if approved'), null);
  // An empty section followed by a footer has no action.
  assert.equal(nextActionFromBody(`## Next action${footer}`), null);
  const started = process.hrtime.bigint();
  assert.equal(nextActionFromBody(`## Next action\n- A\n_${' \t_'.repeat(32_500)}x`), null);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 250);
});
