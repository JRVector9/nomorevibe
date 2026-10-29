# 경로 교체 해제(replaced-path) — 미확인 3건 실행서 (2026-10-29)

정식 서비스 전 단계라서 미확인 해제를 단순화한다(JR 지시, 2026-10-29). 미확인 요청이 지나간 **경로의 모든 프로세스**(owner, 두 gateway, provider)가 dispatch 뒤에 새로 시작된 단일 인스턴스임을 읽어서 확인하면, 옛 호출은 어디에서도 살아 있을 수 없다. 이 사실로 그 요청의 점유만 푼다(`withdrawn`). 사용량, 모델 종료, 업무 결과는 만들지 않는다.

- 코드: `lib/llm/replaced-path-boundary-contract.ts`(계약·경로 등록표), `drizzle/0145_replaced_path_boundary_exit.sql`(DB가 다시 검사하는 권한), `lib/operations/dr/replaced-path-boundary-release.ts`, `scripts/ops/replaced-path/{collect_hop.py,release-cli.ts}`.
- 기존 경로와의 관계:
  - 0143(M1 전용 교체 경계)과 provider boundary V1~V4, CLI 경계는 그대로 둔다.
  - 0145는 CHECK에 분기를 하나 덧붙인다.
  - ops-runner B절(Supa 단건)은 더 쓰지 않는다. 쓰면 같은 reviewer와 gateway를 공유하는 `19b7a1df`가 영구히 남는다.

## 1. 왜 한 DRAIN에서 3건을 모두 푸나

- OPEN하면 epoch가 오른다.
- 새 세대에서 이전 세대의 진행 중 요청이 하나라도 남아 있으면, 모든 새 호출이 `policy_changed`로 보류된다(`capacity-repository.ts`의 `compatibleModelCapacityGeneration`).
- 그래서 남은 미확인 3건은 **같은 DRAIN 안에서 모두 해제한 뒤에** OPEN한다. 한도·경로 정책 변경도 그 창 안에서 한다.

| 요청 | route · budget | owner | 경로(hop 순서) |
| --- | --- | --- | --- |
| `65f8c399-ff4b-47bc-8f4d-6e4a682cf6a7` | crawl-agent-review · `abcllm-supa` | m3-reviewer | reviewer 컨테이너 → gateway-m3 → gateway-mini → supa `vllm.service` |
| `19b7a1df-7efd-492a-bdaf-bdb785e9cbda` | crawl-agent-review · `abcllm-m3-mlx` | m3-reviewer | reviewer 컨테이너 → gateway-m3 → gateway-mini → m3ultra `gui/501/com.jr.deepseek`(omlx-server) |
| `29877f65-9f95-4efb-88f9-aea5f39a28b2` | product-translate · `abcllm-m1-qwen` | m3-text | text 컨테이너 → gateway-m3 → gateway-mini → m1 relay `system/bot.brut.nmv-llm-relay` → m1 엔진 `tcp:127.0.0.1:8000` |

hop마다 판정하는 것:
- 서비스의 **가장 오래된 프로세스** 시작 시각이 dispatch보다 뒤여야 한다. 내림 처리한다(컨테이너는 ms, 나머지는 초). 그래서 dispatch 전부터 살아남은 프로세스가 더 새것처럼 보일 수 없다.
- 인스턴스가 하나뿐이어야 한다.
  - 컨테이너: 실행 컨테이너 1개, 실행 task 1개
  - launchd·listener: 같은 프로그램이 작업 밖에 없어야 한다
  - systemd: 단위 cgroup 전체를 본다

plan은 살아 있는 행과 DRAIN을 고정하므로 60분 안에 써야 한다. 교체 관측은 한 번 확인되면 바뀌지 않으므로 plan보다 먼저 읽어도 되고, 24시간 안이면 쓴다.

## 2. 사전 단계 (OPEN 유지)

1. **[승인] 0143·0144·0145 적용:**
   - 정식 migration 절차로 적용한다. 0145는 0143이 없으면 `replaced_path_predecessor_0143_missing`으로 스스로 멈춘다.
   - 적용 뒤 `SELECT count(*) FROM drizzle.__drizzle_migrations`가 저널 항목 수(146)와 같아야 한다.
2. **경로 리허설(읽기 전용, 쓰기 0):**
   ```sh
   cd <main checkout>
   node --import tsx scripts/ops/replaced-path/release-cli.ts probe --owner=m3-reviewer --budget=abcllm-supa
   node --import tsx scripts/ops/replaced-path/release-cli.ts probe --owner=m3-reviewer --budget=abcllm-m3-mlx
   node --import tsx scripts/ops/replaced-path/release-cli.ts probe --owner=m3-text --budget=abcllm-m1-qwen
   ```
   - 성공 조건: 모든 hop이 `singleInstance: true`다.
   - 2026-10-29 14:58Z 실측: reviewer는 01:05:32, gateway-m3는 01:05:21, gateway-mini는 01:05:16, supa vllm은 01:04:45, omlx는 01:07:26에 시작했다. 앞의 두 요청 dispatch보다 이르므로 교체가 필요하다.
   - text는 14:55에 시작했고 두 gateway도 10-28 13:58 뒤에 시작했다. 그래서 M1 요청은 relay와 엔진만 확인하면 된다.
