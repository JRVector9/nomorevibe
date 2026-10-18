import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, onPrimary } from "@/lib/db";
import { uptimeSplitControl } from "@/lib/db/product-uptime-schema";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { assertJobLeaseAtWallTime, type JobLease } from "@/lib/jobs/control";
import { DrWriterFencedError, writerSiteActive } from "@/lib/operations/dr/epoch";
import type { ProductTransaction } from "./generation";
import { RECHECK_AFTER_MINUTES } from "./health-freshness";
import { advanceUptimeBreaker, closedUptimeBreaker, parseUptimeSplitControl, uptimeClaimAllowance, uptimeSplitHostEntry,
  UPTIME_HTTP_STATUS_MAX, UPTIME_SPLIT_CLOCK_SKEW_MS, type UptimeBreakerState, type UptimeHost, type UptimeHostBreaker, type UptimeHostClass,
  type UptimeSplitControl } from "./uptime-split-policy";

/**
 * split-v1 claim 저장소(0103 uptime_claims). 제품당 1행을 idle → claimed → submitted 로 옮긴다. 정식 기록은 쓰지 않는다
 * (home 적용기 uptime-apply.ts 만 쓴다). 그래서 Oracle principal 은 이 파일의 claim·제출·되돌림만 할 수 있으면 된다.
 *
 * - claim: due 선정 + FOR UPDATE SKIP LOCKED + 소유 기록을 한 TX 의 두 문장으로 한다. 다른 owner 가 잡고 있는 행은 기다리지 않고 건너뛴다.
 * - 같은 사이트(origin) 동시 1: 다른 owner 의 살아 있는 claim 이 있는 origin 은 고르지 않는다. 고른 origin 은 TX 끝까지
 *   advisory lock 을 쥐고, lock 을 얻은 뒤의 새 snapshot 으로 다시 확인한다 — 동시에 같은 origin 을 고른 두 TX 중 하나만 가져간다.
 * - 제출: token·epoch·owner·control epoch CAS. claim 회차당 한 번만 submitted 가 된다(같은 6h slot 중복 쓰기의 첫 겹).
 * - 시각은 DB clock_timestamp 다. host 시계는 제출 결과의 시작·관측 시각에만 쓰고 ±30초만 믿는다.
 */

const MAX_CLAIM = 200;
const MAX_SUBMIT = 200;
const SYNC_DEFAULT = 2_000;
const SYNC_MAX = 10_000;
const HOME_CLASS: UptimeHostClass = "home";

function supported() { if (currentReplayDb()) throw new Error("uptime_split_replay_unsupported"); }

export const UptimeClaimOwnerSchema = z.strictObject({
  instanceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/), bootId: z.uuid(),
});
export type UptimeClaimOwner = z.infer<typeof UptimeClaimOwnerSchema>;

const resultSchema = (maxHttpStatus: number) => z.strictObject({
  productId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), token: z.uuid(),
  epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  startedAt: z.date(), observedAt: z.date(),
  kind: z.enum(["http", "timeout", "dns", "network", "unknown"]), status: z.number().int().min(0).max(maxHttpStatus),
  latencyMs: z.number().int().min(0).max(2_147_483_647).nullable(),
}).superRefine((value, ctx) => {
  if (!Number.isFinite(value.startedAt.getTime()) || !Number.isFinite(value.observedAt.getTime()) || value.observedAt < value.startedAt
    || (value.kind === "http" ? value.status < 100 : value.status !== 0)) ctx.addIssue({ code: "custom", message: "uptime_result_invalid" });
});
/** 결과 한 건(제출·적용 공통 모양). 시작·관측은 확인한 host 의 시계다. 제출분은 claim 행 CHECK 와 같이 HTTP 100..599 만 담는다 */
export const UptimeResultSchema = resultSchema(599);
export type UptimeResult = z.infer<typeof UptimeResultSchema>;
/**
 * home 이 직접 연 결과(적용기 own). 제출 행에 담지 않으므로 비표준 HTTP 상태(예: 999)도 그대로 받는다 — legacy recordPing 이
 * product_health.status 에 999 를 실패로 그대로 쓰는 것과 같은 의미다(UPTIME_HTTP_STATUS_MAX, uptime-split-policy.ts).
 */
export const UptimeOwnResultSchema = resultSchema(UPTIME_HTTP_STATUS_MAX);

