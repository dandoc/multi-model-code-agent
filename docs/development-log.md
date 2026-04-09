# Development Log

이 문서는 프로젝트의 중요한 변화, 방향 전환, 알려진 문제를 계속 기록하는 용도다. 의미 있는 기능 추가나 중요한 판단이 생기면 이 파일도 함께 업데이트한다.

## 2026-04-07

### 초기 MVP 부트스트랩

관련 커밋:

- `bc7ae45 feat: bootstrap multi-model code agent mvp`

요약:

- 별도 저장소 `multi-model-code-agent` 생성
- TypeScript 기반 CLI/REPL 뼈대 구성
- `Ollama`와 `OpenAI-compatible` 공급자 지원 시작
- `read_file`, `search_files`, `write_patch`, `run_shell` 중심의 첫 툴 세트 구성

### 구조화된 최종 응답 정리 개선

관련 커밋:

- `b2be8b7 fix: normalize structured final responses`

요약:

- 모델이 반환한 최종 응답을 더 안정적으로 정리하도록 보강

### 저장소 탐색 능력 강화

관련 커밋:

- `8c94efe feat: improve repository exploration workflow`

요약:

- `list_files` 추가
- 프로젝트 구조 질문 전에 파일 트리를 먼저 확보하는 흐름 추가
- 문서와 추천 프롬프트 업데이트

### 여러 파일을 근거로 읽는 흐름 추가

관련 커밋:

- `d62314b feat: add multi-file reading for repo analysis`

요약:

- `read_multiple_files` 추가
- 여러 파일을 함께 읽는 저장소 분석 흐름 보강
- 단일 파일 질문보다 다중 근거 질문에 더 잘 대응하도록 개선

### 현재 확인된 한계

관찰 내용:

- `qwen2.5-coder:7b`는 프로젝트 분석형 질문에서 실제 파일보다 추측에 의존하는 경우가 있다
- 특히 엔트리포인트, 구조 요약, 설정 파싱 요약 같은 질문에서 환각이 발생할 수 있다

현재 판단:

- 간단한 실행 가이드나 단일 파일 설명은 비교적 양호
- 프로젝트 분석 정확도는 아직 충분히 신뢰할 수준이 아님

다음 방향:

- 실제 파일 근거를 더 강하게 요구하는 흐름 강화
- 중요한 분석은 장기적으로 결정론적 툴로 분리하는 방안 검토

### 문서화 원칙 추가

요약:

- Claude Code와의 관계, 프로젝트 마일스톤, 개발 로그를 문서로 분리
- 앞으로 방향이 바뀌거나 중요한 기능이 들어가면 문서도 함께 갱신

### 결정론적 프로젝트 분석기 추가

요약:

- `src/repoAnalysis.ts` 추가
- `summarize_project`, `find_entrypoint`, `summarize_config` 툴 추가
- 구조, 엔트리포인트, 설정 질문에 대해 먼저 결정론적 분석 결과를 주입하도록 에이전트 보강
- 한국어 질문 감지와 파일 근거 강제 로직 개선
- 작은 로컬 모델이 끝까지 근거 기반 답변을 못 만들 때 결정론적 폴백으로 마무리하도록 보강

검증:

- `Summarize this project structure in Korean.`
- `Find the main entrypoint of this project and explain the execution flow in Korean.`
- `Search for all files related to config parsing and summarize them.`

### 엔트리포인트 실행 흐름 설명 개선

요약:

- `src/repoAnalysis.ts`의 엔트리포인트 분석이 단순 import 나열이 아니라 실제 시작 단계 중심으로 흐름을 만들도록 개선
- `src/index.ts`의 `.env` 로드, CLI 파싱, help 처리, REPL 초기화, one-shot prompt 실행, REPL 진입 흐름을 단계별로 설명 가능
- 결정론적 폴백도 같은 실행 단계 요약을 재사용하도록 맞춤
- 엔트리포인트 설명 톤을 짧은 자연어 문단 스타일로 정리해, 초보자도 읽기 쉽게 개선

검증:

- `Find the main entrypoint of this project and explain the execution flow in Korean.`

### 한국어 구조 요약 표현 개선

요약:

- 구조 요약 fallback에서 영어 스택 라벨이 섞이던 문제를 완화
- `docs/`, `src/` 같은 상위 디렉터리와 핵심 파일, 엔트리포인트 후보를 더 자연스럽게 한국어 문단으로 정리하도록 보강

검증:

- `이 프로젝트 구조를 한국어로 요약해줘`

### config 설명체 개선

요약:

- config 질문에 대해 번호 목록보다 짧은 자연어 문단을 선호하도록 프롬프트와 재작성 흐름 보강
- `README.md`의 `.env` 설정법과 주요 실행 옵션 설명도 config 흐름에 포함
- config fallback을 `설정 파일 -> 설정이 만들어지는 흐름 -> env/CLI 항목` 순서로 정리

검증:

- `config 파싱과 관련된 파일들을 찾아서 한국어로 요약해줘`
- `이 프로젝트 설정이 어디서 정의되고 어떻게 적용되는지 한국어로 설명해줘`

### 자동 스모크 테스트 추가

요약:

- `src/smoke.ts` 추가
- `npm run smoke`로 typecheck, build, 구조 요약, 엔트리포인트 설명, config 설명의 최소 기준을 자동 검증
- `smoke`, `build`, `test` 같은 유틸 스크립트는 메인 엔트리포인트 후보 계산에서 제외해 설명 노이즈를 줄임

검증:

- `npm run smoke`

### 한국어 표현 보정

요약:

- 구조 요약에서 `TOP-LEVEL FILES`, `KEY FILES` 같은 영어 섹션 라벨이 그대로 보이면 자연스러운 한국어 표현으로 다시 정리하도록 보강
- config 설명에서 `런타임 설정을 빌립니다` 같은 어색한 표현이 나오면 자연스러운 한국어 문장으로 다시 쓰도록 보강
- 한국어 연결 조사도 `방법과`처럼 더 자연스럽게 이어지도록 조정

검증:

- `이 프로젝트 구조를 한국어로 요약해줘`
- `이 프로젝트 설정이 어디서 정의되고 어떻게 적용되는지 한국어로 설명해줘`
- `npm run smoke`

### 마일스톤 2 시작: 수정 미리보기와 승인 메시지 개선

요약:

- `src/writePatchPreview.ts` 추가
- `write_patch` 승인 전에 create/replace 변경 내용을 미리 보여주는 preview 추가
- `write_patch` 실행 결과도 단순 성공 메시지 대신 before/after 중심 요약으로 개선
- `run_shell` 승인 메시지도 작업 디렉터리, timeout, 실제 명령이 보이도록 개선

검증:

- `npm run typecheck`
- `npm run build`
- 임시 작업 디렉터리에서 `create`와 `replace` 승인 메시지 및 결과 출력 확인
### Milestone 2 follow-up: workspace-local file creation reliability

Summary:

- clarified in the system prompt that creating files and nested folders inside the current workspace is allowed
- if the model refuses a safe workspace-local create task, the agent now asks it to use `write_patch`
- if the model claims the work is done without a successful `write_patch` result, the agent now forces a real file-creation step
- added smoke coverage for a workspace-local file-creation request that mentions the workspace directory by name

Validation:

- reproduced the failure with a Korean prompt that asked for a `테스트` folder and several language files
- confirmed that the agent created real files only after the new correction loop
- `npm run smoke`
# Development Log

### 2026-04-07 - Model selection persistence

Summary:

- `/model`, `/provider`, and `/base-url` now persist their startup values to `.env`
- `/api-key` remains session-only
- added a smoke check that verifies `.env` updates can be written and read back

Validation:

- changed the REPL model setting and confirmed it was saved to `.env`
- `npm run typecheck`
- `npm run build`
- `npm run smoke`

### 2026-04-07 - Entrypoint anchor strictness

Summary:

- tightened entrypoint answer validation so a reply must mention the real startup anchors from the bootstrap analysis
- entrypoint answers now require the main entrypoint plus key startup files such as `src/env.ts` and `src/config.ts` when they are part of the detected flow

