# 경로 교체 해제(replaced-path) — 미확인 3건 실행서 (2026-10-29)

정식 서비스 전 단계라서 미확인 해제를 단순화한다(JR 지시, 2026-10-29).

미확인 요청이 지나간 경로를 hop 단위로 읽는다. 다음 조건을 모두 만족하면 옛 호출은 어디에서도 살아 있을 수 없으므로, 그 요청의 점유만 푼다(`withdrawn`). 사용량, 모델 종료, 업무 결과는 만들지 않는다.

| hop | 허용 상태 | 이유 |
| --- | --- | --- |
| owner | **replaced**: dispatch 뒤에 시작한 단일 인스턴스 | 토큰을 쥐고 다시 보낼 수 있는 것은 owner뿐이다 |
| gateway·relay | **replaced**, 또는 **absent**(프로세스 없음, dispatch **뒤** 관측. 0146) | 중계는 옛 호출을 재시도할 수 있다 |
| 엔진(provider) | **replaced**, 또는 **idle** | idle은 실행 0·대기 0을 관측한 것이다. 위의 모든 hop이 교체·부재가 된 시각보다 **엄격히 뒤**에 관측해야 한다. 그러면 다시 보낼 주체가 없으니 유휴인 엔진은 옛 호출을 돌리고 있지 않다 |

- 코드:
  - 계약·경로 등록표: `lib/llm/replaced-path-boundary-contract.ts`
  - DB가 다시 검사하는 권한: `drizzle/0145_replaced_path_boundary_exit.sql`
  - 해제: `lib/operations/dr/replaced-path-boundary-release.ts`
  - 수집·CLI: `scripts/ops/replaced-path/{collect_hop.py,release-cli.ts}`
- 경로 등록표(owner·gateway·엔진 목록)는 TS와 0145 SQL에 고정한다.
- 장비별 읽기 방법(유휴 카운터를 읽는 곳, 부재 허용 여부)은 `REPLACED_PATH_PROBES`에 둔다. 판정 권한은 아니다.
- 기존 경로와의 관계:
  - 0143(M1 전용 교체 경계), provider boundary V1~V4, CLI 경계는 그대로 둔다.
  - 0145는 CHECK에 분기를 하나 덧붙인다.
  - ops-runner B절(Supa 단건)은 더 쓰지 않는다. 쓰면 같은 reviewer와 gateway를 공유하는 `19b7a1df`가 영구히 남는다.

## 1. 왜 한 DRAIN에서 3건을 모두 푸나

- OPEN하면 epoch가 오른다.
- 새 세대에서 이전 세대의 진행 중 요청이 하나라도 남아 있으면, 모든 새 호출이 `policy_changed`로 보류된다(`capacity-repository.ts`의 `compatibleModelCapacityGeneration`).
- 그래서 남은 미확인 3건은 **같은 DRAIN 안에서 모두 해제한 뒤에** OPEN한다. 한도·경로 정책 변경도 그 창 안에서 한다.

| 요청 | budget · owner | 경로(hop 순서) | 이번 근거(예정) |
| --- | --- | --- | --- |
| `65f8c399-ff4b-47bc-8f4d-6e4a682cf6a7` | `abcllm-supa` · m3-reviewer | reviewer → gateway-m3 → gateway-mini → supa `vllm.service` | reviewer·gateway는 재시작(replaced), vllm은 **idle**(재시작하지 않는다) |
| `19b7a1df-7efd-492a-bdaf-bdb785e9cbda` | `abcllm-m3-mlx` · m3-reviewer | reviewer → gateway-m3 → gateway-mini → m3ultra `gui/501/com.jr.deepseek` | 위와 같고, omlx는 **idle**(재시작하지 않는다) |
| `29877f65-9f95-4efb-88f9-aea5f39a28b2` | `abcllm-m1-qwen` · m3-text | text → gateway-m3 → gateway-mini → m1 relay → m1 엔진 `tcp:127.0.0.1:8000` | text·gateway는 이미 replaced. relay는 replaced 또는 absent. 엔진은 replaced(허브 읽기) |

hop 읽기 규칙:
- 서비스의 **가장 오래된 프로세스** 시작 시각을 내림 처리해서 쓴다(컨테이너는 ms, 나머지는 초).
- 인스턴스가 하나뿐인지 본다.
  - 컨테이너: 실행 컨테이너 1개, 실행 task 1개
  - launchd·listener: 같은 프로그램이 작업 밖에 없어야 한다
  - systemd: 단위 cgroup 전체를 본다
- 유휴 카운터:
  - vllm: `/metrics`의 `num_requests_running`·`num_requests_waiting` 합계
  - omlx: `/api/status`의 `active_requests`·`waiting_requests`
  - 토큰은 장비 밖으로 나가지 않는다.

