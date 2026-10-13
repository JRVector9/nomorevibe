# NoMoreVibe 1인 관리자 운영 감사 — 계정·동선·댓글·분석·정책

- 날짜: 2026-10-13
- 읽기 기준: /private/tmp/nomorevibe-i18n-integration-20261013 (부모가 지정한 PR406 통합 저장소)
- 담당: 관리자 정보구조/접근·인증·세션/감사·위험작업, 일반 사용자·메이커, 댓글·GitHub 연동, 개인정보 기술 상태, 서비스 분석·SEO·다국어, 문의·고지·정책
- 저장소 파일 수정, commit, migration, 테스트 실행, 운영 접근/쓰기, secret/env 파일 열람 없음. 이 독립 메모만 생성했다.
- 분류: **코드 확인**은 읽은 현재 저장소가 제공하는 기능; **추론**은 그 구조가 1인 운영에 주는 효과; **실운영 미확인**은 네트워크/인증/사용자 파일럿/배포에 대해 이번 감사가 검증하지 않은 것.
- 법적 적합성·준법 여부를 판단하지 않는다. 저장·삭제·동의·접수·기록의 기술 상태만 다룬다.
- 부모 제공 운영 증거: 부모 /root가 별도 배포 사전 조회에서 M3/mini 실행 웹 양쪽의 local 우회 활성화와, 쿠키 없는 공개 https://nomorevibe.com/admin · /admin/status · /admin/login 각각 HTTP200을 실제 확인했다고 전달했다. /admin/status에는 Cloudflare edge/cf-ray 헤더와 관리자 본문이 실제 존재했다. 양웹 관리자 OAuth client ID/secret은 미설정이며 allowlist·충분한 길이 세션 키는 존재한다(값/secret 원문 미수록). 따라서 우회만 끄면 OAuth 준비 전에는 관리자 로그인이 불가능하다. 부모는 이전 Tailscale·아이디/비번 지시를 근거로 기존 웹이미지의 local 우회를 끄는 최소조치를 재배포 중이며 이 메모시점 완료증거는 아직 없다. 이 감사 담당자는 원격 호출을 실행하지 않았다. 이전 사용자 Tailscale 관리자 접근·아이디/비번 지시는 아직 코드에 구현되지 않은 요구다. 접근 보호와 관리자 로그인 구현이 모두 끝났다는 뜻은 아니다.
- 구현=관리자·사용자 화면과 동작 코드 존재, 부분=핵심은 있으나 운영 동선/예외 대응 부족, 없음=검토 범위의 메뉴/API/domain 검색에 제공 경로 없음. “없음”은 외부 수동 절차가 없다는 뜻은 아니다.

## 읽은 운영 기준과 해석

AGENTS.md의 현재 운영서비스/13 core앱/main CI·PR/소개 검수 중단을 적용했다. README.md:133–164의 운영 배포·상태 관측, README.md:40–48의 사용자 인증·개인 스타·피드백·관리자 OAuth 분리를 읽었다. PENDING.md:16–19는 2026-10-12 운영 키·마이그레이션·14앱/19컨테이너·네 웹 플래그 true를 기록한다. 따라서 일반 로그인/댓글이 현재 꺼져 있다고 보고하면 안 된다. PENDING.md:11–13은 실제 GitHub 가입/스타/댓글/봇 Issue·철회/failover 사용자 파일럿 증거가 아직 없다고 기록한다. README의 “기본 false”는 코드 기본값이며 현재 운영 false의 증거가 아니다.

docs/operations/2026-09-22-admin-deployment.md:21은 당시 관리자 익명 접근 허용 정책이 미결이라고 기록한다. 현재 코드의 app/(operator)/admin/status/actions.ts:23–25도 ADMIN_LOCAL_LOGIN 운영 관리자 및 OAuth/Cloudflare Access로 화면 보호가 남았다는 설명을 갖고 있다. 추가로 부모가 양웹 local 우회 활성화와 무쿠키 공개 관리자 HTTP200을 실제 조회해 제공했다. 따라서 현재 접근 노출은 부모 실측으로 확인된 P0다. 이번 담당자는 Tailscale ACL/OAuth 로그인 성공·실제 쓰기 호출은 확인하지 않았다.

