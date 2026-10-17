import { sql } from "drizzle-orm";
import { z } from "zod";
import { releaseModelDispatchWithEvidence, type ModelDispatchReleaseCandidate } from "@/lib/llm/capacity-repository";
import type { ModelDispatchReleaseEvidence } from "@/lib/llm/capacity";
import { identity, writerSiteActive } from "./epoch";
import { evaluateProcessReclaim, judgeModelReclaim, type ProcessGroupEvent, type ReclaimPolicy } from "./call-drain";
import { promotionDrain } from "./promotion";
import { dbNow, drTransactionMaybeDry, lockPromotedState, processOwnerSchema, readProcessGroupEvents, type ProcessOwner } from "./repository";
import { httpHopReleaseEvidenceSchema } from "./hop-reclaim";
import { gatewayLocalEndFactSchema } from "@/lib/llm/capacity";

/** 운영자가 선언한 provider 종료 성격과 그 출처. provider_bound 는 증명된 hard deadline 이 있어야 한다. */
export type ReclaimPolicyWithReference = ReclaimPolicy & Readonly<{ reference: string }>;
export type DispatchReleaseRow = Readonly<{ requestId: string; released: boolean; reason: string | null }>;
const iso = (ms: number) => new Date(ms).toISOString();
const row = (requestId: string, result: Awaited<ReturnType<typeof releaseModelDispatchWithEvidence>>): DispatchReleaseRow =>
  ({ requestId, released: result.kind === "released", reason: result.kind === "released" ? null : result.kind === "blocked" ? result.reason : "not_active" });

/**
 * D11 운영자 회수. fence SHARE 가 첫 lock 이고(fenced DB 에서는 장부를 바꾸지 않는다), 행마다 장부 hook 이 control/request 를 잠근 뒤
 * 같은 TX·DB clock 으로 그 owner 의 프로세스 그룹 근거를 다시 읽어 판정한다. dry-run 은 같은 TX 를 실행한 뒤 ROLLBACK 한다.
 */
export async function releaseProcessExitedDispatches(value: { owner: ProcessOwner; policies: ReadonlyMap<string, ReclaimPolicyWithReference>;
  operator: string }, apply: boolean): Promise<{ rows: DispatchReleaseRow[] }> {
  const owner = processOwnerSchema.parse(value.owner), operator = identity(120).parse(value.operator);
  return drTransactionMaybeDry(apply, async tx => {
    if (!await writerSiteActive(tx)) throw new Error("dr_writer_site_fenced");
    const ids = Array.from(await tx.execute<{ request_id: string }>(sql`SELECT request_id::text FROM model_capacity_requests
      WHERE owner_instance_id = ${owner.instanceId} AND owner_boot_id = ${owner.bootId}::uuid AND state IN ('dispatched','indeterminate')
      ORDER BY queue_ordinal`)).map(item => item.request_id);
    const rows: DispatchReleaseRow[] = [];
    for (const requestId of ids) rows.push(row(requestId, await releaseModelDispatchWithEvidence(tx, requestId,
      async (candidate: ModelDispatchReleaseCandidate): Promise<ModelDispatchReleaseEvidence | { blocked: string }> => {
        const policy = value.policies.get(candidate.providerBudgetId);
        if (!policy) return { blocked: "provider_deadline_unknown" };
        if (!candidate.dispatchAt) return { blocked: "dispatch_time_unknown" };
        // 장부 행 lock 뒤에 읽는다. 근거 표는 append-only 이고 새 intent 는 지금(> dispatch) 이후 시각이라 판정을 뒤집지 못한다.
        const events = await readProcessGroupEvents(tx, owner), dispatchAtMs = Date.parse(candidate.dispatchAt);
        const verdict = evaluateProcessReclaim(events, dispatchAtMs, policy, Date.parse(candidate.now));
        if (!verdict.reclaimable) return { blocked: verdict.reason };
        const exits = events.filter(event => event.kind === "spawn_intent" && event.recordedAtMs <= dispatchAtMs).map(intent => {
          const exited = events.find(event => event.kind === "group_exited" && event.seq === intent.seq)!;
          return { seq: intent.seq, runId: intent.runId!, pid: exited.pid!, exitedAt: iso(exited.recordedAtMs) };
        });
        return { version: 1, kind: "process_group_exit", requestId: candidate.requestId, owner: candidate.owner, fromState: candidate.state,
          dispatchAt: candidate.dispatchAt, bindingHash: candidate.bindingHash, termination: policy.termination, hardDeadlineMs: policy.hardDeadlineMs,
          skewBoundMs: policy.skewBoundMs, reference: identity(400).parse(policy.reference), exits, notBefore: iso(verdict.notBeforeMs),
          evaluatedAt: candidate.now, operator };
      })));
    return { rows };
  });
}

