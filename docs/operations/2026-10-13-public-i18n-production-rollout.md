# NoMoreVibe — 다국어 운영 배포 기록

2026-10-13. 사용자 운영 배포 지시에 따라 [prod 절차](/Users/jr/.agents/skills/prod/SKILL.md)와 저장소의 공유 이미지 배포/독립 worker runbook을 사용했다. 실제 공개 응답·Docker runtime·DB 증거를 기록하며 사용자 OAuth/댓글/스타의 기능 시험을 대신하지 않는다.

## 원 배포 완료와 후속 교정

[PR406](https://github.com/JRVector9/nomorevibe/pull/406)을 정상 병합한 source main `ca2c8c32759373f4b8da4637e438982610f8f302`의 [CI38349103642](https://github.com/JRVector9/nomorevibe/actions/runs/38349103642)는 check 및 web/worker 이미지 발행까지 실제 성공했다. core13앱 배포와 runtime 검증을 완료했다. 별도 connect-agent1은 교체하지 않았다.

| 범위 | 실제 확인 |
|---|---|
| 웹 M3/mini | 새 web immutable digest, M3 4·mini 2 복제본 healthy, release/Next deployment ID/build key 일치 |
| publisher/reviewer/crawler M3/mini | 새 worker immutable digest, 역할별 양서버 readiness ready·progress ok |
| text/maintenance M3/mini, scheduler M3 | Git main source provider 보존, 실제 runtime source523파일 hash 일치. scheduler2 복제본 |
| 모든 core13앱 | Dokploy done, Docker runtime ready, 환경/명령/autoDeploy/복제본 정책 검증. 전체18복제본 |
| DB0075 | consumer11서비스 drain 후 직접5432 migration exit0, journal75→76, product_translations 존재, 기존11서비스 복원 |
| 소개 검수 | product-intro-check not_before2100-01-01, lease 없음. 중단 유지 |
| 기능 플래그 | PUBLIC_USER_AUTH_ENABLED/GITHUB_STAR_ENABLED/PRODUCT_FEEDBACK_ENABLED/GITHUB_FEEDBACK_DELIVERY_ENABLED ON 유지 |
| 관리자 임시 차단 | 양웹 ADMIN_LOCAL_LOGIN0. 공개 status/review307→admin/login. 관리자 OAuth미설정503, 정상관리자로그인은 잠김 |

원 이미지 digest:

- web: `ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:6732f239ee5cd7e5fdc3b84aa602331a408065cde26764023ab388964a5ca612`
- worker: `ghcr.io/jrvector9/nomorevibe-worker@sha256:1662c1f0f471739e3cc9daa8aa0e68b85179bcab2b76f142c5f51a80747c84ab`

원 배포 실제 명령 결과: preflight63223, migration22434, source44179, Dockerworker46887, web84913, verify18670 exit0. private state의 verification.json에는 13앱 runtime/env와 failover/progress ok 증거가 있다. snapshot/env/token/key는 공유·Git 포함하지 않는다.

## 내용 검사에서 추가 발견한 두 문제

첫24페이지/6경계 공개 GET의 HTTP/lang/canonical/새JS/댓글접힘은 통과했으나 **홈 정상 노출의 근거로 충분하지 않았다.** 네 언어 홈의 실제 제품 링크가0, SuspenseLoading만 보였다. 운영 네 웹 로그에서 `Attempted to call parseShown() from the server but parseShown is on the client`와 digest854463322로 확정했다. /rising의15제품은 정상 노출됐다.

[PR407](https://github.com/JRVector9/nomorevibe/pull/407)은 서버 HomeContent의 순수함수를 client BrowseFilters 재export에서 호출하던 경계를 바로잡는다. chipCategories 기존본문 이동과 기존fixture import만 교정하며 필터 기준·관측·UI·DB·번역 정책은 바꾸지 않는다. root가 diff를 검토했고 기존19사례/2파일, 담당 next typegen/tsc/scopedESLint/diff 검사가 실제 성공했다. PR407 CI38351532853의필수check/quality/integration1~3 실제성공 후 정상merge b5924ac3a2dac3225998671f97117fce78c5246c. 운영용 main CI38351933550/image 결과와 후속 배포는 아래 최종 기록에 갱신한다.

자동 번역은 최초33필드 중16개 network 실패였다. M3host curl/컨테이너 https.get IPv4는200이지만 Node24의 기본 family 자동 연결은 IPv4 ETIMEDOUT/IPv6 ENETUNREACH를 약500ms에 반환했다. ipv4first만은 실패했고 family attempt timeout2000과 auto-family 비활성 각각은 동일 컨테이너 모델 목록 GET200(약1.6초)였다. API-key와 게이트웨이를 바꾸지 않고 양text NODE_OPTIONS에 `--network-family-autoselection-attempt-timeout=2000`을 적용·재배포45963 exit0. 실제 정상text 작업으로 처음 중국어15필드, 후속26필드(Hans11/Hant15), 이후36필드(Hans15/Hant21)의 ready 저장을 확인했다. 마지막읽기에는 network 실패0, 검수실패5, 새화면수요 pending28을구분했다. 오래된 실패는 기존 유한 재시도/검수 규칙을 따른다. 원문 이름/간체·번체 검수를 완화하거나 전체 백필하지 않는다.

홈이 Loading에 머무는 동안 양웹을 직전정상6b3fdfe로 복구31628 exit0. 공개homeGET34269는 실제30제품/no Suspense error/6b3 asset을 확인했다. 관리자우회0은 보존했다. 이 복구 이후 다국어 b592를 다시 배포했고 다음 최종 확인을 완료했다.

## 최종 공개·runtime 확인

홈 교정 PR407/main b5924ac의CI38351933550은 check 및 양이미지 발행 모두성공했다. preflight84063 exit0. 양웹14756 exit0, source5앱59342 exit0. 공개내용검사15582 exit0:네언어×6종류24페이지와6경계읽기, 각홈30제품/급상승15제품, 동일제품집합·올바른lang/canonical/새asset·serverSuspenseerror없음·상세댓글접힘 보존. Dockerworker6앱72835 exit0, 각쌍readiness ready/progress ok. 13앱최종verify25987 exit0:모든core앱healthy/적용env일치/failover·progressok/두웹확인/개발우회0. backend/source523파일 및 Node옵션2000도 실제 runtime과 일치했다. 이때 web digest는 `sha256:953e9200d187c8613442ba517448cb09b9836a6762ea8faf4416e16392a1ea62`, worker digest는 `sha256:85c69a33193e2d9fc0a651682a0731a0825bb650b3da78567660317ad635e9b3`다.

공개 언어 URL은 한국어 `https://nomorevibe.com`, 영어 `/en`, 간체 `/zh-Hans`, 번체 `/zh-Hant`다. 공유 페이지/카탈로그 구조로 관리하며 제품 한줄소개·설명은 화면 수요 기반 번역이다. 모든 제품이 네 언어로 번역완료됐다는 뜻은 아니다.

## 추가 사용자 UI 요청

사용자가 하단첫8h탭이 위쪽8h영역과중복된다고지적하여 AI로제작탭으로교체를지시했다. 상단8h영역/rising/관측주기는유지한다. [PR408](https://github.com/JRVector9/nomorevibe/pull/408)에서 기존 AI 1·2·3단계 근거의 공개 목록을 최근 등록순으로 보여주고 기존 오른쪽 AI 칩도 첫 탭으로 합쳤다. root 소스/DAL 리뷰와 기존 7파일83사례 재실행을 통과했다. PR CI38353635696의 필수 check/quality/integration1~3 성공 후 main `707e9c220f2eb8d9d2d9b245e2a3e64d9ae9dbd1`에 정상 병합했다. [main CI38354066578](https://github.com/JRVector9/nomorevibe/actions/runs/38354066578)의 check/quality/integration1~3 및 web·worker 이미지 발행까지 모두 성공했다.

## AI 탐색 탭 최종 운영 확인

소스의 lib/scripts/drizzle/패키지/tsconfig/Dockerfile diff가 없어 백엔드 로직과 DB는 기존 b592를 유지하고 **양웹만** 교체했다. 웹의 최종 이미지:

`ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:3e19c38110d542aff27d5c27be15dfb5dcd5c3ba96efbadc25180aafcc370d10`

capture92733, plan21904, web49515가 모두 exit0였다. mini2·M3 4 웹 복제본과 공개 health의 양 인스턴스가 새707e9c2 릴리스로 정상이다. 최종 verify96936 exit0: core13앱 healthy, 실제 환경·정책·Git source523파일 일치, worker failover/progress ok, 백엔드 b592 worker digest85c69 유지, 네 기능 flag ON, 관리자 개발 우회0을 확인했다. 새 migration 또는 불필요한 워커 재배포는 하지 않았다.

공개 검증 결과:

- contentGET14972 exit0: 네 언어×6종류24페이지와6경계의 HTTP/lang/canonical/새 asset/실제 제품/no Suspense error, 상세 댓글 기본 접힘 유지. 홈 전체 구획의 고유 프로젝트36개, `/rising`15개가 네 언어에서 같은 집합이었다.
- AI18페이지 최종 읽기 exit0: 각 언어의 AI/최근 등록/총스타/개발도구 AI 목록, 옛 weekly 주소, 더 보기18개. 세 탭·선택 상태·AI 칩 제거·상단 급상승5개 유지 및 언어별 목록 순서/개수가 일치했다. 기본 하단은9개다.
- DB 읽기5849 exit0: 실제 노출39개 프로젝트의 AI1·2·3 자격, 개발도구 분야, 총스타 내림차순을 확인했다. 각 탭의 화면 총수와 분야별 표시 개수를 같은 DAL 조건의 DB 집계와 대조해 일치를 확인했다. 검증 시 AI32,552 / 최근 등록37,980 / 총스타38,110 / 개발도구 AI7,781이었다. 수집·판정으로 계속 변하는 값이며 고정 운영 수가 아니다.

처음 언어별 개수 비교는 비동일로 실패했다. 재독에는 모두 같았지만 그 후 최신 DB 읽기는 AI32,551과 직전 화면32,544로7개 차이가 났다. 기존 공개 읽기는30초 캐시이고 수집/판정이 계속되므로 서로 다른 읽기 시점을 같은 스냅샷으로 간주하지 않았다. 화면과 DB를 이어 다시 읽은 최종 결과는 위 수와 분야 집계가 모두 일치했다. 검증 실패를 숨기거나 워커를 중지해 숫자를 맞추지 않았다.

15:07 KST 번역 진행 읽기에서 Hans ready28/Hant ready34, ready62·pending77·검수실패11이었다. 실패 코드는 english_uncertain5/name_lost2/term_lost4이고 network0이다. product-translate는 실제 last_success가 갱신되며 소개 검수는 not_before2100/unleased였다. 화면 수요의 일부 번역 저장 확인이며 모든 제품/문장의 번역 완료 또는 의미 품질 검증을 뜻하지 않는다.

## 관리자 감사와 남은 범위

gpt-6.1-sol/xhigh 3담당 감사와 root 대조 결과는 [1인 관리자 보고서](2026-10-13-single-operator-admin-audit.md)에 기존36기능영역·후속ADM01~16으로 정리했다. 관리자 개발우회0 차단과 Tailscale/ID비밀번호 구현은 별개다. 현재정상관리자로그인 잠김과 미구현 경계를 명시한다.

사용자 실제 인증·댓글·외부전송·스타쓰기, 번역문장 의미품질, 검색엔진색인, 장기관측/외부알림/격리백업복원은 이번 읽기검증과 코드감사에서 실행하지 않았다. PENDING의 기존미검증 항목은 유지한다. 새시간별collector·전체번역백필·소개검수재개·새관리자시스템 구현은 하지 않았다.
