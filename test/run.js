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
const LINE_HTML = fs.readFileSync(path.join(ROOT, 'public', 'line.html'), 'utf8');
const HOME_HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const HOME_JS = fs.readFileSync(path.join(ROOT, 'public', 'home.js'), 'utf8');

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

async function serverRecord(line = 'kapital') {
  const res = await api('/api/lines/' + line + '/record');
  return res.json();
}

// ---------- Server ----------

// Data that was already in the Kapital record before lines existed (row / file 'main').
const SEED = {
  available: 5000000, tiie: 6.75, spread: 5, cushion: { amount: 250000, note: 'Seeded' }, settingsUpdated: 1,
  dispositions: [{ id: 'seed1', name: 'Seeded', amount: 1000000, date: '2026-09-23', days: 30, created: 1, updated: 1, repaid: false, payments: [] }]
};

async function seed() {
  if (process.env.TEST_DATABASE_URL) {
    const { Client } = require('pg');
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    await client.query('CREATE TABLE IF NOT EXISTS records (id text primary key, version bigint not null default 0, ' +
      'data jsonb not null, updated_at timestamptz default now())');
    await client.query("DELETE FROM records WHERE id IN ('main', 'banco-azteca')");
    // Test database only: start with no saved versions.
    await client.query('DROP TABLE IF EXISTS record_history');
    await client.query("INSERT INTO records (id, version, data) VALUES ('main', 3, $1)", [JSON.stringify(SEED)]);
    await client.end();
  } else {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ version: 3, data: SEED }));
  }
}

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

