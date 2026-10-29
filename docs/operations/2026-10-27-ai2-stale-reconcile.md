# 오래된 AI2 재검수 자동 정리·갱신·재등록 — 2026-10-27

현재 입력과 맞지 않는 표가 `input_changed`로 건너뛰어진 뒤 pending에 남았다. 공개 후48시간이 지난 원래 재검수 수요는 신규 enqueue가 다시 집지 않아 대기 시간이 계속 늘었다. 14:23:58 KST 운영 읽기에서 pending76건을 보관했으며, 그중 가장 오래된136522(Nitsuah-Labs/nitsuah-io)는 전날09:51:38 KST 생성됐다. 최근1시간 실제AI2는 agreed16/needs_human9/resolved39로, 전체AI2중단은 아니었다.

## 자동화 흐름

기존 `second-review` 잡이 매분 활성 pending/failed와 이 자동화가 닫은 미완료 수요를 검사한다. 후보ID 커서를 jobs.cursor에 보존해 한 틱에서 최대80후보를 검사하고 최대25후보를 변경한다. 정상 prefix나 재시작이 뒤의 오래된 수요를 계속 막지 않는다.

1. 실제 입력 검증과 일치하지 않는 표를 `resolved/superseded/resolved_by=stale-input-reconciler`로 닫는다. 이전 오류·실패 횟수는 남긴다. 유효한 오래된 fallback 체인의 root도 함께 소유해 새 primary를 가로막지 않게 한다.
2. 원본·최신 탐지 scan이24시간 이내이고 현재 detector와 일치하면 현재 입력 세대로 모델별 한 행을 멱등 생성한다. 공개 후48시간이 지났어도 기존 수요를 이어간다.
3. 근거가 오래됐으면 기존 crawl-fetch와 agent-evidence-refresh 큐를 사용한다. 사이트 재요청 cooldown24시간과 scan 실패 backoff·살아있는 claim을 보존한다. 갱신이 오래 걸려도 원래 수요를 임의 일수로 만료시키지 않는다.
4. 신선한 공개 근거에서 risk/sample 요건이 사라졌거나 자동 공개 요건이 없어졌으면 자동 소유 수요만 `not_required`로 명시 종료한다. 사람 판단·성공 표를 수정하지 않는다.

product→candidate→document/settings/scan/frontier→fetch item→AI2 item→job 순서로 잠근다. 새 frontier 준비가 실제 정리/갱신에 쓰이지 않으면 transaction을 rollback한다. 진행 중이거나 종료가 불명확한 dispatched/indeterminate, 유효·불명확 reservation과 live item은 건드리지 않는다. capacity행을 회수하거나 실제 모델을 종료하지 않는다. secondReview가 꺼지면 이 추가 scan 수요도 공급하지 않는다.

입력이 너무 커 로더가 거부한 후보는 그 transaction을 되돌리고 `crawl.second_review_stale_skipped/input_too_large`를 남긴 뒤 다음 후보로 진행한다. 이 경우 해당 수요를 성공 처리하거나 버리지 않는다. 제한된 replay DB에는 capacity 권한이 없어 신규 live 정리를 건너뛰며, Oracle claim-only 역할의 권한도 넓히지 않는다.

## 검증과 운영 적용

native Grok CLI가 초안을 작성했고 root가 read-only call 사이 SIGINT해 EXIT130으로 넘겼다. 이를 native 최종 성공이라고 기록하지 않는다. 사용자 지정 gpt-6.1-sol xhigh 구현/독립 검토 agent가 수요 보존·fallback·잠금·커서 문제를 보완했고 root가 diff를 검토했다. 사용자 지시에 따라 수동 test/lint/typecheck/build를 실행하지 않았다. `git diff --cached --check`만 실제EXIT0이며 필수 GitHub CI는 별도 증거다.

추가 회귀는 오래된 공개 수요→갱신→최신세대 멱등 생성, 일주일 이후 수요 보존, policy-only 변경, not_required, fallback 이력 보존, 실제 reservation 무변경, unknown binding/route 보호, cursor wrap·기존 cursor 필드 보존을 포함한다. 아직 CI/운영 반영 성공을 주장하지 않는다.

