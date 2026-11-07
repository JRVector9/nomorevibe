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
/** handoff replaces open only when the reviewed operator profile keeps the runner's own DRAIN for the next declared procedure. */
export type OpsStep = typeof OPS_STEPS[number] | "handoff";
export const OPS_STEP_LABELS: Record<OpsStep, string> = { prepare: "준비·대상 고정", drain: "접수 중지 (DRAIN)", stop: "서비스·모델 종료",
  "verify-stop": "종료 근거 확인", release: "요청 점유 해제", restore: "원래 설정 복원", "verify-restored": "복원 확인", open: "접수 재개 (OPEN)",
  handoff: "DRAIN 유지·다음 절차 인계" };
export type OpsState = {
  id: string; action: OpsCommand["action"]; targetId: string; actor: string; reason: string;
  status: "queued" | "running" | "blocked" | "manual" | "completed" | "cancelled";
  steps: Partial<Record<OpsStep, "running" | "done" | "blocked" | "manual">>;
  step: OpsStep; code: string | null; profileHash?: string; auditId?: number;
  /** Set from the pinned operator profile. "draining" ends with handoff instead of OPEN. */
  finalAdmission?: "draining";
  /** 시작 전 취소(2026-11-07) — 누가 왜. 원래 요청자(actor)는 그대로 둔다. */
  cancelledBy?: string; cancelReason?: string;
};
export function initialOpsState(command: OpsCommand, actor: string): OpsState {
  return { ...command, actor, status: "queued", steps: {}, step: "prepare", code: null };
}

export function opsStepsFor(state: Pick<OpsState, "action" | "finalAdmission">): OpsStep[] {
  if (state.action.startsWith("admission-")) return ["prepare", state.action === "admission-open" ? "open" : "drain"];
  return OPS_STEPS.filter(step => step !== "release" || state.action === "request-release")
    .map(step => step === "open" && state.finalAdmission === "draining" ? "handoff" : step);
}

/** Terminal states: the runner never touches them again. */
export const opsFinished = (state: Pick<OpsState, "status">) => state.status === "completed" || state.status === "cancelled";
/** A human-only preflight has changed no admission or host state and does not own a physical boundary. */
export const opsHoldsBoundary = (state: OpsState) => !opsFinished(state)
  && !(["manual", "blocked"].includes(state.status) && state.step === "prepare" && !state.steps.drain);
/**
 * 시작 전 취소(2026-11-07 운영자 결정) — 운영 실행기가 아직 한 단계도 돌리지 않은 접수(queued · prepare · 단계 기록 없음)만 닫는다.
 * 접수·장비·장부를 바꾼 적이 없으므로 되돌릴 물리 상태가 없다. 한 단계라도 돌았으면 실행기가 끝까지 처리하거나 사람이 본다.
 */
export const opsCancellable = (state: OpsState) => state.status === "queued" && state.step === "prepare" && Object.keys(state.steps).length === 0;
export const opsCancelSchema = z.object({ id: z.uuid(), reason: z.string().trim().min(1).max(300).regex(/^[^\p{Cc}]+$/u) }).strict();
