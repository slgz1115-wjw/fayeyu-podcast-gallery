// migrations/2026-05-19-multi-tenant.js — One-shot SaaS migration.
// Creates users table, adds user_id to business tables, inserts Faye as user_id=1.
// Idempotent: re-running skips if users table already populated.
//
// Env required:
//   MURMUR_ENCRYPTION_KEY  (64 hex chars)
//   FAYE_INITIAL_PASSWORD  (one-shot, for first migration)
//   DEEPSEEK_API_KEY       (encrypted into Faye's user row)
//   GROQ_API_KEY           (encrypted into Faye's user row)
'use strict';

const bcrypt = require('bcrypt');
const { encryptApiKey } = require('../lib/crypto');

function isAlreadyMigrated(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").all();
  if (tables.length === 0) return false;
  const userCount = db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
  return userCount > 0;
}

function tableHasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

function applyMigration(db) {
  if (isAlreadyMigrated(db)) {
    console.log('[migration] already applied (users table has rows) — skipping');
    return { applied: false };
  }

  console.log('[migration] starting multi-tenant migration…');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      deepseek_api_key TEXT,
      groq_api_key TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_login_at TEXT,
      is_admin INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  `);

  const addUserIdTo = ['podcasts', 'episodes', 'notes', 'comments'];
  for (const tbl of addUserIdTo) {
    if (!tableHasColumn(db, tbl, 'user_id')) {
      db.exec(`ALTER TABLE ${tbl} ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`);
      console.log(`[migration] added user_id to ${tbl}`);
    }
  }

  if (!tableHasColumn(db, 'sessions', 'user_id')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`);
    console.log('[migration] added user_id to sessions');
  }

  // kg_edits — rebuild because PK changes to (user_id, term)
  const kgHasUserId = tableHasColumn(db, 'kg_edits', 'user_id');
  if (!kgHasUserId) {
    db.exec(`
      CREATE TABLE kg_edits_new (
        user_id INTEGER NOT NULL DEFAULT 1,
        term TEXT NOT NULL,
        action TEXT NOT NULL,
        new_name TEXT,
        new_category TEXT,
        new_subcategory TEXT,
        user_note TEXT,
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, term)
      );
      INSERT INTO kg_edits_new (term, action, new_name, new_category, new_subcategory, user_note, updated_at)
        SELECT term, action, new_name, new_category, new_subcategory, user_note, updated_at FROM kg_edits;
      DROP TABLE kg_edits;
      ALTER TABLE kg_edits_new RENAME TO kg_edits;
    `);
    console.log('[migration] rebuilt kg_edits with composite PK (user_id, term)');
  }

  const fayePassword = process.env.FAYE_INITIAL_PASSWORD;
  if (!fayePassword) throw new Error('FAYE_INITIAL_PASSWORD env var required for first migration');

  const fayeHash = bcrypt.hashSync(fayePassword, 10);
  const dsKey = process.env.DEEPSEEK_API_KEY ? encryptApiKey(process.env.DEEPSEEK_API_KEY) : null;
  const grKey = process.env.GROQ_API_KEY ? encryptApiKey(process.env.GROQ_API_KEY) : null;

  db.prepare(`
    INSERT INTO users (id, email, password_hash, display_name, deepseek_api_key, groq_api_key, is_admin)
    VALUES (1, ?, ?, ?, ?, ?, 1)
  `).run('fayeyu@deltax.world', fayeHash, 'Faye', dsKey, grKey);

  console.log('[migration] inserted Faye user_id=1 (email=fayeyu@deltax.world)');
  console.log('[migration] done — existing data is now owned by user_id=1');
  return { applied: true };
}

module.exports = { applyMigration, isAlreadyMigrated };
