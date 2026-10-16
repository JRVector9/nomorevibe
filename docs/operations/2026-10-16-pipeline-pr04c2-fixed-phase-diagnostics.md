# PR04c2 CI 시간초과의 고정 경계 진단 — 2026-10-16

PR453의 profile SQL 개선 뒤 CI38850309527에서도 item5case가20초를 넘었다. 같은 source의 fresh local 성공을 공유 CI 원인 해소로 보지 않고, 원래 동작을 유지한 고정 진단을 추가했다. root는 C의 읽기 조사 및 A의2파일 최소계획/최종diff를 직접 검토했다.

## 변경

private certified runner에서 기존 scope/seal/verified readback/report의 시작·종료·실패만 stderr로 기록한다. 고정 label·invocation ordinal·legacy/item만 사용하고 원 error/query/params/owner/token/runID/모델/문서 원문을 출력하지 않는다. 공개 callback/증명값/실행설정은 추가하지 않았다.

기존 prepare가 이미 반환한 preview에서 고정 table별 행수·universe/item/stage 개수와 JSON UTF8 크기를 한 번 기록한다. 크기 측정 자체 시간도 별도다. 추가 capture/SQL/parse/hash/clone은 없다. 원 report도 같은 artifact에 한 번 호출한다.

A의 역변환 및 AST 대조에서 원14개 it 전체 call text, driver82/runner2 tagged SQL은 정확히 같았다. profile/권한검사 빈도·native ACK·strict parse·원20초 및 manifest120초를 유지했다. runtime admission이나 심사 정책을 바꾸는 수정이 아니다.

## 실제 좁은 검증

승인한 원 legacy1+첫item1을 새 전용55540에서 각각 한 번만 실행해2PASS/12skip,16.82초/exit0이었다. 추가 whole14/전체suite/build/typegen은 실행하지 않았다. 해당2파일 scoped eslint/tsc exit0. 신규4phase×2run의16 begin/end와 기존29sequence가 정산됐다.

| fresh case | scope ms | seal ms | readback ms | report ms |
| --- | ---: | ---: | ---: | ---: |
| legacy |3938.621|585.410|535.127|916.136|
| item |3877.424|1198.990|1923.250|1646.710|

preview는 legacy12427/item13943bytes, 진단 비용0.059/0.066ms였다. 이 단일 fresh 실행으로 CI 성능 향상률이나 정확한 병목을 판정하지 않는다. scope는 inner drain을 포함하고 앞뒤 open/prepare/start/outer drain/fence/close의 비용은 별도 미측정이다.

root는 반환55540의 고정container/image/name/label/mount/loopback/memory를 확인하고 독립조회했다. baseline whole raw87표/8행·82journal/default/jobs/stageµs는 정확히 같고 agentfinal 전체 JSON과도 같았다. 타client0이었다. 기존 profile release 뒤16relation ACL+database ACL의 NULL→명시default 표현차이로 **whole catalog exact=false/readback exit1을 그대로 보존**했다. 이 단계는 추가 effective 권한 동등성 비교를 실행하지 않았고 ACL 정규화/복원 DML도 하지 않았다. 정상STOP/exited0/OOMfalse 뒤 자기container/volume만 제거했다.55540은retired이며 재접속하지 않는다.

정확 증거: `/tmp/nomorevibe-pr453-a-fixed-final-report-20261016.md`, `...fixed-final-shas...json`, `...fixed-conformance...json`, `...fixed-ast-conformance...json`, `...root-fixed-independent-proof...json`, `...root-fixed-phases-cleanup...json`. 앞선 profile32 conformance는 별도 검증이고 이번 readback false를 소급해 true로 바꾸지 않는다.

## 명령·다음 판정

```sh
TEST_DATABASE_URL="$OWN_TEST_DATABASE_URL" npx vitest run --config vitest.integration.config.ts tests/integration/pipeline-replay-item-journal.test.ts -t 'preserves genuine legacy v1 fixture certification|certifies actual AI1 legacy then AI2 item work with persisted owner journal and a strict seal'
npx eslint lib/operations/pipeline-replay-runner.ts tests/integration/pipeline-replay-item-journal.test.ts
npx tsc --project /tmp/nomorevibe-pr453-a-fixed-tsconfig-20261016.json --noEmit --incremental false
```

DB 명령은 별도 배정한 새 전용 DB에서만 실행한다. 다음 필수 자동 CI가 실제 공유 universe의 phase/크기를 보여주면 병목을 좁힌다. 새 근거 없이 검사 cache/빈도감소/timeout확대/foreign데이터삭제/인증 완화로 성공시키지 않는다. 현재 원인·성능 개선·CI 통과·운영 적용은 미확정이다.
