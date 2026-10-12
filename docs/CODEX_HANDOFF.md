# 2026-10-11 — nomorevibe.com 전환 완료, PR360 병합·주차 경로 복구

## Current objective / completed work

GoDaddy의 nomorevibe.com을 서비스 기본 도메인으로 전환하라는 요청을 완료했다. 현재 운영 기본 주소는 https://nomorevibe.com이다. 사용자가 로그인한 Cloudflare/GoDaddy에서 DNS·NS·공개 TLS·redirect를 적용했고 M3·mini 웹의 origin 변경과 실제 배포를 검증했다. 브라우저 화면 작업을 끝내고 새 홈을 띄워두었다. 사용자에게 Chrome을 다시 사용해도 된다고 알렸다.

PR https://github.com/JRVector9/nomorevibe/pull/360 은 MERGED, merge SHA9944254975e9d7ba2e1eb0eb7e986186567708eb이다. 변경685249b, 최신 main 합류 merge 및 API 증거 커밋baa2ecd를 push했다. 병행 인기 화면 PR359의 base def8953f7c9d71613ec850f45dbeec0d6e55f931와 병합 직전 원격 main이 같고 필수 check 성공임을 확인했다. 보호 규칙/관리자 우회 없이 --match-head-commit baa2ecd5a7d22cd825a152884e0f2f64820a98ea로 병합했다. 최종 인계 문서만 새 docs branch에서 기록한다.

## Modified files / key decisions

전환 PR은 README.md, AGENTS.md, PENDING.md, docs/CODEX_HANDOFF.md, 도메인 준비/완료 운영 기록, GitHub capability/runbook, production-multi-instance.env.example, scripts/ops/deploy_shared_images.py를 변경했다. 서비스 앱 코드 변경은 없다. 배포 script의 공개 gate는 새 health, purge 대상은 새 zone9fc499cc4b48354cf9738ac039c9fd70이다. 스크립트는 Docker context에서 제외되므로 이 두 상수 변경을 위해 웹 이미지를 다시 빌드/배포하지 않는다. 최종 기록 branch는 docs/primary-domain-final-handoff-20261011, worktree /private/tmp/nomorevibe-domain-20261011이다.

GoDaddy NS는 실제 배정된 emely.ns.cloudflare.com/tony.ns.cloudflare.com이다. Cloudflare Free zone의 apex→nomorevibe.brut.bot 및 www→apex CNAME을 proxied로 설정했다. DMARC/domainconnect 내용 보존, DS 없음. 기존 wildcard LB 두 tunnel/60:40/Host override 없음 유지. 두 cloudflared ingress validate0 및 실제 재시작 완료. UniversalSSL Active/2027-01-09, AlwaysUseHTTPS on. 새www와 옛 GET/HEAD 웹페이지308는 경로·query 보존, 옛 API와 CLI는 그대로 응답한다.

M3 web oipo2OAnIrtcnILBCRoG2 deploymentMXlEPzk4andlIBCn2xRL5 및 mini web llv4rlABSJOcFauSxaHdx deploymentXqiJUxLGdOrMYYNgt2EG8 done. NEXT_PUBLIC_SITE_URL만 새주소로 바꿨고 이미지·source·replicas·build 설정·비밀키·네 feature flag OFF를 보존했다. 실제 M3 4/4·mini2/2 모든 컨테이너 origin/digest/release/health 정상. 이 env 배포의 코드 release는650b341c8889f06b2ec3daa3b99da4e5712fee1a, web digest8b65fed0865672f2ab942874a897f9ff00850ad6d309238f58fa4921deeb2ab6이다. 다른 병행 작업의 새 코드 릴리스를 이 도메인 작업에서 배포했다고 주장하지 않는다. DB migration·worker 배포·키 회전·소개 검수 재개는 하지 않았다. root main/PPT/stash/미추적 사용자 자료를 보존한다.

전환 전 비밀 snapshot /private/tmp/nomorevibe-primary-origin-before-20261011.json와 /private/tmp/nomorevibe-domain-web-before-20261011.json는각0600이며 출력/커밋 금지. 각 서버 tunnel 원본 backup은 /Users/jr/.cloudflared/config.yml.nomorevibe-domain-20261011.backup이다. 도메인 operator의 apply 재실행은 금지한다(이미 새 origin 및 snapshot O_EXCL). 상세 DNS/redirect/API/복구/App URL은 docs/operations/2026-10-11-primary-domain-cutover.md를 따른다.


최종 재확인 중 병행 PR359 배포가 두 웹에 반영됐다. 실제 현재 웹 release는 def8953f7c9d71613ec850f45dbeec0d6e55f931, digest26f73703a15024394465f8a77bdff1eb0a707351b10596c1045eee99006afa2b이다. mini deployment4VK_pxZ-eDJZEeRUTIyYX, M3 HxouTaTLdDzi_O1T5LQFB done. 각각2/2·4/4 실제 컨테이너 image/deploymentID/release/health가 정상이며 새 origin 및 flagOFF가 유지됐다. 이 코드를 domain agent가 배포했다고 해석하지 않는다.

Mac 일반curl에404가 발생했으나 remote_ip3.33.130.190/HTTP1.1로 옛 주차 서버였다. 기본 DNS100.100.100.100(Tailscale)은 옛A 두 개/TTL460을 반환했다. 같은 시각 .com TLD위임은 새NS, Cloudflare1.1.1.1와Google8.8.8.8은 새CF A를 반환했다. 두 서버 직접 Host health와 cloudflared ingress/PID는 정상이었다. 새CF IP로--resolve한 HTTPS는 인증서 검증을 유지하면서200/dbok였다. 코드/웹/터널/시스템 DNS를 바꾸지 않고 TTL 전파를 관측했다. 로컬 DNS 수렴 helper /private/tmp/nomorevibe-dns-convergence-20261011.py는 실제 exit0: localDnsConverged true, A104.21.85.139/172.67.206.111, 일반 HTTPS health mini-web/def8953/dbok였다. 이후 일반 curl 홈200도 확인했다.

사용자 /lander 증상은 옛IP의114바이트 HTML에서 window.location.href="/lander"를 직접 확인해 원인을 입증했다. 이미 주차 경로에 도착한 사용자를 복구하기 위해 새 zone에 NoMoreVibe parking path to home 규칙 dbd6662d2a764d78bb454b43c80036ad를 추가해 Active를 확인했다. 정확한 apex Host + /lander + GET/HEAD만 새 홈으로308 이동하며 query보존, www다음 순서다. 실제 /lander?x=a%2Fb → /?x=a%2Fb 한 번 이동 후200. 사용자가 열어둔 GoDaddy 주차 탭을 강력 새로고침한 뒤 nomorevibe.com/ 서비스 홈·이미지·프로젝트 목록 렌더링을 AX/screenshot으로 확인했다. 현재 그 탭에 정상 홈을 띄워두었다. 전체 지역 resolver의 수렴을 검증한 것으로 주장하지 않는다.

## Actual tests / failed approaches

PR CI38142169371의 scope·quality·integration3분할·필수check 모두 success. 최초 옛 base CI38142075061은 최신 base 검증을 대신하지 않는다. 실제 로컬 Python23pass, Node CI-scope4pass, diffcheck0. 최신 base 합류 뒤 두 검사도 다시 pass했다.

병합 후 main CI38142499118도 quality·통합3분할·필수check·두 이미지 게시 모두 success였다. 도메인 최종 기록 PR361은 docs-only다. 최신 head의 원격 상태를 확인하고 필수 check 성공 뒤 병합한다.

DNS 수렴 뒤 현재 release def8953 대상의 수정한 public_gate를 실제 실행해 publicHealth ok/m3-web·mini-web 모두 관측했다. 일반 DNS apex200, lander/www/old 상세308 정확한 Location, HTTP301, 옛health/install/skill200도 최종 재확인했다.

수정한 public_gate(650b341…) 실제 실행은 publicHealth ok, m3-web/mini-web 모두 관측했다. 새 홈 canonical과 홈/상세/robots/RSS/skill/install 절대 주소에서 옛 origin0. sitemap 재조회200/2.525초/2584655bytes, XML parse 및15860loc 새 origin. Native Chrome 홈·상세 screenshot과 이동 렌더링 확인. console/network 오류0 검사를 이번에 실행했다고 주장하지 않는다. 실제 old/www308의 경로·query·인코딩 보존, HTTP apex301, old health/install/skill200. 제품 GET /api/products/nanomuse는 새/옛200 및 JSON 동일, verify 안내가 새주소다. 관리자 OAuth 시작503은 키 미설정이며 실제 OAuth 성공이 아니다.

기존 CF cert/API 토큰 create403은 로그인 UI로 해결했다. 기존 DNS 토큰2개 새 zone 읽기403, UI에서 설정했다. 인증서 발급 전 curl TLS35는 Active 이후 정상 HTTPS가 됐다. 첫 sitemap 조회 실패 뒤 재조회 정상, 코드 수정 없음. mini 재시작 후 helper의 json import 누락으로 outer exit1은 고친 뒤 M3만 이어 수행exit0이었다. Chrome 사용자 조작으로 선택이 바뀔 때 fresh getApp/AX를 다시 읽었고 사용자의 일시 중단 허용 후 완료했다.

## Remaining work / exact commands

도메인 운영 전환은 완료다. 기존 Cloudflare purge 키 인증은 미해결이므로 PENDING에 남겼다. 새 zone은 HTML cache-everything을 복사하지 않았고 실제 홈·상세 DYNAMIC을 확인했다. purge 성공으로 기록하지 않는다. Star/Feedback App·Resend·공개 인증키와 실제 파일럿은 별도 PENDING이며 네 기능은 OFF다. 활성화 전 웹/publisher/maintenance6앱의 origin·키를 맞춘다. 이번엔 비활성 워커의 origin을 변경/재배포하지 않았다. 호스트별 쿠키 때문에 새 도메인에서 다시 로그인한다.

```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short --branch
gh pr view 360 --json state,mergeCommit,url
gh pr view 361 --json state,headRefOid,baseRefOid,mergeCommit,url,statusCheckRollup
gh run view 38142169371
curl -fsS --max-time 10 https://nomorevibe.com/api/health
curl -sS -I 'https://nomorevibe.com/lander?x=a%2Fb'
curl -sS -I 'https://nomorevibe.brut.bot/p/nanomuse?utm_source=cutover&x=a%2Fb'
cd /private/tmp/nomorevibe-domain-20261011
gh pr list --head docs/primary-domain-final-handoff-20261011 --state all --json number,state,url,mergeCommit
python3 -m unittest tests/test_deploy_shared_images.py
node --test scripts/ci-scope.node-test.mjs
git diff --check
```

최종 docs-only PR의 상태는 위 명령으로 직접 조회한다. 해당 기록 변경으로 운영 앱을 다시 배포할 필요는 없다. CUA를 계속 사용할 때 compaction 후 rewriteDocumentation을 실행하고 현재 fresh AX를 확인한다. Dokploy inspect helper의 inventory() 재실행 금지. 이전 준비/진행 기록은 아래 이력이며 최상단 현재 상태와 Git/실제 검사가 우선한다.

---

# 2026-10-11 22:10 KST — nomorevibe.com 공개 전환·양쪽 웹 배포 검증 완료

## Current objective / completed work

사용자가 GoDaddy 로그인 상태에서 nomorevibe.com을 기본 도메인으로 전환하라고 요청했다. Cloudflare 로그인 후 사용자 브라우저 사용 중단 확인을 받고 전환을 완료했다. 현재 기본 주소는 https://nomorevibe.com이다. 전용 worktree /private/tmp/nomorevibe-domain-20261011, branch feat/primary-domain-cutover-20261011, base f2e36d8770f7bfc14ea81b893a4e178591d3b4d7 (준비PR358 병합). 공개 전환 및 운영 env 배포는 실제 완료했다. 변경 커밋685249b를 push하고 PR360을 열었다. 병행 작업인 인기 화면 PR359가 main def8953f7c9d71613ec850f45dbeec0d6e55f931에 병합돼 충돌 없이 branch에 merge했다. 최신 base 필수 CI/병합을 마무리한다. 상세 증거·복구·새 App URL은 docs/operations/2026-10-11-primary-domain-cutover.md다.

## Modified files / key decisions

README.md, AGENTS.md, PENDING.md, docs/CODEX_HANDOFF.md, 기존 도메인 준비 기록, 신규 도메인 완료 기록, github-integration-capability-check.md, github-stars-feedback-runbook.md, production-multi-instance.env.example, scripts/ops/deploy_shared_images.py를 변경했다. 서비스 앱 코드는 변경하지 않았다. 배포 script는 public health 주소와 purge zone ID만 바꿨다. 스크립트 변경은 현재 웹 이미지를 다시 빌드할 이유가 아니다.

GoDaddy NS emely.ns.cloudflare.com/tony.ns.cloudflare.com 저장 및 UI/공개DNS 확인. Cloudflare Free zone9fc499cc4b48354cf9738ac039c9fd70, apex→nomorevibe.brut.bot/www→apex proxied, 기존DMARC/domainconnect 보존. 기존 wildcard LB 두 tunnel/60:40/Hostoverride없음 유지. 두 cloudflared 실제 재시작 및 ingress validate0. UniversalSSL Active/2027-01-09, AlwaysUseHTTPS on. 새www 및 옛GET/HEAD웹페이지308는경로query보존. 옛API health/install/skill200 유지. 제품 GET /api/products/nanomuse도 새/옛 호스트200이며 JSON이 동일하고 verify 안내는 새주소다. 관리자 OAuth 시작은 키미설정503으로 실제OAuth 검증은 하지 않았다.

M3web oipo2OAnIrtcnILBCRoG2 deploymentMXlEPzk4andlIBCn2xRL5, miniweb llv4rlABSJOcFauSxaHdx deploymentXqiJUxLGdOrMYYNgt2EG8 done. 각NEXT_PUBLIC_SITE_URL만새주소로변경하고 같은운영창배포. 실제6컨테이너 origin/image/release/health 정상, M3 4/4·mini2/2. Code release650b341c8889f06b2ec3daa3b99da4e5712fee1a, web digest8b65fed0865672f2ab942874a897f9ff00850ad6d309238f58fa4921deeb2ab6 유지. flags4개OFF. worker/DBmigration/키회전/소개검수재개없음. root main/PPT/stash/미추적사용자자료 보존.

비밀snapshot /private/tmp/nomorevibe-primary-origin-before-20261011.json, /private/tmp/nomorevibe-domain-web-before-20261011.json는각0600이며출력/커밋금지. 양쪽tunnel원본backup경로는 config.yml.nomorevibe-domain-20261011.backup. 도메인operator /private/tmp/nomorevibe-primary-origin-20261011.py verify로 실제재확인가능. apply재실행금지(기존snapshot O_EXCL·이미새origin).

## Actual tests / failed approaches

Python23pass, NodeCI-scope4pass, diffcheck0. 수정한 public_gate(650b341…) 실제실행ok, 공개m3-web/mini-web모두관측. 새홈canonical/홈상세oldorigin0, robots/RSS/skill/install주소neworigin, sitemapHTTP200/XMLparse/15860loc모두새주소. NativeChrome홈스크린샷과상세이동렌더링확인. console/network오류0검사를이번에했다고주장하지않는다. 실제old/www308Location경로쿼리인코딩유지, HTTPapex301, oldAPI/CLI200.

CF기존cert/API토큰create403은로그인UI로해결. DNS API토큰2개새zone읽기403이므로UI설정. 처음CF인증서대기중curlTLS35→발급후정상HTTPS. 첫sitemap검사실패후다음실제200/2.525초/2584655bytes, 코드수정없음. mini재시작후helperjson import누락outerexit1은고친뒤M3만이어실행exit0. 실제재시작이안됐다고해석하지않는다.

## Remaining work / exact commands

PR https://github.com/JRVector9/nomorevibe/pull/360 의 latest base 필수 check 성공 후 병합한다. 기존 base의 CI38142075061은 새 base 성공을 대신하지 않는다. 원격PR/CI/병합의현재상태는아래명령으로직접조회한다. 기존Cloudflarepurge키인증은미해결. 새zoneHTMLcache-everything미적용으로DYNAMIC응답, purge성공으로표시하지않는다. 새GitHubApp/Resend/공개키와실제파일럿은별도PENDING. 기능활성화전웹/publisher/maintenance6앱origin/키일치필수;이번엔OFF워커origin변경/재배포없음. 새호스트에서다시로그인한다.

```sh
cd /private/tmp/nomorevibe-domain-20261011
git status --short --branch
gh pr list --head feat/primary-domain-cutover-20261011 --state all --json number,state,url,mergeCommit
gh pr checks feat/primary-domain-cutover-20261011
python3 -m unittest tests/test_deploy_shared_images.py
node --test scripts/ci-scope.node-test.mjs
git diff --check
python3 /private/tmp/nomorevibe-primary-origin-20261011.py verify
dig @1.1.1.1 +short NS nomorevibe.com
curl -fsS --max-time 10 https://nomorevibe.com/api/health
```

CUA를 계속 사용할 때 compaction 이후 rewriteDocumentation을 실행하고 현재 화면의 fresh AX를 확인한다. Dokployinspecthelper의inventory()재실행금지. 과거준비/진행기록은아래이력이며최상단현재상태와git/실제검사우선.

---

# 2026-10-11 — nomorevibe.com 전환 진행 중: Cloudflare DNS 준비·Tunnel 반영 완료

## Current objective

사용자가 GoDaddy 로그인 상태에서 nomorevibe.com을 기본 도메인으로 전환하도록 요청했다. 로그인과 Chrome 임시 사용 중단을 확인했으며 작업을 계속한다. 전용 worktree /private/tmp/nomorevibe-domain-20261011, branch feat/primary-domain-cutover-20261011, base f2e36d8770f7bfc14ea81b893a4e178591d3b4d7 (준비 PR358 병합)이다. 공개 전환은 아직 완료되지 않았다.

## Completed work / modified files / key decisions

이전 준비 기록대로 양쪽 Dokploy 웹 apex/www domain 및 tunnel ingress를 추가했다. 이번 단계에서 Cloudflare native Chrome UI로 Free zone을 만들고 apex CNAME→nomorevibe.brut.bot, www CNAME→apex를 proxied로, 기존 _domainconnect CNAME과 _dmarc TXT를 DNS only로 넣었다. 아직 GoDaddy NS는 ns73/ns74.domaincontrol.com이다. Cloudflare Continue to activation을 클릭한 뒤 nameserver-directions 화면까지 진행했다. 실제 배정 NS를 다음에 읽어 적용한다.

기존 brut.bot wildcard LB는 brut-bot-pool(54b63d9b4e0e1129444eea6e423d2b95), M3 tunnel9e3903e4-0752-42ea-a275-7ccd2beb7105/mini815302dd-6f8d-4708-919d-bfce671b27ab, 60/40 및 Host override 없음이 UI에서 확인됐다. 새 CNAME은 기존 양쪽 LB를 재사용한다. 기존 LB를 변경하지 않았다.

두 cloudflared gui/501/com.cloudflare.cloudflared를 실제 재시작했다. mini PID17360→89299, M3 PID1474→9929, 각각 running 및 ingress validate 성공. 양쪽 재시작 후 기존 공개 health 10회 모두 ok/dbok/release650b341c8889f06b2ec3daa3b99da4e5712fee1a, m3-web와mini-web 둘 다 관측했다. 기존 config backup과 전환 전 웹 snapshot0600을 보존한다. 두 웹 NEXT_PUBLIC_SITE_URL은 아직 옛 주소, immutable image/replicas/source/기능flagOFF는 그대로다.

현재 수정 파일은 이 인계 문서뿐이다. root main/PPT/미추적 사용자 자료와 소개 검수 중단 상태는 보존한다. Next redirects/environment/proxy 설치 문서와 prod 절차는 이전 단계에서 읽었다.

## Tests / failed approaches

실제 실행: 두 서버 ingress validate, launchctl 재시작/상태, 기존 공개 health10회 모두 성공. 이전 내부6health와 Node CI-scope4검사 성공 기록은 이전 단계 결과다. 새 공개 DNS/TLS/OAuth/redirect는 아직 미검증이다.

기존 Cloudflare 인증은 brut.bot 읽기만 가능하며 새 zone 생성과 LB 조회403이었다. 로그인 UI로 해결했다. UI Type 콤보에 setValue+Return 방식은 DNS 기록을 추가하지 못해 실제 목록에서 CNAME/TXT를 클릭하는 방식으로 완료했다. mini 재시작 후 operator helper의 json import 누락으로 outer helper exit1; import를 고치고 M3만 이어 실행했으며 최종 helper exit0이다. Chrome 창 변경으로 UI 액션이 중단됐으나 사용자가 잠시 브라우저 사용을 멈춰 진행 허용했다. 기존 purge key 인증 실패는 아직 해결되지 않았다.

## Remaining work / exact commands

Cloudflare 배정 NS 읽기→GoDaddy NS 변경→공개 DNS/TLS/양쪽 health, 웹 두 개 origin env 변경 및 순차 배포, metadata/robots/sitemap/RSS/skill/install 검증, www/옛 HTML redirect와 API 호환, 운영 script/docs 반영 후 protected PR CI/병합이 남았다. 새 기능 flag는 계속 OFF이며 실제 GitHub App/메일 키와 실제 파일럿은 별도 미완료다.

```sh
cd /private/tmp/nomorevibe-domain-20261011
git status --short --branch
dig +short NS nomorevibe.com
curl -fsS --max-time 10 https://nomorevibe.brut.bot/api/health
curl -fsS --max-time 10 https://nomorevibe.com/api/health
```

Dokploy helper /private/tmp/nomorevibe-release-inspect-20261011.py의 client()는 Keychain 내부 읽기. inventory() 재실행 금지. M3 web oipo2OAnIrtcnILBCRoG2, mini llv4rlABSJOcFauSxaHdx. SSH root@100.92.77.66/root@100.116.119.93. CUA compaction 이후 rewriteDocumentation 후 actual UI를 확인한다. 마지막 Chrome URL은 Cloudflare nomorevibe.com/nameserver-directions다.

---

# 2026-10-11 — nomorevibe.com 전환: 서버 준비 완료, Cloudflare 로그인 대기

## Current objective

사용자가 GoDaddy 로그인 상태에서 nomorevibe.com을 기본 도메인으로 전환하도록 요청했다. 전용 worktree /private/tmp/nomorevibe-domain-20261011, branch feat/primary-domain-nomorevibe-com-20261011, base bb318b4820c3309ae48356191926e848923b4d27이다. 공개 전환은 아직 완료되지 않았다. 상세 운영 기록은 docs/operations/2026-10-11-primary-domain-preparation.md다.

## Completed work / modified files / key decisions

GoDaddy DNS 7개를 UI에서 확인하고 A/AAAA/NS/CNAME/MX/DS/CAA를 조회했다. Parked apex A15.197.148.33 및3.33.130.190, NS ns73/ns74.domaincontrol.com, www CNAME apex, _domainconnect와_dmarc를 확인했다. DNS/GoDaddy 네임서버는 아직 변경하지 않았다.

Dokploy M3/mini 웹에 nomorevibe.com과www.nomorevibe.com을 port3000/path/httpsfalse로 추가했다. 기존 brut.bot 도메인을 보존했고 두 서버80포트에 Host 헤더를 넣어 세 호스트의 health 총6개를 실제 확인했다. 모두 status/dbok, 각 instanceId와 동일 코드 release650b341을 반환했다. env/site origin과 이미지·source·replicas·DB·네기능flagOFF·소개검수 중단 상태는 변경하지 않았다.

두 서버 /Users/jr/.cloudflared/config.yml에 새 두 호스트→localhost80을 마지막404 앞에 추가했다. 각각 ingress validate exit0. 원본 backup은 같은 디렉터리 config.yml.nomorevibe-domain-20261011.backup,0600이다. 실행 프로세스는 재시작하지 않았으므로 새 ingress는 아직 런타임 미반영이다. M3 tunnel9e3903e4-0752-42ea-a275-7ccd2beb7105, mini815302dd-6f8d-4708-919d-bfce671b27ab. 두 웹의 전환 전 전체 snapshot /private/tmp/nomorevibe-domain-web-before-20261011.json은0600이며 비밀 출력/커밋금지다.

수정 파일은 이 인계 문서 및 새 도메인 준비 운영 기록이다. root main/PPT/미추적 자료는 보존했다. Next 설치 문서 redirects/environment/proxy를 읽었으며 서비스 코드 수정은 아직 없다.

## Test commands / results / failed approaches

실제 실행: DNS 조회, Dokploy 두 웹 domain/env 상태, SSH tunnel 설정/프로세스 읽기, 내부6health status/dbok/release650, 두 ingress validate exit0, git diff --check exit0. node --test scripts/ci-scope.node-test.mjs 실제4검사 pass/exit0. 새 공개도메인/TLS/기본주소/OAuth/redirect 검사는 아직 실행하지 않았다.

Chrome browser provider가 없어 native Chrome cua_repl로 조작한다. Cloudflare 로그인 화면을 열고 사용자에게 로그인 완료를 비동기로 요청했다. 계정975a92815b3140c4bc264f90721a4375의 새 zone 생성은 기존 cloudflared cert와 Keychain cloudflare-api-token/cloudflare-dns-api-token 모두403. 명시 오류 com.cloudflare.api.account.zone.create 권한 필요. 같은 계정 brut.bot DNS 읽기는 성공, nomorevibe.com zone 결과 빈목록, LB 조회403이다. 새 zone은 생성되지 않았다. 기존 Cloudflare purge key도 앞선 배포에서 인증 실패했다.

## Remaining work / exact commands

Cloudflare 로그인 후 Free full zone 추가·배정 NS 확인, 기존 LB의 대상/Host헤더와 두 웹 연결을 유지하는 CNAME 검토, 기존 DMARC 등 보존, ingress 서버별 재시작, GoDaddy NS 변경, 공개DNS/TLS 확인이 남았다. 그 후 두 웹 NEXT_PUBLIC_SITE_URL=https://nomorevibe.com 변경·양쪽 배포·runtime metadata/robots/sitemap/RSS/skill/install 검증·www/옛HTML308·API호환검토·deploy script health/purge 설정·현재주소 문서를 반영한다. 아직 README/AGENTS 현재운영주소를 새주소로 바꾸지 않는다. GitHub 앱 새 callback 전체값은 운영 기록에 있으며 새HTTPS 준비후사용한다. 새기능flag는 도메인전환과별도로 계속OFF다.

```sh
cd /private/tmp/nomorevibe-domain-20261011
git status --short --branch
node --test scripts/ci-scope.node-test.mjs
git diff --check
dig +short NS nomorevibe.com
curl -fsS --max-time 10 https://nomorevibe.brut.bot/api/health
curl -fsS --max-time 10 -H 'Host: nomorevibe.com' http://100.92.77.66/api/health
curl -fsS --max-time 10 -H 'Host: nomorevibe.com' http://100.116.119.93/api/health
```

Dokploy helper /private/tmp/nomorevibe-release-inspect-20261011.py의 client()가 Keychain을 내부에서 읽는다. inventory()는 기존 snapshot O_EXCL 때문에 다시 실행하지 않는다. M3 web oipo2OAnIrtcnILBCRoG2, mini web llv4rlABSJOcFauSxaHdx. SSH root@100.92.77.66 / root@100.116.119.93. CUA 계속사용시 cua.rewriteDocumentation() 후 현재 화면을 다시 확인한다. 문서 준비 커밋/PR 상태는 git/gh에서 직접확인한다.

---

# 2026-10-11 17:24 KST — PR #356 push·병합·운영 코드 배포 검증 완료

## Current objective / completed work

사용자가 PR01~09 구현 이후 commit/push/deploy를 요청했다. 9개 논리 구현 커밋을 원격에 push했고 PR https://github.com/JRVector9/nomorevibe/pull/356 을 최신 base 필수 CI 성공 후 merge로 병합했다. 코드 release `650b341c8889f06b2ec3daa3b99da4e5712fee1a`를 운영 DB와 14개 앱·19개 복제본에 배포하고 실제 컨테이너 코드/이미지·health·역할 lease·공개 화면을 확인했다. 로컬 구현 검증에 더해 실제 배포도 완료했다. 실제 GitHub/메일 기능 활성화는 아직 하지 않았다.

논리 커밋01~09: `a03f638`, `c4606ac`, `b25731f`, `2992598`, `9df60e0`, `0ea6656`, `cba7eed`, `007d65f`, `4f87832`. 원격 PR 번호는356이며 01~09는 계획 번호다. branch `feat/github-stars-feedback-20261011`, 구현 worktree `/private/tmp/nomorevibe-github-integration-20261011`; 배포·기록 worktree `/private/tmp/nomorevibe-release-20261011`. 전 agent와 직접 Codex CLI는 지정된 gpt-6.1-sol/xhigh를 사용했다.

## Modified files / key design decisions

구현01~09의 변경 목록/설계/로컬 결과는 아래 이전 완료 기록과 `docs/operations/2026-10-11-github-integration-implementation.md`다. 이번 후속 문서 커밋은 README, PENDING, 구현/파일럿/계획/인계 문서 및 신규 `docs/operations/2026-10-11-github-integration-rollout.md`를 갱신한다. 서비스 source 코드·package lock·PPT·.env.local은 이번 기록 단계의 변경 대상이 아니다.

- 8개 Docker 앱은 두 immutable digest로 배포했다. worker `sha256:b2f81cd8179770c364452e9d2cbb1fb19c1a1ac9607c79496b3282dbde1070ab`, private web `sha256:8b65fed0865672f2ab942874a897f9ff00850ad6d309238f58fa4921deeb2ab6`. 두 서버 ARM64/OCI release/web 빌드 키 일치를 확인했고 웹 암호화 키를 회전하지 않았다.
- maintenance/text 주예비·scheduler·connect-agent의 6개 Git source 앱은 source/autoDeploy/command 정책을 보존해 동일 main 코드로 교체했다. 실제 컨테이너의 worker source500파일을 git SHA256과 대조했다. 기존13 core앱 외 connect-agent1개도 실제 inventory에서 확인해 총14앱을 검증했다.
- scheduler·5역할 주예비 총11서비스 정상 drain 후, 직접5432에서 새 worker 이미지의 scripts/migrate.mjs를 한 번 실행(exit0), 소비자를 복구하고 역할별 순차 배포했다. runtime PgBouncer6432는 유지했다. DB초기화/복구덮어쓰기/수동lease조작을 하지 않았다.
- 네 기능flag false 유지. Star/FeedbackApp·공개세션/암호화·메일설정은 아직 운영에 없다. 실제스타/봇이슈/메일수신/웹훅 파일럿을 mock이나 코드배포의 성공으로 대신하지 않는다.
- 중단 소개검수 product-intro-check의 not_before2100-01-01/processed_version741/leasedfalse가 배포 전후 동일하다. root의PPT·미추적 사용자자료는 보존한다.

## Test commands and actual results

- PR CI38123311591: scope·quality·integration3분할·필수check success. 최신 base6839194와 같음을 병합 직전 확인했다. main CI38123539692: 같은 필수검사와 worker/web image build 모두 success. main보호 우회없음.
- 운영 scripts/migrate.mjs exit0. journal66→73, 새14표, 최신7migration hash가 배포SQL과 일치했다.
- deploy_shared_images.py plan/run exit0. 각 publisher/reviewer/crawler 쌍의 readiness ready/progress ok, web6복제본 실제digest·release·deploymentID·health 정상. 별도 Git source6앱 총7복제본의500파일과worker health 정상.
- 최종 operator verify exit0:14앱 done/healthy, DB5역할 M3primary live+mini standby관측, failover readiness/worker progress ok, scheduler fresh2, 공개m3-web/mini-web health ok/dbok/release650b341.
- 실제 공개 Playwright 홈·/p/nanomuse 상세200, pageerror/consoleerror0·실패리소스0. HTML JS/CSS dpl650b341을 별도 확인하고 홈스크린샷도 직접 봤다. 단발홈load5953→2730ms는 성능개선 통계가 아니다.
- 이전 실제로컬검증:unit246파일/2256pass, DB통합140파일/1370pass+기존TODO1, 신규E2E18pass, 기존flagsOFF전체30pass/18skip, Python23pass, CI-scopeNode4pass, typegen/tsc/lint/build/bundle/빈DBmigration/compose/diff0(기존vendor경고1). 해당 결과를 이번 문서 커밋에서 재실행한 것으로 표현하지 않는다.
- 이번 문서 단계에서는 Node CI-scope 4개를 실제 다시 실행하여 pass/exit0, 문서 diff check도 exit0을 확인했다.

## Failed approaches / remaining work

source 최초502파일probe에는 .dockerignore가 제외하는 scripts/ops2개가 들어 있었다. operator검증을500으로 고친 뒤 완료된컨테이너를 재배포 없이 확인했다. 처음 pollinghelper만SIGTERM(exit143)했고 서비스코드는 바꾸지 않았다. 전체복구를mini먼저시작해 예비가 정상lease를 먼저받았다. maintenance/text순차교체 및 나머지3역할의 mini개별 정상drain→M3소유권 확인→mini재시작으로5역할 M3primary를 회복했다. 이후operatorresume은M3→mini순서다.

Cloudflare HTML purge는 Authentication error로 실패했다. 새홈/상세dpl·실제브라우저로딩은 정상이며 배포실패로 되돌리지 않았다. `nomorevibe-cloudflare-purge-token` Keychain의 유효zonepurge키 복구와 purge_html ok를 PENDING에 기록했다. purge가 성공했다고 주장하지 않는다.

실제App capability·Resend/사용자키·허가된일반사용자/제작자·개인/조직repo가 준비된 뒤 runbook으로 인증→Star→로컬feedback→지정제품외부전송을 활성화하고 실메일/스타/이슈/권한철회/외부전송failover 파일럿을 검증한다. staging행은 실제staging서비스미검증으로 남겼고 운영14앱과DB행만 실제증거로갱신했다. unknownStar영구fence/관리자unlock미구현 및 기존fallback저장dirty표시는 PENDING의 별도항목이다. 코드배포 완료를 기능활성화 완료로 해석하지 않는다. 소개검수 재개·migrations 재적용·테스트DB초기화를 운영에서 실행하지 않는다.

## Evidence / exact commands for the next agent

운영근거문서 `docs/operations/2026-10-11-github-integration-rollout.md`. 비밀 포함 all-apps/swarm/shared-image snapshot은 `/private/tmp/nomorevibe-{all-apps-before-20261011,swarm-before-20261011,release-650b341-20261011}.json`, 모두0600이며 raw출력/커밋금지. 안전한검증기록은 `/private/tmp/nomorevibe-{migration-result-20261011,db-after-migration-20261011,production-release-20261011,public-after-20261011}.json`와 공개스크린샷이다. operator Python helper도 같은/private/tmp에 남겼다.

```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short --branch
gh pr view 356 --json state,mergeCommit,url
gh pr list --head docs/github-integration-rollout-20261011 --state all --json number,state,url
gh run view 38123539692
curl -fsS --max-time 10 https://nomorevibe.brut.bot/api/health
cd /private/tmp/nomorevibe-release-20261011
python3 /private/tmp/nomorevibe-release-ops-20261011.py verify --worker-image ghcr.io/jrvector9/nomorevibe-worker@sha256:b2f81cd8179770c364452e9d2cbb1fb19c1a1ac9607c79496b3282dbde1070ab --web-image ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:8b65fed0865672f2ab942874a897f9ff00850ad6d309238f58fa4921deeb2ab6
```

이 문서를 담은 운영증거 docs-only PR의 최종 필수CI/병합 상태는 위 명령으로 직접조회한다. 변경범위가 README/PENDING/docs이므로 운영코드재배포는 필요하지 않다. 이전 기록은 아래 보존하되 위 현재 상태와 실제Git/DB검사 결과를 우선한다.

---

# 2026-10-11 16:21 KST — GitHub PR01~09 로컬 구현·리뷰·검증 완료

## Current objective / completed work

사용자가 승인한 PR01~09를 3개 서브에이전트로 병렬 구현하고 root가 파일 소유권·DB를 격리했다. 에이전트 종료 후 직접 코드 리뷰·계획 대조·회귀 수정·전체 검사 및 9개 논리 커밋을 수행한다. 작업 branch `feat/github-stars-feedback-20261011`, worktree `/private/tmp/nomorevibe-github-integration-20261011`, base `6839194dc47e1f1993f54471c0fb94b6857cd6aa`다. 모든 agents와 직접 Codex CLI는 `gpt-6.1-sol`/`xhigh`다.

완료 커밋:01 `a03f638`,02 `c4606ac`,03 `b25731f`,04 `2992598`,05 `9df60e0`,06 `0ea6656`,07 `cba7eed`,08 `007d65f`;09는 이 인계 문서·최종검사·배포준비를 담은 검증 커밋이다. PR 번호는 계획상의 논리 번호이며 원격 PR를 생성하지 않았다. user root main/PPT/미추적 자료 보존, 외부 push/merge/배포/메일·스타·이슈 쓰기 없음. 소개 검수 중단 유지.

## Modified files / key design decisions

01~08은 `lib/domain/{accounts,github-integration,github-user,github-stars,feedback,github-installations,github-webhooks}`, 공개/제작자/GitHub API와 로그인·제품·관리자 UI, DB schema와 migrations0066~0072, job catalog/registry 및 unit/integration/E2E를 변경했다. 09는 `.env.example`, `compose.yml`, `README.md`, `PENDING.md`, deploy script/Python 테스트, 기존 E2E8파일, 새 흐름 E2E와 운영/계획/인계 문서다. 정확한 전체 목록은 아래 git diff 명령으로 확인한다.

- 이메일 피드백과 개인 GitHub Star 인증을 구분하고 관리자 세션/수집용 인증과 분리한다. 제작자만 수정키와 repo관리 권한·선택저장소 FeedbackApp 설치로 수신을 켠다.
- unknownStar는 영구 외부순서 fence이며 GET/재연결/lease 만료로 해제하지 않는다. 자동·관리자 unlock API 없음은 PENDING/runbook에 명시했다.
- outbox는 원문·동의·숫자repoID·bindingrevision/hash를 검증하고 외부HTTP중 DB transaction을 유지하지 않는다. uncertain 자동POST금지, state=all 전체marker·개별이슈 확인, rate-limit backoff, 명시적1회재전송/감사.
- signed lifecycle/첫binding/재전송은 installation advisory lock-before-product를 사용한다. presentpermissions의Issues생략은 explicitnone, permissions부재는 optionalnull, malformed400. deliveryUUID전역PK는 app/hash충돌거절.
- maker token10분사용만료, flagsOFF에도 다음15분maintenance에서암호문폐기. maintenance/publisher에는 FeedbackApp키만 필요하고 Starclient/복호화secret불필요.
- Node 공유 worker7파일의 Next전용 server-only 표식을 최소제거했다. 웹전용표식은유지, Node/DB가서버경계. 실제 Node registry/역할worker기동 검증했다.
- 배포8개쓰기대상유지. maintenance2개는읽기전용preflight이며 동일SHA 수동 mini→M3 절차다. 네featureflag는defaultfalse.

## Test commands and results / failed approaches

최종 실제 실행: typegen·tsc·linter exit0(기존vendor경고1), unit246파일/2256pass, DB통합140파일/1370pass+기존TODO1, 새5spec E2E18pass, 기존flagsOFF전체E2E30pass/새18skip, Python23pass, CI-scopeNode4pass, 빈55444DB 전체migration0, productionbuild0·bundle gate0(홈129.1KB/상세128.8KB/등록120.1KB br), compose config0, diff check0. build에는기존agent-review.ts동적파일경고가있다. 실제워커선출/SIGTERM drain/standby/crashfailover6개도GREEN이다. 원격GitHubCI check를실행한결과로표현하지않는다.

01 및02b/03b/04c/05b/06b/07c/08b/09b 직접Codex재리뷰OK, 기존E2E8개rootdiff리뷰+github_core읽기전용추가리뷰에서새P0/P1/P2없음. 실제키/외부파일럿은아직없다.

실패 접근: PG17transaction_timeout FATAL은postgres3.4.9 socket=nulldriver오류로폐기했다. scoped쿼리/SQL남은deadline·COMMIT전lease체크/awaitrollback으로실제DB통과. plainNodeworker는server-onlydefaultthrow를정리했다. Nextbuild 외부node_modules symlink panic은APFS물리clone으로해결. 기존E2E의캐시slug·30초memo·현행DOM·srcsetnaturalWidth를test-only보완했다. 늦은RSCbody읽기경합도제거하고 DB/새formversion/저장판/reload로저장을확인한다.

별도미해결: 기존관리자fallback저장은실제action ok:true/version+revalidatedprops가확인됐으나dirty표시가남아성공알림이숨겨졌다. 관련생산코드는기준6839194와동일. PENDING에별도기록했으며UI문제를해결했다고주장하지않는다. 당시c원본trace는다음실행에서덮였다;d의수명경합trace는 `/private/tmp/nomorevibe-gh-baseline-ui-defect-20261011/`에보존했다.

## Remaining work / exact commands for the next agent

로컬코드/리뷰/검증커밋단계를마무리했다. 실제Star/FeedbackApp·Resend/암호화/일반인증키와승인된사용자/개인·조직repo/email이미제공이라capability/실메일수신/실스타·봇이슈/웹훅/운영주예비배포·파일럿은미검증이다. 계획01/04/07/08의실연동완료및09운영항목을체크하지않았다. 준비후runbook/PENDING/파일럿기록을따른다. 중단소개검수는재개하지않는다. 모든에이전트파일동결, 추가수정시검증범위갱신.

전용 pgvector0.8.6-pg17 컨테이너의exactDB이름은nomorevibe_test.55441auth/55442feedback/55443browser(43127)/55444freshfullDB이다. 같은DB의통합/E2E동시초기화금지. node_modules는root원본과분리한물리clone이며사용자원본deps변경없음. 임시snapshotblobs/로그는커밋대상이아니다. 주요최종log `/private/tmp/nomorevibe-gh-final-{unit-b,integration-b,feature-e2e-b,baseline-e2e-e,python,ci-scope,fresh-migration,bundle-b,lint-d,tsc-d}.log`.

```sh
cd /private/tmp/nomorevibe-github-integration-20261011
git status --short --branch
git log --oneline -9
git diff 6839194 --name-only
cat docs/operations/2026-10-11-github-integration-implementation.md
cat docs/operations/github-stars-feedback-runbook.md
cat docs/operations/2026-10-11-github-integration-pilot.md
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@localhost:55444/nomorevibe_test npm run test:integration
PUBLIC_USER_AUTH_ENABLED=true GITHUB_STAR_ENABLED=true PRODUCT_FEEDBACK_ENABLED=true GITHUB_FEEDBACK_DELIVERY_ENABLED=true TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@localhost:55443/nomorevibe_test npx playwright test tests/e2e/public-user-auth.spec.ts tests/e2e/github-user-connection.spec.ts tests/e2e/github-star-action.spec.ts tests/e2e/product-feedback.spec.ts tests/e2e/github-integration-flow.spec.ts
```

---

# 2026-10-01 — 최신 수집 수정·배포·실제 저장 검증 완료

## Current objective / completed work

홈 “태어난 프로젝트” 감소 원인을 확인하고 GitHub 수집을 최신 활동순으로 수정했다.
운영 홈 지표는 현재 16건, 이전 7일 201건(-92%)이었다. KST 오늘 자정 이전 완료된
최근 7일의 GitHub 생성일 집계이며 누적 수가 아니다. seed가 UTC 9/15~18의 Claude
포화 구간에 약 12일 머물러 최신 생성분의 수집이 부족했다. 워커 실행·저장·발행은 계속됐다.

PR #244(수집 수정), #245(HN 테스트 DNS 의존 제거)를 병합하고 운영 릴리스
`dd3a21f07fe98acd60148701cce1c1f8d1afdae8`를 공유 이미지 8앱에 배포했다.
모두 deployment done/service healthy, publisher·reviewer·crawler 준비 ready/progress ok,
공개 m3-web·mini-web health ok/db:ok/같은 release 확인. 02:00:38 KST에 saveSettings로
sort relevance→recent, pagesPerTick 2→10만 부분 수정했고 당시 기존 cursor는 그대로였다.
정상 역할 worker에 seed 3틱을 순차 요청하여 최신 12개 신호를 모두 확인했다.
latestScan은 UTC 9/27 17:01:22~9/30 17:01:22, doneSignals 12개/waiting=true,
다음 최신 탐색은 03:01:22 KST 이후다. 그동안 기존 full cursor의 전체 탐색은 이어간다.

02:15 KST 관측: 신규 frontier 389 = 원본/후보 382 + 기존 GitHub ID 별칭 7(skipped).
신규 GitHub ID 중복 0, pending/fetching/failed 0. 최근 7일 생성 원본 112개를 확보했다.
당시 83개는 규칙 거절(no_homepage 71/not_a_product 10/unreachable 2),
16개 승인 상태, 13개 추가 심사(ambiguous 11/second_review_split 2)로 아직 공개 전이었다.
홈 born은 심사·발행한 공개 제품만 포함하며 오늘 발행분은 다음 KST 자정 이후 집계 대상이다.
로컬 root main도 운영 코드가 있는 origin/main으로 fast-forward했다. 화면 자료는 그대로다.

## Modified files / key design decisions

`lib/crawl/jobs/seed.ts`, `settings-schema.ts`, `github.ts`, `app/admin/SettingsForm.tsx`,
README, 수집 unit/integration fixtures·최신 탐색 10개 회귀검사, HN 테스트 DNS stub,
`docs/operations/2026-10-01-born-count-latest-discovery.md`, 이 문서를 수정했다.
최신은 활동일(committer-date/updated desc), born은 생성일(created_at)이다. 하루 지연 시
최신 첫 페이지를 먼저 확인하고 나머지 예산으로 기존 전체 탐색을 진행한다. 최신 peek를
전체 탐색 완료로 간주하지 않는다. 정렬 변경 시 미완 기간을 보존하고 페이지 1부터 재탐색한다.
두 커서는 같은 job/role lease 안에서 직렬 실행하며 중복·인증·쿼터·큐 상한을 유지한다.
DB 서버·schema·streaming 설정과 중단된 소개 검수는 변경하지 않았다.

## Test commands and results / failed approaches

`npm test` 161파일·1,286검사, 수집 3파일·38검사, next typegen, `tsc --noEmit`,
`git diff --check` 성공. lint 오류 0·기존 vendor 경고 1.
`python3 -m unittest tests/test_deploy_shared_images.py` 8검사 성공.
PR run 36745191372/#244, 36746542548/#245의 quality·통합 3분할·필수 check 성공.
main run 36747035679는 quality·통합 3분할·check와 두 이미지 빌드 모두 성공.
이전 main run 36745740075의 HN 1,100건 검사는 실제 DNS 반복으로 5초 timeout을 넘었고,
끝나지 않은 테스트가 다음 mock도 오염시켰다. 테스트 DNS만 고정한 뒤 후속 검증이 성공했다.
첫 TypeScript 검사는 테스트 반환 타입 추론이 좁아 실패했고 SeedCursor 명시로 수정했다.
로컬 Docker daemon 미실행으로 통합 검증은 CI의 독립 PostgreSQL 3분할을 사용했다.
실제 최신순 GitHub 표본은 commit 100건/97repo, topic 100건/100repo, 활동일도 최신이었다.
Claude 광역 검색은 total 3,664,361/incomplete=true로 포화를 직접 확인했다.
중간 원본·후보 수량 차이는 judge가 따라간 뒤 382/382로 일치했다. 저장 누락은 아니었다.

## Remaining work / exact commands for the next agent

이번 요청의 구현·배포·수집 검증은 완료했다. 이 완료 기록은 docs-only PR로 보존하며
문서만 바뀌므로 운영 재배포가 필요하지 않다. PENDING.md의 장기 관측·복구 주입은 별도다.
사용자 화면 미추적 자료와 이전 backup/stash는 보존했다. 설정 적용과 seed 3틱을 다시
실행하지 않는다. 최신/과거 두 cursor를 구분해 읽는다. 과거 full 날짜만 보고 최신 수집이
여전히 멈췄다고 판단하지 않는다.

```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short --branch
git rev-list --left-right --count HEAD...origin/main
gh run view 36747035679 --repo JRVector9/nomorevibe --json status,conclusion,jobs
curl -fsS --retry 2 --retry-all-errors https://nomorevibe.brut.bot/api/health
python3 /private/tmp/nmv-after-query.py
```

배포 snapshot `/private/tmp/nomorevibe-release-dd3a21f.json`(0600)은 환경 비밀을 포함한다.
표시/커밋 금지. 읽기 전용 관측 `/private/tmp/nmv-latest-final.json`, 수정 전 관측
`/private/tmp/nmv-born-before.json`을 보존했다. 원격 보조는 Keychain/Dokploy를 쓰며 비밀을 출력하지 않는다.

---

# 2026-09-30 — 로컬·원격 정리와 운영 상태 문서화 완료

## Current objective / completed work

화면 시안·이미지·압축본을 제외한 로컬 미커밋 문서와 검색 판정 자료를 PR #242로
main `11b90ef684ee8a002f25d414aa4f6b2961694e1d`에 병합했다. 로컬 루트
`main`도 fast-forward하여 `HEAD...origin/main`이 `0 0`이다. 운영 공유 이미지
8개 앱은 릴리스 `50b02b7`에서 모두 `done`, 공개 health `ok/db:ok`,
failover와 worker progress `ok`다. 이번 병합은 문서·평가 데이터·로컬 운영 보조
스크립트만 바꿨으며 운영 앱은 재배포하지 않았다.

## Modified files / key design decisions

PR #242는 운영 보고서·평가 근거, 검색 수정 계획, PT 기획 문서 텍스트,
`scripts/search-judgments.json`, `.claude/prod.sh`, `AGENTS.md`, `README.md`,
이 인계 문서를 포함한다. `AGENTS.md`의 과거 10개 앱 표기를 주·예비 13개 앱으로
수정했다. PT 문서에는 화면 이미지가 Git에 포함되지 않음을 밝혔다. 로컬의 오래된
동명 failover 설계는 원격의 최신 파일을 우선했고, 로컬 인계 문서의 9월 28일 메모는
원격에 동일한 내용이 이미 있어 중복 추가하지 않았다. 화면 자료는 로컬에 남겼다.

로컬 기존 자료의 사본·이동 백업은
`/private/tmp/nmv-root-presync-20260930-8_39m5kv`(0700, manifest 0600),
추적 파일 변경의 Git 백업은 `stash@{0}: presync-20260930-tracked-notes`다.
백업에는 이전 로컬 문서와 검색 판정 자료가 있으므로 필요 여부 확인 전 삭제하지 않는다.

## Test commands and results / failed approaches

검색 판정 JSON은 이전 1247개 값 삭제·변경 없이 1257개 항목을 추가했다.
`python3 -m json.tool scripts/search-judgments.json`, 새 JSON/JSONL 52파일 파싱,
`bash -n .claude/prod.sh`, `git diff --cached --check`가 통과했다. PR #242의
GitGuardian·quality·통합 3분할·필수 `check`, main run `36657187881`의
quality·통합 3분할·필수 `check` 및 이미지 빌드가 모두 성공했다. 로컬 fast-forward
후 `git rev-list --left-right --count HEAD...origin/main`은 `0 0`이었다.

첫 staged diff 검사는 원본 PT Markdown hard break 공백과 평가 CSV/로그의 CRLF·
끝 공백을 지적했다. 복사한 텍스트 59개를 정규화한 뒤 통과했다. 루트에서 바로
fast-forward하면 미추적 문서와 최신 추적 문서가 충돌하므로, 85개 파일을 백업으로
이동하고 추적 2개를 stash한 뒤 fast-forward했다. 원본 화면 자료는 이동하지 않았다.

## Remaining work / exact commands for the next agent

이 완료 기록만 docs-only PR로 병합한다. 별도로 요청되지 않은 화면 자료는 로컬
미추적 상태로 유지한다. 백업·stash는 검증을 위해 보존했다. 장기 관측·실제
복구 주입 등 운영 검증은 `PENDING.md`를 따른다.

```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short --branch
git rev-list --left-right --count HEAD...origin/main
git stash list -1
gh run view 36657187881 --repo JRVector9/nomorevibe --json conclusion,jobs
curl -fsS https://nomorevibe.brut.bot/api/health
```

---

# 2026-09-30 — 로컬 문서·판정 자료와 원격 운영 상태 정리 진행 중

## Current objective / completed work

사용자 요청에 따라 뒤처진 로컬 `main`을 최신 원격 상태로 맞추고, 로컬 미커밋 자료 중
화면 시안·이미지·압축본을 제외한 문서와 검색 판정 데이터를 커밋한다. 원격 main
`e7867bc`에서 별도 작업 트리 `/private/tmp/nmv-repo-sync-20260930`의
`docs/reconcile-local-20260930` 브랜치를 만들었다. 루트 checkout의 기존 자료는
아직 변경하지 않았다. 공개 `/api/health`는 `ok/db:ok`, 릴리스 `50b02b7`이었다.
공통 이미지 8개 앱은 모두 Dokploy `done`/최신 배포 `done`/릴리스 `50b02b7`, 운영
failover·worker progress는 모두 `ok`로 읽기 전용 확인했다.

## Modified files / key design decisions

로컬의 운영 보고서·평가 근거 79개, 검색 수정 계획 1개, PT 기획 문서 3개,
`.claude/prod.sh`와 `scripts/search-judgments.json`을 별도 작업 트리로 복사했다.
`AGENTS.md`의 10개 앱 설명을 README와 실제 주·예비 13개 앱 구성에 맞게 고쳤다.
PT 문서에는 화면 이미지가 저장소에 포함되지 않는다고 표시했다. 화면 시안 디렉터리,
이미지, ZIP, 프로토타입은 커밋 대상에서 제외한다. 로컬의 9월 28일 설계 파일은
동일 경로의 원격 파일보다 오래되어 덮어쓰지 않는다. 로컬 `CODEX_HANDOFF.md`의
추가 37줄은 원격 파일의 2026-09-28 18:13 KST 항목과 본문이 완전히 같아 다시 넣지 않는다.

## Test commands and results / failed approaches

`git rev-list --left-right --count HEAD...origin/main`은 루트 기준 `0 28`이었다.
검색 판정 데이터는 기존 1247개 항목을 바꾸거나 삭제하지 않고 1257개를 추가했다.
`python3 -m json.tool scripts/search-judgments.json`, 새 JSON/JSONL 52파일 파싱,
`bash -n .claude/prod.sh`, `git diff --cached --check` 종료 0. 처음의 diff 검사는
원본 PT 문서의 Markdown hard break 공백과 평가 CSV/로그의 CRLF·끝 공백을 지적했다.
작업 트리로 복사한 텍스트 59개를 정규화한 뒤 다시 통과했다.
운영 8개 공통 이미지 앱과 두 감시 CLI의 읽기 전용 조회는 위 결과였다.
문서·판정 자료의 커밋, PR 검사, 루트 main 갱신은 아직 하지 않았다.

## Remaining work / exact commands for the next agent

선별한 자료의 보안·중복·현재성 검사, 필요한 문구 보완 후 commit/push·PR 필수
`check` 통과·병합한다. 그 뒤 루트의 추적 파일 수정분을 안전하게 보존하고 원격
main으로 fast-forward한다. 원격과 경로가 겹치는 로컬의 오래된 설계 파일은 별도
백업 후 최신 추적 파일을 받는다. 화면 자료는 로컬에 그대로 남겨 둔다.

```sh
cd /private/tmp/nmv-repo-sync-20260930
git status --short --branch
git diff --check
bash -n .claude/prod.sh
python3 -m json.tool scripts/search-judgments.json >/dev/null
cd /Users/jr/Desktop/projects/nomorevibe
git status --short --branch
```

---

# 2026-09-29 — 수집·1차 심사 재시도 소진 복구 운영 적용 완료

## Current objective / completed work

멈춰 있던 1차 AI 심사 후보 2건과 GitHub 원본 재수집 실패 후보 1건을 사람 심사 큐로
옮기는 수정을 PR #240으로 main `50b02b739a556af4ad92cd86fbd72c429f00e4e2`에
병합했다. 새 공통 worker/web 이미지를 운영 8개 앱에 순차 배포했고 공개 M3·mini 웹
health, 역할별 준비·진행 상태, 실제 후보 3건의 인계를 확인했다. 루트 checkout의 사용자
변경, DB 서버·스트리밍·스키마는 건드리지 않았다.

## Modified files / key design decisions

기능 파일과 테스트 목록은 바로 아래 구현 단계 항목에 있다. 운영 적용 기록으로 이 파일을
추가 수정했다. 재시도 소진은 자동 승인이나 오래된 원본 재사용 대신
`ai_review_exhausted`/`source_refresh_failed` 사람 심사 사유로 남긴다. 단계별
`manualAttention`은 워커 장애 경보와 분리한다. 이전 앱 설정의 0600 복구 스냅샷은
`/private/tmp/nomorevibe-release-50b02b7.json`이며 비밀값을 포함하므로 내용을
출력하거나 저장소에 넣지 않는다. 새 worker digest는
`sha256:bb289114dc4a9e7fce059ff28b60a95e3086bbe2f3611a98ed7a8e260c710c9f`,
web digest는 `sha256:35f5df4f1c9b92536eb39b0795391e0d4295b49fd4fc6238ae082febb9cb105e`다.

## Test commands and results / failed approaches

로컬 `npx tsc --noEmit`, `npm run lint`, `npm run build`, `git diff --check` 종료 0;
`npm test` 160파일 1276/1276 통과, 관련 통합 56개·28개와 관리자 사유 파일 15/15 통과.
PR #240의 GitGuardian, quality, 통합 3분할, 필수 `check` 성공; main run
`36579824652`의 동일 검사와 worker/web 이미지 빌드 성공. 배포 CLI `plan`·`run`
종료 0; 8개 앱 `done`/healthy, crawler·reviewer·publisher 역할 `ready`와 진행 `ok`,
공개 M3·mini health `ok`. 배포 전 후보 ID 109663·109675는 `approved`, 16941은
`new`/frontier `skipped`였다. 배포 후 세 후보 모두 `needs_review`가 됐고 실제
`reviewQueueCauses`의 `ai_review_exhausted`에 앞의 2개, `source_refresh_failed`에
나머지 1개가 나타났다. 실제 `pipelineThroughput`은 fetch `manualAttention=1`,
first `manualAttention=2`; 진행 CLI는 두 단계 `manual_attention`, `alarm=false`,
전체 failover/progress `ok`였다. 최근 5분 수집·규칙·1차·2차·발행 완료량은
각각 14·14·4·5표·3이었다.

첫 전체 단위 검사에서 새 repository 함수를 테스트 목에 빠뜨려 19개가 실패했으며,
목 수정 후 전체 재실행이 통과했다. 운영 조회에서 TypeScript 프로세스가 DB 풀을
열어 둬 SSH가 40초에 만료됐고, 조회 출력 뒤 프로세스를 종료하여 정상 측정했다.
운영 복구/롤백 또는 장시간 장애 주입은 수행하지 않았다.

## Remaining work / exact commands for the next agent

이 운영 기록 문서만 commit/push하고 docs-only PR의 필수 `check`와 GitGuardian을
확인한 뒤 병합한다. 장기 관측과 실제 장애·복구 주입은 `PENDING.md`의 별도 항목이다.

```sh
cd /private/tmp/nmv-pipeline-deploy-20260929
git status --short --branch
git diff --check
gh run view 36579824652 --repo JRVector9/nomorevibe --json conclusion,jobs
curl -fsS https://nomorevibe.brut.bot/api/health
```

---

# 2026-09-29 22:56 KST — 수집·1차 심사 재시도 소진 복구 구현, 운영 적용 대기

## Current objective / completed work

운영 확인에서 발견한 1차 AI 심사 재시도 소진 후보 2건과 GitHub 원본 재수집 실패 후보 1건을
자동 작업의 숨은 대기에서 사람 심사 큐로 넘기도록 수정했다. 독립 작업 트리
`/private/tmp/nmv-pipeline-stuck-20260929`의 `fix/pipeline-stuck-recovery`에서 작업했고,
루트 checkout의 사용자 변경은 건드리지 않았다. 아직 commit·PR·운영 배포는 하지 않았다.

## Modified files / key design decisions

`lib/crawl/agent-review-repository.ts`, `lib/crawl/jobs/agent-review.ts`는 현재 설정·원본에 맞는
1차 실패 3회가 있고 유효한 성공이 없는 자동 승인 후보를 `ai_review_exhausted`로 사람 큐에 넘긴다.
`lib/crawl/repository.ts`, `lib/crawl/jobs/fetch.ts`는 `reconsiderAfter`보다 새 원본이 필요한데
프론티어가 최종 `skipped`/`failed`이면 `source_refresh_failed`로 넘긴다. 양쪽 모두 작업 lease와
후보 행 잠금으로 소유권을 확인하며 자동 승인·발행으로 우회하지 않는다. 새 사유는
`lib/db/crawl-schema.ts`, `lib/crawl/admin-review.ts`, `app/admin/reasons.ts`,
`app/admin/review/causes.ts`에 추가했다. `lib/operations/throughput-model.ts`, `throughput.ts`,
`worker-progress.ts`, `app/admin/status/ThroughputStrip.tsx`, `throughput.module.css`는 단계별
`manualAttention`을 표시한다. 워커 자체 장애가 아니므로 감시 종료 코드 0은 유지하고,
관리자에는 직접 확인 링크·건수를 보인다. 운영 설명은
`docs/operations/independent-workers-runbook.md`에 있다. DB 스키마·migration은 변경하지 않았다.
테스트 파일은 `tests/integration/agent-review-records.test.ts`, `crawl-fetch.test.ts`,
`operations-throughput.test.ts`, `tests/worker-progress.test.ts`,
`tests/operations-throughput-display.test.ts`, `tests/agent-review-job.test.ts`,
`tests/integration/admin-review-causes.test.ts`다.

## Test commands and results / failed approaches

`npm ci`, `npx next typegen`, `npx tsc --noEmit`, `npm run lint`(기존 미사용 변수 경고 1개),
`npm run build`, `git diff --check` 종료 0. 통합 테스트 3파일 56/56,
사람 심사·감시 관련 3파일 28/28, 새 관리자 사유 테스트가 포함된 파일 15/15,
전체 `npm test` 160파일 1276/1276 통과했다. 첫 전체 단위 실행은 새 함수를 목에
등록하지 않아 `agent-review-job.test.ts` 19개가 실패했다. 목을 추가하고 전체 재실행이
성공했다. 실제 운영의 두 후보·한 후보가 새 코드로 이동하는지는 아직 확인하지 않았다.

## Remaining work / exact commands for the next agent

소스 재수집 대기 선별의 대량 큐 경계와 변경 diff를 재검토한다. 이후 commit/push, 보호 브랜치
PR의 최신 CI `check` 성공 및 병합, worker/web 공통 이미지 배포, 운영 2+1건의 큐 이동·
`manualAttention` 표시와 수집→1차→2차의 계속 진행을 확인한다. 배포 순서는
`README.md`와 `docs/operations/independent-workers-runbook.md`를 따른다.

```sh
cd /private/tmp/nmv-pipeline-stuck-20260929
git status --short --branch
git diff --check
npx vitest run --config vitest.integration.config.ts tests/integration/agent-review-records.test.ts tests/integration/crawl-fetch.test.ts tests/integration/operations-throughput.test.ts
npx tsc --noEmit
python3 scripts/ops/deploy_shared_images.py --help
```

---

# 2026-09-29 21:35 KST — 자동 확인 릴리스 운영 적용 완료, 실측 기록 PR 대기

## Current objective / completed work

사용자가 요청한 배포 확인 자동화를 PR #238로 main
`5d67b23466659e943e51d5110ce5f2fd2ef8eab1`에 병합하고 새 worker/web
이미지를 운영 8개 앱에 실제 배포했다. `plan`은 기존 릴리스·두 서버 pull·웹
빌드 키·failover를 확인했고 `run`은 publisher→reviewer→crawler 각각
mini→M3, 웹 mini→M3를 사람의 단계별 대기 없이 처리했다. 8개 앱의 배포·
실행 이미지·건강 상태, 세 역할 쌍의 failover/progress, 양쪽 공개 웹 응답이
모두 정상이다. 운영 기록을 문서 전용 후속 PR로 병합할 일이 남았다.

## Modified files / key design decisions

PR #238은 `scripts/ops/deploy_shared_images.py`,
`tests/test_deploy_shared_images.py`, `.github/workflows/ci.yml`,
`.gitignore`, `.dockerignore`, `README.md`,
`docs/operations/independent-workers-runbook.md`, 이 파일을 변경했다.
현재 `docs/release-verification-rollout` 브랜치는 `PENDING.md`,
`docs/operations/2026-09-29-deployment-speed-rollout.md`, 새
`docs/operations/2026-09-29-deployment-verification-automation-rollout.md`, 이 파일을
기록용으로 변경한다. 배포 실패 시 뒤 앱을 멈추고 권한 0600 스냅샷에서
개별 앱을 복구한다. 웹 키 회전은 자동화하지 않으며 DB 서버·스트리밍·migration을
변경하지 않았다. 루트 checkout의 사용자 변경은 건드리지 않았다.

새 worker digest는
`ghcr.io/jrvector9/nomorevibe-worker@sha256:89e32f9fb18179424310a96aaf23867507ac936327aaaf7f41451f28db8cb19f`,
private web digest는
`ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:3c5b760860b53265c4db2fbe316f584260c6b7c10b4bc23d6913dc8a5ccdbe65`다.
이전 운영 설정 스냅샷은
`/private/tmp/nomorevibe-release-5d67b23.json`(0600)에 있으며 비밀값을
포함하므로 내용은 로그·문서에 출력하지 않는다.

## Test commands and results / failed approaches

로컬 `python3 -m unittest tests/test_deploy_shared_images.py -v` 8/8,
`python3 -m py_compile scripts/ops/deploy_shared_images.py`,
`actionlint .github/workflows/ci.yml`, `git diff --check` 종료 코드 0.
PR #238 최신 hosted quality·통합 3분할·필수 `check`·GitGuardian 성공,
main run `36567972623`의 quality·통합 3분할·필수 `check`·web/worker 이미지
빌드 모두 성공. 실제 `plan`은 20.27초·종료 0, `run`은 사전 검사를 포함해
118.45초·종료 0. Dokploy 기록의 첫 시작 `12:31:16.253 UTC`부터 마지막
완료 `12:32:45.706 UTC`까지 89.45초이며 앞 수동 릴리스 252.8초보다
163.35초(64.6%) 짧다. 배포 후 별도 조회도 8개 앱의 새 digest·복제본·
health와 전체 failover/progress `ok`, 공개 M3·mini health `ok/db:ok`였다.
웹 GHCR 패키지는 private이다.

실제 배포에서는 게이트 실패나 롤백이 없었다. 오류 후 중단·스냅샷 복원은
Python 안전 테스트로 확인했으나 운영 장애 주입은 하지 않았다. 구현 중 웹
Docker healthcheck 부재, failover 보고서의 중첩 구조를 발견해 직접 health·
올바른 필드로 고쳤다. 기존 임시 점검의 논리 이름으로 Docker service를 찾던
오류는 실제 `appName` 사용으로 해결했다.

## Remaining work / exact commands for the next agent

이번 운영 기록 문서만 commit/push·PR을 열고 docs-only 필수 `check`와
GitGuardian 성공 뒤 병합한다. main 문서 push가 이미지를 다시 만들지
않는지 확인한다. 24시간 처리/헬스 관측, 최소 권한 GHCR pull 토큰 교체,
실제 장애·복구 주입은 `PENDING.md`에 남는다.

```sh
cd /private/tmp/nmv-deploy-verify-auto-20260929
git status --short --branch
git diff --check
gh run view 36567972623 --repo JRVector9/nomorevibe --json conclusion,jobs
gh api user/packages/container/nomorevibe-runtime-web --jq '{name,visibility}'
curl -fsS https://nomorevibe.brut.bot/api/health
```

---

# 2026-09-29 20:37 KST — 공통 이미지 배포의 단계별 확인 자동화 구현, PR 최신 검사 대기

## Current objective / completed work

사용자가 요청한 순차 배포 확인 자동화를 진행 중이다. 별도 작업 트리
`/private/tmp/nmv-deploy-verify-auto-20260929`의
`feat/deployment-verification-automation`에서 8개 앱의 사전 확인, 순차 배포,
각 앱의 Dokploy·Swarm·컨테이너 상태, 역할 쌍의 failover/progress, 웹의 직접·공개
health를 자동으로 기다리는 운영자 CLI를 작성했다. 실패하면 뒤 앱을 배포하지
않고 설정 스냅샷에서 개별 앱을 복구하는 `restore` 명령을 제공한다. PR #238을
열었고 첫 hosted CI와 GitGuardian은 성공했다. 최신 추가 테스트의 CI,
main 빌드·새 릴리스 실제 배포는 아직 하지 않았다. 루트 checkout의 사용자 변경과
운영 DB 서버·스트리밍은 건드리지 않았다.

## Modified files / key design decisions

`scripts/ops/deploy_shared_images.py`, `tests/test_deploy_shared_images.py`,
`.github/workflows/ci.yml`, `.gitignore`, `.dockerignore`, `README.md`,
`docs/operations/independent-workers-runbook.md`, 이 파일. CI quality 잡에
Python 표준 라이브러리 테스트를 추가했다. 스크립트는 운영자 Mac의 Keychain,
GitHub CLI, SSH, curl을 사용하며 비밀값·Dokploy 앱 원문을 출력하지 않는다.
`plan`은 main SHA/비공개 웹 패키지, 8개 앱의 동일한 이전 릴리스, DB readiness,
두 서버의 이미지 pull/arm64/revision 및 웹 이미지 빌드 키 일치를 확인한다.
`run`은 권한 0600의 스냅샷을 만든 뒤 publisher→reviewer→crawler의
mini→M3, 웹 mini→M3 순서로 진행한다. 새 deployment ID만으로 성공하지 않고
실제 컨테이너 digest·release·health와 역할 상태를 함께 판정한다. migration
변경이 있으면 별도 완료 표시를 요구한다. 웹 키 회전은 기존 수동 절차를 따른다.

## Test commands and results / failed approaches

`python3 -m unittest tests/test_deploy_shared_images.py -v` 8/8 통과,
`python3 -m py_compile scripts/ops/deploy_shared_images.py`,
`actionlint .github/workflows/ci.yml`, `git diff --check` 종료 0.
실제 운영의 현재 릴리스를 읽기 전용으로 조사해 8개 앱의 Docker service·실행
컨테이너 digest/health, baseline 8개, crawler failover/progress `ok`, 공개
웹의 M3·mini 응답, 두 서버의 기존 digest pull과 웹 이미지 서버 액션 빌드 키
일치를 확인했다. 새 코드의 실제 `run`은 아직 실행하지 않았다.
PR #238 첫 hosted `quality`, 통합 3분할, 필수 `check`, GitGuardian은 성공했다.

첫 remote probe는 웹에 Docker healthcheck가 있다고 가정해 웹을 잘못
`not ready`로 분류했다. 웹은 컨테이너 직접 `/api/health`로 판정하게 고쳤다.
처음엔 Dokploy 표시 이름으로 service를 찾는 이전 점검이 실패했으나 새
도구는 실제 `appName`을 사용한다. failover CLI의 역할 목록은 상위가 아닌
`readiness.roles`에 있음을 확인하고 파서를 고쳤다.

## Remaining work / exact commands for the next agent

최종 코드 diff와 운영 절차를 검토한 뒤 commit/push, PR의 최신 base CI와
GitGuardian을 확인해 병합한다. main의 worker/web 새 digest 빌드 완료 후
새 main checkout에서 `plan`을 실행하고, 출력된 스냅샷 경로로 `run`을 실행한다.
8개 앱의 실제 digest·health와 전체 교체 시간을 확인하고 운영 기록에 실측을
남긴다. 실패 시 자동 계속 진행하지 않으며 해당 앱의 상태·스냅샷을 확인해
`restore`로 이전 릴리스에 맞춘다.

```sh
cd /private/tmp/nmv-deploy-verify-auto-20260929
git status --short --branch
python3 -m unittest tests/test_deploy_shared_images.py -v
actionlint .github/workflows/ci.yml
git diff --check
gh run list --repo JRVector9/nomorevibe --workflow ci.yml --limit 5
```

---

# 2026-09-29 19:55 KST — 배포 속도 개선 1·2·3 완료, main 문서 경로·운영 재확인

## Current objective / completed work

배포 속도 개선 1·2·3을 완료했다. CI 병렬화·공통 이미지 배포 코드 PR #234/#235,
운영 기록 PR #236은 main에 병합됐다. #236 문서 전용 PR의 첫 필수 `check`는
실행 생성부터 14초, 최신 커밋은 19초였다. main 문서 push `908edf3`는
16초였고 세 실행 모두 quality·integration·두 이미지 작업이 skipped였다.
앞선 코드 PR #234의 필수 `check`는 2분 55초(직전 6분 27초), #235 main은
2분 53초(직전 5분 3초)였으며 두 이미지 작업까지 4분 17초였다.
8개 운영 앱은 worker/web 공통 digest로 실행 중이며 최종 재확인에서 8개
Docker service 모두 지정 digest·1/1 복제본·배포 `done`이었다.

## Modified files / key design decisions

이번 최종 기록 브랜치 `docs/deployment-speed-final`은
`docs/operations/2026-09-29-deployment-speed-rollout.md`와 이 파일만 수정한다.
기능/운영 배포 변경 파일 목록, digest, 키 회전, DB 무변경 결정은 아래 19:48
KST 항목에 있다. 운영 전체 교체는 확인 대기로 4분 12.8초가 걸려 이전 4분
7초보다 짧아지지 않았다. 이 수치는 CI와 개별 앱 배포 개선과 분리해서 기록한다.

## Test commands and results / failed approaches

`gh run view 36557725684`, `36557913407`, `36557983527`의 jobs/완료 시각으로
문서 전용 PR 두 실행과 main 실행의 성공·skip을 확인했다. 최종 운영 읽기 전용
점검은 8개 앱의 Dokploy source/digest/release/deployment, 실제 service image와
replica `1/1`을 모두 확인했다. 두 웹 컨테이너의 직접 health는 각각
`status:ok`, `db:ok`였고 runtime 키와 deployment ID도 일치했다. 공개
`/api/health`를 `curl`로 12회 조회해 M3 3회·mini 9회, 모두 새 release와
`ok/db:ok`였다. private web package visibility도 재확인했다.

첫 점검 스크립트는 Dokploy 표시 `name`으로 Docker service를 찾아 빈 값을
오류로 판단했다. 실제 service 식별자인 `appName`으로 다시 조회해 8개 모두
일치했다. Python 기본 `urllib` 요청은 공개 프록시에서 403이었으나 `curl`
요청은 200이었고 12회 전체 검증을 마쳤다. 기능 테스트의 자세한 기록과
첫 공개 웹 이미지 대응은 아래 19:48 KST 항목 및 운영 기록에 있다.

## Remaining work / exact commands for the next agent

필수 구현·검증은 끝났다. 24시간 처리/헬스 관측, GHCR pull 자격 정보를 별도
최소 권한 토큰으로 교체하고 만료·철회 상황을 확인하는 일, 운영 순차 검증의
자동화는 `PENDING.md`의 후속 작업이다. 이 최종 기록 PR을 병합한 뒤 main의
문서 전용 `check` 성공과 이미지 작업 skip을 확인한다.

```sh
cd /private/tmp/nmv-deploy-speed-docs-20260929
git status --short --branch
git diff --check
gh run view 36557983527 --repo JRVector9/nomorevibe --json createdAt,conclusion,jobs
gh api user/packages/container/nomorevibe-runtime-web --jq '{name,visibility}'
curl -fsS https://nomorevibe.brut.bot/api/health
gh run list --repo JRVector9/nomorevibe --workflow ci.yml --limit 5
```

---

# 2026-09-29 19:48 KST — 배포 시간 단축 1·2·3 운영 전환 완료, 문서 PR 병합 대기

## Current objective / completed work

사용자가 요청한 (1) CI 병렬화, (2) 같은 SHA의 web/worker 공통 이미지 배포,
(3) 문서 전용 빠른 CI를 적용했다. PR #234와 #235는 각각 main `202e9d7`,
`cf64bc2`에 병합됐다. PR #234 필수 `check`는 2분 55초로 직전 PR #231의
6분 27초보다 짧았고, PR #235 main `check`는 2분 53초로 이전 5분 3초보다
짧았다. main의 두 이미지 작업까지는 4분 17초였다. Docker source로 바꾼
운영 8개 앱의 실제 image digest, `RELEASE_TAG`, 배포 `done`을 확인했다.
두 웹의 직접 및 공개 health, worker failover readiness/progress도 확인했다.
문서 전용 PR #236의 첫 hosted 실행은 생성부터 필수 `check`까지 14초였다.
이 문서 변경의 최신 검사와 병합이 남았다.

## Modified files / key design decisions

코드 변경은 PR #234/#235의 `.github/workflows/ci.yml`,
`scripts/ci-scope.mjs`, `scripts/ci-scope.node-test.mjs`, 통합 테스트 fixture와
`docs/superpowers/specs/2026-09-29-deployment-speed-design.md`에 있다.
이번 문서 작업 트리 `/private/tmp/nmv-deploy-speed-docs-20260929`의
`docs/deployment-speed-rollout`은 `README.md`, `PENDING.md`,
`docs/operations/independent-workers-runbook.md`,
`docs/operations/2026-09-29-deployment-speed-rollout.md`,
`docs/superpowers/plans/2026-09-29-deployment-speed.md`, 이 파일을 수정한다.
루트 checkout에는 다른 사용자 변경이 있어 건드리지 않는다.

worker digest `ghcr.io/jrvector9/nomorevibe-worker@sha256:77f33353431c74be2886a0b3d5849fcf5e20cbaea722ecd45fcdefac183176d8`를
crawler/reviewer/publisher 주·예비 6개가 공유한다. private web digest
`ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:b3a81e45d30c7720e5a90fa28de713c3ba496f84d17770b26d07bb4050164b39`를
mini/M3 웹 2개가 공유한다. 8개 앱의 이전 source/env/build 백업은
`/private/tmp/nmv-deploy-speed-app-snapshot.json`(0600)에 있다. DB 서버,
스트리밍, migration은 변경하지 않았다. 웹 build/runtime key는 같은 새 값으로
회전했고 `/private/tmp/nmv-next-actions-rotated-20260929.key`(0600)에 보관한다.

## Test commands and results / failed approaches

로컬 분류기 4/4, 독립 PostgreSQL 17 DB 3개를 쓴 통합 shard
323/271/352개 통과와 기존 TODO 1개, `npx next typegen`, `npx tsc --noEmit`,
`npm run lint`, `npm test`, `npm run build`, `actionlint`, `git diff --check`가
통과했다. PR #234/#235 hosted 필수 `check`와 해당 main 이미지 작업이 성공했다.
PR #236 첫 hosted 실행은 `scope`·`check` 성공, quality·integration·web/worker
이미지 작업 skipped, GitGuardian 성공이었다.
두 서버의 arm64 digest pull과 OCI revision을 확인했다. 8개 앱의 최신 deployment
`done`, 실행 중 service의 digest·release 일치, 두 웹 직접 health `ok/db:ok`,
공개 health 12회에서 M3 7·mini 5회 모두 새 SHA를 확인했다.
10:38:59 UTC의 `check-failover-readiness.ts`와 `check-worker-progress.ts`는
exit 0, 전체 `ok`였다. Dokploy 개별 배포 기록 합계는 6.103초이나 운영자가
역할별로 확인해 첫 앱부터 마지막 앱까지 4분 12.8초로 이전 4분 7초보다 짧지 않았다.

첫 `nomorevibe-web` 이미지가 public이며 server-reference manifest에 실제
서버 액션 키를 포함한 것을 2,732개 파일 검사로 발견해 배포하지 않았다.
패키지를 삭제하고 익명 접근 불가를 확인했으며 이전 키를 회전했다. 새 private
`nomorevibe-runtime-web`은 빌드 전후 private/익명 차단을 확인했고 새 이미지에서
이전 키가 발견되지 않았다. 기존 Dokploy `GHCR-deppy` 등록 토큰으로는 Docker
login이 실패해 private web Docker provider에 검증된 운영 계정 pull 토큰을
직접 설정했다. 외부에서 첫 이미지를 다운로드했는지는 알 수 없다.

## Remaining work / exact commands for the next agent

PR #236의 이번 측정 기록 commit/push 후 최신 base 필수 `check`와 GitGuardian
성공을 확인해 병합한다.
main 문서 push에서도 같은 skip을 확인한다. 이후 8개 앱 상태·공개 health를
짧게 재확인한다. 별도 최소 권한 GHCR pull 토큰 교체와 24시간 운영 관측은
`PENDING.md`에 남는다.

```sh
cd /private/tmp/nmv-deploy-speed-docs-20260929
git status --short --branch
git diff --check
git add docs/CODEX_HANDOFF.md docs/operations/2026-09-29-deployment-speed-rollout.md docs/superpowers/plans/2026-09-29-deployment-speed.md
git commit -m 'docs: record measured docs-only CI time'
git push
gh run list --repo JRVector9/nomorevibe --workflow ci.yml --limit 5
gh pr checks --repo JRVector9/nomorevibe 236
```

---

# 2026-09-29 18:50 KST — 공개 웹 이미지의 빌드 키 노출 대응

## Current objective / completed work

배포 시간 단축 PR #234는 main `202e9d7b2d3825842c5c5e2568aa8881bab66592`에 병합됐고
main 필수 `check`와 두 ARM 이미지 빌드가 성공했다. 운영 8개 앱은 아직 이전 Git
소스/릴리스 `e232f16`으로 실행 중이며 두 웹의 autoDeploy는 중복 빌드 방지를 위해
false로 바꿨다. 공개 `nomorevibe-web` 이미지에서 실제
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`가 `/app/.next/server/server-reference-manifest.{js,json}`에
들어간 것을 발견해 웹 앱 전환을 중지했다. 해당 GHCR 패키지를 삭제했고 익명 manifest
접근이 404가 된 것을 확인했다. 이전 키는 노출된 것으로 보고 교체한다.

## Modified files / key decisions

새 작업 트리 `/private/tmp/nmv-private-web-20260929`의 `fix/private-web-image`에서
`.github/workflows/ci.yml`, `README.md`,
`docs/operations/independent-workers-runbook.md`, 이 파일을 수정 중이다.
웹 이미지는 별도 `nomorevibe-runtime-web` 패키지에 계정 토큰으로 푸시하고,
푸시 전 `private` 가드를 둔다. 공개 저장소를 연결하는 OCI source label을 웹에서는
제거한다. 임시 작은 이미지로 새 패키지의 기본 `private` 설정을 직접 확인했고
동일 이름의 비공개 웹 패키지를 bootstrap했다. 로컬 GitHub CLI의 package-write
토큰을 Actions secret `GHCR_PUSH_TOKEN`에 등록했다.

새 32바이트 base64 키는 값 출력 없이
`/private/tmp/nmv-next-actions-rotated-20260929.key`(mode 0600)에 저장하고 Actions
secret `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`를 갱신했다. 이 키는 아직 운영 웹
두 앱에는 적용하지 않았다. 기존 두 웹의 빌드/런타임 키를 같은 새 값으로 교체해
비공개 이미지와 함께 배포해야 한다. 기존 `GHCR-deppy` 등록 PAT는 Docker login이
거부되므로 웹 Docker provider에는 유효한 pull 자격 정보를 직접 넣어야 한다.

## Test commands and results / failed approaches

PR #234 hosted `check`, 통합 3분할, 보안 검사 성공. main의 `check`와 첫 worker/web
이미지 빌드도 성공했고 두 서버에서 두 digest의 실제 pull, arm64와 OCI revision을
검증했다. 단, 첫 웹 이미지는 공개였다. 2,732개 웹 이미지 파일을 실제로 검색해
키가 server-reference manifest 두 파일에 있는 것을 확인했다.
GHCR public package는 private으로 되돌릴 수 없다는 GitHub 문서 때문에 해당
신규 패키지를 삭제했다. 임시 이미지 계정 토큰 push는 private 패키지를 만들었고
`nomorevibe-runtime-web` bootstrap도 `private`으로 확인했다. 새 workflow의
`actionlint`와 `git diff --check`는 통과했다. PR hosted CI와 private 웹 빌드는
아직 실행하지 않았다.

## Remaining work / exact commands for the next agent

새 workflow/diff 검증 후 PR을 열어 CI/병합한다. main private 이미지 빌드의
package visibility와 digest를 확인하고 M3/mini에서 인증된 pull을 시험한다.
두 운영 웹의 buildSecrets와 runtime env에 새 키를 넣고 같은 새 private image로
교체한다. worker 역할 6개도 새 main worker digest로 예비→주 순서로 배포한다.
실제 실행 중 이미지 digest, readiness/progress, 공개 health를 확인한다.
문서 후속 PR에서 docs-only `check`를 실측하고 운영 기록을 갱신한다.

```sh
cd /private/tmp/nmv-private-web-20260929
git status --short --branch
actionlint .github/workflows/ci.yml
git diff --check
gh api user/packages/container/nomorevibe-runtime-web --jq '{name,visibility}'
gh secret list --repo JRVector9/nomorevibe
gh run list --repo JRVector9/nomorevibe --workflow ci.yml --limit 5
```

---

# 2026-09-29 18:32 KST — CI 분할·공통 이미지 빌드 구현, PR 전 검증

## Current objective / completed work

사용자가 승인한 배포 시간 단축 우선순위 1·2·3을 진행한다. 별도 작업 트리
`/private/tmp/nmv-deploy-speed-20260929`의 `feat/deployment-speed`에서 필수
`check`를 유지한 변경 범위 판별, 독립 DB를 쓰는 통합 테스트 3분할,
main 성공 후 웹/워커 arm64 이미지를 한 번씩 GHCR에 빌드하는 workflow를 작성했다.
루트 checkout과 운영 DB 서버·스트리밍은 변경하지 않았다. PR·이미지 생성·Dokploy
source 전환은 아직 하지 않았다.

## Modified files / key decisions

`.github/workflows/ci.yml`, `scripts/ci-scope.mjs`, `scripts/ci-scope.node-test.mjs`,
`tests/integration/{setup,product-audit,review-publication-gate}.test.ts`, `README.md`,
`docs/operations/independent-workers-runbook.md`,
`docs/superpowers/{specs/2026-09-29-deployment-speed-design.md,
plans/2026-09-29-deployment-speed.md}`, 이 파일.
문서 경로만 변경되면 `scope`와 항상 실행하는 필수 `check`만 통과시킨다.
코드 변경은 quality와 3개 DB 격리 integration을 병렬 실행한다. 운영 M3와 mini는
모두 arm64이고 이미지 배포는 SHA 태그를 digest로 확인해 같은 digest를 재사용한다.
기존 웹 두 앱의 동일한 32바이트 Actions 암호화 키를 값 노출 없이 GitHub Actions
secret `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`에 등록했다.

## Test commands and results / failed approaches

`npm ci`, `npx next typegen`, `npx tsc --noEmit`, `npm run lint`, `npm test`,
`DATABASE_URL=postgres://build:build@localhost:5432/build npm run build` 종료 코드 0.
`actionlint .github/workflows/ci.yml`, `git diff --check`,
`node --test scripts/ci-scope.node-test.mjs`(4/4) 통과.
`TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@localhost:<전용포트>/nomorevibe_test
npm run test:integration -- --shard=N/3`을 각 shard의 독립 PostgreSQL 17 DB에서
실행했다. 1/3: 34파일 323개 통과, 2/3: 33파일 271개 통과,
3/3: 33파일 352개 통과·1 TODO. 테스트 DB는 로컬 컨테이너
`nmv-deploy-speed-db`(55445), `db2`(55446), `db3`(55447)에 격리했다.
전체 기존 suite를 수정 전 새 DB에서 실행했을 때 11건 실패했고, 공통 초기화가
감사 행을 남겨 뒤 테스트의 제품 ID에 붙는 것과 호스트/DB 시계 경계의 fixture
불안정을 재현했다. 중앙 초기화에 감사 campaign을 넣고 두 fixture 시각을
1초 이전으로 고쳐 세 shard 재실행을 통과시켰다. `vitest list --shard`는
분할 목록을 보여주지 않아 검증 근거로 쓰지 않았다.

기존 Dokploy `GHCR-deppy` 등록의 실제 `docker login`은 거부됐다. Dokploy
registry 연결 API의 성공 응답은 pull 인증 검증이 아니었다. 현재 로컬 `gh auth`
계정의 토큰으로 임시 Docker config 로그인은 성공했지만 운영 registry 자격 정보는
아직 교체하지 않았다. 이미지가 올라오면 양 서버의 실제 pull을 확인한 뒤 전환한다.

## Remaining work / exact commands for the next agent

diff/계획을 최종 확인한다. 커밋·PR을 열어 hosted
CI의 `check`와 분할 시간을 측정한 뒤 병합한다. main의 두 이미지 build, digest,
GHCR pull 인증을 확인하고 예비→주→웹 순서로 운영 전환한다. 문서만 바뀌는 후속 PR에서
빠른 필수 `check`를 실측한다. 각 단계 뒤 실제 이미지/커밋, 웹 health, failover
readiness와 처리 진행을 확인하고 이 파일의 결과를 갱신한다.

```sh
cd /private/tmp/nmv-deploy-speed-20260929
git status --short --branch
actionlint .github/workflows/ci.yml
node --test scripts/ci-scope.node-test.mjs
git diff --check
gh secret list --repo JRVector9/nomorevibe
gh run list --repo JRVector9/nomorevibe --workflow ci.yml --limit 5
```

---

# 2026-09-29 15:47 KST — 500스타 이상 자동 승인 배포 완료

## Current objective / completed work / modified files

사용자 승인대로 공개·비포크·비보관 GitHub 저장소의 최신 원본에서 500스타 이상이면
일반 규칙과 AI 심사를 거치지 않고 승인·발행한다. 관리자 설정 범위는 500–10,000,000이고
과거 스타 상한은 판정에서 제거했다. 설계·구현·테스트는 PR #231로 main
`e232f16a79e7db8e3b9abdfc79aadf717041795f`에 병합했다. 이전 단계의 세부 수정
파일 목록은 아래 15:11 KST 기록을 따른다. 이번 단계의 새 수정 파일은
`docs/operations/2026-09-29-star-auto-approval-rollout.md`, `PENDING.md`, 이 파일이다.
루트 checkout의 사용자 변경과 DB 서버·스트리밍 설정은 건드리지 않았다.

## Key decisions / test commands and results / failed approaches

publisher·reviewer·crawler mini 예비→M3 주→웹 mini→M3 순서로 8개 앱을 배포했고
모두 최신 deployment `done`/같은 main 커밋이었다. 공개 `/api/health`는
`status:ok/db:ok`/같은 release였다. 운영 DB `scripts/check-failover-readiness.ts`는
06:36:58과 06:38:32 UTC에 종료 코드 0/전체 `ok`였다. PR CI의 `check`·GitGuardian과
main CI의 `check`가 성공했다. 최종 로컬 단위 1,274건, 통합 946건/기존 TODO 1건,
typegen·tsc·lint·build 종료 코드 0은 이전 단계에서 실제 실행했다.

배포 전 읽기 전용 계획 92건 중 1건이 자연 발행돼 배포 후 계획은 91건이었다.
새 계획·DB 식별값과 저장된 GitHub ID 별칭/기발행 중복 0건을 확인한 뒤 89건을
재수집 대기로 적용했다. 2건은 그 사이 변경돼 건너뛰었다. 재계획·재적용도
건너뛰어 조사한 결과 두 건 모두 기존 제품 URL과 겹쳤다. 별도 재발행은 하지 않았다.
06:46 UTC 초기 92건 중 88건 발행, URL 중복 2건·보관 저장소 1건 거부,
GitHub 404/오래된 원본 1건이 `new`/frontier `skipped`였다. 발행 88건의
GitHub ID별 중복 제품은 0건이고 118,660스타 저장소도 발행됐다.
운영 기록에 시각·범위를 남겼다.

PR CI는 6분 27초, main CI는 5분 3초(배포와 병행), 앱 8개 순차 완료는
4분 7초였다. main CI에서 통합 테스트 3분 24초가 최장 단계였다.
`Dockerfile`의 web/worker target을 8개 Dokploy 앱이 Git 소스에서 각자 빌드한다.
배포 시간 단축의 우선순위는 중복 main CI 대기 제거, 통합 테스트 병목 개선,
동일 커밋 이미지 2개를 한 번씩 빌드해 digest로 재사용이다. 실제 설정 변경은
하지 않았다.

## Remaining work / exact commands for the next agent

24시간 동안 새 후보의 신선 원본·중복·발행 오류를 관측한다. GitHub 404로
`new`에 남는 후보의 표시/정리 정책은 별도 설계가 필요하다. 문서 변경은 아직
main에 반영되지 않았다. 아래 순서로 `git diff --check` 후 문서 커밋·PR·CI·병합한다.
운영 DB를 다시 적용하지 않는다.

```sh
cd /private/tmp/nmv-github-auth-fallback
git diff --check
git status --short --branch
gh pr view 231 --json state,mergeCommit,statusCheckRollup
python3 /tmp/nmv-health-20260925.py status
curl -fsS https://nomorevibe.brut.bot/api/health
```

---

# 2026-09-29 15:11 KST — 500스타 이상 자동 승인 정책 (검증 및 배포 당시 진행 중)

## Current objective

사용자가 승인한 정책을 구현한다: 공개 GitHub 저장소의 최근 원본에서 500스타 이상을 확인하면
10만 스타 이상을 포함해 규칙의 제품 적합성·AI 1차/2차 심사 없이 발행한다. 관리자에서 500 이상
기준을 조정하고, 이전 스타 상한은 판정에서 제거한다. 미발행 기존 후보도 새 GitHub 응답을
다시 받은 뒤 판정한다. 루트 checkout의 사용자 변경과 DB 서버·스트리밍 설정은 건드리지 않는다.

## Completed work / Modified files

분리된 `/private/tmp/nmv-github-auth-fallback` 작업 트리의 `feat/star-auto-approval` 브랜치에
설계 문서 커밋 `748b191`이 있다. 구현은 아직 커밋 전이다. 주요 수정은 다음과 같다.

- 설정/관리자: `lib/crawl/settings-schema.ts`, `lib/crawl/settings.ts`, `app/admin/SettingsForm.tsx`,
  `app/admin/actions.ts`. 기본 자동 승인 500, 관리 범위 500–10,000,000, 과거 상한 UI/드리프트 제거.
- 판정/검수/발행: `lib/crawl/star-auto-approval.ts`, `lib/crawl/rules.ts`, `lib/crawl/jobs/judge.ts`,
  `lib/crawl/repository.ts`, `lib/crawl/agent-review-{repository,contract}.ts`,
  `lib/crawl/jobs/{agent-review,publish}.ts`, `lib/crawl/publish.ts`, `lib/crawl/admin-review.ts`,
  `lib/domain/products/recheck.ts`. 판정·관리자 화면·AI 대상 조회·발행 후보 조회가 같은
  검증 자료를 사용하고, 발행 트랜잭션에서 재확인한다. 발행 지연/기준 변경 시 재수집/재판정한다.
- 기존 후보: `lib/crawl/reconsider.ts`, 새 `scripts/reconsider-star-auto.ts`. 읽기 전용 계획과
  지문·정책·중복 재확인 후 재수집 적용. 최종 읽기 전용 운영 계획은 자동 후보 92건
  (거부 59, 보류 33; 517–116,862스타)이다. 92건 중 동일 GitHub ID의 다른 원본 또는
  동일 ID로 이미 발행된 제품은 0건이었다. 아직 적용하지 않았다.
- 테스트: `tests/star-auto-approval.test.ts`, `tests/crawl-rules.test.ts`,
  `tests/crawl-settings-{form,drift}.test.ts`, `tests/agent-review-contract.test.ts`,
  `tests/review-pipeline-equivalence.test.ts`, `tests/integration/{crawl-fetch,crawl-judge,
  review-publication-gate,admin-review-causes,product-recheck,reconsider-installable,
  settings-drift}.test.ts` 등.
- 문서: `README.md`, `docs/operations/independent-workers-runbook.md`,
  `docs/superpowers/specs/2026-09-29-star-auto-approval-design.md`, 이 handoff.

## Key design decisions

GitHub REST 원본의 숫자 ID·정수 스타·일치하는 full_name·공개·포크 아님·보관 아님·24시간 내
수집을 모두 확인한다. 후보 marker만으로 발행하지 않는다. 관리자 결정, 중복/차단 제품과
원본/설정 경합은 기존 잠금으로 보호한다. 홈페이지가 없으면 공식 GitHub 저장소 URL을 쓴다.
`maxStars`는 저장된 과거 JSON 호환 필드로만 남기고 판정에는 쓰지 않는다. 기존 후보 적용은
오래된 스타 수로 즉시 승인하지 않고 재수집을 요구한다. 자동 승인 자료가 만료되면 발행 워커가
프론티어에 재수집을 넣고 새 원본 이후 판정하도록 한다.

## Test commands and results

- `npm test -- --silent`: 160파일, 1,274/1,274 통과(최신 코드에서 실행).
- `npm run test:integration`: 최종 100파일, 946 통과/1 TODO. 중간 재실행 1실패는 새
  테스트가 앞선 사례의 프론티어 항목을 집은 격리 문제였고 `beforeEach` 정리 후 전체
  재실행 통과. 집중 실행 `review-publication-gate.test.ts` 23/23 통과.
- `npx next typegen`, `npx tsc --noEmit -p .`, `npm run lint`, `git diff --check`,
  `npm run build`: 종료 코드 0. lint의 기존 vendor 미사용 변수 경고 1건과 빌드의 기존
  `agent-review.ts` 동적 파일 추적 경고 1건만 있다.
- 운영 DB 읽기 전용 `scripts/reconsider-star-auto.ts --plan`: 종료 코드 0,
  `examined=92`, `eligible=92`, DB 식별값 포함.
  `.crawl-samples/star-auto-plan-identity-20260929.json` 생성. 별도 읽기 전용 대조에서
  92건의 GitHub ID 별칭/기발행 ID 충돌/ID 누락은 모두 0건.

## Failed approaches / Remaining work

초기 CLI 계획 실행은 DB pool이 프로세스를 열어둬 시간 초과했다. 명시적 종료를 추가하고
운영 읽기 전용 계획을 다시 실행해 정상 종료를 확인했다. 관리자 화면이 순수 `judge`를
호출해 자동 승인 결과와 어긋나던 문제는 공통 저장 원본 판정으로 고쳤다. 저장소 ID만 바뀔 때
재판정하지 않던 문제는 원본 변경 검출에 ID/full_name/private을 추가해 고쳤다.

다음 단계: 변경 검토 및 커밋, PR 생성·최신 main CI 통과·병합,
웹·crawler·reviewer·publisher 주/예비 동기 배포, 배포 후 새 계획 작성·기존 후보 적용,
운영 처리/발행/중복/worker 상태 확인. 운영 DB 스키마 변경 없음.

## Exact commands for the next agent

```sh
cd /private/tmp/nmv-github-auth-fallback
npm run test:integration
npx tsc --noEmit -p .
npm run lint
npm run build
git diff --check
git status --short --branch
gh auth status
```

---

# 2026-09-29 12:16 KST — GitHub 401 계정 전환 수정

## 현재 목적 / 완료 작업 / 수정 파일

사용자는 수집 중 한 PAT가 만료되어 GitHub REST가 401을 돌려줄 때 응답 이유를
검토하고 제한적으로 재시도한 뒤 다른 계정으로 즉시 전환하도록 요청했다. 별도 작업 트리
`/private/tmp/nmv-github-auth-fallback`의 `fix/github-auth-fallback`에서 원인을 재현하고
요청 함수, 수집 큐, 관련 GitHub 갱신 작업과 회귀 테스트를 수정했다. PR #229의
최신 base CI와 GitGuardian 성공 후 main `202f16db532d3ecea6366f7309a7d1692c822031`에 병합하고
crawler mini 예비→M3 주를 같은 SHA로 배포했다.
루트 checkout의 사용자 변경·운영 DB 서버/streaming·중단된 `product-intro-check`는 건드리지 않았다.

수정 파일: `lib/crawl/github{,-quota}.ts`, `lib/crawl/jobs/{fetch,seed}.ts`,
`lib/crawl/readme-refresh.ts`, `lib/domain/evidence/agents/collect.ts`,
`lib/domain/evidence/providers/github.ts`,
`lib/jobs/products/{agent-evidence-refresh,stars-refresh}.ts`, 해당 단위·통합 테스트,
`docs/operations/independent-workers-runbook.md`, `PENDING.md`, 이 문서.

## 핵심 설계 결정 / 실제 시험 / 실패 접근

401 JSON 본문을 크기 제한 안에서 읽어 `expired`·`revoked`·`bad_credentials`·
`unauthorized`만 기록한다. 같은 토큰에 100ms·250ms 뒤 최대 두 번 재시도하고,
반복 실패 또는 401 뒤 일반 403이면 SHA-256 키로 기존 `rate_limits`에 15분 보류한다.
토큰 값이나 원문 오류는 기록하지 않는다. 다른 계정으로 즉시 전환하며, 모든 토큰이
거부되면 풀을 약 1분 뒤 다시 확인한다. 프론티어 claim은 실패 횟수를 소모하지 않고
되돌린다. 새 PAT는 새 해시 키라 보류된 기존 PAT와 독립이다. secondary 한도는 기존처럼
전체 계정에 공유하고 일반 권한 403은 다른 토큰으로 자동 전환하지 않는다.

TDD로 첫 401 전환 테스트와 전체 토큰 거부 시 fetch/seed 보류 테스트를 실패시킨 뒤
수정했다. 401→403, 일시 401 회복, 공유 cooldown, README·agent evidence·GitHub
근거·스타 갱신의 재개 시각도 각각 테스트했다. `npm test` 159파일 1,267/1,267,
관련 통합 6파일 73/73, `npx next typegen`, `npx tsc --noEmit`, `npm run lint`,
`npm run build`, `git diff --check` 통과. lint에는 기존 vendor 파일의 미사용 변수
경고 1건, build에는 기존 `agent-review.ts` 동적 filesystem tracing 경고 1건이 있다.
관련 테스트의 초기 전체 단위 실행 1건 실패는 새 테스트가 앞 테스트의 `mockResolvedValueOnce`
잔여 값을 공유한 탓이었다. `beforeEach`에서 mock 구현을 초기화한 뒤 전체 재실행은 통과했다.
운영 PAT를 실제로 만료·폐기해 보는 장애 주입은 하지 않았다. GitHub Actions 전체 CI
`check`와 GitGuardian이 통과했다.

03:26 UTC 배포 전 프론티어 108,919·원본 108,910, crawler 주 lease는 구 SHA였다.
mini 예비 03:26:43, M3 주 03:27:45 UTC 배포 완료 후 두 후보가 같은 새 SHA의
`active/standby`, lease owner는 M3였다. `check-failover-readiness.ts`는 종료 코드 0,
다섯 역할과 scheduler 2복제본·진행 상태 모두 `ok`였다. 03:31 UTC 첫 검색 주기는
21건을 새로 발견했고 `crawl-fetch`가 20건 원본·후보를 저장했다. 1건은 기존
GitHub ID의 새 경로라 `skipped/alias_of`로 끝났고 새 문서가 없었다. 기존 ID 중복
초과 행은 305건으로 증가하지 않았다. `crawl-seed`와 `crawl-fetch`는 최근 성공,
`last_error=null`, 인증 보류 활성 행은 0개였다. 공개 웹 헬스는 `status:ok/db:ok`.
[운영 기록](operations/2026-09-29-github-auth-fallback-rollout.md)에 상세 시각을 남겼다.

## 남은 작업 / 정확한 다음 명령

실제 운영 PAT를 만료·폐기하는 장애 주입은 수행하지 않는다. 자연 만료가 발생하면
`github.auth_rejected` 사유 코드, 계정별 보류·다른 계정 수집 지속, 관리자 교체 후
재개를 확인한다. 기존 중복 제품 정리와 24시간 quota·수집량 관측은 `PENDING.md`를 따른다.
코드-only 변경이며 운영 DB 마이그레이션은 없었다.

```sh
cd /private/tmp/nmv-github-auth-fallback
git diff --check
git status --short --branch
gh pr view 229 --json state,mergeCommit,statusCheckRollup
python3 /tmp/nmv-health-20260925.py status
curl -fsS https://nomorevibe.brut.bot/api/health
```

---

# 2026-09-29 09:04 KST — GitHub 수집 PAT 관리자 기능 운영 완료

## 현재 목적 / 완료 작업 / 수정 파일

사용자가 클립보드에 둔 두 번째 실제 GitHub 계정 PAT로 관리자 등록·교체 및 수집
사용을 확인했다. 기능 PR #225는 최신 base의 CI `check`와 GitGuardian 성공 후
main의 `0dbbf21489a779582018e3597ebab55492b115a4`로 병합됐다. 운영 앱 DB에
가산 마이그레이션 0053을 적용했고 웹 M3·mini, crawler M3 주·mini 예비 네 앱에
같은 전용 암호화 키와 병합 SHA를 배포했다. DB 서버·스트리밍 설정은 바꾸지 않았다.
이 기록 단계에서 수정한 파일은 `docs/CODEX_HANDOFF.md`,
`docs/operations/2026-09-29-github-collector-accounts.md`, `PENDING.md`,
`docs/superpowers/plans/2026-09-29-github-pat-pool.md`이다. 루트 checkout의 사용자
변경과 중지된 `product-intro-check`는 보존했다.

## 핵심 설계 결정 / 실제 시험 / 실패 접근

기존 crawler 환경 `GITHUB_TOKEN`을 유지하면서 DB에 등록된 다른 계정을 함께
회전시킨다. PAT는 GitHub 숫자 사용자 ID로 식별해 동일 계정 등록은 교체하며,
전용 키로 암호화해 저장한다. 관리자 화면·로그에는 원문과 암호문을 표시하지 않는다.
primary core 한도 소진 시 다음 계정으로 전환하고 secondary cooldown은 전 계정에
공유한다. 계정별 GitHub 사용량과 전체 원본 저장량은 다른 단위로 표시한다.

클립보드 PAT의 `/user`는 `lollol-jr`/ID `227736397`로 기존 `JRVector9`와
달랐고, `/rate_limit`은 core 5,000/시간이었다. 공개 저장소·저장소 검색·커밋
검색이 모두 HTTP 200이었다. 운영 관리자 폼에서 등록과 명시적 동일 계정 교체를
각각 수행해 HTTP 200/성공 문구/새로고침 후 계정 1개를 확인했다. 운영 DB에는
활성 계정 1행과 길이 164자의 암호문만 확인했다. 앱 수집 코드로 DB 복호화 후
공개 저장소 `octocat/Hello-World` 조회 HTTP 200도 확인했다. 새 계정 core
잔여량이 4,884→4,808로 줄고 관측 시각이 갱신돼 배포 수집기가 계정을 실제
사용 중이었다. 1시간 quota reset 이후 관리자 교체 화면은 5,000 잔여를 보였다.
원본 총수는 108,406→108,445로 39건 증가했다. `crawl-fetch`는 최근 성공했고
M3 crawler lease가 활성, mini는 배포 완료된 예비다. 두 공개 웹 헬스체크는
각각 새 SHA에 `status:ok`, `db:ok`였다.

최신 코드의 로컬 `npm test`는 159파일 1,256/1,256, 전용 DB 통합 시험은
2파일 3/3 통과했다. `next typegen`, `tsc --noEmit`, 수정 파일 ESLint,
`npm run build`도 통과했으며 기존 `agent-review.ts` 경고 1건이 있었다.
PR CI의 lint·unit·integration·build와 GitGuardian이 모두 성공했다.
처음 `gh run watch`는 별도 `gh` 로그인 계정의 core 5,000회 소진으로 403이었고,
새 PAT로 읽기 전용 CI를 확인했다. 로컬 DB 연동 조회의 첫 실행은 결과 후 열린
DB 풀 때문에 프로세스가 20초에 종료되지 않아 timeout 났다. 결과 출력 후
명시적으로 종료한 재실행은 HTTP 200이었다. 실제 PAT 값은 어떤 출력·파일에도
남기지 않았다.

## 남은 작업 / 정확한 다음 명령

실제 한 계정의 primary 한도 소진을 기다린 자동 계정 전환과 24시간 quota·수집량
관측은 남는다. 단위 테스트에서는 primary·secondary·모두 소진 경로를 검증했다.
새 계정 PAT 만료 전에 관리자에서 교체하고, 암호화 키 회전 때는 저장된 모든 PAT를
새 키로 안전하게 재암호화해야 한다. 운영 키는 Dokploy 네 앱과 이 머신의 Keychain
`nomorevibe/github-collector-secret`에 보관돼 있다. 값은 출력하지 않는다.

```sh
cd /private/tmp/nmv-github-token-pool
gh pr view 225 --json state,mergeCommit,statusCheckRollup
python3 /tmp/nmv-github-pat-deploy.py status 0dbbf21489a779582018e3597ebab55492b115a4 crawler-m3
python3 /tmp/nmv-github-pat-deploy.py status 0dbbf21489a779582018e3597ebab55492b115a4 crawler-mini
python3 /tmp/nmv-pat-verify.py
curl -fsS https://nomorevibe.brut.bot/api/health
git status --short --branch
git diff --check
```

---

## 2026-09-29 — GitHub 저장소 ID 중복 차단 작업 (진행 중)

### Current objective / 완료한 작업

사용자는 두 GitHub 계정 수집이 겹치는지·수집량이 늘었는지 확인한 뒤 수정할 것을 정리해 수정하라고 요청했다.
운영 코드는 한 활성 crawler가 계정을 요청별로 번갈아 사용한다. `owner/name` 중복은 프론티어에서
막지만 이름 변경 뒤 같은 GitHub 숫자 ID가 새 경로로 다시 저장되는 결함을 확인했다.
읽기 전용 운영 조회 당시 원본 299 중복 ID 그룹·초과 행 304개, 그중 발행 제품이 둘 이상인 그룹
16개였다. 새 토큰 투입 뒤에도 이름 변경으로 새 경로 2개가 들어왔으며 계정 간 동시 작업 때문이라는
근거는 없다. 기존 발행 제품 자동 병합 여부를 사용자에게 비동기 질문했고 답변을 기다리는 중이다.

별도 작업 트리 `/private/tmp/nmv-github-identity-dedup`의 `fix/github-identity-dedup` 브랜치에서
`getRepo`의 안전한 숫자 ID 검증, `crawl_documents` ID 조회 인덱스, `crawl_frontier.alias_of`,
같은 ID 트랜잭션 자문 잠금과 새 별칭 원본 저장 차단, 별칭 로그/skip 처리를 구현했다.
기존 중복 원본·후보·제품은 삭제하지 않는다. 배포·운영 DB migration은 아직 하지 않았다.

### Modified files / 설계 결정

`lib/crawl/{github.ts,repository.ts,jobs/fetch.ts}`, `lib/db/crawl-schema.ts`,
`drizzle/0054_crawl_github_identity_lookup.sql`, `drizzle/meta/_journal.json`,
`tests/github-request-boundary.test.ts`, `tests/integration/crawl-github-identity.test.ts`,
`README.md`, `docs/operations/independent-workers-runbook.md`, `PENDING.md`, 이 문서.
기존 304행은 발행·심사 참조가 있으므로 보존한다. 새 별칭은 기존 원본의 ID와 대조하여
프론티어에 `skipped/alias_of`만 기록한다. 동시 별칭 저장은 GitHub ID별 DB 자문 잠금으로 직렬화한다.
GitHub ID 누락/불안전 응답은 원본 수집 실패로 분류한다. 새 토큰만으로 수집량 증가를 단정하지 않으며
검색 10분 주기와 대기열 상태는 이번 수정 범위에서 바꾸지 않았다.

### Tests and results / failed approaches

- 새 통합 테스트는 수정 전 2/3 실패(새 경로 중복 저장·동시 저장), 구현 후 3/3 통과했다.
- GitHub ID 누락 테스트는 수정 전 실패했고 null 응답 추가 테스트도 예외를 재현한 뒤 수정해 14/14 통과했다.
- 관련 통합 4파일 71/71, 전체 단위 159파일 1257/1257, `npx drizzle-kit check`, 대상 ESLint,
  `npx tsc --noEmit`, `npm run build`는 성공했다. 빌드의 기존 Turbopack 동적 filesystem 경고는 남았다.
- 전체 통합 99파일은 98파일 통과, 1파일 실패(928 passed, 1 failed, 1 todo)였다.
  `tests/integration/product-audit.test.ts:163`의 gateway 미호출 기대가 실패했고,
  변경 전 다른 작업 트리에서도 같은 단일 테스트 실패를 재현했다. 이번 중복 차단의 회귀가 아니다.
- 첫 빌드는 작업 트리 밖 `node_modules` 심볼릭 링크를 Turbopack이 거부해 실패했다.
  링크를 해제하고 `npm ci --ignore-scripts`로 작업 트리 안에 설치한 뒤 빌드 성공했다.

### 운영 적용 / 남은 작업

PR #227의 GitGuardian·CI `check`가 모두 통과했고 main `f305a6b21d575c53af515ec0debd3e9f491460c7`로
병합됐다. 0054 앱 마이그레이션을 운영 DB 직접 연결로 한 번 적용했고 `alias_of` 컬럼과
ID 조회 인덱스를 읽기 전용으로 확인했다. crawler mini 예비 → M3 주, web mini → M3 순서로
네 앱을 같은 SHA로 배포했다. 두 웹의 공개 `/api/health`는 `ok/db:ok`, crawler role lease는
M3 주/new SHA였고 `crawl-fetch` 최근 성공·오류 없음·대기열 0을 확인했다.
01:33 UTC 운영 기준 기존 중복은 300그룹·초과 행 305개였다. 직전 추가된 1개는 새 코드 배포
이전 01:12 UTC에 저장됐다. 자연 유입되는 새 이름 변경 별칭이 아직 없어 운영 분기(`alias_of`)
자체는 직접 관측하지 못했다. [운영 기록](operations/2026-09-29-github-id-dedup-rollout.md)을 따른다.

사용자의 기존 발행 제품 병합 범위 답변을 확인한다. 답변 없이 공개 제품을 자동 병합·삭제하지 않는다.
운영 DB 서버·스트리밍 설정과 중단된 `product-intro-check`는 건드리지 않는다.

```sh
cd /private/tmp/nmv-github-identity-dedup
git status --short --branch
git diff --check
gh pr view 227 --json state,mergeCommit,statusCheckRollup
python3 /tmp/nmv-github-pat-deploy.py status f305a6b21d575c53af515ec0debd3e9f491460c7 crawler-m3
python3 /tmp/nmv-github-pat-deploy.py status f305a6b21d575c53af515ec0debd3e9f491460c7 crawler-mini
curl -fsS https://nomorevibe.brut.bot/api/health
```

---

# 2026-09-29 08:34 KST — 관리자 GitHub PAT 등록·교체 구현

## 현재 목적 / 완료 작업 / 수정 파일

관리자에서 수집용 GitHub PAT를 등록·교체하고 실제 서로 다른 계정의 수집 한도
전환을 지원하는 작업이다. 별도 worktree `/private/tmp/nmv-github-token-pool`, 브랜치
`feat/github-collector-token-pool`에서 구현했다. 관리자 `/admin/github-accounts`에
계정 등록/교체/활성·중지, core 한도, 최근 1시간 원본·신규 수집 제품 수를 추가했다.
GitHub `/user` 숫자 ID로 계정을 식별하고 PAT를 전용 비밀키로 AES-GCM 암호화해
새 앱 테이블에 저장한다. `githubRequest`는 기존 환경 토큰과 등록 토큰을 회전하며
primary 한도 소진 시 다음 계정으로 전환하고 secondary cooldown은 공유한다.
DB 서버·복제 설정과 중지된 `product-intro-check`는 건드리지 않았다.

수정 파일: `app/admin/AdminNav.tsx`, `app/admin/github-accounts/*`,
`lib/crawl/{github.ts,github-accounts.ts,github-quota.ts,readme-refresh.ts}`,
`lib/db/operations-schema.ts`, `drizzle/0053_github_collector_accounts.sql`,
`drizzle/meta/_journal.json`, `tests/{github-collector-accounts.test.ts,github-token-pool.test.ts,github-quota.test.ts,admin-navigation.test.tsx}`,
`tests/integration/github-quota.test.ts`, `README.md`,
`docs/operations/{independent-workers-runbook.md,production-multi-instance.env.example,2026-09-29-github-collector-accounts.md}`,
`docs/superpowers/plans/2026-09-29-github-pat-pool.md`, 이 handoff.

## 핵심 설계 / 실제 시험 / 실패 접근

기존 `GITHUB_TOKEN`은 운영 이행용으로 유지한다. 등록 계정이 없으면 기존 토큰만
사용한다. 같은 GitHub 숫자 ID를 등록하면 암호문을 교체하고, 명시한 교체 계정과
새 PAT 계정이 다르면 저장을 거절한다. 토큰·암호문을 HTML, 감사 기록, 로그에
표시하지 않는다. 토큰 만료 시 교체는 관리자 화면에서 다시 한다. 등록 계정의
core 한도 헤더를 최대 30초 간격으로 저장한다. 다른 앱이 소비한 API 사용량도
포함되므로 원본 저장 건수와 비율 계산은 하지 않는다.

사용자가 클립보드에 둔 새 PAT는 토큰 값을 출력·파일 저장하지 않고 GitHub에
읽기 요청으로 시험했다. `/user` HTTP 200: `lollol-jr`, 사용자 ID `227736397`로
기존 `JRVector9`와 다르다. `/rate_limit` HTTP 200: core 5,000/시간,
search 30/분. 공개 `octocat/Hello-World` 조회, 저장소 검색, 커밋 검색도 모두
HTTP 200이었다. 같은 클립보드 PAT를 애플리케이션의
`inspectGitHubCollectorToken`으로도 확인해 ID·login·core 5,000을 반환했다.
이 시점 실제 PAT를 운영 또는 시험 DB에 등록하지는 않았다.

TDD에서 새 모듈 import 실패와 풀 테스트의 기존 단일 토큰 강제 오류를 red로
확인했다. 새/기존 GitHub 집중 테스트 45/45 통과, `next typegen`, `tsc --noEmit`,
수정 파일 ESLint, `npm run build` 통과했다. build에는 기존
`agent-review.ts` 동적 파일 접근 경고만 있었다. 첫 전체 `npm test`는 새 화면의
12px 텍스트와 관리자 메뉴 9개 고정 기대 때문에 3건 실패했다. 텍스트를 13px로
고치고 메뉴 테스트를 10개로 갱신한 뒤 전체 159파일 1255/1255 통과했다.
전용 로컬 시험 DB의 마이그레이션 0053과 계정 암호화 저장·교체·비활성화
통합 테스트는 2파일 3/3 통과했다. 시험 계정 행/감사 행은 테스트 후 삭제했다.
`next start`로 전용 시험 DB에 연결한 관리자 페이지를 HTTP 200으로 읽어 제목,
등록 폼, 빈 계정 안내가 렌더링됨을 확인한 뒤 서버를 중지했다.
후속 검토에서 기존 secondary cooldown 행도 새 전역 제한에 포함하고, 여러 계정
전환이 호출자의 단일 timeout 예산을 넘지 않게 고쳤다. 해당 단위 16/16,
secondary 통합 2/2, 타입·ESLint가 통과했다. 운영 앱 DB에는 0053 가산
마이그레이션을 직접 연결로 한 번 적용하고 8개 컬럼·빈 계정 행을 확인했다.
M3·mini 웹과 crawler 주·예비 네 앱에는 동일한 전용 암호화 키를 설정했다.
이 시점 새 PAT는 아직 운영 DB에 등록하지 않았고 앱 새 릴리스도 배포 전이다.

## 남은 작업 / 정확한 다음 명령

PR #225를 만들었고 최신 커밋의 CI `check`가 남았다. 기존 `gh` 로그인 계정의
GitHub core 5,000회 한도가 2026-09-28 23:54:42 UTC까지 소진돼 `gh run watch`는
403이었다. 새 PAT로 읽기 전용 CI 상태 조회는 HTTP 200이며 latest run의 `check`가
진행 중인 것을 확인했다. 운영 전환의 DB 마이그레이션과 네 앱 전용 키 설정은
완료했다. CI 통과 후 PR을 병합하고 같은 릴리스를 웹·crawler 주·예비에 배포한다.
그 다음 관리자에서
새 PAT를 등록하고 계정별 quota 및 원본 증가를 확인한다. 이 전에는 두 계정의
실제 운영 처리량을 검증했다고 주장하지 않는다. 루트 checkout의 사용자 변경은
보존한다.

```sh
cd /private/tmp/nmv-github-token-pool
git status --short --branch
git diff --check
npm test
npx next typegen && npx tsc --noEmit
npx eslint app/admin/github-accounts app/admin/AdminNav.tsx lib/crawl/github.ts lib/crawl/github-accounts.ts lib/crawl/github-quota.ts lib/crawl/readme-refresh.ts lib/db/operations-schema.ts tests/github-collector-accounts.test.ts tests/github-token-pool.test.ts tests/github-quota.test.ts
npm run build
git diff --stat
```

---

# 2026-09-29 08:00 KST — 수집 한도 장애 확인 및 관리자 화면 개선

## 현재 목적 / 완료 작업 / 수정 파일

수집 정체 원인을 운영에서 확인하고, 심사 구간 클릭이 해당 구간의 후보만 표시하도록
고쳤다. 처리 속도가 0이어도 각 카드에 워커 관측·실행 가능 일감·재시도 예약·오류
상태가 직접 나오도록 했다. 별도 기술 검토는
`docs/operations/2026-09-29-github-collector-accounts.md`에 기록했다.
수정 파일은 `app/admin/review/{page.tsx,stages.ts}`,
`app/admin/status/{ThroughputStrip.tsx,throughput.module.css}`,
`lib/operations/{throughput-model.ts,throughput.ts}`,
`tests/{review-stages.test.ts,operations-throughput-display.test.ts}`와 위 문서, 이 handoff다.
깨끗한 작업 공간 `/private/tmp/nmv-stage-runtime-ui`의
`feat/review-stage-runtime-status`에서 작업했다. 루트 checkout의 사용자 변경은 보존했다.

## 핵심 설계 / 실제 테스트 / 실패 접근

구간 링크는 과거 검색·상세·기간·정렬을 모두 버리고 `stage`만 남기며 목록 앵커로
이동한다. 목록 자체의 기존 구간 SQL 조건은 유지했다. 수집 재시도 예약 건수는
기존 집계 `extra`를 fetch 구간에만 전달하고, 워커 생존 이상은 대기 0보다 우선해
보여준다. 0건 저장이 워커 중단을 뜻하지 않도록 상태를 분리했다.

운영 읽기 전용 관측에서 22:39:57 UTC GitHub `core` primary 한도 소진,
22:53:40 UTC 초기화, 22:54:45 UTC 원본 저장 재개를 확인했다. 원본 총수는
22:54:46 UTC 108,189건에서 22:59:53 UTC 108,248건으로 증가했다.
22:59:53 UTC 현재 수집 계정 `JRVector9`의 `/rate_limit`은 core 609/5,000 사용,
4,391 잔여였다. OAuth 관리자 로그인 토큰은 현재 저장되지 않고 운영 수집은
환경 `GITHUB_TOKEN` 하나를 사용한다.

`vitest run tests/review-stages.test.ts tests/operations-throughput-display.test.ts`는
새 테스트 4건의 red를 확인한 뒤 16/16 통과했다. 해당 파일 ESLint와
`next typegen` 후 `tsc --noEmit`은 통과했다. `npm run build`는 정상 의존성을
설치한 뒤 통과했으며 기존 `agent-review.ts` 동적 파일 접근 경고 1건이 있었다.
첫 build는 임시 작업 공간에서 다른 작업 공간의 `node_modules`를 가리킨
심볼릭 링크가 Turbopack 파일시스템 경계 밖이라 실패했다. 링크를 풀고
`npm ci --ignore-scripts --no-audit --no-fund`로 해당 공간에 설치해 해결했다.

## 남은 작업 / 정확한 다음 명령

diff 검토와 PR, 최신 base CI `check`, 병합·운영 웹 배포 확인이 남았다.
수집 계정 연결/암호화 저장/토큰 풀/계정별 한도 및 저장 성과 지표는 구현되지 않았다.
위 설계 문서를 따라 별도 작업으로 구현하고 실제 두 번째 계정 연결 후 운영 전환을
시험해야 한다. DB 서버·복제 설정은 변경하지 않는다. 사용자가 중지한
`product-intro-check`도 재개하지 않는다.

```sh
cd /private/tmp/nmv-stage-runtime-ui
git diff --check
node_modules/.bin/vitest run tests/review-stages.test.ts tests/operations-throughput-display.test.ts
node_modules/.bin/next typegen && node_modules/.bin/tsc --noEmit
npm run build
git status --short
git add app/admin/review/page.tsx app/admin/review/stages.ts app/admin/status/ThroughputStrip.tsx app/admin/status/throughput.module.css lib/operations/throughput-model.ts lib/operations/throughput.ts tests/review-stages.test.ts tests/operations-throughput-display.test.ts docs/operations/2026-09-29-github-collector-accounts.md docs/CODEX_HANDOFF.md
git commit -m 'feat: clarify review stage and worker runtime status'
git push -u origin feat/review-stage-runtime-status
```

---

# 2026-09-29 01:43 KST — 이번 단계 종료 상태

## 현재 목적 / 완료 작업 / 수정 파일

워커 장애 시 주·예비 감시와 maintenance 실제 처리량을 보강하고 기존 역할 인계를
재검토했다. 코드 PR #219, #220과 운영 기록 PR #221, DB 격리 복원 기록 PR #222는
모두 main에 병합됐다. #222는 최신 base의 CI `check`와 GitGuardian 성공 후
merge SHA `1229c2597235a6a6c528fc3a827e9c7e3aab329c`가 됐다. 운영 DB는 이미
별도로 구성돼 있으며 이번 워커 failover 작업에서 설정·역할·운영 데이터를 바꾸지 않았다.
이번 후속 변경 파일은 `docs/CODEX_HANDOFF.md`뿐이다. 루트 checkout의 사용자 변경과
중단된 `product-intro-check`는 보존했다.

## 핵심 판단 / 테스트 / 실패 접근

운영 DB의 주·복제 스트리밍과 WAL 아카이브를 읽기 전용으로 확인했고, 운영 primary에서
새 논리 백업을 로컬 격리 DB에 복원해 주요 행·마이그레이션과 실제 OG 이미지 바이트를
대조했다. replica dump 첫 시도는 hot standby recovery conflict로 실패했고 primary
재시도는 `pg_restore --exit-on-error` 종료 코드 0이었다. 로컬 시험 DB는 삭제했다.
기존 보관 백업의 복원 성공이나 DB 자동 승격은 이 시험으로 주장하지 않는다.
PR #222의 CI `check`와 GitGuardian은 실제 통과했다. 이번 후속 문서의
`git diff --check`는 커밋 전에 실행한다.

## 남은 작업 / 정확한 다음 명령

운영 monitor는 코드만 main에 있고 Kuma Push/알림 수신자 및 별도 앱이 아직 없다.
Kuma 로그인 경로와 알림 대상이 확인되면 기존 접속 설정으로 monitor를 연결해
예비 중단 DOWN/복귀 UP과 감시자 자체 timeout을 실제 확인한다. 이어 mini 전체 장애의
독립 deadman, publisher 예비 신규 발행, 실제 저장 정체·반복 부팅 격리,
maintenance 6시간 backlog 장기 회복과 24시간 관측을 진행한다. DB 설정 작업은
여기서 수행하지 않는다. DB 관련 미검증 경계는 `PENDING.md`와
`docs/operations/2026-09-29-db-restore-verification.md`를 따른다.

```sh
cd /private/tmp/nmv-uptime-capacity
git status --short --branch
git diff --check
gh pr view 222 --json state,mergeCommit,statusCheckRollup
rg -n 'monitor|Kuma|deadman' PENDING.md docs/operations/independent-workers-runbook.md
```

---

# 2026-09-29 01:35 KST — 기존 DB 구성 확인·격리 복원 기록

## 현재 목적 / 완료 작업 / 수정 파일

사용자는 남은 워커 failover 작업과 기존 구현 재검토를 요청했고, DB는 이미 별도로
구성됐으므로 DB 서버 설정은 건드리지 말라고 명확히 했다. 이 방향을 따른다.
독립 감시 PR #219와 maintenance 용량 PR #220, 용량 운영 기록 PR #221은 각각
필수 CI 후 main에 병합됐다. maintenance M3 주·mini 예비는 같은 SHA `ce64737`와
60/6 설정으로 운영 중이며 마지막 직접 확인에서 M3 active/mini standby였다.
기존 다섯 역할은 모두 주·예비 후보와 lease가 일치했다.

이번 문서 단계는 `PENDING.md`, 신규
`docs/operations/2026-09-29-db-restore-verification.md`, 이 handoff를 수정한다.
별도 worktree `/private/tmp/nmv-uptime-capacity`의
`docs/db-restore-verification-20260929` 브랜치에서 진행하고 루트 checkout의 사용자
변경과 중단된 `product-intro-check`는 보존한다.

## 핵심 판단 / 실제 테스트 / 실패 접근

- 운영 DB primary/replica는 이미 Patroni 스트리밍이다. 읽기 전용 당시 복제 lag
  0바이트, WAL 아카이브 on/실패 0건을 확인했다. 서버 설정·운영 데이터 변경은 없다.
- replica의 새 논리 dump를 로컬 격리 DB로 스트리밍한 첫 시도는
  `crawl_review_attempts`의 hot standby recovery conflict로 실패했다. 로컬 부분
  복원 DB를 버리고 primary에서 다시 `pg_dump -Fc --no-acl --no-owner`를 스트리밍해
  `pg_restore --exit-on-error` 종료 코드 0으로 복원했다.
- 원본/복원은 products 19,894, crawl_documents 107,220, jobs 25,
  migration 53/최대 ID53/hash 집계 일치, `og_images` 19,865행/데이터 총
  2,009,099,011바이트/한 표본 38,948바이트·MD5 일치였다. `media_assets`는
  양쪽 0행이라 그 테이블의 bytea 복원은 검증하지 못했다. 로컬 시험 DB는 대조 후
  `dropdb` 종료 코드 0으로 삭제했다. 기존 보관 백업본 복원·보존 기간·시점 복구는
  시험하지 않았다.
- PR #220의 단위 1,229건·통합 923건, 타입·lint(기존 vendor 경고1)·build와
  Docker monitor build를 이전 단계에서 실제 실행했다. 이번 단계는 문서만 변경하며
  문서 diff-check를 실행한다. 운영 monitor/Kuma 알림 실전 배포는 여전히 미완료다.

## 남은 작업 / 정확한 다음 명령

이 문서 diff를 검토·커밋하고 PR의 최신 main CI `check` 뒤 병합한다. 별도 DB
설정 작업은 하지 않는다. mini Kuma 로그인 경로와 알림 수신자가 확인되면 기존
DB 접속 설정으로 독립 monitor를 연결하고 예비 중단 DOWN/복귀 UP, 감시자 자체
timeout을 검증한다. mini 호스트 장애의 독립 deadman, publisher 예비 신규 발행,
실제 저장 정체/반복 부팅 격리, maintenance 6시간 backlog 장기 회복,
24시간 연속 관측은 남았다. 별도로 관리하는 기존 보관 백업의 복구 가능성은
이번 새 논리 백업 시험으로 증명되지 않는다.

```sh
cd /private/tmp/nmv-uptime-capacity
git status --short --branch
git diff --check
git diff -- PENDING.md docs/CODEX_HANDOFF.md
git add PENDING.md docs/CODEX_HANDOFF.md docs/operations/2026-09-29-db-restore-verification.md
git commit -m 'docs: record isolated database restore verification'
git push -u origin docs/db-restore-verification-20260929
gh pr checks <new-pr-number>
```

---

# 2026-09-29 01:22 KST — maintenance 60/6 단계적 운영 배포

## 현재 목적 / 완료 작업 / 수정 파일

남은 failover 운영 작업과 기존 구현 재검토를 계속한다. 독립 감시 PR #219는 main
`a92e490`, 용량 PR #220는 필수 CI 후 main `ce64737edfc0bfc586fc428c082d060d08e0376e`로
병합했다. monitor 코드는 main에 있지만 별도 앱과 실제 경보는 미배포다. mini Uptime Kuma는
로그인이 필요하고 Keychain의 흔한 이름에서 자격을 찾지 못했다. 사용자에게 로그인 경로와
알림 대상을 비동기로 요청했다.

maintenance는 Dokploy의 mini 예비 앱 `T6ATm-paaE03hfSsQX8-S`, M3 주 앱
`7OlFqQdacbyQseQM72E7b`를 순서대로 SHA `ce64737`에 배포하고 설정을 30/4→60/6으로
증량했다. 현재 두 앱 배포 `done`, 같은 SHA와 60/6, lease epoch 7의 M3 active·mini
standby다. 다른 역할 앱은 옛 SHA `20208d3`이며 각 주·예비가 같은 릴리스로 동작한다.

운영 기록과 현재 미검증 경계를 반영하려고 새 브랜치 `docs/uptime-capacity-rollout`의
`README.md`, `PENDING.md`, `docs/operations/independent-workers-runbook.md`,
`docs/operations/2026-09-29-uptime-capacity-rollout.md`, 이 handoff를 수정했다.
아직 커밋·문서 PR 전이다. 루트 checkout과 중단된 `product-intro-check`는 보존했다.

## 핵심 판단 / 실제 테스트 / 실패 접근

- 30/4에서 tick 30건/6.698초·9.351초·8.819초, 5분 저장 150건,
  `jobs.last_error=null`; M3 컨테이너 healthy, CPU 0.89%, RSS 197.5MiB/1GiB.
- 60/6 배포 전환 중 mini가 epoch 6으로 정상 인계해 60건/15.238초를 저장했다.
  mini를 정상 drain해 M3가 epoch 7로 재획득하고 mini 1복제본을 복원했다.
  M3 tick 60건/10.840초·13.092초·9.274초, 5분 저장 300건, 오류 없음.
  6시간 초과 건수는 13,976→13,628로 줄었다. 수시간의 전체 회복은 미검증이다.
- 기존 다섯 역할은 모두 M3 active·mini standby 신선한 관측과 lease/릴리스 일치.
  publisher 승인 행 17은 적격 발행 큐가 아니며 예비 신규 제품 저장은 미검증.
- 실제 DB 호스트는 V9-Primary `100.99.209.55`, 복제본 V9-Replica
  `100.85.113.10`. 읽기 전용 확인에서 primary `pg_stat_replication`은
  `streaming`/async/lag 0바이트, replica WAL receiver `streaming`이었다.
  `archive_mode=on`, 아카이브 실패0. 백업 복원 시험은 하지 않았다.
- Dokploy API 첫 읽기 명령은 셸 환경변수를 같은 명령에 할당하면서 헤더 확장이 먼저 돼
  401이었다. 다음 호출에서 키를 별도 줄에 읽고 성공했으며 원문 키는 출력하지 않았다.
  M3 컨테이너를 찾을 때 이전 컨테이너 ID로 `docker stats`를 호출해 0B가 나왔고
  현재 컨테이너 ID로 재측정했다. mini scale 0/1은 성공하고 최종 standby를 확인했다.

## 남은 작업 / 정확한 다음 명령

문서 diff-check·커밋·PR·CI를 끝낸다. 60/6을 수시간 관측해 6시간 초과 건수가
실제로 충분히 줄고 tick 예산, DB 연결, CPU/RSS가 유지되는지 확인한다.
Kuma 로그인/알림 대상이 확인되면 read-only DB 자격과 Push monitor를 만들고 별도 M3
monitor 앱, 예비 중단 DOWN/회복과 감시자 자체 timeout을 검증한다. mini 호스트 장애의
독립 deadman, publisher 예비 신규 발행, 실제 저장 정체/반복 부팅 격리,
백업 복원, 24시간 관측이 남았다.

```sh
cd /private/tmp/nmv-uptime-capacity
git status --short --branch
git diff --check
git add README.md PENDING.md docs/CODEX_HANDOFF.md docs/operations/independent-workers-runbook.md docs/operations/2026-09-29-uptime-capacity-rollout.md
git commit -m 'docs: record maintenance capacity rollout'
git push -u origin docs/uptime-capacity-rollout
python3 /tmp/nmv-p3-db-audit.py
python3 /tmp/nmv-p3-db-status.py maintenance
```

---

# 2026-09-29 00:59 KST — 독립 감시 병합·maintenance 용량 증량 준비

## 현재 목적 / 완료 작업 / 수정 파일

남은 워커 failover 작업과 기존 구현 재검토를 진행 중이다. 독립 감시 PR #219는 필수 CI
`check`와 GitGuardian 통과 후 main SHA `a92e490937068ebbce79d5106dcfd5ced140670c`로
병합됐다. 운영 monitor 앱·Kuma Push는 아직 만들지 않았다. mini Kuma의 로그인 화면을
확인했고 접근 경로와 경보 대상에 대한 사용자 응답을 기다리면서 독립 작업을 계속한다.

maintenance 용량은 별도 worktree `/private/tmp/nmv-uptime-capacity`, 브랜치
`feat/uptime-capacity`에서 구현했다. 변경 파일은 `lib/jobs/products/uptime.ts`,
`tests/uptime-config.test.ts`, `tests/integration/uptime.test.ts`, `README.md`, `PENDING.md`,
`docs/operations/independent-workers-runbook.md`,
`docs/operations/2026-09-29-uptime-capacity-preflight.md`,
`docs/superpowers/plans/2026-09-29-uptime-capacity.md` 및 이 handoff다.
루트 사용자의 미커밋 변경과 중단된 `product-intro-check`는 건드리지 않았다.

## 설계 판단 / 실제 테스트 / 실패 접근

운영 읽기 전용 표본에서 웹사이트 19,365곳·6시간 초과 13,976곳·점검 905건/시간.
최근 900건 응답 지연 p50 717ms/p95 2,471ms/최대 6,091ms, 15건 tick 5,626ms다.
6시간 목표는 분당 약 54건이 필요하다. 기본 15건/HTTP 동시3개는 유지하고
환경 상한 60건/동시6개를 추가해 30/4→60/6으로 단계적 측정을 가능하게 했다.
한 origin의 요청과 DB 기록은 각각 직렬, 25초 tick 예산도 유지한다. 설정값만으로
실제 처리량이나 6시간 목표가 달성됐다고 보지 않는다.

- `tests/uptime-config.test.ts` 구현 전 7건 실패→구현 후 7건 통과.
  기존 통합의 증량 시험은 동시3개만 열려 실패→수정 후 24건 통과.
- `npx next typegen`, `npx tsc --noEmit`, `npm test`(155파일/1,229건),
  `npm run test:integration`(96파일/923건·TODO1), `npm run lint`(오류0·기존 vendor
  경고1), `npm run build`, `git diff --check` 통과. 첫 capacity 커밋 `bd874d6`은
  monitor 병합 이전 base였고, `git rebase origin/main`이 충돌 없이 완료됐다.
- mini Kuma는 `http://100.116.119.93:3001/dashboard`의 로그인 화면까지 확인했다.
  비밀번호가 없어 Push monitor 생성이나 실제 경보 발송은 하지 않았다.

## 남은 작업 / 정확한 다음 명령

capacity handoff 변경을 커밋하고 브랜치 푸시→별도 PR의 최신 CI `check`를 통과시킨다.
그 뒤 maintenance 주·예비 같은 이미지 배포와 30/4→60/6 설정 증량, tick/DB/백로그
실측이 필요하다. 독립 monitor는 mini Kuma 로그인/알림 대상과 읽기 전용 DB 자격을
확정한 뒤 운영 앱을 연결해야 한다. publisher 예비 신규 발행, 실제 저장 정체/반복 부팅
격리 주입, 백업 복구, 24시간 연속 관측, mini 장애에서 독립된 deadman도 남았다.

```sh
cd /private/tmp/nmv-uptime-capacity
git status --short --branch
git diff --check
git add docs/CODEX_HANDOFF.md
git commit -m 'docs: hand off uptime capacity rollout'
git push -u origin feat/uptime-capacity
gh pr create --base main --head feat/uptime-capacity --title 'Allow measured uptime check capacity ramp' --body-file /tmp/nmv-uptime-pr-body.md
gh pr checks <new-pr-number>
```

---

# 2026-09-29 00:43 KST — 독립 failover 감시 구현·기존 운영 재검토

## 현재 목적 / 완료 작업 / 수정 파일

사용자가 남은 failover 작업 진행과 이전 구현 재검토를 요청했다. 루트의 사용자 변경을
보존하고 `origin/main` `77612eb`에서 별도 worktree
`/private/tmp/nmv-worker-failover-followup` (`feat/worker-failover-followup`)를 만들었다.
기존 진행 CLI가 최신 주 서비스 하나만 보아 예비 소실을 놓치는 공백을 찾았다.
`lib/operations/failover-readiness.ts`, `failover-monitor.ts`,
`scripts/check-failover-readiness.ts`, `watch-failover-readiness.ts`, `monitor-healthcheck.ts`,
`lib/db/pool.ts`, `Dockerfile`, 관련 단위·통합 시험, README/PENDING/runbook,
설계·계획 및 `docs/operations/2026-09-29-independent-worker-monitor-preflight.md`를 추가/수정했다.
이 시점에 아직 커밋·PR·운영 배포는 하지 않았다.

## 설계 판단 / 테스트 / 실패 접근

DB `localtimestamp`로 후보 관측·lease 나이를 계산하고 M3/mini 5역할 쌍과 scheduler
서로 다른 2복제본을 각각 판정한다. 30초 별도 monitor가 연속 2회 이상일 때 Kuma Push
DOWN, 정상 복귀 때 UP을 전송한다. URL·응답 본문은 오류 로그에 남기지 않는다.
mini 호스트 전체 장애 때 mini Kuma도 죽는 공백과 실제 경보 수신 미검증은 남는다.
운영 monitor의 `CONNECT_AGENT_URL` 설정 여부는 publisher와 같아야 발행 적격 큐가
같이 계산된다. monitor는 해당 URL에 요청하지 않으며 존재 여부만 사용한다.

- 처음 단위 시험은 구현 파일이 없어 실패했고 구현 후 통과. 전용 DB의 정상/예비 70초 지연,
  CLI 경보 종료 코드 2 통과. `npm test`: 156파일/1,235 통과.
  `npm run test:integration`: 97파일/924 통과·TODO1.
- `npx tsc --noEmit` 첫 실행은 새 worktree의 Next `PageProps` 생성물이 없고 시험 fixture
  타입이 부족해 실패했다. `npx next typegen`과 fixture 교정 뒤 타입 검사 통과.
  lint 오류0/기존 vendor 경고1, 웹 build, monitor Docker build, diff-check 통과.
  DB 미설정 이미지의 CLI `unknown`/exit1, healthcheck exit1 확인.
- 운영 읽기 전용에서 다섯 역할 M3 primary/mini standby 모두 신선하고 같은 릴리스,
  lease owner M3였다. 진행 CLI `overall=ok`; crawler 문서·publisher 발행·maintenance
  ping·text 프로필 결과 저장이 최근에도 있었다. 적격 발행 큐는 0이라 예비 새 제품 저장은
  미검증. maintenance는 19,365 웹사이트 중 13,976곳 6시간 초과, 최근 905건/시간이다.
- 운영 scheduler 컨테이너에서 `rg`가 없어 `grep`으로 바꿨다. 관측 JSON 확인에는 영향 없다.
  임시 Node SQL 한 줄은 원격 shell 인용 오류로 실행되지 않았고 어떠한 DB 변경도 없었다.

## 남은 작업 / 정확한 다음 명령

diff와 문서를 다시 확인하고 커밋·PR·필수 CI `check`를 통과시킨다. 운영 알림 수신
경로가 정해지면 전용 읽기 계정/Kuma Push monitor를 연결하고 monitor 앱의 실제 DOWN/UP,
monitor heartbeat timeout을 검증한다. mini 전체 장애에 독립된 deadman, publisher 예비의
적격 새 제품 저장, 실제 진행 정체/반복 부팅 격리, maintenance 용량 개선, 백업 복구와
24시간 관측이 남았다. 중단된 `product-intro-check`는 재개하지 않는다.

```sh
cd /private/tmp/nmv-worker-failover-followup
git status --short
git diff --check
npx next typegen
npx tsc --noEmit
npm test
npm run test:integration
git add Dockerfile README.md PENDING.md lib/db/pool.ts lib/operations/failover-readiness.ts lib/operations/failover-monitor.ts scripts/check-failover-readiness.ts scripts/watch-failover-readiness.ts scripts/monitor-healthcheck.ts tests/failover-readiness.test.ts tests/failover-monitor.test.ts tests/integration/failover-readiness-query.test.ts docs/CODEX_HANDOFF.md docs/operations/independent-workers-runbook.md docs/operations/2026-09-29-independent-worker-monitor-preflight.md docs/superpowers/specs/2026-09-29-independent-worker-monitor-design.md docs/superpowers/plans/2026-09-29-independent-worker-monitor.md
git commit -m 'feat: independently monitor worker failover readiness'
git push -u origin feat/worker-failover-followup
```

---

# 2026-09-28 21:00 KST — P2 병합·운영 장애 복구 시험 완료

## 현재 목적 / 완료 작업 / 수정 파일

사용자의 우선순위에 따라 P0 진행 판정/owner-change 재시도(#213), P1 역할 lease·fencing·
frontier 조기 회수(#214), P2 scheduler 2복제본·crawler/reviewer 주/예비(#215)를 진행했다.
P2 main SHA `2f8a6bb607e622b18ba512415b4004d19f5557e5`. PR #215의 필수 CI
`check`를 통과하고 기존 8개 앱에 배포했다. scheduler는 M3 2복제본, M3
crawler/reviewer는 역할 후보 primary 명령, mini에는 같은 SHA의 별도 standby 앱
2개를 배포해 총 10개 앱이 운영 중이다. 두 standby는 `autoDeploy=false`라 다음
릴리스에 수동 교체가 필요하다. 운영 DB streaming·서버 설정은 수정하지 않았다.

이 단계의 문서 브랜치 `/private/tmp/nmv-worker-failover-ops`에서 `AGENTS.md`,
`README.md`, `PENDING.md`, `docs/operations/independent-workers-runbook.md`,
`docs/operations/2026-09-28-worker-failover-rollout.md`, 이 handoff를 수정했다.
루트 main의 사용자 미커밋 변경과 중단된 `product-intro-check`는 건드리지 않았다.

## 설계 판단 / 실제 테스트 / 실패 접근

- P2 로컬 단위 152파일/1217, PostgreSQL 통합 93파일/906 통과·TODO1, 타입·lint·
  build·diff-check 통과. GitHub Actions `check`도 타입·lint·단위·통합·build 전부 통과.
- 운영 10개 앱 최신 배포 `done`/source SHA 일치. M3·mini 웹 각각 public health
  HTTP200/app+DB ok. scheduler 컨테이너 2개 healthy, 별도 신선한 DB 관측 2개,
  `crawl-fetch` 요청 버전과 next schedule 전진, 최종 진행 판정 `overall=ok`.
- crawler 자식 SIGKILL→Swarm 실패 감지/재시작→M3 주 epoch 1→2, M3 서비스
  0 복제본→mini 예비 epoch 3, M3 재기동·예비 drain→M3 epoch 4. reviewer도 같은
  순서로 epoch 1→2→3→4. 최종 두 주·두 예비 healthy, 주 active·예비 standby.
  reviewer 예비 활성 중 `second-review` requested/processed version 전진.
  자세한 명령·증거·검증 한계는
  `docs/operations/2026-09-28-worker-failover-rollout.md`.
- `gh pr merge 215 --squash --delete-branch`는 원격 merge 뒤 로컬 main이 다른 worktree에서
  사용 중이라 종료1이었다. `gh pr view`와 `git ls-remote`로 원격 병합 SHA를 확인했다.
  후반 GitHub REST API는 사용자 core quota 403으로 실패해 정상 git transport의
  `git ls-remote origin refs/heads/main`으로 소스 SHA를 검증했다. 자격 증명 교체는 안 했다.
- 운영에서 반복 부팅 격리·진행 정체 자동 재시작은 주입하지 않았다. 예비 활성 구간에
  새 적격 결과가 없어 문서/심사 결과 저장 재개도 확인하지 못했다. 로컬 통합은 강제 종료
  뒤 lease 만료를 DB에서 앞당겨 인계했으므로 운영 비정상 재시작 실패의 시간 실측이 아니다.

## 남은 작업 / 정확한 다음 명령

이 문서 변경을 diff-check 후 커밋·PR·CI로 main에 병합한다. 운영 완료 내용은
`PENDING.md`에 미검증 경계와 함께 남긴다. 다음 우선순위는 독립 진행 감시의 주기 실행·
외부 알림(메시지 전송 경로는 별도 승인 필요), 적격 backlog가 있을 때 예비의 결과 저장,
반복 부팅 격리/정체 자동 재시작의 운영 시험이다. publisher/text/maintenance는
supervisor·Swarm 1차 재시작만 있고 별도 예비/쓰기 fencing은 아직 없다. 이 역할까지
확대하려면 P1의 역할 lease와 각 쓰기 경로를 동일하게 감사·구현해야 한다.

```sh
cd /private/tmp/nmv-worker-failover-ops
git diff --check
git status --short
git add AGENTS.md README.md PENDING.md docs/CODEX_HANDOFF.md docs/operations/independent-workers-runbook.md docs/operations/2026-09-28-worker-failover-rollout.md
git commit -m 'docs: record live worker failover rollout'
git push -u origin feat/worker-failover-ops-20260928
```

---

# 2026-09-28 20:24 KST — P1 운영 반영, P2 scheduler·정체 재시작 코드 검증

## 현재 목적 / 완료 작업 / 수정 파일

P1 PR #214 최신 CI(단위·PostgreSQL 통합·타입·lint·build)를 통과시킨 뒤 운영 DB에
가산 migration 0051/0052를 직접 연결로 적용했다. `role_leases`와
`primary_boots`·`quarantine_until` 컬럼 존재를 읽기 전용 확인했다. PR 병합 main SHA는
`8401edfb31c9ecbcff351e61e6ec86949e9bbf2b`. 웹 M3·mini와 M3의
scheduler/crawler/reviewer/publisher/text/maintenance 8개 앱을 해당 SHA로 배포했고,
Dokploy 모두 `done`, `RELEASE_TAG`도 해당 SHA로 교정했다. 두 웹의
`NEXT_DEPLOYMENT_ID` 환경/빌드 인자도 함께 교정했다. M3 6개 역할 컨테이너는 모두
healthy, mini 웹은 컨테이너 내부 HTTP200/app+DB ok·동일 SHA, 공개 M3 웹도
HTTP200/app+DB ok·동일 SHA다. P0 감시 CLI의 운영 읽기 전용 결과는 `overall=ok`,
수집 저장 진행, scheduler 정상 예약, 심사 유휴/준비 중이다.

P2는 별도 worktree `/private/tmp/nmv-worker-failover-p2`, 브랜치
`feat/worker-failover-p2-20260928`에서 코드 작성 중이다. 변경 파일은
`lib/operations/instance.ts`, `scripts/role-worker.ts`, `scripts/worker-supervisor.ts`,
`tests/operations-instance.test.ts`, `tests/role-worker.test.ts`,
`docs/operations/independent-workers-runbook.md`,
`docs/superpowers/plans/2026-09-28-progress-restart-and-scheduler.md` 및 이 문서다.
`SCHEDULER_REPLICA_IDENTITY=1`이면 HOSTNAME을 관측 키에 넣어 두 poller가 덮어쓰지 않는다.
주 역할 후보만 수요가 있는데 저장이 없는 상태를 15초 간격 2회 확인하고,
scheduler 정상·다른 단계 진행/제공자 오류 없음일 때 supervisor를 drain 후 종료 코드1로
Swarm 재시작을 요청한다. 기존 반복 부팅 격리로 예비 승격이 이어진다. 운영 옵션·복제 수와
예비 서비스는 아직 변경하지 않았다.

## 실제 테스트 / 실패 접근

- P2 표적 단위: 관측 키 9/9, 역할 후보 8/8 통과. 실제 프로세스/동시 scheduler 요청
  PostgreSQL 통합 2파일/10 통과. 최신 `npm test`, 타입 검사, lint(기존 vendor 경고1),
  `git diff --check` 통과. 전체 단위 152파일/1217, 전체 PostgreSQL 통합
  93파일/906 통과·TODO1 (`/tmp/nmv-p2-integration.log`). `npm run build`도
  종료 코드 0으로 통과했다. 빌드의 기존 Claude CLI 동적 경로 추적 경고는 남는다.
- 새 worktree 첫 타입 검사는 Next `PageProps` 생성물이 없어 실패했고 `npx next typegen`
  실행 뒤 통과했다. 진행 정체 기능의 첫 단위 실행은 함수 부재/타이머 대기로 실패한 뒤
  구현하여 통과했다. 운영 mini 직접 Traefik 경로는404였지만 컨테이너 내부의
  `HOSTNAME:3000/api/health`는 HTTP200이므로 앱 장애로 판정하지 않았다.
- P1 CI는 강제 종료 테스트가 standby DB 선출 직후 heartbeat 전에 SIGTERM해 1회 실패했다.
  테스트가 실제 실행 준비를 기다리게 하고 supervisor가 startup 정상 종료 요청을
  깨끗한 drain으로 처리하도록 수정한 최신 CI는 통과했다.

## 남은 작업 / 정확한 다음 명령

P2 변경을 커밋한다. P1 병합 main으로 재기반해 새 PR의
최신 CI를 통과시킨 뒤 scheduler 2복제본을 **먼저** 운영 검증한다. 그 뒤 crawler 주 후보
명령 전환→같은 릴리스 예비 배치→실제 장애 주입/자료 저장 확인, 이어 reviewer 순서다.
예비 배치 전 현재 운영 crawler/reviewer는 여전히 legacy 단일 supervisor 명령이다.
P0 외부 알림 경로는 미연결, 사용자 중단 `product-intro-check`와 루트 사용자 변경은 보존.

```sh
cd /private/tmp/nmv-worker-failover-p2
git status --short --branch
tail -n 5 /tmp/nmv-p2-integration.log
git diff --check
git fetch origin main
git log -3 --oneline
```

---

# 2026-09-28 20:09 KST — P1 CI 시작 중 종료 경계 수정

## 현재 목적 / 완료 작업 / 수정 파일

PR #214 최신 head `7117b31`의 CI `check`가 통합 테스트에서 1건 실패했다. 실패 파일은
`tests/integration/role-worker-process.test.ts`의 강제 종료 후 standby 승격 시험이다.
DB owner가 standby로 바뀐 직후 자식 supervisor의 heartbeat 전에 SIGTERM을 보냈고,
자식이 시작 도중 종료 코드1로 끝났다. `tests/integration/role-worker-process.test.ts`에서
standby `status=running`/childPid까지 기다린 뒤 정상 drain을 검증하도록 고쳤다.
동시에 `scripts/worker-supervisor.ts`에서 요청된 종료가 **첫 heartbeat 이전**인 경우
자식의 signal/비정상 startup exit를 깨끗한 drain으로 인정한다. 실행 중 자식의 비정상
종료와 45초 강제 종료는 계속 실패 처리한다. `tests/worker-supervisor.test.ts`에
이 분기를 RED→GREEN 시험으로 추가했다. 이 3파일과 인계 문서는 아직 미커밋이다.

## 실제 테스트 / 실패 접근

- CI의 최신 검사: 타입·lint·단위 통과, 통합 92파일 통과·1파일 1테스트 실패.
  `gh run view 36413096655 --log-failed`에서 시작 중 SIGTERM, `supervisor.stopped`
  `exitCode=1`, 테스트의 종료 코드0 기대 실패를 확인했다. 전체 로그가 매우 길므로
  다음에는 특정 실패 줄만 추출한다.
- 수정 뒤 대상 단위 1파일/9, 실제 프로세스 통합 1파일/3 통과.
  첫 타입 검사는 테스트 closure의 nullable `standby` 때문에 실패했고 non-null 접근으로
  교정했다. 교정 뒤 타입 검사는 아직 다시 실행하지 않았다.
- 운영 migration은 적용하지 않았다. `/tmp/nmv-p1-migrate-20260928.py preflight`로
  직접 DB `nomorevibe`와 migration table 존재, `role_leases` 부재를 읽기 전용 확인했다.
  `/tmp/nmv-p1-release-env-20260928.py preflight bc21ed3d27c624c4930cadbeee3e562cd9d89120`
  으로 현 main SHA의 8개 앱 환경 교정 대상도 확인했다. 이 스크립트는 비밀값을 출력하지 않는다.

## 남은 작업 / 정확한 다음 명령

타입·lint·diff·대상 테스트를 다시 실행하고 수정 커밋을 PR #214에 푸시해 최신 CI를
기다린다. 통과 전에는 migration·병합·배포하지 않는다. 이후 기존 단일 워커 명령 유지,
P2 예비 배치 전까지 이중 실행 금지. P0 감시 주기/알림, 데이터 정체 자동 제어도 남았다.

```sh
cd /private/tmp/nmv-worker-failover-20260928
npx tsc --noEmit
npx eslint scripts/worker-supervisor.ts tests/worker-supervisor.test.ts tests/integration/role-worker-process.test.ts
npm run test:integration -- tests/integration/role-worker-process.test.ts
git diff --check
git status --short
gh pr checks 214
```

---

# 2026-09-28 20:00 KST — P1 PR과 강제 종료 추가 검증

## 현재 목적 / 완료 작업 / 수정 파일

P1 변경을 P0 squash main 위로 재기반해 브랜치 `feat/worker-failover-20260928`에
커밋 `50c9fc7`(수집 조기 회수), `e050496`(역할 후보/lease/fencing)으로 만들고
PR #214를 열었다. 필수 CI `check`는 아직 진행 중이다. P1 코드는 운영에 배포되지 않았고
예비 워커도 없다. PR 뒤 `tests/role-worker.test.ts`에 DB 갱신 예외 시 중단 시험,
`tests/integration/role-worker-process.test.ts`에 실제 supervisor SIGKILL 뒤 역할 lease
만료를 시험 DB에서 앞당겨 standby가 인계하는 시험을 추가했다. 두 파일과 이 문서는
아직 후속 커밋 전이다.

## 설계 판단 / 실제 테스트 / 실패 접근

SIGKILL 시험은 Swarm이 재시작에 실패한 상황의 lease 만료를 모사한다. 실제 65초를
기다리는 대신 DB `lease_until`을 21초 과거로 바꿨으므로 운영 복구 시간 측정은 아니다.
실제 primary supervisor 프로세스 그룹을 SIGKILL했을 때 후보 프로세스가 종료 코드1로
끝났고 owner가 남았다. DB 만료 뒤 standby가 새 owner가 되고 정상 drain에서 종료 코드0을
반환했다. 해당 프로세스 통합 1파일/3 통과, 갱신 예외 단위 1파일/4 통과,
`npx tsc --noEmit`, 대상 ESLint, `git diff --check` 통과했다. 초기 graceful drain 시험의
간헐 실패 원인은 여전히 불명확하다.

## 남은 작업 / 정확한 다음 명령

추가 테스트를 커밋·푸시하고 PR #214의 **최신 head** CI를 확인한다. 통과하면 병합 후
기존 단일 워커 명령 그대로 앱 8개에 배포하고 migration 0051/0052를 확인한다.
P1 후보 실제 운영 활성화는 릴리스 태그 교정과 추가 장애 주입·쓰기 경로 감사 전까지
금지한다. P0 정기 감시/알림·정체 제어, P2 scheduler 두 poller·crawler/reviewer standby,
P3 후속 역할은 남았다. 사용자 중단 소개 검수와 루트 변경은 보존한다.

```sh
cd /private/tmp/nmv-worker-failover-20260928
git status --short --branch
git add tests/role-worker.test.ts tests/integration/role-worker-process.test.ts docs/CODEX_HANDOFF.md
git commit -m 'test: verify DB renewal failure and crashed primary handoff'
git push
gh pr checks 214
```

---

# 2026-09-28 19:54 KST — P0 운영 배포 완료, P1 코드 후보 검증

## 현재 목적 / 완료 작업 / 수정 파일

P0 PR #213의 병합 SHA `bc21ed3d27c624c4930cadbeee3e562cd9d89120`를 Dokploy의
웹 M3·mini와 scheduler/crawler/reviewer/publisher/text/maintenance 총 8개 앱에 배포했다.
8개 모두 해당 SHA deployment `done`이며 공개 `/api/health` 12회에서 M3·mini 양쪽이
HTTP200, app/db ok였다. 실제 runtime `RELEASE_TAG`는 과거 `611820d` 값이라 P1 후보
운영 전 실제 코드 SHA와 일치시켜야 한다. connect-agent는 이번 8개 배포 범위가 아니다.

P1 worktree `/private/tmp/nmv-worker-failover-20260928`의 미커밋 변경은 역할 lease/epoch,
동일 릴리스 standby 선출, 이전 job token 무효화와 쓰기 경로 fencing, 후보 로컬 health,
후보 관측, crawler/reviewer 저장 경로 및 테스트다. 변경 파일은 `git status --short` 참조.
정상 primary drain 뒤 owner가 null일 때 다른 릴리스 standby가 선출되던 결함을 RED→GREEN
테스트로 수정했다. 두 standby 동시 경쟁에서 한 후보만 선출됐다. 실제 두 프로세스의
primary drain→standby 활성화와 대기/활성 healthcheck를 확인했다. 정상 종료와 lease 상실의
진단 사유를 구분한다. 운영 runbook과 설계 문서에 코드/미구현 경계를 반영했다.

## 실제 테스트 / 실패 접근

- P1 최종 전체 재실행: 단위 152파일/1210 통과
  (`/tmp/nmv-failover-unit-p1-final.log`), 통합 93파일/905 통과·TODO1
  (`/tmp/nmv-failover-integration-p1-final.log`), 타입 검사·lint(오류0,
  기존 vendor 경고1)·build·diff-check 통과. 후보 healthcheck와 두 예비 경쟁을
  포함한 결과다.
- 프로세스 SIGTERM 테스트 최초 1회 15초 시간 초과 후 약47초에 강제 drain 실패가 있었다.
  당시 로그 미수집이라 원인 미확정이다. 이후 동일 테스트 단독12회와 두 후보 테스트를
  반복해 통과했지만 간헐 실패가 완전히 제거됐다고 주장하지 않는다.
- 정상 drain 직후 다른 릴리스 예비 선출 테스트는 실패로 재현해 role-leader에서 owner
  유무와 관계없이 마지막 owner release를 비교하도록 수정했다. 대기 healthcheck 테스트도
  기존 함수 부재로 실패 확인 뒤 로컬 후보 상태/활성 supervisor 확인을 구현했다.

## 남은 작업 / 정확한 다음 명령

P1 변경을 커밋하고, P0 squash main 위로 재기반해 PR을 연다.
역할 후보는 현재 Dokploy에 배치하지 않았다. P0 외부 감시 CLI의 정기 실행/경보와
데이터 정체 자동 재시작 제어는 미구현이다. P1 추가 장애 주입(실제 SIGKILL,
DB 단절, 느린 결과)과 crawler/reviewer 쓰기 경로 감사 후 P2 scheduler 두 poller,
crawler standby, reviewer standby를 순서대로 활성화한다. P1 운영 시
`RELEASE_TAG`·실제 이미지 SHA 일치를 먼저 교정하고 old standby→old primary drain→
new primary→new standby 순서로 진행한다. 사용자 중단 `product-intro-check`와 루트
작업트리 사용자 변경은 보존한다.

```sh
cd /private/tmp/nmv-worker-failover-20260928
git status --short --branch
npm test
npm run test:integration
npx tsc --noEmit
npm run lint
npm run build
git diff --check
python3 /tmp/nmv-health-20260925.py status
```

---

# 2026-09-28 19:15 KST — P0 병합, P1 역할 임대 검증 중

## 현재 목적 / 완료 작업 / 수정 파일

수집·심사 워커의 장애를 판별하고 재시작 실패 시 같은 릴리스의 예비 워커로 안전하게
인계하는 기능을 P0→P3 순서로 진행한다. P0를 별도 worktree
`/private/tmp/nmv-worker-failover-p0`의 PR #213으로 분리했고 필수 CI `check`와
GitGuardian 통과를 확인한 뒤 10:15 UTC에 squash 병합했다. main SHA는
`bc21ed3d27c624c4930cadbeee3e562cd9d89120`이다. `gh pr merge`는 원격 병합 뒤 로컬
`main`이 다른 worktree에서 사용 중이라 종료 코드 1을 냈지만 PR 상태 `MERGED`와 main SHA로
원격 병합을 확인했다. 병합 직후 Dokploy 앱 8개는 아직 이전 `1e11190` deployment `done`이고
connect-agent는 별도 앱이다. 새 SHA의 운영 배포는 아직 확인하지 않았다.

P1 worktree `/private/tmp/nmv-worker-failover-20260928`에는 frontier 조기 회수 커밋
`6f4aaf2` 뒤 미커밋 변경이 있다. `role_leases`/history migration, `lib/jobs/role-leader.ts`,
`scripts/role-worker.ts`, `scripts/worker-supervisor.ts`, `scripts/worker.ts`,
`lib/jobs/runner.ts`, `lib/jobs/control.ts`와 crawler/reviewer 저장 경로의 lease 검증,
관련 통합·단위 테스트 및 설계 문서가 변경됐다. 정확한 전체 목록은 `git status --short`.
역할 선출은 DB 락과 epoch를 사용하고 이전 잡 token을 무효화한다. 같은 릴리스의 standby만
인계하며, 5분 내 primary 부팅 3회는 15분 격리한다. 후보 관측을 15초마다 기록한다.
Compose/Dokploy의 예비 워커는 아직 만들거나 켜지 않았다.

## 실제 테스트 / 실패 접근

- P0 분리 worktree: `npm ci`, `npx next typegen`, `npx tsc --noEmit`, lint(오류0,
  기존 vendor 경고1), 단위151파일/1206테스트, `npm run build`, `git diff --check` 통과.
  호스팅 필수 CI `check` 통과. 통합 테스트는 호스팅 CI에서 실행됐다.
- P1 기존 전체 실행: 단위152파일/1209 통과, 통합92파일/900 통과·TODO1,
  타입 검사, lint(오류0·기존 경고1), build 통과. 통합 로그는
  `/tmp/nmv-failover-integration-20260928.log`. 다만 그 뒤 리뷰 늦은 결과 테스트,
  후보 관측, 프로세스 테스트를 추가했으므로 최종 전체 재실행은 남았다.
- 실제 프로세스 SIGTERM drain 통합 테스트 `tests/integration/role-worker-process.test.ts`는
  첫 실행에서 15초 대기 제한을 넘고 약47초 뒤 `role_lease_lost` 상태로 실패했다.
  진단 출력 추가 뒤 4회 재실행은 각 1초 이내 통과했다. 원인 미확정이므로 간헐 실패가
  해결됐다고 보지 않는다. 시스템 디버깅 절차로 재현·시그널·DB 경계를 조사한다.
- 처음 P1 build는 외부 worktree `node_modules` symlink 때문에 Turbopack이 실패했다.
  해당 worktree에서 `npm ci`로 실제 의존성 디렉터리를 만들고 build 통과했다.
- 루트 worktree의 사용자 `scripts/search-judgments.json` 및 기타 미커밋 자료는 건드리지 않는다.
  사용자가 중단한 `product-intro-check`도 재개하지 않는다.

## 남은 작업 / 정확한 다음 명령

P0의 운영 자동 배포가 main SHA로 완료되는지 확인한다. P0 CLI의 주기 실행과 외부 알림은
아직 미연결이다. P1 프로세스 테스트 간헐 실패의 원인을 찾고 수집·심사 늦은 쓰기 경로를
감사한다. 여러 후보의 강제 종료/DB 단절/지연 완료 시험과 전체 CI를 통과하기 전에는
standby를 배치하지 않는다. 이후 scheduler 두 poller→crawler standby→reviewer standby→
publisher/text/maintenance 순서로 진행한다. DB streaming/서버 자체 설정은 범위 밖이다.

```sh
cd /private/tmp/nmv-worker-failover-20260928
git status --short --branch
npm run test:integration -- tests/integration/role-worker-process.test.ts
npm run test:integration -- tests/integration/role-leader.test.ts tests/integration/review-handoffs.test.ts
python3 /tmp/nmv-health-20260925.py status
gh pr view 213 --json state,mergeCommit
```

---

# 2026-09-28 18:43 KST — P1 수집 선점 조기 회수 완료

## 현재 목적 / 완료 작업 / 수정 파일

P0 커밋 `1aab591`, `b0375e8`에 이어 P1 첫 코드 커밋 `6f4aaf2`를 만들었다.
`lib/crawl/repository.ts`의 `recoverAbandonedFrontier`가 새 `crawl-fetch` 잡 token이
유효할 때만 현재 잡의 DB `last_run_at`보다 오래된 `fetching` 항목을 `pending`으로 돌린다.
오류 시도 횟수를 하나 되돌리고, `lib/crawl/jobs/fetch.ts`가 새 잡 첫 선점 전 한 번 호출한다.
`tests/integration/crawl-fetch.test.ts`에 회수·토큰 검증·현재 선점 보호·옛 결과 거부·
실제 다음 잡 틱 재개 테스트를 추가했다. frontier 컬럼 migration은 필요하지 않았다.
설계 문서와 작업 계획에 이 선택을 반영했으나 문서는 아직 미커밋이다.

## 설계 판단 / 테스트 / 실패 접근

- 새 통합 테스트는 처음 10분 미래 `next_attempt_at` 때문에 원본이 저장되지 않아 RED였다.
  다른 역할의 유효한 token도 잘못 회수하던 반례를 추가로 RED 확인한 뒤 `crawl-fetch`로 한정했다.
- `npm run test:integration -- tests/integration/crawl-fetch.test.ts tests/integration/crawl-pipeline.test.ts tests/integration/job-control.test.ts`: 3파일 60/60 통과.
  `npx vitest run tests/crawl-fetch-concurrency.test.ts tests/crawl-fetch-backpressure.test.ts`: 2파일 7/7 통과.
  `npx tsc --noEmit`, 대상 ESLint, `git diff --check` 통과.
- 첫 테스트에서 앱 시계 `Date.now()`와 DB `now()`가 약 12ms 달라 시각 단정이 실패했다.
  DB에서 실제 `dequeue`가 가능한지 검증하도록 교정했다. 운영 결함으로 해석하지 않는다.
- 이 조기 회수는 단일 `crawl-fetch` 잡의 선점을 처리한다. 예비 역할 인계/epoch 쓰기 차단은
  아직 없다. 옛 워커의 모든 DB 쓰기를 막는 기능으로 보고하지 않는다.

## 남은 작업 / 정확한 다음 명령

P1 역할 lease/epoch, 늦은 쓰기 경로 감사와 예비 선출 시험을 수행한다. P2 운영 배치 전
이 안전 조건이 통과해야 한다. P0 감시 CLI는 아직 운영 주기 실행/외부 경보 라우팅이 없다.
사용자 중단 `product-intro-check`는 유지하고 루트 작업트리 사용자 변경은 건드리지 않는다.

```sh
cd /private/tmp/nmv-worker-failover-20260928
git status --short --branch
git log -3 --oneline
sed -n '1,210p' scripts/worker.ts
sed -n '1,150p' lib/jobs/control.ts
rg -n 'assertJobLease|ctx.lease|recordAutomaticJudgement' lib/crawl
```

---

# 2026-09-28 18:38 KST — 워커 failover P0 구현 결과

## 현재 목적 / 완료 작업 / 수정 파일

사용자 지시대로 P0→P3 순서로 계속 구현한다. 작업트리
`/private/tmp/nmv-worker-failover-20260928`, 브랜치 `feat/worker-failover-20260928`.
P0 코드 커밋 `1aab591`(심사 owner 변경 한도)과 `b0375e8`(수집·심사·scheduler 진행 판별,
최근 5분 부팅 이력, 관리자 표시, JSON 감시 CLI)을 만들었다. 새 감시 CLI는
`node --import tsx scripts/check-worker-progress.ts`이며 읽기 전용으로 DB를 조회한다.
종료 코드 0=정상/유휴, 1=조회·판정 불가, 2=경보 대상이다. **운영에서 CLI를 주기 실행하거나
외부 호출로 연결하지는 않았다.** 감시 서비스 배치는 P2 대상이다. 수정 파일은 두 커밋에 있고,
설계·계획·이 인계 문서는 아직 별도 미커밋 상태다.

## 판단 / 실제 테스트 / 실패 접근

- 심사 회귀 통합 16/16, 연관 심사·발행 통합 30/30 통과(`1aab591` 단계).
- P0 진행 판별 단계: `npm run test:integration -- tests/integration/worker-progress-query.test.ts tests/integration/operations-throughput.test.ts tests/integration/job-control.test.ts tests/integration/agent-review-records.test.ts` 4파일 34/34 통과.
  `npx vitest run tests/worker-progress.test.ts tests/operations-throughput.test.ts tests/operations-throughput-display.test.ts tests/worker-supervisor.test.ts tests/scheduler-runtime.test.ts` 5파일 28/28 통과. 대상 ESLint, `npx tsc --noEmit`, `git diff --check` 통과.
- `DATABASE_URL='' node --import tsx scripts/check-worker-progress.ts`는 JSON `overall=unknown`, 종료 코드1을 반환했다(예상 동작). 전용 DB에서는 경보 JSON과 종료 코드2를 통합 테스트로 확인했다.
- TDD에서 누락 모듈, `unknown` 스텁, 이전 부팅 관측 덮어쓰기, scheduler heartbeat만 있는 상태의 잘못된 `scheduled` 판정, 관리자 라벨 누락을 각각 RED로 보고 교정했다. 첫 관측 구현은 `value.bootedAt`이 closure에서 unknown으로 추론되어 타입 검사에 실패했고 좁혀진 지역 변수로 교정했다.
- `job.failed` 로그는 기존 테스트의 의도된 실패 주입이며 전체 테스트 결과는 통과다.

## 남은 작업 / 정확한 다음 명령

P0 관리자 화면은 최근 5분 저장량과 판별 사유를 표시하지만 마지막 저장의 전체 이력 시각은
아직 제공하지 않는다. 외부 감시 주기 실행/경보 라우팅도 미배치다. P1에서는 수집 frontier의
10분 선점 대기 조기 회수, 역할 lease/epoch와 이전 주인 쓰기 차단, 반복 정체 시 1회 재시작
제어를 구현한다. 예비 활성화는 모든 쓰기 경로를 검증하기 전에는 켜지 않는다.
P2는 scheduler 두 poller, crawler 예비, reviewer 예비 순서이며 P3는 후속 역할이다.
사용자 중단 `product-intro-check`는 재개하지 않는다. 루트 사용자 변경은 보존한다.

```sh
cd /private/tmp/nmv-worker-failover-20260928
git status --short --branch
git log -2 --oneline
sed -n '1,155p' docs/superpowers/specs/2026-09-28-worker-failover-design.md
sed -n '90,175p' lib/crawl/repository.ts
npm run test:integration -- tests/integration/worker-progress-query.test.ts tests/integration/agent-review-records.test.ts
```

---

# 2026-09-28 18:22 KST — 워커 failover P0 심사 중단 한도 수정

## 현재 목적 / 완료 작업 / 수정 파일

사용자 지시대로 워커 장애 복구 설계의 P0→P3를 순서대로 구현 중이다. 별도 작업트리
`/private/tmp/nmv-worker-failover-20260928`, 브랜치 `feat/worker-failover-20260928`에서 작업한다.
P0 첫 수정으로 심사 `owner_changed`를 모델 실패 한도와 분리하고, 동일 입력의 최근 24시간
소유권 변경 3회는 `infrastructure_interruptions_exhausted`로 별도 중단하도록 했다. 영구 회귀
테스트에서 25시간이 지나면 다시 준비 큐에 들어와 다음 시도를 할 수 있음을 확인했다.
코드·테스트 커밋 `1aab591`이며 수정 파일은 `lib/crawl/agent-review-repository.ts`,
`tests/integration/agent-review-records.test.ts`다. 구현 계획은
`docs/superpowers/plans/2026-09-28-worker-review-recovery.md`, 설계는
`docs/superpowers/specs/2026-09-28-worker-failover-design.md`다.

## 설계 결정 / 실제 테스트 / 실패 접근

- 회귀 테스트 RED: 기존 코드는 `attempts_exhausted`를 반환했다. GREEN: 심사 기록 통합 16/16,
  연관 심사 잡·발행 게이트·인계 통합 30/30 통과. `git diff --check` 통과.
- 첫 작업트리 테스트는 `node_modules`가 없어 실행되지 않았다. 루트 의존성에 symlink해 해결했다.
- 첫 타입 검사는 생성된 Next `PageProps`가 없어 실패했다. `npx next typegen` 성공 뒤
  `npx tsc --noEmit` 통과했다. 이 오류는 변경 코드의 타입 오류가 아니었다.
- 첫 GREEN 시도는 DB 행을 supersede한 뒤 메모리 행의 `errorCode`·`completedAt`을 갱신하지 않아
  세 번째 변경을 세지 못했다. 같은 행을 갱신해 16/16 통과했다.
- 테스트 로그의 `job_lease_lost`는 늦은 발행을 막는 기존 실패 주입 fixture이며 테스트 실패는 아니다.

## 남은 작업 / 정확한 다음 명령

P0 준비 큐·저장 결과·scheduler 예약 지연·반복 부팅 판별과 외부 감시용 구조화된 상태를
구현한다. 이어서 P1 frontier 조기 회수/역할 lease·epoch, P2 scheduler 두 poller와
crawler/reviewer 예비 배치, P3 후속 역할 순서다. 운영 강제 종료·예비 인계는 아직 미시험이다.
사용자가 중단한 `product-intro-check`는 재개하지 않는다. 루트 작업트리의 사용자 변경은 보존한다.

```sh
cd /private/tmp/nmv-worker-failover-20260928
git status --short --branch
npm run test:integration -- tests/integration/agent-review-records.test.ts
npx next typegen
npx tsc --noEmit
sed -n '1,260p' lib/operations/throughput.ts
sed -n '1,180p' lib/operations/admin.ts
```

---

# 2026-09-28 18:13 KST — 워커 장애 복구 설계 검증 완료

## 현재 목적 / 완료 작업 / 변경 파일

수집·심사 워커 장애 복구의 **현 구현을 실제 시험**하고 서버 설정 변경 전 우선순위를 검증했다.
`docs/superpowers/specs/2026-09-28-worker-failover-design.md`를 새로 작성했다(아직 구현·배포하지 않음).
운영 6개 역할 서비스는 각각 1복제본, Swarm `restart=any`, 지연 5초임을 읽기 전용으로 확인했다.
2026-09-28 09:08:35 UTC 운영 DB 읽기 전용 표본에서 최근 1시간 발견155·원본159·규칙159·
1차 AI38·2차 AI30·발행11건이 저장됐다. 5분 원본/규칙 대기0·진행0은 정상 유휴였다.
첫 AI 준비 큐0이며 `needs_review` 전체2399건을 준비 큐로 해석하면 안 된다.

## 설계 판단 / 테스트 / 실패 접근

- `npx vitest run tests/worker-supervisor.test.ts tests/worker-runtime.test.ts tests/scheduler-runtime.test.ts tests/operations-throughput.test.ts`: 4파일 23테스트 통과.
- `npm run test:integration -- tests/integration/job-runner.test.ts tests/integration/job-control.test.ts tests/integration/crawl-fetch.test.ts tests/integration/agent-review-records.test.ts tests/integration/operations-throughput.test.ts`: 전용 localhost:55435 PostgreSQL에서 5파일 70테스트 통과. 예상된 실패 주입 로그가 있으나 테스트 실패는 0건.
- 일회성 통합 테스트 `tests/integration/worker-failover-audit-20260928.test.ts`에서 2테스트 통과 후 해당 임시 파일을 삭제했다. 모델 결과 0건인 채 owner가 세 번 바뀌면 네 번째 심사 claim은 `attempts_exhausted`이고 준비 큐에서도 제외됐다. `fetching` 항목은 9분에는 선택되지 않고 10분 경과 뒤 다시 선택됐다.
- 현재 supervisor가 종료/응답 정지를 감시하고 Swarm이 재시작한다. 잡 lease는 90초 회수다. `crawl_frontier`의 개별 `fetching` 항목은 10분 재선택 시각을 갖고, `owner_changed` 심사 시도는 현 코드상 시도 한도에 포함된다.
- 첫 일회성 시험은 설정 모델 불일치와 앱/DB 시계 차이 때문에 2개 실패했다. 시험 조건을 현재 모델과 DB의 예약 시각에 맞춰 교정한 뒤 2개 통과했다. 운영 코드의 새 실패로 해석하지 않는다.
- scheduler는 모든 정기 요청의 의존성이고 동시 poll을 합치는 통합 테스트가 통과했다. 설계 순서를 바로잡아 P0 판별·경보와 심사 owner 변경 결함, P1 수집 조기 회수·역할 fencing, P2 scheduler 두 poller 배치→crawler 예비→reviewer 예비, P3 후속 역할로 정했다.
- 운영 강제 종료 및 예비 인계는 시험하지 않았다. 예비 역할 서비스와 역할 lease는 미구현이다. 복구 시간의 실제 측정값을 주장하지 않는다.

## 남은 작업 / 정확한 다음 명령

구현은 아직 시작하지 않았다. 다음은 P0의 실제 일감·저장 진행·scheduler 예약 지연·반복 부팅 판별 및 경보, 심사 owner 변경 시도 한도 수정이다. 이어서 P1 수집 token/조기 회수·역할 lease/epoch를 플래그 off로 검증한다. 운영 배치는 P2까지 보류한다. 기존 사용자 `scripts/search-judgments.json` 수정과 다른 untracked 자료는 보존했다. 사용자 중단 `product-intro-check`는 재개하지 않았다.

```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
sed -n '1,150p' docs/superpowers/specs/2026-09-28-worker-failover-design.md
sed -n '225,330p' lib/crawl/agent-review-repository.ts
sed -n '100,145p' lib/crawl/repository.ts
npm run test:integration -- tests/integration/job-control.test.ts tests/integration/agent-review-records.test.ts tests/integration/crawl-fetch.test.ts
python3 /tmp/nmv-health-20260925.py audit
```

---

# 2026-09-28 15:18 KST — 검색 키워드 검수 운영 적용 결과

## 현재 목적 / 완료 작업 / 변경 파일

README 입력 변경 뒤 검색 키워드를 정상 text 워커로 재생성·검수하는 중이다. PR209의 오래된
검수 우선 순서와 PR211의 형식 오류 묶음별 개별 재시도를 main에 병합하고 운영 M3 7개 앱·
mini 웹 1개 모두 `1e1119034624acae74dca825b590f5f125623a97` 소스, `done`을 확인했다.
수정 파일은 각 PR의 `lib/domain/products/search-profiles.ts`, `lib/domain/products/search-verify.ts`,
`tests/integration/search-verify.test.ts`, `tests/search-verify.test.ts`, `docs/CODEX_HANDOFF.md`다.
이 절은 배포 관측을 반영하는 문서 수정이며 기능 코드는 바꾸지 않는다.

- PR211 필수 CI [36384611587](https://github.com/JRVector9/nomorevibe/actions/runs/36384611587)의
  타입·lint·단위·PostgreSQL 통합·빌드 PASS 뒤 병합했다. 로컬 TDD RED→GREEN 및 표적 단위17,
  잡 예산6, 통합13 통과는 아래 절에 기록했다. 공개 `/api/health` 8회에서 M3 7회·mini 1회 모두
  `status=ok`, `db=ok`였다.
- 기존 재시도 소진5건 중 `authelia`, `product-491`, `ozo-calendar`는 이전 코드에서,
  `linkfinder-ai`는 새 개별 재시도 코드로 06:14:22 UTC에 실제 `verified_at`을 확인했다.
  총4/5 성공. `k-pop-wars`는 새 코드 검수에서 timeout으로 `verify_attempts=4`,
  `verify_retry_at=2026-09-28 06:57:02 UTC`이며 아직 성공이 아니다. backoff는 존중한다.
- 06:18 UTC 읽기 전용 운영 대조: 공개19,744개, 생성 대기2,435, 검수 대기302,
  미표시 원본 해시·검색 사본 불일치0, 재시도 소진0, 최근15분 생성85·검수82.
  가장 오래된 검수 대기는 `linkfinder-ai` 성공 뒤 약1,039분으로 내려갔다.
  소개 검수 `product-intro-check`의 사용자 중단(`2100-01-01`)은 유지한다.

## 설계 판단 / 실패 접근 / 남은 작업

모델이 5개 묶음에서 원문 공백을 바꿔 적는 실제 오류를 확인했지만, 판정 파서를 느슨하게 하지 않았다.
오류 난 묶음만 개별 검수하고 같은 전체 deadline과 원본·리스 검사를 유지한다. 한 응답이라도 실패하면
부분 결과를 저장하지 않는다. 첫 격리 작업트리 타입 검사는 Next `PageProps` 생성 전이라 실패했고
`npx next typegen` 뒤 통과했다. 테스트 모의 `Response` 재사용 실패는 매 호출 새 응답으로 교정했다.
Dokploy의 자동 배포 플래그만으로 실제 배포를 추정하지 않고 8앱의 소스 커밋과 완료 상태를 확인했다.

남은 작업은 정상 워커가 생성2,435건과 검수302건을 계속 처리하도록 관측하고,
`k-pop-wars`의 06:57 UTC 이후 재시도가 성공하는지 확인하는 것이다. 다시 실패해 소진되면
모델 응답·시간 제한을 새 근거로 조사한다. 원본 키워드·해시·재시도 시각을 임의로 덮어쓰지 않는다.

```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short --branch
python3 /tmp/nmv-priority-ops-20260927.py health-check
python3 /tmp/nmv-keyword-status-20260928.py
python3 /tmp/nmv-repair-ops-20260926.py status
gh pr view 211 --json state,mergeCommit,statusCheckRollup
curl -fsS --max-time 15 https://nomorevibe.brut.bot/api/health
```

위 조회 명령은 읽기 전용이다. 기존 사용자 `scripts/search-judgments.json` 수정과 untracked
자료는 건드리지 않았다. 아래 15:02 기록의 PR/배포 대기는 당시 상태로, 이 절의 완료 확인이 최신이다.

---

# 2026-09-28 15:02 KST — 반복 형식 오류의 개별 키워드 재시도

## 현재 목적 / 완료 작업 / 수정 파일

사용자 요청인 검색 키워드 재생성·검수를 계속 진행한다. PR209의 오래된 검수 우선 순서는
운영 8개 앱에서 `b332457`로 적용됐고, 재시도 소진 5건 중 3건은 실제 검수가 끝났다.
남은 `linkfinder-ai`와 `k-pop-wars`는 `invalid_output`이 반복되지만 소진은 0이다.
읽기 전용 모델 진단에서 `linkfinder-ai`의 5개 묶음은 판정 수가 모두 맞아도
`LinkedIn 프로필 찾기`를 `LinkedIn 프로필찾기`로 다시 써 엄격 일치 검사에 실패했다.
같은 한 키워드만 요청한 진단은 정확한 원문과 유효 판정을 반환했다. `k-pop-wars`의
동일 설정 4묶음 진단은 모두 유효해 일시적 응답 실패로 판단한다.

`lib/domain/products/search-verify.ts`에 한정된 복구를 추가했다. 5개 묶음의 형식이 틀리면
같은 전체 deadline 안에서 그 묶음의 키워드를 하나씩 재검수한다. 매 응답의 정확한 키워드와
boolean 판정을 그대로 요구하고, 하나라도 실패하면 이전 묶음 결과까지 버린다.
`tests/search-verify.test.ts`에 원문 공백 변화 회귀를, `tests/integration/search-verify.test.ts`에
추가 호출을 반영했다. 이 문서까지 수정 파일 4개다. 루트 사용자 변경은 건드리지 않았다.

## 설계 결정 / 실제 테스트 / 실패 접근

- 새 단위 테스트 RED(`invalid_output`)→GREEN. `npx vitest run tests/search-verify.test.ts` 17/17,
  `npx vitest run --config vitest.integration.config.ts tests/integration/search-verify.test.ts` 13/13.
  `npx vitest run tests/search-job-budget.test.ts` 6/6.
  `npx next typegen` 뒤 `npx tsc --noEmit`, 대상 ESLint, `git diff --check` PASS.
- 독립 작업트리에서 첫 타입 검사에 `PageProps` 생성 파일이 없어 실패했고 `npx next typegen` 후 통과했다.
  단위 테스트 모의 `Response`를 재사용해 두 번째 `.json()`이 `network`로 보인 오류는 매 호출에 새
  응답을 만들도록 테스트 도구를 바로잡았다. 제품 코드의 네트워크 실패로 해석하지 않는다.
- 원문 일치 규칙을 느슨하게 하지 않는다. `invalid_output`에만 개별 재시도를 적용하고
  rate limit·timeout·취소 및 전체 deadline은 기존대로 처리한다. 검수 부분 결과는 DB에 저장하지 않는다.

## 남은 작업 / 정확한 다음 명령

브랜치 `fix/search-verify-singleton-retry`, 작업트리
`/private/tmp/nmv-search-verify-singleton-20260928`의 PR, hosted CI, main 병합, 8개 앱 배포와
운영 재시도 결과 확인이 남았다. 현재 운영(06:02 UTC) 공개19,743개, 생성 대기2,516,
검수 대기300, 미표시 해시·검색 사본 불일치0, 재시도 소진0. 두 문제 제품은 각각
06:11:33·06:15:38 UTC 이후 자동 재시도 대상이며 새 코드 배포 전에는 성공을 주장하지 않는다.
소개 검수 `product-intro-check`의 사용자 중단(`2100-01-01`)은 유지한다.

```sh
cd /private/tmp/nmv-search-verify-singleton-20260928
git status --short --branch
npx vitest run tests/search-verify.test.ts
npx vitest run --config vitest.integration.config.ts tests/integration/search-verify.test.ts
npx next typegen
npx tsc --noEmit
npx eslint lib/domain/products/search-verify.ts tests/search-verify.test.ts tests/integration/search-verify.test.ts
git diff --check
cd /Users/jr/Desktop/projects/nomorevibe
python3 /tmp/nmv-priority-ops-20260927.py health-check
python3 /tmp/nmv-keyword-status-20260928.py
```

---

# 2026-09-28 14:43 KST — 검색 검수 순서 운영 배포와 대기열 인계

## 현재 목적 / 완료 작업 / 변경 파일

README 입력 변경 뒤 검색 키워드 재생성·검수를 정상 워커로 계속 진행한다. PR209의
`pendingVerifications` 대기 시각 우선 순서와 회귀 테스트를 main `b332457723cacaec78593d90ec4ecea8d8525088`에
병합했다. 수정 파일은 `lib/domain/products/search-profiles.ts`,
`tests/integration/search-verify.test.ts`, `docs/CODEX_HANDOFF.md`다. 이 절은 배포 후
운영 관측을 추가한 문서 수정이며 기능 코드는 바꾸지 않는다.

- PR209 필수 CI [36381746877](https://github.com/JRVector9/nomorevibe/actions/runs/36381746877)의
  타입, lint, 단위·PostgreSQL 통합 테스트, 빌드가 모두 통과한 것을 확인한 뒤 병합했다.
  테스트 RED→GREEN, 표적 통합13/13, 로컬 타입·lint·diff 검증은 바로 아래 절에 있다.
- 자동 배포가 바로 시작되지 않아 Dokploy `application.one`에서 8개 앱 모두 이전 커밋인 것을 확인한 뒤
  기존 `application.deploy` 절차로 M3 7개·mini 웹 1개를 함께 요청했다. 요청 수락과 완료를 분리해
  8개 전부 `done`/소스 커밋 `b332457`을 확인했다. 공개 `/api/health` 8회에서 M3 6회,
  mini 2회 모두 `status=ok`, `db=ok`였다.
- 운영 읽기 전용 대조(05:41 UTC): 공개 19,735개, 생성 대기 2,600, 검수 대기 292,
  미표시 원본 해시·검색 사본 불일치 각각0, 재시도 소진0. 생성·검수 성공 시각이 실제 진행 중이다.
  재시도한 5건 중 `authelia`, `product-491`, `ozo-calendar` 3건의 `verified_at`을 확인했다.
  `linkfinder-ai`는 이번 재검수에서 timeout으로 05:48:52 UTC 이후 다시 시도하며,
  `k-pop-wars`는 형식 오류 뒤 대기 시각이 지났으나 앞선 검수 약72건을 순서대로 기다린다.
  이 2건을 성공으로 세지 않는다. 소개 검수는 `2100-01-01` 중단 상태를 유지한다.

## 판단 / 실패 접근 / 남은 작업

검수 처리량과 새 키워드 생성량이 비슷해 대기량은 단기간에 0이 되지 않는다. 오래된 건을
먼저 고르는 변경은 처리량 증가를 주장하기 위한 것이 아니라 무기한 뒤로 밀림을 막기 위한 것이다.
실패한 첫 진단용 TypeScript의 CJS top-level await는 async `main()`으로 고쳤고,
Dokploy의 `autoDeploy=true`만으로 새 소스가 배포됐다고 간주하지 않고 실제 source/status를 조회했다.
남은 작업은 정상 워커가 2,600건 생성·292건 검수를 계속 처리하는 것을 관측하고,
재시도 2건의 성공 또는 재소진 여부를 확인하는 것이다. 키워드나 원본 해시를 수동으로 덮어쓰지 않는다.

```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short --branch
python3 /tmp/nmv-priority-ops-20260927.py health-check
python3 /tmp/nmv-keyword-status-20260928.py
python3 /tmp/nmv-repair-ops-20260926.py status
gh pr view 209 --json state,mergeCommit,statusCheckRollup
curl -fsS --max-time 15 https://nomorevibe.brut.bot/api/health
```

위 상태 도구는 읽기 전용이며 원문 키워드·자격 정보를 출력하지 않는다. 루트의 기존 사용자
`scripts/search-judgments.json` 변경과 untracked 자료는 보호한다. 아래 14:22 기록의 PR/배포
대기는 당시 상태이며 이 절의 완료 확인으로 대체한다.

---

# 2026-09-28 14:22 KST — 검색 키워드 재생성·검수 진행

## 현재 목적과 완료 작업

사용자 요청은 README 입력 변경 뒤 남은 검색 키워드 재생성·검수를 진행하는 것이다. 소개 검수
`product-intro-check`는 사용자 중단 상태(`not_before=2100-01-01`)를 유지한다.
운영 읽기 전용 대조에서 공개 19,732개, 생성 대기 2,716→2,691, 검수 대기 299,
미표시 해시 불일치·검색 사본 불일치 0을 확인했다. text 워커의 두 잡은 실제 성공 시각이 진행 중이다.

- 재시도 소진 5건을 원인별로 확인했다. `invalid_output` 4건은 기존
  `scripts/reconcile-search-profiles.ts --apply --retry-invalid-output`로 1회 묶음 재검수에 넣었다.
  `timeout` 1건(`product_id=11606`)은 기존 묶음 검수 코드가 처리할 수 있도록 조건부 DB 갱신으로
  `verify_attempts=0, verify_retry_at=null, repair_version=1`로 되돌리고 오류 원인은 보존했다.
  직후 읽기 전용 대조에서 `repeatedFailures=0`, `exhausted=0`이었다. 성공 검수 완료를 뜻하지는 않는다.
- 검수 대기열이 제품 ID 역순이라 새 제품이 들어오면 오래된 검수가 밀리는 원인을 확인했다.
  `pendingVerifications`를 프로필 `updated_at` 오름차순, 제품 ID 오름차순으로 바꿨다.
  기존 재시도 시각·소유권·원본 해시·엄격 검수는 그대로 사용한다.

## 변경 파일·테스트·실패 접근

- 변경: `lib/domain/products/search-profiles.ts`, `tests/integration/search-verify.test.ts`, 이 문서.
  분리된 작업트리 `/private/tmp/nmv-search-verification-20260928`, 브랜치
  `fix/search-verification-fairness`. 루트의 기존 사용자 변경과 untracked 자료는 건드리지 않는다.
- 회귀 테스트를 먼저 추가해 실제 실패(기대 ID 1, 결과 ID 2)를 확인했다. 순서 변경 후
  `npx vitest run --config vitest.integration.config.ts tests/integration/search-verify.test.ts`:
  13/13 PASS. `npx tsc --noEmit`, 대상 ESLint, `git diff --check`도 PASS.
- 첫 임시 상태 스크립트가 CJS의 top-level await로 컴파일 실패했다. async `main()`으로 고친 뒤
  읽기 전용 조회 성공. 키워드 생성·검수 우회 저장이나 해시 덮어쓰기는 하지 않았다.

## 남은 작업과 정확한 다음 명령

이 변경의 PR/hosted CI/병합/운영 text 앱 배포가 남았다. 배포 후 오래된 검수 5건의
실제 성공 여부와 대기량 감소를 확인한다. 새 제품이 계속 들어오므로 단일 시점의 대기량 0을
완료 조건으로 과장하지 않는다. README 일회성 12,418건 복구는 이전 절에서 완료했다.

```sh
cd /private/tmp/nmv-search-verification-20260928
git status --short
npx vitest run --config vitest.integration.config.ts tests/integration/search-verify.test.ts
npx tsc --noEmit
npx eslint lib/domain/products/search-profiles.ts tests/integration/search-verify.test.ts
git diff --check
cd /Users/jr/Desktop/projects/nomorevibe
python3 /tmp/nmv-priority-ops-20260927.py health-check
```

---

# 2026-09-27 11:04 KST — README 복구와 우선순위 후속 완료

## 현재 목적 / 완료 상태

README가 없던 제품 재수집·입력, 공개 저장소 보안/main 보호, 검색 감시, 엄격 묶음 검수,
CI 강화·README/운영 문서 보충과 기능 배포를 완료했다. 아래10시대 기록의 pending PR205는 과거 상태다.

- PR205 latest281c144 required CI36286825146 PASS 후 병합, main `a826947449512e501b7a19e9ca419e713d0bf387`.
  해당 커밋8앱 전부 source/done 확인. 실제 main workflow_dispatch36287149956도02:04:23 UTC PASS.
  같은 ref의 push36287139921은 concurrency에 따라 취소됐으며 통과로 주장하지 않는다.
- README12,418 전체 확인: 저장10,630/README미발견1,766/정제 텍스트 없음21/HTTP451제한1/
  일시 오류·API 대기 잔여0. 배포 후 readonly audit 문서누락0/제품입력누락0/사본불일치0/추가누락대상0.
- 검색 입력 변경의 생성 대기10,174와 검수33은 정상 자동 처리 중이다(11:03 KST).
  전체19,356, unmarked0/copy0, 최근 생성84/검수90, idle0분; 신규제품2개의 프로필은 grace 내 생성대기.
- GitHub 공용 core 제한 대기1건,11:30:02 KST reset. 원본조회는 공유 backoff를 존중하며,
  완료된 README 복구 미처리 항목으로 집계하지 않는다. 소개검수 user pause2100 유지.
- root npm ci 실행 exit0/취약점0, Next16.3.3/sharp0.35.4/Vitest4.1.11 직접 확인.
- 변경파일/설계/RED·GREEN/과거 테스트는 아래와 운영 보고서에 기록. 최종 PR206 hosted unit1197/
  integration886+todo1/type/lint/build PASS, PR205 required/main manual CI PASS를 실제 확인했다.
- 수정한 실패: exact cap tail stall, recrawl README삭제, published 제품 refresh경로 누락,
  비공개/접근불가404 README삭제 오인, shared quota 재시도. 원본 해시를 위조해 맞추지 않는다.

## 남은 자동 작업 / 미검증 범위 / 다음 명령

요청한 데이터 입력과 기능 수정은 끝났다. 자동 키워드 생성/검수 진행은 관리자 상태에서 관찰한다.
운영 백업 복원/24h 관측/랭킹 시즌 정책 전환/이번 관리자 visualQA는 실행하지 않았고 PENDING에 보존했다.
사용자 `scripts/search-judgments.json`과 기존 untracked 자료는 변경/커밋하지 않는다.
최종 검증 기록은 report/plan/handoff 문서3개만 별도 커밋한다. 일반 CI와 배포 상태는 실제 최신 커밋으로 확인한다.

```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
git rev-parse HEAD
python3 /tmp/nmv-priority-ops-20260927.py health-check
python3 /tmp/nmv-priority-ops-20260927.py readme-audit
python3 /tmp/nmv-repair-ops-20260926.py status
```

완료된 일회성 README helper는 다시 실행할 필요가 없다. 정상 job runner/소유권/공유 quota를 우회하지 않는다.
마이그레이션49/50는 완료했으므로 불필요한 재실행 없이 조회한다. 마지막 검증 파일:
`/private/tmp/nmv-readme-audit-final-runtime.json`, `/private/tmp/nmv-priority-health-final-20260927.log`,
`/private/tmp/nmv-priority-final-status-20260927.json`. 인증값·README원문을 공개 문서에 넣지 않는다.

---

# 2026-09-27 README 실수집 완료 / 최종 CI·문서 인계

## 현재 목적

승인된 우선순위 후속 1·2→4·5→3·6(공개 저장소 보안/main 보호, 검색 감시, 엄격 묶음 검수, CI/문서, 배포)과
추가 요청 **README 없는 제품 재수집·입력**을 완료한다. 아래 날짜가 더 오래된 기록은 과거 상태다.
사용자 수정 `scripts/search-judgments.json`과 기존 untracked 자료는 보호한다. 소개 검수 `product-intro-check`는
사용자 중단 상태(`not_before=2100-01-01`)를 유지한다. 외부 이메일/Slack 발송 권한은 없다.

## 완료한 작업 / 실제 운영 결과

- PUBLIC `JRVector9/nomorevibe`, main 관리자 포함 PR/최신 base 필수 check(app15368)/리뷰 대화 해결,
  force/delete 차단. Secret scanning·push protection·Dependabot 보안 업데이트 활성화. 09:50 KST 열린 경고 각각0.
- PR202 보안, PR201 검색 감시, PR203 엄격 5키워드 묶음 재검수, PR204 bounded README prefix,
  PR206 README 보존/재확인 **모두 hosted CI 통과 후 병합**. 현재 main 코드 커밋은
  `801039a58e4b0944c124a61609073332152082db`이다. 10:46 요청한 8개 앱 모두 해당 소스 커밋/done 실제 확인.
  PR205 CI·문서는 최종 내용을 추가한 뒤 아직 CI/병합/수동 실행 확인이 남아 있다.
- PR202의 실제 양쪽 웹 런타임 Next16.3.3/sharp0.35.4 확인. npm audit0/npm ls0.
  root npm ci exit0 후 Next16.3.3/sharp0.35.4/Vitest4.1.11도 직접 확인했다.
- 운영 migration0049(generated_at),0050(최신 심사 사유 partial index) 실행 exit0. 재실행 필요 없음.
  maintenance의 정상 소유 감시 잡 실행·완료 관측 확인, 웹은 캐시만 읽는다.
- **README original cohort12,418 전부 확인 완료**: 저장10,630 / 공개 README 미발견1,766 /
  정제 텍스트 없음21 / GitHub HTTP451 접근 제한1 / 일시적 오류·quota 대기0.
  마지막 DB audit: 획득10,630 모두 공개, 문서 누락0/제품 입력 누락0/SQL left2000 사본 불일치0,
  원본 cohort 밖의 추가 누락 대상0. HTTP451 저장소는 `nomaan5541/motionsites-prompt-collection`.
  원문 전체가 아닌 기존 정책의 정제 발췌(문서3000자/제품2000자)를 저장했다.
- README recovery helper 전부 종료 exit0. 최종 retry session90780 완료. 운영 수집 워커는 중단하지 않았다.
  `/private/tmp/nmv-readme-recovery-20260927.json` 상태와 `.jsonl` journal에는 대상/결과 metadata만 보관.
- 10:46 KST readonly search audit19,354제품/2703ms: missing0/unmarked0/copy0,
  marked generation10,265/verify25/repeated0/exhausted0/recentgenerated86/recentverified77/idle0분.
  입력이 바뀌었으므로 정상적인 자동 재생성 대기다. 예전 키워드에 해시만 덮어쓰지 않았다.
  수집·심사·생존 확인 성공 시각이 실제 진행 중이며 소개 검수 중단은 유지.

## 변경 파일 / 설계 결정

- PR202: package.json/package-lock.json. 버전 패치와 검증된 global esbuild/js-yaml override.
- PR201: search-health model/domain/job, cached status 표시, generated_at 및 최신 사유 lookup migration/tests.
- PR203: search verifier/job/reconcile 및 회귀 테스트. prior invalid_output/timeout만 5개 순차 묶음,
  전체 한 deadline, 모든 묶음 성공 전 쓰기 없음, 소스/버전/lease/backoff 유지.
- PR204: lib/net/fetch.ts, lib/crawl/readme.ts와 tests. README에만 최대256KiB prefix opt-in,
  정확히 cap에 도달하면 끝나지 않는 tail을 기다리지 않고 취소. 일반 근거 strict 크기 정책은 유지.
- PR206: lib/crawl/{repository,readme-refresh}.ts, lib/jobs/products/readme-refresh.ts,
  catalog/registry/contracts, crawl-fetch/readme-refresh/job-catalog unit/integration.
  홈페이지 recrawl은 마지막 README만 보존하고 version=null로 표시한다. crawler가5분마다 최대2문서,
  저장소당8초/전체20초 예산으로 갱신. explicit null version+sample만 선택하며 과거 전체 cohort 자동 스캔 아님.
  source CAS+owned lease 같은 transaction; 실패는 기존 sample 유지/15분→24h backoff 또는 provider reset.
  raw 긍정 결과는 public retrieval; API fallback은 private===false 확인 후 README endpoint를 읽는다.
  repo404는 visibility 불명 실패, 공개 repo README404만 confirmed absence이다.
- PR205: .github/workflows/ci.yml, README.md, AGENTS.md, PENDING.md,
  docs/superpowers/plans/2026-09-27-priority-followups.md,
  docs/operations/2026-09-27-public-ci-readme-recovery.md, docs/CODEX_HANDOFF.md.
  Node24 공식 고정 action SHA, contents read, concurrency/20분/manual dispatch, 과거 미배포 문서 교정.

## 실제 테스트 / 수정한 실패

- PR206 final CI36286197257(head a2e188d...) 단위1197/150파일, 통합886/90파일+todo1,
  typegen/tsc/lint/build 성공. lint 기존 경고1. 최종 focused independent review 추가 지적 없음.
- README retention 이전 구현 실제 RED2→crawl-fetch GREEN25, refresh guards GREEN5통합,
  visibility404 실제 RED1→GREEN8단위. PR201 health8+profile19=27통합,
  PR203 verify12+profile19=31통합, PR204 capped-network/readme25표적 테스트 실제 실행.
- PR202 unit1173/integration28/audit0, PR201unit1178, PR203unit1184는 각각 그 시점 base의 결과이며
  최종 PR206 전체 테스트가 최신 코드의 통합 근거다.
- 실패 접근: scoped esbuild override는 Vite optional peer invalid→검증된 global override;
  처음 retention-only는 발행 제품 리뷰 제외로 stale README 영구 보존→독립 refresh job 추가;
  repo404를 absence로 취급→현재 공개 여부 확인 실패 시 기존 sample 보존;
  정확한 cap 뒤 미종료tail wait→즉시 streamcancel;
  migration doc에 env-file 빠짐→정확한 local command 수정/격리 testDB에서 실행 확인.
- 실제 DB audit `/private/tmp/nmv-readme-audit-final.json`, 마지막 retry `/private/tmp/nmv-readme-recovery-retry.log`,
  hosted CI `/private/tmp/nmv-readme-refresh-hosted-ci.log`, quota/451 구분 로그는 private tmp에 있다.

## 아직 실행해야 하는 것 / 정확한 다음 명령

PR205 워크트리 `/private/tmp/nmv-ci-docs-20260927`에 최종 README/report/plan/handoff를 특정 파일만 commit/push.
최신 head의 hosted CI 성공 후 full SHA match로 병합한다(`--delete-branch`는 worktree 때문에 사용하지 않는다).
main push CI와 실제 workflow_dispatch를 확인하고 최종 소스8앱 배포/status 커밋·done/HTTP/worker progress를 확인한다.
README 입력은 끝났지만 키워드 자동 재생성은 pending; 진행 수치를 보고한다. root user dirty를 일괄 stage하지 않는다.

```sh
cd /private/tmp/nmv-ci-docs-20260927
git status --short
git diff --check
gh pr view 205 --json headRefOid,statusCheckRollup,state
# frozen head CI 성공 뒤 full SHA를 --match-head-commit으로 지정:
# gh pr merge 205 --squash --match-head-commit <fullSHA>
cd /Users/jr/Desktop/projects/nomorevibe
git fetch origin
git merge --ff-only origin/main
gh workflow run ci.yml --ref main
python3 /tmp/nmv-repair-ops-20260926.py deploy
python3 /tmp/nmv-repair-ops-20260926.py status
python3 /tmp/nmv-priority-ops-20260927.py health-check
python3 /tmp/nmv-priority-ops-20260927.py readme-audit
```

safe bridge는 Dokploy/Keychain env를 메모리로만 전달하며 값은 출력하지 않는다. DB 통합 테스트는
local55435/nomorevibe_test만 사용한다. API quota는 공유 제한을 존중한다. 복구 helper는 완료되어
불필요하게 다시 실행하지 않는다. 미검증: 운영 백업 복원/24h 연속 관측/랭킹 시즌 정책전환/이번 관리자 visualQA.
CUA available browser0와 native Chrome cgWindowNotFound로 실제 시각 QA는 수행하지 못했다.

---

# 2026-09-27 GitHub 저장소 공개 및 CI 전환 완료

## 현재 목적

사용자의 명시 요청에 따라 `JRVector9/nomorevibe`를 public으로 전환하고 실제 GitHub Actions CI를 실행한다.

## 완료 및 검증

- `git fetch origin` 후 Gitleaks v8.30.1로 `git --log-opts=--all --redact=100` 검사: 459커밋/13.16MB. 탐지6건은 tests/operations-agent의 합성 테스트 암호1건과 ranking fixture key5건으로 검토했다. 실제 인증정보 발견 없음. 일반 패턴 검사 결과이며 모든 비밀의 부재를 보증하는 것은 아니다. 보고서 `/private/tmp/nmv-public-audit-20260927/history.json`은 redacted다.
- `gh repo edit JRVector9/nomorevibe --visibility public --accept-visibility-change-consequences` 실행, `gh repo view`로 PUBLIC 확인했다.
- Actions enabled=true. 기존 `.github/workflows/ci.yml`은 push main 및 pull_request에서 Node24/PG17, 타입·린트·단위·통합·빌드를 실행하도록 구성돼 있어 변경하지 않았다.
- 기존 main0836bd77 CI run36250632287을 rerun했다. attempt2/job108508971991에서 runner_id1000015485, Set up job SUCCESS, Initialize containers 실행을 실제 확인했다. 과거 billing 때문에 runner0/steps0으로 실패하던 상태를 벗어났다. 최종 attempt2는 2026-09-27 08:36 KST completed/success. 타입·린트·단위·통합·빌드와 cleanup 전 단계 SUCCESS를 실제 확인했다.

## 파일·설계·실패 접근·남은 작업

이번 단계 저장소 소스/워크플로 수정 없음. 인계 문서만 갱신. 사용자 `scripts/search-judgments.json`과 untracked 자료는 변경·커밋하지 않았다. 공개 전환은 사용자 명시 승인 범위다. 최신 main 재실행을 선택해 불필요한 커밋이나 배포를 만들지 않았다. 실패한 접근은 없음; 요청 범위의 남은 작업 없음. GitHub hosted CI 전체 PASS. 기존 린트 경고1/빌드 경고1은 유지되며 실패가 아니다.

```sh
gh run view 36250632287 --json status,conclusion,attempt,jobs,url
gh run view 36250632287 --log-failed
gh repo view JRVector9/nomorevibe --json visibility,url
git status --short
```

CI watch session12643은 exit0으로 완료했다. 실제 run JSON은 `/private/tmp/nmv-public-audit-20260927/ci-result.json`, 로그는 `ci.log`와 `ci-watch.log`에 있다. 저장소 https://github.com/JRVector9/nomorevibe (PUBLIC), CI https://github.com/JRVector9/nomorevibe/actions/runs/36250632287/attempts/2 (SUCCESS). 앞으로 push main 및 pull_request는 기존 CI가 자동 실행된다. 이번 작업은 GitHub 설정 변경과 기존 run 재실행이므로 새 소스 커밋/배포 없음.

---

# 2026-09-27 수집·검색 프로필 수정 및 복구 완료

## 현재 목적과 완료 상태

사용자가 요청한 검토 항목2·3·4의 독립 PR 수정, 생성 입력 해시 재발 방지, 기존 불일치 프로필 복구와 배포를 완료했다. 운영 소스와 origin/main은 `0836bd77db8eadebc15d644c668c93d184119d64`다. 요청 범위에서 남은 수동 작업은 없다.

- 항목2 PR190, 항목3 PR189, 항목4 PR191, 해시 재발 방지 PR193, 운영에서 확인한 메모 쿼리 결함 PR194, 틱 예산 시간 초과 회계 PR195 모두 병합·배포했다. 기존 홈 테스트 격리 PR192도 병합했다.
- 2026-09-27 07:38:40 KST **동일한 REPEATABLE READ / READ ONLY 스냅샷**에서 공개 프로필 **19,306개** 전수 대조: 입력 해시 불일치0, 큐 미등록0, 검색 키워드 사본 불일치0, 프로필 누락0, 생성·검수 오류0, 갱신·검수 대기0. `repair-final-consistent.json`의 complete=true와 모든 카운터를 실제 확인했다.
- 이전 실패6건은 실제 생성·검수까지 복구했다. 마지막 추가 실패609는 정상JSON이어도 키워드1개가 바뀌어 검수가 거부됐다. 동일 모델에15개를5개씩3묶음으로 실제 검수해 모두 strict 응답 검증을 통과한 뒤, 기존 current-input/profile-version/lease 저장 경로로 한번에 저장했다. 부분 성공이나 새 해시만 덮어쓰는 처리는 하지 않았다. 검수 기준을 완화하지 않았다.
- 운영8앱이 동일 커밋으로 deployment done, 워커6개 healthy, 핵심8파일 SHA-256 대조48개 일치. 양쪽 웹HTTP200/DB정상2ms. RELEASE_TAG는 예전 환경값이므로 실제 커밋 판단에는 deployment description과 소스 대조를 사용했다.
- 임시 실행기 모두 종료(07:41 activeOwnedTemporaryPids=[]), 로컬 감시 프로세스도 종료했다. 함수bridge249 terminated, watcher62325은 의도적으로 SIGTERM 종료(exit143). 정상 생성·검수·근거 수집 작업은 최신 성공 기록과 last_error=null을 확인했다. 종료 후07:41 집계도 pending0/older0/unverified0/errors0이었다. 사용자 중단한 소개 검수(not_before2100)는 유지했다.

## 수정 파일과 설계 결정

주요 소스: `lib/domain/evidence/agents/collect.ts`, `lib/domain/products/{intro-checks,search-profile,search-verify,search-profiles}.ts`, `lib/jobs/products/{search-profile,search-verify}.ts`, `lib/db/schema.ts`, `drizzle/0048_search_profile_freshness.sql` 및 migration metadata, `scripts/reconcile-search-profiles.ts`. 회귀 테스트는 `tests/agent-evidence-collect.test.ts`, `tests/search-profile.test.ts`, `tests/search-verify.test.ts`, `tests/search-job-budget.test.ts`, 해당 integration 테스트와 `tests/integration/search-profile-note-correlation.test.ts` 등에 추가했다.

- GitHub compare의 파일 패치를 제외하는 요약 조회로 전역2MiB 제한을 유지하며 반복 수집 실패를 해결했다.
- 소개 교정 시 기존 키워드·프로필 무효화를 한 트랜잭션에서 처리했다.
- 잘못된 생성 구조와 불완전/중복/알 수 없는 키워드 검수는 성공으로 저장하지 않는다. 명시적으로 두 키워드 배열이 빈 경우는 유효한 결과다.
- 생성 입력과 최신 메모 변경을 DB 트리거로 감지하고, 실제 생성 입력 해시와 프로필 버전을 저장 직전 재확인한다. JS UTF16 slicing/trim 의미를 DB 감지와 맞췄다. 생성 실패 시 기존 키워드와 기존 생성 해시를 함께 보존한다.
- 메모의 외부제품 ID는 `products.id`로 SQL에서 명시했다. 틱 잔여 시간으로 줄어든 호출의 timeout은 제품 실패 횟수를 소비하지 않는다. 실제 전체 호출 제한을 넘긴 실패는 재시도한다.

## 실제 실행한 검증

최종 소스 PR195의 frozen head에서 `npx tsc --noEmit`, `npm test`, `npm run test:integration`(PostgreSQL17/localhost55438), `npm run lint`, `npm run build`를 실행했다. 단위 **1,173개**, 통합 **867개 + 기존 TODO1**, 타입·린트(오류0/기존 경고1)·빌드 PASS. 독립 Codex CLI 리뷰도 추가 지적 없음. `/tmp/nmv-search-budget-{typecheck,unit,integration,lint,build,review}.log`와 운영 검증 자료 참조.

GitHub Actions는 결제로 러너 실행 전 실패했다. run36250595448/job108427767520의 runner_id0·steps0·billing annotation을 확인했으며 exact head의 GitGuardian은 SUCCESS였다. 호스팅 CI가 성공했다고 주장하지 않는다.

## 실패했던 접근과 해결

- 기존 메모 테스트는 제품과 감사행 ID가 모두1이라 SQL 상관관계 결함을 놓쳤다. ID가 다른 회귀3개로 RED를 재현하고 수정했다.
- 작업 트리의 node_modules symlink는 Turbopack 빌드를 깨뜨렸다. 독립 APFS 복사로 해결했다.
- 예비 실험 마이그레이션이 남은 localhost55435 fixture는 최종0048로 복구하고 회귀3개를 실제 통과시켰다. 임시 PG55436/55437/55438은 종료했다. 기존 사용자 테스트 DB는 보존했다.
- 새 budget 테스트의 fake ctx.save 누락으로 첫 타입·빌드 검사가 실패했다. mock을 보완하고 관련 검사와 전체 단위·린트·빌드를 다시 실행해 통과했다.
- 모델 지연/키워드 크기만 추측해 제한을 늘리지 않았다. 609에서는 실제 응답 구조를 계측해15개 판정 중 unknown1/missing1을 확인하고 소량 묶음의 실제 검수로 복구했다.
- 페이지별 전수 순회는 조회 중 새 수집으로 순간적인 불일치를 포함할 수 있다. 최종 판정은 동일한 DB 스냅샷에서 전수 대조했다.

## 보고서·남은 파일·다음 명령

완료 보고서는 `docs/operations/2026-09-26-search-pipeline-fixes.md`, 증거는 `docs/operations/evaluations/2026-09-26-search-pipeline-fixes/`다. 실제 read-only 검사 코드는 `audit-readonly.ts.txt`에 보관했다. 문서와 운영 증거는 현재 워크스페이스에 남아 있다. 소스 변경은 모두 커밋·푸시·병합·배포됐다.

사용자 `scripts/search-judgments.json` 및 기타 untracked 사용자 자료는 변경·커밋하지 않았다. 현재 root의 소스 수정은 없고, 우리 handoff/운영 보고서 외 사용자 변경은 그대로 보존했다. 이전의 draft PR159/160(LAYA)은 이번 작업 범위 밖이다.

추가 상태 확인이 필요할 때만 아래 read-only 명령을 사용한다. `apply`, 마이그레이션, 배포나 임시 실행기를 다시 실행할 필요는 없다.

```sh
git status --short
git rev-parse HEAD origin/main
python3 /tmp/nmv-repair-ops-20260926.py quick
python3 /tmp/nmv-repair-ops-20260926.py snapshot
```

새 수집이나 원본 변경은 이후 정상 갱신 큐에 들어갈 수 있다. 이는 과거 복구 잔여가 아니며 정상 워커가 자동 처리한다. 아래는 복구 과정의 시점별 기록이며, 현재 완료 상태는 이 상단 요약과 최종 스냅샷을 기준으로 판단한다.

---

# 2026-09-27 07:34 最後1건 작은묶음으로실제검수복구

- Actual diagnostic609응답07:29:57: status200,finishReasonlength,completionTokens2723,prompt1322,contentChars10893,validJSONtrue/checks15,missing1/unknown1/duplicate0/nonBoolean0. 즉단순큰키워드배열아니며정상JSON에서도label하나가달라strict검수저장거절. 원문/키/근거내용출력않음. 현재invalid4/정상fullretry08:09:57,cap0. 성공으로강제않음.
- diagnosticownedPID29245 SIGTERM후(같은joblease) /tmp/nmv-verify-tail-chunks.ts 임시실행(현재28d96ed337e1/log同stem.log). ID60915키워드를5개씩3호출, 기존모델/strictparse/call60/동시1. 모든chunk가유효해야만removed합집합을recordVerificationResult기존currenthash/profileversion/leaseguard로한번저장. 불완전chunk는저장않고원본retry/attempt그대로(진단시도), fakekeyword/hash 없음. 정상전체15재시도반복과다른요청형태로복구하는 bounded수리이지검수기준완화아님. 최대5분, 실패면현재제품미검수유지하고root분석필요.
- 次: ssh jr@100.92.77.66 'docker exec 28d96ed337e1 tail -n 8 /tmp/nmv-verify-tail-chunks.log'; chunks3ok/savedtrue 확인→fullhash/keywordCopies0검증→ownedPIDcleanup추가path/tmp/nmv-verify-tail-chunks.ts 포함. 기존gen/verify긴helper는drained종료확인, diagnosticはSIGTERM. monitor249/watch62325계속.
- Repositorysource는변경않음; PR source모두배포끝, 사용자파일보존. 이singletonrepair로실제검수완료한뒤완료보고할것.

# 2026-09-27 07:16 마지막 검수 응답 구조 계측

- ID18 재시도검수완료,609만 invalid→timeout→invalid3 반복. keyword_count15/JSONchars274/max21, cross-langduplicates0이어서큰keyword배열가설은근거없음. 다음정상retry07:28:51KST. 지금강제성공/조기재시도않음.
- /tmp/nmv-verification-tail-diagnostic.ts 현재text28d96ed337e1에서실행,log同stem.log. 기존verify4/call60/105s틱/backoff/model 그대로, runJob기존lease사용;609가미검수이면futurebackoff에서도idlewait해서다른정상새verifications계속처리. Fetchwrapper는609 이름+URL의응답에만 finishReason/completionTokens/contentChars/JSON검사횟수/누락·중복·unknown·nonBoolean count를출력,원문·키·근거내용은출력하지않음. 실제parser/record결과는변경하지않음. 다음609응답형식원인확인후필요하면근거로별도fix;지금은추측코드변경없음.
- 기존gen4helper는06:56drained/verify2helper07:00drained 종료. 새diagnostichelper도최대4h 또는609검수완료&큐소진후종료. 최종ownedcleanup exactpath목록에 /tmp/nmv-verification-tail-diagnostic.ts 추가필수.
- Legacy gen대기0, 새source변경0→2→0정상worker처리. monitor249 /watchshell62325활성. 전체hash0최종대조는609완료후정식확인필요. 최종healthy/source0836/48SHA/bothweb200재검증자료alreadyfinalfiles。

# 2026-09-27 07:00 과거 재생성 완료 / 검수 재시도 대기

- 최초 복구 cohort 재생성은 끝났음: latest06:59 pending0/older0/missing0/generror0, 공개19301. 정상새수집으로pending0→1→0은발생하며기존워커가처리중. full06:59:34 mismatch1/unmarked0은동시새source갱신(legacy대기0); 후속현재hash0확인필요. keywordCopies checked19301/mismatch0. repair-generation-complete.json은과거cohort완료시점검사이며전체0완료증거아님.
- 검수609: invalid1다음진짜full60timeout2→retry07:07:06KST; ID18 timeout1→retry07:03:50KST. Cap0. backoff준수해서정상재시도기다릴것. 무조건성공/forcedhash/조기retry금지. 현재unverified3 (newsource1+failed2). verifierhelper는eligible없으면3idle후drained종료해도정상worker catalog interval60s로재시도계속. 최종두건실제검수/metadata clear확인필수.
- genhelper4.log drained06:56:33 종료확인. verifier2.log계속(07:55deadline). 원본실패6은이미모두복구. 운영 apps8 deploymentdone0836,gitfetch후HEAD=origin/main0836, worker6healthy/48SHA재검증 PASS, 양쪽web200/DBok2ms. latest증거 runtime-proof-final/deployment-status-final/web-health-final.json 저장.
- Watcher62325 / bridgecell249활성. 다음 functions.wait cell249<=60000; errorsretry정상wait, hash/keywordCopies0/missing0/unmarked0전체inspect→ownedtemporaryPIDs없음확인/SIGTERM필요시→normaljob/health/report cleanup. 아직검수2건이남아최종완료보고않음.

# 2026-09-27 05:50 생성 실행기 갱신

- pending375/unverified14/generror0/verifyerror0 at05:49. genhelper4h만료전 소유한 /tmp/nmv-generation-repair-lease.ts exact /proc cmdline 대상으로만 SIGTERM 후 동일코드 재시작. newlog /tmp/nmv-generation-repair-lease-4.log,4hdeadline09:50KST. 동시2/기존lease/게이트웨이backoff 유지. verifier log-2.log ~07:55deadline 그대로.
- monitorcell249활성; watcher shell62325(11:23deadline) healthy계속, final fullcheck조건이될때hash/keywordCopies/미등록/누락0 확인 및helper종료 필요.
- 보고서/하andoff외 source추가변경 없음. main0836bd77/모든소스 PR배포 완료. 남은 실제복구375건 및최종검증/cleanup/보고.

# 2026-09-27 05:23 모니터 갱신

- 이전 watcher shell93289가 예정된6h한도(exit4)로 종료. 오류/정체 때문이 아님. 동일 /tmp/nmv-watch-profile-repair.py 재실행, 새 shellsession62325, 6h한도11:23KST. repair-latest.json과repair-progress.jsonl 계속갱신, completed 시 repair-full-check.json 자동검증생성. functions.exec cell249 출력bridge는그대로활성.
- 마지막05:21pending541/unverified6/generror0/verifyerror0/cap0. 서버generation/verifierhelper정상계속. gen06:02만료전05:50잔여큐확인후renew; verifier07:55만료. 최종hash·검색사본0/미등록0/누락0 확인전완료보고않음.
- Next: functions.wait cell249<=60000, completion/stall 시 새watch session62325 write_stdin으로exit 확인. ownedhelpers cleanup/bothweb/workerhealth/report remaining.

# 2026-09-27 04:38 현재 작업 인계

- 목적: 항목2·3·4 분리 PR 수정 + 해시 재발방지 배포는 완료. 남은 기존 프로필 실제 재생성/검수와 최종 전수 해시 확인, 임시 실행기 종료, 최종 보고.
- 최신 full 검사04:22KST: 공개19276,pending849,hashMismatch757,unmarked0,검색 키워드 사본18429/mismatch0,missing0,generror0,verifytimeout2(cap0). repair-midpoint-0422.json 증거. 최신 quick04:37pending758/검수3/errors0. 원본 실패6건은 실제생성·검수완료.
- 운영 main0836bd77, source8apps배포/worker6healthy/핵심파일SHA48일치, 최종 실제검증 unit1173,PG17integration867+TODO1,type/lint/build PASS. CI billing으로 runner 미실행; GitGuardian exacthead PASS. PR189/190/191/193/194/195/192 모두 병합. 보고서 docs/operations/2026-09-26-search-pipeline-fixes.md를 최신 소스/검증/전수검사 중심으로 다시 정리했다.
- 활성 monitor functions.exec cell249: local repair-latest를55초마다표시, functions.wait cell249<=60000. shell93289의watcher실행은05:22KST 6h만료 예정이므로 미완이면 종료코드/실패사유확인후재시작(사용자요청pause아님).
- 임시 실행기는 text28d96ed337e1(jr@100.92.77.66): gen /tmp/nmv-generation-repair-lease.ts log-3.log 만료06:02KST; verify同pathverification log-2.log03:55재시작→07:55KST. 05:50 잔여가있으면 gen만 /proc cmdline exactpath 확인후SIGTERM/재시작, lease/concurrency2/4유지. 정상서비스전체중단금지.
- 다음명령: python3 /tmp/nmv-repair-ops-20260926.py quick; python3 /tmp/nmv-repair-ops-20260926.py inspect. 최종 full hash0/미등록0/검색사본0/누락0 및원본6복구확인→ownedhelper종료→6worker/bothwebhealth→보고서/인계갱신. 함수bridge249만 종료해도serverhelper/watch는계속이므로최종cleanup따로필요.
- 수정한 저장소파일은 docs/CODEX_HANDOFF.md, 우리untracked운영보고서/증거. 사용자 scripts/search-judgments.json 및기타untracked자료변경/커밋금지. 소스커밋은전부origin main과일치. 새코드나추가PR현재필요없음.

# 2026-09-27 03:55 verifier期限更新

- 03:54pending1009/unverified7/generror0/verifyerror0/cap0。既存owned verifier /proc cmdline正確path(/tmp/nmv-verification-repair-lease.ts)でSIGTERM後再実行, newlog /tmp/nmv-verification-repair-lease-2.log,4h deadline→07:55KST。Only ownhelper renewed; leases/concurrency4/defaultworkers intact. Generation3.log remains06:02deadline;05:50残れば同様更新必要。
- functions.exec monitorcell249 continues55s snapshotyield; shell93289 originalwatch6h期限05:22なら未完再起動。最終keywordCopies+mismatched/unmarked/legacy6/fullhealth/helperstop required。User artifacts preserved.

# 2026-09-27 03:11 실제 해시·검색색인 사본 대조

- /tmp/nmv-repair-inspect-20260926.ts read-only full inspector에 keywordCopies 추가. JSON 배열 en||ko 순서 유지, removed_keywords 제거 후 string_agg(' · ') 결과와 products.search_keywords IS DISTINCT FROM 비교. 최종 inspect/watch 자동fullcheck도 이 검증 포함한다. quick은 비용추가없이null.
- Actual full at2026-09-26T18:10:48Z: total19265,pending1223,older1221,hashMismatch1127,unmarked0,keywordCopies checked18044/mismatched0; generror0/verifyerror1/cap0/unverified7. evidence docs/operations/evaluations/2026-09-26-search-pipeline-fixes/repair-midpoint-keyword-copies.json 저장. 동시 수집/갱신 때문에 각 별도 SELECT count는 미세 snapshot차이 가능.
- 이전 monitorbridge184 terminated(JS bridge만중단,watch shell93289 계속운영). New functions.exec cell249 local repair-latest JSON을55초마다 text+yield_control 표시: functions.wait cell249<=60000사용. watcher 자체 shell93289는 여전히05:22까지, stdoutpoll은필요할때만. Final watcher fullcheck파일 여부도확인할것. 아직실제재생성완료아님.

# 2026-09-27 03:00 복구 진행 상태

- 현재 main0836bd77: PR190/189/191(각 항목2/3/4),193(hash재발방지),194(note상관쿼리),195(tick예산 실패회계),192(test격리) 모두 병합/8앱 배포 완료. 소스48 SHA확인, 마지막 실제 검증 unit1173/integration867+TODO1/type/lint/build PASS. HostedCI는 billing으로 runner실행전 실패, green아님.
- 최신 운영 quick at2026-09-26T17:59:26Z: public19263,pending1288,older1288,generror0,verifyerror2(cap0),unverified8,missing0. 원본 실패6건은 실제생성/검수 모두완료. 새 transient timeout/invalid은 기존 backoff로 재시도하며 성공으로 강제하지않음. 중간전체대조01:24KST mismatch1676/unmarked0, 최종전체대조는 아직 필요.
- Active monitor functions.exec cell184가shell93289를소유: functions.wait cell184 yield_time_ms60000 사용(동일shell 직접poll금지). report repair-latest.json / repair-progress.jsonl 계속저장. 모니터6h한도05:22KST 미완료면새로재시작할것.
- Active owned text28d96ed337e1 onjr@100.92.77.66: /tmp/nmv-generation-repair-lease.ts log*-3.log ~06:02KST expiry; /tmp/nmv-verification-repair-lease.ts log*.log ~04:07KST expiry. 03:55KST 잔여큐있으면 verifier만 exact /proc cmdline ownpath 확인후SIGTERM/restart. 동시2/4 및기존lease유지. 완료후ownedhelper모두종료/정상job확인필수.
- 다음: python3 /tmp/nmv-repair-ops-20260926.py quick; 최종 inspect 실제hash0/미등록0 확인, 원본6상태/누락0/양쪽웹health 확인, helpercleanup/report갱신. 사용자 scripts/search-judgments.json 및untracked자료보존. user 진행중질문답변: 현재1288건 실제재생성중, 완료라고하지않음.

# 2026-09-27 02:02 MLX 지연 조사/계속 처리

- 01:53 thin우선큐끝나고rich묶음선택됨(ids15k). MLXactualfulldeadline45초timeout5건연속발견(generror5/cap0), callerbudgetfalsefailure아님. metadata sizes: topics37~106/descriptions130~198chars,page/readmefull2000→실제모델각1500slice. oversizedtopics가설검증했지만문제없음, 불필요한inputhash변경/새PR않음.
- owngenhelperPID1943 SIGTERM후/tmp/nmv-probe-rich-profile-repair.ts(oneoff같은profilejoblease,목표15062/15053,최대동시2/timeout90)으로정상실제재생성시도. 15062는이미normalworker재생성돼큐에서빠짐. 15053actual같은근거 응답9481ms oktrue/savedtrue로그확인,45초내응답이라고정timeout변경의증거없음(이전2호출/이번1호출+시간대부하confound). defaultCALL45/SLOW20/concurrency2그대로. 단지upstream지연관측이며모델응답을성공으로속이거나hash덮지않음.
- genlonghelper재실행02:02 MAX4h→06:02,newlog /tmp/nmv-generation-repair-lease-3.log. 본script추가logging아직beforeIDs/revision/date만. Currenttext28d96ed337e1. verifier기존log/max4h→04:07,03:55쯤남은큐확인후필요하면재시작. 기존6문제 actualgeneration+verify복구상태유지.
- Currentpending1613at01:58/生成errors5(재시도대기)/verify0. root외부모델지연이라고해도기존hash잔여0확인전종료않음. monitorcell184shell93289(source6hr→05:22까지),그때미완이면normalbackoff/stall분석후monitor재실행.

# 2026-09-27 01:25 中간 전체 해시 재검증

- Actual full inspector /tmp/nmv-profile-repair-midpoint-0123.json at01:23:59: public19251,pending1769,older_generation_pending1769,hashMismatch1676,unmarked0,generationErrors0,verifyErrors0,unverified1. 모든잔여mismatchqueued, source현재hash과어긋난healthy/미등록0. 빈응답campaign때문에pending와hashMismatch갯수차이는정상.
- 원본6실패모두actualLLM재생성+검수완료및metadata확인. 이후간헐invalid/timeout재시도들도clear현재0. PR195 budget_deferred로그에서shortcallerDeadline타임아웃failed0유지 확인.
- Current main0836bd77, sourcefixes모두병합배포/검증끝. 남은실제backfill1769(+새수집source자동 갱신)/final全hash0/helpercleanup/report. Monitorcell184shell93289 (<=60wait),deadline현재6hr~05:22KST. genhelperrestart00:31(MAX4h→04:31), verifierhelper00:07(MAX4h→04:07). 04시쯤잔여가있으면ownhelperSIGTERM후재시작해기존2/4동시성병렬을유지할것(정상worker전체중단않음).
- Exact read commands: python3 /tmp/nmv-repair-ops-20260926.py quick; ssh jr@100.92.77.66 'docker exec 28d96ed337e1 tail -n 10 /tmp/nmv-generation-repair-lease-2.log'; ssh jr@100.92.77.66 'docker exec 28d96ed337e1 tail -n 8 /tmp/nmv-verification-repair-lease.log'. 원본fullfields출력금지/secretconfig keychainmemoryonly. 新規예외메타데이터localreportlatestJSONgenerationFailures/verificationFailures확인.
- User latest “진행중이야?” 답변commentary진행중1916대기/코드배포끝, 계속진행. 요청을취소하거나pause하지않았음. 기존합의대로최종mismatch0전완료라고하지말것.

# 2026-09-27 00:34 복구 진행·정체 검증

- Currentmain0836bd7,8deploydone/6workershealthy/source48matched/양쪽webDBok2ms.
- actualpastfailure6profile생성+검수완료메타데이터 /tmp/nmv-profile-cohort-progress-0018.json. latest00:31 generrors0/verifyerrors0. 기존genhash복구pending2168(아직전체미완료), fullsourcecheck마지막필요.
- modeldelay때문에genrate변동(<20sec정상tick/~20sec넘으면기존SLOW_CALL backoff유지). 같은id반복의심만으로추가코드변경않고generationbeforebatchIDs/revision/updatedAt만로깅. observed첫batch5169...다음5050...으로10개처리후정상앞으로진행, sourceRevision1(기존복구표시), 새sourceRevision반복변경아님. noadditionalFIFOchange.
- owngenerationhelperPID168SIGTERM후debuglogginghelper재시작, 새log /tmp/nmv-generation-repair-lease-2.log,newMAX4h시작00:31. 현재text28d96ed337e1. verifier기존/tmp/nmv-verification-repair-lease.log MAX4h시작00:07계속. modelCONCURRENCY2/4및gatewaybackoff그대로. 종료cleanup두path프로세스IDs확인후필요시SIGTERM.
- inspectorquick에older_generation_pending 추가(s.needs_refresh&&updated_at<2026-09-26T13:43:00Z), 과거generation기준이지정확cohortID스냅샷은아님.00:18 older2257=전체pending2257. report최종allhash0외에도olderpending/generationerror/검수legacy6확인해야함.
- monitorexec cell184(shell93289)동작중: report/evaluations/2026-09-26-search-pipeline-fixes/repair-latest.json &repair-progress.jsonl. 60초조회중, gen/verifycap 또는20분samecounts면exit3/6hr끝exit4. 그경우정상retry_at/backoff와실제정체구분해필요시재시작. strict완료조건pending0+errors0+unverified0+missing0에서전체hash0자동대조. 새externalinvalid출력을성공으로강제하지않을것.
- Next: functions.wait cell184<=60초; script최신source검증/로그원격조회명령은앞section참조. 몇시간모델호출이걸리더라도실제hash정렬완료전완료라고하지말것. PR195까지코드작업끝, 남은건backfill+최종검증+helpercleanup+보고서/compacthandoff마무리.

# 2026-09-27 00:09 PR195 운영 배포 완료 / 계속 복구

- 8 apps actual0836bd77done 확인. newtext28d96ed337e1, worker6healthy+핵심8파일SHA48개일치 /tmp/nmv-profile-runtime-proof-195.json. Rootreport evaluationdir에latestproof복사. 웹새cid는status명령output참조후health재검증.
- newtext에/tmp/nmv-generation-repair-lease.ts & /tmp/nmv-verification-repair-lease.ts 복사/재시작. 둘다기존lease/concurrency2/4/MAX4h/tick예산유지. logs /tmp/*-repair-lease.log. 이전cidba808e94ee7c helpers종료(oldcontainer replaced).
- fullsourcePR190/189/191/193/194/195병합/배포됨. code수정끝. 기존profile실제hash정렬진행: 00:07pending2334/verify9/generrors0/verifyerrors2. monitorcell184shell93289 계속notify; cap또는20분정체면중단해 root분석해야함. finalpending0/mismatch0 확인전완료라고하지말것.
- localtemporaryPG55438stopped(유일해당phaseactive였다), 기존사용자fixture55435canonical48/test3PASS상태유지. rootourhandoff/opsreport만uncommitted, 사용자scripts/search-judgments.json그대로M, 기타untracked사용자자료보존.

# 2026-09-27 00:05 後속 PR195 병합·배포 진행

- 추가발견: CALL_MS보다짧게틱남은시간때문에timeoutMs를줄여부른호출이끝나면productfailureattempt를누적함. 실제운영timeout도재시도중이라회귀로영향확인. 별도PR195https://github.com/JRVector9/nomorevibe/pull/195병합, main0836bd77db8eadebc15d644c668c93d184119d64.
- code: lib/jobs/products/search-profile.ts/search-verify.ts shorteneddeadline(timeoutMs<CALL_MS)의timeout은recordResult하지않고donefalse로다음틱에넘김. genuinefulldeadline실패는유지. tests/search-job-budget.test.ts fakeDate다중성공후shorteneddeadline만료를재현; RED2실패/2PASS->GREEN4PASS.
- fullunit1173 / fullintegration867+기존TODO1(PG17/55438) / type/lint(errors0warning1)/build 실제PASS. /tmp/nmv-search-budget-*.log. 처음testctx.save 누락type/buildfail수정후모두재실행PASS. independentCLIreview noactionable+4unit별도PASS.
- frozenhead c271e35b41a225281eaad2f594e54933453a317d GitGuardianSUCCESS, CIrun36250595448job108427767520 failure billedrunnernotstarted: runner_id0/steps0/annotationpaymentfailed확인. /tmp/nmv-search-budget-hosted-ci-{jobs,annotations}.json. PR195bodylocalreplacement증거기재, hostedCI성공이라고하지않음.
- rootmainff0836bd7+user scripts/search-judgments.json SHA보존. PR195deployment8appqueue중 /tmp/nmv-repair-ops-20260926.py deploy shell2814. Migration없음. runtimeproof8파일로늘려48개비교준비(추가jobverify). 배포후newtextcid찾고기존3helper파일복사, generation/verifylease둘만재실행. priority원본6이미모두actualverify완료이므로재실행필요없음.
- Last00:03 pending2347/verify22/generrors0/verifyerrors2. actualhash복구ongoing. monitorcell184shell93289 quick매60초+reportrepairprogress, baseline3kbackfillnonzero진행. 최종fullhash0와임시helperstop, 보고서갱신필요.

# 2026-09-26 23:30 過거 실패 전부 실제 복구 확인

- originalFailures6 중 generationfail18759재생성+verify이미success. 과거verifyfail5는 /tmp/nmv-prioritize-failed-verifications.ts의actual기존Qwen모델호출+recordVerificationResult로5건oktrue/savedtrue확인(ID1271,1829,4760,5366,5829). 해시만덮은것아님.
- 기존longverifyhelperPID278SIGTERM(소유helperfilepatharg일치로만중단), 동일lease해제확인후priorityverify가잡음. 임시priority는oldinvalidid8687도있어6번째재시도진행중. 로그docker exec ba808e94ee7c tail /tmp/nmv-prioritize-failed-verifications.log.
- fullverifyhelper재실행23:30 새로그 /tmp/nmv-verification-repair-lease-2.log (기존*.log는종료신호reason signal확인). generationleasehelper동시2변경없음. temporaryhelperscleanup최종필요.
- 현verifyfaildebug 대부분timeout(6개)과oldinvalid8687(1개),cross_language_duplicates모두0; 중복키워드관련추정으로코드변경하지않음. 정상backoff재시도중, cap0.
- 재생성대기2545,검수대기129at23:29. monitorcell184계속작동. 아직전체hash정렬미완료.

# 2026-09-26 23:25 보완 후 복구 대상 재대조

- 최신 PR194 code로 apply 재실행: scanned19240,mismatched2389,alreadyPending2613,queued1,verificationRetried0 (/tmp/nmv-profile-repair-apply-after194.json). 새로운조회상관관계로전체대조하여미등록추가1건queued; 기존복구중profile중복요청없음.
- 양쪽actual새웹container 8c4ab7540cba(M3),f781397c361b(mini) direct /api/health DBok1ms둘다확인. source proof42개일치/latest8deploy4d24c1b.
- 실행중monitor functions.exec cell184가shell93289출력을60초마다계속받아notify중. root다른tool과독립조회가능. pending2621/verify104at23:23. actualgeneration+verifyhelper동시정상처리, verify는strictparserinvalid출력2개재시도(backoff정상), cap0.

# 2026-09-26 23:24 실제 실패6건 복구·추가 처리량 보완

- 과거verify실패5 ID1271/5829/5366/4760/1829 PR194배포후actualLLM생성5개saved=true. 과거gen실패18759도이미saved=true. 검수cap5 ->0, 원본6개actual검수는아직확인전. /tmp/nmv-profile-repair-after194-2.json metadata참조.
- 기본55435fixture실험migration깨짐복구완료+actualfinal48migratePASS+ID분리회귀3PASS.
- APIquota23:21:54풀린후CIrun36247631966 job108419662771 runner_id0/steps0/conclusionfailure증거확보 /tmp/nmv-note-correlation-hosted-ci-jobs.json. billingannotation/GitGuardianSUCCESS과함께CI실행전실패확인완료.
- 생성도 /tmp/nmv-generation-repair-lease.ts 기존동시2/54초틱그대로 하나의profilejoblease로반복, 최대4시간orqueue3회빈경우stop. jobdone gatewayblocked이면30초backoff. 기존textworker는locked두잡을넘기고translate/tagline등실행, LLM동시제한늘리지않음. verifyhelper기존동시4 유지. 모두textcontainerba808e94ee7c에서/tmp/*-repair-lease.log.
- /tmp/nmv-watch-profile-repair.py 운영quick60초마다6시간내 자동모니터. shellsession93289. 보고폴더repair-latest.json+repair-progress.jsonl, 종료전에fullhashinspect. generationcap/verificationcap/20분정체면exit3으로분석요청. 아직완료아님.

# 2026-09-26 23:21 보완 PR194 병합·배포 완료 / 데이터 복구 진행

- Objective: 항목2/3/4 각각 PR 및 실제hash불일치 복구. PR190/189/191/193 모두 병합·배포; 추가 심사 메모 상관쿼리 PR194도 병합 main4d24c1b70f4301c38ecd5d58cf95c7177ec02527.
- PR194 실제검증: RED3 실패 -> GREEN관련31, 전체unit1169/integration867+기존TODO1/type/lint(build기존경고1)/build 모두 PASS. independentCodexreview코드문제없음. /tmp/nmv-note-correlation-*.log. GitHubCI billingannotation, exactheadGitGuardianSUCCESS; RESTquota로runner_id/steps 추가조회는 아직못했으므로 새head에대해3증거완료라고하지말것.
- 관련8apps deploydone4d24c1b 확인. worker6 healthy, source7개SHA42일치 /tmp/nmv-profile-runtime-proof-194.json. rootff동기화, 사용자scripts/search-judgments.json hash보존.
- text새container ba808e94ee7c. /tmp/nmv-prioritize-failed-profiles.ts + /tmp/nmv-verification-repair-lease.ts 원격복사 및실행. /tmp/...log로진행확인. priorcap5의saved=true와검수복구를확인해야함. helper최대4시간후stop또는queue소진stop.
- Latest23:17:55 pending2682, generationerrors0, verificationerrors9/exhausted5, unverified68. 실제재생성완료아님. 운영helperROOT와inspectorimports/proofexpected 모두최신root로변경.
- DedicateddefaultlocaltestDB55435 experimentalpartialmigration48: 마지막journaltimestamp1790428559333/needs_refreshonly/notrigger를확인, 자신이만든실험column+row만guardedtransaction으로제거후actualfinal48migrator실행PASS. 기본fixture에서새회귀3개PASS(/tmp/nmv-note-correlation-default-fixture.log). 55438finalfixture도유지.
- modifiedsource(committedPR194): lib/domain/products/search-profiles.ts, tests/integration/search-profile-note-correlation.test.ts. root Mhandoff(ours), Mscripts/search-judgments.json(user); 기존untracked사용자파일보존. 운영보고draft docs/operations/2026-09-26-search-pipeline-fixes.md 추가보완배포반영필요.
- Next commands: python3 /tmp/nmv-repair-ops-20260926.py quick; ssh jr@100.92.77.66 'docker exec ba808e94ee7c tail -n 20 /tmp/nmv-prioritize-failed-profiles.log'; ssh jr@100.92.77.66 'docker exec ba808e94ee7c tail -n 15 /tmp/nmv-verification-repair-lease.log'. 全hashinspector는종료근처 python3 /tmp/nmv-repair-ops-20260926.py inspect. actualhashmismatch0/legacyfailuresresolved까지진행, helpercleanup+양쪽health+최종문서필요.

# 2026-09-26 23:08 運영검증 추가발견/보완중

- CRITICAL: 과거verifycap5원본재생성 직접시도 정상LLM응답에도 saved=false, generationfailed1은 saved=true. /tmp/nmv-profile-failed-save-debug.json 원인 differentKeys reviewerNote뿐, taskNoteLength254~315, 저장직전 currentNote null, date/revision일치.
- 원인 Drizzle single-table select가 SQL템플릿 ${products.id}를 unqualified "id"로 변환. REVIEWER_NOTE 하위쿼리에서 a.product_id=a.id가 되어 products.id 상관관계가 깨짐. joined큐조회에서는정상. 기존테스트productId=auditItemId=1이라못잡음.
- 보완 worktree /private/tmp/nmv-note-correlation-20260926 branch fix/search-reviewer-note-correlation (base224525c). lib/domain/products/search-profiles.ts NOTE문자열에 products.id를명시적으로qualified. 새로운 tests/integration/search-profile-note-correlation.test.ts는 productid2/auditid1을강제, 메모있음/메모없음/검수3회귀.
- RED /tmp/nmv-note-correlation-red.log 3개모두saved=false실패실제재현. GREEN등검증 /tmp/nmv-note-correlation-*.log 진행중, 별도후속PR 필요. 이전4PR병합완료배포224인현재운영은이추가문제남아있음. 완료라고보고하지말것.
- 배포후우선 failedProfile5(ID1271,5829,5366,4760,1829) 재생성재시도. ID18759Hyperswitch 생성실패는새엄격파서성공/saved=true. 임시우선재생성script /tmp/nmv-prioritize-failed-profiles.ts 운영컨테이너 /tmp동일파일; log5false1true보존. 동일profilejoblease로중복MLX호출없음.
- 새text배포시 임시helpers삭제/프로세스정지됨. 새containerid확인후 /tmp/nmv-verification-repair-lease.ts 재복사/재실행해필요한기간Qwen검수병렬유지. helper관련root path를최신release코드로갱신. 양쪽web에도보완배포. migration변경없음.
- 루트 main을224525c로ff동기화완료, 사용자 scripts/search-judgments.json 해시보존확인. livehandoff는저장했다가다시복원해서M상태. 임시PG55438 docker nomorevibe-freshness-reviewed-test-db 재시작하여검증중.

# 2026-09-26 22:58 임시검수 실행기 보완

- 임시verification helper가 normaltextworker와 매틱 lease를 다투며 직렬대기가 재발할 수 있어서 /tmp/nmv-verification-repair-lease.ts로 교체. 기존 helperPID597SIGTERM, 새 helper는 하나의 product-search-verify lease(기존 heartbeat갱신) 아래 내부110초틱반복. Qwen동시4/MLX동시2는불변. 원래textworker는 lockedverify를건너뛰고 profile처리함.
- 새helper 최대4시간/eligible생성·검수queue3회빈경우정지. 새로그 docker exec f547adc9406c tail /tmp/nmv-verification-repair-lease.log. 요청한운영복구임시프로세스이며저장소서비스설정변경없음. 종료PID확인후 필요시SIGTERM.
- 22:54 pending2933, generationerrors0, oldverifycaps5(재생성대기), generated5m58/verified5m45. quick통계 계속수집, 아직hash복구완료아님.
- 다음: python3 /tmp/nmv-repair-ops-20260926.py quick 반복, full inspect는종료전만. 수집원본이계속바뀌므로 pending신규건과기존cohort는분리하여실제완료판정. helper종료후서비스정상/최신hash/검색사본재검증하고보고.

# 복구 모니터링 최종 상태/도구 (2026-09-26 22:52)

- 운영 큐 등록 완료3006. 22:50 full inspector pending2989, mismatch2756, unmarked0, 생성5m34/검수5m21, generation errors0, old verification capped5는 재생성 대기하여 아직reset전. 모든불일치가대기열에등록됨, 실제재생성끝나지않음.
- 임시 검수runnerPID597 textcontainerf547adc9406c, 정상첫틱11완료/0실패. 앞 phase 설명 참조.
- 모니터링 비용 축소: python3 /tmp/nmv-repair-ops-20260926.py quick 로 집계만(해시전체읽기없음). mismatch/unmarked null은 오류가 아니라quick에서생략. full inspect는전체원본을읽으므로 자주반복금지, pending0가까울때/final에서실행.
- 최신 파일들 /tmp/nmv-profile-repair-quick-1.json, /tmp/nmv-profile-repair-progress-4.json, /tmp/nmv-profile-repair-apply.json. 앞으로타임스탬프별quick파일과최종검증파일저장. 배포/검증모두완료(actualhash정렬만현재진행중).
- 완료기준: 기존cohort actualgeneration해시대조0, generationerrors/exhausted0, 과거검수실패5복구완료 및remaining정상검수상태보고. 임시helper종료확인. 메인모든수정PR189/190/191/193+fixture192병합완료.

# 2026-09-26 22:50 복구 대기열 등록 완료

- /tmp/nmv-profile-repair-apply.json: scanned19239, mismatched2783, alreadyPending13, queued3006, verificationRetried0. 과거 검수실패5도 근거해시가 바뀌어 생성부터 재개하므로 verificationRetried0은 정상.
- 요청한 수정 PR 모두 병합/최신224525c 배포 완료. 기존hash실제맞추기는 worker재생성/검수 계속 진행 중. root handoff 마지막 갱신만 로컬 미커밋, root 사용자변경 scripts/search-judgments.json 보존.
- 메인 검증종료. 생성한 임시PG테스트 컨테이너3개 stop진행(기존55435 nomorevibe-test-db 유지). sourceworktrees는 보존.
- 다음명령: python3 /tmp/nmv-repair-ops-20260926.py inspect > /tmp/nmv-profile-repair-progress-N.json ; ssh jr@100.92.77.66 'docker exec f547adc9406c tail -n 20 /tmp/nmv-verification-repair.log'. 매번 통계파일 at과pending/mismatch/오류/생성·검수5m율 확인. 임시검수helper max4h 및drained자동정지. 실제완료후 보고/문서 갱신.

# 2026-09-26 22:50 복구 처리량 보완

- 기존 text 워커에서 profile55초+verify110초를 직렬 실행하여 생성이 검수 기다림. 복구 기간 임시 verification helper를 text container f547adc9406c에 /tmp/nmv-verification-repair.ts로 넣고 docker exec -d 실행. 기존 product-search-verify job lease+동시4개 유지, profile 기존동시2개 유지. 정상서비스 설정/intro pause 변경 없음.
- helper stop: 최대4시간 또는 생성/검수 eligible 큐가3번 연속빈 경우 자동정지. 로그 docker exec f547adc9406c tail /tmp/nmv-verification-repair.log. 수동 중단 필요 시 그 파일명의 node PID를 ps로 확인 후 SIGTERM (코드signal보존). 재배포 시 임시파일/프로세스 사라짐.
- 22:48 mismatch2769, pending2255, 아직CLI미등록651. profile18 실제재생성, verify18 실제검수. apply 프로세스실행중 /tmp/nmv-profile-repair-apply.json.
- 절대 완료라고 보고하지 말 것: 실제 mismatch0/current profile provenance 대조와 검수큐/오류 확인까지 계속. /tmp/nmv-repair-ops-20260926.py inspect 로 전체통계출력. 원본변경 새데이터 정상pending은 따로실제완료 구분.

# 2026-09-26 22:47 실제 복구 모니터링

- 최종 배포 main224525c: M3 workers6 모두 running healthy, collector/parser/profile/intro/job/migration7개 파일 hash42개 일치. 양쪽 web done 동일커밋, /api/health 양쪽 DBok2ms. /tmp/nmv-profile-runtime-proof.json, /tmp/nmv-profile-mini-health.json.
- 통합 main 최종 type/lint(기존 경고1)/단위1169/통합864(TODO1)/build 통과 /tmp/nmv-pipeline-release-*.log.
- 운영 repair apply 실행 중(pid94348 당시): /tmp/nmv-profile-repair-apply.json 최종요약미출력, 약19k스캔+3000트랜잭션으로 수분 걸림. 최초baseline mismatch2780. 22:46 pending1050, 남은 미등록1894, 과거 빈응답 등 repair_version1 211.
- 새 text worker 22:47:08 프로필 실제18건 성공/0실패. 초반3건성공후 두틱0건이라 검증: pendingProfiles query248ms, 최신입력/작업해시/updatedAt/revision 모두 같음 /tmp/nmv-profile-save-debug.json. 새처리는 정상 시작됨, 아직 완료 아님.
- 근거 partial-invalid1195→1187 감소, complete27634→27643. 반복compare실패 일부 실제복구확인. 전체완료아님.
- 다음: apply 종료 확인 후 inspect 통계 반복(복구완료까지 actual mismatch 제거/검수확인), 느린 serialtext profile/verify 스케줄 검토. 소개 검수2100중단 유지. DB비밀출력금지.
- Dokploy deploy는 HTTP200 빈 body를 반환하므로 helper JSON parse만 실패했으나 실제8배포done 확인. helper는 빈응답처리로 수정했으며 불필요재배포 금지.

# 2026-09-26 22:42 검색 수정 배포/복구 진행

- 완료: 독립 PR189(소개 키워드 초기화),190(compare 작은 응답),191(엄격한 생성/검수 응답),193(자동 갱신/해시 복구) 모두 병합. PR192는 기존 홈 단위 테스트 DB 접근 격리. 최종 main 224525c(verify/pipeline-release-20260926 HEAD).
- 전체 CI 로컬 대체: 각각 타입/린트 오류0(기존 경고1), 단위1156~1168, 통합849/851/862 통과(기존 TODO1), 각 프로덕션 빌드 통과. 원격 CI runner_id0/steps0+결제 사유 확인, GitGuardian 성공. 정확한 PR head/CI증거 /tmp/nmv-pr-release-checks.json. 독립 리뷰4건 반영 후 D 재리뷰 추가 문제 없음.
- 운영 migration0048 적용 완료 /tmp/nmv-profile-production-migration.log. 운영 프로필19239, 해시 불일치2780, 자동갱신 대기4. 아직 수동 repair --apply 실행 전.
- 배포: /tmp/nmv-repair-ops-20260926.py deploy로 관련 M3 worker6+M3/mini web2 동시 배포 요청. 진행 /tmp/nmv-profile-deployment-status.json. API200은 완료가 아니라 대기열 등록. 실제 소스 hash 및 컨테이너 건강 확인 후 apply.
- 새 통합 검증 트리: /private/tmp/nmv-pipeline-release-20260926, 모든 변경 포함 최종 main. node_modules 사본으로 typegen/tsc/lint/unit/integration/build 실행 중 /tmp/nmv-pipeline-release-*.log. 운영DB로 테스트 금지.
- 다음 명령: python3 /tmp/nmv-repair-ops-20260926.py status; python3 /tmp/nmv-repair-ops-20260926.py inspect; 새 text code 및 8서비스 done 확인 후 python3 /tmp/nmv-repair-ops-20260926.py apply; 이후 inspect로 실제 mismatch 소진/검수 완료 확인. hash만 overwrite 금지. 복구 CLI repair_version1로 한 번만 재개.
- 운영 helper는 keychain 및 child env에만 비밀 유지, 출력/파일 저장 금지. 소개 검수 job not_before2100 유지. 기존 scripts/search-judgments.json 사용자 변경 보존. 모든 소스 수정은 독립 worktree에서 완료, 루트 소스에 변경 없음.
- 실패 접근: worktree symlink node_modules가 Turbopack filesystem root 밖이라 빌드 실패; cp -cR 로컬 사본으로 해결. 복사 중 실행 중인 통합 3~4 suite의 dependency 조회 실패가 발생하여 다시 전체 실행했고 모두 통과. 기본 main 홈 단위 2개 timeout 재현 후 PR192로 해결.

# 2026-09-26 검색 파이프라인 수정 진행

- 목표: 감사 항목 2/3/4를 각각 PR로 수정하고, 프로필 source hash 불일치 재발 방지와 기존 데이터 실제 재생성(해시만 덮어쓰기 금지).
- 독립 작업 트리: /private/tmp/nmv-evidence-compare-20260926 (fix/evidence-compare-response), /private/tmp/nmv-intro-keywords-20260926 (fix/intro-search-keyword-invalidation). 둘 다 origin/main 410c991 기반. 루트 scripts/search-judgments.json 사용자 변경 보존.
- 완료: A compare 관계 조회 page=2&per_page=1로 파일 패치 응답 제한 회피. 단위 27개 통과 /tmp/nmv-compare-green-final.log, 통합 29개 통과 /tmp/nmv-compare-integration-final.log. B 소개 교정 트랜잭션에서 searchKeywords 초기화. 통합 14개 통과 /tmp/nmv-intro-green.log. 각각 실제 RED 확인 후 GREEN.
- 수정 파일 A: lib/domain/evidence/agents/collect.ts, tests/agent-evidence-collect.test.ts, tests/integration/agent-evidence-repository.test.ts, tests/integration/agent-evidence-cursor-recovery.test.ts. B: lib/domain/products/intro-checks.ts, tests/integration/intro-check.test.ts.
- 미완료: 각 독립 리뷰/커밋/푸시/PR, C 응답 스키마와 키워드 전체 검수 강제, D 원본 변경 자동 갱신 + 최신 reviewerNote/입력 해시 저장 시 재검증 + 기존 2747개 불일치 실제 재생성, 배포/운영 검증.
- 설계: source_hash는 실제 생성 근거 해시로 보존. 원본 변경 시 needs_refresh 표시하여 worker가 실제 재생성, 저장 시 최신 근거 검사. 실패 시 이전 키워드 해시 덮어쓰기 금지. 별도 reconciliation dry-run/apply 스크립트.
- 실패 접근: 첫 A 통합 테스트의 이전 compare URL mock 2개가 실패, 새 query로 갱신 후 29개 통과. 동시 통합 테스트는 같은 로컬 DB를 사용하므로 앞으로 순차 실행.
- 다음 명령: cd /private/tmp/nmv-evidence-compare-20260926; git diff --check; codex review --uncommitted (모델 설정은 -c). B도 별도 리뷰. C 작업 트리 생성 후 tests/search-profile.test.ts, tests/search-verify.test.ts RED부터 진행.
- 운영: /tmp/nmv-health-20260925.py 및 /tmp/nmv-health-20260925-apps.json로 안전한 Dokploy 접근. 비밀 환경 출력/파일 저장 금지. 운영 DB에 통합 테스트 절대 실행 금지. 소개 검수는 2100까지 명시 중단 상태 유지.

# 수집·검수 및 검색 저장 감사 완료 — 2026-09-26 21:40 KST

## 목표 / 완료
사용자 “수집,검수과정문제및검색개선추가저장요소누락검토보고”. 코드·운영READ ONLY DB·원본대조·관련단위/통합·로컬재현·운영워커hash검증완료. 보고서 `docs/operations/2026-09-26-search-pipeline-review.md`.

## 핵심 발견 / 남음
- 검색공개19,217개후보/문서/프로필연결누락0,색인빈값0,category전부/값일치. 토픽/README사본차이0,본문차이초기1→재조회0. 성공키워드사본19,216개불일치0.
- README미확인12,089개(9월19일이전제품).표본8모두실제README있음.원본보충수집경로부재.신규공개9월20일이후버전미기록0.
- 활성근거partial/invalid883개;전체최신invalid908개전부커밋compare단계.공개API4개HTTP200/ahead이나본문2MiB초과재현.현공통클라이언트invalid로막고15분재시도.원인확인4개를전체로확대단정금지.작은페이지표본1은1.17MB로성공.
- 소개수정후profile만삭제/search_keywords잔존,생성HTTP502실패후잘못된키워드유지로컬재현.운영orphankeywords0.수정필요latent버그.
- `{}`생성답ok빈배열,checks[]검수성공허점재현.성공빈프로필261개중허점때문인지원문미저장이라확정불가.생성실패1/검수실패5는한도5로자동대상제외.
- 현재증거해시와불일치2,747/19,216개;30일재생성정책은의도적,내용변경인지본문숫자인지미분류.프롬프트판/검사범위메타부족.
- 소개검수보류2100년그대로,선택함수대상43개;임의재개안함.근거enforceEligibility/displayObservedFacts=false는기존설정.

## 변경 파일 / 결정 / 검증
보고서와 `docs/operations/evaluations/2026-09-26-search-pipeline-review/` JSON6개+로그2개+읽기전용스크립트.txt3개,이handoff.소스수정·운영변경·커밋·push·배포없음.사용자scripts/search-judgments.json변경및기존untracked보존.
단위7파일69PASS,통합7파일101PASS+1TODO(전용localhost55435/nomorevibe_test).로컬proof소개수정/생성실패잔존재현.운영소스관련9파일현재코드와hash일치.공개GitHub비교4/README8GET성공.전체build/lint/test미실행.집계1차regexp역참조템플릿이스케이프→SQLundefined오류,split_part로고쳐READ ONLY조회완료;최초rollback.테스트는운영DB에절대실행하지말것.

## 다음 명령
```sh
cd /Users/jr/Desktop/projects/nomorevibe
cat docs/operations/2026-09-26-search-pipeline-review.md
git status --short
python3 /tmp/nmv-health-20260925.py search
python3 /tmp/nmv-health-20260925.py search-detail
npx tsx .crawl-samples/admin-ui-review/search-proofs-20260926.ts
```
/tmp helper존재시만사용.읽기전용audit출력/tmp/nmv-search-{audit,detail}-20260926.json,proof는고정전용로컬DB만사용.다음수정우선순위는보고서끝참조.운영재처리/재배포요청은이번감사와별개로검증후진행.

---

# 수집 중단 의심 점검 완료 — 2026-09-26 21:12 KST

## 목표 / 완료
사용자 “수집이 멈춘거같아” 확인. 운영DB/워커/스케줄러/실행로그 조사 후 다음 예약 배치 직접 관찰. 실제21:11:47 신규41건 발견 →21:12:03 원본41건 수집, 실패0. 수집 중단 아님. 21:09스냅샷1시간원본170/AI1성공38회/AI2성공26표/발행15. 큐0,워커healthy,스케줄러heartbeat정상. 신규발견10분주기 vs UI최근1분·5분집계라중간0으로보임. 코드·운영설정·배포수정없음.

## 변경 / 검증 / 결정
`docs/operations/2026-09-26-crawl-check.md`, `docs/operations/evaluations/2026-09-26-crawl-check/`집계4개,이handoff. 사용자변경scripts/search-judgments.json및기존untracked보존. READ ONLY SQL/DokployGET/healthHTTP200/SSH상태·로그조회성공. 단위·통합테스트미실행. 잘못된lib/jobs/crawl/seed.ts경로조회실패,실제주기는catalog에서확인. 정상예약진행을확인해강제실행·재시작하지않음.

## 남음 / 다음 명령
현재중단문제없음. 후속UI개선권장: 마지막수집/다음발견예정/10분또는1시간처리량표시. 이전근거오류·생존확인용량·사람대기문제는해결되지않음. HEAD410c991. 9앱autoDeploytrue확인;아래과거restore명령재실행금지.
```sh
cd /Users/jr/Desktop/projects/nomorevibe
cat docs/operations/2026-09-26-crawl-check.md
git status --short
python3 /tmp/nmv-health-20260925.py audit
python3 /tmp/nmv-health-20260925.py status
```
helper가남아있을때만사용. 기존helper출력은/tmp/nmv-health-20260925-{db,apps}.json으로덮어쓰므로당일증거로복사할것. 운영DB테스트금지.

---

# 수집·평가 운영 상태 점검 완료 — 2026-09-25 09:43 KST

## 현재 목표 / 완료
사용자 “크롤링등은 잘하고있어? 수집 평가등”에 대한 읽기전용 운영 감사. 수집·AI1/2·발행 진행 확인. 1시간 수집174, AI1성공46회, AI2성공31표, 발행16. 핵심 준비 큐0, 최근5분 진행 있음. 9앱done/autoDeploytrue, 핵심7워커healthy. 운영 변경·재배포·커밋·push 없음. HEAD c7937d1이며 아래9월22일 기록보다 이후 코드가 배포됨. **아래 과거 autoDeploy restore 명령을 재실행하지 말 것. 현재9개 모두true를 확인했다.**

## 주요 문제 / 남은 작업
- 근거 partial/invalid841개는 전부 커밋 대기. 1시간 invalid39회(서로 다른39repo), 원인 미확정. upsert라 DB행 수로 반복 횟수 판단 불가. 실패 사유 세분화 후 영구 오류 재시도 정책 검토 필요.
- 생존 확인 공개18,730개, 6시간 초과13,330개. 코드BATCH15/동시3/매분, 로그900건/시간으로 상한. 목표52건/분 이상, 배치와HTTP동시성 함께 개선 필요.
- 사람 판단 대기1,694개 중 split1,528. 소개문 검수는 not_before2100년으로 보류; 사유 미확인, 임의 재개 금지.
- GitHub호출제한 재시도 존재. RELEASE_TAG는611820d로 오래됐고 실제배포description과 다름.

## 변경 파일 / 판단 / 검증
`docs/operations/2026-09-25-pipeline-health.md`, `docs/operations/evaluations/2026-09-25-pipeline-health/` 집계5개, 이handoff. 무관untracked보존. 작업은 감사이므로 운영 설정/큐 수정하지 않음. curlhealth200/DBok2ms, DokployGET, READ ONLY DB집계, SSH docker상태·1시간로그 성공. 단위/통합테스트는 미실행. 실패 접근: 잘못된 uptime-ping.ts 경로와 GitHub glob경로를 rg로 바로잡음; pause감사target조회0건; 동일스캔 upsert 때문에 repeated행조회는 반복실패 증거로 사용불가.

## 다음 명령
```sh
cd /Users/jr/Desktop/projects/nomorevibe
cat docs/operations/2026-09-25-pipeline-health.md
git status --short
python3 /tmp/nmv-health-20260925.py status
python3 /tmp/nmv-health-20260925.py audit
python3 /tmp/nmv-health-20260925.py detail
```
도구가 남아 있을 때만 사용. `/tmp/nmv-health-20260925.py`는Keychain키/DATABASE_URL을메모리로전달하는읽기전용launcher; 실제SQL은ignored `.crawl-samples/admin-ui-review/health-20260925{,-detail}.ts`. 운영DB에테스트금지. 후속수정은원인확인후별도검증할것.

---

# 관리자·처리 속도 운영 배포 및 검증 완료 — 2026-09-22 07:24 KST

## 완료 결과
- 사용자 “배포해” 지시에 따라 구현57파일 `611820d63096f54700e1254634987046d25cbe01` main commit/push, Dokploy 웹M3·mini2개 + M3워커7개에동일커밋배포완료. 9앱새deployment done/description동일SHA.
- 실제9컨테이너release일치/restarts0, 웹2개직접healthHTTP200/DBok(1·2ms), 7워커healthy/수정lib소스12개모두hash일치. 외부health도HTTP200/동일release.
- 운영status/ranking 브라우저8PASS,console/JS오류0. 5단계실제집계/AI2표단위/10초갱신/중지/필터/랭킹/375px가로넘침검증. 운영PNG직접검토. 상태화면ready4031ms,랭킹2130ms는1회브라우저표본.
- 배포요청22:19:44UTC~22:22:27UTC워커로그222건에서job.failed0/실패event0. GitHub수집한도재시도reset22:22:30UTC관측(임의우회/토큰변경안함). 새발견22건및기타워커완료확인. 끝난서비스/모든후보문제해소라고확장하지말것.

## 검증·제약
정확한커밋clean checkout `/tmp/nmv-admin-release-check`,Node24.18.0,npmci/typegen/tsc/전체lint(기존vendor경고1,error0)/unit144파일1118/통합83파일809/productionbuildPASS. GitHub CI상태조회는403API한도로불가. 최초통합seed1FAIL(808PASS)은단독seed100회/queue200회재현안되고,원커밋전체재실행809PASS. 원인미확정/런타임수정없음. 상세validation.json에첫실패보존. 이전운영익명관리자접근정책은여전히미결이며변경안함.

## 변경·증거
소스변경목록은아래구현기록/611820d참조. 배포문서커밋은이handoff,기존보고2개후속링크,`docs/operations/2026-09-22-admin-deployment.md`, `docs/operations/evaluations/2026-09-22-admin-deployment/`(release/runtime/검증/이벤트집계/브라우저/실운영PNG)만포함한다. 무관사용자untracked보존. 마이그레이션/DB수동큐수정없음.

## 마지막 복구 단계와 재개 명령
이문서스냅샷은후속문서push전이다. 원래9앱autoDeploy=true를새receipt에저장했고중복배포방지를위해일시false로두었다. **문서commit/push직후아래restore와status를실행하고9개true인경우에만최종완료보고한다.** 다음에이handoff를읽을때복구를무조건재실행하지말고status부터확인한다. `/tmp/nmv-admin-release-state.json`와원격상태가최신근거다. 코드재배포불필요.
```sh
cd /Users/jr/Desktop/projects/nomorevibe
python3 /tmp/nmv-admin-release.py restore
python3 /tmp/nmv-admin-release.py status
python3 /tmp/nmv-admin-runtime.py /tmp/nmv-admin-runtime-postrestore.json
git status --short
```

---

# 관리자·처리 속도 기능 운영 배포 진행 — 2026-09-22

사용자가 “배포해”를 명시 지시했다. 아래 검증 완료 변경 전체(관리자 로직 수정/랭킹/헤더 필터/처리 속도)를 선택 커밋·main push 후 M3·mini 웹2개와 M3 singleton 워커7개에 동일 SHA로 배포한다. 무관 사용자 untracked는 제외한다. 시작 HEAD d6ed3c7, origin/main과 차이0. prod 스킬과 기존 Dokploy curl API 절차 적용.

새 helper `/tmp/nmv-admin-release.py`는 preflight/pause/release/deploy/status/restore. receipt `/tmp/nmv-admin-release-state.json`에 현재9앱 원래 autoDeploy값을 저장했다. **push 전에 autoDeploy를 일시 pause하고, 운영 검증·배포 문서 push 후 restore해서 전부 원래 상태임을 확인할 것.** 이전 cursor helper의 receipt는 건드리지 않는다.

구현 검증은 아래에 기록. 배포 도중 Next shared server-action key 유지와 RELEASE_TAG/NEXT_DEPLOYMENT_ID 동일 SHA 주입,9앱새 deployment done 및 실제runtime확인,외부status/ranking/health QA가 남았다. GitHub CI가 과거 결제/한도와 같은 이유로 실행되지 않으면 정확한 커밋의 clean checkout에서 동일 검사 전부 실행한다. API 키/환경 변수 원문을 출력·저장·커밋하지 않는다. 운영 데이터 변경이나 새 마이그레이션은 없다.

## 배포 중간 체크포인트 — 07:20 KST

- 구현57파일 `611820d63096f54700e1254634987046d25cbe01` main 커밋·push 완료. 9앱autoDeploy=false, 원래true는새receipt에보존. RELEASE_TAG9앱/NEXT_DEPLOYMENT_ID웹2앱일치 및공유Actions키동일확인. 9앱동시deploy요청중. helper/receipt는위경로.
- GitHub CI조회는HTTP403 APIrate-limit으로불가(결제실패라고단정하지말것). `/tmp/nmv-admin-release-check` clean detached611820d에서npmci/typegen/tsc/전체lint(0오류,기존vendor경고1)/unit1118/productionbuildPASS.
- 전체통합첫실행808PASS/seed1FAIL(기록된pending2인데즉시dequeue가빈값). 별도queue200회·동일seed100회포함114tests재현안됨. 진단파일은복원했고원커밋clean tree에서전체통합83파일809PASS(94.68s). 원인은확정하지않았으며임의prod코드수정없음. `/tmp/nmv-admin-release-clean-integration{,-recheck}.log`, `/tmp/nmv-admin-{frontier-clock-probe.json,seed-reproduction.log}`.
- 남음: 모든새deployment done(이전deploymentID와구분),runtime웹health/워커12개변경lib소스hash+release검증,운영status/ranking브라우저QA,배포문서commitpush,autoDeploy9개restore후확인.

---

# 운영센터 처리 속도·병목 표시 완료 — 2026-09-22 06:35 KST

## 현재 목표와 상태
최신 사용자 요청은 `/admin/status` 상단의 실시간 대신 `10건/1분` 같은 수집·심사 처리량과 병목을 보는 것이다. 이전 관리자 검토/랭킹/헤더 필터 변경을 보존하고 후속 구현했다. HEAD `d6ed3c7`, 기존 및 이번 변경 모두 미커밋·미푸시·미배포. main push는 운영 9앱 자동배포를 유발한다. 이전 배포 autoDeploy 복구는 완료됐으므로 아래 과거 restore 명령을 재실행하지 말 것.

## 완료
- 상단 5단계 수집/규칙/AI1/AI2/발행: 최근1분,5분평균,대기,경과,오류기록,재시도·조건대기 별도표시. AI2단위는표. 모든탭공통,375/768/1440px 대응.
- worker의 rules/firstAI 큐 predicate를 공통화하여 count/oldest에 재사용. AI1 LIMIT100 없이 실제 준비된 전체큐 집계. 발행은 현재 심사/분류조건과 동일한 filter.
- 최근 저장 항목 기반이며 호출횟수로 과장하지 않음. AI1모델속도는rules/reuse제외하되 상태용progress에는 포함. 자동꺼짐·빈큐·정체의심·대기많음 구분. 2차retry경과 공통상수로보정;first/publish경과는갱신시각추정임을명시.
- 운영readonly측정 최초7183ms, JIT컴파일7340ms가원인. 읽기전용transaction 내 SETLOCALjitoff + publishReady materialized1회계산→최종281ms 한표본. 전역DB변경없음,마이그레이션없음. statementtimeout3s,조회실패면속도불가표시+기존화면유지.
- 기존실시간→자동갱신,10초visible-tab refresh/중지유지. 기존24h지표의'멈춘곳없음'단정제거.
- 서브에이전트domain:큐predicate/회귀+리뷰,ranking:속도UI. 최종domain재검토에서추가critical/확정오류없음(읽기전용검토). 상세 `docs/operations/2026-09-22-throughput.md`.

## 이번 추가/수정 파일
추가 `lib/operations/{throughput,throughput-model}.ts`, `app/admin/status/{ThroughputStrip.tsx,throughput.module.css}`, `tests/{operations-throughput,operations-throughput-display}.test.ts`, `tests/integration/operations-throughput.test.ts`, 보고서/증거 `docs/operations/2026-09-22-throughput.md`, `docs/operations/evaluations/2026-09-22-throughput/`.
수정 `lib/crawl/{agent-review-repository,repository,second-review}.ts`, `tests/integration/agent-review-records.test.ts`, `app/admin/status/{page,OperationsCenter,LiveRefresh,PipelineRail}.tsx`, 이handoff. 이전태스크파일/사용자untracked는아래목록대로보존.

## 실제 검증
- 전체단위144파일1118PASS `/tmp/nmv-throughput-full-unit.log`; 관련단위14PASS `/tmp/nmv-throughput-unit.log`.
- 최종관련통합3파일80PASS `/tmp/nmv-throughput-final-integration.log` (throughput8+secondreview57+firstrecords15). worker관련3파일88PASS `/tmp/nmv-throughput-worker-regression.log`. 이전전체통합799PASS와구별. DB는전용localhost55435/nomorevibe_test만사용.
- 최종Next build PASS `/tmp/nmv-throughput-build-final.log`; tsc PASS `/tmp/nmv-throughput-types-final.log`; 이번14개TS파일ESLint PASS `/tmp/nmv-throughput-lint.log`; gitdiffcheck PASS. 저장소전체lint는아래기록의무관untracked복사본문제로실패하므로전체lintPASS라고말하지말것.
- production standalone localhost43129 브라우저10PASS `/tmp/nmv-throughput-browser-final.log`, console/JS오류0. 새DBfixture로처리10건/분/규칙정체/2차대기과다/첫AI중지,단위,10초갱신·중지·탭·375/768/1440px가로넘침없음. 화면PNG직접열어검토완료.
- 운영읽기전용집계측정결과및수치한계는증거폴더query-performance.json. 워커속도개선율이아니라새조회쿼리최적화표본이다.

## 실패 접근·주의
- 첫통합fixture에frontier.signal누락→fixture필수값추가. retryinterval CASE 파라미터가text로추론되어text*interval오류→integer명시후8개신규통합모두PASS.
- 단일복잡쿼리그대로는JIT컴파일로7초이상걸려버림→local transaction jitoff로해결. 백오프/재사용을무시한초기정체기준도리뷰로고쳤다.
- 정확한ready시각이없는first/publish의경과는추정이며경고는의심단계다. 문서/판정/2차는마지막시각을덮으므로전체시도이력이아니다. 10초마다기존페이지전체refresh하는구조유지.
- 별도사용자Next서버3000/PID93803손대지않음. 로컬QA43129는검증종료후중지완료(exec3134 exit130). 운영익명관리자접근미결정책은이번에변경안함.

## 다음 명령
구현/검증완료. 추후릴리스시이전관리자작업변경도포함하여범위검토하고명시적파일만stage할것. 사용자무관untracked(`.claude/`, `docs/PT/`, 기존9월14일자료, `nomorevibe-final/`,html/zip,`prototypes/`)보존.
```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
git diff --check
npm test
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55435/nomorevibe_test npm run test:integration -- tests/integration/operations-throughput.test.ts tests/integration/second-review.test.ts tests/integration/agent-review-records.test.ts
# 브라우저QA는위통합과동시에돌리지않는다. fixture가전용DB를리셋한다.
DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55435/nomorevibe_test TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55435/nomorevibe_test npx tsx .crawl-samples/admin-ui-review/seed.ts
DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55435/nomorevibe_test npx tsx .crawl-samples/admin-ui-review/seed-throughput.ts
# 최신standalone서버43129구동법은아래인수인계참조. seed후60초안에시작(최근1분assert).
/tmp/nmv-admin-qa-venv/bin/python .crawl-samples/admin-ui-review/verify_throughput.py
cat docs/operations/evaluations/2026-09-22-throughput/browser-checks.json
```

---

# 관리자 전반 검토·랭킹 재설계·운영센터 헤더 필터 완료 — 2026-09-22 06:00 KST

## 현재 목표와 상태
사용자는 관리자 로직 전체 검토, `/admin/ranking` 가독성 개선을 서브에이전트 병렬로 지시했다. 앞선 `/admin/status` 헤더 필터 요청도 함께 수행한다. 액션/API/auth, 도메인 집계/정책, 랭킹 UI를 3개 에이전트로 나눴고 부모가 필터 및 통합검증을 담당했다. 기준 HEAD `d6ed3c7`, 이번 작업은 미커밋·미푸시·미배포다. 기존 무관 untracked는 보존했다. 이전 배포의 autoDeploy 복구는 이미 완료돼 있으므로 아래 옛 기록의 restore 명령을 다시 실행하지 않는다.

## 완료 구현
- 잘못된 slug/오래된 폼 및 동시결정으로 제품 차단과 기록이 달라지는 2차 심사·발행분 감사·내림 요청 3경로를 transaction+제품 세대/관련행 잠금으로 수정.
- 수집 기본값 복원의 동시 중지 덮어쓰기, 무제한 queryCount 배열 생성, 수동·미검증 등록의 publisher 처리량 오집계 수정.
- 근거 누락 갈래 판정/재판정, 재판정의 관리자 결정 덮어쓰기/처리 건수 과장, AI 마지막 성공 판단과 최신 실패 상태 표시 불일치 수정.
- 랭킹 현재 시즌/예약/설정6그룹/미리보기/이력 재설계. 고유 유입자 설정3개 비교 누락, 쉼표/소수 쿨다운 편집, 숫자 입력 폭 보완.
- status 후보검색/갈래/AI/최소별/푸시 헤더 필터. 서버에서 전체 대기→필터→14건 pagination, URL 조건 유지·변경시1쪽, 범위밖 마지막쪽 redirect. 탭 URL `?tab=ai` 초기선택 복구, 별 줄바꿈 방지, 수집지표 문구 구체화.
- Next 설치 page/searchParams/Form/server-client docs 읽음. webapp-testing, TDD, 도메인/액션 systematic-debugging 사용. 별도 운영 변경 없음.

## 변경 파일
`app/admin/{actions.ts,review/actions.ts}`; `app/admin/status/{page,OperationsCenter,QueuePreview}.tsx`, 신규 `queue-filters.ts`; `app/admin/ranking/{page,RankingPolicyForm}.tsx`, 신규 `ranking.module.css`;
`lib/crawl/{admin-review,product-audit,settings}.ts`, 신규 `published-second-review.ts`; `lib/domain/products/{repository,takedown}.ts`; `lib/operations/pipeline.ts`;
단위 `tests/{admin-ranking,crawl-settings-form,operations-queue-filters}.test.ts`; 통합 `tests/integration/{admin-review-batch,admin-review-causes,product-audit,takedown,admin-domain-review,admin-published-second-review}.test.ts`;
보고서 `docs/operations/2026-09-22-admin-{review,domain-review}.md`, 증거 `docs/operations/evaluations/2026-09-22-admin-review/`, 이 handoff.

## 실제 검증
- 최종 단위 **142파일1109PASS**, `/tmp/nmv-admin-unit-complete.log`.
- 전체 통합 **82파일799PASS(88.43s)**, `/tmp/nmv-admin-integration-full.log`. 전용 localhost55435/nomorevibe_test만 사용. 운영DB를 테스트에 넣지 말 것.
- 최종 Next production build PASS `/tmp/nmv-admin-build-verified.log`, `npx tsc --noEmit --incremental false` PASS `/tmp/nmv-admin-types-verified.log`, diff검사PASS.
- `npm run lint`는 기존 사용자 untracked `nomorevibe-final/` 복사본을 스캔해3424오류/57948경고로 실패. 이 파일들은 수정하지 않았다. 대신 **모든 git tracked 소스+이번 신규TS**를 명시한 ESLint는0오류/기존vendor unused경고1로 완료(`/tmp/nmv-admin-lint-source.log`). 전체 lint 무오류라고 말하지 말 것.
- 운영 갈래 필터 비용: 새 코드로 읽기전용 BEGIN READ ONLY에서999후보/9갈래 **533ms** 한 표본, truncated=false. `/tmp/nmv-admin-cause-performance.json`. 일반 규모 성능 보증/확정 개선율 아님.
- 로컬 production standalone+fixture36후보/3랭킹제품으로 **브라우저14항목PASS, JS/console오류0**. `.crawl-samples/admin-ui-review/verify_ui.py` 최종실행10680 exit0. 390/768/1440px 두화면 가로넘침없음, 필터/페이지/탭/쿨다운편집/예약/취소확인. 실제CSS충돌(필터버튼흰글자/랭킹순위폭)수정후재빌드·재검증. 결과와7스크린샷은 `docs/operations/evaluations/2026-09-22-admin-review/`. QA서버43129는검증후중지완료(exec59830 exit130).

## 실패 접근과 남은 위험
- 기능이 없는 첫 unit은 missingmodule RED; 별수 실제 DB 회귀 expected2/received4 RED후13PASS. 다른 경합/불일치도 각 담당이 실패재현후 회귀통과(도메인 상세보고서).
- 병렬 CSS파일 작성중 첫 전체단위는 CSS module미존재1suiteFAIL; 완성후 최종1109PASS.
- 성능 도구 첫연결 startup파라미터는 PgBouncer08P01, reserved연결의Drizzle options누락TypeError→prepare:false+명시read-only transaction+원client.options전달후성공. 운영 변경없음.
- Python QA 파일명inspect.py가표준모듈을가려실패→capture_ui.py로변경. 최초상호작용검사는Next SPA URL반영을기다리지않은assert,전역[name=q]중복선택으로실패→URL predicatewait와큐영역selector로고침. 이들은앱실패가아님.
- **운영 익명 관리자 접근은 그대로 남음**. 새 브라우저로status진입확인. 과거 handoff의ADMIN_LOCAL_LOGIN=1/OAuth미구성,접근정책질문미응답상태. 현재끄면운영자도잠기므로운영설정변경안함.
- 공개 requestTakedown의새요청vs관리자처리경합은별도미재현검토가능성. 큰큐갈래재판정은최대2만상한/화면표시,현재표본외성능보증없음.

## 남은 작업과 정확한 다음 명령
구현·전체단위/통합·브라우저검증·스크린샷시각검토·보고서작성완료. 남은작업은미해결운영접근정책및추후릴리스다. **커밋/푸시/배포를이번작업에서수행하지않았다.** main push는9앱자동배포를일으킬수있음. 아래QA재실행은먼저서버를시작해야한다.
```sh
cd /Users/jr/Desktop/projects/nomorevibe
HOSTNAME=127.0.0.1 PORT=43129 DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55435/nomorevibe_test ADMIN_LOCAL_LOGIN=1 NEXT_PUBLIC_SITE_URL=http://127.0.0.1:43129 CONNECT_AGENT_URL= GITHUB_TOKEN= node .next/standalone/server.js
# 별도 터미널에서 실행 (fixture가 다른 테스트로 바뀌었다면 아래 seed명령 먼저):
/tmp/nmv-admin-qa-venv/bin/python .crawl-samples/admin-ui-review/verify_ui.py
cat docs/operations/evaluations/2026-09-22-admin-review/browser-checks.json
tail -n 6 /tmp/nmv-admin-integration-full.log
git diff --check
git status --short
```
QA fixture는 `.crawl-samples/admin-ui-review/seed.ts`이며DB를비우므로다른통합테스트와동시실행금지. 필요시명시로컬환경으로만실행:
```sh
DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55435/nomorevibe_test TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55435/nomorevibe_test npx tsx .crawl-samples/admin-ui-review/seed.ts
```

---

# 근거 수집 복구 배포·운영 검증 완료 — 2026-09-22 01:08 KST

## 완료 결과
- 사용자 명시 지시에 따라 `d29b7156ac256f7b7f7730899da8c02ab87d2abf` main 커밋·푸시, Dokploy 웹 M3/mini 2개+M3 워커7개 배포 완료. 9앱 모두 새 deployment done, 컨테이너 release 일치/restarts0, 두 웹 health HTTP200+DBok 각2ms, 7워커 healthy+14/14소스해시 일치. 외부 홈페이지/health HTTP200.
- 문제3레포 hraness/{hra,atet,message-like-me}는 새scan65733/65734/65735로자연재수집. cursor이름일치/lastError없음/관측4·2·5개. 아직partial이며후속수집대기. 다음다른레포2건complete로그까지확인. 새컨테이너시작후16:05:39–16:07:59UTC로그203개:job.failed0/agent_evidence.failed0/scanned5.
- 기존불일치행6개는이력보존,latest불일치3개남음(문제3레포latest는모두해소). 전체적체정리·생존확인배치확대는이번범위아님.
- GitHub CI35622606975는결제/사용한도로steps=[]미실행. 같은커밋clean checkout Node24.18.0에서npmci/typegen/tsc/전체lint(기존warning1,error0)/unit1094/integration784/productionbuildPASS. 작업폴더전체통합784도별도PASS. 이전간헐실패원인확정은아님.

## 변경 파일·증거·판단
코드커밋19파일은바로아래진행기록참조. 후속문서커밋은이handoff,remediation배포링크,`docs/operations/evaluations/2026-09-22-evidence-cursor-deployment/`의README/release.json/db-before.json/db-after.json/events.json/읽기전용감사소스다. 키/환경변수값은출력·커밋하지않음. DB원본은read-only,마이그레이션/큐리셋없음. standalone빌드와실제운영코드hash로CI실행불가를보완했다.

before DB timestamp는로컬KST해석으로9시간어긋났던필드만UTC정규화해설명을남겼다. after는TZ=UTC로실행. 순서/ID/상태비교와DB내계산은유지된다. 총행수와latest불일치수를혼동하지말것.

## 마지막 후처리·다음 에이전트
이기록을커밋·push한뒤 **9앱autoDeploy를원래true로restore하고status확인**한다. 현재커밋시점의증거파일autoDeploy=false는문서push중중복배포방지상태다. 최종사용자보고는restore성공확인뒤에만할것. API/receipt는`/tmp/nmv-cursor-release.py`, `/tmp/nmv-cursor-release-state.json`. 아래명령은상태확인/마지막복원이며코드재배포는필요없다.
```sh
cd /Users/jr/Desktop/projects/nomorevibe
python3 /tmp/nmv-cursor-release.py restore
python3 /tmp/nmv-cursor-release.py status
python3 /tmp/nmv-cursor-runtime.py /tmp/nmv-cursor-runtime-final.json
TZ=UTC node .crawl-samples/review-speed/cursor-release-audit.mjs /tmp/nmv-cursor-db-final.json
git status --short
```

---

# 근거 수집 복구 커밋·운영 배포 진행 — 2026-09-22

### 최신 진행 체크포인트
코드/보고19파일 **d29b7156ac256f7b7f7730899da8c02ab87d2abf** main 커밋·push 완료. GitHub CI35622606975는 결제/사용 한도 때문에 job steps=[]로 시작되지 않음(테스트 실패 아님), annotations `/tmp/nmv-cursor-ci-{run,annotations}.json`. 대신 clean detached `/tmp/nmv-cursor-release-check`에서 npm ci→next typegen→tsc→전체lint(기존vendor unused경고1/오류0)→unit1094PASS→integration784PASS(87.46s)→productionbuildPASS, Node24.18.0. 로그 `/tmp/nmv-cursor-clean-{install,types,lint,unit,integration,build}.log`.

9앱 autoDeploy=false 및 RELEASE_TAG=d29b715 설정 완료, 웹NEXT_DEPLOYMENT_ID 일치/공유Actions키동일 확인. 9앱동시deploy 요청 진행. 최신receipt `/tmp/nmv-cursor-release-state.json`의 deploymentTriggeredAt 확인. **마지막에 restore 필수**. 검증helper `/tmp/nmv-cursor-runtime.py`는실제컨테이너health/7워커변경3+기존11파일=14파일hash 확인; `/tmp/nmv-cursor-deploy-logs.py <UTC시작>`은배포이후안전필드로그수집. `.crawl-samples/review-speed/cursor-release-audit.mjs`는전체및latest cursor불일치도구분조회. 배포전원본3은Sept16불일치partial,별칭3은같은GitHubID/더새로운Sept19HEADpartial이며서로다른scan행이다. 운영after로실제진행확인할것.

## 목표·현재 상태
사용자가 “커밋하고 푸시하고 배포해”를 명시 지시했다. 앞선 미배포 상태를 종료하고 현재 근거 수집 수정/검증 문서를 커밋·푸시한 뒤 Dokploy 웹2대(M3/mini)+워커7개를 동일 SHA로 배포한다. 생존 확인 배치 확대는 미구현 제안이므로 이번 배포에 포함되지 않는다.

## 배포 전 검증
- `npm test`: 141파일 1094PASS, `/tmp/nmv-cursor-release-unit.log`.
- 전용 local DB 통합 전체: **80파일784PASS(90.89초)**, `/tmp/nmv-cursor-release-integration.log`. 이전 seed/dequeue 간헐 실패는 이번 실행에서 재현되지 않았으며 이전 실패 기록은 아래에 보존한다.
- `npx tsc --noEmit`, 변경6파일 ESLint, `git diff --check` PASS.
- origin/main과 로컬main 5146d13 차이0 확인. 운영9앱 모두 done, main/JRVector9/nomorevibe, 원래 autoDeploy=true. 운영 릴리스는 8ec1adc. 키는 Keychain→curl stdin, 출력·커밋 안 함.
- 커밋 범위: 근거 코드3파일, 테스트3파일, CODEX_HANDOFF, 9/21 pipeline-bottlenecks 및 runtime-verification 보고서/증거. 무관 사용자 파일은 포함하지 않는다.

## 운영 절차·남은 작업
`prod` 스킬 적용. `/tmp/nmv-cursor-release.py`는 기존 Keychain/curl API 함수를 재사용하며 preflight/pause/release/deploy/status/restore 지원. pause에서 **9앱 모두** 자동배포를 잠시 끄고 마지막 restore로 원래 true 복구해야 한다. API HTTP200은 큐 등록일 뿐이며 최종 컨테이너 health·코드 해시·DB 확인이 필요하다. 일반 스키마 변경/수동 운영 큐 수정은 없다.

증거: `/tmp/nmv-cursor-{predeploy-status,preflight,release-state,release-status,db-before}.json`. 읽기전용 DB 점검 `.crawl-samples/review-speed/cursor-release-audit.mjs`는 문제3저장소/별칭, cursor불일치 수, 주요 jobs 진척을 기록한다. 운영 URL은 기존 private `/tmp/nmv-installable-web.env`에서 메모리로만 읽음.

다음: 선택 파일 커밋·push→CI→release SHA 설정→9앱 동시deploy→두웹health/7workerhealth와변경3파일hash→문제3레포복구/배포이후로그→배포기록커밋push→restore autoDeploy. 정확한 명령:
```sh
cd /Users/jr/Desktop/projects/nomorevibe
python3 /tmp/nmv-cursor-release.py status
python3 /tmp/nmv-cursor-release.py release <40자리 검증된 커밋 SHA>
python3 /tmp/nmv-cursor-release.py deploy
node .crawl-samples/review-speed/cursor-release-audit.mjs /tmp/nmv-cursor-db-after.json
python3 /tmp/nmv-cursor-release.py restore
git status --short
```

---

# 근거 수집 수정 재검토 — 2026-09-22 00:48 KST

## 현재 목표·완료
사용자 “한번 더 검토하고 문제없는지 확인” 요청 수행. 중간 “마지막 커밋, 개발 사항 배포했어?”에는 **미커밋·미푸시·미배포, 로컬 수정만 있음**이라고 답했다. 이 질문만으로 배포하지 않았다. 생존 확인 배치 확대 역시 제안만 있고 미구현.

## 발견·최종 설계 (아래 9/21 설계보다 우선)
- 최초 수정의 repositoryKey 덮어쓰기는 기존 이름으로 제품/심사가 근거를 찾지 못하게 했다. 로컬 회귀 테스트로 실패를 확인하고 보완했다.
- 불변 GitHub ID/head/detector/scope 충돌 시 **기존 repositoryKey와 스캔 ID 유지**, cursor만 저장된 이름에 원자적으로 맞춘다. 커밋 cursor 안의 별칭 URL을 가진 임시 observations는 제거해 재조회·도달 가능성 검증을 다시 한다.
- 별칭을 확인했다고 원래 이름도 확인됐다고 확정하지 않음. 기존 completedAt 보존, alias_recheck_required로 보류, 원래 이름의 공개 여부/ID 재확인 후 해제. 빈 cursor도 이 보류 상태면 우선 재개 대상에 넣는다. 오류 반환에 이 상태를 노출해 조기 재심사/제품 연결 방지.
- upstream rate_limited/timeout 등과 겹치면 upstream 오류 반환 및 retry deadline을 우선 보존한다. 별칭 복구 때문에 재시도 제한을 우회하지 않는다.
- 이미 DB에 있는 이름 불일치 cursor는 앞선 typed error 1회 복구(폐기→공개 metadata/head 새 조회)를 유지. 비공개/ID 변경 시 후속 근거 수집 금지. 별칭 조회 캐시 통합·별칭 레지스트리는 범위 밖이라 중복 조회 가능성 남음.
- 이번 전체 테스트 중 operations-center 분류 보류 테스트 실패 원인: 테스트 DB 시계가 앱 시계보다 약 **2021ms 앞섬**(read-only SELECT clock_timestamp 실측). 테스트의 앱시각+1초가 DB의 보류보다 과거가 됨. 테스트만 DB clock_timestamp()+1초로 통일. 운영 분류 로직 변경 없음.

## 변경 파일
- `lib/domain/evidence/agents/collect.ts`: 앞선 typed cursor 오류 유지.
- `lib/domain/evidence/agents/repository.ts`: 이름 보존/원자적 cursor 조정/캐시된 커밋 claim 제거/원래 이름 재확인 보류/오류 우선순위.
- `lib/jobs/products/agent-evidence-refresh.ts`: alias_recheck_required도 우선 재개.
- `tests/integration/agent-evidence-cursor-recovery.test.ts`: 총16개, 최초10개 중 이름 갱신 기대를 원래 연결 보존으로 변경하고 검증 추가.
- `tests/integration/agent-evidence-refresh.test.ts`: 빈 cursor의 별칭 확인 보류도 커서 뒤에서 재개하는 테스트 추가.
- `tests/integration/operations-center.test.ts`: DB 기준 시간으로 테스트 수정.
- `docs/operations/evaluations/2026-09-21-pipeline-bottlenecks/remediation.md`, 이 handoff 최신화. 무관 파일 보존.

## 테스트·실패 접근
- 시작 관련4파일56PASS. 최초 이름/커밋 회귀3RED→4파일39PASS. 이름 재확정/작업 우선순위2RED→4파일43PASS. rate-limit 우선순위1RED→2파일28PASS.
- 단위141파일1094PASS. tsc/변경6파일ESLint/diff검사PASS.
- 중간 전체781중780PASS/운영센터1FAIL→DB시계차 원인 규명, 테스트 수정 후 운영센터6PASS.
- 전체 재실행80파일783PASS(89.36s). 이후 rate-limit 회귀1건 추가 및 실패재현/수정 후 최종784건 중 **783PASS/1FAIL**(86.38s). 실패는 기존 crawl-seed `어떤 AI인지 말하지 않는 신호는 추정을 비운 채 넣는다`: dequeue 결과 undefined. 해당 파일 단독15PASS, 같은 사례를 임시 진단 테스트로50회 반복해50PASS. 정확한 원인은 미확정이며 수정 영향/무관 여부를 확정하지 않았다. 전체 무실패라고 보고하지 말 것. 진단 임시 파일은 제거했고 `/tmp/nmv-cursor-review-seed-{recheck,diagnostic}.log` 보존.
- SQL CASE의 JS Date 직접 바인딩은 postgres 드라이버 TypeError를 냈다. typed `excluded.completed_at/next_attempt_at/started_at`을 사용해 수정 후 관련 테스트 PASS. 실패 구현은 남아 있지 않다.
- 로그 `/tmp/nmv-cursor-review-{initial,red,green,alias-red,alias-green,unit-final,operations-green,integration,integration-final,rate-red,rate-green,integration-final2}.log`.
- 전용 로컬 DB만 사용: `127.0.0.1:55435/nomorevibe_test`. 운영 DB를 테스트에 넣지 말 것. Next 설치 use-server 문서 확인, systematic-debugging/TDD 절차 적용. 서브에이전트 없음.

## 남은 일·다음 명령
재검토·보완·검증 보고까지 수행. 남은 것은 전체 실행에서 한 번만 관측된 seed/dequeue 실패의 원인 규명 및 운영 배포 후 회복 검증이다. 단독·50회 반복으로 재현되지 않아 추정 수정은 하지 않았다. 배포/운영 회복 실측은 수행하지 않았고, 생존 확인 처리량 제안도 미적용. 이번 수정이 운영에서 동작한다고 주장하지 말 것. 로컬 HEAD는 여전히 `5146d13`(docs: record verified review speed production rollout).
```sh
cd /Users/jr/Desktop/projects/nomorevibe
tail -n 12 /tmp/nmv-cursor-review-integration-final2.log
git diff -- lib/domain/evidence/agents/repository.ts lib/jobs/products/agent-evidence-refresh.ts
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55435/nomorevibe_test npm run test:integration -- tests/integration/agent-evidence-cursor-recovery.test.ts tests/integration/agent-evidence-refresh.test.ts tests/integration/agent-evidence-repository.test.ts tests/integration/agent-review-scan-lock.test.ts tests/integration/operations-center.test.ts
npx tsc --noEmit
git diff --check
git status --short
```

---

# 근거 수집 반복 실패 수정·생존 확인 개선안 — 2026-09-21 17:25 KST

## 현재 목표·완료
사용자 “개선 대안 제시, 근거 수집 반복 실패 해결, 생존 확인 처리량 확대 방안” 요청. 기존 보고 후 명시적으로 요청한 근거 오류를 로컬 코드에서 수정하고 검증했다. 생존 확인은 대안과 실행·측정 기준을 제안했으며 코드는 미변경. 운영 배포·운영 DB 쓰기·설정 변경·커밋·푸시 없음.

## 수정 파일·설계 판단
- `lib/domain/evidence/agents/collect.ts`: 기존 cursor 검사 유지, `InvalidAgentScanCursorError`로 구분.
- `lib/domain/evidence/agents/repository.ts`: immutable ID/head 충돌 upsert에서 repositoryKey도 cursor와 함께 갱신. legacy 부적합 cursor만 1회 버리고 공개 metadata/head를 새로 확인. 원래 예산 유지, 다른 예외는 그대로 전파. 복구 조회 실패는 기존 저장 경로의 lastErrorCode/nextAttemptAt 사용, 기존 완료 근거 보존. 일회성 운영 SQL 삭제나 검증 완화 없음. 여러 별칭의 캐시 통합은 이번 범위 밖.
- `tests/integration/agent-evidence-cursor-recovery.test.ts`: 새 10회귀 테스트. 이름 변경 충돌, 운영 3개 이름 조합, transport/private/rate limit 재시도, 같은 이름의 다른 GitHub ID, 예산 없음, 직접 collector 거부 검증.
- `docs/operations/evaluations/2026-09-21-pipeline-bottlenecks/remediation.md`: 수정·테스트와 생존 확인 대안/제약/측정 기준. 기존 보고서와 이 handoff 갱신. 무관 untracked 보존.
- Next 설치 문서 use-server를 확인, TDD로 RED→GREEN 수행. 서브에이전트·사용자 승인 질문 없음.

## 실제 테스트·실패 접근
- RED: 새 테스트 10건 중 9실패/1통과, upsert 불일치 및 invalid cursor 재현. `/tmp/nmv-cursor-red.log`.
- 관련 통합 3파일 34PASS, `/tmp/nmv-cursor-green.log`.
- 단위 전체 141파일 1094PASS, `/tmp/nmv-cursor-unit.log`.
- 전체 통합 1차 776PASS/1FAIL(80파일): 기존 crawl-fetch의 임대권 교체 테스트 expected failed/received completed. 단독 22PASS 후 전체 2차 **80파일777PASS(99.30s)**. `/tmp/nmv-cursor-{integration,fetch-recheck,integration-recheck}.log`. 실패했던 테스트는 수정하지 않았고, 정확한 원인은 미확정. 첫 실패 기록을 성공으로 덮어쓰지 말 것.
- tsc 최초 테스트의 99n 타깃 오류→BigInt(99) 수정 후 `npx tsc --noEmit` PASS. 변경 파일 ESLint PASS, git diff --check PASS.
- 통합 DB는 loopback `127.0.0.1:55435/nomorevibe_test` 전용. 운영 DB 절대 테스트 투입 금지.

## 생존 확인 권장안·남은 일
현 16,845웹/900건h, 필요2,808건h. 우선 1분당 BATCH15→60(이론상3600h/전수4.68h), HTTP3/origin직렬/DB쓰기1/제품6시간 유지. 25초 시작 예산이 총 완료 시간을 강제하지 않는 점 보완, origin라운드로빈·실제 처리량 및 다른 maintenance 대기 측정 권장. 대안30초×30 또는전용워커. 이것은 제안이며 미구현·미측정 성능. 적체 있는 동안 시간당 고유완료3000이상/6시간 초과 수 감소를 검증. 다른 병목(승인대기90 근거우선갱신,감사정책전환,GitHub쿼터공유)도 보고서에 제안.

운영에서 반복 실패가 사라졌다고 아직 주장할 수 없음. 배포 후 문제3레포 예외 소멸·완료 또는 오류/미래재시도·다음partial 전진을 확인해야 함. 전체 통합 첫 실패가 재발하면 별도 원인 조사.

## 다음 에이전트의 정확한 명령
```sh
cd /Users/jr/Desktop/projects/nomorevibe
git diff -- lib/domain/evidence/agents/collect.ts lib/domain/evidence/agents/repository.ts
cat docs/operations/evaluations/2026-09-21-pipeline-bottlenecks/remediation.md
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55435/nomorevibe_test npm run test:integration -- tests/integration/agent-evidence-cursor-recovery.test.ts tests/integration/agent-evidence-repository.test.ts tests/integration/agent-evidence-refresh.test.ts
npx tsc --noEmit
git diff --check
git status --short
# 아래는 기존 읽기 전용 운영 스냅샷 도구(로컬 private env 파일 필요)
node .crawl-samples/review-speed/bottleneck-audit.mjs
node .crawl-samples/review-speed/bottleneck-detail.mjs
```

---

# 전체 과정 병목 검토 — 2026-09-21 17:08 KST

## 목표·완료
사용자 “전체 과정 검토하고 병목구간 있으면 체크하고 보고” 요청. 보고 전용으로 운영DB read-only 조회/15:50–16:50KST고정1시간 로그6,180개/코드 실행구조/읽기전용재현 완료. 코드·운영데이터·설정·작업요청·배포변경없음. 상세: `docs/operations/evaluations/2026-09-21-pipeline-bottlenecks/README.md`, 원본 `evidence.json`.

## 핵심 발견·설계 판단
- P1 개발AI근거 132예외 = hraness/{hra,atet,message-like-me} 각44회. 저장scan.repository_key와cursor.repositoryKey가각각oompa/slopcamera/textbutler로불일치. 실제collector에운영cursor만넣고request금지stub으로3/3 `invalid agent scan cursor` 재현,외부호출0/DB쓰기0. partial우선재개3슬롯을반복소비. catch가Error이름만로그/재시도시각미저장. upsert는GitHubID/head충돌시cursor교체하지만repositoryKey안바꿔별칭불일치가능;최초운영쓰기는재현안함.
- P1 승인92건최신평가만료,91건스캔24h초과,그중90건문서는신선. listReviewCandidates는stale스캔으로제외하지만requeueStaleReviewSources는문서만복구. agentEvidence.enforceEligibility=false여도freshness조건유효. 근거수요18,223/갱신대상14,490/스캔없음3,065/partial4,108(중복가능). 분류실패보류0.
- P1 기존발행감사캠페인3 running이나59회모두policy_changed. 캠페인2026-09-19.3/19.2,현재21.3/21.2. 11,558항목중AI미판단5,176. 명시적구캠페인종료/새정책감사필요,이번변경안함.
- P1 생존확인웹16,845개중6h초과13,102(77.8%),p50나이12.71h/max38.83h. 실제/상한900/h vs필요2,808/h. BATCH15×1분고정이라한바퀴18.7h. maintenance작업시간16.5%,CPU병목아님. 설치형377never_checked는정상제외.
- P2 stars대상17,222,24h초과6,773,실제328/h/상한480/h vs필요718/h. 공유Githubprimary한도발생,원본8회/스타2회대기. 제품근거342개별실패(작업실패아님),rate_limited근거329스냅샷. 먼저요청공유/쿼터배분,동시성만높이지말것.
- P2 1차저장→2차호출57쌍p50=7.8s/p95=39.737s,max50.703s. reviewer직렬실행+pending스냅샷으로후속요청대기. reviewer작업16.7%/publisher6.9%,분류처리량이주병목아님.
- 번역미처리2,515+실패1,시간당451성공/최장미처리211h. 소개61보류는전부빈결과/자동대상0,1시간6성공. 잠재결함:tagline자체54s대runner기본25s(jobRunOptions분기누락)실제함수확인. 이번느린호출실패재현안함.
- 사람큐902(ambiguous436/split405/no_description61),2차needs_human472/agreed213과중복가능. 단순합산금지.
- 정상진행:발견252/수집272/규칙260/발행36,이미지461채움. DB106/150,앱6,Lock대기0;CPU순간최고3.04%,메모리최고38.03%. 순간값으로피크안정성보장금지.

## 변경 파일·검증·실패 접근
- 위보고서폴더 README/evidence 및재현소스5개.txt,이handoff. ignored실행본 `.crawl-samples/review-speed/bottleneck-{audit,detail}.mjs`, `bottleneck-cursor-check.mts`; `/tmp/nmv-bottleneck-{logs,summary}.py`.
- 전체테스트이번재실행안함. 직전turn단위1094/통합767/tscPASS는앞절기록. 이번검증은productionread-onlySQL/로그/3cursor재현/예산함수실행이며앱수정없음.
- 상세SQL정규식역참조한번이스케이프때tagged template cooked undefined→42601;두번이스케이프로복구후성공. 기존코드실패와구분. source경로일부추측실패후rg로실제경로확인.
- 스킬systematic-debugging이전turn적용을이어사용. 사용자승인요청/서브에이전트없음.

## 남은 일·다음 명령
이번보고요청은완료. 수정은아직요청받지않았으므로적용하지않음. 권장순서는근거cursor복구→승인후보근거우선갱신→감사정책전환→uptime/stars용량→후속대기/텍스트예산. 기존관리자익명접근별도정책결정도미변경. 무관untracked보존,운영키출력금지.
```sh
cd /Users/jr/Desktop/projects/nomorevibe
cat docs/operations/evaluations/2026-09-21-pipeline-bottlenecks/README.md
node .crawl-samples/review-speed/bottleneck-audit.mjs
node .crawl-samples/review-speed/bottleneck-detail.mjs
node --import tsx .crawl-samples/review-speed/bottleneck-cursor-check.mts
python3 /tmp/nmv-bottleneck-logs.py
python3 /tmp/nmv-bottleneck-summary.py
git diff --check
git status --short
```

---

# 수집·평가·속도 재검증 — 2026-09-21 16:47 KST

## 목표·완료
사용자 “수집, 평가등 기능 정상동작하는지 체크하고, 속도 개선 여부 확인” 요청. 운영 릴리스8ec1adc/로컬5146d13에서 자연 실행과 read-only DB, 브라우저, 로컬 테스트 확인 완료. 코드·설정·운영 큐·배포 변경 없음.

- 고정16:10–16:40KST: 신규발견136/수집150/수집실패0,GitHub한도대기7회후진행. 1차38호출(성공36/invalid_output2),2차기본22(정상19/invalid_output3),연결된Sonnet fallback3승인,신규발행16. 1차실패2는사람보류로남음.
- 웹2/워커7정상,restart0,11파일해시일치,9앱autoDeploy=true. job.failed0. 배포안정화후발행29건승인누락0,repo중복그룹0. Publisher완료14회중text실행중완료6,Publisher에서text잡0.
- 속도: 신규발행13건(재심사3제외)수집→발행p50=71.719s/p95=92.628s. 1차완료→2차등록p50=24.236s,2차완료→발행12.664s. 전체발행16건후자는11.345s. 과거35.229s보다짧지만과거는일괄재심사적체로인과적개선율주장불가. 30분신규1차38건으로100건기준미충족.
- 통제비교재실행af50608→5146d13:8건/10초응답70→20s,24초응답84→53s,번역중발행대기34→4s.가상시계/모의DB/고정모델이며각3PASS. 운영처리량수치아님.
- 화면홈/상세/인기/운영센터/심사/2차보류/제품/크롤설정200. 상세·번역실패팝업열기닫기PASS. pageerror/추가관리자consoleerror/5xx0,모바일overflow없음.

## 수정 파일·판단
- `docs/operations/evaluations/2026-09-21-runtime-verification/{README.md,evidence.json,verification-audit.mjs.txt,verification-browser.mjs.txt}` 및 이handoff. 재현helper는ignored `.crawl-samples/review-speed/verification-{audit,browser}.mjs`. 앱코드수정없음/커밋안함.
- 과거AGENTS/PENDING의미배포표기보다실제운영상태우선. 모델성공과job성공구분. 신규와재심사분리. queueMs는candidate.updatedAt기준이라55시간p95를신규대기SLA로해석하지않음. 발행표본만의속도로전체후보SLA/판별정확도주장금지.
- 스킬:webapp-testing,systematic-debugging. qa-only는검토했으나소스·백엔드분석요청에부적합하여적용하지않음.

## 실제 실행 테스트
- `npm test`:141파일1094PASS(4.58s),log `/tmp/nmv-check-unit.log`.
- `TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55435/nomorevibe_test npm run test:integration`:79파일767PASS(93.23s),log `/tmp/nmv-check-integration.log`. 전용local DB만사용.
- `npx tsc --noEmit`:exit0.
- 위비교harness각3PASS,production browser두script exit0.
- 실패접근:과거laya문서가현브랜치에없어보존된`.crawl-samples/laya-eval/production-audit.json`확인. Docker service logs --until시도JSON없음→--since와파싱후UTC상한필터로성공. 구현실패아님.

## 남은 사항·다음 명령
- 동일조건충분한전후운영표본없으므로확정개선율은아직없음. 모델형식오류/한도대기/사람보류469건(16:44)남음. AI판별의미정확도는이번검증대상아님.
- 기존익명관리자접근재확인,정책변경없음. 운영센터번역실패1/응답하지않는제품50표시. 기존사용자정책결정필요사항유지.
- 관련없는untracked파일보존. 운영키출력/테스트투입금지.
```sh
cd /Users/jr/Desktop/projects/nomorevibe
cat docs/operations/evaluations/2026-09-21-runtime-verification/README.md
python3 /tmp/nmv-speed-dokploy.py status
python3 /tmp/nmv-speed-runtime.py /tmp/nmv-check-runtime-next.json
node .crawl-samples/review-speed/verification-audit.mjs
node .crawl-samples/review-speed/verification-browser.mjs
git diff --check
git status --short
```

---

# 최종 운영 배포 — 2026-09-21 15:49 KST

## 목표 및 완료
사용자 “배포해”에 따라 PR161–166 순차merge 및 운영9앱 배포, 현장에서 발견한2문제PR167보완/merge/재배포 완료. 최종 앱 코드 `8ec1adc90709b813297e6a63686deb8d2fff6626`. 로컬main과remote동기화. 이 이후 변경은 배포 문서뿐이다.

- M3/mini웹 health200/DBok/동일release. 모든7worker healthy/restart0/PID1tini/중요11파일hash일치. text앱id Pi0loosJrKsse_UQ0mln9,appName nomorevibe-text-m3-ebmybu,512MiB/pool3,역할2잡. publisher발행만1잡. 구형publisher종료→신형publisher→text순으로 첫분리완료.
- 약17분 자연실행: 첫심사성공103/실패8, 발행39/회수0, 발행승인누락0/중복repo0. 기본2차오류4건,Sonnet fallback4건성공. 기존README오류없어짐. 모델오류를승인으로처리하지않음.
- 추가수정: Dockerfile tini와Dokploy supervised5개명령prefix,readme.ts lone surrogate제거,lib/net/fetch.ts 비표준status보존/bodycancel/originrelease,TranslationProgress.tsx dialog포함flow HTML수정. 승인·모델·timeout·동시성기준 변경없음. DB마이그레이션없음.
- 최종브라우저홈/상세/인기/관리자200,hydration/pageerror0,서버5xx0,모바일overflow0. 관리자text상세release와두잡확인,번역실패팝업열기닫기성공. uptime-ping15사이트/3.105초성공,last_error있는job0(06:47:57UTC).
- 최종PR167 CI35569369508 단위141파일1094/통합79파일767/타입/lint/build PASS. 로컬fetch/SSRF19,tsc,lint,SSR+hydrate browser fixture PASS. Dockerworker init이미지build/종료smoke PASS는이전단계기록참고. main CI35569795611도전체PASS확인. 이후문서만push.
- 자동배포는중간스택차단을위해일시off; 문서push후기존8+newtext=9앱모두true로복구하는순서로마무리한다. 최종재확인은 아래 status명령으로한다. release env와web NEXT_DEPLOYMENT_ID는8ec1adc,두웹Server Actions빌드키일치확인. 키내용은출력금지.

## 기록·실패 접근·남은 일
- 상세검증/원본: docs/operations/evaluations/2026-09-21-review-speed/{README.md,deployment.json},runbook. 수정문서: 위3개와이handoff.
- 초기init준비는connect-agent command=null때문에assertion중단→이미지ENTRYPOINT사용분리후완료. 구형stop API timeout은실제종료/runtime/API로확인했고중복요청하지않음. 웹loopbackhealth는HOSTNAMEbind라실패→컨테이너HOSTNAME사용. datetime없는PG타임스탬프의9시간오해는UTC문자열SQL로수정. HTMLfixture첫실패는charset누락→UTF8후PASS. 모두현재코드실패와구분.
- 실제추가문제(답변대기): 기존웹2대 ADMIN_LOCAL_LOGIN=1로익명관리자접근가능,OAuth키없음. allowlist/authsecret은있다. 차단시운영자도잠겨서 async질문요청했으나아직응답없음. 접근정책은사용자답변후변경. 이문제가해결됐다고말하지말것.
- 성능: 이전30분은README오류로진행0. 정상동일조건기준선부재/최종관측17분이므로운영단축률주장금지. 모델timeout/invalid_output은계속실측대상. 100건/30분같은조건전후비교는남음.
- unrelated untracked(.claude,docs/PT,Sep14운영문서,디자인산출물,prototypes)는그대로보존. 운영env를테스트에넣지말것.

## 정확한 재확인 명령
```
cd /Users/jr/Desktop/projects/nomorevibe
git status --short --branch
python3 /tmp/nmv-speed-dokploy.py status
python3 /tmp/nmv-speed-runtime.py /tmp/nmv-speed-final-runtime.json
node .crawl-samples/review-speed/production-metrics.mjs /tmp/nmv-speed-next-metrics.json 2026-09-21T06:29:45Z
node .crawl-samples/review-speed/deploy-audit.mjs 2026-09-21T06:29:45Z
python3 /tmp/nmv-speed-logs.py 2026-09-21T06:46:10Z
node --import tsx scripts/report-review-latency.ts /tmp/nmv-speed-production-pipeline.jsonl
```
모든DB도구는read-only SQL. /tmp/nmv-speed-dokploy.py는Keychain→curl stdin으로키와payload처리,비밀출력없음. 다음진행은사용자접근정책답변및정상성능표본검토다.

---

# 운영 배포 후 보완 — 2026-09-21 15:39 KST

- a982c1a 운영9앱 배포 완료. M3/mini 웹 각각 health200 DBok,7worker healthy/restart0/PID1tini/10sourcehash일치. 새 text는06:31:55UTC시작, 구형publisher06:28:44종료/새publisher06:29:54시작이라 겹침없음. 구형stop API25초 timeout이었으나 별도 runtime/API에서 실제종료 확인후 진행했다.
- 실제 첫2분 1차성공9, 신규발행3. 이후4분 첫모델20호출/4실패(2invalid_output+2timeout); 두번째10호출/1실패,Sonnet fallback성공 관측. 기존 README JSONB오류 해소, 수집/심사/발행job last_error없음. 발행3건 1차/독립2차승인 누락0, repo중복0. 모델오류율0/운영단축률 주장 금지.
- 브라우저 홈/상세/인기200, 모바일overflow0. 관리자도200이며 text역할 표시확인. 다만 기존 TranslationProgress의 p/span 안 dialog가 browser parser에 의해 section아래로 이동하여 hydration418 재현.
- 추가 문제: uptime-ping에 RangeError(status200..599)반복. safeFetch background가 비표준999응답을 새Response로 감싸다실패. 원본실패status보존+bodycancel+originrelease 추가. 회귀RED1→GREEN, SSRF포함19 PASS/tsc/lint PASS. TranslationProgress flow container를div로 수정; 실제SSR+Reacthydrate 브라우저fixture는 초기fixturecharset누락 수정뒤 재검증했다.
- 현재 fix/deploy-runtime-checks 브랜치, 수정 lib/net/fetch.ts,TranslationProgress.tsx,net-fetch-deadline.test.ts,이문서. 추가PR/CI/merge/9앱재배포 남음. 기존9앱autoDeploy=false는 마지막에반드시true복구. 보완이후README+catalog+fetch 해시를모두검증할것.
- 별도확인필요: 기존운영웹2대 ADMIN_LOCAL_LOGIN=1이고 OAuth키없음(allowlist/authsecret은있음). 실제익명관리자접근가능. 접근차단시사용자도로그인불가라 async질문으로확인요청했고 아직답없음. 사용자명시응답없이접근정책변경하지않음. 키값출력금지.
- 다음: 변경PR CI완료후merge/deploy. `python3 /tmp/nmv-speed-dokploy.py status`; `python3 /tmp/nmv-speed-runtime.py /tmp/nmv-speed-after-runtime.json`; `python3 /tmp/nmv-speed-logs.py 2026-09-21T06:29:30Z`; `node .crawl-samples/review-speed/deploy-audit.mjs 2026-09-21T06:29:30Z`. 실측표본100/30분은충족전이다.

---

# 운영 배포 진행 — 2026-09-21 15:25 KST

- PR161–166 모두 검토/CI 성공 후 merge commit으로 main 병합. 최종 main `a982c1ae034e89a125de553fd0824c6e58213de7`, 검증된 PR166 `6dcfb34`와 tree 차이0. 로컬 main ff-only 완료. 최종 PR CI35567722915: 단위1093/통합767/타입/lint/build PASS. main CI35568200091 대기.
- 기존8앱 autoDeploy=false 유지. 배포 태그9앱 모두 a982c1a로 준비, 웹2대 NEXT_DEPLOYMENT_ID도 동일, Server Actions 빌드 키 일치 확인. 아직 새 배포 요청 전.
- text 앱 `Pi0loosJrKsse_UQ0mln9`, `nomorevibe-text-m3-ebmybu` 생성·설정 완료/미시작. 원래5개 supervised worker command에 `/sbin/tini --` 준비 완료. connect-agent는 custom command=null이라 새 이미지 ENTRYPOINT를 그대로 사용한다. 처음 init 준비 assertion은 null command를 구분하지 못해서 발생했고, 변경 전에 중단했으며 skip 처리 후 정상 적용했다.
- 운영 웹 health의 loopback 직접 호출은 기존 HOSTNAME bind 때문에 실패. runtime helper를 컨테이너 HOSTNAME/PORT로 호출하도록 수정; 서비스 장애로 오인하지 말 것. 배포 전 worker10파일 중9개는 이전 코드, 최종 source 검증 필요.
- 다음: main CI PASS 확인→구형 publisher stop/drain 확인→기존8앱 동시 deploy(두 웹 함께)→new publisher healthy/catalog 역할 확인→text deploy→실제 source hashes/health/jobs/readonly gates/telemetry 확인→문서 커밋·push→9앱 autoDeploy=true 복구.
- 도구: `/tmp/nmv-speed-dokploy.py` (API/env는 stdin만), `/tmp/nmv-speed-runtime.py`, `.crawl-samples/review-speed/production-metrics.mjs`. 명령: `gh run view 35568200091 --json status,conclusion`; `python3 /tmp/nmv-speed-dokploy.py stop-publisher`; `python3 /tmp/nmv-speed-dokploy.py deploy-existing`; `python3 /tmp/nmv-speed-dokploy.py status`. 큐/심사 DB 수정 없이 자연 실행 검증할 것.

---

# 운영 배포 진행 — 2026-09-21 15:15 KST

사용자가 배포를 명시 승인했다. prod/land-and-deploy 적용, 추가 확인 불필요. 기존 운영8앱의 autoDeploy를 일시 false로 변경(모두 원래true); 반드시 완료 후 복원. 원래 상태는 /tmp/nmv-speed-app-configs.json, 배포 전 상태 /tmp/nmv-speed-predeploy-status.json. API키는 Keychain에서 읽고 curl --config stdin으로만 전달; payload/env도 stdin. 새 도구 /tmp/nmv-speed-dokploy.py. 기존 /tmp/nmv-installable-web.env는 private, 절대 출력 금지.

- PR161/162 병합 완료,163 병합 요청(session51861). merge commit 방식으로 ancestry 보존하며 다음 PR base를main으로 순차 변경. PR164/165/166남음. 자동 배포는 아직 꺼져 있으므로 운영은이전678380c.
- 발견/보완1: 운영Swarm ContainerSpec.Init=null. Dockerfile worker에 tini 추가 +ENTRYPOINT. 기존 Dokploy custom command는 image ENTRYPOINT를 덮으므로 deployment config에서도 /sbin/tini -- prefix 필요. tini 이미지 로컬 buildPASS, --init 없이 text 컨테이너 healthy/restart0/SIGTERM exit0/PID자식정리PASS. 이미지 nomorevibe-worker:review-speed-init-20260921.
- 발견/보완2: 현재1차 job README저장오류로 막힘. 실제 Starlitnightly/omicverse README3000자 끝d83d/ill-formed, local JSONB22P02 재현. readme.ts의 두 truncation 뒤 lone surrogate만제거; 완전이모지/길이/정책/표본버전유지. 새2회귀RED→GREEN, 관련40PASS, 타입/lintPASS. 실제문서2999/wellformed/localJSONB성공.
- 수정중: Dockerfile,lib/crawl/readme.ts,tests/crawl-readme.test.ts,문서. PR166에추가커밋후CI완료기다릴것. fullunit session12291,새text앱설정 session27999. 다른영역 앱코드변경없음.
- 새text는source publisher의DB/API키만전달,role=text,instance=m3-text,pool3,512MiB/CPU1,stop-first,grace60초,autoDeployfalse. /tmp/nmv-speed-text-app.json에id; 아직deploy하지않음. create-text는idempotent.
- 운영자원: M3호스트여유; DB max150현재총103/app6. reviewer실제pool12(문서기본3과다름), 유지. 새text pool3추가. 기존runbook31합계는실제운영40→43으로수정필요.
- 기준선: .crawl-samples/review-speed/production-metrics.mjs read-only transaction. 최초timestamp withouttimezone 파싱으로9시간어긋난측정폐기; DB에서UTC문자열로반환하도록수정. 정상최근30분1차/2차/발행0,1차오류있음. /tmp/nmv-speed-baseline-metrics.json. 오류원문대신 boolean+prefix만출력.
- 다음: unit결과확인,code/docs커밋push→PR166 CI. 순차merge164/165/166→mainCI/트리동일확인. 새commitRELEASE_TAG+webNEXT_DEPLOYMENT_ID를올바르게설정하고workercommand initprefix. 기존publisher drain/교체종료확인후text시작. 두web동일창배포,다른M3역할도교체. Health/sourcehash/jobs/실제모델완료/중복과관문 검증. autoDeploy원복. 아직배포완료라고보고하지말것.

---

# 속도 확인 — 2026-09-21 14:57 KST

- 사용자 요청: 속도 개선되는지 확인. 운영 미배포 사실을 읽기 전용으로 재검증하고 이전/개선 실제 코드 비교 실험 수행.
- 운영 증거: 6개 worker/container에서 catalog·1차job·판정repository·1차repository·taglinejob 해시 모두 baseline af50608과5/5 일치, 개선 bd4b36d와0/5. PR166 OPEN/미병합. 따라서 운영 단축률 확인 불가. 배포/운영DB/모델API/큐 수정 없음.
- 비교: 같은 Vitest harness, baseline af50608와 current bd4b36d에 각각3개 테스트 실행하여 모두PASS. 가상 시계·모의 DB·고정 모델 응답. 1차8건/동시성4/10초 응답70→20초; 24초 응답84→53초. 두 버전8건·peak4·모의오류0·timeout24초 동일. 번역30초 중 요청한 발행의 시작 대기34→4초.
- 한계: 첫 심사는 다른 reviewer 작업 없다고 가정; catalog60초 schedule과5초 poll을 harness에서 재현. 발행은 실제 worker loop로 비교. 네트워크/DB/분류/이미지 지연 미포함. 운영 처리량/오류율/모델 성능 주장 금지.
- 변경 파일: docs/operations/evaluations/2026-09-21-review-speed/{README.md,before.json,after.json,production-code-check.json,*.txt}, runbook, 이 인계문서. 앱 코드 변경 없음. `.crawl-samples/review-speed/`의 harness는 ignored; .txt 원본으로 재현 가능.
- 실패한 접근 없음. 전체 CI는 이전 최종 bd4b36d도35565616984에서PASS 확인. 이번 추가 작업은 비교실험3+3개만 실행했다.
- 남은 일: 161→166 병합/운영 배포 후 신규100건/30분 이상 전후 표본으로 실제 개선 확인. 이번 요청에서 배포하지 않았다.
- 다음 명령: `gh pr view 166 --json state,mergedAt`; 위 evaluations README의 두 비교 명령. 운영 rollout은 review-pipeline-speed-runbook.md. 기존 unrelated untracked 유지.

---

# CI 완료 기록 — 2026-09-21 14:42 KST

6개 구현 PR161~166 모두 CI 성공. 최종 검증 코드 `5df9bceab7c8a9791b9c144669db2fc96a05a10f`: GitHub 전체 단위141파일1091 PASS, 통합79파일767 PASS, 타입/lint/Next build PASS. 이 기록 후 커밋은 문서만 수정한다. 로컬에서 남았던 단일 구형 기대값 실패도 최종 전체 CI에서 해결 확인.

[#161 CI](https://github.com/JRVector9/nomorevibe/actions/runs/35565100321), [#162 CI](https://github.com/JRVector9/nomorevibe/actions/runs/35565095414), [#163 CI](https://github.com/JRVector9/nomorevibe/actions/runs/35565087150), [#164 CI](https://github.com/JRVector9/nomorevibe/actions/runs/35565091983), [#165 CI](https://github.com/JRVector9/nomorevibe/actions/runs/35565212113), [#166 CI](https://github.com/JRVector9/nomorevibe/actions/runs/35565195009)

현재 구현·재검토·검증·커밋/push·PR 작성 완료. 운영 배포와 운영 전후 지연 실측은 미실시. 다음 작업은 161→166 순서의 검토/병합 및 runbook에 따른 단계 배포다. 추가 모델 호출·재심사·데이터 수정은 수행하지 않았다. `gh pr checks 166` 및 `docs/operations/review-pipeline-speed-runbook.md`로 이어간다.

---

# 최종 구현 인계 — 2026-09-21 심사 대기·텍스트 워커 분리

요청한 코드 구현과 로컬 검증, 커밋/push, 6개 stacked PR 작성 완료. 현재 브랜치 `test/review-speed-release-verification`. 운영 미배포이며 새 text 운영 앱도 아직 만들지 않았다. 아래 이전 단계의 커밋 hash는 unpublished stack 정리 전의 기록이다.

| 단계 | PR | 브랜치 | 현재 커밋 |
|---|---|---|---|
| 1 | [#161](https://github.com/JRVector9/nomorevibe/pull/161) | `perf/review-stage-observability` | `107bbb4` |
| 2 | [#162](https://github.com/JRVector9/nomorevibe/pull/162) | `perf/review-transactional-handoffs` | `4f769c6` |
| 3 | [#163](https://github.com/JRVector9/nomorevibe/pull/163) | `perf/review-bounded-draining` | `18cfb70` |
| 4 | [#164](https://github.com/JRVector9/nomorevibe/pull/164) | `fix/fence-text-job-results` | `b248040` |
| 5 | [#165](https://github.com/JRVector9/nomorevibe/pull/165) | `perf/isolate-text-worker` | `ad5f33b` |
| 6 | [#166](https://github.com/JRVector9/nomorevibe/pull/166) | `test/review-speed-release-verification` | `76ea50e` |

- 보완: 오프라인 CLI 실행 테스트에서 발견한 CJS top-level await를 async main으로 수정해 PR01에 포함. handoff 동작에 대한 기존 통합 기대값 수정은 PR02로 이동. 이후 스택 rebase 후 최종 트리와 검증한 원래 트리 차이0 확인.
- 실제 검증: 전체 단위140파일1090 통과 + 추가 CLI 회귀1개/관련5개 통과(고유1091). 통합79파일767 중766 통과, 구형 기대1개 수정 후 해당17 통과; 최종 종료 경계 DB5 통과. 타입/추적+신규lint/Next build/Compose/Docker worker build 통과. text/publisher --init smoke healthy/restart0, 각 소유 잡 실행, SIGTERM supervisor·container exit0.
- 보호: 원문·정책·모델·fallback·500별 기준·최종 발행 관문 유지. LAYA 운영 호출 없음. 관리자/원본 변경 경합, lease 교체, 종료 이후 응답 쓰기 차단.
- 문서: `docs/operations/review-pipeline-speed-runbook.md`, 계획 디렉터리 README에 구현/검증/배포 순서. 운영100건/30분 이상 같은 조건 전후 비교가 남아 있으므로 실제 단축률 주장 금지.
- 환경: 운영키/DB 미사용. 전용 local nomorevibe_test만 사용. 테스트용 stopped smoke 컨테이너4개 및 image는 재현 자료로 남김. unrelated untracked 유지.
- 남은 일: 각 PR CI 확인, 순서대로 코드 검토/병합, 구형 publisher drain 후 publisher/text 분리 배포, 운영 비교. 현재 자동 병합/배포하지 않음.
- 다음 명령: `gh pr checks 161`부터 `gh pr checks 166`; `gh pr diff 161`; `git status --short --branch`. 재현 테스트는 운영 문서의 loopback TEST_DATABASE_URL 명령을 사용. 운영 env를 통합 테스트에 넣지 말 것.

---

# 진행 인계 — 2026-09-21 심사 속도 PR06 최종 검증

- 목표: 다음 심사 대기 단축, 제한된 슬롯 재사용, 번역·소개 전용 text 워커, 판정·발행 기준 유지.
- 현재 브랜치: `test/review-speed-release-verification`; PR01~05 로컬 커밋 완료, 아직 push/PR/운영 배포 없음.
- PR06: 기준 `af50608` 실제 checkout에서 만든 10개 입력/규칙 fixture, 전용 테스트 DB 주소 guard, 오프라인 검증 CLI, 추가 DB 경합/종료 안전성, 운영 보고서 작성.
- 최종 리뷰 수정: 1차 claim 중 종료하면 호출하지 않고 취소로 정리; 1·2차 모델 성공 응답이 종료 신호 이후 도착하면 승인 저장 금지.
- 수정 파일: `lib/crawl/jobs/{agent-review,second-review,tagline,translate-reasons}.ts`, `lib/observability/review-pipeline.ts`, 관련 unit/integration tests, `scripts/{test-database,verify-review-pipeline-speed}.ts`, fixture와 계획/운영 문서. 상세 목록은 git status로 확인.
- 검증: 최종 전체 단위 140파일/1090 통과(14:27 KST), 1·2차 단위33 통과. 통합 전체79파일/767 중766 통과·옛 batch 요청 기대1개 실패→해당 파일17 통과. 최종 1·2차 DB 통합5 통과. tsc, 추적+신규 소스 lint(기존 경고1), Next build, Compose config, 최종 worker Docker build 통과.
- 실패 접근: fixture 출력 폴더 누락 수정; raw Date SQL 인자 오류를 ISO timestamp 비교로 수정. 첫 Docker smoke에서 Compose의 init:true 누락으로 종료 exit1; 올바른 --init 실행에서 두 컨테이너 healthy/restart0, worker failures0, supervisor/container exit0 확인.
- 비밀/운영: 운영 DB/API/env 사용하지 않음. 테스트는 loopback nomorevibe_test만 사용. LAYA 운영 호출 미추가. 사용자 무관 untracked 파일 유지.
- 최종 CLI 확인: CJS top-level await 오류 재현→async main으로 수정, 실제 subprocess 회귀1개와 계측4개 통과. 고유 단위1091개. 오프라인 CLI 수정/회귀는 PR01로 이동할 것.
- 남은 일: PR06 커밋. PR02에 agent-review-job/crawl-judge 통합 기대 수정이 포함되도록 미공개 스택 정리 후 6개 브랜치 push 및 stacked PR 작성. 운영 배포·100건/30분 비교는 아직 안 함.
- 다음 명령: `npm test`; `DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55435/nomorevibe_test node --import tsx .crawl-samples/review-speed/smoke-setup.mts`; text/publisher를 `docker run --init ... nomorevibe-worker:review-speed-20260921 node --import tsx scripts/worker-supervisor.ts --role=text` 방식으로 실행. 상세 배포/검증 명령은 `docs/operations/review-pipeline-speed-runbook.md`.

# Phase 05 update — dedicated text worker implemented

Branch perf/isolate-text-worker; phase04 commit4d79a0f. text owns reason-translate+crawl-tagline serially; publisher only crawl-publish. Catalog/worker parser/supervisor180s/pool3/operations role+UI label/Compose/environment template/runbook wired. Existing translation55s, tagline default25s unchanged. 2new tests RED→GREEN, related7files36PASS, tscPASS. Phase04 final type passed; whitespace EOF warning fixed here. No Dokploy or production environment changed. Phase06 remains full regression, isolated worker container health, safety review, docs and stacked PRs.

---

# Phase 04 update — text result fencing implemented

Branch fix/fence-text-job-results, prior phase03 commit927fd03. Automatic tagline writes now ONLY through recordTaglineResult(task,lease,result): exact candidate/document/written snapshot compare under locks, absent-row conditional upsert cannot overwrite manual insert, success/failure/reuse protected, result+release+publish request+lease assert atomic. Removed unsafe automatic functions; two publication tests now seed rows directly. Worker translation wrapper mandatorylease, HTTP/search API unchanged. Both text workers pass AbortSignal, suppress writes after shutdown, wait for started lanes before throwing.

Tests: original6 new race cases all RED→GREEN. Added3 source CAS and1 translation lease/HTTP case ->10newPASS; existing10taglinePASS (20combined). Original related4files72tests70PASS2failed due SQL raw Date serialization; corrected ISO+millisecond compare, affected20 nowPASS. Translation/publication remaining56 alreadyPASS. Unit3files35PASS. Type check initially found obsolete test import; removed, rerun pending. No deployment. Next role isolation PR05 then complete verification/real local supervisor smoke/PR creation.

---

# Phase 03 update — bounded review draining implemented

Branch perf/review-bounded-draining. Phase01 commit1dd580d, phase02 0fec460. First review 40s budget, fixed24s gateway/20s CLI, 2s save margin, configured active concurrency unchanged, max16 admitted candidates, preparation inside slots, dedup candidate IDs. Stop refilling on provider/record errors; await all lanes before lease release. Ready continuation allowed only first/second, progress+fresh eligible queue required, excludes seen/running candidates. Runner preserves incoming requestedVersion and only leaves one own continuation. Existing role serial poll fairness unchanged.

Tests: new refill/dedup RED2 -> GREEN; runner continuation RED1 -> GREEN3. Unit4files45PASS; integration4files39tests initial38PASS1old batch signal assertion failed; adapted that assertion to second request (new gate contract), targeted2files7PASS. Other32 alreadypassed. Type and scopedlintPASS. No production calls/deployment. Next implement text CAS/lease fencing before role separation.

---

# Phase 02 update — transactional review handoffs implemented

Rules→first/publish, first→second/publish, second approved→publish and fallback→second now commit with state changes. Duplicate batch signals removed. Source/policy/approval predicates unchanged. Lease update lock on second results avoids concurrent self-signal lock upgrades. New integration test RED8/PASS1 -> PASS9; related integration5files103PASS; type PASS. Unit old batch-signal expectation deliberately updated to transactional contract, next command reruns 51 tests. No deployment.

Next: bounded draining (PR03), text fencing (PR04), isolated text role (PR05), full verification (PR06). Commands use explicit TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55435/nomorevibe_test only. No production environment loaded.

---

# Active handoff — review pipeline speed implementation (2026-09-21)

Objective: implement six PR phases in docs/plans/2026-09-21-review-pipeline-speed. User explicitly approved proceeding. No model/prompt/approval-policy changes, no LAYA runtime integration. No prohibited skills/subagents. execute-plan and TDD applied; Next Vitest/env guides read.

Phase 01: added safe allowlisted structured model/reuse/commit/queue telemetry, monotonic adapter timing, offline JSONL report. Adapter timing includes HTTP/CLI response parsing, excludes preparation/save; clock is application UTC against DB queue timestamps, negative waits excluded. No production speed claim. Branch perf/review-stage-observability from origin/main af50608, separate from LAYA draft PR159/160. Copied six existing plan documents from experimental branch. Prior private LAYA config remains /Users/jr/.config/nomorevibe/laya.env mode0600; never print key or load it for tests.

Modified: lib/observability/review-pipeline.ts, scripts/report-review-latency.ts, first/second/publish handlers, tests/review-pipeline-observability.test.ts, plan docs, handoff.

Executed: telemetry TDD 3 expected assertion failures against stub -> 3 PASS; focused 4 files 41 PASS; dedicated loopback nomorevibe_test publication gate 17 PASS; npx tsc --noEmit PASS. Initial missing-module failure replaced with stub for proper assertion RED. Existing expected lease-loss logs and Vite warning only.

Remaining: transactional handoffs; slot refill/ready continuation; text result CAS/lease fencing; separate text role/config; comprehensive regression and local worker smoke. No production settings/deployment changed. PR01 telemetry receives additional transactional commit/request events in PR02/04. Offline report intentionally does not accept live DB credentials; DB cohort comparisons remain explicit read-only operations work.

Next commands:
```sh
npx vitest run tests/review-pipeline-observability.test.ts tests/agent-review-job.test.ts tests/second-review-job.test.ts
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55435/nomorevibe_test npm run test:integration -- tests/integration/review-publication-gate.test.ts
npx tsc --noEmit
git diff --check
```

---

# Active handoff — crawl identity and review criteria audit COMPLETE (2026-09-21 09:57 KST)

## Objective / completed work

User requested existing crawl paths checked against duplicate records and new >=500-star criteria. PR158 bd0c654 merged as `678380cba2e268916504d99c3ef2421d8d6e4c08`, all8productionapps deployed to that functional commit. Root main synced. No subagents. User prohibits systematic-debugging/brainstorming/writing-plans. TDD/prod skills used. Unrelated untracked/design files preserved.

- Case-insensitive discovery identity locking with first-signal preservation; applies to all4frontier insert paths: discovery, stale review refresh, admin evidence refresh, rejected reconsideration. Five historical terminal alias pairs kept as audit history. Actual duplicate productrepo identities0.
- Shared repository+URL duplicate matching in rules job/firstreview/publication for BOTH website/installable; finaltransactionlocks prevent concurrentabsentrowrace. Productinsert/repochange join sameidentitylock; distinctmakerproducts sharingmonorepo not globallyforbidden.
- Firstreview preserves actual hard-rule reason; duplicate/banned finalstops store existingproductlink/status. Reconsiderapply rechecks products/casealiases afterpreview. Guardedmetadatarepair with audit/CAS no newproduct/publication, no humanoverride or model-prose-as-proof.
- Migration0043 APPLIED production: frontierlower and normalizedrepo expressionindexes;44ledgerrows. Readonly EXPLAIN lookup113ms→0.019ms. Auditedactor `codex-2026-09-21-crawl-identity`:120repairs(27lostrule-reasons+93missingrefs),0conflicts. Subsequentpreview0eligible. Current720duplicate-rejectionrecords allmatched withrefs.120auditrows,0publicationevents,0erroneouspublishedstates. Do not unnecessarily rerunapply.
- Cohort160 at09:57:109published(99installable/10website),36rejected(35notproduct/1personal_site),15held(7ambiguous/2no_description/6secondsplit). All109usedlatestprompt2026-09-21.3/rules2026-09-21.2+independentsecondapproval;invalidinstallationcriteria0. Plugin11/Skill3. This is gate verification, not100%modelaccuracy. Jobsfetch/judge/first/second/publishlast_errornull.
- All8deploymentdone678380c. Sixworker/connectcontainers healthy with16/16sourcehashes eachmatched. Bothwebhealth/dbok2ms. Runtimehealthreleaseenvstillold2839ec; deploymentrecord/hash+DOMareproof. Liveadmin teaql/teaql-cargo-cli shows duplicateexplanation and/p/teaql link,24h+1596,desktop/mobile nooverflow/errors0. Screenshots inspected.

## Modified files / tests

Core: lib/crawl/{repository,admin-review,agent-review-repository,reconsider,publication-guard,publish,duplicate-reconciliation}.ts; jobs/{judge,agent-review,publish}.ts; lib/domain/products/{repository,repository-identity}.ts; DBschema/indexmigration0043+journal; ReviewDetail wording; scripts/reconcile-crawl-duplicates.ts; regressiontests andupdatedunitmocks. `git show bd0c654 --stat` lists30implementation/reportfiles.

Executed 14newregressionsREDthenGREEN. Finalunit1066PASS; integration744/76filesPASS; types/full lint/build/diffcheckPASS. PRCI35547260727 andmainCI35547573556PASS; CIalso1066/744. Intermediateunit14failureswereoldmockexports, updatedthenpassed. Newadminrefreshregressionintentionallyfailedintermediatefullsuite, fixedwithsameidentityguard. NewhelperinitialmissingmodulefailurewasfollowedbyrealstubassertionREDbeforeimplementation. No testsrunagainstproduction; productionqueries/metadatarepair separate explicitprivateenv.

Report: docs/operations/2026-09-21-crawl-identity-review-audit.md. Publicdata-only verificationartifacts+screenshots under docs/operations/evaluations/2026-09-21-crawl-identity/.

## Remaining / failures / exact commands

Requested implementation/review/deploy done.15heldcases require additional evidence/humanjudgment; do notforcepublish orrerun160/392reconsiderations. Documentation-onlycompletioncommit followsfunctional678380c; no need redeploydocs-only.

Operational incident: old/tmp/nmv-installable-deploy-status.py used subprocess.check_output with credentialheaderinargv; a timeout traceback exposedtheDokployAPIkeyintheconversationtooloutput. NEVERrepeatvalue. No keyvaluecommitted/storedinreports. Replacedstatushelperwith/tmp/nmv-dedupe-deploy.py (curlconfigstdin,25sdeadline,redactederrors); oldstatuspathdelegatestothis. Oldruntimehelpercouldhave sameerrorrisk; useNEWruntimehelperbelowreading sanitizedappmetadata, notold. **Keyrotationstillneeded, notperformed** (sharedcredential otherdeployments). Usernotified. Do notclaimallsecurityfollowupdone.

GitHubcorequota wasexhausteduntil09:17:47; respectedreset (ghauthstatusmisleadinglysaidinvalidtoken). Didnotrotateaccounts/tokens tobypass. Dokployreadtimeout retriedwithboundedredactedhelper. No settings/modelchanges,Sonnetfallbackretained,noOpus.

```sh
cd /Users/jr/Desktop/projects/nomorevibe
python3 /tmp/nmv-dedupe-deploy.py
python3 /tmp/nmv-dedupe-runtime.py
node .crawl-samples/queue-status.mjs /tmp/nmv-dedupe-next-cohort.json
node .crawl-samples/dedupe-gates-audit.mjs /tmp/nmv-dedupe-next-gates.json
npx tsx .crawl-samples/dedupe-reconcile.ts # preview only; --apply already completed
npx tsx .crawl-samples/dedupe-live-ui.ts
```
Private0600 /tmp/nmv-installable-web.env andprod.env neverprint/commit. ParseexplicitlytooverrideinheritedtestDB; productionmigrationdirect5432. Rootignoredhelpersdedupe-migrate.mjs(alreadyapplied),dedupe-reconcile.ts(applied),dedupe-operation-proof.mjs(readonly),dedupe-gates-audit.mjs(readonly). Receipt/tmp/nmv-dedupe-reconciliation-receipt.json andproofs/tmp/nmv-dedupe-*.json. New/tmp/nmv-dedupe-runtime.py uses/tmp/nmv-dedupe-deploy-progress.json; refreshthatwithsafehelperifneeded. Preservedesignworktree/tunnel.

---

# Active handoff — rejected high-star queue and 24-hour publication change (2026-09-21 08:42 KST)

## Objective and completed work

User says >=500-star products remain rejected; correct missing review paths and display rolling24h (+/-) next to Published. User explicitly prohibited systematic-debugging; do not use it. No subagents used. PR157 merged and deployed, functional commit `b9428376a7d3b2da782be282c7dff27f7d9dffbf`. Root main synced. Original unrelated untracked/design files preserved.

- Production audit:234 rejected>=500;70 already_listed matched existing product URLs. Repo_url-only comparison falsely looked unlisted. Remaining omissions: release/package/social/docs URLs and unreachable homepages were rejected before installable exception. Shared accessFromDocument now consistently routes >=500 eligible repository fallback through substantive README review in judge, first/second input, classifier and publication. No automatic star-only approval; fork/archive/research/survey, duplicate/ban, source-generation and independent second-review gates stay. Original source URL retained. Prompt2026-09-21.3, rules2026-09-21.2.
- Explicit --include-admin reconsideration option (default preserves human decisions). Current user request includes previously excluded15admin rejections; prior decisions and reasons retained in audit. SnapshotCAS plan161examined160eligible; APPLY COMPLETED160queued0conflicts. Actor `codex-2026-09-21-rejected-queue`; receipt `/tmp/nmv-queue-reconsider-receipt.json`. DO NOT rerun apply.
- Migration0042 APPLIED production: publication enter/leave/delete event trigger, existing published transitions backfilled; short write lock closes bootstrap race. Signed24h change uses DB clock and actual state transitions, not arbitrary updates. Duplicate UI label + existingSlug links (63/70legacyduplicates have stored slug).
- All8Dokployapps done on b942837; sixworker/connectcontainers healthy and12/12sourcehashes match. BothwebhealthHTTP200/db2ms. Live authenticated admin desktop/mobile screenshot shows16941(+1894) at08:39, no browser errors or horizontal overflow. RELEASE_TAG healthenv stillhistorical2839ec; deployment descriptions and hashes prove actualsource.

## Tests, files, failures

Executed unit1066PASS, integration730PASS/75files, browser2PASS (positive/negative24h, desktop/390px), types/scopedlint/build/diffcheckPASS. PRCI35544904190PASS including clean migrations. MainCI35545174640PASS. Live public search finds Transformers; /p/transformers and /p/salesforcedx-vscode return200 and show Copy Prompt, browsererrors0. Sevenneweligibility regressions RED beforefix; explicitadminscope REDthenPASS; deltaDB tests REDmissingtable then clock-skew failure corrected by DBclock,3PASS.

Files: rules.ts/access consumers; reconsider.ts/CLI; review page/count query/duplicateUI; crawl-schema; migration0042/journal; unit/integration/E2Etests. Report `docs/operations/2026-09-21-rejected-queue-and-publication-change.md`; publicresultartifacts `docs/operations/evaluations/2026-09-21-rejected-queue/`.

Failed diagnostics: nonexistent readme_excerpt column / github_api_cooldowns table queried read-only; actual README ispage_meta and cooldowns are rate_limits. No data changed by failedreads. No secrets printed. Model/runtime settings unchanged; Sonnet fallback retained, noOpus.

## Remaining work and exact next commands

The implementation/deploy/re-review enrollment is done. Normal asynchronous pipeline continues160cases; do not claim all160published.08:40:60freshfetch,100waitingcollection,52needs_review,8rule-approved,0published.08:41firstattempts7approve1reject, no errors.08:42:118fresh;7published(transformers/gutenberg/salesforcedx-vscode/etc),2notproduct,151stillprocessing. Worker last_errornull. Independentsecondreview/publication proven working; remainingitems continue normally. Prior392cohort is separate; do not reapply its plan or repair scripts.

```sh
cd /Users/jr/Desktop/projects/nomorevibe
node .crawl-samples/queue-status.mjs /tmp/nmv-queue-next.json
gh run view 35545174640 --json status,conclusion
python3 /tmp/nmv-queue-runtime.py
npx tsx .crawl-samples/queue-live-ui.ts
```

Ignored helpers root `.crawl-samples/queue-status.mjs`, `queue-live-ui.ts`, `queue-reconsider.ts`, `rejected-500-inspect.ts`. The reconsider plan is ALREADY APPLIED; only status/UI helpers are safe to repeat. Explicit private0600 `/tmp/nmv-installable-web.env` and prod.env; neverecho/commit. Envfile must explicitly override inheritedtestDB. Migrationusesdirect5432, runtime6432. DokployAPIKeychain perprodskill. Bothwebapps oipo2OAnIrtcnILBCRoG2 / llv4rlABSJOcFauSxaHdx, main. No localserver left running after E2E; design preview/tunnel untouched.

---

# Active handoff — installable GitHub products (2026-09-21 02:35 KST)

## Objective and completed work

User requested >=500-star software without deployment URLs, Copy Prompt installation help, Plugin/Skill categories, both review prompts, re-review rejected candidates, and collection proposals. Implemented, reviewed, tested, committed and deployed PR154/155/156. Final functional commit `0db0b2d15f553cc8670df3765840686d8720e908`. Root main pulled to this commit; original unrelated untracked/design files preserved.

- Additive production migration0041 applied: products.access_mode defaults website. Installable products use canonical repository identity without altering candidate/document source URL.
- >=500 installation eligibility, substantive shared1st/2nd review, document/survey/data-list exclusions, fork/archive/ban/duplicate protection. Shared prompt2026-09-21.2 and rules2026-09-21.1. Independent2nd gate stays enabled; same-model votes do not independently approve; existing Sonnet fallback unchanged.
- Plugin/Skill categories and README-aware classification RPC. Installation UI and safe repository-specific clipboard prompt, manual-copy fallback, ownership/uptime behavior adapted.
- Production canary exposed and fixed SQLNULL vs JSONnull README CAS bug and GitHub/docs wrapper product identity. README loss reproduced failing before repair; source-change protection preserved. Existing wrong identity5products corrected via audited CAS;33automatic held candidates requeued after real README recovery. tksuoran/erhe has empty README and remains human review.

## Operational results and remaining work

- All8Dokploy apps on functional commit0db0b2d, done;6worker/connect containers healthy with9source hashes eachmatch. Bothweb /api/health200 and DB1–2ms. RELEASE_TAG env remains historical, so actualdeployment/sourcehashes are proof.
- Audited actor `codex-2026-09-21-installable-policy`:497auto-rejected examined;392queued,0revision conflicts;392freshfetches complete.02:35KST:21published(14installable/7website),18rejected(13duplicate/4notproduct/1other),353review/held(55approved state awaiting gates,296ambiguous,1no_description,1second_review_split). Fifteen admin rejections retained. DO NOT claim all392finished; normalworkers continue.
- GitHubcore limit initiallypausedfetchuntil02:17. Sharedcooldownwas respected, noquota bypass. Currentjobs last_errornull. Historical modelinvalid_output attempts remain inledger; jobhealth is not perfect modelaccuracy.
- Plugin/Skill categoryschema/filter ready; nofinalpublishedPlugin/Skill at02:35. Zero-countcategories are hidden byexistingdefaultfilterpolicy but explicit URLs work. Waitnormalreview/classification; don'tforcepublish or fabricatelabels.
- Real public products tested: /p/elevenlabs-python and /p/github(Calibre-Web-Automated;preservedexistingURL). Correctnames/taglines, clipboardcanonicalrepo,390pxnooverflow,pageerror0. Screenshots in installableworktree test-results/installable-live-final-{desktop,mobile}.png.
- Next action is observe automatic cohort and review genuine human cases. Do NOT reapply plan/repair. No featureimplementation remains pending; data processing/human decisions remain. Collection improvements are proposals in report, not implemented.

## Files and validation

Implementation spans lib/domain/products/access.ts, lib/crawl/{rules,agent-review*,publish,publication-guard,reconsider,repository,readme,settings-schema,classify}, schema/migration0041, operations RPC, detail/list UI, thumbnail/health/verify behavior and tests. `git diff c42b266..0db0b2d --stat` gives exactlist. Report: docs/operations/2026-09-21-installable-projects.md and evaluationartifacts.

Actually executed: fullunit1058PASS; latestGitHubCI integration724PASS; type/lint/buildPASS(existingvendorwarningonly); local E2E4PASS and livebrowser2productsPASS. Final focusedintegration64PASS includesnullREADME,identity,sourceCAS,reviewgates. PR156 CI35525705682PASS. No need rerunbroadtests for documentation updates.

Live model evaluation: initial4repos×2models8consistent; additional6repos×2modelsbefore/afterrevealedtype-definition/playlistboundaries. Final two cases stilldisagree. Not statisticalaccuracy. Stored publicinput-derivedoutputsunder evaluationfolder.

Failed approaches: Node --env-file did notoverride inheritedtestDATABASE_URL (initialreadonlytestauditdiscarded); use explicitparseEnv. Rawpostgres naive timestamp display shifts locally; useSQL::text/SQLage(DrizzleUTCcorrect). InitialUIfilterselectfailedbecausezero-countcategoryhidden, explicitcategoryURLverified. Inline tsx-e dynamic import schema was undefined; transactionrolledback; standalone auditedtagline requestscript succeeded. No productioncredentialsprinted orcommitted.

## Exact next commands

Working implementation/ignoredoperationshelpers: `/Users/jr/Desktop/projects/nomorevibe-installable`; rootmain `/Users/jr/Desktop/projects/nomorevibe`.

```sh
cd /Users/jr/Desktop/projects/nomorevibe-installable
node .crawl-samples/installable-cohort-status.mjs /tmp/nmv-installable-cohort-next.json
python3 /tmp/nmv-installable-deploy-status.py
python3 /tmp/nmv-installable-runtime.py
git status --short
```

Monitor parses private0600 `/tmp/nmv-installable-web.env` explicitly. Private reviewerconfig `/tmp/nmv-installable-prod.env`; NEVER echo/commit. Dokploykey inmacOSKeychain perprodskill. Repairreceipt `/tmp/nmv-installable-rollout-repair-receipt.json` has33retries/5identityrepairs andisalreadyapplied. Originalreconsiderplan/receipt `/tmp/nmv-installable-reconsider-live-{plan,receipt}.json` ALREADYAPPLIED. No active localtest/evaluationprocesses remain. Do not touch designworktree/tunnel.

---

# Codex handoff

## Design temporary public link active — 2026-09-17 17:57 KST

- User-requested public preview: https://regarding-develops-conjunction-thoroughly.trycloudflare.com/design. Source branch `feat/final-plan-design` at f854d64; no production/main deployment. Mac/network/server/tunnel must remain running; restart changes URL.
- Worktree `/Users/jr/Desktop/projects/nomorevibe-final-design`; ignored runtime helper `.design-review/share/`; server4322 PID44458, path-limited proxy4323 PID70421, cloudflared PID47260. Read that worktree's handoff for exact restart/check commands. Do not kill reviewing processes.
- Public Chromium smoke passed: five screens×1440/390, mobile search/save, zero console/page errors/overflow; API/admin/env404, POST405. Initial Next-Url relay omission fixed and proven by RSC200 instead of307. Report and handoff updated; app source unchanged.

## Active handoff: final business plan design completed on separate branch — 2026-09-17

- User asked for the final business document's development plan and design implementation on a separate branch; explicitly prohibited brainstorming/writing-plans skills. Source PT files were read; original main source and unrelated ProductHero changes were preserved.
- Completed and pushed `feat/final-plan-design` at `f854d64` in `/Users/jr/Desktop/projects/nomorevibe-final-design`. 21 screen specifications /24 representative routes at `http://127.0.0.1:4321/design`; browser result tab opened. No main merge or production deployment.
- Full objective, modified file list, decisions, failures, remaining work and exact commands are in that worktree's `docs/CODEX_HANDOFF.md`; deliverables `docs/plans/2026-09-17-final-business-development.md` and `docs/operations/2026-09-17-final-design-preview.md`, three committed UI captures under `docs/design-preview/final-plan/`.
- Actual final checks: 979 unit tests, 10 browser tests, types, scoped lint, build and diff check PASS. All24 routes tested at1440/390; no console/page errors, API requests or overflow. Production DB integration not run. This is local sample-data design; actual Claim/auth, uploads, payments, transactional credits, Agent execution remain planned backend PRs.
- Key boundaries: free registration, User/Agent separation, owner/Agent reward exclusion, maker/reviewer separation, shipped ≠ reconfirmed; localStorage key `nomorevibe-design-v1` only. Review fixed mobile search, dashboard filter/detail and owned-product scope, Agent submission guard, release-link persistence. Initial symlink+webpack and Playwright caret-hydration issues resolved in the separate worktree; see detailed handoff.
- Next exact: `cd /Users/jr/Desktop/projects/nomorevibe-final-design`; `git status --short`; `npm run dev:design` if port4321 is not already serving this tree; `npm run test:design`; `npm test`. Continue M1 product lifecycle then M2 Claim from the plan when requested. Do not run historical production mutation scripts. Root's earlier Spark investigation edits and PT/prototype files remain uncommitted as before; this pointer is appended without replacing them.

## Follow-up: Spark authentication diagnosis — 2026-09-17 11:48 KST

- User asked why Spark returns access_denied and whether Codex is logged in. Both local CLI 0.154.0 and connect-agent owner CLI 0.153.4 report `Logged in using ChatGPT`. Stored owner ID-token plan is pro; not a live billing check. Reviewer default home being unauthenticated does NOT imply the owner is logged out.
- Actual local Spark minimal call (tools disabled) returns HTTP400 invalid_request_error: model not supported when using Codex with a ChatGPT account. Owner cached model list lacks Spark; current classification reports access_denied. failureReason groups `not supported` with403, so previous status never proved actual403 or missinglogin. Exact server-side entitlement/rollout cause remains unknown; don't claim account-wide denial or forced re-login needed.
- Read official https://learn.chatgpt.com/docs/models and /docs/auth: Spark listed for Pro, availability depends on rollout/auth/client. No authentication copied, no model settings changed, no Spark adapter deployed. Sonnet fallback remains. No source edits/tests in this diagnostic phase.
- Helpers: `python3 /tmp/nmv-spark-auth-audit.py` reads sanitized owner login/status/cache (never outputs token values). Fresh owner probe result `/tmp/nmv-spark-probe-20260917.json`; probe invokes only built-in synthetic classification check. It updates diagnostic account status, not production candidate decisions/configuration.

## Sonnet fallback implemented and deployed — 2026-09-17

- Objective: automatically recover technical second-review failures, using **Sonnet or Codex Spark; never Opus**. Implemented and deployed Sonnet. Spark returned actual `access_denied`; its adapter remains only on local branch `fix/spark-review-fallback` at `beaeb42`, NOT shipped. Never copy connect-agent-owned authentication files.
- Source: PR #116 fixes raw evidence handling, retry limits, error details, current-model queue and failure alerts; #117 adds linked model fallback; #118 fixes Unicode truncation in collection; #119 makes same-first Sonnet fallback reference-only. Final runtime source **2839ec5d7578493a8f34bb475f48f32cbc50104b**, all 7 apps deployed, 5 workers healthy / 10 source hashes match, both web servers HTTP 200 and DB healthy. PR119 CI 35173417543 and main CI 35173699866 passed.
- Current settings: first reviewer Sonnet in `observe`; second voters `[MLX] qwen3.8-27b-uncensored` and `[MLX] gpt-oss-120b`; fallback only `claude-cli/sonnet`. Opus disabled audit 27 at 10:48:36 KST; Sonnet enabled audit 28 at 11:17:18; Qwen ID updated audit 29 at 11:24:32 after live gateway removed old ID and a fresh 14-case evaluation. These mutations are already applied; **do not repeat switch scripts**, especially the old Opus switch.
- Decisions: normal reject/abstention never triggers fallback; failures share a total budget of 3; actual model, original error and linked history remain. Same-first Sonnet is not an independent vote and forces human review even when another model agrees. Removed fallback leaves a required null-vote human-review placeholder instead of silently erasing a slot. Migration 0035 applied (36 migration records).
- Actual evidence: 11:19:15 KST observed 24 automatic Sonnet recoveries, all valid and human-review (first was also Sonnet). After the Qwen replacement, 11:30:56 showed another 13 active Sonnet results, no pending Sonnet rows, 0 broken links / budget overflows. Old Qwen-linked results subsequently became resolved history as designed. Do not combine snapshots as current queue counts. Final 11:32:17 canary also verified 3 actual new-Qwen worker responses (2 agreed, 1 human), 13 current Sonnet results / 0 pending Sonnet, no active Opus. Queue still had Qwen 284 pending and OSS 2 pending / 2 invalid-output retries; do not claim an empty queue. All four job last_error values null. Portable `canary-final.json` and `public-ui.json` recorded.
- Collector fix: `Zee7280/ciel_frontend` had 143 attempts and no document; truncation created an unpaired UTF-16 surrogate. Sanitizing after truncation fixed JSONB storage. Normal 144th attempt succeeded 11:18:47 without resetting attempts or manually requeuing.
- Tests actually executed for final source: 974 unit, 652 DB integration, types, production build, lint (0 errors / 1 existing vendor warning), admin Playwright save/reload 1 pass. Public live UI at 1440/390 px: home 9→18, popular 15 rows, no overflow/page errors; mobile screenshot inspected. Direct final code review completed. Do not run fixture DB tests against production; local DB port 55435 only.
- Failed approaches: gateway adaptive context changed evidence (fixed with raw); Gemma semantic/format issues prompted evaluated replacement; coder 30B repeatedly timed out and was excluded; Spark access denied and not deployed; a flaky evidence-refresh test completion boundary failed once (651/652), fixture timestamp fixed and all 652 passed. Initial Unicode SQL probe double-encoded JSON and was corrected to `::text::jsonb`.
- Modified source files are recorded in merged PRs. Final documentation: `docs/operations/2026-09-17-sonnet-fallback.md`, historical diagnosis/fallback reports, Unicode report, and corresponding `docs/operations/evaluations/2026-09-17-*` evidence. Main user edit `components/product-detail/ProductHero.tsx` and prior design/news/9-14 evaluation artifacts remain untouched and unstaged.
- Remaining limitation: real models can still fail and queued backlog is not zero; small selected model evaluations are not general accuracy estimates. Same-first fallback requires human action. No Spark availability claim and no Opus use authorized. No requested source/deployment work remains. Final docs/evidence are included in this completion commit; push it to main. Documentation-only changes do not require another runtime deployment.
- Exact read-only checks (helpers are local, no secret output): from `/tmp/nmv-second-review-fix`, run `python3 /tmp/nmv-review-env.py npx tsx .crawl-samples/second-review-fallback-canary.ts`; `python3 /tmp/nmv-second-runtime.py`; `python3 /tmp/nmv-hardening-web-health.py`. From root: `git status --short`; `node .crawl-samples/sonnet-fallback-live-20260917.mjs`. Keep runtime hash helper at deployed source 2839ec5, not the local Spark spike.

## USER OVERRIDE: Sonnet fallback IN PROGRESS — 2026-09-17 11:04 KST

- Latest explicit user: fallback must NOT use Opus; use Sonnet OR Codex Spark. Immediately DISABLED Opus at10:48:36KST, audit27, fallbackpool=[]; primaryQwen3.8-27b+OSS, firstSonnetobserve unchanged. Do not reenableOpus. Opuswasbrieflyenabledaudit26 at10:44:20and2actualgatewayerrors→Opuscompleted10:46:31 (1agreed,1human), historymustremainbutinactive.
- PR117 59e405cfede76b55a4ac9997b3ea4106e1a6ff3c deployed7apps:5workershealthy/9sourcehashesmatch,web2health200DBok2ms. MainCI35171553476PASS, PRCI35171251145PASS. Migration0035APPLIED36records. Rootmain59e405c userHero untouched. Rootdocs/evidenceuncommittedstillneedfinalcommit.
- InvestigatedSpark: gatewaymodelsnospark; reviewerCLI0.153.4 NOTloggedin andnoCONNECT_AGENT_URL/secret. Existing dedicatedconnect-agentowns encryptedCodexcredentials (nevercopyauthfile). PublisherRPCstatus at10:52Sparkaccess_denied, Sonnet success; connected/configReadytrue, primarySpark/fallbackSonnet. Thus cannotenableknownfailingSpark. TolduserwewilluseallowedSonnetbutbecause1stalsoSonnetitwillnotcountasanindependentvoteandrequiresmanualreview.
- SparkadapterSPIKE preserved LOCAL commitbeaeb42 branchfix/spark-review-fallback in /tmp/nmv-second-review-fix; NOTpushed/PR/deployed. SupportsreviewRPCsingleauthowner,busydefer,validation/UIprovider/tests. Tests981unit/651DB/type/lintPASS/browser1PASS. E2EfirstlaunchcancelledbeforerunbecauseDBsuiteactive, thenrerunafterDBsuitePASS. Do NOTshipspikewhileSparkaccessdenied. Needno8thappdeployorcredentialconfigifSonnetonly.
- CURRENTisolatedworktree /tmp/nmv-second-review-fix branchfix/sonnet-review-fallback based240f51d (118merged), commit412203a PR119CI35173417543PASS; MERGED2839ec5d7578493a8f34bb475f48f32cbc50104b11:15:11KST; DEPLOYEDall7apps11:16,5workershealthy10filehashesmatch(web2health200DBok1/2ms),rootmainff2839ec5. SonnetfallbackIMPLEMENTEDasreference-onlywhenfirstmodelmatches: preferindependentpool, allowechoonlyfallbacklinkedrows, loadinputallowslinkedEcho, recordcombineVerdictsalreadymarksneeds_human; summarymustkeeppendinguntilresponseandthenforcehumanforechofallback. Preserveoriginalmodelhistory; avoidduplicatedvotes. UpdateUIechoexistingmarkeralreadyexists. Productionsetpool=[claude-cli sonnet]ONLYafternewcode. Handledactiveoriginalslotwhenfallbackremoved: originalrootbecomesneeds_human/nullvote withmaxchainfailurecount, NOTpending/retry; keepfailurehistoryanddoNOTresetbudget, so2formerOpusreplacementsdon'tsilentlyleaveemptyrequiredslots. Newtestscoverotherindependentvote+Sonnetecho stillhuman.
- Sonnet14casereadonlyprobe COMPLETE14valid/14referenceagreement median5957ms max6612ms, session30362 `/tmp/nmv-sonnet-evaluate.py` writesroot `.crawl-samples/second-review-fix-20260917/sonnet-evaluation.jsonl`, log/tmp/nmv-sonnet-evaluation.log. Reviewercontainer45f668a0b61bM3. Same14casespreviousOpus/Qwencomparison. NoDBjudgmentswritten.
- EXTRAactualcollectorbug found10:47 `Zee7280/ciel_frontend`: pageTextendslonely\ud83d after3000UTF16slice. Loggingfullquerymetadata24KB hidesPGcause. LocalPG `::text::jsonb` proves22P02 Unicode low surrogate must follow high surrogate; initialprobeaccidentallydoubleencodedJSONstringfixed. Separateworktree/tmp/nmv-unicode-fix branchfix/crawl-unicode-boundary PR118. FixsanitizesAFTERtitle300/desc500/bodylimit; regressionREDthen37unit/scopedlint/diffPASS. PR118CI35172657881PASS, MERGED240f51d; no deploymentyet. Needmerge119afterCIanddeployfinal7once, recrawlthatrepowithauditifstuck. No migrationforboth.
- Safehelpers: /tmp/nmv-review-env.py prodDB+gatewayenvonly; /tmp/nmv-hardening-deploy.pyreleaseSHA/deploy/status7apps; /tmp/nmv-second-runtime.py sourcehash9files(addnormalizefor118); /tmp/nmv-hardening-web-health.py. Worktreeignored `.crawl-samples/second-review-fallback-canary.ts` readonlystate+lineage; `.crawl-samples/second-review-disable-opus.ts` ALREADYAPPLIEDaudit27donotrepeat; originalfallback-switchscriptenablesOPUSDO NOTRUN. NEW `.crawl-samples/second-review-sonnet-switch.ts` APPLIED11:17:18KST audit28, Sonnetonlyfallback. WillsetSonnetwithCASemptyfallbackpool. DO NOTuseoriginalOpusswitch.
- Canaryfiles/tmp/nmv-fallback-canary-{1,2,3}.json;3at10:47:23has2Opussuccesses/Qwen10results,lastcrawlererror(separatebug),36migrations. Rootportabledeployment.json reflectsearlierOpusenableaudit26andmustbeupdatedwithdisable27/finalSonnetauditlater. ReportsPR116/117historicalneedtopcurrentcorrectionandfinalnewreport. Rootownuntrackeddiagnosisdocs/evidencecanexplicitlystagewithfinaldocs; preserveallprioruserdesign/prior9/14reports andHero. CurrentactualfallbackOFFuntilSonnetready.

## Sonnet validation checkpoint

- Sonnetbranch local974unit/type/build/lint0errors/browser1PASS. FullDBfirst651pass1failed existing evidence-refresh completed_at<=DBnowboundary; isolated11PASS, fixture now explicitnow-1000ms. FullDBrerun /tmp/nmv-sonnet-integration-final.log COMPLETE652PASS. PR119CI35173417543running head412203ac0b66d71d1f4c1f9dc23913bf36a233f1. No introducedproductionlogicchangeforflakyfixture. UI screenshots overwrittenwithSonnet values inworktreeignored.crawl-samples.
- PR119CIpassedanddeployed. MainCI35173699866running. Afterdeploy7apps,verifyallworkerhashes+2web,apply NEWsonnetsettingsscript,normaljobcanarymustshowrealSonnetlinkedresult withfirstModelsonnet/needs_human. OldOpusmodel_removedhistoryshouldstayinactive; rootorphanmanualplaceholderhandledbynewcode. Updatecanaryscript examples toselectfirst_model.
- Collectorfix118 actualrecovery outstanding: affectedrepoZee7280/ciel_frontend maybefetching/failed fromrepeatedmalformedUnicode. Readonly11:11:48KSTfrontierfetching attempts143 nextAttemptAt11:18:06,documentNONE,lastcrawl-fetchsuccessfresh. Afterfinaldeployverifydocumentexistsandfrontierdone; ifstuckuseauditedtargetedrequeue preservingattemptcounts. Addnormalize.tsto/tmp/nmv-second-runtime.pyFILES. ReportallfinalstatesandcommitdocsexplicitpathsrootpreserveuserHero/priorartifacts. Finaldocstestcountsneverclaimnotrun.

## Second-review fallback IN PROGRESS — 2026-09-17

- Latest user explicitly requests automatic fallback on failures. PR116 ffa13c3 is ALREADY deployed all7apps; 5workers healthy/source hashes match; web2health200/DBok. Migration0034applied35records. Production model switch audit25 at10:17:29KST Qwen3.8-27b+OSS; firstSonnetobserve unchanged. Do NOT rerun old model switch.
- Isolated /tmp/nmv-second-review-fix branch fix/second-review-fallback. Newcode adds configurable ordered fallbackpool, linked actual-model rows fallbackForId, shared3failurebudget, uniqueindependentmodel selection, priorityqueue, source/configguards, adminsettings. Migration0035APPLIEDproduction36records at10:37KST. PR117head414180e CI35171251145PASS; merged59e405cfede76b55a4ac9997b3ea4106e1a6ff3c at10:41:50KST. All7DEPLOYED59e405c: 5workershealthy/9sourcehashesmatch,2webhealth200DBok2ms. Rootmainfastforwarded59e405c; userHero preserved. OpusfallbackENABLED audit26 at10:44:20KST. Initialcanary10:44:21noattemptsyet,36migrations; mainCI35171553476running. Needactualautomaticfallbackandfinalreport/docscommit. RED3DB+1UI executed. All973unit/650integration/tsc/build/lint0errors existingvendorwarning/Playwrightadminsave+reloaddesktopmobile1PASS; screenshotinspected. Directdiffreviewdone.
- Production readonly Opus14caseprobe complete14valid, 14/14referenceagreement; latency3.8–9.9s. Coder30Bprobe stoppedownedPID29709 afterrepeated60stimeouts; excludeproduction. Initialfallbackwillclaude-cli opus only; max2pooloptional. Never fallback validreject/needs_review/disagreement. Failurehistoryretainedlinked; no fabricatedvotes; source/leaseguards preserved.
- Evidence root .crawl-samples/second-review-fix-20260917/opus-evaluation.jsonl/fallback-evaluation.jsonl. Safehelpers /tmp/nmv-review-env.py (prodcredentials childenv only), /tmp/nomorevibe-prod-db.py migration, /tmp/nmv-hardening-deploy.py release SHA/deploy/status; /tmp/nmv-second-runtime.py workerhashes; /tmp/nmv-hardening-web-health.py. DBfixturesONLYlocalhost55435, never production.
- Next exact: cd /tmp/nmv-second-review-fix; npm run test:integration -- tests/integration/second-review.test.ts; npm test -- tests/crawl-settings-form.test.ts; addedgecases/types/fullchecks; commit PR/CI/merge; apply0035thenall7deploy; auditedpartialfallbacksettings switchonlyafternewruntime; checkactualfallbackandqueue. Updateoperationsreport+handoff. RootuserHero+design/priorreportsuntouched; rootmain ffa13c3. Preserveunrelateddirtyfiles.

## Second-review repair IN PROGRESS — 2026-09-17 10:10 KST

- User authorized fixing/replacing models and said continue. Isolated branch fix/second-review-reliability in /tmp/nmv-second-review-fix (real /private/tmp) commit c05e59f. Root user Hero/docsPT/prototypes preserved. Source implementation complete; PR #116 CI35169477766 PASS, merged ffa13c3cb36c59a0e0cfc41b2f4b14dde08871e4 at10:15KST. Production migration0034 APPLIED (35migrationrows); deployment queued session54034, settings switch NOT done yet.
- Proven deeper cause: both live abc-llm M3/mini source hashes match /Users/jr/Desktop/projects/abcLLM backend. Adaptive true/1500token threshold; Gemma auto extracts/summarizes and clips system+evidence. Actual appliedTrue logs vs raw appliedFalse. ChatRequest+forwarder discard response_format/reasoning_effort/client chat_template_kwargs. No abcLLM files edited. Do not change shared gateway gratuitously.
- 6 raw probes:2failedinputs xGemma26/Gemma31/Qwen27 allvalid, but bothGemmas falselyapprove loginwall. Full14cases x3models=42calls:Gemma26raw14valid/12referenceagreement/2falseapprovals, Qwen3.8-27b14valid/14match/0FA median26.1s max56.2s, OSS13valid/11match/1FA/1gatewayerror median15.4s. Smallpurposefulsample not100%accuracy. Allcallscomplete root .crawl-samples/second-review-fix-20260917; portable report/evidence committedbranch.
- Planned settings switch AFTERnewcode: secondReview.voters=[abcllm Qwen3.8-27b,abcllm gpt-oss-120b], keepfirstSonnetobserve/otherpolicy unchanged. Need audited partial/CAS update, requestsecond-review; removeoldmodelrows automatically bynewcode thenchecknewQwenrecordsandqueueprogress. Existingmodels config remainsGemma26/Gemma31/OSS now.
- Code: gateway context_strategyraw andfixed diagnosticdetail; migration0034failure_count default0/error_detail;3completedfailures =>needs_human nullvote; no retry capbypass; removeunconfiguredopinions andlateanswers; enqueueexistingcandidate missingnewmodel fixed; currentfailurealert excludesresolved; UIexhaustedlabel;concurrency8to4. Originalcontractvalidation maintained.
- Tests executed RED2unit+3DB, GREEN45relatedunit/42relatedDB thenALL972unit/638DB PASS; Nexttypegen+tsc PASS (initialfreshworktree PagePropsmissingfixedtypegen);buildPASS;fulllint0errors existingvendor_ctx1warning;diffcheckPASS. Logs /tmp/nmv-second-*.log. LocalDB55435only; neverprodreset.
- Next exact: cwd /tmp/nmv-second-review-fix; git push -u origin fix/second-review-reliability; ghprcreate bodyfile; waitCI/inspectdiff thenmerge matchingc05e59f; 0034 alreadyappliedsuccessfully; do not resetDB. deployall7using /tmp/nmv-hardening-deploy.py release FINALEXACTSHA then deploy/status. User has authorized repair including deployment. prodskill read; informusewhenstartingdeploy. Verifyruntimehashes fromfinalcheckout, bothwebhealth, thenauditedsettingsswitch. Runtimehelper currently6hashes missesgateway/jobs/schema:extendcheckwhitelistforfix.
- Existing helpers safe: /tmp/nmv-review-env.py passes onlysecret env tochildwithoutprinting; /tmp/nmv-hardening-deploy.py status savedroot .crawl-samples/second-review-fix-20260917/pre-deploy.jsonl. Reviewerservice app-copy-primary-hard-drive-b5fhzd M3. No active eval/test sessions; status21971 likelydone; finishcheckifneeded. Build66927done. Noagents spawned.
- Final docs mustupdate report deploymentpendingsection, root handoff, commit/push own diagnostics+fixreportupdates; rootmaincanffmerge sourcecommit sincehand offnotinPR andnewfixreportnotinrootyet. Preservealluserunrelatedfiles; nobulkstage. Currentrootdiagnosereport/evidenceuntracked own frompreviousphase cancommitwithdocs.

## Second-review failure diagnosis COMPLETE — 2026-09-17 09:51 KST

- Objective: investigate user's current second-review failure alert. Diagnosis only; no production settings, judgments, source, deployment, commit or push changed.
- Confirmed deployed aa07228; 5 workers healthy; reviewer actually running second-review; core6 + gateway/job source hashes match local. Gateway models endpoint200 and all3 configured voters present. Health/job success do not measure model-answer success.
- 09:48 readonly DB: failed52 rows/48 candidates (26B invalid28 timeout9 length2;31B invalid2 timeout11); pending388 rows/130 candidates. Error banner recent117 includes65 resolved/superseded historical error rows due missing status filter. Counts are snapshot and candidate populations overlap.
- 08:45–09:45 completed30tick logs:146 valid responses/198 failed calls=57.6% of344 attempts incl retries; enqueued273, deferred1096 incl repeats. No claim of model accuracy/project failure percentage.
- Replayed9 current failed rows (10 selected,1 source changed skipped) with deployed gateway function, no recording:26B5invalid1timeout;31B1invalid1timeout1valid. Invalid examples bare yes (bothGemmas) and two conflicting JSON objects (26B). Header wait timeout60005/60001ms. Row56165 actualurl/page1785chars/README2999chars present but26BclaimsURLmissing. Sameinput GPT-OSS control valid6662ms correctlycitesURL. Selected failures are not representative accuracy benchmark. Gateway schema enforcement/server queue internals remain unproven.
- Amplifiers: no second retry cap;5min transient/1h other;8concurrent/tick108sec/newcallsrequire62sec remaining; pending/failed block consensus. Originalrawresponses and detailedvalidationnotstored, so historical length2 exactbranchunknown. Do not loosen validation to choose one of conflictinganswers.
- Modified files: docs/CODEX_HANDOFF.md; docs/operations/2026-09-17-second-review-failures.md; docs/operations/evaluations/2026-09-17-second-review/evidence.json. Ignored diagnostic scripts/JSON in .crawl-samples/second-review-*-20260917*, pipeline-audit-2026-09-17T00-45-47-249Z.json; logs /tmp/nmv-reviewer-20260917.log. User ProductHero/docsPT/prototypes/priorartifacts preserved.
- Tests actually executed: npx vitest run tests/agent-review-gateway.test.ts tests/second-review-job.test.ts =>18PASS. ReadonlySQL/models/runtime probes and10total diagnostic gateway calls executed. Failedapproach: SQL reservedalias hour causedsyntaxerror, replacedbucket thenquerysuccess. No appbuild/fullsuite needed for docs-only diagnosis.
- Remaining recommendations, not implemented: current/historical alert split; error subcodes/attempt history; bounded retries+human escalation/circuitbreaker; Gemma structuredoutput backend investigation/evaluation before model replacement; latency/concurrency measurement. No repair claimed.
- Exact next readonly commands: git status --short; python3 /tmp/nmv-hardening-runtime.py; python3 /tmp/nmv-review-env.py npx tsx .crawl-samples/review-hardening-audit.ts. Read report/evidence first. Diagnostic replay files overwrite fixeddate outputs and consume model requests: copy/redate before any justified rerun. Never run fixture DB reset against prod. No active background diagnostics remain.

## Collection/review hardening COMPLETE — 2026-09-14

- Objective fulfilled: fix preceding abc evaluation findings, inspect/repair actual collection/evaluation/classification/publication and deploy. Three PRs reviewed inline, CI passed, merged in order #113 faeede7 → #114 8bf4cc4 → #115 aa07228688ce4eb6445e60fdd6f26c0604aeeada. Root main fast-forwarded to final; own source no longer dirty. User ProductHero hash checked unchanged. Prior news/evaluation/design artifacts remain untouched/untracked.
- Implemented README bounded HTTP destination evidence/versioned CAS refresh; canonical independent model votes/strict dissent and abstention; first provider/model cache/retries/enforcement identity; second firstAttemptId+input/source generation/pre/post-call transactional guard/lease; atomic enqueue/supersede; published sampling beyond25; retired prompt/rules/expired inputs excluded before queue limit and obsolete pending/failed generations closed.
- Actual audit found12exhaustedGitHubtransport allHTTP301renames. Added manualHTTPSapi.github.com-only redirects max3/one deadline/quota; deny external/downgrade/credentials/loop/missinglocation. Probe12/12actual200, then deployedclientnormalcrawler ALL12done10:44:38–46,errornull. Firstresetcycle failedandwaspreservedinaudit; afterfixadvancednextAttemptAt without resettingattempts. DO NOTrepeattheseoperationalmutations.
- Production migration0033 APPLIED by migrate.mjs,34migrationrecords; historicalreviewrowsretained. All7Dokployappsdone; actual5workershealthy,6changedfilehashesmatchfinalcheckout; webM3+mini directhealth200/app+DBok/aa07228/DB2ms. AllrolesCRAWL_REVIEW_MODEL=sonnet; firstobserve/evidencedisplay&enforcefalseunchanged. No modelreplacement.
- Final tests ACTUALLY executed: mergedmain CI34796791254 allPASS (969unit/633integration/types/fullESLint/build). Existingvendorunused_ctxwarningonly. Localisolatedinitial962unit631DB/build/types/scopedlintPASS; GithubredirectRED5then969unit; queueupgradeRED2then39relatedDBPASS. Directdiffreview + productioncanary done; formalreviewskillcouldnotrunmissingrequiredchecklist (reported, noindependentagentreviewclaimed).
- Live10:45:20KST: documents38386 (+146from09:53),public7153(+16),all7153images/noOGbroken; frontierfailed0. Newfirstprompt26success,2input_changedsuperseded; new2nd20recorded(12agreedrows/8humanrows),2timeouts1invalid_output49pending. New1761rowsmissingfirst0/mismatchedfirst0. Theseareexecution/provenancecounts,NOTaccuracy. Secondfailuresretry/humanhandlingremain. News18sourceslast09:54ok,210articles; stars10:44jobfreshand4425comparisoneligible,notall24hfreshguaranteed. 17categories,old422nullclassificationrows400published22rejected—notblockedqueue.
- UI finalaa07228 Playwright1440/390 PASS home9→18,popular15rows,pageerrors0/nooverflow; screenshotsinspected(firstrelease,finalrerunalsopass). Two directweb checks and5workerhashes verified. Helpers localhostprobe initiallyfailedbecauseNextbindsHOSTNAME, fixedprobe; domainneverconfirmeddown. Old50case200answercounterfactual newstrict11agreed0labelmismatch18human20pending1firstfail; Skillberrynowhuman; notnewpromptaccuracyexperiment.
- Deliverables docs/operations/2026-09-14-review-hardening-and-pipeline-health.md; portable docs/operations/evaluations/2026-09-14-review-hardening/{operations,github-before,github-after,consensus-replay}.json +README; completedplan. Finaldocscommit/push follows; no runtimecodeworkremains. Sourcecommits53a4fe5/758a7da/8623f83; migrations/schema/tests listedbygitlog. Tasksourcebackupstash retained withmessage nomorevibe reviewed PR113 source backup; do not apply it to finalmain.
- Failedapproaches preserved: oldREADME/consensus/cache/source regressions RED; originalrootunit1failurefromunrelatedHero (excluded); fakeproviderfixture4fail corrected; shutdownoldvfixturetimeout corrected; preauditSQLANYarraymistakefixedinArray; initialPRbodycreationSameFileErrorfixed; missingreviewchecklistfallbackdirectreview. No unresolvedintroducedtestfailure.
- Remaining limitations: no Claude→abc firstswitch, firstobserve notenforce; probabilityofmodelmalformed/timeoutsnotzero; AIbackfill/stardailycoverageongoing; newsprototype/X/Threadsnotdeployedthisphase. No remaining authorized implementation/deployment task.
- Exact readonly next: git status --short; python3 /tmp/nmv-hardening-deploy.py status; python3 /tmp/nmv-hardening-runtime.py (cwdroot nowmatchesfinal); python3 /tmp/nmv-hardening-web-health.py; python3 /tmp/nmv-review-env.py npx tsx .crawl-samples/hardening-post-deploy.ts; node .crawl-samples/hardening-live.mjs. CI gh run view34796791254. Never run fixture DB reset againstproduction. LocaltestDB55435only. PreserveuserHero/priorartifacts; don'tbulkstage.

## Review hardening final operational fixes — #114 merged / #115 CI pending

- #113 merged faeede7aa4798fb2a6dca18b46f05891374c81b1, deployed all7apps; 5workers healthy +5sourcehashes match; two directwebhealth200/app+DBok2ms; allroles now CRAWL_REVIEW_MODEL=sonnet. Actualnewprompt first6success2input_changed superseded at10:34. Migration34records. Public UI1440/3909→18 +popular15rows/nooverflow/pageerrors0; bothscreenshotsinspected .crawl-samples/hardening-live*.png/json.
- Requeued12 allfailedagain. Foundactualcause ALL12GitHub301renames (nottransport). OfficialGitHubredirectdocs verified. #114 758a7da3b1de7d059d56e07964ce8dada5e2301a addsmanualsame-originHTTPSredirects max3/sharedtimeout/quotalimit/noexternaltoken; 5newRED thenfull969unitPASS; CI34796248917 allPASS; merged8bf4cc4262d854b002b52941ed364271abdde870. Notmanuallydeployed114yet; autoDeploydidNOTupdatecrawlerwhenchecked. Actualnewclientprobe12/12HTTP200 canonicalrepo/id matches, .crawl-samples/hardening-redirect-fixed-probe.json. Existingretried12pendingattempts2/30minbackoff; DO NOTresetattemptsagain. Afterfixeddeployadvance nextAttemptAt oncewithauditandrequestcrawl-fetch toverifyrecovery.
- #113postrollout showed555newrows0missing/mismatchedfirst, butno2ndcompletedbecauseoldpromptfirsts enqueueandconsumeFIFO. #115 fixes enqueuecurrentprompt/rules/unexpiredafterlatestselection+beforelimit; closeslegacy/retiredexpiredpending+failedbeforecalls, keepcompletedhistory. TwoREDregressions then39DBtests/types/lint/diffPASS. UpdatedfirstReviewfixturesandshutdownfixturefromv toactualconstants; firstshutdownrunhung/timedoutbeforeresolvingfixture, corrected39PASS.
- Currentcleanworktree /tmp/nmv-review-hardening-check branch fix/review-queue-upgrade HEAD8623f839495cf2b7219dd46c57d17a392e70ec7e; #115 https://github.com/JRVector9/nomorevibe/pull/115 CI34796510771 running. Watchsession31629 /tmp/nmv-queue-pr-checks.log. Thisbranchbased113anddoesNOTinclude114GitHubchangesyet; aftermergefetch/checkoutsfinaloriginmainforruntimehashchecks. #114watchsession15183doneprobably. Noothermutationspending.
- Next: ghprchecks115; merge--merge--match-head-commit8623f839495cf2b7219dd46c57d17a392e70ec7e; getfinalSHA, gitfetchoriginmain/checkoutsdetachedfinal; python3 /tmp/nmv-hardening-deploy.py release FINAL then deploy/status all7. Runtimehelperaddgithub.tstoFILESforfinalactualhashproof. Webhelperusesprocess.env.HOSTNAME becauseNextbindscontainerhost,127.0.0.1probeTypeErrorwasprobeerror(notoutage); fixed /tmp/nmv-hardening-web-health.py works. Domainhttpshealthalsook.
- Rootreadonly .crawl-samples/hardening-post-deploy.ts nowworks (initialSQLarrayANYinterpolationfixedinArray); savesdatedfile andstdout. Reports /tmp/nmv-hardening-post-{first,second}.log. Finalpollactualnewfirst+2ndsuccess/oldcleared/12recovery, fullauditstar/news/publishcounts andmainCI. Needreportcomplete+handoff,explicitdoc/filescommitpush. Newreportdraft alreadyhasfindingsall3PRs; rootowncode stilluncommitted113equivalent. PreserveuserHero/design/priornews/eval. Safe syncrootmainwithpathwhiteliststash onlyowncode+plan thenffmerge; nooverwritinguserfiles. /tmp/nmv-hardening-files.json whitelist24; new115shutdownand114githubfileswerenevereditedrootsoffautomatically. PlanrootuncheckedvsPRcheckedcopytaskplanbeforestashifneeded. Finaldocartifactsnewreport+evidenceonly, don'tbulkstageprioruntrackedreports/prototype.

## Review hardening PR #113 — migration applied, deployment pending (2026-09-14)

- Code 53a4fe5 in isolated /tmp/nmv-review-hardening-check branch fix/review-evidence-integrity; PR https://github.com/JRVector9/nomorevibe/pull/113. Not merged/deployed yet. Github CI34795728410 running integration (types/full lint/unit passed). Watch session63163, /tmp/nmv-hardening-pr-checks.log.
- Final isolated checks PASS: 962unit,631integration,tsc,scopedlint,build,diffcheck. Logs /tmp/nmv-hardening-clean-{unit,integration}.log, build.log,final-tsc.log,lint.log. Directreview (formalreview skill missingchecklist already explained). Extra fixes pubfirst25starvation,legacypublicbucket,adminecho,atomicAIenqueue/supersede. Added real evidence-writer lock/lostlease tests. Fulltests originalroot had unrelatedHero1failure; cleancheckoutallPASS. Firstpublicationfixture updatedprovider/model, all7pass.
- Production migration0033 APPLIED via python3 /tmp/nomorevibe-prod-db.py node scripts/migrate.mjs from cleancheckout; initial33migrations. No appcode deployed yet. /tmp/nmv-hardening-prod-migration.log success. 12 exhaustedGitHubtransport repos retried once via .crawl-samples/hardening-requeue.ts with audit record previousrows, result hardening-requeued.json. Do NOT repeatreset; inspectstates.
- Runtimeenv audit revieweronly had CRAWL_REVIEW_MODEL=sonnet; othersmissing. New /tmp/nmv-hardening-deploy.py copies prior7apphelper but release setsallrolesSonnet, nootherpolicychange. Use release MERGESHA then deploy aftermerge; web2 together. Sourcesmain/autodeploytrue verifiedall7. Need actualDockerhash/health afterdone; helper /tmp/nmv-hardening-runtime.py verifies5 changedfiles and5workers; webhealth /tmp/nmv-hardening-web-health.py.
- Old200answers replay separateartifact hardening-consensus-replay.json:11agreed0labelmismatch18human20pending1firstfail; Skillberrynowhuman. No newaccuracyclaim. Originaldataset/report preserved.
- Newreportdraft docs/operations/2026-09-14-review-hardening-and-pipeline-health.md.10:20 doc38316,public7145,allimages/noOGbroken.10:23stars6705fresh/7145,440due; source18newsok09:54,210approved. firstobserve remains. Need updatepostdeploy actualcounts and errors.
- Remaining exact: gh pr checks 113 (cleancheckout); onceCIgreen gh pr merge113 --merge --match-head-commit53a4fe5FULL; getmergeSHA; python3 /tmp/nmv-hardening-deploy.py release SHA; python3 ... deploy/status; runtime helper cwdcleancheckout; webhelper; root python3 /tmp/nmv-review-env.py npx tsx .crawl-samples/hardening-post-deploy.ts (readonly,savesdatedfile), review-hardening-audit.ts; node .crawl-samples/hardening-live.mjs. Pre-rolloutquery session92852 outputsfile /tmp/nmv-hardening-pre-rollout.log. Dontlogsecrets.
- Root owncode still dirty/untracked identicaltoPR exceptplancheckboxes; originaluserHero/design/priornews/evalfiles untouched. Need safelysyncroot main aftermerge by comparing ownfiles tocommittedtree then path-scopedstash (no userfiles) beforeffmerge, orpreserveequivalent. Fileswhitelist /tmp/nmv-hardening-files.json includes24files. Handoff/priorreports notinPR. Finalreport/handoffdocscommit afterverification, preserveprior report/prototypeartifacts.

## Review hardening IN PROGRESS — 2026-09-14 10:15 KST

- Objective: fix preceding abc-llm evaluation findings, verify live collection/evaluation/publication, deploy and report. Keep Claude first review; no model switch. Not yet committed/deployed this phase.
- Implemented README HTTP link preservation/versioned CAS refresh; strict dissent/abstention consensus and canonical model echo/dedup; second-review firstAttemptId/source generation and transactional pre/post-call source+lease validation; model-aware first-review cache/retry/publish identity. Migration0033 applied TEST DB ONLY. Plan docs/superpowers/plans/2026-09-14-review-hardening.md.
- Modified lib/crawl/{readme,repository,review-model-identity,second-review-input,second-review,agent-review-contract,agent-review-repository,agent-review}.ts; jobs/{review-document,second-review}.ts; lib/db/second-review-schema.ts; drizzle0033+journal; related unit/integration tests incl new review-document integration. Preserve unrelated ProductHero/design files, prior report/prototype artifacts.
- Executed: unit README+consensus31PASS; integration second-review+shutdown+README35PASS; first-model records+scanlock13PASS; latest tsc noEmit PASS. Expanded55unit had1 old mock signature failure, corrected but rerun pending. RED failures reproduced for links/consensus/cache/generation first. Full unit/integration/lint/build NOT run yet.
- Live readonly09:53: docs38240,279/hour; seeded products7137 all images,21/hour; activejobs fresh/no lastError. 10:07 first119success/hour+3invalid_output; second some invalid/timeouts; AI scans currentversion544complete65partial,73complete/hour. Classification422oldnull rows=400published22rejected, none blocked. Frontier12failed GitHub transport. Review mode observe, evidence display/enforce false. Audits ignored .crawl-samples/pipeline-audit-2026-09-14T00-53-39-753Z.json and review-hardening-details.json.
- Review skill checklist missing: skill explicitly STOP; reported to user, doing direct code review/tests instead. No subagents. Read systematic-debugging/TDD/plans/brainstorming and local Next testing guide. No current process pending.
- Remaining: review summary mixed legacy published bucket/admin alias; comments; add late-first/lease/concurrency regression; consider enqueue superseding race; full checks; bounded real model smoke; migration/deploy/health and report. Do not overwrite prior200-call evaluation by replaying old analyzer (imports changed policy); use separate post-fix artifact.
- Exact next: git diff -- lib/crawl/second-review.ts lib/crawl/second-review-input.ts; npx vitest run tests/agent-review-job.test.ts tests/second-review-job.test.ts tests/second-review.test.ts tests/crawl-readme.test.ts; npx vitest run --config vitest.integration.config.ts tests/integration/second-review.test.ts. Test DB localhost55435 only. Read package scripts for full suites. python3 /tmp/nmv-review-env.py npx tsx .crawl-samples/review-hardening-audit.ts for readonly prod audit; helper keeps secrets out of output. Deployment helper /tmp/nomorevibe-copy-deploy.py status; inspect helper before mutation.

## First-review abc-llm replacement evaluation COMPLETE — 2026-09-14 04:35 KST

- Objective completed: user requested feasibility/accuracy/second-stage impact REPORT on replacing Claude first review with abc-llm. No application code, production settings, candidate judgments, deployment, commit or push changed in this phase. Preserve original ProductHero/design files and prior news prototype work.
- Deliverables: `docs/operations/2026-09-14-first-review-abcllm-evaluation.md`; portable `docs/operations/evaluations/2026-09-14-first-review/` manifest, 200 actual results JSONL, 50-row cases.csv, summary.json, compatibility/input-audit/policy-gaps evidence and README. Local replay source/dataset remains ignored `.crawl-samples/abcllm-first-review-20260914/`. This handoff updated.
- Actual calls COMPLETE: 50 identical frozen cases × Sonnet/Gemma26/Gemma31/OSS = 200, concurrency2, 03:53:54–04:32:53 KST. Exec session12599 exited0. Do not rerun completed calls. Sonnet20s, gateway60s, temperature0/current shared policy and production validators. No DB writes. Dataset SHA-256 matches manifest, no duplicate keys, each model50, all7 scenario totals50 verified.
- Results ADMIN REFERENCE AGREEMENT (not absolute accuracy): Sonnet43/50=86%, falseApprove0/25,falseReject4/25,held2,CLIerror1,median7.311s; OSS41/50=82%,FA5,FR4,held0,failed0,median11.762s; Gemma26 24/50=48%,FA9,FR2,held0,timeout15,median29.153s; Gemma31 27/50=54%,FA1,FR6,held3,timeout13,median36.056s. 20s exceed counts0/5/30/43 respectively. Failed calls included in total score; success-only rates87.8/82/68.6/73.0% documented. Not retried.
- Limitations: admin567 → seeded25approve25reject, labels9/9–10; all50GitHubPages,49host_excluded_subpath. Original snapshots lackedpageText/readme;8initialsmoke calls EXCLUDED. Current readonly input rebuilt, fresh README48/50,2absent0fetcherrors; pageText only25approve and none25reject, olddocuments9/9–10. Current frozen input replay is not production claim/freshness execution. Research-reports oldapprove conflicts with current personal-research exclusion; do not silently relabel or call model agreement trueaccuracy. No statistically established Sonnet-vsOSS superiority/general service accuracy. No costsaving/throughput claim.
- Production read03:49: firstCLIsonnet observe; second threeabc models above; agreeAt.7/includeAiHeldtrue/sample.05. First24h2236success13fail5superseded,median6.1605s. Latestreadonly audit04:10 open2nd90rows/30uniqueinputs allmatchcurrenthash; does NOT prove historical runtimeinputs were correct. No production corruption claimed.
- Findings: first provider/caller hardcodedClaude + modelvalidator rejects[MLX]; second enqueue selects onlyClaude first => gatewayfirst notqueued. First success cache ignoresmodel; retrybudgetshared; enforcepublishapproval notboundactiveprovider/model. Secondunique candidate/input/model canretainold firstModel/decision; needfirstAttemptId/provider/config generation. Alias echo normalization missing; duplicate excluded only atvote count yet called and failed duplicateblocksoutstanding. Movingexistingsecondtofirst removes4thdistinctmodel. Existingfirst20/24/25sbudgets inadequateforGemma. Observe doesn'tchangecandidate; enforceapprove canbypass needs_review 2nd route.
- Additional real findings: 2ndjob loads CURRENTinput without comparing row.inputHash, then recordsagainstoldfirstdecision; report-onlymock reproducesagreed withold/newhash mismatch. README `readmeText` removes markdownlink destinations; actual Skillberry README separates live onrender app from GitHubPagesdocs, butinputloses distinction. LowconfidenceClaude reject(.68) + Gemma31needs_review are ignored; Gemma26+OSS approve yield agreed2votes (raisingClaudeconfidence.7 sendsneeds_human). Do not equate agreed with unanimous. Allfields/tests inreport.
- Real combineVotes COUNTERFACTUAL on200answers: currentSonnet+3:14agreed13labelmatch1falseApprove,15human20pending1firstfail; OSS+2Gemmas:15agreed14match1FA,15human20pending; OSSfirst+Sonnetsecond:35agreed33match0FA,14human1pending (2label mismatchesrejects includeknownresearchwronglabel). AddingGemma26toOSS+Sonnet produces2falseapprovals dueabstentionrules. This is not deployed routing or actualretry simulation. Allagreedpendingcandidate decisionsstill humanconfirmed.
- Recommendation: keepSonnet now; repair inputlinks and2ndinput/attemptconsistency/consensuspolicy before limitedOSSshadowcomparison. Gemma26 notrecommendedcurrentfalseapprovals, Gemma31currenttimeout/falseRejects. Qwen/othermodelsonactual14modellist untested. PotentialPRs:1current2ndsourceconsistency;2provider/model/cache/identitysupport;3prospectiveshadowgoldset. Useraskedreview, implementation remains future scope.
- Executed PASS: 5existingunitfiles63tests (`agent-review-gateway`, `agent-review-cli`, `second-review`, `agent-review-job`, `second-review-job`); compatibility10asserts; policy-gaps4asserts; tempsecond-reviewjobcopy12tests(11existing+1inputmismatchrepro). Passing repro confirms UNDESIRED behavior, no fix shipped. No integrationDBreset tests, fullbuild or UItests this report-only phase. Finaldocument/data QA totals/hash above passed.
- Failed approaches: PythonurllibCloudflare403, Nodefetchworked (notauthunavailable); oldsnapshot8smokecalls excluded afterfindingmissinginput; initialCJS top-levelawaitscript fixed. Current claude-reads-hn website failedwebopen, casebasedonstoredinput explicitly. CurrentrawREADMEandGitHubsourcesforcocktailmaker/researchreports/skillberryverified. Actualmodelerrorsretained, not hidden. Never print secrets; existing skill containedliteralkey, do not repeat it.
- Exact next commands (read-only/recompute): `git status --short`; `npx tsx .crawl-samples/abcllm-first-review-20260914/analyze.ts > .crawl-samples/abcllm-first-review-20260914/progress-summary.json`; read final report and `docs/operations/evaluations/2026-09-14-first-review/cases.csv`. Do NOT rerun finish-report.py onfinalreport: it is a one-shot insertion helper and would duplicate tables. Credentialhelper `/tmp/nmv-review-env.py` onlyneededforfreshapprovedprovider/readonlyDBwork, notanalysis. No need rerun200calls or deployedpriorPRs.

## AI news HTML prototype and tool-filter audit COMPLETE — 2026-09-14 03:40 KST

- Current request: explain empty maker-tool dropdown; FIRST show a NewsTimes-inspired HTML news design using real company news, YouTube, X, Threads and influencer posts, with periodic updates. This phase is a reviewable standalone prototype, not production news rollout.
- Results: `prototypes/ai-news/index.html`, local preview http://localhost:4178/ (process started with `node prototypes/ai-news/serve.mjs`, default 1h collection). 9 companies / 25 articles / 3 videos / 3 real social posts / 4 release snapshots, 24 embedded source images. Single HTML works from file; only server mode refreshes. X/Threads and selected interviews/releases remain manual snapshots, not automatic API collection.
- Production read-only audit03:18: 6907public, reported eligible builder0; live select only default option.03:35 raw builderfilled811/reported0; new detector68complete13partial. Observations are separated internally but are not maker-confirmed usage. No application filter code changed. Recommendation hide/disable empty filter, preserve reported vs observed distinction.
- Existing production news: 18 configured sources, 210approved items, all18cursor.ok true/check02:54KST, autoApprove true, hourlyjob. Public AI news nav currently /#briefing, no independent page. Sitemap baseline doesn't backfill, Anthropic root-level model announcements fall outside existing /news/ /engineering/ filters. Full-company coverage and API integrations remain future implementation scope.
- Modified files: NEW prototypes/ai-news/ (template/build/collect/serve/data/editorial/sources/image-cache/README/QA scripts/results/screenshots), NEW docs/operations/2026-09-14-news-prototype-and-tool-filter-audit.md, this handoff. Existing dirty ProductHero, nomorevibe-final/, HTML/zip untouched. No runtime deployment, migration, commit or push this phase.
- Decisions: official source links and actual dates; Korean editorial paraphrases, retain original title; no invented engagement/popularity; failures retain old data; exclude invalid/future dates; URL dedup; escape embedded JSON. Local fixed-source collector uses no DB/credentials, startup +1h, UI polls1min. X/Threads need official API access, source register expansion is documented.
- Executed PASS: node syntax checks collect/serve, build25/9, `node prototypes/ai-news/qa.mjs` 16checks (filter/search/save/9→18→25/tabs/links/keyboard/1440-768-390-320/nooverflow/images/file mode/0pageerrors/poll-error recovery without new data); scopedESLintPASS; `node prototypes/ai-news/qa-refresh.mjs` failure retention/date/url/dedup/JSON plus 2 actual timer runs in isolated temp copy at3sec; diffcheck. Full app tests/build not run since app code unchanged.
- Failed approaches: candidate Microsoft feed410, Meta category feed404 excluded; CUA reported no browser, opened local URL with macOS `open` and verified via Playwright. First mobile overflow390 then320 found/fixed; final rerun PASS. Initial read-only audit used wrong column value vs values, fixed without writes. No remaining test failures.
- Remaining: deliver prototype/report to user; production design implementation awaits next scope instruction, especially company register and X/Threads credentials/permissions. Do not claim all AI companies or social auto-refresh implemented. Do not deploy this static preview as the production app.
- Exact next: `git status --short`; `curl -fsS http://localhost:4178/status.json`; `open http://localhost:4178/`; if preview stopped, `node prototypes/ai-news/serve.mjs`; edits to template/data followed by `node prototypes/ai-news/build.mjs`; QA commands above. Detailed report and README contain source URLs and production integration recommendations. No need repeat completed landing/deployment below.

## AI attribution merge and deployment COMPLETE — 2026-09-14

- User authorized sequential review/merge/deploy. Previous no-deploy scope is superseded. #110 merged5f49eb9 → #111e743d48 → #1127492cf0887de85c364711d4b8dafb79e8ef1c9e1. Successors retargetedmain, merge ancestry preserved; task-owned remote branches deleted after all merged.
- Re-reviewed actualdiffs and independent CLEAN outcomes. PR CI957unit613integration/types/lint/build PASS. Merged main run34772638671 allPASS. Tree7492cf0 identical to testedc43f867. No runtime edits during landing. Details docs/operations/2026-09-14-agent-attribution-deployment.md.
- Deployed Dokploy webM3+mini and5singletonworkers (crawler/publisher/reviewer/maintenance/scheduler). All application done, Swarm completed, workers healthy, RELEASE_TAG7492cf0; five detector/collector/summary/audit/review files' hashes match checkout. Two webdirecthealth release7492cf0/app+DBok/latency1–2ms. No SQLmigration or connect-agent deployment required.
- First publisher/reviewer attempts automatically rolled back on Docker task No such container. Detected actual RELEASE_TAG mismatch despite Dokploydone. Retried only2 viaAPI; Swarm completed02:56:11/14 and actualcode+release+health verified. Resolved, not an outstanding blocker.
- At02:57:02 saveSettings changed ONLY agentEvidence.detectorVersion to2026-09-14.1; full before/after comparison passed. enabledtrue/displayfalse/enforcefalse/reviewModeobserve/policyold unchanged. Actual scheduled collection02:57:08 newversion14complete4partial,7commit claims allwithchangeproof,13instructions. Existing data rechecks remain normal scheduled work, not completed wholebackfill.
- Read-only report02:57:03 completed:6898published,5184outdated1698unscanned12current3incomplete1failed,0qualifiedproducts. New published proof exclusions4partial1relationship; legacy3053excluded. This is not AI absence/accuracy. Evidence .crawl-samples/attribution-audit-deployed-20260914.jsonl and state-after/state-final.
- Live Playwright1440/390 PASS:home9→18, popularpaging/personalfilter, noAIcolumn/evidencelink, no documentoverflow, pageerrors0. Load2.433s/0.440s. Bothscreenshotsopened. Runtime verification /tmp/nomorevibe-attribution-runtime.py; API status helper /tmp/nomorevibe-attribution-deploy.py; no credentials in outputs.
- Modified files thisphase: docs/CODEX_HANDOFF.md and newdeploymentreport only. Commit/push docs and fast-forward original main while preserving user ProductHero/design artifacts. Update Obsidian journal with deployment completion. No application work remains.
- Exact read-only next: `python3 /tmp/nomorevibe-attribution-deploy.py status`; `python3 /tmp/nomorevibe-attribution-runtime.py` (cwd deploymentworktree); `python3 /tmp/nomorevibe-prod-db.py npx tsx .crawl-samples/attribution-rollout-state.ts`. Never run fixture tests against prod. Original /Users/jr/Desktop/projects/nomorevibe userHero/design files must remain uncommitted.

## AI attribution PR implementation COMPLETE — final CI verification, 2026-09-14

- Objective: three stacked implementation PRs, no merge/deploy or production settings/DB mutations. Original `/Users/jr/Desktop/projects/nomorevibe` user ProductHero and design artifacts remain untouched. Worktree `/tmp/nomorevibe-agent-prs` currently feat/agent-attribution-audit. Additional `/tmp/nomorevibe-pr-baseline` holds PR1 branch for test-only fixture updates.
- PR1 #110 feat/agent-evidence-policy base main: config/committer-only exclusion, rules cache bump, review CLEAN. Commits46d4e7b/487b218 plus stale UI test-only837b168/d0ecc50. Main20129d5 reproduced existing7 stale UI failures; current shipped behavior fixtures35 PASS.
- PR2 #111 feat/agent-commit-evidence base PR1: changed-path/head/ancestry proof, Aider author/committer, fork exclusion+same-head stale-claim deletion, detector/prompt/rules bumps. Code54a3a3f, fixture5323f79, merge commits carry PR1 updates. 75 unit/62 integration + scan-lock3 PASS. Independent initial P1(9/10) fork transition and P2(8/10) prompt version fixed; follow-up CLEAN `/tmp/nomorevibe-pr2-rereview.txt`.
- PR3 new audit.ts + scripts/audit-agent-attribution.ts + pure/integration tests. Read-only repeatable-read JSONL output, no overwrite, completion marker, all published pagination, current evidence/source gates, dedup claims vs maker reports. First review P1(10/10) normalization mismatch fixed by shared normalizeTypedLink and parameterized JSONB page identities. Final13 unit/7 integration/TSC/lint PASS; follow-up review CLEAN `/tmp/nomorevibe-pr3-rereview.txt`. No claim that new report certifies AI execution.
- Whole-stack tests:957 unit PASS `/tmp/nomorevibe-pr3-all-unit-final.log`;608 integration PASS `/tmp/nomorevibe-pr3-all-integration-final.log` before final5 URL cases, then final7 targeted PASS. Full lint PASS (existing vendor warning1) and build PASS. Initial full lint included ignored live collector any2; moved script to `/tmp/nomorevibe-commit-proof-live.ts` and reran. Initial fullintegration scan-lock fixture lacked fork/files; fixed and validated3+608. UI stale-test fix briefly added wrong no-image expectation to positive OG case; final35 PASS.
- Production read-only final report02:32:10KST:6877 published,5184outdated detector,1693unscanned,0qualifiedclaims/0publicmakerreports. `.crawl-samples/attribution-audit-prod-20260914-final.jsonl` completed. Previous3livecollector samples complete API4each; these are source-proof samples, no precision claim.
- All three stacked PRs created: #110 → #111 → #112. PR3 code82a89e2. PR1/2 GitHub CI all steps success; final PR3 CI verification and journal remain. All independent reviews CLEAN. Do NOT merge/deploy. No public UI update intended.
- Exact next: `gh pr checks 112`; `git status --short`; compare original user worktree remains untouched. Final report three PR links, test results, no merge/deploy. Production audit optional reruns need NEW output filename; no write or backfill.

## Release visibility + attribution source validation COMPLETE — 2026-09-14 01:23 KST

- User asked whether AI detection proves AI development; clear evidence/drop unnecessary methods; how latest release extracted; hide release row if no date. Completed source verification/narrowed research and shipped date-only release UI. No new detector or automatic policy changes claimed.
- Code `4137a9ed0e22f4e92be85b3158298ba614cf65dd` pushedmain, webM3+mini deployed sameSHA/app+DBhealthok at01:20:43KST. Own component `components/product-detail/RepositoryEvidence.tsx`: release row only valid publishedAt, safe URL/notesURL source link, ISO datetime+KST display, no push/observed fallback. Other metrics preserved.
- Own tests `tests/repository-release.test.tsx`6cases, RED5fail/1pass thenGREEN; plus existing github-evidence13 =>19PASS. TSC/targetedlint/diffcheckPASS. Isolated `/tmp/nomorevibe-release-evidence-check` (32a9ab4+owncopies) productionbuild+existingproductdetailE2E3PASS, `/tmp/nomorevibe-release-evidence-e2e.log`. IndependentCodexreviewCLEAN(nofindings/confidenceunprovided), `/tmp/nomorevibe-release-evidence-review-result.txt`; reviewerTSCpassed but reviewerVitestblockedEPERMreadonlytemp, parent19actualPASS. Not an application test failure.
- Operational audit01:14:6843publishedGitHub/5735structuredfacts/2016datedrelease; no-date4827 contains1108withoutstructuredfacts, not proofactualreleaseabsent. `.crawl-samples/release-evidence-audit-20260914.json`. DirectpublicAPI3dated+3emptyallmatchstored. Commit3Aider/Claude/CodexoriginalSHA+trailer+branchancestry+changedfilesallmatch; proves attribution claim, not actualAIexecution oroverallaccuracy. `.crawl-samples/release-evidence-source-check.json`; links inreport.
- Release extraction unchanged: listreleases10validmax, draft/dateinvalidexcluded, publishedAtdescending amongcollectedrows, prereleaseincluded, notGitHub/latest/authorLatestlabel, noallhistorylatestguarantee. Failedcollectionpreservespriorfacts. UIonlyshowsactualvaliddate.
- AI research scope narrowed: exclude file/config/model/topic/style/LLMguess/simpleCI-success from definitive usage claims; retain originalcommitcontributionclaims and makerreports as distinct sources. BroadPR/Actions/ownerintegration/backfill not currentlyimplemented. Existinginternal summarymodel_config support still exists; futurepolicyredesignmustaddressit beforeenablingenforce. enabledtrue/displayfalse/enforcefalse unchanged; noAI-madecertificationormade-upconfidence.
- Reports `docs/operations/2026-09-14-release-evidence.md`, earlierAIreportmarkedsubordinate; plan `docs/superpowers/plans/2026-09-14-release-evidence.md`complete. Journal `프로젝트 일지/nomorevibe/2026-09-14 릴리스 날짜 표시와 AI 근거 재검증.md`. Finaldocscommitfollows,noredeploy.
- Production `node .crawl-samples/release-evidence-live.mjs` PASS12views(6slugs×1440/390). Datedyana-ai-desktop/worldscript-studio/traycer-ai correctversion/href/ISOdatetime, undatedvotepredict/timemachine-2/mylesson no row; documentoverflowfalse/pageerrors0. Dated+undatedentiresectionactualscreenshotsopened `.crawl-samples/release-evidence-section-{yana-ai-desktop,votepredict}.png`. Firstviewportshotscutoffbottom→capturedwholesection, noUIdefect.
- Preserve user `components/product-detail/ProductHero.tsx` and untrackednomorevibe-final/HTML/zip. No worker/schema/settingschanges. Remainingrequestedwork:none; strongerAIpipelinefuturetaskrequiresground-truthandclaimlimits, notautomaticallyauthorizealloldresearchproposals.
- Exactread-onlynext: `git status --short`; `python3 /tmp/nomorevibe-copy-deploy.py status`; optional `node .crawl-samples/release-evidence-live.mjs` (data-dependentlatest). Do not rerun seedE2Eagainstproduction; fixturesusetestDB55435only.

## AI evidence field removal + research COMPLETE — 2026-09-14 01:01 KST

- Objective fulfilled: remove screenshot's popular-table AI trace/evidence-link fields; investigate stronger tool attribution. UI shipped, research documented; detector improvements are proposals, not implemented.
- Code `f0f9c19d83d21cd93f5d4135b6f9451fb42f1ed9` committed/pushed main, webM3+mini both deployed same SHA, app/DB health ok. Manual deploy done at01:00:22–27KST; M3 oldinstancebrieflyservedthenconvergedby01:00:44. No worker/schema/settings changes.
- Own code files `app/popular/page.tsx` removes AI column, extra evidence read and adjusts empty colspan6; `app/home.css` removes orphan CSS. Internal collection, separate development-tool info and reported builder filtering retained. Public display/enforce remain false; collection enabled true.
- Research report `docs/operations/2026-09-14-ai-evidence.md` has official source links, limitations and prioritized implementation/300-item comparison proposal. Current scans miss general nested directories and use max5 search-discovered commit SHAs, only trailer attribution; Aider author metadata and PR/workflow correlation are proposed additions. Shared instruction presence != specific tool use; model != client != gateway. Do not automatically overwrite reported builder or enable eligibility.
- Live audit00:56KST `.crawl-samples/ai-evidence-audit-20260914.json`: published repo6836 / ever scanned5121 / ever observations3841. All latest scan states5103complete/767partial/1failed (different population), fresh1867. Historical observations are NOT validated tool usage. Unscanned published1715; builderfilled811 includes fields excluded by public reported gate.
- Executed PASS: TSC, targeted ESLint, diffcheck, isolated production build + existing popular E2E3 (1440/390/filter/paging/empty), `/tmp/nomorevibe-ai-evidence-e2e.log`. Independent Codex CLI review CLEAN, confidence unprovided, `/tmp/nomorevibe-ai-evidence-review-result.txt`. No new tests for simple field removal.
- Production `node .crawl-samples/ai-evidence-live.mjs` PASS: AI 흔적/공개된 흔적 없음/근거 보기 absent, six headers/rowcells, desktop1440/mobile390, next-page and personal filter work, documentoverflowfalse/browsererrors0. Both live screenshots opened. `.crawl-samples/ai-evidence-live.json` and `ai-evidence-live-{1440,390}.png`. Existing internal table horizontal scroll on mobile preserved.
- Modified docs thisphase report/handoff; journal `프로젝트 일지/nomorevibe/2026-09-14 AI 흔적 열 제거와 도구 탐지 강화 조사.md`. Final docs-only commit follows; no runtime redeploy needed.
- Failed research retrieval: Claude settings-reference oversized/unavailable via web; used accessible official settings page instead, no unverified new trailer rules claimed. No failed application checks.
- Preserve original user `components/product-detail/ProductHero.tsx` changes and untracked nomorevibe-final/HTML/zip. Do not bulk stage. Isolated checkout `/tmp/nomorevibe-ai-evidence-check` retained.
- Remaining requested work: none. Detector enhancement implementation is a proposed follow-up to user's research request. Next read-only: `git status --short`; `python3 /tmp/nomorevibe-copy-deploy.py status`; optional `node .crawl-samples/ai-evidence-live.mjs`. Do not re-deploy workers or change publication gates for this field removal.

## Full catalogue task COMPLETE — 2026-09-13 23:53 KST

- Userrequested100limitremovalimplemented/shipped8007168c47753a88a27d4fa725ff075029f16761. Mainpushed; webM3+mini samecommitdeploydone, app/dbhealthok. Worker/schemaunchanged.
- Production23:50KSTproof `.crawl-samples/full-catalog-live.json`:initial9/6753,truefilteredcounts,99→108,all6753rendered withnolinksremaining,noduplicates,lastpi-coding-agent.390mobile108nooverflow/pageerrors0. Hugeviewimagefetchesabortedonlyforverification; normalimagesseparatelyloadedandscreenshotopened.
- Changes app/page.tsx matchingcounts+visiblelimits/unclaimedfulltotal/wholecataloguelink, ProjectGridtotalCount, browse-state safeintegernocap, stable repository slugorder, BrowseFiltersweeklyquerysortpreservation, tests/plan/report. Allpublishedaccessiblethroughlatest/search/open; rankingeligibilitystilldistinct; existingstatus/downexclusionsretained. Savedmodeold100candidatepoolremains(knownpreviouslyreportedlimitation), notshrunkto9; notclaimedsavedbugfixed.
- Testsunit5/integration15/TSC/lint/diffcheckPASS; isolatedproductionbuild/E2E4PASS. InitialE2Erevealedweeklyqmorehrefomittedsort→recent; fixedhrefWith+hiddeninput,finalgreen. IndependentreviewplusfocusedURLreviewbothCLEAN; confidenceunprovided. No unresolvednewcodefailures. Source-treeuserHero/designartifactsremainuncommittedanduntouched.
- Previousquestiontopbaranswered/read-onlyverified: completed7daysendingtoday00KST, daterangechangesdaily;DBaggregatesrecalconrequestwith1minprocesscache,nofixedsnapshot,noclientpoll. Today-bornnewlylistedproductswaitnextdate; latepastreleasescanaltertodaycounts.23:34values337/-7.9%/1221/5189, laterUI1223/5201sameasOfobserved. No topbarcodechanges.
- Report `docs/operations/2026-09-13-full-catalog.md`; plancomplete; journalrecordedunder프로젝트일지/nomorevibe/2026-09-13 공개 프로젝트 전체 탐색.md. Finaldocscommitfollows,noredeployneeded. Remainingrequestedwork:none. Nextread-only `git status --short`; `python3 /tmp/nomorevibe-copy-deploy.py status`; optional `python3 /tmp/nomorevibe-prod-db.py npx tsx .crawl-samples/full-catalog-audit.ts`. Avoidrerunning6753-rowbrowsercheckwithoutneed.

## Full catalogue release queued — 2026-09-13 23:50 KST
- Code8007168c47753a88a27d4fa725ff075029f16761 committed/pushed. Web2envupdated anddeployqueued via copyhelpers. Both independentreviewsCLEAN. Finalunit5/integration15/TSC/lint/isolatedbuildE2E4PASS. No production schema/workerchanges.
- Next poll `.crawl-samples/full-catalog-deploy-status.jsonl` or `python3 /tmp/nomorevibe-copy-deploy.py status`, directweb2healthnewSHA, `node .crawl-samples/full-catalog-live.mjs` (imageaborts onlyhugeview), inspectinitialscreenshot andactualall6753+lastitem. Report/handoff/journal/docscommit. UserHero/designartifactsstillonlyunrelateddirtyfiles.

## Full published catalogue IN PROGRESS — 2026-09-13 23:47 KST
- Latestuserasked100capremoval toviewallpublished. Previousquestiontopbaranswered: KSTcompleted7daywindowrollsdaily00;loadHomePulsequeryDBonrequestwith1minprocesscache,nofrozendailysnapshot/noautopoll. Prodread23:34born337/prev366/-7.9%,updatedprojects1221/releases5189. No topbarcodechangesrequested.
- Implemented: parseShown safeinteger no100cap; publiclistcountsamefilters andlimitmin(shown,actualcount),9initial; ProjectGridtotalCount enablesmorebeyondloadedrows; unclaimedfillindependenttotal; rankeligibilityretained; stableSlugtie; wholecataloguelink/?sort=recent. Savedmodeoldcandidatepool100preservedexplicitly, oldsavedUIlimitationNOTfixed.
- Ownfiles app/page.tsx,components/BrowseFilters.tsx,home/ProjectGrid.tsx,home/browse-state.ts,products/repository.ts,tests/home-sort,tests/e2e/full-catalog.spec.ts,plan2026-09-13-full-catalog. UserHero/designartifactsuntouched. No committhisphaseyet.
- Tests unit5/integration15/TSC/lintPASS. Isolatednewworktree/tmp/nomorevibe-full-catalog-check HEAD51cdb20 owncopies+depsclone. Build/E2E4PASS `/tmp/nomorevibe-full-catalog-e2e-final.log`:117fixture9/99→108→117end, hugeinputclampedactualcount, no duplicates, filters, mobile, savedregression. InitialE2Efoundweekly+qsortlostonmore: hrefWithmustexplicitweeklyifquery;formhiddeninputsamefix. Finalgreenafterfix. Serverstreamclosedearlylogonclientnavigation observed,butallbrowserassertions/pageerrorspassed.
- IndepakreviewCLEAN `/tmp/nomorevibe-full-catalog-review.log`; finaltwoURLconditionsfocusedreviewrunning session53113; log `/tmp/nomorevibe-full-catalog-review-final.log`, CLIresume01a09b38-8087-7671-9868-48c2f1787389. No modeloverrideexceptskill-supportedsol/high.
- Prodaudit `.crawl-samples/full-catalog-audit.json`:visible6753,lastslugpi-coding-agent at14:45:06UTC. LiveQAready `.crawl-samples/full-catalog-live.mjs`:initial9 truecount,99→108,allactualcount/lastslug/noMore/noduplicates,390px108. Abortsimagefetchonlyduringhugeviewtoavoid6753mediarequests.
- Next: finalreviewclean, owncommit/push; web2onlyusingexisting/tmp/nomorevibe-copy-{release-env,deploy}.py withNEW SHA; verifyhealth/deploythenrunliveQAandviewinitialscreenshot; operationsreport includes topbaranswer and fullcataloguecounts; updatehandoff/Obsidianjournal/docscommit. No DB/workerdeploynecessary.

## Project presentation task COMPLETE — 2026-09-13 23:27 KST

- Userrequest fulfilled: exactGitHubowner/repo fallback titles→repo inpubliclist/popular/detail, descriptions2lines,31processcopyitems removed/shortened/reportlisted, weeklysave/visitbehavior explainedwithactualpolicy. Main commits4c1fb2f/724029b/b2cf859 pushed; webM3+mini deployed finalb2cf859282093b94975f4d00d236697b95b257b9; bothapp/dbhealthok exactrelease. No worker/DBmigration.
- Live `.crawl-samples/copy-live.json`: 1440/390screens actual8chamber-orchestra projects cleanedtitles/cover, descriptionsheight41.59375/line20.8→2lines, nooverflow/errors. Requestedmetadata-bundle search+detailh1 verified.20populardescriptions2line. Bothactualscreenshotsopened. Deploysource/status andhealth savedcopy-deploy-status.jsonl/copy-release-health.json.
- Validation: unit3/integration11/TSC/lint/diffcheckPASS; isolatedproductionbuild+popular3 thenfinalsearch/detail4PASS; final2literalcopychangeslint+independentreviewCLEAN andproductionbuild/livePASS.3independentreviewpassesCLEAN,noactionablefindings; rawconfidenceunprovided. Failedtests corrected: namefixtureoutsidefirst9, missedFreshnesspendinglabel, liveQAassumed9actual8. AccidentalrootE2EuseduserHerolayout12px andfailedfontcontract; deployisolatedHero excludesitandpassed.
- Files: display-name.ts +publicview/popular/detailintegration; StarMetric/homeCSS/popular/HomeAside/apphome;detailcopyHero/Gallery/Introduction/Metrics/Repository/EvidenceSummary/Freshness/BuildProvenance; unitname/E2Ecases; plan/report/handoff. No persistentnameDBrewrite orchangesearchmatching.
- ExistinguserHerolayout preserveduncommitted (ownprosechangesstagedviaHEADbasedblob), userdesignartifactsuntouched. SourcecaptioninworkinguserHeroalso shortened. DonotbulkaddHero/designartifacts.
- Report `docs/operations/2026-09-13-project-copy.md` containsall31removed/shorteneditems. SavedIDslocalStoragepersist, but savedUIonlyfilterscurrentserverquerieditems andcanomitoldstoredIDs; documentedexistinglimitation, notfixedbecausequestionwasbehavior. ↑isvalidvisits, latest/openrolling7days, weeklyMonday00KSTseason, cumulative3650days. CurrentseasonW37endsSep14Monday00KST, productsarenotdeleted.
- Remaining: no requestedimplementationpending. Savedviewscopebugdocumentedforfutureexplicitwork; do notclaimallbookmarksalwaysvisible. Finaldocs/journal recorded; docscommitfollowswithoutredeploy. Readonlynextcommands `git status --short`; `python3 /tmp/nomorevibe-copy-deploy.py status`; `node .crawl-samples/copy-live.mjs` (data-dependentresults1..9).

## Copy release queued — 2026-09-13 23:25 KST
- Final codecommits4c1fb2f,724029b,b2cf859 allpushedmain. Web2releaseenvnowb2cf859282093b94975f4d00d236697b95b257b9 anddeploymentqueuedvia `/tmp/nomorevibe-copy-deploy.py`. No workers/DBmigration. Final31copyinventoryitems inclHomeAsidenews+unclaimedlistnarration. LatestliteralreviewCLEAN `/tmp/nomorevibe-copy-review-literals.log`; targetedlintPASS. Lastisolatedbuild/E2E4PASS beforelast2literal-onlychanges; deploymentsbuildlatestsource.
- Importantquestion4finding: bookmarkIDs persistlocalStorage, but savedview filters onlycurrentlyqueriedlist/unclaimedcandidates (capped/currentseason). Oldsaveditemscan beomittedfromUI withoutdeletingstoredID. Explicitlyreported limitation, notfixedbecauseuseraskedhowitworks. No claimallbookmarksalwaysvisible.
- Next verifylatestweb2health/sourceSHA, run `node .crawl-samples/copy-live.mjs` andopenactualscreenshots, finishreport/handoff/journal, docscommit. PreserveworkinguserHero/designartifacts. Do notshipold4c1releaseenv.

## Copy final omission pass — 2026-09-13 23:20 KST
- Main implementation committed/pushed4c1fb2f; webreleaseenvset4c1but NO deployqueued yet. Additional5copyitems found: search result narration, popularSuspenseloadingsentence,2BuildProvenanceparagraphs, Herosourcemissinglongsentence. Now29inventoryrowsinreport; directfunctionaluserworkflows/provenancebadges retained.
- Follow-up changes app/page.tsx, BuildProvenance.tsx, HeroHEADblob(`/tmp/nomorevibe-copy-Hero.tsx`) +report. FinalisolatedbuildE2E4PASS `/tmp/nomorevibe-copy-e2e-last.log`; TSC/lintPASS. Focusedreview session36113 `/tmp/nomorevibe-copy-review-final.log` running. StageHeroindependentblobagain, neverwholeuserHero.
- Next commit/pushfollowup, updateweb2releaseenvtoNEW SHA (not4c1), deploy2, liveQA `.crawl-samples/copy-live.mjs`, screenshotinspection, report/handoff/journal finaldocscommit.

## Copy cleanup ready to release — 2026-09-13 23:16 KST
- Independent review CLEAN `/tmp/nomorevibe-copy-review.log`; final isolatedbuild+search/detail4PASS, previouspopular3PASS; unit3/integration11/TSC/lint/diffcheckPASS. InitialE2EfoundmissedFreshnesscollectinglabel fixed; namefixture initiallyoutsidefirst9corrected. AccidentalrootE2E includeduncommitteduserHero andfailed13pxminimum(12pxcoverbrand); isolateddeploymentHeroexcludesuserlayout and4PASS. Do notclaimrootalltests passed.
- Own21filesstaged inclHeroHEADbasedblob; workingHeroisuserlayout+shortenedpreviewcaption, donotgitaddit. Readycommitpushthenweb2only. Actualprodseason2026-W37 ends2026-09-13T15:00UTC=Sep14Monday00KST. Liveverification script `.crawl-samples/copy-live.mjs` ready; ownhelpers `/tmp/nomorevibe-copy-{release-env,deploy}.py`.

## Project presentation cleanup IN PROGRESS — 2026-09-13 23:11 KST

- User asks: exact GitHub owner/repo fallback names→repo only, remove collection-process narration and list changes, descriptions max2lines, explain saved/↑ counts afterweek. Existing user Hero3hunks/designartifacts preserved. Scope publichome/popular/detail copy; no pipeline/DB migration changes.
- Implemented display-name.ts at publicview/popular/detail boundaries (DB/search unchanged); StarMetric pendingdelta hidden; actualdelta retained; card/popular2lineCSS. Removed/shortened24groupspubliccopy, inventory `docs/operations/2026-09-13-project-copy.md`. UserHeroroottextalso shortened but owncommitHero prepared fromHEAD in `/tmp/nomorevibe-copy-Hero.tsx`; stageblob, NEVERgitaddfullHero.
- Unit3/integration11,TSC/lintPASS. Name REDmissingmodule run. Isolated `/tmp/nomorevibe-copy-check` HEAD3ec5a58 contains owncopies only, APFSdepsclone. Build/E2E7 running session78757 log `/tmp/nomorevibe-copy-e2e.log`; independentakCLI sol/high session92773 `/tmp/nomorevibe-copy-review.log` boundedreadonly. No changescommittedyet.
- Answer evidence: savedlocalStorage nmb-saved-v1 noexpiry; ↑isvalidoutboundvisits notvote/span. Latest/open/unclaimed countsrolling7days (`METRICS_WINDOW_DAYS=7`); weeklyseason Monday00:00KST resetsnewseason notprojects; alltime3650days. Actualprodseason checkscript `.crawl-samples/copy-proof.ts` running.
- Next: finishE2E/reviewfixes, commitownfileslist `/tmp/nomorevibe-copy-ownfiles.json` plusreport/handoff, specialHeroHEADblobstaging; push; web2only via `/tmp/nomorevibe-copy-{release-env,deploy}.py`; verifyactualuserexamplemetadata-bundle/titlecover/detail, pendingcopyabsent,2linesdesktop/mobile, sourcebadgesstillpresent. Updatecopyinventory/results/handoff/journal, docscommit. No worker deploymentsnecessary.

## Catalogue task COMPLETE — 2026-09-13 22:53 KST

- Requested personal research/survey exclusion, daily stars+change, nine cards, search fix implemented and shipped `17abf63b3a4bf5555330f61f87997780f558052e`. All7 affected Dokploy apps(web2/crawler/publisher/reviewer/maintenance/scheduler)done samecommit; bothwebapp/dbhealthok;7freshnewrelease/runningheartbeats. connect-agentunchanged.
- Production0032applied;3definite nonproducts banned/reversible/audited, skipped0. Latent Coffee Research, research publications, OTT thesis survey; actuallatestmetadatarechecked. Latest purpose preview0. Shared rules+publishguards and reviewpromptversion updated; observepolicyunchanged. Conservative detector does not promise universal semantic classification.
- Searchactual @opencovibe/FastGPT1each, AI9/more18; resultstop137px vs1431before;390mobile nooverflow andpageerrors0. Removed3detail404, Formbricksactualslugthe-open-source-experience-data-hub andJabRef200. Actualdesktop/mobile screenshotsopened. Final `.crawl-samples/catalog-live.json` passed.
- Daily starworkeralreadyexisted; nowprevioussuccessfulsample+timestamp storedatomically, failureretains/sourcechangeresets. Live6757repo products,6695fresh<24h,comparable0 at13:52:29UTC. Onerequestedactualnewworkerstarjob succeededrun255 at13:52:19; errors/locknull. Do not fabricate priorvalues orforce24hinterval. Pending UIuntilnextactualdailymeasurement is expected.
- Finalreview CLEAN after3findingsfixed(P1reusabletool falsepositive,P1latestmetadata+fullinputhashCAS,P2term13+ignored); confidenceunprovided. Fullunit914/integration603beforefinalfix; finalrelatedunit69/integration38,timezone2,TSC/lint/diffcheckPASS; isolatedbuildE2E8 thenfinalsearchbuild/E2E1PASS. Firstnewcleanupfixture missingrepoMeta corrected; liveQA earlyread+wrongslugdiagnostic failurescorrected, not appdefects.
- Ownfilesincommit43, see `git show --stat 17abf63`. OriginaluserHero3hunks/designartifactsremainuncommitted and untouched. Operationsreport `docs/operations/2026-09-13-catalog-quality.md`, plan/spec complete. Obsidianjournal saved `프로젝트 일지/nomorevibe/2026-09-13 비제품 제외와 검색 및 스타 증감.md`; finaldocscommit follows; no runtime redeployneeded fordocs.
- Remaining implementation: none foractive4requests. Existingquerycap100retained; broadsemanticfalse-negativepossibility documented. Latest requestwas search; prior survey-featurequestion not partofthisphase. Nextread-onlycommands: `git status --short`; `python3 /tmp/nomorevibe-catalog-deploy.py status`; `python3 /tmp/nomorevibe-prod-db.py npx tsx .crawl-samples/catalog-release-proof.ts`. Do NOT reruncompletedcleanup; oldplanslacknewinputhashandareintentionallyrejected. Noadditionalapprovalneeded forauthorizedverification.

## Catalogue ready to release — 2026-09-13 22:48 KST

- Independent review found P1 reusable research tool false positives, P1 current metadata/input freeze gaps in cleanup, P2 ignored terms after12. All fixed; focused re-review CLEAN (`/tmp/nomorevibe-catalog-review-clean.log`). Review confidence unprovided. Related unit69/integration38, TSC/lint PASS; final isolated production build/search E2E1PASS after previous8PASS.
- Existing3 exclusions rechecked against latest page identity and remain definite; updated public cleanup preview0. Migration0032 already applied. Do not reapply old plans (new evidenceHash required).
- Ready own commit/push then7-app release: `python3 /tmp/nomorevibe-catalog-release-env.py SHA`, `python3 /tmp/nomorevibe-catalog-deploy.py deploy`, then status. Live checks `node .crawl-samples/catalog-live.mjs` and `python3 /tmp/nomorevibe-prod-db.py npx tsx .crawl-samples/catalog-release-proof.ts`. Complete operations report and Obsidian journal. Preserve user Hero/design artifacts.

## Catalogue release checkpoint — 2026-09-13 22:42 KST

- Objective and own/user file boundaries remain as below. All implementation is complete locally; no release commit/push/deploy yet.
- Production migration0032 APPLIED, exit0 (`/tmp/nomorevibe-catalog-migration-prod.log`). Frozen three-purpose cleanup APPLIED3/skipped0 at13:39:53UTC; receipts `.crawl-samples/non-product-apply-20260913.jsonl`. Do not reapply the cohort.
- Final isolated production build and Playwright8/8 PASS (`/tmp/nomorevibe-catalog-e2e2.log`), TSC and targeted ESLint clean. First browser run found12px star text violating existing13px minimum, fixed to13px; old home heading locator made exact after new search heading legitimately matched. Latest extra timezone unit2PASS. Full unit914 and integration603 previously passed this phase.
- Independent Codex CLI review still running session57430, log `/tmp/nomorevibe-catalog-review.log`; final changed files recopied into isolated worktree. Await findings, fix and focused re-review before shipping.
- Next: review completion; prepare7-app deployment helpers including reviewer; stage only own files (NEVER ProductHero.tsx or user design artifacts), commit/push; release env+deploy7; verify both web health/release, worker heartbeats, actual desktop/mobile search9/more18 and excluded3pages404; report actual baseline availability without inventing history; final report/handoff/Obsidian journal.

## Catalogue/search/star task IN PROGRESS — 2026-09-13 22:37 KST

- Active userrequest: exclude personal research documents/one-off surveys fromprojects, dailyGitHubstars+delta, show9cards instead6, fixsearch. Latestsearchrequest supersedes previous surveyfeaturequestion. Authorizedimplementation+production scope; noadditionalpermissionneeded. Optionalasyncquestion asks exactbadexamples/searchterms; noresponseyet, independentlyreproduced.
- Productionaudit `.crawl-samples/catalog-audit-20260913.json`:6743publicrepo products,6686fresh<24h,57stale,noneunchecked; existing product-stars-refresh248runs/errornull. Existingdailycollectorworks, previouscountsnotstored. Searchrepro `.crawl-samples/search-repro-20260913.json`: OpenCoVibe/FastGPT match butresults1431pxbelowviewport; @opencovibefails. CodebeforethisphaseHEAD2690201, currentprod1893release.
- Implemented locally: sharedproducts/search.ts fieldOR/termAND/literalwildcards/@owner; productrepository+season/alltimeranking useit. Headerglobalq dropsoldfilters; querypages suppresshero/pulse/popular/aside andshowimmediateresults; HOME_FIRST_PAGE/PAGE_SIZE=9. Star schema addsstarsPrevious/starsPreviousAt migration0032; worker shiftsoldcurrentatomicallyonlysuccess; repochangeclearsbaseline. SharedStarMetric+star-change timestampsUTC correctly; home/popular/detail showcount+signeddifference orpending, no fabricatedbaseline. Existingdailycadenceunchanged. No newhistorychart.
- Purpose: pureproduct-purpose.ts excludesclearpersonalresearchjournals/publications/respondentsurveys; reusableFormbricks/JabRef/researchtools/recommendationapps preserved. rulesPageFacts nowincludesdescription;publishpreparation+preparedsnapshotguard catchesalreadyapproved. AIreviewprompt addsdistinction; bothprompt/rulesversions2026-09-13.1. REVIEWMODEobserve unchanged. Thusdeployreviewer too.
- Existingcleanup: lib/crawl/product-purpose-cleanup.ts +scripts/cleanup-non-products.ts preview/apply, exactid/slug/url/repo/updateAt/documentAt CAS, unclaimedcrawleronly, currentpurpose rechecked, reversiblebannedwithauditreason. PreviewALLpublic→3definite:latent-coffee-research, ontology-knowledge-graph-and-ai-research-publications, ott. Plan`.crawl-samples/non-product-plan-20260913.json`. Actualexternalpagescheckedread-only `.crawl-samples/non-product-live-check.json` corroborate3purposes. NOT APPLIED; migration0032NOTAPPLIEDproductionyet.
- Testsactuallyrun: REDpurposemissing,searchmatch,stardelta and9cards. GREENfullunit123files914tests;fullintegration67files603tests. Latertimezoneunitadded2testsPASS;TSCpass. ESLint2unusedimportsremovedafterlastlint,needsquickrerun. NewE2E8tests running session10258 /tmp/nomorevibe-catalog-e2e.log (builddone) innew/tmp/nomorevibe-catalog-check detached2690201; rootnode_modules APFSclone +envcopy. Do notrunintegrationconcurrentlywithE2E sharedtestDB.
- Independentreview activeak: CLIgpt-5.6unsupportedknown; supportedgpt-5.6-sol/high `codex exec` readonlybounded changedfunctionalpaths, noarchive/generatedsnapshot/totalskills, session57430 /tmp/nomorevibe-catalog-review.log. ReviewworktreecopiesallownfilesexceptuserHero; lastunusedimportcleanupnotcopiedy et(harmless). Nochangescommitted/pushedthisphaseyet.
- Modifiedownfileslist `/tmp/nomorevibe-catalog-ownfiles.json` (needsincludehandoffafterthiswrite). Newplan/specdocs/superpowers/...2026-09-13-catalog-quality*. UserHerooriginal3hunks+nomorevibe-final/ +nomorevibe_final.html/source.zip preserved; doNOTstageHero, noowntaskeditsinit.
- Next: finishE2E/review; fixfindings&rerunfocusedreview. Additionalguardtests sourcechange/claimed optionalmeaningful. Migratevia`python3 /tmp/nomorevibe-prod-db.py python3 /tmp/nomorevibe-migrate.py` direct5432. Re-previewifstale; apply3onlyafterreviewwith`python3 /tmp/nomorevibe-prod-db.py npx tsx scripts/cleanup-non-products.ts apply .crawl-samples/non-product-plan-20260913.json .crawl-samples/non-product-apply-20260913.jsonl`. Existingplanwasbeforemigration butCASignoresnewstarscolumnsvalid.
- Deploy7appsweb2/crawler/reviewer/publisher/maintenance/scheduler afterowncommitpush. Adapt/tmp/nomorevibe-thumbnail-{deploy,release-env}.py addreviewer4RlA9EeKvtKGdR6c6AV4j. Need allcodepolicyversionsmatch. No connectagentchanges. Currentkeychain&DBhelperunchanged; neverprintenv/SQLparams. Liveverifyglobalownersearch+description+9rows+more18/mobile,3removed404/excludedsearch, preservedtoolsvisible, starpending/delta states, freshstarsworkerheartbeat+jobruns. Baselinesonlybecomeavailableafterrealnextdailycheck; donotforceextra/fabricatehistory. Finalreport+handoff+Obsidianjournal+owncommits.

## Thumbnail work COMPLETE — 2026-09-13 10:16 KST

- User objective fulfilled: fixed initial3128 image-less public products, integrated collector hints/publication+registration requests/maintenance60s scheduler/daily upgrade retries, deployed and verified actual UI, independently reviewed omissions.
- Initial cohort3128: site icons2127, GitHub avatars734, repository images125, OG142, service defaults0. Final DB confirms3128real,0missing,0broken cache. At01:16:16UTC ALL public6303 haveimages (missing0). Deployed job automaticallyfilled29additional newerproducts(icons22/avatar7); all3postdeploypublishedproducts alsohaveimages;6newdocuments carrythumbnailHints. Productthumbnailjob5successfulruns, last_errornull/locknull. LiveUI4sources×desktop/mobile8pagesPASS, errors0; actualscreenshotsopened.
- Commits77f6548 +1893b15d9d944fdd8e80211eb9391bc42d5c92ba pushed. Sixdeployments(webM3/mini,crawler,publisher,scheduler,maintenance)done exact1893release; bothwebhealthapp/dbok and6freshheartbeats. Reviewer/connectagent priorreleases untouched.
- Final independent review CLEAN after4fixes(P1semanticthumbnailhints, P2small/squarelogo, P2previewreceipt, P2widelogo). Allrepoimagescontain; nativecaps preservewordmarks; originalscreenshot sizesremain. Rawconfidenceunprovided. Requestedgpt5.6unsupported; defaultsolreview used, longreviewconcludedviaexisting-sessionresume thenfocusedfinalclean. Logs `/tmp/nomorevibe-thumbnail-review-{final,conclusion,clean}.log`.
- Validation actuallyexecuted: fullunit119/905 +fullintegration65/596 initial; finalrelatedunit11, integration26; addeddefault→OGretryintegration5, collector/publisherhook55, encodedSVG5, widelogounit2; TSC/lint/diffcheck PASS. Isolatedproductionbuild+E2E5 initialand2final PASS. FirstwideSSRtestfailedPlaywrighttransform; childNode/tsxrealcomponentrenderfixed. InitialrootbuildandunsupportedCLI failures recorded below; no unresolvedcodefailures.
- Filesmodified: thumbnail domain modules,crawl fetch/publish/repository,registration,jobs catalog/registry/worker,networkabort,schema/migration0031,Dockerfont,home/ProductIcon/ProjectCover/Hero,adminjoblabels,unit/integration/E2E,plan/spec/report/handoff. UserHerooriginal3hunks andnomorevibe-final artifacts remainuncommitted; ownHero was stagedbyseparateHEADbasedblob.
- Report `docs/operations/2026-09-13-thumbnail-fallback-rollout.md`; evidence `.crawl-samples/thumbnail-{cohort-20260913,final-audit,pipeline-proof,fallback-live,release-health}.json`, applyreceiptJSONL/deployfinalJSONL. Obsidianjournal saved `프로젝트 일지/nomorevibe/2026-09-13 누락 이미지 보충과 자동 수집.md`.
- Remaining work: no requestedimplementationpending. Backgroundnewpublications naturallymaybrieflyawaitimages; no AIpolicychanges. Finaldocumentation records completed; runtime remains1893release. Nextagentread-onlycommands: `git status --short`; `python3 /tmp/nomorevibe-prod-db.py npx tsx .crawl-samples/thumbnail-pipeline-proof.ts`; `python3 /tmp/nomorevibe-thumbnail-deploy.py status`. Do NOT rerun completedcohort or redeploy withoutnewchanges. Noadditionalapprovalneeded foralreadyrequestedverification.

## Thumbnail release verification in progress — 2026-09-13 10:12 KST

- Code77f6548 plus wide-logo fix1893b15d9d944fdd8e80211eb9391bc42d5c92ba committed/pushed. Last independent review CLEAN `/tmp/nomorevibe-thumbnail-review-clean.log`. Four findings fixed total(earlier3 +wide512x128repo logos). All repoimages nowcontain, onlysmall/squareidentity capped112; native-size caps forwide logos; ProductIcon/ProjectCover/Hero aligned. Last isolatedbuild+E2E2PASS, TSC/lintPASS. SSRfixture firstfailed PlaywrightJSXtransform, separateNode/tsxrenderer fixed actualmarkup test.
- Releaseenvupdated and deploymentqueued6apps at01:12:10UTC via `/tmp/nomorevibe-thumbnail-{release-env,deploy}.py`:webM3/mini,crawler,publisher,scheduler,maintenance. Needpollstatus and fresh runtimeheartbeats/healthsameSHA. No review/connectagentdeploy needed.
- Fixedcohort3128done100%: icons2127/avatar734/repo125/OG142/default0, missing0/broken0 DBverified09:56:35KST. Duringprocessingnewpublicitemscontinued;23outsidecohortmissingat09:56, expectnewbackgroundjobtofill.
- Nextcommands: `python3 /tmp/nomorevibe-thumbnail-deploy.py status`; `python3 /tmp/nomorevibe-prod-db.py npx tsx .crawl-samples/thumbnail-final-audit.ts`; `node .crawl-samples/thumbnail-fallback-live.mjs`. Inspectactualscreenshots andruntimejoboutput/newlypublishedfilled; finalreportandjournal then docscommit. RootonlyuserHero/designartifactsbeforethishandoffedit.

- Release implementation committed locally as `77f6548` at10:07KST; independent review session58318 still checking adjacent cases before push/deploy. Root workingtree contains user Hero/design artifacts plus this handoff update. Hook integration55 and encodedSVG rejection5 tests also passed.

## Thumbnail backfill COMPLETE, release pending — 2026-09-13 09:57 KST

- Frozen3128 fully applied: site_icon2127/github_avatar734/repository_image125/og142/default0; DB audit09:56:35KST confirms3128real,0missing,0brokencache. FullCLI session23638 done3116 afterinitial12. Evidence `.crawl-samples/thumbnail-final-audit.json` andreceipt. No further cohort mutationneeded.
- Review3 findings fixed: ignorethumbnailHints-only reviewmetadata; contain small/square repository logos; receipt onlyapplied/preexisting consideredcomplete. REDexecuted, GREENunit11 +integration26; addedretrydefault→OGtest later integration5PASS. Final TSC/lintPASS, isolated build+E2E5PASS.
- Final independent Codex read-only review currentlyrunning session58318 `/tmp/nomorevibe-thumbnail-review-final.log` in/tmp/nomorevibe-thumbnail-check; waitforcleanbeforecommit. Root ownfiles staged EXCEPT latest report/retrytest/handoff additions; stageexplicitly. Hero indexcontainsownchangesonly; workingdiffisoriginaluser3hunks.
- Next: finishreview, commit/push, use `/tmp/nomorevibe-thumbnail-release-env.py SHA` then `/tmp/nomorevibe-thumbnail-deploy.py deploy` forweb2/crawler/publisher/scheduler/maintenance. Pollstatus. RunDBaudit and `node .crawl-samples/thumbnail-fallback-live.mjs` afterbothwebsup. Reportscriptcurrentlyexists, source examples4kinds. Default0 verifiedviaE2E only. Updateoperationsreport/finalhandoff/journal, docscommit.

## Thumbnail progress 2026-09-13 09:50 KST

- Full backfill running session23638, receipt `.crawl-samples/thumbnail-apply-20260913.jsonl`, over1650/3128 applied. Migration0031 applied. No releasecommit/deploy yet.
- Independent Codex review3 completed: P1 exclude thumbnailHints from semantic review comparison; P2 repository logos must contain; P2 preview/CAS skipped receipt must remain retryable. Fixing with regressions, then rerun review. First requested gpt-5.6 unsupported; default CLI used. Log `/tmp/nomorevibe-thumbnail-codex-review3.log`.
- Full unit119/905 and integration65/596 passed; isolated build and Playwright5 passed. New palette ICO and SVG external-reference regressions passed afterward. Worktree `/tmp/nomorevibe-thumbnail-check` needs fresh copies of root ownchanges, HEAD-based Hero from `.crawl-samples/ProductHero-thumbnail-committed.tsx`. Preserve user Hero diff and three design artifacts.
- Next: finish reviewfixes/tests, clean independentreview, commit/push ownfiles, deploy web2/crawler/publisher/maintenance/scheduler, verifyhealth/job and live sourceimages, final3128 cohortcount + report + journal. Helpers and prior details below remainvalid.

## Thumbnail fallback implementation IN PROGRESS — 2026-09-13 09:31 KST

- User explicitly authorized priority OG→site icons(app/apple/favicon)→project README images→GitHub owner avatar→nomorevibe initials default; first apply to existing image-less published products and report counts, integrate collector/publication/retries. No additional approval needed. Frozen production cohort3128 at00:21:39UTC `.crawl-samples/thumbnail-cohort-20260913.json` (id+slug+initialfields).
- Modified core: new lib/domain/products/thumbnails/{candidates,images,resolver,repository,presentation}.ts; schema product_thumbnail_state; migration0031generated and APPLIED production via `python3 /tmp/nomorevibe-prod-db.py python3 /tmp/nomorevibe-migrate.py` (direct5432). Firstbare migrate helper failed source guard, no mutation, correctwrapperthenpassed.
- Candidate discovery reads HTML icons/manifest, related README images excludingbadges/foreignhosts, exactowner avatar. Safe fetchCapped now accepts abortsignal; deadlines28s total/stages, imagebytes5MB,pixels16M,sharpWebPsmallnoenlarge; PNG/DIB24/32ICO supported, SVG externalresourcesrejected. DefaultgeneratedWebP withinitials/servicebrand; Dockerfile addsfont-dejavu forworker text.
- State persistence atomically writes OGcache+provenance+productpath?thumbnail=kind&w=&h=&v=. CASchecks generation/id,url,repo,updatedAt,currentimage,publicstatus,no maker media; preservesoldhigherpriorityresult. dailyretrylowerpriorities; existingoldOGprotected. Collector stores thumbnailHints;publisher/registerrequest new maintenance job product-thumbnail-refresh, 6parallel per40s tick/1min; scheduler catalog hook. CLI scripts/backfill-thumbnails.ts cohort receipt [--apply][--limit=12],8concurrency, resumableJSONL. Dryrun12 currentlyrunning session1824, receiptthumbnail-preview-20260913.jsonl. No production image writesyet.
- UI ProjectCover removedfakescreens, usesidentitysmallimage/defaulticon;ProductIconobjectcontainforidentity;Hero sourcecaptions +nativeiconsize. IMPORTANT user had preexisting Hero modifications; exactbeforepatch saved`.crawl-samples/user-ProductHero-before-thumbnails.patch`; ownHEAD-basedHero prepared`.crawl-samples/ProductHero-thumbnail-committed.tsx`. Stage that blob forHero usinghash-object/update-index toexcludeuserdiff; do NOT git addwholeHero. Othersusernomorevibe-final artifactsuntouched.
- Tests: newunit7PASS,integration4PASS;TSCpassedafterfixture source crawlerfix;fullunit119/905PASS;fullintegrationstillrunning /tmp/nomorevibe-thumbnail-all-integration.log(session10164). Lintzeroerrors,removedoneunusedtestimportsince. Need strongerICO/abort/sourceUItestsandreview.
- Next: inspect12previewresults;finishunitintegration;copyownchanges to newlycreated/tmp/nomorevibe-thumbnail-check (worktreecreating sessionlastcall), includingHEAD-basedHero, clone node_modules andenvlikepriorisolatedbuild; runcodexCLIindependentreview perak ifappliedandbuild/E2E. No commitsyet. Applyfullcohortonlyafterreviewfirst12andvalidatedcode;maystartwhileUIbuildfinishes ifnecessary buticonsoldUIstretchesuntildeploy.
- Newjob affectsweb2/crawler/publisher/maintenance/scheduler;reviewer/connect-agent unchanged. Existinghelpers /tmp/nomorevibe-lease-deploy.py coverweb2/crawler/publisher/reviewer/maintenance (adaptreplace reviewer→scheduler). /tmp/nomorevibe-release-env.py already5web2/crawler/publisher/scheduler;addmaintenance. Keychain/APIneverprintenvsecrets. DBhelper runtimepgbouncer6432 DB_POOL_MAX1;backfill8requestsusesfastserialDBpoolfine.
- Relevantcommands: `tail -8 /tmp/nomorevibe-thumbnail-all-integration.log`; `python3 /tmp/nomorevibe-prod-db.py npx tsx scripts/backfill-thumbnails.ts .crawl-samples/thumbnail-cohort-20260913.json .crawl-samples/thumbnail-apply-20260913.jsonl --apply`; `git diff --check`. Need update spec/plan checkboxes, operationsreport sourcecounts genuinevsdefault andhandofffinal;actualproduction browser allsourcekinds andresponsive test.

## Thumbnail/pipeline audit complete — 2026-09-13 08:54 KST

- Objective completed: explain image availability, audit actual collection/classification/review, repair proven review stall and re-review omissions. Full report: docs/operations/2026-09-13-thumbnail-pipeline-audit.md.
- Code2ed85c499fd1e80bbcf7070fa8f06a9d9d68cff1 committed/pushed; deployed webM3+mini/crawler/publisher/reviewer/maintenance. BothwebhealthsameSHA/dbok,4workerheartbeatsnewSHA. Scheduler/connect-agent unchanged intentionally.
- Root cause: upstream spmixx12-creator/sperok README had10NULs → PostgreSQL text write failed → error message also hadNUL, catchDBwritefailed and leftlease → queue still10min while runner90s. Fixed README NULstrip, errorNULescape, shared90s queue/runner/assert/status.
- Final production proof23:53:33UTC: first-review completed two ticks23:50:53/23:52:54;4successful review records including originalrepo needs_review. README367chars persisted. Job lock/errornull, requested/processed5848/5848. Second-reviewcompleted23:52:43andnexttickactive. No manual lease reset or policy changes.
- Verification: RED regressions all reproduced; fullintegration64/591PASS atleasefix; finaltargeted3/24+unit2/6PASS,TSC/lint/diffcheck/isolatedproductionbuildPASS. Actualbrowser afterdeploy:detail3,home4x5owner+description,filter/paging15rows/mobile/methodologyPASS,errors0. Final own code review completed.
- Remaining findings (not hidden): OG automaticretry/screenshotcaptureabsent; reviewModeobserve and evidenceeligibility/displayoff;2ndreviewhumanqueue453candidatesat23:38,somegatewaytimeout/invalidoutput; source title/description quality examples inreport. Avoid presenting publication asAIapproval. UserProductHero anddesignartifacts remain untouched.
- Files: lib/crawl/readme.ts;lib/jobs/lease.ts,control.ts,runner.ts,status.ts;tests/crawl-readme.test.ts,admin-job-status.test.ts,integration/job-control.test.ts;handoff/report.
- Failed approaches: rootbuildENOTEMPTY;isolatednode_modulesoutsideTurbopackrootrejected;APFScloneofdepsresolved. SSHread-only source/loginspectionandboundedoldrunJobprobeidentified22021withoutprintingSQLparams/secrets.
- Next commands if asked to continue: `git status --short`; `python3 /tmp/nomorevibe-prod-db.py npx tsx .crawl-samples/review-recovery.ts`; `python3 /tmp/nomorevibe-lease-deploy.py status`; `node .crawl-samples/thumbnail-live-smoke.mjs`. Evidence final `.crawl-samples/review-recovery-2026-09-12T23-53-33-252Z.json`. Do not rerun broad tests withoutnewchanges. Do not changeobserve→enforceorbulkpublicstatuswithoutconcreteuserpolicyinstruction.

## Thumbnail and pipeline audit — 2026-09-13 08:45 KST (in progress)

- Objective: explain thumbnails and verify production collection/classification/review. Read-only receipts at `.crawl-samples/pipeline-audit-2026-09-12T23-37-04-155Z.json`, second at23:40:56Z, `pipeline-followup.json` and `thumbnail-live-smoke.json`.
- Findings: public6248, internal OG3132, no image3116 (2763 no source OG,353 source OG but no cache); current product_media/declarations0, broken OG references0. Images are OG copies, not automated screenshots; home ProjectCover also has decorative fallback. Three live detail pages passed (vigil,2024-2026,know-your-vote); Vercel sample OG redirects to SSO. OG caching silently returns null and has no periodic retry.
- Pipeline: first snapshot recent1h317fetched/40published; classification connected,latest sonnet success23:33:51Z, approved queue0;422 historical classification holds now400published/22rejected. Review observe, evidence eligibility/displayoff; latestAI outcomes public5983unreviewed/49approve/52reject/164hold (historical latest, not necessarily source-current). First AI40success/1invalid output in1h. Second pending417→401votes in4min; at23:38 needs_human453 distinct candidates, pending137,failed21, row statuses overlap candidates. Never claim resolved=approved or all publishedAIapproved.
- Concrete bug reproduced: runner expires lease90s, pendingJobNames/assertJobLease/adminstatus still10min. Actual first-review lock23:29:39→nextclaim23:39:44; no successful job completion since23:28 despite successful attempt23:29:46. Runtime logs show worker.job failed without job.failed detail: original reason for abandoned lease still under investigation. No manual DB unlock/restart.
- Changes: new lib/jobs/lease.ts shared90000ms;control/runner/status consume it;integration job-control2regressions,adminstatusboundary. RED executed (1failed5passed), GREEN targeted23passed plusunit1passed;TSC+targetedESLint PASS. Full integration currently running /tmp/nomorevibe-lease-all-integration.log. Root build failed ENOTEMPTY .next/standalone; use isolated worktree for clean production build.
- Root cause now proven: production bounded runJob probe at23:44:56Z failed22021 NUL while recording the original error. Read-only first20eligible README audit found spmixx12-creator/sperok with10NULs; upstream README562bytes, mixed-encoding tail. readmeText failed to strip NUL before setReadmeSample(text→JSONB); error carried the same NUL into jobs.last_error, so catch itself threw and left ownership. Added readme stripNUL plus error-message escapeNUL. Both regressions REDexecuted; error-record GREEN7passed. Finaltargeted integration/unit/build nowrunning. Earlier fullintegration64/591passed beforethese2smallfixes. Isolated build initially symlinkoutsideTurbopackroot failed; cloned dependencies (cp-cR) succeeded, finalmodifiedsourcebuildingagain.
- Final pre-deploy checks: targetedintegration3/24 PASS, unit2/6 PASS, TSC+targetedESLint+diffcheck PASS; isolated production build PASS with finalcode. Own diff reviewed:90s queue/runner/assert/UI boundaries agree, currentleases remainexclusive; README strips NULbeforeDB and genericcatch escapesNUL beforeerrorpersist. No policy/schema change. Classification latest15 inspected; category calls successful, obvious examples Finance/Commerce/Design/Sports appropriate; generic Streamlit title and truncated Augenta tagline remain contentquality issues, not classification-runtime failure.
- User ProductHero.tsx and nomorevibe_final artifacts untouched. Do not stage them. Ready to commit/deploy own files. Need finish finalchecks, own diffreview, commit/push, releaseenv+Dokploy6apps(web2/crawler/publisher/reviewer/maintenance), observeactualcompletion, reportremainingpolicy/image/secondreviewlimitations.
- Commands: `tail -10 /tmp/nomorevibe-lease-all-integration.log`; `git diff --check`; `python3 /tmp/nomorevibe-lease-deploy.py status`; `python3 /tmp/nomorevibe-prod-db.py npx tsx .crawl-samples/pipeline-audit-20260913.ts`; SSH100.92.77.66 works, reviewer container e2d53bc9a6a3(app-copy-primary-hard-drive-b5fhzd). Fetch logs into memory and emit only sanitized fields; don't print env/tokens/SQLparams.

## Compact popular preview — 2026-09-13

- Objective: user's screenshot feedback requests project name, GitHub ID, one-line description and at most5items per tier, with compact spacing. This supersedes the earlier10-item home preview.
- Completed locally: home query limit5; each row has project link/stars, linked @GitHub owner, one-line tagline with full-text title; removed ordinal and account-type rows; tightened header/padding; methodology now says maximum5. Full table remains15/page.
- Modified: components/home/PopularTiers.tsx, app/home.css, lib/domain/products/popular.ts, components/home/MethodologyDialog.tsx, tests/e2e/popular-projects.spec.ts, this handoff. Existing user ProductHero edit and design artifacts remain untouched.
- Tests executed: TSC, targeted ESLint and diffcheck PASS. Existing Playwright3/3 PASS (1440/390px, minimum13px, no document overflow, filter/paging,5row cap and GitHub/description fields). Screenshot /tmp/nomorevibe-popular-home-1440.png opened and inspected: panel approximately461px vs737px previously.
- Release complete: a9a5734f7370537711264b0275d80649a18a4b5d pushed to main. M3 deploy rIsulT-HMtAtYz6TIFIvp and mini deploy gwqK31ioicTyJ4qrGsvZ8 both done at23:27UTC, same source/release. Both direct /api/health responses ok/dbok with that release. Workers unchanged.
- Live verification at2026-09-12T23:27:43Z passed:4×5projects,20GitHub IDs and descriptions,full counts80/66/61/45,owner profile hrefs,existing filtering/paging/evidence/methodology/mobile overflow checks,pageerrors0. Desktop production screenshot opened and visually checked. Evidence: .crawl-samples/popular-compact-production-home-desktop.png and popular-compact-production-smoke.json.
- Failed approaches: none. Remaining requested work: none. GitHub CI34725426058 was still running at this record; only the explicitly executed local build/TSC/lint/browser3 and production checks are claimed passed.
- Next commands: `git status --short`; `node .crawl-samples/live-popular-smoke.mjs` after updating its expected per-tier count to5. Production /tmp helpers use Keychain secrets only in childenv; restrict deployments to the two web apps for this UI-only change.

## C-track complete: deployed, live UI verified, omission review complete — 2026-09-13 01:46 KST

- Objective fulfilled: entire C-track handoff implemented, approved C1 applied, deployed and visually verified, then reviewed again for omissions as requested. C4 was conditional: all default groups exceed10, so retain existing12discoveryqueries and budget2. B-track commit streaks remain separate per original document.
- Completed C1: maxStars99999;318 applied/0 skipped; after30.39min published249,needs_review12,rejected57 (duplicate34/not_product22/unreachable1),new/approved0. reviewMode observe unchanged; publication count is not AI approvals. Receipt remains .crawl-samples/stars-prod-receipt-20260913.json.
- Completed C2: migration0030 applied directly on production5432,5995products backfilled. Publisher initializes stars, repository changes clear them. New bounded crawler job schedules every5min/40rows,24h freshness. First real execution16:44:27→33UTC updated40/40,error0,cursor afterId52,request/processed1/1.
- Completed C3: home4×10 rows, /popular15rows,personal/tier/page URL state,public evidence summaries with freshness/relationship caveats,methodology2.1,min13px,responsive overflow handling,empty and failed-load states. Live groups78/65/61/45,personal23/17/9/15.
- Source PR109 merged: d7b832be7a7bfccb06183daa6d7ad91c02435c6c. WebM3+mini/crawler/publisher/scheduler all deployment.done on that SHA. Code release418d734028990df808068a4a38debc6bd38d301a was set consistently in runtime tags and web build/runtime deployment IDs. Both direct node health checks and public domain return ok/dbok. New-release worker heartbeats verified16:45UTC.
- Tests actually executed: GitHub CI unit116files/897PASS,integration64files/589PASS,fullESLint,TSC,NextproductionbuildPASS. Separate checkout containing only committed source passed7Playwright tests covering old home,new lists,and desktop/mobile detail. Expanded stars integration9/9PASS. Live browser smoke on https://nomorevibe.brut.bot completed16:44:40UTC: all bands/bounds/order/filter/paging/reload/evidence anchor/mobile/methodology PASS,pageerrors0. Screenshots opened and visually inspected.
- Final review fixes: optimistic checkbox state; missing evidence anchor; repository changed-and-returned response race; locked current repo for resetting stats; preserve stale/relationship caveats in table; stale detail test expectations; stale production release identifiers.
- Modified files: implementation f5d94eb (32files incl schema0030/rejudge/domain/stars job/home/popular/shared detail evidence/tests/docs); test correction418d734. Final docs record operational evidence. User ProductHero.tsx edit and nomorevibe-final artifacts remain untouched and uncommitted. No user stash touched.
- Failed approaches: public artifact fetch only shell, native Chrome read succeeded earlier; server-only test needs existing vi.mock pattern; Turbopack rejects external node_modules symlink in isolated checkout, actual cloned dependencies fixed it. No claimed success before actual execution.
- Remaining implementation work: none for C1–C4. Twelve candidates remain in normal human-review queue. Full operational report and local screenshot links: docs/operations/2026-09-13-popular-projects.md. Earlier pending entries below are historical and superseded.

Exact verification commands:
```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
curl -fsS https://nomorevibe.brut.bot/api/health
node .crawl-samples/live-popular-smoke.mjs
python3 /tmp/nomorevibe-prod-db.py npx tsx .crawl-samples/observe-stars.ts
python3 /tmp/nomorevibe-prod-db.py npx tsx .crawl-samples/observe-stars-job.ts
```
The local /tmp production helper retrieves secrets from Keychain into childenv only. Never print/save app env or credentials. The isolated validation checkout is /tmp/nomorevibe-release-check (detached418d734); do not confuse it with the user's working tree.

## C-track implementation verified, release in progress — 2026-09-13 01:35 KST

- C1 production applied318/0 skipped under approved existing policy; 30min observation still due at16:41:36Z.
- C2 production0030 migration successfully applied directly to5432. At16:33:05Z all5995 products backfilled; public eligible bands78/65/61/45, personal23/17/9/15. C4 conditional expansion not triggered: all four default groups already exceed10. Existing12queries/pagesPerTick2 unchanged.
- C3 implementation and final review corrections: optimistic checkbox state, actual evidence anchor, reuse detail public observed facts including stale/relationship qualifiers, repository change-and-return CAS guarded by exact DB updated_at, latest locked repo used when clearing stats.
- Tests executed: full unit116/897 PASS, integration64/587 PASS; expanded focused9/9 PASS (includes public setting/link hiding/old evidence and change-return race); TSC+targetedESLint+diffcheck PASS. New Playwright3/3 PASS with1440/390px screenshots visually inspected. Final browser regression run now includes home-redesign and product-detail.
- Failure fixed in test setup: server-only module needs same vi.mock used by existing detail integration tests. No application workaround.
- Modified files: git status plus app/p/[slug]/page.tsx anchor and lib/domain/products/detail-view.ts shared evidence helper; docs/operations/2026-09-13-popular-projects.md tracks whole requirement review. ProductHero and user design artifacts remain excluded.
- Remaining: commit explicit files/PR/merge, deploywebM3+mini/crawler/publisher/scheduler (web autoDeploy is true, DB already ready), inspect deployments and public https://nomorevibe.brut.bot, run30min receipt observation, update finalreport/handoff. Production migration helper `/tmp/nomorevibe-migrate.py` only transforms the verified existing host's6432→5432 in childenv; no secrets on disk.
- Next commands: `tail -15 /tmp/nomorevibe-popular-e2e-final.log`; `git diff --check`; `python3 /tmp/nomorevibe-prod-db.py npx tsx .crawl-samples/observe-stars.ts`. Native Chrome currently user other task; use new browser tab or repository Playwright live smoke, do not alter their tab.

## C-track full implementation in progress — 2026-09-13 01:28 KST

- Objective: user authorized C1 apply, then requested the entire document implemented, deployed and checked on screen, followed by another omission review. No further approval needed for that scope.
- Production C1: maxStars 2000→99999 saved 2026-09-12T16:10:44.910Z. Reviewed 318-row plan applied: 318 changed, 0 skipped. Receipt `.crawl-samples/stars-prod-receipt-20260913.json`. At 16:17:41Z (~6 min): published123, approved112, needs_review15, new19, rejected49. These are actual pipeline states, not AI approval claims. Observe again after16:41:36Z.
- C2/C3 implemented locally: migration0030 stars/stars_at/owner_type/stars_checked_at + latest document backfill + indexes; publisher writes stats; repository URL edits clear stats; bounded crawler refresh job scheduled every5min; home four10-item lists; /popular fifteen-row table; URL-preserved personal filter/tier/page; methodology and responsive13px styles.
- Tests executed: new stars unit3 PASS; new popular integration7 PASS including backfill, failure throttle, quota cursor and repository-edit race. TSC and targeted ESLint PASS before latest test additions. Full unit and new Playwright are currently running; do not claim passed until exit checked.
- Modified files: see git status, C1 files in previous entry plus new stars/popular domain modules, stars refresh job, schema/migration0030, home/popular UI and tests. User preexisting ProductHero.tsx edit and nomorevibe-final artifacts must remain unstaged. No commits/push/deploy yet.
- Decisions: retain existing AI policy. Do not fabricate B-track commit streaks; show actual stats check date and link to evidence. C4 discovery expansion remains conditional on actual C1 band fill and existing source settings.
- Remaining: finish UI QA + visual inspection; repair evidence anchor; review table evidence requirements; full test suite; C4 decision/config; C1 30min observation; final code/requirements review; commit PR merge; direct DB migration0030; deploy both web instances and affected singleton workers; verify live screen/health and record exact outcomes.
- Failed approaches: initial missing-module tests were RED as expected; one test fixture omitted required health.status and was corrected. Artifact HTTP fetch returned shell/Cloudflare, native Chrome CUA successfully read original and mock.
- Production helper `/tmp/nomorevibe-prod-db.py` reads Dokploy keychain and supplies DB URL to child env only. Never print secrets or app env. Relevant IDs: webM3 oipo2OAnIrtcnILBCRoG2, webMini llv4rlABSJOcFauSxaHdx, crawler AFHDBGCCY4zT9XkkcnzGd, publisher AeTaWnZbZKzzv94h7c8Vw, scheduler uAjLU7MslLIGpORD9h6LQ. Deploy API uses direct curl per prod skill.

Exact continuation commands:
```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
tail -30 /tmp/nomorevibe-popular-e2e.log
tail -10 /tmp/nomorevibe-popular-unit.log
python3 /tmp/nomorevibe-prod-db.py npx tsx .crawl-samples/observe-stars.ts
npm run test:integration
npx tsc --noEmit -p .
```

## C-1 star-band rejudge prepared; production apply awaits review — 2026-09-13

- Current objective: user asked to read and continue the [C-track handoff](https://claude.ai/code/artifact/258acc8e-c763-45cc-9aea-62c360b6ac56).
  The next PR-sized item is C-1: widen star eligibility and requeue automatic `large_oss` rejections. The linked
  document explicitly requires a reviewed dry-run before production application. C-2/C-3/C-4 remain subsequent work.
- Current repository: main at `580c7d1` at start. Production now exists: Dokploy reviewer
  `4RlA9EeKvtKGdR6c6AV4j` returned name `nomorevibe-reviewer-m3`, status `done`, branch `main`.
  Earlier deployment-pending entries below are historical and must not override this observed state.
- Completed: added read-only repeatable-read planning, schema-validated apply/revert, exact candidate/document
  fingerprints with row locks, settings and DB guards, pre-commit durable receipt persistence and conservative
  rollback. CLI defaults to dry-run, refuses conflicting flags and existing output files, and suppresses raw DB errors.
- Modified files: new `lib/crawl/rejudge.ts`, `scripts/rejudge-stars.ts`, `tests/integration/rejudge-stars.test.ts`,
  `docs/superpowers/plans/2026-09-13-rejudge-stars.md`, `docs/operations/2026-09-13-rejudge-stars.md`, this handoff.
  Existing `components/product-detail/ProductHero.tsx`, `nomorevibe-final/`, `nomorevibe_final.html`,
  `nomorevibe_final_source.zip` were not changed. Do not stage/revert them or touch the user's stash.
- Key decisions: existing maxStars is inclusive (`stars > maxStars` rejects), so the document's 100000 would
  admit exactly 100000. Proposed setting is **99999**, preserving the user requirement to exclude 100000+.
  No production setting or rule default changed. An optional user question about stronger evidence at 5000+
  is pending; preparation retains current AI/second-review policy. Application requires proposed settings to
  match the plan; it only changes candidate state and updated_at. Human decisions, published rows and changed
  inputs are preserved. Revert only restores actual applied rows still unchanged/new, including microsecond
  timestamp precision; it does not undo later reviews/publication or restore the global star setting.
- Production dry-run actually executed at `2026-09-12T15:48:17.688Z` (2026-09-13 00:48 KST): **318 candidates**,
  bands 97/84/71/66, personal accounts 35/27/11/20 (93 total). Stored-source rule preview: approved/passed292,
  needs_review/ambiguous16, rejected/not_a_product10. Preview excludes live AI/second review, latest evidence
  and URL duplicate/ban lookup; it is not a claim of publication eligibility or eventual outcomes.
- Artifacts: `.crawl-samples/stars-prod-plan-20260913.json` and human-readable
  `.crawl-samples/stars-prod-review-20260913.md` (318 rows), both local and gitignored. They contain no credentials.
  No receipt exists because no production apply was performed.
- Tests actually run: initial missing-module failure followed by placeholder RED (5/6 expected behavior failures);
  final focused integration **6/6 PASS**; full unit **115 files/894 PASS**; full integration **63 files/580 PASS**
  (178.76s); `npx tsc --noEmit -p .`, targeted ESLint and `git diff --check` PASS. Logs are
  `/tmp/nomorevibe-stars-unit.log` and `/tmp/nomorevibe-stars-integration.log`. CLI help exit0 and conflicting
  apply/revert exit1 verified. No production changes, live rejudge results, deploy or UI implementation claimed.
- Failed approaches: web fetch returned an artifact shell; its frame API returned a Cloudflare challenge.
  CUA browser provider was unavailable, but native Chrome through CUA successfully displayed the full document.
  No anti-bot bypass or account permission change was performed. `lib/crawl/rejudge.ts` was absent before this work;
  the existing `scripts/rejudge.ts` only evaluates local samples and is unchanged.
- Remaining work: obtain review of the concrete 318-row plan and authorization for maxStars2000→99999 plus
  requeue under existing review policy; then change only that setting, apply with a new receipt path, record
  applied/skipped counts, and measure actual rule/AI/second-review states after5/30minutes. If the user chooses
  stricter evidence, define that policy before applying. Code is local, uncommitted; no push or PR was created.

Exact next commands (DB URL must be injected from the secret store, never printed or stored in a file):

```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
# Read reviewed input; production mutation below ONLY after user approval and maxStars=99999 in /admin.
cat .crawl-samples/stars-prod-review-20260913.md
DB_POOLER_MODE=pgbouncer npx tsx scripts/rejudge-stars.ts --apply=.crawl-samples/stars-prod-plan-20260913.json --receipt=.crawl-samples/stars-prod-receipt-20260913.json
# If reverting unprocessed applied rows is authorized:
DB_POOLER_MODE=pgbouncer npx tsx scripts/rejudge-stars.ts --revert=.crawl-samples/stars-prod-receipt-20260913.json
```

Production DB access used Python `subprocess.check_output` for macOS keychain account `deploy.brut.bot`,
service `dokploy-api-key`; GET `https://deploy.brut.bot/api/application.one?applicationId=4RlA9EeKvtKGdR6c6AV4j`
with the key in `x-api-key`; extracted only DATABASE_URL from the env field into the child process environment,
with DB_POOLER_MODE=pgbouncer and DB_POOL_MAX=1. Never print the key, app env or raw exception bodies.

## Production multi-instance hardening complete; deployment pending — 2026-09-09 17:47 KST

- Current objective: deploy NoMoreVibe for the first time with two load-balanced web instances, one M3-only
  scheduler/crawler/reviewer/publisher/maintenance set, one persistent M3 connect-agent, and the existing
  catalogue copied into the dedicated production PostgreSQL database.
- Completed work: added explicit PgBouncer transaction-pool mode and per-role connection budgets; separated
  migration from the runtime pool URL; added DB-backed `/api/health`; added per-instance service heartbeats and
  release/RSS/freshness visibility; made partially stale replica groups degraded; gave connect-agent its own
  Docker target and HTTP health check; removed the `AUTH_SECRET` fallback for agent control; configured a stable
  Next deployment ID and BuildKit-only Server Action key; documented M3/mini placement and cutover/rollback.
- Modified files: `.env.example`, `Dockerfile`, `compose.yml`, `next.config.ts`, root `instrumentation.ts`,
  `app/api/health/route.ts`, `app/admin/status/OperationsCenter.tsx`, `lib/db/pool.ts`,
  `lib/operations/{admin,agent-client,health,instance,observations,web-observer}.ts`,
  `scripts/{connect-agent,migrate,worker-supervisor}.ts`, `scripts/migration-config.{mjs,d.mts}`,
  `tests/{db-pool-options,migration-config,next-config,operations-agent-client,operations-health,operations-instance}.test.ts`,
  `.env.example`, `PENDING.md`, and the production operations/design/plan documents.
- Key design decisions: both web replicas use one release SHA, Server Action encryption key and session/visitor
  secrets; only the M3 runs singleton jobs; runtime traffic uses PgBouncer port 6432 while the one-shot migration
  uses direct PostgreSQL port 5432; Redis is not introduced because the current DB lease/job system already
  provides atomic claims and measured load does not require another dependency; each process reports a stable
  `SERVICE_INSTANCE_ID`, so a healthy replica cannot hide a stale one.
- Tests actually executed: full unit suite 95 files/681 tests PASS; full integration suite 50 files/456 tests
  PASS before the final review corrections; focused operations-center integration 1 file/6 tests PASS after
  those corrections; TypeScript/typegen PASS; ESLint PASS with the pre-existing `_ctx` warning in
  `lib/vendor/deppy-aibox/claude.ts:158`; Next production build PASS; runner, worker and connect-agent Docker
  targets PASS; Compose config and `git diff --check` PASS. A runner container returned `status=ok` and `db=ok`
  from `/api/health`. A real connect-agent container reached Docker `healthy`; both smoke observation rows were
  removed. Thirty-two concurrent query/transaction operations through the production PgBouncer endpoint passed.
- Review: `codex review --uncommitted` completed. Its migration-URL and stale-replica findings were fixed and
  covered by regressions. No known code blocker remains for deployment.
- Failed approaches: the first Next build failed because the worktree's `node_modules` symlink pointed outside
  the Turbopack filesystem root; an independent `npm ci` fixed it. The first Dockerfile exposed the Server Action
  key through `ARG`/`ENV`; it was replaced with a required BuildKit secret and rebuilt successfully.
- Remaining work: commit/push/merge this branch; create Dokploy applications on M3 and mini; generate and store
  distinct production secrets; stop and drain local singleton consumers; copy data without the Drizzle migration
  ledger into the already migrated production DB; clear any stale leases; deploy the same release to both web
  nodes and singleton roles only on M3; attach the public domain/load balancer; verify health, row counts, jobs,
  AI connectivity and direct/public routes; then update `PENDING.md`, this handoff and the project journal.

Exact next commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe-prod-fix
git diff --check
git status --short
git add .env.example Dockerfile PENDING.md app/api/health app/admin/status/OperationsCenter.tsx compose.yml docs/CODEX_HANDOFF.md docs/operations/independent-workers-runbook.md docs/operations/production-multi-instance.env.example docs/superpowers/plans/2026-09-09-production-multi-instance.md instrumentation.ts lib/db/pool.ts lib/operations/admin.ts lib/operations/agent-client.ts lib/operations/health.ts lib/operations/instance.ts lib/operations/observations.ts lib/operations/web-observer.ts next.config.ts scripts/connect-agent.ts scripts/migrate.mjs scripts/migration-config.d.mts scripts/migration-config.mjs scripts/worker-supervisor.ts tests/db-pool-options.test.ts tests/migration-config.test.ts tests/next-config.test.ts tests/operations-agent-client.test.ts tests/operations-health.test.ts tests/operations-instance.test.ts
git commit -m "fix: harden production multi-instance runtime"
git push -u origin fix/production-multi-instance
```

## Claude stored-token corruption repaired; live greeting and classification verified — 2026-09-09 13:49 KST

- Objective: investigate Claude authentication failure despite credential storage; show an actual hi~ reply.
- Root cause proven: the saved token was 113 characters and ended with the literal footer word `Store`.
  The provider stitched this isolated footer word onto the token as if it were a wrapped token segment.
  Actual CLI returned HTTP 401 `OAuth access token is invalid` both with and without --safe-mode, so safety
  isolation was not the cause and remains enabled. Removing only that diagnosed suffix yielded a real Sonnet
  greeting and structured product classification. Previous blank-line fix alone was insufficient.
- Completed: parser excludes the Store footer and waits for incomplete footer lines. Claude adapter supports
  plain text output for a fixed hi~ probe; default category output remains schema-bound. Probe records contain
  timestamp/model/prompt/reply/result separately from classification. UI displays sent hi~ and actual reply;
  auth errors read `인증 실패 · 재연결 필요`. No raw CLI errors or tokens exposed; reply bounded to 2,000 chars.
- Modified files this phase: `lib/vendor/deppy-aibox/{claude.ts,README.md}`, `lib/operations/{claude,agent,contracts}.ts`,
  `lib/crawl/classify.ts` (export existing failure classifier), `app/admin/status/{AiConnection.tsx,operations.css}`,
  `tests/operations-claude.test.ts`, operations runbook and this handoff. Prior countdown changes still uncommitted.
- Data repair: while connect-agent idle, stopped it, read the encrypted vault via a temporary worker container,
  required exact diagnosed 113-char/Store shape, verified corrected candidate using a real hi~ call, backed up
  encrypted original to `vault.enc.before-footer-repair-20260909`, then atomically stored corrected credential.
  No general-purpose token trimming was added. Temporary env file was mode0600 and removed. Helpers:
  `/tmp/nomorevibe-repair-claude.py` and `/tmp/claude-repair-footer.cjs` (one-time; do not rerun after repair).
- Local deployment: new worker/runner images use existing operations-v2-20260909 tags; only app/connect-agent
  recreated. Both healthy; five independent workers healthy. Existing configVersion=2, generation=2,
  appliedGeneration=2, configReady=true preserved. Primary Spark xhigh, fallback Sonnet high.
- Verification actually executed: three regressions failed before implementation, then 2 files/24 tests PASS;
  full suite 89 files/663 tests PASS (`/tmp/claude-hi-full.log`), TypeScript/targeted ESLint/diff check PASS;
  Docker worker and runner builds PASS. CUA at localhost3200: clicked Claude connection check, saw real
  `Hi! What are you working on?`; clicked selected-model test, saw Spark AND Sonnet `정상 응답 확인`.
  DB observation confirms both connected=true, busy=null, configReady=true and both test results success.
- Failed approaches: toggling --safe-mode produced the same401 and was diagnostic only. Fixture token capture
  from previous phase omitted the isolated Store footer case. No further user OAuth approval is needed now.
- Remaining: no requested implementation outstanding. User can reload localhost3200/admin/status -> AI 연결.
  No new commit/push this phase. Preserve unrelated ProductHero/product-detail test edits and design artifacts.

Exact next commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
npx vitest run tests/operations-claude.test.ts tests/operations-countdown.test.ts tests/operations-agent.test.ts
docker exec nomorevibe-db-1 psql -U nomorevibe -d nomorevibe -Atc "select value->>'busy',value->>'claudeConnected',value->>'configReady',value->'verification'->'results' from operations_observations where key='connect-agent'"
```

Do not rerun token-repair helpers: repaired token intentionally no longer matches the corruption guard.


## AI countdown and Claude setup-token compatibility — 2026-09-09 13:38 KST

- Objective: display an actual 35-second model countdown and Claude connection countdown; investigate repeated
  Claude connection failures against `/Users/jr/Desktop/projects/Deppy-aibox` and fix the integration.
- Completed: added server activity IDs/deadlines/current time and a client countdown (model 35s, login 600s,
  code exchange 45s). Countdown survives dialog close/reopen and polling; terminal state clears activity.
  Claude code and Enter are now separate stdin writes, 250ms apart, with cancellation cleanup. Token capture
  now accepts completed blank lines in the real setup-token success layout.
- Root cause evidence: aibox HEAD 814144a2d37cb60359486219393f93f32c7267fc pins Claude 2.1.186; our image uses
  2.1.263. Original combined long `code#state` + CR stalled for 55 seconds. A separate CR immediately yielded
  HTTP 400. With the corrected ConnectAgent, an isolated real CLI run yielded `oauth_rejected` in 713ms and
  drained the busy lock. Installed CLI source confirms a blank line after the token (Ink gap:1); old parser
  failed to capture that layout while the process remained open. No real OAuth secrets were used in diagnostics.
- Modified files: `lib/operations/{agent,contracts,countdown}.ts`, `app/admin/status/{AiConnection,Countdown}.tsx`,
  `app/admin/status/operations.css`, `lib/vendor/deppy-aibox/{claude.ts,README.md}`,
  `tests/operations-{claude,countdown}.test.ts`, `docs/operations/operations-center-runbook.md`, this handoff.
- Actual checks: two new regressions failed before fixes; focused 3 files/23 tests PASS; full Vitest 89 files/
  660 tests PASS (`/tmp/claude-countdown-full-tests.log`); TypeScript, targeted ESLint, git diff --check PASS.
  Docker worker and runner builds PASS. Isolated real CLI check `/tmp/claude-agent-submit-check.cjs` PASS.
  CUA at localhost:3200/admin/status showed 35 -> 29 seconds then real Codex Spark success; Claude showed
  600 -> 595 -> 588 seconds across dialog close/reopen. The diagnostic Claude session was cancelled.
- Local deployment: rebuilt `nomorevibe-{web,worker}:operations-v2-20260909`, recreated app and connect-agent
  only with `/tmp/nomorevibe-operations-deploy.py connect-agent app`. Both healthy; all five worker roles
  healthy. Existing encrypted vault and applied config version 1 preserved; configReady=true, Codex connected
  and probe success, Claude not connected. No production deployment or push performed.
- Failed approaches: testing a short dummy code without #state only exercised CLI local validation and missed
  real exchange; combined long input was the actual failure. Direct dummy token endpoint POST returned 400
  in 373ms, so no evidence for changing proxy/certificate handling. Early Python UI edit had syntax error;
  corrected before tests/build. CUA binding was absent after compaction; recovered existing tab 1/browser 1.
- Remaining: user must approve a fresh Claude OAuth session to verify real account storage and actual Sonnet
  response. Do not claim authenticated Claude success from a fake-code exchange or fixture-token tests.
  Current task uncommitted. Prior commit 605203f contains the operations center. Preserve unrelated existing
  ProductHero.tsx / product-detail-components.test.tsx edits and untracked nomorevibe-final artifacts.

Exact next commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
npx vitest run tests/operations-claude.test.ts tests/operations-countdown.test.ts tests/operations-agent.test.ts
docker ps --filter name=nomorevibe --format '{{.Names}} {{.Status}}'
docker exec nomorevibe-db-1 psql -U nomorevibe -d nomorevibe -Atc "select value->>'busy',value->>'connected',value->>'claudeConnected',value->>'configVersion',value->>'configReady',value->'connection'->>'state' from operations_observations where key='connect-agent'"
```

Use the admin UI at http://localhost:3200/admin/status for fresh Claude approval, then Claude connection check,
selected model test and settings apply. Never print credential contents, real authorization codes or vault keys.


## GitHub owner identity and detail-sidebar evidence — 2026-09-08 22:08 KST

- Objective: replace the anonymous creator label on crawler-listed product cards with the public GitHub
  repository owner, and move the useful unclaimed-product identity/repository facts into the existing detail
  sidebar. Audit the current category classifier without expanding its taxonomy in the same change.
- Completed: unclaimed cards backed by a canonical GitHub repository now show a linked `@owner`; claimed maker
  labels remain unchanged. The detail sidebar now includes one compact owner/contact/claim card and renames the
  repository panel to `현재 확인 가능한 정보`, with owner, repository, visibility, dates, stars, forks,
  contributors, activity, languages, service relationship, release and license facts. Invalid or non-GitHub
  repository URLs do not receive an attributed owner.
- Modified files: `components/home/ProjectCard.tsx`, `app/home.css`, `app/p/[slug]/page.tsx`,
  `components/product-detail/{UnclaimedOwnerContact,RepositoryEvidence}.tsx`,
  `lib/domain/products/github-owner.ts`, their focused tests, the accepted standalone concept at
  `docs/designs/2026-09-08-unclaimed-product-contact.html`, and this handoff.
- Key design decisions: call the account `GitHub 저장소 소유자`, since repository ownership does not prove who
  built the deployed service; derive identity only from strict two-segment github.com repository URLs; preserve
  the existing unclaimed badge and takedown flow; keep all observed facts in the existing 340px sidebar; make no
  category/schema migration before agreeing on a richer taxonomy and measuring existing `Other` records.
- Category audit: the schema has only `Productivity`, `Dev`, `Design`, `Finance`, and `Other`. Publication asks
  hard-coded `claude-sonnet-5` for one of those five using name, tagline, URL, repository, language and topics;
  any CLI/auth/timeout/parse failure falls back to ordered topic/description keyword rules. The live local
  publisher currently logs `reason=auth` / `Not logged in`, so its new publications are using that fallback.
  Latest live local public counts were Other 646, Dev 407, Productivity 55, Design 41, Finance 36. Categories are
  stored at publication and there is no automatic reclassification job; a claimed maker can edit the category.
- Actual checks: TDD red run failed for the missing helper/component/link, then focused 3 files/29 tests PASS;
  full unit 81 files/620 tests PASS; nonincremental TypeScript PASS; ESLint PASS; production Next build PASS;
  `git diff --check` PASS. Playwright against the preserved live-data DB returned HTTP 200 for home/detail,
  resolved the owner link to `https://github.com/AISecurity365`, found both new sidebar headings, had no
  console/page errors, and had no horizontal overflow at 1440px or 390px. Screenshots:
  `/tmp/nomorevibe-owner-list.png`, `/tmp/nomorevibe-owner-detail-desktop.png`, and
  `/tmp/nomorevibe-owner-detail-mobile.png`.
- Failed approaches: an existing Next development lock pointed to port 43128 and its isolated DB did not contain
  the selected live product. A production server was therefore started on port 3201 with only DATABASE_URL's
  local forwarded port changed from 55434 to the preserved DB at 55437. The first Playwright accessibility-name
  selector expected `GitHub` in a link whose visible label was only the owner; selecting the exact sidebar href
  fixed the QA script. The temporary script was removed.
- Merge and local deployment: PR64 passed its checks and merged to main as `bb19bc2456daa0c20dc2fa756404ff6fd800a973`;
  post-merge main CI run `34230385038` passed. Port 3200 now runs image
  `nomorevibe-web:github-owner-5431902` against the preserved catalogue DB; only the app was recreated, so all
  independent workers kept running. The container is healthy. Post-deploy Playwright used an exact search query
  because ongoing publication moved the earlier fixture off the first six cards; search and detail returned 200,
  the detail had three owner-profile links, mobile had no horizontal overflow, and browser errors were zero.
- Remaining: category expansion should be a separate measured change: sample and label current `Other` records,
  agree on stable primary categories plus functional tags, restore a long-lived classifier credential, add
  confidence/versioned decisions, then reclassify existing records with review and rollback support.

Exact next commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe-workers
git status --short
npm test
npm run build
git diff --check
open http://127.0.0.1:3200/?q=Automatizaci%C3%B3n
gh run view 34230385038
docker logs --since 2h nomorevibe-publisher-1 2>&1 | rg 'crawl.classif|Not logged|auth' | tail -n 30
docker exec nomorevibe-db-1 psql -U nomorevibe -d nomorevibe -c "select category,count(*) from products where status in ('seeded','verified') group by category order by count(*) desc"
```

## Unclaimed product owner/contact HTML concept — 2026-09-08 21:30 KST

- Objective: produce a reviewable HTML concept that gathers useful public information for crawler-listed,
  unclaimed products and gives visitors a realistic way to contact the repository owner.
- Completed: added `docs/designs/2026-09-08-unclaimed-product-contact.html`, using the current product-detail
  visual language and live `AgentWorkforce/relay` metadata. The design keeps owner identity, available contact
  routes and ownership claim in one section, followed by a compact observed-facts panel and an explanation of
  the unclaimed state.
- Design decisions: label the account as `GitHub 저장소 소유자`, never as the confirmed maker; distinguish
  organization accounts; expose only working routes (GitHub profile, new issue and official website); avoid
  scraped commit email; keep `GitHub에서 확인` and the observation date visible; let verified makers replace
  the unclaimed treatment through the existing claim flow.
- Modified files: the standalone HTML concept above and this handoff only. No production component, schema or
  crawler behavior changed.
- Actual checks: HTML parser PASS; `git diff --check` PASS; Playwright desktop 1440px and mobile 390px rendered
  HTTP 200 with three contact links, the source label and claim CTA; both had zero console/page errors and no
  horizontal overflow. Screenshots: `/tmp/nomorevibe-unclaimed-desktop.png` and
  `/tmp/nomorevibe-unclaimed-mobile.png`.
- Failed approaches: `agbrowse` was unavailable on PATH, so the existing Playwright installation was used. A
  temporary QA module under `/tmp` could not resolve the project dependency; moving it to the repository for the
  run fixed module resolution, and the temporary file was then removed.
- Remaining: collect user feedback on this concept. If accepted, normalize GitHub owner fields into the detail
  view, add the responsive production component, conditionally expose Issues/Discussions/site links, then run
  focused component and browser checks.

Exact next commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe-workers
python3 -m http.server 8766 --directory docs/designs
open http://127.0.0.1:8766/2026-09-08-unclaimed-product-contact.html
git diff -- docs/designs/2026-09-08-unclaimed-product-contact.html docs/CODEX_HANDOFF.md
```

## Existing catalogue restored and independent local crawler activated — 2026-09-08 21:06 KST

- Objective: explain why previously crawled products were absent from the redesigned local page, restore them
  without data loss, verify the independent crawler against the existing DB, and fix the catalogue query that
  could hide seeded products again later.
- Root cause: the accepted redesign at port 43201 intentionally used isolated DB
  `nomorevibe_workers_local_deploy` with one synthetic verified product. The original port-3200 DB still held
  1,118 seeded products, 5,336 crawl documents and all candidate history. Its legacy HTTP scheduler was no
  longer crawling: every request returned 403 because its cron secret differed from the web container.
- Recovery: created `/tmp/nomorevibe-before-worker-split-20260908.dump` (151 MiB, SHA-256
  `8bbb4e26f75988fb840c019410925af8f75f0e156a0c888520a830fe99f831ce`), stopped the old web/scheduler,
  applied additive migrations once, then started the current web and one scheduler/crawler/reviewer/publisher/
  maintenance process each against the preserved `nomorevibe` DB. All six services are healthy at port 3200.
  The temporary secret env file was removed; the rollback dump remains on the host.
- Runtime proof: the DB scheduler requested nine due jobs. The crawler discovered two repositories and fetched
  both. A bounded judge tick classified one as `passed` and one as `no_homepage`; a publisher tick added
  `Dark Factory`. Continuous operation then raised the preserved catalogue from 1,118 to 1,146 seeded products.
  The latest DB snapshot has 1,146 published candidates, 260 `needs_review` candidates and 4,168 rule-rejected
  candidates. All job requested/processed versions match and `last_error` is empty. The obsolete isolated
  web/five-worker set was stopped and removed.
- AI state: collection is enabled, but automatic AI review is effectively `off`; no `CRAWL_REVIEW_MODEL` is
  configured and repository agent-evidence collection is disabled in the preserved settings. Publisher category
  classification attempted Claude and received `Not logged in`, then used the existing deterministic fallback.
  Configure a valid long-lived Claude token/model and verify `observe` results before enabling `enforce`.
- Follow-up code: branch `fix/public-catalogue-home` changes the Recent tab and plain search to query both
  `verified` and `seeded` products and uses the same statuses for category/public totals. This prevents seeded
  products disappearing once verified products exceed the unclaimed-fill threshold. The regression tests were
  observed failing first (3 expected failures), then passed after the minimal fix.
- Actual checks for the follow-up: targeted 1 file/13 tests PASS; full unit 80 files/610 tests PASS;
  nonincremental TypeScript, ESLint, Playwright 6 tests and Docker runner build PASS. Production-mode browser QA
  at port 3200 returned 200 for default/recent views, rendered six initial cards, reported
  `최신 100개 · 공개 1119개`, and had no console/page errors.
- Merge result: PR62 merged as `1d0bdd2c816efeeb252a3f422d1bf36bc0907f10`; Git verified implementation
  commit `f72ec909d9ac486d11737849188d28cb4929d071` is its ancestor. PR checks and post-merge main CI run
  `34223497961` passed typegen, TypeScript, lint, unit, integration and build. The live local page at port 3200
  returns HTTP 200 and all six current services are healthy.
- Remaining: AI review and agent evidence remain intentionally inactive until credentials, model and an
  observed sample are accepted. Publisher category classification currently logs Claude authentication failures
  and uses the deterministic fallback; it does not block rule-approved publication.

Exact next commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe-workers
git diff --check
git status --short
docker compose -p nomorevibe ps
curl -I http://127.0.0.1:3200/
docker exec nomorevibe-db-1 psql -U nomorevibe -d nomorevibe -c "select status,count(*) from products group by status"
docker exec nomorevibe-db-1 psql -U nomorevibe -d nomorevibe -c "select name,requested_version,processed_version,last_error from jobs order by name"
gh run view 34223497961
```

## Port 3200 home redesign applied, verified and merged — 2026-09-08 19:08 KST

- Objective: inspect the home design running on port 3200, apply that design to the clean current-main
  integration without carrying unrelated dirty-worktree changes, verify it locally, and land it after CI.
- Worktree/branch: `/Users/jr/Desktop/projects/nomorevibe-workers`; implementation commit `a4ac7fa` was based
  on `origin/main` at `bc525e9`. Preserve `/Users/jr/Desktop/projects/nomorevibe`; its local main still has
  unrelated uncommitted auth/detail/Compose/design-source files.
- Completed: responsive shared header/footer/mobile navigation, hero, four KST pulse panels and methodology
  dialog, larger project cards, saved-project flow, search/category/builder/repository-link browsing, curated
  AI news, and accurate empty/unclaimed states. The existing worker architecture and product detail remain.
- Accuracy rule: only maker-reported builders reach public view models, cards, builder search/filter options,
  and pulse counts. Crawler guesses remain hidden. Repository URLs are labelled `저장소 있음`, not open source.
  Interest change is exposed only after both completed seven-day windows have been collected; a complete window
  with no rising category is distinguished from collection still in progress.
- Main modified areas: `app/page.tsx`, `app/layout.tsx`, `app/globals.css`, `app/home.css`,
  `components/home/*`, `components/BrowseFilters.tsx`,
  `lib/domain/products/{repository,view,home-pulse,labels}.ts`, `lib/domain/ranking/view.ts`, and corresponding
  unit/integration/E2E tests. Full report: `docs/operations/2026-09-08-home-redesign-qa.md`.
- Actual final tests: unit 80 files/608 tests PASS; integration 49/446 PASS; Playwright 6 PASS;
  nonincremental TypeScript, ESLint, diff check, and Docker runner build PASS. Local production browser QA
  passed all 10 flows in 10 consecutive runs with no console/page/request errors; duplicate builder query
  returned HTTP 200. The fast-navigation hydration reproducer also passed 10 consecutive development runs.
- Local deployment: `nomorevibe-workers-local-app` runs `nomorevibe-web:local-home-qa` at
  `http://127.0.0.1:43201` against `nomorevibe_workers_local_deploy`; five independent worker containers are
  healthy. Keep them running. Port 3200 and its dirty source worktree were not changed.
- Findings fixed during QA: misplaced save control, unranked search miss, duplicate-param 500, non-modal dialog,
  broken card fragment, saved/unclaimed mixing, route-invalid skip link, low BETA contrast, guessed-builder
  exposure, a false category-level unique-visitor description, a mislabeled interest-sort tab, a fast-navigation
  header hydration mismatch, premature interest comparison before two full collection windows, a false collection
  message when no category was rising, and non-repeatable admin E2E cleanup.
- Failed check: the first lint attempt overlapped Playwright deleting `test-results` and got ENOENT. A sequential
  standalone lint run passed. Negative-path unit/integration log messages are expected assertions; both suites
  exited 0. The first E2E after adding the interest-copy assertion raced dialog URL cleanup; waiting for dialog
  close and `metric` removal made the full rerun pass. The first hydration diagnostic used unsupported top-level
  await under the CommonJS loader; wrapping its execution exposed the exact header DOM mismatch. An automated
  full-diff `codex review --base origin/main` inspected the large redesign for more than 30 minutes without
  returning a verdict and was stopped; do not represent that run as a clean review. Manual review found and fixed
  the interest collection-window issue, then the full checks above passed.
- Merge result: PR60 merged to main as `db682a3165cef02e382f2803bf5baaa34e9f6e20`; Git verified implementation
  commit `a4ac7fa711c1133e9554f12a085207931cf5ef29` is its ancestor. PR checks passed, and post-merge main CI run
  `34213468456` passed typegen, TypeScript, lint, unit, integration and build. The first `gh pr merge --delete-branch`
  command exited 1 only because another worktree already had local `main` checked out; GitHub had completed the
  merge before the CLI attempted that local switch.
- Remaining work is production-specific: deployment and a 24-hour external-worker observation remain blocked by
  the P0 target/credential decisions in `PENDING.md`. No production mutation occurred.

Exact next commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe-workers
git fetch origin main
git show --stat --oneline db682a3165cef02e382f2803bf5baaa34e9f6e20
gh run view 34213468456
docker ps --filter name=nomorevibe-workers-local
curl -I http://127.0.0.1:43201/
cat PENDING.md
```

## Local deployment QA and main merge completed — 2026-09-08 17:02 KST

- Objective completed: deployed the stacked worker changes locally, exercised the public/admin/worker paths,
  fixed every blocker found, and merged PR57 and PR58 to remote main after CI succeeded.
- Worktree: `/Users/jr/Desktop/projects/nomorevibe-workers`, branch `feat/independent-workers`.
  Preserve all unrelated uncommitted files in `/Users/jr/Desktop/projects/nomorevibe`; do not reset or merge
  inside that dirty worktree.
- Completed code changes: stale automatic review sources are requeued to `crawl-fetch` after the terminal
  cooldown; successful refetches that change the product URL reset only automatic unpublished candidates
  to `source_changed/new` and request `crawl-judge`; lock order matches scheduler order and lease loss rolls
  back the transaction. The product detail now conditionally renders one compact development-evidence
  section and keeps team information under objective facts.
- Modified code/tests: `app/p/[slug]/page.tsx`, `components/product-detail/{BuildProvenance,ProductFacts}.tsx`,
  `lib/crawl/{agent-review-repository,repository}.ts`, `lib/crawl/jobs/{agent-review,fetch}.ts`, and the
  corresponding unit/integration/E2E tests including the backpressure mock. Final report:
  `docs/operations/2026-09-08-local-deployment-qa.md`.
- Independent read-only review confirmed the three prior blockers are resolved and found no additional
  correctness/security/concurrency merge blocker.
- Actual final tests: `npm test` 78 files/592 tests PASS; `npm run test:integration` 49/445 PASS;
  targeted unit 2/22 plus backpressure 1/2 PASS; targeted integration 2/16 PASS; `npm run test:e2e`
  5 PASS; Next typegen, full nonincremental TypeScript, ESLint and diff check PASS; final worker and web
  Docker target builds PASS.
- Actual local deployment: `nomorevibe-web:local-merge-qa` plus `nomorevibe-worker:local-merge-qa` run at
  `http://127.0.0.1:43201` against isolated DB `nomorevibe_workers_local_deploy`. Web plus five roles are up;
  workers are healthy; all six restart0/OOM0/error-log0. Browser QA passed 20 public/admin flows with no
  console/page/request errors. Authenticated crawl-fetch returned202 and was consumed; all executable job
  requested/processed versions match with empty last_error. Product force refresh requested1/completed1.
- External collection and Claude were deliberately disabled for final local QA; the earlier bounded real
  CLI/sample evidence remains documented separately. This is not a production deployment or 24h proof.
- Failed approaches: the first final unit run failed one test because its complete repository mock omitted
  the new export; the mock was fixed and the full suite rerun. Integration cleanup removed the fixture and
  the old temporary seed imported crawl tables from the pre-split schema; the temporary import was corrected
  and the production-mode browser run then passed. A diagnostic query guessed `job_controls`; the real table
  is `jobs`, and the corrected query showed complete consumption.
- Merge result: PR57 merged as `f6a0d88`; PR58 merged as `8b3a99c`. Git verified final feature commit
  `7384fc4` is an ancestor of `origin/main`. The post-merge main CI run `34202033925` passed typegen,
  TypeScript, lint, unit, integration and build. Keep the final local containers running.
- Remaining work is production-specific: P0 server/domain/DB and long-lived Claude credentials in
  `PENDING.md`, followed by the runbook's deployment and 24-hour observation. No production mutation occurred.

Exact next commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe-workers
git status --short
git fetch origin main
git merge-base --is-ancestor 7384fc49642f4d3beb68443015b675d129fadaf2 origin/main
docker ps --filter name=nomorevibe-workers-local
curl -I http://127.0.0.1:43201/p/local-qa-product
cat PENDING.md
cat docs/operations/independent-workers-runbook.md
```

## Independent worker implementation completed locally — 2026-09-08 15:46 KST

- Latest user authorized parallel implementation, review, fixes and operational verification, with
  essential intermediate tests and comprehensive checks after large phases. PR01–10 code is complete.
- Use `/Users/jr/Desktop/projects/nomorevibe-workers`, branch `feat/independent-workers` for this work.
  Original main's home/auth/UI uncommitted changes are preserved. Do not reset, blanket stage, or merge over them.
- Draft PR58: https://github.com/JRVector9/nomorevibe/pull/58 (new worker implementation).
  Prerequisite draft PR57: https://github.com/JRVector9/nomorevibe/pull/57 (the4existing local commits through9c84bb9).
  PR58 targets review/agent-evidence-foundation; after PR57 lands, retarget58 to main. Neither PR was merged.
- Actual local verification: fullB unit589/integration441; subsequent affected DB28/unit26; finalE2E5,
  cron3 plusrealcontainer400/202, type/lint and web/workerDockerbuilds PASS. Counts are from different phases.
- Real10publicsources allHTTP200; latest .2 allrules needs_review, zero sample publication. CLI authenticated
  structured response succeeded; rules holds are not10AIapprovals. See final report for cost/limits.
- Actual no-web5role30min:1800.307s/31samples allhealthy/restarts0/maxDBconnections5. Externalcollectiondisabled.
  Runtime report integrated070ac57 from agent4865797. Testcontainers exited0; pending/lease/connections/errors0.
- Product1000/click100000/ranking1000, actual recent+weeklyHTML20RPS120s:2400/2400success,p95=33.6ms.
  Not active crawler/LLM capacity or24h assurance. Local acceptanceapp43200 contains testfixtures, not productiondata.
- Reports/runbook/evidence/prompts live under `../nomorevibe-workers/docs/operations/` and its docs/superpowers/plans/.
- Remaining external prerequisites: choose productionserver/domain/DB, configure long-lived ClaudeOAuth,
  deploy with stop/drain→migrationonce→oneofeachrole and observe→enforce, then real24hobservation.
  Read-only Dokploy inventory found no matching project. No production deployment or database reset occurred.
- This handoff update preserves prior entries below. Existing uncommitted original-main files are not in PR58.
- Next agent commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe-workers
git status --short
gh pr checks 58
cat docs/operations/2026-09-08-independent-workers-implementation-report.md
cat docs/operations/independent-workers-runbook.md
# Resolve production target/credentials before deployment. Never enable acceptance fixture publishers.
```

## Independent workers implementation — 2026-09-08 15:42 KST

- Objective: finish approved PR01–10 in parallel through operational readiness. User requests essential
  intermediate checks only, comprehensive verification after large phases, and fixes for discovered failures.
- Integration: `/Users/jr/Desktop/projects/nomorevibe-workers`, `feat/independent-workers`, base9c84bb9.
  Original main worktree has unrelated uncommitted home/auth/UI/Compose changes. Preserve them all.
- Completed PR01–10: DB request versions/leases/schedules; independent 5 roles; GitHub shared cooldown;
  resumable force refresh; queue-only web/cron; role pools and supervised images; immutable review attempts;
  bounded Claude reviewer; current-source publication approval; audited admin mode/decision/recollection.
- Execution prompts: docs/superpowers/plans/2026-09-08-worker-execution-prompts.md.
  Implementation report: docs/operations/2026-09-08-independent-workers-implementation-report.md.
  Runtime acceptance: docs/operations/2026-09-08-worker-runtime-acceptance.md (agent completing).
- Final source fixes through06cfbaa: HTTP rejects scheduler-only heartbeat400 (no consumer), realjobs202; no-first-scan null guard; scan identity advisory lock and scanStartedAt
  source version; completed scan with pending discovery resumes; postgres3.4.9 exact queued cancellation,
  pipeline/BEGIN/connection rotation; graceful leader-only SIGTERM then group cleanup; rules/prompt .2
  deterministically hold missing development evidence before LLM, invalidating mistaken .1 reuse.
- Design: preserve existing handlers/states/SQL queues. Each role singleton; stop/drain before release
  migration and replacement. Web has no CLI. Review off/observe/enforce changes require separate audited
  CAS action and readiness flag. Off removes the gate and is not an automatic rollback. No Redis or
  horizontal worker expansion. Conditional PR11/12 not implemented; no measured need to rewrite home.
- Actual tests: B full unit78files589PASS, full integration49files441PASS; after final evidence/review fixes
  targeted5DBfiles28PASS and3unitfiles26PASS, finalcron3PASS plusactualcontainer400/202. Final Playwright5PASS (product3/admin2), typegen/tsc/lint PASS.
  Final Docker worker+web builds PASS. Do not combine different-stage counts as one final full suite.
  Browser actions: mode changes/admin approval/extra collection/force queue, mobile390 no overflow/JS error.
- Live10: fixed public repos from verify-worker-sample.ts, all pageHTTP200; latest `.2` all rules needs_review,
  zero published sample products, reported historicalAIcost$0.1264348. This is evidence-hold acceptance,
  not 10 successful AI approvals. CLI errors retry rather than reject; actual .1 errors remain history.
  Local container Claude2.1.263/claude-sonnet-5 real auth/structured response passed; smoke1458ms/$0.0070588.
- Capacity: isolated1000products/100000rawclicks; actual click-rollup110ms, ranking-refresh110ms and1000entries
  in2026-W37. Latest Docker web fullresponse20RPS120s:2400/2400HTTP2xx,0errors/skipped,p50=22.7,p95=33.6,
  p99=39.3ms,peakInflight2. Real recent/weeklybody contained fixtures; no rankingfallback/errorpage/logevents.
  VM4CPU7.737GiB,webcap2CPU1.5GiB, other local containers shared. This is not active crawler/LLM capacity.
- Acceptance DB `nomorevibe_workers_acceptance`, no truncation. Root integration DB
  `postgres://nomorevibe:nomorevibe@localhost:55435/nomorevibe_workers_test` (truncating suites must not overlap).
  Agent separate DBs: runtime_test, agent_resume_test, pool_review_test prefixed nomorevibe_workers_/nomorevibe_.
- Local Docker app43200 `nomorevibe-workers-acceptance-app-1` uses synthetic acceptance data. Original
  app3200/DB55437 and devDB55434 unchanged. Do not start acceptance crawler/publisher: it also contains
  reserved.example browser fixtures, including an admin-approved candidate and force refresh request.
- `/root/implement_runtime`: actual no-web5role observation06:10:09.786Z→06:40:10.118Z,1800.307s,
  31samples allhealthy,restarts0,maxDBconnections5. Cleanup06:40:55Z: all5exit0,pending/lease/connections/errors0. Source image original1901c81, gracefulfix verified
  separately mounted supervisor: earlySIGTERM3/3exit0,steadyexit0; staleheartbeat actualrestart30.34s;
  jobhang+SIGTERM-ignoringCLI actualrestart76.165s with group cleanup. Agent commits report+sanitized evidence JSON; its runtime containers are stopped.
  No24h claim from any local check.
- Final images: docker inspect IDs worker0b5a6690306c4179e75c2ca058eda839ae01aa8acbda0389f49efb88bd181cf7,
  web72ee522e36a2fe9efb630572896310916cac282cd75479eaa479178dfab1dc0c; tags
  nomorevibe-worker:workers-acceptance and nomorevibe-web:workers-acceptance.
- `/root/plan_review` owns README/PENDING/.env.example/runbook docs-only update in pool-review worktree,
  integrated as7719471; root owns plan/handoff/report/sample/capacity/E2E. `/root/plan_runtime` final read-only
  review found no new blocker in recent sourcefixes or verification scripts. No extra tests repeated.
- Failed approaches: initialforceclock skew; CLI detached process group; minfont12; wrong lease test expectation;
  Turbopack node_modules external symlink (own npm ci fixed); browser label selector fixed to selectname;
  nonexistent /ranking404 and missingseason fallback load probes excluded, corrected fullpath numbers above.
- Production: async server/domain question still pending. Read-only Dokploy project.all found no matching
  project. No production mutation. Remote main is4commits behind localbase9c84bb9;
  prepare stacked draftPRs foundationreview/agent-evidence-foundation and feat/independent-workers. Long-lived production Claude credential not configured;
  local token is short-lived Keychain accessToken in private/tmp env files. Never print token/config contents.
- Remaining: cherry-pick final runtime docs commit, final report status/artifacts/handoff,
  commit isolated branch, prepare/push reviewable PR without overwriting dirty main, report exact deployment
  prerequisites and remaining24h observation. No repeating whole tests absent changed behavior/failures.

Exact commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe-workers
git status --short
git log -10 --oneline
# Incorporate only the two agents' docs-only commits; inspect each diff.
git diff --check
# Finished verification logs (all exit0):
tail -n 8 /tmp/nomorevibe-workers-e2e-admin-final.log
cat /tmp/nomorevibe-workers-acceptance/capacity-ranking-20rps.json
# Read-only sample report; never prepare/reset existing acceptance DB:
DATABASE_URL=postgres://nomorevibe:nomorevibe@localhost:55435/nomorevibe_workers_acceptance node --import tsx scripts/verify-worker-sample.ts report
```

## Minimal worker refactor design re-review — 2026-09-08 KST

- Current objective: correct the worker architecture report against current code and prevent a
  rewrite-sized implementation. User requested documentation changes only.
- Completed: re-read runtime/cron/admin imports, runner/frontier locks, existing maker refresh,
  force media semantics, rule/review/publish paths and their tests. Revised the existing report:
  `docs/superpowers/specs/2026-09-08-independent-workers-and-capacity-design.md`.
- This revision supersedes the earlier generic work_items/schedules/outbox-first proposal. Preserve
  runJob/JobContext/JobOutcome, jobs cursors, frontier, documents, candidate/product statuses,
  evidence collector, publication transaction, public registration/verify and ranking policies.
- Plan A: independent role processes using one worker image/entrypoint and existing handlers;
  add narrow request-version/schedule/owner-token fields to jobs. Role-specific singleton execution
  first; stop/drain on replacement. Runner tokens alone do not fence all domain writes.
- Plan B: crawler-only AI review with bounded input snapshots in crawl_review_attempts and a separate
  reviewMode off/observe/enforce setting. Preserve candidate states and human decisions. Add approval
  filtering before publish LIMIT and validation inside the existing publication guard.
- Plan C: improve measured bottlenecks only. Redis, generalized queues/outbox/DAG, immutable source
  storage, object-storage migration, universal async APIs, ownership/listing policy changes and
  immediate horizontal worker scaling are deferred, not prerequisite work.
- Important corrections: maker refresh already returns 202; queueMakerRefresh does not force recent
  observed media. Preserve admin force scope through a small product_refresh_requests record and
  resumable progress in the existing evidence job. Admin status imports JOB_NAMES from the executable
  registry; split out metadata so removing cron imports actually separates the web graph. Existing
  guard covers publication-time inputs, not a prior AI review snapshot. Agent evidence enforcement
  is conditional, and the code default is false; live DB settings were not inspected.
- Modified files this phase: the design report and docs/CODEX_HANDOFF.md only. Existing home/auth/UI/
  compose edits and untracked artifacts belong to other work; do not revert or stage them.
- Test actually executed:

```sh
npm test -- tests/evidence-worker.test.ts tests/evidence-scheduler.test.ts tests/agent-evidence-refresh-demand.test.ts tests/crawl-publication-guard.test.ts tests/crawl-publish-evidence.test.ts tests/crawl-agent-input.test.ts tests/agent-evidence-summary.test.ts
```

- Result: 7 files, 25 tests passed, exit 0. HTTP/LLM are mocked. Vite printed a future native-config
  loader compatibility warning; no config changes were made. Integration/build/E2E/load/24h tests
  and live crawler/deployment checks were not run. The integration setup truncates tables and must
  use the dedicated TEST_DATABASE_URL when implementation starts.
- Documentation validation executed: git diff --check for this handoff passed; a read-only check of
  the report/current handoff section passed whitespace, code-fence and placeholder checks. All 10
  referenced test paths and key existing source paths were found. Added idle workerSeenAt separately
  from lock/progress timestamps, and an explicit manual-review stop after the AI attempt cap.
- Failed approach: apply_patch rejected a delete+add targeting the same existing report path before
  mutation. Replaced it with a single update patch. No partial service changes occurred.
- Remaining: user reviews the corrected design; implementation begins only upon a subsequent request.
  Initial server sizes and load targets remain assumptions until measured. Plans A/B/C include
  bounded change lists, preservation criteria, migration and rollback limits.
- Exact next commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
cat docs/superpowers/specs/2026-09-08-independent-workers-and-capacity-design.md
git diff --check -- docs/CODEX_HANDOFF.md
```

## Compact development-clue design — 2026-09-07 KST

- User feedback: development AI is secondary. Hide the section when there is no evidence; when only
  `AGENTS.md`, `CLAUDE.md` or another instruction artifact exists, show only the observed file facts;
  append tool/model details in that same section only when they are supportable.
- Updated `docs/designs/2026-09-06-product-detail-full-redesign.html`. Removed the large dark AI panel,
  the four repeated unknown fields and the third unknown card in the evidence map. Replaced them with
  one compact `개발 지침 파일` row containing `AGENTS.md`, pinned commit, root scope and a concise
  `AI 사용 미확정` explanation.
- Verification: Playwright rendered desktop 1440px and mobile 390px with no console/page errors or
  horizontal overflow. It also asserted the development-clue section is shorter than the repository
  section. Screenshots: `/private/tmp/nomorevibe-detail-full-redesign-compact-ai-{desktop,mobile}.png`.
- Production components remain unchanged; wait for approval of the revised full-page mockup.

```sh
open http://127.0.0.1:8767/2026-09-06-product-detail-full-redesign.html
git diff --check
```

## Full product-detail redesign proposal — 2026-09-07 KST

- Current objective: explain why Drever's development-AI fields are unknown and redesign the entire
  lower product-detail area as an HTML proposal. Production React components were not changed.
- Drever scan 31 completed at pinned commit `502eff05d9b629370b51ee03cafceb571562e3c2`
  without collection issues. It found root `AGENTS.md`, but that catalog rule has `client=null` and is
  compatible with Codex, Kimi, Grok Build, OpenCode, GitHub Copilot, Cursor and Kiro. The parser
  intentionally does not interpret instruction prose as model configuration. No client-specific
  config, selected model, gateway or commit attribution was observed.
- The AI judge also requires a current product-site link back to exactly one matching repository.
  Drever has a repository-to-site homepage link, while its site fingerprint exposed no repository
  key, so the agent relationship remains `unknown`. `summarizeAgentEvidence` therefore returns
  `ai_evidence_insufficient`; `executionVerified` is intentionally always false for static public
  repository evidence.
- Created `docs/designs/2026-09-06-product-detail-full-redesign.html`. It keeps the approved editorial
  hero and redesigns product story, evidence map, development-AI reasoning, repository/languages,
  updates, and ownership CTA. The mock uses the actual Drever snapshot and labels public-page product
  claims separately from externally confirmed facts.
- Verification: static HTML returned HTTP 200 (29,569 bytes); Playwright found all five section IDs,
  verified anchor navigation, no console/page errors, no external requests, and no horizontal overflow
  at 1440px and 390px. Final screenshots are `/private/tmp/nomorevibe-detail-full-redesign-
  {desktop,mobile}-final.png`.
- Failed approach: the first QA one-liner read browser `location` in the Node context. Replaced it with
  `page.evaluate(() => location.hash)` and the verification passed.
- Remaining work: wait for user approval of this complete lower-page direction before changing the
  production components.

```sh
open http://127.0.0.1:8767/2026-09-06-product-detail-full-redesign.html
git diff --check
```

## Product detail editorial redesign COMPLETE — 2026-09-06 23:52 KST

- Current objective: implement the user's selected A (editorial profile) direction on the real
  product detail page. The local app now uses the new layout at `/p/drever`.
- `ProductHero` now renders the first mirrored media item as a large representative screen. When a
  product has no media row, a safe internal `/api/og-cache/...` copy is rendered at full width; only
  products with neither source receive the explicit empty state. Product description, tagline,
  provenance status, health, rank and actions are all visible beside the image.
- The separate duplicate gallery block was removed from the route. Metrics remain directly below the
  hero. The body now uses an editorial story column and an evidence sidebar; mobile DOM order remains
  product screen, description, factual evidence and updates.
- `ProductIntroduction` has the approved PRODUCT STORY hierarchy. Metrics are denser, and the evidence
  summary is shaped for the sidebar. No product facts or proposal-only mockup copy were invented.
- Modified for the implementation: `app/p/[slug]/page.tsx`, `components/product-detail/{ProductHero,
  ProductIntroduction,ProductMetrics,EvidenceSummary}.tsx`, `tests/{product-detail-components.test.tsx,
  e2e/product-detail.spec.ts}`. Design records: `docs/designs/`, `docs/superpowers/specs/
  2026-09-06-product-detail-editorial-design.md`, and `docs/superpowers/plans/
  2026-09-06-product-detail-editorial-implementation.md`.
- TDD evidence: the first component run failed 3 intended assertions; the OG fallback regression then
  failed 1 intended assertion. Final component run passed 16/16. Full unit suite passed 64 files and
  528 tests. TypeScript and ESLint passed.
- Product E2E rebuilt the standalone app and passed 3/3 after the final change, including contrast,
  keyboard target size, mobile reading order, internal image requests, no external provider requests,
  and no horizontal overflow. The build retains the pre-existing Turbopack whole-project tracing
  warning from `lib/crawl/classify.ts`; it is unrelated to this layout.
- Real Drever browser check: `/api/og-cache/drever` rendered at 747.47px wide on a 1440px viewport;
  desktop and 390px mobile had no page/console errors or horizontal overflow. Screenshots:
  `/private/tmp/nomorevibe-drever-editorial-{desktop,mobile}-final.png`.
- Failed approach fixed during verification: relying only on `detail.media` left Drever's large hero
  empty because it currently has only an internal OG copy. The fallback now promotes that safe copy.
- Remaining work: no code work remains for the chosen design. Remote production deployment remains
  governed by the existing P0 decisions in `PENDING.md`.

```sh
npm test -- tests/product-detail-components.test.tsx
npx tsc --noEmit
npm run test:e2e:product
npm test
npm run lint
open http://localhost:3000/p/drever
```

## Product detail A/B HTML concepts — 2026-09-06 23:36 KST

- Current objective: compare two redesigned product-detail directions before changing production UI.
- Created `docs/designs/2026-09-06-product-detail-ab.html` and copied the current Drever OG image to
  `docs/designs/drever-og.png` so the mockup is self-contained.
- Concept A is an editorial product profile with a large thumbnail, expanded product story, compact
  metrics, and a persistent evidence column. Concept B is a visual showcase with a dark image-led
  hero, expanded introduction, workflow sequence, and a quieter evidence timeline.
- The expanded Korean descriptions are proposal copy. The mockup explicitly says production must
  distinguish maker-provided claims from verified public sources.
- Actual application components were not changed. Wait for the user to choose A, B, or a hybrid
  before writing the production implementation plan and editing `app/p/[slug]` components.
- Verification executed: both static assets returned HTTP 200; Playwright opened both concepts at
  1440px and 390px, switched both tabs, found no console/page errors and no horizontal overflow.
  Screenshots are `/private/tmp/nomorevibe-detail-concept-{a,b}{,-mobile}.png`.
- Local preview server: PID 18009, `http://127.0.0.1:8767/2026-09-06-product-detail-ab.html`.

```sh
curl -I http://127.0.0.1:8767/2026-09-06-product-detail-ab.html
open http://127.0.0.1:8767/2026-09-06-product-detail-ab.html
git diff -- docs/designs docs/CODEX_HANDOFF.md
```

## Local crawler scheduler verified — 2026-09-06 23:05 KST

- The existing Docker scheduler is alive and its traditional crawler calls to the isolated Docker
  app (port 3200 / separate DB) return HTTP 200. It was not driving the development DB.
- The prior tool-session processes on port 3000 did not persist after that turn. Replaced them with
  detached local processes: Next dev PID 28962, evidence worker PID 28963, and full crawler
  scheduler PID 28965. PID files and logs are under `/private/tmp/nomorevibe-*`.
- The local scheduler targets `http://localhost:3000` every 60 seconds. Its first actual tick returned
  200 for crawl-fetch, crawl-judge, crawl-publish, crawl-seed, product-evidence-refresh, and
  agent-evidence-refresh. Development DB job rows show fresh `lastSuccessAt`, `lastError=null`, and
  no locks for all six jobs. TradingGoose returned HTTP 200 after startup.
- Keep in mind that the detached evidence worker and the full scheduler both invoke the two evidence
  jobs. DB leases make overlap safe; this is intentional for the user's explicit worker restart, but
  one of them can be removed later to avoid redundant no-op invocations.


## Local processes restarted — 2026-09-06 22:54 KST

- Restarted the latest local Next development server and evidence worker after terminating process
  groups 43023 and 58634 with SIGTERM.
- Next dev process group 99538, application PID 190, next-server PID 213; port 3000 is listening.
- Evidence worker PID 99541; its first cycle completed both jobs successfully. Agent evidence reached
  `done:true` with no error after resuming the stored cursor.
- Actual probes: `/` HTTP 200 and
  `/p/tradinggoose-visual-workflow-platform-for-llm-trading` HTTP 200.
- Current interactive exec sessions: server 28636 and worker 89957. PID files under `/private/tmp`
  were updated to 99538 and 99541. No remote service or Docker service was changed.

## Follow-up recheck and application COMPLETE — 2026-09-06

User requested another check/fix/apply pass. Parallel agents and root fixed additional concrete bugs,
reviewed them, applied the changes locally, and verified runtime continuation. Report:
`docs/reviews/2026-09-06-agent-followup-result.md`.

- Fixed unsaved pre-SHA budget exhaustion: explicit `budget_exhausted`, pending log and unchanged
  pagination cursor. HTTP timeout stays within the remaining deadline.
- Failed private/404/timeout rechecks now retain historical observations while invalidating the
  prior confirmation. Pure budget deferral does not invalidate a successful previous observation.
- Root reproduced four RED cases and fixed stale/future/invalid site timestamps and failed rechecks
  in `lib/crawl/agent-evidence.ts`. Publication repeats timestamp and last-error validation.
- Automatic judge writes now compare candidate/document/settings snapshots under locks. Concurrent
  admin decisions are preserved; explicit pre-existing admin state:new rejudge requests still work.
- Missing archive/fork/relationship values no longer imply active or connected. Recent failed HTTP
  checks no longer show online merely because the three-failure down threshold has not been reached.
- New changes in this pass: `lib/crawl/{agent-evidence,repository,publication-guard}.ts`, jobs/judge,
  agents/{collect,repository}, jobs/products/agent-evidence-refresh, products/detail-view,
  ProductHero/RepositoryEvidence components and their unit/integration regression suites.
- Runtime metadata audit: all 32 repository sources state=ok. Final browser audit: 32/32 products,
  desktop/mobile, 210 immutable citations matched stored visible observations, no JS errors/overflow.
  Agent collection is still in progress; 32 UI passes do not mean all 32 agent scans are complete.
- Worker75975 gracefully terminated and replaced by **58634** with the same command and log:
  `node --import tsx --env-file=.env.local scripts/evidence-worker.ts`,
  `/private/tmp/nomorevibe-evidence-worker.log`. DB cursor resumed from onlycastle/popdict, later
  advanced to rrzu777/agendita; job runs increased from 11 to 13, both lastError=null.
- Explicitly recollected formerly skipped capsule-zero: scan86 complete, no collection issues.
- Tests executed: unit 64 files/526 PASS; E2E production build +3 PASS (11.7s); type/lint/diff PASS.
  Final full integration: 41 files/405 PASS in 41.22s; log
  `/private/tmp/nomorevibe-recheck-integration-verified.log`.
- Failed approaches: initial read-only SQL template had an extra dollar sign; Drizzle query corrected
  it. Browser snapshot changed during active collection; post-browser DB verification confirmed all
  new citations. No service DB corruption or hidden source exposure was found.
- No new migration, commit or remote deploy. Local dev supervisor43023 remains on port3000.
- Required work is complete. Final integration, runtime process and document/diff checks passed.
  Factual unknowns and partial scans remain explicitly labeled; collection continues.

```sh
tail -n 6 /private/tmp/nomorevibe-recheck-integration-verified.log
git diff --check
ps -o pid,etime,command -p 58634
tail -n 15 /private/tmp/nomorevibe-evidence-worker.log
# Current worker PID is 58634; earlier sections below are historical.
```

## Current objective — implementation and live recrawl COMPLETE, 2026-09-06

The user authorized parallel implementation, independent review, restarting collection, and ten real
product checks. The implementation and live checks are complete locally. No commit or remote deploy
was performed. Read `docs/reviews/2026-09-06-agent-implementation-result.md` for the Korean report.

### Completed work and key decisions

- Added versioned artifact catalog, bounded parsers, and separate client/model developer/declared
  model/gateway/role/scope observations for Grok, Kimi, GLM, DeepSeek, OpenRouter and other clients.
  Files, configuration and commit attribution never establish actual execution. Shared formats,
  unknown/auto/inherit and subproject scopes are retained; maker declarations remain separate.
- Migration 0019 adds scans, observations and multi-signal discovery. Collection pins SHA, rechecks
  public visibility on resume, and stores safe projections without credentials, prompts or logs.
- Added repository link synchronization/backfill with generation, current URL and tombstone checks;
  site fingerprints, primary repository selection, source URLs/dates and stale observation labels.
- Added conservative eligibility and transactional publication guards. New admin decisions, source
  edits and settings changes cannot be overwritten by classification or early failure handling.
- Added durable search page/item/attribution cursors, split/incomplete windows, five provider hints,
  partial-first scheduling, bounded scheduler HTTP calls and a standalone evidence worker.
- Independently reviewed and fixed private collection, missing commit enrichment, same-SHA freshness,
  search budget loss, source selection, publication/backfill races and absent recurring collection.
- Backfilled 32 missing links. Ten real products have complete scans and metadata, with 141 facts
  (138 instruction files, 3 client configs). Two site/repository relations are confirmed, eight are
  unknown. No actual execution model is confirmed; none of these ten qualifies for automatic
  publication under the strict gate. Existing published products are preserved.
- Final browser verification passed for all ten products on desktop and 390px mobile: HTTP 200,
  no JavaScript errors or horizontal overflow, visible citations and accurate unknown labels.

### Modified files

- `lib/domain/evidence/agents/*`, `lib/db/agent-evidence-schema.ts`, schema exports,
  `drizzle/0019_agent_evidence.sql` and metadata, package.json/package-lock.json.
- `lib/crawl/{agent-evidence,publication-guard,search-window,github,rules,publish,settings,settings-schema}.ts`,
  `lib/crawl/jobs/{seed,fetch,judge,publish}.ts`, crawl schema reason types and admin status labels.
- `lib/domain/evidence/{repository-link-sync,repository,refresh}.ts`, providers/{github,site-fingerprint}.ts,
  `lib/domain/products/{repository,detail-view,health,health-freshness}.ts`, job registry/agent refresh.
- Product detail page, TrustBadges and BuildProvenance/EvidenceSummary/ProductHero components.
- `scripts/{scheduler.sh,evidence-worker.ts,backfill-agent-evidence.ts,verify-agent-evidence-live.mjs}`;
  new/updated unit and integration suites, README, PENDING, plan, this handoff and review artifacts.
  `git status --short` is the complete inventory; pre-existing uncommitted documents were preserved.

### Tests actually executed

- `npm test`: 63 files, 517 tests passed.
- `npm run test:integration`: final 41 files, 395 tests passed in 45.63 seconds at 09:25 KST.
  Log: `/private/tmp/nomorevibe-agent-integration-final-pass.log`. Two stale search-default
  expectations were corrected after a RED run, then the full suite passed.
- `npm run test:e2e:product`: production build plus 3 tests passed, final run 10.8 seconds.
- `npx tsc --noEmit`, `npm run lint`, `git diff --check` passed; final doc checks are repeated.
- `node scripts/verify-agent-evidence-live.mjs`: ten live products passed after collection fixes.
  TradingGoose screenshot `/private/tmp/nomorevibe-tradinggoose-agent-mobile.png` was opened and inspected.

### Failed approaches and corrections

- Concurrent TDD briefly exposed incomplete seed/UI types. Final targeted and full checks were rerun.
- Maker API test selected an arbitrary source by slug after adding site sources. Exact repository
  identity and deterministic external fixtures fixed the assertion; GitHub facts were preserved.
- Long-running Next dev cached the old Drizzle schema, causing 500 after the new table was accessed.
  Restarting the project development server resolved it; all ten pages subsequently passed.
- TradingGoose HTML was 1,169,782 bytes. Site fingerprint now reads up to 2MiB without truncating
  source-link analysis. Its explicit GitHub repository link confirms the product relation.
- Opanel's 100-release response was 2,800,798 bytes. The collector now requests 10 items, falling
  back to one while preserving pagination offset. The 2MiB transport cap remains unchanged.
- Both products were actually recollected after fixes. Initial failures are preserved in
  `docs/reviews/2026-09-06-agent-live-10-initial.json`; final rows and browser results have separate files.
- Python Playwright was unavailable; installed Node Playwright was used headlessly instead.

### Runtime and rollout

- Development DB: localhost:55434/nomorevibe, `.env.local`. Backup before migration:
  `/private/tmp/nomorevibe-before-agent-evidence-20260906.dump`. Migration 0019 applied successfully.
- Next development supervisor PID 43023, port 3000; log `/private/tmp/nomorevibe-dev-agent-evidence.log`.
  Only the prior project development parent 52359 was stopped.
- Evidence worker PID 75975, running `node --import tsx --env-file=.env.local scripts/evidence-worker.ts`.
  Log `/private/tmp/nomorevibe-evidence-worker.log`; PID file has the same basename plus `.pid`.
  Both jobs succeeded repeatedly with null lastError and saved DB cursors. Default wait is 60 seconds
  between cycles; the process stops when the Mac shuts down.
- Development flags collection/display/enforcement are all enabled. Five provider hints were explicitly
  merged without resetting user queries. General crawler enabled was already true and was preserved.
  The evidence worker does not run the new-candidate publication pipeline.
- Separate Docker app 3200/DB 55437/scheduler image and remote infrastructure were untouched.
  Destructive integration fixtures use only DB 55435.

### Remaining work and exact commands

Final integration and document checks are complete. No required work remains for the user's
ten-product request. Eight unresolved relationships and actual execution models
need stronger public evidence or maker declarations. Arbitrary monorepo scopes and external referenced
files remain outside coverage. The original plan's 50 representative repos, separate audit CLI,
per-task commits and remote deployment were not performed.

```sh
git status --short
tail -n 8 /private/tmp/nomorevibe-agent-integration-final-pass.log
git diff --check
ps -o pid,etime,rss,%cpu,command -p 75975
tail -n 20 /private/tmp/nomorevibe-evidence-worker.log
node scripts/verify-agent-evidence-live.mjs
# Read-only audit:
npx tsx --env-file=.env.local scripts/backfill-agent-evidence.ts --limit 1000
# Restart only if the old worker is no longer running:
node --import tsx --env-file=.env.local scripts/evidence-worker.ts
```

## Current objective — multi-provider agent evidence plan, 2026-09-06

User requested Grok, Kimi, GLM, DeepSeek, OpenRouter and other agent cases be checked, and a
concrete code modification plan reported. This phase is research and planning only, not execution
or deployment. The earlier audits below remain evidence snapshots, not a fresh production check.

- Completed: reviewed official provider/client documentation and current discovery, storage,
  judgement, publication, evidence refresh and provenance presentation code. Produced a Korean
  source-linked detection matrix/design and an implementation plan with Tasks 0–11, exact target
  paths, contracts, regression cases, future commands and rollout criteria.
- Modified files this phase: `docs/superpowers/specs/2026-09-06-agent-evidence-design.md`,
  `docs/superpowers/plans/2026-09-06-agent-evidence-implementation.md`, this handoff.
  Existing uncommitted `docs/reviews/` and prior handoff sections are preserved.
- Decisions: separate client, declared model ID/model developer, API gateway and evidence kind.
  Instruction/config presence is observed, never proof of execution. AGENTS and skills are shared;
  Claude Code may use GLM/DeepSeek/OpenRouter. Grok Build project config has narrower allowed scope
  than user model config. Kimi old/new documentation and Windsurf/Devin paths need versioned rules.
  Keep unknown/auto/inherit/unpublished settings unresolved. Runtime AI features are separate from
  AI-assisted development. Use bounded deterministic parsing, fixed commit SHA, secret-free facts,
  resumable scans and separate automatic observations rather than system provenance replacement.
- Corrected code understanding: maker replaceProductProvenance deletes only maker_reported rows;
  system authority can replace all rows. Do not describe maker edits as deleting every system row.
- Integration priorities: preserve commit trailers/multiple discovery evidence; repair repoUrl/link
  synchronization; implement missing site_fingerprint repositoryKeys writer and source-derived
  relationship/freshness; add explicit eligibility gate; produce dry-run correction rows and
  backfill without reviving maker-hidden/deleted links. Repo homepage alone is insufficient to
  transfer authorship evidence to a product; detached copies remain review candidates.
- Validation actually executed this phase: Python document inspection confirmed all 5 local links
  across the two new documents exist, code fences pair, and neither document has trailing spaces.
  Ran git diff --check with no diagnostics; final check is repeated after this handoff write.
  No new application tests, migration, build, backfill, DB mutation, deployment or commit ran.
  Earlier targeted PASS counts below belong to the previous review, not a new detector.
- Failed/corrected approaches: broad combined web searches often returned irrelevant/dominant
  results; used primary documentation and targeted opens/finds. Guessed Grok agents-md and Goose
  guide URLs failed; followed Grok's official project-rules link and Goose's official repository.
  Draft language inconsistency was corrected before delivery. Long scope strings were changed to
  a scope hash in the planned unique index. Added missing site-to-repository ingestion to Task 8.
- Remaining: all Tasks 0–11 are proposed and unchecked. No cross-provider live detection precision
  is established; implementation must validate synthetic counterexamples and a manually labelled
  real public-repository sample before changing automatic publication. Server deploy remains a
  separate subsequent phase under the prior infrastructure recommendations.

Exact next commands (read the plan before beginning authorized implementation):

```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
cat AGENTS.md
cat docs/superpowers/specs/2026-09-06-agent-evidence-design.md
cat docs/superpowers/plans/2026-09-06-agent-evidence-implementation.md
cat tests/integration/setup.ts
cat node_modules/next/dist/docs/01-app/02-guides/self-hosting.md
git diff --check
```

The new tests/scripts named in the plan do not yet exist. Integration tests must use the separate
55435 test database, never the development database (55434) or local Docker database (55437).

## Current objective — AI eligibility and deployment review, 2026-09-06

User requested a second review of AI-related project detection, a fix list, and an assessment of
web/worker colocation and server sizing before deploying. This supersedes the intervening request
to deploy immediately: report before deployment. Review completed; deployment and fixes remain unperformed.

- Completed: traced discovery → queue → judgement → publication; sampled 100 Claude and 100 Codex
  GitHub search commits; compared canonical sites/repos; replayed 4,652 stored candidates read-only;
  inspected 24h Docker logs, restart/resource settings, database sizes and six resource samples;
  ran targeted unit/integration tests; produced an actionable fix list and deployment recommendation.
- Important findings: judgement has no AI evidence gate. Codex sample has 2/100 results without a
  Codex coauthor line (not an overall false-positive rate). Search evidence SHA/URL is discarded.
  Detached copies of vLLM/Vector pass with zero stars and unrelated canonical homepage. Current
  scheduler only calls the web process; it is not a separate worker. CLI category classification
  failed auth 184 times / 24h, with zero successful classifications. DB restart policy is `no`;
  curl has no total timeout. Uptime 15 targets/10min cannot meet 6h coverage for ~1,006 products;
  measured 479/1,004 checked rows overdue, oldest 11.40h.
- Snapshot: 4,652 candidates / 1,006 published (two new products arrived during the audit).
  Replay flags 12 published items under current rules: 5 placeholder titles, 7 old stored push
  times. These are not 7 confirmed offline sites; fresh metadata/review needed.
- Decisions: retain distinction between AI-made evidence and AI-powered functionality. Unknown
  evidence/relationship should be held for review. Start with same host, separate web/actual worker/
  DB containers; propose 4 vCPU / 8GB / 80GB with external builds and single CLI/image concurrency.
  Sizing is a planning estimate, not a proven capacity. Worker-only API design could be smaller.
- Modified files this phase: `docs/reviews/2026-09-06-ai-crawler-deployment-review.md`,
  `docs/reviews/2026-09-06-ai-crawler-deployment-evidence.json`, this handoff. Prior audit retained.
- Tests executed: unit `crawl-rules`, `classify`, `github-evidence`: 3 files / 64 PASS.
  Dedicated DB 55435 integration `crawl-seed`, `crawl-fetch`, `crawl-judge`, `crawl-publish`,
  `crawl-pipeline`, `crawl-review`: 6 files / 76 PASS. No full suite/build/max-load/reboot test.
- Failed/corrected analysis: initial exact prefix missed `OpenAI Codex`; corrected provider-name
  coauthor-line check yields 98/100. One temporary log-summary JS syntax error corrected and rerun.
- Remaining: implement the report's AI/EV/OP fix list, confirm real provider classification, clean
  existing bad records through review, package actual worker and backfill, then deployment staging
  and reboot/recovery/load validation. No app/dev DB or Docker deployment mutations were made;
  only the explicitly separate integration test DB was reset by existing test fixtures.

Exact next commands:

```sh
git status --short
cat docs/reviews/2026-09-06-ai-crawler-deployment-review.md
cat docs/reviews/2026-09-06-ai-crawler-deployment-evidence.json
cat AGENTS.md
cat node_modules/next/dist/docs/01-app/02-guides/self-hosting.md
npx vitest run tests/crawl-rules.test.ts tests/classify.test.ts tests/github-evidence.test.ts
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@localhost:55435/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/crawl-seed.test.ts tests/integration/crawl-fetch.test.ts tests/integration/crawl-judge.test.ts tests/integration/crawl-publish.test.ts tests/integration/crawl-pipeline.test.ts tests/integration/crawl-review.test.ts
```

## Earlier review context

## Current objective — 2026-09-06 crawler/evidence audit

User asked whether the crawler is running and requested an overall review to show more confirmed
information, using `/p/tradinggoose-visual-workflow-platform-for-llm-trading` on localhost:3000.
The review is complete; implementation and data backfill have not been performed.

- Completed: compared development and Docker DBs/jobs/logs, reproduced public pages with Playwright,
  queried the actual due-product selector read-only, checked TradingGoose's live GitHub APIs/site,
  traced ingestion/read-model/label/scheduler gaps, and documented prioritized remediation.
- Findings: localhost:3000 uses DB 55434 (crawler last ran Aug 18; evidence job never ran).
  Docker localhost:3200 uses DB 55437 and its scheduler is active. Development has 32 repository
  products but zero evidence links; Docker has 1,004 repository products but only one evidence link.
  Publishing/basic registration writes repo_url without linking product_links. Source success does
  not update the link state used by public badges. Old health checks still render as online.
- Modified files: this handoff and `docs/reviews/2026-09-06-crawler-evidence-audit.md` only.
- Decisions: preserve maker/discovered provenance; distinguish observed repository facts, product
  relationship, and mere URL reachability. Do not convert AI authorship inference into verification.
  Review recommends backfill plus ongoing synchronization, consistent source-derived presentation,
  health freshness, shorter worker ticks, and explicit ingestion coverage metrics.
- Tests: `npx vitest run tests/github-evidence.test.ts tests/evidence-links.test.ts tests/product-detail-components.test.tsx`
  executed 2 existing files / 18 tests, all passed. The evidence-links path does not exist and added
  no coverage. Two public browser pages returned 200 with zero pageerrors. GitHub's five read
  endpoints returned 200; website returned 200 after redirect. No integration/full-suite/build run.
- Failed approaches: agbrowse unavailable; browser wrapper's cli.mjs missing. Used installed
  Playwright successfully. Initial enabled-column SQL failed; corrected to values->>'enabled'.
- Remaining: all remediation in the review is proposed, not implemented. No app/DB/scheduler
  mutation, deployment, or commit was made. Existing dev server remains available at port 3000.

Exact next commands (inspection first; test DB must remain separate for any implementation):

```sh
git status --short
cat docs/reviews/2026-09-06-crawler-evidence-audit.md
cat AGENTS.md
rg --files node_modules/next/dist/docs | head -30
sed -n '175,240p' lib/domain/evidence/refresh.ts
sed -n '75,122p' lib/crawl/publish.ts
sed -n '440,490p' lib/domain/products/detail-view.ts
npx vitest run tests/github-evidence.test.ts tests/product-detail-components.test.tsx
```

The implementation history below is retained as historical context; its completion statements do
not establish end-to-end real-data ingestion, as the Sep 6 audit demonstrated.

## Historical implementation context

## Current objective

Execute plan 3, `docs/superpowers/plans/2026-08-19-product-detail-ui-implementation.md`, and show the
finished white-theme, global minimum-13px product-detail screen in the browser.

Plan 2, `docs/superpowers/plans/2026-08-19-product-evidence-pipeline-implementation.md`, is complete.
Plan 3 Tasks 1–8 are implemented, the exact final matrix is green, and the seeded rich product
screen is open from an isolated standalone server. The evidence-based public product page, global
light-first/13 px UI contract, distributable maker-evidence skill, and desktop/mobile Playwright
release contract are complete. The only local follow-up is retrying the independent diff review
after the Codex usage window resets; the attempted review returned no verdict.

## Completed work

Plan 3 commits and completed phases:

1. `6058fa2 test: prepare product detail browser coverage`
2. `e6eeae4 feat: let makers manage product evidence`:
   authenticated/capped profile, link, media, provenance, maker-update, and refresh resource APIs;
   transactional audit writes; asynchronous external-media declarations; maker-update tombstones;
   per-product-generation and optional trusted-proxy IP rate limits; stale in-flight media response
   rejection through declaration ID/revision checks.
3. `85fdb48 feat: administer product evidence`:
   protected `/admin/evidence` settings and `/admin/products/[slug]` evidence controls; safe
   authenticated Server Actions; immutable settings/update audits; explicit maker-versus-observed
   license conflicts; source freshness, media, update, provenance, and audit views; aggregate
   due/stale/failed evidence status; and a production-supported `server-only` boundary marker.
4. `4817b65 feat: compose product detail read model`:
   one server-only public read contract for safe product identity, stored season rank, seven-day
   valid/unique visits, 30-day health, profile, current visible links and evidence, internally
   mirrored media, visible updates, provenance, license comparison, and freshness states. Public
   identity queries explicitly omit verification/edit credentials and reject banned rows; a final
   generation/status check discards data assembled across a concurrent ban or slug replacement.
5. `66eace7 feat: show evidence-based product details`:
   dynamic `/p/[slug]` composition with current rank, seven-day unique/valid visits, health,
   compact evidence summary, internally mirrored gallery, sanitized structured introduction,
   objective links, repository/license facts, agent/skill provenance, freshness, and filterable
   updates. It keeps one mobile reading order, places the same nodes into a two-column desktop grid,
   preserves claim/takedown notices, and adds no phase-2 comment or login surface.
6. `de5306b style: enforce light 13px interface`:
   makes light tokens unconditional while preserving an explicit future dark override and the
   deliberate `.surface-dark` terminal; enforces the 13 px visible-text floor; reduces ordinary
   section radii to 12 px while preserving the 14 px product hero and 10 px metric cards; sets
   product prose to 15 px and structured/update copy to 14 px; adds global keyboard focus and
   reduced-motion behavior; and tests muted-text contrast across every light surface.
7. `edbcfc8 feat: extend nomorevibe evidence skill`:
   adds profile, links, media, provenance, update, and refresh commands without changing existing
   registration/verification/deletion behavior. Every maker replacement first reads a private,
   authenticated merge baseline, previews additions/changes/kept/deleted values, and requires
   confirmation. GET returns a strong content ETag; PUT requires the matching `If-Match` and rejects
   stale replacement with 412 inside the same lifecycle/resource lock. Credential storage is keyed
   by API origin then slug so an untrusted project file or a second registry cannot redirect or
   overwrite an edit token. Provenance remains explicit opt-in, metadata-only, maker-reported, and
   ranking-neutral; Git commit IDs accept full SHA-1 or SHA-256 while content hashes remain SHA-256.
8. Task 8, `docs: release evidence product profiles`:
   adds serial Playwright coverage for rich, collecting, stale/conflict, and unclaimed profiles at
   1440 px and 390 px; proves light mode, 13 px minimum visible text, WCAG AA text contrast,
   approved 14/12/10 px radii, 15 px prose, 14 px structured/update copy, mobile reading order,
   internal-only media, no provider requests, no horizontal overflow, no timeline connector,
   visible keyboard focus, 44 px controls, and no comment surface. Browser QA found and fixed the
   update filters' 36 px hit target by raising it to 44 px. The E2E server runs the same standalone
   production artifact used by deployment.

Task 2 does not add comments, login, reactions, follows, or provider I/O in request handlers.
External gallery URLs are declarations only. The evidence job copies validated bytes into internal
content-addressed storage before any image becomes public.

Plan 2 commits:

1. `ca15631 feat: add product evidence storage`
2. `c03b97a feat: validate product evidence declarations`
3. `f4c47d6 feat: collect GitHub product evidence`
4. `5cf6107 feat: normalize external product updates`
5. `d260126 feat: persist immutable product media`
6. `85dbcbe feat: record product build provenance`
7. `481cab4 feat: refresh product evidence`

The committed pipeline separates maker declarations from observed facts; collects bounded
GitHub/store/package/feed/changelog facts; retains last-known-good values; normalizes immutable
updates; copies validated gallery images into content-addressed PostgreSQL storage; stores optional
agent/skill provenance without affecting ranking; records 30-day health; and runs a bounded
six-hour refresh job.

Task 8 now also:

- deletes product-owned profile/link/source/media/update/provenance/audit, health, click, ranking,
  takedown, OG, and product rows in one transaction;
- preserves shared media bytes until the final relationship is deleted;
- bans/unbans without deleting evidence and audits only a real row transition;
- treats reusable slug and numeric product ID as a generation, validating it under
  `product-lifecycle:<slug>` before evidence, update, media, GitHub, health, status, or delete writes;
- prevents an old GitHub post-refresh schedule and an in-flight uptime response from attaching to a
  same-slug replacement;
- uses one public-IP classifier for declarations, preflight DNS, and connection-time DNS; reserved,
  documentation, benchmarking, multicast, loopback, link-local, and private ranges are rejected;
- caps successful GitHub JSON responses at 2 MiB using declared and streamed byte checks;
- treats malformed percent-encoded release URLs without aborting the whole feed batch;
- stops GitHub release pagination when the job budget expires, keeps the product cursor in place,
  and does not record budget exhaustion as provider failure;
- applies shared 6/12/24/48-hour retry to transient GitHub failure while preserving a real provider
  rate-limit reset timestamp;
- logs unexpected per-product refresh failure as safe `slug` plus normalized `errorCode` only;
- documents tokens, schedule, source semantics, retry/stale behavior, network/media limits,
  PostgreSQL `bytea` capacity/backup impact, and one-product force refresh;
- leaves production scheduler/token checks explicitly unverified in `PENDING.md`, requiring an
  operator to inspect existing schedules before adding missing entries.

## Modified files

Plan 3 Task 4 files:

- `lib/domain/products/detail-view.ts`
- `tests/integration/product-detail-view.test.ts`
- `tests/integration/setup.ts`

Plan 3 Task 5 files:

- `app/p/[slug]/page.tsx`
- `app/p/[slug]/TakedownForm.tsx`
- `components/product-detail/*.tsx`
- `components/product-detail/format.ts`
- `tests/product-detail-components.test.tsx`
- `vitest.config.ts`

Plan 3 Task 3 files:

- `app/admin/AdminNav.tsx`
- `app/admin/evidence/page.tsx`
- `app/admin/evidence/EvidenceSettingsForm.tsx`
- `app/admin/evidence/actions.ts`
- `app/admin/products/ProductRow.tsx`
- `app/admin/products/[slug]/page.tsx`
- `app/admin/products/[slug]/EvidenceProductActions.tsx`
- `app/admin/products/[slug]/actions.ts`
- `app/admin/status/page.tsx`
- `lib/domain/evidence/admin.ts`
- `package.json`
- `package-lock.json`
- `tests/admin-evidence.test.ts`
- `tests/evidence-admin-components.test.ts`
- `tests/integration/evidence-admin.test.ts`

Plan 3 Task 2 files:

- `app/api/products/[slug]/maker-route.ts`
- `app/api/products/[slug]/{profile,links,media,provenance,refresh}/route.ts`
- `app/api/products/[slug]/updates/route.ts`
- `app/api/products/[slug]/updates/[id]/route.ts`
- `drizzle/0015_product_media_declarations.sql`
- `drizzle/0016_light_boomerang.sql`
- `drizzle/meta/0015_snapshot.json`
- `drizzle/meta/0016_snapshot.json`
- `drizzle/meta/_journal.json`
- `lib/db/product-evidence-schema.ts`
- `lib/domain/evidence/maker.ts`
- `lib/domain/evidence/refresh.ts`
- `lib/domain/evidence/repository.ts`
- `lib/domain/media/repository.ts`
- `lib/domain/products/maker-auth.ts`
- `lib/domain/products/manage.ts`
- `lib/domain/products/repository.ts`
- `lib/rate-limit.ts`
- `tests/integration/maker-evidence-api.test.ts`
- `tests/integration/product-evidence-lifecycle.test.ts`
- `tests/integration/setup.ts`
- `tests/maker-evidence-routes.test.ts`

Plan 3 Task 7 files:

- `README.md`
- `app/api/products/[slug]/{profile,links,media,provenance}/route.ts`
- `app/api/products/[slug]/maker-route.ts`
- `app/install.sh/route.ts`
- `app/skill.md/route.ts`
- `lib/domain/evidence/contracts.ts`
- `lib/domain/evidence/maker.ts`
- `lib/domain/evidence/repository.ts`
- `lib/domain/evidence/resource-version.ts` (new)
- `skill/SKILL.md`
- `tests/evidence-contracts.test.ts`
- `tests/integration/maker-evidence-api.test.ts`
- `tests/skill-contract.test.ts` (new)
- `docs/CODEX_HANDOFF.md`

Plan 3 Task 8 files:

- `.gitignore`
- `components/product-detail/UpdateTimeline.tsx`
- `playwright.config.ts`
- `tests/e2e/product-detail.spec.ts` (new)
- `docs/CODEX_HANDOFF.md`

Plan 2 Task 8 commit files:

- `PENDING.md`
- `README.md`
- `docs/CODEX_HANDOFF.md`
- `lib/crawl/github.ts`
- `lib/domain/evidence/contracts.ts`
- `lib/domain/evidence/providers/github.ts`
- `lib/domain/evidence/refresh.ts`
- `lib/domain/evidence/repository.ts`
- `lib/domain/evidence/updates.ts`
- `lib/domain/media/repository.ts`
- `lib/domain/products/health.ts`
- `lib/domain/products/manage.ts`
- `lib/domain/products/repository.ts`
- `lib/jobs/products/evidence-refresh.ts`
- `lib/jobs/products/uptime.ts`
- `lib/net/fetch.ts`
- `lib/net/ssrf.ts`
- `tests/evidence-contracts.test.ts`
- `tests/github-evidence.test.ts`
- `tests/integration/evidence-refresh.test.ts`
- `tests/integration/github-evidence.test.ts`
- `tests/integration/product-evidence-lifecycle.test.ts` (new)
- `tests/integration/uptime.test.ts`
- `tests/ssrf.test.ts`
- `tests/update-events.test.ts`

## Key design decisions

- Product-detail browser coverage builds once and serves `.next/standalone/server.js`, copying
  `public` and `.next/static` into the standalone directory as the production image does. This
  avoids a second `next dev` process and exercises the deployable SSR artifact.
- Browser tests attach request/error observers before navigation and treat any non-local request as
  a failure. Gallery assertions require `/api/media/<hash>`, so rendering cannot silently regress
  to volatile provider URLs.
- Accessibility checks inspect computed, visible text sizes and composite foreground/background
  contrast rather than relying only on source classes. Interactive share, outbound, and update
  filter controls must render at least 44 px high and expose a keyboard-visible outline.
- Comments and unified end-user authentication remain phase two. Task 8 explicitly verifies that
  no comment surface leaked into phase one.
- Maker mutation order is authorization, rate-limit charge, bounded body read, schema validation,
  then transaction. Authenticated malformed and oversized bodies therefore consume quota.
- Rate-limit product identity is immutable `products.id`, not reusable slug. A newly registered
  same-slug generation never inherits the prior owner's exhausted bucket.
- A raw `X-Forwarded-For` header is used only when `TRUSTED_PROXY_HOPS >= 1`. When no trusted
  client address is available, maker routes skip the IP bucket rather than merging every tenant
  into one global `direct` bucket; the product-generation bucket remains mandatory.
- Media declaration rows carry a monotonically increasing revision. The collector captures
  declaration ID/revision before network I/O and revalidates both after the product-media lock,
  preventing removed or edited declarations from publishing a stale response.
- Maker media replacement and collector publication share lifecycle then product-media lock order.
- Two generated additive migrations are retained: `0015` creates declarations and `0016` adds the
  revision used for in-flight compare-and-swap behavior.
- Maker replacement APIs use a strong SHA-256 content ETag over the exact authenticated GET body.
  A valid PUT requires that ETag in `If-Match`; the writer recomputes it after acquiring lifecycle
  then resource advisory locks and returns 412 before any mutation when it is stale. Missing
  preconditions return 428. System-observed provenance does not invalidate or get deleted by the
  maker-only comparison.
- Edit-token credentials are stored as `origin → slug → token`. Project `.nomorevibe.json` data may
  select an already-bound origin/slug pair but can never supply the authenticated destination.
  Legacy unbound credentials are not sent until the user explicitly trusts and migrates them.

- Slug is reusable and is not identity. Long-running work captures `products.id`, then validates
  `(id, slug)` under the lifecycle advisory lock before any write.
- Lock order is lifecycle, product-media, then sorted asset hashes.
- Full maker-authorized deletion physically removes owned data. Ban only changes public eligibility
  and keeps evidence/audit history.
- Network requests stay outside transactions; each completed observation gets a short generation-
  checked transaction.
- Budget exhaustion is control flow, not provider failure. It leaves the source due and product
  cursor unchanged.
- A GitHub rate-limit timestamp is preserved only when the provider actually supplied one; otherwise
  shared attempt-based backoff applies.
- Production evidence scheduling state is unknown until an operator with production access inspects
  the platform schedule and `/admin/status`; missing entries should be added without duplicating
  existing ones.

Plan 3 local Next.js 16 guidance read before implementation:

- Route Handler mutation methods are uncached, dynamic segment params are promises, and generated
  `RouteContext<"/path/[param]">` types are available only after `next typegen`, dev, or build.
- `cookies()` is asynchronous; cookie mutation is limited to Route Handlers or Server Functions and
  must happen before response streaming starts.
- Direct ORM reads belong in Server Components, but authorization still applies. The detail model
  will use request-scoped `React.cache()` for the identity read, then eagerly start independent DB
  reads and await them with `Promise.all`.
- Gallery rendering will use only the internal media route with stored width/height to prevent
  layout shift. Page rendering must not call external providers.

Task 3 administrator boundaries:

- Every page and Server Action authenticates before any evidence read, refresh, setting write, or
  visibility mutation. Page protection is not treated as action protection.
- Force refresh returns only bounded counts and a completion flag; provider bodies and thrown
  errors are never serialized to the browser.
- Automatic update visibility changes run under the reusable-slug product-generation lock and
  append a new audit row. Maker updates remain exclusively controlled by the maker API.
- Admin evidence reads expose only normalized fact subsets and safe error codes. Raw provider
  responses are not part of the read model.
- Admin evidence UI is white-theme compatible, uses reduced 10–12 px radii, and contains no text
  utility below 13 px.

Task 4 public read boundaries:

- `PublicProduct` is an allowlisted projection; public detail code never loads `verifyToken`,
  `verifyMethod`, or `editTokenHash`.
- Evidence sources must still match a visible current product link by slug, kind, and normalized
  key. Removed/replaced repository facts cannot remain public merely because the source row exists.
- Failed refresh state takes precedence over age labels while last-known-good normalized facts stay
  available. Disconnected, collecting, delayed, stale, and current remain distinct states.
- Agent and skill rows are read lock-free and in parallel. Public reads do not enter the writer's
  provenance transaction/advisory lock.
- The first identity read is request-cached for metadata/page reuse; the final uncached allowlisted
  identity read must find the same numeric product ID and a non-banned status before returning.
- Rendering reads PostgreSQL only. It never calls an external provider or serves an external media
  URL.

Task 5 presentation boundaries:

- Only gallery rows already mirrored to `/api/media/<hash>` render as images; stored dimensions,
  eager first image, lazy later images, and last-copy missing-source notices are explicit.
- Markdown skips raw HTML, uses GFM plus sanitization, removes all image nodes, and renders only safe
  HTTP(S)/internal links. Maker Markdown cannot cause third-party image requests.
- Both visible site link and primary action use `/go/[slug]`, so every outbound product visit uses
  the same first-party measurement path.
- Unclaimed crawler content says `자동 감지`/`우리 추정`; claimed maker content says
  `메이커 제공·미검증`/`신고값`. A GitHub-confirmed badge requires parsed observed facts, not just
  a pending or failed source row.
- `validVisits` remains independently measurable before unique-browser collection starts; only
  unique values say `집계 중`, and the valid-visit card states this distinction.
- The timeline filter is the only detail client state besides sharing and takedown. There is no
  connecting vertical line, no comment placeholder, and touched detail text never uses <13 px.

## Test commands and results

Plan 3 Task 2 RED results actually observed:

- initial route tests failed because the maker helper/routes did not exist;
- initial resource integration tests failed because the APIs were absent;
- declared gallery refresh returned `mediaInserted: 0` until declarations joined the evidence job;
- an already-normalized link payload was parsed as a raw declaration twice and returned 500;
- review regressions failed as expected: invalid bodies created no rate row, same-slug replacement
  inherited a 429, and a removed in-flight gallery response was published;
- first GREEN attempt after revision wiring failed with `ReferenceError: sql is not defined`; the
  paused race test then timed out because collection never reached its start signal. Importing the
  existing Drizzle `sql` helper fixed the root cause.

Plan 3 Task 2 final verification actually run:

```text
npx vitest run tests/maker-evidence-routes.test.ts
  PASS — 1 file, 2 tests
npx vitest run --config vitest.integration.config.ts tests/integration/maker-evidence-api.test.ts
  PASS — 1 file, 7 tests
npx vitest run --config vitest.integration.config.ts tests/integration/maker-evidence-api.test.ts tests/integration/product-evidence-lifecycle.test.ts tests/integration/evidence-refresh.test.ts tests/integration/product-media.test.ts
  PASS — 4 discovered files, 36 tests
npx tsc --noEmit
  PASS
npm run lint
  PASS — 0 errors, 0 warnings
git diff --check
  PASS
npx drizzle-kit check
  PASS
```

Plan 3 Task 3 RED/fix history actually observed:

- the first unit and integration runs failed because the new admin pages/domain module did not
  exist;
- after implementation, Vitest could not resolve the documented Next `server-only` marker because
  the package was not installed; `server-only@0.0.1` was added as a production dependency and the
  client component test mocked its Server Action boundary;
- the first evidence-admin integration run had two real failures: audit assertions depended on
  unspecified row order, and a raw Drizzle SQL template bound a JavaScript `Date` where the
  postgres driver required a serialized timestamp. The test now orders audit IDs explicitly and
  the query binds an ISO string cast to `timestamptz`.

Plan 3 Task 3 final verification actually run:

```text
npx vitest run tests/admin-evidence.test.ts tests/evidence-admin-components.test.ts
  PASS — 2 files, 7 tests
npx vitest run --config vitest.integration.config.ts tests/integration/evidence-admin.test.ts
  PASS — 1 file, 4 tests
npx vitest run --config vitest.integration.config.ts tests/integration/evidence-admin.test.ts tests/integration/product-evidence-lifecycle.test.ts tests/integration/product-evidence-repository.test.ts tests/integration/evidence-refresh.test.ts tests/integration/product-evidence-schema.test.ts tests/integration/product-media.test.ts tests/integration/maker-evidence-api.test.ts tests/integration/github-evidence.test.ts
  PASS — 8 files, 62 tests
npx tsc --noEmit
  PASS
npm run lint
  PASS — 0 errors, 0 warnings
npm run build
  PASS — Next.js 16.3.1; `/admin/evidence` and `/admin/products/[slug]` dynamic
git diff --check
  PASS
```

Plan 3 Task 4 RED/fix history actually observed:

- the first target run failed because `lib/domain/products/detail-view.ts` did not exist;
- the first implementation passed once, then the immediate rerun hit duplicate `product_health`
  rows because shared `resetTables()` omitted that table; adding it to the common TRUNCATE restored
  isolation;
- first review regressions reproduced five failures: credential-bearing/banned full product rows,
  orphaned evidence winning over the current link, failed sources shown as collecting/stale, and a
  public provenance read blocked on the writer advisory lock;
- the next review found a concurrent-ban/generation race and a timing-based 250 ms lock test that
  could flake. A deterministic mocked first identity read reproduced the race; the implementation
  now does a final uncached same-ID/non-banned projection. The lock test now spies on the initialized
  Drizzle transaction method instead of comparing wall-clock duration;
- the first concurrent-ban test double returned a Promise where Drizzle's `findFirst` signature is
  a thenable query, so runtime tests passed but `tsc` failed. The cast is now isolated at the test
  double boundary and the full target/type checks pass.

Plan 3 Task 4 final verification actually run:

```text
npx vitest run --config vitest.integration.config.ts tests/integration/product-detail-view.test.ts
  PASS — 1 file, 9 tests; repeated in a separate process
npx vitest run --config vitest.integration.config.ts tests/integration/product-detail-view.test.ts tests/integration/clicks.test.ts tests/integration/uptime.test.ts tests/integration/ranking-view.test.ts tests/integration/product-provenance.test.ts tests/integration/product-updates.test.ts
  PASS — 6 files, 84 tests
npx tsc --noEmit
  PASS
npm run lint
  PASS — 0 errors, 0 warnings
git diff --check
  PASS
```

Plan 3 Task 5 RED/fix history actually observed:

- the component target initially was not discovered because the unit config matched only `.test.ts`;
  the include now supports both `.test.ts` and `.test.tsx`, after which missing components produced
  the intended RED;
- two first assertions were incorrect: a legitimate measured `validVisits: 0` was treated as a
  false zero, and `border-line` was mistaken for a vertical `border-l` utility. The contracts now
  inspect the correct semantics/source pattern;
- first review found five P2s. Four reproduced as RED: crawler content labeled as maker-provided,
  GitHub confirmation on an unobserved source, external Markdown image requests, and the displayed
  site URL bypassing `/go`. The fifth was resolved as a documented domain distinction: valid visits
  predate unique-visitor collection and a real zero remains visible with an explanatory note.

Plan 3 Task 5 final verification actually run:

```text
npx vitest run tests/product-detail-components.test.tsx tests/schema.test.ts
  PASS — 2 files, 20 tests
npx vitest run --config vitest.integration.config.ts tests/integration/product-detail-view.test.ts
  PASS — 1 file, 9 tests
npx next typegen
  PASS
npx tsc --noEmit
  PASS
npm run lint
  PASS — 0 errors, 0 warnings
npm run build
  PASS — Next.js 16.3.1; `/p/[slug]` dynamic
git diff --check
  PASS
```

`npx drizzle-kit generate` created `0016_light_boomerang.sql`; `npx drizzle-kit migrate` applied
the declaration revision to the local integration database. No production database was accessed.

RED regressions actually observed during Task 8/review:

- delete left product evidence/health rows; ban did not audit;
- stale delete/status and in-flight generic/GitHub work mutated a same-slug replacement;
- reserved/non-global IPs passed runtime/declaration checks;
- declared and streamed oversized GitHub JSON parsed successfully;
- malformed percent encoding threw `URIError`;
- GitHub release pagination ignored job budget;
- transient/rate-limit-without-reset GitHub failures bypassed shared backoff;
- budget exhaustion was persisted as transport failure and advanced the cursor;
- in-flight uptime wrote replacement health;
- unexpected product refresh failure had no safe diagnostic log.
- a deletion authorized before an admin ban could erase the subsequently banned product;
- repeated status transitions created duplicate audit rows.

Final focused verification actually run:

```text
npx vitest run tests/ssrf.test.ts tests/evidence-contracts.test.ts tests/github-evidence.test.ts tests/update-events.test.ts
  PASS — 4 files, 54 tests
npx vitest run --config vitest.integration.config.ts tests/integration/github-evidence.test.ts tests/integration/evidence-refresh.test.ts tests/integration/uptime.test.ts
  PASS — 3 files, 40 tests
npx vitest run --config vitest.integration.config.ts tests/integration/product-evidence-lifecycle.test.ts
  PASS — 1 file, 8 tests
npx tsc --noEmit
  PASS
npm run lint
  PASS — 0 errors, 0 warnings
git diff --check
  PASS
```

Final full matrix actually run on the current code:

```text
npx next typegen
  PASS
npx tsc --noEmit
  PASS
npm test
  PASS — 31 files, 293 tests
npm run test:integration
  PASS — 31 files, 319 tests
npm run lint
  PASS — 0 errors, 0 warnings
npm run build
  PASS — Next.js 16.3.1; `/p/[slug]` and `/api/media/[hash]` dynamic
sh -n scripts/scheduler.sh
  PASS
git diff --check
  PASS
npx drizzle-kit check
  PASS
```

Expected suite output: the existing Vitest native config-loader warning and intentional error logs
for invalid ranking policy, job failures, and registration rollback. All suites exited zero.

Local development database state:

- Before migration check: evidence tables `0/4`.
- `npx drizzle-kit migrate`: PASS; additive migrations applied successfully.
- After migration: evidence tables `4/4` (`product_profiles`, `product_evidence_sources`,
  `media_assets`, `evidence_settings`).
- No production database was accessed.

## Review and failed approaches

- The first Task 2 review found one P1 and three P2s: a global `direct` IP bucket, invalid-body
  quota bypass, slug-keyed generation collision, and stale in-flight media publication. All four
  were reproduced in RED integration tests and fixed as described above.
- Three bounded read-only Codex re-review attempts did not return a final verdict: the first two
  spent their three-minute windows loading the full review workflow and re-reading/rerunning broad
  checks; the third focused run read the intended files but its final output was not returned by the
  CLI wrapper before process exit. None is claimed as CLEAN. The repository was not modified by
  these review attempts. A manual final diff inspection found no remaining instance of the four
  reproduced regressions.
- Task 3's first read-only `codex review --uncommitted` reran the 7 unit tests, 4 integration tests,
  TypeScript, focused ESLint, and the production build successfully, but spent the rest of its
  three-minute bound reading the broad review workflow and returned no final verdict. A second
  `gpt-5.6-sol` high-effort focused read-only run inspected only the Task 3 boundaries but again
  reached the bound without writing its requested last-message file. Neither attempt is claimed
  as CLEAN, and neither modified the repository.
- Task 4's first focused review returned two P1 and three P2 findings: secret/banned product row
  exposure, orphaned evidence, failed-state precedence, and the locking sequential provenance read.
  All were reproduced before fixes. Re-review found two P2s—the concurrent ban/generation race and
  a 250 ms test oracle—and both were reproduced or replaced with deterministic checks. Final narrow
  re-review returned `CLEAN`; its own target test could not start in the read-only sandbox because
  Vitest could not create a temporary directory, so no reviewer-run test pass is claimed.
- Task 5's first focused review found five P2s. Four were fixed after RED reproduction; the
  collecting-valid-visits concern was reconciled with the independent click-event contract and the
  UI now explains it. Narrow re-review returned `CLEAN`. Both Task 5 review sandboxes were unable to
  create Vitest's temporary SSR directory, so no reviewer-run test pass is claimed.
- Task 6's first review found one P2: unconditional light mode made 13 px muted text only 4.14:1
  on `--bg-soft`. A RED contrast test reproduced it; `--text-3` changed from `#6b7488` to
  `#636d80`, giving at least 4.60:1 across `--bg`, `--bg-soft`, and `--bg-card`. Final review
  returned `No actionable defects were found` and independently reran unit tests, lint, build,
  and diff checks successfully.
- The first Task 6 review invocation tried to combine `--uncommitted` with a positional prompt and
  failed immediately because this CLI rejects that combination. Bare `codex review --uncommitted`
  worked. Its optional browser probe could not launch Chromium in the review sandbox because the
  macOS Mach rendezvous port was denied; browser coverage remains Task 8 and no browser pass is
  claimed here.
- Task 7 review iterations found and fixed: 40-character Git SHA-1 rejection; omitted maker license
  payload; replacement PUTs without a server baseline; unsupported non-GitHub repository proposals;
  project-controlled credential destinations; stale product-generation reads; unserialized
  provenance baselines; maker/system provenance identity collisions; same-slug credentials
  colliding across API origins; and finally GET-to-PUT stale replacement. The final P1 was
  reproduced with all four resources before adding ETag/`If-Match` compare-and-swap.
- The first Task 7 concurrency regression held a PostgreSQL advisory lock but released it after an
  assertion. When that assertion failed, the test process waited indefinitely. Only the matching
  Vitest processes were terminated; the fixture now releases the lock in `finally` before asserting
  the result.
- A Task 7 review-side `npm test -- --runInBand` attempt failed because Vitest does not support that
  Jest option. The reviewer then ran the correct `npm test` command and it passed.
- The post-P1 Task 7 Codex re-review could not start because the CLI account reported its usage
  limit and asked to retry after 12:30 PM. It is not claimed as CLEAN. The corrected diff was
  manually traced across all four GET/PUT bodies and lock boundaries, and the regression plus full
  matrix below passed; Task 8 must run a fresh complete-diff independent review when capacity is
  available.
- Running two integration Vitest processes in parallel against the same database made each process
  truncate the other's fixtures, causing false missing-row/duplicate-singleton failures. Related
  integration tests are intentionally run sequentially from here onward.
- The first Task 3 review command tried to combine this CLI build's `--uncommitted` flag with a
  positional prompt and failed immediately because that combination is rejected despite the help
  usage text. The retry used the supported bare `--uncommitted` form.

- The installed gstack `/review` workflow cannot run because
  `.agents/skills/gstack/review/checklist.md` is absent.
- Exact `gpt-5.6` is unsupported by this account; read-only reviews used supported
  `gpt-5.6-sol`.
- Two broad complete-diff reviews exceeded the three-minute bound without verdict and were
  interrupted; they are not claimed as passes. The same full scope was then split into storage/
  contracts, providers/media, provenance/jobs, and lifecycle/docs boundaries.
- Split reviews found all P2s listed in RED history. Each was reproduced before implementation.
  Provider/media and provenance/job re-reviews returned `CLEAN`; focused lifecycle generation
  re-review also returned `CLEAN`. The last lifecycle/docs review then found a P1 ban/delete race,
  a P2 duplicate status audit, and contradictory production-schedule claims; all three were fixed
  after RED reproduction. The final narrow re-review returned `CLEAN`.
- A historical storage review reported missing deletion cleanup, but the current Task 8 lifecycle
  transaction and eight regression cases supersede it. Its hostname-only SSRF concern was refined
  into the real runtime reserved-range gaps and fixed at the shared classifier.
- First force-refresh documentation used top-level await and failed under `tsx -e` CJS transform.
  The promise form succeeded against the test database for a missing slug.
- A real `.env.local` force-refresh probe produced no output and was terminated; no live provider
  success is claimed.
- The first ban/delete regression fixture omitted its referenced `media_assets` row and failed on
  the foreign key before exercising deletion. Adding only the missing fixture row exposed the
  intended `true`-instead-of-`false` deletion failure.
- The first `impeccable` helper lookup used its documented project-local `.Codex/...` path, which is
  absent here. The installed global helper reported `NO_PRODUCT_MD`; `PRODUCT.md` was then derived
  from the already approved detail specification before resuming Plan 3.
- Task 8's first Playwright server used `next dev` and failed before tests because the user's
  existing development process already held this repository's Next lock. That process was left
  untouched; the browser suite now builds and serves an isolated standalone artifact on port 43127.
- The first contrast RED came from the test helper compositing opaque ancestor backgrounds in the
  wrong order, not the UI. Correcting the compositor exposed the actual UI RED: update filter
  buttons were 36 px high. They are now 44 px and covered at both viewport sizes.
- A programmatic `.focus()` check did not activate the browser's `:focus-visible` state. The test now
  starts from the document and uses real Tab navigation until the share control receives focus.
- An intermediate E2E server used `next start`, which passed but warned that standalone output must
  use `.next/standalone/server.js`. The final server follows that deployment contract and the full
  three-case browser suite passed again.
- The required final `codex review --uncommitted` reached the CLI but exited immediately because the
  account usage limit had been reached; it requested a retry after 12:30 PM. No Codex verdict or
  reviewer-run test result is claimed. A manual read of the five-file Task 8 diff found no P1/P2,
  but the independent review remains an explicit follow-up rather than being relabelled CLEAN.

## Task 6 verification

```text
npx vitest run tests/ui-contract.test.ts
  RED — 1/5 failed before the contrast fix; #6b7488 on #f7f8fb was 4.415:1
  PASS — 1 file, 5 tests after the fix
npm test
  PASS — 36 files, 316 tests
npx next typegen
  PASS
npx tsc --noEmit
  PASS
npm run lint
  PASS — 0 errors, 0 warnings
npm run build
  PASS — Next.js 16.3.1; /p/[slug] remains dynamic
git diff --check
  PASS
codex review --uncommitted
  CLEAN — No actionable defects were found
```

## Task 7 verification

RED failures actually observed during Task 7/review:

- missing distributed skill contract and command documentation;
- full Git SHA-1 rejected and maker license absent from the profile proposal;
- merge-ready GET endpoints absent, non-GitHub repository proposal allowed, and replacement capable
  of erasing unknown current fields;
- project-controlled API destination could receive a global edit token;
- replacement-generation reads, provenance read serialization, and stronger retained skill identity
  preservation failed;
- credentials keyed only by slug collided across API origins;
- authenticated GET returned no ETag and a stale second full-replacement PUT overwrote the first.

Final verification actually run on the current Task 7 code:

```text
npx vitest run tests/skill-contract.test.ts tests/evidence-contracts.test.ts
  PASS — 2 files, 39 tests (before the final ETag regression; final skill target: 8/8)
npx vitest run --config vitest.integration.config.ts tests/integration/maker-evidence-api.test.ts tests/integration/product-provenance.test.ts
  PASS — 2 files, 14 tests before the final ETag regression
npx vitest run --config vitest.integration.config.ts tests/integration/maker-evidence-api.test.ts -t 'rejects stale merge-and-replace writes'
  RED — GET ETag missing
  PASS — 1 passed, 11 skipped after the fix
npx vitest run --config vitest.integration.config.ts tests/integration/maker-evidence-api.test.ts
  PASS — 1 file, 13 tests after the fix
npm test
  PASS — 37 files, 324 tests
npm run test:integration
  PASS — 34 files, 345 tests
npx next typegen
  PASS
npx tsc --noEmit
  PASS
npm run lint
  PASS — 0 errors, 0 warnings
npx tsx -e 'import("./app/install.sh/route.ts").then(async ({GET}) => { process.stdout.write(await (await GET(new Request("https://registry.example/install.sh"))).text()); })' | sh -n
  PASS
npm run build
  PASS — Next.js 16.3.1; maker evidence routes and `/p/[slug]` remain dynamic
git diff --check
  PASS
```

Expected suite output remains the existing Vite native config-loader warning and intentional
failure-path logs. No test command above is claimed beyond the result actually observed.

## Task 8 verification

Fixtures and screenshots:

- `e2e-rich`: complete objective repository/license facts, seven-day unique/valid visits, internal
  gallery, maker/automatic updates, agent and skill provenance;
- `e2e-collecting`: explicit collecting/empty media and repository states;
- `e2e-stale-conflict`: explicit stale, disconnected, down, and license-conflict states;
- `e2e-unclaimed`: explicit unclaimed and missing maker introduction states;
- desktop screenshot: `/private/tmp/nomorevibe-product-rich-desktop.png` at 1440 px;
- mobile screenshot: `/private/tmp/nomorevibe-product-rich-mobile.png` at 390 px.

Both screenshots were opened and visually inspected after the passing run. The desktop is a white
two-column evidence profile with reduced radii and card-based updates without a left connector. The
mobile page has no horizontal overflow and follows gallery → introduction → facts → repository /
license → provenance → freshness → updates after the hero, metrics, and evidence summary.

After the release commit, an isolated standalone server was started at
`http://127.0.0.1:43128/p/e2e-rich` against the seeded test database. A direct HTTP probe returned
200 and the URL was opened in the user's macOS browser. The user's existing port-3000 development
server was not stopped or modified. The standalone process is a local session, not a durable deploy.

Final matrix actually executed on the Task 8 code:

```text
npx next typegen
  PASS
npx tsc --noEmit
  PASS
npm test
  PASS — 37 files, 324 tests
npm run test:integration
  PASS — 34 files, 345 tests
npm run test:e2e:product
  PASS — 3 tests in 9.1s using the final standalone server
npm run lint
  PASS — 0 errors, 0 warnings
npm run build
  PASS — Next.js 16.3.1; `/p/[slug]` remains dynamic
git diff --check
  PASS after the Task 8 handoff update
```

The E2E assertions cover computed minimum font size, light color scheme, exact radius/type scale,
WCAG AA text contrast, 44 px controls, keyboard focus, descriptive/internal media, update filters,
mobile order, no overflow, no external provider requests, and no console/page errors. The expected
build-time `NO_COLOR`/`FORCE_COLOR` warnings remain non-failing.

## Remaining work

- After the Codex usage window resets, rerun the independent diff review and fix any actionable
  P1/P2 through RED tests; the current attempt returned no verdict.
- Comments and unified end-user authentication remain phase-2 design only; no comment persistence,
  reactions, follows, or login integration belongs in phase 1.

External blockers remain in `PENDING.md`: category classification API verification and production
scheduler/provider-token verification, production `VISITOR_HASH_SECRET` activation, and real-source
smoke checks. Do not claim any complete without external access.

## Exact commands for the next agent

```sh
git status --short
cat docs/superpowers/plans/2026-08-19-product-detail-ui-implementation.md
git diff --check
codex review --uncommitted
# if review finds P1/P2: add a RED regression, fix, and rerun the relevant target plus full matrix
```

# 2026-09-09 Publisher category expansion and Codex classifier

## Current objective

Apply the measured category expansion and publisher classifier choice: add Games and a broader product taxonomy,
use `gpt-5.3-codex-spark` xhigh first with a `gpt-5.6-terra` high fallback, preserve the independent Claude review
worker, and integrate the finished change without losing the dirty main worktree.

## Completed work

- Expanded the accepted product taxonomy from 5 to 17 values and added Korean labels. The database column is an
  unconstrained `varchar(40)`, so no migration or stored-value rewrite is required.
- Replaced per-product Claude category calls with Codex batches of at most 10. Spark xhigh has an 8-second deadline,
  Terra high has a 12-second deadline, and complete CLI failure returns nulls for the existing rule fallback.
- Added strict structured output, exact numeric-ID set validation, input-order restoration, output caps, process
  termination on timeout/overflow, isolated Codex configuration, and escaped untrusted product JSON.
- Preserved publication race protection by carrying the pre-classification document/settings/evidence snapshot into
  the insert transaction and comparing it after the model call.
- Expanded the keyword fallback, including explicit playable-game detection, wedding/Lifestyle handling, and the
  game-server/Dev exception.
- Added `scripts/codex-auth.sh`. Publisher authentication prefers `CODEX_ACCESS_TOKEN`, tries `OPENAI_API_KEY` when
  access-token login fails, removes raw secrets before exec, and leaves the worker running for rule fallback if login
  is unavailable. Reviewer continues to receive only `CLAUDE_CODE_OAUTH_TOKEN`.
- Pinned Codex CLI `0.153.4` and Claude Code `2.1.263` in the worker image. Publisher gets a 120-second cooperative
  budget below its 180-second supervisor hard timeout so a 20-second model fallback does not repeatedly classify a
  batch while publishing only its first rows.
- Updated the distributed registration skill and operations documentation to use all 17 accepted categories.

## Modified files

- Runtime/domain: `.env.example`, `Dockerfile`, `compose.yml`, `lib/crawl/classify.ts`,
  `lib/crawl/jobs/publish.ts`, `lib/crawl/publish.ts`, `lib/domain/products/schema.ts`,
  `lib/domain/products/labels.ts`, `scripts/codex-auth.sh`, `scripts/worker.ts`, `skill/SKILL.md`.
- Tests: `tests/classify.test.ts`, `tests/codex-auth.test.ts`, `tests/schema.test.ts`,
  `tests/home-pulse.test.ts`, `tests/skill-contract.test.ts`, `tests/worker-runtime.test.ts`,
  `tests/integration/crawl-publish.test.ts`, `tests/integration/review-publication-gate.test.ts`.
- Documentation: `README.md`, `PENDING.md`, this handoff, `docs/operations/independent-workers-runbook.md`,
  `docs/operations/2026-09-08-independent-workers-implementation-report.md`,
  `docs/operations/2026-09-08-local-deployment-qa.md`, and
  `docs/operations/2026-09-08-publisher-category-classification.md`.

## Key design decisions

- Keep existing English category keys and only add values; Korean labels remain presentation data.
- Use one batch per publication selection because measured CLI startup/context cost dominates the small product input.
- Adopt Spark xhigh because it agreed with Terra xhigh on 21/22 sampled records while the two measured batches were
  roughly twice as fast. Use Terra high as the API-key-capable availability fallback.
- Category classification remains non-blocking. AI review approval remains a separate blocking publication policy.
- Keep all tool access disabled for classification. Inspection of Codex `rust-v0.153.4` confirmed shell tool
  registration requires `Feature::ShellTool`; `features.shell_tool=false` prevents both one-shot and unified exec.

## Test commands and results

```text
npm test
  PASS — 82 files, 623 tests on the final code
npm run test:integration
  PASS — 49 files, 450 tests after repairing the separate review-gate module mock
npx tsc --noEmit
  PASS on the final code
npm run lint
  PASS — 0 errors/warnings on the final code
npm run build
  PASS — Next.js 16.3.1 on the final code
npm test -- tests/codex-auth.test.ts
  RED for CODEX_CLI override, then PASS — 2 tests
  RED for expired access token plus valid API key, then PASS — 2 tests
npm test -- tests/skill-contract.test.ts tests/worker-runtime.test.ts
  RED — stale five-category skill contract and missing publisher budget
  PASS — 2 files, 17 tests after both fixes
npm run test:integration -- tests/integration/review-publication-gate.test.ts
  PASS — 1 file, 6 tests after adding the batch mock
docker compose config --quiet
  PASS
docker compose build publisher
  PASS on final code — image includes Claude Code 2.1.263 and codex-cli 0.153.4
docker run --rm --entrypoint sh nomorevibe-worker:local scripts/codex-auth.sh codex --version
  PASS — codex-cli 0.153.4
node --import tsx -e '<actual classifyCategories smoke>'
  PASS — actual Spark path returned Lifestyle for wedding and Games for playable puzzle
```

Expected Vitest failure-path logs and the existing Vite native-config-loader warning remain non-failing.

## Failed approaches

- The first full integration run failed 4/450 because `review-publication-gate.test.ts` fully mocked the old classifier
  export and omitted `classifyCategories`. The production path was not failing; the mock was updated and the full
  integration suite then passed 450/450.
- A `codex review --uncommitted` run re-executed unit, integration, build, image, and upstream CLI-source checks but
  did not produce a final verdict after an extended investigation, so it was terminated. Its concrete discovery was
  the stale five-category `skill/SKILL.md`; a RED contract test now covers that. Upstream source inspection also
  confirmed the shell isolation flag instead of leaving that as an assumption.
- Per-product Spark calls were rejected after a single sample took 4.275 seconds and 6,889 tokens. Batch calls are the
  adopted path.

## Remaining work

- The feature is committed on local `main`, one commit ahead of `origin/main`. The root worktree was first
  fast-forwarded from `9c84bb9` to `b220e93`, then the feature commit was cherry-picked. The pre-existing local
  design/login work was restored as uncommitted work. Conflicts were older versions of changes already merged into
  upstream, so the newer upstream versions were retained; non-conflicting local files and edits were preserved.
  `stash@{0}` (`pre-category-integration-2026-09-09`) remains as a safety copy.
- Root integration checks: `npm test` PASS — 83 files/628 tests; focused category/auth/detail checks PASS — 8
  files/73 tests; `npx tsc --noEmit --incremental false` PASS; production build PASS. The first build failed because
  macOS created `.next/standalone/node_modules/.DS_Store` while Next was removing that generated directory; moving
  only that metadata file to `/tmp` and rerunning the same build passed. `npm run lint` sees the restored untracked
  standalone concept at `nomorevibe-final/` and fails on its CommonJS fixture; linting the application with
  `--ignore-pattern nomorevibe-final` PASS. `git diff --check` PASS.
- Local runtime applied: built `nomorevibe-web:category-c0d4287` and
  `nomorevibe-worker:category-c0d4287`, stopped/drained only app and publisher, ran the migration command
  successfully, and recreated those two services. Port 3200 returns HTTP 200; app and publisher are healthy with
  restart count 0; the existing scheduler/crawler/reviewer/maintenance stayed up. Rendered HTML contains the new
  Games/Business/Marketing/Data/Security/Sports labels. Every job row has matching requested/processed versions and
  an empty `last_error`. The publisher contains codex-cli 0.153.4 but reports `Not logged in` because neither Codex
  credential is configured, so runtime classification currently uses the deterministic rule fallback.
- Controlled publisher verification requested `crawl-publish` version 60 against the existing local queue. It
  completed version 60 with no `last_error` in 93.163 seconds, published 17 candidates and skipped one missing a
  description. Spark xhigh timed out for batches of 9 and 8, Terra high also timed out for both batches, and the
  deterministic fallback produced 16 `Other` plus one `Security`. This proves the publication loop works but is
  not evidence of a successful Spark classification; inject `CODEX_ACCESS_TOKEN`, recreate publisher, and require a
  `crawl.classified` event naming `gpt-5.3-codex-spark` before claiming Spark is active.
- Production remains blocked by `PENDING.md` P0: target server, domain, PostgreSQL, secret store, publisher Codex
  credential, reviewer Claude credential/model, and a real 24-hour observation are not configured. Existing stored
  products were not bulk-reclassified; the new taxonomy applies when the publisher classifies new candidates.

## Exact commands for the next agent

```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short --branch
git log -2 --oneline
git stash list | head -n 3
git diff --check
npm test
npx tsc --noEmit --incremental false
npm run lint -- --ignore-pattern nomorevibe-final
npm run build
docker compose -p nomorevibe ps
curl -I http://127.0.0.1:3200/
docker exec nomorevibe-publisher-1 sh -lc 'codex --version; codex login status 2>&1'
docker exec nomorevibe-db-1 psql -U nomorevibe -d nomorevibe -c \
  "select name,requested_version,processed_version,last_error from jobs order by name"
cat PENDING.md
```

## Admin operations HTML concept and Deppy-aibox review — 2026-09-09

- Objective: show all real service roles and jobs in an administrator design; review manual Codex reconnect using Deppy-aibox. User approved the proposed concept with `진행해`; this phase delivers the standalone HTML, not production integration.
- Completed: four-tab operating-center concept with seven observed services, ten executable jobs, service/search filters, explicit snapshot timestamps, disconnected Codex status, four-step mock reconnection dialog, and proposed manual category selection. No backend/OAuth/job request is sent by the demo controls.
- Files: `docs/designs/2026-09-09-admin-operations.html`, `docs/superpowers/specs/2026-09-09-admin-operations-design.md`, this handoff.
- Decisions: reuse `/admin/status` and existing jobs/catalog/queue/review data; distinguish liveness, job completion, disabled AI and model success. Job request versions are not item counts. Missing progress denominator means no percentage. AI failure hold/manual category are proposed changes, not existing policy. Container runtime/AI metadata requires central observations. Do not mount Docker socket into the web.
- Aibox review: private repo pinned to `814144a2d37cb60359486219393f93f32c7267fc`, checkout `/private/tmp/deppy-aibox-review.2Ncv9E`. Build → 64 actual tests → typecheck PASS in prior review. No live OAuth/refresh/Spark entitlement validation was performed. The design identifies whole auth.json retention, atomic generation/refresh ownership, webhook replay/schema/provider binding, version pin and real admin session requirements.
- Actual HTML checks: Playwright HTTP200; 1440/1024/768/390 widths across all four tabs without page overflow; role filter/search/empty state; request demo; four reconnect stages and Escape; manual missing-category/selected-category feedback; 0 page errors. Desktop and mobile screenshots visually inspected. Mobile notice changed to a stacked button layout after inspection.
- Failed approaches: port 8767 occupied, used loopback 8879. First manual selection test found malformed option markup; explicit option elements/values repaired, complete interaction rerun passed. Prior Aibox invocation had wrong cwd; test-before-build produced zero tests. Correct build-first results are recorded in the design document.
- Preview server: Python http.server session 30614, loopback port 8879; serves only docs/designs. Screenshots `/tmp/nomorevibe-ops-{1440,1024,768,390}.png`, `/tmp/nomorevibe-ops-connect.png`.
- Remaining: user design feedback, then scoped production implementation plan and integration. Real runtime settings, credentials and fallback publication policy are unchanged. Preserve existing unrelated local edits and stash.

Exact next commands:
```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short --branch
open http://127.0.0.1:8879/2026-09-09-admin-operations.html
cat docs/superpowers/specs/2026-09-09-admin-operations-design.md
# If preview server has stopped:
python3 -m http.server 8879 --bind 127.0.0.1 --directory docs/designs
```

## Operations concept v2 — worker roles and model configuration

- Objective: expand the existing approved administrator concept with role-first worker names, detailed task progress, and Codex model settings after connection.
- Completed: each of six service cards shows its Korean role above the worker key; database has role/name too. Selected worker panel shows purpose, owned jobs, schedules, activity constraints and dated real result excerpts. Task modal and Korean role/job search work. Codex reconnect demo now leads to primary/fallback model and effort configuration, test success/access denial/timeout scenarios, and guarded apply preview. Duplicate models are rejected; changing settings invalidates verification.
- Files: `docs/designs/2026-09-09-admin-operations.html`, corresponding `docs/superpowers/specs/2026-09-09-admin-operations-design.md`, and this handoff only.
- Decisions: retain explicit historical snapshots, avoid fictitious progress percentages, use only existing Spark/Terra model IDs, separate account connection from model compatibility and worker application. Actual configuration implementation must bind credential generation/config hash and apply only on the next batch. Current fallback publication policy is unchanged.
- Validation executed: Playwright 4 widths × 4 tabs no page overflow; six worker detail switches; job modal; Korean search; pre-auth fieldset disabled and post-auth enabled; denied/duplicate configuration cannot apply; successful configuration applies in demo; effort edits invalidate verification; mobile model section no overflow; zero page errors. Inspected desktop overview and model screen screenshots. No failing checks in this phase.
- Artifacts: `/tmp/nomorevibe-ops-v2-{1440,1024,768,390}.png`, `/tmp/nomorevibe-ops-v2-models.png`, `/tmp/nomorevibe-ops-v2-models-mobile.png`. Existing loopback preview 8879 remains active.
- Remaining: design feedback, then implement data/credential/config endpoints under separate scope. No new production code, runtime settings, credentials, or service processes changed.
- Next commands: `cd /Users/jr/Desktop/projects/nomorevibe`; `git diff --check`; `open http://127.0.0.1:8879/2026-09-09-admin-operations.html`; `git diff --stat`.

## Shared admin layout implementation — in progress

- Objective: implement persistent sidebar and content navigation across all real admin menus.
- Completed: added nested admin layout, client shell, scoped responsive CSS, all-menu active navigation; removed duplicate per-page nav, renamed status heading to 운영센터. Auth remains in pages/actions; login bypasses shell.
- Modified: app/admin/{layout.tsx,AdminShell.tsx,AdminNav.tsx,admin.css}, existing admin pages, tests/admin-navigation.test.tsx. Preserve other dirty work.
- Validation: navigation tests ran RED (3 failures before implementation); after implementation two assertions failed because Next serializes aria-current before href. Adjusted assertions to ignore attribute order; rerun pending.
- Remaining: actual job-role overview, final tests/typecheck/lint/build, local web update and browser navigation verification. OAuth/model settings remain concept only.
- Next commands: `npx vitest run tests/admin-navigation.test.tsx`; `npx tsc --noEmit --incremental false`; `docker compose -p nomorevibe ps`.

## Shared admin layout implementation — completed locally (2026-09-09)

- Objective completed: the real admin sidebar persists across 운영센터, 심사 큐, 제품 관리, 크롤 설정, 근거 설정 and 랭킹; page bodies render in the shared content area. Product detail selects 제품 관리 and now uses client navigation. Mobile navigation collapses after route changes. Login is outside the sidebar; returning to the public site restores its header/footer.
- Files: `app/admin/layout.tsx`, `AdminShell.tsx`, `AdminNav.tsx`, `admin.css`; existing admin pages with duplicate nav removed; `app/admin/products/ProductRow.tsx`; `app/admin/status/{page.tsx,WorkerOverview.tsx,RefreshStatus.tsx}`; `tests/admin-navigation.test.tsx`; this handoff. Earlier unrelated dirty edits remain intact.
- Operations: added five actual job-role cards from JOB_CATALOG and existing jobs query, role before worker name, expandable owned-job state/schedule/last run/last success/retry timestamps, manual refresh and KST snapshot timestamp. Observed DB timestamps explicitly do not claim current container health or successful AI authentication. No extra collector is loaded and no new DB query is needed for these cards. Existing status panels remain.
- Decisions: use a nested layout rather than moving every admin route; keep authorization on server pages/actions; no menu prefetch to avoid loading all admin datasets. Scope public chrome hiding to the mounted admin shell. Long text wraps inside the content column. Existing Codex reconnect/model configuration remains HTML concept only; this phase does not implement credentials or runtime model settings.
- Tests actually run: navigation regression tests RED before changes, then 3/3 PASS after fixing attribute-order-dependent assertions. Full `npm test`: 84 files / 631 tests PASS. `npx tsc --noEmit --incremental false`: PASS. `npm run lint -- --ignore-pattern nomorevibe-final`: PASS (unrelated imported design folder excluded). After final Link/CSS changes: targeted nav tests 3/3 and `npx eslint app/admin` PASS; final Docker production build, including TypeScript, PASS. `git diff --check`: PASS.
- Browser verification on updated localhost:3200: all six client menu transitions preserve the same sidebar DOM; active menu correct; product detail also preserves sidebar; back/reload work; 1024/768/390 widths for six menus plus detail have no page overflow; mobile menu opens/closes and closes on navigation; public header restored on return home; refresh works; zero page errors. Desktop 1440 and mobile screenshots inspected. Auth-disabled temporary instance on loopback3212 redirects unauthenticated status/product-detail/ranking requests to login without sidebar or protected content; temporary container stopped after checks.
- Failed approaches fixed: Next Link HTML emits aria-current before href (test assertion corrected). First browser pass found mobile product URL text extending page to537px at390px; `overflow-wrap:anywhere` fixed it and complete QA rerun passed. First recreate helper copied container PATH into host subprocess and could not find docker; no mutation occurred. Retried with only explicit Compose runtime variables in memory, preserving host PATH and existing credentials.
- Local deployment: `nomorevibe-app-1` on port3200 now uses `nomorevibe-web:admin-sidebar-20260909`; rebuilt/recreated app only with existing app credentials. Existing crawler/reviewer/publisher/maintenance/scheduler and DB were not restarted. Compose reports all seven services healthy. No production deployment, commit or push in this phase.
- Artifacts: `/tmp/nomorevibe-admin-sidebar-desktop.png`, `/tmp/nomorevibe-admin-sidebar-mobile.png`; read-only navigation QA `/tmp/nomorevibe-admin-qa.cjs`.
- Remaining: requested sidebar work is complete. Real Codex reconnect/model settings and broader service runtime telemetry remain separate implementation work described in the existing design specification.

Exact verification commands:
```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
git diff --check
npx vitest run tests/admin-navigation.test.tsx
node /tmp/nomorevibe-admin-qa.cjs
docker compose -p nomorevibe ps
curl -I http://127.0.0.1:3200/admin/status
# Browser: http://localhost:3200/admin/status
```

## Full operations v2 implementation — in progress, current objective supersedes sidebar-only phase

- User explicitly requested ALL functionality in the8879 v2 concept. Implementing overview/jobs/AI/manual tabs, real operations requests, isolated Codex credential owner/model checks, and manual classification holds.
- New code: lib/operations/{contracts,observations,agent-client,credential-vault,agent,categories,admin}.ts; lib/db/operations-schema.ts + schema export; additive drizzle0023 + journal; scripts/connect-agent.ts; supervisor DB observation hook; classifier accepts models and attempt callback; publisher broker calls/holds/manual decisions; publication guard checks category decision revision; real admin/status components/actions/operations.css replacing summary-only presentation. Compose adds internal connect-agent encrypted vault; Dockerfile creates owned vault directory.
- Architecture adjustment: one internal connect-agent owns login+CLI+refresh+encrypted full auth.json; publisher calls bounded authenticated RPC. This avoids shared auth file refresh races and credential webhooks. RPC derives its internal token from existing AUTH_SECRET. Credential actions require an actual allowlisted GitHub session; local bypass is insufficient. No OAuth approval has been started.
- Tests executed: operations-agent + classify + worker-runtime =21 PASS. Full unit suite/typecheck currently in progress. Initial typecheck before latest UI fixes PASS. Lint found plain OAuth API anchor false positive, internal review anchor, Date.now in render, unused ModelConfig. Fixing those now. No local migration/deploy of this full phase yet;3200 still sidebar-only image.
- Important remaining: fix login persist rollback and supervisor DB connection shutdown; final lint/type/tests; isolated DB category/guard/job coalescing integration; build images; preserve current service env secrets in memory while replacing roles; migrate existing local DB only after checks and backup; all-tabs Playwright QA (real OAuth requires operator approval, do not fake it). Existing unrelated dirty work remains.
- Plan: docs/superpowers/plans/2026-09-09-operations-implementation.md. Tests sessions55789,50435; current helpers /tmp/nomorevibe-admin-qa.cjs is previous sidebar QA and needs full-v2 replacement.

## Full operations v2 — final verification/deployment checkpoint

- Full unit suite639/639 PASS (86 files); new category+publication gate integration12/12 PASS. Initial hold cooldown test exposed host/DB timestamp skew; use DB clock_timestamp()/now() for hold writes. One unrelated public-network SSRF test transiently failed then targeted9/9 and whole639/639 passed.
- New runner stores last12 numeric/boolean event summaries atomically with successful completion in operations_observations job:<name>; UI job details shows last run duration/results, no original/model output. Integration12/12 rerun after runner change PASS; whole unit639/639 rerun PASS.
- Production Docker web build initially failed because client ManualClassification imported server product schema (node:net). Extracted pure lib/domain/products/categories.ts and re-exported original schema interface. Next build then passed. Final manual form accessibility edit accidentally left a closing label; replaced component with readable explicit labels; typecheck/lint PASS, final web build session97683 pending/just completed.
- First full-v2 local deployment complete: all8 services healthy; supervisor observations recorded for5 worker roles and connect-agent; actual publisher tick135/135, no last_error,13 classification holds. Existing publisher Codex reported Not logged in before replacement; no usable credential migrated or lost. Backup /var/folders/5g/tm96jknx43n8r04kl5j12kvm0000gn/T/nomorevibe-before-ops-q6nnysgb.dump; additive0023 applied to local55437. Credentials preserved in memory with temporary0600 Compose override removed after use. Helper /tmp/nomorevibe-operations-deploy.py.
- Browser on real3200: all four tabs ×1440/1024/768/390 no page overflow;8 role detail selections;5 crawler jobs, Korean search, empty state; modal Escape; disabled model test before connection; local bypass cannot manage credentials; sidebar navigation; zero page errors. Screenshots /tmp/nomorevibe-ops-live-<width>-<tabIndex>.png inspected desktop/mobile. QA /tmp/nomorevibe-ops-v2-qa.cjs.
- Isolated fixture app3214/agent3213 + test DB55435: fake pinned-CLI contract executable (no network/real account) completed login credential storage, primary+fallback validation, apply; editing effort invalidated verification; actual manual-category and job-request server actions passed. Earlier manual getByLabel exact failed due implicit label/select options; fixed explicit htmlFor. Fixture Docker app stopped; fixture node22331 terminated. No real OpenAI login approval or real model inference tested.
- Latest worker image operations-v2-20260909 includes completion summaries and one-use model apply; built successfully. Need rerun /tmp/nomorevibe-operations-deploy.py after final web build to place final images on real stack; rerun browser QA, verify latest job summaries/health, final docs/check report. No commits/push in this phase. Real OAuth remains operator action, not an implementation stub.

## Full operations v2 — completed locally

- Final web and worker images deployed to3200 under operations-v2-20260909, preserving existing credentials. All8 services verified healthy after full replacement; final web-only rebuild adds explicit missing OAuth configuration notice. Full four-tab responsive/browser QA rerun PASS with zero page errors on deployed stack. Latest source typecheck and status-component ESLint PASS; final web production build PASS; whole lint passed after manual JSX repair. Whole639-unit suite and12 DB integrations passed as recorded above.
- Real runtime now records job:crawl-fetch, job:crawl-agent-review, job:product-evidence-refresh and job:agent-evidence-refresh completion summaries. Final browser spot-check verifies recent job result and OAuth-setup notice. Publisher queue resumes after refresh with category holds instead of fallback publication; no stale human classification can bypass publication guard.
- Operator configuration remaining: local GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET are absent (allowlist is configured). The actual UI clearly reports this and does not present an unusable login link. Need configure the GitHub OAuth app, sign in as an allowlisted admin, then explicitly approve Codex device authorization and test/apply models. This is an external configuration/approval requirement; code paths are implemented and tested with isolated fixtures, not real OpenAI inference. No production deployment/commit/push.
- Next verification: `cd /Users/jr/Desktop/projects/nomorevibe`; `git diff --check`; `node /tmp/nomorevibe-ops-v2-qa.cjs`; `docker compose -p nomorevibe ps`. Local web-only redeploy helper: `python3 /tmp/nomorevibe-operations-deploy.py app` (preserves current secrets through a private temporary Compose override).

## Local Codex connection bug fixed — next objective Claude fallback via local Deppy-aibox

- Root cause: actualAdmin required a GitHub session while local UI bypass was enabled and GitHub OAuth client/secret absent. Failed request left the modal in fake code-preparing state.
- Fixed: explicit `localCodexEnabled` requires ADMIN_LOCAL_LOGIN=1 + ADMIN_LOCAL_CODEX=1 + HTTP loopback site URL. Local Compose binds web only127.0.0.1:3200. Server mode retains actual allowlisted session checks. AI tab describes local mode, catches failed requests, has proper retry/failed/cancelled/expired branches, resumes active login with 연결 계속 and prevents overlapping status polls. No prior credentials were used or exposed.
- Files: lib/auth/local-codex.ts, status actions/page/OperationsCenter/AiConnection, compose.yml, .env.example, tests/local-codex.test.ts and operations-actions.test.ts, operations runbook. Existing other dirty work preserved.
- Validation:10 targeted tests passed, typecheck and scoped ESLint passed, production web build passed; deployed web only with existing secrets and loopback port. Actual real Codex CLI device code and official URL generated via browser UI; close/resume worked; cancellation cleared code/wait state; no page errors. QA canceled the actual pending test login; no OpenAI account approval occurred. /tmp/nomorevibe-local-codex-qa.cjs reproduces without logging the code. Last failure/mobile QA session61443 pending result.
- User now asks: use `/Users/jr/Desktop/projects/Deppy-aibox` so Claude is used when Codex fails. New objective includes inspecting that local repo and integrating actual provider/auth/fallback behavior, retaining the above fixed local login capability. Do not revert to GitHub-only requirement. Existing connect-agent is Codex-only and provider fallback still Spark→Terra; Claude fallback NOT implemented yet.

## 2026-09-09 — Deppy-aibox Claude publisher fallback (implemented locally)

### Objective and completed work
User asked to integrate `/Users/jr/Desktop/projects/Deppy-aibox` so the publisher can use Claude when Codex fails. Implemented in the existing private connect-agent, preserving the current publisher/reviewer separation and publication guards. Local app and connect-agent have been rebuilt/recreated; both are healthy at port3200 (web loopback only). Other five worker services remain healthy and unchanged; publisher already delegates classification to the broker.

- Vendored the actual aibox core and Claude provider from commit `814144a2d37cb60359486219393f93f32c7267fc`, with Apache-2.0 license/provenance. Did not edit the sibling repository or add its unrelated server/webhook/Naver components.
- Added Claude `setup-token` PTY login, official OAuth URL, transient authorization-code input, encrypted token storage alongside existing full Codex refresh credential, and credential generation invalidation.
- Added isolated Claude classification adapter consuming the same strict category schema. Default new selection is Spark xhigh → Claude Sonnet high; existing applied configurations are preserved. Explicit preset button selects this policy.
- At least one selected model must pass a real sample probe before config apply; a failed Codex probe does not block a verified Claude fallback. Both failures reject apply. Runtime primary failures (auth/timeout/CLI missing/invalid output and other errors) invoke fallback; both failures retain the established approved/hold policy.
- Actual recent attempt model distinguishes Sonnet from Codex. General observations preserve login provider, not OAuth URL/code/token. Authorization input is omitted from audit.
- Codex cancellation previously killed the wrapper only, leaving a child CLI and a permanent busy login. Both login providers now run in detached groups and cancellation/expiry kills the group; CLI-close drains the lock.

### Files in this phase
`lib/vendor/deppy-aibox/{core.ts,claude.ts,LICENSE,README.md}`; `lib/operations/{claude.ts,agent.ts,contracts.ts}`; `lib/crawl/classify.ts`; `scripts/connect-agent.ts`; `app/admin/status/{AiConnection.tsx,OperationsCenter.tsx,actions.ts}`; `Dockerfile`; `tests/{operations-claude.test.ts,operations-agent.test.ts,operations-actions.test.ts}`; `docs/operations/operations-center-runbook.md`; this handoff. Existing large dirty admin implementation/unrelated work remains uncommitted; do not indiscriminately stage/revert it.

### Decisions and limitations
- No Redis/new service/schema migration was required for this phase. Both credentials use existing AES-GCM vault/volume; no credentials were printed or placed in web env.
- Claude inference receives OAuth token only in that child environment, isolated HOME/config, no ambient API key/proxy/customizations, no tools/MCP/session persistence. Review worker token/model remain separately configured.
- Claude Sonnet is the installed CLI alias, not a promise of a specific dated model. Actual account access requires the in-app model test.
- Local QA generated OAuth URLs/device codes, then cancelled only QA-owned sessions; no user account was approved and no live authenticated Claude inference was claimed. Unit tests use dummy credentials and structured CLI fixtures.
- User must connect Claude under `/admin/status` → AI 연결, enter the official authorization code, select Spark → Claude preset, run model test, then apply. Current automatic fallback capability is deployed but no account/model configuration was authorized by the assistant.

### Verification actually executed
- `npx vitest run`: **88 files / 655 tests passed**, `/tmp/nomorevibe-claude-tests.log`.
- `npx vitest run --config vitest.integration.config.ts tests/integration/operations-center.test.ts tests/integration/review-publication-gate.test.ts`: **2 files / 12 passed**, `/tmp/nomorevibe-claude-integration.log`.
- `npx tsc --noEmit`: passed after final source changes.
- Targeted ESLint for operations/UI/RPC/tests: passed. Vendored original provider has one unused `_ctx` warning when explicitly included, no errors.
- Docker worker and runner builds passed. Final local deployment: `python3 /tmp/nomorevibe-operations-deploy.py connect-agent`, then `... app`. Helper retains existing env without printing secrets; encrypted volume preserved. Live expired old Codex login was observed before broker restart.
- Actual pinned Claude2.1.263 in worker image: official OAuth URL generated, inputRequired=true; cancellation drained entire process group. `/tmp/nomorevibe-claude-cli-qa.cjs` via `docker run --rm -i --init --entrypoint node nomorevibe-worker:operations-v2-20260909 --import tsx - < /tmp/nomorevibe-claude-cli-qa.cjs`.
- `node /tmp/nomorevibe-claude-ui-qa.cjs`: passed real Claude URL/input, invalid-code inline feedback, close/resume/cancel; real Codex device code + cancellation; preset values; 1280/390 widths without overflow; zero browser page errors. Screenshots `/tmp/nomorevibe-claude-{1280,390}.png`.
- `git diff --check`: passed.

### Failed approaches corrected
- Initial aibox PTY startup failed `This account is not available`: worker's passwd shell is nologin. Added explicit isolated `SHELL=/bin/sh`, plus util-linux package for Linux `script`; real startup passed afterwards.
- Initial TS errors from aibox optional capture results/ProcessEnv NODE_ENV contract were corrected.
- First token-redaction assertion expected a string even when provider deliberately omits `.out` after token detection; corrected assertion; capture credential still verified.
- Docker bind mount from host `/tmp` resolved to a directory under this Docker context. Switched diagnostic script transport to stdin; no source/runtime workaround needed.

### Remaining / exact next commands
User account approval and actual model access test remain user-operated in the admin UI; do not automatically approve OAuth or claim live AI output. No commit/push in this phase. Before any broker restart, inspect login state and avoid interrupting an active user approval:
```
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
docker exec nomorevibe-db-1 psql -U nomorevibe -d nomorevibe -Atc "select observed_at,value->>'busy',value->>'connected',value->>'claudeConnected',value->>'configVersion',value->'connection'->>'state' from operations_observations where key='connect-agent'"
docker ps --filter name=nomorevibe --format '{{.Names}} {{.Status}} {{.Ports}}'
npx vitest run tests/operations-agent.test.ts tests/operations-claude.test.ts tests/operations-actions.test.ts
```
Do not run the real-login QA script while the user is authenticating; it intentionally starts/cancels its own login sessions.

## 2026-09-09 — Follow-up: Codex visibility, Claude Enter protocol, readable operations UI

### Objective
User reported at `http://localhost:3200/admin/status`: cannot tell whether Codex connected, cannot set models, Claude still cannot connect, UI unreadable. Asked whether aibox was actually reused. Fixed the integration defects and redesigned the existing AI tab and operations typography, then deployed locally.

### Root causes (observed, not inferred from prior claims)
- Live DB showed `connected=true`, generation1, configVersion0, no model verification. Codex had successfully connected; the user lacked a clear distinction between stored credential and usable/applied model.
- A Claude login held the single CLI lock for10minutes. Frontend disabled the entire model fieldset while any login was pending, with no clear reason; status polling could stop permanently after an error.
- Deppy-aibox USAGE.md lines216/282 use `sendInput(code + '\r')`. Our integration sent LF (`\n`). Actual pinned Claude CLI diagnostic reproduced **LF_error=false / CR_error=true** with a deliberately invalid code: LF did not submit, CR caused a rejection response. This is an integration bug; the previous fixture accepted any stdin and missed it. The regression fixture now requires byte13 and was run failing first (`exchanging` instead of `stored`).
- Core/provider-claude are actual vendored aibox modules. Entire server/client/React SDK were NOT imported. Explained this distinction to the user; preserved existing broker ownership/access control/vault architecture rather than rewriting the project.

### Completed / modified files in this follow-up
- `lib/operations/agent.ts`: CR submission,45s exchange deadline, safe OAuth rejection classification and process cleanup. Rejected/timed-out reconnection preserves existing credentials. Added per-provider stored/checked metadata, `probe(provider)` async real model response check, and computed `configReady` independent of stored credential/verification.
- `lib/operations/contracts.ts`: optional backwards-compatible account metadata, configReady, safe connection error code.
- `scripts/connect-agent.ts`, `app/admin/status/actions.ts`: privileged probe RPC/action, observation carries safe error/provider only; no credential/code content in audit.
- New `app/admin/status/useAgentConnection.ts`: mount/focus/3s visible-tab polling, retry after error, preserve last known state and drafts, reject older overlapping response after mutation. Initial load is scheduled/cleaned with an effect timer (direct async callback initially tripped the React lint rule).
- `app/admin/status/AiConnection.tsx`: account rows with stored state/actual response/time, individual connection check and reconnect buttons; login reason/cancel shown inline; model selection remains editable during login; actual execution remains serialized. Clearly separates model draft, sample verification, application and recent execution. Technical generation/version metadata moved into details. Claude modal shows code entry, exchange progress, safe failure reason and new-session retry; Codex has code copy. Displays transport errors inside dialog too.
- `app/admin/status/operations.css`:14–15px operational body/labels,13px minimum badges/metadata,44px controls, darker muted text, structured account/model/result layout, responsive grids. Desktop/mobile visually inspected.
- `app/admin/status/OperationsCenter.tsx`: alert based on applied config, not just Codex credential; redundant global alert hidden on AI tab.
- `tests/operations-claude.test.ts`: CR-sensitive success, rejected-code preservation, account probe vs apply separation. `tests/operations-actions.test.ts`: probe respects admin gate.
- `docs/operations/operations-center-runbook.md`, this handoff updated.

### Tests actually executed / results
- CR-sensitive regression before fix: FAILED as expected (exchanging instead of stored), `/tmp/claude-enter-regression.log`.
- Actual isolated Docker pinned Claude CLI input comparison: `{"LF_error":false,"CR_error":true}`; `/tmp/claude-enter-diagnostic.cjs`. No real OAuth code/token printed.
- `npx vitest run`: **88 files /657 tests passed**; `/tmp/ops-connect-all-tests.log`.
- `npx tsc --noEmit`, targeted ESLint, `git diff --check`: passed.
- Worker and web Docker builds passed, tags remain `operations-v2-20260909`. Only local app/connect-agent changed. Encrypted vault preserved.
- `node /tmp/ops-connect-current-qa.cjs`: real localhost browser passed stored Codex vs unapplied config, model editing during active Claude login with execution reason, actual Claude invalid-code rejection (CR reaches real CLI), automatic recovery after deliberately aborted status request,4 widths1440/1024/768/390, no page errors. Initial attempt used incorrect getByLabel selector; changed to role=combobox matching the actual accessible name. Initial probe wait matched '미검사' too early; corrected script to match timestamp paragraph. Live DB and final separate test confirmed actual probe success.
- `node /tmp/ops-model-verification-qa.cjs`: **actual Codex Spark sample succeeded**; after broker restart its saved probe result remained visible. Live selected-model verification succeeded for Spark, returned auth-required for unconnected Claude, and **Apply button became enabled**. Config was NOT applied as part of this diagnostic. Desktop/mobile final layout passed with zero page errors. Screenshots `/tmp/ops-connect-final-{1440,390}.png`; earlier four widths `/tmp/ops-connect-after-*.png`.
- Re-ran no publication integration suite this follow-up: publication guard/queue behavior unchanged. Prior12 integration tests remain prior-phase evidence, not newly executed evidence.

### Live state / remaining
Local web `http://localhost:3200/admin/status` and connect-agent healthy. Codex connected with actual Spark response success. Claude still has no stored OAuth token; user must reconnect through official page. Verified config in live broker is Spark xhigh → Sonnet high; results Spark success / Sonnet auth; configReady=false, configVersion0. User can Apply current verified policy, or connect Claude then re-test/apply (reconnection changes generation).
Do not claim Claude account authorization succeeded: only actual CLI submission/rejection plus fixture credential persistence were tested. No user account approval or product publishing was performed in this diagnostic. Latest QA-owned failed session was cleared by broker restart, before final model verification. No active login remained at completion.

No commit/push. Dirty tree includes earlier admin implementation and unrelated files; do not bulk revert/stage. Do not restart broker while user is approving Claude now.

### Exact next commands
```
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
docker exec nomorevibe-db-1 psql -U nomorevibe -d nomorevibe -Atc "select observed_at,value->>'busy',value->>'connected',value->>'claudeConnected',value->>'configReady',value->'accounts',value->'verification'->>'state' from operations_observations where key='connect-agent'"
npx vitest run tests/operations-agent.test.ts tests/operations-claude.test.ts tests/operations-actions.test.ts
```
Real browser scripts initiate login/model probes and must not be rerun during the user's approval session. Local deploy helper remains `/tmp/nomorevibe-operations-deploy.py`; app/connect-agent image builds use Dockerfile runner/worker targets. Preserve existing env/vault when deploying.

## 2026-09-09 10:43 KST — User asked to check Claude again
- Live check: `claudeConnected=false`, previous Sonnet result `auth`; broker healthy. No valid Claude account credential exists, so actual authenticated Sonnet inference remains unverified.
- Re-ran `npx vitest run tests/operations-claude.test.ts`: **15/15 passed** (`/tmp/claude-current-check.log`); includes CR submission, persistence with fixture tokens, rejection handling and fallback. These are not live authenticated model calls.
- Opened the local admin AI tab in the CUA in-app browser and initiated a fresh Claude login. UI visibly shows official Claude OAuth URL and authorization-code field. Live state `provider=claude,state=awaiting_approval` at10:43KST.
- **ACTIVE USER HANDOFF:** Claude connection window shown to user. Do not cancel this session, restart connect-agent, or run login QA while they are approving. Session expires10minutes after start (~10:52KST). Browser `browser` binding ID1, `adminTab` tab1, marked handoff. Mark again if reused in another turn.
- User must approve through the official page and input the resulting code in the local modal. After connection is stored, use the Claude account's `연결 확인` to test actual Sonnet; then selected model test/apply according to user instruction. Do not assume verification from the fixture tests.
- No application code/config changed or model config applied this turn; only this handoff updated. The browser create-tab operation unexpectedly took~12minutes; no service failure was observed.

## 2026-09-09 — Commit preparation requested by user
- Commit scope: persistent admin shell/operations center, jobs/manual classification, private Codex/Claude connect-agent and aibox provider integration, local admin access needed by the tested setup, migrations, documentation and associated tests.
- Existing unrelated ProductHero/product-detail test edits and `nomorevibe-final/`, `nomorevibe_final.html`, `nomorevibe_final_source.zip` remain outside this commit.
- Most recent verification: full unit suite657 passed; Claude-focused15 passed; TypeScript, targeted ESLint, Docker builds and browser checks recorded above. No application code changed after those checks; commit preparation uses staged diff validation.
- No runtime restart, authentication cancellation, model application, push or deployment requested/performed as part of commit preparation. Preserve any active Claude user approval.
# 2026-09-28 19:06 KST — 워커 failover P0 별도 출고 준비

## 현재 목적 / 완료 작업 / 수정 파일

수집·심사 워커 장애 복구를 우선순위대로 진행한다. P0만 분리한 작업트리
`/private/tmp/nmv-worker-failover-p0`, 브랜치 `feat/worker-failover-p0-20260928`에
심사 `owner_changed` 반복을 모델 실패 한도와 분리한 커밋 `580f48e`, 일감·저장 진행·
scheduler 지연·반복 부팅 판별과 읽기 전용 JSON CLI를 만든 커밋 `d0539d9`를 적용했다.
`README.md`, `docs/operations/independent-workers-runbook.md`, `PENDING.md`에 명령·종료 코드·
90초 잡 stale와 남은 외부 감시 배치를 기록했다. P1 역할 lease/예비 워커 코드는 별도 작업트리
`/private/tmp/nmv-worker-failover-20260928`에서 개발 중이며 이 P0 브랜치에는 없다.

## 설계 결정 / 테스트 / 실패 접근

CLI 종료 코드는 0=정상·유휴, 1=DB/판별 불가, 2=경보다. 유휴·사용자 중단 소개 검수·
backoff는 정체로 처리하지 않는다. 아직 독립 주기 실행과 외부 알림을 배치하지 않았다.
기존 워커 supervisor·Swarm 재시작 설정을 변경하지 않는다. 이 브랜치에서 `npm ci`,
`npx next typegen`, `npx tsc --noEmit`, `npm run lint`(기존 vendor 경고1·오류0),
`npm test`(151파일 1206/1206), `npm run build`, `git diff --check`를 실제 실행해 통과했다.
PostgreSQL 통합 전체는 이 브랜치에서 아직 실행하지 않았고, PR의 hosted CI에서 확인한다.
원래 작업트리의 `node_modules` symlink는 Next/Turbopack 빌드에 실패하므로 여기에는 `npm ci`로
직접 설치한다. 사용자 루트 작업트리의 수정은 보존한다.

## 남은 작업 / 정확한 다음 명령

P0 브랜치에서 CI 명령 실행, PR·hosted check·main 병합·운영 배포와 실제 상태 확인이 남았다.
외부 감시 주기 실행·알림과 장애 주입은 별도 P1/P2 작업이다. 사용자가 중단한
`product-intro-check`는 재개하지 않는다.

```sh
cd /private/tmp/nmv-worker-failover-p0
npm ci
npx next typegen
npx tsc --noEmit
npm run lint
npm test
npm run test:integration
npm run build
git status --short --branch
```

---
# 2026-09-28 — P3 publisher → maintenance → text failover 진행 중

## 현재 목적 / 완료 작업 / 수정 파일

사용자 지시대로 publisher, maintenance, text 순서로 P1/P2의 역할 lease·주/예비 선출을 확장하고 이전 crawler/reviewer 배포도 재검토한다. 루트 체크아웃은 사용자 변경이 많아 건드리지 않고 `/private/tmp/nmv-worker-failover-p3` (`feat/worker-failover-p3`, `origin/main` 1f5c2df 기반)에서 작업한다. 운영은 아직 P2 코드 SHA `2f8a6bb`다. 새 코드 배포·PR·커밋은 아직 없다.

`scripts/role-worker.ts`가 세 역할을 후보로 받아 진행 정체를 판별하도록 바꿨다. publisher 진행 신호와 OG 늦은 쓰기 fencing을 `lib/operations/worker-progress*`, `lib/crawl/publish.ts`, `lib/domain/products/{og,repository}.ts`에 추가했다. maintenance의 ping·검색 텍스트·뉴스·클릭 정리·랭킹 쓰기를 job lease로 fence하고 `lib/operations/maintenance-progress.ts`를 추가했다. text의 기존 번역·tagline·profile·verification 결과 쓰기는 이미 job lease+source CAS가 있음을 확인했고 `lib/operations/text-progress.ts`, `lib/crawl/translations.ts`에 정체 판별을 추가했다. 새 표적 테스트는 `tests/integration/{publisher-og-fencing,maintenance-fencing}.test.ts`, `tests/{maintenance-progress,text-progress}.test.ts`; 기존 parser/progress 테스트와 P3 계획 문서도 수정했다. 정확한 파일 목록은 `git status --short`를 본다.

## 설계 판단 / 실제 테스트 / 실패 접근

주 후보만 저장 가능한 일감이 오래 있고 실제 저장이 멎었으며 scheduler 정상·backoff/provider 오류가 아닐 때 15초 2회 후 자식 재시작을 요청한다. 예비는 진행 정체로 스스로 재시작하지 않는다. late write는 같은 DB 트랜잭션에서 현재 job lease를 확인한다. 운영 읽기 전용 검토에서 P2 crawler/reviewer 주·예비는 같은 SHA, 예비 autoDeploy=false, 진행 CLI `overall=ok`였다. 기존 역할 단위 3파일/21, 통합 3파일/14 통과. 새 maintenance 회귀 6파일/102, 새 fencing 6, publisher OG/진행 4, text/parser 단위 10 통과. `npx next typegen`, `npx tsc --noEmit` 통과. 전체 단위/통합, lint, build, CI와 운영 장애 주입은 이 단계에서 아직 실행하지 않았다.

의도한 red→green 테스트를 실행했다. maintenance 신규 제품은 건강 기록이 없어도 실제 점검 대상임을 확인하여 잘못된 테스트 기대를 고쳤다. **남은 결함:** text tagline 경과 시간을 JS `Date`로 계산하면 운영 `timestamp without timezone`의 KST 해석으로 9시간 오판할 수 있어 DB 시계로 고쳐야 한다. 새로 추가한 P3 liveness 통합 테스트는 아직 실행 전이며 text/maintenance liveness 구현이 빠져 있어 red가 예상된다. 운영 maintenance backlog 약 19,328곳 중 13,939곳이 6시간 경과, 현재 처리 약 900건/시간이라 6시간 SLA 필요 약 3,222건/시간에 미달한다. 예비 배치는 용량 증가가 아니다.

## 남은 작업 / 정확한 다음 명령

P3 liveness 테스트를 red 확인 후 구현, tagline 시간 보정, 실제 후보 프로세스 선출/인계 테스트, 쓰기 경로 재감사, 전체 gate, 코드 리뷰, 문서 갱신을 끝낸다. 이후 최신 main CI를 통과한 PR과 운영 순차 배포·장애 주입을 진행한다. mini 예비의 구 SHA/autodeploy false와 P2 예비의 동일 릴리스 조건을 지킨다. 기존 P2의 반복 부팅 격리/정체 자동 재시작 운영 주입과 예비의 적격 결과 저장은 여전히 미검증이다. 사용자 중단 `product-intro-check`는 재개하지 않는다.

```sh
cd /private/tmp/nmv-worker-failover-p3
npm run test:integration -- tests/integration/worker-progress-query.test.ts
npm test -- tests/text-progress.test.ts tests/role-worker.test.ts
npx next typegen
npx tsc --noEmit
git status --short
```

---

## 2026-09-28 23:11 KST — P3 코드·검증 완료, PR/운영 전환 대기

### 현재 목적 / 완료 작업 / 수정 파일

publisher → maintenance → text 순으로 role lease 주/예비·진행 정체 감시·late-write fencing을 구현했다. 이전 P2의 crawler/reviewer 정체 감시도 실행 중 job lease가 있으면 재시작을 보류하도록 고쳤다. `worker-healthcheck.ts`가 P3 후보 3역할을 수락하도록 보완했고 P3 liveness를 읽기 전용 JSON에 추가했다. 마지막 수정 파일은 `git status --short`를 따른다. 주요 신규 파일은 `lib/operations/{maintenance-progress,text-progress}.ts`, `tests/integration/{maintenance-fencing,publisher-og-fencing,role-active-job}.test.ts`, `tests/{maintenance-progress,text-progress}.test.ts`, P3 계획 문서다. README·runbook·PENDING에 **아직 운영 배포 전**임을 기록했다.

### 설계 판단 / 실행한 테스트 / 실패 접근

- 발행 적격 대기 10분, maintenance 적격 점검과 최근 5분 ping 없음, text 적격 번역·소개·프로필·검수와 최근 10분 결과 없음이 2표본 지속될 때만 주 후보의 Swarm 재시작을 요청한다. scheduler 지연, backoff, 최근 제공자 오류, 실행 중인 job lease는 정체로 보지 않는다. job hard timeout은 기존 supervisor가 담당한다. job 결과 쓰기와 현재 token 확인은 같은 DB 트랜잭션이다.
- 기존 P2 역할 단위 21·통합 14, 새 실제 프로세스 인계 포함 표적 11 통과. 전체 `npm test` 154파일/1222 통과. 전체 `npm run test:integration` **최종 재실행** 96파일/921 통과·TODO1. `npx tsc --noEmit`, `npm run lint`(기존 vendor 경고1), `npm run build`(기존 Claude CLI 추적 경고), `git diff --check` 통과. 빌드 첫 시도는 작업트리 `node_modules`가 외부 symlink라 Turbopack panic; 이 symlink를 제거하고 `npm ci`로 독립 설치 후 성공했다.
- TDD 첫 실패로 P3 liveness, timezone 기준 tagline, 실행 중 job lease, 오래된 text provider 오류, 늦은 maintenance/OG 쓰기 경로를 확인·수정했다. 전체 통합 첫 실행 2건 실패는 OG mock 인자(lease 추가)와 오래된 text 오류 테스트였고 수정 후 관련 55 통과, 전체 최종 921 통과. 추가 cleanup 테스트 첫 기대는 기존 rate-limit 행을 무시해 실패했고 고유 키 범위로 고친 뒤 8 통과했다.
- 운영 DB **읽기 전용** 새 쿼리 측정: maintenance 약106~291ms, text 약1.1~1.2s, 전체 약300~353ms. 최종 `overall=ok`, 6역할 liveness `present`, publisher `no_work`, text `providerError=false`. mini 32GiB/도커 17.61GiB, 기존 P2 예비 대기 RSS 약67~70MiB. P2 운영 진행 CLI도 `overall=ok`. 운영은 아직 구 SHA `2f8a6bb`이며 이 P3 코드는 배포하지 않았다.

### 남은 작업 / 정확한 다음 명령

코드 diff와 stage 범위를 최종 검토하고 커밋·PR을 만든다. 최신 main의 필수 CI `check` 성공 후에만 merge한다. 운영 autoDeploy=true 앱이 main merge 직후 P2 예비와 다른 이미지가 될 수 있으므로 **병합 전** 기존 앱의 자동 배포 설정을 확인·잠시 끄거나 동등하게 안전한 순차 릴리스 계획을 적용한다. P2 예비는 autoDeploy=false이고 구 이미지/RELEASE_TAG다. 각 역할 M3 주 명령과 같은 SHA의 mini 예비를 publisher, maintenance, text 순서로 배포하고 자식 강제 종료, 주 중단, 예비 저장, 복귀, 최종 주 active/예비 standby를 검증한다. 남은 P2 예비도 같은 릴리스로 교체하고 웹/스케줄러를 확인한다. 외부 독립 감시·24시간 관측·실제 P2 예비 저장, maintenance 용량 부족은 아직 해결되지 않았다. 사용자 중단 소개 검수는 재개하지 않는다.

```sh
cd /private/tmp/nmv-worker-failover-p3
git status --short --branch
git diff --check
npm test
npm run test:integration
npx tsc --noEmit
npm run lint
npm run build
git diff --stat
```

---

### 2026-09-28 23:19 KST — PR #217 후속 경계 수정

maintenance `uptime-ping`의 과거 `last_error`가 영구적으로 정체 재시작을 막던 조건을 발견했다. 전용 통합 시험을 red 확인 후 최근 5분 내 실행 오류만 보호하도록 `lib/operations/maintenance-progress.ts`, `tests/integration/maintenance-fencing.test.ts`를 수정했다. 표적 통합 1파일/9, `npx tsc --noEmit`, 운영 DB 읽기 전용 쿼리(maintenance 222ms, text 1131ms, 전체 337ms, overall=ok) 통과. 이 수정 뒤 전체 통합과 GitHub 필수 CI는 **다시 받아야 한다**. PR #217은 첫 커밋 `0c1d91e`로 생성됐고 CI가 진행 중이다. 정확한 다음 명령:

```sh
cd /private/tmp/nmv-worker-failover-p3
git add lib/operations/maintenance-progress.ts tests/integration/maintenance-fencing.test.ts docs/CODEX_HANDOFF.md
git diff --cached --check
git commit -m 'fix: ignore stale uptime job errors in failover probe'
git push
gh pr checks 217 --watch
```

---

## 2026-09-29 00:08 KST — 5역할 장애 복구 전환·P2 재검토 완료

### 현재 목적 / 완료 작업 / 수정 파일

사용자의 publisher→maintenance→text 순차 확대와 기존 crawler/reviewer 작업 재검토를 완료했다. PR #217은 CI `check` 성공 후 main `20208d3c96ed92e4e931f1c91c40f6561ab12ad9`로 병합·운영 배포했다. M3 7개 앱과 mini 웹·다섯 역할 예비 6개 앱, 총 13개다. 이 문서 작업 브랜치는 `/private/tmp/nmv-worker-failover-docs`의 `docs/worker-failover-p3-rollout`이며 수정 파일은 `README.md`, `PENDING.md`, `docs/operations/independent-workers-runbook.md`, `docs/operations/2026-09-29-worker-failover-p3-rollout.md`, 이 handoff다. 사용자 루트 체크아웃의 변경은 건드리지 않았다. 코드 수정은 이미 PR #217에 있고 이 브랜치에는 문서만 있다.

### 설계 판단 / 실제 시험 / 실패 접근

역할 앱은 주·예비가 한 이미지여야 하므로 5역할 주·예비 모두 `autoDeploy=false`로 두었다. 웹 M3·mini와 scheduler만 새 이미지 후 `autoDeploy=true`로 복원했다. P3 세 역할은 새 이미지 기존 명령→주 후보 명령→mini 예비 순으로 배포했다. 각 역할에서 M3 자식 SIGKILL 뒤 M3 재획득(epoch2), 주 서비스 0 뒤 mini 인계(epoch3), M3 복귀(epoch4)를 확인했다. maintenance mini의 실제 ping/검색 갱신, text mini의 검수 저장이 전진했다. publisher mini는 job 요청·처리와 성공은 전진했지만 적격 승인 후보가 없어 새 제품 저장은 미검증이다.

P2 crawler/reviewer는 기존 주가 활성인 동안 mini 예비를 새 이미지/RELEASE_TAG로 먼저 교체했다. 릴리스 불일치 예비는 옛 주 lease를 승계할 수 없음을 코드와 DB에서 확인하고 주도 새 이미지로 배포했다. 새 쌍의 주 중단/mini 인계 후 crawler 새 문서 저장과 reviewer 1차 심사 저장을 확인했다. 둘 다 M3 epoch7 active/mini standby로 복귀했다. 이전 P2의 유효한 실행 중 job lease를 정체로 오인하는 결함은 PR #217 코드에서 수정돼 두 운영 이미지에도 반영됐다. 실제 정체 2회 자동 재시작과 반복 부팅 격리의 운영 주입은 하지 않았다.

웹 2개는 Dokploy source `20208d3`/done, 공개 `/api/health`·`/admin/status`는 각각 HTTP 200. scheduler 2개 컨테이너 healthy, 새 RELEASE_TAG와 maintenance liveness 코드 표식, 그 컨테이너의 `check-worker-progress.ts` 종료 0·`overall=ok`·6역할 present를 확인했다. **scheduler Dokploy 최신 배포 description은 빈 문자열**이라 단순 source 필드 성공으로 보고하지 않았다. 실제 런타임 확인으로 보완했다. 첫 자동 배포 복원 스크립트가 이 빈 description 때문에 종료1했고, scheduler 런타임 두 컨테이너/코드 표식/RELEASE_TAG를 강제 검증하도록 임시 도구를 수정한 뒤 웹·scheduler만 복원했다. Docker service ps의 의도한 SIGKILL 과거 실패 task는 현재 task와 구분했다.

코드 gate: `npm test` 154파일/1222 통과, `npm run test:integration` 96파일/921 통과·기존 TODO1, `npx tsc --noEmit`, lint(기존 vendor 경고), build(기존 Claude CLI 추적 경고), diff check, PR #217 최신 head CI `check` 성공. 이번 문서 수정 후 문서 정합성과 `git diff --check`를 다시 확인한다. DB streaming/서버 설정/사용자 중단 `product-intro-check`는 변경하지 않았다.

### 남은 작업 / 정확한 다음 명령

이 문서 브랜치의 diff를 검토·커밋해 PR을 만들고 최신 main CI `check` 성공 뒤 병합한다. 운영 재확인에서 13개 앱과 5개 역할의 주 active/예비 standby, 공개 health와 scheduler 두 컨테이너를 확인한다. publisher 예비의 새 제품 발행, 외부 감시/알림, 24시간 관측, 실제 정체 및 반복 부팅 격리, 백업 복구와 maintenance 용량 부족은 `PENDING.md`에 남겼다.

```sh
cd /private/tmp/nmv-worker-failover-docs
git status --short --branch
git diff --check
git diff -- README.md PENDING.md docs/operations/independent-workers-runbook.md docs/operations/2026-09-29-worker-failover-p3-rollout.md docs/CODEX_HANDOFF.md
git add README.md PENDING.md docs/operations/independent-workers-runbook.md docs/operations/2026-09-29-worker-failover-p3-rollout.md docs/CODEX_HANDOFF.md
git commit -m 'docs: record five-role failover production rollout'
git push -u origin docs/worker-failover-p3-rollout
gh pr create --base main --head docs/worker-failover-p3-rollout --title 'docs: record five-role failover rollout' --body-file /tmp/nmv-worker-failover-docs-pr-body.md
```

---

## 2026-10-11 — 상세 화면 개선과 GitHub 스타·피드백 재개 (진행 중)

### 현재 목적 / 완료 작업

사용자가 상세 정보 패널 축소, 미리보기 이미지 확대, 도구·AI 근거 섹션 제거, 전체 README 내부 스크롤, 스타·댓글 활성화를 요청했다. PR 4개로 나누고 gpt-6.1-sol/xhigh 서브에이전트를 독립 worktree에서 병렬 실행했다. 사용자가 기능 테스트를 직접 한다. 새 테스트와 로컬 테스트·빌드·브라우저 기능 검사는 하지 않고 필수 원격 CI는 유지한다.

- PR01 `/private/tmp/nomorevibe-detail-compact-20261011` / `feat/detail-compact-20261011`: FactsStrip 축소와 page의 BuildTools 섹션 제거. 기존 단위·E2E 기대만 최소 변경했다.
- PR02 `/private/tmp/nomorevibe-detail-image-20261011` / `feat/detail-image-zoom-20261011`: PreviewFigure + 신규 PreviewImageDialog. 독립 읽기 전용 CLI 리뷰에서 지적 없음.
- PR03 `/private/tmp/nomorevibe-detail-readme-20261011` / `feat/detail-full-readme-20261011`: IntroSection children 슬롯, 신규 ReadmeSection/readme-content helper 구현. 부모가 page에 Suspense를 연결하고 리뷰해야 한다.
- PR04 현재 rollout worktree / `feat/detail-integration-rollout-20261011`: 계획 문서와 운영 재활성화 조사 문서 작성. GitHub App 등록·메일 설정·실제 활성화는 미완료. 아직 이번 작업 커밋·푸시·PR·배포 없음.

### 수정 파일 / 주요 판단

PR01은 components/product-detail/FactsStrip.tsx, app/p/[slug]/page.tsx, tests/product-detail-components.test.tsx, tests/e2e/product-detail.spec.ts. PR02는 PreviewFigure.tsx와 PreviewImageDialog.tsx. PR03는 IntroSection.tsx, ReadmeSection.tsx, lib/domain/products/readme-content.ts이며 page 연결 예정. PR04는 docs/superpowers/plans/2026-10-11-detail-ui-and-integrations.md, docs/operations/2026-10-11-star-feedback-reactivation.md, 이 handoff다.

정보 패널 글자는 기존 최소 13px를 지키고 여백·주요 값 크기를 줄인다. README 검색 저장본은 2,000자여서 전문으로 표시할 수 없다. 공개 GitHub 원문을 안전한 익명 요청으로 256KiB 한도/8초 예산으로 읽고 기존 캐시를 재사용한다. 실패·초과는 발췌임을 명시하고 원문 링크를 제공한다. 스키마·crawler·검색 저장범위는 변경하지 않는다. 소개 검수 중단은 유지한다.

### 실행한 검사 / 실패 접근

각 agent git diff --check 통과. 첫 부모 codex review 명령에 실행 금지를 전달하지 못해 기존 4개 테스트 파일이 실행됐다(2파일 실패/2통과, 5실패/56통과). baseline은 4파일/61통과. 관련 로그는 /private/tmp/nomorevibe-detail-compact-review-tests.log 및 -baseline.log. 사용자가 직접 테스트한다는 지시를 놓쳤음을 알리고 리뷰를 중단했다. 글자13px·radius12·희소 fallback 복원과 제거/배치 변경 기대를 수정했지만 테스트는 다시 실행하지 않았다. 이후 CLI 리뷰는 읽기 전용/테스트·빌드·브라우저·DB·쓰기 금지를 명시한다. image 리뷰 완료, compact 최종 리뷰가 지적한 오래된 기대는 agent가 수정했다. README 독립 리뷰는 미실행.

### 운영/브라우저 상태 / 남은 작업

main 기준 8b608b2a7abc89cfacb830d3fdf14825b22d4d13. 두 웹 앱의 release 설정/배포 done은 이 SHA. 재활성화 조사에서 6개 앱 네 feature flag 모두 미설정(실효 false), 새 웹 인증 관련 14개 키 모두 비어 있다. 실제 OAuth·메일·스타·Issue 동작은 미검증.

GitHub @JRVector9 재인증을 사용자가 완료했다. Chrome https://github.com/settings/apps/new 의 Star App 초안은 이름 NoMoreVibe Star, 홈페이지 nomorevibe.com, 사용자 callback /api/auth/user/github/callback, webhook /api/github/webhooks/star, expiring token ON, Starring read/write + Metadata read, Any account로 준비됐다. Secret은 비었고 Create를 누르지 않았다. Feedback App 초안도 준비 후 등록 직전 승인이 필요하다. 기존 App/Resend 보유 여부 질문은 아직 답변이 없다. 새 키를 대화/문서에 출력하지 않는다. 자격증명 없이 flag ON 금지.

### 다음 에이전트 명령

```sh
cd /private/tmp/nomorevibe-detail-compact-20261011
git diff --check
git diff -- components/product-detail/FactsStrip.tsx app/p/\[slug\]/page.tsx tests/product-detail-components.test.tsx tests/e2e/product-detail.spec.ts
cd /private/tmp/nomorevibe-detail-readme-20261011
git status --short
```

CUA 재개 첫 호출은 await cua.rewriteDocumentation(); 후 Chrome을 새로 선택하고 인덱스를 새로 읽는다. PR01/02 커밋·push·PR, PR03 page 연결과 읽기 전용 CLI 리뷰, PR04 실제 설정/문서 상태 정리 후 PR을 진행한다. 최신 main의 필수 CI check 성공 뒤 순차 병합한다. UI 릴리스는 두 웹만 같은 검증된 이미지로 배포한다. 기존 소스 방식·replica·worker 설정·사용자 untracked 산출물·stash는 보존한다.

### 2026-10-11 23:32 KST — PR 생성·첫 병합

PR01 #363은 540cda52 head 필수 CI check 성공 후 main 3607fa2716510aab3d5136655e5c7dd947b70f0a로 병합했다. PR02 #364는 최신 main을 merge한 head 39c7036으로 push했고 CI 진행 중이다. PR03 page의 IntroSection children에 Suspense + ReadmeFallback/ReadmeSection을 연결했다. 읽기 전용 CLI 리뷰(로그 /private/tmp/nomorevibe-detail-readme-review-20261011.log)에서 루트 상대 README 링크가 github.com 호스트 루트로 잘못 향하는 P2 한 건을 찾아 detail_readme가 명시적인 저장소/기본 branch를 사용하도록 수정 중이다. 해당 리뷰는 테스트를 실행하지 않았다.

두 GitHub App 양식이 준비됐다. Feedback은 callback /api/auth/maker/github/callback, setup /api/github/installations/setup, webhook /api/github/webhooks/feedback, Issues read/write + 자동 Metadata read, Issues 이벤트, Any account, expiring token ON, installation OAuth OFF, SSL ON이다. 두 secret은 비어 있고 두 Create는 누르지 않았다. 새 보안 권한 생성과 운영 키 저장을 위한 브라우저 정책상의 확인 요청을 사용자에게 보냈고 답변 대기 중이다. Resend 보유/발신주소 질문도 대기 중이다. 키를 생성/전송하거나 flag를 켜지 않았다.

다음 명령: gh pr checks 364 (latest base 3607fa2); PR03 수정 diff 리뷰 및 git diff --check 뒤 커밋/push/PR. 웹 배포는 최종 main CI 및 private web image 발행 후 두 웹만 함께 진행한다. 이미 존재하는 /private/tmp/nomorevibe-primary-origin-20261011.py apply는 과거650b SHA가 고정되어 있으므로 재사용하지 않는다.

### 2026-10-11 23:42 KST — 화면 변경 세 PR 병합 완료

PR02 #364 최신-base CI 38147536149 check 성공 후 cd940e8a860c48eabc5972eb41ccd21ee2febf82로 병합. PR03 #365 최신-base CI 38147892606 check 성공 후 a91eecf2a3e3ef1e457acce47d9234c685f7c4a6으로 병합. README 상대 링크 P2는 기본 branch 전체를 인코딩한 저장소 루트 URL로 고쳤다. 최초 PR01 제거와 PR03 children 통합의 page 충돌은 부모가 BuildTools 없이 Suspense를 유지하도록 해결했다. 새 캐시 키 버전 문자열은 미배포 코드라 필요 없어 제거했다. 세 PR의 원격 필수 CI는 통과했으며 로컬 테스트를 추가 실행하지 않았다.

PR04 #366 생성. 현재 rollout worktree는 최신 main a91eecf를 merge했지만 아직 그 merge/이 기록을 push하기 전이다. #366은 docs-only CI check가 통과했던 이전 head이고 최신 head를 push하면 다시 받아야 한다. 운영 화면 배포는 아직이다. main CI 38148216532의 성공과 private web image 발행을 기다린다. docs-only #366은 web image를 발행하지 않으므로 a91eecf 이미지 배포 후 병합한다.

운영용 임시 도구 /private/tmp/nomorevibe-detail-web-rollout-20261011.py는 두 웹만 baseline·공통 action key·replicas·origin을 확인하고 같은 새 private image를 선행 pull하여 같은 창에 배포·실행 컨테이너/health를 확인한다. 아직 실행하지 않았다. 비밀 스냅샷은 외부0600만 허용한다. 다음 실행 인자는 SHA a91eecf2a3e3ef1e457acce47d9234c685f7c4a6과 main CI가 발행한 web digest다. GitHub 앱 등록 확인/Resend 답변은 여전히 대기 중, App 등록·키/플래그 변경 없음.

### 2026-10-11 23:50 KST — 상세 화면 배포 완료, 후속 홈 목록 검토 요청

현재 목적: 사용자가 화면 변경 뒤 ‘이번 주 새로 나온 프로젝트’와 ‘지금 뜨는 프로젝트’ 기준/운영 반영을 검토하라고 추가 요청했다. 오래된 프로젝트가 신규 목록에 나오고 급상승 목록 변화가 거의 없는 원인을 소스·실제 데이터로 대조해야 한다. 아직 해당 조사는 시작하지 않았다. 스타/피드백 App 등록 승인과 Resend 답변 대기는 원래 작업의 남은 단계로 유지한다.

완료: PR363/364/365 최신-base CI 성공·병합, main a91eecf CI38148216532 전체 성공 및 private web image 발행. 임시 web-only 도구를 실행해 mini2/M3 4 같은 이미지 sha256:638039d10f6cf75364c814d3c3c2a10659962f89a3f22dea3b97afb2ce67f2bc로 배포했다. mini 배포 jReyg8165rBJSiZRJABFF, M3 배포2JMxitPFP1q_9BVvlBc8S. 실제 컨테이너 revision/건강/개수와 공개 health에서 두 instanceId 새 release/status/db ok 확인. 로컬 기능 테스트는 추가 실행하지 않았다. 두 웹의 원래 인증키/registry/replicas/source/worker 설정을 보존했고 기능 플래그는 false다. 외부0600 rollback snapshot /private/tmp/nomorevibe-detail-web-before-a91eecf2a3e3.json은 비밀이므로 출력/커밋 금지.

수정 파일은 앞서 기록한 세 UI PR과 PR366의 계획/운영 기록/이 handoff다. 실패한 첫 CLI 리뷰와 해결한 page merge 충돌/README 링크 P2는 앞 기록을 따른다. PR366은 최신 main을 합치고 이 배포 기록까지 커밋/push한 뒤 docs-only 필수 CI 성공으로 병합해야 한다. 그 다음 사용자 root main을 fast-forward하되 untracked PPT/prototypes/stash는 보존한다.

다음 명령:
```sh
cd /private/tmp/nomorevibe-detail-rollout-20261011
git diff --check
git add docs/CODEX_HANDOFF.md docs/operations/2026-10-11-star-feedback-reactivation.md docs/superpowers/plans/2026-10-11-detail-ui-and-integrations.md
git commit -m 'docs: record detail web rollout and pending app setup'
git push
gh pr checks 366
```

이후 root에서 rg -n '이번 주|새로 나온|지금 뜨는|trending|rising|recent' app components lib 로 홈 목록 경로를 찾는다. 소스와 운영의 repository createdAt/publishedAt/ranking window·snapshot 시각·주기·증가량을 읽기 전용으로 대조한다. 사용자 요청은 우선 검토이며 새 기준을 임의로 정해 배포하지 않는다. 중단한 소개 검수는 재개하지 않는다.

### 2026-10-11 23:56 KST — 홈 목록 소스 조사 완료, 운영 데이터 대조 진행

PR366은 최신-base 필수 CI38148821876 check 성공 후 main298eb926으로 병합했고 사용자 main도 fast-forward했다. 상세 화면의 운영 이미지는 앞서 검증한 a91eecf2이며 이후 main 변경은 문서뿐이다. GitHub App 등록 확인 및 Resend 답변은 아직 없어 플래그 OFF를 유지한다.

현재 목적은 사용자가 추가 요청한 신규/급상승 목록의 **읽기 전용 검토**다. 독립 문서 worktree /private/tmp/nomorevibe-home-criteria-audit-20261011, branch docs/home-criteria-audit-20261011에서 기록한다. detail_compact와 integration_reactivation의 gpt-6.1-sol/xhigh 소스 조사 완료. 새 코드·테스트·빌드·기준 변경은 하지 않았다.

확인된 소스: getNewThisWeek는 저장소 생성일 대신 coalesce(verified_at,created_at) 등재/인증일을 사용하고 시작 경계만 적용한다. 따라서 오래된 저장소와 집계 종료일 이후 등재도 포함된다. 반면 홈의 ‘이번 주 새로 생김’ 요약은 crawl_documents.repo_meta.created_at과 KST 완료 7일 양쪽 경계를 사용한다. 급상승은 두 숫자 관측 사이 일평균 증가량의 고정 상위5개이며 정상 재조회20시간, 시도 작업5분, freshness 기본7일이다. 집계 설명의 1일 바닥·2~3일 주기는 소스와 다르다.

실패 접근: root .env/.env.local DATABASE_URL로 읽기 전용 연결했지만 제품 스키마에 repo_status/repo_checked_at 등 현재 필드가 없어 복잡한 조회가42703으로 실패했다. 이 연결의 crawl_settings.updated_at은2026-09-09이며 운영 연결로 간주할 수 없다. 정보스키마 조회로 확인했고 **마이그레이션하거나 변경하지 않았다**. 운영 웹의 실제 연결을 안전하게 사용해 날짜·순위·관측 시각·job 상태를 대조해야 한다. 웹 도구 nomorevibe.com open도 internal/not-accessible 오류로 콘텐츠 근거를 얻지 못했다.

실행한 검사는 git 상태/소스 읽기와 위 READ ONLY 트랜잭션 및 정보스키마 조회뿐이며 기능 테스트 결과는 없다. 사용자 untracked PPT/prototypes와 중단한 소개 검수는 보존한다. 비밀 env·접속 문자열은 출력/커밋하지 않는다.

다음 명령: cd /private/tmp/nomorevibe-home-criteria-audit-20261011; git diff --check. /private/tmp/nomorevibe-release-inspect-20261011.py를 import해 client().app('web-mini')로 운영 연결을 메모리에 가져오거나 실행 컨테이너에서 postgres READ ONLY 조회한다. 해당 도구 inventory()는 비밀 스냅샷을 만들므로 실행하지 않는다. 제품 신규top5/급상승top10, rising 설정, stars_at/checked_at/previous_at, product-stars-refresh job 및 관측 counts를 수집한 뒤 이 기록과 운영 검토 문서를 갱신한다.

### 2026-10-12 00:06 KST — 홈 기준 운영 대조 완료

완료 작업: 운영 mini 웹 실행 컨테이너의 실제 DATABASE_URL/READ_DATABASE_URL을 사용해 각각 REPEATABLE READ, READ ONLY로 조사했다. 컨테이너 runtime a91eecf2와 현재 제품 필드를 확인했다. 00:02:30 KST 주 DB/읽기 복제본의 신규top5/급상승top10 결과가 같았고, 복제본 replay 경과 약0.058초다. 공개 홈 HTTP 읽기에서도 급상승5개 순서·스타·증가량이 일치했고 CF DYNAMIC였다. 해당 읽기는 기능 테스트가 아니다.

신규 상위5개 vm2api/Yielded Auth/Aptos Explorer/examples/HyperDX 모두 기간 이전 생성 저장소다. 기간내 서비스 등재·스타50이상·정상공개 조건1,307개 중1,289개(98.62%)가 이전 생성,18개가 기간내 생성이다. 시작 경계만 사용하고 카드도 등재일을 표시하므로 화면 명칭과 구현이 다르다. 완료7일 창은10/5 00시~10/12 00시 KST이고 달력 이번 주와도 다르다.

급상승 freshDays=7. 정상ok36,262개 모두 숫자 관측24시간 이내이며 공개 저장소37,479개 중24시간 내 숫자36,269개,48시간 초과1,165개다. product-stars-refresh 요청/처리8,332 동일, 오류/lock/retryAfter 없음, 최근23:59:28 성공, 관측examined35/updated15/ok15/missing20/unknown0. 현재 상위5개 관측 간격20.07~20.09시간, 마지막 성공14.38~19.97시간 전. 이 표본에서 수집 정체나 오래된 복제본을 원인으로 확인하지 않았다. 고정5개·20시간 재관측·두 관측 일평균 기준이다. 과거 순위가 수일간 동일했는지까지 확정하지 않는다. 설명의1일 바닥/2~3일 확인은 실제20시간과 다르다.

수정 파일: docs/operations/2026-10-12-home-criteria-audit.md 신규 보고서, 이 handoff. 앱 코드/기준/DB/운영설정 변경 없음. 최소 수정안을 신규 의미/날짜/범위 정합성 PR, 급상승 설명 PR, 공통24시간 이력은 별도 선택 PR로 기록했다. 사용자 요청은 검토이므로 아직 구현하지 않는다. 원래 스타/댓글 활성화는 GitHub App 최종 등록 확인과 Resend 발신 정보 대기이며 OFF다. 사용자 중단 소개 검수와 untracked 산출물 보존.

검사/실패: 테스트·빌드·린트·브라우저 기능 테스트 미실행. 앞서 stale local DB에서42703으로 실패한 접근은 운영 연결로 교체했다. 웹 도구 open 접근 실패 후 일반HTTP 읽기를 사용했다. 임시 도구 /private/tmp/nomorevibe-home-audit-20261011.py와 .mjs는 비밀을 출력하지 않고 read-only 조회만 수행한다. 운영 결과는 보고서에 표본 시각과 함께 기록했다. 독립 서브에이전트 보고서 읽기 리뷰 완료: 실패/성공 표현과 ‘관측 간격 상한만으로 공통24시간 창은 만들 수 없음’ 두 문구를 수정했다. 문서 diff 검사 통과, 커밋/PR/필수CI 병합을 진행한다.

정확한 다음 명령:
```sh
cd /private/tmp/nomorevibe-home-criteria-audit-20261011
git diff --check
git diff --stat
git add docs/CODEX_HANDOFF.md docs/operations/2026-10-12-home-criteria-audit.md
git commit -m 'docs: audit home new and rising criteria'
git push -u origin docs/home-criteria-audit-20261011
gh pr create --base main --head docs/home-criteria-audit-20261011 --title 'docs: audit home new and rising project criteria' --body-file /private/tmp/nomorevibe-home-criteria-audit-pr-body.md
```

### 2026-10-12 — 8시간 독립 관측 정책·PR 제안, GitHub App 수동 키 인계

현재 목적: 사용자가 검토 보고서를 바탕으로 수정 범위를 PR별로 보고하고 급상승의 스타 구간/비교 기간/표기를 명확히 제안하라고 요청했다. 이어 **매시간 대신8시간**, 발굴과 독립된 관측 스케줄·DB 스키마를 지정했다. 앱 설정은 gpt-6.1-sol/xhigh 서브에이전트에 맡기도록 명시 요청했다.

완료: 앞 검토 PR367은 head08238d7/최신-base298eb926의 필수 CI38150052766 check 성공 후 main240cbdfd로 병합했고 사용자 main을 fast-forward했다. 새 제안은 독립 worktree /private/tmp/nomorevibe-home-ranking-policy-proposal-20261012, branch docs/home-ranking-policy-proposal-20261012의 docs/superpowers/specs/2026-10-12-home-ranking-policy-proposal.md에 작성했다. 수정 파일은 그 제안과 이 handoff뿐이다. 코드/DB/운영 순위·스케줄 변경 없음.

주요 판단: 8시간 갱신 및 관측 독립은 사용자 지정, 스타50~1,999·전일동시간대 순증가10이상·00/08/16KST 집계는 나머지 추천 기준이다. 회차직전1시간에 고정 대상만관측, 동일제품·저장소의24시간전회차 비교(실측23~25시간)를 사용하므로 표기는 ‘전일 대비 스타 급상승’이다. 관측값을 정확한24시간 이벤트 총계로 표시하지 않는다. 회차/관측2개표, 닫힌회차·정책불변, 신규발굴다음회차+24시간이력확보후진입, 공개차단즉시숨김을 제안했다. 기존20시간product-stars-refresh writer는 보존한다(8시간으로단순변경하면20시간 baseline 이동이안되는함정). 별도관측 job/기존 crawler 별도stars lane/공유lease·quota를사용하고 추가서버를전제하지않는다.

PR 제안:01 신규생성일·양쪽경계·생성일표시·같은범위모두보기;02 독립관측job+2개스키마+불변회차;03 T/T−24시간비교·고정순위조회·회차캐시;04 새이름/전일대비증가/집계시각/자료부족UI.01은독립,02→자료축적→03→04 순서다. 앱코드구현은 아직 요청/합의 범위가 아니라 기준과PR제안을 보고하는 단계다.

운영 READ ONLY 추가 표본00:40KST: 정상 기본공개저장소36,314, 스타50~1,999/archived=false3,556개. 하루3회추가관측10,668건, 매시간85,344건보다87.5% 감소.50개묶음 약72요청/회·216/일,7일약74,676관측행은산술추정이다. 실제API비용·수집완료시간·성공률은 측정결과가아니다. 테스트/빌드/브라우저기능검사미실행, 코드·운영설정변경없음. 표본시각별후보변화와실패를사실대로제안에기록했다.

GitHub App 후속: 두 앱생성·Anyaccount·권한·콜백·webhook/SSL·expiringtoken설정은 서브에이전트가nativeChrome으로확인했다. Star AppID5275277/ClientIDIv23liBh5c8iGzZr8Dj6/slugnomorevibe-star, Feedback AppID5275280/ClientIDIv23livP6lwafpUbq6uf/slugnomorevibe-feedback. 확인시점에는 두Clientsecrets0/Keypairs0이며 생성PEM다운로드없음. 사용자의generate완료표현과차이가있어‘확인시점’으로안내했다. Resend기존세션·발신도메인은미확인, 다른사이트로그인/등록은하지않았다.

브라우저 도구mcp__cua_repl Computer Use Confirmation Policy 명시: “Changing a password or other authentication credential: Ask the user to take over before any new credential is entered, and have them complete the entry, confirmation, and submission steps themselves.” 이에 새키생성/입력/제출은사용자가직접완료하도록인계했다. 자동승인review rejection이아니며 스킬승인규칙에서나온중단도아니다. 비밀키·PEM은채팅으로요청하지않는다.

안전한로컬입력파일 /private/tmp/nomorevibe-integration-credentials-gz7qjgkf/credentials.env: 디렉터리0700/파일0600. 공개앱식별자와서버내부 PUBLIC_AUTH_SECRET/GITHUB_INTEGRATION_SECRET 및서로다른두webhooksecret을각48바이트안전랜덤으로준비했다. 기존nonblank값보존·편집충돌감지·atomicreplace·권한확인을했고 실제값은출력/커밋하지않았다. 남은5입력은 LOGIN_EMAIL_API_KEY/LOGIN_EMAIL_FROM, 두APP_CLIENT_SECRET, staging전용 GITHUB_FEEDBACK_APP_PRIVATE_KEY_FILE(다운로드PEM경로)다. 공급자유효성·메일/스타/Issue동작은미검증. 네flags는false이고운영주입/배포없음. 준비webhook값은사용자가각General에서직접붙여넣고Save해야한다.

다음 단계: 제안문서 self-review·diffcheck 후 docs-only PR을 만든다. 최신-base 필수CI 성공뒤 문서만병합하고사용자main을fast-forward한다. 사용자정책승인전구현하지않는다. 앱credential 파일의입력완료답변이오면 값을출력하지말고필수키존재·길이·distinct·PEM형식·provider전제를점검한다. 두웹14키와 publisher/maintenance네앱의Feedback ID/PEM/primaryorigin을사전검토한범위로주입하되처음에는flagsfalse, 준비가완료된기능만후속활성화한다. 새로운마이그레이션은아직작성/적용하지않았다. paused소개검수·사용자untracked산출물보존.

정확한 명령:
```sh
cd /private/tmp/nomorevibe-home-ranking-policy-proposal-20261012
git diff --check
git add docs/CODEX_HANDOFF.md docs/superpowers/specs/2026-10-12-home-ranking-policy-proposal.md
git diff --cached --check
git commit -m 'docs: propose eight-hour independent star observations'
git push -u origin docs/home-ranking-policy-proposal-20261012
gh pr create --base main --head docs/home-ranking-policy-proposal-20261012 --title 'docs: propose eight-hour independent star observations' --body-file /private/tmp/nomorevibe-home-ranking-policy-pr-body.md
```

### 2026-10-12 — 사용자 생성 PEM 연결, 문서 PR368

사용자가 두 secret 생성 완료와 Feedback PEM 경로 /Users/jr/Downloads/nomorevibe-feedback.2026-10-11.private-key.pem 을 제공했다. 서브에이전트가 값 출력 없이 Node crypto로 유효한 RSA private PEM/충분한 키 크기를 확인했다. 원본은 보존하고 staging 디렉터리에 0600 feedback.private-key.pem 사본을 만든 뒤 credentials.env의 PRIVATE_KEY_FILE을 연결했다. 기존 nonblank 값 보존·편집 충돌 감지·atomic replace·파일0600/디렉터리0700 확인 완료. PEM 원문·해시·secret은 기록하지 않았다.

현재 누락은 두 APP_CLIENT_SECRET과 LOGIN_EMAIL_API_KEY/LOGIN_EMAIL_FROM 네 입력이다. 생성 완료와 로컬 입력 완료를 구별한다. 사용자에게 Client secret 보관 파일 경로 또는 staging 직접 입력 후 완료 답변을 async로 요청했다. 값 자체를 채팅에 요청하지 않았다. 운영 주입·flag ON·브라우저 자격증명 생성/Save·기능 테스트는 하지 않았다. 사용자 입력이 도착하면 준비 상태를 다시 메모리에서 확인한다.

제안문서와 앞 handoff를 head88778cd로 커밋·push하고 PR368을 만들었다. 최신-base240cbdfd에서 CI38153698272의 필수 check 성공(문서용 quality/integration/image 발행 skip). 이 추가 기록을 push한 후 **새 head의 필수 CI를 다시 확인**하고 정상 병합한다. 문서 병합은 정책 구현/운영 활성화가 아니다. 다음 명령: git diff --check; handoff만 커밋/push; gh pr checks 368; gh pr view 368 --json headRefOid,baseRefOid,mergeStateStatus,statusCheckRollup. 최신 main/CI를 확인한 뒤 gh pr merge 368 --merge --match-head-commit <확인한HEAD> 하고 사용자 root main을 fast-forward한다.

### 2026-10-12 — .env.local Client Secret 연결

사용자가 두 secret을 root `.env.local`에 저장했다고 명시했다. integration_reactivation(gpt-6.1-sol/xhigh)이 해당 파일에서 `GITHUB_STAR_SECRET`과 `GITHUB_FEEDBACK_SECRET`의 존재를 확인했고, Root는 사용자 생성 맥락에 따라 각 `GITHUB_*_APP_CLIENT_SECRET`으로만 매핑하도록 승인했다. staging 반영 후 원본 바이트 보존·대상 값 일치·0600/0700·12개 GitHub/내부 키 존재를 확인했다. 웹훅 값으로 매핑하거나 기존 DB/collector/admin 인증값을 복사하지 않았다. `.env.local`에 Resend/EMAIL/MAIL/SMTP 관련 필드는 없으며 현재 누락은 LOGIN_EMAIL_API_KEY/LOGIN_EMAIL_FROM 두 개다. 필요한 이름과 검증 발신 주소를 async로 요청했다. 비밀값 원문은 요청/출력/커밋하지 않았다.

Feedback PEM은 메모리 JWT를 사용한 GitHub READ ONLY GET /app에서 HTTP200/App5275280 일치까지 확인했다. 실제 이메일·OAuth·스타·Issue·웹훅 기능 테스트는 하지 않았다. 준비된 값을 웹2/publisher2/maintenance2 저장 설정에만 주입하는 임시 helper/preflight를 서브에이전트가 준비 중이다. Root 코드 검토 전 쓰기 금지, 배포/기능 ON 금지. 메일·사용자 직접 웹훅 secret Save가 준비된 후 실행 반영을 함께 진행한다. 별도 정책 제안/운영 상태 문서를 검토했고 git diff --check 통과, 로컬 테스트/빌드/E2E 미실행.

수정 파일은 정책 제안, 이 handoff, docs/operations/2026-10-11-star-feedback-reactivation.md의 최신 키 상태다. PR368 head d752320의 최신-base240cbdfd 필수 CI38153917814 check가 성공했다. 이 추가 기록을 push하면 새 head에 대해 다시 확인해야 한다. 정책은 여전히 제안 단계이며 DB·스케줄·앱 코드를 작성/변경하지 않았다. 사용자 untracked PPT/prototypes 및 paused 소개 검수는 보존한다.

### 2026-10-12 01:21 KST — 준비된 App 키 운영 저장 설정 반영

Root가 /private/tmp/nomorevibe-integration-env-stage-20261012.py를 읽고 두 Client Secret distinct 및 새 PUBLIC_AUTH_SECRET/GITHUB_INTEGRATION_SECRET의 기존 관리자 AUTH_SECRET 재사용 방지 guard를 추가하게 한 뒤 다시 검토했다. read-only preflight의 새 rollback snapshot /private/tmp/nomorevibe-integration-env-preflight-uf3b5sr8/before.json은 상위0700/파일0600이다. 내용 출력/커밋 금지. 이 snapshot으로 --apply를 승인했고 서브에이전트가 application.saveEnvironment만 호출해 6앱을 모두 저장했다. 오류/부분 실패 없이 완료했다.

01:21:47KST 별도 fresh GET 확인: 두웹12키존재·두웹간12값일치, worker4개FeedbackID/PEM/origin존재, 전체6앱FeedbackID/PEM/primaryorigin일치. 네flags모든6앱명시false. 비대상env·이미지·source·replicas·기존credential·RELEASE_TAG 보존, applicationStatus=done 확인. saveDockerProvider/deploy/메일/스타/Issue/제공자설정 변경은 하지 않았다. **저장설정만 반영했으며 runtime 배포/키 전달·OAuth·기능 성공은 아직 검증하지 않았다.**

남은 일: 사용자에게 요청한 LOGIN_EMAIL_API_KEY/LOGIN_EMAIL_FROM 및 각 GitHub General의 staging 웹훅 secret 직접 입력·Save 확인. 현재 helper는 메일 키 주입이나 flag ON/배포를 하지 않는 목적이다. 입력이 추가되면 별도 최신 snapshot·원본 설정 검토 후 메일을 웹2앱에 반영하고, runbook의 공통 키·origin·publisher/maintenance 실행 릴리스 요건을 확인해 배포/활성화한다. 과거 apply snapshot을 그대로 재실행하지 않는다. 기능 테스트는 사용자 담당, paused소개검수 유지.

다음 문서 마무리 명령:
```sh
cd /private/tmp/nomorevibe-home-ranking-policy-proposal-20261012
git diff --check
git add docs/CODEX_HANDOFF.md docs/operations/2026-10-11-star-feedback-reactivation.md
git commit -m 'docs: record GitHub app credential staging'
git push
gh pr edit 368 --body-file /private/tmp/nomorevibe-home-ranking-policy-pr-body.md
gh pr checks 368
gh pr view 368 --json headRefOid,baseRefOid,mergeStateStatus,statusCheckRollup
```
최신-base 필수CI가 성공한 실제head를 --match-head-commit으로 정상병합한 후 root main을 fast-forward한다. 홈 정책 보고서 링크를 사용자에게 전달하되 실제 신규/급상승 코드가 아직 변경되지 않았음을 알린다.


### 2026-10-12 — 승인된 홈 PR01~04 병렬 구현 진행

현재 목적: 사용자가 API-key 입력을 제외하고 홈 기준 수정 PR01~04를 gpt-6.1-sol/xhigh 서브에이전트 병렬로 구현하고 Root가 충돌 관리·코드 리뷰·최종 보고하도록 승인했다. PR368은 필수 CI 성공 후 main674c62bd615a7e2ed3039a9745905295b1a50c16으로 병합됐다. 추천 기준(50~1,999스타, 전일 동시간대 순증가10이상, KST00/08/16 집계)을 구현한다. 실제 기능 테스트는 사용자 담당이며 로컬 테스트·typecheck·lint·build·E2E를 실행하지 않는다. 필요한 보호 main 원격 CI와 소스/diff 검토는 구분해 보고한다.

독립 worktree와 소유권: /private/tmp/nomorevibe-home-new-20261012 (feat/home-new-repository-birth-20261012, home_new)은 신규 저장소 생성일 조회·전체 목록·기존 fixture 최소 수정 8파일; /private/tmp/nomorevibe-home-observer-20261012 (feat/star-observation-cycles-20261012, home_observer)은 관측 스키마·마이그레이션0073·정책·job·worker·유지보수 연결; /private/tmp/nomorevibe-home-growth-20261012 (feat/star-growth-query-20261012, home_growth)은 신규 star-growth.ts 독립 조회만; /private/tmp/nomorevibe-home-integration-20261012 (feat/home-policy-integration-20261012)은 Root 문서·통합 관리. 아직 구현 커밋/PR/배포/DB 마이그레이션은 없다. PR04 UI는 PR01 소스 검토 완료 후 그 커밋 기반으로 별도 에이전트가 작성하도록 한다. app/page.tsx 등 공통 UI 파일을 동시에 수정하지 않는다.

작성된 코드: PR01 GitHub 저장소 생성 시각의 완료7일 양쪽 경계와 동일 조건 /?new=1&page=N, 생성일 카드 표시. PR02 회차/관측 두 표와 최소 repo_link_version 재연결 트리거, 공개 대상 고정·회차 직전1시간 관측·3회 재시도·회차 종료·7일 정리. 기존 job 엔진을 재사용해 분당 DB 재개 점검하지만 GitHub 수집은 하루3회 관측창에만 한다. PR03 닫힌 T/T−24시간 회차의 실측23~25시간 비교·정책 고정·정렬/페이지/캐시·자료 부족 상태. 현재 소스 리뷰 중이며 성공 확정이 아니다. 비공개 저장소 감지와 실제 GitHub 저장소 식별자의 필요성을 추가 검토한다.

검사: 에이전트 git diff --check와 Root 소스 읽기만 수행했다. 독립 CLI PR01 리뷰가 session51256에서 진행 중이며 모델 gpt-6.1-sol, effort xhigh, read-only/ephemeral; 로그와 결과는 /private/tmp/nomorevibe-home-reviews.5VapVm/pr01-log.txt 및 pr01-result.txt. 테스트 통과 주장 금지. PR02/03 독립 리뷰와 PR04 구현·검토, 정상 PR/최신-base CI, 배포 계획 구분이 남았다. 자료 축적은 최소24시간/4회차가 필요하며 코드 완료를 급상승 자료 준비와 혼동하지 않는다.

운영 App 키 저장 설정은 앞 기록대로 준비된6앱/flags false이며 이번 구현은 API-key 입력·메일 키·브라우저 webhook Save·기능 ON과 무관하다. 사용자 untracked PPT/prototypes와 중단한 소개 검수 보존. 실패 접근은 새로 없으며 stale 로컬 DB를 운영 마이그레이션에 사용하지 않는다.

다음 정확한 명령: cd /private/tmp/nomorevibe-home-integration-20261012; git diff --check; git status --short. PR01 결과는 cat /private/tmp/nomorevibe-home-reviews.5VapVm/pr01-result.txt (완료 후). 각 worktree 변경을 Root가 검토·stage·git diff --cached --check 후 커밋하고, 의존 순서01 독립/02→03→04로 통합한다. codex 호출 시 반드시 -m gpt-6.1-sol -c model_reasoning_effort=xhigh. 비밀 .env/PEM/운영 rollback snapshot은 출력/커밋하지 않는다.


진행 추가: PR01 CLI 소스 리뷰 완료, P2 현재URL자료 누락/P3 Date decoder 유실/P3 신규뷰헤더활성표시3건을 수정한다. 신규 direct lower(repo) lookup의 인덱스 추가를 PR01 migration0073으로 지시했으며 관측 migration은0074로 Root가 순차 재번호해야 한다. UI는 /private/tmp/nomorevibe-home-ui-20261012 feat/star-growth-ui-20261012의 사전 스냅샷0937a1e 기반 /root/home_growth_ui(gpt-6.1-sol/xhigh)가 작성 중. UI 공통 파일만소유, PR01 추가backendfix는 Root가합친다. PR02 stageddiff 독립CLI session15691/pr02-result.txt, PR03 stageddiff 독립CLI session21833/pr03-result.txt, 둘다 /private/tmp/nomorevibe-home-reviews.5VapVm에 저장. PR02 관측에 GitHub node repositoryId+isPrivate guard 보완, PR03 양쪽 repositoryId 일치추가. 기존 회차policyVersion상수불일치 gate 제거. 새 DB migration/배포/로컬테스트는 아직 미실행.


2026-10-12 진행: PR01 추가인덱스/현재URL/Date변환의독립범위재리뷰 추가지적없음. 실제 PR01커밋5231fbb push/PR369 생성, CI38157584835 진행중. Root통합branch에는동일내용db3f65c로cherry-pick. PR03 독립CLI추가지적없음, e3031a2커밋(아직push/PR없음). PR04 소스8파일완료/stage하고CLI session65978/pr04-result.txt 검토중. PR02 독립CLI P2/highconfidence2건(cooldown재시도소모/토큰준비후timeout으로마감후requeststart) 수정지시, scopegithub.ts/github-accounts.ts/github-apps.ts deadline선택옵션으로최소확장. 기존jobcatalog3→4lanefixture만수정. 마이그레이션실행/배포/로컬테스트없음. 다음: PR02수정완료후새코드만재리뷰하고0074로번호조정, PR01최신baseCI→정상병합, PR02→03→04순차의존PR. PR04홈/모두보기는code완료와24시간warmup운영반영을구별해최종보고.


2026-10-12 02시경: PR369 head5231fbb/최신base674c62b의 필수 CI38157584835 scope/quality/integration3개/check 모두 실제success확인, 정상merge요청했다. PR04 CLI staged8파일소스검토 추가지적없음, UIcommit완료(아래후속기록에SHA). PR03 reader도소스검토추가지적없음. PR02 P2수정은콜백 인증/쿼터waitreserveattempt반환+선택적절대deadline을공유collector의tokenmint부터HTTPdispatch까지전달하며, 기존callers/credential기본동작보존방식으로작성중. 코드완료후Root복사통합branch에서observermigration74/journal순서해결, PR02/03/04 actualdeliverybranch와원격CI결과는아직미확정.


최신 전달 상태: PR369은 2026-10-12 02:01KST경 main9424d6e6cebe3bbfd4311461275d3063def9928b로정상병합, 사용자rootmain도같은SHA로ff. Root통합branch가origin/main을정상merge했으며 사용자untracked산출물보존. PR04UIcommit03a2b73(사전PR01스냅샷0937a1e의후속), PR03e3031a2는아직deliveryPR없음. Root통합worktree에관측16파일복사하고SQL파일0074_product_star_observations.sql, journalidx74/when1792700000000으로번호충돌해결(아직commit없음).

관측재리뷰추가지적P2/highconfidence: 느린Appmint가10초준비예산전부를쓰면정상PAT/cachedApp으로도GraphQL을못시작함. home_observer에deadline선택경로에서dispatch5초를남겨optionalAppmint예산을제한하고,짧은예산종료시공유실패캐시를오염시키거나뒤cached토큰을건너뛰지않도록최소수정지시. 아직재리뷰완료아님. 완료후Root통합에서github-apps/accounts/request최신수정만다시복사해야함. PR02최종stage검토→최소경로독립재리뷰→commit/deliverybranch/PR370(실제번호확인), PR03/04순차의존PR/필수CI가남음.

독립리뷰파일: /private/tmp/nomorevibe-home-reviews.5VapVm/pr01-result.txt,pr01-fix-result.txt,pr02-result.txt,pr02-fix-result.txt,pr03-result.txt,pr04-result.txt. PR02-fixCLI session98167은완료됐으며result에는위느린mint지적이있음. PR04 CLI session65978완료추가지적없음. 추가CLI도gpt-6.1-sol/xhigh/read-only/실행금지로한다. 운영migration/deploy/기능ON/테스트미실행. 코드PRCI는GitHub필수검사만실제로확인해보고.


구현 phase 완료 상태: 모든 에이전트작성완료. Root가최종관측16파일을0074로통합하고a9887bf커밋/deliveryfeat/home-star-observations-20261012/push/PR370생성. PR03e3031a2를54e6b2a로cherry-pick, deliveryfeat/home-star-growth-reader-20261012branch준비. PR04UI03a2b73의8파일을no-commitcherry-pick해stage, Rootdocs도아래최종UIcommit에포함예정. 마지막auth-empty보완은중복return없이optionaldeadline&& (예산종료||accounts0)로3줄작동을합쳤다. 선택적mintreserve5s+후행cachedtoken취합경로 독립재리뷰추가지적없음, 마지막auth-emptyFocusedCLI session11338/pr02-final-result.txt진행중. 기능테스트미실행, gitdiffcachedcheck0.

다음정확한명령: cd /private/tmp/nomorevibe-home-integration-20261012; git add app/page.tsx app/rising/page.tsx components/home/CompactCard.tsx components/home/CompactRow.tsx components/home/MethodologyDialog.tsx components/home/SiteHeader.tsx components/home/StarGrowthMetric.tsx components/home/StarGrowthSummary.tsx docs/CODEX_HANDOFF.md docs/operations/2026-10-12-home-ranking-implementation.md; git diff --cached --check; git commit -m 'feat: present daily star growth with cycle evidence'. PR370 최신 base9424d6e/HEADa9887bf의 필수CI성공확인후정상merge하고origin/main을fetch/Root통합merge. PR03deliverybranch를Root통합의mainmergecommit까지ff한뒤push/mainbasePR생성. PR03병합후같은방법으로PR04전달. 임의force-push/보호규칙우회금지. 사용자rootmain은trackedclean확인후ff,untracked보존. 운영migration/deploy/24시간warmup아직없으며CODE완료와다르게보고한다.


전달 명령 정정(아래가 최신): Root 통합 HEAD에는 PR04까지 들어 있으므로 PR03 branch를 Root HEAD로 이동시키지 않는다. PR03/04 전용 delivery worktree를 만들었다. /private/tmp/nomorevibe-home-reader-delivery-20261012 = feat/home-star-growth-reader-20261012 HEAD54e6b2a(조회1파일만), /private/tmp/nomorevibe-home-ui-delivery-20261012 = feat/home-star-growth-ui-20261012 HEADb270d42(UI8+Root문서2). PR370 최신base9424d6e의 check 성공 후 정상merge, git fetch origin main, reader-delivery에서 git merge --no-edit origin/main; git push -u origin feat/home-star-growth-reader-20261012; gh pr create --base main --head feat/home-star-growth-reader-20261012 --title 'feat(stars): 닫힌 회차 기반 전일 대비 상승 조회' --body-file /private/tmp/nomorevibe-home-reviews.5VapVm/pr03-body.md. PR03 최신baseCI/병합 후 ui-delivery에서 fetch/mergeoriginmain 후 별도push/PR04로 전달한다. 각 PR diff가 reader1파일/UI8+문서2인지 확인한다. 최신 auth-empty통합/0074journal순서의 독립최종소스리뷰 완료 추가지적없음. API-key/환경/DB/배포 변경없음.


2026-10-12 전달진행: PR370 head a9887bfc44cefe9ed02fcb6dd4ecbc5565e39402/최신base9424d6e의 CI38158817772 scope/quality/integration3개/check 모두실제성공, 정상병합main de4c894. reader-delivery에서origin/main정상merge후diff는star-growth.ts239줄1파일만확인, push/PR371 생성진행(최신HEAD아래최종기록참조). ui-delivery도동일mainmerge완료이며DB74와reader+UI의파일충돌없음. PR371필수CI/정상병합후ui-delivery mainmerge하고PR04를전달한다. Runtime배포/DB적용/API-key입력/기능테스트없음.


## 2026-10-12 PR03 merged; PR04 UI delivery pending

- Objective: finish the four home-ranking implementation PRs, excluding API-key input and feature activation.
- PR369 (repository creation date) and PR370 (independent 8-hour observations) are merged. PR371 (24-hour star-growth reader) also merged as `01b9d6d`; its required CI run `38159154251` passed scope, quality, all three integration shards, and check against latest base `de4c894`.
- PR04 delivery branch: `feat/home-star-growth-ui-20261012`; worktree `/private/tmp/nomorevibe-home-ui-delivery-20261012`. UI source review is complete with no remaining actionable findings. Eight UI files and two progress documents remain to submit for required remote CI and merge.
- A document-update error in `dcf6d1b` overwrote this handoff with the implementation report. Restored the complete handoff history from that commit's parent before opening the UI PR; no source files were affected.
- No local tests, typecheck, lint, build, or browser testing were executed; user will perform functional testing. Protected-main remote CI is the only automated test execution recorded here. No operational database migration, deployment, or feature-flag activation has been performed.
- Remaining: create and review PR04, wait for required remote CI, merge with matching head, update completion report and local project journal, fast-forward the user's main checkout. Runtime application and a minimum 24-hour observation warm-up remain separate operational work.
- Next commands (in the UI delivery worktree): `git diff origin/main...HEAD --stat`; `gh pr create --base main --head feat/home-star-growth-ui-20261012 --title 'feat(home): 전일 대비 스타 급상승과 회차별 전체 목록' --body-file /private/tmp/nomorevibe-home-reviews.5VapVm/pr04-body.md`; then `gh pr checks <actual-number>` and merge only after the required check succeeds.


### 2026-10-12 PR04 required CI failure investigation

PR372 headbd378705/최신base01b9d6d의 CI38159743423는 통합3개 모두성공, quality기존화면6개실패/check실패다. tests/home-unclaimed.test.tsx의5실패는전용reader mock누락·예전getPublicList strip호출·피드앞5개skip기대·count0fixture이고 tests/p12-head-chrome.test.tsx의1실패는옛/#rising링크기대다. 제품계약을바꾸지않고기존fixture/기대값만최소수정한다. home_growth_ui가deliveryworktree의이두tests파일만소유하고Root는문서만소유한다. 새테스트/로컬실행/커밋은에이전트에게금지했다. 원문을 /private/tmp/nomorevibe-home-reviews.5VapVm/pr04-quality-failure.log 에저장했다. Root가수정diff리뷰후필수CI다시확인할것.

문서이력덮어쓰기는bd37870의새일반커밋으로복원해PRdiff가handoff53줄추가/삭제0임을확인했다. forcepush/이력재작성없음. Root가implementationreport를현재상태중심으로정리했고handoff의원래이력은보존한다. RuntimeDB/deploy/기능ON없음. 다음: deliveryworktree에서 git diff -- tests/home-unclaimed.test.tsx tests/p12-head-chrome.test.tsx; git diff --check; 해당tests2+docs2만stage/commit/push; gh pr checks 372; 최신head/base/check확인후정상merge.


PR04 fixture 보완 완료: Root가 tests2개diff를 읽고 기존목적을보존한전용getStarGrowthPage mock/typedfixture, recent feed count1, fallbackcount8/offset0·9, 새제목과실제띠렌더, /rising활성·new=1비활성기대를확인했다. 새it/test케이스와로컬실행없음. git diff --check실제exit0. tests2+docs2최소커밋push후새HEAD의최신base원격CI결과로판단한다.


### 2026-10-12 — 홈 PR01~04 구현·리뷰·전달 완료 (최신 상태)

- 현재 목적: API-key 입력을 제외한 승인된 홈 기준 PR01~04의 병렬 구현·충돌 관리·부모 리뷰·최종 보고. 코드 단계 완료이며 운영 적용은 별도다. 모든 서브에이전트/독립 CLI는 gpt-6.1-sol/xhigh였다.
- 완료: PR369→370→371→372를 의존 순서대로 정상 병합. 마지막 main SHA `ccc7ed3b3ba168a67f7dbe09ba06325b88654b00`; 사용자 root main도 이 SHA로 fast-forward 완료. 원래 미추적 PPT/prototype 자료를 보존했다.
- 실제 필수 CI: PR369 run38157584835, PR370 run38158817772, PR371 run38159154251, PR372 최종 run38160248035 모두 scope/quality/integration3개/check success. PR372 head25f83db/최신base01b9d6d 확인 후 --match-head-commit 정상merge했다. PR372 첫 run38159743423 quality6실패/check실패도 기록했으며 기존 화면 fixture2파일 보완 후 새HEAD에서 성공했다.
- 검증 명령/결과: `git diff --check` 및 `git diff --cached --check` exit0; `gh pr checks 372 --watch --interval 10` exit0; `gh pr view 372 --json state,mergeCommit,mergedAt,headRefOid` MERGED/ccc7ed3 확인. 로컬 테스트/typecheck/lint/build/E2E/앱 실행은 사용자 지시로 미실행. 새 테스트 케이스 없음. 소스 재리뷰 추가 지적 없음.
- 수정 파일: PR369의 repository/view/신규 홈·CompactCard·Methodology·crawl-schema/0073/journal와 기존 integration fixture3개; PR370의 schema/0074/journal/policy/observation job/catalog/registry/click-rollup/worker, collector github-repositories/github/accounts/apps와 기존 fixture2개; PR371의 lib/domain/products/star-growth.ts; PR372의 app/page.tsx/app/rising/page.tsx, CompactCard/CompactRow/MethodologyDialog/SiteHeader/StarGrowthMetric/StarGrowthSummary, 기존 home-unclaimed/head-chrome fixture2개. 최종 상태 보고는 docs/operations/2026-10-12-home-ranking-implementation.md와 이 handoff다.
- 핵심 결정: 신규는 현재 GitHub 저장소 생성일의 KST완료7일/스타50이상; 급상승은 KST00/08/16 닫힌 T/T−24h, 실측23~25h, 회차스타50~1,999/+10이상, 연결버전/GitHubID 일치와 고정순위. 기존 job 엔진·별도stars lane·quota/lease를 재사용하고 분당 DB 재개점검과 하루3회 관측창의 GitHub수집을 구별한다. 기존20h writer/일반 StarMetric 유지.
- 실패/보완: 신규 현재URL누락/Date decoder 유실/헤더활성표시 및 관측 cooldown재시도소모/마감후dispatch/느린Appmint를 최소 수정하고 재리뷰했다. 문서 덮어쓰기 dcf6d1b는 bd37870 새 일반커밋으로 원래 handoff이력을 복원했으며 최종PR에는 역사 삭제 없음. forcepush/이력재작성 없음.
- 남은 운영 작업: 이미지 발행 확인→소비자 drain→migration0073/0074 한 번 적용·검증→관측워커 같은SHA 배포→최소24시간/4닫힌회차 자료축적→공개UI 전환 및 사용자 기능확인. 이번 단계에서 운영DB/migration/deploy/flagON/제공자설정/API-key 입력 없었음. Resend키/검증FROM과 사용자 직접 GitHub webhook Save는 기존 활성화대기항목. 스테이징에 저장한6앱 GitHub설정과 flags false 유지. paused소개검수 재개금지.
- 정확한 다음 읽기 명령 (사용자 root main): `git status --short --branch`; `git log -5 --oneline`; `gh run list --branch main --workflow CI --limit 3`; `cat docs/operations/2026-10-12-home-ranking-implementation.md`; `sed -n '90,150p' docs/operations/independent-workers-runbook.md`; `cat docs/operations/github-stars-feedback-runbook.md`. 실제 운영migration의직접DB설정은 최신 안전스냅샷으로 확인하고 stale로컬.env를 사용하지 않는다. 배포의 --migration-verified는실제적용성공후에만사용. 비밀 .env/PEM/rollbacksnapshot 출력/커밋금지.
- 로컬 프로젝트 일지: `/Users/jr/Library/CloudStorage/SynologyDrive-sync_data/Obsidian-Vault/프로젝트 일지/nomorevibe/2026-10-12 신규 프로젝트 기준과 8시간 스타 관측 구현.md`에 코드완료/운영미반영을 구별해 갱신한다.


### 2026-10-12 — Resend 없이 GitHub 로그인 구현 진행

- 현재 목적: 사용자 요청 “로그인 화면 만들고, Github 인증 구현해.” 기존 익명 GitHub OAuth가 계정/세션을 생성하는 구현은 이미 존재한다. 앞 답변에서 Resend가 모든 로그인에 필수라고 안내한 것은 잘못이며 이메일 인증에만 필요하다고 정정했다. GitHub 우선 로그인 UI와 선택적 이메일 설정, 배포 preflight의 잘못된 필수 메일 의존을 최소 수정한다.
- 작업 위치: `/private/tmp/nomorevibe-github-login-20261012`, branch `feat/github-login-without-resend-20261012`, base origin/main `192b5721415abe90bc9a6a7f02ac4ac068dac4d7`. 설계/계획 문서만 `f85ee63`으로 커밋했다. 아직 push/PR/코드 커밋 없음.
- 현재 수정 파일: app/login/page.tsx, components/auth/GithubConnection.tsx, lib/domain/accounts/email-delivery.ts, lib/domain/accounts/email-login.ts, scripts/ops/deploy_shared_images.py, tests/public-login-page.test.tsx, tests/e2e/github-user-connection.spec.ts. 문서와 이 handoff 후속 갱신이 남았다.
- 핵심 결정: 기존 state/PKCE/CSRF/토큰 암호화/콜백/계정 생성 경로 그대로 재사용. GET /api/auth/user/email/start는 이메일 발송 없이 익명 OAuth용 CSRF nonce를 제공한다. 기존 GITHUB_STAR_ENABLED가 GitHub 로그인도 제어한다. 이메일은 LOGIN_EMAIL_API_KEY와 LOGIN_EMAIL_FROM 둘 다 있을 때만 화면에 표시. 배포 검사에서 두 웹의 메일 값이 전부 없고 GitHub 로그인이 켜졌으면 허용하며 부분 입력/불일치는 거부한다. 새 API/스키마/의존성/플래그 없음.
- 검증: 설치된 Next Server/Client Components, Route Handlers, cookies 가이드와 실제 인증 소스를 읽었다. 이 코드 변경의 diff check/독립 CLI 리뷰/원격 CI는 아직 실행 전이다. 사용자 지시에 따라 새 테스트 케이스·로컬 test/typecheck/lint/build/E2E/브라우저 실행 없음. 기존 fixture와 selector만 변경했다.
- 남은 일: runbook/README의 메일 필수 설명 정정, diff/source 검토, gpt-6.1-sol/xhigh read-only CLI 리뷰, 필요한 최소 보완, 커밋/push/PR/최신-base 필수 원격 CI/정상 병합, 완료 handoff와 로컬 프로젝트 일지. 운영 환경·DB·배포·feature ON·provider Save 변경 없음. 실제 사용자 GitHub 로그인/스타/피드백 검증은 사용자 담당.
- 실패 접근: 기존 OAuth가 없는 것으로 가정해 중복 인증을 만들지 않았다. 이번 구현 오류/테스트 실패는 아직 확인되지 않았다. 기존 큰 handoff는 append로만 보존하고 보고서 변수 재사용으로 덮어쓰지 않는다.
- 정확한 다음 명령: `cd /private/tmp/nomorevibe-github-login-20261012`; `git diff -- app/login/page.tsx components/auth/GithubConnection.tsx lib/domain/accounts/email-delivery.ts lib/domain/accounts/email-login.ts scripts/ops/deploy_shared_images.py tests/public-login-page.test.tsx tests/e2e/github-user-connection.spec.ts`; `cat docs/operations/github-stars-feedback-runbook.md`; `git diff --check`. 독립 CLI는 반드시 `codex exec -m gpt-6.1-sol -c model_reasoning_effort=xhigh -s read-only --ephemeral`로 실행하고 테스트·앱 실행·비밀파일 읽기를 금지한다.


GitHub 로그인 소스 단계 완료: `git diff --check`와 `git diff --cached --check` 실제 exit0. gpt-6.1-sol/xhigh read-only 독립 CLI review 실제 exit0, 결과 “No actionable findings in the staged changes or relevant dependency paths.” 테스트·파일 수정·커밋은 리뷰에서도 미실행. 결과 파일 `/private/tmp/nomorevibe-github-login-review-mcz77dgw/result.txt`. 부모가 nonce GET/익명 계정 생성/세션 쿠키/returnTo와 기존 Python 부분 메일 거절 fixture를 대조했다. 불필요한 인증 재구현·새 테스트 없이 소스7파일과 README/runbook/기록/계획/handoff를 전달한다. 운영 쓰기 없음. 다음: 해당 staged 파일 커밋 후 `git push -u origin feat/github-login-without-resend-20261012`; `gh pr create --base main --head feat/github-login-without-resend-20261012 --title 'feat(auth): Resend 없이 GitHub 가입·로그인 제공' --body-file /private/tmp/nomorevibe-github-login-review-mcz77dgw/pr-body.md`; 최신 base 필수 CI와 head 확인 후 일반 merge.


### 2026-10-12 09:07 KST — GitHub 로그인 코드·리뷰·PR 반영 완료

- 현재 목적: 사용자 “로그인 화면 만들고, Github 인증 구현해.” 코드 단계 완료. 익명 GitHub 가입·로그인을 기존 OAuth/identity/session으로 재사용하고 메일 필수 UI/배포 검사만 최소 수정했다. 운영 활성화 성공은 아직 아니다.
- 완료: 설계 f85ee63·구현045db777d271157f6d01c5a8615adc7bbb5d9b4f 커밋/push, PR374 정상 병합. merge SHA `58a63a3bc180f3e9cce3670ebb5b52a11cf6c3ef`, mergedAt2026-10-12T00:06:12Z. 사용자 root main을 해당 SHA로 fast-forward했고 원래 미추적 PPT/prototypes를 보존했다. 완료 기록은 현재 `docs/github-login-completion-20261012` branch(/private/tmp/nomorevibe-github-login-20261012)에서 문서 전용 PR로 전달한다.
- 수정 파일: app/login/page.tsx, components/auth/GithubConnection.tsx, lib/domain/accounts/email-delivery.ts, lib/domain/accounts/email-login.ts, scripts/ops/deploy_shared_images.py, 기존 tests/public-login-page.test.tsx·tests/e2e/github-user-connection.spec.ts, README.md, GitHub runbook/재활성화 기록, 설계·계획, 이 handoff. 새 API/DB schema/의존성/플래그/테스트 케이스 없음.
- 결정: GitHub-first 로그인, 완전한 메일 pair일 때만 이메일 폼, signed-in 연결/해제 유지. 명시적 스타 동의·nonce GET·state/PKCE·Origin/CSRF·서버 토큰 교환/암호화·세션/returnTo 그대로. Python 배포 검사는 GitHub-only 메일 공백을 허용하되 부분 입력/값 불일치/로그인 수단 없음과 기존 App/키/역할 gate를 유지한다.
- 실제 검증: git diff --check/cached --check exit0. gpt-6.1-sol/xhigh read-only 독립 리뷰 exit0·수정 지적 없음(`/private/tmp/nomorevibe-github-login-review-mcz77dgw/result.txt`). PR374 최신 base192b572/head045db77의 원격 CI38186468194는 scope, quality(typegen/tsc/lint/unit/Python/build/bundle), integration3개, check 모두 success. GitGuardian도 success. gh pr checks374 --watch exit0 및 gh pr view의 CLEAN/latestbase/head 확인 후 --match-head-commit으로 일반 merge했다. 로컬 test/typecheck/lint/build/E2E/브라우저/실제 GitHub 로그인·스타·피드백은 사용자 지시로 미실행. 원격 CI를 실연동 성공으로 주장하지 않는다.
- 운영 fresh read: 2026-10-12T00:07:17UTC(09:07:17KST) Dokploy application.one만 읽음. 두 웹 저장release a91eecf, publisher2개8b608b2, maintenance2개650b341, 6개 앱 status done, 네 flag 모두 false. 저장 설정만 확인했으며 runtime/OAuth 성공 증거 아님. 이번 단계에서 env/provider Save/DB/migration/deploy/flagON/실제 외부 쓰기 없음. 증거 `/private/tmp/nomorevibe-github-login-review-mcz77dgw/operations-readonly.json`에는 role/status/release/flags만 저장하고 비밀값 없음.
- 실패/정정: Resend를 모든 인증의 필수로 안내했던 이전 답변을 정정했다. 운영 read 첫 Keychain 조회에서 account/service 인자를 반대로 넣어 credential unavailable로 끝났고, 기존 prod/배포 스크립트의 정확한 -a deploy.brut.bot/-s dokploy-api-key로 수정한 fresh read는 성공했다. 설정이나 비밀값에 변경/출력 없음. 이번 코드/필수 CI 실패 없음.
- 남은 일: 완료 문서 PR의 필수 check/정상 병합과 최종 root main fast-forward. 실제 운영 로그인/스타/피드백 ON은 실행 릴리스 반영·일치하는 키/원본 설정·GitHub provider webhook Save 확인 후 진행한다. 메일 키는 이메일 로그인 선택 시에만 필요하며 GitHub-only의 blocker로 다시 취급하지 않는다. 홈0073/0074 적용과 관측워커 배포/24시간·4닫힌회차 자료 축적의 별도 운영 절차를 보존한다. paused소개검수 재개금지.
- 정확한 다음 명령: 현재 worktree에서 `git diff --check`; docs3개만 stage/commit; `git push -u origin docs/github-login-completion-20261012`; `gh pr create --base main --head docs/github-login-completion-20261012 --title 'docs: record completed GitHub login implementation' --body-file /private/tmp/nomorevibe-github-login-review-mcz77dgw/completion-body.md`; 필수 check 성공 후 최신 head matching merge. 사용자 root에서 `git fetch origin main`; tracked clean 확인 후 `git merge --ff-only origin/main`; `git status --short --branch`. 운영 재개는 `cat docs/operations/github-stars-feedback-runbook.md`와 `cat docs/operations/2026-10-12-home-ranking-implementation.md`, `gh run list --branch main --workflow CI --limit 3`부터 읽는다. 비밀 staging/rollback snapshot을 출력·커밋하거나 과거 false용 --apply helper를 ON 용도로 재사용하지 않는다.
- 일지: `/Users/jr/Library/CloudStorage/SynologyDrive-sync_data/Obsidian-Vault/프로젝트 일지/nomorevibe/2026-10-12 Resend 없이 GitHub 로그인 구현.md`에 실제 CI/병합과 운영 미반영을 구별해 기록했다.


### 2026-10-12 — GitHub 웹훅 설정 진행 (Feedback 완료, Star 사용자 저장 대기)

- 목적: 사용자 “github 웹훅 설정해.” 두 앱의 기존 서버 저장 webhook secret을 제공자 설정에 적용. 현재 코드main9e5babe, 독립 문서worktree `/private/tmp/nomorevibe-webhook-docs-20261012`/branch `docs/github-webhook-config-20261012`. 애플리케이션 코드 변경 없음.
- 완료: CUA native Chrome Window 메뉴로 기존 GitHub App 창을 선택, Confirm access 재인증 요청. 사용자 “goTdj”(한국어 키보드 ‘했어’) 뒤 Feedback General 접근을 실제 확인했다. 두 앱 General의 URL·Active=1·SSL검증=1이 맞았다. secret은 UI에 입력하지 않음.
- Feedback: 저장웹2의 AppID/PEM/별도32자이상webhooksecret/origin을 메모리에서 대조. 제공 PEM과 저장 PEM 일치. OpenSSL로 5분JWT를 메모리 생성하고 GitHub GET/app ID5275280·slugnomorevibe-feedback·ownerJRVector9·Issueswrite/events[issues] 검증. 2026-10-12T01:09:05UTC API PATCH/app/hook/config HTTP200 후 fresh GET: URL https://nomorevibe.com/api/github/webhooks/feedback, content_type=json, insecure_ssl=0, secretConfigured=true. 전에는 false였다. 원문 secret/JWT/PEM 출력/커밋 없음.
- Star: 공개 GET/apps/nomorevibe-star에서 ID5275277/ownerJRVector9/metadata read/starring write/events[] 확인. General URL https://nomorevibe.com/api/github/webhooks/star/Active1/SSL1과 Secret 입력 필요 상태 확인. Star private PEM은 Downloads에 없음(Feedback와collector파일만). 새 credential 생성하지 않았다. CUA Hand-Off Required 규칙에 따라 새 Secret 입력·제출은 사용자에게 요청했으며 아직 저장 완료 답변을 받지 않았다. 준비 파일은 서버저장2웹과 일치하는 값 한 개를 포함한 `/private/tmp/nomorevibe-webhook-20261012-bhd0gmig/star-webhook-secret.txt`(파일0600/상위0700)이다. 사용자에게 파일 링크→Secret→Save changes→완료 답변을 async로 요청했다. 값은 채팅에 요청/출력하지 않았다.
- 도구/판단: 브라우저 UI는 CUA만 사용. browser skill의 다른 CLI UI 조작은 CUA 상위 지침에 따라 사용하지 않았다. 기존 Feedback JWT 공식 API는 UI 자격증명 인계 정책의 범위 밖이며 목적별 API 우선 원칙과 명시적 사용자 요청으로 적용했다. 모든 API TLS 검증·no redirect·오류코드만 출력. 외부 쓰기는 Feedback hook configuration PATCH 한 번뿐이다.
- 실패 접근: 사용자 Chrome 창 전환으로 초기 General click과 Star tab 조회가 달라져 fresh AX와 Window 메뉴로 올바른 창을 다시 선택했다. native scroll은 다중모니터 음수좌표 windowNotFoundAtPosition으로 실패해 추가 credential/UI 행동 없이 인계했다. 첫 credentials 페이지 자동 AX에서 기존 client secret이 나타났으므로 이후 모든 관측은 emit:false+allowlist/Secret값숨김으로 제한했다. 해당 값 재사용/인용/출력/회전하지 않았다.
- 검증: 실제 제공자 GET/PATCH/GET 설정 조회와 파일 권한 stat700/600 확인. 앱 테스트/typecheck/lint/build/E2E/스타/Issue/메일/redelivery 미실행. provider 저장을 runtime 서명 검증 성공으로 해석하지 않는다. env·DB·배포·featureflags·원본.env.local/PEM·기존paused소개검수 유지.
- 수정: docs/operations/2026-10-11-star-feedback-reactivation.md에 실제 Feedback 완료와 Star 대기를 append하고 이 handoff도 원래 이력 보존해 append. 아직 이 문서단계 diffcheck/commit/push/PR 없음.
- 남은 일: 사용자 Star Secret 입력·Save 완료 후 fresh Star General reload/저장 표시와 URL·Active·SSL 확인, Feedback 설정 fresh GET 재확인. docs의 Star 대기 상태를 실제 결과로 추가 갱신하고 docs-only PR/필수 CI/일반 merge, rootmain ff와 일지. 사용자 미답변이면 Secret 변경·Save를 agent가 대신하지 않는다. 운영 반영·로그인/스타/피드백 ON은 별도 작업이다.
- 정확한 다음 명령: `python3 /private/tmp/nomorevibe-webhook-20261012-bhd0gmig/configure.py`는 READ ONLY preflight(GET만)이며 --apply-feedback은 다시 실행할 필요 없다. 결과 `/private/tmp/nomorevibe-webhook-20261012-bhd0gmig/result.json`은 key값없이metadata만 있다. CUA 상태는 ghChrome binding이며 사용자 Chrome 창 전환을 고려해 fresh AX로 올바른 GitHub 창을 선택하고 secret 값을 emit하지 않는다. `cd /private/tmp/nomorevibe-webhook-docs-20261012`; `git diff --check`; `git diff --stat`; docs2개만 stage/commit/push 후 정상PR. secret one-value 파일/임시script/credential원본/rollback snapshot 커밋 금지.


### 2026-10-12 10:32 KST — 사용자 저장 답변 뒤 Star 재확인

- 목적/현재 상태: GitHub provider 웹훅 설정 계속. Feedback API 저장은 완료, Star Secret은 아직 저장 확인 불가. 사용자 “했어”를 설정 성공 증거로 단독 사용하지 않았다.
- 완료: CUA TextEdit에서 요청한 star-webhook-secret.txt 파일 열림을 window title로 확인. emit:false로 키를 채팅에 출력하지 않음. GitHub Window 메뉴로 올바른 창을 활성화해 Star General 선택, reload 후 URL `/api/github/webhooks/star`, Active1, SSL1 확인. Secret 입력란/설정 안내가 남고 Change secret은 없었다. 사용자에게 현재 Star 화면에서 Secret 붙여넣기/Save를 다시 async 요청. 새 인증정보 입력·제출은 CUA Hand-Off Required 규칙상 사용자 직접.
- Feedback 실제 read: 2026-10-12T01:27:52UTC READ ONLY configure.py exit0 및 추가 GET exit0. Secret configured true, JSON, SSL, 정상URL, events[issues]. GET secret은 masked라 서버 원문 equality를 이 조회만으로 판단하지 않는다. 사용자 어느 앱에 저장했는지 추정하지 않았다. 추가 PATCH/env/deploy/flags/DB/write-test 없음.
- 실패 접근: Chrome tab/키보드 행동은 user changed 경고 후 실제 변경 없음. fresh AX→Window 메뉴→정확한 창 활성화→Star tab→reload 방식 성공. 이후 AX가 제목만 반환해 credential 입력/화면 캡처를 강행하지 않았다. 파일 picker도 fresh 관측으로 실제 파일 선택 후 열림 확인.
- 수정/검증: operations 기록과 이 handoff append만. 이전 git diff --check 실제 exit0, 새 append 뒤 다시 수행한다. 테스트/typecheck/lint/build/E2E/redelivery 미실행. 현재 tracked app 코드 불변, 문서2개만 uncommitted, PR/커밋/push 아직 없음.
- 남은 일: Star 사용자 저장 완료 답변 뒤 persisted Change secret/URL/Active/SSL 확인. 필요하면 Feedback canonical secret 재설정은 공식API를 검토하되 불일치 사실을 masked GET으로 주장하지 않는다. 실제 결과 문서 반영→docs-only PR/필수check/일반merge→rootmain ff. 실행배포/4플래그ON 별도.
- 정확한 다음 명령: `cd /private/tmp/nomorevibe-webhook-docs-20261012`; `git diff --check`; `git diff --stat`; 완료 후 docs2개만 stage/commit/push. 읽기 전용 provider 조회는 `python3 /private/tmp/nomorevibe-webhook-20261012-bhd0gmig/configure.py`. --apply-feedback을 반복할 이유는 현재 없다. 비밀파일/PEM/임시helper 커밋·출력 금지. CUA ghChrome fresh AX에서 Window 메뉴로 해당 GitHub 창 활성화한 뒤 Star 페이지를 확인할 것.


### 2026-10-12 10:36 KST — Star·Feedback 제공자 웹훅 설정 완료

- 목적/완료: 사용자 “다시 열어줘”에 TextEdit의 star-webhook-secret.txt 열림을 실제 window title로 확인. 이후 “했어” 답변 뒤 GitHub nomorevibe-star General의 Change secret/Active1/SSL1/정상URL을 읽고 정확한 Chrome 창 활성화 후 reload하여 같은 상태가 유지되는 것 확인. 이제 Star 사용자 저장 인계는 해소됐다. 키 원문·화면 이미지 출력 없음.
- Feedback 최종 적용: 2026-10-12T01:36:05UTC 기존 서버저장 Secret을 공식 PATCH/app/hook/config로 다시 적용하고 GET 검증했다. 이전사용자 저장 뒤 최종 제공자 상태를 canonical 서버 키로 맞추는 idempotent 적용이며 키 회전/새 키 생성 아님. URL/json/SSL/secretConfigured true/events[issues] 확인. GET Secret은 masked이므로 조회로 원문 equality를 주장하지 않는다. 실제 PATCH 총2회, 둘 모두HTTP200/readback 성공. 임시helper 실제exit0.
- 수정/설계: docs/operations/2026-10-11-star-feedback-reactivation.md와 이 handoff만 append. 이전 대기 기록을 이력으로 보존하고 최종 완료 상태를 추가. 앱 소스/env/DB/배포/featureflags 불변. provider 저장 완료와 runtime 전달·서명·기능 활성화 성공을 분리한다.
- 검증/실패: 실제 CUA user-entry file open/Star 저장 후 reload, Feedback PATCH/GET. 로컬 기능test/typecheck/lint/build/E2E/실제로그인·메일·스타·Issue/redelivery 미실행(사용자 직접 테스트). Chrome user changed 경고는 fresh AX→Window 메뉴→정확한 창 활성화로 해결. 이전 미설정 표시 뒤 재인계하여 성공 확인.
- 남은 일: 현재 문서2개 diffcheck와 내용 리뷰→stage/commit/push→docs-only PR 최신 base 필수check 성공 후 일반merge→rootmain fast-forward, 일지에 실제 PR/CI/병합 기록. 이번 요청의 provider 설정은 완료. 운영 활성화와 홈관측 마이그레이션0073/0074·observer 배포/자료축적은 별도 절차 유지. paused소개검수 재개금지.
- 정확한 다음 명령: `cd /private/tmp/nomorevibe-webhook-docs-20261012`; `git diff --check`; `git diff --stat`; `git add docs/CODEX_HANDOFF.md docs/operations/2026-10-11-star-feedback-reactivation.md`; `git commit -m 'docs: record completed GitHub webhook configuration'`; `git push -u origin docs/github-webhook-config-20261012`; `gh pr create --base main --head docs/github-webhook-config-20261012 --title 'docs: record completed GitHub webhook configuration' --body-file /private/tmp/nomorevibe-webhook-20261012-bhd0gmig/pr-body.md`; 필수 check 성공과 최신 head 일치 확인 후 일반 merge. 비밀키/PEM/staging/임시helper 커밋 금지.
- 문서 검증: 완료 결과 append 뒤 `git diff --check`를 실제 실행해 exit0, 변경 문서2개의 diff를 직접 검토했다. application 테스트는 실행하지 않았다.


### 2026-10-12 — 운영 배포·GitHub 기능 ON 진행

- 목적: 사용자 “운영 배포하고 플래그 ON 해. 플래그 ON은 환경설정에서해?”에 Dokploy 앱별 환경변수 true와 운영 실행 반영. 웹2개 네 flag ON, publisher/maintenance 주·예비의 delivery flag ON. 기존 키/origin 사용, Resend 없는 GitHub 로그인. 실제 기능 테스트는 사용자 직접.
- 현재 완료: main PR376 d506cfb, Star 사용자 저장 후 reload·Feedback API 설정 확인 완료. 운영 saved web a91eecf/worker8b608b2/maintenance·text·scheduler650b341, 4flags false. 기존 Docker8앱 runtime healthy, DBjournal73/0072까지/소개검수 pause2100-01-01/processed741/leasedfalse 읽기 확인. 새0073/0074 미적용.
- 결정: 검증된 main code58a63a3과 현재main d506cfb의 비docs 차이가0이므로 CI38186736825의 immutable images 재사용. worker43f7a921..., privateweb76f7ed24...; OCI revision58a와 웹 build/runtime키 양 서버 실제pull 검사중. Git source앱은 main d506으로 build하되 실행파일hash를58a와 비교하고 RELEASE_TAG58a로 동일앱코드 확인. 기존source/autoDeploy/replica/command 정책 보존. 역할 간 기존 release차이는 앱별 baseline/snapshot으로 다루며 공통스크립트의 단일baseline을 가정하지 않음.
- 도구/권한: prod skill 적용·Dokploy directcurl API 재사용, 프로젝트runbook의 mini예비→M3주 pair 검증 순서. 사용자 운영배포/ON 명시 승인으로 추가승인 없음. 새 credential생성/회전/웹훅 변경 없음. snapshot/ops helper는0700/0600 `/private/tmp/nomorevibe-activation-20261012-7ej2ked6`, 비밀값 출력/커밋 금지.
- 진행/실패: snapshot 첫 엄격 false-autoDeploy 가정이 connect-agent에 맞지 않아 read-only 단계에서 중지; scheduler/connect-agent의 기존true를 실제 재조회해 보존하도록 수정. 첫 digest log조회는 잘못된jobID404 및 summary문자열 없음; 실제 publish job114611229863/864의 DIGEST env에서 정확값을 확인. 아직 운영 save/deploy/drain/migration 없음. preflight session63787 imagespull 진행중, snapshot재시도예정.
- 수정: 현재 문서worktree `/private/tmp/nomorevibe-activation-docs-20261012`, branch docs/github-activation-20261012. app소스 변경 없음. opshelperactivate.py는 저장소밖이며 기존 API/pull/probe/drain/migrate 함수 재사용.
- 남은 일: snapshot14apps/Swarm/DB→preflight완료→scheduler와10역할 정상drain→검증이미지0073/74 direct5432 migration→DBjournal75/hash 확인→M3→mini roles/scheduler resume→6앱flags save→maintenance/text 주예비·scheduler/connect Gitrelease→publisher/reviewer/crawler pairs→webpair→runtimeflags/health/5rolesmonitor/DB/introPause검증. 문제시추가배포중지하고 스냅샷과실행상태로 affectedpair복구. 새급상승 관측은8h회차/24h 비교가 쌓여야 하며 과거값 위조 금지. paused소개검수 재개금지.
- 정확한 다음 명령: cwd `/Users/jr/Desktop/projects/nomorevibe`. `python3 /private/tmp/nomorevibe-activation-20261012-7ej2ked6/activate.py snapshot`(보관파일없을때만); `.../activate.py preflight`(READ ONLY provider/실제imagepull); `.../activate.py stop`; `.../activate.py migrate`; `.../activate.py database`; `.../activate.py resume`; `.../activate.py flags`; `.../activate.py source nomorevibe-maintenance-standby-mini` 후M3, textpair/scheduler/connect도같은source action; `.../activate.py shared publisher`→reviewer→crawler→web. 실제 preflight성공/DB적용확인 전 mutation금지.

운영 진행 갱신: snapshot/preflight 모두 실제exit0. 14앱·Swarm·DB원본0600 보관, 양서버pre-pull arm64/OCI58a/webbuild키 일치 성공. Proposed flags alltrue preflight configurationMatched true. scheduler1서비스(2복제본), 역할주예비10서비스를 정상drain하여 scale0/컨테이너0 확인(activate.py stop exit0). 웹6복제본과connect-agent는 유지 중. migration 실제session53126 진행중이며 아직 성공으로 기록하지 않는다. 재개시 해당세션결과를 먼저 확인하고 중복migration 실행하지 않을것. 종료후 `activate.py database`를 기존web 컨테이너를 통해읽고journal75/마지막0073·0074 hash를검증한뒤 `activate.py resume`로M3→mini역할/scheduler복구한다. migration실패면 새release/flags추가변경을멈추고 기존워커를resume해복구한다. 아직 flags saved 변경없음.

DB 단계 완료: migrate session53126 실제exit0/direct5432/drained11서비스. database session4271 실제exit0 journal73→75, 새관측2표를포함한16표, 0073/74 SQL SHA256이 마지막journal2개와일치. migration-verified.json0600 기록. intro not_before2100-01-01/processed741/leasedfalse 유지. 새소비자시작 전 DB검증 완료. resume session90766 진행/완료 결과확인 후 flags action으로 6앱saved 환경만바꾸고 신규코드deploy를진행할것. 기능테스트는여전히미실행.

운영 saved flags 단계 실제 완료: resume exit0로M35/mini5/scheduler2복제본 running확인. flags session18973 exit0, 웹2개4flag true, publisher/maintenance4앱delivery true, 전체키/origin/의존성 matched true. 실행중기존컨테이너는아직OLD/OFF이며새배포로반영예정. Git배포4개 진행중: maintenance-mini93825, text-mini56254, scheduler-M3 65091, connect-M3 41306. mini maintenance/text 완료후 각각M3를source action으로배포할것. 공통Docker역할/웹배포는아직시작전.

Git worker 단계 완료: source maintenance/text 주예비4앱+M3scheduler/connect2앱 총6앱 모두 실제done 및507실행파일SHA256 비교/healthy/RELEASE58a 확인. APIdeployment commitId는null이므로실제Gitcommitd506으로단정하지않는다(배포시main refd506+비docs diff0+507파일증거 사용). source/command/autoDeploy/복제본보존. 네이전세션93825/56254/65091/41306, M376064/5354 모두exit0. 다음 공통 publisher pair 실행중, reviewer→crawler→web순서. 최종read-only verify.py가14앱19컨테이너실행키/flags 일치,Git파일/immutableDigest,DB/5primaryLease/introPause/공개양웹health를확인한다. activate.py는import시에mutation이없도록main guard추가.

공통Docker publisher 주·예비 배포 실제exit0, 양쪽done/healthy/immutableworker43f7.../release58a 확인 후 publisher readiness ready/progress ok. reviewer pair session27808 진행중. 다음 crawler pair 후 webpair. 문서 diffcheck 실제exit0, 기능 테스트 없음. 초기운영보고서는 docs/operations/2026-10-12-github-feature-activation.md이며 아직진행중 표기를최종검증후갱신해야한다.

reviewer session27808도실제exit0: 주예비done/healthy, reviewer readiness ready/progress ok. 현재 publisher/reviewer6개중4개Dockerworker완료, crawler pair만진행. 다음web mini2/M3 4복제본을연속배포하고verify.py read-only실행. source6완료/DB75/flags savedtrue 상태유지.

crawler session79566 실제exit0. Docker6역할앱모두done/healthy/target43f7.../58a, publisher/reviewer/crawler 각ready/progressok. 이제webpair진행: mini2복제본먼저완료확인→M3 4복제본→공개health양서버판정. workerGit6+Docker6총12앱완료, 최종web2와runtime flags/key대조만남았다. 최종verify.py는실연동쓰기없이provider환경/runtime/DB/lease/readiness만읽는다.


### 2026-10-12 11:10 KST — 운영 배포·네 기능 플래그 실행 ON 완료

- 현재목적/완료: 사용자 운영배포/ON 요청 충족. web-mini/web-m3의PUBLIC_USER_AUTH_ENABLED/GITHUB_STAR_ENABLED/PRODUCT_FEEDBACK_ENABLED/GITHUB_FEEDBACK_DELIVERY_ENABLED true, publisher·maintenance 주예비delivery true를saved설정과실행컨테이너에서모두확인. Resend없는GitHub로그인. provider웹훅설정완료는앞PR376 기록.
- 실제배포: codeSHA58a63a3bc180f3e9cce3670ebb5b52a11cf6c3ef, immutableworker43f7a9212d57203d9df5681df48e2a6b15514cc6d91237f1cf5aa4b44196722c/privateweb76f7ed244d5c6838aae6b90785f0f087a1af5bb5868883a46fdf68690d10ebd7. 배포시maind506과비docsdiff0. Git6앱507파일hash일치/healthy; Docker8앱digest/label/release/healthy. 총14앱19컨테이너, 웹mini2/M34/scheduler2. 기존source/command/autoDeploy/replicas/DB설정/keys보존.
- 실제검증: DBdrain11서비스→direct5432 migrateexit0→journal73→75/0073·0074hash/관측2표→M3→mini역할/schedulerresumeexit0. publisher/reviewer/crawler pair게이트모두ready/progressok. websession6165 exit0 donehealthy/public양서버ok. finalverify session91030 exit0 14앱19컨테이너실행환경일치/5M3primary livelease/readiness/progressok/DB75/introPause preserved. HTML준비GETsession68796 exit0: /login·/p/nanomuseHTTP200/DYNAMIC/dpl58a, GitHub로그인안내표시. actual기능tests/typecheck/lint/build/E2E/OAuth/Star/comment/Issue/메일/redelivery/failover실험미실행(사용자직접).
- 수정: 문서worktree docs/github-activation-20261012(/private/tmp/nomorevibe-activation-docs-20261012)의 PENDING.md, docs/CODEX_HANDOFF.md, 운영활성화새보고서, 재활성화기록, 홈구현기록. 앱소스/테스트변경없음. temp opshelpers/snapshots는0700/0600저장소밖; verification.json만safemetadata이며원본envsnapshot공유/커밋금지.
- 실패/결정: 초기autoDeployfalse가정읽기실패→scheduler/connecttrue실제확인후보존. digest첫잘못된job404/summary없음→실제publishID114611229863/864 DIGEST+실제양서버pull검증. 실제migration/deploy/runtimeverification실패없음. Source commitIdnull을정확한GitSHA증거로사용하지않음. paused소개검수2100/processed741/leasedfalse보존.
- 남은일: 문서5개diff/검토→docs-onlycommit/push/PR최신base필수check→일반matching-headmerge→rootmainff/일지완료. scheduler/connectautoDeploytrue이므로docsmerge후그두앱status/readiness재조회필요. 실제사용자기능파일럿과새관측24시간/4닫힌회차자료축적은별도남은확인. 제작자FeedbackApp설치/binding/수신허용/작성자전송동의는ON만으로대체되지않음.
- 정확한다음명령: `cd /private/tmp/nomorevibe-activation-docs-20261012`; `git diff --check`; `git diff --stat`; docs5개만stage/commit; `git push -u origin docs/github-activation-20261012`; `gh pr create --base main --head docs/github-activation-20261012 --title 'docs: record production GitHub feature activation' --body-file /private/tmp/nomorevibe-activation-20261012-7ej2ked6/pr-body.md`; `gh pr checks <PR> --watch`; 최신base/head/check확인후일반merge. 운영helper flags/shared/source를다시실행하지않는다(이미완료). fresh검증이필요하면read-onlyverify.py, 단독Git두앱상태조회. 앱상태와실행은보고서보다실제API/SSH결과를우선한다.

문서검토: PENDING의과거App/Resend필수/OFF blocker를실제운영ON과사용자실연동미검증으로갱신. 새운영보고서/재활성화/홈관측기록/이handoff를직접검토하고기록된credential값이문서5개에없음을확인했다. 완료기록후git diff --check 실제exit0. 앱소스/테스트변경없음.


### 2026-10-12 — 홈 급상승·상세 정보 이전 스타일 복원 진행

- 현재 목적: 사용자가 지적한 홈 전일 대비 스타 급상승의 표시와 상세 FactsStrip를 이전 스타일로 복원한다. 새 수집/선정/노출 데이터 기준(8시간 회차, 전일 동회차, 스타 50~1,999, 증가 10 이상)은 유지한다. GitHub 로그인/스타/댓글 ON, 미리보기 확대, README 내부 스크롤도 유지한다.
- 원인 조사: 이전 웹 a91eecf2→배포58a63a3 diff에서 home PR372의 관측 회차/성공률 summary와 block/flex 스타 증가 메타/분야 숨김을 확인했다. FactsStrip는 두 release간 변경 없으며, 기존의 정보 3개 미만 inline 분기가 사용자 이미지(온라인·등록 한 줄)를 만든다. 더 이전540cda5의 compact 변경 전 grid/여백/글자 크기를 기준으로 복원한다. 누락된 저장소 정보를 만들어 넣거나 데이터 작업을 수행하지 않는다.
- 완료/수정 파일: app/page.tsx(홈 관측 요약 여러 줄→빈 결과일 때 짧은 상태 한 줄; 상세 관측은 집계 기준과 /rising에 유지), components/home/CompactCard.tsx(분야 복원), components/home/StarGrowthMetric.tsx(inline 기본 스타일/+증가량; 키보드 초점/툴팁 z-index 보존), components/product-detail/FactsStrip.tsx(이전 tile/grid 크기·여백, sparse inline 분기 제거, 수집 전 안내 보존). tests/product-detail-components.test.tsx는 기존 assertion/설명만 새 요청에 맞춰 정렬(새 테스트 추가 없음). 이 handoff는 기존 역사 뒤에 append.
- 주요 결정: 사용자 최신 요청은 이전의 상세 축소 요청보다 우선. 적은 데이터도 동일한 grid 형태를 쓰되 확인되지 않은 정보는 여전히 표시하지 않는다. 수집/DB/스케줄/순위 reader/lib 코드 변경 없음. 서버 전체 디자인/테마 변경 없음.
- 실제 확인: git diff --check exit0(초기 작성 뒤). 설치된 Next CSS 가이드 읽음. codex exec gpt-6.1-sol/xhigh/read-only 독립 리뷰 session38591 진행 중, 아직 완료나 clean이라고 주장하지 않는다. 사용자 지시로 로컬 tests/typecheck/lint/build/E2E/브라우저 기능 테스트 미실행. 필수 GitHub CI는 normal PR 절차에서 확인 예정.
- 실패/수정: docs styling.md/detail.css/workflow check.yml 경로 추정 읽기 실패→실제 CSS 가이드/파일/ci.yml을 rg로 확인. 첫 상태 문자열 empty 가정은 실제 StarGrowthSnapshot discriminant no-results를 읽고 즉시 수정(커밋/배포 전). 별도 운영 실패 없음.
- 남은 일: 리뷰 결과 확인·반영→diff 확인→코드/기존 assertion/handoff 6파일만 commit/push→일반 PR/최신 base 필수check→merge→main CI 이미지 검증→웹 mini2/M3 4 복제본을 동일 새 private web digest로 순차 배포. UI만 바뀌므로 worker 실행 소스 차이 없음 증명 후 worker release58a를 유지한다. 모든 GitHub flags/키/DB/paused intro 검사 유지, 테스트는 사용자 직접. root main FF 및 프로젝트 일지 기록까지 완료한다.
- 정확한 다음 명령: cwd /private/tmp/nomorevibe-style-restore-20261012. 리뷰 결과 /private/tmp/nomorevibe-style-restore-review-20261012.txt 및 exec session38591 결과 확인. git diff --check; git diff; git add app/page.tsx components/home/CompactCard.tsx components/home/StarGrowthMetric.tsx components/product-detail/FactsStrip.tsx tests/product-detail-components.test.tsx docs/CODEX_HANDOFF.md; git commit -m 'fix(ui): restore home growth cards and detail facts styling'; git push -u origin fix/restore-home-detail-style-20261012; gh pr create --base main --head fix/restore-home-detail-style-20261012 --body-file <작성된 PR 본문>. 필수check 성공과 최신 base 대조 후 matching-head 일반 merge. 기존 activation helper 재실행 금지(이미 완료 상태와 오래된 main 가정 포함).

진행 갱신: 독립 codex exec gpt-6.1-sol/xhigh/read-only 리뷰 완료, 결과는 actionable findings 없음. 리뷰는 소스/기존 CSS/타입/fixture만 읽었고 테스트/빌드/외부 쓰기는 하지 않았다. 자체 타입 대조에서 no-results discriminant를 사용하고, 카드 overlay 위에서 툴팁이 동작하도록 기존 position:relative/z-index:1을 보존했다. git diff --exit-code 58a63a3 -- lib scripts drizzle package.json package-lock.json tsconfig.json 실제 exit0: worker 실행 소스 변경 없음을 확인해 이번 운영 반영은 두 웹 앱만 대상으로 한다.


복원 PR 전달 갱신: code commit c489095aeafb28b2497060df7e2938ae55db442e push 및 PR378 https://github.com/JRVector9/nomorevibe/pull/378 생성. 최신 base36b72a6와 main 일치에서 PR CI38196247331 scope/quality/integration3/check/GitGuardian 모두 actual success. gpt-6.1-sol/xhigh independent review actionable findings 없음. matching-head normal merge 완료, mergeSHA1d8e092eeff8c63d30ca0d30e7002d75b171da40, mergedAt2026-10-12T02:37:56Z. root main fast-forward 및 사용자 미추적 자료 보존. main CI38196543226 진행 중, 이미지 생성/운영 배포는 아직 완료가 아니다.
- 운영 전 read-only 현재 상태 확인 실제 exit0: mini웹2/M3웹4 컨테이너 기존58a 이미지와 health ready, saved/runtime 모든 환경 일치, 네 플래그 true. 기존 n.baseline/preflight/pull/stage_and_deploy/probe/public_gate를 재사용하는 웹 전용 임시 operator helper /private/tmp/nomorevibe-style-web-20261012-zw_x9frm/deploy.py(0600, 부모0700) 준비. worker 실행소스(lib/scripts/drizzle/package/tsconfig)58a→새main diff exit0. 이 helper는 새main SHA/privateweb digest를 검증하고 기존 웹환경키/ON 플래그를 보존한다. worker·DB·웹훅 변경 없음.
- 다음: main CI38196543226 성공과 web publish job digest 확인, root가 targetmain인지/웹private/OCIarm64/buildkey 및 양서버 actualpull 검증 후 helper run <1d8e092전체SHA> <새privateweb@sha256digest>. 이 임시 helper는 main guard가 있어 import만으로 mutation하지 않는다. plan은 read-only+imagepull; run은 snapshot(0600) 후 mini→M3 웹 순차 deploy 및 실제 done/runtime환경/공개health를 검증한다. target SHA는 운영main과 같아야 한다. helper plan/run을 완료 전에 성공으로 기록하지 않는다.
- 문서 마무리 branch: docs/style-restoration-release-20261012, cwd /private/tmp/nomorevibe-style-restore-20261012. 운영 적용 완료 후 이 handoff에 실제 digest/양웹6컨테이너/ON flag/API상태 결과를 append하고 docs-only PR로 일반 commit/push/check/merge, 일지 업데이트. root tracked clean 상태를 다시 확인한다.

운영 이미지 단계 완료: main CI38196543226(head1d8e092) actual completed/success, scope/quality/integration3/check/publish-worker-image/publish-web-image 성공. 완료된 web job114641023042 DIGEST 환경 로그에서 정확한 privateweb digest sha256:39d05e4a88fe43d3b6bea8140526f4888d78314d85ee2f9449cdabcc13734d55를 추출(전체 로그/키는 출력하지 않음). target.json에 메타만 저장. 운영 웹 전용 deploy.py run session70831 시작, 완료 결과 아직 미확인. 세션 결과 먼저 poll하고 중복 run하지 않을 것(기존 before snapshot은 O_EXCL). worker 및 DB 변경 계획 없음. main은1d8e092, root FF/미추적 자료보존 완료.


### 2026-10-12 — 이전 스타일 운영 복원 완료

- 완료: 웹 전용 rollout session70831 actual exit0. privateweb sha256:39d05e4a88fe43d3b6bea8140526f4888d78314d85ee2f9449cdabcc13734d55 / release1d8e092eeff8c63d30ca0d30e7002d75b171da40. mini2개 먼저 done/healthy/runtime환경일치 후 M3 4개 done/healthy/runtime환경일치, public health가 두 instance(m3-web/mini-web) 모두 status:ok/db:ok/새 release를 반환했다. Dokploy deploymentId mini3V4CvT2lEaxognbhpczeW, M3T8OfOI1kBUbQ-g9JV4bX3.
- 실제 preflight: 양웹 saved/runtime 전체 환경 일치, 4flags true, private package, ARM64/OCI revision/웹 build key와 실행key hash 일치, 양서버 actual immutable digest pull. 기존 환경은 release/deploymentID만 변경, source/command/replicas/server/autoDeploy/buildSecrets/인증키 보존. snapshot before-1d8e092eeff8.json은0600/상위0700이며 비밀값 포함, 출력/커밋 금지.
- 실제 공개 readiness GET session17161 exit0: / 및 /p/nanomuse HTTP200/DYNAMIC/dpl1d8e092, 홈 rising 제목과 관측 통계 여러 줄 제거, 상세 복원 grid markup 확인. 급상승 카드가 채워진 화면의 시각 검수는 하지 않았다. 화면 시각 검수·OAuth·Star·댓글 기능 테스트를 수행한 기록은 아니다. 사용자 직접 테스트 지시 유지.
- 실제 후속 read-only 운영확인 session20566 exit0: DB journal75 유지, M3의 다섯 primary role lease live/worker58a 유지, failover readiness/progress ok. 중단 소개검수 not_before2100-01-01/processed741/leasedfalse 보존. 새8시간 관측/24시간 비교 기준과 원천 DB 수정 없음.
- 주요 결정/남은 일: 요청한 두 화면 스타일 복원 및 코드 커밋/푸시/PR378/일반merge/운영반영 완료. 화면 확인과 실제 사용자 GitHub 기능 파일럿, 관측24시간 자료축적 확인은 사용자/후속 운영 관측에 맡겨 둔다. 이번 문서 append를 docs-only commit/push/PR 필수check/일반merge하고 root main FF, journal 기록을 마무리한다. 기존 temp helper run을 반복하지 않는다(이미 target 실행중, O_EXCL snapshot).
- 정확한 다음 명령: cwd /private/tmp/nomorevibe-style-restore-20261012, branch docs/style-restoration-release-20261012. git diff --check; git add docs/CODEX_HANDOFF.md; git commit -m 'docs: record restored UI production rollout'; git push -u origin docs/style-restoration-release-20261012; gh pr create --base main --head docs/style-restoration-release-20261012 --body-file /private/tmp/nomorevibe-style-web-20261012-zw_x9frm/docs-pr-body.md. 최신base/head/check 확인 뒤 matching-head 일반merge 및 사용자rootmain fast-forward. docs-only merge 이후 scheduler/connect autoDeploy 상태는 실제 API로 확인한다. 공개 웹 code release는1d8e092이고 docs-only 최신commit과 구별한다.


### 2026-10-12 12:36 KST — ManimGX 상세 정보 누락 원인 확인·단일 수집 완료

- 현재 목적/완료: 사용자가 두 칸만 보이는 실제 URL `https://nomorevibe.com/p/manimgx`를 지정했다. 해당 제품만 기존 수집 요청 함수로 갱신했고 공개 응답에서 원래 6개 사실 항목이 표시되는 것을 확인했다. 앱 코드 수정·새 배포는 필요하지 않았다. 이전 UI 복원 PR378과 문서 PR379는 병합 완료, root main/origin main은 cd67f7ec9bf6881641ee4a71951502f4598f7867이었다.
- 원인 근거: 수집 전 product40195/seeded/repo_url https://github.com/academa-labs/manimgx, visible repository link key academa-labs/manimgx가 정상 일치했다. product_evidence_sources/refresh_requests/audit는 모두 0행. crawl_documents(2026-10-10T22:40:01.377Z)에는 MIT/포크3/생성2026-10-05T20:57:05Z/당시 push 정보가 남아 있었으나 상세 전용 github_repository facts는 최초 수집되지 않았다. 삭제되거나 화면 항목 자체가 제거된 증거는 없다. 전용 evidence 잡은 정상 실행 중이었고 cursor는 agent-notion-template-docs였다. 일반 처리 쿼리는 slug 오름차순이며 수집되지 않은 제품도 같은 순회에 들어간다. 전체 등록 제품의 첫 수집 대기 문제까지 이번 한 건으로 해결했다고 주장하지 않는다.
- 실제 운영 조치: M3 maintenance 컨테이너에서 기존 `queueProductRefresh({slug:"manimgx", productId:40195, actor:"operator:manimgx-facts-repair-20261012", force:true})` 한 번 호출. 별도 worker/수집 루프를 만들지 않고 기존 crawler lease·요청 lane·provider retry를 사용했다. requestedVersion1, 요청2026-10-12T03:35:27.132Z, 시작/완료03:35:29.538Z, completedVersion1, activeVersion null, sourcesAttempted1/sourcesFailed0/factsChanged1/eventsInserted2/mediaInserted0/lastError null. 다른 제품 일괄 갱신·DB 임의 facts 삽입·스케줄 변경 없음.
- 실제 결과: repository state ok/type github_repository, 최근 push2026-10-11T21:57:17Z(서울10월12일), latest release v0.1.1/ManimGX0.1.1/published2026-10-07T22:54:05Z(서울10월8일), 기여자2명/포크36개/MIT/저장소 생성2026년10월. 가동 상태 온라인/30일100%, nomorevibe등록10월11일 포함 6개 칸을 실제 HTTP200 공개 HTML에서 확인했고 미수집 안내 false. 포크3은 옛 crawl 관측값이며 현재36으로 실제 provider 수집 결과를 표시한다.
- 수정 파일: 이 handoff append만. 운영 조사/receipt/status 임시 파일은 /private/tmp 아래0600로 보관하고 커밋하지 않는다. helper import는 배포 action을 실행하지 않았다. provider/client/env/키 값을 출력하거나 기록하지 않았다.
- 검증/테스트: 최초 read-only DB transaction과 공개 GET 실제 성공(이전 두 칸/미수집true); 기존 운영 큐 함수 호출 실제 exit0; 후속 read-only DB와 공개 GET 실제 exit0(6개 칸/미수집false). 사용자 지시에 따라 로컬 테스트·새 테스트 작성·typecheck/lint/build/E2E/실제 Star·댓글·OAuth 조작은 실행하지 않았다. 공개 GET은 데이터 표시 확인이다. 소개 검수 pause not_before2100-01-01/requested742/processed741/leasedfalse 보존 확인.
- 실패 접근: 존재하지 않는 lib/domain/evidence/github.ts와 provider-cooldown.ts 읽기를 시도했다. 실제 provider는 lib/domain/evidence/providers/github.ts이며 rg로 위치 확인 후 읽었다. 운영 작업 실패는 없었다.
- 남은 일: 현재 ManimGX 누락은 해결. 전체 신규 발행 제품의 최초 상세 수집 지연 개선(발행 시 요청 enqueue/기존 순회 우선순위 등)은 별도 범위 검토 사항이며 이번에 변경하지 않았다. 시각 및 사용자 기능 테스트는 사용자가 직접 한다. 이번 docs/CODEX_HANDOFF.md append는 로컬 변경으로 남아 있으며 다음 문서/구현 PR에 포함할 수 있다. 기존 공개 웹 release1d8e092, worker58a63a3, 네 GitHub flags ON과 중단 소개 검수 유지.
- 정확한 다음 명령: `cd /Users/jr/Desktop/projects/nomorevibe`; `git status --short --branch`; `python3 /private/tmp/nomorevibe-manimgx-status-20261012.py`(read-only DB/public GET; 원본 비밀 환경 출력 없음). 증거 파일은 /private/tmp/nomorevibe-manimgx-readonly-20261012.json, nomorevibe-manimgx-refresh-receipt-20261012.json, nomorevibe-manimgx-status-result-20261012.json. 이미 완료된 큐 요청·배포 helper를 반복 실행하지 않는다. 다음 개선을 할 때 lib/domain/evidence/refresh.ts:dueEvidenceProductSlugs, lib/jobs/products/evidence-refresh.ts, lib/crawl/publish.ts 및 products 생성 함수부터 읽는다.


### 2026-10-12 — 상세 정보 크기·라이선스 표·다른 페이지 수집 정확성 병렬 구현

- 현재 목적: 사용자 요청(다른 상세페이지 확인, 사실 영역을 조금 좁힘, 클릭으로 여러 라이선스 의미 표, 라이선스 정확성 감사)을 PR01 UI/PR02 라이선스/PR03 최초 수집으로 분리했다. gpt-6.1-sol/xhigh 서브에이전트3개가 독립 worktree에서 소유 파일만 수정했고 root가 리뷰 중이다. 사용자 테스트 직접 수행 지시로 새 테스트 작성·로컬 test/typecheck/lint/build/E2E·UI 기능 테스트 없음.
- 설계/계획: docs/superpowers/plans/2026-10-12-detail-facts-license.md. 기존 정보 칸과 grid 유지; value20→18px/padding18→14px/vertical12px. native LicenseDialog, 13개 주요 라이선스 공식 원문 표, GitHub 대표 라이선스 자동 판별/메이커 선언/미식별/마지막 수집 상태 구분. 새 의존성·스케줄러·migration·full-text license classifier 없음. user explicit execution authority로 추가 설계 승인 질문 없음.
- 운영 진단 실제 read-only DB 결과: public GitHub42283, current primary visible facts38623, missing link1105, visible no source2402, source factsnull153. missing1105 전부 crawler/seeded/unclaimed/no maker.links audit, 생성8/29..9/8 legacy. null facts153은136not_found/10rate_limited/5collection_failed/1http403/1invalid_response로 신규 원인 없이 기존 retry보존 대상. 48h 초과facts9732, non-ok1566. 첫 요청 큐1건(ManimGX)완료, regular evidence worker정상.
- 라이선스 실제 분포: null19713/MIT10478/Apache3134/NOASSERTION2772/AGPL1115/GPL3 754/기타657. nonempty name누락0, generic API license textURLs16138. 공개 공식 REST12건 중 운영 표본7건(value/SPDX/url)모두같음. GitHub자동판별은 파일별/의존성/복수 전체 조건을 검증하지 않는다는 공식문서 한계를 표와 report에 기록.
- 공개GET 실제 표본9건 모두HTTP200: manimgx/openfilm6facts, shellrs/nanomuse7facts(visits), okrapdf2facts(legacy no link), dynasty-league-hub2facts(미수집), agent-studio-2 staleApachefacts6, aet-go5facts(nulllicense), agent-skills-30installable6facts. 공개GET은 로그인/스타/댓글/모달 기능 테스트가 아니다.
- 에이전트 완료/소유: UI /private/tmp/nomorevibe-facts-license-ui-20261012 branchfix/detail-facts-license-guide-20261012(FactsStrip,새LicenseDialog,license-guide); 라이선스 /private/tmp/nomorevibe-license-audit-20261012 branchfix/github-license-evidence-20261012(provider github,detail-viewlicensehelpers,auditdoc); 첫수집 /private/tmp/nomorevibe-evidence-first-20261012 branchfix/product-first-evidence-20261012(refresh-requests transaction API,products insert/markVerified,refresh boundedintake,jobintake,auditdoc). root plan/handoff는UI worktree만수정한다. rootmain사용자미추적자산 보존.
- 구현: 공백/NOASSERTION/NONE SPDX정리, observedOther는unidentified, 두명시적ID다르면conflict, 한쪽ID없는경우정확한반대ID/반환명만비교. C는publicinsert에서generation/동일tx큐,verify때 visibleprimary/미수집만queue; 기존잡은dueexplicit요청이없을때legacybackfill가드로최대1건/tick복구요청. 새요청wallclock이현재ticknow뒤라다음tick소비. hidden/tombstone/maker edits/claimed/status변경/기존providerretry보존. 새루프/전체42k강제갱신 없음.
- 실제 리뷰: root직접source검토에서closed모달 nesteddt가factscount를바꾸는문제와freshlicense긴note가높이를늘리는문제를 발견해UI에반영. 독립CLI(gpt-6.1-sol/xhigh/read-only)license session91661 종료exit0/P2공백makername+유효SPDX표시누락(confidence9/10)1건. root가SPDXfallback으로수정. 후속 좁은리뷰 session진행중(결과아직미확인); UI독립review session17402, 최초수집96814도진행중. 테스트미실행; 각에이전트 gitdiffcheck실제exit0. 아직commit/push/PR/새배포 없음.
- 실패 접근: 일부추정파일(styles/verify route 등)읽기실패후 rg로실제위치찾음. 첫독립review가전역review skill장문을읽어출력이커졌으므로후속CLI는읽기전용범위를좁히고로그를private/tmp0600파일로redirect했다. no secretoutputs. 운영조사SQL/receipt/statustools는0600이며원본앱환경snapshot을출력하지않는다.
- 남은일: 3독립review결과확인·반영→PR02부터commit/push/필수CI/일반merge→PR03·PR01최신base통합(타입unidentified는PR02선행)·리뷰·commit/push/CI/일반merge. 기존필수CI는정상PR로실행되고로컬tests는하지않는다. 운영승인범위필요역할/웹새이미지배포·GET/runtime확인후docs/journal최종실행결과기록. 전체backlog는즉시다채웠다고주장하지않고boundedrecovery장기관측남김. 소개검수 pause2100-01-01/requested742/processed741/leasedfalse,4flagsON키보존.
- 정확한다음명령: 각review로그/결과 /private/tmp/nomorevibe-license-evidence-review-fixed-20261012.txt, nomorevibe-facts-license-ui-review-20261012.txt, nomorevibe-first-evidence-review-20261012.txt 확인. Bcwd에서 git diff --check; 3소유파일만add/commit/push→ghprcreate본문파일. rootmaincd67f7e 최신base동일확인. C/A아직커밋없으므로새mainfetch후merge(필요스냅샷patch보관)해서타입통합. Bstateunidentified후 A의 ['unidentified'].includes를직접===로단순화. root/docs/CODEX_HANDOFF.md로localManimGXentry+현재작업entry복사한것은A worktree에만있으며 최종PR01에포함예정. 진단다시읽기: python3 /private/tmp/nomorevibe-detail-license-audit-20261012.py, python3 /private/tmp/nomorevibe-detail-license-audit-extra-20261012.py. 기존activation/deployhelper는옛main가정으로재실행금지.


### 2026-10-12 — 상세 정보·라이선스 병렬 작업 통합 갱신

- PR02 완료: commit967925a2f3a5f9497466620d8cae3e2caa878be0, PR380 https://github.com/JRVector9/nomorevibe/pull/380. 최신basecd67f7e에서 CI38202319232 scope/quality/integration3/check/GitGuardian 실제 success, 일반 matching-head merge3aba2368951b2100c2e372b655802900220377e8. 독립 source-only 리뷰의 P2 공백 메이커명+유효SPDX 누락을 fallback으로 수정했으며 후속 review-fixed 결과 actionable findings 없음.
- PR03 완료: commit24bca91 및 최신main 통합headcba339398ef1f757d14003f784606d5672c09563, PR381 https://github.com/JRVector9/nomorevibe/pull/381. 최신base3aba236에서 CI38202661496 scope/quality/integration3/check/GitGuardian 실제 success, 일반 matching-head merge2f3920d3334c4fb60b862c585288be35cddd30bd(04:15:56Z). 독립 최초 수집 source-only 리뷰 actionable findings 없음. 최대1건/tick 접수/기존 provider retry/숨김·메이커 편집 보존이며 backlog 전체 완료 아님.
- PR01 통합: UI worktree를 origin/main2f3920d로 fast-forward. unidentified 직접 equality로 정렬. 기존 실제 사실 항목 유지, 여백/글자만 완만히 축소. 독립 UI 리뷰 P2 2건(inset focus outline/배경 스크롤 잠금)을 반영. 후속 review-fixed에서 native close→queued close 이전 reopen 시 원래 overflow restorer 덮어쓰기 P2 발견: showModal 후 restoreScroll.current가 존재하면 재캡처하지 않도록 1줄 guard로 수정. 좁은 독립 리뷰 session31305 진행 중, 아직 clean이라고 주장하지 않는다.
- 실제 형식 확인: 최종 UI guard 변경과 PR03 통합 뒤 git diff --check actual exit0. 사용자 지시로 새 테스트와 로컬 test/typecheck/lint/build/E2E/브라우저 기능 테스트 미실행. 위 CI 성공은 GitHub에서 실제 실행된 필수 PR CI이며 로컬 테스트 실행 주장 아님.
- 수정 파일: FactsStrip.tsx, 새LicenseDialog.tsx, 새license-guide.ts, 이handoff, 상세 계획 문서. PR02/03 소유 코드·감사 보고서는 각각 이미 main에 병합. root main 사용자 미추적 자산 보존, local ManimGX handoff는 이 UI 문서에 포함되어 있다.
- 다음: session31305와 /private/tmp/nomorevibe-license-dialog-race-review-20261012.txt 확인·발견사항 반영→UI5파일만 commit/push/PR→최신base 필수check 성공/일반merge→root own localhandoff 보관 후 해당 경로만restore/mainFF. 최종main CI 성공/양 immutable image digest 검증 후 저장소밖 /private/tmp/nomorevibe-facts-license-release-20261012-2j9n7gly/deploy.py target.json 메타 작성 및 plan/run(한번만), source6+Docker8앱 순차 rollout. helper는 아직실행하지 않았으며 before snapshot 없음. GitHub4flagsON/키/source/replicas/소개검수2100pause 유지, migration 없음. 배포 완료 뒤 실제 read-only runtime/publicGET/backlog 초기접수 증거와 handoff/journal 기록을 마무리한다.

UI 좁은 후속 독립 리뷰 session31305 actual exit0: guard가 기존 overflow restorer를 보존해 queued close/reopen 경합 P2를 해결했으며 actionable findings 없음. 리뷰 범위 open/close/onClose/unmount 소스만, 테스트·빌드·브라우저 미실행. PR01 커밋 준비 완료.


### 2026-10-12 13:23 KST — 상세·라이선스 3개 PR 병합 완료, 운영 이미지 단계

- PR01 commit238a51980c708911b7e88058452603e74253caf6 / PR382 https://github.com/JRVector9/nomorevibe/pull/382. 최신base2f3920d와 remote main 일치, CI38203255490 scope/quality/integration3/check/GitGuardian 실제success 후 일반 matching-head merge33349ed1352caabcb434ac4906bc2a2213ac2a51(04:22:39Z). 새 테스트 작성/로컬 테스트 실행 없음; CI는 GitHub 정상필수절차. 독립 최종 UI 경합 리뷰 actionable findings 없음.
- root main33349ed fast-forward 완료. 기존 root local ManimGX handoff append가 UI 커밋에 verbatim 포함됐음을 확인하고0600 백업 후 root의 해당 own local append만 restore하여 FF했으며 사용자 미추적 자산은 보존했다. PR380/381/382 소스 모두 main에 포함.
- 운영 아직 미반영: 최종main CI38203533979 실제 진행 중. 대상 worker/web immutable image가 이main에 일치하며 required CI 성공해야 반영한다. 새로운 migration/package 차이없음, GitHub flags4 ON/키/origin/replicas/source/autoDeploy 유지. 소개검수 pause 유지. rollout operator helper는 /private/tmp/nomorevibe-facts-license-release-20261012-2j9n7gly/deploy.py, 확장 read-only runtime verifier verify.py, snapshot은 아직 없음. old activation의 CLI action은 실행하지 않는다.
- 다음: gh run view38203533979 상태 확인→실제 publish-worker-image/publish-web-image job DIGEST만 allowlist 추출/target.json0600 저장→helper plan(prepull/ready/flags proof)→helper run 한 번(snapshot14앱/source6/Docker8 pair순차)→verify.py read-only14앱19컨테이너 전체 saved/runtime env, source hash, immutabledigest, lease/DB/introPause/publichealth. 세션결과 먼저poll, snapshot생긴뒤 run재실행금지. 상세9페이지+주요공개페이지 GET 표시확인과 bounded queue 초기복구를 read-only로 기록하고 docs-onlyPR/일지로 마무리. 전체누락 즉시복구 주장금지.

운영 이미지 실제 완료: main CI38203533979(head33349ed1352caabcb434ac4906bc2a2213ac2a51) actual completed/success, scope/quality/integration3/check/worker·web publish success. 실제 publish job DIGEST allowlist 추출: worker ghcr.io/jrvector9/nomorevibe-worker@sha256:ce17a8f84c31bbab98bd9186e2ecaefc4fd8855a6c55d1c2a7ff84f32952ade9; private web ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:0833f944689d822005ea8090f96a4a5d2d60e00904ff7f42f9e43ecf824a8d98. target.json0600 저장. plan session81781(preflight/actualpull) 진행 중이며 아직 완료로 주장하지 않는다. 운영 mutation/snapshot은 아직 없음. 다음은 plan결과 확인 후 run 한번, 해당 session먼저poll.

운영 preflight 실제 완료: plan session81781 exit0, 기존Docker8앱 baseline healthy/각별 기존release 보존, privateweb build/runtime key 일치, 양서버 ARM64/OCI revision33349ed 및 immutable images actualpull 성공, four flags true/configurationMatched. migrationRequired false. run session17166 시작, 결과는 아직 미확인이다. 현재세션을 먼저poll하고 run 중복실행/최신main문서merge 금지. snapshot 생긴 뒤 같은run은 O_EXCL로 거절된다.

운영 중간 결과: run17166의 source maintenance/text 주예비+scheduler/connect 6앱 모두 actual verified/507실행파일hash/RELEASE33349ed 정상. API gitCommit null이므로 이를 commit증거로 단정하지 않는다. Docker publisher/reviewer/crawler 주예비6앱 모두 done/healthy, 각role readiness ready/progress ok. 현재 웹 mini2→M3 4 반영 진행 중이다. DB migration/keys/flags/source정책/소개검수 재개 변경 없음. 최종 run17166→read-only verify.py→observe.py/public_get.py 결과를 확인 후 실제완료기록을 append한다. 원본 before/swarm-before snapshot은0600/상위0700이며 비밀값 포함/출력금지.


### 2026-10-12 — 상세·라이선스 운영 코드 반영 완료, 최종 기록 진행

- 실제 rollout run17166 exit0. code release33349ed1352caabcb434ac4906bc2a2213ac2a51, worker sha256:ce17a8f84c31bbab98bd9186e2ecaefc4fd8855a6c55d1c2a7ff84f32952ade9, privateweb sha256:0833f944689d822005ea8090f96a4a5d2d60e00904ff7f42f9e43ecf824a8d98. Git source6앱507실행파일hash 일치/healthy, Docker8앱 immutable image/release/healthy. 주예비 publisher/reviewer/crawler readiness ready/progress ok, 웹 mini2→M3 4 완료 및 두instance publichealth ok.
- 최종 전체 runtime verifier session34607 actual exit0. 14앱19컨테이너 모두 saved/runtime 전체 환경 일치; 원본snapshot 대비 RELEASE_TAG/NEXT_DEPLOYMENT_ID 외env변경없음, source/autoDeploy/replicas/command/buildSecrets 등보존. GitHub fourflags true/configurationMatched, fiveM3primary livelease/targetrelease, DBjournal75변경없음, 소개검수2100/requested742/processed741/leasedfalse 보존. all-runtime-verification.json0600 safe메타 저장. before/swarm snapshots는 비밀 포함하므로 출력/커밋금지.
- 공개 read-only GET session68545 actual exit0, 홈/rising/popular/login/policy 및 대표9상세 총14곳 모두HTTP200. manimgx/openfilm6facts, shellrs/nanomuse7(visits), agent-skills-30installable6, aet-go5(nulllicense는발명안함), okrapdf/dynasty-league-hub2(미수집값은계속생략), agent-studio-2 이전Apache값은 이전수집으로한정. 모든상세compact14px/12px/18px markup, license있는표본13행표/안내dialog/수집시점포함확인. 이 GET은 모달 클릭/Esc/스크롤/로그인/스타/댓글 실제기능test 아님, user직접테스트 유지.
- 진단 도구의 실패: 최초verify를/private/tmp cwd로실행해 git 기반 manifest에서RuntimeError 발생→repo cwd로 재실행한session34607 실제성공. 배포실패가아니다. observe.py 최초2회 remote stdoutempty→JSONDecodeError라 backlog 접수 성공을 아직주장하지 않는다. 읽기전용metadata debug48734 결과를확인하여 source/SQL/원격출력 원인을 좁힌후 재조회한다. 운영요청강제쓰기/배포 재실행 없음.
- 남은일: bounded recovery 실제접수/완료 초기증거·미식별license표본 read-only 확인→수집/라이선스 감사보고서와 plan/handoff 최종기록→docs-onlycommit/push/PR최신base필수check/일반merge→rootFF/Obsidian일지완료. docsmerge뒤 scheduler/connect의 autoDeploy=true 유지 상태를읽고 source/runtime/pausedintro를확인한다. 전체backlog완료시각이나전량정확성은주장하지 않는다.
- 정확한 다음명령: cwd/Users/jr/Desktop/projects/nomorevibe에서 python3 /private/tmp/nomorevibe-facts-license-release-20261012-2j9n7gly/observe.py(진단수정뒤); verify.py는이미exit0완료이며 새상태변경없으면반복불필요. public_get.py도이미14성공. 문서worktree/private/tmp/nomorevibe-facts-license-ui-20261012 branchdocs/detail-facts-license-release-20261012에서문서만stage/commit/PR. rootmain33349ed이며실행code도33349ed이다. helper run은완료했으므로절대반복하지않는다.


추가 관측 완료: 진단29519에서 SQL 두 요청조회만실패하는것을분리했고 실제schema의 컬럼은 started_at/completed_at임을확인하여 own observe.py의 잘못추정한 last_* 컬럼만수정했다. observe84613 actual exit0/read-only. system:evidence_bootstrap 자동요청4건(opencovibe/apps-by-tim-wu-haotian/avibe/claude-directory) requestedVersion=completedVersion=1/active null/lastError null, currentvisible link와 github_repository facts/stateok/정상provider수집시점 확인. code자동복구의 최초접수·수집완료를 확인했으며 운영DB 직접facts쓰기/추가강제큐 없음. product_created/verified 이벤트는 이 관측기간 발생하지 않았으므로 런타임발행시나리오 검증 완료로 과장하지 않는다. joblastError null/regularcursor진행, introPause계속보존. public repo_urlnull cohort0/visible secondary facts0으로 원천 primary삭제후fallback분기는 실운영표본에서 확인하지못했으며 임의수정안함.
- 미식별 실제표본 agentmesh-officialrecruitment: rawOther/NOASSERTION/stateok. 이표본과 자동복구 opencovibe targetedGET session88339 결과를확인한후최종표시증거를append한다. 현재 collection-observations.json과 all-runtime-verification/public-get 메타는0600, 민감원본snapshot과구분한다.

Targeted publicGET88339 actualexit0: agentmesh-officialrecruitment HTTP200/6facts/13행안내표/식별미확인 true, 자동복구 opencovibe HTTP200/6facts/13행안내표/미수집안내false. 기존14GET와별도2GET 총16개서로다른공개페이지 HTTP200. 실제모달클릭test아님. 감사보고서2개/계획/인계와Obsidian일지 실제결과작성완료; 지금 docs-only 전달PR commit/push/check/merge 진행예정이다. 앱소스·테스트추가변경없음. 최종operatingcode33349ed/flagsON/pause유지.


최종 문서 전달: docs commit51cef97 / PR383 https://github.com/JRVector9/nomorevibe/pull/383 생성. 감사보고서2개·계획·인계4문서만 변경. 실제 git diff --check 및 --cached --check exit0. 앱/테스트추가변경없음. PR383 필수CI와 최신base33349ed/head를 확인한 뒤 일반matching-head merge/rootFF한다. 문서merge가 새 앱release는 아니며 실행코드는33349ed/양웹·워커배포완료다. 후속 agent는 이PR 상태와 Git실제결과를 먼저읽고 완료된operator run을반복하지않는다. merged후 README상 autoDeploy=true인 scheduler/connect의 sourcehash와상태, DBintroPause/publichealth만 read-only 확인하고 Obsidian일지에actualmergeSHA/결과를append하면문서전달도완료다. 기능시험은user직접, 전체backlog는기존잡의점진복구대상으로남는다.


### 2026-10-12 — 상세 상단 스타 숫자 클릭 연동 구현·리뷰 진행

- 현재 목적: 별도 액션 행의 GitHub 스타 버튼·재조회·긴 오류 문구를 없애고, 기존 상세 메타 정보의 `★ 숫자`를 개인 GitHub 스타 추가/취소 컨트롤로 통합한다. 사용자 요청 범위는 웹 UI이며 최소 코드 원칙 적용. 관리자 Tailscale 전용 접근/아이디·비밀번호 요청은 아직 구현하지 않은 별도 후속 범위로 보존한다.
- 구현/수정 파일: app/p/[slug]/page.tsx(수집 스타 수 prop), components/product-detail/ProductHero.tsx(메타 숫자를 컨트롤로 교체, 액션 행 제거), components/product-detail/GithubStarButton.tsx(같은 숫자 표기/확인된 개인 상태 색·aria-pressed/연결 링크/한 버튼으로 조회 재시도/클릭 후 오류 안내). 기존 GitHub 개인 자격 정보 PUT/DELETE, CSRF, revision, operationId, uncertainty 잠금과 집계 DB 값은 그대로 사용한다. 전체 숫자는 관측값으로 유지하며 사용자 클릭에 따른 개인 상태만 GitHub 확인 후 변경한다.
- 원인 조사: 기존 코드에서 최초 조회 실패 후 view=null인데 `확인 중`을 계속 표시하는 상태 표현 결함을 확인했다. 조회 요청 busy/finally와 실패 재조회 상태를 구분했으며 /api/me 서버 오류를 로그인 필요로 오인하지 않는다. 스크린샷의 실제 제공자 실패 원인까지 특정한 것으로 주장하지 않는다. 읽기 전용 운영 확인에서 웹/워커 8앱 모두 release33349ed/done, 웹 mini2/M3 4, GitHub four flags true/configurationMatched. DB read-only에서 GitHub active1/토큰 만료0, 개인 unstarred2/요청된 쓰기0. product-intro-check pause2100-01-01/requested742/processed741/unleased 보존. 개인 OAuth·스타·댓글 쓰기는 실행하지 않았다.
- 작업 상태: root main8ea8e36/사용자 미추적 자료 보존. 독립 worktree /private/tmp/nomorevibe-star-inline-20261012, branchfix/detail-inline-github-star-20261012. 초기 git diff --check exit0. 독립 Codex source-only 리뷰 gpt-6.1-sol/xhigh session38868 진행 중이며 clean 판정 전이다. 결과 /private/tmp/nomorevibe-star-inline-review-20261012-s1yh9b_2/review.txt. 사용자 지시로 새 테스트 작성·로컬 test/typecheck/lint/build/E2E/브라우저 기능 테스트 미실행. 정상 PR 필수 CI는 그대로 따른다.
- 실패 접근: 이전 단계 /private/tmp 운영 helper가 정리되어 파일이 없어 저장소의 scripts/ops/deploy_shared_images.py를 읽고 재사용하도록 새 private operator를 준비했다. 최초 운영 진단은 jobs.lease_owner라는 잘못된 컬럼 추정으로 실패했다. 실제 schema lease_token으로 수정 후 성공했고, 소개 검수 이름을 잘못 추정한 빈 조회는 actual product-intro-check/2100 조건 조회로 바로잡았다. 운영 변경·배포 실패가 아니다. 원본 환경/키/토큰은 출력하지 않는다.
- 남은 일: 독립 리뷰 결과 반영→소유 코드3파일+handoff만 commit/push/PR→최신 base 필수check/일반merge→최종main CI/immutable web digest 확인→worker 관련 lib/scripts/drizzle/package/tsconfig가 기존33349ed와 같은지 증명 후 웹 mini→M3만 배포→runtime env/flags/source/replicas/public HTML 확인→최종handoff·일지. 실제 사용자 스타 클릭 테스트는 사용자 수행. 기존 E2E의 별도 확인 불가·재조회 버튼 단정은 UI 변경으로 달라지며 이번에 E2E를 실행하거나 새로 작성하지 않는다.
- 정확한 다음 명령: `cd /private/tmp/nomorevibe-star-inline-20261012`; 먼저 session38868과 review.txt를 확인; `git diff --check`. 새 operator /private/tmp/nomorevibe-star-inline-review-20261012-s1yh9b_2/release.py는 아직 capture/plan/deploy를 실행하지 않았다. 정상 main CI 완료 후 `python3 .../release.py capture <new-main-sha> <main-run-id>` → `plan` → `deploy` 한 번 → `verify` 순서. before.json snapshot 생성 후 deploy를 반복하지 않는다. 진단은 `python3 .../diagnose.py` read-only. 환경 snapshot/private token/PEM은 커밋·출력하지 않는다.

독립 source-only 리뷰 session38868 실제 exit0: P2 aria-label이 보이는 전체 스타 숫자를 가리는 접근성 결함 1건(confidence9/10), DOM/async/상태/잠금/필수 unit 소스의 다른 새 결함 없음. accessibleLabel에 같은 formatCount 수를 넣어 button/link 모두 수정. 좁은 후속 리뷰 session93404 실제 exit0/clean(새 결함 없음). 로컬/브라우저/기능 테스트 실행 없음. 정상 PR commit/push 준비 완료.

PR384 https://github.com/JRVector9/nomorevibe/pull/384 생성/head2d5e492ad0a44fcf0599ab21d9c8713e2359114d/base8ea8e360. 첫 CI38213902348의 quality에서 실제 lint failure: GithubStarButton.tsx:61 setBusy(true), react-hooks/set-state-in-effect(불필요한 effect 내 동기 상태 변경). checking 조건이 최초 조회를 이미 잠그므로 mount의 한 줄만 삭제했다. 초기 상태/완료/오류/finally/refresh/toggle에 대한 좁은 독립 리뷰 session38329 actual exit0/clean. GitHub typegen/tsc까지는 실제success였지만 첫run 전체성공은 아니다. 후속 커밋으로 정상 PR CI를 다시 수행한다. 새 로컬 테스트·typecheck/lint/build 실행 없음.


### 2026-10-12 15:51 KST — 상단 스타 클릭 PR384 병합 완료, 운영 이미지 대기

- 실제 PR CI38214148828(head48d8914b41968d8d7ff4847b8e7ccca193579239) scope/quality/integration3/check/GitGuardian 전체 success. 최신base8ea8e360과 remote main을 직접 대조하고 일반 matching-head merge 수행. PR384 merge9cf8286c7b57796510ede2e659becaa6fad70fd2(06:51:06Z), root main fast-forward 완료/사용자 미추적 자산 보존. 코드3파일만 변경했으며 git diff --exit-code33349ed HEAD --lib/scripts/drizzle/package/tsconfig 실제exit0(worker 불변). 로컬/기능 테스트 미실행은 유지한다.
- 현재 운영 웹과 worker는 아직33349ed이며 새 웹 배포는 아직 하지 않았다. 최종main CI의 실제check/image publish 성공·immutable web digest/revision 확인 후 웹 mini2→M3 4만 배포한다. 기존 네 플래그/개인 credential/환경/source/autoDeploy/replicas/소개 검수 pause 유지. 소개검수 아직2100-01-01/requested742/processed741/unleased 실제 확인. 실제 스타·OAuth·댓글 쓰기 없음.
- 별도 문서 전달 branchdocs/detail-inline-star-release-20261012/worktree같은경로를 생성해 최종 배포 결과·인계만 기록한다. 코드 PR 수정이나 운영 helper 재실행 금지. code target9cf8286을 운영 반영하는 동안 docs PR을 merge해 main을 바꾸지 않는다.
- 다음 명령: `gh run list --branch main --workflow ci.yml --limit 2 --json databaseId,headSha,status,conclusion`; code9cf8286 run 실제completed/success 확인 후 `cd /Users/jr/Desktop/projects/nomorevibe`; `python3 /private/tmp/nomorevibe-star-inline-review-20261012-s1yh9b_2/release.py capture 9cf8286c7b57796510ede2e659becaa6fad70fd2 <main-run-id>`→`plan`→`deploy`한번→`verify`. snapshot before.json 생긴뒤 deploy반복금지. 공개 GET script public_get.py는threadplane/dawn-ai/manimgx/openfilm/agent-skills-30와홈/login/api-me총8곳의HTTP/단일메타starcontrol/accessiblecount를확인하는읽기전용이며 아직미실행. 실제클릭시험은user수행. `/private/tmp` 이전 단계 helpers는정리되어존재하지않으므로지난경로재시도금지.

최종 main CI38214584907(head9cf8286c7b57796510ede2e659becaa6fad70fd2) actual completed/success: scope/quality/integration3/check/worker·web publish 모두success. 실제image digest allowlist 추출/capture55631 exit0: web ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:6064eaae1b9b4ba21443a522e1d93d1d79002d30c82464b44df7afe318d4027d; CI worker b4cb0348581cf258c75eb55bfde85d7548d13538409699604b382752186bf596는 생성만 확인했고 배포하지 않는다. 운영 worker는33349ed/ce17a8 유지(관련코드diffexit0). private target.json0600 저장. 웹 전용 plan session26332 실행 중, 아직 preflight 완료/배포라고 주장하지 않는다. 이 세션을 먼저poll하고 preflight.json이 실제 생성되고 성공해야 deploy 한 번. before.json은 아직 생성되지 않았다.


### 2026-10-12 — 상단 스타 클릭 UI 운영 배포·읽기 전용 확인 완료

- plan26332 actualexit0: 두 서버 ARM64/privateweb OCIrevision9cf8286, immutable6064eaae pull, build/runtime Server Action 키 일치, 네 플래그ON, mini2/M3 4 보존. deploy92198 actualexit0: 웹 mini2→M3 4 done/healthy, publichealth 두instance 모두release9cf8286/DBok. before.json0600/O_EXCL 생성됨. 이 deploy를 다시 실행하지 않는다. worker는 변경하지 않았으며33349ed/ce17a8 이미지 그대로다.
- verify30231 actualexit0: Docker8앱12컨테이너(주예비6+웹6) 모두 immutableimage/release/healthy, saved/runtime 전체환경 일치, 기존env는웹RELEASE_TAG/NEXT_DEPLOYMENT_ID외변경없음, source/autoDeploy/replicas/command/buildSecrets등정책보존. 네플래그true/configurationMatched. source maintenance 두앱done/설정matched. 전체14앱19컨테이너를 새release로 교체한 것이 아니라 UI-only 두 웹 교체다.
- public GET7516 actualexit0: Threadplane305/DawnAI311/ManimGX447/OpenFilm123/agent-skills-30178의5상세에서모두단일starcontrol이metadatap내에위치/같은count/accessibleName숫자확인. 홈·로그인·익명/api/me까지8GET HTTP200. 별도액션행스타control은없다. 이GET은JShydration/OAuth/개인스타추가·취소/댓글실제기능테스트가아니다. 사용자직접테스트유지.
- 제한/실패: Cloudflare HTML cachepurge는 Authentication error로실패했다. 이어진 canonical 공개8GET에서는이미새배포마크업·양releasehealth를확인하여UI배포를저지하는문제는아니다. 저장된purgetoken 갱신은별도운영후속이다. 실제GitHub상단숫자는최근관측값이며개인별추가/취소확인은색/aria-pressed로표시한다. 스크린샷upstream조회실패의정확한원인은확정하지않았고명시적인조회오류/재시도UI만수정했다.
- 남은일: 문서전달commit/push/정상docs PR check/merge/rootFF와작업일지최종기록. 관리자Tailscale전용접근/아이디비밀번호요청은별도후속으로미구현이며멈춘소개검수는재개금지. 실제스타클릭/계정연결/모바일오류표시기능테스트는user수행.
- 다음정확한명령: docsbranch에서git diff --check→docs/CODEX_HANDOFF.md만add/commit/push→body-file로docsPR→최신base9cf8286/필수check/일반matching-headmerge. rootmainFF. 이미성공한deploy/plan/capture를재실행하지않는다. 현재운영web9cf8286/worker33349ed이다. 기록은private/tmp의 verification.json/public-get.json에0600safe메타로있으며 before.json/preflight.json은비밀포함이므로출력·커밋금지.


### 2026-10-12 — 상단 스타 숫자 즉시 반영 구현

- 현재 목적: 사용자의 상세 상단 개인 GitHub 스타 추가·취소가 확정되면 같은 화면의 숫자를 즉시 +1/−1 표시한다. 사용자 요청은 최소 코드 변경이며 실제 클릭 테스트는 사용자 수행을 유지한다.
- 변경 파일: components/product-detail/GithubStarButton.tsx, 이 인계. 최초 확정된 개인 상태를 기준으로 가장 최신 확정 상태와의 차이만 수집 숫자에 더한다. 추가→취소는 원래 숫자로 돌아오며 반복 조회/동일 응답은 중복 증가시키지 않는다. pending/unknown/uncertain에서는 마지막 확정 숫자를 유지하고 null 원천 숫자는 발명하지 않으며 0 미만은 표시하지 않는다. 기존 request generation/revision/CSRF/operationId/uncertainty 잠금과 상단 디자인은 유지한다. 접근성 이름도 같은 변경 숫자를 사용한다.
- 범위: 현재 상세 UI의 확정된 개인 상태 차이만 반영한다. 공개 DB의 관측된 총 스타 수·스냅샷·급상승 순위·수집 주기 또는 다른 방문자의 변경을 push하는 전역 동기화는 변경하지 않는다. 새로고침 시 공개 원천 숫자는 기존 수집값을 사용한다.
- 실제 검증: git diff --check exit0. 설치된 Next use-client.md를 읽었다. 잘못 추정한 .mdx 경로 및 tests/unit glob 조회는 실패했으며 실제 .md 가이드/tests/github-star-action.test.ts 소스를 확인했다. 사용자가 직접 테스트하므로 새 테스트 작성·로컬 test/typecheck/lint/build/E2E/브라우저 기능시험은 실행하지 않았다. 독립 Codex gpt-6.1-sol/xhigh source-only review session96585 진행 중; 결과 미확정. 필수 정상 GitHub CI는 그대로 수행한다.
- Git 상태: root main ef37a717f3f60cfe5e5ea9b3bec51b5339d80404, 사용자 미추적 자산 보존. 독립 worktree /private/tmp/nomorevibe-star-count-20261012, branch fix/detail-live-star-count-20261012. 현재 운영 웹9cf8286/worker33349ed로 최근 UI-only 배포 때문에 공통 이미지 helper baseline을 그대로 호출하면 release 불일치로 거절되는 정상 상태다.
- 남은 일: 독립 리뷰 결과 반영→변경2파일 commit/push/PR→최신base 필수check 및 일반 matching-head merge→main CI/image digest 확인→웹 mini2/M3 4만 같은 immutable image로 배포→환경/flags/replicas/health/소개 검수 pause 읽기 전용 확인→최종 기록·일지. 관리자 Tailscale/아이디비밀번호 미구현은 별도 후속으로 보존하고 소개검수는 재개하지 않는다.
- 다음 명령: 먼저 source-review session96585와 /private/tmp/nomorevibe-star-count-review-20261012/review.txt 확인; worktree에서 git diff --check. 새 private release.py는 mixed web/worker baseline을 검증하도록 지난 안전 helper를 재사용했으며 아직 capture/plan/deploy 미실행. main CI 완료 뒤 repo cwd에서 python3 /private/tmp/nomorevibe-star-count-review-20261012/release.py capture <merge-sha> <main-ci-id> → plan → deploy 한 번 → verify. snapshot before.json 생성 후 deploy 반복 금지. snapshot은 비밀 포함/0600이며 출력·커밋금지. 기존 Cloudflare purge token은 지난 배포에서 Authentication error여서 이번 purge는 시도하지 않고 canonical public GET/health로 읽기 전용 확인한다.


독립 source-only 리뷰 session96585 actual exit0/clean: 새 결함 없음. reviewer는 파일 변경·테스트·lint/typecheck/build/browser/network/live action을 실행하지 않았음을 명시했다. 운영 baseline read-only session91744 actual exit0: Docker8앱 ready, 웹9cf8286/worker33349ed, mini2/M3 4, fourflags ON. 코드 변경은 버튼1파일 11추가/3삭제이며 새 API·DB·워커 코드 없음. 정상 PR commit/push/CI 진행한다.
