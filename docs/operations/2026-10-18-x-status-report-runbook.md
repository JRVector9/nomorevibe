# X 수집기 하루 보고(x-status) — 보내는 쪽 계약과 켜는 법

운영센터 v8 PR9. X 수집기(osaka-smoke, `nomorevibe-x.service`)가 하루 한 번 자기 상태를 **서명한 push** 로
웹에 보낸다. 웹은 관측 표(`operations_observations`)의 `x-status` 한 줄만 덮어쓴다.
Tailscale 로 끌어오는 길 대신 이 길을 고른 까닭은 v8 계획(공개 쓰기 주소 1개, Cloudflare 가 막으면 그 주소만 예외)과 같다.

- 받는 주소: `POST https://nomorevibe.com/api/ops/x-status` — **공개 쓰기 주소 1개**다.
- 받는 코드: `app/api/ops/x-status/route.ts`, `lib/operations/x-status-receive.ts`, 형식·읽기는 `lib/operations/x-status.ts`.
- 보내는 코드: `lib/social/x-report.ts`(SNS 화제 C안 T18 에서 수집기와 함께 main 으로 들어왔다). 수집기가 매 실행 끝에
  이 문서의 계약대로 한 번 보낸다. 수집기 설치·운영은 `docs/operations/2026-10-15-x-osaka-smoke-runbook.md` 를 따른다.
- 같은 비밀로 게시물 보고(`/api/ops/x-posts`)도 보낸다 — 아래 "게시물 보고(x-posts)".

## 켜기 전(지금 배포 상태)

웹에 `X_STATUS_REPORT_SECRET` 이 없으면(또는 32바이트 미만이면) 주소는 **404** 이고 본문·DB·로그를 보지 않는다.
운영센터 조치에도 아무것도 뜨지 않는다. 그래서 이 PR 을 배포해도 바뀌는 것이 없다.

## 받는 쪽이 하는 일 — 검사 순서

1. 설정: 비밀이 없으면 404.
2. 크기: `content-length` 가 4,096바이트를 넘거나 실제 본문이 넘으면 413. 본문은 5초 안에 와야 한다(408).
3. 시각: `x-nmv-timestamp` 가 10자리 유닉스 초가 아니거나 웹 시계와 **±300초** 밖이면 401.
4. 서명: `x-nmv-signature` 가 지금 비밀 또는 직전 비밀의 HMAC 과 상수 시간 비교로 맞지 않으면 401.
5. 형식: `content-type: application/json`(415), UTF-8 JSON, 아래 칸 그대로(400).
6. DR 관문: 여기서 처음 DB 를 본다(웹 쓰기 관문의 fence 캐시). fenced 사이트면 503.
7. 단조: 저장된 보고의 `x-nmv-timestamp` 보다 **같거나 오래된** 보고는 409(다시 보내기 거절).
8. 속도: 마지막으로 받은 지(DB 시계) **60초 안**이면 429 `Retry-After: 60`.
9. 쓰기: 쓰기 TX(첫 lock 은 fence SHARE)에서 `x-status` 한 줄을 조건부 upsert 한다. 같은 조건을 다시 걸어
   동시에 온 둘 중 하나만 쓴다(진 쪽은 409).

1~5 는 DB 를 보지 않는다. 6~8 의 거절은 읽기만 한다. 주 DB 의 새 부하는 **받은 보고마다 작은 쓰기 하나**다
(속도 제한도 같은 줄의 받은 시각으로 재서 `rate_limits` 줄을 따로 쓰지 않는다).

## 본문

```json
{"v":1,"mode":"live","reads":{"used":10,"limit":10},"candidates":3,
 "lastRunAt":"2026-10-18T00:10:01.000Z","lastSuccessAt":"2026-10-18T00:10:01.000Z","error":null}
```

