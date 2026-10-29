**결론: 순환 의존은 코드상 실제였다. 해소는 두 가지 정식 도구로 했다. ① 운영 웹(199a3ebb)에 버튼이 없어도 Supa job을 웹과 같은 함수·감사·직렬화로 접수하는 운영자 셸 CLI(`scripts/ops/admin-models-ops-submit.ts`). ② runner가 마지막에 OPEN하지 않고 **자기가 건 DRAIN을 그대로 인계**하는 검토된 profile 선택(`finalAdmission:"draining"`, 마지막 단계 `handoff`). 이 둘로 순서는 한 줄이 된다. 0143(+0144) → OPEN 상태에서 Supa runner가 DRAIN을 건다 → Supa 해제 → 그 DRAIN을 인계받아 M1 해제 → 미확인 0 → 배포 → M1 relay 재설치 → OPEN. 배포 전에는 OPEN을 한 번도 하지 않는다. 관문 면제·시간 경과 해제·DB 직접 UPDATE는 쓰지 않았다.**

# 미확인 2건 해제와 배포의 실행 순서 확정본 (2026-10-29)

작업자는 원격 명령·운영 DB 읽기/쓰기·0143 적용·DRAIN·배포를 하지 않았다. 아래는 모두 대표가 실행할 목록이다. 각 단계의 성공 조건을 확인한 뒤에만 다음 단계로 간다. 응답이 불명확하면 같은 쓰기를 다시 요청하지 않고, 읽기로 먼저 확인한다. **[승인]** 표시는 사람이 명시적으로 승인한 뒤 실행할 단계다.

세부 명령은 다음 두 문서의 절 번호를 그대로 참조한다. 이 문서와 다르게 적힌 곳이 있으면 이 문서를 따른다.
- 실행서: [2026-10-29-unknown-release-runbook.md](2026-10-29-unknown-release-runbook.md) (M1 = A절 C1~C7·D1~D10, Supa = B절 S1~S14)
- 경보 잡 멈춤: [2026-10-29-monitor-gate-pause-plan.md](2026-10-29-monitor-gate-pause-plan.md) (R1, S0~S7, 4절, 6절 resume 순서)

## 1. 순환이 실제였는지 (코드 근거)

| 의심 | 판정 | 근거 |
| --- | --- | --- |
| 배포는 미확인 0건을 요구한다 | **실제** | `scripts/ops/deploy_release.py` `model_replacement_gate`는 교체 대상에 `web-*`이나 reviewer·publisher·text·maintenance가 하나라도 있으면 `mode='draining'`과 `dispatched`·`indeterminate`·유효한 `reserved`가 **0건**이어야 통과한다. 면제 인자는 없다. web도 모델 owner로 취급되므로 웹만 먼저 배포하는 길도 이 관문에서 막힌다. 앱 일부만 고르는 plan 옵션도 없다(`create_plan`은 `impact()` 결과를 그대로 쓴다) |
| Supa 해제는 배포를 요구한다 | **실제였다(해소)** | job은 append-only `operations_audit`의 `ops-runner-state` 행이다. 이 행을 만드는 곳은 `submitModelOpsCommand` 하나뿐이고, 이를 부르는 것은 웹 액션 `app/(operator)/admin/models/ops-runner-actions.ts`뿐이었다. 199a3ebb 트리에는 `lib/operations/ops-runner/`와 이 액션이 **둘 다 없다**(`git ls-tree 199a3ebb`). runner CLI는 job이 없으면 `ops_runner_job_missing`으로 끝난다 |
| 배포를 먼저 해도 Supa는 풀 수 없다 | **실제** | Supa adapter prepare는 요청 owner(M3 reviewer)의 incarnation이 그대로여야 한다. 배포가 reviewer를 교체하면 `request_owner_incarnation_changed`로 이 경로가 영구히 막힌다(실행서 B-3) |
| runner는 DRAIN이면 시작을 거절한다 | **실제(유지)** | `operator.ts` prepare: `prepared.original.mode !== "open"`이면 `original_admission_mode_not_expected`. 이 보호는 바꾸지 않았다 |
| runner는 끝에 OPEN하는데 M1·배포는 DRAIN이 필요하다 | **실제였다(해소)** | runner 마지막 단계는 `controlOpsAdmission(open)`이다. 이 단계는 runner 프로세스 env로 route를 판정하는 `runPipelineControl`을 `allowDeferredRoutes:false`로 부른다. 199a3ebb에서는 모델 이름 고정 때문에 deferred route가 남을 수 있다(관문 문서 6절 8번). 거절되면 다시 실행해도 `controlOpsAdmission(reconcile)`은 커밋 기록이 없으므로 `control_not_committed_reprepare_required`만 낸다. 그러면 job이 영구 `blocked`가 되고, `opsHoldsBoundary`가 이후 모든 job 접수를 막는다. 성공하더라도 Supa→OPEN→M1 DRAIN 사이에 새 호출이 끼어든다 |
| Supa 해제에 0143이 필요하다 | 아님 | Supa는 `provider_boundary_exit`(0140~0142, 운영 적용됨)이다. `capacity-repository.ts`는 `replaced_provider_boundary_exit`일 때만 0143 함수를 부르고, 0143은 기존 CHECK에 OR 분기만 더한다. 순서상 0143을 먼저 적용하는 것은 M1과 배포 때문이다 |
| job-pause가 199a3ebb에 없다 | 아님 | `admin-job-control.ts`·`job-control-actions.ts`가 199a3ebb에 있고 main과 차이가 없다. worker-progress 판정 코드도 같다 |

