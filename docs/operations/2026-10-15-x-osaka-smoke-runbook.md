# X 독립 수집기 — osaka-smoke

## 대상과 실제 상태

대상은 **surfguide / ap-osaka-1 / osaka-smoke**다. SSH도 `osaka-smoke`를 사용한다.
**onetwoday는 대상이 아니다.** M3 crawler role이나 운영 DB 자격 증명을 사용하지 않는다.

2026-10-15 14:07–14:09 KST 설치·검증:

| 항목 | 실제 결과 |
| --- | --- |
| 실행 폴더 | `/opt/nomorevibe-x/current` → `releases/60825cdc1be26b52` |
| 실행 파일 SHA256 | `60825cdc1be26b52cfa153588f7ec35876f9d2ec84752c3b8932ae5690a6519d` |
| 런타임 | `/usr/bin/node`, v24.19.0, ARM64 |
| 계정 | `nomorevibe-x`, 로그인 셸 없음 |
| 설정 | `/etc/nomorevibe-x.env`, root:root 0600 |
| 상태 | `/var/lib/nomorevibe-x`, 전용 계정 0700 |
| 서비스/타이머 | `nomorevibe-x.service` / `.timer`, timer active/enabled |
| 실행 시각 | 매일 **00:10 UTC / 09:10 KST**, Persistent=true |
| 실제 검증 | systemd-analyze verify 성공, oneshot exit0, planned/요청0/예약0 |
| 실제 API 수집 | **아직 없음**. live=0, use-case-approved=0 |

토큰은 사용자가 제공한 로컬 `~/.config/nomorevibe/x-api.env`에서 SSH stdin으로 전달했다.
토큰·env 전문을 명령 인자·로그·Git에 출력하지 않았다. 구매·자동충전·권한 확대는 하지 않았다.
X 사용 목적 승인 기록은 아직 확인하지 못했다. 토큰/API200을 외부 승인 기록으로 대체하지 않는다.
독립 서비스 설치와 실제 수집 가동을 구별한다.

### 2026-10-20 실제 수집 시작

| 시각(UTC) | 한 일 |
| --- | --- |
| 06:24 | env 백업(`/etc/nomorevibe-x.env.bak-20261020T062402Z`, root 0600) 뒤 `X_COLLECTION_LIVE=1`·`X_USE_CASE_APPROVED=1` (사용자 지시) |
| 06:39 | 보고를 넣은 release `f419c3aed5aaf5f2` 설치(임시 상태 폴더 dry-run 확인), current 교체. 이전 `60825cdc1be26b52` 는 남김 |
| 07:06 | 보고 비밀·두 보고 주소를 env 에 추가(웹 두 앱과 같은 값), 웹 재배포 뒤 두 주소 모두 401(앱 응답) 확인 |
| 07:08 | 수동 실행 1회: completed, 요청1·예약10·후보10, 게시물 보고 200·하루 보고 200. DB `social_posts`(x) 10건 |

첫 실제 수집의 10건은 모두 작성 70분 안의 글로 점수 0~2였다(최신순). 그래서 검색을 **관련도순**으로 바꿨다
(`X_COLLECTOR_SORT_ORDER`, release `3d25790786540aad`). 그날 예약 장부는 07:08 실행이 썼다.

## 웹 보고 — 하루 상태와 게시물(SNS 화제 C안 T18)

수집기는 매 실행 끝에 웹으로 서명한 보고를 보낸다. 계약은 [보고 runbook](2026-10-18-x-status-report-runbook.md)이다.

| env(`/etc/nomorevibe-x.env`) | 값 |
| --- | --- |
| `X_STATUS_REPORT_SECRET` | 웹 두 앱과 **같은 값**, 32바이트 이상·공백 없음. 없으면 아무것도 보내지 않는다 |
| `X_STATUS_REPORT_URL` | `https://nomorevibe.com/api/ops/x-status` — 매 실행(dry-run 포함) 하루 상태 |
| `X_POSTS_REPORT_URL` | `https://nomorevibe.com/api/ops/x-posts` — live 수집이 끝난 실행에서만 게시물 |
| `X_QUERY_URL` | `https://nomorevibe.com/api/ops/x-query` — 매 실행(dry-run 포함) 그날 검색할 우리 제품 저장소를 묻는다. 없으면 고정 검색어 |

