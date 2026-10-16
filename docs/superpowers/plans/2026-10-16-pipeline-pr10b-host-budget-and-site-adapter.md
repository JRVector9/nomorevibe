# PR10b — host DB 예산과 canonical site-only adapter 실행 계획

> **For agentic workers:** 아래 checklist를 root가 배정한 파일 소유권 순서로 실행한다. 이 문서는 읽기 설계만 승인된 상태다. 코드·테스트·DB·운영·Git 실행을 승인하지 않으며, 새 agent/원격 작업을 자동으로 시작하지 않는다.

**Goal:** PR10의 비활성 배치 기반에 PR08의 실제 canonical source job을 연결하고, 모든 동시 DB 접속 경로를 포함하는 host 예산을 기존 PgBouncer·고정 DB 사용자·프로세스 roster로 강제할 수 있게 한다.

**Architecture:** 기존 `executeCanonicalEvidenceSource`와 source receipt/CAS/정산을 재사용한다. 새 job은 고정 이름 `product-site-evidence-refresh` 하나로 제안하며, versioned site-evidence만 소비한다. DB 예산은 새 DB permit/broker 없이 기존 client pool에 strict process quota를 적용하고, 단일 PgBouncer의 host 사용자별 backend cap과 확인된 실행 roster를 별도로 검증한다.

**Tech Stack:** 기존 TypeScript/Drizzle/postgres-js/worker supervisor/PgBouncer/PostgreSQL. 새 queue·provider·장부 table·migration 번호를 예약하지 않는다.

## 1. 기준·소유권·이번 계획의 한계

- PR10 frozen WT `/Users/jr/Desktop/projects/nomorevibe-role-batches`: source/test/SQL 등 기존22파일은 그대로 동결한다. 이 계획 파일만 새로 작성했다. PR10 manifest `/tmp/nomorevibe-pr10-c-final-shas-20261016.json`.
- 읽은 PR08 frozen WT `/Users/jr/Desktop/projects/nomorevibe-source-claims`: source 복사/편집0. root가 PR08/07c/10 최신 main을 순차 통합한 뒤에만 아래 실제 구현을 시작한다.
- PR08 source-claims:95–131 실제 claim, :133–150 원 receipt renew/abandon, :153–194 실제 result/CAS/outbox/final wall, :195–208 collection→정산 API가 이미 있다. HTTP는 `canonical-collection.ts:15–44`의 실제 `fetchCapped`와 body 정산을 재사용한다.
- `source-contract.ts:16`은 현재 `product-evidence-refresh`만 허용한다. `jobs/products/evidence-refresh.ts:50–65`가 source mode에서 canonical을 inline 소비한다. `refresh.ts:702–705,763–765`는 source mode에서 legacy canonical collection을 건너뛰지만, 제품 전체 요청의 나머지 source/완료 검사는 유지한다.
- PR10 `batch-repository.ts:159–175`의 전환은 role/job/generic item을 검사한다. PR08 `evidence_source_claims`는 별도 장부여서 통합 후 live source claim 검사도 필요하다. TTL은 외부 HTTP 종료 증거가 아니다.
- PR11은 systemd/slice/release/독립 scheduler·실제 Oracle runtime을, PR05는 실제 translation model slot을 소유한다. 이 계획이 둘의 운영 검증을 완료하지 않는다.

## 2. 파일별 연결 계약