## 2. 해소 방법 (구현, 브랜치 `xaegis/7b7a2d23`)

1. **운영자 셸 job 접수** `scripts/ops/admin-models-ops-submit.ts` — `request-release`만 받는다. 기본은 READ ONLY 미리 보기다(`previewModelOpsCommand`: writer fence, 같은 ID 충돌, 미완료 job, 대상 `indeterminate` 여부와 group·owner). `--execute`는 웹과 **같은** `submitModelOpsCommand`를 부르므로 advisory lock 7219401, writer fence, 미완료 job 직렬화, indeterminate 재확인, append-only 감사 행이 모두 그대로다. 웹 로그인으로 인증된 것이 아니므로 감사 행의 `actor_kind`는 `pipeline-control` CLI처럼 비운다(NULL). 응답이 불명확하면 같은 `--id`로 다시 실행한다. 기존 job을 돌려받을 뿐 새로 만들지 않는다.
2. **DRAIN 인계** — operator profile에 `finalAdmission:"draining"`을 넣으면 마지막 단계가 `open` 대신 `handoff`가 된다. handoff는 capacity를 바꾸지 않는다. 같은 트랜잭션에서 다음을 확인하고 기록한다. (a) writer fence, (b) 이 job이 직접 커밋한 `ops-runner-control <id>:draining` 감사의 핀이 runner가 저장한 drained 핀과 같다(자기 DRAIN만 인계), (c) `model_capacity_control` 행을 `FOR UPDATE`로 잠근 현재 핀이 그 핀과 정확히 같고 `draining`이다. 그다음 `ops-runner-control <id>:handoff` 감사 행을 한 번만 쓴다. 다른 사람이 그사이 control을 바꿨으면 `handoff_drain_changed`, 자기 DRAIN이 아니면 `handoff_drain_not_owned`로 멈춘다. profile은 prepare 때 hash로 고정되므로 시작한 뒤에는 바꿀 수 없다(`ops_runner_profile_changed`). 접수(admission) job에는 쓸 수 없다. `build-manifest.py --final-admission=draining`이 이 값을 profile에 넣는다. 관리 화면 카드는 마지막 단계를 「DRAIN 유지·다음 절차 인계」로 보여 주고, 「이 작업은 끝나도 접수를 DRAIN으로 둡니다」라는 안내를 단다.
3. **배포 뒤 OPEN 실행기** `scripts/ops/release-order/capacity-control.sh` — 배포가 유지보수 컨테이너를 교체하면 M1용 `/tmp` 스테이징이 사라진다. 그래서 새 컨테이너의 `/app`(배포 SHA)에서 정식 `pipeline-control`의 `status`·`routes`·`open`(기본 dry-run)만 실행하는 실행기를 만들었다. `--allow-deferred-routes`는 받지 않는다.

M1 쪽 코드는 바꾸지 않았다. M1 plan은 `capacity_draining`만 검사하므로(`assemble.ts`) 인계받은 DRAIN에서 그대로 plan을 만들 수 있다.

## 3. 공통 값

