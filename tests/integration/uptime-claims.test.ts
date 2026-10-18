import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { claimUptimeProducts, releaseUptimeClaims, submitUptimeResults, syncUptimeClaimRows, type UptimeClaimTicket } from "@/lib/domain/products/uptime-claims";
import { applyUptimeResults } from "@/lib/domain/products/uptime-apply";
import { ensureSchema, resetTables, TEST_DATABASE_URL } from "./setup";
import { claimRow, clearSplitState, dbNow, OWNERS, POLICY, product, result, setSplit, TAG, takeJobLease } from "./uptime-split-fixture";

/*
 * U1b claim·제출·되돌림·동기화를 실제 PostgreSQL 에서 본다(design-uptime §8.1 1~4·15 의 claim 쪽, 같은 slot 중복, origin 배타).
 * 동시성은 연결 둘 이상으로 본다: lib 의 pool 과 따로 연 연결이 같은 행·같은 origin lock 을 쥔 상태에서 claim 한다.
 */
let other: postgres.Sql;
let original: { split: Record<string, unknown>; control: Record<string, unknown> | undefined };

beforeAll(async () => {
  ensureSchema();
  const [split] = await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(c) as row from uptime_split_control c where id = 1`);
  const [control] = await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(c) as row from uptime_control c where id = 1`);
  original = { split: split.row, control: control?.row };
  other = postgres(TEST_DATABASE_URL, { max: 2, onnotice: () => {} });
});
beforeEach(async () => {
  await resetTables();
  await clearSplitState();
  await setSplit("claims");
});
afterAll(async () => {
  await other?.end({ timeout: 5 });
  // 다른 파일이 uptime_control 을 켤 수 있게 legacy 로 돌린다(epoch 는 원래 값보다 커도 된다 — 단조 증가)
  await db.execute(sql`update uptime_split_control set mode = ${original.split.mode as string}, policy = null, policy_hash = null,
    epoch = epoch + 1, updated_at = clock_timestamp() where id = 1`);
  if (original.control) {
    await db.execute(sql`update uptime_control set observations_enabled = ${original.control.observations_enabled as boolean},
      gate_enabled = ${original.control.gate_enabled as boolean} where id = 1`);
  }
  await db.execute(sql`update jobs set lease_token = null, locked_at = null where name = 'uptime-ping'`);
});

/** 다른 연결에서 TX 를 열고 statement 를 실행한 뒤 release 를 부를 때까지 잡고 있는다 */
async function hold(statement: (tx: postgres.TransactionSql) => Promise<unknown>) {
  let release!: () => void, ready!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { ready = resolve; });
  const done = other.begin(async tx => { await statement(tx); ready(); await released; });
  await Promise.race([started, done]);
  return async () => { release(); await done; };
}
const claimed = async (owner: (typeof OWNERS)[keyof typeof OWNERS], limit: number) => {
  const batch = await claimUptimeProducts({ owner, limit });
  if (batch.kind !== "claimed") throw new Error(`claim_blocked:${batch.reason}`);
  return batch;
};
const ids = (claims: readonly UptimeClaimTicket[]) => claims.map(claim => claim.productId).sort((a, b) => a - b);