비밀이 있는데 주소가 하나도 없거나 https 가 아닌 주소면 설정 오류로 멈춘다(요청·예약 없음).
보내기는 한 번뿐이고(10초 제한) 결과는 `status.json` 의 `reports`(`posts`·`status`: 응답 코드 또는 `timeout`·`network`)에만 남는다.
보내기가 실패해도 수집 결과·예약 장부는 그대로다. **보고를 다시 받으려고 수집을 다시 돌리지 않는다.**
수집기는 운영 DB 자격 증명을 갖지 않는다 — DB 에 쓰는 것은 웹이다.

## 검색어 — 우리 제품 저장소(2026-10-21)

고정 검색어(`X_COLLECTOR_QUERY`, `url:github.com (launch OR … ) has:links`)로는 10-21 까지 7일 동안 본 저장소 17곳 중
우리 제품이 1곳이라 /talk 에 X 글이 오르지 못했다(사용자 지시로 변경). 이제 수집기는 매 실행 처음에 웹에 그날 검색할
저장소를 묻고(`X_QUERY_URL`, 서명 POST 한 번·10초), 답으로 검색어를 만든다.

```text
(url:"github.com/owner/repo" OR url:"github.com/owner2/repo2" OR …) -is:retweet      ← 감싼 전체가 512자 이하
```

- `url:` 은 글의 주소(url·expanded_url)를 낱말로 잘라 맞춘다(docs.x.com 연산자 표). 빗금·점이 든 경로는 따옴표로 묶는다
  (엔터프라이즈 연산자 안내의 `url:"/developer"`). 따옴표 경로가 실제 X 응답에서 기대대로 맞는지는 **첫 실제 실행에서 확인한다**(PENDING).
  낱말 맞춤이라 이름이 더 긴 저장소(`owner/repo-plus`)·그 저장소의 이슈 주소도 잡힐 수 있다 — 글이 가리킨 저장소는 수집기가 주소에서 다시 읽는다.
- 하루 10~13곳이 든다(이름 15~25자 기준. 저장소 하나가 `17 + 이름 길이`자, 이음말 ` OR ` 4자). 512자 검사는 `runXPilot` 한 곳이다.
- 웹이 고르는 법(`lib/social/x-query.ts`, `/api/ops/x-query`): 공개 제품(/talk 와 같은 조건 — seeded·verified, 응답 있음, 기본 목록,
  감사 보류 아님, 저장소 살아 있음) 중 github.com 저장소가 있는 것, 저장소마다 먼저 등록된 제품 하나.
  1. **차례**(약 160자, 하루 3~4곳): 제품 id 순으로 지난 차례가 멈춘 곳 다음부터 — 끝에 닿으면 처음으로. 웹이 관측 표 `x-query` 줄에
     `{day, after, next}` 를 적어 날마다 이어 가므로 제품이 늘어도 건너뛰거나 겹치지 않는다. 같은 날 다시 물으면 같은 목록이다(dry-run·재실행이 차례를 넘기지 않는다).
     한 바퀴는 공개 제품 수 ÷ 3~4 일이다 — 하루 읽기 10건 안에서는 긴 꼬리를 자주 볼 수 없다.
  2. **먼저 볼 것**(남은 자리, 7~9곳): 스타가 느는 제품(홈 '지금 뜨는' 조건, 하루 평균 증가 큰 순)과 14일 안에 오른 제품(새것 순)을 번갈아.
- 묻는 주소가 없거나, 묻기가 실패(시간 초과·연결·404·503·형식)하거나, 목록이 비면 **고정 검색어로 그날 읽기를 쓴다**. 어느 쪽이었는지는
  `status.json`(·실행 결과 한 줄)의 `query` 에 남는다: `{"source":"products","repositories":12,"reason":null}` 또는
  `{"source":"default","repositories":0,"reason":"timeout"}`(`not_configured`·`network`·`http_404`·`invalid_response`·`empty`·`invalid_query`).
  저장소 이름·검색어 글자·비밀은 남기지 않는다.
