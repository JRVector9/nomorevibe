# 관리자 모델 작업 실행기

웹은 `ops-runner-actions.ts`에서 관리자·확인·허용 목록을 검사하고 기존 append-only
`operations_audit`에 명령을 접수한다. 웹/maintenance에는 SSH 키·sudo·물리 실행 모듈을 주지 않는다.
별도 운영자 프로세스의 `admin-models-ops-runner.ts`가 같은 작업 ID를 prepare → run 한다.
이 문서는 설치·실행 계약이며 이번 개발 작업에서 운영 설치·DB 쓰기·SSH·배포는 하지 않았다.

## 명령과 버튼

| 허용 동작 | 대상 | 실행 |
| --- | --- | --- |
| `request-release` / 요청 종료·해제 | 미확인 요청 UUID | prepare, DRAIN, owner→gateway 2개→provider 종료, 종료 증거, 기존 V1 release, 역순 복원·검증, OPEN |
| `model-restart` / 모델 재시작 | 등록부 모델 key | 같은 종료·복원 절차. 요청 점유 해제 단계 없음 |
| `admission-pause` / 접수 일시중지 | `model-capacity` | prepare, 정식 pipeline-control CAS로 DRAIN |
| `admission-open` / 접수 재개 | `model-capacity` | prepare, 정식 controller의 실행 계약 검사를 유지한 OPEN |

추가 필드·shell·host·실행 파일·근거 JSON을 웹 입력으로 받지 않는다. 버튼은 사유와 확인 창을 요구한다.
접수 UUID를 재사용하면 응답 유실 뒤에도 중복 명령을 만들지 않는다. 상태는 2초마다 관리자 검사 후 조회한다.
모든 단계의 시작/결과/중단 위치/이유는 감사 장부에 남으며 공개 UI에는 원격 출력·명령·비밀 값을 보내지 않는다.
같은 물리 경계가 겹칠 수 있어 미완료 작업이 있으면 새 작업과 OPEN을 거절한다.
prepare에서만 막힌 사람 작업은 장비·접수를 바꾸지 않았으므로 다른 작업을 막지 않는다.

## 별도 운영자 설치 계약

기존에 승인된 운영자 계정과 **직접 primary DB 세션**에서 실행한다. PgBouncer transaction pooling으로
session advisory lock을 흉내내지 않는다. 외부 장비 인증은 기존 SSH 설정과 정상 host-key 검증을 사용한다.
일회성 도구의 원래 PID/boot/CID/요청 ID를 복사해 재사용하지 않는다.

실행 소스·helper·프로필·장부 디렉터리는 운영자 또는 root 소유이며 모든 경로 구성 요소가
symlink/다른 계정 쓰기 가능이면 거절한다. 장부 디렉터리는 새로 준비된 private 디렉터리(0700)가 필요하다.
프로필과 frozen manifest는 운영자가 검토한 설치본의 실제 바이트 SHA-256으로 고정한다.
웹이 쓰는 볼륨에 설치하거나 웹 DB 입력으로 설치 경로를 정하지 않는다. 이 도구는 chmod·sudo·권한 수리를 하지 않는다.

```sh
node --import tsx scripts/ops/admin-models-ops-runner.ts prepare JOB_UUID --profile=/private/JOB_UUID/profile.json --state-dir=/private/runner-state
node --import tsx scripts/ops/admin-models-ops-runner.ts run JOB_UUID --profile=/private/JOB_UUID/profile.json --state-dir=/private/runner-state
```

CLI는 명시한 작업 하나를 읽으며 전역 DB advisory lock을 가진다. 큐 접수와 진행은 기존 감사 장부를 쓰므로
새 DB 초기화/마이그레이션이 없다. 서버 기동이나 자동 운영 설치는 포함하지 않는다.

접수 제어 프로필에는 `version:1, jobId, action, targetId, requiresSudo:false`만 필요하다.
물리 복구 프로필은 다음 필드를 추가한다. 경로 예시는 **형태**이며 실제 장비 자료가 아니다.

```json
{
  "version": 1,
  "jobId": "접수된 작업 UUID",
  "action": "request-release",
  "targetId": "정확한 요청 UUID",
  "requiresSudo": false,
  "affectedGroups": ["검토한 물리 그룹"],
  "adapter": {"path": "/private/reviewed/admin-models-boundary-adapter.py", "sha256": "검토한 소스의 SHA-256"},
  "material": {"path": "/private/JOB_UUID/manifest.json", "sha256": "검토한 manifest의 SHA-256"},
  "artifactDirectory": "/private/JOB_UUID"
}
```

manifest 계약:

- `version:1, id, action, targetId, requiresSudo:false, stateDirectory:/private/JOB_UUID`.
- `sourceHashes`: 함께 설치한 `admin_models_helpers/`의 7개 소스 파일명 → 실제 SHA-256.
- `targets`: 순서대로 owner/container, gateway/container, gateway/container, provider/systemd 또는 launchd의 네 대상.
  각 대상은 `key`(짧은 ASCII 이름), `role`, `kind`, `host:user@등록호스트`, 기존 읽기 helper의 **비밀 값 없는**
  `expected` 관측 snapshot, canonical `identity`, 원격 private `progressRoot`를 가진다.
  helper는 현재 허용된 text/reviewer와 양 gateway 서비스, `vllm.service`, M3의 고정 native 서비스만 지원한다.
