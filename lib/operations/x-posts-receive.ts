import { timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { operationsObservations } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { WEB_FENCED_RETRY_AFTER } from "@/lib/operations/dr/web-gate";
import { markSocialPostsGoneByExternalId, writeSocialPosts, type SocialPostInput } from "@/lib/social/repository";
import { publicRepositoryKeys } from "@/lib/social/talk";
import { parseXPostsReport, xPoints, xPostsDigest, X_POSTS_KEY, X_POSTS_MAX_BODY_BYTES, type XPostsReport } from "./x-posts";
import { readBody } from "./x-status-receive";
import {
  xStatusSecrets, X_STATUS_CLOCK_WINDOW_SECONDS, X_STATUS_MIN_INTERVAL_SECONDS, X_STATUS_SIGNATURE_HEADER, X_STATUS_TIMESTAMP_HEADER,
  type XStatusSecretSlot,
} from "./x-status";

/**
 * X 게시물 보고 받기(SNS 화제 C안 T18) — 검사 순서는 하루 보고(x-status-receive)와 같다:
 * 설정 → 크기 → 시각 → 서명 → 형식 → (DR 관문) → 단조 → 속도 → 쓰기.
 *
 * 쓰기는 한 트랜잭션이다 — 단조·속도용 관측 한 줄(x-posts)과 social_posts(source=x)·관측, 사용 불가 글 내리기.
 * 그래서 쓰다 실패하면 관측 줄도 남지 않고, 수집기가 같은 보고를 다시 보낼 수 있다.
 */
export type XPostsVerified = { report: XPostsReport; sentAt: number; signedWith: XStatusSecretSlot };
type Checked = { ok: true; value: XPostsVerified } | { ok: false; response: Response };

const HEADERS = { "Cache-Control": "private, no-store" };
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...HEADERS, ...headers } });
const refuse = (status: number, error: string): Checked => ({ ok: false, response: reply(status, { error }) });

export async function verifyXPostsRequest(request: Request, nowMs = Date.now()): Promise<Checked> {
  const secrets = xStatusSecrets();
  if (!secrets) return { ok: false, response: new Response(null, { status: 404, headers: HEADERS }) };

  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > X_POSTS_MAX_BODY_BYTES)) return refuse(413, "x_posts_body_too_large");
  let raw: Uint8Array;
  try {
    const body = await readBody(request, X_POSTS_MAX_BODY_BYTES);
    if (body === "too_large") return refuse(413, "x_posts_body_too_large");
    if (body === "timeout") return refuse(408, "x_posts_body_timeout");
    raw = body;
  } catch {
    return refuse(400, "x_posts_payload_invalid");
  }

  const stamp = request.headers.get(X_STATUS_TIMESTAMP_HEADER) ?? "";
  const sentAt = Number(stamp);
  if (!/^\d{10}$/.test(stamp) || Math.abs(sentAt - Math.floor(nowMs / 1_000)) > X_STATUS_CLOCK_WINDOW_SECONDS) return refuse(401, "x_posts_timestamp_invalid");

  const signature = request.headers.get(X_STATUS_SIGNATURE_HEADER) ?? "";
  if (!/^v1=[a-f0-9]{64}$/.test(signature)) return refuse(401, "x_posts_signature_invalid");
  const given = Buffer.from(signature.slice(3), "hex");
  const current = timingSafeEqual(xPostsDigest(secrets.current, sentAt, raw), given);
  const previous = secrets.previous !== null && timingSafeEqual(xPostsDigest(secrets.previous, sentAt, raw), given);
  if (!current && !previous) return refuse(401, "x_posts_signature_invalid");

  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return refuse(415, "x_posts_json_required");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { return refuse(400, "x_posts_payload_invalid"); }
  const report = parseXPostsReport(value, sentAt);
  if (!report) return refuse(400, "x_posts_payload_invalid");
  return { ok: true, value: { report, sentAt, signedWith: current ? "current" : "previous" } };
}

/**
 * 보고의 게시물을 우리 글 모양으로 — 본문이 없으므로 제목은 비우고, 화면은 출처가 x 면 'X 게시물'로 그린다.
 *
 * - 저장소 하나: 그 저장소 글(repo). v1 은 모두 이것이다.
 * - 저장소 여럿(v2): 보낸 순서에서 처음 나오는 공개 제품의 저장소 글(repo) — 그 제품을 정말 가리킨 글이다.
 *   공개 제품이 하나도 없으면 site 글(저장소 열쇠 없음, 링크는 첫 저장소).
 * - 저장소 없음(v2): site 글, 링크는 X 게시물 주소.
 *
 * site 글은 공개 화면(/talk·홈·상세·'아직 공개 제품이 아닌 저장소' 수)에 오르지 않는다 — 공개 읽기는 저장소 열쇠로 제품을 찾고(talk.ts),
 * 순위는 repo·path 글만 센다. 관리자 /admin/talk 에는 다른 글처럼 보인다(검색이 돌려준 글을 버리지 않는다).
 */
