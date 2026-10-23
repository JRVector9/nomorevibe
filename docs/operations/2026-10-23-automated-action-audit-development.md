# PR-09 독립 감사 개발 인수인계

구현은 부모 PR-04 `f961ce58` 기반이다. 공통 큐·schema export·catalog·registry·worker·운영센터·migration journal은 부모가 통합한다. 운영 DB, 실모델, 배포, 기능 활성화는 수행하지 않았다.

## 추가한 코드

- `lib/domain/products/automated-action-audit.ts`: strict 원 결정/후보/정책 계약, 주간 층화 표본, 기반 family 독립성, 이전 결론을 가린 입력, 충분한 같은 입력의 Qwen 의미 충돌만 예외 허용, 현재 비교·서버 보호 규칙 검토.
- `lib/domain/products/automated-action-audit-repository.ts`: 당시 result input snapshot 우선 로드, 주간 최초 표본 고정·예외 quota, 공통 작업 enqueue, 현재 제품/원 결정/원 업무 pause 검증, native dispatch용 concrete input proof, same-TX finding 기록.
- `lib/jobs/products/automated-action-audit.ts`: `auditAutomatedActions(ctx)`는 표본 producer다. 모델 호출이 없다.
- `drizzle/0122_automated_action_audit.sql`: task 가산 확장·원 result+기간 unique, 주간 선정/예산 원장, record-only 비교 기록, 주간 표본/상한 변경 방지 trigger. 별도 작업 큐를 만들지 않는다.

## 부모 공통 코드 연결

공통 task/source union에 `decision_audit`·`semantic_exception`과 `actionAuditCandidateSchema`를 추가한다. 모델 입력 task는 둘 다 **audit**다. source의 대상은 `source.product.{id,slug,url,updatedAt,status}`이고 원 작업은 `decision.task`의 uptime/repo/intro에 따라 `uptime-ping`/`product-repo-review`/`product-intro-check`다. 이미 내려간 제품도 감사하므로 기존 공개 상태·product_health INNER JOIN claim 조건을 적용하지 않는다.

1. `readActionAuditPolicy()`가 비활성이면 표본 생산·의미 예외 enqueue를 열지 않는다. `LLM_ACTION_AUDIT_POLICY`의 enabled=true에서 lookbackDays/perStratum/maxAuditsPerWeek/maxExceptionsPerWeek/maxCandidates를 모두 명시하고, 최소32자 `LLM_ACTION_AUDIT_SEED`도 요구한다. 10%/5% 같은 비율이나 활성 기본값은 없다. 중단은 각 공통 task control의 dispatch를 끈다. 설정/seed 변경은 같은 주 원장의 예산을 초기화하지 않고 거부한다.
2. `auditAutomatedActions`를 `product-automated-action-audit`에 등록한다. 제안 역할은 maintenance, 1시간 주기·20초 예산이다. 같은 주 최초 표본만 고정하고 재실행은 미등록 후보만 멱등 enqueue한다. reviewer 공통 native drain은 별도로 처리한다. JOB_HOW/별도 운영 원장 단계 또는 명시 제외 사유/attention work 연결도 함께 추가한다.
3. 공통 consumer에서 후보의 `decision.modelFamily`를 읽고 `preferredAuditFamily`를 선택한다. Qwen 원판정→DeepSeek, DeepSeek/GPT-OSS 원판정→Qwen이다. unknown/alias를 임의 정규화하지 않는다. GPU/M1 Qwen은 같은 family다. 공통 backend drains는 이 감사 routing을 일반 Qwen 처리와 분리해야 한다.
4. 수집기는 **현재** 외부 page/rendered_page/readme/repository를 수집하고 `readCurrentActionAuditFacts`·`readActionAuditProtections`로 현재 DB 사실·보호를 읽는다. `buildBlindedActionAuditInput(candidate,sources,protections,facts)`를 호출한다. 이전 결론·이유·family·result/work ID는 모델 입력에 없다. 전달받은 arbitrary metadata source는 제거하고 strict 현재 사실만 서버 metadata로 만든다. 신선한 완전한 외부 근거가 없으면 `audit_current_evidence_required`: 수집/보류이며 DeepSeek 빈 근거 호출은 금지한다.
5. native dispatch의 도메인 proof는 `lockActionAuditInput(tx,candidate,input)`을 사용한다. current facts/protections를 DB에서 재구성하고 완전한 입력 hash를 비교한다. 원 result·raw 제품 revision·origin pause·source 정책은 같은 TX에서 검증한다. parent의 `nmv_local_assist_task_valid` 함수는 0122 통합에서 audit task/input subject 가산 분기를 추가해야 한다.
6. 공통 result를 먼저 같은 TX에 insert하고 work는 claimed/revision 그대로 둔 채 `recordActionAuditCompletion(tx,{candidate,workId,resultId,input,auditorFamily,outcome})`을 호출한다. 반환 comparison.status가 human_review면 원 작업에 연결한 운영 검토 대상으로 표시한다. 이 API는 findings만 쓰며 제품 내림·차단 해제·소개 복구를 수행하지 않는다. 현재 근거 불일치는 과거 오판으로 단정하지 않는다. 공통 result.applied는 false다.
7. 의미 예외는 `enqueueSemanticActionException(tx,{firstResultId,secondResultId,reason,periodStart,selectedAt,seedHash,policy})`로 넣는다. 같은 입력·source의 충분한 상반 Qwen 결과 두 개만 허용한다. capacity/transport/invalid_output/missing_evidence는 not_eligible다. 주간 한도는 새 enqueue에만 소비하고 duplicate는 소모하지 않는다. 반환 budget_exhausted는 물리 모델 capacity 대기와 다르다. 이 한도는 재시작/동시 producer가 넘어갈 수 없다. 결과로 다시 DeepSeek 예외를 만들지 않는다.

원 결정 로더는 `coalesce(nullif(to_jsonb(result)->'input','null'::jsonb),work.input)`을 사용한다. inputHash와 실제 스냅샷이 일치해야만 포함한다. 부모의 추가 nullable result.input 컬럼이 아직 없는 agent base에서도 동작한다. 복구할 수 없는 과거 입력이나 미상 모델을 추측하지 않는다. legacy operations audit 전체를 새 LLM 결정인 것처럼 임의 변환하지 않는다. `auditServerProtectionDecision`은 당시 보호 snapshot이 있는 규칙 결정의 검토용이며 independentModelAudit=false를 기록한다.

운영센터의 사람 검토 수는 `llm_assist_audit_findings`의 comparison.status='human_review'를 읽고 work_id와 원 제품을 연결한다. 원 result+period unique는 주간 재실행/semantic exception과 표본 감사 중복의 사람 기록을 합친다. 기존 product-audit 업무 의미는 바꾸지 않는다.

## 검증 기록

Node24.22.1에서 순수 회귀 10건과 격리 PostgreSQL 신규 회귀 5건을 통과했다. 격리 DB는 127.0.0.1:55574, 전용 container `nmv-llm-pr09-pg-20261023`을 사용했고 baseline migrations 후 0119/0122 SQL을 적용했다. 전역 migration journal은 변경하지 않았다. 동시 예외 producer의 주간 max1, 고정 표본·중복 작업, source microsecond 변경·원 업무 pause, DB target CHECK, immutable period, 원 결과와 같은 TX인 record-only 비교를 검증했다. 변경 파일 ESLint와 Next typegen 후 TypeScript 검사도 실행했다. 최종 정확한 commit의 전체 unit/DB/build는 부모 PR-11 단계에서 수행한다.
