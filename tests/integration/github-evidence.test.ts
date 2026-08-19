import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  productEvidenceSources,
  productProfiles,
  products,
  productUpdates,
} from "@/lib/db/schema";
import type { GitHubHttpResult } from "@/lib/crawl/github";
import { refreshGitHubEvidence } from "@/lib/domain/evidence/providers/github";
import {
  replaceMakerLinks,
  saveMakerProfile,
  upsertObservedSource,
} from "@/lib/domain/evidence/repository";
import { insertUpdateCandidates } from "@/lib/domain/evidence/updates";
import { ensureSchema, resetTables } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
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
    throw new Error(`unexpected path: ${path}`);
  });
}

describe("GitHub evidence refresh", () => {
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
      expect(sources).toHaveLength(0);
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
          ...Array.from({ length: 10 }, (_, index) => draft(index + 1)),
          ...[1, 2, 3, 4, 5].map(published),
        ], {
          link: '<https://api.github.com/repos/owner/repo/releases?per_page=100&page=2>; rel="next", <https://api.github.com/repos/owner/repo/releases?per_page=100&page=2>; rel="last"',
        });
      }
      return baseRequest(path);
    });

    await expect(refreshGitHubEvidence({
      slug: "github-product",
      repository: "owner/repo",
    }, { request })).resolves.toEqual({ status: "updated", releases: 10 });
    expect(request.mock.calls.filter(([path]) => String(path).includes("/releases"))).toHaveLength(2);
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
});
