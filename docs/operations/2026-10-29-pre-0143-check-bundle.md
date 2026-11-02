**결론: 0143 승인 전에 대표가 이 문서를 위에서 아래로 그대로 친다.** 쓰는 곳은 gpu3090 `$W`와 두 컨테이너의 `/tmp`뿐이다. 운영 DB 쓰기·DRAIN·OPEN·배포는 없다. 판정은 두 수로 한다. M1 preflight의 **`blockedNow`가 `[]`**이어야 하고, 2(b) route 표의 **`non_serving`** 수를 적어 둔다. 0이 아니면 배포 전 OPEN(실패 경로)을 쓸 수 없다. 기준 SHA는 PR #735 병합 main `f4fe5958290713d95e2ce618126fbbf651cd3d95`이다. 이 값이 확정본의 `REL`(스테이징·runner·M1 스크립트의 소스)이다. 배포 `TARGET`은 고정값이 아니고 plan 시점의 main 머리다. 1절 끝에서 확정본 3절 「배포 TARGET 확인」으로 `REL`과 스테이징 경로가 같은지 본다.

# 0143 전 사전 점검 묶음 — 대표용 (2026-10-29)

- 순서의 근거: [확정본](2026-10-29-release-order.md) 1단계 전제(C1~C7 `blockedNow: []`)와 2단계 (a)~(e). 세부 설명은 [실행서](2026-10-29-unknown-release-runbook.md) A-2와 [관문 문서](2026-10-29-monitor-gate-pause-plan.md) 7절.
- **전제: 운영 이미지 `/app`에는 `scripts/ops`가 없다**(`.dockerignore` 7행). 컨테이너 안에서 `node … scripts/ops/…`를 `/app` 기준으로 치지 않는다(`ERR_MODULE_NOT_FOUND`). 검토한 SHA의 tar를 `/tmp`에 올려 sha256·`package-lock.json` 동일을 확인한 뒤, 그 스테이징 소스에서만 실행한다(`in-container.sh`, `capacity-control.sh`). `scripts/check-worker-progress.ts`(R1)와 `postgres` 모듈은 `scripts/ops` 밖이라 이미지에 있다.
- 위치 표기: **[gpu3090]** 대표 셸, **[m3]** `xa-ssh m3ultra`, **[mini]** `xa-ssh mini`, **[m1]** m1studio device_admin(root).
- 하나라도 성공 조건과 다르면 거기서 멈추고 0143을 승인하지 않는다. 응답이 불명확하면 같은 명령을 다시 치기 전에 읽기로 먼저 확인한다(stage는 같은 tar면 다시 쳐도 `existing:true`로 그대로 둔다. `in-container.sh stage`는 두 번째에 `source_dir_exists_use_new_base`를 낸다. 이때 3-2의 확인으로 같은 tar인지 본다).

## 0. 기준 값 (`f4fe5958290713d95e2ce618126fbbf651cd3d95` 기준, gpu3090에서 계산)

