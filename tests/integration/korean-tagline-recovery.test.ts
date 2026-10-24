import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs, modelCapacityControl, products, productKoreanTaglines } from "@/lib/db/schema";
import { KOREAN_TRANSLATION_QWEN_MODEL } from "@/lib/crawl/korean-translation-config";
import { koreanTaglineQueue, pendingKoreanTaglines, pendingKoreanTaglineRecovery, recordKoreanTaglines,
  type KoreanTaglineResult, type KoreanTaglineTask } from "@/lib/domain/products/korean-taglines";
import { runJob } from "@/lib/jobs/runner";
import { ensureSchema, resetTables } from "./setup";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.insert(modelCapacityControl).values({ id: 1, mode: "disabled" }).onConflictDoUpdate({
    target: modelCapacityControl.id, set: { mode: "disabled", policy: null, policyHash: null },
  });
  vi.stubEnv("KOREAN_TRANSLATION_QWEN_ENABLED", "false");
  vi.stubEnv("KOREAN_TRANSLATION_QWEN_RECOVERY_ENABLED", "false");
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await resetTables();
  await db.delete(jobs).where(sql`${jobs.name} like 'ko-recovery-proof-%'`);
  await db.insert(modelCapacityControl).values({ id: 1, mode: "disabled" }).onConflictDoUpdate({
    target: modelCapacityControl.id, set: { mode: "disabled", policy: null, policyHash: null },
  });
});

const GPT = "[MLX] gpt-oss-120b";
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 2, providerLimits: { account: 2 }, groupLimits: { engine: 2 },
  poolLimits: { reviewer: 2, text: 2 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12,
  queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "product-tagline-ko", provider: "abcllm", model: GPT, providerBudgetId: "account", groupId: "engine" }] };
let serial = 0;
function enable() {
  vi.stubEnv("KOREAN_TRANSLATION_QWEN_ENABLED", "true");
  vi.stubEnv("KOREAN_TRANSLATION_QWEN_RECOVERY_ENABLED", "true");
}
async function seed(slug: string, cache: Partial<typeof productKoreanTaglines.$inferInsert> | null = {},
  values: Partial<typeof products.$inferInsert> = {}) {
  const tagline = `Track tasks with ${slug}`;
  const [product] = await db.insert(products).values({ slug, name: slug, url: `https://${slug}.test`, tagline,
    description: "A task tracker", category: "Dev", status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e",
    createdAt: sql`now() - interval '30 days'` as unknown as Date, ...values,
  }).returning({ id: products.id });
  if (cache) await db.insert(productKoreanTaglines).values({ productId: product.id, sourceTagline: tagline,
    attempts: 4, qualityRejections: 4, errorCode: "rejected:empty", model: GPT, ...cache });
  return product.id;
}
const row = async (id: number) => (await db.select().from(productKoreanTaglines)
  .where(eq(productKoreanTaglines.productId, id)))[0];
const ids = (tasks: KoreanTaglineTask[]) => tasks.map(task => task.productId).sort((a, b) => a - b);
async function record(task: KoreanTaglineTask, result: KoreanTaglineResult) {
  await runJob(`ko-recovery-proof-${++serial}`, async ctx => {
    expect(await recordKoreanTaglines([{ task, result }], ctx.lease!)).toBe(1);
    return { done: true };
  });
}