export type UptimeClaimTicket = {
  productId: number; slug: string; url: string; token: string; epoch: number;
  claimedAt: Date; leaseUntil: Date; confirmClass: "home" | null;
};
export type UptimeSplitBlocked = "site_fenced" | "mode_legacy" | "source_unconfigured" | "breaker_open";
export type UptimeClaimBatch =
  | { kind: "claimed"; controlEpoch: number; host: UptimeHost; hostClass: UptimeHostClass; breaker: UptimeBreakerState; claims: UptimeClaimTicket[] }
  | { kind: "blocked"; reason: UptimeSplitBlocked; controlEpoch: number | null };
export type UptimeSubmitOutcome =
  | { kind: "submitted"; controlEpoch: number; accepted: number[]; lost: number[] }
  | { kind: "blocked"; reason: Exclude<UptimeSplitBlocked, "breaker_open">; controlEpoch: number | null };

/** uptime_split_control 을 FOR SHARE 로 잠그고 검증한다(policy hash 가 틀리면 던진다 — fail-closed) */
export async function lockUptimeSplitControl(tx: ProductTransaction): Promise<UptimeSplitControl> {
  const [row] = await tx.select().from(uptimeSplitControl).where(eq(uptimeSplitControl.id, 1)).for("share");
  if (!row) throw new Error("uptime_split_control_missing");
  return parseUptimeSplitControl({ mode: row.mode, epoch: row.epoch, policy: row.policy, policyHash: row.policyHash });
}

/** 잠그지 않는 읽기 — consumer 가 쉬거나 다시 읽을지 정할 때 쓴다. 실제 권한 확인은 claim·제출 TX 가 다시 한다 */
export async function readUptimeSplitControl(): Promise<UptimeSplitControl> {
  const [row] = await db.select().from(uptimeSplitControl).where(eq(uptimeSplitControl.id, 1));
  if (!row) throw new Error("uptime_split_control_missing");
  return parseUptimeSplitControl({ mode: row.mode, epoch: row.epoch, policy: row.policy, policyHash: row.policyHash });
}

// products.url 의 scheme://host[:port] (소문자). 두 claim 의 비교는 언제나 이 같은 식으로 하므로 JS URL.origin 과 달라도 된다
const originOf = (url: ReturnType<typeof sql>) =>
  sql`coalesce(lower(substring(${url} from '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]+')), ${url})`;

/**
 * 이 owner 의 host·class(policy 의 instance 매핑)로 due 제품을 최대 limit 건 claim 한다. probe 는 policy 의 batch 를 넘지 않는다.
 * home 은 재확인 요청(confirm)을 먼저 가져간다. probe 는 실패 중·home 고정(affinity) 제품과 재확인 요청을 가져가지 않는다.
 * 차단기가 열려 있으면 가져가지 않고, probing 이면 probeSize 에서 이미 받은 수·나가 있는 수를 뺀 만큼만, 실패 중·재확인 요청이 아닌 제품만 가져간다.
 * 아무것도 쓰지 않는 거절은 blocked 로 돌려준다(fenced DB·legacy·policy 에 없는 instance·차단기).
 */
