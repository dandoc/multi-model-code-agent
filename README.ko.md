# 멀티 모델 코드 에이전트
언어: [English](README.md) | **한국어**

`multi-model-code-agent`는 Claude Code 스타일의 작업 흐름을 여러 백엔드에 연결할 수 있게 만든 작은 TypeScript CLI입니다.

이 저장소는 더 큰 프로젝트의 일부입니다. 목표는 Claude Code의 워크플로우와 외부에서 관찰 가능한 제품 동작에서 드러나는 방법론을 연구하고, 그중 실제로 유효한 부분을 골라 여러 LLM에 잘 맞는 vibe-coding tool로 확장하는 것입니다. 이 저장소의 CLI는 그 목표를 실전에서 검증하는 테스트베드 역할을 합니다.

즉 이 프로젝트는 다음과 같은 Claude Code 방법론을 강하게 참고합니다.

- REPL 중심 코딩 워크플로우
- 툴 기반 에이전트 루프
- 위험 작업에 대한 사람 승인
- 모델 추측만이 아니라 실제 파일 근거를 바탕으로 한 저장소 분석
- 세션 저장, 런타임 전환, 반복 작업에 맞춘 사용성

동시에 이 구현은 Claude Code를 그대로 복제하려는 것이 아닙니다. `Ollama`, `OpenAI-compatible` 백엔드, `Codex CLI`, 로컬 모델 특성, 그리고 “어떤 LLM을 붙여도 잘 버티는 도구”라는 장기 목표에 맞춰 별도로 설계한 멀티 모델 구현입니다.

## 현재 목표

- `Ollama`를 통한 로컬 모델 사용
- 임의의 `OpenAI-compatible` chat-completions API를 통한 원격 모델 사용
- 이 프로젝트 안에서 API key를 직접 관리하지 않고, 로컬 ChatGPT 로그인 상태의 `Codex CLI` 사용
- 모델이 다음 핵심 코딩 툴 10개를 호출할 수 있도록 만들기
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
- 위험한 작업은 기본적으로 사람 승인 뒤에 두기
- Claude Code의 방법론을 계속 검증하면서, 특정 백엔드에 고정되지 않는 멀티 LLM 코딩 도구로 발전시키기

이 프로젝트는 아직 MVP에 가깝기 때문에, 당장의 최우선은 “최대 성능”보다 “이해하기 쉬움”과 “안전한 반복 개발”입니다.

## 문서

- 영문 기본 문서
  - `README.md`
  - `docs/claude-code-inspiration.md`
  - `docs/milestones.md`
  - `docs/development-log.md`
  - `docs/supported-runtime-matrix.md`
  - `docs/release-checklist.md`
- 한국어 동반 문서
  - `README.ko.md`
  - `docs/claude-code-inspiration.ko.md`
  - `docs/milestones.ko.md`
  - `docs/development-log.ko.md`
  - `docs/supported-runtime-matrix.ko.md`
  - `docs/release-checklist.ko.md`

## 동작 방식

에이전트는 크게 다섯 조각으로 나뉩니다.

1. `Model adapter`
2. `Prompt + JSON protocol`
3. `Tool registry`
4. `Agent loop`
5. `CLI / REPL`

모델은 정확히 하나의 JSON 객체로 응답하도록 요구받습니다.

- 최종 답변:

```json
{ "type": "message", "message": "..." }
```

- 툴 요청:

```json
{
  "type": "tool_call",
  "tool": "read_file",
  "arguments": { "path": "src/index.ts" },
  "thinking": "I need to inspect the entrypoint first."
}
```

CLI는 툴을 실행하고, 그 결과를 다시 모델에 전달하고, 모델이 최종 답변을 줄 때까지 반복합니다.

## 빠른 시작

### 1. 의존성 설치

```bash
npm install
```

### 2. 로컬 모델을 쓰려면 Ollama 설치 후 코딩 모델 pull

예시:

```bash
ollama pull qwen2.5-coder:7b
ollama pull gemma3:12b
```

