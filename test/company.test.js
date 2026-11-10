'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { collectCompany, parseMinutes, parseTaskLine, deadlineAt, signer } = require('../scripts/company');

const NOW = Date.parse('2026-11-10T14:00:00Z');
const mapLimit = async (items, _limit, fn) => Promise.all(items.map(fn));

const MINUTES = (id, title, tasks) => [
  `**[Claude]** **${title}**`, '', `<!-- boardroom-minutes:${id} -->`, '',
  '## מה הוחלט', '- אין.', '', '## משימות', ...tasks, '', '## מה עוצר', '- ממתין לתשובה ב-#3', '',
].join('\n');

test('a task line keeps owner, status and deadline, and links the items it names', () => {
  const task = parseTaskLine('- להשיב על #103 ולסגור את PR 85 · אחראי: מנחם · סטטוס: לא ידוע · דדליין: הוצע: 09.11 20:00');
  assert.equal(task.owner, 'מנחם');
  assert.equal(task.status, 'לא ידוע');
  assert.equal(task.deadline, 'הוצע: 09.11 20:00');
  assert.deepEqual(task.refs, [103, 85]);
  const bare = parseTaskLine('- משימה בלי שדות');
  assert.deepEqual([bare.owner, bare.deadline, bare.refs], ['לא נקבע', 'לא נקבע', []]);
});

test('deadlines are read in Israel time, in the meeting year, and impossible dates are refused', () => {
  assert.equal(deadlineAt('הוצע: 09.11 20:00', '2026-11-09T10:00:00Z'), '2026-11-09T18:00:00.000Z');
  assert.equal(deadlineAt('12.11', '2026-11-09T10:00:00Z'), '2026-11-12T21:59:00.000Z', 'a date alone is the end of that day');
  assert.equal(deadlineAt('הוצע: 2026-11-04 12:00', '2026-11-03T10:00:00Z'), '2026-11-04T10:00:00.000Z');
  assert.equal(deadlineAt('05.01', '2026-11-09T10:00:00Z'), '2027-01-05T21:59:00.000Z', 'January said in November is next year');
  assert.equal(deadlineAt('31.02', '2026-11-09T10:00:00Z'), null);
  assert.equal(deadlineAt('לא נקבע', '2026-11-09T10:00:00Z'), null);
});

test('only marked minutes parse; "אין." is not a decision', () => {
  assert.equal(parseMinutes('**[Claude]** ordinary comment', 'x'), null);
  const minutes = parseMinutes(MINUTES('aaaaaaaa-1', 'סיכום פגישה, 09.11.2026, 12:20–12:40', ['- א · אחראי: CEO']), '2026-11-09T11:00:00Z');
  assert.deepEqual(minutes.decisions, []);
  assert.equal(minutes.tasks.length, 1);
  assert.deepEqual(minutes.blockers, ['ממתין לתשובה ב-#3']);
});

test('signers: bold agent tags, ChatGPT\'s plain tag, the Codex bot, and the owner', () => {
  assert.equal(signer({ user: { login: 'mendisuissa', type: 'User' }, body: '**[Dispatcher]** picked up' }), 'Dispatcher');
  assert.equal(signer({ user: { login: 'mendisuissa', type: 'User' }, body: '[ChatGPT Finance] 2026-11-10 report' }), 'ChatGPT');
  assert.equal(signer({ user: { login: 'chatgpt-codex-connector[bot]', type: 'Bot' }, body: 'review' }), 'Codex');
  assert.equal(signer({ user: { login: 'mendisuissa', type: 'User' }, body: 'החלטה: כן' }), 'מנחם');
  assert.equal(signer({ user: { login: 'mendisuissa', type: 'User' }, body: '[Claude Code](https://claude.ai) footer' }), 'מנחם');
  assert.equal(signer({ user: { login: 'github-actions[bot]', type: 'Bot' }, body: 'deploy' }), null);
});

function reader(routes) {
  const calls = [];
  const read = async path => {
    calls.push(path);
    const key = Object.keys(routes).find(route => path.startsWith(route));
    if (!key) throw new Error('GITHUB_HTTP_404');
    if (routes[key] instanceof Error) throw routes[key];
    return routes[key];
  };
  return { read, calls };
}