export async function claimUptimeProducts(input: { owner: UptimeClaimOwner; limit: number }): Promise<UptimeClaimBatch> {
  supported();
  const owner = UptimeClaimOwnerSchema.parse(structuredClone(input.owner));
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_CLAIM) throw new Error("invalid uptime claim batch");
  return onPrimary(() => db.transaction(async tx => {
    // DR writer fence 가 첫 lock 이다(seal 의 fence UPDATE → … → uptime_claims 와 같은 순서)
    if (!await writerSiteActive(tx)) return { kind: "blocked", reason: "site_fenced", controlEpoch: null };
    const control = await lockUptimeSplitControl(tx);
    if (control.mode !== "claims" || !control.policy) return { kind: "blocked", reason: "mode_legacy", controlEpoch: control.epoch };
    const policy = control.policy;
    const entry = uptimeSplitHostEntry(policy, owner.instanceId);
    if (!entry) return { kind: "blocked", reason: "source_unconfigured", controlEpoch: control.epoch };

    // 나가 있는 probing claim: probe_after 뒤에 잡은 살아 있는 claim·아직 적용 안 된 제출. 저장된 상태가 아직 open 이어도
    // (적용기가 probing 으로 옮기기 전) 같은 기준으로 센다 — 그래야 그 사이 claim 이 probeSize 를 거듭 가져가지 않는다
    const [state] = await tx.execute<{ wall_ms: number; row: Record<string, unknown> | null; in_flight: number }>(sql`
      select (extract(epoch from clock_timestamp()) * 1000)::float8 as wall_ms,
        (select to_jsonb(b) from uptime_host_breakers b where b.host = ${entry.host}) as row,
        (select count(*)::int from uptime_claims c join uptime_host_breakers b on b.host = c.host
          where c.host = ${entry.host} and b.probe_after is not null and c.claimed_at >= b.probe_after
            and (c.state = 'submitted' or (c.state = 'claimed' and c.lease_until > clock_timestamp()))) as in_flight`);
    const wall = new Date(state.wall_ms);
    const breaker = advanceUptimeBreaker(state.row ? breakerFromJson(state.row) : closedUptimeBreaker(entry.host, policy), wall);
    const allowance = uptimeClaimAllowance(breaker, policy, { requested: Math.min(input.limit, entry.batch ?? input.limit),
      inFlight: breaker.state === "probing" ? state.in_flight : 0 });
    if (allowance === 0) return { kind: "blocked", reason: "breaker_open", controlEpoch: control.epoch };

    const probe = entry.class !== HOME_CLASS;
    // 차단기 시험(probing) 표본은 이 host 네트워크가 돌아왔는지 보는 것이다 — 실패 중인 제품·재확인 요청(대개 실제로 죽은 사이트)이 섞이면
    // 사이트의 죽음이 host 장애로 보여 시험이 매번 실패하고 영영 닫히지 않는다(review F2). 그래서 probing 동안은 건강하다고 알려진 제품
    // (연속 실패 0, 재확인 요청 아님)만 가져간다. home 고정(affinity) 제품은 home 에서 열렸던 제품이라 표본에 든다
    const healthyOnly = probe || breaker.state === "probing";
    // 1) 후보를 잠근다(다른 owner 가 잡은 행은 건너뛴다). origin advisory lock 은 고른 행에서만 시도한다(기다리지 않는다)
    const picked = await tx.execute<{ product_id: number; slug: string; url: string; origin: string; locked: boolean }>(sql`
      with cand as materialized (
        select c.product_id, p.slug, p.url, ${originOf(sql`p.url`)} as origin
        from uptime_claims c join products p on p.id = c.product_id left join product_health h on h.slug = p.slug
        where p.status in ('verified','seeded') and p.access_mode = 'website'
          and (c.state = 'idle' or (c.state = 'claimed' and c.lease_until <= ${wall.toISOString()}::timestamptz))
          and c.due_at <= ${wall.toISOString()}::timestamptz and c.epoch < 9007199254740991
          -- legacy 쓰기와 겹쳐도 낭비하지 않는다. 재확인 요청은 정식 반영이 없었으므로 이 조건을 건너뛴다
          and (c.confirm_class is not null or h.checked_at is null
            or h.checked_at <= (${wall.toISOString()}::timestamptz at time zone 'UTC') - ${RECHECK_AFTER_MINUTES} * interval '1 minute')
          and (${!healthyOnly} or (c.confirm_class is null and coalesce(h.failures, 0) = 0))
          and (${!probe} or coalesce(c.affinity_home_until, '-infinity') <= ${wall.toISOString()}::timestamptz)
          and (c.confirm_class is null or c.confirm_class = ${entry.class})
          and not exists (select 1 from uptime_claims o where o.state = 'claimed' and o.lease_until > clock_timestamp()
            and o.owner_instance_id <> ${owner.instanceId} and o.origin = ${originOf(sql`p.url`)})
        order by (c.confirm_class is not null) desc, c.due_at, c.product_id
        limit ${allowance} for update of c skip locked)
      select product_id, slug, url, origin, pg_try_advisory_xact_lock(hashtext('uptime-origin'), hashtext(origin)) as locked from cand`);
    const chosen = Array.from(picked).filter(row => row.locked)
      .map(row => ({ product_id: row.product_id, slug: row.slug, url: row.url, origin: row.origin }));
    if (chosen.length === 0) return { kind: "claimed", controlEpoch: control.epoch, host: entry.host, hostClass: entry.class, breaker: breaker.state, claims: [] };
    // 2) origin lock 을 쥔 뒤의 새 snapshot 으로 다른 owner 의 claim 을 다시 본다. 행은 1)에서 잠갔으므로 상태가 그대로다
    const written = await tx.execute<{ product_id: number; slug: string; url: string; token: string; epoch: number;
      claimed_ms: number; lease_ms: number; confirm_class: "home" | null }>(sql`
      update uptime_claims c set state = 'claimed', epoch = c.epoch + 1, control_epoch = ${control.epoch}, token = gen_random_uuid(),
        owner_instance_id = ${owner.instanceId}, owner_boot_id = ${owner.bootId}::uuid, host = ${entry.host}, host_class = ${entry.class},
        claimed_at = t.at, lease_until = t.at + ${policy.claim.ttlMs} * interval '1 millisecond',
        claim_slug = r.slug, claim_url = r.url, origin = r.origin,
        claim_slot = to_timestamp(floor(extract(epoch from t.at) / 21600) * 21600),
        result_started_at = null, result_observed_at = null, result_kind = null, result_status = null, result_latency_ms = null,
        submitted_at = null, updated_at = t.at
      from jsonb_to_recordset(${JSON.stringify(chosen)}::jsonb) as r(product_id integer, slug varchar, url text, origin text),
        (select date_trunc('milliseconds', clock_timestamp()) as at) t
      where c.product_id = r.product_id
        and not exists (select 1 from uptime_claims o where o.state = 'claimed' and o.lease_until > clock_timestamp()
          and o.owner_instance_id <> ${owner.instanceId} and o.origin = r.origin)
      returning c.product_id, c.claim_slug as slug, c.claim_url as url, c.token::text as token, c.epoch::float8 as epoch,
        (extract(epoch from c.claimed_at) * 1000)::float8 as claimed_ms, (extract(epoch from c.lease_until) * 1000)::float8 as lease_ms,
        c.confirm_class`);
    const claims = Array.from(written, row => ({ productId: row.product_id, slug: row.slug, url: row.url, token: row.token,
      epoch: Number(row.epoch), claimedAt: new Date(row.claimed_ms), leaseUntil: new Date(row.lease_ms), confirmClass: row.confirm_class }))
      .sort((a, b) => a.productId - b.productId);
    return { kind: "claimed", controlEpoch: control.epoch, host: entry.host, hostClass: entry.class, breaker: breaker.state, claims };
  }));
}

