# Oracle osaka-smoke 종단 간 활성화·DR runbook (PR11f, 2026-10-17)

대상은 **surfguide / ap-osaka-1 / osaka-smoke**다. 이 문서는 절차만 적는다. 작성하면서 운영 DB·SSH·OCI·배포·provider 호출은 하지 않았고, 문서의 명령도 실행하지 않았다. 실행한 것은 `scripts/ops/oracle_activation_check.py`의 구문 검사(`bash -n`)와 코드 대조뿐이다.

- 기준 코드: integration-3 (`9c92f983`). integration-2에 PR15c #515, PR11e #513(0098), PR01b-8 #509(0097), PR05c-6 #510, PR05d #511, PR16b #512, PR13c #514를 더한 상태다.
- 함께 읽을 문서: `deploy/oracle/README.md`(offline 패키징·canary·refresh 정책), `docs/superpowers/plans/2026-10-16-pipeline-pr11-oracle-runtime.md`, `docs/operations/independent-workers-runbook.md`.
- 운영 배포 도우미는 이 문서에서 "운영 도우미(prod.sh)"라고만 부른다. 이 저장소에는 없다.

## 요약 — 지금 코드로 어디까지 갈 수 있나

**결론: 0–3단계(설치·권한·env·unit 설치)는 승인만 있으면 실행할 수 있다. 4단계부터는 코드가 막는다. 7단계 DR 도구와 8단계 embedding parity 도구는 따로 쓸 수 있다.**

| 막는 것 | 내용 | 근거 | 풀려면 |
| --- | --- | --- | --- |
| B1 제어값 운영 도구 없음 | `job_batch_control`의 policy·writer contract·mode 전이, `http_origin_control`의 policy·open, `model_capacity_control`의 policy·open을 운영자가 쓰는 경로가 없다. 전이 함수는 테스트에서만 부른다. HTTP를 열지 못하면 canary의 `capability.http`가 `verified`가 될 수 없고, 이 값은 모든 역할의 readiness 조건이다. | `lib/jobs/batch-repository.ts:205-238`(호출자 없음), `lib/runtime/oracle-canary.ts:93-102`, `lib/jobs/batches.ts:57-60`, `lib/operations/dr/permits.ts:37,82`(DR 승격 뒤에만 open) | 인벤토리 7a·7b·8c(PR06d 제어면 CLI) |
| B2 versioned 전환은 전 fleet 전환 | `versioned`가 되면 legacy 선출(`tryAcquireRole`)이 null을 돌려주고, lease 없는 직접 실행도 batch admission에서 막힌다. M3·mini의 다섯 역할(주·예비) 워커가 일을 멈춘다. 계속 일하려면 M3·mini 워커도 `JOB_BATCH_VERSION=1`과 검증된 capability·result 증거가 있어야 한다. 그런데 그 증거를 쓰는 코드는 Oracle canary뿐이고, canary는 Oracle 4역할·Oracle host만 받는다. 같은 이유로 M3·mini가 Oracle 역할을 인계받을 수도 없다. | `lib/jobs/role-leader.ts:45-51`, `lib/jobs/batch-repository.ts:28-45,132`, `lib/jobs/batches.ts:57-60`, `lib/runtime/oracle-canary.ts:23-27,154,240`(capability를 쓰는 유일한 곳) | 사용자 결정과 새 lane(M3·mini 후보 증거 발급, 또는 혼합 운용 설계) |
| B3 Oracle scheduler 기동 불가 | preflight가 scheduler에서 `scheduler_canary_unavailable`로 끝나 `workload.ready`가 늘 false다. launcher는 이 값이 true여야 실행하므로 scheduler unit은 항상 exit 78이다. | `lib/runtime/oracle-preflight.ts:89`, `deploy/oracle/launch.py:149-150`, `deploy/oracle/README.md:90` | scheduler canary 설계(미배정) |
| B4 번역 model proof | 번역은 tick이 남긴 capacity 장부 행이 계약에 묶여 정산돼야 `model: verified`가 된다. 장부 행은 model capacity가 `open`일 때만 생긴다. `open`은 전역 스위치라서 계약이 없는 route는 모두 미뤄진다. 번역 3경로 계약은 abcLLM PR3 배포와 readback이 있어야 채울 수 있다. | `lib/runtime/oracle-model-evidence.ts:47-81`, `lib/llm/text-capacity-admission.ts:14-19`, `lib/llm/gateway-serving-contract-config.ts:16-27` | 인벤토리 4·11b, abcLLM PR3, B1 |
| B5 Oracle이 실행할 수 있는 역할 | launcher는 10역할을 받지만 preflight 입력은 4개 분리 역할과 scheduler뿐이다. crawler·reviewer·publisher·text·maintenance는 preflight가 거절해 exit 78이다. 비상 모드에서도 Oracle이 M3·mini 역할을 대신하지 못한다. | `deploy/oracle/launch.py:20-21`, `lib/runtime/oracle-preflight.ts:13`, `lib/runtime/oracle-canary.ts:23` | 설계 결정(미배정) |
| B6 운영 반영 상태 | GitHub main(`9a3c8077`, 2026-10-17T00:17Z)의 마지막 migration은 0084이고 `deploy/oracle`에 `least-privilege.sql`·`install_units.py`·`oci_identity.py`가 없다. integration-3과 main은 갈라져 있다(compare: ahead 124 / behind 33). 운영 DB는 0082까지 적용된 상태로 전달받았다(이번에 직접 확인하지 않음). | `gh api .../contents/drizzle/meta/_journal.json?ref=main`(85항목, 끝 `0084_model_capacity_terminal`), `gh api .../compare/main...9c92f983` | root의 main 병합, 0083–0098 적용, 13앱 배포 |

## 표기 규칙

- 각 단계는 **목적 · 명령 · 성공 readback · 중단 조건 · 되돌리기 · 승인 · 근거** 순서로 적는다.
- 비밀값은 문서·셸 기록·명령 인자에 쓰지 않는다. URL과 비밀번호는 env 파일(root 0600), `~/.pgpass`(0600), stdin으로만 넘긴다.
- 코드나 저장소 문서로 확인하지 못한 것은 **확인 필요**라고 적는다. 추측한 값을 사실처럼 쓰지 않는다.
- 셸 변수 약속:

| 변수 | 뜻 |
| --- | --- |
| `SRC` | 승인한 SHA의 source export 루트. `deploy/oracle`의 설치 도구는 release에 들어가지 않으므로 여기서 실행한다(`deploy/oracle/release_contract.py:19-20,49-50`) |
| `APPROVED_RELEASE_SHA` | 승인한 40자리 소문자 SHA |
| `PREPARED_NATIVE_TREE`, `NEW_ARCHIVE_PATH`, `APPROVED_EXACT_NODE_VERSION` | README 준비 절차의 결과 tree, 새 archive 경로, 승인한 Node 24 정확 버전 |
| `ARCHIVE_PATH`, `APPROVED_ARCHIVE_SHA256` | 검증할 archive와 승인 채널로 받은 sha256 |
| `APPROVED_IDENTITY_FILE` | `oracle-identity.json.example` 형식의 승인 identity(OCID·shape) |
| `APPROVED_HOST_RECORD` | `oracle-host.json.example` 형식의 승인 host record |
| `RECORDED_HOST_READBACK` | `oci_identity.py`가 출력한 host record 파일 |
| `OWN_OFFLINE_ROOT` | Oracle의 root 소유 offline staging root(절대 경로, `/` 금지, `nomorevibe-x`·`mautic` 이름 금지). 값은 사용자 결정 |
| `ROLE`, `JOB` | `translation`·`product-health`·`site-evidence`·`official-news` 중 하나와 그 역할의 versioned 잡 |

역할별 versioned 잡(`lib/jobs/batches.ts:20-24`): translation=`reason-translate`·`product-tagline-ko`·`product-translate`, product-health=`uptime-ping`, official-news=`news-refresh`, site-evidence=`product-site-evidence-refresh`.

---

## 0. 사전 조건

### 0.1 운영 DB migration 0083–0098

- **목적:** Oracle 경로가 쓰는 표·트리거(0095 writer fence, 0098 증거 INSERT guard 등)를 운영 DB에 둔다.
- **현재 상태 readback(읽기 전용):**

```sql
-- 운영 primary. drizzle 마이그레이터는 마지막 created_at 보다 큰 journal 항목만 적용한다.
SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 3;
```

  마지막 `created_at`이 `1793500000000`(0082)이면 0083–0098의 16개가 남은 것이다. 각 journal의 `when`은 `drizzle/meta/_journal.json`에 있다(0098=`1794086400010`).

- **명령:** 기존 운영 절차를 그대로 따른다. 소비자를 drain하고, 검증한 worker 이미지의 `scripts/migrate.mjs`를 PostgreSQL 직접 연결(5432)에서 한 번 실행하고, 종료 코드 0을 확인한 뒤에 앱을 시작한다. 실행 위치와 wrapper(이미지 실행 방식 또는 운영 도우미(prod.sh))는 **확인 필요**다.

```bash
# MIGRATION_DATABASE_URL 은 비밀 저장소에서 env 로만 넣는다(인자·출력 금지). 직접 연결 5432.
node scripts/migrate.mjs
echo "migrate exit=$?"
shasum -a 256 "$SRC"/drizzle/00{83..98}_*.sql
```

- **성공 readback:** 종료 코드 0, 출력 `[migrate] 완료`. 위 SQL의 마지막 `created_at`이 `1794086400010`이고, 16행의 `hash`가 `shasum` 값과 같다(마이그레이터는 파일 전체의 sha256을 저장한다, `node_modules/drizzle-orm/migrator.js:22-23`).
- **중단 조건:** 종료 코드가 0이 아님, hash 불일치, drain되지 않은 소비자. 이때 앱을 시작하지 않는다.
- **되돌리기:** schema downgrade는 없다. 실패하면 앱을 시작하지 않은 채 원인을 고친다. 기존 DB를 초기화하거나 덤프로 덮지 않는다.
- **승인:** 필요(운영 DB 쓰기).
- **근거:** `scripts/migrate.mjs:13-29`, `scripts/migration-config.mjs:1-3`, `docs/operations/independent-workers-runbook.md:70-75,110-111`, `docs/operations/2026-10-11-github-integration-rollout.md:28-31`.

### 0.2 main 병합과 13앱 배포

