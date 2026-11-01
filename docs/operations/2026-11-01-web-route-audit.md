# 웹 경로 신뢰성·병목·보안 소스 감사 — 2026-11-01

## 기준과 검증 경계

- 기준 main: `f70901181e89e95e4e4a9d916b27f8a6d22a6e32`.
- 작업: `codex/reliability-web-20261101`, 별도 worktree `nomorevibe-reliability-web-20261101`.
- `app/**/page.tsx` **48개 전부**의 진입점·권한 확인·파라미터·조회 의존관계·실패 경로를 소스로 확인했다. 공개 20개에는 URL을 따로 만들지 않는 `@seasonfooter/page.tsx`가 포함된다. 관리자 28개다.
- `app/**/route.ts` **78개 전부**의 메서드·래퍼·공유 인증/오류 처리 표면을 목록화했다. API 전체 내부 구현의 침투 시험이나 모든 저장소 SQL의 실행 계획 분석을 했다는 뜻은 아니다.
- 루트·공개 locale/content/me·operator/admin layout, 공개/전역 오류 화면, not-found, `proxy.ts`, `next.config.ts`, 공개 캐시·복제본·DB pool·요청 인증·maker route 공통 경로를 함께 확인했다.
- 실제 브라우저·로그인·운영 DB·네트워크·배포·부하 시험은 하지 않았다. 사용자 지시대로 **로컬 테스트·lint·typecheck·build·컴파일을 실행하지 않았다**. 필수 GitHub CI 및 실제 운영 확인은 root가 진행한다. 이 문서는 source 완료 기록이며 운영 복구 성공 인증이 아니다.
- 실제 실행한 `git diff --check`는 EXIT 0이었다. 이 결과는 추적 파일 diff의 공백 검사이며 기능 테스트 통과가 아니다.
- Next 16.4.1 설치 문서의 `01-app/01-getting-started/{10-error-handling,06-fetching-data}.md`, `03-api-reference/03-file-conventions/{error,proxy}.md`, `03-api-reference/05-config/01-next-config-js/headers.md`를 원 작업 폴더의 `node_modules/next/dist/docs`에서 읽었다. 설치 구현 `client/components/error-boundary.js`에서도 `retry()`가 router refresh+경계 reset임을 확인했다.

## 증거가 있는 수정

1. **실패 화면이 수동 조작을 기다리던 경로**: 전역·공개 오류 경계에 제한된 자동 재조회를 연결하고 관리자 오류 경계를 추가했다. 서버 오류의 digest가 있는 경우만 자동 시도한다. 브라우저 렌더 오류는 수동 시도를 유지한다. 관리자 페이지 실패 때 정상 admin layout과 메뉴가 남는다. layout 자체 실패는 전역 경계가 맡는다.
2. **예외를 잡아 정상 HTML 안에 실패 안내를 그리던 목록**: 홈·분야·신규 모두보기·인기·급상승·화제는 실패 시 `error.tsx`로 가지 않는 경우가 있었다. 실제 핵심 목록 읽기 실패에만 같은 자동 재조회 부품을 넣었다. 정상 빈 목록·급상승 기준선 준비 중·비공개 화제의 404·옵션 구획 누락에는 자동 재조회를 붙이지 않는다.
3. **`/popular`의 불필요한 전체 실패**: 목록과 보조 facet 집계를 `Promise.all`로 함께 대입해 facet 하나가 실패하면 이미 성공한 목록까지 버렸다. `allSettled`로 각각의 결과를 보존한다. 집계를 못 읽으면 수를 숨기며 0으로 만들지 않는다. facet 실패만으로 전체 페이지 자동 재조회를 반복하지 않는다.
4. **API 예외 응답의 명시적 캐시 금지 누락**: `withRoute`의 미처리 500·출처 permit 보류 503·writer fence 503에 브라우저/공유 캐시용 `Cache-Control: private, no-store`, Cloudflare용 `Cloudflare-CDN-Cache-Control: no-store`를 넣었다. 기존 성공 응답과 도메인 응답의 캐시 정책·요청 ID·오류 비공개·fence Retry-After는 보존한다.
5. **관리자 심사 갈래의 상속 키 허용**: `/admin/review?cause=constructor`·`toString`·`__proto__`를 `in`이 갈래로 받아들였다. `Object.hasOwn`으로 실제 정의만 받는다. 기존 CSV export의 같은 조건 검증과 맞췄다.
6. **복구 GET의 새 edge key와 origin cache 제외**: 자동 시도는 `crypto.getRandomValues`의 128-bit 비밀 아닌 nonce로 예약 query `__nmv_recover`만 바꾼 같은 출처 document URL에 `window.location.replace`한다. locale·다른 query 값·반복 필터·인증 return 값·hash는 보존한다. `location.reload`의 POST 재전송이나 같은 cache key의 RSC refresh를 자동 호출하지 않는다. 시도 예산을 차감한 직후 `nmv_render_recovery=1` cookie도 20초만 설정한다. `Path=/; SameSite=Lax`, HTTPS에서 `Secure`, Domain과 사용자 데이터는 없다. `next.config.ts`가 정확한 이름/값을 edge TTL 대상에서 빼고 CDN no-store를 적용한다. `proxy.ts`는 기존 경로·언어·인증 판정 후 같은 cookie가 있는 GET/HEAD 응답에 private/no-store와 CDN no-store를 붙인다. 정상 요청의 기존 cache 시간은 보존하며 이 cookie는 인증 능력이 없다. cookie만으로 기존 edge HIT를 우회하지 못한다는 운영 증거와 새 query key의 MISS 증거는 아래에 기록했다.

