// Database layer. Production uses PostgreSQL via DATABASE_URL (Neon, Supabase, Vercel Postgres, RDS...).
// Without DATABASE_URL (local development, tests) an embedded Postgres (PGlite) stores data under ./data/pgdata.
// Queries are written once, with `?` placeholders, and run unchanged on both.
const path = require('node:path');
const fs = require('node:fs');

const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
let driver; // { exec(sql, params) -> {rows, rowCount}, tx(fn), script(sql), kind }

function connect() {
  if (driver) return driver;
  if ((process.env.DATABASE_URL || process.env.POSTGRES_URL)) {
    const { Pool, types } = require('pg');
    types.setTypeParser(20, (v) => parseInt(v, 10));   // bigint (COUNT, BIGINT columns) -> number
    types.setTypeParser(1700, (v) => parseFloat(v));   // numeric (SUM, AVG) -> number
    const pool = new Pool({
      connectionString: (process.env.DATABASE_URL || process.env.POSTGRES_URL),
      max: Number(process.env.PG_POOL_MAX || 3),       // serverless: keep per-instance connections low, use the provider's pooled URL
      idleTimeoutMillis: 10000, allowExitOnIdle: true,
    });
    const wrap = (c) => ({
      exec: async (sql, params = []) => { const r = await c.query(toPg(sql), params); return { rows: r.rows, rowCount: r.rowCount }; },
      script: (sql) => c.query(sql),
    });
    driver = {
      kind: 'postgres',
      ...wrap(pool),
      async tx(fn) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const out = await fn(wrap(c));
          await c.query('COMMIT');
          return out;
        } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
      },
    };
  } else {
    const mod = '@electric-sql/pglite'; // loaded by name so serverless bundlers never include it
    const { PGlite } = require(mod);
    const dir = process.env.PGLITE_DIR || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'pgdata');
    if (!dir.startsWith('memory://')) fs.mkdirSync(path.dirname(dir), { recursive: true });
    const lite = new PGlite(dir, { parsers: { 20: (v) => parseInt(v, 10), 1700: (v) => parseFloat(v) } });
    const wrap = (c) => ({
      exec: async (sql, params = []) => { const r = await c.query(toPg(sql), params); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; },
      script: (sql) => c.exec(sql),
    });
    driver = {
      kind: 'pglite',
      ...wrap(lite),
      tx: (fn) => lite.transaction((t) => fn(wrap(t))),
    };
  }
  return driver;
}

// Convenience helpers that work both on the shared connection and inside a transaction (pass `t`).
const run = (t) => (t || connect());
const q = async (sql, params, t) => (await run(t).exec(sql, params)).rows;
const one = async (sql, params, t) => (await run(t).exec(sql, params)).rows[0];
const exec = (sql, params, t) => run(t).exec(sql, params);
const tx = (fn) => connect().tx(fn);

// ---------- schema ----------
// Add new versions to the END of this list; each runs once, in order, so existing data is always preserved.
const MIGRATIONS = [`
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee', active INTEGER NOT NULL DEFAULT 1, phone TEXT,
  in_rotation INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL, last_seen BIGINT NOT NULL, ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS buckets (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, UNIQUE(name, source)
);
CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, phone_norm TEXT NOT NULL UNIQUE, email TEXT,
  source TEXT NOT NULL DEFAULT 'other', campaign TEXT, city TEXT, purpose TEXT, property_type TEXT, bhk TEXT,
  budget_min DOUBLE PRECISION, budget_max DOUBLE PRECISION, location_pref TEXT, timeline TEXT, temperature TEXT,
  status TEXT NOT NULL DEFAULT 'new', status_before TEXT,
  bucket_id INTEGER REFERENCES buckets(id) ON DELETE SET NULL,
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  locked_by INTEGER REFERENCES users(id) ON DELETE SET NULL, locked_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, next_action_at TEXT, last_disposition TEXT,
  notes TEXT, extra TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_queue ON leads(assigned_to, status, next_action_at);
CREATE INDEX IF NOT EXISTS idx_leads_bucket ON leads(bucket_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source);
CREATE INDEX IF NOT EXISTS idx_leads_temp ON leads(temperature);
-- the database itself guarantees an employee can hold only ONE lead at a time, even if requests race
CREATE UNIQUE INDEX IF NOT EXISTS one_active_lead_per_employee ON leads(locked_by) WHERE status = 'in_call';
CREATE TABLE IF NOT EXISTS call_sessions (
  id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'dialing_agent', end_reason TEXT, provider_sid TEXT, lead_sid TEXT,
  created_at TEXT NOT NULL, ringing_at TEXT, answered_at TEXT, ended_at TEXT, talk_sec INTEGER DEFAULT 0,
  recording_url TEXT, recording_sec INTEGER
);
CREATE INDEX IF NOT EXISTS idx_call_sessions_user ON call_sessions(user_id, status);
CREATE TABLE IF NOT EXISTS calls (
  id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, agent_name TEXT, disposition TEXT NOT NULL, temperature TEXT, notes TEXT,
  duration_sec INTEGER DEFAULT 0, follow_up_at TEXT, session_id INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls(lead_id);
CREATE INDEX IF NOT EXISTS idx_calls_user ON calls(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_calls_time ON calls(created_at);
CREATE TABLE IF NOT EXISTS audit (
  id SERIAL PRIMARY KEY, ts TEXT NOT NULL, user_id INTEGER, user_name TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT
);
CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, until BIGINT NOT NULL DEFAULT 0, updated BIGINT NOT NULL);
`];

let ready;
function migrate() {
  ready ||= (async () => {
    connect();
    await exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
    const cur = Number((await one("SELECT value FROM settings WHERE key = 'schema_version'"))?.value || 0);
    if (cur >= MIGRATIONS.length) return;
    await tx(async (t) => {
      await exec('SELECT pg_advisory_xact_lock(727274)', [], t); // two cold starts must not migrate at once
      const again = Number((await one("SELECT value FROM settings WHERE key = 'schema_version'", [], t))?.value || 0);
      for (let v = again; v < MIGRATIONS.length; v++) {
        await t.script(MIGRATIONS[v]); // multi-statement DDL
        await exec("INSERT INTO settings (key,value) VALUES ('schema_version',?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [String(v + 1)], t);
      }
    });
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

module.exports = { connect, q, one, exec, tx, migrate, kind: () => connect().kind };
