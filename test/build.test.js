'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const build = path.join(__dirname, '..', 'scripts', 'build.js');
const run = env => spawnSync(process.execPath, [build], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });

test('build refuses to run without a long passphrase, a token or a source repo', () => {
  const base = { CC_SOURCE_TOKEN: 'x', CC_SOURCE_REPO: 'owner/repo' };
  for (const [env, code] of [
    [{ ...base }, 'CC_PASSPHRASE_MISSING_OR_SHORT'],
    [{ ...base, CC_PASSPHRASE: 'short-passphrase' }, 'CC_PASSPHRASE_MISSING_OR_SHORT'],
    [{ CC_SOURCE_REPO: 'owner/repo', CC_PASSPHRASE: 'p'.repeat(32) }, 'CC_SOURCE_TOKEN_MISSING'],
    [{ CC_SOURCE_TOKEN: 'x', CC_PASSPHRASE: 'p'.repeat(32) }, 'CC_SOURCE_REPO_MISSING'],
  ]) {
    const result = run(env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`BUILD_FAILED ${code}`));
    assert.equal(result.stdout, '');
  }
});