수집 확대는 PR691(main6838889)로 분리했다. 운영 DB pool 명시4·모델·토큰 예산·승인/발행 기준은 유지한다. 실제 배포는 공통 lib 영향의 공식18앱 scope/plan/run으로 진행한다. 최종 main check/이미지 발행만 기다리고 refresh-caches나6시간 관측은 배포 동기 대기에서 제외한다. 과거 once/중단/회수/원복 영수증은 재실행하지 않는다.

정리 건수, 원본·근거 갱신 대기, 최신 세대 등록, 실제 모델 결과를 구분해 읽는다. 기존76행 snapshot과 비교하고 신규 고유 발견/그 신규의 원본 확보를5·15·60분으로 측정한다. 3,000/h는 실제60분 관측 전 달성으로 기록하지 않는다. 저장소 밖 private 상태는 grok-reconcile-discovery-20261027 아래 보존하며 비밀이나 원문 env는 커밋하지 않는다.

## 운영 데이터에서 확인한 SQL 비용 보완

PR692의 운영 적용 뒤 새 stale 힌트가 완료되지 않는 현상을 확인했다. primary READ ONLY로 확인한 실행계획에서 후보별 capacity 이력 Seq Scan이 반복됐으며 전체 추정 비용은574138.10이었다. 이 수치는 실행시간이 아니다. 실제 reviewer의 약95초 실행 중 SQL과 stale 힌트의 실패 기록을 별도로 관측했으며, 잘린 오류에서 SQLSTATE는 확인하지 못했다.

종료되지 않은 capacity 행을 MATERIALIZED CTE로 한 번 선별한 뒤 후보별 작업 키를 비교한다. 예약 행은 만료 시각과 관계없이 먼저 포함하며, 힌트는 DB 현재 시각, 후보 콜백은 기존 JS 틱 시각으로 최종 판단해 이전 보호 의미를 유지한다. 각 후보 트랜잭션에서는 현재 보호 요청을 다시 조회한다. 미확정 호출·null 예약기한·불명확 AI2 identity 보호, 작업 커서, 락 순서와 모델 설정은 유지한다. capacity 이력이나 호출을 삭제·회수하지 않는다. 새 인덱스나 DB 마이그레이션은 없다.

회귀 코드는 PostgreSQL 실행계획에서 원본 capacity 접근1회와 CTE Scan을 확인하고, 활성·unknown·null 예약기한 및 다른 route의 보호 의미를 비교한다. 로컬 테스트는 실행하지 않았으며 PR의 필수 CI 결과와 운영 후 실제 정리·재등록 결과를 따로 확인한다.

스키마 후속 검토: 요청에 후보/2차 검수 ID를 직접 저장하여 문자열·JSON 비교를 줄이는 방안, 기존 활성 요청 인덱스 재사용, 완료 이력과 현재 처리 목록의 분리다. 이번 복구에 광범위한 스키마 변경은 포함하지 않는다.

## 2026-10-29 정리 공백 보완과 정합 도구 (이 차선의 남은 일 목록)

### 원인 — 미게시 pending 138985 / candidate 357316

`docs/CODEX_HANDOFF.md`가 남긴 공백이다. 관문 표(`trigger=ai_approved`)가 대기로 남은 채 후보가 갈림 보류가 아닌 자동 `needs_review`로 내려갔다. stale 힌트는 관문 표를 `approved` 후보에서만 집고, `closeSettledSecondReviews`는 `needs_review`를 사람 대기로 보아 닫지 않는다. items 모드 입장은 입력 불일치를 `input_changed`로 건너뛰기만 하므로 이 표는 끝나지 않고 매 순회마다 다시 집힌다.

### 바꾼 것 (로컬 커밋, 미배포)

