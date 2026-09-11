import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, secondReviews, type SecondReviewStatus } from "@/lib/db/schema";
import { pageFactsFromDocument } from "./rules";
import type { CrawlSettings } from "./settings-schema";

/**
 * 2차 심사 — 무엇을 다시 보고, 두 판단을 어떻게 합치나.
 *
 * 1차와 다른 모델이 같은 입력으로 따로 본다. 판단을 합치는 규칙과 위험 신호는 순수 함수로 두어
 * 잡·화면·테스트가 같은 답을 낸다.
 */

/** 제품일 수도, 아닐 수도 있어 규칙으로 막지 않은 주소 — 2차에서 한 번 더 본다 */
export const RISK_HOSTS = ["testflight.apple.com", "t.me", "apps.apple.com", "play.google.com"];
const SEO_NAME = /(下载|GitHub 与|指南|教程|官方|免费|破解)/;

/** 규칙은 통과했지만 한 번 더 볼 이유 */
export function riskSignals(input: { name: string; productUrl: string | null; textSample: string | null; readme: string | null }): string[] {
  const signals: string[] = [];
  let host = "";
  try { host = input.productUrl ? new URL(input.productUrl).hostname.toLowerCase() : ""; } catch { /* 주소가 아니면 호스트 신호는 없다 */ }
  if (RISK_HOSTS.some((risk) => host === risk || host.endsWith(`.${risk}`))) signals.push("store_or_messenger");
  // 페이지 문장을 이름으로 가져온 것 — "ile başlıyordu: ne doctype, ne <head>…" (2026-09-11 실측 243개가 45자 넘음)
  if (input.name.length > 45 || input.name.trim().split(/\s+/).length >= 8) signals.push("sentence_name");
  if (SEO_NAME.test(input.name)) signals.push("seo_name");
  if (!input.textSample?.trim() && !input.readme?.trim()) signals.push("no_text");
  return signals;
}

/** 무작위 표본 — 레포 이름으로 정해 같은 것이 매번 뽑히지도, 빠지지도 않는다 */
export function inSample(repo: string, rate: number): boolean {
  if (rate <= 0) return false;
  const value = createHash("sha256").update(repo.toLowerCase()).digest().readUInt32BE(0);
  return value / 0x1_0000_0000 < rate;
}

type Verdict = { decision: string; confidence: number | null };

/**
 * 두 판단을 합친다.
 *
 * 대기 후보: 결론이 같고 둘 다 확신이 기준 이상이면 일치 — 사람은 한 번에 확정만 한다. 아니면 사람에게.
 * 공개된 제품: 2차도 제품이라 하면 일치(그대로 둔다), 아니라거나 모르겠다면 사람에게 — 자동으로 내리지 않는다.
 */
export function combineVerdicts(first: Verdict, second: Verdict, agreeAt: number, published: boolean): Exclude<SecondReviewStatus, "pending" | "failed" | "resolved"> {
  if (published) return second.decision === "approve" ? "agreed" : "needs_human";
  const agreed = first.decision === second.decision && first.decision !== "needs_review"
    && (first.confidence ?? 0) >= agreeAt && (second.confidence ?? 0) >= agreeAt;
  return agreed ? "agreed" : "needs_human";
}

const PUBLISHED_LOOKBACK_MS = 48 * 3600_000;

/** 공개분은 slug 당 한 번 — slug 가 80자까지라 그대로는 input_hash(64)에 안 들어간다 */
export function publishedInputHash(slug: string): string {
  return createHash("sha256").update(`published:${slug}`).digest("hex");
}
const ENQUEUE_LIMIT = 50;

/**
 * 2차에 올린다. 같은 후보·같은 입력은 한 번만(유일 색인).
 *  - ai_decided: 규칙이 못 가른 보류 후보를 AI 1차가 승인·거부로 가른 것 — 확신을 낸 1차만.
 *    확신이 없던 옛 1차(프롬프트 2026-09-11.2 이전)는 일치 기준에 닿을 수 없어 전부 "사람 확인"이 된다.
 *    배포 직후 프로드에서 그렇게 쌓였다 — 새 프롬프트가 다시 보면 그 판단으로 올린다.
 *  - risk / sample: 규칙만 통과해 최근 공개된 것 중 위험 신호가 있거나 표본에 든 것
 * 같은 후보에 새 1차 판단이 오면 앞의 것은 superseded 로 닫는다 — 한 후보가 두 칩에 겹쳐 세어지지 않게.
 */
