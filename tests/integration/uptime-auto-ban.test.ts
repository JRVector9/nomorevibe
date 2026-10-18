import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const { safeFetch, readBodyCapped, fetchPage } = vi.hoisted(() => ({
  safeFetch: vi.fn(), readBodyCapped: vi.fn(), fetchPage: vi.fn(),
}));
vi.mock("@/lib/net/fetch", () => ({ safeFetch, readBodyCapped, fetchPage }));
const leaseObserver = vi.hoisted(() => ({ afterCheck: null as (() => void) | null }));
vi.mock("@/lib/jobs/control", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/jobs/control")>();
  return { ...actual, assertJobLease: async (...args: Parameters<typeof actual.assertJobLease>) => {
    await actual.assertJobLease(...args);
    leaseObserver.afterCheck?.();
  }, assertJobLeaseAtWallTime: async (...args: Parameters<typeof actual.assertJobLeaseAtWallTime>) => {
    await actual.assertJobLeaseAtWallTime(...args);
    leaseObserver.afterCheck?.();
  } };
});

import { db } from "@/lib/db";
import { cdnPurges, crawlCandidates, crawlDocuments, jobs, operationsAudit, productEvidenceAudit, productHealth, productHealthDaily, products } from "@/lib/db/schema";
import { removeProductAndEvidence, setStatusWithAudit, update } from "@/lib/domain/products/repository";
import { autoBanUptimeProduct, nextUptimeAutoBanTargets } from "@/lib/domain/products/uptime-auto-ban";
import { downProducts, recordPing } from "@/lib/domain/products/health";
import { lockProductGeneration } from "@/lib/domain/products/generation";
import { pingProducts } from "@/lib/jobs/products/uptime";
import type { JobContext } from "@/lib/jobs/runner";
import { auditFloor, auditRowsAfter, ensureSchema, resetTables } from "./setup";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const ctx = (extra: Partial<JobContext<null>> = {}): JobContext<null> => ({
  cursor: null, save: async () => {}, hasBudget: () => true, log: () => {}, ...extra,
});
let floor = 0;

async function product(slug: string, failures?: number, checkedAt = ago(1)) {
  const [row] = await db.insert(products).values({
    slug, url: `https://${slug}.test`, name: slug, tagline: "소개", description: "설명", category: "Other",
    status: "seeded", verifyToken: "verify", editTokenHash: "x".repeat(64), updatedAt: ago(7 * 24 * 60),
  }).returning({ id: products.id, slug: products.slug, url: products.url });
  if (failures !== undefined) await db.insert(productHealth).values({
    slug, failures, checkedAt, status: 404, downSince: ago(72 * 60),
  });
  return row;
}

async function status(slug: string) {
  return (await db.select({ status: products.status }).from(products).where(eq(products.slug, slug)))[0]?.status;
}
async function autoAudits() { return auditRowsAfter(floor, "product-auto-ban-uptime"); }