| 파일/소유 접점 | 제안 변경 | 보존 경계 |
| --- | --- | --- |
| NEW `lib/jobs/products/site-evidence-refresh.ts` | `refreshSiteEvidenceJob(ctx:JobContext<null>):Promise<JobOutcome<null>>`; 실제 site-evidence role env와 `ctx.lease`를 받아 고정 job만 수행. existing bounded4turn/deadline/signal로 `executeCanonicalEvidenceSource` 호출 | caller owner/receipt/result callback 추가0, GitHub/media/모델 호출0 |
| PR08 `lib/domain/evidence/source-contract.ts` | `SourceJobSchema.name=z.enum(['product-evidence-refresh','product-site-evidence-refresh'])`; 나머지 strict identity 그대로 | 임의 job명 허용0, receipt의 원 job/token/version 보존 |
| PR08 `source-claims.ts` | claim 첫 short TX에서 batch control SHARE→source control UPDATE→기존 domain/source→jobs. old job은 legacy, new job은 versioned site 배치에서만 새 claim; draining은 `JobBatchBlockedError` | 기존 소유자의 renew/record/abandon은 새 batch mode 때문에 원 receipt를 무효화하지 않음. source epoch/input/CAS/actual final wall 유지 |
| `lib/jobs/catalog.ts` | 고정 새 descriptor `{name:'product-site-evidence-refresh',role:'site-evidence',intervalMs:60000,batchVersion:1}`. `CatalogRole`만 additive 확장하고 legacy `JOB_ROLES`5/기존 `jobsForRole`·lanes 그대로 | legacy crawler에 새 job을 위장 배치하지 않음. 기본 legacy의 새 scheduler row/dispatch0 |
| `lib/jobs/registry.ts` | 고정 새 handler 한 개 등록 | 다른 handler/provider 교체0 |
| PR10 `batches.ts`/`batch-repository.ts` | site-evidence 고정 목록에 새 job 하나. legacy direct/new role 새 job 거절, versioned 기존 crawler의 새 job 거절. transition에 live `evidence_source_claims` 보존 검사 | fixed mapping·host rank·기존 token 보존. generic item authority 재발급/정리0 |
| PR08 `jobs/products/evidence-refresh.ts` | inline canonical loop는 legacy에서만. versioned는 product/GitHub/media/요청 완료 처리만 계속. claim의 actual batch-blocked는 기존 deferred outcome으로 연결 | 제품 전체 요청을 canonical 성공만으로 completed 처리0, GitHub quota/backoff 그대로 |
| `lib/jobs/control.ts` / `scripts/scheduler.ts` | catalog `batchVersion` descriptor만 actual control SHARE 아래 versioned due 처리. 기존 due job/주기 그대로 | producer·pause·notBefore·version coalescing 불변, 새 global scheduler 선출 추가0 |
| PR08 `refresh-requests.ts`/`source-claims.ts` | 요청 producer는 old product wakeup을 유지하고 새 site wakeup을 같은 TX에 추가. source result도 source job과 old product completion을 원자 wakeup | product/request 잠금 뒤 batch SHARE를 새로 취득하지 않음. producer는 배치를 기다리지 않고 신호만 보존 |
| `runner.ts` / `scripts/worker.ts` | source continuation의 고정 job 목록에 새 이름 추가, site-only lane 직렬·실제 requested/notBefore 조건 재사용. batchResult fixed event 추가 | done:false ACK 기존 의미·HTTP typed deferred·producer/pause/CAS 보존. item 결과/transport lifecycle 변경0 |
| `job-batch-readiness.ts`/health/IPC/admin catalog 소비자 | 새 job의 같은 host/release/requestedVersion 실제 source readback을 operator evidence와 대조 | 빈 tick/단순 factsChanged0을 성공 canary로 승격0. 설치/역할 health와 ready 구분 |

`JOB_CATALOG` 소비자는 `app/api/cron/[job]/route.ts`, admin status/settings UI, `lib/operations/{worker-progress,crawler-activity}.ts`에도 있다. 새 descriptor 타입과 표시를 좁게 확인한다. 공개 cron의 새 job direct 실행도 batch proof 없이 거절하며, UI는 job명/role 표시만 추가한다. 기존 PR09 health/detail/inbox 소스는 root 순차 인수 없이 편집하지 않는다.

### source proof/전환의 정확한 순서

