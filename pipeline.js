/**
 * Podcast processing pipeline:
 *   1. Download audio from RSS enclosure
 *   2. Transcribe via Groq API (chunked) with local fallback
 *   3. Extract notes with Claude Code CLI
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const AUDIO_DIR = path.join(__dirname, 'audio');
const TRANSCRIPTS_DIR = path.join(__dirname, 'transcripts');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);
if (!fs.existsSync(TRANSCRIPTS_DIR)) fs.mkdirSync(TRANSCRIPTS_DIR);

// --- Step 1: Download audio (with timeout and retry) ---
function downloadAudio(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    if (!url) return reject(new Error('No audio URL'));

    let attempt = 0;
    const maxAttempts = 3;

    function doDownload() {
      attempt++;
      let settled = false;
      const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

      // 10 minute timeout for the entire download
      const timer = setTimeout(() => {
        settle(reject, new Error(`Download timeout after 10 min (attempt ${attempt})`));
      }, 10 * 60 * 1000);

      function doGet(u, redirects = 0) {
        if (redirects > 8) return settle(reject, new Error('Too many redirects'));
        const m = u.startsWith('https') ? https : http;
        const req = m.get(u, { headers: { 'User-Agent': 'PodcastGallery/1.0' }, timeout: 30000 }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return doGet(res.headers.location, redirects + 1);
          }
          if (res.statusCode !== 200) return settle(reject, new Error(`HTTP ${res.statusCode}`));

          const total = parseInt(res.headers['content-length'] || '0');
          let downloaded = 0;
          const file = fs.createWriteStream(destPath);

          res.on('data', (chunk) => {
            downloaded += chunk.length;
            file.write(chunk);
            if (total > 0 && onProgress) onProgress(Math.round((downloaded / total) * 100));
          });

          res.on('end', () => {
            file.end(() => {
              clearTimeout(timer);
              // Verify file is not empty
              const size = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
              if (size < 1000) {
                settle(reject, new Error(`Downloaded file too small: ${size} bytes`));
              } else {
                settle(resolve, destPath);
              }
            });
          });

          res.on('error', (e) => { clearTimeout(timer); settle(reject, e); });
          file.on('error', (e) => { clearTimeout(timer); settle(reject, e); });
        });

        req.on('error', (e) => { clearTimeout(timer); settle(reject, e); });
        req.on('timeout', () => { req.destroy(); clearTimeout(timer); settle(reject, new Error('Connection timeout')); });
      }

      doGet(url);
    }

    // Retry wrapper
    (async () => {
      for (let i = 0; i < maxAttempts; i++) {
        try {
          const result = await new Promise((res, rej) => { doDownload = () => { /* reset */ }; doDownload(); res; rej; });
          return resolve(result);
        } catch (e) {
          if (i < maxAttempts - 1) {
            onProgress && onProgress(0);
          } else {
            return reject(e);
          }
        }
      }
    })();

    // Just run the first attempt directly
    doDownload();
  });
}

// --- Step 2: Transcribe with Python script ---
function transcribeAudio(audioPath, updateProgress, onProcess) {
  return new Promise((resolve, reject) => {
    updateProgress({ step: 'transcribing', progress: 35, message: '启动转录引擎...' });

    const scriptPath = path.join(__dirname, 'transcribe.py');
    const txtPath = audioPath.replace(/\.[^.]+$/, '.txt');
    const proc = spawn('/opt/miniconda3/bin/python3', [scriptPath, audioPath, txtPath], {
      env: {
        ...process.env,
        PATH: '/opt/miniconda3/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
        GROQ_API_KEY: process.env.GROQ_API_KEY || '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      // No timeout — long podcasts can take a while with Groq chunking
    });
    if (onProcess) onProcess(proc);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => {
      const lines = d.toString().split('\n');
      for (const line of lines) {
        stdout += line + '\n';
        try {
          const msg = JSON.parse(line);
          if (msg.message) {
            const prog = msg.progress != null ? msg.progress : null;
            const mappedProg = prog != null ? 35 + Math.round(prog * 0.35) : 50;
            updateProgress({ step: 'transcribing', progress: mappedProg, message: msg.message });
          }
        } catch(e) {}
      }
    });

    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', code => {
      if (code === 0) {
        const match = stdout.match(/===TRANSCRIPT_START===\n([\s\S]*?)===TRANSCRIPT_END===/);
        if (match && match[1].trim().length > 100) {
          resolve(match[1].trim());
        } else if (fs.existsSync(txtPath) && fs.statSync(txtPath).size > 100) {
          resolve(fs.readFileSync(txtPath, 'utf-8'));
        } else {
          reject(new Error('Transcript output empty or not found'));
        }
      } else {
        reject(new Error(`Transcribe failed (code ${code}): ${stderr.slice(-500)}`));
      }
    });

    proc.on('error', reject);
  });
}

