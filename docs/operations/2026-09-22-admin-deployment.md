# 관리자 개선·처리 속도 표시 운영 배포

2026-09-22, 사용자 배포 지시에 따라 `611820d63096f54700e1254634987046d25cbe01`을 main에 커밋·푸시하고 운영에 배포했다. 관리자 동시 결정/집계 오류 수정, 랭킹 화면 재설계, 운영센터 헤더 필터, 단계별 분당 처리량 표시가 포함됐다.

## 배포 확인

- Dokploy 웹 M3·mini 2개와 M3 singleton 워커 7개가 모두 새 커밋의 deployment `done`이다.
- 실제 9개 컨테이너의 release가 일치하고 재시작 횟수는 0이다. 7개 워커는 healthy이며 수정한 lib 소스 12개씩의 해시가 모두 일치했다.
- 두 웹 서버 내부 `/api/health`: HTTP200, DB ok, DB 응답 1·2ms. 외부 도메인 health도 HTTP200·동일 release.
- 운영 브라우저 8개 검증 통과, JS/console 오류 없음: 5단계 속도, 심사표 단위, 자동 갱신·중지, 목록 필터, 랭킹 화면, 모바일 가로 넘침. 쓰기 작업을 실행하지 않았다.
- 배포 요청 후 약 3분 동안 워커 로그 222개에서 job.failed 0, 실패 이벤트 0. GitHub 수집 요청 한도에 따른 재시도 예약이 있었고 새 발견 22건을 기록했다. 전체 후보 처리가 완료됐다는 뜻은 아니다.

[배포·컨테이너 증거](evaluations/2026-09-22-admin-deployment/release.json), [브라우저 결과](evaluations/2026-09-22-admin-deployment/browser-checks.json), [워커 이벤트](evaluations/2026-09-22-admin-deployment/worker-events.json).

## 검증 기록과 한계

GitHub CI 조회는 HTTP403 API 호출 한도로 막혔다. 따라서 배포 커밋의 별도 깨끗한 체크아웃에서 Node24.18.0, npm ci, 타입 생성·타입 검사, 전체 lint(0오류·기존 vendor 경고1), 단위1,118개, 통합809개, production build를 실행했다.

최초 전체 통합에서는 기존 seed 테스트 하나가 실패했다. pending2개 직후 dequeue가 빈 값을 반환했다. 수집 큐200회와 해당 seed100회 반복에서 재현되지 않았고, 진단 변경을 제거한 원커밋 전체 재실행에서는809개 모두 통과했다. 원인은 확정하지 않았으며 이를 해결했다고 주장하지 않는다. [검증 상세](evaluations/2026-09-22-admin-deployment/validation.json).

관리자 익명 접근 허용에 관한 기존 운영 정책 미결 사항은 그대로다. 이번 배포에서는 인증 설정, 운영 데이터, DB 스키마를 변경하지 않았다.

## 후처리

9개 앱의 원래 자동 배포 값(true)을 저장한 뒤 배포 동안 잠시 false로 뒀다. 이 문서 푸시 후 복원·재조회가 마지막 단계이며, 완료 보고는 복원이 확인된 후에 한다. 증거 JSON의 autoDeploy=false는 문서 푸시 전 스냅샷이다. 재개 시 `/tmp/nmv-admin-release.py status`로 현재 값을 먼저 확인한다.

[운영 처리 속도 화면](evaluations/2026-09-22-admin-deployment/status-throughput-production.png), [운영 랭킹 화면](evaluations/2026-09-22-admin-deployment/ranking-production.png).
