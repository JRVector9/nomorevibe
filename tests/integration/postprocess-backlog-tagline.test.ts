import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, productKoreanTaglines } from "@/lib/db/schema";
import { busyLogicalKeysSql, busyMemberKeysSql } from "@/lib/llm/capacity-busy-targets";
import { productTaglineKoInputHash, productTaglineKoLogicalWorkKey, type ProductTaglineKoMember } from "@/lib/llm/capacity";
import { requestProductTaglineKoModelSlot } from "@/lib/llm/capacity-repository";
import { koreanTaglineProgress, MAX_GATEWAY_FAILURES, pendingKoreanTaglines } from "@/lib/domain/products/korean-taglines";
import { readTextStageProgress } from "@/lib/operations/text-stage-progress";
import { classifyStage } from "@/lib/operations/worker-progress";
import { admin, cleanupCapacityFixture, fixtureOwner, policy, setCapacityMode, shadowRequests } from "./postprocess-backlog-fixture";
import { ensureSchema, resetTables } from "./setup";

const MODEL = "postprocess-backlog-tagline-model";
let serial = 0;
async function seed(extra: Partial<typeof productKoreanTaglines.$inferInsert> | null = null) {
  const slug = `pb-ko-${++serial}`, tagline = `A tool called ${slug} for teams`;
  const [row] = await db.insert(products).values({ slug, name: slug, url: `https://${slug}.test`, tagline, description: "d",
    category: "Dev", status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e", stars: 1_000 - serial,
    createdAt: sql`now() - interval '30 days'` as unknown as Date }).returning({ id: products.id, slug: products.slug });
  if (extra) await db.insert(productKoreanTaglines).values({ productId: row.id, sourceTagline: tagline, model: "m",
    retryAt: sql`now() - interval '1 minute'` as unknown as Date, updatedAt: sql`now() - interval '2 hours'` as unknown as Date, ...extra });
  return row;
}
const member = (productId: number, slug: string): ProductTaglineKoMember => ({ productId, slug, sourceIdentityHash: "a".repeat(64),
  sourceHash: "b".repeat(64), cache: { kind: "absent" } });
async function holdForeign(owner: { instanceId: string; bootId: string }, members: ProductTaglineKoMember[]) {
  const workKey = `${productTaglineKoLogicalWorkKey(members)}:${productTaglineKoInputHash({ members, model: MODEL })}`;
  const slot = await requestProductTaglineKoModelSlot({ requestId: randomUUID(), owner, workKey, class: "background", pool: "text",
    routeId: "product-tagline-ko", provider: "abcllm", model: MODEL }, members);
  expect(["granted", "deferred"]).toContain(slot.kind);
}

beforeAll(ensureSchema);
beforeEach(async () => {
  await resetTables();
  vi.stubEnv("KOREAN_TRANSLATION_QWEN_ENABLED", "false"); vi.stubEnv("KOREAN_TRANSLATION_QWEN_RECOVERY_ENABLED", "false");
});
afterEach(async () => { vi.unstubAllEnvs(); await cleanupCapacityFixture(); });
afterAll(() => admin.end({ timeout: 5 }));

it("stops re-selecting the same source after MAX_GATEWAY_FAILURES item failures and reports the terminal reason", async () => {
  expect(MAX_GATEWAY_FAILURES).toBe(10);
  const exhausted = await seed({ errorCode: "invalid_output", attempts: MAX_GATEWAY_FAILURES + 2, qualityRejections: 2 });
  const retrying = await seed({ errorCode: "invalid_output", attempts: MAX_GATEWAY_FAILURES - 1, qualityRejections: 0 });
  // 공급자 전체 장애는 제품 탓이 아니다 — 세지 않고 이어 간다(그동안은 upstream_stalled 경보가 알린다)
  const outage = await seed({ errorCode: "http_503", attempts: 25, qualityRejections: 0 });
  // 홈 제품은 두 번 더 본다(HOME_EXTRA_REJECTIONS) — 관측은 실제 홈 목록을 쓰므로 일반·홈 한도를 모두 넘긴 행으로 둔다
  const quality = await seed({ errorCode: "rejected:too_long", attempts: 6, qualityRejections: 6 });
  const fresh = await seed();
  const picked = (await pendingKoreanTaglines(8, [], undefined)).map(task => task.productId);
  expect(picked).toEqual([retrying.id, outage.id, fresh.id]);
  expect(picked).not.toContain(exhausted.id); expect(picked).not.toContain(quality.id);
  const progress = await koreanTaglineProgress();
  expect(progress).toMatchObject({ gaveUp: 2, failed: 2, waiting: 1 });
  expect(progress.gaveUpReasons).toEqual(expect.arrayContaining([{ reason: "failure_limit:invalid_output", count: 1 },
    { reason: "quality_limit:rejected:too_long", count: 1 }]));
  // 운영 관측도 같은 판정이다 — 손 뗀 두 건은 대기가 아니라 수동(manualAttention)으로 센다
  const stage = (await readTextStageProgress()).find(row => row.key === "tagline-ko")!;
  expect(stage).toMatchObject({ waiting: 3, manualAttention: 2 });
});

