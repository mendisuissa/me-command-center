'use strict';

// Collects the private GitHub state, encrypts it, and writes the static site to _site/.
// This repository and its Actions logs are public: print only short status codes, never data.
const crypto = require('node:crypto');
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
  const titles = [...data.issues, ...data.pulls].map(item => item.title).filter(title => title.length >= 6);
  if (titles.some(title => serialized.includes(title)) || serialized.includes(data.repo)) fail('PLAINTEXT_IN_OUTPUT');
}

// GitHub Pages lets browsers keep every file for 10 minutes. Right after a deploy a phone could load
// the new index.html with the previous app.js, and new panels then stay blank (12.11). Each script and
// stylesheet reference therefore carries a hash of that file's content: a page and its code always match.
function versionAssets(html, contentOf) {
  return html.replace(/(<script\s+src="|<link\s+rel="stylesheet"\s+href=")([a-z0-9-]+\.(?:js|css))"/g, (whole, prefix, file) => {
    const content = contentOf(file);
    if (content == null) return whole;
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
    return `${prefix}${file}?v=${hash}"`;
  });
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
  const index = path.join(out, 'index.html');
  fs.writeFileSync(index, versionAssets(fs.readFileSync(index, 'utf8'), file => {
    const asset = path.join(out, file);
    return fs.existsSync(asset) ? fs.readFileSync(asset) : null;
  }));
  fs.writeFileSync(path.join(out, 'data.json'), serialized);
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  const github = data.sources.find(source => source.name === 'github');
  const ci = data.sources.find(source => source.name === 'github-ci');
  console.log(`BUILD_OK github=${github?.ok ? 'OK' : github?.error || 'UNKNOWN'} ci=${ci ? ci.error : 'OK'}`);
}

if (require.main === module) main().catch(() => fail('UNEXPECTED'));

module.exports = { main, MIN_PASSPHRASE, versionAssets };
