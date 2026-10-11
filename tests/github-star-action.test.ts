import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

async function contract() {
  const loaded = await import("@/lib/domain/github-stars/contract").catch(() => null);
  expect(loaded, "star input and result contracts are missing").not.toBeNull();
  return loaded!;
}

describe("personal GitHub star writes", () => {
  it("provides revision-checked idempotent personal star operations", async () => {
    const loaded = await import("@/lib/domain/github-stars/service").catch(() => null);
    expect(loaded, "personal GitHub star operations are missing").not.toBeNull();
    expect(typeof loaded?.writeGithubStar).toBe("function");
  });
  it("accepts only an explicit desired state, UUID operation and safe integer revision", async () => {
    const loaded = await contract();
    const input = { starred: true, operationId: "123e4567-e89b-42d3-a456-426614174000", expectedRevision: 1 };
    expect(loaded.parseStarWrite(input)).toEqual(input);
    for (const invalid of [{ ...input, starred: "true" }, { ...input, operationId: "forged" }, { ...input, expectedRevision: -1 }, { ...input, expectedRevision: 1.5 }, { ...input, owner: "attacker", repo: "other" }, null]) {
      expect(() => loaded.parseStarWrite(invalid)).toThrow("invalid_star_request");
    }
  });
  it("treats only confirmed starring 404 as unstarred and never turns uncertainty into success", async () => {
    const loaded = await contract();
    expect(loaded.starStateFromRead({ outcome: "confirmed_success", status: 204, data: null, code: null, retryAt: null, requestId: null })).toBe("starred");
    expect(loaded.starStateFromRead({ outcome: "confirmed_rejection", status: 404, code: "github_not_found", retryAt: null, requestId: null })).toBe("unstarred");
    expect(loaded.starStateFromRead({ outcome: "unknown", status: null, code: "github_timeout", retryAt: null, requestId: null })).toBe("unknown");
    expect(loaded.starStateFromRead({ outcome: "confirmed_rejection", status: 401, code: "github_unauthorized", retryAt: null, requestId: null })).toBe("needs_reconnect");
  });
  it("disables public star APIs behind the default-off flag", async () => {
    const route = await import("@/app/api/products/[slug]/github-star/route").catch(() => null);
    expect(route, "personal star route is missing").not.toBeNull();
    vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true");
    vi.stubEnv("GITHUB_STAR_ENABLED", "false");
    const request = new Request("https://nomorevibe.example/api/products/test/github-star");
    const context = { params: Promise.resolve({ slug: "test" }) };
    for (const response of [await route!.GET(request, context), await route!.PUT(request, context)]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });
  it("renders a GitHub star control separately from browser saving", async () => {
    const loaded = await import("@/components/product-detail/GithubStarButton").catch(() => null);
    expect(loaded, "personal star button is missing").not.toBeNull();
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const markup = renderToStaticMarkup(createElement(loaded!.GithubStarButton, { slug: "test" }));
    expect(markup).toContain("GitHub 스타");
    expect(markup).not.toContain("localStorage");
  });
  it("keeps newer personal state when an older browser response arrives", async () => {
    const loaded = await import("@/components/product-detail/GithubStarButton");
    const current = { state: "starred" as const, revision: 3, repositoryId: 1000, pending: false };
    const stale = { state: "unstarred" as const, revision: 2, repositoryId: 1000, pending: true };
    expect(loaded.newerStarView(current, stale)).toBe(current);
    expect(loaded.newerStarView(stale, current)).toBe(current);
  });
  it("ignores an older failed refresh after a newer successful browser response", async () => {
    const states: unknown[] = [];
    const callbacks: ((...args: unknown[]) => unknown)[] = [];
    let stateSlot = 0;
    const actual = await vi.importActual<Record<string, unknown>>("react");
    vi.resetModules();
    vi.doMock("react", () => ({ ...actual,
      useState(initial: unknown) {
        const slot = stateSlot++; states[slot] = initial;
        return [initial, (value: unknown) => { states[slot] = typeof value === "function" ? value(states[slot]) : value; }];
      },
      useRef: (initial: unknown) => ({ current: initial }),
      useCallback(callback: (...args: unknown[]) => unknown) { callbacks.push(callback); return callback; },
      useEffect() {},
    }));
    const releases: ((response: Response) => void)[] = [];
    vi.stubGlobal("fetch", async (url: string) => url === "/api/me" ? Response.json({ user: { id: 1 }, csrfToken: "test-csrf" }) : new Promise<Response>((resolve) => releases.push(resolve)));
    try {
      const loaded = await import("@/components/product-detail/GithubStarButton");
      loaded.GithubStarButton({ slug: "test" });
      const older = callbacks[1]() as Promise<void>;
      const newer = callbacks[1]() as Promise<void>;
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      const latest = { state: "starred", revision: 10, repositoryId: 1000, pending: false };
      releases[1](Response.json(latest)); await newer;
      releases[0](Response.json({ error: "star_repository_unavailable" }, { status: 503 })); await older;
      expect(states[0]).toEqual(latest);
      expect(states[4]).toBe("");
    } finally { vi.doUnmock("react"); vi.resetModules(); vi.unstubAllGlobals(); }
  });
  it("preserves the uncertainty lock explanation after a conflicted write refreshes its state", async () => {
    const states: unknown[] = [];
    let slot = 0;
    const actual = await vi.importActual<Record<string, unknown>>("react");
    vi.resetModules();
    vi.doMock("react", () => ({ ...actual,
      useState(initial: unknown) {
        const index = slot++;
        const seeded = index === 0 ? { state: "unstarred", revision: 2, repositoryId: 1000, pending: false } : index === 1 ? "csrf" : initial;
        states[index] = seeded;
        return [seeded, (value: unknown) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
      },
      useRef: (initial: unknown) => ({ current: initial }), useCallback: (callback: unknown) => callback, useEffect() {},
    }));
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === "/api/me") return Response.json({ user: { id: 1 }, csrfToken: "csrf" });
      if (init?.method === "PUT") return Response.json({ error: "star_result_uncertain" }, { status: 409 });
      return Response.json({ state: "unknown", uncertain: true, revision: 3, repositoryId: 1000, pending: false });
    });
    try {
      const loaded = await import("@/components/product-detail/GithubStarButton");
      const tree = loaded.GithubStarButton({ slug: "test" });
      tree.props.children[0].props.onClick();
      await vi.waitFor(() => expect(states[3]).toBe(false));
      expect(states[4]).toContain("재조회로 해제되지 않습니다");
    } finally { vi.doUnmock("react"); vi.resetModules(); vi.unstubAllGlobals(); }
  });
});
