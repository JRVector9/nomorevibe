import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_EVIDENCE_SETTINGS } from "@/lib/domain/evidence/settings";
import type { ProductRefreshProgress } from "@/lib/db/product-evidence-schema";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(), generation: vi.fn(), select: vi.fn(), product: vi.fn(), source: vi.fn(), repository: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: {
  select: mocks.select,
  transaction: mocks.transaction,
  query: { products: { findFirst: mocks.product }, productEvidenceSources: { findFirst: mocks.source },
    productLinks: { findFirst: mocks.repository } },
} }));
vi.mock("@/lib/domain/evidence/settings-store", () => ({ currentEvidenceSettings: mocks.settings }));
vi.mock("@/lib/domain/products/generation", () => ({
  withProductGeneration: mocks.generation, ProductGenerationChangedError: class extends Error {},
}));

const { refreshProductEvidence, retryAt } = await import("@/lib/domain/evidence/refresh");
const { ProductGenerationChangedError } = await import("@/lib/domain/products/generation");
const { JobLeaseLostError } = await import("@/lib/jobs/control");
const now = new Date("2026-10-14T00:00:00Z");
const stoppedResult = { complete: false, sourcesAttempted: 0, sourcesFailed: 0, nextAttemptAt: now };

function rowsQuery(rows: unknown[]) {
  const query = {
    from: () => query, innerJoin: () => query, leftJoin: () => query, where: () => query,
    orderBy: () => query, limit: () => query, for: () => query,
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
  };
  return query;
}

function repositoryPostprocessing() {
  const source = { productId: 1, slug: "test", kind: "repository", sourceKey: "owner/repo", sourceUrl: "https://github.com/owner/repo",
    sourceId: 1, attempts: 0, normalizedFacts: { type: "github_repository", stars: 1 }, lastSuccessAt: null,
    nextAttemptAt: now, lastErrorCode: null };
  const refreshed = { id: 1, attempts: 0, normalizedFacts: { type: "github_repository", stars: 2 } };
  mocks.select.mockImplementationOnce(() => rowsQuery([source]));
  const mutation = vi.fn(async () => {});
  const set = vi.fn(() => ({ where: mutation }));
  const tx = { select: vi.fn(() => rowsQuery([refreshed])), update: vi.fn(() => ({ set })) };
  mocks.generation.mockImplementation(async (_slug, _id, run) => run(tx));
  return { tx, mutation, set };
}

function cutoff(mode: "abort" | "deadline" | "budget") {
  const controller = new AbortController();
  const deadlineAt = Date.now() + 60_000;
  let budget = true;
  return {
    options: { now, signal: controller.signal, deadlineAt, hasBudget: () => budget },
    stop: () => {
      if (mode === "abort") controller.abort();
      if (mode === "deadline") vi.spyOn(Date, "now").mockReturnValue(deadlineAt);
      if (mode === "budget") budget = false;
    },
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.settings.mockResolvedValue(DEFAULT_EVIDENCE_SETTINGS);
  mocks.transaction.mockResolvedValue(undefined);
  mocks.generation.mockResolvedValue(undefined);
  mocks.product.mockResolvedValue(undefined);
  mocks.source.mockResolvedValue(undefined);
  mocks.repository.mockResolvedValue(undefined);
  mocks.select.mockImplementation(() => {
    const query = {
      from: () => query, innerJoin: () => query, leftJoin: () => query, where: () => query,
      orderBy: () => query, limit: () => query,
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
    };
    return query;
  });
});
afterEach(() => vi.restoreAllMocks());

it.each(["abort", "deadline", "budget"] as const)("starts no preparation when %s has already stopped the product refresh", async mode => {
  const { options, stop } = cutoff(mode);
  stop();
  expect(await refreshProductEvidence("test", { ...options, productId: 1 })).toMatchObject(stoppedResult);
  expect(mocks.generation).not.toHaveBeenCalled();
  expect(mocks.settings).not.toHaveBeenCalled();
  expect(mocks.select).not.toHaveBeenCalled();
  expect(mocks.product).not.toHaveBeenCalled();
});

