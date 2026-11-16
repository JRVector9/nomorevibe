import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ crawlBurstStatus: vi.fn(), saveCrawlBurstSettings: vi.fn(), releaseCrawlBurst: vi.fn() }));
vi.mock("@/lib/operations/crawl-burst-ops", () => mocks);
import { runCrawlBurstCommand } from "@/scripts/crawl-burst";
beforeEach(() => { vi.resetAllMocks(); mocks.saveCrawlBurstSettings.mockResolvedValue({ ok: true, revision: 2 }); });
it("status returns detailed settings and counts", async () => {
  mocks.crawlBurstStatus.mockResolvedValue({ settings: { detailReadLimit: 60, detailReadWindowSeconds: 600, detailBurstLimit: 20, detailBurstWindowSeconds: 10 }, blockedNow: 1 });
  expect(await runCrawlBurstCommand(["status"])).toMatchObject({ settings: { detailReadLimit: 60, detailBurstLimit: 20 }, blockedNow: 1 });
});
it("set detail changes only detailed settings; 0 is passed through", async () => {
  expect(await runCrawlBurstCommand(["set", "detail", "0", "600", "20", "10", "tester"])).toMatchObject({ detailReadLimit: 0, revision: 2 });
  expect(mocks.saveCrawlBurstSettings).toHaveBeenCalledWith({ detailReadLimit: 0, detailReadWindowSeconds: 600, detailBurstLimit: 20, detailBurstWindowSeconds: 10 }, "tester");
});
it("existing set and release syntax remains valid", async () => {
  await runCrawlBurstCommand(["set", "80", "10", "1800", "tester"]);
  expect(mocks.saveCrawlBurstSettings).toHaveBeenCalledWith({ burstLimit: 80, burstWindowSeconds: 10, burstBlockSeconds: 1800 }, "tester");
  await runCrawlBurstCommand(["release", "198.51.100.1", "tester"]);
  expect(mocks.releaseCrawlBurst).toHaveBeenCalledWith("198.51.100.1", "tester");
});
it("invalid settings and arguments fail explicitly", async () => {
  mocks.saveCrawlBurstSettings.mockResolvedValue({ ok: false, issues: ["invalid"] });
  await expect(runCrawlBurstCommand(["set", "detail", "-1", "600", "20", "10", "tester"])).rejects.toThrow("invalid");
  await expect(runCrawlBurstCommand(["set", "detail"])).rejects.toThrow("usage:");
});