export async function enqueueSecondReviews(settings: CrawlSettings, now = new Date()): Promise<number> {
  const decided = await db.selectDistinctOn([crawlReviewAttempts.candidateId], {
    candidateId: crawlReviewAttempts.candidateId, repo: crawlCandidates.repo, inputHash: crawlReviewAttempts.inputHash,
    decision: sql<string>`${crawlReviewAttempts.outcome}->>'decision'`, confidence: sql<number | null>`(${crawlReviewAttempts.outcome}->>'confidence')::float`,
  }).from(crawlReviewAttempts).innerJoin(crawlCandidates, eq(crawlCandidates.id, crawlReviewAttempts.candidateId))
    .where(and(eq(crawlCandidates.state, "needs_review"), eq(crawlCandidates.decidedBy, "auto"),
      eq(crawlReviewAttempts.kind, "automatic"), eq(crawlReviewAttempts.state, "succeeded"), eq(crawlReviewAttempts.provider, "claude-cli"),
      sql`${crawlReviewAttempts.outcome}->>'confidence' is not null`))
    .orderBy(crawlReviewAttempts.candidateId, desc(crawlReviewAttempts.id)).limit(ENQUEUE_LIMIT * 4);
  const rows: (typeof secondReviews.$inferInsert)[] = decided.filter((row) => row.decision === "approve" || row.decision === "reject")
    .slice(0, ENQUEUE_LIMIT)
    .map((row) => ({ candidateId: row.candidateId, repo: row.repo, trigger: "ai_decided" as const, firstDecision: row.decision,
      firstConfidence: row.confidence, inputHash: row.inputHash }));

  const published = await db.select({ id: crawlCandidates.id, repo: crawlCandidates.repo, slug: crawlCandidates.publishedSlug,
    productUrl: crawlCandidates.productUrl, pageMeta: crawlDocuments.pageMeta, pageStatus: crawlDocuments.pageStatus, documentUrl: crawlDocuments.productUrl })
    .from(crawlCandidates).innerJoin(crawlDocuments, eq(crawlDocuments.repo, crawlCandidates.repo))
    .where(and(eq(crawlCandidates.state, "published"), eq(crawlCandidates.decidedBy, "auto"), isNotNull(crawlCandidates.publishedSlug),
      gte(crawlCandidates.decidedAt, new Date(now.getTime() - PUBLISHED_LOOKBACK_MS))))
    .limit(2_000);
  for (const row of published) {
    const meta = (row.pageMeta ?? {}) as { title?: unknown; readmeSample?: unknown };
    const facts = pageFactsFromDocument({ productUrl: row.documentUrl, pageStatus: row.pageStatus, pageMeta: row.pageMeta });
    const signals = riskSignals({ name: typeof meta.title === "string" ? meta.title : row.repo, productUrl: row.productUrl,
      textSample: facts.textSample ?? null, readme: typeof meta.readmeSample === "string" ? meta.readmeSample : null });
    const sampled = inSample(row.repo, settings.secondReview.sampleRate);
    if (!signals.length && !sampled) continue;
    rows.push({ candidateId: row.id, repo: row.repo, publishedSlug: row.slug, trigger: signals.length ? "risk" : "sample", signals,
      firstDecision: "approve", firstConfidence: null, inputHash: publishedInputHash(row.slug!) });
    if (rows.length >= ENQUEUE_LIMIT * 2) break;
  }
  if (!rows.length) return 0;
  const inserted = await db.insert(secondReviews).values(rows).onConflictDoNothing()
    .returning({ id: secondReviews.id, candidateId: secondReviews.candidateId, trigger: secondReviews.trigger });
  const renewed = inserted.filter((row) => row.trigger === "ai_decided");
  if (renewed.length) {
    await db.update(secondReviews).set({ status: "resolved", resolution: "superseded", resolvedAt: now })
      .where(and(eq(secondReviews.trigger, "ai_decided"), inArray(secondReviews.candidateId, renewed.map((row) => row.candidateId)),
        notInArray(secondReviews.id, renewed.map((row) => row.id)), inArray(secondReviews.status, ["pending", "agreed", "needs_human", "failed"])));
  }
  return inserted.length;
}

/**
 * 더 볼 필요가 없어진 것을 닫는다 — 사람이 이미 결정했거나(보류가 아님) 공개분이 내려갔다.
 * 지우지 않는다. 몇 건을 누가 어떻게 끝냈는지가 2차 심사의 정확도다.
 */
export async function closeSettledSecondReviews(now = new Date()): Promise<number> {
  // 확신 없는 옛 1차로 올린 것 — 일치할 수 없으니 닫는다. 2차 의견은 남아 심사 상세에 그대로 보인다
  const legacy = await db.update(secondReviews).set({ status: "resolved", resolution: "no_first_confidence", resolvedAt: now })
    .where(and(eq(secondReviews.trigger, "ai_decided"), isNull(secondReviews.firstConfidence),
      inArray(secondReviews.status, ["pending", "agreed", "needs_human", "failed"])))
    .returning({ id: secondReviews.id });
  return legacy.length + await closeDecidedSecondReviews(now);
}