자동 복구는 **같은 탭 전체에서 60초 창당 최대 두 번**, 2초/5초 지연으로 **화면 document GET만** 다시 받는다. 경계가 remount되거나 다른 주소로 이동해도 예산을 공유한다. 복구 query가 있는 자동 GET의 후속 화면은 60초가 지나도 이전 예산을 다시 열지 않는다. 따라서 느린 실패 응답이 매번 60초를 넘겨도 무한 재시작하지 않는다. 이후 복구 query가 없는 독립 이동에서만 새 시간 창을 열 수 있다. 매번 새로운 nonce로 다음 GET key를 만들며 sessionStorage에는 URL/nonce를 남기지 않는다. 동시 실패 부품이 같은 예산 판을 보고 예약했다면 먼저 실행한 것만 재조회를 시작한다. 숨겨진 탭·offline에서는 타이머를 취소하고 예산을 쓰지 않으며 다시 보이고 연결되면 지연을 새로 둔다. unmount 때 타이머와 listener를 정리한다. 지속 오류는 예산 소진 뒤 멈추며 다음 창까지 기다려 스스로 재시작하는 timer는 없다. 저장소 차단·손상·미래 시각 값·crypto/navigation 차단이면 기존 수동 UI를 유지한다. 저장값은 시작 시각과 시도 수뿐이며 경로·계정·오류 내용을 저장하지 않는다.

수동 `retry()`는 그대로다. 자동 경로는 현재 화면 URL에 document GET만 하며 폼 전송·server action·로그인·제품 수정·검수 결정·재전송·삭제는 재실행하지 않는다. 이미 GET 렌더 때 실행되던 `/admin/models`의 probe 관측 upsert, `/admin/status`의 제한된 attention 표본, 홈의 검색 기록 등은 기존 GET 동작이다. 자동 새로고침이 새 업무 결정을 내린다는 의미는 아니다. 프로세스/호스트/DB 복구와 Oracle 감시는 별도 운영 변경이다.

## 모든 공개 페이지

아래 공개 경로는 한국어 기본 주소와 `/en`, `/zh-Hans`, `/zh-Hant` prefix에 적용된다. `/ko`는 기존 proxy가 정식 기본 주소로 redirect한다.

