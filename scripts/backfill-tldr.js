#!/usr/bin/env node
/**
 * One-time backfill: add TL;DR to all existing done notes (episodes + notes table).
 * Idempotent — skips items that already have a `## TL;DR` section at the top.
 *
 * Usage: node scripts/backfill-tldr.js [--dry-run]
 */
const Database = require('better-sqlite3');
const path = require('path');
const { extractWithPrompt } = require('../pipeline');

const DRY_RUN = process.argv.includes('--dry-run');
const db = new Database(path.join(__dirname, '..', 'podcasts.db'));

const TLDR_PROMPT = (title, content) => `你是一位笔记分析师。下面是一份已经整理好的笔记。请只输出一个 TL;DR 段落，概括这份笔记的核心观点、阐述逻辑和叙述脉络。

## 输出格式（严格遵守）

\`\`\`
## TL;DR

**核心观点**：用 1-3 句话点破本文最根本的论断、判断或结论。不是"本文讨论了 X"，而是"关于 X，核心论断是 Y"。

**阐述逻辑**：用 4-8 句话梳理论证链条，用"因为 A，所以 B；进一步地因为 B，所以 C"的因果结构。不要罗列章节，而是抽象出推理骨架：前提 → 中间论点 → 结论。

**叙述脉络**：用 1-2 句话描述展开结构（如：现象切入→机制拆解→预判；时间纵轴→当下横切→未来展望；问题提出→多角度论证→反常识收尾）。
\`\`\`

## 严格要求

- 必须以 \`## TL;DR\` 开头（两个 \`#\`）
- 总长度 300-500 字
- 是逻辑的抽象，不是摘要的复述
- 不要有其他章节，不要重复原文，不要前言、不要收尾
- 直接输出 TL;DR 段落即可

---

标题：${title}

笔记内容：
${content.length > 40000 ? content.substring(0, 40000) + '\n\n[...内容过长已截断...]' : content}`;

function hasTldr(content) {
  // Match ## TL;DR or ### TL;DR in the first 500 chars (must be near top)
  return /^[\s\S]{0,500}#{2,3}\s*TL;?DR/i.test(content || '');
}

async function backfillOne(item, isEpisode) {
  const label = isEpisode ? `EP ${item.id}` : `NOTE ${item.id}`;
  const title = item.title;
  const contentKey = isEpisode ? 'notes' : 'content';
  const content = item[contentKey];

  if (!content || content.length < 2000) {
    console.log(`[SKIP] ${label} "${title.substring(0, 50)}" — content too short (${content?.length || 0} chars)`);
    return { skipped: true, reason: 'too_short' };
  }
  if (!isEpisode && item.source_type === 'glimpse') {
    console.log(`[SKIP] ${label} "${title.substring(0, 50)}" — glimpse entry (user's own raw clippings, no TL;DR needed)`);
    return { skipped: true, reason: 'glimpse' };
  }
  if (hasTldr(content)) {
    console.log(`[SKIP] ${label} "${title.substring(0, 50)}" — already has TL;DR`);
    return { skipped: true, reason: 'already_has_tldr' };
  }

  console.log(`[PROCESSING] ${label} "${title.substring(0, 50)}" (${content.length} chars)...`);
  const t0 = Date.now();
  if (DRY_RUN) {
    console.log(`  [DRY] would call DeepSeek`);
    return { skipped: true, reason: 'dry_run' };
  }

  try {
    const tldr = (await extractWithPrompt(TLDR_PROMPT(title, content))).trim();
    // Sanity check
    if (!/^#{2,3}\s*TL;?DR/i.test(tldr)) {
      console.log(`  [WARN] ${label} response didn't start with ## TL;DR, skipping. First 200 chars: ${tldr.substring(0, 200)}`);
      return { error: 'bad_format' };
    }
    const newContent = tldr + '\n\n---\n\n' + content;
    if (isEpisode) {
      db.prepare('UPDATE episodes SET notes=? WHERE id=?').run(newContent, item.id);
    } else {
      db.prepare(`UPDATE notes SET content=?, updated_at=datetime('now') WHERE id=?`).run(newContent, item.id);
    }
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  [OK] ${label} — TL;DR added (${tldr.length} chars) in ${dt}s`);
    return { ok: true, tldr_chars: tldr.length };
  } catch (err) {
    console.log(`  [ERR] ${label} — ${err.message}`);
    return { error: err.message };
  }
}

async function main() {
  console.log(`===== TL;DR Backfill ${DRY_RUN ? '(DRY RUN)' : ''} =====\n`);

  const eps = db.prepare(`
    SELECT e.id, e.title, e.notes, p.name as podcast_name
    FROM episodes e JOIN podcasts p ON e.podcast_id=p.id
    WHERE e.status='done' AND e.notes IS NOT NULL
    ORDER BY e.id
  `).all();

  const notes = db.prepare(`
    SELECT id, title, content, source_type
    FROM notes
    WHERE status='done' AND content IS NOT NULL
    ORDER BY id
  `).all();

  console.log(`Found ${eps.length} done episodes, ${notes.length} done notes\n`);

  const stats = { ok: 0, skipped: 0, error: 0 };
  for (const ep of eps) {
    const r = await backfillOne(ep, true);
    if (r.ok) stats.ok++;
    else if (r.skipped) stats.skipped++;
    else stats.error++;
  }
  for (const n of notes) {
    const r = await backfillOne(n, false);
    if (r.ok) stats.ok++;
    else if (r.skipped) stats.skipped++;
    else stats.error++;
  }

  console.log(`\n===== Done. OK: ${stats.ok}, Skipped: ${stats.skipped}, Errors: ${stats.error} =====`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
