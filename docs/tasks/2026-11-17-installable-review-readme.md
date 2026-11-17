# 설치형 1차 심사에 README가 빈 채로 들어가던 문제

- PR: [#981](https://github.com/JRVector9/nomorevibe/pull/981)
- base: main `da81adec`, branch: `fix/installable-review-readme-20261117`
- 이 PR에서 하지 않은 것: 병합, 배포, 운영 설정 변경, 운영 DB 쓰기, 보류 건 재심사 실행. 관리자 알림 집계 코드도 바꾸지 않았다(그 일은 다른 PR이 맡는다).

## 남은 일

- [x] 최신 main에서 격리 브랜치, 빈 시작 커밋, push, Draft PR #981 확인.
- [x] 원인을 코드와 커밋으로 확정하고 시험 DB 55435에서 재현(아래).
- [x] 수정: 원본 판 대조를 밀리초 단위로 바꿈, README 받기 실패를 기록하고 기다림, 다시 수집할 때 README 판 때문에 승인이 다시 열리지 않게 함.
- [x] 이미 보류된 후보에 README를 붙이는 도구 `scripts/review-readme-backfill.ts`를 만듦(운영에서 실행하지 않음).
- [x] 바뀐 범위 vitest, `tsc --noEmit`, 바뀐 파일 ESLint, `npm run deploy -- scope` 실행.
- [ ] (사람 결정) 병합과 배포. 배포 범위는 아래 scope 결과 그대로다.
- [ ] (사람 결정, 배포 뒤) 보류 건 README 붙이기(`count` → `apply`). 방법은 PR 본문에 적었다.
- [ ] (배포 뒤 관측) 1차 스냅숏 `product.readme` 빈 비율과 `crawl.agent_review_skipped reason=readme_wait`, `crawl.agent_review_readme_unavailable` 로그를 잰다.

## 원인

- 원본 저장 `saveFetchedDocument`는 `fetched_at`을 `clock_timestamp()`로 쓴다(`lib/crawl/repository.ts`). 이 값은 마이크로초까지 있다. 이 저장 방식은 #436 `254a5bbb`(2026-10-16)에서 들어왔다.
- 1차 심사의 `loadReviewDocument`(`lib/crawl/jobs/review-document.ts`)는 README를 받은 뒤 `setReadmeSample`로 원본 옆에 붙인다. 이때 `eq(crawlDocuments.fetchedAt, expected.fetchedAt)`로 대조하는데, 비교값은 다시 읽은 JS Date라 밀리초까지만 있다.
- 그래서 마이크로초가 0이 아닌 거의 모든 원본에서 이 쓰기가 0행으로 끝난다. 그러면 README 없는 원본을 다시 읽어 `createReviewInput`을 만들고, 스냅숏의 `product.readme`가 `''`가 된다.
- `page_meta`가 null인 설치형에는 README 말고 다른 본문이 없다. 그래서 모델은 "README·pageText가 비어 있음"으로 판단을 보류(ambiguous)한다.
- 발행분 README 갱신 `recordPublishedReadme`에도 같은 대조가 있다. 그래서 그쪽도 결과(성공과 실패 모두)를 적지 못하고 같은 두 건을 되풀이한다.
- 운영 실측(대표 보고 report-187425a7)이 11-08부터 시작하는 까닭은 이 PR에서 확인하지 못했다. 코드 결함 자체는 10-16부터 있었다. 운영 DB를 읽지 않았으므로 11-08 이전 비율은 측정하지 않았다.

## 고친 것

- `sameDocumentRevision`: `date_trunc('milliseconds', fetched_at)`로 대조한다. 같은 밀리초 안에 다시 수집된 경우는 `page_meta` 대조가 막는다. `setReadmeSample`과 `recordPublishedReadme`가 이 함수를 같이 쓴다.
- README 받기 실패 기록:
  - `fetchReadmeSample(repo, request?, onFailure?)`가 실패 까닭을 알린다(`http_429`·`http_403`·`http_5xx`·`http_0`·`timeout`). 모든 이름이 404면 지금처럼 `""`(없음)이다.
  - `loadReviewDocument`는 원본에 `readmeFetchError`·`readmeFetchAttempts`·`readmeFetchRetryAfter`를 남긴다. 기다리는 간격은 15분, 30분, 60분…이며 그 시각 전에는 다시 받지 않는다.
  - 1차 심사는 3번째 시도 전까지 이 후보를 `readme_wait`로 건너뛴다. 이 건너뜀은 건너뜀 상한에 세지 않는다. 3번째 실패 뒤에는 README 없이 심사하고 `crawl.agent_review_readme_unavailable`를 로그에 남긴다.
  - 스냅숏 모양은 바뀌지 않는다.
- 다시 수집할 때 `judgementPageMeta`가 README 판·받기 기록 키를 빼고 비교한다. 이렇게 하지 않으면 README가 붙은 미발행 승인·보류가 다시 수집될 때마다 `new`로 돌아간다.
- 마이그레이션은 0개다(`page_meta` jsonb 키만 더한다).

## 실제 검사 기록

- 수정 전 재현(시험 DB 55435): `tests/integration/installable-review-readme.test.ts`의 README 채움 두 건이 `expected '' to be 'Agent Bridge MCP …'`로 실패했다. 대조 수정만 되돌린 상태로 돌렸을 때는 5건이 실패했다(설치형·주소 있음 README, 실패 기록, 다시 수집 시 승인 유지, 발행분 마이크로초).
- 수정 뒤:
  - 통합: 바뀐 모듈을 쓰는 43파일 중 41파일 540건이 통과했다. 나머지 2파일(`pipeline-consumer`, `pipeline-first-consumer`)은 앞 파일이 남긴 후보 행 때문에 `beforeAll`의 빈 표 전제에서 멈췄다. 이는 저장소에 알려진 직렬 파일 함정이다. 두 파일을 따로 돌리면 각각 8/8 통과다. 새 시험 파일에는 `afterAll` 정리를 넣었다.
  - 이후 `installable-review-readme` 6/6, `review-document` 6/6 통과.
- unit: `tests/installable-review-readme.test.ts`를 포함해 바뀐 모듈을 쓰는 20파일 703/703 통과. 새 unit 파일은 수정 전 base에서 8/10이 실패했다. 실패 구분 API가 없었기 때문이다. 성공 경로 2건은 DB 결함이 없는 모의 상태라 base에서도 통과했다.
- `npx next typegen` 후 `npx tsc --noEmit`: exit 0. 바뀐 파일 ESLint: exit 0.
- `npm run deploy -- scope --base da81adec… --sha <head>`: mode `full`, 대상 18앱 전부, reasons `no_runtime_change`·`unclassified_runtime_change`.
