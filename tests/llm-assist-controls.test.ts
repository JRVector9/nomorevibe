import { describe, expect, it } from "vitest";
import { assistControlInputFromForm, assistControlIssueText, assistTasksOff, assistWorkAiTask, nextAssistControl, type AssistControlRow } from "@/lib/operations/llm-assist-controls";

/** LLM 보강 제어(2026-11-11) — 폼 읽기·바꾼 뒤의 행(DB 규칙과 같은 순수 판정)·작업마다 「보내기 모두 꺼짐」 */
const form = (entries: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(entries)) data.set(key, value); return data; };
const row = (patch: Partial<AssistControlRow> = {}): AssistControlRow => ({ task: "uptime", mode: "off", confirmationRequired: false, dispatchEnabled: false,
  applyEnabled: false, revision: 3, updatedAt: null, ...patch });

describe("LLM 보강 제어", () => {
  it("폼: 보강 일·단계·판이 맞아야 하고, 꺼진(보내지 않은) 체크 칸은 꺼짐이다", () => {
    expect(assistControlInputFromForm(form({ task: "news", mode: "shadow", revision: "4", dispatch: "on" })))
      .toEqual({ issues: [], input: { task: "news", mode: "shadow", expectedRevision: 4, dispatchEnabled: true, applyEnabled: false } });
    expect(assistControlInputFromForm(form({ task: "nope", mode: "loud", revision: "x" })).issues)
      .toEqual(["assist_control_invalid:task", "assist_control_invalid:mode", "assist_control_invalid:revision"]);
    expect(assistControlIssueText("assist_control_invalid:mode")).toBe("단계를 고르세요(끔·그림자·확인 후 반영).");
    expect(assistControlIssueText("weird")).toBe("저장하지 못했습니다(weird).");
  });
  it("바꾼 뒤의 행: 끔에서 보내기·그림자에서 반영은 거절, confirm 은 확인 필수를 켜고 한 번 켜진 확인 필수는 그대로다", () => {
    const input = (patch: Partial<Parameters<typeof nextAssistControl>[1]>) => ({ task: "uptime" as const, expectedRevision: 3, mode: "off" as const,
      dispatchEnabled: false, applyEnabled: false, ...patch });
    expect(nextAssistControl(row(), input({ dispatchEnabled: true })).issues).toEqual(["assist_control_dispatch_needs_mode"]);
    expect(nextAssistControl(row(), input({ mode: "shadow", dispatchEnabled: true, applyEnabled: true })).issues).toEqual(["assist_control_apply_needs_confirm"]);
    expect(nextAssistControl(row(), input({ mode: "confirm", applyEnabled: true })).issues).toEqual(["assist_control_apply_needs_confirm"]);
    expect(nextAssistControl(row(), input({ mode: "confirm", dispatchEnabled: true, applyEnabled: true })))
      .toEqual({ issues: [], row: row({ mode: "confirm", dispatchEnabled: true, applyEnabled: true, confirmationRequired: true }) });
    expect(nextAssistControl(row({ mode: "confirm", confirmationRequired: true, dispatchEnabled: true }), input({ mode: "off" })).row)
      .toMatchObject({ mode: "off", confirmationRequired: true, dispatchEnabled: false });
  });
  it("보강 일 → AI 작업, 작업마다 보내기가 모두 꺼졌나(모르면 null)", () => {
    expect(assistWorkAiTask("uptime")).toBe("assist-review");
    expect(assistWorkAiTask("semantic_exception")).toBe("assist-audit");
    expect(assistWorkAiTask("other")).toBeNull();
    const all = (["uptime", "repo_move", "intro_recheck", "decision_audit", "semantic_exception", "news"] as const).map(task => row({ task }));
    expect(assistTasksOff(all)).toEqual({ "assist-review": true, "assist-audit": true });
    // 그림자 + 보내기 하나면 그 작업은 켜짐, 끔 + 보내기 표시는 켜짐이 아니다
    expect(assistTasksOff(all.map(entry => entry.task === "news" ? { ...entry, mode: "shadow" as const, dispatchEnabled: true } : entry)))
      .toEqual({ "assist-review": false, "assist-audit": true });
    expect(assistTasksOff(all.map(entry => entry.task === "decision_audit" ? { ...entry, dispatchEnabled: true } : entry)))
      .toEqual({ "assist-review": true, "assist-audit": true });
    expect(assistTasksOff(all.filter(entry => entry.task !== "news"))).toEqual({ "assist-review": null, "assist-audit": true });
    expect(assistTasksOff(null)).toEqual({ "assist-review": null, "assist-audit": null });
  });
});
