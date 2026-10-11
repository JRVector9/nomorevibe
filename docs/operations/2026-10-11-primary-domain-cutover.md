# nomorevibe.com 기본 도메인 전환 완료

2026-10-11 22:05 KST 기준 운영 기본 주소는 <https://nomorevibe.com>이다.
GoDaddy 등록은 유지하고 Cloudflare Free DNS·공개 TLS를 연결했다. 기존 M3·mini
로드밸런서를 공유하며 웹 2개·6복제본을 같은 기존 이미지로 재배포했다.
[전환 전 준비 기록](2026-10-11-primary-domain-preparation.md)은 이력으로 보존한다.

## DNS와 연결

- GoDaddy UI 저장 후 실제 NS가 `emely.ns.cloudflare.com`, `tony.ns.cloudflare.com`으로
  표시됐다. 1.1.1.1 조회에서도 같은 NS를 확인했다.
- 새 Cloudflare zone ID는 `9fc499cc4b48354cf9738ac039c9fd70`, 계정 ID는
  `975a92815b3140c4bc264f90721a4375`다. ID는 인증 비밀이 아니다.
- apex CNAME → `nomorevibe.brut.bot`, www CNAME → `nomorevibe.com`: proxied, Auto TTL.
  기존 `_domainconnect` CNAME과 `_dmarc` TXT 내용을 DNS only로 보존하고 실제 조회했다.
  주차 A와 GoDaddy NS/SOA를 서비스 라우팅으로 복사하지 않았다. DS는 없었다.
