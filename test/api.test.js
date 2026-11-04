// Integration tests against a real Postgres database.
// Uses TEST_DATABASE_URL if set, otherwise DATABASE_URL. WARNING: tests call /reset, which wipes data.
require('dotenv').config();
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
// Production uses a pool of 3 per serverless instance (concurrent requests land on separate
// instances). This test process serves all 20 concurrent requests itself, so give it more.
process.env.PG_POOL_MAX = process.env.PG_POOL_MAX || '10';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/middleware/db');
const { migrate } = require('../src/schema');
const app = require('../src/app');

let server;
let base;

const KEY = process.env.API_KEY;

// Sends X-API-Key by default; pass {'X-API-Key': null} to omit it.
async function call(method, path, body, headers = {}) {
  const h = {
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    'X-API-Key': KEY,
    ...headers,
  };
  for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
  const res = await fetch(base + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, body: json, text, headers: res.headers };
}

const SLOTS = [
  { id: 's3', provider: 'Dr Bello', start: '2026-12-11T09:00:00Z', end: '2026-12-11T09:30:00Z' },
  { id: 's1', provider: 'Dr Ade', start: '2026-12-10T09:00:00Z', end: '2026-12-10T09:30:00Z' },
  { id: 's2', provider: 'Dr Ade', start: '2026-12-10T10:00:00+01:00', end: '2026-12-10T10:30:00+01:00' }, // = 09:00Z, tie with s1
  { id: 'past', provider: 'Dr Ade', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' },
  { id: 's4', provider: 'Dr Ade', start: '2026-12-10T08:00:00.000Z', end: '2026-12-10T08:30:00.000Z' },
];

before(async () => {
  await migrate(db.pool);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await db.pool.end();
});

beforeEach(async () => {
  const r = await call('POST', '/reset', { slots: SLOTS });
  assert.equal(r.status, 200);
});

// ---------- Level 1: /reset ----------

test('POST /reset returns 200 and replaces all slots (past included)', async () => {
  const r = await call('POST', '/reset', { slots: [SLOTS[3]] });
  assert.equal(r.status, 200);
  const s = await call('GET', '/slots');
  assert.deepEqual(s.body.slots.map((x) => x.id), ['past']);
});

test('POST /reset deletes all bookings', async () => {
  const b = await call('POST', '/bookings', { slot_id: 's1', name: 'Ada', email: 'ada@example.com' });
  assert.equal(b.status, 201);
  await call('POST', '/reset', { slots: SLOTS });
  assert.equal((await call('GET', `/bookings/${b.body.id}`)).status, 404);
  const s = await call('GET', '/slots');
  assert.ok(s.body.slots.every((x) => x.available === true));
});

test('POST /reset with empty slots list empties everything', async () => {
  assert.equal((await call('POST', '/reset', { slots: [] })).status, 200);
  assert.deepEqual((await call('GET', '/slots')).body, { slots: [] });
});

test('POST /reset with invalid body returns 400 {"error"} and keeps existing data', async () => {
  for (const bad of [{}, { slots: 'x' }, { slots: [{ id: 'a' }] },
    { slots: [{ id: 'a', provider: 'p', start: 'nope', end: 'nope' }] },
    { slots: [SLOTS[0], SLOTS[0]] }]) {
    const r = await call('POST', '/reset', bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(typeof r.body.error, 'string');
  }
  assert.equal((await call('GET', '/slots')).body.slots.length, SLOTS.length);
});

// ---------- Level 1: GET /slots ----------

test('GET /slots returns {"slots"} earliest start first with exact strings and available flag', async () => {
  const r = await call('GET', '/slots');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.deepEqual(r.body.slots.map((s) => s.id), ['past', 's4', 's1', 's2', 's3']);
  const s2 = r.body.slots.find((s) => s.id === 's2');
  assert.deepEqual(s2, { ...SLOTS[2], available: true }); // strings returned unchanged
  const s4 = r.body.slots.find((s) => s.id === 's4');
  assert.equal(s4.start, '2026-12-10T08:00:00.000Z');
});

test('GET /slots?provider= is an exact match', async () => {
  assert.deepEqual((await call('GET', '/slots?provider=Dr%20Bello')).body.slots.map((s) => s.id), ['s3']);
  assert.equal((await call('GET', '/slots?provider=Dr%20Ade')).body.slots.length, 4);
  assert.deepEqual((await call('GET', '/slots?provider=dr%20ade')).body.slots, []);
  assert.deepEqual((await call('GET', '/slots?provider=Dr')).body.slots, []);
});

test('GET /slots marks a slot unavailable while it has a confirmed booking', async () => {
  await call('POST', '/bookings', { slot_id: 's1', name: 'Ada', email: 'ada@example.com' });
  const slots = (await call('GET', '/slots')).body.slots;
  assert.equal(slots.find((s) => s.id === 's1').available, false);
  assert.equal(slots.find((s) => s.id === 's3').available, true);
});

// ---------- Level 1: bookings ----------

test('POST /bookings returns 201 with the booking', async () => {
  const r = await call('POST', '/bookings', { slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body).sort(), ['created_at', 'email', 'id', 'name', 'slot_id', 'status']);
  assert.equal(typeof r.body.id, 'string');
  assert.ok(r.body.id.length > 0);
  assert.equal(r.body.slot_id, 's1');
  assert.equal(r.body.name, 'Ada Obi');
  assert.equal(r.body.email, 'ada@example.com');
  assert.equal(r.body.status, 'confirmed');
  assert.equal(new Date(r.body.created_at).toISOString(), r.body.created_at);
  assert.ok(Math.abs(Date.parse(r.body.created_at) - Date.now()) < 60_000);
});

test('booking ids are unique', async () => {
  const a = await call('POST', '/bookings', { slot_id: 's1', name: 'A', email: 'a@example.com' });
  const b = await call('POST', '/bookings', { slot_id: 's3', name: 'B', email: 'b@example.com' });
  assert.notEqual(a.body.id, b.body.id);
});

test('GET /bookings/{id} returns 200 with the same booking', async () => {
  const created = await call('POST', '/bookings', { slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' });
  const r = await call('GET', `/bookings/${created.body.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, created.body);
});

test('GET /bookings/{id} returns 404 {"error"} for an unknown id', async () => {
  const r = await call('GET', '/bookings/does-not-exist');
  assert.equal(r.status, 404);
  assert.equal(typeof r.body.error, 'string');
});

// ---------- Level 1: web page ----------

test('GET / serves the web page', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.text, /Bloom Clinic/);
});

// ---------- Level 2: API key ----------

test('every endpoint returns 401 {"error"} without a key or with a wrong key', async () => {
  const id = (await call('POST', '/bookings', { slot_id: 's1', name: 'A', email: 'a@example.com' })).body.id;
  const endpoints = [
    ['POST', '/reset', { slots: [] }],
    ['GET', '/slots'],
    ['GET', '/slots?provider=Dr%20Ade'],
    ['POST', '/bookings', { slot_id: 's3', name: 'A', email: 'a@example.com' }],
    ['GET', `/bookings/${id}`],
    ['DELETE', `/bookings/${id}`],
    ['GET', '/bookings?email=a@example.com'],
    ['GET', '/no-such-route'],
  ];
  for (const key of [null, '', 'wrong-key', `${KEY}x`, KEY.slice(0, -1)]) {
    for (const [m, p, b] of endpoints) {
      const r = await call(m, p, b, { 'X-API-Key': key });
      assert.equal(r.status, 401, `${m} ${p} key=${key === KEY ? '<real>' : key}`);
      assert.equal(typeof r.body.error, 'string');
    }
  }
  // nothing changed: reset was rejected, s3 not booked
  const slots = (await call('GET', '/slots')).body.slots;
  assert.equal(slots.length, SLOTS.length);
  assert.equal(slots.find((s) => s.id === 's3').available, true);
});

test('lower-case x-api-key header name is accepted (headers are case-insensitive)', async () => {
  assert.equal((await call('GET', '/slots', undefined, { 'X-API-Key': null, 'x-api-key': KEY })).status, 200);
});

// ---------- Level 2: web page + proxy ----------

test('web page is served without a key and does not contain the API key', async () => {
  const r = await call('GET', '/', undefined, { 'X-API-Key': null });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.ok(!r.text.includes(KEY), 'page must not contain the API key');
  assert.match(r.text, /\/proxy/);
});

test('proxy adds the key for the endpoints the page needs', async () => {
  const s = await call('GET', '/proxy/slots', undefined, { 'X-API-Key': null });
  assert.equal(s.status, 200);
  assert.equal(s.body.slots.length, SLOTS.length);
  const b = await call('POST', '/proxy/bookings', { slot_id: 's1', name: ' Ada ', email: 'Ada@Example.com' }, { 'X-API-Key': null });
  assert.equal(b.status, 201);
  assert.equal(b.body.email, 'ada@example.com');
  const g = await call('GET', `/proxy/bookings/${b.body.id}`, undefined, { 'X-API-Key': null });
  assert.equal(g.status, 200);
  for (const [, v] of s.headers) assert.ok(!v.includes(KEY));
});

test('proxy does not expose /reset or other endpoints', async () => {
  for (const [m, p] of [['POST', '/proxy/reset'], ['GET', '/proxy/bookings?email=a@example.com'], ['DELETE', '/proxy/bookings/x'], ['GET', '/proxy/nope']]) {
    const r = await call(m, p, m === 'POST' ? { slots: [] } : undefined, { 'X-API-Key': null });
    assert.equal(r.status, 404, `${m} ${p}`);
    assert.equal(typeof r.body.error, 'string');
  }
  assert.equal((await call('GET', '/slots')).body.slots.length, SLOTS.length);
});

// ---------- Level 2: POST /bookings validation ----------

test('POST /bookings trims name and email and lower-cases email', async () => {
  const r = await call('POST', '/bookings', { slot_id: 's1', name: '  Ada Obi  ', email: '  ADA@Example.COM ' });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'Ada Obi');
  assert.equal(r.body.email, 'ada@example.com');
  assert.equal((await call('GET', `/bookings/${r.body.id}`)).body.email, 'ada@example.com');
});

test('POST /bookings returns 400 for missing, empty or non-string fields', async () => {
  const good = { slot_id: 's1', name: 'Ada', email: 'ada@example.com' };
  const bads = [{}];
  for (const f of ['slot_id', 'name', 'email']) {
    const missing = { ...good };
    delete missing[f];
    bads.push(missing);
    for (const v of ['', '   ', null, 123, true, [], {}, ['s1']]) bads.push({ ...good, [f]: v });
  }
  for (const [i, b0] of bads.entries()) {
    // unique valid email per case so the Level 5 rate limit (5/min/email) doesn't interfere
    const b = b0.email === good.email ? { ...b0, email: `ada${i}@example.com` } : b0;
    const r = await call('POST', '/bookings', b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.equal(typeof r.body.error, 'string');
  }
  assert.equal((await call('GET', '/slots')).body.slots.find((s) => s.id === 's1').available, true);
});

test('POST /bookings returns 400 for an invalid email', async () => {
  for (const email of ['ada', 'ada@', '@example.com', 'ada@example', 'ada example@x.com', 'a@b@c.com']) {
    const r = await call('POST', '/bookings', { slot_id: 's1', name: 'Ada', email });
    assert.equal(r.status, 400, email);
    assert.equal(typeof r.body.error, 'string');
  }
});

test('POST /bookings with a non-object JSON body returns 400', async () => {
  for (const raw of ['[]', '"hello"', '42', 'null']) {
    const r = await call('POST', '/bookings', raw);
    assert.equal(r.status, 400, raw);
    assert.equal(typeof r.body.error, 'string');
  }
});

test('POST /bookings returns 404 when the slot does not exist', async () => {
  const r = await call('POST', '/bookings', { slot_id: 'nope', name: 'Ada', email: 'ada@example.com' });
  assert.equal(r.status, 404);
  assert.equal(typeof r.body.error, 'string');
});

test('POST /bookings returns 400 when the slot has already started', async () => {
  const r = await call('POST', '/bookings', { slot_id: 'past', name: 'Ada', email: 'ada@example.com' });
  assert.equal(r.status, 400);
  assert.equal(typeof r.body.error, 'string');
  // a slot that started a moment ago (start <= now) is also rejected
  const justNow = new Date(Date.now() - 1000).toISOString();
  await call('POST', '/reset', { slots: [{ id: 'now', provider: 'Dr Ade', start: justNow, end: '2030-01-01T00:00:00Z' }] });
  assert.equal((await call('POST', '/bookings', { slot_id: 'now', name: 'Ada', email: 'ada@example.com' })).status, 400);
});

test('validation errors (400) win over slot-not-found (404)', async () => {
  const r = await call('POST', '/bookings', { slot_id: 'nope', name: 'Ada', email: 'bad' });
  assert.equal(r.status, 400);
});

// ---------- Level 2: malformed JSON + unknown routes ----------

test('malformed JSON body returns 400 {"error"}', async () => {
  for (const p of ['/bookings', '/reset']) {
    for (const raw of ['{', '{"slot_id": "s1",}', "{'a':1}", 'not json']) {
      const r = await call('POST', p, raw);
      assert.equal(r.status, 400, `${p} ${raw}`);
      assert.match(r.headers.get('content-type'), /application\/json/);
      assert.equal(typeof r.body.error, 'string');
    }
  }
  assert.equal((await call('GET', '/slots')).body.slots.length, SLOTS.length);
});

// ---------- Level 3: double booking ----------

test('a slot with a confirmed booking returns 409 {"error"}', async () => {
  const a = await call('POST', '/bookings', { slot_id: 's1', name: 'A', email: 'a@example.com' });
  assert.equal(a.status, 201);
  const b = await call('POST', '/bookings', { slot_id: 's1', name: 'B', email: 'b@example.com' });
  assert.equal(b.status, 409);
  assert.equal(typeof b.body.error, 'string');
  // other slots are unaffected
  assert.equal((await call('POST', '/bookings', { slot_id: 's3', name: 'B', email: 'b@example.com' })).status, 201);
});

test('20 concurrent bookings for one slot: exactly one 201, the rest 409', async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      call('POST', '/bookings', { slot_id: 's1', name: `P${i}`, email: `p${i}@example.com` })),
  );
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 201).length, 1, statuses.join(','));
  assert.equal(statuses.filter((s) => s === 409).length, 19, statuses.join(','));
  const { rows } = await db.query("SELECT count(*)::int AS n FROM bookings WHERE slot_id = 's1' AND status = 'confirmed'");
  assert.equal(rows[0].n, 1);
});

test('the partial unique index exists in Postgres', async () => {
  const { rows } = await db.query(
    "SELECT indexdef FROM pg_indexes WHERE tablename = 'bookings' AND indexname = 'bookings_one_confirmed_per_slot'",
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0].indexdef, /UNIQUE INDEX .* \(slot_id\) WHERE \(status = 'confirmed'::text\)/);
});

// ---------- Level 3: DELETE /bookings/{id} ----------

test('DELETE /bookings/{id} cancels, returns 200 with the booking, and frees the slot', async () => {
  const created = await call('POST', '/bookings', { slot_id: 's1', name: 'Ada', email: 'ada@example.com' });
  const r = await call('DELETE', `/bookings/${created.body.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ...created.body, status: 'cancelled' });
  assert.deepEqual((await call('GET', `/bookings/${created.body.id}`)).body, r.body);
  assert.equal((await call('GET', '/slots')).body.slots.find((s) => s.id === 's1').available, true);
  // slot can be booked again
  const again = await call('POST', '/bookings', { slot_id: 's1', name: 'Bo', email: 'bo@example.com' });
  assert.equal(again.status, 201);
  assert.notEqual(again.body.id, created.body.id);
  assert.equal((await call('GET', '/slots')).body.slots.find((s) => s.id === 's1').available, false);
});

test('DELETE /bookings/{id} returns 404 for an unknown id', async () => {
  const r = await call('DELETE', '/bookings/does-not-exist');
  assert.equal(r.status, 404);
  assert.equal(typeof r.body.error, 'string');
});

test('DELETE /bookings/{id} returns 409 when already cancelled', async () => {
  const created = await call('POST', '/bookings', { slot_id: 's1', name: 'Ada', email: 'ada@example.com' });
  assert.equal((await call('DELETE', `/bookings/${created.body.id}`)).status, 200);
  const r = await call('DELETE', `/bookings/${created.body.id}`);
  assert.equal(r.status, 409);
  assert.equal(typeof r.body.error, 'string');
});

test('concurrent cancels of one booking: exactly one 200, the rest 409', async () => {
  const created = await call('POST', '/bookings', { slot_id: 's1', name: 'Ada', email: 'ada@example.com' });
  const statuses = (await Promise.all(Array.from({ length: 10 }, () => call('DELETE', `/bookings/${created.body.id}`))))
    .map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 200).length, 1, statuses.join(','));
  assert.equal(statuses.filter((s) => s === 409).length, 9, statuses.join(','));
});

// ---------- Level 4: Idempotency-Key ----------

const { withIdempotency } = require('../src/middleware/idempotency');

async function countBookings(where = 'TRUE', params = []) {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM bookings WHERE ${where}`, params);
  return rows[0].n;
}

test('same Idempotency-Key + same body: identical status and body, one booking', async () => {
  const body = { slot_id: 's1', name: 'Ada', email: 'ada@example.com' };
  const a = await call('POST', '/bookings', body, { 'Idempotency-Key': 'k-1' });
  const b = await call('POST', '/bookings', body, { 'Idempotency-Key': 'k-1' });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(b.text, a.text); // byte-identical, same id and created_at
  assert.match(b.headers.get('content-type'), /application\/json/);
  assert.equal(await countBookings(), 1);
});

test('key order / whitespace differences still count as the same body', async () => {
  const a = await call('POST', '/bookings', '{"slot_id":"s1","name":"Ada","email":"ada@example.com"}', { 'Idempotency-Key': 'k-2' });
  const b = await call('POST', '/bookings', '{ "email": "ada@example.com",\n "name": "Ada", "slot_id": "s1" }', { 'Idempotency-Key': 'k-2' });
  assert.equal(a.status, 201);
  assert.equal(b.text, a.text);
  assert.equal(await countBookings(), 1);
});

test('same Idempotency-Key + different body returns 422 {"error"}', async () => {
  await call('POST', '/bookings', { slot_id: 's1', name: 'Ada', email: 'ada@example.com' }, { 'Idempotency-Key': 'k-3' });
  for (const other of [
    { slot_id: 's3', name: 'Ada', email: 'ada@example.com' },
    { slot_id: 's1', name: 'Ada ', email: 'ada@example.com' },
    { slot_id: 's1', name: 'Ada', email: 'ada@example.com', extra: 1 },
  ]) {
    const r = await call('POST', '/bookings', other, { 'Idempotency-Key': 'k-3' });
    assert.equal(r.status, 422, JSON.stringify(other));
    assert.equal(typeof r.body.error, 'string');
  }
  assert.equal(await countBookings(), 1);
});

test('different keys are independent; no key means no idempotency', async () => {
  const body = { slot_id: 's1', name: 'Ada', email: 'ada@example.com' };
  assert.equal((await call('POST', '/bookings', body, { 'Idempotency-Key': 'k-a' })).status, 201);
  assert.equal((await call('POST', '/bookings', body, { 'Idempotency-Key': 'k-b' })).status, 409);
  assert.equal((await call('POST', '/bookings', body)).status, 409);
});

test('stored error responses (4xx) are replayed exactly, even after state changes', async () => {
  const first = await call('POST', '/bookings', { slot_id: 's1', name: 'A', email: 'a@example.com' });
  const body = { slot_id: 's1', name: 'B', email: 'b@example.com' };
  const conflict = await call('POST', '/bookings', body, { 'Idempotency-Key': 'k-409' });
  assert.equal(conflict.status, 409);
  await call('DELETE', `/bookings/${first.body.id}`); // slot is free now
  const replay = await call('POST', '/bookings', body, { 'Idempotency-Key': 'k-409' });
  assert.equal(replay.status, 409);
  assert.equal(replay.text, conflict.text);
  // validation errors are stored too
  const v1 = await call('POST', '/bookings', { slot_id: 's3', name: '', email: 'x@example.com' }, { 'Idempotency-Key': 'k-400' });
  const v2 = await call('POST', '/bookings', { slot_id: 's3', name: '', email: 'x@example.com' }, { 'Idempotency-Key': 'k-400' });
  assert.equal(v1.status, 400);
  assert.equal(v2.text, v1.text);
});

test('10 concurrent requests with the same key + body: all identical, one booking', async () => {
  const body = { slot_id: 's1', name: 'Ada', email: 'ada@example.com' };
  const results = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/bookings', body, { 'Idempotency-Key': 'k-conc' })));
  for (const r of results) {
    assert.equal(r.status, 201);
    assert.equal(r.text, results[0].text);
  }
  assert.equal(await countBookings(), 1);
});

test('concurrent same key, two different bodies: one booking; others replay or 422', async () => {
  const A = { slot_id: 's1', name: 'A', email: 'a@example.com' };
  const B = { slot_id: 's3', name: 'B', email: 'b@example.com' };
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => call('POST', '/bookings', i % 2 ? A : B, { 'Idempotency-Key': 'k-mixed' })));
  const created = results.filter((r) => r.status === 201);
  assert.ok(created.length >= 1);
  assert.ok(created.every((r) => r.text === created[0].text));
  assert.ok(results.every((r) => r.status === 201 || r.status === 422), results.map((r) => r.status).join(','));
  assert.equal(await countBookings(), 1);
});

test('Idempotency-Key longer than 255 chars returns 400', async () => {
  const r = await call('POST', '/bookings', { slot_id: 's1', name: 'A', email: 'a@example.com' }, { 'Idempotency-Key': 'x'.repeat(256) });
  assert.equal(r.status, 400);
  assert.equal(await countBookings(), 0);
});

test('429 and 5xx results are not stored: the claim is released and the key can run again', async () => {
  let runs = 0;
  const r429 = await withIdempotency('k-unit-429', { a: 1 }, async () => { runs++; return { status: 429, text: '{"error":"x"}' }; });
  assert.equal(r429.status, 429);
  await assert.rejects(withIdempotency('k-unit-500', { a: 1 }, async () => { runs++; throw new Error('boom'); }));
  const { rows } = await db.query("SELECT key FROM idempotency_keys WHERE key LIKE 'k-unit-%'");
  assert.deepEqual(rows, []);
  const ok = await withIdempotency('k-unit-429', { a: 1 }, async () => { runs++; return { status: 201, text: '{"ok":1}' }; });
  assert.equal(ok.status, 201);
  assert.equal(runs, 3);
});

test('booking + stored response commit atomically: a failed transaction leaves neither', async () => {
  await assert.rejects(withIdempotency('k-atomic', { a: 1 }, (idem) => db.withTransaction(async (c) => {
    await c.query("INSERT INTO bookings (id, slot_id, name, email, status) VALUES ('atomic-1', 's1', 'A', 'a@example.com', 'confirmed')");
    await idem.storeWith(c, { status: 201, text: '{"id":"atomic-1"}' });
    throw new Error('crash before commit');
  })));
  assert.equal(await countBookings("id = 'atomic-1'"), 0);
  const { rows } = await db.query("SELECT 1 FROM idempotency_keys WHERE key = 'k-atomic'");
  assert.equal(rows.length, 0); // claim released, so a retry runs again
});

test('a stale unfinished claim (crashed owner) is taken over', async () => {
  const { hashBody } = require('../src/middleware/idempotency');
  const body = { slot_id: 's1', name: 'Ada', email: 'ada@example.com' };
  await db.query("INSERT INTO idempotency_keys (key, body_hash, created_at) VALUES ('k-stale', $1, now() - interval '1 minute')", [hashBody(body)]);
  const r = await call('POST', '/bookings', body, { 'Idempotency-Key': 'k-stale' });
  assert.equal(r.status, 201);
});

test('POST /reset clears idempotency keys', async () => {
  const body = { slot_id: 's1', name: 'Ada', email: 'ada@example.com' };
  const a = await call('POST', '/bookings', body, { 'Idempotency-Key': 'k-reset' });
  await call('POST', '/reset', { slots: SLOTS });
  const b = await call('POST', '/bookings', body, { 'Idempotency-Key': 'k-reset' });
  assert.equal(b.status, 201);
  assert.notEqual(b.body.id, a.body.id);
});

// ---------- Level 4: GET /bookings ----------

// Inserts n bookings for `email` directly (fast, and not subject to the rate limit).
// Each gets a distinct past slot and created_at = base + i seconds; `tieEvery` makes groups share a timestamp.
async function seedBookings(email, n, { tieEvery = 1, status = 'confirmed' } = {}) {
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const ids = [];
  for (let i = 0; i < n; i++) {
    const slotId = `seed-${email}-${i}`;
    await db.query("INSERT INTO slots VALUES ($1, 'Dr Seed', '2030-01-01T00:00:00Z', '2030-01-01T00:30:00Z', '2030-01-01T00:00:00Z', '2030-01-01T00:30:00Z')", [slotId]);
    const id = `b-${String(i).padStart(3, '0')}-${crypto.randomUUID()}`;
    await db.query('INSERT INTO bookings (id, slot_id, name, email, status, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, slotId, `N${i}`, email, status, new Date(base + Math.floor(i / tieEvery) * 1000)]);
    ids.push(id);
  }
  return ids; // in expected (created_at, id) order
}
const crypto = require('crypto');

async function listAll(email, limit) {
  const seen = [];
  let cursor = null;
  for (let pages = 0; pages < 100; pages++) {
    const q = new URLSearchParams({ email });
    if (limit !== undefined) q.set('limit', String(limit));
    if (cursor) q.set('cursor', cursor);
    const r = await call('GET', `/bookings?${q}`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.body).sort(), ['bookings', 'next_cursor']);
    seen.push(r.body);
    if (r.body.next_cursor === null) return seen;
    assert.equal(typeof r.body.next_cursor, 'string');
    cursor = r.body.next_cursor;
  }
  throw new Error('pagination did not terminate');
}

test('GET /bookings: oldest first, default limit 10, cursor walks every page, last page null', async () => {
  const ids = await seedBookings('pat@example.com', 23);
  await seedBookings('other@example.com', 3);
  const pages = await listAll('pat@example.com');
  assert.deepEqual(pages.map((p) => p.bookings.length), [10, 10, 3]);
  assert.deepEqual(pages.flatMap((p) => p.bookings.map((b) => b.id)), ids);
  for (const b of pages[0].bookings) {
    assert.deepEqual(Object.keys(b).sort(), ['created_at', 'email', 'id', 'name', 'slot_id', 'status']);
    assert.equal(b.email, 'pat@example.com');
  }
});

test('GET /bookings: exact multiple of limit ends with next_cursor null (no empty extra page)', async () => {
  await seedBookings('pat@example.com', 20);
  const pages = await listAll('pat@example.com', 10);
  assert.deepEqual(pages.map((p) => p.bookings.length), [10, 10]);
});

test('GET /bookings: bookings with identical created_at are neither skipped nor repeated', async () => {
  const ids = await seedBookings('pat@example.com', 17, { tieEvery: 4 });
  for (const limit of [1, 3, 4, 5, 50]) {
    const pages = await listAll('pat@example.com', limit);
    assert.deepEqual(pages.flatMap((p) => p.bookings.map((b) => b.id)), ids, `limit=${limit}`);
  }
});

test('GET /bookings: email match ignores case and surrounding spaces; includes cancelled', async () => {
  const created = await call('POST', '/bookings', { slot_id: 's1', name: 'Ada', email: 'Ada@Example.com' });
  await call('DELETE', `/bookings/${created.body.id}`);
  await call('POST', '/bookings', { slot_id: 's3', name: 'Ada', email: 'ada@example.com' });
  for (const email of ['ada@example.com', 'ADA@EXAMPLE.COM', ' Ada@example.com ']) {
    const r = await call('GET', `/bookings?email=${encodeURIComponent(email)}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.bookings.map((b) => [b.slot_id, b.status]), [['s1', 'cancelled'], ['s3', 'confirmed']]);
    assert.equal(r.body.next_cursor, null);
  }
  assert.deepEqual((await call('GET', '/bookings?email=nobody@example.com')).body, { bookings: [], next_cursor: null });
});