describe("claim", () => {
  it("records owner·host·class·epoch·slot·lease in one batch; probe class comes from the policy, not the caller", async () => {
    const targets = [await product("one"), await product("two")];
    const before = await dbNow();
    const batch = await claimed(OWNERS.oracle, 10);
    const after = await dbNow();
    expect(batch).toMatchObject({ host: "oracle-osaka-smoke", hostClass: "probe", breaker: "closed" });
    expect(ids(batch.claims)).toEqual(targets.map(target => target.id));
    for (const ticket of batch.claims) {
      expect(ticket.epoch).toBe(1);
      expect(ticket.claimedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1);
      expect(ticket.claimedAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1);
      expect(ticket.leaseUntil.getTime() - ticket.claimedAt.getTime()).toBe(POLICY.claim.ttlMs);
      const row = await claimRow(ticket.productId);
      expect(row).toMatchObject({ state: "claimed", epoch: 1, token: ticket.token, owner_instance_id: "u1b-oracle", host: "oracle-osaka-smoke",
        host_class: "probe", control_epoch: batch.controlEpoch });
    }
    const [slot] = await db.execute<{ ok: boolean }>(sql`select bool_and(extract(epoch from claim_slot)::bigint % 21600 = 0
      and claim_slot <= claimed_at and claimed_at < claim_slot + interval '6 hours') as ok from uptime_claims where state = 'claimed'`);
    expect(slot.ok).toBe(true);
    // 이미 잡힌 행은 같은 owner 도 다시 가져가지 않는다(살아 있는 claim)
    expect((await claimed(OWNERS.oracle, 10)).claims).toEqual([]);
  });

  it("two owners claiming at once on separate connections never overlap, and a row locked elsewhere is skipped without waiting", async () => {
    const targets = await Promise.all(Array.from({ length: 24 }, (_, index) => product(`pair-${index}`)));
    const all = targets.map(target => target.id).sort((a, b) => a - b);
    const releaseLock = await hold(tx => tx`select product_id from uptime_claims where product_id in ${tx(all.slice(0, 4))} for update`);
    try {
      const started = Date.now();
      const [m3, mini] = await Promise.all([claimed(OWNERS.m3, 10), claimed(OWNERS.mini, 10)]);
      // SKIP LOCKED: 다른 연결이 잡은 4행을 기다리지 않는다(lock_timeout 5초보다 훨씬 짧다)
      expect(Date.now() - started).toBeLessThan(3_000);
      const got = [...ids(m3.claims), ...ids(mini.claims)];
      expect(new Set(got).size).toBe(got.length);
      expect(got.sort((a, b) => a - b)).toEqual(all.slice(4));
      expect(m3.claims.every(claim => claim.epoch === 1) && mini.claims.every(claim => claim.epoch === 1)).toBe(true);
    } finally {
      await releaseLock();
    }
    expect(ids((await claimed(OWNERS.m3b, 10)).claims)).toEqual(all.slice(0, 4));
  });

  it("keeps one site at a time across owners: another owner's live claim or an in-flight claim on the origin excludes it; the same owner may take more", async () => {
    const shared = `https://shared-${TAG}.example`;
    const a = await product("shared-a", { url: `${shared}/a`, dueMinutes: -30 });
    const b = await product("shared-b", { url: `${shared}/b`, dueMinutes: -20 });
    const c = await product("shared-c", { url: `${shared.toUpperCase().replace("HTTPS", "https")}/c`, dueMinutes: -10 });
    const lone = await product("lone", { dueMinutes: -5 });
    expect(ids((await claimed(OWNERS.m3, 1)).claims)).toEqual([a.id]);
    // 다른 owner 는 같은 origin(대소문자 무관)을 건너뛴다
    expect(ids((await claimed(OWNERS.mini, 10)).claims)).toEqual([lone.id]);
    // 같은 owner 는 같은 origin 을 더 가져간다(host 안에서는 origin 줄이 차례로 연다)
    expect(ids((await claimed(OWNERS.m3, 10)).claims)).toEqual([b.id, c.id]);

    // 다른 TX 가 origin 을 고르는 중(advisory lock)이면 commit 전이라 claim 이 안 보여도 건너뛴다
    const race = `https://race-${TAG}.example`;
    const r1 = await product("race-1", { url: `${race}/1` }), r2 = await product("race-2", { url: `${race}/2` });
    const releaseLock = await hold(tx => tx`select pg_advisory_xact_lock(hashtext('uptime-origin'), hashtext(${race}))`);
    try {
      const started = Date.now();
      expect((await claimed(OWNERS.mini, 10)).claims).toEqual([]);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await releaseLock();
    }
    expect(ids((await claimed(OWNERS.mini, 10)).claims)).toEqual([r1.id, r2.id]);
  });

  it("two owners racing for the same sites never both hold one origin", async () => {
    for (let round = 0; round < 6; round++) {
      const origin = `https://round-${round}-${TAG}.example`;
      const targets = [await product(`round-${round}-a`, { url: `${origin}/a` }), await product(`round-${round}-b`, { url: `${origin}/b` }),
        await product(`round-${round}-x`), await product(`round-${round}-y`)];
      const [m3, mini] = await Promise.all([claimed(OWNERS.m3, 4), claimed(OWNERS.mini, 4)]);
      const sameOrigin = [targets[0].id, targets[1].id];
      const holders = [m3, mini].filter(batch => batch.claims.some(claim => sameOrigin.includes(claim.productId)));
      expect(holders.length).toBeLessThanOrEqual(1);
      const got = [...ids(m3.claims), ...ids(mini.claims)];
      expect(new Set(got).size).toBe(got.length);
      await db.execute(sql`update uptime_claims set state = 'idle', token = null, lease_until = null, due_at = clock_timestamp() + interval '1 day'`);
    }
  });

  it("probe skips failing, confirm-requested and home-pinned products; home takes confirm requests first", async () => {
    const failing = await product("failing", { health: { failures: 2, status: 503 } });
    const confirm = await product("confirm", { dueMinutes: -1 });
    await db.execute(sql`update uptime_claims set confirm_class = 'home', confirm_reason = 'http:403', confirm_requested_at = clock_timestamp()
      where product_id = ${confirm.id}`);
    const pinned = await product("pinned");
    await db.execute(sql`update uptime_claims set affinity_home_until = clock_timestamp() + interval '7 days' where product_id = ${pinned.id}`);
    const plain = await product("plain", { dueMinutes: -60 });
    const fresh = await product("fresh", { health: { hoursAgo: 2 }, dueMinutes: -90 });
    const never = await product("never", { health: null, dueMinutes: -30 });
    expect(ids((await claimed(OWNERS.oracle, 40)).claims)).toEqual([plain.id, never.id]);
    // home: 재확인 요청이 due 가 늦어도 맨 앞이다. 6시간 안에 확인한 것은 due 가 지나도 가져가지 않는다
    const home = await claimed(OWNERS.m3, 1);
    expect(home.claims.map(claim => [claim.productId, claim.confirmClass])).toEqual([[confirm.id, "home"]]);
    expect(ids((await claimed(OWNERS.m3, 10)).claims)).toEqual([failing.id, pinned.id]);
    expect((await claimRow(fresh.id)).state).toBe("idle");
  });

  it("an open breaker stops the host; probing hands out only the probe slots that are not already out", async () => {
    await Promise.all(Array.from({ length: 34 }, (_, index) => product(`probe-${index}`)));
    await db.execute(sql`insert into uptime_host_breakers (host, state, opened_at, probe_after, reason, ratio)
      values ('oracle-osaka-smoke', 'open', clock_timestamp(), clock_timestamp() + interval '10 minutes', 'batch_ratio', 1)`);
    expect(await claimUptimeProducts({ owner: OWNERS.oracle, limit: 40 })).toMatchObject({ kind: "blocked", reason: "breaker_open" });
    // 다른 host 는 그대로다
    expect((await claimed(OWNERS.m3, 1)).claims).toHaveLength(1);
    // cool-down 이 지났다. 저장된 상태는 아직 open 이어도(적용기가 옮기기 전) probing 으로 보고 probeSize 만 준다
    await db.execute(sql`update uptime_host_breakers set probe_after = clock_timestamp() - interval '1 second' where host = 'oracle-osaka-smoke'`);
    const probing = await claimed(OWNERS.oracle, 40);
    expect(probing.breaker).toBe("probing");
    expect(probing.claims).toHaveLength(POLICY.breaker.probeSize);
    expect(await claimUptimeProducts({ owner: OWNERS.oracle, limit: 40 })).toMatchObject({ kind: "blocked", reason: "breaker_open" });
  });

  it("refuses without writing when the mode is legacy or the instance is not in the policy", async () => {
    const target = await product("refused");
    expect(await claimUptimeProducts({ owner: { instanceId: "u1b-stranger", bootId: randomUUID() }, limit: 5 }))
      .toMatchObject({ kind: "blocked", reason: "source_unconfigured" });
    await setSplit("legacy", null);
    expect(await claimUptimeProducts({ owner: OWNERS.m3, limit: 5 })).toMatchObject({ kind: "blocked", reason: "mode_legacy" });
    expect(await submitUptimeResults({ owner: OWNERS.m3, results: [] })).toMatchObject({ kind: "blocked", reason: "mode_legacy" });
    expect(await claimRow(target.id)).toMatchObject({ state: "idle", epoch: 0, token: null });
  });
});

