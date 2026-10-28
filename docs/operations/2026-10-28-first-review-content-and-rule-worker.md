# AI 1차 심사가 실제로 판정하는 것과 결정적 '심사 워커' 대체 검토

작성: 2026-10-28 UTC, 작업 공간 `xaegis/36694e57`. 코드 근거는 이 작업 공간 기준이다.
**운영 DB에 접근하지 못해(이 세션의 승인 거절) 대체 가능 비율은 측정하지 못했다.** 아래 비율은 문서에 기록된 표본뿐이며, 운영 측정용 SQL을 함께 적는다.

## 1. 입력

`createReviewInput`(`lib/crawl/agent-review-contract.ts:141-220`)이 만드는 스냅샷:

- `product`: repo, name(`pageMeta.title`→repo 이름), description(페이지 설명+`repoMeta.description`, 각 6,000자), `pageText`(`textSample`), url, `accessMode`, repositoryUrl, topics(≤30), language, `readme`(raw README 3,000자, 설치·사용 발췌 우선 — `lib/crawl/readme.ts:12,51-75`), `linksOwnGithub`, `packageProof`(있을 때만).
- `repoFacts`: stars, pushedAt, createdAt.
- `rules`: 규칙 판정이 마지막으로 멈춘 단계 `{stoppedAt, detail, cause}`.
- `policy`: 버전, `enforceEligibility`.
- AI 개발 근거: 관측 최대 32건, `evidenceSummary`, `relationship`, `scanState`.
- 전체 64KB 상한(`MAX_REVIEW_INPUT_BYTES`, :56) 넘으면 근거부터 버린다. `inputHash`, `validUntil = min(fetchedAt, scan.completedAt)+24h`.

## 2. 규칙 판정과 AI 판정의 경계

모델에 가지 않는 것:

| 경로 | 결과 | 근거 |
| --- | --- | --- |
| 규칙 확정 거절(no_homepage, not_a_product의 여러 패턴, fork, personal_site, large_oss, unreachable, already_listed, banned) | `rejected`, AI1 대상 아님 | `lib/crawl/rules.ts` `judgeWebsite`, `lib/crawl/jobs/judge.ts:68-92` |
| 별 자동 승인(≥500★, 비공개·포크·보관 아님, 24시간 내 수집) | AI1 제외 | `star-auto-approval.ts:12-16`, `agent-review-repository.ts:564` |
| README 확인 뒤 스팸 의심 | 사람 보류, provider `rules` | `agent-review-preparation.ts:15` |
| 심사 시점 규칙 거절(hardReason) | `reject`, provider `rules` | preparation :19-25 |
| AI 개발 근거 미달(evidenceHold) | `needs_review`, provider `rules` | preparation :21-28 |
| 같은 입력·모델·프롬프트 결과 재사용 | 호출 없이 기록 | `agent-review-repository.ts:993-1003` |

AI1이 보는 후보(`isReviewCandidate`, contract :235-238): `decidedBy='auto'`이면서 규칙 `approved`이거나, `REVIEW_RETRIABLE_REASONS`의 보류(`installable_product`, `page_status_unknown`, `push_time_unknown`, `docs_generator`, `docs_nav`, `name_pattern`, `host_excluded_subpath`, `agent_evidence` 등)다. **규칙이 승인한 후보도 AI1을 거친다.**

## 3. 프롬프트가 묻는 것

`REVIEW_SYSTEM_PROMPT`(`lib/crawl/agent-review.ts:102-141`): "product.url이 사람들이 만든 것의 목록에 들어갈 페이지인가".

- 승인: 실제 소프트웨어의 페이지(SaaS·앱·CLI·확장·라이브러리/SDK·게임/API·검색 가능한 카탈로그, 문서 프레임워크 홈 포함), 개인 프로필 사이트(category "Profile"). `linksOwnGithub`이면 거절 유형이 분명하지 않는 한 승인.
- 설치형 저장소 예외: ≥500★ 또는 `packageProof`. 문서·데이터만 있는 저장소는 거절, 설치·사용 사실이 없으면 보류.
- 거절: 문서 자체, 글·튜토리얼·뉴스레터, 강의, 대행·서비스, 남의 플랫폼 목록(Product Hunt·레지스트리·GitHub), placeholder·로딩·로그인 전용·출시 예정, **보이는 글이 비었거나 제목뿐인 페이지("이름·설명·README가 실제 소프트웨어를 말해도 거절")**.
- `enforceEligibility`가 참이고 근거 미달이면 승인 금지. 근거 id 인용.
- 요청(`agent-review-gateway.ts:137-148`): temperature 0, `max_tokens` 3,000, reasoning low, JSON schema(`decision`·`reason`·`evidenceIds`·`confidence`).