async function closeDecidedSecondReviews(now: Date): Promise<number> {
  // 공개분의 일치는 끝난 기록이다(그대로 둔다) — 훑는 대상에 넣으면 날마다 쌓여 한도를 잡아먹는다
  const open = await db.select({ id: secondReviews.id, candidateId: secondReviews.candidateId, published: secondReviews.publishedSlug })
    .from(secondReviews).where(or(inArray(secondReviews.status, ["pending", "needs_human"]),
      and(eq(secondReviews.status, "agreed"), isNull(secondReviews.publishedSlug))))
    .orderBy(secondReviews.id).limit(1_000);
  if (!open.length) return 0;
  const candidates = await db.select({ id: crawlCandidates.id, state: crawlCandidates.state }).from(crawlCandidates)
    .where(inArray(crawlCandidates.id, [...new Set(open.map((row) => row.candidateId))]));
  const state = new Map(candidates.map((row) => [row.id, row.state]));
  const settled = open.filter((row) => row.published ? state.get(row.candidateId) !== "published" : state.get(row.candidateId) !== "needs_review");
  if (!settled.length) return 0;
  await db.update(secondReviews).set({ status: "resolved", resolution: "decided_elsewhere", resolvedAt: now })
    .where(inArray(secondReviews.id, settled.map((row) => row.id)));
  return settled.length;
}

export async function pendingSecondReviews(limit: number) {
  return db.select().from(secondReviews).where(eq(secondReviews.status, "pending")).orderBy(secondReviews.id).limit(limit);
}

export async function recordSecondReview(id: number, result:
  | { ok: true; decision: string; confidence: number | null; reason: string; model: string; status: "agreed" | "needs_human" }
  | { ok: false; error: string; model: string }, now = new Date()): Promise<void> {
  await db.update(secondReviews).set(result.ok
    ? { status: result.status, model: result.model, secondDecision: result.decision, secondConfidence: result.confidence,
        secondReason: result.reason.slice(0, 2000), errorCode: null, reviewedAt: now }
    : { status: "failed", model: result.model, errorCode: result.error.slice(0, 60), reviewedAt: now })
    .where(eq(secondReviews.id, id));
}

/**
 * 실패한 것을 다시 대기로 — 한 시간 뒤. CLI 가 잠깐 막혔던 것이 영영 남지 않게.
 *
 * 비교는 lt() 로 한다. sql`` 안에 Date 를 그대로 넣으면 "Fri Sep 11 2026 …" 문자열로 넘어가
 * 프로드에서 매 틱 실패했다(2026-09-11) — 컬럼 타입을 거쳐야 시각으로 바뀐다.
 */
export async function retryFailedSecondReviews(now = new Date()): Promise<void> {
  await db.update(secondReviews).set({ status: "pending" })
    .where(and(eq(secondReviews.status, "failed"), lt(secondReviews.reviewedAt, new Date(now.getTime() - 3600_000))));
}

export type SecondReviewCounts = { agreedReject: number; agreedApprove: number; needsHuman: number; published: number; pending: number };

/** 심사 화면의 거르기 칩과 운영센터가 쓰는 수. 대기 후보 것과 공개분 것을 나눈다 */
export async function secondReviewSummary(): Promise<{ counts: SecondReviewCounts; ids: Record<"agreed_reject" | "agreed_approve" | "needs_human", number[]> }> {
  const rows = await db.select({ candidateId: secondReviews.candidateId, status: secondReviews.status, decision: secondReviews.secondDecision,
    published: secondReviews.publishedSlug }).from(secondReviews)
    .where(inArray(secondReviews.status, ["pending", "agreed", "needs_human"]));
  const ids = { agreed_reject: [] as number[], agreed_approve: [] as number[], needs_human: [] as number[] };
  let published = 0, pending = 0;
  for (const row of rows) {
    if (row.status === "pending") { pending += 1; continue; }
    if (row.published) { if (row.status === "needs_human") published += 1; continue; }
    if (row.status === "needs_human") ids.needs_human.push(row.candidateId);
    else if (row.decision === "reject") ids.agreed_reject.push(row.candidateId);
    else if (row.decision === "approve") ids.agreed_approve.push(row.candidateId);
  }
  return { counts: { agreedReject: ids.agreed_reject.length, agreedApprove: ids.agreed_approve.length, needsHuman: ids.needs_human.length, published, pending }, ids };
}

/** 후보별 마지막 2차 판단 — 심사 상세에 1차와 나란히 보인다 */
export async function secondReviewsFor(candidateIds: number[]) {
  if (!candidateIds.length) return [];
  return db.selectDistinctOn([secondReviews.candidateId]).from(secondReviews)
    .where(and(inArray(secondReviews.candidateId, candidateIds), notInArray(secondReviews.status, ["pending"])))
    .orderBy(secondReviews.candidateId, desc(secondReviews.id));
}

/** 공개된 제품 중 2차가 제품이 아니라고 본 것 — 사람이 내릴지 정한다 */
export async function publishedSecondReviews(limit = 100) {
  return db.select().from(secondReviews).where(and(eq(secondReviews.status, "needs_human"), isNotNull(secondReviews.publishedSlug)))
    .orderBy(desc(secondReviews.reviewedAt)).limit(limit);
}

export async function resolveSecondReviews(ids: number[], resolution: "kept" | "banned", actor: string, now = new Date()): Promise<number> {
  if (!ids.length) return 0;
  const updated = await db.update(secondReviews).set({ status: "resolved", resolution, resolvedBy: actor, resolvedAt: now })
    .where(and(inArray(secondReviews.id, ids), eq(secondReviews.status, "needs_human"))).returning({ id: secondReviews.id });
  return updated.length;
}
