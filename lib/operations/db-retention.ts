import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { PACKAGE_PROOF_KEY } from "@/lib/crawl/package-proof";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import { assertRoleLease, roleLeaseFromEnv } from "@/lib/jobs/role-leader";
import { readModelCapacityLedgerRetentionDays } from "@/lib/llm/capacity-retention";

/**
 * DB 보관 정리(2026-11-15 소유자 승인 「④⑤⑥ PR 만들어줘」) — maintenance 잡 db-retention 이 한 시간마다 조금씩 돈다.
 *
 * 같은 날 운영 스크립트(nmv-replaced-path-ops/db-retention-123.mts)로 한 번 정리한 ①발굴 근거 ②저장소 스캔 ③일일 가동 집계를 같은 규칙으로
 * 이어 하고, ④수집 원본 줄이기 ⑤모델 장부 보관을 더한다. 모든 쓰기는 짧은 트랜잭션 한 묶음이고 잡 lease·역할 lease·DR writer fence 를 지난다.
 * 시각 비교는 모두 DB 시계로 한다 — timestamp(시간대 없음) 칸은 UTC 벽시계라 `now() AT TIME ZONE 'UTC'` 와 견준다.
 *
 * ④ crawl_documents — **행을 지우지 않는다**(소유자 「메이커 소유확인은 중요한 기능이야. 아이디 근거 사라지지 않도록해야해」). 수집 원본은
 *    메이커 소유 확인의 저장소 id 근거다(lib/me/maker-claims.ts storedRepositoryAnchors 가 같은 lower(repo) 의 repo_meta->>'id' 를 모두 읽는다).
 *    자동 거절(auto·deepseek)·미발행·수집 30일 지남·같은 이름의 제품도 거절 아닌 후보도 없는 행의 repo_meta 만, 코드가 읽는 키(REPO_META_KEEP_KEYS)로 줄인다.
 * ⑤ model_capacity_requests·events — 끝난(settled·withdrawn) 지 관리자 설정 일수(capacity.ledgerRetentionDays, 기본 14·바닥 8)가 지난 요청과
 *    그 이벤트 전부. 열린 행·결과 미확정 행, 아직 열린 생성(generationHash)·논리 작업 열쇠(logical_work_key)에 묶인 행, 처리 중인 LLM 보조 작업·
 *    적용 전 소개 교정이 가리키는 행은 남긴다. 이벤트 표의 추가 전용 트리거는 0187 이 이 트랜잭션 설정(nmv.capacity_retention)에만 DELETE 를 연다.
 * ⑥ 이 모두를 한 잡에서 — 발굴 근거(최근 24시간 + 저장소마다 최근 서로 다른 commit 5개), 스캔(7일 · 보존 집합 밖), 가동 집계(KST 오늘 − 40일 전).
 *
 * 저장소 id 근거 표(repository_identity_anchors, 0191)는 이 잡의 대상이 아니다 — 지우지 않는 표다(DB 가 DELETE·TRUNCATE 를 거절한다). 여기에 넣지 않는다.
 * ④의 줄이기는 id·node_id 를 그대로 두므로 근거 트리거(id 가 바뀔 때만 돈다)도 부르지 않는다.
 */

/**
 * repo_meta 에서 남기는 키 — 저장소의 모든 읽는 곳(2026-11-15 origin/main 전수)에서 모았다. 줄인 행도 판정·재판정·관리자 심사·발행이 같은 답을 낸다.
 * - id · full_name · owner{login,id,type}: 메이커 소유 근거(maker-claims storedRepositoryAnchors·notifyNewListingMine), 이름 바뀐 저장소 중복 막기
 *   (crawl/repository.ts saveFetchedDocument · crawl_documents_github_id_idx), 스타 자동 승인(star-auto-approval.ts), 인기 저장소 검사(agent-review-repository.ts)
 * - node_id · owner.node_id: 읽는 곳은 없지만 GitHub 의 다른 id 근거(RepoAnchor 의 nodeId 꼴)라 소유자 규칙대로 남긴다
 * - name: 스팸 신호(spam-signals.ts repoName)·분류 대기 이름(operations/categories.ts)
 * - private · fork · archived: 스타 자동 승인·판정 사실(rules.ts factsFromRepoMeta)·재고(reconsider.ts)·원본 바뀜 판단(judgedSourceChanged)
 * - description · topics · language: 판정·발행 초안·분류·심사 입력(agent-review-contract.ts)·소개 짓기 증거(tagline.ts)·검색 문서(search-refresh.ts)·정리(tidy-catalog.ts)
 * - homepage: 수집이 배포 주소(product_url)로 옮긴 값의 원문(crawl/jobs/fetch.ts)
 * - stargazers_count · created_at · pushed_at: 판정·재판정(rejudge.ts)·관리자 심사 정렬·거르기(admin-review*.ts)·심사 사실(repoFacts)·홈 화면(home-pulse.ts)·저장소 나이
 * - default_branch: 썸네일(thumbnails/resolver.ts)·패키지 증거 조사 가지(fetch.ts)
 * - has_issues: 스팸 약한 신호 issues_disabled(spam-signals.ts)
 * - nmv_package_proof(PACKAGE_PROOF_KEY): 설치형 증거(package-proof.ts packageProofOf → 판정·심사 입력)
 * 버리는 것: *_url 46개, permissions, license, organization, template_repository, parent/source, 각종 개수(forks·watchers·open_issues·size …)와
 * has_* 나머지·visibility·updated_at 등 — 읽는 곳이 없다. 다시 수집하면 repo_meta 전체를 새로 쓴다(putDocument·saveFetchedDocument).
 */
