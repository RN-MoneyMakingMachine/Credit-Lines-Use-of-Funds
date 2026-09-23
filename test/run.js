'use strict';

// End to end checks: starts the server with the file store on a test port,
// exercises the API over HTTP and drives the real page in jsdom.
// Run with: npm test

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PORT = 4100 + Math.floor(Math.random() * 800);
const BASE = 'http://127.0.0.1:' + PORT;
const CODE = 'test-code-123';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kapital-test-'));
const DATA_FILE = path.join(TMP, 'record.json');
const APP_JS = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

let server;
let cookie = '';
let failures = 0;
let passes = 0;
const consoleErrors = [];
const windows = [];

function check(name, ok, detail) {
  if (ok) {
    passes++;
    console.log('  ok    ' + name);
  } else {
    failures++;
    console.log('  FAIL  ' + name + (detail !== undefined ? '\n        ' + String(detail).slice(0, 600) : ''));
  }
}

function section(title) {
  console.log('\n' + title);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeout = 8000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(40);
  }
  throw new Error('Timed out waiting for ' + label + (last instanceof Error ? ': ' + last.message : ''));
}

function api(pathname, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (opts.auth !== false && cookie) headers.cookie = cookie;
  return fetch(BASE + pathname, Object.assign({ redirect: 'manual' }, opts, { headers }));
}

async function serverRecord() {
  const res = await api('/api/record');
  return res.json();
}

// ---------- Server ----------

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        ACCESS_CODE: CODE,
        SESSION_SECRET: 'test-secret-' + Date.now(),
        DATA_FILE,
        // Set TEST_DATABASE_URL to run the same checks against PostgreSQL.
        DATABASE_URL: process.env.TEST_DATABASE_URL || '',
        NODE_ENV: 'test'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
    server.on('exit', (code) => {
      if (code) reject(new Error('Server exited with code ' + code));
    });
    waitFor(async () => (await fetch(BASE + '/healthz')).ok, 'server start', 10000).then(resolve, reject);
  });
}

// ---------- jsdom clients ----------

class TestEventSource {
  constructor(url) {
    this.listeners = {};
    this.req = http.get(new URL(url, BASE), { headers: { cookie, accept: 'text/event-stream' } }, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (data) (this.listeners[event] || []).forEach((fn) => fn({ data }));
        }
      });
    });
    this.req.on('error', () => {});
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  close() {
    this.req.destroy();
  }
}

function openClient(name, { live = false } = {}) {
  const vc = new VirtualConsole();
  vc.on('error', (...args) => consoleErrors.push(name + ': ' + args.join(' ')));
  vc.on('jsdomError', (err) => consoleErrors.push(name + ': ' + (err && err.message)));
  const statuses = [];
  const dom = new JSDOM(INDEX_HTML, {
    url: BASE + '/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  const w = dom.window;
  w.fetch = (url, opts = {}) => {
    const headers = Object.assign({}, opts.headers || {}, { cookie });
    return fetch(new URL(url, BASE), Object.assign({}, opts, { headers })).then((res) => {
      statuses.push((opts.method || 'GET') + ' ' + res.status);
      return res;
    });
  };
  w.confirm = () => true;
  // Keep the stale clients stale: no background polling during the scenario.
  const realSetInterval = w.setInterval.bind(w);
  w.setInterval = (fn, ms) => (ms >= 15000 ? 0 : realSetInterval(fn, ms));
  if (live) {
    const sources = [];
    w.EventSource = function (url) {
      const s = new TestEventSource(url);
      sources.push(s);
      return s;
    };
    dom.sources = sources;
  } else {
    delete w.EventSource;
  }
  w.eval(APP_JS);
  windows.push(dom);
  const doc = w.document;
  const $ = (sel, root) => (root || doc).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || doc).querySelectorAll(sel));
  return { name, dom, w, doc, $, $$, statuses };
}

