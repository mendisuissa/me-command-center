'use strict';
// 12.11: a phone kept the previous app.js for up to 10 minutes after a deploy and showed the new
// index.html with blank new panels. Every asset reference now carries a hash of its content.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { versionAssets } = require('../scripts/build');

const SITE = path.join(__dirname, '..', 'site');
const read = file => (fs.existsSync(path.join(SITE, file)) ? fs.readFileSync(path.join(SITE, file)) : null);

test('every script and the stylesheet in index.html get a content version', () => {
  const html = versionAssets(fs.readFileSync(path.join(SITE, 'index.html'), 'utf8'), read);
  for (const file of ['vault.js', 'decision.js', 'app.js', 'styles.css']) {
    assert.match(html, new RegExp(`${file.replace('.', '\\.')}\\?v=[0-9a-f]{12}"`), file);
  }
  assert.doesNotMatch(html, /(src|href)="[a-z0-9-]+\.(js|css)"/, 'no unversioned asset reference is left');
});

test('the version changes when the file changes, and only then', () => {
  const html = '<script src="app.js"></script>';
  const a = versionAssets(html, () => Buffer.from('one'));
  assert.equal(a, versionAssets(html, () => Buffer.from('one')));
  assert.notEqual(a, versionAssets(html, () => Buffer.from('two')));
});

test('a reference to a missing file and other markup are left untouched', () => {
  const html = '<script src="gone.js"></script><a href="app.js">x</a>';
  assert.equal(versionAssets(html, () => null), html);
  assert.equal(versionAssets('<a href="app.js">x</a>', () => Buffer.from('x')), '<a href="app.js">x</a>');
});
