# GitHub 스타·피드백 병렬 구현 기록 — 2026-10-11

## 결과와 범위

PR-01~09의 코드를 구현하고 에이전트 종료 후 오케스트레이터가 직접 코드 리뷰,
계획 대조, 회귀 수정과 통합 검사를 수행했다. 계획의 9개 논리 커밋으로 구현·검증
결과를 보존한다. PR-09는 이 문서를 포함한 최종 검증 커밋이다.
후속 사용자 요청으로 [PR #356](https://github.com/JRVector9/nomorevibe/pull/356)을 병합하고
운영 코드·DB·14앱 배포를 완료했다. [운영 배포 검증](2026-10-11-github-integration-rollout.md)에
실제 근거를 기록했다. GitHub App 권한·메일 수신·기능 활성화와 실연동 파일럿은 계속 미검증이다.

- 브랜치: `feat/github-stars-feedback-20261011`
- worktree: `/private/tmp/nomorevibe-github-integration-20261011`
- 기준 main: `6839194dc47e1f1993f54471c0fb94b6857cd6aa`
- 계획: [PR-01~09 구현 계획](../superpowers/plans/2026-10-11-github-stars-feedback-integration.md)
- 운영 절차: [GitHub 연동 runbook](github-stars-feedback-runbook.md)
- 실제 제공자 검증: [파일럿 기록](2026-10-11-github-integration-pilot.md)
- 모든 서브에이전트·직접 Codex CLI: `gpt-6.1-sol`, reasoning effort `xhigh`

기존 사용자 main/PPT/미추적 자료는 보존했다. 기능 플래그 네 개는 기본 false이며
사용자가 중단한 소개 검수는 유지했다. 구현 커밋 후 사용자 승인에 따라 push·PR 병합과
운영 릴리스 교체를 수행했으며 네 기능 플래그는 운영에서도 false를 유지했다.

## 작업 소유권과 커밋

3개 에이전트는 전용 파일을 작성하고 오케스트레이터가 공유 파일·통합·커밋을 맡았다.
동일 파일은 소유권을 알린 뒤 넘겼고, 담당별 전용 PostgreSQL을 사용했다.
외부 요청 중 DB transaction을 유지하지 않는다.

| 담당 | 순차 작업 | 전용 범위 |
| --- | --- | --- |
| github_core | 01 → 06 → 08 | API/JWT, 제작자 설치, 웹훅·복구의 도메인/라우트/테스트/SQL |
| public_accounts | 02 → 03 → 04 | 공개 인증, 개인 GitHub 연결, Star; 마지막 기존 E2E fixture 보완 |
| feedback_local | 05 → 07 → 09 | 피드백, outbox, 파일럿 테스트·배포 preflight |
| 오케스트레이터 | 공유 통합·직접 리뷰·검사·커밋 | schema exports/meta/reset, UI 진입점, job catalog/registry, env/compose/nav, 문서 |

| 계획 PR | 구현 결과 | 커밋 | 실연동 상태 |
| --- | --- | --- | --- |
| 01 | 읽기용 수집과 분리한 API/JWT 경계, 명시적 인증 유형·결과 분류 | `a03f638` | 실제 App capability 미검증 |
| 02 | 이메일 OTP·공개 계정/세션·Origin/CSRF·로그인 화면 | `c4606ac` | 실제 Resend 수신 미검증 |
| 03 | 개인 Star App 승인·PKCE·암호화 토큰·갱신 lease/재연결 | `b25731f` | 실제 GitHub 승인 미검증 |
| 04 | 본인 Star 조회/등록/취소·멱등 receipt·불명확 요청 fence·버튼 | `2992598` | 실제 starred 상태 대조 미검증 |
| 05 | 원문·공개 동의·작성 한도·held 검토·개인 기록·제품 화면 | `9df60e0` | 로컬 검증 완료 |
| 06 | 제품 수정키·현재 repo 관리권한·선택 저장소 설치·binding | `0ea6656` | 실제 개인/조직 설치 미검증 |
| 07 | 원자적 enqueue/job·publisher outbox·확정 결과·uncertain 재조회 | `cba7eed` | 실제 봇 이슈 미검증 |
| 08 | 서명 웹훅·즉시 권한 중지·정기 조회·관리자 감사/명시 재전송 | `007d65f` | 실제 웹훅·권한 철회 미검증 |
| 09 | 로컬 흐름/기존 화면 E2E·배포 사전 검사·운영/파일럿 문서 | `4f87832` | 코드·DB 운영 배포 완료; 활성화·실연동 파일럿 미실행 |

공통 명칭의 PR 번호는 계획상의 9개 논리 커밋이다. 원격 GitHub PR 번호가 아니다.
커밋 대상은 파일별로 지정했고 사용자 PPT나 `.env.local`을 포함하지 않는다.

## 인증과 주요 설계

이메일 로그인만으로 서비스 피드백을 작성할 수 있다. 본인 명의의 GitHub Star는
별도의 Star App 승인이 필요하다. 피드백 외부 전송은 작성자의 GitHub 공개 동의와
제작자의 Feedback App 설치·수신 설정을 모두 요구한다. 공개 계정은 관리자 세션과
분리되며 관리자 OAuth와 수집 인증은 쓰기 연동에 재사용하지 않는다.

- `/api/me`와 개인 상태는 primary DB와 `private, no-store`를 사용한다.
- 개인 Star의 불명확한 쓰기는 추가 변경을 잠근다. GET 결과 일치, 재연결 또는 lease
  만료로 잠금을 해제하지 않는다. 현재 자동·관리자 unlock API가 없으며 제한을
  PENDING/runbook에 명시했다. 사이트 클릭으로 공개 관측 별 수를 임의 증감하지 않는다.
- 피드백 저장/held 승인, outbox와 job 요청은 한 transaction이다. 기능 활성화 전 글은
  자동 전송하지 않는다. 이미 발송한 불명확 POST를 자동 반복하지 않는다.
- outbox는 숫자 repo ID·binding revision·동의·본문/payload hash를 발송 전 재확인한다.
  `sending`을 먼저 기록하고 외부 호출은 transaction 밖에서 한다. marker 목록과 현재
  개별 이슈를 대조하며 부분 순회를 부재 증거로 사용하지 않는다.
- 웹훅 receipt와 첫 binding/재전송은 동일 installation advisory lock을 먼저 잡는다.
  삭제/정지/저장소 제외/Issues 권한 제거 시 pending을 즉시 취소한다. 이미 발송된 요청의
  결과 확인은 계속한다. present permissions에서 Issues 생략은 명시적 none이다.
- 관리자의 재조회·재전송은 분리되며 1회 재전송은 이유·중복 위험 동의·멱등 키와
  현재 권한/원문 재검증을 요구하고 감사 기록을 남긴다.
- 임시 제작자 토큰은 10분 사용 만료, 기능 false에서도 다음 maintenance에서 암호문
  삭제를 수행한다. 정기/관리자 재조회 모두 제공자의 Retry-After/reset을 존중한다.
- 기존 배포 스크립트의 8개 쓰기 대상은 유지한다. maintenance 두 앱은 읽기 전용
  preflight 대상이며 mini→M3 동일 릴리스 수동 확인 절차를 문서화했다. worker에는
  Feedback App ID/private key만 제공하며 개인 사용자 토큰 복호화 키를 요구하지 않는다.

계획과 달리 웹훅 delivery UUID는 전역 PK로 사용해 app/hash 충돌을 거절한다.
Star unknown은 영구 fence로 구현했고, PR-09 브라우저 4개는 로컬 세션·binding·제공자
결과 fixture 검사다. 실제 OAuth→설치→publisher→webhook→운영 failover의 증거가 아니다.
병렬 실행에서는 PR별 기능 테스트와 직접 리뷰 후 논리 커밋하고, 전체 공통 검사는
통합된 최종 소스에서 수행했다. 이후 최신 base의 PR CI와 병합 후 main CI `check`가
모두 성공했고, merge SHA `650b341`의 운영 코드를 배포했다.

## 실제 최종 검증

| 명령/검사 | 실행 결과 |
| --- | --- |
| `npx next typegen`, `npx tsc --noEmit` | 각각 exit 0 |
| `npm run lint` | exit 0, 오류 0·기존 vendor `_ctx` 경고 1 |
| `npm test` | 246파일·2,256개 통과, exit 0 |
| `TEST_DATABASE_URL=…55444/nomorevibe_test npm run test:integration` | 140파일·1,370개 통과·기존 TODO 1, exit 0 |
| 새 인증/연결/Star/피드백/흐름 5개 Playwright spec | 18개 통과, exit 0; 기능 네 플래그 true |
| 기존 기능 false 전체 Playwright 회귀 | 30개 통과·신규 비활성 18개 skip, exit 0 |
| `python3 -m unittest tests.test_deploy_shared_images` | 23개 통과, exit 0 |
| `node --test scripts/ci-scope.node-test.mjs` | 4개 통과, exit 0 |
| `DATABASE_URL=…55444/nomorevibe_test npx drizzle-kit migrate` | 빈 DB에서 전체 migration 적용, exit 0 |
| production build | Playwright webServer의 실제 `npm run build` 성공 |
| bundle gate | 홈129.1KB/상세128.8KB/등록120.1KB br, 각 한도 이내·exit 0 |
| `docker compose config --quiet` | 테스트용 비밀 placeholder로 config 확인, exit 0 |
| `git diff --check` | exit 0; staged diff도 commit 직전 확인 |

테스트 DB는 exact 이름 `nomorevibe_test` 가드를 유지했다. `pgvector/pgvector:0.8.6-pg17`
전용 컨테이너 55441(인증),55442(피드백),55443(브라우저),55444(빈 DB에서 최종 전체 통합)를
사용하며 동일 DB를 동시에 초기화하지 않았다. 개발/운영 DB를 테스트에 사용하지 않았다.

최종 raw log는 `/private/tmp/nomorevibe-gh-final-{unit-b,integration-b,feature-e2e-b,baseline-e2e-e,python,ci-scope,fresh-migration,bundle-b}.log`에 있다.
build에는 기존 Turbopack
`lib/crawl/agent-review.ts` 동적 파일 접근 경고가 있으며 새 코드 오류로 해석하지 않는다.

## 직접 리뷰와 실패 원인 보완

오케스트레이터가 PR별 read-only Codex CLI를 실행했다. 01 및 02b/03b/04c/05b/06b/07c/
08b/09b 재리뷰에서 추가 P0/P1/P2를 확인하지 못했다. PR-09에 포함한 기존 E2E
8파일은 root가 diff를 직접 검토하고 github_core가 추가 읽기 전용 검토해 같은 결론을
보고했다. 해당 추가 리뷰는 테스트를 실행한 것으로 기록하지 않는다. 결과 파일은
`/private/tmp/nomorevibe-gh-reviewNN[-revision]-result.txt`에 보존한다.

리뷰에서 실제 드러난 URL 정규화/nonce 수명, callback 오류 표시, Star 로컬 receipt와
미확정 fence, 피드백 URL 한도와 제품별 내 기록, 조직 설치 승인 대기, outbox rate 분류/
개별 후보 검증/20초 SQL 예산, 웹훅 Issues 생략 권한 중지, 배포 PEM/역할 키 범위를
회귀 검사 후 수정했다. 수정 전 RED와 최종 GREEN은 파일럿 및 개별 agent 결과에 기록했다.

전체 DB 첫 실행에서 plain Node worker가 Next `server-only` 패키지의 기본 throw 때문에
시작하지 못했다. worker가 직접 사용하는 07/08 공유 모듈 7개의 표식만 제거하고 웹 전용
표식은 유지했다. 실제 자식 Node import와 worker 선출·SIGTERM drain·standby·crash failover
6개를 확인했으며 최종 140파일 전체 DB 검사도 통과했다.

PG17 `transaction_timeout` FATAL과 postgres3.4.9 조합은 driver의 socket 오류가 있어
폐기했다. 기존 pool의 scoped query deadline과 SQL마다 남은 statement/lock timeout,
COMMIT 전 lease/예산 검증, 끝까지 기다리는 rollback으로 바꿨다. 늦은 쓰기 취소와
201 이후 저장 실패·다음 틱 uncertain 복구를 실제 DB로 검사했다.

첫 build의 외부 node_modules symlink 문제는 APFS 물리 clone으로 해결했다.
기존 화면 E2E에서 드러난 현행 DOM 선택자·공개 캐시 slug·responsive 이미지
naturalWidth 오류는 기준 main의 해당 제품 코드와 동일함을 확인한 뒤 테스트만 고쳤다.
최종 전체 재실행은30개 통과·신규18개 skip·exit0이었다. 저장 응답 본문을 늦게
읽는 Playwright 리소스 수명 경합도 발견해 RSC 내부 파싱을 제거했다. 최종 검사는
200 응답에 더해 exact DB 저장·새 form version·표시 저장판·reload를 확인한다.

기존 관리자 fallback 저장은 실제 action `ok:true`/새 version과 revalidated props가
확인됐으나 dirty 표시가 남아 성공 알림이 숨겨졌다. 관련 설정 생산 코드는 기준main과
동일하며 이 표시 결함을 PENDING에 남겼다. 최종 브라우저 검사는 HTTP 응답에 더해 새 저장판·
정확한 DB 값·reload의 실제 저장 계약을 확인하고 표시 결함을 해결했다고 주장하지 않는다.
홈 fixture는 DB 갱신과 30초 공개 읽기 캐시가 섞이는 문제로, 운영 캐시를 완화하지
않고 테스트에서 정상 갱신을 제한된 시간 동안 기다린다.

## 남은 실제 제공자·운영 확인

새 Star/Feedback App, 암호화/공개 인증/Resend 설정과 허가된 사용자·개인/조직 repo·메일
대상은 제공되지 않았다. 따라서 실제 스타 등록/취소, 봇 이슈 생성, 메일 수신, 실제
웹훅 및 운영 주/예비 파일럿은 미검증이다. [파일럿 기록](2026-10-11-github-integration-pilot.md)의
외부 행은 미검증으로 유지하며 준비 후 runbook 순서로 수행한다.
