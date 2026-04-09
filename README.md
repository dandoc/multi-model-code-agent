# Multi Model Code Agent

`multi-model-code-agent` is a small TypeScript CLI that gives you a Claude Code style workflow with pluggable backends.

Current goals:

- Use local models through `Ollama`
- Use remote models through any `OpenAI-compatible` chat-completions API
- Use `Codex CLI` through a local ChatGPT login, without managing an API key in this project
- Let the model call ten core coding tools:
  - `summarize_project`
  - `find_entrypoint`
  - `summarize_config`
  - `list_files`
  - `read_file`
  - `read_multiple_files`
  - `search_files`
  - `write_patch`
  - `run_files`
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
- `/help runtime|sessions|profiles|models|safety`
- `/?` and `/? <topic>` as a short alias for `/help`
- `/config`
- `/status`
- `/history [count]`
- `/history latest [count]`
- `/history <session-id> [count]`
- `/resume [count]`
- `/resume latest [count]`
- `/resume <session-id> [count]`
- `/resume runtime latest [count]`
- `/resume runtime <session-id> [count]`
- `/sessions [count]`
- `/sessions summary <current|latest|session-id> [count]`
- `/sessions compare [count]`
- `/sessions compare all [count]`
- `/sessions search <query> [count]`
- `/sessions delete <session-id>`
- `/sessions clear-idle [count]`
- `/sessions prune <keep-count>`
- `/profiles`
- `/profiles search <query>`
- `/profiles diff <name>`
- `/profiles save <name>`
- `/profiles rename <old-name> --to <new-name>`
- `/profiles load <name>`
- `/profiles delete <name>`
- `/session [count]`
- `/profile`
- `/title <text>`
- `/tools`
- `/reset`
- `/provider ollama|openai|codex` persists to `.env`
- `/model <name>` persists to `.env`
- `/model default` resets to the provider default
- `/models [current|all|provider]` shows model choices
- `/models [current|all|provider] search <query>` filters model names and shows family hints
- `/models [current|all|provider] doctor` checks provider readiness and common failure causes
- `/models [current|all|provider] smoke [quick|protocol|all]` runs live provider checks for plain replies and/or structured JSON envelopes
- `/base-url <url>` persists to `.env`
- `/api-key <value>`
- `/workdir <path>`
- `/temperature <value|default>`
- `/max-turns <value|default>`
- `/request-timeout <seconds|default>`
- `/approve on|off`
- `/quit`

If you mistype a slash command, the REPL now suggests the closest known command and a matching help topic when possible.

Recent CLI output polish:

- tool summaries now use a more consistent `tool_name SUCCESS:` / `tool_name FAILED:` style
- `run_shell` and `run_files` results keep the detailed body output, but the first summary line is shorter and easier to scan

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
- a model-catalog search and family-hint regression check
- a provider adapter retry/fallback regression check
- a provider-readiness doctor regression check
- a live-provider smoke-matrix regression check
- a JSON/tool-call normalization regression check

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
- use `/sessions compare` to compare the latest non-idle sessions by message count, command count, config changes, and a simple activity profile
- use `/sessions compare all` if you also want to include idle startup-only sessions in the comparison view
- use `/sessions summary current` to get a focused summary of the current saved session
- use `/sessions summary latest` or `/sessions summary <session-id>` to inspect one saved session before resuming it
- use `/sessions search <query>` or `/sessions find <query>` to filter saved sessions by title, provider, model, workdir, or reason
- `/sessions search` now also matches saved user/assistant text and shows a short `match:` preview line
- use `/sessions delete <session-id>` to remove one saved session by full or unique-prefix id
- use `/sessions clear-idle` to remove idle startup-only sessions, oldest first
- use `/sessions prune <keep-count>` to keep only the latest saved sessions and delete older ones after confirmation
- use `/title <text>` to override the current session title with something easier to recognize later
- `/session` is a short alias for `/sessions`
- `/sessions` now shows a short title from the first saved user prompt and the last activity time, so similar sessions are easier to tell apart
- use `/history latest` to inspect the most recent earlier session
- use `/history <session-id>` to open a specific saved session by full or unique prefix id
- use `/resume latest` to replace the current conversation with messages from the most recent earlier session
- use `/resume <session-id>` to continue from a specific saved session by full or unique prefix id
- `/resume` only restores saved user/assistant messages; your current provider, model, and workdir stay as they are
- use `/resume runtime latest` or `/resume runtime <session-id>` to restore the saved provider, model, workdir, and runtime flags together with the conversation
- `/resume` now prints a short context recap with the saved session title, last active time, activity profile, and the last visible user/assistant messages
- use `/status` to see the current runtime config together with the current saved session id, resume source, activity profile, and latest visible messages
- corrupted or schema-invalid session logs are skipped during browsing with a visible warning
- exact full session ids are resolved directly, even when they are older than the recent-session scan window

## Saved profiles

