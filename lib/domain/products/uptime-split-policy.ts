import { createHash } from "node:crypto";
import { z } from "zod";
import { RECHECK_AFTER_MINUTES, UPTIME_AUTO_BAN_THRESHOLD } from "./health-freshness";
import { isUnknownUptimeStatus } from "./health-record";
import { UptimeHostSchema, uptimeSlot, type UptimeDisposition, type UptimeObservation, type UptimeSource } from "./uptime-policy";

/**
 * split-v1 — 제품 연결 확인을 home(M3·mini)과 probe(Oracle)가 제품 단위로 나눠 맡을 때의 판정 규칙(0103 표).
 * 이 파일은 순수 함수만 둔다. DB·시계·환경 변수를 읽지 않는다. 시각은 부르는 쪽이 DB clock_timestamp 로 넘긴다.
 *
 * - 성공은 어느 host 것이든 반영한다(어디선가 열리면 살아 있다).
 * - probe(Oracle) 실패는 절대 세지 않는다. 차단기가 닫혀 있으면 home 재확인을 요청하고, 열려 있으면 풀로 되돌린다.
 * - home 실패도 그 host 차단기가 닫혀 있고 이번 묶음이 광역 실패 모양이 아닐 때만 센다. 세지 않은 home 실패는 legacy 광역 보류와 같이
 *   판정 보류다 — 확인 시각만 넘긴다(writeHealthHeld, 연속 실패가 자동 내림 기준 이상이면 시각도 그대로).
 * - 봇·로그인 차단 응답(401·403·429·999)은 살았는지 알 수 없다(legacy recordPing 과 같은 목록). home 이 보면 세지도 끊지도 않고 확인 시각·응답 코드만
 *   남긴다(writeHealthUnknown). probe 가 보면 다른 실패처럼 home 재확인을 요청한다. 차단기 비율에서는 legacy 광역 비율처럼 실패 쪽에 센다.
 * - 숨김 3회·내림 10회·최종 commit 보호는 기존 함수(notDown·autoBanUptimeProduct)가 그대로 맡는다. 여기서는 카운터를 누가 올리는지만 정한다.
 */

export type UptimeHost = UptimeSource["host"];
export const UPTIME_SPLIT_POLICY_VERSION = "split-v1";
export const UPTIME_SPLIT_MODES = ["legacy", "claims"] as const;
export type UptimeSplitMode = (typeof UPTIME_SPLIT_MODES)[number];
export const UPTIME_CLAIM_STATES = ["idle", "claimed", "submitted"] as const;
export type UptimeClaimState = (typeof UPTIME_CLAIM_STATES)[number];
export const UPTIME_HOST_CLASSES = ["home", "probe"] as const;
export type UptimeHostClass = (typeof UPTIME_HOST_CLASSES)[number];
export const UPTIME_BREAKER_STATES = ["closed", "open", "probing"] as const;
export type UptimeBreakerState = (typeof UPTIME_BREAKER_STATES)[number];

/** host 시계를 믿는 폭. 시작이 claim 보다, 관측이 적용 시각보다 이만큼 넘게 어긋나면 stale clock 이다(제출 CAS 와 같은 값). */
export const UPTIME_SPLIT_CLOCK_SKEW_MS = 30_000;
/**
 * 확인을 시작하기 전에 잰 host−DB 시계 차가 이만큼 넘으면 claim·확인을 쉰다(home 잡·Oracle consumer). 결과가 위 폭에 걸려 버려질
 * 확인으로 사이트를 두드리지 않는다. 재는 오차(왕복의 절반)와 묶음이 도는 동안의 흐름을 위해 폭보다 10초 좁게 둔다.
 */
export const UPTIME_SPLIT_CLOCK_GUARD_MS = UPTIME_SPLIT_CLOCK_SKEW_MS - 10_000;
/** home 광역 실패를 보류했지만 확인 시각을 넘기지 못한 제품(연속 실패가 자동 내림 기준 이상)·시계가 틀린 결과를 다시 볼 때까지 */
export const UPTIME_SPLIT_HOLD_MS = 15 * 60_000;
/** 정식 확인 간격. legacy(nextToCheck)와 같은 6시간이다 */
export const UPTIME_RECHECK_MS = RECHECK_AFTER_MINUTES * 60_000;
/** uptime_host_windows 한 칸 */
export const UPTIME_WINDOW_BUCKET_MS = 60_000;
/**
 * 한 틱(묶음) 광역 실패 기준. 평소 하루 실패는 확인의 0.6~1.8%다(2026-10-14~18) — 한 틱의 30%를 넘는 실패는 사이트가 아니라
 * 확인한 서버 쪽 문제로 본다. 표본이 너무 작으면 몇 건만 죽어도 비율이 튀므로 30건부터 판단한다.
 * legacy 잡의 틱 보류(uptime.ts)와 split 정책의 batchMin·batchOpenRatio 가 같은 값이어야 한다 — 제어 CLI(uptime-split)가 다른 값을 거절한다.
 */
