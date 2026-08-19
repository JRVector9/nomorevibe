import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const safeFetch = vi.fn();
vi.mock("@/lib/net/fetch", () => ({
  safeFetch: (...a: unknown[]) => safeFetch(...a),
  fetchPage: vi.fn(),
  readBodyCapped: vi.fn(),
}));

const { db } = await import("@/lib/db");
const { productHealth, productHealthDaily, jobs } = await import("@/lib/db/schema");
const repo = await import("@/lib/domain/products/repository");
const { nextToCheck, recordPing, downProducts, healthMetrics, RECHECK_AFTER_MINUTES } = await import(
  "@/lib/domain/products/health"
);
const { pingProducts } = await import("@/lib/jobs/products/uptime");
const { runJob } = await import("@/lib/jobs/runner");
const { ensureSchema, resetTables } = await import("./setup");

async function product(slug: string, url: string, status: "verified" | "seeded" | "unverified" = "seeded") {
  await repo.insert({
    slug,
    url,
    name: slug,
    tagline: "소개",
    description: "설명",
    category: "Other",
    stack: [],
    status,
    source: status === "seeded" ? "crawler" : "skill",
    verifyToken: `nmv_verify_${slug}`,
    editTokenHash: "x".repeat(64),
  });
}

const alive = () => safeFetch.mockResolvedValue({ finalUrl: "x", response: { status: 200 } });
const dead = () => safeFetch.mockResolvedValue(null);

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(productHealth);
  await db.delete(jobs);
  await resetTables();
  safeFetch.mockReset();
});

