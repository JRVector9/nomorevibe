import { timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, onReplica } from "@/lib/db";
import { operationsObservations, products } from "@/lib/db/schema";
import { RISING_FRESH_DAYS, RISING_MAX_STARS, risingFreshDays, starGainPerDay } from "@/lib/domain/products/repository";
import { logger } from "@/lib/observability/logger";
import { WEB_FENCED_RETRY_AFTER } from "@/lib/operations/dr/web-gate";
import { PRODUCT_IDENTITY, publicProduct } from "@/lib/social/talk";
import { planXQueryRepositories, type XQueryCandidate } from "@/lib/social/x-query";
import { parseXQueryRequest, xQueryDigest, X_QUERY_KEY, X_QUERY_MAX_BODY_BYTES, type XQueryRequest } from "./x-query";
import { readBody } from "./x-status-receive";
import { xStatusSecrets, X_STATUS_CLOCK_WINDOW_SECONDS, X_STATUS_SIGNATURE_HEADER, X_STATUS_TIMESTAMP_HEADER, type XStatusSecretSlot } from "./x-status";

/**
 * X 검색 저장소 묻기 받기(2026-10-21) — 검사 순서는 하루 보고(x-status-receive)와 같다:
 * 설정 → 크기 → 시각 → 서명 → 형식 → (DR 관문) → 공개 제품 읽기 → 차례 줄 한 줄.
 *
 * 형식까지는 DB 를 보지 않는다. 공개 제품은 복제본에서 읽고(안 되면 주 DB), 관측 표의 x-query 한 줄에 '차례'를 적는다
 * ({v:1, day, after, next}: 그날 차례가 시작한 곳·다음 날 시작할 곳). 같은 날 다시 물으면 같은 곳에서 시작하므로 시험 실행·재실행이
 * 차례를 넘기지 않는다. 그 줄을 쓰므로 쓰기 관문(fenced 사이트면 503)을 지난다 — 수집기는 그때 고정 검색어로 돈다.
 */
export type XQueryVerified = { request: XQueryRequest; sentAt: number; signedWith: XStatusSecretSlot };
type Checked = { ok: true; value: XQueryVerified } | { ok: false; response: Response };

const HEADERS = { "Cache-Control": "private, no-store" };
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...HEADERS, ...headers } });
const refuse = (status: number, error: string): Checked => ({ ok: false, response: reply(status, { error }) });

export async function verifyXQueryRequest(request: Request, nowMs = Date.now()): Promise<Checked> {
  const secrets = xStatusSecrets();
  if (!secrets) return { ok: false, response: new Response(null, { status: 404, headers: HEADERS }) };

  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > X_QUERY_MAX_BODY_BYTES)) return refuse(413, "x_query_body_too_large");
  let raw: Uint8Array;
  try {
    const body = await readBody(request, X_QUERY_MAX_BODY_BYTES);
    if (body === "too_large") return refuse(413, "x_query_body_too_large");
    if (body === "timeout") return refuse(408, "x_query_body_timeout");
    raw = body;
  } catch {
    return refuse(400, "x_query_payload_invalid");
  }

  const stamp = request.headers.get(X_STATUS_TIMESTAMP_HEADER) ?? "";
  const sentAt = Number(stamp);
  if (!/^\d{10}$/.test(stamp) || Math.abs(sentAt - Math.floor(nowMs / 1_000)) > X_STATUS_CLOCK_WINDOW_SECONDS) return refuse(401, "x_query_timestamp_invalid");

  const signature = request.headers.get(X_STATUS_SIGNATURE_HEADER) ?? "";
  if (!/^v1=[a-f0-9]{64}$/.test(signature)) return refuse(401, "x_query_signature_invalid");
  const given = Buffer.from(signature.slice(3), "hex");
  const current = timingSafeEqual(xQueryDigest(secrets.current, sentAt, raw), given);
  const previous = secrets.previous !== null && timingSafeEqual(xQueryDigest(secrets.previous, sentAt, raw), given);
  if (!current && !previous) return refuse(401, "x_query_signature_invalid");

  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return refuse(415, "x_query_json_required");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { return refuse(400, "x_query_payload_invalid"); }
  const parsed = parseXQueryRequest(value, sentAt);
  if (!parsed) return refuse(400, "x_query_payload_invalid");
  return { ok: true, value: { request: parsed, sentAt, signedWith: current ? "current" : "previous" } };
}