function breakerFromJson(row: Record<string, unknown>): UptimeHostBreaker {
  const at = (value: unknown) => typeof value === "string" ? new Date(value) : null;
  return { host: row.host as UptimeHost, state: row.state as UptimeBreakerState, openedAt: at(row.opened_at), probeAfter: at(row.probe_after),
    coolDownMs: Number(row.cool_down_ms), reason: (row.reason as string | null) ?? null, ratio: row.ratio === null ? null : Number(row.ratio),
    probeChecks: Number(row.probe_checks), probeFailures: Number(row.probe_failures) };
}

/**
 * 확인 결과를 제출한다(state claimed → submitted). token·epoch·owner(instance·boot)·지금 control epoch 가 맞고 host 시계가
 * ±30초 안인 것만 받는다. 받지 않은 것은 lost 다 — 다시 claim 됐거나, epoch 이 바뀌었거나, 이미 제출했다.
 * 만료됐어도 아직 다른 owner 가 가져가지 않았으면 token 이 같으므로 받는다(행 lock 으로 claim 과 제출 중 먼저 commit 한 쪽만 이긴다).
 */
export async function submitUptimeResults(input: { owner: UptimeClaimOwner; results: readonly UptimeResult[] }): Promise<UptimeSubmitOutcome> {
  supported();
  const owner = UptimeClaimOwnerSchema.parse(structuredClone(input.owner));
  if (input.results.length > MAX_SUBMIT) throw new Error("invalid uptime submit batch");
  const results = input.results.map(result => UptimeResultSchema.parse(structuredClone(result)));
  if (new Set(results.map(result => result.productId)).size !== results.length) throw new TypeError("uptime_split_duplicate_product");
  return onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) return { kind: "blocked", reason: "site_fenced", controlEpoch: null };
    const control = await lockUptimeSplitControl(tx);
    if (control.mode !== "claims" || !control.policy) return { kind: "blocked", reason: "mode_legacy", controlEpoch: control.epoch };
    if (!uptimeSplitHostEntry(control.policy, owner.instanceId)) return { kind: "blocked", reason: "source_unconfigured", controlEpoch: control.epoch };
    if (results.length === 0) return { kind: "submitted", controlEpoch: control.epoch, accepted: [], lost: [] };
    const rows = results.map(result => ({ product_id: result.productId, token: result.token, epoch: result.epoch,
      started_at: result.startedAt.toISOString(), observed_at: result.observedAt.toISOString(), kind: result.kind,
      status: result.status, latency_ms: result.latencyMs }));
    const accepted = await tx.execute<{ product_id: number }>(sql`
      update uptime_claims c set state = 'submitted', lease_until = null, submitted_at = clock_timestamp(),
        result_started_at = r.started_at, result_observed_at = r.observed_at, result_kind = r.kind, result_status = r.status,
        result_latency_ms = r.latency_ms, updated_at = clock_timestamp()
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as r(product_id integer, token uuid, epoch bigint,
        started_at timestamptz, observed_at timestamptz, kind varchar, status integer, latency_ms integer)
      where c.product_id = r.product_id and c.token = r.token and c.epoch = r.epoch and c.state = 'claimed'
        and c.owner_instance_id = ${owner.instanceId} and c.owner_boot_id = ${owner.bootId}::uuid and c.control_epoch = ${control.epoch}
        and r.started_at >= c.claimed_at - ${UPTIME_SPLIT_CLOCK_SKEW_MS} * interval '1 millisecond'
        and r.observed_at <= clock_timestamp() + ${UPTIME_SPLIT_CLOCK_SKEW_MS} * interval '1 millisecond'
      returning c.product_id`);
    const ok = new Set(Array.from(accepted, row => row.product_id));
    return { kind: "submitted", controlEpoch: control.epoch, accepted: results.map(result => result.productId).filter(id => ok.has(id)),
      lost: results.map(result => result.productId).filter(id => !ok.has(id)) };
  }));
}

