# 장부 CHECK 비용 — 측정과 0160(트리거 이전) 시제품 (2026-11-01)

상태: **시제품, 사용자 결정 대기.** 브랜치 `claude/ledger-check-trigger`(origin/main 7a10dfb0 기준). 운영 DB·GitHub 는 건드리지 않았다.
측정은 이 작업용 Docker PostgreSQL 17.11(pgvector 0.8.6-pg17, tmpfs, 같은 호스트) 하나에서 했다.

## 1. 무엇이 문제인가

`model_capacity_requests`·`model_capacity_events` 의 합성 CHECK 는 0096 이후 "`(이전 pg_get_constraintdef 전체) OR (새 가지)`" 로 다시 만들어 왔다
(0099·0118·0125·0149·0151·0155·0157·0158, 생성기 `scripts/ops/generate-release-branch-kinds-sql.ts`). main(0158) 의 크기:

| 제약 | `pg_get_constraintdef` 길이 | `conbin::text` 길이 | 최상위 OR 가지 수 |
| --- | ---: | ---: | ---: |
| `model_capacity_requests_dispatch_check` | 586,546 | 7,047,113 | 35 |
| `model_capacity_requests_terminal_check` | 515,142 | 6,193,825 | 28 |
| `model_capacity_requests_logical_check` | 48,414 | 565,953 | 31 |
| `model_capacity_requests_members_check` | 37,027 | 443,379 | 24 |
| `model_capacity_events_terminal_check` | 650,211 | 8,421,779 | 20 |
| `model_capacity_events_kind_check` | 21,499 | 257,428 | 13 |

(가지 수는 괄호·따옴표를 따라 최상위 `OR` 만 편 것. 나머지 작은 CHECK 14개는 모두 1KB 아래.)

PostgreSQL 은 INSERT/UPDATE 문마다 `ExecRelCheck` 에서 CHECK 의 `conbin` 을 `stringToNode` → `expression_planner` → `ExecInitExpr` 로 다시 세운다(캐시 없음).
그래서 문장 하나에 약 13MB 의 노드 문자열을 다시 읽고 상수 접기를 다시 한다. 모델 호출 한 번이 장부 문장 6~7개를 쓰고, 그 시간 동안
`model_capacity_control` 한 행 뮤텍스와 행 잠금을 잡고 있다(10-31 의 55P03 줄서기).

### 가지가 담고 있는 것(dispatch_check 35 가지 기준)

- 1개: 배정 전(binding·hash·dispatched_at 모두 NULL).
- 18개: kind 별 "dispatched 모양" — `dispatch_binding->>'kind'='<kind>'` 뒤에 그 binding 의 JSON 스키마를 SQL 로 손으로 푼 것(가장 큰 가지 123KB). 0157(ai1 provider enum)이
  provider 리스트만 다른 가지 7개(171KB)를 복제해 거의 두 배가 됐다.
- 4개: 회수 가지(`state='withdrawn' AND terminal_evidence->>'kind' IN (...)`, kind 목록만 다름 — 0096·0099·0151·0158).
- 2개: local_model_direct 모양(0118·0155).
- 1개: publication_classify(0125, SQL 도움 함수 사용).
- 7개: `nmv_*_request_valid(to_jsonb(model_capacity_requests.*))` 함수 호출(0126·0134~0137·0143·0145) — 이미 "작은 술어 + PL/pgSQL 검증기" 꼴이고 각 72~89 글자.
- 2개(terminal·events terminal 도 같은 꼴): 비슷한 분류.

## 2. 측정

같은 세션에서 INSERT 200 + UPDATE 200(한 트랜잭션, ROLLBACK). ms/문장. `nocheck` 는 dispatch·terminal 두 CHECK 를 트랜잭션 안에서 DROP 한 바닥값(남은 guard 트리거 7개 포함).

