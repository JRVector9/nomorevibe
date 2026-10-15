# PR01a 현재 검수 상태 측정 — 구현·검증 기록

2026-10-15, 기준 main `8020dcae2e69f64922d71e8469fc86a5495399dc`.
PR00의 [13앱 배포](2026-10-15-pipeline-pr00-rollout.md) 이후 측정 도구를 별도 PR로 구현했다.
이 문서의 수치는 로컬 테스트 결과이며 운영 처리량 측정값이 아니다.

## 결과와 범위

`pipeline-capacity`는 후보에 실제 적용된 현재 자동 검수 세대를 집계한다.
현재 원문·정책·모델·적용 attempt가 일치하고 유효한 AI1 결과만 인정하며,
승인은 발행과 동일한 SQL의 필수 AI2 gate까지 완료되어야 한다. 거절에는 승인 전용 AI2를 요구하지 않는다.
후보별 신규 최종 완료를 한 번만 세고, 재심사·중복 세대·규칙·복사 재사용·사람/미적용·부분·만료 결과를 분리한다.
`exclusions.human`은 사람 대기열 수가 아니라 비자동 또는 후보에 적용되지 않은 행도 포함하는 제외 사유다.

전체 normalized 설정 hash는 정확한 export 결합에 사용한다. 비교용 hash는 `reviewConcurrency`만 제외하므로
같은 판단 기준의 동시성2→4 실험을 허용한다. 나머지 입력 분포·원문 hash·모델 identity·기준 시각·캐시·초기 상태·예산은 고정한다.
완료 시간은 AI1과 마지막 필수 AI2 슬롯의 완료 중 늦은 값이며, 준비 시각부터의 p50/p95를 계산한다.

이 결과는 `as_of_snapshot_only`, 진위와 예산 증거는 `unverified`다. 발행 뒤 정리되는 AI2 행이나
이후 관리자 판단으로 사라진 과거 상태는 재구성할 수 없다. 실제 발행→cleanup 회귀로 이 한계를 확인했다.
입력 재계산도 기존 함수의 현재 시각을 사용하므로 신선도 경계에서 보수적으로 제외할 수 있다.
JSON의 출처 표시와 호출/준비 구간은 인증된 실행 장부가 아니다. 비교의 성능·종합 판정은 합격으로 바뀌지 않는다.
`replay`는 `real_model_replay_unimplemented`로 거절하고, `replay-plan`은 설정만 검사한다.
30분 실모델 실행·사전 예약·제공자 강제 상한·준비/최종 전이 장부는 PR01b에서 구현한다.

## 실행 방법

Node24와 설치된 의존성이 필요하다. artifact/manifest는 strict schema이며 자격 증명을 넣지 않는다.
최소 fixture의 작성 방법과 실제 로컬 export는 `tests/pipeline-capacity.test.ts`와
`tests/integration/pipeline-capacity.test.ts`의 실행 예를 따른다.

```sh
node --import tsx scripts/measure-pipeline-capacity.ts report /private/tmp/capacity-run.json
node --import tsx scripts/measure-pipeline-capacity.ts compare /private/tmp/capacity-before.json /private/tmp/capacity-after.json
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55452/nomorevibe_test node --import tsx scripts/measure-pipeline-capacity.ts replay-plan /private/tmp/capacity-manifest.json
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55452/nomorevibe_test node --import tsx scripts/export-pipeline-capacity.ts /private/tmp/capacity-template.json /private/tmp/capacity-export.json
```

Export는 명시적인 loopback `nomorevibe_test`만 허용한다. 충돌하는 `DATABASE_URL`, `READ_DATABASE_URL`,
host/service/options override와 다중 host·URL parser 불일치를 DB import 전에 거절한다.
일반적인 실행 예는 위의 `127.0.0.1`을 사용한다. 설치된 postgres.js의 IPv6 host 파싱에는 별도 기능 제한이 있다.
primary의 read-only/repeatable-read transaction으로 읽고, 고정 입력과 맞지 않는 과거 세대를 제외한 수를 출력한다.
출력은 기존 파일을 덮어쓰지 않는 mode0600 JSON이다. 입력 파일 상한은64MiB다.
잘못된 schema는 고정 코드만, 예기치 않은 DB/파일 오류는 `capacity_operation_failed`만 출력한다.

## 실제 검증

전용 컨테이너 `nomorevibe-pipeline-pr01-test-db-20261015`, loopback55452만 사용했다.
로컬 image는 `pgvector/pgvector:pg17`의 digest
`sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d`, PostgreSQL17.11이었다.
CI의 고정 image `pgvector/pgvector:0.8.6-pg17`와 구분하며 전체 통합3shard는 PR CI로 확인한다.

