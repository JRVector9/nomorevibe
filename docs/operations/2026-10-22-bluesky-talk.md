# Bluesky 화제 수집 (bluesky-talk)

작성: 2026-10-22 KST · 사용자 지시 "Bluesky 수집 붙이는 거 진행해 그리고 이것도 관리자에 쌓이도록해".
HN(`hn-talk`)·X 에 이어 세 번째 SNS 화제 출처다. 운영 배포 전 기록이며, 아래 실측은 로컬 테스트 DB 에 실제 Bluesky 를 읽은 것이다.

## 한눈에

| 항목 | 값 |
| --- | --- |
| 잡 | `bluesky-talk` · crawler 기본 줄 · 30분 · 틱 40초(`scripts/worker.ts`) |
| 읽는 곳 | `https://api.bsky.app/xrpc` 공개 AppView(인증 없음) — `app.bsky.feed.searchPosts`, `app.bsky.feed.getPosts` |
| 요청 | 회차당 최대 30번, 요청 사이 0.5초 이상, 응답 2MB·10초 상한, 429 를 받으면 그 회차의 남은 요청을 하지 않는다 |
| User-Agent | `nomorevibe/1.0 (+https://nomorevibe.com)` |
| 창 | 최근 72시간(HN 과 같다) — 제품에 이어진 보이는 글은 7일까지 다시 묻는다 |
| 저장 | `social_posts`(source=`bluesky`) — 주소·점수·시각만. 본문·핸들·이름·사진은 받자마자 버린다 |
| 보관 | 90일(다른 출처와 같다). 원문이 지워진 글은 내린 뒤 7일이 지나면 행째 지운다 |
| /talk 자격 | 반응(좋아요 + 재게시×2) **5** 이상 — `BLUESKY_TALK_POINTS`(`lib/social/talk-score.ts`), 무게 1 |
| 공개 표시 | 본문 없이 반응 수와 원문 링크만(X 와 같다). 마지막 확인 뒤 24시간 동안만 |
| migration | `drizzle/0115_social_posts_bluesky.sql` — 출처 제약에 `bluesky` 를 더할 뿐 |

## 수집 방식

`lib/social/bluesky-talk.ts` · `bluesky-talk-source.ts` · `bluesky-talk-store.ts` · `bluesky-link.ts`.

1. **새 글** — 최신 한 쪽(`q=*&domain=github.com&sort=latest&limit=100`)을 읽는다. 지난 회차 끝(10분 겹침) 뒤로 더 있으면
   `q=github.com` 에 `since`·`until` 시간 창을 밀어 내려간다(최대 10쪽).
   - `cursor` 로 다음 쪽을 물으면 403("administrative rules")이라 시간 창을 민다. `q=*` 는 시간 창을 받지 않아(400) 첫 쪽에만 쓴다.
   - 창을 미는 `q=github.com` 은 본문에 주소 글자가 없는 글(링크 카드만 남긴 글)을 놓친다. 30분 회차면 보통 첫 쪽(`q=*`)으로 끝나 문제가 드물다.
   - 검색은 가린 글을 빼고 주므로 100건이 안 차도(실측 99건) 끝이 아니다 — 응답의 `cursor` 를 "다음 쪽이 있다"는 표시로만 본다.
   - 시각은 밀리초까지 `Z` 로 쓴다(`+00:00`·마이크로초는 400). 창의 기준은 sortAt(작성·색인 시각 중 이른 쪽)이고, 우리 `posted_at` 도 같은 값이다.
   - 장애 뒤라 10쪽으로 모자라면 그 앞은 건너뛴다(`truncated`). 다음 단계의 반응 큰 글 읽기가 그 사이의 반응 큰 글을 채운다.
2. **반응 큰 글** — 창을 하루씩 셋으로 나눠 `sort=top` 100건씩. 점수가 오르는 글의 값을 새로 받는다.
3. **다시 묻기** — 이번에 돌아오지 않은 글을 `getPosts` 로 25건씩, 최대 12번(300건). 제품에 이어진 보이는 글(7일)을 먼저, 그다음 창 안에서 오래 확인 못 한 글.
   돌아오지 않은 글(지워짐·계정 내려감)은 `gone`(source_missing)으로 내린다. 검색이 막혀도 이 단계는 돈다.
