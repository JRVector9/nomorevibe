# 댓글 PR01~04 구현 리뷰 보고서

2026-10-12. 승인된 댓글 전체 시나리오를 구현하고 통합 코드 리뷰를 마쳤다. 네 PR을 게시했으며 병합·운영 배포는 수행하지 않았다. 화면 기능 테스트는 사용자가 직접 진행한다.

## 구현 결과와 PR

| PR | 결과 | 주요 변경 |
| --- | --- | --- |
| [PR01 #393](https://github.com/JRVector9/nomorevibe/pull/393) | 댓글 영역 통합·작은 목록·공개 개수 | 기본3개·본문2줄 미리보기·펼치기, 공개 GET의 실제 total, 조회 실패와 빈 상태 구분 |
| [PR02 #394](https://github.com/JRVector9/nomorevibe/pull/394) | 한 줄 작성 진입·로그인 복귀 | 약48px 작성 버튼, 본문에서 제목 생성, 작성 의도를 확인한 인증 복귀에서 한 번 펼침, 취소 시 초안 유지 |
| [PR03 #395](https://github.com/JRVector9/nomorevibe/pull/395) | 접수 결과·내 댓글·재시도 | 실제 서버 응답을 즉시 목록에 반영, 검토 중·거절은 비공개, 실패 시 동일 본문/요청 ID 유지, 지연 응답·중복 증가 차단 |
| [PR04 #396](https://github.com/JRVector9/nomorevibe/pull/396) | GitHub 전달·상태·설정 축소 | 연결된 프로젝트의 접힌 전달 옵션과 별도 동의, 작은 전달 상태·확인된 이슈 링크, 헤더의 제작자 설정 메뉴 |

## 병렬 작업과 충돌 관리

모든 서브에이전트는 `gpt-6.1-sol`, `xhigh`로 실행했다. root를 포함한 동시 실행 한도4개에 맞춰 PR01·02·04의 독립 작업을 먼저 병렬로 진행했다. PR03은 PR01·02의 인터페이스 확정 후 진행했고 PR04의 공통 폼·목록 연결은 PR03 이후 수행했다. 네 작업은 별도 worktree를 사용했고 공통 파일 연결·브랜치 전달은 오케스트레이터가 순서대로 관리했다.

PR01 → PR02 → PR03 → PR04로 브랜치를 쌓았고, 게시 후 보정은 일반 커밋과 병합으로 전달했다. force push는 사용하지 않았다. 루트 main과 사용자의 기존 미추적 자료는 보존했다.

## 코드 리뷰에서 수정한 문제

- 유효한 기존 초안의 제목·본문·요청 ID는 그대로 재시도한다. 빈 제목의 오래된 초안은 API에 접수될 수 없으므로 본문 기반 제목과 새 ID로 복원해 작성이 막히지 않게 했다.
- 자동 생성 제목에서 HTTP(S) URL을 제외했다. 제목에 복제된 링크가 기존 본문 링크 검토에 중복 계산되지 않도록 했으며 본문과 서버 검토 기준은 유지했다.
- 작성 의도는 프로젝트별 저장 키와 일회성 nonce가 일치하는 로그인 복귀에서만 소비한다. 실패 재시도 표시만 남은 일반 로그인으로 작성창이 자동 펼쳐지지 않게 했다.
- 접수 시작 전에 초안과 동일 요청 ID를 저장한다. 접수 중 새로고침이나 응답 유실 후 재등록해도 기존 중복 방지 계약을 유지한다.
- 공개 개수는 같은 가시성 조건을 적용한 DB 집계다. 새201 접수만 한 번 증가시키고 재확인은 중복 증가시키지 않는다. 이전 GET 응답이 최신 접수 상태를 덮어쓰지 않게 했다.
- 오래된 댓글을 재확인할 때도 생성일·ID 내림차순으로 정렬한 후 공개50개/내100개 제한을 적용한다. 목록 재조회 실패가 오래된 글을 최신 댓글처럼 올리지 않는다.
- 공개/내 댓글 조회 실패를 각각 처리한다. 내 댓글 조회 실패로 공개 댓글을 숨기거나 실패를0개로 표시하지 않는다. 기존 API 응답에 total이 없으면 알 수 없는 개수로 유지한다.
- 공개 응답에 비공개 검토 사유를 넣지 않고, 내 댓글은 작성자 확인 후에만 표시한다. 원문·관리자의 전체 본문과 전달 정보는 유지했다.
- 작은 UI의 글자는 기존 최소13px 규칙을 유지한다. 중복 `#feedback`과 등록되지 않은 테마 클래스도 제거했다.
- 전달 연결이 사라진 저장 초안은 복원 시 payload/ID를 바꾸지 않는다. 실제 편집 또는 작은 선택 해제 버튼으로 전달을 끌 수 있으며 접수 중에는 편집을 잠근다.

리뷰한 변경 범위에서 남은 병합 차단 문제는 발견하지 않았다. 이 결과는 실제 인증·전송 성공의 증거를 대신하지 않는다.

## 실행한 확인과 한계

설치된 Next.js16.3.8의 관련 가이드를 읽었다. 에이전트별 ESLint·라우트 타입 생성·TypeScript 검사에 이어 오케스트레이터가 최종 통합본의 아래 검사를 실제 실행해 모두 종료 코드0을 확인했다.

```sh
npx eslint components/product-detail/FeedbackForm.tsx components/product-detail/FeedbackList.tsx components/product-detail/FeedbackGithubOptions.tsx components/product-detail/FeedbackDeliveryStatus.tsx components/product-detail/FeedbackSettingsMenu.tsx 'app/p/[slug]/page.tsx' 'app/api/products/[slug]/feedback/route.ts' lib/domain/feedback/repository.ts tests/product-feedback.test.ts tests/product-detail-components.test.tsx tests/e2e/product-feedback.spec.ts
npx tsc --noEmit --incremental false
git diff --check cd95de0..HEAD
```

GitHub의 기존 필수 CI는 각 PR의 최신 head를 기준으로 확인한다. PR01의 첫 CI는 신규 글자의 최소13px 규칙과 기존 상세페이지 테스트의 오래된 기대 때문에 실패했다. UI 글자를 규칙에 맞추고 기존 테스트의 기능 플래그·읽기 순서를 새 댓글 영역에 맞춰 보정했다. PR01·02·03 및 PR04 코드 통합본에서 quality·integration3분할·필수check 성공을 실제 확인했다. 확인한 head/run은 PR01 `68940aa`/`38263733075`, PR02 `f9d7ffa`/`38263748425`, PR03 `7eb0ddb`/`38264257084`, PR04 `c695954`/`38265357907`이다. 문서 커밋 후 최신 head의 필수check는 각 PR과 `docs/CODEX_HANDOFF.md`의 최신 기록에서 확인한다.

새 worktree의 첫 TypeScript 검사는 생성된 라우트 타입이 없어 기존 `PageProps` 참조4건에서 실패했으며 설치된 Next CLI의 `next typegen` 후 통과했다. 기존 테스트/fixture와 E2E 선택자를 변경했지만 새 테스트 체계는 만들지 않았다. 로컬 자동 기능/E2E·브라우저 테스트·실제 운영 댓글 제출·GitHub 이슈 생성은 실행하지 않았다. GitHub 필수 CI가 실행하는 기존 테스트·빌드와 사용자 직접 기능 테스트를 구분한다.

## 남은 확인과 병합 순서

사용자 확인 항목은 로그인 전/후 작성 진입, 인증 취소·복귀, 취소 후 초안 복원, 공개·검토 중·거절, 응답 유실·새로고침·동일 요청 재시도, 내 댓글 권한, 공개50개를 넘는 개수, GitHub 연결·미연결·별도 동의, 좁은 화면·키보드다. 실제 GitHub 전송은 수신이 연결된 테스트 프로젝트의 이슈와 원문으로 확인한다.

네 PR은 #393 → #394 → #395 → #396 순서다. 앞 PR을 병합한 뒤 후속 PR의 base를 main으로 바꾸고 실제 main 변경을 반영해 필수check를 다시 확인해야 한다. 현재 stacked base의 성공을 미래 main 병합 결과로 주장하지 않는다. 병합·운영 웹 배포·사용자 화면 확인은 남아 있다. 새 키·DB 스키마·워커·플래그·스타 기능 및 중단된 소개 검수는 이번 작업에서 변경하지 않았다.
