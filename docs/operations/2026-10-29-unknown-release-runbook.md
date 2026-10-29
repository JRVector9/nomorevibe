**결론: M1 `29877f65`는 지금(0143 전·OPEN 유지) 읽기 전용 수집과 preflight까지 할 수 있고, plan→dry-run→apply는 0143 적용 뒤 대표가 연 짧은 DRAIN 창 안에서만 이어서 실행한다. Supa `65f8c399`는 유지보수 컨테이너 안에서 runner를 돌릴 수 없다(이미지에 `/usr/bin/python3`·`/usr/bin/ssh`가 없고, maintenance에 SSH 키를 주지 않는 설계). 그래서 gpu3090의 실제 운영자 셸(허브 샌드박스 아님)에서 runner를 실행하고, root 단계 두 번만 대표가 device_admin으로 supa에서 실행한다. 운영 웹(199a3ebb)에는 접수 버튼이 없지만, 배포는 미확인 0건을 요구하므로 배포를 기다릴 수 없다. 그래서 job은 운영자 셸 접수 CLI로 접수하고 **배포 전에** 실행한다.**

> **실행 순서는 [2026-10-29-release-order.md](2026-10-29-release-order.md)가 확정본이다.** 그 순서에서는 Supa(B절)를 OPEN 상태에서 먼저 실행한다. runner는 끝에 OPEN하지 않고 자기 DRAIN을 인계한다(`--final-admission=draining`). M1(A절)은 그 DRAIN 안에서 D2·D10 없이 실행한다. 아래 절과 다르게 적힌 곳이 있으면 확정본을 따른다.

# 미확인 요청 2건 해제 실행서 (2026-10-29)

작성 범위는 코드·스크립트·문서다. 작업자는 원격 명령, 운영 DB 쓰기, 0143 적용, DRAIN, 배포를 실행하지 않았다. 아래 명령은 모두 대표가 실행할 목록이며, 각 단계의 성공 조건을 확인한 다음에만 다음 단계로 넘어간다.

- 시간 경과·TTL·idle만으로 해제하지 않는다. 장부를 SQL로 직접 UPDATE하지 않는다. DB 쓰기는 정식 도구만 한다(`pipeline-control --execute`, `model-replaced-provider-boundary-release.ts --apply`, ops-runner).
- 응답이 불명확하면 같은 쓰기를 다시 요청하지 않는다. readback으로 먼저 확인한다. 실패한 once 디렉터리는 다시 쓰지 않는다.
- 다른 차선(49b91700 등)의 작업, ops-runner 미완료 job, 배포가 진행 중이면 시작하지 않는다.

## 0. 공통 값

| 이름 | 값 |
| --- | --- |
| M1 요청 | `29877f65-9f95-4efb-88f9-aea5f39a28b2` (product-translate, `[m1] qwen3.8-flash-next`, dispatch 2026-10-28T13:58:16.331Z, C=40768) |
| 원 relay 요청 | `6571d6c8-002f-4f5f-b399-47e40876ee43` |
| Supa 요청 | `65f8c399-ff4b-47bc-8f4d-6e4a682cf6a7` (crawl-agent-review, supa `vllm.service`) |
| 도구 위치 | 처음 작성 브랜치는 `xaegis/4ed4ea33`(기준 origin/main `75b8aa31`, push 안 함)이다. 확정 순서에서는 이 브랜치를 포함하고 runner 인계·접수 CLI를 더한 `xaegis/7b7a2d23`을 쓴다: `SRC=/home/ubuntu/.xaegis-hub/data/local-agent/worktrees/7b7a2d23-0c49-41f3-9665-1fc4e53ff9a0`, 아래 `SHA`와 B절 `T`는 `git -C "$SRC" rev-parse xaegis/7b7a2d23` |
| 유지보수 컨테이너 | m3ultra Swarm 앱 `app-navigate-neural-system-yf43c7` |
| 직접 primary | `100.99.209.55:5432/nomorevibe`. 10/28 0140~0142를 적용한 경로다. 컨테이너 `DATABASE_URL`의 계정을 쓰고 host/port/db만 바꾼다(`in-container.sh`). URL은 출력하지 않는다 |

검토할 스크립트의 SHA-256(브랜치 커밋 기준):

| 파일 | SHA-256 |
| --- | --- |
| `scripts/ops/release-29877f65/collect-m1.sh` | `9ee283daffd0f8aa943e6c0e3829c9cdb0214a7105d94db5db4f83022807ce38` |
| `scripts/ops/release-29877f65/collect-docker.sh` | `185c8f486a47b42060830a902b6dbc4422119de341a4c2abe52abe1d6a79ab83` |
| `scripts/ops/release-29877f65/in-container.sh` | `8690b97adf6497d28470ab2a42339a3efd6c562d127ac1ac1b54b1573c2c0611` |
| `scripts/ops/release-29877f65/assemble.ts` | `724f537c814a5159c360b4961984159a56417eb451a13e531a10122afb6691d2` |
| `scripts/ops/release-29877f65/wire.ts` | `065f7639006caafaff961236eb82de7ed75aa6d9d6334a455412e15bfc6e5c51` |
| `scripts/ops/release-65f8c399/build-manifest.py` (`xaegis/7b7a2d23`, `--final-admission` 추가. 4ed4ea33 판은 `4099b7e0…`이며 S5 인자를 받지 못한다) | `1d974717b4b6b45ffa1e6119f05edfca003cb217dcb92feafbf26e692c2285c7` |
| `scripts/ops/model-replaced-provider-boundary-release.ts` (main 그대로) | `c9e1ae002ecb49ad7e7cf1382adbdf7f41228f10a7262eafee5114f513463771` |
| `scripts/ops/admin-models-boundary-adapter.py` (main 그대로) | `f51d5ef76232bf74e652a27627aabed97236029ae1c17742a55df55311707f61` |
| `admin_models_helpers/systemd_action.py` | `744e082e9b7e8708e41203eb481b640df4542453a0f965e4039ac55ce2dd160e` |
| `admin_models_helpers/systemd_reader.py` | `6bc05052a521c6e30624ee734a0b57c5098de99ef6842c61ee35d009c3041156` |
| `admin_models_helpers/systemd_handoff.py` | `d98074cb55868a5e2cff49f11011bb13d2fc37bcd6d8fd25f1121dcc95b7f4ff` |

