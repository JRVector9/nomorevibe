# Oracle 독립 감시와 자동복구

2026-10-25 구현·검증 진행 기록이다. 현재 목표 전체의 완료 증거는 아니다. 앱 운영 릴리스는 아직 be71이며 새 Node/liveness/번역·items 감시는 배포 전이다.

## 배치와 권한

Oracle `onetwoday`의 `nomorevibe-oracle-watchdog.service`가 M3 11앱·mini 6앱을 약30초 간격으로 관찰한다. 설정 `/etc/nomorevibe-watchdog/config.json`, key/known_hosts는 같은 디렉터리, 상태는 `/var/lib/nomorevibe-watchdog/state.json`이다. 설정·key·상태는0600이며 로그에는 상태 코드와 고정 앱 이름만 남는다. 원본 환경·Push URL·Kuma 비밀번호를 출력하지 않는다.

M3/mini에는 tailnet IPv4:22222의 별도 native OpenSSH launchd `com.nomorevibe.recovery-sshd`를 둔다. Tailscale SSH :22는 authorized_keys의 forced command를 거치지 않으므로 복구 키 경로에 사용하지 않는다. 전용 listener는 jr/publickey-only·Oracle tailnet IP from 제한·ForceCommand·forward/TTY 금지다. 실제 host key를 신뢰된 기존 관리 연결로 읽어 Oracle known_hosts에 고정한다. 설정 예시는 `scripts/ops/recovery-sshd.conf.example`이다.

Gateway 소스는 `/usr/local/libexec/nomorevibe-recovery/gateway.py`, root-owned allowlist는 `/usr/local/etc/nomorevibe-recovery.json`이다. 일반 authorized_keys·기존 SSH·Dokploy·앱 source/env/replicas를 재설정하지 않는다. gate 상태만 jr의 `.local/state/nomorevibe-recovery/`에0600으로 쓴다.

Oracle에는 Dokploy/DB/모델 자격을 전달하지 않는다. 공개·DB·모델의 전역 장애 경보를 앱 재시작 권한과 혼동하지 않는다. 현재 자동복구 설정은 **recover=true**다. Oracle pipeline2/heartbeat3과 mini pipeline73/heartbeat74를 별도로 활성화했으며 네 Push ACK를 확인했다. 두 신호가 같은 endpoint를 공유하면 설정을 거절한다. 기존 M3 worker Push monitor1을 덮지 않는다. 현재 live 수신/알림 및 활성화 결과는 `docs/CODEX_HANDOFF.md`를 우선 확인한다.

## 복구 판정

- 같은 버전·같은 복구 원인3개가150초 이내 간격으로 연속 관측되어야 요청한다. 경보는2개 표본이다.
- 웹: 모든 replica의 직접 `/api/health` 준비 상태가정상인데 홈페이지 GET이 실패할 때. DB unavailable은 경보만 낸다. 운영 바인딩에 맞춰 컨테이너 env.HOSTNAME을 사용한다.
- 읽기 전용 monitor: 로컬 heartbeat가90초 이상 오래됐거나 사라졌을 때. 최근 heartbeat의 pipeline alarm 자체로 재시작하지 않는다.
- gateway가 의도한 replica 수·배포 완료·3분 안정화·현재 실패와 version을 다시 확인한다. Docker Engine API version CAS로 `TaskTemplate.ForceUpdate`만1늘리고 기존 spec/registryAuth/rollout/종료 grace를 보존한다. 동시에 배포가 일어나면 거절한다.
- Oracle/gateway 양쪽이 요청 전에 상태에 예약한다. 응답을 잃어도 재요청하지 않는다. 앱별15분 cooldown·24시간2회 상한이며 재부팅 후에도 유지한다. 손상·미래·NaN 이력은 새 예산을 열지 않는다.
- 모델 worker·DB·role lease·policy/hold·replica0·stopped/deploying/불확실한 상태는 gateway가 복구하지 않는다. 기존 fenced supervisor/Swarm이 담당한다. 실제 host/DB disaster readiness는 별도다.

