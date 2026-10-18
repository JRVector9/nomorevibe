import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { productHealth, products } from "@/lib/db/schema";
import { uptimeClaims, uptimeControl, uptimeHostBreakers, uptimeHostWindows, uptimeObservations } from "@/lib/db/product-uptime-schema";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { refreshTextSample } from "@/lib/crawl/repository";
import { assertJobLeaseAtWallTime, type JobLease } from "@/lib/jobs/control";
import { DrWriterFencedError, writerSiteActive } from "@/lib/operations/dr/epoch";
import { writeHealthHelds, writeHealthResults } from "./health-record";
import { autoBanUptimeProduct, UPTIME_AUTO_BAN_THRESHOLD } from "./uptime-auto-ban";
import { lockUptimeSplitControl, UptimeOwnResultSchema, type UptimeResult } from "./uptime-claims";
import { closedUptimeBreaker, decideSplitResults, splitResetStreak, uptimeWindowSince, type UptimeHealthSnapshot, type UptimeHost,
  type UptimeHostBreaker, type UptimeHostCounts, type UptimeProductSnapshot, type UptimeSplitDecision, type UptimeSplitInput,
  type UptimeSplitMode, type UptimeSplitOutcome, type UptimeSplitReason } from "./uptime-split-policy";

/**
 * split-v1 묶음 적용기(home 의 uptime-ping 잡만 부른다). 제출된 결과(Oracle 등)와 home 이 직접 연 결과를 한 TX 에서
 * decideSplitResults 로 판정하고 정식 기록(product_health·일일 집계·연속 실패, 광역 보류면 확인 시각만)·raw 사실·claim 행·차단기 재료를 함께 쓴다.
 * commit 뒤에 기존 함수로 자동 내림(10회, 최종 commit 보호 그대로)과 텍스트 표본(home 이 연 살아 있는 결과만)을 한다.
 *
 * lock 순서: DR fence → uptime_control → uptime_split_control → 제품 세대(slug 정렬 advisory → products id 정렬)
 *   → uptime_claims(id 정렬) → product_health(slug 정렬) → 차단기 → jobs.
 * 제품 세대를 claim 행보다 먼저 잡는다 — 제품 삭제는 세대 → products → (FK cascade) uptime_claims 순서로 잡는다.
 * claim·제출 TX 는 claim 행만 잡으므로(SKIP LOCKED 또는 자기 행) 이 순서와 순환하지 않는다.
 */

export const UPTIME_APPLY_SUBMITTED_MAX = 100;
/** home 은 한 틱의 실패를 한 번에 넣어야 묶음 광역 규칙(batchMin)이 작동한다 — 배치 상한(UPTIME_BATCH_SIZE 200)까지 받는다 */
export const UPTIME_APPLY_OWN_MAX = 200;
/** 차단기 창 칸을 이만큼만 남긴다 */
const WINDOW_RETENTION_MS = 2 * 24 * 60 * 60_000;

/** home 이 직접 연 결과. claim 회차의 token·epoch 를 그대로 넣는다. 표본은 살아 있는 결과에서 읽은 본문 앞부분이다. 비표준 HTTP 상태도 받는다(UptimeOwnResultSchema) */
export type UptimeOwnResult = UptimeResult & { textSample?: string | null };

export type UptimeApplySummary = {
  mode: UptimeSplitMode; controlEpoch: number;
  /** 이번에 적용한 제출 행 수와 home 결과 수 */
  remote: number; own: number;
  outcomes: Record<UptimeSplitOutcome, number>; reasons: Partial<Record<UptimeSplitReason, number>>;
  /** 지역 충돌(probe 실패 → home 성공) */
  conflicts: number; autoBanned: number; textSamples: number;
  breakers: UptimeHostBreaker[]; decisions: UptimeSplitDecision[];
};

const OUTCOMES: readonly UptimeSplitOutcome[] = ["lost", "discarded", "stale", "held", "applied", "returned", "confirm_requested"];
const lostDecision = (productId: number): UptimeSplitDecision =>
  ({ productId, host: null, outcome: "lost", reason: "claim_lost", claim: null, health: null, raw: null, textSample: false });

