# Replay row schema 구성 재사용 — 2026-10-16

`pipeline-replay-readiness.ts`의 normalizeRow에서 매 row마다 구성하던 strict schema를 module 초기화 때
이미 구성한 publicTableRows[name].element로 바꿨다. Production 변경은 expression1개다. 같은 row parse를
계속 실행하며 결과/권한을 cache하지 않는다. 숫자 검사→clone→날짜 정규화→parse 순서, projection parse,
OLD/NEW 대조·canonical/hash·coverage·policy/owner/wall·strict seal은 유지한다. 새 map/export/hook은 없다.

## 실제 검증

- 기존21+같은 객체 mutation 회귀1: 원 source22PASS(1.06초), 새 source22PASS(791ms). 이 회귀는 정상→missing
  column→unknown column→복구→unsafe integer→실제 값 변경을 매번 검사하며 입력 불변·µs/order/hash를 확인한다.
- /tmp 실제 소스 계측의 동일66corpus(성공28/기대오류38): 전체 output/error name·message/Zod issues·순서와 입력
  불변이 old/new exact다. 계측 노드를 제거하면 각각 원 source AST가 exact임을 확인했다.
- Runtime schema 생성0 기대만 원718≠0 AssertionRED→새0 GREEN이다. 이는 구조적 성능 RED이며 기존 업무 결함이 아니다.
- Module 초기 schema11/row parse718/projection parse134/전체 parse1490/clone849/hash822는 old/new 동일하다.
  이 수는 해당 corpus의 readiness 모듈 내부 관측이며 전체 애플리케이션/모든 미래 입력의 실험 증명이 아니다.
- 변경2파일 scoped tsc/eslint exit0. 원 source의 한 expression 치환과 test1block 추가 외 전체 bytes exact다.
- Root 직접 리뷰 및 C 독립 읽기 리뷰의 추가 확정 P1/P2=0이다.

후속 opt-in 진단 수정과 합친 새55551에서 원 coverage1PASS(6.87초), 원 legacy/item2PASS(8.30초)를 각각1회
확인했다. CLI의 원 exact error/출력 bytes와 strict seal/원 actual authority assertions를 유지했다. 이 local 시간은
공정한 before/after benchmark나 CI timeout 해소·실처리2배의 증거로 쓰지 않는다. 전체 수동 검증은 모든 PR 뒤다.

## DB·실행 기록·한계

55551은 원 coverage fixture가 자기 domain/job/observation10행을 남겨 baseline8→final18이다. Root 독립 final은
agent final과 exact이고 초기8행을 그대로 보존했다. 수집 raw catalog도16관계+DB ACL NULL→default 표현차이로
false, effective catalog만 exact다. Journal82/default/stage raw exact·item0/replayrole·schema0/타연결0을 확인했다.
Strict readback exit1을 감추는 수동 DML/정규화는0이다. 정상 STOP/exited0/OOMfalse 후 자기 container/volume만
삭제했고55551은 retired다. 이 변경에서 운영 DB/실모델/consumer/Oracle를 실행하지 않았다.

```sh
npx vitest run tests/pipeline-replay-readiness.test.ts
node /tmp/nomorevibe-pr453-row-schema-differential-20261016.cjs current
npx eslint lib/operations/pipeline-replay-readiness.ts tests/pipeline-replay-readiness.test.ts
```

위는 이미 실행한 명령이다. Source/검증 전체는 `/tmp/nomorevibe-pr453-row-schema-final-report-20261016.md`,
conformance JSON·원 RED/GREEN 로그, `...row-schema-c-independent-review...md`에 있다. 합친 actual3·원형 readback은
`...pr453-a-optin-actual3-report...md`, `...pr453-optin-root-independent-proof...json`,
`...pr453-optin-root-replay-cleanup...json`에 보존한다. Actual CI 개선과 전체 처리량 측정은 별도 남아 있다.