## AI 1차·2차 정체 진단 (2026-10-28 소스 보완)

프로세스가 `healthy`여도 검수가 진행된다는 뜻은 아니다. monitor heartbeat의 `reviewFailures`는 AI 1차(`first`)·2차(`second`)의 실제 진행 경보를 SSH gateway로 전달한다. Oracle은 같은 단계·사유를 150초 이내 간격으로 두 번 관측하면 기존 aggregate DOWN과 별도로 장애를 알린다. stage·reason 고정 값만 전달하며 요청 ID·모델명·본문·자격은 전달하지 않는다. text 공급자 오류의 기존 30분 관측과 별개다.

| 사유 | 의미와 복구 주체 |
| --- | --- |
| `capacity_blocked` | 실행 대기가 현재 공유 용량에 막혔다. 원격 생성 종료 확인과 정규 장부 회수가 필요하다. reviewer 재시작은 점유를 풀지 않는다. 이 신호만으로 종료 미확정이라고 단정하지 않는다. |
| `local_stalled` | 해당 단계의 `restartEligible=true`인 로컬 정체다. 기존 역할 supervisor가 임대·실행 작업·연속 표본을 다시 확인해 복구한다. Oracle은 같은 장애를 무한 재시작하지 않는다. |
| `consumer_missing`·`worker_missing` | 독립 consumer/워커 관측 부재다. Swarm/systemd와 운영자 확인 대상이며 legacy reviewer 재시작으로 대체하지 않는다. |
| `upstream_stalled`·`review_stalled` | 공급자 오류 또는 자동 재시작 조건이 없는 정체다. 운영자 확인이 필요하며 공유 모델 강제 종료 권한을 주지 않는다. |

관측을 읽지 못했거나 구버전 heartbeat에 필드가 없으면 미확인으로 보존한다. 명시적 `reviewFailures=[]` 또는 사유 교체만 해당 알림을 해제하며 다른 단계의 장애와 기존 pipeline 경보는 유지한다. Oracle 관측 상태와 notification receipt는 재시작 뒤에도 보존한다. 복구 요청의 앱별 cooldown·상한과 allowlist에는 변화가 없다.

적용 순서는 **Oracle watchdog·incident notifier → M3/mini SSH gateway → monitor 앱**이다. 새 gateway의 선택 필드를 구버전 Oracle validator가 거절하므로 이 순서를 지킨다. 기존 state/config/key를 지우거나 수동 `--once`를 중복 실행하지 않는다. 이 절은 소스 계약이며 실제 설치·알림·복구 완료는 운영 영수증으로 별도 확인한다.

## 모델 장부 '확인 못함'은 경보가 아니다 (2026-10-31)

소유자 결정(2026-10-30): 결과를 모르는 모델 호출(`indeterminate`)은 일을 멈추지 않고 `/admin/models`의 「확인 못함 — 사람 검토」 목록으로만 간다.
monitor heartbeat의 `capacityUnknowns`는 다음 뜻이다.

| status | 뜻 | monitor overall·Kuma | gateway 행 | Oracle |
| --- | --- | --- | --- | --- |
| `ok` | 검토 행 0, 기한 넘긴 보낸 호출 0 | 영향 없음 | 영향 없음 | 지움 |
| `review` | 검토 행이 있다(점유 아님) | 영향 없음 — UP 메시지에 `capacity review N (oldest …)`만 붙음 | monitor 자신의 overall대로 | 로그 이벤트 `model_review_pending`만, 알림 없음 |
| `alarm`(검토 문턱만) | `alarmReasons`가 `review_backlog`·`review_stale`뿐이고 `stuckDispatched` 0 | 영향 없음(2026-11-10) — UP, 메시지 `검토 대기 N건(가장 오래된 H시간) — 사람 검토 필요 (사유)`, `check-failover-readiness` 출력·watcher 주기 로그에 `warnings: ["capacity_review"]` | monitor 자신의 overall대로 | 경보·DOWN 아님. 사유별 Telegram 알림 한 건은 그대로(600초 연속 해제 규칙 같음) |
| `alarm` | `dispatch_stuck`이 있는 문턱 초과(`alarmReasons`) | `alarm` → 2표본 뒤 DOWN | `pipeline_alarm` | 사유별 장애 `<host>/<service>/capacity/<reason>` 한 건, 명시적 비경보 관측 600초 연속 뒤 해제 |
| `unknown` | 장부를 읽지 못함 | `unknown` | `pipeline_alarm` | 경보, 이전 검토 목록을 지우지 않음 |

