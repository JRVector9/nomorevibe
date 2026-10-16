import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";
import type { RoleLease } from "@/lib/jobs/role-leader";
import type { EvidenceRefreshCursor } from "@/lib/jobs/products/evidence-refresh";
import { SourceJobSchema } from "@/lib/domain/evidence/source-contract";
import { DEFAULT_EVIDENCE_SETTINGS } from "@/lib/domain/evidence/settings";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(), role: vi.fn(), mode: vi.fn(), sourceMode: vi.fn(), settings: vi.fn(),
  due: vi.fn(), queue: vi.fn(), refresh: vi.fn(), dueRequests: vi.fn(), begin: vi.fn(), progress: vi.fn(),
}));
vi.mock("@/lib/domain/evidence/source-claims", () => ({ executeCanonicalEvidenceSource: mocks.execute }));
vi.mock("@/lib/jobs/role-leader", () => ({ roleLeaseFromEnv: mocks.role }));
vi.mock("@/lib/jobs/batch-repository", () => ({
  lockJobBatch: mocks.mode,
  JobBatchBlockedError: class JobBatchBlockedError extends Error {},
}));
vi.mock("@/lib/db", () => ({ db: { transaction: (load: (tx: object) => Promise<unknown>) => load({}) }, onPrimary: (load: () => Promise<unknown>) => load() }));
vi.mock("@/lib/domain/evidence/source-control", () => ({ canonicalSourceMode: mocks.sourceMode }));
vi.mock("@/lib/domain/evidence/settings-store", () => ({ currentEvidenceSettings: mocks.settings }));
vi.mock("@/lib/domain/evidence/refresh", () => ({
  dueEvidenceProductSlugs: mocks.due, queueInitialProductEvidenceRefresh: mocks.queue, refreshProductEvidence: mocks.refresh,
}));
vi.mock("@/lib/domain/evidence/refresh-requests", () => ({
  beginProductRefresh: mocks.begin, dueProductRefreshRequests: mocks.dueRequests, saveProductRefreshProgress: mocks.progress,
}));

const { refreshSiteEvidenceJob } = await import("@/lib/jobs/products/site-evidence-refresh");
const { refreshProductEvidenceJob } = await import("@/lib/jobs/products/evidence-refresh");
const { JobBatchBlockedError } = await import("@/lib/jobs/batch-repository");
const { HttpOriginPermitError } = await import("@/lib/net/http-origin-policy");
const role: RoleLease = { role: "site-evidence", instanceId: "oracle-site", bootId: "boot-1", release: "release-1",
  kind: "primary", epoch: 3, batchVersion: 1, batchEpoch: 2, host: "oracle-osaka-smoke" };
