# 2026-10-25 페이지별 성능·오류 복원 감사

대상 소스는 worktree `nomorevibe-reliability-autorecovery`의 base `e7136238`다. 운영은 기존 배포이며 이번 수정은 아직 배포하지 않았다. `app/**/page.tsx` **42개**를 모두 분류했다. URL을 갖는 페이지 **41개**를 각각 익명 GET으로 확인했고, 홈 전용 병렬 slot **1개**는 소스로 검토했다. 이어 별도 임시 브라우저에서 내부 origin에 로그인해 관리자 **22개**를 실제 조회했고, 기존 회원 로그인 세션의 새 탭으로 회원 전용 **8개** 경로를 추가 확인했다. 로그인·로그아웃 외의 폼 제출, 운영 action, 모델 실행, 배포 명령은 실행하지 않았다.

## 확인한 문제와 수정

1. `lib/cache/shared.ts`의 선택적 Valkey client 선택이 `try` 밖에 있었다. 연결 생성/설정의 동기 예외가 DB 읽기 앞에서 전파되었고, 캐시 쓰기의 동기 예외는 이미 성공한 DB 읽기를 페이지 실패로 바꾸었다. client 선택과 쓰기 호출까지 예외 경계 안으로 옮겨 기존의 DB fallback·프로세스 cache·분당 경고 제한을 유지했다. 실제 `createMemo`를 거치는 회귀 2개가 수정 전 rejected였고 수정 뒤 42를 반환했다.
2. 홈 `PopularTiers`의 5쿼리(집계1+구간목록4)와 `/popular`의 3쿼리(집계·목록·facet)가 공개 읽기 공통 `publicRead`를 우회해 primary에서 요청마다 실행되었다. 공개 call site 2곳에 기존 30초 memo/Valkey/복제본 fallback 경로를 적용했다. 동일 조건의 동시 요청은 한 번 읽고, 목록·카드 전환은 같은 raw rows를 재사용한다. page·tier·filters·sort는 키에 포함하며 facet는 page/view와 독립적이다. 워커도 쓰는 repository 함수는 그대로 두었다.
3. `/admin/audit`는 탭 집계가 끝난 뒤 Qwen 상태·화면 판별 상태·보류 사유·선택한 갈래 사유를 직렬로 기다렸다. 이 읽기들은 overview와 탭만 사용하고 서로의 결과를 사용하지 않는다. 기존 `Promise.all`에 합쳐 불필요한 대기를 없앴다. 권한 확인·탭별 조회 조건·선택 사유에 의존하는 목록 조회·기존 오류 fallback은 유지했다. 느린 처리량 집계를 보류한 회귀에서 다른 네 읽기가 시작되지 않는 실패를 확인한 뒤 병렬 시작을 검증했다. 관리자 공유 cache와 모델 호출은 추가하지 않았다.

공개 캐시 수명30초와 만료 후 재조회 정책은 그대로다. 차단 제품의 CDN 60초 후 재삭제 계약을 늘리지 않는다. 실패 결과·개인 계정 자료·관리자 권한은 공통 캐시에 저장하지 않는다. 개선 수치는 회귀에서 실제 원본 호출이 2회→1회가 된 사실이며, 배포 후 사용자 지연이 감소했다고 주장하지 않는다.

## 측정 조건

