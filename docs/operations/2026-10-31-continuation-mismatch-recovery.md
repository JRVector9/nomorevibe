# 2026-10-31 search-verify·crawl-tagline·crawl-agent-review 성공 기록 멈춤 — 원인·회복·확인 SQL

대상 판: main 62e46256(운영) → 이 문서의 PR. 운영 명령·DB 쓰기는 이 문서에 없다. 아래 SQL은 모두 `SELECT`이고
`BEGIN READ ONLY; … ROLLBACK;` 안에서 실행한다.

## 원인

| 잡 | 현상 | 원인(코드) | 재현 시험 |
|---|---|---|---|
| product-search-verify | 01:27Z 뒤로 매 틱 `search_verify_continuation_mismatch`, 새 요청 행 0 | #747(0149)부터 연결 거부·DNS 실패처럼 **요청 바이트 0** 이 증명된 호출을 `settled` + `gateway_not_started` 증거로 정산한다. `searchVerifyGeneration` 은 세대 안의 settled 행이 모두 search-verify 응답 증거라고 가정해, 이 행 하나로 세대 전체를 불일치로 던졌다. writer 도 이 꼬리를 받지 못해 실패를 적지 못했다 → 세대(프로필 행)가 바뀌지 않아 다음 틱에 같은 제품을 다시 집고 다시 던졌다. | `tests/integration/search-verify-capacity-dispatch.test.ts` "2026-10-31 repro: a not_started step among withdrawn permits and a reviewed unknown …", "records a live not_started failure once …" |
| crawl-tagline | 01:28Z 뒤로 매 틱 `crawl_tagline_continuation_mismatch`, 새 요청 행 0 | 같은 원인. `readCrawlTaglineContinuation` 이 not_started ask 를 불일치로 던졌고, 그 틱의 writer(`recordReservedCrawlTagline`)도 settled 행을 응답 증거로만 읽어 실패를 적지 못했다(stored:false). 같은 단계는 단계 고유 색인(`model_capacity_requests_crawl_tagline_phase_idx`) 때문에 그 세대에서 다시 보낼 수도 없다. | `tests/integration/crawl-tagline-capacity-dispatch.test.ts` "2026-10-31 repro: a not_started ask …", "records a live not_started failure in the same tick …" |
| crawl-agent-review | 01:26Z 뒤로 `last_success_at` 고정, `last_error` 없음, 처리는 계속(60분 settled 1,137) | 1차 심사 풀에서 모델 하나라도 멈추면(포화·실패·미매핑) 틱이 `deferred: model_capacity` 로 끝났다. 러너는 미룸을 "일을 인정하지 않음"으로 보고 성공 시각을 옮기지 않는다 — 다른 모델이 심사를 남겨도 마찬가지였다. 같은 시각의 엔진 거부·배포 재시작이 그 "모델 하나 멈춤"의 계기로 보인다(운영 로그 미확인). | `tests/agent-review-reservation-wait.test.ts` "does not wait on a model whose physical slots are all unknown-occupied; the other model keeps working", "true saturation …", `tests/agent-review-job.test.ts` 세 시험(기대값을 deferred → 완료로 바꿈) |

공통 원인이 하나는 아니다. search-verify·crawl-tagline 은 같은 결함(0149 not_started 행을 장부 사슬이 모름)이고, crawl-agent-review 는
결과 분류 결함이다. 같은 사건(01:24~01:27Z 엔진 거부·재시작)에서 함께 드러나 한 PR로 묶었다. withdrawn 행(대기·예약 취소)과
검토 완료로 닫은 미확인 행은 세 경로 모두 사슬 조회(`dispatched|indeterminate|settled`)에 들어오지 않아 원인이 아니다 — 재현 시험이
그 둘을 같이 만들고도 고친 코드에서 통과하는 것으로 확인한다.

## 고친 것

- search-verify: 세대를 execution 별로 따로 본다. not_started 꼬리나 깨진 사슬을 가진 execution 은 **닫힌 것**으로 보고 이어 쓰지 않으며,
  다음 틱은 그 뒤 번호로 새 execution 을 시작한다(같은 단계 ID 를 다시 보내지 않는다). writer 는 not_started 꼬리를 미확인 꼬리와 같게
  받아 실패(`network` 등)를 적는다. 실행 번호조차 읽을 수 없는 행이 있으면 그 제품만 `ledger_mismatch` 로 넘기고 잡은 계속한다.
