# PR-00 응답 정리·근거 continuation 검증

2026-10-15. 기준 main `b55ac083cda523c7c1907d65aec300bb286a6d3a`,
branch `codex/pipeline-pr00-evidence-progress-20261015`.

## 변경과 경계

- `lib/net/fetch.ts`: 선언 크기 초과·HTTP 오류·redirect에서 읽지 않는 response body를 취소한다. 취소 오류가 원래 실패 결과를 덮지 않는다.
- `lib/jobs/products/evidence-refresh.ts`: 외부 I/O 전에 다음 제품 한 행을 확인해 full-page deadline 경계에서도 continuation을 유지한다. batch100은 selector 상한을 유지하고 별도 limit1을 I/O 전에만 읽는다.
- lookahead는 시도·성공·cursor에 포함하지 않는다. 오류/abort/provider hold/부분 완료의 기존 guard를 유지한다.
- schema·model·심사 조건·원문 크기·SSRF·운영 pause·API/Cloudflare 예산·X 서비스 변경은 없다.
- 기존 로컬 `c5fcb0b`/`90a57fd`의4파일만 추출했다. 그때의 실패 회귀 기록과 이번 재검증을 구분한다.

## 실제 실행

| 명령 | 결과 |
| --- | --- |
| `npx vitest run tests/link-evidence.test.ts tests/evidence-refresh-continuation.test.ts tests/evidence-refresh-cancellation.test.ts tests/worker-runtime.test.ts` | 4파일96PASS |
| 해당4파일 `npx eslint` | exit0 |
| `npx next typegen && npx tsc --noEmit` | exit0 |
| `npm test` | 260파일2,547PASS |
| `npm run lint` | exit0; 기존 vendor `_ctx` 경고1 |
| `npm run check:i18n` | PASS,4locales/8namespaces/11publicPages |
| `npm run build` | PASS; 기존 agent-review dynamic spawn tracing 경고1 |
| `node scripts/bundle-size.mjs` | 3개 경로 모두 기준+10% 이내 |
| `python3 -m unittest tests/test_deploy_shared_images.py` | 23PASS |
| `TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@localhost:55451/nomorevibe_test npm run test:integration -- tests/integration/evidence-refresh.test.ts tests/integration/product-evidence-repository.test.ts tests/integration/product-refresh-requests.test.ts` | 3파일38PASS |
| `git diff --check` | exit0 |

DB 검증은 이 PR 전용 loopback Docker `nomorevibe-pipeline-pr00-test-db-20261015`
(`pgvector/pgvector:0.8.6-pg17`)에서 수행했다. 운영/개발 DB를 사용하지 않았다.
통합 테스트 전용 DB에 기존 schema migration이 성공 적용됐다. 운영 migration은 실행하지 않았으며 이 PR에는 새 DDL이 없다.

첫 build는 worktree 밖 `node_modules` symlink를 Turbopack이 거부해 실패했다.
해당 worktree에 실제 dependency 디렉터리를 복사한 뒤 source 변경 없이 같은 build가 통과했다.
부모가 전체4파일 diff와 기존 selector·deadline·error/cursor guard를 검토했다.

## 배포·복구 상태

이 문서 작성 시 원격 PR/필수 CI 확인 전이며 운영 배포는 하지 않았다.
PR 생성 후 URL과 CI 결과를 별도 갱신한다. 단위/fixture 처리 속도를 실제 모델 처리량으로 보고하지 않는다.
이 변경만으로2배·전체 근거 적체 해소·Oracle 업무 이전을 달성한 것은 아니다.

main 병합과 고정 image 생성 뒤 기존 독립 워커 runbook으로 배포한다.
새 DDL이 없어 운영 migration은 필요 없다. 문제 시 작업 drain 후 이전 image digest로 되돌리고,
기존 source 장부·실패·quota·미래 예약은 유지한다.
