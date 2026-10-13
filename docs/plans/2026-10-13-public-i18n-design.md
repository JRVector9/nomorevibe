# 공개 페이지 다국어 설계 — 한국어·영어·중국어 간체·번체

2026-10-13. 설계 및 PR 제안이다. 이 문서 작성으로 언어 페이지나 번역 워커를 배포한 것은 아니다. 사용자는 중국어 간체와 번체를 모두 지원하라고 지정했다. 기존 한국어 주소와 제품 데이터는 유지한다.

## 목표와 언어 계약

페이지를 언어별로 복사하지 않는다. 공개 페이지 구현 하나와 공통 번역 카탈로그를 네 언어가 사용한다. 새 페이지를 추가할 때 페이지 구현·번역 키·번역 문구를 추가하면 네 언어 주소가 같은 구현으로 열린다. 새 언어는 locale 등록과 카탈로그 추가로 확장한다. 제품·카테고리·순위·관측 회차의 식별자는 언어와 독립적이다.

| 언어 | locale / HTML lang / hreflang | 홈 | 같은 상세 페이지 | 선택기 표기 |
| --- | --- | --- | --- | --- |
| 한국어 | ko | / | /p/manimgx | 한국어 |
| 영어 | en | /en | /en/p/manimgx | English |
| 중국어 간체 | zh-Hans | /zh-Hans | /zh-Hans/p/manimgx | 中文（简体） |
| 중국어 번체 | zh-Hant | /zh-Hant | /zh-Hant/p/manimgx | 中文（繁體） |

`zh-Hans`와 `zh-Hant`는 국가가 아닌 문자 체계 기준이다. 번체를 대만·홍콩 공통 첫 버전으로 제공하고 지역별 용어 차이가 필요할 때 별도 locale을 추가한다. 두 중국어 카탈로그는 따로 검수한다. 단순 문자 치환만으로 번체 번역 완료를 판정하지 않는다. 브랜드·제품명·slug·GitHub 저장소 주소·SPDX 라이선스 식별자를 번역하지 않는다.

한국어는 기존 비접두사 URL을 canonical로 유지한다. 외부 `/ko/...` 접근은 비접두사 한국어 주소로 정규화하며, 한국어 요청은 내부적으로 `/ko/...` 라우트에 rewrite한다. 명시적인 언어 URL을 기준으로 응답한다. 초기 버전은 브라우저 언어에 따른 강제 redirect 없이 선택기를 제공한다. 같은 URL에 언어별 HTML을 번갈아 저장하는 방식은 사용하지 않는다.

## 현재 코드에서 확인한 전환 지점

| 현재 위치 | 현재 동작 | 변경 방향 |
| --- | --- | --- |
| app/layout.tsx | html lang=ko, 한국어 공통 셸·metadata | locale를 갖는 공개 root layout과 공통 셸 |
| app/page.tsx, app/c/[category]/page.tsx | 공유 목록, 한국어 제목·필터 설명 | 공통 browse 결과 모델 + locale 문구 |
| components/BrowseFilters.tsx, home/browse-state.ts | 탭·필터·숫자·href | 기준 확정 후 키별 번역, localePath |
| components/ProductTagline.tsx | taglineKo를 모든 화면에서 우선 표시 | 요청 locale의 유효 번역 선택 |
| lib/domain/products/korean-tagline.ts, korean-taglines.ts | 원문과 일치하는 한국어 한 줄만 읽기·저장 | 원문 버전 검증을 다국어 콘텐츠에도 적용 |
| lib/format/time.ts, number.ts | 한국어 날짜·상대시각과 공통 숫자 | locale-aware 표시, 집계 시간대 KST 유지 |
| lib/copy/share.ts, brand.ts | ko_KR·한국어 설명 | locale별 SEO·OG 문구 |
| proxy.ts | 관리자 인증 전용 matcher | 관리자 차단 분기를 보존하고 공개 locale 분기 추가 |
| next.config.ts, public-reads.ts | 한국어 경로의 CDN 태그, 공통 데이터 캐시 | 다국어 HTML 경로·무효화 및 콘텐츠 캐시 키 |
| app/sitemap.ts | 상세 최대49,000개를 한 파일에 싣기 | 언어별 색인 가능 주소 집계와 sitemap 분할 |
| app/@seasonfooter, OnlyOnHome | 루트 홈 여부에 의존 | locale를 제거한 논리 경로로 판별 |

## 공유 페이지와 라우팅

설치된 Next 16.3.8 국제화·root layout·route groups 문서를 기준으로 공개 페이지 전체를 한 locale 트리로 옮긴다. 아래는 목표 구조이며 기존 제품 코드를 네 벌 만드는 구조가 아니다.