export const UPTIME_BROAD_FAILURE_MIN_CHECKS = 30;
export const UPTIME_BROAD_FAILURE_RATIO = 0.3;
/**
 * home 결과가 담을 수 있는 HTTP 상태 상한. safeFetch 는 100..599 밖의 비표준 상태(예: LinkedIn 999)를 그대로 돌려주고, legacy(recordPing)는
 * 그것을 product_health.status 에 그대로 쓰고 실패로 센다(2xx·3xx 만 성공). split 의 정식 기록도 같은 값·같은 의미(실패)로 쓴다 —
 * 알 수 없음(unknown/0)으로 바꾸면 상태별 규칙(예: 차단성 응답을 따로 다루는 규칙)이 legacy 와 claims 에서 달라진다.
 * 100..599 만 담는 표(uptime_claims 제출 칸, uptime_observations)에는 담을 수 없어 그 표에만 unknown/0 으로 남긴다(Oracle consumer 와 같다).
 * HTTP 상태 줄은 세 자리라 999 가 끝이다.
 */
export const UPTIME_HTTP_STATUS_MAX = 999;
/** uptime_claims·uptime_observations CHECK 가 받는 표준 범위 */
export function uptimeStandardHttpStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 100 && status <= 599;
}
const DAY_MS = 24 * 60 * 60_000;
const KST_OFFSET_MS = 9 * 60 * 60_000;
const LISTED = new Set(["verified", "seeded"]);

/** Oracle 은 언제나 probe, M3·mini 는 home 이다. 0103 의 uptime_claims_host CHECK 와 같다. */
export function uptimeHostClass(host: UptimeHost): UptimeHostClass {
  return host === "oracle-osaka-smoke" ? "probe" : "home";
}

// SERVICE_INSTANCE_ID 와 같은 모양(uptime_claims.owner_instance_id varchar(48)). 지역 이름 규칙은 UptimeSourceSchema 와 같다.
const instanceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/);
const region = z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const openRatio = z.number().gt(0).lt(1);

export const UptimeSplitHostSchema = z.strictObject({
  host: UptimeHostSchema, instanceId, region, class: z.enum(UPTIME_HOST_CLASSES),
  maxPerHour: z.number().int().min(1).max(20_000).optional(),
  batch: z.number().int().min(1).max(200).optional(),
  concurrency: z.number().int().min(1).max(16).optional(),
}).superRefine((value, ctx) => {
  if (value.class !== uptimeHostClass(value.host)) ctx.addIssue({ code: "custom", message: "uptime_split_host_class" });
  if (value.host === "oracle-osaka-smoke" && value.region !== "ap-osaka-1") ctx.addIssue({ code: "custom", message: "uptime_split_oracle_region" });
  // probe 는 정책으로 정한 상한 없이 돌지 않는다
  if (value.class === "probe" && (value.maxPerHour === undefined || value.batch === undefined || value.concurrency === undefined)) {
    ctx.addIssue({ code: "custom", message: "uptime_split_probe_pacing_required" });
  }
});
export type UptimeSplitHost = z.infer<typeof UptimeSplitHostSchema>;

export const UptimeSplitBreakerSchema = z.strictObject({
  windowMinutes: z.number().int().min(1).max(60), minChecks: z.number().int().min(1).max(100_000), openRatio,
  batchMin: z.number().int().min(1).max(1_000), batchOpenRatio: openRatio,
  coolDownMinutes: z.number().int().min(1).max(1_440), maxCoolDownMinutes: z.number().int().min(1).max(1_440),
  probeSize: z.number().int().min(1).max(200), probeCloseRatio: z.number().min(0).lt(1),
  // cool-down 이 창보다 짧으면 닫힌 직후 장애 때 실패가 아직 창에 남아 바로 다시 열린다
}).refine(value => value.maxCoolDownMinutes >= value.coolDownMinutes && value.coolDownMinutes >= value.windowMinutes,
  { message: "uptime_split_cool_down_range" });
export type UptimeSplitBreakerPolicy = z.infer<typeof UptimeSplitBreakerSchema>;

export const UptimeSplitPolicySchema = z.strictObject({
  version: z.literal(1),
  hosts: z.array(UptimeSplitHostSchema).min(1).max(8),
  claim: z.strictObject({ ttlMs: z.number().int().min(30_000).max(900_000) }),
  confirm: z.strictObject({ affinityDays: z.number().int().min(1).max(30) }),
  breaker: UptimeSplitBreakerSchema,
}).superRefine((policy, ctx) => {
  if (new Set(policy.hosts.map(entry => entry.instanceId)).size !== policy.hosts.length) {
    ctx.addIssue({ code: "custom", message: "uptime_split_duplicate_instance" });
  }
  const regions = new Map<string, string>();
  for (const entry of policy.hosts) {
    if ((regions.get(entry.host) ?? entry.region) !== entry.region) ctx.addIssue({ code: "custom", message: "uptime_split_host_region" });
    regions.set(entry.host, entry.region);
  }
  // 실패를 셀 home 이 없으면 재확인 요청이 쌓이기만 한다
  if (!policy.hosts.some(entry => entry.class === "home")) ctx.addIssue({ code: "custom", message: "uptime_split_home_required" });
});
export type UptimeSplitPolicy = z.infer<typeof UptimeSplitPolicySchema>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

/** 키 정렬·host 항목 instanceId 정렬 뒤 sha256. jsonb 왕복(키 순서 변경)에도 같은 값이다. */
export function uptimeSplitPolicyHash(value: unknown): string {
  const policy = UptimeSplitPolicySchema.parse(value);
  const hosts = [...policy.hosts].sort((a, b) => a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(canonical({ ...policy, hosts }))).digest("hex");
}

