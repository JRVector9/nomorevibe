# 2026-11-01 파이프라인 논리·복구 경계 점검

기준 소스는 `f70901181e89e95e4e4a9d916b27f8a6d22a6e32`다. 전용 작업 트리에서 읽기와 소스 변경만 했다. 이 기록은 운영 DB·SSH·공급자 호출·실제 장애 복구 관측을 수행했다는 뜻이 아니다. 사용자 지시대로 로컬 테스트·lint·typecheck·build·컴파일러는 실행하지 않았다. 아래 회귀 기대값은 작성만 했으며, 필수 GitHub CI의 실제 결과가 필요하다.

## 고친 결함

### 미확인 요청의 점유를 계속 세던 관측

`lib/operations/pipeline-observation.ts`의 `modelRequestIntervals`가 `reserved`, `dispatched`, `indeterminate`를 모두 ACTIVE로 묶었다. 따라서 `dispatched → indeterminate` 뒤 늦은 정산이 오거나 정산이 없으면 그때까지 점유가 이어졌다. 이 값은 같은 파일의 `integrateModelSlots`로 들어가 장비 포화·빈 슬롯 대기·사용 시간 근거를 왜곡했다.

2026-10-30 소유자 결정과 `lib/llm/capacity-states.ts`에 맞춰 공통 `MODEL_CAPACITY_OCCUPYING_STATES`를 사용한다. 미확인 전환 시각에 점유는 끝나고, 미확인 사건·사람 검토 행은 그대로 보인다. 실제 입장·정산 정책은 바꾸지 않았다.

회귀 기대값: 늦은 정산이 있는 요청과 정산 없는 요청 모두 미확인 전환에서 점유 종료, 그 뒤 다른 대기를 빈 슬롯 대기로 계산. 기존 DB rollout fixture의 구식 기대값도 수정했다. 해당 fixture의 점유는 `[1분,10분)`과 `[35분,40분)`으로 총 14분이고, 대기 22분은 빈 슬롯 11분·포화 8분·정책 미상 3분이다. 이는 소스의 고정 시간표를 읽어 계산한 기대값이며 실행 결과가 아니다.

### 이전 boot의 만료된 예약이 마지막 일감을 숨기는 선택기

`lib/llm/capacity-busy-targets.ts`의 `busyMemberKeysSql`, `busyLogicalKeysSql`은 상태만 보고 모든 waiting/reserved 행을 busy로 셌다. 호출하는 선택기는 사유 번역·후보 소개·제품 번역·한국어 소개·검색 프로필이다. 이전 boot의 마지막 요청이 만료됐어도 선택 단계에서 모든 대상이 빠지면 `requestSlot`에 도달하지 못한다. 만료를 쓰는 `expireRequests`는 입장·예약 관련 API 안에서만 실행되므로 다른 경로의 입장이 없으면 그 일감이 다시 선택되지 않는다.

선택기가 waiting의 `queue_until`, reserved의 `reserved_until`을 DB wall clock과 비교한다. 만료된 미전송 요청은 대상을 숨기지 않으며, 다음 정상 입장이 control 잠금 아래에서 만료·중복·소유권을 다시 판정한다. 선택기는 장부를 쓰거나 만료 사건을 만들지 않는다. dispatched는 기한에 상관없이 busy다. 스키마상 불가능한 NULL 기한도 읽기 경계에서는 보수적으로 busy로 유지한다.

회귀 기대값: waiting/reserved의 만료·미만료, dispatched의 오래된 기한, NULL 기한을 member/logical 두 선택기에서 구분한다. 실제 DB를 사용하는 CI 회귀에는 마지막 제품 한 건만 예약한 뒤 이전 예약 기한을 fixture에서 만료시키고, 다른 입장 없이도 선택되는지, 선택만으로는 상태가 바뀌지 않는지, 다음 canonical 입장이 `reservation_expired`를 남기는지 포함했다. 실행하지 않았다.