describe("submit", () => {
  it("accepts once per claim: a second submit of the same claim, another boot, or a clock outside ±30 s is lost", async () => {
    const [a, b, c, d] = [await product("sub-a"), await product("sub-b"), await product("sub-c"), await product("sub-d")];
    const batch = await claimed(OWNERS.oracle, 10);
    const ticket = (id: number) => batch.claims.find(claim => claim.productId === id)!;
    const first = await submitUptimeResults({ owner: OWNERS.oracle, results: [result(ticket(a.id), { status: 200 })] });
    expect(first).toMatchObject({ kind: "submitted", accepted: [a.id], lost: [] });
    // 같은 6h slot 의 같은 claim 을 다시 내면 받지 않는다(이미 submitted)
    expect(await submitUptimeResults({ owner: OWNERS.oracle, results: [result(ticket(a.id), { status: 500 })] }))
      .toMatchObject({ accepted: [], lost: [a.id] });
    expect(await submitUptimeResults({ owner: { ...OWNERS.oracle, bootId: randomUUID() }, results: [result(ticket(b.id), { status: 200 })] }))
      .toMatchObject({ accepted: [], lost: [b.id] });
    const late = await submitUptimeResults({ owner: OWNERS.oracle, results: [
      result(ticket(c.id), { status: 200 }, { startMs: -31_000, observeMs: -30_500 }),
      result(ticket(d.id), { status: 200 }, { startMs: 59_000, observeMs: 60_000 }),
      result(ticket(b.id), { status: 200 }),
    ] });
    expect(late).toMatchObject({ accepted: [b.id], lost: [c.id, d.id] });
    const [submitted] = await db.execute<{ state: string; result_status: number; result_kind: string; lease_until: string | null }>(sql`
      select state, result_status, result_kind, lease_until::text from uptime_claims where product_id = ${a.id}`);
    expect(submitted).toEqual({ state: "submitted", result_status: 200, result_kind: "http", lease_until: null });
    expect((await claimRow(c.id)).state).toBe("claimed");
  });

  it("after the TTL another owner takes the claim with epoch+1 and the old owner's late result is lost; an expired claim nobody took is still accepted", async () => {
    const [taken, untaken] = [await product("ttl-taken", { dueMinutes: -20 }), await product("ttl-untaken", { dueMinutes: -10 })];
    const oracle = await claimed(OWNERS.oracle, 10);
    await db.execute(sql`update uptime_claims set lease_until = clock_timestamp() - interval '1 second' where state = 'claimed'`);
    const m3 = await claimed(OWNERS.m3, 1);
    expect(m3.claims).toMatchObject([{ productId: taken.id, epoch: 2 }]);
    const old = (id: number) => oracle.claims.find(claim => claim.productId === id)!;
    expect(m3.claims[0].token).not.toBe(old(taken.id).token);
    const late = await submitUptimeResults({ owner: OWNERS.oracle, results: [result(old(taken.id), { status: 200 }), result(old(untaken.id), { status: 200 })] });
    expect(late).toMatchObject({ accepted: [untaken.id], lost: [taken.id] });
    expect(await claimRow(taken.id)).toMatchObject({ state: "claimed", epoch: 2, owner_instance_id: "u1b-m3", token: m3.claims[0].token });
  });

  it("a control epoch change makes in-flight claims unsubmittable", async () => {
    const target = await product("epoch");
    const batch = await claimed(OWNERS.oracle, 1);
    const epoch = await setSplit("claims");
    expect(epoch).toBe(batch.controlEpoch + 1);
    expect(await submitUptimeResults({ owner: OWNERS.oracle, results: [result(batch.claims[0], { status: 200 })] }))
      .toMatchObject({ kind: "submitted", controlEpoch: epoch, accepted: [], lost: [target.id] });
  });

  it("an applied result is not claimed again in the same six hours, even when its due time is forced back", async () => {
    const target = await product("same-slot");
    const batch = await claimed(OWNERS.oracle, 1);
    await submitUptimeResults({ owner: OWNERS.oracle, results: [result(batch.claims[0], { status: 200 })] });
    const lease = await takeJobLease();
    expect((await applyUptimeResults({ lease })).outcomes.applied).toBe(1);
    await db.execute(sql`update uptime_claims set due_at = clock_timestamp() - interval '1 minute' where product_id = ${target.id}`);
    expect((await claimed(OWNERS.oracle, 5)).claims).toEqual([]);
    expect((await claimed(OWNERS.m3, 5)).claims).toEqual([]);
  });
});

