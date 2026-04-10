# Project Milestones
Language: **English** | [한국어](milestones.ko.md)

## Vision

Build a Claude Code style local coding-agent CLI that can read code, search files, edit safely, run commands, and work across multiple model backends without tying the project to one vendor.

## Product principles

- Local-first by default
  - strong support for `Ollama + Qwen/Gemma`
- Model portability
  - adapters should stay replaceable
- Human approval for risky actions
  - edits and command execution are confirmed unless auto-approve is enabled
- Workspace safety before convenience
  - path validation and rollback matter more than raw speed
- Deterministic help for high-stakes repo questions
  - repo analysis should not rely only on model guesswork

## Milestones

### Milestone 0. Core CLI foundation
Status: complete

Completed:

- TypeScript CLI scaffold
- `Ollama` backend
- `OpenAI-compatible` backend
- basic REPL loop
- initial core tool set
- git-based iteration flow

### Milestone 1. Grounded repo analysis
Status: complete

Completed:

- `list_files` and `read_multiple_files` based repo exploration
- deterministic repo helpers:
  - `summarize_project`
  - `find_entrypoint`
  - `summarize_config`
- stronger grounding for structure, entrypoint, and config questions
- better support for non-JS grounding and entrypoint detection
- smoke coverage for repo analysis regressions

### Milestone 2. Safer editing and tool execution
Status: complete

Completed:

- `write_patch` diff-style approval previews
- better edit failure guidance
- batch edits with rollback on failure
- empty-file create support
- path hardening and symlink/junction escape protection
- approval UX improvements for edit and execution tools
- failure, batch, path, and approval smoke coverage

### Milestone 3. Sessions and runtime usability
Status: complete

Completed:

- saved session logs and `/history`
- `/sessions`, search, compare, summary, delete, prune, clear-idle
- `/resume` and `/resume runtime`
- `/status`
- manual session titles
- saved runtime profiles:
  - save
  - load
  - diff
  - rename
  - delete
  - search
- runtime persistence and effective-config restore
- session/profile smoke coverage and corrupted-log hardening

### Milestone 4. Multi-model hardening
Status: complete

Completed:

- `/models search`
- `/models doctor`
- `/models smoke [quick|protocol|all]`
- provider-specific diagnostics
- transient request retry for provider failures
- runtime transition preflight
- provider base URL normalization
- per-provider/per-family prompt tuning
- JSON/tool-call normalization hardening
- empty reply recovery
- malformed structured reply recovery
- live provider smoke matrix
- runtime tuning commands:
  - `/temperature`
  - `/max-turns`
  - `/request-timeout`
- primary-path closeout validation:
  - `Ollama + qwen3-coder:30b` on Windows
  - `Codex CLI + gpt-5.4` on Windows
- scripted release closeout path:
  - `npm run smoke:closeout`

### Milestone 5. CLI polish and release readiness
Status: in progress (late stage)

Completed so far:

- topic-based `/help`
- slash-command typo suggestions
- simplified tool result summaries
- simplified approval prompts
- sectioned session/profile result views
- packaging smoke for the built CLI entrypoint
- release checklist documentation
- supported runtime matrix documentation
- `smoke:release` for release-readiness closeout
- `--version` and `/version`
- package metadata cleanup for the public GitHub repository
- combined `smoke:closeout` runner
- manual release sanity checks:
  - `npm link`
  - `mm-agent --version`
  - `mm-agent --help`
  - REPL sanity pass for `/help`, `/status`, `/models doctor`, `/profiles`, `/sessions`

Still remaining:

- final output consistency polish across remaining commands if new rough edges appear in real use
- decide when to stamp the first formal release candidate
- optional TUI/GUI preparation after CLI output contracts settle

## Current focus

The project is no longer blocked on basic agent capability. The current work is about making the CLI easier to use, easier to trust, and easier to ship:

- finish Milestone 5 release-readiness work
- keep locking real regressions into smoke tests as they appear