/**
 * 승격 뒤 옛 세대(seal 전 epoch/revision/policy)의 dispatched/indeterminate 를 그 budget scope 의 call-drain 이 drained 일 때만 회수한다.
 * lock 순서는 open-permits 와 같다: fence SHARE → promotion UPDATE → control UPDATE → request UPDATE. independent 는 호출 종료 증명이 아니므로 풀지 않는다.
 */
export async function releaseDrainedDispatches(value: { promotionId: string; operator: string }, apply: boolean): Promise<{ rows: DispatchReleaseRow[] }> {
  const promotionId = z.uuid().parse(value.promotionId), operator = identity(120).parse(value.operator);
  return drTransactionMaybeDry(apply, async tx => {
    const state = await lockPromotedState(tx, promotionId);
    const ids = Array.from(await tx.execute<{ request_id: string }>(sql`SELECT r.request_id::text FROM model_capacity_requests r, model_capacity_control c
      WHERE c.id = 1 AND r.state IN ('dispatched','indeterminate')
        AND (r.epoch <> c.epoch OR r.revision <> c.revision OR r.policy_hash IS DISTINCT FROM c.policy_hash) ORDER BY r.queue_ordinal`)).map(item => item.request_id);
    const rows: DispatchReleaseRow[] = [];
    for (const requestId of ids) rows.push(row(requestId, await releaseModelDispatchWithEvidence(tx, requestId,
      async (candidate: ModelDispatchReleaseCandidate): Promise<ModelDispatchReleaseEvidence | { blocked: string }> => {
        if (!candidate.oldGeneration) return { blocked: "not_old_generation" };
        const scope = `model:${candidate.providerBudgetId}`;
        const drain = promotionDrain(state.promotion, state.evidence, Date.parse(candidate.now)).find(item => item.scope === scope);
        if (!drain) return { blocked: "drain_scope_missing" };
        if (drain.status !== "drained" || !drain.notBefore) return { blocked: `drain_${drain.status}` };
        return { version: 1, kind: "dr_call_drain", requestId: candidate.requestId, owner: candidate.owner, fromState: candidate.state,
          dispatchAt: candidate.dispatchAt, bindingHash: candidate.bindingHash, promotionId, writerEpoch: state.promotion.plan.fromEpoch + 1, scope,
          notBefore: drain.notBefore, evaluatedAt: candidate.now, operator };
      })));
    return { rows };
  });
}

// ---- PR15d: DR 밖 회수(전역). 근거 있는 행만 풀고, 근거 없는 행은 그대로 두고 이유와 함께 보고한다. ----
const msIso = (column: string) => sql.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
/** dispatch 시각까지 의도가 기록된 child 들의 종료 기록(판정이 이미 모두 있음을 확인한 뒤에만 부른다). */
function exitsBefore(events: readonly ProcessGroupEvent[], dispatchAtMs: number) {
  return events.filter(event => event.kind === "spawn_intent" && event.recordedAtMs <= dispatchAtMs).map(intent => {
    const exited = events.find(event => event.kind === "group_exited" && event.seq === intent.seq)!;
    return { seq: intent.seq, runId: intent.runId!, pid: exited.pid!, exitedAt: iso(exited.recordedAtMs) };
  });
}

/**
 * 모든 owner 의 dispatched/indeterminate 모델 행 중 근거가 있는 것만 회수한다: 프로세스 그룹 종료(process_group_exit) 또는 indeterminate 행에
 * owner 가 남긴 게이트웨이 로컬 종료(local_call_ended). 둘 다 운영자가 선언한 provider 정책(client_bound, 또는 증명된 hard deadline)을 따른다.
 * lock 순서: fence SHARE → (장부 hook) control UPDATE → 요청 행 UPDATE. fenced DB 에서는 장부를 바꾸지 않는다. dry-run 은 같은 TX 뒤 ROLLBACK.
 */