function fire(c, el, type) {
  el.dispatchEvent(new c.w.Event(type, { bubbles: true }));
}

function type(c, el, value) {
  el.focus();
  el.value = value;
  fire(c, el, 'input');
}

function setValue(c, el, value) {
  el.focus();
  el.value = value;
  fire(c, el, 'input');
  fire(c, el, 'change');
}

function blur(c) {
  const a = c.doc.activeElement;
  if (a && a !== c.doc.body) a.blur();
}

function text(el) {
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
}

async function waitSaved(c, label) {
  await waitFor(() => /^Saved /.test(text(c.$('#status'))), (label || c.name) + ' saved');
}

async function waitLoaded(c) {
  await waitFor(() => /save automatically/.test(text(c.$('#status'))), c.name + ' loaded');
}

// ---------- Tests ----------

async function testAuth() {
  section('1. Access');
  let res = await api('/api/record', { auth: false });
  check('unauthenticated API answers 401', res.status === 401);
  check('401 is JSON', /application\/json/.test(res.headers.get('content-type') || ''));

  res = await api('/', { auth: false });
  check('unauthenticated page redirects to /login', res.status === 302 && res.headers.get('location') === '/login');

  res = await api('/app.js', { auth: false });
  check('app script needs a session', res.status === 302);

  res = await api('/login', { auth: false });
  check('/login is public', res.status === 200 && /Kapital line/.test(await res.text()));

  res = await api('/login.js', { auth: false });
  check('/login.js is public', res.status === 200);
  res = await api('/styles.css', { auth: false });
  check('/styles.css is public', res.status === 200);

  check('Cache-Control no-store', res.headers.get('cache-control') === 'no-store');
  check('nosniff header', res.headers.get('x-content-type-options') === 'nosniff');
  check('X-Frame-Options DENY', res.headers.get('x-frame-options') === 'DENY');
  check('Referrer-Policy no-referrer', res.headers.get('referrer-policy') === 'no-referrer');
  check(
    'Content Security Policy',
    res.headers.get('content-security-policy') ===
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
  );

  res = await api('/api/login', {
    auth: false, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'wrong' })
  });
  check('wrong code answers 401', res.status === 401);
  check('wrong code sets no cookie', !res.headers.get('set-cookie'));

  res = await api('/api/login', {
    auth: false, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE })
  });
  const setCookie = res.headers.get('set-cookie') || '';
  check('right code answers 200', res.status === 200);
  check('right code sets the session cookie', /^session=[^;]+\.[^;]+/.test(setCookie), setCookie);
  check('cookie is HttpOnly and SameSite=Lax', /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), setCookie);
  check('cookie lasts 30 days', /Max-Age=2592000/.test(setCookie), setCookie);
  cookie = setCookie.split(';')[0];

  res = await api('/');
  check('page opens with the cookie', res.status === 200 && /id="dispositions"/.test(await res.text()));

  res = await api('/api/record', { auth: false, headers: { cookie: cookie.replace(/.$/, (ch) => (ch === 'a' ? 'b' : 'a')) } });
  check('tampered cookie is rejected', res.status === 401);

  res = await api('/login');
  check('/login with a session goes to the page', res.status === 302 && res.headers.get('location') === '/');
}

