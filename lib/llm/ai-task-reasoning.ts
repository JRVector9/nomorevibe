import type { AiCliTool } from "./ai-tasks";
import { isCliEngineTask } from "./cli-engine-config";

/**
 * OpenCode variants come only from the actual host catalog; the other adapters retain their existing contracts.
 * Claude CLI rank efforts reach the process only on first/second review (reviewCliArgs `--effort`). Intro check pins `--effort high`
 * and reads stage pools, and publish-classify takes Codex/Claude effort from the connect agent config — neither reads rank options,
 * so they offer none here (lib/operations/cli-task-usage.ts shows them read-only). Codex is accepted only by publish-classify.
 */
export function aiTaskReasoningEfforts(task: string, cliTool: AiCliTool | null, model: string, catalogVariants: readonly string[] = []): readonly string[] {
  if (["first-review", "second-review"].includes(task)) {
    if (cliTool === "grok") {
      if (model === "grok-4.7" || model === "grok-4.6") return ["low", "medium", "high", "xhigh"];
      if (model === "grok-4.5") return ["low", "medium", "high"];
      return [];
    }
    if (cliTool === "claude" && /^(opus|sonnet)$|^claude-(opus|sonnet)-(4-[6-9]|[5-9])/.test(model)) return ["low", "medium", "high"];
    if (cliTool === "opencode") return catalogVariants;
    return [];
  }
  if (cliTool === "opencode" && (isCliEngineTask(task) || task === "product-intro-check" || task === "product-audit")) return catalogVariants;
  return [];
}