test('GET /bookings: limit 1 and 50 are accepted', async () => {
  await seedBookings('pat@example.com', 2);
  assert.equal((await call('GET', '/bookings?email=pat@example.com&limit=1')).body.bookings.length, 1);
  assert.equal((await call('GET', '/bookings?email=pat@example.com&limit=50')).body.bookings.length, 2);
});

test('GET /bookings: invalid limit returns 400 {"error"}', async () => {
  for (const limit of ['0', '51', 'abc', '1.5', '-1', '', ' 5', '5abc', '1e1', '100', '10&limit=20']) {
    const r = await call('GET', `/bookings?email=a@example.com&limit=${limit === '10&limit=20' ? limit : encodeURIComponent(limit)}`);
    assert.equal(r.status, 400, `limit=${JSON.stringify(limit)}`);
    assert.equal(typeof r.body.error, 'string');
  }
});

test('GET /bookings: invalid cursor returns 400 {"error"}', async () => {
  const b64 = (s) => Buffer.from(s).toString('base64url');
  for (const cursor of ['garbage!', 'abc', '%%%', b64('not-a-date|x'), b64('2026-01-01T00:00:00.000Z'), b64('2026-01-01T00:00:00.000Z|'), b64('hello')]) {
    const r = await call('GET', `/bookings?email=a@example.com&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(r.status, 400, `cursor=${cursor}`);
    assert.equal(typeof r.body.error, 'string');
  }
});

test('GET /bookings: missing or empty email returns 400', async () => {
  for (const q of ['', '?email=', '?email=%20%20', '?limit=5']) {
    const r = await call('GET', `/bookings${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(typeof r.body.error, 'string');
  }
});

// ---------- Level 5: rate limit ----------

const book = (email, slot_id = 'nope', headers = {}) => call('POST', '/bookings', { slot_id, name: 'R', email }, headers);

function assert429(r) {
  assert.equal(r.status, 429, r.text);
  assert.equal(typeof r.body.error, 'string');
  const ra = r.headers.get('retry-after');
  assert.match(ra, /^\d+$/, `Retry-After=${ra}`);
  assert.ok(Number(ra) >= 1 && Number(ra) <= 60, `Retry-After=${ra}`);
}

test('6th attempt for an email within a minute returns 429 with Retry-After (failed attempts count)', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await book('rl@example.com')).status, 404); // failed attempts
  assert.equal((await book('rl@example.com', 's1')).status, 201); // 5th: success
  assert429(await book('rl@example.com', 's3')); // 6th: even a valid booking is refused
  assert429(await book('rl@example.com', 's3'));
  assert.equal(await countBookings('slot_id = $1', ['s3']), 0);
});

