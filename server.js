const express = require('express');
const Database = require('better-sqlite3');
const Parser = require('rss-parser');
const cron = require('node-cron');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const { runPipeline, extractNotes, extractWithPrompt } = require('./pipeline');

const crypto = require('crypto');
const app = express();
const parser = new Parser({ customFields: { item: [['enclosure', 'enclosure']] } });
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const db = new Database(path.join(DATA_DIR, 'podcasts.db'));
const TRANSCRIPTS_DIR = path.join(__dirname, 'transcripts');
if (!fs.existsSync(TRANSCRIPTS_DIR)) fs.mkdirSync(TRANSCRIPTS_DIR);

// --- Auth ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'fayeyu2026';
const sessions = new Map(); // token -> { created, expires }

function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function isAdmin(req) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() > s.expires) { sessions.delete(token); return false; }
  return true;
}
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'unauthorized', message: '需要管理员登录' });
}

// Login
app.post('/api/auth/login', express.json(), (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    const token = generateToken();
    sessions.set(token, { created: Date.now(), expires: Date.now() + 7 * 24 * 60 * 60 * 1000 }); // 7 days
    res.json({ ok: true, token });
  } else {
    res.status(401).json({ error: 'wrong password' });
  }
});

// Check auth status
app.get('/api/auth/check', (req, res) => {
  res.json({ isAdmin: isAdmin(req) });
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const jobs = new Map(); // episodeId -> progress
const jobProcesses = new Map(); // episodeId -> child process refs for abort

// Init DB
db.exec(`
  CREATE TABLE IF NOT EXISTS podcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, rss_url TEXT,
    artwork TEXT, last_checked TEXT, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, podcast_id INTEGER, title TEXT NOT NULL,
    pub_date TEXT, link TEXT, audio_url TEXT, description TEXT, status TEXT DEFAULT 'new',
    notes TEXT, transcript TEXT, is_oneoff INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (podcast_id) REFERENCES podcasts(id)
  );
`);
try { db.exec(`ALTER TABLE podcasts ADD COLUMN artwork TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE episodes ADD COLUMN is_oneoff INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE episodes ADD COLUMN transcript TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE episodes ADD COLUMN audio_url TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE episodes ADD COLUMN starred INTEGER DEFAULT 0`); } catch(e) {}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'PodcastGallery/1.0' } }, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

// --- API ---

