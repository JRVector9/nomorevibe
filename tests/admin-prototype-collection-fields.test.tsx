import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CRAWL_SETTINGS, crawlSettingsSchema } from "@/lib/crawl/settings-schema";
import { prototypeCollectionFields, prototypeCollectionSettings } from "@/lib/operations/admin-prototype-collection-fields";

const fake=vi.hoisted(()=>({save:vi.fn(),admin:vi.fn()}));
vi.mock("@/lib/auth/admin",()=>({currentAdmin:fake.admin}));
vi.mock("@/lib/crawl/settings",()=>({saveSettings:fake.save,settingsFormVersion:()=>"new-form-version",resetSettings:vi.fn()}));
vi.mock("@/lib/operations/dr/web-gate",()=>({webWriteAction:(action:unknown)=>action}));
vi.mock("@/lib/operations/admin-log",()=>({recordAdminAction:vi.fn(),recordAdminActions:vi.fn()}));
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
vi.mock("next/navigation",()=>({useRouter:()=>({refresh:vi.fn()})}));
import {saveCrawlSettings} from "@/app/(operator)/admin/actions";
import {PrototypeCollectionForm} from "@/app/(operator)/admin/settings/PrototypeCollectionForm";

const settings=()=>crawlSettingsSchema.parse(structuredClone(DEFAULT_CRAWL_SETTINGS));
const payload=(values:Record<string,string>)=>{const form=new FormData();for(const [key,value]of Object.entries(values))form.set(key,value);form.set("settingsVersion","original-form-version");return form;};
beforeEach(()=>{vi.clearAllMocks();fake.admin.mockResolvedValue({login:"operator"});fake.save.mockResolvedValue({ok:true,settings:settings()});});
describe("prototype collection form preserves the existing action contract",()=>{
  it("sends the expected form version and all untouched hidden settings through the existing parser",async()=>{
    const original=settings();original.judge.blockedHomepageDomains=["blocked.example"];original.judge.excludeOrganizations=true;original.discover.queries[0].priority=87;
    const fields=prototypeCollectionFields(original);fields.windowDays="21";
    await saveCrawlSettings(null,payload(fields));
    const [patch,actor,version]=fake.save.mock.calls[0];
    expect(actor).toBe("operator");expect(version).toEqual({expectedFormVersion:"original-form-version"});
    expect(patch.discover.windowDays).toBe(21);expect(patch.discover.queries).toEqual(original.discover.queries.map(query=>({...query,requireEvidence:query.requireEvidence??false})));
    expect(patch.judge).toEqual(Object.fromEntries(Object.keys(patch.judge).map(key=>[key,original.judge[key as keyof typeof original.judge]])));expect(patch.judge).not.toHaveProperty("docsGenerators");expect(patch).not.toHaveProperty("qwenAuto");expect(patch.secondReview).toEqual({enabled:original.secondReview.enabled,includeAiHeld:original.secondReview.includeAiHeld,sampleRate:original.secondReview.sampleRate,agreeAt:original.secondReview.agreeAt});
    expect(patch.agentEvidence).toEqual({enabled:original.agentEvidence.enabled,enforceEligibility:original.agentEvidence.enforceEligibility});expect(patch.reviewConcurrency).toBe(original.reviewConcurrency);expect(patch.rising).toEqual(original.rising);
    expect(patch).not.toHaveProperty("enabled");expect(patch).not.toHaveProperty("firstReview");
  });
  it.each([true,false])("does not let a preserved hidden checkbox override visible choice %s",async enabled=>{
    const original=settings();original.judge.excludeForks=!enabled;original.judge.holdAmbiguous=!enabled;
    const form=payload(prototypeCollectionFields(original));
    form.delete("excludeForks");form.delete("holdAmbiguous");if(enabled){form.set("excludeForks","on");form.set("holdAmbiguous","on");}
    await saveCrawlSettings(null,form);expect(fake.save.mock.calls[0][0].judge).toMatchObject({excludeForks:enabled,holdAmbiguous:enabled});
    const html=renderToStaticMarkup(createElement(PrototypeCollectionForm,{settings:original,version:"original-form-version"}));
    expect((html.match(/name="excludeForks"/g)??[]).length).toBe(1);expect((html.match(/name="holdAmbiguous"/g)??[]).length).toBe(1);
    expect(html).toContain('name="settingsVersion" value="original-form-version"');
  });
  it("passes a stale-version refusal through without reporting success",async()=>{
    fake.save.mockResolvedValue({ok:false,issues:["설정 판이 바뀌었습니다"]});
    await expect(saveCrawlSettings(null,payload(prototypeCollectionFields(settings())))).resolves.toEqual({issues:["설정 판이 바뀌었습니다"]});
  });
  it("sends only explicit form fields and no model connection secrets",()=>{
    const fields=prototypeCollectionFields(settings());
    expect(Object.keys(fields).some(key=>/secret|token|api.?key|ciphertext/i.test(key))).toBe(false);
    expect(Object.keys(fields).some(key=>key.startsWith("query."))).toBe(true);
    const dto=prototypeCollectionSettings(settings());expect(dto).not.toHaveProperty("stageModelPools");expect(dto).not.toHaveProperty("classify");expect(dto.secondReview).not.toHaveProperty("voters");expect(dto.judge).not.toHaveProperty("docsGenerators");
  });
});
