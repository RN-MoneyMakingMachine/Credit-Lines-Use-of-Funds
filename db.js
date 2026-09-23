'use strict';

// Storage for the single shared record.
// PostgreSQL when DATABASE_URL is set, otherwise a JSON file at DATA_FILE.
// Both stores expose the same interface:
//   init()
//   get()                    -> { version, data }
//   save(data, baseVersion)  -> { conflict: false, version } or { conflict: true, version, data }

const fs = require('fs');
const path = require('path');

const RECORD_ID = 'main';

function emptyRecord() {
  return {
    available: 0,
    tiie: 6.75,
    spread: 5,
    cushion: { amount: 0, note: '' },
    settingsUpdated: 0,
    dispositions: [],
    deleted: {}
  };
}

function pgStore(connectionString) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined
  });

  async function ensureRow(client) {
    await client.query(
      'INSERT INTO records (id, version, data) VALUES ($1, 0, $2) ON CONFLICT (id) DO NOTHING',
      [RECORD_ID, JSON.stringify(emptyRecord())]
    );
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
      await ensureRow(pool);
    },

    async get() {
      let r = await pool.query('SELECT version, data FROM records WHERE id = $1', [RECORD_ID]);
      if (!r.rows.length) {
        await ensureRow(pool);
        r = await pool.query('SELECT version, data FROM records WHERE id = $1', [RECORD_ID]);
      }
      return { version: Number(r.rows[0].version), data: r.rows[0].data };
    },

    async save(data, baseVersion) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await ensureRow(client);
        const r = await client.query('SELECT version, data FROM records WHERE id = $1 FOR UPDATE', [RECORD_ID]);
        const current = Number(r.rows[0].version);
        if (current !== Number(baseVersion)) {
          await client.query('ROLLBACK');
          return { conflict: true, version: current, data: r.rows[0].data };
        }
        const next = current + 1;
        await client.query(
          'UPDATE records SET version = $2, data = $3, updated_at = now() WHERE id = $1',
          [RECORD_ID, next, JSON.stringify(data)]
        );
        await client.query('COMMIT');
        return { conflict: false, version: next };
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw err;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    }
  };
}

function fileStore(file) {
  const target = path.resolve(file);
  let chain = Promise.resolve();

  // Serialize every operation so reads and writes never interleave.
  function run(fn) {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  }

  async function read() {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(target, 'utf8'));
      return {
        version: Number(parsed.version) || 0,
        data: parsed.data && typeof parsed.data === 'object' ? parsed.data : emptyRecord()
      };
    } catch (err) {
      if (err.code === 'ENOENT') return { version: 0, data: emptyRecord() };
      throw err;
    }
  }

  async function write(rec) {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const tmp = target + '.' + process.pid + '.' + Date.now() + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(rec));
    await fs.promises.rename(tmp, target);
  }

  return {
    kind: 'file',

    init() {
      return run(async () => {
        try {
          await fs.promises.access(target);
        } catch (_) {
          await write({ version: 0, data: emptyRecord() });
        }
      });
    },

    get() {
      return run(read);
    },

    save(data, baseVersion) {
      return run(async () => {
        const current = await read();
        if (current.version !== Number(baseVersion)) {
          return { conflict: true, version: current.version, data: current.data };
        }
        const next = current.version + 1;
        await write({ version: next, data });
        return { conflict: false, version: next };
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
