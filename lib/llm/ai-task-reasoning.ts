import type { AiCliTool } from "./ai-tasks";
import { isCliEngineTask } from "./cli-engine-config";

/**
 * OpenCode variants come only from the actual host catalog; the other adapters retain their existing contracts.
 * Claude CLI: first/second review pass the rank effort as `--effort` (reviewCliArgs). Intro check passes the effort saved for its
 * stage-pool registry key (settings.stageModelEfforts → introCheckEffort, default high) with the same model rule. Publish-classify
 * takes Codex/Claude effort from the connect agent config (its own schema: Codex high·xhigh, Claude high), never from here.
 */
const CLAUDE_EFFORT_MODEL = /^(opus|sonnet)$|^claude-(opus|sonnet)-(4-[6-9]|[5-9])/;
export function aiTaskReasoningEfforts(task: string, cliTool: AiCliTool | null, model: string, catalogVariants: readonly string[] = []): readonly string[] {
  if (["first-review", "second-review"].includes(task)) {
    if (cliTool === "grok") {
      if (model === "grok-4.7" || model === "grok-4.6") return ["low", "medium", "high", "xhigh"];
      if (model === "grok-4.5") return ["low", "medium", "high"];
      return [];
    }
    if (cliTool === "claude" && CLAUDE_EFFORT_MODEL.test(model)) return ["low", "medium", "high"];
    if (cliTool === "opencode") return catalogVariants;
    return [];
  }
  if (task === "product-intro-check" && cliTool === "claude") return CLAUDE_EFFORT_MODEL.test(model) ? ["low", "medium", "high"] : [];
  if (cliTool === "opencode" && (isCliEngineTask(task) || task === "product-intro-check" || task === "product-audit")) return catalogVariants;
  return [];
}
