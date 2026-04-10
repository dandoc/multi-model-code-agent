# 릴리스 체크리스트
언어: [English](release-checklist.md) | **한국어**

이 체크리스트는 현재 CLI 저장소의 릴리스 준비 상태를 판단하는 기준입니다.

목표는 “세상의 모든 provider와 모델이 다 된다”를 증명하는 것이 아닙니다. 현재 우리가 실제로 쓰는 경로가 건강하고, 문서화되어 있고, 반복 가능한 검증으로 잠겨 있는지를 확인하는 것입니다.

## 범위

이 체크리스트는 현재 `multi-model-code-agent` 저장소에 적용됩니다.

- CLI와 REPL 동작
- 멀티 모델 runtime 전환
- session / profile persistence
- packaging과 로컬 설치 흐름
- 실제 회귀를 막는 smoke coverage

이 문서는 미래의 Electron GUI나 서브에이전트 오케스트레이션 제품까지 포함하지 않습니다.

## 필수 문서

릴리스 후보를 준비 상태로 보기 전에 다음 문서가 최신이어야 합니다.

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

## 필수 명령

다음 명령이 기본 릴리스 준비 게이트입니다.

```bash
npm run typecheck
npm run build
npm run smoke
npm run smoke:release
```

현재 선택된 실사용 provider에 대해서는 다음 live check도 함께 실행합니다.

```bash
npm run smoke:live -- current all
```

또는 합쳐진 scripted closeout 경로를 실행합니다.

```bash
npm run smoke:closeout
```

## 수동 확인 항목

스크립트 smoke 외에도 아래를 한 번 확인합니다.

1. `npm run build`
2. `npm link`
3. `mm-agent --version`
4. `mm-agent --help`
5. REPL을 한 번 띄운 뒤 다음 확인
   - `/version`
   - `/help`
   - `/status`
   - `/models doctor`
   - `/models smoke quick`
   - `/profiles`
   - `/sessions`

## 지원 runtime 사인오프

릴리스 후보에는 어떤 runtime 조합을 “실사용 지원 경로”로 보는지 명확히 적혀 있어야 합니다.

현재 단계에서 우선 사인오프하는 경로는 다음입니다.

- Windows에서 `Ollama + qwen3-coder:30b`
- Windows에서 `Codex CLI + gpt-5.4`

보조 호환 경로는 문서화할 수 있지만, 주 지원 경로를 조용히 대체하면 안 됩니다.

## 회귀 관리 원칙

수동 사용이나 live-provider 검증 중 실제 failure를 발견하면:

1. 먼저 로컬에서 재현하고
2. 가능하면 smoke / regression 테스트로 고정하고
3. `docs/development-log.md`에 남기고
4. 그 다음에 닫습니다

## 범위 밖

다음 항목은 이 저장소의 CLI 릴리스를 막는 대상이 아닙니다.

- Electron GUI 작업
- 서브에이전트 오케스트레이션 UI
- 사용자 노출형 benchmark 제품
- 직접 파일을 수정하는 서브에이전트
