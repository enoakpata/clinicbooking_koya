const db = require('./db');

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

/**
 * Records one POST /bookings attempt for `email` (already trimmed + lower-cased) in a rolling
 * window, or refuses it. The check-and-insert runs atomically inside Postgres
 * (record_booking_attempt in db.js, serialised per email by an advisory lock), so concurrent
 * attempts can't slip past the limit. Refused (429) attempts are not recorded, so a client that
 * keeps retrying still gets in once the window rolls on.
 *
 * Resolves to {allowed: true} or {allowed: false, retryAfter: <whole seconds, >= 1>}.
 */
async function recordAttempt(email) {
  const { rows } = await db.query('SELECT record_booking_attempt($1, $2, $3) AS wait', [email, MAX_ATTEMPTS, WINDOW_MS]);
  const wait = rows[0].wait;
  if (wait === null) return { allowed: true };
  return { allowed: false, retryAfter: Math.max(1, Math.ceil(Number(wait))) };
}

// The rate-limit bucket for a request body: trimmed + lower-cased email, or null if there is
// no usable email (such requests fail validation and can't be attributed to anyone).
function rateLimitEmail(body) {
  const email = body && typeof body === 'object' ? body.email : undefined;
  if (typeof email !== 'string') return null;
  const clean = email.trim().toLowerCase();
  return clean === '' ? null : clean;
}

module.exports = { recordAttempt, rateLimitEmail, MAX_ATTEMPTS, WINDOW_MS };
