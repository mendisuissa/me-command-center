'use strict';

// Liveness probes for the company's systems. The list comes from the CC_FLEET secret, so the
// endpoints never appear in this public repository; results are only published encrypted.
const MAX_SYSTEMS = 30;

function parseFleet(raw) {
  if (!raw) return [];
  let list;
  try { list = JSON.parse(raw); } catch { throw new Error('CC_FLEET_INVALID'); }
  if (!Array.isArray(list) || list.length > MAX_SYSTEMS) throw new Error('CC_FLEET_INVALID');
  return list.map(item => {
    const name = String(item?.name || '').slice(0, 60);
    let url;
    try { url = new URL(String(item?.url || '')); } catch { throw new Error('CC_FLEET_INVALID'); }
    if (!name || url.protocol !== 'https:') throw new Error('CC_FLEET_INVALID');
    return { name, url: url.href };
  });
}

async function probe({ name, url }, { fetchImpl = globalThis.fetch, timeoutMs = 15_000, now = () => Date.now() } = {}) {
  const started = now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: controller.signal,
      headers: { 'user-agent': 'me-command-center-probe' } });
    // Read the body so a server that sends headers and then stalls still counts as down.
    await response.text();
    return { name, ok: response.status < 400, status: response.status, ms: now() - started };
  } catch (error) {
    return { name, ok: false, status: null, ms: now() - started,
      error: error.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE' };
  } finally { clearTimeout(timeout); }
}

async function probeFleet(raw, options = {}) {
  const systems = parseFleet(raw);
  if (!systems.length) return null;
  const checkedAt = new Date((options.now || Date.now)()).toISOString();
  const results = await Promise.all(systems.map(system => probe(system, options)));
  return { checkedAt, systems: results };
}

module.exports = { probeFleet, parseFleet, probe };