| 측정 | main(0158, CHECK) | **0160(트리거)** | nocheck(바닥) |
| --- | ---: | ---: | ---: |
| 400 문장, 3회 | 66.0 / 67.4 / 63.9 | **6.5 / 6.5 / 6.4** | 4.0 / 4.0 / 4.0 |
| 같은 400 문장, PREPARE/EXECUTE | 30.3 / 30.1 / 30.3 | **3.4** | — |
| `EXPLAIN (ANALYZE, TIMING)` INSERT 한 건(세션 두 번째 이후) | 67.3 (총 69.3) | **≈6.1** | 6.1 |
| 같은 UPDATE 한 건 | 60.4 (총 61.8) | **6.0** (트리거 5.5) | 3.9 |
| 세션 **첫** 호출(계획 캐시 만들기) | — | **169 ms** (트리거 166) | — |
| `tests/integration/ledger-check-rules.test.ts` 안 20+20 문장(첫 호출 포함) | 52.5 | **6.3** | — |

- CHECK 가 차지한 몫: 문장당 약 62ms → 트리거에서는 약 2.4ms(남은 몫은 `ExecInitExpr` 만). 전체 문장 비용 **약 10배** 개선(66 → 6.5), 5배 기준을 넘어 Option 1 을 주 결과물로 삼았다.
- 첫 호출 169ms 는 **백엔드 세션마다 한 번**이다(PL/pgSQL 이 SELECT 계획을 세션에 캐시). 커넥션 풀·pgbouncer 가 세션을 재사용하므로 운영에서는 분산된다.
  연결마다 새로 세션을 열고 한 문장만 쓰는 호출자(짧은 스크립트)는 오히려 느려질 수 있다 — 아래 미결 사항.
- 운영 영향 예상(실측 아님): 모델 호출당 장부 문장 6~7개 × 약 60ms 절감 = 호출당 0.35~0.45초의 뮤텍스·행 잠금 보유 시간이 줄어든다.

## 3. 무엇을 바꿨나 — `drizzle/0160_ledger_check_rules.sql`

0159 는 아직 병합되지 않은 PR #772 의 번호여서 **0160** 을 썼다(journal `when` 1794086401071; 0159 자리 1794086401070 은 비워 둠).

1. `model_capacity_check_rules(table_name, constraint_name, ordinal, predicate, source, created_at)` — 여섯 CHECK 의 `pg_get_expr(conbin, conrelid)` 를 ordinal 1 로 넣는다. **글자 하나 고치지 않는다**
   (마이그레이션은 `pg_constraint` 를 읽어 넣으므로 정확한 글자에 의존하지 않는다).
2. `nmv_model_capacity_check_guard_rebuild(표)` — rules 행으로 `nmv_<표>_check_guard()` 트리거 함수를 `CREATE OR REPLACE` 한다.
   - 제약 이름 알파벳 순서 = PostgreSQL 의 CHECK 평가 순서(`CheckConstraintCmp`). 같은 제약의 가지는 ordinal 순서로 `ok := ok OR leaf`, TRUE 가 나오면 멈춘다 — SQL `OR` 의 3값 논리·왼쪽부터 단락과 같다.
   - `ok IS FALSE` 일 때만 RAISE(NULL 은 CHECK 처럼 통과). `ERRCODE 23514`, `CONSTRAINT`, `TABLE`, `SCHEMA`, `MESSAGE` 를 원래 제약과 같게 둔다 — `code`·`constraint_name`·`table_name` 을 보는 코드·시험이 그대로 맞는다. `DETAIL` 은 `Failing row contains (<NEW::text>)` 로 비슷하게만 낸다.
   - 열 참조는 `SELECT (<술어>) INTO leaf FROM (SELECT (NEW).*) AS <표>` 로 NEW 에 맺는다(별칭 = 표 이름이라 `to_jsonb(model_capacity_requests.*)` 도 그대로 풀린다). 0158 시험의 `judge()` 가 쓰던 바로 그 꼴.
   - 함수에 `SET plan_cache_mode = force_generic_plan` — 첫 다섯 번의 custom plan 재계획(각 170ms)을 피한다.