1. 새 adapter는 `roleLeaseFromEnv('site-evidence',env)`와 실제 runner job lease가 없으면 dispatch0. SourceJobSchema가 old/new 두 고정 이름만 허용한다. 기존 foundation의 job:null API는 legacy에서 유지하되 versioned의 신규 production claim은 새 actual job proof를 필수로 한다. normal direct null consumer를 새로 연결하지 않는다.
2. outer job claim은 PR10 batch SHARE→role→job 뒤 commit한다. source claim은 **별도 short TX**에서 batch SHARE→source control UPDATE→기존 product/current input/source receipt→job wall 순서로 다시 검사한다. preflight만으로 이를 대체하지 않는다. source claim 전 mode가 변하면 old/new adapter는 `{done:false,deferred:'stage_blocked'}`로 원 요청을 보존한다.
3. 기존 source result/renew는 원 claim의 job identity와 receipt를 계속 사용한다. batch drain은 새 claim만 닫는다. transition은 live source owner가 있으면 epoch 증가를 거절하고 원 token/expiry를 변경하지 않는다. 프로세스를 먼저 정상 drain해 기존 job/source Promise 정산 후 role release→전환한다.
4. source result가 새 job proof와 old product wakeup 두 jobs를 만지므로 **두 고정 job row를 이름 정렬 순서로 잠근 후** outbox를 쓴다. 현재 :186의 단일 job lock→:187 old request를 그대로 확장하면 역순이 생길 수 있다. 원 job/token DB wall과 source lease DB wall은 모든 outbox 대기 뒤 마지막에 재검사한다. trigger 실패 시 source/progress/cursor/outbox/release 전부 rollback한다.
5. producer는 product/domain 잠금 이후 batch lock을 새로 읽지 않는다. old/new wakeup을 같은 TX에 이름 정렬로 쓴다. legacy에서 새 신호가 있어도 dispatcher는 거절한다. scheduler 자체는 batch 전용 descriptor를 legacy에서 만들거나 due 요청하지 않는다. source result와 제품 checkpoint의 기존 merge는 canonical completedKey를 보존한다.
6. rollback은 새 claim 중단→두 job과 source owner 정상 정산→role release→batch epoch 전환→legacy inline canonical 재개다. jobs/source claim 삭제·TTL 단축·healthy token 강제 폐기0. 미정산 HTTP를 TTL로 종료 처리하지 않는다.

## 3. 전체 DB 접속 catalog와 현재 숫자의 의미

실제 source 근거: `lib/db/index.ts:19–30`은 process별 primary singleton, :37–46은 web read replica **별도 pool**이다. `role-worker.ts`의 선출/renew/observation과 `superviseWorker()`는 **같은 parent process**다. `worker-supervisor.ts:120–126`이 만드는 worker child만 다른 pool이다. 10초 role heartbeat, job heartbeat, supervisor observation은 각 해당 process의 기존 pool을 공유하며 추가 client가 아니다. scheduler supervisor와 scheduler child도 두 pool이다. CLI healthcheck는 로컬 파일만 읽지만 monitor/preflight/직접 운영 script는 별도 process일 수 있다.

| 실제 동시에 가능한 경로 | current code의 client ceiling 계산 | host roster에서 포함할 것 |
| --- | --- | --- |
| 5 legacy role parent + worker child | `(4+3+3+3+3)*2=32` | standby parent도 DB 사용. active child가 어느 host에 생기는지 별도 집계 |
| 새4 role parent + worker child | `4*3*2=24` | 설치만으로 각 child가 생기지는 않지만 failover 가능 최대를 계산 |
| scheduler 1replica | parent2 + child2 =4 | M3 현 2replica라면8; Oracle 독립1은4 |
| web 1replica | primary8 + optional read4 =12 | operator override/실제 replica URL은 별도 실측; READ pool을 누락하지 않음 |
| connect-agent / monitor | 각1 | 각 process 수와 원 실제 URL 포함 |
| preflight/readback CLI | 원 client 경로 max1로 명시 | runtime과 겹치면 같은 host 예산에 포함. 실행 후 실제 end 필요 |
| migration/직접 관리 CLI | `migrate.mjs:22` direct max1, 다른 script는 runtime module 또는 별도 client | 활성 workload와 겹치면 별도 reserve를 포함하거나 stop/drain 후 실행 |
| provider CLI/tsx/esbuild | DB module을 로드하지 않는 자식은 DB0 | process 존재만으로0을 추정하지 않고 실제 entry/import/credential 전달을 확인 |

위 계산은 모든 parent에 올바른 WORKER_ROLE가 주입된다는 조건이다. 누락되면 현재 `dbPoolConfig`가 web8로 default하므로 고정 예산 모드에서는 누락을 거절해야 한다. DB_POOL_MAX는 현재 최대64 override 가능하다. 이 값들의 합계는 **가능한 client 연결 수의 catalog일 뿐 강제 host 상한이 아니다.**

예: 모든9role parent/child가 한 host에서 허용되면56, web1/read 포함12, scheduler2는8, monitor/connect/preflight 각1이면79개다. mini에서 scheduler/connect가 없고 나머지 같으면70개다. Oracle의 새4role+독립 scheduler1+monitor1+preflight1만이면30개다. 이는 운영 관측 숫자가 아니며 무조건 이만큼 pool을 허용하자는 제안도 아니다. rolling 배포의 old/new parent·child 중첩, 여러 preflight도 roster에 따로 포함해야 한다.