Validation:

- reproduced the smoke failure where the model omitted `src/env.ts`
- `npm run smoke`

### 2026-04-07 - Loose tool-call parsing for local models

Summary:

- expanded JSON parsing so local models can call tools with `{"type":"write_patch", ...}` style envelopes
- this keeps workspace-local file creation working even when the model does not emit the stricter `tool_call` wrapper

Validation:

- reproduced the smoke failure where the model returned a flat `write_patch` JSON object
- `npm run smoke`

### 2026-04-07 - Forgiving write_patch arguments

Summary:

- `write_patch` now accepts looser local-model arguments such as missing `operation` or aliases like `contents`, `text`, `replacement`, and `filePath`
- the agent infers `create` vs `replace` when the model leaves the operation out

Validation:

- reproduced the workspace-local creation smoke failure with a looser `write_patch` shape
- `npm run smoke`

### 2026-04-07 - Stabilized workspace creation smoke prompt

Summary:

- simplified the workspace-local creation smoke prompt so it tests nested file creation more deterministically
- the smoke check still verifies parent directory creation because it targets `smoke-output/hello.txt`

Validation:

- `npm run smoke`

### 2026-04-07 - Hybrid tool envelope parsing

Summary:

- added support for local-model envelopes shaped like `{"type":"write_patch","tool":"write_patch","arguments":{...}}`
- this keeps tool execution working when the model mixes the legacy and newer envelope styles

Validation:

- reproduced the workspace-local smoke failure with the hybrid `write_patch` envelope
- `npm run smoke`

### 2026-04-07 - Diff-style edit previews

Summary:

- `write_patch` approvals and results now render compact `+/-` diff previews instead of separate before/after text blocks
- replace previews show a small context hunk around the first affected location
- create previews show the added lines directly

Validation:

- `npm run typecheck`
- manual replace/create preview check

### 2026-04-07 - Write patch failure messages

Summary:

- `write_patch` failures now explain the reason, requested path or operation when available, and concrete next steps
- common cases such as missing fields, outside-workdir paths, missing files, existing files, no exact match, and multi-match replace errors now have tailored guidance

Validation:

- manual failure checks for create-on-existing-file and replace-without-exact-match

### 2026-04-07 - Batch write patch with rollback

Summary:

- `write_patch` now accepts an `edits` array so the agent can stage multiple create or replace operations in one approval flow
- batched edits are validated in memory before disk writes begin, which prevents partial updates when a later edit is invalid
- if a disk write fails after earlier writes succeeded, the tool rolls those earlier writes back to their original contents
- added `npm run smoke:batch` to cover batched success, preflight failure with no writes, and commit-time rollback

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:failures`
- `npm run smoke:batch`

### 2026-04-08 - Path boundary hardening

Summary:

- `resolvePathInsideRoot` now compares canonical realpaths instead of only lexical prefixes, which blocks symlink and junction escapes
- new file paths are checked against the nearest existing parent directory, so creating a file under a linked directory can no longer escape the workspace
- `walkFiles` and `list_files` now skip out-of-root linked directories and avoid recursive loops through in-root links
- `/workdir` now reuses the same startup validation path instead of accepting missing or non-directory targets at runtime
- added `npm run smoke:paths` to cover canonical path checks, traversal safety, runtime workdir validation, and tool-level rejection for `read_file`, `read_multiple_files`, and `write_patch`
- `npm run smoke` now includes both the original repo-analysis smoke flow and `smoke:paths` so path regressions stay in the default verification path

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:paths`
- `npm run smoke:failures`
- `npm run smoke:batch`

### 2026-04-08 - Empty file create support

Summary:

