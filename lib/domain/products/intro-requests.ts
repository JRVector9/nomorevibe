import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { introCorrectionRequests, products, productSearchProfiles } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { type Result, ok, fail } from "./errors";
import { lockProductGeneration } from "./generation";
import { LIMITS } from "./limits";
import * as repo from "./repository";
import { introRequestMessage, type IntroRequestEntry } from "./takedown-view";
import { isUnclaimed } from "./view";

/**
 * 소개 수정 요청(2026-10-08 UX 감사 UX-18).
 *
 * 주인 없는 제품의 운영자가 한 줄 소개를 고쳐 달라고 한다. 설치형은 도메인이 없어 명령으로 소유를 확인할 수 없으니,
 * 이것이 소개를 바로잡을 유일한 길이다.
 *
 * 내려달라는 요청(takedown.ts)과 표가 다르다 — 그쪽은 들어오는 즉시 상세를 noindex 로 바꾸고 CDN 지우기를 적는다.
 * 소개를 고쳐 달라는 말에 검색 노출을 멈추면 안 되므로 여기서는 그 둘을 하지 않는다. 사람이 보고 고치거나 둔다.
 */

/** 한 제품에 처리 전 요청이 이만큼 쌓이면 더 받지 않는다 — 장난 요청이 목록을 채우지 않게 */
export const MAX_PENDING_PER_PRODUCT = 20;
const MAX_NOTE = 1000;
/** UTC 로 저장된 시각을 같은 시계로 잰다(시각 열은 시간대 없이 UTC — JS Date 로 쓴다) */
const NOW = sql`(current_timestamp at time zone 'UTC')`;

/** 요청을 받는다. 보낸이는 내려달라는 요청과 같은 해시(takedownRequesterHash)만 남긴다 */
export async function requestIntroCorrection(
  slug: string,
  raw: unknown,
  requesterHash: string | null = null,
): Promise<Result<{ id: number }>> {
  const checked = introRequestMessage(raw);
  if (!checked.ok) return fail({ kind: "invalid", message: checked.error });

  const product = await repo.findBySlug(slug);
  if (!product || (product.status !== "seeded" && product.status !== "verified")) return fail({ kind: "not_found" });
  // 주인이 있는 제품은 수정 키로 소개를 직접 고친다 — 남이 고쳐 달라고 하는 길을 열지 않는다
  if (!isUnclaimed(product)) {
    return fail({ kind: "forbidden", message: "주인이 있는 제품입니다. 수정 키로 소개를 직접 고칠 수 있습니다" });
  }

  const [pending] = await db.select({ n: count() }).from(introCorrectionRequests)
    .where(and(eq(introCorrectionRequests.productId, product.id), isNull(introCorrectionRequests.handledAt)));
  if (pending.n >= MAX_PENDING_PER_PRODUCT) {
    return fail({ kind: "forbidden", message: "이 제품에는 확인 전 요청이 이미 많습니다. 관리자가 확인한 뒤 다시 보내 주세요" });
  }

  const [row] = await db.insert(introCorrectionRequests).values({
    productId: product.id, slug, message: checked.message, requesterHash, createdAt: new Date(),
  }).returning({ id: introCorrectionRequests.id });
  logger.info("intro_request.received", { slug, id: row.id });
  return ok({ id: row.id });
}

/** 처리 전 요청 수 — 처리 화면의 탭 고르기와 머리 */
export async function pendingIntroRequestCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(introCorrectionRequests).where(isNull(introCorrectionRequests.handledAt));
  return row.n;
}

/** 처리 화면의 목록 — 처리 전 요청에 지금 소개를 붙인다. 오래 기다린 것부터 */
export async function introRequestQueue(limit = 200): Promise<IntroRequestEntry[]> {
  const rows = await db.execute<{
    id: number; slug: string; message: string; created_iso: string; age_hours: number; requester_hash: string | null;
    name: string | null; url: string | null; tagline: string | null; status: string | null;
  }>(sql`
    select r.id, r.slug, r.message, r.requester_hash,
      to_char(r.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_iso,
      extract(epoch from (${NOW} - r.created_at)) / 3600 as age_hours,
      p.name, p.url, p.tagline, p.status
    from intro_correction_requests r left join products p on p.id = r.product_id
    where r.handled_at is null
    order by r.created_at asc, r.id asc
    limit ${limit}
  `);
  // 시각은 SQL 에서 ISO(UTC)로 만든다 — 시간대 없는 열을 노드가 Date 로 읽으면 서버 시간대만큼 밀린다
  return rows.map((row) => ({
    id: Number(row.id), slug: row.slug, message: row.message, createdAt: row.created_iso, ageHours: Number(row.age_hours),
    requesterHash: row.requester_hash,
    product: row.name === null ? null : { name: row.name, url: row.url ?? "", tagline: row.tagline ?? "", status: row.status ?? "" },
  }));
}

