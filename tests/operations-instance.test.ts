import { describe, expect, it } from "vitest";
import {
  parseServiceObservationKey,
  serviceObservationKey,
  serviceInstanceId,
  serviceInstancesFromObservations,
  staleServiceInstanceCount,
} from "@/lib/operations/instance";

describe("service instance observations", () => {
  it("uses an explicit instance ID to keep replicas separate", () => {
    const env = { SERVICE_INSTANCE_ID: "m3-web-1" };

    expect(serviceInstanceId(env)).toBe("m3-web-1");
    expect(serviceObservationKey("app", env)).toBe("service:app:m3-web-1");
    expect(parseServiceObservationKey("service:app:m3-web-1")).toEqual({
      role: "app",
      instanceId: "m3-web-1",
    });
  });

  it("keeps legacy singleton keys readable when no instance is configured", () => {
    expect(serviceObservationKey("crawler", {})).toBe("crawler");
    expect(parseServiceObservationKey("crawler")).toEqual({
      role: "crawler",
      instanceId: "legacy",
    });
  });

  it("rejects invalid or oversized instance IDs", () => {
    expect(() => serviceInstanceId({ SERVICE_INSTANCE_ID: "m3:web" })).toThrow("Invalid SERVICE_INSTANCE_ID");
    expect(() => serviceInstanceId({ SERVICE_INSTANCE_ID: "x".repeat(49) })).toThrow("Invalid SERVICE_INSTANCE_ID");
  });

  it("does not treat job observations as service instances", () => {
    expect(parseServiceObservationKey("job:crawl-fetch")).toBeNull();
    expect(parseServiceObservationKey("unrelated")).toBeNull();
  });

  it("projects service observations without discarding duplicate roles", () => {
    const rows = [
      { key: "service:app:m3-web", value: { release: "abc" }, observedAt: "2026-09-09T00:00:00Z" },
      { key: "service:app:mini-web", value: { release: "abc" }, observedAt: "2026-09-09T00:00:01Z" },
      { key: "job:crawl-fetch", value: {}, observedAt: "2026-09-09T00:00:02Z" },
    ];

    expect(serviceInstancesFromObservations(rows)).toEqual([
      { role: "app", instanceId: "m3-web", key: "service:app:m3-web", value: { release: "abc" }, observedAt: "2026-09-09T00:00:00Z" },
      { role: "app", instanceId: "mini-web", key: "service:app:mini-web", value: { release: "abc" }, observedAt: "2026-09-09T00:00:01Z" },
    ]);
  });

  it("drops a legacy singleton row after that role reports scoped instances", () => {
    const rows = [
      { key: "crawler", value: { release: "old" }, observedAt: "2026-09-08T00:00:00Z" },
      { key: "service:crawler:m3-crawler", value: { release: "new" }, observedAt: "2026-09-09T00:00:00Z" },
    ];

    expect(serviceInstancesFromObservations(rows).map((row) => row.instanceId)).toEqual(["m3-crawler"]);
  });

  it('reports a degraded role when one of its replicas is stale', () => {
    const now = new Date('2026-09-09T00:01:00Z').getTime();
    const rows = [
      { observedAt: '2026-09-09T00:00:50Z' },
      { observedAt: '2026-09-08T23:59:00Z' },
    ];

    expect(staleServiceInstanceCount(rows, now)).toBe(1);
  });
});
