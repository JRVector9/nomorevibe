import { randomUUID } from "node:crypto";
import { like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { TEST_DATABASE_URL, ensureSchema, resetTables } from "./setup";

/**
 * 운영센터 개편 v8 PR6 의 새 숫자를 실제 PostgreSQL 에서 — 모델 자리 24h(+최근 1시간)·7일(UNION 가지 모두)과 미룬 이유(defer:<job>).
 * 테스트 DB 를 복제본 자리(READ_DATABASE_URL)에 넘긴다(db-replica.test.ts 와 같은 fixture). 복제본이 없으면 보류.
 * 시각은 이 프로세스 시계로 심고 창 경계는 DB 시계로 잰다 — 같은 호스트라 어긋나지 않게 경계에서 여유를 둔다(1시간 안은 5~50분 전).
 */
const globalForDb = globalThis as unknown as { readDb?: unknown };
const setReplica = (url: string | undefined) => {
  if (url) process.env.READ_DATABASE_URL = url; else delete process.env.READ_DATABASE_URL;
  globalForDb.readDb = undefined;
};
const tag = randomUUID().slice(0, 8);

const { db } = await import("@/lib/db");
const schema = await import("@/lib/db/schema");
const { jobDeferralKey, writeJobDeferral } = await import("@/lib/jobs/deferral-observation");
const { readDeferrals, readModelSlotWeek, readModelSlotWindows } = await import("@/lib/operations/flow-reads");
const { resolveModelSlots } = await import("@/lib/operations/stage-registry");

/** 오늘(2026-10-18) 운영 설정과 같은 모델 자리 — 1차 [MLX] gpt-oss-120b, 2차 투표 [gpu3090] qwen3.8-flash-next, 예비 qwen3-coder:30b */
const FIRST = "[MLX] gpt-oss-120b", VOTER = "[gpu3090] qwen3.8-flash-next", FALLBACK = "qwen3-coder:30b";
const settings: CrawlSettings = { ...DEFAULT_CRAWL_SETTINGS, firstReview: { provider: "abcllm", model: FIRST },
  secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, voters: [{ provider: "abcllm", model: VOTER }], fallbacks: [{ provider: "abcllm", model: FALLBACK }] } };
const slots = resolveModelSlots(settings, {});
const deferJob = `v8-defer-${tag}`;

const base = Date.now();
const ago = (minutes: number) => new Date(base - minutes * 60_000);
const H = 60, D = 1440;

