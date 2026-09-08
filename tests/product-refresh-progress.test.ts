import { beforeEach, expect, it, vi } from "vitest";
import type { ProductRefreshProgress } from "@/lib/db/product-evidence-schema";
import type { DeclaredEvidenceSource } from "@/lib/domain/evidence/refresh";

const state = vi.hoisted(() => ({ sources: [] as Record<string, unknown>[], declarations: [] as Record<string, unknown>[],
  media: [] as Record<string, unknown>[] }));
vi.mock("@/lib/db", () => ({ db: {
  select: () => {
    let table: unknown;
    const query = {
      from: (value: unknown) => { table = value; return query; },
      innerJoin: () => query, leftJoin: () => query, where: () => query, orderBy: () => query, limit: () => query,
      then: async (resolve: (rows: unknown[]) => unknown) => {
        const schema = await import("@/lib/db/schema");
        return resolve(table === schema.productLinks ? state.sources
          : table === schema.productMediaDeclarations ? state.declarations : state.media);
      },
    };
    return query;
  },
  update: () => ({ set: () => ({ where: async () => {} }) }),
} }));
vi.mock("@/lib/domain/products/generation", () => ({
  withProductGeneration: async (_slug: string, _id: number, run: () => unknown) => run(),
  ProductGenerationChangedError: class extends Error {},
}));
vi.mock("@/lib/domain/media/repository", () => ({
  observeProductMedia: vi.fn(async () => ({ status: "unchanged" })), markProductMediaMissing: vi.fn(),
}));
vi.mock("@/lib/domain/evidence/settings-store", async () => ({
  currentEvidenceSettings: async () => (await import("@/lib/domain/evidence/settings")).DEFAULT_EVIDENCE_SETTINGS,
}));
vi.mock("@/lib/domain/evidence/providers/github", () => ({ refreshGitHubEvidence: vi.fn() }));
vi.mock("@/lib/domain/evidence/providers/site-fingerprint", () => ({ refreshSiteFingerprint: vi.fn() }));
vi.mock("@/lib/domain/evidence/repository", () => ({ upsertObservedSource: vi.fn() }));

const { refreshProductEvidence, evidenceRefreshKey, mediaRefreshKey } = await import("@/lib/domain/evidence/refresh");
const now = new Date("2026-09-08T00:00:00Z");
const fresh = () => ({ completedKeys: [], retryAfterByKey: {} } satisfies ProductRefreshProgress);
const source = (url: string) => ({ productId: 1, slug: "test", kind: "support", sourceKey: url, sourceUrl: url,
  attempts: 0, normalizedFacts: null, lastSuccessAt: now, sourceId: 1, nextAttemptAt: new Date(now.getTime() + 86400000), lastErrorCode: null });
beforeEach(() => { state.sources = []; state.declarations = []; state.media = []; vi.clearAllMocks(); });

it("force revisits recent observed media, while maker refresh does not", async () => {
  state.media = [{ productId: 1, slug: "test", sourceUrl: "https://test.example/shot.png", altText: null,
    position: 0, declarationId: null, declarationRevision: null, nextAttemptAt: now }];
  const image = vi.fn(async () => ({ ok: true as const, asset: {} as never, finalUrl: "https://test.example/shot.png" }));
  await refreshProductEvidence("test", { now, force: false, progress: fresh(), dependencies: { image } });
  expect(image).not.toHaveBeenCalled();
  await refreshProductEvidence("test", { now, force: true, progress: fresh(), dependencies: { image } });
  expect(image).toHaveBeenCalledTimes(1);
});

it("resumes force after a budget stop without repeating completed URLs", async () => {
  state.sources = [source("https://test.example/a"), source("https://test.example/b")];
  let progress: ProductRefreshProgress = fresh();
  const refreshSource = vi.fn(async (source: DeclaredEvidenceSource) => {
    void source;
    return { factsChanged: 0, eventsInserted: 0, mediaInserted: 0 };
  });
  const options = { now, force: true, dependencies: { refreshSource },
    saveProgress: async (next: ProductRefreshProgress) => { progress = structuredClone(next); } };
  const first = await refreshProductEvidence("test", { ...options, progress, hasBudget: () => refreshSource.mock.calls.length === 0 });
  expect(first.complete).toBe(false);
  expect(progress.completedKeys).toHaveLength(1);
  const second = await refreshProductEvidence("test", { ...options, progress });
  expect(second.complete).toBe(true);
  expect(refreshSource.mock.calls.map(([input]) => (input as {sourceUrl: string}).sourceUrl))
    .toEqual(["https://test.example/a", "https://test.example/b"]);
});

it("force preserves an upstream cooldown and leaves the source unfinished", async () => {
  state.sources = [{ ...source("https://test.example/a"), lastErrorCode: "rate_limited" }];
  const refreshSource = vi.fn();
  let progress: ProductRefreshProgress = fresh();
  const result = await refreshProductEvidence("test", { now, force: true, progress,
    saveProgress: async next => { progress = next; }, dependencies: { refreshSource } });
  expect(refreshSource).not.toHaveBeenCalled();
  expect(progress.completedKeys).toEqual([]);
  expect(result).toMatchObject({ complete: false, nextAttemptAt: new Date(now.getTime() + 86400000) });
});

it("changed URLs and declaration revisions cannot reuse a completion", () => {
  const original = { kind: "support" as const, sourceKey: "support", sourceUrl: "https://test.example/a" };
  expect(evidenceRefreshKey(original)).not.toBe(evidenceRefreshKey({ ...original, sourceUrl: "https://test.example/b" }));
  const declaration = { sourceUrl: "https://test.example/shot.png", declarationId: 3, declarationRevision: 1 };
  expect(mediaRefreshKey(declaration)).not.toBe(mediaRefreshKey({ ...declaration, declarationRevision: 2 }));
});