4. **봇** — 창 안에 GitHub 링크 글이 15개 이상인 계정(`BLUESKY_BOT_POSTS`)의 보이는 글을 숨긴다.
5. **보관** — 90일 지난 글, 내린 지 7일 지난 Bluesky 글을 지운다.

평소 회차는 새 글 1 + 반응 큰 글 3 + 다시 묻기 12 = 16번쯤, 하루 800번 안팎이다. 상한 30은 안전판이다(정상 경로의 최대는 25).
관측(`social_post_observations`)은 값이 바뀔 때만 남긴다 — 다른 출처의 "6시간마다 같은 값도 한 줄"은 Bluesky 에 걸지 않는다(창 안 글이 수천 건).

### 로컬 실측 (2026-10-22 08:36~08:39 KST, 로컬 테스트 DB)

| 회차 | 요청 | 시간 | 받은 글 | 새로 넣음 | 다시 묻기 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| 첫 회차(빈 DB) | 13(새 글 10쪽 + top 3) | 7.1초 | 1,181 | 1,181 | 0 | truncated — 최근 24시간 981건까지 읽음 |
| 바로 다음 회차 | 16(새 글 1 + top 3 + getPosts 12) | 8.2초 | 394 | 4 | 300(지워진 글 0) | complete |

- 첫 회차 1,181건 중 봇으로 숨김 377건(계정 4곳), 라벨로 숨김 277건(`!no-unauthenticated` 216 · `bot` 60 · `porn` 1), 저장소 여럿 33건, 저장소 아닌 주소 18건, 못 읽은 글 1건.
- 개발 중 Bluesky 에 보낸 요청은 위 두 회차와 탐색(형식·경계 확인) 합쳐 50번 안쪽이다.

## 저장 규칙

| 글이 가리킨 것 | `link_target` | `repository_key` | `link_url` | /talk |
| --- | --- | --- | --- | --- |
| 저장소 하나(같은 저장소의 여러 주소 포함) | repo·path·issue·pull(저장소 > 저장소 안 > PR > 이슈 순으로 하나) | 소문자 owner/repo | 고른 주소 | 저장소 자체·안 경로만 순위에 센다 |
| 저장소 둘 이상(목록·비교 글) | site | 없음 | 첫 GitHub 주소 | 오르지 않음 — 관리자 까닭 "저장소 여럿" |
| 저장소가 아닌 GitHub 주소(사용자·조직·sponsors·gist·github.io) | site | 없음 | 첫 GitHub 주소 | 오르지 않음 — "저장소 아님" |
| 링크가 없음(인용 글 안의 링크로만 맞춘 글 등) | — | — | — | 버리고 `skipped` 로 센다 |

- 저장소 여럿을 첫 저장소에 붙이지 않은 까닭: 한 글이 다섯 저장소를 늘어놓으면 어느 한 곳의 화제라 할 수 없다. X 보고도 저장소 하나인 글만 받는다.
  스키마가 이미 허용하는 모양(site·키 없음)이라 migration 이 필요 없고, 관리자 화면은 "저장소 주소인데 키가 없다"로 저장소 여럿을 가려 적는다.
- 링크는 본문 링크(facet)와 링크 카드(embed·recordWithMedia) 주소만 읽는다. 본문 글자에서 주소를 캐지 않는다.
- 제목은 비운다(본문이 없다). 화면은 "Bluesky 게시물", 관리자는 "Bluesky 게시물 <rkey>" 로 그린다.

### 작성자 정보

- 작성자 칸은 없다. 글 ID(`external_id`)는 at-uri 의 `<did>/<rkey>` 다 — 원문 링크(`https://bsky.app/profile/<did>/post/<rkey>`)와
  다시 묻기(getPosts 는 at-uri 로만 묻는다)에 꼭 필요한 글 주소라 남긴다. 핸들·표시 이름·사진·본문은 zod 스키마가 버린다.
- 봇 판단은 회차마다 그 글 주소의 DID 부분으로 창 안 글 수를 세어 메모리에서만 한다. 어느 계정이 봇인지는 저장하지 않는다 — 글마다 숨긴 까닭만 남는다.
- did:web 처럼 글 ID 가 64자(칸 길이)를 넘는 글은 받지 않는다.

