# PR01b-5 — 준비 coverage·writer fence·ledger artifact 실행 계획

사용자가 승인한 PR01 handler 계획4절을 구체화한다. 2026-10-15, base `4af0589` / [PR433](https://github.com/JRVector9/nomorevibe/pull/433).
사전 읽기3명은 모두 gpt-6.1-sol/xhigh였다. 공통 계약에 따라 세 담당 병렬 구현과 root 통합을 진행했다. 실제 결과는 [검증 기록](../../operations/2026-10-15-pipeline-pr01b-coverage-validation.md)에 구분해 기록한다. 최종 교차 리뷰·전체 로컬 검증은 완료했으며 PR 제출/최신 base CI는 남아 있다.
PR433 main CI `38733408567`은 quality·통합3shard·check·웹/워커 image 전체 SUCCESS를 확인했다.

## 목표와 경계

같은 고정 입력의 실제 준비량·보류·재개·0-ready·실행 gap을 기록하고, 호출/저장 종료 뒤 장부를 확정한다.
별도 strict ledger artifact를 DB readback으로 인증한다. 기존 v1 snapshot parser/compare는 유지한다.
fixture seal은 구현 검증이며 실제 모델 처리량 인증이 아니다. b6 provider admission·실모델 baseline은 닫혀 있다.
운영 migration/새 consumer·실제 모델 변경/추론 호출/공개 발행은 이 단계 범위에 없다.

## 사전 읽기에서 확정한 설계

1. 초기 입력 universe는 capacity_inputs 전원이다. LIMIT100의 listReviewCandidates나 양수 주기 sample로 인증하지 않는다.
   기존 actual eligibility와 current input/규칙 경로에서 stage별 eligible/modelReady/inFlight/blockedReasons를 유도한다.
   rules·기존 성공 reuse·semantic reuse·사람 보류·만료 입력을 model-ready에 넣지 않는다.
2. semantic 유효성은 frozen reference다. lease/retry/owner-history/job not_before/deadline은 실제 DBclock이다.
   retry_after 경계, jobs.locked_at+90초, owner_changed 이력의 completed_at+24시간을 모두 다룬다.
   heartbeat와 row version/hash가 오래된 만료 타이머를 무효화해야 한다.
3. 현재 event.at은 commit 시각이 아니다. 증가분을 소급해 ready로 인정하지 않는다.
   실제 before/after facts와 tx 시작 하한·commit 확인 DBclock 상한으로 보수적 구간을 계산한다.
   경합·미확인 commit·재시작 gap은 unknown이다. 하한 준비량으로 전체 구간을 증명하지 못하면 coverage_missing이다.
4. 신규 handler/호출 admission 종료와 진행 중 writer 종료를 분리한다.
   admission_closed_at 이후 예약/새 tick은 거절하지만 이미 시작한 호출의 정산과 draining writer는 허용한다.
   writers_fenced_at 이후 claim·cleanup·heartbeat·job 종료/continuation까지 모두 거절한다.
5. 공통 handler transaction 시작에서 공유 fence를 얻고 영속 run/epoch/fence를 평문 조회한다.
   순서는 공유 fence→AI2 prefix mutex→기존 domain/job/outbox→마지막 journal flush/run lock이다.
   seal/recovery는 lifecycle 직렬화→배타 fence→run lock이며 candidate/job을 재잠그지 않는다.
   최종 recorder만 fence를 잡는 방법과 run lock을 잡고 배타 fence를 기다리는 방법은 쓰지 않는다.
6. 최종 evidence와 coverage는 domain 관측을 먼저 끝내고 같은 마지막 flush에서 journal을 기록한다.
   final의 run lock 이후 새 helper가 domain 행을 읽거나 잠그지 않도록 공통 flush를 설계한다.
7. 종료는 closeAdmission→새 tick 차단→실제 handler/runJob heartbeat 완료→fixture teardown→불명 호출 확인→writer fence→장부 검증→seal이다.
   프로세스 내부 Promise만으로 fence를 대신하지 않는다. DB 공유/배타 fence가 두 연결과 늦은 writer를 방어해야 한다.
   초기 구현은 중단 run의 투명 재개를 지원하지 않는다. restart gap을 보존하고 진단·종료하며 불명 비용을 취소하지 않는다.
8. seal은 모든 call settled 또는 proven cancelled_before_dispatch, 연속 seq·frozen universe·call/final/root/slot·예약 비용 합계·초기 binding을 검증한다.
   indeterminate/unresolved면 seal과 겹치는 새 run을 거절한다. 알려진 0-ready·30분 미달은 장부 확정과 양립하지만 성능은 미판정이다.
9. 별도 `{kind:"pipeline-replay-ledger",version:1}` artifact의 모든 중첩 객체를 strict 검증한다.
   JSON sealed/verified/hash는 정합성만 나타낸다. 동일 protected DB/profile/seal을 읽어 대조한 함수만 private verified handle을 발급한다.
   JSON만 입력한 report/compare는 provenance unverified다. export는 0600/exclusive이고 credentials·nonce를 포함하지 않는다.
10. initialStateHash는 현재 caller 값이므로 실행 전 actual DB projection과 대조해야 한다.
    실제 초기 projection digest와 명시적 실험 변수/상대 timer만 정규화한 comparison digest를 구분한다.
    candidate/input/source/기존 결과/순서/cursor/결정에 영향을 주는 필드를 임의로 제외하지 않는다.
11. 신규 고유 완료는 후보별 최초 적격 final1회다. final/reReview/repeat generation은 별도 집계한다.
    사전 고정 quality cohort/labels/dataset hash가 없거나 양쪽 final이 누락되면 품질/2배 미판정이다.
    기술 실패율에는 정산 transaction의 strict failure classification이 필요하며 unknown usage를 추정하지 않는다.

## 병렬 소유권과 공통 API 고정

코드 시작 전에 root가 다음 계약을 소스와 실제 DB RED에 대조해 확정한다. 소유권 밖 파일은 인계 전 편집하지 않는다.

| 담당 | 단독 소유 제안 |
| --- | --- |
| readiness | 새 pipeline-replay-readiness 모듈·순수 reducer·초기 전체 projection·실제 SQL differential 회귀 |
| lifecycle/SQL | ledger/final/SQL·새 execution 모듈·authentic handle·seal/재시작/두 연결 회귀 |
| artifact/compare | 새 strict artifact·집계·compare 순수 모듈과 단위 회귀 |
| root | DB transaction scope/runner/jobs 경계·고정 handlers-v4 profile·export/compare CLI·통합 회귀·문서·전체 리뷰/Git |

세 담당을 병렬로 쓰되 SQL/profile/runner와 공통 마지막 flush는 각 한 소유자만 수정한다.
확정한 구현은 개별 handler마다 별도 집계 코드를 넣는 대신, 제한 DB scope의 공통 transaction hook과 7개 mutable table의 DB-owned OLD/NEW trigger를 사용한다. 시작 fence→domain→마지막 run flush→실제 COMMIT→별도 DBclock 확인 순서를 지킨다.

```ts
captureReplayReadinessProjection(tx, manifest, frozenInputs?)
currentReplayTransactionHooks(database) // before / after / commitAck / rollback
withReplayExecutionScope(run, load)
assertReplayJobAdmission(tx)
replayQuiescenceProof(run)
ledger.closeAdmission(run)
ledger.fenceWriters(run)
ledger.seal(run, quiescenceProof)
parseReplayArtifact(value)                  // 정합성만, unverified
loadVerifiedReplayArtifact(database, runId) // 고정 DB readback, 비공개 capability
compareVerifiedReplayRuns(baseline, candidate)
```

`handlers-v4`의 initial binding은 INSERT-only이고 장부/commit 확인은 append-only다. certified nested savepoint와 같은 run의 실행 scope 재진입은 거절한다. 실제 DB 전체 준비 상태를 재구성할 수 없는 env first-model fallback은 certified 경로에서 거절한다.

## 실행 순서와 실제 검증 목표

- [x] 공통 state/event/artifact·transaction flush API를 확정하고 소유권/세 전용 DB port를 배정한다.
- [x] lifecycle admission/writer 분리·공유/배타 fence·고정 profile을 실제 DB RED부터 구현한다.
- [x] artifact strict schema/집계/미판정은 독립 단위 RED부터 병렬 구현한다.
- [x] 전체 초기 projection과 actual classifier를 DB에서 인증하고 manifest initialStateHash mismatch를 거절한다.
- [x] 모든 readiness 변경·실시간 expiry·commit 상한·세션 gap을 실제 handler와 함께 기록한다.
- [x] 종료 proof·seal·검증된 DB export·별도 compare CLI를 연결한다.
- [x] 담당 간 교차 읽기 후 root가 목적/coverage/원자성/잠금/권한/비용/판정 경계를 전체 리뷰한다.
- [ ] 실제 unit/전체 DB/typegen/tsc/lint/i18n/build/bundle/Python/diff와 최신 base CI를 확인하고 PR로 납품한다.

필수 actual RED 제안:

- 101개 universe의 LIMIT 밖 준비 입력 포함; rules/reuse/human/stale/exhausted/backoff/running 제외.
- 양수 관측 사이의 실제 0-ready, retry/lease/24h 경계, heartbeat 연장에 따른 옛 timer 무효화.
- COMMIT을 막은 실제 transaction의 ready 증가 조기 인정 거절; recorder/writer rollback 시 journal 동시0.
- 실제 writer 선점 시 seal 배타 fence 대기, seal 선점 시 writer 공유 fence 대기 + candidate NOWAIT 성공.
  seal commit 뒤 늦은 writer/cleanup/heartbeat result/outbox/event 증가0.
- unresolved/indeterminate seal·겹친 start 거절, restart gap·30분 미달·quality 누락·fixture는 성능 미판정.
- JSON 인증 위조/타 DB/profile/seq·digest 누락 거절, cleanup 뒤 final 이력 보존·후보당1·재검수 분리.

## 남은 검증과 후속 범위

구현 체크와 최종 납품 체크를 구분한다. 교차 리뷰에서 발견한 재검수/현재 owner·CLI 종료 경계를 보완했다. 최종 전체 DB160파일1,745PASS/기존TODO1과 unit2,843PASS를 확인했다. PR/최신 base CI는 남아 있다.
PR433의 actual tests는 b4 결과이며 b5 증거로 재사용하지 않는다. b6 provider 전체 비용/identity/취소 계약과
실제 30분 baseline, PR02–17 개발/운영 합격, 처리량2배·Oracle DR은 별도 남은 작업이다.