```text
app/
  layout.tsx            # 단일 HTML root: 검증된 요청 locale로 html lang
  (public)/[locale]/
    layout.tsx          # locale 검증·선택 문구 provider; (content)에 공통 셸
    page.tsx            # 기존 홈을 한 번만 구현
    c/[category]/page.tsx
    p/[slug]/page.tsx
    p/[slug]/github/page.tsx
    rising/page.tsx
    popular/page.tsx
    rankings/[key]/page.tsx
    login/page.tsx
    feedback/[id]/page.tsx
    launch/page.tsx
    policy/page.tsx
    @seasonfooter/...   # page/default 계약 보존
    not-found.tsx
    error.tsx
  (operator)/
    layout.tsx          # 관리자용 inner layout: 기존 한국어·인증 유지
    admin/...           # 기존 /admin URL·인증·허용목록 유지
  api/...               # 기존 API·OAuth·웹훅 계약 유지
  go/[slug]/route.ts    # 기존 외부 방문·계측 주소 유지
  badge/[slug]/route.ts
  feed.xml/route.ts
  install.sh/route.ts
  skill.md/route.ts
  robots.ts
  sitemap 관련 라우트

lib/i18n/
  locales.ts            # locale 목록·표시명·기본언어·Intl/OG 설정
  routing.ts            # localePath / stripLocale / switchLocale
  dictionary.ts         # 서버에서 요청 언어·namespace만 읽기
  format.ts             # locale-aware 숫자·날짜·상대시각
  metadata.ts           # canonical / alternates / OG
messages/
  ko/{common,browse,detail,auth,policy,...}.ts
  en/{...}.ts
  zh-Hans/{...}.ts
  zh-Hant/{...}.ts
```

`app/layout.tsx`만 HTML root로 사용하고 공개·관리자는 각각 inner layout을 둔다. 초기 다중 root 설계는 설치된 Next16.3.8의 explicit notFound 문제를 실제 빌드/응답과 기존 baseline에서 확인한 뒤 단일 root로 조정했다. proxy는 모든 처리 분기에서 검증한 요청 locale header를 덮어쓰고 root는 그 값으로 html lang을 정한다. 공개 provider는 URL의 [locale]를 다시 검증한다. 언어 변경은 일반 링크 이동으로 처리해 root lang와 metadata가 확실히 바뀌게 한다.

공개 locale 검증은 레이아웃·metadata·URL helper에서 같은 등록 목록을 쓴다. 관리자 인증 분기는 관리자 요청에서만 실행하고, 비밀키가 없을 때 차단하는 기존 동작과 `/admin/login` 예외를 유지한다. `/api`, `/admin`, `/_next`, 파일·이미지, OAuth callback, 웹훅, `/go`, `/badge`, feed·sitemap·robots·설치 스크립트는 locale rewrite에서 제외한다. 접두사를 붙인 `/en/admin`, `/zh-Hant/api/...`를 공개 트리를 통해 관리자/API 별칭으로 열지 않는다.

모든 공개 링크는 `localePath(locale, logicalPath)`를 사용한다. 언어 선택은 현재 제품 slug와 `sort`, category, `ai`, `q`, `shown`, `cycle`, hash를 유지한다. URL query의 정렬 값·카테고리 key는 번역하지 않는다. API 호출은 기존 `/api/...`를 그대로 사용한다. 로그인 returnTo는 same-origin의 허용된 공개 locale 경로인지 기존 검증에 맞춰 검증하고, 인증 복귀 후 같은 언어·제품·댓글 작성 의도를 복원한다. API는 locale별 문장을 반환하기보다 기존 안정적인 오류 코드와 상태를 유지하고 UI에서 번역한다.

root layout 전환 PR에서는 `/`, 한국어 내부 rewrite, 네 언어 상세, invalid locale, 존재하지 않는 제품/경로의 404·noindex·전체 오류 화면, seasonfooter의 hard/soft 이동을 먼저 검증한다. 기존 슬롯에 catch-all을 넣어 404 셸이 깨졌던 이력이 있으므로 그 접근을 반복하지 않는다. `global-not-found`는 현재 설치 문서에서 experimental이며 이 설계만으로 활성화를 확정하지 않는다. 공개 missing-route 처리와 root layout 전환의 빌드/응답 상태가 확인되기 전 후속 페이지 이동을 진행하지 않는다.