3. 표마다 `BEFORE INSERT OR UPDATE FOR EACH ROW` 트리거 `<표>_zz_check_guard`. 이름이 `zz` 인 이유: BEFORE 트리거는 이름 순서로 돌고 CHECK 는 늘 모든 BEFORE 트리거 **뒤**였다. 기존 guard 트리거가 먼저 거절하던 행은 그대로 guard 가 먼저 거절한다. 새 BEFORE 트리거를 더할 때 이 이름 뒤에 오지 않게 한다.
4. 여섯 CHECK 를 DROP. 작은 CHECK 14개는 그대로 pg_constraint 에 있다.

바뀌지 않은 것: 함수 본문(기존 `nmv_*`)·행·해시·인덱스·권한·`__drizzle_migrations` 이전 항목. 트리거는 새 쓰기만 검사한다(기존 행은 CHECK 를 통과했던 행이라 상태가 같다; NOT VALID 류의 구분은 없다).

의미가 달라지는 가장자리(알고 받아들인 것):
- 작은 CHECK 와 옮긴 CHECK 를 **동시에** 어기는 행은 전에는 알파벳이 앞선 쪽(예: class_check) 이, 지금은 옮긴 쪽이 먼저 보고된다. 받아들임/거절 자체는 같다.
- `session_replication_role = replica` 나 `pg_restore --disable-triggers` 아래서는 트리거가 돌지 않는다(CHECK 는 돌았다). 운영은 물리 복제(Patroni)라 해당 없음; 기존 guard 트리거 7개와 같은 조건이다.
- `DETAIL` 문구 형식이 PostgreSQL 기본과 조금 다르다(NULL 표기·따옴표).

되돌리기(검증함): rules 의 ordinal 1 술어로 `ALTER TABLE … ADD CONSTRAINT … CHECK (…)` 를 다시 걸고 두 트리거·함수를 DROP 한다 — 임시 DB 에서 그 절차로 0158 동치 스키마를 만들어 "전" 시간을 재는 데 썼다.
다시 건 CHECK 의 `pg_get_constraintdef` 는 dispatch·requests terminal 은 글자까지 같고, events terminal(+12)·logical(+6)·members(+6) 는 괄호 몇 개가 더 붙는다(PostgreSQL 의 deparse 가 고정점이 아니다). 의미는 같지만 글자 비교 시험은 되돌린 DB 에서 그대로 쓸 수 없다.

### 저장소 쪽

- `lib/db/operations-schema.ts`: `modelCapacityCheckRules` 표 선언, 두 장부 표 위에 0160 주석. 여섯 `check()` 선언은 **그대로 둔다** — 이 저장소는 drizzle-kit generate/push 를 쓰지 않고(migrate 만), 그 선언은 술어의 TypeScript 쪽 단일 출처로 스키마 이력 시험이 읽는다. DB 와 어긋난다고 볼 수도 있어 미결 사항에 적었다.
- `tests/integration/ledger-check-defs.ts`: `ledgerCheckDefs()`·`ledgerCheckExpressions()` — pg_constraint 와 rules 두 출처를 합쳐 `CHECK (<술어>)`/`pg_get_expr` 꼴로 돌려준다(가지 둘 이상이면 `(가지1) OR (가지2)`). 0160 앞뒤 어느 DB 에서나 같은 글자. 이력 시험 9개가 `defs()` 를 이 도움 함수로 바꿨다(cli-executor-*-boundary-release 4, provider-boundary-release, dr-followups, gateway-not-started-ledger, local-model-assist-constraint-regression, release-branch-kinds).
- `tests/integration/release-branch-kinds.test.ts`: 0158 검증은 ≤158 부분 폴더로 올려 그대로 두고, 0160 뒤 상태를 보는 시험을 하나 더했다. 그 뒤의 회수 UPDATE 두 건은 트리거 아래서 돈다.
- 새 시험: `tests/ledger-check-rules-schema.test.ts`(journal·파일 모양·Drizzle 표), `tests/integration/ledger-check-rules.test.ts`(아래 4절).

