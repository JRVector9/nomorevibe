# 관리자 페이지 전환 성능 검토

검토 기준: `8af25463` · 측정 2026-11-05 08:09–08:10 KST · Next.js 16.4.1.

실데이터 미리보기: http://gpu3090.tail02799e.ts.net:8789/admin/flow

HTML 보고서: http://gpu3090.tail02799e.ts.net:8788/performance/index.html

이번 작업은 읽기 전용 측정과 검토 보고다. 앱 코드·캐시 설정·운영 DB·운영 배포를 변경하지 않았다. 3개 서브에이전트가 브라우저 측정, 흐름/LLM/갱신 구조, 나머지 화면의 조회 구조를 나눠 검토했다.

## 판단과 권고

**우선순위는 불필요 조회 제거 → 핵심/보조 영역의 대기 분리 → 표시 데이터에 한정한 캐시와 갱신 조정이다.** 현재 화면과 작업 흐름을 유지하는 수정으로 시작할 수 있다. 전체 앱을 SPA나 새 API 계층으로 다시 만들거나 새 캐시 서비스를 도입할 필요는 현재 근거로 확인되지 않았다.

페이지 전환 자체는 빨랐고, 특정 화면의 실제 본문을 기다리는 시간이 길었다. 검수는 약 10.8–11.0초, 운영 홈은 약 2.8–5.5초였다. 요청함·콘텐츠 SNS·설정 수집 대표 화면은 약 0.34–0.37초였다. 모든 페이지에 같은 캐시를 추가하는 방식보다 검수와 운영 홈의 조회 경로부터 줄이는 편이 타당하다.

이미 async/Promise.all, 공통 loading, 일부 Suspense와 15/30/60초 캐시가 있다. 문제는 **병렬로 시작한 불필요 조회와 느린 보조 집계까지 모두 완료되어야 주요 본문을 반환하는 경계**에 있다. SQL별 시간·반환 행 수·캐시 hit율·pool 대기 시간은 계측하지 않았으므로, 아래 코드 구조가 각 지연에 몇 초씩 기여했는지는 아직 확정하지 않았다.

## 실제 측정

사이드 메뉴 7개를 같은 순서로 두 번 클릭했다. 기준은 실제 click 이벤트부터 각 화면의 주요 본문 selector가 확인될 때까지다. 숫자는 초이며, 캐시 적중을 보장하는 warm 측정이라는 뜻은 아니다.

| 대표 페이지 | 1회차 본문 | 2회차 본문 | 우선 판단 |
| --- | ---: | ---: | --- |
| 운영 홈 · 실시간 흐름 | 5.459 | 2.840 | 높은 우선순위 |
| 검수 · 기본 주소 `/admin/review` | 10.801 | 11.001 | 가장 먼저 개선 |
| 요청함 · 열린 요청 | 0.373 | 0.352 | 현재 대표 표본은 빠름 |
| 프로젝트 · 목록 | 1.939 | 1.357 | 조회 경로 정리 후 재측정 |
| LLM · 실시간 | 1.836 | 1.945 | 미사용 이력 분리 우선 |
| 콘텐츠 · SNS | 0.364 | 0.336 | 미사용 집계 정리, 큰 구조 변경 후순위 |
| 설정 · 수집 | 0.350 | 0.350 | 폼 조회 공유·보조 집계 분리 후보 |

측정은 사이드 메뉴의 기본 주소를 클릭했다. 검수는 `?tab=all`을 붙인 측정이 아니며 서버 필터의 기본값은 human이다(`PrototypeReviewQuery.ts:11–12`). 부수 확인으로 이 기본 URL의 UI는 all 탭을 활성화하는 불일치도 있다(`workspace-navigation.ts:126–130`). UI의 활성 탭 링크만으로 서버 조회 범위를 추정하지 않았으며, 후속 검증에는 기본 URL의 탭/필터 일치를 포함한다. 이번 검토에서 앱 동작은 수정하지 않았다.