export const REPO_META_KEEP_KEYS = Object.freeze(["id", "node_id", "name", "full_name", "owner", "private", "fork", "archived", "description", "homepage",
  "topics", "language", "stargazers_count", "created_at", "pushed_at", "default_branch", "has_issues", PACKAGE_PROOF_KEY] as const);
export const REPO_META_OWNER_KEEP_KEYS = Object.freeze(["login", "id", "node_id", "type"] as const);

/** 줄이기 대상 — 수집한 지 이만큼 지난 자동 거절 원본(소유자 승인 규칙) */
export const DOCUMENT_SHRINK_AFTER_DAYS = 30;
export const SCAN_RETENTION_DAYS = 7;
export const HEALTH_DAILY_RETENTION_DAYS = 40;
/** 발굴 근거: 최근 이만큼은 모두 남긴다 · 저장소마다 최근 서로 다른 commit 이만큼 */
export const DISCOVERY_KEEP_HOURS = 24;
export const DISCOVERY_KEEP_SHAS = 5;
/** 발굴 근거 커서는 이만큼 지난 행까지만 넘긴다 — 늦게 commit 된 낮은 id 를 지나치지 않게 한 시간 여유 */
const DISCOVERY_CURSOR_LAG_HOURS = DISCOVERY_KEEP_HOURS + 1;

const LEDGER_BATCH = 500;
const DISCOVERY_ROWS_PER_BATCH = 5_000;
const DOCUMENT_ID_SPAN = 5_000;
const SCAN_BATCH = 2_000;
/** 하루 한 바퀴 도는 부분(원본 줄이기·스캔·가동 집계)이 다시 도는 간격 */
export const DAILY_PASS_MS = 20 * 60 * 60_000;

export const DB_RETENTION_PARTS = ["ledger", "evidence", "documents", "scans", "health"] as const;
export type DbRetentionPart = (typeof DB_RETENTION_PARTS)[number];
export type DbRetentionCursor = {
  v: 1;
  /** 이번 틱에 먼저 설 부분의 차례 — 한 부분이 예산을 다 써 다른 부분이 굶지 않게 틱마다 돌린다 */
  lead?: number;
  evidence?: { afterId: number };
  documents?: { afterId: number; passDoneAt?: string };
  scans?: { afterId: number; passDoneAt?: string };
  health?: { passDoneAt?: string };
};
export type PartResult = { counts: Record<string, number | string | boolean>; caughtUp: boolean };

const keyList = (keys: readonly string[]): SQL => {
  for (const key of keys) if (!/^[a-z_]{1,40}$/.test(key)) throw new Error("db_retention_key_invalid");
  return sql.raw(`ARRAY[${keys.map(key => `'${key}'`).join(",")}]::text[]`);
};
const KEEP = keyList(REPO_META_KEEP_KEYS), OWNER_KEEP = keyList(REPO_META_OWNER_KEEP_KEYS);
const UTC_NOW = sql`(now() AT TIME ZONE 'UTC')`;

