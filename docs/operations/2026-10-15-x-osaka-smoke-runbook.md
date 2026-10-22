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

### 실제 수집·변경 기록(2026-10-20~)

| 시각(UTC) | 한 일 |
| --- | --- |
| 10-20 06:24 | env 백업(`/etc/nomorevibe-x.env.bak-20261020T062402Z`, root 0600) 뒤 `X_COLLECTION_LIVE=1`·`X_USE_CASE_APPROVED=1` (사용자 지시) |
| 10-20 06:39 | 보고를 넣은 release `f419c3aed5aaf5f2` 설치(임시 상태 폴더 dry-run 확인), current 교체. 이전 `60825cdc1be26b52` 는 남김 |
| 10-20 07:06 | 보고 비밀·두 보고 주소를 env 에 추가(웹 두 앱과 같은 값), 웹 재배포 뒤 두 주소 모두 401(앱 응답) 확인 |
| 10-20 07:08 | 수동 실행 1회: completed, 요청1·예약10·후보10, 게시물 보고 200·하루 보고 200. DB `social_posts`(x) 10건 |
| 10-22 | **사고**: #590 수집기 배포의 dry-run 을 `systemd-run -p EnvironmentFile=/etc/nomorevibe-x.env -E X_STATE_DIR=/tmp/…` 로 돌렸는데, systemd 는 EnvironmentFile 값이 `-E`(Environment=)를 이겨 **실제 상태 폴더** `/var/lib/nomorevibe-x` 의 `status.json`·`last-success.json` 을 dry-run 결과로 덮어썼다. 예약 장부(`budget-*.json`)는 그대로(dry-run 은 장부·`observations.json` 을 쓰지 않는다). 다음 정기 실행이 두 파일을 다시 쓴다. 바로잡은 방법은 아래 "dry-run — 임시 상태 폴더" |

첫 실제 수집의 10건은 모두 작성 70분 안의 글로 점수 0~2였다(최신순). 그래서 검색을 **관련도순**으로 바꿨다
(`X_COLLECTOR_SORT_ORDER`, release `3d25790786540aad`). 그날 예약 장부는 07:08 실행이 썼다.

## 웹 보고 — 하루 상태와 게시물(SNS 화제 C안 T18)

수집기는 매 실행 끝에 웹으로 서명한 보고를 보낸다. 계약은 [보고 runbook](2026-10-18-x-status-report-runbook.md)이다.

| env(`/etc/nomorevibe-x.env`) | 값 |
| --- | --- |
| `X_STATUS_REPORT_SECRET` | 웹 두 앱과 **같은 값**, 32바이트 이상·공백 없음. 없으면 아무것도 보내지 않는다 |
| `X_STATUS_REPORT_URL` | `https://nomorevibe.com/api/ops/x-status` — 매 실행(dry-run 포함) 하루 상태 |
| `X_POSTS_REPORT_URL` | `https://nomorevibe.com/api/ops/x-posts` — live 수집이 끝난 실행에서만 게시물 |

`X_QUERY_URL`(2026-10-21 우리 제품 저장소 묻기)은 2026-10-22 에 없앴다. 새 수집기는 이 줄을 읽지 않으므로 남아 있어도
설정 오류가 아니다 — 배포 때 지운다(아래 "배포 — GitHub 화제 검색어").

비밀이 있는데 주소가 하나도 없거나 https 가 아닌 주소면 설정 오류로 멈춘다(요청·예약 없음).
보내기는 한 번뿐이고(10초 제한) 결과는 `status.json` 의 `reports`(`posts`·`status`: 응답 코드 또는 `timeout`·`network`)에만 남는다.
하루 상태만 예외가 하나 있다 — v3 가 400 이면 v1 로 한 번 더 보내고 그 결과를 `statusV1` 에 남긴다(아래).
보내기가 실패해도 수집 결과·예약 장부는 그대로다. **보고를 다시 받으려고 수집을 다시 돌리지 않는다.**
수집기는 운영 DB 자격 증명을 갖지 않는다 — DB 에 쓰는 것은 웹이다.

## 검색어 — GitHub 주소가 있고 많이 퍼진 글(2026-10-22)

사용자 결정(2026-10-22): "X 검색방식 - Github 주소가 있고 많이 커진 글만 필터해서 10개씩 모으는 거야."

```text
(url:github.com min_likes:50) -is:retweet      ← 41자. 수집기 X_COLLECTOR_QUERY, 하한은 X_COLLECTOR_MIN_LIKES
```

