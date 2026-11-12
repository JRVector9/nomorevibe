import type { AssistControlView } from "./llm-assist-controls";
import type { SettingsControlView } from "./admin-runtime-settings";

export type UnifiedAssistDraft = Pick<AssistControlView, "mode" | "dispatchEnabled" | "applyEnabled">;
export const unifiedAssistModeLabel = (mode: UnifiedAssistDraft["mode"]) => ({ off: "끔", shadow: "그림자 · 묻고 기록만", confirm: "확인 후 반영" })[mode];
export function unifiedAssistDraft(value: UnifiedAssistDraft): UnifiedAssistDraft {
  return { mode: value.mode, dispatchEnabled: value.mode !== "off" && value.dispatchEnabled,
    applyEnabled: value.mode === "confirm" && value.dispatchEnabled && value.applyEnabled };
}
export function unifiedAssistForm(control: AssistControlView, draft: UnifiedAssistDraft): FormData {
  const form = new FormData(), next = unifiedAssistDraft(draft);
  form.set("task", control.task); form.set("revision", String(control.revision)); form.set("mode", next.mode);
  if (next.dispatchEnabled) form.set("dispatch", "on"); if (next.applyEnabled) form.set("apply", "on");
  return form;
}
/** 기존 실시간 한도의 sparse-patch 필드 규약과 CAS를 그대로 쓴다. 기본값 복원도 같은 저장이다. */
export function unifiedConcurrencyForm(control: SettingsControlView, values: Readonly<Record<string, string>>, resets: Readonly<Record<string, boolean>>): FormData {
  const form = new FormData(); form.set("group", "jobs"); form.set("expectedRevision", String(control.revision ?? ""));
  for (const field of control.fields) {
    form.set(`value:${field.path}`, values[field.path] ?? field.input); form.set(`initial:${field.path}`, field.input);
    form.set(`stored:${field.path}`, field.overridden ? "1" : "0"); if (resets[field.path]) form.set(`reset:${field.path}`, "on");
  }
  return form;
}
