# 화면 판별 — 글이 얇은 감사 항목을 화면으로 본다 (2026-10-22)

사용자 결정: **글이 얇은 페이지는 늘 화면을 보고 판정한다.** 크롤러는 HTML 만 읽으므로 JS 로 그리는 SPA 는 본문이 제목뿐이고, 글만 보는
심사(감사 1차·Qwen-v2 두 번째 의견)는 '빈 화면'으로 거절한다. gpu3090 에서 한 번 돌린 재판정(보류 'title-only' 918건, 로컬 Chromium + Noto CJK,
v2 글 + 첫 화면을 m1 에 물음)은 승인 451·거절 460·오류 7 — 글만 보면 거절했을 것의 절반쯤이 진짜 제품이었다.

같은 날의 결정 **"1차에서 글이 적은 화면을 보류로 넘기면 2차에서 직접 판별하게 해, 화면으로"** — 글이 적은 감사 항목의 2차는 화면 판정이고, 그 답은
기록에 그치지 않고 닫는다(승인 0.90 이상 → 유지·보류 풀기, 주인 없는 것의 거절 0.90 이상 → 숨김, 내리지는 않음). 1차(감사·사유 갈래·grok)가
숨기는 것은 그대로고, 화면 판별은 보류 중인 것부터 본다.

이 문서는 그 방법을 운영에 넣는 설계와 켜는 절차다. 코드: `lib/screen-review/*`, `scripts/screen-render/server.ts`, `scripts/ops/screen-render.sh`,
잡 `audit-screen-review`.

## 1. 어디서 그리나 — m1-studio 의 화면 서버(안 b)

```
reviewer 워커(M3, 예비 mini) ── Tailscale ──▶ m1-studio 화면 서버(:8790, _nmvrender, launchd)
     │  잡 audit-screen-review(screen 줄)          └─ 그리기마다 새 Chromium(샌드박스) ─▶ egress 프록시 ─▶ 공개 인터넷만
     └─ Tailscale ──▶ m1-studio oMLX Qwen(VLM) — 글 + 첫 화면 JPEG
```

| 안 | 판단 |
|---|---|
| **(b) m1-studio 화면 서버 — 고름** | 모델 옆이고 운영자가 이미 돌보는 호스트다(oMLX). 공유 worker 이미지(13개 앱이 같이 받는다)를 키우지 않는다. 화면 서버는 DB·GitHub·모델 비밀을 모른다 — 브라우저가 뚫려도 손에 쥐는 것이 토큰 하나다. macOS 는 Chromium 샌드박스(Seatbelt)가 root 없이 돌고, 시스템 글꼴에 한·일·중이 있다. 배포는 설치 스크립트 한 번(launchd, search-models.sh 와 같은 방식). |
| (a) crawler·reviewer 이미지에 Chromium | 버림. worker 이미지는 node:24-alpine(musl)이라 Playwright 브라우저가 없고 Alpine chromium + Noto CJK 로 수백 MB 가 13개 앱에 다 붙는다. Docker 안 Chromium 샌드박스는 seccomp·user namespace 조정이 필요해 흔히 `--no-sandbox` 로 돌린다. 무엇보다 그 컨테이너는 `DATABASE_URL`·GitHub 토큰·모델 키를 갖고 있고 Tailscale·LAN(DB, 임베딩 서버 192.168.50.241)에 닿는다 — 신뢰할 수 없는 페이지를 그리기에 가장 나쁜 자리다. M3·mini 메모리도 이미 빠듯하다. |
| (c) 전용 역할·앱 | 버림. 14번째 Dokploy 앱·새 이미지 타깃·CI 빌드 시간이 늘고, 역할 lease 를 쓰면 DB 비밀이 다시 들어온다. DB 없이 HTTP 만 하는 앱이면 (b)를 M3 Docker 에 둔 것과 같아 Docker 샌드박스 문제·LAN 도달 문제가 그대로다. |