- `write_patch` create edits now accept an explicit empty string for `content` instead of treating it like a missing field
- empty file previews now render as `Content lines: 0`, `Content chars: 0`, with a clearer diff preview marker
- `npm run smoke:batch` now includes a dedicated empty-file create regression case

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:batch`

### 2026-04-08 - Session history and persistence

Summary:

- added `src/sessionStore.ts` so each REPL session writes a JSONL event log under the local agent home directory
- added `/history [count]` to show recent events from the current session without leaving the REPL
- redacted `/api-key ...` commands before they are written and stored config snapshots as `apiKeySet` instead of raw secrets
- added `npm run smoke:sessions` and folded it into the default `npm run smoke` flow

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`
- `npm run smoke`

### 2026-04-08 - Session browsing

Summary:

- added saved-session indexing so the REPL can list recent sessions instead of only showing the current one
- added `/sessions [count]` to browse recent session ids and `/history latest` or `/history <session-id>` to inspect earlier sessions
- session ids can now be resolved by unique prefix, which makes browsing older sessions less awkward from the terminal
- expanded the session smoke coverage so it verifies current-session marking, previous-session lookup, and older-session history rendering

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`

### 2026-04-08 - Session browsing hardening

Summary:

- made JSONL session parsing tolerant so one truncated or malformed session file no longer poisons `/sessions`, `/history latest`, or prefix-based browsing
- added runtime session-event shape validation so syntactically valid garbage such as `null` or incomplete objects is treated as malformed input instead of crashing session browsing
- added visible warnings when corrupted session logs are skipped during browsing
- changed exact `/history <session-id>` lookup to check the direct session file path first, so older sessions remain reachable even after the recent-session scan window
- expanded the session smoke test with corrupted-log and 205-session exact-id regression cases

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`

### 2026-04-08 - Explicit run_shell selection

Summary:

- added an optional `shell` field to `run_shell` so commands can explicitly target the default shell, `cmd`, or `powershell`
- updated shell approvals to show which shell will run the command
- taught the system prompt to request `shell: "powershell"` for Windows-specific PowerShell commands such as `Start-Process`
- added `npm run smoke:shells` to verify default-shell, `cmd`, and `powershell` execution paths

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:shells`

### 2026-04-08 - Windows GUI shell guidance

Summary:

- strengthened the system prompt so Windows GUI launches prefer `shell: "powershell"` with `Start-Process` on the first attempt
- added explicit guidance for resolving a working Python launcher (`pyw`, `pythonw`, `py`, or `python`) before launching a GUI script
- updated the `run_shell` tool shape and README examples so the model sees a PowerShell-first pattern for Tkinter-style launches

Validation:

- `npm run typecheck`
- `npm run build`

### 2026-04-08 - Automatic Windows shell fallback

Summary:

- taught `run_shell` to retry once in PowerShell on Windows when a failed default/cmd command clearly uses PowerShell syntax
- added a second Windows fallback path that turns failed `start "" ...` launch commands into `Start-Process`, with Python launcher discovery for GUI-style Python launches
- updated the prompt and README so shell selection is described as contextual, with runtime fallback support instead of a blanket PowerShell-first rule
- expanded `smoke:shells` to lock in the automatic PowerShell fallback behavior

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:shells`

### 2026-04-08 - Codex timeout resilience

Summary:

- stopped REPL turns from crashing the whole app when a provider request throws, so timeouts now surface as assistant-visible errors and the session stays alive
- added a single automatic retry for Codex CLI requests after the first timeout, with a clearer final message when both attempts time out

Validation:

- `npm run typecheck`
- `npm run build`

### 2026-04-08 - Fast run_files execution tool

Summary:

- added a new `run_files` tool so the agent can run or launch existing example files directly instead of composing large one-off shell scripts
- built in handlers for JavaScript, Python, C, C++, Rust, Java, and HTML, including Windows-friendly Python GUI launching and default-app HTML opening
- added a shorter approval view for `run_files` and updated the prompt so execution requests prefer this tool over verbose shell commands
- added `npm run smoke:run-files` and folded it into the default smoke flow

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:run-files`

### 2026-04-08 - Session resume

Summary:

- added `/resume`, `/resume latest`, and `/resume <session-id>` so a saved session's user/assistant messages can be loaded back into the current conversation
- kept runtime settings explicit: resume restores conversation context only, while the current provider, model, and workdir stay unchanged
- surfaced resume warnings for malformed session logs and empty sessions instead of failing silently
- expanded the session smoke coverage to lock in session-conversation loading and `/resume`-style behavior

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`

