# Claude Code Inspiration
Language: **English** | [한국어](claude-code-inspiration.ko.md)

## Why this document exists

This project did not appear out of nowhere. It grew out of a larger effort to study the methodology visible in Claude Code's workflow and observable product behavior, then test those ideas in a separate codebase that is free to target many different LLMs.

The long-term goal is bigger than this CLI alone:

- understand which Claude Code ideas are genuinely strong
- validate them through real implementation work
- adapt them for local and remote model mixes
- build a vibe-coding tool that can work well with many LLMs instead of depending on a single hosted model

`multi-model-code-agent` is the hands-on CLI experiment inside that broader project.

## What this project borrows

The project borrows heavily from Claude Code at the methodological level.

The most important ideas are:

- REPL-first coding flow
  - stay in one loop, ask questions, inspect files, edit, run commands, and continue iteratively
- tool-driven agent loop
  - let the model request explicit tools instead of pretending it already changed files
- human approval for risky actions
  - edits and command execution should be visible and confirmable by default
- grounded repository analysis
  - use deterministic helpers and file evidence so answers are tied to the actual repo
- saved sessions and runtime ergonomics
  - treat coding as an ongoing workflow, not a single prompt

These are the parts that felt worth studying and carrying forward.

## Why not copy Claude Code directly

The point of this repository is not to recreate Claude Code implementation details line by line.

That would be the wrong goal for this project for several reasons:

- the target environment here is different
  - this project needs to work with `Ollama`, `OpenAI-compatible` backends, and `Codex CLI`
- local models behave differently from larger hosted models
  - `Qwen`, `Gemma`, and other local-model paths need extra grounding, normalization, and recovery logic
- the design goal is portability
  - the architecture should survive backend swaps and model churn
- the implementation needs to stay understandable and adaptable
  - the project is as much a research and validation effort as it is a working tool

So the project borrows workflow ideas, safety patterns, and interaction design, then re-implements them in a way that matches its own constraints.

## What is intentionally different here

This CLI intentionally focuses on problems that become more important once the backing model is not fixed.

Examples:

- pluggable provider adapters
  - `Ollama`, `OpenAI-compatible`, and `Codex CLI`
- provider-specific failure diagnosis and retry rules
- runtime preflight checks before switching provider, model, or profile
- response normalization for inconsistent model outputs
- live smoke coverage for different provider paths
- session and profile flows that are explicit about runtime state

These are not side details. They are central to the goal of making the tool work across many model families.

## The broader project goal

The broader project can be summarized like this:

1. Study Claude Code's methodology seriously.
2. Implement the useful parts in a separate codebase.
3. Test them against real day-to-day coding work.
4. Keep the pieces that still work when the model changes.
5. Use that learning to build a stronger multi-LLM vibe-coding tool.

From that perspective, this CLI is not the whole destination. It is one concrete deliverable inside a larger research-and-build effort.

## Current practical interpretation

The best short description of this repository is:

> a Claude Code inspired, multi-model coding-agent CLI used to research and validate how to build a vibe-coding tool that works well across many LLMs

That means the project is:

- inspired by Claude Code's methods
- implemented independently
- optimized for multi-model portability
- used as a real development testbed instead of a purely theoretical experiment
