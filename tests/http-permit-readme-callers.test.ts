import { beforeEach, expect, it, vi } from "vitest";
import { HttpOriginPermitError } from "@/lib/net/http-origin-policy";
const mock = vi.hoisted(() => ({ raw: vi.fn(), github: vi.fn(), setReadme: vi.fn(), record: vi.fn() }));
vi.mock("@/lib/net/fetch", () => ({ fetchCapped: mock.raw }));
vi.mock("@/lib/crawl/github", () => ({ githubRequest: mock.github }));
vi.mock("@/lib/crawl/repository", () => ({ getDocument: async () => ({ repo: "acme/app", pageMeta: {} }), setReadmeSample: mock.setReadme,
  pendingPublishedReadmes: async () => [{ repo: "acme/app" }], recordPublishedReadme: mock.record }));
import { fetchPublicReadme } from "@/lib/crawl/readme-refresh";
import { loadReviewDocument } from "@/lib/crawl/jobs/review-document";
import { refreshPublishedReadmes } from "@/lib/jobs/products/readme-refresh";
const blocked = new HttpOriginPermitError("waiting_aborted");
beforeEach(() => { vi.resetAllMocks(); mock.raw.mockRejectedValue(blocked); });
it("raw README waits do not trigger authenticated API fallback", async () => {
  await expect(fetchPublicReadme("acme/app")).rejects.toBe(blocked);
  expect(mock.github).not.toHaveBeenCalled();
});
it("review-document waits leave the stored evidence unchanged", async () => {
  await expect(loadReviewDocument("acme/app")).rejects.toBe(blocked);
  expect(mock.setReadme).not.toHaveBeenCalled();
});
it("published README waits do not write failure, backoff or replacement evidence", async () => {
  await expect(refreshPublishedReadmes({ cursor: null, hasBudget: () => true, save: vi.fn(), log: vi.fn(),
    lease: { name: "product-readme-refresh", token: "fixture", requestedVersion: 1 } })).rejects.toBe(blocked);
  expect(mock.record).not.toHaveBeenCalled();
});