1. **판별 규칙** `classifyAi2Vote`(`lib/crawl/second-review-stale.ts`). 실제 로더 검증을 통과한 표는 그대로 둔다. 통과하지 못한 표는 후보 상태·공개 slug·원본 URL·투표자 설정·1차 판단 id·prompt/rules 버전·`inputHash`·`sourceRevisionHash`·`policyHash`·1차 결론·세대 키를 비교해 까닭을 남긴다. 만든 지 오래됐다는 사실은 까닭에 넣지 않는다. 비교가 모두 같고 근거 유효기간만 지났으면 `refresh_only`로 분류해 표를 닫지 않고 원본·스캔 갱신만 요청한다. 다만 입력 해시에는 근거 신선도(`scanState`·`relationship`)가 들어가므로 실제로는 근거가 만료되면 대부분 `input_hash_changed`로 분류된다. 사람 갈림 보류(`second_review_split`)와 사람 결정(`decided_by<>'auto'`)은 `protected`로 두고 손대지 않는다.
2. **힌트 확장**: 같은 조건(자동·미공개·갈림 아님)에서 `ai_approved` 표의 후보가 `needs_review`인 경우도 정리 대상으로 집는다.
3. **계획 후 실행**(`planStaleCandidate`). 잡과 도구가 같은 계획을 쓴다.
   - 어긋난 표는 기존처럼 `resolved/superseded/resolved_by=stale-input-reconciler`로 닫는다. 실패 이력은 남긴다.
   - 다시 넣을 때 trigger는 닫은 표가 아니라 **지금 후보 상태**로 정한다. 승인 상태면 관문(`ai_approved`), 보류 상태면 1차 결론에 따라 `ai_decided` 또는 `ai_held`다.
   - 공개 전 수요를 명시적으로 `not_required`로 끝내는 경우: 후보가 공개됐거나, 사람이 결정했거나, 갈림 보류이거나, 다른 상태가 됐거나, 지금 1차 판단이 2차를 부르지 않는 경우다. 1차가 새 입력을 아직 보지 않았으면(`waiting`) 수요를 남기고 갱신만 요청한다. 시간이 지났다는 이유로 끝내지 않는다.
4. **중복 방지·순서** `admitStaleProposals`.
   - 같은 세대·입력·모델 행은 상태와 관계없이 다시 넣지 않는다.
   - 같은 후보·slug·모델에 pending/failed 표가 있으면 그 모델은 다시 배정하지 않는다.
   - 제안 안에서도 모델마다 한 행만 넣고, 투표자 순서를 유지한다.
   - 다시 넣은 행은 새 id라 소비자(id 오름차순 keyset)의 대기열 끝에 FIFO로 붙는다.
   - 묶음은 후보 id 커서로 끝까지 돈 뒤 처음으로 돌아간다.
5. **정합 도구** `scripts/reconcile-ai2-stale.ts`.
   - 기본은 dry-run이다. READ ONLY 트랜잭션에서 잡과 같은 힌트와 계획을 계산하며, 쓰거나 잠그지 않는다.
   - `--apply --actor NAME`은 second-review 잡의 실제 lease를 잡고 잡과 같은 잠금 경로로 쓴다. 바꾼 후보마다 같은 트랜잭션에 `operations_audit`(`action='reconcile-ai2-stale'`, `target='candidate:<id>'`) 한 줄을 남긴다. 잡이 lease를 쥐고 있으면 쓰지 않고 종료 코드 3으로 끝난다.
   - `--limit`의 기본값은 25, 최대값은 200이다. 출력의 `nextAfterCandidateId`를 `--after`에 넘겨 다음 묶음으로 진행한다. 0이면 끝까지 본 것이다.
   - 잡 커서를 보존하며, 끝나면 실제 잡의 다음 틱을 요청한다.
   - 사용 중인 용량 요청·살아 있는 item·입력 초과 후보는 건너뛰고 dry-run에 `blocked`로 표시한다.

### 실제 검증 (2026-10-29, 로컬 일회용 PostgreSQL 17 + pgvector 0.8.6 컨테이너, 운영 DB 아님)

- 새 단위 시험 14개, 3파일:
  - `tests/ai2-stale-rule.test.ts` 6개
  - `tests/ai2-stale-tool-args.test.ts` 3개
  - `tests/ai2-stale-fairness.test.ts` 5개
  - 명령: `npx vitest run tests/ai2-stale-`
- 새 DB 통합 시험 9개: `tests/integration/ai2-stale-reconcile.test.ts`. 명령은 `npx vitest run --config vitest.integration.config.ts tests/integration/ai2-stale-reconcile.test.ts`이다. 다룬 내용:
  - 138985 모양을 닫은 뒤 한 번만 다시 넣기
  - not_required 끝내기
  - 갈림 보류 무변경
  - 갱신 대기
  - dry-run 무쓰기와 apply 결과·감사 일치
  - `--limit`·커서
  - 실제 스크립트 실행
  - 두 투표자 단일성
  - 잡 lease 보유 중 apply 거부