## 봇·라벨 — 남기되 /talk 에 올리지 않는다

수집기가 숨긴 글은 `state = hidden` 에 까닭을 단다(관리자가 숨긴 글은 `admin`). /talk·홈·상세는 보이는 글만 읽으므로 오르지 않고,
관리자 "수집한 글 전부"의 /talk 칸에 까닭이 보인다(`lib/social/talk-reasons.ts`).

| 까닭(`state_reason`) | 언제 | 풀림 |
| --- | --- | --- |
| `bot_suspected` | 창 안 GitHub 링크 글 15개 이상인 계정 | 관리자가 "다시 보이기" 하면 그 글은 다시 숨기지 않는다(state_changed_at 으로 가린다) |
| `label:!no-unauthenticated` | 로그아웃한 사람에게 보이지 않기를 원한 계정 — 우리 공개 화면은 로그아웃 화면이다 | 회차마다 다시 정한다(라벨이 떼어지면 보인다). 관리자가 풀어도 라벨이 남아 있으면 다음 회차에 다시 숨는다 |
| `label:bot` | 스스로 자동 계정이라 밝힌 계정 | 위와 같다 |
| `label:porn`·`sexual`·`nudity`·`graphic-media`·`gore` 등 | 성인·폭력 라벨(스스로 단 것이든 검토가 단 것이든) | 위와 같다 |
| `label:<값>` | `!` 로 시작하는 시스템 라벨(`!hide`·`!warn`…), spam·scam·impersonation 등 검토 라벨, Bluesky 검토 서비스(`did:plc:ar7c4by46qjdydhdevvrndac`)가 단 모든 라벨 | 위와 같다 |

- 취소된 라벨(`neg`)·만료된 라벨(`exp`)은 보지 않는다. 출처 표시 같은 스스로 단 라벨(`bridged-from-bridgy-fed-activitypub` 등)은 막지 않는다.
- 봇 숨김은 한 번 걸면 남는다(계정 글 수가 창에서 줄어도 풀지 않는다). 라벨이 떼어진 글이 봇 계정이면 같은 회차에 봇 숨김으로 돌아간다.

## 삭제·신고·연락 — Bluesky 개발자 지침 대응

`docs` 밖 원문: Bluesky Developer Guidelines(2026-10-21 조사본). 공개 화면은 `SNS_TALK_PUBLIC_ENABLED` 로 아직 꺼져 있다.

| 지침 | 대응 |
| --- | --- |
| 1. 스팸 금지(자동 상호작용·팔로·좋아요) | 읽기만 한다. 계정·로그인·쓰기 없음 |
| 2-1. 불법 콘텐츠 신고 방법 | /talk "집계 기준"에 "글쓴이가 원하면 뺍니다 — 원문을 지우거나 그 프로젝트 상세 페이지 요청 폼에 글 주소를" 안내. 요청 폼은 사람이 처리한다 |
| 2-2·2-3. 금지 콘텐츠·악성 사용자 차단 | 라벨 숨김(성인·검토·로그아웃 비공개), 봇 숨김, 관리자 숨기기·저장소 빼기 |
| 3. 삭제 요청 처리 | 원문 삭제·계정 내려감은 다시 묻기(공개 화면에 오를 글은 30분마다)로 `gone`, 7일 뒤 행째 삭제. 다시 확인하지 못한 글은 24시간 뒤 공개 화면에서 빠진다 |
| 4. 신고 응답 체계 | 요청 폼 → 관리자 감사함(기존 takedown·소개 수정 요청 흐름) |
| 5. 공개 연락처(정기적으로 보는 이메일) | **미정** — 정책 페이지는 "공개 이메일 주소는 두지 않습니다"라고 적고 있다. 공개 켜기 전에 사용자 결정 필요(PENDING.md) |
| 6. 보안 | 저장하는 것이 공개 글의 주소·수뿐이다. 토큰 없음 |

## 관리자·운영 화면

- `/admin/talk` "수집한 글 전부": 출처 거르기에 Bluesky(`?source=bluesky`), 원문 링크(bsky.app), 가리킨 주소, 연결 제품, /talk 판정과 까닭
  (봇·라벨·저장소 여럿·Bluesky 확인 24시간 지남·반응 5 미달 등). 머리글에 Bluesky 마지막 수집·마지막 오류.
