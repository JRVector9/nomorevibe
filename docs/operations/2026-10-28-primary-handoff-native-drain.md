# 주·예비 인계가 원격 모델 요청을 끊는 결함

## 원인과 근거 범위

사용자가 제공한 운영 경과에서는 mini 예비 reviewer가 M3 주 reviewer에 역할을 넘기는 순간 Supa 요청이 취소되고 종료 미확정이 재발했다. 이 PR은 main `749763e8`의 해당 실행 경로를 추적하고 로컬 회귀로 검증한다. 운영 로그·DB를 새로 조회하거나 공유 모델을 호출·중단하지 않았다. 첫 배포 중 발생한 `8859d0a0`의 개별 원인을 이번 소스 검토만으로 확정하지 않는다.

기존 경로는 다음과 같다.

1. `runRoleCandidate`가 안정적으로 기다리는 주 후보를 확인하고 `primary_handoff`로 active signal을 abort한다. 인계 중에는 역할 lease를 계속 갱신한다.
2. `superviseWorker`는 원인을 구분하지 않고 자식에게 SIGTERM을 보낸다.
3. `withRuntimeProcess`는 같은 AbortSignal로 새 회차 중단과 진행 중 회차의 HTTP 취소를 처리한다. AI1은 `ctx.signal`을 모델 호출에 전달한다.
4. `reviewAgentReviewModelCapacity`는 실제 종료 증거 없이 끊긴 전송을 `local_abort`/`indeterminate`로 기록한다. 클라이언트 연결 종료는 원격 모델 종료 증거가 아니므로 이 처리는 유지해야 한다.

즉 인계 코드의 “drain” 의도와 자식 프로세스의 실제 취소 동작이 달랐다. 추가로 기존 45초 drain은 reviewer의 최대 작업 한도 180초보다 짧아, HTTP 즉시 취소만 제거해도 정상 회차가 강제 종료될 수 있었다. 또한 한 번 abort된 인계 signal은 뒤이어 발생한 lease 상실을 다시 전달할 수 없었다.

## 변경

- 자발적 `primary_handoff`는 SIGTERM 대신 고정 IPC `{type: "runtime.drain"}`을 보낸다. 일반 역할 워커의 `stopClaims`가 새 회차·다음 잡·background refill을 중단하며 이미 실행 중인 유한 회차의 transport signal은 유지한다. 회차 안의 기존 모델 처리·시간 예산은 유지한다.
- polling/host admission을 기다리던 줄도 drain을 다시 확인한다. 이미 받은 host 자리는 반납하고 새 회차를 시작하지 않는다. idle sleep은 즉시 깨어난다.
- 인계 시에만 감독의 한도를 `jobMs + drainMs`로 맞추고 바깥 역할 후보는 여기에 기존 정리 여유 5초를 더한다. reviewer 기본값은 감독 225초, 바깥 후보 230초다. 이 동안 역할 lease를 갱신하고 자식의 정상 종료 후에만 기존 `yieldRoleToPrimary`를 호출한다.
- 별도 강제 취소 signal로 인계 중 갱신 거절·실패·기한 초과를 전달한다. 실제 SIGINT/SIGTERM도 인계를 중단하고 기존 취소·강제 종료 경로로 전환한다.
- IPC 전달 실패와 인계 시간 초과는 기록한다. 시간 초과·비정상 종료·lease 상실 뒤에는 정상 인계로 기록하지 않는다. 프로세스 그룹 정리·종료 관측은 기존 순서를 따른다.

선택한 방법은 원격 종료 증거·장부의 보수적인 점유 정책을 보존하면서 잘못된 취소 원인을 제거하는 것이다. 모델·용량·DB schema·기존 운영 설정 변경은 없다. 진행 중 회차 전체를 마치므로 인계가 기존보다 늦어질 수 있다.

## 검증과 운영 적용 경계

새 회귀는 실제 자식 IPC + 로컬 HTTP 응답 유지/취소, 원본 native terminal과 정확한 usage 보존, 새 회차/refill 금지, 지연된 host admission 반납, 60초 drain 중 lease 갱신, 인계 중 lease 상실·종료·전달 실패·시간 초과를 다룬다. 로컬 native gateway fixture는 운영 Supa 호출이나 DB 정산의 실측 근거가 아니다. 실제 실행 결과는 PR과 작업 보고서에 기록한다.

이 수정은 자발적 주·예비 인계 경로에 한정한다. 실제 배포 SIGTERM, 프로세스 강제 종료, 연결 장애, 모델 timeout에서 원격 종료가 확인되지 않으면 미확정은 여전히 필요하다. 기존 미확정 요청을 임의 해제하거나 자동 재시도·가짜 종료/사용량 증거를 추가하지 않는다. 독립 AI1/AI2 consumer의 SIGTERM 동작도 바꾸지 않는다.

병합·배포는 이 작업 범위 밖이다. 운영 적용 후에는 원래 승인된 배포 절차로 주·예비를 교체하고, 자연 인계에서 `supervisor.stopping`의 `stopMode=drain`·`sentSignal=null`, 실제 native terminal과 도메인 결과 저장, 자식 종료 후 yield, 미확정 증감 여부를 대조해야 한다. 한 번의 성공을 장기 재발 방지 검증으로 기록하지 않는다.
