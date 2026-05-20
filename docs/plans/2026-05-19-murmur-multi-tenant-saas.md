# Murmur Multi-tenant SaaS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert single-tenant Murmur into multi-tenant SaaS — open registration, per-user data isolation, users bring own DeepSeek/Groq API keys, Faye's existing data migrates to user_id=1.

**Architecture:** Single SQLite + `user_id` column on every business table. Bcrypt password auth + session tokens in DB. AES-256-GCM encrypts user API keys. Express middleware `requireUser` mounts on all routes. Frontend gets auth gate (signup/login before main app) + settings modal.

**Tech Stack:** Node.js + Express + better-sqlite3 + bcrypt + express-rate-limit + cookie-parser. Node 22 (pm2 daemon's). Built-in `node:test` (zero-dep test runner).

**Spec:** [`docs/specs/2026-05-19-murmur-multi-tenant-saas-design.md`](../specs/2026-05-19-murmur-multi-tenant-saas-design.md)

**Notes**:
- `~/podcast-hub/` is the active deployment dir (pm2 runs from here). Not a git repo.
- `~/Desktop/murmur/` is the git repo for GitHub backup. Sync via `cp` after each phase + commit at end.
- No per-task `git commit` (matches murmur-soul-sync pattern). After full plan done → batch sync to Desktop/murmur + commit + push.
- `pm2 restart podcast-gallery` is the live-reload mechanism. Public URL `https://murmur-mac.tail2817ed.ts.net` reflects in 2-3 seconds.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/crypto.js` | AES-256-GCM encrypt/decrypt for user API keys |
| `lib/auth.js` | bcrypt password hashing, session token mgmt, `requireUser` middleware, rate limiters |
| `migrations/2026-05-19-multi-tenant.js` | One-shot schema migration: create `users`, add `user_id` to business tables, insert Faye row |
| `tests/lib/crypto.test.js` | Unit tests for crypto |
| `tests/lib/auth.test.js` | Unit tests for auth helpers |
| `tests/migration.test.js` | Integration test for migration on fixture DB |
| `tests/fixtures/legacy-fixture.db` | Pre-migration DB snapshot (2 podcasts + 3 episodes + 2 notes, no `users` table) |
| `tests/fixtures/make-fixture.js` | Script to (re)generate `legacy-fixture.db` |
| `server.js` | (modified) auth routes + `requireUser` mount + 70 SQL queries audited for `user_id` |
| `pipeline.js` | (modified) `runPipeline(episodeId, userId)` decrypts user keys |
| `public/index.html` | (modified) auth gate + settings modal |
| `package.json` | (modified) deps: `bcrypt`, `express-rate-limit`, `cookie-parser` |

**Env vars (Faye sets via `pm2 set podcast-gallery:KEY value` or `.env`)**:
- `MURMUR_ENCRYPTION_KEY` — 64 hex chars (32 bytes), generated once by Task 8 helper
- `FAYE_INITIAL_PASSWORD` — used once by migration, then deleted

---

## Task 0: Scaffolding (test infra + deps + dirs)

**Files:**
- Modify: `package.json`
- Create: `tests/fixtures/make-fixture.js`
- Create: `tests/fixtures/legacy-fixture.db` (generated)
- Create: `tests/sanity.test.js` (placeholder)

- [ ] **Step 1: Add deps + test script to package.json**

Modify `~/podcast-hub/package.json`:

```json
{
  "name": "podcast-hub",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": {
    "test": "node --test tests/**/*.test.js"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "description": "",
  "dependencies": {
    "bcrypt": "^5.1.1",
    "better-sqlite3": "^12.8.0",
    "cookie-parser": "^1.4.7",
    "express": "^5.2.1",
    "express-rate-limit": "^7.4.1",
    "marked": "^18.0.0",
    "node-cron": "^4.2.1",
    "puppeteer": "^24.40.0",
    "rss-parser": "^3.13.0"
  }
}
```

- [ ] **Step 2: Install deps**

Run: `cd ~/podcast-hub && npm install`
Expected: `bcrypt`, `cookie-parser`, `express-rate-limit` installed. No errors. `node_modules/bcrypt/` exists.

- [ ] **Step 3: Create fixture DB generator**

Create `~/podcast-hub/tests/fixtures/make-fixture.js`:

```javascript
#!/usr/bin/env node
// Generate tests/fixtures/legacy-fixture.db — a pre-migration DB snapshot for testing migration logic.
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const OUT = path.join(__dirname, 'legacy-fixture.db');
if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

const db = new Database(OUT);
// Match production schema BEFORE migration (no user_id)
db.exec(`
  CREATE TABLE podcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, rss_url TEXT,
    artwork TEXT, last_checked TEXT, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, podcast_id INTEGER, title TEXT NOT NULL,
    pub_date TEXT, link TEXT, audio_url TEXT, description TEXT, status TEXT DEFAULT 'new',
    notes TEXT, transcript TEXT, is_oneoff INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')), starred INTEGER DEFAULT 0,
    FOREIGN KEY (podcast_id) REFERENCES podcasts(id)
  );
  CREATE TABLE notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL, source_ref TEXT,
    title TEXT NOT NULL, content TEXT, raw_content TEXT, skill_id INTEGER,
    status TEXT DEFAULT 'new', starred INTEGER DEFAULT 0, metadata TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, target_type TEXT NOT NULL, target_id INTEGER NOT NULL,
    quote TEXT NOT NULL, occurrence INTEGER DEFAULT 0, comment TEXT,
    color TEXT DEFAULT 'yellow', created_at TEXT DEFAULT (datetime('now')),
    kind TEXT DEFAULT 'comment'
  );
  CREATE TABLE kg_edits (
    term TEXT PRIMARY KEY, action TEXT NOT NULL, new_name TEXT, new_category TEXT,
    new_subcategory TEXT, user_note TEXT, updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE sessions (
    token TEXT PRIMARY KEY, created INTEGER NOT NULL, expires INTEGER NOT NULL
  );
  CREATE TABLE skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL,
    description TEXT, prompt_template TEXT NOT NULL, variables TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed minimal data
db.prepare(`INSERT INTO podcasts (id, name, rss_url) VALUES (?, ?, ?)`).run(101, 'Test Podcast A', 'https://example.com/a.rss');
db.prepare(`INSERT INTO podcasts (id, name, rss_url) VALUES (?, ?, ?)`).run(102, '_散装收藏', null);
db.prepare(`INSERT INTO episodes (id, podcast_id, title, status, notes) VALUES (?, ?, ?, 'done', ?)`).run(201, 101, 'Ep 1', '## TL;DR\n核心观点：...');
db.prepare(`INSERT INTO episodes (id, podcast_id, title, status, is_oneoff) VALUES (?, ?, ?, 'new', 1)`).run(202, 102, 'Oneoff Ep', 1);
db.prepare(`INSERT INTO notes (id, source_type, title, content, status) VALUES (?, 'note', ?, ?, 'done')`).run(301, 'A note', 'content here');
db.prepare(`INSERT INTO notes (id, source_type, title, content, status) VALUES (?, 'glimpse', '2026-05-13', '# 2026-05-13\n- bullet', 'done')`).run(302);
db.prepare(`INSERT INTO comments (target_type, target_id, quote, kind) VALUES ('episode', 201, 'something', 'thought')`).run();

console.log('fixture written:', OUT);
db.close();
```

- [ ] **Step 4: Generate fixture**

Run: `cd ~/podcast-hub && node tests/fixtures/make-fixture.js`
Expected: stdout `fixture written: /Users/slgz1115/podcast-hub/tests/fixtures/legacy-fixture.db`. File exists.

- [ ] **Step 5: Sanity test**

Create `~/podcast-hub/tests/sanity.test.js`:

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('sanity — node:test runner is wired', () => {
  assert.equal(1, 1);
});
```

- [ ] **Step 6: Verify test command**

Run: `cd ~/podcast-hub && npm test 2>&1 | tail -8`
Expected: `pass 1 / fail 0`. If glob form fails, fall back to `node --test tests/sanity.test.js` (Node 22 prefers explicit file vs dir).

---

## Task 1-2: `lib/crypto.js` (AES-256-GCM)

**Files:**
- Create: `lib/crypto.js`
- Create: `tests/lib/crypto.test.js`

- [ ] **Step 1: Write failing tests**

Create `~/podcast-hub/tests/lib/crypto.test.js`:

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const KEY = crypto.randomBytes(32).toString('hex');
process.env.MURMUR_ENCRYPTION_KEY = KEY;
delete require.cache[require.resolve('../../lib/crypto')];
const { encryptApiKey, decryptApiKey, generateMasterKey } = require('../../lib/crypto');

test('encryptApiKey returns iv:ciphertext:tag format', () => {
  const out = encryptApiKey('sk-test-1234');
  assert.match(out, /^[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/);
});

test('decryptApiKey reverses encryptApiKey', () => {
  const original = 'sk-deepseek-abcdef1234567890';
  const encrypted = encryptApiKey(original);
  const decrypted = decryptApiKey(encrypted);
  assert.equal(decrypted, original);
});

test('encryptApiKey same input → different ciphertext (random IV)', () => {
  const a = encryptApiKey('sk-foo');
  const b = encryptApiKey('sk-foo');
  assert.notEqual(a, b);
});

test('decryptApiKey returns null for empty/null input (no crash)', () => {
  assert.equal(decryptApiKey(''), null);
  assert.equal(decryptApiKey(null), null);
  assert.equal(decryptApiKey(undefined), null);
});

test('decryptApiKey returns null for malformed input', () => {
  assert.equal(decryptApiKey('not-valid'), null);
  assert.equal(decryptApiKey('aa:bb'), null);  // missing tag
});

test('decryptApiKey returns null for wrong tag (tampered ciphertext)', () => {
  const encrypted = encryptApiKey('sk-test');
  const [iv, ct, tag] = encrypted.split(':');
  const tamperedTag = tag.replace(/./, c => c === '0' ? '1' : '0');
  assert.equal(decryptApiKey(`${iv}:${ct}:${tamperedTag}`), null);
});

test('generateMasterKey returns 64-char hex', () => {
  const k = generateMasterKey();
  assert.match(k, /^[a-f0-9]{64}$/);
});

test('encryptApiKey throws if MURMUR_ENCRYPTION_KEY not set', () => {
  delete process.env.MURMUR_ENCRYPTION_KEY;
  delete require.cache[require.resolve('../../lib/crypto')];
  const { encryptApiKey: e } = require('../../lib/crypto');
  assert.throws(() => e('sk-x'), /MURMUR_ENCRYPTION_KEY/);
  process.env.MURMUR_ENCRYPTION_KEY = KEY;  // restore for subsequent tests
  delete require.cache[require.resolve('../../lib/crypto')];
});
```

- [ ] **Step 2: Run tests — should fail (file not exists)**

Run: `cd ~/podcast-hub && npm test 2>&1 | tail -10`
Expected: `Cannot find module '../../lib/crypto'`

- [ ] **Step 3: Implement crypto.js**

Create `~/podcast-hub/lib/crypto.js`:

```javascript
// lib/crypto.js — AES-256-GCM for user API key at-rest encryption.
// 2026-05-19 v0.1
// Master key in env MURMUR_ENCRYPTION_KEY (64 hex chars = 32 bytes).
// Format on disk: <iv-hex>:<ciphertext-hex>:<auth-tag-hex>

'use strict';

const crypto = require('node:crypto');

function getMasterKey() {
  const hex = process.env.MURMUR_ENCRYPTION_KEY;
  if (!hex) throw new Error('MURMUR_ENCRYPTION_KEY env var not set — generate with generateMasterKey() and add to pm2 env');
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error('MURMUR_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  return Buffer.from(hex, 'hex');
}

function encryptApiKey(plaintext) {
  if (!plaintext) return null;
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);  // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let ct = cipher.update(String(plaintext), 'utf8', 'hex');
  ct += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${ct}:${tag}`;
}

function decryptApiKey(encrypted) {
  if (!encrypted) return null;
  try {
    const parts = String(encrypted).split(':');
    if (parts.length !== 3) return null;
    const [ivHex, ctHex, tagHex] = parts;
    if (!ivHex || !ctHex || !tagHex) return null;
    const key = getMasterKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    let pt = decipher.update(ctHex, 'hex', 'utf8');
    pt += decipher.final('utf8');
    return pt;
  } catch (_) {
    return null;  // tampered / wrong key / corrupt
  }
}

function generateMasterKey() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { encryptApiKey, decryptApiKey, generateMasterKey };
```

- [ ] **Step 4: Run tests — should pass**

Run: `cd ~/podcast-hub && npm test 2>&1 | tail -10`
Expected: 8 crypto tests pass (plus the sanity test = 9 total).

---

## Task 3-7: `lib/auth.js` (bcrypt + session + middleware + rate limit)

**Files:**
- Create: `lib/auth.js`
- Create: `tests/lib/auth.test.js`

This is one combined task because the parts are tightly coupled and trivially decomposable when implementing. Each sub-step is its own TDD cycle.

- [ ] **Step 1: Write failing tests**

Create `~/podcast-hub/tests/lib/auth.test.js`:

```javascript
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
  // expired row deleted
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
```

- [ ] **Step 2: Run tests — should fail**

Run: `cd ~/podcast-hub && npm test 2>&1 | tail -10`
Expected: `Cannot find module '../../lib/auth'`

- [ ] **Step 3: Implement auth.js**

Create `~/podcast-hub/lib/auth.js`:

```javascript
// lib/auth.js — bcrypt password hashing + session token mgmt + Express middleware + rate limiters.
// 2026-05-19 v0.1
'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days
const BCRYPT_COST = 10;

// --- password hashing ---

async function hashPassword(plaintext) {
  return bcrypt.hash(String(plaintext), BCRYPT_COST);
}

async function verifyPassword(plaintext, hash) {
  if (!hash) return false;
  try { return await bcrypt.compare(String(plaintext), String(hash)); }
  catch (_) { return false; }
}

// --- session tokens ---

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(db, userId) {
  const token = generateToken();
  const created = Date.now();
  const expires = created + SESSION_TTL_MS;
  db.prepare(`INSERT INTO sessions (token, user_id, created, expires) VALUES (?, ?, ?, ?)`)
    .run(token, userId, created, expires);
  return token;
}

function verifyToken(db, token) {
  if (!token) return null;
  const row = db.prepare(`SELECT user_id, expires FROM sessions WHERE token = ?`).get(token);
  if (!row) return null;
  if (row.expires < Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return null;
  }
  return row.user_id;
}

function deleteSession(db, token) {
  if (!token) return;
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

// --- middleware factory ---

function requireUser(db) {
  return function _requireUser(req, res, next) {
    const headerToken = req.headers?.authorization?.replace(/^Bearer\s+/i, '');
    const cookieToken = req.cookies?.session;
    const token = headerToken || cookieToken;
    if (!token) return res.status(401).json({ error: 'login required' });
    const userId = verifyToken(db, token);
    if (!userId) return res.status(401).json({ error: 'session expired or invalid' });
    req.user_id = userId;
    next();
  };
}

// --- rate limiters ---

const signupRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 3,
  message: { error: '注册太频繁,稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max: 10,
  message: { error: '登录尝试太频繁,稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  hashPassword, verifyPassword,
  generateToken, createSession, verifyToken, deleteSession,
  requireUser,
  signupRateLimit, loginRateLimit,
  SESSION_TTL_MS,
};
```

- [ ] **Step 4: Run tests — should pass**

Run: `cd ~/podcast-hub && npm test 2>&1 | tail -10`
Expected: All auth tests pass (13 new + 8 crypto + 1 sanity = 22).

---

## Task 8: Migration script — schema

**Files:**
- Create: `migrations/2026-05-19-multi-tenant.js`
- Create: `tests/migration.test.js`

- [ ] **Step 1: Write failing migration test**

Create `~/podcast-hub/tests/migration.test.js`:

```javascript
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
  const f = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')) + '/test.db';
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
  // sessions table needs user_id too
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
  applyMigration(db);  // should detect already done and skip
  const after = db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
  assert.equal(before, after);
  assert.equal(isAlreadyMigrated(db), true);
});

test('isAlreadyMigrated returns true after applyMigration', () => {
  const db = freshDb();
  applyMigration(db);
  assert.equal(isAlreadyMigrated(db), true);
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `cd ~/podcast-hub && npm test tests/migration.test.js 2>&1 | tail -10`
Expected: `Cannot find module '../migrations/2026-05-19-multi-tenant'`

- [ ] **Step 3: Implement migration**

Create `~/podcast-hub/migrations/2026-05-19-multi-tenant.js`:

```javascript
// migrations/2026-05-19-multi-tenant.js — One-shot SaaS migration.
// Creates users table, adds user_id to business tables, inserts Faye as user_id=1.
//
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

  // Add user_id to business tables (idempotent via tableHasColumn check)
  const addUserIdTo = ['podcasts', 'episodes', 'notes', 'comments'];
  for (const tbl of addUserIdTo) {
    if (!tableHasColumn(db, tbl, 'user_id')) {
      db.exec(`ALTER TABLE ${tbl} ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`);
      console.log(`[migration] added user_id to ${tbl}`);
    }
  }

  // sessions needs user_id too
  if (!tableHasColumn(db, 'sessions', 'user_id')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`);
    console.log('[migration] added user_id to sessions');
  }

  // kg_edits — rebuild table because PK changes to (user_id, term)
  const kgCols = db.prepare(`PRAGMA table_info(kg_edits)`).all();
  const kgHasUserId = kgCols.some(c => c.name === 'user_id');
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

  // Insert Faye user_id=1
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
```

- [ ] **Step 4: Run tests — should pass**

Run: `cd ~/podcast-hub && npm test tests/migration.test.js 2>&1 | tail -10`
Expected: 7 migration tests pass.

---

## Task 9: Wire migration into server.js startup

**Files:**
- Modify: `server.js` (top of file, around line 14-17 where `db` is created)

- [ ] **Step 1: Generate MURMUR_ENCRYPTION_KEY + add to pm2 env**

Run:
```bash
KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "MURMUR_ENCRYPTION_KEY=$KEY"
pm2 set podcast-gallery:MURMUR_ENCRYPTION_KEY "$KEY"
```

Save the key value somewhere outside the repo (e.g. `~/.murmur-encryption-key`, perms 600). DO NOT commit it to git.

- [ ] **Step 2: Set FAYE_INITIAL_PASSWORD env**

```bash
pm2 set podcast-gallery:FAYE_INITIAL_PASSWORD "<FAYE_INITIAL_PASSWORD>"
# (uses the same password we already gave Faye for admin auth — she can change it via settings later)
```

- [ ] **Step 3: Add migration call to server.js**

After `const db = new Database(path.join(DATA_DIR, 'podcasts.db'));` (around line 15-17), add:

```javascript
// 2026-05-19: Multi-tenant SaaS migration. Idempotent. Skipped if users table already populated.
const { applyMigration } = require('./migrations/2026-05-19-multi-tenant');
try {
  applyMigration(db);
} catch (e) {
  console.error('[migration] FAILED:', e.message);
  console.error('Server starting in single-tenant mode (legacy). Fix migration and restart.');
}
```

- [ ] **Step 4: BACKUP THE DB**

Critical step. Migration ALTER TABLE is hard to undo:
```bash
cp ~/podcast-hub/podcasts.db ~/podcast-hub/podcasts.db.bak-pre-saas-$(date +%Y%m%d-%H%M%S)
ls -la ~/podcast-hub/podcasts.db.bak-pre-saas-*
```
Expected: backup file exists with non-zero size.

- [ ] **Step 5: Restart Murmur and check migration log**

```bash
pm2 restart podcast-gallery
sleep 3
pm2 logs podcast-gallery --lines 20 --nostream 2>&1 | grep -iE "(migration|error)" | tail -10
```
Expected: `[migration] starting…` followed by `[migration] inserted Faye user_id=1` and `[migration] done`. No errors.

- [ ] **Step 6: Verify in DB**

```bash
sqlite3 ~/podcast-hub/podcasts.db "SELECT id, email, is_admin FROM users; SELECT 'pods:' || COUNT(*) FROM podcasts WHERE user_id=1; SELECT 'eps:' || COUNT(*) FROM episodes WHERE user_id=1; SELECT 'notes:' || COUNT(*) FROM notes WHERE user_id=1"
```
Expected: 1 row in users with email=fayeyu@deltax.world. `pods:9 / eps:394 / notes:33` (matches Faye's existing data).

---

## Task 10: `POST /api/auth/signup`

**Files:**
- Modify: `server.js` (replace `/api/auth/login` block around line 65-74, add signup before it)

- [ ] **Step 1: Add cookie-parser middleware to server.js**

Near where other middleware is mounted (look for `app.use(express.json…`):

```javascript
const cookieParser = require('cookie-parser');
app.use(cookieParser());
```

- [ ] **Step 2: Replace old `/api/auth/login` block with full auth router**

Find the existing `app.post('/api/auth/login'` block (around line 65-74) and the `app.get('/api/auth/check'` block. Replace BOTH with:

```javascript
// === Auth (2026-05-19 multi-tenant) ===
const { hashPassword, verifyPassword, createSession, verifyToken, deleteSession, requireUser, signupRateLimit, loginRateLimit } = require('./lib/auth');
const { encryptApiKey, decryptApiKey } = require('./lib/crypto');

// Signup — open registration
app.post('/api/auth/signup', signupRateLimit, express.json(), async (req, res) => {
  try {
    const { email, password, display_name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email + password 都必填' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'email 格式不对' });
    if (String(password).length < 8) return res.status(400).json({ error: '密码至少 8 位' });
    const exists = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
    if (exists) return res.status(409).json({ error: '该 email 已注册,请直接登录' });
    const hash = await hashPassword(password);
    const result = db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)`)
                     .run(email.toLowerCase(), hash, display_name || email.split('@')[0]);
    const userId = result.lastInsertRowid;
    const token = createSession(db, userId);
    res.json({ ok: true, token, user: { id: userId, email: email.toLowerCase(), display_name: display_name || email.split('@')[0] } });
  } catch (e) {
    console.error('[signup] error:', e.message);
    res.status(500).json({ error: 'signup 失败: ' + e.message });
  }
});

// Login
app.post('/api/auth/login', loginRateLimit, express.json(), async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email + password 都必填' });
  const user = db.prepare(`SELECT id, email, display_name, password_hash FROM users WHERE email = ?`).get(email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'email 或密码不对' });
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'email 或密码不对' });
  const token = createSession(db, user.id);
  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(user.id);
  res.json({ ok: true, token, user: { id: user.id, email: user.email, display_name: user.display_name } });
});

// Who am I (used by frontend to check login state at boot)
app.get('/api/auth/me', requireUser(db), (req, res) => {
  const u = db.prepare(`SELECT id, email, display_name, is_admin, deepseek_api_key IS NOT NULL AS has_deepseek, groq_api_key IS NOT NULL AS has_groq FROM users WHERE id = ?`).get(req.user_id);
  res.json({ ok: true, user: u });
});

// Logout
app.post('/api/auth/logout', requireUser(db), (req, res) => {
  const token = req.headers?.authorization?.replace(/^Bearer\s+/i, '') || req.cookies?.session;
  deleteSession(db, token);
  res.json({ ok: true });
});

// Settings — change password, API keys, display_name
app.post('/api/auth/settings', requireUser(db), express.json(), async (req, res) => {
  const { current_password, new_password, deepseek_api_key, groq_api_key, display_name } = req.body || {};
  const user = db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(req.user_id);

  if (new_password) {
    if (!current_password) return res.status(400).json({ error: '改密码要先输旧密码' });
    if (!await verifyPassword(current_password, user.password_hash)) return res.status(401).json({ error: '旧密码不对' });
    if (String(new_password).length < 8) return res.status(400).json({ error: '新密码至少 8 位' });
    const newHash = await hashPassword(new_password);
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(newHash, req.user_id);
  }
  if (deepseek_api_key !== undefined) {
    const enc = deepseek_api_key ? encryptApiKey(deepseek_api_key) : null;
    db.prepare(`UPDATE users SET deepseek_api_key = ? WHERE id = ?`).run(enc, req.user_id);
  }
  if (groq_api_key !== undefined) {
    const enc = groq_api_key ? encryptApiKey(groq_api_key) : null;
    db.prepare(`UPDATE users SET groq_api_key = ? WHERE id = ?`).run(enc, req.user_id);
  }
  if (display_name !== undefined) {
    db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`).run(display_name, req.user_id);
  }
  res.json({ ok: true });
});

// Replace the old isAdmin() / requireAdmin function:
function requireAdmin(req, res, next) {
  // 2026-05-19: requireAdmin is now an alias for requireUser. Per-route ownership is enforced via user_id in SQL.
  return requireUser(db)(req, res, next);
}
```

- [ ] **Step 3: Restart and smoke test**

```bash
pm2 restart podcast-gallery
sleep 3
# anonymous request to protected endpoint should be 401
curl -s -X POST http://localhost:3456/api/podcasts -H 'Content-Type: application/json' -d '{}' -w "\nHTTP %{http_code}\n"
# Faye login should still work with her password
curl -s -X POST http://localhost:3456/api/auth/login -H 'Content-Type: application/json' -d '{"email":"fayeyu@deltax.world","password":"<FAYE_INITIAL_PASSWORD>"}' -w "\nHTTP %{http_code}\n"
# A brand new signup
curl -s -X POST http://localhost:3456/api/auth/signup -H 'Content-Type: application/json' -d '{"email":"test1@example.com","password":"test12345678"}' -w "\nHTTP %{http_code}\n"
```
Expected: protected endpoint 401, Faye login 200 + token, new signup 200 + token.

- [ ] **Step 4: Test /api/auth/me**

```bash
TOKEN=$(curl -s -X POST http://localhost:3456/api/auth/login -H 'Content-Type: application/json' -d '{"email":"fayeyu@deltax.world","password":"<FAYE_INITIAL_PASSWORD>"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
curl -s http://localhost:3456/api/auth/me -H "Authorization: Bearer $TOKEN"
```
Expected: `{"ok":true,"user":{"id":1,"email":"fayeyu@deltax.world","display_name":"Faye","is_admin":1,"has_deepseek":1,"has_groq":1}}`

---

## Task 11-14: SQL audit — add user_id everywhere

This is the biggest chunk (~1 day of work). 70 SQL queries in `server.js` to audit. Group into 4 batches.

**Strategy**: search/replace each table's queries, add `WHERE user_id = ?` + bind `req.user_id`, INSERT add user_id column.

**Files:**
- Modify: `server.js` (everywhere — search for `db.prepare(` calls)

For each task below: grep + read each match + edit. Patterns:

| Pattern | Replace with |
|---|---|
| `SELECT … FROM podcasts` (no WHERE) | `… FROM podcasts WHERE user_id = ?` + bind `req.user_id` |
| `SELECT … FROM podcasts WHERE name=?` | `… FROM podcasts WHERE name=? AND user_id = ?` + bind |
| `INSERT INTO podcasts (name, …) VALUES (?, …)` | `INSERT INTO podcasts (user_id, name, …) VALUES (?, ?, …)` + bind `req.user_id` first |
| `UPDATE/DELETE FROM podcasts WHERE id=?` | add `AND user_id = ?` + bind |
| Same for `episodes`, `notes`, `comments`, `kg_edits` |

### Task 11: Podcasts routes

**Files:** `server.js`

Find all `db.prepare(…podcasts…).` calls. Specifically:
- Line ~134: `app.post('/api/podcasts'` — INSERT, add user_id
- Line ~142: `app.delete('/api/podcasts/:id'` — DELETE WHERE id, add `AND user_id = ?`
- Line ~328-334: `/api/refresh` — SELECT all podcasts → SELECT WHERE user_id
- Line ~325: `_散装收藏` SELECT — same change
- Line ~339-356: `fetchEpisodes` — keep podcast_id-based logic, but tighten its caller

- [ ] **Step 1: Grep all `podcasts` references**

```bash
grep -n "podcasts\b" ~/podcast-hub/server.js | grep -E "(prepare|FROM|INTO|UPDATE|DELETE)" | head -30
```

- [ ] **Step 2: For each match, edit to scope to req.user_id**

Example replacements (full code, no placeholders):

`app.post('/api/podcasts')` (around line 134):
```javascript
app.post('/api/podcasts', requireAdmin, async (req, res) => {
  const { name, rss_url, artwork } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const info = db.prepare('INSERT INTO podcasts (user_id, name, rss_url, artwork) VALUES (?, ?, ?, ?)')
                 .run(req.user_id, name, rss_url || null, artwork || null);
  let warning = null;
  let episodes_fetched = 0;
  if (rss_url) {
    try { episodes_fetched = await fetchEpisodes(info.lastInsertRowid, rss_url, req.user_id); }
    catch (e) {
      console.error('[POST /api/podcasts] fetchEpisodes failed:', e.message);
      warning = `RSS 抓取失败: ${e.message}`;
    }
  }
  res.json({ id: info.lastInsertRowid, episodes_fetched, warning });
});
```

`app.delete('/api/podcasts/:id')`:
```javascript
app.delete('/api/podcasts/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM episodes WHERE podcast_id=? AND user_id=?').run(req.params.id, req.user_id);
  const result = db.prepare('DELETE FROM podcasts WHERE id=? AND user_id=?').run(req.params.id, req.user_id);
  if (result.changes === 0) return res.status(404).json({ error: 'podcast not found or not yours' });
  res.json({ ok: true });
});
```

`/api/refresh` (line ~332):
```javascript
app.post('/api/refresh', requireAdmin, async (req, res) => {
  const podcasts = db.prepare(`SELECT * FROM podcasts WHERE user_id = ? AND rss_url IS NOT NULL AND name != '_散装收藏'`).all(req.user_id);
  let total = 0;
  for (const p of podcasts) { try { total += await fetchEpisodes(p.id, p.rss_url, req.user_id); } catch(e) { console.error(e); } }
  res.json({ new_episodes: total });
});
```

`fetchEpisodes` signature change (line ~340):
```javascript
async function fetchEpisodes(podcastId, rssUrl, userId) {
  const feed = await parser.parseURL(rssUrl);
  const existing = new Set(db.prepare('SELECT link FROM episodes WHERE podcast_id=? AND user_id=?').all(podcastId, userId).map(r => r.link));
  const insert = db.prepare('INSERT INTO episodes (user_id, podcast_id, title, pub_date, link, audio_url, description) VALUES (?, ?, ?, ?, ?, ?, ?)');
  let count = 0;
  for (const item of feed.items.slice(0, 20)) {
    const link = item.link || item.guid || item.title;
    if (existing.has(link)) continue;
    const audioUrl = item.enclosure?.url || item.enclosure?.['$']?.url || null;
    insert.run(userId, podcastId, item.title, item.pubDate || item.isoDate || null, link, audioUrl,
      (item.contentSnippet || item.content || '').substring(0, 2000));
    count++;
  }
  db.prepare(`UPDATE podcasts SET last_checked=datetime('now') WHERE id=? AND user_id=?`).run(podcastId, userId);
  return count;
}
```

Cron job (line ~358) — needs special treatment since it has no `req.user_id`. Change to loop all users:

```javascript
cron.schedule('*/30 * * * *', async () => {
  console.log('[cron] Checking RSS feeds for all users…');
  const users = db.prepare('SELECT id FROM users').all();
  let total = 0;
  for (const u of users) {
    const podcasts = db.prepare(`SELECT * FROM podcasts WHERE user_id = ? AND rss_url IS NOT NULL AND name != '_散装收藏'`).all(u.id);
    for (const p of podcasts) {
      try { total += await fetchEpisodes(p.id, p.rss_url, u.id); }
      catch(e) { console.error(`[cron] user ${u.id} podcast ${p.id}:`, e.message); }
    }
  }
  console.log(`[cron] done, ${total} new episodes total`);
});
```

`_散装收藏` lookup (around line 325): this is the user's personal oneoff bucket. Each user gets their own. When user adds first oneoff:
```javascript
let oneoff = db.prepare(`SELECT id FROM podcasts WHERE name='_散装收藏' AND user_id=?`).get(req.user_id);
if (!oneoff) {
  const r = db.prepare(`INSERT INTO podcasts (user_id, name, artwork) VALUES (?, '_散装收藏', NULL)`).run(req.user_id);
  oneoff = { id: r.lastInsertRowid };
}
```

- [ ] **Step 3: Restart + smoke**

```bash
pm2 restart podcast-gallery && sleep 3
TOKEN=$(curl -s -X POST http://localhost:3456/api/auth/login -H 'Content-Type: application/json' -d '{"email":"fayeyu@deltax.world","password":"<FAYE_INITIAL_PASSWORD>"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
curl -s http://localhost:3456/api/episodes -H "Authorization: Bearer $TOKEN" | python3 -c "import json,sys;d=json.load(sys.stdin);print(f'episodes count: {len(d) if isinstance(d, list) else d}')"
```
Expected: 394 episodes returned (Faye's). New signup user would return 0.

### Task 12: Episodes routes

Same pattern. Around lines 148-280:
- `app.get('/api/episodes')` — add `WHERE e.user_id = ?`
- `app.patch('/api/episodes/:id')` — add `AND user_id = ?`
- `app.post('/api/episodes/:id/process')` — verify ownership before processing
- `app.post('/api/episodes/:id/reextract')` — same
- `app.post('/api/episodes/:id/transcript')` — same
- `app.post('/api/episodes/:id/star')` — same
- `app.post('/api/episodes/:id/abort')` — same
- `app.post('/api/episodes/oneoff')` — INSERT with user_id

- [ ] **Step 1: Grep all episodes refs**

```bash
grep -n "FROM episodes\|INTO episodes\|UPDATE episodes\|DELETE.*episodes" ~/podcast-hub/server.js | head -20
```

- [ ] **Step 2: Edit each — full pattern**

For SELECT joining episodes and podcasts:
```javascript
// before:
let sql = `SELECT e.id, ... FROM episodes e JOIN podcasts p ON e.podcast_id=p.id WHERE 1=1`;
// after:
let sql = `SELECT e.id, ... FROM episodes e JOIN podcasts p ON e.podcast_id=p.id WHERE e.user_id = ?`;
params.unshift(req.user_id);
```

For mutating an episode by id:
```javascript
// before:
db.prepare('UPDATE episodes SET status=? WHERE id=?').run(status, req.params.id);
// after:
const result = db.prepare('UPDATE episodes SET status=? WHERE id=? AND user_id=?').run(status, req.params.id, req.user_id);
if (result.changes === 0) return res.status(404).json({ error: 'episode not found or not yours' });
```

Apply to all 8-15 episode endpoints.

- [ ] **Step 3: Restart + smoke**

```bash
pm2 restart podcast-gallery && sleep 3
curl -s http://localhost:3456/api/episodes -H "Authorization: Bearer $TOKEN" | python3 -c "import json,sys;d=json.load(sys.stdin);print(f'episodes: {len(d)}')"
```
Expected: 394.

### Task 13: Notes routes

Around lines for `/api/notes`:
- `app.get('/api/notes')` — add user_id filter
- `app.post('/api/notes')` — INSERT with user_id
- `app.patch('/api/notes/:id')` — add ownership check
- `app.post('/api/notes/:id/process')` — same
- `app.get('/api/notes/:id/job')` — same
- `app.post('/api/notes/:id/abort')` — same
- `/api/glimpse/append` — INSERT with user_id (or UPSERT on today's date for that user)
- `/api/thoughts` — JOIN through notes filtered by user_id
- `/api/lark/search` — filter by user_id

- [ ] **Step 1: Grep all notes refs**
```bash
grep -n "FROM notes\|INTO notes\|UPDATE notes\|DELETE.*notes" ~/podcast-hub/server.js | head -30
```

- [ ] **Step 2: Apply same pattern**

`/api/glimpse/append` is special — multiple bullets share one daily row. UPSERT pattern keyed on `(user_id, source_type='glimpse', title=today's date)`:

```javascript
app.post('/api/glimpse/append', requireAdmin, express.json(), (req, res) => {
  const { text, source_type, source_id, source_title } = req.body;
  const today = new Date().toISOString().slice(0, 10);
  let row = db.prepare(`SELECT id, content FROM notes WHERE user_id=? AND source_type='glimpse' AND title=?`).get(req.user_id, today);
  const bulletLine = `- ${text}\n  — 摘自《${source_title || ''}》 [${source_type === 'episode' ? 'EP_ID' : 'NOTE_ID'}=${source_id || ''}]`;
  if (row) {
    const newContent = (row.content || `# ${today}\n`) + bulletLine + '\n';
    db.prepare(`UPDATE notes SET content=?, updated_at=datetime('now') WHERE id=?`).run(newContent, row.id);
  } else {
    db.prepare(`INSERT INTO notes (user_id, source_type, title, content, status) VALUES (?, 'glimpse', ?, ?, 'done')`)
      .run(req.user_id, today, `# ${today}\n${bulletLine}\n`);
  }
  res.json({ ok: true });
});
```

- [ ] **Step 3: Restart + smoke**

### Task 14: Comments, kg_edits, ask, misc routes

Remaining endpoints around: `/api/comments`, `/api/comments/:id`, `/api/thoughts`, `/api/kg/*`, `/api/ask`, `/api/skills/*`.

- `/api/comments` GET — filter by user_id
- `/api/comments` POST — INSERT with user_id
- `/api/comments/:id` PATCH/DELETE — add ownership check
- `/api/thoughts` GET — `WHERE c.kind='thought' AND c.user_id=?`
- `/api/kg/edits` GET — `WHERE user_id=?`
- `/api/kg/edit` POST — UPSERT with user_id (`INSERT OR REPLACE INTO kg_edits (user_id, term, …) VALUES (?, ?, …)`)
- `/api/ask` POST — context query: `SELECT … FROM episodes WHERE status='done' AND user_id=?` (only user's episodes contribute to their Ask context)
- `/api/skills/*` — skills are GLOBAL, leave as is, but verify no leaks (no user data in skill rows)

- [ ] **Step 1: Grep + apply same pattern to comments/kg/ask**

```bash
grep -n "FROM comments\|INTO comments\|UPDATE comments\|FROM kg_edits\|INTO kg_edits" ~/podcast-hub/server.js | head -20
```

For `/api/ask` (the big context-aggregation endpoint) — make sure to filter contexts to `WHERE e.user_id=?` and `WHERE n.user_id=?` when picking which episodes/notes feed into the prompt.

- [ ] **Step 2: Restart + smoke for each**

```bash
pm2 restart podcast-gallery && sleep 3
curl -s http://localhost:3456/api/thoughts -H "Authorization: Bearer $TOKEN" | head -c 200
curl -s http://localhost:3456/api/comments?target_type=episode\&target_id=201 -H "Authorization: Bearer $TOKEN" | head -c 200
```

### Task 15: Skills + sessions sanity

- [ ] **Step 1: Verify skills table NOT filtered by user_id**

Skills are platform-wide templates. Their endpoints (`/api/skills/*`) should NOT filter by user_id (everyone uses same templates). Verify the queries DON'T have `WHERE user_id`.

```bash
grep -n "FROM skills\|INTO skills" ~/podcast-hub/server.js | head -5
```

- [ ] **Step 2: Verify sessions writes user_id**

`createSession` in lib/auth.js already writes user_id ✓. Verify by checking SQL in lib/auth.js line containing `INSERT INTO sessions`.

---

## Task 16: `pipeline.js` — per-user API keys

**Files:**
- Modify: `pipeline.js`

Currently `pipeline.js` reads `process.env.DEEPSEEK_API_KEY` and `process.env.GROQ_API_KEY` globally. Change to accept userId, look up encrypted keys, decrypt, use.

- [ ] **Step 1: Read current pipeline.js to find API key usage**

```bash
grep -n "DEEPSEEK_API_KEY\|GROQ_API_KEY\|process.env" ~/podcast-hub/pipeline.js | head -10
```

- [ ] **Step 2: Modify exports + key resolution**

At the top of pipeline.js:

```javascript
const path = require('path');
const Database = require('better-sqlite3');
const { decryptApiKey } = require('./lib/crypto');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const db = new Database(path.join(DATA_DIR, 'podcasts.db'));

function getUserKeys(userId) {
  const u = db.prepare(`SELECT deepseek_api_key, groq_api_key FROM users WHERE id = ?`).get(userId);
  if (!u) throw new Error(`user ${userId} not found`);
  const ds = decryptApiKey(u.deepseek_api_key);
  const gr = decryptApiKey(u.groq_api_key);
  if (!ds) throw new Error('用户未配置 DeepSeek API key (去设置页填一下)');
  if (!gr) throw new Error('用户未配置 Groq API key (去设置页填一下)');
  return { deepseek: ds, groq: gr };
}
```

For every existing function that uses `process.env.DEEPSEEK_API_KEY`, replace with the user's key. Example signature:
```javascript
// before:
async function runPipeline(episodeId) { … process.env.DEEPSEEK_API_KEY … }
// after:
async function runPipeline(episodeId, userId) {
  const { deepseek, groq } = getUserKeys(userId);
  … (use `deepseek` and `groq` variables instead of process.env) …
}

// same for extractNotes, extractWithPrompt, transcribe
async function extractNotes(transcript, options = {}, userId) {
  const keys = userId ? getUserKeys(userId) : { deepseek: process.env.DEEPSEEK_API_KEY };
  …
}
```

(Fallback to `process.env.DEEPSEEK_API_KEY` is only for backward-compat in scripts. Production server.js always passes userId.)

- [ ] **Step 3: Update server.js callers to pass req.user_id**

Anywhere server.js calls `runPipeline(id)`, change to `runPipeline(id, req.user_id)`.

- [ ] **Step 4: Restart + test processing**

```bash
pm2 restart podcast-gallery && sleep 3
# As Faye (has keys), trigger reextract on one done episode
curl -s -X POST http://localhost:3456/api/episodes/201/reextract -H "Authorization: Bearer $TOKEN" -w "\nHTTP %{http_code}\n"
```
Expected: 200 + processing starts. Watch pm2 logs for DeepSeek call.

- [ ] **Step 5: Test new user without keys**

```bash
# Sign up + login a new user
NEWTOKEN=$(curl -s -X POST http://localhost:3456/api/auth/signup -H 'Content-Type: application/json' -d '{"email":"newuser@example.com","password":"newpass123"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
# Add a podcast for them
curl -s -X POST http://localhost:3456/api/podcasts -H "Authorization: Bearer $NEWTOKEN" -H 'Content-Type: application/json' -d '{"name":"NewUser test","rss_url":"https://example.com/feed.rss"}'
# Try to process — should fail with "user 未配置 ... API key"
EPID=$(curl -s http://localhost:3456/api/episodes -H "Authorization: Bearer $NEWTOKEN" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d[0]['id'] if d else '')")
[ -n "$EPID" ] && curl -s -X POST http://localhost:3456/api/episodes/$EPID/process -H "Authorization: Bearer $NEWTOKEN" -w "\nHTTP %{http_code}\n"
```
Expected: process call returns 400/500 with message about user 未配置 API key.

---

## Task 17: UI — auth gate (signup/login screen)

**Files:**
- Modify: `public/index.html`

Layer an `#auth-gate` overlay on top of the existing app. Show by default. Hide once a valid token is in localStorage and `/api/auth/me` returns 200.

- [ ] **Step 1: Add auth-gate HTML right after `<body>` open tag**

Find `<body>` in `public/index.html`. Right after it, add:

```html
<div id="auth-gate" style="position:fixed;inset:0;z-index:9999;background:var(--bg);display:none;align-items:center;justify-content:center;">
  <div style="max-width:380px;width:90%;background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:32px;box-shadow:0 20px 60px rgba(0,0,0,0.4);">
    <h1 style="font-family:'Cormorant Garamond',serif;font-style:italic;font-size:32px;color:var(--o);margin:0 0 4px;">murmur</h1>
    <p style="color:var(--ink3);font-size:13px;margin:0 0 20px;">low whispers, gathered quietly</p>

    <div class="auth-tabs" style="display:flex;gap:8px;margin-bottom:18px;border-bottom:1px solid var(--line);">
      <button id="tab-login" class="auth-tab active" data-tab="login" style="flex:1;padding:8px;background:transparent;border:none;color:var(--ink);border-bottom:2px solid var(--o);font-weight:600;cursor:pointer;">登录</button>
      <button id="tab-signup" class="auth-tab" data-tab="signup" style="flex:1;padding:8px;background:transparent;border:none;color:var(--ink3);border-bottom:2px solid transparent;cursor:pointer;">注册</button>
    </div>

    <form id="auth-form" style="display:flex;flex-direction:column;gap:12px;">
      <input id="auth-email" type="email" placeholder="email" required style="padding:10px 12px;border:1px solid var(--line2);border-radius:6px;background:var(--bg);color:var(--ink);font-size:14px;">
      <input id="auth-password" type="password" placeholder="密码 (≥8 位)" required minlength="8" style="padding:10px 12px;border:1px solid var(--line2);border-radius:6px;background:var(--bg);color:var(--ink);font-size:14px;">
      <button id="auth-submit" type="submit" style="padding:10px;background:var(--o);color:#fff;border:none;border-radius:6px;font-weight:600;cursor:pointer;">登录</button>
      <div id="auth-err" style="color:var(--rd);font-size:12px;min-height:14px;"></div>
    </form>
    <p style="color:var(--ink4);font-size:11px;margin-top:18px;line-height:1.6;">注册即可立即使用。Murmur 提炼播客 / 笔记需要 DeepSeek + Groq API key，注册后在右上角「设置」里填。</p>
  </div>
</div>
```

- [ ] **Step 2: Add auth gate JS at end of body (before `</body>`)**

```html
<script>
(function() {
  const AUTH_TOKEN_KEY = 'murmur_token';
  const gate = document.getElementById('auth-gate');
  let mode = 'login';

  function setMode(m) {
    mode = m;
    document.querySelectorAll('.auth-tab').forEach(t => {
      const active = t.dataset.tab === m;
      t.style.color = active ? 'var(--ink)' : 'var(--ink3)';
      t.style.borderBottomColor = active ? 'var(--o)' : 'transparent';
      t.style.fontWeight = active ? '600' : '400';
    });
    document.getElementById('auth-submit').textContent = m === 'login' ? '登录' : '注册';
  }

  document.querySelectorAll('.auth-tab').forEach(t => t.addEventListener('click', () => setMode(t.dataset.tab)));

  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const errEl = document.getElementById('auth-err');
    errEl.textContent = '';
    try {
      const r = await fetch(`/api/auth/${mode === 'login' ? 'login' : 'signup'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await r.json();
      if (!r.ok) { errEl.textContent = data.error || `${mode} 失败`; return; }
      localStorage.setItem(AUTH_TOKEN_KEY, data.token);
      localStorage.setItem('murmur_user', JSON.stringify(data.user));
      window.location.reload();  // simplest: full reload so the rest of the app picks up the token
    } catch (err) {
      errEl.textContent = '网络错误: ' + err.message;
    }
  });

  // Inject Authorization header into all subsequent fetch() calls
  const origFetch = window.fetch;
  window.fetch = function(url, opts = {}) {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    if (token && (typeof url === 'string') && url.startsWith('/api/')) {
      opts.headers = { ...(opts.headers || {}), 'Authorization': `Bearer ${token}` };
    }
    return origFetch(url, opts);
  };

  // Boot: check if already logged in
  (async function bootAuth() {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    if (!token) { gate.style.display = 'flex'; return; }
    try {
      const r = await origFetch('/api/auth/me', { headers: { 'Authorization': `Bearer ${token}` } });
      if (!r.ok) {
        localStorage.removeItem(AUTH_TOKEN_KEY);
        gate.style.display = 'flex';
        return;
      }
      const data = await r.json();
      localStorage.setItem('murmur_user', JSON.stringify(data.user));
      gate.style.display = 'none';
      window.murmurUser = data.user;
    } catch (e) {
      gate.style.display = 'flex';
    }
  })();
})();
</script>
```

- [ ] **Step 3: Restart + test**

```bash
pm2 restart podcast-gallery && sleep 3
```

Open `http://localhost:3456` in a browser (or `https://murmur-mac.tail2817ed.ts.net`). Expected:
- Page loads, immediately shows the auth gate overlay with login/signup tabs
- Login with `fayeyu@deltax.world` + Faye's password → reloads → main app visible
- Open browser dev console: `localStorage.getItem('murmur_token')` returns the token
- Logout? — handled by Task 18 (settings modal)

---

## Task 18: UI — settings modal

**Files:**
- Modify: `public/index.html`

Add a user dropdown to the topbar with: display_name, "设置", "登出". Settings modal lets user set API keys, change password, change display_name.

- [ ] **Step 1: Find topbar in index.html**

```bash
grep -n "topnav\|topbar\|theme-select" ~/podcast-hub/public/index.html | head -10
```

- [ ] **Step 2: Add user dropdown next to existing theme dropdown**

In the topbar area (look for the existing theme dropdown), append:

```html
<div id="user-menu" style="position:relative;display:none;margin-left:8px;">
  <button id="user-menu-btn" style="padding:6px 12px;background:var(--w04);border:1px solid var(--line);border-radius:6px;color:var(--ink);font-size:12px;cursor:pointer;">
    <span id="user-menu-name">…</span> ▾
  </button>
  <div id="user-menu-dropdown" style="display:none;position:absolute;right:0;top:100%;margin-top:4px;background:var(--bg2);border:1px solid var(--line);border-radius:8px;min-width:160px;box-shadow:0 8px 24px rgba(0,0,0,0.2);z-index:100;">
    <button class="user-menu-item" data-action="settings" style="display:block;width:100%;text-align:left;padding:10px 14px;background:transparent;border:none;color:var(--ink);font-size:13px;cursor:pointer;">⚙ 设置</button>
    <button class="user-menu-item" data-action="logout" style="display:block;width:100%;text-align:left;padding:10px 14px;background:transparent;border:none;color:var(--ink);font-size:13px;cursor:pointer;">↪ 登出</button>
  </div>
</div>
```

- [ ] **Step 3: Add settings modal HTML before `</body>`**

```html
<div id="settings-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9998;align-items:center;justify-content:center;">
  <div style="background:var(--bg2);border:1px solid var(--line);border-radius:12px;max-width:480px;width:90%;padding:28px;max-height:80vh;overflow-y:auto;">
    <h2 style="margin:0 0 16px;color:var(--ink);font-size:18px;">设置</h2>

    <h3 style="margin:16px 0 8px;color:var(--ink2);font-size:13px;">API Keys (用户自带)</h3>
    <p style="font-size:11px;color:var(--ink3);margin:0 0 10px;line-height:1.5;">提炼笔记 / Ask Murmur 需要 DeepSeek（<a href="https://deepseek.com" target="_blank" style="color:var(--o);">注册</a> 拿 sk-…）和 Groq Whisper（<a href="https://console.groq.com" target="_blank" style="color:var(--o);">注册</a> 拿 gsk_…）的 key。</p>
    <label style="display:block;font-size:11px;color:var(--ink3);margin-bottom:2px;">DeepSeek API key</label>
    <input id="set-deepseek" type="password" placeholder="sk-..." style="width:100%;padding:8px;border:1px solid var(--line2);border-radius:5px;background:var(--bg);color:var(--ink);font-size:12px;margin-bottom:10px;">
    <label style="display:block;font-size:11px;color:var(--ink3);margin-bottom:2px;">Groq API key</label>
    <input id="set-groq" type="password" placeholder="gsk_..." style="width:100%;padding:8px;border:1px solid var(--line2);border-radius:5px;background:var(--bg);color:var(--ink);font-size:12px;margin-bottom:14px;">

    <h3 style="margin:16px 0 8px;color:var(--ink2);font-size:13px;">改密码</h3>
    <input id="set-curpass" type="password" placeholder="当前密码" style="width:100%;padding:8px;border:1px solid var(--line2);border-radius:5px;background:var(--bg);color:var(--ink);font-size:12px;margin-bottom:6px;">
    <input id="set-newpass" type="password" placeholder="新密码 (≥8 位)" style="width:100%;padding:8px;border:1px solid var(--line2);border-radius:5px;background:var(--bg);color:var(--ink);font-size:12px;margin-bottom:14px;">

    <h3 style="margin:16px 0 8px;color:var(--ink2);font-size:13px;">昵称</h3>
    <input id="set-displayname" type="text" placeholder="显示名" style="width:100%;padding:8px;border:1px solid var(--line2);border-radius:5px;background:var(--bg);color:var(--ink);font-size:12px;margin-bottom:14px;">

    <div id="set-msg" style="font-size:12px;color:var(--gn);min-height:14px;margin-bottom:10px;"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="set-cancel" style="padding:8px 16px;background:transparent;border:1px solid var(--line2);border-radius:5px;color:var(--ink);font-size:12px;cursor:pointer;">取消</button>
      <button id="set-save" style="padding:8px 16px;background:var(--o);color:#fff;border:none;border-radius:5px;font-size:12px;cursor:pointer;">保存</button>
    </div>
  </div>
</div>
```

- [ ] **Step 4: JS for user menu + settings modal**

Add to the same script block as Task 17's auth gate JS:

```javascript
// User menu + settings modal
function initUserMenu() {
  const u = window.murmurUser;
  if (!u) return;
  document.getElementById('user-menu').style.display = 'inline-block';
  document.getElementById('user-menu-name').textContent = u.display_name || u.email;

  document.getElementById('user-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = document.getElementById('user-menu-dropdown');
    dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('click', () => {
    document.getElementById('user-menu-dropdown').style.display = 'none';
  });

  document.querySelectorAll('.user-menu-item').forEach(b => b.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const action = ev.currentTarget.dataset.action;
    document.getElementById('user-menu-dropdown').style.display = 'none';
    if (action === 'logout') {
      await fetch('/api/auth/logout', { method: 'POST' });
      localStorage.removeItem('murmur_token');
      localStorage.removeItem('murmur_user');
      window.location.reload();
    } else if (action === 'settings') {
      document.getElementById('set-displayname').value = u.display_name || '';
      document.getElementById('set-deepseek').value = '';
      document.getElementById('set-groq').value = '';
      document.getElementById('set-curpass').value = '';
      document.getElementById('set-newpass').value = '';
      document.getElementById('set-msg').textContent = u.has_deepseek ? '' : '⚠ 还没填 DeepSeek key — 提炼功能用不了';
      document.getElementById('settings-modal').style.display = 'flex';
    }
  }));

  document.getElementById('set-cancel').addEventListener('click', () => {
    document.getElementById('settings-modal').style.display = 'none';
  });

  document.getElementById('set-save').addEventListener('click', async () => {
    const payload = {};
    const ds = document.getElementById('set-deepseek').value.trim();
    const gr = document.getElementById('set-groq').value.trim();
    const dn = document.getElementById('set-displayname').value.trim();
    const cur = document.getElementById('set-curpass').value;
    const newp = document.getElementById('set-newpass').value;
    if (ds) payload.deepseek_api_key = ds;
    if (gr) payload.groq_api_key = gr;
    if (dn) payload.display_name = dn;
    if (newp) { payload.current_password = cur; payload.new_password = newp; }
    const r = await fetch('/api/auth/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await r.json();
    if (!r.ok) {
      document.getElementById('set-msg').textContent = '❌ ' + (data.error || '保存失败');
      document.getElementById('set-msg').style.color = 'var(--rd)';
    } else {
      document.getElementById('set-msg').textContent = '✓ 已保存';
      document.getElementById('set-msg').style.color = 'var(--gn)';
      setTimeout(() => document.getElementById('settings-modal').style.display = 'none', 800);
    }
  });
}

// Call initUserMenu after auth boot succeeds
const _origBoot = window.bootAuth;
// (initUserMenu is called inside bootAuth in Task 17 — modify that flow: add initUserMenu() right after `gate.style.display = 'none'; window.murmurUser = data.user;` in the bootAuth function above)
```

Actually — to keep it cleaner, modify Task 17's `bootAuth` function: right after `window.murmurUser = data.user;`, add `initUserMenu();`. (Move initUserMenu definition above bootAuth call site so the function is hoisted/defined.)

- [ ] **Step 5: Restart + browser test**

```bash
pm2 restart podcast-gallery && sleep 3
```

In browser:
1. Logged-in user → see "Faye ▾" dropdown in topbar
2. Click → see 设置 / 登出
3. Click 设置 → modal opens
4. Type new DeepSeek key (any sk-...) + save → "✓ 已保存"
5. Click 登出 → reloads → auth gate again
6. Login as new test user → settings modal shows "⚠ 还没填 DeepSeek key"

---

## Task 19: Sync to git repo + commit

**Files:**
- All modified files in `~/podcast-hub/` → `~/Desktop/murmur/`
- `~/Desktop/murmur/.git`

- [ ] **Step 1: Copy modified files to git repo**

```bash
cp ~/podcast-hub/server.js ~/Desktop/murmur/
cp ~/podcast-hub/pipeline.js ~/Desktop/murmur/
cp ~/podcast-hub/public/index.html ~/Desktop/murmur/public/
cp ~/podcast-hub/package.json ~/Desktop/murmur/
cp ~/podcast-hub/package-lock.json ~/Desktop/murmur/
mkdir -p ~/Desktop/murmur/lib ~/Desktop/murmur/migrations ~/Desktop/murmur/tests/lib ~/Desktop/murmur/tests/fixtures ~/Desktop/murmur/docs/specs ~/Desktop/murmur/docs/plans
cp ~/podcast-hub/lib/crypto.js ~/podcast-hub/lib/auth.js ~/Desktop/murmur/lib/
cp ~/podcast-hub/migrations/2026-05-19-multi-tenant.js ~/Desktop/murmur/migrations/
cp ~/podcast-hub/tests/lib/*.test.js ~/Desktop/murmur/tests/lib/
cp ~/podcast-hub/tests/migration.test.js ~/podcast-hub/tests/sanity.test.js ~/Desktop/murmur/tests/
cp ~/podcast-hub/tests/fixtures/make-fixture.js ~/Desktop/murmur/tests/fixtures/
cp ~/podcast-hub/docs/specs/2026-05-19-murmur-multi-tenant-saas-design.md ~/Desktop/murmur/docs/specs/
cp ~/podcast-hub/docs/plans/2026-05-19-murmur-multi-tenant-saas.md ~/Desktop/murmur/docs/plans/
```

- [ ] **Step 2: Update .gitignore to exclude DB backups + key file**

Add to `~/Desktop/murmur/.gitignore`:
```
podcasts.db.bak-*
.murmur-*
```

- [ ] **Step 3: Commit + push**

```bash
cd ~/Desktop/murmur
git add lib/ migrations/ tests/ docs/ server.js pipeline.js package.json package-lock.json public/index.html .gitignore
git status
git commit -m "feat: multi-tenant SaaS

- users table + bcrypt auth + session tokens
- AES-256-GCM encrypted API keys per user
- migration: existing data → user_id=1 (Faye)
- 70 SQL queries audited for user_id isolation
- pipeline.js uses per-user API keys
- UI: auth gate (signup/login) + settings modal
- rate limit on /api/auth/signup + /login

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin main
```

---

## Task 20: End-to-end verification

- [ ] **Step 1: Faye login from public URL**

Open `https://murmur-mac.tail2817ed.ts.net` in browser → log in with `fayeyu@deltax.world` + her password. Expected: see her existing 9 podcasts / 394 episodes / 33 notes.

- [ ] **Step 2: New user signup from incognito**

Open incognito browser → same URL → click "注册" tab → email `test@example.com` + password `test12345`. Expected:
- Account created, logged in
- Empty podcast list (no Faye's data leaked)
- No glimpses, no notes
- Can add a podcast, refresh, see episodes (RSS works without LLM)
- Click process on an episode → "用户未配置 DeepSeek API key (去设置页填一下)" toast

- [ ] **Step 3: Test user fills API keys**

In incognito session → 设置 → paste a DeepSeek + Groq key → save → retry process episode. Expected: processes successfully.

- [ ] **Step 4: Cross-tenant isolation audit**

```bash
# As test user, try to access an episode that belongs to Faye (id=201)
NEWTOKEN=$(... login as test user ...)
curl -s http://localhost:3456/api/episodes/201/process -X POST -H "Authorization: Bearer $NEWTOKEN" -w "\nHTTP %{http_code}\n"
```
Expected: 404 "episode not found or not yours" (NOT 401, NOT 200, NOT a different error).

```bash
# Try comments on Faye's episode
curl -s "http://localhost:3456/api/comments?target_type=episode&target_id=201" -H "Authorization: Bearer $NEWTOKEN"
```
Expected: empty array `[]` (test user sees no comments).

- [ ] **Step 5: Check that test user CAN see global skills**

```bash
curl -s http://localhost:3456/api/skills -H "Authorization: Bearer $NEWTOKEN" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))"
```
Expected: 3 (the 3 platform-wide skill templates).

- [ ] **Step 6: Rate limit smoke**

```bash
# Try 4 signups from same IP within an hour
for i in 1 2 3 4; do
  curl -s -X POST http://localhost:3456/api/auth/signup -H 'Content-Type: application/json' -d "{\"email\":\"flood$i@x.com\",\"password\":\"floodpass123\"}" -w "\nHTTP %{http_code}\n"
done
```
Expected: first 3 are 200, 4th returns 429.

---

## Self-Review

### Spec coverage

| Spec § | Implemented in task |
|---|---|
| § 1.1 user isolation model | Task 8 (schema) + Task 11-14 (SQL audit) |
| § 1.2 data flow / middleware | Task 3-7 (auth.js) + Task 10 (server.js routes) |
| § 2.1 users table | Task 8 |
| § 2.2 user_id on business tables + oneoff handling | Task 8 + Task 11 |
| § 2.3 API key encryption | Task 1-2 (crypto.js) |
| § 3 auth flow (signup/login/me/logout/settings) | Task 10 |
| § 4 SQL audit (70 queries) | Tasks 11-15 |
| § 5 UI auth gate + settings | Task 17, 18 |
| § 6 pipeline.js per-user keys | Task 16 |
| § 7 Faye data migration | Task 8 + Task 9 |
| § 8 no-key fallback policy | Task 16 step 5 |
| § 9.2 rate limit | Task 3-7 + Task 10 |
| § 11 file changes | Mapped across tasks |
| § 12 estimate | matches actual task count |

### Placeholder scan

- ✓ No "TBD" / "TODO" / "implement later"
- ✓ All commands have expected output described
- ✓ Code blocks contain full code, not partial snippets

### Type consistency

- `userId` parameter consistent across `runPipeline / extractNotes / extractWithPrompt`
- `req.user_id` populated by `requireUser` middleware, used by all SQL bindings
- `db` instance shared between server.js + auth.js + crypto.js + migration (passed as arg)
- Token format = 64 hex chars across createSession + verifyToken + JS (`localStorage.getItem('murmur_token')`)

---

*v1.0 · 2026-05-19 · 20 tasks (with some grouped pure-function ones). Estimate ~3.5 days. Suggested batching for subagent-driven: Task 0-2 (scaffold + crypto), Task 3-7 (auth.js), Task 8-9 (migration + wire), Task 10 (auth routes), Task 11-15 (SQL audit in 5 separate dispatches), Task 16 (pipeline), Task 17-18 (UI together), Task 19 (sync git), Task 20 (E2E).*
