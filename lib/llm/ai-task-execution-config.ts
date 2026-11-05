import { z } from "zod";
import { aiTask, AI_TEXT_TASK_IDS } from "./ai-tasks";
import type { AiTaskConnectionSnapshot } from "./ai-task-models-snapshot";

export const AI_TASK_EXECUTION_MODES = ["fallback", "workload_pool"] as const;
export type AiTaskExecutionMode = (typeof AI_TASK_EXECUTION_MODES)[number];
export const AI_TASK_POOL_MEMBER_MAX = 4;
/** Expand only when a real execution adapter consumes the configuration. */
export const AI_TASK_WORKLOAD_POOL_TASKS: readonly string[] = Object.freeze(["first-review", "second-review", ...AI_TEXT_TASK_IDS]);
export const aiTaskSupportsWorkloadPool = (taskId: string, slot = 1): boolean =>
  AI_TASK_WORKLOAD_POOL_TASKS.includes(taskId) && (taskId !== "second-review" || slot === 1);
export const AI_TASK_EXECUTION_SAVE_AUDIT_ACTION = "ai-task-execution-save";
const identity = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value));
export const aiTaskPoolMemberInputSchema = z.object({
  memberId: z.uuid().optional(), connectionId: z.uuid(), model: identity,
  reasoningEffort: z.string().min(1).max(40).optional(),
}).strict();
export const aiTaskExecutionInputSchema = z.object({
  task: z.string().min(1).max(64), slot: z.number().int().min(1).max(8),
  expectedRevision: z.number().int().positive().safe().nullable(),
  mode: z.enum(AI_TASK_EXECUTION_MODES), members: z.array(aiTaskPoolMemberInputSchema).max(AI_TASK_POOL_MEMBER_MAX),
}).strict().superRefine((value, ctx) => {
  const task = aiTask(value.task);
  if (!task || value.slot > task.slots) ctx.addIssue({ code: "custom", message: "ai_task_execution_invalid_task_slot" });
  if (value.mode === "workload_pool" && !aiTaskSupportsWorkloadPool(value.task, value.slot))
    ctx.addIssue({ code: "custom", message: value.task === "second-review" && value.slot !== 1
      ? "ai_task_pool_ai2_single_slot_only" : "ai_task_pool_task_unsupported" });
  if (value.mode === "workload_pool" && value.members.length === 0)
    ctx.addIssue({ code: "custom", message: "ai_task_pool_empty" });
  if (value.mode === "fallback" && value.members.length !== 0)
    ctx.addIssue({ code: "custom", message: "ai_task_fallback_uses_existing_ranks" });
});
export type AiTaskExecutionInput = z.infer<typeof aiTaskExecutionInputSchema>;
export type AiTaskPoolMember = Readonly<{
  memberId: string; position: number; connectionId: string; model: string;
  options: Readonly<Record<string, unknown>>; canonicalModel: string; deviceId: string; engineKey: string;
  /** Current connection, including decrypted credentials in server memory only. Never serialize to UI. */
  connection: AiTaskConnectionSnapshot;
}>;
export type AiTaskExecutionConfig = Readonly<{
  task: string; slot: number; mode: AiTaskExecutionMode; revision: number | null; updatedAt: string | null;
  members: readonly AiTaskPoolMember[];
}>;
/** Observation metadata, not capacity/dispatch authority. Existing dispatch bindings remain unchanged. */
export type AiTaskPoolSelection = Readonly<{
  task: string; slot: number; configRevision: number; memberId: string; position: number;
  policyEpoch: number; policyRevision: number; policyHash: string;
}>;
export type AiTaskWorkloadCandidate = Readonly<{
  memberId: string; routeId: string; connectionId: string; engineModel: string;
  provider: string; identity: string; deviceId: string;
}>;
export type AiTaskWorkloadChoice<T extends AiTaskWorkloadCandidate> = T & Readonly<{ poolSelection: AiTaskPoolSelection }>;

/** Safe numeric/member-ID observation; credentials and endpoint configuration are excluded. */
export type AiTaskPoolRuntime = Readonly<{
  configRevision: number; members: number; served: Readonly<Record<string, number>>;
  unusable: readonly Readonly<{ memberId: string; code: string; count: number }>[];
}>;
