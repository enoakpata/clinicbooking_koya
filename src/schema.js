// Database schema. Applied by `npm run migrate` (scripts/migrate.js), never per request.
// Every statement is idempotent, so re-running the migration is safe.
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
CREATE INDEX IF NOT EXISTS bookings_email_page_idx ON bookings (email, created_at, id);
-- At most one confirmed booking per slot, enforced by Postgres (safe under concurrency).
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_confirmed_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

-- Idempotency-Key state (level 4). Lives only here, never in process memory.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT PRIMARY KEY,
  body_hash   TEXT NOT NULL,
  status_code INT,                  -- NULL while the owning request is still in flight
  response    TEXT,                 -- exact JSON text sent, so replays are byte-identical
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE idempotency_keys ALTER COLUMN response TYPE TEXT USING response::text;

-- Rate-limit attempts (level 5). Lives only here, never in process memory.
CREATE TABLE IF NOT EXISTS booking_attempts (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS booking_attempts_email_idx ON booking_attempts (email, attempted_at);

-- Rate limit in one round trip. The per-email advisory lock serialises count-then-insert and is
-- transaction-scoped (released when this statement's transaction ends), so it works through
-- Neon's PgBouncer pooler in transaction mode and waiting requests don't pin connections.
-- Returns NULL if allowed, else seconds until a slot frees. (plpgsql statements in a volatile
-- function each take a fresh snapshot, so the count sees attempts committed by the previous holder.)
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

async function migrate(pool) {
  await pool.query(SCHEMA);
}

module.exports = { SCHEMA, migrate };
