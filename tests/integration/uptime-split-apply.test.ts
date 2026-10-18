import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cdnPurges, crawlCandidates, crawlDocuments, productEvidenceAudit, products } from "@/lib/db/schema";
import { writeHealthResult, writeHealthResults, type HealthResultInput } from "@/lib/domain/products/health-record";
import { downProducts, recordPing } from "@/lib/domain/products/health";
import { notDown } from "@/lib/domain/products/repository";
import { autoBanUptimeProduct } from "@/lib/domain/products/uptime-auto-ban";
import { claimUptimeProducts, submitUptimeResults, type UptimeClaimBatch, type UptimeClaimTicket } from "@/lib/domain/products/uptime-claims";
import { applyUptimeResults, type UptimeOwnResult } from "@/lib/domain/products/uptime-apply";
import { JobLeaseLostError, type JobLease } from "@/lib/jobs/control";
import { auditFloor, auditRowsAfter, ensureSchema, resetTables } from "./setup";
import { claimRow, clearSplitState, dailyRows, dbNow, healthRow, nextCycle, OWNERS, product, rawRows, result, setSplit, TAG,
  takeJobLease, type FixtureProduct } from "./uptime-split-fixture";

/*
 * U1b 묶음 적용기를 실제 PostgreSQL 에서 본다(design-uptime §8.1 4~14·16). 정식 기록의 의미가 legacy(recordPing·writeHealthResult·
 * autoBanUptimeProduct)와 같은지를 같은 입력의 쌍둥이 제품으로 비교한다. 시각은 DB 시계에서 잰다.
 */
let lease: JobLease;
let floor = 0;
let original: { split: Record<string, unknown>; control: Record<string, unknown> | undefined };
const REPO = `u1b-${TAG}`;

beforeAll(async () => {
  ensureSchema();
  const [split] = await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(c) as row from uptime_split_control c where id = 1`);
  const [control] = await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(c) as row from uptime_control c where id = 1`);
  original = { split: split.row, control: control?.row };
});
beforeEach(async () => {
  await resetTables();
  await clearSplitState();
  await db.execute(sql`delete from crawl_documents where repo like ${`${REPO}/%`}`);
  await db.execute(sql`delete from crawl_candidates where repo like ${`${REPO}/%`}`);
  await setSplit("claims");
  lease = await takeJobLease();
  floor = await auditFloor();
});
afterAll(async () => {
  await db.execute(sql`update uptime_split_control set mode = ${original.split.mode as string}, policy = null, policy_hash = null,
    epoch = epoch + 1, updated_at = clock_timestamp() where id = 1`);
  if (original.control) {
    await db.execute(sql`update uptime_control set observations_enabled = ${original.control.observations_enabled as boolean},
      gate_enabled = ${original.control.gate_enabled as boolean} where id = 1`);
  }
  await db.execute(sql`update jobs set lease_token = null, locked_at = null where name = 'uptime-ping'`);
  await db.execute(sql`delete from crawl_documents where repo like ${`${REPO}/%`}`);
  await db.execute(sql`delete from crawl_candidates where repo like ${`${REPO}/%`}`);
});

const claimed = async (owner: (typeof OWNERS)[keyof typeof OWNERS], limit: number): Promise<Extract<UptimeClaimBatch, { kind: "claimed" }>> => {
  const batch = await claimUptimeProducts({ owner, limit });
  if (batch.kind !== "claimed") throw new Error(`claim_blocked:${batch.reason}`);
  return batch;
};
const ticketOf = (batch: { claims: UptimeClaimTicket[] }, target: FixtureProduct) => {
  const ticket = batch.claims.find(claim => claim.productId === target.id);
  if (!ticket) throw new Error(`not_claimed:${target.slug}`);
  return ticket;
};
/** Oracle 이 claim·확인·제출까지 한 상태를 만든다 */
async function oracleSubmits(outcomes: [FixtureProduct, { status: number; kind?: UptimeOwnResult["kind"] }][]) {
  const batch = await claimed(OWNERS.oracle, 40);
  const submitted = await submitUptimeResults({ owner: OWNERS.oracle, results: outcomes.map(([target, outcome]) => result(ticketOf(batch, target), outcome)) });
  expect(submitted).toMatchObject({ kind: "submitted", lost: [] });
  return batch;
}
/** home(M3)이 claim 한 뒤 바로 적용한다(잡의 자기 결과 경로) */
async function homeChecks(outcomes: [FixtureProduct, { status: number; kind?: UptimeOwnResult["kind"]; textSample?: string }][], limit = 50) {
  const batch = await claimed(OWNERS.m3, limit);
  const own = outcomes.map(([target, outcome]) => ({ ...result(ticketOf(batch, target), outcome), textSample: outcome.textSample ?? null }));
  return applyUptimeResults({ lease, own });
}
async function hidden(target: FixtureProduct) {
  const [row] = await db.select({ hidden: sql<boolean>`not ${notDown}` }).from(products).where(eq(products.id, target.id));
  return row.hidden;
}
async function status(target: FixtureProduct) {
  return (await db.select({ status: products.status }).from(products).where(eq(products.id, target.id)))[0]?.status;
}