URL 반영은 24–73ms였다. RSC 헤더는 측정 시작 후 약 0.1초 이내 도착했다. 헤더 시각은 Node 기준이고 click 시각은 브라우저 기준이므로 두 값을 정밀하게 빼서 서버 시간을 산출하지 않았다. URL 변경과 본문 준비는 별도 지표다.

전체 문서 GET 추가 표본은 다음과 같다. 이 둘은 같은 Node 타이머에서 측정했다.

| 전체 GET | 첫 응답 TTFB | 전체 응답 완료 |
| --- | ---: | ---: |
| 운영 홈 | 0.099초 | 4.194초 |
| 검수 | 0.067초 | 10.870초 |
| LLM | 0.075초 | 1.819초 |

현재 미리보기는 `next dev`, 원격 읽기 전용 운영 복제본, primary 경로 pool 2개, read 경로 기본 4개, SQL timeout 8초이며 Valkey 연결 설정은 없다. 운영의 실제 pool/캐시 상태를 조사한 결과가 아니다. 기존 프로세스 로컬 캐시는 작동할 수 있다. 브라우저는 같은 GPU 호스트에서 Tailscale 주소로 접속했으므로 사용자 기기까지의 원격 네트워크 지연은 측정하지 않았다. 미리보기에는 embedding/rerank health 주소도 없고 고급 probe는 읽기 전용 모드에서 제외하므로, 해당 연결이 있는 운영 화면의 추가 비용은 이번 표에 포함하지 않았다.

자동 갱신은 해당 측정 브라우저에서만 껐다. 클릭 14회와 전체 GET 3회를 순차 실행했고, 준비 요청은 표본에서 제외했다. 브라우저 오류·명시적 조회 실패·변경 POST·모델 probe는 0이었다. RSC 7건은 본문 확인 후 다음 이동에서 취소되어 완전한 stream 종료 시간은 미측정이다. 본문 준비 시각은 유지하되 이 7건의 전체 응답 완료를 추정하지 않았다. 개발 로그에 compile/render timing이 없어 그 분해와 production build 비교도 미실행이다. 두 표본으로 p95나 개선율을 계산하지 않았다.

[측정 집계 JSON](navigation-performance-measurements.json).

## 코드로 확인된 개선 후보

아래 구조는 소스로 확인했다. 행 수 상한은 코드상 최대값이고 이번 측정에서 실제로 그만큼 읽었다는 뜻이 아니다.

