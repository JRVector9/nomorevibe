import { beforeEach, expect, it, vi } from "vitest";
import type { CrawlCandidate } from "@/lib/db/schema";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
const state = vi.hoisted(() => ({enforce:false,insert:vi.fn(),published:vi.fn()}));
vi.mock("@/lib/crawl/settings",()=>({getSettings:async()=>({...DEFAULT_CRAWL_SETTINGS,agentEvidence:{...DEFAULT_CRAWL_SETTINGS.agentEvidence,enforceEligibility:state.enforce}})}));
vi.mock("@/lib/crawl/agent-evidence",()=>({loadAgentJudgeInput:async()=>({scanState:"pending",relationship:"unknown",observations:[],scanId:null})}));
vi.mock("@/lib/domain/products/repository",()=>({nextAvailableSlug:async()=>"sample",insert:state.insert}));
vi.mock("@/lib/domain/products/og",()=>({cacheOgImage:async()=>null}));
vi.mock("@/lib/crawl/classify",()=>({classifyCategory:async()=>null}));
vi.mock("@/lib/crawl/repository",()=>({
  getDocument:async()=>({repo:"acme/app",productUrl:"https://app.example",repoMeta:{description:"Useful project"},pageMeta:{title:"Sample",description:"A useful service"}}),
  getFrontierBuilder:async()=>"Claude",markPublished:state.published,
}));
import { publishCandidate } from "@/lib/crawl/publish";
const candidate={repo:"acme/app",productUrl:"https://app.example",decidedBy:"auto",state:"approved"} as CrawlCandidate;
beforeEach(()=>{state.enforce=false;state.insert.mockClear();state.published.mockClear();});
it("does not publish a legacy search hint as a builder", async()=>{
  expect((await publishCandidate(candidate)).ok).toBe(true);
  expect(state.insert).toHaveBeenCalledWith(expect.objectContaining({builder:null}),expect.any(Function));
});
it("rechecks pending evidence even for a previously approved candidate",async()=>{
  state.enforce=true;
  expect(await publishCandidate(candidate)).toMatchObject({ok:false,reason:"ai_evidence_pending"});
  expect(state.insert).not.toHaveBeenCalled();
});
