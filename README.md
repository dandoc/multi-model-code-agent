# Multi Model Code Agent

`multi-model-code-agent` is a small TypeScript CLI that gives you a Claude Code style workflow with pluggable backends.

Current goals:

- Use local models through `Ollama`
- Use remote models through any `OpenAI-compatible` chat-completions API
- Use `Codex CLI` through a local ChatGPT login, without managing an API key in this project
- Let the model call nine core coding tools:
  - `summarize_project`
  - `find_entrypoint`
  - `summarize_config`
  - `list_files`
  - `read_file`
  - `read_multiple_files`
  - `search_files`
  - `write_patch`
  - `run_shell`
- Keep dangerous actions behind human approval by default

This is an MVP, so the focus is clarity and learnability over raw power.

## Documentation

- `docs/claude-code-inspiration.md` explains what this project borrows conceptually from Claude Code and what it does not copy.
- `docs/milestones.md` tracks the current roadmap and milestone definitions.
- `docs/development-log.md` records important project changes, decisions, and known issues.

## How it works

The agent is made of five pieces:

1. `Model adapter`
2. `Prompt + JSON protocol`
3. `Tool registry`
4. `Agent loop`
5. `CLI / REPL`

The model is told to respond with exactly one JSON object:

- Final answer:

```json
{ "type": "message", "message": "..." }
```

- Tool request:

```json
{
  "type": "tool_call",
  "tool": "read_file",
  "arguments": { "path": "src/index.ts" },
  "thinking": "I need to inspect the entrypoint first."
}
```

The CLI executes the tool, feeds the result back to the model, and repeats until the model returns a final answer.

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. If you want local models, install Ollama and pull a coding model

Examples:

```bash
ollama pull qwen2.5-coder:7b
ollama pull gemma3:12b
```

### 3. Copy `.env.example` to `.env` and edit it

PowerShell:

```powershell
Copy-Item .env.example .env
```

### 4. Start the REPL

```bash
npm run dev -- --provider ollama --model qwen2.5-coder:7b --workdir D:\your-project
```

Or use a locally logged-in `codex` CLI session:

```bash
npm run dev -- --provider codex --workdir D:\your-project
```

Or rely on `.env`:

```bash
npm run dev
```

## REPL commands

- `/help`
- `/config`
- `/history [count]`
- `/history latest [count]`
- `/history <session-id> [count]`
- `/sessions [count]`
- `/tools`
- `/reset`
- `/provider ollama|openai|codex` persists to `.env`
- `/model <name>` persists to `.env`
- `/model default` resets to the provider default
- `/models [current|all|provider]` shows model choices
- `/base-url <url>` persists to `.env`
- `/api-key <value>`
- `/workdir <path>`
- `/approve on|off`
- `/quit`

## Smoke test

Run the smoke test to check the minimum healthy path for the project:

```bash
npm run smoke
```

This runs:

- `npm run typecheck`
- `npm run build`
- a project-structure prompt check
- an entrypoint-flow prompt check
- a config-summary prompt check
- a workspace-local file-creation check
- a `.env` persistence check
- a path-boundary regression check
- a session-history persistence and redaction check

For a focused shell-selection regression check, run:

```bash
npm run smoke:shells
```

## Session history

Each REPL session now writes a small JSONL log so you can inspect recent activity with `/history` and browse older sessions with `/sessions`.

- default location: `%USERPROFILE%\\.multi-model-code-agent\\sessions`
- override location: set `MM_AGENT_HOME`
- sensitive values such as `/api-key ...` are redacted before they are written
- use `/sessions` to list recent saved session ids
- use `/history latest` to inspect the most recent earlier session
- use `/history <session-id>` to open a specific saved session by full or unique prefix id
- corrupted or schema-invalid session logs are skipped during browsing with a visible warning
- exact full session ids are resolved directly, even when they are older than the recent-session scan window

## Good first prompts

- `Summarize this project structure in Korean.`
- `Find the main entrypoint of this project and explain the execution flow in Korean.`
- `Read package.json and README.md, then explain how to run this project.`
- `Search for all files related to config parsing and summarize them.`

## Recent upgrade

The agent now has deterministic repo-analysis helpers:

- `summarize_project`
- `find_entrypoint`
- `summarize_config`

These tools make structure, entrypoint, and config questions more reliable, especially when smaller local models struggle to stay grounded.

## Remote API mode

If your provider exposes an OpenAI-compatible `/chat/completions` endpoint, you can run:

```bash
npm run dev -- --provider openai --model your-model-name --base-url https://api.example/v1
```

Then set `OPENAI_API_KEY` in `.env`, or use `/api-key ...` inside the REPL.

## ChatGPT login mode

If you want to use `codex` without managing an API key in this project, install the OpenAI Codex CLI, sign in once, and use the `codex` provider:

```bash
codex login
npm run dev -- --provider codex --workdir D:\your-project
```

Notes:

- `codex login status` should show that you are logged in with ChatGPT
- `/base-url` and `/api-key` are ignored for the `codex` provider
- `/model` still works and is passed through to `codex exec -m ...`
- `/model default` clears the explicit model and goes back to the Codex account default

## Provider-scoped model settings

The project now keeps per-provider model preferences so switching providers does not drag an old model along:

- `OLLAMA_MODEL_NAME`
- `OPENAI_MODEL_NAME`
- `CODEX_MODEL_NAME`

`MODEL_NAME` is now treated as a deprecated legacy fallback. New writes clear it, and provider-specific keys are the source of truth.

## Listing models

Inside the REPL you can inspect model choices with:

```text
/models
/models all
/models ollama
/models openai
/models codex
```

Behavior by provider:

- `ollama`: reads your locally installed models from `ollama list`
- `openai`: fetches a live list from `/models` when `OPENAI_API_KEY` is set
- `codex`: shows the provider default and explains that Codex CLI does not expose a live account model list

## Safety defaults

- `write_patch` requires approval unless auto-approve is on
- `run_shell` requires approval unless auto-approve is on
- file access is restricted to the chosen `workdir`
- creating new files and nested folders inside `workdir` is allowed

## Shell selection

`run_shell` accepts an optional `shell` field:

- `default`: use the runtime default shell
- `cmd`: force `cmd.exe` on Windows
- `powershell`: force PowerShell on Windows

This is useful when a command is shell-specific. For example, `Start-Process ...` should be run with `shell: "powershell"` instead of the default Windows shell behavior.

## Edit approvals

`write_patch` approvals now show a small diff-style preview before you confirm:

- for `replace`, the file path, match count, first match line, and a compact `+/-` diff hunk
- for `create`, the target path, whether overwrite is on, and a compact added-lines preview

If the user asks to create files inside the current workspace, the agent should use `write_patch` instead of refusing the request.

This is the first step of Milestone 2, which focuses on safer and more understandable edits.

## Project structure

- `src/index.ts` CLI + REPL
- `src/config.ts` env and CLI argument parsing
- `src/modelAdapters.ts` Ollama, OpenAI-compatible, and Codex CLI clients
- `src/repoAnalysis.ts` deterministic repo analysis helpers
- `src/prompt.ts` system prompt and tool contract
- `src/tools.ts` coding tools
- `src/agent.ts` tool loop
