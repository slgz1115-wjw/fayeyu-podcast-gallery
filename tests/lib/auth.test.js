'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Database = require('better-sqlite3');

process.env.MURMUR_ENCRYPTION_KEY = require('node:crypto').randomBytes(32).toString('hex');

const { hashPassword, verifyPassword, generateToken, createSession, verifyToken, deleteSession, requireUser, signupRateLimit, loginRateLimit } = require('../../lib/auth');

function tmpDb() {
  const f = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-')) + '/test.db';
  const db = new Database(f);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE COLLATE NOCASE, password_hash TEXT);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);
  `);
  return db;
}

// --- bcrypt ---
test('hashPassword produces bcrypt $2 hash', async () => {
  const h = await hashPassword('correct horse battery staple');
  assert.match(h, /^\$2[ayb]\$10\$/);
});

test('verifyPassword returns true for correct password', async () => {
  const h = await hashPassword('mypass1234');
  assert.equal(await verifyPassword('mypass1234', h), true);
});

test('verifyPassword returns false for wrong password', async () => {
  const h = await hashPassword('mypass1234');
  assert.equal(await verifyPassword('wrongpass', h), false);
});

// --- token / session ---
test('generateToken returns 64 hex chars', () => {
  assert.match(generateToken(), /^[a-f0-9]{64}$/);
});

test('createSession + verifyToken round-trip', () => {
  const db = tmpDb();
  db.prepare(`INSERT INTO users (id, email, password_hash) VALUES (1, 'a@b.com', 'x')`).run();
  const token = createSession(db, 1);
  const userId = verifyToken(db, token);
  assert.equal(userId, 1);
});

test('verifyToken returns null for unknown token', () => {
  const db = tmpDb();
  assert.equal(verifyToken(db, 'nonexistent'), null);
});

test('verifyToken returns null + cleans up expired session', () => {
  const db = tmpDb();
  db.prepare(`INSERT INTO users (id, email, password_hash) VALUES (1, 'a@b.com', 'x')`).run();
  const token = 'expired-token-12345';
  db.prepare(`INSERT INTO sessions (token, user_id, created, expires) VALUES (?, 1, 0, 0)`).run(token);
  assert.equal(verifyToken(db, token), null);
  const row = db.prepare(`SELECT * FROM sessions WHERE token = ?`).get(token);
  assert.equal(row, undefined);
});

test('deleteSession removes session row', () => {
  const db = tmpDb();
  db.prepare(`INSERT INTO users (id, email, password_hash) VALUES (1, 'a@b.com', 'x')`).run();
  const token = createSession(db, 1);
  deleteSession(db, token);
  assert.equal(verifyToken(db, token), null);
});

// --- requireUser middleware ---
test('requireUser sets req.user_id when token in Authorization header', () => {
  const db = tmpDb();
  db.prepare(`INSERT INTO users (id, email, password_hash) VALUES (42, 'a@b.com', 'x')`).run();
  const token = createSession(db, 42);
  const mw = requireUser(db);
  const req = { headers: { authorization: `Bearer ${token}` }, cookies: {} };
  const res = { status: (n) => ({ json: () => null }) };
  let called = false;
  mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.user_id, 42);
});

test('requireUser accepts token from cookies.session', () => {
  const db = tmpDb();
  db.prepare(`INSERT INTO users (id, email, password_hash) VALUES (7, 'a@b.com', 'x')`).run();
  const token = createSession(db, 7);
  const mw = requireUser(db);
  const req = { headers: {}, cookies: { session: token } };
  let called = false;
  mw(req, { status: () => ({ json: () => null }) }, () => { called = true; });
  assert.equal(req.user_id, 7);
  assert.equal(called, true);
});

test('requireUser returns 401 when no token', () => {
  const db = tmpDb();
  const mw = requireUser(db);
  let statusCode = 0, body = null;
  const res = {
    status(n) { statusCode = n; return this; },
    json(obj) { body = obj; return this; },
  };
  let nextCalled = false;
  mw({ headers: {}, cookies: {} }, res, () => { nextCalled = true; });
  assert.equal(statusCode, 401);
  assert.equal(body.error, 'login required');
  assert.equal(nextCalled, false);
});

test('requireUser returns 401 when token invalid', () => {
  const db = tmpDb();
  const mw = requireUser(db);
  let statusCode = 0;
  const res = { status(n) { statusCode = n; return this; }, json: () => null };
  mw({ headers: { authorization: 'Bearer fake' }, cookies: {} }, res, () => {});
  assert.equal(statusCode, 401);
});

// --- rate limiters ---
test('signupRateLimit + loginRateLimit are express middleware functions', () => {
  assert.equal(typeof signupRateLimit, 'function');
  assert.equal(typeof loginRateLimit, 'function');
});
