export type XCollectorOptions = {
  stateDir: string;
  live?: boolean;
  useCaseApproved?: boolean;
  token?: string;
  now?: () => number;
  /** 웹과 주고받는 것(검색 저장소 묻기·게시물·하루 상태). 없으면 묻지도 보내지도 않는다 */
  report?: XReportConfig;
};
/** 그날 검색어가 어디서 왔는지(status.json·하루 보고 v2) — 저장소 이름·검색어 글자는 남기지 않는다 */
export type XQueryUse = { source: "products" | "default"; repositories: number; reason: string | null };
export type XCollectorResult = {
  status: "planned" | "blocked" | "completed" | "stopped";
  reason?: string;
  reservedPosts: number;
  requests: number;
  candidates: number;
  query?: XQueryUse;
};
type Candidate = { repository: string; reactions: number | null; postCount: number; skillVerified: false };
type Reports = { posts?: XReportOutcome; status?: XReportOutcome };
/** ours: 그날 검색한 우리 저장소 · webV2: 묻기에 답한 웹 — 보고 v2 를 받는다 */
type QueryChoice = { query: string; use: XQueryUse; ours: string[]; webV2: boolean };

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

const exists = (path: string) => access(path).then(() => true, () => false);

/** 마지막으로 정상 끝난 실행(live completed · dry-run planned)의 시각 */
async function lastSuccess(stateDir: string): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(join(stateDir, "last-success.json"), "utf8")) as { observedAt?: unknown };
    return typeof value.observedAt === "string" && Number.isFinite(Date.parse(value.observedAt)) ? value.observedAt : null;
  } catch { return null; }
}

/**
 * 그날 검색어를 고른다 — 예약 장부보다 먼저(묻기 10초 한 번). 웹이 답한 우리 제품 저장소로 만들고,
 * 묻는 주소가 없거나 묻기가 실패하거나 목록이 비면 고정 검색어(X_COLLECTOR_QUERY)로 돈다 — 그날 읽기를 버리지 않는다.
 * 답을 받은 웹만 보고 v2 를 받는다고 본다. 묻기가 실패한 날은 옛 웹일 수도 있어 v1 로 보낸다.
 */
async function chooseQuery(report: XReportConfig | undefined, day: string, send?: typeof fetch): Promise<QueryChoice> {
  const fallback = (reason: string, webV2 = false): QueryChoice =>
    ({ query: X_COLLECTOR_QUERY, ours: [], webV2, use: { source: "default", repositories: 0, reason } });
  if (!report?.queryUrl) return fallback("not_configured");
  const answer = await requestXQuery(report.queryUrl, report.secret, day, send);
  if (!answer.ok) return fallback(answer.reason);
  const built = xRepositoryQuery(answer.repositories);
  if (!built) return fallback("empty", true);
  return { query: built.query, ours: built.repositories, webV2: true, use: { source: "products", repositories: built.repositories.length, reason: null } };
}

/** 게시물은 실제 수집이 끝났고 보낼 것이 있을 때만, 하루 상태는 매 실행 보낸다 */
async function sendReports(config: XReportConfig, run: { live: boolean; result: XCollectorResult; observed: XObservation[];
  observedAt: string; day: string; stateDir: string; choice: QueryChoice }, send?: typeof fetch): Promise<Reports> {
  const reports: Reports = {};
  if (config.postsUrl && run.live && run.result.status === "completed") {
    const payload = xPostsReportFrom(run.observed, run.observedAt, run.choice.webV2 ? { version: 2, ours: run.choice.ours } : {});
    if (payload.posts.length || payload.unavailable.length) reports.posts = await sendSigned(config.postsUrl, signPosts(config.secret), payload, send);
  }
  if (config.statusUrl) {
    reports.status = await sendSigned(config.statusUrl, signStatus(config.secret), xStatusReportFrom({
      live: run.live, status: run.result.status, reason: run.result.reason, candidates: run.result.candidates,
      reservedToday: await exists(join(run.stateDir, `budget-${run.day}.json`)),
      lastRunAt: run.observedAt, lastSuccessAt: await lastSuccess(run.stateDir),
      ...(run.choice.webV2 ? { query: run.choice.use } : {}),
    }), send);
  }
  return reports;
}

export async function runXCollector(
  options: XCollectorOptions,
  dependencies: { request?: typeof fetch; send?: typeof fetch } = {},
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
    let observed: XObservation[] = [];
    // The day's query comes first: the web's repository list, or the fixed query when that fails.
    let choice = await chooseQuery(options.report, day, dependencies.send);
    const finish = async () => {
      if (result.status === "completed" || result.status === "planned") await writeCurrent(options.stateDir, "last-success.json", { observedAt });
      const reports = options.report
        ? await sendReports(options.report, { live: Boolean(options.live), result, observed, observedAt, day, stateDir: options.stateDir, choice }, dependencies.send)
        : undefined;
      await writeCurrent(options.stateDir, "status.json", { ...result, day, observedAt, service: "oci-osaka-smoke-x", ...(reports ? { reports } : {}) });
      return result;
    };
    // Validate the exact transport settings before making a persistent reservation.
    const planFor = (query: string) => runXPilot({ query, searchOnly: true, sortOrder: X_COLLECTOR_SORT_ORDER }, { now: () => now });
    let plan = await planFor(choice.query);
    if (plan.status !== "planned" && choice.use.source === "products") {
      choice = { ...choice, query: X_COLLECTOR_QUERY, ours: [], use: { source: "default", repositories: 0, reason: "invalid_query" } };
      plan = await planFor(choice.query);
    }
    result.query = choice.use;
    if (plan.status !== "planned") return { ...result, status: "blocked", reason: "invalid_plan" };
    if (!options.live) return await finish();
    const gate = !options.useCaseApproved ? "use_case_not_approved" : !options.token?.trim() ? "bearer_token_missing"
      : /[\s\u007f]/.test(options.token) || options.token.length > 4096 ? "bearer_token_invalid" : null;
    if (gate) { result.status = "blocked"; result.reason = gate; return await finish(); }
    // The repository lookup (10 seconds) and the request (20 seconds) both fit in this last minute;
    // do not let a previous day's reservation cross UTC midnight.
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
      query: choice.query, searchOnly: true, sortOrder: X_COLLECTOR_SORT_ORDER }, { request: dependencies.request, now: () => now });
    result.requests = pilot.requests.length;
    result.status = pilot.status === "completed" ? "completed" : "stopped";
    if (pilot.reason) result.reason = pilot.reason;
    if (result.status === "completed") observed = pilot.observations;
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
import { access, chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runXPilot, type XObservation } from "./x-pilot";
import { xRepositoryQuery } from "./x-query";
import {
  requestXQuery, sendSigned, signPosts, signStatus, xPostsReportFrom, xStatusReportFrom, type XReportConfig, type XReportOutcome,
} from "./x-report";

const DAY = 86_400_000;
/** 고정 검색어 — 웹에 저장소를 묻지 못한 날(주소 없음·실패·빈 목록) 그날 읽기를 버리지 않으려고 쓴다 */
export const X_COLLECTOR_QUERY = 'url:github.com (launch OR launched OR "built with" OR "vibe coding" OR "SKILL.md" OR "agent skill") has:links';
/**
 * 하루 한 번 읽는 10개를 최근 24시간에서 관련도순으로 고른다. 최신순은 막 올라온(반응 0~2) 글만 잡혀
 * 화제 자격(X 50점)에 닿지 못했다(2026-10-20 첫 실제 수집). 관련도 순서의 기준은 X 가 공개하지 않는다.
 */
export const X_COLLECTOR_SORT_ORDER = "relevancy";