관련 문서: docs/operations/github-stars-feedback-runbook.md(설정·동의·설치·전송·복구 계약), docs/operations/2026-09-22-admin-domain-review.md, docs/operations/2026-10-13-i18n-auth-pages-implementation.md, docs/operations/2026-10-13-i18n-content-implementation.md, README/PENDING. 이 문서에 적힌 타인의 테스트는 이번 감사의 실행 결과로 계산하지 않았다.

## 기능별 실제 상태

| 기능 | 상태 | 실제 메뉴/페이지/API/domain 근거 | 1인 운영 평가와 빈틈 |
|---|---|---|---|
| 관리자 메뉴·정보구조 | 구현 | app/(operator)/admin/AdminNav.tsx:11–37: 일하기(오늘 할 일·운영센터·심사 큐·내릴 후보·피드백 검수·GitHub 연동·제품), 설정·기록(크롤·카테고리·근거·랭킹·AI소식·수집계정·로그) | 이미 충분한 관리 영역이 있다. 메뉴를 더 늘리기보다 기존 화면 연결을 보완한다. /admin은 홈 허브가 아니라 크롤 설정이다. |
| 매일 처리 동선 | 부분 | /admin/inbox; app/(operator)/admin/inbox/page.tsx:16–19,31–55; lib/operations/inbox.ts:24,144–203; app/(operator)/admin/inbox/inbox-model.ts:16 | oldest preview5·건수·딥링크·구획별 실패는 구현. 키는 takedown/introRequest/human/agreed/audit/down/intro/repoGone/spam뿐. held 댓글 및 uncertain/blocked 전송은 합계/최고령/완료 수에 없다. 새 기능을 운영자가 별도 메뉴에서 찾게 된다(P1). |
| 메뉴 긴급 배지 | 부분 | app/(operator)/admin/layout.tsx:33–47 | 내릴 요청/소개·직접심사·운영 긴급만 표시. 피드백·전송 복구는 배지 없음. 1인에게 새 할 일 누락 위험(P1). |
| 전역 찾기·공개 이동·반응형 | 구현/부분 | AdminShell.tsx:24–66; /admin/search; app/(operator)/admin/search/route.ts:12–16; lib/operations/admin-search.ts:19–48 | ⌘K 검색은 제품·심사후보·감사로그 대상까지만. 계정·댓글 ID/제목·외부 전송 dispatch는 포함하지 않는다. 기존 검색확장이 장기적으로 유용(P2); 지금 별도 대시보드는 불필요. |
| 관리자 GitHub OAuth | 코드 구현 / 운영 미설정(부모 제공) | /admin/login → /api/auth/github → /api/auth/github/callback; login/page.tsx:20–37; auth/github/route.ts:19–28; callback/route.ts:27–61; lib/auth/admin.ts:22–35,75–83 | read:user, OAuth state, 허용 로그인 목록, 매요청 allowlist 재검사 존재. 부모실측은 양웹 client ID/secret 미설정, allowlist·세션키 존재. 따라서 현재 OAuth로 운영자 로그인할 수 있는 상태가 아니다. 운영자 로그인 자체의 완성은 별도 P0다. |
| 관리자 ID/비번 | 없음 | login/page.tsx:30–38에서 GitHub 링크만; lib/auth/admin.ts:17–35; lib/auth/session.ts:11–14 | password verifier/비번 폼/계정 테이블·변경/복구 UI 없음. 부모가 확인한 이전 사용자 아이디/비번 지시는 미구현 요구다. 단일 운영자 자격과 서버 검증·로그아웃·실패 제한을 최소 범위로 구현할 필요가 있으며 RBAC는 필요없다. Tailscale은 앱 로그인 자체가 아니다. |
| Tailscale 전용 접근·운영 local 우회 차단 | 부분/P0 운영 노출 확인(부모 제공) | proxy.ts:53–57; lib/auth/admin.ts:17–18,70–73; docs/operations/independent-workers-runbook.md:229의 Tailscale 내부 worker 설명 | **코드 확인:** ADMIN_LOCAL_LOGIN=1이면 NODE_ENV·peer·헤더 검증 없이 모든 요청이 관리자. **부모 실측:** 양웹 우회 활성화·공개 무쿠키 admin/status/login HTTP200. **추론:** 같은 currentAdmin을 쓰는 관리자 action/API의 자격 검사도 우회되며 실제 mutation은 시험하지 않았다. 앱에 Tailscale 사용자/ACL 검증 코드는 없다. 현재 Tailscale-only 관리자 보호 요구는 미구현이고 공개 접근 노출이 P0다. |
| 관리자 세션·로그아웃·회수 | 부분 | lib/auth/session.ts:11–14,39–44,69–91; lib/auth/admin.ts:82–83; app/api/auth/logout/route.ts:6–10 | HMAC 서명·12h 만료·HttpOnly/SameSite/production Secure·POST 로그아웃·allowlist 회수 존재. active session 목록/개별 서버 revoke는 없음(서명 cookie). 1인 운영은 allowlist/키교체·재로그인 운영 절차로 최소 해결; RBAC/다중운영자 UI 불필요. local 모드는 로그아웃 쿠키 제거 후에도 currentAdmin이 재허용함(P0 경계와 동일). |
| 관리자 작업 감사·CSV | 구현/부분 | /admin/activity; activity/page.tsx:24–28,70–73,172–176; lib/operations/admin-log.ts:50–77,97–104; activity/query.ts:29–37; drizzle/0056_operations_audit_append_only.sql:16–25 | actor/kind/IP/UA/성공·실패·전후 detail·filter/paging·CSV·DB append-only 존재. 일부 작업은 mutation 후 best-effort audit이므로 audit 실패는 시스템 로그만 남음(admin-log:60–72). 로그인 허용·거절은 observability(logger)만(callback:14–18,58). local 이름은 자기신고이며 인증 신원이 아님(admin.ts:38–43). |
| 위험 작업 확인·되돌림 | 구현 | ConfirmAction.tsx:6–28,112–125; ProductRow.tsx:89; lib/domain/products/manage.ts:44–92; github-integrations/page.tsx:42–48, actions.ts:14–28 | 대상·영향·사유·메모 확인·처리중·오류 유지·제품 차단해제 있음. GitHub 재전송은 중복위험 체크/사유/원문·binding·payload CAS/멱등 요청 추가 보호. 기능 전체 재설계 필요 없음. |
| 일반 사용자 로그인·연결 해제 | 구현 | /login; public login/page.tsx:24–50; /api/me; lib/domain/accounts/session.ts:4–6,18–21,49–54; accounts/repository.ts:78–90; /api/me/github DELETE:13–19; github-user/repository.ts:64–67 | GitHub 또는 선택 이메일 OTP·30일 opaque DB session·CSRF/Origin·logout·GitHub 토큰 폐기/연결 해제 있음. 일반 계정과 관리자 인증은 별도. disconnect는 사용자 삭제/댓글 철회가 아니다. |
| 일반 사용자 운영 조회·차단·세션 회수 | 없음 | AdminNav.tsx:11–37(계정운영 없음); public-user-schema.ts:4–24(이름/identity/session, user 상태 없음); accounts/repository.ts:78–90(단일 session revoke만) | 공개 댓글을 쓰는 계정의 반복 악용/접속문제에 관리자 대응 수단 없음. 최소 user ID/GitHub login 조회+작성 정지/복구+모든 session revoke·사유 기록을 기존 피드백 화면에 붙이는 정도(P1). 전체 회원 CRUD·RBAC 불필요. |
| 메이커 관리·소유권·제품 삭제 | 구현/부분 | /api/products/[slug] PATCH/DELETE:69–94; lib/domain/products/actor.ts:16–30; maker-auth.ts:7–23; manage.ts:8–41; verify.ts:31–38,82–107; /admin/products ProductRow.tsx:89–107 | 수정키·도메인 확인·crawler 제품 claim·새 키 1회 발급·메이커 제품삭제·관리자 차단/해제·GitHub 초대 링크/보냈음 표시 있음. 메이커 회원계정/소유제품 목록은 없다(계정 붙이는 계획 주석 actor.ts:7–18). 이 규모에서 제품 중심 모델을 유지해도 된다. |
| 메이커 키 분실/유출 복구·설치형 소유 처리 | 없음/부분 | verify.ts:34의 설치형 “관리자에게 저장소 소유 확인 요청”; :36–38 verified 즉시 already 반환; :82–83 최초 unclaimed만 키 발급. actor.ts:16–30; lib/domain/products/claim-invite.ts:15–17,74–98 | 이미 claimed/verified인 제품의 수정키 재발급 API·관리자 액션을 찾지 못함. 도메인 재증명으로 안전한 키회전, 설치형 repo ownership 확인을 한 제품에서 처리할 최소 지원절차가 필요(P1/P2). 일반 public login만으로 edit 권한을 주면 안 됨. |
| 댓글 작성·사전 검수·스팸 제한 | 구현 | /api/products/[slug]/feedback, /api/me/feedback, /feedback/[id]; /admin/feedback page.tsx:13–35; feedback/submit.ts:28–50; contract.ts:43–56,70–73; repository.ts:74–95; feedback/actions.ts:10–25 | 사용자·서비스 공개동의·GitHub 별도동의·멱등·5/시간+20/일·URL4개/24h본문 반복 held·원문 private visibility·검토사유 감사 구현. 모든 댓글이 사전 검수되는 것은 아님: 나머지는 즉시 accepted. |
| 댓글 사후 숨김·신고·반복스팸 계정 제재 | 없음 | feedback/review.ts:23은 held만 변경; repository.ts:88–94는 held 100건만 큐; contract.ts:70–73 자동accepted; product-feedback-schema.ts:21–26 | 이미 공개된 욕설/개인정보/잘못된 글을 관리자에서 숨기거나 신고로 검토·복원할 기능 없음. 삭제·수정·작성자 철회도 없음. 제품 차단은 대응 범위가 과함. 공개 후 대응 가능한 작은 moderation PR가 P1 최우선. |
| 댓글 검수의 목록·결과 UX | 부분 | /admin/feedback page.tsx:19–35, actions.ts:9–28; feedbackReviewQueue:88–94 | 가장 오래된 held100건은 처리하며 줄어들지만 검색/전체수/최고령/paging/내역/성공·오류 상태 UI 없음. 새 페이지에 기존 ConfirmAction/Toast/scroll-list pattern을 재사용(P1/P2). public list도 최신50, 내기록100 limit(repository:37–41,63–69). |
| GitHub 피드백 전송·복구 | 구현/부분 | /admin/github-integrations page.tsx:14–49; domain/github-webhooks/admin.ts:43–107,110–117; request auth/actions.ts:14–28; docs/operations/github-stars-feedback-runbook.md | 최근100 상태·원문·repo/installation/binding/error·이슈링크·재조회/중복위험 동의 1회 재전송 구현. 상태필터/오래된 실패 우선/전체수/paging/복구내역은 없음. 갱신 최근100이 오래된 문제를 가릴 수 있음(P1). 댓글/GitHub 본문 양방향 sync/외부 이슈closed=문제해결은 제공하지 않으며 꼭 필요한 최소 운영기능도 아님. |
| GitHub 복구 감사의 관리자 조회 | 부분 | admin.ts:36–40은 githubIntegrationActions에 저장; lib/db/github-webhook-schema.ts:29–44; activity/query.ts:29–37은 operationsAudit만; github-integrations/page.tsx:22–49는 현재row만 | 이력은 DB에 존재하므로 “감사없음”이 아님. 그러나 기존 작업로그/CSV/상품대상에서 재조회/재전송 처리자·사유를 못 봄. 기존 activity에 연결하거나 전송카드에 최근 복구이력을 표시(P1/P2). 0072에는 별도 integration action의 append-only trigger가 없고 outbox 삭제 cascade. 보존정책 확정이 필요하며 모든 감사가 불변이라는 표현은 부정확. |
| 개인 GitHub Star 불명확 요청 | 부분 | PENDING.md:2; runbook “개인 Star 변경 unknown”; domain/github-stars 및 GitHub연동 메뉴는 feedback outbox만 | unknown은 GET 상태가 일치해도 잠금을 유지하며 현재 자동/운영자 해제 API 없음. 안전한 정책이지만 사용자가 이후 계속 못 누르는 사유를 운영자가 조회·안내할 최소 수단이 필요(P1/P2). 단순 “현재 값 같은데 해제” 버튼은 제안하지 않는다. |
| 탈퇴·서비스 개인정보삭제/내보내기·보존 정리 | 없음/부분 | public-user-schema.ts:10–37(이메일 identity/challenge·session); product-feedback-schema.ts:10(user FK); AccountMenu.tsx:29–50 logout만; github-user/repository.ts:64–67 token clear만; 검색로그90일 prune(search-log.ts:43–48), 클릭원천35일 prune(clicks.ts:378–409) | 계정탈퇴/내 데이터 요청/댓글철회/일반인 session·만료OTP의 cleanup job·관리자 처리경로는 찾지 못함. 이메일 challenge는 OTP10분 만료지만 행삭제와는 다르다. feedback author FK는 cascade가 없어 계정 행 단순삭제로 해결되지 않음. 외부 Issue에 이미 공개한 내용은 사이트 계정삭제로 회수되지 않는다. 먼저 데이터 inventory/보존·익명화/외부범위 명시+제한 삭제·처리기록(P1); 법적 평가 없음. |
| 서비스 검색·클릭 분석 | 구현/부분 | /admin/status page.tsx:262–325: 30일 많이눌린제품, 7일검색량/0건율/번역/p95/misses/hits. search-log.ts:20–36,104–140; /go/[slug] route.ts:27–47; clicks.ts:27–48,70–80; schema.ts:283–354 | 운영 품질분석은 이미 있다. 검색어200자/결과/필터/시간·키워드, 클릭 제품별 HMAC·10분dedupe·bot제외·일별롤업·랭킹 존재. 월별서비스UV/유입경로·locale·목록노출→상세→외부클릭 전환은 이 schema에 없음. 기존 수치는 아웃바운드로 보낸 브라우저 수여서 사이트 전체UV로 해석하면 안됨. |
| 목록 전환·유입·언어별 성과 | 없음 | click_events=slug,time,product visitorHash(schema:283–290); search_queries에 locale/source/session 없음(:333–345); /go는 referrer/source 수집 없음(route:27–47) | 제품 노출수·상세열람 분모 없어 CTR 계산 불가. 필요할 때 기존 status에 익명 day/locale/surface별 impression/detail/outbound aggregate만 확장(P2). 개인 동선추적/새 분석 플랫폼/대시보드부터 만들 필요 없음. 검색에 locale 필드를 추가하면 다국어0건·p95 비교가 쉬움(P2). |
| SEO·다국어 공개 UI | 구현 | lib/i18n/locales.ts:2–12(ko/en/zh-Hans/zh-Hant); proxy.ts:20–40 admin우선·machine예외; i18n/metadata.ts:7–45 ready locale reciprocal alternate/selfcanonical/noindex; app/robots.ts:18–25; app/sitemap.xml/route.ts:6–9; app/sitemaps/[locale]/[file]/route.ts:5–14; products/indexing.ts:49–55 | 색인규칙·takedown 즉시noindex·locale 준비도·분리 sitemap·noindex admin/auth/feedback 구현. 모든 외국어 제품이 번역완료·색인가능한 것은 아님. 운영 실SEO/검색엔진 발견·번역 의미 검수는 이번 감사 미확인. 관리자 한국어는 1인 운영 요구에 문제 아님. |
| 공개 제품 다국어 번역 운영 | 부분 | productTranslations schema.ts:477–502; products/translations.ts:71–100(수요)/111–117(최대4회)/134–145(CAS·retry); jobs/catalog.ts:70; registry.ts:115. 관리자 TranslationProgress.tsx:15–35는 사유→한국어 진행 | 공개field en/zh별 queue/해시·failed/error/model/retry·유한4회·소유권/stale guard 있음. 그러나 관리자에 locale별준비율/최고령/실패소진/원문-번역 비교/재시도/수동검토 표시 없음. 기존 사유번역패널로 새 번역까지 관측된다고 주장하면 안됨. 최소 기존운영센터패널+상품상세 특정 field 재시도/숨김(P1/P2). 소개 검수 pause와 분리한다. |
| 프로젝트 문의·삭제/수정 요청 | 구현 | /policy#contact page.tsx:128–134; messages/ko/policy.ts:38–41; lib/domain/products/takedown.ts:44–61; /api/products/[slug]/takedown 및 intro-request; /admin/audit/요청 · inbox | 공개이메일 없는 운영자 결정(D5)대로 제품상세 요청폼→관리자 처리 연결. unclaimed제품은 내려달라는 요청, 설치형/소개오류는 수정요청. 일반 서비스 문의 채널을 이미 제공한다고 해석하면 안됨. |
| 일반 문의·로그인/계정/댓글 신고·접수결과 | 없음/부분 | policy/page.tsx:23,128–134; takedown.ts:54–61은 주인있는제품 거절; SiteFooter.tsx:21–25(지표·등록·게재기준만) | 로그인불가/계정삭제/악성댓글/사이트오류를 특정 unclaimed제품 밖에서 접수·상태/완료를 알릴 경로 없음. 기존 inbox에 좁은 “서비스 요청” 종류를 연결하는 작은 접수채널(P1). 제품요청과 댓글을 문의대체로 오용하지 않음. 공개이메일 추가는 기존 결정과 충돌하므로 필요 없음. |
| 게재정책·고지·개인정보·공지 관리 | 부분 | /policy page.tsx:17–23,41–47 및 locale policy catalogs; SiteFooter.tsx:21–25; public login/page.tsx:39–50 | 게재기준·AI근거·제외·미클레임·내림·연락 4언어 정적 코드로 관리. 서비스 이용/계정·이메일·방문쿠키·검색어·댓글/GitHub 외부공개·삭제범위/보존 고지는 독립 페이지/링크를 찾지 못함. 관리자 policy CMS/버전/동의버전도 없음. 소규모는 정적문서+버전·시행일+PR와 기존검사로 충분(P1). 제품의 privacySummary(detail IntroSection)는 서비스 개인정보고지가 아니다. |