/** 정규화한 저장소 주소에서 소문자 owner/repo — github.com 저장소 주소가 아니면 null */
const REPOSITORY = sql<string | null>`substring(${PRODUCT_IDENTITY} from '^https://github[.]com/([a-z0-9-]+/[a-z0-9_.-]+)$')`;

/** 공개 제품(talk.ts 의 publicProduct) 중 GitHub 저장소가 있는 것 — 스타가 느는지는 홈 '지금 뜨는'과 같은 조건(repository.ts) */
export async function xQueryCandidates(): Promise<XQueryCandidate[]> {
  const fresh = await risingFreshDays();
  const days = Number.isSafeInteger(fresh) && fresh > 0 ? fresh : RISING_FRESH_DAYS;
  const rising = sql`${starGainPerDay} > 0 and ${products.stars} < ${RISING_MAX_STARS}
    and ${products.starsAt} > now() - make_interval(days => ${days}::int)`;
  const rows = await db.select({
    id: products.id, repository: REPOSITORY, verifiedAt: products.verifiedAt, createdAt: products.createdAt,
    gain: sql<string | number | null>`case when ${rising} then ${starGainPerDay} end`,
  }).from(products).where(and(publicProduct(), sql`${REPOSITORY} is not null`));
  return rows.flatMap(row => row.repository ? [{
    id: row.id, repository: row.repository, listedAt: (row.verifiedAt ?? row.createdAt).getTime(),
    gain: row.gain === null ? null : Number(row.gain),
  }] : []);
}

type Cursor = { day: string | null; after: number; next: number };
const cursorId = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
function readCursor(value: unknown): Cursor {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { day: typeof row.day === "string" ? row.day : null, after: cursorId(row.after), next: cursorId(row.next) };
}

/** 공개 제품 읽기 → 차례 줄 잠금 → 오늘 목록 → 줄이 바뀌었으면 쓰기. 답은 오늘 날짜와 저장소 목록 */
export async function serveXQuery({ request, signedWith, sentAt }: XQueryVerified): Promise<Response> {
  const candidates = await onReplica(xQueryCandidates);
  const now = Date.now();
  const plan = await db.transaction(async tx => {
    await tx.insert(operationsObservations).values({ key: X_QUERY_KEY, value: { v: 1, day: null, after: 0, next: 0 }, observedAt: sql`(now() at time zone 'utc')` })
      .onConflictDoNothing();
    const [row] = await tx.select({ value: operationsObservations.value }).from(operationsObservations)
      .where(eq(operationsObservations.key, X_QUERY_KEY)).for("update");
    const cursor = readCursor(row?.value);
    // 같은 날이면 그날 시작한 곳에서 다시, 새 날이면 지난 차례가 멈춘 곳 다음부터
    const after = cursor.day === request.day ? cursor.after : cursor.next;
    const planned = planXQueryRepositories(candidates, { now, after });
    if (cursor.day !== request.day || cursor.after !== after || cursor.next !== planned.next) {
      await tx.update(operationsObservations).set({ value: { v: 1, day: request.day, after, next: planned.next }, observedAt: sql`(now() at time zone 'utc')` })
        .where(eq(operationsObservations.key, X_QUERY_KEY));
    }
    return planned;
  });
  logger.info("x_query.served", { day: request.day, repositories: plan.repositories.length, candidates: candidates.length, next: plan.next, signedWith, sentAt });
  return reply(200, { v: 1, day: request.day, repositories: plan.repositories });
}

/** fenced(DR) 사이트 — 차례 줄을 쓰지 않는다. 수집기는 그날 고정 검색어로 돈다 */
export function xQueryUnavailable(): Response {
  return reply(503, { error: "x_query_unavailable" }, { "Retry-After": WEB_FENCED_RETRY_AFTER });
}