describe("판정 반영", () => {
  it("an Oracle success is applied like a home success: streak 0, daily +1, due six hours after the observation, no raw fact", async () => {
    const target = await product("oracle-ok");
    const batch = await oracleSubmits([[target, { status: 200 }]]);
    const summary = await applyUptimeResults({ lease });
    expect(summary).toMatchObject({ mode: "claims", remote: 1, own: 0, conflicts: 0, autoBanned: 0, textSamples: 0 });
    expect(summary.outcomes).toMatchObject({ applied: 1 });
    const health = await healthRow(target.slug);
    expect(health).toMatchObject({ status: 200, failures: 0, down_since: null, latency_ms: 120 });
    const observed = result(ticketOf(batch, target), { status: 200 }).observedAt;
    expect(new Date(`${health!.checked_at}Z`).getTime()).toBe(observed.getTime());
    expect(await dailyRows(target.slug)).toMatchObject([{ checks: 1, successes: 1, latency_total_ms: 120, latency_samples: 1 }]);
    const claim = await claimRow(target.id);
    expect(claim).toMatchObject({ state: "idle", token: null, last_outcome: "split_success", last_applied_host: "oracle-osaka-smoke", confirm_class: null });
    expect(claim.due_at.getTime()).toBe(observed.getTime() + 6 * 3_600_000);
    expect(await rawRows(target.slug)).toEqual([]);
    const [window] = await db.execute<{ host: string; checks: number; failures: number }>(sql`select host, checks, failures from uptime_host_windows`);
    expect(window).toEqual({ host: "oracle-osaka-smoke", checks: 1, failures: 0 });
  });

  it("regional difference: Oracle 403·0·500 never count but ask home to confirm; home success records the conflict and pins the product home for 7 days; home failure counts", async () => {
    const [forbidden, unreachable, broken, dead] = [await product("rd-403"), await product("rd-0"), await product("rd-500"), await product("rd-dead")];
    await oracleSubmits([[forbidden, { status: 403 }], [unreachable, { status: 0, kind: "timeout" }], [broken, { status: 500 }], [dead, { status: 0, kind: "dns" }]]);
    const before = await Promise.all([forbidden, unreachable, broken, dead].map(target => healthRow(target.slug)));
    const first = await applyUptimeResults({ lease });
    expect(first.outcomes).toMatchObject({ confirm_requested: 4, applied: 0 });
    expect(await Promise.all([forbidden, unreachable, broken, dead].map(target => healthRow(target.slug)))).toEqual(before);
    expect(await dailyRows(forbidden.slug)).toEqual([]);
    expect(await claimRow(forbidden.id)).toMatchObject({ state: "idle", confirm_class: "home", confirm_reason: "http:403", last_outcome: "split_confirm_required" });
    expect(await claimRow(unreachable.id)).toMatchObject({ confirm_reason: "timeout:0" });
    expect(await rawRows(forbidden.slug)).toMatchObject([{ host: "oracle-osaka-smoke", disposition: "raw_only", reason: "split_confirm_required", status: 403 }]);
    // 재확인 요청은 Oracle 이 다시 가져가지 않고 home 이 먼저 가져간다
    expect((await claimed(OWNERS.oracle, 40)).claims).toEqual([]);
    const second = await homeChecks([[forbidden, { status: 200 }], [unreachable, { status: 200 }], [broken, { status: 301 }], [dead, { status: 0, kind: "dns" }]]);
    expect(second.outcomes).toMatchObject({ applied: 4 });
    expect(second.conflicts).toBe(3);
    const wall = await dbNow();
    const pinned = await claimRow(forbidden.id);
    expect(pinned).toMatchObject({ state: "idle", confirm_class: null, conflict_count: 1, last_outcome: "split_confirm_success", last_applied_host: "m3" });
    expect(Math.abs(pinned.affinity_home_until!.getTime() - (wall.getTime() + 7 * 86_400_000))).toBeLessThan(60_000);
    expect(await healthRow(forbidden.slug)).toMatchObject({ failures: 0, status: 200 });
    expect(await rawRows(forbidden.slug)).toMatchObject([{ disposition: "raw_only" }, { host: "m3", disposition: "applied", reason: "split_confirm_success" }]);
    expect(await healthRow(dead.slug)).toMatchObject({ failures: 1, status: 0 });
    expect(await claimRow(dead.id)).toMatchObject({ conflict_count: 0, last_outcome: "split_confirmed" });
    expect((await rawRows(dead.slug)).map(row => row.reason)).toEqual(["split_confirm_required", "split_confirmed"]);
    // 7일 동안 Oracle 은 이 제품을 가져가지 않는다. 실패 중인 제품도 마찬가지다. home 은 가져간다
    await nextCycle(forbidden, dead);
    expect((await claimed(OWNERS.oracle, 40)).claims).toEqual([]);
    expect((await claimed(OWNERS.m3, 40)).claims.map(claim => claim.productId).sort((a, b) => a - b)).toEqual([forbidden.id, dead.id].sort((a, b) => a - b));
  });

  it("a Japan-only 403 every six hours for four cycles is never hidden or banned", async () => {
    const target = await product("japan-only");
    for (let cycle = 1; cycle <= 4; cycle++) {
      // 7일 고정이 풀린 것처럼 둔다 — 그래도 Oracle 실패는 세지 않는다
      await db.execute(sql`update uptime_claims set affinity_home_until = null where product_id = ${target.id}`);
      await oracleSubmits([[target, { status: 403 }]]);
      expect((await applyUptimeResults({ lease })).outcomes.confirm_requested).toBe(1);
      expect((await homeChecks([[target, { status: 200 }]])).outcomes.applied).toBe(1);
      expect(await healthRow(target.slug)).toMatchObject({ failures: 0 });
      await nextCycle(target);
    }
    expect(await claimRow(target.id)).toMatchObject({ conflict_count: 4 });
    expect(await hidden(target)).toBe(false);
    expect(await status(target)).toBe("seeded");
    expect(await auditRowsAfter(floor, "product-auto-ban-uptime")).toEqual([]);
    expect((await dailyRows(target.slug)).reduce((sum, row) => sum + row.checks, 0)).toBe(4);
  });

  it("product changes between claim and apply are stale and never touch the streak; a changed URL is due again now", async () => {
    const [moved, unlisted, edited, removed] = [await product("moved"), await product("unlisted"), await product("edited"), await product("removed")];
    const batch = await claimed(OWNERS.m3, 10);
    await db.update(products).set({ url: `https://moved-${TAG}.example/new` }).where(eq(products.id, moved.id));
    await db.update(products).set({ status: "unverified" }).where(eq(products.id, unlisted.id));
    await db.execute(sql`update products set updated_at = clock_timestamp() at time zone 'UTC' where id = ${edited.id}`);
    await db.delete(products).where(eq(products.id, removed.id));
    const before = await Promise.all([moved, unlisted, edited].map(target => healthRow(target.slug)));
    const summary = await applyUptimeResults({ lease, own: [moved, unlisted, edited, removed].map(target => result(ticketOf(batch, target), { status: 0 })) });
    const reason = (target: FixtureProduct) => summary.decisions.find(decision => decision.productId === target.id)?.reason;
    expect([reason(moved), reason(unlisted), reason(edited), reason(removed)]).toEqual(["url_changed", "product_unlisted", "product_changed", "claim_lost"]);
    expect(await Promise.all([moved, unlisted, edited].map(target => healthRow(target.slug)))).toEqual(before);
    expect(await dailyRows(moved.slug)).toEqual([]);
    const wall = await dbNow();
    const movedClaim = await claimRow(moved.id);
    expect(movedClaim).toMatchObject({ state: "idle", token: null, last_outcome: "url_changed" });
    expect(movedClaim.due_at.getTime()).toBeLessThanOrEqual(wall.getTime());
    expect(await claimRow(edited.id)).toMatchObject({ state: "idle", last_outcome: "product_changed" });
  });

  it("a legacy write inside six hours is held (minimum_interval) or stale (older), so nothing is applied twice", async () => {
    const [near, newer] = [await product("legacy-near"), await product("legacy-newer")];
    const batch = await claimed(OWNERS.m3, 10);
    const ownNear = result(ticketOf(batch, near), { status: 0 }), ownNewer = result(ticketOf(batch, newer), { status: 0 });
    // legacy 잡이 같은 제품을 먼저 기록했다: near 는 home 관측 5시간 전, newer 는 home 관측보다 뒤
    await recordPing(near.slug, 200, 50, new Date(ownNear.observedAt.getTime() - 5 * 3_600_000), near.id, undefined, near.url);
    await recordPing(newer.slug, 200, 50, new Date(ownNewer.observedAt.getTime() + 500), newer.id, undefined, newer.url);
    const summary = await applyUptimeResults({ lease, own: [ownNear, ownNewer] });
    expect(summary.reasons).toMatchObject({ minimum_interval: 1, older_observation: 1 });
    expect(await healthRow(near.slug)).toMatchObject({ failures: 0, status: 200 });
    expect(await healthRow(newer.slug)).toMatchObject({ failures: 0, status: 200 });
    expect((await dailyRows(near.slug)).reduce((sum, row) => sum + row.checks, 0)).toBe(1);
    const held = await claimRow(near.id);
    expect(held).toMatchObject({ state: "idle", last_outcome: "minimum_interval" });
    expect(held.due_at.getTime()).toBe(ownNear.observedAt.getTime() - 5 * 3_600_000 + 6 * 3_600_000);
    expect(await rawRows(near.slug)).toEqual([]);
  });

  it("clock skew beyond ±30 s is stale clock and leaves the product due", async () => {
    const [early, future] = [await product("clock-early"), await product("clock-future")];
    const batch = await claimed(OWNERS.m3, 10);
    const before = await healthRow(early.slug);
    const summary = await applyUptimeResults({ lease, own: [
      result(ticketOf(batch, early), { status: 0 }, { startMs: -31_000, observeMs: -30_000 }),
      result(ticketOf(batch, future), { status: 200 }, { startMs: 60_000, observeMs: 61_000 }),
    ] });
    expect(summary.reasons).toMatchObject({ clock: 2 });
    expect(await healthRow(early.slug)).toEqual(before);
    const claim = await claimRow(early.id);
    expect(claim).toMatchObject({ state: "idle", last_outcome: "clock" });
    expect(claim.due_at.getTime()).toBeLessThanOrEqual((await dbNow()).getTime());
  });

  it("a control epoch change or a switch to legacy sends leftover submissions back to idle without counting", async () => {
    const [a, b] = [await product("left-a"), await product("left-b")];
    await oracleSubmits([[a, { status: 0, kind: "timeout" }], [b, { status: 200 }]]);
    await setSplit("claims");
    const summary = await applyUptimeResults({ lease });
    expect(summary.reasons).toEqual({ control_epoch: 2 });
    expect(await claimRow(a.id)).toMatchObject({ state: "idle", token: null, confirm_class: null, last_outcome: "control_epoch" });
    expect(await healthRow(b.slug)).toMatchObject({ failures: 0 });
    expect(await dailyRows(b.slug)).toEqual([]);

    await nextCycle(a, b);
    await oracleSubmits([[a, { status: 0, kind: "timeout" }], [b, { status: 200 }]]);
    await setSplit("legacy", null);
    const legacy = await applyUptimeResults({ lease });
    expect(legacy).toMatchObject({ mode: "legacy", reasons: { mode_legacy: 2 }, breakers: [] });
    expect(await claimRow(b.id)).toMatchObject({ state: "idle", token: null, last_outcome: "mode_legacy" });
    expect(await dailyRows(b.slug)).toEqual([]);
    const [windows] = await db.execute<{ n: number }>(sql`select count(*)::int as n from uptime_host_windows`);
    expect(windows.n).toBe(0);
    // legacy 에서 남은 제출이 없으면 아무것도 쓰지 않는다
    expect(await applyUptimeResults({ lease })).toMatchObject({ mode: "legacy", remote: 0, own: 0, decisions: [] });
  });
});