async function testApi() {
  section('2. API');
  let res = await api('/healthz', { auth: false });
  check('/healthz is 200', res.status === 200);

  const rec = await serverRecord();
  check('GET /api/record returns {version, data}', typeof rec.version === 'number' && Array.isArray(rec.data.dispositions));

  // Live events stream
  const events = [];
  let streamType = '';
  const req = http.get(BASE + '/api/events', { headers: { cookie } }, (r) => {
    streamType = r.headers['content-type'] || '';
    r.setEncoding('utf8');
    r.on('data', (d) => events.push(d));
  });
  req.on('error', () => {});
  await waitFor(() => streamType, 'event stream');
  check('/api/events is text/event-stream', /^text\/event-stream/.test(streamType), streamType);

  const put = (body) => api('/api/record', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body)
  });

  res = await put({ baseVersion: rec.version, data: rec.data });
  const saved = await res.json();
  check('PUT with the current version saves', res.status === 200 && saved.version === rec.version + 1, JSON.stringify(saved));
  await waitFor(() => events.join('').includes('event: changed'), 'changed event');
  check('save broadcasts changed {version}', events.join('').includes('data: {"version":' + saved.version + '}'), events.join(''));
  req.destroy();

  res = await put({ baseVersion: rec.version, data: rec.data });
  const conflict = await res.json();
  check('PUT with a stale version answers 409', res.status === 409);
  check('409 carries {version, data}', conflict.version === saved.version && Array.isArray(conflict.data.dispositions));

  res = await put({ baseVersion: saved.version, data: { dispositions: 'nope' } });
  check('bad shape answers 400', res.status === 400);
  res = await put({ baseVersion: saved.version, data: [] });
  check('array instead of record answers 400', res.status === 400);
  res = await put({ baseVersion: saved.version, data: { dispositions: [{ payments: [5] }] } });
  check('malformed payment answers 400', res.status === 400);
  res = await put({ baseVersion: 'x', data: rec.data });
  check('bad baseVersion answers 400', res.status === 400);

  const big = JSON.stringify({ baseVersion: saved.version, data: { dispositions: [], pad: 'x'.repeat(4.5 * 1024 * 1024) } });
  res = await put(big);
  check('body over 4 MB answers 413', res.status === 413);

  res = await api('/api/nothing');
  check('unknown API route answers 404 JSON', res.status === 404);
}