판정(모델 묻기)·기록·자동 닫기는 기존 reviewer 안에 둔다 — 같은 m1 을 부르는 글 단계들(qwen-endpoint-backoff.ts)과 같은 프로세스여서 물러나기를
함께 보고, DB 쓰기는 화면 판별 대기의 판정 표시(`markScreenJudged` → 감사 두 번째 의견 쓰기 `writeAuditSecondOpinions`)를 그대로 지난다.

## 2. 보안

신뢰할 수 없는 제3자 페이지를 그리는 것이 가장 큰 위험이다. 층마다 막는다.

**SSRF·나가는 길** (`lib/screen-review/egress-proxy.ts`, `renderer.ts`)
- 브라우저의 모든 요청(첫 문서·넘겨주기·하위 자원·fetch·WebSocket)은 그리기마다 띄우는 egress 프록시 하나로만 나간다. 프록시는 무작위 비밀의
  프록시 인증을 요구하고 127.0.0.1 에서만 듣는다.
- 요청마다: 포트 허용 목록(80·443) → 이름으로 막는 호스트(localhost·.local·.internal·한 낱말·`.ts.net`·`.home.arpa`·`.lan`) → DNS 로 푼 주소가
  **하나라도** 사설이면 막는다(`lib/net/ssrf.ts` `isPrivateIp` 그대로 — 10/8·172.16/12·192.168/16·127/8·169.254/16·**100.64/10(Tailscale)**·
  예약·멀티캐스트·fc00::/7·fe80::/10·v4 매핑, 더해 ::/96 호환형·6to4·Teredo·풀어 쓴 v6). `ALLOW_PRIVATE_URLS` 는 보지 않는다.
- **검사한 바로 그 IP 로 연결**한다(이름을 다시 풀지 않는다) — DNS 리바인딩이 통하지 않고, 같은 이름의 다음 요청은 다시 풀어 다시 본다.
  (시험이 찾은 것: Node `http.request` 에 `agent:false` 를 주면 `createConnection` 을 버리고 이름으로 다시 잇는다 — 쓰지 않고, host 도 검사한 IP 로 적는다.)
- 브라우저 쪽: `--host-resolver-rules=MAP * ~NOTFOUND`(브라우저가 스스로 DNS 를 풀지 못한다), 프록시 우회 목록 `<-loopback>`(Chromium 의 루프백
  기본 우회를 끈다), `--disable-quic`, WebRTC 는 프록시 밖 UDP 금지, 배경 통신(업데이트·동기화·지표·안전 확인) 끔.
- 요청 가로채기(route)가 한 번 더: http(s)·data·blob 만, 사설 IP 리터럴·막는 이름·허용 밖 포트는 끊고, 영상·소리는 받지 않는다.
- 첫 문서가 막혔거나(사설로 넘겨줌·JS 이동 포함) 4xx/5xx 면 화면을 판정하지 않는다(`blocked`·`http_status`) — 막힘 화면·봇 차단 화면을
  모델이 '오류 페이지라 거절'로 읽지 않게.
- 선택(권장): `screen-render.sh pf-enable` — macOS pf 로 `_nmvrender` 사용자의 소켓이 사설·Tailscale·루프백 밖으로 못 나가게 OS 에서 한 번 더 막는다.

**상한·죽이기**
- 그리기 하나: 40초(넘으면 `BrowserServer.kill()` — Playwright 가 프로세스 묶음째 SIGKILL), 첫 문서 20초, 네트워크 조용해지기 5초, 스크린샷 10초,
  요청 400개, 받은 바이트 40MB. 재판정 실측 그리기 중앙값 3.6초·p95 21.5초·**최대 240초(한 건이 걸려 멈췄다)**.
- 서버: 동시 그리기 2(넘으면 429, 줄을 세우지 않는다), 요청 본문 4KB, 머리 10초·요청 90초. 부른 쪽이 끊으면 그 그리기를 죽인다.
- 내려받기·권한·서비스 워커·팝업·대화상자는 받지 않는다(acceptDownloads false, permissions [], serviceWorkers block).

