'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decisionLink } = require('../site/decision');

test('approve and reject open a prefilled decision issue in the source repository', () => {
  const yes = new URL(decisionLink('owner/private-repo', 108, true));
  assert.equal(yes.origin + yes.pathname, 'https://github.com/owner/private-repo/issues/new');
  assert.equal(yes.searchParams.get('title'), 'החלטה על #108: כן');
  assert.equal(yes.searchParams.get('body').split('\n')[0], 'החלטה: כן');
  const no = new URL(decisionLink('owner/private-repo', 103, false));
  assert.equal(no.searchParams.get('title'), 'החלטה על #103: לא');
  assert.equal(no.searchParams.get('body').split('\n')[0], 'החלטה: לא');
  assert.match(no.searchParams.get('body'), /סיבה/);
});

test('no link for a malformed repo or item number', () => {
  for (const repo of [null, '', 'owner', 'owner/repo/x', '../x/y', 'a/..', 'evil.com/x y', 'javascript:alert(1)/x']) {
    assert.equal(decisionLink(repo, 1, true), null, String(repo));
  }
  for (const n of [0, -1, 1.5, '7', NaN, null]) assert.equal(decisionLink('owner/repo', n, true), null, String(n));
});

test('spaces are encoded as %20, never as +', () => {
  const link = decisionLink('owner/repo', 5, true);
  assert.ok(!link.includes('+'));
  assert.match(link, /title=%D7%94/);
});

test('the decision quotes the question it answers, on one line and bounded', () => {
  const q = 'מנחם: למזג?\nהמלצה: כן ' + 'x'.repeat(1000);
  const body = new URL(decisionLink('owner/repo', 108, true, q)).searchParams.get('body');
  const quote = body.split('\n').find(line => line.startsWith('> '));
  assert.ok(quote.startsWith('> מנחם: למזג? המלצה: כן'));
  assert.ok(quote.length <= 402);
  assert.equal(body.split('\n')[0], 'החלטה: כן');
});