/** 줄인 repo_meta — 남기는 키만, owner 는 객체일 때 그 안의 남기는 키만. 값은 글자 그대로(null 도) 옮긴다 */
export const shrunkRepoMetaSql = (column: SQL): SQL => sql`coalesce((SELECT jsonb_object_agg(e.key, CASE WHEN e.key = 'owner' AND jsonb_typeof(e.value) = 'object'
    THEN coalesce((SELECT jsonb_object_agg(o.key, o.value) FROM jsonb_each(e.value) o WHERE o.key = ANY(${OWNER_KEEP})), '{}'::jsonb)
    ELSE e.value END)
  FROM jsonb_each(${column}) e WHERE e.key = ANY(${KEEP})), '{}'::jsonb)`;
/** 아직 줄일 키가 남았나 — 이미 줄인 행은 다시 쓰지 않는다(멱등) */
const needsShrinkSql = (column: SQL): SQL => sql`CASE WHEN jsonb_typeof(${column}) = 'object' THEN
    EXISTS (SELECT 1 FROM jsonb_object_keys(${column}) k WHERE NOT (k = ANY(${KEEP})))
    OR (jsonb_typeof(${column}->'owner') = 'object' AND EXISTS (SELECT 1 FROM jsonb_object_keys(${column}->'owner') k WHERE NOT (k = ANY(${OWNER_KEEP}))))
  ELSE false END`;

/** 정리 쓰기 하나 — DR writer fence → (역할 lease) → 쓰기 → 잡 lease 확인을 한 commit 으로 */
function retentionWrite<T>(lease: JobLease | undefined, write: (tx: ProductTransaction) => Promise<T>): Promise<T> {
  const roleLease = roleLeaseFromEnv("maintenance", process.env);
  return withJobLeaseWrite(lease, async tx => {
    if (roleLease) await assertRoleLease(tx, roleLease);
    return write(tx);
  });
}
const count = (rows: readonly unknown[]) => rows.length;

// ───────────────────────── ⑤ 모델 장부 ─────────────────────────