단일 HTML root 구조에서는 `next/root-params`에 locale root parameter가 등록되지 않으므로 Server Component는 검증된 요청 locale helper를 사용한다. Client Component·Server Action·Route Handler는 명시적 locale 전달/검증을 사용한다. locale를 전역 변경 가능한 변수로 두지 않는다.

단일 root에서 unmatched 주소는 네 언어의 셸·진짜404·noindex·lang을 확인했다. 명시적 invalid category/product의 notFound는 기존 baseline에서도 빈 `__next_error__` 문서를 반환한다. 상태404/noindex는 지키지만 해당 응답의 셸·lang은 현재 프레임워크 한계로 남는다. 이 한계는 정상404 성공으로 보고하지 않으며 상태200 우회나 proxy DB 조회를 추가하지 않는다.

## 문구를 한 번에 관리하는 계약

기본 한국어 카탈로그가 키·namespace·치환 인자의 타입을 정의하고 다른 카탈로그는 같은 구조를 만족해야 한다. 영어·간체·번체 값은 문자열 literal 값이 같아야 하는 타입이 아니라 동일한 키 구조와 인자 계약을 만족하는 타입으로 검사한다. UI에서 `browse.sort.starGrowth8h`, `detail.updates.viewAll`, `auth.github.continue`처럼 의미 키를 사용한다. 한국어 원문을 키로 쓰지 않는다.

서버에서 해당 언어의 필요한 namespace만 읽는다. Client Component에는 해당 화면의 문구와 locale만 전달하며 모든 언어 카탈로그를 번들에 싣지 않는다. 첫 버전은 구조화된 카탈로그와 내장 Intl을 사용한다. 숫자와 문장을 연결해 각 언어의 어순을 고정하지 않고 `{count}`, `{hours}` 등 타입이 있는 치환 인자를 사용한다. 영어 단복수 등이 필요한 문구는 명시적 형태와 Intl.PluralRules로 처리한다. 모든 메시지를 처리하는 자체 범용 번역 엔진은 만들지 않는다.

누락 키·잘못된 치환 인자는 CI에서 실패한다. 사용자에게 번역 key를 그대로 출력하지 않는다. 출시 locale의 기본 UI가 완성되지 않았으면 그 locale 출시를 막는다. 동적 제품 콘텐츠의 아직 없는 번역은 아래 원문 fallback 계약으로 처리한다.

새 페이지 작업자는 공유 page와 namespace 키를 추가하고 네 카탈로그의 문구를 채운다. 새 언어 작업자는 locales 등록과 동일 키 카탈로그를 추가한다. 페이지별 언어 조건문이나 언어마다의 route wrapper는 추가하지 않는다. CI의 공개 페이지 목록과 카탈로그 검사로 새 공개 페이지가 번역 규칙을 빠뜨렸는지 확인한다.

## 제품 콘텐츠와 간체·번체 번역

고정 UI 문구와 수만 개 제품의 설명은 관리 방식이 다르다. 제품명·스타·분류·관측 회차·라이선스는 공통 제품 모델에서 읽는다. 소개·설명만 원문과 locale별 번역을 연결한다. 현재 한국어 테이블의 `source_tagline = products.tagline` 조건은 원문 변경 시 오래된 번역을 숨기는 좋은 기존 계약이므로 보존한다.

권장 저장 구조는 `product_translations` 한 테이블이다. 언어마다 `taglineEn`, `taglineZhHans`, `taglineZhHant` 열을 계속 추가하지 않는다.

| 항목 | 계약 |
| --- | --- |
| product_id, locale, field | 논리 기본키. 초기 field는 tagline / description만 허용 |
| source_hash | 원문·제품명·필드·번역 규칙의 버전, 현재 원문 버전과 같을 때만 노출 |
| text, source_locale | 번역값과 원문 언어. 실패 시 text는 비움 |
| status | pending / ready / failed / reviewed, 코드로 검증하는 좁은 enum |
| provenance, model | maker/editor/machine 등 번역 출처와 생성 모델 |
| attempts, retry_at, error_code | 기존 text 역할의 제한된 재시도·운영 확인 |
| created_at, updated_at | 상태 및 번역 갱신 시각 |

초기에는 기존 한국어 읽기 경로를 유지하고 신규 번역 테이블에 영어·간체·번체를 넣는다. 한국어 이관은 기존 데이터를 검증하여 옮기고 읽기 결과를 대조한 뒤 별도 후속으로 한다. 두 한국어 번역 writer를 동시에 운영하지 않는다. 필요할 때 비어 있는 locale/field 버전만 채우며, 원문 언어와 요청 언어가 같으면 원문을 그대로 사용한다.

