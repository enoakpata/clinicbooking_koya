const { Pool } = require('pg');

// Created once per process at module load, so warm serverless invocations reuse it.
// Small by default: on Vercel every concurrent request may be its own instance with its own pool,
// and DATABASE_URL should be Neon's POOLED (-pooler) endpoint, which multiplexes them.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 3,
  idleTimeoutMillis: 10_000, // drop idle connections before Neon's proxy does
  connectionTimeoutMillis: 30_000, // fail instead of hanging forever when Neon is unreachable
  query_timeout: 15_000, // a dead connection fails the request instead of hanging for minutes
  keepAlive: true,
});

// Without these, a connection dropped by the server emits an unhandled 'error' and kills the process:
// 'error' on the pool covers idle clients, the per-client listener covers checked-out ones.
pool.on('error', (err) => console.error('idle Postgres client error:', err.message));
pool.on('connect', (client) => client.on('error', (err) => console.error('Postgres client error:', err.message)));

// Errors with a SQLSTATE code came from Postgres itself; anything else (ECONNRESET, ...) is the connection.
const isConnectionError = (err) => !(err && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code));

// The schema lives in src/schema.js and is applied by `npm run migrate`, not at runtime.

async function withTransaction(fn) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    broken = isConnectionError(err);
    if (!broken) await client.query('ROLLBACK').catch(() => { broken = true; });
    throw err;
  } finally {
    client.release(broken); // true = destroy the connection instead of reusing it
  }
}

module.exports = { pool, query: (text, params) => pool.query(text, params), withTransaction, isConnectionError };