const issues = [
  { number: 103, title: 'bootstrap', url: 'https://github.com/o/r/pull/103', updatedAt: '2026-11-10T13:00:00Z', comments: 3 },
  { number: 9, title: 'old article', url: 'https://github.com/o/r/issues/9', updatedAt: '2026-10-30T12:00:00Z', comments: 1 },
];

test('the newest meeting wins by meeting time, and task state comes from GitHub, not the minutes', async () => {
  const { read } = reader({
    '/issues/100/comments': [
      { body: MINUTES('bbbbbbbb-9', 'סיכום פגישה, 09.11.2026, 12:20–12:40', [
        '- להשיב על #103 · אחראי: מנחם · סטטוס: לא ידוע · דדליין: הוצע: 09.11 20:00',
        '- לסגור את #77 · אחראי: CEO · דדליין: 09.11',
        '- דשבורד · אחראי: CEO · דדליין: 11.11 18:00',
        '- סקירה · אחראי: Codex · דדליין: לא נקבע',
      ]), created_at: '2026-11-09T11:25:00Z', html_url: 'https://github.com/o/r/issues/100#c1' },
      // Posted later, but about an older meeting: must not replace the 09.11 minutes.
      { body: MINUTES('aaaaaaaa-3', 'סיכום פגישה, 03.11.2026, 16:39–17:08', ['- ישן · אחראי: CEO']),
        created_at: '2026-11-09T11:27:00Z', html_url: 'https://github.com/o/r/issues/100#c2' },
    ],
    '/issues/100': { comments: 2 },
    '/issues/103/comments': [
      { user: { login: 'mendisuissa', type: 'User' }, body: '**[Claude]** x', created_at: '2026-11-10T13:00:00Z' },
      { user: { login: 'chatgpt-codex-connector[bot]', type: 'Bot' }, body: 'ok', created_at: '2026-11-09T12:00:00Z' },
    ],
  });
  const company = await collectCompany({ read, issues, pulls: [], now: () => NOW, mapLimit });
  assert.deepEqual(company.errors, []);
  assert.match(company.minutes.title, /09\.11\.2026/);
  assert.equal(company.minutes.url, 'https://github.com/o/r/issues/100#c1');
  const [answer, closed, future, open] = company.minutes.tasks;
  assert.equal(answer.state, 'overdue', 'deadline passed and #103 is still open');
  assert.equal(closed.state, 'closed', '#77 is not open any more, so the task is not shown as late');
  assert.equal(future.state, 'untracked', 'no GitHub item named, deadline still ahead');
  assert.equal(open.state, 'untracked');
  const claude = company.activity.find(agent => agent.name === 'Claude');
  assert.deepEqual(claude.today.map(item => item.number), [103]);
  assert.equal(company.activity.find(agent => agent.name === 'Codex').items7d, 1);
  assert.equal(company.activity.find(agent => agent.name === 'ChatGPT').lastAt, null);
  assert.deepEqual(company.idle.map(item => item.number), [9], 'only items untouched for over 48 hours');
});

test('a failed minutes read is reported by itself and leaves activity intact', async () => {
  const { read } = reader({
    '/issues/100': new Error('GITHUB_HTTP_403'),
    '/issues/103/comments': [{ user: { login: 'mendisuissa', type: 'User' }, body: '**[CEO]** run', created_at: '2026-11-10T12:00:00Z' }],
  });
  const company = await collectCompany({ read, issues, pulls: [], now: () => NOW, mapLimit });
  assert.deepEqual(company.errors, ['minutes:GITHUB_HTTP_403']);
  assert.equal(company.minutes, null);
  assert.equal(company.activity.find(agent => agent.name === 'CEO').today.length, 1);
});

test('the comment read goes to the last page, where the newest comments are', async () => {
  const { read, calls } = reader({
    '/issues/100/comments': [], '/issues/100': { comments: 250 }, '/issues/103/comments': [],
  });
  await collectCompany({ read, issues: [{ ...issues[0], comments: 230 }], pulls: [], now: () => NOW, mapLimit });
  assert.ok(calls.includes('/issues/100/comments?per_page=100&page=3'));
  assert.ok(calls.includes('/issues/100/comments?per_page=100&page=2'), 'no minutes on the last page: one page back');
  assert.ok(calls.includes('/issues/103/comments?per_page=100&page=3'));
});
