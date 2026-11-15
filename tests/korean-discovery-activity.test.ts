import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ sql: [] as string[], params: [] as unknown[][], options: [] as unknown[], rows: [] as unknown[] }));
vi.mock("@/lib/db/pool", () => ({ withDbDeadline: (_deadline: number, load: () => Promise<unknown>) => load() }));
vi.mock("@/lib/db", () => ({
  onPrimary: (load: () => Promise<unknown>) => load(),
  db: { transaction: async (work: (tx: unknown) => Promise<unknown>, options: unknown) => {
    io.options.push(options);
    return work({ execute: async (query: { queryChunks: ({ value?: string[] } | unknown)[] }) => {
      const chunks = query.queryChunks;
      io.sql.push(chunks.flatMap(chunk => (chunk as { value?: string[] }).value ?? []).join("?"));
      io.params.push(chunks.filter(chunk => !(chunk && typeof chunk === "object" && "value" in chunk)));
      return io.sql.at(-1)!.includes("SET LOCAL") ? [] : io.rows;
    } });
  } },
}));

const { buildKoreanDiscoveryActivity, loadKoreanDiscoveryActivity } = await import("@/lib/operations/korean-discovery-activity");
const row = { at: "2026-11-15T10:45:00.000Z", enabled: true, collectionEnabled: true, workAt: "2026-11-15T03:10:39.000Z",
  heartbeatAt: "2026-11-15T03:13:55.000Z", pending: 49_534 };

beforeEach(() => { io.sql.length = 0; io.params.length = 0; io.options.length = 0; io.rows = [row]; });

describe("Korean discovery activity (2026-11-15 stall input)", () => {
  it("reads the Oracle consumer's last discovery progress, heartbeat and pending count in one bounded read-only transaction", async () => {
    expect(await loadKoreanDiscoveryActivity()).toEqual({ ...row, pendingTruncated: false });
    expect(io.options).toEqual([{ accessMode: "read only" }]);
    expect(io.sql[0]).toContain("statement_timeout = '3s'");
    // 일 = 그 consumer 의 탐색 진행 기록(검색 페이지·언어 확인). 켜짐 스위치·heartbeat 은 일이 아니다
    expect(io.sql[1]).toContain("WHERE key LIKE ? AND value->>'worker' LIKE 'github-ko-discovery-consumer-%'");
    expect(io.params[1]).toContain("discovery-progress:korean:%");
    expect(io.sql[1]).toContain("key LIKE 'service:crawler:github-ko-discovery-consumer-%' AND value->>'status' = 'running'");
    expect(io.sql[1]).toContain("FROM github_ko_discovery_control WHERE id = 1), false) AS enabled");
    expect(io.params[1]).toContain(50_001);
  });

  it("caps pending, keeps missing timestamps null and refuses a malformed row (unknown, never zero or off)", async () => {
    expect(buildKoreanDiscoveryActivity({ ...row, pending: 50_001, workAt: null, heartbeatAt: "x" }))
      .toMatchObject({ pending: 50_000, pendingTruncated: true, workAt: null, heartbeatAt: null });
    for (const bad of [{ at: null }, { enabled: "true" }, { collectionEnabled: null }, { pending: -1 }, { pending: "many" }])
      expect(() => buildKoreanDiscoveryActivity({ ...row, ...bad })).toThrow("invalid_korean_discovery_activity");
    io.rows = [];
    await expect(loadKoreanDiscoveryActivity()).rejects.toThrow("korean_discovery_activity_missing");
  });
});
