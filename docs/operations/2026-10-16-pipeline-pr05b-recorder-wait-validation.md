# PR462 recorder 대기 fixture 보완 — 2026-10-16

CI38850700641의 integration1은 admission의 `job_lease_lost` 대신 capacity_runs 잠금 오류를 받았다. PostgreSQL 서비스 로그가 같은 SELECT의 lock timeout을 확인했다. 원 fixture의 잔여 job 수명 약1초와 검증 연결의 잠금 제한1초가 겹쳤다. 이후 runner ACK의 job_lease_lost는 admission 최종 검증의 대체 증거가 아니다.

생산 코드와 제한을 바꾸지 않고 기존 마지막 case만 보완했다. 실제 runJob 진입 뒤 첫 fetch stage를 잠그고 동일 admission PID의 대기를 확인한다. 별도 observer TX의 job FOR UPDATE NOWAIT와 token 일치로 job SHARE 취득 전임을 확인한 뒤 잔여500ms로 한 번만 고정한다. Stage 해제 후 job 갱신은 없다. 동일 PID가 실제 recorder에서 대기하며 job이 살아 있음을 필수 확인하고 DB 시계의 만료 뒤 recorder를 해제한다.

기존 admission·runner의 엄격한 job_lease_lost, 전체 raw rollback, superseded 전이 없음 assertion은 그대로다. 다른32개 runtime case의 전체 prefix도 byte exact다. Profile1초/TTL90초/heartbeat15초/test20초·권한·manifest·생산4파일 SHA를 유지했다. 두 holder와 원 admission을 실제 정산한 뒤 기존 drain/close/release를 수행하며 원 오류를 보존한다. 임의500ms 이상 프로세스 정지에서도 성공한다는 보장은 없다.

## 실제 검증

- 원 CI 로그와 잠금 원인: `/tmp/nomorevibe-pr462-root-head-db732-ci-integration1-20261016.log`, `...pr462-a-recorder-wait-investigation...md`.
- 지정 normal control1 + 교정case1: **2PASS/31skip,2.14초,exit0**. 각 case 한 번이며 전체33/file/shard를 재실행하지 않았다.
- 단일 파일 ESLint와 scoped tsc: 실제 exit0. 초기 closure narrowing 타입 오류는 const PID로 고쳤고 기능 RED로 세지 않는다.
- 최종 driver SHA `a62a4636ef24e5f9555fc5a11b41f874f4fab4b145152a9e0e70b8232da3346f`. Conformance와 원 assertion block exact를 root가 직접 대조했다. 기본 reporter에는 추가 proof marker의 숫자 PID/headroom 출력이 없으므로 실제 query/assertion 통과와 구분한다.
- Root가 반환55543의 exact container/image/label/mount/loopback/memory를 확인하고 독립 snapshot을 실행했다. Public89표/9행 raw·µs,83journal,defaults,stage 및 agent final과 exact/타 연결0이다.
- Raw catalog는 관계16개와 DB ACL의 NULL→명시 default 표현 차이로 **false/readback exit1 그대로** 보존했다. 나머지 수집 catalog 항목은 exact다. 이 단계에서 effective ACL 비교를 새로 실행했다고 주장하지 않는다. ACL 정규화 DML0이다.
- 정상 STOP/exited0/OOMfalse 후 자기 container/volume만 삭제했다. **55543 retired: 재접속·재생성하지 않는다.**

Root 근거는 `/tmp/nomorevibe-pr462-root-recorder-independent-proof-20261016.json`, `...pr462-root-recorder-cleanup...json`이다. 최종 A 보고·override·conformance·실행 로그도 별도 보존했다.

## 명령·남은 검증

새 전용DB를 배정한 경우에만 다음 좁은 필터를 사용한다. 이미 폐기한55543을 다시 사용하지 않는다.

```sh
TEST_DATABASE_URL="$OWN_TEST_DATABASE_URL" npx vitest run --config vitest.integration.config.ts tests/integration/second-review-item-claim.test.ts -t '^(closes only the invalid pending legacy row under the actual job|rolls back invalidation when a nondeferred replay recorder wait outlives the actual job)$'
npx eslint tests/integration/second-review-item-claim.test.ts
```

이 결과는 해당 fixture의 의도한 순서를 실제로 확인한 로컬 증거다. 새 공유 CI와 별도 HTTP native 대기 실패는 아직 확인 중이다. 양성 모델 permit·실제 provider 종료·전체 caller·운영 활성화·처리량2배를 해결한 변경이 아니다. 수동 전체 검증은 모든 PR 개발 뒤 수행한다.
