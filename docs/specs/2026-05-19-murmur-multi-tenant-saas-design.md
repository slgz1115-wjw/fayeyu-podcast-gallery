# Murmur 多租户 SaaS 改造 · 设计文档

**日期**：2026-05-19
**状态**：已确认 reasonable defaults，待 Faye review 后实施
**作用范围**：Murmur 从单实例共享 → 多租户 SaaS（开放注册，每人独立账号）

## 概述

Murmur 当前是单实例单 admin password。本设计把它改造成多租户 SaaS：

- 任何人来 URL 点「注册」→ 填 email + 自定义密码 → 立刻得到独立账号
- 每人有自己的 podcasts / episodes / notes / comments / glimpses，**完全互不可见**
- 用户自带 DeepSeek + Groq API key（避免 Faye 付所有人账单）
- Faye 现有数据（9 podcasts / 28 done episodes / 33 notes / 3 comments）一次性迁到 `user_id=1`

部署保持现状（Tailscale Funnel + Mac），URL 不变（`https://murmur-mac.tail2817ed.ts.net`）。

---

## 一、架构

### 1.1 用户隔离模型

**单 SQLite + user_id 列**（不换 Postgres，不上每用户一份 DB —— 都是过早优化）。

每张业务表加 `user_id INTEGER NOT NULL`，所有 query `WHERE user_id = ?`。

### 1.2 数据流

```
公网请求
  ↓
Tailscale Funnel HTTPS termination
  ↓
Murmur Express on :3456
  ├── /api/auth/signup   { email, password } → users 表 INSERT + 返回 session token
  ├── /api/auth/login    { email, password } → bcrypt 验证 + 发 token
  ├── /api/auth/me       { token } → 当前 user 信息
  └── /api/* (其余所有路由)
       ↓
   middleware: requireUser(req, res, next)
       ├── 从 cookie / Authorization header 拿 token
       ├── 查 sessions 表得到 user_id
       └── req.user_id = N（注入到 req 对象）
       ↓
   handler: SQL 全部 WHERE user_id = req.user_id
```

### 1.3 旧 admin auth 兼容

`requireAdmin` 中间件保留但语义变成「需要登录的 user 」（即 `requireUser`）。旧 `ADMIN_PASSWORD` env 不再用，登录走 `users` 表。

---

## 二、数据库 schema 改造

### 2.1 新增 `users` 表

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,          -- bcrypt cost 10
  display_name TEXT,                    -- 可选,默认 = email @ 前缀
  deepseek_api_key TEXT,                -- 加密存(见 § 2.3)
  groq_api_key TEXT,                    -- 加密存
  created_at TEXT DEFAULT (datetime('now')),
  last_login_at TEXT,
  is_admin INTEGER DEFAULT 0            -- 仅 user_id=1 (Faye) = 1
);
CREATE INDEX idx_users_email ON users(email);
```

### 2.2 业务表加 `user_id`

| 表 | 加列 | 说明 |
|---|---|---|
| `podcasts` | `user_id INTEGER NOT NULL DEFAULT 1` | 每用户自己订阅自己的 |
| `episodes` | `user_id INTEGER NOT NULL DEFAULT 1` | 冗余字段（也可 derive from podcasts.user_id），但加上更安全 + oneoff episodes 没绑 podcast 也能归属 |
| `notes` | `user_id INTEGER NOT NULL DEFAULT 1` | 笔记 + glimpse + lark 全在这表 |
| `comments` | `user_id INTEGER NOT NULL DEFAULT 1` | 评论 + 思考集 |
| `kg_edits` | `user_id INTEGER NOT NULL DEFAULT 1` + PK 改为 `(user_id, term)` | KG 编辑是私人的 |
| `skills` | **不加 user_id** | skill 模板是 Murmur 平台预置，全用户共享 |
| `sessions` | 加 `user_id INTEGER NOT NULL` | session token 归属 |

`DEFAULT 1` 是为了 migration：现有数据自动归属 user_id=1（Faye）。

**oneoff episode 处理**：每个 user 自己有一个 `_散装收藏` virtual podcast（按 user_id 隔离），不再全局共享。Migration 把现有的 user_id=1。

### 2.3 API key 加密

用户自带的 DeepSeek / Groq key 存数据库不能明文（数据库 leak = 所有用户 API key 泄露）。

**简单可靠方案**：用一个 master encryption key（存 env `MURMUR_ENCRYPTION_KEY`，32 字节随机）+ AES-256-GCM 对每个 user 的 API key 单独加密。

```javascript
// 存
const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
const encrypted = cipher.update(apiKey, 'utf8', 'hex') + cipher.final('hex');
const tag = cipher.getAuthTag().toString('hex');
db.run('UPDATE users SET deepseek_api_key = ? WHERE id = ?',
       [`${iv.toString('hex')}:${encrypted}:${tag}`, userId]);

