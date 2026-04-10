# 프로젝트 마일스톤
언어: [English](milestones.md) | **한국어**

## 비전

코드를 읽고, 파일을 검색하고, 안전하게 수정하고, 명령을 실행할 수 있으며, 특정 벤더에 묶이지 않고 여러 모델 백엔드에서 동작하는 Claude Code 스타일의 로컬 코딩 에이전트 CLI를 만든다.

## 제품 원칙

- 기본은 로컬 우선
  - `Ollama + Qwen/Gemma`를 강하게 지원
- 모델 portability
  - adapter는 교체 가능해야 함
- 위험 작업에는 사람 승인
  - 수정과 명령 실행은 auto-approve가 아니면 확인
- 편의보다 workspace 안전성
  - path validation과 rollback이 속도보다 중요
- 높은 중요도의 저장소 질문에는 결정론적 도움
  - repo analysis는 모델 추측만으로 끝나면 안 됨

## 마일스톤

### 마일스톤 0. 코어 CLI 기반
상태: 완료

완료:

- TypeScript CLI scaffold
- `Ollama` backend
- `OpenAI-compatible` backend
- 기본 REPL 루프
- 초기 core tool set
- git 기반 반복 개발 흐름

### 마일스톤 1. 근거 기반 저장소 분석
상태: 완료

완료:

- `list_files`, `read_multiple_files` 기반 저장소 탐색
- 결정론적 repo helper
  - `summarize_project`
  - `find_entrypoint`
  - `summarize_config`
- 구조, entrypoint, config 질문에 대한 grounding 강화
- 비JS 프로젝트 grounding과 entrypoint 탐지 보강
- repo analysis regression smoke

### 마일스톤 2. 더 안전한 편집과 툴 실행
상태: 완료

완료:

- `write_patch` diff-style approval preview
- 더 좋은 edit failure guidance
- batch edit + rollback
- 빈 파일 create 지원
- path hardening 및 symlink/junction escape 방어
- edit/execute tool approval UX 개선
- failure, batch, path, approval smoke

### 마일스톤 3. 세션과 런타임 사용성
상태: 완료

완료:

- saved session log와 `/history`
- `/sessions`, search, compare, summary, delete, prune, clear-idle
- `/resume`, `/resume runtime`
- `/status`
- 수동 session title
- saved runtime profile
  - save
  - load
  - diff
  - rename
  - delete
  - search
- runtime persistence와 effective-config restore
- session/profile smoke 및 corrupted-log hardening

### 마일스톤 4. 멀티 모델 하드닝
상태: 진행 중 (후반부)

현재까지 완료:

- `/models search`
- `/models doctor`
- `/models smoke [quick|protocol|all]`
- provider-specific diagnostics
- provider failure에 대한 transient retry
- runtime transition preflight
- provider base URL normalization
- provider/family별 prompt tuning
- JSON/tool-call normalization hardening
- empty reply recovery
- malformed structured reply recovery
- live provider smoke matrix
- runtime tuning command
  - `/temperature`
  - `/max-turns`
  - `/request-timeout`

남은 일:

- 실제로 자주 쓰는 모델 조합에 대한 실공급자 검증 확대
- 실사용 중 새로 드러나는 provider-specific recovery 케이스 보강
- 최종 마일스톤 4 마감에 맞춘 문서 정리

### 마일스톤 5. CLI polish와 릴리스 준비
상태: 진행 중

현재까지 완료:

- 주제별 `/help`
- slash command typo suggestion
- tool result summary 단순화
- approval prompt 단순화
- session/profile result view 섹션화
- build된 CLI 엔트리포인트용 packaging smoke
- release checklist 문서화
- supported runtime matrix 문서화
- release-readiness closeout용 `smoke:release`

남은 일:

- 남아 있는 명령 결과 출력의 마지막 일관성 polish
- CLI 출력 계약이 더 안정된 뒤 optional TUI/GUI 준비

## 현재 집중점

이 프로젝트는 더 이상 “기본 에이전트 기능 자체가 되느냐”가 병목인 상태가 아닙니다. 현재는 다음을 더 중요하게 봅니다.

- 마일스톤 4 마감
- 마일스톤 5 릴리스 준비 마감
- 실제 회귀를 발견할 때마다 smoke로 고정