| 항목 | SHA-256 |
| --- | --- |
| `scripts/ops/release-29877f65/collect-m1.sh` | `9ee283daffd0f8aa943e6c0e3829c9cdb0214a7105d94db5db4f83022807ce38` |
| `scripts/ops/release-29877f65/collect-docker.sh` | `185c8f486a47b42060830a902b6dbc4422119de341a4c2abe52abe1d6a79ab83` |
| `scripts/ops/release-29877f65/in-container.sh` | `8690b97adf6497d28470ab2a42339a3efd6c562d127ac1ac1b54b1573c2c0611` |
| `scripts/ops/release-order/capacity-control.sh` | `92d59f78927f5fbb983eb309ea4d9aa3c2a3e6f5c44eeade29f08cc5685f4c5a` |
| `scripts/ops/release-29877f65/assemble.ts` | `724f537c814a5159c360b4961984159a56417eb451a13e531a10122afb6691d2` |
| `scripts/ops/release-29877f65/wire.ts` | `065f7639006caafaff961236eb82de7ed75aa6d9d6334a455412e15bfc6e5c51` |
| `scripts/ops/admin-models-ops-submit.ts` | `b9f2bb1a8c56cc4eecb86c8ec206a3f38f76830c9d00711b3c9ffc9174ba94ea` |
| `scripts/ops/release-65f8c399/build-manifest.py` | `1d974717b4b6b45ffa1e6119f05edfca003cb217dcb92feafbf26e692c2285c7` |
| `lib/operations/ops-runner/operator.ts` | `600eab9327eed9db4968973165e322b58517ba7ac903fdf6b414c3b971ec1270` |
| `lib/operations/ops-runner/control.ts` | `e152b09a1594f2298e7f2a2fc76b0e0a3fff3d0a89f9bf7e443f747509f22c92` |
| `lib/operations/ops-runner/repository.ts` | `b09639e60505a516ac14970b76a1fa58ccfacb8034e76afb9664c162e17d5142` |
| `lib/operations/ops-runner/runner.ts` | `1ca48790e752655243b06c8035947066b498fd84ae8aa0defddbb15c7c99820d` |
| `lib/operations/ops-runner/contract.ts` | `0fb66a9c36fc65a544d892af2ce67000c9357f89a31659311b98e3b6e1aebfb3` |
| `scripts/ops/admin-models-ops-runner.ts` | `78df32f4cbaeef344dc4a09a784cb6523306f04fc54b15cb27f666531e271034` |
| `scripts/ops/admin-models-boundary-adapter.py` | `f51d5ef76232bf74e652a27627aabed97236029ae1c17742a55df55311707f61` |
| `scripts/ops/model-replaced-provider-boundary-release.ts` | `c9e1ae002ecb49ad7e7cf1382adbdf7f41228f10a7262eafee5114f513463771` |
| `package-lock.json` | `f609ff6e3159975cce362809a50bc335afb2a812502fb74d70c8ab3a203296d5` |
| 스테이징 tar `TAR_SHA` (`lib scripts drizzle messages tsconfig.json package.json package-lock.json`) | `cdff13dda155a0eeaab4a9a57a0a95a38199ce509e71510997de61cb9822399c` |

`TAR_SHA`는 `git archive --format=tar "$REL" lib scripts drizzle messages tsconfig.json package.json package-lock.json | sha256sum` 결과다(gpu3090 git version 2.53.0). 파일 17개와 `package-lock.json`은 이전 기준 `1f52c9ef`와 같다. tar 해시만 커밋 머리가 들어가서 바뀐다(`1f52c9ef`는 `75f388d4…`였다). tar 바이트는 git 버전에 따라 달라질 수 있다. 그래서 판정은 1단계에서 직접 계산한 `$TAR_SHA`와 컨테이너가 받은 파일의 sha256이 같은지로 한다. 표 값은 참고다. 표 값과 다르면 git 버전부터 본다.

## 1. 준비와 도구 해시 (C1) — [gpu3090]

```sh
SRC=/home/ubuntu/projects/nomorevibe
git -C "$SRC" fetch origin main
REL=f4fe5958290713d95e2ce618126fbbf651cd3d95
git -C "$SRC" merge-base --is-ancestor "$REL" origin/main && echo rel_on_main
SHA=$REL
W=$HOME/nmv-release-29877f65-f4fe59582907
(umask 077; mkdir -p "$W/pre" "$W/sql")
DK='env PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin docker'
for f in scripts/ops/release-29877f65/collect-m1.sh scripts/ops/release-29877f65/collect-docker.sh scripts/ops/release-29877f65/in-container.sh scripts/ops/release-order/capacity-control.sh; do git -C "$SRC" show "$REL:$f" | sha256sum; done
git -C "$SRC" show "$REL:scripts/ops/release-29877f65/collect-m1.sh" > "$W/collect-m1.sh"
git -C "$SRC" show "$REL:scripts/ops/release-29877f65/collect-docker.sh" > "$W/collect-docker.sh"
git -C "$SRC" show "$REL:scripts/ops/release-29877f65/in-container.sh" > "$W/in-container.sh"
git -C "$SRC" show "$REL:scripts/ops/release-order/capacity-control.sh" > "$W/capacity-control.sh"
sha256sum "$W"/*.sh
git -C "$SRC" archive --format=tar "$REL" lib scripts drizzle messages tsconfig.json package.json package-lock.json > "$W/src.tar"
TAR_SHA=$(sha256sum "$W/src.tar" | cut -c1-64); echo "$TAR_SHA"
LOCK_SHA=$(git -C "$SRC" show "$REL:package-lock.json" | sha256sum | cut -c1-64); echo "$LOCK_SHA"
```
- 성공: `rel_on_main`이 나온다. 네 스크립트 해시가 0절 표와 같다(두 번 나오는 값이 서로 같다). `$TAR_SHA`·`$LOCK_SHA`를 적는다.
- 이어서 [확정본](2026-10-29-release-order.md) 3절 「배포 TARGET 확인」 블록을 이 셸에서 친다. `target_same_staged_tree`가 안 나오면 `REL` 뒤에 스테이징 경로를 바꾼 커밋이 main에 들어온 것이다. 이 묶음을 더 진행하지 않고 새 기준의 판을 받는다. 이전 기준(`1f52c9ef`)으로 만든 `$W`나 `/tmp` 스테이징이 있으면 쓰지 않는다. 이 판은 새 `$W` 경로를 쓴다.
- 이 셸의 `SRC`·`REL`·`SHA`·`W`·`DK`·`TAR_SHA`는 확정본 3단계 이후에도 그대로 쓴다. 셸을 새로 열면 이 블록을 다시 친다(같은 값이 나온다).