- **목적:** Oracle release SHA와 운영 앱의 코드가 같은 계약(0095 fence 관문 등)을 쓰게 한다. versioned에서는 batch policy의 `release`가 하나뿐이다(`lib/jobs/batches.ts:9`).
- **명령:** root가 integration-3을 main에 병합하고 필수 CI `check`가 통과한 뒤, 기존 절차로 13앱을 배포한다. 배포 결과는 읽기 전용 inventory로 확인한다(운영자 Mac, Dokploy API 읽기).

```bash
python3 scripts/ops/deploy_shared_images.py inventory --sha "$APPROVED_RELEASE_SHA"
```

- **성공 readback:** `complete: true`, `pending: []`. `oracle: outside_dokploy`는 정상이다(Oracle은 Dokploy 밖이다).
- **중단 조건:** `releaseMatches: false`인 앱이 있음.
- **되돌리기:** 기존 운영 절차의 앱별 이전 이미지·source 복구(`deploy_shared_images.py restore` 등).
- **승인:** 병합·배포는 필요. inventory는 운영 API 읽기라 실행 전에 알린다.
- **근거:** `scripts/ops/deploy_shared_images.py:642-660`.

### 0.3 사용자 결정 목록

| # | 결정 | 영향 단계 | 근거 |
| --- | --- | --- | --- |
| D1 | Oracle capability refresh 정책: A(Oracle host timer, 별도 `nomorevibe_oracle_refresh` principal) 또는 B(M3/mini 원격 실행). 정하지 않으면 선출된 역할은 15분 안에 claim을 멈춘다. | 2, 4 | `deploy/oracle/README.md:112-124`, `lib/jobs/batches.ts:61-62` |
| D2 | `nomorevibe-core.slice`의 CPUQuota %·MemoryMax bytes·TasksMax(실측 뒤 명시, 기본값 없음) | 3 | `deploy/oracle/manage_release.py:18-28` |
| D3 | 역할별 DB connection limit(psql 변수 8개 — consumer `agent-scan`·`uptime` 포함)과 `HOST_DB_BUDGET` 선언(roles·replicas) | 2, 3 | `deploy/oracle/least-privilege.sql:3`, `lib/db/host-budget.ts:7-15,39-69` |
| D4 | `HOST_BUDGET_ENFORCEMENT` 압박 한도 4개(maxLoadPerCpu·maxHostRssBytes·maxEventLoopDelayMs·maxHeartbeatGapMs) | 3, 8 | `lib/operations/host-budget.ts:12-32` |
| D5 | 비상 예산 값 `{jobs, modelJobs, httpJobs, agingMs}`과 `verifiedModelJobs` 목록(빈 목록도 명시) | 8 | `lib/operations/emergency-admission.ts:14-35`, `lib/operations/emergency-priority.ts:73-74` |
| D6 | 비상 독립 provider(번역·심사 등)와 비용 상한 | 5, 8 | `/tmp/nomorevibe-pr16-emergency-design-20261017.md` 5장 |
| D7 | 비상 embedding: Oracle CPU llama.cpp(같은 GGUF) 채택 또는 degraded 확정. parity 기준 0.999·32 승인 | 8 | `lib/domain/products/embedding.ts:44-49` |
| D8 | DNS·Cloudflare tunnel 전환 절차와 권한 소유자, 비상 web 배포 방식과 web DB role | 7, 8 | PR16 설계 7장·12장 |
| D9 | versioned 전환 전략(B2). 전 fleet을 versioned 워커로 바꿀지, 새 증거 발급 lane을 먼저 만들지 | 4, 6 | 요약 B2 |
| D10 | Oracle 역할별 `SERVICE_INSTANCE_ID` 값(48자 이하, `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$`). batch policy와 HTTP policy에 같은 값이 들어가야 한다 | 3, 4 | `lib/operations/instance.ts:16-29`, `lib/net/http-origin-policy.ts:5-8` |
| D11 | seed 동안 M3·mini의 legacy 부모 역할(official-news·product-health는 maintenance, translation은 text) 정지 허용 시간 | 4 | `lib/runtime/oracle-canary.ts:183-190`, `lib/jobs/catalog.ts:42,69,71,87,95` |
| D12 | canary를 실행할 OS 계정과 attest URL 보관 위치(worker 계정이 읽을 수 없어야 한다) | 4 | `deploy/oracle/README.md:118-120` |
| D13 | 신규 발굴 재개 시점. canary와 24h 관측에는 실제 일감이 필요하다(지금 GitHub·Show HN 발굴 중단) | 4, 6 | `AGENTS.md`, 인벤토리 5번 |

---

## 1. ARM 릴리스 빌드·offline 패키지·SHA 고정

- **목적:** 승인 SHA의 Linux/aarch64/glibc native release를 만들고, Oracle의 offline root에 고정 SHA로 설치한다. 이 단계는 unit·env·DB를 건드리지 않는다.
- **명령 (a) 빌드 환경:** README 준비 절차 1–4(승인 SHA source export, `npm ci --omit=dev`, Node 24 binary, 고정 CLI 3종)를 끝낸 tree를 패키징한다. 패키저는 Linux/aarch64/glibc가 아니면 거절한다.

```bash
python3 "$SRC/deploy/oracle/build_release.py" --prepared "$PREPARED_NATIVE_TREE" \
  --output "$NEW_ARCHIVE_PATH" --sha "$APPROVED_RELEASE_SHA" \
  --node-version "$APPROVED_EXACT_NODE_VERSION"
python3 "$SRC/deploy/oracle/manage_release.py" inspect \
  --archive "$NEW_ARCHIVE_PATH" --archive-sha256 "$APPROVED_ARCHIVE_SHA256"
```

- **명령 (b) Oracle host(root):** 승인 identity를 먼저 두고 IMDSv2와 대조한 뒤 설치한다. offline 도구는 Python 3.11 이상이 필요하다(`deploy/oracle/README.md:7`).

```bash
install -d -m 0755 -o root -g root /etc/nomorevibe-core
install -m 0644 -o root -g root "$APPROVED_IDENTITY_FILE" /etc/nomorevibe-core/oracle-identity.json
python3 "$SRC/deploy/oracle/oci_identity.py" --approved /etc/nomorevibe-core/oracle-identity.json > "$RECORDED_HOST_READBACK"
python3 "$SRC/scripts/ops/deploy_shared_images.py" oracle-plan \
  --sha "$APPROVED_RELEASE_SHA" --archive "$ARCHIVE_PATH" \
  --archive-sha256 "$APPROVED_ARCHIVE_SHA256" \
  --expected-host "$APPROVED_HOST_RECORD" --observed-host "$RECORDED_HOST_READBACK"
python3 "$SRC/scripts/ops/deploy_shared_images.py" oracle-install \
  --sha "$APPROVED_RELEASE_SHA" --archive "$ARCHIVE_PATH" \
  --archive-sha256 "$APPROVED_ARCHIVE_SHA256" --staging-root "$OWN_OFFLINE_ROOT" \
  --expected-host "$APPROVED_HOST_RECORD" --observed-host "$RECORDED_HOST_READBACK"
readlink "$OWN_OFFLINE_ROOT/opt/nomorevibe-core/current"
```

- **명령 (c) live 경로 연결 — 확인 필요:** launcher와 unit은 `/opt/nomorevibe-core`를 고정으로 쓴다. 그런데 `manage_release.py`는 `/`를 staging root로 받지 않는다. 둘을 잇는 도구나 문서는 없다. launcher 주석은 `/opt/nomorevibe-core`가 offline root를 가리키는 symlink인 경우를 링크와 대상 양쪽에서 검사한다고 적고 있다. 아래 명령은 그 주석에 맞춘 **제안**이며 검증하지 않았다.

```bash
ln -s "$OWN_OFFLINE_ROOT/opt/nomorevibe-core" /opt/nomorevibe-core
readlink /opt/nomorevibe-core/current
```

- **성공 readback:**
  - 빌드: `{"archiveSha256":…,"manifestSha256":…,"releaseSha":"<SHA>"}`. `archiveSha256`를 승인 채널에 기록한다.
  - `inspect`: `releaseSha`가 승인 SHA, `readiness: "unverified"`.
  - `oci_identity.py`: exit 0, stdout이 host record 6필드.
  - `oracle-install`: `readiness: "unverified"`, `activationAllowed: false`, `previous: null`(첫 설치), `current: <SHA>`.
  - `readlink`: `releases/<SHA>`.
  - launcher는 release tree의 모든 항목이 uid 0 소유이고 group/other 쓰기가 없기를 요구한다. 그래서 설치는 root로 한다.
- **중단 조건:** `native_builder_requires_linux_arm64_glibc`, `artifact_hash_mismatch`, `oracle_release_sha_mismatch`, `oracle_identity_unverified`, `current_release_changed`, `offline_staging_root_required`.
- **되돌리기:** 이 단계에는 실행 중인 것이 없다. 이전 release로 돌리려면 6.3의 `oracle-rollback`을 쓴다. 도구에는 staged release 삭제 기능이 없으므로 지우지 않는다.
- **승인:** 필요(빌드 환경 사용, Oracle root 작업, IMDS 조회).
- **근거:** `deploy/oracle/build_release.py:20-22,99-110`, `deploy/oracle/manage_release.py:97-110,239-268`, `deploy/oracle/oci_identity.py:107-118`, `scripts/ops/deploy_shared_images.py:682-714`, `deploy/oracle/launch.py:26,58-76`, `deploy/oracle/README.md:18-71`.

## 2. 운영 DB principal 생성과 권한 readback

- **목적:** Oracle 서비스별 최소권한 LOGIN role 6개(translation·product-health·site-evidence·official-news·scheduler·attest)와 consumer role 2개를 만든다 — 제작 근거 스캔 `nomorevibe_oracle_agent_scan`(SQL 파일의 `-- consumer agent-scan` 절), uptime `nomorevibe_oracle_uptime`(`-- consumer uptime` 절, split claim·제출만). D1이 A면 refresh principal도 만든다.
  6개 role 이 이미 있으면 파일 전체를 다시 실행하지 않는다(`CREATE ROLE` 충돌로 트랜잭션 전체가 취소된다). 그때는 승인을 받아 필요한 consumer 절(`-- consumer agent-scan`·`-- consumer uptime`)만 `BEGIN`/`COMMIT` 으로 감싸 실행한다.
- **명령:** 관리자 연결은 URL에 비밀번호를 넣지 않고 `~/.pgpass`(0600)나 프롬프트를 쓴다. 관리자 자격 보관 위치는 **확인 필요**다. SQL 파일은 한 트랜잭션이다.