beforeAll(ensureSchema);
beforeEach(async () => {
  vi.unstubAllEnvs();
  leaseObserver.afterCheck = null;
  await db.delete(jobs);
  await resetTables();
  floor = await auditFloor();
  // Future observations are deliberately rejected. Keep the fixture clock behind the actual DB
  // clock instead of racing millisecond host/container skew; real timers and lease time stay real.
  const [clock] = await db.execute<{ epoch: number }>(sql`select extract(epoch from clock_timestamp())::float8 * 1000 as epoch`);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Number(clock.epoch) - 1_000);
  safeFetch.mockReset();
  safeFetch.mockResolvedValue({ finalUrl: "https://example.test", response: { status: 404 } });
  readBodyCapped.mockReset();
  readBodyCapped.mockResolvedValue(Buffer.from(""));
  fetchPage.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("uptime 연속 실패 자동 내림", () => {
  it("9번째 실패는 유지하고 다음 10번째 실패에 상태·감사·purge를 한 번 기록한다", async () => {
    const target = await product("tenth-failure", 8, ago(7 * 60));
    await pingProducts(ctx());
    expect(await status(target.slug)).toBe("seeded");
    expect((await db.select().from(productHealth))[0].failures).toBe(9);
    expect(await autoAudits()).toEqual([]);

    await db.update(productHealth).set({ checkedAt: ago(7 * 60) });
    await pingProducts(ctx());
    expect(await status(target.slug)).toBe("banned");
    const [health] = await db.select().from(productHealth);
    const [evidence] = await db.select().from(productEvidenceAudit);
    expect(evidence).toMatchObject({ slug: target.slug, actor: "system:uptime", action: "admin.product.ban",
      reason: "uptime_consecutive_failures", metadata: {
        policy: "uptime_consecutive_failures", threshold: 10, consecutiveFailures: 10,
        lastStatus: 404, checkedAt: health.checkedAt!.toISOString(), downSince: health.downSince!.toISOString(),
        productId: target.id, url: target.url, status: "banned",
      } });
    const [operation] = await autoAudits();
    expect(operation).toMatchObject({ actor: "system:uptime", actorKind: "token", action: "product-auto-ban-uptime", target: target.slug,
      detail: { ...evidence.metadata, reason: "uptime_consecutive_failures" } });
    expect(operation.detail.note).toContain("10회");
    expect(operation.detail.note).toContain("404");
    expect(operation.detail.note).toContain(health.checkedAt!.toISOString());
    expect(await db.select().from(cdnPurges)).toMatchObject([{ slug: target.slug, reason: "banned" }]);

    await pingProducts(ctx());
    expect(await autoAudits()).toHaveLength(1);
    expect(await db.select().from(productEvidenceAudit)).toHaveLength(1);
    expect(await db.select().from(cdnPurges)).toHaveLength(1);
  });

  /**
   * 2026-10-15~19 운영에서는 다른 제품의 오래된 health 행 하나 때문에 잡의 연속 실패가 매번 1로 돌아가
   * 3회 숨김·10회 내림이 한 번도 일어나지 않았다(health.ts recordPing의 resetStreak). 실제 잡 경로로 센다.
   */
  it("다른 제품의 health 행이 더 오래돼도 실제 잡이 연속 실패를 세어 3회에 숨기고 10회에 내린다", async () => {
    await db.insert(products).values({ slug: "older-health", url: "https://older-health.test", name: "older-health", tagline: "소개",
      description: "설명", category: "Other", status: "unverified", verifyToken: "verify", editTokenHash: "x".repeat(64) });
    await db.insert(productHealth).values({ slug: "older-health", checkedAt: ago(30 * 24 * 60), status: 200 });
    const target = await product("streak-beside-older-health");
    for (let attempt = 1; attempt <= 10; attempt++) {
      await pingProducts(ctx());
      const [health] = await db.select().from(productHealth).where(eq(productHealth.slug, target.slug));
      expect(health.failures).toBe(attempt);
      expect((await downProducts()).map(row => row.slug)).toEqual(attempt >= 3 && attempt < 10 ? [target.slug] : []);
      if (attempt === 10) break;
      expect(await status(target.slug)).toBe("seeded");
      await db.update(productHealth).set({ checkedAt: ago(7 * 60) }).where(eq(productHealth.slug, target.slug));
    }
    expect(safeFetch).toHaveBeenCalledTimes(10);
    expect(await status(target.slug)).toBe("banned");
    const [operation] = await autoAudits();
    expect(operation.detail).toMatchObject({ consecutiveFailures: 10, lastStatus: 404, productId: target.id });
    expect(await db.select().from(cdnPurges)).toMatchObject([{ slug: target.slug, reason: "banned" }]);
  });

  it("이미 최근 확인한 10회 이상 적체도 추가 HTTP 없이 기존 배치 한도만 처리한다", async () => {
    vi.stubEnv("UPTIME_BATCH_SIZE", "2");
    await product("backfill-one", 10);
    await product("backfill-two", 12);
    await product("backfill-three", 15);
    await pingProducts(ctx());
    expect((await db.select().from(products)).filter(p => p.status === "banned")).toHaveLength(2);
    expect(await autoAudits()).toHaveLength(2);
    expect(safeFetch).not.toHaveBeenCalled();
    await pingProducts(ctx());
    expect((await db.select().from(products)).every(p => p.status === "banned")).toBe(true);
    expect(await autoAudits()).toHaveLength(3);
  });

  it("오래된 10회 결과는 재접속 성공이면 회복시키고 내리지 않는다", async () => {
    const target = await product("recovered", 10, ago(7 * 60));
    safeFetch.mockResolvedValue({ finalUrl: target.url, response: { status: 200 } });
    await pingProducts(ctx());
    expect(await status(target.slug)).toBe("seeded");
    expect((await db.select().from(productHealth))[0]).toMatchObject({ failures: 0, downSince: null, status: 200 });
    expect(await autoAudits()).toEqual([]);
    expect(await db.select().from(cdnPurges)).toEqual([]);
  });

  it("오래된 10회 결과도 정상 재접속이 다시 실패하면 새 관측으로 내린다", async () => {
    const target = await product("still-down", 10, ago(7 * 60));
    await pingProducts(ctx());
    expect(safeFetch).toHaveBeenCalledOnce();
    expect(await status(target.slug)).toBe("banned");
    expect((await autoAudits())[0].detail.consecutiveFailures).toBe(11);
  });

  it("관측 이후 제품 변경·미래 시각·성공 상태·실패 시작 없는 값은 적체로 내리지 않는다", async () => {
    await product("changed-product", 10);
    await db.update(products).set({ updatedAt: new Date(), url: "https://changed.test" })
      .where(eq(products.slug, "changed-product"));
    await product("future-observation", 10, ago(-60));
    await product("successful-observation", 10);
    await db.update(productHealth).set({ status: 200 }).where(eq(productHealth.slug, "successful-observation"));
    await product("no-streak-start", 10);
    await db.update(productHealth).set({ downSince: null }).where(eq(productHealth.slug, "no-streak-start"));
    await pingProducts(ctx());
    expect((await db.select().from(products)).every(p => p.status === "seeded")).toBe(true);
    expect(await autoAudits()).toEqual([]);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("HTTP 확인 중 URL이 바뀌면 옛 URL 결과·일별 기록·차단을 모두 버린다", async () => {
    const target = await product("url-changed-in-flight");
    safeFetch.mockImplementationOnce(async () => {
      await db.update(products).set({ url: "https://replacement.test", updatedAt: new Date() })
        .where(eq(products.id, target.id));
      return { finalUrl: target.url, response: { status: 404 } };
    });
    await pingProducts(ctx());
    expect(await db.select().from(productHealth)).toEqual([]);
    expect(await db.select().from(productHealthDaily)).toEqual([]);
    expect(await status(target.slug)).toBe("seeded");
    expect(await autoAudits()).toEqual([]);
  });

  it("URL 변경은 현재 연속 실패만 무효화하고 과거 일별 지표를 보존한다", async () => {
    const target = await product("url-new-streak", 15, ago(7 * 60));
    await db.insert(productHealthDaily).values({ slug: target.slug, day: "2026-10-14", checks: 15, successes: 0 });
    await update(target.id, { url: "https://new-streak.test" });
    expect(await db.select().from(productHealth)).toEqual([]);
    expect(await db.select().from(productHealthDaily)).toMatchObject([{ checks: 15, successes: 0 }]);
    await pingProducts(ctx());
    expect((await db.select().from(productHealth))[0]).toMatchObject({ failures: 1, status: 404 });
    expect(await status(target.slug)).toBe("seeded");
    expect(await autoAudits()).toEqual([]);
  });

  it("배포 전에 제품이 변경되어 URL 귀속을 모르는 과거 streak는 새 관측부터 다시 센다", async () => {
    const target = await product("legacy-url-uncertain", 15, ago(7 * 60));
    await db.update(products).set({ url: "https://legacy-new.test", updatedAt: new Date() })
      .where(eq(products.id, target.id));
    await pingProducts(ctx());
    const [health] = await db.select().from(productHealth);
    expect(health).toMatchObject({ failures: 1, status: 404 });
    expect(health.downSince).toEqual(health.checkedAt);
    expect(await status(target.slug)).toBe("seeded");
    expect(await autoAudits()).toEqual([]);
  });

  it("옛 runtime이 변경된 제품을 다시 확인했어도 streak 시작 이후 변경이면 내리지 않는다", async () => {
    const target = await product("legacy-already-rechecked", 16);
    await db.update(products).set({ updatedAt: ago(8 * 60) }).where(eq(products.id, target.id));
    expect(await nextUptimeAutoBanTargets(10)).toEqual([]);
    await pingProducts(ctx());
    expect(await status(target.slug)).toBe("seeded");
    expect(safeFetch).not.toHaveBeenCalled();
    await db.update(productHealth).set({ checkedAt: ago(7 * 60) });
    await pingProducts(ctx());
    expect((await db.select().from(productHealth))[0].failures).toBe(1);
    expect(await autoAudits()).toEqual([]);
  });

  it("관리자가 해제한 같은 관측으로 재차 내리지 않고 다음 실패 관측에는 정책을 적용한다", async () => {
    const target = await product("manual-unban", 10);
    await setStatusWithAudit({ ...target, status: "banned", action: "admin.product.ban" });
    await setStatusWithAudit({ ...target, status: "seeded", action: "admin.product.unban" });
    // 해제는 이전 관측 이후·다음 관측 이전이다. 호스트와 DB의 수 ms 시계 차이에 기대지 않는다.
    await db.update(productEvidenceAudit).set({ createdAt: ago(0.5) })
      .where(eq(productEvidenceAudit.action, "admin.product.unban"));
    // updatedAt 경계와 별개로 관리자 해제 시각을 직접 보호하는지 검증한다.
    await db.update(products).set({ updatedAt: ago(7 * 24 * 60) }).where(eq(products.id, target.id));
    await pingProducts(ctx());
    expect(await status(target.slug)).toBe("seeded");
    expect(await autoAudits()).toEqual([]);
    await db.update(productHealth).set({ checkedAt: ago(7 * 60) });
    await pingProducts(ctx());
    expect(await status(target.slug)).toBe("banned");
    expect((await autoAudits())[0].detail.consecutiveFailures).toBe(11);
  });

  /**
   * 광역 실패 보류는 확인 시각만 넘긴다. 10회 이상 행은 확인 시각이 곧 자동 내림의 최신성·관리자 해제 비교 기준이라
   * 보류가 그 창을 다시 열면 세지 않은 관측으로 내리게 된다 — 그 행은 건드리지 않는다.
   */
  it("광역 실패 보류는 9회를 10회로 만들지 않고 관리자가 풀어 준 10회 제품의 내림 창도 다시 열지 않는다", async () => {
    vi.stubEnv("UPTIME_BATCH_SIZE", "30");
    const nine = await product("held-nine", 9, ago(7 * 60));
    const unbanned = await product("held-unbanned", 10, ago(7 * 60));
    await setStatusWithAudit({ ...unbanned, status: "banned", action: "admin.product.ban" });
    await setStatusWithAudit({ ...unbanned, status: "seeded", action: "admin.product.unban" });
    // updatedAt 경계와 별개로 관리자 해제 시각 보호가 남는지 본다(위 "관리자가 해제한 같은 관측" 테스트와 같은 설정)
    await db.update(productEvidenceAudit).set({ createdAt: ago(0.5) })
      .where(eq(productEvidenceAudit.action, "admin.product.unban"));
    await db.update(products).set({ updatedAt: ago(7 * 24 * 60) }).where(eq(products.id, unbanned.id));
    for (let i = 0; i < 28; i++) await product(`held-new-${i}`);
    const events: string[] = [];

    // 30곳 모두 404 — 광역 실패로 보류한다
    await pingProducts(ctx({ log: event => { events.push(event); } }));

    expect(events).toContain("uptime.broad_failure_held");
    const health = new Map((await db.select().from(productHealth)).map(row => [row.slug, row]));
    expect(health.get(nine.slug)).toMatchObject({ failures: 9, status: 404 });
    expect(health.get(nine.slug)!.checkedAt.getTime()).toBeGreaterThan(ago(1).getTime());
    expect(health.get(unbanned.slug)).toMatchObject({ failures: 10, status: 404 });
    expect(health.get(unbanned.slug)!.checkedAt.getTime()).toBeLessThan(ago(6 * 60).getTime());
    expect(await nextUptimeAutoBanTargets(200)).toEqual([]);
    expect(await autoBanUptimeProduct(nine)).toBe(false);
    expect(await autoBanUptimeProduct(unbanned)).toBe(false);
    expect(await status(nine.slug)).toBe("seeded");
    expect(await status(unbanned.slug)).toBe("seeded");
    expect(await autoAudits()).toEqual([]);
    expect(await db.select().from(productHealthDaily)).toEqual([]);
  });

  it("봇·로그인 차단 응답은 연속 실패를 끊지 않지만 그 응답으로는 내리지 않는다 — 다음 404에 10회로 내린다", async () => {
    const target = await product("blocked-then-dead", 9, ago(7 * 60));
    safeFetch.mockResolvedValue({ finalUrl: target.url, response: { status: 403 } });
    await pingProducts(ctx());
    expect((await db.select().from(productHealth))[0]).toMatchObject({ failures: 9, status: 403 });
    expect(await status(target.slug)).toBe("seeded");
    expect(await autoAudits()).toEqual([]);

    await db.update(productHealth).set({ checkedAt: ago(7 * 60) });
    safeFetch.mockResolvedValue({ finalUrl: target.url, response: { status: 404 } });
    await pingProducts(ctx());
    expect(await status(target.slug)).toBe("banned");
    expect((await autoAudits())[0].detail).toMatchObject({ consecutiveFailures: 10, lastStatus: 404 });
  });

  it.each([401, 403, 429, 999])("마지막 응답이 HTTP %s면 10회 이상 적체도 자동 내림 대상이 아니다", async (code) => {
    const target = await product(`blocked-${code}`, 12);
    await db.update(productHealth).set({ status: code });
    expect(await nextUptimeAutoBanTargets(10)).toEqual([]);
    expect(await autoBanUptimeProduct(target)).toBe(false);
    await pingProducts(ctx());
    expect(await status(target.slug)).toBe("seeded");
    expect(await autoAudits()).toEqual([]);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("실제 관리자 해제는 제품 변경이므로 다음 실패부터 보수적으로 새 streak를 센다", async () => {
    const target = await product("manual-unban-current-edit", 10);
    await setStatusWithAudit({ ...target, status: "banned", action: "admin.product.ban" });
    await setStatusWithAudit({ ...target, status: "seeded", action: "admin.product.unban" });
    await pingProducts(ctx());
    expect(await status(target.slug)).toBe("seeded");
    expect(safeFetch).not.toHaveBeenCalled();
    await db.update(productHealth).set({ checkedAt: ago(7 * 60) });
    await pingProducts(ctx());
    const [health] = await db.select().from(productHealth);
    expect(health.failures).toBe(1);
    expect(health.downSince).toEqual(health.checkedAt);
    expect(await status(target.slug)).toBe("seeded");
    expect(await autoAudits()).toEqual([]);
  });

  it("URL 기록 없는 legacy는 같은 URL의 이름 수정도 보수적으로 새 streak로 취급한다", async () => {
    const target = await product("name-edit-uncertain-streak", 12, ago(7 * 60));
    await update(target.id, { name: "바뀐 이름" });
    await pingProducts(ctx());
    const [health] = await db.select().from(productHealth);
    expect(health.failures).toBe(1);
    expect(health.downSince).toEqual(health.checkedAt);
    expect(await status(target.slug)).toBe("seeded");
    expect(await autoAudits()).toEqual([]);
  });

  it("예산 소진과 취소는 최근 적체도 처리하지 않는다", async () => {
    await product("no-budget", 10);
    await pingProducts(ctx({ hasBudget: () => false }));
    const controller = new AbortController();
    controller.abort();
    await pingProducts(ctx({ signal: controller.signal }));
    expect(await status("no-budget")).toBe("seeded");
    expect(await autoAudits()).toEqual([]);
    expect(await db.select().from(cdnPurges)).toEqual([]);
  });

  it("HTTP 응답을 기다리다 취소되면 관측·일별 지표·자동 내림을 쓰지 않는다", async () => {
    const target = await product("cancelled-in-flight");
    const controller = new AbortController();
    safeFetch.mockImplementationOnce(async () => {
      controller.abort();
      return { finalUrl: target.url, response: { status: 404 } };
    });
    await pingProducts(ctx({ signal: controller.signal }));
    expect(await db.select().from(productHealth)).toEqual([]);
    expect(await db.select().from(productHealthDaily)).toEqual([]);
    expect(await autoAudits()).toEqual([]);
    expect(await status(target.slug)).toBe("seeded");
  });

  it("정상 lifecycle 잠금을 기다리다 취소되어도 10번째 관측을 커밋하지 않는다", async () => {
    const target = await product("cancelled-waiting-for-lock", 9, ago(7 * 60));
    const [before] = await db.select().from(productHealth);
    const controller = new AbortController();
    let acquired!: () => void;
    let release!: () => void;
    const held = new Promise<void>(resolve => { acquired = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => {
      await lockProductGeneration(tx, target.id, target.slug);
      acquired();
      await released;
    });
    await held;
    const pending = pingProducts(ctx({ signal: controller.signal }));
    let waiting = false;
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        const [row] = await db.execute<{ waiting: boolean }>(sql`select exists (
          select 1 from pg_stat_activity where datname = current_database() and wait_event = 'advisory'
        ) as waiting`);
        if (row.waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      controller.abort();
    } finally {
      release();
      await holder;
    }
    await pending;
    expect(waiting).toBe(true);
    expect(await db.select().from(productHealth)).toEqual([before]);
    expect(await db.select().from(productHealthDaily)).toEqual([]);
    expect(await autoAudits()).toEqual([]);
    expect(await status(target.slug)).toBe("seeded");
  });

  it("성공 응답 도중 URL이 바뀌면 옛 본문도 새 제품의 원본 문서에 쓰지 않는다", async () => {
    const target = await product("url-changed-success");
    const repo = "uptime-auto-ban/url-changed-success";
    await db.delete(crawlDocuments).where(eq(crawlDocuments.repo, repo));
    await db.delete(crawlCandidates).where(eq(crawlCandidates.repo, repo));
    await db.insert(crawlCandidates).values({ repo, state: "published", publishedSlug: target.slug });
    await db.insert(crawlDocuments).values({ repo, repoMeta: {}, pageMeta: { textSample: "보존할 이전 원본" } });
    safeFetch.mockImplementationOnce(async () => {
      await update(target.id, { url: "https://replacement-success.test" });
      return { finalUrl: target.url, response: { status: 200 } };
    });
    readBodyCapped.mockResolvedValue(Buffer.from("<html><body>이 본문은 교체 전 URL에서 읽은 본문입니다.</body></html>"));
    try {
      await pingProducts(ctx());
      const [document] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, repo));
      expect(document.pageMeta).toMatchObject({ textSample: "보존할 이전 원본" });
      expect(await db.select().from(productHealth)).toEqual([]);
    } finally {
      await db.delete(crawlDocuments).where(eq(crawlDocuments.repo, repo));
      await db.delete(crawlCandidates).where(eq(crawlCandidates.repo, repo));
    }
  });

  it("임대를 잃으면 기존 적체의 상태·두 감사·purge가 모두 롤백된다", async () => {
    await product("lost-backfill-lease", 10);
    const lease = { name: "uptime-ping", token: "old-owner", requestedVersion: 1 };
    await db.insert(jobs).values({ name: lease.name, leaseToken: "new-owner", lockedAt: sql`now()` });
    await expect(pingProducts(ctx({ lease }))).rejects.toThrow("job_lease_lost");
    expect(await status("lost-backfill-lease")).toBe("seeded");
    expect(await db.select().from(productEvidenceAudit)).toEqual([]);
    expect(await autoAudits()).toEqual([]);
    expect(await db.select().from(cdnPurges)).toEqual([]);
  });

  it("동시 중복 처리도 실제 전환과 두 감사·purge는 한 번만 만든다", async () => {
    const target = await product("duplicate-auto-ban", 13);
    expect((await Promise.all([autoBanUptimeProduct(target), autoBanUptimeProduct(target)])).sort()).toEqual([false, true]);
    expect(await status(target.slug)).toBe("banned");
    expect(await autoAudits()).toHaveLength(1);
    expect(await db.select().from(productEvidenceAudit)).toHaveLength(1);
    expect(await db.select().from(cdnPurges)).toHaveLength(1);
  });

  it("선택 후 회복했거나 현재 URL·공개 상태·접근 방식이 달라지면 잠금 아래 건너뛴다", async () => {
    const recovered = await product("recovered-after-selection", 10);
    expect(await nextUptimeAutoBanTargets(10)).toContainEqual(recovered);
    await recordPing(recovered.slug, 200, 10, new Date(), recovered.id);
    expect(await autoBanUptimeProduct(recovered)).toBe(false);

    const changed = await product("url-after-selection", 10);
    await db.update(products).set({ url: "https://new-current.test" }).where(eq(products.id, changed.id));
    expect(await autoBanUptimeProduct(changed)).toBe(false);

    const hidden = await product("no-longer-public", 10);
    await db.update(products).set({ status: "unverified" }).where(eq(products.id, hidden.id));
    expect(await autoBanUptimeProduct(hidden)).toBe(false);

    const installed = await product("now-installation", 10);
    await db.update(products).set({ accessMode: "installable" }).where(eq(products.id, installed.id));
    expect(await autoBanUptimeProduct(installed)).toBe(false);
    expect(await autoAudits()).toEqual([]);
    // 공개→unverified fixture 전환 자체의 purge만 있고 자동 banned purge는 없다.
    expect(await db.select().from(cdnPurges)).toMatchObject([{ slug: hidden.slug, reason: "unverified" }]);
  });

  it("삭제 후 같은 slug의 새 세대에는 이전에 선택한 자동 내림을 적용하지 않는다", async () => {
    const old = await product("recreated-generation", 10);
    expect(await removeProductAndEvidence(old.id, old.slug)).toBe(true);
    const replacement = await product(old.slug, 10);
    expect(replacement.id).not.toBe(old.id);
    expect(await autoBanUptimeProduct(old)).toBe(false);
    expect(await status(old.slug)).toBe("seeded");
    expect(await autoAudits()).toEqual([]);
    expect(await db.select().from(productEvidenceAudit)).toEqual([]);
  });

  it("제품 삭제로 제품 감사가 사라져도 append-only 운영 이력에 원본 근거가 남는다", async () => {
    const target = await product("retained-operation", 17);
    await autoBanUptimeProduct(target);
    const [operation] = await autoAudits();
    await setStatusWithAudit({ ...target, status: "seeded", action: "admin.product.unban" });
    expect(await removeProductAndEvidence(target.id, target.slug)).toBe(true);
    expect(await db.select().from(productEvidenceAudit)).toEqual([]);
    expect(await autoAudits()).toEqual([operation]);
    expect(operation.detail).toMatchObject({ productId: target.id, slug: target.slug, url: target.url,
      threshold: 10, consecutiveFailures: 17, lastStatus: 404, previousStatus: "seeded", status: "banned" });
    expect(operation.detail.checkedAt).toBeTypeOf("string");
    expect(operation.detail.downSince).toBeTypeOf("string");
  });

  it("정상 임대 확인 직후 취소도 자동 내림과 관측 트랜잭션을 커밋하지 않는다", async () => {
    const target = await product("cancelled-after-lease-check", 10);
    const [before] = await db.select().from(productHealth);
    const lease = { name: "uptime-ping", token: "current-owner", requestedVersion: 1 };
    await db.insert(jobs).values({ name: lease.name, leaseToken: lease.token, lockedAt: sql`now()` });
    const controller = new AbortController();
    leaseObserver.afterCheck = () => controller.abort();
    await expect(autoBanUptimeProduct(target, { lease, signal: controller.signal })).rejects.toThrow("uptime cancelled");
    expect(await status(target.slug)).toBe("seeded");
    expect(await db.select().from(productEvidenceAudit)).toEqual([]);
    expect(await autoAudits()).toEqual([]);
    expect(await db.select().from(cdnPurges)).toEqual([]);

    const next = new AbortController();
    leaseObserver.afterCheck = () => next.abort();
    await expect(recordPing(target.slug, 404, null, new Date(), target.id, lease, target.url, next.signal))
      .rejects.toThrow("uptime cancelled");
    expect(await db.select().from(productHealth)).toEqual([before]);
    expect(await db.select().from(productHealthDaily)).toEqual([]);
  });

  it("운영 감사 저장이 실패하면 상태·제품 감사·trigger purge도 같은 실제 DB TX에서 롤백된다", async () => {
    const target = await product("audit-store-failure", 10);
    const initializedDb = (globalThis as unknown as { db?: typeof db }).db;
    expect(initializedDb).toBeDefined();
    const transaction = initializedDb!.transaction.bind(initializedDb!);
    const fault = vi.spyOn(initializedDb!, "transaction").mockImplementationOnce((work, config) => transaction(async tx => {
      const insert = tx.insert.bind(tx);
      const insertFault = vi.spyOn(tx, "insert").mockImplementation(((table: Parameters<typeof tx.insert>[0]) => {
        if (table === operationsAudit) throw new Error("audit_store_unavailable");
        return insert(table);
      }) as typeof tx.insert);
      try { return await work(tx); }
      finally { insertFault.mockRestore(); }
    }, config));
    try {
      await expect(autoBanUptimeProduct(target)).rejects.toThrow("audit_store_unavailable");
    } finally { fault.mockRestore(); }
    expect(await status(target.slug)).toBe("seeded");
    expect(await db.select().from(productEvidenceAudit)).toEqual([]);
    expect(await autoAudits()).toEqual([]);
    expect(await db.select().from(cdnPurges)).toEqual([]);
  });
});
