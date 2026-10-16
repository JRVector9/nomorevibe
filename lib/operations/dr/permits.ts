import { sql } from "drizzle-orm";
import { cancelReservedModelSlot } from "@/lib/llm/capacity-repository";
import { modelCapacityReservationSchema, parseModelCapacityPolicy } from "@/lib/llm/capacity";
import { identity, isoMillis } from "./epoch";
import { promotionDrain } from "./promotion";
import type { DrainScopeResult } from "./call-drain";
import { dbNow, drTransactionMaybeDry, insertInternalEvidence, lockPromotedState } from "./repository";

/** HTTP origin permit: promote된 DB에서 http scope barrier를 control lock 아래 다시 확인한 뒤,
 * seal 이전 세대의 hop을 정산하고(reserved=cancelled, dispatched/indeterminate=released) policy가 있으면 연다. */
export async function openHttpPermitsAfterDrain(value: { promotionId: string; operator: string }, apply: boolean): Promise<
  { kind: "blocked"; drain: DrainScopeResult | null } | { kind: "opened" | "settled_only"; controlEpoch: number; released: string[]; cancelled: string[]; mode: string }> {
  const operator = identity(120).parse(value.operator);
  return drTransactionMaybeDry(apply, async tx => {
    const state = await lockPromotedState(tx, value.promotionId);
    const [control] = await tx.execute<{ mode: string; epoch: string; has_policy: boolean }>(sql`SELECT mode, epoch::text, policy IS NOT NULL AS has_policy
      FROM http_origin_control WHERE id = 1 FOR UPDATE`);
    if (!control) throw new Error("http_origin_control_missing");
    // control lock을 기다린 뒤의 DB clock으로 다시 판정한다.
    const now = await dbNow(tx), http = promotionDrain(state.promotion, state.evidence, now.ms).find(scope => scope.scope === "http") ?? null;
    if (!http || http.status !== "drained") return { kind: "blocked" as const, drain: http };
    const epoch = Number(control.epoch);
    const old = Array.from(await tx.execute<{ id: string; state: string }>(sql`SELECT id::text, state FROM http_origin_hops
      WHERE epoch < ${epoch} AND state IN ('reserved','dispatched','indeterminate') ORDER BY id FOR UPDATE`));
    const released: string[] = [], cancelled: string[] = [];
    for (const hop of old) {
      const next = hop.state === "reserved" ? "cancelled" : "released";
      const changed = await tx.execute(sql`UPDATE http_origin_hops SET state = ${next}, settled_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = ${hop.id}::uuid AND state = ${hop.state} RETURNING id`);
      if (changed.length !== 1) throw new Error("http_origin_hop_changed");
      await tx.execute(sql`INSERT INTO http_origin_events (hop_id, kind) VALUES (${hop.id}::uuid, ${next})`);
      (next === "cancelled" ? cancelled : released).push(hop.id);
    }
    await insertInternalEvidence(tx, state.promotion.promotionId, "http_hops_released", `http:${epoch}`,
      { version: 1, controlEpoch: epoch, released, cancelled, drainedAt: isoMillis.parse(now.iso) }, operator);
    if (!control.has_policy || control.mode !== "draining") return { kind: "settled_only" as const, controlEpoch: epoch, released, cancelled, mode: control.mode };
    await tx.execute(sql`UPDATE http_origin_control SET mode = 'open', updated_at = clock_timestamp() WHERE id = 1 AND mode = 'draining'`);
    return { kind: "opened" as const, controlEpoch: epoch, released, cancelled, mode: "open" };
  });
}

type OldReserved = { request_id: string; owner_instance_id: string; owner_boot_id: string; token: string; epoch: string; revision: string; policy_hash: string };
const oldActive = sql`state IN ('reserved','dispatched','indeterminate') AND (epoch <> (SELECT epoch FROM model_capacity_control WHERE id = 1)
  OR revision <> (SELECT revision FROM model_capacity_control WHERE id = 1) OR policy_hash IS DISTINCT FROM (SELECT policy_hash FROM model_capacity_control WHERE id = 1))`;