function context<C = null>(name = "product-site-evidence-refresh"): JobContext<C> {
  return { cursor: null, lease: { name, token: "actual-job-boundary", requestedVersion: 7 },
    signal: new AbortController().signal, deadlineAt: Date.now() + 25_000,
    hasBudget: () => true, save: vi.fn(), log: vi.fn() };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.execute.mockReset().mockResolvedValue({ state: "idle", factsChanged: 0 });
  mocks.role.mockReturnValue(role);
  mocks.mode.mockResolvedValue({ mode: "legacy" });
  mocks.sourceMode.mockResolvedValue(true);
  mocks.settings.mockResolvedValue(DEFAULT_EVIDENCE_SETTINGS);
  mocks.due.mockResolvedValue([]); mocks.queue.mockResolvedValue(null); mocks.dueRequests.mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe("canonical site-only job boundary", () => {
  it("dispatches only the canonical executor with the original role/job and signal", async () => {
    const ctx = context();
    await expect(refreshSiteEvidenceJob(ctx)).resolves.toEqual({ done: true });
    expect(mocks.role).toHaveBeenCalledWith("site-evidence", process.env);
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith({ owner: { instanceId: role.instanceId, bootId: role.bootId },
      roleLease: role, job: ctx.lease, signal: ctx.signal, deadlineAt: ctx.deadlineAt });
    expect(mocks.refresh).not.toHaveBeenCalled(); expect(mocks.due).not.toHaveBeenCalled();
    expect(mocks.queue).not.toHaveBeenCalled(); expect(mocks.progress).not.toHaveBeenCalled();
  });
  it.each(["missing-role", "missing-job", "wrong-job", "legacy-role"] as const)("rejects %s before source dispatch", async kind => {
    const ctx = context(kind === "wrong-job" ? "product-evidence-refresh" : undefined);
    if (kind === "missing-role") mocks.role.mockReturnValue(undefined);
    if (kind === "legacy-role") mocks.role.mockReturnValue({ ...role, batchVersion: undefined, batchEpoch: undefined });
    if (kind === "missing-job") delete ctx.lease;
    await expect(refreshSiteEvidenceJob(ctx)).rejects.toThrow("evidence_source_owner_required");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("keeps source admission blocking as typed deferred without a completion event", async () => {
    mocks.execute.mockRejectedValue(new JobBatchBlockedError()); const ctx = context();
    await expect(refreshSiteEvidenceJob(ctx)).resolves.toEqual({ done: false, deferred: "stage_blocked" });
    expect(ctx.log).not.toHaveBeenCalled();
  });
  it("settles each turn before another and excludes unchanged facts from canary count", async () => {
    mocks.execute.mockResolvedValueOnce({ state: "recorded", factsChanged: 1 })
      .mockResolvedValueOnce({ state: "recorded", factsChanged: 0 })
      .mockResolvedValueOnce({ state: "failed", factsChanged: 0 });
    const ctx = context(); await expect(refreshSiteEvidenceJob(ctx)).resolves.toEqual({ done: true });
    expect(mocks.execute).toHaveBeenCalledTimes(4);
    expect(ctx.log).toHaveBeenLastCalledWith("evidence.site_refresh_batch", { attempted: 3, succeeded: 1, failed: 1, factsChanged: 1 });
    expect(ctx.save).not.toHaveBeenCalled();
  });
  it("limits settled work to four turns without claiming an unobserved next page", async () => {
    mocks.execute.mockResolvedValue({ state: "recorded", factsChanged: 1 });
    const ctx = context(); await expect(refreshSiteEvidenceJob(ctx)).resolves.toEqual({ done: false });
    expect(mocks.execute).toHaveBeenCalledTimes(4);
    expect(ctx.log).toHaveBeenCalledWith("evidence.site_refresh_batch", { attempted: 4, succeeded: 4, failed: 0, factsChanged: 4 });
  });
  it.each(["budget", "abort", "deadline"] as const)("starts no source call after %s", async kind => {
    const ctx = context();
    if (kind === "budget") ctx.hasBudget = () => false;
    if (kind === "abort") ctx.signal = AbortSignal.abort();
    if (kind === "deadline") ctx.deadlineAt = Date.now() - 1;
    await expect(refreshSiteEvidenceJob(ctx)).resolves.toEqual({ done: false });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("preserves a typed HTTP hold and the source executor's cleanup error identity", async () => {
    const hold = new HttpOriginPermitError("unavailable"); mocks.execute.mockRejectedValueOnce(hold);
    await expect(refreshSiteEvidenceJob(context())).rejects.toBe(hold);
    const cleanup = new Error("cleanup"); const both = new AggregateError([hold, cleanup]); mocks.execute.mockRejectedValueOnce(both);
    await expect(refreshSiteEvidenceJob(context())).rejects.toBe(both);
  });
});

describe("legacy inline canonical partition", () => {
  it("preserves the normal legacy inline source control", async () => {
    const oldRole = { ...role, role: "crawler", batchVersion: undefined, batchEpoch: undefined };
    mocks.role.mockReturnValue(oldRole); const ctx = context<EvidenceRefreshCursor>("product-evidence-refresh");
    await expect(refreshProductEvidenceJob(ctx)).resolves.toEqual({ done: true });
    expect(mocks.execute).toHaveBeenCalledTimes(1); expect(mocks.dueRequests).toHaveBeenCalledTimes(1);
  });
  it("skips canonical in versioned mode and continues the old product request path", async () => {
    mocks.mode.mockResolvedValue({ mode: "versioned" }); const ctx = context<EvidenceRefreshCursor>("product-evidence-refresh");
    await expect(refreshProductEvidenceJob(ctx)).resolves.toEqual({ done: true });
    expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.dueRequests).toHaveBeenCalledTimes(1);
  });
  it("defers draining before canonical or product request progress", async () => {
    mocks.mode.mockResolvedValue({ mode: "draining" }); const ctx = context<EvidenceRefreshCursor>("product-evidence-refresh");
    await expect(refreshProductEvidenceJob(ctx)).resolves.toEqual({ done: false, deferred: "stage_blocked" });
    expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.dueRequests).not.toHaveBeenCalled();
    expect(ctx.save).not.toHaveBeenCalled();
  });
  it("preserves pending when actual source admission changes after the legacy hint", async () => {
    mocks.execute.mockRejectedValue(new JobBatchBlockedError()); const ctx = context<EvidenceRefreshCursor>("product-evidence-refresh");
    await expect(refreshProductEvidenceJob(ctx)).resolves.toEqual({ done: false, deferred: "stage_blocked" });
    expect(mocks.dueRequests).not.toHaveBeenCalled(); expect(ctx.save).not.toHaveBeenCalled();
  });
});

it("allows only the old and new fixed job identity inside source receipts", () => {
  const input = { name: "product-site-evidence-refresh", token: "job", requestedVersion: 1 };
  expect(SourceJobSchema.safeParse(input).success).toBe(true);
  expect(SourceJobSchema.safeParse({ ...input, name: "product-evidence-refresh" }).success).toBe(true);
  expect(SourceJobSchema.safeParse({ ...input, name: "news-refresh" }).success).toBe(false);
  expect(SourceJobSchema.safeParse({ ...input, ready: true }).success).toBe(false);
});
