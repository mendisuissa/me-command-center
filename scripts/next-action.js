'use strict';

// Copied verbatim from the source repository's command-center/collectors/github.js (commit ed8942c).
// Keep the two copies identical; the full parser tests live there, a regression subset in test/collect.test.js.

function visibleMarkdownLine(raw, state) {
  if (state.comment) {
    state.hiddenKind = 'comment';
    if (raw.includes('-->')) state.comment = false;
    return false;
  }
  if (raw.includes('<!--')) {
    state.hiddenKind = 'comment';
    if (!raw.includes('-->', raw.indexOf('<!--') + 4)) state.comment = true;
    return false;
  }
  if (state.htmlTag) {
    state.hiddenKind = 'html';
    if (raw.toLowerCase().includes(`</${state.htmlTag}>`)) state.htmlTag = null;
    return false;
  }
  if (state.fence) {
    state.hiddenKind = 'fence';
    const closing = raw.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    if (closing && closing[1][0] === state.fence.char && closing[1].length >= state.fence.length) {
      state.fence = null;
    }
    return false;
  }
  const opening = raw.match(/^ {0,3}(`{3,}|~{3,})/);
  if (opening) {
    state.hiddenKind = 'fence';
    state.fence = { char: opening[1][0], length: opening[1].length };
    return false;
  }
  // Same match as /^ {0,3}<(name)\b[^>]*>/, without its quadratic backtracking on long lines.
  const html = raw.match(/^ {0,3}<([A-Za-z][A-Za-z0-9-]*)\b/);
  if (html && raw.includes('>', html[0].length)) {
    state.hiddenKind = 'html';
    const tag = html[1].toLowerCase();
    if (!raw.toLowerCase().includes(`</${tag}>`) && !/\/\s*>\s*$/.test(raw)) state.htmlTag = tag;
    return false;
  }
  state.hiddenKind = null;
  return true;
}

// Trailing spaces/tabs only, without a regex: /[ \t]+$/ is itself quadratic on a long run.
function trimSpaceTab(line) {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end -= 1;
  return line.slice(0, end);
}

// Surface a real, explicitly documented next action; never infer completion from activity alone.
function nextActionFromBody(body) {
  const lines = String(body || '').split(/\r?\n/);
  // Same match as /...actions?\s*:?[ \t]*$/ on the raw line. Those overlapping trailing quantifiers
  // made one long issue-body line block the event loop for seconds.
  const heading = /^ {0,3}#{1,6}\s*(?:immediate\s+)?next\s+(?:executable\s+)?actions?\s*:?$/i;
  const state = {};
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!visibleMarkdownLine(raw, state)) continue;
    if (!heading.test(trimSpaceTab(raw))) continue;
    const actionState = {};
    for (let j = i + 1; j < lines.length; j += 1) {
      const actionRaw = lines[j];
      if (!visibleMarkdownLine(actionRaw, actionState)) continue;
      if (/^ {0,3}#{1,6}\s/.test(actionRaw)) break;
      if (!actionRaw.trim()) continue;
      if (/^(?: {4,}|\t)/.test(actionRaw)) return null;
      const item = actionRaw.match(/^( {0,3})(?:[-*+]|\d+[.)])\s+(.+)$/);
      if (!item) return null;
      let action = item[2];
      const task = action.match(/^\[([ xX])\]\s+(.+)$/);
      if (task) {
        if (task[1].toLowerCase() === 'x') continue;
        action = task[2];
      }
      // Same test as /<!--|<\/?[A-Za-z][^>]*>/ in linear time: a tag exists iff a '>' follows the first opener.
      const opener = action.search(/<\/?[A-Za-z]/);
      if (action.includes('<!--') || (opener !== -1 && action.includes('>', opener))) continue;
      // A continuation can contain a condition or approval boundary. Do not show only its first line.
      const continuationState = {};
      for (let k = j + 1; k < lines.length; k += 1) {
        const following = lines[k];
        if (!following.trim()) continue;
        if (!visibleMarkdownLine(following, continuationState)) return null;
        const nextHeading = following.match(/^( {0,3})#{1,6}\s/);
        if (nextHeading) {
          if (nextHeading[1].length <= item[1].length) break;
          return null;
        }
        const nextItem = following.match(/^( {0,3})(?:[-*+]|\d+[.)])\s+/);
        if (nextItem && nextItem[1].length <= item[1].length) break;
        return null;
      }
      const wholeLink = action.match(/^\[([^\]]+)\]\([^)]*\)$/);
      action = (wholeLink ? wholeLink[1] : action).trim();
      // Never present a silently truncated instruction as the complete action.
      if (!action || action.length > 240) return null;
      return action;
    }
  }
  return null;
}

module.exports = { nextActionFromBody };
