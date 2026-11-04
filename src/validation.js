const { HttpError } = require('./errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// Validates a POST /bookings body. Returns normalised {slot_id, name, email}
// (name/email trimmed, email lower-cased). Throws HttpError(400) otherwise.
function validateNewBooking(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'request body must be a JSON object');
  }
  const { slot_id, name, email } = body;
  if (!isNonEmptyString(slot_id)) throw new HttpError(400, 'slot_id is required and must be a non-empty string');
  if (!isNonEmptyString(name)) throw new HttpError(400, 'name is required and must be a non-empty string');
  if (!isNonEmptyString(email)) throw new HttpError(400, 'email is required and must be a non-empty string');

  const cleanName = name.trim();
  const cleanEmail = email.trim().toLowerCase();
  if (cleanName.length > 200) throw new HttpError(400, 'name is too long');
  if (cleanEmail.length > 254 || !EMAIL_RE.test(cleanEmail)) throw new HttpError(400, 'email is invalid');

  return { slot_id, name: cleanName, email: cleanEmail };
}

// ----- GET /bookings query -----

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function parseLimit(raw) {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new HttpError(400, `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  const n = Number(raw);
  if (n < 1 || n > MAX_LIMIT) throw new HttpError(400, `limit must be an integer from 1 to ${MAX_LIMIT}`);
  return n;
}

// Opaque cursor: base64url("<created_at ISO>|<id>") of the last booking on the page.
function encodeCursor(createdAt, id) {
  return Buffer.from(`${new Date(createdAt).toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw) {
  const invalid = () => new HttpError(400, 'invalid cursor');
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid();
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== raw) throw invalid(); // not canonical base64url
  const sep = decoded.indexOf('|');
  if (sep < 1) throw invalid();
  const iso = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  const d = new Date(iso);
  if (!id || Number.isNaN(d.getTime()) || d.toISOString() !== iso) throw invalid();
  return { createdAt: iso, id };
}

function parseListQuery(query) {
  const { email, limit, cursor } = query;
  if (!isNonEmptyString(email)) throw new HttpError(400, 'email is required');
  return {
    email: email.trim().toLowerCase(),
    limit: parseLimit(limit),
    after: cursor === undefined || cursor === '' ? null : decodeCursor(cursor),
  };
}

module.exports = { validateNewBooking, isNonEmptyString, parseLimit, parseListQuery, encodeCursor, decodeCursor };
