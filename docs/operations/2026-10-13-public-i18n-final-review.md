# 네 언어 공개 페이지 통합 검토 — 2026-10-13

새 탐색 탭의 한국어 운영 배포는 완료했다. 다국어 코드는 공유 페이지 트리로 통합했으며 언어 운영 공개·migration·번역 모델 호출은 아직 하지 않았다. 사용자 직접 기능 확인 이후 공개하는 설계 조건을 유지한다.

## 설계 작업별 결과

| 단위 | 구현 결과 | 운영 상태 |
| --- | --- | --- |
| FILTER01/02 | 칩 숫자·결과·페이지 분할의 자격 통일, 8시간 스타 급상승/최근 등록/GitHub 스타 많은 순 고정 | PR403/404 병합 및 운영 웹 배포 완료 |
| I18N01 | 단일 HTML root, 공통 공개 locale tree, query/hash 언어 선택, 관리자·API·OAuth·웹훅 경로 보존 | 구현·통합 완료; 언어 배포 전 |
| I18N02 | 홈·분야·급상승·인기·시즌·상세·로그인·댓글·등록·정책·오류·접근성 문구 네 언어 | 8개 namespace/11개 페이지, 상세 405키씩 완료 |
| I18N03 | source hash 기반 tagline/description ledger, 현재 버전만 표시, text 역할의 제한된 수요 번역 | additive0075 적용 및 web/text/scheduler 교체 전 |
| I18N04 | self canonical/준비된 reciprocal hreflang, ID 구간 sitemap, 네 언어 cache tags, 입력 기준 중국어 검색 보충, CI gate | 구현·통합 완료; 최종 CI 확인 중 |

ko는 기존 비접두사 주소다. 영어 `/en`, 간체 `/zh-Hans`, 번체 `/zh-Hant`는 동일한 페이지 코드를 사용한다. 간체·번체는 각각 작성한 카탈로그이며 문자 자동 치환만으로 번체 완료를 판정하지 않는다. 관리자·API·기계용 파일은 언어별로 복제하지 않았다.

새 페이지는 공통 tree의 page와 semantic namespace를 추가하고 네 카탈로그를 채운다. CI는 등록된 공개 페이지 목록·동일 문구 키·치환 인자·빈 문구를 검사한다. 언어에 따라 제품 집합/순위/회차/분류를 바꾸지 않으며 숫자 표시는 정확한 Intl 값이다. KST 관측 경계는 유지한다.

## root 코드 리뷰와 수정

- 정상 검색어의 encoded space를 returnTo 검사가 거부하던 문제를 pathname 검사로 좁혔다. query/hash는 보존한다.
- GitHub 인증 실패·취소가 한국어 로그인으로 돌아가던 문제를 검증·소비된 flow의 returnTo로 복구했다. 미검증 state는 기존 한국어 복귀다. actor/nonce/PKCE 및 한 번 소비하는 계약은 유지한다.
- 메이커 GitHub 설치 완료는 기존 flow.returnTo를 활용한다. 해당 제품의 `/p/<slug>/github`만 허용하며 성공/pending 플래그 외 query/hash를 유지한다. 새 DB 인증 열을 만들지 않았다.
- Latin 문자 비율만으로 프랑스어·독일어 원문에 en을 붙이던 추측을 제거했다. 표시와 readiness가 같은 보수적 영어 근거 helper를 사용한다.
- 번역 검수가 전각/Arabic-Indic 숫자 및 음수 부호 변경을 놓치던 문제를 Unicode decimal token+부호의 exact-count 비교로 보완했다.
- 제품 metadata는 tagline/description 양쪽의 현재 준비 상태로 동일한 reciprocal 언어 집합을 만든다. 한국어 기존 색인 규칙, takedown·차단·프로필 noindex는 유지한다. pending 번역 상세는 noindex/follow, private login/댓글 permalink/GitHub 설정은 noindex/nofollow 및 언어 alternate 없음이다.
- root의 임시 nonKO 전체 noindex는 UI 완료 후 제거했다. 제품 번역 출처와 기존 원문 작성 출처를 구분하고 기계 번역은 표시한다.
- 기존 detail rank/관련 프로젝트/모두보기 숫자와 404 추천을 홈의 같은 8시간 reader로 맞췄다. 별도 legacy 일간 증가 count를 다시 읽지 않는다.
- Next layout이 soft navigation에 재사용되는 점을 반영해 페이지 provider의 서버 표시시각을 갱신한다. 상세는 데이터 읽기 뒤 기준시각을 지정하고 업데이트 목록과 공유한다. 클라이언트의 임의 현재시각으로 초기 표시를 바꾸지 않는다.
- 선택 locale의 필요한 사전만 provider로 전달한다. root를 쓸 수 없는 전역 오류의 tiny6문구만 네 언어를 함께 포함한다.