### 2026-04-08 - REPL session command parsing fixes

Summary:

- fixed `/history <session-id>` and `/resume <session-id>` so session ids that start with a year are no longer misread as counts
- made `/sessions <session-id>` show a direct usage hint instead of silently treating the id prefix as a numeric limit
- added `/session` as a small alias for `/sessions`
- added `npm run smoke:repl` and folded it into the default smoke flow to lock in the parsing behavior

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:repl`

### 2026-04-08 - Richer session list metadata

Summary:

- `/sessions` now shows a short title derived from the first saved user prompt instead of only raw ids and config fields
- each listed session now also shows its last activity timestamp, which makes nearby sessions easier to distinguish during the same day
- fallback titles ignore low-signal browsing commands such as `/sessions` and `/history`, so empty sessions stay readable as `(no prompt yet)`

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`

### 2026-04-08 - Session list search

Summary:

- added `/sessions search <query> [count]` and `/sessions find <query> [count]` so saved sessions can be filtered by title, provider, model, workdir, or reason
- kept `/sessions <session-id>` invalid on purpose, so session ids are not misread as counts and users are steered toward `/history <session-id>` or `/resume <session-id>`
- expanded session smoke and REPL parsing smoke to lock in filtered session listing behavior

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`
- `npm run smoke:repl`

### 2026-04-08 - Session comparison view

Summary:

- added `/sessions compare [count]` so recent sessions can be compared without opening them one by one
- each comparison row now shows message, command, and config-change counts plus a lightweight activity profile such as `mixed`, `command-heavy`, or `chat-heavy`
- changed the default comparison view to hide idle startup-only sessions, and added `/sessions compare all [count]` for the full comparison view
- expanded the session smoke coverage so comparison output stays grounded in real saved events

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`
- `npm run smoke:repl`

### 2026-04-09 - Session summary view

Summary:

- added `/sessions summary <current|latest|session-id> [count]` so one saved session can be inspected in detail before resuming it
- the summary view now shows title, started/last-active timestamps, provider/model/workdir, activity totals, profile, first request, last user message, last assistant reply, and recent events
- expanded session and REPL parsing smoke coverage so the summary command stays stable for current and previous saved sessions

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`
- `npm run smoke:repl`

### 2026-04-09 - Session summary follow-up fixes

Summary:

- current-target `/history` and `/sessions summary` now avoid logging the view command into the current session, so summaries and histories do not self-pollute
- tightened `/sessions summary` parsing so extra trailing tokens are rejected instead of being silently ignored
- expanded REPL command smoke coverage for current-view logging rules and malformed summary syntax

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`
- `npm run smoke:repl`

### 2026-04-09 - Resume context recap

Summary:

- `/resume` now prints a richer recap after loading a saved conversation, including the saved session title, started/last-active timestamps, source-vs-current runtime, activity profile, and the latest meaningful messages
- extended `loadSessionConversation()` so resume flows can reuse the same session metadata that powers summary and comparison views
- expanded session smoke coverage so resume output itself stays grounded and useful, not just the restored message list

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`

### 2026-04-09 - Runtime status view

Summary:

- added `/status` so the REPL can show the current runtime config together with the current saved-session id, timestamps, activity profile, and recent visible messages
- the status view also shows the last resumed session id, which makes it easier to tell whether the current conversation was continued from older saved context
- kept `/status` view-only so checking status does not pollute the current saved session log

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`

### 2026-04-09 - Session search previews

Summary:

- expanded `/sessions search` so it matches not only titles and runtime metadata but also saved user/assistant messages and the last meaningful command
- added a `match:` preview line to filtered session results, so it is obvious why a session matched and easier to choose the right one to inspect or resume
- added session smoke coverage for assistant-message content search, so search stays useful even when the title itself does not contain the query

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`

### 2026-04-09 - Session management commands

Summary:

- added `/sessions delete <session-id>` for one-off cleanup, with current-session protection and confirmation
- added `/sessions clear-idle [count]` so old startup-only sessions can be removed quickly without touching active work sessions
- added `/sessions prune <keep-count>` to keep the latest saved sessions and remove older ones after a confirmation preview
- expanded REPL parsing and session smoke coverage so delete, idle cleanup, and prune flows stay stable

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`
- `npm run smoke:repl`

