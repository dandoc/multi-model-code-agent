# Release Checklist
Language: **English** | [한국어](release-checklist.ko.md)

This checklist is the release-readiness gate for the current CLI repository.

The goal is not to prove that every possible provider or model works. The goal is to prove that the supported day-to-day paths are healthy, documented, and covered by repeatable checks.

## Scope

This checklist applies to the current `multi-model-code-agent` repository:

- CLI and REPL behavior
- multi-model runtime switching
- session and profile persistence
- packaging and local install flow
- smoke coverage for real regressions

It does not cover the future Electron GUI or sub-agent orchestration product.

## Required docs

Before a release candidate is considered ready, these docs should be current:

- `README.md`
- `README.ko.md`
- `docs/milestones.md`
- `docs/milestones.ko.md`
- `docs/development-log.md`
- `docs/development-log.ko.md`
- `docs/release-checklist.md`
- `docs/release-checklist.ko.md`
- `docs/supported-runtime-matrix.md`
- `docs/supported-runtime-matrix.ko.md`

## Required commands

These commands are the default release-readiness gate:

```bash
npm run typecheck
npm run build
npm run smoke
npm run smoke:release
```

For the currently selected real provider, also run:

```bash
npm run smoke:live -- current all
```

## Manual checks

Run these checks in addition to the scripted smoke path:

1. `npm run build`
2. `npm link`
3. `mm-agent --help`
4. Start the REPL once and confirm:
   - `/help`
   - `/status`
   - `/models doctor`
   - `/models smoke quick`
   - `/profiles`
   - `/sessions`

## Supported runtime sign-off

A release candidate should clearly state which runtime combinations are considered day-to-day supported.

For the current project stage, the primary release paths are:

- `Ollama + qwen3-coder:30b` on Windows
- `Codex CLI + gpt-5.4` on Windows

Secondary compatibility paths can be documented, but should not silently replace the primary release paths.

## Regression discipline

If a real failure is discovered during manual use or live-provider validation:

1. reproduce it locally
2. add or extend a smoke/regression test when practical
3. document the change in `docs/development-log.md`
4. only then mark the issue closed

## Out of scope

These items should not block this repository's CLI release:

- Electron GUI work
- sub-agent orchestration UI
- user-facing benchmark products
- direct file-editing sub-agents
