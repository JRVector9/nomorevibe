# PR-09 의미 충돌 예외와 이전 결론을 가린 독립 표본 감사

상태: **공통 소비자 연결·범위 검증 완료 · 최종 통합 대기** · 제안 브랜치: `feat/qwen-first-exceptions-audit-integrated` · 설계 기준: `c37ae82f`

선행 PR: [PR-01](PR-01-contracts-evaluation.md), [PR-02](PR-02-direct-capacity.md), [PR-04](PR-04-work-uptime-candidates.md), [PR-05](PR-05-uptime-confirmation.md), [PR-07](PR-07-repository-move.md), [PR-08](PR-08-intro-recheck.md). 이 번호는 설계 순번이며 GitHub PR 번호가 아니다.

03은 M1 route 활성화에만 필요하며 GPU 구현의 선행 조건은 아니다.

## 구현 상태와 실제 검증

실제 통합 브랜치는 `feat/qwen-first-exceptions-audit-integrated`다. GitHub PR URL은 발행 뒤 통합 담당자가 기록한다. `product-automated-action-audit`는 maintenance에서 매시간 20초 예산으로 표본·충분한 상반 Qwen 예외를 생산한다. 추론은 별도 `product-llm-assist-audit-review` 잡/reviewer `assist-audit` 줄에서 105초 예산으로 수행하며 일반 Qwen 결과 저장·다음 회차 lease와 분리했다.

GPU/M1 Qwen은 같은 family로 판정하며 Qwen 원결정의 독립 모델은 DeepSeek다. 이전 결론·이유·confidence·원 모델명을 가린 현재 근거를 서버가 다시 검증한다. 명시한 주간 표본·예외 한도 외에 실제 UTC 주간 `dispatched_at` 호출 수도 같은 capacity 제어 TX에서 검사한다. 서로 다른 frozen period 키로 현재 주간 호출 한도를 우회하지 못한다. 설정이 없으면 off다. 불일치는 사람 확인 finding만 저장하며 제품·소개를 자동 복구하지 않는다.

실제 격리 DB/localhost 모델 HTTP 신규 10건과 기존 감사 5건, 총15건이 통과했다. DeepSeek 응답 대기 중 일반 Qwen의 새 job token 두 회차 완료, 독립 family·블라인딩·pause·주간 실제 호출 한도·임의 JSON 권한 거절을 포함한다. domain unit 10건·범위 ESLint·Next typegen·tsc도 통과했다. 초기 pause fixture의 과한 기대는 정상 예약 취소 `withdrawn`/미dispatch/attempts0을 확인하도록 수정했다.

후속 리뷰의 초기 조회/제품 잠금 순서 수정과 최종 통합 SHA의 경합·전체 검증은11에서 확인한다. [구현 인수인계](../../operations/2026-10-23-automated-action-audit-development.md)에 API·source 계약을 남겼다. 운영 감사 설정이나 자동 적용은 활성화하지 않았다.

## 문제와 결과

모든건DeepSeek주처리는병목을만든다.같은Qwen의GPU/M1합의는독립감사가아니며기존결론을보여주면동조·라벨반전이생긴다.

입력은출처작업·원모델family·정책버전·결정시스냅샷과현재근거다. 모델에는이전결론을숨긴다. 출력은독립적인기대상태이며실제조치와의비교·사람큐발생·최종변경은서버권한이다.

## 수정 범위

- 충분한근거의의미충돌만DeepSeek예외큐로보내고용량대기·형식오류·수집실패를별도분기한다.
- uptime/repo/intro의결정로그에서층화·무작위표본을재현가능하게선정한다. 감사비율은임의로고정하지않는다.
- 원판정기반모델을기록하고Qwen원판정은DeepSeek,다른기반모델원판정은Qwen도독립후보로쓴다.
- 이전결론·이유·confidence를가린독립기대상태와현재실제조치를서버가비교해엇갈림만사람큐/운영센터로보낸다.
- product-automated-action-audit는 주간 표본·예외를 공통 큐에 넣고 종료한다. 실제 독립 모델 호출은 별도 product-llm-assist-audit-review 잡/assist-audit 줄에서 처리한다.
- 10% 예외+잔여5% 감사=14.5% 호출은 계산 예시일 뿐이다. 이번 PR에서 이 비율을 기본 활성화하지 않고 표본·상향·호출 예산을 명시 설정으로 두며 실측 뒤 적용한다.
- 과거 기록의 모델 family가 unknown이면 임의로 채우지 않는다. 규칙 결정의 근거 검토와 LLM 판정의 이기종 독립 감사를 구분한다.