## 우선순위와 최소 PR 단위 / 수용 기준

### P0-1: 공개 관리자 local 우회를 즉시 닫고 지정된 접근 요구 완성
- **필요**: 부모가 양웹 ADMIN_LOCAL_LOGIN 우회와 무쿠키 공개 관리자 HTTP200을 확인했다. 같은 자격 경로로 수집자격·AI연결·제품차단·GitHub 재전송이 가능하므로 현재운영 P0다. 실제 쓰기는 검증하지 않았다.
- **최소 조치**: 부모가 양웹 local 우회를 끄는 기존이미지 재배포를 진행중이다(완료미확인). 부모실측은 양웹 OAuth client ID/secret 미설정이므로 우회를 끄면 관리자 OAuth 접근은 실제로 잠긴다. 이는 노출을 닫는 임시조치이며 관리자 운영 기능 완성이 아니다. 지정된 Tailscale·아이디/비번 또는 사용자승인된 OAuth 준비·실제허용로그인은 **별도 P0 필수**다.
- **최소 PR A**: ADMIN_LOCAL_LOGIN production 우회 차단과 인증 실패가 닫히는 회귀검사. Tailscale 전용 관리자 ingress/공개호스트 차단·직접origin/callback/API 경계를 기존 배포 설정에 명시.
- **최소 PR B(P0 필수)**: 이전 사용자 아이디/비번 요구를 단일 운영자 로그인·서버 credential검증·실패 rate limit·CSRF·session/logout·회수/교체로 구현. 임의 다중계정/RBAC를 추가하지 않는다. Tailscale 경계와 앱 신원검증은 각각 확인한다. 기존 OAuth 유지 여부는 기존 사용자 지시에 맞춘다. access local 우회 차단 성공만으로 이 PR/실로그인 완료를 주장하지 않는다.
- **수용 기준(향후 작업자 검증)**: 비인증 public/직접origin/locale-prefixed admin 및 관리자 API 요청이 데이터·쓰기 불가; Tailscale 지정경계/허용1명은 로그인·조회·허용쓰기; 비허용·잘못된 비번·만료·logout 후 거절; 양웹 같은정책; 비밀값출력 없이 배포기록. public/login HTTP200만으로 정상 보호라고 판단하지 않고 실제 protected page의 content·redirect/403도 확인한다.
- **분리**: 부모의 운영 사전조회와 현재 최소 환경조치는 이 담당자의 read-only 감사와 구분한다. 신규 인증 구현/운영쓰기·실사용자 OAuth 승인은 이 감사에서 수행하지 않았다.

