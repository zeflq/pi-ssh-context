# pi-context

Two [pi](https://github.com/badlogic/pi-mono) extensions that solve SSH context blindness and flat context scaling.

## Extensions

### 1. `ssh-context` — SSH parity (layers 0 & 1)

When you run pi with `--ssh`, the agent operates on the remote machine but pi's resource discovery never runs there. Your remote project's `SYSTEM.md`, `AGENTS.md`, and skills are silently ignored.

This extension replicates pi's full resource loading pipeline on the remote machine over SSH:

**Layer 0 — system prompt files:**
- Loads `SYSTEM.md` from remote `.pi/`, `.claude/`, or `.agents/` (first found), then `~/.pi/agent/` as fallback → replaces base system prompt
- Loads `APPEND_SYSTEM.md` from same locations → appended at the very end

**Layer 1 — project context:**
- Walks up from remote cwd to root collecting `AGENTS.md` / `CLAUDE.md` (exact uppercase) → injected as `# Project Context`; at each level checks the directory directly and inside each config subdir (`.pi/`, `.claude/`, `.agents/`)
- Also checks `~/.pi/agent/AGENTS.md` (or `CLAUDE.md`) as the global user context file, loaded first

**Skills — via `resources_discover`:**
- Exposes remote skill paths to pi's native loader so they appear in the debug panel and as `/skill:name` commands
- Checks `.pi/skills/`, `.claude/skills/`, `.agents/skills/` at cwd, plus `.agents/skills/` in every ancestor up to the git root
- Git root is resolved relative to the remote cwd (not the SSH session's home dir)

No-ops when `--ssh` is not active — pi handles local loading natively.

---

### 2. `context-graph` — Link-following context graph (layer 2)

Pi's native `AGENTS.md` / `CLAUDE.md` mechanism loads files flat into the system prompt unconditionally. This works for small projects but bloats the context window as your knowledge base grows.

Instead, you create a **context graph** rooted at `<config-dir>/agents.md`:

```
.pi/               # or .claude/ or .agent/
├── agents.md      ← entry point, always fully loaded
├── git.md         ← linked from agents.md → stub only
├── ssh.md         ← linked from agents.md → stub only
└── deployment/
    └── prod.md    ← linked from ssh.md → stub only (recursive)
```

**How it works:**

1. `agents.md` is loaded fully into the system prompt — write your agent's role, core instructions, and project overview here.
2. Every markdown link in `agents.md` is followed. Each linked file is read for its `description` frontmatter only and added as a stub under `## Available Content Files`.
3. Link-following is recursive — linked files can link to more files, all becoming stubs. A visited set and max-depth of 10 guard against cycles.
4. The agent calls the `read` tool on any file when it decides the content is relevant. The LLM acts as the relevance filter.

Works both locally and over SSH.

**File contract:**

Every linked file MUST have a `description` frontmatter field:

```markdown
---
description: Use this file when deploying to staging or production.
---

## Deployment guide
...
```

**Supported config directories** (tried in order): `.pi`, `.claude`, `.agents`

---

## Setup

```bash
pi install git:github.com/zeflq/pi-context
```

## Usage

Works automatically once installed. No configuration needed.

For SSH usage, combine with pi's `--ssh` flag:

```bash
pi --ssh user@host
pi --ssh user@host:/remote/path
```

## Project structure

```
extensions/
  ssh-context.ts     # SSH parity extension (layers 0 & 1)
  context-graph.ts   # Link-following context graph (layer 2)
src/
  fs-ops.ts          # Shared local + SSH filesystem abstraction
  ssh.ts             # Shared SSH flag parsing and state resolution
  markdown.ts        # Shared frontmatter parsing and link extraction
  loader.ts          # Shared file discovery and loading logic
```