| 칸 | 값 | 규칙 |
| --- | --- | --- |
| `v` | `1` · `2` | 판 번호. 다른 값은 400. `2` 는 아래 칸에 `query` 한 칸이 더 있다(2026-10-21) |
| `mode` | `live` · `dry-run` · `disabled` | 실제 수집 · 시험 실행 · 일부러 끔 |
| `reads.used` / `reads.limit` | 정수 | 0 ≤ used ≤ limit ≤ 1,000. 오늘(UTC) 예약한 읽기 수 / 하루 상한(지금 10) |
| `candidates` | 정수 0~1,000 | 마지막 실행이 남긴 고유 저장소 후보 수 |
| `lastRunAt` | UTC ISO 또는 `null` | 마지막 실행 시각. 보낸 시각(+1초)보다 뒤일 수 없다 |
| `lastSuccessAt` | UTC ISO 또는 `null` | 마지막 정상 실행. `lastRunAt` 이 있어야 하고 그보다 뒤일 수 없다 |
| `error` | `null` 또는 코드 | `^[a-z][a-z0-9_]{0,47}$` — 본문에서 유일한 자유 글자(v2 는 `query.reason` 도) |
| `query`(v2 만) | `{"source","repositories","reason"}` | 그날 검색어. `source` 는 `products`(웹이 고른 우리 제품 저장소) · `default`(고정 검색어), `repositories` 0~1,000, `reason` 은 `null` 또는 `error` 와 같은 꼴의 코드(고정 검색어로 돈 까닭) |

칸이 더 있거나 빠지면 400 이다. 게시물 본문·작성자·저장소 이름·토큰·원 응답은 보내지 않는다.
수집기는 그날 검색 저장소 묻기(아래 "검색 저장소 묻기")에 답을 받았을 때만 v2 로 보내고, 그 밖에는 v1 이다 — 옛 웹도 계속 받는다.

수집기 `status.json`(`runXCollector` 결과)에서 채우는 법:

- `mode`: 실제 호출 설정(`X_COLLECTION_LIVE=1`)이면 `live`, 아니면 `dry-run`. 타이머를 일부러 멈추거나 승인을 거둔 때 보내는
  마지막 보고는 `disabled`.
- `reads.used` = `reservedPosts`(그날 예약 장부가 있으면 10), `reads.limit` = 10.
- `candidates` = `candidates`, `lastRunAt` = `observedAt`.
- `lastSuccessAt` = 수집기가 따로 들고 있는 "마지막으로 `completed`(live) 또는 `planned`(dry-run) 로 끝난 실행"의 `observedAt`.
- `error`: `status` 가 `blocked`·`stopped` 이고 `reason` 이 `daily_limit` 이 아니면 그 `reason`(규칙에 안 맞으면 `unknown`),
  그 밖에는 `null`. `daily_limit`(오늘 이미 읽음)은 정상이다.

## 서명

```text
x-nmv-timestamp: <유닉스 초, 10자리>
x-nmv-signature: v1=<HMAC-SHA256 소문자 hex 64자>

서명할 바이트 = "nomorevibe-x-status-v1\n" + <x-nmv-timestamp 와 같은 글자> + "\n" + <보내는 본문 바이트 그대로>
```

본문은 서명한 바이트 그대로 보낸다(다시 직렬화하지 않는다). 보내는 쪽 예시(Node 24, 비밀은 환경에서만 읽는다):

```ts
import { createHmac } from "node:crypto";
const body = JSON.stringify(report), timestamp = Math.floor(Date.now() / 1000);
const signature = "v1=" + createHmac("sha256", process.env.X_STATUS_REPORT_SECRET!)
  .update(`nomorevibe-x-status-v1\n${timestamp}\n`).update(body).digest("hex");
const response = await fetch(process.env.X_STATUS_REPORT_URL!, { method: "POST", body, signal: AbortSignal.timeout(10_000),
  headers: { "content-type": "application/json", "x-nmv-timestamp": String(timestamp), "x-nmv-signature": signature } });
```

비밀을 명령 인자·로그·Git 에 남기지 않는다(`openssl dgst -hmac <비밀>` 처럼 인자로 넘기는 검증 명령도 쓰지 않는다).

