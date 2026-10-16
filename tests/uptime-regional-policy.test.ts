import { describe, expect, it } from "vitest";
import { assessUptimeObservation, uptimeSlot, type UptimeEvidence, type UptimeObservation, type UptimeSource } from "@/lib/domain/products/uptime-policy";

const at = new Date("2026-10-17T02:00:00.000Z");
const m3: UptimeSource = { host: "m3", instanceId: "m3-maintenance", region: "primary-region" };
const mini: UptimeSource = { host: "mini", instanceId: "mini-maintenance-standby", region: "primary-region" };
const oracle: UptimeSource = { host: "oracle-osaka-smoke", instanceId: "oracle-product-health", region: "ap-osaka-1" };
const url = "https://one.example/";
const observation = (source: UptimeSource, status: number): UptimeObservation => ({
  observationId: "00000000-0000-4000-8000-000000000001", productId: 1, slug: "one", url,
  slot: uptimeSlot(at), startedAt: at, observedAt: at, source, kind: "http", status, latencyMs: null,
});
const fact = (source: UptimeSource, status: number, minutesBefore: number, overrides: Partial<UptimeEvidence> = {}): UptimeEvidence => ({
  productId: 1, url, host: source.host, region: source.region, kind: "http", status,
  observedAt: new Date(at.getTime() - minutesBefore * 60_000), ...overrides,
});
const network = (source: UptimeSource) => [0, 1].map(index => fact(source, 200, 1,
  { productId: 100 + index, url: `https://healthy${index}.example/` }));

describe("regional disagreement keeps a single-region failure out of the product counter", () => {
  it("an independent-region success holds a primary-host HTTP failure", () => {
    const evidence = [...network(m3), ...network(oracle), fact(oracle, 200, 10)];
    expect(assessUptimeObservation(observation(m3, 500), evidence)).toBe("regional_conflict");
  });
  it("an independent-region success outweighs a corroborating Oracle403 peer", () => {
    const evidence = [...network(m3), ...network(mini), ...network(oracle), fact(m3, 403, 20), fact(mini, 200, 5)];
    expect(assessUptimeObservation(observation(oracle, 403), evidence)).toBe("regional_conflict");
  });
  it("only the same product URL from another region inside the evidence window disagrees", () => {
    const base = [...network(m3), ...network(oracle)];
    expect(assessUptimeObservation(observation(m3, 500), [...base, fact(oracle, 200, 10, { url: "https://other.example/" })])).toBeNull();
    expect(assessUptimeObservation(observation(m3, 500), [...base, fact(oracle, 200, 10, { productId: 2 })])).toBeNull();
    expect(assessUptimeObservation(observation(m3, 500), [...base, fact(oracle, 200, 31)])).toBeNull();
    expect(assessUptimeObservation(observation(m3, 500), [...base, fact(mini, 200, 10)])).toBeNull();
  });
});
