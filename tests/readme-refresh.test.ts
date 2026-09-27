import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ raw: vi.fn(), api: vi.fn(), download: vi.fn() }));
vi.mock("@/lib/crawl/readme", async importOriginal => ({ ...await importOriginal<object>(), fetchReadmeSample: mocks.raw }));
vi.mock("@/lib/crawl/github", () => ({ githubRequest: mocks.api }));
vi.mock("@/lib/net/fetch", () => ({ fetchCapped: mocks.download }));
import { fetchPublicReadme } from "@/lib/crawl/readme-refresh";
beforeEach(() => { vi.stubEnv("GITHUB_TOKEN", "fixture"); vi.clearAllMocks(); mocks.raw.mockResolvedValue(""); });
afterEach(() => vi.unstubAllEnvs());
const publicRepo = { ok: true, status: 200, value: { private: false } };
describe("public README fallback", () => {
  it("uses ordinary raw evidence without consuming API quota", async () => {
    mocks.raw.mockResolvedValue("Raw README");
    expect(await fetchPublicReadme("someone/repo")).toEqual({ ok: true, sample: "Raw README" });
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it("discovers unusual README names and normalizes their text", async () => {
    mocks.api.mockResolvedValueOnce(publicRepo).mockResolvedValueOnce({ ok: true, status: 200,
      value: { encoding: "base64", content: Buffer.from("# Actual README\n\0Text").toString("base64") } });
    expect(await fetchPublicReadme("someone/repo")).toEqual({ ok: true, sample: "Actual README\nText" });
  });
  it("does not read authenticated README content from a private repository", async () => {
    mocks.api.mockResolvedValueOnce({ ok: true, status: 200, value: { private: true } });
    expect(await fetchPublicReadme("someone/repo")).toMatchObject({ ok: false, error: "not_public" });
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });
  it("preserves the provider retry time and does not mislabel quota exhaustion as absence", async () => {
    const resetAt = new Date(Date.now() + 60_000);
    mocks.api.mockResolvedValueOnce({ ok: false, error: { kind: "rate_limited", resetAt } });
    expect(await fetchPublicReadme("someone/repo")).toEqual({ ok: false, error: "rate_limited", retryAfter: resetAt.getTime() });
  });
  it("downloads a bounded public raw prefix when the API omits oversized inline content", async () => {
    mocks.api.mockResolvedValueOnce(publicRepo).mockResolvedValueOnce({ ok: true, status: 200,
      value: { encoding: "none", download_url: "https://raw.githubusercontent.com/someone/repo/main/ReadMe.md" } });
    mocks.download.mockResolvedValueOnce({ ok: true, body: Buffer.from("# Big README") });
    expect(await fetchPublicReadme("someone/repo")).toEqual({ ok: true, sample: "Big README" });
    expect(mocks.download).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ maxBytes: 256 * 1024, allowTruncatedBody: true }));
  });
  it("rejects an unexpected download destination without sending a request", async () => {
    mocks.api.mockResolvedValueOnce(publicRepo).mockResolvedValueOnce({ ok: true, status: 200,
      value: { encoding: "none", download_url: "https://attacker.test/readme" } });
    expect(await fetchPublicReadme("someone/repo")).toMatchObject({ ok: false });
    expect(mocks.download).not.toHaveBeenCalled();
  });
});