- HTTP 수집 완료: `2026-10-25T05:54:29.826930+00:00`. `curl -sS --max-time 20 -o /dev/null -D - -w ...`로 기존 공개 URL의 최초 응답만 기록했다. redirect를 자동으로 따라가지 않았다.
- 일회 표본이며 별도 부하·네트워크 제한을 걸지 않았다. Cloudflare HIT/MISS/DYNAMIC이 섞여 있어 원 서버 SQL 시간이나 p95로 해석할 수 없다. 익명 `/me` 수치는 로그인 안내 화면이며 인증 후 데이터 쿼리 속도를 증명하지 않는다.
- 관리자22개의 공개 ingress는 정책(`proxy.ts`)에 따라 모두404/본문0이었다. 이 시간은 접근 차단 응답 시간이다. 별도로 내부 Tailscale origin에서 승인된 관리자 계정으로 인증 후 22개를 측정했다(`2026-10-25T06:13:38.926Z`–`06:14:21.096Z`). 로그인 화면은 인증 뒤 inbox로 redirect되었다.
- 관리자 측정은 권한0700의 임시 브라우저 홈·독립 CDP 세션을 사용했고, 자격정보·cookie·화면 본문·개인정보·전체 네트워크 URL은 기록하지 않았다. 자동 갱신은 해당 브라우저의 localStorage에서만 껐다. GET/HEAD/OPTIONS 외의 요청을 차단한 상태로 순차 navigation했고, 차단된 mutation 요청도0개였다. 종료 시 정상 로그아웃했다. 목록의 기본 첫 화면을 대표로 측정한 것으로 모든 탭·필터·페이지·데이터 개체의 조합을 실행한 것은 아니다.
- 브라우저는 기존 Chrome의 새 탭에서 GET 이동만 실행했다. 10개 페이지 모두 `main`이 렌더되고 Next error overlay가 없었다. `/en` 최종 console buffer는 비어 있었다. 네트워크 기록은 해당 페이지의 기존 성능 entry라 모든 요청의 성공을 증명하지 않는다.

## 공개·회원 페이지19개

`[locale]`은 ko/en/zh-Hans/zh-Hant 공통 소스를 뜻한다. 기본 한국어 URL을 각 route의 대표로 측정했고 영어 홈을 브라우저로 추가 확인했다. category·product·season의 모든 데이터 개체를 전부 열었다는 뜻은 아니다.

| URL 대표 | HTTP·CDN | TTFB / total(s) | 개별 검토·복원 경계 |
| --- | --- | --- | --- |
| `/c/dev` | 200 / HIT | 0.644 / 1.389 | category 검증 후 HomeScreen 재사용. 목록은 Suspense, 없는 category의 실제 404 유지. |
| `/feedback/0` | 404 / DYNAMIC | 1.033 / 1.038 | 의도적으로 없는 ID. session/admin 권한과 feedback 가시성 확인 경로를 검토, 404 실측. 실제 비공개 자료는 조회하지 않음. |
| `/launch` | 200 / MISS | 0.623 / 0.767 | DB 없는 설명·설치 명령 화면. 서버 사전 모델 호출 없음. |
| `/login` | 200 / DYNAMIC | 0.799 / 1.051 | feature/session 분기. 로그인 제출·OAuth 호출 없이 화면만 확인, 사용자별 응답 캐시 제외. |
| `/me/account` | 200 / DYNAMIC | 0.826 / 2.097 | session 없으면 안내. account view 조회와 dictionary는 병렬, session 관리 mutation은 실행하지 않음. |
| `/me/alerts` | 200 / DYNAMIC | 0.813 / 1.674 | session 없으면 안내. 인증 후 inbox 첫 쪽은 SSR, 후속 목록·설정은 클라이언트. 조회 실패는 공통 retry 경계. |
| `/me/following` | 200 / DYNAMIC | 0.626 / 0.776 | session 없으면 안내. 인증 후 follow 목록 SSR, 조회 실패는 공통 retry 경계. |
| `/me/opinions` | 200 / DYNAMIC | 1.542 / 3.115 | session 없으면 안내. 인증 후 의견목록·dictionary 병렬. 단일 표본 total3.11초이며 원인 미확정. |
| `/me` | 200 / DYNAMIC | 0.812 / 1.059 | getMeSession 요청 내 중복 제거. 저장목록/미답장 병렬, 읽기 실패 시 null로 내려 클라이언트 회복. |
| `/me/projects` | 200 / DYNAMIC | 0.856 / 1.496 | session 없으면 안내. maker projects/replies는 클라이언트 분기·paging, 개인 공통 캐시 없음. |
| `/me/tried` | 200 / DYNAMIC | 0.664 / 0.913 | feature/session 분기. 서버 초기 reactions 실패는 null 허용, 브라우저 목록으로 진행. |
| `/p/stirling-pdf/github` | 200 / DYNAMIC | 0.634 / 0.788 | 기능 flag·session/권한 분기. OAuth/설정 폼 제출 없이 GET만 확인. 개인 응답을 공통 캐시하지 않음. |
| `/p/stirling-pdf` | 200 / HIT | 0.520 / 0.758 | identity를 먼저 확인해 404 보존. detail은 30초 cache+Suspense, related·talk 실패 축소. 약15개 독립 읽기는 병렬. |
| `/` | 200 / HIT | 0.777 / 2.216 | 목록·개수 병렬+Suspense, 30초 publicRead. 인기 구획의 요청별 primary 5쿼리를 이번에 공통 캐시·복제본에 연결. |
| `/policy` | 200 / HIT | 0.514 / 0.686 | DB 없는 정책·설명 화면. locale dictionary만 읽음. |
| `/popular` | 200 / HIT | 0.609 / 2.411 | 집계·목록·facet3쿼리. 이번에 목록·facet를 독립 키로 30초 캐시·복제본에 연결, 보기 전환 재사용. |
| `/rankings/2026-W43` | 200 / MISS | 0.903 / 1.057 | metadata·본문은 React.cache로 시즌 중복 조회 제거. 없는 시즌은 404, 번역 실패는 원문으로 표시. |
| `/rising` | 200 / HIT | 0.878 / 2.363 | 8시간 snapshot 조회는 publicRead. 조회 실패는 snapshot 안내로 축소, 15개 paging. |
| `/talk` | 200 / DYNAMIC | 0.900 / 1.402 | 공개/미리보기 관문 후 board 조회. 읽기 실패 시 해당 목록의 오류 안내, 나머지 shell 유지. |

