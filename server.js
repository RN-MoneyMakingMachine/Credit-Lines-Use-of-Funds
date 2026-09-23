'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { createStore } = require('./db');

const ACCESS_CODE = process.env.ACCESS_CODE;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!ACCESS_CODE || !SESSION_SECRET) {
  const missing = [!ACCESS_CODE && 'ACCESS_CODE', !SESSION_SECRET && 'SESSION_SECRET'].filter(Boolean);
  console.error(
    'Missing required environment variable' + (missing.length > 1 ? 's' : '') + ': ' + missing.join(', ') + '.\n' +
    'Set ACCESS_CODE (the code people type to open the page) and SESSION_SECRET (a long random string). ' +
    'See .env.example.'
  );
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const LOGIN_LIMIT = 20;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const HEARTBEAT_MS = 25 * 1000;

const store = createStore();
const app = express();

app.disable('x-powered-by');
// Railway (and most hosts) put one proxy in front of the app.
app.set('trust proxy', 1);

// Security headers on every response.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
  );
  next();
});

// ---------- Sessions ----------

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function sign(payload) {
  return b64url(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest());
}

function makeToken() {
  const payload = b64url(JSON.stringify({ exp: Date.now() + SESSION_MS }));
  return payload + '.' + sign(payload);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    if (!(key in out)) {
      try { out[key] = decodeURIComponent(val); } catch (_) { out[key] = val; }
    }
  }
  return out;
}

function validSession(req) {
  const token = readCookies(req).session;
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, sign(payload))) return false;
  try {
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof json.exp === 'number' && json.exp > Date.now();
  } catch (_) {
    return false;
  }
}

function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD || req.secure,
    path: '/'
  };
}

// ---------- Login rate limit (in memory) ----------

const attempts = new Map();

function tooManyAttempts(ip) {
  const now = Date.now();
  let entry = attempts.get(ip);
  if (!entry || now - entry.start > LOGIN_WINDOW_MS) {
    entry = { start: now, count: 0 };
    attempts.set(ip, entry);
  }
  entry.count += 1;
  return entry.count > LOGIN_LIMIT ? Math.ceil((entry.start + LOGIN_WINDOW_MS - now) / 1000) : 0;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of attempts) {
    if (now - entry.start > LOGIN_WINDOW_MS) attempts.delete(ip);
  }
}, LOGIN_WINDOW_MS).unref();

// ---------- Record shape ----------

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNumberish(v) {
  return v === undefined || v === null || v === '' ||
    (typeof v === 'number' && Number.isFinite(v)) ||
    (typeof v === 'string' && v.length < 40);
}

function validShape(data) {
  if (!isObject(data)) return false;
  if (!Array.isArray(data.dispositions)) return false;
  for (const key of ['available', 'tiie', 'spread', 'settingsUpdated']) {
    if (!isNumberish(data[key])) return false;
  }
  if (data.cushion !== undefined && !isObject(data.cushion)) return false;
  if (data.deleted !== undefined && !isObject(data.deleted)) return false;
  for (const d of data.dispositions) {
    if (!isObject(d)) return false;
    if (d.payments !== undefined && !Array.isArray(d.payments)) return false;
    for (const p of d.payments || []) {
      if (!isObject(p)) return false;
    }
  }
  return true;
}

// ---------- Live updates (Server Sent Events) ----------

const sseClients = new Set();

function broadcast(event, payload) {
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n';
  for (const res of sseClients) {
    try { res.write(msg); } catch (_) { /* dropped below */ }
  }
}

setInterval(() => {
  for (const res of sseClients) {
    try { res.write(': heartbeat\n\n'); } catch (_) { /* ignore */ }
  }
}, HEARTBEAT_MS).unref();

// ---------- Public routes ----------

const fileOptions = { cacheControl: false, lastModified: false, etag: false };

app.get('/healthz', (req, res) => {
  res.type('text/plain').send('ok');
});

app.get('/login', (req, res) => {
  if (validSession(req)) return res.redirect('/');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'), fileOptions);
});

app.get('/login.js', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.js'), fileOptions);
});

app.get('/styles.css', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'styles.css'), fileOptions);
});

const jsonBody = express.json({ limit: '4mb' });

app.post('/api/login', jsonBody, (req, res) => {
  const wait = tooManyAttempts(req.ip || 'unknown');
  if (wait) {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  const code = req.body && typeof req.body.code === 'string' ? req.body.code : '';
  if (!code || !safeEqual(code, ACCESS_CODE)) {
    return res.status(401).json({ error: 'That code does not open the record.' });
  }
  res.cookie('session', makeToken(), Object.assign({ maxAge: SESSION_MS }, cookieOptions(req)));
  res.json({ ok: true });
});

// ---------- Everything below requires a session ----------

app.use((req, res, next) => {
  if (validSession(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in.' });
  res.redirect('/login');
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('session', cookieOptions(req));
  res.json({ ok: true });
});

app.get('/api/record', async (req, res, next) => {
  try {
    res.json(await store.get());
  } catch (err) {
    next(err);
  }
});

app.put('/api/record', jsonBody, async (req, res, next) => {
  try {
    const body = req.body;
    if (!isObject(body)) return res.status(400).json({ error: 'Expected {baseVersion, data}.' });
    const baseVersion = Number(body.baseVersion);
    if (!Number.isInteger(baseVersion) || baseVersion < 0) {
      return res.status(400).json({ error: 'baseVersion must be a whole number.' });
    }
    if (!validShape(body.data)) return res.status(400).json({ error: 'The record does not have the expected shape.' });

    const result = await store.save(body.data, baseVersion);
    if (result.conflict) return res.status(409).json({ version: result.version, data: result.data });

    res.json({ version: result.version });
    broadcast('changed', { version: result.version });
  } catch (err) {
    next(err);
  }
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 5000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.use(express.static(PUBLIC_DIR, Object.assign({ index: 'index.html' }, fileOptions)));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.status(404).type('text/plain').send('Not found.');
});

// Errors, including bodies over 4 MB (413) and malformed JSON (400).
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return next(err);
  const message = status === 413 ? 'The record is larger than 4 MB.' :
    status === 400 ? 'The request body is not valid JSON.' : 'Something went wrong on the server.';
  res.status(status).json({ error: message });
});

// ---------- Start ----------

let server;

store.init().then(() => {
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log('Kapital line listening on port ' + PORT + ' (' + store.kind + ' store)');
  });
}).catch((err) => {
  console.error('Could not open the record store:', err.message);
  process.exit(1);
});

function shutdown() {
  for (const res of sseClients) {
    try { res.end(); } catch (_) { /* ignore */ }
  }
  sseClients.clear();
  if (!server) process.exit(0);
  server.close(() => {
    Promise.resolve(store.close && store.close()).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