`xa-ssh <호스트> <원격 명령…>`은 ssh처럼 원격 명령과 stdin을 그대로 넘긴다고 가정했다. 형식이 다르면 같은 원격 argv와 stdin으로 바꿔 실행한다. m3ultra의 docker는 `env PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin docker …`로 부른다(아래 `DK`).

---

# A. M1 `29877f65` — 교체된 경계 단건 해제 (PR721)

## A-1. PR721이 요구하는 근거 목록

근거는 `lib/llm/replaced-provider-boundary-contract.ts`, `scripts/ops/replaced-provider-boundary-artifacts.ts`, `scripts/ops/model-replaced-provider-boundary-release.ts`, 그리고 0143 trigger(`scripts/ops/replaced-provider-boundary-sql.template.sql`)가 요구한다. 시각은 모두 `YYYY-MM-DDTHH:MM:SS.mmmZ` 형식이다. control.updatedAt만 마이크로초 형식이다.

| 항목 | 출처 | 형식·검사 |
| --- | --- | --- |
| 요청 행 고정 | primary `model_capacity_requests` | requestId 1건. `rowHash = sha256(to_jsonb(r)::text)`, `tokenHash = sha256(token)`, bindingHash(canonical binding), epoch/revision/policyHash, providerBudgetId/groupId, servingContractHash, wireHash, chargedTokens(=totalTokenBound), dispatchAt(dispatched_at과 ms 단위로 정확히 같아야 함). route `product-translate`, provider `abcllm`, model `[m1] qwen3.8-flash-next`, binding kind `product_translation_gateway`. trigger가 다시 계산한다 |
| capacity·writer 고정 | `model_capacity_control`, `dr_writer_fence` | mode **draining**, epoch/revision/policyHash, updatedAt(µs). fence active, lineageId/writerEpoch. 같은 revision이라도 OPEN일 때 만든 계획은 쓸 수 없다 |
| 원 owner 종료 | `dr_process_group_events`, `model_capacity_events` | owner_opened(dispatch 전), dispatch 이전 spawn_intent 전부, 그 각각의 spawned와 group_exited(`pgid_esrch_after_sigkill`, dispatch 이후·plan 이전). 요청별 `dispatch_local_ended` 1건과 그 evidence::text의 SHA. 기록상 opened 1932/intent 1933/spawn 1934/exit 1967, local-end 156477. DB 함수 `nmv_boundary_original_owner_records_valid`가 다시 읽는다 |
| 원 wire bytes | 199a3ebb 코드와 상품 원문 4개 | `0507685d…`. 각 member의 sourceHash가 지금도 같아야 복원한다. 원문이 바뀌었으면 중단한다 |
| relay wire bytes | 원 wire에 gateway 변환과 HTTPX 0.27.2 `json.dumps`를 적용 | `81d1f571…` = 원 relay receipt의 requestHash. 키 순서는 model, messages, stream, stream_options, chat_template_kwargs, max_tokens, temperature(`0.0`) |
| owner·gateway 3곳 교체 | m3ultra `nomorevibe-text-m3-ebmybu`·`app-reboot-optical-matrix-3bl2a4`, 9mini `app-hack-optical-monitor-v1ioak` | 서비스마다 replicas 1, 실행 컨테이너 1개, privileged false, PidMode ""(private PID ns), **startedAt > dispatchAt**, desired Running task 1개, 나머지 task는 Shutdown/Failed/Complete/Rejected/Remove. 캡처는 **plan 뒤에** 한다. topology는 대표가 검토했다는 선언(reviewer 이름)이다 |
| gateway 소스 스냅샷 | m3 gateway 컨테이너의 `/app/app/{routers/ollama_proxy.py,models/ollama.py,services/vllm_client.py,services/mlx_concurrency.py}` | `docker cp … -`로 바이트만 읽는다. 실행하지 않는다 |
| 원 relay receipt | m1studio `/var/nmvllm/receipts/6571d6c8-….json` (root 0700) | 파일 바이트 그대로. requestId/requestModel `qwen3.8-flash-next`/requestHash/relayGeneration/startedAt/endedAt/state `indeterminate`/error `upstream_timeout` |
| 복구 proof | m1studio `/Users/jinwooro/.local/share/nomorevibe-m1-translation-20261028/receipts-20261029/*.json` 중 kind `m1-original-request-relay-recovery`·relayRequestId 일치 **1건** | originalReceiptSha256 = receipt 바이트 SHA(기록상 `40f99fed…`), originalRelayGeneration, restored.relayGeneration, newRelayPid, nativeExit/relayExit의 ESRCH 값 모두 true, originalNativeIdentity.{pid,startedAt(ms)}, nativeRestarted false, completedAt |
| 현재 relay·모델 | m1studio `launchctl print system/bot.brut.nmv-llm-relay`, `ps`, `lsof 127.0.0.1:8000`, `GET 127.0.0.1:8000/v1/models` | relay PID = launchd PID = recovery.newRelayPid. 시작은 원 endedAt 이후이고 recovery.completedAt 이전이다. 같은 프로세스이면 `service.ts`의 generation도 같다. 현재 native PID는 원 PID와 다르고 시작이 endedAt 이후이며, 모델 목록에 `qwen3.8-flash-next`가 없다. 원 native PID와 그 process group이 없어야 한다 |
| 신선도 | 시계 | plan 생성 뒤 30분 안, 마지막 수집 뒤 5분 안에 dry-run과 apply를 한다(DB `clock_timestamp()` 기준, trigger가 다시 검사) |

`native-readback.json`은 이 계약에 쓰이지 않는다. 없어도 된다.

