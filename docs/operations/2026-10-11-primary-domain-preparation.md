# nomorevibe.com 기본 도메인 전환 준비

2026-10-11 기준 **서버 준비 완료, 공개 도메인 전환 대기**다. 현재 운영 기본 주소는
<https://nomorevibe.brut.bot>이며 `nomorevibe.com`은 여전히 GoDaddy 주차 DNS를 사용한다.
Cloudflare 로그인 또는 해당 계정의 새 zone 생성 권한이 필요하다. 아직 HTTPS·네임서버
전환·기본 주소 변경·리다이렉트를 완료했다고 해석하지 않는다.

## 확인한 현재 상태

- 도메인 등록기관은 GoDaddy다. NS는 `ns73.domaincontrol.com`, `ns74.domaincontrol.com`이다.
- apex A는 `15.197.148.33`, `3.33.130.190`이며 GoDaddy UI에서 Parked로 표시된다.
  `www`는 apex CNAME이다. `_domainconnect` CNAME과 `_dmarc` TXT도 있다.
- DNS 조회에서 MX·AAAA·DS·CAA는 없었다. GoDaddy UI의 DNS 레코드 7개를 확인했다.
  현재 메일 서비스를 옮기거나 새 호스팅을 구매할 필요는 확인되지 않았다.
- 기존 서비스는 Cloudflare와 두 서버의 Cloudflare Tunnel → Traefik → 웹으로 연결된다.
  두 웹의 코드 릴리스는 `650b341c8889f06b2ec3daa3b99da4e5712fee1a`다.
- 기존 Cloudflare cert와 Keychain의 `cloudflare-api-token`, `cloudflare-dns-api-token`은
  같은 계정의 brut.bot DNS를 읽을 수 있다. 세 인증 수단의 새 zone 작성은 모두403으로
  거절됐다. 오류는 `com.cloudflare.api.account.zone.create` 권한이 필요하다고 명시했다.
  기존 load balancer 조회도403이므로 대상·Host 헤더 설정을 확인하기 전 새 라우팅을
  단일 서버로 바꾸지 않는다.

## 적용한 서버 준비와 검증

Dokploy 두 웹에 기존 도메인을 유지하면서 다음 호스트를 추가했다. Cloudflare가 공개
TLS를 담당하므로 내부 도메인 설정은 `https: false`, port3000, path `/`다.

| 서버 | 앱 ID | 새 호스트 | 내부 health |
| --- | --- | --- | --- |
| M3 | `oipo2OAnIrtcnILBCRoG2` | `nomorevibe.com`, `www.nomorevibe.com` | 둘 다 status/db `ok`, instance `m3-web` |
| mini | `llv4rlABSJOcFauSxaHdx` | `nomorevibe.com`, `www.nomorevibe.com` | 둘 다 status/db `ok`, instance `mini-web` |

Tailscale의 각 서버80포트에 위 Host 헤더를 넣어 `/api/health`를 실제 요청했다.
기존 호스트도 양쪽 서버에서 정상이다. 모두 동일 릴리스650b341을 반환했다. 이 검사는
공개 DNS나 HTTPS 인증서가 준비됐다는 증거는 아니다.

두 서버 `/Users/jr/.cloudflared/config.yml`의 마지막404 규칙 앞에 위 두 호스트를
`http://localhost:80`으로 보내는 ingress를 추가했다. 각 서버에서 다음 명령이 exit0이었다.

```sh
/opt/homebrew/bin/cloudflared --config /Users/jr/.cloudflared/config.yml tunnel ingress validate
```

원본은 각각 `/Users/jr/.cloudflared/config.yml.nomorevibe-domain-20261011.backup`에
0600으로 보존했다. **실행 중인 cloudflared는 아직 재시작하지 않았다.** 따라서 현재
프로세스는 기존 설정을 사용하며 새 ingress 반영은 공개 연결을 준비한 뒤 서버별로
순차 수행한다. M3 tunnel은 `9e3903e4-0752-42ea-a275-7ccd2beb7105`, mini는
`815302dd-6f8d-4708-919d-bfce671b27ab`이다.

웹 설정 전체의 전환 전 snapshot은 운영자의
`/private/tmp/nomorevibe-domain-web-before-20261011.json`(0600)에 있다. 비밀이 들어
있으므로 출력·Git 추가·공유를 금지한다. 웹 image/source/replicas와 네 GitHub 기능flag,
DB·worker·중단 소개 검수·사용자 PPT 자료는 변경하지 않았다.

## 남은 공개 전환 순서

