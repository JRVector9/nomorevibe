# Cloudflare 등에서 사람이 직접 할 일 — 공개 HTML 이름·요약만(PR A·PR B) (2026-11-15)

- 짝 문서: [구현 방안](2026-11-15-public-html-name-summary.md). 앞선 설정 순서는 2026-11-14 Cloudflare 1단계 안내(규칙 1~4·속도 제한)다.
- 운영 실측(2026-11-15 13:59Z, gpu3090에서 일반 브라우저 UA로 GET):
  - `meta-externalagent` UA로 홈 → **200(통과)**. 11/15 시험 때와 같다.
  - 홈 응답에 `Content-Security-Policy` 머리글이 없다 → Turnstile을 위해 보안 머리글을 고칠 일은 없다.
  - 홈 `cf-cache-status: HIT`, `/api/health` `DYNAMIC` → API는 Cloudflare가 저장하지 않는다.
  - `www.nomorevibe.com` → `https://nomorevibe.com/`로 308 → Turnstile 호스트는 `nomorevibe.com` 하나면 된다.

## 0. 한눈에

| 순서 | 언제 | 할 일 | 어디서 |
|---|---|---|---|
| 1 | 지금 | 규칙 3에 Meta 학습 봇 이름 추가 | Cloudflare |
| 2 | 지금 | 규칙 4 끝의 예외 IP가 예시값(`203.0.113.10`)이 아닌지 확인 | Cloudflare |
| 3 | 지금(아무 때나) | Turnstile 위젯 만들고 키 두 개 보관 | Cloudflare |
| 4 | PR A 배포 전 | 색인 수 기준값 기록 | Google Search Console·네이버 서치어드바이저 |
| 5 | 11/17~18 | 이벤트를 보고 규칙 1·2·3을 Block으로 | Cloudflare |
| 6 | PR B 배포 뒤 | 웹 앱 두 곳에 env 3개 넣고 재배포 | Dokploy |

PR A에는 Cloudflare에서 할 일이 없다. 배포 뒤 옛 HTML 사본은 배포 도구가 `html` 태그로 지운다(`scripts/ops/deploy_shared_images.py` purge_html, `lib/jobs/products/cdn-purge.ts`). 지워졌는지는 대표가 배포 뒤 확인한다.

## 1. 규칙 3에 Meta 학습 봇 추가 (지금)

1. `Security → Security rules`(화면에 따라 `Security → WAF`) → `nmv-script-clients` → **Edit expression**.
2. 식에서 `lower(http.user_agent) contains "ccbot"`와 그 바로 뒤의 닫는 괄호 `)` 사이에 아래를 넣는다. 닫는 괄호 뒤는 `and not starts_with(http.request.uri.path, "/api/")`로 이어져야 한다.

```
 or lower(http.user_agent) contains "meta-externalagent"
```

3. 저장한다. 알려 주면 대표가 같은 방법으로 다시 잰다.

## 2. 규칙 4 예외 IP 확인 (지금)

- `nmv-datacenter-challenge` 식 맨 끝 `not ip.src in {…}` 안이 Oracle 오사카 감시 서버의 공인 IP인지 본다.
- 예시값 `203.0.113.10`이 그대로면 Oracle 감시가 확인 화면에 걸릴 수 있다. Oracle 콘솔의 인스턴스 화면에서 공인 IP를 보고 바꾼다.
- 허브 장비 목록에 Oracle 공인 IP가 없어 대표는 확인하지 못했다.

## 3. Turnstile 위젯 만들기 (PR B용, 지금 만들어 둬도 됨)

1. Cloudflare 대시보드 왼쪽 메뉴에서 **Turnstile**을 연다. 도메인 화면 안이 아니라 계정 메뉴에 있다. 화면에 따라 `Application security` 아래에 있다.
2. **Add widget**을 누른다.
3. 칸을 이렇게 채운다.
   - **Widget name**: `nomorevibe-api-session`
   - **Hostname management**: `nomorevibe.com` 하나. `www`는 본 주소로 넘어가므로 넣지 않는다. `localhost`도 넣지 않는다. 개발·시험은 Cloudflare 시험 키를 쓴다.
   - **Widget mode**: **Invisible**
   - **Pre-clearance support**: 쓰지 않음(No). 이 위젯은 API 세션 발급에만 쓴다. WAF 확인 화면의 통과 쿠키와 섞지 않는다.