## 4. 판정 동일성 검증(differential) — 범위를 그대로 적는다

`tests/integration/ledger-check-rules.test.ts` 가 임시 DB 에서 0158 → 0160 을 거치며 비교한 것:

- 여섯 CHECK 의 `pg_get_expr` 술어 ↔ rules 행의 `predicate`: 바이트 단위로 같다. `ledgerCheckDefs` 가 돌려주는 `CHECK (…)` 도 같다.
- 손으로 만든 행 9건의 판정(받아들임 / `23514:<제약 이름>`)이 0158 과 0160 에서 **모두 같다**. 어느 제약에 닿았는지:

| 행 | 판정(0158 = 0160) |
| --- | --- |
| waiting, binding 없음 | 받아들임 |
| waiting + `dispatch_binding='{}'` | `model_capacity_requests_dispatch_check` |
| waiting + `logical_work_key='bogus'` | `model_capacity_requests_logical_check` |
| waiting + `logical_member_keys={a}` (logical key 없음) | `model_capacity_requests_members_check` |
| withdrawn + `terminal_evidence='{}'` | `model_capacity_requests_terminal_check` |
| queued 사건 | 받아들임 |
| dispatch_settled 사건 + `evidence='{}'` | `model_capacity_events_terminal_check` |
| kind='bogus' 사건 | `model_capacity_events_kind_check` |
| dispatch_released 사건, evidence 없음 | `model_capacity_events_kind_check` |

- 오류 모양: `code 23514`, `constraint_name`, `table_name`, `schema_name`, `message` 가 CHECK 때와 같다.
- rebuild 멱등(함수 본문 동일), rules 행 하나(ordinal 2, `dispatch_binding = '{}'::jsonb`)를 넣고 rebuild 하면 그 행만 받아들여지고 지우면 돌아온다.
- 그 위에 실제 장부를 쓰는 통합 시험 묶음(5절)이 트리거 아래서 통과했다 — 그 시험들에는 `23514:<제약 이름>` 을 기대하는 부정 사례가 여럿 있다(model-capacity-cli-ledger, local-model-capacity, websearch-query-ledger, llm-assist-dispatch, local-model-assist-constraint-regression).

**하지 않은 것**: Option 2 용으로 적은 "통합 시험이 쓰는 모든 행을 로깅 트리거로 받아 변이시켜 옛 술어와 새 함수를 맞대는" 차등 하네스는 만들지 않았다. Option 1 은 술어가 글자 그대로라 그 하네스가 항진식이 되고, 가지별 적중(coverage) 측정은 Option 2 를 만들 때 함께 한다.

## 5. 실행한 검사

- `npx next typegen && npx tsc --noEmit` → 0. `npx eslint`(바뀐 ts 13개) → 0.
- `npx vitest run tests/*schema*.test.ts tests/release-branch-kinds-schema.test.ts tests/ledger-check-rules-schema.test.ts tests/migration-production-lock.test.ts tests/migration-config.test.ts` → 9 파일 55 통과.
- 통합(작업용 DB 55490, 0160 적용): 결과·파일별 시간은 아래 "통합 실행" 표.
- `pipeline-replay-fixed-input.test.ts` 시간: 아래 표(전 = 되돌리기 절차로 만든 0158 동치 스키마, 후 = 0160; 같은 호스트·같은 날).

통합 실행(`TEST_DATABASE_URL=…55490 npx vitest run --config vitest.integration.config.ts <23 파일>`): **23 파일 181 시험 통과**, 389.7s.

