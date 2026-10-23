import { z } from "zod";
import { assistHash } from "./contracts";
import { repoMoveCandidateSchema } from "@/lib/domain/products/repo-move-review";
import { introRecheckCandidateSchema } from "@/lib/domain/products/intro-assist";
import { actionAuditCandidateSchema } from "@/lib/domain/products/automated-action-audit";
import { newsLocalizationCandidateSchema } from "@/lib/news/localization-work";
import { newsLocalizationSourceHash } from "@/lib/news/localization-contract";

export const assistWorkTaskSchema = z.enum(["uptime", "repo_move", "intro_recheck", "decision_audit", "semantic_exception", "news"]);
export function isAuditAssistTask(task: string): task is "decision_audit" | "semantic_exception" {
  return task === "decision_audit" || task === "semantic_exception";
}
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
  // legacy 내림과 같은 TX에서 만든 shadow에만 붙는다. confirm 적용 권한으로 쓸 수 없다.
  shadowBan: z.object({ auditId: z.number().int().positive().safe(), observedProductUpdatedAt: z.string().min(1).max(100) }).strict().optional(),
}).strict();
export type UptimeAssistCandidate = Readonly<z.infer<typeof uptimeCandidateSchema>>;
// intro의 기존 판정기는 CLI 모듈도 참조한다. 순환 import 중 schema 값을 먼저 캡처하지 않는다.
export const assistCandidateSchema = z.lazy(() => z.union([uptimeCandidateSchema, repoMoveCandidateSchema, introRecheckCandidateSchema, actionAuditCandidateSchema, newsLocalizationCandidateSchema]));
export type AssistCandidate = Readonly<z.infer<typeof assistCandidateSchema>>;
export function assistCandidateSubject(candidate: AssistCandidate) {
  if (candidate.kind === "news") return { id: candidate.news.id, url: candidate.news.url, updatedAt: candidate.news.revision, slug: null };
  if (candidate.kind === "repo_move") return candidate.snapshot;
  if (candidate.kind === "intro_recheck") return candidate.snapshot.product;
  return candidate.product;
}
export function assistCandidateSourceHash(candidate: AssistCandidate): string {
  const parsed = assistCandidateSchema.parse(candidate);
  return parsed.kind === "news" ? newsLocalizationSourceHash(parsed.news) : assistHash(parsed);
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
