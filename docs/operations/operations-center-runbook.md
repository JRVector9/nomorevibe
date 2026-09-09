# 운영센터 운영 안내

실제 화면: `/admin/status`. 시안 HTML은 미리보기 자료이며 운영 조작은 실제 관리자에서 한다.

## 화면과 실제 동작

- 전체 현황: 웹 요청/DB 조회, 5개 역할 워커의 supervisor 관측, connect-agent 관측, 후보 단계별 수, 선택한 서비스의 담당 작업과 최근 처리 기록.
- 작업 목록: 한국어·잡명 검색, 역할 필터, 실행/예약/재시도/요청 버전/재개 위치/최근 회차 결과. 요청 버튼은 기존 DB 잡 신호를 기록한다. 이미 요청된 신호는 합치고 최근30초 내 실행 요청은 억제한다. 처리 완료 후보 수로 요청 버전을 해석하지 않는다.
- AI 연결: Codex device 로그인 및 Claude OAuth 코드 입력, 취소·만료·실패, 모델별 실제 구조화 출력 검사, 검증한 설정 적용. 우선/예비 모델은 Codex Spark/Terra(high/xhigh) 또는 Claude Sonnet(high), 예비 없음 선택을 지원한다. 이 목록이 모든 계정의 모델 사용 권한을 보장하지 않는다.
- 수동 분류: approved 후보 최대50건을 표시한다. 분류 및 사유를 저장하고 발행 잡을 요청한다. 후보/원본/taxonomy가 달라지면 저장을 거절한다. 발행 시점에 분류 결정 revision과 기존 출처/심사/중복/차단 조건을 재검사한다.
- 기존 근거/랭킹/수율/응답 실패 제품 지표는 전체 현황 하단의 상세 지표에 유지한다.

## Codex·Claude 인증과 설정

`connect-agent`는 외부 포트를 공개하지 않는 내부 서비스다. 웹/퍼블리셔는 `CONNECT_AGENT_URL`과 `OPERATIONS_AGENT_SECRET`으로 내부 RPC를 인증한다. Docker socket을 사용하지 않는다. Compose의 현재 기본값은 기존 AUTH_SECRET을 내부 키로 전달한다.

서버 배포 모드에서는 연결·상태 상세·모델 검사·적용에 `ADMIN_GITHUB_LOGINS`에 허용된 정상 서명 쿠키가 필요하다. 로컬 개발은 `ADMIN_LOCAL_LOGIN=1`, `ADMIN_LOCAL_CODEX=1`, HTTP loopback `NEXT_PUBLIC_SITE_URL`을 모두 지정하면 GitHub OAuth 없이 연결할 수 있다. 로컬 Compose 웹 포트는 `127.0.0.1:3200:3000`으로 제한한다. 이 모드를 외부 프록시로 공개하지 않는다. 운영 배포에서는 두 로컬 플래그를 끄고 정상 관리자 로그인을 사용한다.

AI 연결 탭에서 연결을 시작하고 공식 OpenAI 인증 페이지에서 승인한다. 진행 중인 로그인은 '연결 계속'으로 다시 열 수 있다. 요청 실패에는 오류와 재시도 버튼을 표시하며, 취소/만료/실패 상태에서는 이전 코드나 코드 준비 문구를 표시하지 않는다.

연결 절차:
1. 별도 임시 CODEX_HOME에서 pinned codex-cli0.153.4의 `login --device-auth`를 실행한다.
2. 공식 인증 URL과 device 코드만 관리자에게 노출한다. 취소/10분 만료 시 프로세스를 종료하고 임시 파일을 정리한다. 실패한 재연결은 이전 저장 자격을 보존한다.
3. refresh/id/access 토큰을 포함한 전체 auth.json 스키마를 검사하고 암호화 vault에 원자적으로 저장한다. UI/DB 관측/로그에 자격 원문을 저장하지 않는다.
4. 선택한 모델마다 샘플 분류를 실행한다. 모델별 검사 결과와 하나 이상의 스키마 검증 성공을 credential generation/config에 묶는다. 접근 거절·인증 거절·사용 제한·timeout·출력 형식 오류를 구분한다.
5. 검증 ID와 현재 설정 버전이 일치할 때 저장한다. 다음 분류 배치에서 적용하며 마지막 실제 사용 버전을 별도로 표시한다.