### P1-1: 공개 댓글 사후 검수와 최소 사용자 작성정지
- **문제**: 자동accepted 악성글은 현 admin held 큐로 돌아오지 않는다.
- **최소 PR A**: /admin/feedback에 accepted/held/rejected 필터+feedback ID/제품 조회, 숨김/복원 사유·예상상태 CAS·원문작성자/관리자 private 보존. 원문 임의수정 없이 공개가시성만 바꿈.
- **수용**: 이미accepted글을 숨기면 공개목록/permalink에서 사라지고 본인·관리자는 확인; 복원·중복요청·동시변경 올바름; 미발송 outbox는 막고 이미발송/uncertain은 전송완료를 거짓취소하지 않음; audit 원자기록; 오류/완료 결과 표시.
- **최소 PR B(다음)**: 반복악용 user ID의 새작성 정지/복구·세션전체 revoke·사유, 계정조회는 피드백 작성자에서 진입. masked식별 최소공개. 전체 회원 CRUD는 범위 밖.
- **수용**: 정지계정 모든 새쓰기(피드백/필요한star정책)가 서버차단되며 logout재로그인 우회없음; public product edit-token권한과 혼동없음; 복구감사.

### P1-2: 기존 오늘 할 일에 댓글·전송복구를 연결
- **PR**: 기존 loadInbox/assembleInbox/navBadges에 held댓글과 uncertain/blocked/stale-sending 등 사람필요전송을 추가. 별도dashboard 없음.
- **수용**: 처리화면과 같은조건 count/최고령/5건preview·직접link; 하나조회실패가 0건/모든일없음으로 오인되지 않음; 처리 후반영; done 집계 설명 정확; 소개검수 중단 유지.
- **선행필요 없음**: 현상태의 held·outbox에도 바로적용가능.

