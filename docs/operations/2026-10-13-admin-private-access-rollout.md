# 2026-10-13 관리자 실제 접속 복구

## 문제와 결과

PR410은 관리 경로를 private ingress 증명이 없으면404로 닫도록 배포했지만,
Tailscale Serve·private proxy·ID/비밀번호 운영 설정을 설치하지 않아 관리자 접속이 불가능했다.
앱의 인증 우회를 추가하지 않고 누락된 운영 설정을 설치했다.

Tailscale 연결 후 `https://m3ultra.tail02799e.ts.net/admin`에서 로그인한다.
ID는 `jr`, 생성한 비밀번호는 운영자 Mac의 `~/.config/nomorevibe/admin-login.txt`에만 보관한다.
디렉터리0700/파일0600이며 비밀번호·ingress secret·hash·세션 원문은 이 문서와 Git에 없다.
공개 `https://nomorevibe.com/admin`은404를 유지한다.

## 설치 범위

- 양 웹에 같은 ADMIN_ORIGIN/ADMIN_INGRESS_SECRET/ADMIN_USERNAME/ADMIN_PASSWORD_HASH를 설치하고
  기존 AUTH_SECRET·4개 공개 기능 플래그·나머지 환경값을 유지했다. 운영 ADMIN_LOCAL_LOGIN=0 유지.
- 현재 웹8e767a5 이미지 digest `cea3b1bdef0f9860605f4172b7fc9d2571f58a4d55016f662f154766079eb337`를
  그대로 재배포했다. mini2/M3 4 실제6복제본에 동일한 설정과 올바른 scrypt hash 형식을 확인했다.
- M3의 별도 Docker 컨테이너 `nomorevibe-admin-ingress`를 기존 overlay에 연결하고
  host `127.0.0.1:19391`에만 publish했다. 고정 Swarm 서비스DNS:3000으로 전달하므로
  일시적인 task IP를 하드코딩하지 않는다. restart policy는 unless-stopped다.
- nginx 공식 image digest `a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236`,
  arm64, 1worker/96MiB/0.25CPU 제한이다. 구성은 M3의
  `/Users/jr/Server/nomorevibe-admin/nginx.conf`에 jr 소유/0600, 상위0700으로 보관한다.
- Tailscale Serve443→loopback19391은 background/persistent 설정이다. Funnel을 설정하지 않았다.
  실제 Let’s Encrypt 인증서와 private host를 검증했다.
- Serve가 기존 요청의 identity header를 제거한 뒤 제공하는 운영자 identity를 proxy에서 정확히
  비교한다. 현재 노드와 운영자 Mac의 동일 Tailscale 계정만 전달하고, identity 없음/다른 값은403이다.
  proxy가 ingress token·Host·X-Forwarded-Host·Proto를 고정값으로 덮어쓰며 CONNECT는 거절한다.
  중앙 tailnet ACL은 기존의 넓은 정책을 그대로 두었다. **네트워크 ACL을 단일 사용자로 축소했다고
  주장하지 않는다.** 서비스의 추가 운영자 제한은 loopback proxy의 identity 필터에서 수행한다.
- 양 host의 별도 `nomorevibe-admin-boundary.yml` middleware가 공개 ingress의 증명과 identity
  header를 제거한다. 비밀이 없는 이 파일은0644다. 각 웹의3개domain.middlewares에
  `nmv-admin-proof-strip@file`을 Dokploy API로 저장하여 이후 배포에도 참조가 생성된다.
  domainId별 비교에서 다른 필드의 변화는 없었다. 실제 Traefik runtime router6개의 참조도 확인했다.
- 워커·scheduler·DB 스키마·수집 설정은 변경하지 않았다. 기존 backend b5924ac,
  core13앱18복제본 ready, 추가 ingress1컨테이너 running을 확인했다.
  migration journal76, 소개 검수2100-01-01/미임대, scheduler autoDeploy=false/2복제본을 유지했다.

