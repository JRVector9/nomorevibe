# 외부 수집 방지 A·C — PR #949

- 기준: main 7bb089d6, branch feat/anti-scrape-seo-c38c66be.
- [x] 빈 시작 커밋·브랜치 push·Draft PR 생성 및 head/base 확인.
- [x] A: robots 학습 거부·검색/답변 허용·Content-Signal, llms.txt 안내.
- [ ] C: 원본 우회 및 변환 실패 원본 fallback 제거, OG 미리보기 제한.
- [ ] tests/anti-scrape-seo*.test.ts와 관련 회귀·타입·린트.
- [ ] 운영 DB 없는 로컬 Next + curl 실제 응답 검증.
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