beforeAll(async () => {
  ensureSchema();
  setReplica(TEST_DATABASE_URL);
  // 자리 수를 정확히 재려고 다른 파일이 남긴 호출 기록을 비운다(operations-dashboard.test.ts 와 같은 순서). 제품 쪽은 resetTables(CASCADE)
  await resetTables();
  for (const table of [schema.secondReviews, schema.crawlCandidates, schema.crawlDocuments, schema.crawlFrontier, schema.crawlPublicationChanges,
    schema.textTranslations, schema.crawlTaglines]) await db.delete(table);

  const [candidate] = await db.insert(schema.crawlCandidates).values({ repo: `v8slots-${tag}/repo`, state: "needs_review", reason: "passed",
    decidedBy: "auto", judgedAt: ago(60) }).returning();
  const attempt = (minutes: number | null, over: Partial<typeof schema.crawlReviewAttempts.$inferInsert> = {}): typeof schema.crawlReviewAttempts.$inferInsert => ({
    candidateId: candidate.id, kind: "automatic", state: "succeeded", inputHash: `i-${randomUUID().slice(0, 8)}`, policyHash: "p", sourceRevisionHash: "s",
    snapshot: {} as never, source: {} as never, promptVersion: "test", rulesVersion: "test", provider: "abcllm", model: FIRST, attemptNumber: 1,
    validUntil: ago(-60), startedAt: minutes === null ? ago(1) : ago(minutes + 0.1), completedAt: minutes === null ? null : ago(minutes), ...over,
  });
  await db.insert(schema.crawlReviewAttempts).values([
    attempt(10), attempt(20, { state: "failed", errorCode: "timeout" }), attempt(5 * H), attempt(3 * D),
    // 모델 호출이 아닌 것 — 모델 카드(firstModelCall)와 같이 뺀다
    attempt(15, { state: "failed", errorCode: "cancelled" }), attempt(15, { provider: "rules" }), attempt(15, { kind: "admin_override" }),
    attempt(null, { state: "running" }),
  ]);
  const vote = (model: string, minutes: number, over: Partial<typeof schema.secondReviews.$inferInsert> = {}): typeof schema.secondReviews.$inferInsert => ({
    candidateId: candidate.id, repo: candidate.repo, trigger: "ai_approved", firstDecision: "approve", inputHash: `v-${randomUUID().slice(0, 8)}`,
    provider: "abcllm", model, status: "agreed", secondDecision: "approve", createdAt: ago(minutes + 1), reviewedAt: ago(minutes), ...over,
  });
  await db.insert(schema.secondReviews).values([
    vote(VOTER, 12), vote(VOTER, 25, { secondDecision: "reject", status: "needs_human" }),
    vote(VOTER, 30, { secondDecision: null, errorCode: "timeout", status: "pending" }),
    vote(VOTER, 14, { secondDecision: null, errorCode: "cancelled", status: "pending" }),
    vote(VOTER, 2 * D), vote(FALLBACK, 40), vote("다른 모델", 9),
  ]);

  const product = (slug: string): typeof schema.products.$inferInsert => ({ slug, url: `https://${slug}.example`, name: slug, tagline: "test",
    description: "test", category: "Productivity", status: "seeded", source: "crawler", verifyToken: `verify-${slug}`, editTokenHash: "h".repeat(64) });
  const [p1, p2, p3] = await db.insert(schema.products).values([product(`v8-${tag}-a`), product(`v8-${tag}-b`), product(`v8-${tag}-c`)]).returning();

  await db.insert(schema.productSearchProfiles).values([
    { productId: p1.id, model: "[MLX] gpt-oss-120b", sourceHash: "x", generatedAt: ago(5), verifiedAt: ago(4), verifyModel: "[supa] Qwen3.8-27B-NVFP4", updatedAt: ago(4) },
    { productId: p2.id, model: "[MLX] gpt-oss-120b", sourceHash: "y", generatedAt: ago(6 * H), errorCode: "timeout", verifyError: "bad_json",
      verifyModel: "[supa] Qwen3.8-27B-NVFP4", updatedAt: ago(8) },
  ]);
  const campaign = { startedBy: "test", reason: "test", promptVersion: "test", rulesVersion: "test", provider: "abcllm", model: FIRST };
  const [audit] = await db.insert(schema.productAuditCampaigns).values(campaign).returning();
  const [item] = await db.insert(schema.productAuditItems).values({ campaignId: audit.id, productId: p1.id, slug: p1.slug }).returning();
  const auditAttempt = (minutes: number, errorCode: string | null = null) => ({ itemId: item.id, startedAt: ago(minutes + 0.2), completedAt: ago(minutes),
    provider: "abcllm", model: FIRST, inputHash: "a", source: {} as never, errorCode });
  await db.insert(schema.productAuditAttempts).values([auditAttempt(9), auditAttempt(50, "timeout"), auditAttempt(4 * D)]);

  const vector = sql`('[' || array_to_string(array_fill(0.1::real, ARRAY[1024]), ',') || ']')::halfvec`;
  await db.execute(sql`INSERT INTO product_embeddings (product_id, model, text_hash, embedding, embedded_at) VALUES
    (${p1.id}, 'bge-m3-f16@daec91ff', 'h1', ${vector}, ${ago(7).toISOString()}::timestamp),
    (${p2.id}, 'bge-m3-f16@daec91ff', 'h2', ${vector}, ${ago(3 * D).toISOString()}::timestamp)`);
  const machine = { kind: "machine" as const, source: "test", policy: "test" };
  const hash = (digit: string) => digit.repeat(64);
  await db.insert(schema.productTranslations).values([
    { productId: p1.id, locale: "en", field: "tagline", sourceHash: hash("1"), status: "ready", text: "A tool", provenance: machine, model: "[MLX] gpt-oss-120b", updatedAt: ago(11) },
    { productId: p1.id, locale: "en", field: "description", sourceHash: hash("2"), status: "failed", provenance: machine, model: "[MLX] gpt-oss-120b", updatedAt: ago(3 * H) },
    // 사람이 고친 번역·아직 대기인 것은 모델 결과가 아니다
    { productId: p2.id, locale: "en", field: "tagline", sourceHash: hash("3"), status: "ready", text: "Edited", provenance: { ...machine, kind: "editor" }, updatedAt: ago(5) },
    { productId: p2.id, locale: "en", field: "description", sourceHash: hash("4"), status: "pending", provenance: machine, updatedAt: ago(5) },
  ]);
  await db.insert(schema.textTranslations).values([
    { sourceHash: `r1-${tag}`, status: "done", translated: "번역", model: "[MLX] gpt-oss-120b", updatedAt: ago(13) },
    { sourceHash: `r2-${tag}`, status: "failed", model: "[MLX] gpt-oss-120b", errorCode: "timeout", updatedAt: ago(2 * H) },
    { sourceHash: `r3-${tag}`, status: "done", translated: "번역", model: "[MLX] gpt-oss-120b", updatedAt: ago(10 * D) },
  ]);
  await db.insert(schema.productKoreanTaglines).values([
    { productId: p1.id, sourceTagline: "test", taglineKo: "시험", model: "[MLX] gpt-oss-120b", updatedAt: ago(16) },
    { productId: p2.id, sourceTagline: "test", model: "[MLX] gpt-oss-120b", errorCode: "timeout", updatedAt: ago(17) },
  ]);
  await db.insert(schema.productIntroChecks).values([
    { productId: p1.id, checkedTagline: "test", verdict: "ok", model: "sonnet", updatedAt: ago(18) },
    { productId: p2.id, checkedTagline: "test", model: "sonnet", errorCode: "timeout", updatedAt: ago(19 * H) },
    // 판정도 오류도 없는 행은 결과가 아니다
    { productId: p3.id, checkedTagline: "test", model: "sonnet", updatedAt: ago(20) },
  ]);
  const tagline = (repo: string, minutes: number, errorCode: string | null) => ({ repo: `v8tag-${tag}/${repo}`, tagline: errorCode ? "" : "한 줄",
    source: "page" as const, model: "[MLX] qwen3.6-35b-heretic", sourceHash: "s", documentAt: ago(minutes + 1), errorCode, updatedAt: ago(minutes) });
  await db.insert(schema.crawlTaglines).values([tagline("a", 21, null), tagline("b", 22, "timeout")]);
});
afterAll(async () => {
  setReplica(undefined);
  await db.delete(schema.secondReviews).where(like(schema.secondReviews.repo, `v8slots-${tag}/%`));
  await db.delete(schema.crawlCandidates).where(like(schema.crawlCandidates.repo, `v8slots-${tag}/%`));
  await db.delete(schema.textTranslations).where(like(schema.textTranslations.sourceHash, `%-${tag}`));
  await db.delete(schema.crawlTaglines).where(like(schema.crawlTaglines.repo, `v8tag-${tag}/%`));
  await db.delete(schema.operationsObservations).where(like(schema.operationsObservations.key, jobDeferralKey(deferJob)));
  await resetTables();
});