- crawl-tagline: 리더가 not_started 단계를 `notStarted` 로 돌려준다. 그 세대는 실패 한 번(`error_code='not_started'`, 시도 +1,
  기존 5분×2^n 재시도)으로 닫고, 다음 틱은 새 세대(캐시 행이 바뀜)로 묻는다. 같은 틱의 live 실패도 이제 적힌다. 나머지 불일치는
  그 후보만 `ledger_mismatch`(이 후보만의 미룸)로 넘긴다.
- crawl-agent-review: 심사를 하나라도 남긴 틱은 완료 틱이다. 모델 하나만 멈췄으면 `continuation: ready`(곧바로 다음 틱), 전역 미룸이면
  `done:false`(완료로 적고 scheduler 를 기다림). 아무것도 남기지 못한 틱은 예전처럼 미룸이다.
- product-search-profile(55P03): 아래 절.

중복 발송·이중 저장: not_started 는 요청 바이트 0 의 증명이고, 같은 (세대, 실행, 단계)·(세대, ask) 는 DB 고유 색인이 한 번만 허용한다.
재현 시험이 POST 수(서버가 받은 본문 수)와 장부 행을 세어 닫힌 단계가 다시 나가지 않고 제품·후보가 한 번만 적히는 것을 확인한다.

## 운영 데이터 손질 — 필요 없음

배포만으로 풀린다. 근거:

- search-verify: 막힌 세대의 마지막 execution 은 not_started 꼬리로 닫힌 것으로 읽히고, 다음 틱이 새 execution 으로 처음부터 보낸다
  (재현 시험 1이 바로 이 운영 모양 — withdrawn 행·검토 완료 미확인·not_started 행이 있는 세대 — 에서 출발한다).
- crawl-tagline: 막힌 세대는 다음 틱에 `not_started` 실패 한 번으로 정식 writer 가 닫는다(시도 +1). 시도가 이미 4회였던 후보는
  5회가 되어 자동 재시도에서 빠진다 — 이것은 기존 규칙(MAX_ATTEMPTS=5)이고 사람 검토 대기로 남는다(아래 ③으로 센다).
- withdrawn 행·검토 완료 행은 손대지 않는다. DB 직접 UPDATE·관문 면제는 하지 않는다.

## 확인 SQL (READ ONLY, 배포 전·후)

① 경로별 not_started 정산 행

```sql
SELECT route_id, count(*) AS n, min(settled_at) AS first_at, max(settled_at) AS last_at
FROM model_capacity_requests
WHERE state = 'settled' AND terminal_evidence->>'kind' = 'gateway_not_started'
GROUP BY route_id ORDER BY route_id;
```

② search-verify: not_started 가 걸린 제품과 그 뒤 기록(배포 뒤 `updated_at > settled_at` 이거나 `verified_at` 이 생겨야 한다)

```sql
SELECT r.request_id, r.settled_at, (r.dispatch_binding->'member'->>'productId')::int AS product_id,
  r.dispatch_binding->'execution' AS execution, p.verify_error, p.verified_at, p.updated_at
FROM model_capacity_requests r
LEFT JOIN product_search_profiles p ON p.product_id = (r.dispatch_binding->'member'->>'productId')::int
WHERE r.route_id = 'product-search-verify' AND r.state = 'settled' AND r.terminal_evidence->>'kind' = 'gateway_not_started'
ORDER BY r.settled_at;
```

③ crawl-tagline: not_started 가 걸린 후보와 캐시(배포 뒤 `error_code='not_started'`, `updated_at > settled_at`; `attempts >= 5` 는 사람 검토로 남은 것)

```sql
SELECT r.request_id, r.settled_at, r.dispatch_binding->'askOrdinal' AS ask,
  r.dispatch_binding->'member'->>'repo' AS repo, c.state AS candidate_state,
  t.attempts, t.error_code, t.retry_at, t.updated_at
FROM model_capacity_requests r
LEFT JOIN crawl_candidates c ON c.id = (r.dispatch_binding->'member'->>'candidateId')::int
LEFT JOIN crawl_taglines t ON t.repo = r.dispatch_binding->'member'->>'repo'
WHERE r.route_id = 'crawl-tagline' AND r.state = 'settled' AND r.terminal_evidence->>'kind' = 'gateway_not_started'
ORDER BY r.settled_at;
```

④ 잡 상태(배포 뒤 몇 분 안에 세 잡의 `last_success_at` 이 움직이고 `last_error` 가 비어야 한다)

```sql
SELECT name, last_run_at, last_success_at, last_error
FROM jobs
WHERE name IN ('crawl-agent-review', 'product-search-verify', 'crawl-tagline', 'product-search-profile')
ORDER BY name;
```