**M1 relay를 Gemma handoff 등으로 bootout·재시작하면 현재 relay PID가 recovery.newRelayPid와 달라져 이 경로가 영구적으로 막힌다.** 이 해제가 끝나기 전에는 `2026-10-29-m1-relay-model-handoff.md`의 bootout/bootstrap을 실행하지 않는다. 반대로 owner·gateway 컨테이너는 dispatch 뒤에 다시 시작되기만 하면 된다. 배포로 교체돼도 괜찮다.

## A-2. 0143 전, 지금 실행할 수 있는 단계 (OPEN 유지, DB 쓰기 0)

이 단계들은 DRAIN을 하지 않고 운영을 바꾸지 않는다. 여기서 막히는 항목이 있으면 0143을 적용해도 해제할 수 없다. 그러니 0143 승인 전에 먼저 실행해 본다.

### C1. 작업 폴더와 도구 해시 확인
- 위치: gpu3090 대표 셸
- 전제: 이 브랜치를 검토했다
- 명령:
```sh
SRC=/home/ubuntu/.xaegis-hub/data/local-agent/worktrees/7b7a2d23-0c49-41f3-9665-1fc4e53ff9a0
W=$HOME/nmv-release-29877f65; (umask 077; mkdir -p "$W/pre")
SHA=$(git -C "$SRC" rev-parse xaegis/7b7a2d23); echo "$SHA"     # 4ed4ea33의 M1 스크립트를 그대로 포함한다
git -C "$SRC" show "$SHA:scripts/ops/release-29877f65/collect-m1.sh" | sha256sum
git -C "$SRC" show "$SHA:scripts/ops/release-29877f65/collect-docker.sh" | sha256sum
git -C "$SRC" show "$SHA:scripts/ops/release-29877f65/in-container.sh" | sha256sum
```
- 성공: 세 해시가 표 0의 값과 같다.

### C2. M1 수집 argv 만들기 (원격 파일 생성 없음)
- 위치: gpu3090
- 명령: 스크립트 본문을 `bash -c`의 인자로 넘기는 device_admin JSON을 만든다. M1에 파일을 놓지 않는다.
```sh
git -C "$SRC" show "$SHA:scripts/ops/release-29877f65/collect-m1.sh" > "$W/collect-m1.sh"
python3 -I -c 'import json,sys;print(json.dumps({"executable":"/bin/bash","args":["-c",open(sys.argv[1]).read(),"collect-m1"]}))' "$W/collect-m1.sh" > "$W/m1-argv.json"
sha256sum "$W/collect-m1.sh"
```
- 성공: 해시가 `9ee283da…`이다. `m1-argv.json`의 executable이 `/bin/bash`이다.

### C3. M1 근거 수집 (root, 읽기 전용)
- 위치: m1studio, device_admin(root)
- 전제: C2. 다른 차선이 M1 relay를 재시작하는 중이 아니다
- 명령: device_admin에 `$W/m1-argv.json`의 `{"executable":"/bin/bash","args":["-c","<collect-m1.sh 본문>","collect-m1"]}`를 그대로 넘긴다. stdout 전체를 `$W/pre/bundle-m1.json`에 저장하고, stderr 마지막 줄의 sha256을 적는다.
```sh
sha256sum "$W/pre/bundle-m1.json"   # stderr의 sha256과 같아야 한다
python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["warnings"],d["launchd"],d["relayProcess"],d["nativeProcess"],d["nativeModels"],d["originalModel"],len(d["recoveryCandidates"]))' "$W/pre/bundle-m1.json"
```
- 성공: exit 0이고 두 sha가 같다. `euid` 0, warnings가 비어 있다(`relay_active_json_present`가 있으면 relay가 아직 미확인 상태라는 뜻이다. 해제 자체는 가능하지만 OPEN 뒤에도 M1 경로는 막힌다). recoveryCandidates가 1건이다. 여러 건이면 중단하고 proof 파일을 검토한다.

### C4. Swarm 근거 수집 (읽기 전용)
- 위치: gpu3090 → m3ultra, mini (xa-ssh)
- 명령:
```sh
git -C "$SRC" show "$SHA:scripts/ops/release-29877f65/collect-docker.sh" > "$W/collect-docker.sh"
xa-ssh m3ultra /bin/bash -s -- --host=m3ultra < "$W/collect-docker.sh" > "$W/pre/bundle-m3ultra.json"
xa-ssh mini    /bin/bash -s -- --host=9mini   < "$W/collect-docker.sh" > "$W/pre/bundle-9mini.json"
sha256sum "$W"/pre/bundle-*.json
```
- 성공: 각 exit 0이고 stderr의 sha256이 파일 해시와 같으며 warnings가 비어 있다.

### C5. 유지보수 컨테이너에 검토한 소스 올리기
- 위치: gpu3090 → m3ultra 컨테이너. 컨테이너 `/tmp`에만 쓴다. 운영 데이터는 바꾸지 않는다
- 명령:
```sh
DK='env PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin docker'
CID=$(xa-ssh m3ultra $DK ps -q --no-trunc --filter label=com.docker.swarm.service.name=app-navigate-neural-system-yf43c7); echo "$CID"
git -C "$SRC" show "$SHA:scripts/ops/release-29877f65/in-container.sh" > "$W/in-container.sh"; sha256sum "$W/in-container.sh"
git -C "$SRC" archive --format=tar "$SHA" lib scripts drizzle messages tsconfig.json package.json package-lock.json > "$W/src.tar"
TAR_SHA=$(sha256sum "$W/src.tar" | cut -c1-64); echo "$TAR_SHA"
xa-ssh m3ultra "$DK exec -i $CID sh -c 'umask 077 && mkdir -p /tmp/nmv-release-29877f65 && cat > /tmp/nmv-release-29877f65/src.tar && sha256sum /tmp/nmv-release-29877f65/src.tar'" < "$W/src.tar"
xa-ssh m3ultra "$DK exec -i $CID sh -s -- stage $TAR_SHA" < "$W/in-container.sh"
```
- 성공: CID가 정확히 1줄이다. 원격 sha256이 `$TAR_SHA`와 같다. stage가 `{"staged":…,"lock":"same_as_image"}`를 출력한다. `package_lock_differs_from_image`가 나오면 중단한다(이미지 node_modules를 재사용할 수 없다).

