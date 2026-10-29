'use strict';

(function () {
  const $ = id => document.getElementById(id);
  const STALE_MINUTES = 75;        // the schedule runs every 30 minutes; GitHub may delay a run
  const CEO_STALE_HOURS = 8;       // the CEO runs five times a day
  const REFRESH_MS = 5 * 60 * 1000;
  const STATE = { success: ['ok', 'עובר'], failure: ['bad', 'נכשל'], pending: ['warn', 'רץ'], cancelled: ['', 'בוטל'],
    none: ['', 'בלי CI'], unknown: ['', 'לא נבדק'] };
  const AGENT = { claude: 'CEO', codex: 'Codex', chatgpt: 'ChatGPT', ceo: 'CEO' };
  let key = null;
  let lastLoad = 0;

  // Only a non-extractable CryptoKey is stored, and only when the viewer ticks "remember".
  function keyStore(mode, action) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('me-command-center', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('keys', mode);
        const op = action(tx.objectStore('keys'));
        tx.oncomplete = () => { db.close(); resolve(op.result); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }
  const loadKey = () => keyStore('readonly', store => store.get('key')).catch(() => null);
  const saveKey = value => keyStore('readwrite', store => store.put(value, 'key')).catch(() => null);
  const forgetKey = () => keyStore('readwrite', store => store.delete('key')).catch(() => null);

  // Every value from the data is rendered as text; nothing is ever parsed as HTML.
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props?.className) node.className = props.className;
    if (props?.text != null) node.textContent = props.text;
    if (props?.href) { node.href = props.href; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
    for (const child of children || []) if (child) node.append(child);
    return node;
  }
  const githubLink = value => (typeof value === 'string' && value.startsWith('https://github.com/') ? value : null);
  const linkOrText = (text, url, className) => el(githubLink(url) ? 'a' : 'span', { text, href: githubLink(url), className });
  const when = value => {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? 'לא ידוע'
      : date.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' });
  };
  // Hand-written: Chromium's Hebrew Intl.RelativeTimeFormat renders one minute as "לפני דקה (1)".
  const ago = value => {
    const minutes = Math.round((Date.now() - Date.parse(value)) / 60000);
    if (!Number.isFinite(minutes)) return 'לא ידוע';
    if (minutes < 1) return 'עכשיו';
    if (minutes < 60) return minutes === 1 ? 'לפני דקה' : `לפני ${minutes} דקות`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return hours === 1 ? 'לפני שעה' : hours === 2 ? 'לפני שעתיים' : `לפני ${hours} שעות`;
    const days = Math.round(hours / 24);
    return days === 2 ? 'לפני יומיים' : `לפני ${days} ימים`;
  };
  const roleOf = (item, prefix) => {
    const label = (item.labels || []).find(name => name.startsWith(prefix));
    return label ? AGENT[label.slice(prefix.length)] || label.slice(prefix.length) : null;
  };
  const needsOwner = item => (item.labels || []).includes('needs-owner');
  // "מנחם: <question> (לענות: …)" → "<question>"
  const ownerQuestion = text => String(text || '').replace(/^מנחם:\s*/, '').replace(/\s*\(לענות:[^)]*\)\s*$/, '');

  function setStatus(text, info) {
    $('lock-status').textContent = text;
    $('lock-status').className = info ? 'info' : '';
  }

  async function fetchEnvelope() {
    try {
      const response = await fetch(`data.json?t=${Date.now()}`, { cache: 'no-store', credentials: 'omit' });
      if (!response.ok) throw new Error('DATA_UNAVAILABLE');
      return await response.json();
    } catch { throw new Error('DATA_UNAVAILABLE'); }
  }

  function renderVerdict(data, github, waiting, down) {
    const ageMinutes = (Date.now() - Date.parse(data.generatedAt)) / 60000;
    const ceoHours = data.manager ? (Date.now() - Date.parse(data.manager.updatedAt)) / 3600000 : Infinity;
    let state = 'ok';
    let text = 'הכל עובד. אין שום דבר שמחכה לך.';
    if (!github?.ok) { state = 'bad'; text = 'לא הצלחתי לקרוא את GitHub בעדכון האחרון'; }
    else if (down.length) { state = 'bad'; text = down.length === 1 ? `${down[0]} לא עונה` : `${down.length} מערכות לא עונות: ${down.join(', ')}`; }
    else if (waiting) { state = 'warn'; text = waiting === 1 ? 'החלטה אחת מחכה לך' : `${waiting} החלטות מחכות לך`; }
    else if (!(ageMinutes <= STALE_MINUTES)) { state = 'warn'; text = 'הנתונים לא התעדכנו כבר זמן רב'; }
    else if (ceoHours > CEO_STALE_HOURS) { state = 'warn'; text = 'ה-CEO לא דיווח יותר מ-8 שעות'; }
    $('verdict').className = `verdict ${state}`;
    $('verdict-text').textContent = text;

    const systems = data.fleet?.systems || [];
    const meta = [
      down.length && waiting ? (waiting === 1 ? 'גם: החלטה אחת מחכה לך' : `גם: ${waiting} החלטות מחכות לך`) : null,
      systems.length ? `${systems.length - down.length}/${systems.length} מערכות תקינות` : null,
      `${data.issues.length} משימות · ${data.pulls.length} PR`,
      data.manager ? `CEO: ${ago(data.manager.updatedAt)}` : 'CEO: עוד לא דיווח',
      `נתונים: ${ago(data.generatedAt)}`,
    ].filter(Boolean);
    $('verdict-meta').replaceChildren(...meta.map(text => el('li', { text })));
  }

  function renderOwner(issues) {
    const waiting = issues.filter(needsOwner);
    $('owner-count').textContent = waiting.length ? `${waiting.length}` : '';
    $('owner').replaceChildren(...(waiting.length ? waiting.map(issue => {
      const link = githubLink(issue.url);
      return el('article', { className: 'decision' }, [
        el('p', { className: 'meta' }, [el('span', { text: `#${issue.number}` }), el('span', { text: `עודכן ${ago(issue.updatedAt)}` })]),
        el('p', { className: 'question', text: ownerQuestion(issue.nextAction) || issue.title }),
        el('p', { className: 'about' }, [document.createTextNode('בנושא: '), linkOrText(issue.title, issue.url)]),
        link ? el('a', { className: 'answer', text: 'לענות', href: `${link}#new_comment_field` }) : null,
      ]);
    }) : [el('p', { className: 'empty', text: 'אין החלטות שמחכות לך.' })]));
    return waiting.length;
  }

  // The CEO edits one report issue on every run, so the report's age is the CEO's heartbeat.
  function renderCeo(ceo) {
    if (!ceo) {
      $('ceo-age').textContent = '';
      $('manager').replaceChildren(el('p', { className: 'empty', text: 'ה-CEO עוד לא פרסם דוח.' }));
      return;
    }
    const hours = (Date.now() - Date.parse(ceo.updatedAt)) / 3600000;
    $('ceo-age').textContent = ago(ceo.updatedAt);
    // replaceChildren would print a skipped (null) part as the text "null", so drop them first.
    $('manager').replaceChildren(...[
      hours > CEO_STALE_HOURS ? el('p', { className: 'stale-note', text: `ה-CEO לא דיווח יותר מ-${CEO_STALE_HOURS} שעות, וייתכן שהוא הפסיק לרוץ.` }) : null,
      ceo.verdict ? el('p', { className: 'ceo-verdict', text: ceo.verdict }) : null,
      // The health panel already shows the fleet; keep the CEO card to progress, blockers and the next step.
      ...(ceo.sections || []).filter(section => !section.title.startsWith('בריאות')).map(section => el('section', { className: 'ceo-section' }, [
        el('h3', { text: section.title }),
        el('ul', null, [
          ...section.items.slice(0, 4).map(item => el('li', { text: item })),
          section.items.length > 4 ? el('li', { className: 'more', text: `ועוד ${section.items.length - 4} בדוח המלא` }) : null,
        ]),
      ])),
      linkOrText('לדוח המלא ב-GitHub', ceo.url, 'ceo-link'),
    ].filter(Boolean));
  }

  function renderFleet(fleet) {
    const systems = fleet?.systems || [];
    $('fleet-age').textContent = fleet?.checkedAt ? ago(fleet.checkedAt) : '';
    if (fleet?.error) {
      $('fleet').replaceChildren(el('p', { className: 'empty', text: 'רשימת המערכות לא תקינה, ולכן לא נבדקה.' }));
      return [];
    }
    $('fleet').replaceChildren(...(systems.length ? systems.map(system => el('div', { className: `row sys ${system.ok ? 'ok' : 'bad'}` }, [
      el('span', { className: 'state-dot' }),
      el('span', { className: 'name', text: system.name }),
      el('span', { className: 'detail', text: system.ok ? `תקין · ${system.ms}ms`
        : system.error === 'TIMEOUT' ? 'לא עונה' : system.status ? `שגיאה ${system.status}` : 'לא זמין' }),
    ])) : [el('p', { className: 'empty', text: 'עוד לא הוגדרה רשימת מערכות.' })]));
    return systems.filter(system => !system.ok).map(system => system.name);
  }

  function renderTasks(issues) {
    const rank = item => (needsOwner(item) ? -1 : item.priority ? Number(item.priority.slice(1)) : 9);
    const sorted = [...issues].sort((a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    $('tasks-count').textContent = `${issues.length}`;
    $('tasks').replaceChildren(...(sorted.length ? sorted.map(issue => {
      const p0 = (issue.labels || []).some(name => /\[?P0\]?/.test(name)) || /\[P0\]/.test(issue.title);
      return el('article', { className: 'row' }, [
        el('div', { className: 'line' }, [el('span', { className: 'num', text: `#${issue.number}` }),
          el('p', { className: 'title' }, [linkOrText(issue.title, issue.url)])]),
        el('div', { className: 'chips' }, [
          needsOwner(issue) ? el('span', { className: 'chip owner', text: 'מחכה לך' }) : null,
          issue.priority || p0 ? el('span', { className: 'chip p0', text: issue.priority || 'P0' }) : null,
          roleOf(issue, 'driver:') ? el('span', { className: 'chip', text: `מבצע: ${roleOf(issue, 'driver:')}` }) : null,
          roleOf(issue, 'reviewer:') ? el('span', { className: 'chip', text: `בודק: ${roleOf(issue, 'reviewer:')}` }) : null,
          el('span', { className: 'chip', text: ago(issue.updatedAt) }),
        ]),
        el('p', { className: 'next' }, [el('b', { text: 'הבא: ' }),
          document.createTextNode(issue.nextAction || 'לא הוגדר')]),
      ]);
    }) : [el('p', { className: 'empty', text: 'אין משימות פתוחות.' })]));
  }

  function renderPulls(pulls) {
    $('prs-count').textContent = `${pulls.length}`;
    $('prs').replaceChildren(...(pulls.length ? pulls.map(pull => {
      const [tone, label] = STATE[pull.ci.state] || ['', pull.ci.state];
      return el('article', { className: 'row' }, [
        el('div', { className: 'line' }, [el('span', { className: 'num', text: `#${pull.number}` }),
          el('p', { className: 'title' }, [linkOrText(pull.title, pull.url)])]),
        el('div', { className: 'chips' }, [
          el('span', { className: `chip ${tone}`, text: `CI: ${label}` }),
          pull.draft ? el('span', { className: 'chip', text: 'טיוטה' }) : null,
          el('span', { className: 'chip', text: ago(pull.updatedAt) }),
        ]),
      ]);
    }) : [el('p', { className: 'empty', text: 'אין עבודה פתוחה.' })]));
    return pulls.filter(pull => pull.ci.state === 'failure').length;
  }

  function renderMain(main) {
    const workflows = main?.workflows || [];
    // The source repo runs CI on pull requests only; an always-empty section would just be noise.
    $('ci-section').hidden = !workflows.length;
    $('ci-title').textContent = main ? `CI בענף ${main.name}` : 'CI בענף הראשי';
    $('ci').replaceChildren(...workflows.map(workflow => {
      const [tone, label] = STATE[workflow.state] || ['', workflow.state];
      return el('div', { className: `row sys ${tone === 'bad' ? 'bad' : tone === 'ok' ? 'ok' : ''}` }, [
        el('span', { className: 'state-dot' }), linkOrText(workflow.name, workflow.url, 'name'),
        el('span', { className: 'detail', text: `${label} · ${ago(workflow.updatedAt)}` }),
      ]);
    }));
  }

  function render(data) {
    const github = (data.sources || []).find(source => source.name === 'github');
    const banners = [];
    if (!github?.ok) {
      const hint = github?.error === 'GITHUB_HTTP_401' ? ' ייתכן שתוקף הטוקן של GitHub פג.' : '';
      banners.push(el('p', { className: 'banner bad', text: `קריאת GitHub נכשלה (${github?.error || 'UNKNOWN'}), ולכן אין כאן נתוני משימות.${hint}` }));
    }
    if (!((Date.now() - Date.parse(data.generatedAt)) / 60000 <= STALE_MINUTES)) {
      banners.push(el('p', { className: 'banner warn', text: `הנתונים נאספו ${ago(data.generatedAt)}. העדכון האוטומטי אמור לרוץ כל 30 דקות, וייתכן שהוא נעצר.` }));
    }
    $('banners').replaceChildren(...banners);

    const down = renderFleet(data.fleet);
    const waiting = renderOwner(data.issues);
    renderVerdict(data, github, waiting, down);
    renderCeo(github?.ok ? data.manager : null);
    renderTasks(data.issues);
    renderPulls(data.pulls);
    renderMain(data.mainBranch);
    $('generated').textContent = `נאסף: ${when(data.generatedAt)}`;
  }

  function show(unlocked) {
    $('locked').hidden = unlocked;
    $('dashboard').hidden = !unlocked;
    $('actions').hidden = !unlocked;
  }

  async function load(candidate) {
    const data = await window.MeVault.open(candidate, await fetchEnvelope());
    key = candidate;
    lastLoad = Date.now();
    render(data);
    show(true);
  }

  async function refresh() {
    if (!key) return;
    $('refresh').disabled = true;
    try { await load(key); } catch (error) {
      // A new passphrase was deployed, or the data could not be fetched: go back to the lock screen.
      if (error.message !== 'DATA_UNAVAILABLE') { await lock(); setStatus('הסיסמה השתנתה. הקלד את הסיסמה החדשה.'); }
    } finally { $('refresh').disabled = false; }
  }

  async function lock() {
    key = null;
    await forgetKey();
    ['owner', 'manager', 'tasks', 'prs', 'ci', 'fleet', 'banners', 'verdict-meta'].forEach(id => $(id).replaceChildren());
    show(false);
    setStatus('');
    $('passphrase').focus();
  }

  $('unlock').addEventListener('submit', async event => {
    event.preventDefault();
    const input = $('passphrase');
    if (!input.value.trim()) { setStatus('הקלד סיסמה.'); return; }
    $('unlock-button').disabled = true;
    setStatus('פותח…', true);
    try {
      const candidate = await window.MeVault.deriveKey(input.value);
      let envelope;
      try { envelope = await fetchEnvelope(); } catch { setStatus('לא הצלחתי לטעון את הנתונים. בדוק את החיבור ונסה שוב.'); return; }
      try { await window.MeVault.open(candidate, envelope); } catch { setStatus('הסיסמה לא נכונה.'); return; }
      input.value = '';
      if ($('remember').checked) await saveKey(candidate);
      await load(candidate);
      setStatus('');
    } finally { $('unlock-button').disabled = false; }
  });
  $('refresh').addEventListener('click', refresh);
  $('lock').addEventListener('click', lock);
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastLoad > REFRESH_MS) refresh();
  });

  (async () => {
    const remembered = await loadKey();
    if (!remembered) return;
    try { await load(remembered); } catch { await forgetKey(); setStatus('הקלד את הסיסמה כדי לפתוח.', true); }
  })();
})();