## 포함하지 않는 변경

- 다른장비의동일Qwen을독립표로집계
- 감사불일치의자동차단해제·소개복구
- 현시점재검토필요성을과거오판으로단정
- 기존product-audit발행분감사의의미변경

## 파일과 데이터 변경

기존 파일:

- [lib/db/operations-schema.ts (operationsAudit)](../../../lib/db/operations-schema.ts)
- [lib/db/product-evidence-schema.ts (productEvidenceAudit)](../../../lib/db/product-evidence-schema.ts)
- [lib/crawl/audit-second-opinions.ts (기존감사와독립성정의대조만)](../../../lib/crawl/audit-second-opinions.ts)
- [lib/operations/dashboard.ts](../../../lib/operations/dashboard.ts)
- [app/(operator)/admin/status/attention.tsx](../../../app)

신규 제안 파일:

- `lib/jobs/products/automated-action-audit.ts` (신규 제안 경로, 구현 시 확정)
- `lib/domain/products/automated-action-audit.ts` (신규 제안 경로, 구현 시 확정)

Migration: 있음:공통 work의 semantic_exception/decision_audit kind·typed binding과 원 조치 ID+감사 기간의 멱등 키를 가산 확장한다. 별도 범용 감사 큐를 중복 생성하지 않는다. 실제 번호는 구현 시 최신 main의 journal을 확인해 배정한다.

## 검증과 완료 조건

다음은 실행 결과가 아닌 구현 시 검증 항목이다. PR별로 관련 회귀·정적 검사만 수행하고 GitHub 필수 CI를 유지한다.

- 신규: 모델family동일성·알수없는원모델·이전결론redaction·무작위선정재현/멱등·현재/과거시각분리·maker보호결정적서버감사·불일치자동복구금지
- tests/operations-attention.test.tsx
- tests/operations-work-owners.test.tsx
- tests/stage-registry.test.ts

완료 조건:

- 원모델family가같은GPU/M1은독립감사로세지않는다.
- 이전결론이모델프롬프트에없음을검사한다.
- 주간선정·재실행·재시작이중복사람티켓을만들지않는다.
- 수집실패는DeepSeek빈자료재시도대신수집/보류된다.
- 새 job 또는 실행 줄을 추가하면 lib/jobs/catalog.ts, lib/jobs/registry.ts, scripts/worker.ts의 등록·시간 예산·lane 및 역할별 DB 풀/host budget을 같이 검토한다.
- lib/operations/stage-registry.ts의 단계 또는 제외 사유, app/(operator)/admin/status/work-owners.ts의 JOB_HOW, attention.tsx의 work 연결을 함께 맞춘다.
- tests/job-catalog.test.ts, tests/stage-registry.test.ts, tests/operations-work-owners.test.tsx와 관련 운영센터 회귀를 실행한다.
- 기존 admin-job-control의 legacy/versioned/draining 지원 범위를 따른다. pause가 신규 claim을 멈추는지, 진행 중 원격 호출·pending·capacity 점유가 어떻게 drain되는지 표시·회귀 검증한다. 실제 계속 도는 소비자를 멈춤으로 표시하지 않는다.
- 원 업무(originJob/task) pause도 공통 소비자의 해당 queued work에 적용한다. claim/dispatch 확정 시 제어를 확인하고, 다른 업무·이미 in-flight 호출·resume 동작을 별도로 회귀 검증한다.
- backend와 기반 모델 정체성을 구분해 GPU/M1의 용량은 따로, 같은 Qwen family의 독립 감사 자격은 같게 판정한다.

## 적용 전 확인

- 실제자동결정의스냅샷과감사시근거를분리해사람검토한다. 예외상향비율·대기·성공·무효출력·사람큐의유효성을측정한다. 감사비율과한도는측정후결정하며Qwen정상완료를DeepSeek대기로막지않는다.

## 중단과 되돌림

- 표본선정·예외소비만끄고원작업의Qwen처리·감사원장을보존한다. 감사대기건은보류로남기며원판정을자동뒤집지않는다.

공통 정책·실데이터 평가·운영 전환 조건은 [전체 계획](README.md)을 따른다. PR 병합을 운영 쓰기·배포·기능 활성화 승인으로 간주하지 않는다.
