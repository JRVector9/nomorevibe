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
- [ ] (막힘·사람) 필수 check 성공 — GitHub Billing & plans 결제/사용 한도 문제로 잡 시작 자체 거절
- [x] 검증·한계 보고 준비 및 결재함에 CI 복구 요청 (최종 보고는 PR 본문·보고함 참조)

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

## 남은 것 / 차단 근거

- PR #965는 ready, OPEN이며 병합·배포하지 않았다.
- ready 이벤트 CI 실행 [43723835054](https://github.com/JRVector9/nomorevibe/actions/runs/43723835054), 코드 동일 head 3f0582fa4fefb5b9f4aaf11b61955a0bb952fd68: scope·필수 check FAILURE, 실행 step 0. 타입·린트·unit·통합·빌드 SKIPPED. 로컬 통과를 CI 통과로 바꿔 적지 않음.
- GitHub annotation 원문: “The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings”.
- 사람 결재함에 Billing & plans 복구 요청을 올렸다. 공개 상태 조회는 PRIVATE였으며 임의 공개 전환·결제·사용 한도 변경·CI 우회는 하지 않았다.
- 사람이 복구한 뒤 이 PR의 최종 머리 CI를 재실행해 `gh pr view 965 --json headRefOid,statusCheckRollup`에서 필수 check 성공을 확인해야 완료다. 이 문서 추가 뒤의 최종 머리도 별도로 조회해 PR 본문·보고함에 남긴다.
