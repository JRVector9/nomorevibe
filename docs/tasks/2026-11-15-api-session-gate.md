# PR B · 공개 API 세션 관문

기준: 문서 PR #963 c050dac5, main 21128664. PR #965. 병합·배포 금지.

- [x] 별도 브랜치·빈 착수 커밋·Draft PR 확인
- [x] 기준 문서 두 개 전체 및 Next 설치본 지침 확인
- [x] Turnstile 서버 검증·30분 서명 쿠키·공통 읽기 관문
- [x] 브라우저 fetch 세션 발급·갱신 (화면 컴포넌트 변경 없음)
- [x] 기존 DB 실시간 설정에 observe/enforce 모드 및 감사 저장 CLI
- [x] 범위 단위·DB 회귀 및 headless 실제 세션→카드 API 확인
- [x] 배포 scope·정적 검사·의미 단위 커밋 (push·CI는 PR 상태로 확인)
- [x] ready 전환 및 필수 CI 실제 실행·실패 원인 확인
- [x] 기존 머리 065a1f44 필수 check SUCCESS — CI 43733556340(이전 결제 차단 해소 확인)
- [x] 검증·한계 보고 준비 및 결재함에 CI 복구 요청 (최종 보고는 PR 본문·보고함 참조)
- [x] (대표 검토 1) Turnstile hostname을 request.url이 아닌 정식 주소(NEXT_PUBLIC_SITE_URL) hostname과 비교. 같은 원인인 세션 발급 Origin 검사도 정식 출처(lib/site.ts siteOrigin)와 비교
- [x] (대표 검토 2) 기록만 모드의 hostname 불일치를 별도 이벤트로 기록·집계
- [x] (대표 검토 3) 내부 request.url(http://web:3000) 시험 추가, 옛 코드(fd0fd8ab)에서 실패 확인
- [x] (CI 43725822753 unit 실패 1건) 세션 POST의 `dbWrite: false` 제거 — 발급 IP 한도가 rate_limits를 upsert하므로 쓰기 관문(DR fence)을 지난다. `tests/dr-web-fence.test.ts` 정책 시험은 그대로

## 선택 및 경계

- env `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `PUBLIC_API_SESSION_SECRET` 중 하나라도 없으면 세션 관문 꺼짐. 모두 있으면 기본 기록만(observe).
- 모드는 기존 runtime_settings.values.publicApi.mode, 기본 observe. 운영 변경은 이 작업에서 하지 않는다. 향후 승인 뒤 `node --import tsx scripts/public-api-session-mode.ts observe|enforce <actor>`로 revision 비교·감사 기록을 거쳐 저장한다. 두 웹 앱은 primary에서 읽으므로 재배포 불필요.
- 순서: 기존 UA 403 → cross-site 403 → 기존 IP 429 → 세션 401 → 세션 한도 429. enforce에서 설정/한도 DB 오류는 503. env 없을 때 추가 DB 조회 없음.
- 초기 한도: 10분 카드 600칸·상세 읽기 60회. slugs 배치는 서로 다른 slug 수(최대60), 목록 크기를 모르는 카드 요청은 최대60칸·POST summaries는 기존 상한100칸 선예약(보수적). IP 300회/10분 및 세션 발급 IP 10회/10분도 유지.
- 현재 profile/links/media/provenance GET은 edit-token 필요. 공개 세션으로 인증을 대체하거나 쓰기 경로에 추가 관문을 걸지 않는다. 향후 PR A가 공개 읽기로 바꾸면 공통 guardPublicApiRead 및 paths.ts에 연결해야 한다.
- 브라우저 시작 전 instrumentation-client에서 같은 출처의 명시된 공개 읽기만 감싼다. 다른 요청·쓰기 영향 없음. 세션 401일 때만 1회 재확인·재시도. 기록 모드에서는 Turnstile 실패 후 기존 API를 계속 읽는다.
- 쿠키: httpOnly, SameSite=Strict, Path=/api, production Secure. IPv4 /24 및 IPv6 /64를 HMAC; 신뢰할 공개 IP를 모르면 unavailable을 서명한다(프록시 머리를 직접 믿지 않음).
- 실제 키 취급 없음. Cloudflare 공식 시험 키는 개발/시험에서만 허용; production에서 시험 secret으로 세션 발급 불가.

## 배포 전 사람 몫

[PR #963 사람 안내](https://github.com/JRVector9/nomorevibe/blob/c050dac5d6122534b13513665ee9651ad864cbb4/docs/tasks/2026-11-15-cloudflare-person-steps.md) 3·6장: Invisible 위젯(nomorevibe.com, pre-clearance No) 생성, 웹 두 앱에 고정 env 3개(동일 세션 서명 키)를 입력하고 바로 재배포. 값은 대화·커밋·보고에 쓰지 않는다. 1~2일 로그 관측 뒤 차단 전환은 별도 사람 승인.

## 정식 주소 hostname 비교 (대표 검토 반영)

- 원인: Next 16 standalone은 request.url을 `<bind host>:<port>`(예: `http://web:3000`)로 다시 만든다(`node_modules/next/dist/server/lib/router-utils/resolve-routes.js` initUrl, trustHostHeader 꺼짐). Cloudflare→Traefik 뒤에서는 siteverify hostname(nomorevibe.com)과 절대 같지 않아 막기 모드에서 모든 세션이 거절된다. 세션 발급의 `Origin === new URL(request.url).origin` 검사도 같은 이유로 운영에서 항상 403이었다.
- 고침: `canonicalSiteHostname()`은 NEXT_PUBLIC_SITE_URL만 읽는다(요청으로 대신하지 않음). Origin 검사는 저장소의 정식 출처 함수 `siteOrigin()`과 비교한다(설정 없을 때 요청 출처로 폴백하는 저장소 관례, 로컬 개발용).
- 불일치·미설정 처리: 모드(runtime_settings publicApi.mode)는 hostname이 정식과 다를 때만 읽는다. 기록만이면 통과+기록, 막기·모드 미상·모드 읽기 실패면 거절+기록(더 엄격한 쪽).
  - `anti_scrape.turnstile_hostname_mismatch` (info) `{ mode, outcome: allowed|refused, expected, actual }`
  - `anti_scrape.turnstile_hostname_unconfigured` (warn) `{ mode, outcome, actual }` — NEXT_PUBLIC_SITE_URL 없음/잘못됨
  - actual은 hostname 글자만(253자 이하 `[a-z0-9.-]`), 그 밖은 `invalid`. 토큰·키·IP·Cloudflare 응답 나머지는 기록하지 않는다.
- action 불일치·success false는 모드와 무관하게 거절(변경 없음). Cloudflare 공식 시험 secret은 비운영에서만 hostname/action 생략(변경 없음).
- 운영 웹 두 앱은 이미 `NEXT_PUBLIC_SITE_URL=https://nomorevibe.com`을 런타임 env로 받는다(docs/operations/2026-10-11-primary-domain-cutover.md). 세션 경로는 force-dynamic이라 런타임 값을 읽는다. 운영 설정 변경 불필요.

## 쓰기 관문 정책 (CI 43725822753 attempt 2 실패 반영)

- 실패: unit 5,245건 중 `tests/dr-web-fence.test.ts` 「only the admin logout opts out of the write gate (dbWrite: false)」 1건. 세션 POST가 `{ dbWrite: false }`로 쓰기 관문을 빠져 있었다.
- 고침: 세션 POST는 `rateLimitWindow('api-session-issue:<ip>')`로 DB에 쓰므로 일반 쓰기 route처럼 `withRoute`의 `runWebWrite`를 지난다. 정책 시험은 느슨하게 하지 않았다.
- 동작 영향: 기록만/막기 모드 판정·Origin·본문 상한·Turnstile 검증·쿠키는 그대로. 달라지는 것은 DB가 fenced(DR 승격 전·옛 primary)이거나 fence를 못 읽을 때뿐 — 발급 전에 503(Retry-After 60), 속도 제한 행·siteverify 호출·쿠키 없음. GET(설정 조회)은 SAFE 메서드라 그대로.
- 시험: 단위 시험은 `runWebWrite`를 통과 spy로 두고(POST가 관문을 지나는지 확인), fenced면 503·쓰기 없음 회귀 1건 추가.

## 공식 자료

- https://developers.cloudflare.com/turnstile/troubleshooting/testing/
- https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
- https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/

## 실제 검증 (2026-11-15)

- 품질 수치: `npx vitest run tests/anti-scrape-api` 착수 33/33 → 구현 뒤 54/54 통과. 시험 수 증가이며 운영 수집 방어율 측정이 아니다.
- 변경 범위 기존 시험 포함: `npx vitest run tests/anti-scrape-api tests/public-html-payload-api.test.ts tests/runtime-settings-schema.test.ts tests/runtime-settings-store.test.ts tests/admin-runtime-settings.test.tsx --maxWorkers=3` 7파일 116/116 통과.
- PostgreSQL: 기존 55435 시험 방식의 전용 임시 컨테이너 `nmv-api-session-test-089a81c4`, 포트 55439. 다른 구역의 공유 DB를 비우지 않음. `TEST_DATABASE_URL=<로컬 전용 시험 DB> npx vitest run --config vitest.integration.config.ts tests/integration/anti-scrape-api-limits.test.ts tests/integration/anti-scrape-api-session.test.ts tests/integration/runtime-settings.test.ts` 3파일 16/16 통과. 11개 동시 60칸 예약 중 10개 허용·누적660, 모드 저장 감사/revision·즉시 반영 확인.
- 타입: 최초 tsc는 미생성 PageProps와 신규 코드 타입 두 곳에서 실패. Next `typegen` 및 타입 두 곳 수정 뒤 `NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit` 통과. 변경 파일 ESLint·`git diff --check` 통과.
- 실제 Cloudflare siteverify: 공식 공개 시험 secret 항상 통과→success true, 항상 실패→success false (각 HTTP200). 시험 성공 hostname은 example.com이며 action이 없으므로 비운영 시험 키에서만 hostname/action 비교를 생략한다. production은 시험 secret 거절.
- 실제 headless Chromium(데스크톱 도구 미사용): 로컬 3175, Invisible 공개 시험 sitekey. 쿠키 없음401 → 자동 위젯·발급200 → 카드200(session-test 포함); 쿠키 삭제 → API401 → 자동 갱신200 → 재시도200. httpOnly·Strict·Path=/api 확인. 스크린샷 및 비밀 없는 JSON 영수증은 보고함 첨부.
- `npm run deploy -- scope --base 2112866428a851e6a87fff12883c192b943170d4 --sha <정확한 커밋 SHA>`: trusted=true, full, 18앱 선택. 계획/실행 없음. 마이그레이션 0.
- 화면 컴포넌트·기존 공개 API 응답 본문 변경 0. PR A와 공통 수정 예정 파일에 직접 변경 없음. 공통 관문 호출 및 신규 공개 경로 등록 규약은 위 경계 참조.
- 운영 키 입력·Cloudflare 위젯 생성·차단 전환·배포·병합은 수행하지 않음. 운영 통과율·지연·발급 한도 수치는 미측정이며 사람 설정/후속 배포 뒤에만 측정 가능.

## 이전 차단 이력 (현재 상태는 후속 작업 참조)

- 2026-11-15 대표 지시: 저장소가 PRIVATE로 바뀌어 GitHub Actions가 결제 차단으로 시작조차 못 한다. CI 재실행·결제/한도 결재 요청을 하지 않고, 로컬 검사 결과를 PR 본문 「로컬 검사 결과」에 남긴다.

- PR #965는 ready, OPEN이며 병합·배포하지 않았다.
- ready 이벤트 CI 실행 [43723835054](https://github.com/JRVector9/nomorevibe/actions/runs/43723835054), 코드 동일 head 3f0582fa4fefb5b9f4aaf11b61955a0bb952fd68: scope·필수 check FAILURE, 실행 step 0. 타입·린트·unit·통합·빌드 SKIPPED. 로컬 통과를 CI 통과로 바꿔 적지 않음.
- GitHub annotation 원문: “The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings”.
- 사람 결재함에 Billing & plans 복구 요청을 올렸다. 공개 상태 조회는 PRIVATE였으며 임의 공개 전환·결제·사용 한도 변경·CI 우회는 하지 않았다.
- 사람이 복구한 뒤 이 PR의 최종 머리 CI를 재실행해 `gh pr view 965 --json headRefOid,statusCheckRollup`에서 필수 check 성공을 확인해야 완료다. 이 문서 추가 뒤의 최종 머리도 별도로 조회해 PR 본문·보고함에 남긴다.


## 후속 작업 — 타임라인 세션 읽기 (2026-11-15)

- [x] PR #965 OPEN, head 065a1f44729f350737aff71fd04a10cf5192813a, base main, 기존 필수 check SUCCESS 확인. 같은 PR 유지.
- [x] `git fetch origin main feat/api-session-gate-20261115` 뒤 `git merge --no-edit origin/main`: Already up to date. main 8f7687d5(#966 포함)은 기존 merge 065a1f44의 부모라 추가 merge 커밋·충돌 없음.
- [x] `paths.ts`의 GET·HEAD 세션 읽기 목록에 `/api/products/[slug]/timeline` 추가. 쓰기 메서드는 제외.
- [x] 라우트 기존 연결 확인: timeline GET → guardPublicApiRead → UA·cross-site·IP 한도 → guardApiSession → observe/enforce 및 상세 세션 한도. 본문 publicRead보다 먼저 실행되므로 라우트 수정 불필요.
- [x] 목록·브라우저 사전 발급 2건, 실제 타임라인 401·observe 기록 후200·유효 세션200·봇/IP 차단·세션 한도 모드별 결과 6건 추가.
- [x] 회귀 유효성: 경로 등록 전 새 시험 2실패/71통과(목록·브라우저 사전 발급 실패), 실제 라우트 관문 시험은 이미 통과.
- [x] 로컬: `npx next typegen` → `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p .` exit0. 새 헤더 배열 타입 오류 1건 수정 후 재실행 통과. `npx vitest run tests/anti-scrape-api` 4파일73/73(착수65/65 → 73/73). 변경 TS 3파일 ESLint·diff --check exit0. 전체 unit은 CI에 맡김.
- 커밋·push 뒤 바뀌는 최종 머리와 CI 결과·남은 차단은 [PR #965 검증 칸](https://github.com/JRVector9/nomorevibe/pull/965)과 보고함에서 관리한다. CI는 `gh pr view 965 --json statusCheckRollup`(GraphQL)만 조회한다. 이 문서의 이전 결제 차단은 역사 기록이며 이번 최종 결과로 해석하지 않는다.
- 선택: 다른 작업 공간에서 사용 중인 기존 로컬 브랜치를 보존하기 위해 이 격리 공간은 `pr965-timeline-118c537d`로 작업하고 push 목적지는 기존 `feat/api-session-gate-20261115`만 명시한다. 기록 재작성 없음.
- UI 변경 없음. 브라우저 화면 검수 대상 없음. 병합·배포·운영 설정 변경 금지 유지.
