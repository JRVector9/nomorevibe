import { beforeEach, expect, it, vi } from "vitest";
import type { FetchClaim } from "@/lib/crawl/fetch-ownership";
import { fetchCrawlDocuments } from "@/lib/crawl/jobs/fetch";
const mocks = vi.hoisted(() => ({dequeue:vi.fn(),defer:vi.fn(),repo:vi.fn(),save:vi.fn(),mark:vi.fn(),failed:vi.fn(),request:vi.fn()}));
vi.mock("@/lib/crawl/repository", () => ({recoverAbandonedFrontier:async()=>0,handOffFailedSourceRefreshes:async()=>0,dequeue:mocks.dequeue,deferFrontier:mocks.defer,saveFetchedDocument:mocks.save,markFrontier:mocks.mark,markFailed:mocks.failed}));
vi.mock("@/lib/crawl/settings", () => ({getSettings:async () => ({enabled:true,judge:{docsGenerators:[]},discover:{queries:[],showHn:{enabled:true,priority:120}}})}));
vi.mock("@/lib/crawl/github", () => ({getRepo:mocks.repo}));
vi.mock("@/lib/jobs/control", () => ({requestJob:mocks.request}));
const job = { name: "crawl-fetch", token: "fetch-unit-token", requestedVersion: 1 };
const entries: FetchClaim[] = ["acme/one", "acme/two"].map((repo, index) => ({
  id: index + 1, repo, signal: "test", builder: null, priority: 0, state: "fetching", attempts: 1,
  nextAttemptAt: new Date(0), lastError: null, aliasOf: null, discoveredAt: new Date(0), updatedAt: new Date(0),
  ownership: { kind: "legacy", stageEpoch: 1, job },
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.dequeue.mockResolvedValueOnce(entries).mockResolvedValue([]);
  mocks.save.mockResolvedValue({needsJudgement:true});
});
it("returns the whole unprocessed batch at the actual quota reset", async () => {
  const retryAt = new Date(Date.now()+120_000);
  mocks.repo.mockResolvedValue({ok:false,error:{kind:"rate_limited",resetAt:retryAt}});
  const result = await fetchCrawlDocuments({cursor:null,lease:job,hasBudget:()=>true,save:vi.fn(),log:vi.fn()});
  expect(result).toEqual({done:false});
  expect(mocks.defer).toHaveBeenCalledWith(entries,retryAt);
  expect(mocks.repo).toHaveBeenCalledTimes(1);
});
it("releases unvisited claims without consuming another network call after budget expiry", async () => {
  let budget = true;
  let firstSaved!: () => void;
  const saved = new Promise<void>(resolve => { firstSaved = resolve; });
  // Concurrent lanes may already hold the second claim; its GitHub response arrives after the budget ends.
  mocks.repo.mockImplementation(async (repo: string) => {
    if (repo !== "acme/one") await saved;
    return {ok:true,value:{homepage:null}};
  });
  mocks.save.mockImplementation(async () => {budget=false;firstSaved();return {needsJudgement:true};});
  await fetchCrawlDocuments({cursor:null,lease:job,hasBudget:()=>budget,save:vi.fn(),log:vi.fn()});
  expect(mocks.defer).toHaveBeenCalledWith([entries[1]],undefined);
  expect(mocks.save).toHaveBeenCalledTimes(1);
});