export function xSocialPosts(report: XPostsReport, publicKeys: ReadonlySet<string> = new Set()): SocialPostInput[] {
  const posts = report.v === 1 ? report.posts.map(({ repository, ...post }) => ({ ...post, repositories: [repository] })) : report.posts;
  return posts.map(post => {
    const base = { externalId: post.id, kind: "link" as const, title: "", postedAt: new Date(post.createdAt), frontPage: false, ...xPoints(post.metrics) };
    const repository = post.repositories.length === 1 ? post.repositories[0] : post.repositories.find(item => publicKeys.has(item.toLowerCase()));
    if (repository) return { ...base, linkUrl: `https://github.com/${repository}`, linkTarget: "repo" as const, repositoryKey: repository.toLowerCase() };
    const linkUrl = post.repositories.length ? `https://github.com/${post.repositories[0]}` : `https://x.com/i/web/status/${post.id}`;
    return { ...base, linkUrl, linkTarget: "site" as const, repositoryKey: null };
  });
}

/** 여러 저장소를 가리킨 v2 글의 저장소 열쇠 — 공개 제품인지 DB 에 물을 것 */
const ambiguousKeys = (report: XPostsReport) => report.v === 1 ? []
  : [...new Set(report.posts.filter(post => post.repositories.length > 1).flatMap(post => post.repositories.map(item => item.toLowerCase())))];

const storedSentAt = sql`case when ${operationsObservations.value}->>'sentAt' ~ '^[0-9]{1,15}$' then (${operationsObservations.value}->>'sentAt')::bigint else 0 end`;
const dbNow = sql`(now() at time zone 'utc')`;
const minInterval = sql`make_interval(secs => ${X_STATUS_MIN_INTERVAL_SECONDS})`;

export type XPostsResult = { result: "accepted"; inserted: number; updated: number; gone: number } | { result: "not_newer" | "rate_limited" };

/** 단조(저장된 것보다 새것만) → 속도(마지막으로 받은 지 60초) → 한 트랜잭션에 관측 줄·글·내리기 */
export async function recordXPosts({ report, sentAt, signedWith }: XPostsVerified): Promise<XPostsResult> {
  const [stored] = await db.select({ sentAt: storedSentAt.mapWith(Number),
    recent: sql<boolean>`${operationsObservations.observedAt} > ${dbNow} - ${minInterval}` })
    .from(operationsObservations).where(eq(operationsObservations.key, X_POSTS_KEY));
  if (stored && stored.sentAt >= sentAt) return { result: "not_newer" };
  if (stored?.recent) return { result: "rate_limited" };
  const value = { v: 1, sentAt, signedWith, observedAt: report.observedAt, posts: report.posts.length, unavailable: report.unavailable.length };
  const observedAt = new Date(report.observedAt);
  return db.transaction(async tx => {
    const claimed = await tx.insert(operationsObservations).values({ key: X_POSTS_KEY, value, observedAt: dbNow })
      .onConflictDoUpdate({ target: operationsObservations.key, set: { value, observedAt: dbNow },
        setWhere: sql`${storedSentAt} < ${sentAt} and ${operationsObservations.observedAt} <= ${dbNow} - ${minInterval}` })
      .returning({ key: operationsObservations.key });
    // 동시에 온 같은 보고 중 진 쪽은 아무것도 쓰지 않는다
    if (!claimed.length) return { result: "not_newer" as const };
    const keys = ambiguousKeys(report);
    const written = await writeSocialPosts(tx, "x", xSocialPosts(report, keys.length ? await publicRepositoryKeys(tx, keys) : undefined), observedAt);
    const gone = await markSocialPostsGoneByExternalId(tx, "x", report.unavailable, observedAt);
    return { result: "accepted" as const, inserted: written.inserted, updated: written.updated, gone };
  });
}

export async function writeXPosts(verified: XPostsVerified): Promise<Response> {
  const outcome = await recordXPosts(verified);
  const fields = { v: verified.report.v, posts: verified.report.posts.length, unavailable: verified.report.unavailable.length,
    signedWith: verified.signedWith, sentAt: verified.sentAt };
  if (outcome.result === "accepted") {
    logger.info("x_posts.accepted", { ...fields, inserted: outcome.inserted, updated: outcome.updated, gone: outcome.gone });
    return reply(200, { accepted: true, inserted: outcome.inserted, updated: outcome.updated, gone: outcome.gone });
  }
  logger.warn("x_posts.refused", { ...fields, reason: outcome.result });
  return outcome.result === "rate_limited"
    ? reply(429, { error: "x_posts_rate_limited" }, { "Retry-After": String(X_STATUS_MIN_INTERVAL_SECONDS) })
    : reply(409, { error: "x_posts_not_newer" });
}

/** fenced(DR) 사이트 — 쓰기 전에 거절한다. 수집기는 다음 날 다시 보낸다 */
export function xPostsUnavailable(): Response {
  return reply(503, { error: "x_posts_unavailable" }, { "Retry-After": WEB_FENCED_RETRY_AFTER });
}
