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
// 2026-05-14: 加 User-Agent 头解决喜马拉雅 / 部分国内播客平台 406 拒绝问题
const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*;q=0.9',
  },
  timeout: 30000,
  customFields: { item: [['enclosure', 'enclosure']] },
});
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const db = new Database(path.join(DATA_DIR, 'podcasts.db'));
const TRANSCRIPTS_DIR = path.join(__dirname, 'transcripts');
if (!fs.existsSync(TRANSCRIPTS_DIR)) fs.mkdirSync(TRANSCRIPTS_DIR);

// 2026-05-19: Multi-tenant SaaS migration. Idempotent. Skipped if users table already populated.
try {
  const { applyMigration } = require('./migrations/2026-05-19-multi-tenant');
  applyMigration(db);
} catch (e) {
  console.error('[migration] FAILED:', e.message);
  console.error('Server starting in legacy mode. Fix migration env vars and restart.');
}

// --- Auth (2026-05-19 multi-tenant) ---
const cookieParser = require('cookie-parser');
const { hashPassword, verifyPassword, createSession, verifyToken, deleteSession, requireUser: requireUserFactory, signupRateLimit, loginRateLimit } = require('./lib/auth');
const { encryptApiKey, decryptApiKey } = require('./lib/crypto');

app.use(cookieParser());

const requireUser = requireUserFactory(db);
// requireAdmin kept as alias for backward compat with existing route definitions (so we can audit later).
const requireAdmin = requireUser;

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

// Login (now requires email + password)
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

// Who am I
app.get('/api/auth/me', requireUser, (req, res) => {
  const u = db.prepare(`SELECT id, email, display_name, is_admin, deepseek_api_key IS NOT NULL AS has_deepseek, groq_api_key IS NOT NULL AS has_groq FROM users WHERE id = ?`).get(req.user_id);
  res.json({ ok: true, user: u });
});

// Logout
app.post('/api/auth/logout', requireUser, (req, res) => {
  const token = req.headers?.authorization?.replace(/^Bearer\s+/i, '') || req.cookies?.session;
  deleteSession(db, token);
  res.json({ ok: true });
});

