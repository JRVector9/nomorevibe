# 크롤러와 공개 근거 점검 — 2026-09-06

점검 시각: 2026-09-06 07:20–07:25 KST. 요청은 전체 점검과 개선 검토이며, 이번 작업은
조회·재현·검토 문서 작성이다. 애플리케이션 코드, DB 데이터, 스케줄러 설정은 변경하지 않았다.

## 실제 실행 상태

| 항목 | 개발 환경 localhost:3000 | Docker 환경 localhost:3200 |
|---|---|---|
| PostgreSQL 포트 | 55434 | 55437 |
| 공개 제품 | 34개: seeded 32, verified 2 | 1,004개: 모두 seeded |
| 마지막 crawl-fetch | 8/18 15:01 KST | 9/6 07:19 KST 조회 당시 |
| product-evidence-refresh | 실행 기록 없음 | 실행 중, 마지막 9/6 06:53 KST |
| 저장소 주소가 있는 제품 | 32개 | 1,004개 |
| repository 링크 행 | 0개 | 1개 |
| 저장소 주소는 있으나 수집 링크가 없는 제품 | 32개 | 1,003개 |
| 저장된 상세 근거 | 0개 | GitHub 1개 |

Docker의 seed/fetch/judge/publish가 호출되고 있다. 큐는 done 4,646개, pending 0개였고
후보는 published 1,004 / rejected 3,424 / needs_review 218개였다. fetch의 빠른 성공은
현재 처리 대기 항목이 없는 상황과 일치한다. 이는 상세 근거 수집이 충분하다는 뜻이 아니다.

개발 환경은 GITHUB_TOKEN과 CRON_SECRET이 설정돼 있다. 토큰은 실제 GitHub 읽기 요청에서
정상 동작했다. 비밀값은 출력하지 않았다. `npm run dev` 자체는 스케줄러를 시작하지 않는다.

## 발견 사항과 우선순위

### P1 — 제품 발행과 상세 근거 수집 사이의 연결 누락

`lib/crawl/publish.ts`는 `products.repoUrl`만 저장한다. `lib/domain/products/register.ts`와
`manage.ts`의 기본 저장소 등록/변경도 같은 필드를 사용한다. 반면
`lib/domain/evidence/refresh.ts`의 `dueEvidenceProductSlugs`와 `declaredSources`는
`product_links`를 읽는다. 제품 repository의 `insert`도 링크를 생성하지 않는다.

실제 개발 DB로 `dueEvidenceProductSlugs`를 호출한 결과는 `[]`였다. 따라서 지금 상태에서
개발 스케줄러만 켜거나 해당 제품을 강제 갱신해도 이 누락은 해결되지 않는다.
상세 read model 역시 연결된 source를 요구하므로, 주소가 저장돼 있는데도 화면은
TradingGoose를 “저장소 미제공”, “연결된 공식 링크가 없습니다”로 표시한다.

개선: 저장소 주소와 근거 링크의 정합성 규칙을 정하고 등록·발행·수정 경로에 적용한다.
기존 제품은 URL 정규화와 중복 방지를 갖춘 재실행 가능한 backfill로 연결한다.
수집 제품은 discovered 출처를 유지하고 메이커 선언으로 둔갑시키지 않는다.
메이커가 숨기거나 삭제한 링크를 backfill이 되살리지 않도록 예외 정책도 필요하다.

### P1 — 수집 성공이 공개 링크의 확인 상태에 반영되지 않음

수집기는 `product_evidence_sources.state/last_success_at`을 갱신하지만
`product_links.verification_state/verified_at`을 갱신하지 않는다.
`detail-view.ts`의 `visibleLinks`와 `linkEvidenceLabel`은 후자만 읽는다.

실데이터 `pi-coding-agent`는 source=ok, 마지막 성공 9/6 06:53 KST인데,
link=unobserved, verified_at=NULL이다. 브라우저에서 같은 페이지에
“GitHub에서 확인”, “최신”과 “공식 출처 0”, “메이커 제공·미검증”, “확인 대기”가 함께 나온다.

개선: 링크 표시는 연결된 source의 관측 결과·시각·관계 상태에서 일관되게 도출하는 편이
중복 상태를 줄인다. HTTP 도달 확인, GitHub 객체의 사실 확인, 해당 제품과의 관계 확인을
구분한다. `providers/links.ts`의 일반 링크·Play Store·changelog는 도달 여부 위주이므로
성공한 모든 source에 “공식 출처”를 일괄 부여하면 안 된다. 실패 후 마지막 정상 값은 유지하되
최근 확인 실패/지연을 함께 표시한다.

