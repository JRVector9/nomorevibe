> 최신 확인: 아래 최초 보고를 보존하고, 마지막의 **23:30 UTC 최신 코드·운영 실측 정정**을 현재 결론으로 사용한다. 원래의 미측정·후보 규칙은 당시 기록이며 운영 적용 근거가 아니다.

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

## 23:30 UTC 최신 코드·운영 실측 정정 (p84-5)

코드: origin/main `b047bddb` (#707) + 이 차선의 분리 커밋 `07930102`(재시작 보호), `01514beb`(전송 전 배정), `dc704d87`(기한/relay), `d7fea73c`(미선언 자동 회수). `git fetch origin`으로 최신 main 재확인. 운영에 반영된 커밋 목록이라는 뜻은 아니다.

### 코드 재확인에서 바로잡은 내용

- `agent-review-contract.ts`의 `REVIEW_RETRIABLE_REASONS`는 `ambiguous`, `ai_evidence_pending`, `ai_evidence_insufficient`, `ai_evidence_not_found`, `repository_relationship_conflict`, `source_changed`다. 최초 보고의 installable_product/docs_nav/name_pattern 등은 규칙 trace/cause를 후보 reason과 섞은 서술이었다. 실제 대상은 `decidedBy=auto`이면서 approved 또는 이6개 needs_review reason이다.
- `packageProof`는 설치용 host 생태계 파일의 저장소 관측이다. 레지스트리 실존/이름 일치나 실제 실행 검증이라는 최초 표의 표현은 정확하지 않다. 프롬프트도 packageProof/별은 자격이며 실제 유용한 소프트웨어의 증명이 아니라고 구분한다.
- `REVIEW_SYSTEM_PROMPT`의 **installable 예외가 빈 웹 본문 거절보다 먼저 적용**된다. accessMode=installable이면 README·설치/사용 근거를 판정하며, 원래 URL이 없거나 웹 본문이 짧아도 승인할 수 있다. 별500 미만에서 packageProof만으로 자격을 얻으면 해당 skill/plugin/MCP/extension 자체가 실제 납품물인지도 가린다. 따라서 전역 `pageText < 200 → reject`는 현재 정책을 재현하지 못한다.
- AI1은 단일3값 판정+자유 이유/근거/confidence를 저장한다. enforce에서 AI1 approve는 AI2 관문, reject는 바로 rejected인 기존 경로를 유지한다. 규칙만으로 AI1 reject를 만들면 AI2가 이를 구해 주지 않는다.
- gateway의 기본 출력 상한은3000이지만 AI2 native/direct 준비 경로는 검증된 serving contract의 requestBudget/maxOutputTokens를 사용한다. max_tokens만으로 실행시간 보장이 생기지 않는다.
- 이 차선의 우회 배정은 전송 이력·활성 intent 없는 AI1 후보만 대상이다. 규칙 심사 워커가 새 결론을 쓰는 변경은 하지 않았다.

### 최근14일 그림자 규칙의 실제 AI 일치 (사람 정확도 아님)

명령/원본: `scripts/ops/measure-review-rule-shadow.mjs`를 기존 M3 text 컨테이너에서 `node --input-type=module` stdin으로 실행. READ ONLY·statement_timeout25초, primary 확인. prompt `2026-10-06.2`, automatic+succeeded, provider rules/재사용 제외. 2026-10-28T23:30:50.417Z 표본 **19,093건**. 원본 `review-stall-rule-shadow-by-mode.json`, 첫 조회 `review-stall-rule-shadow.json`도 보존한다.

| 거절 후보 규칙 | 발동 건수 | AI1 전체 대비 | 그중 AI reject | 거절 결정 AI 일치율 | AI approve |
| --- | ---: | ---: | ---: | ---: | ---: |
| 본문50자 미만 | 3589 | 18.80% | 2558 | 71.27% | 875 |
| 본문100자 미만 | 4582 | 24.00% | 3213 | 70.12% | 1199 |
| 본문200자 미만 | 5431 | 28.44% | 3662 | 67.43% | 1593 |
| 본문400자 미만 | 6340 | 33.21% | 4039 | 63.71% | 2122 |

200자 기준을 accessMode로 분리하면 installable637건 중594건 발동, reject56·approve414다. website18456건 중4837건 발동, reject3606·approve1179다. installable을 제외해도 단순 본문 길이만으로 승인/거절을 대체할 근거가 없다. 최초 보고가 예로 든98% AI 일치 기준을 어느 길이에서도 만족하지 않는다.

이것은 실제로 전송된 성공 시도 수이며 독립 제품 수나 사람 정답 표본 수가 아니다. AI와의 불일치를 사람 기준 오판이라고 단정하지 않는다. **사람 정답으로 검증된 대체 가능 비율은 측정 없음**이며, 사람의 같은 입력 판정과 대조한 오류율이 필요하다. 추정 대체율을 만들지 않는다.

### 현재 선택과 다음 관문

가장 덜 파괴적인 선택은 **그림자 평가만 유지하고 신규 규칙으로 자동 거절하지 않는 것**이다. 이유: 현재 입력에 installable·개인 프로필·제품 의미 판정이 섞이며, 단순 길이 규칙은 실제 AI 판단과도 크게 어긋난다. 후보 규칙을 다시 설계할 때 accessMode/설치 근거와 정상 SPA를 분리하고 사람 정답으로 검증한다. 그때까지 기존 규칙/재사용/별 자동 승인 경로를 보존한다.

AI1·AI2 총 실제 저장은 첫 측정23:14 → 재측정23:30에 각각 **94871→94871**, **91158→91158**이다. 이번 앱 배포는 없고 증가도0이므로 이 차선이 운영 정체를 해결했다고 주장하지 않는다. 미확인 회복의 완료 조건은 기한 강제/종료 증거, 표준 배포,4종 드릴,60분 새 저장 증가·수동 해제0이다. 지정 scratch 쓰기 차단과 미확정 M1/서버 상한 때문에 이 운영 관문은 남아 있다.
