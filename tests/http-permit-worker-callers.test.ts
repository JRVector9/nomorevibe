import { beforeEach, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";
import { HttpOriginPermitError } from "@/lib/net/http-origin-policy";
const mock = vi.hoisted(() => ({ fetch: vi.fn(), page: vi.fn(), safe: vi.fn(), body: vi.fn(), save: vi.fn(), insertNews: vi.fn(),
  sources: [{ key: "one", kind: "feed", url: "https://one.example/feed" }, { key: "two", kind: "feed", url: "https://two.example/feed" }],
  slugs: ["one"], normalize: vi.fn(), defaultImage: vi.fn() }));
vi.mock("@/lib/net/fetch", () => ({ fetchCapped: mock.fetch, fetchPage: mock.page, safeFetch: mock.safe, readBodyCapped: mock.body }));
vi.mock("@/lib/domain/products/thumbnails/repository", () => ({ listDueThumbnails: async () => mock.slugs,
  loadThumbnailProduct: async (name: string) => ({ name, url: `https://${name}.example`, repoUrl: null }), saveThumbnail: mock.save }));
vi.mock("@/lib/domain/products/thumbnails/images", () => ({ normalizeThumbnail: mock.normalize, defaultThumbnail: mock.defaultImage }));
vi.mock("@/lib/news/sources", () => ({ NEWS_SOURCES: mock.sources }));
vi.mock("@/lib/news/repository", () => ({ insertNewsItems: mock.insertNews }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: async () => ({ news: { disabledSources: [], autoApprove: false } }) }));
vi.mock("@/lib/domain/products/repo-reviews", () => ({}));
import { resolveThumbnail } from "@/lib/domain/products/thumbnails/resolver";
import { refreshProductThumbnails } from "@/lib/jobs/products/thumbnail-refresh";
import { openProductPage } from "@/lib/jobs/products/repo-review";
import { refreshNews, type NewsCursor } from "@/lib/news/refresh";
const blocked = new HttpOriginPermitError("waiting_aborted");
const ctx = <T>(cursor: T | null = null): JobContext<T> => ({ cursor, save: vi.fn(), hasBudget: () => true, log: vi.fn() });
function latch() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetAllMocks(); mock.slugs = ["one"];
  mock.defaultImage.mockResolvedValue({ data: Buffer.from("default"), contentType: "image/png" });
  mock.safe.mockResolvedValue({ response: new Response("", { status: 200 }), finalUrl: "https://one.example" });
  mock.body.mockResolvedValue(Buffer.from('<meta http-equiv="refresh" content="0; url=https://two.example">'));
});
it("thumbnail resolution stops instead of caching a generated default on a permit hold", async () => {
  mock.fetch.mockRejectedValue(blocked);
  await expect(resolveThumbnail({ name: "One", url: "https://one.example", repoUrl: null })).rejects.toBe(blocked);
  expect(mock.fetch).toHaveBeenCalledTimes(1);
  expect(mock.defaultImage).not.toHaveBeenCalled();
});
it("thumbnail worker drains concurrent work before forwarding a hold without attempt writes", async () => {
  mock.slugs = ["one", "two"];
  const finish = latch(), started = latch();
  mock.fetch.mockImplementation(async (url: string) => {
    if (url.includes("one.example")) throw blocked;
    started.resolve(); await finish.promise;
    return { ok: false, status: 404, reason: "http" };
  });
  let ended = false;
  const execution = refreshProductThumbnails(ctx()).finally(() => { ended = true; });
  const observed = execution.catch(error => error);
  try {
    await started.promise;
    expect(ended).toBe(false);
    expect(mock.save).not.toHaveBeenCalled();
  } finally { finish.resolve(); }
  expect(await observed).toBe(blocked);
  expect(mock.save.mock.calls.every(([product]) => product.name !== "one")).toBe(true);
});
it("news holds do not overwrite a previous source outcome/cursor and drain other transports", async () => {
  const finish = latch(), started = latch();
  const cursor: NewsCursor = { sources: { one: { checkedAt: "2026-10-01T00:00:00.000Z", ok: true, found: 0, added: 0, seen: ["old"] } } };
  const original = structuredClone(cursor);
  mock.fetch.mockImplementation(async (url: string) => {
    if (url.includes("one.example")) throw blocked;
    started.resolve(); await finish.promise;
    return { ok: false, reason: "http", status: 503 };
  });
  let ended = false;
  const execution = refreshNews(ctx(cursor)).finally(() => { ended = true; });
  const observed = execution.catch(error => error);
  try { await started.promise; expect(ended).toBe(false); }
  finally { finish.resolve(); }
  expect(await observed).toBe(blocked);
  expect(cursor).toEqual(original);
  expect(mock.insertNews).not.toHaveBeenCalled();
});
it("repo-review meta-refresh holds cannot become conclusive missing-link evidence", async () => {
  mock.page.mockRejectedValue(blocked);
  await expect(openProductPage("https://one.example")).rejects.toBe(blocked);
});
it("ordinary thumbnail connection failures still use the generated fallback", async () => {
  mock.fetch.mockRejectedValue(new Error("connection reset"));
  expect(await resolveThumbnail({ name: "One", url: "https://one.example", repoUrl: null })).toMatchObject({ kind: "default" });
});
it("ordinary feed failures retain the source failure outcome", async () => {
  mock.fetch.mockRejectedValue(new Error("connection reset"));
  const result = await refreshNews(ctx());
  expect(result).toMatchObject({ done: true, cursor: { sources: { one: { ok: false, error: "connection reset" } } } });
});
it("ordinary repo-review body failures retain observed status and incomplete evidence", async () => {
  mock.body.mockRejectedValue(new Error("connection reset"));
  expect(await openProductPage("https://one.example")).toMatchObject({ status: 200, complete: false });
});

it("news still surfaces a genuine persistence failure when another lane is permit blocked", async () => {
  const dbError = new Error("news write rejected");
  mock.fetch.mockImplementation(async (url: string) => {
    if (url.includes("one.example")) throw blocked;
    return { ok: true, status: 200, finalUrl: url, body: Buffer.from('<rss version="2.0"><channel><title>News</title></channel></rss>') };
  });
  mock.insertNews.mockRejectedValue(dbError);
  await expect(refreshNews(ctx())).rejects.toBe(dbError);
});
