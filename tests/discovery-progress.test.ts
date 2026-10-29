import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
vi.mock("@/lib/db", () => ({ db: { execute: vi.fn() } }));
import { db } from "@/lib/db";
import { discoveryProgressKey, discoveryProgressUpsert, discoveryProgressValue, recordDiscoveryProgress } from "@/lib/crawl/discovery-progress";
import { buildDiscoveryProgress } from "@/lib/operations/discovery-progress";

const at = "2026-10-28T03:30:30.000Z";
const value = { v: 1, worker: "m3-crawler", lane: "full", signal: "Claude 커밋 트레일러", at,
  lastProgressAt: "2026-10-28T03:29:00Z", pendingSince: "2026-10-28T02:00:00Z",
  window: { from: "2026-10-25T00:00:00Z", to: "2026-10-26T00:00:00Z" }, page: 2,
  completedThrough: "2026-10-24T00:00:00Z", blockedBy: "api_wait", counts: {
    "2026-10-28T03:30|searchRequests": 3, "2026-10-28T03:29|discovered": 12,
    "2026-10-28T02:30|existing": 9, "2026-10-28T02:29|discovered": 999,
    "2026-10-28T03:32|discovered": 888, "2026-10-28T03:30|topSecret": 777,
    "2026-10-28T03:30|koreanNo": -1,
  }, secret: "ghp-not-for-browser" };
const wrap = (v: unknown) => [{ key: "discovery-progress:a", value: v }];

describe("discovery progress projection", () => {
  it("sums bounded recent minute buckets and retains actual completion/lag separately from current page", () => {
    const [row] = buildDiscoveryProgress(at, wrap(value)).rows;
    expect(row).toMatchObject({ worker: "m3-crawler", lane: "full", page: 2, blockedBy: "api_wait",
      completedThrough: "2026-10-24T00:00:00.000Z", hour: { searchRequests: 3, discovered: 12, existing: 9, koreanNo: 0 } });
    expect(row.lagMinutes).toBe(5_970);
    expect(JSON.stringify(row)).not.toMatch(/topSecret|ghp-/);
  });
  it("does not imply completed coverage for unfinished pages or unreadable observations", () => {
    const report = buildDiscoveryProgress(at, wrap({ ...value, completedThrough: null }));
    expect(report.rows[0]).toMatchObject({ completedThrough: null, lagMinutes: null });
    expect(buildDiscoveryProgress(at, null).rows).toEqual([]);
    expect(buildDiscoveryProgress(at, wrap({ ...value, v: 9 })).rows).toEqual([]);
  });
  it("does not render unknown error contents, malformed labels, page numbers, or arbitrary nested content", () => {
    expect(buildDiscoveryProgress(at, wrap({ ...value, worker: "Bearer token!" })).rows).toEqual([]);
    const [row] = buildDiscoveryProgress(at, wrap({ ...value, page: 100, blockedBy: "secret-reason" })).rows;
    expect(row).toMatchObject({ page: null, blockedBy: null });
  });
});

describe("discovery progress writes", () => {
  it("keeps observation keys inside the 80-character schema limit and separates worker/lane/signal", () => {
    const input = { worker: "github-ko-discovery-consumer-0123456789", lane: "korean" as const, signal: "한국어 README", counts: {} };
    const key = discoveryProgressKey(input);
    expect(key).toMatch(/^discovery-progress:korean:[a-f0-9]{16}:[a-f0-9]{24}$/);
    expect(key.length).toBeLessThanOrEqual(80);
    expect(discoveryProgressKey({ ...input, lane: "latest" })).not.toBe(key);
    expect(discoveryProgressKey({ ...input, worker: "other" })).not.toBe(key);
  });
  it("admits only known counters and fully completed range markers", () => {
    const v = discoveryProgressValue({ worker: "m3-crawler", lane: "latest", signal: "Claude 커밋 트레일러",
      window: { from: "2026-10-25", to: "2026-10-26" }, completedThrough: "2026-10-27", counts: { discovered: 3, searchRequests: -1, existing: NaN } });
    expect(v).toMatchObject({ counts: { discovered: 3 }, completedThrough: null });
    expect(v.counts).not.toHaveProperty("searchRequests");
  });
  it("uses a single conflict update with bucket retention rather than a read-then-write counter", () => {
    const { sql, params } = new PgDialect().sqlToQuery(discoveryProgressUpsert({ worker: "oracle-ko", lane: "korean", signal: "ko", counts: { koreanYes: 1 } }));
    expect(sql).toContain("ON CONFLICT (key) DO UPDATE");
    expect(sql).toContain("interval '60 minutes'");
    expect(params.some(p => typeof p === "string" && p.startsWith("discovery-progress:"))).toBe(true);
  });
  it("does not fail discovery when the metrics write is unavailable", async () => {
    vi.mocked(db.execute).mockRejectedValueOnce(new Error("db down"));
    await expect(recordDiscoveryProgress({ worker: "oracle-ko", lane: "korean", signal: "ko", counts: { koreanUnknown: 1 } })).resolves.toBeUndefined();
  });
});
