# 저장소 공식 연결과 작업별 근거 경로 검증

## 목적과 범위

기준 커밋은 `592c0a1baeffe4dc6f40a82a3fdcb7ff9f6cf8c0`이고 격리 브랜치는
`fix/repo-official-source-proof`다. GitHub redirect와 README 유사성만으로 제품의
저장소 URL을 교체할 수 있던 경로에 현재 제품 홈페이지의 명시적 공식 연결 검증을 추가했다.
repo/intro/audit/news의 근거 경로 계약도 실제 출력 필드로 한정했다.

공유 `docs/CODEX_HANDOFF.md`는 root 통합 작업 소유여서 직접 수정하지 않았다.
이 문서를 해당 단계의 별도 인계 자료로 반환한다. root가 생산 코드 5개 파일을 직접
리뷰했고 추가 P1/P2를 발견하지 않았다고 전달했다. 병합과 배포는 이 브랜치에서 실행하지 않았다.

## 변경 파일과 결정

- `lib/domain/products/repo-move-evidence.ts`: 기존 `extractSiteRepositoryKeys`를 재사용해
  보이는 본문과 별개로 명시 Source/Repository href를 `product_page_repositories` source에
  보존한다. 동일 fetch의 원 본문 SHA-256, page revision, URL, 관측 시각, completeness를 묶는다.
- `lib/domain/products/repo-move-review.ts`: 완전한 현재 홈페이지의 유일한 공식 링크가
  옛 저장소 또는 목적 저장소의 정확한 repository key일 때만 URL 교체를 허용한다.
  링크 없음·복수·충돌·잘림·차단·누락·오래된 자료·불일치는 사람 확인으로 보낸다.
- `lib/domain/products/repo-move-reviews.ts`: update에도 적용 직전 `fresh.page`와
  `fresh.pageRepositories`를 요구한다. 두 source identity와 원 본문 hash가 동일해야 하고
  현재 재검증 시각은 60초 이내여야 한다. 관측 시각만 identity 비교에서 제외한다.
- `lib/domain/llm-assist/contracts.ts`: 네 작업의 `evidence.supports`를 해당 state 필드와
  schema가 허용하는 배열 원소 경로의 enum으로 만든다. 실제 응답에 해당 원소가 있는지와
  원문 인용이 정확한지는 기존 runtime 검증을 유지한다.
- `lib/domain/llm-assist/prompts.ts`: 네 작업에서 필드 경로와 상태 값의 차이, 근거 품질의
  일관성, repo 공식 홈페이지 연결을 명시한다. 응답 교정이나 인용 정규화는 추가하지 않았다.
- 단위 테스트 4개 파일과 통합 테스트 2개 파일을 추가·수정했다.

기존 candidate/snapshot schema와 전역 wire/prompt 버전 `2026-10-23.1`은 유지한다.
기존 큐도 소비자가 현재 홈페이지와 metadata를 다시 수집한다. 새 source가 없는 이전
입력은 자동 URL 교체 권한을 얻지 못한다. 기존의 실제 필드·배열 원소 경로는 유지하며,
상태 값을 덧붙인 경로, 배열 `length`, schema 밖 원소 경로는 거절한다.
결과의 정확한 prompt hash를 대조하는 기존 적용·평가 검증도 유지한다.

새 metadata 버전은 `repo-page-repositories-2026-10-25.1`, 네 작업의 근거 경로 revision은
`2026-10-25.1`이다. 홈페이지 raw HTML이 동적으로 변하면 본문 hash도 변해 적용을
보류할 수 있다. 이는 현재 공식 근거의 동일성을 확인하는 보수적인 선택이다.

## 계약 해시

| 작업 | 새 schema SHA-256 | 새 prompt SHA-256 |
| --- | --- | --- |
| uptime, 변경 없음 | `fafe8e354f66f4f2b1cad71a6f55d708e5a7ceaaaaed7d26240a4845d910352b` | `a9345c8892920d3d2af39bf576ce840559b7e5450f7a7c703b0e4ece78a7f83d` |
| repo | `894f917807635af57ad33c803973a5747d4a22c53d868b509d7f98e7df22db5b` | `1be5ab4e2f55729041d7b6c4422b2a9280104b80d259592291556590eab1aad3` |
| intro | `4d980789dc8e5331df387c5795f8ffd50eab459fe3cd35ecd2a5abf69fc75f32` | `08bd33b4291f8533099181bb90c3412c23003da22a4acb3a75adc80d14d3e037` |
| audit | `ee218b62d62e133e8f853509696393b165420f14619e1ef7c2facdf40169edd4` | `0c4c546176d67b28e6169b22d98b1bb4b7b9edf54fa7b4969b9574394f3878e3` |
| news | `c1b95ca6a8bdc86cfb1e4f62e6513940d3736c78054a11505ff3edf9e53acb12` | `fc1e9422fff263a3080c5e0ac0673d2170ee6a820bc822e083b5e92362d7aeb1` |

기준 커밋의 구현에서 직접 산출한 이전 해시와 위 새 해시를 private 검증 자료에 함께 보존했다.
news schema 크기는 10,577 bytes다. 원래 고정 입력 6건의 source와 observedAt을 바꾸지 않고
새 builder로 요청 생성/preflight만 실행했으며, 최대 wire 크기 25,912 bytes로 모두 기존
C=50,000/output=2,048의 보수적 byte 기반 preflight를 통과했다. 모델 POST는 실행하지 않았다.