| 이름 | 값 |
| --- | --- |
| 도구 소스 | gpu3090 작업 공간 `SRC=/home/ubuntu/.xaegis-hub/data/local-agent/worktrees/7b7a2d23-0c49-41f3-9665-1fc4e53ff9a0`, 브랜치 `xaegis/7b7a2d23`(push 안 함). `xaegis/4ed4ea33`·`xaegis/4cefcc24`를 포함한다. `REL=$(git -C "$SRC" rev-parse xaegis/7b7a2d23)`를 적어 둔다. 실행서 A절의 `SHA`와 B절의 `T` 모두 이 `REL`을 쓴다 |
| runner 실행 트리 | `T=/home/ubuntu/ops/nmv-runner-$REL`(실행서 S1의 `git archive 75b8aa31` 대신 `git -C "$SRC" archive "$REL"`). runner와 접수 CLI가 이 커밋 코드여야 handoff를 쓸 수 있다 |
| 요청 | M1 `29877f65-9f95-4efb-88f9-aea5f39a28b2`, Supa `65f8c399-ff4b-47bc-8f4d-6e4a682cf6a7` |
| 유지보수 컨테이너 | m3ultra Swarm `app-navigate-neural-system-yf43c7`. `DK='env PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin docker'` |
| 직접 primary | `100.99.209.55:5432/nomorevibe`(PgBouncer 아님) |

검토할 SHA-256(`git show $REL:<파일> | sha256sum`). 실행서 표 0의 M1 스크립트·adapter·helper 해시는 바뀌지 않았다.

| 파일 | SHA-256 |
| --- | --- |
| `scripts/ops/admin-models-ops-submit.ts` (신규) | `b9f2bb1a8c56cc4eecb86c8ec206a3f38f76830c9d00711b3c9ffc9174ba94ea` |
| `scripts/ops/release-order/capacity-control.sh` (신규) | `3ae03fe3f2904d384e762db2821be1d04b9a800e875415fd25ced204e59adb62` |
| `scripts/ops/release-65f8c399/build-manifest.py` (변경) | `1d974717b4b6b45ffa1e6119f05edfca003cb217dcb92feafbf26e692c2285c7` |
| `lib/operations/ops-runner/operator.ts` (변경) | `0747b9dd38e2a629857cf8c6e7b3d67b9d9b91ed88535ee635555b7bb2fc17e9` |
| `lib/operations/ops-runner/control.ts` (변경) | `e152b09a1594f2298e7f2a2fc76b0e0a3fff3d0a89f9bf7e443f747509f22c92` |
| `lib/operations/ops-runner/repository.ts` (변경) | `cbb68dafe697b7300ab0594924b0dd4792ac06b92bb655f4af223719e8b9564f` |
| `lib/operations/ops-runner/runner.ts` (변경) | `1ca48790e752655243b06c8035947066b498fd84ae8aa0defddbb15c7c99820d` |
| `lib/operations/ops-runner/contract.ts` (변경) | `0fb66a9c36fc65a544d892af2ce67000c9357f89a31659311b98e3b6e1aebfb3` |
| `scripts/ops/admin-models-ops-runner.ts` (main 그대로) | `78df32f4cbaeef344dc4a09a784cb6523306f04fc54b15cb27f666531e271034` |
| `scripts/ops/admin-models-boundary-adapter.py` (main 그대로) | `f51d5ef76232bf74e652a27627aabed97236029ae1c17742a55df55311707f61` |

## 4. 실행 순서

**전체 전제(하나라도 아니면 시작하지 않는다)**: 다른 차선(49b91700 등)의 작업이나 배포가 진행 중이 아니다. ops-runner 미완료 job이 없다. M1 relay를 재시작하지 않았다(06:33Z 이후 M3 reviewer도 재배포되지 않았다). capacity가 `open`이다.

### 1. [승인] 0143(+0144) 적용과 적용 확인
- 위치: 적용은 대표의 정식 migration 절차로 한다(이 문서 범위 밖). 확인은 m3ultra 유지보수 컨테이너에서 한다(실행서 C5에서 올린 소스 사용).
- 전제: 실행서 C1~C7을 0143 **전에** 한 번 통과했다(`blockedNow: []`). 막히는 근거가 있으면 0143을 적용해도 M1은 풀 수 없다. 그때는 이 순서 전체를 멈추고 다시 판단한다.
- 명령: 적용 뒤 실행서 C7 preflight를 다시 실행한다. 이어서 관문 문서 7절 SQL 실행기(crawler-m3, READ ONLY)로 아래를 읽는다.
```sql
SELECT (SELECT count(*) FROM drizzle.__drizzle_migrations) AS applied,
  (SELECT array_agg(hash ORDER BY id DESC) FROM (SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 2) t) AS last_two,
  to_regclass('model_capacity_requests_settled_at_idx') IS NOT NULL AS idx_settled, to_regclass('model_capacity_requests_withdrawn_at_idx') IS NOT NULL AS idx_withdrawn;
```
- 성공: preflight가 `schema.has0143: true`, `schema.guardTrigger: true`, `readyForDrainWindow: true`, `blockedNow: []`를 보인다. SQL은 `applied`가 145이고 `last_two`가 0144 `b332c698…ce4e`, 0143 `3cce45c4…c173`이며(각각 `sha256sum drizzle/014[34]_*.sql`과 같아야 한다) 두 인덱스가 true다.
- 실패 시: migration이 일부만 적용됐거나 hash가 다르면 멈춘다. 이후 어떤 단계도 하지 않고 migration 기록과 DB 로그를 본다.

