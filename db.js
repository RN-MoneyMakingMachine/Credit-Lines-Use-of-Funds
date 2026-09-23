'use strict';

// Storage for the shared records, one per credit line, plus their history.
// PostgreSQL when DATABASE_URL is set, otherwise JSON files next to DATA_FILE.
// Both stores expose the same interface:
//   init()
//   get(id)                            -> { version, data }
//   save(id, data, baseVersion, opts)  -> { conflict: false, version, snapshot } or { conflict: true, version, data }
//   historyList(id, limit, before)     -> { entries: [{ hid, version, savedAt, createdAt, reason, summary }], more }
//   historyGet(id, hid)                -> { hid, version, savedAt, createdAt, reason, summary, data } or null
// Each credit line has its own record id. The first line (Kapital) uses the id 'main'.
// A record that does not exist yet is created empty on first use.
//
// History: when a save replaces a record, the state being replaced is kept as a snapshot if
//   opts.reason is set ('restore' or 'clear'), or
//   opts.mustSnapshot(previousData, newData) says so (for example a disposition was removed), or
//   the last snapshot of that record is older than opts.everyMs.
// Only the newest opts.keep snapshots per record are kept.

const fs = require('fs');
const path = require('path');

const MAIN_ID = 'main';
const DEFAULT_EVERY_MS = 10 * 60 * 1000;
const DEFAULT_KEEP = 500;

function emptyRecord() {
  return {
    limit: 0,
    available: 0,
    tiie: 6.75,
    spread: 5,
    cushion: { amount: 0, note: '' },
    settingsUpdated: 0,
    dispositions: [],
    deleted: {}
  };
}

// Returns null when no snapshot is needed, otherwise why it is kept:
// 'restore', 'clear', 'removal' or '' (the regular copy every few minutes).
function snapshotReason(prev, data, lastCreatedAt, opts, now) {
  if (!prev || prev.version <= 0) return null;
  if (opts.reason) return opts.reason;
  if (opts.mustSnapshot && opts.mustSnapshot(prev.data, data)) return 'removal';
  if (!lastCreatedAt) return '';
  const every = typeof opts.everyMs === 'number' ? opts.everyMs : DEFAULT_EVERY_MS;
  return now - lastCreatedAt >= every ? '' : null;
}

function summaryOf(opts, data) {
  try {
    return opts.summarize ? opts.summarize(data) : {};
  } catch (_) {
    return {};
  }
}

function time(v) {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : Number(v);
  return Number.isFinite(t) ? t : null;
}

function pgStore(connectionString) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined
  });

  async function ensureRow(client, id) {
    await client.query(
      'INSERT INTO records (id, version, data) VALUES ($1, 0, $2) ON CONFLICT (id) DO NOTHING',
      [id, JSON.stringify(emptyRecord())]
    );
  }

  function entry(row, withData) {
    const e = {
      hid: Number(row.hid),
      version: Number(row.version),
      savedAt: time(row.saved_at),
      createdAt: time(row.created_at),
      reason: row.reason || '',
      summary: row.summary || {}
    };
    if (withData) e.data = row.data;
    return e;
  }

  return {
    kind: 'postgres',

    async init() {
      await pool.query(
        'CREATE TABLE IF NOT EXISTS records (' +
          'id text primary key, ' +
          'version bigint not null default 0, ' +
          'data jsonb not null, ' +
          'updated_at timestamptz default now())'
      );
      await pool.query(
        'CREATE TABLE IF NOT EXISTS record_history (' +
          'hid bigserial primary key, ' +
          'record_id text not null, ' +
          'version bigint not null, ' +
          'data jsonb not null, ' +
          "summary jsonb not null default '{}'::jsonb, " +
          "reason text not null default '', " +
          'saved_at timestamptz, ' +
          'created_at timestamptz not null default now())'
      );
      await pool.query(
        'CREATE INDEX IF NOT EXISTS record_history_record_idx ON record_history (record_id, hid DESC)'
      );
      await ensureRow(pool, MAIN_ID);
    },

    async get(id) {
      let r = await pool.query('SELECT version, data FROM records WHERE id = $1', [id]);
      if (!r.rows.length) {
        await ensureRow(pool, id);
        r = await pool.query('SELECT version, data FROM records WHERE id = $1', [id]);
      }
      return { version: Number(r.rows[0].version), data: r.rows[0].data };
    },

    async save(id, data, baseVersion, opts = {}) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await ensureRow(client, id);
        const r = await client.query(
          'SELECT version, data, updated_at FROM records WHERE id = $1 FOR UPDATE',
          [id]
        );
        const prev = { version: Number(r.rows[0].version), data: r.rows[0].data, updatedAt: time(r.rows[0].updated_at) };
        if (prev.version !== Number(baseVersion)) {
          await client.query('ROLLBACK');
          return { conflict: true, version: prev.version, data: prev.data };
        }

        const last = await client.query(
          'SELECT created_at FROM record_history WHERE record_id = $1 ORDER BY hid DESC LIMIT 1',
          [id]
        );
        const lastCreatedAt = last.rows.length ? time(last.rows[0].created_at) : null;
        let snapshot = false;
        const why = snapshotReason(prev, data, lastCreatedAt, opts, Date.now());
        if (why !== null) {
          await client.query(
            'INSERT INTO record_history (record_id, version, data, summary, reason, saved_at) ' +
              'VALUES ($1, $2, $3, $4, $5, $6)',
            [id, prev.version, JSON.stringify(prev.data), JSON.stringify(summaryOf(opts, prev.data)),
              why, prev.updatedAt ? new Date(prev.updatedAt) : null]
          );
          const keep = opts.keep || DEFAULT_KEEP;
          await client.query(
            'DELETE FROM record_history WHERE record_id = $1 AND hid < (' +
              'SELECT hid FROM record_history WHERE record_id = $1 ORDER BY hid DESC OFFSET $2 LIMIT 1)',
            [id, keep - 1]
          );
          snapshot = true;
        }

        const next = prev.version + 1;
        await client.query(
          'UPDATE records SET version = $2, data = $3, updated_at = now() WHERE id = $1',
          [id, next, JSON.stringify(data)]
        );
        await client.query('COMMIT');
        return { conflict: false, version: next, snapshot };
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw err;
      } finally {
        client.release();
      }
    },

    async historyList(id, limit, before) {
      const r = await pool.query(
        'SELECT hid, version, summary, reason, saved_at, created_at FROM record_history ' +
          'WHERE record_id = $1 AND ($2::bigint IS NULL OR hid < $2) ORDER BY hid DESC LIMIT $3',
        [id, before || null, limit + 1]
      );
      return { entries: r.rows.slice(0, limit).map((row) => entry(row, false)), more: r.rows.length > limit };
    },

    async historyGet(id, hid) {
      const r = await pool.query(
        'SELECT hid, version, data, summary, reason, saved_at, created_at FROM record_history ' +
          'WHERE record_id = $1 AND hid = $2',
        [id, hid]
      );
      return r.rows.length ? entry(r.rows[0], true) : null;
    },

    async close() {
      await pool.end();
    }
  };
}

