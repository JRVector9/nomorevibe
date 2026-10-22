# 남은 작업
- 불명확한 개인 Star 외부 요청은 GET 상태가 원하는 값과 같아도 종료를 증명하지 못하므로 추가 변경 잠금을 유지한다. 현재 자동·운영자 잠금 해제 API는 없으며 실제 GitHub 상태는 사용자가 직접 확인할 수 있다. 이미 발송된 요청의 취소는 보장하지 않는다.

코드로 끝낼 수 없어 멈춰 있는 것들. 각 항목은 **막고 있는 것**과 **풀렸을 때 할 일**을
그대로 실행할 수 있게 적는다. 끝나면 이 파일에서 지운다.

---

## m1 자동 닫기 규칙 바꿈(글 적은 페이지·엇갈림·공개 먼저) — 2026-10-22 (코드·로컬 DB 시험만, 운영 적용 전)

사용자 결정(2026-10-22): 글이 적은 페이지는 늘 화면을 보고 판정한다 · 다른 모델이 승인했으면 숨기지 않는다 · 엇갈린 것은 까닭을 남긴다 · 공개 먼저 묻는다.
수집 본문(`crawl_documents.page_meta.textSample` — 감사·m1 이 받는 `product.pageText`)이 300자 아래이거나 원본이 없으면 글만 본 m1(qwen-v2-auto)은
유지·숨김·보류 걸기·풀기 어디에도 세지 않고 '화면 판별 대기'로 둔다(`lib/crawl/audit-text-gate.ts`, 큐는 `lib/crawl/audit-screen-review.ts`).
m1 거절에 다른 모델의 승인이 있으면 숨기지 않고(보류의 둘째 문도 세지 않음) 엇갈림으로 작업 로그 `audit-auto-split` 에 두 모델의 결정·사유를 남긴다.
카탈로그 예외는 자동 숨김에 걸지 않는 그대로다(사용자가 바꾸라 하지 않음). **이전 없음·카탈로그 변경 없음** — 배포만으로 바뀐다.

- **배포 직후 볼 것**: 감사 거절 탭 Qwen 상태 칸·정책 처리 탭의 '열어 둔 무리: 화면 판별 대기 N(공개 중 N) · 엇갈림 N'. 작업 로그의 `audit-auto-split`,
  `qwen_second_opinion.ran` 의 `auditLeftThin`·`auditLeftSplit`. 묻는 차례가 공개 중 → 보류 중(글 적은 것은 그 뒤)인지 — 오늘의 'm1 자동 숨김' 실행에
  보류 중이던 것이 아니라 공개 중이던 것이 먼저 쌓이는지.
- **이미 한 자동 숨김**: 규칙을 바꾸기 전 m1 이 글 적은 페이지나 다른 모델이 승인한 것을 숨겼다면 그대로 남는다(쓸기는 풀지 않는다). 정책 처리의
  '보류 풀기'로 고른다 — 거르기 `보류 중 · 페이지 글: 글 적음 · 2차 거절 의견 있음(qwen-v2-auto)` 또는 `보류 중 · 2차 엇갈림`. 그날 실행째 되돌려도 된다.
- **직접 확인하지 않은 것**: 운영 분포(열린 거절 중 300자 아래가 몇인지 — 화면이 세어 보인다), 상태 칸·정책 처리 탭의 수 쿼리 시간(열린 거절 7천여 건 ×
  수집 문서 조회, 로컬 몇십 건만 쟀다), 쓸기의 쪽 읽기(줄마다 수집 문서 조회가 늘었다)의 시간. 운영 화면 판정 잡은 따로 만드는 중 —
  `screenReviewQueue`·`markScreenJudged`(출처 `qwen-vision-auto` 예약, 다른 이름이면 `audit-import-sources.ts` SCREEN_JUDGE_SOURCES 에 더함).

## 감사 두 번째 의견으로 닫기(m1 자동 유지·숨김) — 2026-10-22 (코드·로컬 DB 시험만, 운영 적용 전)

사용자 결정 "승인은 유지, 거절은 숨김" — Qwen-v2 자동 의견(qwen-v2-auto)이 지금 감사의 열린 거절 전부를 묻고(`qwenAuto.auditSecondOpinion.scope`
기본 all), 의견을 적는 트랜잭션에서 승인(확신 0.90 이상·다른 모델 거절 없음)은 유지 90일, 주인 없는 제품의 거절(확신 0.90 이상)은 숨김(보류)으로
닫는다(`autoClose` 기본 켬, `lib/crawl/audit-auto-close.ts`). 배포 전에 받아 둔 같은 판의 답은 다시 묻지 않고 틱마다 조금씩 그 답으로 닫는다(따라잡기).
UTC 하루·행동마다 시스템 정책 실행 하나(누가 qwen-v2-auto)에 적혀 정책 처리 탭에서 되돌린다. **이전 없음·카탈로그 변경 없음** — 운영 행에 새 칸이
없어 배포만으로 켜진다(단계 자체가 켜져 있으므로).

- **배포 순서 주의**: 공통 배포는 reviewer 를 웹보다 먼저 올린다. 그 사이 옛 웹은 자동 숨김 실행을 '보류 풀기'로 보이고 되돌리면 '되돌리지 못함'으로 막힌다
  (안전하지만 그 실행은 다시 되돌릴 수 없다) — 웹까지 새 SHA 가 된 뒤에 되돌린다.
- **설정 행의 새 칸**: 새 코드가 설정을 한 번이라도 저장하면(크롤 설정 폼·리뷰 모드 등 행 전체를 쓰는 길도) scope·autoClose 가 행에 적힌다. 그 뒤 옛 코드로
  되돌리면 옛 코드(strict)는 그 단계를 꺼짐으로 읽고, 옛 코드가 행을 저장하면 `{enabled:false, perTick:10}` 로 덮인다 — 다시 올린 뒤 켜야 한다.
  거꾸로 옛 웹이 그 단계를 켜면 새 칸 없이 적혀 새 코드가 기본값(열린 거절 전부·닫기 켬)으로 읽는다 — 운영자가 닫기를 꺼 두었다면 되돌림 뒤 다시 확인한다.
- **오래된 자동 실행**: 정책 처리 목록은 자동 실행을 최근 14개(이레 치)까지 보인다. 더 오래된 자동 숨김은 정책 처리의 '보류 풀기'(2차 거절 · 출처
  qwen-v2-auto · 보류 중으로 거르기)로 고른다 — 그것도 실행째 되돌릴 수 있다.
- **배포 직후 볼 것**: 감사 거절 탭 Qwen 상태 칸의 '답으로 닫기 · 오늘 자동 유지 N · 자동 숨김 N'과 정책 처리 탭의 'm1 자동 유지·숨김 · 날짜(UTC)' 실행이
  늘어나는지, 작업 로그의 `audit-auto-keep`·`audit-auto-hold`. 감사 #4 가 도는 동안은 두 번째 자리 호출이 한 건 12초쯤이라 시간당 70건 안팎이고, 끝난 뒤
  2.5~3초로 줄면 시간당 400~600건(틱당 상한 10 = 30초 시작 창)으로 오를 것이다 — `qwen_second_opinion.ran` 의 auditAsked 로 확인한다.
- **첫 되돌리기**: 그날의 'm1 자동 유지' 실행을 되돌려 유지가 지워지고 풀렸던 보류가 원래 시각·항목으로 돌아오는지, 'm1 자동 숨김'을 되돌려 목록에 돌아오고
  다음 틱에 다시 숨겨지지 않는지 제품 기록에서 본다(되돌림은 그날 실행 전체다).
- **직접 확인하지 않은 것**: 운영 7천여 건에서 대상 쿼리(틱마다)·상태 쿼리(감사 탭)의 시간(로컬 1만6천 항목 28~64ms), 확신 0.95 아래 무리의 m1 승인
  비율(최근 24시간 m1 결정은 거절 96%였지만 그 표본은 0.95 이상 보류 후보였다), 숨긴 확신 0.95 아래 제품은 정책 처리의 묶어 내리기 문턱(0.95)에 걸려
  묶어 내릴 수 없다 — 한 건씩 내리거나 문턱을 사람이 바꿀 때까지 숨긴 채 남는다.

## 감사 정책 처리(정책으로 닫기·되돌리기) — 2026-10-22 (코드·로컬 DB 시험만, 운영 적용 전)

`/admin/audit?tab=policy` — 열린 감사 거절을 거르기로 골라 미리 보고, 수를 적어 나눠 적용하고, 실행 하나를 통째로 되돌린다
(`lib/crawl/audit-policy.ts`). **이전 0116(새 표 둘, 기존 표 잠그지 않음) — 배포는 `--migrate`**. 카탈로그 변경 없음.

