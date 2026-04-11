const express = require('express');
const Database = require('better-sqlite3');
const Parser = require('rss-parser');
const cron = require('node-cron');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const { runPipeline, extractNotes } = require('./pipeline');

const app = express();
const parser = new Parser({ customFields: { item: [['enclosure', 'enclosure']] } });
// Use /data for persistent storage on Railway, fallback to local
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const db = new Database(path.join(DATA_DIR, 'podcasts.db'));
const TRANSCRIPTS_DIR = path.join(__dirname, 'transcripts');
if (!fs.existsSync(TRANSCRIPTS_DIR)) fs.mkdirSync(TRANSCRIPTS_DIR);

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

app.post('/api/podcasts', async (req, res) => {
  const { name, rss_url, artwork } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const info = db.prepare('INSERT INTO podcasts (name, rss_url, artwork) VALUES (?, ?, ?)').run(name, rss_url || null, artwork || null);
  if (rss_url) { try { await fetchEpisodes(info.lastInsertRowid, rss_url); } catch(e) { console.error(e); } }
  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/podcasts/:id', (req, res) => {
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

app.patch('/api/episodes/:id', (req, res) => {
  const { status, notes } = req.body;
  if (status) db.prepare('UPDATE episodes SET status=? WHERE id=?').run(status, req.params.id);
  if (notes !== undefined) db.prepare('UPDATE episodes SET notes=? WHERE id=?').run(notes, req.params.id);
  res.json({ ok: true });
});

// ========== CORE: Start full auto pipeline ==========
app.post('/api/episodes/:id/process', async (req, res) => {
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
app.post('/api/episodes/:id/transcript', async (req, res) => {
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
app.post('/api/kg/edit', (req, res) => {
  const { term, action, new_name, new_category, new_subcategory, user_note } = req.body;
  if (!term || !action) return res.status(400).json({ error: 'term and action required' });
  db.prepare(`INSERT OR REPLACE INTO kg_edits (term, action, new_name, new_category, new_subcategory, user_note, updated_at) VALUES (?,?,?,?,?,?,datetime('now'))`).run(
    term, action, new_name || null, new_category || null, new_subcategory || null, user_note || null
  );
  res.json({ ok: true });
});

// Remove a KG edit (restore term)
app.delete('/api/kg/edit/:term', (req, res) => {
  db.prepare('DELETE FROM kg_edits WHERE term=?').run(req.params.term);
  res.json({ ok: true });
});

// Toggle star
app.post('/api/episodes/:id/star', (req, res) => {
  const id = parseInt(req.params.id);
  const ep = db.prepare('SELECT starred FROM episodes WHERE id=?').get(id);
  const newVal = ep && ep.starred ? 0 : 1;
  db.prepare('UPDATE episodes SET starred=? WHERE id=?').run(newVal, id);
  res.json({ ok: true, starred: newVal });
});

// Abort a running pipeline
app.post('/api/episodes/:id/abort', (req, res) => {
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

app.post('/api/episodes/oneoff', async (req, res) => {
  const { title, link, description } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  let oneoff = db.prepare(`SELECT id FROM podcasts WHERE name='_散装收藏'`).get();
  if (!oneoff) { const info = db.prepare(`INSERT INTO podcasts (name) VALUES ('_散装收藏')`).run(); oneoff = { id: info.lastInsertRowid }; }
  db.prepare(`INSERT INTO episodes (podcast_id, title, link, description, is_oneoff, pub_date) VALUES (?,?,?,?,1,datetime('now'))`).run(
    oneoff.id, title, link || null, description || null);
  res.json({ ok: true });
});

app.post('/api/refresh', async (req, res) => {
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

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => console.log(`Fayeyu's Podcast Gallery running on port ${PORT}`));