### 2. OPEN인 상태에서 사전 확인 (쓰기 0)
- 위치: gpu3090 셸 → m3ultra 유지보수 컨테이너, crawler-m3
- 명령: (a) `xa-ssh m3ultra "$DK exec -i $CID sh -s -- status" < "$W/in-container.sh"`를 실행해 capacity `open`, `EPOCH0`·`REV0`를 적는다. (b) `xa-ssh m3ultra "$DK exec -i $CID sh -s -- routes" < capacity-control.sh`(아래 `CC`)를 실행한다. 현재 이미지 env 기준으로 serving·unused가 아닌 route 수를 적는다. (c) 관문 문서 S0을 실행해 `job_batch_mode`를 확인한다. (d) S3을 실행해 미확인이 정확히 2건(29877f65·65f8c399)이고 다른 활성이 0인지 확인한다.
  - `CC`: `git -C "$SRC" show "$REL:scripts/ops/release-order/capacity-control.sh" > "$W/capacity-control.sh"`. sha256이 표 3과 같아야 한다.
- 성공: (c)가 `legacy`다(아니면 14단계의 job-pause를 쓸 수 없다. 관문 문서 2절 ①을 따른다). (d)의 미확인이 그 2건뿐이다.
- 실패 시: 미확인이 더 있으면 그 요청이 없어지기 전에는 배포 관문을 통과할 수 없다. 이 순서를 시작하지 않는다. (b)에서 non-serving route가 있으면 **배포 전 OPEN이 거절될 수 있다는 뜻**이다. 그 경우 아래 실패 경로의 「배포 전 OPEN」을 쓸 수 없고, 9~19단계를 끝까지 이어야만 OPEN할 수 있다. 이 사실을 알고 시작할지 대표가 정한다.

### 3. Supa 준비 (쓰기 0, DRAIN 없음)
- 위치: gpu3090 **실제 로그인 셸**. 단 S2의 설치만 device_admin(supa)에서 한다.
- 명령: 실행서 S1(단 `T`는 표 3의 `REL` archive), S2(root helper 설치, **[승인]** device_admin supa), S7(DB 연결 준비).
- 성공: 실행서 각 절의 성공 조건을 따른다. `git -C "$SRC" archive "$REL" | (mkdir -p "$T" && tar -x -C "$T")` 뒤 `sha256sum "$T/scripts/ops/admin-models-ops-submit.ts"`가 표 3과 같다.
- 실패 시: 해당 절에서 멈춘다. DRAIN 전이므로 운영 영향은 없다.

### 4. [승인] Supa job 접수 (운영자 셸 CLI)
- 위치: gpu3090 실제 셸(S7의 `DATABASE_URL`이 들어 있는 같은 셸)
- 명령:
```sh
JOB=$(python3 -I -c 'import uuid;print(uuid.uuid4())'); echo "$JOB"     # 적어 둔다. 재시도에도 같은 값을 쓴다
cd "$T" && node --import tsx scripts/ops/admin-models-ops-submit.ts --target=65f8c399-ff4b-47bc-8f4d-6e4a682cf6a7 --id="$JOB" --operator=<OP> --reason="Supa 65f8c399 provider boundary release; drain handed to M1 29877f65 and deploy (release-order 2026-10-29)"
#   ↑ 미리 보기. 아래는 같은 인자에 --execute
cd "$T" && node --import tsx scripts/ops/admin-models-ops-submit.ts --target=65f8c399-ff4b-47bc-8f4d-6e4a682cf6a7 --id="$JOB" --operator=<OP> --reason="<위와 같은 문자열>" --execute | tee "$HOME/ops-$JOB-submit.json"
```
- 전제: 2·3단계가 끝났고 4~11단계를 이어 갈 시간이 있다(접수한 job은 끝날 때까지 다른 job 접수를 막는다. 5절). 미리 보기에서 `blocked: []`가 나오고, `request.state`가 `indeterminate`, `request.groupId`(= `GROUP`)가 Supa 물리 그룹, `request.ownerInstanceId`가 M3 reviewer다.
- 성공: exit 0이고 `state.status: "queued"`, `state.id == $JOB`이며 `state.auditId`가 숫자다. 관문 문서 7절 실행기로 `SELECT id, actor, actor_kind, detail->>'status' FROM operations_audit WHERE action='ops-runner-state' AND target='<JOB>'`를 읽으면 1행이 나오고 actor_kind가 NULL이다.
- 실패 시: exit 3(`ops_runner_unfinished_operation`, `request_not_indeterminate`, `id_conflict`, `dr_writer_site_fenced`)이면 아무것도 쓰지 않은 것이다. 원인을 본다. exit 1 `ops_submit_unconfirmed_readback_required`이면 같은 `--id`로 미리 보기를 다시 실행한다. `existing`이 나오면 접수된 것이다. 새 ID로 다시 접수하지 않는다.

