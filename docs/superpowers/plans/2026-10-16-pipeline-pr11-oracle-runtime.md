# PR11 — Oracle 독립 runtime Implementation Plan

> **For agentic workers:** `writing-plans`로 작성한 계획이다. 구현은 이 세션의 `execute-plan`/TDD 절차와 아래 체크리스트를 따른다. 모델은 `gpt-6.1-sol` / `xhigh`. Git·공통 handoff·배포 취합은 root가 담당하며, 이 계획 작성 단계에서는 실행하지 않는다.

**Goal:** `surfguide / ap-osaka-1 / osaka-smoke`에 고정 릴리스의 nonroot 워커·독립 scheduler를 재현 가능하게 설치하고, 실제 증거가 없는 업무는 준비 미완료로 유지한다.

**Architecture:** 기존 PostgreSQL 큐, PR10의 9역할·선출·현재 writer 검증을 재사용한다. Oracle 전용 경로의 native ARM/glibc release와 systemd를 추가하고 기존 M3·mini Dokploy 배포 경로를 보존한다. 설치/로컬 테스트, 실제 활성화, 24시간 운영 및 장애 인계는 각각 따로 판정한다.

**Tech Stack:** Node 24, Linux ARM64/glibc, TypeScript/tsx, Python stdlib 배포 도구, systemd, PostgreSQL 17/PgBouncer, 기존 HTTP·모델 permit.

---

## 1. 현재 단계와 읽기 근거

- 최초 단계는 계획만 작성했다. 이후 root가 Task1/2의 독립 Python 검증·prepared artifact builder/offline manager·unit/env 예시·회귀/문서만 승인했다. 현재 허용 source는 `deploy/oracle/**`, test는 `tests/test_oracle_runtime.py`다. Git/DB/SSH/HTTP/provider/실npm/실artifact빌드/설치·배포 실행0이며, 수동 전체 suite/전체 DB/build/bundle은 최종 통합 단계에 남긴다.
- 기준 WT는 `nomorevibe-oracle-runtime`, base `37f0542b`. PR08·09·10의 다른 WT 변경을 복사하지 않는다. root의 선행 병합·파일 인수 후 실제 main 계약을 다시 확인한다.
- 설계 근거: `docs/superpowers/specs/2026-10-15-pipeline-two-times-design.md` §6.1, roadmap PR07–11/14–17, `README.md`, `docs/operations/independent-workers-runbook.md`.
- 현재 `scripts/ops/deploy_shared_images.py:23–42`의 `APPS/ORDER`는 Dokploy **8개 앱 배포 범위**다. maintenance 2개는 별도 read-only 사전 검사다. AGENTS의 **실운영 13개 앱**과 이 도구의 범위는 다르며, 누락 앱이 없거나 이미 13개 자동 배포를 지원한다고 추정하지 않는다.
- 현재 `scripts/role-worker.ts`는 legacy 5역할, `scripts/scheduler.ts`는 10초 간격 DB producer다. Oracle가 M3 HTTP broker를 통해 일감을 받아야 하는 새 경로를 만들지 않는다.
- 기존 worker 이미지는 `Dockerfile`의 Node24 Alpine/arm64이며 CLI pin은 Codex `0.153.4`, Claude `2.1.263`, Grok `1.0.46`이다. 이미지의 Alpine 의존성을 Ubuntu native release에 복사하지 않는다.
- PR10 인수 근거는 `nomorevibe-role-batches/docs/superpowers/plans/2026-10-16-pipeline-pr10-role-batches.md`와 해당 source다. 현재 새 `site-evidence`는 목록이 비어 readiness가 false이며, pool3은 host 전체 DB·CPU·heartbeat 증거가 아니다.

## 2. 실행 방식 비교와 권고

