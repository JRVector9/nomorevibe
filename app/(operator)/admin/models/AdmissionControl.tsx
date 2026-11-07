"use client";
import type { OpsState } from "@/lib/operations/ops-runner/contract";
import { ModelOpsPanel } from "./ModelOpsPanel";

/**
 * 접수 OPEN/DRAIN — 대시보드 한 곳의 버튼. 기존 운영 실행기 접수(submitAdminModelOperation: admission-pause·admission-open)와
 * 확인 대화상자(사유 입력)·진행 표시(ModelOpsPanel)를 그대로 쓴다. 새 쓰기 경로가 없다.
 */
export function AdmissionControl({ mode, opsStates, readOnly, readable }: {
  mode: "open" | "draining" | "disabled" | null; opsStates: OpsState[]; readOnly: boolean; readable: boolean;
}) {
  return <ModelOpsPanel mode={mode} requests={[]} models={[]} initialStates={opsStates} renderControls={controls =>
    <button type="button" className="button" disabled={readOnly || !readable || controls.disabled || !(mode === "open" || mode === "draining")}
      onClick={() => controls.open(mode === "open" ? "admission-pause" : "admission-open", "model-capacity")}>
      {mode === "draining" ? "OPEN 으로 · 접수 재개" : "DRAIN 으로 · 접수 중지"}</button>} />;
}
