import { timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { operationsObservations } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { WEB_FENCED_RETRY_AFTER } from "@/lib/operations/dr/web-gate";
import {
  completedLiveRun, nextXStatusRuns, parseXStatusReport, parseXStatusRuns, xStatusDigest, xStatusSecrets, X_STATUS_CLOCK_WINDOW_SECONDS, X_STATUS_KEY,
  X_STATUS_MAX_BODY_BYTES, X_STATUS_MIN_INTERVAL_SECONDS, X_STATUS_RUNS_KEY, X_STATUS_SIGNATURE_HEADER, X_STATUS_TIMESTAMP_HEADER,
  type XStatusReport, type XStatusSecretSlot,
} from "./x-status";

/**
 * X 수집기 보고 받기(운영센터 v8 PR9) — 검사 순서: 설정 → 크기 → 시각 → 서명 → 형식 → (DR 관문) → 단조 → 속도 → 한 줄 쓰기.
 *
 * 형식까지는 DB 를 보지 않는다. 그 뒤 거절(단조·속도)은 읽기만 하고, 받은 보고만 x-status 한 줄을 조건부 upsert 한다
 * (주 DB 새 부하 = 받은 보고마다 작은 쓰기 하나). 속도 제한은 같은 줄의 DB 받은 시각으로 재므로 rate_limits 줄을 따로 쓰지 않는다.
 */
export type XStatusVerified = { report: XStatusReport; sentAt: number; signedWith: XStatusSecretSlot };
type Checked = { ok: true; value: XStatusVerified } | { ok: false; response: Response };

const HEADERS = { "Cache-Control": "private, no-store" };
const BODY_TIMEOUT_MS = 5_000;
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...HEADERS, ...headers } });
const refuse = (status: number, error: string): Checked => ({ ok: false, response: reply(status, { error }) });

/** max 바이트(보고 4KB)까지만 읽는다 — 넘으면 "too_large", 5초 안에 다 오지 않으면 "timeout". X 게시물 보고(x-posts-receive)도 쓴다 */
export async function readBody(request: Request, max = X_STATUS_MAX_BODY_BYTES): Promise<Uint8Array | "too_large" | "timeout"> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), BODY_TIMEOUT_MS); });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === "timeout") { void reader.cancel().catch(() => {}); return "timeout"; }
      if (next.done) return Buffer.concat(chunks, size);
      size += next.value.byteLength;
      if (size > max) { void reader.cancel().catch(() => {}); return "too_large"; }
      chunks.push(next.value);
    }
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

export async function verifyXStatusRequest(request: Request, nowMs = Date.now()): Promise<Checked> {
  const secrets = xStatusSecrets();
  // 꺼진 주소는 없는 주소와 같다 — 본문을 읽지 않고, DB·로그도 남기지 않는다
  if (!secrets) return { ok: false, response: new Response(null, { status: 404, headers: HEADERS }) };

  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > X_STATUS_MAX_BODY_BYTES)) return refuse(413, "x_status_body_too_large");
  let raw: Uint8Array;
  try {
    const body = await readBody(request);
    if (body === "too_large") return refuse(413, "x_status_body_too_large");
    if (body === "timeout") return refuse(408, "x_status_body_timeout");
    raw = body;
  } catch {
    return refuse(400, "x_status_payload_invalid");
  }

  const stamp = request.headers.get(X_STATUS_TIMESTAMP_HEADER) ?? "";
  const sentAt = Number(stamp);
  if (!/^\d{10}$/.test(stamp) || Math.abs(sentAt - Math.floor(nowMs / 1_000)) > X_STATUS_CLOCK_WINDOW_SECONDS) return refuse(401, "x_status_timestamp_invalid");

  const signature = request.headers.get(X_STATUS_SIGNATURE_HEADER) ?? "";
  if (!/^v1=[a-f0-9]{64}$/.test(signature)) return refuse(401, "x_status_signature_invalid");
  const given = Buffer.from(signature.slice(3), "hex");
  // 두 비밀을 늘 함께 견준다(상수 시간 비교) — 어느 쪽이 맞았는지는 저장해 교체 확인에 쓴다
  const current = timingSafeEqual(xStatusDigest(secrets.current, sentAt, raw), given);
  const previous = secrets.previous !== null && timingSafeEqual(xStatusDigest(secrets.previous, sentAt, raw), given);
  if (!current && !previous) return refuse(401, "x_status_signature_invalid");

  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return refuse(415, "x_status_json_required");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { return refuse(400, "x_status_payload_invalid"); }
  const report = parseXStatusReport(value, sentAt);
  if (!report) return refuse(400, "x_status_payload_invalid");
  return { ok: true, value: { report, sentAt, signedWith: current ? "current" : "previous" } };
}