const counts = (row: { calls1h: number; failed1h: number; calls: number; failed: number } | undefined) =>
  row && { calls1h: row.calls1h, failed1h: row.failed1h, calls: row.calls, failed: row.failed };

describe("모델 자리 24h(+최근 1시간) — UNION 가지마다", () => {
  it("정확한 자리(1차 · 2차 투표 · 예비 · 키워드 짓기 · 감사)와 근사 자리(결과 행)를 DB 시계 창으로 센다", async () => {
    const read = await readModelSlotWindows(slots);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.window).toBe("24h");
    expect(read.value.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const by = Object.fromEntries(read.value.rows.map((row) => [row.slot, row]));
    // 1차: 취소·규칙·관리자 결정·실행 중은 빼고, 3일 전은 창 밖
    expect(counts(by.first)).toEqual({ calls1h: 2, failed1h: 1, calls: 3, failed: 1 });
    expect(by.first.observed).toBe(FIRST);
    expect(by.first.agree1h).toBeNull();
    // 2차 투표: 취소는 빼고, 실패한 표는 일치에 넣지 않는다(일치 1 · 갈림 1). 다른 모델의 표는 이 자리가 아니다
    expect(counts(by["second-voter-1"])).toEqual({ calls1h: 3, failed1h: 1, calls: 3, failed: 1 });
    expect(by["second-voter-1"].agree1h).toBe(0.5);
    expect(by["second-voter-1"].observed).toBe(VOTER);
    expect(counts(by["second-fallback-1"])).toEqual({ calls1h: 1, failed1h: 0, calls: 1, failed: 0 });
    expect(by["second-fallback-1"].agree1h).toBe(1);
    // 키워드 짓기: 생성 시각(성공)과 오류로 다시 쓴 시각(실패) — 모델 카드와 같다
    expect(counts(by.keywords)).toEqual({ calls1h: 2, failed1h: 1, calls: 3, failed: 1 });
    expect(counts(by.audit)).toEqual({ calls1h: 2, failed1h: 1, calls: 2, failed: 1 });
    expect(counts(by["keyword-verify"])).toEqual({ calls1h: 2, failed1h: 1, calls: 2, failed: 1 });
    expect(by["keyword-verify"].observed).toBe("[supa] Qwen3.8-27B-NVFP4");
    expect(counts(by.embedding)).toEqual({ calls1h: 1, failed1h: 0, calls: 1, failed: 0 });
    expect(counts(by["product-translate"])).toEqual({ calls1h: 1, failed1h: 0, calls: 2, failed: 1 });
    expect(counts(by["reason-translate"])).toEqual({ calls1h: 1, failed1h: 0, calls: 2, failed: 1 });
    expect(counts(by["tagline-ko"])).toEqual({ calls1h: 2, failed1h: 1, calls: 2, failed: 1 });
    expect(counts(by["intro-check"])).toEqual({ calls1h: 1, failed1h: 0, calls: 2, failed: 1 });
    expect(counts(by.tagline)).toEqual({ calls1h: 2, failed1h: 1, calls: 2, failed: 1 });
  });

  it("7일 창은 24시간 밖의 호출까지 센다", async () => {
    const read = await readModelSlotWeek(slots);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.window).toBe("7d");
    const by = Object.fromEntries(read.value.rows.map((row) => [row.slot, row]));
    expect(by.first).toMatchObject({ calls: 4, failed: 1 });
    expect(by["second-voter-1"]).toMatchObject({ calls: 4, failed: 1 });
    expect(by["second-voter-1"].agree).toBeCloseTo(2 / 3, 5);
    expect(by.audit).toMatchObject({ calls: 3, failed: 1 });
    expect(by.embedding).toMatchObject({ calls: 2, failed: 0 });
    // 10일 전 사유 번역은 7일 밖
    expect(by["reason-translate"]).toMatchObject({ calls: 2, failed: 1 });
  });

  it("2차 자리가 없는 설정도 읽힌다(가지가 빠져도 문장이 선다)", async () => {
    const lone = resolveModelSlots({ ...settings, secondReview: { ...settings.secondReview, voters: [], fallbacks: [] } }, {});
    const read = await readModelSlotWindows(lone);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.rows.some((row) => row.slot.startsWith("second-"))).toBe(false);
  });

  it("복제본이 없으면 보류", async () => {
    setReplica(undefined);
    try {
      // 다른 자리 목록(열쇠)이라 캐시를 타지 않는다
      expect(await readModelSlotWeek(slots.slice(1))).toEqual({ ok: false, reason: "no_replica" });
    } finally { setReplica(TEST_DATABASE_URL); }
  });
});

describe("미룬 이유(defer:<job>)", () => {
  it("복제본 범위에서 최근 1시간 이유별 수와 DB 시각을 읽고, 복제본이 없으면 보류", async () => {
    await writeJobDeferral({ key: jobDeferralKey(deferJob), reason: "model_capacity", counts: { model_capacity: 3 } });
    const read = await readDeferrals(true);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(read.value.jobs.find((row) => row.job === deferJob)).toMatchObject({ reason: "model_capacity", lastHour: 3, lastHourByReason: { model_capacity: 3 } });
    setReplica(undefined);
    try {
      // 새로고침은 15초 캐시를 건너뛴다 — 다시 읽으려다 복제본이 없으면 보류
      expect(await readDeferrals(true)).toEqual({ ok: false, reason: "no_replica" });
    } finally { setReplica(TEST_DATABASE_URL); }
  });
});
