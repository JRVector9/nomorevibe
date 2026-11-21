# JS로 그리는 앱의 2차 갈림 보류 — 실제 렌더 표본과 렌더 재수집 (2026-11-17)

사람 요청(2026-11-17): "JS로 그리는 앱 갈림 건도 검토해보는게 좋을거같아. 프로덕트가 맞으면 최대한 살려야하니까."
PR: #983 (`fix/js-shell-render-review-20261117`). 병합·배포·운영 DB 쓰기·재심사 apply 는 하지 않았다.

## 상태 (이 구역의 남은 일)

| 항목 | 상태 |
| --- | --- |
| 표본 30건(+예시 3건) 실제 Chromium 렌더·분류 | 끝남 (아래 표) |
| 1차 직전 렌더 재수집(화면 서버 재사용)·심사 입력 교체 | 끝남 (코드·시험) |
| 렌더 출처를 심사 입력에 싣기(정책 글은 그대로) | 끝남 |
| 재심사 도구 `scripts/js-shell-review-requeue.ts` count·dry-run·apply | 끝남 (apply 는 실행하지 않음) |
| 시험 `tests/js-shell-render-review.test.ts`·`tests/integration/js-shell-render-review.test.ts` | 끝남 |
| 배포 | 남음 — 사람 결정. `scope` = full(18앱 전부, `unclassified_runtime_change`) |
| 이미 보류된 것 재심사 apply | 남음 — 배포 뒤 사람 허락으로 (아래 절차) |
| 캔버스 앱(그려도 글자가 없는 게임) 살리기 | 막힘 아님·범위 밖 — 글이 아니라 스크린숏 판정이 필요(다음 단계 제안) |
| 2026-11-21 점검 보완(983-A~E) | 끝남 (코드·시험) — 아래 「2026-11-21 보완」 |
| PR #1020 리뷰 보완(BLOCKER·MAJOR·MINOR) | 끝남 (코드·시험) — 아래 「PR #1020 리뷰 보완」·「배포·되돌리기 주의」 |

## 1. 표본 조사

### 뽑은 SQL (운영 DB 읽기 전용 트랜잭션, 2026-11-17 07:5xZ)

```sql
begin read only; set local statement_timeout='60s';
with last as (
  select distinct on (s.candidate_id) s.candidate_id, s.second_decision, s.second_reason, s.created_at
  from second_reviews s join crawl_candidates c on c.id = s.candidate_id
  where c.state = 'needs_review' and c.reason = 'second_review_split'
  order by s.candidate_id, s.id desc)
select c.id, c.repo, c.product_url, d.page_status, d.page_meta->>'title' as title, d.page_meta->>'textSample' as text_sample
from last l join crawl_candidates c on c.id = l.candidate_id
join crawl_documents d on d.repo = c.repo
where l.second_decision = 'reject'
  and l.second_reason ~* '(only (the )?(product''?s? )?(name|title)|app shell|client-rendered|enable javascript|loading|did not render|visible text is empty|pageText is empty|no visible (content|text))'
  and c.product_url is not null
order by md5(c.repo || '2026-11-17') limit 30;
```

이 정규식(2차 사유 글자)에 걸린 보류는 1,132건, 그중 `app shell|client-rendered|enable javascript|did not render` 만은 613건이다(대표 근사 670건과 같은 범위).
예시 3건(hsyo830/sowondeung·daelong/mochipet-rpg·danielkim614/super-bible-verse-party)은 따로 그렸다.

### 렌더 방법

저장소의 `lib/screen-review/renderer.ts renderPage`(운영 화면 서버와 같은 코드 — egress 프록시·1280×800·domcontentloaded + 5초 idle + 1.5초)로
gpu3090 에서 헤드리스 Chromium(Playwright 1.62)으로 그렸다. 동시 3개, 33건 모두 성공(실패 0). 그리기 시간 중앙값 5.2초 · p90 8.5초 · 최대 14.7초.

### 분류 (표본 30건)

