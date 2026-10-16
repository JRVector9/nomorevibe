# PR05b-0 AI1 모델 진입 제어와 대기 보존 검증

AI1 fresh claim이 공통 모델 control의 open/draining 상태를 확인한다. 현재 serving 종료 계약이 입증된 adapter가 없어 fresh 모델 호출은 명시적으로 대기하며, disabled legacy·rules·기존 재사용은 유지한다. 이 단계는 양성 공통 slot/모든 caller 연결이나 운영 상한 완료가 아니다.

## 변경과 리뷰

C source5/tests3을 root와 A가 읽었다. production P1/P2는0이다. 새 control SHARE reader는 primary short TX의 S3 앞에서 strict policy/hash를 읽는다. rules/reuse 판정 뒤 fresh INSERT 직전 typed refusal을 TX callback 밖으로 던져 선행 supersede와 item acquisition까지 rollback한다. 잘못된 control/DB 실패를 expected waiting으로 숨기지 않는다.

AI1 job은 새 admission만 중단하고 이미 진행한 lane을 abort하지 않는다. allSettled 후 진짜 원예외를 우선 보존하며 그 오류가 없을 때만 `model_capacity` deferred다. runner는 heartbeat 정산 뒤 actual job lock+DBwall/CAS로 자기 token만 반환해 producer/request/pause/processed/cursor/notBefore/history를 보존한다.

새 control 조회를 건너뛰는 범위는 실제 private active verified `currentReplayDb()` 반환뿐이다. profile/grant·fixture settings·live adapter 금지 및 기존 item replay unsupported는 유지한다. 새로운 지원 boolean/permit/예약·dispatch/정상release/DDL은 만들지 않았다.

## 실제 변경 범위 결과

| 실행 | 실제 결과 |
| --- | --- |
| 원3case baseline | disabled 실제claim/fixturetransport/result1PASS + open/draining2AssertionFAIL, exit1/1.53s |
| 동일 원3case 최소구현후 | 3PASS, exit0/1.40s |
| 새 lane3 baseline | 3 행동 실패 → 새 reader와 기존 job을 포함한 unit2파일38PASS/481ms |
| 확장11case | 10PASS/1fixture 시각 실패; 시각만 고쳐 해당 actual-wall1 단독PASS/2.17s |
| genuine fixed replay1 | 실제 restricted role의 model-control SELECT/UPDATE=false 확인 및 fixed runner 성공, 단독1PASS/2.99s |
| 정적 검사 | scoped eslint8 exit0. 전체 tsc exit2: 기존 미생성 PageProps6개, 변경8진단0; typegen/build/전체재검사0 |

15개 distinct integration case는 위의 **분리 실행**에서 통과했다. 최종 whole15 재실행 결과가 아니다. 실제 DB/API/소유권은 사용하고 외부 adapter는 fixture spy이므로 실제 provider 종료/품질/capacity grant의 증거가 아니다. 원3본문은 byte동일이다. setup의 잘못된 table명/JSON bind, wall timestamp timezone, replay manifest voter/fallback 설정 누락은 별도 실패로그로 보존해 기능 RED와 구분했다.

A가 새 integration helper에서 candidate 등록 뒤 item부재 검사 실패시 기존 foreign item도 cleanup으로 삭제하는 P2를 확인했다. 부재 확인에 성공한 key만 `ownItemKeys`에 등록하고 그 key만 정리하는 최소수정을 반영했다. 원15본문/다른7파일 byte동일이며 수정한 파일 eslint만 exit0이다. **기존15 분리PASS는 이 fixture 최소보강 전 증거**이고 이후 DB/전체 반복0이다. 최종driver SHA `6cba4ca32a6936e2a83cc42b71a46dc3512f0b564929f8a55ea6681d783ff998`.

실제 명령: `npx vitest run tests/model-capacity-admission.test.ts tests/agent-review-job.test.ts`, `TEST_DATABASE_URL=<전용55533> npx vitest run --config vitest.integration.config.ts tests/integration/agent-review-model-capacity.test.ts`의 원3/확장11/actual DB wall/genuine fixed replay 각각의 좁은 필터. 수동 전체 unit/전체 DB/종합 build는 모든 PR 개발 후에만 실행한다. 필수 자동 CI는 유지한다.

## root 데이터 인수·정리

root 독립 readback이 C의 최종 full/catalog/extra와 일치했다. public89테이블 raw와 원 stage3의 µs/legacy1contract0/model disabled 원형, journal83, replay schema/role·columnACL·다른client0을 확인했다. **whole catalog exact=false**: 정상 bootstrap/release 후16relacl 및 database ACL이 NULL에서 명시 기본 표현으로 바뀐 원자료를 보존했다. normalization DML0이며 이를 모든 principal의 effective privilege 동등 인증으로 확대하지 않는다. 나머지 캡처한 columns/schema/triggers/functions/roles/default/journal은 동일했다.

정상STOP/exited0/OOMfalse 확인 후 정확한 자기 container/volume만 삭제했다. 55533은 retired다. 인수 증거: `/tmp/nomorevibe-pr05b-c-final-report-20261016.md`, `...pr05b-a-c-source-review...md`, `...pr05b-a-fixture-item-ownership-report...md`, `...pr05b-root-readback-proof...json`, `...pr05b-root-admission-cleanup...json`.

실제 reservation+fresh attempt의 원자 결합/transport 소유 종료증거/unknown 점유/AI2·text·web·CLI 전체caller는 후속이다. disabled claim commit→외부 dispatch gap이 남으므로 provider 증명/모든 caller drain 조건 전 운영 enable은 하지 않는다. Git·CI·배포는 별도다.
