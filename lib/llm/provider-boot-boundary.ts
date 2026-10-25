import { z } from "zod";
const sha=z.string().regex(/^[a-f0-9]{64}$/), uuid=z.uuid().regex(/^[a-f0-9-]+$/);
const text=(max:number)=>z.string().min(1).max(max).refine(v=>v===v.trim()&&!/[\u0000-\u001f\u007f]/.test(v));
export const bootDatabaseAt=z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/)
 .refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===`${v.slice(0,23)}Z`);
const at=z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
 .refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
/** DB clock plus CLOCK_BOOTTIME supplies the reboot interval; host wall time is only a cross-check. */
export const bootWitnessSchema=z.object({dbBefore:bootDatabaseAt,dbAfter:bootDatabaseAt,
 uptimeNs:z.string().regex(/^[1-9][0-9]{0,19}$/),bootId:uuid,hostBtimeAt:at,artifactHash:sha}).strict();
export type BootWitness=z.infer<typeof bootWitnessSchema>;
export const bootMicroseconds=(at:string)=>BigInt(Date.parse(at))*BigInt("1000")+BigInt(at.length===27?at.slice(23,26):"0");
export function bootInterval(w:BootWitness){const n=BigInt(w.uptimeNs);return {lower:bootMicroseconds(w.dbBefore)-(n+BigInt("999"))/BigInt("1000")-BigInt("1"),
 upper:bootMicroseconds(w.dbAfter)-n/BigInt("1000")+BigInt("1")};}
export function validBootWitness(w:BootWitness,bootId:string,observedAt:string){
 const before=bootMicroseconds(w.dbBefore),after=bootMicroseconds(w.dbAfter),observed=bootMicroseconds(observedAt),b=bootInterval(w),wall=bootMicroseconds(w.hostBtimeAt);
 return w.bootId===bootId&&before<=after&&after-before<=BigInt("5000000")&&after<=observed&&observed-after<=BigInt("300000000")
  &&wall>=b.lower-BigInt("1000000")&&wall<=b.upper+BigInt("1000000");
}
const journalBase={bootId:uuid,machineIdSha256:sha,firstAt:bootDatabaseAt,artifactHash:sha};
export const bootProviderIdentitySchema=z.object({kind:z.literal("direct_linux_host_reboot"),host:text(120),endpointAddress:z.ipv4(),
 endpointPort:z.number().int().min(1).max(65535),machineIdSha256:sha,tailscaleNodeId:text(120),oldBootId:uuid,currentBootId:uuid,
 endpointProofHash:sha,oldJournal:z.object({...journalBase,lastAt:bootDatabaseAt}).strict(),currentJournal:z.object(journalBase).strict()}).strict()
 .refine(p=>p.oldBootId!==p.currentBootId&&p.oldJournal.bootId===p.oldBootId&&p.currentJournal.bootId===p.currentBootId
  &&p.oldJournal.machineIdSha256===p.machineIdSha256&&p.currentJournal.machineIdSha256===p.machineIdSha256
  &&p.oldJournal.firstAt<=p.oldJournal.lastAt,"native_boot_identity");
export const bootLocalEndSchema=z.object({eventId:z.number().int().positive().safe(),evidenceHash:sha,endedAt:bootDatabaseAt,
 dispatches:z.literal(1),terminals:z.literal(1)}).strict();
export const bootOwnerAssociationSchema=z.object({instanceId:text(120),bootId:uuid,spawnedEventId:z.number().int().positive().safe(),
 pid:z.number().int().min(2).max(2147483647),runIdHash:sha}).strict();
export const bootTransportSchema=z.object({kind:z.literal("single_direct_http"),redirect:z.literal("error"),attempts:z.literal(1),
 proxy:z.literal(false),durableQueue:z.literal(false),sourceArtifactHash:sha}).strict();
