# 저장소 이전 보강 개발과 통합 계약

PR-07 구현 범위다. 운영 DB·실제 모델·배포·설정 변경은 실행하지 않았다. `repo_move`는 migration 0120에서 off로 생성하며 dispatch/apply도 false다. 기존 `product_repo_reviews.answers`는 유지하고 모델 결과는 공통 결과 원장에 저장한다.

## 구현

- 기존 `product-repo-review`가 공식 GitHub redirect 또는 관련 링크를 발견하면 기존 human 기록과 비동기 작업을 같은 트랜잭션에서 기록한다. 생산자의 50초·최대 관련 링크 3개·`pageConclusive` 규칙은 유지한다. 추가 README/저장소 본문 수집은 소비자가 수행한다.
- `repoMoveCandidateSchema`의 kind는 `repo_move`, 모델 입력의 task는 `repo`다. raw 제품·저장소·검수 시각을 PostgreSQL `::text`로 보존하며 Date 변환 없이 URL/세대/운영자 결정과 대조한다.
- 제품 정체성·계보·공식 연속성은 별도로 검사한다. 현 구현에서 주소 후보의 공식 권한 증거는 서버가 확인한 GitHub redirect다. 저자 연속성만 있는 경우, 비공식 포크·동명·다중/미확인 링크는 보류한다. `unrelated`는 목적지의 다른 제품 본문과 정상 제품 페이지가 필요하다. 페이지 수집 실패나 README 누락으로 무관함을 추론하지 않는다.
- 실제 적용은 공통 결과/작업/입력/프롬프트/제어 revision을 다시 대조한다. 직전 저장소 재접속과 현재 raw snapshot이 맞아야 하며 claimed·메이커·active maker·운영자 keep을 보호한다. 이전 주소·link version·raw revision·공식 근거 hash와 결과 ID를 같은 감사 트랜잭션에 남긴다. 메이커가 숨긴 목적지 링크도 되살리지 않는다.
- 설치형 제품은 `url` 자체도 저장소 정체성이므로 자동 변경을 보류한다. 중복 제품으로 연결되는 주소도 보류한다. 별도 승인된 URL/health 이전 정책 없이 웹사이트 주소를 바꾸지 않는다.
- 기존/비동기 저장소 자동 내림이 동일 advisory lock과 24시간 감사 건수를 사용해 100건 한도를 지킨다.

## 공통 소비자 연결점

공통 파일의 최종 변경은 통합 담당자가 소유한다.

1. `work.ts` task/source union과 DB task CHECK에 `repo_move`/`RepoMoveCandidate`를 포함한다. task CHECK와 기본 off 행은 0120이 확장한다. 기존 uptime 타입은 업무를 좁힌 뒤 사용한다.
2. claim 선택에서 `source.snapshot`의 제품 ID·URL·repoUrl·repoLinkVersion·raw updatedAt/검수 revision을 사용한다. `product_health`가 없는 repo 작업도 소비할 수 있어야 한다. origin은 `product-repo-review`이며 원 업무 pause를 적용한다.
3. `collectRepoMoveInput(candidate,{signal})`이 ready일 때만 모델 작업을 준비한다. obsolete/waiting_evidence는 재추론 없이 해당 상태로 남긴다. 실제 dispatch 전 `lockRepoMoveCandidate(tx,candidate)`로 전체 snapshot과 보호를 확인한다.
4. 모델은 PR01 repo 계약과 공통 capacity/종료 장부를 사용한다. 같은 Qwen family인 GPU/M1을 독립 감사로 세지 않는다.
5. `decideRepositoryMove`로 도메인 후보를 검사한다. 실제 조치 전 `checkRepoMoveBeforeApply`로 다시 접속한다. 공통 결과를 같은 트랜잭션에 먼저 insert하고 작업이 claimed/current revision인 동안 `applyRepoMoveResult(tx,candidate,input,outcome,{resultId,workId},checks)`를 부른다. `updated`/`delisted`만 result.applied=true다. 다른 반환은 도메인 쓰기가 없다.

## 범위 검증

Node 24.22.1을 사용했다. 범위 단위 회귀 5개 파일 104건(저장소 판정·가짜 HTTP 근거 수집·기존 repo·stage·work-owner), 변경 파일 ESLint, Next typegen 후 TypeScript가 통과했다.

격리 PostgreSQL 17/pgvector 컨테이너 `nmv-llm-pr07-pg-20261023`의 loopback 55572 `/nomorevibe_test`에서 신규 CAS·기존 repo-health 회귀 24건이 통과했다. 추가 한도 경합·메이커 숨김·DB 바인딩 보호를 포함한 신규 파일 최종 12건도 통과했다. journal 등록 전이므로 기본 등록 migration 뒤 0119/0120 SQL을 이 일회용 DB에만 적용해 검증했다. 운영 journal은 수정하지 않았다.

수동 전체 unit·전체 DB·종합 검증, 실데이터 false-update 평가와 모델 성능 검증은 실행하지 않았다. 운영 자동 적용 준비 완료로 해석하지 않는다.