## 2. 근거 수집 (C2~C4, 읽기 전용)

### 2-1. M1 argv 만들기 (C2) — [gpu3090]
```sh
python3 -I -c 'import json,sys;print(json.dumps({"executable":"/bin/bash","args":["-c",open(sys.argv[1]).read(),"collect-m1"]}))' "$W/collect-m1.sh" > "$W/m1-argv.json"
python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["executable"])' "$W/m1-argv.json"
```
- 성공: `/bin/bash`가 나온다.

### 2-2. M1 수집 (C3) — [m1] device_admin(root)
- `$W/m1-argv.json`의 내용 그대로(`{"executable":"/bin/bash","args":["-c","<collect-m1.sh 본문>","collect-m1"]}`)를 m1studio device_admin에 넘긴다. stdout 전체를 gpu3090 `$W/pre/bundle-m1.json`에 저장하고, stderr 마지막 줄의 sha256을 적는다.
- **이 수집 중에도, 이 묶음이 끝난 뒤에도 M1 relay를 재시작하지 않는다**(확정본 17단계 전까지).
```sh
sha256sum "$W/pre/bundle-m1.json"
python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print("euid",d.get("euid"),"warnings",d["warnings"],"recoveryCandidates",len(d["recoveryCandidates"]));print("launchd",d["launchd"]);print("relay",d["relayProcess"]);print("native",d["nativeProcess"]);print("models",d["nativeModels"],"original",d["originalModel"])' "$W/pre/bundle-m1.json"
```
- 성공: device_admin exit 0, 두 sha256이 같다, `euid 0`, warnings `[]`, recoveryCandidates `1`. warnings에 `relay_active_json_present`만 있으면 해제 자체는 가능하다. 다만 OPEN 뒤에도 M1 경로는 막힌다(실행서 C3). recoveryCandidates가 여러 건이면 멈추고 proof 파일을 검토한다.

### 2-3. Swarm 수집 (C4) — [m3]·[mini]
```sh
xa-ssh m3ultra /bin/bash -s -- --host=m3ultra < "$W/collect-docker.sh" > "$W/pre/bundle-m3ultra.json"
xa-ssh mini /bin/bash -s -- --host=9mini < "$W/collect-docker.sh" > "$W/pre/bundle-9mini.json"
sha256sum "$W"/pre/bundle-*.json
python3 -I -c 'import json,sys;[print(p,json.load(open(p))["warnings"]) for p in sys.argv[1:]]' "$W/pre/bundle-m3ultra.json" "$W/pre/bundle-9mini.json"
```
- 성공: 각 exit 0, stderr의 sha256이 파일 해시와 같고 warnings가 `[]`다.

## 3. 유지보수 컨테이너 스테이징 (C5) — [m3]

### 3-1. 컨테이너와 전제 확인 (쓰기 0)
```sh
CID=$(xa-ssh m3ultra $DK ps -q --no-trunc --filter label=com.docker.swarm.service.name=app-navigate-neural-system-yf43c7); echo "$CID"
xa-ssh m3ultra "$DK exec $CID sh -c 'ls -d /app/scripts/ops 2>&1; ls /app/node_modules/.bin/tsx; sha256sum /app/package-lock.json; ls -la /tmp/nmv-release-29877f65 /tmp/nmv-release-order 2>&1'"
```
- 성공: CID가 정확히 1줄이다. `/app/scripts/ops`가 `No such file or directory`다(전제 확인). tsx가 있다. `/app/package-lock.json`의 sha256이 `$LOCK_SHA`와 같다. 두 `/tmp` 폴더가 없다.
- `/app/package-lock.json`이 `$LOCK_SHA`와 다르면 이미지 `node_modules`를 쓸 수 없다. 멈춘다.
- `/tmp` 폴더가 이미 있으면(이전 시도) 아무것도 올리지 않는다. 그 폴더의 `src.tar` sha256이 `$TAR_SHA`와 같고 `src`가 있으면 3-2를 건너뛴다. 다르면 `runs/`가 비어 있는지 보고 대표가 처리를 정한다(이 문서는 지우는 명령을 주지 않는다).

