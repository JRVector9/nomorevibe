import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { JobLease } from "@/lib/jobs/control";
import type { UptimeClaimTicket, UptimeResult } from "@/lib/domain/products/uptime-claims";
import { uptimeSplitPolicyHash, type UptimeSplitPolicy } from "@/lib/domain/products/uptime-split-policy";

/*
 * U1b split-v1 통합 테스트 공용 준비물. 시각은 모두 DB 시계에서 잰다(로컬 Mac 과 Docker DB 시계 차와 무관하게).
 * 제품 slug·URL 에 파일마다 다른 꼬리표를 붙인다 — uptime_observations 는 지울 수 없어(append-only) 이전 실행의 사실과
 * (제품, URL, slot, host) 유일 키가 겹치지 않게 한다.
 */
export const TAG = randomBytes(4).toString("hex");
/**
 * uptime_observations 는 지울 수 없고(append-only) 다른 파일은 제품 id 로 raw 행을 센다. resetTables 가 id 를 1 부터 다시 매기므로
 * 이 파일의 제품은 높은 대역에서 시작해 뒤에 도는 파일의 제품 id 와 겹치지 않게 한다.
 */
const PRODUCT_ID_BASE = 1_500_000_000 + randomBytes(4).readUInt32BE() % 500_000_000;

export const POLICY: UptimeSplitPolicy = { version: 1,
  hosts: [
    { host: "m3", instanceId: "u1b-m3", region: "kr-home", class: "home" },
    { host: "m3", instanceId: "u1b-m3-2", region: "kr-home", class: "home" },
    { host: "mini", instanceId: "u1b-mini", region: "kr-home", class: "home" },
    { host: "oracle-osaka-smoke", instanceId: "u1b-oracle", region: "ap-osaka-1", class: "probe", maxPerHour: 1_000, batch: 40, concurrency: 4 },
  ],
  claim: { ttlMs: 180_000 }, confirm: { affinityDays: 7 },
  breaker: { windowMinutes: 10, minChecks: 100, openRatio: 0.08, batchMin: 30, batchOpenRatio: 0.3, coolDownMinutes: 10,
    maxCoolDownMinutes: 60, probeSize: 30, probeCloseRatio: 0.05 } };

export const OWNERS = {
  m3: { instanceId: "u1b-m3", bootId: randomUUID() },
  m3b: { instanceId: "u1b-m3-2", bootId: randomUUID() },
  mini: { instanceId: "u1b-mini", bootId: randomUUID() },
  oracle: { instanceId: "u1b-oracle", bootId: randomUUID() },
} as const;

/** split 제어를 바꾼다(epoch+1, 실제 운영 명령과 같다). claims 는 uptime_control 이 꺼져 있어야 한다(0104 트리거) */
export async function setSplit(mode: "legacy" | "claims", policy: UptimeSplitPolicy | null = POLICY): Promise<number> {
  const [row] = await db.execute<{ epoch: number }>(sql`update uptime_split_control set mode = ${mode},
    policy = ${policy ? JSON.stringify(policy) : null}::text::jsonb, policy_hash = ${policy ? uptimeSplitPolicyHash(policy) : null},
    epoch = epoch + 1, updated_at = clock_timestamp() where id = 1 returning epoch::int as epoch`);
  return row.epoch;
}

export async function dbNow(): Promise<Date> {
  const [row] = await db.execute<{ ms: number }>(sql`select (extract(epoch from clock_timestamp()) * 1000)::float8 as ms`);
  return new Date(row.ms);
}

export type FixtureProduct = { id: number; slug: string; url: string };
type ProductOptions = {
  url?: string; status?: string; accessMode?: string;
  /** null 이면 health 행을 만들지 않는다. 기본은 7시간 전 성공 확인 */
  health?: { hoursAgo?: number; failures?: number; status?: number } | null;
  /** false 면 uptime_claims 행을 만들지 않는다. 기본은 1분 전에 due */
  claim?: boolean; dueMinutes?: number;
};

/** 공개 website 제품(7일 전 수정). health·claim 행은 DB 시계 기준으로 만든다 */
export async function product(name: string, options: ProductOptions = {}): Promise<FixtureProduct> {
  const slug = `u1b-${TAG}-${name}`.slice(0, 80), url = options.url ?? `https://${slug}.example/`;
  const [row] = await db.execute<{ id: number }>(sql`insert into products (slug, url, name, tagline, description, category, status,
      access_mode, verify_token, edit_token_hash, updated_at)
    values (${slug}, ${url}, ${slug}, '소개', '설명', 'Other', ${options.status ?? "seeded"}, ${options.accessMode ?? "website"}, 'verify',
      ${"x".repeat(64)}, (clock_timestamp() at time zone 'UTC') - interval '7 days') returning id`);
  if (options.health !== null) {
    const health = options.health ?? {}, failures = health.failures ?? 0;
    await db.execute(sql`insert into product_health (slug, checked_at, status, failures, down_since)
      values (${slug}, (clock_timestamp() at time zone 'UTC') - ${health.hoursAgo ?? 7} * interval '1 hour', ${health.status ?? 200}, ${failures},
        case when ${failures}::int > 0 then (clock_timestamp() at time zone 'UTC') - interval '3 days' end)`);
  }
  if (options.claim !== false) {
    await db.execute(sql`insert into uptime_claims (product_id, due_at) values (${row.id}, clock_timestamp() + ${options.dueMinutes ?? -1} * interval '1 minute')`);
  }
  return { id: row.id, slug, url };
}