it.each(["abort", "deadline", "budget"] as const)("starts no settings read after %s during the generation check", async mode => {
  const { options, stop } = cutoff(mode);
  mocks.generation.mockImplementation(async () => { stop(); });
  expect(await refreshProductEvidence("test", { ...options, productId: 1 })).toMatchObject(stoppedResult);
  expect(mocks.settings).not.toHaveBeenCalled();
  expect(mocks.select).not.toHaveBeenCalled();
  expect(mocks.product).not.toHaveBeenCalled();
});

it.each(["abort", "deadline", "budget"] as const)("starts no selection reads after %s during the settings read", async mode => {
  const { options, stop } = cutoff(mode);
  mocks.settings.mockImplementation(async () => { stop(); return DEFAULT_EVIDENCE_SETTINGS; });
  expect(await refreshProductEvidence("test", options)).toMatchObject(stoppedResult);
  expect(mocks.select).not.toHaveBeenCalled();
  expect(mocks.product).not.toHaveBeenCalled();
});

it.each(["abort", "deadline", "budget"] as const)("starts no canonical-source read after %s during the product lookup", async mode => {
  const { options, stop } = cutoff(mode);
  mocks.product.mockImplementation(async () => { stop(); return { id: 1, url: "https://test.example" }; });
  expect(await refreshProductEvidence("test", options)).toMatchObject(stoppedResult);
  expect(mocks.source).not.toHaveBeenCalled();
  expect(mocks.repository).not.toHaveBeenCalled();
});

it.each(["abort", "deadline", "budget"] as const)("starts no repository lookup after %s during the canonical-source read", async mode => {
  const { options, stop } = cutoff(mode);
  mocks.product.mockResolvedValue({ id: 1, url: "https://test.example" });
  mocks.source.mockImplementation(async () => { stop(); return undefined; });
  expect(await refreshProductEvidence("test", options)).toMatchObject(stoppedResult);
  expect(mocks.repository).not.toHaveBeenCalled();
});

it.each(["abort", "deadline", "budget"] as const)("keeps accepted source progress without final declaration reads after %s", async mode => {
  const { options, stop } = cutoff(mode);
  mocks.select.mockImplementationOnce(() => {
    const query = {
      from: () => query, innerJoin: () => query, leftJoin: () => query, where: () => query,
      orderBy: () => query,
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([{ productId: 1, slug: "test", kind: "support",
        sourceKey: "https://test.example/support", sourceUrl: "https://test.example/support", sourceId: 1,
        attempts: 0, normalizedFacts: null, lastSuccessAt: null, nextAttemptAt: now, lastErrorCode: null }]).then(resolve),
    };
    return query;
  });
  const refreshSource = vi.fn(async () => { stop(); return { factsChanged: 1, eventsInserted: 0, mediaInserted: 0 }; });
  const saveProgress = vi.fn();
  const result = await refreshProductEvidence("test", { ...options, force: true,
    progress: { completedKeys: [], retryAfterByKey: {} }, saveProgress, dependencies: { refreshSource } });
  expect(mocks.select).toHaveBeenCalledTimes(3);
  expect(mocks.product).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ complete: false, sourcesAttempted: 1, factsChanged: 1, nextAttemptAt: now });
  expect(saveProgress).toHaveBeenLastCalledWith({ completedKeys: [expect.any(String)], retryAfterByKey: {} });
});

