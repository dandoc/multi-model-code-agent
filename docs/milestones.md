# Project Milestones

## 비전

여러 모델을 바꿔가며 코드 읽기, 검색, 수정, 명령 실행을 할 수 있는 로컬 우선 코딩 에이전트 CLI를 만든다. 사용감은 Claude Code 스타일을 지향하되, 구조는 멀티 모델 환경에 맞게 단순하고 이해하기 쉽게 유지한다.

## 개발 원칙

- 로컬 우선
  - 기본 축은 `Ollama + Qwen/Gemma`
- 모델 교체 가능성 유지
  - 특정 벤더에 종속되지 않는 어댑터 구조
- 위험 작업은 승인 기반
  - 수정과 셸 실행은 기본적으로 사람이 확인
- 작은 범위부터 검증
  - 완전체보다 학습 가능한 MVP 우선
- 정확성이 필요한 분석은 점점 결정론적으로
  - 중요한 프로젝트 분석은 모델 추측에만 의존하지 않기

## 마일스톤

### 마일스톤 0. 기반 뼈대 만들기

상태: 완료

완료 기준:

- TypeScript CLI 프로젝트 구성
- `Ollama` 연결
- `OpenAI-compatible` 연결
- 기본 REPL 동작
- 핵심 툴 4개 이상 연결
- git 형상관리 시작

### 마일스톤 1. 프로젝트 탐색과 근거 기반 읽기 강화

상태: 진행 중

완료 기준:

- `list_files`로 구조 탐색 가능
- `read_multiple_files`로 여러 근거 파일 동시 읽기 가능
- `summarize_project`, `find_entrypoint`, `summarize_config` 같은 결정론적 분석 툴 사용 가능
- 프로젝트 구조 질문에 더 안정적으로 답변
- 엔트리포인트, 설정, 실행 방법 질문에서 실제 파일 근거 비중 확대
- 작은 로컬 모델이 답변을 제대로 마무리하지 못할 때 결정론적 폴백 사용 가능

남은 핵심 과제:

- Qwen 계열에서 config/architecture 질문의 최종 응답 품질 추가 보강
- 필요하면 디렉터리 단위 요약이나 관련 파일 추천 툴 추가

### 마일스톤 2. 코드 수정 안정성 강화

상태: 진행 중

완료 기준:

- 패치 실패 케이스 감소
- 변경 전후 확인 흐름 강화
- 더 좋은 승인 메시지
- 수정 작업의 복구 가능성 개선

현재 진행 내용:

- `write_patch` 승인 전에 변경 미리보기 표시
- `write_patch` 실행 결과에 before/after 중심 요약 표시
- `run_shell` 승인 메시지 가독성 개선

### 마일스톤 3. 세션과 사용성 강화

상태: 완료

완료 기준:

- 세션 기록 저장
- 최근 작업 복원
- 설정 프로필 분리
- 모델 전환 UX 개선

### 마일스톤 4. 멀티 모델 확장

상태: 예정

완료 기준:

- `Qwen`, `Gemma`, `OpenAI-compatible` 계열의 더 안정적인 사용
- 모델별 프롬프트와 설정 튜닝
- 공급자별 실패 패턴 정리

### 마일스톤 5. Claude Code 스타일 완성도 높이기

상태: 예정

완료 기준:

- 더 좋은 터미널 UX
- slash command 확장
- diff 보기 강화
- 테스트 보강
- 배포 가능한 CLI 형태 정리

## 현재 초점

지금 가장 중요한 문제는 "분석 정확도"다. 간단한 실행 안내나 단일 파일 읽기는 가능하지만, 프로젝트 구조나 엔트리포인트 같은 질문에서는 로컬 모델이 실제 파일을 덜 읽고 추측하는 문제가 있다.

따라서 현재 방향은 두 가지다.

- 가능한 답변은 실제 파일 근거를 더 많이 읽도록 유도하기
- 정말 정확해야 하는 프로젝트 분석은 점진적으로 결정론적 툴로 분리하기

후보 툴 예시:

- `find_entrypoint`
- `summarize_project`
- `summarize_config`
## Milestone 2 addendum

Current Milestone 2 coverage now also includes workspace-local file creation:

- the prompt explicitly allows creating files and nested folders inside `workdir`
- the agent retries if the model refuses a safe workspace-local create request
- the agent also retries if the model claims creation is complete without a real `write_patch` result
- `npm run smoke` now verifies this path with a temporary workspace
- `write_patch` approvals now show a compact diff-style preview for create and replace operations

## Milestone 3 addendum

Current usability improvements now include persisted startup model settings:

- `/model`, `/provider`, and `/base-url` update `.env`
- restart behavior now follows the last saved startup model choice