## 실행한 검증

TDD에서 먼저 확인한 실패는 다음과 같다.

- 공식 홈페이지 guard 반례: 11건 중 9건 실패, 2건 통과. 잘못된 URL update 허용과
  href metadata 누락을 관측한 뒤 구현했다.
- 적용 직전 page 검증: 6건 모두 `updated`가 나와 기대한 `stale`에 실패했다.
  fresh 검증을 추가한 뒤 해당 파일 18건이 통과했다.
- 작업별 경로 계약: 14건 중 9건 실패, 5건 통과. schema enum과 prompt 수정 후 14건이 통과했다.

최종 범위 회귀 결과는 단위 **114/114**, 격리 DB 통합 **46/46** 통과다.
합성 악의적 모델 fixture도 `official_product_repository_not_verified`로 사람 확인을 요구했다.
이는 실제 모델 응답을 고친 자료가 아니라, guard 우회 가능성을 검사하는 별도 합성 자료다.

```sh
npx vitest run tests/llm-assist-evidence-pointers.test.ts tests/llm-assist-contract.test.ts tests/llm-assist-evaluation.test.ts tests/llm-assist-audit-runtime.test.ts tests/intro-assist.test.ts tests/intro-assist-runtime.test.ts tests/repo-move-review.test.ts tests/repo-move-evidence.test.ts tests/repo-move-official-page.test.ts tests/news-localization-facts.test.ts

TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:32776/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/repo-move-dispatch.test.ts tests/integration/repo-move-review.test.ts tests/integration/llm-assist-audit-news-runtime.test.ts tests/integration/intro-assist-dispatch.test.ts --silent

npx next typegen
npx tsc --noEmit
npx eslint lib/domain/llm-assist/contracts.ts lib/domain/llm-assist/prompts.ts lib/domain/products/repo-move-evidence.ts lib/domain/products/repo-move-review.ts lib/domain/products/repo-move-reviews.ts tests/integration/repo-move-dispatch.test.ts tests/integration/repo-move-review.test.ts tests/repo-move-evidence.test.ts tests/repo-move-review.test.ts tests/repo-move-official-page.test.ts tests/llm-assist-evidence-pointers.test.ts
git diff --check
```

격리 DB는 컨테이너 `nomorevibe-repo-official-source-test-20261025`의 loopback 32776이다.
위 URL은 이 테스트 전용 fixture 자격 정보다. 운영 DB나 다른 작업자의 55447 포트는 사용하지 않았다.
Next typegen, TypeScript, 변경 파일 ESLint, diff check도 실제 실행해 통과했다.
Vitest는 기존 Vite CommonJS/native config 경고를 출력했으며 테스트 실패는 없었다.
전체 unit·전체 DB·종합 테스트는 저장소 지침에 따라 이 단계에서 실행하지 않았다.

초기 배열 parameterized test에서 Vitest가 배열을 여러 인자로 전달해 fixture 제목이
정확하지 않았던 문제는 object case로 고쳤다. RED의 guard 실패 내용과 실제 모델 실패는
별개로 보존했다. 일시적인 missing file 검색 오류는 경로를 확인해 바로잡았다.

## 이전 실제 개발평가와 남은 작업

이 수정 전 원본 6건 평가(repo 2, intro 2, news 2)의 입력·라벨·원응답·점수는 변경하지 않았다.
실제 HTTP/응답 model/stop/usage는 6건 모두 확인했지만 공통 guard 통과는 2/6,
고정 기대 finding과 사실 rubric까지 충족한 결과는 1/6이었다. 뉴스 domain 통과는 0/2,
저장소 자동 update domain 통과는 0/2였다. 금지해야 할 원시 제안 2건은 기존 검증에서
막혔다. p50 3,588ms, p95 8,188ms였고 이 6건을 포함한 담당자의 실제 모델 POST 누계는
29회다. 이 구현 단계의 추가 실제 모델 POST는 0회다. 다른 담당자의 API canary는 이 수치에
합산하지 않는다.

라벨은 Codex AI 독립 개발 라벨이다. 사람 라벨·독립 holdout·production native canary·
운영 globalReady·자동 적용 적격을 입증하지 않는다. 운영 제품/후보/원장/환경 변경도 실행하지 않았다.
새 prompt의 실제 모델 품질 개선을 주장하지 않으며, 추후 root가 조율하는 fresh native canary가 필요하다.
뉴스 negation parser는 별도 최소 설계 검토 대상으로 남겼으며 이 브랜치에서 수정하지 않았다.

다음 담당자는 아래 순서로 상태를 확인할 수 있다. 기존 통과 테스트를 이유 없이 반복할 필요는 없다.

```sh
cd /Users/jr/Desktop/projects/nomorevibe-repo-official-source-proof
git status --short
git log -1 --oneline
git show --stat HEAD
npx tsx /private/tmp/nomorevibe-llm-activation-20261024/evaluation/repo-official-proof-verification/verify.ts
```

마지막 명령은 모델 호출과 DB 쓰기 없이 기존 고정 입력으로 요청 생성·해시·합성 guard만 검사한다.
private 검증 자료는 `/private/tmp/nomorevibe-llm-activation-20261024/evaluation/repo-official-proof-verification/`,
원본 평가 자료는 같은 evaluation 아래 `four-task-development-v1/`에 있다. 원문과 cohort는
공개 저장소에 추가하지 않았다. root 최종 통합과 필수 CI·배포 검증은 남은 작업이다.