describe("release and sync", () => {
  it("release returns only this owner's unopened claims to the pool, still due", async () => {
    const [a, b] = [await product("rel-a"), await product("rel-b")];
    const batch = await claimed(OWNERS.oracle, 10);
    const ticket = (id: number) => batch.claims.find(claim => claim.productId === id)!;
    expect(await releaseUptimeClaims({ owner: OWNERS.m3, claims: [ticket(a.id)] })).toEqual({ kind: "released", released: [] });
    expect(await releaseUptimeClaims({ owner: OWNERS.oracle, claims: [ticket(a.id), { ...ticket(b.id), token: randomUUID() }] }))
      .toEqual({ kind: "released", released: [a.id] });
    expect(await claimRow(a.id)).toMatchObject({ state: "idle", token: null, epoch: 1 });
    expect(ids((await claimed(OWNERS.m3, 10)).claims)).toEqual([a.id]);
  });

  it("sync adds idle rows for new public website products only, due six hours after the last check", async () => {
    const recent = await product("sync-recent", { claim: false, health: { hoursAgo: 2 } });
    const unchecked = await product("sync-unchecked", { claim: false, health: null });
    await product("sync-unverified", { claim: false, status: "unverified" });
    await product("sync-installable", { claim: false, accessMode: "installable" });
    await product("sync-banned", { claim: false, status: "banned" });
    const existing = await product("sync-existing", { dueMinutes: 30 });
    const before = await dbNow();
    expect(await syncUptimeClaimRows({ lease: await takeJobLease() })).toBe(2);
    expect(await syncUptimeClaimRows()).toBe(0);
    const [rows] = await db.execute<{ ids: number[] }>(sql`select array_agg(product_id order by product_id) as ids from uptime_claims`);
    expect(rows.ids).toEqual([recent.id, unchecked.id, existing.id].sort((x, y) => x - y));
    const [due] = await db.execute<{ gap: number }>(sql`select extract(epoch from (c.due_at - (h.checked_at at time zone 'UTC')))::int as gap
      from uptime_claims c join product_health h on h.slug = ${recent.slug} where c.product_id = ${recent.id}`);
    expect(due.gap).toBe(6 * 3600);
    expect((await claimRow(unchecked.id)).due_at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1);
    expect(await claimRow(recent.id)).toMatchObject({ state: "idle", epoch: 0, token: null });
  });
});