describe("bounded alternative-model Korean translation recovery", () => {
  it("requires both opt-ins and leaves the original selector unchanged", async () => {
    const id = await seed("flag-boundary");
    expect(await pendingKoreanTaglineRecovery(8, [])).toEqual([]);
    expect(await koreanTaglineQueue([])).toMatchObject({ ready: 0, recoveryReady: 0, blocked: 1 });
    vi.stubEnv("KOREAN_TRANSLATION_QWEN_ENABLED", "true");
    expect(await pendingKoreanTaglineRecovery(8, [])).toEqual([]);
    vi.stubEnv("KOREAN_TRANSLATION_QWEN_ENABLED", "false");
    vi.stubEnv("KOREAN_TRANSLATION_QWEN_RECOVERY_ENABLED", "true");
    expect(await pendingKoreanTaglineRecovery(8, [])).toEqual([]);
    enable();
    expect(ids(await pendingKoreanTaglineRecovery(8, []))).toEqual([id]);
    expect(await pendingKoreanTaglines(8, [])).toEqual([]);
    expect(await row(id)).toMatchObject({ attempts: 4, qualityRejections: 4, model: GPT });
  });

  it("requires disabled capacity in both recovery selection and counts while ordinary work stays ready", async () => {
    enable();
    const normal = await seed("capacity-normal", { qualityRejections: 3 });
    const recovery = await seed("capacity-recover");
    await seed("capacity-recover-future", { retryAt: new Date("2100-01-01") });
    for (const mode of ["open", "draining", "disabled"] as const) {
      await db.update(modelCapacityControl).set({ mode, policy, policyHash: modelCapacityPolicyHash(policy) })
        .where(eq(modelCapacityControl.id, 1));
      expect(ids(await pendingKoreanTaglines(8, []))).toEqual([normal]);
      expect(ids(await pendingKoreanTaglineRecovery(8, []))).toEqual(mode === "disabled" ? [recovery] : []);
      const queue = await koreanTaglineQueue([]);
      expect(queue).toMatchObject(mode === "disabled"
        ? { eligible: 3, ready: 2, recoveryReady: 1, retryScheduled: 1, blocked: 0 }
        : { eligible: 3, ready: 1, recoveryReady: 0, retryScheduled: 0, blocked: 2 });
      expect(queue.done + queue.ready + queue.retryScheduled + queue.blocked).toBe(queue.eligible);
    }
    await db.delete(modelCapacityControl).where(eq(modelCapacityControl.id, 1));
    expect(await pendingKoreanTaglineRecovery(8, [])).toEqual([]);
    expect(await koreanTaglineQueue([])).toMatchObject({ ready: 1, recoveryReady: 0, blocked: 2 });
  });

  it("accepts only the exact current general4/home6 threshold, below10 attempts, another model and due time", async () => {
    enable();
    const normal = await seed("normal-four");
    const home = await seed("home-six", { attempts: 6, qualityRejections: 6 });
    await seed("normal-three", { attempts: 3, qualityRejections: 3 });
    await seed("normal-five", { attempts: 5, qualityRejections: 5 });
    await seed("home-five", { attempts: 5, qualityRejections: 5 });
    await seed("home-seven", { attempts: 7, qualityRejections: 7 });
    await seed("ten-attempts", { attempts: 10 });
    await seed("already-qwen", { model: KOREAN_TRANSLATION_QWEN_MODEL });
    await seed("future", { retryAt: new Date("2100-01-01") });
    await seed("done", { errorCode: null, taglineKo: "이미 옮긴 소개" });
    await seed("changed", { sourceTagline: "Old input" });
    await seed("private", {}, { status: "banned" });
    await seed("already-korean", {}, { tagline: "이미 한국어로 쓰인 제품 소개" });
    await seed("empty", {}, { tagline: " " });
    expect(ids(await pendingKoreanTaglineRecovery(8, ["home-six", "home-five", "home-seven"])))
      .toEqual([normal, home].sort((a, b) => a - b));
  });

  it("keeps ready, recovery-ready, scheduled and blocked disjoint within one canonical queue", async () => {
    enable();
    const fresh = await seed("fresh", null);
    await seed("done", { errorCode: null, taglineKo: "이미 옮긴 소개" });
    const due = await seed("ordinary-due", { attempts: 3, qualityRejections: 3 });
    await seed("ordinary-future", { attempts: 3, qualityRejections: 3, retryAt: new Date("2100-01-01") });
    const recovery = await seed("recover-due");
    await seed("recover-future", { retryAt: new Date("2100-01-01") });
    const homeRecovery = await seed("home-recover", { attempts: 6, qualityRejections: 6 });
    await seed("beyond-threshold", { attempts: 5, qualityRejections: 5 });
    await seed("already-qwen", { model: KOREAN_TRANSLATION_QWEN_MODEL });
    const homeOrdinary = await seed("home-ordinary");
    const home = ["home-recover", "home-ordinary"];
    const queue = await koreanTaglineQueue(home);
    expect(queue).toMatchObject({ eligible: 10, done: 1, ready: 5, recoveryReady: 2, retryScheduled: 2, blocked: 2 });
    const ordinary = await pendingKoreanTaglines(20, home);
    const extra = await pendingKoreanTaglineRecovery(8, home, ordinary.map(task => task.productId));
    expect(ids(ordinary)).toEqual([fresh, due, homeOrdinary].sort((a, b) => a - b));
    expect(ids(extra)).toEqual([recovery, homeRecovery].sort((a, b) => a - b));
    expect(new Set([...ordinary, ...extra].map(task => task.productId)).size).toBe(queue.ready);
    expect(queue.done + queue.ready + queue.retryScheduled + queue.blocked).toBe(queue.eligible);
  });

  it("caps selection at8 and respects excluded IDs without resetting or changing rows", async () => {
    enable();
    const seeded = [];
    for (let i = 0; i < 11; i++) seeded.push(await seed(`bounded-${i}`, {}, { stars: i }));
    const excluded = seeded.at(-1)!;
    const selected = await pendingKoreanTaglineRecovery(100, [], [excluded, excluded, -1, Number.NaN]);
    expect(selected).toHaveLength(8);
    expect(selected.some(task => task.productId === excluded)).toBe(false);
    expect(new Set(selected.map(task => task.productId)).size).toBe(8);
    expect(await pendingKoreanTaglineRecovery(0, [])).toEqual([]);
    expect(await pendingKoreanTaglineRecovery(Number.POSITIVE_INFINITY, [])).toEqual([]);
    expect(await row(excluded)).toMatchObject({ attempts: 4, qualityRejections: 4, model: GPT });
  });

  it("reclassifies home entry/exit conservatively and sends changed sources to normal work", async () => {
    enable();
    const four = await seed("home-switch-four");
    const six = await seed("home-switch-six", { attempts: 6, qualityRejections: 6 });
    expect(ids(await pendingKoreanTaglineRecovery(8, []))).toEqual([four]);
    expect(ids(await pendingKoreanTaglineRecovery(8, ["home-switch-four", "home-switch-six"]))).toEqual([six]);
    expect(ids(await pendingKoreanTaglines(8, ["home-switch-four", "home-switch-six"]))).toEqual([four]);
    await db.update(products).set({ tagline: "Plan travel with friends" }).where(eq(products.id, four));
    expect(await pendingKoreanTaglineRecovery(8, [])).toEqual([]);
    expect((await pendingKoreanTaglines(8, [])).find(task => task.productId === four))
      .toMatchObject({ attempts: 0, lastError: null, tagline: "Plan travel with friends" });
    expect(await row(four)).toMatchObject({ attempts: 4, qualityRejections: 4 });
  });

  it("closes quality failures above the threshold while preserving cumulative counters", async () => {
    enable();
    const id = await seed("quality-closes");
    const [task] = await pendingKoreanTaglineRecovery(8, []);
    await record(task, { kind: "failure", error: "rejected:too_long", model: KOREAN_TRANSLATION_QWEN_MODEL });
    await db.update(productKoreanTaglines).set({ retryAt: null }).where(eq(productKoreanTaglines.productId, id));
    expect(await row(id)).toMatchObject({ attempts: 5, qualityRejections: 5, model: KOREAN_TRANSLATION_QWEN_MODEL });
    expect(await pendingKoreanTaglineRecovery(8, [])).toEqual([]);
    expect(await koreanTaglineQueue([])).toMatchObject({ recoveryReady: 0, ready: 0, blocked: 1 });
  });

  it("closes a Qwen network failure without pretending it was another quality rejection", async () => {
    enable();
    const id = await seed("network-closes");
    const [task] = await pendingKoreanTaglineRecovery(8, []);
    await record(task, { kind: "failure", error: "timeout", model: KOREAN_TRANSLATION_QWEN_MODEL });
    await db.update(productKoreanTaglines).set({ retryAt: null }).where(eq(productKoreanTaglines.productId, id));
    expect(await row(id)).toMatchObject({ attempts: 5, qualityRejections: 4, errorCode: "timeout", model: KOREAN_TRANSLATION_QWEN_MODEL });
    expect(await pendingKoreanTaglineRecovery(8, [])).toEqual([]);
    expect(await koreanTaglineQueue([])).toMatchObject({ recoveryReady: 0, ready: 0, blocked: 1 });
  });

  it("remains bounded at10 even if another model overwrites last-model between network attempts", async () => {
    enable();
    const id = await seed("finite-not-a-model-ledger");
    for (let attempt = 4; attempt < 10; attempt++) {
      const stored = await row(id);
      const task = { productId: id, name: "finite-not-a-model-ledger", tagline: stored.sourceTagline,
        repoUrl: null, attempts: stored.attempts, lastError: stored.errorCode };
      const model = attempt % 2 === 0 ? KOREAN_TRANSLATION_QWEN_MODEL : GPT;
      await record(task, { kind: "failure", error: "timeout", model });
      await db.update(productKoreanTaglines).set({ retryAt: null }).where(eq(productKoreanTaglines.productId, id));
      const candidates = await pendingKoreanTaglineRecovery(8, []);
      expect(candidates).toHaveLength(model === GPT && attempt + 1 < 10 ? 1 : 0);
    }
    expect(await row(id)).toMatchObject({ attempts: 10, qualityRejections: 4 });
    expect(await pendingKoreanTaglineRecovery(8, [])).toEqual([]);
  });

  it("stores a successful recovery without deleting the original quality history", async () => {
    enable();
    const id = await seed("success-preserves");
    const [task] = await pendingKoreanTaglineRecovery(8, []);
    await record(task, { kind: "success", line: "일상의 할 일을 기록하는 도구", model: KOREAN_TRANSLATION_QWEN_MODEL });
    expect(await row(id)).toMatchObject({ attempts: 5, qualityRejections: 4, errorCode: null,
      taglineKo: "일상의 할 일을 기록하는 도구", model: KOREAN_TRANSLATION_QWEN_MODEL });
    expect(await pendingKoreanTaglineRecovery(8, [])).toEqual([]);
    expect(await koreanTaglineQueue([])).toMatchObject({ done: 1, ready: 0, recoveryReady: 0, blocked: 0 });
  });
});