```bash
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v translation_connections="$TRANSLATION_CONNECTIONS" \
  -v product_health_connections="$PRODUCT_HEALTH_CONNECTIONS" \
  -v site_evidence_connections="$SITE_EVIDENCE_CONNECTIONS" \
  -v official_news_connections="$OFFICIAL_NEWS_CONNECTIONS" \
  -v scheduler_connections="$SCHEDULER_CONNECTIONS" \
  -v attest_connections="$ATTEST_CONNECTIONS" \
  -v uptime_connections="$UPTIME_CONNECTIONS" \
  -v agent_scan_connections="$AGENT_SCAN_CONNECTIONS" \
  -f "$SRC/deploy/oracle/least-privilege.sql"
# D1 이 A 일 때만
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -v refresh_connections=1 -f "$SRC/deploy/oracle/refresh-principal.sql"
```

  비밀번호는 대화형 psql에서 설정한다. 값은 어디에도 출력하지 않는다.

```psql
\password nomorevibe_oracle_translation
\password nomorevibe_oracle_product_health
\password nomorevibe_oracle_site_evidence
\password nomorevibe_oracle_official_news
\password nomorevibe_oracle_scheduler
\password nomorevibe_oracle_attest
\password nomorevibe_oracle_agent_scan
\password nomorevibe_oracle_refresh
\password nomorevibe_oracle_uptime
```

- **비밀번호 보관 위치(값은 쓰지 않는다):**
  - 각 worker principal: 해당 역할 env 파일 `/etc/nomorevibe-core/<role>.env`의 `DATABASE_URL`(root 0600).
  - consumer principal `nomorevibe_oracle_agent_scan`: `/etc/nomorevibe-core/consumer-agent-scan.env`의 `DATABASE_URL`(root 0600).
  - consumer principal `nomorevibe_oracle_uptime`: `/etc/nomorevibe-core/consumer-uptime.env`의 `DATABASE_URL`(root 0600).
  - refresh principal: `/etc/nomorevibe-core/refresh.env`의 `ORACLE_ATTEST_DATABASE_URL`(root 0600, refresh unit 전용 계정 `nomorevibe-attest`가 쓴다).
  - attest principal: worker 계정이 읽을 수 없는 곳(D12). 역할 env 파일에 넣지 않는다.
  - Oracle에서 붙는 경로(PgBouncer auth 설정, pg_hba의 Oracle 주소 허용)는 저장소에 없다. **확인 필요.**
- **connection limit 참고:** 선언 catalog는 역할당 role-parent 1 + worker 3(scheduler는 1 + 2)이고, launcher preflight가 같은 principal로 1개를 더 연다. 실측값이 아니므로 값은 D3에서 정한다(`lib/db/host-budget.ts:39-69`, `deploy/oracle/launch.py:129-133`).
- **성공 readback(읽기 전용):**

```sql
SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit, rolconnlimit, rolconfig
FROM pg_roles WHERE rolname LIKE 'nomorevibe\_oracle\_%' ORDER BY rolname;

-- 0095 writer fence: 4 worker + scheduler 는 SELECT 와 id 열 UPDATE(잠금용)만, attest 는 둘 다 없음, 표 전체 UPDATE 는 모두 false
SELECT r AS role,
  has_table_privilege(r, 'public.dr_writer_fence', 'SELECT') AS fence_select,
  has_column_privilege(r, 'public.dr_writer_fence', 'id', 'UPDATE') AS fence_lock,
  has_table_privilege(r, 'public.dr_writer_fence', 'UPDATE') AS fence_update_all,
  has_column_privilege(r, 'public.job_batch_candidates', 'capability', 'UPDATE') AS capability_update,
  has_column_privilege(r, 'public.job_batch_candidates', 'result_evidence', 'UPDATE') AS evidence_update
FROM unnest(ARRAY['nomorevibe_oracle_translation','nomorevibe_oracle_product_health','nomorevibe_oracle_site_evidence',
  'nomorevibe_oracle_official_news','nomorevibe_oracle_scheduler','nomorevibe_oracle_attest']) AS r;

-- 0098 증거 INSERT guard 트리거와 번역 readback 인덱스
SELECT t.tgname, t.tgenabled, p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
WHERE t.tgrelid = 'public.job_batch_candidates'::regclass AND NOT t.tgisinternal;
SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'model_capacity_requests_job_readback_idx';
```

  기대값:
  - 6개 role 모두 `rolcanlogin=t`이고 super·createdb·createrole·replication·bypassrls·inherit는 `f`다. `rolconfig`에 `statement_timeout`(scheduler 10s, 나머지 60s), `lock_timeout=5s`, `idle_in_transaction_session_timeout=60s`가 있다.
  - consumer role `nomorevibe_oracle_agent_scan`·`nomorevibe_oracle_uptime`도 같고, `rolconfig`에 `statement_timeout=10s`와 `TimeZone=UTC`가 더 있다. 최종 판정은 각 consumer preflight(`worker-oracle-preflight.ts --consumer=agent-scan`·`--consumer=uptime`)의 `checks.database = verified`다.
  - fence: translation·product-health·site-evidence·official-news·scheduler는 `fence_select=t`, `fence_lock=t`, `fence_update_all=f`. attest는 셋 다 `f`.
  - `capability_update`·`evidence_update`: worker 4개와 scheduler는 `f`, attest는 `t`.
  - 트리거 `job_batch_candidates_evidence_insert_guard`(`tgenabled=O`)와 인덱스 1행.
  - 최종 판정은 4단계 preflight의 `checks.database = verified`다. 이 값은 실제 권한 catalog가 profile과 정확히 같을 때만 나온다.
- **중단 조건:** `CREATE ROLE` 충돌(이미 있음), 기대값과 다른 권한, 트리거·인덱스 없음(0098 미적용).
- **되돌리기(운영 DB 쓰기, 승인 필요):** SQL 실패는 트랜잭션 전체가 취소된다. 성공한 뒤 되돌리려면 role마다 `DROP OWNED BY <role>; DROP ROLE <role>;`을 실행한다. 이 role들이 소유한 객체는 없다.
- **승인:** 필요(운영 DB에 role 생성).
- **근거:** `deploy/oracle/least-privilege.sql:1-176`, `deploy/oracle/refresh-principal.sql:1-20`, `lib/runtime/oracle-db-profile.ts:21-63,77-93,118-134`, `drizzle/0095_dr_writer_fence.sql:3-16`, `drizzle/0098_oracle_activation_gaps.sql:5-18`, `lib/runtime/oracle-preflight.ts:120-138`.

## 3. Oracle host env 배치와 systemd unit 설치

### 3.1 unit 설치(enable·start 없음)

- **목적:** 측정한 slice 한도로 unit을 렌더링해 설치하고 역할별 env placeholder를 만든다. 도구는 `systemctl daemon-reload`만 실행하며 enable·start는 하지 않는다. scheduler는 B3 때문에 `--role`에서 뺀다(scheduler env는 만들지 않는다). 렌더러는 slice·role 템플릿·scheduler unit 파일 3개를 항상 함께 쓴다.
- **명령(root):**

```bash
python3 "$SRC/deploy/oracle/install_units.py" --root / --apply \
  --cpu-quota-percent "$CORE_CPU_QUOTA_PERCENT" --memory-bytes "$CORE_MEMORY_BYTES" --tasks "$CORE_TASKS_MAX" \
  --role official-news --role product-health --role site-evidence --role translation
# D1 이 A 일 때는 같은 명령에 역할마다 --refresh-role 을 더한다. 예: --refresh-role official-news
systemctl cat nomorevibe-core.slice nomorevibe-core-role@official-news.service --no-pager
ls -l /etc/nomorevibe-core
```

- **성공 readback:** 출력 JSON의 `enabled: []`, `started: []`, `timersEnabled: []`, `activationAllowed: false`. `written`에 unit 3개와 env 파일 4개가 있다. 이미 있던 env 파일은 `preserved`에 나오고 다시 쓰지 않는다. env 파일은 root 0600, `/etc/nomorevibe-core`는 0755다. slice에 D2 값이 들어 있다.
- **중단 조건:** `{"code":"oracle_unit_install_failed"}`(`install_root_apply_mismatch`, `install_path_symlink`, `service_account_lookup_failed` 등).
- **되돌리기:** unit 파일을 지우고 `systemctl daemon-reload`를 실행한다. env 파일에 비밀이 들어갔다면 안전하게 폐기한다. 서비스 계정(`nomorevibe-core`, `nomorevibe-attest`)은 남겨도 활성화되지 않는다.
- **승인:** 필요(Oracle root, 계정 생성).
- **근거:** `deploy/oracle/install_units.py:22-29,69-116,119-135`, `deploy/oracle/nomorevibe-core-role@.service:1-33`, `deploy/oracle/nomorevibe-core.slice:1-11`.

### 3.2 역할 env 파일 채우기

- **목적:** launcher·preflight·canary가 읽는 키를 채운다. 아래 키 이름은 코드에서 확인했다. 비밀 값은 비워 둔 채로 보이고, 실제로는 root가 편집기로 채운다.
- **4역할 공통(`/etc/nomorevibe-core/<role>.env`):**

```env
# launcher·preflight·canary identity (deploy/oracle/launch.py:61-66,91-94, lib/runtime/oracle-canary.ts:33-38)
SERVICE_INSTANCE_ID=
RELEASE_TAG=
PHYSICAL_HOST=oracle-osaka-smoke
JOB_BATCH_VERSION=1
WORKER_ROLE=
# 역할 principal, PgBouncer 경유 (lib/db/pool.ts:45-56, lib/runtime/oracle-preflight.ts:131)
DATABASE_URL=
DB_POOLER_MODE=pgbouncer
# 숫자를 넣거나 줄을 지운다. 빈 값이면 pool 설정이 시작을 거절한다 (lib/db/pool.ts:31-36)
DB_POOL_MAX=
# 이 역할·host·release 의 host DB 예산 선언(JSON 한 줄) (lib/db/host-budget.ts:103-119)
HOST_DB_BUDGET=
# canary 의 http capability 와 host 예산 장부가 요구한다(1 이 아니면 http 는 unknown) (lib/runtime/oracle-canary-cli.ts:44)
HTTP_ORIGIN_PERMITS=1
```

  - `HTTP_ORIGIN_PERMITS=1`이면 모든 HTTP hop이 공유 permit 장부를 거친다. `http_origin_control`이 `open`이 아니면(B1) hop마다 `http_origin_permit_unavailable`로 거절된다(`lib/net/origin-permits.ts:46-48`, `lib/net/http-origin-policy.ts:22-27`).
  - `HOST_BUDGET_ENFORCEMENT`(D4)와 `EMERGENCY_ADMISSION`(8단계)은 처음에는 **줄 자체를 두지 않는다**. 그것이 비활성이다. 빈 값으로 두면 JSON 해석에 실패해 프로세스가 시작을 거절한다(`lib/operations/host-budget.ts:24-32`, `lib/operations/emergency-admission.ts:26-35`).