홈 병렬 slot `app/(public)/[locale]/(content)/@seasonfooter/page.tsx`는 current/history를 병렬로 읽고 목록이 있는 시즌만 표시한다. 실패하면 slot을 null로 줄여 footer/shell은 유지한다. 홈 외 경로는 default slot이 비며 소프트 이동의 잔존 slot은 OnlyOnHome이 가린다. 별도 URL·독립 HTTP 시간은 없다.

공통 공개 shell은 dictionary/flag로 구성되어 DB 집계가 없다. 일반 페이지 오류는 `(content)/error.tsx`의 retry 경계로, 상위 layout 오류는 `app/global-error.tsx`의 독립 html/body+retry로 회복할 수 있다. 설치된 Next16.4.1의 `10-error-handling.md`와 `06-fetching-data.md`를 읽어 `retry` API·Suspense·실제404 보존을 확인했다. 모든 페이지에 loading.tsx를 덧붙이면 없는 제품·분야의 상태 코드가200으로 바뀔 수 있어 기존의 선검증 후 Suspense 구조를 유지했다.

## 기존 회원 세션의 추가 읽기 검증

`2026-10-25T06:47:14.634Z`–`06:48:34.258Z` 기존 Chrome 회원 세션에서 새 탭 하나로 아래8개를 순차 조회했다. CUA native UI의 주소·문서와 정적 구획을 확인했으며 모든 경로에서 인증 계정 메뉴가 있고 로그인 요구·공통 오류 경계·관측된 목록 읽기 오류가 없었다. 계정 이름·ID·이메일·목록 본문·cookie·token은 추출하거나 저장하지 않았다. 알림 읽음·설정·저장·평가·등록·연결 단추는 누르지 않았으며 새 탭을 닫고 시작 전 Chrome 창으로 복귀했다.