it.each(["abort", "deadline"] as const)("starts no repository freshness transaction after %s while the provider's started write settles", async mode => {
  const { options, stop } = cutoff(mode);
  const { tx } = repositoryPostprocessing();
  const github = vi.fn(async () => { stop(); return { status: "updated" as const, releases: 2 }; });
  const result = await refreshProductEvidence("test", { ...options, dependencies: { github } });
  expect(mocks.generation).not.toHaveBeenCalled();
  expect(tx.select).not.toHaveBeenCalled();
  expect(tx.update).not.toHaveBeenCalled();
  expect(result).toMatchObject({ complete: false, sourcesAttempted: 1, sourcesFailed: 0, eventsInserted: 2, nextAttemptAt: now });
});

it.each(["abort", "deadline"] as const)("starts no source SELECT after %s while awaiting the repository freshness transaction callback", async mode => {
  const { options, stop } = cutoff(mode);
  const { tx } = repositoryPostprocessing();
  mocks.generation.mockImplementation(async (_slug, _id, run) => { stop(); return run(tx); });
  const github = vi.fn(async () => ({ status: "updated" as const, releases: 2 }));
  const result = await refreshProductEvidence("test", { ...options, dependencies: { github } });
  expect(mocks.generation).toHaveBeenCalledTimes(1);
  expect(tx.select).not.toHaveBeenCalled();
  expect(tx.update).not.toHaveBeenCalled();
  expect(result).toMatchObject({ complete: false, sourcesFailed: 0, eventsInserted: 2, nextAttemptAt: now });
});

it.each([
  { mode: "abort", status: "updated" },
  { mode: "deadline", status: "updated" },
  { mode: "abort", status: "deferred" },
  { mode: "deadline", status: "deferred" },
] as const)("starts no $status freshness UPDATE after $mode during the source SELECT", async ({ mode, status }) => {
  const { options, stop } = cutoff(mode);
  const { tx, mutation } = repositoryPostprocessing();
  const refreshed = { id: 1, attempts: 0, normalizedFacts: { type: "github_repository", stars: 2 } };
  tx.select.mockImplementationOnce(() => {
    const query = rowsQuery([refreshed]);
    query.then = resolve => Promise.resolve().then(() => {
      stop();
      return resolve([refreshed]);
    });
    return query;
  });
  const releases = status === "updated" ? 2 : 0;
  const github = vi.fn(async () => ({ status, releases }));
  const result = await refreshProductEvidence("test", { ...options, dependencies: { github } });
  expect(tx.select).toHaveBeenCalledTimes(1);
  expect(tx.update).not.toHaveBeenCalled();
  expect(mutation).not.toHaveBeenCalled();
  expect(result).toMatchObject({ complete: false, sourcesAttempted: 1, sourcesFailed: 0, eventsInserted: releases, nextAttemptAt: now });
});

it("keeps core success and freshness processing when only optional cooperative budget is exhausted", async () => {
  const { options, stop } = cutoff("budget");
  const { tx } = repositoryPostprocessing();
  const github = vi.fn(async () => { stop(); return { status: "updated" as const, releases: 2 }; });
  const saveProgress = vi.fn();
  const result = await refreshProductEvidence("test", { ...options, force: true,
    progress: { completedKeys: [], retryAfterByKey: {} }, saveProgress, dependencies: { github } });
  expect(tx.select).toHaveBeenCalledTimes(1);
  expect(tx.update).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ sourcesFailed: 0, factsChanged: 1, eventsInserted: 2 });
  expect(saveProgress).toHaveBeenLastCalledWith({ completedKeys: [expect.any(String)], retryAfterByKey: {} });
});

it.each(["abort", "deadline"] as const)("lets an already started repository freshness write settle after %s", async mode => {
  const { options, stop } = cutoff(mode);
  const { tx, mutation } = repositoryPostprocessing();
  mutation.mockImplementation(async () => { stop(); await Promise.resolve(); });
  const github = vi.fn(async () => ({ status: "updated" as const, releases: 2 }));
  const saveProgress = vi.fn();
  const result = await refreshProductEvidence("test", { ...options, force: true,
    progress: { completedKeys: [], retryAfterByKey: {} }, saveProgress, dependencies: { github } });
  expect(tx.select).toHaveBeenCalledTimes(1);
  expect(mutation).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ complete: false, sourcesFailed: 0, factsChanged: 1, eventsInserted: 2 });
  expect(saveProgress).toHaveBeenLastCalledWith({ completedKeys: [expect.any(String)], retryAfterByKey: {} });
});