plan은 살아 있는 행과 DRAIN을 고정하므로 60분 안에 써야 한다. 교체·부재 관측은 한 번 확인되면 바뀌지 않으므로 plan보다 먼저 읽어도 되고, 24시간 안이면 쓴다.

## 2. 사전 단계 (OPEN 유지)

1. **[승인] 0143·0144·0145 적용:**
   - 정식 migration 절차로 적용한다. 0145는 0143이 없으면 `replaced_path_predecessor_0143_missing`으로 스스로 멈춘다.
   - 적용 뒤 `SELECT count(*) FROM drizzle.__drizzle_migrations`가 저널 항목 수(146)와 같아야 한다.
2. **리허설(읽기 전용):** `node --import tsx scripts/ops/replaced-path/release-cli.ts probe --owner=<owner> --budget=<budget>`를 세 경로에 대해 돌린다.
   - 2026-10-29 15:2xZ 실측:
     - reviewer는 01:05:32, gateway-m3는 01:05:21, gateway-mini는 01:05:16에 시작했다(교체 필요).
     - supa vllm과 omlx는 `idle: true`였다.
     - text(14:55)와 두 gateway는 M1 요청(10-28 13:58)보다 뒤에 시작했다.
3. **M1 hop 읽기(허브, device_admin, 읽기 전용):**
   - `/home/ubuntu/nmv-replaced-path-ops/m1-hop-{relay,provider}.argv.json`을 실행한다.
   - stdout JSON들을 배열 하나로 모아 `bundle-m1.json`(0600)으로 저장한다.
   - 둘 다 10-28 13:58:16.331Z 뒤에 시작했으면 끝이다.
   - relay를 없앨 거라면 정지해도 된다. 정지 뒤 다시 읽으면 `absent`가 된다.
4. **[승인] gateway 두 곳 재시작:**
   - 지금 gateway를 거치는 그룹(supa·m3-mlx·m1)은 모두 미확인에 막혀 있어서 나가는 호출이 없다. 직전에 이 그룹들의 `dispatched`/`reserved`가 0인지 확인한다.
   - m3ultra와 9mini에서 각각 `docker service update --force <서비스>`(spec 유지)를 실행하고 health를 확인한다.

## 3. DRAIN 창

1. **[승인] DRAIN:** 유지보수 컨테이너의 스테이징 소스로 `in-container.sh drain <epoch> <revision> <operator> <reason>`를 먼저 dry-run하고, 이상이 없으면 `--execute`를 붙여 실행한다. 이어서 `dispatched`/`reserved`가 미확인 3건 밖에 0건인지 READ ONLY로 확인한다.
2. **reviewer 재시작:** `docker service update --force app-copy-primary-hard-drive-b5fhzd`. DRAIN 안이라 진행 중 호출이 없으니 새 미확인이 생기지 않는다.
3. **요청마다 plan → collect → receipt:**
   ```sh
   C="node --import tsx scripts/ops/replaced-path/release-cli.ts"; D=$HOME/nmv-replaced-path-<요청 앞 8자>; mkdir -m 700 -p "$D"
   $C plan --request-id=<요청> --reference="<사유>" --out="$D/plan.json" --database-url-stdin <<< "$DIRECT_URL"
   $C collect --plan="$D/plan.json" --out="$D/bundle.json" --skip-host=m1studio
   $C receipt --plan="$D/plan.json" --bundle="$D/bundle.json[,bundle-m1.json]" --artifact-dir="$D/artifacts" --out="$D/receipt.json"
   ```
   - Supa와 MLX는 reviewer 재시작 **뒤에** collect한다. 그래야 엔진 idle 관측이 모든 앞단 교체보다 뒤가 된다.
   - 성공 조건: receipt가 `replaced_path_hops_not_replaced_after_dispatch` 없이 `receiptSha`를 낸다.
4. **해제:** 먼저 dry-run(전체 쓰기 뒤 ROLLBACK)을 하고, 결과가 `released`면 `--apply`를 붙여 실제로 해제한다.
   ```sh
   $C release --plan="$D/plan.json" --plan-sha=<sha> --receipt="$D/receipt.json" --receipt-sha=<sha> --artifact-dir="$D/artifacts" \
     --operator=<OP> --reference="<plan과 같은 사유>" --database-url-stdin [--apply] <<< "$DIRECT_URL"
   ```
   - 성공 조건: `released`와 `auditId`가 나오고, 그 행이 `withdrawn`, `settled_at NULL`이며, `dispatch_released` 이벤트가 1건 생긴다.
   - 같은 명령을 다시 실행하면 `already_released`가 나온다.
