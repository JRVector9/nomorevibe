# 공개 i18n — SEO·검색·캐시·CI 구현

2026-10-13. I18N-04의 서버 계약을 구현했다. 이 브랜치는 `7201e73` 기반의 격리된 작업이며 운영 배포·DB 쿼리·마이그레이션·LLM 호출을 실행하지 않았다. 공개 페이지 본문·metadata 호출부·root/proxy·UI 카탈로그는 통합 담당자가 연결한다. 중단된 소개 검수는 재개하지 않았다.

## 구현과 통합 계약

- `lib/i18n/metadata.ts`의 `localizedAlternates(locale, logicalPath, readyLocales)`는 자기 언어 canonical, 준비된 언어만의 동일한 상호 hreflang, 한국어 `x-default`를 만든다. query/hash를 canonical에서 뺀다. machine 경로는 거부한다. `localizedOpenGraph`는 같은 등록 목록의 locale을 사용한다.
- `productReadyLocales(source, rows, contentEligible)`는 기존 한국어를 유지하고, 새 언어는 tagline과 description이 모두 현재 원문에 대해 준비됐을 때만 포함한다. 빈 description은 준비됨이다. 확실한 같은 언어 원문은 재사용하고, 확실하지 않은 언어는 준비됐다고 판단하지 않는다. 검수 보류일 때 `contentEligible=false`를 반드시 넘긴다.
- `productLocaleMetadata(locale, path, source, rows, baseIndexable, contentEligible)`는 기존 `productIndexable` 결과를 추가로 지킨다. 기존 색인 불가 제품은 `{index:false, follow:false}`다. 공개 제품의 번역 대기는 `{index:false, follow:true}`다. 대기 페이지도 self canonical을 유지한다.
- metadata에는 `readProductTranslationReadiness(sources)`의 **모든 언어** ready/reviewed 상태를 넘긴다. 요청 언어의 행만 넘기면 상호 alternate 목록이 달라진다. 최대80개 제품의 상태·원문 hash·비어 있지 않은 text 표식만 읽는다. 공개/내림 요청/현재 원문 소개 보류 조건과 요청 원문 및 DB 원문 hash를 함께 확인하며 쓰기와 LLM 호출은 없다. 기존 본문용 `readProductTranslations`는 그대로다.
- `source.name`은 표시용 이름이 아니라 원문 hash에 쓰는 DB 제품 이름이다. 통합 브랜치의 `translationName`을 사용한다. `productTranslationEligibilityField.translationEligible`은 같은 eligibility SQL의 detail extra다. 공유 `productTranslationEligible` predicate와 `translationEligible` detail alias를 사용한다.

```ts
const source = { id: product.id, name: product.translationName,
  tagline: product.tagline, description: product.description };
const ready = await readProductTranslationReadiness([source]);
const localized = productLocaleMetadata(locale, `/p/${product.slug}`, source, ready,
  productIndexable(product), product.translationEligible);
```

## Sitemap

`app/sitemap.ts`를 `/sitemap.xml` route handler와 `/sitemaps/[locale]/[file]`로 바꿨다. robots의 기존 index URL은 유지한다. 정적 UI 파일과 제품 파일은 네 언어에 각각 있으며 machine URL에는 언어 접두사를 붙이지 않는다.

제품은 `floor((id-1)/10000)`의 안정된 ID 구간으로 전부 순회한다. index는 실제 등재 가능한 제품이 있는 구간을 열거하며 49,000개 고정 잘림은 없다. 각 제품 파일은 최대10,000개이며 기존 `indexableProduct` SQL을 지킨다. 새 언어는 위와 같은 두 필드 준비 상태 및 현재 소개 보류 조건을 추가한다. 번역 본문 대신 짧은 준비 표식만 읽는다. 정적 시즌 목록은 기존 현재 시즌 및 종료500개/실제 순위가 있는 시즌 계약을 유지한다.

XML은 URL을 escape하며 HTML hreflang을 복제하지 않는다. 각 파일과 index는 50,000항목/비압축50MiB를 검사하며 초과 시 오류를 낸다. index의 전구간 목록만 서버에서10분간 담는다. 파일은 현재 원문/상태를 읽고10분 HTTP cache를 제공한다. 매우 먼 미래에 12,499개를 넘는 populated ID 구간이 생기면 index 분할 전략을 확장해야 한다. 현재 제품 전체를 누락시키는 truncate는 없다.

## 검색과 캐시

검색 보충은 UI locale에 의존하지 않는다. Hangul은 기존 한국어 경로를 사용한다. Mandarin 소프트웨어 표현이 분명한 Han 입력은 별도 중국어→영어 검색 키워드 지시문을 사용한다. kana, generic Han, 두 script가 섞인 불명확한 입력은 자동 번역하지 않는다. 기존 제품 색인과 사용자가 친 원문 검색은 유지한다. 추가 전용 색인이나 product-field 번역 지시문을 사용하지 않는다.

