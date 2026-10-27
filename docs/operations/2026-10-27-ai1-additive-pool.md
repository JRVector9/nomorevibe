# AI1 추가 모델 분담 — 코드 준비

기본 `firstReview`를 유지하고 선택 필드 `firstReviewAdditional`에 최대 2개 모델을 더할 수 있다. 같은 underlying 모델의 별칭은 중복으로 허용하지 않는다. 이번 구현은 모델 이름을 추가하거나 운영 설정을 적용하지 않는다.

새 후보는 후보 ID로 안정적으로 분담한다. 동일 입력의 재시도는 앞선 제공자·모델에 고정하고, 현재 native waiting/reserved/dispatched/indeterminate 의도가 있으면 그 모델에 고정한다. 설정에서 빠진 모델의 미완료 의도는 다른 모델에 넘기지 않는다. 실제 후보·item·capacity 락, `ai1:<candidateId>` 작업 키, dispatch binding, 결과 기록 권한은 기존 경로를 유지한다.

현재 pool 어느 모델의 완료 결과든 입력·원본·정책·프롬프트·규칙 버전이 맞으면 유효하다. pool 추가는 입력 정책 해시와 AI2 정책 해시에 포함하지 않아 완료 결과 전체를 재검수하지 않는다. 승인 identity와 실패 이력은 분리한다. 동일 입력·원본·정책·버전의 자동 시도 실패/유예는 모델 제거 뒤에도 합산해 총 3회 한도와 backoff를 유지한다.

legacy와 item 소비자가 같은 선택기를 사용한다. 모델/route별 용량 거절·회로는 해당 모델만 기다리게 한다. 전역 drain·정책 변경·owner/host/epoch 관문은 기존처럼 전체에 적용된다. 저장된 `reviewConcurrency`는 전체 AI1 pool의 합계이며 별도 동시성 증설을 하지 않는다. legacy는 기존 미검수 우선·오래된 순서를 보존하는 bounded keyset을 job cursor에 저장해 막힌 모델의 앞부분이 다른 모델을 영구히 가리지 않게 한다. 한 tick 최대 32개 힌트/16개 검토 및 기존 시간 예산을 유지한다.

추가 AI1이 AI2 fallback과 같은 underlying 모델이면 그 fallback은 독립 표로 세지 않고 `needs_human`을 유지한다. 독립 fallback을 임의 추가하지 않는다. 기존 1개 AI1만 선언하는 capacity/replay manifest의 권한은 확장하지 않고, 추가 pool이 켜졌으면 해당 인증 경로를 명시 거절한다. 일반 운영 generation snapshot과 route/status 모델 목록은 pool을 반영한다. 기존 설정 폼의 관계없는 저장은 부분 병합으로 추가 모델 필드를 보존한다.

회귀 코드는 stable 분담·재시도 pin·제거된 활성 의도 보호, 모델별 대기와 전역 drain, 막힌 32개 앞부분 이후 정상 모델 접근, 완료 결과 보존, 제거 후 backoff/시도 상한, 실제 AI2 publication gate와 자기 모델 fallback 금지, route 목록·replay 거절을 다룬다. 사용자 지시로 로컬 tests/lint/typecheck/build/compile/provider probe는 실행하지 않았다. 필수 GitHub CI와 root 리뷰가 남아 있다.

운영 적용은 기존 불명확 native 요청의 실제 정산과 모델별 serving/capacity 확인 뒤 root가 별도로 결정한다. 모델 추가만으로 즉시 처리량 회복이나 수집 3천/h 달성을 주장하지 않는다. DB schema·grant·운영 앱·모델 설정 변경은 없다.
