import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { loadAgentJudgeInput } from "@/lib/crawl/agent-evidence";
const scan = vi.hoisted(() => ({id:1,state:"complete",scope:"",detectorVersion:"2026-09-06.1",completedAt:new Date(),lastErrorCode:null as string|null}));
afterEach(()=>{scan.lastErrorCode=null;});
vi.mock("@/lib/domain/evidence/agents/repository", () => ({
  getLatestRepositoryAgentScan:async()=>scan,
  getLatestRepositoryAgentEvidence:async()=>({scan,observations:[]}),
}));
it("does not trust a repository's homepage alone", async () => {
  const input = await loadAgentJudgeInput({repo:"copy/app",pageMeta:{},fetchedAt:new Date()},DEFAULT_CRAWL_SETTINGS);
  expect(input.relationship).toBe("unknown");
});
it("holds a source link pointing at a different repository", async () => {
  const input = await loadAgentJudgeInput({repo:"copy/app",pageMeta:{repositoryKeys:["github:original/app"]},fetchedAt:new Date()},DEFAULT_CRAWL_SETTINGS);
  expect(input.relationship).toBe("conflict");
});
it("matches normalized repository source links", async () => {
  const input = await loadAgentJudgeInput({repo:"Acme/App",pageMeta:{repositoryKeys:["github:acme/app"]},fetchedAt:new Date()},DEFAULT_CRAWL_SETTINGS);
  expect(input.relationship).toBe("same_product");
});
it.each([new Date(Date.now()-25*3600_000),new Date(Date.now()+3600_000),new Date(NaN)])("does not confirm a relationship from stale or invalid site observation %s",async(fetchedAt)=>{
  const input=await loadAgentJudgeInput({repo:"acme/app",pageMeta:{repositoryKeys:["acme/app"]},fetchedAt},DEFAULT_CRAWL_SETTINGS);
  expect(input.relationship).toBe("unknown");
});
it("holds historical complete evidence after its latest recheck failed",async()=>{
  scan.lastErrorCode="unavailable";
  const input=await loadAgentJudgeInput({repo:"acme/app",pageMeta:{repositoryKeys:["acme/app"]},fetchedAt:new Date()},DEFAULT_CRAWL_SETTINGS);
  expect(input.scanState).toBe("pending");
});