⑤ 같은 단계가 두 번 나가지 않았는지(고유 색인이 막으므로 0행이어야 한다)

```sql
SELECT route_id, dispatch_binding->>'generationHash' AS generation, dispatch_binding->'execution' AS execution,
  coalesce(dispatch_binding->'step', dispatch_binding->'askOrdinal') AS step, count(*) AS n
FROM model_capacity_requests
WHERE route_id IN ('product-search-verify', 'crawl-tagline') AND state IN ('dispatched', 'indeterminate', 'settled')
  AND dispatched_at > timestamp '2026-10-31 00:00'
GROUP BY 1, 2, 3, 4 HAVING count(*) > 1;
```

⑥ 배포 뒤 새 not_started 가 이어서 생기면 엔진이 다시 거부하는 것이다 — ①의 `last_at` 과 text 워커의 엔진 연결 상태를 같이 본다.

## product-search-profile 55P03 (10-29 15:49Z 부터)

- lock_timeout: text 워커는 `DB_LOCK_TIMEOUT_MS` 없으면 `min(5000, statement 60000)` = **5초**(`lib/db/pool.ts:52`, 연결 옵션). pgbouncer 모드는
  `ALTER ROLE … lock_timeout='5s'`. 이 경로에 `SET LOCAL` 은 없다.
- 실패한 문장: 매 틱 첫 잠금 문장이 `pendingProfiles` → `findOwnPendingTextProfileRequests` 의 `model_capacity_control … FOR SHARE` 다.
  같은 SQL 문은 `findOwnPendingModelRequest`·`lockModelCapacityCallerControl` 에도 있어 오류 글만으로는 셋을 가를 수 없다.
- 코드 안의 결정적 교착(같은 틱이 다른 연결로 자기 잠금을 기다림)은 찾지 못했다. 55P03 은 다른 TX 가 control 을 **FOR UPDATE 로 5초 넘게**
  쥐었다는 뜻이다. 후보(코드 읽기, 운영 미확인): 각 경로의 `lock*ModelCapacityDispatch` TX(control FOR UPDATE 뒤 역할·제품·잡 잠금을 각 5초까지
  기다림), `requestSlot`(만료 정리·fence·grant 스캔, 장부 표는 지우지 않아 계속 자란다).
- 이번 PR: (a) `findOwnPendingTextProfileRequests` 는 우선순위 메타데이터라 control 을 잠그지 않고 읽는다(결과는 coordinator 가 잠근 뒤 다시 확인).
  (b) 한 일꾼의 55P03 이 `controller.abort()` 로 옆 일꾼의 보내진 호출을 끊지 않게 했다(끊긴 호출은 미확인 행이 됐다). 틱은 여전히 그 오류로
  끝나 `last_error` 에 남는다. (c) 55P03 뒤 control 을 쥔 세션(pid·application_name·TX 나이·대기)을 `search_profile.lock_timeout_holders` 로그에
  한 번 남긴다.
- 원인 holder 는 배포 뒤 위 로그 또는 아래 ⑦로 확정한다. 다른 FOR SHARE(항목마다의 `findOwnPendingModelRequest`, 디스패치 직전
  `lockModelCapacityCallerControl`)는 순서 보장 때문에 그대로 잠근다 — holder 가 계속 5초를 넘기면 그 자리에서 다시 55P03 이 날 수 있다.

⑦ control 을 쥔·기다리는 세션(search-profile 틱 동안 몇 번 실행)

```sql
SELECT a.pid, a.application_name, a.state, clock_timestamp() - a.xact_start AS xact_age,
  a.wait_event_type, a.wait_event, pg_blocking_pids(a.pid) AS blocked_by, left(a.query, 120) AS query_head
FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.locktype = 'relation' AND l.relation = 'model_capacity_control'::regclass
ORDER BY a.xact_start;
```

## 이 차선의 남은 일 목록

- 끝낸 것: 세 잡 원인 추적·재현 시험(일회용 Postgres), 수정, 55P03 경로 (a)(b)(c), 이 문서.
- 남은 것(대표): PR 병합 → text·reviewer 배포 → ④로 세 잡 성공 시각 확인 → ①②③⑤. search-profile 은 배포 뒤 `search_profile.lock_timeout_holders`
  로그나 ⑦로 holder 를 확정하고, 그것이 특정 TX 면 그 TX 를 줄이는 후속 PR.
- 막힌 것: 운영 DB·로그를 직접 볼 수 없어(이 작업은 운영 접근 금지) 01:26Z 의 crawl-agent-review 멈춤 계기(어느 모델이 멈췄는지)와
  search-profile 의 holder 는 코드로만 추정했다.
