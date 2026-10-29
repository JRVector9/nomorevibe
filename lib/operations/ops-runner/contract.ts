import { z } from "zod";

export const opsActionSchema = z.enum(["request-release", "model-restart", "admission-pause", "admission-open"]);
export const opsCommandSchema = z.object({
  action: opsActionSchema,
  targetId: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  reason: z.string().trim().min(1).max(300).regex(/^[^\p{Cc}]+$/u),
  confirmed: z.literal(true),
  // Client UUID makes an uncertain submission safe to repeat without a second operation.
  id: z.uuid(),
}).strict().superRefine((v, ctx) => {
  if (v.action === "request-release" && !z.uuid().safeParse(v.targetId).success)
    ctx.addIssue({ code: "custom", message: "request_id_required" });
  if (v.action.startsWith("admission-") && v.targetId !== "model-capacity")
    ctx.addIssue({ code: "custom", message: "capacity_target_required" });
});
export type OpsCommand = z.infer<typeof opsCommandSchema>;
export const OPS_STEPS = ["prepare", "drain", "stop", "verify-stop", "release", "restore", "verify-restored", "open"] as const;
export type OpsStep = typeof OPS_STEPS[number];
export const OPS_STEP_LABELS: Record<OpsStep, string> = { prepare: "준비·대상 고정", drain: "접수 중지 (DRAIN)", stop: "서비스·모델 종료",
  "verify-stop": "종료 근거 확인", release: "요청 점유 해제", restore: "원래 설정 복원", "verify-restored": "복원 확인", open: "접수 재개 (OPEN)" };
export type OpsState = {
  id: string; action: OpsCommand["action"]; targetId: string; actor: string; reason: string;
  status: "queued" | "running" | "blocked" | "manual" | "completed";
  steps: Partial<Record<OpsStep, "running" | "done" | "blocked" | "manual">>;
  step: OpsStep; code: string | null; profileHash?: string;
};
export function initialOpsState(command: OpsCommand, actor: string): OpsState {
  return { ...command, actor, status: "queued", steps: {}, step: "prepare", code: null };
}

/** A human-only preflight has changed no admission or host state and does not own a physical boundary. */
export const opsHoldsBoundary = (state: OpsState) => state.status !== "completed"
  && !(["manual", "blocked"].includes(state.status) && state.step === "prepare" && !state.steps.drain);