describe("광역 장애 차단기", () => {
  it("home broad failure: 40 of 50 transport failures are held, the streak is untouched, the breaker opens and home claims stop; 30 healthy probes close it", async () => {
    const first = await Promise.all(Array.from({ length: 50 }, (_, index) => product(`home-broad-${index}`)));
    const later = await Promise.all(Array.from({ length: 30 }, (_, index) => product(`home-probe-${index}`, { dueMinutes: 60 })));
    const batch = await claimed(OWNERS.m3, 50);
    expect(batch.claims).toHaveLength(50);
    const before = await healthRow(first[0].slug);
    const summary = await applyUptimeResults({ lease, own: first.map((target, index) =>
      result(ticketOf(batch, target), index < 40 ? { status: 0, kind: "network" } : { status: 200 })) });
    expect(summary.outcomes).toMatchObject({ held: 40, applied: 10 });
    expect(await healthRow(first[0].slug)).toEqual(before);
    const held = await claimRow(first[0].id);
    expect(held).toMatchObject({ state: "idle", last_outcome: "split_broad_failure" });
    expect(held.due_at.getTime() - (await dbNow()).getTime()).toBeGreaterThan(14 * 60_000);
    expect(await rawRows(first[0].slug)).toMatchObject([{ host: "m3", disposition: "observation_hold", reason: "split_broad_failure" }]);
    expect(summary.breakers.find(breaker => breaker.host === "m3")).toMatchObject({ state: "open", reason: "batch_ratio", ratio: 0.8 });
    const [window] = await db.execute<{ checks: number; failures: number; transport: number }>(sql`
      select checks, failures, transport from uptime_host_windows where host = 'm3'`);
    expect(window).toEqual({ checks: 50, failures: 40, transport: 40 });
    expect(await claimUptimeProducts({ owner: OWNERS.m3, limit: 50 })).toMatchObject({ kind: "blocked", reason: "breaker_open" });

    // cool-down 이 지났다 → probing 30건만 → 모두 성공 → closed
    await db.execute(sql`update uptime_host_breakers set opened_at = clock_timestamp() - interval '11 minutes',
      probe_after = clock_timestamp() - interval '1 second' where host = 'm3'`);
    await db.execute(sql`update uptime_claims set due_at = clock_timestamp() - interval '1 minute' where product_id in ${sql`(${sql.join(later.map(target => sql`${target.id}`), sql`, `)})`}`);
    const probing = await claimed(OWNERS.m3, 50);
    expect(probing.breaker).toBe("probing");
    expect(probing.claims).toHaveLength(30);
    expect(await claimUptimeProducts({ owner: OWNERS.m3, limit: 50 })).toMatchObject({ kind: "blocked", reason: "breaker_open" });
    const closed = await applyUptimeResults({ lease, own: probing.claims.map(ticket => result(ticket, { status: 200 })) });
    expect(closed.outcomes.applied).toBe(30);
    expect(closed.breakers.find(breaker => breaker.host === "m3")).toMatchObject({ state: "closed", probeChecks: 0, reason: null });
    expect((await claimed(OWNERS.m3, 50)).breaker).toBe("closed");
  });

  it("a breaker advances from open to probing on an empty tick", async () => {
    await db.execute(sql`insert into uptime_host_breakers (host, state, opened_at, probe_after, reason, ratio)
      values ('mini', 'open', clock_timestamp() - interval '11 minutes', clock_timestamp() - interval '1 second', 'batch_ratio', 0.5)`);
    const summary = await applyUptimeResults({ lease });
    expect(summary).toMatchObject({ remote: 0, own: 0, decisions: [] });
    const [row] = await db.execute<{ state: string }>(sql`select state from uptime_host_breakers where host = 'mini'`);
    expect(row.state).toBe("probing");
  });

  it("Oracle broad failure: every result fails, the breaker opens, nothing counts and no confirm flood — the products go straight back to the pool", async () => {
    const targets = await Promise.all(Array.from({ length: 40 }, (_, index) => product(`oracle-broad-${index}`)));
    await oracleSubmits(targets.map(target => [target, { status: 0, kind: "timeout" }]));
    const summary = await applyUptimeResults({ lease });
    expect(summary.outcomes).toMatchObject({ returned: 40, confirm_requested: 0, applied: 0 });
    expect(summary.breakers.find(breaker => breaker.host === "oracle-osaka-smoke")).toMatchObject({ state: "open", reason: "batch_ratio", ratio: 1 });
    const claim = await claimRow(targets[0].id);
    expect(claim).toMatchObject({ state: "idle", confirm_class: null, last_outcome: "probe_breaker_open" });
    expect(claim.due_at.getTime()).toBeLessThanOrEqual((await dbNow()).getTime());
    expect(await healthRow(targets[0].slug)).toMatchObject({ failures: 0, status: 200 });
    expect(await rawRows(targets[0].slug)).toEqual([]);
    expect(await claimUptimeProducts({ owner: OWNERS.oracle, limit: 40 })).toMatchObject({ kind: "blocked", reason: "breaker_open" });
    expect((await claimed(OWNERS.m3, 50)).claims).toHaveLength(40);
  });
});