### 5. Supa 스냅샷·manifest(인계 선택)·prepare (쓰기는 감사 행만, DRAIN 없음)
- 위치: gpu3090 실제 셸
- 명령: 실행서 S4, S5(아래처럼 마지막 인자 추가), S6, S8.
```sh
python3 -I "$T/scripts/ops/release-65f8c399/build-manifest.py" --job="$JOB" --out-dir="/home/ubuntu/ops/jobs/$JOB" \
  --adapter="$T/scripts/ops/admin-models-boundary-adapter.py" --affected-group="$GROUP" --container-progress-root=/Users/jr/.nmv-admin-models-progress \
  --owner="jr@m3Ultra:$I/owner.json" --gateway-m3="jr@m3Ultra:$I/gw-m3.json" --gateway-mini="<MINI_SSH>:$I/gw-mini.json" --provider="jr@supa:$I/supa.json" \
  --final-admission=draining
python3 -I -c 'import json,sys;p=json.load(open(sys.argv[1]));print(p["finalAdmission"],p["affectedGroups"])' "/home/ubuntu/ops/jobs/$JOB/profile.json"
```
- 성공: profile이 `draining ['<GROUP>']`을 출력한다. S8 prepare 출력이 `status:"queued"`, `steps.prepare:"done"`, `finalAdmission:"draining"`이고 `rootHandoffFile`이 있다.
- 실패 시: 실행서 S8의 처리와 같다. `original_admission_mode_not_expected`이면 이미 누군가 DRAIN한 것이다. 멈추고 그 DRAIN의 출처(감사)를 확인한다. 이 runner로 남의 DRAIN을 이어받지 않는다.

### 6. root task 전달 확인
- 위치: gpu3090 → supa(jr 전달), device_admin(supa) 읽기 확인
- 명령: 실행서 S9
- 성공: stop·restore 두 task의 sha가 로컬과 supa에서 모두 같다. **stop argv는 아직 실행하지 않는다.**

### 7. [승인] runner run → DRAIN 시작 → stop 대기
- 위치: gpu3090 실제 셸. 명령: 실행서 S10.
- 성공: exit 1, `status:"manual"`, `step:"stop"`, `code:"supa_root_result_required"`. 이때부터 **모든 모델 호출이 미뤄진다**. capacity는 `draining`이고 revision은 `REV0+1`이다.
- 실패 시: `blocked`이면 code를 본다. DRAIN 뒤의 실패라면 runner가 DRAIN을 쥔 상태다. **수동으로 OPEN하지 않는다**(job이 경계를 쥐고 있다). 같은 `run`으로 이어가거나, 막힌 원인이 해소되지 않으면 아래 「실패 경로」를 따른다.

### 8. [승인] root stop (device_admin, supa)
- 명령: 실행서 S11(handoff 파일 stop 줄 그대로). 확인도 S11과 같다.

### 9. runner run → 해제 → restore 대기
- 명령: 실행서 S12. 성공: `step:"restore"`, `code:"supa_root_result_required"`.

### 10. [승인] root restore (device_admin, supa)
- 명령: 실행서 S13.