/** 0187 이 적용됐나 — 아니면 이벤트 DELETE 는 55000 으로 거절되므로 장부 부분을 건너뛴다 */
export async function ledgerRetentionReady(executor: Pick<ProductTransaction, "execute"> = db): Promise<boolean> {
  const [row] = await executor.execute<{ ready: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'model_capacity_events'::regclass AND tgname = 'model_capacity_events_retention_check' AND tgenabled = 'A') AS ready`);
  return row?.ready === true;
}

/** 끝난 지 days 일 지난 행 — 지우기 직전에 잠근 행으로 한 번 더 본다 */
const expiredLedgerSql = (days: number, alias = "r"): SQL => {
  const r = sql.raw(alias);
  return sql`((${r}.state = 'settled' AND ${r}.settled_at < clock_timestamp() - make_interval(days => ${days}))
    OR (${r}.state = 'withdrawn' AND ${r}.updated_at < clock_timestamp() - make_interval(days => ${days})))`;
};

/** 생성(generationHash) 단위로 이어 보내는 두 종류 — 같은 생성의 앞 단계를 읽어 다음 단계를 보낸다(capacity-repository.ts readCrawlTaglineContinuation·search-verify) */
const GENERATION_KINDS = ["crawl_tagline_gateway", "search_verify_gateway"] as const;
/** 대상(logical_member_keys)이 열린 행과 겹치면 남기는 경로 — 이어 보낼 자식(waiting·reserved)은 아직 binding 이 없어 생성으로 못 묶는다 */
const MEMBER_ROUTES = ["crawl-tagline", "product-search-verify", "search-query-translate"] as const;

/**
 * 남기는 끝난 행 — 지울 후보에서 뺀다(2026-11-15 장부 읽는 곳 전수 감사).
 * - 처리 중인 LLM 보조 작업(claimed·indeterminate)이 가리키는 요청, 그 작업의 결과 행이 가리키는 요청(소개 재검수의 사실 호출), 적용 전 소개 교정의 요청:
 *   완료·적용 TX 가 그 settled 행을 다시 읽는다(lib/domain/products/intro-assist-runtime.ts·audit-runtime.ts·news-runtime.ts·intro-assist-repository.ts).
 * - 종료 근거가 있는 withdrawn(사람 검토 operator_review·경계 퇴장 *_boundary_exit·local_call_ended 등): DR·운영 도구가 멱등 재시도에서 그 행을 다시 읽는다
 *   (lib/operations/dr/*-boundary-release.ts, provider-boundary-relay.ts). 수백 건뿐이라 계속 남긴다.
 * - 소개 짓기·키워드 검수의 한 생성: 같은 생성에 아직 기한이 안 지난(열린 것 포함) 행이 하나라도 있으면 그 생성 전부를 남긴다 — 앞 단계만 지워지면
 *   이어 읽기가 broken(ledger_mismatch)이 되어 그 후보가 원본이 바뀔 때까지 멈춘다. 다 지난 생성은 한 묶음에서 통째로 지운다(pruneLedgerBatch).
 * - 소개 짓기·키워드 검수·검색어 번역: 같은 대상(logical_member_keys)의 행이 아직 열려 있으면 남긴다 — 기다리는 자식은 binding 이 없다.
 * - 열린 행과 같은 생성·같은 논리 작업 열쇠(logical_work_key — 검색어 번역 스냅숏 등)를 쓰는 행.
 */
const protectedLedgerSql = (days: number, alias = "r"): SQL => {
  const r = sql.raw(alias);
  const generation = (kind: string) => sql`(coalesce(${r}.dispatch_binding->>'kind', '') = ${kind} AND EXISTS (SELECT 1 FROM model_capacity_requests s
      WHERE s.dispatch_binding->>'kind' = ${sql.raw(`'${kind}'`)} AND s.state IN ('dispatched','indeterminate','settled')
        AND s.dispatch_binding->>'generationHash' = ${r}.dispatch_binding->>'generationHash' AND s.request_id <> ${r}.request_id
        AND NOT ${expiredLedgerSql(days, "s")}))`;
  // 연산자마다 NULL 이 섞이지 않게 쓴다(NOT NULL 은 거르기에서 빠진다). 그래도 NULL 이면 남긴다(coalesce … true) — 모르면 지우지 않는다
  return sql`coalesce((EXISTS (SELECT 1 FROM llm_assist_work w WHERE w.capacity_request_id = ${r}.request_id AND w.state IN ('claimed','indeterminate'))
    OR EXISTS (SELECT 1 FROM llm_assist_results x JOIN llm_assist_work w ON w.id = x.work_id
      WHERE x.capacity_request_id = ${r}.request_id AND w.state IN ('claimed','indeterminate'))
    OR EXISTS (SELECT 1 FROM intro_assist_corrections c WHERE c.capacity_request_id = ${r}.request_id AND NOT c.applied)
    OR (${r}.state = 'withdrawn' AND ${r}.terminal_evidence IS NOT NULL)
    OR ${sql.join(GENERATION_KINDS.map(generation), sql` OR `)}
    OR (${r}.route_id IN (${sql.join(MEMBER_ROUTES.map(route => sql`${route}`), sql`, `)})
      AND coalesce(${r}.logical_member_keys && (SELECT coalesce(array_agg(DISTINCT m), '{}'::text[]) FROM open_rows o, unnest(o.logical_member_keys) AS m), false))
    OR (${r}.dispatch_binding->>'generationHash' IS NOT NULL AND ${r}.dispatch_binding->>'generationHash' IN (SELECT o.dispatch_binding->>'generationHash'
      FROM open_rows o WHERE o.dispatch_binding->>'generationHash' IS NOT NULL))
    OR (${r}.logical_work_key IS NOT NULL AND ${r}.logical_work_key IN (SELECT o.logical_work_key FROM open_rows o WHERE o.logical_work_key IS NOT NULL))), true)`;
};
/** 열린 행 — 부분 색인 둘(live_work_idx: waiting·reserved·dispatched, unknown_hold_idx: indeterminate)로 읽는다 */
const OPEN_ROWS = sql`open_rows AS MATERIALIZED (
  SELECT o.dispatch_binding, o.logical_work_key, o.logical_member_keys FROM model_capacity_requests o WHERE o.state IN ('waiting','reserved','dispatched')
  UNION ALL SELECT o.dispatch_binding, o.logical_work_key, o.logical_member_keys FROM model_capacity_requests o WHERE o.state = 'indeterminate')`;

/** 지울 후보 고르기(잠금 없이) — 시험·운영 측정이 같은 글을 쓴다 */
export const ledgerCandidatesSql = (days: number, state: "settled" | "withdrawn", limit = LEDGER_BATCH): SQL => {
  const order = state === "settled" ? sql`r.settled_at` : sql`r.updated_at`;
  return sql`WITH ${OPEN_ROWS}
      SELECT r.request_id, r.state, r.dispatch_binding->>'kind' AS kind, r.dispatch_binding->>'generationHash' AS generation FROM model_capacity_requests r
      WHERE r.state = ${state} AND ${order} < clock_timestamp() - make_interval(days => ${days}) AND NOT ${protectedLedgerSql(days)}
      ORDER BY ${order} LIMIT ${limit}`;
};

/**
 * 한 묶음 — 한 트랜잭션: 후보 잠금(SKIP LOCKED) → 고른 행의 생성 형제를 모두 잠금(하나라도 못 잠그면 그 생성은 이번에 빼기) → 이벤트 DELETE → 요청 DELETE
 * (같은 기한 조건으로 다시). 0187 트리거가 두 DELETE 끝에서 지운 행이 모두 8일 지난 끝난 행인지 다시 본다.
 */
export async function pruneLedgerBatch(lease: JobLease | undefined, days: number, state: "settled" | "withdrawn", limit = LEDGER_BATCH):
  Promise<{ requests: number; events: number; picked: number }> {
  if (!Number.isSafeInteger(days) || days < 8) throw new Error("ledger_retention_days_invalid");
  return retentionWrite(lease, async tx => {
    await tx.execute(sql`SELECT set_config('nmv.capacity_retention', 'on', true)`);
    const picked = await tx.execute<{ request_id: string; state: string; kind: string | null; generation: string | null }>(sql`${ledgerCandidatesSql(days, state, limit)}
      FOR UPDATE OF r SKIP LOCKED`);
    if (!picked.length) return { requests: 0, events: 0, picked: 0 };
    const doomed = new Set(picked.map(row => row.request_id));
    // 생성 단위: 고른 행과 같은 생성의 나머지 행(모두 기한이 지났다 — 아니면 위에서 남겼다)을 함께 지운다. 잠긴 형제가 있으면 그 생성은 다음 틱으로 미룬다
    const generations = new Map<string, { kind: string; generation: string }>();
    for (const row of picked) if (row.kind && row.generation && (GENERATION_KINDS as readonly string[]).includes(row.kind) && row.state === "settled")
      generations.set(`${row.kind}:${row.generation}`, { kind: row.kind, generation: row.generation });
    for (const { kind, generation } of generations.values()) {
      // 이어 읽기는 보낸 행(dispatched·indeterminate·settled)만 본다 — 0091·0092 부분 유일 색인과 같은 조건이라 그 색인을 탄다
      const sameGeneration = sql`s.dispatch_binding->>'kind' = ${sql.raw(`'${kind}'`)} AND s.state IN ('dispatched','indeterminate','settled')
        AND s.dispatch_binding->>'generationHash' = ${generation}`;
      const locked = await tx.execute<{ request_id: string }>(sql`SELECT s.request_id FROM model_capacity_requests s WHERE ${sameGeneration}
          AND ${expiredLedgerSql(days, "s")} FOR UPDATE OF s SKIP LOCKED`);
      const [{ n: total }] = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM model_capacity_requests s WHERE ${sameGeneration}`);
      if (locked.length === total) for (const row of locked) doomed.add(row.request_id);
      else for (const row of picked) if (row.kind === kind && row.generation === generation) doomed.delete(row.request_id);
    }
    if (!doomed.size) return { requests: 0, events: 0, picked: picked.length };
    const ids = sql.join([...doomed].map(id => sql`${id}::uuid`), sql`, `);
    const events = await tx.execute(sql`DELETE FROM model_capacity_events WHERE request_id IN (${ids}) RETURNING 1`);
    const requests = await tx.execute(sql`DELETE FROM model_capacity_requests r WHERE r.request_id IN (${ids}) AND ${expiredLedgerSql(days)} RETURNING 1`);
    // 잠근 행이라 그사이 바뀔 수 없다 — 다르면 이 묶음을 통째로 되돌린다
    if (requests.length !== doomed.size) throw new Error("ledger_retention_changed");
    await tx.execute(sql`SELECT set_config('nmv.capacity_retention', '', true)`);
    return { requests: count(requests), events: count(events), picked: picked.length };
  });
}

