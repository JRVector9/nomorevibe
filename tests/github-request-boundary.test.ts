import { afterEach, expect, it, vi } from "vitest";
import { githubRequest } from "@/lib/crawl/github";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("rejects path tricks before attaching the GitHub token", async () => {
  vi.stubEnv("GITHUB_TOKEN", "test-token");
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", {status: 200})));
  vi.stubGlobal("fetch", fetcher);
  for (const path of ["//other.example/repos", "/repos/a/b/../secrets", "/repos/a/b#fragment"]) {
    expect(await githubRequest(path)).toMatchObject({ ok: false });
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it("does not follow redirects while carrying an authorization header", async () => {
  vi.stubEnv("GITHUB_TOKEN", "test-token");
  const fetcher = vi.fn().mockResolvedValue(new Response("{}", {status: 200}));
  vi.stubGlobal("fetch", fetcher);
  await githubRequest("/repos/acme/app");
  expect(fetcher).toHaveBeenCalledWith("https://api.github.com/repos/acme/app", expect.objectContaining({redirect: "error"}));
});
