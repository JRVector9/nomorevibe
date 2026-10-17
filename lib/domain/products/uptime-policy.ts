import { z } from "zod";

export const UPTIME_SLOT_MS = 6 * 60 * 60 * 1000;
export const UPTIME_POLICY_VERSION = "regional-v1";
export const UPTIME_EVIDENCE_MS = 30 * 60 * 1000;
export const UptimeHostSchema = z.enum(["m3", "mini", "oracle-osaka-smoke"]);
const identity = z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const UptimeSourceSchema = z.strictObject({
  host: UptimeHostSchema, instanceId: identity, region: identity,
}).refine(source => source.host !== "oracle-osaka-smoke" || source.region === "ap-osaka-1");
export const UptimeSourcesSchema = z.array(UptimeSourceSchema).max(3).superRefine((sources, ctx) => {
  if (new Set(sources.map(source => source.host)).size !== sources.length
    || new Set(sources.map(source => source.instanceId)).size !== sources.length) {
    ctx.addIssue({ code: "custom", message: "duplicate uptime source" });
  }
});
export type UptimeSource = z.infer<typeof UptimeSourceSchema>;
export const UptimeObservationSchema = z.strictObject({
  observationId: z.uuid(), productId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  slug: z.string().min(1).max(80), url: z.url().max(2048).refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  }),
  slot: z.date(), startedAt: z.date(), observedAt: z.date(), source: UptimeSourceSchema,
  kind: z.enum(["http", "timeout", "dns", "network", "unknown"]),
  status: z.number().int().min(0).max(599), latencyMs: z.number().int().min(0).max(2_147_483_647).nullable(),
}).superRefine((value, ctx) => {
  if (value.slot.getTime() !== Math.floor(value.startedAt.getTime() / UPTIME_SLOT_MS) * UPTIME_SLOT_MS
    || value.observedAt < value.startedAt || (value.kind === "http" ? value.status < 100 : value.status !== 0)) {
    ctx.addIssue({ code: "custom", message: "invalid uptime observation" });
  }
});
export type UptimeObservation = z.infer<typeof UptimeObservationSchema>;
export type UptimeDisposition = "raw_only" | "applied" | "observation_hold" | "stale";

export function uptimeSlot(at: Date): Date {
  if (!Number.isFinite(at.getTime())) throw new Error("invalid uptime timestamp");
  return new Date(Math.floor(at.getTime() / UPTIME_SLOT_MS) * UPTIME_SLOT_MS);
}

export type UptimeEvidence = { productId: number; url: string; host: string; region: string;
  kind: UptimeObservation["kind"]; status: number; observedAt: Date };

/** 보수적인 후보 정책. 실제 raw facts만 사용하며 caller의 건강 boolean은 받지 않는다. */
export function assessUptimeObservation(observation: UptimeObservation, evidence: UptimeEvidence[]): string | null {
  const alive = observation.kind === "http" && observation.status >= 200 && observation.status < 400;
  if (alive) return null;
  const near: UptimeEvidence[] = [...evidence.filter(row => row.observedAt <= observation.observedAt
    && observation.observedAt.getTime() - row.observedAt.getTime() <= UPTIME_EVIDENCE_MS),
    { productId: observation.productId, url: observation.url, host: observation.source.host,
      region: observation.source.region, kind: observation.kind, status: observation.status, observedAt: observation.observedAt }];
  const healthy = (host: string) => {
    const latest = new Map<string, UptimeEvidence>();
    for (const row of near.filter(row => row.host === host)) {
      const origin = new URL(row.url).origin;
      const previous = latest.get(origin);
      const negative = row.kind !== "http" || row.status < 200 || row.status >= 400;
      // A timestamp tie cannot choose a healthy fact using database row order.
      if (!previous || previous.observedAt < row.observedAt
        || (previous.observedAt.getTime() === row.observedAt.getTime() && negative)) latest.set(origin, row);
    }
    const rows = [...latest.values()];
    const successes = rows.filter(row => row.kind === "http" && row.status >= 200 && row.status < 400).length;
    return { successes, failures: rows.length - successes };
  };
  const network = healthy(observation.source.host);
  if (network.failures >= 3) return "broad_network_failure";
  if (network.successes < 2) return "network_evidence_missing";
  // 다른 지역이 같은 주소를 열었다면 이 실패는 지역 문제일 수 있다. 같은 결과의 peer가 있어도 충돌은 hold다.
  if (near.some(row => row.productId === observation.productId && row.url === observation.url
    && row.host !== observation.source.host && row.region !== observation.source.region
    && row.kind === "http" && row.status >= 200 && row.status < 400)) return "regional_conflict";
  if (observation.source.host === "oracle-osaka-smoke" || observation.kind !== "http" || observation.status === 403) {
    const peer = near.find(row => row.productId === observation.productId && row.url === observation.url
      && row.host !== observation.source.host && row.region !== observation.source.region
      && row.kind === observation.kind && row.status === observation.status
      && healthy(row.host).successes >= 2 && healthy(row.host).failures < 3);
    if (!peer) return "independent_evidence_missing";
  }
  return null;
}