### P1 — 오래된 측정값을 현재 온라인으로 표시

`components/product-detail/ProductHero.tsx`는 checkedAt이 있고 down이 아니면 온라인으로
표시하며 측정 시각의 나이를 검사하지 않는다. TradingGoose 화면은 마지막 검사
8/18 15:22 KST를 근거로 9/6에도 “온라인”이라고 표시했다.

개선: 가동 상태의 유효기간을 정의하고 초과하면 “마지막 확인 당시 정상 · 갱신 지연”처럼
시점을 표현한다. 최근 검사 실패가 down 임계치 미만일 때의 문구도 함께 검증한다.

### P2 — 공식 사이트 관측과 자동 발견 경로가 연결돼 있지 않음

`siteObservedRepository`는 provider=product_site, type=site_fingerprint의 repositoryKeys를
읽지만 앱의 수집 경로에 이 정보를 쓰는 코드가 없다. 관련 통합 테스트는 직접 해당 행을
만든다. `updates.ts`에 사이트 변화용 함수가 있어도 현재 잡에서 연결해 호출하지 않는다.

따라서 메이커가 링크와 미디어를 제출하지 않은 제품은 소개·갤러리·문서·RSS·changelog가
자동으로 채워지지 않는다. GitHub README 조회도 현재는 저장소→사이트 관계 확인에 사용하며
소개/스크린샷 추출로 연결되지 않는다. 스토어와 패키지의 세부 facts도 공개 read model은
저장소처럼 별도 정보 블록으로 내보내지 않는다.

개선: 제품 사이트와 README의 명시적 링크를 후보로 발견하고 출처별 검증을 수행한다.
소개는 “공식 사이트 설명” 또는 “README 설명”으로 출처·수집 시각·원문을 붙이고,
내용 자체의 사실 검증과 구분한다. 이미지는 기존 내부 저장 파이프라인을 통과시킨다.
TradingGoose 사이트는 실제 HTTP 200, www 호스트의 /en으로 이동하며 본문 약 1.17 MB였다.
새 사이트 수집기는 응답 상한·리다이렉트·SSRF 정책을 고려하고 일반 링크의 64 KiB 상한을
그대로 재사용하지 않아야 한다.

### P2 — 수집률과 미완료 작업을 운영 화면에서 놓침

`getEvidenceStatusSummary`는 이미 존재하는 source 행만 센다. source 자체가 없는 제품은
due/stale/failed 어디에도 나타나지 않는다. 작업 러너의 성공은 핸들러가 반환했다는 뜻이며
처리 건수 0 또는 개별 제품 실패도 작업 성공으로 남을 수 있다.

`scripts/scheduler.sh`는 근거 갱신을 360틱마다 호출하고 러너 기본 예산은 25초다.
커서를 저장한 미완료 배치를 이어받으려면 다음 360틱을 기다린다. 링크 1,003개를 연결한 뒤
얼마나 빨리 한 바퀴 도는지는 실측해야 한다. “6시간마다 실행”을 “모든 제품 6시간 내 갱신”으로
해석할 수 없다. 틱 간 sleep에 작업 실행 시간이 더해져 벽시계 간격도 늘어난다.

개선: 출처별 nextAttemptAt 간격은 유지하되 작업자는 짧은 간격으로 큐를 이어받는다.
전체 대상 / 링크 미연결 / 최초 수집 대기 / 최신 성공 / 실패 / 최장 지연 및 처리량을
운영 화면에 표시하고 최근 실행 환경의 origin도 명확히 한다.

## TradingGoose에서 지금 확보 가능한 정보

인증된 GitHub API의 repository/languages/contributors/releases/readme 5개 읽기 요청이
모두 HTTP 200이었다. 아래 값은 조사 시점의 외부 원본이며 아직 제품 DB에 반영하지 않았다.

