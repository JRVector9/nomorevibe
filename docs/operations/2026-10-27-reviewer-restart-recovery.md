# 2026-10-27 reviewer 반복 재시작 복구

## 원인과 실제 조치

DeepSeek 요청8dc의 클라이언트가 취소된 뒤에도 모델 서버의 종료가 확인되지 않아 공유 m3-mlx 슬롯 한 개가 점유돼 있었다. FIRST 검수도 이 그룹을 사용해 capacity 대기를 반복했다. 기존 progress 판정은 이를 워커 정체로 보고 15초 표본 두 번 뒤 reviewer를 종료했다. 새 컨테이너의 180초 warming_up과 교체 공백 replicas_missing이 알림으로 이어졌다. 현재 재현된 경로는 운영 로그·DB·실제 설정으로 확인했으며, 사용자가 받은 과거 각 알림의 개별 trigger까지 확정한 것은 아니다.

운영에서는 신규 모델 접수를 DRAINING(감사20521)한 뒤 실제 native provider와 reviewer/gateway 경계를 종료했다. 모든 경계 종료와 원 owner의 durable group 종료를 묶은 공식 V2 증거로 요청 한 건만 withdrawn 처리했다(감사20523, event95577). 독립 사후 읽기에서 binding·charged262144·settledNULL 및 업무 실패/후보보류가 유지되고 공유 점유가 사라졌음을 확인했다. 모델 정상 응답이나 사용량 정산을 만든 것이 아니다.

같은 plist/config로 native를 새 PID72251로 복원하고 health GET200을 확인했다. M3/mini gateway와 reviewer도 원 spec/image로 복원했다. 공식 OPEN 복귀 감사20524. 23:13:19 UTC 자연 업무 관측에서 FIRST 최근5분 진행4/AI2진행5, reviewer lane timeout없음을 확인했다. 전체 progress는 기존text 경보로 alarm이다. 기존 미계약 소개 route 하나는 계속 deferred이며 AI2 GPU3090 직접 primary/Supa via abc fallback과 total32k/output10k/no-thinking 설정은 유지한다.

## 재발 방지

`capacity-admission-block.ts`는 현재 OPEN 정책·활성 writer·최근 미만료 waiting과 정확한 route를 대조한다. 그룹/공급자/풀/전체 한도가 실제로 가득 차 있고 해당 job의 대기 경로가 모두 막혔을 때 FIRST/SECOND 단계만 restartEligiblefalse로 표시한다. no_progress 경보·대기량은 유지한다. 실제 실행/폴링 lane timeout, 다른 job, 독립 AI consumer의 정책은 유지한다. 조회 실패나 정책 불일치에 근거 없이 재시작 예외를 만들지 않는다.

배포 때는 신규 모델 접수 DRAINING → 실제 reserved/dispatched 종료를 최대3분 기다리고, 남아 있으면 종료 확인 전 교체를 중단 → 일감 담당 워커 교체 → health/소스 확인 → OPEN 순서가 필요하다. 단순 client abort는 모델 종료 증거가 아니다. indeterminate는 TTL로 지우지 않고 실제 종료 증거를 갖춘 공식 단건 회수 절차를 사용한다. response_only provider의 취소 확인/서버 측 실행기한까지 자동화된 것은 아니며, 이 변경은 점유 대기를 재시작으로 악화시키는 경로를 차단한다.


역할 워커가 자식을 멈춘 이유를 그 판정 자리에서 남긴다. 재시작 조건과 capacity 권한은 바꾸지 않는다. `restartEligible` 계산은 `lib/operations/worker-progress-query.ts`에 있고 이 기록은 그 결과를 그대로 싣는다.

## stdout

`role.progress_stalled`는 15초 표본이 두 번 연속 정체일 때만 난다. `samples`는 2다. `previous`는 첫 표본, `trigger`는 재시작을 결정한 둘째 표본이다. 둘 다 같은 판정(`selectUnexplainedStall`)이다. lane이 있으면 lane이 먼저고, 없으면 scheduler가 `scheduled`일 때 역할 stage 배열에서 처음 걸리는 후보다. FIRST가 그 후보면 `trigger.kind`는 `stage`, `job`은 `crawl-agent-review`다.

각 표본 필드는 `kind`(stage|lane), `reason`, `job`, `lane`, `age`, `wait`, `progress`, `restartEligible`뿐이다. stage의 `age`는 분, `wait`는 대기 건수, `progress`는 최근 진행 건수다. lane의 `age`/`wait`는 ms다. 후보 `role`, `instanceId`, `bootId`, `release`, `epoch`를 함께 남긴다.

`role.supervisor_stopped`는 자식이 끝난 뒤 `exitCode`, `abortReason`, `signal`, `leaseCause`, `drainTimedOut`을 남긴다. `role.supervisor_drain_timeout`은 부모 대기가 실제로 초과한 순간에만 난다. `role.lease_lost`의 `cause`는 `renew_rejected`다. 갱신 실패·watchdog은 `role.renew_unknown`의 `cause`(`role_renew_deadline`, `role_lease_expired`, `renew_failed`)다.

`signal`은 프로세스가 SIGINT 또는 SIGTERM을 받았을 때만 그 값이다. 없는 종료에 신호를 만들지 않고, OOM으로 해석하지 않는다.