### 3-2. 올리기와 stage
```sh
xa-ssh m3ultra "$DK exec -i $CID sh -c 'umask 077 && mkdir -p /tmp/nmv-release-29877f65 && cat > /tmp/nmv-release-29877f65/src.tar && sha256sum /tmp/nmv-release-29877f65/src.tar'" < "$W/src.tar"
xa-ssh m3ultra "$DK exec -i $CID sh -s -- stage $TAR_SHA" < "$W/in-container.sh"
xa-ssh m3ultra "$DK exec -i $CID sh -c 'umask 077 && mkdir -p /tmp/nmv-release-order && cat > /tmp/nmv-release-order/src.tar && sha256sum /tmp/nmv-release-order/src.tar'" < "$W/src.tar"
xa-ssh m3ultra "$DK exec -i $CID sh -s -- stage $TAR_SHA" < "$W/capacity-control.sh"
```
- 성공: 두 원격 sha256이 `$TAR_SHA`와 같다. 첫 stage가 `{"staged":"/tmp/nmv-release-29877f65/src",…,"lock":"same_as_image"}`를, 둘째가 `{"staged":"/tmp/nmv-release-order/src","tarSha256":"<TAR_SHA>",…,"lock":"same_as_image"}`를 낸다.
- 실패: `package_lock_differs_from_image`·`source_tar_sha_mismatch`·`source_tar_unusable`이면 (capacity-control은) 아무것도 쓰지 않은 것이다. 멈춘다.

## 4. DB 대상과 M1 preflight (C6·C7, READ ONLY) — [m3]

```sh
xa-ssh m3ultra "$DK exec -i $CID sh -s -- db-target" < "$W/in-container.sh"
for f in bundle-m3ultra bundle-9mini bundle-m1; do xa-ssh m3ultra "$DK exec -i $CID sh -c 'umask 077 && cat > /tmp/nmv-release-29877f65/in/$f.json'" < "$W/pre/$f.json"; done
xa-ssh m3ultra "$DK exec -i $CID sh -s -- preflight $(sha256sum "$W/pre/bundle-m3ultra.json" | cut -c1-64) $(sha256sum "$W/pre/bundle-9mini.json" | cut -c1-64) $(sha256sum "$W/pre/bundle-m1.json" | cut -c1-64)" < "$W/in-container.sh" > "$W/pre/preflight.json"; echo "preflight exit=$?"
python3 -I -c '
import json,sys; d=json.load(open(sys.argv[1]))
print("blockedNow", d["blockedNow"])
print("applyRequires0143", d["applyRequires0143"], "readyForDrainWindow", d["readyForDrainWindow"], "requestState", d["requestState"])
print("capacity", d["capacity"], "schema", d["schema"])
for c in d["checks"]:
  if not c["ok"]: print("FAIL", c["name"], json.dumps(c.get("detail"))[:400])' "$W/pre/preflight.json"
```
- db-target 성공: host `100.99.209.55`, port `5432`, database `nomorevibe`, queryKeys는 `sslmode`뿐이다.
- **M1 `blockedNow` 읽는 법**
  - `preflight exit=0`이고 `blockedNow []`이면 통과다. 0143 전에는 `applyRequires0143 True`, `readyForDrainWindow False`, `schema.has0143 False`가 정상이다. `requestState`는 `indeterminate`이고 `capacity.mode`는 `open`이다. 이 경우에만 0143을 승인한다.
  - `exit=3`이면 `blockedNow`에 실패한 검사 이름이 나열된다. 이름별 뜻은 다음과 같다.