[Tailscale 공식 Serve 문서](https://tailscale.com/docs/features/tailscale-serve)의
identity header 제거·loopback listener 계약을 따랐다.

## 실행한 검증

2026-10-13 KST 운영 실측이며 앱 코드 변경이나 새 단위·통합 테스트 실행은 없다.

| 검사 | 결과 |
|---|---|
| 실제 로컬 Tailscale peer의 private HTTPS | 정상 인증서, /admin→private /admin/login |
| headless Chromium 로그인 폼 | ID/비밀번호 표시, nonce bootstrap 후 폼 정상 |
| 실제 ID/비밀번호 제출 | /admin/inbox 로그인 성공, 오늘 할 일 표시 |
| 인증 뒤 읽기 | /admin/status 운영센터200, /admin/products 제품200 |
| Origin·CSRF 오류 | 각403, 로그인되지 않음 |
| 로그아웃 | POST303, nmv_admin 쿠키 제거, inbox 재방문은 로그인 폼 |
| 위 브라우저 흐름의 pageerror | 0 |
| 공개 origin에 유효한 실제 secret·세션을 보냄 | 양 host×3domain×3경로18건404, Cloudflare3건403으로 차단 |
| 공개 /admin 일반 요청 | 404 |
| 공개 health·홈·일반 로그인 | 모두200 |
| private proxy의 identity 없음/다른 값 | 각403 |
| loopback proxy port의 peer 접근 | mini에서 M3 Tailscale IP/LAN IP 모두19391접속 불가 |
| 양 웹 실행 환경 | 6복제본 모두5개 설정 exact match, hash 형식 정상 |
| core13앱 상태 | 모두 ready, 웹6복제본/기존backend보존 |
| DB 읽기 전용 검증 | journal76, 소개 검수 중단·scheduler 정책 유지 |

관리 쓰기·실제 다른 Tailscale 사용자·비밀번호 교체/만료·로그인 한도 초과·서버 재부팅은 이번
운영 단계에서 실행하지 않았다. 기존 코드 CI 결과와 이번 실제 접속 검증을 혼동하지 않는다.

## 설치 중 발견한 문제

- domain.update가 응답 순서를 바꿔 배열zip 비교가 실패했다. domainId별 대조로 바꾸었고
  middleware 외 필드 변경이 없음을 확인했다.
- Mac root 소유0700 경로를 OrbStack의 jr 프로세스가 읽을 수 없어 첫 nginx bind가126으로
  실패했다. private config는 jr 소유0700/0600으로 설치해 해결했다.
- 공개 middleware를 root0600으로 생성하여 Traefik 읽기가 실패하고 이전 설정을 유지했다.
  비밀 없는 파일을 jr 소유0644로 교정하고 재읽기를 유도했다. API·디스크만 확인하지 않고
  runtime router와 유효 secret/세션 요청의 실제 차단 결과를 확인했다. 전체 Traefik 재시작은 없었다.
- 기존 replace_setting은 없는 키를 추가하지 않아 새ADMIN_ORIGIN에서 무변경 상태로 중단했다.
  새 키 append 경로를 추가하고 양 웹 저장값·runtime값을 다시 비교했다.
- 첫 private curl은 HTTPS 인증서 발급 중 timeout이었고 발급 후 정상 TLS/307을 확인했다.
- 로그인 nonce bootstrap은 Next의 streaming redirect여서 단순 urllib GET의 HTML에 폼이 바로
  없었다. 실제 브라우저로 bootstrap·쿠키·폼을 확인했다. 첫 브라우저 검증은 존재하지 않는
  heading을 기다려 실패했고 실제 ‘오늘 할 일’ heading으로 교정한 전체 흐름이 성공했다.
- 최초 공개 검사의 urllib 자동 redirect/DNS와 모든 경계404 가정은 검증 도구 오류였다.
  redirect를 따라가지 않고 Cloudflare403/직접공개18건404의 실제 차단을 각각 기록했다.

## 운영 확인·롤백

접속 전 운영자 Mac의 Tailscale 연결을 켠다. 공개 도메인의/admin을 열려고 하지 않는다.
M3의 현재 Serve 설정과 ingress 상태는 아래처럼 읽기 전용으로 확인한다.

```sh
ssh root@100.92.77.66 '/opt/homebrew/bin/tailscale serve status --json'
ssh root@100.92.77.66 'docker ps --filter name=nomorevibe-admin-ingress'
curl -I https://nomorevibe.com/admin
```

후속 배포에서는 domain.middlewares뿐 아니라 실제 Traefik router의 참조·공개 차단을 확인한다.
문서용 origin을 공개 NEXT_PUBLIC_SITE_URL에 덮어쓰지 않는다. 기존 공개 app router를 끄거나
production ADMIN_LOCAL_LOGIN을 켜는 방법으로 복구하지 않는다.

설치 baseline·증거·도구는 운영자 로컬 `/private/tmp/nomorevibe-admin-access-20261013`의
0700/0600 파일이다. 앱 snapshot/settings/test-session에는 비밀이 있으므로 출력·공유하지 않는다.
setup.py의 capture/install/deploy는 설치 도구이며 **현재 운영에 반복 실행하지 않는다**.

롤백이 필요하면 private Serve443을 끄고, 양 웹의5개 설정을 baseline으로 복원한 뒤 같은 이미지로
양 웹을 다시 배포한다. 공개 header 제거 middleware는 유지해도 된다. 불필요한 worker 배포나
DB 롤백은 하지 않는다. 접근 복구는 실제 private 로그인과 공개 차단이 함께 확인되어야 완료다.