| 경로 / 소스 page | 핵심 읽기·접근·병목·복구 검토 결과 |
| --- | --- |
| `/` | `HomeScreen` 내부 Suspense, `HomeContent`의 시즌/검색/목록/개수 병렬화, `publicRead`의 30초 단일 실행 합치기와 목록 창 상한. 선택 구획은 별도 실패 처리가 있다. 핵심 `dbDown`에 자동 재조회 추가. |
| `/?new=1` (같은 page의 별도 분기) | 완성된 주간 창·최소 별·쪽 크기 15·개수로 쪽 보정. 실제 조회 실패 `failed`에만 자동 재조회 추가. |
| `/c/[category]` | 분야 파싱·정식 slug redirect·숨긴 분야 안내 후 `HomeScreen` 재사용. 알 수 없는 분야 404를 먼저 결정하는 구조 보존. 홈과 같은 복구. |
| `/popular` | 검색 상태 parser·15개 쪽·30초 공개 목록/집계. facet 실패가 목록을 버리던 결합 해제. 핵심 목록 실패만 자동 재조회. |
| `/rising` | 완료된 회차 증거에 따른 정렬·쪽 범위 보정·복제본/캐시. 읽기 예외와 `warming/no-results/delayed` 데이터 상태를 구분. 예외로 `result`가 없을 때만 자동 재조회. |
| `/talk` | `talkVisibility`가 비공개 404/관리자 preview를 구분. `now/week`만 허용·정해진 목록 상한. 실제 board 읽기 예외에만 자동 재조회. |
| `/rankings/[key]` | metadata와 본문이 React `cache`로 같은 시즌을 공유. 없는 시즌은 404·빈 시즌 noindex. 실패는 공개 경계에서 재조회. |
| `/p/[slug]` | identity를 먼저 읽어 없는 제품 404를 스트리밍 전에 결정. 상세는 Suspense·30초 공개 읽기. 관련/번역 병렬화, GitHub/SNS 선택 읽기는 실패를 제한. 서버 예외는 공개 경계. 금지 제품/삭제 요청/번역 준비도/JSON-LD escaping 유지. |
| `/p/[slug]/github` | 공개 제품 identity와 repo 파싱 후 maker session/권한을 별도 확인. 개인 설정 HTML은 edge no-store. 연결/저장은 명시적 요청만. |
| `/feedback/[id]` | 공개 session+admin을 함께 읽고 `getFeedback`에 권한 전달. 비공개/없는 항목 404·noindex·edge no-store. 읽기 실패는 경계. |
| `/login` | 안전한 return URL·기능 flag·기존 session 확인. OAuth 시작은 prefetch 없는 명시적 경로. edge no-store·noindex. |
| `/launch` | DB 목록 의존 없음. 요청 시점 origin으로 설치 명령 생성. 복사/설치 폼 동작과 캐시 정책 유지. |
| `/policy` | 정적 사전/연락처/분석 opt-out 표시. 요청 시점 렌더와 기존 anchors 유지. DB 집계 없음. |
| `/me` | session 확인 후 pending replies+저장 첫 쪽 병렬. 실패한 저장 읽기는 브라우저 목록 재수신에 맡김. 비로그인은 기기 목록. edge no-store. |
| `/me/account` | session+계정별 view·현재 session token hash 확인. 키/원 token 비공개. 세션 목록 50개 상한. 수정·내보내기·삭제는 각각 인증/CSRF/한도 경로. |
| `/me/alerts` | session 후 `loadInbox`: 알림 첫 쪽/미읽음/사전 병렬. 알림 읽음 처리와 설정 변경은 별도 API. 경계 복구. |
| `/me/following` | session 후 계정별 팔로 목록. `FOLLOW_LIMIT` 상한·관련 자료 일괄 읽기. 경계 복구. |
| `/me/opinions` | session 후 최근 본인 feedback 100개와 답장/제품 자료 일괄 조회. 경계 복구. |
| `/me/projects` | session에서 user ID 전달. `view` 허용값·쪽 1–9999 검증. 받은 의견과 프로젝트 분기는 기존 컴포넌트가 맡음. 경계 복구. |
| `/me/tried` | 기능 flag 먼저 확인·session별 초기 목록. 초기 읽기 실패 null은 브라우저 재수신 경로. 비로그인 기기 목록 유지. |
| `@seasonfooter/page.tsx` (홈의 병렬 슬롯) | 현재 시즌/이력 병렬·실패하면 footer만 생략. 다른 경로 hard navigation은 `default.tsx`가 null. URL을 만드는 catch-all을 추가하지 않음. |

`/me/layout.tsx`의 summary 실패는 숫자만 생략하고 탭을 연다. 모든 개인 탭의 no-store는 `next.config.ts`가 보장한다. 요청 scope의 계정 자료를 `publicRead`에 넣는 변경은 하지 않았다.

## 모든 관리자 페이지