| 인증 경로 | 실제 확인 범위 |
| --- | --- |
| `/me` | 로그인된 저장 목록의 마이페이지 틀·본문 렌더. |
| `/me/account` | 프로필·로그인 수단·로그인된 기기·내 데이터 구획 렌더. 변경·export·로그아웃·삭제 실행 없음. |
| `/me/alerts` | 알림함·알림 설정 구획 렌더. 알림 열기·모두 읽음·설정 변경 없음. |
| `/me/following` | 인증된 팔로 목록/빈 상태 렌더. 팔로 변경 없음. |
| `/me/opinions` | 인증된 내 의견 화면 렌더. 게시·수정·삭제 없음. |
| `/me/projects` | 인증된 내 프로젝트/미확인 안내 렌더. 프로젝트 등록·메이커 확인·소개 편집·답장 없음. |
| `/me/tried` | 인증된 써봤어요 화면 렌더. 평가 저장·브라우저 기록 이전·삭제 없음. |
| `/p/stirling-pdf/github` | 실제 회원의 GitHub 연결·권한 안내 렌더. 연결/OAuth 승인·재전송 없음. |

이 도구에는 DOM Navigation Timing·HTTP status·console 관측 기능이 노출되지 않아 인증 회원의 정확한 응답 시간이나 JS 오류0을 주장하지 않는다. 위 익명 HTTP 시간은 계속 로그인 안내 화면의 시간이며, 인증 조회 성능 수치로 바꾸지 않았다. 다양한 데이터가 있는 다른 회원·메이커 권한, 후속 paging, 모바일 성능과 장애 중 복원은 별도 검증이다.

## 관리자 페이지22개

각 page의 서버 `currentAdmin()` 및 미인증 분기, 공통 AdminLayout의 배지 실패 축소, global retry 경계를 확인했다. 내부 DB 오류를 시험하기 위해 운영 연결을 끊거나 강제로 실패시키지 않았다. 실제 인증 navigation **22/22**에서 최종HTTP200, `main`·`h1` 각1개, 로그인 폼 없음, 공통 오류 경계·Next error overlay 없음이었다. JS pageerror·console error·HTTP5xx·비중단 네트워크 실패는 모두0개였다. 페이지 이동 시 취소된 요청(`ERR_ABORTED`)은 실패와 별도 집계했다.

내부 수치는 Navigation Timing의 **TTFB / DOMContentLoaded / load(ms)**다. 각 경로 단일 표본이며 CDN이 있는 공개 표본과 직접 비교하지 않는다.