it.each([
  { mode: "abort", upstreamRetry: true },
  { mode: "deadline", upstreamRetry: true },
  { mode: "abort", upstreamRetry: false },
  { mode: "deadline", upstreamRetry: false },
] as const)("keeps the settled deferred retry checkpoint without another read after $mode (upstreamRetry=$upstreamRetry)", async ({ mode, upstreamRetry }) => {
  const { options, stop } = cutoff(mode);
  const { tx, mutation, set } = repositoryPostprocessing();
  const retry = upstreamRetry ? new Date(now.getTime() + 12 * 60 * 60 * 1_000) : retryAt(now, 0, DEFAULT_EVIDENCE_SETTINGS);
  let readsAtStop = 0;
  mutation.mockImplementation(async () => { readsAtStop = mocks.select.mock.calls.length; stop(); await Promise.resolve(); });
  const checkpoints: ProductRefreshProgress[] = [];
  const saveProgress = vi.fn(async (next: ProductRefreshProgress) => { await Promise.resolve(); checkpoints.push(structuredClone(next)); });
  const github = vi.fn(async () => ({ status: "deferred" as const, releases: 0, retryAt: upstreamRetry ? retry : null }));
  const result = await refreshProductEvidence("test", { ...options, force: true,
    lease: { name: "product-evidence-refresh", token: "owner", requestedVersion: 0 },
    progress: { completedKeys: [], retryAfterByKey: {} }, saveProgress, dependencies: { github } });
  expect(mutation).toHaveBeenCalledTimes(1);
  expect(set).toHaveBeenCalledWith(expect.objectContaining({ nextAttemptAt: retry }));
  expect(tx.select).toHaveBeenCalledTimes(2); // Source read and required commit ownership fence.
  expect(mocks.select).toHaveBeenCalledTimes(readsAtStop);
  expect(result).toMatchObject({ complete: false, sourcesAttempted: 1, sourcesFailed: 1, factsChanged: 1, eventsInserted: 0, nextAttemptAt: now });
  expect(checkpoints.at(-1)).toMatchObject({ completedKeys: [] });
  expect(Object.values(checkpoints.at(-1)!.retryAfterByKey)).toEqual([retry.toISOString()]);
});

it.each(["abort", "deadline"] as const)("starts no failure write after a repository collector throws across %s", async mode => {
  const { options, stop } = cutoff(mode);
  repositoryPostprocessing();
  const github = vi.fn(async () => { stop(); throw new Error("collector_failed"); });
  const saveProgress = vi.fn();
  const result = await refreshProductEvidence("test", { ...options, force: true,
    progress: { completedKeys: [], retryAfterByKey: {} }, saveProgress, dependencies: { github } });
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(result).toMatchObject({ complete: false, sourcesAttempted: 1, sourcesFailed: 1, nextAttemptAt: now });
  expect(saveProgress).toHaveBeenLastCalledWith({ completedKeys: [], retryAfterByKey: expect.any(Object) });
  expect(Object.values(saveProgress.mock.calls.at(-1)![0].retryAfterByKey)).toEqual([retryAt(now, 1, DEFAULT_EVIDENCE_SETTINGS).toISOString()]);
});

