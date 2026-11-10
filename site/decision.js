'use strict';
// Approve / reject links for an owner decision (AGENTS.md "Answering from the dashboard").
// GitHub cannot prefill a comment, so each button opens the source repository's new-issue page,
// prefilled with the title "החלטה על #<n>: כן|לא" and the decision as the first line. The owner
// taps Create; the Dispatcher and the CEO treat that issue as his answer to #<n>.
(function (root) {
  const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

  function decisionLink(repo, number, approve) {
    if (typeof repo !== 'string' || !REPO.test(repo) || repo.includes('..')) return null;
    if (!Number.isSafeInteger(number) || number < 1) return null;
    const verdict = approve ? 'כן' : 'לא';
    const body = approve
      ? `החלטה: כן\n\nתשובה לשאלה ב-#${number}.`
      : `החלטה: לא\n\nתשובה לשאלה ב-#${number}.\nסיבה (לא חובה): `;
    // %20, not "+": every client decodes it as a space.
    const title = encodeURIComponent(`החלטה על #${number}: ${verdict}`);
    return `https://github.com/${repo}/issues/new?title=${title}&body=${encodeURIComponent(body)}`;
  }

  const api = { decisionLink };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Decision = api;
})(typeof window === 'object' ? window : globalThis);