## 4. 가장 작은 host DB 예산 구현안

기존 runbook `independent-workers-runbook.md:226–231`은 runtime PgBouncer6432와 DB role timeout을 사용하고 migration만 direct5432로 분리한다. 저장소에는 현 PgBouncer 실제 version/config가 없어 enforcement를 확인한 것으로 쓰지 않는다. 기존 하나의 공통 `nomorevibe` DB 사용자만 쓰면 host별 cap을 분리할 수 없다.

**권장 첫 단위:** 기존 단일 PgBouncer에서 host별 고정 login/DB alias 경로를 operator가 지정하고, 그 host의 모든 runtime·child·scheduler·preflight가 같은 host backend budget을 소비하게 한다. 새 DB permit row/세마포어/broker는 만들지 않는다.

- NEW `lib/db/host-budget.ts`: strict version1 host process roster. fixed host/role/process kind(parent|worker|scheduler-parent|scheduler-worker|web|monitor|connect-agent|preflight), release, allowed instance 수, primary/read pool quota와 합계를 산출한다. 새 모드 default disabled. invalid/unknown host·kind·초과 pool override·worker READ URL은 first DB connect 전에 거절한다. arbitrary `ready:true`/호출자 proof callback은 받지 않는다.
- `lib/db/pool.ts`/`index.ts`: disabled는 기존 config 그대로. enabled는 roster quota 이하만 허용한다. parent quota는1, child quota는 기존 실제 heartbeat/writer 요구를 검증해2 또는3, preflight1로 시작한다. role/supervisor heartbeat를 위한 별도 pool을 또 만들지 않는다. 실제 시도/대기/종료는 기존 driver pool deadline과 server timeout을 그대로 사용한다.
- `scripts/role-worker.ts`/`worker-supervisor.ts`/`worker.ts`/scheduler entry: parent/child kind·host·release를 명시적으로 전달한다. supervisor는 기존 한 child만 실행한다. PR11 systemd의 fixed unit/replica roster와 같은 release artifact로 parent 수를 제한한다. standby/monitor/배포 preflight도 빠뜨리지 않는다. 단순 env 문자열은 실제 실행 프로세스 수의 증명이 아니다.
- NEW `scripts/check-host-db-budget.ts`: 읽기 전용 preflight. 실제 principal·host user/alias·pooler version·pool mode·host cap·reserve pool·강제 server user mapping·direct 경로 차단·현재 client/server 수와 역할 roster/release를 좁게 검증하고 비밀값 없이 hash/unknown 이유만 출력한다. 실제 PgBouncer admin 권한이 없으면 unknown으로 둔다. runtime에 admin 자격을 추가하지 않는다.
- PR10 `batchCapabilitySchema`에 별도 `hostBudgetEvidenceHash`를 추가하고 새 versioned readiness/선출은 같은 host/release의 검증된 budget readback이 없으면 unknown으로 둔다. 이 hash는 pooler cap·host principal·각 endpoint·roster/중첩·관측시각을 포함한 operator readback을 가리킨다. 기존 `effectivePrivilegeHash`에 budget을 숨기거나, hash 문자열 하나를 실제 강제/계정 확인의 대체 증거로 쓰지 않는다. pooler/roster enforcement와 실제 운영 readback이 선행한다. 기존 JSON 열을 사용하므로 새 table/migration은 필요 없다.
- 새 operator 설정 artifact/예시 runbook은 root/PR11과 순차 소유한다. fixed host user는 non-superuser이고 원 runtime effective privileges를 명시 검토한다. 기존 owner/superuser 자격을 다른 host에 재사용해 hard cap을 주장하지 않는다. host 계정/권한 생성·pooler reload·방화벽은 별도 운영 승인 작업이다.

**정확한 enforce/proof 경계:**

