'use strict';
// Renders the dashboard from synthetic fixture data (encrypted like production) and screenshots it.
// Usage: node docs/screenshots/render.js <out-dir>   (needs Playwright with Chromium; not run in CI)
const fs = require('node:fs');
const path = require('node:path'); const http = require('node:http');
const ROOT = path.join(__dirname, '..', '..');
const { collect } = require(`${ROOT}/scripts/collect`);
const vault = require(`${ROOT}/site/vault`);
const { workforceFixture, REPO } = require(`${ROOT}/test/fixtures/workforce`);
const { chromium } = require('playwright');
const PASS = 'fixture-passphrase-for-screenshots-only';
const OUT = process.argv[2];

async function dataFor(now, failComments) {
  const fx = workforceFixture(now);
  const fetchImpl = async url => {
    const p = url.replace(`https://api.github.com/repos/${REPO}`, '');
    let body;
    if (p === '') body = { default_branch: 'main' };
    else if (p.startsWith('/issues/comments')) { if (failComments) return { ok: false, status: 502 }; body = new URL(url).searchParams.get('page') === '1' ? fx.comments : []; }
    else if (p.startsWith('/issues?')) body = fx.issues.map(i => ({ updated_at: new Date(now - 3600e3).toISOString(), ...i }));
    else if (/^\/pulls\/\d+\/reviews/.test(p)) body = fx.reviews[p.split('/')[2]] || [];
    else if (p.startsWith('/pulls?')) body = fx.pulls.map(x => ({ updated_at: new Date(now - 7200e3).toISOString(), user: { login: 'builder' }, ...x }));
    else if (p.startsWith('/actions/runs')) body = { workflow_runs: [{ name: 'Tests', status: 'completed', conclusion: 'success', created_at: new Date(now - 600e3).toISOString(), html_url: 'https://github.com/owner/private-repo/actions/runs/1' }] };
    else return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => body };
  };
  return collect({ token: 'fixture', repo: REPO, fetchImpl, now: () => now });
}

(async () => {
  const variants = [['fresh', Date.now(), false], ['stale', Date.now() - 3 * 3600e3, false], ['failed', Date.now(), true]];
  const key = await vault.deriveKey(PASS);
  const browser = await chromium.launch();
  for (const [name, now, fail] of variants) {
    const dir = path.join(OUT, `site-${name}`);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(`${ROOT}/site`)) fs.copyFileSync(`${ROOT}/site/${f}`, path.join(dir, f));
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(await vault.seal(key, await dataFor(now, fail))));
    const server = http.createServer((req, res) => {
      const file = path.join(dir, new URL(req.url, 'http://x').pathname.replace(/^\/$/, '/index.html'));
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(file)];
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8` }); fs.createReadStream(file).pipe(res);
    });
    await new Promise(r => server.listen(0, r));
    const widths = name === 'fresh' ? [['desktop', 1280], ['phone', 390]] : [['desktop', 1280]];
    for (const [label, width] of widths) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: label === 'phone' ? 2 : 1, colorScheme: 'dark' });
      const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.fill('#passphrase', PASS); await page.click('#unlock-button');
      await page.waitForSelector('#dashboard:not([hidden])', { timeout: 60000 });
      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      // Crop at the end of the Workforce panel: the rest of the board is unchanged.
      const bottom = await page.evaluate(() => { const r = document.querySelector('.workforce-panel').getBoundingClientRect(); return r.bottom + window.scrollY + 16; });
      await page.screenshot({ path: path.join(OUT, `workforce-${name}-${label}.png`), fullPage: true, clip: { x: 0, y: 0, width, height: bottom } });
      console.log(name, label, 'scrollWidth', sw, 'errors', JSON.stringify(errors));
      await page.close();
    }
    server.close();
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