- 묻기는 예약 장부보다 **먼저** 끝난다. 그 뒤 순서는 그대로다 — 정확한 검색어로 계획 검사 → 실행 관문 → 자정 직전 60초 → 장부 → X 요청 1번.
  우리 저장소 검색어가 계획 검사에 걸리면 고정 검색어로 다시 검사한다(`invalid_query`). 묻기(10초)와 X 요청(20초)은 자정 직전 60초 안에 든다.
- **답한 웹만 새 보고 형식(v2)을 받는다고 본다.** 묻기가 실패한 날은 옛 웹일 수 있어 게시물·하루 보고를 v1(예전 그대로)로 보낸다.
  - 게시물 v2: 반응 수가 모두 있는 공개 글을 **모두** 보낸다(저장소 0~5곳, 그날 검색한 우리 저장소가 앞). 웹은 저장소 하나면 그 저장소 글,
    여럿이면 처음 나오는 공개 제품의 저장소 글, 공개 제품이 없거나 저장소가 없으면 `site` 글(저장소 열쇠 없음 — 링크는 첫 저장소 또는 X 게시물 주소)로 둔다.
    `site` 글은 /talk·홈·상세·'아직 공개 제품이 아닌 저장소' 수에 오르지 않고 `/admin/talk` 에만 보인다(목록 표에 '제품 사이트'·저장소 '—'로 나온다).
    본문·작성자는 여전히 보내지도 저장하지도 않는다.
  - 하루 상태 v2: `query`(출처·저장소 수·사유) 한 칸이 더 있다. 운영센터 X 칸에 "검색 우리 저장소 N곳" / "고정 검색어(사유)"로 보인다.

## 하루 10개 계약

한 recent-search 요청에서 최근24시간 최대10게시물을 **관련도순**(`sort_order=relevancy`)으로 읽는다. 검색어는 위의 우리 제품 저장소 검색어(못 물으면 고정 검색어)다.
관련도 순서의 기준은 X 가 공개하지 않는다(값은 `recency`·`relevancy` 둘뿐). 검색 결과 즉시 lookup, pagination,
자동 재시도는 없다. **많이 읽고 저장만10개로 줄이는 방식이 아니다.** 실제 고유 저장소 후보는
중복·링크 없음·여러 저장소 연결 때문에10개보다 적을 수 있다.

UTC 날짜의 `budget-YYYY-MM-DD.json`을 exclusive 생성/0600으로 기록하고 파일·디렉터리를
fsync한 뒤 HTTP를 실행한다. 실패·재시작·동시 실행·깨진 기존 장부도 예약을 되돌리지 않는다.
자정 직전60초에는 요청하지 않는다. 서버 시각과 상태 볼륨이 정상이고 이 수집기만 해당 장부를
사용한다는 운영 조건이다. 별도 파일럿을 수동 실행하면 이 장부를 공유하지 않으므로 함께 돌리지 않는다.