### C6. DB 대상 확인 (값 출력 없음)
- 위치: m3ultra 컨테이너
- 명령: `xa-ssh m3ultra "$DK exec -i $CID sh -s -- db-target" < "$W/in-container.sh"`
- 성공: host `100.99.209.55`, port `5432`, database `nomorevibe`, queryKeys에 sslmode 말고는 없다. 이 단계에서는 계정이 맞는지까지 확인하지 않는다. C7이 실제로 연결해 본다.

### C7. preflight (READ ONLY)
- 위치: m3ultra 컨테이너
- 명령:
```sh
for f in bundle-m3ultra bundle-9mini bundle-m1; do
  xa-ssh m3ultra "$DK exec -i $CID sh -c 'umask 077 && cat > /tmp/nmv-release-29877f65/in/$f.json'" < "$W/pre/$f.json"; done
xa-ssh m3ultra "$DK exec -i $CID sh -s -- preflight $(sha256sum "$W/pre/bundle-m3ultra.json" | cut -c1-64) $(sha256sum "$W/pre/bundle-9mini.json" | cut -c1-64) $(sha256sum "$W/pre/bundle-m1.json" | cut -c1-64)" < "$W/in-container.sh" | tee "$W/pre/preflight.json"
```
- 성공: exit 0이고 `blockedNow: []`이다. 0143 전에는 `applyRequires0143: true`, `readyForDrainWindow: false`가 정상이다. 확인 항목은 request indeterminate/C 보존, binding canonical, dispatch ms 일치, owner 종료 기록과 DB 함수 재검사, 원 wire 복원(0507685d), relay wire(81d1f571), 3개 컨테이너의 dispatch 뒤 시작과 살아 있는 이전 task 없음, M1 receipt·proof·현재 relay=복구 프로세스, 모델 교체, 원 PID/그룹 부재다.
- 막히면 다음 순서로 판단한다. `m1_current_relay_is_recovered_process` 실패는 relay가 복구 뒤 재시작됐다는 뜻이고, 이 경로로는 해제할 수 없다(새 계약이 필요하다). `original_wire_reconstructed_matches_ledger` 실패는 상품 원문이 바뀌었다는 뜻이므로 원문을 추측하지 않는다. `*_started_after_dispatch` 실패는 그 컨테이너가 dispatch 이후 교체되지 않았다는 뜻이고 해제 근거가 없다. 어느 경우든 DRAIN하지 않는다.

## A-3. 0143 게이트 (사람 승인)

0143 적용은 이 문서 범위 밖이다. 대표가 사람 승인 뒤 정식 migration 절차로 적용한다. 그다음 C7을 다시 실행해서 `schema.has0143: true`, `schema.guardTrigger: true`, `readyForDrainWindow: true`를 확인한다. **0143 전에는 dry-run도 할 수 없다.** 해제 트랜잭션이 0143의 `nmv_replaced_provider_records_valid`를 호출하고(`lib/llm/capacity-repository.ts:2335`), 기존 CHECK도 새 withdrawn 증거를 거절하기 때문이다.

## A-4. 0143 적용 뒤 — DRAIN 창 (한 번에 이어서)

시간 제한은 둘이다. plan 생성 뒤 30분 안에 apply해야 하고, **마지막 수집 뒤 5분 안에** dry-run과 apply를 끝내야 한다. DRAIN 동안 모든 모델 호출자가 미뤄지므로 미리 C1~C7을 연습해 둔다. **확정 순서(release-order 12단계)에서는 Supa runner가 인계한 DRAIN 안에서 D1·D3~D9만 실행한다. D2(DRAIN)와 D10(OPEN)은 하지 않는다.** 배포가 같은 DRAIN을 요구하기 때문이다. 이 창에서 M1이 막히면 해제하지 않는다. 그다음 처리는 release-order 5절 「실패 경로」를 따른다.

RUN 이름 예시는 `run-20261029T1200Z`이다(처음 쓰는 이름). REF는 공백 없는 검토 참조, 예: `29877f65-replaced-boundary-20261029-jr`. OP는 운영자 이름이다.

### D1. 현재 상태 확인
- 위치: m3ultra 컨테이너 / 명령: `xa-ssh m3ultra "$DK exec -i $CID sh -s -- status" < "$W/in-container.sh"`
- 성공(확정 순서): capacity `draining`이고 epoch/revision이 Supa runner 인계 값(release-order 7·11단계의 `EPOCH1`·`REV1`)과 같다. `status`는 ops-runner job과 감사를 보여 주지 않는다. job `completed`와 `<JOB>:draining`·`<JOB>:handoff` 감사 2행은 release-order 11단계의 읽기로 이미 확인한 것을 쓴다. (단독 실행이라면 capacity `open`, epoch 1, revision 7을 확인하고 D2로 간다. 모드 전환은 revision을 바꾸지 않으므로 D2 뒤에도 D10은 같은 `1 7`이다.)

### D2. DRAIN (정식 CAS, dry-run 뒤 실행) — 확정 순서에서는 하지 않는다
- 위치: m3ultra 컨테이너
```sh
xa-ssh m3ultra "$DK exec -i $CID sh -s -- drain 1 7 $OP release-29877f65-replaced-boundary" < "$W/in-container.sh"
xa-ssh m3ultra "$DK exec -i $CID sh -s -- drain 1 7 $OP release-29877f65-replaced-boundary --execute" < "$W/in-container.sh"
```
- 성공: dry-run이 blocked 없이 계획을 보여 준다. execute는 exit 0이고 readback이 `draining`이다. 거절(exit 3)되면 중단한다.

### D3. plan (READ ONLY로 작성)
- 위치: m3ultra 컨테이너 / 명령: `xa-ssh m3ultra "$DK exec -i $CID sh -s -- plan $RUN $REF" < "$W/in-container.sh" | tee "$W/plan-out.json"`
- 성공: exit 0이고 `planSha`가 나오며 checks가 모두 ok다(`db_replaced_provider_records_valid` 포함). `PLAN_SHA`와 `createdAt`을 적는다.

