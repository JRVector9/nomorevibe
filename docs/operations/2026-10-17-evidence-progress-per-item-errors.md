# 근거 수집 진행 감시: 출처별 재시도 대기를 공급자 장애로 세지 않기

## 문제

2026-10-17 13:3x UTC 운영 반영 중 배포 도구(`scripts/ops/deploy_shared_images.py`)의 `monitor_gate`가
crawler 컨테이너의 `scripts/check-worker-progress.ts` 결과 `overall=alarm` 때문에 통과하지 못했다.
경보는 근거 수집 단계(stage `evidence`, job `product-evidence-refresh`) 하나였다.

```json
{"stage":"evidence","reason":"upstream_stalled","alarm":true,"waiting":6,"oldestMinutes":6158,"completed5m":0,
 "progress5m":0,"errors5m":2,"deferred":594,"providerErrors":600,"providerErrorMinutes":56074}
```

사용자 판단: 외부 사이트 오류 때문에 우리 서비스(배포)가 막히면 안 된다 — 판정식 결함으로 고친다.
게이트 예외는 쓰지 않는다([2026-10-15 문서](2026-10-15-ai-not-found-monitoring.md)의 "배포 게이트와 실패한 접근"에서
예외 prototype 이 P1 로 거절됐다). 감시 분류 자체를 고친다.

## 원인 1 — 집계가 출처별 재시도 대기를 공급자 장애로 셌다

`classifyStage`는 진행이 없을 때 `(providerErrorMinutes ?? oldestMinutes) >= 30 && errors > 0`이면
`upstream_stalled`(경보, 재시작 대상 아님)로 본다. `errors = max(providerErrors, errors5m) + (job.lastError ? 1 : 0)`.

`evidenceProgress`의 `provider_errors`는 오류 코드가 남은 **모든** 현재 출처를 셌다. 재시도 시각이 미래인
출처(`deferred`)도 포함했고, 나이는 그중 가장 오래된 대상의 마지막 성공 이후였다. 실패가 하나라도 남아 있으면
최근 5분 성공이 0인 순간 항상 경보다. 10/15에는 대기 4.8만 건으로 늘 `progressing`이라 가려졌고,
대기가 비자 성공이 몇 시간에 한 번이 되어 상시 경보가 됐다.

2026-10-17 14:3x UTC 운영 읽기 전용 실측(공개 현재 대상, 코드의 `source_targets`와 같은 정의):

| 공급자 | 오류 코드 | 기한 | 건수 | 최근 1시간 실패 |
|---|---|---|---:|---:|
| product_site | site_too_large | 미래 | 240 | 7 |
| product_site | site_http | 미래 | 199 | 6 |
| github | not_found | 미래 | 118 | 9 |
| product_site | site_timeout | 미래 | 23 | 0 |
| product_site | site_unsafe_url | 미래 | 10 | 0 |
| github | collection_failed | **지남** | 6 | 0 |
| github | http_403 | 미래 | 2 | 0 |
| github | invalid_response | 미래 | 1 | 0 |
| github | http_451 | 미래 | 1 | 0 |

합계 600 = `providerErrors`, 미래 594 = `deferred`. 계정 단위 코드(`rate_limited`·`auth_unavailable`)는 0건이다.
최근 12시간 성공은 시간당 0~2건, 실패는 14~26건이었다 — 대기가 빈 상태에서는 재시도 시각이 온 상습 실패만
다시 시도되므로 "최근 시도가 모두 실패"만으로는 장애와 구별되지 않는다.

같은 결함이 제작 근거(`agent-evidence`)에도 있다. 같은 스냅숏에서 `providerErrors=63`(저장소별 스캔
`unavailable`·`timeout`·`invalid` 등)이었고, 대기 4,302건이 `progressing`이라 가려져 있을 뿐 대기가 비면 같은 상시 경보가 된다.
AI 제작 단계(`ai-level`)는 PR423 이 저장소별 정상 재확인인 `not_found`를 이미 뺐고 현재 오류는 `not_found` 뿐이다.

## 원인 2 — 기한 지난 대기 6건은 사이트 기록 거절로 매 틱 실패했다