export async function releaseEvidencedDispatches(value: { policies: ReadonlyMap<string, ReclaimPolicyWithReference>; operator: string },
  apply: boolean): Promise<{ rows: DispatchReleaseRow[] }> {
  const operator = identity(120).parse(value.operator);
  return drTransactionMaybeDry(apply, async tx => {
    if (!await writerSiteActive(tx)) throw new Error("dr_writer_site_fenced");
    const ids = Array.from(await tx.execute<{ request_id: string }>(sql`SELECT request_id::text FROM model_capacity_requests
      WHERE state IN ('dispatched','indeterminate') ORDER BY queue_ordinal`)).map(item => item.request_id);
    const rows: DispatchReleaseRow[] = [];
    for (const requestId of ids) rows.push(row(requestId, await releaseModelDispatchWithEvidence(tx, requestId,
      async (candidate: ModelDispatchReleaseCandidate): Promise<ModelDispatchReleaseEvidence | { blocked: string }> => {
        const policy = value.policies.get(candidate.providerBudgetId), local = candidate.localEnd ?? null;
        // 장부 행 lock 뒤에 읽는다(근거 표는 append-only). 판정은 보고와 같은 순수 함수다.
        const events = await readProcessGroupEvents(tx, candidate.owner), dispatchAtMs = candidate.dispatchAt ? Date.parse(candidate.dispatchAt) : null;
        const judged = judgeModelReclaim({ state: candidate.state, dispatchAtMs, bindingHash: candidate.bindingHash, owner: candidate.owner, events,
          localEnd: local && { endedAtMs: Date.parse(local.endedAt), owner: local.owner, bindingHash: local.bindingHash } }, policy, Date.parse(candidate.now));
        if (judged.status !== "reclaimable" || !policy || !candidate.dispatchAt) return { blocked: judged.reason ?? judged.status };
        const common = { version: 1 as const, requestId: candidate.requestId, owner: candidate.owner, dispatchAt: candidate.dispatchAt,
          bindingHash: candidate.bindingHash, termination: policy.termination, hardDeadlineMs: policy.hardDeadlineMs, skewBoundMs: policy.skewBoundMs,
          reference: identity(400).parse(policy.reference), notBefore: iso(judged.notBeforeMs!), evaluatedAt: candidate.now, operator };
        if (judged.evidence === "process_group_exit")
          return { ...common, kind: "process_group_exit", fromState: candidate.state, exits: exitsBefore(events, dispatchAtMs!) };
        return { ...common, kind: "local_call_ended", fromState: "indeterminate", endedAt: local!.endedAt,
          localEnd: { dispatches: local!.dispatches, terminals: local!.terminals } };
      })));
    return { rows };
  });
}

export type HopReleaseRow = Readonly<{ hopId: string; released: boolean; reason: string | null }>;
type ActiveHop = { id: string; instance_id: string; boot_id: string; origin: string; host_id: string; state: "dispatched" | "indeterminate"; dispatch_at: string };
const activeHops = (lock: boolean) => sql`SELECT id::text AS id, instance_id, boot_id::text AS boot_id, origin, host_id, state, ${msIso("dispatched_at")} AS dispatch_at
  FROM http_origin_hops WHERE state IN ('dispatched','indeterminate') ORDER BY created_at, id ${lock ? sql`FOR UPDATE` : sql``}`;
const hopPolicy = (skewBoundMs: number): ReclaimPolicy => ({ termination: "client_bound", hardDeadlineMs: null, skewBoundMs });

/**
 * crash 한 프로세스의 dispatched/indeterminate HTTP hop 을 그 owner(instance, boot)의 프로세스 그룹 종료 근거로만 released 로 정산한다.
 * 근거 없는 hop(기록기 없는 프로세스·살아 있는 그룹)은 그대로다. lock 순서: fence SHARE → http_origin_control UPDATE → hop 행 UPDATE.
 */
