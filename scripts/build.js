'use strict';

// Collects the private GitHub state, encrypts it, and writes the static site to _site/.
// This repository and its Actions logs are public: print only short status codes, never data.
const fs = require('node:fs');
const path = require('node:path');
const { collect } = require('./collect');
const { probeFleet, parseFleet } = require('./fleet');
const vault = require('../site/vault');

const MIN_PASSPHRASE = 24;
const ROOT = path.join(__dirname, '..');

function fail(code) {
  console.error(`BUILD_FAILED ${code}`);
  process.exit(1);
}

// A wrong refactor must never ship plaintext: refuse if any title is visible in the output.
function assertNoPlaintext(serialized, data) {
  const workforce = data.workforce || { workers: [], blockers: [] };
  const titles = [...data.issues, ...data.pulls, ...workforce.blockers].map(item => item.title)
    .concat(workforce.workers.flatMap(worker => worker.recent.map(event => event.excerpt)))
    .filter(text => typeof text === 'string' && text.length >= 6);
  if (titles.some(title => serialized.includes(title)) || serialized.includes(data.repo)) fail('PLAINTEXT_IN_OUTPUT');
}

async function main(env = process.env) {
  const passphrase = String(env.CC_PASSPHRASE || '').trim();
  if (passphrase.length < MIN_PASSPHRASE) fail('CC_PASSPHRASE_MISSING_OR_SHORT');
  if (!env.CC_SOURCE_TOKEN) fail('CC_SOURCE_TOKEN_MISSING');
  if (!env.CC_SOURCE_REPO) fail('CC_SOURCE_REPO_MISSING');

  const data = await collect({ token: env.CC_SOURCE_TOKEN.trim(), repo: env.CC_SOURCE_REPO.trim() });
  let fleetUrls = [];
  try {
    fleetUrls = parseFleet(env.CC_FLEET).map(system => system.url);
    data.fleet = await probeFleet(env.CC_FLEET);
  } catch { data.fleet = { error: 'CC_FLEET_INVALID', systems: [] }; }
  const envelope = await vault.seal(await vault.deriveKey(passphrase), data);
  const serialized = JSON.stringify(envelope);
  assertNoPlaintext(serialized, data);
  if (fleetUrls.some(url => serialized.includes(new URL(url).hostname))) fail('PLAINTEXT_IN_OUTPUT');

  const out = path.join(ROOT, '_site');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out);
  for (const file of fs.readdirSync(path.join(ROOT, 'site'))) {
    fs.copyFileSync(path.join(ROOT, 'site', file), path.join(out, file));
  }
  fs.writeFileSync(path.join(out, 'data.json'), serialized);
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  const github = data.sources.find(source => source.name === 'github');
  const workforce = data.sources.find(source => source.name === 'workforce');
  console.log(`BUILD_OK github=${github?.ok ? 'OK' : github?.error || 'UNKNOWN'} workforce=${workforce?.ok ? 'OK' : workforce?.error || 'UNKNOWN'}`);
}

if (require.main === module) main().catch(() => fail('UNEXPECTED'));

module.exports = { main, MIN_PASSPHRASE };
