# /go 서명 토큰 (PR C, 2026-11-15)

사람 결정(11/15): 제품 이름·요약 말고 프로젝트에 연결할 수 있는 정보(GitHub·사이트 주소)는 보호 API를 거치지 않고는
얻을 수 없게 한다. 운영에서 브라우저 UA로 `/go/ggml`을 부르면 302로 `https://github.com/ggml-org/ggml`을 줬다 —
slug만 알면 바깥 주소를 얻을 수 있었다.

- Draft PR: #968 (브랜치 `feat/go-signed-token-20261115`, #964 `feat/public-html-name-summary-20261115` 위에 쌓음)
- 병합·배포·운영 설정·env 변경 없음

## 동작

| 요청 | 응답 | 클릭 기록 |
|---|---|---|
| `/go/<slug>` (토큰 없음) | 302 → `/p/<slug>` | 안 함 |
| 틀린·모양이 다른·다른 제품의·만료된 토큰 | 302 → `/p/<slug>` | 안 함 |
| 서버 비밀(`VISITOR_HASH_SECRET`) 없음·32자 미만 | 302 → `/p/<slug>` (발급도 안 됨) | 안 함 |
| 유효한 토큰, 브라우저 | 302 → 바깥 주소 (지금과 같음) | 함 + `outbound_visit`(via 유지) |
| 유효한 토큰, 봇 UA | 302 → 바깥 주소 | 안 함 (기존 동작) |
| 유효한 토큰, 차단·없는 제품 | 302 → 첫 화면 (기존 동작) | 안 함 |
| IP 한도 초과(10분 60번) | 429 + Retry-After | 안 함 |

- 상세로 돌려보낼 때 언어 접두는 `?lang=`(상세 API가 기본 언어 밖이면 붙임), 없으면 같은 사이트 Referer 경로에서 읽는다.
- 모든 /go 응답: `Cache-Control: private, no-store`, `Cloudflare-CDN-Cache-Control: no-store`.
- IP 한도는 공개 API 읽기와 같은 `limitByIp`(`lib/http/anti-scrape.ts` `guardGoRedirect`, 열쇠 `go:<ip>`).
  IP를 모르면(신뢰 프록시 설정 전) 걸지 않고, 한도 표가 잠시 안 되면 막지 않는다(기존 관례). 확인된 검색 봇은 한도를 넘어도 받는다.

## 토큰

- `lib/domain/products/go-token.ts`. 토큰 = `<만료(초, 36진)>.<HMAC-SHA256(열쇠, "go\0"+slug+"\0"+만료) 앞 16바이트 base64url>`.
- 유효 시간 `GO_TOKEN_TTL_MS` = 15분(상수 하나). 만료를 TTL+1분보다 멀리 적은 토큰은 위조로 본다.
- 열쇠: 새 env 없이 `VISITOR_HASH_SECRET`에서 HKDF-SHA256(salt `nomorevibe`, info `go-link-v1`)로 파생. 방문자 HMAC 열쇠를 그대로 쓰지 않는다.
- `VISITOR_HASH_SECRET`이 두 웹 앱(web-m3·web-mini)에 같은 값으로 있다는 근거(저장소 문서, 운영 접속은 하지 않음):
  `docs/operations/production-multi-instance.env.example`(웹 공통 env 계약), `docs/operations/independent-workers-runbook.md`
  ("두 웹의 `AUTH_SECRET`, `VISITOR_HASH_SECRET` … 같게 둔다"), `compose.yml`(필수), `PENDING.md`(운영 /go HMAC 시작 기록).
  운영 값 존재·일치는 이 PR에서 직접 확인하지 않았다 — 배포 전에 `plan`의 env 이름 점검으로 확인 필요.
  두 웹의 값이 다르면 한 웹이 내준 토큰을 다른 웹이 거절해 사용자가 상세로 돌아간다(바깥 주소는 새지 않는다).

## 토큰을 내주는 곳과 쓰는 곳

- 내줌: `/api/products/[slug]/details` 응답 `go: { href, expiresAt } | null` (공개 API 읽기 관문·IP 한도·no-store).
- 씀: `components/product-detail/DetailHeroSlots.tsx`(저장소 열기·제품 방문하기), `components/product-detail/InfoCard.tsx`(웹사이트 줄).
  못 받았으면 토큰 없는 `/go/<slug>`(서버가 상세로 돌려보낸다). `DetailExtras.tsx`는 받은 값을 토큰 만료 2분 전까지만 다시 쓴다.

## /go 링크를 만드는 곳 전수 확인 (`git grep` 2026-11-15)

| 곳 | 결과 |
|---|---|
| `components/product-detail/DetailHeroSlots.tsx` (2곳) | 서명 주소로 바꿈 |
| `components/product-detail/InfoCard.tsx` (1곳) | 서명 주소로 바꿈 |
| 메일·알림(`lib/me`, `lib/social`), 스킬(`app/skill.md`, `app/install.sh`), 피드(`app/feed.xml`), 사이트맵, `llms.txt` | /go 링크 없음 |
| 관리자(`app/(operator)`), 스크립트(`scripts/`) | /go 링크 없음 |
| 카드(`components/cards`, `components/home`) | /go 링크 없음 — 상세 `/p/<slug>`로 간다 |
| `lib/analytics/dom.ts` | /go 클릭 분류(경로만 봄, 질의 무시) — 바꿀 것 없음 |
| `app/robots.ts` | `Disallow: /go/` 유지 |
| README·PENDING·옛 설계 문서 | README 갱신, 나머지는 기록이라 그대로 |

## 남은 일

- [x] 토큰 발급·검증, /go 관문, IP 한도, no-store
- [x] 상세 API·상세 링크
- [x] 시험: `tests/go-redirect-token.test.ts`, 공개 HTML `/go/`·바깥 주소 0개, 기존 /go 시험에 토큰
- [x] 로컬 화면 확인(Playwright)
- [ ] 필수 CI `check` 통과 — PR #968
- [ ] (배포 때, 이 PR 범위 밖) 두 웹 앱의 `VISITOR_HASH_SECRET` 존재·일치를 `plan`으로 확인
- 막힘 없음. 병합·배포는 사람 결정.

## 한계

- 상세를 15분 넘게 열어 두고 단추를 누르면 토큰이 지나 새 탭에 상세가 다시 열린다(그 화면의 단추는 새 토큰).
- 토큰을 받은 사람은 15분 동안 그 제품 바깥 주소로 갈 수 있다 — 바깥 주소 자체는 이미 그 상세 API 응답에 있다(보호 API 범위).
