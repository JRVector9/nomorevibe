import { cloneElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fake=vi.hoisted(()=>({overview:vi.fn(),held:vi.fn(),audit:vi.fn(),published:vi.fn(),recheck:vi.fn(),products:vi.fn(),control:vi.fn(),summary:vi.fn(),queue:vi.fn()}));
vi.mock("@/lib/crawl/product-audit",()=>({productAuditOverview:fake.overview,listHeldFindings:fake.held,listAuditFindings:fake.audit}));
vi.mock("@/lib/crawl/second-review",()=>({publishedSecondReviews:fake.published}));
vi.mock("@/lib/domain/products/recheck",()=>({recheckPublishedProducts:fake.recheck}));
vi.mock("@/lib/domain/products/repository",()=>({listProducts:fake.products}));
vi.mock("@/lib/domain/products/translation-admin",()=>({productTranslationAdminSummary:fake.summary,productTranslationAdminQueue:fake.queue}));
vi.mock("@/lib/crawl/settings",()=>({getSettings:async()=>({judge:{}})}));
vi.mock("@/lib/auth/admin",()=>({authSecret:()=>"unit-test-only-admin-secret"}));
vi.mock("@/lib/db",()=>({db:{select:()=>({from:()=>({where:()=>({limit:()=>fake.control()})})})}}));
vi.mock("@/app/(operator)/admin/audit/AuditControls",()=>({AuditHoldSettingsForm:()=>null,CancelAudit:()=>null,RestartStalledAudit:()=>null,StartAudit:()=>null}));
vi.mock("@/app/(operator)/admin/audit/second-opinion-label",()=>({secondOpinionLabel:(opinion:{model:string;decision:string})=>`${opinion.model} ${opinion.decision}`}));
vi.mock("@/app/(operator)/admin/products/BanAction",()=>({BanAction:()=>null}));
vi.mock("@/app/(operator)/admin/products/PrototypeQualityActions",()=>({PrototypeQualityDecision:({kind,id,slug}:{kind:string;id:number;slug:string})=><span data-kind={kind} data-id={id} data-slug={slug}>유지·내림</span>}));
vi.mock("@/app/(operator)/admin/translations/TranslationRetryForm",()=>({TranslationRetryForm:({item}:{item:{sourceHash:string}})=><span data-retry-source={item.sourceHash}>원본 판 재요청</span>}));
import {PrototypeQualityWorkspace,prototypeQualityMode} from "@/app/(operator)/admin/products/PrototypeProductQuality";
import {PrototypeTranslationsWorkspace} from "@/app/(operator)/admin/products/PrototypeProductWorkspaces";

/** Resolve async server children while leaving ordinary/client components to React's renderer. */
async function resolve(node:ReactNode):Promise<ReactNode>{
  if(Array.isArray(node))return Promise.all(node.map(async(child,index)=>{const resolved=await resolve(child);return isValidElement(resolved)?cloneElement(resolved,{key:resolved.key??String(index)}):resolved;}));
  if(!isValidElement<{children?:ReactNode}>(node))return node;
  if(typeof node.type==="function"&&node.type.constructor.name==="AsyncFunction")return resolve(await(node.type as unknown as (props:unknown)=>Promise<ReactNode>)(node.props));
  return cloneElement(node,{},await resolve(node.props.children));
}
const render=async(node:ReactNode)=>renderToStaticMarkup(await resolve(node));
beforeEach(()=>{vi.clearAllMocks();fake.overview.mockResolvedValue(null);fake.held.mockResolvedValue([]);fake.audit.mockResolvedValue([]);fake.published.mockResolvedValue([]);fake.recheck.mockResolvedValue({hits:[],checked:0,withoutText:0});fake.products.mockResolvedValue([]);fake.control.mockResolvedValue([]);fake.summary.mockResolvedValue([]);fake.queue.mockResolvedValue({items:[],count:0,nextCursor:null});});
describe("prototype quality sources",()=>{
  it("switches among exactly the four inspection contexts and bounds unknown modes",async()=>{
    expect(prototypeQualityMode("constructor")).toBe("audit");
    const html=await render(await PrototypeQualityWorkspace({mode:"audit"}));
    for(const label of ["AI 감사·정책","공개분 2차","규칙 재검수","생존·저장소"])expect(html).toContain(label);
    expect(html).toMatch(/<button(?=[^>]*value="audit")(?=[^>]*aria-pressed="true")(?=[^>]*name="mode")[^>]*>/);
  });
  it("shows actual audit evidence and additional opinions and carries the original item ID to actions",async()=>{
    fake.held.mockResolvedValue([{id:81,slug:"actual-project",name:"Actual Project",url:"https://actual.example",reviewedAt:null,heldAt:new Date(),reason:"원본 근거",confidence:.91,screenJudged:true,second:[{model:"observed-model",decision:"approve",source:"api",reason:"독립 의견"}]}]);
    const html=await render(await PrototypeQualityWorkspace());
    for(const text of ["원본 근거","observed-model","독립 의견",'data-id="81"','data-slug="actual-project"',"감사 운영 설정"])expect(html).toContain(text);
    expect(fake.published).not.toHaveBeenCalled();
  });
  it("uses the published-review ledger in the second context without mixing candidate rejection",async()=>{
    fake.published.mockResolvedValue([{id:29,publishedSlug:"published-real",repo:"owner/repo",reviewedAt:null,trigger:"risk",secondDecision:"reject",secondReason:"공개분 근거",secondConfidence:.93,autoOpinion:null}]);
    const html=await render(await PrototypeQualityWorkspace({mode:"second"}));
    expect(fake.published).toHaveBeenCalledWith(25);expect(fake.overview).not.toHaveBeenCalled();expect(html).toContain('data-kind="published"');expect(html).toContain("공개분 근거");
  });
  it("keeps missing-body rule results separate from completed checks",async()=>{
    fake.recheck.mockResolvedValue({hits:[],checked:120,withoutText:7});
    const html=await render(await PrototypeQualityWorkspace({mode:"rules",offset:"-4"}));
    expect(fake.recheck).toHaveBeenCalledWith({judge:{}},{limit:200,offset:0});expect(html).toContain("본문 근거 부족 7개는 확인 미완료");
  });
  it("reads actual confirmation/dispatch/application flags and deduplicates overlapping uptime targets",async()=>{
    fake.control.mockResolvedValue([{confirmationRequired:true,dispatchEnabled:true,applyEnabled:false}]);
    fake.products.mockResolvedValue([{slug:"same-project",name:"Same Actual",repoStatus:"not_found"}]);
    const html=await render(await PrototypeQualityWorkspace({mode:"uptime"}));
    expect(html).toContain("확인 소비 ON");expect(html).toContain("적용 OFF");expect(html.match(/<b>Same Actual<\/b>/g)).toHaveLength(1);expect(fake.products).toHaveBeenCalledTimes(2);
  });
  it("does not render failed reads as empty queues",async()=>{
    fake.held.mockRejectedValue(new Error("bounded read failed"));
    const html=await render(await PrototypeQualityWorkspace());expect(html).toContain("읽지 못했습니다");expect(html).not.toContain("사람이 볼 감사 대상이 없습니다");
  });
});
describe("prototype translation demand",()=>{
  it("uses three distinct metrics, current-source text, and only recoverable original demands",async()=>{
    fake.summary.mockResolvedValue([{locale:"en",field:"tagline",pending:4,failed:9,ready:2,lastSavedAt:null}]);
    fake.queue.mockResolvedValue({count:9,nextCursor:"next-source-cursor",items:[{productId:7,slug:"actual-project",name:"Actual Project",locale:"en",field:"tagline",sourceText:"현재 실제 소개",sourceMatches:false,sourceHash:"saved-source",recovery:"new_source",recoveryReason:"new_source",errorCode:"transport",attempts:2,model:"actual-model",updatedAt:"2026-11-04T00:00:00Z",retryAt:null},{productId:8,slug:"exhausted",name:"Exhausted",locale:"en",field:"tagline",sourceText:"다른 현재 소개",sourceMatches:true,sourceHash:"must-not-retry",recovery:null,recoveryReason:"exhausted",attempts:4,updatedAt:"2026-11-04T00:00:00Z",retryAt:null}]});
    const html=await render(await PrototypeTranslationsWorkspace({admin:{login:"operator",exp:99},query:""}));
    expect(html).toContain('class="grid three"');for(const text of ["프로젝트","현재 소개","언어·원본","후처리 상태","다음 행동","현재 실제 소개","번역 작업의 실행"])expect(html).toContain(text);
    expect(html).toContain('data-retry-source="saved-source"');expect(html).not.toContain('data-retry-source="must-not-retry"');expect(html).toContain("next-source-cursor");
    expect(fake.queue).toHaveBeenCalledWith({state:"failed",q:"",cursor:undefined,limit:20});
  });
});
