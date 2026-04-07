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

검증:

- `Find the main entrypoint of this project and explain the execution flow in Korean.`