describe("숨김·자동 내림 — legacy 와 같은 결과", () => {
  it("3 home failures hide and the 10th bans once with both audits and one purge, exactly like the legacy writer", async () => {
    const legacy = await product("twin-legacy", { claim: false });
    const split = await product("twin-split");
    for (let attempt = 1; attempt <= 10; attempt++) {
      // legacy: 잡의 ping 기록(recordPing, expectedUrl) 뒤 자동 내림 — lib/jobs/products/uptime.ts 와 같은 순서
      await recordPing(legacy.slug, 404, null, new Date((await dbNow()).getTime() - 1_000), legacy.id, lease, legacy.url);
      await autoBanUptimeProduct(legacy, { lease });
      const summary = await homeChecks([[split, { status: 404 }]]);
      const [l, s] = [await healthRow(legacy.slug), await healthRow(split.slug)];
      expect([l!.failures, s!.failures]).toEqual([attempt, attempt]);
      expect(await hidden(split)).toBe(await hidden(legacy));
      if (attempt < 10) expect(await hidden(split)).toBe(attempt >= 3);
      expect(summary.autoBanned).toBe(attempt === 10 ? 1 : 0);
      expect(await status(split)).toBe(await status(legacy));
      if (attempt < 10) {
        expect(await status(split)).toBe("seeded");
        await nextCycle(legacy, split);
      }
    }
    expect([await status(legacy), await status(split)]).toEqual(["banned", "banned"]);
    const operations = await auditRowsAfter(floor, "product-auto-ban-uptime");
    expect(operations.map(row => row.target).sort()).toEqual([legacy.slug, split.slug].sort());
    expect(operations.find(row => row.target === split.slug)?.detail).toMatchObject({ consecutiveFailures: 10, lastStatus: 404, productId: split.id });
    const evidence = await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.action, "admin.product.ban"));
    expect(evidence.map(row => row.slug).sort()).toEqual([legacy.slug, split.slug].sort());
    const purges = await db.select().from(cdnPurges);
    expect(purges.filter(row => row.slug === split.slug)).toMatchObject([{ reason: "banned" }]);
    expect(purges.filter(row => row.slug === legacy.slug)).toHaveLength(1);
    const daily = async (target: FixtureProduct) => (await dailyRows(target.slug))
      .reduce((sum, row) => ({ checks: sum.checks + row.checks, successes: sum.successes + row.successes }), { checks: 0, successes: 0 });
    expect(await daily(split)).toEqual(await daily(legacy));
  });

  it("a human unban after the latest check keeps the product (final commit protection)", async () => {
    const target = await product("unbanned", { health: { failures: 9, status: 404 } });
    await db.insert(productEvidenceAudit).values({ slug: target.slug, actor: "admin:test", action: "admin.product.unban", reason: "사람 확인",
      createdAt: sql`(clock_timestamp() at time zone 'UTC') + interval '1 minute'` });
    const summary = await homeChecks([[target, { status: 404 }]]);
    expect(await healthRow(target.slug)).toMatchObject({ failures: 10 });
    expect(summary.autoBanned).toBe(0);
    expect(await status(target)).toBe("seeded");
    expect(await auditRowsAfter(floor, "product-auto-ban-uptime")).toEqual([]);
  });

  it("keeps counting beside an older unrelated health row, and restarts at 1 only when the product changed after the streak began (PR #551 meaning)", async () => {
    await product("ancient", { claim: false, health: { hoursAgo: 30 * 24 } });
    const target = await product("streak");
    for (let attempt = 1; attempt <= 3; attempt++) {
      await homeChecks([[target, { status: 503 }]]);
      expect((await healthRow(target.slug))!.failures).toBe(attempt);
      await nextCycle(target);
    }
    expect((await downProducts()).map(row => row.slug)).toEqual([target.slug]);
    // 연속 실패가 시작된 뒤 제품이 바뀌었다 → 그 실패를 지금 주소에 이어 붙이지 않는다(확인은 수정 1초 뒤에 시작한다)
    await db.execute(sql`update products set updated_at = (clock_timestamp() at time zone 'UTC') - interval '1 second' where id = ${target.id}`);
    const batch = await claimed(OWNERS.m3, 5);
    const own = result(ticketOf(batch, target), { status: 503 }, { startMs: 0, observeMs: 0 });
    await applyUptimeResults({ lease, own: [own] });
    const health = await healthRow(target.slug);
    expect(health).toMatchObject({ failures: 1 });
    expect(new Date(`${health!.down_since}Z`).getTime()).toBe(own.observedAt.getTime());
  });
});

