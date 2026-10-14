# 2026-10-15 근거 갱신 복구 — 현재 커버리지 판정

## 목적과 담당 범위

제품 근거 갱신 적체를 자동으로 처리하면서 확인하지 못한 근거를 완료로 오인하지 않도록 한다.
실제 출처 처리량 병목과 최소 개선은 별도
[출처 처리량 보고서](2026-10-15-evidence-source-capacity.md)의 담당 작업이다.
이 문서는 제작 근거 수집기의 404 복구 결과를 읽는 심사·표시·발행 경계의 P2 오류를 다룬다.
이 단계에서 커밋·배포·운영 DB 수정은 하지 않았다. 전체 검증과 정상 PR·배포는 root 담당이다.

## 확인한 원인

동일 GitHub ID·head·검출기·범위에 예전 완전 스캔이 있으면 저장은 그 이력을 유지한다.
새 발견 커밋의 비교가 404여도 현재 head를 실제로 검사하고 `coverage.limited=true`와
제한 커서를 저장하면서 기존 `state=complete`와 원래 `completedAt`은 보존한다.
이 저장 규약 자체는 새로운 완료를 꾸미지 않는다.

그런데 읽는 쪽이 현재 coverage와 미완료 cursor를 보지 않았다. 예전 완료가 24시간 안이면
심사 입력은 `complete`와 근거 없음 확정(`ai_evidence_not_found`)을 만들 수 있었고,
기존 관측의 공개 표시는 미확인 범위를 감췄으며 귀속 감사는 `current`로 집계했다.
시각·상태·관측이 그대로인 coverage-only 변경은 심사 원본 해시와 SQL의 이전 승인 비교에서도 빠졌다.

단위 테스트에서 실제로 `complete` 대신 `partial`, 감사 `current` 대신 `incomplete`,
공개 무라벨 대신 `일부 미확인`이 필요함을 각각 RED로 확인했다.
격리 실DB에서도 coverage-only 변경의 심사·발행 회귀를 RED로 재현했다.

## 변경과 설계 결정

- `agents/coverage.ts`에서 제한 커버리지 또는 미완료 tree/blob/commit queue가 있으면
  읽기용 완전 상태를 `partial`로 투영한다. 영속 상태·완료 시각·관측·출처 인용은 바꾸지 않는다.
- 심사 입력, 일반 판정 입력, 관리자 일괄 판정, 공개 관측 표시, 귀속 감사, 출처 연결,
  발행 관문이 이 현재 커버리지 규약을 사용한다.
- 예전 확정 관측은 그대로 보존하고 인용 URL과 원래 관측 날짜를 유지한다.
  현재 불완전 범위에서 부재를 확정하거나 새로운 완전 확인으로 계산하지 않는다.
- 실제 limited/pending 대상에서만 선택적 `source.scanCoverage`를 추가한다.
  limited/pending 두 플래그와 기존 최대 5개의 unavailable commit 근거로 된 제한 서명이며
  전체 cursor나 파일 본문을 심사 source에 복사하지 않는다.
- 정상 complete와 미스캔은 새 필드를 내보내지 않는다. 이전 source 해시 인코딩과 input hash를
  유지하는 positive 회귀를 통과했다. prompt/rules/detector 버전 일괄 인상이나 전체 재검수는 없다.
- `matchingSource`와 second-review admission의 기존 scan state/error 비교 옆에 같은 제한 서명을
  비교한다. 이전의 정상 source에는 `{}` 기본값으로 호환된다. coverage-only 변경은 LIMIT 전에
  이전 승인에서 빠지고 실제 발행 CAS에서도 다시 확인한다.

수정 파일:

- `lib/domain/evidence/agents/coverage.ts` (신규), `audit.ts`, `view.ts`, `repository.ts`의 연결 경계
- `lib/domain/products/detail-view.ts`
- `lib/crawl/agent-evidence.ts`, `admin-review-batch.ts`, `admin-review.ts`, `agent-review-contract.ts`,
  `agent-review-repository.ts`, `publication-guard.ts`, `discovery-admission.ts`
