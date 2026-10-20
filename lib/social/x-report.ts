import { signXPosts, X_POSTS_MAX_POSTS, type XPostsReport } from "@/lib/operations/x-posts";
import { signXStatus, type XStatusReport } from "@/lib/operations/x-status";
import type { XObservation } from "./x-pilot";

/**
 * X 수집기가 웹으로 보내는 두 보고(SNS 화제 C안 T18) — 같은 비밀, 서명 머리만 다르다.
 *
 * - 게시물(/api/ops/x-posts): 저장소 하나를 가리키는 공개 게시물의 ID·작성 시각·저장소·반응 수, 사용 불가 ID
 * - 하루 상태(/api/ops/x-status): 모드·오늘 예약한 읽기·후보 수·마지막 실행·마지막 성공·오류 코드
 *
 * 본문·작성자·토큰·원 응답은 보내지 않는다. 보내기가 실패해도 수집 결과와 예약 장부는 그대로이고 status.json 에만 남긴다.
 */
export type XReportConfig = { secret: string; statusUrl: string | null; postsUrl: string | null };
export type XReportOutcome = number | "timeout" | "network";
export const X_DAILY_READ_LIMIT = 10;
const SEND_TIMEOUT_MS = 10_000;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,47}$/;
const POST_ID = /^[1-9]\d{0,19}$/;

/** 검색 관측을 게시물 보고로 — 저장소 하나·반응 수 네 칸이 모두 있는 공개 글만, 사용 불가는 ID만 */
export function xPostsReportFrom(observations: readonly XObservation[], observedAt: string): XPostsReport {
  const posts: XPostsReport["posts"] = [];
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
    if (item.availability !== "available" || item.linkStatus !== "single" || !createdAt || createdAt > observedAt
      || like === null || reply === null || repost === null || quote === null) continue;
    if (posts.length >= X_POSTS_MAX_POSTS) continue;
    posts.push({ id: item.id, createdAt, repository: item.repositories[0], metrics: { like, reply, repost, quote } });
    seen.add(item.id);
  }
  return { v: 1, observedAt, posts, unavailable };
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
};

/** 하루 상태 보고(docs/operations/2026-10-18-x-status-report-runbook.md 의 채우는 법 그대로) */
export function xStatusReportFrom(input: XStatusInput): XStatusReport {
  const failed = (input.status === "blocked" || input.status === "stopped") && input.reason !== "daily_limit";
  return {
    v: 1, mode: input.live ? "live" : "dry-run",
    reads: { used: input.reservedToday ? X_DAILY_READ_LIMIT : 0, limit: X_DAILY_READ_LIMIT },
    candidates: Math.min(Math.max(0, input.candidates), 1_000),
    lastRunAt: input.lastRunAt, lastSuccessAt: input.lastSuccessAt,
    error: failed ? (input.reason && ERROR_CODE.test(input.reason) ? input.reason : "unknown") : null,
  };
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
    return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "network";
  }
}

export const signPosts = (secret: string) => (timestamp: number, body: string) => signXPosts(secret, timestamp, body);
export const signStatus = (secret: string) => (timestamp: number, body: string) => signXStatus(secret, timestamp, body);