describe("묶음 쓰기", () => {
  it("writeHealthResults equals writeHealthResult applied one by one (streak, reset, first failure, latency, KST day)", async () => {
    const base = Date.parse("2026-10-18T14:59:59.999Z");
    const events: Omit<HealthResultInput, "slug">[] = [
      { status: 200, latencyMs: 12.6, observedAt: new Date(base), resetStreak: false },
      { status: 0, latencyMs: 500, observedAt: new Date(base + 60_000), resetStreak: false },
      { status: 503, latencyMs: null, observedAt: new Date(base + 120_000), resetStreak: false },
      { status: 404, latencyMs: 7, observedAt: new Date(base + 180_000), resetStreak: true },
      { status: 302, latencyMs: 99_999_999_999, observedAt: new Date(base + 240_000), resetStreak: true },
      { status: 500, latencyMs: -3, observedAt: new Date(base + 300_000), resetStreak: false },
      { status: 200, latencyMs: -3.4, observedAt: new Date(base + 360_000), resetStreak: false },
    ];
    const one = `u1b-${TAG}-eq-one`, set = `u1b-${TAG}-eq-set`;
    for (const event of events) {
      await db.transaction(tx => writeHealthResult(tx, { slug: one, ...event }));
      const written = await db.transaction(tx => writeHealthResults(tx, [{ slug: set, ...event }]));
      expect(written.get(set)).toBe((await healthRow(one))!.failures);
      const [a, b] = [await healthRow(one), await healthRow(set)];
      expect(b).toEqual(a);
    }
    expect(await dailyRows(set)).toEqual(await dailyRows(one));
    expect((await dailyRows(set)).map(row => row.day)).toEqual(["2026-10-18", "2026-10-19"]);

    // 여러 제품 한 문장: 새 행·있는 행·reset 이 섞여도 하나씩과 같다
    const mixed = (prefix: string) => [
      { slug: `${prefix}-new`, status: 0, latencyMs: null, observedAt: new Date(base + 400_000), resetStreak: false },
      { slug: `${prefix}-old`, status: 503, latencyMs: null, observedAt: new Date(base + 400_000), resetStreak: false },
      { slug: `${prefix}-reset`, status: 503, latencyMs: null, observedAt: new Date(base + 400_000), resetStreak: true },
      { slug: `${prefix}-up`, status: 204, latencyMs: 33, observedAt: new Date(base + 400_000), resetStreak: true },
    ];
    for (const prefix of [`u1b-${TAG}-m1`, `u1b-${TAG}-m2`]) {
      for (const slug of ["old", "reset", "up"]) {
        await db.execute(sql`insert into product_health (slug, checked_at, status, failures, down_since)
          values (${`${prefix}-${slug}`}, '2026-10-18 10:00:00.123456', 500, 4, '2026-10-17 09:00:00.654321')`);
      }
    }
    for (const input of mixed(`u1b-${TAG}-m1`)) await db.transaction(tx => writeHealthResult(tx, input));
    await db.transaction(tx => writeHealthResults(tx, mixed(`u1b-${TAG}-m2`)));
    for (const slug of ["new", "old", "reset", "up"]) {
      expect(await healthRow(`u1b-${TAG}-m2-${slug}`)).toEqual(await healthRow(`u1b-${TAG}-m1-${slug}`));
      expect(await dailyRows(`u1b-${TAG}-m2-${slug}`)).toEqual(await dailyRows(`u1b-${TAG}-m1-${slug}`));
    }
    // 마이크로초까지 첫 실패 시각을 보존한다(legacy 의 coalesce 와 같다)
    expect(await healthRow(`u1b-${TAG}-m2-old`)).toMatchObject({ failures: 5, down_since: "2026-10-17 09:00:00.654321" });
    await expect(db.transaction(tx => writeHealthResults(tx, [mixed("dup")[0], mixed("dup")[0]]))).rejects.toThrow("health_results_duplicate_slug");
  });

  it("home's live result refreshes the stored first-screen text; Oracle results never do", async () => {
    const oracle = await product("sample-oracle");
    await oracleSubmits([[oracle, { status: 200 }]]);
    const home = await product("sample-home");
    for (const target of [home, oracle]) {
      await db.insert(crawlCandidates).values({ repo: `${REPO}/${target.slug}`, state: "published", publishedSlug: target.slug });
      await db.insert(crawlDocuments).values({ repo: `${REPO}/${target.slug}`, repoMeta: {}, pageMeta: { textSample: "이전 본문" } });
    }
    const summary = await homeChecks([[home, { status: 200, textSample: "M3 가 읽은 새 본문" }]]);
    expect(summary).toMatchObject({ remote: 1, own: 1, textSamples: 1 });
    const sample = async (target: FixtureProduct) => (await db.select({ meta: crawlDocuments.pageMeta }).from(crawlDocuments)
      .where(eq(crawlDocuments.repo, `${REPO}/${target.slug}`)))[0].meta as { textSample?: string };
    expect((await sample(home)).textSample).toBe("M3 가 읽은 새 본문");
    expect((await sample(oracle)).textSample).toBe("이전 본문");
  });

  it("losing the job lease rolls back the whole batch", async () => {
    const [a, b] = [await product("lease-a"), await product("lease-b")];
    const batch = await claimed(OWNERS.m3, 10);
    const before = [await healthRow(a.slug), await healthRow(b.slug)];
    await db.execute(sql`update jobs set lease_token = ${randomUUID()} where name = 'uptime-ping'`);
    await expect(applyUptimeResults({ lease, own: [result(ticketOf(batch, a), { status: 0 }), result(ticketOf(batch, b), { status: 200 })] }))
      .rejects.toBeInstanceOf(JobLeaseLostError);
    expect([await healthRow(a.slug), await healthRow(b.slug)]).toEqual(before);
    expect(await dailyRows(b.slug)).toEqual([]);
    expect(await claimRow(a.id)).toMatchObject({ state: "claimed", token: ticketOf(batch, a).token });
    expect(await rawRows(a.slug)).toEqual([]);
    const [window] = await db.execute<{ n: number }>(sql`select count(*)::int as n from uptime_host_windows`);
    expect(window.n).toBe(0);
  });

  it("rejects malformed or duplicate own results before touching the database", async () => {
    const target = await product("malformed");
    const batch = await claimed(OWNERS.m3, 5);
    const good = result(ticketOf(batch, target), { status: 200 });
    await expect(applyUptimeResults({ lease, own: [good, good] })).rejects.toThrow("uptime_split_duplicate_product");
    await expect(applyUptimeResults({ lease, own: [{ ...good, kind: "timeout", status: 200 }] })).rejects.toThrow();
    await expect(applyUptimeResults({ lease: { ...lease, name: "other" }, own: [] })).rejects.toThrow("uptime_job_required");
    expect(await claimRow(target.id)).toMatchObject({ state: "claimed" });
  });
});