| 분류 | 건수 | 비율 | 예시 |
| --- | ---: | ---: | --- |
| 실제 동작하는 제품(렌더 글자로 내용 확인) | 21 | 70% | freshly.cooking(냉장고 관리), pokedoko(포켓몬 GO 플래너), Beat the Pile(채용 검색), PowerAgent(Harvard SEAS 프로젝트 홈), 개인 프로필(jacktreadwell.com) |
| 동작하는 제품이지만 캔버스라 렌더 글자가 거의 없음 | 3 | 10% | Ponger-up(퐁 게임, 글자 0), NYC Heroes(캔버스 게임, 글자 0), pixel-splats(3D 픽셀 뷰어, 34자) |
| 로그인 벽 | 4 | 13% | DuoJazz(로그인만), Pubky Passport(구글 로그인 + 설명), Adimat(매장 ID·PIN + 설명), CoverWatch(/login 으로 넘어감 + 설명·데모 계정) |
| 빈 페이지·템플릿 | 2 | 7% | bseorogue(그려도 빈 보라 화면), Blogify(v0 생성 랜딩, 글 목록 Loading) |
| 404·배포 사라짐 | 0 | 0% | (30건 모두 200) |

예시 3건은 모두 동작하는 제품이다 — 모찌펫(마당·사냥터 RPG, 렌더 106자), 성경 암송 파티(/join 팀 고르기, 119자), 소원등(3D 숲, WASD 안내, 87자).
스크린숏: 보고의 `shots/`·`sheet-0..2.jpg`(33장 모음).

### 지금 껍데기 판정(`pageTextShell`)이 고르는 것

표본 30건 중 수집 본문이 껍데기로 판정되는 것은 10건(제목만 4·제목+로딩 2·제목 밖 낱말 4개 이하 4), 그중 9건이 그린 뒤 뜻있는 글이 됐다
(못 살린 1건은 캔버스 게임 Ponger-up). 예시 3건은 3건 모두 고르고 3건 모두 뜻있게 그려진다.
나머지 20건은 수집 본문이 이미 길다(최대 2,123자) — 2차가 본문의 로딩 조각을 보고 "이름뿐"이라 거절한 것으로, 렌더로 입력이 달라지지 않는다(아래 남은 일).

운영 전체(읽기 전용, 07:5xZ): 자동·미발행 2차 갈림 보류 3,708건 중 주소가 있고 본문 300자 이하인 것 1,189건, 그중 껍데기 346건
(제목만 145 · 제목 밖 낱말 4개 이하 175 · 제목+로딩 22 · JavaScript 안내 4). 세 번째 표로 거절된 것(`second_review_split_qwen_reject`) 92건 중 36건도 같은 꼴이다(도구 대상 아님).

## 2. 고른 해법과 이유

**추천 = (a) 렌더 재수집 + (b) 입력 쪽 출처 표시 + (c) 재심사 도구. 정책 글(빈 화면 규칙)은 한 글자도 바꾸지 않는다.**

- 표본의 70%가 실제 제품이고 빈 화면은 1건뿐이다. 문제는 규칙이 아니라 입력이다 — 수집기(정적 HTML)가 클라이언트에서 그리는 앱의 본문을 못 읽었다.
  정책은 이미 "방문자가 보는 글"로 판단하라고 한다. 그린 글이 곧 방문자가 보는 글이므로 그 글을 pageText 로 주면 규칙을 바꾸지 않고 살아난다.
- 그린 뒤에도 빈 화면·로그인 화면·출시 예정이면(`renderedTextMeaningful` false) 수집 본문 그대로 → 지금처럼 규칙대로 거절된다. 빈 껍데기·미완성은 계속 걸러진다.
- 프롬프트 글(`REVIEW_SYSTEM_PROMPT`, Qwen v2 덧붙임)을 고치면 `REVIEW_PROMPT_VERSION` 을 올려야 하고, 그러면 `reviewPolicyHash` 가 바뀌어 진행 중인 모든 심사
  (보류 3,884·승인 대기 217)가 낡은 것이 되어 다시 돈다. Qwen v2 덧붙임은 sha 로 측정에 묶여 있다. 그래서 (b) 예외는 프롬프트가 아니라 입력에 싣는다:
  그린 글을 쓸 때만 `product.renderedPage = { source: "browser_render", note, crawlerPageText, finalUrl, renderedAt }`. 1차·2차·판가름·감사가
  같은 입력(`createReviewInput`)을 보므로 둘이 일관된다. 그리지 않은 후보의 입력 해시는 그대로다.

