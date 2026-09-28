# 2026-09-29 역할 워커 장애 복구 확대 배포 기록

## 범위와 릴리스

PR #217의 CI `check` 통과 후 main `20208d3c96ed92e4e931f1c91c40f6561ab12ad9`를 운영에 배포했다. M3의 웹·scheduler(2복제본)·crawler·reviewer·publisher·maintenance·text와 mini의 웹·다섯 역할 예비, 총 13개 앱이다. DB migration과 서버·DB streaming 설정 변경은 없었다. 사용자 중단 `product-intro-check`도 재개하지 않았다.

역할 앱 10개는 `autoDeploy=false`로 유지한다. 웹 2개와 scheduler는 새 이미지 확인 후 `autoDeploy=true`로 복원했다. 역할별 주·예비는 같은 이미지와 `RELEASE_TAG`이며 고유 `SERVICE_INSTANCE_ID`를 사용한다. 다음 main 릴리스에서는 역할 주·예비를 [운영 절차](independent-workers-runbook.md)에 따라 함께 교체해야 한다.

## 순차 전환과 장애 시험

| 역할 | 운영에서 확인한 인계와 저장 | 복귀 시점 |
|---|---|---|
| publisher | M3 자식 SIGKILL 뒤 M3 epoch 2, M3 서비스 중단 뒤 mini epoch 3. mini에서 `crawl-publish` 요청/처리 14797→14798과 성공 시각 전진. 당시 적격 승인 후보가 0이라 mini의 **새 제품 발행은 미확인** | M3 epoch 4 active, mini standby |
| maintenance | M3 자식 SIGKILL 뒤 M3 epoch 2, 주 중단 뒤 mini epoch 3. mini에서 `uptime-ping` 23643/23643, `product_health.checked_at` 05:45:43, 성공 시각 05:45:45로 전진. 검색 갱신도 14476/14476 처리 | M3 epoch 4 active, mini standby |
| text | 실행 중 검수 작업의 M3 자식 SIGKILL 뒤 M3 epoch 2, 주 중단 뒤 mini epoch 3. mini 활성 중 `product_search_profiles.verified_at`이 05:51:00으로 전진 | M3 epoch 4 active, mini standby |
| crawler | 구 이미지 주·예비를 새 릴리스로 순차 교체한 뒤 주 중단→mini epoch 6. mini 활성 중 수집 문서 시각 06:02:00, `crawl-fetch` 33520/33520 및 성공 시각 전진 | M3 epoch 7 active, mini standby |
| reviewer | 같은 방식으로 교체한 뒤 주 중단→mini epoch 6. mini 활성 중 1차 심사 저장 시각 06:03:46, `crawl-agent-review` 33614/33614 처리 | M3 epoch 7 active, mini standby |

시간은 운영 DB `timestamp without timezone`을 로컬 조회 도구가 표시한 값으로 UTC 시각으로 해석하지 않는다. 전후 순서만 비교했다. 역할 lease owner/epoch와 후보 관측, job 요청·처리 버전, 실제 출력 행의 최신 저장 시각을 함께 비교했다. 5개 역할 모두 최종 M3 active·mini standby이며 후보 릴리스가 같다. SIGKILL의 과거 Docker 실패 task는 현재 컨테이너 오류로 계산하지 않았고 현재 task 상태를 별도로 확인했다.

P2 재검토에서 코드의 유효한 실행 중 job lease를 진행 정체로 오인하던 조건을 수정한 릴리스를 crawler/reviewer에도 배포했다. 구 예비를 새 이미지로 먼저 교체한 동안 릴리스 불일치 예비는 옛 주의 lease를 승계하지 않았고, 새 주 배포 후 동일 릴리스 쌍으로 돌아왔다. 두 역할의 실제 예비 저장을 이번에 확인했다.

## 배포와 전반 상태 확인

M3·mini 웹은 Dokploy 배포 기록의 source commit `20208d3`와 `done`을 확인했다. 공개 `/api/health`, `/admin/status`는 각각 HTTP 200이었다. scheduler는 2개 컨테이너가 healthy이며 런타임 `RELEASE_TAG`와 새 코드의 maintenance liveness 표식을 확인했다. **Dokploy의 scheduler 최신 배포 기록은 `done`이지만 description이 빈 문자열**이므로 소스 확인은 이 런타임 증거로 대신했다. 새 scheduler 컨테이너에서 `scripts/check-worker-progress.ts`를 직접 실행해 종료 0, `overall=ok`, 여섯 역할 및 scheduler liveness `present`를 확인했다.

코드 게이트는 PR #217 최신 head의 GitHub `check` 성공, 로컬 `npm test` 154파일/1222 통과, `npm run test:integration` 96파일/921 통과·기존 TODO 1, `npx tsc --noEmit`, lint, build, diff check였다. 린트의 기존 vendor 경고와 빌드의 기존 Claude CLI 추적 경고는 남았다. 최신 maintenance 오류 조건 수정 후 표적 통합 9개와 CI를 다시 통과했다. DB 읽기 전용 진행 쿼리는 maintenance 약 100~300ms, text 약 1.1초, 전체 약 300ms였다.

## 남은 검증과 용량

- publisher 예비가 적격 승인 후보를 실제 신규 제품으로 발행하는 순간은 아직 확인하지 못했다.
- 운영에서 실제 저장 정체 2회 판정에 따른 자동 재시작, 반복 부팅 3회/5분 격리, 외부 독립 감시·알림, 24시간 연속 관측, 백업 복구 시험은 남았다.
- maintenance는 약 19,343개 공개 사이트 중 약 13,954개가 6시간 넘게 점검되지 않은 표본이 있다. 최근 약 900건/시간은 6시간 목표의 약 3,224건/시간보다 적다. 예비는 장애 대응용이며 이 처리량을 늘리지 않는다.

재확인은 운영에서 `node --import tsx scripts/check-worker-progress.ts`, DB의 `role_leases`·후보 관측·job 처리·출력 저장 시각, Dokploy 13개 앱의 배포/명령/`RELEASE_TAG`·컨테이너 상태를 함께 본다. 미검증 항목의 실행 조건은 [PENDING.md](../../PENDING.md)에 둔다.