- `tests/agent-review-contract.test.ts`, `agent-evidence-view.test.ts`, `agent-attribution-audit.test.ts`
- `tests/integration/agent-evidence-coverage.test.ts` (신규), `agent-review-scan-lock.test.ts`,
  `discovery-admission.test.ts`

앞선 담당자의 collector 복구·관리자 source 집계 변경은 그대로 유지했다.
`docs/CODEX_HANDOFF.md`는 root가 통합 관리한다.

## 실행한 검증

2026-10-15 08:11~08:15 KST, localhost55449의 독립
`nomorevibe-coverage-projection-test-db-20261015` (`pgvector/pgvector:0.8.6-pg17`)를 사용했다.
공개 dummy test credentials이며 운영 DB를 사용하지 않았다.

- RED: 단위 3개 실패/기존 36개 통과, scan-lock 실DB 신규 회귀 1개 실패/기존 3개 통과.
- GREEN: 관련 단위 4파일 53개 통과.
- 확대 통합 첫 실행: 10파일 112개 중 111개 통과, 새 coverage 통합 1개가 테스트의
  잘못된 public helper export 이름 때문에 실패했다. 구현 오류로 처리 완료를 보고하지 않는다.
- 테스트 오타를 `getPublicObservedAgentFacts`로 고친 뒤 해당 통합 파일 2개를 다시 실행해 통과했다.
  다른 9파일 110개는 같은 확대 실행에서 통과했다.
- 실제 fresh 이전 complete + 새 discovery compare404 저장 후 관측 보존, single/batch judge partial,
  공개 `일부 미확인`, 연결 거절, 감사 incomplete, 정상 완전 재확인 복귀를 확인했다.
- coverage-only 변경의 LIMIT 전 승인 제외, scanId가 있는 발행 guard, scanId 없는 실제 review CAS,
  AI2 admission에서의 오래된 표본 제외를 확인했다.
- JS/SQL 제한 서명 8경계(미스캔, 정상, limited, cursor limited, commit/tree/blob pending, unavailable 근거)를
  실제 DB로 대조했다.
- TypeScript exit0, 해당 변경 ESLint exit0, `git diff --check` exit0.
  처음의 test export 오타는 TypeScript도 탐지했고 수정 후 재실행했다.

```sh
cd /Users/jr/Desktop/projects/nomorevibe
npx vitest run tests/agent-review-contract.test.ts tests/agent-evidence-view.test.ts tests/agent-attribution-audit.test.ts tests/agent-evidence-summary.test.ts
TZ=UTC TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55449/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/agent-evidence-coverage.test.ts tests/integration/agent-review-scan-lock.test.ts tests/integration/discovery-admission.test.ts tests/integration/admin-review-batch.test.ts tests/integration/agent-attribution-audit.test.ts tests/integration/agent-evidence-cursor-recovery.test.ts tests/integration/agent-evidence-repository.test.ts tests/integration/product-detail-view.test.ts tests/integration/review-publication-gate.test.ts tests/integration/admin-review-evidence.test.ts
npx tsc --noEmit
git diff --check
```

기존 lease-lost negative test는 의도한 오류 로그를 출력하며 통과했다.
Vitest의 기존 Vite config 경고를 테스트 실패로 계산하지 않는다.
이 단계는 전체 저장소 테스트·CI·운영 배포 검증을 완료했다는 뜻이 아니다.

## 남은 확인과 다음 명령

root가 전체 통합/빌드와 최신 main의 필수 CI를 확인한 뒤 정상 13앱 배포를 수행한다.
그 다음 기존 정상 due/backoff 처리로 생긴 limited 결과를 읽어 이번 투영이 운영에도 적용됐는지 확인한다.
운영 lease·cursor·attempts·완료 시각 초기화 또는 강제 성공으로 확인하지 않는다.

```sh
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15/evidence-owner/observe.py snapshot
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15/evidence-owner/observe.py cohort
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15/evidence-owner/observe.py postdeploy
```

현재 source 실제 처리량 참고는 23:10:02 UTC 읽기 전용 표본에서 due50,837,
실제 현재 URL 성공 저장 1시간1,943/5분161이었다.
그 관측은 배포 성공이나 처리량 개선 결과가 아니며, 별도 capacity 조사에서 해석한다.