export async function pruneLedger(lease: JobLease | undefined, more: () => boolean): Promise<PartResult> {
  if (!await ledgerRetentionReady()) return { counts: { skipped: "migration_pending" }, caughtUp: true };
  const days = await readModelCapacityLedgerRetentionDays(db);
  let requests = 0, events = 0, caughtUp = true;
  for (const state of ["settled", "withdrawn"] as const) {
    for (;;) {
      if (!more()) { caughtUp = false; break; }
      const batch = await pruneLedgerBatch(lease, days, state);
      requests += batch.requests; events += batch.events;
      if (batch.picked < LEDGER_BATCH) break;
    }
  }
  return { counts: { days, requests, events }, caughtUp };
}

// ───────────────────────── 발굴 근거 ─────────────────────────

/** 저장소 키 묶음 하나에서 남길 것(최근 24시간 · 최근 서로 다른 commit 5개의 마지막 행)을 뺀 나머지를 지운다 */
export async function pruneDiscoveryKeys(lease: JobLease | undefined, keys: readonly string[]): Promise<number> {
  if (!keys.length) return 0;
  const list = sql.join(keys.map(key => sql`${key}`), sql`, `);
  return retentionWrite(lease, async tx => count(await tx.execute(sql`WITH scope AS MATERIALIZED (
      SELECT e.id, e.repository_key, e.commit_sha, e.observed_at FROM crawl_discovery_evidence e WHERE e.repository_key IN (${list})),
    keep AS (
      SELECT id FROM scope WHERE observed_at >= ${UTC_NOW} - make_interval(hours => ${DISCOVERY_KEEP_HOURS})
      UNION
      SELECT id FROM (SELECT id, rank() OVER (PARTITION BY repository_key ORDER BY observed_at DESC) AS r FROM (
        SELECT DISTINCT ON (repository_key, commit_sha) id, repository_key, observed_at FROM scope
        WHERE commit_sha ~ '^[a-f0-9]{40,64}$' ORDER BY repository_key, commit_sha, observed_at DESC, id DESC) per_sha) ranked
      WHERE r <= ${DISCOVERY_KEEP_SHAS})
    DELETE FROM crawl_discovery_evidence e USING scope s
    WHERE e.id = s.id AND NOT EXISTS (SELECT 1 FROM keep k WHERE k.id = s.id)
    RETURNING 1`)));
}

