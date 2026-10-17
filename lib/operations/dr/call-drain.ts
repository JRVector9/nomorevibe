import { z } from "zod";
import { identity, isoMillis } from "./epoch";

/** 새 permit을 막는 단위: 모델 provider budget마다 하나, HTTP origin permit 전체 하나. */
export const drainScopeSchema = z.string().regex(/^(http|model:[A-Za-z0-9][A-Za-z0-9._:-]{0,119})$/);
export type DrainScope = "http" | `model:${string}`;
const deadlineMs = z.number().int().min(1).max(86_400_000);
const skewMs = z.number().int().min(1).max(600_000);

/** client_bound: 호출 프로세스가 죽으면 우리 쪽 점유가 끝난다(HTTP origin). provider_bound: provider가 계속 실행할 수 있어
 * provider 쪽에서 강제되는 hard deadline의 근거가 있어야 한다(gateway 모델). */
export const providerDeadlinePayloadSchema = z.object({ version: z.literal(1), scope: drainScopeSchema,
  termination: z.enum(["client_bound", "provider_bound"]), hardDeadlineMs: deadlineMs.nullable(), reference: identity(400),
}).strict().refine(value => value.termination === "client_bound" ? value.hardDeadlineMs === null : value.hardDeadlineMs !== null, "invalid_provider_deadline");
export type ProviderDeadline = Readonly<z.infer<typeof providerDeadlinePayloadSchema>>;

/** lease 만료·heartbeat 부재·자기 release는 받지 않는다. 옛 writer 밖의 control plane/전원/컨테이너 근거만. */
export const writerProcessStoppedPayloadSchema = z.object({ version: z.literal(1), instanceId: identity(120),
  method: z.enum(["control_plane_stopped", "host_powered_off", "container_removed"]), reference: identity(400),
  autoRestartDisabled: z.literal(true), stoppedAt: isoMillis, skewBoundMs: skewMs }).strict();
export type WriterProcessStopped = Readonly<z.infer<typeof writerProcessStoppedPayloadSchema>>;

/** 옛 budget을 새 policy가 전혀 route하지 않을 때만 의미가 있다(permit adapter가 현재 policy로 다시 확인). */
export const independentBudgetPayloadSchema = z.object({ version: z.literal(1), scope: drainScopeSchema,
  replacementBudgetId: identity(120), reference: identity(400) }).strict()
  .refine(value => value.scope.startsWith("model:") && value.scope.slice(6) !== value.replacementBudgetId, "invalid_independent_budget");
export type IndependentBudget = Readonly<z.infer<typeof independentBudgetPayloadSchema>>;

export type ProcessStop = Readonly<{ stoppedAtMs: number; skewBoundMs: number }>;
export type DrainScopeResult = Readonly<{ scope: DrainScope; status: "drained" | "waiting" | "blocked" | "independent";
  termination: "client_bound" | "provider_bound"; notBefore: string | null; reason: string | null }>;
export type CallDrainInput = Readonly<{ nowMs: number; scopes: readonly DrainScope[]; requiredInstances: readonly string[];
  stops: ReadonlyMap<string, ProcessStop>; deadlines: ReadonlyMap<string, ProviderDeadline>; independent: ReadonlySet<string> }>;

/** 장부에 남은 행이든 RPO 구간에서 장부에 없는 호출이든, 옛 writer 호출의 시작은 프로세스 정지 F 이전이다.
 * dispatched_at은 commit 뒤 transport가 늦게 시작할 수 있어 상한이 아니므로 쓰지 않는다. */
export function evaluateCallDrain(input: CallDrainInput): DrainScopeResult[] {
  const missing = input.requiredInstances.length === 0 ? "writer_instances_undeclared"
    : input.requiredInstances.some(instance => !input.stops.has(instance)) ? "writer_process_unfenced" : null;
  const stops = input.requiredInstances.map(instance => input.stops.get(instance)).filter((stop): stop is ProcessStop => !!stop);
  const fenceAt = Math.max(...stops.map(stop => stop.stoppedAtMs)), skew = Math.max(...stops.map(stop => stop.skewBoundMs));
  return input.scopes.map(scope => {
    const deadline = input.deadlines.get(scope);
    const termination = deadline?.termination ?? (scope === "http" ? "client_bound" : "provider_bound");
    const blocked = (reason: string): DrainScopeResult => ({ scope, status: "blocked", termination, notBefore: null, reason });
    if (missing) return blocked(missing);
    if (scope !== "http" && input.independent.has(scope)) return { scope, status: "independent", termination, notBefore: null, reason: null };
    if (termination === "provider_bound" && !deadline?.hardDeadlineMs) return blocked("provider_deadline_unknown");
    const notBeforeMs = fenceAt + (termination === "provider_bound" ? deadline!.hardDeadlineMs! : 0) + skew;
    if (!Number.isSafeInteger(notBeforeMs)) return blocked("invalid_drain_time");
    return { scope, status: input.nowMs >= notBeforeMs ? "drained" : "waiting", termination, notBefore: new Date(notBeforeMs).toISOString(), reason: null };
  });
}

