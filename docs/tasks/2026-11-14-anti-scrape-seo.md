# 외부 수집 방지 A·C — PR #949

- 기준: main 7bb089d6, branch feat/anti-scrape-seo-c38c66be.
- [x] 빈 시작 커밋·브랜치 push·Draft PR 생성 및 head/base 확인.
- [x] A: robots 학습 거부·검색/답변 허용·Content-Signal, llms.txt 안내.
- [x] C: 원본 우회 및 변환 실패 원본 fallback 제거, OG 미리보기 제한.
- [x] tests/anti-scrape-seo*.test.ts와 관련 회귀·타입·린트.
- [x] 운영 DB 없는 로컬 Next + curl 실제 응답 검증.
- [ ] 의미별 커밋·push, 같은 PR의 필수 check 성공 확인, 보고함 제출.

## 경계와 결정

- 원본 체크아웃, lib/rate-limit.ts, middleware/proxy, app/api/products/** 변경 없음.
- 운영 DB 접근·병합·배포·Cloudflare 변경 없음.
- Next 16.4의 robots `other` 필드 사용(설치된 docs/robots.md 및 serializer 확인).
- 검색/답변 봇과 Google-Extended는 기존 wildcard 허용을 상속한다. 별도 허용 그룹으로 기존 금지 경로를 우회시키지 않는다.
- 확장자 없는 OG 주소는 SNS 호환 JPEG, 화면용 .webp는 WebP. 기존 sharp·VariantCache 재사용.
- CI는 Draft check를 실패시키므로 로컬 검증 뒤 같은 PR을 ready로 전환한다. CI 정책 변경·우회 없음.

실제 시험 결과·공식 출처·Cloudflare 인계는 완료 시 이 문서에 기록한다.

## 공식 문서 확인 (2026-11-14)

- [OpenAI bots](https://developers.openai.com/api/docs/bots): GPTBot 학습 거부, OAI-SearchBot·ChatGPT-User 검색/사용자 요청 유지.
- [Anthropic robots](https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler): ClaudeBot 학습, Claude-SearchBot·Claude-User 검색/답변.
- [Common Crawl CCBot](https://commoncrawl.org/ccbot): 공개 코퍼스 수집, 공식 Disallow 예시.
- [Amazon bots](https://developer.amazon.com/amazonbot): Amazonbot은 모델 학습에도 사용. Amzn-SearchBot·Amzn-User는 검색/답변이며 허용 유지.
- [Google crawler reference](https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers): Google-CloudVertexBot은 사이트 소유자 요청 Vertex AI Agents 크롤러(학습 전용으로 단정하지 않음). 사람의 명시 목록에 따라 차단. Google-Extended는 학습과 grounding 제어를 함께 하지만 사람 확정대로 차단하지 않음. ai-train=no 정책 표기는 유지.
- [Applebot](https://support.apple.com/en-ie/119829): Applebot-Extended는 학습 사용 제어 토큰, Applebot 검색과 별도. 추가 차단.
- [Ai2 crawler](https://allenai.org/crawler): AI2Bot으로 공개 언어 모델 학습. 추가 차단.
- [ByteDance training-data disclosure](https://lf3-static.bytednsdoc.com/obj/eden-cn/lapzild-tss/ljhwZthlaukjlkulzlp/transparency/20260803/Public%20Summary%20of%20Training%20Data%20Content%20for%20Seedance%202.5.pdf): Bytespider 학습·시험·검증 수집 명시. [Cloudflare 관리 robots 공식 예시](https://developers.cloudflare.com/bots/additional-configurations/managed-robots-txt/)에서도 Bytespider·meta-externalagent 등 차단 토큰 확인.
- [Meta crawler operator page](https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/): 이번 직접 열기는 HTTP 429. 직접 읽었다고 주장하지 않으며, Meta-ExternalAgent 토큰은 위 Cloudflare 공식 예시와 사람 지정 목록 근거로 유지. facebookexternalhit 및 다른 검색/답변 fetcher는 wildcard 허용.
- [Cohere](https://docs.cohere.com/v2/docs/cohere-web-crawlers): 현재 학습용 crawler를 쓰지 않는다고 명시. 표의 실제 bot 이름 N/A; 가상의 예시 Coherebot 등을 추가하지 않음.

robots는 자발적 준수 신호이며 요청 자체의 접근 통제가 아니다. 이 PR은 SEO/AEO 허용과 학습 거부 의사를 분리한다.

A 검증: `npx vitest run tests/anti-scrape-seo-robots.test.ts tests/anti-scrape-seo-llms.test.ts tests/robots.test.ts` — 3파일 31시험 통과. robots 동일 시험은 변경 전 17통과/10실패 → 변경 후 27통과/0실패. 원본 실패 로그 보존.

C 검증: `npx vitest run tests/anti-scrape-seo-og.test.ts tests/og-variants.test.ts` 최초 14시험 통과 후, 애니메이션 fixture에 실제 프레임 수 단언을 추가해 1실패 발견. 같은 프레임이 GIF encoder에서 합쳐진 fixture를 `keepDuplicateFrames`로 고쳤으며 최종 Node 24 범위 7파일 61시험 통과. 원본 소스 PNG 4,039,433바이트가 1200×630 이내 JPEG로 축소됨. 세부 최종 HTTP 수치는 아래에 기록.

## 로컬 HTTP 실측

Node 24.22.1 / Next 16.4.1 Turbopack, 환경파일을 제외한 scratch 사본 + 작업 전용 loopback PostgreSQL 합성 fixture. 운영 DB 접근 없음.

| curl 경로 | 상태 | 실제 응답 |
|---|---|---|
| `/robots.txt` | 200 | text/plain 401B, Content-Signal·9학습 토큰·기존 금지·정식 sitemap 확인 |
| `/llms.txt` | 200 | text/plain UTF-8 1480B, max-age=300 / s-maxage=3600 |
| `/api/og-cache/seo-fixture` | 200 | JPEG 1200×630, 4,769B (변경 전 같은 PNG fixture 4,039,433B) |
| `/api/og-cache/seo-fixture.webp?size=1200` | 200 | WebP 1200×630, 1,452B |
| `/api/og-cache/seo-broken` | 422 | 원본 없는 JSON 51B, private/no-store |

명령: `curl --max-time 90 -sS -D <name>.headers http://127.0.0.1:3189/<path> -o <body>` 뒤 `sharp(...).metadata()`와 상태·크기 단언. 결과 파일 `http-verification.json` 및 응답 헤더/본문은 작업 artifacts에 보존.

초기 실패도 보존: symlink node_modules + webpack에서 기존 instrumentation 의존성 `stream` 해석 오류로 500. 실제 복사한 의존성 + 기본 Turbopack으로 해결(제품 코드/설정 변경 없음). `/llms.txt`의 기존 locale rewrite 308 루프는 lib/i18n/routing.ts의 기계 경로 목록에 추가해서 해결; middleware/proxy 파일 변경 없음. proxy 모듈 HMR이 이전 판정을 유지해 서버 재시작 후 200 확인. Python urllib.robotparser는 longest-path 우선 규칙을 구현하지 않아 이 사이트의 Allow /·Disallow /api/ 검증기로 쓰지 않음. 최종 정책 시험은 Next 실제 serializer 출력의 최장 일치 규칙을 검사한다.

## 사람이 Cloudflare에서 맞출 점

- 검색 엔진·AI 검색/답변·SNS 미리보기 요청은 허용하고 학습용 봇만 차단. User-Agent 단독으로 신원을 신뢰하지 않고 Cloudflare의 검증 정보와 대조.
- Managed robots / Bot Preference Sync가 Google-Extended Disallow를 추가하거나 ai-input 정책을 덮어쓰지 않는지 확인. 관리 기본 예시에는 Google-Extended 차단이 있어 사람 확정 정책과 다르다. 앱에서 낸 robots 정책을 보존하는 구성을 선택해야 한다.
- 배포를 사람이 승인한 뒤, 기존 `/api/og-cache/<slug>`와 `.webp` 및 쿼리별 CDN 사본을 purge하고 새 응답의 형식·크기 확인. 기존 태그 `og-<slug>` 유지. robots·llms 캐시도 갱신.
- 공개 HTML의 기존 60~240초 캐시 유지. robots·llms·허용 검색/답변/미리보기 요청에 CAPTCHA나 일괄 AI 차단을 적용하지 않도록 검토.
- robots/llms는 자발적 정책이며 대량 수집의 기술적 차단은 별도 작업의 rate limit/IP/Cloudflare 설정에 달림. 이 PR에서 변경하지 않음.

배포 준비 대상: 위 robots/llms/OG 코드와 시험. 이 작업에서 병합·배포·운영 DB·Cloudflare 설정 변경은 하지 않음. 실제 외부 검색/SNS 크롤러의 운영 재수집 확인은 배포 후 사람 검증 사항이다.

## 최종 로컬 검사

- `npx next typegen`: 통과.
- Node 24.22.1 `node node_modules/typescript/bin/tsc --noEmit --incremental false`: 최종 소스에서 exit 0, 진단 없음.
- `npx eslint app/robots.ts app/llms.txt/route.ts 'app/api/og-cache/[slug]/route.ts' lib/domain/products/og-variants.ts lib/i18n/routing.ts tests/anti-scrape-seo*.test.ts tests/og-variants.test.ts`: exit 0, 진단 없음.
- `npx vitest run tests/anti-scrape-seo*.test.ts tests/og-variants.test.ts tests/robots.test.ts tests/product-json-ld.test.ts tests/p12-cards-images.test.tsx tests/detail-html-slim.test.tsx tests/public-translation-languages.test.ts tests/render-recovery-proxy.test.ts`: 9파일 77시험 통과. anti-scrape-seo는 3파일 37시험.
- `git diff --check`: 통과. 수동 전체 unit·전체 DB·전체 build는 정책에 따라 실행하지 않음. 필수 GitHub CI는 그대로 실행·확인 예정.
- 화면 변경 없음. OG JPEG/WebP는 실제 HTTP 본문을 sharp로 디코딩하여 크기와 형식 확인. 운영 SNS/검색 재수집이나 배포 완료로 표현하지 않음.

품질: 동일 robots 정책 시험 17/27 → 27/27; 합성 OG 응답 4,039,433B/1600×840 PNG → 4,769B/1200×630 JPEG. 측정 명령은 위 시험 및 curl+sharp. 운영 트래픽/차단율/SEO 순위 측정 없음(운영·Cloudflare 접근 범위 밖).

남은 일: 원격 필수 CI check 확인과 보고함 제출. 로컬 차단 사항 없음.

## CI 피드백 후 범위 내 보완

첫 ready CI `43572289837`의 build는 Next 컴파일이 아닌 `scripts/bundle-size.mjs`에서 실패했다. 같은 Node24·환경파일 없는 scratch 빌드로 main과 head를 비교했다. 홈 JS가 main 179,328B (한도179,336B, 여유8B) → 최초 head179,393B가 되어 57B 초과했다. llms 기계 경로를 추가한 같은 함수만 정리하여 동등한 접두사/기계 파일 판정을 한 정규식으로 합쳤다. 기존 API/admin/공개 식별자/비슷한 이름을 유지하는 회귀 시험을 보강했다. 기준선·허용 폭·CI 설정·middleware/proxy 변경 없음.

최종 `next build` 및 `node scripts/bundle-size.mjs` 통과:

| 경로 | main br bytes → 최종 br bytes | 기존 한도 |
|---|---|---|
| `/[locale]` | 179,328 → 179,258 | 179,336 |
| `/[locale]/p/[slug]` | 195,980 → 195,910 | 197,314 |
| `/[locale]/launch` | 160,224 → 160,154 | 168,273 |

최종 범위 시험 9파일78시험(anti-scrape-seo38)·변경 파일 ESLint 통과. 최종 Node24 `NODE_OPTIONS=--max-old-space-size=4096 node node_modules/typescript/bin/tsc --noEmit`도 통과. 실제 로컬 production Next 서버에서 `/robots.txt` 200/401B와 `/llms.txt` 200/1480B 재확인(경로 함수 최종 소스).

첫 CI typecheck는 TypeScript 진단 대신 exit134로 종료(로컬 동일4GiB 모드 통과). 원격 상세 로그는 REST 한도 소진으로 아직 읽지 못했으므로 OOM 등 원인을 확정하지 않는다. REST reset08:11:32Z까지 해당 자원 호출 중단; 별도 GraphQL resource로 상태 확인. 수정 head의 필수 CI 결과와 최종 인계는 PR 본문 및 보고함 첨부 완료 보고서에 기록한다. 이전 실패/미완료 실행은 성공으로 기록하지 않는다.