### 바뀐 규칙(한국어)

- 정책 글: 바꾸지 않았다. "본문이 비었거나 제목뿐이면 README 가 뭐라 해도 거절"은 그대로다.
- 입력: 수집 본문이 JS 앱 껍데기(비었음 · 로딩만 · JavaScript 안내 · 제목만 · 300자 안에서 제목+로딩 문구 · 300자 안에서 제목 밖 낱말 4개 이하)면
  1차 직전에 실제 브라우저로 한 번 그린다. 그린 글이 껍데기가 아니고(빈 화면 규칙 다섯 가지에 안 걸림) 제목 밖 낱말이 5개 이상이며 수집 본문보다 많으면,
  그 글이 pageText 가 되고 "브라우저로 그린 글이며 빈 화면 규칙은 이 글에 건다"는 출처 설명이 입력에 붙는다.
- 그리지 못하면(실패·시간 초과·화면 서버 탈·설정 없음) 또는 그린 글도 껍데기면 지금과 같다.

## 3. 구현

| 파일 | 내용 |
| --- | --- |
| `lib/crawl/shell-render.ts` | 껍데기 판정(`pageTextShell`)·뜻있는 렌더(`renderedTextMeaningful`)·기록 모양(`page_meta.renderedPage`, 껍데기 지문에 묶음)·입력용(`reviewRenderedPage`) |
| `lib/crawl/jobs/shell-render-document.ts` | `ensureShellRender` — 화면 서버(`requestRender`) 호출, 실패 기록·기다림·물러나기 |
| `lib/crawl/jobs/agent-review.ts` | 1차 틱에서 README 확인 바로 뒤에 `ensureShellRender` |
| `lib/crawl/agent-review-contract.ts` | `buildReviewProduct` 가 뜻있는 렌더면 pageText 교체 + `renderedPage` |
| `lib/crawl/repository.ts` | `setRenderedPage`(README 와 같은 원본 판 대조 — µs `fetched_at` 안전), 다시 수집 때 껍데기가 그대로면 렌더 기록을 옮김, 원본 바뀜 비교에서 렌더 기록 제외 |
| `lib/crawl/js-shell-requeue.ts`·`scripts/js-shell-review-requeue.ts` | 재심사 도구 |

### 렌더 비용·어디서 도는가·실패 처리

- **어디서**: reviewer 역할(M3 주·mini 예비, 역할 lease 로 하나만)의 1차 잡 `crawl-agent-review`. 그리기는 m1-studio 화면 서버(이미 운영 중 —
  `operations_observations.screen-review` 07:51Z health ok·sandbox·한중일 글꼴)를 부른다. reviewer 두 앱에는 `SCREEN_RENDER_URL`·`SCREEN_RENDER_TOKEN` 이 이미 있다
  (화면 판별 잡이 4,072건 썼다). **새 환경변수·마이그레이션·새 잡 없음.**
- **시간**: 한 건 중앙값 약 5초(표본), 상한 45초(서버 40초 + 주고받기), 틱 끝 12초 전에는 시작하지 않는다. 그린 뒤 그 틱에 모델을 부를 시간이 모자라면
  다음 틱에 바로 심사한다(그린 글은 남아 있다).