- **translation만:**

```env
ABCLLM_API_KEY=
ABCLLM_BASE_URL=
ABCLLM_MODEL=
# 5단계 readback 전에는 줄을 두지 않는다. 없거나 틀리면 모든 계약이 null 이다 (lib/llm/gateway-serving-contract-config.ts:9-11,52)
ABCLLM_SERVING_CONTRACTS=
```

- **refresh.env(D1=A):**

```env
ORACLE_ATTEST_DATABASE_URL=
```

- **`HOST_DB_BUDGET` 모양:** 같은 host의 모든 프로세스가 같은 policy(roster)를 선언해야 장부가 성립한다(`lib/operations/host-budget.ts:52-62`). 아래는 official-news의 예이며, 숫자는 D3에서 정한다. 형식은 launcher 테스트 fixture와 같다(`tests/test_oracle_activation.py:254-262`).

```json
{"mode":"enabled",
 "policy":{"version":1,"host":"oracle-osaka-smoke","release":"<APPROVED_RELEASE_SHA>",
   "roles":["official-news","product-health","site-evidence","translation"],
   "schedulerReplicas":0,"webReplicas":0,"webReadReplica":false,"monitor":false,"connectAgent":false,
   "preflightProcesses":1,"migrationProcesses":0,"rolloutCopies":1},
 "process":{"host":"oracle-osaka-smoke","release":"<APPROVED_RELEASE_SHA>","replica":1,"copy":1,"kind":"role-parent","role":"official-news"}}
```

  env 파일에는 이 JSON을 한 줄로 넣는다. systemd `EnvironmentFile`에서 JSON의 큰따옴표가 그대로 전달되는 따옴표 방식은 **확인 필요**다(작은따옴표로 감싸는 방식을 제안한다). 실제 판정은 다음 3.3의 launcher가 한다.

- **성공 readback:** 3.3에서 launcher가 `budget` 단계를 통과한다.
- **중단 조건:** `host_db_budget_undeclared`, `host_db_budget_invalid`.
- **되돌리기:** env 파일을 이전 값으로 되돌린다. 아직 프로세스는 없다.
- **승인:** 필요(비밀 배치).
- **근거:** `deploy/oracle/role.env.example:1-17`, `deploy/oracle/refresh.env.example:1-4`, `deploy/oracle/launch.py:85-109`, `lib/crawl/translate.ts:16-17`, `lib/crawl/reason-translation-model-capacity.ts:30`. 그 밖의 역할별 비밀(뉴스·uptime·site 수집에 필요한 키가 있는지)은 **확인 필요**다.

### 3.3 launcher 사전 확인(DB 쓰기 없음)

- **목적:** 실제 unit 환경에서 release·계정·slice·identity 검사를 통과하는지 본다. 이 시점의 batch는 `legacy`이므로 preflight가 `batch`를 `rejected`로 내고, launcher는 role-worker를 띄우기 전에 exit 78로 멈춘다. preflight는 `job_batch_control`을 `FOR SHARE`로 읽기만 한다.
- **명령(root):**

```bash
systemctl start nomorevibe-core-role@official-news.service
journalctl -u nomorevibe-core-role@official-news.service -n 20 --no-pager
systemctl stop nomorevibe-core-role@official-news.service
systemctl reset-failed nomorevibe-core-role@official-news.service
```

- **성공 readback:** journal의 마지막 진단이 `{"check":"preflight","reason":"preflight_rejected"}`다. 이 값은 release(1)·runtime(2)·budget(3)·identity(4)를 모두 통과했다는 뜻이다. unit의 `Restart=on-failure`가 300초 안에 3번까지 다시 시도할 수 있으므로 확인 뒤 바로 stop한다.
- **중단 조건:** `release_*`, `runtime_platform_mismatch`, `service_account_mismatch`, `host_db_budget_undeclared`, `core_slice_not_applied`, `core_slice_unbounded`, `approved_identity_unavailable`, `oci_identity_unverified`. `preflight_unavailable`이면 DB 연결(PgBouncer·pg_hba)을 먼저 본다.
- **되돌리기:** stop·reset-failed로 끝난다.
- **승인:** 필요(Oracle에서 프로세스 기동, DB 읽기).
- **근거:** `deploy/oracle/launch.py:162-198`, `lib/runtime/oracle-preflight.ts:94-104`.

## 4. job batch versioned 전환과 canary → ready

> **차단:** 이 단계는 B1(제어값 도구 없음)과 B2(versioned가 전 fleet을 바꿈)가 풀리기 전에는 실행하지 않는다. 아래 절차는 두 차단이 풀렸을 때의 순서와 코드가 요구하는 조건이다. 제어 표를 SQL로 직접 고치는 방법은 policy hash·drain 검사를 우회하므로 이 runbook에서 승인하지 않는다.

### 4.1 선행 조건(전부 필요)

| 조건 | 확인 방법 | 근거 |
| --- | --- | --- |
| `job_batch_control.policy`에 Oracle 역할 `SERVICE_INSTANCE_ID`가 host `oracle-osaka-smoke`로 있고 `release`가 Oracle release SHA와 같다 | 아래 SQL | `lib/runtime/oracle-canary.ts:70-80`, `lib/jobs/batches.ts:9-12` |
| `writer_contract_version >= 1` | 아래 SQL | `lib/jobs/batch-repository.ts:42,132,208` |
| `http_origin_control.mode='open'`, policy의 `instanceHosts`에서 Oracle 인스턴스가 `oracle-osaka-smoke` | 아래 SQL | `lib/runtime/oracle-canary.ts:93-102` |
| `dr_writer_fence.state='active'` | 아래 SQL | `lib/jobs/batch-repository.ts:41,130` |
| D1 refresh 정책 결정 | — | `deploy/oracle/README.md:112-124` |

```sql
SELECT mode, draining_from, epoch, writer_contract_version, policy, policy_hash FROM job_batch_control WHERE id = 1;
SELECT mode, epoch, policy, policy_hash FROM http_origin_control WHERE id = 1;
SELECT lineage_id, writer_epoch, state, reason FROM dr_writer_fence WHERE id = 1;
```

### 4.2 canary 실행 환경 — 확인 필요

- canary CLI는 release 루트(`/opt/nomorevibe-core/current`)에서 실행해야 한다. IMDS 대조가 상대 경로 `deploy/oracle/oci_identity.py`를 부르기 때문이다(`lib/runtime/oracle-canary-cli.ts:20-24`).
- 프로세스에는 그 역할 env 파일의 값과 별도 `ORACLE_ATTEST_DATABASE_URL`(attest principal)이 있어야 한다. 두 URL이 같으면 거절한다(`lib/runtime/oracle-canary-cli.ts:36-39`).
- env를 어떻게 주입하고 어느 OS 계정으로 실행하는지는 코드·문서에 없다(D12). 같은 역할의 unit이 lease를 쥐고 있으면 canary 선출이 실패하므로(`oracle_canary_role_not_elected`) 그 unit을 먼저 멈춘다.
- 종료 코드: `0` = 증거를 쓰고 ready, `2` = 썼지만 not ready, `78` = DB 쓰기 전 거절, `1` = 실패(고정 code만 출력)(`lib/runtime/oracle-canary-cli.ts:29,68-73`).

### 4.3 legacy 부모가 있는 역할(official-news·product-health·translation)

순서: **legacy에서 seed → attest → (전환) → versioned에서 canary**. translation은 5단계 조건도 필요하다.

1. M3·mini의 legacy 부모 역할을 멈춘다(official-news·product-health는 maintenance, translation은 text). seed가 그 역할 lease를 Oracle 인스턴스로 잡아야 하기 때문이다(D11).
2. seed와 attest를 실행한다.

```bash
cd /opt/nomorevibe-core/current
runtime/bin/node --import tsx lib/runtime/oracle-canary-cli.ts seed --role=official-news --job=news-refresh
runtime/bin/node --import tsx lib/runtime/oracle-canary-cli.ts attest --role=official-news --job=news-refresh
```

3. M3·mini의 legacy 부모 역할을 다시 시작한다.
4. `legacy → draining → versioned` 전환(B1 도구). 완료 조건은 살아 있는 job lease·item lease·role lease·source claim이 모두 0인 것이다. 즉 전 fleet 정지가 필요하다(`lib/jobs/batch-repository.ts:213-238`).
5. versioned에서 canary를 실행한다.

```bash
cd /opt/nomorevibe-core/current
runtime/bin/node --import tsx lib/runtime/oracle-canary-cli.ts canary --role=official-news --job=news-refresh
```

- **성공 readback:**
  - seed: exit 0, `{"seed":{"status":"completed",…}}`. ACK(`batch-result:<instance>:<job>`)는 tick이 양수 결과를 냈을 때만 남는다(`lib/jobs/batch-repository.ts:66-83`).
  - attest: exit 0, `attest.ready: true`, `capability.dbPrivileges/http = verified`, `readbackRows > 0`.
  - canary: exit 0, `canary.after.ready: true`.
- **중단 조건:** `oracle_canary_batch_unavailable`(policy·release·instance 불일치 또는 draining), `oracle_canary_result_missing`, `oracle_canary_domain_readback_empty`(그 tick이 쓴 행이 없음 — 일감이 없을 때 생긴다, D13), `oracle_canary_candidate_identity_mismatch`(policy hash가 바뀜), `capability.http: unknown`(HTTP control이 열리지 않음).
- **되돌리기:** 증거 행은 append·compare 방식이라 지우지 않는다. 다음 canary가 새 증거로 덮는다. 전환을 되돌리려면 `versioned → draining → legacy`(B1 도구)로 M3·mini legacy 워커를 다시 일하게 한다.
- **승인:** 필요(운영 DB 쓰기, M3·mini 정지, 실제 tick 1회).
- **근거:** `lib/runtime/oracle-canary.ts:110-173,183-190,211-218`, `deploy/oracle/README.md:104-106`.