모든 28개 page 진입점에서 `currentAdmin()` 검사를 확인했다. 로그인 page는 기존 session이 있으면 관리 화면으로 보낸다. `proxy.ts`의 ingress 기본 차단·서명/만료 검사에 더해 page와 mutation이 허용목록을 다시 검사하는 구조를 유지한다. operator layout은 noindex다. 아래에 적힌 읽기 예외는 새 `/admin/error.tsx`로 들어가고, 정상 admin shell은 남는다.

| 경로 | 핵심 읽기·병목/보안 검토 |
| --- | --- |
| `/admin` | 설정·metadata·후보 수·적용 관측·배정 flag 병렬. 성과/발행 집계 실패는 별도 생략. 모델 설정 쓰기는 폼/action 유지. |
| `/admin/activity` | 검증된 group/actor/before/target 필터·cursor 목록·facet/operator 병렬. append-only 기록 조회·CSV export 연결. |
| `/admin/audit` | 쪽 크기 50. overview 이후 실제 탭에 필요한 요청/이력/정책만 병렬로 읽는다. 선택 throughput 실패는 생략. 처리는 명시적 action. |
| `/admin/categories` | 설정·metadata·category counts·적용 관측 병렬. 관측 실패가 설정 폼을 막지 않음. |
| `/admin/evidence` | 근거 설정 한 번 읽기. 소유권/증거 정책 수정은 기존 action. |
| `/admin/feedback` | 상태 own-key·검색 120자·cursor. 서명된 admin CSRF와 review state 기반 폼. 결과 목록은 cursor 상한. |
| `/admin/github-accounts` | 수집 계정/App/최근 문서/신규 제품 수 병렬. 토큰 raw 값을 page props로 넘기지 않는 관리 view 사용. |
| `/admin/github-integrations` | 최근 100개 outbox. 검증한 GitHub issue URL만 링크. 재전송은 중복 위험 확인·사유·예상 버전·CSRF를 명시적으로 제출. |
| `/admin/inbox` | `sharedInbox` 단일 snapshot·실패 구획 수/미확인을 보존. 이전 실패를 0건 업무로 확정하지 않음. |
| `/admin/login` | session·운영 로그인 설정·CSRF nonce. 비밀번호 입력 폼은 POST, OAuth는 미리 받지 않는 링크. |
| `/admin/maker-replies` | 허용 상태·offset 최대 100000·본문/버전 기반 검수 폼. |
| `/admin/models` | 공통 serving snapshot을 먼저 읽고 설정/엔진 목록/환경/배정 flag 병렬. 관측·장비·도우미는 Suspense 분리. 실제 probe I/O는 기존 timeout 경로이며 렌더는 관측 upsert도 수행하므로 순수 DB 읽기만인 페이지로 보지 않는다. 최신 capacity/device 의미는 변경하지 않음. |
| `/admin/models/assignments` | 배정 view+reads control 병렬·요청한 경우만 import preview. 읽기 실패/잠긴 수정 폼 처리 유지. |
| `/admin/models/contracts` | serving cache 이후 계약/등록부 조회. 독립 두 목록의 순차 조회는 개선 여지가 있으나 현재 증거 없이 모델/계약 로직을 넓혀 고치지 않음. |
| `/admin/models/devices` | `readCapacityDevicesAdminView` 한 번. 행 읽기 실패 시 readOnly·미확인 표시. 최신 장비 입장 규칙과 예비/빌림 의미 보존. |
| `/admin/models/helpers` | DB 시계 기반 snapshot 하나. 신호 누락/오래됨은 도우미 닫힘·우선 역할 보존. 읽기 실패 시 저장 금지. |
| `/admin/models/limits` | serving cache+runtime view. row 실패 시 readOnly·코드 기본값 구분. 용량/epoch 정책 수정 없음. |
| `/admin/news` | 상태 허용값·쪽 크기 고정·설정/작업/개수/목록 병렬. 큰 OFFSET은 아래 후속 실측 대상. |
| `/admin/products` | 필터/정렬 own-key·검색 100자. 목록·개수·facet 병렬, 관련 리뷰 일괄 읽기·선택 자료 실패 제한. |
| `/admin/products/[slug]` | 제품 admin view 먼저 확인·없는 제품 404. refresh/history/makers 병렬·이력/멤버 실패 생략. |
| `/admin/products/recheck` | 권한 후 저장 문서만 batch 읽고 현재 규칙을 적용하는 표시용 read. 자동 삭제/수집/모델 호출 없음. 큰 OFFSET은 후속 실측 대상. |
| `/admin/ranking` | 단일 ranking admin state와 제한된 preview. 정책 쓰기/실행은 명시적 action. |
| `/admin/reactions` | 서명된 CSRF·보류 목록. 본 comment를 폼에 결속해 미확인 새 글의 자동 승인을 막음. |
| `/admin/requests` | 상태 허용값·offset 최대 100000. 비공개 수동 접수함·버전/CSRF. 외부 이메일 자동 발송 없음. |
| `/admin/review` | stage/AI/second/sort 허용값·검색 100자. cause own-key 누락 수정. 조각/공유 읽기 병렬화·목록 쪽 크기·명시적 batch decisions 보존. |
| `/admin/status` | `loadActionInputs` 핵심부터 렌더하고 무거운 집계는 Suspense/`withDeadline`·공유 cache·복제본 전용 읽기로 분리. 첫 검수/한국어 번역의 stale/미확인 의미 보존. attention 표본은 기존 after+쓰기 gate. |
| `/admin/talk` | 검증한 source/state/link/talk/sort·board/쪽/잡/X status 병렬. X 실패는 별도 생략. |
| `/admin/translations` | 상태/locale/field 허용값·검색 120자·cursor. queue+summary+복제본 전용 batch owner 병렬. 저장 행 실패와 미확인 owner를 구분. 재시도는 CSRF/action. |

