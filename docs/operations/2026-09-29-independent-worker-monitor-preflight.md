# 2026-09-29 독립 워커 감시 사전 검증

## 목적과 판정

기존 `check-worker-progress.ts`는 역할별 최신 서비스 관측 하나를 읽으므로 M3 주가 살아 있으면
mini 예비 소실을 놓칠 수 있었다. 새 판정은 다섯 역할의 고정 주·예비 관측, lease의
owner/boot/epoch/릴리스, scheduler 서로 다른 2복제본을 기존 저장 진행과 별도로 확인한다.
두 표본 연속 이상일 때 Uptime Kuma Push `down`, 복구 시 `up`을 보낼 수 있는 독립 monitor
이미지를 만들었다. 실제 운영 알림 수신은 아직 확인하지 않았다.

## 실행한 검증

- 전용 테스트 DB의 `readFailoverReadiness()`가 정상 crawler lease와 두 scheduler 관측을
  정상으로 보고, 예비 관측을 DB 시계 기준 70초 과거로 바꾼 뒤 `standby_missing`을 보고했다.
  독립 CLI는 다른 역할이 없는 시험 DB에서 JSON 경보와 종료 코드 2를 냈다.
- `npm test`: 156파일, 1,235건 통과. `npm run test:integration`: 97파일,
  924건 통과·기존 TODO 1건. `npx next typegen`, `npx tsc --noEmit`, `npm run lint`
  (오류 0·기존 vendor 경고 1), `npm run build`, `git diff --check` 통과.
- `docker build --target monitor -t nomorevibe-monitor:followup .` 통과.
  DB 미설정 이미지의 독립 CLI는 `overall=unknown`/종료 코드 1,
  heartbeat가 없는 이미지의 healthcheck는 종료 코드 1이었다.
- Push 동작은 로컬 가짜 Kuma HTTP 서버에 실제 POST로 `status=up/down`을 보내 확인했다.
  응답 `{ok:false}`는 일반 오류 `monitor_push_failed`로 바뀌어 응답 본문을 출력하지 않았다.

## 이전 구현의 운영 재검토

2026-09-29 00:41 KST 읽기 전용 표본에서 다섯 역할 모두 M3 primary active,
mini standby 관측 2~11초, 같은 `20208d3` 릴리스, 유효한 M3 lease였다.
crawler 문서 최근 10분 30건, publisher 발행 최근 10분 3건,
maintenance ping 최근 5분 75건, text 프로필 생성 최근 10분 54건과 검증 51건이었다.
기존 진행 CLI는 `overall=ok`, scheduler `scheduled`, 여섯 역할 `present`를 냈다.
reviewer의 최근 2분 저장은 0건이지만 당시 준비된 일감도 없어 장애로 판정하지 않는다.

publisher 승인 행 17건은 발행 정책을 통과한 적격 큐가 아니며 실제 발행 단계는 `no_work`다.
따라서 새 제품을 강제로 발행하거나 심사 정책을 낮추지 않았다. mini 예비의 신규 발행 저장은
여전히 미검증이다. 공개 웹사이트 19,365곳 중 13,976곳은 최근 6시간 점검이 없고
최근 처리량은 905건/시간이었다. 코드 상 한 틱 15건·1분 주기는 최대 900건/시간 수준이며
현재 규모의 6시간 목표에 필요한 약 3,228건/시간보다 낮다. 별도 용량 개선이 필요하다.

## 운영 연결 전 남은 것

전용 읽기 권한 DB 자격, mini Kuma의 전용 Push monitor URL, 경보 수신 대상을 확정한 뒤
publisher와 같은 `CONNECT_AGENT_URL` 설정 여부로 M3에 monitor 앱을 배포한다.
정상 Push와 예비 한 개 중단의 DOWN/회복,
monitor 자체 중단의 heartbeat timeout을 관측한다. mini 호스트 장애와 동시에 Kuma도
중단되는 경우는 별도 외부 deadman이 필요하다. 24시간 관측·백업 복구·실제 저장 정체와
반복 부팅 격리 주입은 이 검증에 포함하지 않았다.
