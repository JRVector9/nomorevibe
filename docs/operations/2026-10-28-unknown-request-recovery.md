# 미확인 요청 감시·M1 해제 연결·reviewer 재시작 보호

작성: 2026-10-28 UTC. 격리 브랜치 `xaegis/cca48837`, 기준 커밋 `8c10f0ad`.

**로컬 코드 보완과 범위 검증 기록이다. GPT-OSS·M1 운영 요청 해제, 운영 배포, 새 업무 성공은 이 작업에서 실행·확인하지 않았다.** 사용자가 제공한 미확인 2건은 작업 입력이며 최신 운영 DB 실측으로 다시 확인한 숫자가 아니다. Coach 체크아웃을 수정하거나 Coach에게 후속 작업을 보내지 않았다.

## 변경

### 이전 정책 점유로 인한 reviewer 반복 재시작 방지

실제 `requestSlot`은 다른 epoch/revision/policy의 점유가 남으면 `policy_changed`로 신규 접수를 거절한다. 새 waiting 행을 INSERT하기 **이전**의 관문이다. 반면 기존 감시 분류기는 `oldActive=true`이면 빈 보호 목록을 반환했다. 따라서 GPT-OSS의 이전 정책 text 점유가 AI1 접수를 막아도 reviewer는 설명 없는 정체로 분류될 수 있었다.

`capacity-admission-block.ts`는 OPEN·활성 writer·검증된 정책 해시와 `oldActive=true`가 있으면 현재 정책의 AI1·AI2 경로에 `scope: policy` 보호를 준다. waiting 행이 없어도 적용한다. 경보, 대기 수, 업무 오류는 유지한다. 점유 해제 뒤에는 정상 재시작 판정으로 돌아가며, 별도의 실제 lane hang 판정은 기존대로 남는다. 같은 정책 점유는 기존의 정확한 경로별 한도 계산을 유지한다.

### Oracle에 요청별 미확인 상태 전달

새 `readModelCapacityUnknowns()`가 primary의 READ ONLY / REPEATABLE READ 트랜잭션으로 `indeterminate`를 읽는다. 최대 64건과 초과 여부를 반환하고, 조회·권한·형식 오류는 `unknown`으로 남긴다. 미확인 요청은 업무 진행·작업 일시정지·정책 변경과 별도로 monitor 전체 경보에 반영한다.

monitor heartbeat → 호스트의 기존 forced-command gateway → Oracle로 다음 필드만 전달한다.

- requestId, routeId, groupId
- 이전 정책 점유 여부
- 같은 owner/boot/binding의 `dispatch_local_ended` 기록 존재 여부

토큰·본문·응답·장부 binding 원문은 전달하지 않는다. Node probe와 Python 수신 양쪽에 개수·길이·형식 제한을 둔다. Oracle은 요청 ID별 사건을 보존하고 기존 incident notifier의 중복 방지·ACK 상태를 사용한다. 실제 알림 전송은 실행하지 않았으며 테스트에서는 가짜 sender만 사용했다.

새 릴리스나 일부 heartbeat 누락은 기존 요청 사건을 해제하지 않는다. 전체 조회가 성공했고 목록이 잘리지 않은 관측에서 요청이 사라졌을 때만 해당 incident를 정리한다. `localEndRecorded`는 로컬 HTTP 종료 관측일 뿐 provider 종료 증명이 아니며, Oracle 사건에 `provider_exit_required` 또는 `local_and_provider_exit_required`를 남긴다.

**Oracle에 DB 자격·모델 종료 권한을 추가하지 않았다. 요청 발견부터 증거 없는 강제 종료·자동 회수까지 구현됐다는 뜻이 아니다.** 운영 monitor 계정이 이미 `model_capacity_requests`·`model_capacity_events`·`model_capacity_control`을 SELECT할 수 있는지는 릴리스 전에 기존 권한으로 확인해야 한다. 부족하면 새 읽기는 `unknown`이 되며 이 작업은 grant를 실행하지 않았다.

### M1의 DB 해제와 relay 점유 표시 정리 연결

기존 `model-provider-boundary-release.ts`에 선택 인자 `--relay-state-dir`를 추가했다. 인자가 없으면 기존 단건 DB 해제 동작을 유지한다.

연결된 순서는 다음과 같다.

