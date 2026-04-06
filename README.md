# Multi Model Code Agent

`multi-model-code-agent` is a small TypeScript CLI that gives you a Claude Code style workflow with pluggable backends.

Current goals:

- Use local models through `Ollama`
- Use remote models through any `OpenAI-compatible` chat-completions API
- Let the model call six core coding tools:
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

Or rely on `.env`:

```bash
npm run dev
```

## REPL commands

- `/help`
- `/config`
- `/tools`
- `/reset`
- `/provider ollama|openai`
- `/model <name>`
- `/base-url <url>`
- `/api-key <value>`
- `/workdir <path>`
- `/approve on|off`
- `/quit`

## Good first prompts

- `Summarize this project structure in Korean.`
- `Find the main entrypoint of this project and explain the execution flow in Korean.`
- `Read package.json and README.md, then explain how to run this project.`
- `Search for all files related to config parsing and summarize them.`

## Recent upgrade

The agent now has `read_multiple_files`, which makes repo analysis prompts more reliable when the answer depends on more than one file.

## Remote API mode

If your provider exposes an OpenAI-compatible `/chat/completions` endpoint, you can run:

```bash
npm run dev -- --provider openai --model your-model-name --base-url https://api.example/v1
```

Then set `OPENAI_API_KEY` in `.env`, or use `/api-key ...` inside the REPL.

## Safety defaults

- `write_patch` requires approval unless auto-approve is on
- `run_shell` requires approval unless auto-approve is on
- file access is restricted to the chosen `workdir`

## Project structure

- `src/index.ts` CLI + REPL
- `src/config.ts` env and CLI argument parsing
- `src/modelAdapters.ts` Ollama and OpenAI-compatible clients
- `src/prompt.ts` system prompt and tool contract
- `src/tools.ts` coding tools
- `src/agent.ts` tool loop