export type IntroRequestOutcome = "fixed" | "dismissed";
export const isIntroRequestOutcome = (value: unknown): value is IntroRequestOutcome => value === "fixed" || value === "dismissed";

/**
 * 처리함·둠 — 요청 하나에 결과를 적는다. 소개는 건드리지 않는다(이미 다른 곳에서 고쳤거나, 고칠 것이 아닐 때).
 * 이미 처리했으면 null.
 */
export async function resolveIntroRequest(
  id: number,
  outcome: IntroRequestOutcome,
  admin: string,
  note?: string | null,
): Promise<{ id: number; slug: string } | null> {
  const [row] = await db.update(introCorrectionRequests)
    .set({ handledAt: new Date(), handledBy: admin, outcome, note: note?.trim().slice(0, MAX_NOTE) || null })
    .where(and(eq(introCorrectionRequests.id, id), isNull(introCorrectionRequests.handledAt)))
    .returning({ id: introCorrectionRequests.id, slug: introCorrectionRequests.slug });
  return row ?? null;
}

/**
 * 소개 고치기 — 요청을 보고 사람이 새 한 줄을 적는다. 그 제품의 처리 전 요청을 모두 '고침'으로 닫는다(같은 소개를 두고 온 요청이다).
 *
 * 소개를 바꾸는 방법은 '소개 확인 필요'의 고치기(intro-editor.ts editIntro)와 같다: 출처를 editor 로 두어 검수 잡이 다시 보지 않게 하고,
 * 검색 키워드를 비우고 검색 프로필을 지워 새 소개로 다시 짓게 하고, 소개와 같은 글이던 설명도 함께 바꾼다. 제품 세대를 잠근다.
 * editIntro 는 검수가 넘긴 제품에만 쓰이므로(needs_editor) 여기서 같은 갱신을 한다. 한국어 소개는 잡이 바뀐 소개를 보고 다시 옮긴다.
 * 요청이 이미 처리됐거나, 제품이 공개 상태가 아니거나, 주인이 생겼으면 null.
 */
export async function fixIntroFromRequest(
  id: number,
  line: string,
  admin: string,
): Promise<{ slug: string; before: string; closed: number[] } | null> {
  const tagline = line.trim();
  if (!tagline || tagline.length > LIMITS.tagline) return null;
  return db.transaction(async (tx) => {
    const [request] = await tx.select({ productId: introCorrectionRequests.productId, slug: introCorrectionRequests.slug })
      .from(introCorrectionRequests).where(and(eq(introCorrectionRequests.id, id), isNull(introCorrectionRequests.handledAt)));
    if (!request) return null;
    if (!(await lockProductGeneration(tx, request.productId, request.slug))) return null;
    const [product] = await tx.select({ tagline: products.tagline, description: products.description, status: products.status,
      source: products.source, claimedAt: products.claimedAt }).from(products).where(eq(products.id, request.productId));
    if (!product || (product.status !== "seeded" && product.status !== "verified") || !isUnclaimed(product)) return null;
    // 제품을 잠근 뒤 요청을 다시 잠가 읽는다 — 그 사이 다른 관리자가 닫았으면 아무것도 바꾸지 않는다
    const open = await tx.select({ id: introCorrectionRequests.id }).from(introCorrectionRequests)
      .where(and(eq(introCorrectionRequests.productId, request.productId), isNull(introCorrectionRequests.handledAt))).for("update");
    if (!open.some((row) => row.id === id)) return null;

    const sameText = product.description.trim() === product.tagline.trim();
    await tx.update(products).set({ tagline, taglineSource: "editor", searchKeywords: null, ...(sameText ? { description: tagline } : {}),
      updatedAt: sql`now()` }).where(eq(products.id, request.productId));
    await tx.delete(productSearchProfiles).where(eq(productSearchProfiles.productId, request.productId));
    const closed = open.map((row) => row.id);
    await tx.update(introCorrectionRequests).set({ handledAt: new Date(), handledBy: admin, outcome: "fixed" })
      .where(inArray(introCorrectionRequests.id, closed));
    return { slug: request.slug, before: product.tagline, closed };
  });
}