| 우선 | 현재 구조 | 최소 수정안 | 근거 |
| --- | --- | --- | --- |
| 1 | 검수 모든 탭이 설정→갈래 전수판정/overview→목록→관리 상태 순서로 기다린다. 갈래 집계는 최대 20,000후보를 1,000개씩 순차 조회·재판정한다. | 활성 필터에 필요한 membership만 신선하게 읽는다. 표시 counts와 닫힌 관리 패널은 주 목록 뒤의 독립 경계로 옮긴다. | `review/page.tsx:47–64`, `lib/crawl/admin-review.ts:271,316–350` |
| 1 | 갈래별 ID를 추가할 때 기존 배열 전체를 매 후보마다 복사한다. 한 버킷에 몰리면 누적 복사가 이차로 증가한다. | 로컬 버킷 배열을 한 번 만들고 push한다. 기존 결과와 순서를 보존하는 작은 CPU 변경이다. 실제 CPU 비용은 미측정이다. | `lib/crawl/admin-review.ts:346` |
| 1 | 기본 흐름·LLM이 쓰지 않는 24시간 완료 이력을 최대 50,001행 읽어 처리량 차트를 계산한다. 새 기본 화면은 throughput을 참조하지 않는다. | 핵심 repeatable-read snapshot을 유지하고 throughput만 옵션/고급 reader로 분리한다. 고급 차트의 상한·미확인 규칙은 유지한다. | `lib/operations/admin-models-repository.ts:61–79`, `models/LiveModels.tsx:110–112`, `flow/desk.ts:104` |
| 1 | 흐름 3탭 모두 conveyor·desk·controls·rank editor·reaction 5개를 기다린다. desk는 공유 조회 후 개인 away의 4 SELECT를 다시 기다린다. | 탭별 reader를 선택하고 편집을 실제 열 때 rank snapshot을 읽는다. 흐름 핵심과 부재/변경/장비 보조 패널을 분리한다. | `flow/page.tsx:54–70`, `flow/desk.ts:102–139` |
| 2 | LLM은 기존 Suspense 앞에서 계약/순위→설정/env/flag→text bindings를 기다린다. | 인증 뒤 각 데이터 slot에서 필요한 bootstrap을 수행해 핵심/보조 영역을 독립 스트리밍한다. 기존 30초 snapshot 캐시와 pending 재사용은 유지한다. | `models/page.tsx:78–103,150–161` |
| 2 | 프로젝트 상세 8섹션 모두 근거 전체·기본 프로젝트·갱신·이력·메이커를 공통 조회한다. 소개 번역·메모도 직렬이다. | 작은 공통 헤더 DTO와 섹션별 reader를 분리한다. 헤더에 필요한 메이커/충돌 요약은 유지한다. 독립 번역·메모는 병렬화한다. | `products/[slug]/page.tsx:67–75`, `lib/domain/evidence/admin.ts:121–197` |
| 2 | 새 랭킹 화면이 쓰지 않는 readiness와 최대 3종 preview 집계도 기다린다. SNS는 반환 summary를 쓰지 않아도 전역 summary를 계산한다. | 기존 전체 reader는 보존하고 새 화면에 얇은 reader/옵션을 적용한다. 공개 노출 판정에 필요한 값은 유지한다. | `lib/domain/ranking/view.ts:367–398`, `lib/social/admin.ts:132–151`, `content/PrototypeContentViews.tsx:19–50` |
| 3 | 요청함 선택 id 변경 시 동일 목록·count를 다시 읽는다. 설정 행도 값·메타·적용 상태 reader에서 중복 조회한다. | 목록 key와 선택 key를 분리하고 요청 범위의 같은 Promise/snapshot을 재사용한다. 통합 요청함의 전체 소스 정렬은 유지한다. | `requests/PrototypeRequestWorkspace.tsx:19–28`, `settings/PrototypeSettingsViews.tsx:24–26` |

흐름의 conveyor/desk가 모두 캐시 hit여도 away 4 + controls 2 + rank editor 2 + reactions 2의 직접 SELECT 10개가 남는다(배지 제외). reader 수와 실제 SQL 수, 실제 시간은 구분해야 한다. cold desk의 경보 fan-out 20개와 inbox 14업무 칸도 코드상 확장 경로이며, 항상 매 페이지에서 전부 기다리는 쿼리 수라는 뜻은 아니다.

추가 검토 후보는 품질 overview 후 목록의 직렬 대기, 번역 전역 집계 분리, 상세의 내림 요청·근거 업데이트 등 무제한 하위 목록의 상한, 랭킹/연동 설정의 얇은 DTO다. `productHistory` 자체는 이미 소스별/최종 결과 상한이 있다. 연동 목록은 100개를 읽어 25개만 표시하고 조회 SELECT가 `feedbackDatabaseWrite` 경로를 사용한다. read-only/primary 조회 계약을 명시적으로 분리하되 기존 변경 명령의 fence·deadline은 보존한다. 실제 lock 대기 발생 여부와 인덱스 효율은 미측정이다.

이미 적절한 부분도 있다. 프로젝트 목록의 quality/translations, 콘텐츠 3탭, 설정 4탭은 선택 분기를 먼저 한다. 프로젝트 filter counts는 한 SQL의 FILTER 집계이고 검수 enrichment는 배치 조회이므로 일반적인 행별 N+1로 진단하지 않는다. 같은 transaction 한 연결의 쿼리를 무조건 Promise.all로 바꾸지 않는다.

## 비동기 처리와 최소 구조