supervisor의 `supervisor.stopping`은 받은 신호와 abort 이유, 자식에게 보낸 SIGTERM을 남긴다. `supervisor.force_stop`은 drain 초과로 그룹에 SIGKILL을 보낸 순간이다(`forcedKill`, `drainTimeout`, `drainMs`). `supervisor.stopped`는 감독 종료 코드, 자식 exit code, 자식이 보고한 SIGINT·SIGTERM·SIGKILL, drain 초과 여부를 남긴다. 모르는 abort는 동작상 기존처럼 `role_lease_lost`로 멈추고, `abortReason`은 아는 토큰이 있을 때만 채운다.

## 부트별 관측

stdout만으로는 사라진 Swarm task의 종료 이유를 다시 볼 수 없다. 프로세스의 제어된 종료 직전에 `operations_observations`에 한 행을 쓴다. 키는 `worker-exit:<role>:<boot UUID>`이고 80자 미만이다. boot마다 키가 달라 다음 boot가 이전 종료를 덮지 않는다.

값에는 `why`, `stopReason`, 두 표본, `instanceId`, `bootId`, `release`, `epoch`, `exitCode`, `drainTimedOut`, `signal`, `leaseCause`만 있다. 쓰기는 최대 2초다. 실패하면 `role.exit_record_failed`에 오류 code만 남기고 종료는 계속한다. 프롬프트, 본문, 환경, 토큰, binding, SQL은 넣지 않는다. `recordStop`이 없으면 DB를 부르지 않는다.

제어할 수 없는 SIGKILL·호스트 전원 종료는 프로세스가 마지막 DB 기록을 남길 수 없다. 이 경우 Docker task exit/OOM/die와 host 로그를 함께 확인한다. 로그가 없다는 이유로 종료 원인을 추정하지 않는다.

## 검증 범위

사용자 지시로 수동 테스트·lint·컴파일·빌드와 합성 모델 호출은 실행하지 않았다. 실제 운영 종료/복원/DB readback 및 health GET을 수행했다. 새 코드의 필수 자동 CI와 실제 배포·자연 업무 관측 결과는 CODEX_HANDOFF에 이어 기록한다.


## 이후 종료 원인 확인

현재 실행 컨테이너의 JSON 로그에서 `role.progress_stalled` → `supervisor.stopping` → `role.supervisor_stopped`를 같은 boot/epoch로 연결한다. `trigger`와 `previous`는 실제 재시작 판정에 쓰인 두 표본이다. `forcedKill`은 supervisor의 drain 타이머가 작동한 경우에만 채워지며, 자식 종료 신호와 요청된 종료 신호를 따로 본다.

교체된 역할 프로세스의 마지막 제어된 종료는 다음 읽기로 찾는다. 기록 부재를 정상 종료나 OOM의 증거로 해석하지 않는다.

```sql
SELECT key, observed_at,
       value->>'instanceId' AS instance_id,
       value->>'bootId' AS boot_id,
       value->>'why' AS cause,
       value->>'stopReason' AS stop_reason,
       value->>'exitCode' AS exit_code,
       value->>'signal' AS received_signal,
       value->>'leaseCause' AS lease_cause,
       value->>'drainTimedOut' AS parent_drain_timed_out,
       value->'trigger' AS deciding_sample,
       value->'previous' AS first_sample
FROM operations_observations
WHERE key LIKE 'worker-exit:reviewer:%'
ORDER BY observed_at DESC
LIMIT 20;
```


## 배포 및 마지막 운영 읽기

[PR687](https://github.com/JRVector9/nomorevibe/pull/687), 앱 소스50be0d706b9562067a44867d239d0362bc83892b. PR CI40418372835 전체와 main CI40419359154 필수check/두 image publish 성공을 확인했다. 검증된 tree와 이미지를 재사용해 stock fast deploy scope/plan/run으로18앱 모두 실제 교체했다. 완료23:35:04.133843 UTC, source/image/health와 public gate 통과, 실패0이다.

배포는 공식 DRAIN20526 뒤 unexpiredreserved/dispatched/indeterminate0을 확인한 후 진행했다. 중간에 기존 tagline-ko 오류가 다시 관문을 막아6text잡 계획 일시정지20527–20532를 사용했고, 완료 후 OPEN20533/own6잡재개20534–20539로 모두 원복했다. 오류·lease·cursor·version은 보존했다. 유지보수 상태의 progressok와 OPEN 업무 정상 여부를 구분한다.

23:36:56 실제 DB에서 원8dc withdrawn·releaseevent1·정산NULL·binding/charge보존과 전역indeterminate0을 재확인했다. reviewer 주·예비의 실제4개 수정 파일 SHA가 앱 소스와 같고, 두 CID가 약229초 동일/healthy/restartCount0이다. 23:37:01 실제 progress에서 FIRST4/AI2 3건 진행·lane alarm0이다.

전체 progress는 여전히alarm이다. reason-translate/no_progress, keywords·product-translate·tagline-ko/upstream_stalled는 별도 미해결 업무 경보다. 새 boot의 종료는 발생하지 않아 durable exit 실제 표본은0이며, 저장 성공을 운영에서 관측했다고 쓰지 않는다. 실제6시간/24시간 결과도 아직 없다. 새 observer는23:35:04 시작했고 예약된 미래 표본은 통과 증거가 아니다.