## 응답과 수집기의 처리

| 상태 | `error` | 뜻 | 수집기 |
| --- | --- | --- | --- |
| 200 | — (`{"accepted":true}`) | 받음 | 끝 |
| 404 | 본문 없음 | 웹에 비밀이 없다(꺼짐) | 다시 보내지 않는다. 웹 설정 확인 |
| 401 | `x_status_timestamp_invalid` | 시각 틀림·±300초 밖 | 서버 시계(NTP) 확인 |
| 401 | `x_status_signature_invalid` | 비밀·서명 틀림 | 비밀·서명 문자열 확인 |
| 400 · 413 · 415 · 408 | `x_status_payload_invalid` 등 | 형식·크기 | 보내는 코드 버그. 다시 보내지 않는다 |
| 409 | `x_status_not_newer` | 같거나 새 보고가 이미 있다 | 다시 보내지 않는다 |
| 429 | `x_status_rate_limited` | 60초 안에 또 보냄(수동 실행을 겹쳐 돌린 때) | 다시 보내지 않는다. 다음 실행에 맡긴다 |
| 503 | `x_status_unavailable` | DR fenced 사이트 | 다음 날 보고에 맡긴다 |

수집기(`sendSigned`)는 한 번만 보내고 응답 코드나 `timeout`·`network` 를 `status.json` 의 `reports` 에 남긴다.
손으로 다시 보낼 때는 언제나 새 `x-nmv-timestamp` 로 다시 서명한다(같은 것은 409). **보고가 실패해도 수집을 다시 돌리지 않는다** —
하루 10개 장부를 지키기 위해서다. 보고 실패는 웹 쪽 "끊김"으로 드러난다.

## 운영센터 조치 — "X 보고 끊김/오류"(`x-status`)

- 늘 `hold` 이고 쌓인 일(`BACKLOG_KEYS`)이라 **확인함 · 7일 숨김**이 된다. 처음 뜬 날은 다른 쌓인 일처럼 "새로 생김"으로 지금 조치에 선다.
- 숫자 단위는 "시간": 끊김은 마지막으로 받은 때(DB 받은 시각)부터, 오류는 마지막 성공부터(없으면 받은 때부터).
- 띄우는 때: 마지막 보고가 **26시간** 넘게 없음(끊김) · 마지막 보고에 `error` 가 있음(오류) · 저장된 줄을 읽지 못함.
- 띄우지 않는 때: 웹에 비밀이 없음 · 아직 받은 보고가 없음(연결 전) · 마지막 보고가 `disabled`.
- 새 쿼리는 없다. 운영센터가 이미 읽는 관측 줄(`operationsData().observations`)에서 꺼낸다.

## 켜는 순서

비밀 설정·배포·수집기 변경은 사용자 승인 뒤 운영 절차로 한다(이 PR 은 하지 않았다).

1. 비밀을 만든다: `openssl rand -hex 32`. 키체인 등 비밀 저장소에만 둔다. 다른 비밀(CRON_SECRET 등)과 재사용하지 않는다.
2. 웹 두 앱(M3·mini)의 Dokploy 환경에 **같은 값**의 `X_STATUS_REPORT_SECRET` 을 넣고 웹만 재배포한다. 워커는 이 비밀이 필요 없다.
   요청은 두 웹 중 어느 쪽으로도 갈 수 있어, 한쪽에만 있으면 다른 쪽으로 간 보고는 404 가 된다.
   확인: 서명 없는 `POST /api/ops/x-status` 가 404 가 아니라 401 이면 켜진 것이다(여러 번 보내 두 웹 모두 401 인지 본다).
3. Cloudflare 확인(아래)을 dry-run 보고로 한다.
4. 수집기 쪽: root 전용 env(`/etc/nomorevibe-x.env`)에 `X_STATUS_REPORT_SECRET`·`X_STATUS_REPORT_URL`
   (게시물도 받으려면 `X_POSTS_REPORT_URL`)을 두고, 보내기를 넣은 새 릴리스를 osaka runbook 대로 배치한다.
   비밀이 있는데 주소가 하나도 없거나, 주소가 https 가 아니거나 사용자 정보·조각이 있으면 수집기는 설정 오류로 멈춘다.
