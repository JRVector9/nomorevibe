import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobLeaseLostError } from "@/lib/jobs/lease";
import type { JobContext } from "@/lib/jobs/runner";
import type { DbRetentionCursor } from "@/lib/operations/db-retention";

// 잡 틀(lib/jobs/db-retention.ts)만 — 부분 함수는 가짜다. 실제 DB 동작은 tests/integration/db-retention.test.ts.
const parts = vi.hoisted(() => ({
  pruneLedger: vi.fn(), pruneDiscoveryEvidence: vi.fn(), shrinkDocuments: vi.fn(), pruneScans: vi.fn(), pruneHealthDaily: vi.fn(), pruneMaintainerEmails: vi.fn(),
}));
vi.mock("@/lib/operations/db-retention", () => ({ DB_RETENTION_PARTS: ["ledger", "evidence", "documents", "scans", "health", "maintainerEmails"], ...parts }));
const { runDbRetention } = await import("@/lib/jobs/db-retention");

const done = (state: unknown = {}) => ({ counts: { n: 1 }, caughtUp: true, state });
const ctx = (cursor: DbRetentionCursor | null, logs: unknown[] = []): JobContext<DbRetentionCursor> =>
  ({ cursor, save: async () => {}, hasBudget: () => true, deadlineAt: Date.now() + 25_000, log: (event, fields) => { logs.push({ event, fields }); } });

beforeEach(() => {
  parts.pruneLedger.mockReset().mockResolvedValue({ counts: { requests: 1 }, caughtUp: true });
  parts.pruneDiscoveryEvidence.mockReset().mockResolvedValue(done({ afterId: 7 }));
  parts.shrinkDocuments.mockReset().mockResolvedValue(done({ afterId: 5_000 }));
  parts.pruneScans.mockReset().mockResolvedValue(done({ afterId: 0, passDoneAt: "2026-11-15T00:00:00.000Z" }));
  parts.pruneHealthDaily.mockReset().mockResolvedValue(done({ passDoneAt: "2026-11-15T00:00:00.000Z" }));
  parts.pruneMaintainerEmails.mockReset().mockResolvedValue({ counts: { deleted: 2, unlisted: 1 }, caughtUp: true, state: { afterKey: "", passDoneAt: "2026-11-21T00:00:00.000Z" } });
});

describe("db-retention 잡 틀", () => {
  it("여섯 부분을 차례로 돌고 각 부분의 다음 자리를 커서에 모은다", async () => {
    const logs: unknown[] = [];
    const outcome = await runDbRetention(ctx(null, logs));
    expect(outcome).toEqual({ done: true, cursor: { v: 1, lead: 1, evidence: { afterId: 7 }, documents: { afterId: 5_000 },
      scans: { afterId: 0, passDoneAt: "2026-11-15T00:00:00.000Z" }, health: { passDoneAt: "2026-11-15T00:00:00.000Z" },
      maintainerEmails: { afterKey: "", passDoneAt: "2026-11-21T00:00:00.000Z" } } });
    // 제작자 이메일 부분은 지난 커서를 받아 「공개 제품 아님」 바퀴를 이어 한다
    expect(parts.pruneMaintainerEmails).toHaveBeenCalledWith(undefined, undefined, expect.any(Function));
    expect(logs).toEqual([{ event: "db.retention", fields: expect.objectContaining({ "ledger.requests": 1, "evidence.n": 1, "health.caughtUp": true,
      "maintainerEmails.deleted": 2, "maintainerEmails.unlisted": 1, "maintainerEmails.caughtUp": true }) }]);
  });

  it("한 부분의 실패는 그 부분만 접고(제 일 못 한 틱으로 알린다) 다른 부분은 돈다 — DB 까닭만 남긴다", async () => {
    parts.shrinkDocuments.mockRejectedValue(Object.assign(new Error("Failed query: UPDATE crawl_documents …"), { cause: new Error("canceling statement due to lock timeout") }));
    const outcome = await runDbRetention(ctx({ v: 1, documents: { afterId: 10_000 } }));
    expect(outcome).toMatchObject({ done: true, degraded: { code: "retention_part_failed", detail: "documents: canceling statement due to lock timeout" } });
    expect((outcome.cursor as DbRetentionCursor).documents).toEqual({ afterId: 10_000 });
    expect(parts.pruneScans).toHaveBeenCalled();
    expect(parts.pruneHealthDaily).toHaveBeenCalled();
  });

  it("잡 소유권을 잃으면 틱 전체를 멈춘다", async () => {
    parts.pruneLedger.mockRejectedValue(new JobLeaseLostError());
    await expect(runDbRetention(ctx(null))).rejects.toBeInstanceOf(JobLeaseLostError);
    expect(parts.pruneDiscoveryEvidence).not.toHaveBeenCalled();
  });

  it("먼저 서는 부분은 틱마다 돌아간다", async () => {
    const order: string[] = [];
    for (const [name, fn] of Object.entries(parts)) fn.mockImplementation(async () => { order.push(name); return done(); });
    await runDbRetention(ctx({ v: 1, lead: 3 }));
    expect(order).toEqual(["pruneScans", "pruneHealthDaily", "pruneMaintainerEmails", "pruneLedger", "pruneDiscoveryEvidence", "shrinkDocuments"]);
  });
});