| `blockedNow`에 있는 이름 | 뜻 | 할 일 |
| --- | --- | --- |
| `m1_current_relay_is_recovered_process` | 복구 뒤 relay가 재시작됐다 | 이 경로로는 M1 해제가 영구히 불가하다. 0143을 승인해도 M1은 안 풀린다. 순서 전체를 멈추고 다시 판단한다 |
| `original_wire_reconstructed_matches_ledger` | 상품 원문이 바뀌었다 | 원문을 추측하지 않는다. 멈춘다 |
| `*_started_after_dispatch` | 그 컨테이너가 dispatch 뒤 교체되지 않았다 | 해제 근거가 없다. 멈춘다 |
| `request_present_indeterminate_unsettled` 등 `request_*` | 요청 행이 바뀌었거나 이미 정리됐다 | 2(d) S3로 상태를 본다 |
| 그 밖의 이름 | FAIL 줄의 `detail` | 그 검사 근거를 실행서 A-1 표에서 찾는다. 멈춘다 |
  - 어느 경우든 DRAIN하지 않는다. preflight는 DB를 쓰지 않는다.

## 5. 확정본 2단계 (a)~(e) — OPEN 상태 사전 확인 (쓰기 0)

### (a) capacity 상태 — [m3] 유지보수 컨테이너
```sh
xa-ssh m3ultra "$DK exec -i $CID sh -s -- status" < "$W/in-container.sh" > "$W/pre/status.json"
python3 -I -c 'import json,sys;s=json.load(open(sys.argv[1]))["snapshot"];c=s["capacity"];print("capacity",c["mode"],"EPOCH0",c["epoch"],"REV0",c["revision"],"fence",s["fence"]["state"],"dispatched",c["dispatched"],"indeterminate",c["indeterminate"])' "$W/pre/status.json"
```
- 성공: `capacity open`, `fence active`. `EPOCH0`·`REV0`를 적는다(확정본 7단계에서 `EPOCH1 = EPOCH0`, `REV1 = REV0`이어야 한다).

### (b) route 판정 — [m3] 유지보수 컨테이너(3-2의 `capacity-control` 스테이징 사용)
```sh
xa-ssh m3ultra "$DK exec -i $CID sh -s -- routes" < "$W/capacity-control.sh" | tee "$W/pre/routes.txt"
awk '/^\[capacity routes\]/{t=1;next} t&&NF&&$1!="route"{n++;if($NF!="serving"&&$NF!="unused"){d++;print "non-serving:",$0}} END{print "routes",n+0,"non_serving",d+0}' "$W/pre/routes.txt"
```
- **`non_serving` 읽는 법**: 마지막 줄 `routes N non_serving D`의 `D`를 `NONSERVING0`으로 적는다. 앞의 `non-serving:` 줄은 그 route·provider·model·status다(status는 `unmapped`·`no_contract`·`admission_only`·`stage_legacy`·`unknown` 중 하나다).
  - `D`는 같은 스테이징 소스와 이 컨테이너 env로 OPEN dry-run을 하면 거절 사유 `deferred_routes:D`가 될 수와 같다. 판정 함수가 같기 때문이다(`statusRouteContracts`·OPEN의 `routesFor` → `modelRouteContracts`·`usedModelRoutes`).
  - `D = 0`이면 배포 전에도 OPEN으로 되돌릴 수 있다(확정본 5절 실패 경로가 쓸 수 있다).
  - `D > 0`이면 배포 전 OPEN은 `deferred_routes:D`로 거절된다. 12단계(M1)에서 막히면 배포도 OPEN도 못 하고 DRAIN만 남는다. 9~19단계를 끝까지 이어야만 OPEN할 수 있다. 이걸 알고 시작할지 대표가 정한다(확정본 2단계 「실패 시」).
  - 배포 뒤(18단계)에는 새 이미지 env로 다시 센다. 그때는 0이어야 OPEN한다.
- `ERR_MODULE_NOT_FOUND`가 보이면 스테이징 없이 실행된 것이다(옛 `capacity-control.sh` 판 또는 3-2 누락). 이 출력을 route 판정으로 읽지 않는다.