### P1-3: GitHub 연동의 오래된 실패 찾기·복구이력·사용자 파일럿
- **PR A**: existing GitHub메뉴에 state/제품/feedbackID 필터, oldest문제순·keyset paging·상세처리결과/에러, integrationActions 이력 read. operationAudit 추가요약 또는 activity 연결 중 한 가지로 “누가 왜 재전송”을 검색가능하게 함.
- **수용**: 최근정상100건보다 오래된 uncertain건을 찾을수있음; 재조회와 retransmit구분·중복risk동의·expecteddispatch/payload/binding 검사 유지; actor/reason/requestID/시간 이전결과 보임; provider비밀·원문 과도로그없음.
- **운영파일럿(코드PR와 별개)**: PENDING의 실제 가입/스타/댓글/발송/재조회/철회/failover 범위를 허가된 사용자·repo로 확인해야 완성. 이번감사는 미실행.

### P1-4: 서비스 요청·계정삭제/댓글철회/개인정보 기술 처리경로
- **PR A**: 계정·신고·사이트오류 등 좁은 서비스요청폼과 접수번호, 기존 Inbox에 count/link·완료·사유·처리기록. 공개email요구하지 않음.
- **PR B**: 현 데이터 inventory에서 user identity/emailchallenge/session/GitHub암호문/댓글/outbox/외부issue별 삭제·익명화·미발송취소·보존경계를 정하고 제한된 본인 요청+관리자처리. 계정삭제전 feedback FK와 외부 uncertain/inflight 계약 처리.
- **수용**: 자신 또는 허용관리자만 요청/처리; 전체session 철회·credential폐기; 타계정데이터불변; 재요청멱등; 사이트탈퇴가 외부GitHub Issue삭제 완료로 표시되지 않음; 만료OTP/session 정리job의 기한·처리량·관측; 단순 product deletion과 구분.
- **판단범위**: 법적완결성·기한규정을 제시하지 않고, 운영자가 결정한 기술보존계약을 구현·검증.