1. **필요한 조회만 시작한다.** 탭/section을 결정한 뒤 사용할 reader만 호출한다. ORM 쿼리는 함수 이름이 같다고 자동 중복 제거되지 않으므로, 읽기 전용 설정·작업·순위 DTO의 동일 요청을 같은 Promise로 재사용한다. 인증 확인은 DB 병목이 아니다.
2. **핵심과 보조를 독립해서 보낸다.** 인증 확인 뒤 주요 흐름/목록과 부재/이력/고급 패널을 형제 Suspense 경계로 분리한다. 현재 PrototypeFlow는 client props를 한 덩어리로 받으므로, await 뒤에 loading을 더 붙이는 것으로는 해결되지 않는다. 패널 단위 Server wrapper와 기존 client 제어 영역 정도로 나누는 것이 최소 범위다. 같은 UI·선택 상태·폼을 유지한다.
3. **기존 로딩과 상태를 보존한다.** `admin/loading.tsx`는 이미 있고 LLM도 일부 스트리밍한다. layout/page는 병렬로 실행되어 layout 시간을 페이지 시간에 순차 합산하면 안 된다. 최초 shell은 자신의 배지 조회를 기다리지만 이후 Link 이동은 공통 layout을 재사용한다. 배지 GET은 별도 요청이다. [Next.js loading 문서](https://nextjs.org/docs/app/api-reference/file-conventions/loading).

먼저 production build의 동일 조건에서 조회별 시간·행 수·pool wait·cache hit/miss를 짧게 계측한다. 개선 전후는 클릭 반응, 핵심 표시, 전체 완료를 각각 비교한다. loading만 빨라지고 핵심 데이터 대기가 그대로면 실제 성능 개선으로 기록하지 않는다.

## 캐시와 갱신 기준

**새 캐시는 표시용 DTO에 한정한다. 기존 conveyor/desk 15초, overview/inbox 30초, hourly/신호 60초 캐시를 먼저 재사용한다.** sharedLoader는 TTL 만료 때 새 값을 기다리므로 SWR이 아니다. 현재 sharedStale만 지난 값/null을 먼저 반환한다. 캐시가 없는 최초 요청과 만료 직후의 느린 조회도 줄여야 한다.

| 데이터 | 표시 캐시 검토안 | 최신 상태가 필요한 경계 |
| --- | --- | --- |
| 수집 흐름 | 기존 15초 우선 유지. 중첩 집계의 원본 시각도 표시 | 작업 제어의 현재 판·허용 상태·CSRF는 요청별로 읽고 제출 때 원본 재확인 |
| LLM 실행·접수 | 미사용 이력 제거 우선. 추가 공유 표시 DTO는 5–10초 검토 | epoch/revision·점유/해제 명령·안전 판정은 캐시로 결정하지 않음 |
| 검수 | 표시 counts/갈래 5–15초, 무거운 표시 통계 15–30초 검토 | 활성 필터 membership·선택 원문·결정 권한·결정 직후 목록/CSV 일치 |
| 요청함 | 개인정보 없는 counts/이력 5–15초 검토 | 문의 원문·처리 version은 요청 범위 재사용 우선, 제출 시 최신 CAS |
| 프로젝트·품질·번역 | 목록/근거 DTO 15–30초, 필터/전역 집계 30–60초 검토 | 공개/내림·품질 판정·번역 sourceHash/version은 최신 원본 |
| 콘텐츠·설정 | 목록 15–30초, 랭킹 metrics 30–60초 검토. 설정 행은 요청 범위 공유 | 공개/숨김·예약 정책·설정 폼 CAS·소유권·비밀·권한 검증은 공유 캐시 제외 |

위 신규 TTL은 초기 검토값이며 검증된 적용값이 아니다. 개인 away는 공유 캐시에 넣지 않는다. 실패를 0으로 저장하거나 갱신 응답 시각을 원본 관측 시각으로 바꾸지 않는다. 복제본 전용 집계의 미확인/보류와 primary 비전환 정책도 유지한다.

검수의 기존 `sharedHumanQueueOverview` 30초 캐시 우회는 결정 직후 일치를 위한 의도된 계약이다(`lib/operations/shared-reads.ts:13`). overview.ids/causes.ids가 목록 membership과 CSV에 쓰이므로 단순히 이 캐시로 교체하지 않는다. needOverview는 heldStage, human 탭, 해당 AI/second 필터 조건이며 needCauses는 detailable&&cause다(`review/PrototypeReviewQuery.ts:23–36`). 표시 count와 선택 membership을 분리하는 것이 선행 조건이다.

새 공유 key에는 필요한 site/read-source·release/schema·정규화한 필터·설정 판을 명시하고 key 수를 제한한다. 같은 요청의 Promise 재사용은 요청 사이에 값을 보관하는 공유 캐시와 구분한다.

`revalidatePath`와 `router.refresh`는 직접 만든 Map/Valkey key를 자동으로 지우지 않는다. 현재 SharedStore는 get/set만 제공한다. 신규 도메인 캐시에는 쓰기 성공 후 관련 key 무효화 또는 revision 변경, 저장 직후 재조회, 다른 웹과 워커 변경을 고려한 TTL이 함께 필요하다. TTL만 늘려 명령 상태를 늦추지 않는다. [router.refresh 공식 동작](https://nextjs.org/docs/app/api-reference/functions/use-router).

화면 갱신은 flow 15초, review 30초/idle60초, 나머지 대부분 15초/idle15초다. 자동 요청은 이미 처리 중 중복을 막고 60초 뒤 1회 재시도만 한다. 수동 갱신·탐색과의 공통 pending guard는 추가 검토할 수 있다. 실시간 flow/LLM은 현재 주기를 유지하고 과거 기록 30–60초, 설정은 변경/수동 또는 60초 갱신을 검토한다. 입력·미저장·확인창·숨김 탭 중단 규칙은 유지한다.

15초 polling + 15초 TTL을 모든 값의 최대 지연 15초라고 해석하면 안 된다. 보이는 값의 나이는 polling+cache age+조회시간+복제지연의 영향을 받고, 내부 overview/hourly는 이미 30/60초다. 각 값의 실제 기준 시각을 유지해야 한다.

## 적용 방법 비교

| 방법 | 이번 판단 |
| --- | --- |
| 불필요 조회 제거·요청 중복 제거 | 가장 먼저 적용할 작은 변경. 최초·만료 요청 모두 줄일 수 있음 |
| 패널별 Suspense | 핵심 데이터를 먼저 보여주는 최소 구조 변경. SQL 총량 감소와 별도로 검증 |
| 기존 Valkey/로컬 표시 캐시 재사용 | 유효. 운영 연결 상태와 hit율을 먼저 확인하고 무효화 계약 보완 |
| 표시 집계 SWR | 제한적으로 검토. 오래된 값·실패·원본 시각을 명확히 유지 |
| 모든 링크 prefetch 켜기 | 제외. 동적 무거운 조회가 클릭 전에 몰릴 수 있음. 조회 정리 후 가벼운 목적지의 hover/focus 의도 기반으로 제한 검토. 개발 자동 prefetch는 운영 동작과 다름. [공식 prefetch 문서](https://nextjs.org/docs/app/guides/prefetching) |
| 전체 페이지/HTML/RSC 공유 캐시 | 제외. 세션·편집 판·원문이 섞이는 화면 전체를 저장하지 않음 |
| 전역 Cache Components 전환·새 SWR/Query 라이브러리·새 서비스 | 현재 최소 수정안에 포함하지 않음. 설치 버전의 기존 mode와 캐시 계층으로 시작 |
| DB pool 확대·인덱스/스키마 변경 | 원인별 계측 후 별도 판단. 운영 host budget과 worker 용량을 보존하며 추측으로 늘리지 않음 |

설치본의 Next 로컬 문서를 기준으로 확인했다. 현재 cacheComponents는 켜져 있지 않다. 새로운 캐시 지시어를 넣기 위한 앱 전체 전환은 범위가 크다. Next는 요청 cookies/headers를 캐시 함수 안에서 읽지 않도록 안내한다. [공식 캐시 API 제약](https://nextjs.org/docs/app/api-reference/functions/unstable_cache).

## 후속 PR 계획과 검증

아래는 실행한 변경이 아니라 제안이다. 기존 관리자 4개 PR의 UI와 실데이터·보호 동작을 기준으로 한다.

| 단계 | 범위 | 완료 판단 |
| --- | --- | --- |
| 성능 PR 1 | 미사용 throughput·랭킹 preview·SNS summary 분리, 검수 필요 필터만 선조회, 갈래 배열 복사 제거, 상세 section reader 선별 | 동일 목록/CSV·정렬·판정 결과, 고급 차트 보존. reader별 시간·조회 수/행 수 전후 확인 |
| 성능 PR 2 | 주요 흐름/목록과 보조/개인/고급 패널의 Server 경계 분리, 동일 요청 snapshot 재사용 | 핵심 표시 시간이 실제로 줄고 느린 보조 실패가 핵심을 막지 않음. 선택/입력/자동 갱신 계약 유지 |
| 성능 PR 3 | 표시 캐시·명시적 무효화·관측 시각, 탭 목적별 갱신·탐색 pending 조정 | 저장 직후 일치, TTL 만료/동시 요청/장애/복제지연/다른 웹에서도 결과 보존. stale가 최신 판정으로 쓰이지 않음 |

PR별 변경 회귀·정적 검사만 실행하고, 전체 unit·DB 통합 검사는 남은 개발 뒤 통합 단계에서 한 번 수행하는 저장소 정책을 유지한다. production build의 동일 조건에서 최초/재방문/만료를 나눠 비교하고 충분한 표본을 얻은 뒤 p95를 보고한다. UX 검토 목표는 클릭 확인 100ms, 핵심 표시 p95 2초 이내다. 현재 실측 달성치나 보장으로 제시하지 않는다. 추가 API·새 상태 저장소·DB 스키마 개편은 이 검증으로 필요가 확인될 때만 별도로 검토한다.

## 근거 위치

모든 코드 위치는 `8af25463` 기준이다. [고정 소스 트리](https://github.com/JRVector9/nomorevibe/tree/8af254636940219eb8abaf2d3192cd92ef3abb97).

- 공통: `app/(operator)/admin/{layout.tsx:12–13,AdminShell.tsx:33–47,live-refresh.ts:14–27,103–129,loading.tsx:10}`, `lib/operations/shared-cache.ts:57–83,117–138`, `lib/cache/shared.ts:15–20,28`, `lib/db/pool.ts:44–69`.
- 흐름: `app/(operator)/admin/flow/{page.tsx:54–70,desk.ts:102–139}`, `lib/operations/{conveyor.ts:29,60–72,shared-reads.ts:13–22,admin-models-repository.ts:61–79}`.
- 검수: `app/(operator)/admin/review/{page.tsx:47–64,PrototypeReviewQuery.ts:23–36}`, `lib/crawl/admin-review.ts:271,316–350,587–624`.
- 프로젝트: `app/(operator)/admin/products/{page.tsx:51–79,[slug]/page.tsx:67–75}`, `lib/domain/evidence/admin.ts:121–197`.
- 콘텐츠·설정: `app/(operator)/admin/content/PrototypeContentViews.tsx:19–50`, `lib/domain/ranking/view.ts:367–398`, `lib/social/admin.ts:132–151`, `app/(operator)/admin/settings/PrototypeSettingsViews.tsx:24–35`.

실제 운영 항목·원문·개인정보·연결 문자열·인증 값·개별 DOM/스크린샷은 보고서에 포함하지 않았다. 실제 개선 코드를 적용하거나 운영에 배포했다고 기록하지 않는다.