vault는 named volume `codex-vault`의 AES-256-GCM 암호문이고 runtime auth는 connect-agent 전용 /tmp(tmpfs)의0600파일이다. 인증·검사·분류는 단일 소유자가 한 번에 하나만 수행하며 CLI 종료 후 갱신된 auth.json 전체를 다시 암호화한다. 별도 브로커가 분류까지 맡으므로 credential webhook/공유 writable auth 볼륨이 필요 없다. vault 암호화 키로 사용하는 secret을 임의로 바꾸지 않는다. 키를 잃으면 기존 vault를 읽을 수 없으며 다시 인증해야 한다. 현재 자동 키 회전 기능은 없다.

## 실패와 부하

연결/모델 검사가 끝나지 않았거나 분류가 실패하면 managed publisher는 approved 상태를 유지한 채 분류 보류를 기록하고1시간 후 재시도한다. source/candidate 갱신은 더 일찍 다시 시도할 수 있다. 카테고리 지정은 AI 심사 승인을 대체하지 않는다. CONNECT_AGENT_URL이 없는 기존 CLI 경로는 이전 규칙 fallback을 유지하므로 rollback 정책 차이를 고려한다.

관측 키 수는 역할/잡별로 제한된다. supervisor는15초, connect-agent는5초 간격으로 관측한다. UI는 스냅샷 조회와 수동 새로고침이며 AI 작업 중에만3초 간격으로 상태를 조회한다. 완료된 잡은 최근12개 이벤트의 숫자/불리언 처리량만 저장하며 원본·모델 출력·인증 원문을 복제하지 않는다. RPC 입력64KB, 최대10개 후보, 모델당35초, 동시 CLI1개, HTTP 연결24개로 제한한다. 정상 현황 조회는 새 모델 호출을 발생시키지 않는다. supervisor RSS는 감시 프로세스 메모리이며 컨테이너 전체 RSS가 아니다.

## 배포와 확인

1. 기존 DB 백업.0023 additive migration 적용.
2. 웹/worker 이미지를 빌드하고 기존 runtime secrets를 유지한다.
3. 기존 소비자를 정상 drain하고 app/scheduler/crawler/reviewer/publisher/maintenance/connect-agent를 새 버전으로 기동한다. 역할별1개 인스턴스로 운영한다.
4. compose health 및 operations_observations 갱신, 잡 요청/완료를 확인한다. 실제 계정 승인 전에는 Spark 정상 동작을 주장하지 않는다.

```sh
docker compose -p nomorevibe ps
curl -I http://127.0.0.1:3200/admin/status
docker exec nomorevibe-db-1 psql -U nomorevibe -d nomorevibe -c "select key,observed_at from operations_observations order by key"
```

rollback은 새 퍼블리셔를 drain하고 이전 이미지/환경을 복구한다. 추가 테이블은 남겨도 이전 코드와 호환된다. 이전 퍼블리셔로 되돌리면 AI 실패 시 규칙 fallback 발행 정책도 복구된다. DB 복원은 기본 rollback 절차가 아니다.

## Claude 예비 분류 (Deppy-aibox 통합)

Deppy-aibox `814144a2d37cb60359486219393f93f32c7267fc`의 core/provider-claude 모듈을 `lib/vendor/deppy-aibox`에 Apache-2.0 라이선스와 함께 포함했다. 별도 aibox 서버 대신 기존 connect-agent가 제공자 모듈의 PTY 실행·URL 추출·토큰 캡처를 사용한다.