const storedSentAt = sql`case when ${operationsObservations.value}->>'sentAt' ~ '^[0-9]{1,15}$' then (${operationsObservations.value}->>'sentAt')::bigint else 0 end`;
/** DB 시계(UTC 벽시계) — 관측 표 시각 열은 시간대가 없다 */
const dbNow = sql`(now() at time zone 'utc')`;
const minInterval = sql`make_interval(secs => ${X_STATUS_MIN_INTERVAL_SECONDS})`;

/** 단조(저장된 것보다 새것만) → 속도(마지막으로 받은 지 60초) → 한 줄 쓰기. 거절은 읽기만 한다 */
export async function recordXStatus({ report, sentAt, signedWith }: XStatusVerified): Promise<"accepted" | "not_newer" | "rate_limited"> {
  const [stored] = await db.select({ sentAt: storedSentAt.mapWith(Number),
    recent: sql<boolean>`${operationsObservations.observedAt} > ${dbNow} - ${minInterval}` })
    .from(operationsObservations).where(eq(operationsObservations.key, X_STATUS_KEY));
  if (stored && stored.sentAt >= sentAt) return "not_newer";
  if (stored?.recent) return "rate_limited";
  const value = { ...report, sentAt, signedWith };
  // 쓰기 TX — 웹 관문 범위라 fence SHARE 가 첫 lock 이다. 같은 조건을 다시 걸어 동시에 온 보고 중 하나만 쓴다
  const written = await db.transaction(async (tx) => {
    const rows = await tx.insert(operationsObservations).values({ key: X_STATUS_KEY, value, observedAt: dbNow })
      .onConflictDoUpdate({ target: operationsObservations.key, set: { value, observedAt: dbNow },
        setWhere: sql`${storedSentAt} < ${sentAt} and ${operationsObservations.observedAt} <= ${dbNow} - ${minInterval}` })
      .returning({ key: operationsObservations.key });
    // 끝난 실제 수집이면 후보 기록(x-status:runs)을 같은 TX 에서 고친다 — 이틀째 후보 0 을 알려면 지난 날이 필요하다
    if (rows.length && completedLiveRun(report)) {
      const [prior] = await tx.select({ value: operationsObservations.value }).from(operationsObservations)
        .where(eq(operationsObservations.key, X_STATUS_RUNS_KEY)).for("update");
      const next = nextXStatusRuns(parseXStatusRuns(prior?.value), report);
      if (next) await tx.insert(operationsObservations).values({ key: X_STATUS_RUNS_KEY, value: next, observedAt: dbNow })
        .onConflictDoUpdate({ target: operationsObservations.key, set: { value: next, observedAt: dbNow } });
    }
    return rows;
  });
  return written.length > 0 ? "accepted" : "not_newer";
}

export async function writeXStatus(verified: XStatusVerified): Promise<Response> {
  const result = await recordXStatus(verified);
  const fields = { mode: verified.report.mode, error: verified.report.error, signedWith: verified.signedWith, sentAt: verified.sentAt };
  if (result === "accepted") {
    logger.info("x_status.accepted", fields);
    return reply(200, { accepted: true });
  }
  logger.warn("x_status.refused", { ...fields, reason: result });
  return result === "rate_limited"
    ? reply(429, { error: "x_status_rate_limited" }, { "Retry-After": String(X_STATUS_MIN_INTERVAL_SECONDS) })
    : reply(409, { error: "x_status_not_newer" });
}

/** fenced(DR) 사이트 — 쓰기 전에 거절한다. 수집기는 다음 날 다시 보낸다 */
export function xStatusUnavailable(): Response {
  return reply(503, { error: "x_status_unavailable" }, { "Retry-After": WEB_FENCED_RETRY_AFTER });
}