/**
 * 열지 않은 claim 을 풀로 돌려준다(종료 정리). 같은 owner·token·epoch 의 claimed 행만 idle 로 바꾸고 due 는 그대로 둔다 —
 * 다음 claim 이 바로 가져간다. fenced DB 에서는 아무것도 하지 않는다(seal 이 이미 회수했다).
 */
export async function releaseUptimeClaims(input: { owner: UptimeClaimOwner; claims: readonly { productId: number; token: string; epoch: number }[] }):
  Promise<{ kind: "released"; released: number[] } | { kind: "blocked"; reason: "site_fenced" }> {
  supported();
  const owner = UptimeClaimOwnerSchema.parse(structuredClone(input.owner));
  if (input.claims.length > MAX_CLAIM) throw new Error("invalid uptime release batch");
  const rows = input.claims.map(claim => z.strictObject({ productId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), token: z.uuid(),
    epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).parse({ productId: claim.productId, token: claim.token, epoch: claim.epoch }))
    .map(claim => ({ product_id: claim.productId, token: claim.token, epoch: claim.epoch }));
  return onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) return { kind: "blocked", reason: "site_fenced" } as const;
    if (rows.length === 0) return { kind: "released", released: [] } as const;
    const released = await tx.execute<{ product_id: number }>(sql`
      update uptime_claims c set state = 'idle', token = null, lease_until = null, updated_at = clock_timestamp()
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as r(product_id integer, token uuid, epoch bigint)
      where c.product_id = r.product_id and c.token = r.token and c.epoch = r.epoch and c.state = 'claimed'
        and c.owner_instance_id = ${owner.instanceId} and c.owner_boot_id = ${owner.bootId}::uuid
      returning c.product_id`);
    return { kind: "released", released: Array.from(released, row => row.product_id).sort((a, b) => a - b) } as const;
  }));
}

/**
 * 공개 website 제품 중 uptime_claims 행이 없는 것에 idle 행을 만든다(home 잡만 부른다. Oracle 에는 INSERT 권한이 없다).
 * due 는 0103 백필과 같다: 마지막 확인 + 6시간, 확인한 적 없으면 지금. 비공개가 된 제품의 행은 claim 조건이 거르고, 삭제는 FK cascade 다.
 * 행을 만들기만 하므로 legacy 동작은 바뀌지 않는다. fenced DB 에서는 worker 쓰기와 같이 거절한다.
 */
export async function syncUptimeClaimRows(input: { limit?: number; lease?: JobLease } = {}): Promise<number> {
  supported();
  const limit = input.limit ?? SYNC_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SYNC_MAX) throw new Error("invalid uptime sync batch");
  return onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
    const inserted = await tx.execute<{ product_id: number }>(sql`
      insert into uptime_claims (product_id, due_at)
      select p.id, coalesce((h.checked_at at time zone 'UTC') + ${RECHECK_AFTER_MINUTES} * interval '1 minute', clock_timestamp())
      from products p left join product_health h on h.slug = p.slug
      where p.status in ('verified','seeded') and p.access_mode = 'website'
        and not exists (select 1 from uptime_claims c where c.product_id = p.id)
      order by p.id limit ${limit}
      on conflict (product_id) do nothing
      returning product_id`);
    if (input.lease) await assertJobLeaseAtWallTime(tx, input.lease);
    return inserted.length;
  }));
}