| URL 대표 | public edge404·TTFB(s) | 내부 인증 TTFB / DCL / load(ms) | 개별 읽기·복원 경계 |
| --- | ---: | ---: | --- |
| `/admin/activity` | 0.782 | 81 / 535 / 2403 | activity rows·facets·operator 병렬. ID 커서+제한 목록, facets 실패는 공통 retry 경계. |
| `/admin/audit` | 1.123 | 315 / 3857 / 3886 | overview/summary 후 선택한 tab 조회. stream 완료 지연을 두 번째 표본에서도 확인, 아래 설명 참조. |
| `/admin/categories` | 1.000 | 33 / 346 / 633 | settings/meta/counts/apply 병렬. 적용관측만 실패 축소, count/settings 실패는 retry 경계. |
| `/admin/evidence` | 1.044 | 51 / 292 / 658 | 권한 후 evidence settings 단일 읽기. 편집 action 실행 안 함, 실패는 retry 경계. |
| `/admin/feedback` | 0.750 | 30 / 328 / 675 | 권한·CSRF 후 bounded queue+cursor. 원문/검수 결과 변경 실행 안 함. |
| `/admin/github-accounts` | 0.770 | 159 / 248 / 627 | collector accounts/apps와 최근1시간 집계 병렬. 토큰 해제·quota 조작 실행 안 함. |
| `/admin/github-integrations` | 0.719 | 60 / 474 / 682 | 권한·CSRF 후 최근100건. GitHub 재조회/재전송 action 실행 안 함. |
| `/admin/inbox` | 1.493 | 42 / 370 / 932 | sharedInbox snapshot 및 부분 결과 조립. 수동 fresh 쿠키를 만들지 않고 공통30초 snapshot 사용. |
| `/admin/login` | 0.773 | 416 / 686 / 853 | 인증 후 `/admin/inbox`로 redirect한 최종200 수치. local 로그인·로그아웃 확인, OAuth 실행 안 함. |
| `/admin/maker-replies` | 0.602 | 240 / 622 / 644 | 권한·CSRF 후 제한 queue+offset. 검수 mutation 실행 안 함. |
| `/admin/news` | 1.514 | 98 / 260 / 457 | settings/job/counts/page 병렬. bounded page 목록, 일부 실패는 전체 retry 경계. |
| `/admin` | 0.781 | 73 / 2357 / 2362 | settings/meta/counts/apply 후 yields/publications 병렬. 덤 통계는 실패 축소, 모델 연결/목록 확인은 Suspense. |
| `/admin/products/stirling-pdf` | 0.671 | 114 / 375 / 636 | evidence product 후 refresh/history/makers 병렬. history/makers 실패 축소, 핵심 상세 실패는 retry 경계. |
| `/admin/products` | 0.623 | 58 / 1039 / 1044 | products/total/filter counts 병렬, filter counts 실패 축소. review/history 조건부 조회. Object.hasOwn filter 검증 확인. |
| `/admin/products/recheck` | 0.818 | 82 / 367 / 419 | GET은 최대500개 보관 원본의 로컬 규칙 재계산과 count만 실행. 모델·저장 호출 없음, ban 폼 실행 안 함. |
| `/admin/ranking` | 0.712 | 101 / 368 / 1215 | ranking state+policy preview 조회. 시즌 처리·재집계 mutation 실행 안 함. |
| `/admin/reactions` | 1.525 | 51 / 448 / 593 | 권한·CSRF 후 보류 queue, 제한된 오래된 목록. 검수 mutation 실행 안 함. |
| `/admin/requests` | 1.061 | 48 / 440 / 617 | 권한·CSRF 후 상태/offset queue를 렌더링만 확인. 문의 내용·개인정보는 기록하지 않고 처리 action 실행 안 함. |
| `/admin/review` | 0.816 | 61 / 549 / 550 | settings 후 translation/model/tiebreak 비동기 시작, 핵심 overview 병렬, 일부 통계 Suspense. cause의 prototype-key 검증은 보안 담당에 전달. |
| `/admin/status` | 0.737 | 29 / 730 / 731 | 필수 inputs 병렬, 부가 집계 Suspense+deadline·replica-only hold. 장애 partial 설계 확인, 큰 HTML 크기는 아래 설명 참조. |
| `/admin/talk` | 0.593 | 51 / 249 / 380 | board/posts page/jobs/X 병렬. X 실패만 축소, 나머지 failure는 retry 경계. 외부 API 실행 안 함. |
| `/admin/translations` | 1.642 | 46 / 365 / 367 | queue/summary/batch 병렬. batch는 replica-only hold. 번역·모델 실행/재처리 action 실행 안 함. |

22개 DCL의 중앙값은 **407ms**였다. `/admin/audit`·`/admin`·`/admin/products` 외19개는 이 표본에서 DCL1초 미만이었다. 첫 activity의 load2.40초와 ranking의 load1.22초는 DCL보다 늦으므로 본문 서버 집계 시간으로 해석하지 않는다.

느린3개와 큰HTML1개는 `2026-10-25T06:15:50.558Z`까지 두 번째 GET으로 확인했다. `/admin/audit`는 첫 responseEnd3849ms, 두 번째3757ms로 HTML stream 완료 지연이 반복됐다. 두 번째 main 최초 가시화는1049ms이므로 화면이3.8초 내내 비었다는 뜻은 아니다. 소스에는 overview→tab 집계→Qwen/screen 상태·사유→findings→기존 번역 조회의 await 단계가 있었다. SQL span·EXPLAIN 없이 특정 쿼리나 DB만 원인이라고 단정하지 않았다. 이후 재측정과 독립 읽기의 병렬화 근거는 아래 추가 조사에 기록했다.

