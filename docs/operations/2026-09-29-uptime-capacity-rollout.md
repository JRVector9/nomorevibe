# 2026-09-29 maintenance 용량 단계적 배포

## 릴리스와 사전 상태

PR #220의 최신 CI `check`와 GitGuardian 성공 뒤 main SHA
`ce64737edfc0bfc586fc428c082d060d08e0376e`로 병합했다.
배포 전 M3 주와 mini 예비 모두 SHA `20208d3c96ed92e4e931f1c91c40f6561ab12ad9`,
`autoDeploy=false`, Docker `worker` target, 역할 후보 명령, 애플리케이션/배포 `done`이었다.
전용 설정은 없어서 기본 15/3이었다. 운영 DB에 새 migration은 없다.

읽기 전용 사전 표본: 공개 웹사이트 19,365곳, 6시간 초과 13,976곳,
최근 점검 905건/시간. 15건 tick 5.626초, 최근 900건 응답 지연 중앙값 717ms,
95백분위 2.471초, 최대 6.091초였다. 6시간 전체 재확인에는 약 54건/분이 필요하다.

## 배포와 직접 확인

1. mini 예비 앱 `T6ATm-paaE03hfSsQX8-S`에 새 SHA와 `UPTIME_BATCH_SIZE=30`,
   `UPTIME_CONCURRENCY=4`를 저장·검증해 배포했다. 배포 소스 SHA 일치·`done`,
   컨테이너 healthy, 후보 `standby`를 확인한 뒤 M3 주 앱
   `7OlFqQdacbyQseQM72E7b`를 같은 설정으로 배포했다. 두 앱이 `done`, 같은 SHA였고
   lease epoch 5의 M3 주·mini 예비로 복귀했다.
2. 30/4 단계에서 실제 tick 30건을 6.698초, 9.351초, 8.819초에 저장했고
   최근 5분 150건을 확인했다. `jobs.last_error=null`, M3 컨테이너 healthy,
   CPU 표본 0.89%, RSS 197.5MiB/1GiB였다.
3. mini 예비를 먼저 60/6으로 재배포해 대기와 동일 SHA를 확인하고 M3 주를 60/6으로
   재배포했다. 배포 전환 중 mini가 정상 승계해 lease epoch 6으로 60건/15.238초를
   저장했다. mini를 정상 drain해 M3가 epoch 7로 재획득한 뒤 mini 서비스를 1복제본으로
   되살렸다. 최종 M3 `active`·mini `standby`, 같은 SHA, 둘 다 60/6이다.
4. M3의 60/6 tick은 60건/10.840초, 60건/13.092초, 60건/9.274초였다.
   최근 5분 실제 `product_health.checked_at` 저장은 300건, `jobs.last_error=null`.
   6시간 초과 건수는 13,976→13,628로 줄었고 공개 웹사이트는 19,370곳이었다.
   다섯 역할 모두 M3 주 active·mini 예비 standby로 신선하게 관측됐다.

## 경계와 후속 관측

60건/분의 짧은 구간은 필요한 약 54건/분을 넘지만 외부 사이트 수와 응답 시간이
변한다. 수시간 뒤 6시간 초과 건수·tick 25초 초과·잡 오류·DB 연결·CPU/RSS를 다시
확인해야 재확인 목표를 달성했다고 볼 수 있다. 이번 배포는 사이트별 6시간 제한,
origin별 한 요청, DB 쓰기 직렬을 바꾸지 않았다. 다른 네 역할의 앱은 여전히
`20208d3`이며 코드 변경이 필요할 때 역할별로 주·예비를 함께 교체한다.