5. `dry-run` 으로 수동 실행 1회 → 200. 읽기 전용 조회로 줄을 본다:
   `select value, observed_at from operations_observations where key = 'x-status';`
   `observed_at` 은 DB 시계(UTC 벽시계)다. 경과는 SQL 로 잰다.
6. 다음 날 00:10 UTC 정기 보고가 들어오는지 본다. 26시간 넘게 없으면 조치에 끊김이 뜬다.

끄기: 웹에서 비밀을 지우면(404, 조치 없음) 끝이다. 수집을 일부러 멈출 때는 마지막 보고를 `disabled` 로 보내면
웹 비밀을 둔 채로도 끊김이 뜨지 않는다.

## 비밀 교체 — 비밀 2개, 4단계

1. 웹(두 앱 모두): `X_STATUS_REPORT_SECRET_PREVIOUS` = 지금 비밀, `X_STATUS_REPORT_SECRET` = 새 비밀 → 웹 재배포. 이제 둘 다 받는다.
2. 수집기: 새 비밀로 바꾼다.
3. 확인: 다음 보고(또는 수동 실행) 뒤 `x-status` 줄의 `value->>'signedWith'` 가 `current` 인지 본다
   (웹 로그 `x_status.accepted` 의 `signedWith` 도 같다).
4. 웹(두 앱 모두): `X_STATUS_REPORT_SECRET_PREVIOUS` 를 지우고 재배포한다. 옛 비밀은 이제 401 이다.

직전 비밀은 지금 비밀과 다르고 32바이트 이상일 때만 쓴다. 유출이 의심되면 1단계에서 `_PREVIOUS` 를 두지 않고 바로 바꾼다
(그 사이 보고가 401 이 되어 다음 날 끊김이 뜰 수 있다).

## Cloudflare — 브라우저가 아닌 POST (2026-10-20 확인: 막지 않음)

2026-10-20 16:08 KST osaka-smoke(Node `fetch`)가 보낸 두 보고가 모두 200 이었다. 지금 설정으로는 예외 규칙이 필요 없다.
설정을 바꾼 뒤 보고가 403 이 되면 아래로 확인한다.


웹은 Cloudflare → Tunnel → Traefik 뒤에 있다. Bot Fight Mode·관리형 챌린지·Browser Integrity Check 같은 설정은
브라우저가 아닌 POST(Node `fetch`, Oracle Osaka IP)를 403 챌린지로 막을 수 있다. GitHub 웹훅 주소도 같은 앞단을 지나지만
이 저장소 문서에서 실제 전달 성공 기록을 찾지 못했다(2026-10-11·10-12 기록은 웹훅 미검증) — 근거로 쓰지 않는다.

- 확인: 위 5단계의 dry-run 보고 1회. 앱이 답하면 JSON 본문과 `cache-control: private, no-store` 가 있다.
  Cloudflare 가 막으면 HTML 본문, `server: cloudflare`, 흔히 `cf-mitigated: challenge` 머리가 온다.
- 막히면: 그 **주소 하나만** 예외로 둔다. 예: WAF 사용자 규칙
  `http.request.method eq "POST" and http.request.uri.path eq "/api/ops/x-status"` → 해당 보안 기능 건너뛰기.
  요금제에 따라 Bot Fight Mode 는 규칙으로 건너뛸 수 없을 수 있으니 실제 화면에서 확인한다.
  인증은 앱의 서명이 하므로 이 예외로 열리는 것은 없다(서명이 틀리면 DB 전에 401).

## 게시물 보고(x-posts) — SNS 화제 C안 T18

