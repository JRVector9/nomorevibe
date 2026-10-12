# 2026-10-13 — 상세페이지 저장소 미수집 안내의 원인

‘저장소 정보는 아직 수집하지 않았습니다’는 실제 작업 상태를 뜻하지 않는다. `FactsStrip.tsx`는 저장소 URL이 있고 저장소 소멸이 확정되지 않았으면서 `repository.facts`가 없으면 이 문구를 표시한다. 따라서 아직 수집하지 않은 경우와 수집에 실패한 경우가 같은 문구로 나온다.

## 상세 정보가 만들어지는 경로

헤더의 스타 수와 상세 근거는 별도 수집 경로다. 스타 관측이 성공해도 기여자·라이선스·최근 코드 업데이트·릴리스 등 상세 근거가 바로 생성되는 것은 아니다.

상세 reader는 현재 제품 저장소와 같은 정규화 키의 `product_evidence_sources`에서 `normalized_facts.type=github_repository`인 값을 읽는다. 연결된 `product_links.visible=true`도 필요하다. URL이나 다른 저장소의 자료만으로 대체하지 않는다. 이미 성공한 자료가 있으면 후속 수집 실패만으로 그 자료를 지우지 않는다.

`product-evidence-refresh`는 crawler 역할에서 1분마다 요청된다. 25초의 협조적 작업 예산 내에서 요청 수집과 갱신 대상 순회를 수행한다. 최초 수집 복구는 처리할 요청이 없을 때 한 번에 최대 한 제품을 접수하며, 일반 갱신과 예산을 공유한다. 설정 행은 없으므로 기본 GitHub 근거 갱신 간격 24시간·조회 batchSize 20이 적용된다. batchSize는 한 번에 읽는 후보 수이며 매분 20건의 수집 완료를 보장하지 않는다.

운영 경로는 사이트와 저장소 관계 확인 후 GitHub 저장소·언어·기여자·릴리스·README를 수집한다. 보조 요청이 실패하면 해당 회차의 새 근거 전체 저장을 보류하고 실패/재시도 상태를 기록한다. README 없음은 허용한다. 작업 예산이 끝나도 부분 근거는 확정 저장하지 않는다.

## 운영 DB 확인 — 10월 13일 04:50 KST

read-only transaction으로 공개 상태 `seeded`/`verified`이고 정규 GitHub 저장소 URL이 있는 43,203개를 조회했다. 전체 표본에는 공개 상세와 목록에서 추가 조건으로 제외될 프로젝트도 포함되므로 아래 숫자는 ‘안내 문구가 표시되는 페이지 수’가 아니다.

| 분류 | 수 |
| --- | ---: |
| 현재 연결에 표시 가능한 GitHub 상세 근거 있음 | 40,403 |
| 현재 저장소 연결 행 없음 | 1,046 |
| 연결은 있지만 현재 저장소 수집 source 행 없음 | 1,593 |
| source는 있지만 최초 정상 근거 없음 | 161 |
| 숨김 연결 | 0 |

근거 없는 source 161개의 실제 오류는 `not_found` 142개, `rate_limited` 12개, `collection_failed` 5개, `http_403` 1개, `invalid_response` 1개다. GitHub의 `not_found`만으로 삭제와 비공개 전환을 구별할 수 없다. 연결/source가 없는 2,639개를 모두 사용자 요청 큐의 대기 건수로 해석해서도 안 된다. 별도 refresh 요청은 당시 미완료 11개, 즉시 도래 9개였다.

잡의 마지막 성공은 `2026-10-12T19:49:08.239Z`, `last_error=null`이며 다음 요청은 실행 중이었다. 연속 두 조회에서 표시 가능한 근거가 40,401 → 40,403으로 증가했고 순회 cursor도 이동했다. 수집 전체가 중단된 상태는 아니다. 다만 실패 표본의 재시도 예정 시각이 이미 지나도 아직 첫 성공이 없어 재시도 지연과 순회 처리량을 별도로 개선할 여지가 있다. 전체 복구 완료 시각은 측정하지 않았다.

## 실제 페이지와 DB 상태 대조

운영 웹 release `de55c8e8182de49ad05cc23018f3c3b4bce4c25a`의 curl GET으로 확인했다.

| 페이지 | DB의 상태 | 실제 안내 |
| --- | --- | --- |
| `vision-studiox-instrument-grade-local-ai-generation` | 현재 저장소 연결/source 없음 | 미수집 문구 표시 |
| `domain-intelligence-api` | 연결 있음, source 없음 | 미수집 문구 표시 |
| `ampwise`, `amplifood` | 최초 수집 rate_limited 실패 | 미수집 문구 표시 |
| `cv-4` | 최초 수집 not_found 실패 | 미수집 문구 표시 |
| `manimgx` | 근거 있음·수집 성공 | 문구 없음, 기여자/최신 버전 표시 |

별도로 ManimGX·skills-46·mygo·baocut-2·linkedin-agent·OpenFilm·Clawsweeper 7개에서도 문구가 없는 것을 확인했다. 이전 ManimGX 화면의 미수집 문구를 현재 운영 상태로 해석하지 않는다.

수정한다면 **대기·실패/재시도·접근 불가 안내를 실제 상태에 맞게 나누고**, **최초 수집과 도래한 재시도의 처리 지연을 줄이는 것**이 우선이다. 이번 요청은 원인 설명이므로 수집 정책·잡·DB·표시 코드는 변경하지 않았다. 사용자가 중단한 소개 검수도 재개하지 않았다.

소스 위치: `components/product-detail/FactsStrip.tsx`, `lib/domain/products/detail-view.ts`, `lib/jobs/products/evidence-refresh.ts`, `lib/domain/evidence/refresh.ts`, `lib/domain/evidence/providers/github.ts`, `lib/domain/evidence/settings-store.ts`, `lib/jobs/runner.ts`. 안전한 로컬 증거는 운영자 폴더의 `detail-diagnosis.json`, `detail-page-proof.json`이다. 비밀값이나 전체 원시 근거를 조회·문서화하지 않았다.