| 파일 | 시험 | 시간 |
| --- | ---: | ---: |
| pipeline-replay-fixed-input | 8 | 91.8s (0158 동치 스키마에서 92.9s, CI 기록 84.0s — 이 파일의 시간은 장부 CHECK 와 무관하다) |
| dr-reclaim-outside | 5 | 34.1s |
| dr-followups | 5 | 27.2s |
| gateway-not-started-ledger | 9 | 22.1s |
| migration-0143-chain | 2 | 22.1s |
| cli-executor-indeterminate-boundary-release | 4 | 16.5s |
| cli-executor-removed-boundary-release | 5 | 16.4s |
| ledger-check-rules(새) | 5 | 15.9s |
| dr-successor-exit | 3 | 15.4s |
| cli-executor-boundary-release | 5 | 15.4s |
| release-branch-kinds | 5 | 14.1s |
| cli-executor-indeterminate-removed-boundary-release | 4 | 13.3s |
| llm-assist-dispatch | 38 | 12.9s |
| provider-boundary-release | 10 | 12.0s |
| model-capacity-cli-ledger | 8 | 6.8s |
| publication-classify-capacity | 17 | 5.2s |
| local-model-capacity | 9 | 5.1s |
| local-model-assist-constraint-regression | 10 | 4.2s |
| product-tagline-ko-capacity-ledger | 4 | 3.4s |
| uptime-split-schema | 9 | 3.3s |
| model-capacity-websearch-query-ledger | 11 | 3.0s |
| model-capacity-control-contention | 2 | 0.9s |
| text-model-capacity-admission | 3 | 0.9s |

실행하지 않은 것: 전체 unit·전체 통합 묶음(AGENTS.md 의 PR별 검증 정책대로 변경 범위만), 운영 DB 어떤 읽기·쓰기, GitHub CI.

## 6. 앞으로 가지를 더하는 법 — 더는 "이전 전체에 OR" 하지 않는다

```sql
-- 0161_xxx.sql (예)
INSERT INTO model_capacity_check_rules(table_name, constraint_name, ordinal, predicate, source)
SELECT 'model_capacity_requests', 'model_capacity_requests_dispatch_check', coalesce(max(ordinal), 0) + 1, $branch$<가지 술어>$branch$, '0161_xxx'
  FROM model_capacity_check_rules WHERE table_name = 'model_capacity_requests' AND constraint_name = 'model_capacity_requests_dispatch_check';
--> statement-breakpoint
SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_requests');
```

- 술어는 `lib/llm/*-sql.ts` 상수 그대로(생성기가 파일을 만든다). 스키마 쪽은 지금처럼 `(이전) OR (가지)` 로 합쳐 두고, 시험은 rules 행 `(ordinal, predicate)` 을 상수와 **직접** 비교한다 — 임시 CHECK 로 정규형을 만들어 비교할 필요가 없다.
- 평가 비용은 "그 제약에서 TRUE 가 나올 때까지 본 가지들의 `ExecInitExpr`" 이다. 자주 맞는 가지를 앞 ordinal 에 두면 더 빠르다(ordinal 1 은 지금 0158 전체 한 덩이).
- PR #772 의 0159 가 CHECK 를 `ALTER … DROP/ADD CONSTRAINT` 로 고치면 0160 뒤에서는 `INTO STRICT` 가 실패한다 → 위 꼴로 다시 쓴다(미결 사항 2).

## 7. Option 2 — 의미 단순화 설계(시제품 아님)

목표: 같은 받아들임/거절 의미를 더 작은 함수로, 그리고 "새 provider·model·kind = 마이그레이션이 아니라 행" 으로.