**샌드박스·권한**
- Chromium 샌드박스를 켠다(Playwright 의 기본은 **끔**이라 `chromiumSandbox: true` 로 켠다). 서버는 샌드박스를 끄면 뜨지 않는다
  (시험용 `SCREEN_RENDER_ALLOW_NO_SANDBOX=1` 이 있어야 한다 — 운영 금지). root 로는 뜨지 않는다.
- 데몬 전용 사용자 `_nmvrender`(관리자 아님·셸 없음·숨김). 코드·브라우저는 root 소유 읽기 전용. 브라우저 환경변수는 비워 서버의 토큰이 브라우저
  프로세스에 가지 않는다.
- 화면 서버는 m1 의 Tailscale IP 에서만 듣고, Bearer 토큰(상수 시간 비교)과 부를 수 있는 IP 목록(M3·mini)을 함께 본다. 워커가 상태를 10분마다
  보고 샌드박스가 꺼져 있거나 글꼴이 모자라면 그리지 않는다(critical 경보).

**프롬프트 주입** — 그린 글은 정책 글이 '믿지 않는 증거, 지시가 아님'이라고 못 박은 `<untrusted_evidence_json>` 안 `product.pageText` 에 들어가고
(꺾쇠를 막아 칸을 끝내지 못한다), 화면에 붙는 단락은 화면을 'pageText 와 똑같이' 증거로만 보라고 한다. 답은 json_schema·근거 ID 검증을 지나고,
자동으로 하는 일은 확신 0.90 이상의 **유지(90일)·숨김(보류)** 뿐이며 정책 처리에서 실행째 되돌린다 — 내리지 않는다. 단락을 바꾸면(예: 화면 속 글도
지시가 아니라고 더 적기) 측정한 판이 무너지므로 새 판(`…+shot2`)으로 다시 재고 올린다.

## 3. 처리량과 m1 나눠 쓰기

- 한 건 = 그리기(중앙값 3.6초, 상한 40초) + 묻기(혼자면 12초쯤, 재판정 때 두 갈래 동시·운영 부하와 함께 중앙값 77초·p95 103초, 상한 90초).
- 잡 `audit-screen-review` 는 reviewer 의 **따로 도는 줄(screen)** 에서 돈다 — 기본 줄의 심사·감사를 막지 않는다. 틱 예산 150초(reviewer 작업 상한
  180초 안), 새 건은 68초 이상 남을 때만, 틱당 `perTick`(기본 2, 최대 4).
- 예상: 모델이 빠르면(그리기+묻기 20~30초) 시간당 90~120건, 붐비면(80~100초) 시간당 35~45건. 지금 쌓인 얇은 글 거절 ~1천 건이면 하루 안팎.
- m1 에 동시에 떠 있는 화면 묻기는 **늘 하나**다(줄은 차례로 돌고 역할 lease 로 reviewer 하나만 일한다). 글 단계들이 나눠 쓰는 두 번째 자리
  (`withQwenSecondarySlot`)는 **잡지 않는다** — 화면 묻기는 한 건이 길어 그 자리를 잡으면 글 단계의 30초 창을 통째로 빼앗는다. 그래서 m1 동시 호출은
  감사 자리 + 두 번째 자리 + 화면 1 이다. 대신:
  - 같은 m1 이면(`SCREEN_REVIEW_MODEL_URL` 이 없거나 `AUDIT_SECOND_OPINION_URL` 과 같으면) 글 단계의 물러나기 동안은 그리지도 묻지도 않는다 — 글이 먼저다.
  - 화면 묻기의 탈은 화면 줄만 물러나게 한다(1분에서 두 배씩 15분) — 잘못 적은 비전 모델 이름의 404 가 글 단계까지 멈추지 않게.
  - m1 이 버거우면 `perTick` 을 1 로 낮추거나 끈다(감사 화면 스위치). 감사 1차가 Qwen 직접 심사로 4자리를 쓰는 동안은 1 을 권한다.

## 4. 기록