function breakerFromRow(row: typeof uptimeHostBreakers.$inferSelect): UptimeHostBreaker {
  return { host: row.host, state: row.state, openedAt: row.openedAt, probeAfter: row.probeAfter, coolDownMs: row.coolDownMs,
    reason: row.reason, ratio: row.ratio, probeChecks: row.probeChecks, probeFailures: row.probeFailures };
}
const sameBreaker = (a: UptimeHostBreaker, b: UptimeHostBreaker) => a.state === b.state && a.openedAt?.getTime() === b.openedAt?.getTime()
  && a.probeAfter?.getTime() === b.probeAfter?.getTime() && a.coolDownMs === b.coolDownMs && a.reason === b.reason
  && a.ratio === b.ratio && a.probeChecks === b.probeChecks && a.probeFailures === b.probeFailures;

/**
 * 제출된 결과를 submittedLimit 건(제출 순서)까지, home 결과(own)는 전부 한 번에 판정해 반영한다. 결과가 없어도 claims 모드면
 * 차단기를 시간에 따라 진행시킨다(open → probing) — 잡이 틱마다 부른다. legacy 에서는 남은 제출 행을 idle 로 돌리기만 한다.
 * 잡 lease 를 commit 직전에 DB 시계로 다시 확인한다(잃었으면 전부 롤백). fenced DB 에서는 worker 쓰기와 같이 거절한다.
 */
