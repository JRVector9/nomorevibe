"use server";

import type { ModelSaveState } from "@/app/(operator)/admin/models/actions";
import type { ModelProbeResult, ModelOperationResult } from "@/app/(operator)/admin/models/operation-actions";

/** Browser-only fixture, imported by a temporary local preview page. No DB or provider IO. */
export async function previewSave(_previous: ModelSaveState, form: FormData): Promise<ModelSaveState> {
  if (process.env.NODE_ENV !== "development") throw new Error("preview_development_only");
  const model = String(form.get("primaryModel0") ?? "");
  if (model === "conflict") return { issues: ["그 사이 다른 곳에서 설정이 바뀌었습니다. 새로고침해 바뀐 값을 확인한 뒤 다시 저장해주세요."] };
  if (model === "failure") throw new Error("fixture_transport_failed");
  return { ok: true, version: "preview-v2" };
}

export async function previewStageSave(): Promise<ModelSaveState> {
  if (process.env.NODE_ENV !== "development") throw new Error("preview_development_only");
  return { ok: true, version: "preview-v3" };
}
export async function previewProbe(): Promise<ModelProbeResult> {
  if (process.env.NODE_ENV !== "development") throw new Error("preview_development_only");
  return { listed: true, listMs: 17, callBlocked: "로컬 시험 데이터 · 실제 모델 호출 없음" };
}
export async function previewAdmission(): Promise<ModelOperationResult> {
  if (process.env.NODE_ENV !== "development") throw new Error("preview_development_only");
  return { error: "로컬 시험 데이터 · 운영 접수 변경 없음", blocked: ["fixture_only"] };
}