export type ProcessGroupEvent = Readonly<{ kind: "owner_opened" | "spawn_intent" | "spawned" | "group_exited"; seq: number;
  runId: string | null; pid: number | null; recordedAtMs: number }>;
export type LocalCallEnd = { ended: true; lastExitAtMs: number } | { ended: false; reason: string };

/** D11: owner(instance,boot)의 행이 dispatch된 시각(같은 DB clock)까지 의도가 기록된 모든 child 그룹이
 * ESRCH 종료 근거를 가져야 로컬 호출이 끝났다고 본다. 기록 유실(번호 공백)·늦은 owner 기록은 거절한다. */
export function evaluateLocalCallEnded(events: readonly ProcessGroupEvent[], dispatchAtMs: number): LocalCallEnd {
  const opened = events.filter(event => event.kind === "owner_opened");
  if (opened.length !== 1 || !(opened[0].recordedAtMs < dispatchAtMs)) return { ended: false, reason: "owner_not_opened_before_dispatch" };
  const intents = events.filter(event => event.kind === "spawn_intent").sort((a, b) => a.seq - b.seq);
  if (intents.some((intent, index) => intent.seq !== index + 1)) return { ended: false, reason: "spawn_sequence_gap" };
  // timestamp(3) 반올림은 단조라 역전은 없다. 같은 ms의 의도는 dispatch할 수 있었던 것으로 보수적으로 센다.
  const possible = intents.filter(intent => intent.recordedAtMs <= dispatchAtMs);
  if (!possible.length) return { ended: false, reason: "no_spawn_before_dispatch" };
  let lastExitAtMs = -Infinity;
  for (const intent of possible) {
    const spawned = events.filter(event => event.kind === "spawned" && event.seq === intent.seq);
    const exited = events.filter(event => event.kind === "group_exited" && event.seq === intent.seq);
    if (!exited.length) return { ended: false, reason: `spawn_not_exited:${intent.seq}` };
    if (spawned.length !== 1) return { ended: false, reason: `spawned_record_missing:${intent.seq}` };
    if (exited.length !== 1 || spawned[0].runId !== intent.runId || exited[0].runId !== intent.runId || exited[0].pid !== spawned[0].pid)
      return { ended: false, reason: `exit_mismatch:${intent.seq}` };
    lastExitAtMs = Math.max(lastExitAtMs, exited[0].recordedAtMs);
  }
  return { ended: true, lastExitAtMs };
}

export type ReclaimPolicy = Readonly<{ termination: "client_bound" | "provider_bound"; hardDeadlineMs: number | null; skewBoundMs: number }>;
/** 로컬 종료 + (provider_bound면) 증명된 기한 경과. 기한이 없으면 회수 근거가 아니다. TTL은 쓰지 않는다. */
export function evaluateProcessReclaim(events: readonly ProcessGroupEvent[], dispatchAtMs: number, policy: ReclaimPolicy, nowMs: number):
  { reclaimable: true; notBeforeMs: number } | { reclaimable: false; reason: string; notBeforeMs: number | null } {
  const local = evaluateLocalCallEnded(events, dispatchAtMs);
  if (!local.ended) return { reclaimable: false, reason: local.reason, notBeforeMs: null };
  if (policy.termination === "provider_bound" && !policy.hardDeadlineMs) return { reclaimable: false, reason: "provider_deadline_unknown", notBeforeMs: null };
  const notBeforeMs = local.lastExitAtMs + (policy.termination === "provider_bound" ? policy.hardDeadlineMs! : 0) + policy.skewBoundMs;
  return nowMs >= notBeforeMs ? { reclaimable: true, notBeforeMs } : { reclaimable: false, reason: "waiting", notBeforeMs };
}