1. 운영센터 → AI 연결 → Claude 연결 → 공식 인증 페이지에서 승인한다.
2. 공식 페이지가 표시한 인증 코드를 관리자 모달에 입력한다. 코드는 stdin으로만 전달하고 DB/감사 기록에 저장하지 않는다.
3. `Spark → Claude 예비 설정 선택` → 선택 모델 검사 → 검증된 설정 적용. 기존 적용 설정은 자동 덮어쓰지 않는다.
4. 각 모델을 샘플로 검사하며 하나 이상 성공해야 적용 가능하다. Codex가 인증 불가여도 Claude 검사 성공으로 적용할 수 있다. 검사 결과에서 어느 모델이 실패했는지 확인한다.
5. 우선 모델의 인증/권한/한도/시간 초과/CLI 없음/출력 오류가 발생하면 예비 모델로 재시도한다. 각 시도 제한35초, 최대2회이며 두 모델 모두 실패하면 기존 approved/분류 보류 정책을 유지한다.

Claude `setup-token` OAuth 토큰은 기존 vault에 추가 암호화 저장한다. 기존 Codex refresh credential은 보존한다. 재연결은 인증 세대를 바꾸므로 모델 재검사·적용이 필요하다. Claude 추론은 격리된 HOME/설정 경로에서 OAuth 토큰을 해당 자식 프로세스 환경에만 전달하며 도구·MCP·사용자 커스터마이징·세션 저장을 끈다. 후보 심사(reviewer)의 기존 Claude 인증 설정과는 별개이며 이 연결로 reviewer 환경을 자동 변경하지 않는다.

컨테이너의 PTY에는 util-linux `script`와 `SHELL=/bin/sh`가 필요하다. worker 계정의 기본 nologin 셸을 사용하면 `This account is not available`로 종료된다. Codex/Claude 연결 취소·만료 시 detached 프로세스 그룹 전체를 종료해 하위 CLI가 남아 busy 상태를 고정하지 않게 한다. 브로커 재시작은 진행 중 인증을 중단하므로 연결 대기 중에는 피한다.

Sonnet은 설치된 Claude CLI가 해석하는 모델 별칭이다. 계정의 실제 접근 권한은 모델 검사로 확인한다. OAuth 승인 및 실제 계정 모델 호출은 사용자가 계정을 연결한 후에만 검증 가능하다.


## 2026-09-09 연결 상태·입력 프로토콜 수정

Codex의 `인증 저장 완료`는 자격 보관 상태다. 계정별 `연결 확인`은 저장된 계정으로 샘플 모델 응답을 실제 요청하고, 결과·모델·확인 시각을 따로 기록한다. 이 검사는 모델 설정을 적용하지 않는다. 모델 검사 → 설정 적용을 완료해야 퍼블리셔가 사용한다. `configReady`는 저장된 설정이 현재 인증 세대에 적용되었는지를 뜻하며 실제 최근 모델 응답과 구분한다.

Claude 입력은 Deppy-aibox USAGE.md의 `sendInput(code + '\r')`와 동일하게 Enter(CR)를 보낸다. 이전 통합 코드의 LF는 Claude 터미널에서 제출로 인식되지 않았다. 실제 pinned CLI에 잘못된 테스트 코드를 보내 LF에서는 응답이 없고 CR에서는 거절 응답이 발생하는 것을 재현했다. 거절 메시지는 원문/코드 노출 없이 `oauth_rejected`로 표시하고 연결을 종료한다. 제출 뒤45초 응답 제한을 별도로 둔다. 전체 로그인 세션 제한은10분이다.

UI는 AI 탭을 보는 동안3초 간격으로 현재 상태를 조회하고 조회 오류 이후에도 재시도한다. 이전 조회가 늦게 도착해서 새 연결 결과를 덮어쓰지 않게 한다. 모델 선택은 로그인 대기 중에도 가능하며, 실제 검사·적용은 단일 CLI 실행 종료까지 대기한다. 대기 사유와 연결 취소 버튼을 같은 화면에 표시한다. 인증 세대/설정 버전 등 기술 정보는 펼쳐보기로 이동했다.