/** host·class 는 env 가 아니라 policy 의 instance 매핑으로 정한다. 없으면 null(claim·적용 모두 거부). */
export function uptimeSplitHostEntry(policy: UptimeSplitPolicy, instance: string): UptimeSplitHost | null {
  return policy.hosts.find(entry => entry.instanceId === instance) ?? null;
}

export type UptimeSplitControl = { mode: UptimeSplitMode; epoch: number; policy: UptimeSplitPolicy | null; policyHash: string | null };

/** uptime_split_control 행을 읽어 검증한다. 저장된 hash 가 policy 와 다르면 쓰지 않는다. */
export function parseUptimeSplitControl(row: { mode: string; epoch: number; policy: unknown; policyHash: string | null }): UptimeSplitControl {
  const mode = z.enum(UPTIME_SPLIT_MODES).parse(row.mode);
  if (!Number.isSafeInteger(row.epoch) || row.epoch < 1) throw new Error("uptime_split_control_invalid");
  if ((row.policy === null) !== (row.policyHash === null)) throw new Error("uptime_split_control_invalid");
  const policy = row.policy === null ? null : UptimeSplitPolicySchema.parse(row.policy);
  if (policy && uptimeSplitPolicyHash(policy) !== row.policyHash) throw new Error("uptime_split_policy_hash_mismatch");
  if (mode === "claims" && !policy) throw new Error("uptime_split_policy_required");
  return { mode, epoch: row.epoch, policy, policyHash: row.policyHash };
}

// ---- 시각 ----

/** products.updated_at::text(시간대 없는 UTC, 마이크로초까지)를 epoch 마이크로초로. JS Date 로 바꾸면 마이크로초를 잃는다. */
export function dbTimestampMicros(text: string): number {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(text);
  const ms = match ? Date.parse(`${match[1]}T${match[2]}Z`) : Number.NaN;
  if (!match || !Number.isFinite(ms)) throw new Error("invalid_db_timestamp");
  return ms * 1000 + Number((match[3] ?? "").padEnd(6, "0"));
}

const micros = (at: Date) => at.getTime() * 1000;
const finite = (at: Date | null): at is Date => at instanceof Date && Number.isFinite(at.getTime());

