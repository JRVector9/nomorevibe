import { beforeEach, expect, it, vi } from "vitest";
import { reviewCrawlCandidates } from "@/lib/crawl/jobs/agent-review";
import { createReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
const mocks = vi.hoisted(() => ({settings:null as CrawlSettings|null,readme:vi.fn(),saveReadme:vi.fn(),requeue:vi.fn(),list:vi.fn(),document:vi.fn(),input:vi.fn(),claim:vi.fn(),record:vi.fn(),review:vi.fn(),existing:vi.fn(),requestJob:vi.fn()}));
vi.mock("@/lib/crawl/settings", () => ({getSettings:async () => mocks.settings}));
vi.mock("@/lib/crawl/repository", () => ({getDocument:mocks.document,setReadmeSample:mocks.saveReadme}));
// 단위 테스트가 README 를 받으러 밖으로 나가지 않게 한다
vi.mock("@/lib/crawl/readme", () => ({fetchReadmeSample:mocks.readme,README_SAMPLE_LIMIT:3000}));
vi.mock("@/lib/domain/products/repository", () => ({findByUrl:mocks.existing}));
vi.mock("@/lib/crawl/agent-review-repository", () => ({requeueStaleReviewSources:mocks.requeue,listReviewCandidates:mocks.list,loadReviewInput:mocks.input,claimAgentReview:mocks.claim,recordAgentReview:mocks.record}));
vi.mock("@/lib/crawl/agent-review", () => ({reviewModel:()=>"tested-model",reviewWithAgent:mocks.review,REVIEW_CLI_TIMEOUT_MS:20_000}));
vi.mock("@/lib/jobs/control", () => ({requestJob:mocks.requestJob}));
const context = () => ({cursor:null,hasBudget:()=>true,save:vi.fn(),log:vi.fn(),lease:{name:"crawl-agent-review",token:"token",requestedVersion:1}});
const candidate = () => ({id:1,repo:"acme/demo",productUrl:"https://demo.example",state:"approved",decidedBy:"auto",judgedAt:new Date()} as CrawlCandidate);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.settings = {...DEFAULT_CRAWL_SETTINGS,enabled:true,reviewMode:"observe"};
  mocks.requeue.mockResolvedValue(0);
  mocks.readme.mockResolvedValue("");
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
  expect(mocks.requeue).not.toHaveBeenCalled();expect(mocks.list).not.toHaveBeenCalled();expect(mocks.review).not.toHaveBeenCalled();
});
it("runs at most two external reviews and records through the transactional repository", async () => {
  mocks.list.mockResolvedValue([candidate(),{...candidate(),id:2},{...candidate(),id:3}]);
  expect(await reviewCrawlCandidates(context())).toEqual({done:false});
  expect(mocks.review).toHaveBeenCalledTimes(2);
  expect(mocks.claim.mock.calls.map(call => call[0].candidate.id)).toEqual([1,2]);
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
it("holds incomplete AI evidence deterministically instead of asking a model to reject it", async () => {
  mocks.settings!.agentEvidence = { ...mocks.settings!.agentEvidence, enforceEligibility: true };
  await reviewCrawlCandidates(context());
  expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({ provider: "rules" }));
  expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: expect.objectContaining({ decision: "needs_review" }) }));
  expect(mocks.review).not.toHaveBeenCalled();
});

