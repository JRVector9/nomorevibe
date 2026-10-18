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

## 운영 상태와 남은 검증

운영 서비스는 `https://nomorevibe.com`에 배포되어 있다. Dokploy는 main을 사용하며
M3의 웹·scheduler(2복제본)·crawler·reviewer·publisher·text·maintenance와 mini의 웹·다섯 역할 예비,
총 13개 앱으로 운영한다. 다섯 역할은 DB 역할 lease로 한 후보만 작업한다.
공개 GitHub 저장소의 main은 PR 및 최신 base의 CI `check` 성공을 요구한다.

배포·테스트 절차는 `README.md`와 `docs/operations/independent-workers-runbook.md`를 읽는다.
`PENDING.md`에는 백업 복구·장기 관측 등 아직 직접 확인하지 않은 운영 검증을 기록한다.
첫 배포가 아직 안 됐다는 과거 기록을 현재 상태로 해석하지 않는다.
2026-10-15 KST 사용자가 소개 검수를 포함한 적체 회복을 지시해 소개 검수 중단을 해제했다.
2026-10-18 08:19 KST 사용자 지시로 신규 GitHub·Show HN 발굴을 재개했다(운영 감사 13090).
현재 설정·남은 확인은 `docs/operations/2026-10-14-backlog-catchup.md`와 `docs/CODEX_HANDOFF.md`를 따른다.
