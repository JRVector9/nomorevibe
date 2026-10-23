import { z } from "zod";
import { assistHash } from "./contracts";
import { repoMoveCandidateSchema } from "@/lib/domain/products/repo-move-review";

export const assistWorkTaskSchema = z.enum(["uptime", "repo_move"]);
export type AssistWorkTask = z.infer<typeof assistWorkTaskSchema>;
export const ASSIST_WORK_STATES = ["queued", "claimed", "waiting_evidence", "waiting_capacity", "retryable_transport", "human", "done", "obsolete", "indeterminate"] as const;
export type AssistWorkState = typeof ASSIST_WORK_STATES[number];
export type AssistControlMode = "off" | "shadow" | "confirm";
export type AssistControl = { task: AssistWorkTask; mode: AssistControlMode; confirmationRequired: boolean;
  dispatchEnabled: boolean; applyEnabled: boolean; revision: number };
export const uptimeCandidateSchema = z.object({
  kind: z.literal("uptime"),
  product: z.object({ id: z.number().int().positive().safe(), slug: z.string().min(1).max(80), url: z.url(), updatedAt: z.string().min(1).max(100) }).strict(),
  health: z.object({ failures: z.number().int().nonnegative().safe(), status: z.number().int().min(0).max(999),
    checkedAt: z.string().min(1).max(100), downSince: z.string().min(1).max(100) }).strict(),
}).strict();
export type UptimeAssistCandidate = Readonly<z.infer<typeof uptimeCandidateSchema>>;
export const assistCandidateSchema = z.union([uptimeCandidateSchema, repoMoveCandidateSchema]);
export type AssistCandidate = Readonly<z.infer<typeof assistCandidateSchema>>;
export function assistCandidateSubject(candidate: AssistCandidate) {
  return candidate.kind === "uptime" ? candidate.product : candidate.snapshot;
}
export function assistCandidateSourceHash(candidate: AssistCandidate): string {
  return assistHash(assistCandidateSchema.parse(candidate));
}

export function assistWorkDisposition(reason: "capacity" | "transport" | "missing_evidence" | "semantic_conflict" | "invalid_output"):
  { state: AssistWorkState; consumesAttempt: boolean; escalate: boolean } {
  switch (reason) {
    case "capacity": return { state: "waiting_capacity", consumesAttempt: false, escalate: false };
    case "transport": return { state: "retryable_transport", consumesAttempt: true, escalate: false };
    case "missing_evidence": return { state: "waiting_evidence", consumesAttempt: false, escalate: false };
    case "semantic_conflict": return { state: "human", consumesAttempt: true, escalate: true };
    case "invalid_output": return { state: "human", consumesAttempt: true, escalate: false };
  }
}
