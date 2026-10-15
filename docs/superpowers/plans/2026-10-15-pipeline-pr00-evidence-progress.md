# PR-00 응답 회수와 근거 이어 처리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 사용 가능한 `execute-plan` 절차로 수행한다.

**Goal:** 읽지 않는 HTTP 응답을 회수하고 근거 갱신이 full-page deadline 경계에서도 후속 작업을 잃지 않게 하는 기존 수정만 독립 PR로 낸다.

**Architecture:** 기존 capped fetch/근거 job의 제어 흐름을 유지한다. 거절 응답 body를 취소하고 외부 I/O 전 한 행 lookahead로 continuation을 결정한다. X·신규 역할·원문 크기·DB 스키마·운영 설정은 이 PR에 포함하지 않는다.

**Tech Stack:** TypeScript, Node 24 fetch streams, Vitest, 기존 PostgreSQL selector/JobContext.

---

이 수정은 로컬 `c5fcb0b`·`90a57fd`에서 이미 실패 회귀→구현 검증을 마쳤다.
이번 계획은 그 코드를 최신 main 기반의 독립 PR로 **추출·재검증·검토·제출**하는 작업이다.
새 코드의 RED를 이번에 실행했다고 기록하지 않는다. 기존 RED 기록은
`docs/CODEX_HANDOFF.md`의2026-10-15 근거 갱신 phase를 따른다.

## 파일 경계

| 파일 | 책임 |
| --- | --- |
| `lib/net/fetch.ts` | `readBodyStrictlyCapped`의 선언 크기 초과, `fetchCapped`의 HTTPerror/redirect에서 unused body 취소. cleanup 오류가 기존 outcome을 덮지 않음. |
| `tests/link-evidence.test.ts` | stream cancel의 실제 호출, HTTP/redirect·취소 실패·기존 상한 보존 회귀. |
| `lib/jobs/products/evidence-refresh.ts` | page+1 선조회, batch100일 때 I/O 전 별도 limit1 조회. lookahead를 처리/cursor/count로 세지 않으며 오류/abort/hold 기존 guard 유지. |
| `tests/evidence-refresh-continuation.test.ts` | full-page exact deadline, 마지막 page, batch100, 예산/abort/오류 guard와 cursor/count 회귀. |
| `docs/operations/2026-10-15-pipeline-pr00-validation.md` | 실제 실행한 명령·결과·PR 상태·배포 전후 구분. |

## Task 1: 격리 추출

- [x] 원격 main과 patch 경계를 읽는다. main `b55ac083cda523c7c1907d65aec300bb286a6d3a`이 기존 수정의 ancestor임을 확인했다.

```sh
git fetch origin main
git diff origin/main..90a57fd -- lib/net/fetch.ts lib/jobs/products/evidence-refresh.ts tests/link-evidence.test.ts tests/evidence-refresh-continuation.test.ts
git merge-base --is-ancestor origin/main 90a57fd
```

- [x] 독립 worktree를 만들고 아래4파일 patch만 적용한다. 기존 사용자 untracked와 X 브랜치는 보존한다.

```sh
git worktree add -b codex/pipeline-pr00-evidence-progress-20261015 /Users/jr/Desktop/projects/nomorevibe-pr00 origin/main
git diff origin/main..90a57fd -- lib/net/fetch.ts lib/jobs/products/evidence-refresh.ts tests/link-evidence.test.ts tests/evidence-refresh-continuation.test.ts > /private/tmp/nomorevibe-pipeline-pr00.patch
git -C /Users/jr/Desktop/projects/nomorevibe-pr00 apply /private/tmp/nomorevibe-pipeline-pr00.patch
git -C /Users/jr/Desktop/projects/nomorevibe-pr00 diff --check
```

기대:4파일 `+253/-7`, 정책·schema·X 변경0. 실행하지 않은 명령을 성공으로 기록하지 않는다.

## Task 2: 재검증

- [x] 격리 worktree에서 focused 회귀를 실행한다.4파일96PASS.

```sh
npx vitest run tests/link-evidence.test.ts tests/evidence-refresh-continuation.test.ts tests/evidence-refresh-cancellation.test.ts tests/worker-runtime.test.ts
npx eslint lib/net/fetch.ts lib/jobs/products/evidence-refresh.ts tests/link-evidence.test.ts tests/evidence-refresh-continuation.test.ts
```

기대: HTTP 정리·deadline/cursor·취소 회귀 전체 PASS. HTTP 실패·quota/backoff는 성공으로 바뀌지 않음.

- [x] 타입·전체 회귀·빌드를 실행했다. 전체unit2,547·Python23PASS, 타입/lint/i18n/build/bundle/diff PASS. worktree 밖 node_modules symlink는 Turbopack build가 거부하므로 빌드용 실제 로컬 dependency 디렉터리를 준비한다.

```sh
npx next typegen
npx tsc --noEmit
npm run check:i18n
npm run lint
npm test
DATABASE_URL=postgres://build:build@localhost:5432/build npm run build
node scripts/bundle-size.mjs
python3 -m unittest tests/test_deploy_shared_images.py
git diff --check
```

- [x] PR00 전용 loopback55451 DB를 생성하고 아래 evidence integration3파일38PASS를 확인했다. 기존 전용 DB가 있으면 해당 evidence integration을 실행한다. 없으면 PR의3개 CI integration shard 결과를 검증하고 로컬 미실행 사실을 기록한다. 운영 DB에 테스트를 실행하지 않는다.

```sh
npm run test:integration -- tests/integration/evidence-refresh.test.ts tests/integration/product-evidence-repository.test.ts tests/integration/product-refresh-requests.test.ts
```

## Task 3: 검토·PR

- [x] 부모가 전체 diff와 새로운 guard/rollback 영향을 읽고 PR00 범위만인지 확인했다. 기존 실패 이력·원문 제한·수집 pause·model/provider를 바꾸지 않는다.
- [x] 실제 검증 결과를 validation 문서와 handoff에 적고 파일을 명시해 `49fcdd0`으로 커밋, push, [PR #427](https://github.com/JRVector9/nomorevibe/pull/427)을 생성했다.

```sh
git add lib/net/fetch.ts lib/jobs/products/evidence-refresh.ts tests/link-evidence.test.ts tests/evidence-refresh-continuation.test.ts docs/operations/2026-10-15-pipeline-pr00-validation.md
git commit -m "fix: release unused fetch bodies and continue evidence pages"
git push -u origin codex/pipeline-pr00-evidence-progress-20261015
gh pr create --base main --title "fix: release unused fetch bodies and continue evidence pages" --body-file /private/tmp/nomorevibe-pipeline-pr00-body.md
```

- [ ] PR의 필수 `check`와 최신 base를 확인한다. main에 미반영된 동안 운영 반영 완료로 기록하지 않는다.

```sh
gh pr checks codex/pipeline-pr00-evidence-progress-20261015
gh pr view codex/pipeline-pr00-evidence-progress-20261015 --json number,url,headRefOid,baseRefOid,mergeStateStatus,statusCheckRollup
```

## 배포·복구

schema 변경이 없어 migration은 필요 없다. main 병합·필수 check·고정 image 생성 이후
기존 runbook의 mini 예비→M3 주 순서와 실제 runtime release/progress 확인을 따른다.
문제 시 새 작업 진입을 drain하고 이전 digest로 복구한다. 기존 장부/실패 이력/미래 예약은 되감지 않는다.
본문 크기 초과 출처의 컨텐츠 자체가 수리된 것은 아니므로 적체 전체 완료라고 보고하지 않는다.
