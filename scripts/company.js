'use strict';

// The "Company" view: what the last Board Room meeting assigned, where each task stands now,
// and which agent is actually working. Everything comes from read-only GitHub issue reads
// (the same Issues permission the dashboard already has). Nothing here is written anywhere.

const MINUTES_ISSUE = 100;
const MINUTES_MARKER = /<!--\s*boardroom-minutes:([0-9a-f-]{8,64})\s*-->/;
const ACTIVITY_DAYS = 7;
const MAX_ACTIVITY_ITEMS = 40;
const MAX_COMMENT_PAGES = 5; // 500 comments back per item; beyond that the read fails rather than guess
const IDLE_HOURS = 48;
const AGENTS = ['CEO', 'Claude', 'Dispatcher', 'Codex', 'ChatGPT', 'מנחם'];
const NOT_SET = 'לא נקבע';

const plain = (value, max = 300) => String(value || '').replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

// "## משימות" bullets are "<task> · אחראי: X · סטטוס: Y · דדליין: Z" (boardroom-web minutesMarkdown).
function parseTaskLine(line) {
  const parts = plain(line.replace(/^\s*-\s+/, ''), 600).split(' · ');
  const task = { text: parts[0].slice(0, 300), owner: NOT_SET, status: NOT_SET, deadline: NOT_SET };
  for (const part of parts.slice(1)) {
    const m = part.match(/^(אחראי|סטטוס|דדליין):\s*(.+)$/);
    if (!m) continue;
    const value = m[2].trim().slice(0, 120);
    if (m[1] === 'אחראי') task.owner = value;
    else if (m[1] === 'סטטוס') task.status = value;
    else task.deadline = value;
  }
  // Minutes name items as "#105" or "PR 85"; both link the task to a live GitHub item.
  task.refs = [...new Set([...task.text.matchAll(/(?:#|\bPR\s?)(\d{1,6})\b/g)].map(m => Number(m[1])))].slice(0, 4);
  return task;
}

// The deadline text is free ("הוצע: 09.11 20:00", "11.11", "10.11 (12:00, 20:00)"). The first
// dd.mm[ hh:mm] is taken, in the meeting's year, as Asia/Jerusalem wall-clock time. The offset is
// the zone's real one for that moment, so dates next to a daylight-saving change are not an hour off.
const JERUSALEM = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
function jerusalemWallClock(utcMs) {
  const p = Object.fromEntries(JERUSALEM.formatToParts(new Date(utcMs)).map(part => [part.type, Number(part.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
}
function fromJerusalem(year, month, day, hour, minute) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let at = wall - 2 * 3600000;
  for (let i = 0; i < 2; i += 1) at = wall - (jerusalemWallClock(at) - at); // converges in two steps
  return jerusalemWallClock(at) === wall ? at : null; // null: a wall time that does not exist (spring gap)
}
function deadlineAt(text, meetingIso) {
  const iso = String(text || '').match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  const m = iso ? [iso[0], iso[3], iso[2], iso[1], iso[4], iso[5]]
    : String(text || '').match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?:,?\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const meeting = new Date(meetingIso);
  let year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : meeting.getUTCFullYear();
  const [day, month] = [Number(m[1]), Number(m[2])];
  if (!(day >= 1 && day <= 31 && month >= 1 && month <= 12)) return null;
  if (!m[3] && month < meeting.getUTCMonth() + 1 - 6) year += 1; // "05.01" said in November is next year
  const [hour, minute] = m[4] ? [Number(m[4]), Number(m[5])] : [23, 59];
  if (hour > 23 || minute > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCDate() !== day || check.getUTCMonth() !== month - 1) return null; // e.g. 31.02
  const at = fromJerusalem(year, month, day, hour, minute);
  return at == null ? null : new Date(at).toISOString();
}

function parseMinutes(body, createdAt) {
  const text = String(body || '').slice(0, 60_000);
  const id = text.match(MINUTES_MARKER)?.[1];
  if (!id) return null;
  const titleLine = text.split('\n').find(line => line.includes('סיכום פגישה'));
  const sections = {};
  for (const chunk of text.replace(/<!--[\s\S]*?-->/g, '').split(/\n(?=## )/).slice(1)) {
    const [heading, ...lines] = chunk.split('\n');
    sections[plain(heading.replace(/^##\s*/, ''), 80)] = lines.filter(line => /^\s*-\s+\S/.test(line));
  }
  const list = name => (sections[name] || []).map(line => plain(line.replace(/^\s*-\s+/, ''))).filter(item => item && item !== 'אין.');
  return {
    id, createdAt,
    title: plain((titleLine || '').replace(/^\*\*\[Claude\]\*\*\s*/, ''), 120) || 'סיכום פגישה',
    decisions: list('מה הוחלט').slice(0, 12),
    tasks: (sections['משימות'] || []).map(parseTaskLine).slice(0, 30),
    blockers: list('מה עוצר').slice(0, 12),
  };
}

// The task's live state comes from the GitHub items it names, never from the meeting text.
function taskState(task, minutes, openByNumber, nowMs) {
  const linked = task.refs.map(number => {
    const item = openByNumber.get(number);
    return { number, open: Boolean(item), url: item?.url || null, updatedAt: item?.updatedAt || null };
  });
  const due = deadlineAt(task.deadline, minutes.createdAt);
  const anyOpen = linked.some(item => item.open);
  const allClosed = linked.length > 0 && !anyOpen;
  const overdue = Boolean(due) && Date.parse(due) < nowMs && !allClosed;
  return { ...task, linked, due, state: allClosed ? 'closed' : overdue ? 'overdue' : linked.length ? 'open' : 'untracked' };
}

// Who signed a comment: agents sign "**[Name]**" at the start; Codex posts as its own bot; an
// unsigned comment from the owner's account is the owner. Unsigned bot output counts as no one.
function signer(comment) {
  const login = String(comment?.user?.login || '');
  if (/codex/i.test(login)) return 'Codex';
  // "**[Claude]**", and also ChatGPT's unbolded "[ChatGPT Finance]".
  const m = String(comment?.body || '').match(/^\s*(?:\*\*)?\[(CEO|Claude|Dispatcher|Codex|ChatGPT)(?:\s[^\]\n]{0,40})?\](?!\()/);
  if (m) return m[1];
  if (comment?.user?.type === 'User' && !/\[bot\]$/.test(login)) return 'מנחם';
  return null;
}

function summarizeActivity(entries, nowMs) {
  const byAgent = new Map(AGENTS.map(name => [name, { name, lastAt: null, items24h: new Map(), items7d: new Set() }]));
  for (const { who, at, item } of entries) {
    const agent = byAgent.get(who);
    if (!agent) continue;
    if (!agent.lastAt || Date.parse(at) > Date.parse(agent.lastAt)) agent.lastAt = at;
    agent.items7d.add(item.number);
    if (nowMs - Date.parse(at) <= 24 * 3600000) agent.items24h.set(item.number, item);
  }
  return [...byAgent.values()].map(agent => ({
    name: agent.name, lastAt: agent.lastAt, items7d: agent.items7d.size,
    today: [...agent.items24h.values()].slice(0, 6).map(item => ({ number: item.number, title: item.title, url: item.url })),
  }));
}

async function collectCompany({ read, issues, pulls, now = () => Date.now(), mapLimit, concurrency = 4 }) {
  const nowMs = now();
  const items = [...issues.map(item => ({ ...item, kind: 'issue' })), ...pulls.map(item => ({ ...item, kind: 'pull' }))];
  const openByNumber = new Map(items.map(item => [item.number, item]));
  const result = { minutes: null, activity: [], idle: [], errors: [] };
  const code = error => (/^GITHUB_[A-Z0-9_]+$/.test(error?.message) ? error.message : 'GITHUB_COLLECTION_FAILED');
  // Reads comment pages from the newest backwards, until `enough(collected, oldestOnPages)` holds or
  // page 1 is read. The last page alone is not enough: right after a 100-comment boundary it holds a
  // single comment. Running out of the page budget first throws, so a partial read is never presented
  // as complete.
  const readBack = async (number, count, enough, maxPages = MAX_COMMENT_PAGES) => {
    const collected = [];
    for (let page = Math.max(1, Math.ceil(Number(count || 0) / 100)), reads = 0; page >= 1; page -= 1, reads += 1) {
      if (reads === maxPages) throw new Error('GITHUB_PAGINATION_LIMIT');
      const batch = await read(`/issues/${number}/comments?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('GITHUB_RESPONSE_INVALID');
      collected.unshift(...batch);
      const oldest = Math.min(...batch.map(comment => Date.parse(comment.created_at)).filter(Number.isFinite));
      if (batch.length && enough(collected, oldest)) break;
    }
    return collected;
  };
  const minutesOf = comment => {
    const parsed = parseMinutes(comment.body, comment.created_at);
    if (!parsed) return null;
    parsed.url = typeof comment.html_url === 'string' && comment.html_url.startsWith('https://github.com/') ? comment.html_url : null;
    parsed.meetingAt = deadlineAt(parsed.title.replace(/^[^\d]*/, ''), comment.created_at) || comment.created_at;
    return parsed;
  };
  const newestMeeting = list => list.map(minutesOf).filter(Boolean)
    .sort((a, b) => Date.parse(b.meetingAt) - Date.parse(a.meetingAt))[0] || null;

  try {
    const issue = await read(`/issues/${MINUTES_ISSUE}`);
    // Minutes can be posted out of order (a backlog of older meetings), so the newest meeting wins,
    // by the meeting time in the title, not by when the comment was posted. Minutes are always
    // posted after their meeting, so once the pages reach back before the best meeting found, no
    // earlier comment can describe a newer one.
    const comments = await readBack(MINUTES_ISSUE, issue?.comments, (collected, oldest) => {
      const best = newestMeeting(collected);
      return Boolean(best) && oldest < Date.parse(best.meetingAt);
    });
    const minutes = newestMeeting(comments);
    if (minutes) minutes.tasks = minutes.tasks.map(task => taskState(task, minutes, openByNumber, nowMs));
    result.minutes = minutes;
  } catch (error) { result.errors.push(`minutes:${code(error)}`); }

  try {
    const recent = items
      .filter(item => nowMs - Date.parse(item.updatedAt) <= ACTIVITY_DAYS * 86400000)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, MAX_ACTIVITY_ITEMS);
    // Every comment inside the 7-day window is read, not just the last page.
    const windowStart = nowMs - ACTIVITY_DAYS * 86400000;
    const perItem = await mapLimit(recent, concurrency, async item => (await readBack(item.number, item.comments,
      (_collected, oldest) => oldest < windowStart))
      .filter(comment => Date.parse(comment.created_at) >= windowStart)
      .map(comment => ({ who: signer(comment), at: comment.created_at, item })));
    result.activity = summarizeActivity(perItem.flat().filter(entry => entry.who), nowMs);
    result.activityItems = recent.length;
  } catch (error) { result.errors.push(`activity:${code(error)}`); }

  // Open work nobody has touched for two days: the clearest sign that something is stuck.
  result.idle = items
    .filter(item => nowMs - Date.parse(item.updatedAt) > IDLE_HOURS * 3600000)
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
    .slice(0, 12)
    .map(item => ({ number: item.number, title: item.title, url: item.url, updatedAt: item.updatedAt, kind: item.kind }));
  return result;
}

module.exports = { collectCompany, parseMinutes, parseTaskLine, deadlineAt, taskState, signer, summarizeActivity, MINUTES_ISSUE };
