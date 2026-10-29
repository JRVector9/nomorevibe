"use server";
import { z } from "zod";
import { recordAdminAction } from "@/lib/operations/admin-log";
import { currentAdmin } from "@/lib/auth/admin";
import { webWriteAction } from "@/lib/operations/dr/web-gate";
import { opsCommandSchema, type OpsState } from "@/lib/operations/ops-runner/contract";
import { submitModelOpsCommand, readModelOpsState } from "@/lib/operations/ops-runner/repository";

export type OpsActionResult = { state?: OpsState; error?: string };
export const submitAdminModelOperation = webWriteAction(async function submitAdminModelOperation(raw: unknown): Promise<OpsActionResult> {
  const admin = await currentAdmin();
  if (!admin) return { error: "관리자만 모델 작업을 요청할 수 있습니다." };
  const parsed = opsCommandSchema.safeParse(raw);
  if (!parsed.success) {
    await recordAdminAction(admin.login, { action: "ops-runner-rejected", target: "model-capacity", ok: false, error: "command_not_allowlisted_or_unconfirmed" });
    return { error: "허용된 작업·대상·확인·사유를 입력해주세요." };
  }
  try {
    const submitted = await submitModelOpsCommand(parsed.data, admin.login);
    // The append-only row id is the audit number, distinct from the operation UUID.
    const recorded = await readModelOpsState(submitted.id).catch(() => null);
    return { state: recorded ?? submitted };
  }
  catch {
    await recordAdminAction(admin.login, { action: "ops-runner-submission-unconfirmed", target: parsed.data.id, ok: false, error: "submission_unconfirmed" });
    return { error: "요청을 접수하지 못했습니다. 미완료 작업·대상 상태와 감사 기록을 확인해주세요. 같은 작업 ID로 다시 확인할 수 있습니다." }; }
});
export const readAdminModelOperation = webWriteAction(async function readAdminModelOperation(id: string): Promise<OpsActionResult> {
  if (!await currentAdmin()) return { error: "관리자만 진행 상황을 볼 수 있습니다." };
  if (!z.uuid().safeParse(id).success) return { error: "작업 ID가 올바르지 않습니다." };
  try {
    const state = await readModelOpsState(id);
    return state ? { state } : { error: "작업을 찾을 수 없습니다." };
  } catch { return { error: "진행 상황 조회 실패 · 실행 결과를 감사 기록에서 확인해주세요." }; }
});