- 크롤러 활동: `bluesky-talk` 이 crawler 수집기로 오르고 `social.bluesky_talk_collected`(받은 글·새로 넣음·라벨·봇 숨김·다시 묻기·지운 글·요청 수·truncated)와
  `social.bluesky_talk_failed`·`social.bluesky_talk_lookup_failed` 를 보인다. 회차마다 같은 창을 다시 센 수(found 등)는 누적에 더하지 않는다.
- 운영센터 작업 표: 수집 순서에 `bluesky-talk`(Bluesky 검색 → SNS 화제 글). 흐름 단계에는 넣지 않는다(프론티어에 넣지 않는 SNS 관측, `STAGE_EXCLUDED_JOBS`).
- 비상 모드에서는 `hn-talk` 처럼 멈춘다(`suspended`).

## 배포 순서

1. **migration** — `0115_social_posts_bluesky` 를 먼저 적용한다(`prod_db.py migrate`). 제약 하나를 다시 거는 것뿐이라 순간이다.
   앱보다 먼저여야 한다: 제약이 없을 때 새 crawler 가 bluesky 글을 넣으면 check 위반으로 그 회차가 실패한다.
2. **scheduler 2복제본** — 새 release 로 올리고 `jobs` 에 `bluesky-talk` 행과 `next_scheduled_at` 이 생겼는지 본다.
   먼저 하지 않으면 공통 배포의 crawler 관문이 `unknown_schedule` 로 멈춘다(2026-10-20 #566 때와 같다).
3. **공통 8앱**(`deploy_shared_images.py run`) — 웹·crawler 가 새 코드를 받는다. 역할마다 readiness·progress 를 본다.
4. 그 뒤 평소처럼 text·maintenance 를 같은 release 로 맞춘다(이번 변경은 그 역할 코드에 닿지 않는다).
5. 배포 뒤 첫 회차(최대 30분 안): 크롤러 활동의 `social.bluesky_talk_collected`, `/admin/talk?source=bluesky`.

되돌리기: 잡을 멈추면(운영센터 pause) 수집이 멈추고, 공개 화면의 Bluesky 글은 24시간 안에 빠진다. 글을 지우려면 `DELETE FROM social_posts WHERE source = 'bluesky'`.
제약은 bluesky 행이 남아 있는 한 되돌리지 않는다.

## 운영에서 아직 확인하지 않은 것

- 운영 첫 회차: 요청 수·시간(틱 40초 안)·429 여부, `truncated`(첫 회차는 거의 확실히 true — 최근 24시간쯤만 읽는다), 크롤러 줄 지연.
- 하루 요청 수(예상 800번 안팎)와 Bluesky 쪽 제한 — AppView 는 "넉넉하다"고만 적는다.
- 반응 5 기준이 맞는지: 2주 관측 뒤 제품에 이어진 글의 분포를 보고 다시 정한다(HN·X 기준과 같이 계획 D9).
- 봇 기준(72시간 15개)의 오탐: 사람 계정이 숨겨지는지 관리자 화면 "숨김 — 봇으로 보임"을 표본으로 본다.
- 다시 묻기가 지운 글을 실제로 내리는지(로컬 두 회차에서는 지운 글 0건).
- 관측 줄 증가량(값이 바뀔 때만) — 한 달 뒤 `social_post_observations` 크기.
- 관리자 `/admin/talk` 실물(운영 로그인 필요).
- 공개 연락처(지침 5) 결정, 공개 켜기 결정(`SNS_TALK_PUBLIC_ENABLED`).

## 다음에 할 수 있는 것

- **Jetstream**(인증 없는 공개 firehose, `wss://jetstream*.bsky.network`): 검색의 쪽 제한·`q=github.com` 누락이 없고 삭제 이벤트도 바로 온다.
  다만 상주 연결(새 역할 또는 별도 프로세스)·재연결·커서 보관이 필요해 이번에는 하지 않았다. 검색이 막히거나 누락이 커지면 이것으로 옮긴다.
- 제품에 이어진 글이 300건을 넘으면 다시 묻기 상한(12번)을 늘리거나 공개 제품 글만 먼저 묻는다.