수집기가 **실제 수집(live)을 끝낸 실행에서만**, 보낼 게시물이나 사용 불가 ID 가 있을 때 한 번 보낸다. dry-run·막힘·실패에는 보내지 않는다.
웹은 `social_posts`(source=`x`)에 넣고 값이 바뀐 글만 `social_post_observations` 에 한 줄 남긴다(HN 수집과 같은 표·같은 규칙).

- 받는 주소: `POST https://nomorevibe.com/api/ops/x-posts` — 공개 쓰기 주소가 하나 더 는다. Cloudflare 예외가 필요하면 이 주소도 함께 둔다.
- 받는 코드: `app/api/ops/x-posts/route.ts`, `lib/operations/x-posts-receive.ts`, 형식은 `lib/operations/x-posts.ts`.
- 비밀·머리·검사 순서·응답 표는 하루 보고와 같다. 다른 점만:
  - 서명 머리는 `nomorevibe-x-posts-v1` — 하루 보고의 서명을 이 주소에 다시 쓸 수 없다(401).
  - 본문은 16,384바이트까지. 오류 코드 머리는 `x_posts_`.
  - 단조·속도는 관측 표의 `x-posts` 한 줄로 따로 잰다. 그 줄과 게시물 쓰기는 **한 트랜잭션**이라 쓰다 실패하면 줄도 남지 않는다.
  - 200 본문은 `{"accepted":true,"inserted":n,"updated":n,"gone":n}`.

```json
{"v":1,"observedAt":"2026-10-21T00:10:01.000Z",
 "posts":[{"id":"1980000000000000001","createdAt":"2026-10-20T12:00:00.000Z","repository":"acme/tool",
           "metrics":{"like":40,"reply":6,"repost":9,"quote":2}}],
 "unavailable":["1980000000000000009"]}
```

| 칸 | 규칙 |
| --- | --- |
| `observedAt` | 수집기가 검색한 UTC ISO 시각. 보낸 시각(+1초)보다 뒤일 수 없다 |
| `posts` | 0~10개. 저장소 하나만 가리키고 반응 네 칸이 모두 있는 공개 게시물만 |
| `posts[].id` | X 게시물 ID(숫자 글자 1~20자, 0 으로 시작 않음) |
| `posts[].createdAt` | 작성 시각. `observedAt` 보다 뒤일 수 없다 |
| `posts[].repository` | `owner/repo` 하나(`.`·`..` 불가). 웹은 소문자로 저장소 열쇠를 만든다 |
| `posts[].metrics` | `like`·`reply`·`repost`·`quote` 정수 0~10억, 넷 다 있어야 한다 |
| `unavailable` | 0~10개 ID. 이번 검색에서 사용할 수 없다고 나온 게시물 — 이미 받은 보이는 글이면 `gone`(`source_unavailable`)으로 내린다 |

한 ID 는 `posts`·`unavailable` 을 통틀어 한 번만 나온다. 칸이 더 있거나 빠지면 400. 본문·작성자·프로필·원 응답은 보내지 않는다(재배포는 ID 중심).

**v2(2026-10-21) — 검색이 돌려준 글을 버리지 않는다.** `v: 2` 이고 `posts[]` 의 `repository` 대신 `repositories`(0~5곳, 대소문자를 무시해도
겹치지 않게)를 싣는다. 반응 네 칸이 모두 있는 공개 글이면 저장소가 없거나 여럿이어도 싣는다. 나머지 칸·서명·검사는 v1 과 같다.
웹이 넣는 모양(마이그레이션 없음 — `social_posts` 의 `site` 는 저장소 열쇠가 없다):

| 가리킨 저장소 | `link_target` | `repository_key` | `link_url` |
| --- | --- | --- | --- |
| 하나 | `repo` | 그 저장소 | `https://github.com/<저장소>` (v1 과 같다) |
| 여럿, 그중 공개 제품이 있음 | `repo` | 보낸 순서에서 처음 나오는 공개 제품의 저장소(같은 트랜잭션에서 `products` 를 본다) | 그 저장소 |
| 여럿, 공개 제품 없음 | `site` | 없음 | 첫 저장소 |
| 없음 | `site` | 없음 | `https://x.com/i/web/status/<ID>` |