간체와 번체는 각각 준비 상태·원문 버전을 가진다. 공통 원문에서 언어별 용어로 번역하고 숫자·제품명·기능 근거를 검수한다. 문자 변환을 초안 작성에 쓰더라도 ready 확정에는 별도 검수를 거친다. 한국어 전용 검사 함수는 중국어 한자를 거부하므로 그대로 재사용하지 않고 길이·markup·숫자·제품명 보존의 공통 검사와 locale별 언어 검사를 분리한다.

표시 우선순위는 **요청 locale의 현재 원문에 맞는 ready/reviewed 번역 → 같은 언어 원문 → 원문 및 해당 언어의 ‘번역 준비 중’ 안내**다. 영어·중국어 화면에 한국어 소개를 무조건 우선하는 현재 ProductTagline 동작을 남기지 않는다. 원문에 적절한 lang를 붙이며 확실하지 않은 원문 언어를 영어로 단정하지 않는다. 상세는 기존 원문 보기 기능을 유지한다.

GET에서 LLM을 호출하지 않는다. 기존 text 역할의 lease·예산·재시도를 이용하고 `(product, locale, field, source_hash)`로 작업 중복을 막는다. 저장 직전 현재 원문 버전을 다시 비교해 오래된 작업이 새 번역을 덮어쓰지 않게 한다. 초기에는 노출 우선 대상의 소개와 상세 설명부터 처리하며 한 번에 전체 프로젝트×세 언어를 번역하지 않는다. 설명이 바뀌면 해당 버전만 다시 번역한다. 소개 검수의 사용자 중단 상태를 번역 작업과 혼동하거나 재개하지 않는다. 번역이 없어도 순위 대상이나 필터 수에서 제품을 빼지 않는다.

README, 댓글, GitHub 릴리스 원문은 원본을 보존한다. 주변 UI와 작성/전달 상태는 번역하지만 사용자가 쓴 댓글이나 저장소의 본문을 자동으로 바꿔 게시하지 않는다. 본문 번역이 필요할 때는 별도 ‘번역 보기’ 범위로 추가한다. 라이선스 설명 문구는 카탈로그에서 관리하되 SPDX 값·원문 링크·수집 근거는 공통이다.

## 날짜·검색·캐시·SEO

표시 언어만 locale에 맞게 바꾼다. 8시간 회차·이번 주·시즌 경계는 모든 언어에서 같은 Asia/Seoul 기준이다. 데이터 query에 브라우저 시간대를 섞지 않는다. 날짜는 KST를 명시하고 숫자는 정확한 전체 값을 천 단위 구분으로 표시한다. 중국어의 ‘万’ 등 축약값을 필터의 정확한 개수 대신 쓰지 않는다. 서버의 now를 재사용해 상대시각 hydration 차이를 막는다. 간체·번체를 지원하는 시스템 글꼴 fallback을 공통 font stack에 두고, 영어 긴 문구·CJK 줄바꿈·모바일 버튼 폭을 확인한다. 언어마다 새로운 글꼴 묶음을 모두 내려받게 하지 않는다.

검색은 locale에 관계없이 동일 검색 식별자·제품 색인과 원문을 기본으로 사용한다. 기존 한국어 검색 보충은 입력 언어를 판별해 유지한다. 중국어 간체/번체 입력은 이미 있는 검색어 번역 캐시를 원문·목적언어·버전으로 일반화하는 후속 범위로 두고, 언어별 설명까지 검색해야 할 때 공용 번역 테이블에 목적에 맞는 색인을 추가한다. 단순히 UI locale만 보고 영어 사용자의 중국어 검색을 번역하지 않는 식으로 제한하지 않는다.

순위·숫자·제품 공통 데이터는 locale 없이 공유한다. 번역 콘텐츠와 최종 렌더 모델의 캐시에는 locale·source_hash·정책 버전을 포함한다. CDN HTML은 실제 locale URL별로 구분한다. 제품 변경·내림 시 `p-<slug>`와 목록 태그가 네 언어 경로를 함께 무효화해야 한다. 인증 상태·댓글 초안은 공용 HTML/번역 캐시에 넣지 않는다. 기존 login/API의 no-store와 인증 cookie 예외, 검색 요청의 비캐시 정책을 지킨다.

