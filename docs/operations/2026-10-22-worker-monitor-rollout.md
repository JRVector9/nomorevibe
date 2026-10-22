# 2026-10-22 워커 감시·mini/Oracle Push 연결

2026-10-22 **22:55:14 UTC**(10-23 07:55:14 KST)에 mini·Oracle 두 Kuma 수신기의 UP과
별도 M3 monitor의 두 대상 `receipts.ok=true`를 확인했다. Docker healthy의 첫 직접 조회는 **22:55:44 UTC**다.
현재 **16개 Dokploy 앱/21개 컨테이너**이며 Oracle 수신기 컨테이너는 이 수에 포함하지 않는다.
기존 15앱/20컨테이너의 코드 릴리스·migration 이력은 [관리자·보안 배포 기록](2026-10-22-admin-production-rollout.md)에 보존한다.

23:04 UTC까지 mini 예비 중단과 monitor 중단의 두 드릴에서 양쪽 DOWN·복구 UP을 확인했다.
Oracle Telegram은 두 드릴의 DOWN/UP **4건 모두 API 전송 수락**을 확인했다.
수신자 단말의 도착·읽음, mini의 별도 Telegram API 응답, 전체 호스트 장애·실제 저장 정체·반복 부팅 격리·장기 관측은 미검증이다.

## 감시자와 수신기

| 항목 | 실제 연결 |
| --- | --- |
| M3 Dokploy 앱 | `nomorevibe-monitor-m3`, applicationId `WbGj-YxQGHNEoGElyTLBq` |
| Swarm 서비스 | `nomorevibe-monitor-m3-7i7xmc`, 1복제본 |
| 코드 release | `5ba60a1aef1878add561152ef8273b2df87e03d4` |
| 재사용한 worker 이미지 | `ghcr.io/jrvector9/nomorevibe-worker@sha256:425e6ff174aeaf2fc19c322f516ea5fb2c7748509a7a5f40464fe6b4eb78b108` |
| 실행·healthcheck | `scripts/watch-failover-readiness.ts` · `scripts/monitor-healthcheck.ts`, 각각 `node --import tsx` |
| 자원·배포 | pool 1, 512 MiB, 0.5 CPU, `autoDeploy=false` |
| 주 수신기 | mini의 기존 Uptime Kuma 2.3.2, Push monitor ID `72`, Telegram notification ID `1` |
| 외부 수신기 | Oracle `onetwoday`, `ap-osaka-1`의 별도 데이터센터, 전용 Uptime Kuma 2.3.2, Push ID `1`, Telegram notification ID `1` |
| 전송·판정 | 검사·전송 후 30초 대기, 연속 2회 `alarm`/`unknown`이면 DOWN, 정상 회복은 즉시 UP |
| heartbeat timeout | 양쪽 120초 |

운영은 기존 worker 이미지를 재사용하고 명령과 healthcheck를 감시 전용으로 지정했다.
`Dockerfile`의 CLI 없는 `monitor` target은 향후 별도 이미지 빌드 경로이며 이번에 그 target을 빌드했다고 기록하지 않는다.
감시자에는 모델 CLI 인증이나 publisher 연결 자격 정보를 제공하지 않는다.
새 릴리스 때는 monitor의 실제 digest·release도 확인한다. 기존 공통 8앱 교체만으로 감시자까지 갱신됐다고 판단하지 않는다.

Oracle 수신기는 `nomorevibe-uptime-kuma` 컨테이너이며 이미지를 다음 digest로 고정했다.

```text
louislam/uptime-kuma@sha256:9aeb4e51d038047f414309c77a1af553281ca535723cb88907d907269d0a908e
```

