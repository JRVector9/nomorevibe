export type XCollectorOptions = {
  stateDir: string;
  live?: boolean;
  useCaseApproved?: boolean;
  token?: string;
  now?: () => number;
  /** 웹으로 보내는 보고(게시물·하루 상태). 없으면 보내지 않는다 */
  report?: XReportConfig;
};
export type XCollectorResult = {
  status: "planned" | "blocked" | "completed" | "stopped";
  reason?: string;
  reservedPosts: number;
  requests: number;
  candidates: number;
  /** 그날 검색어(status.json·실행 결과·하루 보고 v3) — 출처와 좋아요 하한. 검색어 글자는 남기지 않는다 */
  query: XStatusQuery;
  /** X 검색 응답의 HTTP 상태 — http_error 로 멈춘 날 400(연산자·검색어 거절)과 429·5xx 를 가른다 */
  httpStatus?: number;
};
type Candidate = { repository: string; reactions: number | null; postCount: number; skillVerified: false };
/** statusV1: 하루 보고 v3 가 400 이라 검색어 칸 없는 v1 로 다시 보낸 결과(v3 를 모르는 웹) */
type Reports = { posts?: XReportOutcome; status?: XReportOutcome; statusV1?: XReportOutcome };

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
 * 게시물은 실제 수집이 끝났고 보낼 것이 있을 때만, 하루 상태는 매 실행 보낸다.
 * 하루 상태는 검색어 칸이 있는 v3 로 보내고, v3 를 모르는 웹(#590 까지)이 400 으로 답하면 그때만 v1 로 한 번 더 보낸다 —
 * 형식을 맞추는 것이지 실패를 되풀이하는 재시도가 아니다(400 은 웹이 DB 를 보기 전에 거절해 단조·속도 줄을 남기지 않는다).
 */
async function sendReports(config: XReportConfig, run: { live: boolean; result: XCollectorResult; observed: XObservation[];
  observedAt: string; day: string; stateDir: string }, send?: typeof fetch): Promise<Reports> {
  const reports: Reports = {};
  if (config.postsUrl && run.live && run.result.status === "completed") {
    const payload = xPostsReportFrom(run.observed, run.observedAt);
    if (payload.posts.length || payload.unavailable.length) reports.posts = await sendSigned(config.postsUrl, signPosts(config.secret), payload, send);
  }
  if (config.statusUrl) {
    const input = {
      live: run.live, status: run.result.status, reason: run.result.reason, candidates: run.result.candidates,
      reservedToday: await exists(join(run.stateDir, `budget-${run.day}.json`)),
      lastRunAt: run.observedAt, lastSuccessAt: await lastSuccess(run.stateDir),
    };
    reports.status = await sendSigned(config.statusUrl, signStatus(config.secret), xStatusReportFrom({ ...input, query: run.result.query }), send);
    if (reports.status === 400) reports.statusV1 = await sendSigned(config.statusUrl, signStatus(config.secret), xStatusReportFrom(input), send);
  }
  return reports;
}

export async function runXCollector(
  options: XCollectorOptions,
  dependencies: { request?: typeof fetch; send?: typeof fetch } = {},
): Promise<XCollectorResult> {
  const result: XCollectorResult = { status: "planned", reservedPosts: 0, requests: 0, candidates: 0,
    query: { source: "popular", minLikes: X_COLLECTOR_MIN_LIKES } };
  const now = (options.now ?? Date.now)();
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()))
    return { ...result, status: "blocked", reason: "invalid_clock" };
  const observedAt = new Date(now).toISOString();
  const day = observedAt.slice(0, 10);
  try {
    await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
    await chmod(options.stateDir, 0o700);
    let observed: XObservation[] = [];
    const finish = async () => {
      if (result.status === "completed" || result.status === "planned") await writeCurrent(options.stateDir, "last-success.json", { observedAt });
      const reports = options.report
        ? await sendReports(options.report, { live: Boolean(options.live), result, observed, observedAt, day, stateDir: options.stateDir }, dependencies.send)
        : undefined;
      await writeCurrent(options.stateDir, "status.json", { ...result, day, observedAt, service: "oci-osaka-smoke-x", ...(reports ? { reports } : {}) });
      return result;
    };
    // Validate the exact transport settings before making a persistent reservation.
    const plan = await runXPilot({ query: X_COLLECTOR_QUERY, searchOnly: true, sortOrder: X_COLLECTOR_SORT_ORDER }, { now: () => now });
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
      query: X_COLLECTOR_QUERY, searchOnly: true, sortOrder: X_COLLECTOR_SORT_ORDER }, { request: dependencies.request, now: () => now });
    result.requests = pilot.requests.length;
    const httpStatus = pilot.requests[0]?.status;
    if (typeof httpStatus === "number") result.httpStatus = httpStatus;
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
import type { XStatusQuery } from "@/lib/operations/x-status";
import { runXPilot, type XObservation } from "./x-pilot";
import { sendSigned, signPosts, signStatus, xPostsReportFrom, xStatusReportFrom, type XReportConfig, type XReportOutcome } from "./x-report";

const DAY = 86_400_000;
/**
 * 검색어의 좋아요 하한 — 이미 많이 퍼진 글만 읽는다(2026-10-22 사용자 지시 "GitHub 주소가 있고 많이 커진 글만").
 * 공개 /talk 의 X 자격(좋아요 + 재게시×2 ≥ 50, lib/social/talk-score.ts)과 같은 50 에서 시작한다 — 좋아요만 50 이상이면 자격은 늘 넘는다.
 * 재게시가 많고 좋아요가 50 아래인 글은 빠진다. 실제 분포를 보고 다시 정한다.
 */
export const X_COLLECTOR_MIN_LIKES = 50;
/**
 * 하루 한 번 보내는 검색어 — GitHub 주소가 있고 좋아요가 하한 이상인 글. runXPilot 이 `(…) -is:retweet` 으로 감싼다.
 * min_likes: 는 docs.x.com 연산자 표의 참여 연산자(음이 아닌 정수, recent search 에서 쓴다)다. 웹 검색의 min_faves:·min_retweets: 는 API 에서 400 이다.
 * 우리 요금제에서 받아지는지는 문서에 없다 — 첫 실제 실행의 httpStatus 로 본다(400 이면 거절).
 * 앞선 검색어: 고정 낱말(`launch OR … has:links`, 관련도순 10-21 최고 35점·50점 0건) → 웹이 골라 준 우리 제품 저장소(#590) → 이것.
 */
export const X_COLLECTOR_QUERY = `url:github.com min_likes:${X_COLLECTOR_MIN_LIKES}`;
/**
 * 하루 한 번 읽는 10개를 최근 24시간에서 관련도순으로 고른다. 최신순은 막 올라온(반응 0~2) 글만 잡혀
 * 화제 자격(X 50점)에 닿지 못했다(2026-10-20 첫 실제 수집). 관련도 순서의 기준은 X 가 공개하지 않는다.
 */
export const X_COLLECTOR_SORT_ORDER = "relevancy";
