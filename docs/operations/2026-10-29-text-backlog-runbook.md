# 번역·후처리 3잡 적체 수정과 배포 뒤 확인 (2026-10-29)

대상: `product-tagline-ko`(대기 654·수동 1,099, upstream_stalled), `reason-translate`(대기 10,964, no_progress),
`product-search-profile`(대기 15,511, upstream_stalled). 근거 수치는 `docs/CODEX_HANDOFF.md` 10/27 23:07 KST 실측이다.
이 문서의 수정은 코드·시험까지다. 운영 DB·SSH·배포는 하지 않았다(작업자 SSH 차단, 배포는 대표 승인 뒤).

## 원인과 수정(코드에서 확인한 것)

공통 원인 — **고정된 맨 앞 대상의 무한 미룸**. 세 잡은 대기열 맨 앞을 정해진 순서(최신·홈·스타·id)로 고른다. 그 대상이
요청 장부(`model_capacity_requests`)의 다른 요청(남의 대기·예약, 누구든 보냄·미확인)에 묶여 있으면 장부 fence
(`capacity-repository.ts` `reasonTranslationFence`·`productTaglineKoFence`·`textProfileFence`)가 새 요청을 `capacity`로,
같은 boot 의 보냄·미확인이면 조정기가 `dispatched`로 미룬다. 미룸은 아무것도 적지 않으므로 다음 틱이 같은 대상을 다시 골라
같은 미룸을 되풀이한다. 새 대상이 앞에 들어오지 않으면 잡 전체가 멈춘다. 기존 dispatch 시험 세 곳이 이 동작
(“미확인 대상을 다시 골라 틱이 미뤄진다”)을 그대로 고정하고 있었다.

수정 — `lib/llm/capacity-busy-targets.ts`: 선택기가 fence 와 같은 상태·키를 미리 뺀다(읽기만 한다).
fence·용량 한도·장부 순서·경보 규칙은 바꾸지 않았다. 이 boot 의 대기·예약은 조정기가 이어받으므로 빼지 않는다
(search-profile 은 이어받을 요청을 `resumed`로 따로 앞에 둔다). 운영 모드가 `open`일 때만 뺀다.

| 잡 | 이 잡만의 원인 | 수정 |
| --- | --- | --- |
| product-tagline-ko | 최근 오류 10건 중 too_long 6·name_lost 2. 품질 외 실패(invalid_output·timeout…)는 세지 않아 하루 간격으로 끝없이 재시도 | `checkKoreanTaglineOutput`: too_long·name_lost·multiline 출력에 정해진 정리(뒤 괄호·뒷문장·줄표 뒤 부연 떼기, 띄어 쓴 이름 철자 복원, 첫 줄)만 하고 **전체 검사를 다시** 받는다. `leadClause`: 문장 끝 없는 120자 초과 소개는 마지막 쉼표까지 보낸다. 품질 외 실패 10회(`MAX_GATEWAY_FAILURES`)면 손을 떼고 `gaveUpReasons`에 `failure_limit:<오류>`로 남긴다. 공급자 전체 장애(network·rate_limit·no_key·model_unavailable·http_5xx)는 세지 않는다(search-profile 과 같은 구분) |
| reason-translate | 처음 보는 사유가 최신순이라 새 사유가 없으면 맨 앞 묶음이 고정. 그 멤버가 미확인 요청에 묶이면 오류 0의 무진척 | 두 대기열(`untriedTranslations`·`retryableTranslations`) 모두 장부에 묶인 `ko:<hash>`를 뺀다 |
| product-search-profile | 일꾼 둘 중 하나가 묶인 제품에서 미룸을 받으면 틱 전체를 접는다. 묵은 내 대기(입력 해시가 바뀐 것)가 있는 제품에 새 요청을 또 넣으려다 같은 미룸. 일꾼 수가 기본 gpt-oss 동시 수(2)와 같아 같은 그룹의 소개 짓기가 미룸만 받을 수 있다 | 새로 집는 제품에서 장부에 묶인 `text:profile:<id>`를 뺀다(한 제품 한 요청). 같은 그룹에 다른 route 의 대기가 살아 있으면 그 묶음은 일꾼 하나(`search_profile.fair_share`) |

세 잡 모두 미룸 사유를 로그에 남긴다: `tagline_ko.capacity_deferred`·`translate.capacity_deferred`·`search_profile.capacity_deferred`
(`reason` = capacity·dispatched·unmapped·provider_contract_unavailable…). 러너는 `model_capacity` 하나로만 적어 구분이 안 됐다.

이 수정으로 풀리지 않는 것(남음·다른 차선):

- route 전체를 막는 옛 형식 요청: 멤버 키가 없는(`logical_member_keys IS NULL`) reason/tagline 요청, 논리 키가 없는 profile 요청이
  보냄·미확인이면 fence 가 그 route 의 **모든** 새 요청을 막는다. 선택기로 돌아갈 수 없다. 아래 Q0 이 0행이 아니면 이 상태다.