SQLite 데이터는 전용 볼륨 `nomorevibe-monitor-kuma-data`에 둔다. 3001은 호스트 loopback에만 바인딩하고,
Tailscale [HTTPS 8443](https://onetwoday.tail02799e.ts.net:8443/)으로 수신한다. 기존 mini Kuma의 설정과 다른 프로젝트 컨테이너를 대체하지 않았다.
현재 수신기가 M3·mini 밖에 있다는 근거는 다른 hostname만이 아니라 Oracle 데이터센터 배치다.

## DB 권한과 네트워크

새 역할 `nomorevibe_monitor_20261022`를 주 DB에 만들었다. 기존 역할이 있으면 생성을 거절하는 절차를 사용했고
오프라인 SCRAM verifier를 전달해 SQL·명령 인자·출력에 평문 비밀번호를 넣지 않았다.
역할은 LOGIN·connection limit 2, 기본 `default_transaction_read_only=on`, `statement_timeout=10s`, UTC다.
DB CONNECT·public USAGE와 아래 25개 표의 SELECT를 허용하고, 역할 플래그·읽기 범위·실제 UPDATE 거절을 확인했다.

```text
role_leases                  operations_observations
crawl_settings               jobs
job_batch_control            agent_scan_control
uptime_split_control         crawl_documents
crawl_frontier               crawl_candidates
crawl_review_attempts        second_reviews
crawl_publication_changes    category_decisions
pipeline_item_leases         products
product_links                product_evidence_sources
agent_repository_scans       repository_ai_levels
agent_repository_claims      uptime_control
uptime_claims                product_health
uptime_host_breakers
```

뒤의 5개는 agent-scan/uptime 모드에 따라 읽는 표이며 현재는 모두 존재해 25개를 검증했다.
일반 앱 계정을 복사하거나 PUBLIC의 권한을 바꾸지 않았다. 감시자는 Tailscale 경로의 PostgreSQL 직접 5432를 사용한다.
`DATABASE_URL`이 전용 SELECT 계정을 가리키며, `READ_DATABASE_URL`을 대신 사용하는 경로가 아니다.

Push URL은 `MONITOR_PUSH_URL`과 `MONITOR_EXTERNAL_PUSH_URL`에만 주입했다. 신규 monitor 앱에만
Dokploy `mounts.create`로 `/etc/resolv.conf`를 지정해 nameserver `100.100.100.100`을 사용했다.
기존 호스트와 서비스의 DNS는 변경하지 않았다.

## 확인한 동작과 로그의 의미

- 22:55:14 UTC에 같은 watcher의 `primary`·`external` 양쪽 전송 성공과 UP을 확인했고, 22:55:44 UTC에 Docker healthy를 직접 조회했다.
- 각 수신기로 동시에 요청하며, 한 수신기의 실패가 다른 수신기 요청을 막지 않는다. 요청별 제한은 5초다.
- Push URL·토큰·비밀번호·Telegram 설정 본문을 저장소나 로그에 남기지 않는다.
  `monitor.push`에는 대상 이름·성공 여부·시각만 남긴다. 이 문서에도 실제 비밀 URL을 기록하지 않는다.
- healthcheck는 최근 90초 이내 검사 완료를 뜻한다. DB 판정이 `unknown`이거나 Push 전송이 실패해도
  검사 루프가 계속 돌면 컨테이너는 healthy일 수 있다. 수신·알림은 `receipts`·Kuma heartbeat·실제 도착으로 따로 검증한다.
- 이번 작업으로 화면 검수 **틱당 1건**, 보류 기준 **0.95**, 918건 실제 일괄 미적용 상태를 바꾸지 않았다.

23:05:27 UTC에 다섯 역할 ready·진행 ok와 화면 검수 `enabled=true`, `perTick=1`, `autoClose=true`,
보류 기준 `0.95`를 다시 확인했다.

## 장애 드릴 결과

두 드릴은 실제 시각과 원복 결과로 확인했다. 초기 연결의 UP과 드릴에서 확인한 DOWN·복구 UP을 구분한다.

mini maintenance 예비를 중단하기 전에 lease owner가 M3 주인 것을 확인했다. 중단 요청은
22:58:44.915 UTC, 중단 완료는 22:59:15.258 UTC였다. mini Kuma는 23:00:30.077 UTC,
Oracle Kuma는 23:00:31.197 UTC에 DOWN을 기록했다. 23:00:40.128 UTC에 예비 복구를 요청했고,
mini는 23:01:03.579 UTC, Oracle은 23:01:03.694 UTC에 UP으로 회복했다.
start API 완료는 23:01:17.767 UTC, 원본 env·이미지·명령·복제본·autoDeploy 일치 확인은 23:01:20.320 UTC다.
읽기 전용 재확인에서 maintenance owner는 `m3-maintenance`였고 전체 정상 UP이었다.

Oracle의 Telegram 전송 audit은 DOWN 23:00:32.192 UTC와 회복 23:01:04.670 UTC에
HTTP 2xx·응답 `ok=true`·`message_id` 존재를 확인했다.
ID 값·메시지 본문은 기록하지 않았다. 이는 Telegram 서버의 전송 수락 증거이며 수신자 단말의 도착·읽음 확인은 아니다.

monitor의 heartbeat 중단은 23:01:50.103 UTC에 요청했고 23:02:20.733 UTC에 중단 완료를 확인했다.
마지막 Push는 mini 23:01:36.067 UTC, Oracle 23:01:36.185 UTC였다. 두 수신기는 각각
**121초** 뒤인 23:03:37.070 UTC와 23:03:37.187 UTC에 timeout DOWN을 기록했다.
23:03:45.859 UTC에 monitor 재시작을 요청했고 mini 23:03:51.165 UTC, Oracle 23:03:51.294 UTC에 UP으로 회복했다.
start API 완료는 23:04:21.903 UTC였고, 23:04:24.474 UTC에 원본 설정 일치를 확인했다.

| Oracle Telegram 전송 | API 수락 UTC |
| --- | --- |
| mini maintenance 중단 DOWN | 23:00:32.192 |
| mini maintenance 복구 UP | 23:01:04.670 |
| monitor heartbeat timeout DOWN | 23:03:38.151 |
| monitor 재시작 UP | 23:03:52.280 |

네 건 모두 HTTP 2xx·`ok=true`·message ID 존재를 확인했다. 단말 읽음이나 mini의 개별 Telegram API 응답을 확인한 것으로 확대하지 않는다.

| 항목 | 현재 결과 | 추가로 남길 근거 |
| --- | --- | --- |
| 워커 이상 DOWN·회복 UP | mini maintenance 중단의 양쪽 DOWN·복구 UP, 원본 설정·M3 lease 복귀 확인 | 위 시각·원복 결과 |
| monitor 중단의 heartbeat timeout | 양쪽 마지막 Push 121초 뒤 timeout DOWN·재시작 UP, 원본 설정 복귀 확인 | 위 시각·원복 결과 |
| Telegram DOWN·회복 전송 | Oracle에서 두 드릴 DOWN/UP 4건의 API 수락 확인 | mini 개별 API 응답·수신자 단말 도착/읽음은 미확인 |
| 알림 전송 audit preload | Oracle에만 읽기 전용 bind·Node `--require` 배포, 저장소 파일과 hash 정렬 완료 | 아래 최종 hash·15개 테스트 통과 |
| Oracle 관리자 자격 정보 보관 | `/home/ubuntu/.config/nomorevibe-monitor/kuma-admin.json`, mode600 저장 확인 | 내용은 기록하지 않음 |

최종 Oracle audit 파일은 `scripts/ops/kuma-delivery-audit.cjs`와 정렬했으며 SHA-256은
`f3e923401700180b1a6abb1a2de13e41fd95ec44fd5d12af9b59fb54ff40850f`다.
실행 중 메모리에 적재된 파일과의 차이는 ESLint 주석 한 줄뿐이며 실행 동작은 같다.
관련 테스트 15개가 통과했고 Node 22·24 호환성을 검토했다.

전체 호스트 장애, 장기 관측, 실제 저장 정체·반복 부팅 격리를 이번 드릴로 검증한 것으로 기록하지 않는다.
배포나 정상 인계 중 두 표본 이상 경보가 이어질 수 있으므로 의도한 전환과 실제 장애를 시각·역할 상태로 구분한다.

## 운영 인계

현재 감시자는 M3에서 한 번 실행하고, mini와 Oracle이 각각 Push가 끊기는지 확인한다.
monitor가 중단되면 외부 수신기의 timeout이 이를 알려야 하므로 양쪽 수신기를 함께 유지한다.
외부 수신기를 제거하고 mini만 남기면 mini 전체 장애 때 알림 경로도 사라진다.
monitor를 systemd로 옮긴다면 상주 서비스로 실행한다. timer/oneshot으로 매번 새로 띄우면
`badSamples`가 초기화되어 현재의 연속 두 표본 판정이 유지되지 않는다.

추가 배포·복구 절차와 코드 의미는 [독립 워커 운영 절차](independent-workers-runbook.md#독립-failover-감시)를 따른다.
감시자·Kuma의 환경 전체, 관리자 비밀번호 파일, Push URL과 Telegram config는 출력하거나 커밋하지 않는다.

기존 15앱의 런타임은 `5ba60a1a`를 유지한다. 감시 관련 PR을 병합할 때는 의도치 않은 자동 배포를 막기 위해
connect-agent·agent-scan 두 앱의 `autoDeploy`를 잠시 false로 두고, main CI 이미지 발행이 끝난 뒤
원래 값 true로 복원하고 직접 조회한다. 다른 앱의 false는 유지한다.
