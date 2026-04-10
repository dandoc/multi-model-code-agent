# 개발 로그 (한국어판)
언어: [English](development-log.md) | **한국어**

이 문서는 `docs/development-log.md`의 한국어 동반 문서입니다. 영문 로그를 그대로 기계적으로 옮기기보다, 실제 변경의 의미가 읽히도록 날짜별 주요 흐름을 정리했습니다.

## 2026-04-07

### 초기 MVP 부트스트랩

요약:

- 별도 저장소 `multi-model-code-agent` 생성
- TypeScript 기반 CLI/REPL 뼈대 구성
- `Ollama`, `OpenAI-compatible` provider 시작
- `read_file`, `search_files`, `write_patch`, `run_shell` 중심 초기 tool set 구성

검증:

- 초기 실행 흐름 수동 확인

### 구조화된 최종 응답 정리

요약:

- 모델이 반환하는 최종 답변을 더 안정적으로 정규화
- local model이 덜 엄격한 envelope를 내도 agent loop가 버티도록 보강

검증:

- 구조화된 최종 응답 parsing 경로 수동 확인

### 저장소 탐색과 근거 기반 분석 강화

요약:

- `list_files`, `read_multiple_files` 추가
- `summarize_project`, `find_entrypoint`, `summarize_config` 추가
- 구조, entrypoint, config 질문을 모델 추측이 아니라 파일 근거 위주로 유도

검증:

- 구조/엔트리포인트/config 관련 프롬프트 수동 점검

### 워크스페이스 파일 생성 안정화

요약:

- workspace 내부 안전한 파일 생성 요청에서 모델이 거절하지 않도록 correction loop 보강
- local model이 느슨한 `write_patch` shape를 내도 create/replace를 추론하도록 보강
- hybrid envelope와 flat tool envelope도 허용

검증:

- `npm run smoke`

### 편집 preview와 실패 메시지 개선

요약:

- `write_patch` approval/result를 diff-style preview로 개선
- 실패 메시지에 이유, path/operation, 다음 행동 제안 포함

검증:

- `npm run typecheck`
- `npm run build`
- 수동 preview 및 failure case 확인

### 배치 편집과 rollback

요약:

- `write_patch`에 `edits` 배열 지원
- preflight에서 전체 edit를 먼저 검증
- disk write 도중 실패하면 이전 상태로 rollback

검증:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:failures`
- `npm run smoke:batch`

## 2026-04-08

### 경로 경계 하드닝

요약:

- lexical prefix가 아니라 canonical realpath 기준으로 경계 검사
- symlink/junction escape 차단
- `/workdir`도 startup과 같은 검증 경로 재사용
- `read_file`, `read_multiple_files`, `write_patch`에 대한 tool-level path smoke 추가

검증:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:paths`
- `npm run smoke:failures`
- `npm run smoke:batch`

### 빈 파일 생성 지원

요약:

- `content: ""`를 유효한 create 입력으로 취급
- preview에서도 빈 파일 생성이 자연스럽게 보이도록 수정

검증:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:batch`

### 세션 저장과 탐색

요약:

- `src/sessionStore.ts` 추가
- 각 REPL 세션을 JSONL로 저장
- `/history`, `/sessions`, `/history latest`, `/history <session-id>` 지원
- session id prefix lookup 지원

검증:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`

### 세션 브라우징 하드닝

요약:

- 깨진 JSONL 한 줄이나 손상된 session file이 전체 browsing을 망치지 않도록 tolerant parsing
- schema-invalid event도 malformed로 건너뜀
- exact full session id는 recent scan window 밖이어도 직접 조회

검증:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`

### Windows shell 개선

요약:

- `run_shell`에 `shell` 선택(`default`, `cmd`, `powershell`) 추가
- Windows GUI launch를 위한 PowerShell-first guidance 보강
- `default/cmd` 실패 시 PowerShell fallback 추가

검증:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:shells`

### Codex timeout resilience

요약:

- provider request timeout이 나도 REPL 전체가 죽지 않게 수정
- Codex CLI 요청은 timeout 후 1회 자동 재시도

검증:

- `npm run typecheck`
- `npm run build`

### `run_files` 도입

요약:

- ad-hoc shell script 대신 실제 파일 실행용 `run_files` tool 추가
- JavaScript, Python, C, C++, Rust, Java, HTML 지원
- 관련 approval과 smoke 추가

검증:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:run-files`

### 세션 재개와 파싱 개선

요약:

- `/resume`, `/resume latest`, `/resume <session-id>` 추가
- `/session` alias 추가
- 연도처럼 숫자로 시작하는 session id가 count로 오인되지 않도록 수정

검증:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`
- `npm run smoke:repl`