export async function applyUptimeResults(input: {
  lease: JobLease; own?: readonly UptimeOwnResult[]; submittedLimit?: number; signal?: AbortSignal; hasBudget?: () => boolean;
}): Promise<UptimeApplySummary> {
  if (currentReplayDb()) throw new Error("uptime_split_replay_unsupported");
  if (!input.lease || input.lease.name !== "uptime-ping" || typeof input.lease.token !== "string" || !input.lease.token) throw new Error("uptime_job_required");
  const lease = { ...input.lease }, signal = input.signal;
  const submittedLimit = input.submittedLimit ?? UPTIME_APPLY_SUBMITTED_MAX;
  if (!Number.isSafeInteger(submittedLimit) || submittedLimit < 0 || submittedLimit > UPTIME_APPLY_SUBMITTED_MAX) throw new Error("invalid uptime apply batch");
  if ((input.own?.length ?? 0) > UPTIME_APPLY_OWN_MAX) throw new Error("invalid uptime apply batch");
  const own = new Map<number, { result: UptimeResult; textSample: string | null }>();
  for (const value of input.own ?? []) {
    const { textSample, ...rest } = value;
    const result = UptimeOwnResultSchema.parse(structuredClone(rest));
    if (own.has(result.productId)) throw new TypeError("uptime_split_duplicate_product");
    own.set(result.productId, { result, textSample: typeof textSample === "string" ? textSample : null });
  }

  const applied = await onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
    const [pr09] = await tx.select().from(uptimeControl).where(eq(uptimeControl.id, 1)).for("share");
    const control = await lockUptimeSplitControl(tx);

    // 1) 대상(잠그지 않음) → 2) 제품 세대 → 3) claim 행. 사이에 바뀐 행은 3)이 다시 거른다
    const pendingRemote = submittedLimit === 0 ? [] : await tx.select({ productId: uptimeClaims.productId, slug: uptimeClaims.claimSlug })
      .from(uptimeClaims).where(eq(uptimeClaims.state, "submitted"))
      .orderBy(asc(uptimeClaims.submittedAt), asc(uptimeClaims.productId)).limit(submittedLimit);
    const ownIds = [...own.keys()];
    const pendingOwn = ownIds.length === 0 ? [] : await tx.select({ productId: uptimeClaims.productId, slug: uptimeClaims.claimSlug })
      .from(uptimeClaims).where(inArray(uptimeClaims.productId, ownIds));
    const ids = [...new Set([...pendingRemote, ...pendingOwn].map(row => row.productId))].sort((a, b) => a - b);
    const slugs = [...new Set([...pendingRemote, ...pendingOwn].flatMap(row => row.slug === null ? [] : [row.slug]))].sort();
    if (slugs.length > 0) {
      await tx.execute(sql`select count(pg_advisory_xact_lock(hashtext('product-lifecycle:' || s)))
        from jsonb_array_elements_text(${JSON.stringify(slugs)}::jsonb) as s`);
    }
    const productRows: UptimeProductSnapshot[] = ids.length === 0 ? [] : await tx.select({ id: products.id, slug: products.slug, url: products.url,
      status: products.status, accessMode: products.accessMode, updatedAt: sql<string>`${products.updatedAt}::text` })
      .from(products).where(inArray(products.id, ids)).orderBy(asc(products.id)).for("update");
    const remoteIds = pendingRemote.map(row => row.productId);
    const remoteRows = remoteIds.length === 0 ? [] : await tx.select().from(uptimeClaims)
      .where(and(inArray(uptimeClaims.productId, remoteIds), eq(uptimeClaims.state, "submitted")))
      .orderBy(asc(uptimeClaims.productId)).for("update", { skipLocked: true });
    const remoteLocked = new Set(remoteRows.map(row => row.productId));
    // 이번에 적용할 제출 행과 같은 제품의 home 결과는 다른 claim 회차의 것이다(home 은 제출하지 않는다)
    const ownLockIds = ownIds.filter(id => !remoteLocked.has(id)).sort((a, b) => a - b);
    const ownRows = ownLockIds.length === 0 ? [] : await tx.select().from(uptimeClaims)
      .where(inArray(uptimeClaims.productId, ownLockIds)).orderBy(asc(uptimeClaims.productId)).for("update");
    const productById = new Map(productRows.map(row => [row.id, row]));
    const healthSlugs = [...new Set(productRows.map(row => row.slug))].sort();
    const healthRows = healthSlugs.length === 0 ? [] : await tx.select({ slug: productHealth.slug, checkedAt: productHealth.checkedAt,
      failures: productHealth.failures, downSince: productHealth.downSince })
      .from(productHealth).where(inArray(productHealth.slug, healthSlugs)).orderBy(asc(productHealth.slug)).for("update");
    const healthBySlug = new Map<string, UptimeHealthSnapshot>(healthRows.map(row => [row.slug, row]));

    const [clock] = await tx.execute<{ wall_ms: number }>(sql`select (extract(epoch from clock_timestamp()) * 1000)::float8 as wall_ms`);
    const wall = new Date(clock.wall_ms);
    const stored = (await tx.select().from(uptimeHostBreakers).orderBy(asc(uptimeHostBreakers.host)).for("update")).map(breakerFromRow);
    const windows: Partial<Record<UptimeHost, UptimeHostCounts>> = {};
    if (control.policy) {
      const sums = await tx.select({ host: uptimeHostWindows.host, checks: sql<number>`sum(${uptimeHostWindows.checks})::int`,
        failures: sql<number>`sum(${uptimeHostWindows.failures})::int`, transport: sql<number>`sum(${uptimeHostWindows.transport})::int` })
        .from(uptimeHostWindows).where(gt(uptimeHostWindows.bucket, uptimeWindowSince(control.policy, wall))).groupBy(uptimeHostWindows.host);
      for (const row of sums) windows[row.host] = { checks: row.checks, failures: row.failures, transport: row.transport };
    }

    const inputs: UptimeSplitInput[] = [];
    for (const row of remoteRows) {
      const product = productById.get(row.productId) ?? null;
      inputs.push({ claim: row, product, health: product ? healthBySlug.get(product.slug) ?? null : null, submitted: true,
        result: { token: row.token!, epoch: row.epoch, startedAt: row.resultStartedAt!, observedAt: row.resultObservedAt!,
          kind: row.resultKind!, status: row.resultStatus!, latencyMs: row.resultLatencyMs } });
    }
    for (const row of ownRows) {
      const product = productById.get(row.productId) ?? null, { result } = own.get(row.productId)!;
      inputs.push({ claim: row, product, health: product ? healthBySlug.get(product.slug) ?? null : null,
        result: { token: result.token, epoch: result.epoch, startedAt: result.startedAt, observedAt: result.observedAt,
          kind: result.kind, status: result.status, latencyMs: result.latencyMs } });
    }
    const batch = decideSplitResults(inputs, { control, wall, breakers: stored, windows,
      uptimeControl: { observationsEnabled: pr09?.observationsEnabled ?? false, gateEnabled: pr09?.gateEnabled ?? false } });
    const inputById = new Map(inputs.map(value => [value.claim.productId, value]));
    const locked = new Set(ownRows.map(row => row.productId));
    // claim 행이 없거나(제품 삭제) 이번 제출 행과 겹친 home 결과는 그 회차를 잃은 것이다
    const decisions = [...batch.decisions, ...ownIds.filter(id => !locked.has(id)).map(lostDecision)];

    // 정식 기록: legacy 의 기록 함수(writeHealthResult·writeHealthHeld)와 같은 의미의 집합 쓰기. 판정(kind)이 어느 기록인지 정하고,
    // 연속 실패를 다시 셀지는 판정과 같은 함수로 정한다. 쓴 뒤의 연속 실패가 판정과 다르면 두 쪽 의미가 갈린 것이라 전부 되돌린다
    const counted = decisions.filter(decision => decision.health?.kind === "counted");
    const held = decisions.filter(decision => decision.health?.kind === "held");
    const failures = await writeHealthResults(tx, counted.map(decision => {
      const health = decision.health!, value = inputById.get(decision.productId)!;
      return { slug: health.slug, status: health.status, latencyMs: health.latencyMs, observedAt: health.checkedAt,
        resetStreak: splitResetStreak(value.health, value.product!.updatedAt) };
    }));
    const heldFailures = await writeHealthHelds(tx, held.map(decision => ({ slug: decision.health!.slug, status: decision.health!.status,
      observedAt: decision.health!.checkedAt })));
    const differs = (rows: UptimeSplitDecision[], written: Map<string, number>) => rows.some(decision => written.get(decision.health!.slug) !== decision.health!.failures);
    if (differs(counted, failures) || differs(held, heldFailures)) throw new Error("uptime_split_health_mismatch");
    const raw = decisions.flatMap(decision => decision.raw ? [decision.raw] : []).map(({ observation, disposition, reason }) => ({
      observationId: observation.observationId, productId: observation.productId, slug: observation.slug, url: observation.url,
      urlHash: reviewHash(observation.url), slot: observation.slot, startedAt: observation.startedAt, observedAt: observation.observedAt,
      host: observation.source.host, instanceId: observation.source.instanceId, region: observation.source.region,
      kind: observation.kind, status: observation.status, latencyMs: observation.latencyMs,
      payloadHash: reviewHash({ ...observation, slot: observation.slot.toISOString(), startedAt: observation.startedAt.toISOString(),
        observedAt: observation.observedAt.toISOString() }),
      disposition, reason, revision: pr09?.revision ?? 1 }));
    // 같은 (제품, URL, 6h slot, host) 사실이 이미 있으면 남기지 않는다(append-only 표의 유일 키)
    if (raw.length > 0) await tx.insert(uptimeObservations).values(raw).onConflictDoNothing();

    const claimUpdates = decisions.flatMap(decision => decision.claim ? [{ product_id: decision.productId, token: decision.claim.token,
      epoch: decision.claim.epoch, due_at: decision.claim.dueAt.toISOString(), confirm_class: decision.claim.confirmClass,
      confirm_reason: decision.claim.confirmReason, confirm_requested_at: decision.claim.confirmRequestedAt?.toISOString() ?? null,
      affinity_home_until: decision.claim.affinityHomeUntil?.toISOString() ?? null, conflict_count: decision.claim.conflictCount,
      last_outcome: decision.claim.lastOutcome, last_applied_at: decision.claim.lastApplied?.at.toISOString() ?? null,
      last_applied_host: decision.claim.lastApplied?.host ?? null }] : []);
    if (claimUpdates.length > 0) {
      const settled = await tx.execute<{ product_id: number }>(sql`
        update uptime_claims c set state = 'idle', token = null, lease_until = null, due_at = r.due_at,
          confirm_class = r.confirm_class, confirm_reason = r.confirm_reason, confirm_requested_at = r.confirm_requested_at,
          affinity_home_until = r.affinity_home_until, conflict_count = r.conflict_count, last_outcome = r.last_outcome,
          last_applied_at = coalesce(r.last_applied_at, c.last_applied_at),
          last_applied_host = case when r.last_applied_at is null then c.last_applied_host else r.last_applied_host end,
          result_started_at = null, result_observed_at = null, result_kind = null, result_status = null, result_latency_ms = null,
          submitted_at = null, updated_at = clock_timestamp()
        from jsonb_to_recordset(${JSON.stringify(claimUpdates)}::jsonb) as r(product_id integer, token uuid, epoch bigint,
          due_at timestamptz, confirm_class varchar, confirm_reason varchar, confirm_requested_at timestamptz,
          affinity_home_until timestamptz, conflict_count integer, last_outcome varchar, last_applied_at timestamptz, last_applied_host varchar)
        where c.product_id = r.product_id and c.token = r.token and c.epoch = r.epoch
        returning c.product_id`);
      // 행을 잠근 채 판정했으므로 CAS 가 빗나갈 수 없다
      if (settled.length !== claimUpdates.length) throw new Error("uptime_split_claim_mismatch");
    }

    // 차단기 재료·상태는 claims 모드에서만 쓴다(legacy 는 남은 제출 행 정리뿐이다)
    let breakers: UptimeHostBreaker[] = stored;
    if (control.mode === "claims" && control.policy) {
      const policy = control.policy;
      if (batch.windows.length > 0) {
        await tx.insert(uptimeHostWindows).values(batch.windows).onConflictDoUpdate({
          target: [uptimeHostWindows.host, uptimeHostWindows.bucket],
          set: { checks: sql`${uptimeHostWindows.checks} + excluded.checks`, failures: sql`${uptimeHostWindows.failures} + excluded.failures`,
            transport: sql`${uptimeHostWindows.transport} + excluded.transport` } });
      }
      await tx.delete(uptimeHostWindows).where(lt(uptimeHostWindows.bucket, new Date(wall.getTime() - WINDOW_RETENTION_MS)));
      for (const next of batch.breakers) {
        const before = stored.find(row => row.host === next.host);
        if (sameBreaker(before ?? closedUptimeBreaker(next.host, policy), next)) continue;
        const values = { ...next, updatedAt: sql`clock_timestamp()` };
        await tx.insert(uptimeHostBreakers).values(values).onConflictDoUpdate({ target: uptimeHostBreakers.host, set: values });
      }
      breakers = batch.breakers;
    }
    if (signal?.aborted) throw new DOMException("uptime cancelled", "AbortError");
    await assertJobLeaseAtWallTime(tx, lease);
    if (signal?.aborted) throw new DOMException("uptime cancelled", "AbortError");
    return { control, decisions, breakers, remote: remoteRows.length, own: own.size, products: productById };
  }));

  // commit 뒤: 자동 내림(기존 자격·최종 commit 보호를 그 함수가 다시 본다)과 home 텍스트 표본
  let autoBanned = 0, textSamples = 0;
  const errors: unknown[] = [];
  for (const decision of applied.decisions) {
    if (signal?.aborted) break;
    const health = decision.health, product = applied.products.get(decision.productId);
    if (!health || !product) continue;
    const target = { id: product.id, slug: product.slug, url: product.url };
    // 자동 내림은 센 실패만 부른다(판정 보류는 legacy 처럼 내림을 확인하지 않는다)
    if (health.kind === "counted" && !health.alive && health.failures >= UPTIME_AUTO_BAN_THRESHOLD) {
      try {
        if (await autoBanUptimeProduct(target, { lease, signal, hasBudget: input.hasBudget })) autoBanned++;
      } catch (error) {
        errors.push(error);
      }
    }
    const sample = own.get(decision.productId)?.textSample;
    if (decision.textSample && sample) {
      // 표본은 부가물이다 — 못 써도 생존 기록은 이미 commit 됐다(legacy 와 같다)
      await refreshTextSample(product.slug, sample, lease, target, signal).then(() => { textSamples++; }, () => {});
    }
  }
  if (errors.length > 0) throw errors[0];

  const outcomes = Object.fromEntries(OUTCOMES.map(outcome => [outcome, 0])) as Record<UptimeSplitOutcome, number>;
  const reasons: Partial<Record<UptimeSplitReason, number>> = {};
  for (const decision of applied.decisions) {
    outcomes[decision.outcome]++;
    reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
  }
  return { mode: applied.control.mode, controlEpoch: applied.control.epoch, remote: applied.remote, own: applied.own, outcomes, reasons,
    conflicts: reasons.split_confirm_success ?? 0, autoBanned, textSamples, breakers: applied.breakers, decisions: applied.decisions };
}
