# PR D — 스킬 에이전트 접근

- PR: [#971](https://github.com/JRVector9/nomorevibe/pull/971)
- 기준: #965 `70cb0448`, base `feat/api-session-gate-20261115`
- 작업 브랜치: `feat/skill-agent-access-20261115`
- 병합·배포 금지. 운영 env·관문 모드·Cloudflare 규칙을 이 작업에서 변경하지 않는다.

## 사람 결정 (2026-11-15 18:1xZ)

“스킬은 이 서비스를 쓰는 사람들이 에이전트 명령으로 바로 쓰게 하는 것이라, 크롤링은 막더라도 일반 사람이 에이전트에 입력해서 그 에이전트가 접근하는 것은 허용해야 한다.”

## 작업 목록

- [x] 지정 기준에서 빈 시작 커밋·전용 브랜치 push·Draft PR 생성.
- [x] 막기 모드 세션 없는 제품 GET만 가져오기 확인용 최소 응답으로 전환. 기존 설치본의 주소 유지.
- [x] `?url=`은 기존 `normalizeUrl`로 사이트·repoUrl과 비교해 matches만 반환. 네트워크 요청 없음.
- [x] 스킬 클레임·401 최신판 안내 갱신.
- [x] 스킬 전체 API 호출 파싱·실제 핸들러 계약 시험·표식 유출 시험.
- [x] 관련 회귀·정적 검사·로컬 Next curl·배포 scope.
- 최종 커밋·push·Ready 및 필수 `check` 상태는 [PR #971 검사 칸](https://github.com/JRVector9/nomorevibe/pull/971/checks)과 보고함의 최종 SHA 기준으로 기록한다. 이 문서의 로컬 통과는 CI 통과를 뜻하지 않는다.

## 응답 경계와 선택

UA 예외는 추가하지 않는다. 기존 UA·cross-site·IP·함정 차단을 먼저 통과해야 한다.
키 없음·observe는 기존 응답, 막기 모드 유효 세션도 기존 응답과 한도 유지.
세션이 없거나 무효일 때만 최소 응답(slug/name/tagline/category/status)을 주며 주인 없으면 claimable/verify를 더한다.
선택: 별도 엔드포인트 대신 기존 GET에 제한 응답을 둔다. 옛 설치본을 보존하기 위해서다.
전체·최소 응답 모두 private/no-store로 세션별 응답이 공유 캐시에 섞이지 않게 한다.

## Cloudflare 사람 몫 (지금 바로)

규칙 1 `nmv-fake-search-bot` 식에서 `claude-user`, `chatgpt-user`를 뺀다.
대표의 운영 실측: Claude Code WebFetch와 같은 UA `Claude-User (…; +https://support.anthropic.com/)`로
`/p/ggml`을 부르면 Cloudflare 확인 화면 403이다.
Claude Code는 사용자 PC에서 직접 가져오므로 Cloudflare 검증 봇이 될 수 없다.
클라우드의 진짜 Claude-User·ChatGPT-User는 Cloudflare 검증 봇(AI Assistant)이라 원래 통과한다.
따라서 이름을 흉내 낸 봇 식이 사용자 PC 에이전트 접근까지 막는 부분을 사람이 제거해야 한다.

**사람 몫 목록은 원 지시 전문과 대조 필요** — 원 지시의 나머지 문서 항목은 잘려 전달되었다.
이 문서는 사람의 조치 요청이며 실제 규칙 변경 완료를 뜻하지 않는다.

## 실제 검증

품질 수치: SKILL.md의 API 호출 16개 중 막기 모드·세션 없는 성공 응답 **15/16 → 16/16**.
측정 명령: `npx vitest run tests/skill-agent-access.test.ts -t 'has no api_session_required' --maxWorkers=2`.
이전 측정은 제품 GET만 #965 `70cb0448` 소스로 바꿔 실행한 회귀 확인이며 클레임 GET 하나가 401로 실패했다.
현재 소스로 복구 후 같은 16건이 관련 회귀 묶음에서 전부 통과했다.

- `npx vitest run tests/skill-agent-access.test.ts tests/skill-contract.test.ts tests/anti-scrape-api tests/dr-web-fence.test.ts --maxWorkers=3`: 7파일 132/132 통과. 새 파일 36건 중 API 호출 계약 16건. 실제 메이커 수정 키 인증까지 실행하고 DB·외부 작업만 fixture로 대체한다.
- 최소 응답의 url/repoUrl/searchReadme/README/메이커/스타 표식 값 노출 0개. 스킬 UA를 흉내 낸 요청과 일반 브라우저 모두 같은 제한 응답이다.
- `TEST_DATABASE_URL=<격리 로컬 시험 DB> npx vitest run --config vitest.integration.config.ts tests/integration/anti-scrape-api-limits.test.ts tests/integration/anti-scrape-api-session.test.ts`: 2파일 7/7 통과.
- `npx next typegen` 성공. `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p .` 성공. 최초 시험 타입 선언의 이름 충돌(TS2502) 1건을 수정하고 재실행 통과했다.
- 변경 TS 4파일 ESLint·`git diff --check` 성공. 로컬 전체 unit·전체 DB·종합 시험은 실행하지 않았다.
- 로컬 Next `3191`, 기본 55435와 같은 `nomorevibe_test` 방식의 격리 임시 PostgreSQL `55498`. 공유 DB는 비우지 않았다. 기존 마이그레이션 적용 성공, 새 마이그레이션 **0**.
- 실제 curl: enforce·세션 없음 200, 필드 `slug/name/tagline/category/status/claimable/verify`. 공식 시험 키로 실제 `/api/session` POST·Cloudflare siteverify 후 발급된 쿠키로 200, 앞 필드에 기존 `url` 포함.
- 실제 curl `?url=`: http/www/후행 슬래시/쿼리/해시를 정규화한 사이트 일치 true, 다른 사이트 false, 저장소 일치 true. 저장된 주소는 응답에 없음. 전체·최소 응답 모두 private/no-store 확인.
- 시험 키 출처: [Cloudflare 공식 시험 문서](https://developers.cloudflare.com/turnstile/troubleshooting/testing/). 운영 키는 사용하지 않았다. 영수증에는 쿠키·서명 키·시험 키도 넣지 않았다.
- `npm run deploy -- scope --base 70cb04487f945d9a057305f8c359aee942446ae3 --sha 36127de8a7703b21f66b094985f038ea27523048`: trusted=true, full, 18앱. 로컬 범위 예상이며 plan/run·실제 배포 없음.

화면 변경 없음: UI 검수·스크린샷 대상 없음. 병합·배포·운영 설정 변경 없음.
배포 준비 대상은 #965 위의 API 응답·스킬 변경이며, 실제 배포 대상과 준비 완료는 후속 허가된 plan 및 main CI로 확정해야 한다.