**재시작 직후 알림 유예(2026-11-10, 운영자: 「문제나 장애일 때만 받고 싶다」).** 하루 Telegram 48건 중 46건이 배포 때 앱이 다시 뜨는
`warming_up`(컨테이너 시작 180초 이내)이었다. Oracle watchdog 은 대상마다 끊김 없는 고장의 시작(`faultSince`)과 마지막 재시작(`restartedAt`,
`warming_up` 관측 시각)을 상태에 두고 사건에 `faultSeconds`·`restartSeconds` 로 넘긴다. 알림은 `warming_up` 을 늘, `replicas_missing`·
`web_not_ready`·`pipeline_alarm` 은 10분 안에 재시작이 있었을 때만 「재시작 직후의 잠깐 고장」으로 보고, 고장이 끊김 없이 600초 넘게 이어질 때만
보낸다(크래시 루프·재시작 뒤 멈춤). 판 번호가 바뀌어도(배포) 이어진 고장은 이어진 것으로 잰다. 그 밖의 사유와 시각 없는 옛 사건은 예전처럼
두 번째 관측에서 알린다. 복구 판단(`bad`·`actionable`)은 바뀌지 않았다.
monitor 의 `pipeline_alarm` 은 함대 전체의 진행을 보므로 그 사건의 `restartSeconds` 는 monitor 자신이 아니라 모든 대상 중 가장 최근 재시작이다
(2026-11-10 10:28Z: 배포 창에서 text·maintenance 가 다시 뜨는 동안 monitor 재시작 전 진행 경보가 알림이 됐다). DRAIN 만 걸고 아직 아무 앱도 다시 뜨지 않은
때의 진행 경보는 이 재시작 유예가 아니라 아래 DRAIN 유예가 맡는다. 메시지 머리는 `NoMoreVibe 장애 알림`, 줄마다 사유 코드 뒤에 한국어 설명이 붙는다
(`scripts/ops/incident_notifications.py` `SERVICE_TEXT`).

**배포 창 DRAIN 동안의 진행 경보 유예(2026-11-11, 운영자: 「배포 동안은 단계 멈춤 알람을 붙잡아 두자」).** 배포 창은 T+0 에 모델 접수를
DRAINING 으로 두고 잡 ~10개를 멈추며 첫 앱 재시작은 2~3분 뒤다. 그 사이의 `pipeline_alarm` 은 재시작 유예를 받지 못했다(03:52:50Z
`m3/monitor-m3 pipeline_alarm`, `faultSeconds` 35·`restartSeconds` 3880 — DRAIN 03:48:59Z, 마지막 재시작은 65분 전 배포). 하루 여섯 창마다 났다.

- 신호: monitor 가 주기마다 `model_capacity_control`(id=1)의 `mode` 와 `updated_at` 나이를 DB 시계로 읽어 heartbeat 에 `capacityMode: {mode, changedAt}`
  (monitor 컨테이너 시계 epoch ms)로 남긴다. gateway `MONITOR_PROBE` 가 같은 컨테이너 시계로 `{mode, ageSeconds}` 로 바꾸고, 모든 신선한 replica 가
  같은 모드일 때만 행에 붙인다(나이는 가장 오래된 쪽). 행의 `ok`·`reason`·`recoverable`·overall 은 바뀌지 않는다 — monitor overall·Kuma Push·배포 관문·
  운영 홈은 지금처럼 경보를 본다. Oracle 에는 DB 자격을 주지 않는다.
