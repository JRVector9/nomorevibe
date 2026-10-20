import { describe, expect, it } from "vitest";
import {
  consumerServiceGroups,
  isConsumerServiceInstance,
  latestServiceInstance,
  parseServiceObservationKey,
  roleServiceInstances,
  serviceObservationKey,
  serviceInstanceId,
  serviceInstancesFromObservations,
  staleServiceInstanceCount,
  supersededServiceInstanceKeys,
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

  /**
   * 인스턴스 키로 바뀐 뒤 예전 키("connect-agent")만 찾던 운영센터는 연결된 계정을 못 봐서
   * "AI 계정이 연결돼 있지 않습니다"를 띄웠다(2026-09-11 실측: 실제로는 configReady=true).
   */
  it("finds a role's latest observation under instance keys and the legacy key alike", () => {
    const scoped = serviceInstancesFromObservations([
      { key: "service:connect-agent:m3-a", value: { configReady: false }, observedAt: "2026-09-11T00:00:00.000Z" },
      { key: "service:connect-agent:m3-b", value: { configReady: true }, observedAt: "2026-09-11T00:00:05.000Z" },
      { key: "service:app:m3-web", value: { configReady: false }, observedAt: "2026-09-11T00:00:09.000Z" },
    ]);
    expect(latestServiceInstance(scoped, "connect-agent")?.value).toEqual({ configReady: true });

    const legacy = serviceInstancesFromObservations([
      { key: "connect-agent", value: { configReady: true }, observedAt: "2026-09-11T00:00:00.000Z" },
    ]);
    expect(latestServiceInstance(legacy, "connect-agent")?.value).toEqual({ configReady: true });
    expect(latestServiceInstance(legacy, "crawler")).toBeUndefined();
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

it('gives two scheduler replicas distinct observation keys when replica identity is enabled', () => {
  const env = { SERVICE_INSTANCE_ID: 'm3-scheduler', SCHEDULER_REPLICA_IDENTITY: '1' };
  expect(serviceObservationKey('scheduler', { ...env, HOSTNAME: 'task-a' }))
    .toBe('service:scheduler:m3-scheduler-task-a');
  expect(serviceObservationKey('scheduler', { ...env, HOSTNAME: 'task-b' }))
    .toBe('service:scheduler:m3-scheduler-task-b');
  expect(serviceObservationKey('crawler', { ...env, HOSTNAME: 'task-a' }))
    .toBe('service:crawler:m3-scheduler');
  expect(() => serviceObservationKey('scheduler', env)).toThrow('HOSTNAME');
});

// 설계 R5: AI1·AI2 consumer 도 감독 관측을 service:reviewer:<stage>-consumer-* 로 남긴다. 역할 lease 가 없으므로 역할 생존의 근거가 아니다.
it('keeps AI1/AI2 consumer observations out of the reviewer role liveness and slots', () => {
  expect(['ai1-consumer-m3', 'ai2-consumer-mini'].map(isConsumerServiceInstance)).toEqual([true, true]);
  expect(['reviewer-m3', 'ai3-consumer-m3', 'consumer-ai1', undefined].map(isConsumerServiceInstance)).toEqual([false, false, false, false]);
  const rows = serviceInstancesFromObservations([
    { key: 'service:reviewer:reviewer-m3', value: { status: 'running', bootedAt: 1, release: 'a' }, observedAt: '2026-10-19T00:00:00Z' },
    { key: 'service:reviewer:ai1-consumer-m3', value: { status: 'running', bootedAt: 2, release: 'b' }, observedAt: '2026-10-19T00:09:50Z' },
    { key: 'service:reviewer:ai2-consumer-m3', value: { status: 'running', bootedAt: 3, release: 'b' }, observedAt: '2026-10-19T00:09:55Z' },
  ]);
  // 역할 워커가 10분째 조용하면 그대로 보인다 — 더 최근의 consumer 관측이 가리지 않는다
  expect(latestServiceInstance(rows, 'reviewer')?.instanceId).toBe('reviewer-m3');
  expect(supersededServiceInstanceKeys(rows, Date.parse('2026-10-19T00:10:00Z'))).toEqual(new Set());
  expect(latestServiceInstance(rows.filter(row => row.instanceId !== 'reviewer-m3'), 'reviewer')).toBeUndefined();
});

// 리뷰 P3(agent-scan 9·uptime F8): 운영센터 역할 표·카드에 consumer 가 역할 인스턴스로 섞이면 consumer 를 멈출 때 '일부 관측 지연'(오탐),
// 역할 워커가 죽고 consumer 만 살면 '관측 지연' 대신 '일부 관측 지연'(약화)이 된다. 역할 칸은 consumer 를 빼고, consumer 는 따로 센다.
it('keeps every consumer (agent-scan, uptime, ai1, ai2) out of role cards and lists them on their own', () => {
  const at = (seconds: number) => new Date(Date.parse('2026-10-19T01:00:00Z') - seconds * 1_000).toISOString();
  const rows = serviceInstancesFromObservations([
    { key: 'service:crawler:m3-crawler', value: { status: 'running' }, observedAt: at(400) },
    { key: 'service:crawler:agent-scan-consumer-m3', value: { status: 'running' }, observedAt: at(5) },
    { key: 'service:crawler:agent-scan-consumer-oracle', value: { status: 'stopped' }, observedAt: at(1_200) },
    { key: 'service:maintenance:m3-maintenance', value: { status: 'running' }, observedAt: at(5) },
    { key: 'service:maintenance:uptime-consumer-oracle', value: { status: 'running' }, observedAt: at(600) },
    { key: 'service:reviewer:ai1-consumer-m3', value: { status: 'running' }, observedAt: at(7_200) },
  ]);
  const now = Date.parse('2026-10-19T01:00:00Z');
  // crawler 역할 워커가 죽었다(400초) — consumer 가 살아 있어도 역할 칸은 그 한 대만 보고 '관측 지연'이 된다
  expect(roleServiceInstances(rows, 'crawler').map(row => row.instanceId)).toEqual(['m3-crawler']);
  expect(staleServiceInstanceCount(roleServiceInstances(rows, 'crawler'), now)).toBe(1);
  // uptime consumer 를 멈춰도 maintenance 칸은 정상 그대로다
  expect(roleServiceInstances(rows, 'maintenance').map(row => row.instanceId)).toEqual(['m3-maintenance']);
  expect(consumerServiceGroups(rows, now)).toEqual([
    { consumer: 'agent-scan', role: 'crawler', live: 2, fresh: 1, latestAt: at(5) },
    { consumer: 'uptime', role: 'maintenance', live: 1, fresh: 0, latestAt: at(600) },
  ]);
});
