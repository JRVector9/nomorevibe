import { REVIEW_SYSTEM_PROMPT, type AgentReviewResult } from "./agent-review";
import { validateReviewOutcome, type ReviewInput } from "./agent-review-contract";
import type { CliProcessResult } from "@/lib/llm/cli-process-runner";

/** Pinned OpenCode v2.2.5: run/noninteractive.ts emits text/step_finish/error JSONL. */
export const OPENCODE_REVIEW_AGENT = "nmv-review";
export const OPENCODE_REVIEW_VERSION = "opencode v2.2.5";
export function opencodeReviewArgs(model: string, effort?: string): string[] {
  return ["run", "--standalone", "--format", "json", "--agent", OPENCODE_REVIEW_AGENT,
    "--model", `${model}${effort ? `#${effort}` : ""}`];
}

/** The image also installs these deny rules as managed /etc/opencode policy. */
export function opencodeReviewConfig(): string {
  const permissions = [{ action: "*", resource: "*", effect: "deny" }];
  return JSON.stringify({
    permissions,
    policies: ["tool.use", "mcp.use", "skill.use", "plugin.use"].map(action => ({ action, resource: "*", effect: "deny" })),
    snapshots: false, warming: false, instructions: [], skills: [],
    agents: {
      [OPENCODE_REVIEW_AGENT]: { mode: "primary", steps: 1, permissions,
        system: `${REVIEW_SYSTEM_PROMPT}\nReturn one JSON object with decision, reason, evidenceIds, confidence. Do not use tools.` },
      title: { disabled: true }, summary: { disabled: true }, compaction: { disabled: true },
    },
  });
}

type Event = Record<string, unknown> & { part?: Record<string, unknown> };
function events(stdout: string): Event[] {
  return stdout.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const event: unknown = JSON.parse(line);
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("invalid_opencode_event");
    return event as Event;
  });
}
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Reconcile can repeat a completed step; never count the same assistant message twice. */
export function opencodeReportedUsage(stdout: string): { inputTokens: number; outputTokens: number; costUsd?: number } | null {
  try {
    const steps = new Map<string, Record<string, unknown>>();
    for (const event of events(stdout)) {
      const part = event.part;
      if (event.type === "step_finish" && part && typeof part.messageID === "string") steps.set(part.messageID, part);
    }
    if (!steps.size) return null;
    let inputTokens = 0, outputTokens = 0, costUsd = 0, hasCost = true;
    for (const part of steps.values()) {
      const tokens = part.tokens as Record<string, unknown> | undefined;
      const cache = tokens?.cache as Record<string, unknown> | undefined;
      if (!tokens || !count(tokens.input) || !count(tokens.output) || !count(tokens.reasoning)
        || !cache || !count(cache.read) || !count(cache.write)) return null;
      // v2 TokenUsage.total includes cached input and reasoning, both excluded from visible input/output.
      inputTokens += tokens.input + cache.read + cache.write; outputTokens += tokens.output + tokens.reasoning;
      if (typeof part.cost === "number" && Number.isFinite(part.cost) && part.cost >= 0) costUsd += part.cost;
      else hasCost = false;
    }
    if (!count(inputTokens) || !count(outputTokens)) return null;
    return { inputTokens, outputTokens, ...(hasCost ? { costUsd } : {}) };
  } catch { return null; }
}

export function opencodeReviewResult(input: ReviewInput, result: CliProcessResult): AgentReviewResult {
  if (result.kind !== "exit") return { ok: false, error: result.kind };
  try {
    const stream = events(result.stdout), usage = opencodeReportedUsage(result.stdout) ?? undefined;
    if (stream.some(event => event.type === "error") || result.code !== 0) {
      const auth = /auth|unauthenticated|not logged in|api.?key/i.test(`${result.stdout}\n${result.stderr}`);
      return { ok: false, error: auth ? "auth" : "cli_error", usage };
    }
    if (stream.some(event => event.type === "tool_use")) return { ok: false, error: "invalid_output", usage };
    const finishAt = stream.findLastIndex(event => event.type === "step_finish");
    const last = stream[finishAt]?.part;
    if (!last || last.reason !== "stop" || typeof last.messageID !== "string"
      || stream.slice(finishAt + 1).some(event => ["step_start", "text", "reasoning"].includes(String(event.type)) && event.part?.messageID !== last.messageID))
      return { ok: false, error: "invalid_output", usage };
    const text = stream.filter(event => event.type === "text" && event.part?.messageID === last.messageID)
      .map(event => typeof event.part?.text === "string" ? event.part.text : "").join("").trim();
    return { ok: true, outcome: validateReviewOutcome(input, JSON.parse(text)), usage: usage ?? {} };
  } catch { return { ok: false, error: result.code === 0 ? "invalid_output" : "cli_error" }; }
}