- DRAIN 시계(Oracle `observe_drain`, 상태 `targets[<monitor>].drain = {since, seen}`): 처음 본 DRAIN 의 시작 = 보고 나이와 자기 관측 중 이른 쪽.
  `updated_at` 은 정책 쓰기에도 바뀌므로 같은 창 안의 정책 쓰기나 OPEN↔DRAIN 되풀이는 시계를 다시 시작하지 않는다. DRAIN 을 마지막으로 본 지
  `DRAIN_CONTINUITY_SECONDS`(600초)가 지나야 다음 DRAIN 을 새 창으로 본다. 칸이 빠진 표본(monitor 재시작·읽기 실패)은 마지막 DRAIN 관측
  `DRAIN_CARRY_SECONDS`(150초) 안에서만 DRAIN 으로 이어 본다. 사건에 `drainSeconds` 로 넘긴다.
- 유예(`incident_notifications.drain_hold`): `pipeline_alarm` 이고 `drainSeconds`·`faultSeconds` 가 모두 `DRAIN_HOLD_SECONDS`(**1200초 = 20분**,
  보통 창 15분 안팎)보다 짧을 때만 알림을 만들지 않는다. DRAIN 이 20분을 넘기면(멈춘 DRAIN — 감시가 처음 보는 DRAIN 이어도 보고 나이로 잰다)
  또는 경보가 끊김 없이 20분 이어지면 예전 문구 그대로 알린다. 모드가 `open`·`disabled` 이거나 칸이 없으면(옛 monitor·gateway·watchdog) 예전대로
  두 번째 관측에서 알린다. 재시작 유예와 둘 중 하나라도 맞으면 유예다.
- 바뀌지 않는 것: `pipeline_alarm` 밖의 사유(웹·복제본·DB·`monitor_stale` 등), 단계별 `progress-*`·AI 1차·2차·공급자 30분·장부(`capacity/*`) 알림,
  Oracle Kuma DOWN·복구 판단. DR fence 가 접수를 DRAINING 으로 두는 때와 운영 요청 실행기(ops-runner)의 DRAIN 에도 같은 20분 유예가 걸린다.
- 확인할 것: monitor 읽기 역할이 `updated_at` 을 읽을 수 있어야 한다(읽지 못하면 칸이 빠지고 유예 없이 예전대로다). watcher 주기 로그에
  `"capacityMode":"open"` 이 찍히는지, 또는 `SELECT has_column_privilege('nomorevibe_monitor_20261022', 'public.model_capacity_control', 'updated_at', 'SELECT');`.
- 적용 순서는 아래와 같다(Oracle 세 파일 → M3/mini gateway → monitor 앱). 새 `oracle_watchdog.py` 는 Oracle 의 `recovery_gateway.py` 에서
  `valid_capacity_mode` 를 가져오므로 Oracle 세 파일은 함께 바꾼다. 새 gateway 는 새 monitor 가 칸을 쓸 때만 `capacityMode` 를 보내는데, 구 Oracle
  validator 는 그 행을 거절해 호스트 전체가 `probe_unknown` 이 된다. 새 monitor + 구 gateway 는 칸을 버린다(지금과 같다).

**운영 홈 할 일의 휴대폰 알림(2026-11-12 운영 콘솔 개편 조각 4b).** 홈 할 일 중 멈춤·평소와 다름이 새로 생기면 이 Telegram 통로로 한 번 보낸다.