| 정보 | 확인 결과 | 공개 표현 |
|---|---|---|
| 저장소 | TradingGoose/TradingGoose-Studio, 공개, 비보관, 비포크 | GitHub에서 확인 |
| 생성일 | 2025-11-18T18:05:18Z | 저장소 생성일; 서비스 출시일과 구분 |
| 최근 push | 2026-09-04T17:47:17Z | GitHub 최근 push |
| stars / forks | 137 / 11 | 수집 시각을 함께 표시 |
| 기여 계정 | 페이지당 1개 응답의 마지막 페이지 4 | GitHub 기여 계정 4개; 팀원 수와 구분 |
| 언어 | TypeScript, MDX, Python, CSS 등 | 저장소 언어 비율; 전체 기술 스택과 구분 |
| 라이선스 | GitHub 식별 AGPL-3.0 | GitHub 라이선스 식별 결과 |
| 최신 릴리스 | v2026.07.26, 2026-07-26T20:20:10Z | 릴리스 원문 연결 |
| 저장소→사이트 | homepage=https://TradingGoose.ai | 제품 사이트 연결 관측 |
| 사이트→저장소 | 최종 사이트 HTML에 해당 GitHub URL 존재 | 전용 수집기로 저장 후 양방향 근거 표시 |

원문: https://github.com/TradingGoose/TradingGoose-Studio
및 https://github.com/TradingGoose/TradingGoose-Studio/releases/tag/v2026.07.26
및 https://www.tradinggoose.ai/en

제작 AI의 “Codex · 우리 추정”은 별개다. 커밋 트레일러나 설정 파일 존재는 관측할 수 있지만
실제로 어떤 AI가 전체 제품을 만들었는지는 확정하지 못한다. 커밋 URL·관측 시각 등 구체적인
신호를 붙일 수는 있어도 제작 AI 확정 배지로 바꾸지 않는다. 메이커/가격/팀/운영 단계도
신고·외부 설명·직접 관측을 항목별로 구분한다. 저장소 owner를 메이커로 단정하지 않는다.

## 실행 순서와 완료 기준

1. 등록/발행/수정→링크→수집→상세 표시까지 이어지는 회귀 테스트를 먼저 추가한다.
2. 저장소 링크 동기화와 기존 제품 backfill을 구현하고 누락 제품 수가 해소되는지 확인한다.
3. 수집 결과에서 공개 라벨/시각/요약을 도출하고 오래된 가동 상태 표현을 수정한다.
4. 개발 환경 스케줄러를 별도로 연결하고 짧은 간격의 bounded worker로 근거 큐를 처리한다.
   기존 Docker DB와 개발 DB는 독립적으로 유지하며 어느 환경을 갱신하는지 명시한다.
5. TradingGoose를 실제 공급자로 갱신해 저장소·라이선스·릴리스 표시와 원본을 대조한다.
6. 사이트/README의 명시적 링크·소개·이미지 수집, 스토어/패키지 정보 표시를 확장한다.

검증에는 backfill 재실행/숨김 보존/잘못된 URL/기존 메이커 링크 보존, 수집 성공 후
공식 근거 요약 정합성, 실패 후 기존 facts 유지, 출처 미연결 집계, 오래된 온라인 표시,
커서 연속 처리, 네트워크를 호출하지 않는 상세 렌더링을 포함한다.

## 실제 수행한 검증과 한계

- 두 DB의 jobs/products/links/sources 및 Docker scheduler/app 로그를 읽어 위 수치를 확인했다.
- 개발 DB에서 실제 `dueEvidenceProductSlugs` 읽기 호출: 대상 0개 재현.
- Playwright headless로 TradingGoose(3000), pi-coding-agent(3200) DOM 확인:
  모두 HTTP 200, pageerror 0개. 전체 사이트 QA나 모든 API 검증은 아니다.
- `npx vitest run tests/github-evidence.test.ts tests/evidence-links.test.ts tests/product-detail-components.test.tsx`:
  존재하는 2개 테스트 파일, 18개 테스트 통과. `tests/evidence-links.test.ts`는 없는 경로여서
  추가 테스트가 실행된 것으로 계산하지 않았다. 기존 Vite config 경고와 의도된 rate-limit 로그가 있었다.
- 통합 테스트·전체 테스트·빌드는 이번 검토에서 실행하지 않았다.
- browser 스킬의 agbrowse는 PATH에 없고 로컬 wrapper도 cli.mjs 의존성이 없어 실패했다.
  저장소에 설치된 Playwright로 읽기 전용 브라우저 확인을 완료했다.
- 최초 crawl_settings 조회는 enabled를 일반 컬럼으로 잘못 읽어 실패했다.
  실제 JSONB values->>'enabled'로 재조회해 두 환경 모두 true임을 확인했다.