1. **kind 로 분기**: rules 행에 `binding_kind text`(NULL = kind 와 무관), `states text[]`, `evidence_kinds text[]` 열을 더한다. 트리거는 `NEW.dispatch_binding->>'kind'`(요청) / `NEW.kind`·`NEW.evidence->>'kind'`(사건) 로 그 kind 의 행과 kind 무관 행만 평가한다. 지금 35 가지 가운데 18 가지가 kind 하나씩에 묶여 있어 문장당 평가량이 1/10 아래로 떨어진다.
2. **모양 검증은 데이터로**: 손으로 푼 JSON 스키마 SQL(가지당 10~123KB) 대신 0134 가 이미 쓰는 해석기 `nmv_cli_executor_shape_valid(v jsonb, s jsonb)` 꼴의 공용 함수에 스키마를 `jsonb` 로 넘긴다(`rules.shape jsonb`). `lib/llm/*-contract.ts` 의 zod 스키마에서 JSON 스키마를 생성하면 TS 와 DB 가 한 출처를 갖는다. provider 열거(0157 이 복제한 7 가지)는 `providers text[]` 열 또는 `model_assignments`/`model_serving_contracts` 조인으로.
3. **회수 가지 4개 → 행 1개**: `(state='withdrawn', evidence_kinds={process_group_exit,dr_call_drain}, binding_kinds={…18개})`.
4. **오류 이름 유지**: 행마다 `constraint_name` 을 둬 지금과 같은 `23514:<이름>` 을 낸다.
5. **검증(필수, 이게 없으면 적용 금지)**: 차등 하네스 —
   - 옛 술어: rules ordinal 1(0158 정규형)로 `nmv_ledger_old_<이름>(r <표>) RETURNS boolean` SQL 함수를 만든다. 가지별 적중을 세기 위해 최상위 OR 가지 각각도 함수로 둔다(이 문서 1절의 가지 분해기를 PL/pgSQL 로).
   - 행 수집: 두 장부 표에 `AFTER INSERT OR UPDATE` 로깅 트리거를 달아 `ledger_check_capture(table, row jsonb)` 에 남기고 `tests/integration/*capacity*.test.ts`, `*ledger*.test.ts`, `release-branch-kinds`, `publication-classify-capacity` 를 돈다.
   - 변이: 잡힌 행마다 state·kind·evidence kind·provider·hash·필수 키 삭제를 바꿔 부정 사례를 만든다.
   - 판정: 모든 (행, 제약) 에 대해 옛 함수와 새 함수의 결과가 같아야 한다. 가지별 적중 수와 "한 번도 안 맞은 가지" 목록을 결과에 그대로 적는다.
6. 관리자 화면("모델은 stage 와 분리, 저장하면 refresh 가 적용")과의 연결: 새 모델·provider 는 rules/shape 행 INSERT + `rebuild` 호출로 끝난다. rebuild 는 `CREATE OR REPLACE FUNCTION` 이라 ACCESS EXCLUSIVE 잠금 없이 적용된다(함수 교체는 세션별 계획 무효화만 일으킨다).

## 8. 사용자 결정이 필요한 것

1. **0160 채택 여부.** 의미 변화 없이 장부 문장 비용 약 10배 개선(세션 첫 호출 +169ms). 운영 적용은 일반 배포 밖(capacity 변경)이며 DRAIN 뒤 migrate 가 안전하다(10-31 교훈). 적용 전 운영 DB 의 여섯 CHECK 가 0158 상태인지(`__drizzle_migrations` 158) 확인한다.
2. **PR #772(0159) 와의 순서.** drizzle 은 `when` 으로 건너뛴다. 0160 이 먼저 들어가면 #772 는 0161·더 큰 when 으로 바꾸고 CHECK 변경을 6절 꼴(rules 행 + rebuild)로 다시 쓴다. #772 가 먼저 들어가면 0160 의 when 을 그 뒤로 올리고 0159 적용 DB 에서 다시 시험한다(0160 은 pg_constraint 를 읽으므로 글자 변화는 상관없다).
3. Drizzle 쪽 여섯 `check()` 선언을 그대로 둘지(지금), 상수로 빼내고 선언을 지울지(DB 와 1:1 이지만 스키마 시험 6파일 수정).
4. 작은 CHECK 14개도 트리거로 옮겨 보고 순서까지 완전히 같게 할지(지금은 두 가지를 동시에 어기는 행에서 보고되는 이름만 다름).
5. Option 2 진행 여부와 차등 하네스 범위.