4. **Create**를 누른다.
5. 나오는 **Sitekey**와 **Secret key**를 비밀번호 관리자에 보관한다. 대화·작업·메시지·저장소에는 넣지 않는다.

무료 요금제에서 위젯 20개까지, 확인 횟수는 제한이 없다([요금제](https://developers.cloudflare.com/turnstile/plans/)).

## 4. 색인 수 기준값 (PR A 배포 전, Cloudflare 밖)

- Google Search Console: `페이지`(색인 생성) 화면의 색인된 페이지 수, `실적` 화면의 지난 28일 클릭·노출 수를 적어 둔다.
- 네이버 서치어드바이저: 사이트맵 제출 상태와 수집 현황을 적어 둔다. 사이트맵이 제출돼 있지 않으면 `https://nomorevibe.com/sitemap.xml`을 제출한다.
- 배포 2~4주 뒤 같은 칸을 비교한다. 상세 페이지가 이름·요약뿐이라 일부가 '얇은 페이지'로 색인에서 빠질 수 있다.

## 5. 규칙 1·2·3을 Block으로 (11/17~18)

1. `Security → Analytics → Events`에서 규칙별로 걸린 요청을 본다.
2. 네이버(Yeti)·다음·Google·Bing이 규칙 1·2에 걸리지 않았는지, 일반 통신사 대역이 규칙 4·속도 제한에 많이 걸리지 않았는지 본다.
3. 문제없으면 규칙 1·2·3의 동작을 **Block**으로 바꾼다. 규칙 4는 Managed Challenge 그대로 둔다.

## 6. 웹 앱 env 3개 (PR B 배포 뒤, Dokploy)

PR B는 아래 3개가 모두 있을 때만 관문을 켠다. 없으면 지금과 똑같이 동작한다. 그래서 PR B를 먼저 배포하고 env를 나중에 넣는다.

| 이름 | 값 |
|---|---|
| `TURNSTILE_SITE_KEY` | 3번의 Sitekey |
| `TURNSTILE_SECRET_KEY` | 3번의 Secret key |
| `PUBLIC_API_SESSION_SECRET` | 본인 컴퓨터에서 `openssl rand -hex 32`로 만든 64자. 두 앱에 **같은 값** |

1. Dokploy에서 **web-m3**와 **web-mini** 두 앱의 Environment에 위 3개를 더한다. 값에 `#`가 있으면 큰따옴표로 감싼다(hex·Turnstile 키에는 없다).
2. 저장한 뒤 **그 앱을 바로 Redeploy**한다. env만 저장해 두고 다음 릴리스를 돌리면 배포 확인이 시간 초과로 멈춘다(2026-10-31 사례). 직접 하기 어려우면 저장만 하고 대표에게 알린다. 대표가 두 앱을 다시 띄우고 확인한다.
3. 처음 켜지면 **기록만** 모드다. 막지 않고, 막혔을 요청 수만 센다. 1~2일 숫자를 본 뒤 **막기** 모드로 바꿀지 대표가 묻는다.

## 되돌리기

- 규칙은 오른쪽 스위치를 끄면 바로 원래대로다.
- 관문은 env 3개 중 하나를 지우고 재배포하면 꺼진다. 모드를 기록만으로 내려도 된다.
- Turnstile 위젯은 지우지 않아도 비용이 없다.

## 확인하지 못한 것

- 규칙 4 예외 IP의 현재 값, Bot Fight Mode 상태: 대표는 Cloudflare 화면을 볼 수 없다.
- Turnstile 메뉴 위치: Cloudflare 문서는 `Turnstile` 페이지 → `Add widget`이라고만 쓴다. 대시보드 왼쪽 메뉴 묶음 이름은 화면마다 다를 수 있다.
- 원 서버 Traefik 80/443이 `0.0.0.0`에 열려 있어, 같은 LAN·Tailscale에서는 `CF-Connecting-IP`를 꾸밀 수 있다(`docs/operations/2026-11-14-anti-scrape-api-rate-limit.md`). Cloudflare 화면 일이 아니라 별도 운영 작업이다.

## 출처

- Turnstile 위젯 만들기: https://developers.cloudflare.com/turnstile/get-started/widget-management/dashboard/
- Turnstile 시작하기(키 두 개·siteverify·시험 키): https://developers.cloudflare.com/turnstile/get-started/
- Turnstile 요금제: https://developers.cloudflare.com/turnstile/plans/