### P1-5: 최소 정책 고지
- **PR**: 기존 정적 /policy 운영을 활용해 서비스계정·댓글/GitHub·쿠키/검색기록·탈퇴/철회범위를 설명하는 필요한 문서와 locale별 link, 시행일/version를 추가. 정책 CMS나 다중승인없음.
- **수용**: footer/login/댓글동의에서 해당문서에 닿음; 기재내용과 실제기능·35일클릭/90일검색 등 보존코드일치; locale내용/key·machine endpoint예외 유지; 기존 게재앵커안깨짐. 법률결론은 별도전문검토대상.

### P1/P2-6: 공개번역 관측과 제한 복구
- **PR A**: /admin/status 기존하위panel에 언어/field별 pending/ready/failed/exhausted·최고령/마지막저장·소스불일치/현재hold·오류별수.
- **PR B**: /admin/products/[slug]에서 source/locale/field hash를 보여주고 특정실패수요 1회재시도/숨김/검토된값의 제한조정+사유audit. 목록전체무한백필·소개검수재개 금지.
- **수용**: attempts4소진값과 retry대기구분; KO사유번역과 별개; 원문변경뒤이전ready노출없음; 잘못된중국어script/숫자/URL gate 유지; 실패locale는 noindex/hreflang준비도 일치; 새작업이text lease기존큐와공존.
- **우선순위**: multilingual 운영 중이라 실패관측은 P1, manual editorial UI는 실제문제빈도에 따라 P2.