## 공통 경로와 남은 실측

- `publicRead`는 30초 TTL·동일 키 동시 실행 합치기·프로세스 key 수 상한·Valkey 2차 cache를 사용한다. 실패는 저장하지 않는다. 공개 목록/상세의 stale 값 무기한 제공은 삭제·takedown 노출을 늦추므로 넣지 않았다.
- 복제본은 10초 lag 검사·10초 초과 배제·연결 실패 30초 cooldown을 사용한다. 일반 공개 read의 주 DB fallback과 무거운 관리 집계의 replica-only 보류를 구분한다. `lib/db/pool.ts`의 pool wait 취소·연결/statement/lock deadline은 기존 경로다.
- 개인 API는 `PUBLIC_PRIVATE_HEADERS`, session user ID, `requirePublicMutation`의 origin+CSRF를 사용한다. maker token API는 `authorizeMakerRoute`, bounded JSON, per-IP/per-product rate limit, If-Match를 사용한다. web write fence·webhook 서명·운영 토큰 검증은 기존 경로를 유지한다.
- 로딩 파일을 전역 공개 subtree에 새로 두지 않았다. 존재하지 않는 제품/분야를 스트리밍 200으로 바꾸지 않기 위해서다.
- 큰 관리자 목록의 `Number.isSafeInteger(page)` 검증만으로는 `(page-1)*pageSize`의 안전 범위/큰 OFFSET 비용을 완전히 막지 못한다. `/admin/news`, `/admin/audit`, `/admin/products`, `/admin/review`, `/admin/talk`, `/admin/products/recheck`는 권한이 필요하고 기존 DB timeout이 있으나 keyset 전환/현실적인 상한은 별도 데이터 규모·실행 계획 근거로 결정해야 한다. 임의 상한으로 기존 탐색을 자르지 않았다.
- 실제 viewport별 표시·hydration·offline 전환·쿠키/locale CDN 규칙·로그인 후 권한·프로세스 재기동·장애 후 GET 성공은 배포 전후 실측이 남는다. 소스 변경만으로 성능·보안 전체 통과를 선언하지 않는다.
- 특히 익명 공개 HTML/RSC는 기존 Cloudflare 정책상 60–240초 저장된다. root의 2026-11-01 운영 읽기 검사에서 13:53:21 같은 홈 주소의 익명 요청은 MISS, 직후 복구 cookie 요청은 HIT/Age 0이었다. **cookie만으로 기존 edge 객체를 우회하지 못함을 확인했다.** 13:56:39에는 새로운 `__nmv_recover` query key가 MISS, 그 key를 그대로 반복한 요청은 HIT였다. 따라서 자동 경로를 매번 새로운 nonce의 document GET으로 바꿨다. 이는 root가 전달한 현재 edge의 query cache-key 증거이며 이 agent가 운영 I/O를 직접 수행한 것은 아니다. 같은 key를 재사용하면 다시 HIT가 되므로 nonce는 시도마다 새로 만든다. 배포 후 실제 실패 화면→새 GET→정상 화면, cookie origin no-store, 수동 retry 및 locale/auth 유지의 브라우저 확인은 남는다. edge cache-key 규칙이 바뀌면 이 가정을 다시 확인해야 한다.
- 저장소의 `rg --files`와 Cloudflare/cache-rule 관련 검색에서 확인한 관리 코드는 `lib/cdn/purge.ts`, `lib/jobs/products/cdn-purge.ts`, 배포 helper의 purge 호출뿐이며 cache rules의 선언/적용/export는 없다. root의 기존 purge 전용 credential로 cache-rules GET은 403이어서 실제 관리형 규칙을 읽거나 변경하지 못했다. 더 넓은 Cloudflare 권한을 요구하거나 edge 규칙 변경으로 해결했다고 주장하지 않는다. 소스 회귀·필수 CI·배포 후 실패 주입 확인 없이 caught-200 실패의 운영 자동 회복 완료를 보고하지 않는다.