test('other emails are unaffected by one email hitting the limit', async () => {
  for (let i = 0; i < 5; i++) await book('busy@example.com');
  assert429(await book('busy@example.com'));
  assert.equal((await book('calm@example.com', 's1')).status, 201);
});

test('the limit is per trimmed + lower-cased email', async () => {
  for (const e of ['Case@Example.com', ' case@example.com', 'CASE@EXAMPLE.COM ', 'case@example.com', 'cAsE@example.COM']) {
    assert.equal((await book(e)).status, 404);
  }
  assert429(await book('  Case@example.com  '));
});

test('400 attempts with an invalid email still count toward that email', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await book('not-an-email')).status, 400);
  assert429(await book('not-an-email'));
});

test('429 responses do not count as attempts; window is rolling', async () => {
  for (let i = 0; i < 5; i++) await book('roll@example.com');
  for (let i = 0; i < 3; i++) assert429(await book('roll@example.com'));
  assert.equal(await countAttempts('roll@example.com'), 5);
  // pretend all 5 attempts happened 45s ago -> Retry-After about 15 (minus request latency)
  await db.query("UPDATE booking_attempts SET attempted_at = clock_timestamp() - interval '45 seconds' WHERE email = 'roll@example.com'");
  const r = await book('roll@example.com');
  assert429(r);
  assert.ok(Number(r.headers.get('retry-after')) <= 15, r.headers.get('retry-after'));
  // after the window passes, attempts are allowed again
  await db.query("UPDATE booking_attempts SET attempted_at = clock_timestamp() - interval '61 seconds' WHERE email = 'roll@example.com'");
  assert.equal((await book('roll@example.com', 's1')).status, 201);
});