1. 실제 relay 상태 디렉터리에서 requestId·relayGeneration이 맞는 `indeterminate` receipt와 active marker를 확인한다. `in_flight`는 거절한다.
2. 기존 plan/artifact 해시, 물리 종료 receipt, owner·control·binding, writer fence와 DB 제약 검증을 그대로 거쳐 단건 해제한다. dry-run은 기존처럼 롤백하며 relay 파일도 바꾸지 않는다.
3. apply가 성공한 뒤 **primary에서 커밋된 행을 새로 읽는다**. 정확한 plan·receipt·operator·reference의 `withdrawn`, 미정산, 같은 release event와 evidence 해시가 있어야 다음 단계로 간다. CLI 종료 코드나 입력 파일만으로 해제 사실을 대신하지 않는다.
4. 커밋된 binding의 wireHash·모델과 relay receipt를 대조한다. 검증 후 별도 `<requestId>.boundary-release.json`을 fsync하여 남기고 active marker만 정리한다. 원래 timeout receipt는 바이트 그대로 보존한다.
5. DB 커밋 뒤 파일 정리가 실패하면 DB 성공 결과와 `relay.kind=blocked`를 함께 출력하고 종료 코드 1을 반환한다. 동일 근거 재실행은 기존 `already_released`를 확인한 뒤 남은 파일 정리만 마친다.

짧은 파일 정리 구간은 `.boundary-recovery.lock`으로 직렬화하며 같은 디렉터리의 새 relay dispatch도 막는다. 경쟁 실행은 잠금을 훔치지 않는다. 정리 프로세스가 SIGKILL 등으로 끝나 잠금이 남으면 자동 만료시키지 않는다. 기록된 PID만 믿거나 시간만 보고 삭제하지 말고, 복구 coordinator가 확실히 종료됐고 다른 복구가 없는지 운영 절차로 확인한 뒤 잠금 파일을 보존·정리해야 한다.

이미 떠 있는 relay의 메모리상 `indeterminate`는 파일 정리만으로 열리지 않는다. 아래 절차처럼 relay를 정지·drain한 상태에서 연결 도구를 실행하고 provider·relay를 기존 설정으로 복원해야 한다. 새 HTTP 관리 endpoint나 자동 모델 재시작은 추가하지 않았다.

## 운영자 실행 조건과 남은 절차

이 브랜치의 코드는 운영에 반영되지 않았다. 리뷰와 저장소 필수 CI를 통과한 코드·gateway·watchdog를 기존 배포 절차로 반영하는 과정이 먼저 필요하다. DB 제약·migration·정책·replica 수·Oracle 자격은 이 변경에 포함하지 않았다.

운영 해제에는 현재 요청 UUID, 원래 immutable binding, 원래 owner 종료 자료, 현재 ingress 및 필요한 gateway/provider의 실제 경계 종료 관측이 필요하다. 이 작업 공간에는 해당 두 요청의 최신 검토된 plan/receipt 원본과 운영 실행 위임 자료가 없다. 최근 대화의 복사 명령 완료나 relay `active.json`은 그 근거를 대신하지 않는다.

GPT-OSS는 요청 후 gateway가 교체됐다는 제공된 맥락이 있다. 현재 프로세스의 PID나 시작 시각을 원래 gateway의 증거로 채우지 않는다. 기존 v1/v2의 출생·종료 조건을 충족하는 자료를 확보해야 하며, 확보할 수 없는 조건은 blocked로 남긴다. 해당 역사 경계 검증을 완화하는 migration은 만들지 않았다.

M1은 실제 상태 디렉터리와 receipt의 requestId·wireHash가 장부 요청과 일치해야 한다. 현재 모델이 살아 있다는 사실, HTTP 200·1,844바이트·90초 timeout만으로 provider 종료를 인정하지 않는다.

운영 담당자의 실행 순서:

1. 현재 primary와 실제 relay의 읽기 전용 관측으로 정확한 두 요청·binding·receipt를 연결한다. 기존 설정과 일시정지 상태를 보존한다.
2. 기존 canonical 절차로 필요한 구간만 drain하고, 요청 당시 실행에 대한 검토 가능한 물리 종료 plan/receipt와 원문 artifact를 준비한다. M1 relay도 정지·drain한다. 운영 원본 디렉터리로 실행하며 복사한 `active.json`에 도구를 적용하지 않는다.
3. 기존 단건 해제 CLI의 plan/receipt/artifact/operator/reference/database-url-stdin 인자를 사용한다. M1에만 `--relay-state-dir=<실제 상태 디렉터리>`를 더한다. 먼저 dry-run, 같은 검토된 근거로 `--apply`를 실행한다. DB URL은 기존 private stdin 경로를 사용하며 명령행·문서에 넣지 않는다.
4. DB `withdrawn`·release event·audit와 relay `cleared`를 각각 확인한다. `settled`·사용량 확정·업무 성공으로 바꾸지 않는다. 실패한 단계의 응답이 불명확하면 먼저 읽어 확인하며 새 stop/restart 요청을 자동 반복하지 않는다.
5. 기존 provider·relay 설정과 자신이 건 일시정지만 복원한다. 신규 자연 번역의 실제 업무 완료와 새로운 미확인 점유 부재를 확인한다. Oracle의 새 빈 목록과 사건 정리를 확인한다. 새 API 요청 성공이나 배포 CLI exit 0만으로 업무 재개를 선언하지 않는다.

**선택한 방식:** 기존 종료 증거 검증을 재사용하는 단건 해제와 relay 정리의 연결 + Oracle의 요청별 읽기 전용 감시. 이 격리 작업의 로컬 구현 범위와 기존 데이터 보존을 지키면서 적용할 수 있는 최소 변경이다. 근거 없는 TTL 회수, 새 권한 부여, 모델 강제 종료·자동 재시작은 유효한 기본값이 아니다. provider가 `response_only`이고 종료 증거가 없는 경우의 완전 자동 회수는 여전히 지원하지 않는다.

## 실제 검증과 제약

- Node 24.18.0: 관련 Vitest 10파일 **82/82 통과**. reviewer 보호, monitor 읽기·heartbeat, 원래 relay 회귀, boundary CLI·Linux/launchd 검증, 정확한 DB readback 모의 검사, 가짜 upstream을 사용한 timeout→증거 정리→relay 재시작→새 요청 완료와 원본 receipt 보존, dry-run·커밋 후 실패·재실행·경쟁 잠금을 포함한다.
- Python: 새 요청 감시 5개, 기존 watchdog 55개, provider probe 5개, gateway 관측 16개, gateway 계약 8개, 합계 **89/89 통과**. 실제 Node probe를 가짜 로컬 heartbeat로 실행했고 외부 전송·운영 컨테이너 접근은 하지 않았다.
- Next 타입 생성, 최종 `tsc --noEmit --incremental false`, 변경 TS 파일 ESLint, `git diff --check` 통과.
- 실제 DB 통합 검사는 **미실행**. `docker version --format '{{.Server.Version}}'`가 `/var/run/docker.sock` 접근 거부로 실패했다. 우회·권한 변경·운영/기존 개발 DB 대체 실행은 하지 않았다. `tests/integration/provider-boundary-release.test.ts`에 실제 DB에서 dry-run 전후 거절·커밋 후 proof·미확인 목록 해제를 확인하는 검사를 추가했으며 CI 실행이 필요하다.
- 최초 `npm ci --ignore-scripts --no-audit --no-fund`는 `registry.npmjs.org` 네트워크 allowlist 차단으로 실패했다. 같은 package-lock SHA(`f609ff6e3159975cce362809a50bc335afb2a812502fb74d70c8ab3a203296d5`)인 로컬 설치 의존성을 작업 공간에 복사해 검증했다. 원본 설치 디렉터리는 수정하지 않았다.
- 초기 TypeScript 검사에서 새 테스트의 잘못된 단위 문자열과 fixture literal 타입 오류를 발견해 수정했다. Python 새 테스트의 두 번째 알림은 요청 중복이 아니라 기존 2표본 pipeline 경보였다. 두 종류를 구분하도록 검사를 수정했다. 실패를 통과 결과로 기록하지 않았다.
- 지정 jobs `artifacts`·`scratch` 디렉터리는 읽기 전용으로 생성이 거부됐다. 결과는 이 브랜치의 이 Markdown에 보존하고 개발 보고에 내용 artifact로 첨부한다. 허브가 `queued`를 반환하면 동기화 완료나 URL 발급으로 표현하지 않는다.
- 전체 unit·전체 DB·build·배포·CI·운영 모델 요청·실제 알림·장기 관측은 실행하지 않았다.