### 11. runner run → 복원 → **DRAIN 인계로 완료**
- 위치: gpu3090 실제 셸. 명령: 실행서 S10과 같은 run.
- 성공: exit 0이고 `status:"completed"`, `steps["verify-restored"]:"done"`, `steps.handoff:"done"`이며 `steps.open`이 없다. 그다음 읽기 확인을 한다. 유지보수 컨테이너 `status`가 capacity **`draining`**과 `EPOCH1`·`REV1`(7단계와 같은 값)을 보인다. 관문 문서 S3에서 65f8c399가 `withdrawn`이다. `SELECT target, detail FROM operations_audit WHERE action='ops-runner-control' AND target IN ('<JOB>:draining','<JOB>:handoff') ORDER BY id`가 2행이고, 두 행의 `detail.after`가 서로 같다.
- 실패 시: `handoff_drain_changed`이면 runner 밖에서 control을 바꾼 것이다(누가 OPEN·정책 변경을 했는지 감사로 확인한다). 이 상태로 M1을 진행하지 않는다. `handoff_drain_not_owned`이면 이 job의 DRAIN 기록이 핀과 다르다. 멈추고 감사 기록을 검토한다. 둘 다 서비스(reviewer·gateway·Supa)는 이미 복원된 뒤다.

### 12. M1 해제 — 인계받은 DRAIN 안에서 (D2·D10은 하지 않는다)
- 위치: m1studio(device_admin) · gpu3090 → m3ultra/mini(xa-ssh) · m3ultra 유지보수 컨테이너
- 명령: 실행서 D1 → (D2 생략) → D3 plan → D4 plan 뒤 수집 3건 → D5 receipt → D6 dry-run → **[승인]** D7 apply → D8 readback → D9. **D10(OPEN)은 실행하지 않는다.**
- 전제: 11단계가 성공했다. D1 status가 `draining`, `EPOCH1`·`REV1`이다(실행서의 `open`·rev 7 대신 이 값을 쓴다). Supa runner가 gateway 2개와 reviewer를 다시 시작했으므로 0143 뒤의 C7 결과는 그대로 믿지 않는다. D4 수집이 새 컨테이너를 다시 본다(dispatch 뒤 시작, 실행 task 1개 조건은 그대로 성립해야 한다).
- 성공: D7이 `{"dryRun":false,"result":{"kind":"released","auditId":N}}`를 낸다. D8이 `released: true`를 보인다. D9에서 capacity가 여전히 `draining`·`REV1`이다.
- 실패 시: D3~D6이 5분 마감을 넘기면 실행서 D6대로 새 RUN으로 D3부터 다시 한다(DRAIN 유지). M1 근거가 성립하지 않으면(`m1_current_relay_is_recovered_process` 등) 이 DRAIN에서는 M1을 풀 수 없다. 그러면 배포도 할 수 없다. 아래 「실패 경로」로 간다.

### 13. 미확인·활성 0건 확인 (READ ONLY)
- 위치: crawler-m3 컨테이너(관문 문서 7절 SQL 실행기)
- 명령: 관문 문서 S3과, 배포 관문과 같은 아래 질의를 실행한다.
```sql
SELECT pg_is_in_recovery() AS replica, (SELECT mode FROM model_capacity_control WHERE id=1) AS mode,
  (SELECT count(*)::int FROM model_capacity_requests WHERE state IN ('dispatched','indeterminate') OR (state='reserved' AND reserved_until>clock_timestamp())) AS active;
```
- 성공: `replica=false`, `mode='draining'`, `active=0`이다. S3에서 29877f65·65f8c399가 모두 `withdrawn`이다.
- 실패 시: 활성이 남았으면 그 요청을 확인한다. 정상 호출이 끝나기를 기다리는 것만 허용한다. 미확인이 새로 생겼으면 배포하지 않는다.

### 14. 경보 잡 job-pause (관리 화면)
- 위치: `/admin/status` → 작업 상세 → 「이 작업 멈춤」(관문 문서 4절)
- 명령: 관문 문서 R1로 `overall`과 경보 단계를 보고, **경보인 잡만** 하나씩 멈춘다. 기본 후보는 `product-translate`·`product-tagline-ko`·`crawl-tagline`·`product-search-profile`이고, 경보일 때만 `reason-translate`·`product-search-verify`·`product-intro-check`를 더한다. 잡마다 S7로 `job-pause` 감사 행을 확인한다.
- 성공: R1 `overall == "ok"`.
- 실패 시: 관문 문서 3절에서 pause 대상이 「아니오」인 경보가 남으면 배포를 멈춘다(면제 금지). `job_control_unsupported_mode`이면 2절 ①을 따른다.

