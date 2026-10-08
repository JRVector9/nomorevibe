import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkRepositories, mapRepositoryBatch, repositoryBatchQuery, REPOSITORY_BATCH } from "@/lib/crawl/github-repositories";
import { githubResource } from "@/lib/crawl/github-quota";

const quota = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@/lib/crawl/github-quota", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/crawl/github-quota")>(),
  readGitHubCooldown: async () => null,
  readGitHubAuthCooldown: async () => null,
  recordGitHubCooldown: async (token: string, resource: string, cooldown: { retryAt: Date }) => {
    quota.record(token, resource, cooldown); return cooldown.retryAt;
  },
}));

beforeEach(() => vi.stubEnv("GITHUB_TOKEN", "test-token"));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); quota.record.mockClear(); });

const repos = [
  { owner: "acme", name: "alive" }, { owner: "acme", name: "gone" }, { owner: "acme", name: "empty" },
  { owner: "acme", name: "archived" }, { owner: "acme", name: "disabled" }, { owner: "acme", name: "forbidden" },
  { owner: "twitter", name: "bootstrap" }, { owner: "acme", name: "flaky" }, { owner: "Acme", name: "Case" },
];
const node = (nameWithOwner: string, extra: Record<string, unknown> = {}) => ({
  nameWithOwner, isArchived: false, isEmpty: false, isDisabled: false, isLocked: false, pushedAt: "2026-10-07T03:54:23Z",
  stargazerCount: 12, defaultBranchRef: { name: "main" }, owner: { __typename: "Organization" }, ...extra,
});

describe("저장소 묶음 질의", () => {
  it("별칭마다 같은 조각을 묻고 rateLimit 을 함께 받는다", () => {
    const query = repositoryBatchQuery([{ owner: "acme", name: "app.js" }, { owner: "a-b", name: "c_d" }]);
    expect(query).toContain('r0: repository(owner: "acme", name: "app.js") { ...R }');
    expect(query).toContain('r1: repository(owner: "a-b", name: "c_d") { ...R }');
    expect(query).toContain("rateLimit { cost remaining resetAt }");
    expect(query).toContain("fragment R on Repository { nameWithOwner isArchived isEmpty isDisabled isLocked pushedAt stargazerCount");
  });

  it("질의를 깨뜨릴 수 있는 이름과 묶음 상한을 넘는 묶음은 받지 않는다", () => {
    expect(() => repositoryBatchQuery([{ owner: 'acme") { x } y: repository(owner: "z', name: "a" }])).toThrow("repository_batch_name");
    expect(() => repositoryBatchQuery([])).toThrow("repository_batch_size");
    expect(() => repositoryBatchQuery(Array.from({ length: REPOSITORY_BATCH + 1 }, (_, i) => ({ owner: "a", name: `r${i}` })))).toThrow("repository_batch_size");
  });

  it("없음·빈 저장소·보관·비활성·접근 금지·이름 바뀜·그 밖의 오류를 가른다", () => {
    const data = {
      r0: node("acme/alive"), r1: null, r2: node("acme/empty", { isEmpty: true, defaultBranchRef: null, pushedAt: null, stargazerCount: 0 }),
      r3: node("acme/archived", { isArchived: true, pushedAt: "2023-01-03T10:49:48Z" }), r4: node("acme/disabled", { isDisabled: true }),
      r5: null, r6: node("twbs/bootstrap", { stargazerCount: 174996 }), r7: null, r8: node("acme/case"),
    };
    const errors = [
      { type: "NOT_FOUND", path: ["r1"], message: "Could not resolve to a Repository" },
      { type: "FORBIDDEN", path: ["r5"] },
      { type: "SERVICE_UNAVAILABLE", path: ["r7"] },
    ];
    const checks = mapRepositoryBatch(repos, data, errors);
    expect(checks[0]).toEqual({ status: "ok", facts: { stars: 12, ownerType: "Organization", archived: false, pushedAt: "2026-10-07T03:54:23Z", renamedTo: null } });
    expect(checks[1]).toEqual({ status: "not_found", facts: null });
    expect(checks[2]).toMatchObject({ status: "empty", facts: { stars: 0, pushedAt: null } });
    // 보관은 상태가 아니다 — 'ok' 그대로 두고 기록만 한다
    expect(checks[3]).toMatchObject({ status: "ok", facts: { archived: true, pushedAt: "2023-01-03T10:49:48Z" } });
    expect(checks[4]).toMatchObject({ status: "blocked", facts: { stars: 12 } });
    expect(checks[5]).toEqual({ status: "blocked", facts: null });
    expect(checks[6]).toMatchObject({ status: "ok", facts: { renamedTo: "twbs/bootstrap", stars: 174996 } });
    expect(checks[7]).toEqual({ status: null, facts: null });
    // 대소문자만 다른 것은 이름이 바뀐 것이 아니다
    expect(checks[8]).toMatchObject({ status: "ok", facts: { renamedTo: null } });
  });

  it("오류 없이 빠진 별칭이나 깨진 객체는 모름이다", () => {
    expect(mapRepositoryBatch([{ owner: "a", name: "b" }], {}, [])).toEqual([{ status: null, facts: null }]);
    expect(mapRepositoryBatch([{ owner: "a", name: "b" }], { r0: { stargazerCount: 1 } }, [])).toEqual([{ status: null, facts: null }]);
    expect(mapRepositoryBatch([{ owner: "a", name: "b" }], null, [])).toEqual([{ status: null, facts: null }]);
  });
});

describe("GraphQL 요청", () => {
  it("GraphQL 은 REST 와 다른 한도 칸을 쓴다", () => {
    expect(githubResource("/graphql")).toBe("graphql");
    expect(githubResource("/repos/a/b")).toBe("core");
  });

  it("수집 토큰으로 POST 하고 별칭별 답과 남은 점수를 돌려준다", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { rateLimit: { cost: 1, remaining: 4321, resetAt: "2026-10-08T05:00:00Z" }, r0: node("acme/alive"), r1: null },
      errors: [{ type: "NOT_FOUND", path: ["r1"] }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const result = await checkRepositories([{ owner: "acme", name: "alive" }, { owner: "acme", name: "gone" }]);
    expect(result).toMatchObject({ ok: true, rateLimit: { remaining: 4321, resetAt: "2026-10-08T05:00:00Z" },
      checks: [{ status: "ok" }, { status: "not_found", facts: null }] });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.github.com/graphql");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-token", "Content-Type": "application/json" });
    expect(JSON.parse(init.body).query).toContain('r1: repository(owner: "acme", name: "gone")');
  });

  it("200 에 RATE_LIMITED 로 답하면 한도로 본다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
    }), { status: 200, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) } })));
    expect(await checkRepositories([{ owner: "acme", name: "alive" }])).toEqual({ ok: false, error: { kind: "rate_limited", resetAt: null } });
    // 머리에 실린 초기화 시각은 graphql 칸에 적혔다 — 다음 요청이 그때까지 기다린다
    expect(quota.record).toHaveBeenCalledWith("test-token", "graphql", expect.objectContaining({ primary: true }));
  });

  it("data 가 통째로 없으면 묶음 전체를 모른다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: "Something went wrong" }] }), { status: 200 })));
    expect(await checkRepositories([{ owner: "acme", name: "alive" }])).toEqual({ ok: false, error: { kind: "invalid_response" } });
  });

  it("GraphQL 요청은 옮겨 가지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 307, headers: { location: "https://api.github.com/other" } })));
    expect(await checkRepositories([{ owner: "acme", name: "alive" }])).toEqual({ ok: false, error: { kind: "invalid_response" } });
  });
});
