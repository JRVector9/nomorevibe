<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- 아래는 이 저장소가 직접 관리한다 (next dev가 재작성하는 블록 밖) -->

## 현재 파이프라인 PR의 검증 정책 (JR 지정, 2026-10-16)

- PR별로는 변경 범위의 회귀 테스트와 필요한 정적 검사만 실행한다.
- 수동 전체 unit·전체 DB·종합 테스트은 남은 모든 PR 개발이 끝난 뒤 통합 단계에서 실행한다. PR마다 반복하지 않는다.
- 이미 실행한 결과와 실패는 보존하며, 실행하지 않은 검사를 통과했다고 기록하지 않는다.
- GitHub의 필수 병합 CI는 저장소 규칙대로 유지한다.

## 일반 배포 기본 경로 (2026-10-25)

- [단축 배포 절차](docs/operations/deployment-fast-path.md)의 `npm run deploy -- scope|plan|run`을 기본으로 사용한다.
- 실제 앱별 baseline으로 변경 대상을 정하고, 필요한 main `check`·이미지 publish만 기다린다. `refresh-caches`와 6시간 관측은 동기 배포 대기가 아니다.
- text·maintenance·scheduler는 공통 worker digest를 사용한다. connect는 Git이며 출처를 검증한다. 같은 역할의 mini→M3, scheduler M3 2복제본·mini 1복제본과 기존 설정을 보존한다.
- 이미 목표 상태인 앱은 재배포하지 않고 유지 대상으로 검증한다. 실패한 once 디렉터리를 재사용하거나 응답이 불명확한 배포를 자동 재요청하지 않는다.
- DB 이전·native unknown 회수·capacity 변경은 일반 배포와 별도다. 장기 관측은 실제 실행 영수증으로만 완료를 기록한다.

## 운영 상태와 남은 검증

운영 서비스는 `https://nomorevibe.com`에 배포되어 있다. Dokploy는 main을 사용하며
M3의 웹·scheduler(2복제본)·crawler·reviewer·publisher·text·maintenance와 mini의 웹·scheduler(1복제본)·다섯 역할 예비,
connect-agent·agent-scan 소비자·AI2 소비자·읽기 전용 monitor를 합쳐 총 18개 Dokploy 앱/23개 컨테이너로 운영한다.
AI2 소비자는 M3 1앱이며 stage 전환과 전역 모델 용량 제어 상태는 `docs/CODEX_HANDOFF.md`를 따른다.
다섯 역할은 DB 역할 lease로 한 후보만 작업한다. M3 monitor는 mini Kuma와 Oracle Osaka의 별도 Kuma로
Push를 보낸다. 연결·UP 확인과 장애 알림 드릴의 완료 여부는
`docs/operations/2026-10-22-worker-monitor-rollout.md`를 먼저 읽는다.
Oracle 독립 watchdog의 3호스트 감시·제한 자동복구·장애별 알림과 실제 드릴은
`docs/operations/oracle-recovery-runbook.md`와 최신 `docs/CODEX_HANDOFF.md`를 따른다.
공개 GitHub 저장소의 main은 PR 및 최신 base의 CI `check` 성공을 요구한다.

배포·테스트 절차는 `README.md`와 `docs/operations/independent-workers-runbook.md`를 읽는다.
`PENDING.md`에는 백업 복구·장기 관측 등 아직 직접 확인하지 않은 운영 검증을 기록한다.
첫 배포가 아직 안 됐다는 과거 기록을 현재 상태로 해석하지 않는다.
2026-10-15 KST 사용자가 소개 검수를 포함한 적체 회복을 지시해 소개 검수 중단을 해제했다.
2026-10-18 08:19 KST 사용자 지시로 신규 GitHub·Show HN 발굴을 재개했다(운영 감사 13090).
현재 설정·남은 확인은 `docs/operations/2026-10-14-backlog-catchup.md`와 `docs/CODEX_HANDOFF.md`를 따른다.
