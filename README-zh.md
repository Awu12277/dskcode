# DskCode

> **一个原生基于 DeepSeek 的极简 AI 编程 Agent！**
>
> DskCode 是一个极简、终端原生的 AI 编程 Agent，专注于让开发者以更少的配置和干扰完成真实的编码工作。它原生基于 DeepSeek 构建，能够理解项目结构、读取和修改代码、执行命令、搜索文件，并通过工具编排与你协作完成任务。
>
> DskCode 不追求复杂的 IDE 体验，而是将核心编码流程保留在终端中：启动快速、依赖精简、配置简单、执行过程透明。无论是排查问题、重构代码、补充功能、运行测试，还是处理日常开发任务，都可以直接在当前项目中完成。

[![Version](https://img.shields.io/npm/v/dskcode?style=flat&colorA=000000&colorB=000000)](https://npmjs.com/package/dskcode)
[![Downloads](https://img.shields.io/npm/dt/dskcode.svg?style=flat&colorA=000000&colorB=000000)](https://npmjs.com/package/dskcode)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat&colorA=000000&colorB=000000)](https://nodejs.org)

> **[English](https://github.com/Awu12277/dskcode/blob/main/README.md)** · **[中文文档](https://github.com/Awu12277/dskcode/blob/main/README-zh.md)**

<img src="https://raw.githubusercontent.com/Awu12277/pic_go/refs/heads/main//dskcode-logo.gif" width="100%" />

dskcode 是一个**终端原生 AI 编程助手**，基于 DeepSeek 构建。它直接在终端中理解你的代码、读写文件、执行命令，与你协作编码。

```bash
npm install -g dskcode
```

> [!WARNING]
> dskcode 需要 Node.js ≥ 22 和 DeepSeek API Key。[在 DeepSeek 开放平台申请](https://platform.deepseek.com)。

---

## 特性

### 🤖 AI 编程助手

- **终端原生交互** — 直接在终端中与 AI 协作编码，流式渲染
- **DeepSeek 深度集成** — 原生 DeepSeek API，Prefix Cache 感知，成本透明
- **多模型选择** — **DeepSeek-V4-Flash**（默认，速度快）与 **DeepSeek-V4-Pro**（精度高）
- **深度思考模式** — `/thinking` 开启推理能力，`/effort` 切换 High / Max 等级
- **Token 计费** — 会话级 / 日级 / 历史级三层成本统计，Prefix Cache 半价计费

### 🛠️ 工具系统

9 个内置工具覆盖文件读写、命令执行、代码搜索全场景：

| 工具 | 能力 |
| --- | --- |
| `read_file` | 读取文件，支持行号范围，自动拒绝二进制 |
| `write_file` | 写入/创建文件，自动创建中间目录 |
| `edit_file` | 精确文本替换，唯一匹配校验，保留原 EOL |
| `multi_edit` | 原子批量替换，一处失败全部回滚 |
| `delete_range` | 按行锚点删除文件中的行范围 |
| `bash` | 执行 shell 命令，超时控制，Win / Git Bash 兼容 |
| `glob` | 文件路径模式搜索，自动跳过 `node_modules` / `.git` |
| `grep` | 文件内容正则搜索，大小写控制，扩展名过滤 |
| `ls` | 目录列表，类型标记，隐藏文件控制 |

### 🔒 权限与安全

- **三级审批策略** — Allow / Ask / Deny，按工具 + 参数精细化控制
- **硬编码安全规则** — 内置 11 条灾难模式拦截：`rm -rf /`、`curl | sh`、`git push --force` 到 main 等
- **写工具默认确认** — 0 配置即可用，全局 / 项目级别细粒度权限规则
- **Turn-Abort** — 工具被拒绝后，本轮后续 tool_calls 全部跳过
- **`/permissions`** — 随时查看当前生效的规则与配置来源

### 📜 Skills

- **AGENTS.md 项目记忆** — 自动加载项目根目录的 `AGENTS.md` / `CLAUDE.md`，注入 system prompt
- **SKILL.md 技能包** — 支持全局 `~/.agents/skills/` 和项目本地 `.agents/skills/` 技能目录
- **`/skill:<name>`** — 在对话中直接引用已安装的 skill 能力

### ⚙️ 配置

- **多层级合并** — 全局 + 项目 + 环境变量 + CLI flag 四级，优先级从低到高
- **JSON 格式** — 易于编辑、版本控制、团队共享

---

## 命令

| 命令 | 说明 |
| --- | --- |
| `dskcode` | 启动交互式对话 |

### 选项

| 选项 | 说明 |
| --- | --- |
| `-V, --version` | 显示版本号 |
| `-h, --help` | 显示帮助信息 |

### 交互式 Chat 命令

在会话中输入 `/help` 查看所有可用命令：

| 命令 | 说明 |
| --- | --- |
| `/model` | 切换模型 |
| `/thinking` | 切换深度思考模式 |
| `/effort` | 切换推理等级 High / Max |
| `/permissions` | 查看当前权限规则与配置来源 |
| `/skill:<name>` | 在当前对话中引用已安装的 skill |
| `/clear` | 清空对话历史 |
| `/help` | 查看所有可用命令 |
| `/version` | 显示版本信息 |
| `/exit` / `/quit` | 退出对话 |

---

## 架构

项目采用「领域模块 + 入口骨架」的扁平分层：

| 模块 | 职责 |
| --- | --- |
| 入口 | shebang + 全局异常处理 |
| 命令路由 | commander 子命令、参数解析 |
| 配置层 | JSON 多层级加载与合并（全局 / 项目 / 环境变量 / flag） |
| Provider | DeepSeek API 集成层（流式 SSE、事件映射、Token 估算） |
| 工具 | 内置工具注册表与 9 个原子工具 |
| 安全 | 权限决策引擎：硬编码黑名单 + 规则引擎 + 交互式确认 |
| Agent | 会话主循环、工具编排、系统提示词构建 |
| Skill | AGENTS.md / SKILL.md 加载与注入 |
| 成本 | CostTracker 会话 / 日 / 历史三级计费 |
| UI | pi-tui 终端界面（消息流、输入框、状态栏、权限面板） |

---

## 开发

```bash
# 安装依赖
npm install

# 开发模式（自动监听重构建）
npm run dev

# 构建
npm run build

# 测试
npm test

# 类型检查
npm run type-check
```

### 项目要求

- Node.js ≥ 22
- DeepSeek API Key（在 [DeepSeek 开放平台](https://platform.deepseek.com)申请）

---

## 反馈

Bug / 需求 / 改进建议欢迎加入 QQ 群沟通

<img src="https://raw.githubusercontent.com/Awu12277/pic_go/refs/heads/main//group_pic.jpg" width="200" />
