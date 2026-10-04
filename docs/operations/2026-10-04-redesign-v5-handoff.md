# 홈·상세 리디자인 5차 — 인수인계 (2026-10-04)

## 지금 상태

- **라이브**: 릴리스 `c931108`(#259, 2026-10-04 19:27 KST 웹 둘 수동 배포). 이 릴리스에 리디자인 세 PR이 다 들어 있다 —
  #256 데이터(`f851a26`) · #257 홈(`ba598f5`) · #258 상세(`a0d2197`). `/api/health` 로 m3-web·mini-web 모두 `c931108`, db ok 확인.
- 시안: `docs/design/redesign-v5/home.html`, `product.html` (브라우저로 열면 그대로 보인다). 계획: `docs/superpowers/plans/2026-10-03-home-detail-redesign-v5.md`.
- 프로드 측정(2026-10-04, EXPLAIN ANALYZE): 급상승 상위 5 24ms · 이번 주 새로 나온 19ms · 급상승 순위 17ms · 같은 분야 급상승 17ms ·
  제작 도구 집계 411ms + 229ms(60초 캐시). 배포 직후 TTFB: 홈 1.06s, 상세 1.36s(/p/posthog, /p/madeira).
- 되돌리기: 직전 릴리스 `62b7c4b`(#254) 이미지로 `scripts/ops/deploy_shared_images.py`(절차는 메모리 prod-deploy-helper·runbook "공통 이미지").
  리디자인만 되돌릴 수는 없다 — #259 와 같은 릴리스에 묶여 있다.

## 바로 정할 것 하나

**`agentEvidence.displayObservedFacts` 를 켤지.** 지금 프로드는 꺼져 있어서
- 홈 "무엇으로 만들었나" 구획이 아예 안 나오고,
- 상세 "무엇으로 만들었나"가 "아직 저장소를 확인하지 않았습니다 / 흔적을 찾지 못했습니다"만 보인다.

켜면 홈에 도구 알약(Claude Code 11,798 · Codex 788 · …, 2026-10-02 집계)과 상세의 도구+모델 알약이 바로 채워진다.
비용은 위 집계 두 쿼리(0.64초)가 분당 한 번. 어디서: 관리자 수집 설정(crawl_settings) `agentEvidence.displayObservedFacts`
(`lib/crawl/settings-schema.ts:290`, 기본 false). 2026-09-06 에이전트 근거 작업 때 "관찰 사실 공개"를 보류한 설정이라 사용자가 정한다.

## 하루 뒤 확인

- 로그에 `home.list_failed`·`home.pulse_unavailable` 0건.
- TTFB 가 위 값에서 크게 벗어나지 않는지(홈 1.2초 아래).
- 홈 "지금 뜨는" 띠가 5개 다 차는지(급상승이 5개 이하면 띠가 안 나오고 피드만 보이는 게 정상).

## 남은 작업 — 우선순위 순

### A. 작은 정리 (한 PR, 30분)
1. `lib/domain/ranking/view.ts:104` 주석의 `@topbar 슬롯` 언급 — 슬롯은 없어졌다.
2. 푸터 `게재 기준` 링크가 `/launch#policy` 인데 `/launch` 에 그 id 가 없다 — id 를 더하거나 `/launch` 로.
3. `components/home/MobileNav.tsx` 발견·인기가 같은 `grid` 아이콘.
4. `components/home/icons.tsx` 에서 더 안 쓰는 아이콘(`info`·`sparkles`·`news`·`up` 등) — `rg` 로 확인 뒤 제거.
5. `app/home.css` `.wrap-break` 미사용. `.surface-dark` 에 `--accent-ink` 없음(지금 쓰는 곳 없음).
6. `app/p/[slug]/page.tsx` 가 `detail.rank`(시즌 순위)를 읽지만 쓰지 않는다 — 히어로 메타 줄에 "이번 시즌 #n" 을 되살릴지, 조회를 뺄지.
7. `listBuilders`(repository.ts)는 이제 통합 테스트만 쓴다. `SourceBadge` 는 `UnclaimedOwnerContact` 만 쓴다.
8. `tests/ui-contract.test.ts` 의 ProductHero 14px 반경 예외는 이제 아무것도 안 가린다.
9. `eslint.config.*` `globalIgnores` 에 `.crawl-samples/**`·`nomorevibe-final/**`·`prototypes/**`·`.claude/worktrees/**` — 지금 로컬 `npm run lint` 가 이 폴더들 때문에 3천 건 빨갛다(CI 는 폴더가 없어 초록).

### B. 낡은 e2e 둘 (리디자인과 무관, 같은 PR 에 넣어도 됨)
- `tests/e2e/full-catalog.spec.ts:45` — #247 이 대체 목록일 때 "주인을 기다리는 제품" 구획을 뺐는데 99장을 기대한다.
- `tests/e2e/worker-review-admin.spec.ts:43` — 07bd779 가 어드민 제목을 "AI 리뷰 운영 모드 · 관측" 그룹으로 바꿨다.

### C. 기능 후속 (각각 작은 PR)
1. **도구 알약으로 거르기** — 홈 "무엇으로 만들었나"의 알약은 지금 집계 기준 창을 연다. `?builder=` 는 메이커 신고값(3%)만 거르고
   흔적(agent_repository_observations)은 다른 표라, 흔적으로 거르는 조회(`listProducts` 옵션 `observedTool`)가 필요하다.
2. **상세 미클레임 소유자 중복** — `InfoCard` 운영 주체 줄과 `UnclaimedOwnerContact` 카드가 같은 `@owner` 를 두 번 보여 준다.
   후자를 "이 프로젝트의 운영자인가요?" 부분만 남기는 쪽을 권한다(e2e 가 그 제목과 `/nomorevibe verify` 를 본다).
3. **README 발췌 틈**(`lib/domain/products/readme-excerpt.ts`) — `&amp;` 같은 HTML 엔티티 125건, `> ` 인용 표시 348건, 80자 미만 CJK 소개는 null.
   실제 README 6,273건 비교 수치는 PR #256 본문.
4. `detail-view.ts` `toolScan` 의 "scanned" 상태에 테스트가 없다(통합 테스트에 조사 행을 심으면 됨, `tests/integration/home-pulse.test.ts` 가 심는 법을 보여 준다).
5. 검증 제품이 생기면 히어로 메타 줄에 "✓ 검증됨"(`StatusBadge` 가 아직 있다) — 지금은 검증 0 이라 영향 없음.
6. 홈 카드의 한 줄 소개가 중국어·스페인어면 그대로 나온다(시안은 손으로 옮겼었다). 번역 파이프라인(text 워커)에 소개 번역을 붙일지 결정.
7. 홈 `?saved=1` 저장 보기는 #247 이후 기본 탭에서 급상승 제품만 후보로 삼는다 — 스타가 안 는 저장 제품은 안 보인다(리디자인 전부터).

### D. 문서
- `README.md`·`docs/operations/independent-workers-runbook.md` 에 상단 띠(pulse strip) 언급 없음(확인함). `AGENTS.md` 의 13개 앱 설명은 그대로 맞다.
- 이 리디자인의 결정 기록은 메모리 `redesign-v5-2026-10-04`.

## 리디자인에서 지킨 규칙 (다음 작업자가 깨지 않게)

- UI 글자 13px 이상(시안의 12px 캡션은 전부 13px 로 올렸다), 터치 대상 44px, 색은 토큰만(hex 금지, `color-mix` 는 됨).
- 코랄 `--accent #d63a40` 은 버튼·배지·강조 단어·로고 점에만. 18px 아래 글자 링크는 `--accent-ink #c0323a`(연한 바탕에서 AA).
- AI 가 쓴 소개는 항상 "AI가 요약 · …" 표시(2026-09-20 결정). 가동 상태는 5단계(확인 전·재확인 필요·온라인·접속 확인 실패·접속 불안정).
- 모르는 사실은 적지 않는다 — 공개·활성은 확인된 값일 때만, 라이선스 충돌은 두 값 모두.
- 홈 급상승 띠(5)와 피드 `offset: 5` 는 급상승이 5개 넘을 때만, 저장 보기에선 건너뛰지 않는다(`app/page.tsx stripShown`).