### (c)·(d) S0·S3 — [m3] crawler-m3 컨테이너 READ ONLY
crawler-m3 앱 이름은 2026-09-26 기록의 `app-generate-haptic-card-vjqgv4`다. 아래에서 `SERVICE_INSTANCE_ID`가 `crawler-m3`인지 확인한다. 아니면 Dokploy 화면에서 crawler-m3의 appName을 확인해 `CCID` 줄만 바꾼다.
```sh
CCID=$(xa-ssh m3ultra $DK ps -q --no-trunc --filter label=com.docker.swarm.service.name=app-generate-haptic-card-vjqgv4); echo "$CCID"
xa-ssh m3ultra "$DK exec $CCID printenv SERVICE_INSTANCE_ID"
cat > "$W/sql/run.mjs" <<'EOF'
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
try {
  const rows = await sql.begin("read only", async (tx) => { await tx.unsafe("SET LOCAL statement_timeout = 5000"); return tx.unsafe(text); });
  console.log(JSON.stringify(rows, null, 1));
} finally { await sql.end({ timeout: 5 }); }
EOF
cat > "$W/sql/S0.sql" <<'EOF'
SELECT (SELECT mode FROM job_batch_control WHERE id=1) AS job_batch_mode,
  (SELECT writer_contract_version FROM job_batch_control WHERE id=1) AS writer_contract_version,
  c.mode AS capacity_mode, c.epoch, c.revision, c.policy->>'globalLimit' AS global_limit, c.policy->'poolLimits' AS pool_limits,
  (SELECT jsonb_object_agg(stage, mode) FROM pipeline_stage_modes) AS item_stage_modes
FROM model_capacity_control c WHERE c.id=1;
EOF
cat > "$W/sql/S3.sql" <<'EOF'
SELECT r.request_id, r.state, r.route_id, r.provider, r.model, r.group_id, r.provider_budget_id, r.pool, r.class,
  r.owner_instance_id, r.dispatched_at, r.updated_at,
  (r.epoch <> c.epoch OR r.revision <> c.revision OR r.policy_hash IS DISTINCT FROM c.policy_hash) AS old_policy,
  EXISTS (SELECT 1 FROM model_capacity_events e WHERE e.request_id = r.request_id AND e.kind = 'dispatch_local_ended') AS local_end_recorded
FROM model_capacity_requests r CROSS JOIN model_capacity_control c
WHERE c.id = 1 AND (r.state IN ('dispatched','indeterminate') OR (r.state = 'reserved' AND r.reserved_until > clock_timestamp())
  OR r.request_id::text LIKE '29877f65%' OR r.request_id::text LIKE '65f8c399%')
ORDER BY r.queue_ordinal;
EOF
for q in S0 S3; do python3 -I -c 'import json,sys;print("const text="+json.dumps(open(sys.argv[1]).read())+";");print(open(sys.argv[2]).read())' "$W/sql/$q.sql" "$W/sql/run.mjs" > "$W/sql/$q.mjs"; done
xa-ssh m3ultra "$DK exec -i $CCID node --input-type=module -" < "$W/sql/S0.mjs" | tee "$W/pre/S0.json"
xa-ssh m3ultra "$DK exec -i $CCID node --input-type=module -" < "$W/sql/S3.mjs" | tee "$W/pre/S3.json"
python3 -I -c 'import json,sys;rows=json.load(open(sys.argv[1]));[print(r["request_id"],r["state"],r["route_id"],r["group_id"],r["owner_instance_id"]) for r in rows];print("rows",len(rows))' "$W/pre/S3.json"
```
- 실행기는 관문 문서 7절과 같다(컨테이너 `DATABASE_URL`, READ ONLY 트랜잭션, 5초 제한). SQL만 stdin 모듈 안에 넣어 따옴표 문제를 없앴다. URL 값은 출력되지 않는다.
- (c) 성공: S0의 `job_batch_mode`가 `legacy`, `capacity_mode`가 `open`이고 epoch·revision이 (a)와 같다. `legacy`가 아니면 14단계 job-pause를 쓸 수 없다(관문 문서 2절 ①).
- (d) 성공: S3이 정확히 2행이다. `29877f65-…`는 `indeterminate`·`product-translate`이고, `65f8c399-…`는 `indeterminate`·`crawl-agent-review`·owner M3 reviewer다. 그 밖의 `dispatched`·`indeterminate`·유효 `reserved` 행이 없다. 더 있으면 배포 관문을 통과할 수 없으므로 순서를 시작하지 않는다.