- **동시 실행**: 프로세스 안에서 한 줄로 차례대로(동시 1). 화면 서버의 동시 상한(기본 2)을 화면 판별 줄과 나눠 쓴다.
- **양**: 껍데기만 그린다. 운영 보류 기준 껍데기 비율 약 29%(346/1,189, 주소 있고 300자 이하 중) — 새 후보에서도 같은 비율이면 1차의 일부만 몇 초씩 늘어난다.
- **실패**: 2026-11-21 보완으로 바뀌었다 — 아래 「2026-11-21 보완」. 화면 서버 설정이 없으면 그리지 않는다. 재현 실행(replay)에서는 그리지 않는다.
- **다시 수집**: 렌더 기록은 (주소 + 수집 본문)의 지문에 묶인다. 다시 받은 본문이 같으면 옮겨 오고 후보를 new 로 되돌리지 않는다. 본문이 바뀌면 버리고 다음 1차에서 다시 그린다.

### 2026-11-21 보완 (PR 점검 983-A~E)

- **순서(983-A)**: 1차는 규칙 갈림(스팸 의심·규칙 거절·이미 등재·금지·근거 보류 — `prepareAgentReviewRules`)을 먼저 보고, 모델을 부를 후보만 그린다.
  스팸 의심(`spamSignals`)은 `ensureShellRender` 안에서도 한 번 더 막는다(재심사 도구 경로). 그린 글은 규칙 갈림에 들어가지 않으므로 그린 뒤의 갈림은 같은 답이다.
- **실패 셈(983-B)**: 원본에 적는 실패는 페이지 탓(화면 서버가 그 페이지 실패로 답함)뿐이다 — 10분 뒤 한 번 더, 두 번이면 수집 본문으로 심사하고(unavailable),
  그 바퀴의 첫 실패에서 24시간 뒤 새 바퀴로 다시 그린다(후보가 1차·재심사 도구로 다시 올 때만, 하루 한 바퀴 이하).
  붐빔(429 — 프로세스 15초 쉼)·취소·틱 끝 때문에 줄인 상한의 시간 초과(물러나지 않음)·화면 서버 탈(1분→15분 물러남)은 세지도 적지도 않고 1차가 기다린다(`render_deferred`·`render_window`).
  이 기다림은 이 프로세스가 화면 서버 쪽 사정으로 그 껍데기를 처음 못 그린 때부터 1시간까지다(틱에 그릴 시간이 없었을 뿐·취소는 시계를 열지 않는다).
  넘으면 한 번 더 시도해 보고 또 서버 쪽 사정이면 지금 원본으로 심사하며, 물러나는 중이면 시도 없이 보낸다(아래 「다시 보기 보완」). 온전한 그리기 상한은 50초(서버 40초 + 답 받기).
- **나이(983-C)**: 그린 글은 7일이 지나면 1차가 쓰기 전에 다시 그린다. 지문(주소 + 수집 본문)이 바뀌면 그 기록은 버린다(예전 그대로).
  심사 입력은 나이를 보지 않고 그 지문의 마지막 성공 기록을 쓴다 — 공개분 감사·재판정의 입력이 시계로 흔들리지 않게(공개분의 얇은 글은 감사 화면 판별이 새로 그린다).
  입력에 그린 시각(renderedAt)을 싣지 않는다 — 다시 그려 글이 같으면 입력 해시도 같고, 글이 바뀌면 해시가 바뀌어 기존 재심사 흐름을 탄다.
- **끄는 스위치(983-D)**: 실시간 한도 `jobs.crawl-agent-review.shellRender`(1 켬·0 끔, 기본 1) — 관리자 「실시간 한도」의 1차 심사 줄에 보인다. 재배포·env 없이
  워커가 30초 안에 다음 틱부터 읽는다. 끄면 새로 그리지 않을 뿐 이미 그린 글은 입력에 그대로 쓴다(입력 해시 유지). 감사 화면 판별(`audit-screen-review`)은 이 칸을 읽지 않는다.
- **다른 사이트(983-E)**: 그린 화면의 `finalUrl` 호스트가 제품 주소의 호스트(www. 무시)나 그 하위 도메인이 아니면 그 글을 쓰지 않는다(`rendered_offsite` → 수집 본문).
  공개 접미사 목록 없이 보수적으로 가른다(위 도메인으로 넘어간 것도 쓰지 않는다).