async function testMath() {
  section('3. Math on screen');
  const a = openClient('math');
  await waitLoaded(a);
  check('empty record status', text(a.$('#status')) === 'Empty record. Changes save automatically.', text(a.$('#status')));
  check('rate sentence', text(a.$('#rate-sentence')) ===
    'TIIE plus spread is 11.75% a year, 0.98% a month. A peso drawn for 90 days comes back as 1.0294 pesos.', text(a.$('#rate-sentence')));
  check('nothing drawn sentence', text(a.$('#cost-sentence')) ===
    'Nothing drawn yet. Every peso drawn costs 0.98% a month until it is paid back.', text(a.$('#cost-sentence')));
  check('empty schedule', text(a.$('#schedule')) === 'Nothing to pay yet.');

  type(a, a.$('#available'), '17300000');
  check('money input reformats while typing', a.$('#available').value === '17,300,000', a.$('#available').value);
  type(a, a.$('#tiie'), '6.75');
  type(a, a.$('#spread'), '5');
  type(a, a.$('#cushion-amount'), '2,000,000x');
  check('money input keeps digits only', a.$('#cushion-amount').value === '2,000,000', a.$('#cushion-amount').value);
  blur(a);

  a.$('#add-disposition').click();
  let block = a.$('.disp');
  check('new disposition has one empty payment row', a.$$('.pay', block).length === 1);
  check('new disposition defaults to today', a.$('[data-f="date"]', block).value === new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10));
  check('name placeholder', a.$('[data-f="name"]', block).getAttribute('placeholder') === 'Disposition 1');
  check('new disposition focuses its name', a.doc.activeElement === a.$('[data-f="name"]', block));

  const amount = a.$('[data-f="amount"]', block);
  const days = a.$('[data-f="days"]', block);
  const date = a.$('[data-f="date"]', block);
  setValue(a, date, '2026-09-23');
  type(a, amount, '1000000');
  setValue(a, days, '30');
  check('1,000,000 for 30 days costs 9,792', /Interest \$9,792\./.test(text(a.$('.facts', block))), text(a.$('.facts', block)));
  setValue(a, days, '180');
  check('1,000,000 for 180 days costs 58,750', /Interest \$58,750\./.test(text(a.$('.facts', block))), text(a.$('.facts', block)));
  type(a, amount, '6000000');
  setValue(a, days, '120');
  check('6,000,000 for 120 days, facts line',
    text(a.$('.facts', block)) === 'Back to Kapital on Jan 21, 2027. Interest $235,000. Total to pay $6,235,000.', text(a.$('.facts', block)));
  check('cost sentence', text(a.$('#cost-sentence')) ===
    'Paying Kapital back will cost $235,000 in interest. The $6,000,000 we draw becomes $6,235,000 by the time it is repaid.', text(a.$('#cost-sentence')));
  check('big numbers', text(a.$('#big-cushion')) === '$2,000,000' && text(a.$('#big-drawn')) === '$6,000,000' &&
    text(a.$('#big-left')) === '$9,300,000');
  check('drawn label', text(a.$('#big-drawn-label')) === 'drawn from Kapital in 1 disposition', text(a.$('#big-drawn-label')));
  const legend = a.$$('#legend li').map(text).join(' | ');
  check('legend', legend === 'Cushion $2,000,000 | Disposition 1 $6,000,000 | Available $9,300,000', legend);

  const row = a.$('.pay', block);
  type(a, a.$('[data-pf="name"]', row), 'Coffee beans');
  type(a, a.$('[data-pf="amount"]', row), '1000000');
  type(a, a.$('[data-pf="risk"]', row), 'The roaster stops for a month');
  const calc = () => text(a.$('.pay-calc', row));
  check('payment true cost line', calc() === '$1,000,000 paid with this credit really costs $1,039,167, $39,167 of it interest.', calc());
  check('assignment note', text(a.$('.assign-text', block)) === '$5,000,000 not yet assigned to a payment. 1 payment, 0 made ($0 paid).', text(a.$('.assign-text', block)));

  check('brings back hidden until Adds revenue', !row.classList.contains('is-rev'));
  a.$('[data-pf="revenue"]', row).click();
  check('Adds revenue shows brings back', row.classList.contains('is-rev'));
  type(a, a.$('[data-pf="back"]', row), '1500000');
  setValue(a, a.$('[data-pf="backDate"]', row), '2026-12-15');
  check('brings back with net and arrival',
    calc() === '$1,000,000 paid with this credit really costs $1,039,167, $39,167 of it interest. ' +
      'Brings back $1,500,000 on Dec 15, 2026, net $460,833 after interest. Arrives 37 days before Kapital is due.', calc());
  check('net is bold', text(a.$('.pay-calc strong', row)) === '$460,833');
  check('split sentence', text(a.$('#split-sentence')) ===
    'Of what is assigned, $1,000,000 (100%) goes to things that add revenue and $0 to obligations. ' +
    'The revenue payments are expected to bring back $1,500,000, $460,833 more than they cost with interest.', text(a.$('#split-sentence')));
  check('brings back total in gold', text(a.$('#split-sentence .gold')) === '$1,500,000');

  setValue(a, a.$('[data-pf="backDate"]', row), '2027-02-10');
  check('arrives after Kapital is due, red bold', text(a.$('.pay-calc strong.bad', row)) === 'Arrives 20 days after Kapital is due.', calc());
  type(a, a.$('[data-pf="back"]', row), '1000000');
  check('short of its true cost in red', text(a.$('.pay-calc .bad', row)) === 'short by $39,167 of its true cost.', calc());
  check('less than they cost', /\$39,167 less than they cost with interest\.$/.test(text(a.$('#split-sentence'))), text(a.$('#split-sentence')));
  type(a, a.$('[data-pf="back"]', row), '1500000');
  setValue(a, a.$('[data-pf="backDate"]', row), '2026-12-15');

  a.$('[data-pf="paid"]', row).click();
  check('paid row dims', row.classList.contains('is-paid'));
  check('paid appended', /Paid\.$/.test(calc()), calc());
  check('assignment note counts paid', /1 payment, 1 made \(\$1,000,000 paid\)\.$/.test(text(a.$('.assign-text', block))), text(a.$('.assign-text', block)));

  a.$('[data-act="add-pay"]', block).click();
  const row2 = a.$$('.pay', block)[1];
  check('+ Add payment focuses the new name', a.doc.activeElement === a.$('[data-pf="name"]', row2));
  type(a, a.$('[data-pf="name"]', row2), 'Rent');
  type(a, a.$('[data-pf="amount"]', row2), '6000000');
  check('assign bar turns red when over', a.$('.assign-bar', block).classList.contains('over'));
  check('payments exceed note', /^Payments exceed the disposition by \$1,000,000\./.test(text(a.$('.assign-text', block))), text(a.$('.assign-text', block)));
  type(a, a.$('[data-pf="amount"]', row2), '5000000');
  check('fully assigned note', /^Fully assigned\./.test(text(a.$('.assign-text', block))), text(a.$('.assign-text', block)));
  blur(a);

  a.$('#add-disposition').click();
  const block2 = a.$$('.disp')[1];
  setValue(a, a.$('[data-f="date"]', block2), '2026-12-15');
  setValue(a, a.$('[data-f="days"]', block2), '60');
  type(a, a.$('[data-f="amount"]', block2), '10000000');
  check('15 Dec 2026 plus 60 days is 13 Feb 2027', /^Back to Kapital on Feb 13, 2027\./.test(text(a.$('.facts', block2))), text(a.$('.facts', block2)));
  check('over the line warning', !a.$('#over').hidden && text(a.$('#over')) === 'Over the available line by $700,000.', text(a.$('#over')));
  blur(a);

  const rows = a.$$('#schedule tbody tr');
  check('schedule sorted by maturity', rows.length === 2 && /^Jan 21, 2027/.test(text(rows[0])) && /^Feb 13, 2027/.test(text(rows[1])),
    rows.map(text).join(' | '));
  const cells = a.$$('td', rows[0]).map(text).join(' | ');
  check('schedule row values', cells === 'Jan 21, 2027 | Disposition 1 | $6,000,000 | $235,000 | $6,235,000 | ', cells);
  a.$('input[type="checkbox"]', rows[0]).click();
  check('repaid dims the row', a.$$('#schedule tbody tr')[0].classList.contains('is-paid'));
  check('repaid so far', /^Repaid so far \$6,235,000\. Still to pay \$/.test(text(a.$('.schedule-note'))), text(a.$('.schedule-note')));

  // Search
  type(a, a.$('#search'), 'roaster');
  check('search by if we do not pay', text(a.$('#search-count')) === '1 payment matches', text(a.$('#search-count')));
  check('search hides dispositions without matches', a.$$('.disp')[1].hidden && !a.$$('.disp')[0].hidden);
  check('search hides rows without matches', a.$$('.pay', block)[1].hidden && !a.$$('.pay', block)[0].hidden);
  type(a, a.$('#search'), '');
  check('clearing search shows everything', !a.$$('.disp')[1].hidden && !a.$$('.pay', block)[1].hidden && text(a.$('#search-count')) === '');
  blur(a);

  a.$('#hide-all').click();
  check('Hide all payments collapses', a.$$('.disp').every((b) => b.classList.contains('collapsed')));
  check('toggle reads Show payments', text(a.$('[data-act="toggle"]', block)) === 'Show payments');
  a.$('[data-act="toggle"]', block).click();
  check('toggle expands one', !block.classList.contains('collapsed'));
  check('collapsed state lives in localStorage', /"/.test(a.w.localStorage.getItem('kapital.collapsed') || ''));
  a.$('#show-all').click();
  check('Show all payments expands', a.$$('.disp').every((b) => !b.classList.contains('collapsed')));

  await waitSaved(a);
  check('saved status text', /^Saved \d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d{2} (AM|PM)\. Everyone with the code sees this\.$/.test(text(a.$('#status'))), text(a.$('#status')));
  const onServer = await serverRecord();
  check('record reached the server', onServer.data.dispositions.length === 2 && onServer.data.available === 17300000 &&
    onServer.data.dispositions[0].payments[0].back === 1500000, JSON.stringify(onServer.data).slice(0, 300));
  check('collapsed state is not in the record', !JSON.stringify(onServer.data).includes('collapsed'));

  // Summary
  a.$('#copy-summary').click();
  const summary = a.$('#modal-body').value;
  check('summary header', summary.split('\n')[0] === 'AROMARIA, Kapital line, ' + fmtToday(), summary.split('\n')[0]);
  check('summary numbers the payments', /\n1\. Coffee beans, \$1,000,000, really costs \$1,039,167\. Adds revenue\. Brings back \$1,500,000 on Dec 15, 2026, net \$460,833 after interest\./.test(summary), summary);
  check('summary has obligation and if we do not pay', /\n2\. Rent, \$5,000,000, really costs \$5,195,833\. Obligation\./.test(summary) &&
    /If we do not pay: The roaster stops for a month/.test(summary), summary);
  a.$('#modal-primary').click();
  await sleep(50);
  a.$('#modal-close').click();
  check('modal closes', a.$('#modal').hidden);

  a.$('#backup').click();
  const backup = JSON.parse(a.$('#modal-body').value);
  check('backup is the full record', backup.dispositions.length === 2 && backup.cushion.amount === 2000000);
  a.$('#modal-close').click();

  // Remove a payment and a disposition
  a.$('[data-act="remove-pay"]', a.$$('.pay', block)[1]).click();
  check('remove payment', a.$$('.pay', block).length === 1);

  a.$('#clear').click();
  await waitSaved(a, 'clear');
  const cleared = await serverRecord();
  check('clear everything empties the record', cleared.data.dispositions.length === 0 && cleared.data.available === 0 &&
    Object.keys(cleared.data.deleted).length === 2, JSON.stringify(cleared.data));
  check('clear everything empties the screen', a.$$('.disp').length === 0 && a.$('#available').value === '');
  a.w.close();
}

