# 홈 신규·전일 대비 스타 상승 구현 보고서

상태: PR01~04 구현·부모 및 독립 소스 리뷰·커밋·푸시·최신 base 필수 CI·main 병합 완료. 마지막 구현 병합은 `ccc7ed3b3ba168a67f7dbe09ba06325b88654b00`이다. 운영 DB 적용과 배포는 아직 수행하지 않았다. 사용자가 승인한 범위는 API-key 입력을 제외한 병렬 구현·충돌 관리·리뷰·최종 보고다. [기준과 PR 범위](../superpowers/specs/2026-10-12-home-ranking-policy-proposal.md)를 적용했으며 기능 테스트는 사용자가 직접 수행한다.

## PR별 결과

| 작업 | 구현 내용 | 전달 상태 |
|---|---|---|
| PR01 [#369](https://github.com/JRVector9/nomorevibe/pull/369) | 현재 GitHub 저장소 생성일 조회, 신규 홈/전체 목록 동일 조건, 생성일 표시, 조회 인덱스 | CI [38157584835](https://github.com/JRVector9/nomorevibe/actions/runs/38157584835) 성공; main `9424d6e` 병합 |
| PR02 [#370](https://github.com/JRVector9/nomorevibe/pull/370) | 독립 8시간 관측, 회차/관측 이력, 대상 고정, 재개·마감·이력 정리 | CI [38158817772](https://github.com/JRVector9/nomorevibe/actions/runs/38158817772) 성공; main `de4c894` 병합 |
| PR03 [#371](https://github.com/JRVector9/nomorevibe/pull/371) | 닫힌 회차의 전일 대비 증가량 조회, 같은 회차 순위/전체 수/페이지 | CI [38159154251](https://github.com/JRVector9/nomorevibe/actions/runs/38159154251) 성공; main `01b9d6d` 병합 |
| PR04 [#372](https://github.com/JRVector9/nomorevibe/pull/372) | 새 제목·증가량·관측 시각·자료 부족 상태, /rising 전체 목록, 회차 유지 페이지 이동 | CI [38160248035](https://github.com/JRVector9/nomorevibe/actions/runs/38160248035) 성공; main `ccc7ed3` 병합 |

모든 서브에이전트와 독립 Codex 리뷰는 `gpt-6.1-sol / xhigh`다. 독립 worktree와 파일 소유권으로 병렬 작업을 분리했다. 부모는 PR01/04의 공통 화면 파일을 순차 통합하고 관측 migration을0074로 조정해 PR01의0073과 번호 충돌을 해결했다. 기존 PPT·prototype·미추적 자료와 중단한 소개 검수는 보존했다.

## 확정한 기준과 표시

**최근 7일에 생성된 프로젝트**

- KST 오늘00시에 끝난 완료된7일 동안 GitHub 저장소가 생성된 프로젝트다. 최근 서비스에 등재된 오래된 저장소는 제외한다.
- 스타50개 이상, 기본 공개 범위, 정상 저장소·생존 조건을 적용한다. 생성일 미상/잘못된 메타/현재 저장소와 다른 과거 메타는 제외한다.
- 생성일 최신순이며 홈5개와 `/?new=1` 전체 목록15개가 같은 조건을 사용한다. 일반 최신순의 서비스 등재일 정렬은 유지한다.
- 상단 신규 요약의 스타 제한 없는 전체 수와 스타50개 이상 목록 수를 구별해 설명한다.

**전일 대비 스타 급상승**

- KST00·08·16시 마감의 회차 T와24시간 전 같은 회차를 비교한다. 실제 관측 간격은23~25시간이어야 한다.
- 이번 회차의 스타50~1,999개, 전일 순증가10개 이상, 두 회차 모두 성공 관측인 프로젝트만 포함한다.
- 동일 제품·저장소 URL·연결 버전·GitHub 저장소 ID가 일치해야 한다. 삭제 후 같은 URL에 재생성된 저장소나 A→B→A 재연결의 과거 관측을 섞지 않는다.
- 순증가 내림차순, 회차 스타 내림차순, 회차에 고정한 slug 오름차순이다. 새 발굴과 현재 스타 값 변경이 닫힌 회차의 순위를 다시 계산하지 않는다. 현재 차단·삭제·공개 범위·생존 상태에 따른 숨김은 유지한다.
- 홈5개와 `/rising` 전체 목록15개가 같은 조회를 사용한다. 페이지 이동은cycle을 유지하고 새 회차로 바뀌면 최신 목록으로 새로고침하도록 안내한다.
- 제목/카드에 전일 증가량을 표시하고 집계 기준·다음 예정·관측 성공/대상/실패 수 및 실제 관측 시각을 제공한다. 첫 관측·전일 자료 없음·지연·실패·비교 자료 없음·조건 충족 없음·만료 상태를 구별한다.

## 관측 자원과 최소 구현

- 기존 scheduler/worker와 crawler 역할 lease, GitHub collector 인증·quota·50개 묶음을 재사용한다. 별도 발굴 파이프라인이나 AI 호출을 추가하지 않았다.
- `stars` lane은 분당 DB에서 재개 여부를 점검하지만 GitHub 수집은 각 마감 직전1시간에만 한다. 회차 시작에 대상·정책을 고정하고, 마감 후 요청 시작/관측 쓰기를 차단한다.
- 기존20시간 `product-stars-refresh` writer와 일반 StarMetric은 유지한다. 기존 주간 추천의 대체 목록은 새 급상승 조회와 구별한다.
- 새 회차/관측 두 표에7일 이력을 보관한다. 기존 시간별 maintenance가 최대1,000개 관측과3개 빈 회차를 정리한다.
- migration `0073_repository_birth_lookup.sql`은 현재 저장소 메타 조회 인덱스, `0074_product_star_observations.sql`은 관측 스키마와 최소 저장소 연결 버전 trigger다.

## 리뷰와 검증

| 발견 사항 | 심각도 / 원문 확신도 | 반영 |
|---|---|---|
| 현재 저장소 원본이 있어도 이전 발행 후보 연결 때문에 신규 누락 | P2 / 미기재 | 현재 URL로 원본 조회 |
| 관계 extras decoder 유실로 Date 계약 위반 | P3 / 미기재 | 조회 후 명시적 Date 변환 |
| 신규 전체 목록에서 급상승 메뉴 활성 표시 | P3 / 미기재 | 헤더 guard |
| lower(repo) 반복 조회 인덱스 없음 | 부모 검토 | 표현식 복합 인덱스 |
| 인증·quota 대기가3회 재시도 소모 | P2 / high confidence | 예약 attempt 반환과 대기 상태 유지 |
| 토큰 준비 지연으로 회차 마감 후 요청 시작 | P2 / high confidence | 선택적 absolute deadline 전체 전달 |
| 느린 optional App mint가 정상 PAT/cached App 사용 차단 | P2 / high confidence | 요청 예산5초 확보, 뒤 정상 캐시 계속 수집 |
| cold App-only 준비 결과 없음이 전송 실패로 계산 | 부모 검토 | deadline 경로만 인증 대기로 처리 |

수정 경로와 신규·조회·UI의 독립 소스 재리뷰는 추가 지적 없었다. 부모는 스키마·인덱스·저장소 식별·lease/deadline·기준/표기를 소스와 대조했다. 이는 실행 테스트가 아니다.

사용자 요청대로 새 테스트를 작성하지 않았고 로컬 테스트·typecheck·lint·build·E2E·브라우저 앱 실행은 하지 않았다. 기존 의미 변경으로 영향을 받은 fixture/기대값만 최소 수정했다. `git diff --check`와 protected-main의 최신 base 필수 원격 CI를 구별해 확인했다.

PR04 첫 CI [38159743423](https://github.com/JRVector9/nomorevibe/actions/runs/38159743423)는 통합3개 성공, quality의 기존 화면 테스트6개 실패였다. 원인은 예전 급상승 호출·피드 앞5개 건너뛰기·헤더 링크 기대와 전용 reader mock 누락이었다. `tests/home-unclaimed.test.tsx`, `tests/p12-head-chrome.test.tsx`의 기존 fixture/기대값을 보완했다. 후속 CI [38160248035](https://github.com/JRVector9/nomorevibe/actions/runs/38160248035)는 head `25f83db`, 최신 base `01b9d6d`에서 scope·quality·통합3개·check 모두 성공했고 정상 병합했다. 첫 실패 결과와 후속 성공을 구별해 기록한다.

## 운영 상태와 남은 확인

이번 단계에서 DB migration·운영 배포·자격 정보 입력·회전·제공자 설정·스타/피드백 flag ON은 수행하지 않았다. GitHub App 키의 이전 저장 설정 준비와 실제 runtime 적용은 구별한다. Resend 입력 및 사용자 직접 GitHub webhook secret Save는 기존 활성화 작업의 대기 항목이다.

운영 적용은 [워커 운영 절차](independent-workers-runbook.md)에 따라 이미지 발행 확인, 소비자 drain, migration0073/0074 한 번 적용·검증, 같은 SHA의 관측 워커 배포 순서가 필요하다. stale 로컬 .env의 DB를 운영 적용에 사용하지 않는다.

새 순위 확보에는 정상 회차가 최소4개, 같은 시간대24시간 전 비교 쌍이 필요하다. 공개 UI 전환은 자료 축적 뒤 진행한다. 과거값을 현재 회차로 복사하거나 현재 스타를 과거값으로 만들어 채우지 않는다. 실제 처리량·성공률·DB 비용·브라우저 동작은 아직 측정하지 않았다.

사용자 직접 확인 기대값:

- 신규: 최근 등재된 오래된 저장소 제외, 기간 시작 포함/끝 제외, 생성일 표시, 홈/전체 목록 조건과 순서 일치.
- 급상승: 스타49/50/1,999/2,000과 증가9/10 경계, 실측23/25시간 경계, 홈/전체 목록 상위5개 일치, 회차 유지·만료 새로고침.
- 자료 부족/실패: 각 사유가 사실대로 표시되고 예전 일평균 목록으로 대체되지 않음.
- 관측: 창 밖 GitHub 요청0, 마감 후 쓰기 차단, 재시작/역할 교체, 저장소 재연결·재생성 관측 미혼합, 비공개/차단/삭제 숨김,7일 이력 정리.

위 항목은 확인 기대값이며 테스트 성공 기록이 아니다.
