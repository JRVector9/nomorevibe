# X 공식 API 정책 확인과 첫 파일럿

확인일: 2026-10-14. X 공식 문서를 다시 확인하고, 로그인된 개발자 콘솔의 기존 앱을 읽었다. 웹 HTML 수집·인증 API 호출·결제·운영 배포는 실행하지 않았다. 토큰 발급과 파일럿 결과는 아래 상태를 기준으로 판단한다.

## 판단과 이번 구현 범위

일반 X HTML crawler를 만드는 방식은 이번 범위에서 진행하지 않는다. 2026-10-09 시행 약관은 사전 서면 동의 없는 크롤링·스크래핑을 금지하며, 게시된 인터페이스도 해당 조건에 따라 사용해야 한다. `robots.txt`의 일반 user agent도 `/`를 차단한다. 검색엔진 전용 예외를 우리 crawler에 적용하거나 user agent를 위장하지 않는다. 근거: [X 이용약관](https://x.com/en/tos), [X robots](https://x.com/robots.txt).

공식 API로 공개 GitHub 링크와 공개 지표를 읽는 것은 기술적으로 가능하다. **계정/API 접근권과 프로젝트 발굴·공개 HOT 분석이라는 사용 목적의 승인은 별개다.** 개발자 정책은 제출한 사용 목적을 구속력 있는 설명으로 취급하고, 실질적으로 바뀐 목적은 알림과 승인을 먼저 요구한다. 기존 앱의 일반 설명이나 Bearer Token 발급만으로 이 목적이 승인됐다고 판정하지 않는다. 정책 본문에 옛 Free/Basic/Pro 명칭이 남아 있어도 새 pay-per-use 요금 문서가 목적 승인 조건을 없앤 것으로 해석하지 않는다. 근거: [개발자 정책의 사용 목적 규칙](https://docs.x.com/developer-terms/policy), [개발자 계약](https://docs.x.com/developer-terms/agreement).

앞서 제안한 MVP의 첫 합격 조건은 실제 승인 계정에서 공개 검색의 링크·필드·지표·비용을 확인하는 것이다. 따라서 이번 코드는 **기본 dry-run인 독립 실행 파일럿**을 준비한다. scheduler·운영 role·DB·frontier·HOT UI 연결은 이 합격 조건 이후 단계다. HTML·내부 API·로그인 세션 scraping, full archive, stream, DM, 사용자 프로필/팔로워 조회는 파일럿에 포함하지 않는다.

## 정책이 데이터 설계에 주는 조건

| 조건 | 적용할 설계 |
| --- | --- |
| 사용 목적 | 프로젝트 링크 발견, 관측 지표 기반 HOT 분석과 표시, 재관측/삭제 처리, 제한된 보존을 목적 설명에 포함한다. 실제 승인 범위 확인 전 live 실행하지 않는다. |
| 삭제·비공개·정지·withheld | API에서 사용할 수 없어진 콘텐츠는 가능한 한 빨리 제거한다. X/해당 계정 주인의 요청을 받은 경우 24시간 이내 조건도 지킨다. 향후 관측과 파생 HOT snapshot을 함께 무효화한다. 단순 응답 누락은 삭제라고 단정하지 않는다. |
| 공개 표시 | API를 통한 최신 상태 확인 또는 정식 embed의 조건을 따르며, 앱 자체의 제품 정보와 X 출처 링크를 구별한다. 공개 카드 만료·stale 규칙은 삭제 처리의 대체가 아니다. |
| 재배포 | 로컬 acceptance 파일을 공개 JSON API/다운로드 데이터셋으로 노출하지 않는다. 일반적인 재배포 허용 범위는 ID 중심이며, 비자동 소량 객체 예외를 공개 자동 feed 허가로 해석하지 않는다. |
| 개인 식별 | 첫 파일럿은 게시물 본문·미디어·프로필·작성자 ID/이름을 저장하지 않는다. 향후 독립 작성자 수·작성자별 상한이 필요하면 최소 식별/보존 방식과 승인 목적을 별도로 확인한다. 해시 처리만으로 익명 데이터라고 단정하지 않는다. |
| 외부 신원 연결 | 공개 게시물의 GitHub **프로젝트 링크** 추출을 X 작성자와 GitHub 메이커의 소유권/신원 확인으로 바꾸지 않는다. |
| 모델 이용 | X 콘텐츠로 foundation/frontier 모델을 학습·fine-tune하지 않는다. 기존 제품 검수는 별도로 수집한 GitHub/제품 근거를 사용한다. |
| 분석의 의미 | 정한 검색 표본에서 관측된 프로젝트 반응이다. X 전체 이용량·플랫폼 성능 benchmarking, 민감한 개인 속성 추론, 외부 광고 타기팅 서비스로 확장하지 않는다. |

위 삭제·표시·재배포 조건은 [개발자 정책](https://docs.x.com/developer-terms/policy), 신원 연결·민감 정보·집계 조건은 [Restricted Uses](https://docs.x.com/developer-terms/restricted-use-cases), 모델·상업 이용 조건은 [개발자 계약](https://docs.x.com/developer-terms/agreement)에 근거한다. 개인 정보를 저장하지 않는 집계 허용 조항도 다른 모든 계약·정책을 충족해야 한다. HOT라는 파생 분석이 자동으로 승인된다는 법적 결론은 내리지 않는다.

## API·비용 확인

- 최근 검색: `GET https://api.x.com/2/tweets/search/recent`, 최근 7일 API 중 파일럿은 최근 24시간 한 질의·한 페이지·최대 10개만 요청한다. 추가 pagination은 하지 않는다.
- 재조회: `GET https://api.x.com/2/tweets?ids=...`. 공식 batch 한도는 100개지만 파일럿은 한 번에 최대 10개, 검색으로 찾은 후보와 명시한 ID를 합쳐 최대 두 batch만 보낸다.
- 공개 지표는 앱 Bearer로 읽을 수 있다. 좋아요·답글·재게시·인용·북마크·노출을 nullable로 정규화한다. 미제공을 0으로 바꾸지 않는다. 노출은 고유 사람 수가 아니며 공개 지표에는 유료 노출이 섞일 수 있다.
- 문서에 충돌이 있다. metrics 예시/기존 소개는 `tweet.fields`, 현재 endpoint reference는 `post.fields`를 사용한다. 파일럿은 기본 `tweet.fields`, 명시 옵션으로 `post.fields`를 선택하며, 실패 후 다른 이름으로 자동 재시도하지 않는다. 실제 계정 호출로 유효 필드와 계약을 확인해야 한다.

근거: [최근 검색 reference](https://docs.x.com/x-api/posts/search-recent-posts), [Lookup](https://docs.x.com/x-api/posts/lookup/introduction), [Metrics](https://docs.x.com/x-api/fundamentals/metrics).

공식 요금 문서의 Post Read 단가는 반환 리소스당 $0.005다. 파일럿은 요청 전에 최대 반환 수를 보수적으로 예약해 **최대 3요청·30 post resource**로 제한한다. 문서 단가 환산은 최대 $0.15지만 **실제 계정 청구액의 보증이 아니다.** 하루 재조회 dedup은 문서상 soft guarantee이므로 같은 ID에도 예산을 예약한다. 반복 CLI 실행의 일일 상한을 제공하는 운영 crawler는 아직 아니며, 자동 실행하면 안 된다. 실제 요금은 콘솔에서 확인한다. 근거: [X API 요금](https://docs.x.com/x-api/getting-started/pricing).

## 콘솔·토큰 상태

- 기존 로그인 계정의 pay-per-use 프로젝트와 active 개발 앱33221608을 확인했다. 앱 설명은 일반적인 API 사용 설명이며, 프로젝트 발굴/HOT 승인 범위는 확인하지 못했다.
- 콘솔 대시보드에 무료 크레딧 $9.71, 유료 크레딧 $0.00이 표시됐다. 이는 조회 시점 값이고 특정 endpoint 가격/자동 충전 설정을 증명하지 않는다.
- 사용자가 발급/로컬 저장 확인 질문에 `이어서해`라고 답했다. 초기 `생성하기` 버튼은 재생성 확인 창을 열었으며 agent는 최종 재생성 버튼을 누르지 않았다. 이후 사용자가 토큰을 클립보드에 복사했다고 알렸고, 콘솔에는 생성된 Bearer 상태가 표시됐다. OAuth/DM 권한 확대, 결제·자동충전은 실행하지 않았다.
- 사용자 제공 Bearer를 `/Users/jr/.config/nomorevibe/x-api.env`에 저장했다. 디렉터리700/파일600, 단일 `X_BEARER_TOKEN` 형식만 확인했으며 토큰 원문은 출력하거나 Git에 넣지 않았다. 토큰의 실제 인증 유효성은 아직 API로 검증하지 않았다.
- **이번 작업에서 X 신청서에 목적을 입력·제출하거나 목적 변경 승인을 받은 적은 없다.** 앱·프로젝트·계정 설정에서 프로젝트 발굴/HOT 승인 기록도 확인하지 못했다. 아래 설명은 문서의 초안이며 제출된 승인 신청서가 아니다. 사용자의 기존 승인 범위 확인을 요청했고 실제 X API 호출은 보류한다.

권장 목적 설명 초안(실제 제출/계약 동의는 아직 안 함):

> NoMoreVibe uses the official X API to discover public posts linking to software projects and public GitHub repositories. We retain minimal post identifiers, project links, timestamps, and public engagement observations to assess project interest in a bounded recent-search sample. Public HOT listings include only independently reviewed projects, source links and observation times. We do not infer maker identity, collect profiles or DMs, redistribute raw post objects, train models, target advertisements, or benchmark the X platform. We refresh availability and remove unavailable content and derived ranking contributions, and honor removal requests.

## 파일럿 실행·검증 상태

구체적인 파일·검사·실행 계약은 [구현 계획](../superpowers/plans/2026-10-14-x-api-pilot.md)을 따른다. 기본 실행은 HTTP를 보내지 않는다.

```sh
npx tsx scripts/x-api-pilot.ts
```

승인 목적과 크레딧/실제 요금을 확인하고 Bearer가 보안 설정에 준비된 후에만 live 플래그를 사용한다. 토큰은 CLI 인자로 전달하지 않는다.

```sh
node --env-file=/Users/jr/.config/nomorevibe/x-api.env --import tsx scripts/x-api-pilot.ts --live --use-case-approved --fields-parameter tweet.fields
```

`--use-case-approved`는 X의 승인을 만들어 내는 옵션이 아니라 운영자의 사전 확인을 선언하는 플래그다. 문서 충돌 확인을 위해 다른 이름으로 실행한다면 별도 명시 실행이며 자동 재시도하지 않는다. 결과는 최신 지표·연결 가능성과 제한 상태만 보고하고, 첫 관측을 HOT 성장률이나 제품 심사 승인으로 바꾸지 않는다.

저장한 env를 읽되 승인 선언 없이 `--live`만 지정한 실행은 실제로 확인했다. 의도한 exit1과 `status:skipped`, `reason:use_case_not_approved`, 요청0·예약0을 반환했다. 이는 목적 gate 검사이며 인증 실패나 실제 검색 실행이 아니다.

현재 live 검색/재관측·요금 검증은 미실행이다. 독립 운영 프로세스와 공개 HOT 필터는 계정 파일럿 성공 후의 별도 구현 단계로 남는다.

## 코드 검사와 독립 리뷰

최초 구현의 단위31개, 타입·scoped lint, 기본 dry-run은 실제 통과했다. root의 직접 read-only `gpt-6.1-sol / xhigh` 리뷰에서 P2 세 개를 발견했다. HTTP200 빈/오류 전용 응답을 성공으로 처리하는 경우, 중복 ID의 뒤쪽 withheld 표시를 버리는 경우, 질의 내부 OR의 `-is:retweet`를 전역 필터로 오인하는 경우다. 회귀 RED11실패/3통과로 재현하고 수정했다. 전체 질의를 괄호로 묶어 전역 재게시 제외를 추가하며, 중복 관측의 사용 불가 표시를 우선한다. 정상 빈 검색은 성공 metadata가 필요하고 오류 전용 응답은 성공으로 처리하지 않는다.

root의 후속 대조에서는 검색 후보를 재조회한 응답이 명시적인 접근 불가 오류만 포함할 때, 중단 결과에 이전 available 링크·지표가 남는 경계도 확인했다. 실제 resource-denial 네 종류의 RED4→GREEN4로 검증했다. 알려진 요청 ID를 unavailable로 투영하고 링크·지표를 지운 뒤 invalid_response로 중단한다. 전체 재조회 실패나 단순 누락을 삭제로 단정하지 않는다.

오류 전용 lookup 수정까지 파일럿 단위50개, 타입·scoped lint, 기본 dry-run exit0/요청0/예약0은 실제 통과했다. HTTP fixture만 사용하는 단위 검사는 실제 X 권한·유효 필드·요금 검증이 아니다.

두 번째 직접 리뷰에서 한 ID만 예약한 lookup에 중복 ID 두 행이 반환될 때, 행 상한 검사가 unavailable 투영보다 먼저 실행되는 P2를 추가 발견했다. 기존 중복 fixture는 두 ID를 예약해 이 경계를 놓쳤다. 한 ID·양쪽 중복 순서와 잘못된 응답 구조에서도, 요청한 ID의 알려진 사용 불가 표시를 먼저 반영한 뒤 중단하도록 수정했다. 상한 위반을 정상 응답으로 허용하지 않는다.

이 경계는 RED13실패/1통과→GREEN14통과로 검증했다. 기존 관측 배열의 순서를 고정하던 fixture는 ID별 세 상태·중복 없음 검증으로 교정했다. 전체 파일럿64개·scoped lint·기본 dry-run은 실제 통과했다. 최종 root 전체 단위254파일2,433개·타입·전체 lint도 exit0이다(lint 기존 vendor warning1). 파일럿 기본 npm 명령은 요청0/예약0이며, 저장 env의 승인 없는 live 명령도 의도한 exit1/use_case_not_approved/요청0을 확인했다.

root 최종 직접 리뷰 `x_pilot_round3`는 실제 `No findings / CONCLUSION: OK`, exit0/308.25초다. 추가27개 in-memory 검사를 실행했고 실제 API/credential/DB는 사용하지 않았다. 앞선 두 리뷰의 P2를 재현·수정한 뒤 세 번째로 통과한 것이며, 최초 리뷰는 transient503 재연결1회 후 결과를 반환했다. 코드·회귀검사·계획·README/package/.env.example은 로컬 `5c791dc`로 커밋했다. push·PR·운영 배포는 하지 않았다.

파일럿 직접 리뷰3회 receipt의 실제 합계는 입력1,632,423(그중 캐시1,450,624)·출력25,026토큰이다. 캐시를 입력에 다시 더하지 않는다. 이번 전체 재검토 사용량은 [설계 재검토 보고서](2026-10-14-pipeline-design-reaudit.md)에 집계한다. 모델은 모두 `gpt-6.1-sol / xhigh`다.