### 3. `.env.example`을 `.env`로 복사하고 수정

PowerShell:

```powershell
Copy-Item .env.example .env
```

### 4. REPL 시작

```bash
npm run dev -- --provider ollama --model qwen2.5-coder:7b --workdir D:\your-project
```

또는 로컬에 로그인된 `codex` CLI 사용:

```bash
npm run dev -- --provider codex --workdir D:\your-project
```

또는 `.env`에 저장된 설정 사용:

```bash
npm run dev
```

## CLI 설치와 배포 준비

`npm run dev` 대신 build된 CLI 엔트리포인트를 쓰고 싶다면:

```bash
npm run build
npm start -- --help
```

현재 체크아웃을 로컬 전역 명령처럼 연결하려면:

```bash
npm run build
npm link
mm-agent --help
```

참고:

- CLI 명령 이름은 `mm-agent`
- build 결과 엔트리포인트는 `dist/index.js`
- build된 CLI에는 `#!/usr/bin/env node` shebang이 포함되어 있어 `npm link` 또는 `npm install -g .` 뒤 실제 명령처럼 실행할 수 있습니다
- 아직 `package.json`은 `private` 상태이므로, 지금 단계는 npm publish가 아니라 로컬 설치 및 릴리스 준비 경로입니다
- `npm run smoke:packaging`으로 build된 CLI 엔트리포인트와 `--help` 경로를 검증할 수 있습니다
- `npm run smoke:release`는 CLI 마감에 쓰는 더 촘촘한 릴리스 준비 게이트입니다
- 전체 수동/자동 체크 항목은 `docs/release-checklist.ko.md`에 정리합니다

## 현재 실사용 지원 조합

현재 CLI 프로젝트는 adapter에 연결되는 모든 모델을 똑같이 지원한다고 주장하지 않습니다.

현재 일상 실사용 기준의 주 지원 경로는:

- Windows에서 `ollama` + `qwen3-coder:30b`
- Windows에서 `codex` + `gpt-5.4`

OpenAI-compatible backend와 `Qwen2.5`, `Gemma` 같은 인접 로컬 코딩 모델군은 보조 호환 경로로 다루지만, 현재 릴리스 기준은 위 두 경로를 중심으로 잡습니다.

지원 단계와 릴리스 가정은 `docs/supported-runtime-matrix.ko.md`를 참고하세요.

## REPL 명령

- `/help`
- `/help runtime|sessions|profiles|models|safety`
- `/?`, `/? <topic>`
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
- `/provider ollama|openai|codex`
- `/model <name>`
- `/model default`
- `/models [current|all|provider]`
- `/models [current|all|provider] search <query>`
- `/models [current|all|provider] doctor`
- `/models [current|all|provider] smoke [quick|protocol|all]`
- `/base-url <url>`
- `/api-key <value>`
- `/workdir <path>`
- `/temperature <value|default>`
- `/max-turns <value|default>`
- `/request-timeout <seconds|default>`
- `/approve on|off`
- `/quit`

slash command를 잘못 입력하면, 가장 가까운 명령과 관련 help topic을 같이 제안합니다.

## 스모크 테스트

최소 정상 경로를 확인하려면:

```bash
npm run smoke
```

이 명령은 타입체크, 빌드, 저장소 분석 프롬프트, workspace 파일 생성, `.env` persistence, path/session/model/provider/package 검증, JSON/tool-call 정규화 회귀까지 한 번에 점검합니다.

전체 broad smoke 대신 CLI 릴리스 준비 게이트만 빠르게 보고 싶다면:

```bash
npm run smoke:release
```

이 경로는 다음을 실행합니다.

- `npm run typecheck`
- `npm run build`
- `npm run smoke:packaging`
- `npm run smoke:approvals`
- `npm run smoke:repl`
- `npm run smoke:models`
- `npm run smoke:live-matrix`

특정 검증만 보고 싶다면 예를 들면:

```bash
npm run smoke:shells
npm run smoke:packaging
npm run smoke:profiles
```

## 세션 기록