// --- Step 3: Extract notes with Claude CLI ---
function extractNotes(transcript, podcastName, episodeTitle, onProcess) {
  return new Promise((resolve, reject) => {
    const maxLen = 500000;
    const truncated = transcript.length > maxLen
      ? transcript.substring(0, maxLen) + '\n\n[...逐字稿已截断...]'
      : transcript;

    const prompt = `你是一个播客内容提炼专家。请根据以下播客逐字稿，严格按照三个模块输出结构化笔记。

播客名称：「${podcastName}」
本集标题：「${episodeTitle}」

## 输出格式要求

### 模块A：反共识金句（放在最前面作为索引）
- 从全文提炼 10-20 条反共识、高密度金句
- 格式：引号包裹，每条独立一行
- 标准：不是「说得好听」，而是「与常识相悖但有完整论证支撑」的观点

### 模块B：分章节核心观点
将内容按主要话题分章节，每章节包含：
1. **核心命题**（1-2句话中心论点）
2. **展开论述**（前因后果、推导链、举例，不少于200字，不得简化为列表）
3. **话语体系**（嘉宾特有的概念/框架/比喻，直接引用原文用词）

要求：还原论述完整结构，保留嘉宾原话风格，不翻译成官方语言。

### 模块C：专业名词解释词典（放在末尾）
识别所有有理解门槛的概念（经济学/社会学效应、数学/物理概念、哲学概念、行业术语、嘉宾自创概念）。
格式：**[名词]**（[英文/原文]）出处。通俗解释2-3句。嘉宾自创概念标注「嘉宾定义」。

---

以下��逐字稿全文：

${truncated}`;

    const claudePath = '/Users/slgz1115/.deskclaw/node/bin/claude';
    const child = spawn(claudePath, ['-p', '--no-session-persistence'], {
      env: { ...process.env, PATH: process.env.PATH + ':/Users/slgz1115/.deskclaw/node/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (onProcess) onProcess(child);

    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('close', code => {
      if (code === 0 && stdout.trim().length > 200) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Claude failed (code ${code}): ${stderr.slice(-500) || 'empty output'}`));
      }
    });

    child.on('error', reject);
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// --- Full pipeline ---
async function runPipeline(episode, audioUrl, updateProgress, onProcess) {
  const epId = episode.id;
  const audioPath = path.join(AUDIO_DIR, `ep_${epId}.mp3`);

  try {
    // Step 1: Download (skip if already downloaded)
    if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 10000) {
      updateProgress({ step: 'downloading', progress: 30, message: '音频已缓存，跳过下载' });
    } else {
      updateProgress({ step: 'downloading', progress: 5, message: '下载音频中...' });
      await downloadAudio(audioUrl, audioPath, (pct) => {
        updateProgress({ step: 'downloading', progress: 5 + Math.round(pct * 0.25), message: `下载音频... ${pct}%` });
      });
    }
    updateProgress({ step: 'downloading', progress: 30, message: '音频就绪' });

    // Step 2: Transcribe
    const transcript = await transcribeAudio(audioPath, updateProgress, onProcess);
    updateProgress({ step: 'transcribing', progress: 70, message: '转录完成，开始提炼...' });

    // Step 3: Extract notes
    updateProgress({ step: 'extracting', progress: 75, message: 'Claude 正在按 Skill 提炼三模块笔记...' });
    const notes = await extractNotes(transcript, episode.podcast_name, episode.title, onProcess);
    updateProgress({ step: 'saving', progress: 95, message: '保存笔记...' });

    // Cleanup audio (keep transcript)
    try { fs.unlinkSync(audioPath); } catch(e) {}

    return { transcript, notes };

  } catch (err) {
    // Don't delete audio on failure so retry doesn't re-download
    throw err;
  }
}

module.exports = { runPipeline, downloadAudio, transcribeAudio, extractNotes };