1. 단일 PgBouncer의 검증된 host-user backend cap(해당 version이 지원하는 `max_user_connections`, 또는 고정 DB alias의 동등한 cap)이 실제 DB server 연결 상한이다. default/reserve pool이 그 cap을 우회하지 않는지 실제 saturation으로 확인한다. 예산값은 실제 workload headroom을 본 뒤 root가 고정하며, 이번 읽기에서 숫자를 ready로 승인하지 않는다.
2. 여러 PgBouncer 인스턴스에서 같은 cap을 각각 주거나 forced user가 모두 한 계정으로 바뀌면 host 상한 증거가 깨진다. direct5432·다른 alias/READ cluster 경로가 열려도 합계 보장이 깨진다. 기존 단일 endpoint 강제/host 사용자/네트워크 경로를 확인하지 못하면 활성화0. PostgreSQL role connection limit은 backstop이며 단독으로 정확한 분산 상한 인증으로 쓰지 않는다.
3. pooler backend cap과 frontend(client socket) 수는 다르다. frontend 상한은 **강제된 unit/replica roster×각 process pool**과 read pool 별도 quota의 합이다. 수동 extra process/CLI를 허용하면 frontend bound는 미확정이다. backend cap만 확인하고 CPU/RSS/host 전체 socket까지 bound라고 쓰지 않는다.
4. web replica가 다른 DB cluster에 direct 접속하면 writer cap에 포함되지 않는다. host-total은 각 확인된 endpoint의 별도 cap/roster 합계로 증명한다. Oracle 첫 runtime에는 web/READ replica를 연결하지 않는 작은 roster부터 시작할 수 있다. 추후 web을 추가할 때 예산을 다시 승인한다.
5. cap은 안전 상한이며 heartbeat 진척 보장은 아니다. 모든 server slot이 긴 TX로 차면 heartbeat가 굶을 수 있다. 짧은 TX·기존 timeout을 유지하고 actual saturation 동안 role/job heartbeat 여유를 측정한다. 미충족이면 child concurrency/roster를 낮추며 상한을 임의 증대하지 않는다.

## 5. 구현 순서와 최소 실제 RED / control

구현 권한은 root가 별도 배정한다. 각 단계는 원 driver/원 SHA/로그를 보존하고 import/setup 오류를 기능 RED로 세지 않는다. 전체 suite/build 금지, 변경 범위만 실행한다.

### A. PR08 순차 인수와 site-only 실행

- [ ] root가 PR08 frozen source+PR07c deferred+PR10을 정상 통합한다. 기존 source-schema0081/배치0082를 재설계하지 않는다.
- [ ] NEW `tests/integration/site-evidence-job.test.ts`: 실제 runJob 새 job lease를 사용해 new handler의 canonical fetch1/GitHub0/media0, saved source/progress 원자성 control. 기존 job과 source claim을 두 connection으로 경쟁시켜 같은 product dispatch1을 확인한다. versioned old inline dispatch0와 정상 legacy inline control을 먼저 behavioral RED로 보존한다.
- [ ] SourceJobSchema 두 fixed 이름, 새 adapter/registry/catalog descriptor, same-TX source batch guard를 구현한다. `ctx.lease.name`을 typed source receipt에 그대로 결합하고 synthetic receipt를 쓰지 않는다.
- [ ] `tests/integration/job-batches.test.ts`의 scoped 확장: control wait→mode commit 뒤 old source claim0, source healthy owner 동안 transition0, 원 source settle 후 epoch 증가, old/new role 중복0. 일반 item token은 raw 불변이다.
- [ ] source result의 두 jobs sorted lock/outbox+final wall을 구현한다. trigger fault와 실제 job-row wait expiry에서 source/request progress/outbox/release 전부 rollback하고 원 item/source/다른 owner를 건드리지 않음을 확인한다.
- [ ] producer old/new wakeup, scheduler mode descriptor, runner continuation/worker site lane, actual source readback canary를 연결한다. GitHub quota 대기여도 canonical10 due를 처리하고 all-required product 완료는 false로 보존하는 PR08 정상 회귀를 유지한다. 실제 provider 없이 transport 경계만 fixture로 사용한다.

### B. DB host catalog·pool quota·실제 경로 enforcement

