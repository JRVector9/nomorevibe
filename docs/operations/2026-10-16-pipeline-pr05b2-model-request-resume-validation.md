# PR05b2 같은 owner의 모델 요청 재발견

모델 큐의 다른 owner가 대기 요청을 예약한 뒤에도 원 owner가 같은 request ID를 다시 찾을 수 있게 한다.
`findOwnPendingModelRequest(identity)`는 owner instance·boot·work key와 class/pool/route/provider/model
전체 tuple을 대조해 ID/state만 반환한다. 새 grant/token·caller 연결·물리 provider 호출·migration은 없다.

첫 await 전 strict schema로 입력의 독립 snapshot을 만들고 genuine replay는 SQL 전에 거절한다.
Primary native transaction에서 control SHARE가 첫 row lock이며 요청 row를 잠그거나 변경하지 않는다.
Active tuple partial UNIQUE를 사용한다. Expired/이전 정책의 pending 행도 관측만 하고, 호출자는 원 ID로
기존 `requestModelSlot`을 다시 호출해 현재 DB wall·정책·예약을 검사받아야 한다. 반환 ID/state는 권한이 아니다.
기존 request/begin/cancel/mark 본문은 byte exact이며 disabled와 dispatched/indeterminate charge를 유지한다.

## 실제 실행과 리뷰

| 범위 | 실제 결과 |
| --- | --- |
| 순수 strict identity | Runnable baseline class/pool 2 AssertionFAIL+13 controls → 같은 15 PASS, 164ms |
| 원 actual reserve/cancel + 다른 owner poll 후 same-ID lookup | Runnable baseline 1 AssertionFAIL+1 control → 같은 2 PASS, 788ms |
| 추가 actual 경계 | 8 PASS/원2 skip, 1.66s. Full tuple·owner/boot/work·withdrawn·expired waiting/reserved·policy change·dispatched/indeterminate·control holder/입력 snapshot·primary in readonly·restricted replay |
| Fixture vacancy 보강 | 실제 waiting request가 있을 때 setup 준비 함수가 snapshot을 반환하던 1 AssertionFAIL+정상control1 → 같은 2 PASS/9skip, 782ms |
| 정적 검사 | 변경4파일 ESLint 및 실제 deps scoped tsc exit0. 최종 vacancy1파일도 scoped exit0 |

위 10 actual은 원2+추가8의 분리 실행이며 최종11개 전체 일괄 PASS로 쓰지 않는다. 초기 lint/타입 진단은
fixture를 보완해 해결했으며 기능 RED와 구분했다. 수동 전체 unit/DB/build/typegen은 모든 PR 개발 뒤 수행한다.

B 독립 리뷰는 production 추가 P1/P2=0, fixture 기존 foreign request 변경 경로 P2=1을 발견했다.
BeforeAll이 실제 사용하는 preparationSnapshot에서 requests 전체가 비었는지 확인하고, 실패하면 fixture
control install/API와 initialized 진입 전에 거절하도록 보완했다. 기존 migration bootstrap ensureSchema는 이
검사보다 앞이므로 모든 SQL 전 무접속 guard라고 부르지 않는다. 실제 같은 preparation 경로 회귀를 추가했고
원10 body·순수 unit·source2 SHA를 보존했다. C 최종 독립 읽기 리뷰의 추가 확정 P1/P2=0이다.
Snapshot→DML 사이 임의 동시 foreign writer/임의 key 재사용 전조합까지 보호한다는 뜻은 아니다.

## DB 정산

Root 배정 loopback55549/pinned PG17/768MiB 전용 DB만 썼다. 자기 request identity와 event PK∩requestID만
정리하고 원 control µs를 같은 TX에서 복원했다. no_change는 전용 cleanup TX에서만 잠시 해제·ALWAYS 복원,
no_truncate는 유지하며 allSettled 뒤 commit 시점에만 소유 추적을 clear한다.

최초 agent final과 root 독립 readback의 public89표9행/83 journal/타연결0은 baseline exact였다. Genuine replay
profile release 뒤 관계16개+DB ACL은 NULL→명시 default로 표현이 달라 raw catalog=false를 보존했다.
Root의 별도 effective ACL SQL은 baseline owner defaults와 동등함을 확인했다. ACL normalization DML은 없다.
그 뒤 vacancy 보강의 별도 checkpoint는 원 checkpoint 대비 raw/catalog/ACL/default/journal 전체 exact였고
root도 독립 readback으로 확인했다. 후자의 exact를 최초 raw catalog 차이 증거에 소급 적용하지 않는다.
정상 STOP/exited0/OOMfalse 뒤 정확 자기 container/volume만 삭제했다. 55549는 retired로 재사용하지 않는다.

## 재현 명령과 증거

다음은 이미 실행한 기록이다. Retired DB에 재접속하지 말고 후속 담당자가 새 전용 DB를 배정받아 URL을 바꾼다.

```sh
npx vitest run tests/model-capacity-resume.test.ts
TEST_DATABASE_URL=<assigned-local-db> npx vitest run --config vitest.integration.config.ts tests/integration/model-capacity-resume.test.ts -t 'looks up waiting|expired|policy change|dispatched or indeterminate|waits on control|reads on primary|rejects replay'
TEST_DATABASE_URL=<assigned-local-db> npx vitest run --config vitest.integration.config.ts tests/integration/model-capacity-resume.test.ts -t 'keeps genuine reservation|rejects preparation with an actual foreign waiting'
npx eslint lib/llm/capacity.ts lib/llm/capacity-repository.ts tests/model-capacity-resume.test.ts tests/integration/model-capacity-resume.test.ts
```

실행 원문·실패·scoped tsconfig는 `/tmp/nomorevibe-pr05b2-a-final-report-20261016.md`와
`...-a-fixture-vacancy-report-20261016.md`에 있다. Root 증거는 `...-root-independent-proof-20261016.json`,
`...-vacancy-root-independent-proof-20261016.json`, `...-root-model-resume-cleanup-20261016.json`이다.
독립 리뷰는 `...-b-independent-review-20261016.md`, `...-c-vacancy-independent-review-20261016.md`다.
이 helper는 positive provider/물리 호출 종료·모든 caller 전환·새 boot 복구·실처리 2배·운영 활성화를 인증하지 않는다.
