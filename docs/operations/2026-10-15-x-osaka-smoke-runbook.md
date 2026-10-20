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

## 웹 보고 — 하루 상태와 게시물(SNS 화제 C안 T18)

수집기는 매 실행 끝에 웹으로 서명한 보고를 보낸다. 계약은 [보고 runbook](2026-10-18-x-status-report-runbook.md)이다.

| env(`/etc/nomorevibe-x.env`) | 값 |
| --- | --- |
| `X_STATUS_REPORT_SECRET` | 웹 두 앱과 **같은 값**, 32바이트 이상·공백 없음. 없으면 아무것도 보내지 않는다 |
| `X_STATUS_REPORT_URL` | `https://nomorevibe.com/api/ops/x-status` — 매 실행(dry-run 포함) 하루 상태 |
| `X_POSTS_REPORT_URL` | `https://nomorevibe.com/api/ops/x-posts` — live 수집이 끝난 실행에서만 게시물 |

비밀이 있는데 주소가 하나도 없거나 https 가 아닌 주소면 설정 오류로 멈춘다(요청·예약 없음).
보내기는 한 번뿐이고(10초 제한) 결과는 `status.json` 의 `reports`(`posts`·`status`: 응답 코드 또는 `timeout`·`network`)에만 남는다.
보내기가 실패해도 수집 결과·예약 장부는 그대로다. **보고를 다시 받으려고 수집을 다시 돌리지 않는다.**
수집기는 운영 DB 자격 증명을 갖지 않는다 — DB 에 쓰는 것은 웹이다.

## 하루 10개 계약

한 recent-search 요청에서 최근24시간 최대10게시물을 읽는다. 검색 결과 즉시 lookup, pagination,
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
npx vitest run tests/x-api-pilot.test.ts tests/x-collector.test.ts tests/x-collector-config.test.ts tests/x-report.test.ts tests/x-posts.test.ts
npx tsc --noEmit
npx eslint lib/social/x-pilot.ts lib/social/x-collector.ts lib/social/x-report.ts scripts/x-collector.ts tests/x-api-pilot.test.ts tests/x-collector.test.ts tests/x-collector-config.test.ts tests/x-report.test.ts
node_modules/.bin/esbuild scripts/x-collector.ts --bundle --platform=node --target=node24 --format=esm --outfile=/private/tmp/x-collector.mjs
shasum -a 256 /private/tmp/x-collector.mjs
```

검증한 bundle을 새 `/opt/nomorevibe-x/releases/<hash-prefix>/x-collector.mjs`에 root 소유로 배치하고
SHA256을 대조한 뒤 current 링크만 교체한다. unit 원본은 `deploy/x-collector/`다.
장부 디렉터리와 env를 새 릴리스로 복사하거나 초기화하지 않는다. 서비스 실행 전에 live gate를 확인한다.
rollback은 이전 release로 current 링크만 돌리고, 필요하면 timer를 중단한다.
이 서비스는 M3/mini 앱·DB migration을 요구하지 않으며 이번 작업으로13개 core 앱을 재배포하지 않았다.

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