- **하지 않은 것(983-F 등)**: 살린 제품의 발행 검색 문서·AI 소개·검색 프로필·감사 얇은 글 관문은 여전히 수집 본문을 본다. items 소비자(AI1 items 모드)에는 그리기가 없다(꺼지면 안전하게 꺼진다).
  `stubTextRules` 를 enforce 로 바꾸면 껍데기는 규칙에서 거절돼 그리기에 닿지 않는다.
  공개된 껍데기의 수집 본문이 바뀌면 그린 기록이 버려져 공개분 재판정 입력이 수집 본문으로 돌아간다(공개분은 다시 그리지 않는다).

### PR #1020 리뷰 보완 (2026-11-21)

- **그린 글의 jsonb 정리(BLOCKER)**: 짝 없는 UTF-16 서로게이트·NUL 이 든 그린 글은 원본 쓰기(jsonb)를 22P02 로 실패시켜, 레인이 던지고 1차 틱 전체가
  매 틱 같은 후보에서 멈췄다(옆의 정상 후보도 심사되지 않음). 이제 화면 서버 답을 받는 자리(`render-client.ts requestRender` — 화면 판별·소개 보조도 함께)와
  기록(`renderedPageSuccess`, 자른 뒤)에서 `jsonbSafeText`(`toWellFormed()` + NUL 빼기)로 거른다. 화면 서버 쪽 `normalizeRenderedText` 도 같게 했다(m1 을
  다시 띄워야 반영 — 없어도 워커 쪽에서 막힌다). 그래도 그린 기록 쓰기가 실패하면(lease 잃음·DR 쓰기 막힘은 그대로 던진다) 그 후보만 그리지 않은 것으로 보고
  지금 원본으로 심사한다(`crawl.agent_review_shell_render_skipped` reason `record_failed`, code `record_failed_<SQLSTATE>` — 쿼리 글·값은 남기지 않는다).
- **CLI 40초 틱(MAJOR)**: 그리기 상한을 「틱 끝 − 가장 짧은 모델 상한 − 3초」 안으로 줄여, 그린 뒤 같은 틱에 모델을 부를 수 있게 했다. 그 안에 12초가 안 남으면
  틱 끝까지 온전한 상한(50초)을 줄 수 있을 때만 그린다(모델은 다음 틱). 줄인 상한에서 시간이 다 된 껍데기는 다음에 온전한 상한을 줄 수 있는 틱에서 그린다
  (CLI 틱처럼 줄 수 없으면 줄여서라도). 1시간 기다림이 지났으면 물러나는 중엔 시도 없이 심사하고, 아니면 모델 시간 안의 상한으로 한 번 시도한 뒤 같은 틱에 심사한다.
- **다시 그리기 실패가 좋은 글을 지우지 않음(MINOR)**: 페이지 실패 기록이 앞선 성공을 `last` 로 품는다. 입력은 새 성공까지 그 글을 쓴다(입력 해시 그대로).
  새로 그린 글이 껍데기·다른 사이트면 그 성공이 앞선 글을 대신한다.
- **m1 쪽 실패를 후보 탓으로 세지 않음(MINOR)**: `page_browser_failed` 는 화면 서버 탈처럼 물러난다. 서버 쪽 상한(40초) 초과(`page_timeout`)는 세지 않고
  기다리며, 서로 다른 껍데기 3개에서 이어지면(사이에 다른 답 없음) m1 과부하로 보고 물러난다.
- **줄에 선 후보(MINOR)**: 앞 틱에서 예약을 쥐고 줄에 선 후보(pending hint)는 그리지 않고 줄에 설 때의 입력으로 심사한다(`pending_reservation`) — 그리는 사이
  예약이 만료되거나 입력이 바뀌어 `pending_hint_mismatch` 가 되지 않게.