## 4. 출력과 저장

- `reviewOutcomeSchema`(contract :59-67): `decision` ∈ approve/reject/needs_review, `reason` 자유 글(≤2,000자), `evidenceIds`(≤40), `confidence` 0–1, `category`(선택). `validateReviewOutcome`은 없는 근거 id, 근거 없는 승인·거절, 근거 미달 승인을 거절한다.
- 시도 최대 3회(`MAX_REVIEW_ATTEMPTS`), 소진되면 `needs_review/ai_review_exhausted`.
- 저장(`agent-review-repository.ts:1131-1206`): attempt `succeeded`+outcome+토큰. enforce 모드면 후보 state가 결정을 따르고, 후보 reason은 `passed`/`not_a_product`/`ambiguous` 세 값으로 접힌다(AI의 이유는 `signals.stoppedAt`에 글로만 남음). 모델 결정이면 AI2를 요청한다.
- AI2(`lib/crawl/second-review.ts`): AI1 승인은 AI2 합의(같은 결정+AI1 confidence ≥0.85) 뒤 발행. **enforce 모드에서 AI1 거절은 AI2 없이 바로 `rejected`.**

정리: **AI1의 기계 판정은 3값 분류 하나**이고, 핵심 질문은 "실제 소프트웨어/프로필의 페이지인가"와 "보이는 내용이 비었는가"다.

## 5. 결정적 심사 워커로 대체할 수 있는가

### 대체 후보(규칙·분류기로 재현 가능성이 높은 부분)

| 묶음 | 판정 | 결정적 신호 | 기록된 근거 |
| --- | --- | --- | --- |
| A. 빈 페이지·제목뿐·JS 껍데기 거절 | reject | `pageText` 길이·고유 단어 수, `<noscript>`/로딩 문구, 제목=본문 | 2026-10-14 표본: Codex 거절 15건 중 **13건**이 제목뿐·JS 껍데기(`2026-10-14-coder-codex-supa-validation.md:19-23,42`) |
| B. 남의 플랫폼·문서·글 URL | reject | 호스트·경로 목록(이미 `rules.ts`에 일부), 문서 프레임워크 서명 | 규칙 패턴 정밀도: docs-generator 79%(19/24) 실제 홈, docs-nav 95%(19/20)가 실제 홈 → 이 둘은 **규칙 거절이 오히려 틀림**(`rules.ts:352-354,555`) |
| C. 설치형 저장소 승인 | approve | ≥500★ 이미 자동 승인. `packageProof`(레지스트리 실존·이름 일치) | 별 자동 승인은 이미 운영 중 |
| D. 이미 판정한 입력 | 재사용 | `inputHash` 동일 | 이미 운영 중 |

대체가 어려운 부분: 랜딩 페이지가 실제 제품인지 대행 서비스·강의·뉴스레터인지, 개인 프로필 판단, 근거가 섞인 경우. 자유 글을 읽는 의미 판정이라 규칙의 정밀도가 낮다(B의 규칙이 실제 홈을 79~95% 잘못 거절한 기록).

### 대체 가능 비율 — 측정 없음

문서의 표본은 서로 다른 시기·모델·모집단이라 합치면 추정이 된다. 그래서 숫자를 내지 않는다. 운영에서 다음처럼 잰다(primary READ ONLY, 최근 14일, AI1 자동 시도, 같은 프롬프트 버전):