| 방식 | 재사용·추가 비용 | 필수 실제 확인 | 판정 |
| --- | --- | --- | --- |
| nonroot systemd + rootless OCI | 기존 arm64 worker digest 재사용. Podman 등 새 runtime, subuid/subgid·storage/network·cgroup·사용자 runtime 관리가 추가된다. | 해당 Ubuntu의 rootless 실행/중단/자원 합계/CLI 인증·상태 디렉터리와 재부팅 동작 | 이번 기본안으로 선택하지 않는다. Docker socket 권한으로 대체하지 않는다. |
| nonroot systemd + native 고정 release | 기록상 이미 있는 Node24를 사용. 동일 source SHA/lockfile로 **대상 Linux ARM/glibc**에서 production 의존성과 CLI를 준비하는 작은 artifact builder가 필요하다. | Node 정확 버전·binary hash, native dependency/CLI, artifact 재현·소유권·readback | **권고안.** 추가 container runtime 없이 기존 서버 구성과 가장 가깝다. |

native 권고가 운영 호환성 확인을 뜻하지 않는다. 빌드 환경은 Linux/arm64/glibc가 아니면 거절하고 macOS/Alpine `node_modules`를 포함하지 않는다. 외부 모델·prompt·reasoning/검증 품질은 변경하지 않는다. Node/CLI의 승인된 정확 버전과 checksum은 artifact manifest에 고정하며 운영에서 `latest` 설치하지 않는다.

## 3. 선행 인수와 PR 경계

| 선행 | 필요한 실제 계약 | PR11 경계 |
| --- | --- | --- |
| PR07b/c | `safeFetch/fetchCapped` 전 hop 공유 origin permit, Oracle host 합2/origin1, typed defer의 attempt/ACK 보존, 실제 read/cancel 정산 | 동일 adapter·정책을 사용. 새 HTTP wrapper나 수치 override를 만들지 않는다. 참여하지 않는 구 caller가 남으면 해당 업무 활성화 차단. |
| PR08 | canonical `documentation + canonical_site`의 source-only claim/result/CAS, 관리자/정상/catch-up 공정 배분, 2MiB/304/partial·URL/정책/공개상태 fencing | root가 PR10과 source-only adapter의 정확 entry를 연결한 후 사용. `product-evidence-refresh` 전체를 새 site 역할로 옮기지 않는다. |
| PR09 | raw observation과 authoritative gate 기본 비활성, 6h slot/URL·세대 CAS, Oracle 403/timeout·광역 장애·증거 공백 hold, 최종 sweep/commit 보호 | 첫 Oracle 비교는 **raw-only**. 검증된 gate 입력 전 counter/checkedAt/3회 숨김·10회 audited 내림 권한 이전 금지. |
| PR10 | 9역할 catalog/runner/role-worker/pool/권한/readiness 같은 전환 버전, 현 owner 비선점, drain·epoch, 고정 host 순위 | PR11에서 복제하지 않는다. root 인수 후 CLI/env·readiness API를 재사용한다. `site-evidence` 공백은 활성화 blocker다. |
| PR05/01b provider 후속 | 실제 route·모델 identity/상한/terminal 및 모든 caller의 공통 모델 슬롯, translation 실제 합1과 대기 의미 | 단순 host 이동이나 env로 충족했다고 하지 않는다. 미연결/unknown이면 모델 업무 capability를 unknown으로 유지한다. |

현재 PR10 공개 접점은 `BATCH_ROLES/BATCH_HOSTS`, `batchJobsForRole`, `batchPolicyHash`, `classifyBatchReadiness`, `readJobBatchReadiness()`다. 환경은 명시 `JOB_BATCH_VERSION=1`, `PHYSICAL_HOST=oracle-osaka-smoke`와 기존 `--role=<role> --kind=primary|standby` 형식이다. 정확 이름은 최종 인수본에서 재확인한다. 기본 DB mode `legacy/epoch1/contract0`과 새 consumer 비활성을 이 PR의 설치 과정이 바꾸지 않는다.

## 4. 파일 소유권과 산출물

다음 표의 Python/템플릿·지정 Python test·관련 계획/검증 문서만 Task1/2로 승인되었다. TS preflight·공통 deploy helper와 기존 test는 아직 root/선행 owner 소유이며 편집하지 않는다.

