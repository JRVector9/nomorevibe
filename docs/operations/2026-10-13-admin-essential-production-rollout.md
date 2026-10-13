# 필수 관리자 구현 — 병렬 리뷰·운영 배포 기록

2026-10-13. 사용자 지시에 따라 gpt-6.1-sol/xhigh 세 담당의 독립 코드리뷰 후 [prod 절차](/Users/jr/.agents/skills/prod/SKILL.md)와 저장소 runbook으로 운영 배포를 진행했다. 아래 완료 상태는 실제 CI·Dokploy·컨테이너·HTTP 증거로 확정한다.

## 리뷰와 범위

인증 경계, 댓글/번역, 운영 상태·inbox/자동 차단을 나눠 base b8147dc부터 구현 head6848016을 검토했다. 후속671c6d5는 handoff만 변경했다. 재현 가능한 P1/P2 발견은 없었다. 댓글의 state CAS·잠금 순서·in-flight 보존·복원 시 재전송 없음, 번역 현재 원문 CAS·attempts4/backoff·보류, private proof·production local 금지·단일 자격·세션 교체, unknown/stale·같은 release 쌍 비교·닫힌8h reader와 실제 수신 필터를 확인했다.

세 담당의 추가 호환성 대조와 root의 git diff 확인에서 job/worker 진입점·DB/schema·collector·translation policy·outbox 수행 코드는 기존 b592와 같았다. optional transaction과 관리자용 조회는 기존 ledger/job 계약을 사용한다. 이번 배포는 **mini2/M3 4 양 웹만 교체**하며 worker/source5는b592를 유지한다. 공개 페이지·components·i18n·global CSS diff는 없다. 새 migration, dependency, worker collector, RBAC/CMS를 추가하지 않았다.

## PR와 CI

[PR410](https://github.com/JRVector9/nomorevibe/pull/410)을 정상 병합했다. 최초 CI38362899860은 feedback 식별자12px 한 곳이 공통 typography fixture2개를 위반해 실패했다. 실제 표시를13px로 고친 bb3461f에서 기존2파일6사례/lint/diff를 확인했다. 최신 [PR CI38363457760](https://github.com/JRVector9/nomorevibe/actions/runs/38363457760)의 scope/quality/integration1~3/check가 모두 성공했다. quality는 단위247파일2271사례, 타입/i18n/lint, Python 배포 도구 검사, Turbopack build와 bundle 검사를 포함한다.

source main은 `8e767a5fce5f935513e1d942e79593fedd5c4517`이다. [main CI38363987161](https://github.com/JRVector9/nomorevibe/actions/runs/38363987161)의 check/quality/integration1~3·web/worker 이미지 발행까지 모두 성공했다. 실제 단위247파일2271사례, 통합140파일1375사례(3개 묶음434/411/530)가 통과했다.

## 운영 정책

배포 전 core13앱은 모두 Dokploy done/실제 runtime ready였다. 앱 env·provider·replicas·commands·build 설정은 private0700/0600 snapshot에 보관하고 값은 공개하지 않았다. scheduler만 autoDeploy=true였으므로 false로 맞췄다. before/after 모든 필드를 대조해 autoDeploy 외 정책/환경 변화가 없고2복제본이 유지됨을 확인했다. main 병합 때 release/CI와 무관한 source 재시작을 막기 위한 설정이며 scheduler 실행과8시간 관측 주기는 바꾸지 않는다.

기능4개 ON, 관리자 local0, 소개 검수2100 중단, backendb592, 별도 connect-agent는 유지한다. 새 관리자 비밀은 워커에 주입하지 않는다.

## 실제 배포 결과

**완료. 최종 검증 시각: 2026-10-13 16:54:54 KST.**

| 확인 | 실제 결과 |
|---|---|
| 새 웹 image | `ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:cea3b1bdef0f9860605f4172b7fc9d2571f58a4d55016f662f154766079eb337` |
| 양웹 | mini2/M3 4 모두 Dokploy done·실제6컨테이너 digest/release/health 일치 |
| 공개 health | m3-web/mini-web 양인스턴스 `ok`, 새8e767a5 릴리스 |
| 공개 본문 | 4언어×6종류24페이지200, 올바른lang/canonical/새asset, 홈·rising 제품집합 동일, 서버Suspense 오류 없음 |
| 상세 댓글 | 네언어 manimgx의 feedback 영역1, composer0으로 기본 접힘 유지 |
| routing 경계 | 6GET에서 관리자/언어접두 차단과ko정규화 확인 |
| 관리자 위조 요청 | 공개9GET+실제6웹 내부12GET 모두404. 가짜proof/Host/XFF/cookie로 우회되지 않음 |
| core13앱 | 실제 runtime ready 및 적용 환경·명령·복제본·build 정책 일치 |
| source5앱 | text/maintenance 주·예비와scheduler2의 backend523파일 hash 모두 일치 |
| 워커 | 5역할 failover와worker progress 모두ok, 기존b592 image/release 보존 |
| DB·중단 | migration journal76·번역테이블 유지, 소개 검수not_before2100·미임대 |
| 설정 | 네flag ON·관리자local0, scheduler autoDeploy=false/2복제본 |

실제 명령 결과: capture/plan59067, web28256, 공개13154, 최종verify20025, 위조경계76301 모두exit0다. private state의verification/database-preservation/public-get/administrator-boundary에는 안전한 결과가 남으며 env snapshot은 공유하지 않는다.

검증 과정의 실패도 구분했다. 최초verify는 새 웹의tracked 파일목록을 보존backend checkout에서 찾다가 FileNotFound로 실패했다. 파일목록만 backend git checkout 기준으로 고쳤다. 다음1회publisher-m3 snapshot이ready=false여서 중단했지만 재조회에서1/1·healthy·failingStreak0·health exit3회0·기존digest/release를 확인했고 최종 전체검증은 성공했다. 추가 재배포나 재시작은 하지 않았다. 최초 직접경계 probe는127.0.0.1 가정 때문에 실패해 실제standalone의HOSTNAME/PORT로 고친 뒤6컨테이너의12요청을 확인했다. 애플리케이션 인증 경계를 느슨하게 바꾸지 않았다.

## 관리자 내부 접속 경계

실제 `/opt/homebrew/bin/tailscale`로 양host Running을 확인했다. mini/M3의 MagicDNS host는 각각 `9mini.tail02799e.ts.net`, `m3ultra.tail02799e.ts.net`이며 Serve는 미설정이었다. 양웹의 ADMIN_ORIGIN/ingress/password도 아직 없다. 코드 배포 이후 공개 관리자 경로는404로 닫히며, 이것이 private 관리자 설치 완료를 뜻하지 않는다. [관리자 접속 설치](admin-private-access.md)의 private proxy·ACL·방화벽·자격 설정과 실제 브라우저 로그인이 별도 후속이다. production local 우회로 관리자 화면을 열지 않는다.

새 브라우저/E2E·사용자 OAuth·댓글/GitHub 외부 전송·관리자 실제 쓰기를 실행하지 않았다. 사용자 수동 기능 시험과 PENDING의 미확인 운영 검증을 완료 처리하지 않는다.