각 REPL 세션은 작은 JSONL 로그로 저장되며, `/history`와 `/sessions` 계열 명령으로 다시 탐색할 수 있습니다.

- 기본 위치: `%USERPROFILE%\\.multi-model-code-agent\\sessions`
- override: `MM_AGENT_HOME`
- `/api-key ...` 같은 민감 값은 기록 전에 redaction 처리
- `/sessions compare`로 최근 비-idle 세션을 활동량 기준으로 비교 가능
- `/sessions summary`로 특정 세션 상세 확인 가능
- `/resume`으로 이전 대화를 이어서 불러올 수 있음
- `/resume runtime`은 대화뿐 아니라 저장된 provider/model/workdir/runtime flags도 함께 복원
- `/status`는 현재 런타임 설정과 현재 세션 상태를 한 번에 보여줌

## 저장된 프로필

- `/profiles save <name>`: 현재 runtime 저장
- `/profiles`: 저장된 프로필 목록
- `/profiles search <query>`: 프로필 검색
- `/profiles diff <name>`: 현재 runtime과 비교
- `/profiles load <name>`: preview + confirm 뒤 로드
- `/profiles rename <old-name> --to <new-name>`: 프로필 이름 변경
- `/profiles delete <name>`: 프로필 삭제

프로필은 API key를 저장하지 않으며, 필요하면 `/api-key`를 별도로 사용해야 합니다.

## 모델 탐색과 진단

REPL에서 다음을 사용할 수 있습니다.

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

핵심 동작:

- `ollama`: 로컬 설치 모델 읽기
- `openai`: `/models`에서 live 목록 읽기
- `codex`: 계정 기본 모델과 CLI 상태 설명
- `doctor`: provider별 readiness와 흔한 실패 원인 진단
- `smoke`: plain 응답과 structured envelope 응답을 실제로 점검
- provider/model/profile/runtime 전환 전 preflight 경고
- `/base-url` 입력 시 흔한 endpoint suffix 자동 정규화

## 런타임 튜닝

- `/temperature <value|default>`
- `/max-turns <value|default>`
- `/request-timeout <seconds|default>`

이 값들은 현재 세션 runtime을 즉시 조절하고, 나중에 profile로 저장할 수도 있습니다.

## 안전 기본값

- `write_patch`는 auto-approve가 아니면 승인 필요
- `run_shell`은 auto-approve가 아니면 승인 필요
- 파일 접근은 선택된 `workdir`로 제한
- `workdir` 내부의 새 파일/중첩 폴더 생성은 허용

## 셸 선택

`run_shell`은 optional `shell` 필드를 지원합니다.

- `default`
- `cmd`
- `powershell`

Windows에서는 PowerShell 전용 명령을 더 잘 다루기 위해 자동 fallback도 일부 지원합니다.

## 기존 파일 실행

사용자가 기존 예제 파일 실행을 요청하면, 에이전트는 큰 ad-hoc 셸 스크립트 대신 `run_files`를 사용할 수 있습니다.

지원 확장자:

- JavaScript
- Python
- C
- C++
- Rust
- Java
- HTML

## 편집 승인

`write_patch` 승인은 compact diff preview를 보여준 뒤 확인받습니다.

- `replace`: 파일 경로, match 수, 첫 match 줄, compact diff hunk
- `create`: target path, overwrite 여부, added lines preview
- `write_patch`, `run_shell`, `run_files` 승인 화면은 공통 field-style 레이아웃으로 정리되어 있어 핵심 정보를 더 빨리 읽을 수 있습니다

## 프로젝트 구조

- `src/index.ts`: CLI + REPL
- `src/config.ts`: env 및 CLI 인자 파싱
- `src/modelAdapters.ts`: Ollama, OpenAI-compatible, Codex CLI 클라이언트
- `src/repoAnalysis.ts`: 결정론적 저장소 분석 helper
- `src/prompt.ts`: 시스템 프롬프트와 tool contract
- `src/tools.ts`: 코딩 도구
- `src/agent.ts`: tool loop