## 회귀 코드와 다음 명령

추가/보강한 회귀 코드는 모두 **미실행**이다.

- `tests/render-recovery.test.ts`: 순수 URL의 같은 출처/locale/반복 query/return/hash 보존·예약 query 교체·새 nonce별 다른 key·위험 scheme/nonce 거절·document GET 사이 budget-only 저장. 지연·per-mount 1회·remount/navigation 공유 예산·60초를 넘는 느린 영구 오류 중단·offline/hidden·취소·동시 경계·저장소 장애/손상/시계 역행.
- `tests/handler.test.ts`: 예외 500/503의 두 계층 no-store, fence Retry-After, 성공 cache header 보존.
- `tests/render-recovery-proxy.test.ts`, `tests/next-config.test.ts`, `tests/p12-head-config.test.ts`: 20초 cookie 속성·정확한 값·GET/HEAD 조건·언어 routing 보존·관리자 권한 없음·정상 TTL 보존과 복구 요청의 CDN cache 제외.
- `tests/popular-page.test.tsx`: facet만 실패해도 목록 유지·0으로 오인시키지 않음·실패 facet 후속 복구·성공 목록 cache 재사용.
- 회귀 코드는 순수 URL/controller와 proxy/cache 정책을 대상으로 한다. 실제 browser hook의 crypto·cookie·document navigation 연결을 브라우저에서 실행했다는 뜻은 아니다. client 부품은 App Router hook을 사용하지 않고 `useEffect`에서만 browser API를 읽으므로 static markup용 전역 mock은 추가하지 않는다.

root의 통합/CI 환경에서 사용할 명령(이 작업에서 실행하지 않음):

```sh
npx vitest run tests/render-recovery.test.ts tests/render-recovery-proxy.test.ts tests/handler.test.ts tests/popular-page.test.tsx tests/next-config.test.ts tests/p12-head-config.test.ts
git diff -- app lib/http/handler.ts lib/web components/errors tests docs/operations/2026-11-01-web-route-audit.md
```

아래는 78개 route handler 전체의 소스 경로 목록이다. `maker-route.ts`는 handler가 아닌 공통 helper라 별도로 위에서 다뤘다. manifest/robots와 icon/static 파일도 DB 목록/사용자 mutation을 만드는 page가 아니다.