| 파일 | 책임/소유 |
| --- | --- |
| NEW `deploy/oracle/build_release.py` | 대상 플랫폼 확인, 고정 source/lockfile·production dependencies/CLI 설치, 비밀 없는 native archive/manifest 생성. A |
| NEW `deploy/oracle/manage_release.py` | exact host·manifest 검증, staging/install/switch/rollback, 허용 경로·unit만 다루는 stdlib 도구. A |
| NEW `deploy/oracle/release.json.example`, `oracle-host.json.example` | 비밀 없는 schema 예시. full40 SHA/파일 SHA256/Node·CLI pin/platform/contract와 승인된 OCI identity. A |
| NEW `deploy/oracle/role.env.example`, `scheduler.env.example` | 비밀값 없는 필수 key·권한 범위 안내. 실제 env는 repository 밖. A |
| NEW `deploy/oracle/nomorevibe-core.slice`, `nomorevibe-core-role@.service`, `nomorevibe-core-scheduler.service` | host 합계 cgroup, nonroot service, 독립 scheduler, 고정 launcher·상태 경로. A |
| NEW `scripts/ops/oracle-runtime-preflight.ts` | 기존 DB/readiness API를 호출하는 제한된 runtime 사전 검사·비밀 없는 결과. A, 실제 PR10 source 인수 후만 |
| `scripts/ops/deploy_shared_images.py` | **명시 Oracle action만** native manifest 관리 도구로 위임. 기존 default `plan/run/restore`, 8앱 ORDER와 기존 설정 조회 순서 보존. root가 단독 인수 지정 |
| NEW `tests/test_oracle_runtime.py`, 기존 `tests/test_deploy_shared_images.py` | host/path/artifact/unit/install·실패 복구 및 기존 Dokploy 비영향. A/해당 helper owner 순차 |
| NEW `tests/oracle-runtime-preflight.test.ts`, NEW `tests/integration/oracle-runtime-preflight.test.ts` | 엄격 unknown/오권한/구버전/실제 DB·scheduler·소유권 경계. 전용 DB 배정 후 지정 owner |
| NEW `docs/operations/oracle-runtime-runbook.md`, `2026-10-16-pipeline-pr11-validation.md` | 설치·활성화·rollback·실제 증거/미실행 구분. A |

PR08 evidence 파일/0081, PR09 health/0080, PR10 catalog/role/runner/control/0082는 선행 owner/root 소유다. A가 직접 patch를 복사하거나 선행 API를 재구현하지 않는다. 원본 X branch·`deploy/x-collector/`·공통 AGENTS/handoff·Git은 root 소유다. PR11 자체 migration은 계획하지 않는다.

## 5. 고정 설치·릴리스·host 계약

