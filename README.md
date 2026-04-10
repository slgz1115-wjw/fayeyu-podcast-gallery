# Fayeyu's Podcast Gallery 🎙️

> 播客订阅、自动转录、AI 内容提炼与知识图谱构建的一站式工作站。

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js)
![Python](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python)
![Claude](https://img.shields.io/badge/Claude_Code-Powered-FF6A00)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## 功能全景

### 🔔 播客订阅与更新检测
- 输入播客名称，**自动从 Apple Podcasts 搜索并获取 RSS 链接**
- 每 30 分钟自动检测 RSS 更新，新剧集实时通知
- 支持「喂入单集链接」——不在订阅范围的播客也能直接加入处理

### ⚡ 全自动提炼流水线
点击「自动提炼」，系统全自动完成：

```
下载音频（RSS enclosure）
    ↓
Groq Whisper 极速转录（1h 播客 ≈ 30s）
    ↓
Claude Code 按 Skill 提炼三模块笔记
    ↓
笔记归档，进度条实时显示
```

### 📝 三模块结构化笔记（基于 podcast-notion-notes Skill）

| 模块 | 内容 | 标准 |
|------|------|------|
| **反共识金句** | 10-20 条与常识相悖但有完整论证的观点 | 放在最前面作为快速索引 |
| **分章节核心观点** | 按话题分章，每章含核心命题、展开论述、话语体系 | 还原完整论述结构，不简化为列表 |
| **专业名词词典** | AI/经济学/哲学/行业术语 + 嘉宾自创概念 | 通俗解释 + 本集语境说明 |

### 🧠 知识图谱（Obsidian 风格）

从已提炼笔记的词典模块中自动提取术语，按 **五大领域** 分层组织：

```
🧠 AI 基础理论
  ├─ 模型架构：Transformer, MoE, Flash Attention...
  ├─ 训练方法：强化学习, 预训练, Self-Play...
  └─ 智能扩展：Test-time Compute Scaling, AGI...

⚙️ AI 工程基础设施
  ├─ 硬件与底层：CUDA, Triton, FP8...
  └─ 系统与协议：MCP, Benchmark, Infra...

🤖 AI 应用与产品
  ├─ 智能体：Agentic Model, 端到端...
  └─ 具身与感知：VLA, 世界模型, 遥操作...

🚀 AI 商业与创业
  ├─ 商业模式：ARR, 数据飞轮...
  └─ 竞争与护城河...

📈 经济与金融
  ├─ 宏观经济：财富效应...
  └─ 投资与交易：期权, 量化交易...
```

**双向链接**：
- 知识图谱 → 点击概念 → 跳转到笔记原文中该术语出现的位置
- 笔记正文 → 术语自动紫色高亮 → 点击弹出定义卡片 + 跨播客引用

### ⭐ Best of Faye
星标收藏你最喜欢的播客剧集，形成个人精选库。

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | Vanilla JS + marked.js（Markdown 渲染） |
| 后端 | Node.js + Express |
| 数据库 | SQLite（better-sqlite3） |
| 转录 | Groq Whisper API（极速）/ mlx-whisper（Apple Silicon 本地）/ faster-whisper（CPU 本地） |
| 内容提炼 | Claude Code CLI（`claude -p`） |
| RSS 解析 | rss-parser |
| 定时任务 | node-cron（每 30 分钟检测更新） |
| 进程管理 | pm2 |

---

## 快速开始

### 前置条件

- Node.js 18+
- Python 3.10+
- [Claude Code CLI](https://claude.ai/code) 已安装并登录
- Groq API Key（免费，从 [console.groq.com](https://console.groq.com/keys) 获取）

### 安装

```bash
git clone https://github.com/slgz1115-wjw/fayeyu-podcast-gallery.git
cd fayeyu-podcast-gallery
npm install
pip3 install faster-whisper  # 或 pip3 install mlx-whisper（Apple Silicon）
```

### 配置

```bash
# 创建 ecosystem 配置
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'podcast-gallery',
    script: 'server.js',
    env: {
      GROQ_API_KEY: 'your_groq_api_key_here',
    }
  }]
};
EOF
```

### 启动

```bash
pm2 start ecosystem.config.js
pm2 save

# 访问 http://localhost:3456
```

### 使用流程

1. 在搜索框输入播客名称（如「晚点聊」），自动获取 RSS 并拉取剧集
2. 点击「⚡ 自动提炼」→ 系统自动下载、转录、提炼
3. 进度条实时显示处理状态
4. 完成后点「查看笔记」→ 右侧抽屉展示格式化笔记
5. 在「知识图谱」页面浏览跨播客的概念网络

---

## 项目结构

```
├── server.js          # Express 后端，API 路由，RSS 抓取
├── pipeline.js        # 提炼流水线：下载 → 转录 → Claude 提炼
├── transcribe.py      # 多引擎转录脚本（Groq > mlx-whisper > faster-whisper）
├── ecosystem.config.js # pm2 配置（含 API keys）
├── public/
│   ├── index.html     # 前端单页应用
│   └── logo.svg       # Logo
├── audio/             # 临时音频文件（处理后自动清理）
└── transcripts/       # 临时转录文件
```

---

## Credits

- 内容提炼方法论来自 [podcast-notion-notes](https://claude.ai) Skill
- 转录引擎：[Groq](https://groq.com)（云端极速）、[mlx-whisper](https://github.com/ml-explore/mlx-examples)（Apple Silicon）
- AI 提炼：[Claude Code](https://claude.ai/code) by Anthropic

---

*Built with Claude Code* 🤖