/** PR15d: owner 가 남긴 게이트웨이 로컬 종료(같은 DB clock 의 기록 시각) + (provider_bound면) 증명된 기한 + skew. TTL 은 쓰지 않는다. */
export function evaluateLocalEndReclaim(endedAtMs: number, policy: ReclaimPolicy, nowMs: number):
  { reclaimable: true; notBeforeMs: number } | { reclaimable: false; reason: string; notBeforeMs: number | null } {
  if (policy.termination === "provider_bound" && !policy.hardDeadlineMs) return { reclaimable: false, reason: "provider_deadline_unknown", notBeforeMs: null };
  const notBeforeMs = endedAtMs + (policy.termination === "provider_bound" ? policy.hardDeadlineMs! : 0) + policy.skewBoundMs;
  return nowMs >= notBeforeMs ? { reclaimable: true, notBeforeMs } : { reclaimable: false, reason: "waiting", notBeforeMs };
}

export type ModelReclaimFacts = Readonly<{ state: "dispatched" | "indeterminate"; dispatchAtMs: number | null; bindingHash: string | null;
  owner: Readonly<{ instanceId: string; bootId: string }>; events: readonly ProcessGroupEvent[];
  localEnd: Readonly<{ endedAtMs: number; owner: Readonly<{ instanceId: string; bootId: string }>; bindingHash: string | null }> | null }>;
export type ModelReclaimJudgement = Readonly<{ status: "reclaimable" | "waiting" | "policy_blocked" | "unproven";
  evidence: "process_group_exit" | "local_call_ended" | null; reason: string | null; notBeforeMs: number | null }>;
/**
 * 행 하나의 회수 판정(보고·실행 공통). 근거가 먼저다: 프로세스 그룹 종료(ESRCH) 또는 indeterminate 행에 같은 owner·binding 이 남긴 로컬 종료.
 * 근거가 없으면 정책과 무관하게 unproven 이다. 근거가 있으면 provider 정책(없으면 provider_bound·기한 미상)으로 기한을 보고, 둘 다 있으면 먼저 오는 쪽을 쓴다.
 */
export function judgeModelReclaim(facts: ModelReclaimFacts, policy: ReclaimPolicy | undefined, nowMs: number): ModelReclaimJudgement {
  const unproven = (reason: string): ModelReclaimJudgement => ({ status: "unproven", evidence: null, reason, notBeforeMs: null });
  if (facts.dispatchAtMs === null) return unproven("dispatch_time_unknown");
  const group = evaluateLocalCallEnded(facts.events, facts.dispatchAtMs), local = facts.localEnd;
  const localReason = !local ? null : facts.state !== "indeterminate" ? "local_end_state_mismatch"
    : local.owner.instanceId !== facts.owner.instanceId || local.owner.bootId !== facts.owner.bootId ? "local_end_owner_mismatch"
      : local.bindingHash !== facts.bindingHash ? "local_end_binding_mismatch" : null;
  const proofs: { evidence: "process_group_exit" | "local_call_ended"; endedAtMs: number }[] = [];
  if (group.ended) proofs.push({ evidence: "process_group_exit", endedAtMs: group.lastExitAtMs });
  if (local && !localReason) proofs.push({ evidence: "local_call_ended", endedAtMs: local.endedAtMs });
  if (!proofs.length) return unproven(localReason ?? (group.ended ? "unknown" : group.reason));
  const rule = policy ?? { termination: "provider_bound" as const, hardDeadlineMs: null, skewBoundMs: 1 };
  const results = proofs.map(proof => ({ evidence: proof.evidence, result: evaluateLocalEndReclaim(proof.endedAtMs, rule, nowMs) }));
  const due = results.filter(item => item.result.notBeforeMs !== null).sort((a, b) => a.result.notBeforeMs! - b.result.notBeforeMs!)[0];
  if (!due) return { status: "policy_blocked", evidence: results[0].evidence, reason: "provider_deadline_unknown", notBeforeMs: null };
  return due.result.reclaimable ? { status: "reclaimable", evidence: due.evidence, reason: null, notBeforeMs: due.result.notBeforeMs }
    : { status: "waiting", evidence: due.evidence, reason: "waiting", notBeforeMs: due.result.notBeforeMs };
}