/** 모델 슬롯: 모든 model scope가 drained 또는 independent(현재 policy가 옛 budget을 route하지 않음)이고,
 * seal 이전 세대의 active 행이 0일 때만 연다. 옛 reserved는 장부 공개 API로 취소한다(owner는 G3로 정지가 증명됨).
 * 옛 dispatched/indeterminate는 장부 해제 hook이 없으므로 남은 수를 보고하고 거절한다(PR05 의미: 정책 변경으로 풀지 않음). */
export async function openModelCapacityAfterDrain(value: { promotionId: string; operator: string }, apply: boolean): Promise<
  { kind: "blocked"; reason: string; drain: readonly DrainScopeResult[]; cancelledReservations: string[] }
  | { kind: "opened"; drain: readonly DrainScopeResult[]; cancelledReservations: string[] }> {
  identity(120).parse(value.operator);
  const reserved = await drTransactionMaybeDry(false, async tx => {
    await lockPromotedState(tx, value.promotionId);
    return Array.from(await tx.execute<OldReserved>(sql`SELECT request_id::text, owner_instance_id, owner_boot_id::text, token::text, epoch::text, revision::text, policy_hash
      FROM model_capacity_requests WHERE state = 'reserved' AND ${oldActive} ORDER BY queue_ordinal`));
  });
  const cancelledReservations: string[] = [];
  for (const row of reserved) {
    if (!apply) { cancelledReservations.push(row.request_id); continue; }
    // 만료됐으면 장부가 reservation_expired로, 아니면 reservation_cancelled로 정산한다(둘 다 기존 의미).
    await cancelReservedModelSlot(modelCapacityReservationSchema.parse({ requestId: row.request_id,
      owner: { instanceId: row.owner_instance_id, bootId: row.owner_boot_id }, token: row.token,
      epoch: Number(row.epoch), revision: Number(row.revision), policyHash: row.policy_hash }));
    cancelledReservations.push(row.request_id);
  }
  return drTransactionMaybeDry(apply, async tx => {
    const state = await lockPromotedState(tx, value.promotionId);
    const [control] = await tx.execute<{ mode: string; policy: unknown }>(sql`SELECT mode, policy FROM model_capacity_control WHERE id = 1 FOR UPDATE`);
    if (!control) throw new Error("model_capacity_control_missing");
    const now = await dbNow(tx), drain = promotionDrain(state.promotion, state.evidence, now.ms).filter(scope => scope.scope !== "http");
    const blocked = (reason: string) => ({ kind: "blocked" as const, reason, drain, cancelledReservations });
    const notReady = drain.find(scope => scope.status !== "drained" && scope.status !== "independent");
    if (notReady) return blocked(`drain_${notReady.status}:${notReady.scope}`);
    if (control.policy === null) return blocked("model_capacity_policy_missing");
    const policy = parseModelCapacityPolicy(control.policy);
    const routed = drain.find(scope => scope.status === "independent" && policy.routes.some(route => route.providerBudgetId === scope.scope.slice(6)));
    if (routed) return blocked(`independent_budget_still_routed:${routed.scope}`);
    const [old] = await tx.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM model_capacity_requests WHERE ${oldActive}`);
    if (old.count > (apply ? 0 : cancelledReservations.length)) return blocked(`model_capacity_old_dispatch_unreleased:${old.count - (apply ? 0 : cancelledReservations.length)}`);
    if (control.mode !== "draining") return blocked(`model_capacity_mode_${control.mode}`);
    await tx.execute(sql`UPDATE model_capacity_control SET mode = 'open', updated_at = clock_timestamp() WHERE id = 1 AND mode = 'draining'`);
    return { kind: "opened" as const, drain, cancelledReservations };
  });
}
