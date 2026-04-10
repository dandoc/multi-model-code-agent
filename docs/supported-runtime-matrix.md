# Supported Runtime Matrix
Language: **English** | [한국어](supported-runtime-matrix.ko.md)

This document explains which runtime combinations are treated as primary, secondary, or experimental for the current CLI project.

The point is to communicate what we actively validate in real use, not to claim universal support for every model that happens to fit an adapter.

## Support tiers

- `Primary`
  - day-to-day supported path
  - release-blocking regressions
  - live validation and smoke coverage matter here
- `Secondary`
  - documented compatibility path
  - expected to work, but not the main daily-driver route
- `Experimental`
  - may work, but should not be described as a release-ready default

## Current matrix

| Tier | Provider path | Typical model / auth | Platform | Notes |
| --- | --- | --- | --- | --- |
| Primary | `ollama` | `qwen3-coder:30b` | Windows | Primary local-model path used for real development, with doctor, preflight, retry, response recovery, and live smoke coverage. |
| Primary | `codex` | `gpt-5.4` via ChatGPT login | Windows | Primary remote-model path used for real development, with CLI readiness, timeout handling, malformed-response recovery, and live smoke coverage. |
| Secondary | `openai` | OpenAI-compatible `/chat/completions` backend with valid API key | Windows | Compatibility path with doctor, base-URL normalization, retry, and response-normalization support, but not the main day-to-day path. |
| Secondary | `ollama` | nearby local coding families such as `Qwen2.5` or `Gemma` | Windows | Strongly considered during prompt tuning and adapter behavior, but the release bar is still centered on the primary local path above. |

## What "supported" means here

For this project stage, a supported path should have:

- documented setup guidance
- `/models doctor` coverage
- runtime-switch preflight coverage
- adapter failure diagnosis
- default smoke coverage
- at least one live-provider check path

## Release-readiness commands

The minimum commands for a supported release path are:

```bash
npm run smoke
npm run smoke:release
npm run smoke:live -- current all
```

For the current release flow, prefer the combined closeout command:

```bash
npm run smoke:closeout
```

If the current runtime is not one of the primary paths, use `/models doctor` and `/models smoke` to decide whether the path is healthy enough for the current session.

## Notes

- This matrix describes the current CLI repository, not the future Electron GUI app.
- The matrix can evolve as real usage shifts.
- New providers or models should not be promoted to `Primary` without both documentation and regression coverage.
- Both primary paths have now been validated through the scripted closeout flow plus manual release sanity checks.