- 새 Unix 계정 `nomorevibe-core`(로그인 셸 없음), `/opt/nomorevibe-core/releases/<full40sha>/`, `/opt/nomorevibe-core/current`, `/etc/nomorevibe-core/`, `/var/lib/nomorevibe-core/`, `/run/nomorevibe-core/`만 사용한다. 경로 escape/symlink 경유·다른 unit prefix·잘못된 role은 거절한다.
- release source/`node_modules`/CLI는 root 소유 read-only로 설치하고 worker가 수정하지 못한다. 상태/health/temp/필요 CLI auth state만 전용 계정 쓰기 허용. env는 서비스별 root 관리 0600 파일이며 systemd가 읽어 주입한다. worker에게 migration URL/OCI 관리자 키/운영 DB owner/GHCR 쓰기 credential을 주지 않는다.
- artifact는 Git SHA·lockfile hash·전체 허용 파일 checksum·Node/CLI binary pin·Linux ARM/glibc·PR10 계약 버전의 manifest와 함께 검증한다. archive의 절대 경로/`..`/외부 symlink/중복 entry를 거절한다. source archive에는 `.env*`, `.npmrc`, token/로그/사용자 홈이 들어가지 않는다. package registry 인증이 필요하면 빌드 단계에서만 별도 주입하고 artifact/출력에서 제외한다.
- `npm ci --omit=dev`와 현재 CLI pin을 Linux ARM/glibc staging에서 사용한다. `tsx`, `lib`, `scripts`, `drizzle`, `tsconfig.json` 등 기존 worker에 필요한 파일을 포함한다. 설치/업데이트 시 서버에서 lockfile을 다시 풀거나 임의 `npm install`을 하지 않는다. 검증한 archive를 미리 보관하므로 M3/Dokploy가 없어도 이미 배치된 release를 실행/복구할 수 있다.
- 명시 host는 **tenancy surfguide / region ap-osaka-1 / instance osaka-smoke**다. SSH 별칭/IP 문자열만으로 검증하지 않는다. 승인된 full tenancy/instance OCID와 대상 호스트 metadata의 실제 필드를 좁게 대조한다. exact OCID·metadata 취득 경로는 아직 미확인값이며 placeholder면 plan/readiness 실패다. `onetwoday`/metadata 접근 실패/identity mismatch에서 설치·start·rollback 변경0.
- 예시 manifest/host map은 설정이며 물리 attestation이 아니다. 실제 운영자의 OCI readback/호스트 identity 증거와 묶는다. 비밀 없는 digest·판정·오류 코드만 출력한다. env 전문/전체 argv/자격 파일을 진단 출력하지 않는다.
- `prepare/install`은 파일 검증·unit 설치까지만 하며 `enable --now`, DB mode/policy 수정, job request/소비, canary evidence 생성은 하지 않는다. 활성화는 별도 단계다. 고정 manifest의 현재/이전 release를 관리하고 current link는 동일 filesystem의 원자 교체를 쓴다.

## 6. systemd·공통 budget·readiness 계약

- 서비스는 `User=nomorevibe-core`, 고정 `WorkingDirectory`, `UMask=0077`, `NoNewPrivileges`, read-only release와 명시 write 경로, 독립 role별 health 파일을 사용한다. Linux CLI·실제 자식 정산과 충돌하는 sandbox 항목은 ARM 검증 후 정한다. CLI 인증이 없는 업무에 인증 mount를 공유하지 않는다.
- `ExecStart`는 관리 launcher→동일 release의 `node --import tsx scripts/role-worker.ts ...` 또는 `worker-supervisor.ts --role=scheduler`다. 전자는 PR10 실제 admission을 재사용한다. 직접 `worker.ts`를 띄워 role/job 검사를 우회하지 않는다.
- `KillMode`/`TimeoutStopSec`/supervisor drain은 실제 child·CLI 정산 계약과 맞춘다. systemd hard kill/프로세스 실종을 외부 HTTP·모델 종료 증거로 사용하지 않는다. DB의 미확정 외부 호출 charge를 TTL로 해제하지 않는다. 실패 재시작에 rate limit을 두고 readiness가 없으면 새 claim0이다.
- Oracle scheduler는 같은 DB `requestDueJobs/markSchedulerSeen`을 실행한다. M3 웹/스케줄러 RPC나 local cron에 의존하지 않는다. 다른 scheduler와 같은 due 요청의 멱등성과 job pause/request/cursor 보존을 회귀로 확인한다.
- PR10 9역할 전체 설치 지원과 동시 실행 개수는 별개다. 1CPU/메모리 약6GiB라는 과거 표본만으로 9개 Node 프로세스+자식/pool을 모두 켜지 않는다. `nomorevibe-core.slice`의 합계 CPU/RSS/Tasks 상한과 host 상태 보고를 두며 실제 값은 현재 여유·heartbeat 부하 측정 후 고정한다. 확인 전 자동 기본 수치를 만들어 active로 표시하지 않는다.
- HTTP는 참여 caller 모두 기존 PR07 공유 정책을 사용해 Oracle 합2/origin1을 유지한다. 번역3종은 PR10 한 lane 및 실제 provider 공통 slot과 결합해 host 실제 호출 합1을 증명해야 한다. 다른 구 consumer가 살아 있거나 모델 permit 연결/terminal이 미증명인 경우 번역 ready0이다.
- **DB host 전체 budget은 현재 미완성 선행 경계다.** 역할별 pool3/작업별 concurrency 합으로 충분하다고 하지 않는다. runtime·자식·scheduler·preflight·heartbeat를 모두 세어 실제 client/backend 상한과 여유를 측정하고, 공유 pool/admission이 모든 경로를 제한하는 계약을 PR10 owner/root가 확정해야 한다. 현재 pool API로 불가능하면 별도 좁은 후속을 먼저 납품하며 systemd CPU/RSS 제한을 DB 제한인 것처럼 대체하지 않는다.
- preflight는 ARM/Node·native dependency/CLI→host/release/contract→인증 SQL·최소권한→budget→기존 readiness를 검증한다. TCP200/프로세스 설치/빈 tick/다른 host 성공은 해당 canary가 아니다. DB `current_user`, 실제 effective privilege/RLS 범위·timeout/pgbouncer 조건을 확인하고 migration/schema create/다른 서비스 고권한은 거절한다. read-only catalog 확인과 실제 승인된 write canary 증거를 구분한다.
- PR10 `classifyBatchReadiness`의 host+instance+release·최근 결과·`effectivePrivilegeHash`/모델 bound evidence·domain readback을 재사용한다. runtime heartbeat가 capability/result evidence를 발급하지 않는다. 오래되거나 관찰 불가면 unknown/새 claim0, 기존 owner/token을 강제로 폐기하지 않는다.
- 최초 capability 증거를 만드는 실제 canary entry/운영 최소권한 grant 집합은 아직 인수 전이다. 설치 후 임의 `verified:true`를 기록하는 bootstrap을 만들지 않는다. genuine job/domain 결과 readback이 가능한 승인된 고정 경로가 없으면 이 부분은 미완료로 남긴다.

