export type XCollectorOptions = {
  stateDir: string;
  live?: boolean;
  useCaseApproved?: boolean;
  token?: string;
  now?: () => number;
};
export type XCollectorResult = {
  status: "planned" | "blocked" | "completed" | "stopped";
  reason?: string;
  reservedPosts: number;
  requests: number;
  candidates: number;
};
type Candidate = { repository: string; reactions: number | null; postCount: number; skillVerified: false };

async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeCurrent(directory: string, name: string, value: unknown) {
  const temporary = join(directory, `.${name}-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await rename(temporary, join(directory, name));
    await syncDirectory(directory);
  } finally { await unlink(temporary).catch(() => {}); }
}

function candidatesFrom(observations: XObservation[]): Candidate[] {
  const candidates = new Map<string, Candidate>();
  for (const observation of observations) {
    if (observation.availability !== "available" || observation.linkStatus !== "single") continue;
    const repository = observation.repositories[0];
    const values = [observation.metrics.like_count, observation.metrics.reply_count,
      observation.metrics.retweet_count, observation.metrics.quote_count];
    const sum = values.every(value => value !== null) ? values.reduce<number>((total, value) => total + value!, 0) : null;
    const reactions = sum !== null && Number.isSafeInteger(sum) ? sum : null;
    const previous = candidates.get(repository);
    if (!previous) candidates.set(repository, { repository, reactions, postCount: 1, skillVerified: false });
    else {
      previous.postCount++;
      const combined = previous.reactions === null || reactions === null ? null : previous.reactions + reactions;
      previous.reactions = combined !== null && Number.isSafeInteger(combined) ? combined : null;
    }
  }
  return [...candidates.values()].sort((a, b) => (b.reactions ?? -1) - (a.reactions ?? -1) || a.repository.localeCompare(b.repository));
}

export async function runXCollector(
  options: XCollectorOptions,
  dependencies: { request?: typeof fetch } = {},
): Promise<XCollectorResult> {
  const result: XCollectorResult = { status: "planned", reservedPosts: 0, requests: 0, candidates: 0 };
  const now = (options.now ?? Date.now)();
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()))
    return { ...result, status: "blocked", reason: "invalid_clock" };
  const observedAt = new Date(now).toISOString();
  const day = observedAt.slice(0, 10);
  try {
    await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
    await chmod(options.stateDir, 0o700);
    const finish = async () => {
      await writeCurrent(options.stateDir, "status.json", { ...result, day, observedAt, service: "oci-osaka-smoke-x" });
      return result;
    };
    // Validate the exact transport settings before making a persistent reservation.
    const plan = await runXPilot({ query: X_COLLECTOR_QUERY, searchOnly: true }, { now: () => now });
    if (plan.status !== "planned") return { ...result, status: "blocked", reason: "invalid_plan" };
    if (!options.live) return await finish();
    const gate = !options.useCaseApproved ? "use_case_not_approved" : !options.token?.trim() ? "bearer_token_missing"
      : /[\s\u007f]/.test(options.token) || options.token.length > 4096 ? "bearer_token_invalid" : null;
    if (gate) { result.status = "blocked"; result.reason = gate; return await finish(); }
    // A request may take 20 seconds; do not let a previous day's reservation cross UTC midnight.
    if (now % DAY >= DAY - 60_000) {
      result.status = "blocked"; result.reason = "day_boundary"; return await finish();
    }
    let receipt;
    try { receipt = await open(join(options.stateDir, `budget-${day}.json`), "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      result.status = "blocked"; result.reason = "daily_limit"; return await finish();
    }
    // Never remove or refund this receipt, including after a failed/aborted request or partial write.
    result.reservedPosts = 10;
    try {
      await receipt.writeFile(`${JSON.stringify({ day, reservedPosts: 10, observedAt })}\n`);
      await receipt.sync();
    } finally { await receipt.close(); }
    await syncDirectory(options.stateDir);
    const pilot = await runXPilot({ live: true, useCaseApproved: true, token: options.token,
      query: X_COLLECTOR_QUERY, searchOnly: true }, { request: dependencies.request, now: () => now });
    result.requests = pilot.requests.length;
    result.status = pilot.status === "completed" ? "completed" : "stopped";
    if (pilot.reason) result.reason = pilot.reason;
    const candidates = result.status === "completed" ? candidatesFrom(pilot.observations) : [];
    result.candidates = candidates.length;
    // A single private snapshot; post text, authors, and raw provider bodies never reach disk.
    await writeCurrent(options.stateDir, "observations.json", { observedAt,
      expiresAt: new Date(now + DAY).toISOString(), candidates });
    return await finish();
  } catch {
    return { ...result, status: "stopped", reason: "state_error" };
  }
}
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runXPilot, type XObservation } from "./x-pilot";

const DAY = 86_400_000;
export const X_COLLECTOR_QUERY = 'url:github.com (launch OR launched OR "built with" OR "vibe coding" OR "SKILL.md" OR "agent skill") has:links';