### (e) R1 경보 단계 — [m3] crawler-m3 컨테이너
```sh
xa-ssh m3ultra "$DK exec $CCID node --import tsx scripts/check-worker-progress.ts" > "$W/pre/r1.json"; echo "r1 exit=$?"
python3 -I -c '
import json,sys; r=json.load(open(sys.argv[1])); print("overall", r["overall"])
for s in r["stages"]:
  if s["alarm"] or s["reason"] in ("paused","unknown_age"): print(s["stage"], s.get("job"), s["reason"], "wait", s.get("waiting"), "oldest", s.get("oldestMinutes"), "done5m", s.get("completed5m"), "err5m", s.get("errors5m"))
for k in ("liveness","lanes"):
  for x in r.get(k) or []:
    if x.get("alarm"): print(k, x)
print("scheduler", r["scheduler"]["reason"], r["scheduler"]["overdueJobs"])' "$W/pre/r1.json"
```
- 경보가 있으면 exit가 0이 아닐 수 있다. JSON이 저장됐으면 그대로 읽는다.
- 판단(확정본 2단계 (e)): 출력된 단계를 관문 문서 3절 표에서 찾는다. pause 대상(「예」·조건부)이거나 first·second이면 시작을 막지 않는다. 생존(`liveness`)·`lanes`·scheduler, fetch·judge·publish·evidence 등 「아니오」인 경보가 하나라도 있으면 시작하지 않는다.

## 6. 결과 기록과 다음 단계

`$W/pre/`의 `preflight.json`·`status.json`·`routes.txt`·`S0.json`·`S3.json`·`r1.json`을 보존한다. 아래 표를 채운다.

| 값 | 결과 | 통과 조건 |
| --- | --- | --- |
| C1 해시 4개 | | 0절 표와 같음 |
| C3·C4 sha·warnings | | 일치, `[]` |
| C5 원격 sha·stage 2건 | | `$TAR_SHA`, `same_as_image` |
| M1 `blockedNow` | | `[]` (exit 0) |
| `EPOCH0`·`REV0` | | capacity `open`, fence `active` |
| `NONSERVING0` | | 0이 아니면 실패 경로 제약을 알고 시작할지 결정 |
| `job_batch_mode` | | `legacy` |
| S3 미확인 | | 정확히 29877f65·65f8c399 2건 |
| R1 「아니오」 경보 | | 없음 |

모두 통과하면 확정본 1단계(0143 승인·적용)로 간다. 적용 뒤에는 같은 `$CID` 스테이징으로 4절 preflight를 다시 친다(`schema.has0143 true`, `readyForDrainWindow true`, `blockedNow []`). 그동안 컨테이너가 바뀌어 CID가 다르면 3절부터 다시 한다. 이 셸 변수와 `/tmp` 스테이징은 확정본 2단계 이후에도 그대로 쓴다.

## 7. 이 문서의 검증 (작업자, 운영 접근 없음)

- 0절 표는 `REL=f4fe5958…`(PR #735 병합 main)에서 gpu3090 git으로 다시 계산했다(이전 판은 `1f52c9ef…`). 파일 해시는 확정본 표 3·실행서 표 0의 값과 같고, `tests/release-order-hashes.test.ts`가 두 표와 코드를 대조한다. `package-lock.json`은 운영 이미지 199a3ebb의 것과 같다(`git diff 199a3ebb f4fe5958 -- package-lock.json` 차이 없음). 그러므로 3-1의 `$LOCK_SHA` 비교는 통과할 것으로 예상된다. 실제 판정은 대표가 컨테이너에서 한다.
- 1절 블록을 이 저장소에서 그대로 실행했다. `rel_on_main`과 네 해시, `TAR_SHA`가 표와 같았다. 같은 `src.tar`로 다음 둘을 확인했다.
  - busybox `sh`로 `capacity-control.sh stage`를 실행했다. `/app`에 `scripts/ops`가 없고 lock이 같은 모의 이미지에서 `lock:"same_as_image"`가 나왔다.
  - 그 스테이징 소스에서 `pipeline-control status`가 로컬 시험 DB로 실행됐다(`node_modules`는 이미지 쪽 심링크만 사용).
- 5절의 SQL 실행기(stdin 모듈), S0·S3 SQL, R1 파서, 2(b) awk를 로컬 시험 DB(0144까지 적용)의 실제 출력에 돌려 형식이 맞음을 확인했다. awk 집계가 OPEN의 `deferred_routes` 판정과 같다는 것은 `tests/release-order-capacity-control.test.ts`가 시험한다.
- 운영(M3·mini·m1studio·운영 DB)에서는 아무것도 실행하지 않았다. 표의 결과 칸은 대표가 채운다.