## 7. TDD 구현 순서와 변경 범위 검증

### Task 1 — 선행 파일 인수와 manifest/host fail-closed

- [ ] root가 PR07–10의 실제 main 반영·파일 소유권을 고정한다. site-only entry/9role/health raw gate/typed defer/model blocker inventory를 최종 source로 갱신한다.
- [x] `tests/test_oracle_runtime.py`에 runnable baseline 행동 RED/control을 작성하고 원 driver/log/hash를 보존했다. import/setup 실패와 구분했다.
- [x] strict manifest/host/catalog 및 offline staging·pinned current CAS를 구현하고 원6개 메서드 AST/기대값 동일성 및 GREEN을 확인했다. **실제 host metadata·live 설치·활성화는 지원하지 않는다.**

### Task 2 — native artifact와 nonroot unit

- [x] controlled local fixture로 wrong arch/libc·pin/hash mismatch·archive/path/secret 거절, X sentinel 보존·오류 보존·원자 current CAS/replace 실패를 검증했다. 파일 mode는 offline에서 검증했으며 실제 root/nonroot 소유권은 미확인이다.
- [x] prepared-tree `build_release.py`, renderer와 unit/env 예시를 구현했다. npm·CLI 설치/실빌드0. fixture의 inert binary가 실제 ARM 호환성/CLI 버전 증거는 아니다.
- [ ] scheduler/role별 env/health/state가 격리되고 install이 start/migrate/DB activation을 호출하지 않는지 확인한다. failing start 뒤 이전 verified release 참조·원 오류와 cleanup 오류 동시 보존을 테스트한다.

### Task 3 — preflight와 helper의 명시 Oracle 경로