| 실행한 명령 | 실제 결과 |
| --- | --- |
| `npm test` | 263파일, 2,633 PASS |
| 아래 관련 DB 통합4파일 | 62 PASS |
| `npx next typegen` / `npx tsc --noEmit` | PASS |
| `npm run check:i18n` | PASS, locale4/namespace8/공개 페이지11 |
| `npm run lint` | PASS, 기존 vendor `_ctx` 경고1 |
| `DATABASE_URL=postgres://build:build@localhost:5432/build npm run build` | PASS |
| `node scripts/bundle-size.mjs` | PASS, br homepage148.7KB/product159.0KB/launch136.2KB |
| `python3 -m unittest tests/test_deploy_shared_images.py` | 23 PASS |
| `git diff --check` | PASS |

```sh
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55452/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/pipeline-capacity.test.ts tests/integration/review-publication-gate.test.ts tests/integration/review-handoffs.test.ts tests/integration/agent-review-records.test.ts
```

Build의 기존 dynamic spawn tracing 경고와 Vitest의 기존 Vite native-config 경고가 남아 있다.
최종 CLI 오류 정리·URL guard 뒤 전체 unit/통합/타입/lint를 다시 실행했다. Build는 그 두 offline 변경 전 성공 결과다.
9개 신규 DB 회귀는 필수2슬롯, fallback·시각, 사람 인계·원문 변경, 전체 정책, 관리자 보호,
선택 검증, 발행 후 cleanup, AI1 거절, 실제 CLI의 과거 세대 필터·복사 재사용·모델 불일치를 다룬다.

## 실패 관측과 수정

- 초기 missing-module RED와 API skeleton 이후52개 동작 assertion RED를 구분해 기록했다.
- 발행 상태에서 기존 AI2 입력 검사 실패: 읽기 전용 gate 시각 계산에서 발행 전 상태를 투영했다. 원본 gate SQL과 운영 writer는 바꾸지 않았다.
- AI1 거절에 AI2가 필요하던 필드, 과거 입력 export 충돌, 선언된 AI2 모델과 실제 설정 불일치가 각각 RED 후 GREEN이었다.
- 재심사와 추가 신규 세대 수의 혼합을2개 회귀로 분리했다.
- installed postgres.js3.4.9의 첫 `@`·다중 host 해석과 WHATWG의 마지막 `@` 차이를 순수 파싱으로 재현했다.
  3개 URL 회귀 RED 후 core와 공통 test-DB guard를 보강했다. 재현에 원격 DB/client를 사용하지 않았다.
- 두 CLI가 schema unknown-key의 canary를 오류로 노출하던 동작을 실제 subprocess RED로 확인했다.
  공유 고정 오류 경계를 추가했고 전용18개 및 최종 전체 테스트가 통과했다.

부모와 독립 agent가 집계·gate·입력/actor 결합·DB/오류 경계를 검토했다.
운영 DB 쓰기·모델 호출·공개 발행·운영 migration·PR01a 배포·30분 성능 시험은 실행하지 않았다.
DDL이 없고 소비자 설정도 바꾸지 않는다. 제거 시 기존 운영 경로로 복구되며 새 DB 구조를 지울 필요가 없다.
PR01b 완료 전 PR02 신규 소비자 활성화와2배/Oracle DR 완료 주장은 보류한다.

## 첫 PR CI의 환경 회귀 수정

[PR429](https://github.com/JRVector9/nomorevibe/pull/429)의 첫 실행38701417690에서
quality와 통합1/2는 성공했지만 통합3의 새 CLI export 테스트1건이 실패했다.
공통 test setup은 기본 DB URL을 상수로 해석해 `DATABASE_URL`에 넣지만 선택 환경변수
`TEST_DATABASE_URL`은 만들지 않는다. 테스트가 자식 프로세스에 선택 변수만 넘긴 것이 원인이다.

기존 부모 연결은 전용55452로 유지하면서 자식 호출 직전에 선택 변수만 지우는 회귀를 추가했다.
실제 RED는 CI와 같은 `explicit_TEST_DATABASE_URL_required`였으며, 두 subprocess가
setup의 검증된 `TEST_DATABASE_URL` 상수를 명시적으로 전달하도록 고친 뒤 관련4파일62PASS였다.
선택 변수는 finally에서 복구한다. CLI의 명시 URL 요구나 로컬 DB guard는 완화하지 않았다.
수정 후 TypeScript·해당 테스트 ESLint·diff 검사도 통과했다. 새 head의 전체 CI는 별도로 확인한다.