// Settings — change password, API keys, display_name
app.post('/api/auth/settings', requireUser, express.json(), async (req, res) => {
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
// --- end auth ---

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

app.get('/api/podcasts', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT p.*, COUNT(e.id) as episode_count,
    SUM(CASE WHEN e.status='new' THEN 1 ELSE 0 END) as new_count
    FROM podcasts p LEFT JOIN episodes e ON e.podcast_id=p.id
    WHERE p.user_id = ?
    GROUP BY p.id ORDER BY p.created_at DESC
  `).all(req.user_id));
});

app.post('/api/podcasts', requireAdmin, async (req, res) => {
  const { name, rss_url, artwork } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const info = db.prepare('INSERT INTO podcasts (user_id, name, rss_url, artwork) VALUES (?, ?, ?, ?)').run(req.user_id, name, rss_url || null, artwork || null);
  // 2026-05-14: 不再静默吞 fetch 错。返回给前端能看到的 warning,podcast 已建但 RSS 拉失败
  let warning = null;
  let episodes_fetched = 0;
  if (rss_url) {
    try { episodes_fetched = await fetchEpisodes(info.lastInsertRowid, rss_url, req.user_id); }
    catch (e) {
      console.error('[POST /api/podcasts] fetchEpisodes failed:', e.message);
      warning = `RSS 抓取失败: ${e.message} —— podcast 已建,可稍后手动 refresh`;
    }
  }
  res.json({ id: info.lastInsertRowid, episodes_fetched, warning });
});

app.delete('/api/podcasts/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM episodes WHERE podcast_id=? AND user_id=?').run(req.params.id, req.user_id);
  const result = db.prepare('DELETE FROM podcasts WHERE id=? AND user_id=?').run(req.params.id, req.user_id);
  if (result.changes === 0) return res.status(404).json({ error: 'podcast not found or not yours' });
  res.json({ ok: true });
});

app.get('/api/episodes', requireAdmin, (req, res) => {
  const { podcast_id, status } = req.query;
  let sql = `SELECT e.id, e.podcast_id, e.title, e.pub_date, e.link, e.audio_url, e.description, e.status, e.notes, e.is_oneoff, e.starred, e.created_at, p.name as podcast_name, p.artwork as podcast_artwork FROM episodes e JOIN podcasts p ON e.podcast_id=p.id WHERE e.user_id = ?`;
  const params = [req.user_id];
  if (podcast_id) { sql += ` AND e.podcast_id=?`; params.push(podcast_id); }
  if (status) { sql += ` AND e.status=?`; params.push(status); }
  sql += ` ORDER BY e.pub_date DESC, e.created_at DESC`;
  const rows = db.prepare(sql).all(...params);
  rows.forEach(r => { if (jobs.has(r.id)) r.job = jobs.get(r.id); });
  res.json(rows);
});

app.patch('/api/episodes/:id', requireAdmin, (req, res) => {
  const { status, notes } = req.body;
  if (status) {
    const r = db.prepare('UPDATE episodes SET status=? WHERE id=? AND user_id=?').run(status, req.params.id, req.user_id);
    if (r.changes === 0) return res.status(404).json({ error: 'episode not found or not yours' });
  }
  if (notes !== undefined) {
    const r = db.prepare('UPDATE episodes SET notes=? WHERE id=? AND user_id=?').run(notes, req.params.id, req.user_id);
    if (r.changes === 0) return res.status(404).json({ error: 'episode not found or not yours' });
  }
  res.json({ ok: true });
});

// ========== CORE: Start full auto pipeline ==========
app.post('/api/episodes/:id/process', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const ep = db.prepare(`SELECT e.*, p.name as podcast_name FROM episodes e JOIN podcasts p ON e.podcast_id=p.id WHERE e.id=? AND e.user_id=?`).get(id, req.user_id);
  if (!ep) return res.status(404).json({ error: 'episode not found or not yours' });

  db.prepare('UPDATE episodes SET status=? WHERE id=?').run('processing', id);

  // Run pipeline async
  (async () => {
    try {
      if (ep.audio_url) {
        const procs = [];
        jobProcesses.set(id, procs);
        const result = await runPipeline(ep, ep.audio_url, (prog) => jobs.set(id, prog), (proc) => procs.push(proc), req.user_id);
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

  const ep = db.prepare(`SELECT e.*, p.name as podcast_name FROM episodes e JOIN podcasts p ON e.podcast_id=p.id WHERE e.id=? AND e.user_id=?`).get(id, req.user_id);
  if (!ep) return res.status(404).json({ error: 'episode not found or not yours' });
  db.prepare('UPDATE episodes SET transcript=?, status=? WHERE id=?').run(transcript, 'processing', id);

  // Just run Claude extraction
  (async () => {
    try {
      jobs.set(id, { step: 'extracting', progress: 60, message: 'Claude 按 Skill 提炼三模块笔记...' });
      const notes = await extractNotes(transcript, ep.podcast_name, ep.title, req.user_id);
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

// Re-extract: re-run note extraction on existing transcript without re-downloading/re-transcribing
app.post('/api/episodes/:id/reextract', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const ep = db.prepare(`SELECT e.*, p.name as podcast_name FROM episodes e JOIN podcasts p ON e.podcast_id=p.id WHERE e.id=? AND e.user_id=?`).get(id, req.user_id);
  if (!ep) return res.status(404).json({ error: 'episode not found or not yours' });
  if (!ep.transcript) return res.status(400).json({ error: '该集没有逐字稿，无法重新提炼' });

  db.prepare('UPDATE episodes SET status=? WHERE id=?').run('processing', id);

  (async () => {
    try {
      jobs.set(id, { step: 'extracting', progress: 60, message: '重新提炼笔记中（新版 prompt）...' });
      const notes = await extractNotes(ep.transcript, ep.podcast_name, ep.title, req.user_id);
      db.prepare('UPDATE episodes SET notes=?, status=? WHERE id=?').run(notes, 'done', id);
      jobs.set(id, { step: 'done', progress: 100, message: '重新提炼完成！' });
      setTimeout(() => jobs.delete(id), 60000);
    } catch (err) {
      console.error(`Re-extract error for ep ${id}:`, err);
      jobs.set(id, { step: 'error', progress: 0, message: `重新提炼失败: ${err.message}` });
      db.prepare('UPDATE episodes SET status=? WHERE id=?').run('done', id);
      setTimeout(() => jobs.delete(id), 120000);
    }
  })();

  res.json({ ok: true, message: '重新提炼已启动' });
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
app.get('/api/kg/edits', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM kg_edits WHERE user_id=? ORDER BY updated_at DESC').all(req.user_id));
});

// Save a KG edit (delete, rename, move, annotate)
app.post('/api/kg/edit', requireAdmin, (req, res) => {
  const { term, action, new_name, new_category, new_subcategory, user_note } = req.body;
  if (!term || !action) return res.status(400).json({ error: 'term and action required' });
  db.prepare(`INSERT OR REPLACE INTO kg_edits (user_id, term, action, new_name, new_category, new_subcategory, user_note, updated_at) VALUES (?,?,?,?,?,?,?,datetime('now'))`).run(
    req.user_id, term, action, new_name || null, new_category || null, new_subcategory || null, user_note || null
  );
  res.json({ ok: true });
});

// Remove a KG edit (restore term)
app.delete('/api/kg/edit/:term', requireAdmin, (req, res) => {
  const r = db.prepare('DELETE FROM kg_edits WHERE term=? AND user_id=?').run(req.params.term, req.user_id);
  if (r.changes === 0) return res.status(404).json({ error: 'kg edit not found or not yours' });
  res.json({ ok: true });
});

// Toggle star
app.post('/api/episodes/:id/star', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const ep = db.prepare('SELECT starred FROM episodes WHERE id=? AND user_id=?').get(id, req.user_id);
  if (!ep) return res.status(404).json({ error: 'episode not found or not yours' });
  const newVal = ep.starred ? 0 : 1;
  db.prepare('UPDATE episodes SET starred=? WHERE id=? AND user_id=?').run(newVal, id, req.user_id);
  res.json({ ok: true, starred: newVal });
});

// Abort a running pipeline
app.post('/api/episodes/:id/abort', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  // Ownership check before aborting
  const ep = db.prepare('SELECT id FROM episodes WHERE id=? AND user_id=?').get(id, req.user_id);
  if (!ep) return res.status(404).json({ error: 'episode not found or not yours' });
  const procs = jobProcesses.get(id);
  if (procs) {
    procs.forEach(p => { try { p.kill('SIGTERM'); } catch(e) {} });
    jobProcesses.delete(id);
  }
  jobs.delete(id);
  db.prepare('UPDATE episodes SET status=? WHERE id=? AND user_id=?').run('new', id, req.user_id);
  res.json({ ok: true });
});

app.post('/api/episodes/oneoff', requireAdmin, async (req, res) => {
  const { title, link, description } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  let oneoff = db.prepare(`SELECT id FROM podcasts WHERE name='_散装收藏' AND user_id=?`).get(req.user_id);
  if (!oneoff) {
    const info = db.prepare(`INSERT INTO podcasts (user_id, name, artwork) VALUES (?, '_散装收藏', NULL)`).run(req.user_id);
    oneoff = { id: info.lastInsertRowid };
  }
  db.prepare(`INSERT INTO episodes (user_id, podcast_id, title, link, description, is_oneoff, pub_date) VALUES (?,?,?,?,?,1,datetime('now'))`).run(
    req.user_id, oneoff.id, title, link || null, description || null);
  res.json({ ok: true });
});

app.post('/api/refresh', requireAdmin, async (req, res) => {
  const podcasts = db.prepare(`SELECT * FROM podcasts WHERE user_id = ? AND rss_url IS NOT NULL AND name != '_散装收藏'`).all(req.user_id);
  let total = 0;
  for (const p of podcasts) { try { total += await fetchEpisodes(p.id, p.rss_url, req.user_id); } catch(e) { console.error(e); } }
  res.json({ new_episodes: total });
});

// Fetch episodes from RSS (now captures audio_url from enclosure)
async function fetchEpisodes(podcastId, rssUrl, userId) {
  const feed = await parser.parseURL(rssUrl);
  const existing = new Set(db.prepare('SELECT link FROM episodes WHERE podcast_id=? AND user_id=?').all(podcastId, userId).map(r => r.link));
  const insert = db.prepare('INSERT INTO episodes (user_id, podcast_id, title, pub_date, link, audio_url, description) VALUES (?,?,?,?,?,?,?)');
  let count = 0;
  // 2026-05-14 Faye: 默认拉前 20 集（之前是 50,Faye 觉得太多杂）
  for (const item of feed.items.slice(0, 20)) {
    const link = item.link || item.guid || item.title;
    if (existing.has(link)) continue;
    // Extract audio URL from enclosure
    const audioUrl = item.enclosure?.url || item.enclosure?.['$']?.url || null;
    insert.run(userId, podcastId, item.title, item.pubDate || item.isoDate || null, link, audioUrl,
      (item.contentSnippet || item.content || '').substring(0, 2000));
    count++;
  }
  db.prepare(`UPDATE podcasts SET last_checked=datetime('now') WHERE id=? AND user_id=?`).run(podcastId, userId);
  return count;
}

cron.schedule('*/30 * * * *', async () => {
  console.log('[cron] Checking RSS feeds for all users...');
  const users = db.prepare('SELECT id FROM users').all();
  let total = 0;
  for (const u of users) {
    const podcasts = db.prepare(`SELECT * FROM podcasts WHERE user_id = ? AND rss_url IS NOT NULL AND name != '_散装收藏'`).all(u.id);
    for (const p of podcasts) {
      try { const n = await fetchEpisodes(p.id, p.rss_url, u.id); if(n>0) { console.log(`[cron] user ${u.id} ${p.name}: ${n} new`); total += n; } }
      catch(e) { console.error(`[cron] user ${u.id} podcast ${p.id}:`, e.message); }
    }
  }
  console.log(`[cron] done, ${total} new episodes total`);
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
  const TLDR_SECTION = `## TL;DR（Too Long; Didn\\u0027t Read）\n\n放在笔记最前面，让读者 30 秒就能判断是否值得深读。严格按以下三段结构：\n\n**核心观点**：用 1-3 句话点破本文/本集最根本的论断或结论。不是"讨论了 X"，而是"关于 X，核心论断是 Y"。\n\n**阐述逻辑**：用 4-8 句话梳理论证链条，用"因为 A，所以 B；进一步地因为 B，所以 C"的因果结构。不要罗列章节，而是抽象出推理骨架：前提 → 中间论点 → 结论。\n\n**叙述脉络**：用 1-2 句话描述展开结构（如：现象切入→机制拆解→预判；时间纵轴→当下横切→未来展望；问题提出→多角度论证→反常识收尾）。\n\n要求：总长 300-500 字，是逻辑的抽象不是摘要的复述，不用"本文讨论了"这种套话。\n\n---\n`;
  seedSkill.run('播客三模块提炼', 'podcast', '播客逐字稿专用：TL;DR + 反共识金句 + 核心观点体系 + 专业名词词典',
    `你是一位专业的播客内容分析师。请对以下播客逐字稿进行深度提炼，严格按以下四个模块输出（TL;DR 必须第一个）：\n\n${TLDR_SECTION}\n\n## 模块A：反共识金句\n提取说话人最具洞察力的原话（3-8句），用引号标注。\n\n## 模块B：核心观点体系\n梳理说话人的核心命题和论证逻辑，层次分明地展开。\n\n## 专业名词解释词典\n列出涉及的专业术语，格式：**[术语]**（English）定义...\n\n⚠️ 标题「## 专业名词解释词典」是下游系统解析锚点，必须一字不差输出。\n\n---\n播客：{{podcast_name}}\n标题：{{title}}\n逐字稿：\n{{transcript}}`,
    JSON.stringify(['podcast_name', 'title', 'transcript']));
  seedSkill.run('高密度对谈逻辑梳理', 'transcript', '适用于会议录音、访谈、讨论等口语化文字记录',
    `# 底层逻辑学习\n\n将口语化文字记录梳理为结构化文字版。笔记最前面必须有 TL;DR，后面产出三层内容。\n\n${TLDR_SECTION}\n\n## 第一层：底层知识体系\n抽离可穿越周期的知识框架。\n\n## 第二层：逻辑梳理版\n按话题重组，理顺推理链条，去噪音。\n\n## 第三层：总结\n核心议题 + 逻辑闭环。\n\n## 专业名词解释词典\n⚠️ 标题「## 专业名词解释词典」是下游系统解析锚点，必须一字不差输出。\n\n---\n标题：{{title}}\n内容：\n{{content}}`,
    JSON.stringify(['title', 'content']));
  seedSkill.run('结构化内容提炼', 'article', '适用于文章、网页、文档等已成文内容',
    `请对以下内容输出两部分：\n\n${TLDR_SECTION}\n\n## 专业名词解释词典\n列出涉及的专业术语，格式：**[术语]**（English）定义...\n\n⚠️ 标题「## 专业名词解释词典」是下游系统解析锚点，必须一字不差输出。\n\n你的输出只包含上述两部分（TL;DR + 专业名词解释词典），不要重复原文内容，不要加其他章节。原文会被系统自动拼接在这两部分之间。\n\n---\n标题：{{title}}\n内容：\n{{content}}`,
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
// Add kind column to distinguish comments ('comment') from critical thoughts ('thought').
try { db.exec(`ALTER TABLE comments ADD COLUMN kind TEXT DEFAULT 'comment'`); } catch(e) {}

app.get('/api/comments', requireAdmin, (req, res) => {
  const { target_type, target_id } = req.query;
  if (!target_type || !target_id) return res.json([]);
  const rows = db.prepare('SELECT * FROM comments WHERE target_type=? AND target_id=? AND user_id=? ORDER BY id ASC').all(target_type, parseInt(target_id), req.user_id);
  res.json(rows);
});
app.post('/api/comments', requireAdmin, (req, res) => {
  const { target_type, target_id, quote, occurrence, comment, color, kind } = req.body;
  if (!target_type || !target_id || !quote) return res.status(400).json({ error: 'missing fields' });
  const tid = parseInt(target_id);
  // Ownership check: target must belong to this user
  if (target_type === 'episode') {
    const target = db.prepare('SELECT id FROM episodes WHERE id=? AND user_id=?').get(tid, req.user_id);
    if (!target) return res.status(404).json({ error: 'target episode not found or not yours' });
  } else if (target_type === 'note') {
    const target = db.prepare('SELECT id FROM notes WHERE id=? AND user_id=?').get(tid, req.user_id);
    if (!target) return res.status(404).json({ error: 'target note not found or not yours' });
  }
  const info = db.prepare('INSERT INTO comments (user_id, target_type, target_id, quote, occurrence, comment, color, kind) VALUES (?,?,?,?,?,?,?,?)').run(
    req.user_id, target_type, tid, quote, occurrence || 0, comment || '', color || 'yellow', kind === 'thought' ? 'thought' : 'comment'
  );
  res.json({ id: info.lastInsertRowid, ok: true });
});

// Aggregate all thoughts across all notes/episodes — for the 思考集 view
app.get('/api/thoughts', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT c.*,
      CASE WHEN c.target_type='episode' THEN e.title ELSE n.title END as source_title,
      CASE WHEN c.target_type='episode' THEN p.name ELSE n.source_type END as source_label
    FROM comments c
    LEFT JOIN episodes e ON c.target_type='episode' AND e.id=c.target_id AND e.user_id=?
    LEFT JOIN podcasts p ON e.podcast_id=p.id
    LEFT JOIN notes n ON c.target_type='note' AND n.id=c.target_id AND n.user_id=?
    WHERE c.kind='thought' AND c.user_id=?
    ORDER BY c.created_at DESC
  `).all(req.user_id, req.user_id, req.user_id);
  res.json(rows);
});
app.patch('/api/comments/:id', requireAdmin, (req, res) => {
  const { comment, color } = req.body;
  const id = parseInt(req.params.id);
  // Verify ownership first
  const existing = db.prepare('SELECT id FROM comments WHERE id=? AND user_id=?').get(id, req.user_id);
  if (!existing) return res.status(404).json({ error: 'comment not found or not yours' });
  if (comment !== undefined) db.prepare('UPDATE comments SET comment=? WHERE id=? AND user_id=?').run(comment, id, req.user_id);
  if (color !== undefined) db.prepare('UPDATE comments SET color=? WHERE id=? AND user_id=?').run(color, id, req.user_id);
  res.json({ ok: true });
});
app.delete('/api/comments/:id', requireAdmin, (req, res) => {
  const r = db.prepare('DELETE FROM comments WHERE id=? AND user_id=?').run(parseInt(req.params.id), req.user_id);
  if (r.changes === 0) return res.status(404).json({ error: 'comment not found or not yours' });
  res.json({ ok: true });
});

app.get('/api/notes', requireAdmin, (req, res) => {
  const { source_type, status } = req.query;
  let sql = 'SELECT * FROM notes WHERE user_id=?';
  const params = [req.user_id];
  if (source_type) { sql += ' AND source_type=?'; params.push(source_type); }
  if (status) { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/notes', requireAdmin, (req, res) => {
  const { source_type, source_ref, title, content, raw_content, skill_id, metadata } = req.body;
  const explicitStatus = req.body.status;
  const info = db.prepare(`INSERT INTO notes (user_id, source_type, source_ref, title, content, raw_content, skill_id, status, metadata) VALUES (?,?,?,?,?,?,?,?,?)`).run(
    req.user_id, source_type, source_ref || null, title, content || null, raw_content || null, skill_id || null, explicitStatus || (content ? 'done' : 'new'), JSON.stringify(metadata || {})
  );
  res.json({ id: info.lastInsertRowid });
});

app.patch('/api/notes/:id', requireAdmin, (req, res) => {
  const fields = [];
  const params = [];
  ['title', 'content', 'raw_content', 'status', 'starred', 'metadata', 'skill_id'].forEach(f => {
    if (req.body[f] !== undefined) { fields.push(`${f}=?`); params.push(f === 'metadata' ? JSON.stringify(req.body[f]) : req.body[f]); }
  });
  if (fields.length) {
    fields.push(`updated_at=datetime('now')`);
    params.push(req.params.id);
    params.push(req.user_id);
    const r = db.prepare(`UPDATE notes SET ${fields.join(',')} WHERE id=? AND user_id=?`).run(...params);
    if (r.changes === 0) return res.status(404).json({ error: 'note not found or not yours' });
  }
  res.json({ ok: true });
});

app.delete('/api/notes/:id', requireAdmin, (req, res) => {
  const r = db.prepare('DELETE FROM notes WHERE id=? AND user_id=?').run(req.params.id, req.user_id);
  if (r.changes === 0) return res.status(404).json({ error: 'note not found or not yours' });
  res.json({ ok: true });
});

// Note processing pipeline: apply selected Skill to raw_content and store result in content
const noteJobs = new Map(); // noteId -> { step, progress, message }

app.post('/api/notes/:id/process', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const note = db.prepare('SELECT * FROM notes WHERE id=? AND user_id=?').get(id, req.user_id);
  if (!note) return res.status(404).json({ error: 'note not found or not yours' });
  // Allow processing even without raw_content: fall back to content
  // (useful for glimpse notes which only have a content field).
  if (!note.raw_content && !note.content && note.source_type !== 'lark') {
    return res.status(400).json({ error: 'no content to process' });
  }

  let rawContent = note.raw_content || note.content;

  db.prepare('UPDATE notes SET status=? WHERE id=?').run('processing', id);
  noteJobs.set(id, { step: 'starting', progress: 10, message: '准备中...' });
  res.json({ ok: true, message: 'Note processing started' });

  // Run async
  (async () => {
    try {
      // Fetch lark content if needed — supports regular docs AND minutes
      if (note.source_type === 'lark' && !rawContent) {
        const meta = JSON.parse(note.metadata || '{}');
        const larkUrl = meta.lark_url || note.source_ref;
        if (!larkUrl) throw new Error('缺少飞书链接');
        const { execSync } = require('child_process');
        const fsMod = require('fs');
        const osMod = require('os');
        const pathMod = require('path');
        let newTitle = note.title;
        try {
          if (/\/minutes\//.test(larkUrl)) {
            // === 飞书妙记 ===
            noteJobs.set(id, { step: 'fetching', progress: 20, message: '通过 lark-cli 拉取妙记逐字稿...' });
            const mt = larkUrl.match(/\/minutes\/([A-Za-z0-9]+)/);
            if (!mt) throw new Error('无法识别的 minutes URL');
            const token = mt[1];
            const tmpDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'lark-min-'));
            execSync(`lark-cli vc +notes --minute-tokens ${token} --output-dir . 2>&1`, { cwd: tmpDir, timeout: 180000, encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 });
            const entries = fsMod.readdirSync(tmpDir);
            const dir = entries.find(e => e.startsWith('artifact-'));
            if (!dir) throw new Error('lark-cli 未返回 artifact 目录');
            const tp = pathMod.join(tmpDir, dir, 'transcript.txt');
            if (!fsMod.existsSync(tp)) throw new Error('未找到 transcript.txt');
            rawContent = fsMod.readFileSync(tp, 'utf-8').trim();
            // artifact-<title>-<token> → title
            const titleMatch = dir.match(/^artifact-(.*)-[A-Za-z0-9]+$/);
            if (titleMatch) newTitle = titleMatch[1];
            try { fsMod.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
          } else {
            // === 普通飞书文档 ===
            noteJobs.set(id, { step: 'fetching', progress: 20, message: '通过 lark-cli 拉取飞书文档...' });
            const safe = larkUrl.replace(/"/g, '\\"');
            rawContent = execSync(`lark-cli docs +fetch --doc "${safe}" --format pretty 2>/dev/null`, { timeout: 60000, encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 }).trim();
            if (!rawContent || rawContent.length < 20) throw new Error('lark-cli 返回内容为空，请确认链接和授权');
            if (/^https?:\/\//.test(note.title)) {
              const firstHead = rawContent.match(/^#+\s*(.+)/m);
              const firstLine = rawContent.split('\n').find(l => l.trim().length > 0);
              newTitle = (firstHead ? firstHead[1] : firstLine || note.title).trim().slice(0, 120);
            }
          }
          db.prepare('UPDATE notes SET raw_content=?, title=? WHERE id=?').run(rawContent, newTitle, id);
        } catch (e) {
          throw new Error('飞书内容拉取失败：' + e.message);
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

      const result = await extractWithPrompt(prompt, req.user_id);

      // For "article" category skills, the LLM outputs TL;DR + dictionary;
      // we wrap the original raw content between them so the final note is:
      //   [TL;DR] + [raw content] + [dictionary]
      // Also clean up mammoth's overzealous markdown escaping (\- \. \_ etc).
      const cleanMammoth = (s) => (s || '').replace(/\\([-.\_\[\]()#+!*<>])/g, '$1');
      let finalContent;
      if (skill.category === 'article') {
        const cleanedRaw = cleanMammoth(rawContent);
        const llmOut = result.trim();
        // Split LLM output at the dictionary anchor. If anchor missing, fall back to appending LLM output after raw.
        const dictMatch = llmOut.match(/(#{2,3}\s*专业(?:名词|术语)(?:解释)?词典[\s\S]*)$/);
        if (dictMatch) {
          // Strip trailing separator lines from TL;DR part so we don't double up "---"
          const tldrPart = llmOut.substring(0, dictMatch.index).trim().replace(/\n+---\s*$/, '').trim();
          const dictPart = dictMatch[1].trim();
          finalContent = (tldrPart ? tldrPart + '\n\n---\n\n' : '') + cleanedRaw + '\n\n---\n\n' + dictPart;
        } else {
          // No dict anchor found — treat entire LLM output as TL;DR prefix
          finalContent = llmOut + '\n\n---\n\n' + cleanedRaw;
        }
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

app.get('/api/notes/:id/job', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (noteJobs.has(id)) return res.json(noteJobs.get(id));
  const n = db.prepare('SELECT status FROM notes WHERE id=? AND user_id=?').get(id, req.user_id);
  if (!n) return res.status(404).json({ error: 'note not found or not yours' });
  if (n.status === 'done') return res.json({ step: 'done', progress: 100, message: '完成' });
  res.json({ step: 'idle', progress: 0 });
});

// Append a quote to today's 惊鸿一瞥 (glimpse) entry. Creates the entry if it doesn't exist.
// Each user gets their own daily row keyed by (user_id, source_type='glimpse', title=today).
app.post('/api/glimpse/append', requireAdmin, (req, res) => {
  const { text, source_type, source_id, source_title } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });

  // Today's date in YYYY-MM-DD using local timezone
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // Find or create today's glimpse note for this user
  let glimpse = db.prepare(`SELECT id, content FROM notes WHERE user_id=? AND source_type='glimpse' AND title=?`).get(req.user_id, today);
  let action = 'appended';
  if (!glimpse) {
    const info = db.prepare(`
      INSERT INTO notes (user_id, source_type, title, content, status, metadata)
      VALUES (?, 'glimpse', ?, ?, 'done', '{}')
    `).run(req.user_id, today, `# ${today}\n\n`);
    glimpse = { id: info.lastInsertRowid, content: `# ${today}\n\n` };
    action = 'created';
  }

  // Build bullet with attribution link
  let attribution = '';
  if (source_id && source_title) {
    const tag = source_type === 'ep' ? `[EP_ID=${source_id}]` : `[NOTE_ID=${source_id}]`;
    attribution = `\n  — 摘自《${source_title}》 ${tag}`;
  }
  const cleanText = text.trim().replace(/\n+/g, ' ');
  const bullet = `- ${cleanText}${attribution}\n`;

  const newContent = (glimpse.content || '').replace(/\s*$/, '') + '\n' + bullet;
  db.prepare(`UPDATE notes SET content=?, updated_at=datetime('now') WHERE id=?`).run(newContent, glimpse.id);
  res.json({ ok: true, glimpse_id: glimpse.id, date: today, action });
});

app.post('/api/notes/:id/abort', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  noteJobs.delete(id);
  const r = db.prepare("UPDATE notes SET status='new' WHERE id=? AND user_id=?").run(id, req.user_id);
  if (r.changes === 0) return res.status(404).json({ error: 'note not found or not yours' });
  res.json({ ok: true });
});

// ========== Ask Murmur: knowledge base Q&A ==========
app.post('/api/ask', requireAdmin, async (req, res) => {
  const { question } = req.body || {};
  if (!question || !question.trim()) {
    return res.status(400).json({ error: '问题不能为空' });
  }

  try {
    // 1. Gather user's done episodes with notes
    const dones = db.prepare(`
      SELECT e.id, e.title, e.notes, p.name as podcast_name
      FROM episodes e JOIN podcasts p ON e.podcast_id=p.id
      WHERE e.status='done' AND e.notes IS NOT NULL AND length(e.notes) > 200 AND e.user_id=?
    `).all(req.user_id);

    // 2. Gather user's done notes (lark/manual) with content
    const doneNotes = db.prepare(`
      SELECT id, title, content, source_type
      FROM notes
      WHERE status='done' AND content IS NOT NULL AND length(content) > 200 AND user_id=?
    `).all(req.user_id);

    if (dones.length === 0 && doneNotes.length === 0) {
      return res.status(400).json({ error: '知识库为空，请先提炼一些笔记' });
    }

    // 3. Build context with labels, truncating if too long
    const MAX_CTX = 180000; // ~90K tokens, leaves room for question + answer
    const blocks = [];
    dones.forEach(e => {
      blocks.push({
        label: `[EP_ID=${e.id}]`,
        header: `=== [EP_ID=${e.id}] 标题：${e.title} 播客：${e.podcast_name} ===`,
        body: e.notes,
      });
    });
    doneNotes.forEach(n => {
      blocks.push({
        label: `[NOTE_ID=${n.id}]`,
        header: `=== [NOTE_ID=${n.id}] 标题：${n.title} 来源：${n.source_type || 'note'} ===`,
        body: n.content,
      });
    });

    // Sort by length descending, truncate longest until fits
    let total = blocks.reduce((s, b) => s + b.header.length + b.body.length + 4, 0);
    while (total > MAX_CTX) {
      blocks.sort((a, b) => b.body.length - a.body.length);
      blocks[0].body = blocks[0].body.substring(0, Math.floor(blocks[0].body.length * 0.7)) + '\n[...已截断...]';
      total = blocks.reduce((s, b) => s + b.header.length + b.body.length + 4, 0);
    }

    const context = blocks.map(b => `${b.header}\n${b.body}`).join('\n\n');

    // 4. Build prompt
    const prompt = `你是 Murmur 知识库问答助手。基于下面这些播客和文档笔记回答用户的问题。

## 严格规则
1. 只基于提供的笔记内容回答，绝不编造
2. 回答里每个核心观点/论述/引用后面必须用 [EP_ID=数字] 或 [NOTE_ID=数字] 标注出处
   - 一个观点可以标多个出处
   - 标注紧贴句末，放在句号之前：像这样 [EP_ID=296]。
3. 如果笔记里没有相关内容，直接说「笔记库中未找到相关内容」，不要硬编
4. 尽量用嘉宾原话或保留原始论证结构，不要翻译成官话
5. 回答要有逻辑层次：先给结论，再展开论证链条
6. 答案长度：视问题复杂度，简单问题 200 字以内，复杂问题可以 1500+ 字展开

## 知识库

${context}

## 用户问题
${question}

## 你的回答
（直接给回答，用 Markdown 格式，不要重复问题）`;

    // 5. Call DeepSeek
    const answer = await extractWithPrompt(prompt, req.user_id);

    // 6. Parse citations from answer
    const epIds = new Set();
    const noteIds = new Set();
    (answer.match(/\[EP_ID=(\d+)\]/g) || []).forEach(m => epIds.add(parseInt(m.match(/\d+/)[0])));
    (answer.match(/\[NOTE_ID=(\d+)\]/g) || []).forEach(m => noteIds.add(parseInt(m.match(/\d+/)[0])));

    const citations = [];
    epIds.forEach(id => {
      const e = dones.find(x => x.id === id);
      if (e) citations.push({ type: 'ep', id: e.id, title: e.title, podcast_name: e.podcast_name });
    });
    noteIds.forEach(id => {
      const n = doneNotes.find(x => x.id === id);
      if (n) citations.push({ type: 'note', id: n.id, title: n.title, podcast_name: n.source_type });
    });

    res.json({
      answer,
      citations,
      stats: { episodes_searched: dones.length, notes_searched: doneNotes.length, context_chars: context.length },
    });
  } catch (err) {
    console.error('Ask error:', err);
    res.status(500).json({ error: err.message || '服务器错误' });
  }
});

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => console.log(`Murmur running on port ${PORT}`));