- 앱: maintenance 잡 `console-alerts`(5분)가 홈과 같은 규칙(`lib/operations/console-tasks.ts`)으로 할 일을 세어 알림 줄(`console_alerts`, 마이그레이션 0183)을
  열고·이어 쓰고·닫는다. 10분 넘게 안 보이면 닫고, 다시 생기면 새 줄이다. 「그대로 둔다」로 표시한 할 일과 접수 중단 30분 전의 접힌 줄은 열지 않는다.
  켜기·끄기와 조용한 시간(KST)은 관리자 「홈 › 알림」(`/admin/alerts`)에서 저장하고(작업 로그 `console-alert-settings`), **기본은 꺼짐**이다.
- monitor: 주기마다 닫히지 않았고 내보낸 줄(최대 8줄 — 제목 80·사실 160·경로 200자)을 heartbeat 에 `consoleAlerts: [{id, title, fact, href}]` 로 적는다.
  읽지 못하면 칸이 없다. gateway `MONITOR_PROBE` 는 모양(관리자 경로 `/admin…` 만, 제어·방향 글자 없음)을 검사하고 모든 신선한 replica 가 같을 때만
  행에 붙인다. 행의 `ok`·`reason`·`recoverable` 은 바뀌지 않는다.
- Oracle: `incident_notifications` 가 줄 id(`host/service/id`)마다 한 번 `NoMoreVibe 할 일 알림` 으로 보낸다(제목 · 사실 한 줄 · 링크). 보고에서 줄이
  사라지면 표시를 지우고, 칸이 없는 보고(옛 monitor·읽기 실패·호스트 못 읽음)는 모름으로 두어 표시를 지우지 않는다. 상태 파일에는 열쇠와 보냄 표시만 둔다.
  링크 앞의 사이트 주소는 config 의 선택 키 `adminOrigin`(예: `"https://nomorevibe.com"` — https, 경로 없음)이 붙인다. 없으면 경로만 보낸다.
- 켜는 순서: ① 마이그레이션 0183 ② monitor 읽기 역할에 `GRANT SELECT ON TABLE public.console_alerts TO nomorevibe_monitor_20261022;`
  ③ **Oracle 세 파일(`oracle_watchdog.py`·`incident_notifications.py`·`recovery_gateway.py`)과 config `adminOrigin`** → ④ M3/mini SSH gateway(`recovery_gateway.py`)
  → ⑤ scheduler(새 카탈로그 잡 `console-alerts`) → maintenance·monitor 앱 → ⑥ `/admin/alerts` 에서 켜기. 구 Oracle validator 는 `consoleAlerts` 가 붙은
  행을 거절해 그 호스트 전체가 `probe_unknown` 이 되므로 Oracle 이 gateway 보다 먼저다. 새 monitor + 구 gateway 는 칸을 버린다(지금과 같다).
- 바뀌지 않는 것: 장애 알림(`NoMoreVibe 장애 알림`)의 사유·유예·해제 규칙, Kuma Push·복구 판단. 같은 멈춤이 `pipeline_alarm`(장애 알림)과 할 일 알림으로
  두 번 올 수 있다 — 장애 알림은 워커 진행 관측, 할 일 알림은 홈 규칙(1시간 처리가 대기의 10분의 1 미만 등)이다.

2026-11-10 소유자 결정: 검토 행은 아무것도 막지 않으므로 검토 문턱만 넘은 장부로 monitor를 DOWN으로 만들지 않는다(11-09 배포 창이
indeterminate 35건·가장 오래된 41시간의 `review_stale` 때문에 `monitor_push_state_not_up`으로 멈췄다). 문턱 값은 그대로이고,
`capacityUnknowns`의 `status: alarm`·`alarmReasons`도 그대로 보고한다. 같은 규칙이 TS `capacityReviewOnlyAlarm`과
Python `recovery_gateway.capacity_review_only`에 있다. 다른 경보·unknown과 겹치면 지금처럼 DOWN이다.

`alarm` 사유와 기본 문턱(monitor 앱 env, 양의 정수만, 틀리면 기본값; 시작 로그 `monitor.configured.capacityThresholds`에 실제 값):