it("applies the page-body rule before a model call, like the rule judge", async () => {
  // codex 재현: needs_review 후보를 재수집하자 본문에 설치 명령이 생겼는데, 규칙 재호출에 본문이 없어 모델이 승인했다
  mocks.list.mockResolvedValue([{...candidate(),state:"needs_review",reason:"ambiguous"}]);
  const document = await mocks.document();document.pageMeta = {...document.pageMeta,textSample:"Demo CLI. Install: npm install -g demo"};
  await reviewCrawlCandidates(context());
  expect(mocks.review).not.toHaveBeenCalled();
  expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({provider:"rules"}));
  expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({outcome:expect.objectContaining({decision:"reject"})}));
});
it("runs two external reviews at once so two 20-second calls fit one 25-second tick", async () => {
  mocks.list.mockResolvedValue([candidate(),{...candidate(),id:2},{...candidate(),id:3}]);
  let started = 0, release!: () => void, timer: NodeJS.Timeout | undefined;
  const bothStarted = new Promise<void>(resolve => { release = resolve; });
  mocks.review.mockImplementation(async () => {
    if (++started === 2) release();
    // 직렬로 돌면 두 번째 호출이 시작되지 않아 여기서 풀리지 않는다
    await Promise.race([bothStarted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("reviews ran serially")), 1_000); })]);
    clearTimeout(timer);
    return {ok:true,outcome:{decision:"approve",reason:"Deployed task tracker",evidenceIds:["product"]},usage:{}};
  });
  expect(await reviewCrawlCandidates(context())).toEqual({done:false});
  expect(mocks.review).toHaveBeenCalledTimes(2);
  expect(mocks.record.mock.calls.map(call => call[0].candidate.id).sort()).toEqual([1,2]);
});
it("records every concurrent review even when one model call fails", async () => {
  mocks.list.mockResolvedValue([candidate(),{...candidate(),id:2}]);
  mocks.review.mockResolvedValueOnce({ok:false,error:"timeout"})
    .mockResolvedValueOnce({ok:true,outcome:{decision:"approve",reason:"Deployed task tracker",evidenceIds:["product"]},usage:{}});
  await reviewCrawlCandidates(context());
  expect(mocks.record.mock.calls.map(call => [call[0].candidate.id, call[0].error ?? call[0].outcome.decision]).sort()).toEqual([[1,"timeout"],[2,"approve"]]);
});
it("waits for the other review before failing the tick when one record throws", async () => {
  mocks.list.mockResolvedValue([candidate(),{...candidate(),id:2}]);
  const document = await mocks.document();
  // 두 번째 후보의 DB 조회가 실제 I/O처럼 한 틱을 넘긴다. 그 사이 첫 기록이 실패해도 워커가 죽으면 안 된다
  mocks.document.mockImplementationOnce(async () => document)
    .mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return document; });
  mocks.record.mockImplementation(async ({candidate}) => {
    if (candidate.id === 1) throw new Error("record failed");
    return {applied:false,state:"succeeded"};
  });
  await expect(reviewCrawlCandidates(context())).rejects.toThrow("record failed");
  expect(mocks.review).toHaveBeenCalledTimes(2);
  expect(mocks.record.mock.calls.map(call => call[0].candidate.id)).toEqual([1,2]);
});
it("requests publication once at the end of a batch with applied approvals", async () => {
  mocks.settings!.reviewMode = "enforce";
  mocks.list.mockResolvedValue([candidate(),{...candidate(),id:2}]);
  const approval = {decision:"approve",reason:"Deployed task tracker",evidenceIds:["product"]};
  mocks.claim.mockResolvedValueOnce({kind:"reused",attempt:{id:1,attemptNumber:1,outcome:approval}})
    .mockResolvedValueOnce({kind:"claimed",attempt:{id:2,attemptNumber:1}});
  mocks.record.mockResolvedValue({applied:true,state:"succeeded"});
  await reviewCrawlCandidates(context());
  expect(mocks.record).toHaveBeenCalledTimes(2);
  expect(mocks.requestJob.mock.calls).toEqual([["crawl-publish"]]);
});
it("does not request publication without an applied approval", async () => {
  await reviewCrawlCandidates(context());
  expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({outcome:expect.objectContaining({decision:"approve"})}));
  mocks.settings!.reviewMode = "enforce";
  mocks.record.mockResolvedValue({applied:true,state:"succeeded"});
  mocks.review.mockResolvedValue({ok:true,outcome:{decision:"reject",reason:"Documentation only",evidenceIds:["product"]},usage:{}});
  await reviewCrawlCandidates(context());
  mocks.review.mockResolvedValue({ok:false,error:"timeout"});
  mocks.record.mockResolvedValue({applied:false,state:"failed"});
  await reviewCrawlCandidates(context());
  expect(mocks.requestJob).not.toHaveBeenCalled();
});

/** README 는 처음 심사할 때 한 번 받아 원본 옆에 둔다 — 다음 심사는 저장된 것을 쓴다 */
it("README 가 없으면 한 번 받아 저장하고, 있으면 다시 받지 않는다", async () => {
  mocks.readme.mockResolvedValue("Oigo — dictation for macOS");
  await reviewCrawlCandidates(context());
  expect(mocks.readme).toHaveBeenCalledWith("acme/demo");
  expect(mocks.saveReadme).toHaveBeenCalledWith("acme/demo", "Oigo — dictation for macOS");

  mocks.readme.mockClear(); mocks.saveReadme.mockClear();
  const stored = await mocks.document();
  mocks.document.mockResolvedValue({...stored, pageMeta:{...(stored.pageMeta ?? {}), readmeSample:""}});
  await reviewCrawlCandidates(context());
  expect(mocks.readme).not.toHaveBeenCalled();
  expect(mocks.saveReadme).not.toHaveBeenCalled();
});

it("README 를 잠깐 못 받으면 저장하지 않고 이번엔 없이 심사한다", async () => {
  mocks.readme.mockResolvedValue(null);
  await reviewCrawlCandidates(context());
  expect(mocks.saveReadme).not.toHaveBeenCalled();
  expect(mocks.review).toHaveBeenCalled();
});