- 기존 `*.brut.bot` LB는 healthy, `brut-bot-pool` ID
  `54b63d9b4e0e1129444eea6e423d2b95`를 사용한다. M3 tunnel
  `9e3903e4-0752-42ea-a275-7ccd2beb7105` 60%, mini tunnel
  `815302dd-6f8d-4708-919d-bfce671b27ab` 40%, Host override 없음이다.
  LB·풀·대상 설정은 변경하지 않았다. 새 유료 LB나 호스팅을 구매하지 않았다.
  여러 zone의 CNAME으로 기존 LB를 공유하는 방식은
  [Cloudflare 공식 절차](https://developers.cloudflare.com/learning-paths/load-balancing/planning/multiple-zones/)를 따른다.
- 두 tunnel의 apex/www ingress는 localhost80으로 연결된다. `ingress validate` exit0 후
  `launchctl kickstart -k gui/501/com.cloudflare.cloudflared`를 mini→M3로 실행했다.
  새 PID는 mini89299, M3 9929이고 running이었다. 기존 공개 health10회에서 두 서버를
  모두 관측했다. 다른 서비스 ingress와 마지막404는 보존했다.
- Universal SSL은 `*.nomorevibe.com`, `nomorevibe.com` 대상 Active,
  만료일2027-01-09로 UI에서 확인했다. 실제 HTTPS 요청에서도 인증서 검증을 통과했다.
  Always Use HTTPS를 켰으며 HTTP는 같은 경로·query의 HTTPS로301 이동한다.

## 웹 기본 주소와 배포

두 웹 `NEXT_PUBLIC_SITE_URL=https://nomorevibe.com`만 변경했다. 환경의 다른 값,
Docker provider·immutable image·source·replicas·buildArgs·buildSecrets·command·autoDeploy를
전후 대조했다. 같은 운영 창에서 두 배포를 요청하고 새 deployment ID·done 이후
실제 실행 중 컨테이너의 origin·digest·release·health를 확인했다.

| 서버 | 앱 ID | 새 deployment ID | 실제 상태 |
| --- | --- | --- | --- |
| M3 | `oipo2OAnIrtcnILBCRoG2` | `MXlEPzk4andlIBCn2xRL5` | 4/4, 컨테이너4개 정상 |
| mini | `llv4rlABSJOcFauSxaHdx` | `XqiJUxLGdOrMYYNgt2EG8` | 2/2, 컨테이너2개 정상 |

두 웹 모두 코드 release `650b341c8889f06b2ec3daa3b99da4e5712fee1a`, web digest
`sha256:8b65fed0865672f2ab942874a897f9ff00850ad6d309238f58fa4921deeb2ab6`이다.
DB migration·worker 재배포·암호화 키 회전은 수행하지 않았다. 네 기능flag는 모두false다.
새 기본 origin은 런타임 응답에서 검증했으므로 별도 Next 빌드를 필요로 하지 않았다.

전환 전 비밀 snapshot은 `/private/tmp/nomorevibe-primary-origin-before-20261011.json`과
`/private/tmp/nomorevibe-domain-web-before-20261011.json`(각0600)이다. 출력·Git 추가 금지.
서버 tunnel backup은 각각 `/Users/jr/.cloudflared/config.yml.nomorevibe-domain-20261011.backup`이다.

## 주소 이동과 API 호환

Cloudflare Single Redirect 두 규칙을 실제 Active로 확인했다.

- 새 zone `NoMoreVibe www to primary`, ID `cc6f8ae131d441cc8bd3253282c870f6`:
  Host가 정확히 `www.nomorevibe.com`인 요청만 apex로308 이동한다.
- brut.bot zone `NoMoreVibe legacy pages to primary`, ID
  `860e32bcb8a54c8cb297f9450c712fea`: Host가 정확히 `nomorevibe.brut.bot`이고
  GET/HEAD인 서비스 페이지만 apex로308 이동한다. 대상은 `/`, `/popular`, `/policy`,
  `/login`, `/launch`, `/admin`, `/p/`, `/c/`, `/rankings/`, `/feedback/`, `/admin/`이며
  `/admin/export`, `/admin/search`는 제외한다.
- 두 규칙은 `concat("https://nomorevibe.com", http.request.uri.path)`와
  Preserve query string을 사용한다. 실제 `utm_source=cutover&x=a%2Fb`를 포함한
  상세 주소에서 경로·query·인코딩 보존을 확인했다.
- 기존 `/api/health`, `/install.sh`, `/skill.md`는200 유지다. 제품 GET
  `/api/products/nanomuse`도 새/옛 호스트200이며 JSON이 동일하고 verify 안내가 새주소다. API·자산·기존 POST를
  도메인 간 리다이렉트하지 않아 기존 CLI의 인증 헤더를 유지한다. 새 apex 요청은
  옛 호스트 전용 규칙에 매칭하지 않는다. 실제 apex 홈·상세가 정상200이다.

## 실제 검증 결과

- 새 주소의 `public_gate(650b341…)`: publicHealth ok, m3-web와mini-web 모두 관측.
- 홈 canonical `https://nomorevibe.com`, 홈·상세의 새 origin 포함/옛 origin0.
  실제 Chrome에서 홈 화면·이미지를 보고 nanoMuse 상세로 이동해 렌더링을 확인했다.
  native UI 검증이므로 console/network 오류0 검사를 실행한 것으로 기록하지 않는다.
- robots의 sitemap 주소, RSS·skill·install의 절대 주소가 새 origin이며 옛 origin0.
- sitemap은 첫 조회 실패 후 재조회200, 2.525초, 2,584,655바이트였다. XML parse 성공,
  15,860개 loc 모두 새 origin. 첫 실패를 코드 수정으로 해결했다고 해석하지 않는다.
- www·옛 상세308/정확한 Location, HTTP apex301, 새/옛 health 및 옛 install/skill200.
- Python 배포 안전 검사23개 pass, Node CI-scope4개 pass. PR의 필수 원격 CI 상태는
  해당 PR에서 확인한다. 이전 전체 앱 테스트를 이번에 다시 실행한 것으로 기록하지 않는다.

배포 스크립트의 public gate와 purge zone을 새 기본 주소로 갱신했다. 기존 purge 키 인증은
아직 미해결이며 성공했다고 기록하지 않는다. 새 zone은 HTML cache-everything 규칙을
복사하지 않았고 홈·상세의 `cf-cache-status: DYNAMIC`을 확인했다. 자산은 기본 Cloudflare
캐시 정책을 사용한다. 옛 zone의 기존 HTML 캐시는 edge redirect보다 우선하지 않는다.

## GitHub 앱 등록과 남은 설정

Homepage는 `https://nomorevibe.com`이다. 새 Star/Feedback 앱은 다음 정확한 값을 사용한다.

| 항목 | URL |
| --- | --- |
| Star OAuth callback | `https://nomorevibe.com/api/auth/user/github/callback` |
| Star webhook | `https://nomorevibe.com/api/github/webhooks/star` |
| Feedback OAuth callback | `https://nomorevibe.com/api/auth/maker/github/callback` |
| Feedback setup | `https://nomorevibe.com/api/github/installations/setup` |
| Feedback webhook | `https://nomorevibe.com/api/github/webhooks/feedback` |
| 별도 관리자 OAuth callback | `https://nomorevibe.com/api/auth/github/callback` |

실제 새 앱 키·Resend·공개 인증키는 아직 없다. 앱 생성·실제 OAuth·스타·이슈·메일 파일럿은
이번 전환으로 완료되지 않았다. 기능 활성화 전 웹·publisher·maintenance 주/예비의 키와
origin을 맞추고 [연동 runbook](github-stars-feedback-runbook.md)을 따른다.
도메인 전환에서는 비활성 워커 origin을 변경/재배포하지 않았다. 쿠키는 호스트별이므로
관리자와 일반 사용자는 새 도메인에서 다시 로그인한다. 수집 전용 앱 권한은 그대로다.

## 재확인과 복구

```sh
dig @1.1.1.1 +short NS nomorevibe.com
curl -fsS --max-time 10 https://nomorevibe.com/api/health
curl -sS -I 'https://www.nomorevibe.com/p/nanomuse?x=a%2Fb'
curl -sS -I 'https://nomorevibe.brut.bot/p/nanomuse?utm_source=cutover&x=a%2Fb'
curl -fsS --max-time 10 https://nomorevibe.brut.bot/api/health
python3 -m unittest tests/test_deploy_shared_images.py
node --test scripts/ci-scope.node-test.mjs
git diff --check
```

새 도메인 장애 때는 먼저 옛 HTML redirect를 비활성화해 기존 호스트를 복구하고
양쪽 env snapshot의 이전 origin만 복원하여 같은 digest로 재배포한 뒤 두 health를 검증한다.
현재 Cloudflare DNS·LB·Tunnel은 기존 호스트와 공존하므로 GoDaddy 주차 DNS로 돌아갈
필요는 없다. 새 apex를 옛 주소로 보내는 임시 redirect를 쓴다면 먼저 옛→새 규칙을
끄고 루프를 검사한다. 사용자 미추적 PPT·stash와 소개 검수 중단 상태는 보존했다.
