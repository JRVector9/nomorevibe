# 관리자 후속 — 외부 감시 수신기·개별 작업 멈춤/재개

## 변경

- 기존 read-only monitor에 선택 외부 Kuma Push 수신기를 연결한다. 한 수신기 실패가 다른 수신기 전송을 막지 않는다.
  외부 주소는 HTTPS·다른 hostname이어야 하며 로그는 대상 이름·성공 여부·시각만 남긴다.
- 운영센터 작업 상세에서 사유를 적어 개별 잡을 멈추거나 재개한다. legacy의 실제 잡만 지원한다.
  실행 중 호출은 끝까지 처리하고 요청/처리 판·커서·lease를 유지한다. 재개 시 아직 유효한 원래 재시도 시각을 복원한다.
- 관리자 세션·정확한 origin·세션 HMAC·DR writer fence를 확인한다. fence → batch → job 순서로 잠그고
  이전 제어 감사 id와 not_before를 비교해 동시/오래된 화면/ABA 변경을 거절한다.
  상세를 연 뒤 자동 갱신으로 상태가 바뀌면 폼은 제출하지 못하며 닫고 다시 확인한다.

## 실제 검증

- monitor 기존/신규 2파일 8개 PASS: 주/외부 수신 실패 격리, DOWN/회복, 비밀 비노출, 구성 거부.
- 관리자 action·기존 표시 4파일 40개 PASS, 작업 로그 13개 PASS. 단위/UI 합계 61개.
- 전용 pgvector PostgreSQL 17(127.0.0.1:55439) 2파일 27개 PASS: 신규 20개·기존 job-control 7개.
  실행 중 성공/실패/deferred 뒤 멈춤 유지, 유효 retry 복원, 동시 변경·ABA, batch/fence 거부 포함.
- Next 16.3.8 local guide 확인, next typegen·tsc --noEmit·변경 코드/테스트 ESLint·git diff --check PASS.
- root와 독립 검토 담당이 구현·잠금 순서·폼 snapshot을 확인했다. 수동 전체 unit/DB는 PR마다 반복하지 않는 AGENTS 정책을 따른다.
- 처음 로컬 HTTP 시험은 sandbox listen EPERM으로 실패했고 승인 후 같은 시험이 통과했다.

## 운영 연결 상태

2026-10-22 읽기 전용 Dokploy inventory에서 서비스 앱 15개를 확인했다. 별도 monitor/Kuma 앱과
MONITOR/HEARTBEAT/DEADMAN/KUMA/ALERT 설정은 발견하지 못했다. 실제 알림 발송·도착·외부 heartbeat
timeout·독립 호스팅은 아직 검증하지 않았다. 수신 채널과 외부 서비스가 정해지면 runbook대로 연결한다.
이번 코드 작업으로 운영 migration·배포·잡 중단/재개를 실행하지 않았다.
