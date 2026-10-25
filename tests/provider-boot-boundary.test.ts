import {expect,it} from "vitest";
import {providerBoundaryCanonicalHash,providerBoundaryPlanSchema,providerBoundaryReceiptSchema,validateProviderBoundary} from "@/lib/llm/provider-boundary-contract";
import {modelDispatchReleaseEvidenceSchema} from "@/lib/llm/capacity";
import {bootBoundaryFixture,invalidBootBoundaries} from "./fixtures/provider-boot-boundary";
function fixture(){const {plan,receipt}=bootBoundaryFixture();receipt.planHash=providerBoundaryCanonicalHash(plan);return {plan,receipt};}
it("a direct host reboot after the exact local end releases physical capacity without a new provider stop",()=>{
 const {plan,receipt}=fixture();
 expect(providerBoundaryPlanSchema.safeParse(plan).success).toBe(true);
 expect(providerBoundaryReceiptSchema.safeParse(receipt).success).toBe(true);
 expect(modelDispatchReleaseEvidenceSchema.safeParse({version:1,kind:"provider_boundary_exit",requestId:plan.request.requestId,owner:plan.request.owner,
  fromState:"indeterminate",dispatchAt:plan.request.dispatchAt,bindingHash:plan.request.bindingHash,notBefore:receipt.provider.observedAt,
  evaluatedAt:"2026-10-24T18:13:00.000Z",operator:"fixture",reference:"fixture raw reboot proof",plan,receipt}).success).toBe(true);
});
it("wrong native endpoint/machine/boot, proxy/retry/extra fields and microsecond borderline clocks fail closed",()=>{
 for(const mutate of [
  (x:ReturnType<typeof fixture>)=>{x.plan.provider.endpointAddress="100.77.43.64";},
  (x:ReturnType<typeof fixture>)=>{x.plan.provider.oldJournal.machineIdSha256="0".repeat(64);},
  (x:ReturnType<typeof fixture>)=>{x.plan.provider.oldBootId=x.plan.provider.currentBootId;},
  (x:ReturnType<typeof fixture>)=>{x.plan.bootWitness.bootId=x.plan.provider.oldBootId;},
  (x:ReturnType<typeof fixture>)=>{x.plan.bootWitness.dbAfter="2026-10-24T18:00:04.000000Z";},
  (x:ReturnType<typeof fixture>)=>{x.plan.localEnd.endedAt="2026-10-24T17:50:58.999999Z";},
  (x:ReturnType<typeof fixture>)=>{x.plan.transport.attempts=2;},
  (x:ReturnType<typeof fixture>)=>{x.plan.transport.proxy=true;},
  (x:ReturnType<typeof fixture>)=>{Object.assign(x.plan,{extra:true});},
 ]){const x=fixture();mutate(x);expect(providerBoundaryPlanSchema.safeParse(x.plan).success).toBe(false);}
});
it("receipt must observe the same host boot after actual owner exit with a fresh overlapping boot interval",()=>{
 const x=fixture(),p=providerBoundaryPlanSchema.parse(x.plan),r=providerBoundaryReceiptSchema.parse(x.receipt);
 expect(validateProviderBoundary(p,r,"2026-10-24T18:13:00.000Z")).toBe(true);
 for(const mutate of [
  (v:typeof x)=>{v.receipt.provider.identity.machineIdSha256="0".repeat(64);},
  (v:typeof x)=>{v.receipt.provider.observedAt="2026-10-24T18:09:59.000Z";},
  (v:typeof x)=>{v.receipt.provider.bootWitness.uptimeNs="1200000000000";},
  (v:typeof x)=>{v.receipt.planHash="0".repeat(64);},
 ]){const v=structuredClone(x);mutate(v);const rr=providerBoundaryReceiptSchema.safeParse(v.receipt);expect(rr.success&&validateProviderBoundary(p,rr.data,"2026-10-24T18:13:00.000Z")).toBe(false);}
 expect(validateProviderBoundary(p,r,"2026-10-24T18:18:00.000Z")).toBe(false);
});
it('DB local-end comparison retains the last microsecond instead of rounding it into admission',()=>{
 const x=fixture(),iso=(us:string)=>{const n=BigInt(us),ms=n/BigInt(1000);return new Date(Number(ms)).toISOString().slice(0,23)+(n%BigInt(1000)).toString().padStart(3,'0')+'Z';};
 const lower=BigInt(Date.parse(x.plan.bootWitness.dbBefore))*BigInt(1000)-(BigInt(x.plan.bootWitness.uptimeNs)+BigInt(999))/BigInt(1000)-BigInt(1);
 for(const delta of [-1,0,1]){const p=structuredClone(x.plan);p.localEnd.endedAt=iso(String(lower+BigInt(delta)));expect(providerBoundaryPlanSchema.safeParse(p).success).toBe(delta===-1);}
});

it('strict missing/null/extra-key and native topology negatives fail the full release schema',()=>{const{plan,receipt}=fixture();for(const value of invalidBootBoundaries({plan,receipt})){const p=value.plan as Record<string,unknown>;const r=value.receipt as Record<string,unknown>;if(p&&r&&r.planHash===receipt.planHash)r.planHash=providerBoundaryCanonicalHash(p);expect(modelDispatchReleaseEvidenceSchema.safeParse({version:1,kind:'provider_boundary_exit',requestId:plan.request.requestId,owner:plan.request.owner,fromState:'indeterminate',dispatchAt:plan.request.dispatchAt,bindingHash:plan.request.bindingHash,notBefore:receipt.provider.observedAt,evaluatedAt:'2026-10-24T18:13:00.000Z',operator:'fixture',reference:'synthetic strict matrix',...value}).success).toBe(false);}});