/**
 * 발굴 근거는 id 차례로 한 번씩만 본다(커서 = 끝까지 본 id). 행이 남길 창(24시간)을 벗어날 때 그 저장소를 한 번 다듬으면 된다 —
 * 그 뒤로 지울 것이 생기는 것은 새 행이 들어올 때뿐이고, 그 새 행도 24시간 뒤 이 커서를 지나며 그 저장소를 다시 다듬는다.
 * id 는 넣을 때 매기고 observed_at 도 넣을 때의 now() 라 둘의 차례가 같다. 커서는 25시간 지난 행까지만 넘긴다(늦은 commit 여유).
 */
export async function pruneDiscoveryEvidence(lease: JobLease | undefined, state: DbRetentionCursor["evidence"], more: () => boolean):
  Promise<PartResult & { state: NonNullable<DbRetentionCursor["evidence"]> }> {
  let afterId = state?.afterId ?? 0, deleted = 0, repositories = 0, caughtUp = false;
  while (more()) {
    const rows = await db.execute<{ id: number; key: string; old: boolean }>(sql`SELECT id, repository_key AS key,
        observed_at < ${UTC_NOW} - make_interval(hours => ${DISCOVERY_CURSOR_LAG_HOURS}) AS old
      FROM crawl_discovery_evidence WHERE id > ${afterId} ORDER BY id LIMIT ${DISCOVERY_ROWS_PER_BATCH}`);
    const fresh = rows.findIndex(row => !row.old);
    const ready = fresh < 0 ? rows : rows.slice(0, fresh);
    if (!ready.length) { caughtUp = true; break; }
    const keys = [...new Set(ready.map(row => row.key))];
    deleted += await pruneDiscoveryKeys(lease, keys);
    repositories += keys.length;
    afterId = Number(ready.at(-1)!.id);
    if (fresh >= 0 || rows.length < DISCOVERY_ROWS_PER_BATCH) { caughtUp = true; break; }
  }
  return { counts: { deleted, repositories, afterId }, caughtUp, state: { afterId } };
}

// ───────────────────────── ④ 수집 원본 줄이기 ─────────────────────────

