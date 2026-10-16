# PR10 — 비활성 versioned job 배치와 3 host 선출

> 구현 모델 gpt-6.1-sol/xhigh. 2026-10-16. base 37f0542b. 실제 운영 활성화/SSH/provider 호출 없음.

## 목표와 보존 계약

기본 `JOB_ROLES` 5개와 기존 catalog/producer/scheduler 주기를 보존한다. additive migration 0082가 singleton 배치 상태를 `legacy`, epoch1, contract0으로 만든다. 명시 계약이 설치된 fixture에서만 legacy→draining→versioned 전환을 검증한다. 운영 설정/권한/canary는 채우지 않는다.

versioned 배치는 translation(`reason-translate`, `product-tagline-ko`, `product-translate`만), product-health(`uptime-ping`), official-news(`news-refresh`), site-evidence(별도 canonical-source handler 필요)를 기존 다섯 역할에서 분리한다. product-evidence-refresh 전체를 canonical의 별칭으로 사용하지 않는다. 미설치 source adapter는 실행 불가이며 준비도로 올리지 않는다. 모델/품질/paused job/X 서비스/API gate 변경 없음.

## 읽기 근거와 충돌 inventory

- catalog 현재 5역할 정적 배치; worker main은 정적 lanes, control pending도 정적 목록.
- role-leader의 기존 primary/standby는 45초 lease와 20초 standby grace, takeover/release에서 job token 강제 초기화. 기존 기본 의미는 유지하되 새 versioned 경로는 live job/item token을 건드리지 않는다.
- runner의 기존 role 검사와 claim TX에는 batch admission이 없어 역할 catalog만 바꾸면 direct/이전 worker가 계속 claim할 수 있었다. root가 PR07c의 동결 runner를 이 WT로 순차 전달하고 runner/control의 좁은 배치 접점 소유권을 승인했다. claim TX 첫 batch SHARE 검사, role-job membership 위임, pending/active 목록의 batch-aware 조회만 추가하고 PR07c의 HTTP deferred 보존 동작은 유지한다.
- supervisor/worker/role-worker/worker-healthcheck는 새 역할 CLI·IPC·pool 분기를 추가해야 한다. scheduler는 producer이므로 단일 기존 due catalog를 그대로 사용한다.
- operations failover-readiness는 m3-primary/mini-standby 설치/heartbeat 판정이다. versioned strict readiness를 별도 API로 제공하고 기존 보고서를 실제 3host 준비 완료로 재해석하지 않는다.
- PR08 source adapter, PR09 health observation gate는 다른 WT 소유. registry 또는 source handler 공유 접점은 root 순차 통합. AGENTS/handoff/공통 진행 문서/Git은 root 소유.

## 최소 설계

1. `lib/jobs/batches.ts`: strict version1 policy, fixed host enum m3/mini/oracle-osaka-smoke, 고정 job→role mapping, 역할별 host 선호순위. 기존 role은 legacy 타입을 유지하고 별도 BatchRole을 사용한다. Oracle 역할 Oracle→M3→mini, crawler는 mini→M3→Oracle(원본 수집), reviewer/publisher/text/maintenance는 M3→mini→Oracle. reviewer 내 AI1/AI2 분리는 item consumer 계약 영역이며 이 PR에서 전부 mini로 옮기지 않는다.
2. `job_batch_control` singleton: mode legacy|draining|versioned, draining_from, epoch, writer_contract_version, policy JSON/hash. 기본 legacy/contract0. `job_batch_candidates`: role+instance PK, host/boot/release/policy hash, heartbeat, capability, 별도 operator-managed `result_evidence`. DB가 승인한 instance→fixed host mapping과 release를 대조한다. capability는 host identity / release / DB principal·effective privilege hash / dependent HTTP-model evidence를 구분한다. runner는 성공 ACK TX에서 DB 시각과 양수 처리량을 host별 observation으로 남긴다. operator의 같은 host/release/job/requestedVersion 실제 domain readback hash가 추가로 있어야 준비도로 쓴다. 로그 count만으로 저장 성공을 추정하지 않으며 heartbeat는 capability/readback을 쓸 수 없다. 설치·빈 tick·타 host 성공은 canary가 아니다.
3. claim 잠금: batch control SHARE → versioned role UPDATE(짧은 admission 직렬화) → role proof → jobs UPDATE. drain은 control UPDATE로 이후 신규 job claim을 차단하되 기존 heartbeat/result는 원 job token으로 계속 종료한다. complete는 control UPDATE → role rows 정렬 UPDATE → job rows 정렬 UPDATE 뒤 fresh DB wall로 live role/job/item을 검사하며 live면 거절한다. epoch는 complete 때만 증가. producer requested/processed/cursor/pause/history 변경0. item행은 mutation0. item stage/consumer의 별도 admission이나 외부 호출 종료를 이 batch mode가 증명하지 않는다.
4. versioned 선출은 같은 role_leases를 재사용한다. control SHARE→role UPDATE 뒤 DB `clock_timestamp()`로 재판정한다. 건강한 현 owner는 선호 host 복귀와 무관하게 유지. 만료/정상 drain 뒤 새 epoch, 현재 release/policy/readiness가 맞는 fresh 후보 중 고정 host 순위. 임의 role/host/미등록 instance/미확정 권한·canary는 선출 불가. 기존 legacy election은 기본 그대로다.
5. runner/worker에 실제 연결한다. legacy 상태에서 새 역할은 claim0, versioned 상태에서 이동 잡은 이전 role/direct worker claim0. scheduler는 계속 기존 producer 신호를 생성한다. 새 역할은 같은 registry handler/현재 job budget/직렬 lane을 재사용한다. translation은 세 잡을 한 lane에서 직렬 실행하며 실제 모델 합계 슬롯을 대체하지 않는다.
6. 현재 host 전체 pool/CPU 상한 실측·Oracle install/권한·모델 hard cap/canary가 없으므로 실제 활성화는 금지. 새 capability 보고가 unknown을 그대로 나타내도록 한다. HTTP origin1/Oracle합2는 PR07 transport 계약을 재사용하며 임의 role별 상한 합산으로 대체하지 않는다.