### 세션 목록 UX 개선

요약:

- session title, last active, search, compare, summary 뷰 추가
- idle session 숨기기, current view self-pollution 방지, malformed summary syntax 방지

검증:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`
- `npm run smoke:repl`

## 2026-04-09

### resume recap, status, title, session 관리

요약:

- `/resume` 직후 컨텍스트 recap 강화
- `/status` 추가
- `/title`로 수동 session title override 지원
- `/sessions delete`, `/sessions clear-idle`, `/sessions prune` 추가
- retitled idle session이 non-idle로 오인되지 않도록 수정

검증:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`
- `npm run smoke:repl`

### runtime-aware resume와 saved profile

요약:

- `/resume runtime` 추가
- latest config event를 반영한 effective runtime snapshot 사용
- `/profiles save|load|delete|search|rename|diff` 추가
- profile storage는 공용 agent home, lock, atomic rename 사용

검증:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:sessions`
- `npm run smoke:profiles`
- `npm run smoke:repl`

### 모델 탐색과 provider 하드닝

요약:

- `/models search`, family hint
- `/models doctor`
- provider-specific failure diagnosis
- transient retry
- runtime transition preflight
- `/temperature`, `/max-turns`, `/request-timeout`
- base URL normalization

검증:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:models`
- `npm run smoke:profiles`
- `npm run smoke:sessions`
- `npm run smoke:repl`

### prompt tuning과 response normalization

요약:

- provider/model family별 system prompt tuning
- JSON/tool-call normalization hardening
- empty reply recovery
- malformed structured reply recovery

검증:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:json-protocol`
- `npm run smoke:regressions`
- `npm run smoke`

### live provider smoke matrix

요약:

- `/models ... smoke [quick|protocol|all]`
- `npm run smoke:live -- <scope> [quick|protocol|all]`
- readiness blocking 규칙을 재사용해 live/non-live 검증을 분리

검증:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:live-matrix`
- `npm run smoke:live -- current all`
- `npm run smoke`

### CLI polish와 packaging

요약:

- `/help <topic>`와 `/?` alias
- typo suggestion
- tool result summary 단순화
- approval prompt 단순화
- session/profile output section layout
- packaging smoke 추가
- build된 CLI와 `--help` 경로 검증

검증:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:approvals`
- `npm run smoke:packaging`
- `npm run smoke`

## 2026-04-10

### 프로젝트 framing 문서 정리

요약:

- `README.md`에 이 CLI가 Claude Code 방법론 연구의 실험장이며, 더 큰 multi-LLM vibe-coding tool 프로젝트의 일부라는 설명 추가
- `docs/claude-code-inspiration.md`를 읽기 쉬운 형태로 재작성

검증:

- `npm run smoke:packaging`

### 한국어 동반 문서 추가

요약:

- `README.ko.md`
- `docs/claude-code-inspiration.ko.md`
- `docs/milestones.ko.md`
- `docs/development-log.ko.md`

를 추가해 주요 프로젝트 문서를 한국어로도 읽을 수 있게 정리

검증:

- 문서 변경
- `npm run smoke:packaging`

### 법적 오해를 줄이는 문구 정리

요약:

- 프로젝트 소개 문서의 표현을 더 안전하게 다듬어, Claude Code의 내부 구현을 활용했다는 뉘앙스 대신 워크플로우와 외부에서 관찰 가능한 제품 동작에서 보이는 방법론을 참고했다는 방향으로 정리
- `source`처럼 직접 코드 활용으로 읽힐 수 있는 표현을 줄이고, `내부 구현`, `methodology`, `inspiration`, `independent implementation` 쪽 표현으로 통일

검증:

- 문서 변경
- `npm run smoke:packaging`

### 릴리스 준비 문서와 지원 runtime 매트릭스

요약:

- CLI 마감 기준을 README의 흩어진 설명에만 두지 않도록 `docs/release-checklist.md`, `docs/release-checklist.ko.md`를 추가
- 어떤 provider/model 조합을 주 지원 경로로 볼지 분명히 하기 위해 `docs/supported-runtime-matrix.md`, `docs/supported-runtime-matrix.ko.md`를 추가
- build, packaging, approvals, REPL parsing, model diagnostics, live-smoke 회귀를 묶어 보는 `npm run smoke:release`를 추가
- README와 milestone 문서도 현재 프로젝트 단계에 맞게 같이 정리

검증:

- 문서/스크립트 변경
- `npm run typecheck`
- `npm run build`
- `npm run smoke:packaging`
- `npm run smoke:release`
