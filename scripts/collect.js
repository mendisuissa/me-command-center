'use strict';

const { nextActionFromBody } = require('./next-action');

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FAILED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
const MAX_PULLS_WITH_CI = 30;

// Read-only GitHub collection for the encrypted dashboard. Every call is a GET; errors become
// short codes so nothing from a response or the token can reach the (public) workflow log.
function createGitHubReader({ token, repo, fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
  if (typeof token !== 'string' || !token || !REPO.test(String(repo || ''))) throw new Error('GITHUB_CONFIG_INVALID');
  return async function read(path) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
        method: 'GET', signal: controller.signal, redirect: 'error',
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28', 'user-agent': 'me-command-center' },
      });
      if (!response.ok) throw new Error(`GITHUB_HTTP_${response.status}`);
      return await response.json();
    } catch (error) {
      throw new Error(/^GITHUB_[A-Z0-9_]+$/.test(error.message) ? error.message :
        error.name === 'AbortError' ? 'GITHUB_TIMEOUT' : 'GITHUB_FETCH_FAILED');
    } finally { clearTimeout(timeout); }
  };
}

// Pages until a short page; fails closed rather than presenting a truncated queue as complete.
async function readAll(read, path, maxPages = 3) {
  const items = [];
  const seen = new Set();
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await read(`${path}&per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('GITHUB_RESPONSE_INVALID');
    for (const item of batch) {
      if (typeof item?.id !== 'number' || seen.has(item.id)) throw new Error('GITHUB_PAGINATION_INCONSISTENT');
      seen.add(item.id);
      items.push(item);
    }
    if (batch.length < 100) return items;
  }
  throw new Error('GITHUB_PAGINATION_LIMIT');
}

const safeUrl = value => (typeof value === 'string' && value.startsWith('https://github.com/') ? value : null);

// The latest run of each workflow decides the state; an older failure that was re-run green does not.
function summarizeRuns(runs) {
  const latest = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    const name = String(run?.name || run?.workflow_id || '');
    const previous = latest.get(name);
    if (!previous || Date.parse(run.created_at) > Date.parse(previous.created_at)) latest.set(name, run);
  }
  const workflows = [...latest.values()].map(run => ({
    name: String(run.name || 'Workflow').slice(0, 120),
    state: run.status !== 'completed' ? 'pending' : FAILED.has(run.conclusion) ? 'failure'
      : run.conclusion === 'cancelled' ? 'cancelled' : 'success',
    url: safeUrl(run.html_url), updatedAt: run.updated_at || run.created_at || null,
  })).sort((a, b) => a.name.localeCompare(b.name));
  const states = new Set(workflows.map(item => item.state));
  const state = !workflows.length ? 'none' : states.has('failure') ? 'failure' : states.has('pending') ? 'pending'
    : states.has('cancelled') ? 'cancelled' : 'success';
  return { state, workflows };
}

async function collect({ token, repo, fetchImpl, now = () => Date.now() }) {
  const generatedAt = new Date(now()).toISOString();
  const read = createGitHubReader({ token, repo, fetchImpl });
  const result = { schema: 1, generatedAt, repo, sources: [], issues: [], pulls: [], mainBranch: null, manager: null };
  try {
    const [meta, issues, pulls] = await Promise.all([
      read(''),
      readAll(read, '/issues?state=open&sort=updated&direction=desc'),
      readAll(read, '/pulls?state=open&sort=updated&direction=desc'),
    ]);
    const labelsOf = item => (item.labels || []).map(label => String(label.name || ''));
    // The CEO's in-place report issue is shown as the CEO's heartbeat, not as a task.
    const report = issues.find(item => !item.pull_request && labelsOf(item).includes('ceo'));
    result.manager = report ? { number: report.number, url: safeUrl(report.html_url), updatedAt: report.updated_at || null } : null;
    result.issues = issues.filter(item => !item.pull_request && item !== report).map(item => ({
      number: item.number, title: String(item.title || '').slice(0, 300), url: safeUrl(item.html_url),
      owner: item.assignee?.login || null,
      priority: (item.labels || []).map(label => String(label.name || '')).find(name => /^P[0-3]$/i.test(name)) || null,
      labels: (item.labels || []).map(label => String(label.name || '')).slice(0, 12),
      updatedAt: item.updated_at || null, nextAction: nextActionFromBody(item.body),
    }));
    const pullsWithCi = pulls.slice(0, MAX_PULLS_WITH_CI);
    const ci = await Promise.all(pullsWithCi.map(pull => read(
      `/actions/runs?head_sha=${encodeURIComponent(String(pull.head?.sha || ''))}&per_page=50`)));
    result.pulls = pulls.map((pull, index) => ({
      number: pull.number, title: String(pull.title || '').slice(0, 300), url: safeUrl(pull.html_url),
      draft: Boolean(pull.draft), author: pull.user?.login || null, updatedAt: pull.updated_at || null,
      labels: labelsOf(pull).slice(0, 12),
      ci: index < pullsWithCi.length ? summarizeRuns(ci[index]?.workflow_runs) : { state: 'unknown', workflows: [] },
    }));
    const branch = String(meta?.default_branch || '');
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch)) throw new Error('GITHUB_RESPONSE_INVALID');
    const runs = await read(`/actions/runs?branch=${encodeURIComponent(branch)}&per_page=50`);
    result.mainBranch = { name: branch, ...summarizeRuns(runs?.workflow_runs) };
    result.sources.push({ name: 'github', ok: true, fetchedAt: generatedAt });
  } catch (error) {
    // Publish the failure itself (encrypted) instead of stale numbers presented as current.
    result.issues = []; result.pulls = []; result.mainBranch = null; result.manager = null;
    result.sources.push({ name: 'github', ok: false, fetchedAt: generatedAt,
      error: /^GITHUB_[A-Z0-9_]+$/.test(error.message) ? error.message : 'GITHUB_COLLECTION_FAILED' });
  }
  return result;
}

module.exports = { collect, summarizeRuns, createGitHubReader };