function openClient(name, { live = false, page = '/kapital', html = LINE_HTML, script = APP_JS } = {}) {
  const vc = new VirtualConsole();
  vc.on('error', (...args) => consoleErrors.push(name + ': ' + args.join(' ')));
  vc.on('jsdomError', (err) => consoleErrors.push(name + ': ' + (err && err.message)));
  const statuses = [];
  const dom = new JSDOM(html, {
    url: BASE + page,
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
  w.eval(script);
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
  check('/login is public', res.status === 200 && /USE OF FUNDS/.test(await res.text()));

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
  check('front page opens with the cookie', res.status === 200 && /USE OF FUNDS/.test(await res.text()));
  res = await api('/kapital');
  check('Kapital page opens', res.status === 200 && /id="dispositions"/.test(await res.text()));
  res = await api('/banco-azteca');
  check('Banco Azteca page opens', res.status === 200 && /id="dispositions"/.test(await res.text()));
  res = await api('/cash-flow');
  check('Cash flow placeholder opens', res.status === 200 && /Coming soon/.test(await res.text()));
  res = await api('/cash-flow', { auth: false });
  check('Cash flow needs a session', res.status === 302);
  res = await api('/banco-azteca', { auth: false });
  check('signing in returns to the page asked for', res.status === 302 && res.headers.get('location') === '/login?next=%2Fbanco-azteca',
    res.headers.get('location'));
  res = await api('/login?next=%2Fbanco-azteca');
  check('signed in, /login goes on to that page', res.status === 302 && res.headers.get('location') === '/banco-azteca');
  res = await api('/login?next=%2F%2Fevil.example');
  check('login never redirects off the site', res.status === 302 && res.headers.get('location') === '/');
  res = await api('/nope');
  check('unknown page answers 404', res.status === 404);
  res = await api('/api/lines/nope/record');
  check('unknown line answers 404', res.status === 404);
  res = await api('/api/summary', { auth: false });
  check('summary needs a session', res.status === 401);

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

  const put = (body) => api('/api/lines/kapital/record', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body)
  });

  res = await put({ baseVersion: rec.version, data: rec.data });
  const saved = await res.json();
  check('PUT with the current version saves', res.status === 200 && saved.version === rec.version + 1, JSON.stringify(saved));
  await waitFor(() => events.join('').includes('event: changed'), 'changed event');
  check('save broadcasts changed {line, version}', events.join('').includes('data: {"line":"kapital","version":' + saved.version + '}'), events.join(''));
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
  check('asks for the line total', text(a.$('#line-sentence')) === 'Enter the line total to see how much was already in use before this page.',
    text(a.$('#line-sentence')));
  check('line total comes before available today', a.$$('.line-fields .label').map(text).join(' | ') === 'Line total | Available today | TIIE % | Spread %');

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
    text(a.$('.facts', block)) === 'Back to Kapital on Jan 21, 2027. Interest $235,000. Total to pay $6,235,000. ' +
      'Interest is paid monthly: 4 payments of $58,750, the first on Oct 23, 2026, the last with the principal.', text(a.$('.facts', block)));
  check('cost sentence', text(a.$('#cost-sentence')) ===
    'Paying Kapital back will cost $235,000 in interest. The $6,000,000 we draw becomes $6,235,000 by the time it is repaid.', text(a.$('#cost-sentence')));
  check('big numbers', text(a.$('#big-cushion')) === '$2,000,000' && text(a.$('#big-drawn')) === '$6,000,000' &&
    text(a.$('#big-left')) === '$9,300,000');
  check('drawn label', text(a.$('#big-drawn-label')) === 'drawn from Kapital in 1 disposition', text(a.$('#big-drawn-label')));
  const legend = a.$$('#legend li').map(text).join(' | ');
  check('legend', legend === 'Cushion $2,000,000 | Disposition 1 $6,000,000 | Available $9,300,000', legend);

  // Line total: the part of the line already in use before this page.
  type(a, a.$('#limit'), '10000000');
  check('available more than the line total is flagged', a.$('#line-sentence').classList.contains('bad') &&
    text(a.$('#line-sentence')) === 'Available today ($17,300,000) is more than the line total ($10,000,000). Check both numbers.',
    text(a.$('#line-sentence')));
  type(a, a.$('#limit'), '20000000');
  blur(a);
  check('line total sentence', !a.$('#line-sentence').classList.contains('bad') &&
    text(a.$('#line-sentence')) === 'Line total $20,000,000. $2,700,000 of it was already in use before this page, $17,300,000 is available today.',
    text(a.$('#line-sentence')));
  const legend2 = a.$$('#legend li').map(text).join(' | ');
  check('bar shows what was already in use', legend2 === 'Already in use $2,700,000 | Cushion $2,000,000 | Disposition 1 $6,000,000 | Available $9,300,000', legend2);
  check('bar is scaled to the whole line', a.$('#alloc .seg-used').style.width === '13.5%', a.$('#alloc .seg-used').style.width);
  check('still available is unchanged by the line total', text(a.$('#big-left')) === '$9,300,000');

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

  // Set aside part of what comes back to repay the credit
  type(a, a.$('[data-pf="toCredit"]', row), '1600000');
  check('setting aside more than comes back is flagged',
    text(a.$('.pay-calc .bad', row)) === 'Set aside $1,600,000 is more than the $1,500,000 that comes back.', calc());
  type(a, a.$('[data-pf="toCredit"]', row), '750000');
  check('set aside line', /\$750,000 of it is set aside to repay Kapital\./.test(calc()), calc());
  check('safe big number', text(a.$('#big-safe')) === '$750,000');
  check('split sentence gains the safe', /Of what comes back, \$750,000 is set aside to repay the credit\.$/.test(text(a.$('#split-sentence'))),
    text(a.$('#split-sentence')));
  blur(a);

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

  // The payment calendar: monthly interest every 30 days, principal with the last payment.
  const rows = a.$$('#schedule tbody tr');
  check('one row per monthly payment, sorted by date', rows.length === 6 &&
    rows.map((r) => text(a.$('td', r))).join(' | ') === 'Oct 23, 2026 | Nov 22, 2026 | Dec 22, 2026 | Jan 14, 2027 | Jan 21, 2027 | Feb 13, 2027',
    rows.map(text).join(' || '));
  check('monthly interest row', a.$$('td', rows[0]).map(text).join(' | ') === 'Oct 23, 2026 | Disposition 1 | Monthly interest 1 of 4 | $58,750 | ',
    a.$$('td', rows[0]).map(text).join(' | '));
  check('principal row carries the last interest', a.$$('td', rows[4]).map(text).join(' | ') === 'Jan 21, 2027 | Disposition 1 | Principal + last interest | $6,058,750 | ',
    a.$$('td', rows[4]).map(text).join(' | '));
  check('second disposition monthly row', a.$$('td', rows[3]).map(text).join(' | ') === 'Jan 14, 2027 | Disposition 2 | Monthly interest 1 of 2 | $97,917 | ',
    a.$$('td', rows[3]).map(text).join(' | '));
  check('calendar total is the grand total to pay', text(a.$('#schedule tfoot')).includes('$16,430,833'), text(a.$('#schedule tfoot')));
  check('the next payment is highlighted', rows[0].classList.contains('is-next') && !rows[1].classList.contains('is-next'));
  check('next payment line', text(a.$('.next-payment')) === 'Next payment to Kapital: $58,750 on Oct 23, 2026 (Disposition 1).',
    text(a.$('.next-payment')));

  a.$('input[type="checkbox"]', rows[0]).click();
  check('a paid interest payment dims its row', a.$$('#schedule tbody tr')[0].classList.contains('is-paid'));
  check('repaid so far counts the interest payment', /^Repaid so far \$58,750\. Still to pay \$16,372,083\./.test(text(a.$('.schedule-note'))), text(a.$('.schedule-note')));
  check('the highlight moves to the next unpaid payment', a.$$('#schedule tbody tr')[1].classList.contains('is-next'));
  a.$('input[type="checkbox"]', a.$$('#schedule tbody tr')[4]).click();
  check('ticking the principal row marks the disposition repaid', /^Repaid so far \$6,117,500\./.test(text(a.$('.schedule-note'))), text(a.$('.schedule-note')));
  check('schedule shows the repayment safe', text(a.$('.safe-note')) ===
    'The repayment safe holds $750,000 of money on its way back: it covers 7% of the $10,313,333 still to pay.', text(a.$('.safe-note')));

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
    onServer.data.limit === 20000000 &&
    onServer.data.dispositions[0].intPaid['1'] === true && onServer.data.dispositions[0].repaid === true &&
    onServer.data.dispositions[0].payments[0].toCredit === 750000 &&
    onServer.data.dispositions[0].payments[0].back === 1500000, JSON.stringify(onServer.data).slice(0, 300));
  check('collapsed state is not in the record', !JSON.stringify(onServer.data).includes('collapsed'));

  // Summary
  a.$('#copy-summary').click();
  const summary = a.$('#modal-body').value;
  check('summary header', summary.split('\n')[0] === 'AROMARIA, Kapital line, ' + fmtToday(), summary.split('\n')[0]);
  check('summary has the line total', summary.split('\n')[1] === 'Line total $20,000,000. Already in use before this page $2,700,000.', summary.split('\n')[1]);
  check('summary numbers the payments', /\n1\. Coffee beans, \$1,000,000, really costs \$1,039,167\. Adds revenue\. Brings back \$1,500,000 on Dec 15, 2026, net \$460,833 after interest\./.test(summary), summary);
  check('summary has the monthly interest sentence', /Interest paid monthly: 4 payments of \$58,750, the first on Oct 23, 2026, the last with the principal on Jan 21, 2027\./.test(summary), summary);
  check('summary has the next payment', /\nNext payment to Kapital: \$58,750 on Nov 22, 2026\./.test(summary), summary);
  check('summary has the repayment safe', /\nRepayment safe: \$750,000 of what comes back is set aside for the credit, covering 7% of the \$10,313,333 still to pay\./.test(summary), summary);
  check('summary payment shows the set aside', /\$750,000 of it set aside to repay\./.test(summary), summary);
  check('summary has obligation and if we do not pay', /\n2\. Rent, \$5,000,000, really costs \$5,195,833\. Obligation\./.test(summary) &&
    /If we do not pay: The roaster stops for a month/.test(summary), summary);
  a.$('#modal-primary').click();
  await sleep(50);
  a.$('#modal-close').click();
  check('modal closes', a.$('#modal').hidden);

  // Downloads
  check('download links point at this line', a.$('#download-json').getAttribute('href') === '/api/lines/kapital/export.json' &&
    a.$('#download-csv').getAttribute('href') === '/api/lines/kapital/export.csv' && a.$('#download-json').hasAttribute('download'));
  let res = await api('/api/lines/kapital/export.json');
  const exported = await res.json();
  check('backup file downloads as an attachment', /attachment; filename="aromaria-kapital-\d{4}-\d{2}-\d{2}\.json"/.test(res.headers.get('content-disposition') || ''),
    res.headers.get('content-disposition'));
  check('backup file holds the full record', exported.line === 'kapital' && exported.data.dispositions.length === 2 &&
    exported.data.cushion.amount === 2000000);
  res = await api('/api/lines/kapital/export.csv');
  const csvBytes = Buffer.from(await res.arrayBuffer());
  const csv = csvBytes.toString('utf8').replace(/^\uFEFF/, '');
  const csvLines = csv.trim().split('\r\n');
  // The byte order mark tells Excel the file is UTF-8, so accents show correctly.
  check('payments file downloads as CSV for Excel', /text\/csv/.test(res.headers.get('content-type') || '') &&
    csvBytes[0] === 0xEF && csvBytes[1] === 0xBB && csvBytes[2] === 0xBF &&
    /filename="aromaria-kapital-payments-/.test(res.headers.get('content-disposition') || ''));
  check('CSV header', csvLines[0].startsWith('Disposition,Drawn on,Days,Back to Kapital on,Disposition amount'), csvLines[0]);
  check('CSV payment row with true cost, net and set aside', csvLines.some((l) => l.startsWith('Disposition 1,2026-09-23,120,2027-01-21,6000000,235000,Yes,Coffee beans,1000000,Adds revenue,1039167,39167,1500000,2026-12-15,460833,750000,Yes,')),
    csvLines.join('\n'));
  check('CSV text is quoted', csvLines.some((l) => l.endsWith(',The roaster stops for a month')), csvLines.join('\n'));
  check('CSV has the payment calendar', csvLines.includes('When we pay Kapital') && csvLines.includes('Date,Disposition,Payment,Amount,Paid') &&
    csvLines.includes('2026-11-22,Disposition 1,Monthly interest 2 of 4,58750,No') &&
    csvLines.includes('2026-10-23,Disposition 1,Monthly interest 1 of 4,58750,Yes') &&
    csvLines.includes('2027-01-21,Disposition 1,Principal + last interest,6058750,Yes'), csvLines.join('\n'));

  // A payment named like a formula must not run as one in Excel.
  const row2b = a.$$('.pay', block)[1];
  type(a, a.$('[data-pf="name"]', row2b), '=HYPERLINK("x")');
  blur(a);
  await waitSaved(a, 'formula name');
  res = await api('/api/lines/kapital/export.csv');
  check('CSV never starts a cell with a formula', (await res.text()).includes(`"'=HYPERLINK(""x"")"`));

  // History: removing a payment keeps the state before it.
  await waitFor(() => a.$('#history table'), 'history list');
  a.$('[data-act="remove-pay"]', a.$$('.pay', block)[1]).click();
  check('remove payment', a.$$('.pay', block).length === 1);
  await waitSaved(a, 'remove payment');
  res = await api('/api/lines/kapital/history');
  let hist = await res.json();
  check('removal keeps a saved version first', hist.entries[0].reason === 'removal' && hist.entries[0].summary.count === 2, JSON.stringify(hist.entries[0]));
  await waitFor(() => /Before something was removed/.test(text(a.$('#history'))), 'history shows removal');
  check('saved versions list shows the removal', !/null|undefined/.test(text(a.$('#history'))), text(a.$('#history')));

  a.$('#clear').click();
  await waitSaved(a, 'clear');
  const cleared = await serverRecord();
  check('start over empties the record', cleared.data.dispositions.length === 0 && cleared.data.available === 0 &&
    Object.keys(cleared.data.deleted).length === 2, JSON.stringify(cleared.data));
  res = await api('/api/lines/kapital/history');
  hist = await res.json();
  check('start over keeps the previous version', hist.entries[0].reason === 'clear' && hist.entries[0].summary.drawn === 16000000, JSON.stringify(hist.entries[0]));
  res = await api('/api/lines/kapital/history/' + hist.entries[0].hid);
  const kept = await res.json();
  check('saved version holds the full data', kept.data.dispositions.length === 2 && kept.data.available === 17300000);
  res = await api('/api/lines/kapital/history/999999');
  check('unknown saved version answers 404', res.status === 404);
  res = await api('/api/lines/banco-azteca/history');
  check('history is kept per line', (await res.json()).entries.length === 0);

  // Bring it back from the list.
  await waitFor(() => /Before starting over/.test(text(a.$('#history'))), 'history shows start over');
  a.$('#history button[data-act="view"]').click();
  await waitFor(() => !a.$('#modal').hidden, 'view modal');
  check('view shows that version as text', /as it was on/.test(a.$('#modal-body').value) && /Coffee beans/.test(a.$('#modal-body').value),
    a.$('#modal-body').value.slice(0, 200));
  a.$('#modal-primary').click();
  await waitFor(() => a.$$('.disp').length === 2, 'brought back');
  await waitSaved(a, 'bring back');
  const back = await serverRecord();
  check('bring back restores it for everyone', back.data.dispositions.length === 2 && back.data.available === 17300000);
  res = await api('/api/lines/kapital/history');
  hist = await res.json();
  check('bringing back keeps the emptied version too', hist.entries[0].reason === 'restore' && hist.entries[0].summary.count === 0);

  a.$('#clear').click();
  await waitSaved(a, 'clear again');
  check('start over empties the screen', a.$$('.disp').length === 0 && a.$('#available').value === '');
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
  const afterRestore = await (await api('/api/lines/kapital/history')).json();
  check('restore keeps the previous version', afterRestore.entries[0].reason === 'restore', JSON.stringify(afterRestore.entries[0]));

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

async function testSeeded() {
  section('Existing Kapital data');
  let rec = await serverRecord('kapital');
  check('Kapital reads the original record', rec.version === 3 && rec.data.dispositions[0].id === 'seed1', JSON.stringify(rec).slice(0, 200));
  const res = await api('/api/record');
  const old = await res.json();
  check('old /api/record still reads Kapital', old.version === 3 && old.data.cushion.note === 'Seeded');
  const stale = await api('/api/record', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseVersion: 1, data: SEED })
  });
  check('old /api/record still saves to Kapital with version checks', stale.status === 409 && (await stale.json()).version === 3);
  const k = openClient('seeded');
  await waitLoaded(k);
  check('Kapital page shows the existing data', text(k.$('#status')) === 'Record loaded. Changes save automatically.' &&
    k.$('#available').value === '5,000,000' && k.$$('.disp').length === 1, text(k.$('#status')));
  check('Kapital page title', text(k.$('#line-title')) === 'Kapital line' && k.doc.title === 'Kapital line, use of funds');
  check('Kapital headings', k.$$('[data-bank]').every((n) => n.textContent === 'Kapital'));
  check('back link to all funds', k.$('.crumbs a').getAttribute('href') === '/');
  k.w.close();
  // Start the remaining checks from an empty Kapital record.
  const put = await api('/api/lines/kapital/record', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion: 3, data: { available: 0, tiie: 6.75, spread: 5, cushion: { amount: 0, note: '' }, settingsUpdated: 0, dispositions: [], deleted: {} } })
  });
  check('reset Kapital for the next checks', put.status === 200);
}

