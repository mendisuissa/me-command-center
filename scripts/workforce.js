'use strict';

// Workforce reports: every worker signs its GitHub comments, and reviewers end with a verdict.
// This module turns those comments into the encrypted dashboard's "Workforce" view and its
// "Critical blockers" strip. It never defaults to PASS: a signed comment without a readable verdict
// is UNVERIFIED, and conflicting verdicts resolve to the most severe one.

const WORKFORCE_DAYS = 7;       // the Workforce view shows the last week
const BLOCKER_DAYS = 90;        // a reviewer FAIL keeps blocking until a later verdict replaces it
const MAX_COMMENT_PAGES = 10;
const MAX_PULLS_WITH_REVIEWS = 30;
const MAX_REVIEW_PAGES = 5;
const VERDICTS = ['FAIL', 'UNVERIFIED', 'PASS'];        // most severe first
const SEVERITY = Object.fromEntries(VERDICTS.map((verdict, index) => [verdict, index]));

// The five rows of the Workforce view, in display order. ChatGPT signatures with an unknown role are
// kept as "chatgpt" so a FAIL from them still blocks, but they get no row of their own.
const WORKERS = [
  { key: 'ceo', name: 'CEO' },
  { key: 'claude', name: 'Claude builders' },
  { key: 'codex', name: 'Codex' },
  { key: 'chatgpt-finops', name: 'ChatGPT Finance/Ops' },
  { key: 'chatgpt-security', name: 'ChatGPT Security' },
];
const REVIEWERS = new Set(['codex', 'chatgpt-finops', 'chatgpt-security', 'chatgpt']);

const safeUrl = value => (typeof value === 'string' && value.startsWith('https://github.com/') ? value : null);
const timeOf = value => { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : NaN; };