5. **정책 변경:** 미확인이 0건인지 확인한 뒤 `pipeline-control capacity policy`로 바꾼다. 안은 `/home/ubuntu/nmv-replaced-path-ops/policy-rev8.draft.json`이고, 199a3ebb와 새 코드 양쪽 스키마에서 통과한다.
   - 한도:

     | 대상 | 한도 |
     | --- | --- |
     | supa·gpu3090 | 4 |
     | m1 | 2 |
     | CLI | 2 |
     | m3-mlx | 1 (env 물리 한도 1) |
     | reviewer 풀 | 10 |
     | text 풀 | 6 |
     | 전역 | 15 |

   - 추가 경로: `[gpu3090]` 1차 경로, M1 Gemma 번역 경로
6. **[승인] OPEN:** `capacity-control.sh open`. deferred route가 0이어야 열린다.
   - 판정은 지금 실행 중인 코드와 같은 199a3ebb 소스로 한다. 번역 기본값이 MLX라서 env에 모델을 고정하지 않아도 된다.

## 4. 실패하면

- DB가 거절하면 아무것도 쓰지 않는다(`replaced_path_transition_conflict`, `replaced_path_boundary_records_mismatch`). DRAIN을 유지한 채 원인을 본다.
- 엔진이 idle이 아니면(다른 호출이 돌고 있으면) 끝날 때까지 기다렸다가 다시 collect한다. 재시작은 마지막 수단이다.
- plan은 행 해시와 DRAIN을 고정한다. 그사이 행이나 control이 바뀌었으면 plan부터 다시 만든다.
- 응답이 불명확하면 같은 apply를 다시 실행한다. 이미 풀렸으면 `already_released`가 나오고, 두 번 풀리지 않는다.
- 3건 중 하나라도 남으면 OPEN하지 않는다(1절).

## 5. 이 변경의 검증 (작업자, 2026-10-29)

- 단위 시험: `tests/replaced-path-boundary.test.ts`(51), `tests/replaced-path-cli.test.ts`(4) 통과.
  - replaced, idle, absent 허용·거절 경우를 모두 넣었다. 예: idle 관측이 앞단보다 앞서거나 같은 시각이면 거절한다.
  - 0145 SQL이 계약에서 생성한 값과 같음을 고정한다.
- 수집기 시험: `python3 -B -m unittest discover -s tests -p 'test_release_replaced_path*.py'` 12건 통과.
  - 부재 허용·거절, omlx·vllm 유휴 카운터를 시험한다. omlx 토큰이 결과에 없음도 확인한다.
- 실제 PG17(pgvector 0.8.6) 일회용 DB 통합 시험: `replaced-path-boundary-release`(6)와 경계·해제 회귀를 합쳐 통과.
  - 0145 분기에 맞춰, 최종 CHECK 정의를 고정한 시험 3건의 기대값에 0145 분기를 추가했다.
- `tsc --noEmit` exit 0, 변경 파일 ESLint 0.
- 운영 접근: 읽기 전용 `probe`(SSH)와 omlx·vllm 상태 GET만 실행했다. DB 쓰기, migration, DRAIN, 재시작, 해제는 0이다.

## 6. 실행 기록 (2026-10-29 UTC, 실제 영수증)

- 사전 단계: 0143·0144·0145 적용(143→146건). gateway 두 곳 재시작(m3 16:07:23, mini 16:07:31). 허브가 M1 relay를 `disable`·`bootout`(종료 코드 0, 16:02) 하고 relay `absent`, 엔진 `omlx-server` pid 15664(10-28 23:39:06 시작)를 읽었다.
- DRAIN 16:12:33(epoch 1, revision 7). reviewer 재시작 16:12:57.
- 해제(`replaced_path_boundary_exit`, 모두 dry-run `released` 뒤 apply):

  | 요청 | 감사 | 근거 |
  | --- | --- | --- |
  | `65f8c399` | 20964 | supa vllm **idle** |
  | `19b7a1df` | 20966 | M3 omlx **idle** |
  | `29877f65` | 20968 | relay absent, M1 엔진 replaced |

  세 행 모두 `withdrawn`, `settled_at NULL`, `dispatch_released` 이벤트 1건씩 남았다.
- 정책 revision 8(`f8223e79…`). OPEN 16:16:30. 미서빙 경로는 0/40이었다.
- **새 미확인 2건:** `a465f729`, `1c2a4a62`(product-translate `[m1] qwen3.8-flash-next`, 16:16:41·16:16:58).
  - 원인: relay를 끈 뒤 OPEN 전에 상품 번역을 멈추지 않았다.
  - m1-qwen 한도(2)를 이 두 건이 채워 그 뒤 M1 dispatch는 없다.
  - 다음 DRAIN에서 같은 방법으로 푼다: text·gateway 재시작, relay absent 재관측, M1 엔진 재시작 또는 idle.
- 0146: 위 점검 중 absent 관측 시각 조건이 빠진 것을 찾아 막았다. 이번 세 건은 relay absent 관측(10-29 16:02)이 dispatch(10-28)보다 뒤라 유효하다.