`queryTranslationKey(query, targetLocale='en')`에는 입력 언어, 목적 언어, 검색 정책 `search-keywords-v3`, 각 지시문 판, 필요한 한국어 용어표 판, 정규화 원문을 넣는다. 기존 `text_translations` 표와 credential/gateway를 재사용한다. 실패/키 부재 시 원문 검색 fallback이며, 기록은 기존 primary scope다. 정책 변경으로 기존 한국어 q2 캐시는 새 지시문 namespace에서 다시 채운다.

`next.config.ts`는 실제 네 언어 URL에 같은 `p-<slug>`/`lists` 태그를 붙인다. 기존 tag purge가 네 언어 HTML 및 RSC 경로에 함께 작동한다. locale 없는 제품/순위 데이터 캐시는 변경하지 않았다. 최종 locale 뷰를 새로 memoize하지 않아 별도 혼입 키를 만들지 않는다. 로그인·피드백·GitHub 계정 연결은 모든 언어에서 CDN no-store이고, 인증/nonce cookie와 검색 query도 명시적으로 no-store다. API/admin 정책은 유지한다.

## CI와 수정 파일

`scripts/public-i18n-contract.mjs` 및 `npm run check:i18n`을 quality CI의 기존 typecheck 다음에 추가했다. 등록 namespace별 출시 문자열이 비어 있지 않아야 하며 네 언어의 key와 named placeholder가 같아야 한다. catastrophe UI의 작은 `global-error.ts`/`globalError` slice만 정확한 support filename으로 허용하고 같은 검사를 한다. 다른 임의의 추가 catalog 파일은 거부한다.

전체 app의 page 경로를 확인하며 관리자와 parallel slot을 제외한 공개 page는 공유 `[locale]` 트리와 선언된 namespace inventory에 있어야 한다. route group 이름은 URL에서 제거하므로 `(content)` 이동에도 같다. 한국어 원문 README/댓글을 검색하지 않는다. auth/launch/policy namespace를 통합 담당자가 registry에 등록해야 한다.

bundle baseline은 기존 수치와10% 한도를 유지하고 route key만 `/[locale]`, `/[locale]/p/[slug]`, `/[locale]/launch`로 옮겼다. 기존 sitemap/discovery integration imports와 기존 cache/search-key 기대값만 변경했다. 새 테스트 suite는 추가하지 않았다.

수정 범위: 두 sitemap route 및 기존 sitemap 삭제, metadata/sitemap 서버 모듈, product translation readiness type/reader/eligibility extra, search translation 및 gateway의 중국어 keyword API, Next cache headers, CI script/workflow/package script, bundle route keys, 기존 관련 contract expectations, 이 문서다.

## 실행한 검증과 한계

- `npx next typegen`: 최종 실행 exit0, route type 생성 성공.
- `npx tsc --noEmit --incremental false`: 최종 실행 exit2. 기반 브랜치의 아직 빈 dictionary generic 타입, 이동 전 root/seasonfooter import를 쓰는 기존 테스트, 기존 rankings `PageProps`의 locale 누락이 남았다. 변경한 SEO/search/cache 모듈 자체의 오류는 보고되지 않았다. 전체 typecheck 성공으로 주장하지 않는다.
- `npm run check:i18n`: 최종 실행 exit1, `ko: catalog files differ from registered namespaces`. 이 중간 브랜치는 foundation의 `global-error.ts`와 auth/launch/policy 및 browse/detail 완료 카탈로그를 아직 받지 않았다. 앞선 실행도 빈 browse namespace에서 실패했다. release gate가 출시 미완성 구성을 거부한 결과다.
- `node --check scripts/public-i18n-contract.mjs`: exit0.
- 변경 TS/TSX/MJS 파일만 대상으로 실행한 `npx eslint ...`: exit0.
- `node --conditions=react-server --import tsx --input-type=module`의 임시 assertion 실행: exit0. 두 필드/빈 설명/영어 원문/unknown/stale/held readiness, reciprocal hreflang/x-default/self canonical, 기존 nofollow, Han 입력 및 목적 언어 cache 분리, XML escaping/50,000항목/50MiB/no-hreflang, 네 언어 CDN tags 및 account no-store를 확인했다. DB/HTTP/LLM 호출은 없다. 첫 시도는 Node TSX의 config default export wrapper 때문에 `headers is not a function`으로 실패했고 wrapper를 풀어 다시 실행해 통과했다.
- `git diff --check`: exit0.

이번 단계에서 unit/integration suite, build, 브라우저/E2E, 운영 응답 점검, migration/job, LLM 호출은 실행하지 않았다. 통합 root와 페이지/UI 완료 후 담당자가 final type/build/CI 및 읽기 응답을 확인한다. 운영에 쓰려면 앞 단계의 additive migration이 먼저 필요하지만 이 단계에는 추가 migration/credential 설정이 없다.

## 통합 후 다음 명령

```sh
npx next typegen
npx tsc --noEmit --incremental false
npm run check:i18n
npm run lint
npm run build
node scripts/bundle-size.mjs
git diff --check
```

페이지 metadata 호출부는 위 readiness reader/공통 helper를 연결하고, 통합 브랜치의 eligibility SQL/extra alias를 하나로 합친다. 최종 routing/root와 카탈로그 변경은 이 문서의 중간 검증 결과와 구분해 기록한다.