### P2-1: 메이커 키 복구 / 최소 지원
- **PR**: 이미claimed웹제품에 fresh ownership challenge로 키회전·old key무효화·한번만반환·사유감사. 설치형은 기존 GitHub확인계약과 접수채널을 연결. 일반login만으로 ownership인정하지 않음.
- **수용**: 분실키없이fresh증명가능; 이전token즉시불가; 오래된verifyfile재사용으로탈취못함; claimed제품/ban/동시회전CAS·암호문안로그; 설치형예외처리메뉴및결과명확.
- **현재허들**: 기술적으로 필요하지만 incidence미확인. 일반계정/소유제품dashboard까지확대하지 않음.

### P2-2: 최소 전환·언어분석
- **PR**: 기존 검색요약에 locale dimension, 기존운영센터에 day/locale/surface별 목록노출·상세열람·outbound aggregate(필요한분모만), 검색/0건/p95 비교.
- **수용**: outbound고유값을 siteUV로 부르지않음; bot/prefetch/더보기중복·캐시된렌더의측정정의명확; referrer는 필요시 origin host만; 민감query/토큰/계정이 event metadata로 안들어감; 보존기한/수집실패unknown표시. 기존랭킹점수/visitorproduct별분리 유지.
- **범위**: 계정별전여정추적/광고·CRM/새analyticsdashboard는 지금필수아님.