각 언어 페이지의 canonical은 자기 언어 URL이다. 번역이 완료된 대응 페이지끼리 동일한 상호 hreflang 목록(ko/en/zh-Hans/zh-Hant)을 낸다. 기본 한국어 대응 주소를 x-default로 정한다. 영어·중국어 canonical을 한국어로 일괄 지정하지 않는다. 고정 UI만 번역하고 주 설명이 다른 언어 원문인 상세는 ‘완전 번역됨’으로 취급하지 않는다. 해당 상세는 기존 색인 조건에 번역 준비 조건을 추가해 초기 noindex로 제공하고, 준비된 locale만 alternates/sitemap에 싣는다. README·사용자 댓글 같은 원문 부가 콘텐츠는 이 준비 판정의 필수 번역 대상에서 제외한다.

현재 sitemap의 최대49,000 제품을 네 언어로 단순 복제하면 약196,000 URL이 된다. 실제 색인 가능 제품 수와는 다른 상한 계산이다. 단일 sitemap의 50,000 URL/비압축50MB 한도를 넘지 않도록 언어별·제품 구간별 파일과 sitemap index를 사용한다. 49,000개 고정 truncate로 향후 프로젝트를 누락시키지 않고 안정된 ID 구간/페이지로 전부 순회한다. `/sitemap.xml` 호환 진입점을 index로 유지하며 robots에는 그 index를 등록한다. hreflang은 공통 metadata helper에서 HTML에 관리하고 sitemap에 동일한 alternate 로직을 또 복제하지 않는다.

## PR 단위 제안

필터의 의미부터 [별도 검토 보고서](../operations/2026-10-13-browse-filter-audit.md)대로 확정한다. 번역 문구의 기반이므로 실제 기준과 이름을 먼저 맞춘다. 아래는 구현 전 계획이며 PR 번호는 논리 작업 번호다.

| PR | 작업 | 주요 범위 | 완료 기준 |
| --- | --- | --- | --- |
| I18N-01 | locale·공통 경로·root layout 기반 | lib/i18n, 공개 route 이동, proxy, 공통 layout/선택기, 기본 카탈로그 | 네 언어 진입, 기존 한국어 URL, 관리자 인증, API/OAuth 제외, 404·슬롯·직접/클라이언트 이동 정상 |
| I18N-02 | 전체 공개 UI 번역 | 홈/분야/급상승/인기/랭킹/상세, 로그인/피드백/등록/정책, 오류·접근성 문구, format | 네 언어의 동일 키·인자, 동일 제품·순위·개수, locale 링크/날짜, 간체·번체 검수 |
| I18N-03 | 동적 제품 콘텐츠 | migration, 번역 repository/view model, text 역할 큐/예산, ProductTagline | 원문 변경 시 오래된 번역 숨김, 영어 원문 재사용, 간체·번체 준비 독립, 조회 시 LLM 호출0, 중단 검수 보존 |
| I18N-04 | 검색·캐시·SEO와 출시 점검 | locale-aware metadata·OG·sitemap 분할, 경로별 cache tags, 검색 보충, CI 카탈로그 검사 | 언어 간 캐시 혼입0, reciprocal hreflang, 기존 noindex·차단 유지, sitemap 한도/전체 순회, 인증 복귀 언어 유지 |

I18N-01은 routing·layout 공통 파일 변경 소유자가 하나여야 한다. 이후 I18N-02의 namespace별 문구·화면과 I18N-03의 DB/text 역할은 소유 범위를 나눌 수 있다. metadata/cache 변경은 route 기반 안정 후 I18N-04에서 통합한다. 이 문서는 병렬 구현을 시작한 상태가 아니다.

운영 공개는 네 언어 UI가 준비된 뒤 원문 fallback 표시·인증 복귀·모바일·언어 변경을 사용자가 확인하고 진행한다. 자동 검사는 해당 구현 PR의 타입·빌드와 계약에 필요한 기존/추가 검사로 제한하며 현재 설계 단계에서 제품 테스트 성공을 주장하지 않는다.

## 근거

- 설치본 `node_modules/next/dist/docs/01-app/02-guides/internationalization.md` 및 layout/route-groups/not-found 문서. 설치 버전16.3.8 규약을 구현 시 다시 확인한다.
- [Next.js 국제화 공식 가이드](https://nextjs.org/docs/app/guides/internationalization): 공유 locale route·서버 dictionary 패턴. 공개/관리자 분리와 한국어 URL 보존은 현재 서비스 계약에 맞춘 설계 판단이다.
- [Google 지역·언어 버전 공식 문서](https://developers.google.com/search/docs/specialty/international/localized-versions): zh-Hans/zh-Hant, 대응 버전의 상호 링크와 main content 번역 여부. 번역 미완료 상세의 초기 noindex는 이 서비스의 출시 정책 제안이다.
- [Google sitemap 공식 문서](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap): 파일 크기·URL 수 한도와 분할.