| Source | Methods |
| --- | --- |
| `app/(operator)/admin/export/route.ts` | GET |
| `app/(operator)/admin/nav-badges/route.ts` | GET |
| `app/(operator)/admin/search/route.ts` | GET |
| `app/(public)/[locale]/(content)/p/[slug]/share-card.png/route.ts` | GET |
| `app/api/admin/products/[slug]/route.ts` | DELETE |
| `app/api/auth/github/callback/route.ts` | GET |
| `app/api/auth/github/route.ts` | GET |
| `app/api/auth/logout/route.ts` | POST |
| `app/api/auth/maker/github/callback/route.ts` | GET |
| `app/api/auth/maker/github/route.ts` | POST |
| `app/api/auth/password/route.ts` | GET, POST |
| `app/api/auth/user/email/start/route.ts` | GET, POST |
| `app/api/auth/user/email/verify/route.ts` | POST |
| `app/api/auth/user/github/callback/route.ts` | GET |
| `app/api/auth/user/github/route.ts` | POST |
| `app/api/auth/user/logout/route.ts` | POST |
| `app/api/cron/[job]/route.ts` | POST |
| `app/api/github/installations/setup/route.ts` | GET |
| `app/api/github/webhooks/feedback/route.ts` | POST |
| `app/api/github/webhooks/star/route.ts` | POST |
| `app/api/health/route.ts` | GET |
| `app/api/live/route.ts` | GET |
| `app/api/maker/claims/repo-file/route.ts` | POST |
| `app/api/maker/claims/route.ts` | POST |
| `app/api/me/delete/route.ts` | POST |
| `app/api/me/export/route.ts` | POST |
| `app/api/me/feedback/route.ts` | GET |
| `app/api/me/follows/route.ts` | GET, PUT, DELETE |
| `app/api/me/follows/state/route.ts` | GET |
| `app/api/me/github/route.ts` | GET, DELETE |
| `app/api/me/maker/found-repos/route.ts` | GET |
| `app/api/me/maker/intro/route.ts` | PUT |
| `app/api/me/maker/projects/route.ts` | GET |
| `app/api/me/maker/replies/route.ts` | PUT |
| `app/api/me/notification-settings/route.ts` | GET, PUT |
| `app/api/me/notification-settings/unsubscribe/route.ts` | GET, POST |
| `app/api/me/notifications/read/route.ts` | POST |
| `app/api/me/notifications/route.ts` | GET |
| `app/api/me/notifications/unread/route.ts` | GET |
| `app/api/me/profile/route.ts` | PATCH |
| `app/api/me/reactions/browser/route.ts` | GET |
| `app/api/me/reactions/merge/route.ts` | POST |
| `app/api/me/reactions/route.ts` | GET |
| `app/api/me/route.ts` | GET |
| `app/api/me/saved/[slug]/route.ts` | PUT, DELETE |
| `app/api/me/saved/route.ts` | GET, POST |
| `app/api/me/sessions/[id]/route.ts` | DELETE |
| `app/api/me/sessions/revoke-others/route.ts` | POST |
| `app/api/me/sessions/route.ts` | GET |
| `app/api/me/summary/route.ts` | GET |
| `app/api/media/[hash]/route.ts` | GET |
| `app/api/og-cache/[slug]/route.ts` | GET |
| `app/api/ops/x-posts/route.ts` | POST |
| `app/api/ops/x-status/route.ts` | POST |
| `app/api/product-summaries/route.ts` | POST |
| `app/api/products/[slug]/feedback/route.ts` | GET, POST |
| `app/api/products/[slug]/github-integration/route.ts` | GET, PUT |
| `app/api/products/[slug]/github-star/route.ts` | GET, PUT |
| `app/api/products/[slug]/intro-request/route.ts` | POST |
| `app/api/products/[slug]/links/route.ts` | GET, PUT |
| `app/api/products/[slug]/media/route.ts` | GET, PUT |
| `app/api/products/[slug]/profile/route.ts` | GET, PUT |
| `app/api/products/[slug]/provenance/route.ts` | GET, PUT |
| `app/api/products/[slug]/reactions/route.ts` | GET, PUT, DELETE |
| `app/api/products/[slug]/refresh/route.ts` | POST |
| `app/api/products/[slug]/route.ts` | GET, PATCH, DELETE |
| `app/api/products/[slug]/takedown/route.ts` | POST |
| `app/api/products/[slug]/updates/[id]/route.ts` | PATCH, DELETE |
| `app/api/products/[slug]/updates/route.ts` | POST |
| `app/api/products/[slug]/verify/route.ts` | POST |
| `app/api/products/route.ts` | POST |
| `app/badge/[slug]/route.ts` | GET |
| `app/feed.xml/route.ts` | GET |
| `app/go/[slug]/route.ts` | GET |
| `app/install.sh/route.ts` | GET |
| `app/sitemap.xml/route.ts` | GET |
| `app/sitemaps/[locale]/[file]/route.ts` | GET |
| `app/skill.md/route.ts` | GET |