- [ ] Python helper 테스트에서 Oracle 미선택 시 기존 APPS/ORDER/13앱 관련 가정·Dokploy 접근/restore 순서 불변을 확인한다. Oracle action은 macOS Keychain/Dokploy 전체 env 조회 전에 별도 분기한다.
- [ ] 별도 Oracle `plan/install/rollback` 동작은 SHA/native archive/host manifest를 필수로 받아 관리 도구에 위임한다. `--worker-image`에 native 경로를 가장하거나 일반 `run`에 Oracle를 암묵 추가하지 않는다.
- [ ] TypeScript preflight unknown/잘못된 host·release·privilege·expired canary·비참여 budget·site adapter 부재·legacy contract0에 대해 새 claim/false-ready0 테스트를 작성한 뒤 구현한다.
- [ ] DB 필요 검증은 **root가 새 전용 DB를 배정한 뒤** 수행한다. 두 scheduler·producer pause/request 보존, 현재 role/item owner 비간섭, restricted 역할 grant·readiness fail-closed를 실제 회귀로 검증한다. 다른 555xx/운영 DB를 사용하지 않는다.

### Task 4 — runbook·범위 static·소유권 반환

- [ ] runbook에 설치/시작/드레인/고정 rollback·증거 표를 적고 local PASS와 미실행 ARM/운영 절차를 나눈다. 실행 로그/원 RED/실패 접근을 보존한다.
- [ ] 실행한 범위만 보고하고 source/test/manifest SHA를 동결한다. fixture 외행 rawµs/ACL/관리 행·연결 원복을 확인한 뒤 DB를 root에 반환한다. root가 handoff/Git/CI·최종 통합을 취합한다.

예정 scoped 명령(현재 실행 결과 없음):

```sh
python3 -m unittest tests/test_oracle_runtime.py tests/test_deploy_shared_images.py
python3 -m py_compile deploy/oracle/build_release.py deploy/oracle/manage_release.py scripts/ops/deploy_shared_images.py
npx vitest run tests/oracle-runtime-preflight.test.ts tests/role-worker.test.ts tests/worker-supervisor.test.ts tests/scheduler-runtime.test.ts tests/http-origin-policy.test.ts
npx tsc --noEmit --incremental false
npx eslint scripts/ops/oracle-runtime-preflight.ts tests/oracle-runtime-preflight.test.ts tests/integration/oracle-runtime-preflight.test.ts
```

인수 후 실제 바뀐 역할/pool 파일이 있으면 해당 existing test만 추가한다. DB 명령은 배정된 URL로 새 `oracle-runtime-preflight.test.ts`만 실행하며 승인 없이 전체 integration을 실행하지 않는다. `systemd-analyze verify`는 지원되는 격리 Linux 환경의 변경 unit만 대상으로 한다. macOS parser 테스트를 systemd 실제 기동 PASS로 기록하지 않는다.

## 8. 실제 운영 단계 — 코드 납품만으로 체크하지 않을 항목

- [ ] 최신 main 필수 CI/승인 artifact·SHA/checksum, 현재 Oracle identity/ARM/디스크 여유·원 X/Mautic 상태를 좁게 readback한다. Node/CLI/native artifact·정확 최소권한 SQL·PgBouncer timeout/용량을 실제 nonroot 계정으로 검증한다.
- [ ] 기존 M3/mini 역할에서 이동될 job 신규 claim 차단→진행 중 호출 실제 정산/drain→공통 batch 전환 순서. producer 요청·사람 판단·pause·미확정 charge를 유지한다. TTL/heartbeat 소실만으로 외부 종료를 확정하지 않는다.
- [ ] 독립 scheduler와 예비 candidate부터 시작한다. 현재 owner 비선점 및 host 전체 CPU/RSS/DB/HTTP/번역 budget 아래 heartbeat 여유를 측정한다. 미확정 capability를 채워 넣어 선출하지 않는다.
- [ ] 번역3종 각각 실제 승인 저장·현재 source/hash/세대·locale/검증기 readback을 확인한다. 전체 언어 backfill, crawl-tagline/embedding/keyword 이전은 하지 않는다. API endpoint·모델은 현재 승인된 설정 그대로다.
- [ ] canonical due10·공식 due source1의 실제 결과/관계·후속 요청/partial/304를 readback한다. GitHub quota와 독립 처리 여부를 확인하되 GitHub 업무를 Oracle에 임의 이전하지 않는다.
- [ ] uptime은 먼저 Oracle **raw-only** 관측/6h slot과 M3·mini 비교를 확인한다. 지역403/timeout/광역 장애·공백 hold가 counter/checkedAt·기존 sweep/final commit까지 막는지 확인한 후 별도 gate 단계로 간다. 원3/10 임계값·유효10회 audit/CDN·사람 결정은 보존한다.
- [ ] 생존 DB·모델 조건을 명시하고 M3/mini 역할 중단→Oracle 만료 후 인계, Oracle 중단→M3/mini 인계를 검증한다. 직접 SQL/독립 scheduler·원 token fencing·무중복 결과·회복 시간을 기록한다. 실제로 중단하지 않은 host는 시험 완료로 세지 않는다.
- [ ] 24시간 실제 정상 업무의 고유 결과·oldest age·실패/hold·budget·RSS/CPU·heartbeat와 X 독립성을 관측한다. 설치·빈 큐 성공/하나의 canary를 대체 증거로 사용하지 않는다.