### 15. 배포 plan
- 위치: gpu3090(배포 대상 main SHA를 checkout한 깨끗한 트리, `deployment-fast-path.md`)
- 전제: 배포 대상 `TARGET`은 CI `check`와 이미지가 준비된 main 40자리 SHA다. 0143·0144를 포함하므로 `--migration-verified`가 필요하다. 이 브랜치의 PR을 먼저 병합해 `TARGET`에 넣는 것을 권한다(관리 화면의 handoff 표시, 정식 접수 CLI). 넣지 않아도 안전에는 영향이 없다. 화면이 마지막 단계를 「접수 재개 (OPEN) · 대기」로 보일 뿐이다.
```sh
xa-key exec DOKPLOY_API_KEY=gpu3090/dokploy -- env NMV_DEPLOY_SSH_USER=jr npm run deploy -- plan --sha "$TARGET" --migration-verified \
  --out "$HOME/.local/state/nomorevibe-releases/release-order-20261029-<처음 쓰는 이름>"
```
- 성공: `status:"planned"`가 나온다. `planSha256`와 `selectedApps`를 적는다. `serviceMutations: 0`이다.
- 실패 시: `database_changes_require_migration_verified`는 플래그가 빠진 것이다. monitor 관문 실패는 14단계로 돌아간다. readiness 미준비면 기다리며 배포 요청은 하지 않는다.

### 16. [승인] 배포 run
- 명령: `xa-key exec DOKPLOY_API_KEY=gpu3090/dokploy -- env NMV_DEPLOY_SSH_USER=jr npm run deploy -- run --plan "$PLAN" --plan-sha "$PLAN_SHA256"`
- 성공: `status:"deployed-and-verified"`가 나온다. execution 디렉터리의 `model-drain.safe.json`이 `{"required":true,"mode":"draining","active":0,…}`이고 관측 예약 영수증이 있다.
- 실패 시: `model_replacement_requires_explicit_drain_and_zero_active_calls`는 13단계 조건이 깨진 것이다. 서비스 변경은 0이지만 execution 디렉터리가 소모됐으므로 새 plan이 필요하다. 그 밖의 중단은 `stopped.safe.json`을 보고 marker를 다시 쓰지 않는다(deployment-fast-path).

### 17. [승인] M1 relay 재설치 (device_admin, m1studio)
- 전제: 12단계 M1 해제가 끝났다(그 전에는 절대 하지 않는다). capacity가 아직 `draining`이다.
- 설치본: `<REVIEWED_SHA>` = `TARGET`. 대표가 `/var/tmp/nmv-relay-reviewed/$TARGET`에 그 SHA의 완전한 설치본(의존성 포함)을 준비한다. 준비할 때 `find /var/tmp/nmv-relay-reviewed/$TARGET -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256`을 기록하고, ditto 직전에 같은 값인지 다시 확인한다.
- 명령: `2026-10-29-m1-relay-model-handoff.md` 「대표용 M1 argv」 jsonl을 한 줄씩 실행한다(backup·release 목적지는 처음 쓰는 경로).
- 성공: launchd readback이 `state = running`과 새 pid를 보인다. `/v1/models` id가 `mlx-community--gemma-4-26b-a4b-it-4bit`이다. plist의 `LOCAL_MODEL_RELAY_VERSION`이 `TARGET`이다.
- 실패 시: bootout 뒤 bootstrap이 실패하면 relay가 없는 상태다. backup으로 되돌릴지는 대표가 판단한다. capacity는 DRAIN이므로 M1 요청은 들어오지 않는다.

### 18. [승인] 접수 OPEN
- 위치: gpu3090 → **배포 뒤 새** m3ultra 유지보수 컨테이너
```sh
NCID=$(xa-ssh m3ultra $DK ps -q --no-trunc --filter label=com.docker.swarm.service.name=app-navigate-neural-system-yf43c7)   # 정확히 1줄
xa-ssh m3ultra "$DK exec -i $NCID sh -s -- status" < "$W/capacity-control.sh"        # draining, EPOCH1·REV1 확인
xa-ssh m3ultra "$DK exec -i $NCID sh -s -- routes" < "$W/capacity-control.sh"        # serving·unused 밖 route 0 확인
xa-ssh m3ultra "$DK exec -i $NCID sh -s -- open $EPOCH1 $REV1 <OP> release-order-20261029-open" < "$W/capacity-control.sh"
xa-ssh m3ultra "$DK exec -i $NCID sh -s -- open $EPOCH1 $REV1 <OP> release-order-20261029-open --execute" < "$W/capacity-control.sh"
```
- 성공: dry-run에서 `blocked`가 비어 있고, execute가 exit 0과 `executed:true`를 낸다. 다시 `status`를 보면 `open`이다.
- 실패 시: `deferred_routes:N`이면 모델 이름 고정이나 relay 계약이 아직 맞지 않는 것이다. 허용 플래그를 쓰지 않는다. DRAIN을 유지한 채 `routes` 표의 non-serving 행 원인을 고친다. 잡은 멈춘 상태로 둔다.