### 4.4 legacy 부모가 없는 역할(site-evidence)

versioned에서만, 그 인스턴스에 결과·anchor·readback이 하나도 없을 때만 쓴다. bootstrap grant는 최대 10분이다.

```bash
cd /opt/nomorevibe-core/current
runtime/bin/node --import tsx lib/runtime/oracle-canary-cli.ts bootstrap --role=site-evidence --job=product-site-evidence-refresh
runtime/bin/node --import tsx lib/runtime/oracle-canary-cli.ts attest --role=site-evidence --job=product-site-evidence-refresh
runtime/bin/node --import tsx lib/runtime/oracle-canary-cli.ts canary --role=site-evidence --job=product-site-evidence-refresh
```

- **성공 readback:** bootstrap exit 0, `bootstrap.acknowledged: true`, `bootstrap.revoked: true`. 이어서 attest·canary가 4.3과 같다.
- **중단 조건:** `oracle_bootstrap_requires_versioned`, `oracle_bootstrap_prior_evidence`, `grant.reason: capability_unknown`.
- **근거:** `lib/runtime/oracle-canary.ts:245-314`, `lib/jobs/batches.ts:116-148`.

### 4.5 unit 시작, readback, capability 유지

```bash
systemctl start nomorevibe-core-role@official-news.service
systemctl status nomorevibe-core-role@official-news.service --no-pager
journalctl -u nomorevibe-core-role@official-news.service -n 50 --no-pager
cat /run/nomorevibe-core/official-news/role-health.json
# D1 이 A 일 때만(README 권고안). B 면 원격 timer 를 따로 만든다.
systemctl enable --now nomorevibe-core-refresh@official-news.timer
systemctl list-timers 'nomorevibe-core-refresh@*' --no-pager
# timer 를 켜기 전에는 15분 안에 손으로 refresh 한다(4.2 와 같은 실행 환경, attest 또는 refresh principal)
cd /opt/nomorevibe-core/current
runtime/bin/node --import tsx lib/runtime/oracle-canary-cli.ts refresh --role=official-news
```

  refresh 출력은 `{"refresh":{"dbPrivileges":…,"http":…,"model":…,"observedAt":…}}`이고 종료 코드는 0이다. refresh는 result 증거·anchor·번역 model proof를 새로 만들지 않는다(`lib/runtime/oracle-canary.ts:220-243`).

```sql
SELECT role, instance_id, host, boot_id, release, policy_hash,
  capability->>'dbPrivileges' AS db, capability->>'http' AS http, capability->>'model' AS model,
  capability->>'observedAt' AS capability_at, result_evidence->>'job' AS readback_job, observed_at
FROM job_batch_candidates WHERE host = 'oracle-osaka-smoke' ORDER BY role, instance_id;
SELECT role, owner_instance_id, owner_boot_id, owner_release, epoch, lease_until > clock_timestamp() AS live
FROM role_leases WHERE role IN ('translation','product-health','site-evidence','official-news') ORDER BY role;
```

- **성공 readback:** journal에 launcher 진단이 없고 role-worker 로그(`role.acquired`)가 보인다. role-health의 `phase`가 `active`다. `role_leases`의 owner가 Oracle 인스턴스이고 `live=t`다. `capability_at`이 15분 안이다.
- **중단 조건:** launcher 진단 `preflight/workload_unverified`, `preflight/database_unverified`, `preflight/timeouts_unverified`. `capability_at`이 15분을 넘김(refresh 정책 미적용).
- **꼭 알아 둘 것:** **재시작할 때마다 새 canary가 필요하다.** 새 boot가 heartbeat로 후보 행의 `boot_id`를 바꾸면 저장된 결과의 boot와 달라져 preflight가 거절한다. 그래서 `systemctl enable`(부팅 자동 시작)이나 `Restart=on-failure`가 스스로 복구해 주지 않는다(`lib/runtime/oracle-preflight.ts:160-163`, `deploy/oracle/README.md:90`).
- **되돌리기:** `systemctl stop`. lease는 45초 뒤 만료된다. 진행 중 작업은 원래 token으로 끝난다.
- **승인:** 필요(Oracle에서 실제 업무 시작).
- **근거:** `deploy/oracle/launch.py:129-159`, `scripts/role-worker.ts:130-190`, `deploy/oracle/nomorevibe-core-refresh@.timer:1-15`.

### 4.6 결과가 24시간보다 오래됐을 때(recanary, PR11e)

결과가 모두 24시간을 넘으면 readiness가 거절하고 `attest`·`canary`도 `oracle_canary_result_stale`로 멈춘다. 이때만 recanary를 쓴다(versioned 전용).

```bash
systemctl stop nomorevibe-core-role@official-news.service
cd /opt/nomorevibe-core/current
runtime/bin/node --import tsx lib/runtime/oracle-canary-cli.ts recanary --role=official-news --job=news-refresh
runtime/bin/node --import tsx lib/runtime/oracle-canary-cli.ts attest --role=official-news --job=news-refresh
runtime/bin/node --import tsx lib/runtime/oracle-canary-cli.ts canary --role=official-news --job=news-refresh
systemctl start nomorevibe-core-role@official-news.service
```

- **성공 readback:** recanary exit 0, `recanary.acknowledged: true`, `recanary.revoked: true`. 이어서 attest·canary가 ready다.
- **중단 조건:** `recanary_prior_fresh`(24시간 안의 결과가 있음 → `attest`가 맞는 경로), `recanary_prior_absent`(결과가 처음부터 없음 → seed나 bootstrap), `oracle_recanary_requires_versioned`.
- **근거:** `lib/runtime/oracle-canary.ts:316-381`, `lib/jobs/batches.ts:150-194`, `deploy/oracle/README.md:110`.

## 5. 번역 역할 활성화 전 model proof

> **차단:** B4. 아래 조건이 모두 readback되기 전에는 번역 역할을 계속 미룬다. 계약이 없으면 resolver가 null이고 model 증거는 늘 `unknown`이라 번역은 ready가 될 수 없다. 이것이 정상 동작이다.

- **목적:** 번역 tick의 모든 모델 호출이 승인된 serving 계약에 묶여 정산됐음을 attest와 preflight가 각자 다시 읽어 확인하게 한다.
- **선행 readback(외부·운영, 각각 승인 필요):**
  1. abcLLM PR3(번역 non-raw 4경로의 엄격 terminal opt-in, 헤더 `X-Abcllm-Strict-Terminal: 1`) 병합·배포. 게이트웨이 두 컨테이너의 `/app` 파일 SHA가 병합 커밋과 같은지 확인한다.
  2. M3 gpt-oss-120b의 실제 엔진·launch 인자·상한 C, `mlx_proxy` 구성을 readback한다(PR2 bounded release 배포 여부 포함).
  3. 경계 실추론: C 통과·C+1 거절, `usage_provenance=upstream_reported`가 게이트웨이까지 오는지 확인한다.
  4. 위 값으로 번역 3경로 계약(`reason-translate`·`product-translate`·`product-tagline-ko`)을 만들고, translation env의 `ABCLLM_SERVING_CONTRACTS`에 넣는다. 형식은 아래와 같다. 번역 경로는 `strictTerminalOptIn`이 없으면 그 kind 전체가 닫힌다.

```json
{"version":1,"contracts":[
  {"version":1,"protocol":"abcllm-reason-total-bound-v1","routeId":"reason-translate","provider":"abcllm",
   "model":"<게이트웨이 표시 이름>","responseModel":"<upstream id>","deploymentRevision":"<readback 묶음>",
   "endpoint":"<https://…/v1/chat/completions>","totalTokenBound":0,"strictTerminalOptIn":"abcllm-strict-terminal-v1"},
  {"version":1,"protocol":"abcllm-product-translation-total-bound-v1","routeId":"product-translate","…":"같은 필드"},
  {"version":1,"protocol":"abcllm-product-tagline-ko-total-bound-v1","routeId":"product-tagline-ko","…":"같은 필드"}]}
```

  5. model capacity policy에 번역 route를 매핑하고 `open`으로 둔다(B1 도구). `open`은 전역 스위치라서 그 전에 다른 모든 route의 계약(PR05d 9 route, PR05c-6 CLI)이 채워져 있어야 한다.
- **명령:** 4.3의 seed·attest·canary를 번역 잡마다 실행한다(`--role=translation --job=reason-translate` 등). 세 잡은 한 lane에서 직렬로 돌고 host 번역 호출 합은 1이다.
- **성공 readback:** attest 출력에 `capability.model: "verified"`, `modelEvidence: "model_bound_readback_verified"`가 있다. preflight 보고서의 `checks.model.status`가 `verified`, `reason`이 `model_bound_readback_matches`다.

```sql
SELECT request_id, state, route_id, provider, model, settled_at,
  dispatch_binding->'role'->'batch'->>'host' AS batch_host, dispatch_binding->'job'->>'requestedVersion' AS requested_version
FROM model_capacity_requests
WHERE route_id IN ('reason-translate','product-translate','product-tagline-ko') AND owner_instance_id = :'translation_instance'
ORDER BY request_id DESC LIMIT 20;
```

- **중단 조건:** `serving_contract_unavailable`(resolver null), `model_readback_empty`(capacity disabled라 장부 행 없음), `model_readback_mismatch`, `serving_contract_mismatch`, `model_bound_evidence_mismatch`.
- **되돌리기:** translation unit을 멈추고 `ABCLLM_SERVING_CONTRACTS`를 지운 뒤 재시작한다(설정은 프로세스 시작 때 한 번만 읽는다). 재시작에는 새 canary가 필요하다. model capacity를 `open`에서 되돌리는 것은 B1 도구 몫이다.
- **승인:** 필요(외부 저장소 병합·배포, 운영 모델 호출, 운영 DB 쓰기).
- **근거:** `lib/runtime/oracle-model-evidence.ts:12-81`, `lib/runtime/oracle-preflight.ts:171-184`, `lib/llm/gateway-serving-contract-config.ts:16-57`, `lib/llm/reason-translation-serving-contract.ts:6-26`, `lib/operations/host-budget.ts:39-44`, `/tmp/nomorevibe-abcllm-status-20261017.md` 3–5장.

## 6. 24시간 관측, 양방향 인계 시험, 고정 SHA rollback

### 6.1 24시간 관측