- 힌트 확장만 되돌리면 이 중 3개가 실패하는 것을 확인했다.
- 회귀 결과:
  - `npx vitest run tests/ai2-stale- tests/second-review` 13파일 271개 통과
  - `npx vitest run --config vitest.integration.config.ts tests/integration/ai2-stale-reconcile.test.ts tests/integration/second-review` 16파일 289개 통과
- 전체 unit·전체 DB·종합 시험은 정책에 따라 통합 단계에서 실행하며, 이번에는 실행하지 않았다.

### 대표가 칠 명령

**배포 전에도 가능 (READ ONLY)**: 아래 SQL은 현재 상태 기준선이다. `docs/operations/2026-10-29-monitor-gate-pause-plan.md` §7 SQL 실행기와 같은 방식으로 reviewer-m3 컨테이너의 `DATABASE_URL`을 쓰며, 값은 출력하지 않는다.

```bash
CID=$(docker ps --filter name=<reviewer-m3 appName> --format '{{.ID}}')   # 정확히 1개여야 함
docker exec -i "$CID" node --input-type=module -e '
import postgres from "postgres";
let text=""; for await (const c of process.stdin) text+=c;
const sql=postgres(process.env.DATABASE_URL,{max:1,prepare:false,onnotice:()=>{}});
try { const rows=await sql.begin("read only", async tx=>{ await tx.unsafe("SET LOCAL statement_timeout = 5000"); return tx.unsafe(text); });
  console.log(JSON.stringify(rows,null,1)); } finally { await sql.end({timeout:5}); }' < Q1.sql
```

**Q1 — 138985/357316 현재 상태**
```sql
SELECT s.id, s.trigger, s.status, s.resolution, s.resolved_by, s.model, s.first_attempt_id, s.created_at, s.resolved_at,
  c.state, c.reason, c.decided_by, c.published_slug
FROM second_reviews s JOIN crawl_candidates c ON c.id = s.candidate_id
WHERE s.candidate_id = 357316 ORDER BY s.id;
```

**Q2 — 같은 공백에 남은 표 수 (성공 기준: 0, 용량·item 보호 중인 것만 남을 수 있음)**
```sql
SELECT count(*) AS stranded_gate_votes, min(s.id) AS lowest_id
FROM second_reviews s JOIN crawl_candidates c ON c.id = s.candidate_id
WHERE s.status IN ('pending', 'failed') AND s.trigger = 'ai_approved' AND s.published_slug IS NULL
  AND c.published_slug IS NULL AND c.decided_by = 'auto' AND c.state = 'needs_review'
  AND c.reason IS DISTINCT FROM 'second_review_split';
```

**Q3 — 한 후보·slug·모델의 중복 대기 (성공 기준: 0행)**
```sql
SELECT s.candidate_id, coalesce(s.published_slug, '') AS slug,
  regexp_replace(lower(trim(s.model)), '^\[mlx\][[:space:]]*', '', 'i') AS model, count(*) AS waiting
FROM second_reviews s WHERE s.status IN ('pending', 'failed')
GROUP BY 1, 2, 3 HAVING count(*) > 1 ORDER BY waiting DESC LIMIT 20;
```

**Q4 — 이 정리가 들고 있는 이월 수요 (성공 기준: 늘지 않음, 원본·스캔·1차 갱신 뒤 줄어듦)**
```sql
SELECT count(*) AS carried_demand, count(*) FILTER (WHERE s.published_slug IS NULL) AS unpublished
FROM second_reviews s
WHERE s.status = 'resolved' AND s.resolution = 'superseded' AND s.resolved_by = 'stale-input-reconciler' AND s.fallback_for_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM second_reviews t WHERE t.candidate_id = s.candidate_id
    AND t.published_slug IS NOT DISTINCT FROM s.published_slug
    AND regexp_replace(lower(trim(t.model)), '^\[mlx\][[:space:]]*', '', 'i') = regexp_replace(lower(trim(s.model)), '^\[mlx\][[:space:]]*', '', 'i')
    AND NOT (t.status = 'resolved' AND coalesce(t.resolution, '') IN ('superseded', 'model_removed')));
```