// 读
const [ivHex, encrypted, tagHex] = encryptedString.split(':');
const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey,
                                         Buffer.from(ivHex, 'hex'));
decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
const apiKey = decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
```

Master key 丢了 = 所有用户都需要重设 key（自己重新填 DeepSeek / Groq key）—— 不致命。

---

## 三、Auth 流程

### 3.1 注册

```
POST /api/auth/signup
Body: { email, password }
约束:
  - email 格式验证 (regex)
  - email 唯一 (UNIQUE constraint)
  - password 至少 8 位
  - 不发邮件验证 (Faye 决定)

成功:
  - bcrypt hash password
  - INSERT users
  - 返回 { ok: true, token, user: { id, email, display_name } }
  - 自动创建 session
```

### 3.2 登录

```
POST /api/auth/login
Body: { email, password }
  - 查 users WHERE email = ?
  - bcrypt.compareSync(password, user.password_hash)
  - 成功 → INSERT sessions (token, user_id, created, expires)
  - 返回 { ok: true, token, user }
  - 更新 last_login_at
```

### 3.3 Session 中间件

```javascript
function requireUser(req, res, next) {
  const token = req.cookies?.session || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'login required' });
  const session = db.prepare('SELECT user_id, expires FROM sessions WHERE token = ?').get(token);
  if (!session || session.expires < Date.now()) return res.status(401).json({ error: 'session expired' });
  req.user_id = session.user_id;
  next();
}
```

### 3.4 登出

`POST /api/auth/logout` → 删 session row。

---

## 四、SQL 改造（70 处审计）

`server.js` ~70 处 SQL 全部要加 user_id 过滤。

**机械模式**：

```sql
-- 改前
SELECT * FROM podcasts;
-- 改后
SELECT * FROM podcasts WHERE user_id = ?;

-- 改前
SELECT e.* FROM episodes e JOIN podcasts p ON e.podcast_id=p.id;
-- 改后
SELECT e.* FROM episodes e JOIN podcasts p ON e.podcast_id=p.id WHERE p.user_id = ?;

-- 改前
INSERT INTO podcasts (name, rss_url) VALUES (?, ?);
-- 改后
INSERT INTO podcasts (user_id, name, rss_url) VALUES (?, ?, ?);
```

**例外**：

- `skills` 表全用户共享，**不加** user_id 过滤
- `sessions` 表只在 auth middleware 用，**不需要** WHERE user_id（session token 已经 imply user）
- `kg_edits` 表 PK 改为复合 `(user_id, term)`，所有 query 加 user_id

---

## 五、UI 改造

### 5.1 新增页面

| 路径 | 内容 |
|---|---|
| `/login` | 邮箱 + 密码，登录 / 注册 切换 tab |
| `/settings` | 设置页：改密码、display_name、填 DeepSeek / Groq API key、登出 |

或者：现有单页应用基础上加 **登录前的 splash 页**（未登录时显示注册/登录卡片，登录后展开主应用）。

**推荐做法**：在 `public/index.html` 同一文件内做，加一段：

```html
<div id="auth-gate" style="display:none">
  <!-- 注册 / 登录卡片 -->