/** id 구간 하나의 대상 원본을 줄인다. 행은 지우지 않는다 */
export async function shrinkDocumentRange(lease: JobLease | undefined, afterId: number, toId: number, days = DOCUMENT_SHRINK_AFTER_DAYS): Promise<number> {
  return retentionWrite(lease, async tx => count(await tx.execute(sql`WITH picked AS (
      SELECT d.id FROM crawl_documents d JOIN crawl_candidates c ON c.repo = d.repo
      WHERE d.id > ${afterId} AND d.id <= ${toId}
        AND c.state = 'rejected' AND c.decided_by IN ('auto','deepseek') AND c.published_slug IS NULL
        AND d.fetched_at < ${UTC_NOW} - make_interval(days => ${days})
        AND ${needsShrinkSql(sql`d.repo_meta`)}
        AND NOT EXISTS (SELECT 1 FROM crawl_candidates o WHERE lower(o.repo) = lower(d.repo) AND o.state <> 'rejected')
        AND NOT EXISTS (SELECT 1 FROM products p WHERE regexp_replace(regexp_replace(lower(rtrim(p.repo_url, '/')), '^https?://(www[.])?', 'https://'), '[.]git$', '')
          = 'https://github.com/' || lower(d.repo))
        AND NOT EXISTS (SELECT 1 FROM products p WHERE p.repo_renamed_to IS NOT NULL AND lower(p.repo_renamed_to) = lower(d.repo))
      FOR UPDATE OF d SKIP LOCKED)
    UPDATE crawl_documents d SET repo_meta = ${shrunkRepoMetaSql(sql`d.repo_meta`)}
    FROM picked WHERE d.id = picked.id AND d.fetched_at < ${UTC_NOW} - make_interval(days => ${days})
    RETURNING 1`)));
}

export async function shrinkDocuments(lease: JobLease | undefined, state: DbRetentionCursor["documents"], more: () => boolean, now = Date.now()):
  Promise<PartResult & { state: NonNullable<DbRetentionCursor["documents"]> }> {
  const doneAt = state?.passDoneAt ? Date.parse(state.passDoneAt) : Number.NaN;
  if (!state?.afterId && Number.isFinite(doneAt) && now - doneAt < DAILY_PASS_MS)
    return { counts: { shrunk: 0, waiting: true }, caughtUp: true, state: state! };
  const [{ maxId } = { maxId: 0 }] = await db.execute<{ maxId: number | null }>(sql`SELECT max(id) AS "maxId" FROM crawl_documents`);
  let afterId = state?.afterId ?? 0, shrunk = 0;
  while (more()) {
    if (afterId >= Number(maxId ?? 0)) {
      return { counts: { shrunk, afterId, passDone: true }, caughtUp: true, state: { afterId: 0, passDoneAt: new Date(now).toISOString() } };
    }
    const toId = afterId + DOCUMENT_ID_SPAN;
    shrunk += await shrinkDocumentRange(lease, afterId, toId);
    afterId = toId;
  }
  return { counts: { shrunk, afterId }, caughtUp: false, state: { afterId, ...(state?.passDoneAt ? { passDoneAt: state.passDoneAt } : {}) } };
}

// ───────────────────────── ② 저장소 스캔 ─────────────────────────

/**
 * 스캔 한 묶음(id 차례). 지우는 것: scope '' 이고 시작·끝이 모두 7일 지났고 다음 보존 집합 밖인 것(운영 스크립트 db-retention-123.mts 와 같은 규칙).
 * 보존: 저장소 키마다 시작 최신 2개 · GitHub 저장소 id 마다 시작 최신 2개 · 키마다 끝난(complete·partial) 최신 · 키마다 complete 최신 ·
 * 제품 근거가 가리키는 스캔(normalized_facts.agentScanId) · 최근 30일 심사 시도가 쓴 스캔(source.scanId). 관측은 FK CASCADE 로 함께 지워진다.
 */