- 물리 그룹 한도를 미확인 요청이 다 채운 경우(handoff 의 “m3group1 을 reason-translate indeterminate 1 이 막음”). 용량 한도는
  완화하지 않는다. 회수는 `model-capacity-reclaim`(미확인 요청 정체 차선, `review-stall-backlog.md`)이 맡는다. Q1 로 확인한다.
- 네이티브 GPT tagline wire(예약 증명 고정 문구)는 바꾸지 않았다 — 출력 길이 제한은 후처리·원문 앞 구절로만 했다.

## 배포 뒤 확인 — READ ONLY SQL과 기대값

모두 읽기 전용 트랜잭션으로 친다. `deploy_at`은 text 워커 새 이미지가 뜬 시각(KST 아님, timestamptz)으로 바꾼다.

```sql
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '10s';
\set deploy_at '2026-10-30 01:00:00+00'
```

**Q0. route 전체를 막는 옛 형식 요청** — 기대: **0행**. 행이 있으면 그 route 는 이 수정으로 풀리지 않는다(회수 차선으로 넘김).

```sql
SELECT route_id, state, count(*) AS n, min(updated_at) AS oldest
FROM model_capacity_requests
WHERE state IN ('dispatched','indeterminate')
  AND ((route_id IN ('reason-translate','product-tagline-ko') AND logical_member_keys IS NULL)
    OR (route_id = 'product-search-profile' AND logical_work_key IS NULL))
GROUP BY 1, 2;
```

**Q1. 물리 그룹 점유** — 기대: 세 route 가 쓰는 그룹마다 `indeterminate < group_limit`. 같으면 그 그룹은 미확인이 다 쥔 상태라
진척이 없어도 이 수정의 결함이 아니다(회수 차선).

```sql
WITH c AS (SELECT policy FROM model_capacity_control WHERE id = 1),
routes AS (SELECT route->>'routeId' AS route_id, route->>'groupId' AS group_id FROM c, jsonb_array_elements(c.policy->'routes') route
  WHERE route->>'routeId' IN ('reason-translate','product-tagline-ko','product-search-profile')),
limits AS (SELECT key AS group_id, value::int AS group_limit FROM c, jsonb_each_text(c.policy->'groupLimits'))
SELECT r.route_id, r.group_id, l.group_limit,
  (SELECT count(*) FROM model_capacity_requests q WHERE q.group_id = r.group_id AND q.state = 'indeterminate') AS indeterminate,
  (SELECT count(*) FROM model_capacity_requests q WHERE q.group_id = r.group_id AND q.state IN ('reserved','dispatched')) AS live,
  (SELECT count(*) FROM model_capacity_requests q WHERE q.group_id = r.group_id AND q.state = 'waiting') AS waiting
FROM routes r LEFT JOIN limits l USING (group_id) ORDER BY 2, 1;
```

**Q2. product-tagline-ko 진척·길이** — 기대: 배포 60분 뒤 `ok_since_deploy > 0`, `max_len <= 80`.

```sql
SELECT count(*) AS ok_since_deploy, max(char_length(tagline_ko)) AS max_len
FROM product_korean_taglines WHERE error_code IS NULL AND updated_at > :'deploy_at';
```

**Q3. product-tagline-ko 종료 사유** — 기대: `quality_limit:*`(이전 수동과 같은 성격)와 `failure_limit:*`(이전엔 끝없이 재시도하던 것)가
나뉘어 보인다. 수동 수는 배포 직후 `failure_limit` 만큼 늘 수 있다(의도된 변화).

```sql
SELECT CASE WHEN k.quality_rejections >= 4 THEN 'quality_limit:' ELSE 'failure_limit:' END || k.error_code AS reason, count(*) AS n
FROM product_korean_taglines k JOIN products p ON p.id = k.product_id AND k.source_tagline = p.tagline
WHERE p.status IN ('seeded','verified') AND k.error_code IS NOT NULL
  AND (k.quality_rejections >= 4 OR (k.attempts - k.quality_rejections >= 10
    AND k.error_code NOT IN ('network','rate_limit','rate_limited','no_key','model_unavailable')
    AND k.error_code !~ '^http_5[0-9][0-9]$'))
GROUP BY 1 ORDER BY 2 DESC;
```

(홈 제품은 품질 거절 6회까지 본다 — 이 집계는 홈 여부를 모르는 근사다. 정확한 값은 운영센터 한국어 번역 화면의 blocked.)

**Q4. product-tagline-ko 무한 재시도 없음** — 기대: **0**(배포 뒤 갱신된 행 중 품질 외 실패가 10회를 넘은 것).

