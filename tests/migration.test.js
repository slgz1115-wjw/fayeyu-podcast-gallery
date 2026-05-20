'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Database = require('better-sqlite3');

const FIXTURE = path.join(__dirname, 'fixtures/legacy-fixture.db');

process.env.MURMUR_ENCRYPTION_KEY = require('node:crypto').randomBytes(32).toString('hex');
process.env.FAYE_INITIAL_PASSWORD = 'fayetest1234';
process.env.DEEPSEEK_API_KEY = 'sk-deepseek-fixture';
process.env.GROQ_API_KEY = 'gsk-groq-fixture';

const { applyMigration, isAlreadyMigrated } = require('../migrations/2026-05-19-multi-tenant');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  const f = path.join(dir, 'test.db');
  fs.copyFileSync(FIXTURE, f);
  return new Database(f);
}

test('isAlreadyMigrated returns false on legacy DB', () => {
  const db = freshDb();
  assert.equal(isAlreadyMigrated(db), false);
});

test('applyMigration creates users table', () => {
  const db = freshDb();
  applyMigration(db);
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").all();
  assert.equal(rows.length, 1);
});

test('applyMigration adds user_id columns to business tables', () => {
  const db = freshDb();
  applyMigration(db);
  for (const tbl of ['podcasts', 'episodes', 'notes', 'comments']) {
    const cols = db.prepare(`PRAGMA table_info(${tbl})`).all().map(c => c.name);
    assert.ok(cols.includes('user_id'), `${tbl} missing user_id column`);
  }
  const sCols = db.prepare(`PRAGMA table_info(sessions)`).all().map(c => c.name);
  assert.ok(sCols.includes('user_id'), 'sessions missing user_id');
});

test('applyMigration inserts Faye user_id=1 with encrypted keys', () => {
  const db = freshDb();
  applyMigration(db);
  const faye = db.prepare(`SELECT id, email, is_admin, password_hash, deepseek_api_key, groq_api_key FROM users WHERE id=1`).get();
  assert.equal(faye.id, 1);
  assert.equal(faye.email, 'fayeyu@deltax.world');
  assert.equal(faye.is_admin, 1);
  assert.match(faye.password_hash, /^\$2[ayb]\$10\$/);
  assert.match(faye.deepseek_api_key, /^[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/);
  assert.match(faye.groq_api_key, /^[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/);
});

test('applyMigration assigns existing data to user_id=1', () => {
  const db = freshDb();
  applyMigration(db);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM podcasts WHERE user_id=1`).get().n, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM episodes WHERE user_id=1`).get().n, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM notes WHERE user_id=1`).get().n, 2);
});

test('applyMigration is idempotent (re-running is no-op)', () => {
  const db = freshDb();
  applyMigration(db);
  const before = db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
  applyMigration(db);
  const after = db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
  assert.equal(before, after);
  assert.equal(isAlreadyMigrated(db), true);
});

test('isAlreadyMigrated returns true after applyMigration', () => {
  const db = freshDb();
  applyMigration(db);
  assert.equal(isAlreadyMigrated(db), true);
});

test('applyMigration rebuilds kg_edits with composite PK (user_id, term)', () => {
  const db = freshDb();
  // seed a kg_edits row in legacy schema
  db.prepare(`INSERT INTO kg_edits (term, action) VALUES ('foo', 'delete')`).run();
  applyMigration(db);
  const cols = db.prepare(`PRAGMA table_info(kg_edits)`).all();
  assert.ok(cols.some(c => c.name === 'user_id'), 'user_id column missing');
  // existing row migrated with user_id=1
  const row = db.prepare(`SELECT user_id, term FROM kg_edits WHERE term='foo'`).get();
  assert.equal(row.user_id, 1);
});