- **시험 공백(MINOR)**: 「원본 바뀜」 비교(`judgementPageMeta`)의 그린 기록 빼기를 지우면 실패하는 통합 시험을 두었다(옮겨 오지 못한 기록이 있는 원본의 같은 본문 재수집).
- **남긴 것**: 줄인 상한의 시간 초과가 이어질 때 물러나기(리뷰 제안 3)는 넣지 않았다 — 기다림 상한(1시간)과 모델 시간 안의 상한으로 기아는 없어졌고, 느린
  페이지 하나가 프로세스 전체를 물러나게 하지 않게 하려는 983-B 와 부딪친다. 같은 정리가 감사 화면 판별·소개 보조의 다른 jsonb 쓰기에도 필요한지는 따로 보지
  않았다(이번에 받는 자리에서 걸러 함께 막힌다).

### PR #1020 다시 보기 보완 (4be83326 이후)

- **MAJOR-2 — 기다림 시계**: 1시간 기다림 시계는 화면 서버 쪽 사정(물러남·탈·붐빔·시간 초과·원본 쓰기 일시 오류)으로 미룰 때만 연다. 틱에 그릴 시간이 없어서
  (`render_window`)·취소로 미룬 것은 열지 않는다 — 열면 CLI 틱(한 틱에 껍데기 하나쯤만 그린다)·적체·`--no-render` 일괄 되돌리기에서 늦게 돌아온 껍데기가
  m1 이 멀쩡해도 그려지지 않았다. 시도 전 만료 판정은 서버가 지금 나쁘다고 알려졌을 때(물러나는 중)만 한다. 그 밖에는 한 번 더 시도해 보고(모델 시간 안의
  상한이라 틱을 먹지 않는다) 또 서버 쪽 사정이면 지금 원본으로 심사한다.
- **MINOR-A — 멈춘 화면 서버와 CLI 틱**: 틱 끝 때문에 줄인 상한의 시간 초과도 서버 쪽 시간 초과(`page_timeout`)와 같이 「서로 다른 껍데기의 연속 시간 초과」로
  센다. 3개면 탈로 보고 물러나고, 한 번 물러난 뒤 성공 없이 또 시간 초과면 바로 다시(두 배로) 물러난다. 한 껍데기가 거듭하는 것으로는 물러나지 않는다(느린
  페이지 하나가 프로세스를 멈추지 않게). 후보의 시도로는 세지 않는다.
- **MINOR-C — 원본 쓰기 일시 오류**: 그린 기록 쓰기 실패 중 데이터·한도 오류(22xxx·54xxx)만 `record_failed`(그 후보를 지금 원본으로 심사)다. 그 밖(55P03 잠금
  시간 초과·40001·40P01·57014·연결 오류·SQLSTATE 없음)은 그 후보만 다음 틱으로 미룬다(`record_deferred_<SQLSTATE>` — 기다림 시계를 연다. 1시간 넘게 이어지면
  지금 원본으로). 어느 쪽도 틱 전체를 멈추지 않는다.
- **MINOR-D**: 화면 서버 쪽 `normalizeRenderedText` 의 `toWellFormed()` 를 고정하는 시험을 두었다.
- **MINOR-B(기록만)**: 모델 창을 가장 짧은 상한으로 잡으므로, Grok(90초)과 CLI(20초)가 섞인 순위에서 긴 상한 모델에 배정된 껍데기는 그린 뒤
  `tick_window_closed` 로 한 틱 늦는다. 그린 기록이 남아 다음 틱에 바로 심사된다.

### 배포·되돌리기 주의 (PR #1020 리뷰 MINOR)

- **스위치 칸을 저장한 뒤 되돌리기**: `jobs.crawl-agent-review.shellRender` 를 한 번이라도 저장한 뒤 이 판 이전으로 되돌리면, 옛 web 의 실시간 한도 저장이
  모든 그룹에서 `unknown_job_knob:crawl-agent-review.shellRender` 로 거절된다(읽는 쪽은 issue 만 남기고 돈다). 되돌리기 **전에** 그 칸을 지운다 —
  관리자 「실시간 한도」에서 「기본값으로」, 또는 `saveRuntimeSettings({ "crawl-agent-review": null }, actor, { group: "jobs", expectedRevision })`.
  배포 중(섞인 판)에도 web 이 모두 새 판이 되기 전에는 이 칸을 저장하지 않는다.