## 검토한 경계와 근거

- 수집: `lib/crawl/jobs/fetch.ts`, `lib/crawl/jobs/judge.ts`, `lib/crawl/star-auto-approval.ts`에서 원본·판정 분리와 별 자동 승인의 최신성/저장소 identity 검사를 확인했다. 네트워크 경계는 `lib/net/fetch.ts`의 hop별 public URL 검사, `lib/crawl/github.ts`의 API-origin 제한 redirect를 읽었다. 이 범위에서 새 보안 취약점을 확정하지 않았다.
- AI1·AI2: `lib/crawl/jobs/agent-review.ts`, `lib/crawl/jobs/second-review.ts`, `lib/crawl/second-review-stale.ts`, `lib/llm/capacity-repository.ts`의 입장·공통 상태·만료·최종 쓰기 경계를 확인했다. 미확인 행을 슬롯으로 되돌리거나 dispatched를 TTL로 해제하지 않았다.
- 승인·발행: `lib/crawl/publish.ts`, `lib/crawl/publication-guard.ts`, `lib/crawl/jobs/publish.ts`, `lib/operations/categories.ts`의 원본 snapshot·수동 분류 revision·발행 승인·최종 job lease 확인을 읽었다. 아래 publisher hold 경계를 보완했다.
- 번역·후처리: `lib/crawl/translations.ts`, `lib/crawl/reason-translation-model-capacity.ts`, `lib/jobs/products/translations.ts`, `lib/domain/products/product-translation-model-capacity.ts`, 한국어 소개·검색 프로필 잡과 busy 선택기를 읽었다. 11월 1일 `JobOutcome.deferred.processed` 처리와 retry backoff overflow cap은 유지했다.
- 진행 분류: `lib/operations/worker-progress.ts`, `worker-progress-query.ts`, `text-stage-progress.ts`, `job-health.ts`, `capacity-admission-block.ts`를 읽었다. 진행 출력·공급자 실패·명시 중단·입장 대기를 별개로 보존하며 경보를 없애는 임시 유예를 추가하지 않았다.

## 추가로 고친 복구·쓰기 경계

### 소유를 잃은 publisher의 분류 hold 쓰기

`lib/crawl/jobs/publish.ts`가 기다린 분류 호출 뒤 `holdClassification(candidate, snapshot.document)`를 부르며 `ctx.lease`를 넘기지 않았다. `lib/operations/categories.ts`의 hold 함수는 stage와 정확한 원본 hash를 잠그지만 raw transaction에 job lease/DR writer fence가 없어, 긴 분류 호출 뒤 소유를 잃은 publisher도 1시간 hold를 쓸 수 있었다.

발행 호출자가 `ctx.lease`를 넘기고, hold는 기존 `withJobLeaseWrite`의 fence-first transaction에서 stage→candidate→document→category→jobs 순서를 지킨다. 쓰기 전후 wall-clock lease 검사를 넣었다. 직접 controller 호출도 stage를 잡기 전에 writer site를 검사하므로 fenced site에서 hold를 만들지 못한다. 수동 분류의 revision·원본 보호와 기존 직접 hold API는 유지했다.

회귀 기대값은 실제 stage lock 대기 중 job lease를 만료시켰을 때 hold가 남지 않는 경우와, worker/direct 호출 모두 fenced site에서 쓰지 않는 경우다. 기존 유효 worker·직접 hold 회귀도 계속 적용된다. 실행하지 않았다.

### GitHub 여유 관문 대기와 일부 consumer 관측의 잘못된 진행 분류

제작 근거 consumer의 `github_headroom_low` 대기는 실제로 60초 쉬지만 `pausedUntil`에 들어가지 않았다. 진행 분류는 `pausedUntil`만 읽었다. 기존 `agentScanProviderPause`는 live service와 metric의 완전성·현재 child를 결속하지 않아 disabled consumer의 null이 정상 대기 판정을 방해하거나, 일부 consumer의 metric만으로 전체 대기를 주장할 수 있었다.