</div>
<div id="app-main">
  <!-- 现有所有 UI -->
</div>

<script>
  // 启动时 GET /api/auth/me, 拿不到 user → show #auth-gate, hide #app-main
</script>
```

### 5.2 顶部加 user 区

右上角加一个 user dropdown：
- 显示当前 email / display_name
- 「设置」入口
- 「登出」按钮

替换或扩展现有的 theme dropdown。

### 5.3 settings 页

简单一个 modal 或 panel：
- DeepSeek API key 输入框（type=password）
- Groq API key 输入框
- 改密码 form
- 「保存」「登出」按钮

API key 输入后立刻 POST `/api/auth/settings`，server 加密后存 DB，不返回明文 key（前端始终不显示明文 key）。

---

## 六、pipeline.js 改造

`pipeline.js` 是后台 job（download → transcribe → extract）。要传 user_id：

```javascript
// 改前
function runPipeline(episodeId) { ... }

// 改后
function runPipeline(episodeId, userId) {
  // 用 userId 查 users 表拿 deepseek/groq key 解密
  const user = db.prepare('SELECT deepseek_api_key, groq_api_key FROM users WHERE id = ?').get(userId);
  const deepseekKey = decryptApiKey(user.deepseek_api_key);
  const groqKey = decryptApiKey(user.groq_api_key);
  if (!deepseekKey || !groqKey) throw new Error('user 未配置 API key');
  // 用这些 key 调外部服务
}
```

Server.js 触发 pipeline 时传入 `req.user_id`。

---

## 七、Faye 旧数据迁移

启动时一次性 migration（idempotent）：

```javascript
function runMultiTenantMigration() {
  // 1. 如果 users 表已有 row,跳过
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount > 0) return console.log('[migration] users 表已有数据,跳过');

  // 2. 创建 Faye 账户(user_id=1)
  const fayePasswordHash = bcrypt.hashSync(process.env.FAYE_INITIAL_PASSWORD || '<FAYE_INITIAL_PASSWORD>', 10);
  db.prepare(`INSERT INTO users (id, email, password_hash, display_name, is_admin, deepseek_api_key, groq_api_key)
              VALUES (1, ?, ?, ?, 1, ?, ?)`).run(
    'fayeyu@deltax.world',
    fayePasswordHash,
    'Faye',
    encryptApiKey(process.env.DEEPSEEK_API_KEY),
    encryptApiKey(process.env.GROQ_API_KEY)
  );

  // 3. 现有数据 user_id 字段都 default 1 (schema 设的),无需 UPDATE

  console.log('[migration] Faye 账户已建 (user_id=1), DeepSeek/Groq key 已加密导入');
}
```

Faye 登录用：`fayeyu@deltax.world` + 现有 `<FAYE_INITIAL_PASSWORD>`（之后她可以在 settings 改）。

---

## 八、API key fallback 策略

新注册用户**没填 API key 之前**怎么办？两种选择：

| 策略 | 行为 |
|---|---|
| A. 严格 | 没 API key 时 process 调用直接 401，让用户先去 settings 填 |
| B. 宽松 | 没填时 fallback 到平台默认 key（Faye 的）+ 加 quota（比如每月 10 次提炼）|

**推荐 A**（更省 Faye 钱，更清晰）。

**没填 API key 时哪些 endpoint 可用 / 不可用**：

| Endpoint | 没 key | 说明 |
|---|---|---|
| `/api/auth/*` | ✓ 可用 | 注册 / 登录 / 设置自己的 key 必须能用 |
| `/api/podcasts` (GET) | ✓ 可用 | 看自己已订阅列表，不需要 LLM |
| `/api/podcasts` (POST) + `/api/refresh` | ✓ 可用 | 订阅 / 抓 RSS 不需要 LLM |
| `/api/episodes/:id/process` | ✗ 401 + 错误 message | 提炼三模块需要 DeepSeek + Groq，未填提示去 settings |
| `/api/ask` | ✗ 401 | Ask Murmur 需要 DeepSeek |
| `/api/notes/:id/process` | ✗ 401 | 笔记提炼需要 DeepSeek |

Settings 页第一次打开 highlight 提示「填了才能用，免费在 https://deepseek.com 注册」。

---

## 九、并发 / 安全

### 9.1 SQLite 并发

SQLite 支持多读单写。Murmur 当前流量 + 小用户量 (<50)，单 DB 文件够。**写并发瓶颈**只在 transcribe + extract 同时多用户跑时，pipeline.js 已经是单文件单 episode 顺序处理，整体并发瓶颈在 LLM API 而非 DB。

### 9.2 Brute force

新注册开放 + 公网暴露 = login endpoint 会被 bot 扫。加 rate limit：

```javascript
const rateLimit = require('express-rate-limit');
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max: 10,                    // 每 IP 最多 10 次/15min
  message: { error: '尝试太频繁,稍后再试' },
}));
app.use('/api/auth/signup', rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 3,                     // 每 IP 最多 3 个账号/小时
  message: { error: '注册太频繁,稍后再试' },
}));
```

### 9.3 数据泄漏防御

每个 SQL query 加 user_id 过滤是**唯一**防线 —— 一处漏了就跨用户数据泄露。**强制 code review**：合并前 grep 所有新加的 SQL 必须含 user_id 过滤。

---

## 十、不在本次 scope 里

- ❌ 邮箱验证（Faye 决定）
- ❌ 密码重置（v1 没邮件 → 用户忘密码联系 Faye 手动 reset；v2 再加）
- ❌ Google / GitHub SSO
- ❌ 多人协作 / 笔记 share
- ❌ 公开笔记 / 公开 glimpse 页面
- ❌ Quota / billing
- ❌ Admin dashboard（Faye 当前只是 user_id=1，没专门 admin 后台）

---

## 十一、文件改动清单

**新建**：
- `/Users/slgz1115/podcast-hub/lib/crypto.js` — encryptApiKey / decryptApiKey
- `/Users/slgz1115/podcast-hub/lib/auth.js` — bcrypt + session token + requireUser middleware
- `/Users/slgz1115/podcast-hub/migrations/2026-05-19-multi-tenant.js` — schema migration

**修改**：
- `~/podcast-hub/server.js` — auth 路由 + 70+ SQL 加 user_id + middleware
- `~/podcast-hub/pipeline.js` — runPipeline 传 user_id + 解密 API key
- `~/podcast-hub/public/index.html` — auth gate + settings 页
- `~/podcast-hub/package.json` — 加 `bcrypt`, `express-rate-limit`, `cookie-parser`

**Env**：
- `MURMUR_ENCRYPTION_KEY` (新, 32 字节 random hex)
- `FAYE_INITIAL_PASSWORD` (新, migration 用一次性, 之后她改自己的)
- `ADMIN_PASSWORD` (废弃)

---

## 十二、估时

| 阶段 | 任务 | 估时 |
|---|---|---|
| 1 | DB schema migration + crypto / auth lib | 0.5 天 |
| 2 | server.js 70 处 SQL audit + 加 user_id | 1 天 |
| 3 | UI auth gate + settings 页 | 0.5 天 |
| 4 | pipeline.js API key 路由 | 0.5 天 |
| 5 | Migration + 验证 Faye 旧数据可访问 | 0.5 天 |
| 6 | Rate limit + 安全审计 + 真用户端到端测试 | 0.5 天 |
| **总计** | | **~3.5 天专注开发** |

---

*v1.0 · 2026-05-19 · 待 Faye review*