read $0.005 기준10개는 최대$0.05/일,31일$1.55의 단순 환산이며 실제 계정 청구액 보증은 아니다.
최신 단가·계정 크레딧은 [X 요금](https://docs.x.com/x-api/getting-started/pricing)에서 확인한다.

`observations.json`은 저장소별 반응 합계·기여 게시물 수·시각의 비공개 최신 스냅샷이다.
본문·작성자·프로필·raw 응답은 저장하지 않는다. 반응 누락은 null, withheld/모호한 링크는 제외한다.
`skillVerified:false`이며 SKILL.md 존재나 제품 적합성을 검증한 결과가 아니다.
24시간 만료 이후 표시하면 안 된다. 이 파일은 웹이 읽지 않는다 — 웹에는 게시물 보고(ID·저장소·반응 수)로 가고,
웹도 마지막 확인 뒤 24시간만 공개 화면에 보인다. 다음 유효 요청이 파일을 교체한다.
장기 관측 기록이나 성장률/HOT 확정 순위가 아니다.

## 운영 명령

```sh
ssh osaka-smoke 'systemctl list-timers nomorevibe-x.timer --no-pager'
ssh osaka-smoke 'sudo systemctl show nomorevibe-x.service -p Result -p ExecMainStatus -p MemoryMax -p CPUQuotaPerSecUSec'
ssh osaka-smoke 'sudo cat /var/lib/nomorevibe-x/status.json'
ssh osaka-smoke 'sudo journalctl -u nomorevibe-x.service -n 10 --no-pager'
```

env 전문을 cat하거나 `systemctl show ... -p Environment`로 출력하지 않는다.
중단은 timer를 disable/stop한다. **budget 파일/상태 디렉터리 삭제는 금지**한다.

```sh
ssh osaka-smoke 'sudo systemctl disable --now nomorevibe-x.timer'
```

현재 dry-run 설정에서 수동 서비스 실행은 요청0이다. 실제 목적 승인과 계정 상태를 확인한 뒤
root 전용 env의 `X_COLLECTION_LIVE=1`, `X_USE_CASE_APPROVED=1`을 설정해야 실제 호출한다.
이 플래그 자체가 외부 승인을 만들어 내지는 않는다. 토큰은 CLI 인자로 전달하지 않는다.
승인 범위는 [정책 확인 기록](2026-10-14-x-api-policy-and-pilot.md)을 따른다.

## 빌드·갱신·복구

```sh
npx vitest run tests/x-api-pilot.test.ts tests/x-collector.test.ts tests/x-collector-config.test.ts tests/x-report.test.ts tests/x-posts.test.ts tests/x-query.test.ts
npx tsc --noEmit
npx eslint lib/social/x-pilot.ts lib/social/x-collector.ts lib/social/x-report.ts lib/social/x-query.ts scripts/x-collector.ts tests/x-api-pilot.test.ts tests/x-collector.test.ts tests/x-collector-config.test.ts tests/x-report.test.ts tests/x-query.test.ts
node_modules/.bin/esbuild scripts/x-collector.ts --bundle --platform=node --target=node24 --format=esm --outfile=/private/tmp/x-collector.mjs
shasum -a 256 /private/tmp/x-collector.mjs
```

검증한 bundle을 새 `/opt/nomorevibe-x/releases/<hash-prefix>/x-collector.mjs`에 root 소유로 배치하고
SHA256을 대조한 뒤 current 링크만 교체한다. unit 원본은 `deploy/x-collector/`다.
장부 디렉터리와 env를 새 릴리스로 복사하거나 초기화하지 않는다. 서비스 실행 전에 live gate를 확인한다.
rollback은 이전 release로 current 링크만 돌리고, 필요하면 timer를 중단한다.
이 서비스는 M3/mini 앱·DB migration을 요구하지 않으며 이번 작업으로13개 core 앱을 재배포하지 않았다.

### 우리 제품 저장소 검색어 배포 순서(2026-10-21 변경)

**웹 먼저, 수집기 나중.** DB migration·잡 카탈로그 변경은 없다. 순서를 거꾸로 해도 깨지지는 않는다 — 옛 웹에 물으면 404 라
수집기는 고정 검색어·v1 보고로 돈다. 다만 두 쪽이 다 바뀐 다음 실행부터 효과가 난다.

1. 웹 두 앱(M3·mini)을 이 변경을 담은 main 으로 재배포한다(평소 웹 배포 절차. 워커는 필요 없다 — 웹만 받는다).
   확인: 서명 없는 `POST https://nomorevibe.com/api/ops/x-query` 가 **401**(앱 JSON, `cache-control: private, no-store`)이면 켜진 것이다.
   404 면 그 웹에 비밀이 없거나 아직 옛 웹이다 — 여러 번 보내 두 웹 모두 401 인지 본다. Cloudflare 가 막으면(403·HTML) 이 주소도
   [보고 runbook](2026-10-18-x-status-report-runbook.md)의 예외 규칙에 더한다.
2. osaka 수집기: 위 빌드 명령으로 bundle 을 만들고 새 release 로 배치한다(current 링크만 교체, 장부·상태 폴더는 그대로).
3. root 전용 env 를 백업(root 0600)한 뒤 `X_QUERY_URL=https://nomorevibe.com/api/ops/x-query` 한 줄을 더한다. 전문을 출력하지 않는다.
4. 임시 상태 폴더(`X_STATE_DIR`)로 `--dry-run` 1회 — X 요청·예약 0. 결과 한 줄의 `query.source` 가 `products`, `repositories` 가 10 안팎인지 본다
   (웹 로그 `x_query.served` 에도 남는다). 이 dry-run 도 하루 보고를 보내므로 다음 정기 실행 전까지 운영센터 X 칸이 시험 실행으로 보이고,
   그날 차례를 연다(같은 날 정기 실행은 같은 목록을 쓴다).
5. 다음 00:10 UTC 정기 실행 뒤 `status.json` 의 `query`·`reports`(posts·status 200)와 `/admin/talk` 의 X 글을 본다.

되돌리기: 수집기는 이전 release 로 current 링크만 돌린다(옛 수집기 v1 은 새 웹이 그대로 받는다). 웹을 되돌리면 묻기가 404 가 되어 수집기가
알아서 고정 검색어로 돈다. `X_QUERY_URL` 을 지우면 예전 동작(고정 검색어·v1 보고)이다.

## 마지막 단계 — Mautic 정리

14:09 KST, X 서비스 dry-run 검증 후 수행했다. Mautic 외 활성 nginx site가 없고 사용자 DB가
mautic 하나인 것, 애플리케이션 설정의 db_name도 mautic인 것을 실제 확인했다.

- `nginx`, `php8.3-fpm`, `mariadb`, `cloudflared-quicktunnel`을 disable/stop, 전부 inactive 확인.
- `/var/www/mautic`과 enabled/available의 mautic nginx 설정을 아래 private 백업으로 **이동 보관**했다.
- DB는 삭제하지 않았다. 최종 transaction-consistent dump도 별도로 보관했다(1,372,038bytes).
  gzip 전체 읽기·CREATE TABLE·완료 marker·SHA256 확인. **별도 DB 복원 실행은 아직 하지 않았다.**
- 패키지 전체 삭제나 Tailscale/OCI monitoring agent 변경은 하지 않았다.
- 정리 후 X service 재실행 exit0/요청0/예약0, timer active를 재확인했다.

백업 위치: `/var/backups/nomorevibe/mautic-retired-20261015T050901Z` (root0700).
`mautic/`, `mautic.sql.gz`, `backup-sha256.txt`, nginx 설정, tunnel unit 사본,
`units-before.json`, `cleanup-proof.json`이 있다. 민감한 설정이 포함되므로 공개/커밋하지 않는다.

복구할 때 timer를 유지한 채 Mautic 폴더를 `/var/www/mautic`으로 돌리고 nginx available 설정과
enabled symlink를 원위치에 둔다. 기존 DB는 남아 있다. `nginx -t` 이후 units-before의
enabled/active 상태를 따라 네 서비스를 복구한다. DB dump 복원은 기존 DB 상태를 먼저 확인하고
별도 작업으로 진행한다. 백업을 검증 없이 지우지 않는다.

## crawler 집중 구조와 후속 분리

M3의 active crawler1개가 GitHub 수집8종을5개 병렬 lane으로 실행한다.
seed/fetch, 제품 근거, agent 근거 스캔, AI-level, stars 관측 등이 같은 프로세스를 공유한다.
reviewer/publisher/text/maintenance는 이미 독립 역할이며 mini에 각 예비가 있다.
M3 crawler 장애 시 lease 만료 후 같은 릴리스의 mini가 인계하므로 crawler가 단일 무대책 구성은 아니다.
단, 전환 공백·공통 코드 오류·DB/인증 장애는 남는다. 새 X 서비스에는 아직 예비 실행자가 없다.

다음 분리는5개 lane을 각각 lease·재시작·주/예비·관리자 관측이 있는 실행 단위로 만드는 방향이다.
느린 작업과 프로세스 장애의 영향을 줄일 수 있지만 공유 GitHub quota가 늘지는 않는다.
현재 M3 CPU 포화는 짧은 관측에서 없었으므로 처리량 배수 증가를 주장하지 않는다.
진행 중인 근거 갱신 helper는 이번 X 이전에서 변경하지 않았다.