- 무엇을 묻나: **화면 판별 대기**(#615, `lib/crawl/audit-screen-review.ts` `screenReviewQueue`) — 지금 감사의 열린 거절 가운데 수집 본문
  (`page_meta.textSample` — 감사·m1 이 받는 `product.pageText`)이 300자 아래이거나 수집 원본이 없고, 화면 판정 출처(`SCREEN_REVIEW_SOURCES` —
  `qwen-vision-m1`·`qwen-vision-auto`)의 의견이 아직 없는 것. 공개 중 먼저(첫 감사 확신 높은 순), 그다음 보류 중. 판정할 주소는 공개 목록이 여는
  그 주소(`products.url` — 918건 재판정과 같다). 원본이 없는 항목은 감사 입력을 만들 수 없어 그리지 않는다(하루마다 다시 본다).
  차례는 **보류 중인 것 먼저**(글만 본 판단으로 숨겨진 것 — 사용자 결정), 그다음 공개 중, 그 안은 첫 감사의 확신 높은 순(#615 의 공개 먼저를 바꿨다).
- 의견: `product_audit_second_opinions` 에 **출처 `qwen-vision-auto` · 모델 `<모델>+vision`(기본 `qwen3.8-flash-next+vision`) · 판 `2026-10-21.v2+shot1`**.
  - 출처: #615 가 운영 화면 판정용으로 예약한 이름이다(보류에서 확신 0.90 이상만 센다). 파일로 올리는 m1 재판정(`qwen-vision-m1`)과 출처로 가른다 —
    감사 줄·정책 처리 거르기·작업 로그에서 '자동으로 그려 본 것'과 '사람이 올린 것'이 갈린다.
  - 모델 이름·판은 올리는 재판정과 같다 — 같은 (항목, 모델) 한 줄이고, 대기는 어느 출처든 화면 의견이 있으면 빠지므로 올린 918건은 다시 묻지 않는다.
  - 글만 본 자동 의견(`qwen-v2-auto`, 모델 `qwen3.8-flash-next`)과 이름이 달라 서로 덮어쓰지 않는다. 글 단계는 자기 모델·판의 줄만 보고 묻고,
    화면 줄은 대기(화면 의견 없음)만 묻는다 — 서로 다시 묻지 않는다.
- 쓰기: `markScreenJudged(rows, { source: qwen-vision-auto, actor: qwen-vision-auto, lease, close: true, step: "screenReview" })` — 옮겨 적기와 같은 쓰기
  (`writeAuditSecondOpinions` — DR fence → stage → 세대 → 항목 → 설정 행 → 의견 → 닫기 → lease)에 이 PR 이 `close`·`step` 을 이어 붙였다. 쓰는 순간
  화면 판별 스위치를 다시 보고(끈 뒤 받은 답은 적지 않는다), 같은 커밋에서 답으로 닫는다. 정책 실행 일지는 누가 `qwen-vision-auto` 인 UTC 하루·행동마다의
  실행('m1 화면 자동 유지·숨김')이라 글 단계의 실행과 따로 되돌린다.
- 자동 닫기에서 화면 판정이 정한다(`audit-auto-close.ts`, 이 PR 의 최소 배선): #615 의 `thin_text`(글이 적으면 닫지 않음)는 **글만 본 의견에만** 건다 —
  화면 판정 출처의 답은 글이 적어도 닫는다(그 항목을 보려고 그린 것이다). 그때 엇갈림(다른 모델의 거절이면 유지 안 함, 다른 모델의 승인이면 숨기지 않음)은
  **화면을 본 의견끼리만** 가른다 — 그 항목에서 글만 본 의견(qwen-v2-auto·grok 일괄)은 대개 '제목만·빈 화면'을 본 것이라 세지 않는다. 확신 하한(0.90)·
  주인 있는 제품은 숨기지 않음·되돌린 항목은 다시 닫지 않음·보류 스위치는 그대로다. 화면을 본 출처끼리 엇갈리면(모델 이름이 다른 화면 판정 둘)
  열어 두고 `audit-auto-split` 에 두 판정의 결정·사유를 남긴다(#615 와 같은 꼴). 답으로 닫기 스위치는 **화면 판별의 것**(`qwenAuto.screenReview.autoClose`,
  기본 켬)이라 글 단계의 닫기를 꺼도 화면 답은 닫는다.

| 화면 답(글 적은 항목) | 하는 일 |
|---|---|
| 승인 · 확신 0.90 이상 · 다른 화면 판정의 거절 없음 | 유지 90일(`human_decision kept`, 누가 `qwen-vision-auto`) + 보류면 같은 커밋에서 풂 · 작업 로그 `audit-auto-keep` |
| 거절 · 확신 0.90 이상 · 주인 없음 · 다른 화면 판정의 승인 없음 | 아직 안 숨겼으면 숨김(감사 보류) · 작업 로그 `audit-auto-hold`. 내리지 않는다 |
| 다른 화면 판정과 반대 | 열어 둠 · `audit-auto-split` |
| 판단 보류·확신 0.90 아래 | 의견만 적고 열어 둠(대기에서 빠짐 — 사람이 본다) |
| 그리기·묻기 실패 | 적지 않음 — 두 번 실패하면 하루 쉬고 다시 본다 |

  자동으로 한 일은 0116 정책 실행 일지에 UTC 하루·행동마다 시스템 실행 하나(누가 `qwen-vision-auto`, 화면 이름 'm1 화면 자동 유지·숨김 · 날짜')로
  적혀 정책 처리 탭에서 기존 되돌리기로 실행째 되돌린다. DR fence → stage → 세대 → 항목 → 설정 행 → 자동 실행 행 → lease 차례는 #614·#615 그대로다.
- 항목만의 실패(막힘·닿지 않음·4xx/5xx·그리기 시간 초과·형식 오류)는 두 번까지 보고 하루 쉰 뒤 한 번 더 본다(관측 `screen-review` —
  모델·판이 바뀌면 처음부터). 원본이 없는 것처럼 다시 해도 같은 것은 바로 쉰다.

## 5. 글꼴

두부(빈 네모) 화면을 모델은 '빈 페이지'로 오판한다 — 재판정에서 겪었다. 화면 서버는 뜰 때(그리고 6시간마다) 네트워크 없는 페이지의 캔버스에
한글·가나·간체자를 그려 없는 글자(U+10FFFD)·빈 그림과 같은지 본다. 셋 중 하나라도 없으면 `/v1/render` 를 503 `fonts_missing` 으로 거절하고,
워커는 critical 경보(`screen_render_fonts_missing`)를 남기고 그리지 않는다.
- macOS: 시스템 글꼴(Apple SD Gothic Neo·Hiragino·PingFang)이 있다. 점검이 실패하면 `brew install --cask font-noto-sans-cjk` 처럼 Noto CJK 를
  `/Library/Fonts` 에 넣고 `screen-render.sh upgrade` 로 다시 띄운다.
- 리눅스로 옮길 때: fontconfig 는 `$HOME/.local/share/fonts` 에서도 찾는다 — 브라우저 환경의 HOME 은 그 사용자의 진짜 집(passwd)이다(HOME 을 바꾸면
  사용자 글꼴이 사라져 두부가 그려진다 — gpu3090 에서 확인). `fonts-noto-cjk` 를 시스템에 까는 편이 낫다.

## 6. 켜는 순서 (운영자)

마이그레이션 없음. 새 잡이 하나 생기므로 **scheduler 먼저** 배포한다.

1. **m1-studio 화면 서버** — m1 에서(관리자 계정, git·node 22+ 필요):
   ```sh
   git clone https://github.com/JRVector9/nomorevibe.git /tmp/nmv && cd /tmp/nmv
   sudo NODE_BIN=$(command -v node) scripts/ops/screen-render.sh install --sha <main 커밋> --host <m1 Tailscale IPv4> --allow-from <M3 IP>,<mini IP>
   ```
   끝에 찍히는 상태가 `"ok":true,"sandbox":true,"fonts":{"ko":true,"ja":true,"zh":true}` 인지 본다. 아니면 `/var/nmvrender/logs/render.log`.
   선택: `sudo scripts/ops/screen-render.sh pf-enable`.
2. **Tailscale ACL**(쓰고 있다면): M3·mini → m1:8790 만 열어 둔다.
3. **reviewer 환경**(M3 주·mini 예비 둘 다, Dokploy 비밀): `SCREEN_RENDER_URL=http://<m1 Tailscale IP>:8790`, `SCREEN_RENDER_TOKEN=<sudo cat /var/nmvrender/token>`.
   모델은 `AUDIT_SECOND_OPINION_URL`(m1 의 같은 Qwen VLM)을 그대로 쓴다. 다른 서버를 쓰려면 `SCREEN_REVIEW_MODEL_URL`·`_MODEL`·`_API_KEY`.
   (`docs/operations/production-multi-instance.env.example`)
4. **배포 순서**: scheduler(2복제본) → 공통 배포(publisher → reviewer → crawler, 웹). scheduler 가 새 잡 `audit-screen-review` 를 모르면 reviewer 의
   새 줄이 요청을 받지 못한다(크롤러 관문 시간 초과와 같은 까닭 — 잡을 더하는 릴리스는 scheduler 먼저).
5. **켜기**: 모든 앱이 새 SHA 가 된 뒤 감사 화면(감사 탭 → 자동 보류 칸 → '화면 판별')에서 켠다(사유 필요, '답으로 닫기'는 기본 켬 —
   처음 한두 시간 의견만 보려면 끄고 켠다). 처음엔 틱당 1 로 한두 시간 본다.
   `scripts/ops/set-qwen-auto.ts` 로도 된다.
6. **볼 것**: 감사 탭 화면 판별 줄(지난 1시간·남은 것·서버 상태), 작업 로그 `screen_review.ran`, 정책 처리 탭의 'm1 화면 자동 유지·숨김'(누가 qwen-vision-auto), 감사 탭 '화면 판별 대기' 수(#615),
   운영센터의 `audit-screen-review` 경보(`screen_review_not_configured`·`screen_render_unreachable`·`screen_render_fonts_missing`·`screen_model_outage`).

끄기: 감사 화면 스위치(쓰는 순간 다시 보므로 바로 멈춘다). 되돌리기: 정책 처리 탭에서 그날의 화면 판별 실행을 되돌린다. 화면 서버만 내릴 때:
`sudo scripts/ops/screen-render.sh uninstall`(잡은 `screen_render_unreachable` 로 물러난다).

배포 되돌림 주의: 이 칸(`qwenAuto.screenReview`)을 모르는 옛 코드가 설정 행을 저장하면 이 단계가 사라져 꺼짐으로 읽힌다 — 다시 올린 뒤 켠다(안전한 쪽).

## 7. 확인하지 못한 것

- m1-studio 에서 실제로 설치·실행하지 않았다(이 작업은 서버를 바꾸지 않는다). macOS 의 데몬 계정·LaunchDaemon 아래 Chromium 샌드박스 기동,
  시스템 글꼴 점검 결과, pf 규칙의 실제 동작은 m1 에서 처음 확인한다.
- 시험은 리눅스(gpu3090)에서 Playwright headless shell 로 돌렸다 — 우분투 24 가 비특권 user namespace 를 막아 **샌드박스를 끈 채** 그렸다
  (운영 서버는 끄면 뜨지 않는다). CI 에는 브라우저가 없어 진짜 브라우저 시험은 건너뛴다(egress·서버·잡 시험은 CI 에서 돈다).
- oMLX 가 화면 묻기와 글 묻기를 동시에 받을 때의 지연 — 재판정 때 두 갈래 동시 중앙값 77초였다. 운영 감사 1차의 Qwen 4자리와 겹칠 때는 재지 않았다.
- 운영의 '얇은 글' 열린 거절 수(쿼리 시간 포함)는 운영 DB 에서 재지 않았다.