- **배포 직후 볼 것**: 정책 처리 탭의 '자주 쓰는 거르기'가 내는 수가 2026-10-22 읽기 전용 조회(3,851·2,139·583·526·351)와 맞는지.
  맞지 않으면 대상 정의(마지막 감사의 열린 거절 + 지난 감사 항목으로 보류 중인 것)를 먼저 확인한다.
- **직접 확인하지 않은 것**: 운영 7천여 건에서 미리보기 한 번의 시간(사유 갈래 정규식을 SQL 로 매 줄 계산한다 — 로컬 40건만 쟀다),
  한 묶음(50건·8초)의 실제 시간과 서버 액션 요청이 Traefik·Dokploy 제한에 걸리지 않는지, 내리기 묶음이 Cloudflare 지우기 줄
  (지난 60초 45줄)에 막혀 기다리는 빈도.
- **되돌리기 첫 사용**: 작은 실행(예: 20건 유지)을 적용하고 되돌려 보류 시각·항목·'풀었음'이 원래대로 돌아오는지 제품 기록 화면에서 본다.
- **두 번째 의견 올리기(m1 화면 재판정)**: `held-recheck/m1.jsonl` 은 운영 DB 에 아직 올리지 않았다. 올려서 검사만 하면 아무것도 적지 않는다 —
  받은 줄·없는 항목·제품 다름 수, 미리보기의 '풀림'·'대체를 켜면 더 풀림'·'그래도 보류' 수를 먼저 본다. 파일은 그 뒤 나머지 줄이 끝나야
  918줄이 된다(2026-10-22 08시 866줄). 모델 이름은 `qwen3.8-flash-next+vision`, 글 `2026-10-21.v2+shot1`.
- **처리 속도·적체 배지**: 메뉴 '내릴 후보' 배지가 7일 넘게 기다린 열린 거절이 있으면 주황으로 선다(요청·소개가 있으면 글자는 그 합계,
  적체는 title). 감사 #4 가 10-14 에 시작해 배포 직후에는 켜질 것이다 — 정책으로 닫아 7일 넘은 것이 0 이 되면 꺼지는지 본다. 배지는 60초 나눠 쓰는 값이라
  열린 거절 7천여 건을 세는 쿼리 시간(로컬만 쟀다)을 운영센터 느린 쿼리에서 확인한다.
- **유지 연장**: 아직 운영에 사람 유지가 0 이라 '곧 끝나는 유지'는 비어 있다. 정책 유지(90일)가 쌓이면 끝나기 30일 전부터 보인다 —
  그때 '페이지 그대로' 판정(수집 원본 해시)이 실제와 맞는지 표본으로 본다(수집 문서가 다시 긁히지 않는 제품은 늘 '그대로'로 나온다).
- **직접 확인하지 않은 것**: 운영 브라우저에서 1MB 아래로 나눠 보내는 올리기(400줄·600KB)가 Traefik 본문 상한에 걸리지 않는지, 감사 잡의
  Qwen-v2 자동 의견이 대체로 풀린 항목을 다시 묻지 않는지(풀린 항목은 '풀었음'이 적혀 보류 후보가 아니다 — 로컬 시험만).

## 무음 실패 경보(제 일 못 한 작업·메일·X 전달·랭킹·Qwen·생존 확인 보류) — 2026-10-22 (코드·로컬 DB 시험만, 운영 확인 전)

러너가 제 일 못 한 틱(degraded)을 성공으로 적지 않고 `job:<name>` 관측에 까닭·연속 횟수를 남기며, 조치할 일이 그것과 메일 발송함·
X 보고·랭킹·Qwen 물러나기로 경보한다(`lib/operations/job-health.ts`·`app/(operator)/admin/status/attention.tsx`). 이전 없음·카탈로그 변경 없음.

- **배포 직후 볼 것**: 운영센터 "지금 조치"에 새 줄(`job-health`·`uptime-held`·`stage-upstream`·`qwen-backoff`·`email-outbox`·`login-email`·
  `ranking-stale`·`x-delivery`·`x-candidates`)이 바로 몇 개 서는지. 서는 것은 지금까지 숨어 있던 실패다 — 까닭 코드로 확인하고, 일부러 그런 것
  (예: 일부러 키를 뺀 워커)이면 그 잡을 멈추거나 설정을 고친다. 메뉴 배지에 주황 "작업 이상 N건(보류)"이 붙을 수 있다.
- **직접 확인하지 않은 것**: 운영 데이터에서 성공 끊김 기준(주기 6번·최소 30분)이 일부러 미루는 잡(stage_blocked·source_buffer)을 잘 빼는지,
  미룸 까닭(`defer:<job>`) 열쇠 읽기가 운영센터 갱신(10초)마다 주 DB 에 부담이 없는지, Resend 거절·발신 설정 없음일 때 실제 발송함 수,
  X 수집기의 다음 실제 수집에서 `x-status:runs` 가 쌓이는지(첫 기록은 다음 보고부터다 — 이틀째 후보 0 경보는 배포 뒤 이틀이 지나야 설 수 있다),
  M3 네트워크 장애 때 `uptime-held` 가 30분 안에 서는지.

## 공통 배포의 Swarm 되돌림·`--resume`·관문 소유자 판정 — 2026-10-22 (코드·단위 테스트만, 운영 실행 전)

#597 배포 실패 대응. 절차는 [운영 절차](docs/operations/independent-workers-runbook.md) "Swarm 되돌림·멈춘 배포 이어 가기·관문의 소유자 판정".

- **Swarm 상태 읽기**: 운영 서버의 `docker service inspect --format '{{json .UpdateStatus}}'`·`docker service ps --no-trunc --format '{{json .}}'` 모양을
  실제로 본 적이 없다(가짜 docker 로만 시험). 다음 릴리스에서 정상 앱 줄에 지연이 늘지 않았는지(준비가 아닐 때만 두 명령을 더 부른다),
  다음 Swarm 되돌림 때 `swarmRollback`·`taskErrors` 줄이 실제 오류(`No such container` 등)를 담는지 본다.