async function testTwoClients() {
  section('4. Two clients');
  const a = openClient('A');
  await waitLoaded(a);

  a.$('#add-disposition').click();
  const blockA = a.$('.disp');
  const id = blockA.getAttribute('data-id');
  type(a, a.$('[data-f="name"]', blockA), 'Harvest');
  type(a, a.$('[data-f="amount"]', blockA), '2000000');
  blur(a);
  await waitSaved(a, 'A add disposition');
  let rec = await serverRecord();
  check('A autosaved the disposition', rec.data.dispositions.length === 1 && rec.data.dispositions[0].name === 'Harvest');

  const b = openClient('B');
  await waitLoaded(b);
  check('B loads the record', text(b.$('#status')) === 'Record loaded. Changes save automatically.', text(b.$('#status')));
  const blockB = b.$('.disp[data-id="' + id + '"]');
  check('B sees the disposition', !!blockB && b.$('[data-f="name"]', blockB).value === 'Harvest');
  b.$('[data-act="add-pay"]', blockB).click();
  const newRow = b.$$('.pay', blockB)[1];
  type(b, b.$('[data-pf="name"]', newRow), 'Pickers');
  type(b, b.$('[data-pf="amount"]', newRow), '400000');
  blur(b);
  await waitSaved(b, 'B add payment');
  rec = await serverRecord();
  check('B saved the payment', rec.data.dispositions[0].payments.some((p) => p.name === 'Pickers'));

  // A is stale. It edits the cushion, gets 409, merges and saves again.
  a.statuses.length = 0;
  type(a, a.$('#cushion-amount'), '3000000');
  type(a, a.$('#cushion-note'), 'Rent and payroll, October to December');
  blur(a);
  await waitSaved(a, 'A cushion');
  check('A got a 409 and saved again', a.statuses.join(',').includes('PUT 409') && /PUT 200$/.test(a.statuses.join(',')), a.statuses.join(','));
  rec = await serverRecord();
  check('server has A\'s cushion', rec.data.cushion.amount === 3000000 && rec.data.cushion.note === 'Rent and payroll, October to December');
  check('server kept B\'s payment', rec.data.dispositions.length === 1 && rec.data.dispositions[0].payments.some((p) => p.name === 'Pickers'),
    JSON.stringify(rec.data.dispositions));
  check('A\'s screen shows B\'s payment', a.$$('.disp[data-id="' + id + '"] [data-pf="name"]').some((i) => i.value === 'Pickers'));

  // A deletes the disposition. B is stale, edits a top field and the deletion is merged on B.
  a.$('[data-act="remove-disp"]', a.$('.disp[data-id="' + id + '"]')).click();
  await waitSaved(a, 'A delete');
  rec = await serverRecord();
  check('A deleted the disposition on the server', rec.data.dispositions.length === 0 && rec.data.deleted[id] > 0);

  b.statuses.length = 0;
  type(b, b.$('#available'), '17300000');
  blur(b);
  await waitSaved(b, 'B available');
  check('B got a 409', b.statuses.join(',').includes('PUT 409'), b.statuses.join(','));
  rec = await serverRecord();
  check('server keeps the deletion', rec.data.dispositions.length === 0, JSON.stringify(rec.data.dispositions));
  check('server has B\'s top field', rec.data.available === 17300000);
  check('B\'s screen dropped the deleted disposition', b.$$('.disp').length === 0);
  // The top fields and the cushion share one timestamp: B's newer edit wins as a whole.
  check('B\'s newer top fields win', rec.data.settingsUpdated > 0 && b.$('#available').value === '17,300,000');

  // A live client (with EventSource) follows along.
  const c = openClient('C', { live: true });
  await waitLoaded(c);

  // Restore replaces the record for everyone.
  const now = Date.now();
  const backup = {
    available: 12000000,
    tiie: 6.75,
    spread: 5,
    cushion: { amount: 1000000, note: 'Payroll' },
    settingsUpdated: now - 1000,
    dispositions: [{
      id: 'restored1', name: 'Restored', amount: 6000000, date: '2026-09-23', days: 120,
      created: now - 5000, updated: now - 5000, repaid: false,
      // an old record: no back, backDate or deleted
      payments: [{ id: 'rp1', name: 'Old supplier', amount: 1000000, risk: 'Late fees', revenue: true, paid: false }]
    }]
  };
  b.$('#restore').click();
  b.$('#modal-body').value = '{"not": "a backup"}';
  b.$('#modal-primary').click();
  check('restore rejects a bad shape', /does not look like/.test(text(b.$('#modal-error'))), text(b.$('#modal-error')));
  b.$('#modal-body').value = JSON.stringify(backup);
  b.$('#modal-primary').click();
  check('restore closes the modal', b.$('#modal').hidden);
  await waitSaved(b, 'B restore');
  rec = await serverRecord();
  check('restore replaces the record', rec.data.available === 12000000 && rec.data.dispositions.length === 1 &&
    rec.data.dispositions[0].id === 'restored1' && rec.data.dispositions[0].updated > now, JSON.stringify(rec.data).slice(0, 400));
  check('old payment gets defaults', rec.data.dispositions[0].payments[0].back === 0 && rec.data.dispositions[0].payments[0].backDate === '');

  await waitFor(() => c.$('.disp[data-id="restored1"]'), 'C live update after restore');
  check('live client shows the restored record', c.$('#available').value === '12,000,000' && c.$$('.disp').length === 1);

  // A disposition being typed in is not replaced on screen.
  const cBlock = c.$('.disp[data-id="restored1"]');
  const cName = c.$('[data-f="name"]', cBlock);
  cName.focus();
  const bBlock = b.$('.disp[data-id="restored1"]');
  type(b, b.$('[data-f="amount"]', bBlock), '7000000');
  blur(b);
  await waitSaved(b, 'B amount');
  await waitFor(() => c.statuses.filter((s) => s === 'GET 200').length >= 3, 'C pulled B\'s change');
  await sleep(100);
  check('focused block is kept on screen', c.$('.disp[data-id="restored1"]') === cBlock && c.$('[data-f="amount"]', cBlock).value === '6,000,000' &&
    c.doc.activeElement === cName);
  cName.blur();
  await waitFor(() => c.$('.disp[data-id="restored1"] [data-f="amount"]').value === '7,000,000', 'C applies the held copy after blur');
  check('held copy applied when focus leaves', true);

  // Brings back and comes back on, checked on B's screen for the restored payment.
  const rRow = b.$('.pay[data-id="rp1"]');
  type(b, b.$('[data-f="amount"]', b.$('.disp[data-id="restored1"]')), '6000000');
  type(b, b.$('[data-pf="back"]', rRow), '1500000');
  setValue(b, b.$('[data-pf="backDate"]', rRow), '2026-12-15');
  check('net after interest', /net \$460,833 after interest\./.test(text(b.$('.pay-calc', rRow))), text(b.$('.pay-calc', rRow)));
  check('arrives before Kapital is due', /Arrives 37 days before Kapital is due\.$/.test(text(b.$('.pay-calc', rRow))), text(b.$('.pay-calc', rRow)));
  setValue(b, b.$('[data-pf="backDate"]', rRow), '2027-02-10');
  check('arrives after Kapital is due', text(b.$('.pay-calc strong.bad', rRow)) === 'Arrives 20 days after Kapital is due.', text(b.$('.pay-calc', rRow)));
  blur(b);
  await waitSaved(b, 'B brings back');
  await waitFor(() => /Arrives 20 days after/.test(text(c.$('.pay[data-id="rp1"] .pay-calc'))), 'C sees brings back');
  check('live client sees the brings back line', true);

  for (const cl of [a, b, c]) {
    if (cl.dom.sources) cl.dom.sources.forEach((s) => s.close());
    cl.w.close();
  }
}