### D4. plan 뒤 수집 3건
- 위치: m1studio(device_admin) → m3ultra·mini(xa-ssh). C3·C4와 같은 명령을 실행하고, 출력은 `$W/$RUN/`에 저장한다
- 성공: 세 묶음의 sha가 각각 일치한다. 이 수집 중 **가장 늦은 시각부터 5분**이 apply 마감이다.

### D5. 묶음 전송과 receipt
```sh
for f in bundle-m3ultra bundle-9mini bundle-m1; do
  xa-ssh m3ultra "$DK exec -i $CID sh -c 'umask 077 && cat > /tmp/nmv-release-29877f65/runs/$RUN/$f.json'" < "$W/$RUN/$f.json"; done
xa-ssh m3ultra "$DK exec -i $CID sh -s -- receipt $RUN $PLAN_SHA <m3 sha> <mini sha> <m1 sha> <topology 검토자> $OP" < "$W/in-container.sh" | tee "$W/receipt-out.json"
```
- 성공: exit 0, `readyForDryRun: true`, `artifacts_verified`와 `evidence_predicate_at_local_clock`가 ok다. `RECEIPT_SHA`와 `applyBefore`를 적는다. topology 검토자는 C4 묶음의 serviceList·endpointPorts를 보고 대체 ingress가 없다고 판단한 사람이다.

### D6. dry-run (전체 쓰기 뒤 ROLLBACK)
- 명령: `xa-ssh m3ultra "$DK exec -i $CID sh -s -- release $RUN $PLAN_SHA $RECEIPT_SHA $OP $REF" < "$W/in-container.sh"`
- 성공: `{"dryRun":true,"result":{"kind":"released",…}}`이 나온다. 오류 JSON의 `code`/`missing`이 나오면 중단한다. 마지막 수집 뒤 5분이 지났으면, receipt.json을 덮어쓸 수 없으므로(once 파일) 새 RUN 이름으로 D3(plan)부터 다시 한다. DRAIN은 유지된 상태이고 plan도 READ ONLY로 다시 만든다.

### D7. apply
- 명령: D6 명령 끝에 ` --apply`를 붙인다
- 성공: `{"dryRun":false,"result":{"kind":"released","auditId":N}}`이 나온다. 응답이 불명확하면 apply를 반복하지 않고 D8을 먼저 실행한다. 같은 근거로 다시 실행하면 `already_released`가 나온다.

### D8. readback (READ ONLY)
- 명령: `xa-ssh m3ultra "$DK exec -i $CID sh -s -- readback" < "$W/in-container.sh" | tee "$W/readback.json"`
- 성공: exit 0이고 `released: true`이다. 요청 state `withdrawn`, terminal kind `replaced_provider_boundary_exit`, settled_at NULL(사용량 미확정 보존), C 40768 보존, `dispatch_released` 1건, 감사 `model-replaced-provider-boundary-release` 1건. active 목록에 29877f65가 없다.

### D9. 판 확인
D2 이후 다른 쓰기가 끼어들지 않았는지 확인한다. D1과 같은 status를 보고 capacity가 여전히 `draining`, epoch/revision이 그대로인지 본다.

### D10. OPEN (자기가 건 DRAIN만 복원) — 확정 순서에서는 하지 않는다(배포 뒤 release-order 18단계)
```sh
xa-ssh m3ultra "$DK exec -i $CID sh -s -- open 1 7 $OP release-29877f65-done" < "$W/in-container.sh"
xa-ssh m3ultra "$DK exec -i $CID sh -s -- open 1 7 $OP release-29877f65-done --execute" < "$W/in-container.sh"
```
- 성공: readback이 `open`이다. dry-run이 deferred route 경고나 거절을 보이면, 그 경고가 DRAIN 전 상태에도 같았는지 확인하기 전에는 `--allow-deferred-routes`를 붙이지 않는다.

이 해제는 장부 점유만 해제한다. 원 요청의 업무 실패와 사용량 미확인은 그대로 남는다. M1 번역의 새 업무 성공은 M1 relay를 Gemma로 정식 전환한 뒤 따로 실측해서 기록한다.

---

# B. Supa `65f8c399` — ops-runner (PR719/722) 경로

## B-1. 추천안(컨테이너 안 runner)을 쓸 수 없는 이유 — 코드 근거

1. worker 이미지는 `node:24.22.1-alpine`이고, 시스템 패키지는 `apk add --no-cache tini util-linux font-dejavu`만 설치한다. grok 설치용 `bash curl`은 같은 층에서 다시 지운다(`Dockerfile:29-49`). 그래서 `/usr/bin/python3`와 `/usr/bin/ssh`가 없다.
2. runner는 adapter를 `execFile("/usr/bin/python3", …)`로 고정 경로에서 실행한다(`lib/operations/ops-runner/operator.ts:77`). adapter는 모든 장비에 `['/usr/bin/ssh','-o','BatchMode=yes',…, target['host'], '/usr/bin/python3 -I -']`로 접속한다(`scripts/ops/admin-models-boundary-adapter.py:127-128`).
3. 설계상 maintenance에는 SSH 키·sudo·물리 실행 모듈을 주지 않는다(`docs/operations/admin-models-ops-runner.md:4`). 컨테이너에 키를 넣는 것은 계약 위반이다.
4. 그래도 실행하면 execFile이 실패해 stdout이 빈 값이 되고, `ops_runner_adapter_outcome_unknown` → prepare `blocked`로 끝난다. DRAIN 전이므로 운영 영향은 없다.

신뢰 경로 검사(`operator.ts:29-40`, adapter `private()`)는 막는 원인이 아니다. 모든 경로 구성 요소가 symlink가 아니고, 소유자가 0 또는 실행 uid이며, group/other 쓰기가 없으면 통과한다. 허브 샌드박스에서 난 `ops_runner_untrusted_path`는 user namespace가 `/`·`/home`을 overflow uid로 보이게 해서 생긴 것이다. 실제 uid 매핑 셸에서는 생기지 않는다. 검사를 느슨하게 하는 코드 수정은 보호를 약하게 하므로 하지 않았다.