### 2026-04-09 - Manual session titles

Summary:

- added `/title <text>` so the current session can be renamed explicitly instead of relying only on the first saved prompt
- title overrides are stored in the session JSONL log and automatically flow through `/sessions`, comparison, summary, resume recap, and status views
- expanded session smoke coverage so title overrides stay visible in list, history, summary, status, and resume output
- `/title` now behaves as metadata-only so retitling a startup-only session does not make it look active in compare, status, or idle cleanup flows

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`

### 2026-04-09 - Resume saved runtime

Summary:

- added `/resume runtime ...` so saved provider, model, workdir, and runtime flags can be restored together with the conversation
- runtime-aware resume now uses the latest saved config event instead of only the initial session_started snapshot
- reused existing workdir validation so missing or unsafe saved workdirs are rejected instead of being restored blindly
- expanded REPL/session smoke coverage for runtime-aware resume parsing and recap messaging

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`
- `npm run smoke:repl`

### 2026-04-09 - Saved runtime profiles

Summary:

- added `/profiles save|load|delete` and `/profiles` so frequently used provider/model/workdir combinations can be reused quickly
- profile storage now uses the same agent-home resolution as sessions and serializes read-modify-write updates with a lock + atomic rename
- profile loads reuse existing workdir validation and reset the conversation into a fresh session with the loaded runtime
- `/status` now shows which saved profiles match the current runtime
- added `/profiles search <query>` and `/profiles rename <old-name> --to <new-name>` for easier profile management
- added `/profiles diff <name>` so a saved profile can be compared against the current runtime before load
- `/profiles load <name>` now shows a runtime diff preview and asks for confirmation before resetting the conversation
- `/models ... search <query>` now filters provider model lists and shows short family hints for common model families
- `/models ... doctor` now diagnoses provider readiness and common setup failures for Ollama, OpenAI-compatible endpoints, and Codex CLI
- `/temperature` and `/max-turns` now tune the current session runtime without restarting or persisting to `.env`
- `/request-timeout` now tunes the current session request timeout without restarting or persisting to `.env`
- the system prompt now injects provider/model-specific operating guidance so Qwen, Gemma, Codex, and OpenAI-compatible paths get different grounding and failure-handling hints
- runtime request failures are now classified by provider so Ollama/OpenAI-compatible/Codex errors return provider-specific causes and next steps
- Ollama/OpenAI-compatible chat requests now retry once on transient timeout/network/429/5xx failures, with adapter smoke coverage for retry vs non-retry paths
- provider/model/base-url switches now run a quick runtime preflight and surface readiness warnings before resetting the conversation
- `/profiles load` and `/resume runtime` now include the same preflight in their preview/confirm flow, so missing keys, missing local models, or missing Codex login show up before the runtime is applied
- saved profiles and runtime-aware resume now preserve the effective request-timeout setting as part of the runtime snapshot
- `/models ... smoke [quick|protocol|all]` now checks both a plain live completion path and a structured JSON/message-envelope path, while still skipping providers that already fail blocking readiness checks
- added `npm run smoke:live -- <scope> [quick|protocol|all]` for manual live provider checks and `npm run smoke:live-matrix` for a non-live regression harness that is folded into the default smoke chain
- `parseAgentEnvelope()` now normalizes more real-world response shapes, including stringified arguments, OpenAI-style `function_call` / `tool_calls`, jsonc-style fenced payloads, trailing commas, and single-item JSON arrays
- added `npm run smoke:json-protocol` and folded it into the default smoke chain to lock in those response-normalization paths
- profiles intentionally exclude API keys so secrets stay session-local

Validation:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:profiles`
- `npm run smoke:repl`
