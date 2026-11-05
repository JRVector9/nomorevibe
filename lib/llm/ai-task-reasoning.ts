import type { AiCliTool } from "./ai-tasks";

/** OpenCode variants come only from the actual host catalog; the other adapters retain their existing contracts. */
export function aiTaskReasoningEfforts(task: string, cliTool: AiCliTool | null, model: string, catalogVariants: readonly string[] = []): readonly string[] {
  if (!["first-review", "second-review"].includes(task)) return [];
  if (cliTool === "grok") {
    if (model === "grok-4.7" || model === "grok-4.6") return ["low", "medium", "high", "xhigh"];
    if (model === "grok-4.5") return ["low", "medium", "high"];
    return [];
  }
  if (cliTool === "claude" && /^(opus|sonnet)$|^claude-(opus|sonnet)-(4-[6-9]|[5-9])/.test(model)) return ["low", "medium", "high"];
  if (cliTool === "opencode") return catalogVariants;
  return [];
}