## B-2. 선택지와 결정

| 선택지 | 판단 |
| --- | --- |
| **A. gpu3090 실제 운영자 셸(허브 샌드박스 아님)에서 runner 실행** | **채택.** `/usr/bin/python3`·`/usr/bin/ssh`가 있다. jr@m3Ultra·jr@supa SSH는 이전 기록에서 실제로 쓰였다. 코드·이미지·배포 변경이 없다. DB URL은 대표가 기존 비밀 저장소에서 셸 환경에만 넣는다 |
| B. m3ultra 호스트 셸(jr)에서 실행 | 가능은 하다. 다만 Node 24와 checkout이 있는지 확인되지 않았고(이전 기록상 경로 없음/권한 거부), 자기 자신(jr@m3Ultra)으로의 SSH 키도 필요하다 |
| C. python3+openssh를 넣은 전용 이미지 단계와 키 마운트 | 쓰지 않는다. 설계 문서를 위반하고, 이미지 변경·배포·비밀 마운트가 필요하다 |

최소 코드 변경은 runner 코드 수정이 아니다. **manifest/profile 생성기**(`scripts/ops/release-65f8c399/build-manifest.py`)만 추가했다. 손으로 identity를 옮기다 생기는 불일치를 없애기 위해서다. identity 계산은 adapter의 `linux_identity` 본문과 같고, 시험이 AST 동일성을 확인한다.

## B-3. 선행 조건 (하나라도 아니면 시작하지 않는다)

- 배포를 기다리지 않는다. 운영 웹 199a3ebb에는 `ops-runner-actions.ts`가 없으므로 job은 운영자 셸 접수 CLI `scripts/ops/admin-models-ops-submit.ts`로 접수한다(S3). 이 CLI는 웹과 같은 `submitModelOpsCommand`를 쓴다. 배포는 미확인 0건을 요구하므로 Supa 해제가 배포보다 먼저다. Supa 해제 자체에는 0143이 필요 없지만, 확정 순서에서는 M1 때문에 0143(+0144)을 먼저 적용·확인한다.
- capacity가 **OPEN**이다(prepare가 요구한다). 확정 순서에서는 A-2(C1~C7, 읽기 전용)만 0143 전에 끝냈고 A-4(D1~D9)는 아직 시작하지 않았다. runner는 시작할 때 이미 DRAIN이면 거절하고, 이 보호는 그대로다. runner는 끝에 OPEN하지 않고 자기 DRAIN을 A절에 인계한다(profile `finalAdmission:"draining"`).
- 다른 ops-runner 미완료 job이 없다. 요청 owner가 M3 reviewer `app-copy-primary-hard-drive-b5fhzd` 안에 아직 있다. 06:33Z 이후 reviewer가 재배포됐으면 prepare가 `request_owner_incarnation_changed`로 거절한다. 그때는 이 경로로 해제할 수 없다.
- supa에 root helper 3개가 설치돼 있다(B-4의 S2).

## B-4. 명령

### S1. 실행 셸 확인
- 위치: gpu3090 **실제 로그인 셸**(대표). `REL=$(git -C "$SRC" rev-parse xaegis/7b7a2d23)`, `T=/home/ubuntu/ops/nmv-runner-$REL` (runner 인계·접수 CLI가 이 커밋에 있다)
```sh
id -u; cat /proc/self/uid_map          # 0 0 4294967295 이어야 한다(샌드박스면 중단)
ls -l /usr/bin/python3 /usr/bin/ssh; node -v
for h in jr@m3Ultra <MINI_SSH> jr@supa; do /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=10 "$h" '/usr/bin/python3 -I -c "print(1)"' 2>"$HOME/ssh-$h.err"; wc -c < "$HOME/ssh-$h.err"; done
(umask 077; mkdir -p /home/ubuntu/ops/runner-state /home/ubuntu/ops/jobs /home/ubuntu/ops/inputs)
git -C "$SRC" archive "$REL" | (mkdir -p "$T" && tar -x -C "$T")
cmp "$T/package-lock.json" /home/ubuntu/projects/nomorevibe/package-lock.json && ln -s /home/ubuntu/projects/nomorevibe/node_modules "$T/node_modules"
sha256sum "$T/scripts/ops/admin-models-boundary-adapter.py" "$T"/scripts/ops/admin_models_helpers/systemd_*.py
```
- 성공: uid_map이 정체(identity) 매핑이다. 호스트마다 stdout `1`, stderr 0바이트다(adapter는 stderr가 한 글자라도 있으면 `remote_outcome_unknown`. host-key 경고가 나오면 그 호스트의 `LogLevel ERROR`·known_hosts를 먼저 정리한다). 해시가 표 0과 같다. `<MINI_SSH>`는 mini의 등록된 `user@host`이다.

### S2. supa root helper 설치 (대표 관리자 실행)
- 위치: gpu3090 → supa(jr로 사본 전달) → supa device_admin(root)
```sh
/usr/bin/ssh jr@supa 'umask 022; mkdir /var/tmp/nmv-helpers-75b8aa31'
for f in systemd_action.py systemd_reader.py systemd_handoff.py; do /usr/bin/ssh jr@supa "set -C; cat > /var/tmp/nmv-helpers-75b8aa31/$f" < "$T/scripts/ops/admin_models_helpers/$f"; done
```
device_admin argv(한 줄씩, 성공을 확인한 뒤 다음 줄):
```jsonl
{"executable":"/usr/bin/sha256sum","args":["/var/tmp/nmv-helpers-75b8aa31/systemd_action.py","/var/tmp/nmv-helpers-75b8aa31/systemd_reader.py","/var/tmp/nmv-helpers-75b8aa31/systemd_handoff.py"]}
{"executable":"/usr/bin/stat","args":["-c","%u %g %a %F %n","/usr/local/libexec/nmv-admin-models","/var/lib/nmv-admin-models-root","/var/lib/nmv-admin-models-root/results","/var/lib/nmv-admin-models-root/progress"]}
```
sha256이 표 0과 같으면 `2026-10-29-supa-root-handoff.md`의 설치 argv 다섯 줄을 `<REVIEWED_SOURCE_DIR>=/var/tmp/nmv-helpers-75b8aa31`로 실행한다(`install -d …`, `install -o root -g root -m 0644 …`). stat 결과 기존 설치물이 있으면 덮어쓰기 전에 그 해시와 진행 중인 작업 여부를 먼저 보존·검토한다.
- 성공: 설치 뒤 stat이 `0 0 755 directory …/nmv-admin-models`, `0 0 755 …/results`, `0 0 700 …/progress`를 보인다. 설치된 세 파일의 sha256이 표 0과 같다.

