import { signXPosts, X_POSTS_MAX_POSTS, X_POSTS_MAX_REPOSITORIES, type XPostsReport } from "@/lib/operations/x-posts";
import { parseXQueryResponse, signXQuery, X_QUERY_MAX_RESPONSE_BYTES } from "@/lib/operations/x-query";
import { signXStatus, type XStatusQuery, type XStatusReport } from "@/lib/operations/x-status";
import type { XObservation } from "./x-pilot";

/**
 * X 수집기가 웹과 주고받는 것(SNS 화제 C안 T18) — 같은 비밀, 서명 머리만 다르다.
 *
 * - 검색 저장소 묻기(/api/ops/x-query): 그날 검색할 우리 제품 저장소 목록(2026-10-21). 답을 받은 웹은 아래 두 보고의 v2 도 받는다
 * - 게시물(/api/ops/x-posts): 공개 게시물의 ID·작성 시각·저장소·반응 수, 사용 불가 ID
 * - 하루 상태(/api/ops/x-status): 모드·오늘 예약한 읽기·후보 수·마지막 실행·마지막 성공·오류 코드(v2 는 그날 검색어 출처까지)
 *
 * 본문·작성자·토큰·원 응답은 보내지 않는다. 보내기가 실패해도 수집 결과와 예약 장부는 그대로이고 status.json 에만 남긴다.
 */
export type XReportConfig = { secret: string; statusUrl: string | null; postsUrl: string | null; queryUrl: string | null };
export type XReportOutcome = number | "timeout" | "network";
export const X_DAILY_READ_LIMIT = 10;
const SEND_TIMEOUT_MS = 10_000;
/** 검색 저장소 묻기 — 예약 장부를 만들기 전에 끝나야 하므로 짧게, 한 번만 */
const QUERY_TIMEOUT_MS = 10_000;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,47}$/;
const POST_ID = /^[1-9]\d{0,19}$/;

/**
 * 검색 관측을 게시물 보고로 — 반응 수 네 칸이 모두 있는 공개 글만, 사용 불가는 ID만.
 * v1(옛 웹): 저장소 하나를 가리킨 글만. v2(x-query 에 답한 웹): 저장소가 없거나 여럿인 글도 싣고, 저장소는 그날 검색한 우리 저장소(ours)를 앞에 5곳까지.
 */
export function xPostsReportFrom(observations: readonly XObservation[], observedAt: string,
  options: { version?: 1 | 2; ours?: readonly string[] } = {}): XPostsReport {
  const version = options.version ?? 1;
  const ours = new Set(options.ours ?? []);
  const v1: Extract<XPostsReport, { v: 1 }>["posts"] = [], v2: Extract<XPostsReport, { v: 2 }>["posts"] = [];
  const unavailable: string[] = [];
  const seen = new Set<string>();
  for (const item of observations) {
    if (!POST_ID.test(item.id) || seen.has(item.id)) continue;
    if (item.availability === "unavailable") {
      if (unavailable.length < X_POSTS_MAX_POSTS) { unavailable.push(item.id); seen.add(item.id); }
      continue;
    }
    const { like_count: like, reply_count: reply, retweet_count: repost, quote_count: quote } = item.metrics;
    const createdAt = item.createdAt && Number.isFinite(Date.parse(item.createdAt)) ? new Date(Date.parse(item.createdAt)).toISOString() : null;
    if (item.availability !== "available" || !createdAt || createdAt > observedAt
      || like === null || reply === null || repost === null || quote === null) continue;
    if (v1.length + v2.length >= X_POSTS_MAX_POSTS) continue;
    const metrics = { like, reply, repost, quote };
    if (version === 1) {
      if (item.linkStatus !== "single") continue;
      v1.push({ id: item.id, createdAt, repository: item.repositories[0], metrics });
    } else {
      const repositories = [...item.repositories.filter(key => ours.has(key)), ...item.repositories.filter(key => !ours.has(key))];
      v2.push({ id: item.id, createdAt, repositories: repositories.slice(0, X_POSTS_MAX_REPOSITORIES), metrics });
    }
    seen.add(item.id);
  }
  return version === 1 ? { v: 1, observedAt, posts: v1, unavailable } : { v: 2, observedAt, posts: v2, unavailable };
}