PR17a 관측 수집기는 아직 없다(인벤토리 10번). 그때까지는 아래 읽기 전용 SQL을 주기적으로 실행해 기록한다. 관리자 상태 화면(`/admin/status`)의 제어·runtime 영역도 같은 DB 시계로 batch·HTTP·모델·DR fence·Oracle 후보를 보여준다(`lib/operations/pipeline-control-status.ts:129-175`). 기존 `scripts/check-failover-readiness.ts`는 M3 주·mini 예비 판정이라 Oracle을 대신 보지 않는다.

```sql
-- 역할별 최근 ACK(실처리 수)와 나이
SELECT key, value->'batchResult'->>'job' AS job, (value->'batchResult'->>'count')::int AS count,
  value->'batchResult'->>'recordedAt' AS recorded_at, value->'batchResult'->>'bootId' AS boot_id
FROM operations_observations WHERE key LIKE 'batch-result:%' ORDER BY key;
-- Oracle 잡의 요청·처리·실패
SELECT name, requested_version, processed_version, last_run_at, last_success_at, left(last_error, 120) AS last_error,
  lease_token IS NOT NULL AS running, not_before
FROM jobs WHERE name IN ('reason-translate','product-tagline-ko','product-translate','uptime-ping','news-refresh','product-site-evidence-refresh')
ORDER BY name;
-- host 장부(HOST_BUDGET_ENFORCEMENT 를 켰을 때만 행이 있다): RSS·event loop·heartbeat
SELECT key, value->>'type' AS type, value->>'identity' AS identity, (value->>'rssBytes')::bigint AS rss,
  value->>'eventLoopDelayMs' AS loop_ms, value->>'heartbeatGapMs' AS gap_ms, value->>'loadPerCpu' AS load
FROM operations_observations WHERE key LIKE 'host-slot:oracle-osaka-smoke:%' ORDER BY key;
-- Oracle HTTP 점유(합 2·origin 1)와 미정산
SELECT state, count(*) FROM http_origin_hops WHERE host_id = 'oracle-osaka-smoke' GROUP BY state ORDER BY state;
-- 역할 인계·epoch 변화
SELECT role, owner_instance_id, owner_release, epoch, lease_until, updated_at FROM role_leases ORDER BY role;
```

- **성공 기준(기록할 것):** 역할마다 고유 결과(`count>0`)가 이어지고 결과 나이가 24시간을 넘지 않는다. capability 나이가 15분을 넘지 않는다. HTTP `indeterminate`가 늘지 않는다. role epoch가 예상 밖으로 오르지 않는다. X 서비스(`/opt/nomorevibe-x`)가 영향받지 않는다. 설치 성공·빈 큐·canary 한 번은 24시간 증거를 대신하지 않는다.
- **중단 조건:** 결과 공백이 잡 주기보다 길게 이어짐, `host_pressure_*`로 계속 미뤄짐, HTTP `indeterminate` 증가, X 영향.
- **승인:** 읽기 전용이지만 운영 DB 접속이므로 실행 전에 알린다.

### 6.2 양방향 인계 시험(M3/mini ↔ Oracle) — 현재 시험 불가

- **Oracle → M3/mini:** 분리 역할의 host 순서는 Oracle → M3 → mini다(`lib/jobs/batches.ts:39-42`). Oracle unit을 멈추면 lease가 45초 뒤 만료되지만, M3·mini 후보에는 검증된 capability·result 증거가 없어 아무도 선출되지 않는다(B2). 결과적으로 그 역할의 일이 멈춘다.
- **M3/mini → Oracle:** Oracle launcher는 legacy 5역할을 실행하지 못한다(B5). Oracle은 M3·mini 역할을 인계받지 못한다.
- **풀린 뒤의 시험 절차(기록 양식):** 한쪽을 실제로 멈추고(멈추지 않은 host는 시험 완료로 세지 않는다) 시각 T0를 기록한다 → 반대쪽 후보의 선출(`role_leases` epoch+1, owner 변경)을 확인한다 → 첫 검증된 고유 결과(`batch-result` + domain readback)까지의 시간을 잰다 → 중복 결과·lease 위반이 0인지 확인한다 → 원래 host를 되돌리고 선점 없이 drain 뒤 반환되는지 본다. 사용자 결정(D9) 뒤에 다시 쓴다.

### 6.3 고정 SHA rollback

- **목적:** 승인한 이전 SHA로 되돌린다. 추측한 이전 release나 schema downgrade는 없다.
- **명령(root):**

```bash
systemctl stop nomorevibe-core-role@official-news.service nomorevibe-core-role@product-health.service \
  nomorevibe-core-role@site-evidence.service nomorevibe-core-role@translation.service
readlink "$OWN_OFFLINE_ROOT/opt/nomorevibe-core/current"
python3 "$SRC/scripts/ops/deploy_shared_images.py" oracle-rollback \
  --sha "$APPROVED_OLDER_SHA" --archive "$APPROVED_OLDER_ARCHIVE_PATH" \
  --archive-sha256 "$APPROVED_OLDER_ARCHIVE_SHA256" --staging-root "$OWN_OFFLINE_ROOT" \
  --expected-current "$RECORDED_CURRENT_SHA" \
  --expected-host "$APPROVED_HOST_RECORD" --observed-host "$RECORDED_HOST_READBACK"
readlink "$OWN_OFFLINE_ROOT/opt/nomorevibe-core/current"
```

  그다음 역할 env의 `RELEASE_TAG`와 `HOST_DB_BUDGET`의 두 `release`를 이전 SHA로 바꾼다. versioned에서는 batch policy의 `release`도 같아야 하므로 B1 도구로 policy를 바꿔야 한다. policy hash가 바뀌면 후보 증거가 맞지 않으므로 역할마다 새 canary가 필요하다.

- **성공 readback:** `{"action":"oracle-rollback",…,"previous":"<RECORDED_CURRENT_SHA>","current":"<APPROVED_OLDER_SHA>","readiness":"unverified","activationAllowed":false}`, `readlink`가 `releases/<APPROVED_OLDER_SHA>`.
- **중단 조건:** `current_release_changed`(관측한 current가 다름), 이전 release가 지금 batch·schema 계약을 지원하지 않음. 그때는 이전 release를 시작하지 않고 core를 멈춘 채 둔다.
- **되돌리기:** 같은 명령을 두 SHA를 바꿔 다시 실행한다. switch 뒤 오류는 rollback으로 간주하지 않으므로 `readlink`로 먼저 확인한다.
- **승인:** 필요.
- **근거:** `scripts/ops/deploy_shared_images.py:693-713`, `deploy/oracle/manage_release.py:207-236`, `deploy/oracle/launch.py:61-66`, `docs/superpowers/plans/2026-10-16-pipeline-pr11-oracle-runtime.md:136-141`.

## 7. DR: fence → seal → promote

이 절은 Oracle 역할 활성화와 별개로 쓸 수 있다. 도구는 모두 dry-run이 기본이다(같은 트랜잭션을 실행한 뒤 ROLLBACK). `--apply`가 있을 때만 commit한다. DB URL은 stdin 한 줄로만 받는다. 종료 코드는 `0` 정상, `3` blocked, `1` 오류다(`scripts/ops/dr/promotion.ts:1-3,121-128,168-173`). 실행 위치는 승인 SHA checkout 루트다.

### 7.0 전제와 사용자 결정

- 복원 대상 R(Oracle의 PG17)이 준비돼 있고, R에는 어떤 워커도 붙어 있지 않다. R 준비 순서는 `replication_plan.py plan`이 출력하는 `procedure`(observe → capacity_gate → cluster_settings → prepare_r → … → cutover)를 따른다. Oracle에 PG17을 설치하고 실제로 복원하는 일은 아직 한 적이 없다(**확인 필요**). `scripts/ops/oracle-dr/restore_rehearsal.py`는 로컬 격리 리허설 전용이다.
- 승인 범위: 대상 old DB(V9-Primary), R, 운영자 이름, RPO/RTO 목표, 중단 허용 시간.
- DNS·tunnel 전환: **사용자 결정 대기(D8).** 이 runbook은 명령을 적지 않는다.

### 7.1 논리 복제(PR14d) 확인과 cutover 준비

논리 복제로 R을 유지했다면, 쓰기를 멈춘 뒤 양쪽 상태를 읽어 대조한다. 구독을 끊는 SQL(`ALTER SUBSCRIPTION … DISABLE`, `SET (slot_name = NONE)`, `DROP SUBSCRIPTION`)과 sequence 동기화 SQL은 `replication_plan.py`가 만든 plan의 `sql.rollback.subscriber`와 `sequence-sync` 출력을 그대로 쓴다.

```bash
printf '%s\n' "$PUBLISHER_DATABASE_URL" | python3 scripts/ops/oracle-dr/replication_status.py capture \
  --plan "$REPLICATION_PLAN" --side publisher --label cutover-publisher --row-counts \
  --database-url-stdin --expect-database "$PUBLISHER_DATABASE" --expect-user "$PUBLISHER_USER" > "$PUBLISHER_CAPTURE"
printf '%s\n' "$R_DATABASE_URL" | python3 scripts/ops/oracle-dr/replication_status.py capture \
  --plan "$REPLICATION_PLAN" --side subscriber --label cutover-subscriber --row-counts \
  --database-url-stdin --expect-database "$R_DATABASE" --expect-user "$R_USER" > "$SUBSCRIBER_CAPTURE"
python3 scripts/ops/oracle-dr/replication_status.py evaluate --plan "$REPLICATION_PLAN" \
  --publisher "$PUBLISHER_CAPTURE" --subscriber "$SUBSCRIBER_CAPTURE" \
  --max-lag-bytes 0 --max-retained-wal-bytes "$MAX_RETAINED_WAL_BYTES"
python3 scripts/ops/oracle-dr/replication_plan.py sequence-sync --plan "$REPLICATION_PLAN" \
  --margin "$SEQUENCE_MARGIN" --publisher-capture "$PUBLISHER_CAPTURE"
```

- **성공 readback:** evaluate exit 0, `blockingFindings: 0`. 구독을 끊은 뒤 다시 capture·evaluate하면 `sealPrecondition.satisfied: true`(구독 없음, 복제 worker 없음)다. old primary가 죽어 publisher를 읽을 수 없으면 R의 마지막 적용 지점을 RPO 기록에 남긴다.
- **중단 조건:** exit 3(blocking finding), exit 2(관측 실패).
- **근거:** `scripts/ops/oracle-dr/replication_status.py:540-583`, `scripts/ops/oracle-dr/replication_plan.py:190-242,397-429`.

### 7.2 identity와 plan