/** 다음 바퀴: 마지막 확인을 7시간 전으로, claim 을 지금 due 로 돌린다(6시간 간격을 기다리는 대신) */
export async function nextCycle(...targets: FixtureProduct[]) {
  for (const target of targets) {
    await db.execute(sql`update product_health set checked_at = (clock_timestamp() at time zone 'UTC') - interval '7 hours' where slug = ${target.slug}`);
    await db.execute(sql`update uptime_claims set due_at = clock_timestamp() - interval '1 minute' where product_id = ${target.id}`);
  }
}

/**
 * claim 받은 회차의 결과. 기본은 claim 2초 전 시작·1초 전 관측이다(±30초 안). 관측을 claim 보다 앞에 두면 뒤이은
 * 자동 내림의 "확인 시각 ≤ now()" 가 DB 시계로 언제나 성립한다.
 */
export function result(ticket: UptimeClaimTicket, outcome: { status: number; kind?: UptimeResult["kind"]; latencyMs?: number | null },
  offsets: { startMs: number; observeMs: number } = { startMs: -2_000, observeMs: -1_000 }): UptimeResult {
  const kind = outcome.kind ?? (outcome.status === 0 ? "network" : "http");
  return { productId: ticket.productId, token: ticket.token, epoch: ticket.epoch,
    startedAt: new Date(ticket.claimedAt.getTime() + offsets.startMs), observedAt: new Date(ticket.claimedAt.getTime() + offsets.observeMs),
    kind, status: outcome.status, latencyMs: outcome.latencyMs === undefined ? (kind === "http" ? 120 : null) : outcome.latencyMs };
}

/** 적용기가 요구하는 uptime-ping 잡 lease 를 이 테스트가 쥔다 */
export async function takeJobLease(): Promise<JobLease> {
  const token = randomUUID();
  await db.execute(sql`insert into jobs (name, lease_token, locked_at) values ('uptime-ping', ${token}, now())
    on conflict (name) do update set lease_token = excluded.lease_token, locked_at = now()`);
  return { name: "uptime-ping", token, requestedVersion: 0 };
}

export type ClaimRow = { product_id: number; state: string; epoch: number; token: string | null; owner_instance_id: string | null;
  host: string | null; host_class: string | null; due_at: Date; confirm_class: string | null; confirm_reason: string | null;
  affinity_home_until: Date | null; conflict_count: number; last_outcome: string | null; last_applied_host: string | null;
  control_epoch: number | null };
export async function claimRow(productId: number): Promise<ClaimRow> {
  const [row] = await db.execute<Omit<ClaimRow, "due_at" | "affinity_home_until"> & { due_ms: number; affinity_ms: number | null }>(sql`
    select product_id, state, epoch::int as epoch, token::text as token, owner_instance_id, host, host_class,
      (extract(epoch from due_at) * 1000)::float8 as due_ms, confirm_class, confirm_reason,
      (extract(epoch from affinity_home_until) * 1000)::float8 as affinity_ms, conflict_count, last_outcome, last_applied_host,
      control_epoch::int as control_epoch
    from uptime_claims where product_id = ${productId}`);
  const { due_ms, affinity_ms, ...rest } = row;
  return { ...rest, due_at: new Date(due_ms), affinity_home_until: affinity_ms === null ? null : new Date(affinity_ms) };
}

export async function healthRow(slug: string) {
  const [row] = await db.execute<{ checked_at: string; status: number; failures: number; down_since: string | null; latency_ms: number | null }>(sql`
    select checked_at::text, status, failures, down_since::text, latency_ms from product_health where slug = ${slug}`);
  return row ?? null;
}

export async function dailyRows(slug: string) {
  return Array.from(await db.execute<{ day: string; checks: number; successes: number; latency_total_ms: number; latency_samples: number }>(sql`
    select day::text, checks, successes, latency_total_ms::int, latency_samples from product_health_daily where slug = ${slug} order by day`));
}

export async function rawRows(slug: string) {
  return Array.from(await db.execute<{ host: string; disposition: string; reason: string | null; status: number; kind: string; observation_id: string }>(sql`
    select host, disposition, reason, status, kind, observation_id::text from uptime_observations where slug = ${slug} order by received_at, observation_id`));
}

/** 이 파일이 쓰는 공유 test DB 상태를 비운다(제품 TRUNCATE 가 claim 행을 cascade 로 지운다). resetTables 뒤에 부른다 */
export async function clearSplitState() {
  // 이 파일이 앞 시험에서 raw 사실을 남긴 제품 id 는 다시 쓰지 않는다. 같은 대역 시작으로 매번 되돌리면 파일 끝의 시퀀스가 이미 쓴 id 보다
  // 낮게 남고, 표를 비우지 않는 뒤 파일(예: oracle-db-roles 의 canary 제품)이 그 id 를 받아 남의 raw 사실을 제 것으로 센다
  await db.execute(sql`select setval(pg_get_serial_sequence('products', 'id'), greatest(${PRODUCT_ID_BASE}::bigint,
    (select max(product_id) from uptime_observations where product_id between ${PRODUCT_ID_BASE} and ${PRODUCT_ID_BASE + 1_000_000})))`);
  await db.execute(sql`delete from uptime_host_windows`);
  await db.execute(sql`delete from uptime_host_breakers`);
  await db.execute(sql`update uptime_control set observations_enabled = false, gate_enabled = false where id = 1
    and (observations_enabled or gate_enabled)`);
}
