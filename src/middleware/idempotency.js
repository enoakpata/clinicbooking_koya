const crypto = require('crypto');
const db = require('./db');
const { HttpError } = require('../errors');

const MAX_KEY_LENGTH = 255;
const WAIT_TIMEOUT_MS = 10_000; // how long a duplicate waits for the in-flight original
const POLL_MS = 100;
const STALE_CLAIM_MS = 30_000; // claim with no response this old = owner crashed; take it over

// Canonical JSON: object keys sorted recursively, so key order / whitespace don't change the hash.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function hashBody(body) {
  return crypto.createHash('sha256').update(canonical(body)).digest('hex');
}

function shouldStore(status) {
  return status !== 429 && status < 500;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `handler` at most once per Idempotency-Key.
 * handler() resolves to {status, text, headers?} (text = the exact JSON body sent).
 *
 * 1. Insert-claim the key row (ON CONFLICT DO NOTHING). Whoever inserts owns the key.
 * 2. Owner runs the handler, then stores status + exact response text,
 *    or deletes the claim for 429/5xx/crash so the request can be retried.
 * 3. Anyone else: different body hash -> 422; stored response -> replay it;
 *    still in flight -> poll until stored (or the claim is released, then try to claim).
 */
async function withIdempotency(key, body, handler) {
  if (key.length > MAX_KEY_LENGTH) {
    return errorResult(400, `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters`);
  }
  const bodyHash = hashBody(body);
  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  for (;;) {
    const claim = await db.query(
      `INSERT INTO idempotency_keys (key, body_hash) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING RETURNING key`,
      [key, bodyHash],
    );

    if (claim.rowCount === 1) return runAsOwner(key, handler);

    const { rows } = await db.query(
      `SELECT body_hash, status_code, response,
              created_at < now() - ($2::int * interval '1 millisecond') AS stale
       FROM idempotency_keys WHERE key = $1`,
      [key, STALE_CLAIM_MS],
    );
    if (rows.length === 0) continue; // owner released the claim between our two queries; try again

    const row = rows[0];
    if (row.body_hash !== bodyHash) {
      return errorResult(422, 'Idempotency-Key was already used with a different request body');
    }
    if (row.status_code !== null) return { status: row.status_code, text: row.response };

    if (row.stale) {
      await db.query('DELETE FROM idempotency_keys WHERE key = $1 AND status_code IS NULL', [key]);
      continue;
    }
    if (Date.now() >= deadline) {
      return errorResult(409, 'a request with this Idempotency-Key is still in progress');
    }
    await sleep(POLL_MS);
  }
}

const STORE_SQL = 'UPDATE idempotency_keys SET status_code = $2, response = $3 WHERE key = $1';

// The handler receives `idem`. A handler that changes data (creating a booking) calls
// idem.storeWith(client, result) inside its own transaction, so the booking and its stored
// response commit together: a booking can never exist without its replayable response.
async function runAsOwner(key, handler) {
  const idem = {
    stored: false,
    async storeWith(client, result) {
      await client.query(STORE_SQL, [key, result.status, result.text]);
      idem.stored = true;
    },
  };
  let result;
  try {
    result = await handler(idem);
  } catch (err) {
    await releaseClaim(key); // only deletes an unfinished claim; a committed response is kept
    throw err;
  }
  if (!shouldStore(result.status)) {
    await releaseClaim(key);
  } else if (!idem.stored) {
    await storeWithRetry(key, result);
  }
  return result;
}

// For results that changed nothing (400/404/409): retry transient connection errors.
async function storeWithRetry(key, result, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      await db.query(STORE_SQL, [key, result.status, result.text]);
      return;
    } catch (err) {
      if (i >= attempts || !db.isConnectionError(err)) {
        await releaseClaim(key);
        throw err;
      }
      await sleep(100 * i);
    }
  }
}

async function releaseClaim(key) {
  await db.query('DELETE FROM idempotency_keys WHERE key = $1 AND status_code IS NULL', [key]).catch((e) => {
    console.error('failed to release idempotency claim', e);
  });
}

function errorResult(status, message) {
  return { status, text: JSON.stringify({ error: message }) };
}

// Turns a thrown HttpError into a response result; rethrows anything else (-> 500, not stored).
function resultFromError(err) {
  if (err instanceof HttpError) return errorResult(err.status, err.message);
  throw err;
}

module.exports = { withIdempotency, errorResult, resultFromError, hashBody, canonical };
