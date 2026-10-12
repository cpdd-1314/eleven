'use strict'

const { Pool } = require('pg')

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  console.error('[db] 缺少环境变量 DATABASE_URL，无法连接数据库。')
}

// Render 内部连接串（*.internal）走内网，不需要 SSL；
// 外部连接串（本地直连 / 跨区连接）通常需要 SSL。
const isInternal = /\.internal[:/]/.test(connectionString || '') ||
  /(?:^|@)(localhost|127\.0\.0\.1)/.test(connectionString || '')

const pool = new Pool({
  connectionString,
  ssl: isInternal ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
})

pool.on('error', (err) => {
  console.error('[db] 连接池错误：', err.message)
})

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      rate        NUMERIC(10, 4) NOT NULL DEFAULT 30,
      allowance   NUMERIC(12, 2) NOT NULL DEFAULT 0,
      deduction   NUMERIC(12, 2) NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id            TEXT PRIMARY KEY,
      fingerprint   TEXT NOT NULL,
      order_date    TEXT NOT NULL,
      boss          TEXT NOT NULL DEFAULT '',
      companions    JSONB NOT NULL DEFAULT '[]'::jsonb,
      project       TEXT NOT NULL DEFAULT '',
      gift          TEXT NOT NULL DEFAULT '',
      unit_price    NUMERIC(12, 2) NOT NULL DEFAULT 0,
      quantity      NUMERIC(12, 2) NOT NULL DEFAULT 0,
      amount        NUMERIC(12, 2) NOT NULL DEFAULT 0,
      stage_manager TEXT NOT NULL DEFAULT '',
      allocations   JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS orders_date_idx ON orders (order_date);
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS orders_fingerprint_idx ON orders (fingerprint);
  `)

  // 版本号：任何写操作都会 +1，前端靠它判断是否需要重新拉数据
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_meta (
      id         INTEGER PRIMARY KEY,
      revision   BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)

  await pool.query(`
    INSERT INTO sync_meta (id, revision) VALUES (1, 0)
    ON CONFLICT (id) DO NOTHING;
  `)
}

async function getRevision() {
  const { rows } = await pool.query('SELECT revision FROM sync_meta WHERE id = 1')
  return rows.length ? Number(rows[0].revision) : 0
}

async function bumpRevision() {
  const { rows } = await pool.query(`
    UPDATE sync_meta
       SET revision = revision + 1, updated_at = now()
     WHERE id = 1
    RETURNING revision
  `)
  return rows.length ? Number(rows[0].revision) : 0
}

module.exports = { pool, ensureSchema, getRevision, bumpRevision }