- [ ] NEW `tests/host-db-budget.test.ts`: 위 모든 process category와 parent/supervisor 동일 pool, child 별도 pool, web READ 별도, scheduler replicas, preflight/migration reserve, rolling 중첩을 assert한다. unknown kind/host, WORKER_ROLE 누락, quota override 초과를 거절한다. disabled 원 config control은 그대로다.
- [ ] NEW `tests/integration/host-db-budget.test.ts`: 실제 root 배정 test DB와 별도 승인된 **local PgBouncer fixture**에서 서로 다른 Node executors가 같은 host user/alias를 사용해 cap+1 backend가 생기지 않음을 검증한다. 원 코드에서 개별 max3만 설정한 두 process는 합계 초과하는 actual RED/control을 먼저 얻는다. 다른 host user의 독립 quota도 실제 두 connection으로 확인한다. local pooler 제공 전에는 directDB만으로 PgBouncer PASS를 주장하지 않는다.
- [ ] actual parent observation+child writer+job heartbeat+scheduler+preflight 동시 시도에 cap 적용을 확인한다. 기다리던 쿼리를 Promise.race로 방치하지 않으며 모든 client/TX 원 Promise를 정산한 뒤 close한다. ordinary caller의 pause/request/CAS와 pool timeout 의미를 유지한다.
- [ ] direct endpoint/alternate alias/replica·pooler replica가 있으면 preflight unknown/activation0 control. host user role privilege와 cap readback은 실제 DB/배포 evidence를 구분한다. DB 권한을 늘려 test를 통과시키지 않는다.

### C. PR11/PR05 접점과 반환

- [ ] PR11이 fixed process roster/Nonroot systemd CPU·Memory slice/actual release·scheduler를 소유한다. PR10b는 계산/입력 검증/role readiness 소비만 한다. 실제 Oracle1CPU/RSS/DB heartbeat 검증 없이 설치를 ready로 만들지 않는다.
- [ ] translation3job은 PR05의 모든 실제 gateway 호출 공통 slot 경로를 사용해야 한다. role 직렬 lane이나 host child cap은 실제 모델 공통1의 증거가 아니다. PR05 dispatch 후 unknown 점유/종료 증거 한계를 그대로 보존한다.
- [ ] scoped command(예정): `npx vitest run tests/host-db-budget.test.ts tests/job-batches.test.ts tests/job-catalog.test.ts tests/worker-runtime.test.ts tests/role-worker.test.ts`; `TEST_DATABASE_URL="$PR10B_TEST_DATABASE_URL" npx vitest run --config vitest.integration.config.ts tests/integration/site-evidence-job.test.ts tests/integration/host-db-budget.test.ts tests/integration/job-batches.test.ts`; 필요한 whole tsc/scoped lint만. `PR10B_TEST_DATABASE_URL`은 root가 새 전용 DB metadata와 함께 배정하기 전 비어 있어야 하며 기존55525/완료 DB 재사용0.
- [ ] raw foreign 전체/관리행 µs/ACL·trigger·role·기본 disabled 상태 복원과 실제 Promise 정산/다른 연결0을 검증하고 원로그·SHA·실패 접근을 반환한다. Git/공용 handoff·배포·활성화는 root 소유다. 이 계획 시점 실제 새 RED/GREEN/DB/운영 실행은0이다.

## 6. 충돌 없는 세 담당 경계

| 담당 | 독점 파일/작업 | 순차 공유 접점 |
| --- | --- | --- |
| source adapter 담당 | 새 site job, PR08 source-contract/claims/refresh-requests, 기존 evidence job canonical 분기, 해당 actual tests | PR08 frozen 인수 먼저. 공통 runner/control/catalog/registry는 root가 아래 runtime 담당에 한 번만 인수 |
| runtime/budget 담당 | host-budget/pool/index, PR10 batches/readiness, catalog/registry/control/runner/worker/supervisor와 scoped tests | source 담당은 공통 파일 직접 편집0. PR11 TS preflight/systemd artifact는 root 순차 통합 |
| 독립 actual 담당 | NEW site/host-budget adversarial tests와 root 배정 전용 DB/local pooler fixture, raw 복원·two executor driver | production/source 동시 소유0. 원 behavior RED 후 구현·같은 GREEN, 실제 DB 권한/기동은 별도 root 배정 |

공용 source CAS/SQL lifecycle, item/certified replay/profile, 모델 dispatch framework를 이 작업에서 재개발하지 않는다. site-only 기능과 host budget을 각각 리뷰 가능한 작은 PR로 나눌 수 있으나, 둘과 PR11/PR05 실제 activation gate가 모두 닫히기 전 운영 소비자 활성화는 금지한다.
