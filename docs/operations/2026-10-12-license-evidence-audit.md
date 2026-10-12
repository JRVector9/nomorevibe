# 2026-10-12 GitHub 라이선스 근거 감사

## 결론과 범위

현재 수집기는 `GET /repos/{owner}/{repo}`가 돌려준 라이선스 이름·SPDX 식별자·일반 라이선스 API URL을 저장한다. 운영 표본 7건의 세 필드는 같은 날 공개 GitHub REST 응답과 모두 같았다. 이는 해당 표본의 **GitHub 메타데이터 전사 정확성** 근거이며, 저장소 전체의 실제 라이선스 조건을 완전히 판독했다는 뜻은 아니다.

GitHub는 Licensee로 알려진 라이선스 파일을 식별한다고 설명한다. API는 의존성 라이선스나 README의 라이선스 언급을 포함하지 않는다. 이 프로젝트도 `/license`, LICENSE 본문, 각 파일 헤더, 의존성의 조건을 수집·분류하지 않는다. [GitHub Licenses API 공식 문서](https://docs.github.com/en/rest/licenses/licenses), [Licensee 탐지 범위](https://github.com/licensee/licensee/blob/main/docs/what-we-look-at.md).

이 감사는 소스 읽기, 전달받은 운영 집계 JSON 읽기, 인증 없는 공개 REST GET, 공식 문서 열람으로 진행했다. 테스트 작성·실행, typecheck, lint, build, E2E, 브라우저 기능 검증은 수행하지 않았다. 코드의 기대 동작은 아래에 명시하되 실행 검증을 완료했다고 주장하지 않는다. 운영 DB 수정, GitHub 메시지·스타·이슈 작성, 배포를 수행하지 않았다.

## 운영 집계

근거 파일: `/private/tmp/nomorevibe-detail-license-audit-result-20261012.json` (상위 작업자가 제공한 2026-10-12 읽기 전용 운영 감사). 공개 GitHub 제품 42,283건 중 현재 저장소 링크에 대응하는 표시 가능한 facts는 38,623건이다.

| 라이선스 메타데이터 | 제품 수 | 해석 |
| --- | ---: | --- |
| null | 19,713 | API 메타데이터에서 라이선스를 확인하지 못함. 실제 무라이선스·권리 조건으로 단정하지 않음 |
| MIT | 10,478 | GitHub가 반환한 식별자 |
| Apache-2.0 | 3,134 | GitHub가 반환한 식별자 |
| NOASSERTION | 2,772 | 실제 라이선스 식별자로 비교할 수 없는 값 |
| AGPL-3.0 | 1,115 | GitHub가 반환한 식별자. 임의로 `-only` / `-or-later`로 바꾸지 않음 |
| GPL-3.0 | 754 | GitHub가 반환한 식별자. 임의로 `-only` / `-or-later`로 바꾸지 않음 |
| 나머지 식별자 | 657 | BSD·MPL·CC·LGPL 등 |

이 cohort에서 이름 없는 비어 있지 않은 라이선스 객체는 0건, 일반 `https://api.github.com/licenses/...` URL은 16,138건이다. 이 URL은 해당 저장소 LICENSE 파일의 주소가 아니다. 전달된 메이커 라이선스 표본은 비어 있으며, 상위 작업자는 현재 실제 메이커 선언이 없다고 확인했다. 따라서 메이커 비교 오류는 현재 충돌 사례를 발견했다는 주장이 아니라 허용된 입력과 소스 분기를 근거로 확인한 오류다.

추가 근거 `/private/tmp/nomorevibe-detail-license-audit-extra-20261012.json`의 운영 표본 `agentic-atlas`, `agentdomains`, `agentcrew`, `agentcap`은 모두 source `ok`, 이름 `Other`, SPDX `NOASSERTION`, URL null이다. 이 네 건은 일반적인 다른 라이선스명이 아니라 미식별 GitHub 메타데이터가 실제 제품에 들어오는 사례다. 공개 REST와 직접 비교한 7건에는 포함하지 않는다.

facts 전체 기준 48시간 초과는 9,732건, non-ok source는 1,566건이다. 이는 라이선스 단독 갱신 상태 집계가 아니다. 라이선스는 마지막 성공한 facts와 함께 남으므로 수집된 값의 존재와 현재 신선도를 구분해야 한다.

## 수집·저장·표시 경로

1. `lib/domain/evidence/providers/github.ts`의 `refreshGitHubEvidence`가 저장소 루트 REST 응답을 요청한다. `mapGitHubRepositoryFacts`는 `license.name`, `license.spdx_id`, `license.url`을 각각 `value`, `spdxId`, `url`로 옮긴다. null/필드 누락은 라이선스 null이 된다. 정상 응답의 이름 없는 객체를 실제로 관측하지는 않았다.
2. 저장소 루트 요청의 304에는 본문이 없으므로 `repositoryFacts`는 이전 facts의 라이선스를 보존한다. 언어·기여자·릴리스는 별도로 새로 읽는다. 숫자 저장소 ID가 없는 오래된 facts에는 조건부 요청을 보내지 않는다. 304에 이전 facts가 없으면 오류를 낸다. GitHub는 조건부 요청의 ETag/Last-Modified 지원을 문서화한다. [공식 REST 모범 사례](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests).
3. 루트 실패, 비공개 판정, 보조 조회 실패는 실패·연결 끊김 상태만 upsert한다. `lib/domain/evidence/repository.ts`의 upsert는 생략된 normalizedFacts와 lastSuccessAt을 지우지 않는다. 루트에서 새 라이선스를 받았어도 보조 조회에 실패하면 성공 facts 전체가 교체되지 않는다. 이 보존은 실패를 무라이선스로 오해하지 않게 하며, 표시에는 마지막 성공 시점 설명이 필요하다.
4. detail 조회는 현재 `product.repoUrl`의 정규화된 저장소 키와 같은 source를 선택한다. 저장소를 다른 키로 다시 연결하면 이전 키의 facts를 새 저장소의 라이선스로 사용하지 않는다. 단, `repoUrl`을 제거한 경우 조건의 `!product.repoUrl` 때문에 남은 첫 repository source를 선택할 수 있다. 이는 소스에서 확인한 unlink 경계이며 운영에서 발생한 오표시를 직접 관측했다는 뜻은 아니다. 일반 detail source 선택은 이 라이선스 helper 수정 범위 밖이라 변경하지 않았다. 과거 source 자체를 제거하는 작업은 하지 않는다.
5. `lib/domain/products/detail-view.ts`의 `repositoryFacts` → `licenseValue` → `presentLicense`가 저장된 관측과 메이커 선언을 구분한다. 기존 UI는 `observed ?? maker`를 표시했으며, facts가 오래됐거나 source가 실패·연결 끊김이어도 라이선스 옆의 마지막 성공 시점이 없었다. 해당 표시 변경은 UI 작업 범위에서 처리한다.

운영의 실제 마지막 성공 facts 보존 사례: `agent-studio-2`, 저장소 `webdevcom01-cell/agent-studio`, source `disconnected`, 마지막 성공 `2026-09-24T18:13:51.844Z`, 마지막 실패 `2026-10-12T03:40:41.857Z`, 오류 `not_found`, 보존 라이선스 `Apache-2.0`. 이를 현재 확인된 라이선스로 오해하지 않도록 마지막 성공 시점·실패 상태를 함께 설명해야 한다. 404가 삭제인지 비공개 전환인지도 API 결과만으로 단정하지 않는다.

## 확인된 비교 오류와 수정

기존 `sameLicense`는 `(spdxId ?? value)`를 비교했다. 예를 들어 메이커 `Custom A / NOASSERTION`, 관측 `Other / NOASSERTION`은 서로 식별되지 않은 라이선스임에도 공통 sentinel 때문에 `matched`였다. 메이커 `MIT License`가 SPDX 필드를 생략한 경우와 관측 `MIT License / MIT`은 같은 반환 이름임에도 `conflict`였다. 메이커 schema는 SPDX 필드 생략과 임의 문자열을 허용한다.

수정한 파일은 다음 두 개다.

- `lib/domain/evidence/providers/github.ts`: 새 facts의 `NOASSERTION`과 `NONE`을 실제 SPDX 식별자로 저장하지 않고 `spdxId:null`로 정규화한다. 이름과 URL은 보존한다. 라이선스 객체 자체가 null인 경우는 계속 null이다.
- `lib/domain/products/detail-view.ts`: 오래된 facts와 메이커 선언에서도 sentinel/공백 식별자를 정리한다. 구체적인 이름을 보존한다. usable SPDX가 없는 `Other`, `Unknown`, `NOASSERTION`, `NONE`은 `unidentified` 상태로 표시하고 일치·충돌의 근거로 쓰지 않는다. 관측 출처 설명은 `GitHub 감지·식별 미확인`이다. 메이커 값도 함께 보존한다.

관측은 구체적으로 식별되지만 메이커 선언만 `Other`처럼 미식별인 경우, 구체적인 관측을 `observed_only`로 보존한다. 메이커의 미식별 선언 때문에 알려진 관측까지 미식별로 낮추거나 두 값이 충돌한다고 단정하지 않는다. 해당 메이커 객체도 버리지 않는다.

두 값에 명시적 SPDX가 있으면 그 식별자만 비교한다. 한쪽에 SPDX가 없으면 그쪽의 선언 문자열과 반대쪽의 **정확한 반환 식별자 또는 반환 이름**을 비교한다. 양쪽 모두 식별자가 없고 구체적인 이름이 있으면 이름을 정확히 비교한다. 공백 양끝과 대소문자만 정리하며, 퍼지 매칭·라이선스 계열 추정·본문 분류는 추가하지 않는다.

`LicensePresentation` 계약은 `state:'unidentified'`, `label:'라이선스 식별 미확인'`을 추가한다. `maker`와 `observed`는 기존 구조 그대로다. 별도 UI 작업자는 이 상태, 메이커 값, 마지막 성공 시점과 라이선스 본문 링크 의미를 반영한다.

SPDX는 NOASSERTION을 판단할 수 없거나 정보를 제공하지 않는 경우로 정의하며, 그 값에 라이선스 의미를 붙이지 않는다. [SPDX NoAssertionLicense 공식 정의](https://spdx.github.io/spdx-spec/v3.0.1/model/ExpandedLicensing/Individuals/NoAssertionLicense/).

## 공개 REST 응답 비교

2026-10-12 03:53:33–35 UTC, 인증 없이 아래의 공식 GitHub REST URL을 GET했다. 모두 HTTP 200이었다. `name→value`, `spdx_id→spdxId`, `url→url` 세 필드를 운영 표본과 비교했으며 모두 같았다. 이 비교는 애플리케이션 테스트가 아니라 외부 근거 수집이다.

| 운영 slug / 저장소 | API 라이선스 | 운영 세 필드와 비교 | 공식 응답 |
| --- | --- | --- | --- |
| aet-go / cloudgal1234-cyber/Eat-go-dmo | null | 같음 | [REST 응답](https://api.github.com/repos/cloudgal1234-cyber/Eat-go-dmo) |
| driftlet-demos / markblundeberg/driftlet | 0BSD | 같음 | [REST 응답](https://api.github.com/repos/markblundeberg/driftlet) |
| a-privacy-first-open-source-knowledge-base / logseq/logseq | AGPL-3.0 | 같음 | [REST 응답](https://api.github.com/repos/logseq/logseq) |
| agent-social / navienpotheri/agent-social | Apache-2.0 | 같음 | [REST 응답](https://api.github.com/repos/navienpotheri/agent-social) |
| website-builder-create-a-website-now / elementor/elementor | GPL-3.0 | 같음 | [REST 응답](https://api.github.com/repos/elementor/elementor) |
| agent-skills-30 / datadog-labs/agent-skills | MIT | 같음 | [REST 응답](https://api.github.com/repos/datadog-labs/agent-skills) |
| sb3-creator / CrispStrobe/sb3-creator | MPL-2.0 | 같음 | [REST 응답](https://api.github.com/repos/CrispStrobe/sb3-creator) |

추가 공식 저장소 응답을 2026-10-12 03:50:42–43 UTC에 읽었다.

- [microsoft/vscode](https://api.github.com/repos/microsoft/vscode): `MIT License / MIT / https://api.github.com/licenses/mit`.
- [elastic/elasticsearch](https://api.github.com/repos/elastic/elasticsearch): `Other / NOASSERTION / null`. 이 객체는 라이선스 미식별을 보여 주며 특정 custom 라이선스로 추정하지 않는다.
- [rust-lang/rust](https://api.github.com/repos/rust-lang/rust): `Apache License 2.0 / Apache-2.0`. 반면 [공식 README](https://github.com/rust-lang/rust#license)는 MIT·Apache와 일부 BSD 계열 조건을 언급한다. 따라서 하나의 정상 식별자가 있어도 저장소 모든 조건·복수 라이선스를 완전히 표현한다고 주장할 수 없다.
- [facebook/react](https://api.github.com/repos/facebook/react): 응답 `full_name`은 `react/react`, 라이선스는 MIT. 이름 변경·리다이렉트는 REST 계층에서 처리되며 새 저장소 키의 facts를 기존 다른 source 키에 임의로 가져오는 방식은 아니다.
- [github/gitignore](https://api.github.com/repos/github/gitignore): `Creative Commons Zero v1.0 Universal / CC0-1.0`.

GitHub는 여러 라이선스나 복잡한 조건이 탐지를 방해할 수 있다고 설명한다. SPDX 복수 라이선스는 AND/OR/WITH 등의 표현식으로 표현할 수 있으나, 현재 수집기는 이를 본문에서 생성하거나 동등성을 판독하지 않는다. 메이커가 준 표현식은 문자열로 보존할 수 있으며, 같은 문자열 여부 이상의 의미 비교는 하지 않는다. [GitHub 탐지 설명](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository#detecting-a-license), [SPDX 라이선스 표현식](https://spdx.github.io/spdx-spec/v2.2.2/SPDX-license-expressions/).

## 남은 확인

- 전체 운영 라이선스의 LICENSE 본문과 법적 의미를 대조한 감사는 아니다. null·Other·정상 SPDX를 근거로 허용 행위를 추론하지 않는다.
- 사용자 지시에 따라 이 변경의 실행 테스트·typecheck·lint·build·브라우저 검증을 수행하지 않았다. 메이커 비교 분기, 새 unidentified 상태, 기존 null 표시 정책의 실행 확인은 사용자가 수행할 부분이다.
- 과거 NOASSERTION facts를 DB에서 일괄 수정하지 않았다. 읽기 시 정규화하며, 이후 정상 200 수집에는 새 정규화가 적용된다. 304에서는 원래 facts를 보존한다.
- 별도 갱신 실패와 저장소 연결 변경은 현재 제품의 source 선택·마지막 성공 시점으로 설명한다. 일괄 캐시 제거·재수집·정체불명 라이선스 삭제를 수행하지 않는다.

실제로 실행한 확인: 관련 소스·schema·최근 Git 이력 읽기, 수정 diff 읽기, 전달된 운영 JSON 두 파일 읽기, 위 공개 REST GET 12건, GitHub/SPDX/Licensee/Rust 공식 문서 열람, `git diff --check` (exit 0, 출력 없음). 코드의 함수나 UI를 실행하는 검증 명령은 실행하지 않았다.

독립 `gpt-6.1-sol / xhigh` 소스 리뷰에서 공백 메이커 이름과 유효 SPDX 조합을 버리는 P2 회귀 1건(confidence 9/10)을 발견했다. 이름이 비면 정규화된 SPDX로 대체하도록 수정했고, 후속 좁은 독립 리뷰는 해당 P2 해결 및 추가 actionable finding 없음으로 완료됐다. 두 리뷰 모두 테스트를 실행하지 않았다.


## UI·운영 통합 확인

PR380 https://github.com/JRVector9/nomorevibe/pull/380의 최신base CI38202319232 실제 success 후 일반merge3aba236. UI PR382 https://github.com/JRVector9/nomorevibe/pull/382와 최초수집 PR381도 필수 CI 통과·병합했고 최종main33349ed1352caabcb434ac4906bc2a2213ac2a51의 CI38203533979/worker·web이미지생성 success 후 운영반영했다.

기존 모든 사실 항목을 유지하며 값20→18px, 좌우여백18→14px, 세로여백12px로 조정했다. 라이선스 값의 안내버튼은 GitHub 대표 자동판별과 미검증 메이커 선언을 구분하며, MIT/Apache/BSD/ISC/GPL/LGPL/MPL/AGPL/Unlicense/CC0 13행 조건표·공식 원문 링크를 제공한다. 식별자를 제품의 모든 파일·의존성에 관한 완전한 법적 검증으로 해석하지 않는다. license-null에는 임의라이선스칸을 만들지 않는다. 실패 후 이전값은 수집시점·갱신실패상태로 한정하고 제공된 일반 license API URL을 저장소 LICENSE 파일 링크로 오인하지 않게 표기했다.

독립 UI 소스리뷰에서 focus outline clipping, 배경scroll잠금, native close→reopen 경합 P2를 수정했다. 마지막 좁은 gpt-6.1-sol/xhigh 리뷰 actionable findings 없음. 공개 표본14 GET에서는13행표·안내dialog HTML, 실제정보칸 유지, aet-go의null생략, agent-studio-2의이전수집표시를 확인했다. 모달 클릭/ESC/가로·세로scroll/초점 실제 UI 테스트는 사용자직접검증 범위다. 운영14앱19컨테이너 정상·runtime환경일치·네기능ON·DBjournal75/소개검수pause 유지 확인. 실제 repo_urlnull 공개제품이0이라 primary삭제 후 visible secondary fallback분기는 운영표본으로 검증하지 않았다.

추가 targeted GET2곳도 실제HTTP200: 미식별 agentmesh-officialrecruitment는6facts/13행안내표/식별미확인, 자동복구 opencovibe는6facts/미수집안내없음. 앞선14곳과합쳐16개서로다른공개페이지 응답을확인했다. UI 상호작용 테스트는 수행하지 않았다.
