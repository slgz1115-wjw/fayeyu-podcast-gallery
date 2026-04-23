/**
 * Podcast processing pipeline:
 *   1. Download audio from RSS enclosure
 *   2. Transcribe via Groq API (chunked) with local fallback
 *   3. Extract notes with DeepSeek API
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

    function doGet(u, redirects) {
      if (redirects > 8) return reject(new Error('Too many redirects'));
      const m = u.startsWith('https') ? https : http;
      const timer = setTimeout(() => reject(new Error('Download timeout')), 10 * 60 * 1000);

      m.get(u, { headers: { 'User-Agent': 'PodcastGallery/1.0' }, timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doGet(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) { clearTimeout(timer); return reject(new Error(`HTTP ${res.statusCode}`)); }

        const total = parseInt(res.headers['content-length'] || '0');
        let downloaded = 0;
        const file = fs.createWriteStream(destPath);

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          file.write(chunk);
          if (total > 0 && onProgress) onProgress(Math.round((downloaded / total) * 100));
        });
        res.on('end', () => { file.end(() => { clearTimeout(timer); resolve(destPath); }); });
        res.on('error', (e) => { clearTimeout(timer); reject(e); });
        file.on('error', (e) => { clearTimeout(timer); reject(e); });
      }).on('error', (e) => { clearTimeout(timer); reject(e); });
    }
    doGet(url, 0);
  });
}

// --- Step 2: Transcribe with Python script ---
function transcribeAudio(audioPath, updateProgress, onProcess) {
  return new Promise((resolve, reject) => {
    updateProgress({ step: 'transcribing', progress: 35, message: 'Groq Whisper 转录中...' });

    const scriptPath = path.join(__dirname, 'transcribe.py');
    const txtPath = audioPath.replace(/\.[^.]+$/, '.txt');
    const pythonCmd = process.env.PYTHON_PATH || 'python3';
    const proc = spawn(pythonCmd, [scriptPath, audioPath, txtPath], {
      env: {
        ...process.env,
        GROQ_API_KEY: process.env.GROQ_API_KEY || '',
      },
    });
    if (onProcess) onProcess(proc);

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => {
      const lines = d.toString().split('\n');
      for (const line of lines) {
        stdout += line + '\n';
        try {
          const msg = JSON.parse(line);
          if (msg.message) {
            const prog = msg.progress != null ? 35 + Math.round(msg.progress * 0.35) : 50;
            updateProgress({ step: 'transcribing', progress: prog, message: msg.message });
          }
        } catch(e) {}
      }
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) {
        const match = stdout.match(/===TRANSCRIPT_START===\n([\s\S]*?)===TRANSCRIPT_END===/);
        if (match && match[1].trim().length > 100) resolve(match[1].trim());
        else if (fs.existsSync(txtPath) && fs.statSync(txtPath).size > 100) resolve(fs.readFileSync(txtPath, 'utf-8'));
        else reject(new Error('Transcript output empty'));
      } else {
        reject(new Error(`Transcribe failed (code ${code}): ${stderr.slice(-500)}`));
      }
    });
    proc.on('error', reject);
  });
}

// --- Step 3: Extract notes with DeepSeek API ---
function extractNotes(transcript, podcastName, episodeTitle) {
  return new Promise((resolve, reject) => {
    const maxLen = 500000;
    const truncated = transcript.length > maxLen
      ? transcript.substring(0, maxLen) + '\n\n[...truncated...]'
      : transcript;

    const prompt = `你是一位专业的播客内容分析师。请对以下播客逐字稿进行深度提炼，输出三个模块的结构化笔记。

播客名称：「${podcastName}」
本集标题：「${episodeTitle}」

# 核心原则

- **忠于原话**：金句必须是说话人的原始表述，不做改写
- **体系化而非碎片化**：观点要梳理成有逻辑层级的体系，不是简单罗列
- **术语完整**：每个专业名词都要有定义，不能只列名字
- **聚焦嘉宾**：如果是访谈类播客，重点提炼嘉宾的观点，而非主持人的提问
- **篇幅充分**：整体输出不少于 3000 字，模块B的每个章节不少于 300 字

---

## 模块A：反共识金句

从全文中提炼 10-20 条反共识、高密度金句。

**筛选标准**：
- 有信息密度的原话，不是客套话或过渡语
- 能独立成立、脱离上下文也有意义的断言
- 与常识相悖但有完整论证支撑的观点
- 避免陈词滥调和已经被说烂的观点

**格式**：
> "金句内容"
> —— 简短的一句话背景说明（为什么这句话重要）

---

## 模块B：分章节核心观点

将内容按主要话题分章节。每个章节包含：

1. **核心命题**（1-2句话，该章节的中心论点）
2. **展开论述**（包含前因后果、推导链、举例、与其他章节的内部关联，不少于 300 字）
   - 每个分论点是什么
   - 论点之间的逻辑关系（递进/并列/对比/因果）
   - 支撑论据（案例/数据/类比）
   - 推理链条（前提→推理→结论）
3. **话语体系**（该嘉宾特有的概念/框架/比喻，直接引用原文用词）

**写作要求**：
- 不得简化为要点列表了事，必须还原论述的完整结构
- 如果嘉宾在该话题上的论述有多个层次（比喻→推理→实践），都要体现
- 保留嘉宾的原话表达风格，不要翻译成四平八稳的商业语言
- 如果说话人前后有矛盾或自我修正，也要记录下来
- 当说话人讲了一个完整的逻辑闭环，必须完整保留，不能只留结论
- 当说话人引用了历史经验或案例来论证观点，保留案例的关键细节

---

## 专业名词解释词典

⚠️ 这个标题「## 专业名词解释词典」是下游系统自动解析的锚点，必须一字不差地输出。不要写成「模块C」「术语词典」「名词解释」等任何变体。

从全文中识别所有有理解门槛的概念，包括：
- 经济学/社会学效应（马太效应、长尾效应等）
- 数学/物理概念（贝叶斯公式、奥卡姆剃刀等）
- 哲学概念（存在主义、荒诞主义等）
- 行业术语（prompt engineering、向量数据库、MoE、RLHF 等）
- 嘉宾自创概念（需标注「嘉宾定义」，这些往往是最有价值的）
- 引用的历史人物/理论

**严格格式**：

**[术语名]**（English Name）
[出处/学科来源]。[通俗解释，2-3句话，说清楚它是什么、为什么重要、在本集播客中如何使用]

**要求**：
- 最少 8 个，最多 30 个，必须覆盖全部主要概念
- 每个术语必须有完整定义，不能只列名字
- 有英文名的一定要标注
- 定义要准确、简洁、可独立阅读

---

## 常见错误，严格避免

- ❌ 把章节写成要点 bullet list 了事（要有完整论述，每章不少于 300 字）
- ❌ 把嘉宾的话翻译成「官方语言」（保留原有风格和自创词）
- ❌ 名词词典漏掉嘉宾自创概念（自创概念最有价值）
- ❌ 反共识金句选了「听起来好听」的（要选「反常识但有论证」的）
- ❌ 模块B只写了结论没写推理过程（必须保留论证链条）
- ❌ 整体输出太短（总输出不应少于 3000 字）

---

以下是逐字稿全文：

${truncated}`;

    const apiKey = process.env.DEEPSEEK_API_KEY || '';
    if (!apiKey) return reject(new Error('DEEPSEEK_API_KEY not set'));

    const body = JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 8192,
      temperature: 0.3,
    });

    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 600000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content;
          if (content && content.length > 200) resolve(content);
          else reject(new Error(`DeepSeek empty response: ${data.slice(0, 300)}`));
        } catch (e) {
          reject(new Error(`DeepSeek parse error: ${e.message}, body: ${data.slice(0, 300)}`));
        }
      });
    });

    req.on('error', e => reject(new Error(`DeepSeek request error: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('DeepSeek timeout (10min)')); });
    req.write(body);
    req.end();
  });
}

// --- Full pipeline ---
async function runPipeline(episode, audioUrl, updateProgress, onProcess) {
  const audioPath = path.join(AUDIO_DIR, `ep_${episode.id}.mp3`);

  try {
    // Step 1: Download
    if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 10000) {
      updateProgress({ step: 'downloading', progress: 30, message: '音频已缓存' });
    } else {
      updateProgress({ step: 'downloading', progress: 5, message: '下载音频中...' });
      await downloadAudio(audioUrl, audioPath, (pct) => {
        updateProgress({ step: 'downloading', progress: 5 + Math.round(pct * 0.25), message: `下载音频... ${pct}%` });
      });
    }

    // Step 2: Transcribe
    const transcript = await transcribeAudio(audioPath, updateProgress, onProcess);
    updateProgress({ step: 'transcribing', progress: 70, message: '转录完成' });

    // Step 3: Extract notes
    updateProgress({ step: 'extracting', progress: 75, message: 'DeepSeek 提炼三模块笔记...' });
    const notes = await extractNotes(transcript, episode.podcast_name, episode.title);
    updateProgress({ step: 'saving', progress: 95, message: '保存笔记...' });

    try { fs.unlinkSync(audioPath); } catch(e) {}
    return { transcript, notes };
  } catch (err) {
    throw err;
  }
}

// Generic skill-based extraction: takes a full prompt string and returns DeepSeek response
function extractWithPrompt(prompt) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.DEEPSEEK_API_KEY || '';
    if (!apiKey) return reject(new Error('DEEPSEEK_API_KEY not set'));
    const body = JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 8192,
      temperature: 0.3,
    });
    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 300000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content;
          if (content && content.trim().length > 0) resolve(content);
          else reject(new Error(`DeepSeek empty response: ${data.slice(0, 300)}`));
        } catch (e) {
          reject(new Error(`DeepSeek parse error: ${e.message}`));
        }
      });
    });
    req.on('error', e => reject(new Error(`DeepSeek request error: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('DeepSeek timeout (5min)')); });
    req.write(body);
    req.end();
  });
}

module.exports = { runPipeline, downloadAudio, transcribeAudio, extractNotes, extractWithPrompt };
