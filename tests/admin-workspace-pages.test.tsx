import { beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ admin: vi.fn(), redirect: vi.fn((url:string)=>{throw new Error(`redirect:${url}`);}) }));
vi.mock("@/lib/auth/admin",()=>({currentAdmin:fake.admin}));
vi.mock("next/navigation",()=>({redirect:fake.redirect}));
vi.mock("@/app/(operator)/admin/content/PrototypeContentViews",()=>({PrototypeSocialContent:function Social(){return null;},PrototypeNewsContent:function News(){return null;},PrototypeRankingContent:function Ranking(){return null;}}));
vi.mock("@/app/(operator)/admin/settings/PrototypeSettingsViews",()=>({PrototypeCollectionSettings:function Collection(){return null;},PrototypeEvidenceSettings:function Evidence(){return null;},PrototypeIntegrationsSettings:function Integrations(){return null;},PrototypeSettingsHistory:function History(){return null;}}));
import Content from "@/app/(operator)/admin/content/page";
import Settings from "@/app/(operator)/admin/settings/page";
import {PrototypeSocialContent,PrototypeNewsContent,PrototypeRankingContent} from "@/app/(operator)/admin/content/PrototypeContentViews";
import {PrototypeCollectionSettings,PrototypeEvidenceSettings,PrototypeIntegrationsSettings,PrototypeSettingsHistory} from "@/app/(operator)/admin/settings/PrototypeSettingsViews";
const props=(query:Record<string,string|string[]|undefined>)=>({searchParams:Promise.resolve(query)});
beforeEach(()=>{vi.clearAllMocks();fake.admin.mockResolvedValue({login:"operator"});});
describe("prototype server workspaces",()=>{
  it.each([["social",PrototypeSocialContent],["news",PrototypeNewsContent],["ranking",PrototypeRankingContent]])("routes %s to the prototype view and preserves query context",async(tab,view)=>{
    const query={tab:tab as string,state:"hidden",id:"52"};
    const page=await Content(props(query));
    expect(page.type).toBe("main");expect(page.props.children[1].type).toBe(view);
    if(tab!=="ranking")expect(page.props.children[1].props.query).toEqual(query);
  });
  it.each([["collection",PrototypeCollectionSettings],["evidence",PrototypeEvidenceSettings],["integrations",PrototypeIntegrationsSettings],["history",PrototypeSettingsHistory]])("routes settings %s without rendering a legacy whole page",async(tab,view)=>{
    const page=await Settings(props({tab:tab as string}));expect(page.props.children[1].type).toBe(view);
  });
  it("uses defaults for an ambiguous tab and authenticates before selecting any view",async()=>{
    expect((await Content(props({tab:["news","ranking"]}))).props.children[1].type).toBe(PrototypeSocialContent);
    fake.admin.mockResolvedValue(null);await expect(Content(props({}))).rejects.toThrow("redirect:/admin/login");await expect(Settings(props({}))).rejects.toThrow("redirect:/admin/login");
  });
});
