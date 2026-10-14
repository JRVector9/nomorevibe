import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  productEvidenceSources,
  productProfiles,
  products,
  productUpdates,
  jobs,
} from "@/lib/db/schema";
import type { ConditionalRequest, GitHubHttpResult } from "@/lib/crawl/github";
import { fetchPublishedReleases, mapGitHubRepositoryFacts, recomputeRepositoryRelationships, refreshGitHubEvidence } from "@/lib/domain/evidence/providers/github";
import {
  replaceMakerLinks,
  saveMakerProfile,
  upsertObservedSource,
} from "@/lib/domain/evidence/repository";
import { insertUpdateCandidates } from "@/lib/domain/evidence/updates";
import { ensureSchema, resetTables } from "./setup";
import { refreshProductEvidence } from "@/lib/domain/evidence/refresh";
import * as generation from "@/lib/domain/products/generation";
import * as jobControl from "@/lib/jobs/control";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(jobs);
  await db.insert(products).values({
    slug: "github-product",
    url: "https://product.example",
    name: "GitHub Product",
    tagline: "Evidence",
    description: "Evidence product",
    category: "Dev",
    status: "verified",
    verifyToken: "verify-token",
    editTokenHash: "a".repeat(64),
  });
  await saveMakerProfile({
    slug: "github-product",
    actor: "maker:test",
    profile: {
      pricingModel: "open_source",
      lifecycle: "ga",
      longDescriptionMarkdown: "Maker profile",
      team: [],
      makerLicense: { value: "MIT", spdxId: "MIT" },
    },
  });
  await replaceMakerLinks({
    slug: "github-product",
    actor: "maker:test",
    links: [{ kind: "repository", url: "https://github.com/Owner/Repo" }],
  });
});

const ok = <T>(value: T, headers: Partial<{ etag: string; lastModified: string; link: string }> = {}): GitHubHttpResult<T> => ({
  ok: true,
  status: 200,
  value,
  etag: headers.etag ?? null,
  lastModified: headers.lastModified ?? null,
  link: headers.link ?? null,
});

const repository = {
  html_url: "https://github.com/Owner/Repo",
  full_name: "Owner/Repo",
  created_at: "2024-01-02T03:04:05Z",
  pushed_at: "2026-08-18T12:00:00Z",
  updated_at: "2026-08-18T13:00:00Z",
  stargazers_count: 146,
  forks_count: 12,
  private: false,
  archived: false,
  fork: false,
  homepage: "https://product.example",
  license: {
    name: "Apache License 2.0",
    spdx_id: "Apache-2.0",
    url: "https://api.github.com/licenses/apache-2.0",
  },
};

function successfulRequest() {
  return vi.fn(async (path: string): Promise<GitHubHttpResult<unknown>> => {
    if (path === "/repos/owner/repo") {
      return ok(repository, { etag: '"repo-v1"', lastModified: "Wed, 19 Aug 2026 00:00:00 GMT" });
    }
    if (path.endsWith("/languages")) return ok({ TypeScript: 700, Rust: 300 });
    if (path.includes("/contributors")) {
      return ok([{ login: "maker" }], {
        link: '<https://api.github.com/repos/owner/repo/contributors?per_page=1&page=2>; rel="last"',
      });
    }
    if (path.includes("/releases")) {
      return ok([
        {
          id: 2,
          tag_name: "v1.1.0",
          name: "v1.1.0",
          html_url: "https://github.com/Owner/Repo/releases/tag/v1.1.0",
          published_at: "2026-08-17T00:00:00Z",
          draft: false,
        },
        {
          id: 1,
          tag_name: "v1.0.0",
          name: "v1.0.0",
          html_url: "https://github.com/Owner/Repo/releases/tag/v1.0.0",
          published_at: "2026-08-10T00:00:00Z",
          draft: false,
        },
      ]);
    }
    if (path.endsWith("/readme")) {
      return ok({
        html_url: "https://github.com/Owner/Repo/blob/main/README.md",
        content: Buffer.from("[Live service](https://product.example)").toString("base64"),
        encoding: "base64",
      });
    }
    if (path.includes("/activity?")) return { ok: false, error: { kind: "not_found" } };
    throw new Error(`unexpected path: ${path}`);
  });
}

