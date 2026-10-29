'use strict';

(function () {
  const $ = id => document.getElementById(id);
  const STALE_MINUTES = 75;           // the schedule runs every 30 minutes; GitHub may delay a run
  const REFRESH_MS = 5 * 60 * 1000;
  const STATE_LABEL = { success: 'עובר', failure: 'נכשל', pending: 'רץ', cancelled: 'בוטל', none: 'אין ריצות', unknown: 'לא נבדק' };
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

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props?.className) node.className = props.className;
    if (props?.text != null) node.textContent = props.text;
    if (props?.href) { node.href = props.href; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
    for (const child of children || []) if (child) node.append(child);
    return node;
  }
  const githubLink = value => (typeof value === 'string' && value.startsWith('https://github.com/') ? value : null);
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
  const chip = state => el('span', { className: `chip ${state}`, text: STATE_LABEL[state] || state });
  const title = item => el('p', { className: 'title' }, [el(githubLink(item.url) ? 'a' : 'span',
    { text: item.title, href: githubLink(item.url) })]);

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

  const AGENT = { claude: 'Claude', codex: 'Codex', chatgpt: 'ChatGPT', ceo: 'CEO' };
  const roleOf = (item, prefix) => {
    const label = (item.labels || []).find(name => name.startsWith(prefix));
    return label ? AGENT[label.slice(prefix.length)] || label.slice(prefix.length) : null;
  };
  const needsOwner = item => (item.labels || []).includes('needs-owner');
  const nextLine = item => (item.nextAction
    ? el('p', { className: 'next' }, [el('span', { text: 'פעולה הבאה' }), document.createTextNode(item.nextAction)])
    : el('p', { className: 'next missing', text: 'פעולה הבאה לא הוגדרה' }));

  function renderOwner(issues) {
    const waiting = issues.filter(needsOwner);
    $('owner').replaceChildren(...(waiting.length ? waiting.map(issue => el('article', { className: 'card owner' }, [
      el('div', { className: 'meta' }, [el('span', { text: `#${issue.number}` }), el('span', { text: `עודכן ${ago(issue.updatedAt)}` })]),
      title(issue), nextLine(issue),
    ])) : [el('p', { className: 'empty', text: 'אין החלטות שמחכות לך.' })]));
    return waiting.length;
  }

  // The CEO edits one report issue on every run, so the report's age is the CEO's heartbeat.
  function renderManager(ceo) {
    const CEO_STALE_HOURS = 8;
    if (!ceo) {
      $('manager').replaceChildren(el('p', { className: 'banner warn', text: 'ה-CEO עוד לא פרסם דוח.' }));
      return;
    }
    const hours = (Date.now() - Date.parse(ceo.updatedAt)) / 3600000;
    const link = githubLink(ceo.url);
    $('manager').replaceChildren(el('article', { className: `card${hours > CEO_STALE_HOURS ? ' stale' : ''}` }, [
      el('p', { className: 'title' }, [el(link ? 'a' : 'span', { text: `דוח CEO: עודכן ${ago(ceo.updatedAt)}`, href: link })]),
      hours > CEO_STALE_HOURS
        ? el('p', { className: 'meta', text: `ה-CEO לא דיווח יותר מ-${CEO_STALE_HOURS} שעות, וייתכן שהוא הפסיק לרוץ.` })
        : el('p', { className: 'meta', text: 'ה-CEO פעיל. הדוח המלא נפתח בקישור.' }),
    ]));
  }

  function renderTasks(issues) {
    const rank = item => (item.priority ? Number(item.priority.slice(1)) : 9);
    const sorted = [...issues].sort((a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    $('tasks').replaceChildren(...(sorted.length ? sorted.map(issue => el('article', { className: 'card' }, [
      el('div', { className: 'meta' }, [el('span', { text: `#${issue.number}` }),
        issue.priority ? el('span', { className: 'chip priority', text: issue.priority }) : null,
        needsOwner(issue) ? el('span', { className: 'chip owner', text: 'מחכה לך' }) : null,
        el('span', { text: roleOf(issue, 'driver:') ? `מבצע: ${roleOf(issue, 'driver:')}` : 'לא שובץ' }),
        roleOf(issue, 'reviewer:') ? el('span', { text: `בודק: ${roleOf(issue, 'reviewer:')}` }) : null,
        el('span', { text: `עודכן ${ago(issue.updatedAt)}` })]),
      title(issue), nextLine(issue),
    ])) : [el('p', { className: 'empty', text: 'אין משימות פתוחות.' })]));
  }

  function renderPulls(pulls) {
    $('prs').replaceChildren(...(pulls.length ? pulls.map(pull => {
      const failing = pull.ci.workflows.find(workflow => workflow.state === 'failure');
      return el('article', { className: 'card' }, [
        el('div', { className: 'meta' }, [el('span', { text: `PR #${pull.number}` }),
          pull.draft ? el('span', { className: 'chip', text: 'טיוטה' }) : null, chip(pull.ci.state),
          el('span', { text: `עודכן ${ago(pull.updatedAt)}` })]),
        title(pull),
        failing ? el('p', { className: 'meta' }, [document.createTextNode('נכשל: '),
          el(githubLink(failing.url) ? 'a' : 'span', { text: failing.name, href: githubLink(failing.url) })]) : null,
      ]);
    }) : [el('p', { className: 'empty', text: 'אין PR פתוחים.' })]));
  }

  function renderMain(main) {
    const workflows = main?.workflows || [];
    // The source repo runs CI on pull requests only; an always-empty section would just be noise.
    $('ci-section').hidden = !workflows.length;
    $('ci-title').textContent = main ? `CI בענף ${main.name}` : 'CI בענף הראשי';
    $('ci').replaceChildren(...workflows.map(workflow => el('article', { className: 'card' }, [
      el('div', { className: 'meta' }, [chip(workflow.state), el('span', { text: ago(workflow.updatedAt) })]),
      el('p', { className: 'title' }, [el(githubLink(workflow.url) ? 'a' : 'span',
        { text: workflow.name, href: githubLink(workflow.url) })]),
    ])));
  }

  function render(data) {
    const github = (data.sources || []).find(source => source.name === 'github');
    const banners = [];
    const ageMinutes = (Date.now() - Date.parse(data.generatedAt)) / 60000;
    if (!(ageMinutes <= STALE_MINUTES)) {
      banners.push(el('p', { className: 'banner warn', text: `הנתונים נאספו ${ago(data.generatedAt)}. העדכון האוטומטי אמור לרוץ כל 30 דקות, ולכן ייתכן שהוא נעצר.` }));
    }
    if (!github?.ok) {
      const hint = github?.error === 'GITHUB_HTTP_401' ? ' ייתכן שתוקף הטוקן של GitHub פג.' : '';
      banners.push(el('p', { className: 'banner bad', text: `קריאת GitHub נכשלה בעדכון האחרון (${github?.error || 'UNKNOWN'}), ולכן אין כאן נתוני משימות.${hint}` }));
    }
    $('banners').replaceChildren(...banners);

    const failing = (data.mainBranch?.workflows || []).filter(w => w.state === 'failure').length +
      data.pulls.filter(pull => pull.ci.state === 'failure').length;
    $('issue-count').textContent = github?.ok ? data.issues.length : 'לא זמין';
    $('ci-count').textContent = github?.ok ? failing : 'לא זמין';
    $('ci-tile').classList.toggle('alert', github?.ok && failing > 0);
    $('age').textContent = ago(data.generatedAt);
    $('generated').textContent = `נאסף: ${when(data.generatedAt)}`;
    const waiting = renderOwner(data.issues);
    $('owner-count').textContent = github?.ok ? waiting : 'לא זמין';
    $('owner-tile').classList.toggle('alert', github?.ok && waiting > 0);
    $('prs-title').textContent = `עבודה בתהליך (${data.pulls.length} Pull Requests)`;
    renderManager(github?.ok ? data.manager : undefined);
    renderTasks(data.issues);
    renderPulls(data.pulls);
    renderMain(data.mainBranch);
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
    ['owner', 'manager', 'tasks', 'prs', 'ci', 'banners'].forEach(id => $(id).replaceChildren());
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