1. 기존 Cloudflare 계정에 로그인하여 `nomorevibe.com`을 Free full zone으로 추가한다.
   등록기관은 GoDaddy로 유지한다. 기존 `_dmarc` TXT와 필요한 `_domainconnect` 레코드를
   보존하고 GoDaddy 주차 A·기존 NS/SOA를 새 zone에 서비스 라우팅으로 복제하지 않는다.
2. 기존 NoMoreVibe load balancer의 두 tunnel 대상, Host 헤더와 health monitor를 직접
   확인한다. 같은 계정의 기존 LB에 apex CNAME을 연결하는 방식부터 검토한다.
   [Cloudflare 공식 문서](https://developers.cloudflare.com/learning-paths/load-balancing/planning/multiple-zones/)는
   여러 zone에서 기존 LB를 CNAME으로 공유하는 구성을 지원한다. `www`도 프록시하여
   apex로 리다이렉트한다. 새 유료 LB·구독을 임의 구매하지 않는다.
3. 두 tunnel ingress를 검증한 뒤 실제 활성 launchctl 서비스를 한 서버씩 재시작하고
   기존 서비스 health를 확인한다. Cloudflare가 **실제로 배정한** 네임서버로 GoDaddy
   NS를 변경한다. 아직 배정된 네임서버가 없으므로 값을 추측해 먼저 바꾸지 않는다.
4. 공개 DNS·TLS 인증서·apex와 www의 두 웹 연결을 확인한다. 새 주소가 정상인 뒤 두 웹의
   `NEXT_PUBLIC_SITE_URL=https://nomorevibe.com`을 맞추고 기존 immutable image·비밀키를
   보존해 양쪽을 배포한다. 런타임 metadata/robots/sitemap/RSS/skill/install 응답을 실제
   확인한다. 공개 env의 빌드 인라인 여부를 추측만으로 판단하지 않는다.
5. www 및 기존 HTML 주소를 경로·query를 보존하여308로 새 apex에 보낸다. 기존 설치
   스킬의 API 요청 호환성을 검토하고 health 경로는 계속 정상으로 둔다. 새 hostname의
   요청을 다시 동일 URL로 보내는 루프가 없어야 한다.
6. 배포 스크립트의 `public_gate`와 Cloudflare purge 대상은 아직 brut.bot에 고정되어
   있다. 전환 후 새 기본주소와 두 zone 캐시 정책을 반영한다. 기존 purge 인증 실패는
   별도로 해결하기 전 성공했다고 기록하지 않는다.
7. README/AGENTS/PENDING의 현재 운영 주소, GitHub 앱 등록 안내를 실제 공개 전환 후
   갱신한다. 운영 전환 전의 역사적 배포 기록은 유지한다. 문서·필요한 코드 변경을
   PR로 올려 최신 base의 필수 CI를 통과한 뒤 병합한다.

## GitHub 앱에 사용할 새 URL

아래 값은 새 공개 HTTPS 연결을 확인한 뒤 앱 등록 화면에 사용한다. 앱 인증값은 아직
운영에 없으며, 도메인 준비만으로 Star·피드백 기능을 켜지 않는다.

| 항목 | 값 |
| --- | --- |
| Homepage | `https://nomorevibe.com` |
| Star OAuth callback | `https://nomorevibe.com/api/auth/user/github/callback` |
| Star webhook | `https://nomorevibe.com/api/github/webhooks/star` |
| Feedback OAuth callback | `https://nomorevibe.com/api/auth/maker/github/callback` |
| Feedback setup | `https://nomorevibe.com/api/github/installations/setup` |
| Feedback webhook | `https://nomorevibe.com/api/github/webhooks/feedback` |

관리자 OAuth를 사용하는 경우 별도 관리자 앱의 callback도 실제 라우트
`/api/auth/github/callback`에 맞춘다. 수집 전용 GitHub App을 Star/Feedback App으로
재사용하거나 수집 권한을 변경하지 않는다.

## 다음 운영자 확인 명령

```sh
dig +short NS nomorevibe.com
dig +short A nomorevibe.com
dig +short DS nomorevibe.com
curl -fsS --max-time 10 https://nomorevibe.brut.bot/api/health
curl -fsS --max-time 10 -H 'Host: nomorevibe.com' http://100.92.77.66/api/health
curl -fsS --max-time 10 -H 'Host: nomorevibe.com' http://100.116.119.93/api/health
```

도메인 전환 완료 후에는 새 주소의 공개 health와 실제 브라우저 홈/상세 화면, metadata,
인증 리다이렉트, 기존 주소의 경로·query 보존을 추가로 검증한다.

문서 검증은 `node --test scripts/ci-scope.node-test.mjs` 4검사 pass, `git diff --check` exit0이었다.