consumer는 실제 다음 quota poll까지만 `headroomPausedUntil`을 관측하고 step에서 결정한 뒤 쉬기 전에 관측을 보낸다. quota 비율·자격·다음 poll·claim 정책은 바꾸지 않았다. `AGENT_SCAN_HEADROOM_WAIT_MS`가 실제 sleep과 분류 상한에 공통으로 쓰인다.

분류는 켜진 running/starting service 전부에 대해 신선한 scan 관측, 같은 instance, `running=0`, supervisor의 `childPid`와 child의 실제 `process.pid`, child의 시작 시각이 해당 spawn 직전 하한보다 이르지 않음을 요구한다. 두 PID는 같은 supervisor가 띄운 child의 동일 PID namespace 값이다. 독립 생성되는 supervisor/child UUID를 같다고 가정하지 않았다. disabled service는 제외하지만 상태가 running으로 남은 consumer의 관측이 오래되거나 현재 child 증거가 빠지면 대기 판정을 하지 않는다. headroom의 기한은 실제 관측 시각+60초를 넘을 수 없다. 실제 provider 오류의 기존 경보 우선순위와 consumer_missing은 유지한다.

회귀 기대값: disabled consumer 제외, live consumer의 일부 관측 누락, 이전 child PID/시작 시각, 오래되거나 미래인 관측, 진행 중 scan·systemic halt, 만료되거나 임의로 긴 headroom 대기, 공급자 장애 경보·consumer_missing 보존, 실제 sleep 전에 child의 quota 대기 관측. 실행하지 않았다. 혼합 배포에서 예전 child가 pid를 아직 내지 않으면 그 consumer의 대기를 증명하지 않으며 기존 경보가 유지된다.

후속 소스 리뷰에서 `worker-supervisor.ts`의 `bootedAt`이 spawn 뒤 부모가 다시 실행된 시각이라, 부모가 늦게 스케줄되면 실제 현재 child의 시작보다 늦어질 수 있음을 확인했다. `1f16b329` 위의 후속 변경은 해당 child를 spawn하기 직전 시각을 별도로 잡아 관측 `bootedAt`에만 쓴다. 초기 건강·heartbeat·progress의 기존 spawn 뒤 시계와 timeout·drain 계산은 유지한다. 관측의 재시작 이력·이전 boot 교체 순서는 같은 child spawn의 하한 시각을 사용하며 부모 전체 프로세스의 시작 시각을 재사용하지 않는다. production supervisor의 spawn mock 안에서 시계를 앞으로 옮겨 child 시작이 부모 복귀보다 빠른 경우를 만들고, 그 관측으로 현재 child의 60초 이내 quota 대기를 인정하며 하한보다 이른 이전 child는 계속 거절하는 회귀를 작성했다. 이 회귀도 실행하지 않았다.

## 실행·남은 증거

- 실행한 것은 저장소 파일 읽기·검색, 전용 worktree 생성, 위 파일 편집뿐이다. 테스트/정적 검사/운영 측정의 통과 주장은 없다.
- root가 변경 diff를 검토하고 필수 GitHub CI를 실행·확인해야 한다. 운영 장비의 현재 SHA·설정·대기량·직접 모델 경로·새 완료 사건, Oracle 경보·복구 실제 영수증은 root의 별도 운영 관측으로 확인한다.
- 로컬 테스트 금지가 해제되지 않은 동안 다음 담당자도 테스트를 직접 실행하지 않는다. root는 이 트리에서 `git diff -- lib tests`와 이 문서를 읽어 세 논리 단위(점유·선택, publisher hold, quota 관측·분류)를 검토할 수 있다. `docs/CODEX_HANDOFF.md` 갱신은 root가 통합 단계의 실제 상태로 수행한다.
