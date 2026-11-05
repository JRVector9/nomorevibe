import type { AiCliTool } from "./ai-tasks";

/** Model variants verified from the configured OpenCode v2.2.5 catalog; never infer arbitrary effort values. */
export function aiTaskReasoningEfforts(task: string, cliTool: AiCliTool | null, model: string): readonly string[] {
  if (!["first-review", "second-review"].includes(task)) return [];
  if (cliTool === "grok") return ["minimal", "low", "medium", "high", "xhigh"];
  if (cliTool === "claude" && /^(opus|sonnet)$|^claude-(opus|sonnet)-(4-[6-9]|[5-9])/.test(model)) return ["low", "medium", "high"];
  if (cliTool === "opencode") {
    if (["opencode/deepseek-v4.1-flash", "opencode-go/deepseek-v4.1-flash", "opencode/deepseek-v4.1-flash-free"].includes(model)) return ["low", "high", "max"];
    if (model === "opencode/deepseek-v4-pro") return ["high", "max"];
  }
  return [];
}