- use `/profiles save <name>` to store the current provider, model, base URL, workdir, and runtime flags as a reusable profile
- use `/profiles` to list saved profiles and see which one matches the current runtime
- use `/profiles search <query>` to filter saved profiles by name, provider, model, base URL, or workdir
- use `/profiles diff <name>` to see what would change before loading a saved profile
- use `/profiles rename <old-name> --to <new-name>` to rename a saved profile without recreating it
- use `/profiles load <name>` to preview the changes, confirm them, and then restore a saved profile into the current runtime
- use `/profiles delete <name>` to remove a saved profile after confirmation
- `/status` now also shows which saved profiles match the current runtime exactly
- profiles do not store API keys; use `/api-key` separately if needed
- `/profile` is a short alias for `/profiles`
- runtime-changing commands now run a small readiness preflight first, so provider/model/profile/runtime switches can warn before the next request fails
- saved profiles now also preserve the request timeout for slow local or remote model paths

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
/models search qwen
/models codex search gpt-5
/models doctor
/models all doctor
/models smoke
/models all smoke protocol
/models codex smoke quick
```

Behavior by provider:

- `ollama`: reads your locally installed models from `ollama list`
- `openai`: fetches a live list from `/models` when `OPENAI_API_KEY` is set
- `codex`: shows the provider default and explains that Codex CLI does not expose a live account model list

Search behavior:

- `/models ... search <query>` filters the visible model names before rendering
- filtered results also include short family hints for well-known choices such as Qwen coder, Gemma, GPT-5.4, and Codex-oriented models

Doctor behavior:

- `/models ... doctor` checks the selected provider scope for common setup failures
- `ollama` doctor checks the local `ollama list` command, base URL shape, and whether the expected model is installed
- `openai` doctor checks base URL shape, whether an API key is configured, and whether `/models` is reachable
- `codex` doctor checks Codex CLI availability and ChatGPT login status
- runtime request failures are also classified by provider, so auth/model/base-url/login/time-out issues return clearer next steps instead of one generic error
- provider/model/profile/runtime switches now run a readiness preflight before the new runtime is applied
- `/provider`, `/model`, and `/base-url` print preflight warnings immediately when the next runtime looks risky
- `/base-url` now trims common endpoint suffixes like `/chat/completions`, `/responses`, `/models`, or Ollama `/api/chat` back to the provider base URL automatically

Live smoke behavior:

- `/models ... smoke [quick|protocol|all]` can check a plain `OK` reply, a structured JSON/message envelope, or both in one pass
- providers with obvious blocking readiness issues are skipped before the live request runs, and the output shows why
- use `npm run smoke:live -- current`, `npm run smoke:live -- all protocol`, or `npm run smoke:live -- codex quick` for the same live matrix outside the REPL
- `/profiles load` and `/resume runtime` fold the same preflight into their preview/confirm flow before they reset the conversation

Session tuning:

- `/temperature <value|default>` updates the current session sampling temperature without rewriting `.env`
- `/max-turns <value|default>` updates the current session turn budget without restarting the REPL
- `/request-timeout <seconds|default>` updates the current session request timeout for slow providers without rewriting `.env`
- these settings are included if you later save the current runtime as a profile

Model-specific prompt tuning:

- the system prompt now adapts its operating guidance by provider/model family
- local `Qwen` and `Gemma` paths are pushed toward smaller grounded steps and more deterministic helper usage
- `codex` gets shorter execution-oriented guidance for larger cross-file work
- `openai-compatible` models get extra diagnostics-oriented guidance around API key, base URL, and live model mismatches
- the agent also retries once when a provider returns an empty or obviously placeholder-like final answer before surfacing a fallback
- the agent retries once when a reply looks like a broken `tool_call` / structured envelope instead of surfacing that malformed payload directly

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

On Windows, `run_shell` can also retry once in PowerShell after a failed `default`/`cmd` attempt when the command clearly looks PowerShell-specific or when a `start "" ...` launch is a better fit for `Start-Process`.

If you already know a command is PowerShell-specific, setting `shell: "powershell"` is still the most direct option. A good pattern for Python GUI scripts is:

```json
{
  "command": "$cmd = Get-Command pyw, pythonw, py, python -ErrorAction SilentlyContinue | Select-Object -First 1; if (-not $cmd) { throw 'Python launcher not found' }; Start-Process $cmd.Source -ArgumentList 'test\\hello.py'",
  "timeoutMs": 10000,
  "shell": "powershell"
}
```

## Running existing files

If the user asks to run or launch existing example/source files, the agent can now use `run_files` instead of building a large ad-hoc shell script.

Supported file types:

- JavaScript: `.js`, `.mjs`, `.cjs`
- Python: `.py`
- C: `.c`
- C++: `.cpp`, `.cc`, `.cxx`
- Rust: `.rs`
- Java: `.java`
- HTML: `.html`, `.htm`

Typical patterns:

```json
{ "paths": ["test/hello.js", "test/hello.py"], "timeoutMs": 30000 }
```

```json
{
  "directory": "test",
  "nameContains": "hello",
  "extensions": [".js", ".py", ".c", ".cpp", ".rs", ".java", ".html"],
  "recursive": true,
  "maxFiles": 12,
  "timeoutMs": 30000
}
```

## Edit approvals

`write_patch` approvals now show a small diff-style preview before you confirm:

- for `replace`, the file path, match count, first match line, and a compact `+/-` diff hunk
- for `create`, the target path, whether overwrite is on, and a compact added-lines preview
- `write_patch`, `run_shell`, and `run_files` approvals now use a shorter field-style layout so `cwd`, timeout, shell/path scope, and diff previews are easier to scan quickly

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
