<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- 아래는 이 저장소가 직접 관리한다 (next dev가 재작성하는 블록 밖) -->

## 운영 상태와 남은 검증

운영 서비스는 `https://nomorevibe.brut.bot`에 배포되어 있다. Dokploy는 main을 사용하며
M3의 웹·scheduler(2복제본)·crawler·reviewer·publisher·text·maintenance와 mini의 웹·crawler 예비·reviewer 예비,
총 10개 앱으로 운영한다. crawler·reviewer는 DB 역할 lease로 한 후보만 작업한다.
공개 GitHub 저장소의 main은 PR 및 최신 base의 CI `check` 성공을 요구한다.

배포·테스트 절차는 `README.md`와 `docs/operations/independent-workers-runbook.md`를 읽는다.
`PENDING.md`에는 백업 복구·장기 관측 등 아직 직접 확인하지 않은 운영 검증을 기록한다.
첫 배포가 아직 안 됐다는 과거 기록을 현재 상태로 해석하지 않는다.
사용자가 중단한 소개 검수는 별도 지시 없이 재개하지 않는다.

## 검증 스킬

코드 변경을 "고쳤다"고 말하지 않는다. 프로젝트 로컬 스킬
[`.cursor/skills/verify-nomorevibe/SKILL.md`](.cursor/skills/verify-nomorevibe/SKILL.md)를 읽고
[`features/`](.cursor/skills/verify-nomorevibe/features/)의 해당 Feature Map 레시피로 실제 앱을
구동한 뒤 증거(로그, 스크린샷, 명령 출력)를 남긴다. 맵에 있는 진입점을 다른 경로로 대신
통과했다고 보고하지 않는다.