async function countAttempts(email) {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM booking_attempts WHERE email = $1', [email]);
  return rows[0].n;
}

test('Retry-After counts from the oldest attempt in the window', async () => {
  await db.query(`INSERT INTO booking_attempts (email, attempted_at) VALUES
    ('old@example.com', clock_timestamp() - interval '57.5 seconds'),
    ('old@example.com', clock_timestamp() - interval '30 seconds'),
    ('old@example.com', clock_timestamp()), ('old@example.com', clock_timestamp()), ('old@example.com', clock_timestamp())`);
  const r = await book('old@example.com');
  assert429(r);
  // ~2.5s left minus network latency, rounded up to whole seconds (not ~60 from the newest attempt)
  assert.ok(['1', '2', '3'].includes(r.headers.get('retry-after')), r.headers.get('retry-after'));
});

test('idempotent replays do not count as new attempts', async () => {
  const body = { slot_id: 's1', name: 'R', email: 'idem@example.com' };
  const first = await call('POST', '/bookings', body, { 'Idempotency-Key': 'rl-k' });
  for (let i = 0; i < 8; i++) {
    const r = await call('POST', '/bookings', body, { 'Idempotency-Key': 'rl-k' });
    assert.equal(r.status, 201);
    assert.equal(r.text, first.text);
  }
  assert.equal(await countAttempts('idem@example.com'), 1);
  for (let i = 0; i < 4; i++) assert.equal((await book('idem@example.com')).status, 404);
  assert429(await book('idem@example.com'));
});