export async function pruneScanBatch(lease: JobLease | undefined, afterId: number, limit = SCAN_BATCH):
  Promise<{ examined: number; lastId: number; scans: number; observations: number }> {
  return retentionWrite(lease, async tx => {
    const candidates = await tx.execute<{ id: number }>(sql`SELECT s.id FROM agent_repository_scans s
      WHERE s.id > ${afterId} AND s.scope = ''
        AND s.started_at < ${UTC_NOW} - make_interval(days => ${SCAN_RETENTION_DAYS})
        AND coalesce(s.completed_at, s.started_at) < ${UTC_NOW} - make_interval(days => ${SCAN_RETENTION_DAYS})
      ORDER BY s.id LIMIT ${limit}`);
    if (!candidates.length) return { examined: 0, lastId: afterId, scans: 0, observations: 0 };
    const ids = sql.join(candidates.map(row => sql`${row.id}`), sql`, `);
    const doomed = await tx.execute<{ id: number }>(sql`SELECT s.id FROM agent_repository_scans s WHERE s.id IN (${ids})
      AND (SELECT count(*) FROM agent_repository_scans n WHERE n.repository_key = s.repository_key
        AND (n.started_at > s.started_at OR (n.started_at = s.started_at AND n.id > s.id))) >= 2
      AND (SELECT count(*) FROM agent_repository_scans n WHERE n.github_repository_id = s.github_repository_id
        AND (n.started_at > s.started_at OR (n.started_at = s.started_at AND n.id > s.id))) >= 2
      AND s.id IS DISTINCT FROM (SELECT n.id FROM agent_repository_scans n WHERE n.repository_key = s.repository_key AND n.state IN ('complete','partial')
        ORDER BY n.completed_at DESC NULLS LAST, n.id DESC LIMIT 1)
      AND s.id IS DISTINCT FROM (SELECT n.id FROM agent_repository_scans n WHERE n.repository_key = s.repository_key AND n.state = 'complete'
        ORDER BY n.completed_at DESC NULLS LAST, n.id DESC LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM product_evidence_sources p WHERE p.normalized_facts->>'agentScanId' = s.id::text)
      AND NOT EXISTS (SELECT 1 FROM crawl_review_attempts a WHERE a.started_at > now() - interval '30 days' AND a.source->>'scanId' = s.id::text)
      FOR UPDATE OF s SKIP LOCKED`);
    const lastId = Number(candidates.at(-1)!.id);
    if (!doomed.length) return { examined: candidates.length, lastId, scans: 0, observations: 0 };
    const doomedIds = sql.join(doomed.map(row => sql`${row.id}`), sql`, `);
    const [{ n: observations }] = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM agent_repository_observations WHERE scan_id IN (${doomedIds})`);
    const scans = count(await tx.execute(sql`DELETE FROM agent_repository_scans WHERE id IN (${doomedIds}) RETURNING 1`));
    return { examined: candidates.length, lastId, scans, observations };
  });
}

export async function pruneScans(lease: JobLease | undefined, state: DbRetentionCursor["scans"], more: () => boolean, now = Date.now()):
  Promise<PartResult & { state: NonNullable<DbRetentionCursor["scans"]> }> {
  const doneAt = state?.passDoneAt ? Date.parse(state.passDoneAt) : Number.NaN;
  if (!state?.afterId && Number.isFinite(doneAt) && now - doneAt < DAILY_PASS_MS)
    return { counts: { scans: 0, waiting: true }, caughtUp: true, state: state! };
  let afterId = state?.afterId ?? 0, scans = 0, observations = 0;
  while (more()) {
    const batch = await pruneScanBatch(lease, afterId);
    scans += batch.scans; observations += batch.observations; afterId = batch.lastId;
    if (batch.examined < SCAN_BATCH) {
      return { counts: { scans, observations, passDone: true }, caughtUp: true, state: { afterId: 0, passDoneAt: new Date(now).toISOString() } };
    }
  }
  return { counts: { scans, observations, afterId }, caughtUp: false, state: { afterId, ...(state?.passDoneAt ? { passDoneAt: state.passDoneAt } : {}) } };
}

// ───────────────────────── ③ 일일 가동 집계 ─────────────────────────

/** product_health_daily 는 30일 창만 읽는다(lib/domain/products/health.ts) — KST 오늘 − 40일 전 날을 하루씩 지운다 */
export async function pruneHealthDaily(lease: JobLease | undefined, state: DbRetentionCursor["health"], more: () => boolean, now = Date.now()):
  Promise<PartResult & { state: NonNullable<DbRetentionCursor["health"]> }> {
  const doneAt = state?.passDoneAt ? Date.parse(state.passDoneAt) : Number.NaN;
  if (Number.isFinite(doneAt) && now - doneAt < DAILY_PASS_MS) return { counts: { rows: 0, waiting: true }, caughtUp: true, state: state! };
  let rows = 0, days = 0;
  while (more()) {
    const [{ day } = { day: null }] = await db.execute<{ day: string | null }>(sql`SELECT min(day)::text AS day FROM product_health_daily
      WHERE day < (now() AT TIME ZONE 'Asia/Seoul')::date - ${HEALTH_DAILY_RETENTION_DAYS}::int`);
    if (!day) return { counts: { rows, days, passDone: true }, caughtUp: true, state: { passDoneAt: new Date(now).toISOString() } };
    rows += await retentionWrite(lease, async tx => count(await tx.execute(sql`DELETE FROM product_health_daily WHERE day = ${day}::date
      AND day < (now() AT TIME ZONE 'Asia/Seoul')::date - ${HEALTH_DAILY_RETENTION_DAYS}::int RETURNING 1`)));
    days += 1;
  }
  return { counts: { rows, days }, caughtUp: false, state: state ?? {} };
}