describe("GitHub evidence refresh", () => {
  it.each(["page=100", "page=0", "page=invalid", "per_page=1&page=2"])("rejects an impossible next release cursor %s instead of skipping consumed items", async query => {
    const request = vi.fn(async () => ok([], { link: `<https://api.github.com/repos/owner/repo/releases?${query}>; rel="next"` }));
    expect(await fetchPublishedReleases(request, "owner/repo", () => true)).toMatchObject({ ok: false, error: { kind: "invalid_response" } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["deadline", "abort", "budget"] as const)("starts no activity or final success after %s during the relationship lookup", async stop => {
    const now = new Date("2026-08-19T00:00:00Z");
    const controller = new AbortController();
    const deadlineAt = Date.now() + 5000;
    let budget = true;
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    const original = db.query.productLinks.findFirst.bind(db.query.productLinks);
    const lookup = vi.spyOn(db.query.productLinks, "findFirst").mockImplementation((async (config: Parameters<typeof db.query.productLinks.findFirst>[0]) => {
      const result = await original(config);
      if (stop === "abort") controller.abort();
      if (stop === "budget") budget = false;
      if (stop === "deadline") clock = vi.spyOn(Date, "now").mockReturnValue(deadlineAt + 1);
      return result;
    }) as unknown as typeof db.query.productLinks.findFirst);
    const request = successfulRequest();
    try {
      expect(await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request,
        signal: controller.signal, deadlineAt, hasBudget: () => budget, now: () => now })).toMatchObject({ status: "budget_exhausted" });
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(request.mock.calls.some(([path]) => path.includes("/activity?"))).toBe(false);
    } finally { lookup.mockRestore(); clock?.mockRestore(); }
    expect((await db.select().from(productEvidenceSources))[0].lastSuccessAt).toBeNull();
    expect(await db.select().from(productUpdates)).toHaveLength(0);
  });

  it.each(["deadline", "abort"] as const)("starts no final success write after %s while awaiting its transaction callback", async stop => {
    const controller = new AbortController();
    const deadlineAt = Date.now() + 5000;
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    let writes = 0;
    const original = jobControl.withJobLeaseWrite;
    const write = vi.spyOn(jobControl, "withJobLeaseWrite").mockImplementation((async (lease, callback) => {
      if (++writes === 6) {
        if (stop === "abort") controller.abort();
        else clock = vi.spyOn(Date, "now").mockReturnValue(deadlineAt + 1);
      }
      return original(lease, callback);
    }) as typeof jobControl.withJobLeaseWrite);
    try {
      expect(await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, {
        request: successfulRequest(), signal: controller.signal, deadlineAt,
      })).toMatchObject({ status: "budget_exhausted" });
      expect(writes).toBe(6);
    } finally { write.mockRestore(); clock?.mockRestore(); }
    expect((await db.select().from(productEvidenceSources))[0].lastSuccessAt).toBeNull();
    expect(await db.select().from(productUpdates)).toHaveLength(0);
  });

  it.each(["deadline", "abort", "budget"] as const)("starts no new source SELECT after %s while awaiting the generation lock", async stop => {
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: successfulRequest() });
    await upsertObservedSource({ slug: "github-product", kind: "documentation", provider: "product_site", sourceKey: "canonical_site",
      state: "ok", normalizedFacts: { type: "site_fingerprint", repositoryKeys: ["owner/repo"] } });
    const [product] = await db.select({ id: products.id }).from(products);
    const controller = new AbortController();
    const deadlineAt = Date.now() + 5000;
    let budget = true;
    let readsAfterLock = -1;
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    const original = generation.withProductGeneration;
    const lock = vi.spyOn(generation, "withProductGeneration").mockImplementation((async (slug, id, run) => original(slug, id, async tx => {
      if (stop === "abort") controller.abort();
      if (stop === "budget") budget = false;
      if (stop === "deadline") clock = vi.spyOn(Date, "now").mockReturnValue(deadlineAt + 1);
      const select = vi.spyOn(tx, "select");
      try { return await run(tx); }
      finally { readsAfterLock = select.mock.calls.length; select.mockRestore(); }
    })) as typeof generation.withProductGeneration);
    try {
      await recomputeRepositoryRelationships("github-product", product.id, undefined, { signal: controller.signal, deadlineAt, hasBudget: () => budget });
      expect(lock).toHaveBeenCalledTimes(1);
      expect(readsAfterLock).toBe(0);
    } finally { lock.mockRestore(); clock?.mockRestore(); }
    expect((await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.kind, "repository")))[0].normalizedFacts?.relationshipState)
      .toBe("repository_link");
  });

  it.each(["root", "languages", "contributors", "readme", "releases"] as const)("flushes accepted %s progress but starts no relationship or success work after the core HTTP budget ends", async phase => {
    const now = new Date("2026-08-19T00:00:00Z");
    const base = successfulRequest();
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: base, now: () => now });
    const makerRead = vi.spyOn(db.query.productLinks, "findFirst");
    const siteRead = vi.spyOn(db.query.productEvidenceSources, "findMany");
    let budget = true;
    const request = vi.fn(async (path: string) => {
      const response = path === "/repos/owner/repo" ? ok({ ...repository, stargazers_count: 201 }) : await base(path);
      if (phase === "root" ? path === "/repos/owner/repo" : path.includes(`/${phase}`)) budget = false;
      return response;
    });
    try {
      expect(await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request,
        now: () => new Date(now.getTime() + 60000), hasBudget: () => budget })).toMatchObject({ status: "budget_exhausted" });
      expect(makerRead).not.toHaveBeenCalled();
      expect(siteRead).not.toHaveBeenCalled();
    } finally { makerRead.mockRestore(); siteRead.mockRestore(); }
    const [source] = await db.select().from(productEvidenceSources);
    expect(source.lastSuccessAt).toEqual(now);
    expect(source.normalizedFacts).toMatchObject({ stars: 201, _githubCollection: { partial: {
      releases: phase === "releases" ? { complete: true } : { pagesRead: 0 },
    } } });
  });

  it.each(["deadline", "abort"] as const)("defers explicit %s in optional activity and completes cached core on retry without optional starvation", async stop => {
    const now = new Date("2026-08-19T00:00:00Z");
    const controller = new AbortController();
    const deadlineAt = Date.now() + 5000;
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    const base = successfulRequest();
    const request = vi.fn(async (path: string) => {
      if (!path.includes("/activity?")) return base(path);
      if (stop === "abort") controller.abort();
      else clock = vi.spyOn(Date, "now").mockReturnValue(deadlineAt + 1);
      return ok([]);
    });
    try {
      expect(await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request,
        signal: controller.signal, deadlineAt, now: () => now })).toMatchObject({ status: "budget_exhausted" });
    } finally { clock?.mockRestore(); }
    expect((await db.select().from(productEvidenceSources))[0]).toMatchObject({ lastSuccessAt: null,
      normalizedFacts: { stars: 146, _githubCollection: { partial: { releases: { complete: true } } } } });
    expect(await db.select().from(productUpdates)).toHaveLength(0);
    const retry = vi.fn(async () => { throw new Error("completed cached core must not retry optional HTTP"); });
    expect(await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: retry,
      now: () => new Date(now.getTime() + 60000) })).toEqual({ status: "updated", releases: 2 });
    expect(retry).not.toHaveBeenCalled();
    expect((await db.select().from(productEvidenceSources))[0].lastSuccessAt).toEqual(new Date(now.getTime() + 60000));
  });

  it.each([
    [10, 1, 0, false, true], [10, 2, 1, false, true], [10, 2, 2, true, true], [10, 10, 10, true, true],
    [1, 1, 0, false, true], [1, 2, 1, false, true], [1, 11, 1, false, true], [1, 12, 2, false, true], [1, 21, 2, false, true],
    [1, 2, 2, true, true], [1, 11, 2, true, true],
    [10, 100, 0, false, false], [10, 2, 0, false, false], [10, 1, 1, false, false], [10, 3, 1, true, false],
    [1, 100, 0, false, false], [1, 11, 0, false, false], [1, 3, 1, false, false], [1, 20, 1, false, false], [1, 10, 1, true, false],
  ] as const)("validates cursor perPage=%s page=%s reads=%s complete=%s (valid=%s) against its consumed offset", async (perPage, page, pagesRead, complete, valid) => {
    const now = new Date("2026-08-19T00:00:00Z");
    const base = successfulRequest();
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: base, now: () => now });
    const [source] = await db.select().from(productEvidenceSources);
    const facts = structuredClone(source.normalizedFacts!);
    const state = facts._githubCollection as { cache: Record<string, { value: unknown }>; partial: unknown };
    const release = (state.cache["/repos/owner/repo/releases?per_page=10&page=1"].value as unknown[])[0];
    const progress = { page, perPage, pagesRead, published: complete ? [release] : [], complete };
    state.partial = { startedAt: now.toISOString(), completed: Object.keys(state.cache).filter(path => !path.includes("/releases?")), releases: progress };
    await db.update(productEvidenceSources).set({ normalizedFacts: facts }).where(eq(productEvidenceSources.id, source.id));
    const request = vi.fn(async (path: string) => path.includes("/releases?")
      ? ok(valid || path.endsWith("per_page=10&page=1") ? [release] : []) : base(path));
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request, now: () => now });
    const paths = request.mock.calls.map(([path]) => path).filter(path => path.includes("/releases?"));
    expect(paths).toEqual(valid && complete ? [] : [`/repos/owner/repo/releases?per_page=${valid ? perPage : 10}&page=${valid ? page : 1}`]);
    if (!valid) expect(request.mock.calls.some(([path]) => path === "/repos/owner/repo")).toBe(true);
    expect((await db.select().from(productEvidenceSources))[0].normalizedFacts?.latestRelease).toEqual(facts.latestRelease);
    const direct = vi.fn(async () => ok([release]));
    await fetchPublishedReleases(direct, "owner/repo", () => true, { progress: progress as NonNullable<Parameters<typeof fetchPublishedReleases>[3]>["progress"] });
    expect(direct.mock.calls.length).toBe(valid && complete ? 0 : 1);
    if (direct.mock.calls.length) expect(direct).toHaveBeenCalledWith(`/repos/owner/repo/releases?per_page=${valid ? perPage : 10}&page=${valid ? page : 1}`);
  });

  it.each(["deadline", "abort"] as const)("starts no identity query when %s has already stopped the caller", async stop => {
    const controller = new AbortController();
    if (stop === "abort") controller.abort();
    const identityRead = vi.spyOn(db.query.products, "findFirst");
    try {
      expect(await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, {
        request: successfulRequest(), signal: controller.signal, deadlineAt: Date.now() + (stop === "deadline" ? -1 : 5000),
      })).toMatchObject({ status: "budget_exhausted" });
      expect(identityRead).not.toHaveBeenCalled();
    } finally { identityRead.mockRestore(); }
  });

  it.each(["deadline", "abort"] as const)("starts no source query after %s during the identity lookup", async stop => {
    const controller = new AbortController();
    const identityRead = vi.spyOn(db.query.products, "findFirst").mockImplementationOnce((async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
      return { id: 1, url: "https://product.example" } as never;
    }) as unknown as typeof db.query.products.findFirst);
    const sourceRead = vi.spyOn(db.query.productEvidenceSources, "findFirst");
    const request = successfulRequest();
    const timer = stop === "abort" ? setTimeout(() => controller.abort(), 15) : undefined;
    try {
      expect(await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, {
        request, signal: controller.signal, deadlineAt: Date.now() + (stop === "deadline" ? 15 : 5000),
      })).toMatchObject({ status: "budget_exhausted" });
      expect(sourceRead).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
      identityRead.mockRestore();
      sourceRead.mockRestore();
    }
  });

  it.each(["deadline", "abort"] as const)("starts no HTTP or write after %s during the source lookup", async stop => {
    const controller = new AbortController();
    const sourceRead = vi.spyOn(db.query.productEvidenceSources, "findFirst").mockImplementationOnce((async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
      return undefined;
    }) as typeof db.query.productEvidenceSources.findFirst);
    const request = successfulRequest();
    const timer = stop === "abort" ? setTimeout(() => controller.abort(), 15) : undefined;
    try {
      expect(await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, {
        request, signal: controller.signal, deadlineAt: Date.now() + (stop === "deadline" ? 15 : 5000),
      })).toMatchObject({ status: "budget_exhausted" });
      expect(request).not.toHaveBeenCalled();
      expect(await db.select().from(productEvidenceSources)).toHaveLength(0);
    } finally {
      clearTimeout(timer);
      sourceRead.mockRestore();
    }
  });

  it.each([
    ["startedAt", { startedAt: "invalid-date" }],
    ["completed", { completed: "not-an-array" }],
    ["completed entry", { completed: [null] }],
    ["uncached completed entry", { completed: ["/repos/owner/repo/missing"] }],
    ["releases", { releases: null }],
    ["page", { releases: { page: "1" } }],
    ["page range", { releases: { page: 0 } }],
    ["perPage", { releases: { perPage: 0 } }],
    ["pagesRead", { releases: { pagesRead: "0" } }],
    ["pagesRead range", { releases: { pagesRead: -1 } }],
    ["published", { releases: { published: {} } }],
    ["published entry", { releases: { published: [{ id: 1 }] } }],
    ["complete", { releases: { complete: "false" } }],
    ["complete without a read", { releases: { complete: true } }],
  ] as const)("restarts a malformed %s checkpoint without losing last-good facts or cache", async (_field, malformed) => {
    const now = new Date("2026-08-19T00:00:00.000Z");
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: successfulRequest(), now: () => now });
    const [source] = await db.select().from(productEvidenceSources);
    const facts = structuredClone(source.normalizedFacts!);
    const state = facts._githubCollection as { cache: Record<string, unknown>; partial: Record<string, unknown> };
    const releases = { page: 1, perPage: 10, pagesRead: 0, published: [], complete: false };
    const malformedReleases = "releases" in malformed ? malformed.releases : undefined;
    state.partial = { startedAt: now.toISOString(), completed: Object.keys(state.cache).filter(path => !path.includes("/releases?")),
      releases, ...malformed, ...(malformedReleases && { releases: { ...releases, ...malformedReleases } }) };
    await db.update(productEvidenceSources).set({ normalizedFacts: facts }).where(eq(productEvidenceSources.id, source.id));
    const original = successfulRequest();
    const request = vi.fn(async (path: string, conditional?: ConditionalRequest) => {
      if (path === "/repos/owner/repo") {
        expect(conditional?.etag).toBe('"repo-v1"');
        return { ok: false as const, error: { kind: "http" as const, status: 503 } };
      }
      return original(path);
    });
    expect(await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request, now: () => now }))
      .toMatchObject({ status: "deferred" });
    const [failed] = await db.select().from(productEvidenceSources);
    expect(failed.normalizedFacts?.latestRelease).toEqual(facts.latestRelease);
    expect((failed.normalizedFacts?._githubCollection as typeof state).cache).toEqual(state.cache);
    request.mockReset().mockImplementation(original);
    expect(await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request, now: () => now }))
      .toMatchObject({ status: "not_modified" });
    expect(request.mock.calls.some(([path]) => path.includes("/releases?"))).toBe(true);
    expect((await db.select().from(productEvidenceSources))[0].normalizedFacts?.latestRelease).toEqual(facts.latestRelease);
  });

  it("refreshes the full README after a canonical host change outside the cached host projection", async () => {
    const base = successfulRequest();
    const content = Buffer.from([
      ...Array.from({ length: 65 }, (_, index) => `https://unrelated-${index}.example`),
      "https://product.example", "https://new-product.example",
    ].join("\n")).toString("base64");
    const first = async (path: string) => path === "/repos/owner/repo" ? ok({ ...repository, homepage: null })
      : path.endsWith("/readme") ? ok({ encoding: "base64", content }, { etag: '"readme-unchanged"' }) : base(path);
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: first });
    await db.update(products).set({ url: "https://new-product.example" }).where(eq(products.slug, "github-product"));
    let reads = 0;
    const second = async (path: string, conditional?: ConditionalRequest): Promise<GitHubHttpResult<unknown>> => {
      if (!path.endsWith("/readme")) return first(path);
      if (++reads === 1) return { ok: true, status: 304, etag: '"readme-unchanged"', lastModified: null, link: null };
      expect(conditional?.etag).toBeUndefined();
      return first(path);
    };
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: second });
    expect(reads).toBe(2);
    expect((await db.select().from(productEvidenceSources))[0].normalizedFacts?.relationshipState).toBe("repository_link");
  });

  it("invalidates a confirmed absent README so site-only recomputation cannot restore its deleted link", async () => {
    const base = successfulRequest();
    const first = async (path: string) => path === "/repos/owner/repo" ? ok({ ...repository, homepage: null }) : base(path);
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: first });
    const missing = async (path: string): Promise<GitHubHttpResult<unknown>> => path.endsWith("/readme")
      ? { ok: false, error: { kind: "not_found" } } : first(path);
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: missing });
    const [source] = await db.select().from(productEvidenceSources);
    expect(source.normalizedFacts?.relationshipState).toBe("disconnected");
    const [product] = await db.select({ id: products.id }).from(products).where(eq(products.slug, "github-product"));
    await recomputeRepositoryRelationships("github-product", product.id);
    const [after] = await db.select().from(productEvidenceSources);
    expect(after.normalizedFacts?.relationshipState).toBe("maker_reported");
    const cache = after.normalizedFacts?._githubCollection as { cache: Record<string, unknown> };
    expect(cache.cache["/repos/owner/repo/readme"]).toBeUndefined();
  });

  it("ignores malformed README cache in site-only relationship computation", async () => {
    const base = successfulRequest();
    const request = async (path: string) => path === "/repos/owner/repo" ? ok({ ...repository, homepage: null }) : base(path);
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request });
    const [source] = await db.select().from(productEvidenceSources);
    const facts = structuredClone(source.normalizedFacts!);
    facts.relationshipState = "disconnected";
    const state = facts._githubCollection as { cache: Record<string, { value: Record<string, unknown> }> };
    state.cache["/repos/owner/repo/readme"].value = { encoding: "base64", content: "", canonicalHost: "product.example", linksCanonicalHost: "false" };
    await db.update(productEvidenceSources).set({ normalizedFacts: facts }).where(eq(productEvidenceSources.id, source.id));
    const [product] = await db.select({ id: products.id }).from(products).where(eq(products.slug, "github-product"));
    await recomputeRepositoryRelationships("github-product", product.id);
    expect((await db.select().from(productEvidenceSources))[0].normalizedFacts?.relationshipState).toBe("maker_reported");
  });

  it.each(["deadline", "abort"] as const)("bounds the entire GitHub request await by %s", async stop => {
    const controller = new AbortController();
    const deadline = new AbortController();
    // A monotonic deadline signal can fire before the wall clock reaches deadlineAt.
    const timeout = stop === "deadline" ? vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal) : undefined;
    const deadlineAt = Date.now() + 5000;
    let started = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finishRequest: ((result: GitHubHttpResult<unknown>) => void) | undefined;
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn((_path: string, _conditional?: ConditionalRequest, options?: { signal?: AbortSignal }): Promise<GitHubHttpResult<unknown>> => {
      started = performance.now();
      requestSignal = options?.signal;
      // Arm cancellation after DB preparation so this always exercises a pending request.
      timer = setTimeout(() => {
        if (stop === "deadline") deadline.abort(new DOMException("Deadline reached", "TimeoutError"));
        else controller.abort();
      }, 50);
      return new Promise(resolve => { finishRequest = resolve; });
    });
    try {
      expect(await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, {
        request, deadlineAt, signal: controller.signal,
      })).toMatchObject({ status: "budget_exhausted" });
      expect(request).toHaveBeenCalledTimes(1);
      expect(performance.now() - started).toBeLessThan(250);
      expect(requestSignal?.aborted).toBe(true);
      expect(requestSignal?.reason.name).toBe(stop === "deadline" ? "TimeoutError" : "AbortError");
      if (stop === "deadline") {
        expect(timeout).toHaveBeenCalledTimes(1);
        expect(controller.signal.aborted).toBe(false);
        expect(Date.now()).toBeLessThan(deadlineAt);
      }
      finishRequest?.(ok(repository));
      await request.mock.results[0].value;
      expect(await db.select().from(productEvidenceSources)).toEqual([]);
      expect(await db.select().from(productUpdates)).toEqual([]);
    } finally { clearTimeout(timer); timeout?.mockRestore(); finishRequest?.(ok(repository)); }
  });

  it.each(["checkpoint", "final"] as const)("fences %s persistence after job ownership changes", async phase => {
    const lease = { name: `evidence-${phase}`, token: "first-owner", requestedVersion: 0 };
    await db.insert(jobs).values({ name: lease.name, leaseToken: lease.token, lockedAt: new Date() });
    const base = successfulRequest();
    const request = vi.fn(async (path: string): Promise<GitHubHttpResult<unknown>> => {
      if (phase === "checkpoint" ? path === "/repos/owner/repo" : path.includes("/activity?")) {
        await db.update(jobs).set({ leaseToken: "next-owner" }).where(eq(jobs.name, lease.name));
        if (phase === "final") await upsertObservedSource({ slug: "github-product", kind: "repository", provider: "github",
          sourceKey: "owner/repo", state: "ok", normalizedFacts: { type: "github_repository", stars: 999, relationshipState: "bidirectional" } });
      }
      return base(path);
    });
    await expect(refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, {
      request, lease,
    } as Parameters<typeof refreshGitHubEvidence>[1])).rejects.toThrow("job_lease_lost");
    const sources = await db.select().from(productEvidenceSources);
    if (phase === "checkpoint") expect(sources).toEqual([]);
    else expect(sources[0].normalizedFacts).toMatchObject({ stars: 999, relationshipState: "bidirectional" });
    expect(await db.select().from(productUpdates)).toEqual([]);
  });

  it("preserves the confirmed relationship in a partial root checkpoint", async () => {
    const base = successfulRequest();
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: base });
    let remaining = true;
    const request = async (path: string) => {
      const result = await base(path);
      if (path === "/repos/owner/repo") remaining = false;
      return result;
    };
    expect(await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request, hasBudget: () => remaining }))
      .toMatchObject({ status: "budget_exhausted" });
    const [source] = await db.select().from(productEvidenceSources);
    expect(source.state).toBe("ok");
    expect(source.normalizedFacts?.relationshipState).toBe("repository_link");
  });

  it("preserves the consumed canonical README link beyond the first 64 hosts on 304", async () => {
    await replaceMakerLinks({ slug: "github-product", actor: "maker:test", links: [] });
    const base = successfulRequest();
    const first = async (path: string) => path === "/repos/owner/repo" ? ok({ ...repository, homepage: null })
      : path.endsWith("/readme") ? ok({ encoding: "base64", content: Buffer.from([
        ...Array.from({ length: 65 }, (_, index) => `https://unrelated-${index}.example`), "https://product.example",
      ].join("\n")).toString("base64") }, { etag: '"readme-v1"' }) : base(path);
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: first });
    const second = async (path: string): Promise<GitHubHttpResult<unknown>> => path.endsWith("/readme")
      ? { ok: true, status: 304, etag: '"readme-v1"', lastModified: null, link: null } : first(path);
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: second });
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: second });
    const [source] = await db.select().from(productEvidenceSources);
    expect(source.normalizedFacts?.relationshipState).toBe("repository_link");
  });

  it("sorts release dates before persisting the completed top ten checkpoint", async () => {
    const request = async (path: string) => {
      const page = Number(new URL(`https://api.github.com${path}`).searchParams.get("page"));
      return ok(Array.from({ length: page === 1 ? 5 : 10 }, (_, index) => {
        const id = (page - 1) * 5 + index + 1;
        return { id, tag_name: `v${id}`, name: `v${id}`, html_url: `https://github.com/owner/repo/releases/tag/v${id}`,
          draft: false, published_at: `2026-08-${String(id).padStart(2, "0")}T00:00:00Z` };
      }), page === 1 ? { link: '<https://api.github.com/repos/owner/repo/releases?per_page=10&page=2>; rel="next"' } : {});
    };
    const progress = { page: 1, perPage: 10, pagesRead: 0, published: [] };
    await expect(fetchPublishedReleases(request, "owner/repo", () => true, { progress, saveProgress: async checkpoint => {
      Object.assign(progress, structuredClone(checkpoint));
      if (checkpoint.complete) throw new Error("simulated interruption after checkpoint");
    } })).rejects.toThrow("simulated interruption");
    expect(progress.published[0]).toMatchObject({ id: 15 });
    const resumedRequest = vi.fn(request);
    const resumed = await fetchPublishedReleases(resumedRequest, "owner/repo", () => true, { progress });
    expect(resumed.ok && resumed.status === 200 && resumed.value[0]).toMatchObject({ id: 15 });
    expect(resumedRequest).not.toHaveBeenCalled();
  });

  it("does not evict completed core endpoints during large draft release pagination", async () => {
    const base = successfulRequest();
    let remaining = true;
    const request = async (path: string) => {
      if (!path.includes("/releases?")) return base(path);
      const page = Number(new URL(`https://api.github.com${path}`).searchParams.get("page"));
      if (page === 5) remaining = false;
      return ok(Array.from({ length: 10 }, (_, index) => ({ id: page * 10 + index,
        tag_name: "t".repeat(160), name: "n".repeat(500), html_url: `https://github.com/owner/repo/${"x".repeat(900)}`,
        draft: true, published_at: null })), { link: `<https://api.github.com/repos/owner/repo/releases?per_page=10&page=${page + 1}>; rel="next"` });
    };
    expect(await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request, hasBudget: () => remaining }))
      .toMatchObject({ status: "budget_exhausted" });
    const resumed = vi.fn(async (path: string) => base(path));
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: resumed });
    expect(resumed.mock.calls.map(([path]) => path)).toEqual([
      "/repos/owner/repo/releases?per_page=10&page=6", "/repos/owner/repo/activity?time_period=week&per_page=100&direction=desc",
    ]);
  });

  it("retains newly completed root facts when unused nested metadata exceeds the cache budget", async () => {
    const base = successfulRequest();
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: base });
    let remaining = true;
    const request = async (path: string) => {
      if (path !== "/repos/owner/repo") return base(path);
      remaining = false;
      return ok({ ...repository, stargazers_count: 321, license: { ...repository.license, unused: "x".repeat(30 * 1024) } });
    };
    expect(await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request, hasBudget: () => remaining }))
      .toMatchObject({ status: "budget_exhausted" });
    const resumed = vi.fn(async (path: string) => base(path));
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: resumed });
    expect(resumed.mock.calls.some(([path]) => path === "/repos/owner/repo")).toBe(false);
    expect((await db.select().from(productEvidenceSources))[0].normalizedFacts?.stars).toBe(321);
  });


  it.each([
    ["archived", { archived: "false" }], ["fork", { fork: "false" }], ["pushed_at", { pushed_at: 42 }],
    ["homepage", { homepage: 42 }], ["license", { license: { name: 42, spdx_id: null, url: null } }], ["id", { id: 0 }],
  ])("retains last-good root facts and cache when %s is malformed", async (_field, malformed) => {
    const base = successfulRequest();
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: base });
    const [before] = await db.select().from(productEvidenceSources);
    const request = async (path: string) => path === "/repos/owner/repo" ? ok({ ...repository, ...malformed }, { etag: '"bad"' }) : base(path);
    expect(await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request })).toMatchObject({ status: "deferred" });
    const [after] = await db.select().from(productEvidenceSources);
    expect(after.normalizedFacts).toEqual(before.normalizedFacts);
    expect(after.lastErrorCode).toBe("invalid_response");
  });

  it.each(["payload", "etag", "lastModified", "link"])("retries a 304 unconditionally when cached root %s is malformed", async field => {
    const base = successfulRequest();
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: base });
    const [source] = await db.select().from(productEvidenceSources);
    const facts = structuredClone(source.normalizedFacts!);
    const state = facts._githubCollection as { cache: Record<string, Record<string, unknown>> };
    state.cache["/repos/owner/repo"][field === "payload" ? "value" : field] = field === "payload" ? { ...repository, archived: "false" } : 42;
    await db.update(productEvidenceSources).set({ normalizedFacts: facts }).where(eq(productEvidenceSources.id, source.id));
    let roots = 0;
    const request = async (path: string): Promise<GitHubHttpResult<unknown>> => path === "/repos/owner/repo" && ++roots === 1
      ? { ok: true, status: 304, etag: null, lastModified: null, link: null } : base(path);
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request });
    expect(roots).toBe(2);
    expect((await db.select().from(productEvidenceSources))[0].normalizedFacts).toMatchObject({ archived: false, fork: false });
  });

  it("sends endpoint-specific validators and reuses each last-good payload on 304", async () => {
    const base = successfulRequest();
    const firstRequest = vi.fn(async (path: string): Promise<GitHubHttpResult<unknown>> => {
      const result = await base(path);
      return result.ok ? { ...result, etag: `"${path}"`, lastModified: "Wed, 19 Aug 2026 00:00:00 GMT" } : result;
    });
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: firstRequest });
    const nextRequest = vi.fn(async (path: string, conditional?: ConditionalRequest): Promise<GitHubHttpResult<unknown>> => {
      if (path.includes("/activity?")) return { ok: false, error: { kind: "not_found" } };
      expect(conditional?.etag).toBe(`"${path}"`);
      return { ok: true, status: 304, etag: `"${path}"`, lastModified: null, link: null };
    });
    await expect(refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, {
      request: nextRequest,
    })).resolves.toEqual({ status: "not_modified", releases: 0 });
    expect(nextRequest.mock.calls.filter(([path]) => !path.includes("/activity?"))).toHaveLength(5);
    const [source] = await db.select().from(productEvidenceSources);
    expect(source.normalizedFacts).toMatchObject({ stars: 146, latestRelease: { id: 2 } });
  });

  it("retries a cacheless 304 unconditionally before considering an endpoint complete", async () => {
    const base = successfulRequest();
    const seen = new Set<string>();
    const request = vi.fn(async (path: string, conditional?: ConditionalRequest): Promise<GitHubHttpResult<unknown>> => {
      if (path.includes("/activity?")) return base(path);
      if (!seen.has(path)) {
        seen.add(path);
        return { ok: true, status: 304, etag: '"orphan"', lastModified: null, link: null };
      }
      expect(conditional?.etag).toBeUndefined();
      return base(path);
    });
    await expect(refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request }))
      .resolves.toEqual({ status: "updated", releases: 2 });
    expect(request.mock.calls.filter(([path]) => !path.includes("/activity?"))).toHaveLength(10);
  });

  it("does not cache a malformed supporting payload as a last-good endpoint", async () => {
    const base = successfulRequest();
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: base });
    const bad = vi.fn(async (path: string): Promise<GitHubHttpResult<unknown>> =>
      path.endsWith("/languages") ? ok({ TypeScript: "invalid" }, { etag: '"bad"' }) : base(path));
    await expect(refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: bad }))
      .resolves.toMatchObject({ status: "deferred" });
    const [source] = await db.select().from(productEvidenceSources);
    expect(source.lastErrorCode).toBe("invalid_response");
    expect(source.normalizedFacts?.languages).toEqual(expect.arrayContaining([expect.objectContaining({ name: "TypeScript", bytes: 700 })]));
    const saved = source.normalizedFacts?._githubCollection as { cache: Record<string, { etag: string | null }> };
    expect(saved.cache["/repos/owner/repo/languages"].etag).not.toBe('"bad"');
    expect(bad.mock.calls.map(([path]) => path)).toEqual(["/repos/owner/repo", "/repos/owner/repo/languages"]);
  });

  it("does not report changed public facts for internal endpoint-validator changes", async () => {
    const base = successfulRequest();
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request: base });
    const changedValidators = async (path: string): Promise<GitHubHttpResult<unknown>> => {
      const result = await base(path);
      return result.ok ? { ...result, etag: '"validator-v2"' } : result;
    };
    const result = await refreshProductEvidence("github-product", { force: true, dependencies: {
      github: (input, options) => refreshGitHubEvidence(input, { ...options, request: changedValidators }),
    } });
    expect(result.factsChanged).toBe(0);
  });

  it("passes the same deadline into every GitHub request, including resumed release pages and activity", async () => {
    const base = successfulRequest();
    const deadlineAt = Date.now() + 5_000;
    const request = vi.fn(async (path: string, _conditional?: ConditionalRequest, options?: { deadlineAt?: number }) => {
      expect(options?.deadlineAt).toBe(deadlineAt);
      return base(path);
    });
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" },
      { request, deadlineAt } as Parameters<typeof refreshGitHubEvidence>[1]);
    expect(request).toHaveBeenCalledTimes(6);
  });

  it("keeps completed core facts when the job budget expires during optional push pagination", async () => {
    const baseRequest = successfulRequest();
    let remaining = true;
    const request = async (path: string): Promise<GitHubHttpResult<unknown>> => {
      if (!path.includes("/activity?")) return baseRequest(path);
      remaining = false;
      return ok([{ id: 1, activity_type: "push", timestamp: "2026-08-18T00:00:00Z" }], {
        link: '<https://api.github.com/repos/owner/repo/activity?after=next>; rel="next"',
      });
    };
    await expect(refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, {
      request, now: () => new Date("2026-08-19T00:00:00Z"), hasBudget: () => remaining,
    })).resolves.toEqual({ status: "updated", releases: 2 });
    const [source] = await db.select().from(productEvidenceSources);
    expect(source.normalizedFacts).toMatchObject({ stars: 146, pushActivity: null });
    expect(source.lastSuccessAt).toEqual(new Date("2026-08-19T00:00:00Z"));
    expect(await db.select().from(productUpdates)).toHaveLength(2);
  });

  it("resumes the next release page after a budget stop without fetching completed core endpoints again", async () => {
    const baseRequest = successfulRequest();
    let remaining = true;
    const request = vi.fn(async (path: string): Promise<GitHubHttpResult<unknown>> => {
      if (path.includes("/releases") && path.endsWith("page=1")) {
        remaining = false;
        return ok([], { link: '<https://api.github.com/repos/owner/repo/releases?per_page=10&page=2>; rel="next"' });
      }
      return baseRequest(path);
    });
    const firstAt = new Date("2026-08-19T00:00:00Z");
    await expect(refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, {
      request, now: () => firstAt, hasBudget: () => remaining,
    })).resolves.toEqual({ status: "budget_exhausted", releases: 0 });
    const [partial] = await db.select().from(productEvidenceSources);
    expect(partial.normalizedFacts).toMatchObject({ stars: 146,
      languages: expect.arrayContaining([expect.objectContaining({ name: "TypeScript" })]) });
    expect(partial.lastSuccessAt).toBeNull();
    request.mockClear();
    remaining = true;
    await expect(refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, {
      request, now: () => new Date(firstAt.getTime() + 60_000), hasBudget: () => remaining,
    })).resolves.toEqual({ status: "updated", releases: 2 });
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/repos/owner/repo/releases?per_page=10&page=2",
      "/repos/owner/repo/activity?time_period=week&per_page=100&direction=desc",
    ]);
  });

  it("stores complete weekly push counts without treating an optional activity failure as zero", async () => {
    const now = new Date("2026-08-19T00:00:00.000Z");
    await upsertObservedSource({ slug: "github-product", kind: "repository", provider: "github", sourceKey: "owner/repo", state: "ok", etag: '"legacy"',
      normalizedFacts: mapGitHubRepositoryFacts({ repository, languages: {}, contributors: { items: [], link: null }, releases: [] }),
    });
    const baseRequest = successfulRequest();
    const request = async (path: string, conditional?: ConditionalRequest): Promise<GitHubHttpResult<unknown>> => {
      if (path === "/repos/owner/repo") return conditional?.etag
        ? { ok: true, status: 304, etag: '"legacy"', lastModified: null, link: null }
        : ok({ ...repository, id: 123 });
      if (path.startsWith("/repositories/123/activity?")) return ok([
        { id: 2, activity_type: "force_push", timestamp: "2026-08-17T00:00:00Z" },
      ]);
      if (path.includes("/activity?")) return ok([
        { id: 1, activity_type: "push", timestamp: "2026-08-18T00:00:00Z" },
        { id: 3, activity_type: "pr_merge", timestamp: "2026-08-17T00:00:00Z" },
      ], { link: '<https://api.github.com/repositories/123/activity?after=next>; rel="next"' });
      return baseRequest(path);
    };
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, { request, now: () => now });
    const [source] = await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.kind, "repository"));
    expect(source.normalizedFacts?.pushActivity).toEqual({
      count: 2, since: "2026-08-12T00:00:00.000Z", observedAt: now.toISOString(),
    });
    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, {
      request: baseRequest, now: () => new Date("2026-08-20T00:00:00Z"),
    });
    const [afterFailure] = await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.kind, "repository"));
    expect(afterFailure.state).toBe("ok");
    expect(afterFailure.normalizedFacts?.pushActivity).toBeNull();
  });

  it("does not duplicate a canonical release that an RSS feed observed first", async () => {
    const observedAt = new Date("2026-08-19T00:00:00.000Z");
    await insertUpdateCandidates("github-product", [{
      sourceKind: "feed",
      dedupeKey: "feed-v1.1.0",
      canonicalUrl: "https://github.com/Owner/Repo/releases/tag/v1.1.0?source=rss",
      title: "Version 1.1.0 released",
      summary: "Feed observation",
      beforeAfter: null,
      publishedAt: new Date("2026-08-17T00:00:00.000Z"),
      observedAt,
    }]);

    await expect(refreshGitHubEvidence({
      slug: "github-product",
      repository: "owner/repo",
    }, { request: successfulRequest(), now: () => observedAt })).resolves.toEqual({
      status: "updated",
      releases: 1,
    });

    const updates = await db.select().from(productUpdates).where(eq(productUpdates.slug, "github-product"));
    expect(updates).toHaveLength(2);
    expect(updates.filter((update) => update.canonicalUrl?.includes("v1.1.0"))).toHaveLength(1);
  });

  it("stores normalized facts/releases, retains license conflict, and advances 304 freshness", async () => {
    const request = successfulRequest();
    const firstNow = new Date("2026-08-19T00:00:00.000Z");
    await upsertObservedSource({
      slug: "github-product",
      kind: "documentation",
      provider: "product_site",
      sourceKey: "https://product.example",
      state: "ok",
      normalizedFacts: { type: "site_fingerprint", repositoryKeys: ["owner/repo"] },
    });
    const first = await refreshGitHubEvidence({
      slug: "github-product",
      repository: "owner/repo",
    }, { request, now: () => firstNow });
    expect(first).toEqual({ status: "updated", releases: 2 });

    const [profile] = await db.select().from(productProfiles).where(eq(productProfiles.slug, "github-product"));
    let [source] = await db.select().from(productEvidenceSources).where(and(
      eq(productEvidenceSources.slug, "github-product"),
      eq(productEvidenceSources.kind, "repository"),
    ));
    let updates = await db.select().from(productUpdates).where(eq(productUpdates.slug, "github-product"));
    expect(profile.makerLicense).toEqual({ value: "MIT", spdxId: "MIT" });
    expect(source).toMatchObject({
      state: "ok",
      etag: '"repo-v1"',
      normalizedFacts: {
        type: "github_repository",
        stars: 146,
        forks: 12,
        contributors: { count: 2, incomplete: false },
        relationshipState: "bidirectional",
        license: { spdxId: "Apache-2.0" },
      },
    });
    expect(updates).toHaveLength(2);
    expect(updates.every((update) => update.dedupeKey.startsWith("release:"))).toBe(true);
    expect(updates.map((update) => update.canonicalUrl).sort()).toEqual([
      "https://github.com/owner/repo/releases/tag/v1.0.0",
      "https://github.com/owner/repo/releases/tag/v1.1.0",
    ]);

    const secondNow = new Date("2026-08-19T06:00:00.000Z");
    const supportingRequest = successfulRequest();
    request.mockReset().mockImplementation(async (path: string) => (
      path === "/repos/owner/repo"
        ? { ok: true, status: 304, etag: '"repo-v1"', lastModified: null, link: null }
        : supportingRequest(path)
    ));
    const second = await refreshGitHubEvidence({
      slug: "github-product",
      repository: "owner/repo",
    }, { request, now: () => secondNow });
    expect(second).toEqual({ status: "not_modified", releases: 0 });

    [source] = await db.select().from(productEvidenceSources).where(and(
      eq(productEvidenceSources.slug, "github-product"),
      eq(productEvidenceSources.kind, "repository"),
    ));
    updates = await db.select().from(productUpdates).where(eq(productUpdates.slug, "github-product"));
    expect(source.lastSuccessAt).toEqual(secondNow);
    expect(source.normalizedFacts).toMatchObject({ stars: 146, license: { spdxId: "Apache-2.0" } });
    expect(updates).toHaveLength(2);
  });

  it("marks 404 disconnected while preserving the last-known-good facts", async () => {
    const request = successfulRequest();
    await refreshGitHubEvidence({
      slug: "github-product",
      repository: "owner/repo",
    }, { request, now: () => new Date("2026-08-19T00:00:00.000Z") });
    request.mockReset().mockResolvedValue({ ok: false, error: { kind: "not_found" } });

    await expect(refreshGitHubEvidence({
      slug: "github-product",
      repository: "owner/repo",
    }, { request, now: () => new Date("2026-08-19T06:00:00.000Z") })).resolves.toEqual({
      status: "disconnected",
      releases: 0,
    });

    const [source] = await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug, "github-product"));
    expect(source.state).toBe("disconnected");
    expect(source.normalizedFacts).toMatchObject({ stars: 146 });
  });

  it("keeps collecting repository facts when the optional README is absent", async () => {
    const baseRequest = successfulRequest();
    const request = vi.fn(async (path: string): Promise<GitHubHttpResult<unknown>> => {
      if (path === "/repos/owner/repo") return ok({ ...repository, homepage: null });
      if (path.endsWith("/readme")) return { ok: false, error: { kind: "not_found" } };
      return baseRequest(path);
    });

    await expect(refreshGitHubEvidence({
      slug: "github-product",
      repository: "owner/repo",
    }, { request, now: () => new Date("2026-08-19T00:00:00.000Z") })).resolves.toEqual({
      status: "updated",
      releases: 2,
    });

    const [source] = await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug, "github-product"));
    expect(source).toMatchObject({
      state: "ok",
      normalizedFacts: {
        stars: 146,
        relationshipState: "maker_reported",
      },
    });
  });

  it("rejects private repository metadata before fetching or persisting supporting facts", async () => {
    const baseRequest = successfulRequest();
    const request = vi.fn(async (path: string): Promise<GitHubHttpResult<unknown>> => (
      path === "/repos/owner/repo"
        ? ok({ ...repository, private: true })
        : baseRequest(path)
    ));

    await expect(refreshGitHubEvidence({
      slug: "github-product",
      repository: "owner/repo",
    }, { request })).resolves.toEqual({ status: "disconnected", releases: 0 });

    const [source] = await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug, "github-product"));
    expect(source).toMatchObject({ state: "disconnected", normalizedFacts: null });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("polls releases after a repository 304 and advances the latest release atomically", async () => {
    await refreshGitHubEvidence({
      slug: "github-product",
      repository: "owner/repo",
    }, { request: successfulRequest(), now: () => new Date("2026-08-19T00:00:00.000Z") });

    const baseRequest = successfulRequest();
    const nextRelease = {
      id: 3,
      tag_name: "v1.2.0",
      name: "v1.2.0",
      html_url: "https://github.com/Owner/Repo/releases/tag/v1.2.0",
      published_at: "2026-08-19T01:00:00Z",
      draft: false,
    };
    const request = vi.fn(async (path: string): Promise<GitHubHttpResult<unknown>> => {
      if (path === "/repos/owner/repo") {
        return { ok: true, status: 304, etag: '"repo-v1"', lastModified: null, link: null };
      }
      if (path.includes("/releases")) return ok([nextRelease]);
      return baseRequest(path);
    });

    await expect(refreshGitHubEvidence({
      slug: "github-product",
      repository: "owner/repo",
    }, { request, now: () => new Date("2026-08-19T06:00:00.000Z") })).resolves.toEqual({
      status: "updated",
      releases: 1,
    });

    const [source] = await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug, "github-product"));
    const updates = await db.select().from(productUpdates).where(eq(productUpdates.slug, "github-product"));
    expect(source.normalizedFacts).toMatchObject({ latestRelease: { id: 3, tagName: "v1.2.0" } });
    expect(updates).toHaveLength(3);
    expect(updates.every((update) => update.dedupeKey.startsWith("release:"))).toBe(true);
    expect(updates.map((update) => update.canonicalUrl).sort()).toEqual([
      "https://github.com/owner/repo/releases/tag/v1.0.0",
      "https://github.com/owner/repo/releases/tag/v1.1.0",
      "https://github.com/owner/repo/releases/tag/v1.2.0",
    ]);
  });

  it("reports only newly inserted releases on repeated 200 responses", async () => {
    await refreshGitHubEvidence({
      slug: "github-product",
      repository: "owner/repo",
    }, { request: successfulRequest() });

    await expect(refreshGitHubEvidence({
      slug: "github-product",
      repository: "owner/repo",
    }, { request: successfulRequest() })).resolves.toMatchObject({ releases: 0 });
  });

  it("rolls back source validators when release persistence fails", async () => {
    await db.execute(sql.raw('alter table "product_updates" rename column "title" to "title_disabled"'));
    try {
      await expect(refreshGitHubEvidence({
        slug: "github-product",
        repository: "owner/repo",
      }, { request: successfulRequest() })).rejects.toThrow();

      const sources = await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug, "github-product"));
      expect(sources.every(source => source.lastSuccessAt === null)).toBe(true);
      expect(sources.every(source => source.etag === null)).toBe(true);
    } finally {
      await db.execute(sql.raw('alter table "product_updates" rename column "title_disabled" to "title"'));
    }
  });

  it("loads canonical URL and site-link observations from authoritative database rows", async () => {
    await upsertObservedSource({
      slug: "github-product",
      kind: "documentation",
      provider: "product_site",
      sourceKey: "https://product.example",
      state: "ok",
      normalizedFacts: {
        type: "site_fingerprint",
        repositoryKeys: ["owner/repo"],
      },
    });
    const baseRequest = successfulRequest();
    const request = vi.fn(async (path: string): Promise<GitHubHttpResult<unknown>> => {
      if (path === "/repos/owner/repo") return ok({ ...repository, homepage: null });
      if (path.endsWith("/readme")) return { ok: false, error: { kind: "not_found" } };
      return baseRequest(path);
    });

    await refreshGitHubEvidence({
      slug: "github-product",
      repository: "owner/repo",
    }, { request });

    const source = await db.query.productEvidenceSources.findFirst({
      where: (table, { and, eq }) => and(
        eq(table.slug, "github-product"),
        eq(table.kind, "repository"),
      ),
    });
    expect(source?.normalizedFacts).toMatchObject({ relationshipState: "site_link" });
  });

  it("walks bounded release pages until ten published releases are collected", async () => {
    const baseRequest = successfulRequest();
    const published = (id: number) => ({
      id,
      tag_name: `v${id}`,
      name: `v${id}`,
      html_url: `https://github.com/Owner/Repo/releases/tag/v${id}`,
      published_at: `2026-08-${String(id).padStart(2, "0")}T00:00:00Z`,
      draft: false,
    });
    const draft = (id: number) => ({ ...published(id), id: 1_000 + id, draft: true });
    const request = vi.fn(async (path: string): Promise<GitHubHttpResult<unknown>> => {
      if (path.includes("/releases") && path.includes("page=2")) {
        return ok([6, 7, 8, 9, 10].map(published));
      }
      if (path.includes("/releases")) {
        return ok([
          ...Array.from({ length: 5 }, (_, index) => draft(index + 1)),
          ...[1, 2, 3, 4, 5].map(published),
        ], {
          link: '<https://api.github.com/repos/owner/repo/releases?per_page=10&page=2>; rel="next", <https://api.github.com/repos/owner/repo/releases?per_page=10&page=2>; rel="last"',
        });
      }
      return baseRequest(path);
    });

    await expect(refreshGitHubEvidence({
      slug: "github-product",
      repository: "owner/repo",
    }, { request })).resolves.toEqual({ status: "updated", releases: 10 });
    expect(request.mock.calls.filter(([path]) => String(path).includes("/releases")).map(([path]) => path)).toEqual([
      "/repos/owner/repo/releases?per_page=10&page=1",
      "/repos/owner/repo/releases?per_page=10&page=2",
    ]);
  });

  it("stops release pagination when the enclosing job budget expires", async () => {
    const baseRequest = successfulRequest();
    let releaseRequests = 0;
    const request = vi.fn(async (path: string): Promise<GitHubHttpResult<unknown>> => {
      if (!path.includes("/releases")) return baseRequest(path);
      releaseRequests += 1;
      return ok([], {
        link: releaseRequests === 1
          ? '<https://api.github.com/repos/owner/repo/releases?per_page=10&page=2>; rel="next"'
          : undefined,
      });
    });

    await expect(refreshGitHubEvidence({
      slug: "github-product",
      repository: "owner/repo",
    }, {
      request,
      hasBudget: () => releaseRequests < 1,
    })).resolves.toEqual({ status: "budget_exhausted", releases: 0 });
    expect(releaseRequests).toBe(1);
  });

  it.each([
    [{ kind: "rate_limited", resetAt: new Date("2026-08-19T07:00:00.000Z") }, "rate_limited"],
    [{ kind: "http", status: 500 }, "http_500"],
  ] as const)("preserves facts on provider failure and logs no token/body (%s)", async (error, code) => {
    const request = successfulRequest();
    await refreshGitHubEvidence({
      slug: "github-product",
      repository: "owner/repo",
    }, { request, now: () => new Date("2026-08-19T00:00:00.000Z") });
    request.mockReset().mockResolvedValue({ ok: false, error });
    const log = vi.fn();

    await refreshGitHubEvidence({
      slug: "github-product",
      repository: "owner/repo",
    }, {
      request,
      now: () => new Date("2026-08-19T06:00:00.000Z"),
      log,
    });

    const [source] = await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug, "github-product"));
    expect(source.state).toBe("failed");
    expect(source.lastErrorCode).toBe(code);
    expect(source.normalizedFacts).toMatchObject({ stars: 146 });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/test-token|Live service|https?:\/\//i);
  });

  it("schedules GitHub evidence after the auth-pool retry time", async () => {
    const resetAt = new Date("2026-08-19T07:00:00.000Z");
    const request = vi.fn().mockResolvedValue({ ok: false,
      error: { kind: "auth_unavailable", reason: "expired", resetAt } });

    await refreshGitHubEvidence({ slug: "github-product", repository: "owner/repo" }, {
      request, now: () => new Date("2026-08-19T06:00:00.000Z"),
    });

    const [source] = await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug, "github-product"));
    expect(source).toMatchObject({ state: "failed", lastErrorCode: "auth_unavailable", nextAttemptAt: resetAt });
  });
});
