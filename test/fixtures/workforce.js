'use strict';

// Synthetic GitHub data for the Workforce tests and the PR screenshots. Everything here is made up:
// no titles, comments or logins from the private source repository. Item numbers mirror the shapes
// the dashboard must catch (a PR failed by Codex, a PR whose security FAIL outlives a later Codex PASS,
// an issue with an unverified-and-failed security check), not their content.
const REPO = 'owner/private-repo';
const base = `https://github.com/${REPO}`;
const api = `https://api.github.com/repos/${REPO}`;

function workforceFixture(now) {
  const at = minutes => new Date(now - minutes * 60000).toISOString();
  const comment = (id, number, kind, minutes, body, login) => ({ id, body, updated_at: at(minutes), created_at: at(minutes),
    html_url: `${base}/${kind === 'pull' ? 'pull' : 'issues'}/${number}#issuecomment-${id}`,
    issue_url: `${api}/issues/${number}`, user: { login } });

  const issues = [
    { id: 103, number: 3, title: 'Fixture issue: credential revocation check', html_url: `${base}/issues/3`, labels: [{ name: 'P0' }] },
    { id: 118, number: 18, title: 'Fixture CEO report', html_url: `${base}/issues/18`, labels: [{ name: 'ceo' }],
      updated_at: at(30), user: { login: 'ceo-bot' }, body: '**[CEO]** Run 41 of the day\n\nVerdict: PASS\n\n## Progress\n- fixture' },
    { id: 141, number: 41, title: 'Fixture issue: quoted verdict only', html_url: `${base}/issues/41`, labels: [] },
    { id: 152, number: 52, title: 'Fixture issue: workforce panel', html_url: `${base}/issues/52`, labels: [{ name: 'P1' }] },
  ];
  const pulls = [
    { id: 235, number: 35, title: 'Fixture PR: reviewer signature independence', html_url: `${base}/pull/35`, labels: [], head: { sha: 'a35' } },
    { id: 240, number: 40, title: 'Fixture PR: failed then fixed', html_url: `${base}/pull/40`, labels: [], head: { sha: 'a40' } },
    { id: 249, number: 49, title: 'Fixture PR: artifact binding', html_url: `${base}/pull/49`, labels: [{ name: 'P0' }], head: { sha: 'a49' } },
    { id: 257, number: 57, title: 'Fixture PR: artifact binding follow-up', html_url: `${base}/pull/57`, labels: [{ name: 'P0' }], head: { sha: 'a57' } },
  ];
  const comments = [
    // The CEO heartbeat re-posts the same status on every run: one report, three runs.
    comment(1001, 52, 'issue', 25, '**[CEO]** Run 14:05 status\n\nVerdict: PASS. All lanes moving.', 'ceo-bot'),
    comment(1002, 52, 'issue', 55, '**[CEO]** Run 13:35 status\n\nVerdict: PASS. All lanes moving.', 'ceo-bot'),
    comment(1003, 52, 'issue', 85, '**[CEO]** Run 13:05 status\n\nVerdict: PASS. All lanes moving.', 'ceo-bot'),
    // A builder report without a verdict is UNVERIFIED, never PASS.
    comment(1010, 52, 'issue', 40, '**[Claude]** Opened the fixture PR for the workforce panel; waiting for review.', 'builder'),
    // Quoting a reviewer's FAIL is not a FAIL.
    comment(1011, 41, 'issue', 45, '**[Claude]** Summary of the thread:\n\n> **[Codex]** Verdict: FAIL\n\nNothing new from me.', 'builder'),
    comment(1020, 35, 'pull', 90, '**[Codex]** The second reviewer signature is produced by the same key.\n\nVerdict: FAIL', 'codex-bot'),
    comment(1021, 40, 'pull', 300, '[Codex review] Missing test for the empty case. FAIL', 'codex-bot'),
    comment(1022, 40, 'pull', 120, '[Codex review] Re-checked at the new head. Verdict: PASS', 'codex-bot'),
    comment(1030, 57, 'pull', 200, '[ChatGPT Security] The artifact digest is not bound to the reviewed SHA.\n\nVerdict: FAIL', 'gpt-sec'),
    comment(1031, 57, 'pull', 60, '**[Codex]** Style and tests look fine. Verdict: PASS', 'codex-bot'),
    comment(1040, 3, 'issue', 180, '[ChatGPT Security] Revocation of the old credential is UNVERIFIED: no sign-in log evidence.\n\nVerdict: FAIL', 'gpt-sec'),
    // Older than the 7-day window: counts for blockers history, not for the Workforce row.
    comment(1050, 52, 'issue', 10 * 24 * 60, '[ChatGPT Finance/Ops] Budget within limits. Verdict: PASS', 'gpt-ops'),
    // A FAIL on an item that is no longer open does not block.
    comment(1060, 20, 'pull', 400, '**[Codex]** Verdict: FAIL', 'codex-bot'),
    // Unsigned.
    { id: 1070, body: 'PASS from a human, unsigned', updated_at: at(10), html_url: `${base}/issues/52#issuecomment-1070`,
      issue_url: `${api}/issues/52`, user: { login: 'someone' } },
  ];
  const reviews = {
    49: [{ id: 5001, body: '[Codex review] The build output is not tied to the reviewed commit.\n\n**Verdict:** FAIL',
      submitted_at: at(70), html_url: `${base}/pull/49#pullrequestreview-5001`, user: { login: 'codex-bot' } }],
    35: [], 40: [], 57: [],
  };
  return { issues, pulls, comments, reviews };
}

// A `read(path)` like collect.js's, serving the fixture. `fail` makes a matching path throw.
function fixtureReader(fixture, { fail } = {}) {
  const calls = [];
  const read = async path => {
    calls.push(path);
    if (fail && fail.test(path)) throw new Error('GITHUB_HTTP_500');
    if (path.startsWith('/issues/comments')) {
      const page = Number(new URLSearchParams(path.split('?')[1]).get('page'));
      return page === 1 ? fixture.comments : [];
    }
    const review = path.match(/^\/pulls\/(\d+)\/reviews/);
    if (review) {
      const page = Number(new URLSearchParams(path.split('?')[1]).get('page')) || 1;
      return (fixture.reviews[review[1]] || []).slice((page - 1) * 100, page * 100);
    }
    throw new Error('GITHUB_HTTP_404');
  };
  return { read, calls };
}

module.exports = { workforceFixture, fixtureReader, REPO };
