import { eq, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { modelCapacityControl } from "@/lib/db/schema";
import { aiTask, AI_CLI_TOOL_PROVIDERS, type AiCliTool } from "./ai-tasks";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { modelCapacityPolicyHash, parseModelCapacityPolicy } from "./capacity";
import { readModelCapacityDeviceStates, listModelCapacityDevices } from "./capacity-devices-repository";
import { deviceFits, deviceModelQuotaFits, deviceRoleRank, deviceRouteQuotaFits } from "./capacity-devices";
import { ModelCapacityDeferredError } from "./capacity-deferred";
import { taskPoolEngineKey } from "./ai-task-pool-identity";
import { aiTaskUsesCliEngine, cliEngineRevision, type CliEngineSource } from "./cli-engine-config";
import { aiTaskSupportsPool, type AiTaskExecutionConfig, type AiTaskWorkloadCandidate, type AiTaskWorkloadChoice } from "./ai-task-execution-config";

const cursors = new Map<string, number>();

type CliEngineCandidateMetadata = Readonly<{
  cliEngine?: CliEngineSource;
  options?: Readonly<Record<string, unknown>>;
}>;

function configuredCliEngineSource(member: { connectionId: string; options?: Readonly<Record<string, unknown>> }): CliEngineSource | null {
  const reasoningEffort = (member.options ?? {}).reasoningEffort;
  if (reasoningEffort !== undefined && typeof reasoningEffort !== "string") return null;
  const source: CliEngineSource = reasoningEffort === undefined
    ? { connectionId: member.connectionId }
    : { connectionId: member.connectionId, reasoningEffort };
  try {
    cliEngineRevision(source);
    return Object.freeze(source);
  } catch {
    return null;
  }
}

function sameCliEngineSource(left: CliEngineSource, right: CliEngineSource): boolean {
  try {
    return cliEngineRevision(left) === cliEngineRevision(right);
  } catch {
    return false;
  }
}
/**
 * Read-only selection HINT for one new work unit, never a reservation or dispatch authority.
 * Device state uses grantOne's existing CTE/role/helper rules. Concurrent observations may race;
 * only existing requestSlot + domain claim/dispatch transactions authorize work and enforce caps.
 * Existing waiting/resumed identities are selected first and never replaced by a newly idle route.
 *
 * queueWhenFull(2026-11-12 「동시에」 검토): 지금 빈 칸이 있는 구성원이 없으면 줄에 설 구성원(압력이 가장 낮은 것)을 고른다.
 * 순위대로는 requestSlot 이 대기 행을 남기고 칸이 비면 grantOne 이 차례대로 예약해 다음 틱이 이어받는다 — 힌트가 빈 칸만 고르면
 * 「동시에」는 그 줄에 한 번도 서지 못해 같은 장비를 쓰는 다른 경로(줄에 선 대기 행)에 계속 밀린다. 줄에 서지 못하는 구성원
 * (장비 없음·꺼짐, 경로 몫·모델 상한이 참 — requestSlot 이 대기 행 없이 거절, 도우미 닫힘·가득)은 고르지 않는다. 판정은 여전히 장부다.
 * rotate: 압력보다 돌림 차례를 먼저 본다 — 장부에 행을 쓰지 않고 잇달아 고르는 쪽(2차 표 배정)이 같은 장비 상태를 보고 한 구성원에 몰리지 않게.
 */
export async function chooseTaskWorkloadMember<T extends AiTaskWorkloadCandidate>(config: AiTaskExecutionConfig,
  candidates: readonly T[], options: Readonly<{ preferIdentity?: string | null; preferMemberId?: string | null; executor?: ProductTransaction;
    queueWhenFull?: boolean; rotate?: boolean }> = {}): Promise<AiTaskWorkloadChoice<T> | null> {
  if (config.mode !== "workload_pool") return null;
  if (!aiTaskSupportsPool(config.task, config.slot)) throw new ModelCapacityDeferredError("assignments_unavailable");
  if (config.revision === null || config.members.length < 1 || config.members.length > 4)
    throw new ModelCapacityDeferredError("assignments_unavailable");
  const task = aiTask(config.task);
  if (!task || config.slot < 1 || config.slot > task.slots) throw new ModelCapacityDeferredError("assignments_unavailable");
  try {
    const load = async (tx: ProductTransaction): Promise<AiTaskWorkloadChoice<T> | null> => {
      if (!options.executor) await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      const [control] = await tx.select().from(modelCapacityControl).where(eq(modelCapacityControl.id, 1));
      if (!control?.policy || !control.policyHash) throw new ModelCapacityDeferredError("assignments_unavailable");
      const policy = parseModelCapacityPolicy(control.policy);
      if (modelCapacityPolicyHash(policy) !== control.policyHash) throw new ModelCapacityDeferredError("policy_changed");
      const eligible = candidates.flatMap(candidate => {
        const member = config.members.find(row => row.memberId === candidate.memberId);
        if (!member || candidate.connectionId !== member.connectionId || candidate.engineModel !== member.model
          || !member.connection.enabled || member.connection.keyUnreadable
          || member.connection.deviceId !== member.deviceId || candidate.deviceId !== member.deviceId
          || taskPoolEngineKey(member.connection, member.canonicalModel) !== member.engineKey
          || task.routeId !== null && candidate.routeId !== task.routeId) return [];
        const cliEngineTask = aiTaskUsesCliEngine(config.task, member.connection);
        const cliMetadata = candidate as T & CliEngineCandidateMetadata;
        if (cliEngineTask) {
          if (candidate.provider !== "abcllm" || cliMetadata.options === undefined) return [];
          const configured = configuredCliEngineSource(member);
          const captured = configuredCliEngineSource({ connectionId: candidate.connectionId, options: cliMetadata.options });
          if (!configured || !captured || !cliMetadata.cliEngine
            || !sameCliEngineSource(captured, configured)
            || !sameCliEngineSource(cliMetadata.cliEngine, configured)) return [];
        } else {
          const provider = member.connection.kind === "cli"
            ? AI_CLI_TOOL_PROVIDERS[member.connection.cliTool as AiCliTool] : null;
          if (member.connection.kind === "cli" ? candidate.provider !== provider
            : !["abcllm", "local-direct"].includes(candidate.provider)) return [];
          if (member.connection.kind === "api" && cliMetadata.cliEngine !== undefined) return [];
        }
        const route = policy.routes.find(row => row.routeId === candidate.routeId && row.provider === candidate.provider && row.model === candidate.identity);
        if (!route || route.groupId !== member.deviceId) return [];
        return [{ candidate, member, route }];
      });
      const result = (chosen: typeof eligible[number]): AiTaskWorkloadChoice<T> => Object.freeze({ ...chosen.candidate,
        poolSelection: Object.freeze({ task: config.task, slot: config.slot, configRevision: config.revision!, memberId: chosen.member.memberId,
          position: chosen.member.position, policyEpoch: Number(control.epoch), policyRevision: Number(control.revision), policyHash: control.policyHash! }) });
      if (options.preferIdentity || options.preferMemberId) {
        const preferred = eligible.find(row => (!options.preferIdentity || row.candidate.identity === options.preferIdentity)
          && (!options.preferMemberId || row.member.memberId === options.preferMemberId));
        return preferred ? result(preferred) : null;
      }
      if (control.mode !== "open") throw new ModelCapacityDeferredError(control.mode === "disabled" ? "disabled" : "draining");
      const [states, settings] = await Promise.all([readModelCapacityDeviceStates(tx), listModelCapacityDevices(tx)]);
      const judged = eligible.flatMap(row => {
        const state = states.find(item => item.deviceId === row.route.groupId);
        const configured = settings.find(item => item.deviceId === row.route.groupId);
        if (!state || configured && !configured.enabled) return [];
        const helper = state.helpers?.filter(item => item.routeId === row.candidate.routeId
          && item.provider === row.candidate.provider && item.model === row.candidate.identity) ?? [];
        // A closed or full helper route is refused as helper_ineligible without queuing.
        if (helper.some(item => !item.ok || item.active >= item.maxSlots)) return [];
        // Route quota (step 2) hint, same expression as deviceCandidateSql/deviceRouteQuotaGateSql: a route at its cap on this device
        // would be refused as route_quota without queuing, and other routes' unmet guarantees stay free. SQL stays the authority.
        const quota = deviceRouteQuotaFits(state, row.candidate.routeId);
        // Model cap (0170) hint, same expression as deviceModelQuotaGateSql: the ledger model string on this device at its cap would be
        // refused as model_quota without queuing. Absolute, whatever the route guarantee says.
        const model = deviceModelQuotaFits(state, row.route.model);
        if (quota.atCap || model.atCap) return [];
        // Match capacity-devices effectiveRank: helper routes never receive the rank-1 bypass. A route under its guarantee
        // passes the secondary bound like rank 1 (non-helper only), as in deviceCandidateSql.
        const roleRank = deviceRoleRank(configured?.roles ?? [], row.candidate.routeId);
        const rank = helper.length ? Math.max(roleRank, 2) : quota.underGuarantee ? 1 : roleRank;
        const fits = quota.fits && model.fits && deviceFits({ active: state.active, limitSlots: state.limitSlots, rank,
          secondaryActive: state.secondaryActive, secondaryBound: state.secondaryBound });
        return [{ ...row, fits, pressure: (state.active + state.waiting) / state.limitSlots }];
      });
      const ready = judged.filter(row => row.fits);
      // 빈 칸이 없으면(그리고 부른 쪽이 원하면) 줄에 설 수 있는 구성원 중에서 — requestSlot 이 대기 행을 쓴다
      const pool = ready.length ? ready : options.queueWhenFull ? judged : [];
      if (!pool.length) return null;
      const key = `${config.task}#${config.slot}@${config.revision}`, cursor = cursors.get(key) ?? 0;
      const turn = (row: typeof pool[number]) => (row.member.position - 1 - cursor + 4) % 4;
      pool.sort((a, b) => options.rotate ? turn(a) - turn(b) || a.pressure - b.pressure : a.pressure - b.pressure || turn(a) - turn(b));
      const chosen = pool[0];
      if (cursors.size >= 256 && !cursors.has(key)) cursors.delete(cursors.keys().next().value!);
      cursors.set(key, chosen.member.position % 4);
      return result(chosen);
    };
    return options.executor ? await load(options.executor)
      : await onPrimary(() => db.transaction(load, { accessMode: "read only", isolationLevel: "repeatable read" }));
  } catch (error) {
    if (error instanceof ModelCapacityDeferredError) throw error;
    throw new ModelCapacityDeferredError("assignments_unavailable");
  }
}