`/admin` 두 번째 main639ms/responseEnd1244ms/DCL1247ms, `/admin/products` main412ms/responseEnd875ms/DCL905ms, `/admin/status` main614ms/responseEnd911ms/DCL919ms였다. 설정은 첫 표본보다 빨라 cache·게이트웨이 메타데이터 등의 영향 가능성이 있으나 분리 계측하지 않았다. 운영센터의 HTML은 첫 압축163,680B/해제1,026,967B, 두 번째165,343B/1,042,696B였다. 상태 자료를 많이 직렬화하는 비용을 후속 모바일·저사양 브라우저 분석 대상으로 남긴다. 대용량 자체를 관측했고 실제 상호작용 지연·hydration CPU 병목은 아직 측정하지 않았다.

## 브라우저 표본

수치는 Navigation Timing의 ms다. load가0인 표본은 수집 시 load event가 아직 끝나지 않아 미관측으로 적었다. 기존 browser cache와 CDN의 영향이 있으며 모바일·저사양 CPU·실사용자 Core Web Vitals를 측정한 것이 아니다.

| 경로 | TTFB | DOMContentLoaded | load | HTML 압축/해제(bytes) |
| --- | ---: | ---: | ---: | ---: |
| `/` | 479 | 628 | 628 | 41,470 / 228,423 |
| `/popular` | 1196 | 1895 | 1904 | 30,535 / 144,385 |
| `/rising` | 810 | 1323 | 미관측 | 28,836 / 144,072 |
| `/talk` | 597 | 1652 | 1652 | 28,118 / 135,646 |
| `/c/dev` | 731 | 926 | 2122 | 29,437 / 140,030 |
| `/p/stirling-pdf` | 690 | 1857 | 1957 | 40,857 / 193,667 |
| `/launch` | 250 | 532 | 1184 | 16,996 / 80,981 |
| `/policy` | 501 | 769 | 769 | 17,529 / 80,946 |
| `/login` | 394 | 425 | 1078 | 12,947 / 55,527 |
| `/en` | 1299 | 1779 | 1790 | 41,991 / 243,978 |

## 실제 회귀·정적 검사

- RED: `npx vitest run tests/shared-cache.test.ts --maxWorkers=2` → 신규2개 실패/기존6개 성공. client 생성과 동기 set 예외가 `createMemo`의 원본 읽기를 reject한 스택을 확인했다.
- RED: `npx vitest run tests/popular-page.test.tsx tests/popular-tier-cards.test.tsx --maxWorkers=2` → 동시요청 원본 호출2회인 신규2개 실패/15개 성공. 실패후회복 테스트는 기존 동작을 함께 보존한다.
- GREEN: `npx vitest run tests/popular-page.test.tsx tests/popular-tier-cards.test.tsx tests/shared-cache.test.ts tests/memo.test.ts --maxWorkers=2` → **33/33 성공**.
- `npx vitest run tests/admin-shared-cache.test.ts tests/db-replica.test.ts --maxWorkers=2` → **28/28 성공**. 관리자 shared cache와 복제본 실패·cooldown 경계 보존.
- `npx eslint 'app/(public)/[locale]/(content)/popular/page.tsx' components/home/PopularTiers.tsx tests/popular-page.test.tsx tests/popular-tier-cards.test.tsx lib/cache/shared.ts tests/shared-cache.test.ts` → exit0.
- Vitest는 기존 configLoader/native 전환 경고를 출력했다. DB-down 주입 테스트의 logger 출력은 예상된 오류 경로다. 전체 DB/전체 unit·production build는 이 담당 단계에서 실행하지 않았고 부모 통합 검증에 넘긴다.

## 관리자 느린 응답 추가 조사

`2026-10-25T07:16:27.913Z`–`07:16:50.087Z`에 별도 임시 프로필로 같은 내부 origin에 로그인해 GET 7회를 추가 측정했다. 측정 대상 운영 소스는 기존 `be71a75a`이며, 작업 트리 변경이나 이후 main `bfe0c8fc`가 배포된 결과가 아니다. 자동 갱신을 끄고 GET/HEAD/OPTIONS만 허용했으며 차단된 mutation 요청도 0개였다. 모두 HTTP200, 공통 error boundary·pageerror·5xx는 0건이었다. 정상 로그아웃 후 해당 임시 브라우저와 프로필을 제거했다. 기록은 시각·경로·성능 숫자만 포함하며 본문·자격·세션은 저장하지 않았다.