대기 6건(모두 github `collection_failed`, 마지막 성공 없음):

| 제품 | 저장소 | 마지막 실패(UTC) | 재시도 시각(UTC) | 제품 주소 |
|---|---|---|---|---|
| unilab | thiha-lynn/unilab | 10-11 21:23 | 10-13 21:23 | unilab.3-0-126-159.nip.io |
| astana-ceramic | libovskiy/astana_ceramic_ai | 10-12 06:59 | 10-13 06:59 | 91-147-113-239.sslip.io |
| product-2143 | konkovdv/fsp-talent | 10-13 20:55 | 10-14 02:55 | 89-124-65-102.sslip.io |
| glassbox | yash-vks-chauhan/glassbox | 10-13 00:45 | 10-15 00:45 | glassbox.15-252-203-137.sslip.io |
| llama-receipts-a-proof-of-one-llm-calculation | luiscosio/ai-verification | 10-13 07:17 | 10-15 07:17 | 178-156-248-181.sslip.io |
| product-781 | likelion-backend-24th/final-project-mokoco | 10-13 21:54 | 10-15 21:54 | 32.199.114.190.nip.io |

공통점은 제품 주소가 `sslip.io`·`nip.io`(사설 DNS 별칭)라는 것이다. 공개 제품 43,278건 중 이런 주소는 이 6건뿐이고,
저장소 링크가 보이는데 `canonical_site` 행이 없는 공개 제품도 정확히 이 6건이다(나머지 43,272건은 주소 정상·사이트 행 있음).

선택 쿼리 비교: 감시의 waiting(`greatest(l.created_at, s.created_at, s.next_attempt_at) <= now`)과
`dueEvidenceProductSlugs`의 링크 분기(보이는 링크, 공개 상태, `next_attempt_at <= now`)는 이 6건에서 일치한다 —
제품은 매분 집힌다. `canonical_site`의 주소 불일치(`p.updated_at`) 분기와 출처 행이 없는 LEFT JOIN 분기는 해당하지 않는다.

실제 경로(운영은 `evidence_source_control.enabled=false`, `job_batch_control.mode=legacy`):

