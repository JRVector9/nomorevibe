# PR406 병렬 코드 리뷰 — 2026-10-13

최종 통합 구현을 gpt-6.1-sol/xhigh 서브에이전트 3개가 독립적으로 검토했다. root가 실제 소스 조건과 순수 재현 결과를 다시 대조하여 신규 P2 결함 3건을 확인했다. **후속 보완 지시로 세 건을 수정했고 담당 리뷰 에이전트 2개가 재검토했다.** 검토 범위에서 확정한 P1은 없다.

- 대상: [PR406](https://github.com/JRVector9/nomorevibe/pull/406), HEAD `ba9c3fd53889fc5344ee7a94c15f8b249496b069`, base `6b3fdfe3ccb9a150a0c82d32fe8d14884ea89427`.
- 작업 트리: `/private/tmp/nomorevibe-i18n-integration-20261013`.
- 분담: 경로·인증·관리자 차단 / 번역 DB·작업·비용 / 공개 화면·SEO·sitemap. root는 재현·우선순위·기존 문제 구분을 담당했다.
- 최초 리뷰는 읽기 전용이었다. 후속 수정은 아래 제품 코드3파일과 결과·인계 문서다. 운영 설정·DB·배포 변경은 없다.

## 후속 보완과 실제 확인

- R1: `lib/jobs/products/translations.ts`의 호출 이후 조건을 외부 종료 신호 검사로 좁혔다. 내부 시간 예산 취소는 이미 보낸 시도로 기록한다. 신규 호출 전 budget/abort 검사와 기존 record transaction의 최종 lease/CAS 보호는 유지한다. 소유권이 실제로 사라지면 최종 lease 오류가 전파되고 트랜잭션이 취소되는 기존 계약이다.
- R2: `lib/domain/products/translations.ts`의 demand upsert에 stale_source 재접수만 추가했다. 일반 검수 실패·timeout·source_too_long은 같은 원문 demand로 초기화하지 않는다.
- R3: `lib/i18n/routing.ts`의 switchLocale이 로그인 URL의 단일 검증된 returnTo에도 선택 locale을 적용한다. 제품 식별자·query/hash는 유지하고 중복·외부·관리자·API 복귀 주소는 선택 언어 홈으로 대체한다. 일반 언어 링크와 서버 인증 API는 바꾸지 않았다.

root의 실제 worker+fixture 재현에서5틱의 모델 함수 호출4회/기록4건/attempts4를 확인했다. 최종 lease 오류의 전파와 외부 shutdown의 기록0건도 확인했다. 네 언어 로그인 복귀와 query/hash, unsafe fallback 및 일반 링크 보존도 실제 helper assertion exit0이다. 에이전트는 로그인 주소89개 assertion exit0, 실제 requestProductTranslations의 upsert SQL 캡처에서 재접수 오류가 ineligible/stale_source 두 개뿐임을 확인했다. 실제 저장 함수의 attempts1~4·backoff5/10/20분·마지막 retry 없음, 내부 budget abort 기록·외부 shutdown 생략·lease 오류 전파도 소스 기반 fixture로 확인했다. 모두 DB·네트워크·LLM 호출0이며 실제 DB rollback을 실행한 것으로 주장하지 않는다.

수정 후 next typegen, tsc69931, 세 수정 파일 ESLint53335, check:i18n(4언어/8namespace/11page), diff 검사는 실제 exit0이다. 새 suite·E2E를 추가하거나 실행하지 않았다. 담당 에이전트 두 개는 수정 후 신규 확정 결함을 찾지 못했다. 최신 필수 CI의 상태는 [PR406 checks](https://github.com/JRVector9/nomorevibe/pull/406/checks)에서 해당 최신 head와 대조한다. 아래는 최초 결함의 재현·근거 기록이며 수정 후 동작과 구분한다.

## 확인한 결함

### R1 — P2: 시간 예산 종료 시 번역 실패 횟수와 재시도 대기를 기록하지 않는다

위치: `lib/jobs/products/translations.ts:34-36`. 보조 근거는 같은 파일15행, `lib/jobs/runner.ts:120`, `lib/domain/products/translations.ts:115-117,139-141`이다.

worker는 25초 틱의 남은 시간과 관계없이 gateway timeout을20초로 지정한다. claim/DB 읽기 등에6초를 소비하면 남은 시간은19초다. 이 상태에서 느린 요청을 시작하고25초 예산에 도달하면 ownership polling이 요청을 취소하고 `hasBudget()`는 false가 된다. 이때 recordProductTranslations를 호출하기 전에 반환하여 attempts/retryAt/updatedAt을 갱신하지 않는다. 소유권이 유지되는 단순 시간 예산 종료에도 같은 처리가 적용된다. 기존 text DB 기본 statement timeout은60초라 선행 읽기6초는 설정상 가능한 조건이다.

같은 지연이 반복되면 동일한 오래된 행이 계속 선택되어 최대4회 제한과 실패 backoff를 우회하고 뒤의 작업도 밀릴 수 있다. 모델 요청을 이미 보냈다는 사실이 행에 남지 않는다. 실제 운영에서 발생한 횟수나 비용을 측정한 것은 아니다.

root는 실제 worker 파일을 TypeScript로 transpile해 실행하고 DB/gateway만 fixture로 대체했다. 가상 시간의5틱에서 **모델 함수 호출5회 / 기록0건 / attempts0 / done=false5회**가 재현됐다. 외부 모델 호출이 아니다. ownership polling 타이머는 fixture로 대체했으며 실제25초 기다림·lease 상실·DB SQL은 검증하지 않았다. 에이전트도 같은 결함을 독립 재현했다.

최소 보완 방향: 남은 시간에서 저장 여유를 예약한 호출 timeout을 사용하거나, 예산 종료와 소유권 상실을 구분하여 유효 lease 아래 실패 시도를 기록한다. 실제 lease 상실 후 저장 금지와 최종 lease/CAS 보호는 유지해야 한다.

### R2 — P2: 원문을 되돌리면 stale_source 행을 다시 접수하지 못한다

위치: `lib/domain/products/translations.ts:94-97`. 보조 근거는115-116행 및134-141행이다.

원문 A의 작업이 대기·실행 중일 때 원문이 B로 변경되면 A 행은 `failed`, `stale_source`, `attempts=4`로 종료된다. B에 대한 새 demand가 들어오기 전에 원문을 A로 복원하고 페이지를 다시 방문하면 현재 원문 해시가 저장된 A 해시와 같아진다. upsert는 해시 차이 또는 `ineligible`만 허용하므로 이 행을 갱신하지 않는다. worker의 `attempts < 4` 조건도 만족하지 않아, 해당 언어·필드 번역이 재개되지 않는다.

실제 해시 함수로 A→B→A를 계산하고 현재 upsert·pending 조건을 대조했다. **enqueueAllowed=false / pendingAllowed=false**를 root와 에이전트가 확인했다. DB 트랜잭션을 실행한 결과로 주장하지 않는다.

최소 보완 방향: 현재 원문에 해당하는 `stale_source` 행도 demand upsert가 pending으로 재접수하도록 허용한다. 일반 검수 실패의 최대4회 제한과 source_too_long 처리를 함께 초기화해서는 안 된다.

### R3 — P2: 로그인 화면에서 언어를 바꾸면 인증 후 이전 언어로 돌아간다

위치: `components/home/LanguageSwitcher.tsx:25-31`. 보조 근거는 `lib/i18n/routing.ts:36-37` 및 `app/(public)/[locale]/(content)/login/page.tsx:29-30,44-48`이다.

`/en/login?returnTo=%2Fen%2Fp%2Fdemo%3Fsort%3Drecent%23feedback`에서 번체를 선택하면 바깥 경로만 `/zh-Hant/login`으로 바뀐다. query 안의 returnTo는 `/en/p/demo?sort=recent#feedback` 그대로다. LoginPage는 안전한 주소라는 이유로 이 값을 유지하고 이메일·GitHub 인증 폼에 전달하므로 인증 완료 후 선택한 번체가 영어로 돌아간다.

실제 switchLocale/safePublicReturnUrl을 호출한 순수 재현에서 **선택 경로=/zh-Hant/login / 복귀=/en/p/demo?sort=recent#feedback**를 root와 에이전트가 확인했다. 실제 인증이나 브라우저 로그인을 실행한 것은 아니다. 설계의 같은 언어·제품·댓글 작성 의도 복원 계약과 어긋난다.

최소 보완 방향: 로그인 페이지에서 언어를 선택할 때 검증된 공개 returnTo의 언어도 바꾼다. 제품 식별자·sort/query/hash는 보존하고 same-origin/공개 경로 allowlist와 중첩 query 검증을 유지한다.

## 추가 지적이 없는 범위와 한계

관리자 fail-closed·locale header 덮어쓰기·same-origin 복귀 allowlist, source hash/CAS·최종 lease 검사, primary enqueue/replica read, 요청80제품·batch4필드/4000자 제한, 간체·번체 독립 저장, 수요 기반 큐, 중단 소개 검수 보존, 검색 cache 방향·버전에서 위3건 외 확정 결함을 찾지 못했다. UI/SEO 에이전트는 provider/namespace, 주요 공개 분기·링크·Intl/KST·locale 중립 집합/순위, JSON-LD·readiness/noindex/hreflang·sitemap에서 신규 actionable finding을 찾지 못했다. 이는 전체 동작의 무결함 보장이 아니다.

한국어 외부 주소에 headers를 적용하고 proxy에서 /ko로 rewrite하는 순서는 설치된 Next resolve-routes가 headers→redirects→middleware로 처리함을 확인했다. 이 후보를 신규 결함으로 보고하지 않는다. 이번 리뷰에서 실제 CDN 응답을 요청한 것은 아니다.

이미 untouched baseline에서도 확인한 잘못된 상세·분야 주소의 빈404 SSR 화면은 신규 회귀 목록에서 제외했다. 기존 vendor lint 경고나 별도 의존성 경고도 이 변경의 결함으로 포함하지 않았다.

실행한 검증은 결함 재현을 위한 순수 로컬 assertion과 diff 검사다. root assertion exit0은 **위 잘못된 동작을 재현했다는 뜻**이며 수정 성공을 뜻하지 않는다. 실제 DB/LLM/network 호출0, 새 test suite·E2E·계정 쓰기·운영 조작0이다. 기존 최신 필수 [CI38345403384](https://github.com/JRVector9/nomorevibe/actions/runs/38345403384)는 구현 head에서 성공했지만 위 경로의 기능 검증을 대신하지 않는다. 이번 리뷰에서 CI를 다시 실행하지 않았다.

세 결함의 최소 수정·소스 경계 확인은 완료했다. 최신 head 필수 CI 및 사용자 직접 언어·인증 복귀·fallback·모바일 확인이 출시 절차에 남는다. 운영 DB migration0075와 다국어 배포는 아직 수행하지 않았다.