- **옛 crawler 의 다시 수집**: 옛 판 crawler(M3·mini — Oracle 은 crawler 역할을 돌리지 않는다)는 그린 기록을 옮기지 않고 그 차이를 「원본 바뀜」으로 보아,
  그린 기록이 있는 미발행 auto 승인·보류를 `new/source_changed` 로 되돌린다. 배포 창이나 되돌린 뒤에 그런 후보마다 한 번씩 다시 심사된다(파괴적이지 않음).
- **섞인 판의 입력 해시**: 새 reviewer 가 그린 입력으로 낸 1차 결과를 옛 AI2·발행이 받으면 입력이 맞지 않아(`second-review-input.ts` null) 그 후보가 다시 돈다 — 잠깐이다.
- **공개된 제품**: 이 경로는 공개분을 그리지 않는다. 공개분의 얇은 글은 기존 감사 화면 판별(`audit-screen-review`)이 맡는다.

## 4. 이미 보류된 것 다시 심사 (실행하지 않음 — 배포 뒤 사람 허락으로)

reviewer 컨테이너 안에서(화면 서버 env 가 있는 곳):

```bash
DB_POOLER_MODE=pgbouncer npx tsx scripts/js-shell-review-requeue.ts count
DB_POOLER_MODE=pgbouncer npx tsx scripts/js-shell-review-requeue.ts dry-run --limit 30
DB_POOLER_MODE=pgbouncer npx tsx scripts/js-shell-review-requeue.ts apply 50 <actor>       # 먼저 50건, 결과 보고 나머지
```

- count·dry-run 은 읽기만 한다(`readOnly: true`). 그리기 스위치(`renderSwitch` on/off/unreadable)·화면 서버 설정 여부(`renderConfigured`, 값은 찍지 않음)·상태 설명(`legend`)을 함께 싣는다.
- apply 상한: 한 번에 1~1,000건, 그리기 사이 `--interval-ms`(기본 2,000), `--batch`(기본 25, 최대 100)건마다 한 커밋 + operations_audit 한 줄(같은 `runId`, 마지막 줄 `final: true`).
  화면 서버 탈·붐빔으로 3건 이어 미루면 멈춘다(`stoppedEarly`). 스위치가 꺼져 있으면 거절한다.

- 대상: 자동·미발행 `needs_review/second_review_split` 중 원본 주소 = 후보 주소이고 수집 본문이 껍데기인 것. 07:5xZ 기준 **346건**.
- apply 는 기본으로 먼저 그려 뜻있는 것만 되돌린다(표본 비율 9/10 → 약 300건 예상). 되돌리기 = 다시 수집과 같은 길(state new · reason source_changed)
  → 규칙 재판정 → 1차(그린 글) → 2차. operations_audit `js-shell-review-requeue` 한 줄. `--no-render` 는 그리지 않고 되돌린다(1차가 그 자리에서 그린다).
- 비용: 되돌린 건마다 1차·2차 모델 호출 한 번씩(갈리면 판가름 한 번 더). 그리기는 건당 약 5초 + 간격 1초.

## 5. 남은 일·제안

- 캔버스 앱(표본 10%): 글이 없어 렌더로도 못 살린다. 기존 화면 판별(스크린숏 + Qwen vision)을 1차 갈림에도 쓰는 것은 별도 결정이 필요하다.
- 수집 본문이 이미 긴데 2차가 로딩 조각을 보고 "이름뿐"이라 거절한 건(표본 20건 중 14건이 실제 제품): 렌더와 무관한 2차 판단 문제다. 판가름(세 번째 표)이나 사람 검토 몫이다.
- 배포 뒤 볼 것: 작업 로그 `crawl.agent_review_shell_render`(ok·code·renderMs·used), `render_wait` 건너뜀 수, 2차 갈림 신규 유입에서 껍데기 비율.