export async function releaseProcessExitedHops(value: { skewBoundMs: number; reference: string; operator: string }, apply: boolean): Promise<{ rows: HopReleaseRow[] }> {
  const operator = identity(120).parse(value.operator), reference = identity(400).parse(value.reference);
  const skewBoundMs = z.number().int().min(1).max(600_000).parse(value.skewBoundMs);
  return drTransactionMaybeDry(apply, async tx => {
    if (!await writerSiteActive(tx)) throw new Error("dr_writer_site_fenced");
    const [control] = await tx.execute(sql`SELECT id FROM http_origin_control WHERE id = 1 FOR UPDATE`);
    if (!control) throw new Error("http_origin_control_missing");
    const hops = Array.from(await tx.execute<ActiveHop>(activeHops(true))), now = await dbNow(tx), rows: HopReleaseRow[] = [];
    for (const hop of hops) {
      const owner = processOwnerSchema.safeParse({ instanceId: hop.instance_id, bootId: hop.boot_id });
      if (!owner.success) { rows.push({ hopId: hop.id, released: false, reason: "owner_invalid" }); continue; }
      const events = await readProcessGroupEvents(tx, owner.data), dispatchAtMs = Date.parse(hop.dispatch_at);
      const verdict = evaluateProcessReclaim(events, dispatchAtMs, hopPolicy(skewBoundMs), now.ms);
      if (!verdict.reclaimable) { rows.push({ hopId: hop.id, released: false, reason: verdict.reason }); continue; }
      const evidence = httpHopReleaseEvidenceSchema.parse({ version: 1, kind: "process_group_exit", hopId: hop.id, owner: owner.data, fromState: hop.state,
        dispatchAt: hop.dispatch_at, termination: "client_bound", skewBoundMs, reference, exits: exitsBefore(events, dispatchAtMs),
        notBefore: iso(verdict.notBeforeMs), evaluatedAt: now.iso, operator });
      const changed = await tx.execute(sql`UPDATE http_origin_hops SET state = 'released', settled_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = ${hop.id}::uuid AND state = ${hop.state} RETURNING id`);
      if (changed.length !== 1) throw new Error("http_origin_hop_changed");
      await tx.execute(sql`INSERT INTO http_origin_events (hop_id, kind, evidence) VALUES (${hop.id}::uuid, 'released', ${JSON.stringify(evidence)}::text::jsonb)`);
      rows.push({ hopId: hop.id, released: true, reason: null });
    }
    return { rows };
  });
}

type ReportOwner = Readonly<{ instanceId: string; bootId: string }>;
export type ModelReclaimReportRow = Readonly<{ requestId: string; owner: ReportOwner; state: "dispatched" | "indeterminate"; providerBudgetId: string;
  dispatchAt: string | null; status: "reclaimable" | "waiting" | "policy_blocked" | "unproven"; evidence: "process_group_exit" | "local_call_ended" | null;
  reason: string | null; notBefore: string | null }>;
export type HopReclaimReportRow = Readonly<{ hopId: string; owner: ReportOwner; origin: string; hostId: string; state: "dispatched" | "indeterminate";
  dispatchAt: string; status: "reclaimable" | "waiting" | "unproven"; reason: string | null; notBefore: string | null }>;
export type ReclaimReport = Readonly<{ now: string; siteActive: boolean;
  model: Readonly<{ total: number; reclaimable: number; waiting: number; policyBlocked: number; unproven: number; rows: ModelReclaimReportRow[] }>;
  http: Readonly<{ total: number; reclaimable: number; waiting: number; unproven: number; rows: HopReclaimReportRow[] }> }>;
type ActiveModel = { request_id: string; owner_instance_id: string; owner_boot_id: string; state: "dispatched" | "indeterminate"; provider_budget_id: string;
  dispatch_binding_hash: string | null; dispatch_at: string | null; local: unknown; local_at: string | null };
const count = <T extends { status: string }>(rows: readonly T[], status: string) => rows.filter(item => item.status === status).length;

/**
 * 읽기 전용 회수 보고(ROLLBACK). 모델 행·HTTP hop 마다 회수 가능(근거+정책 충족)/대기(기한 전)/정책 필요(근거는 있으나 provider 기한 미상)/
 * 근거 없음을 센다. 행을 잠그지 않고 fence 상태와 무관하게 읽는다 — 실제 회수는 release* 가 같은 판정을 lock 아래에서 다시 한다.
 */