## 비용과 원문 범위

제품 필드 번역은 페이지 GET에서 모델을 호출하지 않는다. 원문과 제품명/필드/규칙의 hash가 맞는 행만 읽고, 응답 전체에서 최대80개 visible 제품의 누락 필드만 after→primary로 접수한다. 기존 text 역할이 한 tick 최대4필드·모델 호출1회·4000자 입력 예산·최대4회 시도로 처리한다. 4000자보다 긴 원문은 source_too_long으로 남으며 임의 발췌 번역을 완료 전문으로 표시하지 않는다. 기존 ABCLLM 설정을 사용하고 키가 없으면 원문 fallback을 유지한다. 수만 개×3언어 일괄 번역이나 새 상시 워커는 만들지 않았다.

한국어 기존 writer, 원문 README·릴리스·댓글·메이커 프로필 prose는 유지한다. 중단된 소개 검수를 재개하지 않았다. 검색 keyword expansion은 기존 사용자 검색 시의 synchronous 경로를 중국어 입력에도 지원하므로 위의 제품필드 GET 모델0 계약과 구분한다.

## 실제 확인과 남은 확인

- 새 탭: main6b3fdfe, 필수 CI38335186074 성공. mini2→M3 4개 웹의 새 image/release/health/env를 확인했다. worker33349ed 유지, 네 flags ON 유지. 공개 읽기12GET의 release·count/facet·카드 중복·노출 수·라벨 확인 성공. worker health/progress 및 중단 intro 상태도 읽기로 확인했다.
- 기반: 최종 foundation webpack/typegen/tsc 성공, spoofed locale header를 포함한30개 읽기GET로 네 언어 일반/없는 경로, KO308 query, prefixed admin/API404, missing admin secret 차단 및 기계용 경로 보존을 확인했다.
- 통합: 카탈로그 gate는4locales/8namespaces/11publicpages 성공. 전체 lint는 오류0·기존 vendor 경고1. webpack 빌드27839 compile/type/prerender 완료 성공. 마지막 source clock 보완 이후 최종 빌드는 실행 중이며 결과를 후속 기록한다.
- 순수 검증: root language/numeric14사례, 에이전트 maker return35사례·제품 준비 상태14사례·signed number10사례 성공. DB/원격/LLM 호출 없는 assertion이다. 실제 제품·계정 동작 테스트로 해석하지 않는다.
- 사용자 직접 기능 테스트 선호로 새 suite/E2E·로그인/댓글/스타 쓰기는 수행하지 않았다. 기존 CI fixture는 route 이동·dynamic metadata·서버 async 계약에 맞춰 보완하며 검증 기준 자체를 삭제하지 않는다. 최종 필수 CI 결과는 확정 후 기록한다.

Next16.3.8의 explicit invalid category/product notFound가 빈 `__next_error__` 문서를 만드는 문제는 untouched baseline에서도 재현했다. 단일 root로 unmatched URL의 선택 lang/셸/진짜404/noindex는 복원했다. explicit404의 셸/lang은 기존 프레임워크 한계가 남는다. 상태200 우회·proxy DB 조회·프레임워크 패치는 추가하지 않았다.

다국어 운영 공개 전 순서는 사용자 직접 언어/로그인 복귀/필터/상세 확인, 최신 필수 CI·이미지 확인, 기존 drain 절차에서 migration0075 한 번 적용, 호환된 web 및 text/scheduler 릴리스 교체, 읽기 health/번역 진행/중단 intro 상태 확인이다. 운영 migration·이 후속 배포는 이 단계에서 실행하지 않았다.

설계: `docs/plans/2026-10-13-public-i18n-design.md`. 상세 중간 결과와 실패 기록은 각 `2026-10-13-i18n-*` 및 `2026-10-13-public-i18n-*` operations 문서, 정확한 이어받기 명령은 `docs/CODEX_HANDOFF.md`를 따른다.
