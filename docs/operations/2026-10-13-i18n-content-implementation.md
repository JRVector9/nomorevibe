# I18N-03 제품 콘텐츠 번역 구현

2026-10-13. 독립 작업 경로 `/private/tmp/nomorevibe-i18n-content-20261013`, 브랜치 `feat/product-translations-20261013`. 이 기록은 구현과 로컬 읽기·순수 계약 검사 결과이며 운영 migration·번역 실행·배포 기록이 아니다. 탭 변경을 먼저 배포하는 부모 작업의 순서를 유지한다. 부모 에이전트가 `docs/CODEX_HANDOFF.md`를 통합 관리한다.

## 완료 범위와 파일

- `lib/db/schema.ts`, `drizzle/0075_product_translations.sql`, `drizzle/meta/_journal.json`: `(product_id, locale, field)` 기본키, 원문 해시, nullable 원문 locale, pending/ready/failed/reviewed 상태, 출처·모델·시도·오류·재시각·타임스탬프. DB check로 locale/field/status/현재 상태의 text 계약을 제한한다. 기존 최근 수동 migration과 같이 SQL+ledger를 추가하며 오래된 snapshot을 생성기로 다시 작성하지 않는다.
- `lib/domain/products/translation-policy.ts`: 순수 해시·언어 증거·표시 선택·출력 검사. 해시는 정책 버전 `public-fields-v1`/원문/제품명/field를 포함한다. ASCII만으로 영어를 단정하지 않고 증거가 없으면 lang를 생략한다. 간체·번체의 문체 지시·문자·용어 검사는 독립적이다. 숫자는 소수점과 자릿수를 포함하여 원문 토큰 그대로 보존하며 URL·인용·이름·기술 이름을 검사한다.
- `lib/domain/products/translations.ts`: 공개·현재 원문의 bounded batch 읽기와 노출 수요 접수, 대기 선택, lease/원문/시도 compare-and-set 저장. banned·unverified·미처리 takedown·현재 소개의 needs_editor 행을 제외한다.
- `lib/jobs/products/translations.ts`, `lib/jobs/catalog.ts`, `lib/jobs/registry.ts`: `product-translate`를 기존 text 역할 기본 줄에 추가한다. 요청된 행만 처리하며 product-intro-check를 접수하거나 pause를 변경하지 않는다.
- `lib/crawl/translate.ts`: 기존 gateway/chat·모델·환경 자격 정보를 사용하는 `translateProductFields`만 추가한다. 한국어 기존 writer/테이블/읽기와 기존 gateway 동작은 유지한다.
- `tests/text-worker-isolation.test.ts`: 기존 exact text-role 작업 수 계약만 7개→8개로 수정했다. 새 테스트 묶음을 만들지 않았다.

## UI 연결 계약

`lib/domain/products/translations.ts`의 공개 계약은 아래와 같다.

```ts
type ProductTranslationSource = {
  id: number; name: string; tagline: string; description?: string;
};
type ProductTranslationField = "tagline" | "description";

readProductTranslations(sources, locale): Promise<ProductTranslation[]>;
selectProductTranslation(source, locale, field, translation?): {
  text: string; lang: Locale | undefined; translated: boolean;
  ready: boolean; pending: boolean; sourceHash: string;
  sourceLocale: Locale | null;
};
requestProductTranslations(productIds, locale, fields = ["tagline"]): Promise<number>;
```

읽기/수요 모두 최대 80개 서로 다른 제품이다. description을 읽을 때 source.description을 전달한다. 읽기는 ready/reviewed 행의 해시를 **화면 원문 및 현재 DB 원문**과 각각 비교하며 LLM이나 쓰기를 호출하지 않는다. 요청 locale/field/source_hash가 동일한 완료·대기·실패 행은 재접수하지 않는다. 원문 변경은 해당 field 버전만 다시 대기시킨다. ineligible로 폐기된 동일 원문은 제품이 다시 적격일 때 수요로 재접수할 수 있다.

화면은 수신 행을 productId/field로 찾고 순수 선택 함수를 사용한다. 현재 요청 locale의 ready/reviewed → 확실한 같은 언어 원문 → 원문 및 해당 locale 준비 안내 순서다. 마지막 fallback은 `ready=false`이므로 영어/중국어 상세를 완료 번역으로 색인하지 않는다. 알려지지 않은 원문 언어는 영어로 표기하지 않는다. 한국어 호출은 새 큐/테이블을 사용하지 않으며 기존 현재 원문의 taglineKo 선택을 계속 사용한다.

수요 접수는 렌더 결과의 노출 제품에 대해 `after()` 등으로 **렌더 후 별도로** 호출한다. 복제본/캐시 결과 읽기 함수 안에 수요 접수를 넣지 않는다. 이 함수도 `onPrimary()`로 쓰기 연결을 명시한다. GET에서 모델을 호출하지 않는다. 원문·상세 제품명을 그대로 전달하고 번역 문자열을 source로 다시 보내지 않는다. 번역 캐시는 locale/원문 해시/정책 버전을 포함하고 준비 상태 갱신 반영은 상위 UI/cache 통합에서 담당한다.

