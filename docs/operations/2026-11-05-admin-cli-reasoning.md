# 관리자 CLI 모델 · 추론 강도 연동

2026-11-05. 기존 순위·운영 계정·활성 모델은 자동 변경하지 않는다.

## 적용 범위

- 실시간 전체 흐름의 모델 순위 서랍과 작업 ↔ AI 모델의 공통 순위 편집기에서 추론 강도를 저장한다. 기존 options의 다른 키는 보존한다.
- OpenCode는 실제 순위 실행이 연결된 검수 1차·2차만 지원한다. 소개 검수·감사·분류의 고정 실행 경로 또는 API 전용 작업을 OpenCode로 실행한다고 표시하지 않는다.
- 새 OpenCode 연결은 기존 연결 관리 폼에서 CLI 도구 `opencode`로 등록한다. 모델 목록은 운영자가 등록한 실제 연결의 `cliModels`만 사용한다. 가상 연결·샘플 배정은 만들지 않는다.
- Flash: `opencode/deepseek-v4.1-flash`, `opencode-go/deepseek-v4.1-flash`, `opencode/deepseek-v4.1-flash-free`는 `low/high/max`. `opencode/deepseek-v4-pro`는 `high/max`. 그 밖의 모델은 검증되지 않은 추론값을 제안하지 않는다.
- 선택값은 실제 CLI 인자에 전달되고 관리된 프로세스/모델 용량 장부의 기존 검증을 거친다. OpenCode JSONL의 정상 완료·검수 JSON을 확인하며 도구 실행·오류·미완료 출력을 승인으로 해석하지 않는다.

## 실행 환경

worker 이미지에 공식 npm 패키지 `@opencode/cli@2.2.5`를 고정 설치한다. 연결의 CLI 버전은 실제 `--version` 출력인 **`opencode v2.2.5`** 그대로 입력한다. v2.2.5는 `--variant`가 없으므로 `--model provider/model#variant` 형식을 사용한다.

호출은 `--standalone`으로 개인 서버를 사용하며, 임시 작업 디렉터리에 검수 전용 agent를 작성한다. `/etc/opencode/opencode.json`의 시스템 정책으로 도구·MCP·skills·plugins를 막고 제목·요약·압축 agent와 warming을 끈다. 검수 외 숨은 모델 호출을 만들지 않는다.

워커의 DB·제어 환경변수는 OpenCode에 전달하지 않는다. 표준 HOME/XDG 계정 저장소와 필요한 provider 환경변수만 사용한다. 임의 `OPENCODE_CONFIG*`·`OPENCODE_SERVER*` 재정의는 넘기지 않는다.

## 계정 연결과 운영 적용 경계

구현 전 읽기 전용 확인 결과, GPU3090에는 OpenCode와 OpenCode Go의 계정 연결이 각각 1개 있었고 운영 reviewer에는 OpenCode 실행 파일·로그인 저장소가 없었다. **어느 계정을 운영에 연결할지는 사용자 답변 대기**다. 이 문서 작성 시 토큰 내보내기·복사·운영 순위 변경·모델 추론은 실행하지 않았다.

v2 계정은 표준 XDG data의 `opencode/opencode.db`에 저장된다. 운영자의 `debug paths`로 실제 워커 사용자 경로를 확인한다. 컨테이너 재배포를 견디도록 전용 영속 경로를 쓰거나 운영 비밀 환경변수로 연결한다. 기존 앱의 볼륨·환경·역할 설정을 덮어쓰지 않는다. `OPENCODE_AUTH_PATH`라는 비공식 변수를 발명하지 않는다.

계정 출처가 확인되면 공식 `auth export <선택한 integration>` → `auth import --standalone`을 비밀 출력 없는 stdin/메모리 경로로 수행할 수 있다. 전체 계정을 무차별 복사하거나 SQLite를 직접 해석하지 않는다. 내보내기 JSON은 비밀이므로 채팅·Git·공개 보고서·실행 인자·일반 로그에 남기지 않는다. 읽기 전용 auth 메타데이터로 연결 존재를 확인하고 실제 모델 호출을 검증했다고 기록하지 않는다.

0163은 CLI 연결 CHECK와 검수 전용 장부 가지를 추가한다. 별도 마이그레이션 절차에서 DRAINING과 실제 진행 중 요청 0을 확인한 뒤 적용한다. 기존 CLI·terminal·indeterminate·분류 복구 의미를 넓히지 않는다. 일반 배포 도구의 `--migration-verified`만으로 이전을 대신하지 않는다. 적용 후 journal과 생성된 guard를 확인하고 단축 배포를 따른다.

## 실제 확인한 결과

- 새 node:24.22.1-alpine 컨테이너에서 npm 설치, `opencode --version`, `opencode run --help` 성공. x64 musl에서 실행 확인. ARM64는 이미지 빌드의 실행 확인이 별도로 필요하다.
- 설치된 v2.2.5에서 빈 HOME/XDG + `debug config --standalone`으로 제한 정책 JSON을 파싱했다. 실제 계정·모델 추론을 사용하지 않았다.
- GPU3090의 인증된 읽기 전용 `/api/model`에서 위 DeepSeek 모델 ID·variants를 확인했다. 모델 요청은 하지 않았다.
- 관리자 화면은 실데이터 읽기 전용 미리보기의 390/768/1600px에서 문서 가로 넘침 없이 렌더링됐다. 저장·제어·프로브 요청은 없었다. 실제 Claude CLI sonnet/high 초안을 골라 확인표의 추론 강도 표시도 확인했다.
- 독립 검토에서 이전 stop 뒤의 length/미완료 응답을 잘못 승인할 수 있는 parser 조건을 찾아 마지막 assistant 종료를 검사하도록 보강했다. 캐시·추론 토큰도 고정 버전 합산식에 포함한다.
- 변경 경로의 회귀 검사와 정적 검사를 수행했다. 스키마 이전의 정확한 좁은 검증·초기 실패·보완 결과는 [0163 스키마 기록](2026-11-05-opencode-cli-schema.md)에 보존한다. GitHub 필수 CI는 PR에서 별도로 확인하며 실행하지 않은 운영 추론을 통과했다고 기록하지 않는다.

## 정본

- [공식 v2 CLI 명령](https://opencode.ai/v2/docs/cli/commands)
- [모델과 variant 형식](https://opencode.ai/v2/docs/models/)
- [시스템 설정 우선순위](https://dev.opencode.ai/v2/docs/config/)
- [고정 버전 JSONL 구현](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/cli/src/run/noninteractive.ts)
- [고정 버전 설정 스키마](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/config.ts)
- [고정 버전 토큰 합산](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/token-usage.ts)