1. `refreshProductEvidence`가 `canonicalSiteSources`로 사이트 출처를 맨 앞에 넣는다(사이트 행이 없고 저장소 링크가 보이면).
2. `refreshSiteFingerprint`가 기록할 때 `upsertObservedSource`의 `sourceUrl: safeHttpUrl`이 사설 DNS 별칭을 거절해 ZodError.
3. 사이트 출처 오류는 다시 던진다(#456 `d7640dfb`) → 잡은 `evidence.product_refresh_failed`(`zoderror`)만 남기고 다음 제품으로.
4. 뒤의 저장소 출처는 시도도 기록도 없이 `next_attempt_at`이 그대로 남아 매분 반복된다.

이력: `1167d5e4`(10-14) 전에는 사이트 지문이 저장소 수집 안에서 돌아 같은 ZodError 가 저장소 `collection_failed`로
기록되고 재시도 대기에 들어갔다(그래서 6건 모두 성공 이력 없이 `collection_failed`). 이후 사이트가 별도의 첫 출처가 되면서
기록 자체가 사라졌다. 운영 로그는 직접 보지 않았다 — 같은 경로를 실제 DB 통합 테스트로 재현했다(아래).

## 변경

1. `lib/operations/worker-progress-query.ts` — 공급자 오류 수·나이(`providerErrors`·`providerErrorMinutes`):
   - `evidence`: GitHub 계정 단위 실패 `rate_limited`·`auth_unavailable`만 센다(재시도 대기 중이어도).
     GitHub 수집기는 한도 403/429를 `rate_limited`로, 401 뒤의 403·인증 불가를 `auth_unavailable`로 바꾸므로
     그대로 남은 `http_403`·`http_451`은 저장소별 응답이다. 사이트 오류·`not_found`·`collection_failed` 등은 출처별 실패다.
   - `agent-evidence`: 스캔 오류는 `rate_limited`만 센다. 잡 커서가 기록한 스캔 전 공급자 실패(`providerFailure`)는
     코드와 무관하게 계속 센다(`job_failure`). 스캔의 `unavailable`은 없는 저장소와 인증 실패를 함께 담는다.
   - `ai-level`: 바꾸지 않았다. 저장소별 정상 재확인인 `not_found`는 PR423 이 이미 뺐고, `unknown`은 GraphQL 장애에서도
     생기는데 이 단계에는 5분 오류 신호(`errors5m`)가 없어 빼면 유일한 실패 신호가 사라진다.
   - `waiting`·`oldestMinutes`·`errors5m`·`deferred` 정의와 `classifyStage`는 바꾸지 않았다.
2. `lib/domain/evidence/refresh.ts` `canonicalSiteSources` — 제품 주소가 출처 기록 계약(`safeHttpUrl`)에 맞지 않으면
   사이트 출처를 만들지 않는다. 기록할 수 없는 사이트가 같은 제품의 다른 출처를 영영 막지 않게 한다.
   운영 공개 제품 중 해당은 위 6건뿐이다.

품질·재시도·timeout·parser·근거 판정·트랜잭션 규칙, 스키마(DDL)는 바꾸지 않았다.

## 수정 후 판정

| 상황 | 이유 | 경보 |
|---|---|---|
| 대기 0, 출처별 실패만 재시도 대기 | backoff | 아니오 |
| 대기 0, 방금(5분 안) 출처별 실패 기록 | upstream_or_job_error | 아니오 |
| 기한 지난 대기가 30분 넘게 시도조차 없음 | no_progress | 예(재시작 대상) |
| 기한 지난 대기 30분 이상 + 최근 5분 실패만 있음 | upstream_stalled | 예 |
| `rate_limited`·`auth_unavailable`(재시도 대기 포함), 나이 30분 이상 | upstream_stalled | 예 |
| 잡 `lastError` + 30분 넘은 기한 대기 | upstream_stalled | 예 |
| 제작 근거: 잡 커서의 스캔 전 공급자 실패, 30분 이상 | upstream_stalled | 예 |
| 제작 근거: 저장소별 스캔 오류가 재시도 대기 | backoff | 아니오 |

## 실측 — 같은 스냅숏에서 옛·새 집계

방법: 로컬 테스트 DB에서 `readWorkerProgress`를 돌려 drizzle 로거로 `evidenceProgress`의 실제 SQL을 잡고
(임시 스크립트, 커밋 안 함) 매개변수를 리터럴로 넣었다. 측정 시각은 운영 DB의 `now() at time zone 'utc'`,
설정·커서는 운영 값(제작 근거 `backgroundRefreshDays=90`, 커서 `providerFailure`)을 썼다. AI 단계의 `skipUnseen`은
렌더 시점 값(true)으로 고정됐다. 실행은 `ssh -o BatchMode=yes jr@100.99.209.55 "sudo -n -u postgres psql -X -A -d nomorevibe"`에
`begin transaction isolation level repeatable read read only; … rollback;`으로 감쌌다.

2026-10-17 14:45:58 UTC:

| 단계 | 판본 | waiting | oldest(분) | progress5m | errors5m | deferred | providerErrors | 나이(분) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| evidence | 옛 | 6 | 6,226 | 0 | 3 | 594 | 600 | 56,142 |
| evidence | 새 | 6 | 6,226 | 0 | 3 | 594 | 0 | — |
| agent-evidence | 옛 | 4,302 | 56,313 | 26 | 15 | 541 | 63 | 69,914 |
| agent-evidence | 새 | 4,302 | 56,313 | 26 | 15 | 541 | 1 | 4,417 |
| ai-level | 옛·새 | 4 | 0.9 | 6 | 0 | 159 | 0 | — |

새 집계에서도 `evidence`는 `upstream_stalled`(경보)다 — 기한 지난 6건(4.3일)과 최근 실패 3건 때문이며 맞는 경보다.
이 6건은 같은 PR의 변경 2가 들어간 crawler가 처리해야 풀린다. 운영 배포 후 관문 통과는 확인하지 않았다.
`agent-evidence`의 남은 1건은 커서의 스캔 전 실패(`idiljot-singh/stenwatch`, 10-14 13:08 UTC, failures 1)다.

## 검증 — 실행한 명령과 실제 결과

테스트 DB: `docker run -d --name nomorevibe-evidence-progress-db … -p 127.0.0.1:55671:5432 pgvector/pgvector:0.8.6-pg17`,
`MIGRATION_DATABASE_URL=… node scripts/migrate.mjs`(완료, NOTICE만), 이후 `TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@localhost:55671/nomorevibe_test`.

- 기준(변경 전): `tests/integration/worker-progress-query.test.ts` 17/17 통과.
- RED(변경 전 코드): 새 통합 테스트 3개 실패.
  - 출처별 재시도 대기만 있을 때 `backoff` 기대 → 실제 `upstream_stalled`, `providerErrors: 4`, `providerErrorMinutes: 4320`.
  - 제작 근거 저장소별 `unavailable` 재시도 대기 → 실제 `upstream_stalled`, `providerErrors: 1`.
  - `sslip.io` 제품의 기한 지난 저장소 출처 → 실제 `evidence.product_refresh_failed`(`errorCode: "zoderror"`), 저장소 미수집.
- GREEN: 같은 3개 통과.
- 기존 제작 근거 테스트 2개가 저장소별 스캔 `timeout`을 공급자 오류 1로 기대해 실패했고, 새 규칙에 맞춰 0으로 바꿨다.
- 관련 통합 11개 파일 264개 통과: `worker-progress-query`·`evidence-refresh`·`agent-evidence-refresh`·`evidence-admin`(91),
  `evidence-source-claims`·`github-evidence`·`maker-evidence-api`·`product-evidence-lifecycle`·`repository-link-sync`·
  `site-evidence-job`·`site-fingerprint`(173).
- 단위 15개 파일 184개 통과(`worker-progress` 17개, 판정 표 6개 추가 포함 — 분류기 자체는 바꾸지 않아 이 6개는 RED 재현이 아닌 계약 고정이다).
- `npx eslint <변경 6개 파일>` 위반 0, `git diff --check` 통과.
- `npx next typegen` 후 `npx tsc --noEmit -p tsconfig.json` exit 0, 진단 0.
- 돌리지 않은 것: 전체 단위·통합 스위트, e2e, 운영 배포·관문. CI 결과는 PR에 남긴다.

## 남은 위험·결정 필요

- 배포 전까지 `evidence` 경보는 계속된다(6건). 새 crawler가 6건을 처리하면 풀릴 것으로 보지만 관문 120초 안에 처리되는지는 미확인이다.
- 6개 제품은 처음으로 GitHub 근거가 수집된다(공개 화면에 근거가 새로 보일 수 있다). 사설 DNS 별칭 주소 제품을 공개로 둘지는 별도 정책 결정이다.
- 출처 claim 모드(`evidence_source_control.enabled=true`)의 `selectTarget`은 이 6건을 여전히 고른다. 켜면 같은 기록 거절이
  claim 레인을 막을 수 있어, 켜기 전 별도 수정이 필요하다(이번 변경 범위 밖).
- 제작 근거 커서의 스캔 전 실패(`idiljot-singh/stenwatch`)는 계속 공급자 실패로 센다. 대기 4,302건이 비기 전에 그 저장소가
  다시 시도되지 않거나 다시 실패하면 그때 경보가 된다.
- 출처별 실패로 흡수되는 설정 장애(예: GitHub 수집 계정이 아예 없어 수집이 던지면 `collection_failed`)는 저장 오류 수로는 경보하지 않는다.
  기한 대기 노화·`errors5m`·다른 단계로만 드러난다.
- 오케스트레이터 예시의 `http_403`은 계정 단위로 세지 않았다(위 근거). 계정 단위로 보려면 결정이 필요하다.
- AI 제작 단계의 `unknown` 한 건은 재확인(약 1시간)까지 경보할 수 있다(PR423 결정 유지).
- 관찰만: 사이트 지문 본문이 정확히 2 MiB이면 `budget_exhausted`로 기록 없이 돌아온다. 같은 무기록 반복 유형이며 운영 해당 건수는 확인하지 않았다.
