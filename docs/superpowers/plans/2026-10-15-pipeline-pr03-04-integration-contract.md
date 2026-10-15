# PR03/04 root 통합 계약 — 2026-10-15

사용자가 승인한 전체 설계와 PR03/04 범위를 유지한다. 이 문서는 세 담당의 읽기 초안을 취합한 root 결정이며 아직 새 코드·테스트 실행 결과가 아니다. 개발/병합과 운영 활성화를 구분한다.

## 공통 결정

- 기본 legacy/계약0, 신규 consumer 비활성, 기존 모델·품질·발굴 중단을 유지한다. PR01b-6 baseline과 PR05 외부 호출 장부가 준비되기 전 병렬 소비자를 켜지 않는다.
- PR02에 추가하는 공통 export는 `readItemStage(tx, guard)` 하나로 시작한다. 이미 획득한 opaque guard의 실제 tx/xid/stage를 검증하고 SHARE 아래 현재 상태를 읽는다. caller boolean이나 plain row는 권한이 아니다.
- 입력을 바꾸는 controller는 필요한 stage를 fetch→ai1→ai2 고정 순서로 먼저 잠근다. 그 뒤 기존 domain→item→jobs/outbox 순서를 유지한다. product lifecycle 등 상위 잠금과 충돌하는 경로는 실제 call graph를 확인한 root가 진입점부터 순차 통합한다.
- legacy/item 권한은 discriminated receipt로 구분하고 신규 item API에는 필수 lease를 요구한다. 실제 DB claim/input/attempt·job token·stage epoch 검증을 사용한다. 추가 WeakMap 발급 프레임워크는 도입하지 않는다.
- 원본/정책/관리자 변경은 늦은 결과의 domain 유효성을 없애지만 정상 live token을 조기 해제해 외부 호출 종료로 간주하지 않는다. 구 owner가 실제 호출을 정산한 뒤 자신의 cleanup을 원자적으로 끝내거나, 외부 종료를 별도로 증명할 때만 호출 재개 판단에 쓴다.
- 기존 request version/cursor/pause/backoff/producer 신호를 유지한다. 네트워크·LLM 대기 중 DB transaction/connection을 잡지 않는다.

## legacy drain에 대한 root 리뷰 결정

`live item=0`, `fetching=0`, `running attempt=0`, job heartbeat/90초 TTL 소실은 필요한 DB 관측일 수 있지만 이미 dispatch된 외부 호출의 종료를 증명하지 않는다. 이것만으로 `completeStageTransition`을 성공시키는 초안은 채택하지 않는다.

고정 stage별 legacy admission/inflight 종료 계약은 root 소유로 통합한다. 현재 domain이 충분한지 actual RED로 확인하고, 부족하면 필요한 최소 durable 증거를 별도 migration/PR로 설계한다. 미완료인 stage의 전환은 fail-closed로 유지하고 계약 버전을 올리지 않는다. 임의 callback·`legacyDrained:true`·TTL만으로 전환을 열지 않는다. PR03a/b 또는 PR04 일부 코드 병합을 전체 drain 합격으로 보고하지 않는다.

## 구현 소유권과 순서

| 단위 | 담당의 단독 파일 | root가 순차 통합할 공유 접점 | 첫 검증 |
| --- | --- | --- | --- |
| PR03a fetch | `lib/crawl/repository.ts` fetch 경로, `jobs/fetch.ts`, 신규 fetch authority adapter | 공통 stage read/helper, admin evidence 완료 in-tx helper, admin/reconsider/source controller | legacy가 items/draining에서 HTTP0, live foreign item 복구0, source+release+요청 중 실패 시 전체 rollback |
| PR03b AI1 | `agent-review-repository.ts` AI1 경로, `jobs/agent-review.ts`, 신규 receipt/adapter | README/source controller, admin/settings, publication gate, B5 provenance | hidden job SHARE 분리, actual attempt receipt, direct/semantic reuse 각각, stale 모든 결과 쓰기0 |
| PR04a AI2 기반 | 신규 composite policy/binding helper, 미연결 AI2 item adapter, 신규 독립 DB 회귀 | 고정 read-only domain loader export만 소비 | 정책/pool/threshold 변경 binding 불일치, 실제 vote 단일 승자·stale 저장0·fallback 원자 rollback |
| PR04b/c AI2 연결 | `second-review.ts`, `second-review-input.ts`, `jobs/second-review.ts`, `published-second-review.ts` | PR03 공유 source/admin·발행·legacy/B5 변경은 소유권 반환 뒤 root 통합 | 14 direct mutation 및 간접 controller, 공개분 keep/ban 경합, 필수 독립 slot gate |

`repository.ts`, `agent-review-repository.ts`, `admin-review.ts`, generic items repository, replay profile은 동시에 두 담당이 편집하지 않는다. source 구현자와 독립 DB 검증자의 파일/DB port도 분리한다. Git·migration 번호·전체 검증·PR/merge는 root만 수행한다.

## 유지할 domain 의미

- fetch binding은 실제 frontier claim CAS 그대로 사용한다. source 결과와 필요한 judge 요청·관리자 evidence 소비·lease 완료를 하나의 transaction에 넣는다. 배치 요청→결과별 요청으로 바뀌는 경우 version 증가 의미를 실제 회귀로 확인하고 중복 완료 요청0을 보장한다.
- AI1 receipt는 actual attempt ID를 담는다. direct succeeded reuse의 과거 token은 덮지 않는다. semantic reuse의 새 attempt 및 item token은 실제 같은 transaction에 결합한다. rules·observe·human hold를 모델 완료로 세지 않는다.
- AI2 policyHash는 base review policy+현재 AI2 gate 설정의 composite stage hash다. published row의 slug placeholder를 실제 inputHash로 오인하지 않고 잠긴 ReviewInput을 바인딩한다. 실제 first generation/root/slot/fallback·canonical 모델 독립성을 다시 검증한다.
- B5는 현재 job-token 기반 인증이다. item UUID를 바꾸고 기존 인증을 통과한 것으로 보고하지 않는다. stage/item의 실제 projection·journal·writer authority·profile 권한을 함께 확장하고 기존 legacy B5 회귀를 유지한다. 인증되지 않은 item 실행은 certified 처리량에서 제외한다.

## 납품 gate

각 담당은 실행 가능한 behavioral RED→GREEN, actual DB barrier/rollback, 독립 fixture 및 연결 정리, 정확한 파일 목록과 남은 경계를 보고한다. root가 목적 적합성·코드·교차 리뷰 뒤 전체 unit/DB·타입/lint/i18n/Python/build/bundle·최신 base CI를 확인한다. 작은 PR 완료가 PR03/04 전체나 2배·Oracle DR 완료를 뜻하지 않는다.