### 19. job-resume (순서대로)
- 위치: `/admin/status` → 「이 작업 재개」
- 명령·조건: 관문 문서 6절 「resume 순서와 정상 복귀 조건」을 따른다. `product-search-profile` → `crawl-tagline` → `product-tagline-ko` → `product-translate` → 조건부 3개 순서로, 한 번에 하나씩 재개하고 2분에 1차 확인, 5분에 판정한다. M1을 쓰는 잡은 17단계가 확인된 뒤에만 재개한다.
- 실패 시: 10분 안에도 완료가 0이면 다음 재개를 멈추고 R1·S2~S6을 기록한다.

### 20. 운영 판 확인
- 위치: gpu3090(`TARGET`이 있는 checkout)
- 명령: `bash scripts/ops/verify-prod-revision.sh "$TARGET"`
- 성공: exit 0이고 두 웹 인스턴스 모두 `TARGET`이다.
- 이어서: 배포 관측(5·10·15분·6시간) 영수증과 해제 뒤 30분 동안 모델별 성공·새 미확인 0건을 **실제 영수증으로만** 기록한다. 멈췄던 단계의 관측 통과는 재개 뒤 시각부터 따로 센다.

## 5. 실패 경로 (어디서 멈추든 지킬 것)

- **7단계 이전**에 멈추면 운영(capacity·서비스)은 바뀌지 않았다. 다만 4단계에서 접수한 job은 `queued`이다. `opsHoldsBoundary`가 참이므로 **다른 ops-runner job 접수를 막는다**. 취소 경로는 없다. prepare가 `blocked`/`manual`로 끝난 job만 막지 않는다. 그러므로 4단계 접수는 3단계가 모두 끝나고 4~11단계를 한 창에서 이어 갈 수 있을 때만 한다.
- **7~11단계 사이**에는 runner가 DRAIN과 물리 경계를 쥐고 있다. 같은 `$JOB`으로 `run`을 이어가는 것만 허용한다. 수동 OPEN, 다른 job 접수, 배포는 하지 않는다(`ops_runner_unfinished_operation`이 막는다).
- **11단계 뒤 M1이 막히면**(12단계 실패): 배포는 관문 때문에 할 수 없다. 운영을 되살리는 정식 방법은 OPEN 하나뿐이다. 유지보수 컨테이너에서 실행서 D10 형식으로 `open $EPOCH1 $REV1 …` dry-run을 먼저 실행한다. 2단계 (b)에서 non-serving route가 있었다면 199a3ebb에서는 이 OPEN이 거절될 수 있다. 그때는 허용 플래그를 쓰지 말고 DRAIN을 유지한 채 대표가 판단한다. M1 미확인은 그대로 남고, M1 relay는 재시작하지 않는다(경로 보존).
- 어떤 단계에서도 시간 경과로 해제하지 않는다. `model_capacity_*`나 `jobs`를 SQL로 바꾸지 않는다. 관문 면제·`--allow-deferred-routes`를 쓰지 않는다. 실패한 once 디렉터리(배포 execution, M1 RUN, manifest out-dir)는 다시 쓰지 않는다.

## 6. 이 문서의 검증

- 로컬 시험(Node v22.22.1, 운영 접근 없음). 바꾼 영역 묶음은 다음과 같다: `release-29877f65`, `release-65f8c399-manifest`, `worker-progress-job-pause`, `worker-progress`, `worker-progress-capacity-drain`, `ops-runner-*` 9개, `admin-models-ops-*` 3개(ui 포함), `release-order-capacity-control`. 결과는 Vitest **17파일/145시험 PASS**이고, 변경 전(병합 커밋 51136a32, 같은 묶음에서 새 파일 제외)은 14파일/130시험이었다. Python `test_release_65f8c399_manifest` 3→**4건 PASS**. `next typegen` 뒤 `tsc --noEmit` exit 0, 변경 파일 ESLint 0.
- 화면: 관리 화면 작업 카드(인계 완료/일반 완료)를 앱 CSS로 정적 렌더해 확인했다(`ops-runner-handoff-card.png`). 운영 DB와 관리자 로그인이 필요한 `/admin/models` 실제 화면은 띄우지 않았다.
- 실제 운영에서는 아무것도 실행하지 않았다. 따라서 운영 수치(미확인 수, route 상태, revision)는 이번에 측정하지 않았다. 표의 `EPOCH*`·`REV*`는 대표가 실행하면서 적는 값이다.
