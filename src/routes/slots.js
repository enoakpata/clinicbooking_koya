const express = require('express');
const db = require('../middleware/db');
const { HttpError } = require('../errors');

const router = express.Router();

function isValidDate(s) {
  return typeof s === 'string' && s.trim() !== '' && !Number.isNaN(Date.parse(s));
}

function validateSlots(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.slots)) {
    throw new HttpError(400, 'slots must be an array');
  }
  const seen = new Set();
  for (const s of body.slots) {
    if (!s || typeof s !== 'object') throw new HttpError(400, 'each slot must be an object');
    for (const f of ['id', 'provider', 'start', 'end']) {
      if (typeof s[f] !== 'string' || s[f] === '') {
        throw new HttpError(400, `slot ${f} must be a non-empty string`);
      }
    }
    if (!isValidDate(s.start) || !isValidDate(s.end)) {
      throw new HttpError(400, 'slot start and end must be valid date-times');
    }
    if (seen.has(s.id)) throw new HttpError(400, `duplicate slot id: ${s.id}`);
    seen.add(s.id);
  }
  return body.slots;
}

// POST /reset — delete all bookings, replace all slots, clear idempotency + rate-limit state.
router.post('/reset', async (req, res, next) => {
  try {
    const slots = validateSlots(req.body);
    await db.withTransaction(async (c) => {
      await c.query('TRUNCATE bookings, slots, idempotency_keys, booking_attempts');
      if (slots.length > 0) {
        await c.query(
          `INSERT INTO slots (id, provider, start_raw, end_raw, start_at, end_at)
           SELECT id, provider, s, e, s::timestamptz, e::timestamptz
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(id, provider, s, e)`,
          [
            slots.map((s) => s.id),
            slots.map((s) => s.provider),
            slots.map((s) => s.start),
            slots.map((s) => s.end),
          ],
        );
      }
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    // Postgres couldn't parse a date-time that Date.parse accepted
    if (err.code === '22007' || err.code === '22008') {
      return next(new HttpError(400, 'slot start and end must be valid date-times'));
    }
    next(err);
  }
});

// GET /slots — earliest start first, optional exact provider filter.
router.get('/slots', async (req, res, next) => {
  try {
    const provider = typeof req.query.provider === 'string' ? req.query.provider : null;
    const { rows } = await db.query(
      `SELECT s.id, s.provider, s.start_raw AS start, s.end_raw AS "end",
              NOT EXISTS (
                SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed'
              ) AS available
       FROM slots s
       WHERE ($1::text IS NULL OR s.provider = $1)
       ORDER BY s.start_at, s.id`,
      [provider],
    );
    res.json({ slots: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