async function testLines() {
  section('5. Lines');
  const before = await serverRecord('kapital');

  const az = openClient('azteca', { page: '/banco-azteca' });
  await waitLoaded(az);
  check('Banco Azteca starts empty', text(az.$('#status')) === 'Empty record. Changes save automatically.', text(az.$('#status')));
  check('Banco Azteca title', text(az.$('#line-title')) === 'Banco Azteca line' && az.doc.title === 'Banco Azteca line, use of funds');
  check('Banco Azteca headings', text(az.$('#dispositions-section h2')) === '2. Dispositions from Banco Azteca' &&
    text(az.$('#schedule-section h2')) === '3. When we pay Banco Azteca');

  // A live Kapital client must not react to Banco Azteca saves.
  const kLive = openClient('kapital-live', { live: true });
  await waitLoaded(kLive);
  const kGets = () => kLive.statuses.filter((x) => x.startsWith('GET')).length;
  const kGetsBefore = kGets();

  type(az, az.$('#limit'), '12000000');
  type(az, az.$('#available'), '9000000');
  blur(az);
  az.$('#add-disposition').click();
  const block = az.$('.disp');
  setValue(az, az.$('[data-f="date"]', block), '2026-09-23');
  setValue(az, az.$('[data-f="days"]', block), '120');
  type(az, az.$('[data-f="amount"]', block), '6000000');
  check('Banco Azteca facts line', text(az.$('.facts', block)) === 'Back to Banco Azteca on Jan 21, 2027. Interest $235,000. Total to pay $6,235,000. ' +
    'Interest is paid monthly: 4 payments of $58,750, the first on Oct 23, 2026, the last with the principal.', text(az.$('.facts', block)));
  check('Banco Azteca drawn label', text(az.$('#big-drawn-label')) === 'drawn from Banco Azteca in 1 disposition');
  check('Banco Azteca cost sentence', /^Paying Banco Azteca back will cost \$235,000 in interest\./.test(text(az.$('#cost-sentence'))));
  const row = az.$('.pay', block);
  type(az, az.$('[data-pf="amount"]', row), '1000000');
  az.$('[data-pf="revenue"]', row).click();
  type(az, az.$('[data-pf="back"]', row), '1500000');
  setValue(az, az.$('[data-pf="backDate"]', row), '2026-12-15');
  check('arrives before Banco Azteca is due', /Arrives 37 days before Banco Azteca is due\.$/.test(text(az.$('.pay-calc', row))), text(az.$('.pay-calc', row)));
  blur(az);
  await waitSaved(az, 'Azteca');

  const azRec = await serverRecord('banco-azteca');
  check('Banco Azteca saved to its own record', azRec.data.available === 9000000 && azRec.data.dispositions.length === 1);
  const after = await serverRecord('kapital');
  check('Kapital record untouched', after.version === before.version && JSON.stringify(after.data) === JSON.stringify(before.data));
  await sleep(300);
  check('Kapital page ignores Banco Azteca events', kGets() === kGetsBefore, kLive.statuses.join(','));
  check('Kapital page still shows its own data', kLive.$$('.disp').length === before.data.dispositions.length && kLive.$('#available').value !== '9,000,000');

  az.$('#copy-summary').click();
  check('summary names Banco Azteca', az.$('#modal-body').value.split('\n')[0] === 'AROMARIA, Banco Azteca line, ' + fmtToday());
  az.$('#modal-close').click();

  if (!process.env.TEST_DATABASE_URL) {
    check('file store keeps Banco Azteca next to the main file', fs.existsSync(path.join(TMP, 'record-banco-azteca.json')));
  }

  // Front page
  const res = await api('/api/summary');
  const sum = await res.json();
  const k = sum.lines.find((l) => l.id === 'kapital');
  const a = sum.lines.find((l) => l.id === 'banco-azteca');
  check('summary lists both lines', sum.lines.length === 2 && k && a && a.name === 'Banco Azteca');
  check('summary numbers for Banco Azteca', a.available === 9000000 && a.drawn === 6000000 && Math.round(a.interest) === 235000 &&
    a.left === 3000000 && a.count === 1 && a.limit === 12000000 && a.used === 3000000, JSON.stringify(a));
  const kRec = (await serverRecord('kapital')).data;
  const kDrawn = kRec.dispositions.reduce((t, x) => t + x.amount, 0);
  check('summary numbers for Kapital include the cushion', k.available === kRec.available && k.cushion === kRec.cushion.amount &&
    k.drawn === kDrawn && k.left === kRec.available - kRec.cushion.amount - kDrawn, JSON.stringify(k));

  const home = openClient('home', { page: '/', html: HOME_HTML, script: HOME_JS, live: true });
  await waitFor(() => /Open a line/.test(text(home.$('#status'))), 'home loaded');
  const azRow = home.$('.fund[data-line="banco-azteca"]');
  check('front page links to each line', home.$('.fund[data-line="kapital"]').getAttribute('href') === '/kapital' &&
    azRow.getAttribute('href') === '/banco-azteca');
  check('front page shows Banco Azteca numbers', text(azRow.querySelector('[data-num="available"]')) === '$9,000,000' &&
    text(azRow.querySelector('[data-num="drawn"]')) === '$6,000,000' && text(azRow.querySelector('[data-num="left"]')) === '$3,000,000');
  check('summary has the next payment for Banco Azteca', a.next && a.next.amount === 58750 && a.next.date === '2026-10-23', JSON.stringify(a.next));
  check('front page shows the line total', text(azRow.querySelector('[data-num="limit"]')) === '$12,000,000');
  check('front page shows the next payment', home.$$('#next-payments .next-line').some((n) =>
    text(n) === 'Next payment to Banco Azteca: $58,750 on Oct 23, 2026. Interest is paid monthly.'),
    home.$$('#next-payments .next-line').map(text).join(' | '));
  check('front page says when a line total is not set', text(home.$('.fund[data-line="kapital"] [data-num="limit"]')) === 'Not set');
  const cash = home.$('.fund[data-line="cash-flow"]');
  check('Cash flow holds its place, not clickable', cash.tagName === 'DIV' && /Coming soon/.test(text(cash)));
  const fmt = (n) => (Math.round(n) < 0 ? '-$' : '$') + String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const allDrawn = k.drawn + a.drawn;
  const allInterest = k.interest + a.interest;
  const allCount = k.count + a.count;
  check('combined sentence', text(home.$('#combined')) === 'Across both lines we have drawn ' + fmt(allDrawn) + ' in ' + allCount +
    (allCount === 1 ? ' disposition' : ' dispositions') + '. Paying it back will cost ' + fmt(allInterest) + ' in interest, ' +
    fmt(allDrawn + allInterest) + ' in total.', text(home.$('#combined')));

  // The front page follows live changes.
  type(az, az.$('#available'), '9500000');
  blur(az);
  await waitSaved(az, 'Azteca 2');
  await waitFor(() => text(azRow.querySelector('[data-num="available"]')) === '$9,500,000', 'front page live update');
  check('front page updates live', true);

  // The repayment safe reaches the summary and the front page.
  type(az, az.$('[data-pf="toCredit"]', row), '400000');
  blur(az);
  await waitSaved(az, 'Azteca set aside');
  const sum2 = await (await api('/api/summary')).json();
  check('summary carries the safe', sum2.lines.find((l) => l.id === 'banco-azteca').safe === 400000, JSON.stringify(sum2.lines));
  await waitFor(() => /The repayment safe across the lines holds \$400,000\.$/.test(text(home.$('#combined'))), 'front page safe');
  check('front page shows the repayment safe', true);

  // Restore Banco Azteca from a downloaded backup file.
  const file = await (await api('/api/lines/kapital/export.json')).text();
  az.$('#restore').click();
  check('restore offers a file picker', !az.$('#modal-file-row').hidden);
  Object.defineProperty(az.$('#modal-file'), 'files', { value: [new az.w.File([file], 'backup.json', { type: 'application/json' })], configurable: true });
  fire(az, az.$('#modal-file'), 'change');
  await waitFor(() => /Backup file loaded/.test(text(az.$('#modal-error'))), 'file read');
  let asked = '';
  az.w.confirm = (m) => { asked = m; return true; };
  az.$('#modal-primary').click();
  check('restoring a backup from the other line warns first', /^This backup is from Kapital, not Banco Azteca\./.test(asked), asked);
  await waitSaved(az, 'Azteca file restore');
  const fromFile = await serverRecord('banco-azteca');
  const kapitalNow = await serverRecord('kapital');
  check('restore from a file replaces the line', fromFile.data.available === kapitalNow.data.available &&
    fromFile.data.dispositions.length === kapitalNow.data.dispositions.length, JSON.stringify(fromFile.data).slice(0, 200));
  const azHist = await (await api('/api/lines/banco-azteca/history')).json();
  check('file restore keeps the previous Banco Azteca version', azHist.entries[0].reason === 'restore' && azHist.entries[0].summary.available === 9500000,
    JSON.stringify(azHist.entries[0]));

  for (const cl of [az, kLive, home]) {
    if (cl.dom.sources) cl.dom.sources.forEach((x) => x.close());
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
  const files = ['public/index.html', 'public/line.html', 'public/cash-flow.html', 'public/app.js', 'public/home.js',
    'public/login.html', 'public/login.js', 'README.md', 'server.js'];
  const bad = files.filter((f) => fs.existsSync(path.join(ROOT, f)) && /[\u2013\u2014]/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  check('no em or en dashes in interface text or docs', bad.length === 0, bad.join(', '));
  const inline = ['public/index.html', 'public/line.html', 'public/cash-flow.html', 'public/login.html'].filter((f) => /<script(?![^>]*\bsrc=)[^>]*>/i.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
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
  await seed();
  await startServer();
  try {
    await testAuth();
    await testSeeded();
    await testApi();
    await testMath();
    await testTwoClients();
    await testLines();
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