- **Dokploy `done` 직후 UpdateStatus**: swarmkit 이 spec 을 바꾸는 update 마다 UpdateStatus 를 비운다는 전제로 done 뒤의 rollback 을 이번 배포의
  것으로 본다. Dokploy 가 같은 spec 으로 update 를 건너뛰는 경우가 있는지(재배포 시간이 3~4초였던 #597 restore·재시작) 운영에서 확인한다.
- **`run --resume` 첫 사용**: 섞인 상태에서 `resume` 앱별 상태가 실제와 맞는지, Dokploy 가 env 를 저장한 그대로 돌려줘 `unexplained_drift` 오탐이 없는지.

## 방문 분석(GA4) — 2026-10-22 (코드만, 꺼진 채 배포)

켜는 법·이벤트·동의·확인 절차는 [`docs/operations/2026-10-22-google-analytics.md`](docs/operations/2026-10-22-google-analytics.md).
`GA_MEASUREMENT_ID` 가 없으면 아무것도 불러오지 않는다.

- **막고 있는 것**: GA4 속성이 없다(사람이 만든다). 속성의 이벤트 데이터 보관을 **14개월**로, Google 신호·광고 맞춤을 끄고,
  향상된 측정의 '브라우저 기록 기반 페이지 변경'·사이트 검색·이탈 클릭·양식 상호작용을 끈다 — 정책 화면 `#analytics` 문구가 이 설정을 전제한다.
- **풀렸을 때**: 두 웹에 `GA_MEASUREMENT_ID`(+ 확인 동안 `GA_DEBUG=1`) → 웹만 다시 배포 → 문서의 DebugView 확인 1~8 → `GA_DEBUG` 지우고 웹만 다시 배포.
- **직접 확인하지 않은 것**: 실제 GA 수신(DebugView), 이동 뒤 제목이 늦게 올 때 1초 기다림이 충분한지, GPC 브라우저에서 요청이 없는지,
  `gtag('set', {page_location…})` 이 향상된 측정 이벤트(스크롤 등)에도 정리한 주소를 쓰는지.
- **서버 이벤트·여정(PR C)**: 막고 있는 것은 같다(속성) + 웹 스트림의 Measurement Protocol API 비밀.
  풀렸을 때 두 웹에 `GA_API_SECRET`·`ANALYTICS_USER_ID_SECRET`(두 웹 같은 값)·`GA_PROPERTY_URL` → 웹만 다시 배포 →
  문서의 '서버 이벤트 확인' 1~8 → 맞춤 측정기준(33개)·핵심 이벤트(8개) 등록 → BigQuery 일별 내보내기 연결.
  직접 확인하지 않은 것: 실제 MP 수신·검사 주소 응답, BigQuery 에서 서버 이벤트의 세션 키(`ga_session_id`/`session_id`),
  운영에서 `after()` 가 응답 뒤에 도는지, Cloudflare 가 `CF-IPCountry` 를 원 서버로 넘기는지, 문서의 BigQuery SQL 실행.

## 공통 이미지 배포 빠르게 — 2026-10-22 (코드·단위 테스트만, 운영 실행 전)

`deploy_shared_images.py`의 시각·소요 시간 기록, 두 서버 동시 pre-pull, `prepull`, 짧은 확인 간격(2·3초), 선택 모드 `--parallel-roles`.
절차·위험은 [운영 절차](docs/operations/independent-workers-runbook.md) "시각·소요 시간, 동시 pre-pull, `prepull`"·"`--parallel-roles`".

- **순차 기준선**: 다음 실제 릴리스(기본 순차)의 마지막 `summary`로 앱·관문별 초를 처음 기록한다. 지금까지는 전체 3분11초~4분16초만 안다.
- **`--parallel-roles` 첫 사용**: 기준선과 전체 시간을 비교하고, 한 번 관문(한도 180초)이 몇 초에 통과하는지, 세 역할 동시 재시작 동안
  경보·일감 끊김이 있었는지 본다. Dokploy가 동시 배포 요청을 실제로 나란히 처리하는지(줄 세우는지)도 앱 줄의 `at`·`seconds`로 확인한다.
- **동시 pre-pull·`prepull`**: 두 서버 줄의 `seconds`, 그리고 `prepull`을 먼저 돌렸을 때 `run`의 `preflight.durations.prePull`이 줄었는지.

## 예비 넘겨주기(역할 lease) — 2026-10-22 (코드·로컬 DB·로컬 프로세스 시험만, 운영 실행 전)

#597 복구에서 같은 릴리스 예비가 crawler 를 쥐고 놓지 않던 문제의 근본 수정. 절차는
[운영 절차](docs/operations/independent-workers-runbook.md) "역할 후보 운영·교체" 6. migration·catalog 변화 없음.

- **첫 배포 뒤 lease 위치**: 보통 공통 배포(예비 → 주)라 넘겨주기가 일어나지 않아야 한다. 배포 뒤 다섯 역할 lease 가 모두 M3 주이고
  `role.primary_handoff` 로그가 없는지 본다(text·maintenance 는 git 빌드 앱 배포 뒤).
- **실제 넘겨주기 한 번**: 운영자가 따로 승인한 때에만 — 같은 릴리스로 주 하나를 재배포해 예비가 맡았다가 60~120초 안에 주가 되찾는지,
  그 사이 그 역할의 일감 오류·중복 저장이 없는지, readiness 경보가 몇 초 `lease_expired` 뒤 `ready` 로 돌아오는지 본다.
- **주 관측 `electable`**: 운영 M3 주들이 host 장부(enforce)를 쓰는지에 따라 `host.ready()` 가 늦게 true 가 되는지, 관측에 `electable: true` 가
  실제로 실리는지 `operations_observations` 의 `candidate:%` 행으로 확인한다.

## Bluesky 화제 수집 — 2026-10-22 (배포 전)

설계·실측·지침 대응은 [`docs/operations/2026-10-22-bluesky-talk.md`](docs/operations/2026-10-22-bluesky-talk.md). 잡 `bluesky-talk`(crawler, 30분), migration `0115_social_posts_bluesky`.

- **배포 순서**: (배포 전 contact@nomorevibe.com 전달 확인) → migration 0115 → scheduler 2복제본(새 잡 `bluesky-talk` 의 `next_scheduled_at` 확인) → 공통 8앱 → text·maintenance. scheduler 를 먼저 하지 않으면 crawler 관문이 `unknown_schedule` 로 멈춘다.
- **운영 첫 회차**: 요청 수(상한 30)·시간(틱 40초)·429 여부·`truncated`(첫 회차는 최근 24시간쯤만 읽어 true 가 정상)를 크롤러 활동 `social.bluesky_talk_collected` 로 본다.
- **기준 다시 맞추기**: 반응 5(`BLUESKY_TALK_POINTS`)·봇 72시간 15개(`BLUESKY_BOT_POSTS`)를 2주 관측 뒤 실제 분포·오탐(`/admin/talk?source=bluesky&state=hidden`)으로 다시 정한다.
- **지운 글 내리기**: 다시 묻기(getPosts)가 지운 글을 `gone` 으로 내리고 7일 뒤 지우는지 운영 데이터로 본다(로컬 두 회차에서는 0건).
- **공개 연락처 contact@nomorevibe.com**(2026-10-22 사용자 결정 A, Bluesky 지침 5): 게재 기준 `/policy#contact`·/talk 집계 기준에 싣는다(D5 의 "공개 이메일 없음"을 바꿈).
  사용자가 Cloudflare Email Routing(DNS·전달 규칙)을 만든다. **배포 전에** 바깥 주소에서 보낸 메일이 운영자에게 도착하는지 확인한다 — 받지 못하면 배포하지 않는다.
- **관측 줄 증가량**: Bluesky 는 값이 바뀔 때만 관측을 남긴다. 한 달 뒤 `social_post_observations` 크기를 본다.
- 후속 후보: Jetstream(인증 없는 firehose)로 옮기기 — 검색 쪽 제한·`q=github.com` 누락이 커지면.

## SNS 화제·X 수집 — 2026-10-20

배포·첫 실제 수집 기록은 `docs/CODEX_HANDOFF.md` "2026-10-20 SNS 화제 C안·X 수집 연결". 아직 직접 확인하지 않은 것:

- **X GitHub 화제 검색어 `url:github.com min_likes:50`(2026-10-22 코드, 배포 전)**: 10-21 관련도순 결과(최고 35점·50점 0건, 7일 동안 본 저장소 17곳 중
  제품 1곳)와 #590 우리 제품 저장소 검색어 뒤의 사용자 결정. 웹 → osaka 수집기 순서로 배포하고 osaka env 의 `X_QUERY_URL` 줄을 지운다
  ([osaka runbook](docs/operations/2026-10-15-x-osaka-smoke-runbook.md) "배포 — GitHub 화제 검색어", dry-run 은 같은 문서의 고친 방법으로).
  첫 정기 실행 뒤 볼 것: **우리 요금제가 `min_likes:` 를 받는지**(문서에 없음 — `status.json` 의 `httpStatus` 200 이면 받음, 400·`http_error` 면 거절이니
  타이머를 멈추고 사용자에게 다시 묻는다), 돌려준 글 수·점수 분포, 공개 제품을 가리킨 글 수와 `/admin/talk` 의 `site` 글,
  하루 상태 `reports.status` 200(400·`statusV1` 이면 웹이 옛 판). 관측 표의 `x-query` 줄은 남아도 무해하다(지우려면 사용자 승인).
- **X 24시간 표시 규칙의 실제 동작**: 다시 잡히지 않은 X 글이 하루 뒤 /talk·홈·상세에서 빠지는지(공개를 켠 뒤, 또는 관리자 미리보기로).
- **X 하루 보고 끊김 조치**: 26시간 넘게 보고가 없을 때 운영센터 조치가 뜨는지 — 정상이면 매일 00:10 UTC 보고가 들어와 뜨지 않는다.
- **X 사용 목적 승인 기록**: 스위치는 사용자 지시로 켰다. X 쪽 승인 기록은 이 저장소에 없다([정책 확인 기록](docs/operations/2026-10-14-x-api-policy-and-pilot.md)).
- **공개 켜기 결정**: `SNS_TALK_PUBLIC_ENABLED` 는 꺼져 있다. 약 2주 관측 뒤 점수 무게·자격 기준을 다시 맞추고(설계 D9) 켤지 정한다. 켤 때 두 웹 env 와 Cloudflare HTML purge 를 함께 한다(이번 배포는 purge 토큰이 없어 건너뜀).
- **관리자 `/admin/talk` 실물 확인**: 운영 화면은 관리자 로그인이 필요해 아직 보지 않았다(로컬 개발 서버에서만 확인).
  2026-10-21 더한 "수집한 글 전부"(HN·X 모든 글·모든 상태, 거르기·쪽 넘김, 글마다 /talk 판정)도 배포 뒤 운영 데이터로 본다.
  HN 이 저장소 아닌 주소(github.io·gist 등)를 키 없이 남기는지는 크롤러 활동의 `social.hn_talk_collected` `unlinked`·`skipped` 로 확인한다.
- **Oracle 증설 migration 번호(2026-10-20 고침)**: main 의 `0103_social_posts`(when 1794086400015, 운영 적용) 때문에 Oracle 묶음을
  **0104 uptime_split · 0105 agent_repository_claims · 0106 oracle_agent_scan_row_scope · 0107 oracle_consumer_row_scope**(when …016~…019)로 옮겼다.
  PR 브랜치 8개(#554·#556·#560·#561·#557·#558·#559·#562)에 같은 커밋 "fix(db): Oracle 증설 migration 번호를 한 칸 뒤로"를 더했다(force push 없음).
  main 상태 DB(104줄)에 네 개를 더하면 108줄·표 생성까지 확인했다.
  - PR 없는 `codex/gpu3090-oracle-review-fixes-20261019`·`codex/gpu3090-merge-review-20261019` 에도 같은 커밋을 더했다.
    두 브랜치의 xaegis 작업 폴더(`~/.xaegis-hub/data/main-agent/nomorevibe-{oracle-fixes,merge-audit}-20261019/source`)는 건드리지 않아
    로컬 브랜치가 원격보다 뒤다 — 그 폴더에서 이어 작업하기 전에 `git pull --ff-only` 한다(untracked 파일 3개는 그대로).
  - review 브랜치 2개의 `tests/integration/uptime-split-control.test.ts` "배포 관문·감시" 실패(번호 변경 전부터 있던 문제)는 테스트를 고쳤다:
    리뷰 수정 0a4e8c06 이 split 진행을 붙잡는 차단기를 "지금 maintenance 를 돌리는 home(role_leases 주인)"의 것으로 좁혔는데 테스트는 주인 없이
    m3 차단기만 열었다. 감시 시나리오에 주인(m3)을 두고, 주인이 mini 로 넘어가면 붙잡지 않는 것도 보며, 파일 앞의 maintenance 행은 되돌린다
    (review-fixes c204cbd1 · merge-review cde03602, 코드 동작은 그대로).
- **main 과 합침(2026-10-20, 사용자 지시)**: 브랜치 11개(#554·#556·#560·#561·#557·#558·#559·#562·#563, review 2개)에 `Merge origin/main` 커밋을 더해
  이제 main(48a1d6cd)과 충돌이 없다(PR 은 모두 MERGEABLE). 해결:
  - `drizzle/meta/_journal.json`: main 의 0103_social_posts 다음에 0104~0107.
  - #551 을 이미 가진 #562·review 2개: `health-record.ts`·`uptime.ts`·`tests/crawler-activity.test.ts` 는 브랜치 쪽(main 판은 #551 5788ab2a 와 같다),
    `crawler-activity.ts` 는 브랜치 쪽 + main(#566)의 `social.hn_talk_*` 이벤트 3줄.
  - #551 이 없는 #556·#560·#561: `health-record.ts` 는 이 줄의 `writeHealthResults` 와 #551 함수를 둘 다, #561 의 `uptime.ts`·uptime 통합 테스트는
    통합 브랜치가 같은 조합을 푼 c41f7755 의 결과. **split 을 #551 뜻(401·403·429·999 는 알 수 없는 응답)에 맞추는 적응은 통합 줄(#562)에만 있다** —
    이 PR 들만 따로 main 에 합치면 split claims 가 그 응답을 실패로 센다. 배포는 계획대로 통합 줄로 한다.
  - 테스트 기준: `uptime-split-schema` 비교 기준을 0102 고정 → journal 의 0104 바로 앞(main 의 0103 이 끼어 들었다),
    merge-review 의 `next-config` CloudFront 규칙 수 64 → 72(main #567 의 공개 /talk 4언어 × HTML·RSC).
  - #563: 기록의 migration 번호를 0104~0107 로 맞추고(10-22 계획도 **0104~0107 적용**), main 의 10-20 기록과 날짜 순서로 둘 다.
  - CI: PR 9개 PR CI 성공(#562 포함), review-fixes 수동 CI 성공. merge-review 는 quality 의 `cli-process-runner` "abort kill" 1건이 한 번
    실패했다(로컬 5/5 통과, 병합이 건드린 파일과 무관) — 실패한 job 만 다시 돌려 성공했다(run 39406088351) — 11개 브랜치 CI 가 모두 통과한다.
  - `codex/oracle-scaleout-fix-uptime-20261019`·`codex/oracle-scaleout-fix-agent-scan-20261019` 는 통합(#562)에 이미 들어 있고(235faccf·36bd586d)
    단독으로 main 에 맞추려면 통합이 한 적응을 다시 해야 해, 사용자 지시로 원격 브랜치를 지웠다(복구가 필요하면 875d2b7c·4b55cb2b).
- osaka env 백업 `/etc/nomorevibe-x.env.bak-20261020T062402Z`(root 0600)에는 X 토큰이 들어 있다. 되돌릴 일이 없으면 지운다.

## Oracle 증설 배포 뒤 — 2026-10-20

#562 를 main(6ad56cd1)에 병합·배포했다(migration 0104~0107 적용, 모두 legacy). 기록은 `docs/CODEX_HANDOFF.md` "2026-10-20 저녁 Oracle 증설 통합 배포".

- 리뷰 수정 0a4e8c06 은 #575(main 14a9171c)로 들어가 모든 앱에 배포됐다. 공통 8앱·git 빌드 앱·text 모두 14a9171c(connect-agent 만 33964cb5, 변경 없음).
- **uptime A3 관측 중**(2026-10-20 21:55 KST claims, epoch 3): runbook 통과 조건(마감 지남 최장 ≤ 12분, 5분 반영 끊김 없음, `uptime.split_blocked`·`split_broad_failure` 없음,
  숨김·내림 속도 legacy 와 비슷)을 **10-21 03:55 KST 이후** 확인한다. 통과하면 A6 Oracle probe(cap 1,000/h) — Oracle 설치가 먼저다.
- **제작 근거 items 전환 대기**: consumer 앱은 만들었다(consumers=1). runbook §11 11-1 contract → 11-2 drain → 11-3 legacy 틱 끝 → 11-4 items 는
  운영 쓰기라 사용자 허가 뒤 한다. 되돌리기 11-6.
- **Oracle 설치·시작**(`docs/operations/2026-10-17-oracle-activation-runbook.md`): ARM 빌드·DB 계정(`nomorevibe_oracle_*`)·PgBouncer 인증·TZ=UTC·unit. 아직 아무것도 설치하지 않았다.
- maintenance-mini 는 `.claude/prod.sh` 목록에 없다 — 다음 maintenance 배포 때도 M3·mini 를 같은 release 로 맞춘다(아니면 lease 가 예비에 남는다).
- Cloudflare HTML purge 토큰을 운영자 Mac 키체인(`nomorevibe-cloudflare-purge-token`)에 둔다 — 지금 접근한 M3 Ultra·mini 에는 없다.

## 수집·검수 개선의 운영 검증 — 2026-10-14

PR00~07의 코드·회귀검사와 전체 검사(단위2,318·통합1,543·타입·lint·빌드)는 별도 브랜치에서 실행했다. 마지막 근거·캐시 cutoff·재개 커서 경계까지 수정하고 전체 검사와 모든 범위의 최종 독립 리뷰를 통과해 로컬 커밋했다.
[구현·검증 보고서](docs/operations/2026-10-14-pipeline-recovery-implementation.md)에 실제 결과를 기록한다.
[후속 설계 재검토](docs/operations/2026-10-14-pipeline-design-reaudit.md)에서 추가 취소 경계6개를
수정했고 단위2,433·선택 통합136·타입·lint와 마지막 직접 리뷰를 통과했다.
이전 전체 검사 횟수와 구별해 기록하며, 해당 source는 로컬 `df39c40`/파일럿은 `5c791dc`다.
후속 관리자·deadline 수정과 집계 SQL 최적화를 [PR#416](https://github.com/JRVector9/nomorevibe/pull/416),
[PR#417](https://github.com/JRVector9/nomorevibe/pull/417)로 정상 병합했다. 최종 runtime은
`9baf31ab5c48d0104c913e53299b776cbd106679`이며 main CI38563927498의 전체 검사와 양 이미지 발행이 성공했다.
운영 migration0076은 직접5432에서 exit0·journal77·quality 카운터 backfill mismatch0을 확인했다.
13개 앱/18개 컨테이너의 release·이미지·readiness, 소스 앱5개의 각532개 파일 hash,
다섯 역할의 readiness/progress, 공개 양 웹 health가 통과했다. 정상 관리자 로그인 뒤
크롤러 탭의13개 수집기·주/예비·최근 실행 표시와 공개 관리자404를 확인했다.
[배포 기록](docs/operations/2026-10-14-pipeline-recovery-rollout.md)은 당시 적용 증거다.
후속 적체 회복 PR419의 runtime `b0879eab83d7020839caef477fd512f842bcf1dc`로13앱/18컨테이너를 교체했다.
PR/main 전체 CI·양 이미지·실제 readiness·source5앱533파일 hash·관리자HTTP200 확인을 마쳤다.
근거96시간/완료 공개 제작근거 배경90일과 신규 발굴 중단·소개 검수 재개를 적용했다.
최신 결과는 [적체 회복 기록](docs/operations/2026-10-14-backlog-catchup.md)에 있다.

남은 것은 개선 후 처리량·장기 관측이다. 현재 공개 source 성공·실패·partial·due·최장 지연,
HTTP/304 비율·계정별 quota·신규 수집 starvation을 함께 측정한다.
과거 24시간 갱신의 유지 하한3,453source/h와 catch-up 목표5,500source/h는 달성으로 표시하지 않는다.
현재 facts/link는96시간으로 변경됐고, 활성 repository/site86,834개 기준 단순 재도래량은
약905source/h다. 실제 재도래·오류·부분 재개를 포함한 여유와 장기 backlog 감소는 관측해야 한다.
Grok CLI `grok-4.7`/`low`의 [출처 처리량 실측](docs/operations/2026-10-15-evidence-source-capacity.md)과
[제작 근거 복구](docs/operations/2026-10-15-backlog-evidence-recovery.md),
[현재 커버리지 판정](docs/operations/2026-10-15-evidence-capacity-recovery.md),
[발행분 재검수](docs/operations/2026-10-15-backlog-published-audit.md),
[텍스트 복구](docs/operations/2026-10-15-backlog-text-recovery.md)에 후속 수정과 실제 검증 상태를 기록한다.
외부 monitor 설치·Push/deadman 실제 수신과 과거 초기 gate 거절 후보의 fresh 재수집→규칙 판정도
별도 검증이 남았다. 소개 검수는 이후 사용자 명시 지시로 재개했다.
최신 적체 회복 설정·신규 발굴 중단·현재 처리 상태는
[적체 회복 기록](docs/operations/2026-10-14-backlog-catchup.md)을 따른다.

X는 [정책 확인·독립 파일럿](docs/operations/2026-10-14-x-api-policy-and-pilot.md)을 준비했고,
사용자가 복사한 Bearer Token을 로컬 비밀 설정에 저장했다. 원래 승인 목적이 공개 프로젝트
발굴·HOT 분석을 포함하는지는 미확인이다. 사용자 요청의17:11 소량 테스트에서 검색/재조회
각HTTP200·10개 게시물·공개 지표6종·`tweet.fields` 동작을 확인했다. 실제 청구액은 미확인이며,
공개 HOT 필터와 독립 social role/lease·상시 운영의 일일 예산은 이후 구현 단계다.
Threads는 [가능성 조사](docs/operations/2026-10-14-social-hot-crawler-feasibility.md)까지다.

---

## 관리자 private 접속의 추가 운영 검증 — 2026-10-13

**접속 설치 완료:** [실제 접속 기록](docs/operations/2026-10-13-admin-private-access-rollout.md)에
Tailscale HTTPS·private proxy·양 웹 ID/비밀번호 적용과 실제 로그인/읽기/로그아웃,
공개 경계 차단·6웹runtime 일치를 기록했다. production ADMIN_LOCAL_LOGIN=0 유지.

**남은 수동 검증:** 관리 쓰기·실제 다른 Tailscale 사용자·비밀번호 교체/만료·한도 초과·
서버 재부팅 후 접속은 이번 운영 단계에서 실행하지 않았다. 중앙 tailnet ACL은 기존 정책을
유지하고 Serve의 단일 운영자 identity를 private proxy에서 검사한다. 서비스 접속 복구와
네트워크 ACL을 축소한 작업을 혼동하지 않는다.


---

## GitHub 스타·피드백 실연동 파일럿 — 2026-10-12

**남은 확인:** 사용자가 직접 수행할 실제 GitHub 가입·로그인, 개인 스타 등록/취소,
서비스 댓글 제출과 제작자 저장소의 봇 Issue 전송·재조회·설치 철회 및 외부 전송 중
failover 확인. 허가된 개인/조직 테스트 레포와 사용자 범위의 실연동 증거는 아직 없다.
Resend는 이메일 로그인을 추가할 때만 필요하며 GitHub 로그인 활성화 조건은 아니다.

**운영 활성화 완료:** [2026-10-12 운영 기록](docs/operations/2026-10-12-github-feature-activation.md)에서
Star/Feedback App 키와 웹훅 저장, 실행 코드58a63a3, migration0073/0074까지 journal75,
14앱·19컨테이너의 실제release/health/환경값 일치·다섯primary lease를 확인했다.
웹의 네 플래그와 publisher/maintenance 전송 플래그는true다.

**사용자 확인 시:** [연동 운영 절차](docs/operations/github-stars-feedback-runbook.md)에 따라
GitHub URL·DB state·두 웹 결과와 지연을 [파일럿 기록](docs/operations/2026-10-11-github-integration-pilot.md)에
남긴다. 이메일 로그인을 선택하면 발신 설정과 메일 수신을 별도로 확인한다. 제작자 Feedback App
설치·저장소binding·수신허용 및 작성자의 전송 동의가 필요하다. 소개 검수 중단은 유지한다.

---

## 기존 관리자 설정의 저장 알림 — 2026-10-11

GitHub 기능 false 회귀 검사에서 기존 2차 심사 대체 모델을 새로 추가해 저장하면
서버 action은 `ok:true`와 새 version을 반환하고 revalidated props에도 새 값이 있으나,
화면의 `data-dirty=true`와 “2차 심사 모델” 변경 표시가 남아 성공 알림이 숨겨지는 현상을
확인했다. 관련 설정 화면 코드는 기준 main `6839194`와 동일하다. 이번 GitHub 연동에서
관리자 설정 생산 코드를 변경하지 않았으며 별도 UI 수정이 남는다.

**다음:** `SettingsForm`의 저장 후 baseline과 동적 `ModelRows` form reset 시점을
실제 브라우저에서 재현하고 성공 후 변경 표시가 해제되는지 검사한다. 현재 저장/DB/새 판/
reload 검사는 유지하되 이 UI 결함을 해결 완료로 표시하지 않는다. 근거는
`/private/tmp/nomorevibe-gh-final-baseline-e2e-c.log` 및 당시 Playwright trace에서 직접
확인한 성공 action/새 version/revalidated props다. 원본 trace는 다음 검사에서 덮였으며
아직 보존된 파일처럼 안내하지 않는다.

---

## 현재 남은 운영 검증 — 2026-09-29

첫 배포·운영 DB 연결·역할 워커 시작은 완료됐다. 서비스는 `https://nomorevibe.com`에서 운영하며,
Dokploy의 M3 7개 앱과 mini 웹·다섯 역할 예비 6개 앱이 운영된다. 웹과
crawler·reviewer·publisher의 주·예비 8개 앱은 GHCR digest를 사용하고 나머지는
main Git 소스를 사용한다.
2026-10-11 실제 inventory에서는 M3 connect-agent 1개가 추가되어 총14앱이며,
새 코드 릴리스의 14앱·19복제본을 [배포 기록](docs/operations/2026-10-11-github-integration-rollout.md)에서 확인했다.
scheduler는 M3에서 2복제본이다. 공개 GitHub main은 최신 base의 CI `check` 성공과 PR을 요구한다.
2026-09-29 릴리스 `20208d3`의 13개 앱 배포와 다섯 역할의 주/예비 인계를 확인했다.

남은 항목은 배포 준비가 아니라 아래 직접 검증이다. 실행하지 않은 검증을 완료로 표시하지 않는다.

- **공통 이미지 릴리스 장기 관측**: 2026-09-29 웹·crawler·reviewer·publisher
  주/예비 8개 앱을 같은 SHA의 두 digest로 교체하고 공개 웹 두 인스턴스, failover,
  진행 상태를 확인했다. 새 웹 패키지는 private이며 이전 공개 웹 패키지에 들어갔던
  빌드 키를 회전했다. 이미지 pull 자격 정보는 현재 운영자가 가진 GitHub 계정
  토큰을 사용한다. 별도 최소 권한 토큰으로 교체하고 만료·철회 시 pull 실패 알림과
  다음 릴리스의 재배포를 확인해야 한다. 24시간 처리/헬스 추세는 아직 관측 중이다
  ([첫 운영 기록](docs/operations/2026-09-29-deployment-speed-rollout.md)).
  이어서 main `5d67b23`의 공통 이미지를 자동 게이트로 8개 앱에 배포했고
  첫 앱부터 마지막 앱까지 89.45초, 모든 단계의 digest·health·failover 확인을
  마쳤다. 게이트 실패 후 실제 운영 복구는 아직 주입하지 않았다
  ([자동화 운영 기록](docs/operations/2026-09-29-deployment-verification-automation-rollout.md)).

- **500스타 자동 승인 장기 관측**: PR #231의 웹·crawler·reviewer·publisher
  주/예비 8개 앱을 같은 main 커밋으로 배포했다. 기존 92건 중 88건 발행,
  기존 제품 URL 중복 2건·보관 저장소 1건 거부, GitHub 404 저장소 1건의
  `new`/frontier `skipped`를 확인했다. 발행 88건의 GitHub ID 중복은 0건이었다.
  신규 수집의 24시간 신선 원본·중복·발행 오류 추세와 `new`로 남은 404 후보의
  표시/정리 정책은 별도로 관측한다
  ([운영 기록](docs/operations/2026-09-29-star-auto-approval-rollout.md)).

- **GitHub 수집 계정 풀의 장기 관측**: PR #225 배포 후 서로 다른 실제 GitHub
  계정의 관리자 PAT 등록·교체, 암호화 저장, 수집 코드 조회, 새 계정 quota 관측과
  원본 39건 증가를 확인했다. 실제 한 계정의 primary 한도가 자연 소진될 때
  다른 계정으로 전환되고 양쪽 reset 후 정상 재개되는 운영 경로와 24시간
  API 사용량·저장량 추세는 아직 직접 관측하지 않았다. 토큰 만료 전 관리자
  교체와 네 앱 공통 암호화 키의 보관·재암호화 절차도 장기 운영 항목이다.
  401 응답의 제한 재시도·다른 계정 전환·모든 계정 거부 시 큐 보류는 자동화 시험으로
  확인했으며, 실제 운영 PAT를 만료·폐기해 보는 장애 주입은 하지 않았다.

- **기존 GitHub 저장소 ID 중복 원본 검수**: 2026-09-29 읽기 전용 운영 조회에서
  같은 GitHub 숫자 ID의 중복 원본 299그룹·초과 행 304건을 확인했다. 새 코드 배포 직전
  이름 변경 원본 1건이 더 쌓여 배포 후 기준은 300그룹·초과 행 305건이었다.
  16그룹은 이미 발행된 제품이 둘 이상이므로 자동 삭제·병합 시 공개 제품, 심사 기록,
  사용자 지표가 바뀐다. 신규 중복 저장을 막는 `0054` 변경은 운영에 배포됐고 기존 행을 보존한다.
  발행 제품의 대표 선택과 병합·리다이렉트 정책을 정한 뒤 별도 백업·미리보기·적용 검증으로
  기존 자료를 정리해야 한다. 2026-09-29 03:31 UTC에 새 이름 변경 별칭 1건이
  `skipped/alias_of`로 기록되고 새 원본은 저장되지 않았으며 초과 행은 305건 그대로였다.
  장기 관측과 기존 자료 정리는 계속 필요하다.

- **워커 진행 감시의 외부 실행**: `scripts/check-failover-readiness.ts`는 주·예비 후보,
  lease, scheduler 2복제본과 기존 진행 판정을 함께 내고 별도 monitor 이미지가 30초 간격으로
  Uptime Kuma Push를 보낼 수 있게 구현했다. 운영 monitor 앱·Push 대상·실제 경보 수신은
  아직 배포/검증하지 않았다. mini 전체 장애 시 mini의 Kuma도 사라지는 감시 공백이 남아
  외부 deadman 경로가 필요하다. 운영 예비 중단·감시자 중단·실제 저장 정체·반복 부팅 격리
  주입도 각각 직접 확인해야 한다.
- **publisher 예비의 새 제품 발행**: mini가 epoch 3으로 인계받고 `crawl-publish` 요청·처리를
  완료했지만 당시 적격 승인 후보가 없어 새 제품 저장은 확인하지 못했다. 이후 승인 행 17건은
  발행 정책의 모든 조건을 만족하는 적격 큐가 아니며 실제 발행 잡은 `no_work`였다. 적격 후보가 생길 때
  mini 활성 상태의 신규 발행과 role epoch를 함께 확인한다.
- **실제 정체·반복 부팅 격리 주입**: publisher·maintenance·text의 자식 종료와 다섯 역할의
  주 서비스 중단·예비 선출을 확인했다. crawler 문서·reviewer 1차 심사·maintenance 점검·
  text 검수 저장도 확인했다. 실제 저장
  정체가 2회 판정되어 자동 재시작되는 경로와 3회/5분 반복 부팅 격리는 운영에서 아직 주입하지 않았다.
- **maintenance 처리 용량**: 공개 웹사이트 약 19,343곳 중 약 13,954곳이 6시간 넘게
  점검되지 않았고 최근 처리량은 약 900건/시간이다. 6시간 목표에 필요한 약 3,224건/시간과
  차이가 있으며 예비 대기는 용량 부족을 해결하지 않는다(2026-09-28 읽기 전용 표본).
  2026-09-29 재측정은 19,365곳 중 13,976곳 6시간 초과, 최근 905건/시간이었다.
  `UPTIME_BATCH_SIZE`·`UPTIME_CONCURRENCY`의 60/6을 M3 주·mini 예비에 적용했다.
  5분 저장 300건, 마지막 tick 60건/9.3초, 잡 오류 없음과 6시간 초과 13,628건을
  확인했다. 전체 backlog가 수시간에 걸쳐 6시간 안으로 회복되는지와 장기 CPU·DB 부하 검증은
  아직 남았다([운영 기록](docs/operations/2026-09-29-uptime-capacity-rollout.md)).

- **기존 보관 백업의 복구 가능성**: 운영 DB의 Patroni 주·복제 스트리밍과 WAL 아카이브가
  설정된 것은 읽기 전용으로 확인했다. 2026-09-29 운영 primary에서 새로 생성한 논리 백업을
  로컬 격리 DB에 복원해 주요 행·마이그레이션과 비어 있지 않은 `og_images.data` 바이트를
  대조했다. 운영 DB 설정은 바꾸지 않았고 시험 DB는 삭제했다. 당시 `media_assets`가 0행이어서
  그 테이블의 `web_data`·`thumbnail_data` 복구는 검증할 수 없었다. **이미 보관 중인 과거 백업의
  복원, 보존 기간·볼륨/WAL 여유 및 PgBouncer 용량은 별도 운영 관리 영역의 미검증 항목**이다.
  워커 failover 작업에서 DB 구성을 변경하지 않는다([복원 기록](docs/operations/2026-09-29-db-restore-verification.md)).
- **24시간 연속 관측**: 각 앱의 소스 커밋·재시작·job 성공/대기·API quota·DB 연결·RSS를 기록한다.
  개별 점검과 짧은 로컬 관측으로 24시간 안정성을 보장하지 않는다.
- **랭킹 정책 전환**: 운영 `unique_visitor_started_at`은 2026-08-29 03:56:49 UTC이며,
  2026-09-27 읽기 전용 점검에서 해시가 있는 방문 이벤트 43건을 확인했다. 고유 유입자 수집은 시작됐다.
  실제 정책 예약과 다음 자연 시즌 경계 적용은 아래 B2 절차로 별도 확인해야 한다.
- **소개 검수 재개·적체 회복 관측**: 2026-10-15 KST 사용자가 `소개 검수도 포함해`라고 명시해
  `product-intro-check` 중단을 해제했다. 신규 GitHub/Show HN 발굴은 중단한 채 기존 소개를 실제 검수 중이다.
  처리 완료·사람 확인 필요·재시도 상한을 따로 확인한다.
  [적체 회복 기록](docs/operations/2026-10-14-backlog-catchup.md)을 따른다.

정확한 배포 명령은 [독립 워커 운영 절차](docs/operations/independent-workers-runbook.md),
최근 실행 결과는 `docs/operations/`의 릴리스 기록과 `docs/CODEX_HANDOFF.md`를 따른다.
과거 준비·로컬 실측과 운영 확인 절차는 아래에 보존한다.

---

## D1. 카테고리·AI 리뷰 — 운영용 Codex·Claude CLI 인증과 모델 확인

**현재 상태(2026-09-27)**: publisher와 reviewer는 실제 운영 중이다. 아래 2026-09-08의 모델·인증 준비 기록은
과거 실측이다. 새 릴리스의 인증 만료·모델 변경은 역할별 로그와 실제 구조화 응답으로 다시 확인한다.
현재 자격 정보가 없다는 과거 상태를 배포 장애로 해석하지 않는다.

**현재 상태(2026-09-08)**: 로컬 로그인으로 실제 Spark 구조화 카테고리 응답과 worker 이미지의
Codex CLI 실행을 확인했다. 앞선 단기 OAuth 시험으로 Claude 구조화 리뷰 응답도 확인했다. 이 결과는
생산 환경의 장기 인증이나 24시간 운영 검증을 대신하지 않는다. 카테고리와 리뷰는 서로 다른 CLI,
모델, 인증을 사용한다.

```text
카테고리  codex exec / structured output / CLI 설정·지침·plugin·shell·web 격리 / 최대 10건 batch
          gpt-5.3-codex-spark / effort xhigh / 8초
          실패 시 gpt-5.6-terra / effort high / 12초, 다시 실패 시 키워드 폴백
리뷰      명시한 CRAWL_REVIEW_MODEL / effort low / safe-mode / 20초 / 한 tick AI 호출 최대 1개
인증      Spark는 CODEX_ACCESS_TOKEN, Terra는 OPENAI_API_KEY, 리뷰는 CLAUDE_CODE_OAUTH_TOKEN
실패      카테고리는 키워드 폴백. 리뷰는 보류·제한 재시도이며 enforce의 승인 조건을 우회하지 않음
```

publisher 시작 스크립트는 Codex 로그인 뒤 원문 토큰을 환경에서 제거한다. 분류 결과는 입력의 숫자
ID 전체 집합이 중복·누락 없이 돌아왔을 때만 채택한다. reviewer의 Claude CLI에서 `--bare`는 OAuth도
건너뛰므로 운영 코드와 동일한 `--safe-mode`로 인증을 확인한다. 토큰 값·Authorization 헤더·인증
응답 본문은 문서와 로그에 남기지 않는다.

### 실측 — 2026-09-08, 개발 DB의 기존 Other 표본 22건

| | Spark xhigh | Terra xhigh |
|---|---:|---:|
| 분류 일치 | 21/22 (95.5%) | 기준 비교 |
| 일반 표본 10건 | 5.119초 · 8,775 tokens | 10.463초 · 10,410 tokens |
| 게임 후보 12건 | 5.276초 · 3,731 tokens | 12.983초 · 10,725 tokens |

불일치 1건은 Craft Football을 Spark가 Social, Terra가 Lifestyle로 분류한 경우다. 실제 구현 경로의
2건 smoke에서는 wedding → Lifestyle, playable puzzle → Games를 반환했다. 이 비교로 1차를 더 빠른
Spark xhigh, 서버 인증·접근 실패 시 2차를 Terra high로 정했다. Spark는 현재 일반 API 모델이 아닌
Codex 연구 프리뷰이므로 서버 access token과 계정 제공 여부를 운영 배포 전에 반드시 확인한다.

### 과거 실측 — 2026-08-29, 개발 DB에 발행된 32건의 원본, sonnet · effort high

| | |
|---|---|
| 성공 | 32/32 — 4병렬 첫 실행에서 1건이 15초에 걸렸고, 단독 재실행은 11.2초에 성공 |
| 소요 | 단독 6.2초 · 4병렬 평균 10.3초, 최대 14.7초. 병렬이면 늘어난다. 발행 잡은 순차라 단독 값이 기준 |
| 출력 토큰 | 473 (생각 288) |
| codex 백필과 일치 | 26/31 (**83%**) — 앞서 codex↔qwen 일치율은 75%였다 |
| RevealUI | **Productivity** — 규칙은 Finance로 틀렸던 그 케이스 |

분포: Productivity 15 · Dev 13 · Finance 2 · Design 1 · Other 1 (codex 백필: 13·11·4·1·3).
불일치 5건은 전부 codex가 Finance/Other로 보낸 것을 CLI가 Productivity/Dev로 본 것이고, 프롬프트의
"결제 기능이 있다는 이유로 Finance를 고르지 않는다"와 맞는 방향이다. **개발 DB에는 CLI 결과를
반영했다.** 되돌릴 값은 이 실측 전 codex 분포뿐이므로 다시 재지 말 것.

응답 처리 경로는 `tests/classify.test.ts`가 붙들고 있다 — 구조화 출력, 허용 밖 카테고리, 로그인
풀림(`auth`)과 그 밖 실패의 구분, JSON 아닌 출력, 타임아웃, CLI 없음(한 번만 알림), 보내는 인자.

### 프로덕션에서 풀려면

1. 준비한 worker 이미지 안에서 `codex --version`이 `0.153.4`, `claude --version`이 `2.1.263`인지 확인한다.
2. Spark를 쓸 수 있는 `CODEX_ACCESS_TOKEN` 또는 Terra용 `OPENAI_API_KEY`를 publisher에만 저장한다.
   `claude setup-token`으로 발급한 장기 토큰은 reviewer에만 주입한다. 로컬의 짧은 수명 시험 토큰을
   그대로 운영 인증으로 채택하지 않는다.
3. Spark 사용 가능 여부, Terra 폴백, 명시한 리뷰 모델의 실제 구조화 응답·시간 제한을 격리된 후보로 확인한다.
   카테고리 로그의 `crawl.classified`와 인증 실패 여부를 확인하고, 리뷰 실패를 자동 거절로 처리하지 않는다.
4. 모든 reviewer/publisher에 B 릴리스가 적용된 것을 확인한 뒤 웹 `CRAWL_REVIEW_READY=true`를
   주입한다. `/admin/review`에서 사유와 함께 `off → observe → 판정 비교 → enforce`로 전환한다.
   `off`는 AI 발행 보호 해제이므로 enforce 운영 장애 때 자동으로 낮추지 않는다.

**과거 로컬 검증(2026-08-29)**: 이전 runner 이미지의 CLI `2.1.251`과 카테고리 인증 실패 시
키워드 폴백을 확인했다. 당시 이미지 322 → 817MB 측정은 현재 분리 이미지의 크기나 메모리 예산이 아니다.

---

## B1. 프로덕션 독립 스케줄러·워커 전환과 운영 확인

**현재 상태(2026-09-27)**: 독립 scheduler와 5개 역할 워커(crawler·reviewer·publisher·text·maintenance)가
운영 중이다. 남은 것은 상단의 24시간 연속 관측과 기존 보관 백업의 복구 검증이다.
격리 환경의 웹 없는 5역할 관측을 1,800.307초 동안 완료했다(31표본 모두 healthy, 재시작0). 외부 수집 비활성·빈 DB 조건이며 24시간 관측은 수행하지 않았다.
완료 기록은 [운영 절차](docs/operations/independent-workers-runbook.md)와 릴리스 보고서에 별도로 남긴다.

### 전환할 실행 구성

- DB scheduler는 10초마다 `lib/jobs/catalog.ts`의 예정 시각을 확인해 요청을 접수한다.
- crawler·reviewer·publisher·maintenance는 역할당 1개씩, 기본 5초 poll로 접수된 작업을 소비한다.
- 기존 HTTP 스케줄·evidence wrapper·수동 루프는 stop/drain 후 교체한다. 웹 컨테이너와
  HTTP 스케줄만 배포하면 요청을 처리할 소비자가 없으므로 충분하지 않다.
- `crawl-fetch`, 두 evidence 잡, `crawl-agent-review`는 1분, judge/publish는 5분,
  seed는 15분, uptime은 10분, click-rollup은 1시간 요청 주기다. 완료 시각을 보장하지 않는다.
- `ranking-refresh`는 독립 주기가 없다. `click-rollup`의 `done=true` 성공 완료 트랜잭션에서만
  후속 정기 요청을 생성한다. 예전 매시 5분 HTTP 등록은 제거한다.
- 두 evidence 잡은 출처 due/쿨다운을 확인하며, 일반 저장소·에이전트 완료 스캔의 기본 간격은 24시간이다.

기존 실행 프로세스를 확인한 뒤 운영 절차의 **stop/drain → migration → 역할 시작**을 수행한다.
`POST /api/cron/<job>`는 인증된 호환 접수 API이며 HTTP 202는 실행 완료를 뜻하지 않는다.
독립 scheduler는 `CRON_SECRET`이나 웹 접근을 필요로 하지 않는다.

### 필요한 환경변수

| 변수 | 사용하는 역할과 미설정 영향 |
|---|---|
| `DATABASE_URL` | 웹·모든 워커·migration에 필요 |
| `CRON_SECRET` | 웹의 호환 cron 접수 인증. 미설정이면 403 |
| `GITHUB_TOKEN` | crawler의 기존 GitHub 요청 토큰. 관리자 등록 PAT가 있으면 없어도 수집 가능 |
| `GITHUB_COLLECTOR_SECRET` | 관리자 PAT 암호화·복호화. 웹 2개와 crawler 주·예비에 동일한 32자 이상 키 필요 |
| `CODEX_ACCESS_TOKEN` | publisher의 Spark 분류. 없거나 실패하면 Terra로 진행 |
| `OPENAI_API_KEY` | publisher의 Terra 분류. 없거나 실패하면 키워드 폴백 |
| `CLAUDE_CODE_OAUTH_TOKEN` | reviewer. 리뷰 오류는 보류·제한 재시도 |
| `CRAWL_REVIEW_MODEL` | reviewer의 명시적 모델. 기본값 없음 |
| `CRAWL_REVIEW_READY` | 웹 모드 변경 준비 플래그. true여야 observe/enforce 전환 가능 |
| `TRUSTED_PROXY_HOPS` | 웹 프록시 환경의 클라이언트 IP 판별. 실제 hop 수에 맞춤 |

### 확인

`/admin/status`에서 scheduler·worker 생존과 요청/처리 버전·성공/실패·다음 대기를 함께 본다.
실행 기록이 없으면 접수 누락인지, 소비자 중단인지, 설정 비활성인지 구분한다.

1. crawler 자격 정보의 GitHub 응답을 확인하고 토큰 값이나 Authorization 헤더는 출력하지 않는다.
2. `/admin/products/<slug>`의 강제 갱신으로 접수한 요청 버전과 최종 완료 상태를 비교한다.
   `product_evidence_sources.last_success_at`과 `normalized_facts` 갱신, 최근 미디어 재확인도 점검한다.
3. 예약된 evidence 작업과 집계 작업의 실행·성공 시각 및 진행점을 확인한다. heartbeat만 늘어난 것을
   실제 수집 성공으로 세지 않는다. 웹 중지와 scheduler 중지를 별도로 관측한다.
4. 인증 실패는 별도 시험 환경에서 확인한다. 마지막 정상 facts가 보존되고 오류/재시도 시각만
   바뀌는지 확인하며, 운영 토큰을 의도적으로 폐기하지 않는다.
5. 새 논리 백업의 격리 복원은 [2026-09-29 기록](docs/operations/2026-09-29-db-restore-verification.md)을 따른다.
   기존 보관 백업 복구·보존 기간·용량은 별도 운영 관리에서 확인한다. `media_assets`에 실제 행이
   생기면 `web_data`·`thumbnail_data` 바이트 포함 여부를 그 표본으로 확인한다.
6. 24시간 동안 모드·모델·재시작·잡 진행·API 대기·RSS·DB 연결을 기록한다. 운영 관측을 완료하기 전
   24시간 안정성이 검증됐다고 보고하지 않는다.

### 함께 해야 할 일

저장된 크롤 설정은 코드 기본값을 덮으므로 `/admin`의 차이 표시를 보고 의도한 정책인지 확인한다.
설정 초기화는 현재 수집 스위치와 리뷰 모드를 보존한다. 리뷰 모드는 별도 사유·현재 값 비교로 변경한다.

이전 문서의 검색 신호 → `crawl_frontier.builder` → `products.builder` 일괄 백필 SQL은 제거했다.
검색어·토픽·발견 라벨은 제작 도구나 모델의 사용 증명이 아니므로 그 값으로 빈 제작 AI를 채우지 않는다.
필요한 근거는 공개 저장소 수집 결과로 확인하며 메이커 신고·숨김·삭제 의도를 보존한다.

---

## B2. 프로덕션 고유 유입자 수집 시작 및 전환 확인

**현재 상태(2026-09-27)**: 운영에서 고유 유입자 수집 시작 시각과 해시가 있는 이벤트를 확인했다.
7일 준비 기간은 경과했지만, 현재 정책 예약·자연 시즌 경계 적용은 이 세션에서 확인하지 않았다.
아래 절차는 새 환경 전환이나 정책 변경 시 사용할 검증 절차다.

**지금 상태**: `0013_unique_visits.sql`은 기존 이벤트와 시즌을 유지하는 가산 마이그레이션이다.
`visit_collection_state.unique_visitor_started_at`은 마이그레이션 때 `NULL`로 두고, 유효한
`VISITOR_HASH_SECRET`으로 `/go/<slug>` 요청의 HMAC을 처음 만들 수 있을 때 DB 시각으로 한 번만
채운다. 따라서 코드 배포나 마이그레이션 시각을 수집 시작 시각으로 간주하면 안 된다.

### 과거 로컬 배포 검증 — 2026-08-29

2026-08-29, `docker compose`로 띄운 배포 형태(앱+DB+스케줄러)에서 **작동 원리는 전부 밟았다.**
프로덕션에서 남은 것은 아래 "배포 순서"의 환경 고유 단계(비밀값 주입·마이그레이션 적용 확인·
수집 시작 시각 기록·7일 경과)뿐이다.

| 확인한 것 | 결과 |
|---|---|
| `/go/<slug>` 첫 방문이 `unique_visitor_started_at`을 채운다 | 채워짐. 그 전에는 NULL |
| `visitor_hash` 길이 | 64자 |
| 같은 브라우저·같은 제품 10분 재방문 | 기록 안 됨 (중복 제거 동작) |
| 같은 브라우저·**다른 제품** | 기록되며 **해시가 다르다** — 제품별 HMAC이 실제로 분리된다 |
| 다른 브라우저·같은 제품 | 별도 기록 |
| 봇 User-Agent(Slackbot) | 이동은 되고 기록은 안 됨 |
| `click-rollup` | `product_click_daily`에 유효 방문과 **고유 수**가 함께 남는다 (예: 유효 2 / 고유 2) |
| 중복 제거 키 | `rate_limits`의 `visit:<slug>:<hash>` — 제품×방문자마다 하나 |
| `ranking-refresh` | 시즌 스냅샷 갱신. `ranking_entries`는 0 — 검증된 제품만 참가하므로 맞다 |

즉 프로덕션에서 새로 확인할 것은 **"이 환경에서도 같은 일이 일어나는가"**이지 동작 자체가 아니다.

### 배포 순서

1. 비밀 저장소에서 다른 용도로 재사용하지 않을 값을 생성한다.

   ```bash
   openssl rand -hex 32
   ```

   결과를 프로덕션 `VISITOR_HASH_SECRET`에 넣는다. `AUTH_SECRET`, `CRON_SECRET`,
   수정 토큰용 키와 같은 값을 쓰지 않는다. 평문 값을 문서·로그·명령 기록에 복사하지 않는다.

2. 운영 절차대로 기존 소비자를 stop/drain한 뒤 별도 `migrate` 서비스를 한 번 실행한다.
   종료 코드 0을 확인하고 새 웹·워커를 시작한다. entrypoint는 마이그레이션을 실행하지 않는다.
   운영 DB에서 다음 구조가 실제로 생겼는지도 읽기 전용으로 확인한다.

   ```sql
   select column_name
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'click_events'
     and column_name = 'visitor_hash';

   select id, unique_visitor_started_at
   from visit_collection_state
   where id = 1;
   ```

   첫 정상 방문 전 두 번째 쿼리의 시각은 `NULL`이어야 한다. 기존 `click_events`의
   `visitor_hash`도 억지로 채우지 않는다.

3. 공개된 실제 제품 하나를 새 1st-party 쿠키로 `/go/<slug>`를 통해 방문한다. 리다이렉트가
   정상인지 확인한 뒤 운영 DB에서 다음을 확인한다. 원본 쿠키, IP, User-Agent, 해시 본문은
   로그에 출력하지 않는다.

   ```sql
   select id, unique_visitor_started_at is not null as started
   from visit_collection_state
   where id = 1;

   select slug, length(visitor_hash) as hash_length
   from click_events
   where visitor_hash is not null
   order by occurred_at desc
   limit 1;
   ```

   `started=true`, `hash_length=64`인지 확인하고 시작 시각을 배포 기록에 남긴다. 이것이 7일
   준비 기간의 기준이다. `/admin/ranking`에서 그 전에는 `집계 중`이고 고유 기준 예약이
   거절되는지, 정확히 7일 뒤 준비 상태로 바뀌는지 확인한다.

4. B1의 독립 scheduler와 maintenance를 운영하고 `/admin/status`에서 `click-rollup`의
   완료 뒤 `ranking-refresh` 요청·실행이 이어지는지 확인한다. ranking은 별도 정기 등록하지 않는다.
   하루가 지난 뒤 `product_click_daily.unique_visitors`가 채워지는지도 확인하되, 여러 날짜의 값을 합쳐
   여러 날의 고유 유입자로 해석하지 않는다.

5. 수집 시작 후 7일이 모두 지난 다음에만 고유 기준 정책을 예약한다. 예약이 현재 시즌을
   바꾸지 않고 다음 자연 시즌 경계에 적용되는지, 이전 시즌과 전체 기간 보드가 각각
   `유효 방문`·`누적 유효 방문` 표기를 유지하는지 확인한다.

### 비밀키 교체 시 주의

키를 교체하면 같은 브라우저도 새 해시가 되어 교체 전후가 한 집계 구간에 겹칠 때 둘로 셀 수
있고 10분 중복 제거도 초기화된다. 원본 쿠키를 저장하지 않으므로 과거 해시를 새 키로 변환할 수
없다. 유출 대응이 아니라면 일상적으로 교체하지 말고, 불가피하면 교체 시각과 영향을 기록한 뒤
7일 준비 상태와 다음 시즌 예약을 다시 검토한다.
