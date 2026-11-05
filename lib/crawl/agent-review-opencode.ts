import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { REVIEW_SYSTEM_PROMPT, type AgentReviewResult } from "./agent-review";
import { validateReviewOutcome, type ReviewInput } from "./agent-review-contract";
import type { CliProcessResult } from "@/lib/llm/cli-process-runner";

/** Existing M3 host CLI, never installed or upgraded by workers. */
export const OPENCODE_HOST_COMMAND = "/opt/homebrew/bin/opencode";
export const OPENCODE_HOST_HOME = "/Users/jr";
export const OPENCODE_REVIEW_AGENT = "nmv-review";
export const OPENCODE_REVIEW_VERSION = "1.19.5";
export function opencodeReviewArgs(model: string, effort?: string): string[] {
  return ["run", "--pure", "--format", "json", "--agent", OPENCODE_REVIEW_AGENT, "--model", model,
    ...(effort ? ["--variant", effort] : [])];
}

/** v1 configuration: deny every tool/MCP operation and prevent auxiliary LLM calls. */
export function opencodeReviewConfig(): string {
  const permission = { "*": "deny" };
  return JSON.stringify({
    permission, plugin: [], mcp: {}, snapshot: false, autoupdate: false, instructions: [],
    compaction: { auto: false, prune: false }, default_agent: OPENCODE_REVIEW_AGENT,
    agent: {
      [OPENCODE_REVIEW_AGENT]: { mode: "primary", steps: 1, permission,
        prompt: `${REVIEW_SYSTEM_PROMPT}\nReturn one JSON object with decision, reason, evidenceIds, confidence. Do not use tools.` },
      title: { disable: true }, summary: { disable: true }, compaction: { disable: true },
    },
  });
}

/** Child commands inherit the original jr auth data home, never the bridge's DB, RPC or startup/config credentials. */
export function opencodeHostEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (source.HOME !== OPENCODE_HOST_HOME) throw new Error("cli_host_identity_mismatch");
  const keys = ["PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
  const env = Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  return { ...env, NODE_ENV: "production", HOME: OPENCODE_HOST_HOME, NO_COLOR: "1", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_PURE: "true" };
}

/**
 * Keep jr's credentials in their existing data directory, while isolating project/user plugins, agents and MCP.
 * v1 scans ~/.opencode even with project config disabled; refuse it rather than changing the user's directory.
 * Its built-in npm bootstrap skips nonwritable config directories, so the isolated profile installs no packages.
 */
const ownedProfiles = new Set<string>();
export async function opencodeReviewProfile(directory: string) {
  const env = opencodeHostEnv(process.env);
  try { await lstat(path.join(OPENCODE_HOST_HOME, ".opencode")); throw new Error("cli_host_user_profile_not_isolated"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const configRoot = path.join(directory, "config"), configDir = path.join(configRoot, "opencode");
  const config = opencodeReviewConfig();
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  ownedProfiles.add(directory);
  await writeFile(path.join(configDir, "opencode.json"), config, { mode: 0o600 });
  await chmod(configDir, 0o500);
  const flags = { OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_AUTOCOMPACT: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true", OPENCODE_CONFIG_CONTENT: config, OPENCODE_PERMISSION: JSON.stringify({ "*": "deny" }) };
  return { command: OPENCODE_HOST_COMMAND,
    env: { ...env, ...flags, XDG_CONFIG_HOME: configRoot,
      XDG_DATA_HOME: env.XDG_DATA_HOME ?? path.join(OPENCODE_HOST_HOME, ".local", "share"),
      XDG_CACHE_HOME: path.join(directory, "cache"), XDG_STATE_HOME: path.join(directory, "state") },
    files: [{ path: path.join("config", "opencode", "opencode.json"), content: config }],
    boundEnvKeys: ["NO_COLOR", "OPENCODE_PURE", "OPENCODE_DISABLE_AUTOUPDATE", ...Object.keys(flags)] };
}
export async function releaseOpencodeReviewProfile(directory: string): Promise<void> {
  if (!ownedProfiles.has(directory)) return;
  await chmod(path.join(directory, "config", "opencode"), 0o700).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  ownedProfiles.delete(directory);
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
      // Include cache and reasoning in the conservative capacity total, rather than counting visible text alone.
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