// Visible text only: no fenced or inline code, no quoted lines, no HTML comments. A worker quoting
// another worker's signature or verdict must not count as that worker's own report.
function visibleLines(body) {
  const lines = [];
  let fence = null;
  const text = String(body || '').slice(0, 20_000).replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  for (const raw of text.split(/\r?\n/)) {
    const marker = raw.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) { if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null; continue; }
    if (marker) { fence = marker[1]; continue; }
    if (/^ {0,3}>/.test(raw)) continue;
    const line = raw.replace(/`[^`\n]*`/g, ' ').trim();
    if (line) lines.push(line);
  }
  return lines;
}

// `**[CEO]**`, `**[Claude]**`, `**[Codex]**`, `[Codex …]`, `[ChatGPT …]` (bold optional for the last two).
function signatureOf(line) {
  let match = line.match(/^\*\*\[(CEO|Claude|Codex)\]\*\*/);
  if (match) return { key: match[1].toLowerCase(), signature: match[0] };
  match = line.match(/^(\*\*)?\[(Codex|ChatGPT)((?:[ :/–-][^\]\n]{0,60})?)\]\1/);
  if (!match) return null;
  if (match[2] === 'Codex') return { key: 'codex', signature: match[0] };
  const role = match[3];
  const key = /secur/i.test(role) ? 'chatgpt-security' : /financ|\bops\b|operat/i.test(role) ? 'chatgpt-finops' : 'chatgpt';
  return { key, signature: match[0] };
}

const mostSevere = verdicts => verdicts.reduce((worst, verdict) => (SEVERITY[verdict] < SEVERITY[worst] ? verdict : worst));

// An explicit "Verdict: X" line wins; otherwise any standalone verdict word counts, most severe first.
// "not PASS" is a failure. No verdict at all is UNVERIFIED, never PASS.
function verdictOf(lines) {
  const text = lines.join('\n');
  const explicit = [...text.matchAll(/^(?:[-*]\s+)?(?:\*\*)?(?:verdict|result|status|הכרעה|תוצאה)(?:\*\*)?\s*[:：–-]\s*(?:\*\*)?\s*(PASS|FAIL|UNVERIFIED)\b/gim)]
    .map(match => match[1].toUpperCase());
  if (explicit.length) return { verdict: mostSevere(explicit), explicit: true };
  const found = [...text.matchAll(/\b(PASS|FAIL|UNVERIFIED)\b/g)].map(match => match[1]);
  if (/\b(?:not|NOT|no|NO|לא)\s+(?:\*\*)?PASS\b/.test(text)) found.push('FAIL');
  return found.length ? { verdict: mostSevere(found), explicit: false } : { verdict: 'UNVERIFIED', explicit: false };
}

// Returns null for an unsigned comment. The signature may open or close the comment.
function parseSignedComment(body) {
  const lines = visibleLines(body);
  if (!lines.length) return null;
  let signed = signatureOf(lines[0]);
  let index = 0;
  if (!signed && lines.length > 1) { signed = signatureOf(lines[lines.length - 1]); index = lines.length - 1; }
  if (!signed) return null;
  const rest = [...lines];
  rest[index] = rest[index].slice(signed.signature.length).trim();
  const excerpt = rest.map(line => line.replace(/\*\*|__|^#+\s*|^[-*]\s+/g, '').trim()).find(Boolean) || '';
  return { worker: signed.key, ...verdictOf(rest.filter(Boolean)), excerpt: excerpt.slice(0, 160) };
}

const itemNumberOf = url => { const match = String(url || '').match(/\/(?:issues|pulls?)\/(\d+)(?:[/#?]|$)/); return match ? Number(match[1]) : null; };

// One event per signed comment, review or report body. `kind` comes from the open lists when known.
function toEvent(source, { id, body, at, url, issueUrl, author }, openItems) {
  const parsed = parseSignedComment(body);
  const time = timeOf(at);
  if (!parsed || !Number.isFinite(time)) return null;
  const number = itemNumberOf(issueUrl || url);
  const open = number != null ? openItems.get(number) : null;
  return { id: `${source}:${id}`, worker: parsed.worker, verdict: parsed.verdict, explicit: parsed.explicit,
    excerpt: parsed.excerpt, at: new Date(time).toISOString(), url: safeUrl(url), author: author ? String(author).slice(0, 60) : null,
    item: number == null ? null : { number, kind: open ? open.kind : /\/pull\//.test(String(url)) ? 'pull' : 'issue', open: Boolean(open) } };
}

// A heartbeat that re-posts the same report on every run is one report: same worker, same item,
// same verdict and the same text once digits (timestamps, run numbers) are ignored. Keep the latest.
function dedupe(events) {
  const byId = new Map();
  for (const event of events) if (event && !byId.has(event.id)) byId.set(event.id, event);
  const byRun = new Map();
  for (const event of [...byId.values()].sort((a, b) => timeOf(b.at) - timeOf(a.at))) {
    const fingerprint = [event.worker, event.item?.number ?? '-', event.verdict,
      event.excerpt.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ')].join('|');
    const kept = byRun.get(fingerprint);
    if (kept) kept.repeats += 1; else byRun.set(fingerprint, { ...event, repeats: 1 });
  }
  return [...byRun.values()];
}

// Pure: events → the published view. `now` makes the 7-day window testable.
function summarizeWorkforce(events, { now = Date.now(), openItems = new Map(), truncated = false } = {}) {
  const unique = dedupe(events).sort((a, b) => timeOf(b.at) - timeOf(a.at));
  const since = now - WORKFORCE_DAYS * 86_400_000;
  const recent = unique.filter(event => timeOf(event.at) >= since);
  const workers = WORKERS.map(({ key, name }) => {
    const mine = recent.filter(event => event.worker === key);
    const counts = Object.fromEntries(VERDICTS.map(verdict => [verdict, mine.filter(event => event.verdict === verdict).length]));
    return { key, name, latest: mine[0] || null, recent: mine.slice(0, 5), counts, reports: mine.length };
  });

  // Per open item and per reviewer, the latest verdict decides. Any reviewer's latest FAIL blocks:
  // a later PASS from a different reviewer does not clear it.
  const latestByItem = new Map();
  for (const event of unique) {
    if (!REVIEWERS.has(event.worker) || !event.item?.open) continue;
    const reviewers = latestByItem.get(event.item.number) || new Map();
    if (!reviewers.has(event.worker)) reviewers.set(event.worker, event);
    latestByItem.set(event.item.number, reviewers);
  }
  const blockers = [];
  for (const [number, reviewers] of latestByItem) {
    const failing = [...reviewers.values()].filter(event => event.verdict === 'FAIL');
    if (!failing.length) continue;
    const item = openItems.get(number);
    blockers.push({ number, kind: item.kind, title: item.title, url: item.url, priority: item.priority || null,
      failing: failing.map(event => ({ worker: event.worker, at: event.at, url: event.url, excerpt: event.excerpt })) });
  }
  blockers.sort((a, b) => Math.max(...b.failing.map(f => timeOf(f.at))) - Math.max(...a.failing.map(f => timeOf(f.at))));
  return { windowDays: WORKFORCE_DAYS, blockerWindowDays: BLOCKER_DAYS, truncated, workers, blockers };
}

// Repo-wide issue and PR conversation comments, newest first. Hitting the page cap is not an error:
// the newest comments are complete, and `truncated` tells the dashboard older blockers may be missing.
async function readRecentComments(read, sinceIso) {
  const comments = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const batch = await read(`/issues/comments?sort=updated&direction=desc&since=${encodeURIComponent(sinceIso)}&per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('GITHUB_RESPONSE_INVALID');
    for (const comment of batch) {
      if (typeof comment?.id !== 'number') throw new Error('GITHUB_RESPONSE_INVALID');
      if (!seen.has(comment.id)) { seen.add(comment.id); comments.push(comment); }
    }
    if (batch.length < 100) return { comments, truncated: false };
  }
  return { comments, truncated: true };
}