```sql
-- 1) 분모: 모델이 실제로 판정한 AI1 시도
WITH ai1 AS (
  SELECT a.id, a.outcome->>'decision' AS decision, a.snapshot
  FROM crawl_review_attempts a
  WHERE a.kind = 'automatic' AND a.state = 'succeeded' AND a.provider <> 'rules'
    AND a.reused_from_attempt_id IS NULL AND a.completed_at > now() - interval '14 days')
SELECT decision,
  count(*) AS n,
  -- 2) 후보 규칙 A: 보이는 글이 거의 없음
  count(*) FILTER (WHERE length(coalesce(snapshot->'product'->>'pageText','')) < 200) AS thin_text,
  count(*) FILTER (WHERE length(coalesce(snapshot->'product'->>'pageText','')) < 200 AND decision = 'reject') AS thin_text_reject,
  -- 3) 후보 규칙 C: 패키지 증명 + 자기 GitHub 링크
  count(*) FILTER (WHERE snapshot->'product' ? 'packageProof' AND (snapshot->'product'->>'linksOwnGithub')::boolean) AS pkg_own,
  count(*) FILTER (WHERE snapshot->'product' ? 'packageProof' AND (snapshot->'product'->>'linksOwnGithub')::boolean AND decision = 'approve') AS pkg_own_approve
FROM ai1 GROUP BY decision;
```

- 규칙별 **일치율** = (규칙이 내린 결정 = AI1 결정) / 규칙이 발동한 건수. **대체 가능 비율** = 일치율이 기준(예: 98%)을 넘는 규칙들이 덮는 AI1 시도 / 분모.
- 정답은 AI1이 아니라 사람: `crawl_candidates.decided_by='admin'`과 `admin_override` attempt가 있는 후보로 규칙·AI1 각각의 오류율을 따로 잰다. AI1 단독 승인 124건 중 9건 오류(`agent-review-repository.ts:243-244` 주석)처럼 AI1 자체도 틀린다.
- `pageText` 길이 200은 첫 시험값이다. 같은 SQL에서 50·100·200·400을 비교해 일치율이 무너지는 지점을 고른다.

### 품질 위험

- 규칙 과거 기록: 문서 홈을 문서로 오인해 거절(79~95%가 실제 홈). 결정적 규칙은 **거절 쪽 오류를 늘리기 쉽다**. enforce 모드에서 AI1 거절은 AI2를 거치지 않으므로 규칙 거절도 같은 경로면 되돌릴 기회가 없다.
- 빈 페이지 판정은 JS 렌더링 사이트(정상 SPA)를 거절할 수 있다. 프롬프트도 같은 정책이지만, 규칙은 렌더링 뒤 본문을 읽지 못하면 더 많이 틀린다.
- 결정적 판정은 `confidence`가 없다. AI2 합의 조건(AI1 confidence ≥0.85)과의 연결을 새로 정해야 한다.

### 미확인 요청 감소 효과

모델 호출이 줄어든 만큼 물리 그룹 점유와 미확인 발생 기회가 줄어든다. 효과 크기 = (대체 가능 비율) × (AI1 호출당 미확인 발생률). 둘 다 **측정 없음**. 미확인 발생률은 `model_capacity_events`의 `dispatch_indeterminate` / `dispatch_started`(AI1 route)로 잰다. 다만 미확인 자체의 해결은 기한 사다리·자동 해제(3·4단계)가 맡고, 심사 워커는 부하를 줄이는 보조 수단이다.

### 단계적 도입안

1. **그림자 판정(쓰기 없음)**: 심사 워커가 같은 스냅샷에 규칙 판정을 계산해 로그·별도 표에만 남긴다. AI1은 그대로. 2주 동안 위 SQL로 규칙별 일치율과 사람 판정 대비 오류율을 잰다.
2. **거절 전용 1개 규칙(A: 빈 페이지)**: 일치율 ≥98%이고 사람 기준 오류율이 AI1보다 높지 않을 때만, provider `rules`로 `reject`를 기록하고 모델 호출을 건너뛴다. 기존 hardReason 경로(`provider 'rules'`)를 재사용하므로 저장 형식이 바뀌지 않는다. 규칙 거절은 사람 검토 목록에 표시해 되돌릴 수 있게 한다.
3. **승인 쪽(C)**: AI2 합의가 필요하므로 confidence 대신 "규칙 승인 → AI2 필수"로 연결한다. 직접 발행하지 않는다.
4. **확대 판단**: 1~3의 실측 뒤에만. 의미 판정(대행·강의·프로필)은 AI에 남긴다.

전부 대체는 권하지 않는다. 기록상 규칙의 거절 정밀도가 낮았고, AI1의 핵심 판정은 자유 글을 읽는 분류다.