app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  try {
    const data = await fetchJSON(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=podcast&limit=8&country=CN`);
    res.json((data.results || []).map(r => ({
      name: r.collectionName, artist: r.artistName, rss_url: r.feedUrl,
      artwork: r.artworkUrl100, episode_count: r.trackCount,
    })));
  } catch(e) { res.json([]); }
});

app.get('/api/podcasts', (req, res) => {
  res.json(db.prepare(`
    SELECT p.*, COUNT(e.id) as episode_count,
    SUM(CASE WHEN e.status='new' THEN 1 ELSE 0 END) as new_count
    FROM podcasts p LEFT JOIN episodes e ON e.podcast_id=p.id
    GROUP BY p.id ORDER BY p.created_at DESC
  `).all());
});

app.post('/api/podcasts', requireAdmin, async (req, res) => {
  const { name, rss_url, artwork } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const info = db.prepare('INSERT INTO podcasts (name, rss_url, artwork) VALUES (?, ?, ?)').run(name, rss_url || null, artwork || null);
  if (rss_url) { try { await fetchEpisodes(info.lastInsertRowid, rss_url); } catch(e) { console.error(e); } }
  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/podcasts/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM episodes WHERE podcast_id=?').run(req.params.id);
  db.prepare('DELETE FROM podcasts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/episodes', (req, res) => {
  const { podcast_id, status } = req.query;
  let sql = `SELECT e.id, e.podcast_id, e.title, e.pub_date, e.link, e.audio_url, e.description, e.status, e.notes, e.is_oneoff, e.starred, e.created_at, p.name as podcast_name, p.artwork as podcast_artwork FROM episodes e JOIN podcasts p ON e.podcast_id=p.id WHERE 1=1`;
  const params = [];
  if (podcast_id) { sql += ` AND e.podcast_id=?`; params.push(podcast_id); }
  if (status) { sql += ` AND e.status=?`; params.push(status); }
  sql += ` ORDER BY e.pub_date DESC, e.created_at DESC`;
  const rows = db.prepare(sql).all(...params);
  rows.forEach(r => { if (jobs.has(r.id)) r.job = jobs.get(r.id); });
  res.json(rows);
});

app.patch('/api/episodes/:id', requireAdmin, (req, res) => {
  const { status, notes } = req.body;
  if (status) db.prepare('UPDATE episodes SET status=? WHERE id=?').run(status, req.params.id);
  if (notes !== undefined) db.prepare('UPDATE episodes SET notes=? WHERE id=?').run(notes, req.params.id);
  res.json({ ok: true });
});

// ========== CORE: Start full auto pipeline ==========
app.post('/api/episodes/:id/process', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const ep = db.prepare(`SELECT e.*, p.name as podcast_name FROM episodes e JOIN podcasts p ON e.podcast_id=p.id WHERE e.id=?`).get(id);
  if (!ep) return res.status(404).json({ error: 'not found' });

  db.prepare('UPDATE episodes SET status=? WHERE id=?').run('processing', id);

  // Run pipeline async
  (async () => {
    try {
      if (ep.audio_url) {
        const procs = [];
        jobProcesses.set(id, procs);
        const result = await runPipeline(ep, ep.audio_url, (prog) => jobs.set(id, prog), (proc) => procs.push(proc));
        db.prepare('UPDATE episodes SET transcript=?, notes=?, status=? WHERE id=?').run(result.transcript, result.notes, 'done', id);
      } else {
        // No audio URL: just mark as needing manual transcript
        jobs.set(id, { step: 'no_audio', progress: 0, message: '该集没有音频链接，请手动上传逐字稿' });
        db.prepare('UPDATE episodes SET status=? WHERE id=?').run('confirmed', id);
        setTimeout(() => jobs.delete(id), 30000);
        return;
      }
      jobProcesses.delete(id);
      jobs.set(id, { step: 'done', progress: 100, message: '全部完成！' });
      setTimeout(() => jobs.delete(id), 60000);
    } catch (err) {
      jobProcesses.delete(id);
      console.error(`Pipeline error for ep ${id}:`, err);
      jobs.set(id, { step: 'error', progress: 0, message: `失败: ${err.message}` });
      db.prepare('UPDATE episodes SET status=? WHERE id=?').run('new', id);
      setTimeout(() => jobs.delete(id), 120000);
    }
  })();

  res.json({ ok: true, message: 'Pipeline started' });
});

// Manual transcript upload (fallback for no-audio episodes)
app.post('/api/episodes/:id/transcript', requireAdmin, async (req, res) => {
  const { transcript } = req.body;
  const id = parseInt(req.params.id);
  if (!transcript) return res.status(400).json({ error: 'transcript required' });

  const ep = db.prepare(`SELECT e.*, p.name as podcast_name FROM episodes e JOIN podcasts p ON e.podcast_id=p.id WHERE e.id=?`).get(id);
  db.prepare('UPDATE episodes SET transcript=?, status=? WHERE id=?').run(transcript, 'processing', id);

  // Just run Claude extraction
  (async () => {
    try {
      jobs.set(id, { step: 'extracting', progress: 60, message: 'Claude 按 Skill 提炼三模块笔记...' });
      const notes = await extractNotes(transcript, ep.podcast_name, ep.title);
      db.prepare('UPDATE episodes SET notes=?, status=? WHERE id=?').run(notes, 'done', id);
      jobs.set(id, { step: 'done', progress: 100, message: '提炼完成！' });
      setTimeout(() => jobs.delete(id), 60000);
    } catch (err) {
      console.error(err);
      jobs.set(id, { step: 'error', progress: 0, message: `提炼失败: ${err.message}` });
      db.prepare('UPDATE episodes SET status=? WHERE id=?').run('confirmed', id);
      setTimeout(() => jobs.delete(id), 120000);
    }
  })();

  res.json({ ok: true });
});

app.get('/api/jobs/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (jobs.has(id)) return res.json(jobs.get(id));
  const ep = db.prepare('SELECT status FROM episodes WHERE id=?').get(id);
  if (ep && ep.status === 'done') return res.json({ step: 'done', progress: 100, message: '完成' });
  res.json({ step: 'idle', progress: 0 });
});

// --- Knowledge Graph edits ---
db.exec(`CREATE TABLE IF NOT EXISTS kg_edits (
  term TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  new_name TEXT,
  new_category TEXT,
  new_subcategory TEXT,
  user_note TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
)`);

// Get all KG edits
app.get('/api/kg/edits', (req, res) => {
  res.json(db.prepare('SELECT * FROM kg_edits').all());
});

// Save a KG edit (delete, rename, move, annotate)
app.post('/api/kg/edit', requireAdmin, (req, res) => {
  const { term, action, new_name, new_category, new_subcategory, user_note } = req.body;
  if (!term || !action) return res.status(400).json({ error: 'term and action required' });
  db.prepare(`INSERT OR REPLACE INTO kg_edits (term, action, new_name, new_category, new_subcategory, user_note, updated_at) VALUES (?,?,?,?,?,?,datetime('now'))`).run(
    term, action, new_name || null, new_category || null, new_subcategory || null, user_note || null
  );
  res.json({ ok: true });
});

// Remove a KG edit (restore term)
app.delete('/api/kg/edit/:term', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM kg_edits WHERE term=?').run(req.params.term);
  res.json({ ok: true });
});

// Toggle star
app.post('/api/episodes/:id/star', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const ep = db.prepare('SELECT starred FROM episodes WHERE id=?').get(id);
  const newVal = ep && ep.starred ? 0 : 1;
  db.prepare('UPDATE episodes SET starred=? WHERE id=?').run(newVal, id);
  res.json({ ok: true, starred: newVal });
});

// Abort a running pipeline
app.post('/api/episodes/:id/abort', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const procs = jobProcesses.get(id);
  if (procs) {
    procs.forEach(p => { try { p.kill('SIGTERM'); } catch(e) {} });
    jobProcesses.delete(id);
  }
  jobs.delete(id);
  db.prepare('UPDATE episodes SET status=? WHERE id=?').run('new', id);
  res.json({ ok: true });
});

app.post('/api/episodes/oneoff', requireAdmin, async (req, res) => {
  const { title, link, description } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  let oneoff = db.prepare(`SELECT id FROM podcasts WHERE name='_散装收藏'`).get();
  if (!oneoff) { const info = db.prepare(`INSERT INTO podcasts (name) VALUES ('_散装收藏')`).run(); oneoff = { id: info.lastInsertRowid }; }
  db.prepare(`INSERT INTO episodes (podcast_id, title, link, description, is_oneoff, pub_date) VALUES (?,?,?,?,1,datetime('now'))`).run(
    oneoff.id, title, link || null, description || null);
  res.json({ ok: true });
});

app.post('/api/refresh', requireAdmin, async (req, res) => {
  const podcasts = db.prepare(`SELECT * FROM podcasts WHERE rss_url IS NOT NULL AND name != '_散装收藏'`).all();
  let total = 0;
  for (const p of podcasts) { try { total += await fetchEpisodes(p.id, p.rss_url); } catch(e) { console.error(e); } }
  res.json({ new_episodes: total });
});

// Fetch episodes from RSS (now captures audio_url from enclosure)
async function fetchEpisodes(podcastId, rssUrl) {
  const feed = await parser.parseURL(rssUrl);
  const existing = new Set(db.prepare('SELECT link FROM episodes WHERE podcast_id=?').all(podcastId).map(r => r.link));
  const insert = db.prepare('INSERT INTO episodes (podcast_id, title, pub_date, link, audio_url, description) VALUES (?,?,?,?,?,?)');
  let count = 0;
  for (const item of feed.items.slice(0, 50)) {
    const link = item.link || item.guid || item.title;
    if (existing.has(link)) continue;
    // Extract audio URL from enclosure
    const audioUrl = item.enclosure?.url || item.enclosure?.['$']?.url || null;
    insert.run(podcastId, item.title, item.pubDate || item.isoDate || null, link, audioUrl,
      (item.contentSnippet || item.content || '').substring(0, 2000));
    count++;
  }
  db.prepare(`UPDATE podcasts SET last_checked=datetime('now') WHERE id=?`).run(podcastId);
  return count;
}

cron.schedule('*/30 * * * *', async () => {
  console.log('[cron] Checking RSS feeds...');
  const podcasts = db.prepare(`SELECT * FROM podcasts WHERE rss_url IS NOT NULL AND name != '_散装收藏'`).all();
  for (const p of podcasts) { try { const n = await fetchEpisodes(p.id, p.rss_url); if(n>0) console.log(`[cron] ${p.name}: ${n} new`); } catch(e) { console.error(e); } }
});

// --- Skills (prompt templates, categorized by content type) ---
db.exec(`CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  prompt_template TEXT NOT NULL,
  variables TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)`);

// Seed skills if empty
const skillCount = db.prepare('SELECT COUNT(*) as c FROM skills').get().c;
if (skillCount === 0) {
  const seedSkill = db.prepare('INSERT INTO skills (name, category, description, prompt_template, variables) VALUES (?,?,?,?,?)');
  seedSkill.run('播客三模块提炼', 'podcast', '播客逐字稿专用：反共识金句 + 核心观点体系 + 专业名词词典',
    `你是一位专业的播客内容分析师。请对以下播客逐字稿进行深度提炼，输出三个模块：\n\n## 模块A：反共识金句\n提取说话人最具洞察力的原话（3-8句），用引号标注。\n\n## 模块B：核心观点体系\n梳理说话人的核心命题和论证逻辑，层次分明地展开。\n\n## 模块C：专业名词解释词典\n列出涉及的专业术语，格式：**[术语]**（English）定义...\n\n---\n播客：{{podcast_name}}\n标题：{{title}}\n逐字稿：\n{{transcript}}`,
    JSON.stringify(['podcast_name', 'title', 'transcript']));
  seedSkill.run('高密度对谈逻辑梳理', 'transcript', '适用于会议录音、访谈、讨论等口语化文字记录',
    `# 底层逻辑学习\n\n将口语化文字记录梳理为结构化文字版，产出三层：\n\n## 第一层：底层知识体系\n抽离可穿越周期的知识框架。\n\n## 第二层：逻辑梳理版\n按话题重组，理顺推理链条，去噪音。\n\n## 第三层：总结\n核心议题 + 逻辑闭环。\n\n---\n标题：{{title}}\n内容：\n{{content}}`,
    JSON.stringify(['title', 'content']));
  seedSkill.run('结构化内容提炼', 'article', '适用于文章、网页、文档等已成文内容',
    `请对以下内容进行结构化提炼：\n\n## 核心观点\n提取主要论点和结论。\n\n## 关键信息\n重要的数据、事实、引用。\n\n## 专业名词解释词典\n**[术语]**（English）定义...\n\n---\n标题：{{title}}\n内容：\n{{content}}`,
    JSON.stringify(['title', 'content']));
}