### S3. job 접수와 요청 확인
- 위치: gpu3090 실제 셸(S7의 `DATABASE_URL` 셸). 운영 웹 199a3ebb에는 버튼이 없다. 명령은 release-order 4단계에 있다(`admin-models-ops-submit.ts` 미리 보기 → `--execute`).
- 성공: `state.status: "queued"`이고 `JOB`이 나온다. 미리 보기의 `request.groupId`를 `GROUP=`로 적는다. `request.ownerInstanceId`가 M3 reviewer인지 확인한다. 순서상 S7을 S3보다 먼저 실행한다.

### S4. 읽기 helper 스냅샷 (읽기 전용)
- 위치: gpu3090. `I=/home/ubuntu/ops/inputs/$JOB`(`umask 077; mkdir "$I"`)
```sh
P='PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin /usr/bin/python3 -I -'
/usr/bin/ssh -o BatchMode=yes jr@m3Ultra "$P app-copy-primary-hard-drive-b5fhzd" < "$T/scripts/ops/admin_models_helpers/docker_reader.py" > "$I/owner.json"
/usr/bin/ssh -o BatchMode=yes jr@m3Ultra "$P app-reboot-optical-matrix-3bl2a4" < "$T/scripts/ops/admin_models_helpers/docker_reader.py" > "$I/gw-m3.json"
/usr/bin/ssh -o BatchMode=yes <MINI_SSH> "$P app-hack-optical-monitor-v1ioak" < "$T/scripts/ops/admin_models_helpers/docker_reader.py" > "$I/gw-mini.json"
/usr/bin/ssh -o BatchMode=yes jr@supa '/usr/bin/python3 -I -' < "$T/scripts/ops/admin_models_helpers/systemd_reader.py" > "$I/supa.json"
```
- 성공: 네 명령 모두 exit 0이고 stderr가 없으며 JSON이다. `supa.json`의 `unitProperties.ExecMainStartTimestamp`가 `… UTC`로 끝난다(adapter 파싱 형식). 아니면 중단한다.

### S5. manifest/profile 생성
- 위치: gpu3090
```sh
python3 -I "$T/scripts/ops/release-65f8c399/build-manifest.py" --job="$JOB" --out-dir="/home/ubuntu/ops/jobs/$JOB" \
  --adapter="$T/scripts/ops/admin-models-boundary-adapter.py" --affected-group="$GROUP" --container-progress-root=/Users/jr/.nmv-admin-models-progress \
  --owner="jr@m3Ultra:$I/owner.json" --gateway-m3="jr@m3Ultra:$I/gw-m3.json" --gateway-mini="<MINI_SSH>:$I/gw-mini.json" --provider="jr@supa:$I/supa.json" \
  --final-admission=draining
```
- 성공: `manifestSha256`·`profileSha256`가 나오고 warnings가 비어 있다(`owner_reader_shows_no_role_lease_owner…`가 나오면 중단한다). mini의 progress 경로가 m3와 다르면 별도로 정해야 한다. 이 생성기는 컨테이너 3개에 같은 progressRoot를 쓴다. 상위 디렉터리(`/Users/jr`)가 있는 경로를 쓴다.

### S6. 신뢰 경로·소유자 확인
```sh
J=/home/ubuntu/ops/jobs/$JOB; S=/home/ubuntu/ops/runner-state
for p in "$J/profile.json" "$J/manifest.json" "$T/scripts/ops/admin-models-boundary-adapter.py" "$T"/scripts/ops/admin_models_helpers/*.py "$S" "$J"; do d=$p; while :; do stat -c '%u %a %F %n' "$d"; [ "$d" = / ] && break; d=$(dirname "$d"); done; done | sort -u
```
- 성공: 모든 줄의 uid가 0 또는 `id -u`이다. 권한에 group/other 쓰기가 없다(끝 두 자리에 2·3·6·7 없음). `symbolic link`가 없다. `$S`·`$J`는 700이다. (`$T/node_modules`는 symlink지만 검사 대상이 아니다.)

### S7. DB 연결 준비 (값 출력 없음)
```sh
read -rs DATABASE_URL; export DATABASE_URL     # 대표의 비밀 저장소에서 직접 5432 primary URL을 붙여 넣는다
printf '%s\n' "$DATABASE_URL" | (cd "$T" && node --import tsx scripts/ops/release-29877f65/assemble.ts db-target --database-url-stdin)   # S1의 $T(REL archive + node_modules 연결)에서 실행한다
```
- 성공: host/port가 직접 primary다(PgBouncer 6432가 아니다. session advisory lock이 필요하다). gpu3090에서 5432가 닿지 않으면 `ssh -N -L 127.0.0.1:15432:100.99.209.55:5432 jr@m3Ultra` 터널과 그 host/port를 쓴다. sslmode 검증이 host 불일치로 실패하면 중단한다.

### S8. prepare (읽기 전용, DRAIN 없음)
```sh
cd "$T" && node --import tsx scripts/ops/admin-models-ops-runner.ts prepare "$JOB" --profile="$J/profile.json" --state-dir="$S" | tee "$HOME/ops-$JOB-prepare.json"
```
- 성공: exit 0, `status:"queued"`, `step:"prepare"`, `steps.prepare:"done"`. 출력에 `rootHandoffFile`(= `$S/$JOB.root-handoff.json`, 0600)가 있다. `blocked`이면 code를 보고 중단한다. identity 불일치면 S4부터 다시 하되, 출력 폴더는 새 부모 아래에 만든다(once 디렉터리는 다시 쓰지 않는다).