```sql
SELECT count(*) AS over_limit
FROM product_korean_taglines
WHERE updated_at > :'deploy_at' AND error_code IS NOT NULL AND error_code NOT LIKE 'rejected:%'
  AND error_code NOT IN ('network','rate_limit','rate_limited','no_key','model_unavailable')
  AND error_code !~ '^http_5[0-9][0-9]$' AND attempts - quality_rejections > 10;
```

**Q5. reason-translate 진척** — 기대: Q0·Q1 이 정상이면 배포 60분 안에 `done_since_deploy > 0`.

```sql
SELECT count(*) FILTER (WHERE updated_at > :'deploy_at') AS done_since_deploy,
       count(*) FILTER (WHERE updated_at > now() - interval '5 minutes') AS done_5m
FROM text_translations WHERE target_lang = 'ko' AND status = 'done';
```

**Q6. 세 route 의 장부 점유(참고)** — 기대: 미확인 행이 남아 있어도 Q2·Q5·Q7 의 진척이 이어진다(묶인 대상만 건너뛴다).

```sql
SELECT route_id, state, count(*) AS n, min(updated_at) AS oldest,
  sum(coalesce(cardinality(logical_member_keys), 1)) AS targets
FROM model_capacity_requests
WHERE route_id IN ('reason-translate','product-tagline-ko','product-search-profile')
  AND state IN ('waiting','reserved','dispatched','indeterminate')
GROUP BY 1, 2 ORDER BY 1, 2;
```

**Q7. product-search-profile 진척** — 기대: 배포 60분 뒤 `generated_since_deploy > 0`.

```sql
SELECT count(*) AS generated_since_deploy FROM product_search_profiles
WHERE error_code IS NULL AND generated_at > :'deploy_at';
```

**Q8. 같은 제품의 활성 요청 중복** — 기대: **0행**(한 제품 한 요청).

```sql
SELECT logical_work_key, count(*) AS n FROM model_capacity_requests
WHERE route_id = 'product-search-profile' AND state IN ('waiting','reserved','dispatched','indeterminate')
GROUP BY 1 HAVING count(*) > 1;
```

**Q9. 같은 그룹의 예약 배분(최근 60분)** — 기대: 같은 group_id 에서 `product-tagline-ko`도 대기가 있으면 `reserved_60m > 0`이고,
`product-search-profile`이 그 그룹 예약의 전부가 아니다.

```sql
SELECT r.group_id, r.route_id, count(*) AS reserved_60m
FROM model_capacity_events e JOIN model_capacity_requests r ON r.request_id = e.request_id
WHERE e.kind = 'reserved' AND e.created_at > now() - interval '60 minutes'
  AND r.route_id IN ('product-search-profile','product-tagline-ko','reason-translate')
GROUP BY 1, 2 ORDER BY 1, 2;
```

```sql
ROLLBACK;
```

**Q10. 경보** — 같은 기준의 공식 관측(`node --import tsx scripts/check-worker-progress.ts`, 읽기 전용)에서 세 단계
(`tagline-ko`·`reason-translate`·`keywords`)의 `completed5m > 0`이면 `reason: progressing`, `alarm: false`여야 한다. 경보 규칙은 바꾸지
않았으므로 진척이 0이면 전처럼 `no_progress`·`upstream_stalled`로 남는다 — 그때는 Q0·Q1 과 로그의 `*.capacity_deferred` 사유를 본다.
`search_profile.fair_share` 로그가 계속 찍히면 같은 그룹에 다른 route 대기가 늘 있다는 뜻이다(처리량이 일꾼 하나로 준다).

## 시험(2026-10-29 실제 실행)

- 단위: `npx vitest run tests/postprocess-backlog-*.test.ts` — 3파일 24개 통과. 관련 기존 단위 19파일 291개 통과
  (작업 전 기준으로 잰 16파일은 265개 → 265개 그대로).
- 통합(일회용 PostgreSQL, `scripts/ci-test-postgres.sh`와 같은 pgvector 0.8.6-pg17 이미지):
  `TEST_DATABASE_URL=… npx vitest run --config vitest.integration.config.ts tests/integration/postprocess-backlog-*.test.ts`
  — 새 3파일 8개와 관련 기존 10파일 합쳐 13파일 121개 통과.
- 고친 기존 시험 세 곳(`korean-tagline-capacity-dispatch`·`reason-translation-capacity-dispatch`·`text-profile-capacity-dispatch`)은
  CI 처럼 빈 DB 에서 `node scripts/integration-shards.mjs --serial` 21파일을 순서대로 한 파일씩 돌렸다 — 21파일 204개 통과.
- 위 Q0~Q9 SQL 은 빈 시험 DB 에서 `BEGIN TRANSACTION READ ONLY` 로 문법·실행만 확인했다(운영 값 아님).
- eslint(바꾼 파일) 오류 0, `npx next typegen` 뒤 `tsc --noEmit` 0.
