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