```bash
printf '%s\n' "$OLD_DATABASE_URL" | node --import tsx scripts/ops/dr/promotion.ts identity --database-url-stdin
printf '%s\n' "$R_DATABASE_URL" | node --import tsx scripts/ops/dr/promotion.ts identity --database-url-stdin
```

출력의 `db`(systemIdentifier·databaseOid·databaseName)와 `fence`(lineageId·writerEpoch·state)로 plan JSON을 만든다. `knownActiveEpoch`는 `fromEpoch`와 같아야 한다. 더 높은 epoch이 이미 있다면 그 DB를 fence하고 그 DB를 복원해야 한다.

```json
{"version":1,"promotionId":"<새 uuid>","lineageId":"<fence.lineageId>","fromEpoch":1,"knownActiveEpoch":1,
 "restoredDb":{"systemIdentifier":"<R>","databaseOid":"<R>","databaseName":"<R>"},
 "oldDbs":[{"systemIdentifier":"<P>","databaseOid":"<P>","databaseName":"<P>"}],
 "oldInstances":["<M3·mini·Oracle 의 모든 SERVICE_INSTANCE_ID>"],
 "snapshotAt":"<dump 또는 마지막 적용 시각, YYYY-MM-DDTHH:MM:SS.mmmZ>","operator":"<운영자>"}
```

### 7.3 seal(R)

```bash
printf '%s\n' "$R_DATABASE_URL" | node --import tsx scripts/ops/dr/promotion.ts seal --plan="$PROMOTION_PLAN" --database-url-stdin
printf '%s\n' "$R_DATABASE_URL" | node --import tsx scripts/ops/dr/promotion.ts seal --plan="$PROMOTION_PLAN" --apply --database-url-stdin
```

- **성공 readback:** dry-run 결과의 `sealSnapshot.instances`·`modelBudgets`를 검토한 뒤 apply한다. apply 결과 `state: "sealed"`. R에서 role·job·item·source claim token이 모두 폐기되고, 모델·HTTP control은 `draining` 또는 `disabled`가 된다.
- `sealSnapshot.instances`에는 `job_batch_candidates`에 남은 과거 후보 인스턴스까지 들어간다. promote는 plan의 `oldInstances`와 이 목록 전부에 7.4의 정지 근거를 요구한다(`lib/operations/dr/repository.ts:67-73`, `lib/operations/dr/promotion.ts:81-87,120-123`).
- **중단 조건:** `dr_database_identity_mismatch`, `dr_restored_is_old_db`, `dr_writer_fence_expectation_mismatch`, `dr_in_place_promotion_forbidden`, `dr_promotion_exists`.
- **되돌리기:** seal은 되돌리지 않는다. 막히면 R을 버리고 새로 복원한다. token 재발급이나 장부 초기화는 쓰지 않는다.
- **근거:** `lib/operations/dr/repository.ts:55-112`.

### 7.4 근거 기록(record-evidence)

옛 writer를 모두 멈추고(M3·mini 13앱과 Oracle unit, 자동 재시작 해제), 그 정지를 외부 근거로 기록한다. 근거마다 subject가 고정돼 있다.

| kind | subject | payload 필수 필드 |
| --- | --- | --- |
| `writer_process_stopped` | 인스턴스 ID | `version:1, instanceId, method(control_plane_stopped·host_powered_off·container_removed), reference, autoRestartDisabled:true, stoppedAt, skewBoundMs` |
| `old_db_fenced` | `db:<systemIdentifier>:<databaseOid>` | 7.5의 `fence-old --apply` 출력의 `result` 객체 그대로 |
| `old_db_isolated` | `db:<systemIdentifier>:<databaseOid>` | `version:1, db, method(host_powered_off·db_service_stopped·network_blocked), reference, autoRestartDisabled:true, rejoinFenceRequired:true, observedAt` |
| `provider_deadline` | scope(`http` 또는 `model:<budget>`) | `version:1, scope, termination(client_bound·provider_bound), hardDeadlineMs(provider_bound면 필수, client_bound면 null), reference` |
| `independent_budget` | `model:<budget>` | `version:1, scope, replacementBudgetId(옛 budget과 달라야 함), reference` |
| `external_effects_reconciled` | `rpo-window` | `version:1, windowFrom(≤snapshotAt), windowTo(≥마지막 stoppedAt), method(old_db_compared·manual_review), reference, reviewed, corrective` |

```bash
printf '%s\n' "$R_DATABASE_URL" | node --import tsx scripts/ops/dr/promotion.ts record-evidence \
  --promotion="$PROMOTION_ID" --kind=writer_process_stopped --subject="$INSTANCE_ID" \
  --payload="$EVIDENCE_FILE" --operator="$OPERATOR" --database-url-stdin
printf '%s\n' "$R_DATABASE_URL" | node --import tsx scripts/ops/dr/promotion.ts record-evidence \
  --promotion="$PROMOTION_ID" --kind=writer_process_stopped --subject="$INSTANCE_ID" \
  --payload="$EVIDENCE_FILE" --operator="$OPERATOR" --apply --database-url-stdin
```

- lease 만료, heartbeat 부재, 옛 writer의 자기 release는 근거 kind로 받지 않는다. 같은 (kind, subject)는 마지막 기록이 유효하다.
- **근거:** `lib/operations/dr/promotion.ts:28-55`, `lib/operations/dr/call-drain.ts:12-27`, `lib/operations/dr/repository.ts:115-129`.

### 7.5 old primary fence와 복귀 금지

접근할 수 있으면 old DB에 fence를 건다. 한 방향(active → fenced)이며 다시 여는 API는 없다.

```bash
printf '%s\n' "$OLD_DATABASE_URL" | node --import tsx scripts/ops/dr/promotion.ts fence-old \
  --expect-lineage="$LINEAGE_ID" --expect-epoch="$WRITER_EPOCH" --expect-db="$OLD_DB_IDENTITY" \
  --operator="$OPERATOR" --database-url-stdin
printf '%s\n' "$OLD_DATABASE_URL" | node --import tsx scripts/ops/dr/promotion.ts fence-old \
  --expect-lineage="$LINEAGE_ID" --expect-epoch="$WRITER_EPOCH" --expect-db="$OLD_DB_IDENTITY" \
  --operator="$OPERATOR" --apply --database-url-stdin
printf '%s\n' "$OLD_DATABASE_URL" | node --import tsx scripts/ops/dr/promotion.ts identity --database-url-stdin
```

- `OLD_DB_IDENTITY`는 `<systemIdentifier>:<databaseOid>:<databaseName>`이다. apply 출력의 `result` 객체를 파일로 저장해 `old_db_fenced` payload로 R에 기록한다.
- **복귀 금지 readback:** old DB의 `identity`가 `fence.state: "fenced"`, `reason: "operator_fence"`다. fenced DB에서는 legacy·versioned 선출과 갱신이 모두 null·false를 돌려주므로, old DB에 다시 붙은 워커는 일을 얻지 못한다. 접근할 수 없어 `old_db_isolated`로 기록했다면, 그 DB를 네트워크에 다시 붙이기 전에 반드시 `fence-old`를 먼저 실행한다.
- **근거:** `lib/operations/dr/epoch.ts:69-72,91-111`, `lib/jobs/role-leader.ts:49-51`, `lib/jobs/batch-repository.ts:128-130,176-178`.

### 7.6 status → promote → permit open

```bash
printf '%s\n' "$R_DATABASE_URL" | node --import tsx scripts/ops/dr/promotion.ts status --promotion="$PROMOTION_ID" --database-url-stdin
printf '%s\n' "$R_DATABASE_URL" | node --import tsx scripts/ops/dr/promotion.ts promote --promotion="$PROMOTION_ID" --operator="$OPERATOR" --database-url-stdin
printf '%s\n' "$R_DATABASE_URL" | node --import tsx scripts/ops/dr/promotion.ts promote --promotion="$PROMOTION_ID" --operator="$OPERATOR" --apply --database-url-stdin
printf '%s\n' "$R_DATABASE_URL" | node --import tsx scripts/ops/dr/promotion.ts open-permits --promotion="$PROMOTION_ID" --target=http --operator="$OPERATOR" --apply --database-url-stdin
printf '%s\n' "$R_DATABASE_URL" | node --import tsx scripts/ops/dr/promotion.ts release-drained --promotion="$PROMOTION_ID" --operator="$OPERATOR" --apply --database-url-stdin
printf '%s\n' "$R_DATABASE_URL" | node --import tsx scripts/ops/dr/promotion.ts open-permits --promotion="$PROMOTION_ID" --target=model --operator="$OPERATOR" --apply --database-url-stdin
```

`open-permits`와 `release-drained`도 먼저 `--apply` 없이 dry-run을 실행해 결과를 확인한다.

- **성공 readback:**
  - status: exit 0, `evaluation.ready: true`, `blockers: []`. exit 3이면 blockers를 읽는다(`old_db_unfenced:<i>`, `writer_process_unfenced:<id>`, `drain_blocked:<scope>:<reason>`, `drain_waiting:<scope>`, `external_effects_unreconciled`, `reconciliation_window_incomplete`).
  - promote: `kind: "promoted"`, `fence.state: "active"`, `fence.writerEpoch: fromEpoch+1`.
  - open-permits http: `kind: "opened"` 또는 `settled_only`(policy 없음).
  - model scope마다 `provider_deadline`(provider_bound + 증명된 hard deadline)이나 `independent_budget` 근거가 없으면 status가 `drain_blocked:model:<budget>:provider_deadline_unknown`으로 막혀 promote 자체가 진행되지 않는다. 지금 abcLLM에는 증명된 생성 deadline이 없으므로 이것이 예상 결과다.
  - promote 뒤 model open은 옛 세대 `dispatched`·`indeterminate` 행이 남으면 `model_capacity_old_dispatch_unreleased:<n>`로 막힌다. `release-drained`는 drained scope의 옛 행만 회수하고 independent scope의 행은 풀지 않는다.
- **되돌리기:** promote 뒤에는 되돌리지 않는다. planned failback은 같은 절차로 새 사본을 epoch+1로 승격한다. 양방향 merge는 없다.
- **다음:** 새 site의 워커를 역할 하나씩 canary한다. DNS·tunnel 전환은 D8 결정 뒤에 한다.
- **근거:** `lib/operations/dr/promotion.ts:102-135`, `lib/operations/dr/repository.ts:143-161`, `lib/operations/dr/permits.ts:11-84`, `lib/operations/dr/reclaim.ts:52-77`.