- `review_backlog`: 검토 행이 `MONITOR_CAPACITY_REVIEW_MAX_ROWS`(기본 **50**)보다 많다. 이 사유와 `review_stale`만 있으면 위의 「검토 문턱만」 줄이다.
- `review_stale`: 가장 오래된 검토 행(전송 시각, 없으면 접수 시각)이 `MONITOR_CAPACITY_REVIEW_MAX_AGE_SECONDS`(기본 **86400** = 24시간)보다 오래됐다.
- `dispatch_stuck`: 보낸 호출(`dispatched`, 슬롯을 실제로 점유)이 `MONITOR_CAPACITY_DISPATCH_STUCK_SECONDS`(기본 **1800** = 30분, 가장 긴 기본 호출 상한 300초의 6배)보다 오래 남았다 — 워커가 죽어 표식 없이 남은 전송 등 실제로 슬롯을 막는 상태.

요약 필드(`count`·`oldestAgeSeconds`·`stuckDispatched`·`alarmReasons`)는 `unknown`이 아닐 때 항상 붙는다. 요약 없는 예전 `alarm`(2026-10-31 전 monitor)은 "검토 대기"였으므로 gateway·Oracle은 `review`로 읽는다.
요청별 장애(`<requestId>/model_indeterminate`, 5분 `model_reclaim_overdue`)와 Oracle의 요청별 첫 관측 시계(`capacitySeen`)는 없앴다 — 새 watchdog이 상태를 처음 읽을 때 저장된 요청별 장애는 버린다.

적용 순서는 위와 같다: **Oracle watchdog·incident notifier(`oracle_watchdog.py`·`incident_notifications.py`·Oracle에 함께 설치된 `recovery_gateway.py`) → M3/mini SSH gateway(`recovery_gateway.py`) → monitor 앱**.
새 gateway가 내는 `review`·요약 필드를 구버전 Oracle validator가 거절하므로 Oracle이 먼저다. 새 Oracle은 구 gateway·구 monitor의 형식을 받는다.
monitor만 먼저 배포되면 구 gateway가 `review`를 `unknown`으로 읽어 지금처럼 검토 행이 있을 때 `pipeline_alarm`이 난다(지금보다 나빠지지 않음).

2026-11-10 「검토 문턱만」 규칙도 같은 순서다. 새 gateway는 검토 문턱만 넘은 장부에서 행을 `ok`로 보내는데, 구 Oracle validator는
그 행을 `invalid_capacity_recovery_claim`으로 거절해 그 호스트 전체가 `probe_unknown`이 된다. 그래서 Oracle 세 파일을 먼저 바꾸고 gateway를 바꾼다.
monitor 앱은 언제 배포해도 된다 — 새 monitor + 구 gateway·구 Oracle에서는 monitor Push만 UP이고 Oracle은 지금처럼 DOWN이다.
`native_recovery_gateway.py`는 `recovery_gateway.py`에서 `bounded_output`·`save`만 써서 동작이 바뀌지 않는다.

## 장애별 현재 검증 범위

