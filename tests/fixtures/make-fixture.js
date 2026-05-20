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
db.prepare(`INSERT INTO episodes (id, podcast_id, title, status, is_oneoff) VALUES (?, ?, ?, 'new', 1)`).run(202, 102, 'Oneoff Ep');
db.prepare(`INSERT INTO notes (id, source_type, title, content, status) VALUES (?, 'note', ?, ?, 'done')`).run(301, 'A note', 'content here');
db.prepare(`INSERT INTO notes (id, source_type, title, content, status) VALUES (?, 'glimpse', '2026-05-13', '# 2026-05-13\n- bullet', 'done')`).run(302);
db.prepare(`INSERT INTO comments (target_type, target_id, quote, kind) VALUES ('episode', 201, 'something', 'thought')`).run();

console.log('fixture written:', OUT);
db.close();
