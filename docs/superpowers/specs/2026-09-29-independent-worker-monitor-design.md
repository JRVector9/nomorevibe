# 독립 워커 장애 감시 설계

## 목적과 관측 경계

현재 `check-worker-progress.ts`는 작업 진행과 역할별 최신 서비스 관측을 확인한다. 주 후보가 살아 있으면 mini 예비 후보가 사라져도 최신 관측만으로 `overall=ok`가 될 수 있다. 다섯 역할의 주·예비 준비 상태와 scheduler 2복제본을 읽기 전용으로 검사하고, 웹·scheduler와 별도인 감시 프로세스가 결과를 운영 알림으로 보낸다.

## 구성

1. `failover-readiness`는 DB 시계로 `role_leases`, `candidate:<role>:<instance>` 관측, scheduler 복제본 관측의 나이를 계산한다. 각 역할에서 `m3-<role>`과 `mini-<role>-standby`가 최근 60초 안에 관측되고 같은 릴리스이며, 유효한 lease 소유자 하나의 active 관측과 일치해야 정상이다. 주가 격리 중이거나 예비가 사라진 상태는 degraded/alarm이다. DB 오류는 unknown이며 정상으로 바꾸지 않는다.
2. 독립 CLI는 위 결과와 기존 `readWorkerProgress()`를 합쳐 JSON 한 줄과 종료 코드 0=정상, 1=판별 불가, 2=경보를 출력한다. 정상 작업 유휴는 경보가 아니다. 후보 준비와 실제 저장 진행은 다른 필드로 유지한다.
3. M3의 별도 Dokploy monitor 앱은 30초마다 CLI와 같은 검사를 실행한다. 2회 연속 이상에서 Uptime Kuma Push에 `down`, 정상일 때 `up`을 보낸다. Push URL은 환경변수로만 주고 로그에 남기지 않는다. 신호가 끊기면 Kuma의 push timeout이 감시자 자체 중단을 드러낸다. 앱의 자체 healthcheck는 최근 검사 완료 시각만 확인하며 DB 장애 때문에 감시 프로세스를 계속 재시작하지 않는다. monitor는 DB 읽기 전용 자격과 풀1만 사용한다.

M3 monitor와 mini Kuma는 호스트가 달라 M3가 완전히 사라져도 mini가 heartbeat 중단을 감지한다. mini 전체 장애 시 Kuma도 사라져 이 구성만으로는 알림을 보장하지 않는다. 별도 외부 deadman 또는 두 번째 독립 알림 경로는 운영 알림 채널 확정 후 추가한다. monitor의 Push 연동 전에는 로그/CLI만 준비된 것으로 기록한다.

## 오탐과 오류

- 정상 drain과 주·예비 교체 중에는 한두 표본의 전환 유예를 둔다. 같은 릴리스 예비가 새 owner가 된 뒤 정상으로 복귀해야 한다.
- 후보 관측 누락, lease 만료/소유자 불일치, 릴리스 불일치, scheduler 복제본 1개 소실, DB 조회 오류를 각각 구분한다.
- Push 실패는 URL이나 응답 본문을 로그에 남기지 않고 코드만 기록한다. 실패 동안 heartbeat가 끊어져 Kuma timeout으로 드러나야 한다.
- 알림은 데이터 변경이나 워커 재시작을 실행하지 않는다. 실제 복구는 기존 Swarm/role lease가 담당한다.

## 검증

순수 판정의 예비 소실·주 인계·릴리스 불일치·lease 만료·격리·scheduler 복제본 소실을 red→green으로 시험한다. 격리 DB에서 실제 SQL과 CLI 종료 코드를 확인한다. 운영에서는 알림 대상 설정 후 monitor를 배포해 정상 Push, 한 번의 의도한 예비 중단에 따른 down/recovery, 감시 프로세스 중단에 따른 Push timeout을 확인하고 원래 상태로 복귀한다. 외부 경보 수신은 실제 수신 확인 없이는 완료로 기록하지 않는다.