export async function readReclaimReport(policies: ReadonlyMap<string, ReclaimPolicy>, skewBoundMs: number): Promise<ReclaimReport> {
  const skew = z.number().int().min(1).max(600_000).parse(skewBoundMs);
  return drTransactionMaybeDry(false, async tx => {
    const siteActive = await writerSiteActive(tx);
    const models = Array.from(await tx.execute<ActiveModel>(sql`SELECT r.request_id::text, r.owner_instance_id, r.owner_boot_id::text, r.state, r.provider_budget_id,
      r.dispatch_binding_hash, ${msIso(`coalesce(r.dispatched_at, (SELECT min(e.created_at) FROM model_capacity_events e
        WHERE e.request_id = r.request_id AND e.kind = 'dispatch_started'))`)} AS dispatch_at, f.evidence AS local, ${msIso("f.created_at")} AS local_at
      FROM model_capacity_requests r LEFT JOIN model_capacity_events f ON f.request_id = r.request_id AND f.kind = 'dispatch_local_ended'
      WHERE r.state IN ('dispatched','indeterminate') ORDER BY r.queue_ordinal`));
    const hops = Array.from(await tx.execute<ActiveHop>(activeHops(false))), now = await dbNow(tx);
    const events = new Map<string, ProcessGroupEvent[]>();
    const eventsOf = async (owner: ReportOwner) => {
      const key = JSON.stringify([owner.instanceId, owner.bootId]), parsed = processOwnerSchema.safeParse(owner);
      if (!events.has(key)) events.set(key, parsed.success ? await readProcessGroupEvents(tx, parsed.data) : []);
      return events.get(key)!;
    };
    const modelRows: ModelReclaimReportRow[] = [];
    for (const item of models) {
      const owner = { instanceId: item.owner_instance_id, bootId: item.owner_boot_id };
      const fact = item.local === null ? null : gatewayLocalEndFactSchema.safeParse(item.local);
      const judged = judgeModelReclaim({ state: item.state, dispatchAtMs: item.dispatch_at ? Date.parse(item.dispatch_at) : null, bindingHash: item.dispatch_binding_hash,
        owner, events: await eventsOf(owner), localEnd: fact?.success && item.local_at ? { endedAtMs: Date.parse(item.local_at), owner: fact.data.owner,
          bindingHash: fact.data.bindingHash } : null }, policies.get(item.provider_budget_id), now.ms);
      modelRows.push({ requestId: item.request_id, owner, state: item.state, providerBudgetId: item.provider_budget_id, dispatchAt: item.dispatch_at,
        status: judged.status, evidence: judged.evidence, reason: judged.reason, notBefore: judged.notBeforeMs === null ? null : iso(judged.notBeforeMs) });
    }
    const hopRows: HopReclaimReportRow[] = [];
    for (const hop of hops) {
      const owner = { instanceId: hop.instance_id, bootId: hop.boot_id };
      const verdict = evaluateProcessReclaim(await eventsOf(owner), Date.parse(hop.dispatch_at), hopPolicy(skew), now.ms);
      hopRows.push({ hopId: hop.id, owner, origin: hop.origin, hostId: hop.host_id, state: hop.state, dispatchAt: hop.dispatch_at,
        status: verdict.reclaimable ? "reclaimable" : verdict.notBeforeMs !== null ? "waiting" : "unproven", reason: verdict.reclaimable ? null : verdict.reason,
        notBefore: verdict.notBeforeMs === null ? null : iso(verdict.notBeforeMs) });
    }
    return { now: now.iso, siteActive,
      model: { total: modelRows.length, reclaimable: count(modelRows, "reclaimable"), waiting: count(modelRows, "waiting"),
        policyBlocked: count(modelRows, "policy_blocked"), unproven: count(modelRows, "unproven"), rows: modelRows },
      http: { total: hopRows.length, reclaimable: count(hopRows, "reclaimable"), waiting: count(hopRows, "waiting"), unproven: count(hopRows, "unproven"), rows: hopRows } };
  });
}