3. **M1 hop 수집(허브, device_admin, 읽기 전용):**
   - `probe --owner=m3-text --budget=abcllm-m1-qwen`의 `manual`에 나온 hop마다, `collect`가 출력하는 argv를 m1studio에서 실행한다.
   - stdout JSON(`{"hop":…,"artifact":…}`)을 배열 하나로 모아 `bundle-m1.json`(0600)으로 저장한다.
   - relay와 엔진 둘 다 10-28 13:58:16.331Z 뒤에 시작했어야 한다. 아니면 그 프로세스를 재시작한 뒤 다시 읽는다.
4. **유휴 장비 재시작:**
   - 대상: gateway 두 곳, M3 omlx, supa vllm.
   - 지금 supa, m3-mlx, m1 그룹이 모두 미확인에 막혀 있어서 gateway와 이 엔진들로 나가는 호출이 없다.
   - 재시작 직전에 그 그룹의 `dispatched`/`reserved`가 0인지 READ ONLY로 확인한다.
   - gateway: `docker service update --force <서비스>`(spec 유지, m3ultra·9mini 각각)
   - omlx: `launchctl kickstart -k gui/501/com.jr.deepseek`(jr)
   - supa: `systemctl restart vllm.service`(root, JR·대표)
   - 재시작 뒤 각 health를 확인한다.

## 3. DRAIN 창

1. **[승인] DRAIN:** 유지보수 컨테이너의 스테이징 소스로 `in-container.sh drain <epoch> <revision> <operator> <reason>`를 먼저 dry-run하고, 이상이 없으면 `--execute`를 붙여 실행한다. 이어서 `dispatched`/`reserved`가 미확인 3건 밖에 0건인지 READ ONLY로 확인한다.
2. **reviewer 재시작:** `docker service update --force app-copy-primary-hard-drive-b5fhzd`. DRAIN 안이라 진행 중 호출이 없으니 새 미확인이 생기지 않는다.
3. **수집 → plan → receipt (요청마다):**
   ```sh
   C=node\ --import\ tsx\ scripts/ops/replaced-path/release-cli.ts; D=$HOME/nmv-replaced-path-<요청 앞 8자>; mkdir -m 700 -p "$D"
   $C plan --request-id=<요청> --reference="<사유>" --out="$D/plan.json" --database-url-stdin <<< "$DIRECT_URL"
   $C collect --plan="$D/plan.json" --out="$D/bundle.json" --skip-host=m1studio      # M1 요청은 bundle-m1.json을 추가로 쓴다
   $C receipt --plan="$D/plan.json" --bundle="$D/bundle.json[,bundle-m1.json]" --artifact-dir="$D/artifacts" --out="$D/receipt.json"
   ```
   - 성공 조건: `receipt`가 `replaced_path_hops_not_replaced_after_dispatch` 없이 `receiptSha`를 낸다.
4. **해제:** 먼저 dry-run(전체 쓰기 뒤 ROLLBACK)을 하고, 결과가 `released`면 `--apply`를 붙여 실제로 해제한다.
   ```sh
   $C release --plan="$D/plan.json" --plan-sha=<sha> --receipt="$D/receipt.json" --receipt-sha=<sha> --artifact-dir="$D/artifacts" \
     --operator=<OP> --reference="<plan과 같은 사유>" --database-url-stdin [--apply] <<< "$DIRECT_URL"
   ```
   - 성공 조건: `{"result":{"kind":"released","auditId":…}}`가 나오고, 그 행이 `withdrawn`, `settled_at NULL`이며, `dispatch_released` 이벤트가 1건 생긴다.
   - 같은 명령을 다시 실행하면 `already_released`가 나온다.
5. **정책 변경(선택, 같은 창):** 미확인이 0건인지 확인한 뒤 `pipeline-control capacity policy`로 바꾼다(한도 2, `[gpu3090]` 1차 경로 등).
6. **[승인] OPEN:** `capacity-control.sh open`. deferred route가 0이어야 열린다.

## 4. 실패하면

- DB가 거절하면 아무것도 쓰지 않는다(`replaced_path_transition_conflict`, `replaced_path_boundary_records_mismatch`). DRAIN을 유지한 채 원인을 본다.
- plan은 행 해시와 DRAIN을 고정한다. 그사이 행이나 control이 바뀌었으면 plan부터 다시 만든다.
- 응답이 불명확하면 같은 apply를 다시 실행한다. 이미 풀렸으면 `already_released`가 나오고, 두 번 풀리지 않는다.
- 3건 중 하나라도 남으면 OPEN하지 않는다(1절).

## 5. 이 변경의 검증 (작업자, 2026-10-29)

- 단위 시험: `tests/replaced-path-boundary.test.ts`(39), `tests/replaced-path-cli.test.ts`(3), `tests/replaced-provider-boundary.test.ts`(회귀) 통과. 0145 SQL이 계약에서 생성한 값과 같음을 고정한다.
- 수집기 시험: `python3 -B -m unittest discover -s tests -p 'test_release_replaced_path*.py'` 8건 통과. 외부 명령은 모두 가짜로 바꿨다.
- 실제 PG17(pgvector 0.8.6) 일회용 DB 통합 시험: `replaced-path-boundary-release`(6)와 경계·해제 회귀 12파일을 합쳐 **76건 통과**.
  - 0145가 덧붙인 분기에 맞춰, 최종 CHECK 정의를 고정한 시험 3건(`gateway-not-started-ledger`, `cli-executor-removed-*`, `cli-executor-indeterminate-*`)의 기대값에 0145 분기를 추가했다.
- `tsc --noEmit` exit 0, 변경 파일 ESLint 0.
- 운영 접근: 2절 2번의 `probe`(읽기 전용 SSH)만 실행했다. DB 쓰기, migration, DRAIN, 재시작, 해제는 0이다.