export type XStatusInput = {
  live: boolean;
  status: "planned" | "blocked" | "completed" | "stopped";
  reason?: string;
  candidates: number;
  /** 오늘(UTC) 예약 장부가 있다 — 이번 실행이든 앞선 실행이든 */
  reservedToday: boolean;
  lastRunAt: string;
  lastSuccessAt: string | null;
  /** 그날 검색어 — 있으면 v2(x-query 에 답한 웹에만 보낸다) */
  query?: XStatusQuery;
};

/** 하루 상태 보고(docs/operations/2026-10-18-x-status-report-runbook.md 의 채우는 법 그대로) */
export function xStatusReportFrom(input: XStatusInput): XStatusReport {
  const failed = (input.status === "blocked" || input.status === "stopped") && input.reason !== "daily_limit";
  const fields = {
    mode: input.live ? "live" as const : "dry-run" as const,
    reads: { used: input.reservedToday ? X_DAILY_READ_LIMIT : 0, limit: X_DAILY_READ_LIMIT },
    candidates: Math.min(Math.max(0, input.candidates), 1_000),
    lastRunAt: input.lastRunAt, lastSuccessAt: input.lastSuccessAt,
    error: failed ? (input.reason && ERROR_CODE.test(input.reason) ? input.reason : "unknown") : null,
  };
  if (!input.query) return { v: 1, ...fields };
  const { source, repositories, reason } = input.query;
  return { v: 2, ...fields, query: { source, repositories: Math.min(Math.max(0, repositories), 1_000),
    reason: reason === null ? null : ERROR_CODE.test(reason) ? reason : "unknown" } };
}

/** 서명해 한 번 보낸다(재시도 없음 — 다음 날 다시 보낸다). 응답 상태 코드나 실패 종류만 돌려준다 */
export async function sendSigned(url: string, sign: (timestamp: number, body: string) => string, payload: unknown,
  request: typeof fetch = fetch, now = Date.now): Promise<XReportOutcome> {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(now() / 1_000);
  try {
    const response = await request(url, { method: "POST", body, redirect: "manual", signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      headers: { "content-type": "application/json", "x-nmv-timestamp": String(timestamp), "x-nmv-signature": sign(timestamp, body) } });
    await response.body?.cancel().catch(() => {});
    return response.status;
  } catch (error) {
    return timedOut(error) ? "timeout" : "network";
  }
}

const timedOut = (error: unknown) => error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

export type XQueryAnswer = { ok: true; repositories: string[] } | { ok: false; reason: string };

/**
 * 그날 검색할 저장소를 웹에 묻는다 — 서명한 POST 한 번, 10초(답 본문까지). 재시도는 없다.
 * 실패는 짧은 사유 코드만 돌려준다(timeout·network·http_<코드>·invalid_response). 수집기는 그때 고정 검색어로 돈다.
 */
export async function requestXQuery(url: string, secret: string, day: string, request: typeof fetch = fetch, now = Date.now): Promise<XQueryAnswer> {
  const body = JSON.stringify({ v: 1, day });
  const timestamp = Math.floor(now() / 1_000);
  const signal = AbortSignal.timeout(QUERY_TIMEOUT_MS);
  let response: Response;
  try {
    response = await request(url, { method: "POST", body, redirect: "manual", signal, headers: { "content-type": "application/json",
      accept: "application/json", "x-nmv-timestamp": String(timestamp), "x-nmv-signature": signXQuery(secret, timestamp, body) } });
  } catch (error) {
    return { ok: false, reason: timedOut(error) ? "timeout" : "network" };
  }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => {});
    return { ok: false, reason: Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? `http_${response.status}` : "invalid_response" };
  }
  const reader = response.body?.getReader();
  if (!reader) return { ok: false, reason: "invalid_response" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > X_QUERY_MAX_RESPONSE_BYTES) { void reader.cancel().catch(() => {}); return { ok: false, reason: "invalid_response" }; }
      chunks.push(chunk.value);
    }
    const answer = parseXQueryResponse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))), day);
    return answer ? { ok: true, repositories: answer.repositories } : { ok: false, reason: "invalid_response" };
  } catch (error) {
    return { ok: false, reason: signal.aborted || timedOut(error) ? "timeout" : "invalid_response" };
  }
}

export const signPosts = (secret: string) => (timestamp: number, body: string) => signXPosts(secret, timestamp, body);
export const signStatus = (secret: string) => (timestamp: number, body: string) => signXStatus(secret, timestamp, body);