function fmtToday() {
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = new Date();
  return d.getDate() + ' ' + m[d.getMonth()] + ' ' + d.getFullYear();
}

async function testText() {
  section('Text rules');
  const files = ['public/index.html', 'public/app.js', 'public/login.html', 'public/login.js', 'README.md', 'server.js'];
  const bad = files.filter((f) => fs.existsSync(path.join(ROOT, f)) && /[\u2013\u2014]/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  check('no em or en dashes in interface text or docs', bad.length === 0, bad.join(', '));
  const inline = ['public/index.html', 'public/login.html'].filter((f) => /<script(?![^>]*\bsrc=)[^>]*>/i.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  check('no inline scripts', inline.length === 0, inline.join(', '));
}

async function testRateLimit() {
  section('Login limit');
  let last;
  for (let i = 0; i < 21; i++) {
    last = await api('/api/login', {
      auth: false, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'nope' })
    });
  }
  // 2 attempts were made in testAuth, so the limit is hit within this loop.
  check('login attempts are limited to 20 per 15 minutes', last.status === 429, last.status);
}

async function main() {
  console.log('Starting server on port ' + PORT + ' with ' +
    (process.env.TEST_DATABASE_URL ? 'the PostgreSQL store' : 'the file store at ' + DATA_FILE));
  await startServer();
  try {
    await testAuth();
    await testApi();
    await testMath();
    await testTwoClients();
    await testText();
    await testRateLimit();
    section('Console');
    check('no console errors', consoleErrors.length === 0, consoleErrors.join('\n'));
  } catch (err) {
    failures++;
    console.log('  FAIL  ' + (err && err.stack || err));
  } finally {
    windows.forEach((d) => { try { d.window.close(); } catch (_) { /* ignore */ } });
    server.kill('SIGTERM');
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
}

main();