- launchd provider는 기존 frozen diagnostic의 `nativeMaterial`도 가진다. 원본 코드/설정/토폴로지 해시,
  boot·PID·start·process group·descendants·listener를 검증한다. 자격증명 파일 내용은 읽더라도 해시만 기록한다.
- 물리 identity는 snapshot에서 다시 계산해 비교한다. 요청 owner instance/boot가 실제 owner 프로세스에 있는지도 검사한다.
  DB 요청·control pin은 실행기가 primary에서 읽으며 사용자 입력으로 대체하지 않는다.

prepare는 읽기만 수행한다. systemd에 root 권한이 없거나 `requiresSudo:true`, M1이면 DRAIN 전에
`human_on_device_sudo_stop_restore_required`를 기록하고 멈춘다. 사람이 장비에서 할 일을 자동 수행하지 않는다.
모델 재시작은 업무 생성/시험 추론을 하지 않으며 유료 DeepSeek 호출도 없다.

## 안전한 중단과 이어가기

DB writer fence·mode/epoch/revision/policyHash/**updatedAt**을 유지한다. 접수 제어 전환과 실행기의 ACK는
동일 트랜잭션으로 저장한다. OPEN은 별도 수동 버튼도 미완료 복구를 우회할 수 없으며, 복원/원래 설정 hash
검증 뒤에만 수행한다. 시작할 때 이미 DRAIN인 복구는 자동 OPEN하지 않고 prepare에서 거절한다.

다른 reserved/dispatched는 모두 빠져야 한다. 다른 indeterminate는 검토한 `affectedGroups` 안에서는 막고,
밖에서는 점유를 그대로 보존한다. 그룹 범위를 제공하지 않으면 모든 다른 unknown을 보수적으로 막는다.
네트워크/권한 오류나 단순한 idle/경과 시간은 종료 근거가 아니다.

Python coordinator는 대상별 변이 시도 **전** private 장부를 fsync한다. Docker version CAS·원래 spec 유지,
wait ACK와 private PID namespace 종료, systemd boot/invocation/config·전체 cgroup empty,
launchd disabled/unloaded·원래 PID/그룹/descendants ESRCH·대체 프로세스/리스너 부재를 수집한다.
기존 CLI가 원문 artifact hash와 V1 plan/receipt를 다시 검사하고, 기존 DB 장부 hook이 점유만 해제한다.
업무 결과·과거 실패·미확인 사용량은 바꾸지 않는다.

M3 native stop의 `failed / verify-stop / exit_fact_missing_launchdUnloaded`는 native **verify**로 읽기 재확인한다.
성공해야 해제로 진행한다. 다시 실패하면 stop에 멈춘다. stop/restore의 응답이 불명확하면 변이를 재요청하지 않는다.
다음 run은 이미 시도한 대상의 ACK/종료를 다시 읽고, 아직 시도하지 않은 대상만 순서대로 진행한다.
원격 ACK가 없으면 자동 재시작 대신 사람 확인이 필요하다. 실패한 once 디렉터리를 새 작업으로 재사용하지 않는다.

복원은 역순으로 진행하며 새 incarnation·동일 image/spec/source/config·health를 검증한다. 중간 실패는 DRAIN을 유지하고
같은 ID의 run으로 남은 단계를 이어간다. 해제가 이미 기록되었으면 다시 해제하지 않는다. 해제 응답 유실은 기존 exact
plan/receipt 재시도로 먼저 확정한다. primary가 **같은 요청이 여전히 indeterminate**임을 증명한 경우에만 읽기 전용 종료
관측을 갱신할 수 있다. TTL/새 PID를 옛 요청의 종료 증거로 만들지 않는다.

## 자동 회수와 미완료 운영 검증

`MODEL_CAPACITY_AUTO_RECLAIM`은 기본 빈 값/비활성을 유지한다. maintenance가 같은 `runModelOpsRunner`로 들어가며,
PR712의 선언 검증·enforcedAfter·DB lock 아래 local_call_ended/process_group_exit + provider_bound 판정을 재사용한다.
이 분기는 장비를 중지하지 않는다. 장비가 이미 검증된 상한으로 끝난 경우의 기존 경로를 보존하며, 해제 결과를
장부 이벤트와 같은 트랜잭션의 `ops-runner-auto-release` 감사에 남긴다. 활성화는 운영 실측 뒤 별도 작업이다.

남은 운영 단계: 별도 권한 영역에 검토된 설치본/새 snapshot 프로필 배치, 큐 소비 운영 절차 적용,
운영 종료/복원·자동 회수 활성화 드릴. 이번 PR은 배포/권한 설정/운영 장비 조작을 수행하지 않는다.
로컬 브라우저 제한과 실제 검증 결과는 `admin-models-backlog.md`의 이번 실행 기록을 따른다.

## Supa 관리자 root 단계 분리 (2026-10-29)

명시적 provider `rootHandoff:true`를 지원한다. prepare의 절대 argv/private task 준비와 대표의 관리자 root 실행,
root 소유 결과 수집·현재 종료 근거 재검증을 분리한다. runner는 sudo/원격 root 변이를 실행하지 않는다.
자세한 manifest·설치·단계별 실행 목록과 응답 유실 처리:
[2026-10-29-supa-root-handoff.md](2026-10-29-supa-root-handoff.md).
기존 직접 root/launchd 경로와 M1 수동 차단은 보존한다. 이 변경은 운영 실행 영수증이 아니다.
