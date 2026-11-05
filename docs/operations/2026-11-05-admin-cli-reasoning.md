# 관리자 CLI 모델 · 추론 강도 연동

2026-11-05 사용자 지정: **M3 호스트에 이미 설치된 OpenCode를 연결한다.** 워커에 OpenCode를 설치하거나 기존 계정을 복사·업그레이드하지 않는다. 업무 순위와 용량 설정은 자동 변경하지 않는다.

## 연결과 모델 선택

- 실행 대상은 M3의 `jr` 계정, HOME `/Users/jr`, 기존 `/opt/homebrew/bin/opencode` **1.19.5**다.
- 기존 로그인으로 실제 조회한 모델은 OpenCode 81개와 OpenCode Go 30개다. 관리자에는 모델 ID·표시 이름·지원 variant·조회 시각만 전달한다. Provider 원본의 key/options는 전달하지 않는다.
- DeepSeek V4.1 Flash의 실제 variant는 `low/high/max`, Pro는 `high/max`다. 선택지는 하드코딩하지 않고 해당 호스트의 catalog에서 읽는다.
- 기존 AI 연결 행에 호스트 주소와 **별도의 RPC 인증키 암호문**을 저장한다. 이 키는 CLI의 provider 계정 키가 아니다. 기존 secret-box와 연결 ID AAD를 사용하며 브라우저·감사·실행 인자에 다시 내보내지 않는다.
- 최초 M3 연결은 실제 catalog를 확인하는 서버 등록 경로로 구성한다. 이후 등록된 연결을 편집하고 기존 순위 서랍에서 모델·추론 강도를 선택한다. 일반 호스트 등록 화면은 추가하지 않는다.
- 목록은 비동기로 읽으며 성공 결과를 60초 캐시한다. 저장할 때는 선택한 연결의 실제 catalog·버전·variant를 다시 확인한다. 미접속이어도 기존 연결 끄기는 허용하고, DB에 있는 모델·버전·기타 옵션을 보존한다.
- OpenCode 실행 지원 범위는 검수 1차·2차다. 소개 검수·감사·분류의 고정 경로와 API 전용 작업은 확대하지 않는다.

## M3 호스트 실행

`npm run cli-host:bundle -- --out /절대경로/cli-host-bridge.mjs`로 기존 의존성을 포함한 단일 ESM 파일과 metafile을 만든다. M3에는 새 npm 패키지를 설치하지 않고 기존 Node 25.6.1로 실행한다.

호스트 서비스는 `jr`로 실행하며 필요한 구성은 비공개 파일로 전달한다. `DATABASE_URL`은 기존 primary ledger 접근이고, `OPENCODE_HOST_SECRET`은 연결 행에 암호화한 전용 RPC 키다. `OPENCODE_HOST_BIND`는 loopback 또는 Tailscale IPv4만 허용하고 기본 포트는 3031이다. 앱의 새 전역 URL/키 환경변수는 사용하지 않는다.

RPC는 인증된 `POST /v1/rpc`의 catalog·prepare·run·notStarted·release만 받는다. 기존 OpenCode의 `run --pure --format json --model provider/model --variant ...`를 호출하며 stdin으로 검수 입력을 전달한다. 별도 상시 OpenCode 서버를 열지 않는다.

각 호출의 임시 설정은 도구·MCP·플러그인·추가 제목/요약/압축 호출·자동 업데이트를 끈다. 설정 디렉터리는 0500으로 잠가 v1의 자동 패키지 bootstrap을 막는다. 원래 HOME/XDG 인증 저장소는 유지하며 DB·RPC 비밀과 제어 환경변수는 CLI 자식에 전달하지 않는다. 생성한 임시 디렉터리만 정리한다.

## 실행 상태와 정산

worker는 기존 예약·업무 claim·dispatch 트랜잭션을 유지한다. 호스트는 `bootId/callId`가 가리키는 원본 준비 객체를 한 번만 실행하며, 실행 직전 primary DB의 실제 dispatch 전체와 transport를 대조한다.

native terminal은 생성한 호스트 프로세스 안에서 기존 reconciliation으로 정산한다. RPC의 JSON을 native terminal로 바꾸지 않는다. worker는 primary DB의 정산 행·원래 dispatch·증거 해시를 다시 확인한 뒤 결과를 사용한다. 연결 단절·재시작·정산 실패는 기존 indeterminate 경로로 남기며 자동 재실행하거나 미실행으로 정산하지 않는다.

## 스키마와 운영 경계

0163은 검수 전용 OpenCode ledger 가지를 추가한 기존 이전이다. 이미 적용된 이전을 재실행하지 않는다.

0164는 실제 111개 모델을 수용하도록 OpenCode 목록 상한만 512로 늘리고, OpenCode에만 호스트 주소/암호문 쌍을 허용한다. 다른 CLI는 기존 32개·NULL 제약을 유지하고 legacy 행도 보존한다. catalog variant는 모델 순서 해시에 묶은 작은 snapshot이며 기존 options 8KB 제한을 유지한다. 실제 111개 관리 옵션은 3,029바이트였다.

별도 이전과 journal 검증 후 일반 배포 절차를 따른다. 기존 모델 배정·provider budget·동시 실행 한도·종료 미확정 행을 임의 변경하지 않는다. catalog 조회와 인증정보 존재는 실제 모델 호출 성공을 뜻하지 않는다.

## 검증 범위

M3의 실제 기존 CLI에서 격리된 metadata 조회 111개와 자동 패키지 미설치를 확인했다. 변경 범위의 parser·host 원본 호출/정산 경계·원격 연결·UI 저장/캐시 회귀를 실행했다. 실제 모델 추론이나 가상 업무 데이터는 생성하지 않았다. 필수 GitHub CI와 운영 배포·건강 확인 결과는 실제 영수증으로 별도 기록한다.

- [사용 버전의 모델 목록 구현](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/cli/cmd/models.ts)
- [사용 버전의 실행 구현](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/cli/cmd/run.ts)