### S9. root-handoff 파일과 task sha 확인, task 전달
```sh
H=$S/$JOB.root-handoff.json
python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));[print(c["phase"],c["taskSha256"],c["taskPath"],c["stagingPath"],c["resultPath"],json.dumps({"executable":c["executable"],"args":c["args"]})) for c in d["commands"]]' "$H"
head -c -1 <taskPath> | sha256sum      # 파일은 canonical JSON+개행이다. 개행을 뺀 sha가 taskSha256과 같아야 한다
/usr/bin/ssh jr@supa "set -C; cat > /var/tmp/nmv-supa-root-<taskSha256>.json" < <taskPath>    # stop·restore 두 task 각각
```
device_admin(supa) 확인:
```jsonl
{"executable":"/bin/sh","args":["-c","head -c -1 /var/tmp/nmv-supa-root-<STOP_SHA>.json | sha256sum"]}
{"executable":"/bin/sh","args":["-c","head -c -1 /var/tmp/nmv-supa-root-<RESTORE_SHA>.json | sha256sum"]}
```
- 성공: stop과 restore 두 줄이 나온다. 로컬과 supa의 sha가 모두 taskSha256과 같다. **이 단계에서 stop argv를 실행하지 않는다.**

### S10. run → stop 대기
```sh
cd "$T" && node --import tsx scripts/ops/admin-models-ops-runner.ts run "$JOB" --profile="$J/profile.json" --state-dir="$S" | tee -a "$HOME/ops-$JOB-run.json"
```
- 성공(기대 정지): exit 1, `status:"manual"`, `step:"stop"`, `code:"supa_root_result_required"`. runner가 정식 CAS로 DRAIN하고 quiescence와 plan을 확인한 뒤 reviewer와 gateway 2개를 중지·검증한 상태다. 업무가 멈춰 있으므로 바로 S11로 간다.

### S11. root stop (device_admin, supa)
- argv: handoff 파일 stop 줄의 값을 그대로 쓴다. 형태는 다음과 같다:
`{"executable":"/usr/bin/python3","args":["-I","/usr/local/libexec/nmv-admin-models/systemd_handoff.py","execute","/var/tmp/nmv-supa-root-<STOP_SHA>.json","<STOP_SHA>"]}`
- 확인: `{"executable":"/usr/bin/stat","args":["-c","%u %g %a %s %n","/var/lib/nmv-admin-models-root/results/<STOP_SHA>.json"]}` → `0 0 644 …`
- 응답이 불명확하면 같은 argv를 다시 실행해도 기록된 시도를 읽어 확인만 하고 stop을 다시 보내지 않는다. 결과가 없으면 계속 막힌 상태로 둔다.

### S12. run → 해제 → restore 대기
- 명령: S10과 같다
- 성공(기대 정지): exit 1, `status:"manual"`, `step:"restore"`, `code:"supa_root_result_required"`. 그 사이 runner가 root 결과·cgroup 비어 있음·원 PID 부재를 다시 읽고 V1 release를 **바로 apply**했다(`operator.ts:176`, 별도 dry-run 단계 없음). 그다음 provider 복원 차례에서 멈춘 것이다. 다른 위치에서 blocked면 DRAIN이 유지되므로 code를 보고 같은 run으로 이어간다.

### S13. root restore (device_admin, supa)
- argv: handoff 파일 restore 줄 그대로(`…/nmv-supa-root-<RESTORE_SHA>.json`, `<RESTORE_SHA>`). 결과 파일 stat은 S11과 같은 방법으로 확인한다.

### S14. run → 완료
- 명령: S10과 같다
- 성공: exit 0, `status:"completed"`. runner가 gateway와 owner를 역순으로 복원하고, 원래 설정 hash와 새 incarnation health를 확인한 뒤 **OPEN 대신 `handoff`**(자기 DRAIN 핀이 그대로임을 확인하고 감사 기록)로 끝낸다. readback으로 요청 `withdrawn`(terminal kind `provider_boundary_exit`), capacity **`draining`**(인계 값), Supa 새 invocation을 확인한다. 이어서 A절(D1·D3~D9)로 간다. `affectedGroups` 밖의 M1 미확인은 그대로 보존된다.

---

## 실행하지 않은 것과 검증

- 원격 명령, 운영 DB 읽기·쓰기, 0143/0144, DRAIN, 배포, M1/Supa 장비 접근은 0이다. 운영 수치는 이번에 새로 측정하지 않았다.
- 로컬 검증: `tests/release-29877f65.test.ts` 7건(실제 공개 원문으로 `0507685d`와 `81d1f571`을 재현한다. 합성 근거로 만든 plan/receipt가 정식 CLI 파서 `readReplacedProviderBoundaryReleaseFiles`와 증거 predicate를 통과한다. OPEN·종료 순서·ms 불일치·재시작된 relay·Qwen 잔존·이전 task·plan 이전 수집은 거절한다). `tests/release-65f8c399-manifest.test.ts`(Python 3건: adapter identity AST 동일, manifest·profile·helper 해시 결속, 잘못된 폴더·다중 컨테이너 거절). 기존 PR721 시험 2파일과 ops-runner adapter/root-handoff 시험도 함께 PASS. `bash -n` 3개 스크립트, `next typegen` 뒤 `tsc --noEmit` exit 0, 변경 TS ESLint 0.
- `collect-docker.sh`는 가짜 docker CLI로 실행했다. 묶음 구조와 sha 자기 보고가 일치함을 확인했고, 잘못된 host 인자는 exit 2로 거절했다. `collect-m1.sh`는 macOS 전용이라 내장 Python 문법 검사만 했다. 실제 M1·m3·mini에서는 실행하지 않았다.
