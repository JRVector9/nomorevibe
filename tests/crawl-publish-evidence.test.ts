import { HttpOriginPermitError } from "@/lib/net/http-origin-policy";
import { beforeEach, expect, it, vi } from "vitest";
import type { CrawlCandidate } from "@/lib/db/schema";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
const state = vi.hoisted(() => ({enforce:false,insert:vi.fn(),published:vi.fn(),og:vi.fn(),request:vi.fn(),
  document:{repo:"acme/app",productUrl:"https://app.example",pageStatus:200,repoMeta:{description:"Useful project"},pageMeta:{title:"Sample",description:"A useful service",ogImage:undefined as string|undefined}}}));
vi.mock("@/lib/crawl/settings",()=>({getSettings:async()=>({...DEFAULT_CRAWL_SETTINGS,agentEvidence:{...DEFAULT_CRAWL_SETTINGS.agentEvidence,enforceEligibility:state.enforce}})}));
vi.mock("@/lib/crawl/agent-evidence",()=>({loadAgentJudgeInput:async()=>({scanState:"pending",relationship:"unknown",observations:[],scanId:null})}));
vi.mock("@/lib/domain/products/repository",()=>({nextAvailableSlug:async()=>"sample",insert:state.insert,findRepositoryProduct:async()=>undefined}));
vi.mock("@/lib/domain/products/og",()=>({cacheOgImage:state.og}));
vi.mock("@/lib/domain/evidence/ai-level-store",()=>({storedAiLevel:async()=>null}));
vi.mock("@/lib/crawl/classify",()=>({classifyCategory:async()=>null}));
vi.mock("@/lib/crawl/repository",()=>({
  getDocument:async()=>state.document,
  getFrontierBuilder:async()=>"Claude",markPublished:state.published,
}));
vi.mock("@/lib/jobs/control",()=>({requestJob:state.request}));
import { publishCandidate } from "@/lib/crawl/publish";
import { judgeRevision } from "@/lib/crawl/rules";
// 운영의 판정 잡처럼 판정이 본 원본의 리비전을 남긴다 — 없으면 발행이 "그 원본인가"를 못 가려 멈춘다
const candidate={repo:"acme/app",productUrl:"https://app.example",decidedBy:"auto",state:"approved",
  signals:{judgedRevision:judgeRevision(state.document)}} as unknown as CrawlCandidate;
beforeEach(()=>{state.enforce=false;state.insert.mockClear();state.published.mockClear();state.og.mockReset();state.request.mockResolvedValue(undefined);});
it("does not publish a legacy search hint as a builder", async()=>{
  expect((await publishCandidate(candidate)).ok).toBe(true);
  expect(state.insert).toHaveBeenCalledWith(expect.objectContaining({builder:null}),expect.any(Function), undefined);
});
it("passes the publisher's actual lease through the final insertion boundary", async()=>{
  const lease = { name:"crawl-publish", token:"00000000-0000-4000-8000-000000000078", requestedVersion:7 };
  expect((await publishCandidate(candidate, lease)).ok).toBe(true);
  expect(state.insert).toHaveBeenCalledWith(expect.objectContaining({builder:null}),expect.any(Function), lease);
});
it("rechecks pending evidence even for a previously approved candidate",async()=>{
  state.enforce=true;
  expect(await publishCandidate(candidate)).toMatchObject({ok:false,reason:"ai_evidence_pending"});
  expect(state.insert).not.toHaveBeenCalled();
});

it("a published product remains successful when optional OG transport is deferred", async () => {
  const old = state.document.pageMeta;
  state.document.pageMeta = { ...old, ogImage: "https://app.example/icon.png" };
  state.og.mockRejectedValue(new HttpOriginPermitError("unavailable"));
  try {
    const current = { ...candidate, signals: { judgedRevision: judgeRevision(state.document) } };
    expect(await publishCandidate(current)).toMatchObject({ ok: true, slug: "sample" });
    expect(state.insert).toHaveBeenCalledTimes(1);
    expect(state.request).toHaveBeenCalledWith("product-thumbnail-refresh");
  } finally { state.document.pageMeta = old; }
});
