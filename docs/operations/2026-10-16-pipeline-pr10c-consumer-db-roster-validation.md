# Reviewer consumer별 DB 연결 예산

기존 reviewer 역할 하나로 계산하던 선언을 legacy·AI1·AI2 목적별로 구분한다. 선택적인 reviewerConsumers에 ai1/ai2를 선언하고 각 supervisor1+worker3 연결을 별도 계수한다. 세 종류 합계12, 배포 중 두 복사본24는 선언상 수치다. 기존 roles.reviewer/old row 객체·JSON·default-off 동작을 유지하고, 실제 supervisor와 두 CLI는 자신에게 맞는 consumer 선언만 허용한다. 다른 consumer의 slot 차용은 DB/runtime import 전에 거절한다.

Root가 production4 전체 diff·host-budget 모듈·NEW190행 unit과 원문 보존 proof를 읽고 검토했다. 기존 네 파일은 승인 hunk 역변환으로 whole byte exact이며 기존 관련 test4와 pool 파일도 exact다. Source manifest `/tmp/nomorevibe-pr10c-a-roster-final-shas-20261016.json`를 root가 독립 확인했다.

실제로 실행한 범위 검증: 최초 합법 legacy entry/child2 AssertionFAIL+3control→동일5PASS, catalog6 AssertionFAIL+6control→동일12PASS, 실제 CLI/supervisor6 AssertionFAIL+18control→동일24PASS다. 최종 새24 및 기존 host21/supervisor2/AI1CLI2/AI2CLI2 총27control PASS, 실제 Next global 포함 scoped TypeScript와 변경5파일 ESLint exit0이다. 구체 명령/원로그/SHA는 `/tmp/nomorevibe-pr10c-a-roster-final-report-20261016.md`와 `...final-logs...json`에 보존했다. 기존 테스트는 수정하지 않았으며 성공 후 불필요 반복은 하지 않았다.

이 검증은 실제 entry/catalog/config/CLI/supervisor 함수를 호출하고 DB/queue/child spawn 경계만 mock한다. 실제 프로세스별 slot 독점·중복 선언·여러 factory 합계·URL/principal/endpoint·PgBouncer/backend·호스트 물리 상한은 증명하지 않는다. enforcement=unknown/ready=false/activationAllowed=false 유지, M3/mini/Oracle 실제 연결 검증은 남는다. DB·SQL·Docker·SSH·실provider·배포·활성화0, 수동 전체 테스트는 모든 계획 PR 개발 뒤 실행한다.