## 1인 운영의 현재 권장 일과 (구현된 것 우선)

1. /admin/inbox에서 요청·사람심사·내릴후보 순서대로 확인.
2. /admin/status에서 worker·잡·critical·검색0건/p95·클릭상위·사유번역 확인.
3. 현재 누락기간에는 /admin/feedback의 held원문과 /admin/github-integrations의 uncertain/blocked를 별도로 열어 확인(개선PR 전).
4. 해당 제품·후보의 기존 관리화면에서 사유를 남기고 처리, /admin/activity로 결과확인. GitHub재조회/재전송은 현작업로그에서 내역조회안되므로 별도DB이력읽기지원이 필요.
5. 설정은 /admin 등 기존메뉴에서 변경. PENDING.md:46–59의 저장후 dirty/성공알림 결함은 사용자오인·중복저장의 실무위험으로 별도작은UI PR 대상이며 이번감사에서 해결/테스트하지 않았다.
6. 도메인·키·기능활성화·외부동의 파일럿·장기검증은 runbook/PENDING를 따라 별도권한으로 수행. 소개검수중단은 재개하지 않는다.

## 실제 실행한 검증과 한계

- 실행: pwd, ls, rg --files, rg -n, nl -ba/cat/sed/head 등 저장소 읽기만. 잘못된 src/db/components/admin/app/[locale] 경로 읽기는 오류를 냈고 실제 tree app/(operator), app/(public)/[locale], lib/db로 수정해 읽었다. 명령오류는 기능실패증거가 아니다.
- 테스트: **실행하지 않음**. unit/integration/E2E/build/typegen/lint/migration/DB/HTTP/OAuth/GitHub실쓰기 없음.
- 운영: **이 담당자는 접근하지 않음**. 부모가 별도로 실제 조회한 양웹 local 우회 활성화·무쿠키 public 관리자 HTTP200을 인용했다. TailscaleACL/관리자실로그인/실외부전송/실제관리자mutation/현재번역처리량·SEO색인은 이 담당자 검증없음.
- 작업범위: 공유repo와 docs/CODEX_HANDOFF.md 수정안함(부모가 major phase handoff를 담당). 이메모는 구현지시·배포승인이 아니다.