| 장애 | 자동 동작 | 현재 근거 / 남은 일 |
| --- | --- | --- |
| 웹 프로세스 종료 | 기존 Swarm any/unlimited 재생성 | 양 운영 서비스 restart policy 확인. 새 릴리스에서 실제 드릴 남음 |
| DB 일시 불통 | 새 `/api/live`는 DB와 분리, readiness503·기존 DB 재연결 | unit/readonly 경계 검증. 새 image 배포·실제 일시불통 드릴 남음 |
| Valkey 설정/접속 예외 | 캐시 실패를 흡수하고 정상 DB 경로 사용 | 동기 client/set 예외 RED→GREEN |
| 악성 HTTP 응답/과도 압축 | 패치된 Undici에서 caught failure/정규 retry | 기존 Node 종료 재현→패치 transport/monitor child 회귀 통과 |
| 역할 선출 응답 무한 대기 |5분 한도 뒤 boot 종료1·불확실 선출 재요청 금지 | fake-timer resolve/reject 및 기존 supervisor 회귀 |
| 번역/소개 검토 정체 |7개 개별 queue를 경보, canonical retry/hold/시도 소진 유지 | 실제 PG9개 및SELECT-only/write거절. 운영 SELECT grant12표·쿼리 비용·배포 남음 |
| AI items 정체/consumer 누락 | 독립 consumer lane 경보, legacy reviewer 재시작 배제 | legacy/items/draining unit·실PG 회귀. 실제 mode/반복 부팅 원인·수정 후 관측 남음 |
| 홈페이지500/monitor hang | 위 제한으로 same-spec rolling recovery | Python/Node/CAS 계약42개. 격리 실제Engine29.5.2의180초gate·CAS·task교체·홈500→200·ACK유실중복제한 통과; 실제운영홈500주입은 미실행 |
| Oracle watchdog 프로세스 종료 | systemd Restart=always·Kuma deadman | 실제SIGKILL→systemd복귀, 양Kuma heartbeat timeoutDOWN→재시작UP 및 OracleTelegram 두API수락 확인 |
| 한 receiver 실패 | 원래 M3 watcher는 독립 두 Kuma에 동시 전송 | 양pipeline·양heartbeat ACK와 실제두receiver deadman DOWN→UP 확인. mini tailnetHTTPS8443 추가 |
| 전체 호스트/DB 영구 장애 | 기존 standby/재연결 범위, 준비된 DR fence 필요 | 최신 릴리스에서 host 인계·M3/mini 동시 단절·Oracle DB DR/독립 모델·복귀는 완료로 주장하지 않음 |

## 관찰과 변경

```sh
ssh onetwoday 'sudo systemctl show nomorevibe-oracle-watchdog.service -p ActiveState -p SubState -p MainPID -p NRestarts -p MemoryCurrent'
ssh onetwoday 'sudo journalctl -u nomorevibe-oracle-watchdog.service -n 3 --no-pager -o cat'
ssh onetwoday 'sudo ssh -F /dev/null -p 22222 -o BatchMode=yes -o ConnectTimeout=8 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/nomorevibe-watchdog/known_hosts -i /etc/nomorevibe-watchdog/gateway_ed25519 jr@100.92.77.66 probe'
```

로그의 `receipts=true`는 Push ACK이며 Telegram API의 전송 수락·수신자 단말 도착과 별개다. Kuma delivery audit에서 해당 monitor ID의 `apiAccepted/receiptPresent`와 시각을 대조한다. recover를 전환할 때 비밀 설정을 화면에 표시하지 않고 원본과 변경할 필드만 읽어 확인한다. 상한 상태를 삭제해 같은 장애를 무제한 재시도하지 않는다.

복구기 소스는 테스트·hash 대조 후 한 번 갱신한다. 관측 이력과 attempts를 보존하며 기존 watchdog를 중복 시작하지 않는다. systemd와 `--once`는 같은 파일 lock을 사용한다. 결과가 불확실한 복구 요청은 반복하지 않고 gateway 결과·Docker version/spec/task/HTTP를 읽어 확인한다.

## 회귀검사

```sh
python3 -B -m unittest discover -s tests -p 'test_recovery*.py'
python3 -B -m unittest discover -s tests -p 'test_oracle_watchdog*.py'
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:32784/nomorevibe_test npm run test:integration -- tests/integration/text-stage-progress.test.ts tests/integration/review-stage-progress.test.ts
npx vitest run tests/failover-monitor.test.ts tests/monitor-heartbeat.test.ts
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:32784/nomorevibe_test npm run test:integration -- tests/integration/monitor-capacity-mode.test.ts
```

전 페이지 측정·개선은 `2026-10-25-page-reliability-audit.md`, 보안 점검은 `2026-10-25-security-reliability-audit.md`, 최신 실행 상태와 다음 명령은 `docs/CODEX_HANDOFF.md`를 참조한다.