// Skills CRUD
app.get('/api/skills', (req, res) => {
  res.json(db.prepare('SELECT * FROM skills ORDER BY category, name').all());
});

app.post('/api/skills', requireAdmin, (req, res) => {
  const { name, category, description, prompt_template, variables } = req.body;
  if (!name || !category || !prompt_template) return res.status(400).json({ error: 'missing fields' });
  const info = db.prepare(`INSERT INTO skills (name, category, description, prompt_template, variables) VALUES (?,?,?,?,?)`).run(
    name, category, description || null, prompt_template, JSON.stringify(variables || [])
  );
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/skills/:id', requireAdmin, (req, res) => {
  const { name, category, description, prompt_template, variables } = req.body;
  db.prepare(`UPDATE skills SET name=?, category=?, description=?, prompt_template=?, variables=?, updated_at=datetime('now') WHERE id=?`).run(
    name, category, description || null, prompt_template, JSON.stringify(variables || []), req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/skills/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM skills WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// --- Lark search (via lark-cli) ---
const { execSync } = require('child_process');

app.get('/api/lark/search', requireAdmin, (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  try {
    const result = execSync(`lark-cli docs +search --query "${q.replace(/"/g, '\\"')}" --format json 2>/dev/null`, {
      timeout: 15000,
      encoding: 'utf-8'
    });
    const parsed = JSON.parse(result);
    const items = (parsed.data && parsed.data.results) || [];
    res.json(items.slice(0, 10).map(d => {
      const meta = d.result_meta || {};
      // title_highlighted has <em> tags, strip them
      const title = (d.title_highlighted || d.title || '').replace(/<\/?em>/g, '').replace(/<\/?h>/g, '') || 'Untitled';
      return {
        title,
        token: meta.token || '',
        type: meta.doc_types || d.entity_type || 'doc',
        url: meta.url || ''
      };
    }));
  } catch (e) {
    console.error('[lark search]', e.message);
    res.json([]);
  }
});

// --- Notes (unified) ---
db.exec(`CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,
  source_ref TEXT,
  title TEXT NOT NULL,
  content TEXT,
  raw_content TEXT,
  skill_id INTEGER,
  status TEXT DEFAULT 'new',
  starred INTEGER DEFAULT 0,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)`);

db.exec(`CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  quote TEXT NOT NULL,
  occurrence INTEGER DEFAULT 0,
  comment TEXT,
  color TEXT DEFAULT 'yellow',
  created_at TEXT DEFAULT (datetime('now'))
)`);

app.get('/api/comments', (req, res) => {
  const { target_type, target_id } = req.query;
  if (!target_type || !target_id) return res.json([]);
  const rows = db.prepare('SELECT * FROM comments WHERE target_type=? AND target_id=? ORDER BY id ASC').all(target_type, parseInt(target_id));
  res.json(rows);
});
app.post('/api/comments', requireAdmin, (req, res) => {
  const { target_type, target_id, quote, occurrence, comment, color } = req.body;
  if (!target_type || !target_id || !quote) return res.status(400).json({ error: 'missing fields' });
  const info = db.prepare('INSERT INTO comments (target_type, target_id, quote, occurrence, comment, color) VALUES (?,?,?,?,?,?)').run(
    target_type, parseInt(target_id), quote, occurrence || 0, comment || '', color || 'yellow'
  );
  res.json({ id: info.lastInsertRowid, ok: true });
});
app.patch('/api/comments/:id', requireAdmin, (req, res) => {
  const { comment, color } = req.body;
  if (comment !== undefined) db.prepare('UPDATE comments SET comment=? WHERE id=?').run(comment, req.params.id);
  if (color !== undefined) db.prepare('UPDATE comments SET color=? WHERE id=?').run(color, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/comments/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM comments WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/notes', (req, res) => {
  const { source_type, status } = req.query;
  let sql = 'SELECT * FROM notes WHERE 1=1';
  const params = [];
  if (source_type) { sql += ' AND source_type=?'; params.push(source_type); }
  if (status) { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/notes', requireAdmin, (req, res) => {
  const { source_type, source_ref, title, content, raw_content, skill_id, metadata } = req.body;
  const explicitStatus = req.body.status;
  const info = db.prepare(`INSERT INTO notes (source_type, source_ref, title, content, raw_content, skill_id, status, metadata) VALUES (?,?,?,?,?,?,?,?)`).run(
    source_type, source_ref || null, title, content || null, raw_content || null, skill_id || null, explicitStatus || (content ? 'done' : 'new'), JSON.stringify(metadata || {})
  );
  res.json({ id: info.lastInsertRowid });
});

app.patch('/api/notes/:id', requireAdmin, (req, res) => {
  const fields = [];
  const params = [];
  ['title', 'content', 'raw_content', 'status', 'starred', 'metadata'].forEach(f => {
    if (req.body[f] !== undefined) { fields.push(`${f}=?`); params.push(f === 'metadata' ? JSON.stringify(req.body[f]) : req.body[f]); }
  });
  if (fields.length) {
    fields.push(`updated_at=datetime('now')`);
    params.push(req.params.id);
    db.prepare(`UPDATE notes SET ${fields.join(',')} WHERE id=?`).run(...params);
  }
  res.json({ ok: true });
});

app.delete('/api/notes/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM notes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Note processing pipeline: apply selected Skill to raw_content and store result in content
const noteJobs = new Map(); // noteId -> { step, progress, message }

app.post('/api/notes/:id/process', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const note = db.prepare('SELECT * FROM notes WHERE id=?').get(id);
  if (!note) return res.status(404).json({ error: 'not found' });
  if (!note.raw_content) return res.status(400).json({ error: 'no raw_content to process' });

  // If it's a lark note without raw_content yet, fetch from lark first
  let rawContent = note.raw_content;

  db.prepare('UPDATE notes SET status=? WHERE id=?').run('processing', id);
  noteJobs.set(id, { step: 'starting', progress: 10, message: '准备中...' });
  res.json({ ok: true, message: 'Note processing started' });

  // Run async
  (async () => {
    try {
      // Fetch lark content if needed
      if (note.source_type === 'lark' && !rawContent) {
        noteJobs.set(id, { step: 'fetching', progress: 20, message: '从飞书拉取文档内容...' });
        const meta = JSON.parse(note.metadata || '{}');
        const token = meta.lark_token || note.source_ref;
        if (token) {
          try {
            const { execSync } = require('child_process');
            const docType = (meta.lark_type || 'DOCX').toLowerCase();
            // Try docs +get for DOCX, or wiki +get for wiki nodes
            const cmd = `lark-cli docs +get --token "${token}" --format md 2>/dev/null`;
            rawContent = execSync(cmd, { timeout: 30000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
            db.prepare('UPDATE notes SET raw_content=? WHERE id=?').run(rawContent, id);
          } catch (e) {
            throw new Error('飞书文档拉取失败：' + e.message);
          }
        }
      }

      if (!rawContent) throw new Error('没有可提炼的原始内容');

      // Load skill
      let skill = null;
      if (note.skill_id) {
        skill = db.prepare('SELECT * FROM skills WHERE id=?').get(note.skill_id);
      }
      if (!skill) {
        // Default: use transcript skill
        skill = db.prepare("SELECT * FROM skills WHERE category='article' LIMIT 1").get()
              || db.prepare("SELECT * FROM skills WHERE category='transcript' LIMIT 1").get();
      }
      if (!skill) throw new Error('找不到可用的 Skill');

      noteJobs.set(id, { step: 'extracting', progress: 50, message: `用「${skill.name}」提炼中...` });

      // Substitute variables in prompt template
      let prompt = skill.prompt_template;
      const meta = JSON.parse(note.metadata || '{}');
      const vars = {
        title: note.title || '',
        content: rawContent,
        transcript: rawContent,
        filename: meta.filename || '',
        url: meta.url || meta.lark_url || '',
        lark_url: meta.lark_url || '',
        podcast_name: '',
      };
      Object.entries(vars).forEach(([k, v]) => {
        prompt = prompt.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), v);
      });

      const result = await extractWithPrompt(prompt);

      // For "article" category skills, the LLM only outputs the dictionary;
      // we prepend the original raw content so the final note has both.
      // Also clean up mammoth's overzealous markdown escaping (\- \. \_ etc).
      const cleanMammoth = (s) => (s || '').replace(/\\([-.\_\[\]()#+!*<>])/g, '$1');
      let finalContent;
      if (skill.category === 'article') {
        const cleanedRaw = cleanMammoth(rawContent);
        const dictPart = result.trim();
        finalContent = cleanedRaw + '\n\n---\n\n' + dictPart;
      } else {
        finalContent = cleanMammoth(result);
      }

      db.prepare("UPDATE notes SET content=?, status='done', updated_at=datetime('now') WHERE id=?").run(finalContent, id);
      noteJobs.set(id, { step: 'done', progress: 100, message: '提炼完成' });
      setTimeout(() => noteJobs.delete(id), 60000);
    } catch (err) {
      console.error(`[note ${id}] pipeline error:`, err);
      noteJobs.set(id, { step: 'error', progress: 0, message: `失败: ${err.message}` });
      db.prepare("UPDATE notes SET status='new' WHERE id=?").run(id);
      setTimeout(() => noteJobs.delete(id), 120000);
    }
  })();
});

app.get('/api/notes/:id/job', (req, res) => {
  const id = parseInt(req.params.id);
  if (noteJobs.has(id)) return res.json(noteJobs.get(id));
  const n = db.prepare('SELECT status FROM notes WHERE id=?').get(id);
  if (n && n.status === 'done') return res.json({ step: 'done', progress: 100, message: '完成' });
  res.json({ step: 'idle', progress: 0 });
});

app.post('/api/notes/:id/abort', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  noteJobs.delete(id);
  db.prepare("UPDATE notes SET status='new' WHERE id=?").run(id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => console.log(`Murmur running on port ${PORT}`));
