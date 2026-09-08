import { beforeEach, expect, it, vi } from "vitest";
import { reviewCrawlCandidates } from "@/lib/crawl/jobs/agent-review";
import { createReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
const mocks = vi.hoisted(() => ({settings:null as CrawlSettings|null,list:vi.fn(),document:vi.fn(),input:vi.fn(),claim:vi.fn(),record:vi.fn(),review:vi.fn(),existing:vi.fn()}));
vi.mock("@/lib/crawl/settings", () => ({getSettings:async () => mocks.settings}));
vi.mock("@/lib/crawl/repository", () => ({getDocument:mocks.document}));
vi.mock("@/lib/domain/products/repository", () => ({findByUrl:mocks.existing}));
vi.mock("@/lib/crawl/agent-review-repository", () => ({listReviewCandidates:mocks.list,loadReviewInput:mocks.input,claimAgentReview:mocks.claim,recordAgentReview:mocks.record}));
vi.mock("@/lib/crawl/agent-review", () => ({reviewModel:()=>"tested-model",reviewWithAgent:mocks.review,REVIEW_CLI_TIMEOUT_MS:20_000}));
const context = () => ({cursor:null,hasBudget:()=>true,save:vi.fn(),log:vi.fn(),lease:{name:"crawl-agent-review",token:"token",requestedVersion:1}});
const candidate = () => ({id:1,repo:"acme/demo",productUrl:"https://demo.example",state:"approved",decidedBy:"auto",judgedAt:new Date()} as CrawlCandidate);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.settings = {...DEFAULT_CRAWL_SETTINGS,enabled:true,reviewMode:"observe"};
  const now = new Date();
  const document = {id:1,repo:"acme/demo",productUrl:"https://demo.example",repoMeta:{description:"Task tracker",homepage:"https://demo.example",pushed_at:now.toISOString(),stargazers_count:0,owner:{type:"User"}},
    pageMeta:{title:"Demo"},pageStatus:200,fetchedAt:now} as CrawlDocument;
  mocks.list.mockResolvedValue([candidate()]);mocks.document.mockResolvedValue(document);
  mocks.input.mockImplementation(async (c,d,s) => createReviewInput(c,d,s,{scan:null,observations:[]}));
  mocks.existing.mockResolvedValue(null);mocks.claim.mockResolvedValue({kind:"claimed",attempt:{id:1,attemptNumber:1}});
  mocks.record.mockResolvedValue({applied:false,state:"succeeded"});
  mocks.review.mockResolvedValue({ok:true,outcome:{decision:"approve",reason:"Deployed task tracker",evidenceIds:["product"]},usage:{}});
});
it("does not select or call AI when review mode is off", async () => {
  mocks.settings!.reviewMode = "off";
  expect(await reviewCrawlCandidates(context())).toEqual({done:true});
  expect(mocks.list).not.toHaveBeenCalled();expect(mocks.review).not.toHaveBeenCalled();
});
it("runs at most one external review and records through the transactional repository", async () => {
  mocks.list.mockResolvedValue([candidate(),{...candidate(),id:2}]);
  expect(await reviewCrawlCandidates(context())).toEqual({done:false});
  expect(mocks.review).toHaveBeenCalledTimes(1);
  expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({settings:expect.objectContaining({reviewMode:"observe"}),outcome:expect.objectContaining({decision:"approve"}),lease:context().lease}));
});
it("does not call AI for administrator decisions or hard rule rejection", async () => {
  mocks.list.mockResolvedValue([{...candidate(),decidedBy:"admin"}]);
  await reviewCrawlCandidates(context());
  expect(mocks.claim).not.toHaveBeenCalled();
  mocks.list.mockResolvedValue([candidate()]);
  const document = await mocks.document();document.repoMeta.fork=true;
  await reviewCrawlCandidates(context());
  expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({provider:"rules"}));
  expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({outcome:expect.objectContaining({decision:"reject"})}));
  expect(mocks.review).not.toHaveBeenCalled();
});
it("records transient AI failures with a retry time without inventing a verdict", async () => {
  mocks.review.mockResolvedValue({ok:false,error:"auth"});
  await reviewCrawlCandidates(context());
  const recorded = mocks.record.mock.calls[0][0];
  expect(recorded.error).toBe("auth");expect(recorded.outcome).toBeUndefined();expect(recorded.retryAfter.getTime()).toBeGreaterThan(Date.now());
});