## 예산·동시성·배포 계약

한 text 틱은 기본 25초 예산에서 한 번의 최대 20초 gateway 호출, 최대 4개 field/원문 4,000자만 처리한다. 원문이 4,000자보다 길면 호출하지 않고 해당 정책에서 exhausted 실패로 남긴다. 한 원문 버전은 최대 4번, 실패는 5분·10분·20분… 뒤에 재시도한다. gateway 키가 없으면 `no_key` deferred 로그만 남기며 ready로 만들거나 시도 수를 소비하지 않는다. 별도 API-key 설정은 이 단계의 요구가 아니다.

원문 생성/소개 판단/README/댓글/GitHub 릴리스 번역은 처리하지 않는다. 제품 상태·원문 해시는 모델 호출 후 제품 share lock으로 재확인하고 queue 행의 해시와 시도 수가 그대로일 때만 저장한다. 새 요청 버전·ready/reviewed를 오래된 결과가 덮지 않는다. 마지막 job lease 검사 실패는 전체 저장 transaction을 rollback한다. 기존 역할 lease가 한 text 소비자를 선정한다.

운영 반영 전 기존 runbook의 drain → PostgreSQL 직접 연결 migration 종료 코드 0 → 새 웹/text/scheduler 릴리스 절차를 따른다. additive migration은 기존 worker가 무시하는 새 테이블만 추가한다. 새 job의 별도 schedule DML은 없다. 새 scheduler가 catalog를 읽고 jobs 행/60초 주기를 만든다. 이전 text worker는 새 job을 소비하지 않는다. 새 웹이 수요를 먼저 접수해도 이전 worker는 기존 일만 처리하며 새 text worker 교체 뒤 대기 수요가 처리된다. migration 없이 새 번역 읽기 코드를 먼저 배포하지 않는다. 소개 검수의 운영 pause를 변경하지 않는다.

## 실제 검사와 남은 확인

- 최초 `npx tsc --noEmit --incremental false`: exit 2, 생성 전 PageProps 이름 없음 4곳. `npx next typegen` exit 0 뒤 같은 tsc를 실제 실행하여 exit 0.
- 출력 검사에 외부 호출의 한국어 방어를 추가하면서 Exclude 타입의 직접 ko 비교는 TS2367로 한 번 실패했다. runtime guard만 전체 Locale 비교로 바꾼 뒤 최종 tsc와 변경 파일 ESLint·diff 검사를 실제 다시 실행하여 모두 exit 0.
- 변경 TS 파일의 `npx eslint ...`: exit 0. `git diff --check`: exit 0.
- `npx vitest run tests/translate.test.ts tests/korean-tagline.test.ts tests/job-catalog.test.ts`: exit 0, 3파일/28개 기존 테스트 통과.
- `npx vitest run tests/text-worker-isolation.test.ts`: exit 0, 1파일/2개 기존 테스트 통과.
- `node --import tsx --input-type=module` 임시 순수 assert 실행: 해시의 이름/원문/field 차이, 현재·오래된 번역 선택, 영어 원문 준비, unknown 언어, 간체/번체 독립 선택과 용어/문자, 숫자·URL·인용·markup, text 역할 등록, `readMigrationFiles`의 SQL+ledger 76개 순서를 확인하여 exit 0. 부모 리뷰 지적 뒤 별도 소수 1.5→15 거절·번체의 下载 거절 assert를 실제 실행하여 exit 0. DB/LLM/HTTP 호출은 없었다.

DB migration 적용·SQL 결과 저장/CAS 통합 실행·실제 LLM 번역·기능 E2E·운영 배포는 실행하지 않았다. full build/full unit는 부모 통합 CI 범위다. 자동 검사는 제한된 언어·문자·용어와 출처 보존의 sanity gate이며 문장 의미 전체에 대한 사람 검수를 대신하지 않는다. source 언어가 불확실한 짧은 영어/중국어는 완료로 추정하지 않아 원문+준비 안내가 남을 수 있다.

## 다음 에이전트 명령

부모에게 전달한 백엔드 commit만 cherry-pick한다. pure locale 선행 commit `5e5abae670c3a2bf675bbfd80d63cd9863b1dbda`는 이미 통합된 경우 중복 적용하지 않는다. 이 worktree에서는 같은 선행 commit의 cherry-pick SHA가 `1d66f80`이다.

```bash
cd /private/tmp/nomorevibe-i18n-content-20261013
git status --short
git log -2 --oneline
git diff --check
npx next typegen
npx tsc --noEmit --incremental false
npx vitest run tests/translate.test.ts tests/korean-tagline.test.ts tests/job-catalog.test.ts tests/text-worker-isolation.test.ts
```

상위 통합 후 페이지에서 read/선택/after 수요 API를 연결하고 번역 준비에 맞춘 SEO·cache 계약을 적용한다. 정상 PR CI·최신 base 리뷰·운영 migration/릴리스는 부모가 수행하며 이 독립 작업은 push/merge/운영 쓰기를 하지 않았다.