function fileStore(file) {
  const mainFile = path.resolve(file);
  const dir = path.dirname(mainFile);
  let chain = Promise.resolve();

  // 'main' keeps DATA_FILE as it always was; other records sit next to it.
  function fileFor(id) {
    if (id === MAIN_ID) return mainFile;
    return path.join(dir, 'record-' + id + '.json');
  }

  function historyFileFor(id) {
    return path.join(dir, 'history-' + id + '.json');
  }

  // Serialize every operation so reads and writes never interleave.
  function run(fn) {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  }

  async function read(target) {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(target, 'utf8'));
      return {
        version: Number(parsed.version) || 0,
        data: parsed.data && typeof parsed.data === 'object' ? parsed.data : emptyRecord(),
        updatedAt: time(parsed.updatedAt)
      };
    } catch (err) {
      if (err.code === 'ENOENT') return { version: 0, data: emptyRecord(), updatedAt: null };
      throw err;
    }
  }

  async function readHistory(id) {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(historyFileFor(id), 'utf8'));
      return {
        next: Number(parsed.next) || 1,
        entries: Array.isArray(parsed.entries) ? parsed.entries : []
      };
    } catch (err) {
      if (err.code === 'ENOENT') return { next: 1, entries: [] };
      throw err;
    }
  }

  async function write(target, rec) {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const tmp = target + '.' + process.pid + '.' + Date.now() + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(rec));
    await fs.promises.rename(tmp, target);
  }

  function entry(e, withData) {
    const out = {
      hid: e.hid, version: e.version, savedAt: e.savedAt || null, createdAt: e.createdAt,
      reason: e.reason || '', summary: e.summary || {}
    };
    if (withData) out.data = e.data;
    return out;
  }

  return {
    kind: 'file',

    init() {
      return run(async () => {
        try {
          await fs.promises.access(mainFile);
        } catch (_) {
          await write(mainFile, { version: 0, data: emptyRecord() });
        }
      });
    },

    get(id) {
      return run(async () => {
        const rec = await read(fileFor(id));
        return { version: rec.version, data: rec.data };
      });
    },

    save(id, data, baseVersion, opts = {}) {
      return run(async () => {
        const target = fileFor(id);
        const prev = await read(target);
        if (prev.version !== Number(baseVersion)) {
          return { conflict: true, version: prev.version, data: prev.data };
        }
        const now = Date.now();
        const history = await readHistory(id);
        const lastCreatedAt = history.entries.length ? history.entries[0].createdAt : null;
        let snapshot = false;
        const why = snapshotReason(prev, data, lastCreatedAt, opts, now);
        if (why !== null) {
          history.entries.unshift({
            hid: history.next,
            version: prev.version,
            data: prev.data,
            summary: summaryOf(opts, prev.data),
            reason: why,
            savedAt: prev.updatedAt,
            createdAt: now
          });
          history.next += 1;
          history.entries = history.entries.slice(0, opts.keep || DEFAULT_KEEP);
          // History first: if the record write fails, the old state is still kept.
          await write(historyFileFor(id), history);
          snapshot = true;
        }
        const next = prev.version + 1;
        await write(target, { version: next, data, updatedAt: now });
        return { conflict: false, version: next, snapshot };
      });
    },

    historyList(id, limit, before) {
      return run(async () => {
        const history = await readHistory(id);
        const list = history.entries.filter((e) => !before || e.hid < before);
        return { entries: list.slice(0, limit).map((e) => entry(e, false)), more: list.length > limit };
      });
    },

    historyGet(id, hid) {
      return run(async () => {
        const history = await readHistory(id);
        const found = history.entries.find((e) => e.hid === hid);
        return found ? entry(found, true) : null;
      });
    },

    async close() {
      await chain;
    }
  };
}

function createStore() {
  if (process.env.DATABASE_URL) return pgStore(process.env.DATABASE_URL);
  return fileStore(process.env.DATA_FILE || './data/record.json');
}

module.exports = { createStore, emptyRecord };
