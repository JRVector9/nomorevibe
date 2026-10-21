import { uptimeNegativeAllowed } from "@/lib/domain/products/uptime-negative-gate";
import { and, asc, eq, gte, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { crawlCandidates, productAuditCampaigns, productAuditItems, productEvidenceAudit, productHealth, productIntroChecks,
  products } from "@/lib/db/schema";
import { sharedStore } from "@/lib/cache/shared";
import { sharedLoader } from "./shared-cache";
import { sharedHumanQueueOverview } from "./shared-reads";
import { heldPublic } from "@/lib/crawl/product-audit-hold";
import { getSettings } from "@/lib/crawl/settings";
import { DOWN_THRESHOLD, downProductCount } from "@/lib/domain/products/health";
import { countProducts, repoGone, repoGoneAutoBanned, SPAM_AUTO_BAN_ACTOR, SPAM_AUTO_BAN_REASON } from "@/lib/domain/products/repository";
import { feedbackAdminQueue } from "@/lib/domain/feedback/repository";
import { productTranslationAdminQueue } from "@/lib/domain/products/translation-admin";
import { introRequestQueue, pendingIntroRequestCount } from "@/lib/domain/products/intro-requests";
import { takedownQueue, takedownSummary } from "@/lib/domain/products/takedown";
import { logger } from "@/lib/observability/logger";
import { attentionCounts } from "./dashboard";

/**
 * "오늘 할 일" 받은편지함의 읽기(2026-10-08 UX 감사 ADM-07) — 사람에게 오는 일을 칸마다 센다. 읽기만 한다.
 *
 * 수는 새로 세지 않는다. 각 처리 화면과 운영센터가 쓰는 함수를 그대로 불러 두 화면의 숫자가 같게 한다 —
 * 요청은 takedownSummary, 심사는 humanQueueOverview, 응답 없음은 downProductCount, 나머지는 attentionCounts.
 * 여기서 새로 쓰는 SQL 은 칸마다 "오래 기다린 것부터 다섯 줄"뿐이고, 그 조건은 수를 낸 함수와 같은 식이다.
 * 칸은 따로 읽는다 — 하나가 실패해도 그 칸만 "불러오지 못함"이다(attentionCounts 를 쓰는 네 칸은 함께 실패한다).
 */

export type InboxKey = "takedown" | "introRequest" | "feedback" | "human" | "agreed" | "audit" | "down" | "intro" | "translations" | "repoGone" | "repoAutoBanned" | "spam";

/** 미리 보기 한 줄 — 이름, 왜 여기 왔나, 언제부터 기다렸나(ISO, UTC). 심사 후보의 why 는 사유 코드다 */
export type InboxItem = { id: string; name: string; why: string; since: string | null };

export type InboxSectionData = {
  /** 처리 화면의 수와 같은 함수에서 온 수 */
  count: number;
  /** 오래 기다린 것부터 INBOX_PREVIEW 줄 — 첫 줄이 가장 오래된 것이다 */
  items: InboxItem[];
  /** 약속을 넘긴 수 — 내려달라는 요청의 24시간 */
  overdue?: number;
  /** 칸 머리의 짧은 덧말 */
  note?: string;
};

export type InboxSectionResult = { ok: true; data: InboxSectionData } | { ok: false };

export type InboxSnapshot = {
  /** 읽은 시각 — 화면의 "몇 분 전"을 이 시각으로 잰다(서버·브라우저가 같은 글자를 내게) */
  fetchedAt: string;
  results: Record<InboxKey, InboxSectionResult>;
  /** 최근 24시간에 처리한 것의 조각 — 심사 결정, 내려달라는 요청 처리. 못 읽으면 null */
  done: [review: number | null, takedowns: number | null];
};

export const INBOX_PREVIEW = 5;

const at = (now: Date) => sql`${now.toISOString()}::timestamp`;
/** 시각 열은 시간대 없는 UTC 다 — SQL 에서 ISO 로 만든다(노드가 읽으면 서버 시간대만큼 밀린다) */
const iso = (value: SQL | AnyPgColumn) => sql<string | null>`to_char(${value}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const LISTED = inArray(products.status, ["seeded", "verified"]);
const count = (value: number) => value.toLocaleString("ko-KR");
const clip = (text: string, size = 140) => text.length > size ? `${text.slice(0, size - 1)}…` : text;

/**
 * 심사 후보 — 심사 큐의 "오래 기다린 것부터"(sort=wait)와 같은 순서·같은 대기 시각(판정 시각, 없으면 마지막 변경).
 * 후보는 humanQueueOverview 가 가른 구간의 id 그대로다.
 */
async function candidatePreview(ids: number[], why: (row: { id: number; reason: string | null }) => string): Promise<InboxItem[]> {
  if (ids.length === 0) return [];
  const since = sql`coalesce(${crawlCandidates.judgedAt}, ${crawlCandidates.updatedAt})`;
  const rows = await db.select({ id: crawlCandidates.id, repo: crawlCandidates.repo, reason: crawlCandidates.reason, since: iso(since) })
    .from(crawlCandidates).where(inArray(crawlCandidates.id, ids))
    .orderBy(sql`${since} asc nulls last`, asc(crawlCandidates.id)).limit(INBOX_PREVIEW);
  return rows.map((row) => ({ id: String(row.id), name: row.repo, why: why(row), since: row.since }));
}

/** 감사 거절 — attentionCounts 의 auditRejectsOpen 과 같은 조건(마지막 감사, AI 거절, 사람 손 안 탐, 아직 공개) */
async function auditPreview(): Promise<InboxItem[]> {
  const rows = await db.select({ id: productAuditItems.id, name: products.name, reason: productAuditItems.aiReason,
    confidence: productAuditItems.aiConfidence, since: iso(productAuditItems.reviewedAt) })
    .from(productAuditItems).innerJoin(products, eq(products.id, productAuditItems.productId))
    .where(and(sql`${productAuditItems.campaignId} = (select max(${productAuditCampaigns.id}) from ${productAuditCampaigns})`,
      eq(productAuditItems.aiDecision, "reject"), isNull(productAuditItems.humanDecision), LISTED))
    .orderBy(sql`${productAuditItems.reviewedAt} asc nulls last`, asc(productAuditItems.id)).limit(INBOX_PREVIEW);
  return rows.map((row) => ({ id: String(row.id), name: row.name,
    why: [row.reason ? clip(row.reason) : "사유 없음", row.confidence !== null && `확신 ${row.confidence.toFixed(2)}`].filter(Boolean).join(" · "),
    since: row.since }));
}

/** 지난 감사의 항목으로 보류 중인 공개 제품 — 마지막 감사의 거절(auditRejectsOpen)에 이미 든 보류는 두 번 세지 않는다 */
async function heldOutsideLatestCampaign(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(products)
    .innerJoin(productAuditItems, eq(productAuditItems.id, products.auditHoldItemId))
    .where(and(heldPublic, sql`${productAuditItems.campaignId} <> (select max(${productAuditCampaigns.id}) from ${productAuditCampaigns})`));
  return row?.count ?? 0;
}

/** 응답 없음 — health.ts downProductCount 와 같은 조건(DOWN_THRESHOLD 회 이상 연속 실패, 죽기 시작한 시각 있음, 공개) */
async function downPreview(): Promise<InboxItem[]> {
  const rows = await db.select({ slug: products.slug, name: products.name, failures: productHealth.failures, code: productHealth.status,
    since: iso(productHealth.downSince) })
    .from(productHealth).innerJoin(products, eq(products.slug, productHealth.slug))
    .where(and(gte(productHealth.failures, DOWN_THRESHOLD), isNotNull(productHealth.downSince),
      uptimeNegativeAllowed({ id: products.id, url: products.url, updatedAt: products.updatedAt,
        checkedAt: productHealth.checkedAt, failures: productHealth.failures, status: productHealth.status }), LISTED))
    .orderBy(asc(productHealth.downSince), asc(products.slug)).limit(INBOX_PREVIEW);
  return rows.map((row) => ({ id: row.slug, name: row.name, since: row.since,
    why: `${count(row.failures)}회 연속 실패 · ${row.code === 0 ? "연결 안 됨" : `응답 ${row.code}`}` }));
}

/** 소개 확인 — repository.ts 의 introNeedsEditor 와 같은 조건(지금 소개를 검수가 needs_editor 로 남김, 공개) */
async function introPreview(): Promise<InboxItem[]> {
  const rows = await db.select({ slug: products.slug, name: products.name, tagline: products.tagline, problem: productIntroChecks.problem,
    since: iso(productIntroChecks.updatedAt) })
    .from(productIntroChecks).innerJoin(products, eq(products.id, productIntroChecks.productId))
    .where(and(eq(productIntroChecks.outcome, "needs_editor"), eq(productIntroChecks.checkedTagline, products.tagline), LISTED))
    .orderBy(asc(productIntroChecks.updatedAt), asc(products.slug)).limit(INBOX_PREVIEW);
  return rows.map((row) => ({ id: row.slug, name: row.name, since: row.since,
    why: row.problem.trim() ? clip(row.problem.trim()) : `소개 "${clip(row.tagline, 80)}"` }));
}

/** 저장소 사라짐 — repository.ts repoGone 그대로. 시작은 사라졌다고 확정된 때(repo_missing_since + 24시간, attentionCounts 와 같다) */
async function repoGonePreview(): Promise<InboxItem[]> {
  const rows = await db.select({ slug: products.slug, name: products.name, accessMode: products.accessMode, repoStatus: products.repoStatus,
    since: iso(sql`${products.repoMissingSince} + interval '24 hours'`) })
    .from(products).where(and(LISTED, repoGone))
    .orderBy(asc(products.repoMissingSince), asc(products.slug)).limit(INBOX_PREVIEW);
  return rows.map((row) => ({ id: row.slug, name: row.name, since: row.since,
    why: `${row.repoStatus === "empty" ? "빈 저장소" : "저장소 없음"} · ${row.accessMode === "website" ? "웹사이트 — GitHub 표시만 뺌" : "설치형 — 목록에서 가려짐"}` }));
}

/** 제품 필터와 같은 최신 결정 조건. 정상 자동 차단은 해제할 필요가 없다. */
async function repoAutoBannedSection(): Promise<InboxSectionData> {
  const since = sql`(select a.created_at from ${productEvidenceAudit} a where a.slug = ${products.slug}
    and a.action in ('admin.product.ban', 'admin.product.unban') order by a.id desc limit 1)`;
  const [total, rows] = await Promise.all([
    countProducts({ statuses: ["banned"], repoAutoBanned: true }),
    db.select({ slug: products.slug, name: products.name, since: iso(since) }).from(products)
      .where(repoGoneAutoBanned).orderBy(asc(since), asc(products.slug)).limit(INBOX_PREVIEW),
  ]);
  return { count: total, note: "자동 처리 결과 · 정상 차단이면 유지",
    items: rows.map((row) => ({ id: row.slug, name: row.name, since: row.since, why: "저장소 소실 자동 차단 · 현재 근거를 확인" })) };
}

const SPAM_CONFIDENCE: Record<string, string> = { high: "높음", medium: "중간", low: "낮음" };
/** 스팸 재검사(spam-rescan.ts)는 확신을 high·medium·low 글자로 적는다. 숫자로 적힌 기록도 그대로 읽는다 */
function spamConfidence(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return `확신 ${value.toFixed(2)}`;
  return typeof value === "string" && Object.hasOwn(SPAM_CONFIDENCE, value) ? `확신 ${SPAM_CONFIDENCE[value]}` : null;
}

/** 스팸 자동 차단 — attentionCounts 의 spamAutoBans.day 와 같은 조건(지난 24시간의 자동 차단 기록) */
async function spamPreview(now: Date): Promise<InboxItem[]> {
  const rows = await db.select({ id: productEvidenceAudit.id, slug: productEvidenceAudit.slug, name: products.name, status: products.status,
    metadata: productEvidenceAudit.metadata, since: iso(productEvidenceAudit.createdAt) })
    .from(productEvidenceAudit).leftJoin(products, eq(products.slug, productEvidenceAudit.slug))
    .where(and(eq(productEvidenceAudit.action, "admin.product.ban"), eq(productEvidenceAudit.actor, SPAM_AUTO_BAN_ACTOR),
      eq(productEvidenceAudit.reason, SPAM_AUTO_BAN_REASON), sql`${productEvidenceAudit.createdAt} > ${at(now)} - interval '24 hours'`))
    .orderBy(asc(productEvidenceAudit.createdAt), asc(productEvidenceAudit.id)).limit(INBOX_PREVIEW);
  return rows.map((row) => {
    const confidence = spamConfidence(row.metadata.confidence);
    const state = row.status === "banned" ? "차단 중" : "차단 풀림";
    return { id: String(row.id), name: row.name ?? row.slug ?? "(이름 없음)", since: row.since,
      why: [state, confidence].filter(Boolean).join(" · ") };
  });
}

async function settle(key: InboxKey, load: () => Promise<InboxSectionData>): Promise<InboxSectionResult> {
  try {
    return { ok: true, data: await load() };
  } catch (error) {
    logger.warn("inbox.section_unavailable", { section: key, errorName: error instanceof Error ? error.name : "unknown" });
    return { ok: false };
  }
}

export async function loadInbox(now = new Date()): Promise<InboxSnapshot> {
  // 여러 칸이 함께 쓰는 수 — 한 번만 부른다. 실패는 각 칸이 받아 그 칸만 "불러오지 못함"이 된다
  const takedowns = takedownSummary();
  const overview = getSettings().then((settings) => sharedHumanQueueOverview(settings));
  const attention = attentionCounts(now);
  // 아무도 기다리지 않는 사이에 실패해도 처리되지 않은 거부로 남지 않게
  for (const shared of [takedowns, overview, attention]) shared.catch(() => undefined);

  const [takedown, introRequest, feedback, human, agreed, audit, down, intro, translations, gone, repoAutoBanned, spam, decided, handled] = await Promise.all([
    settle("takedown", async () => {
      const [summary, queue] = await Promise.all([takedowns, takedownQueue(INBOX_PREVIEW)]);
      return {
        count: summary.pending, overdue: summary.overdue,
        note: summary.overdue > 0 ? `24시간 넘음 ${count(summary.overdue)}건` : undefined,
        items: queue.map((entry) => ({ id: entry.slug, name: entry.product?.name ?? entry.slug, why: entry.reason ?? "사유 없음",
          since: entry.requestedAt })),
      };
    }),
    // 소개 수정 요청(UX-18) — 처리 화면(요청 탭)의 목록과 같은 함수·같은 차례
    settle("introRequest", async () => {
      const [total, queue] = await Promise.all([pendingIntroRequestCount(), introRequestQueue(INBOX_PREVIEW)]);
      return { count: total, items: queue.map((entry) => ({ id: String(entry.id), name: entry.product?.name ?? entry.slug,
        why: clip(entry.message), since: entry.createdAt })) };
    }),
    settle("feedback", async () => {
      const queue = await feedbackAdminQueue({ state: "held", limit: INBOX_PREVIEW });
      return { count: queue.count, items: queue.items.map((item) => ({ id: item.id, name: item.productName,
        why: clip(item.title), since: item.createdAt })) };
    }),
    settle("human", async () => {
      const { ids, stages, wait } = await overview;
      return { count: stages.human, note: wait?.stalled ? `2주 넘음 ${count(wait.stalled)}건` : undefined,
        items: await candidatePreview(ids.human, (row) => row.reason ?? "") };
    }),
    settle("agreed", async () => {
      const { ids, stages, agreed: split, secondIds } = await overview;
      const rejects = new Set([...secondIds.unanimous_reject, ...secondIds.agreed_reject]);
      return { count: stages.agreed, note: `거절 ${count(split.reject)} · 승인 ${count(split.approve)}`,
        items: await candidatePreview(ids.agreed, (row) => rejects.has(row.id) ? "두 모델 모두 거절" : "두 모델 모두 승인") };
    }),
    settle("audit", async () => {
      const [counts, items, heldElsewhere] = await Promise.all([attention, auditPreview(), heldOutsideLatestCampaign()]);
      // 보류 중인 것은 이미 목록에서 빠져 사람을 기다린다 — 감사 화면의 '보류 중' 갈래가 오래된 것부터 보인다.
      // 지난 감사의 보류도 할 일로 센다 — 새 감사를 열어 마지막 감사의 거절이 0 이 되어도 보류 수천 건이 칸에서 사라지지 않게
      return { count: counts.auditRejectsOpen + heldElsewhere, items,
        note: counts.auditHeld > 0 ? `보류 중(목록에서 빠짐) ${count(counts.auditHeld)}건` : undefined };
    }),
    settle("down", async () => {
      const [total, items] = await Promise.all([downProductCount(), downPreview()]);
      return { count: total, items };
    }),
    settle("intro", async () => {
      const [counts, items] = await Promise.all([attention, introPreview()]);
      return { count: counts.introNeedsEditor, items };
    }),
    settle("translations", async () => {
      const queue = await productTranslationAdminQueue({ state: "failed", limit: INBOX_PREVIEW });
      return { count: queue.count, note: "소진·원문 변경·검수 탈락을 구분해 확인",
        items: queue.items.map((item) => ({ id: `${item.productId}:${item.locale}:${item.field}`, name: item.name,
          why: `${item.locale} ${item.field} · ${item.errorCode ?? "실패"} · ${item.attempts}/4`, since: item.updatedAt })) };
    }),
    settle("repoGone", async () => {
      const [counts, items] = await Promise.all([attention, repoGonePreview()]);
      const { installable, website } = counts.repoGone;
      return { count: installable + website, note: `설치형 ${count(installable)} · 웹 ${count(website)}`, items };
    }),
    settle("repoAutoBanned", repoAutoBannedSection),
    settle("spam", async () => {
      const [counts, items] = await Promise.all([attention, spamPreview(now)]);
      return { count: counts.spamAutoBans.day, note: `차단으로 남은 것 모두 ${count(counts.spamAutoBans.banned)}건`, items };
    }),
    overview.then(({ decided24h }) => decided24h ? decided24h.approve + decided24h.reject : null, () => null),
    takedowns.then(({ handled24h }) => handled24h.removed + handled24h.dismissed, () => null),
  ]);
  return {
    fetchedAt: now.toISOString(),
    results: { takedown, introRequest, feedback, human, agreed, audit, down, intro, translations, repoGone: gone, repoAutoBanned, spam },
    done: [decided, handled],
  };
}

/**
 * 오늘 할 일 화면의 읽기 — 칸 열네 개(주 DB)를 웹 여러 대·열린 창이 Valkey 로 30초 나눠 쓴다(shared-cache.ts).
 * 화면은 센 시각(fetchedAt)을 "… 기준"으로 보인다. 수동 새로고침(fresh)은 분당 상한 안에서 건너뛴다.
 */
const inboxCache = sharedLoader<InboxSnapshot>({ namespace: "admin:inbox", ttlMs: 30_000, store: sharedStore });

export function sharedInbox(fresh = false): Promise<InboxSnapshot> {
  return inboxCache("inbox", () => loadInbox(), fresh);
}
