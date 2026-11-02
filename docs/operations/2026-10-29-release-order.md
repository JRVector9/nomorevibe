**결론: 순환 의존은 코드상 실제였다. 해소는 두 가지 정식 도구로 했다. ① 운영 웹(199a3ebb)에 버튼이 없어도 Supa job을 웹과 같은 함수·감사·직렬화로 접수하는 운영자 셸 CLI(`scripts/ops/admin-models-ops-submit.ts`). ② runner가 마지막에 OPEN하지 않고 **자기가 건 DRAIN을 그대로 인계**하는 검토된 profile 선택(`finalAdmission:"draining"`, 마지막 단계 `handoff`). 이 둘로 순서는 한 줄이 된다. 0143(+0144) → OPEN 상태에서 Supa runner가 DRAIN을 건다 → Supa 해제 → 그 DRAIN을 인계받아 M1 해제 → 미확인 0 → 배포 → M1 relay 재설치 → OPEN → job-resume → AI2 정합 → 텍스트 적체 확인. 배포 전에는 OPEN을 한 번도 하지 않는다. 관문 면제·시간 경과 해제·DB 직접 UPDATE는 쓰지 않았다.**

> **2026-10-29 3판(PR #735 병합 `f4fe5958` 기준)**: 도구 소스 `REL`을 `f4fe5958…`로 옮기고 표 3을 다시 계산했다. 배포 `TARGET`은 고정값이 아니라 **plan·run 시점의 main 머리**다(3절 「배포 TARGET」). 그 사이 main에 들어온 PR #732(M1 relay 허용 모델 등록부화)·#734(AI2 정체 정합 도구)·#735(번역·후처리 적체 수정)의 배포 뒤 단계를 17단계와 새 21·22단계에 넣고, 14·19단계 잡 목록을 다시 확인했다. 1~20단계 번호는 바꾸지 않았다.

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

1. **운영자 셸 job 접수** `scripts/ops/admin-models-ops-submit.ts` — `request-release`만 받는다. 기본은 READ ONLY 미리 보기다(`previewModelOpsCommand`: writer fence, 같은 ID 충돌, 미완료 job, 대상 `indeterminate` 여부와 group·owner). `--execute`는 웹과 **같은** `submitModelOpsCommand`를 부르므로 advisory lock 7219401, writer fence, 미완료 job 직렬화, indeterminate 재확인, append-only 감사 행이 모두 그대로다. 웹 로그인으로 인증된 것이 아니므로 감사 행의 `actor_kind`는 `pipeline-control` CLI처럼 비운다(NULL). 응답이 불명확하면 같은 `--id`로 다시 실행한다. 기존 job을 돌려받을 뿐 새로 만들지 않는다. 미리 보기는 잠그지 않는 fence 읽기(`readWriterFence`)를 쓴다. 이전 판은 READ ONLY 트랜잭션 안에서 `FOR SHARE`로 fence를 잠가 PostgreSQL이 `25006`으로 거절했다. 그래서 미리 보기와 `--execute`(미리 보기를 먼저 부른다)가 모두 exit 1 `ops_submit_unconfirmed_readback_required`로 끝났다. 2026-10-29 실제 DB 통합 시험(`tests/integration/ops-runner-drain-handoff.test.ts`)으로 찾아 고쳤다. 실제 접수(`submitModelOpsCommand`)는 그대로 잠금 아래 다시 확인한다.
2. **DRAIN 인계** — operator profile에 `finalAdmission:"draining"`을 넣으면 마지막 단계가 `open` 대신 `handoff`가 된다. handoff는 capacity를 바꾸지 않는다. 같은 트랜잭션에서 다음을 확인하고 기록한다. (a) writer fence, (b) 이 job이 직접 커밋한 `ops-runner-control <id>:draining` 감사의 핀이 runner가 저장한 drained 핀과 같다(자기 DRAIN만 인계), (c) `model_capacity_control` 행을 `FOR UPDATE`로 잠근 현재 핀이 그 핀과 정확히 같고 `draining`이다. 그다음 `ops-runner-control <id>:handoff` 감사 행을 한 번만 쓴다. 다른 사람이 그사이 control을 바꿨으면 `handoff_drain_changed`, 자기 DRAIN이 아니면 `handoff_drain_not_owned`로 멈춘다. profile은 prepare 때 hash로 고정되므로 시작한 뒤에는 바꿀 수 없다(`ops_runner_profile_changed`). 접수(admission) job에는 쓸 수 없다. `build-manifest.py --final-admission=draining`이 이 값을 profile에 넣는다. 관리 화면 카드는 마지막 단계를 「DRAIN 유지·다음 절차 인계」로 보여 주고, 「이 작업은 끝나도 접수를 DRAIN으로 둡니다」라는 안내를 단다.
3. **route 확인·OPEN 실행기** `scripts/ops/release-order/capacity-control.sh` — **운영 이미지에는 `scripts/ops`가 없다.** `.dockerignore` 7행 `scripts/ops`가 빌드 문맥에서 빼기 때문이다(199a3ebb·main 같음). 대표 실측으로 m3ultra 유지보수 컨테이너에서 `/app` 기준 실행이 `ERR_MODULE_NOT_FOUND '/app/scripts/ops/pipeline-control.ts'`로 실패했고 `/app/scripts/ops` 폴더가 없었다. 그래서 이 실행기도 실행서 `in-container.sh`처럼 **`/tmp` 스테이징한 검토 소스에서만** 실행한다. `stage <tar sha256>`는 `/tmp/nmv-release-order/src.tar`(C5와 같은 `git archive` tar)의 sha256과, tar 안 `package-lock.json`이 이미지 `/app/package-lock.json`과 같은지를 **쓰기 전에** 확인한다. 그다음 한 번만 `/tmp/nmv-release-order/src`에 풀고 `node_modules`는 이미지 `/app/node_modules` 심링크로 둔다. 하나라도 어긋나면 아무것도 쓰지 않고 멈춘다(`source_tar_sha_mismatch`·`package_lock_differs_from_image`·`source_tar_unusable`·`image_app_missing`). 같은 tar로 다시 치면 `existing:true`로 그대로 둔다. `status`·`routes`·`open`(기본 dry-run)은 스테이징이 없으면 `source_not_staged`로 거절한다. 실행할 때마다 lock과 심링크를 다시 확인한다. `--allow-deferred-routes`는 받지 않는다. `.dockerignore`를 바꿔 이미지에 넣는 안은 쓰지 않았다. 이미 떠 있는 컨테이너(2단계의 199a3ebb)에는 효과가 없기 때문이다. 배포 뒤 OPEN(18단계)은 새 컨테이너에 C5를 다시 스테이징한 뒤 `in-container.sh open`으로 한다.

M1 쪽 코드는 바꾸지 않았다. M1 plan은 `capacity_draining`만 검사하므로(`assemble.ts`) 인계받은 DRAIN에서 그대로 plan을 만들 수 있다.

## 3. 공통 값

| 이름 | 값 |
| --- | --- |
| 도구 소스 | **`REL=f4fe5958290713d95e2ce618126fbbf651cd3d95`** = PR #735 병합 main SHA. 스테이징 tar·runner 트리·M1 스크립트는 모두 이 커밋에서 만든다. `SRC=/home/ubuntu/projects/nomorevibe`(또는 같은 저장소의 아무 checkout. `git -C "$SRC" fetch origin main` 뒤 `git -C "$SRC" merge-base --is-ancestor "$REL" origin/main`이 성공해야 한다). 실행서 A절의 `SHA`와 B절의 `T` 모두 이 `REL`을 쓴다. `$SRC`는 `git -C "$SRC" show/archive`로만 쓴다(작업 트리 파일을 직접 실행하지 않는다). Node 실행은 모두 `node_modules`를 연결한 `$T`에서 한다. 이전 판의 `REL=1f52c9ef…`와 비교하면 표 3과 사전 점검 묶음 0절의 파일 17개 해시와 `drizzle`·`package-lock.json`은 같다. `git diff 1f52c9ef f4fe5958 -- drizzle package-lock.json package.json scripts/ops lib/operations` 결과도 비어 있다. 바뀐 값은 커밋 머리가 들어가는 스테이징 tar 해시뿐이다 |
| 배포 TARGET | **plan·run 시점의 main 머리**이고 고정값이 아니다. 배포 도구가 `gh api repos/JRVector9/nomorevibe/commits/main`이 `--sha`와 다르면 `main_sha_mismatch`로 멈추기 때문이다(`scripts/ops/deploy_shared_images.py` `main_sha_and_token`, readiness `target_not_main`). 또 그 커밋의 main CI가 `release-image-{worker,web}-<TARGET>` artifact를 남겼어야 한다. **문서만 바뀐 main 커밋에는 이미지가 없다**(CI `code_changed=false`). PR #731 `49cd9330`·PR #733 `be5d1d53`의 main CI artifact는 실제로 0개였다. 그래서 이전 판의 고정 `TARGET=1f52c9ef`는 PR #731이 병합된 순간 main 머리가 아니게 되어 plan에서 거절될 값이었다. 이 판을 병합한 커밋은 시험 파일을 포함하므로 이미지가 만들어진다. 그 뒤 main이 더 움직이지 않으면 이 커밋이 `TARGET`이다. 아래 확인은 사전 점검 묶음 1절(0143 전)과 15단계 plan 직전에 한 번씩 한다 |
| runner 실행 트리 | `T=/home/ubuntu/ops/nmv-runner-$REL`(실행서 S1의 `git archive 75b8aa31` 대신 `git -C "$SRC" archive "$REL"`). runner와 접수 CLI가 이 커밋 코드여야 handoff를 쓸 수 있다 |
| M1 relay 설치본 | **`RELAY_SHA=279e596ee267e39b311d329ef828f4d9fe9946e7`** = PR #732 병합 main([등록부 연결 안내](2026-10-29-m1-relay-registry-rollout.md) 1절). relay가 읽는 파일(`scripts/local-model-relay/`, `lib/llm/model-registry.ts`·`deadline-policy.ts`·`local-model-serving-contract.ts`, `scripts/ops/local-model-relay.sh`, `package*.json`)은 `279e596e`와 `REL` 사이에 차이가 없다(`git diff --stat 279e596e f4fe5958 -- scripts/local-model-relay scripts/ops/local-model-relay.sh lib/llm package.json package-lock.json`에는 relay가 import하지 않는 `lib/llm/capacity-busy-targets.ts` 1개만 나온다). 17단계에서만 쓴다 |
| 요청 | M1 `29877f65-9f95-4efb-88f9-aea5f39a28b2`, Supa `65f8c399-ff4b-47bc-8f4d-6e4a682cf6a7` |
| 유지보수 컨테이너 | m3ultra Swarm `app-navigate-neural-system-yf43c7`. `DK='env PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin docker'` |
| 직접 primary | `100.99.209.55:5432/nomorevibe`(PgBouncer 아님) |

배포 TARGET 확인([gpu3090], 쓰기 0). 사전 점검 묶음 1절의 셸(`SRC`·`REL`)에서 친다.
```sh
TARGET=$(gh api repos/JRVector9/nomorevibe/commits/main --jq .sha); echo "$TARGET"
git -C "$SRC" fetch origin main && test "$(git -C "$SRC" rev-parse origin/main)" = "$TARGET" && echo target_is_main
git -C "$SRC" merge-base --is-ancestor "$REL" "$TARGET" && git -C "$SRC" diff --quiet "$REL" "$TARGET" -- lib scripts drizzle messages tsconfig.json package.json package-lock.json && echo target_same_staged_tree
gh run list --workflow ci.yml --branch main --event push --commit "$TARGET" -L 1 --json databaseId,conclusion -q '.[0]|"\(.databaseId) \(.conclusion)"'
```
- 성공: `target_is_main`과 `target_same_staged_tree`가 나온다. 마지막 줄의 conclusion이 `success`다(아직 진행 중이면 plan 전에 기다린다). 이 경우 `REL`로 만든 스테이징 tar의 코드·`package-lock.json`이 `TARGET` 이미지와 같다. 그래서 2(b)의 route 판정과 18단계 OPEN이 새 이미지와 같은 코드로 판정한다.
- `target_same_staged_tree`가 안 나오면 `REL` 뒤에 `lib`·`scripts`·`drizzle` 등 스테이징 경로를 바꾼 커밋이 main에 들어온 것이다. **시작(또는 배포)하지 않는다.** 그대로 진행하면 스테이징 소스(`REL`)와 새 이미지(`TARGET`)의 코드가 달라 route·OPEN 판정이 이미지와 어긋날 수 있다. 새 main 기준으로 표 3·묶음 0절·`TAR_SHA`를 다시 계산한 판을 받는다(시험 `tests/release-order-hashes.test.ts`가 표와 코드의 어긋남을 잡는다). 문서만 바뀐 커밋이 머리면 `target_same_staged_tree`는 나와도 이미지가 없어 plan이 readiness 미준비로 멈춘다. 그때도 배포 요청은 하지 않는다.

검토할 SHA-256(`git show $REL:<파일> | sha256sum`, `REL=f4fe5958290713d95e2ce618126fbbf651cd3d95`에서 gpu3090 git 2.53.0으로 다시 계산했다). M1 수집 스크립트 등 0143 전 사전 점검에만 쓰는 나머지 파일과 명령은 **[사전 점검 묶음](2026-10-29-pre-0143-check-bundle.md)** 0절에 있다. 두 표의 같은 파일은 같은 값이고, 시험이 이를 대조한다.

| 파일 | SHA-256 |
| --- | --- |
| 스테이징 tar `TAR_SHA`(`git archive --format=tar "$REL" lib scripts drizzle messages tsconfig.json package.json package-lock.json \| sha256sum`. 같은 명령으로 `1f52c9ef`의 `75f388d4…`와 `279e596e`의 `9ab8a624…`도 재현했다. git 버전이 다르면 tar 바이트가 다를 수 있으니, 판정은 대표가 직접 계산한 값과 컨테이너가 받은 파일의 sha256이 같은지로 한다) | `cdff13dda155a0eeaab4a9a57a0a95a38199ce509e71510997de61cb9822399c` |
| `package-lock.json`(`LOCK_SHA`, 1f52c9ef·279e596e·199a3ebb와 같음 → C5·18단계 `same_as_image` 전제 유지) | `f609ff6e3159975cce362809a50bc335afb2a812502fb74d70c8ab3a203296d5` |
| `scripts/ops/admin-models-ops-submit.ts` (신규) | `b9f2bb1a8c56cc4eecb86c8ec206a3f38f76830c9d00711b3c9ffc9174ba94ea` |
| `scripts/ops/release-order/capacity-control.sh` (신규, `/tmp` 스테이징판. 옛 `3ae03fe3…`판은 `/app/scripts/ops`를 전제해 운영 이미지에서 실패한다) | `92d59f78927f5fbb983eb309ea4d9aa3c2a3e6f5c44eeade29f08cc5685f4c5a` |
| `scripts/ops/release-65f8c399/build-manifest.py` (변경) | `1d974717b4b6b45ffa1e6119f05edfca003cb217dcb92feafbf26e692c2285c7` |
| `lib/operations/ops-runner/operator.ts` (변경, da3bd4a3 신뢰 루트 인자 포함. 7b7a2d23판은 `0747b9dd…`) | `600eab9327eed9db4968973165e322b58517ba7ac903fdf6b414c3b971ec1270` |
| `lib/operations/ops-runner/control.ts` (변경) | `e152b09a1594f2298e7f2a2fc76b0e0a3fff3d0a89f9bf7e443f747509f22c92` |
| `lib/operations/ops-runner/repository.ts` (변경, 미리 보기 fence 읽기 수정. 이전 `cbb68daf…`판은 미리 보기·`--execute`가 항상 exit 1) | `b09639e60505a516ac14970b76a1fa58ccfacb8034e76afb9664c162e17d5142` |
| `lib/operations/ops-runner/runner.ts` (변경) | `1ca48790e752655243b06c8035947066b498fd84ae8aa0defddbb15c7c99820d` |
| `lib/operations/ops-runner/contract.ts` (변경) | `0fb66a9c36fc65a544d892af2ce67000c9357f89a31659311b98e3b6e1aebfb3` |
| `scripts/ops/admin-models-ops-runner.ts` (main 그대로) | `78df32f4cbaeef344dc4a09a784cb6523306f04fc54b15cb27f666531e271034` |
| `scripts/ops/admin-models-boundary-adapter.py` (main 그대로) | `f51d5ef76232bf74e652a27627aabed97236029ae1c17742a55df55311707f61` |
| `scripts/local-model-relay/config.ts` (17단계 relay 설치본, `RELAY_SHA`와 같음) | `9c8fdbf814417332096b1d294a00232e7c025b6ad62f661ed1c07f9ea9bff8d5` |
| `scripts/local-model-relay/server.ts` (17단계 relay 설치본) | `210456e7f9c10f43a76512c1e9308f760447828aa792df0943c5cee86d458404` |
| `scripts/local-model-relay/service.ts` (17단계 relay 설치본) | `cf79a0ff5b3d6455bfe41aeb9add7b036f75a925524956e27809d76b65385b3a` |
| `lib/llm/model-registry.ts` (17단계 relay 설치본) | `c2cef4a646f906ada5f9443d1a7da70c76f8693870431471bf8de8d74ec7def8` |
| `scripts/ops/local-model-relay.sh` (17단계 relay 설치본의 `status`) | `3b6415c84aa84f734157075f8346058fafa3e33421e08d7a89ffe1947828f102` |
| `scripts/reconcile-ai2-stale.ts` (21단계, 새 이미지 `/app/scripts`에 있다. `scripts/ops` 밖이라 `.dockerignore`에 빠지지 않는다) | `d764a74054a0ce65ebe4b291a63ab4feec18056df06e87f4aa2d1268594a15d3` |
| `scripts/check-worker-progress.ts` (R1, 14·19·22단계, 이미지 `/app/scripts`) | `fb1a199b7711281613dcb2a9be6d66f6077878331d0e335fd55d32dc0dd58577` |

## 4. 실행 순서

**전체 전제(하나라도 아니면 시작하지 않는다)**: 다른 차선(49b91700 등)의 작업이나 배포가 진행 중이 아니다. ops-runner 미완료 job이 없다. M1 relay를 재시작하지 않았다(06:33Z 이후 M3 reviewer도 재배포되지 않았다). capacity가 `open`이다.

### 1. [승인] 0143(+0144) 적용과 적용 확인
- 위치: 적용은 대표의 정식 migration 절차로 한다(이 문서 범위 밖). 확인은 m3ultra 유지보수 컨테이너에서 한다(실행서 C5에서 올린 소스 사용).
- 전제: 실행서 C1~C7과 2단계 (a)~(e)를 0143 **전에** [사전 점검 묶음](2026-10-29-pre-0143-check-bundle.md)으로 한 번 통과했다(`blockedNow: []`). 막히는 근거가 있으면 0143을 적용해도 M1은 풀 수 없다. 그때는 이 순서 전체를 멈추고 다시 판단한다.
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
- 명령: (a) `xa-ssh m3ultra "$DK exec -i $CID sh -s -- status" < "$W/in-container.sh"`를 실행해 capacity `open`, `EPOCH0`·`REV0`를 적는다(`$W`·`$CID`·`/tmp` 스테이징은 실행서 C1·C5의 것이다. 그사이 컨테이너가 바뀌어 CID가 다르면 C5부터 다시 한다). (b) route 판정. 이미지에는 `scripts/ops`가 없으므로 C5의 같은 `$W/src.tar`(`$TAR_SHA`)를 `capacity-control.sh`용 `/tmp/nmv-release-order`에 한 번 더 스테이징한 뒤 `routes`를 실행한다(아래 블록). 출력의 `[capacity routes]` 표에서 마지막 열(status)이 `serving`·`unused`가 아닌 행 수를 적는다(`NONSERVING0`). 이 수는 같은 스테이징 소스와 이 컨테이너 env로 OPEN dry-run을 하면 나올 `deferred_routes:N`과 같은 판정이다(`statusRouteContracts`와 OPEN의 `routesFor`가 같은 `modelRouteContracts`·`usedModelRoutes`를 쓴다). (c) 관문 문서 S0을 실행해 `job_batch_mode`를 확인한다. (d) S3을 실행해 미확인이 정확히 2건(29877f65·65f8c399)이고 다른 활성이 0인지 확인한다. (e) 관문 문서 R1을 실행해 경보 단계를 표로 남긴다(관문 문서 6절 1번).
```sh
git -C "$SRC" show "$REL:scripts/ops/release-order/capacity-control.sh" > "$W/capacity-control.sh"; sha256sum "$W/capacity-control.sh"   # 표 3과 같아야 한다
xa-ssh m3ultra "$DK exec -i $CID sh -c 'umask 077 && mkdir -p /tmp/nmv-release-order && cat > /tmp/nmv-release-order/src.tar && sha256sum /tmp/nmv-release-order/src.tar'" < "$W/src.tar"
xa-ssh m3ultra "$DK exec -i $CID sh -s -- stage $TAR_SHA" < "$W/capacity-control.sh"     # {"staged":…,"lock":"same_as_image"}
xa-ssh m3ultra "$DK exec -i $CID sh -s -- routes" < "$W/capacity-control.sh" | tee "$W/pre/routes.txt"
awk '/^\[capacity routes\]/{t=1;next} t&&NF&&$1!="route"{n++;if($NF!="serving"&&$NF!="unused"){d++;print "non-serving:",$0}} END{print "routes",n+0,"non_serving",d+0}' "$W/pre/routes.txt"
```
- (b)의 판단: 원격 sha256이 `$TAR_SHA`와 같고 stage가 `lock:"same_as_image"`를 내야 한다. `package_lock_differs_from_image`·`source_tar_sha_mismatch`이면 아무것도 쓰이지 않은 것이다. 멈추고 tar와 이미지를 확인한다. 옛 `capacity-control.sh`(`3ae03fe3…`)나 `/app`에서 직접 `node … scripts/ops/pipeline-control.ts`를 치면 `ERR_MODULE_NOT_FOUND`가 난다. 그 결과를 route 판정으로 읽지 않는다.
- (e)의 판단: 관문 문서 3절에서 pause 대상(「예」·조건부)이거나 first·second(DRAIN의 held로 처리)인 경보는 시작을 막지 않는다. 생존·lane·scheduler, fetch·judge·publish·evidence 등 「아니오」인 경보가 있으면 시작하지 않는다. 그 상태로 진행하면 해제 뒤 14단계에서 배포가 막혀 DRAIN만 남는다.
- 성공: (c)가 `legacy`다(아니면 14단계의 job-pause를 쓸 수 없다. 관문 문서 2절 ①을 따른다). (d)의 미확인이 그 2건뿐이다. (e)에 「아니오」인 경보가 없다.
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
- 실패 시: exit 3이면 stdout의 `blocked`(`ops_runner_unfinished_operation`, `ops_runner_request_not_indeterminate`, `ops_runner_id_conflict`, `dr_writer_site_fenced`)가 이유이고 아무것도 쓰지 않은 것이다. 원인을 본다. `--execute` 도중 같은 이유로 거절되면 exit 1과 stderr `{"code":"<위 코드 중 하나>"}`가 나온다. 이것도 쓰지 않은 것이다. exit 1 `ops_submit_unconfirmed_readback_required`이면 같은 `--id`로 미리 보기를 다시 실행한다. `existing`이 나오면 접수된 것이다. 새 ID로 다시 접수하지 않는다.

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
- 성공: exit 1, `status:"manual"`, `step:"stop"`, `code:"supa_root_result_required"`. 이때부터 **모든 모델 호출이 미뤄진다**. 유지보수 컨테이너 `status`(2단계 (a)와 같은 명령)로 capacity가 `draining`인지 보고 epoch·revision을 `EPOCH1`·`REV1`로 적는다. 모드 전환(`setModelCapacityMode`)은 `mode`와 `updated_at`만 바꾸므로 정상이면 `EPOCH1 = EPOCH0`, `REV1 = REV0`이다(revision은 policy 변경 때만 오른다). 값이 다르면 그사이 다른 정책 변경이 끼어든 것이다. 멈추고 감사를 본다.
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
- **PR #732·#734·#735 영향 재확인(3판)**: 멈춤 후보 목록은 바뀌지 않는다. 새 잡은 없고, `second-review`는 계속 pause 대상이 아니다. 바뀐 것은 아래 재개 조건과 배포 뒤 확인이다. 잡 이름은 `/admin/status` 작업 표 이름과 같다.

| 잡(R1 단계) | 들어온 변경 | 14단계 멈춤 | 19단계 재개 때 더 볼 것 |
| --- | --- | --- | --- |
| `product-translate`(product-translate) | #732: 옛 `[m1] qwen3.8-flash-next` 설정을 등록부 `m1:translation` Gemma로 해석한다 | 경보면 멈춤(기존) | **17단계 `check`·health `matched` 확인 뒤에만** 재개(M1 사용). 재개 뒤 [등록부 연결 안내](2026-10-29-m1-relay-registry-rollout.md) 5절 P2·P3로 번역 저장 증가를 본다 |
| `reason-translate`(reason-translate) | #735: 장부에 묶인 사유를 두 대기열에서 건너뛴다. #732: 기본 모델이 같은 `m1:translation`이다(`ABCLLM_MODEL` 재정의가 없을 때) | 경보일 때만(기존) | 17단계 뒤에만 재개(M1 사용). 22단계 T5 |
| `product-tagline-ko`(tagline-ko) | #735: 출력 정리 뒤 다시 검사하고, 품질 외 실패가 10회면 `failure_limit`로 끝낸다 | 경보면 멈춤(기존) | 재개 직후 수동(blocked) 수가 `failure_limit` 수만큼 늘 수 있다. 의도된 변화이고 22단계 T3로 나눠 본다. 22단계 T2·T4 |
| `product-search-profile`(keywords) | #735: 묶인 제품을 건너뛰고, 같은 그룹에 다른 route 대기가 있으면 일꾼 하나만 쓴다 | 경보면 멈춤(기존) | `search_profile.fair_share` 로그가 계속 찍히면 처리량이 일꾼 하나로 준 것이다(결함 아님). 22단계 T7·T8·T9 |
| `crawl-tagline`·`product-search-verify`·`product-intro-check` | 없음 | 기존과 같음 | 기존과 같음 |
| `second-review`(second) | #734: 매분 정체 표를 정리하고 다시 넣는다 | **하지 않는다**(관문 문서 3절 「아니오」, DRAIN의 held) | 배포 뒤 다시 넣은 표가 대기열 끝에 붙는다. 그래서 R1 `second`의 대기 수가 잠시 늘 수 있다. 경보면 21단계 A2·A5로 정리 때문인지 먼저 가른다 |

### 15. 배포 plan
- 위치: gpu3090(배포 대상 main SHA를 checkout한 깨끗한 트리, `deployment-fast-path.md`)
- 전제: 3절 「배포 TARGET 확인」 블록을 **지금** 다시 쳐서 `TARGET`을 정하고 `target_is_main`·`target_same_staged_tree`·CI `success`를 본다(사전 점검 때의 값을 그대로 쓰지 않는다. 그 사이 main이 움직였을 수 있다). 그 main `check`와 이미지 publish가 끝났는지 `deployment-fast-path.md`대로 확인한다. 0143·0144를 포함하므로 `--migration-verified`가 필요하다. `target_same_staged_tree`이므로 18단계 재스테이징 tar(`REL`)의 `package-lock.json`은 새 이미지의 것과 같다. 상품 번역 env `PRODUCT_TRANSLATION_MODEL_KEY=m1:translation`을 넣을 거라면 이 배포 전에 Dokploy env에 넣어 같은 배포로 반영한다([등록부 연결 안내](2026-10-29-m1-relay-registry-rollout.md) 3절). 선택 사항이다. `TARGET`에는 #732가 들어 있어 KEY가 없어도 옛 Qwen 설정을 Gemma로 해석한다.
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
- 전제: 12단계 M1 해제가 끝났다(그 전에는 절대 하지 않는다. 재시작하면 `m1_current_relay_is_recovered_process`로 해제 경로가 영구히 막힌다). 16단계 배포가 `deployed-and-verified`로 끝났다. capacity가 아직 `draining`이다(M1 요청이 들어오지 않는다).
- 설치본(PR #732): `<REVIEWED_SHA>` = **`RELAY_SHA=279e596ee267e39b311d329ef828f4d9fe9946e7`**(3절). Dokploy `TARGET`과 같을 필요는 없다. relay는 M1에 따로 설치하고, relay가 읽는 파일은 `279e596e`와 `REL` 사이에 같다. 경로는 준비 `/var/tmp/nmv-relay-reviewed/279e596ee267e39b311d329ef828f4d9fe9946e7` → 설치 `/usr/local/nmv-llm-relay/releases/279e596ee267e39b311d329ef828f4d9fe9946e7`이다. 대표가 준비 경로에 그 SHA의 완전한 설치본(의존성 포함)을 둔다. 준비할 때 `find /var/tmp/nmv-relay-reviewed/279e596ee267e39b311d329ef828f4d9fe9946e7 -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256`을 기록하고, ditto 직전에 같은 값인지 다시 확인한다. 준비본의 relay 파일 5개를 `shasum -a 256`으로 표 3과 대조한다.
- 순서([m1 device_admin], 각 줄 55초 alarm, 응답이 불명확하면 같은 줄을 다시 치지 않고 다음 읽기 줄로 확인한다):
  1. **전 읽기(쓰기 0)**: [등록부 연결 안내](2026-10-29-m1-relay-registry-rollout.md) 1절 「재설치 전 읽기」 argv. 기대값은 `MODEL_REGISTRY_CONFIG unset`, `LOCAL_MODEL_RELAY_EQUIPMENT None`이다. `set`이면 그 JSON의 M1 entry에 `relay` 용도가 있는지 먼저 본다(없으면 새 relay가 `relay_model_not_registered`로 시작하지 않는다. 안내 2절). 이어서 아래 두 줄로 되돌릴 곳을 적고 `config.env`를 백업한다(목적지는 처음 쓰는 경로).
```jsonl
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/usr/bin/readlink","/usr/local/nmv-llm-relay/current"]}
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/bin/cp","-p","/usr/local/nmv-llm-relay/config.env","/usr/local/nmv-llm-relay/config-before-model-fix.env"]}
```
  2. **설치**: [M1 relay 인계](2026-10-29-m1-relay-model-handoff.md) 「대표용 M1 argv」 jsonl을 `<REVIEWED_SHA>`만 `279e596ee267e39b311d329ef828f4d9fe9946e7`로 바꿔 한 줄씩 친다(backup·release 목적지는 처음 쓰는 경로). **`plutil -lint` 줄 다음, `launchctl bootstrap` 줄 앞에서 멈추고** 3을 친다.
  3. **`server.ts check` — 허용 모델 확인(쓰기 0, bootstrap 전)**: 갱신한 plist의 실행 인자·작업 폴더·env 그대로 `check`만 실행한다. 설치기(`scripts/ops/local-model-relay.sh` `write_service`)가 bootstrap 전에 `run_entry check`를 하는 것과 같은 검사다. `TMPDIR`은 relay 계정 폴더에 root 파일을 만들지 않도록 뺀다.
```jsonl
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/usr/bin/python3","-I","-c","import plistlib,subprocess; d=plistlib.load(open('/Library/LaunchDaemons/bot.brut.nmv-llm-relay.plist','rb')); e={k:v for k,v in d['EnvironmentVariables'].items() if k!='TMPDIR'}; r=subprocess.run(d['ProgramArguments']+['check'],cwd=d['WorkingDirectory'],env=e,capture_output=True,text=True,timeout=45); print('check_exit',r.returncode); print(r.stdout.strip()); print(r.stderr.strip()[-400:])"]}
```
     - 성공: `check_exit 0`이고 JSON이 `"event":"local_model_relay.config_valid"`, `"equipment":"m1"`, `"model":"mlx-community--gemma-4-26b-a4b-it-4bit"`, `"allowedModels":["mlx-community--gemma-4-26b-a4b-it-4bit"]`, `"relayRevision":"279e596ee267e39b311d329ef828f4d9fe9946e7"`를 보인다. 그다음 2의 남은 줄(`bootstrap`, 필요할 때만 `kickstart`, launchd readback)을 친다.
     - 실패: stderr가 `{"event":"local_model_relay.refused","code":"invalid_config"}`이면 아래 「되돌리기」로 간다. 원인 후보는 `relay_model_not_allowed`(plist 모델이 M1 relay entry가 아님, 갱신 줄 누락)·`relay_model_not_registered`·`relay_invalid_equipment`·`relay_model_family_mismatch`다. `allowedModels`에 다른 모델이 있거나 `relayRevision`이 다르면 bootstrap하지 않는다.
  4. **후 읽기(쓰기 0)**: 안내 1절 「재설치 후 읽기」 argv(`local-model-relay.sh status`).
- 성공: launchd readback이 `state = running`과 새 pid를 보이고 `last exit code`가 0이다. status JSON이 `"allowedModels":["mlx-community--gemma-4-26b-a4b-it-4bit"]`, `"upstreamModelMatch":true`, **`"upstreamModelReason":"matched"`**, `"relayRevision":"279e596ee267e39b311d329ef828f4d9fe9946e7"`를 보인다. `not_checked`면 상류 목록을 아직 읽지 않은 것이다. 10초 뒤 같은 status를 한 번 더 읽는다(읽기라 다시 쳐도 된다). plist의 `LOCAL_MODEL_RELAY_VERSION`이 `RELAY_SHA`다.
- 실패 시: `upstream_model_mismatch`이면 oMLX가 다른 모델을 서빙 중이다. relay가 전송 전에 거절하므로 미확인은 생기지 않는다. DRAIN을 유지한 채 멈추고 oMLX `/v1/models`를 본다(18단계로 가지 않는다). `upstream_models_unavailable`도 같다. `status_unavailable`이거나 `last exit code`가 0이 아니면 `relay.log`의 거절 코드를 보고 「되돌리기」로 간다.
- **되돌리기**(relay가 없는 상태면 바로 한다. capacity는 DRAIN이라 M1 요청은 없다): 아래 argv로 1에서 적은 이전 release와 백업 plist·config.env로 돌린 뒤 bootstrap한다. `bootout`은 서비스가 올라와 있을 때만 친다. 이전 relay로 돌아가면 M1은 옛 모델 고정 그대로다. 그러면 18단계 `routes`의 `product-translate`가 non-serving으로 남을 수 있다. 그 상태로 OPEN할지는 대표가 정한다(허용 플래그는 쓰지 않는다).
```jsonl
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/bin/launchctl","bootout","system/bot.brut.nmv-llm-relay"]}
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/bin/ln","-sfn","<1에서 읽은 이전 release 경로>","/usr/local/nmv-llm-relay/current"]}
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/bin/cp","-p","/usr/local/nmv-llm-relay/plist-before-model-fix.plist","/Library/LaunchDaemons/bot.brut.nmv-llm-relay.plist"]}
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/bin/cp","-p","/usr/local/nmv-llm-relay/config-before-model-fix.env","/usr/local/nmv-llm-relay/config.env"]}
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/bin/launchctl","bootstrap","system","/Library/LaunchDaemons/bot.brut.nmv-llm-relay.plist"]}
```

### 18. [승인] 접수 OPEN — 새 컨테이너에 C5 재스테이징 + `in-container.sh open`
- 위치: gpu3090 → **배포 뒤 새** m3ultra 유지보수 컨테이너
- 전제: 배포가 유지보수 컨테이너를 교체했으므로 2단계·C5의 `/tmp` 스테이징은 없다. 새 이미지에도 `scripts/ops`는 없다(`.dockerignore` 7행). 그래서 `/app`에서 직접 실행하지 않고, **실행서 C5를 새 컨테이너에 다시 한다**(같은 `$W/src.tar`·`$TAR_SHA`, 표 3의 `REL`). `REL`이 배포 `TARGET`과 같은 main SHA이므로 tar의 `package-lock.json`은 새 이미지의 것과 같다. 다르면 두 stage가 `package_lock_differs_from_image`로 아무것도 쓰지 않고 멈춘다. 그때는 OPEN하지 않고 DRAIN을 유지한 채 `REL`·`TARGET`을 다시 확인한다.
- 17단계 status가 `upstreamModelReason:"matched"`였다(아니면 OPEN하지 않는다). `routes` 표에서 `product-translate`·`reason-translate` 줄의 status가 `serving`이어야 한다(#732. 정책 route 모델이 `[m1] mlx-community--gemma-4-26b-a4b-it-4bit`가 아니면 `unmapped`로 non-serving이 된다. 그때는 [등록부 연결 안내](2026-10-29-m1-relay-registry-rollout.md) 4절 P1로 정책 값을 보고, 정책 갱신은 별도 승인한다).
- OPEN은 실행서 D10과 같은 `in-container.sh open`(정식 `pipeline-control capacity mode --to=open --from-mode=draining` CAS, 기본 dry-run, 허용 플래그 없음)으로 한다. route 표는 `capacity-control.sh routes`로 같은 스테이징 소스·새 컨테이너 env에서 본다.
```sh
NCID=$(xa-ssh m3ultra $DK ps -q --no-trunc --filter label=com.docker.swarm.service.name=app-navigate-neural-system-yf43c7); echo "$NCID"   # 정확히 1줄, 2단계의 $CID와 다르다
xa-ssh m3ultra "$DK exec -i $NCID sh -c 'umask 077 && mkdir -p /tmp/nmv-release-29877f65 && cat > /tmp/nmv-release-29877f65/src.tar && sha256sum /tmp/nmv-release-29877f65/src.tar'" < "$W/src.tar"
xa-ssh m3ultra "$DK exec -i $NCID sh -s -- stage $TAR_SHA" < "$W/in-container.sh"          # C5 재스테이징: {"staged":…,"lock":"same_as_image"}
xa-ssh m3ultra "$DK exec -i $NCID sh -s -- status" < "$W/in-container.sh"                  # draining, EPOCH1·REV1 확인
xa-ssh m3ultra "$DK exec -i $NCID sh -c 'umask 077 && mkdir -p /tmp/nmv-release-order && cat > /tmp/nmv-release-order/src.tar && sha256sum /tmp/nmv-release-order/src.tar'" < "$W/src.tar"
xa-ssh m3ultra "$DK exec -i $NCID sh -s -- stage $TAR_SHA" < "$W/capacity-control.sh"
xa-ssh m3ultra "$DK exec -i $NCID sh -s -- routes" < "$W/capacity-control.sh" | tee "$W/routes-after-deploy.txt"   # 2단계 (b)의 awk로 non_serving 0 확인
xa-ssh m3ultra "$DK exec -i $NCID sh -s -- open $EPOCH1 $REV1 <OP> release-order-20261029-open" < "$W/in-container.sh"
xa-ssh m3ultra "$DK exec -i $NCID sh -s -- open $EPOCH1 $REV1 <OP> release-order-20261029-open --execute" < "$W/in-container.sh"
xa-ssh m3ultra "$DK exec -i $NCID sh -s -- status" < "$W/in-container.sh"                  # open 확인
```
- 성공: 두 원격 sha256이 `$TAR_SHA`와 같고 두 stage가 `lock:"same_as_image"`를 낸다. `routes`의 non-serving이 0이다. dry-run JSON의 `plan.blocked`가 비어 있고, execute가 exit 0과 `executed:true`를 낸다. 마지막 `status`가 `open`이다.
- 실패 시: `ERR_MODULE_NOT_FOUND …/app/scripts/ops/…`가 보이면 스테이징 없이 `/app`에서 실행한 것이다. 쓰기는 일어나지 않았다. 위 순서대로 다시 한다. `deferred_routes:N`이면 모델 이름 고정이나 relay 계약이 아직 맞지 않는 것이다. 허용 플래그를 쓰지 않는다. DRAIN을 유지한 채 `routes` 표의 non-serving 행 원인을 고친다. 잡은 멈춘 상태로 둔다. 18단계에서 멈추면 **DRAIN이 남아 모든 모델 호출이 미뤄진다**. 그러니 17단계가 끝나는 대로 바로 이어서 한다.

### 19. job-resume (순서대로)
- 위치: `/admin/status` → 「이 작업 재개」
- 재개 전(쓰기 0): 22단계의 준비 블록과 **T0·T1**을 먼저 친다. T0이 0행이 아니거나 T1에서 어떤 그룹의 `indeterminate`가 `group_limit`와 같으면, 그 route를 쓰는 잡(`reason-translate`·`product-tagline-ko`·`product-search-profile`)은 재개해도 진척하지 않는다. 그 잡은 멈춘 채로 두고 미확인 회수 차선(`review-stall-backlog.md`)으로 넘긴다. 나머지 잡만 재개한다.
- 명령·조건: 관문 문서 6절 「resume 순서와 정상 복귀 조건」을 따른다. `product-search-profile` → `crawl-tagline` → `product-tagline-ko` → `product-translate` → 조건부 3개 순서로, 한 번에 하나씩 재개하고 2분에 1차 확인, 5분에 판정한다. M1을 쓰는 `product-translate`·`reason-translate`는 17단계 `check`와 health `matched`가 확인된 뒤에만 재개한다. 잡마다 재개 시각(UTC)을 적는다(22단계 60분 판정의 기준).
- 14단계 표의 「19단계 재개 때 더 볼 것」을 같이 본다. 특히 `product-tagline-ko`의 수동 수 증가는 `failure_limit` 때문이면 실패가 아니다(22단계 T3).
- 실패 시: 10분 안에도 완료가 0이면 다음 재개를 멈추고 R1·S2~S6을 기록한다. 다시 멈출지는 대표가 정한다(관문 문서 6절). 다시 멈출 때는 같은 「이 작업 멈춤」으로 하고 실패 사실을 사유에 적는다.

### 20. 운영 판 확인
- 위치: gpu3090(`TARGET`이 있는 checkout)
- 명령: `bash scripts/ops/verify-prod-revision.sh "$TARGET"`
- 성공: exit 0이고 두 웹 인스턴스 모두 `TARGET`이다.
- 이어서: 배포 관측(5·10·15분·6시간) 영수증과 해제 뒤 30분 동안 모델별 성공·새 미확인 0건을 **실제 영수증으로만** 기록한다. 멈췄던 단계의 관측 통과는 재개 뒤 시각부터 따로 센다.

### 21. AI2 정체 정합 — 자동 정리 확인 → dry-run → [승인] apply (PR #734)
- 근거: [AI2 정체 정합 런북](2026-10-27-ai2-stale-reconcile.md) 「2026-10-29 정리 공백 보완과 정합 도구」의 「대표가 칠 명령」(Q1~Q5, 「[배포 뒤에만] 정리 잡의 자동 반영」, 「[배포 뒤에만] 도구 dry-run → apply」). 이 단계는 그 명령을 이 셸의 `xa-ssh`·`$DK` 형식으로 옮긴 것이다. SQL은 런북 원문을 `REL`에서 그대로 뽑아 쓴다.
- 위치: gpu3090 → m3ultra crawler-m3(READ ONLY SQL), reviewer-m3(도구). 도구는 새 이미지의 `/app/scripts/reconcile-ai2-stale.ts`다. `scripts/ops` 밖이라 이미지에 있고 스테이징이 필요 없다.
- 전제: 18단계 OPEN과 20단계가 성공했다(다시 넣은 표는 OPEN이어야 처리된다). `$W/sql/run.mjs`가 있다(사전 점검 묶음 5절 (c). 셸을 새로 열었으면 묶음 1절과 5절 (c)의 `run.mjs` 블록을 다시 친다). 배포가 컨테이너를 바꿨으므로 CID를 새로 읽는다.
```sh
mkdir -p "$W/post"
CCID=$(xa-ssh m3ultra $DK ps -q --no-trunc --filter label=com.docker.swarm.service.name=app-generate-haptic-card-vjqgv4); echo "$CCID"   # crawler-m3, 정확히 1줄
RCID=$(xa-ssh m3ultra $DK ps -q --no-trunc --filter label=com.docker.swarm.service.name=app-copy-primary-hard-drive-b5fhzd); echo "$RCID"  # reviewer-m3, 정확히 1줄
xa-ssh m3ultra "$DK exec $RCID sh -c 'printenv SERVICE_INSTANCE_ID; sha256sum /app/scripts/reconcile-ai2-stale.ts'"   # reviewer-m3, 표 3 값
git -C "$SRC" show "$REL:docs/operations/2026-10-27-ai2-stale-reconcile.md" > "$W/post/ai2-runbook.md"
python3 -I - "$W/post/ai2-runbook.md" "$W/post" <<'PY'
import pathlib, re, sys
doc, out = pathlib.Path(sys.argv[1]).read_text(), pathlib.Path(sys.argv[2])
qs = re.findall(r"^\*\*Q(\d) — .*?^```sql\n(.*?)^```", doc, re.S | re.M)
assert [n for n, _ in qs] == ["1", "2", "3", "4", "5"], [n for n, _ in qs]
for n, body in qs: (out / f"A{n}.sql").write_text(body)
print("ai2_sql", len(qs))
PY
for n in 1 2 3 4 5; do python3 -I -c 'import json,sys;print("const text="+json.dumps(open(sys.argv[1]).read())+";");print(open(sys.argv[2]).read())' "$W/post/A$n.sql" "$W/sql/run.mjs" > "$W/post/A$n.mjs"; done
for n in 1 2 3; do echo "== A$n"; xa-ssh m3ultra "$DK exec -i $CCID node --input-type=module -" < "$W/post/A$n.mjs" | tee "$W/post/A$n-$(date -u +%H%M).json"; done
```
- 순서와 확인 조건:
  1. **배포 5분 뒤, 자동 정리 확인(쓰기 0)**: 위 블록의 A1·A2·A3. 실행기 앱 이름이 런북의 reviewer-m3 대신 crawler-m3인 것은 사전 점검 묶음과 같은 READ ONLY 실행기를 쓰기 위해서다. 같은 DB를 읽는다. 기대: A1에서 후보 357316의 관문 표(138985)가 `resolved/superseded`(다시 넣음) 또는 `not_required`다. A2 `stranded_gate_votes`가 0이거나 줄고 있다. A3은 0행이다. 그대로 남아 있으면 2로 간다.
  2. **dry-run(쓰기·잠금 0)**: `nextAfterCandidateId`가 0이 될 때까지 이어 본다.
```sh
A=0; while :; do xa-ssh m3ultra "$DK exec $RCID node --import tsx scripts/reconcile-ai2-stale.ts --limit 25 --after $A" > "$W/post/ai2-dry-$A.json" || { echo "dry_run_exit=$?"; break; }
  A=$(python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["mode"],d["examined"],d["summary"],file=sys.stderr);print(d["nextAfterCandidateId"])' "$W/post/ai2-dry-$A.json"); [ "$A" = 0 ] && break; done
```
     - 성공: 모든 묶음이 `mode dry-run`이다. `summary`의 `close`·`retire`·`reinsert`·`refresh` 합이 0이면 잡이 이미 정리한 것이다. **apply하지 않고 4로 간다.** 0이 아니면 `entries`의 `close`·`reinsert` 대상과 사유(`reasons`)가 런북 「판별 규칙」과 맞는지 본다. 사람 결정(`decided_by<>'auto'`)이나 갈림 보류(`second_review_split`) 후보가 `close`에 있으면 apply하지 않는다(규칙상 `protected`여야 한다).
     - `dry_run_exit`가 나오면 stderr 메시지를 남기고 멈춘다(읽기만 했으므로 운영 변화는 없다).
  3. **[승인] apply**: dry-run을 검토한 뒤 25개 묶음으로, 같은 커서 순서로 한 번씩 친다. `<OP>`는 대표 이름이다.
```sh
xa-ssh m3ultra "$DK exec $RCID node --import tsx scripts/reconcile-ai2-stale.ts --apply --actor <OP> --limit 25 --after 0" | tee "$W/post/ai2-apply-0.json"; echo "apply_exit=${PIPESTATUS[0]}"
#   다음 묶음은 바로 앞 출력의 nextAfterCandidateId를 --after에 넣는다. 0이면 끝이다
```
     - 성공: exit 0, `mode:"apply"`, `disabled:false`, `changed`가 그 묶음의 dry-run `candidatesWithChanges` 이하다. `skipped`는 `input_too_large`뿐이다. `job.status:"completed"`는 쓰기가 끝났다는 뜻일 뿐이고 모델 결과가 아니다.
     - exit 3이면 잡이 lease를 쥐고 있었던 것이다(stderr `written:false`, 쓰기 0). 1분 뒤 **같은 명령**을 다시 친다. exit 1이면 stderr 한 줄을 남기고 멈춘다. 같은 apply를 반복하지 말고 2의 dry-run으로 지금 상태부터 다시 본다. 실패한 출력은 지우지 않는다.
  4. **확인(쓰기 0)**: 1의 블록에서 마지막 줄의 `1 2 3`을 `1 2 3 4 5`로 바꿔 다시 친다. 성공 기준은 A2=0(용량·item 보호로 dry-run `blocked`에 나온 후보만 남을 수 있다), A3=0행, A4 `carried_demand`가 늘지 않음, A5의 감사 줄 수가 apply `changed` 합과 같음이다. 다시 넣은 표의 실제 모델 결과(`agreed`·`needs_human`)는 이후 `second_reviews.status`로 따로 본다.
- 되돌리기: 이 도구에는 되돌리는 명령이 없다. SQL로 `second_reviews`를 고치지 않는다. 잘못 닫힌 표가 보이면(A1·A5에서 사람 결정·갈림 보류 후보가 닫힘) 다음 apply 묶음을 멈추고 A5의 `closedIds`·`insertedIds`를 기록한다. `second-review` 잡도 1분마다 같은 정리를 한다. 그 잡을 멈출지는 대표가 정한다(14단계와 같은 「이 작업 멈춤」. 멈추면 AI2 표 처리도 멈춘다). R1 `second` 경보가 다시 넣은 표의 대기 증가 때문이면 A2·A5로 확인하고 기다린다.

### 22. 번역·후처리 적체 확인 Q0~Q10 (PR #735, READ ONLY)
- 근거: [텍스트 적체 런북](2026-10-29-text-backlog-runbook.md) 「배포 뒤 확인 — READ ONLY SQL과 기대값」. 런북 SQL은 psql 변수(`\set deploy_at`, `:'deploy_at'`)를 쓴다. 이 셸의 실행기(`run.mjs`, READ ONLY 트랜잭션·5초 제한)에는 psql 변수가 없다. 그래서 아래 블록이 `REL`의 런북 원문에서 Q0~Q9를 뽑아 `:'deploy_at'`을 실제 시각 리터럴로 바꾼 `T0`~`T9`를 만든다. `BEGIN`·`SET`·`ROLLBACK` 줄은 쓰지 않는다(실행기가 READ ONLY 트랜잭션을 연다).
- `deploy_at` 치환: text-m3 새 컨테이너의 시작 시각(docker `StartedAt`, UTC `…Z`)을 그대로 쓴다. mini 예비 text가 먼저 배포되므로 M3 쪽이 더 늦다. 늦은 시각을 쓰면 배포 전 행을 세지 않는다. 시각 형식이 docker `StartedAt`과 다르면 블록이 `deploy_at_must_be_docker_startedat_utc`로 멈춘다. KST나 손으로 적은 값은 넣지 않는다.
- 위치: gpu3090 → m3ultra crawler-m3(READ ONLY SQL, 21단계와 같은 `$CCID`), text-m3(시작 시각만 읽기).
- 시점: **준비 블록과 T0·T1은 19단계 재개 전에** 친다. T2~T9는 각 잡 재개 60분 뒤에 친다(기준은 19단계에서 적은 재개 시각이다. `deploy_at`은 세는 시작점일 뿐이고 그 잡이 멈춰 있던 시간은 진척 기대에서 뺀다). T10(R1)은 재개 5분 판정과 60분 뒤에 친다.
```sh
mkdir -p "$W/post"
TCID=$(xa-ssh m3ultra $DK ps -q --no-trunc --filter label=com.docker.swarm.service.name=nomorevibe-text-m3-ebmybu); echo "$TCID"   # text-m3, 정확히 1줄
xa-ssh m3ultra "$DK exec $TCID printenv SERVICE_INSTANCE_ID"
DEPLOY_AT=$(xa-ssh m3ultra "$DK inspect -f '{{.State.StartedAt}}' $TCID"); echo "$DEPLOY_AT"   # 16단계 배포 시각 뒤여야 한다
git -C "$SRC" show "$REL:docs/operations/2026-10-29-text-backlog-runbook.md" > "$W/post/text-runbook.md"
python3 -I - "$W/post/text-runbook.md" "$W/post" "$DEPLOY_AT" <<'PY'
import pathlib, re, sys
doc, out, at = pathlib.Path(sys.argv[1]).read_text(), pathlib.Path(sys.argv[2]), sys.argv[3].strip()
if not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z", at): sys.exit("deploy_at_must_be_docker_startedat_utc")
qs = re.findall(r"^\*\*Q(\d+)\. .*?^```sql\n(.*?)^```", doc, re.S | re.M)
assert [n for n, _ in qs] == [str(i) for i in range(10)], [n for n, _ in qs]
for n, body in qs:
    body = body.replace(":'deploy_at'", "'%s'::timestamptz" % at)
    assert not re.search(r":'[A-Za-z_]\w*'|\\set", body), n
    (out / f"T{n}.sql").write_text(body)
print("text_sql", len(qs), "deploy_at", at)
PY
for n in 0 1 2 3 4 5 6 7 8 9; do python3 -I -c 'import json,sys;print("const text="+json.dumps(open(sys.argv[1]).read())+";");print(open(sys.argv[2]).read())' "$W/post/T$n.sql" "$W/sql/run.mjs" > "$W/post/T$n.mjs"; done
for n in 0 1 6 8; do echo "== T$n"; xa-ssh m3ultra "$DK exec -i $CCID node --input-type=module -" < "$W/post/T$n.mjs" | tee "$W/post/T$n-$(date -u +%H%M).json"; done   # 재개 전
#   재개 60분 뒤: 같은 for 줄을 "for n in 2 3 4 5 6 7 8 9"로 친다
```
- T10(R1): 사전 점검 묶음 5절 (e)의 R1 명령을 새 `$CCID`로 친다. 세 단계 `tagline-ko`·`reason-translate`·`keywords`를 본다.
- 확인 조건(런북 기대값 그대로):

| 번호 | 무엇 | 통과 | 아니면 |
| --- | --- | --- | --- |
| T0 | route 전체를 막는 옛 형식 미확인 | **0행** | 그 route는 이 수정으로 풀리지 않는다. 그 잡은 재개하지 않고 회수 차선으로 넘긴다 |
| T1 | 물리 그룹 점유 | 그룹마다 `indeterminate < group_limit` | 같으면 미확인이 그룹을 다 쥔 것이다(결함 아님). 회수 차선으로 넘긴다 |
| T2 | tagline-ko 진척·길이 | 재개 60분 뒤 `ok_since_deploy > 0`, `max_len <= 80` | T0·T1·로그 `tagline_ko.capacity_deferred` 사유를 본다 |
| T3 | tagline-ko 종료 사유 | `quality_limit:*`와 `failure_limit:*`가 나뉘어 보인다 | 수동 수 증가가 `failure_limit` 수 이내면 의도된 변화다 |
| T4 | tagline-ko 무한 재시도 | **0** | 0이 아니면 결함 신고(런북 차선). 잡을 다시 멈출지는 대표가 정한다 |
| T5 | reason-translate 진척 | T0·T1이 정상이면 재개 60분 안에 `done_since_deploy > 0` | `translate.capacity_deferred` 사유를 본다 |
| T6 | 세 route 장부 점유(참고) | 미확인이 남아도 T2·T5·T7 진척이 이어진다 | — |
| T7 | search-profile 진척 | 재개 60분 뒤 `generated_since_deploy > 0` | `search_profile.capacity_deferred` 사유를 본다 |
| T8 | 같은 제품 활성 요청 중복 | **0행** | 결함 신고. 잡을 다시 멈출지는 대표가 정한다 |
| T9 | 같은 그룹 예약 배분(60분) | tagline-ko도 대기가 있으면 `reserved_60m > 0` | `search_profile.fair_share` 로그를 본다 |
| T10 | R1 | 진척이 있으면 세 단계가 `progressing`, `alarm:false` | 진척 0이면 `no_progress`·`upstream_stalled`가 그대로다. T0·T1과 `*.capacity_deferred`를 본다 |

- 되돌리기: 이 단계는 읽기만 한다. 되돌릴 쓰기가 없다. 기대와 다르면 19단계 실패 규칙(10분 완료 0 → 다음 재개 중단)과 위 표의 「아니면」을 따른다. `statement_timeout`(5초)에 걸린 질의는 그 번호를 「측정 없음」으로 적는다. 읽기라 나중에 다시 쳐도 된다. 결과 JSON은 `$W/post/`에 남기고 [review-stall-backlog.md](review-stall-backlog.md) 「번역·후처리 3잡 적체 차선」에 실제 값으로만 기록한다.

## 5. 실패 경로 (어디서 멈추든 지킬 것)

- **7단계 이전**에 멈추면 운영(capacity·서비스)은 바뀌지 않았다. 다만 4단계에서 접수한 job은 `queued`이다. `opsHoldsBoundary`가 참이므로 **다른 ops-runner job 접수를 막는다**. 취소 경로는 없다. prepare가 `blocked`/`manual`로 끝난 job만 막지 않는다. 그러므로 4단계 접수는 3단계가 모두 끝나고 4~11단계를 한 창에서 이어 갈 수 있을 때만 한다.
- **7~11단계 사이**에는 runner가 DRAIN과 물리 경계를 쥐고 있다. 같은 `$JOB`으로 `run`을 이어가는 것만 허용한다. 수동 OPEN, 다른 job 접수, 배포는 하지 않는다(`ops_runner_unfinished_operation`이 막는다).
- **11단계 뒤 M1이 막히면**(12단계 실패): 배포는 관문 때문에 할 수 없다. 운영을 되살리는 정식 방법은 OPEN 하나뿐이다. 유지보수 컨테이너(배포 전이므로 2단계와 같은 `$CID`, C5 스테이징이 남아 있다. 컨테이너가 바뀌었으면 C5를 다시 한다)에서 실행서 D10 형식으로 `xa-ssh m3ultra "$DK exec -i $CID sh -s -- open $EPOCH1 $REV1 <OP> <REASON>" < "$W/in-container.sh"` dry-run을 먼저 실행한다. `/app`에는 `scripts/ops`가 없으므로 스테이징 없이 직접 실행하지 않는다. 2단계 (b)에서 non-serving route가 있었다면(`NONSERVING0 > 0`) 이 OPEN은 같은 판정으로 `deferred_routes:N`에 거절된다(스테이징한 `REL` 코드 + 199a3ebb 컨테이너 env). 그때는 허용 플래그를 쓰지 말고 DRAIN을 유지한 채 대표가 판단한다. M1 미확인은 그대로 남고, M1 relay는 재시작하지 않는다(경로 보존).
- **16단계 뒤**(배포 완료, DRAIN 유지)에 멈추면 정식으로 되살리는 방법은 18단계 OPEN 하나다. 17단계 relay 재설치가 실패하면 17단계 「되돌리기」로 이전 relay를 살린 뒤 18단계 `routes`를 본다. `product-translate`·`reason-translate`가 non-serving이면 OPEN은 `deferred_routes:N`으로 거절된다. 그때는 허용 플래그 없이 DRAIN을 유지하고 대표가 정한다. M1 잡은 멈춘 채로 둔다. 18단계가 끝나면(OPEN) 21·22단계는 접수 상태를 바꾸지 않는다. 21단계 apply는 AI2 표만 쓰고, 22단계는 읽기만 한다. 거기서 멈춰도 운영 접수는 그대로다.
- 어떤 단계에서도 시간 경과로 해제하지 않는다. `model_capacity_*`나 `jobs`를 SQL로 바꾸지 않는다. 관문 면제·`--allow-deferred-routes`를 쓰지 않는다. 실패한 once 디렉터리(배포 execution, M1 RUN, manifest out-dir)는 다시 쓰지 않는다.

## 6. 이 문서의 검증

- 로컬 시험(Node v22.22.1, 운영 접근 없음). 바꾼 영역 묶음은 다음과 같다: `release-29877f65`, `release-65f8c399-manifest`, `worker-progress-job-pause`, `worker-progress`, `worker-progress-capacity-drain`, `ops-runner-*` 9개, `admin-models-ops-*` 3개(ui 포함), `release-order-capacity-control`. 결과는 Vitest **17파일/145시험 PASS**이고, 변경 전(병합 커밋 51136a32, 같은 묶음에서 새 파일 제외)은 14파일/130시험이었다. Python `test_release_65f8c399_manifest` 3→**4건 PASS**. `next typegen` 뒤 `tsc --noEmit` exit 0, 변경 파일 ESLint 0.
- 화면: 관리 화면 작업 카드(인계 완료/일반 완료)를 앱 CSS로 정적 렌더해 확인했다(`ops-runner-handoff-card.png`). 운영 DB와 관리자 로그인이 필요한 `/admin/models` 실제 화면은 띄우지 않았다.
- 실제 운영에서는 아무것도 실행하지 않았다. 따라서 운영 수치(미확인 수, route 상태, revision)는 이번에 측정하지 않았다. 표의 `EPOCH*`·`REV*`는 대표가 실행하면서 적는 값이다.
- 재검증(2026-10-29, 브랜치 `xaegis/e84f26ca`, `xaegis/7b7a2d23`를 fast-forward로 합침, node_modules 연결): 지정 7파일(`release-29877f65`, `release-65f8c399-manifest`, `worker-progress-job-pause`, `ops-runner-root-handoff`, `ops-runner-operator`, `ops-runner-handoff`, `release-order-capacity-control`) Vitest **7파일/38시험 PASS**. 표 3의 SHA-256 10개를 `git show xaegis/7b7a2d23:<파일> | sha256sum`으로 다시 계산해 모두 일치했다. `drizzle/0143`·`0144` sha256과 저널 145항목, 0144 인덱스 이름이 1단계 기대값과 같다. `package-lock.json`은 199a3ebb·`/home/ubuntu/projects/nomorevibe`와 같다(C5 `same_as_image`, S1 `cmp` 전제 성립). 코드와 대조해 고친 곳: 7단계 revision(모드 전환은 revision을 올리지 않는다), 4단계 실패 코드 이름과 exit, 2단계 (b) 파일 경로·순서와 (e) R1 사전 확인(관문 문서 6절 1번과 맞춤), 실행서 표 0의 `build-manifest.py` 해시·S5/S7 실행 위치·B-3/D1 문구.
- 대표 실측 결함 수정(2026-10-29, 작업 공간 `xaegis/13018003`, `xaegis/da3bd4a3`와 origin/main `c7dad56b` 병합): 운영 이미지에는 `scripts/ops`가 없다(`.dockerignore` 7행). m3ultra 유지보수 컨테이너에서 옛 `capacity-control.sh routes`가 `ERR_MODULE_NOT_FOUND '/app/scripts/ops/pipeline-control.ts'`로 실패해 2단계 (b)와 18단계를 실행할 수 없었다. `capacity-control.sh`를 `/tmp` 스테이징 방식으로 고쳤고(2절 3번), 2단계 (b)·18단계·5절 실패 경로와 실행서 표 0·C5·D10·B-1, 관문 문서 6절 3·8번을 고쳤다. 18단계는 「새 컨테이너에 C5 재스테이징 + `in-container.sh open`」이다. 시험 `tests/release-order-capacity-control.test.ts`는 이미지 `/app`에 `scripts/ops`가 없는 조건에서 스테이징 경로로만 성공함을 보인다. tar sha·lock 불일치·pipeline-control 없는 tar·`/app/node_modules` 없음·다른 tar 재스테이징·스테이징 뒤 lock 변경을 쓰기 없이 거절함도 보인다. busybox 도구만으로 도는 경우와 실제 `git archive` tar(pax 머리)도 시험하고, 2단계 (b) awk 집계가 OPEN의 `deferred_routes` 판정과 같음도 확인한다. 이 파일은 2 → 11시험이다.
- 같은 작업에서 실제 DB 통합 시험(로컬 일회용 PostgreSQL 17 + pgvector, CI와 같은 `127.0.0.1:55435`)으로 결함 하나를 더 찾았다. 접수 CLI 미리 보기가 READ ONLY TX에서 `FOR SHARE`를 써 `25006`으로 실패했다(4단계 미리 보기·`--execute` 모두 exit 1). `readWriterFence`로 고쳤다. 새 통합 시험 `tests/integration/ops-runner-drain-handoff.test.ts`(2건)는 정식 CAS DRAIN → handoff의 감사 핀 왕복, 재실행 시 중복 없음, 남의 DRAIN(`handoff_drain_not_owned`), 바뀐 DRAIN(`handoff_drain_changed`), 미리 보기 READ ONLY와 비 indeterminate 거절(감사 행 0)을 확인한다. 고치기 전 코드에서는 1/2가 `25006`으로 실패했다. 관련 통합 `provider-boundary-release`·`replaced-provider-boundary-release`·`pipeline-control-status`와 함께 4파일/17시험 PASS다. `assemble.ts preflight`·`readback`과 `pipeline-control status`도 같은 시험 DB(0144까지 적용, 145행)에서 SQL 오류 없이 실행됐다(요청 행이 없으므로 exit 3이 정상).
- 시험 수(전 = 병합 커밋 `69b830a5`, 후 = 수정 커밋): 지정 7파일 40 → 49, ops-runner·admin-models-ops·release·worker-progress·pipeline-control 18파일 175 → 184, Python unittest 20건 PASS, `next typegen` 뒤 `tsc --noEmit` 0, 바뀐 파일 ESLint 0.
- 3판(2026-10-29, 작업 공간 `xaegis/87e232d6`, origin/main `f4fe5958`에 fast-forward, node_modules 연결, 운영 접근 없음):
  - 해시: 표 3과 묶음 0절의 파일 해시를 `REL=f4fe5958…`에서 다시 계산했다. 1f52c9ef 판과 모두 같고 스테이징 tar만 `75f388d4…` → `cdff13dd…`로 바뀌었다. 같은 명령으로 `1f52c9ef`·`279e596e`의 이전 tar 값(`75f388d4…`·`9ab8a624…`)도 재현했다. 묶음 1절 블록을 이 저장소에서 그대로 쳐서 `rel_on_main`, 네 해시, `TAR_SHA`, `LOCK_SHA`가 표와 같음을 확인했다. 3절 「배포 TARGET 확인」 블록도 병합 전 main(`f4fe5958`)에 쳐서 `target_is_main`·`target_same_staged_tree`·CI `40885469282 success`를 확인했다. 병합 뒤 main에서는 대표가 다시 친다.
  - 새 시험 `tests/release-order-hashes.test.ts`(10건): 확정본·묶음·실행서·relay 안내 네 표의 파일 해시를 작업 트리 파일과 대조한다. 같은 파일이 네 문서에서 같은 값인지, `REL`·`RELAY_SHA`·`TAR_SHA`가 문서 사이에 같은지, `TARGET`을 고정하지 않았는지 본다. REL 커밋이 있는 checkout에서는 `git archive` tar sha256도 대조한다(단위 CI는 얕은 checkout이라 그 1건은 건너뛴다). 21·22단계 SQL 생성기를 실제 런북에 돌려 A1~A5·T0~T9가 원문 그대로이고 psql 변수가 남지 않는지, 잘못된 `deploy_at`을 쓰기 없이 거절하는지도 본다. 통합 시험 `tests/integration/release-order-post-deploy-sql.test.ts`(2건)는 그 SQL 15개를 READ ONLY 실행기 방식으로 마이그레이션 0144까지 적용한 일회용 PostgreSQL 17(pgvector 0.8.6)에서 오류 없이 실행한다.
  - 17단계 `check` argv: macOS 밖에서 가짜 plist(같은 키)·토큰 파일·작업 트리 코드로 실제 `server.ts check`를 돌렸다. `check_exit 0`, `equipment:"m1"`, `allowedModels:["mlx-community--gemma-4-26b-a4b-it-4bit"]`, `relayRevision:"279e596e…"`가 나왔다. plist 모델을 `qwen3.8-flash-next`로 바꾸면 `check_exit 1`, `invalid_config`였다. 실제 M1 launchd·health는 측정 없음.
  - 문서 안 `sh` 블록 10개는 `bash -n`, `jsonl` 3개는 JSON 파싱을 통과했다.
  - 시험 수: 관련 단위 10파일 64건 → 새 파일을 더해 11파일 74건 PASS(`release-order-capacity-control`·`release-29877f65`·`release-65f8c399-manifest`·`postprocess-backlog-*` 3·`ai2-stale-*` 3·`m1-relay-model-config`). 통합 `release-order-post-deploy-sql`·`ai2-stale-reconcile`·`postprocess-backlog-*` 3·`ops-runner-drain-handoff` 6파일 22건 PASS. 바뀐 TS 파일 ESLint 0, `next typegen` 뒤 `tsc --noEmit` 0. 전체 unit·전체 DB·종합 시험은 AGENTS.md 정책상 통합 단계 몫이라 돌리지 않았다.
  - 운영(DB·M1·M3·배포·0143)에서는 아무것도 실행하지 않았다. 21·22단계의 운영 결과와 relay health는 측정 없음이다.