`site` 글은 공개 화면(/talk·홈·상세·'아직 공개 제품이 아닌 저장소' 수)에 오르지 않고 `/admin/talk` 에만 보인다.

웹이 쓰는 값: 제목은 비우고(화면은 "X 게시물"로 그린다), 링크는 `https://github.com/<repository>`, 점수 = `like + repost×2`,
댓글 칸 = `reply`. 화제 자격은 점수 50 이상, 출처 무게 0.6(`lib/social/talk-score.ts`).

**공개 화면에는 마지막으로 확인한 뒤 24시간만** 보인다(`lib/social/talk.ts` 의 `X_FRESH_MS`) — X 정책은 API 로 최신 상태를 확인한
콘텐츠만 표시하게 한다. 수집기는 하루 한 번 최근 24시간을 다시 검색하므로, 다시 잡히지 않은 글은 하루 뒤 /talk·홈·상세에서 빠진다
(관리자 `/admin/talk` 에는 남는다). 공개 화면 자체는 여전히 `SNS_TALK_PUBLIC_ENABLED` 로 꺼져 있다.

확인(읽기 전용): `select value, observed_at from operations_observations where key = 'x-posts';`,
`select external_id, repository_key, points, comments, state, last_seen_at from social_posts where source = 'x' order by last_seen_at desc limit 20;`

## 검색 저장소 묻기(x-query) — 2026-10-21

수집기가 매 실행 처음(예약 장부보다 먼저) 그날 검색할 우리 제품 저장소를 묻는다. 고르는 법과 수집기 쪽 동작은
[osaka runbook](2026-10-15-x-osaka-smoke-runbook.md)의 "검색어 — 우리 제품 저장소"다.

- 받는 주소: `POST https://nomorevibe.com/api/ops/x-query` — 공개 주소가 하나 더 는다. Cloudflare 예외가 필요하면 이 주소도 함께 둔다.
- 받는 코드: `app/api/ops/x-query/route.ts`, `lib/operations/x-query-receive.ts`, 형식은 `lib/operations/x-query.ts`, 고르기는 `lib/social/x-query.ts`.
- 비밀·머리·검사 순서는 하루 보고와 같다. 다른 점만:
  - 서명 머리는 `nomorevibe-x-query-v1` — 다른 두 주소의 서명은 여기서 401 이다.
  - 본문은 `{"v":1,"day":"YYYY-MM-DD"}` 하나(256바이트까지). `day` 는 `x-nmv-timestamp` 의 UTC 날짜와 같아야 한다(아니면 400). 오류 코드 머리는 `x_query_`.
  - 단조·속도 제한은 없다. 대신 관측 표의 `x-query` 한 줄(`{v:1, day, after, next}`, 그날 차례가 시작한 곳·다음 날 시작할 곳)을 쓰기 TX 에서
    잠그고 날이 바뀐 첫 물음에만 고쳐 쓴다 — 같은 날 다시 물으면 같은 목록이다. 이 줄을 쓰므로 DR 쓰기 관문을 지난다(fenced 사이트면 503).
  - 공개 제품 읽기는 복제본에서 한다(안 되면 주 DB). 공개 제품 수만큼 작은 줄을 하루 한두 번 읽는다.
- 200 본문: `{"v":1,"day":"2026-10-21","repositories":["owner/repo",…]}` — 소문자 owner/repo, 감싼 검색어 512자 안에 드는 만큼(10~13곳).
  수집기는 날짜가 다르거나, 40곳을 넘거나, 이름 꼴이 어긋나면 받지 않고 고정 검색어로 돈다.
- 이 주소에 답한 웹은 게시물·하루 보고 v2 를 받는다(같은 변경으로 들어왔다). 수집기는 답을 받은 날만 v2 로 보낸다.

확인(읽기 전용): `select value, observed_at from operations_observations where key = 'x-query';` · 웹 로그 `x_query.served`(day·repositories·candidates·next).
