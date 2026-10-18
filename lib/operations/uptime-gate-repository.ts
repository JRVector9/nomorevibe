import { and, asc, desc, eq, gte, inArray, isNotNull, like, lte, ne, or, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/lib/db/schema";
import { operationsAudit, operationsObservations, productHealth, products } from "@/lib/db/schema";
import { uptimeControl, uptimeGates, uptimeObservations, uptimeSplitControl } from "@/lib/db/product-uptime-schema";
import { DOWN_THRESHOLD } from "@/lib/domain/products/health";
import { UPTIME_AUTO_BAN_THRESHOLD } from "@/lib/domain/products/uptime-auto-ban";
import { uptimeNegativeAllowed } from "@/lib/domain/products/uptime-negative-gate";
import { UPTIME_EVIDENCE_MS, UPTIME_POLICY_VERSION, UptimeSourcesSchema, type UptimeSource } from "@/lib/domain/products/uptime-policy";
import { planUptimeTransition, sameUptimeSource, shadowEvaluateUptimeGate, uptimeMode, uptimeRollbackTarget, UPTIME_GATE_LOOKBACK_MS,
  UPTIME_GATE_SHADOW_LIMIT, UPTIME_GATE_SHADOW_MS, UPTIME_RUNNER_LOOKBACK_MS, UPTIME_RUNNER_ROLES, type UptimeControlState,
  type UptimeGateSnapshot, type UptimeGateTarget, type UptimeTransitionPlan } from "./uptime-gate";
import { uptimeExclusionError } from "./uptime-split";

type Database = PostgresJsDatabase<typeof schema>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
const iso = (value: SQL) => sql<string>`to_char(${value} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const count = (filter: SQL) => sql<number>`(count(*) filter (where ${filter}))::int`;

async function readControl(tx: Tx, lock = false): Promise<UptimeControlState> {
  const query = tx.select().from(uptimeControl).where(eq(uptimeControl.id, 1));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw new Error("uptime_control_missing");
  const sources = UptimeSourcesSchema.safeParse(row.sources);
  if (!sources.success) throw new Error("uptime_control_sources_invalid");
  return { observationsEnabled: row.observationsEnabled, gateEnabled: row.gateEnabled, revision: row.revision, sources: sources.data };
}

async function shadowIn(tx: Tx, control: UptimeControlState, nowMs: number) {
  const columns = { observationId: uptimeObservations.observationId, productId: uptimeObservations.productId, url: uptimeObservations.url,
    host: uptimeObservations.host, instanceId: uptimeObservations.instanceId, region: uptimeObservations.region, kind: uptimeObservations.kind,
    status: uptimeObservations.status, observedAt: uptimeObservations.observedAt, disposition: uptimeObservations.disposition, reason: uptimeObservations.reason };
  const candidates = await tx.select(columns).from(uptimeObservations).where(and(eq(uptimeObservations.revision, control.revision),
    gte(uptimeObservations.observedAt, new Date(nowMs - UPTIME_GATE_SHADOW_MS)),
    sql`not (${uptimeObservations.kind} = 'http' and ${uptimeObservations.status} between 200 and 399)`,
    or(inArray(uptimeObservations.disposition, ["applied", "raw_only"]),
      and(eq(uptimeObservations.disposition, "observation_hold"), sql`${uptimeObservations.reason} is distinct from 'minimum_interval'`))))
    .orderBy(desc(uptimeObservations.observedAt), asc(uptimeObservations.observationId)).limit(UPTIME_GATE_SHADOW_LIMIT);
  if (!candidates.length) return shadowEvaluateUptimeGate([], [], control.sources);
  const times = candidates.map(row => row.observedAt.getTime());
  const evidence = await tx.select(columns).from(uptimeObservations).where(and(eq(uptimeObservations.revision, control.revision),
    ne(uptimeObservations.disposition, "stale"), gte(uptimeObservations.observedAt, new Date(Math.min(...times) - UPTIME_EVIDENCE_MS)),
    lte(uptimeObservations.observedAt, new Date(Math.max(...times)))));
  return shadowEvaluateUptimeGate(candidates, evidence, control.sources);
}

/** 현재 revision의 raw canary·gate·역할 후보·영향을 한 스냅숏으로 읽는다. 쓰기는 없다. */
async function snapshotIn(tx: Tx): Promise<UptimeGateSnapshot> {
  const [clock] = await tx.execute<{ now: string }>(sql`select ${iso(sql`clock_timestamp()`)} as now`);
  const control = await readControl(tx), nowMs = Date.parse(clock.now), from = new Date(nowMs - UPTIME_GATE_LOOKBACK_MS);
  const scope = and(eq(uptimeObservations.revision, control.revision), gte(uptimeObservations.observedAt, from));
  const hostRows = await tx.select({ host: uptimeObservations.host, instanceId: uptimeObservations.instanceId, region: uptimeObservations.region,
    total: sql<number>`count(*)::int`, positive: count(sql`${uptimeObservations.kind} = 'http' and ${uptimeObservations.status} between 200 and 399`),
    applied: count(sql`${uptimeObservations.disposition} = 'applied'`), rawOnly: count(sql`${uptimeObservations.disposition} = 'raw_only'`),
    held: count(sql`${uptimeObservations.disposition} = 'observation_hold'`), stale: count(sql`${uptimeObservations.disposition} = 'stale'`),
    first: iso(sql`min(${uptimeObservations.observedAt})`), last: iso(sql`max(${uptimeObservations.observedAt})`),
  }).from(uptimeObservations).where(scope).groupBy(uptimeObservations.host, uptimeObservations.instanceId, uptimeObservations.region)
    .orderBy(uptimeObservations.host, uptimeObservations.instanceId, uptimeObservations.region);
  const slots = await tx.execute<{ slot: string }>(sql`select distinct ${iso(sql`${uptimeObservations.slot}`)} as slot
    from ${uptimeObservations} where ${scope} order by 1`);
  const holdRows = await tx.select({ reason: uptimeObservations.reason, count: sql<number>`count(*)::int` }).from(uptimeObservations)
    .where(and(scope, eq(uptimeObservations.disposition, "observation_hold"))).groupBy(uptimeObservations.reason);
  const runnerRows = await tx.select({ key: operationsObservations.key }).from(operationsObservations)
    .where(and(or(...UPTIME_RUNNER_ROLES.map(role => like(operationsObservations.key, `candidate:${role}:%`))),
      sql`${operationsObservations.observedAt} >= localtimestamp - make_interval(secs => ${UPTIME_RUNNER_LOOKBACK_MS / 1000})`));
  const [gate] = await tx.select({
    admitted: count(sql`${uptimeGates.state} = 'admitted' and ${uptimeGates.revision} = ${control.revision} and ${uptimeGates.policyVersion} = ${UPTIME_POLICY_VERSION}`),
    held: count(sql`${uptimeGates.state} = 'observation_hold'`), due: count(sql`${uptimeGates.nextCheckAt} <= clock_timestamp()`),
    currentRevision: count(sql`${uptimeGates.revision} = ${control.revision}`),
  }).from(uptimeGates);
  const heldRows = await tx.select({ reason: uptimeGates.reason, count: sql<number>`count(*)::int` }).from(uptimeGates)
    .where(eq(uptimeGates.state, "observation_hold")).groupBy(uptimeGates.reason);
  const [split] = await tx.select({ mode: uptimeSplitControl.mode, epoch: uptimeSplitControl.epoch }).from(uptimeSplitControl)
    .where(eq(uptimeSplitControl.id, 1));
  // health.ts downWhere와 같은 식이다. 10회 이상은 sweep의 최신성 조건을 빼 수만 센다.
  const [impact] = await tx.select({ hiddenNow: sql<number>`count(*)::int`,
    banEligibleNow: count(sql`${productHealth.failures} >= ${UPTIME_AUTO_BAN_THRESHOLD}`) })
    .from(productHealth).innerJoin(products, eq(products.slug, productHealth.slug))
    .where(and(gte(productHealth.failures, DOWN_THRESHOLD), isNotNull(productHealth.downSince), inArray(products.status, ["verified", "seeded"]),
      uptimeNegativeAllowed({ id: products.id, url: products.url, updatedAt: products.updatedAt, checkedAt: productHealth.checkedAt,
        failures: productHealth.failures, status: productHealth.status })));
  const hosts = hostRows.map(row => ({ host: row.host, instanceId: row.instanceId, region: row.region,
    configured: control.sources.some(source => sameUptimeSource(source, row)), total: row.total, positive: row.positive,
    negative: row.total - row.positive, dispositions: { applied: row.applied, raw_only: row.rawOnly, observation_hold: row.held, stale: row.stale },
    firstObservedAt: row.first, lastObservedAt: row.last }));
  const firsts = hosts.map(host => host.firstObservedAt).sort(), lasts = hosts.map(host => host.lastObservedAt).sort();
  return { now: clock.now, control, window: { from: from.toISOString(), to: clock.now },
    observations: { total: hosts.reduce((sum, host) => sum + host.total, 0), firstObservedAt: firsts[0] ?? null,
      lastObservedAt: lasts.at(-1) ?? null, slots: [...slots].map(row => row.slot) },
    hosts, holdReasons: Object.fromEntries(holdRows.map(row => [row.reason ?? "unknown", row.count])),
    runners: [...new Set(runnerRows.map(row => row.key.split(":")[2]).filter(Boolean))].sort(),
    gates: { ...gate, heldReasons: Object.fromEntries(heldRows.map(row => [row.reason ?? "unknown", row.count])) },
    impact, shadow: await shadowIn(tx, control, nowMs), ...(split ? { split: { mode: split.mode, epoch: split.epoch } } : {}) };
}

export function readUptimeGateSnapshot(database: Database): Promise<UptimeGateSnapshot> {
  return database.transaction(async tx => {
    await tx.execute(sql`set transaction isolation level repeatable read, read only`);
    return snapshotIn(tx);
  });
}

class DryRunRollback<T> extends Error { constructor(readonly value: T) { super("uptime_gate_dry_run_rollback"); } }
/** dry-run도 같은 TX(잠금·CAS·감사 insert)를 실제로 실행한 뒤 ROLLBACK한다. */
async function maybeDry<T>(database: Database, apply: boolean, load: (tx: Tx) => Promise<T>): Promise<T> {
  try { return await database.transaction(async tx => { const value = await load(tx); if (!apply) throw new DryRunRollback(value); return value; }); }
  catch (error) { if (error instanceof DryRunRollback) return error.value as T; throw error; }
}

/** 판정한 값과 정확히 같은 행만 바꾼다. revision은 되돌리지 않고 항상 올린다 — 옛 gate 인증이 다시 살아나지 않는다. */
async function switchControl(tx: Tx, expected: UptimeControlState, next: { observationsEnabled: boolean; gateEnabled: boolean; sources: UptimeSource[] },
  audit: { operator: string; action: string; detail: Record<string, unknown> }): Promise<UptimeControlState> {
  const [row] = await tx.update(uptimeControl).set({ observationsEnabled: next.observationsEnabled, gateEnabled: next.gateEnabled,
    sources: next.sources, revision: sql`${uptimeControl.revision} + 1` })
    .where(and(eq(uptimeControl.id, 1), eq(uptimeControl.revision, expected.revision), eq(uptimeControl.observationsEnabled, expected.observationsEnabled),
      eq(uptimeControl.gateEnabled, expected.gateEnabled), sql`${uptimeControl.sources} = ${JSON.stringify(expected.sources)}::jsonb`))
    .returning();
  if (!row) throw new Error("uptime_control_revision_conflict");
  const after = { observationsEnabled: row.observationsEnabled, gateEnabled: row.gateEnabled, revision: row.revision, sources: UptimeSourcesSchema.parse(row.sources) };
  await tx.insert(operationsAudit).values({ actor: audit.operator, action: audit.action, target: "uptime_control",
    detail: { ...audit.detail, before: expected, after } });
  return after;
}

export type UptimeTransitionResult =
  | { kind: "blocked"; plan: UptimeTransitionPlan; before: UptimeControlState }
  | { kind: "applied" | "dry_run"; plan: UptimeTransitionPlan; before: UptimeControlState; after: UptimeControlState };

/** 잠금 없이 판정한 뒤 짧은 쓰기 TX에서 판정한 control 그대로일 때만 바꾼다. 판정이 막히면 쓰지 않는다. */
export async function applyUptimeTransition(database: Database, input: { target: UptimeGateTarget; expectRevision: number;
  sources?: unknown; operator: string; apply: boolean }): Promise<UptimeTransitionResult> {
  const snapshot = await readUptimeGateSnapshot(database);
  if (snapshot.control.revision !== input.expectRevision) throw new Error("uptime_control_revision_conflict");
  const plan = planUptimeTransition(input.target, snapshot, input.sources);
  if (!plan.allowed) return { kind: "blocked", plan, before: snapshot.control };
  try {
    return await maybeDry(database, input.apply, async tx => {
      const locked = await readControl(tx, true);
      if (locked.revision !== input.expectRevision) throw new Error("uptime_control_revision_conflict");
      const after = await switchControl(tx, snapshot.control, plan.next, { operator: input.operator, action: "uptime-control-transition",
        detail: { target: input.target, observations: snapshot.observations, hosts: snapshot.hosts, shadow: snapshot.shadow, impact: snapshot.impact } });
      return { kind: input.apply ? "applied" as const : "dry_run" as const, plan, before: snapshot.control, after };
    });
  } catch (error) {
    // 판정 뒤 split 이 먼저 claims 로 commit 된 경합 — 0103 트리거의 거절을 오류가 아니라 거절로 돌려준다(아무것도 쓰지 않았다)
    const code = uptimeExclusionError(error);
    if (code) return { kind: "blocked", plan: { ...plan, allowed: false, blocked: [...plan.blocked, code] }, before: snapshot.control };
    throw error;
  }
}

export type UptimeRollbackResult =
  | { kind: "blocked"; blocked: string[]; before: UptimeControlState }
  | { kind: "applied" | "dry_run"; before: UptimeControlState; after: UptimeControlState };

/** 근거 없이도 허용하는 안전 방향 한 단계(gate→raw-only→disabled). sources는 유지한다. */
export function rollbackUptimeTransition(database: Database, input: { expectRevision: number; operator: string; apply: boolean }): Promise<UptimeRollbackResult> {
  return maybeDry(database, input.apply, async tx => {
    const before = await readControl(tx, true);
    if (before.revision !== input.expectRevision) throw new Error("uptime_control_revision_conflict");
    const target = uptimeRollbackTarget(before);
    if (!target) return { kind: "blocked" as const, blocked: ["uptime_already_disabled"], before };
    const after = await switchControl(tx, before, { ...target, sources: before.sources }, { operator: input.operator,
      action: "uptime-control-rollback", detail: { from: uptimeMode(before), to: uptimeMode(target) } });
    return { kind: input.apply ? "applied" as const : "dry_run" as const, before, after };
  });
}