| GET | responseEnd / DCL(ms) | decoded / encoded(bytes) |
| --- | --- | --- |
| `/admin/audit` 첫 회 | 3570 / 3573 | 694997 / 114266 |
| `/admin/audit?tab=audit` | 3484 / 3487 | 694998 / 114258 |
| `/admin/audit?tab=requests` | 2406 / 2410 | 62820 / 15813 |
| `/admin/audit?tab=policy` | 2757 / 2759 | 126284 / 25647 |
| `/admin/audit?tab=history` | 2474 / 2476 | 368420 / 47434 |
| `/admin/audit` 재조회 | 3377 / 3382 | 695177 / 114308 |
| `/admin/status` | 3892 / 3893 | 1033924 / 167449 |

모든 감사 탭은 `productAuditOverview`·요청 요약·소개 요청 수를 먼저 기다린다. 감사 탭만의 추가 직렬 대기는 소스로 확인해 병렬화했다. Qwen·화면 판별 상태 함수는 저장된 DB 관측·집계를 읽으며 페이지 GET에서 모델 서버를 실행하지 않는다. 다만 공통 선행 집계가 지연의 얼마를 차지하는지는 SQL span/실행계획 없이 확정할 수 없다. 새 코드의 운영 배포 뒤 지연 개선량은 아직 측정하지 않았다.

운영센터의 약1MB는 압축 전 HTML이며 이번 전송 본문은 약164KiB였다. 여러 서버 조각과 client props를 전송하는 구조를 확인했지만, React Flight의 참조 재사용까지 고려한 중복 직렬화의 실제 바이트 기여는 입증하지 못했다. 현재 근거로 레이아웃이나 전달 자료를 줄이지 않았다. 브라우저 hydration CPU·메모리와 SQL별 시간도 이번 측정 범위 밖이다.

추가 검증: `tests/admin-audit.test.tsx` 새 병렬 시작 회귀는 수정 전 1실패/기존41통과, 수정 후 관련 4파일62개 통과였다. 감사 page·회귀의 scoped ESLint와 `git diff --check`는 exit0이었다.

## 남은 검증과 다음 명령

- 배포 뒤 같은 조건의 동시 요청에서 popular 원본 read/primary 부하가 감소했는지 실제 origin 로그·DB telemetry로 확인한다. CDN 단일 GET 시간을 개선량으로 대체하지 않는다.
- 관리자 기본22개와 기존 회원8개 경로의 인증 읽기 검증은 완료했다. 회원의 정확한 Navigation Timing·console, 다양한 회원/메이커 데이터, 모든 필터·paging 조합과 장애 중 인증 복원 드릴은 별도다. 감사 탭의 독립 읽기는 병렬화했고 배포 후 재측정이 남아 있다. 공통 선행 집계와 운영센터 약1MB HTML은 SQL span·실행계획·hydration CPU를 분리 계측한다. 민감정보를 공유 cache에 넣어 속도를 높이지 않는다.
- 영어·중국어 긴 browse window는 번역을80개씩 순차 조회한다. 현재 범위가 bounded이며 pool를 무제한 병렬화하지 않았다. 실제 병목으로 확인되면 제한된 병렬 batch를 별도 검토한다.
- 공통 DB 자동복구·서비스 health·Oracle 감시는 다른 담당의 검증과 합쳐야 한다. 이번 비파괴 GET이 복구 드릴 완료를 뜻하지 않는다.

```sh
cd /Users/jr/Desktop/projects/nomorevibe-reliability-autorecovery
npx vitest run tests/popular-page.test.tsx tests/popular-tier-cards.test.tsx tests/shared-cache.test.ts tests/memo.test.ts tests/admin-shared-cache.test.ts tests/db-replica.test.ts --maxWorkers=2
npx eslint 'app/(public)/[locale]/(content)/popular/page.tsx' components/home/PopularTiers.tsx tests/popular-page.test.tsx tests/popular-tier-cards.test.tsx lib/cache/shared.ts tests/shared-cache.test.ts
git diff --check
```
