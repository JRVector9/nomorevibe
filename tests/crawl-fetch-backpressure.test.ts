import { beforeEach, expect, it, vi } from "vitest";
import { fetchCrawlDocuments } from "@/lib/crawl/jobs/fetch";
const mocks = vi.hoisted(() => ({dequeue:vi.fn(),defer:vi.fn(),repo:vi.fn(),put:vi.fn(),mark:vi.fn()}));
vi.mock("@/lib/crawl/repository", () => ({dequeue:mocks.dequeue,deferFrontier:mocks.defer,putDocument:mocks.put,markFrontier:mocks.mark}));
vi.mock("@/lib/crawl/settings", () => ({getSettings:async () => ({enabled:true,judge:{docsGenerators:[]}})}));
vi.mock("@/lib/crawl/github", () => ({getRepo:mocks.repo}));
vi.mock("@/lib/crawl/admin-review", () => ({requeueAfterAdminEvidenceRefresh:async () => false}));
const entries = [{repo:"acme/one"},{repo:"acme/two"}];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.dequeue.mockResolvedValueOnce(entries).mockResolvedValue([]);
});
it("returns the whole unprocessed batch at the actual quota reset", async () => {
  const retryAt = new Date(Date.now()+120_000);
  mocks.repo.mockResolvedValue({ok:false,error:{kind:"rate_limited",resetAt:retryAt}});
  const result = await fetchCrawlDocuments({cursor:null,hasBudget:()=>true,save:vi.fn(),log:vi.fn()});
  expect(result).toEqual({done:false});
  expect(mocks.defer).toHaveBeenCalledWith(entries,retryAt);
  expect(mocks.repo).toHaveBeenCalledTimes(1);
});
it("releases unvisited claims without consuming another network call after budget expiry", async () => {
  let budget = true;
  mocks.repo.mockResolvedValue({ok:true,value:{homepage:null}});
  mocks.mark.mockImplementation(async () => {budget=false;});
  await fetchCrawlDocuments({cursor:null,hasBudget:()=>budget,save:vi.fn(),log:vi.fn()});
  expect(mocks.defer).toHaveBeenCalledWith([entries[1]]);
  expect(mocks.repo).toHaveBeenCalledTimes(1);
});