최소 웹/관리자·독립 embedding·DB/모델 동반 상실 및 logical DR/RPO/RTO는 PR14–17의 별도 조건이다. M3/mini 앱만 중단하고 DB/모델은 살아 있는 시험을 전체 DR 완료라고 하지 않는다.

## 9. rollback과 보존 금지선

- 새 Oracle claim부터 막고 실제 inflight 정산/미확정 상태를 readback한다. approved 이전 SHA의 artifact/계약 호환성을 확인한 뒤 원자 current link·해당 core unit만 되돌린다. schema downgrade/table DROP/작업·quota·실패 이력 reset/기존 token 강제 폐기는 하지 않는다.
- 구 release가 새 batch/schema를 지원하지 않으면 그것을 시작하지 않는다. 호환 release가 없으면 core를 멈춘 채 준비된 M3/mini 경로를 사용한다. rollback 성공도 실제 release/DB readiness readback 전에는 unknown이다.
- X의 `/opt/nomorevibe-x`, `/etc/nomorevibe-x.env`, `/var/lib/nomorevibe-x`, `nomorevibe-x.service/.timer`, UTC 하루10 장부·목적 승인/live gate는 읽기 보존 대상이다. PR11 launcher에 X를 포함하거나 동일 계정/env/상태 경로를 재사용하지 않는다.
- Mautic 백업 `/var/backups/nomorevibe/mautic-retired-20261015T050901Z`와 남은 DB·unit backup은 삭제/권한변경/복원하지 않는다. X runbook에 있는 과거 Mautic 정리 이전 조사 내용을 현재 서비스 상태로 오인하지 않는다.
- `onetwoday`, M3·mini 기존13앱, 원본 X branch, secrets/SSH/OCI/Tailscale/모델 제공 설정은 이 계획 작성으로 변경되지 않는다.

## 10. 남은 확정값과 완료 판정

아직 미확정: 승인 OCI full identity·metadata 대조 경로, native artifact build 환경/정확 Node·CLI checksum, 서비스별 최소권한 집합/최초 genuine canary entry, host 전체 DB/CPU/RSS·heartbeat 예산과 실제 모델 slot 연결, PR08↔PR10 canonical-only 등록. 이 값이 없으면 관련 install/start/readiness는 fail-closed다. 새 boolean이나 문서의 체크 표시로 대체하지 않는다.

**현 단계 완료:** 계획과 승인된 Task1/2의 독립 Python/offline 기반. 지정23개 Python 회귀·원6개 재실행·변경 Python compile이 실제 exit0이었다(상세 검증 문서 참조). Task1 첫 main/API 인수와 Task3는 미완료다. **미실행:** 실제 native dependency/CLI 설치·artifact 빌드, ARM/systemd/Oracle 접속·인증 SQL·설치·권한·기동·실제 업무·24h·장애 전환. launcher는 항시 exit78이고 live `/` 설치 경로는 거절한다. PR11 전체 기능·운영 배포 완료로 세지 않는다.
