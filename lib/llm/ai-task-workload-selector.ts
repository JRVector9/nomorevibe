import { eq, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { modelCapacityControl } from "@/lib/db/schema";
import { aiTask, AI_CLI_TOOL_PROVIDERS, type AiCliTool } from "./ai-tasks";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { modelCapacityPolicyHash, parseModelCapacityPolicy } from "./capacity";
import { readModelCapacityDeviceStates, listModelCapacityDevices } from "./capacity-devices-repository";
import { deviceFits, deviceRoleRank } from "./capacity-devices";
import { ModelCapacityDeferredError } from "./capacity-deferred";
import { taskPoolEngineKey } from "./ai-task-pool-identity";
import { aiTaskSupportsWorkloadPool, type AiTaskExecutionConfig, type AiTaskWorkloadCandidate, type AiTaskWorkloadChoice } from "./ai-task-execution-config";

const cursors = new Map<string, number>();
/**
 * Read-only selection HINT for one new work unit, never a reservation or dispatch authority.
 * Device state uses grantOne's existing CTE/role/helper rules. Concurrent observations may race;
 * only existing requestSlot + domain claim/dispatch transactions authorize work and enforce caps.
 * Existing waiting/resumed identities are selected first and never replaced by a newly idle route.
 */
export async function chooseTaskWorkloadMember<T extends AiTaskWorkloadCandidate>(config: AiTaskExecutionConfig,
  candidates: readonly T[], options: Readonly<{ preferIdentity?: string | null; executor?: ProductTransaction }> = {}): Promise<AiTaskWorkloadChoice<T> | null> {
  if (config.mode !== "workload_pool") return null;
  if (!aiTaskSupportsWorkloadPool(config.task, config.slot)) throw new ModelCapacityDeferredError("assignments_unavailable");
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
        const provider = member.connection.kind === "cli"
          ? AI_CLI_TOOL_PROVIDERS[member.connection.cliTool as AiCliTool] : null;
        if (member.connection.kind === "cli" ? candidate.provider !== provider
          : !["abcllm", "local-direct"].includes(candidate.provider)) return [];
        const route = policy.routes.find(row => row.routeId === candidate.routeId && row.provider === candidate.provider && row.model === candidate.identity);
        if (!route || route.groupId !== member.deviceId) return [];
        return [{ candidate, member, route }];
      });
      const result = (chosen: typeof eligible[number]): AiTaskWorkloadChoice<T> => Object.freeze({ ...chosen.candidate,
        poolSelection: Object.freeze({ task: config.task, slot: config.slot, configRevision: config.revision!, memberId: chosen.member.memberId,
          position: chosen.member.position, policyEpoch: Number(control.epoch), policyRevision: Number(control.revision), policyHash: control.policyHash! }) });
      if (options.preferIdentity) {
        const preferred = eligible.find(row => row.candidate.identity === options.preferIdentity);
        return preferred ? result(preferred) : null;
      }
      if (control.mode !== "open") throw new ModelCapacityDeferredError(control.mode === "disabled" ? "disabled" : "draining");
      const [states, settings] = await Promise.all([readModelCapacityDeviceStates(tx), listModelCapacityDevices(tx)]);
      const ready = eligible.flatMap(row => {
        const state = states.find(item => item.deviceId === row.route.groupId);
        const configured = settings.find(item => item.deviceId === row.route.groupId);
        if (!state || configured && !configured.enabled) return [];
        const rank = deviceRoleRank(configured?.roles ?? [], row.candidate.routeId);
        if (!deviceFits({ active: state.active, limitSlots: state.limitSlots, rank,
          secondaryActive: state.secondaryActive, secondaryBound: state.secondaryBound })) return [];
        const helper = state.helpers?.filter(item => item.routeId === row.candidate.routeId
          && item.provider === row.candidate.provider && item.model === row.candidate.identity) ?? [];
        if (helper.some(item => !item.ok || item.active >= item.maxSlots)) return [];
        return [{ ...row, pressure: (state.active + state.waiting) / state.limitSlots }];
      });
      if (!ready.length) return null;
      const key = `${config.task}#${config.slot}@${config.revision}`, cursor = cursors.get(key) ?? 0;
      ready.sort((a, b) => a.pressure - b.pressure
        || (a.member.position - 1 - cursor + 4) % 4 - (b.member.position - 1 - cursor + 4) % 4);
      const chosen = ready[0];
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
