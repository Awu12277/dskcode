# DskCode

> **A DeepSeek-native minimalism AI coding agent!**
>
> DskCode is a minimal, terminal-native AI coding agent designed to help developers get real coding work done with less configuration and less distraction. Built natively on DeepSeek, it understands project structure, reads and edits code, executes commands, searches files, and collaborates with you through tool orchestration.
>
> Instead of recreating a complex IDE, DskCode keeps the core coding workflow in your terminal: fast startup, minimal dependencies, simple configuration, and transparent execution. Use it to investigate issues, refactor code, implement features, run tests, and handle everyday development tasks directly in your current project.

[![Version](https://img.shields.io/npm/v/dskcode?style=flat&colorA=000000&colorB=000000)](https://npmjs.com/package/dskcode)
[![Downloads](https://img.shields.io/npm/dt/dskcode.svg?style=flat&colorA=000000&colorB=000000)](https://npmjs.com/package/dskcode)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat&colorA=000000&colorB=000000)](https://nodejs.org)

> **[English]('https://github.com/Awu12277/dskcode/blob/main/README.md')** · [中文文档]('https://github.com/Awu12277/dskcode/blob/main/README-zh.md')

<img src="https://raw.githubusercontent.com/Awu12277/pic_go/refs/heads/main//dskcode-logo.gif" width="100%" />

dskcode is a **terminal-native AI coding assistant** built on DeepSeek. It understands your code, reads and writes files, executes commands, and collaborates with you—all directly in your terminal.

```bash
npm install -g dskcode
```

> [!WARNING]
> dskcode requires Node.js ≥ 22 and a DeepSeek API Key. [Get one at DeepSeek Platform](https://platform.deepseek.com).

---

#### Are there capability limits?

No. From file read/write and `bash` execution to project search, all tools work out of the box with zero external dependencies.

#### Is it slower than calling the DeepSeek API directly?

No. Built on the official SDK, it supports full streaming, Prefix Cache awareness, and streaming rendering—performance equivalent to direct API calls, with tool orchestration, permission control, and cost tracking included.

#### Can it keep up with DeepSeek's frequent model updates?

Yes. The `providers` config points to your chosen model. When DeepSeek releases a new model, just edit `settings.json`—no library update needed.

---

### What it looks like

<table>
  <tbody>
    <tr>
      <td>Start a conversation and let dskcode analyze your project structure to modify code directly.</td>
      <td>
        <a href="#">
          <img src="https://raw.githubusercontent.com/Awu12277/pic_go/refs/heads/main//dskcoderun.gif" width="100%" />
        </a>
      </td>
    </tr>
  </tbody>
</table>

```bash
# Start an interactive session
dskcode
```

<details>
  <summary>Expand to see an example session</summary>

```bash
$ dskcode

╭─────────────────────────────────────────────────╮
│  dskcode  v0.2.0  │  /help to see all commands  │
╰─────────────────────────────────────────────────╯

You: Check this project for unused imports

  >>> Analyzing project structure...

  ● src/utils/helper.ts — unused import: `lodash`
  ● src/components/Button.tsx — unused import: `React`

  Found 2 unused imports. Clean them up?

You: Yes, delete them all

  ✓ src/utils/helper.ts — removed `import { debounce } from 'lodash'`
  ✓ src/components/Button.tsx — removed `import React from 'react'`
```

</details>

---

## Features

### 🤖 AI Coding Assistant

- **Terminal-native interaction** — Collaborate with AI directly in your terminal with streaming rendering
- **DeepSeek deep integration** — Native DeepSeek API, Prefix Cache awareness, transparent cost tracking
- **Multi-model selection** — **DeepSeek-V4-Flash** (default, fast) and **DeepSeek-V4-Pro** (high precision)
- **Deep thinking mode** — `/thinking` enables reasoning, `/effort` switches High/Max level
- **Token billing** — Session-level, daily, and historical three-tier cost tracking with Prefix Cache half-price billing

### 🛠️ Tool System

9 built-in tools covering file read/write, command execution, and code search:

| Tool | Capability |
| --- | --- |
| `read_file` | Read files with line range support, auto-reject binary |
| `write_file` | Write/create files, auto-create intermediate directories |
| `edit_file` | Precise text replacement with unique match validation, preserve original EOL |
| `multi_edit` | Atomic batch replacement, roll back all on any failure |
| `delete_range` | Delete line ranges by line anchor |
| `bash` | Execute shell commands with timeout control, Win/Git Bash compatible |
| `glob` | File path pattern search, auto-skip `node_modules` / `.git` |
| `grep` | File content regex search with case control and extension filter |
| `ls` | Directory listing with type markers and hidden file control |

### 🔒 Permissions & Security

- **Three-level approval policy** — Allow / Ask / Deny, fine-grained by tool and parameters
- **Hardcoded safety rules** — 11 disaster pattern interceptors: `rm -rf /`, `curl | sh`, `git push --force` to main, etc.
- **Write tools default to confirm** — Works with zero config, global/project-level granular permission rules
- **Turn-Abort** — After a tool is denied, all subsequent tool_calls in that round are skipped
- **`/permissions`** — View current active rules and their sources at any time

### 📜 Skills

- **AGENTS.md project memory** — Auto-load `AGENTS.md` / `CLAUDE.md` from project root, inject into system prompt
- **SKILL.md skill packages** — Supports global `~/.agents/skills/` and project-local `.agents/skills/` skill directories
- **`/skill:<name>`** — Reference an installed skill directly in conversation

### ⚙️ Configuration

- **Multi-layer merging** — Global + project + environment variable + CLI flag, four levels with ascending priority
- **JSON format** — Easy to edit, version control, and team sharing

---

## Commands

| Command | Description |
| --- | --- |
| `dskcode` | Start an interactive conversation |

### Options

| Option | Description |
| --- | --- |
| `-V, --version` | Show version number |
| `-h, --help` | Display help information |

### Interactive Chat Commands

Type `/help` during a session to see all available commands:

| Command | Description |
| --- | --- |
| `/model` | Switch model |
| `/thinking` | Toggle deep thinking mode |
| `/effort` | Switch reasoning level High / Max |
| `/permissions` | View current permission rules and sources |
| `/skill:<name>` | Reference an installed skill |
| `/clear` | Clear conversation history |
| `/help` | Show all available commands |
| `/version` | Show version info |
| `/exit` / `/quit` | Exit the session |

---

## Configuration

Configuration uses JSON format with multi-layer merging (ascending priority):

1. **Built-in defaults** — Works without any config
2. **User global** — `~/.dskcode/settings.json`
3. **Project local** — `.dskcode/settings.json`
4. **Environment variables** — `DEEPSEEK_API_KEY`, `DSKCODE_*` series
5. **CLI flags** — Highest priority

<details>
  <summary>Expand to see full config example</summary>

`~/.dskcode/settings.json`:

```json
{
  "defaultProvider": "deepseek",
  "providers": [
    {
      "name": "deepseek",
      "apiKey": "sk-xxx",
      "baseUrl": "https://api.deepseek.com",
      "model": "deepseek-v4-flash"
    }
  ]
}
```

`.dskcode/settings.json` (project-level overrides):

```json
{
  "temperature": 0.3,
  "maxToolRounds": 30,
  "tools": [
    { "name": "read_file", "enabled": true },
    { "name": "write_file", "enabled": true },
    { "name": "edit_file", "enabled": true },
    { "name": "bash", "enabled": true },
    { "name": "glob", "enabled": true },
    { "name": "grep", "enabled": true },
    { "name": "ls", "enabled": true }
  ],
  "permissions": {
    "default": "confirm",
    "tools": {
      "bash": {
        "always_allow": ["^git\\s+status", "^ls"],
        "always_deny": ["^npm\\s+publish"],
        "always_confirm": ["^rm\\s"]
      },
      "edit_file": {
        "always_allow": [{ "pathGlob": "**/*.test.ts" }]
      }
    }
  },
  "thinking": {
    "enabled": true,
    "effort": "high"
  }
}
```

You can also just set the `DEEPSEEK_API_KEY` environment variable—dskcode will inject it automatically. Use `/model` to switch models during a session.

</details>

---

## Permission System

dskcode enables two layers of protection by default, **usable with zero config**. Type `/permissions` to view the current rules.

| Tool Type | Default Behavior |
| --- | --- |
| Read tools (`read_file`, `ls`, `glob`, `grep`) | Allowed directly |
| Write tools (`write_file`, `edit_file`, `multi_edit`, `delete_range`) | Prompt to confirm |
| `bash` | Hardcoded blacklist (cannot be overridden) + prompt to confirm |

**Hardcoded blacklist**: `rm -rf /`, `rm -rf ~`, `curl ... | sh`, `git push --force` to main, etc.—11 disaster patterns, any hit is denied.

**Custom rules**: In `settings.json` you can configure `always_allow`, `always_deny`, `always_confirm` regex lists per tool under the `permissions` field (only for `bash`).

---

## Architecture

The project uses a flat layered architecture with domain modules:

| Module | Responsibility |
| --- | --- |
| Entry | shebang + global error handling |
| Command routing | Commander subcommand parsing |
| Config | JSON multi-layer load and merge (global / project / env / flag) |
| Provider | DeepSeek API integration (streaming SSE, event mapping, token estimation) |
| Tools | Built-in tool registry with 9 atomic tools |
| Security | Permission decision engine: hardcoded blacklist + rule engine + interactive confirmation |
| Agent | Session main loop, tool orchestration, system prompt construction |
| Skill | AGENTS.md / SKILL.md loading and injection |
| Cost | CostTracker session / daily / historical three-tier billing |
| UI | pi-tui terminal interface (message stream, input, status bar, permission panel) |

---

## Development

```bash
# Install dependencies
npm install

# Development mode (auto-rebuild on changes)
npm run dev

# Build
npm run build

# Test
npm test

# Type check
npm run type-check
```

### Requirements

- Node.js ≥ 22
- DeepSeek API Key ([apply at DeepSeek Platform](https://platform.deepseek.com))

---

## Feedback

For bugs, feature requests, or improvements, join the QQ group:

<img src="https://raw.githubusercontent.com/Awu12277/pic_go/refs/heads/main//group_pic.jpg" width="200" />