**Q5 — 도구 감사 기록 (apply 뒤)**
```sql
SELECT id, actor, target, detail->'closedIds' AS closed, detail->'retiredIds' AS retired, detail->'insertedIds' AS inserted,
  detail->'reasons' AS reasons, detail->'queuedSite' AS queued_site, detail->'queuedScan' AS queued_scan, created_at
FROM operations_audit WHERE action = 'reconcile-ai2-stale' ORDER BY id DESC LIMIT 50;
```

**[배포 뒤에만] 정리 잡의 자동 반영**: 이 변경은 공통 lib(`lib/crawl/second-review*.ts`)라 기존 공식 경로인 `npm run deploy -- scope|plan|run`으로 배포한다. 배포 뒤 second-review 잡이 1분마다 같은 정리를 하므로, 138985는 한두 틱 안에 Q1에서 `resolved/superseded`(다시 넣음) 또는 `not_required`로 바뀌어야 한다. 배포 후 5분에 Q1·Q2·Q3을 다시 확인한다.

**[배포 뒤에만] 도구 dry-run → apply**: 스크립트는 새 이미지에만 있다. 잡이 이미 정리했으면 dry-run의 `summary`가 0이고 apply할 것도 없다.

```bash
CID=$(docker ps --filter name=<reviewer-m3 appName> --format '{{.ID}}')
# 1) dry-run: 쓰기·잠금 없음. nextAfterCandidateId 가 0 이 될 때까지 --after 로 이어 본다
docker exec "$CID" node --import tsx scripts/reconcile-ai2-stale.ts --limit 25
docker exec "$CID" node --import tsx scripts/reconcile-ai2-stale.ts --limit 25 --after <nextAfterCandidateId>
# 2) apply: dry-run 의 close/retire/reinsert 를 확인한 뒤에만. 묶음 25, 같은 커서 순서로
docker exec "$CID" node --import tsx scripts/reconcile-ai2-stale.ts --apply --actor <대표 이름> --limit 25
# 종료 코드 3 = 잡이 lease 를 쥐고 있었다(쓰기 0). 잠시 뒤 같은 명령을 다시 친다. 실패한 출력은 지우지 않고 남긴다
```

apply 뒤에는 Q1~Q5를 다시 실행한다. 성공 기준은 Q2=0, Q3=0행, Q5에 바꾼 후보 수만큼 감사 줄이 있는 것이다. apply의 `job.status=completed`는 쓰기 완료만 뜻하며 다시 넣은 표의 실제 모델 결과가 아니다. 다시 넣은 표의 실제 결과는 이후 `second_reviews.status`(agreed/needs_human)로 따로 확인한다.

### 남은 것과 막힌 것

- **막힘 — 운영 실행·배포·PR**: 이 작업 환경은 SSH(22번)가 막혀 운영 DB와 원격 장비에 접근할 수 없고, 사용자 지시도 운영 쓰기·배포·push 금지다. 위 명령은 모두 미실행이며 운영 결과를 주장하지 않는다. 필수 GitHub CI는 PR을 올린 뒤 따로 확인해야 한다.
- **남음 — 운영 기준선**: Q1~Q4를 아직 운영에서 읽지 않았다. 138985의 지금 상태와 1차 최신 판단(재삽입인지 not_required인지)은 Q1로 확인한다.
- **남음(범위 밖, 변경 안 함) — 시간 기반 닫기 하나가 남아 있다**: `closeSettledSecondReviews`의 obsolete 조건이 1차 판단의 `valid_until` 경과만으로 pending/failed 표를 `superseded`로 닫는다. 이번 규칙과 성격이 다르지만, 1차 재판단 흐름에 영향을 주므로 별도 PR에서 검토한다.
- **남음 — 보호해서 남기는 대기**: 사람 갈림 보류(`second_review_split`) 후보의 pending 관문 표는 사람 결정 또는 `reopenOrphanedGateHolds`가 맡도록 그대로 둔다. 사람이 `needs_review`로 둔(`decided_by='admin'`) 후보의 관문 표도 건드리지 않는다. 운영에 이런 표가 실제로 있는지는 아직 세지 않았다.
- **남음 — 스캔 수요 집계**: `staleSecondReviewScanDemand`는 새 공백 모양을 아직 넣지 않았다. 갱신은 정리 잡이 후보를 볼 때 직접 요청한다.
