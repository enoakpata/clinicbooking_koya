const express = require('express');
const crypto = require('crypto');
const db = require('../middleware/db');
const { HttpError } = require('../errors');
const { validateNewBooking, parseListQuery, encodeCursor } = require('../validation');
const { withIdempotency, resultFromError } = require('../middleware/idempotency');
const { recordAttempt, rateLimitEmail } = require('../middleware/rateLimit');

const router = express.Router();

const BOOKING_COLUMNS = 'id, slot_id, name, email, status, created_at';

function toBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function send(res, result) {
  if (result.headers) res.set(result.headers);
  res.status(result.status).type('application/json').send(result.text);
}

// Creates a booking. Resolves to {status, text}; client errors become results,
// unexpected errors are thrown (-> 500). With `idem`, the booking and its idempotent
// response are committed in one transaction.
async function createBooking(body, idem) {
  try {
    const { slot_id, name, email } = validateNewBooking(body);
    const slot = await db.query('SELECT start_at <= now() AS started FROM slots WHERE id = $1', [slot_id]);
    if (slot.rowCount === 0) throw new HttpError(404, 'slot not found');
    if (slot.rows[0].started) throw new HttpError(400, 'slot has already started');

    return await db.withTransaction(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO bookings (id, slot_id, name, email, status)
         VALUES ($1, $2, $3, $4, 'confirmed')
         RETURNING ${BOOKING_COLUMNS}`,
        [crypto.randomUUID(), slot_id, name, email],
      );
      const result = { status: 201, text: JSON.stringify(toBooking(rows[0])) };
      if (idem) await idem.storeWith(c, result);
      return result;
    });
  } catch (err) {
    if (err.code === '23505') return resultFromError(new HttpError(409, 'slot already booked')); // partial unique index
    if (err.code === '23503') return resultFromError(new HttpError(404, 'slot not found')); // slot removed by concurrent /reset
    return resultFromError(err);
  }
}

// One real attempt: rate limit (counts failed attempts too), then create.
async function attemptBooking(body, idem) {
  const email = rateLimitEmail(body);
  if (email) {
    const rl = await recordAttempt(email);
    if (!rl.allowed) {
      return {
        status: 429,
        text: JSON.stringify({ error: 'too many booking attempts for this email, try again later' }),
        headers: { 'Retry-After': String(rl.retryAfter) },
      };
    }
  }
  return createBooking(body, idem);
}

// POST /bookings — optional Idempotency-Key header. A replay returns the stored response
// before the rate limiter runs, so it doesn't count as an attempt.
router.post('/bookings', async (req, res, next) => {
  try {
    const key = req.get('Idempotency-Key');
    const result = key
      ? await withIdempotency(key, req.body, (idem) => attemptBooking(req.body, idem))
      : await attemptBooking(req.body);
    send(res, result);
  } catch (err) {
    next(err);
  }
});

// GET /bookings?email=&limit=&cursor= — oldest first, cursor pagination.
router.get('/bookings', async (req, res, next) => {
  try {
    const { email, limit, after } = parseListQuery(req.query);
    const { rows } = await db.query(
      `SELECT ${BOOKING_COLUMNS} FROM bookings
       WHERE email = $1
         AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::text))
       ORDER BY created_at, id
       LIMIT $4`,
      [email, after ? after.createdAt : null, after ? after.id : null, limit + 1],
    );
    const page = rows.slice(0, limit).map(toBooking);
    const last = page[page.length - 1];
    res.json({
      bookings: page,
      next_cursor: rows.length > limit ? encodeCursor(last.created_at, last.id) : null,
    });
  } catch (err) {
    next(err);
  }
});

// GET /bookings/:id
router.get('/bookings/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1`, [
      req.params.id,
    ]);
    if (rows.length === 0) throw new HttpError(404, 'booking not found');
    res.json(toBooking(rows[0]));
  } catch (err) {
    next(err);
  }
});

// DELETE /bookings/:id — cancel. The conditional UPDATE is atomic, so concurrent
// cancels of the same booking yield exactly one 200 and the rest 409.
router.delete('/bookings/:id', async (req, res, next) => {
  try {
    const updated = await db.query(
      `UPDATE bookings SET status = 'cancelled'
       WHERE id = $1 AND status = 'confirmed'
       RETURNING ${BOOKING_COLUMNS}`,
      [req.params.id],
    );
    if (updated.rowCount === 1) return res.status(200).json(toBooking(updated.rows[0]));

    const existing = await db.query('SELECT 1 FROM bookings WHERE id = $1', [req.params.id]);
    if (existing.rowCount === 0) throw new HttpError(404, 'booking not found');
    throw new HttpError(409, 'booking already cancelled');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
