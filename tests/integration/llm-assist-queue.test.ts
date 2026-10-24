import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { jobs, llmAssistControls, llmAssistWorks, products } from "@/lib/db/schema";
import { autoBanUptimeProduct, nextUptimeAutoBanTargets } from "@/lib/domain/products/uptime-auto-ban";
import { claimAssistWork, deferAssistClaim } from "@/lib/domain/llm-assist/repository";
import { product, takeJobLease } from "./uptime-split-fixture";
import { ensureSchema, resetTables } from "./setup";

beforeAll(ensureSchema);
async function resetControl() {
  await db.delete(llmAssistWorks).where(eq(llmAssistWorks.task, "uptime"));
  await db.delete(llmAssistControls).where(eq(llmAssistControls.task, "uptime"));
  await db.insert(llmAssistControls).values({ task: "uptime" });
}
beforeEach(async () => { await resetTables(); await resetControl(); await db.delete(jobs); });
afterAll(resetControl);
async function candidate(name: string) {
  const p = await product(name, { health: { failures: 10, status: 404, hoursAgo: 0.02 }, claim: false });
  return p;
}
async function confirm() {
  await db.update(llmAssistControls).set({ mode: "confirm", confirmationRequired: true, dispatchEnabled: true, revision: 2 });
}
const owner = { instanceId: "assist-queue-test", bootId: randomUUID() };

describe("비동기 uptime 확인 후보 큐", () => {
  it("제어 행 누락을 off로 간주해 기존 즉시 내림으로 우회하지 않는다", async () => {
    await db.delete(llmAssistControls).where(eq(llmAssistControls.task, "uptime"));
    const p = await candidate("assist-control-missing");
    await expect(autoBanUptimeProduct(p)).rejects.toThrow("assist_control_missing");
    expect((await db.select().from(products).where(eq(products.id, p.id)))[0].status).toBe("seeded");
  });
  it("기본 off는 기존 내림을 보존하고 shadow는 후보와 기존 내림을 함께 기록한다", async () => {
    const off = await candidate("assist-off");
    expect(await autoBanUptimeProduct(off)).toBe(true);
    expect(await db.select().from(llmAssistWorks)).toHaveLength(0);
    await db.update(llmAssistControls).set({ mode: "shadow" });
    const shadow = await candidate("assist-shadow");
    expect(await autoBanUptimeProduct(shadow)).toBe(true);
    expect(await db.select().from(llmAssistWorks)).toMatchObject([{ task: "uptime", state: "queued", productId: shadow.id }]);
  });

  it("confirm은 즉시 내리지 않고 같은 raw 관측을 중복 생성하거나 적체 앞에 반복 노출하지 않는다", async () => {
    await confirm();
    const p = await candidate("assist-confirm");
    // Keep nonzero microseconds deterministic; PostgreSQL ::text trims a clock timestamp's trailing zeros.
    const revision = "2020-01-01 00:00:00.123456";
    await db.execute(sql`update products set updated_at=${revision}::timestamp where id=${p.id}`);
    // Legacy callers pass the full product row; only the current candidate fields belong in the work snapshot.
    const [fullProduct] = await db.select().from(products).where(eq(products.id, p.id));
    await Promise.all([autoBanUptimeProduct(fullProduct), autoBanUptimeProduct(fullProduct)]);
    expect((await db.select().from(products).where(eq(products.id, p.id)))[0].status).toBe("seeded");
    const [work] = await db.select().from(llmAssistWorks);
    if (work.source.kind !== "uptime") throw new Error("unexpected_task");
    expect(work.source.product).toEqual({ id: p.id, slug: p.slug, url: p.url, updatedAt: revision });
    expect(await db.select().from(llmAssistWorks)).toHaveLength(1);
    expect(await nextUptimeAutoBanTargets(10)).toEqual([]);
    await db.execute(sql`update product_health set checked_at=checked_at + interval '1 microsecond' where slug=${p.slug}`);
    expect(await nextUptimeAutoBanTargets(10)).toMatchObject([{ id: p.id }]);
    expect(await autoBanUptimeProduct(p)).toBe(false);
    expect(await db.select().from(llmAssistWorks)).toHaveLength(2);
  });

  it("dispatch 중단과 off 전환도 확인 gate를 우회하지 않으며 latch 해제를 거부한다", async () => {
    await confirm();
    await db.update(llmAssistControls).set({ mode: "off", dispatchEnabled: false, applyEnabled: false, revision: 3 });
    const p = await candidate("assist-paused");
    expect(await autoBanUptimeProduct(p)).toBe(false);
    expect(await db.select().from(llmAssistWorks)).toHaveLength(1);
    await expect(db.update(llmAssistControls).set({ confirmationRequired: false })).rejects.toThrow();
  });

  it("동시 소비자는 하나만 claim하고 원 작업 pause와 raw 관측 변경을 존중한다", async () => {
    await confirm();
    const p = await candidate("assist-claim");
    const lease = await takeJobLease();
    await autoBanUptimeProduct(p);
    await db.update(jobs).set({ notBefore: new Date(Date.now() + 60_000) }).where(eq(jobs.name, "uptime-ping"));
    expect(await claimAssistWork({ lease, owner, backendId: "gpu-qwen", tasks: ["uptime"] })).toBeNull();
    await db.update(jobs).set({ notBefore: null });
    const claims = await Promise.all([0, 1].map(() => claimAssistWork({ lease, owner, backendId: "gpu-qwen", tasks: ["uptime"] })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    expect(await deferAssistClaim(claim, "waiting_capacity", "full")).toBe(true);
    expect((await db.select().from(llmAssistWorks))[0].attempts).toBe(0);
    await db.execute(sql`update product_health set checked_at=checked_at + interval '1 microsecond' where slug=${p.slug}`);
    expect(await claimAssistWork({ lease, owner, backendId: "gpu-qwen", tasks: ["uptime"] })).toBeNull();
  });
});
