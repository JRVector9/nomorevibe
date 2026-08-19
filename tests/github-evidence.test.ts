import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubRequest } from "@/lib/crawl/github";
import {
  CONTRIBUTOR_COUNT_CAP,
  mapGitHubRepositoryFacts,
} from "@/lib/domain/evidence/providers/github";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv("GITHUB_TOKEN", "test-token");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("conditional GitHub HTTP", () => {
  it("sends validators and exposes 200 response metadata", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ full_name: "Owner/Repo" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        etag: '"etag-2"',
        "last-modified": "Wed, 19 Aug 2026 00:00:00 GMT",
        link: '<https://api.github.com/items?page=2>; rel="next"',
      },
    }));

    const result = await githubRequest<{ full_name: string }>("/repos/Owner/Repo", {
      etag: '"etag-1"',
      lastModified: "Tue, 18 Aug 2026 00:00:00 GMT",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/Owner/Repo",
      expect.objectContaining({
        headers: expect.objectContaining({
          "If-None-Match": '"etag-1"',
          "If-Modified-Since": "Tue, 18 Aug 2026 00:00:00 GMT",
        }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      status: 200,
      value: { full_name: "Owner/Repo" },
      etag: '"etag-2"',
      lastModified: "Wed, 19 Aug 2026 00:00:00 GMT",
      link: '<https://api.github.com/items?page=2>; rel="next"',
    });
  });

  it("returns 304 without parsing a body and keeps response validators", async () => {
    fetchMock.mockResolvedValue(new Response(null, {
      status: 304,
      headers: { etag: '"etag-1"' },
    }));

    await expect(githubRequest("/repos/owner/repo", { etag: '"etag-1"' })).resolves.toEqual({
      ok: true,
      status: 304,
      etag: '"etag-1"',
      lastModified: null,
      link: null,
    });
  });

  it("preserves not-found, rate-limit, and transient HTTP failures", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, {
        status: 429,
        headers: { "x-ratelimit-reset": "1787137200" },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));

    await expect(githubRequest("/repos/o/missing")).resolves.toEqual({
      ok: false,
      error: { kind: "not_found" },
    });
    await expect(githubRequest("/repos/o/limited")).resolves.toEqual({
      ok: false,
      error: { kind: "rate_limited", resetAt: new Date(1_787_137_200_000) },
    });
    await expect(githubRequest("/repos/o/flaky")).resolves.toEqual({
      ok: false,
      error: { kind: "http", status: 500 },
    });
  });

  it("returns typed failures for transport and invalid JSON responses", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("test-token network body"))
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }));

    await expect(githubRequest("/repos/o/network")).resolves.toEqual({
      ok: false,
      error: { kind: "transport" },
    });
    await expect(githubRequest("/repos/o/invalid")).resolves.toEqual({
      ok: false,
      error: { kind: "invalid_response" },
    });
  });

  it("rejects declared and streamed GitHub response bodies above the cap", async () => {
    const oversized = 2 * 1024 * 1024 + 1;
    fetchMock
      .mockResolvedValueOnce(new Response("{}", {
        status: 200,
        headers: { "content-length": String(oversized) },
      }))
      .mockResolvedValueOnce(new Response(Buffer.alloc(oversized, 32), { status: 200 }));

    await expect(githubRequest("/repos/o/declared-large")).resolves.toEqual({
      ok: false,
      error: { kind: "invalid_response" },
    });
    await expect(githubRequest("/repos/o/streamed-large")).resolves.toEqual({
      ok: false,
      error: { kind: "invalid_response" },
    });
  });

  it("maps an empty-repository contributor 204 to an empty collection", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(githubRequest("/repos/o/empty/contributors?per_page=1")).resolves.toEqual({
      ok: true,
      status: 200,
      value: [],
      etag: null,
      lastModified: null,
      link: null,
    });
  });
});

describe("GitHub repository fact mapping", () => {
  it("maps objective repository facts, language bytes, identified contributors, and latest release", () => {
    const facts = mapGitHubRepositoryFacts({
      repository: {
        html_url: "https://github.com/Owner/Repo",
        full_name: "Owner/Repo",
        created_at: "2024-01-02T03:04:05Z",
        pushed_at: "2026-08-18T12:00:00Z",
        updated_at: "2026-08-18T13:00:00Z",
        stargazers_count: 146,
        forks_count: 12,
        private: false,
        archived: true,
        fork: false,
        homepage: "https://product.example",
        license: {
          name: "MIT License",
          spdx_id: "MIT",
          url: "https://api.github.com/licenses/mit",
        },
      },
      languages: { TypeScript: 700, Rust: 300 },
      contributors: {
        items: [{ login: "maker" }],
        link: '<https://api.github.com/repos/Owner/Repo/contributors?per_page=1&page=146>; rel="last"',
      },
      releases: [
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
      ],
    });

    expect(facts).toMatchObject({
      type: "github_repository",
      repositoryKey: "owner/repo",
      repositoryUrl: "https://github.com/Owner/Repo",
      createdAt: "2024-01-02T03:04:05.000Z",
      pushedAt: "2026-08-18T12:00:00.000Z",
      updatedAt: "2026-08-18T13:00:00.000Z",
      stars: 146,
      forks: 12,
      public: true,
      archived: true,
      fork: false,
      homepage: "https://product.example",
      contributors: { count: 146, incomplete: false, cap: CONTRIBUTOR_COUNT_CAP },
      license: { value: "MIT License", spdxId: "MIT", url: "https://api.github.com/licenses/mit" },
      languages: [
        { name: "TypeScript", bytes: 700, percent: 70 },
        { name: "Rust", bytes: 300, percent: 30 },
      ],
      latestRelease: {
        id: 2,
        tagName: "v1.1.0",
        name: "v1.1.0",
        url: "https://github.com/Owner/Repo/releases/tag/v1.1.0",
        publishedAt: "2026-08-17T00:00:00.000Z",
      },
    });
  });

  it("caps contributor claims and marks them incomplete", () => {
    const facts = mapGitHubRepositoryFacts({
      repository: {
        html_url: "https://github.com/o/r",
        full_name: "o/r",
        created_at: "2024-01-01T00:00:00Z",
        pushed_at: null,
        updated_at: "2024-01-01T00:00:00Z",
        stargazers_count: 0,
        forks_count: 0,
        private: true,
        archived: false,
        fork: false,
        homepage: null,
        license: null,
      },
      languages: {},
      contributors: {
        items: [{ login: "one" }],
        link: '<https://api.github.com/repos/o/r/contributors?per_page=1&page=900>; rel="last"',
      },
      releases: [],
    });

    expect(facts.public).toBe(false);
    expect(facts.contributors).toEqual({
      count: CONTRIBUTOR_COUNT_CAP,
      incomplete: true,
      cap: CONTRIBUTOR_COUNT_CAP,
    });
    expect(facts.latestRelease).toBeNull();
  });
});