it.each(["abort", "deadline"] as const)("still propagates a checkpoint CAS failure after %s", async mode => {
  const { options, stop } = cutoff(mode);
  const { mutation } = repositoryPostprocessing();
  mutation.mockImplementation(async () => { stop(); });
  const github = vi.fn(async () => ({ status: "deferred" as const, releases: 0, retryAt: new Date(now.getTime() + 60_000) }));
  const error = new Error("product refresh request changed");
  const saveProgress = vi.fn(async () => { throw error; });
  await expect(refreshProductEvidence("test", { ...options, force: true,
    progress: { completedKeys: [], retryAfterByKey: {} }, saveProgress, dependencies: { github } })).rejects.toBe(error);
  expect(saveProgress).toHaveBeenCalled();
  expect(mocks.transaction).not.toHaveBeenCalled();
});

it.each([
  { mode: "abort", failure: "generation" },
  { mode: "deadline", failure: "generation" },
  { mode: "abort", failure: "lease" },
  { mode: "deadline", failure: "lease" },
] as const)("still propagates $failure loss after $mode in the repository collector", async ({ mode, failure }) => {
  const { options, stop } = cutoff(mode);
  repositoryPostprocessing();
  const error = failure === "generation" ? new ProductGenerationChangedError() : new JobLeaseLostError();
  const github = vi.fn(async () => { stop(); throw error; });
  const saveProgress = vi.fn();
  await expect(refreshProductEvidence("test", { ...options, force: true,
    progress: { completedKeys: [], retryAfterByKey: {} }, saveProgress, dependencies: { github } })).rejects.toBe(error);
  expect(saveProgress).not.toHaveBeenCalled();
  expect(mocks.transaction).not.toHaveBeenCalled();
});

it("공유 HTTP permit 대기는 source 실패/재시도와 진행 완료를 기록하지 않는다", async () => {
  const { HttpOriginPermitError } = await import("@/lib/net/http-origin-policy");
  const source = { productId: 1, slug: "test", kind: "support", sourceKey: "https://test.example/support", sourceUrl: "https://test.example/support",
    sourceId: 1, attempts: 0, normalizedFacts: null, lastSuccessAt: null, nextAttemptAt: now, lastErrorCode: null };
  mocks.select.mockImplementationOnce(() => rowsQuery([source]));
  const saveProgress = vi.fn();
  const refreshSource = vi.fn().mockRejectedValue(new HttpOriginPermitError("waiting_aborted"));
  const result = await refreshProductEvidence("test", { now, force: true, progress: { completedKeys: [], retryAfterByKey: {} }, saveProgress,
    dependencies: { refreshSource } });
  expect(result).toMatchObject({ complete: false, sourcesAttempted: 0, sourcesFailed: 0, nextAttemptAt: now, deferred: "http_origin_permit" });
  expect(mocks.generation).not.toHaveBeenCalled();
  expect(saveProgress).toHaveBeenLastCalledWith({ completedKeys: [], retryAfterByKey: {} });
});

it("공유 HTTP permit 대기는 media 선언 실패/6시간 backoff를 기록하지 않는다", async () => {
  const { HttpOriginPermitError } = await import("@/lib/net/http-origin-policy");
  mocks.select.mockImplementationOnce(() => rowsQuery([])).mockImplementationOnce(() => rowsQuery([{ productId: 1, slug: "test", sourceUrl: "https://test.example/image.png", altText: null,
    position: 0, declarationId: 9, declarationRevision: 1, nextAttemptAt: now }])).mockImplementationOnce(() => rowsQuery([]));
  const saveProgress=vi.fn(),image=vi.fn().mockRejectedValue(new HttpOriginPermitError("waiting_aborted"));
  const result=await refreshProductEvidence("test",{now,force:true,progress:{completedKeys:[],retryAfterByKey:{}},saveProgress,dependencies:{image}});
  expect(image).toHaveBeenCalledOnce();
  expect(result).toMatchObject({complete:false,sourcesAttempted:0,sourcesFailed:0,nextAttemptAt:now,deferred:"http_origin_permit"});
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(saveProgress).toHaveBeenLastCalledWith({completedKeys:[],retryAfterByKey:{}});
});