### 7.7 RPO/RTO 기록

DR drill 기록기(PR17a)는 아직 없다. 아래 readback과 운영자가 외부 시계로 기록한 T0(장애 주입 시각)로 계산해 남긴다.

```sql
-- R(승격된 DB)
SELECT promotion_id, plan->>'snapshotAt' AS snapshot_at, sealed_at, promoted_at, from_epoch, to_epoch
FROM dr_promotions ORDER BY sealed_at DESC LIMIT 1;
SELECT kind, subject, payload->>'stoppedAt' AS stopped_at, payload->>'skewBoundMs' AS skew_ms, recorded_at, operator
FROM dr_promotion_evidence WHERE promotion_id = :'promotion_id' ORDER BY id;
SELECT reason, from_epoch, to_epoch, from_state, to_state, created_at, operator FROM dr_fence_events ORDER BY id;
```

- **RPO:** 마지막 옛 writer 정지(`max(stoppedAt)`) − `snapshotAt`(또는 논리 복제의 마지막 적용 지점). 그 구간에서 잃은 작업 수와 사람 결정 재조정 건수를 함께 적는다.
- **RTO:** promote 완료와 permit open, 그리고 역할별 첫 검증된 고유 결과까지의 시간(T0 기준).
- 시계 출처(외부 시계, R의 DB clock)와 skew 상한을 같이 적는다. 검증하지 않은 시나리오는 완료로 올리지 않는다.

## 8. 비상 모드(PR16b)

### 8.1 EMERGENCY_ADMISSION

- **켜는 조건:** 비상 admission은 DB가 판정한 모드가 `full`(M3·mini 후보 heartbeat가 둘 다 60초 넘게 없음, writer active), `recovering`, `hold`(writer fenced)일 때만 동작한다. `normal`·`partial`에서는 판정하지 않는다. 사람이 켜는 스위치는 "예산을 미리 장착"하는 것이고, 실제 발동은 DB 관측이 정한다.
- **전제:** `PHYSICAL_HOST=oracle-osaka-smoke`, `HOST_BUDGET_ENFORCEMENT` 활성(없으면 시작할 때 `emergency_admission_invalid`), `HTTP_ORIGIN_PERMITS=1`, `HOST_DB_BUDGET` 선언. 같은 host의 모든 Oracle 프로세스가 같은 예산·같은 비상 설정을 써야 한다. 다르면 장부가 `host_policy_mismatch`로 막는다.
- **값(D5):** 형식은 아래와 같고 기본값은 없다. PR16 설계의 측정 시작 제안은 `{jobs:1, modelJobs:1, httpJobs:2, agingMs:600000}`이다. 이것은 제안값이며 승인값이 아니다. `verifiedModelJobs`에는 독립 모델 품질·비용 검증을 마친 모델 잡만 넣는다(빈 목록도 명시한다).

```env
# D4 압박 한도 JSON 한 줄: {"mode":"enabled","pressure":{"maxLoadPerCpu":…,"maxHostRssBytes":…,"maxEventLoopDelayMs":…,"maxHeartbeatGapMs":…}}
HOST_BUDGET_ENFORCEMENT=
# D5 예산 JSON 한 줄(아래 모양)
EMERGENCY_ADMISSION=
```

```text
{"mode":"enabled","budget":{"jobs":<정수>,"modelJobs":<정수>,"httpJobs":<정수>,"agingMs":<1..86400000>},"verifiedModelJobs":[<검증한 모델 잡>]}
```

  `maxHeartbeatGapMs`는 장부 갱신 주기 10초보다 커야 한다(`lib/operations/host-budget-runtime.ts:23,70-72`).

- **명령:** 모든 Oracle 역할 env에 같은 두 값을 넣고 unit을 다시 시작한다. env는 시작할 때만 읽는다. **재시작마다 새 canary가 필요하므로(4.5) 장애 중에 켜지 말고 평상시에 미리 장착한다.**
- **성공 readback:** 프로세스가 시작을 거절하지 않는다. `host-slot:oracle-osaka-smoke:p:*` 행의 `shape`가 모두 같다. 비상 중에는 `host-slot:oracle-osaka-smoke:e:<n>` 행이 예산 수 이하로 생긴다. 지금 모드는 저장되지 않으므로 아래 입력으로 다시 계산한다.

```sql
SELECT (SELECT state FROM dr_writer_fence WHERE id = 1) AS writer,
  (SELECT policy->'instanceHosts' FROM http_origin_control WHERE id = 1) AS instance_hosts,
  array_agg(key ORDER BY key) FILTER (WHERE observed_at >= localtimestamp - interval '60 seconds') AS fresh_candidates
FROM operations_observations WHERE key LIKE 'candidate:%';
SELECT key, value->>'job' AS job, value->>'owner' AS owner FROM operations_observations
WHERE key LIKE 'host-slot:oracle-osaka-smoke:e:%' ORDER BY key;
```

  판정: writer가 active가 아니면 `hold`. M3·mini 모두 신선한 후보가 없으면 `full`. Oracle이 평소 M3·mini 몫 역할을 쥐고 있으면 `recovering`. 하나만 없으면 `partial`. 아니면 `normal`.
- **효과 범위:** B5 때문에 Oracle은 분리 4역할만 실행한다. 비상 admission은 그 4역할 잡에만 영향을 준다. M3·mini 역할을 Oracle이 대신하지는 않는다.
- **중단 조건:** `emergency_admission_invalid`, `host_budget_invalid`, `host_policy_mismatch`.
- **되돌리기:** 모든 Oracle 역할 env에서 `EMERGENCY_ADMISSION` 줄을 동시에 지우고 재시작한다(재시작마다 canary).
- **승인:** 필요.
- **근거:** `lib/operations/emergency-admission.ts:22-35`, `lib/operations/emergency-admission-runtime.ts:21-36,59-69`, `lib/operations/emergency-priority.ts:23-32,73-74,101-135`, `lib/operations/host-budget-runtime.ts:53-77,117-165`.

### 8.2 embedding parity 도구

- **목적:** 대체 embedding 서버가 저장 벡터와 같은 공간인지 표본으로 잰다. DB는 읽기 전용 트랜잭션으로만 읽는다. 기본은 dry-run(표본 수만 세고 서버를 부르지 않음)이고 `--execute`일 때만 서버를 부른다.
- **명령:** 모델 파일 sha256은 도구가 확인하지 않는다. 운영자가 먼저 맞춘다. 이 도구는 `products`와 `product_embeddings`를 읽으므로 Oracle principal로는 실행할 수 없다. 실행할 principal과 위치는 **확인 필요**다.

```bash
sha256sum "$CANDIDATE_GGUF_PATH"
node --import tsx scripts/embedding-parity.ts --url="$EMBEDDING_CANDIDATE_URL" --samples=32
node --import tsx scripts/embedding-parity.ts --url="$EMBEDDING_CANDIDATE_URL" --samples=32 --execute
```

- **성공 readback:** `sha256sum`이 `daec91ffb5dd0c27411bd71f29932917c49cf529a641d0168496c3a501e3062c`(`EMBEDDING_MODEL_SHA256`)와 같다. dry-run은 `{"mode":"dry_run",…,"eligible":N,"samples":32}`이며 `eligible`이 32 이상이어야 한다. execute는 exit 0, `readiness.mode: "semantic"`, `minCosine ≥ 0.999`다. 출력의 `profile` JSON이 `EMBEDDING_SERVING_PROFILE` 값이 된다.
- **중단 조건:** exit 2(`degraded`, 이유 목록 확인), exit 1(인자·DB·서버 오류).
- **값의 의미(`lib/domain/products/embedding.ts:62-86`):** `EMBEDDING_SERVING_PROFILE` 줄이 **없으면 legacy**다. 지금처럼 `EMBEDDING_URL` 서버를 부른다. **빈 값이면 degraded**(`profile_missing`)라 서버를 부르지 않는다. 측정한 profile이 기준과 모두 맞으면 semantic이다. 그래서 대체 서버가 degraded로 나오면 줄을 지우지 말고 빈 값으로 두어 degraded를 드러낸다.

```env
# execute 출력의 profile JSON 한 줄, 또는 degraded 를 드러낼 때 빈 값
EMBEDDING_SERVING_PROFILE=
# 대체 embedding 서버 주소. 없으면 endpoint_missing 으로 degraded
EMBEDDING_URL=
```

- **적용 범위:** 이 profile은 embedding을 쓰는 프로세스(web·text 등)에 넣는다. 지금 Oracle 4역할은 `product-embedding`을 돌리지 않는다. 비상 web 배포 방식(D8)이 정해지기 전에는 적용할 곳이 없다.
- **되돌리기:** `EMBEDDING_SERVING_PROFILE` 줄을 지우면 legacy로 돌아간다. legacy는 `EMBEDDING_URL` 서버를 검사 없이 부르므로, 같은 공간인지 확인하지 않은 서버를 가리킬 때는 지우지 않는다.
- **승인:** dry-run은 운영 DB 읽기, execute는 대체 서버 호출이라 둘 다 실행 전 승인.
- **근거:** `scripts/embedding-parity.ts:1-13,26-37,72-91`, `lib/domain/products/embedding.ts:15-18,44-49,79-82`.

---

## 부록 A. 이 문서의 명령 점검

`scripts/ops/oracle_activation_check.py`는 이 문서를 읽기만 한다. 문서의 명령을 실행하지 않는다.

```bash
python3 scripts/ops/oracle_activation_check.py
python3 -m unittest tests/test_oracle_activation_check.py
```

점검 내용:
- `bash`·`sh` 블록마다 `bash -n`으로 구문만 검사한다.
- 블록 안의 `deploy/`·`scripts/`·`lib/` 경로가 저장소에 있는지, 하위 명령과 `--옵션` 이름이 그 파일(또는 그 파일이 import하는 같은 폴더 모듈)에 있는지 grep으로 대조한다.
- `--role=`·`--job=` 값이 `lib/jobs/batches.ts`나 대상 파일에 있는지 본다.
- `psql -v 이름=값 -f 파일.sql`이면 SQL의 `:이름` 변수와 양쪽으로 맞는지 본다.
- systemd unit 이름의 템플릿이 `deploy/oracle`에 있는지 본다.
- `env` 블록의 키가 `lib`·`scripts`·`deploy` 코드에 있는지 본다.

이 점검은 이름과 구문만 확인한다. 명령이 운영에서 성공한다는 증거가 아니다.
