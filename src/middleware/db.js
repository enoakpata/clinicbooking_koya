const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 20,
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

// Schema is created on startup (idempotent). Tables for later levels are
// created here too so /reset can always clear them.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (
  id        TEXT PRIMARY KEY,
  provider  TEXT NOT NULL,
  start_raw TEXT NOT NULL,          -- exact string received, returned unchanged
  end_raw   TEXT NOT NULL,
  start_at  TIMESTAMPTZ NOT NULL,   -- for sorting / comparing
  end_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS slots_start_idx ON slots (start_at, id);

CREATE TABLE IF NOT EXISTS bookings (
  id         TEXT PRIMARY KEY,
  slot_id    TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp())
);
CREATE INDEX IF NOT EXISTS bookings_slot_idx ON bookings (slot_id);
-- At most one confirmed booking per slot, enforced by Postgres (safe under concurrency).
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_confirmed_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT PRIMARY KEY,
  body_hash   TEXT NOT NULL,
  status_code INT,
  response    TEXT,                 -- exact JSON text sent, so replays are byte-identical
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE idempotency_keys ALTER COLUMN response TYPE TEXT USING response::text;
CREATE INDEX IF NOT EXISTS bookings_email_page_idx ON bookings (email, created_at, id);

CREATE TABLE IF NOT EXISTS booking_attempts (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS booking_attempts_email_idx ON booking_attempts (email, attempted_at);

-- Rate limit in one round trip. The per-email advisory lock serialises count-then-insert and is
-- held only inside the database (released when this statement's transaction ends), so waiting
-- requests don't pin pool connections. Returns NULL if allowed, else seconds until a slot frees.
-- (plpgsql statements in a volatile function each take a fresh snapshot, so the count sees
-- attempts committed by whoever held the lock before us.)
CREATE OR REPLACE FUNCTION record_booking_attempt(p_email TEXT, p_max INT, p_window_ms INT)
RETURNS DOUBLE PRECISION LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  n INT;
  wait DOUBLE PRECISION;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('booking-attempts:' || p_email, 0));
  DELETE FROM booking_attempts
   WHERE email = p_email AND attempted_at <= clock_timestamp() - p_window_ms * interval '1 millisecond';
  SELECT count(*), EXTRACT(EPOCH FROM (min(attempted_at) + p_window_ms * interval '1 millisecond' - clock_timestamp()))
    INTO n, wait
    FROM booking_attempts WHERE email = p_email;
  IF n >= p_max THEN
    RETURN wait;
  END IF;
  INSERT INTO booking_attempts (email) VALUES (p_email);
  RETURN NULL;
END
$fn$;
`;

async function init() {
  await pool.query(SCHEMA);
}

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

module.exports = { pool, query: (text, params) => pool.query(text, params), init, withTransaction, isConnectionError };