describe("생존 확인", () => {
  it("확인한 적 없는 제품을 먼저 본다", async () => {
    await product("a", "https://a.test");
    await product("b", "https://b.test");
    await recordPing("a", 200);
    // a는 재검사 간격이 지난 것으로 둬야 순서 비교가 된다
    await db
      .update(productHealth)
      .set({ checkedAt: new Date(Date.now() - (RECHECK_AFTER_MINUTES + 1) * 60_000) });

    expect((await nextToCheck(5)).map((t) => t.slug)).toEqual(["b", "a"]);
  });

  it("방금 확인한 것은 다시 보지 않는다", async () => {
    // 없으면 제품이 배치보다 적을 때 같은 사이트를 하루 144번 두드린다
    await product("a", "https://a.test");
    await recordPing("a", 200);

    expect(await nextToCheck(5)).toEqual([]);

    // 재검사 간격이 지나면 다시 대상이 된다
    await db
      .update(productHealth)
      .set({ checkedAt: new Date(Date.now() - (RECHECK_AFTER_MINUTES + 1) * 60_000) });
    expect((await nextToCheck(5)).map((t) => t.slug)).toEqual(["a"]);
  });

  it("잡이 본문 스트림을 닫는다 — 안 닫으면 연결이 쌓인다", async () => {
    await product("a", "https://a.test");
    const cancel = vi.fn().mockResolvedValue(undefined);
    safeFetch.mockResolvedValue({ finalUrl: "x", response: { status: 200, body: { cancel } } });

    await runJob("uptime-ping", pingProducts);

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("목록에 없는 상태는 확인하지 않는다", async () => {
    await product("pending", "https://pending.test", "unverified");
    expect(await nextToCheck(5)).toEqual([]);
  });

  it("연속 실패를 센다", async () => {
    await product("a", "https://a.test");
    await recordPing("a", 0);
    await recordPing("a", 500);

    const [{ failures, downSince, status }] = await db.select().from(productHealth);
    expect({ failures, status }).toEqual({ failures: 2, status: 500 });
    expect(downSince).toBeInstanceOf(Date);
  });

  it("죽기 시작한 시각은 처음 실패한 때로 남는다", async () => {
    // 매번 갱신하면 얼마나 죽어 있었는지를 잃는다
    await product("a", "https://a.test");
    await recordPing("a", 0);
    const first = (await db.select().from(productHealth))[0].downSince;

    await recordPing("a", 0);

    expect((await db.select().from(productHealth))[0].downSince?.getTime()).toBe(first?.getTime());
  });

  it("한 번 살아나면 실패 기록이 지워진다", async () => {
    await product("a", "https://a.test");
    await recordPing("a", 0);
    await recordPing("a", 0);

    await recordPing("a", 200);

    const [row] = await db.select().from(productHealth);
    expect(row).toMatchObject({ failures: 0, downSince: null });
  });

  it("3xx는 살아 있는 것으로 본다", async () => {
    await product("a", "https://a.test");
    await recordPing("a", 301);
    expect((await db.select().from(productHealth))[0].failures).toBe(0);
  });

  it("잡이 결과를 기록한다 — 목록은 건드리지 않는다", async () => {
    await product("a", "https://a.test");
    dead();

    await runJob("uptime-ping", pingProducts);

    expect((await db.select().from(productHealth))[0]).toMatchObject({ status: 0, failures: 1 });
    // 죽었다고 자동으로 내리지 않는다
    expect((await repo.findBySlug("a"))?.status).toBe("seeded");
  });

  it("연속 실패가 쌓인 것만 어드민에 올린다", async () => {
    await product("a", "https://a.test");
    await product("b", "https://b.test");
    for (let i = 0; i < 3; i++) await recordPing("a", 0);
    await recordPing("b", 0);

    expect((await downProducts()).map((d) => d.slug)).toEqual(["a"]);
  });

  it("확인할 것이 없으면 사이클을 끝낸다", async () => {
    alive();
    expect(await runJob("uptime-ping", pingProducts)).toMatchObject({ done: true });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("KST 일별 성공률과 성공 응답 지연시간을 원자적으로 집계한다", async () => {
    await product("a", "https://a.test");
    await product("b", "https://b.test");
    const firstDay = new Date("2026-08-19T14:59:00.000Z");
    const secondDay = new Date("2026-08-19T15:01:00.000Z");

    await recordPing("a", 200, 120, firstDay);
    await recordPing("a", 503, null, firstDay);
    await recordPing("a", 204, 80, secondDay);

    expect(await db.select().from(productHealthDaily)).toEqual([
      {
        slug: "a",
        day: "2026-08-19",
        checks: 2,
        successes: 1,
        latencyTotalMs: 120,
        latencySamples: 1,
      },
      {
        slug: "a",
        day: "2026-08-20",
        checks: 1,
        successes: 1,
        latencyTotalMs: 80,
        latencySamples: 1,
      },
    ]);

    const metrics = await healthMetrics(["a", "b"], 30, secondDay);
    expect(metrics.get("a")).toEqual({ latencyMs: 80, uptimePercent: 66.7 });
    expect(metrics.get("b")).toEqual({ latencyMs: null, uptimePercent: null });
  });

  it("잡이 monotonic clock으로 측정한 성공 latency를 기록한다", async () => {
    await product("a", "https://a.test");
    const clock = vi.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(157);
    const cancel = vi.fn().mockResolvedValue(undefined);
    safeFetch.mockResolvedValue({ finalUrl: "x", response: { status: 200, body: { cancel } } });
    try {
      await runJob("uptime-ping", pingProducts);
    } finally {
      clock.mockRestore();
    }

    expect((await db.select().from(productHealth))[0].latencyMs).toBe(57);
    expect((await db.select().from(productHealthDaily))[0]).toMatchObject({
      checks: 1,
      successes: 1,
      latencyTotalMs: 57,
      latencySamples: 1,
    });
  });

  it("진행 중이던 확인 결과를 같은 slug의 재등록 제품에 붙이지 않는다", async () => {
    await product("reuse", "https://old.test");
    const oldProduct = await repo.findBySlug("reuse");
    let signalStarted!: () => void;
    let releaseResponse!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const responseReleased = new Promise<void>((resolve) => { releaseResponse = resolve; });
    safeFetch.mockImplementation(async () => {
      signalStarted();
      await responseReleased;
      return { finalUrl: "https://old.test", response: { status: 200 } };
    });
    const ping = pingProducts({
      cursor: null,
      save: async () => {},
      hasBudget: () => true,
      log: () => {},
    });
    await started;

    await repo.removeProductAndEvidence(oldProduct!.id, "reuse");
    await product("reuse", "https://replacement.test");
    releaseResponse();

    await expect(ping).rejects.toThrow(/product generation changed/);
    expect(await db.select().from(productHealth)).toHaveLength(0);
    expect(await db.select().from(productHealthDaily)).toHaveLength(0);
  });
});
