# AI 1차 검수의 24초 취소와 종료 미확정 점유

## 확인한 원인

운영 확인에서 2026-10-28 01:35:22Z 시작한 AI1 요청이 01:35:46Z timeout으로 끝나고 Supa의 유일한 물리 슬롯을 종료 미확정으로 점유했다. 소스의 legacy `crawl-agent-review`는 gateway 자체의 60초 제한을 `FIRST_GATEWAY_MS=24_000`으로 줄이고 있었다. 독립 item 소비자는 60초를 사용한다. 주·예비 인계의 drain 수정과는 별개의 시간 제한 경로다.

게이트웨이 HTTP 연결을 취소해도 원격 모델의 실행 종료를 입증하지 못한다. 따라서 native terminal이 없을 때 `indeterminate`를 유지하는 장부 정책은 보존한다. 워커 재시작이나 시간 경과만으로 이 슬롯을 해제하지 않는다.

## 수정

- legacy AI1의 gateway 호출에도 기존 60초 transport 제한을 제공한다.
- gateway가 포함된 reviewer pool은 108초의 내부 회차를 사용한다. 이미 설정된 worker의 110초 예산과 reviewer supervisor의 180초 한도 안이다. CLI 전용 pool은 기존 40초, Grok pool은 108초다.
- 입력 준비·job claim·모델 예약에 걸린 시간을 포함하도록 runner의 `deadlineAt`과 내부 회차 중 빠른 시각을 적용한다. 새 호출의 전체 제한과 기록 여유 2초가 남아 있지 않으면 시작하지 않는다. 슬롯·검수 동시성·모델·입력·판정 기준은 유지한다.

이는 불필요한 조기 취소를 줄인다. 60초 초과나 연결 장애의 실제 종료 증거를 만들지는 않는다.

## 현재 점유와 자동복구

현재 점유 해제는 실제 provider 종료 확인 뒤 기존 canonical 회수 경로를 사용해야 한다. `dispatch_local_ended`는 로컬 HTTP 종료의 근거이고 원격 모델 종료의 근거가 아니다. 기존 `releaseEvidencedDispatches`는 provider의 종료 성격·입증된 하드 기한 정책과 로컬 종료 사실을 함께 검증한다. 별도의 provider boundary 회수는 원 실행자·중계·모델 경계의 종료 영수증을 요구한다.

Oracle watchdog가 기존에 웹/monitor만 재시작하고 모델 요청을 제외한 것은 이 증명 차이 때문이다. 모델 복구를 추가하려면 provider의 실제 종료/취소 계약과 제한된 실행 권한을 연결해야 한다. 단순히 `indeterminate`를 TTL 만료로 지우거나 reviewer 컨테이너를 재시작하는 것으로 해결했다고 표시하지 않는다.

## 검증 기록

회귀 코드는 45초 응답의 24초 취소 방지, 60초 첫 회차 뒤 잔여시간에 새 호출 미시작, runner 잔여 61초에서 claim 미시작을 추가한다. 기존 사용자 지시에 따라 수동 테스트·TypeScript·린트·빌드는 실행하지 않았다. `git diff --check`만 실행했다. 운영 적용 및 실제 검수 재개 관측은 별도 실행 기록을 따른다.
