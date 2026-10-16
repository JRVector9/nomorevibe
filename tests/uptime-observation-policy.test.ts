import { describe, expect, it } from "vitest";
import { assessUptimeObservation, UptimeObservationSchema, UptimeSourcesSchema, uptimeSlot, type UptimeObservation } from "@/lib/domain/products/uptime-policy";

const at = new Date("2026-10-16T02:00:00.123Z");
const source = { host: "oracle-osaka-smoke" as const, instanceId: "oracle-test", region: "ap-osaka-1" };
const observation = (): UptimeObservation => ({ observationId: "00000000-0000-4000-8000-000000000001", productId: 1,
  slug: "one", url: "https://one.example/", slot: uptimeSlot(at), startedAt: at, observedAt: at,
  source, kind: "http", status: 403, latencyMs: null });
const facts = (host = source.host as string, region = source.region as string) => [0, 1].map(index => ({
  productId: 10 + index, url: `https://healthy${index}.example/`, host, region, kind: "http" as const,
  status: 200, observedAt: new Date(at.getTime() - 1000),
}));

describe("versioned conservative uptime policy", () => {
  it("raw source/time/outcome contract is strict and input is unchanged", () => {
    const value = observation(), before = structuredClone(value);
    expect(UptimeObservationSchema.parse(value)).toEqual(value);
    expect(value).toEqual(before);
    expect(UptimeObservationSchema.safeParse({ ...value, networkHealthy: true }).success).toBe(false);
    expect(UptimeObservationSchema.safeParse({ ...value, productId: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(UptimeObservationSchema.safeParse({ ...value, kind: "timeout", status: 403 }).success).toBe(false);
  });
  it.each([new Date("invalid"), new Date("2026-10-16T01:59:59Z")])("rejects invalid slot %s", slot => {
    expect(UptimeObservationSchema.safeParse({ ...observation(), slot }).success).toBe(false);
  });
  it("preserves UTC6h boundaries and rejects reversed timestamps", () => {
    expect(uptimeSlot(new Date("2026-10-16T05:59:59.999Z"))).toEqual(new Date("2026-10-16T00:00:00Z"));
    expect(uptimeSlot(new Date("2026-10-16T06:00:00Z"))).toEqual(new Date("2026-10-16T06:00:00Z"));
    expect(UptimeObservationSchema.safeParse({ ...observation(), observedAt: new Date(at.getTime() - 1) }).success).toBe(false);
  });
  it("requires configured physical source identity and exact Osaka region", () => {
    expect(UptimeSourcesSchema.safeParse([source, source]).success).toBe(false);
    expect(UptimeSourcesSchema.safeParse([{ ...source, region: "other" }]).success).toBe(false);
    expect(UptimeSourcesSchema.safeParse([{ ...source, host: "oracle" }]).success).toBe(false);
  });
  it.each([403, 404, 500])("Oracle-only HTTP%s holds even with healthy network probes", status => {
    expect(assessUptimeObservation({ ...observation(), status }, facts())).toBe("independent_evidence_missing");
  });
  it.each(["timeout", "dns", "network", "unknown"] as const)("single-host %s stays uncertain", kind => {
    expect(assessUptimeObservation({ ...observation(), kind, status: 0 }, facts())).toBe("independent_evidence_missing");
  });
  it("does not infer healthy network from absence or same-origin duplicates", () => {
    expect(assessUptimeObservation(observation(), [])).toBe("network_evidence_missing");
    const same = facts().map(row => ({ ...row, url: "https://same.example/a" }));
    expect(assessUptimeObservation(observation(), same)).toBe("network_evidence_missing");
  });
  it("holds on broad failure even if previous successes exist", () => {
    const failures = [0, 1, 2].map(index => ({ ...facts()[0], productId: 20 + index,
      url: `https://failed${index}.example/`, kind: "unknown" as const, status: 0 }));
    expect(assessUptimeObservation(observation(), [...facts(), ...failures])).toBe("broad_network_failure");
  });
  it("requires independent region, same URL/product/outcome and each host's network evidence", () => {
    const peer = { productId: 1, url: observation().url, host: "m3", region: "primary-region", kind: "http" as const,
      status: 403, observedAt: new Date(at.getTime() - 1) };
    const evidence = [...facts(), ...facts("m3", "primary-region"), peer];
    expect(assessUptimeObservation(observation(), evidence)).toBeNull();
    for (const bad of [{ region: source.region }, { productId: 2 }, { url: "https://other.example/" }, { status: 200 },
      { observedAt: new Date(at.getTime() + 1) }, { observedAt: new Date(at.getTime() - 31 * 60000) }]) {
      expect(assessUptimeObservation(observation(), [...evidence.slice(0, -1), { ...peer, ...bad }])).not.toBeNull();
    }
  });
  it("same-time conflicting origin evidence stays uncertain independent of SQL row order", () => {
    const positive = facts("m3", "primary-region");
    const negative = { ...positive[0], status: 500 };
    const current = { ...observation(), source: { host: "m3" as const, instanceId: "m3", region: "primary-region" }, status: 404 };
    for (const evidence of [[...positive, negative], [negative, ...positive]]) {
      expect(assessUptimeObservation(current, evidence)).toBe("network_evidence_missing");
    }
  });
  it("positive HTTP is independent of negative network inference", () => {
    expect(assessUptimeObservation({ ...observation(), status: 200 }, [])).toBeNull();
  });
});