/** product_health_daily 의 날짜(KST). writeHealthResult 와 같은 계산이다. */
export function uptimeHealthDay(observedAt: Date): string {
  return new Date(observedAt.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** uptime_host_windows 칸(분 단위로 내림) */
export function uptimeWindowBucket(at: Date): Date {
  return new Date(Math.floor(at.getTime() / UPTIME_WINDOW_BUCKET_MS) * UPTIME_WINDOW_BUCKET_MS);
}

/** 차단기 창의 시작. bucket > 이 값인 칸을 더해 context.windows 로 넘긴다 */
export function uptimeWindowSince(policy: UptimeSplitPolicy, wall: Date): Date {
  return new Date(wall.getTime() - policy.breaker.windowMinutes * 60_000);
}

/** host 시계 범위: 시작은 claim −30초 이후, 관측은 시작 이후이고 적용 시각 +30초 이전 */
export function uptimeSplitClockValid(input: { claimedAt: Date | null; startedAt: Date; observedAt: Date; wall: Date }): boolean {
  const { claimedAt, startedAt, observedAt, wall } = input;
  if (!finite(claimedAt) || !finite(startedAt) || !finite(observedAt) || !finite(wall)) return false;
  return startedAt.getTime() >= claimedAt.getTime() - UPTIME_SPLIT_CLOCK_SKEW_MS
    && observedAt.getTime() >= startedAt.getTime() && observedAt.getTime() <= wall.getTime() + UPTIME_SPLIT_CLOCK_SKEW_MS;
}

/**
 * 연속 실패를 1 부터 다시 셀지(PR-0a 로 고친 recordPing 의 의미). health 는 URL 을 모르므로, 연속 실패가 시작된 뒤
 * 제품이 바뀌었으면 그 실패를 지금 주소에 이어 붙이지 않는다. health 가 없으면 거짓이다.
 */
export function splitResetStreak(health: UptimeHealthSnapshot | null, productUpdatedAt: string): boolean {
  if (!health) return false;
  const updated = dbTimestampMicros(productUpdatedAt);
  return micros(health.checkedAt) < updated || (health.downSince !== null && micros(health.downSince) < updated)
    || (health.failures > 0 && health.downSince === null);
}

// ---- host 차단기 ----

export type UptimeHostCounts = { checks: number; failures: number; transport: number };
export type UptimeHostBreaker = {
  host: UptimeHost; state: UptimeBreakerState; openedAt: Date | null; probeAfter: Date | null; coolDownMs: number;
  reason: string | null; ratio: number | null; probeChecks: number; probeFailures: number;
};
export type UptimeBreakerTrip = { reason: "batch_ratio" | "window_ratio"; ratio: number };
const ZERO: UptimeHostCounts = { checks: 0, failures: 0, transport: 0 };

export function closedUptimeBreaker(host: UptimeHost, policy: UptimeSplitPolicy): UptimeHostBreaker {
  return { host, state: "closed", openedAt: null, probeAfter: null, coolDownMs: policy.breaker.coolDownMinutes * 60_000,
    reason: null, ratio: null, probeChecks: 0, probeFailures: 0 };
}

/** 시간만으로 일어나는 전이: open 이고 probe_after 가 지났으면 probing(받은 수 0)이다. 적용기가 틱마다 모든 host 에 부른다. */
export function advanceUptimeBreaker(breaker: UptimeHostBreaker, wall: Date): UptimeHostBreaker {
  if (breaker.state !== "open" || !breaker.probeAfter || breaker.probeAfter.getTime() > wall.getTime()) return breaker;
  return { ...breaker, state: "probing", probeChecks: 0, probeFailures: 0 };
}

/** closed host 를 여는 조건: 한 묶음 batchMin 건 이상에서 batchOpenRatio 초과, 또는 창(이전 칸 + 이번 묶음) minChecks 건 이상에서 openRatio 초과 */
export function uptimeBreakerTrip(policy: UptimeSplitPolicy, window: UptimeHostCounts, batch: UptimeHostCounts): UptimeBreakerTrip | null {
  const { minChecks, openRatio, batchMin, batchOpenRatio } = policy.breaker;
  if (batch.checks >= batchMin && batch.failures / batch.checks > batchOpenRatio) return { reason: "batch_ratio", ratio: batch.failures / batch.checks };
  const checks = window.checks + batch.checks, failures = window.failures + batch.failures;
  if (checks >= minChecks && failures / checks > openRatio) return { reason: "window_ratio", ratio: failures / checks };
  return null;
}

function openBreaker(breaker: UptimeHostBreaker, wall: Date, coolDownMs: number, reason: string, ratio: number): UptimeHostBreaker {
  return { ...breaker, state: "open", openedAt: wall, probeAfter: new Date(wall.getTime() + coolDownMs), coolDownMs, reason, ratio,
    probeChecks: 0, probeFailures: 0 };
}

/**
 * 이번 묶음을 더한 뒤의 차단기. closed 는 창·묶음 비율로 연다. probing 은 probeSize 건을 받으면 실패율 probeCloseRatio 이하일 때 닫고,
 * 그 비율을 넘을 수밖에 없게 되면 바로 cool-down 을 두 배로(최대 maxCoolDownMinutes) 늘려 다시 연다. open 은 시간이 지나야 바뀐다.
 * probe 는 probing 이 된 뒤 claim 된 결과의 수다(그 전에 나간 결과는 회복 근거가 아니다).
 * opened_at 은 이번 열림 구간의 시작이다 — probing 에서 다시 열려도 처음 연 시각을 이어 간다(오래 열림 경보가 그 시각부터 잰다).
 */
export function settleUptimeBreaker(breaker: UptimeHostBreaker, policy: UptimeSplitPolicy,
  counts: { window: UptimeHostCounts; batch: UptimeHostCounts; probe: UptimeHostCounts }, wall: Date): UptimeHostBreaker {
  const config = policy.breaker, base = config.coolDownMinutes * 60_000;
  if (breaker.state === "closed") {
    const trip = uptimeBreakerTrip(policy, counts.window, counts.batch);
    return trip ? openBreaker(breaker, wall, base, trip.reason, trip.ratio) : breaker;
  }
  if (breaker.state === "open") return breaker;
  const probeChecks = breaker.probeChecks + counts.probe.checks, probeFailures = breaker.probeFailures + counts.probe.failures;
  const ratio = probeChecks === 0 ? 0 : probeFailures / probeChecks;
  if (probeFailures > config.probeCloseRatio * config.probeSize) {
    const reopened = openBreaker(breaker, wall, Math.min(breaker.coolDownMs * 2, config.maxCoolDownMinutes * 60_000), "probe_ratio", ratio);
    return { ...reopened, openedAt: breaker.openedAt ?? wall };
  }
  if (probeChecks >= config.probeSize) {
    return { ...breaker, state: "closed", probeAfter: null, coolDownMs: base, reason: null, ratio, probeChecks: 0, probeFailures: 0 };
  }
  return { ...breaker, probeChecks, probeFailures };
}

/**
 * 이번 claim 에서 이 host 가 가져갈 수 있는 수. closed 는 요청 그대로, open 은 0, probing 은 probeSize 에서 이미 받은 수와
 * 나가 있는 probing claim(claimedAt ≥ probeAfter 인 claimed·submitted) 수를 뺀 만큼이다. breaker 는 advanceUptimeBreaker 를 거친 값이다.
 */
export function uptimeClaimAllowance(breaker: UptimeHostBreaker, policy: UptimeSplitPolicy, input: { requested: number; inFlight: number }): number {
  if (breaker.state === "open") return 0;
  if (breaker.state === "closed") return input.requested;
  return Math.max(0, Math.min(input.requested, policy.breaker.probeSize - breaker.probeChecks - input.inFlight));
}

// ---- 판정 ----

/** 확인 결과. token·epoch 는 결과가 속한 claim 회차다(제출된 행이면 그 행의 값). */
export type UptimeSplitResult = {
  token: string; epoch: number; startedAt: Date; observedAt: Date;
  kind: UptimeObservation["kind"]; status: number; latencyMs: number | null;
};
/** 적용기가 FOR UPDATE 로 잠근 uptime_claims 행(drizzle 행을 그대로 넘길 수 있는 이름이다) */
export type UptimeClaimSnapshot = {
  productId: number; state: UptimeClaimState; token: string | null; epoch: number; controlEpoch: number | null;
  ownerInstanceId: string | null; host: UptimeHost | null; hostClass: UptimeHostClass | null; claimedAt: Date | null;
  claimSlug: string | null; claimUrl: string | null; dueAt: Date;
  confirmClass: "home" | null; confirmReason: string | null; confirmRequestedAt: Date | null;
  affinityHomeUntil: Date | null; conflictCount: number;
};
/** 잠근 products 행. updatedAt 은 products.updated_at::text 다(마이크로초 비교) */
export type UptimeProductSnapshot = { id: number; slug: string; url: string; status: string; accessMode: string; updatedAt: string };
/** 잠근 product_health 행(없으면 null) */
export type UptimeHealthSnapshot = { checkedAt: Date; failures: number; downSince: Date | null };
export type UptimeSplitInput = { claim: UptimeClaimSnapshot; result: UptimeSplitResult; product: UptimeProductSnapshot | null; health: UptimeHealthSnapshot | null;
  /** 제출 행(state submitted)에서 읽은 결과면 참. home 잡이 직접 연 결과(own)는 거짓이다 */
  submitted?: boolean };
export type UptimeSplitContext = {
  control: UptimeSplitControl;
  /** PR09 uptime_control. split 동안 둘 다 거짓이어야 한다(0103 트리거가 강제) */
  uptimeControl: { observationsEnabled: boolean; gateEnabled: boolean };
  /** 적용 TX 의 DB clock_timestamp */
  wall: Date;
  /** uptime_host_breakers 행. 없는 host 는 closed */
  breakers: readonly UptimeHostBreaker[];
  /** host 별 이전 창 합계(bucket > uptimeWindowSince). 이번 묶음은 넣지 않는다 */
  windows: Partial<Record<UptimeHost, UptimeHostCounts>>;
};

export type UptimeSplitOutcome = "lost" | "discarded" | "stale" | "held" | "applied" | "returned" | "confirm_requested";
export type UptimeSplitReason =
  | "claim_lost"
  | "mode_legacy" | "uptime_control_enabled" | "control_epoch" | "source_unconfigured" | "submitted_not_probe"
  | "product_missing" | "product_unlisted" | "url_changed" | "product_changed" | "clock" | "older_observation"
  | "minimum_interval"
  | "split_success" | "split_confirm_success" | "probe_breaker_open" | "split_confirm_required" | "split_broad_failure"
  | "split_counted" | "split_confirmed" | "split_unknown";

/** uptime_claims 를 state='idle', token·lease_until NULL 로 돌릴 때 쓸 값. token·epoch 는 CAS 조건이다(바뀌었으면 쓰지 않는다). */
export type UptimeClaimUpdate = {
  token: string; epoch: number; dueAt: Date;
  confirmClass: "home" | null; confirmReason: string | null; confirmRequestedAt: Date | null;
  affinityHomeUntil: Date | null; conflictCount: number; lastOutcome: UptimeSplitReason;
  /** null 이면 last_applied_* 를 그대로 둔다 */
  lastApplied: { at: Date; host: UptimeHost } | null;
};
/**
 * product_health 에 쓸 값과 product_health_daily 에 더할 날짜. kind 는 legacy 의 어느 기록과 같은지다.
 * - counted: writeHealthResult 를 이 행에 차례로 적용한 결과와 같다(성공 또는 센 실패, 일일 집계에 더한다).
 * - held: writeHealthHeld 와 같다 — 판정 보류. 확인 시각만 넘기고 연속 실패·첫 실패 시각·응답 코드·지연·일일 집계는 그대로다
 *   (status 는 행이 없는 새 제품에만 쓴다). failures·downSince 는 쓴 뒤에도 그대로인 값이다.
 * - unknown: writeHealthUnknown 과 같다 — 살았는지 알 수 없는 응답. 확인 시각·응답 코드만 쓰고 지연은 비운다. 연속 실패·첫 실패 시각·
 *   일일 집계는 그대로다. 다만 연속 실패를 다시 셀 때(splitResetStreak, counted 와 같은 함수)는 행이 없던 것처럼 실패 0·첫 실패 시각 없음이다(리뷰 N1).
 */
export type UptimeHealthWrite = {
  kind: "counted" | "held" | "unknown";
  slug: string; checkedAt: Date; status: number; latencyMs: number | null; failures: number; downSince: Date | null; alive: boolean; day: string;
};
/** uptime_observations 행(observationId = claim token). 해시·revision 은 저장소가 붙인다 */
export type UptimeSplitRaw = { observation: UptimeObservation; disposition: Exclude<UptimeDisposition, "stale">; reason: UptimeSplitReason };
export type UptimeSplitDecision = {
  productId: number; host: UptimeHost | null; outcome: UptimeSplitOutcome; reason: UptimeSplitReason;
  /** null 이면(lost) 그 행은 다른 claim 회차의 것이라 건드리지 않는다 */
  claim: UptimeClaimUpdate | null; health: UptimeHealthWrite | null; raw: UptimeSplitRaw | null;
  /** home 이 직접 연 살아 있는 결과만 텍스트 표본을 갱신한다(Oracle 본문은 지역별로 달라질 수 있다) */
  textSample: boolean;
};
export type UptimeWindowIncrement = UptimeHostCounts & { host: UptimeHost; bucket: Date };
export type UptimeSplitBatch = { decisions: UptimeSplitDecision[]; windows: UptimeWindowIncrement[]; breakers: UptimeHostBreaker[] };

const isAlive = (result: UptimeSplitResult) => result.kind === "http" && result.status >= 200 && result.status < 400;
/** 봇·로그인 차단 응답 — legacy recordPing 과 같은 목록(UPTIME_UNKNOWN_STATUSES). 999 는 home 결과에만 그대로 온다(제출 칸은 unknown/0) */
const isUnknown = (result: UptimeSplitResult) => result.kind === "http" && isUnknownUptimeStatus(result.status);

function assertInput(input: UptimeSplitInput) {
  const { claim, result } = input;
  const statusOk = result.kind === "http" ? Number.isInteger(result.status) && result.status >= 100 && result.status <= UPTIME_HTTP_STATUS_MAX : result.status === 0;
  if (!Number.isSafeInteger(claim.productId) || claim.productId < 1 || !statusOk
    || !["http", "timeout", "dns", "network", "unknown"].includes(result.kind)
    || (result.latencyMs !== null && !(Number.isFinite(result.latencyMs) && result.latencyMs >= 0))
    || !finite(result.startedAt) || !finite(result.observedAt) || !finite(claim.dueAt)
    || (input.product !== null && input.product.id !== claim.productId)) throw new TypeError("uptime_split_input_invalid");
}

function healthWrite(input: UptimeSplitInput, product: UptimeProductSnapshot, alive: boolean): UptimeHealthWrite {
  const { health, result } = input;
  const latencyMs = alive && result.latencyMs !== null ? Math.max(0, Math.min(2_147_483_647, Math.round(result.latencyMs))) : null;
  const reset = splitResetStreak(health, product.updatedAt);
  return { kind: "counted", slug: product.slug, checkedAt: result.observedAt, status: result.status, latencyMs, alive, day: uptimeHealthDay(result.observedAt),
    failures: alive ? 0 : !health || reset ? 1 : health.failures + 1,
    downSince: alive ? null : !health || reset ? result.observedAt : health.downSince ?? result.observedAt };
}

/** 알 수 없는 응답(writeHealthUnknown 과 같다). 연속 실패를 다시 셀 때는 healthWrite 처럼 행이 없던 것과 같은 값(실패 0·첫 실패 시각 없음)이다 */
function unknownWrite(input: UptimeSplitInput, product: UptimeProductSnapshot): UptimeHealthWrite {
  const { health, result } = input;
  const kept = health && !splitResetStreak(health, product.updatedAt) ? health : null;
  return { kind: "unknown", slug: product.slug, checkedAt: result.observedAt, status: result.status, latencyMs: null, alive: false,
    day: uptimeHealthDay(result.observedAt), failures: kept?.failures ?? 0, downSince: kept?.downSince ?? null };
}

/** 판정 보류(writeHealthHeld 와 같다). 연속 실패가 자동 내림 기준 이상인 행은 확인 시각도 넘기지 않으므로 null 이다 */
function heldWrite(input: UptimeSplitInput, product: UptimeProductSnapshot): UptimeHealthWrite | null {
  const { health, result } = input;
  if (health && health.failures >= UPTIME_AUTO_BAN_THRESHOLD) return null;
  return { kind: "held", slug: product.slug, checkedAt: result.observedAt, status: result.status, latencyMs: null, alive: false,
    day: uptimeHealthDay(result.observedAt), failures: health?.failures ?? 0, downSince: health?.downSince ?? null };
}

/**
 * 묶음 적용 판정(design-uptime §3.2 표). 입력 순서대로 결정을 돌려준다. 같은 제품이 두 번 오면 거부한다(제품당 claim 1행).
 * 1 control epoch·mode·PR09·policy 출처·probe 가 아닌 제출 행 → 버림 / 2 제품 변경 → stale / 3 시계 → stale(15분 미룸) / 4 더 새 health → stale /
 * 5 6시간 안 → 보류 / 6 성공 → 반영 / 7 probe 실패·차단기 열림 → 풀로 / 8 probe 실패 → home 재확인 / 9a home 알 수 없는 응답 → 확인 시각·응답 코드만 /
 * 9 home 실패·광역 → 판정 보류 / 10 home 실패 → 반영. probe 의 알 수 없는 응답(401·403·429, 999 는 unknown/0)은 7·8 의 실패와 같다.
 */
export function decideSplitResults(inputs: readonly UptimeSplitInput[], context: UptimeSplitContext): UptimeSplitBatch {
  const { control, wall } = context;
  if (!finite(wall)) throw new TypeError("uptime_split_input_invalid");
  const policy = control.policy;
  const decisions: UptimeSplitDecision[] = [];
  const candidates: { index: number; input: UptimeSplitInput; entry: UptimeSplitHost; product: UptimeProductSnapshot }[] = [];
  const seen = new Set<number>();
  const keep = (claim: UptimeClaimSnapshot, token: string, epoch: number, reason: UptimeSplitReason, change: Partial<UptimeClaimUpdate> = {}): UptimeClaimUpdate => ({
    token, epoch, dueAt: claim.dueAt, confirmClass: claim.confirmClass, confirmReason: claim.confirmReason,
    confirmRequestedAt: claim.confirmRequestedAt, affinityHomeUntil: claim.affinityHomeUntil, conflictCount: claim.conflictCount,
    lastOutcome: reason, lastApplied: null, ...change });
  const settle = (input: UptimeSplitInput, outcome: UptimeSplitOutcome, reason: UptimeSplitReason, change: Partial<UptimeClaimUpdate> = {}): UptimeSplitDecision => ({
    productId: input.claim.productId, host: input.claim.host, outcome, reason, health: null, raw: null, textSample: false,
    claim: keep(input.claim, input.result.token, input.result.epoch, reason, change) });

  inputs.forEach((input, index) => {
    assertInput(input);
    const { claim, result, product, health } = input;
    if (seen.has(claim.productId)) throw new TypeError("uptime_split_duplicate_product");
    seen.add(claim.productId);
    if (claim.state === "idle" || claim.token !== result.token || claim.epoch !== result.epoch) {
      decisions[index] = { productId: claim.productId, host: claim.host, outcome: "lost", reason: "claim_lost", claim: null, health: null, raw: null, textSample: false };
      return;
    }
    const entry = policy && claim.ownerInstanceId ? uptimeSplitHostEntry(policy, claim.ownerInstanceId) : null;
    const discard = control.mode !== "claims" ? "mode_legacy"
      : context.uptimeControl.observationsEnabled || context.uptimeControl.gateEnabled ? "uptime_control_enabled"
        : claim.controlEpoch !== control.epoch ? "control_epoch"
          : !entry || entry.host !== claim.host || entry.class !== claim.hostClass ? "source_unconfigured"
            // home 실패로 셀 수 있는 것은 home 잡이 직접 연 결과(own)뿐이다. 제출 행은 probe(Oracle)만 낸다 — home host·class 로 적힌 제출 행은
            // 제출 권한(uptime_claims 열 UPDATE)만 가진 주체가 쓴 것이라 판정하지 않는다(review F3: 위조한 home 실패가 숨김·내림까지 갔다)
            : input.submitted && entry.class !== "probe" ? "submitted_not_probe" : null;
    if (discard || !entry) { decisions[index] = settle(input, "discarded", discard ?? "source_unconfigured"); return; }
    if (!product) { decisions[index] = settle(input, "stale", "product_missing"); return; }
    if (!LISTED.has(product.status) || product.accessMode !== "website") { decisions[index] = settle(input, "stale", "product_unlisted"); return; }
    if (product.url !== claim.claimUrl) { decisions[index] = settle(input, "stale", "url_changed", { dueAt: wall }); return; }
    if (product.slug !== claim.claimSlug || dbTimestampMicros(product.updatedAt) > micros(result.startedAt)) {
      decisions[index] = settle(input, "stale", "product_changed"); return;
    }
    if (!uptimeSplitClockValid({ claimedAt: claim.claimedAt, startedAt: result.startedAt, observedAt: result.observedAt, wall })) {
      // 시계가 틀린 host 의 결과다 — 바로 다시 due 로 두면 다음 틱·묶음이 같은 사이트를 또 연다(review F5). 보류처럼 15분 미룬다
      decisions[index] = settle(input, "stale", "clock", { dueAt: new Date(wall.getTime() + UPTIME_SPLIT_HOLD_MS) }); return;
    }
    if (health && health.checkedAt.getTime() >= result.observedAt.getTime()) {
      decisions[index] = settle(input, "stale", "older_observation", { dueAt: new Date(health.checkedAt.getTime() + UPTIME_RECHECK_MS) }); return;
    }
    if (health && result.observedAt.getTime() - health.checkedAt.getTime() < UPTIME_RECHECK_MS) {
      decisions[index] = settle(input, "held", "minimum_interval", { dueAt: new Date(health.checkedAt.getTime() + UPTIME_RECHECK_MS) }); return;
    }
    candidates.push({ index, input, entry, product });
  });

  if (!policy) return { decisions, windows: [], breakers: [] };

  // 차단기: 시간 전이 → 이번 묶음으로 열릴지 → 실패를 셀 수 있는지
  const counts = (rows: typeof candidates): UptimeHostCounts => rows.reduce((sum, { input }) => ({ checks: sum.checks + 1,
    failures: sum.failures + (isAlive(input.result) ? 0 : 1), transport: sum.transport + (input.result.kind === "http" ? 0 : 1) }), ZERO);
  const hosts = new Set<UptimeHost>([...context.breakers.map(row => row.host), ...candidates.map(row => row.entry.host)]);
  const countable = new Map<UptimeHost, boolean>(), breakers: UptimeHostBreaker[] = [], windows: UptimeWindowIncrement[] = [];
  for (const host of hosts) {
    const current = advanceUptimeBreaker(context.breakers.find(row => row.host === host) ?? closedUptimeBreaker(host, policy), wall);
    const rows = candidates.filter(row => row.entry.host === host), batch = counts(rows), window = context.windows[host] ?? ZERO;
    const probeAfter = current.probeAfter?.getTime() ?? Number.POSITIVE_INFINITY;
    const probe = current.state === "probing" ? counts(rows.filter(row => (row.input.claim.claimedAt?.getTime() ?? 0) >= probeAfter)) : ZERO;
    countable.set(host, current.state === "closed" && !uptimeBreakerTrip(policy, window, batch));
    breakers.push(settleUptimeBreaker(current, policy, { window, batch, probe }, wall));
    if (batch.checks > 0) windows.push({ host, bucket: uptimeWindowBucket(wall), ...batch });
  }

  for (const { index, input, entry, product } of candidates) {
    const { claim, result } = input;
    const alive = isAlive(result), unknown = !alive && isUnknown(result), home = entry.class === "home", confirmed = home && claim.confirmClass === "home";
    // raw 표는 HTTP 100..599 만 담는다 — 비표준 상태는 raw 에만 unknown/0 으로 남기고 정식 기록(health)에는 그대로 쓴다(UPTIME_HTTP_STATUS_MAX)
    const standard = result.kind !== "http" || uptimeStandardHttpStatus(result.status);
    const observation: UptimeObservation = { observationId: result.token, productId: claim.productId, slug: product.slug, url: product.url,
      slot: uptimeSlot(result.startedAt), startedAt: result.startedAt, observedAt: result.observedAt,
      source: { host: entry.host, instanceId: entry.instanceId, region: entry.region },
      kind: standard ? result.kind : "unknown", status: standard ? result.status : 0, latencyMs: standard ? result.latencyMs : null };
    const next = new Date(result.observedAt.getTime() + UPTIME_RECHECK_MS);
    const cleared = { confirmClass: null, confirmReason: null, confirmRequestedAt: null } as const;
    if (alive) {
      const reason = confirmed ? "split_confirm_success" : "split_success";
      decisions[index] = { ...settle(input, "applied", reason, { dueAt: next, ...cleared, lastApplied: { at: wall, host: entry.host },
        ...(confirmed ? { conflictCount: claim.conflictCount + 1, affinityHomeUntil: new Date(wall.getTime() + policy.confirm.affinityDays * DAY_MS) } : {}) }),
        health: healthWrite(input, product, true), textSample: home,
        raw: confirmed ? { observation, disposition: "applied", reason } : null };
    } else if (!home) {
      // probe 실패는 세지 않는다. 알 수 없는 응답(Oracle 주소가 막혔을 수 있다)도 같다 — home 이 다시 보고, 열리면 지역 충돌로 남는다
      decisions[index] = countable.get(entry.host)
        ? { ...settle(input, "confirm_requested", "split_confirm_required", { dueAt: wall, confirmClass: "home",
          confirmReason: `${result.kind}:${result.status}`, confirmRequestedAt: wall }),
          raw: { observation, disposition: "raw_only", reason: "split_confirm_required" } }
        : settle(input, "returned", "probe_breaker_open");
    } else if (unknown) {
      // home 이 본 봇·로그인 차단 응답 — legacy(recordPing → writeHealthUnknown)와 같다. 세지도 끊지도 않고 확인 시각·응답 코드만 남긴다
      // (관리자 해제·제품 수정 뒤라 연속 실패를 다시 셀 때는 새로 시작한다).
      // legacy 는 광역 보류 틱에도 바로 쓰므로 차단기와 무관하다(차단기 재료에서는 위 counts 가 실패 쪽에 센다 — legacy 비율과 같다).
      // 재확인 요청도 이 확인으로 끝난다(지역 충돌은 성공일 때만 센다)
      decisions[index] = { ...settle(input, "applied", "split_unknown", { dueAt: next, ...cleared, lastApplied: { at: wall, host: entry.host } }),
        health: unknownWrite(input, product), raw: { observation, disposition: "applied", reason: "split_unknown" } };
    } else if (!countable.get(entry.host)) {
      // 판정 보류 — legacy 광역 보류(uptime.ts, writeHealthHeld)와 같은 의미다. 확인은 했으므로 확인 시각만 넘겨 다른 제품처럼 6시간 뒤
      // 차례에 둔다(시각을 그대로 두면 legacy 의 래칫처럼 같은 사이트를 거듭 연다). 재확인 요청도 이 확인으로 끝난다 — 6시간 안의 다음 확인은
      // minimum_interval 로 버려질 뿐이다. 연속 실패가 자동 내림 기준 이상이면 그 행의 확인 시각은 내림 최신성·관리자 해제 비교의 기준이라
      // 넘기지 않고(writeHealthHeld 와 같다) 지금처럼 15분 뒤 다시 본다
      const held = heldWrite(input, product);
      decisions[index] = { ...settle(input, "held", "split_broad_failure", held ? { dueAt: next, ...cleared }
        : { dueAt: new Date(wall.getTime() + UPTIME_SPLIT_HOLD_MS) }),
        health: held, raw: { observation, disposition: "observation_hold", reason: "split_broad_failure" } };
    } else {
      const reason = confirmed ? "split_confirmed" : "split_counted";
      decisions[index] = { ...settle(input, "applied", reason, { dueAt: next, ...cleared, lastApplied: { at: wall, host: entry.host } }),
        health: healthWrite(input, product, false), raw: { observation, disposition: "applied", reason } };
    }
  }
  return { decisions, windows, breakers };
}
