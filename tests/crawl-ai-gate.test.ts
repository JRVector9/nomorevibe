import { expect, it } from "vitest";
import { judge } from "@/lib/crawl/rules";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";

const settings = {...DEFAULT_CRAWL_SETTINGS,agentEvidence:{...DEFAULT_CRAWL_SETTINGS.agentEvidence,enforceEligibility:true}};
const repo = {repo:"acme/calculator",stars:200,isFork:false,ownerType:"User",pushedAt:new Date(),archived:false,description:"Calculator for everyone"};
const page = {productUrl:"https://calculator.example",status:200};
it("holds a recent popular product until AI development evidence is collected", () => {
  expect(judge(repo,page,settings)).toMatchObject({state:"needs_review",reason:"ai_evidence_pending"});
});
it("does not mistake absent public evidence for proven non-AI authorship", () => {
  expect(judge(repo,page,settings,new Date(),{scanState:"complete",relationship:"same_product",observations:[]}))
    .toMatchObject({state:"needs_review",reason:"ai_evidence_not_found"});
});
it("holds a detached copy pointing at someone else's canonical service", () => {
  expect(judge(repo,page,settings,new Date(),{scanState:"complete",relationship:"conflict",observations:[]}))
    .toMatchObject({state:"needs_review",reason:"repository_relationship_conflict"});
});