- `url:github.com` 은 글의 주소(url·expanded_url)에 github.com 이 든 글, `min_likes:50` 은 좋아요 50 이상이다.
  `min_likes:`·`min_replies:`·`min_reposts:` 는 [docs.x.com 연산자 표](https://docs.x.com/x-api/posts/search/integrate/operators)의
  참여 연산자다(단독으로 쓰는 음이 아닌 정수, recent search 에서 쓴다). 웹 검색 이름 `min_faves:`·`min_retweets:` 는 API 에서 400 이다.
- 하한 50 은 공개 /talk 의 X 자격(좋아요 + 재게시×2 ≥ 50, `lib/social/talk-score.ts`)과 같은 값에서 시작한다 — 이 검색이 돌려준 글은
  점수 자격을 늘 넘는다. 좋아요는 50 아래이고 재게시로만 자격을 넘는 글은 빠진다. 바꿀 때는 상수 하나와 수집기 bundle 만 바꾼다(웹은 그대로).
- **우리 요금제에서 `min_likes:` 가 받아지는지는 문서에 없다 — 첫 실제 실행에서 확인한다**(PENDING). 받아지면 `status.json` 이
  `status: completed`·`httpStatus: 200`, 거절이면 `status: stopped`·`reason: http_error`·`httpStatus: 400` 이다(그날 예약 10은 되돌리지 않는다).
- 웹에 묻는 것은 없다. 2026-10-21 의 우리 제품 저장소 검색어(`/api/ops/x-query` 가 그날 목록을 골라 줌, `X_QUERY_URL`)는 웹·수집기에서 모두 지웠다.
  관측 표의 `x-query` 줄(차례 `{v:1, day, after, next}`)은 남지만 아무도 읽지 않는다.
- 그날 검색어는 `status.json`(·실행 결과 한 줄)의 `query` 에 `{"source":"popular","minLikes":50}` 로 남는다. 검색어 글자·비밀은 남기지 않는다.
  X 응답의 HTTP 상태는 `httpStatus` 에 남는다(요청을 보낸 실행만).
- 순서는 그대로다 — 계획 검사 → 실행 관문 → 자정 직전 60초 → 장부 → X 요청 1번(관련도순·10건).
- 보고:
  - **게시물 v2**(#590 웹부터 받는다): 반응 수가 모두 있는 공개 글을 **모두** 보낸다(저장소 0~5곳, 글이 가리킨 순서). 웹은 저장소 하나면 그 저장소 글,
    여럿이면 처음 나오는 공개 제품의 저장소 글, 공개 제품이 없거나 저장소가 없으면 `site` 글(저장소 열쇠 없음 — 링크는 첫 저장소 또는 X 게시물 주소)로 둔다.
    `site` 글은 /talk·홈·상세·'아직 공개 제품이 아닌 저장소' 수에 오르지 않고 `/admin/talk` 에만 보인다(목록 표에 '제품 사이트'·저장소 '—'로 나온다).
    본문·작성자는 여전히 보내지도 저장하지도 않는다. 저장소 하나만 싣던 v1 은 보내지 않는다(웹은 옛 수집기의 v1 을 계속 받는다).
  - **하루 상태 v3**: `query`(`{"source":"popular","minLikes":50}`) 한 칸이 더 있다. 운영센터 X 칸에 "검색 GitHub 주소·좋아요 50 이상"으로 보인다.
    v3 를 모르는 웹(#590 까지)은 400 이다 — 그 실행에서 한 번만 칸 없는 v1 로 다시 보낸다(400 은 웹이 DB 를 보기 전에 거절해 단조·속도 줄을 남기지 않는다).
    `status.json` 의 `reports` 가 `{"status":400,"statusV1":200}` 이면 웹이 아직 옛 판이다. 429·503·시간 초과 같은 다른 실패는 다시 보내지 않는다.

## 하루 10개 계약

한 recent-search 요청에서 최근24시간 최대10게시물을 **관련도순**(`sort_order=relevancy`)으로 읽는다. 검색어는 위의 `url:github.com min_likes:50` 이다.
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
npx vitest run tests/x-api-pilot.test.ts tests/x-collector.test.ts tests/x-collector-config.test.ts tests/x-report.test.ts tests/x-posts.test.ts tests/x-status.test.ts tests/x-status-route.test.ts
npx tsc --noEmit
npx eslint lib/social/x-pilot.ts lib/social/x-collector.ts lib/social/x-report.ts scripts/x-collector.ts tests/x-api-pilot.test.ts tests/x-collector.test.ts tests/x-collector-config.test.ts tests/x-report.test.ts
node_modules/.bin/esbuild scripts/x-collector.ts --bundle --platform=node --target=node24 --format=esm --outfile=/private/tmp/x-collector.mjs
shasum -a 256 /private/tmp/x-collector.mjs
grep -cE 'drizzle-orm|DATABASE_URL|from "postgres"' /private/tmp/x-collector.mjs   # 0 — bundle 에 DB 코드가 없다
```

검증한 bundle을 새 `/opt/nomorevibe-x/releases/<hash-prefix>/x-collector.mjs`에 root 소유로 배치하고
SHA256을 대조한 뒤 current 링크만 교체한다. unit 원본은 `deploy/x-collector/`다.
장부 디렉터리와 env를 새 릴리스로 복사하거나 초기화하지 않는다. 서비스 실행 전에 live gate를 확인한다.
rollback은 이전 release로 current 링크만 돌리고, 필요하면 timer를 중단한다.
이 서비스는 M3/mini 앱·DB migration을 요구하지 않으며 이번 작업으로13개 core 앱을 재배포하지 않았다.

### 배포 — GitHub 화제 검색어(2026-10-22 변경)

**웹 먼저, 수집기 나중.** DB migration·잡 카탈로그 변경은 없다. 순서를 거꾸로 해도 깨지지는 않는다 — #590 웹은 게시물 v2 를 받고,
하루 상태 v3 는 400 으로 거절해 수집기가 v1 으로 다시 보낸다(운영센터에 검색어 칸만 빠진다).

1. 웹 두 앱(M3·mini)을 이 변경을 담은 main 으로 재배포한다(평소 웹 배포 절차. 워커는 필요 없다 — 웹만 받는다).
   확인: 서명 없는 `POST https://nomorevibe.com/api/ops/x-query` 가 **404** 면 새 웹이다(주소를 지웠다). **401** 이면 아직 #590 웹이다 —
   여러 번 보내 두 웹 모두 404 인지 본다. `POST /api/ops/x-status`·`/api/ops/x-posts` 는 그대로 401 이다.
2. 로컬: 위 빌드 명령으로 bundle 을 만들고 SHA256 을 적는다(DB 코드 0 확인).
3. osaka: 새 release 로 배치하고 **current 링크만** 바꾼다. 장부·상태 폴더·env 는 복사하거나 초기화하지 않는다.

   ```sh
   scp /private/tmp/x-collector.mjs osaka-smoke:/tmp/x-collector.mjs
   ssh osaka-smoke "sudo bash -s -- <로컬 SHA256 64자>" <<'EOF'
   set -euo pipefail
   expected=$1; sum=$(sha256sum /tmp/x-collector.mjs | cut -d' ' -f1)
   [ "$sum" = "$expected" ] || { echo "sha256 mismatch"; exit 1; }
   release=releases/${sum:0:16}
   install -d -o root -g root -m 0755 "/opt/nomorevibe-x/$release"
   install -o root -g root -m 0644 /tmp/x-collector.mjs "/opt/nomorevibe-x/$release/x-collector.mjs"
   echo "previous: $(readlink /opt/nomorevibe-x/current)"      # 되돌릴 곳 — 적어 둔다
   ln -sfn "$release" /opt/nomorevibe-x/current.next && mv -T /opt/nomorevibe-x/current.next /opt/nomorevibe-x/current
   echo "current: $(readlink /opt/nomorevibe-x/current)"; sha256sum /opt/nomorevibe-x/current/x-collector.mjs
   rm -f /tmp/x-collector.mjs
   EOF
   ```

4. root 전용 env 를 백업하고 `X_QUERY_URL` 줄만 지운다. 값은 출력하지 않는다(이름만 본다).

   ```sh
   ssh osaka-smoke 'sudo bash -s' <<'EOF'
   set -euo pipefail
   env=/etc/nomorevibe-x.env; backup=$env.bak-$(date -u +%Y%m%dT%H%M%SZ)
   cp -p "$env" "$backup"                                 # root:root 0600 그대로
   sed -i '/^X_QUERY_URL=/d' "$env"
   stat -c '%n %U:%G %a' "$env" "$backup"                  # 둘 다 root:root 600
   grep -c '^X_QUERY_URL=' "$env" || true                  # 0
   grep -oE '^[A-Z_][A-Z0-9_]*=' "$env" | sort             # 남은 이름(값 없음) — 보고 비밀·두 보고 주소·live 두 줄이 있어야 한다
   EOF
   ```

5. 아래 방법으로 임시 상태 폴더 dry-run 1회 — X 요청·예약 0. 결과 한 줄의 `query` 가 `{"source":"popular","minLikes":50}`,
   임시 `status.json` 의 `reports.status` 가 200 이면 웹이 v3 를 받았다(`400`·`statusV1: 200` 이면 1단계 웹이 아직 옛 판).
   이 dry-run 도 하루 보고를 보내므로 다음 정기 실행 전까지 운영센터 X 칸이 시험 실행(읽기 0)으로 보인다.
6. 다음 00:10 UTC 정기 실행 뒤 `status.json` 의 `status`·`httpStatus`·`query`·`reports`(posts·status 200)와 `/admin/talk` 의 X 글을 본다.
   `httpStatus: 400`(`reason: http_error`)이면 우리 요금제가 `min_likes:` 를 받지 않는 것이다 — 그날 읽기는 썼다. 다음 날 같은 실패를
   되풀이하지 않게 타이머를 멈추거나 되돌리고(아래) 사용자에게 검색어를 다시 묻는다.

되돌리기: 수집기는 이전 release 로 current 링크만 돌린다. #590 수집기는 `X_QUERY_URL` 이 없으면 옛 고정 검색어(`launch OR …`)·v1 보고로 돌고,
새 웹은 v1 을 그대로 받는다. 우리 제품 저장소 검색어로는 돌아갈 수 없다(웹의 `/api/ops/x-query` 를 지웠다 — 웹까지 되돌려야 한다).

### dry-run — 임시 상태 폴더(실제 상태 폴더를 건드리지 않는다)

`systemd-run -p EnvironmentFile=/etc/nomorevibe-x.env -E X_STATE_DIR=/tmp/…` 은 **임시 폴더를 쓰지 않는다**. `-E` 는 Environment= 이고,
systemd 는 EnvironmentFile 의 값이 Environment= 를 이긴다(systemd.exec) — 10-22 에는 env 파일 쪽 상태 폴더 값이 이겨
실제 폴더의 `status.json`·`last-success.json` 을 덮어썼다(위 기록). 같은 이름이 여러 EnvironmentFile 에 있으면 **뒤에 적은 파일이 이긴다** —
그래서 `X_STATE_DIR` 한 줄만 든 root 전용 임시 env 파일을 **두 번째** `-p EnvironmentFile=` 로 준다. 실제 폴더의 지문을 앞뒤로 비교한다.

```sh
ssh osaka-smoke 'sudo bash -s' <<'EOF'
set -euo pipefail
real=/var/lib/nomorevibe-x
dir=$(mktemp -d /var/tmp/nomorevibe-x-dryrun.XXXXXX); chown nomorevibe-x:nomorevibe-x "$dir"; chmod 0700 "$dir"
override=$(mktemp /run/nomorevibe-x-dryrun.XXXXXX)                 # root 0600
printf 'X_STATE_DIR=%s\n' "$dir" > "$override"
fingerprint() { stat -c '%n %i %s %Y' "$real" "$real"/* | sha256sum; }   # 이름·inode·크기·수정 시각(폴더 자신 포함)
before=$(fingerprint)
systemd-run --quiet --wait --pipe --collect -p User=nomorevibe-x -p Group=nomorevibe-x -p UMask=0077 \
  -p EnvironmentFile=/etc/nomorevibe-x.env -p EnvironmentFile="$override" \
  /usr/bin/node /opt/nomorevibe-x/current/x-collector.mjs --dry-run || echo "dry-run exit $?"
[ "$(fingerprint)" = "$before" ] && echo "real state dir untouched" || echo "REAL STATE DIR CHANGED"
ls -l "$dir"; cat "$dir/status.json" || true                       # 결과·reports 뿐, 비밀 없음
rm -f "$override"; rm -rf "$dir"
EOF
```

- 확인할 것: `real state dir untouched`, 임시 폴더에 `status.json`·`last-success.json` 이 생김(장부 `budget-*` 는 없음), 결과 한 줄의 `status: planned`·`requests: 0`.
  `REAL STATE DIR CHANGED` 면 실제 폴더에 쓴 것이다 — 장부(`budget-*.json`)는 dry-run 이 쓰지 않지만 `ls -l --time-style=full-iso /var/lib/nomorevibe-x` 로 무엇이 바뀌었는지 적어 둔다.
- 실제 폴더는 `writeCurrent` 가 새 파일로 바꿔 끼우므로(rename) 한 번이라도 쓰면 inode 와 폴더 수정 시각이 바뀐다 — 지문이 같으면 쓰지 않은 것이다.
- 웹 보고까지 막으려면 임시 env 파일에 `X_STATUS_REPORT_URL=` 한 줄을 더한다(빈 값 = 보내지 않음. dry-run 은 게시물을 보내지 않는다).
  배포 확인(웹이 v3 를 받는지)에는 보고를 보내는 쪽을 쓴다.

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
