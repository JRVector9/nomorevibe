# checkMini 반복 알림 수정

2026-10-27, 실제 Grok CLI 작업 결과를 운영자가 소스와 운영 상태로 독립 검토했다. 이 문서는 알림 경로와 재알림 조건의 변경을 기록한다. 번역 적체 자체가 해결됐다는 기록은 아니다.

## 원인과 변경

M3 worker 감시 결과는 mini·Oracle의 Kuma 두 곳으로 전송된다. Oracle 독립 watchdog 역시 같은 업무 경보를 두 곳으로 전송하고, 장애별 Telegram도 직접 보낸다. 네 Kuma 항목에 Telegram이 모두 연결되어 같은 장애의 DOWN/UP 네 건과 장애별 알림 한 건이 겹쳤다. Kuma의 주기적 재전송 설정은 0이었으며 실제 상태 전환이 발생했다.

2026-10-27 11:36:33 KST mini 72·73, 11:38:00 KST Oracle 1·2의 Telegram 연결만 해제했다. 대상은 worker failover와 Oracle recovery watchdog 집계 항목이다. 감시 항목·Push 수신·상태 이력·알림 수단의 정의·다른 서비스의 연결은 보존했다. mini 74·Oracle 3의 watchdog heartbeat 알림도 유지했다. 실제 Kuma 2.3.2의 전송 함수가 매번 DB에서 연결을 조회함을 확인하고, 짧은 트랜잭션과 변경 전후 해시로 네 연결만 제거했다. 감시 프로그램 재시작은 필요하지 않았다.

업무 경보는 Oracle의 기존 장애별 전송 한 경로를 사용한다. 기존 구현은 정상 표본 하나만으로 전송 완료 기록을 지워, 잠깐 정상화된 뒤 같은 장애가 나타나면 다시 통보했다. `pipeline_alarm`에 한해 600초 연속 명시적 정상 표본을 관측해야 기록을 해제한다. 정상 표본 간격이 150초를 넘거나, 보고가 누락·불완전하거나, 시간이 역행하면 연속 정상 시간을 다시 센다. 재시작 후에도 전송 완료와 정상 관측 시간을 상태 파일에서 복원한다. 아직 전송되지 않은 과거 장애는 현재 명시적으로 정상인 동안 보내지 않는다.

10분은 업무 진행 판정의 짧은 5분 창보다 길게 잡은 재알림 조건이다. 실제 업무 경보 판정·오류·대기량·모델·품질 관문은 그대로다. 새로운 장애와 provider·receiver 장애, watchdog 생존 감시의 기존 처리는 유지한다.

## 반영 및 검증 경계

코드 변경은 Oracle에 별도 설치하는 `scripts/ops/incident_notifications.py`와 회귀 사례다. Docker에서 제외되는 이 파일을 배포 범위 허용 목록에 명시했으므로 웹·워커 18앱을 다시 배포할 필요가 없다. CI 범위는 축소하지 않는다.

PR [#689](https://github.com/JRVector9/nomorevibe/pull/689)의 자동 CI `40440673155`에서 타입·린트(Python 회귀 포함)·빌드·단위2·통합6·직렬 ledger·필수 check가 통과했다. 2026-10-27 11:57:29 KST 병합 커밋은 `225965189581877e59bc5e1cac5a00b288fdfc7b`이며 main의 필수 check도 통과했다. 수동 test/lint/typecheck/build/컴파일과 합성 모델 호출·시험 Telegram 발송은 실행하지 않았다.

11:58:24 KST 병합 소스만 Oracle에 원자적으로 설치하고 watchdog 한 개를 재시작했다. 설치 SHA256은 `3b0305a89cb2050df0174c61e3ab1964e6e6df610404914ca6d9ec3f647f9550`, 새 PID는 `4036892`다. config와 상태 파일 권한0600 및 기존 pipeline 전송 완료 기록을 보존했다. 실제 배포 범위 명령은 웹·워커 selected0/retained18로 끝났고 앱 재배포는 없었다.

실제 native Grok CLI가 운영 읽기 명령을 실행해 설치 소스·config·PID·상태·자연 주기와 두 Kuma 연결을 확인했다. root는 별도 SSH 재읽기와 원본 결과 대조를 수행했다. 12:10:54 KST 재확인까지 설치 후 약12분30초·21회 자연 주기에서 notification sent0/accepted전부NULL/pending0, failedCycles0, Push·heartbeat 모두 ACKtrue였다. 마지막5회는 정상 표본이었지만 기존 incident의 sent/firstSeen과 연속 정상 시간이 보존됐다. 두 Kuma의 네 집계 알림 연결0·heartbeat 연결1과 다른 설정 보존도 확인했다.

관측 전체12분30초가 연속 정상10분을 뜻하지 않는다. 600초 연속 정상 뒤 해제·재발 통보는 자동 회귀로 확인했으며, 그 경로의 실제 장기 관측은 별도다. 사용자에게 도착한11:28·11:29·11:37·11:39·11:51 메시지는 코드 설치 전이다. 마지막 기존 incident firstSeen은11:51:34 KST로, 설치 뒤에도 유지됐다. 번역 등 업무 적체가 모두 해소됐다는 주장은 하지 않는다.

## 되돌림

이 변경의 private 영수증에는 네 연결의 이전 상태와 notifier 소스 원본·해시가 있다. 필요하면 현재 상태를 다시 확인한 뒤 이 변경에서 해제한 연결만 복원하고, notifier 원본만 복원한 후 watchdog 한 개를 재시작한다. 전체 Kuma DB·config·장애 상태 파일을 과거 시점으로 덮거나 이미 소비한 작업 영수증을 재실행하지 않는다.