// Reviews are listed oldest first, so the newest verdicts are on the last page: read every page up to
// the cap, and report `truncated` (never a silently partial history) when the cap is reached.
async function readReviews(read, number) {
  const reviews = [];
  for (let page = 1; page <= MAX_REVIEW_PAGES; page += 1) {
    const batch = await read(`/pulls/${Number(number)}/reviews?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('GITHUB_RESPONSE_INVALID');
    reviews.push(...batch);
    if (batch.length < 100) return { reviews, truncated: false };
  }
  return { reviews, truncated: true };
}

// `issues` and `pulls` are the raw open lists the main collection already read; `report` is the CEO issue.
async function collectWorkforce(read, { issues, pulls, report, now = Date.now() }) {
  const labelsOf = item => (item.labels || []).map(label => String(label.name || ''));
  const openItems = new Map();
  for (const item of issues) if (!item.pull_request) openItems.set(item.number, { kind: 'issue', title: String(item.title || '').slice(0, 300),
    url: safeUrl(item.html_url), priority: labelsOf(item).find(name => /^P[0-3]$/i.test(name)) || null });
  for (const pull of pulls) openItems.set(pull.number, { kind: 'pull', title: String(pull.title || '').slice(0, 300),
    url: safeUrl(pull.html_url), priority: labelsOf(pull).find(name => /^P[0-3]$/i.test(name)) || null });

  const since = new Date(now - BLOCKER_DAYS * 86_400_000).toISOString();
  const pullsWithReviews = pulls.slice(0, MAX_PULLS_WITH_REVIEWS);
  const [{ comments, truncated }, reviews] = await Promise.all([
    readRecentComments(read, since),
    Promise.all(pullsWithReviews.map(pull => readReviews(read, pull.number))),
  ]);
  const events = comments.map(comment => toEvent('comment', { id: comment.id, body: comment.body,
    at: comment.updated_at || comment.created_at, url: comment.html_url, issueUrl: comment.issue_url, author: comment.user?.login }, openItems));
  reviews.forEach(({ reviews: list }, index) => {
    const pull = pullsWithReviews[index];
    for (const review of list) events.push(toEvent('review', { id: review.id, body: review.body, at: review.submitted_at,
      url: review.html_url, issueUrl: `/pulls/${pull.number}`, author: review.user?.login }, openItems));
  });
  if (report) events.push(toEvent('report', { id: report.number, body: report.body, at: report.updated_at,
    url: report.html_url, issueUrl: report.html_url, author: report.user?.login }, openItems));
  return summarizeWorkforce(events, { now, openItems, truncated: truncated || pulls.length > MAX_PULLS_WITH_REVIEWS || reviews.some(result => result.truncated) });
}

module.exports = { parseSignedComment, summarizeWorkforce, collectWorkforce, dedupe, toEvent,
  WORKERS, WORKFORCE_DAYS, BLOCKER_DAYS };