## RED → GREEN / 소유 파일

- NEW pure policy test: legacy 목록 불변, 정확 번역3종, 고정 순위, 잘못된 policy/host, 설치만으로 readiness 불가. runnable stub의 실제 Assertion RED 후 구현.
- NEW actual DB `tests/integration/job-batches.test.ts`: 현재 실제 runner에서 draining/이동 role 우회 claim을 Assertion RED로 보존(새 import 오류 제외). 두 DB connection으로 transition↔claim 양방향 순서, healthy old owner 비선점, expiry takeover/epoch, job token·pause/request/µs cursor 보존, items raw 불변, contract0 activation0, invalid/unknown capability 선출0, same-release fallback ranking, producer 경합을 검증한다.
- 기존 scoped tests: job-catalog, role-worker, worker-runtime, worker-supervisor, scheduler-runtime, failover-readiness, pool 및 role-leader/job-control 관련 필요한 파일만. 전체 unit/DB/build 금지.
- 소유 예정: batches.ts/batch-repository.ts, catalog/role-leader, operations 새 readiness module, scripts worker/role-worker/supervisor/healthcheck, pool/instance의 enum 적응, operations-schema/0082/journal, 위 범위 tests, 이 상세 계획/검증 문서. runner/control/root 공유 registry/source adapter는 승인된 좁은 hunk만 별도 인수.

## 실행·정리

root가 배정한 fresh55525만 사용했다. fixture 외행 전체 raw/to_jsonb µs/ACL/3stage/role/job baseline 보존, 자체 exact key만 정리하고 원 role/control 행은 같은 열 raw로 복원한다. API/child/setup 실제 Promise를 Set으로 모두 정산 후 cleanup, 동시 본문/정리 예외 Aggregate 보존. 실제 readback/타 connection0 이후 root에게 DB 반환(STOP은 root). 새 운영 권한/활성화/remote/provider/DR/2배 증거로 보고하지 않는다.

실제 최종 검증: scoped unit 12files/108PASS, actual DB 1file/17PASS(2.05s), whole TypeScript/scoped ESLint exit0. 원 actual 3case의 본문/assertions는 보존했고 helper/fixture만 확장했다. 84개 public table 원행·카탈로그·설정의 저장 기준 대비 exact readback과 다른 연결0을 확인했다. 기준 catalog는 첫 verified replay bootstrap 정상 teardown 뒤 캡처했으므로 초기 bootstrap 이전 NULL ACL 표현의 byte identity를 주장하지 않는다. [검증 기록](../../operations/2026-10-16-pipeline-pr10-role-batches-validation.md)에 명령·실패 접근·실제 제약을 남긴다.

## 명시적으로 남긴 활성화 조건

- canonical-only site-evidence handler는 PR08 순차 통합 전까지 빈 배치/ready0이다. 전체 product-evidence-refresh를 옮기지 않았다.
- actual fixture의 runner cursor readback/관리자 evidence는 선출 경계 검증용이며 실제 번역 품질·provider·운영 DB role 권한을 증명하지 않는다. 운영 evidence는 미설치/unknown이다.
- 새 역할 pool max3은 프로세스별 접속 여유이며 Oracle host 전체 CPU/RSS/DB pool 예산이 아니다. 실제 host mapping·Oracle 배포·독립 scheduler·HTTP/모델 hard bound·최근 domain canary를 운영에서 확인해야 한다.
- fixed replay 예외는 private verified DB/scope의 기존 legacy job-batch 계약에만 한정한다. v5 actual 회귀를 실행했으며 이 base에 없는 v6의 actual 회귀를 주장하지 않는다. v5/v6 profile 권한/정책 hash를 변경하지 않는다.
- migration 기본 legacy/epoch1/contract0, 운영 활성화0. item certificate/외부 transport drain/DR/30분 처리량/2배 성능 증거를 추가하지 않았다.
