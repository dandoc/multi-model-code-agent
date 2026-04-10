# 지원 runtime 매트릭스
언어: [English](supported-runtime-matrix.md) | **한국어**

이 문서는 현재 CLI 프로젝트에서 어떤 runtime 조합을 `Primary`, `Secondary`, `Experimental`로 보는지 설명합니다.

핵심은 “adapter에 연결만 되면 다 지원”이라고 말하는 것이 아니라, 실제로 어떤 경로를 실사용 기준으로 검증하고 있는지 분명히 하는 것입니다.

## 지원 단계

- `Primary`
  - 일상적으로 지원하는 경로
  - release-blocking regression 대상
  - live validation과 smoke coverage가 특히 중요함
- `Secondary`
  - 문서화된 호환 경로
  - 동작은 기대하지만, 메인 일상 경로는 아님
- `Experimental`
  - 동작할 수는 있지만 release-ready 기본값처럼 설명하면 안 되는 경로

## 현재 매트릭스

| 단계 | Provider 경로 | 대표 모델 / 인증 | 플랫폼 | 설명 |
| --- | --- | --- | --- | --- |
| Primary | `ollama` | `qwen3-coder:30b` | Windows | 실제 개발에 쓰는 메인 로컬 모델 경로. doctor, preflight, retry, response recovery, live smoke 기준으로 검증합니다. |
| Primary | `codex` | ChatGPT 로그인 기반 `gpt-5.4` | Windows | 실제 개발에 쓰는 메인 원격 경로. CLI readiness, timeout handling, malformed-response recovery, live smoke 기준으로 검증합니다. |
| Secondary | `openai` | 정상 API key가 있는 OpenAI-compatible `/chat/completions` backend | Windows | doctor, base URL normalization, retry, response normalization을 지원하는 호환 경로이지만, 메인 일상 경로는 아닙니다. |
| Secondary | `ollama` | `Qwen2.5`, `Gemma` 같은 인접 로컬 코딩 모델군 | Windows | prompt tuning과 adapter 동작에서는 중요하게 다루지만, 현재 release 기준의 중심은 위 Primary 로컬 경로입니다. |

## 여기서 말하는 "지원"의 의미

현재 프로젝트 단계에서 어떤 경로를 지원한다고 말하려면 최소한 다음이 있어야 합니다.

- setup 가이드 문서
- `/models doctor` 검증
- runtime-switch preflight 검증
- adapter failure diagnosis
- 기본 smoke coverage
- 적어도 하나 이상의 live-provider check 경로

## 릴리스 준비 명령

지원 경로 기준의 최소 명령은 다음입니다.

```bash
npm run smoke
npm run smoke:release
npm run smoke:live -- current all
```

현재 runtime이 Primary 경로가 아니라면, `/models doctor`와 `/models smoke`로 이번 세션에서 충분히 건강한지 먼저 판단합니다.

## 참고

- 이 매트릭스는 미래 Electron GUI 앱이 아니라 현재 CLI 저장소 기준입니다.
- 실사용 흐름이 바뀌면 매트릭스도 같이 바뀔 수 있습니다.
- 새로운 provider나 모델을 `Primary`로 올릴 때는 문서와 regression coverage가 같이 따라와야 합니다.