test('a 429 is not stored under the Idempotency-Key: retrying after the window succeeds', async () => {
  for (let i = 0; i < 5; i++) await book('later@example.com');
  const body = { slot_id: 's1', name: 'R', email: 'later@example.com' };
  assert429(await call('POST', '/bookings', body, { 'Idempotency-Key': 'rl-later' }));
  await db.query("UPDATE booking_attempts SET attempted_at = attempted_at - interval '61 seconds' WHERE email = 'later@example.com'");
  const ok = await call('POST', '/bookings', body, { 'Idempotency-Key': 'rl-later' });
  assert.equal(ok.status, 201);
  const replay = await call('POST', '/bookings', body, { 'Idempotency-Key': 'rl-later' });
  assert.equal(replay.text, ok.text);
});

test('20 concurrent attempts for one email: exactly 5 get through, 15 get 429', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => book('flood@example.com', i % 2 ? 's1' : 'nope')));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 429).length, 15, statuses.join(','));
  for (const r of results.filter((x) => x.status === 429)) assert429(r);
  assert.equal(await countAttempts('flood@example.com'), 5);
  assert.ok(await countBookings("slot_id = 's1'") <= 1);
});

test('requests with no usable email are not rate limited (they fail validation)', async () => {
  for (let i = 0; i < 7; i++) {
    assert.equal((await call('POST', '/bookings', { slot_id: 's1', name: 'R' })).status, 400);
  }
});

test('POST /reset clears rate-limit counters', async () => {
  for (let i = 0; i < 5; i++) await book('reset-rl@example.com');
  assert429(await book('reset-rl@example.com'));
  await call('POST', '/reset', { slots: SLOTS });
  assert.equal((await book('reset-rl@example.com', 's1')).status, 201);
});

test('unknown routes return 404 JSON {"error"}', async () => {
  for (const [m, p] of [['GET', '/nope'], ['GET', '/slots/s1'], ['PUT', '/slots'], ['PATCH', '/bookings/x'], ['POST', '/slots'], ['GET', '/api/slots']]) {
    const r = await call(m, p);
    assert.equal(r.status, 404, `${m} ${p}`);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.equal(typeof r.body.error, 'string');
  }
});
