import { sql } from "drizzle-orm";
import { z } from "zod";
import { releaseModelDispatchWithEvidence, type ModelDispatchReleaseCandidate } from "@/lib/llm/capacity-repository";
import type { ModelDispatchReleaseEvidence } from "@/lib/llm/capacity";
import { identity, writerSiteActive } from "./epoch";
import { evaluateProcessReclaim, type ReclaimPolicy } from "./call-drain";
import { promotionDrain } from "./promotion";
import { drTransactionMaybeDry, lockPromotedState, processOwnerSchema, readProcessGroupEvents, type ProcessOwner } from "./repository";

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