Deppy-aibox 전체 서버/React SDK를 그대로 이식한 것은 아니다. 원본 provider-claude/core를 재사용하며 기존 broker의 인증·암호화 저장·분류 소유권을 유지했다. 그 통합부의 입력·상태 계약 차이를 위와 같이 수정했다. 실제 사용자 Claude 승인 완료/계정 모델 응답은 사용자 재연결 후 확인해야 한다.

### 2026-09-09 인증 카운트다운 및 Claude 입력 호환성

- 계정 응답 검사/선택 모델 검사는 모델별 35초, 계정 연결은 600초, Claude 코드 제출 이후는
  45초의 남은 시간을 표시한다. 서버가 전달하는 작업 ID·기한·현재 시각을 기준으로 계산하며,
  창을 닫았다 열거나 상태를 갱신해도 같은 작업의 기한은 초기화되지 않는다. 0초에서는 서버의
  최종 결과를 기다리며, 시간 만료만으로 연결 성공을 표시하지 않는다.
- Deppy-aibox 기준 CLI는 2.1.186, 현재 이미지의 Claude CLI는 2.1.263이다. 현재 CLI에서는
  긴 `code#state`와 CR을 한 번에 stdin에 쓰면 붙여넣기로 처리되어 제출이 멈출 수 있다.
  코드를 먼저 쓰고 250ms 후 CR을 별도 입력한다. 취소/프로세스 종료 시 예약 입력을 취소한다.
- 현재 setup-token 성공 출력은 토큰 다음에 빈 줄을 둔다. vendored Claude 캡처기는 완성된
  빈 줄도 토큰 구분자로 인식하도록 수정했다. 스트림 끝의 미완성 줄은 계속 기다린다.
- 검증 범위: 실제 CLI에 형식이 완전한 가짜 인증 코드를 제출했을 때 713ms 내 `oauth_rejected`
  응답 및 작업 잠금 해제를 확인했다. 성공 출력 캡처·암호화 저장은 테스트로 검증했다.
  이는 실제 사용자 Claude 계정의 OAuth 승인/모델 응답 성공을 의미하지 않는다.
- 재시도: AI 연결 → Claude 연결 → 공식 페이지 승인 → 새 인증 코드 전체(`code#state`) 입력 →
  인증 저장 완료 확인 → Claude 연결 확인 → 선택 모델 검사 → 설정 적용.

### 2026-09-09 Claude 인증 저장 후 401 복구 및 hi~ 확인

- 인증 저장 완료는 저장 여부만 뜻한다. 이 시점의 실제 401은 과거 검사 표시가 아니라 손상된 토큰
  때문이었다. PTY의 안내 문구 첫 단어 `Store`가 독립 줄로 전달되어 토큰 뒤에 붙은 값이 저장됐다.
  캡처기는 `Store`로 시작하는 안내 줄을 토큰 연속 줄로 합치지 않으며, 미완성 안내 줄은 기다린다.
- 이미 손상된 로컬 인증은 해당 접미사를 제거한 후보로 실제 Sonnet 응답을 먼저 확인하고 복구했다.
  원본 vault는 암호화 상태로 같은 볼륨에 백업했다. 모델 설정 버전 2와 적용 세대 2는 보존됐다.
  접미사를 무조건 제거하는 자동 복구 로직은 없다. 다른 토큰에 같은 보정을 추측 적용하지 않는다.
- Claude 연결 확인은 `hi~` 고정 메시지에 대한 일반 텍스트 응답을 별도 기록하고 화면에 표시한다.
  선택 모델 검사는 기존 JSON 카테고리 분류를 그대로 검증하며, 인사 응답만으로 설정을 승인하지 않는다.
  성공 답변만 최대 2,000자로 표시하고 원본 CLI 오류/토큰은 표시하지 않는다.
- 실제 관리자 버튼 호출에서 `Hi! What are you working on?` 응답 확인. 이후 선택 모델 검사에서
  Codex Spark와 Claude Sonnet 모두 정상 응답 확인. 새 계정 승인은 필요하지 않다.