it("skips products another live request already holds, keeps the caller's own pending request, and only while capacity is open", async () => {
  const held = await seed(), free = await seed();
  await setCapacityMode("open", policy([{ routeId: "product-tagline-ko", model: MODEL }]));
  const other = fixtureOwner("tagline-other"), self = fixtureOwner("tagline-self");
  await holdForeign(other, [member(held.id, held.slug)]);
  expect((await pendingKoreanTaglines(8, [], self)).map(task => task.productId)).toEqual([free.id]);
  expect((await pendingKoreanTaglines(8, [], undefined)).map(task => task.productId)).toEqual([free.id]);
  // 같은 owner·boot 의 대기·예약은 조정기가 이어받는다 — 선택에서 빼지 않는다
  expect((await pendingKoreanTaglines(8, [], other)).map(task => task.productId)).toEqual([held.id, free.id]);
  // disabled(legacy) 경로에는 fence 가 없다 — 오래된 행이 대상을 가리지 않는다
  await setCapacityMode("disabled");
  expect((await pendingKoreanTaglines(8, [], self)).map(task => task.productId)).toEqual([held.id, free.id]);
});

it("treats waiting/reserved/dispatched requests of any owner as busy, but not indeterminate, settled or withdrawn ones", async () => {
  const own = randomUUID(), other = randomUUID();
  const rows = [
    { state: "indeterminate", owner: "a", boot: other, members: ["product-tagline-ko:1"] },
    { state: "dispatched", owner: "me", boot: own, members: ["product-tagline-ko:2"] },
    { state: "waiting", owner: "me", boot: own, members: ["product-tagline-ko:3"] },
    { state: "reserved", owner: "a", boot: other, members: ["product-tagline-ko:4", "product-tagline-ko:5"] },
    { state: "settled", owner: "a", boot: other, members: ["product-tagline-ko:6"] },
    { state: "withdrawn", owner: "a", boot: other, members: ["product-tagline-ko:7"] },
    { state: "indeterminate", owner: "a", boot: other, members: ["ko:" + "c".repeat(64)] },
  ];
  const keys = async (mode: string, keepOwn: boolean) => (await db.execute<{ key: string }>(sql`${shadowRequests(rows, mode)}
    ${busyMemberKeysSql("product-tagline-ko:", { owner: { instanceId: "me", bootId: own }, keepOwn })}`)).map(row => row.key).sort();
  // 2026-10-30: 미확인(indeterminate) 멤버는 busy 가 아니다 — 선택기가 숨기지 않는다.
  expect(await keys("open", true)).toEqual(["product-tagline-ko:2", "product-tagline-ko:4", "product-tagline-ko:5"]);
  expect(await keys("open", false)).toEqual(["product-tagline-ko:2", "product-tagline-ko:3", "product-tagline-ko:4", "product-tagline-ko:5"]);
  expect(await keys("disabled", true)).toEqual([]);
});

it("clears the stalled alarm once a passing line is stored in the last five minutes, without changing alarm rules", async () => {
  await seed({ errorCode: "rejected:too_long", attempts: 2, qualityRejections: 2,
    updatedAt: sql`now() - interval '40 minutes'` as unknown as Date });
  const pending = await seed();
  const now = new Date();
  const before = (await readTextStageProgress()).find(row => row.key === "tagline-ko")!;
  expect(classifyStage(before, null, true, now)).toMatchObject({ reason: "upstream_stalled", alarm: true });
  await db.insert(productKoreanTaglines).values({ productId: pending.id, sourceTagline: `A tool called ${pending.slug} for teams`,
    taglineKo: "팀을 위한 도구", model: "m", attempts: 1 });
  const after = (await readTextStageProgress()).find(row => row.key === "tagline-ko")!;
  expect(after).toMatchObject({ completed5m: 1 });
  expect(classifyStage(after, null, true, now)).toMatchObject({ reason: "progressing", alarm: false });
});

it("lets expired unstarted work reach admission again while preserving live, dispatched and unknown-deadline fences", async () => {
  const boot = randomUUID();
  const rows = [
    { state: "waiting", queueMs: -1_000 },
    { state: "reserved", reservedMs: -1_000 },
    { state: "waiting", queueMs: 60_000 },
    { state: "reserved", reservedMs: 60_000 },
    { state: "dispatched", queueMs: -1_000, reservedMs: -1_000 },
    { state: "waiting", queueMs: null },
    { state: "reserved", reservedMs: null },
  ].map((row, index) => ({ ...row, owner: "previous-boot", boot,
    members: [`product-tagline-ko:${index + 1}`], logical: `text:profile:${index + 1}` }));
  const members = await db.execute<{ key: string }>(sql`${shadowRequests(rows)} ${busyMemberKeysSql("product-tagline-ko:")}`);
  const logical = await db.execute<{ key: string }>(sql`${shadowRequests(rows)} ${busyLogicalKeysSql("text:profile:")}`);
  expect(members.map(row => row.key).sort()).toEqual([3, 4, 5, 6, 7].map(id => `product-tagline-ko:${id}`));
  expect(logical.map(row => row.key).sort()).toEqual([3, 4, 5, 6, 7].map(id => `text:profile:${id}`));
});
