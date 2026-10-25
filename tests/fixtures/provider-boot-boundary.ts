import { localModelContractHash } from "@/lib/llm/local-model-serving-contract";
import { boundaryFixture } from "./provider-boundary-release";
export function bootBoundaryFixture() {
  const old = boundaryFixture(), hash = (s:string) => s.repeat(64);
  const servingContract = { version:1, protocol:"local-openai-chat-v1",backendId:"gpu3090-qwen",provider:"local-direct",physicalGroup:"gpu3090-qwen",
    endpoint:"http://100.77.43.63:8090/v1/chat/completions",model:"qwen3.8-flash-next",responseModel:"qwen3.8-flash-next",modelFamily:"qwen3.8-flash-next",
    deploymentRevision:"fixture-native-revision",contextWindowTokens:50000,totalTokenBound:50000,maxOutputTokens:3000,maxInputBytes:5242880,
    capabilities:{vision:true,jsonSchema:true},thinking:{mode:"disabled",parameter:"chat_template_kwargs.enable_thinking"},termination:{kind:"response_only"}} as const;
  const currentBootId="44444444-4444-4444-8444-444444444444", machineIdSha256=hash("9");
  const provider={kind:"direct_linux_host_reboot",host:"gpu3090",endpointAddress:"100.77.43.63",endpointPort:8090,machineIdSha256,tailscaleNodeId:"fixture-native-node",
    oldBootId:"55555555-5555-4555-8555-555555555555",currentBootId,endpointProofHash:hash("a"),
    oldJournal:{bootId:"55555555-5555-4555-8555-555555555555",machineIdSha256,firstAt:"2026-10-24T16:00:00.000000Z",lastAt:"2026-10-24T17:49:59.000000Z",artifactHash:hash("b")},
    currentJournal:{bootId:currentBootId,machineIdSha256,firstAt:"2026-10-24T17:51:01.000000Z",artifactHash:hash("c")}};
  const witness=(dbBefore:string,dbAfter:string,uptimeNs:string)=>({dbBefore,dbAfter,uptimeNs,bootId:currentBootId,hostBtimeAt:"2026-10-24T17:51:00.000Z",artifactHash:hash("d")});
  const plan={version:3,kind:"provider_boundary_plan",createdAt:old.plan.createdAt,
    request:{...old.plan.request,providerBudgetId:"gpu3090-qwen",groupId:"gpu3090-qwen",servingContractHash:localModelContractHash(servingContract)},control:old.plan.control,
    owner:old.plan.owner,gateways:[],provider,servingContract,
    transport:{kind:"single_direct_http",redirect:"error",attempts:1,proxy:false,durableQueue:false,sourceArtifactHash:hash("e")},
    ownerAssociation:{instanceId:old.plan.request.owner.instanceId,bootId:old.plan.request.owner.bootId,spawnedEventId:12,pid:279,runIdHash:hash("f")},
    localEnd:{eventId:13,evidenceHash:hash("1"),endedAt:"2026-10-24T17:50:00.000000Z",dispatches:1,terminals:1},
    bootWitness:witness("2026-10-24T17:59:57.000000Z","2026-10-24T17:59:59.000000Z","538000000000"),beforeArtifactHash:old.plan.beforeArtifactHash};
  const receipt={version:3,kind:"provider_boundary_receipt",planHash:hash("0"),owner:old.receipt.owner,gateways:[],
    provider:{identity:provider,observedAt:"2026-10-24T18:12:00.000Z",bootWitness:witness("2026-10-24T18:11:57.000000Z","2026-10-24T18:11:59.000000Z","1258000000000"),artifactHash:hash("2")}};
  return {plan,receipt,hash};
}
/** The same malformed evidence matrix is exercised by TypeScript and real PostgreSQL. */
export function invalidBootBoundaries(seed:{plan:unknown;receipt:unknown}) {
 const cases:{plan:unknown;receipt:unknown}[]=[], change=(path:string[],value:unknown,remove=false)=>{
  const x=JSON.parse(JSON.stringify(seed)) as typeof seed,parts=[...path],last=parts.pop()!;let at:unknown=x;
  for(const key of parts)at=(at as Record<string,unknown>)[key];
  if(remove)delete(at as Record<string,unknown>)[last];else(at as Record<string,unknown>)[last]=value;
  cases.push(x);
 };
 const visit=(value:unknown,path:string[])=>{if(!value||typeof value!=='object'||Array.isArray(value))return;
  for(const [key,v]of Object.entries(value)){change([...path,key],null);change([...path,key],undefined,true);visit(v,[...path,key]);}
  change([...path,'unexpected'],true);
 };
 visit(seed.plan,['plan']);visit(seed.receipt,['receipt']);
 for(const [path,value]of [
  [['plan','provider','endpointAddress'],'100.77.43.64'],[['plan','provider','endpointAddress'],'localhost'],
  [['plan','provider','endpointAddress'],'100.077.43.63'],[['plan','provider','endpointPort'],8080],
  [['plan','provider','oldBootId'],'44444444-4444-4444-8444-444444444444'],
  [['plan','provider','oldJournal','machineIdSha256'],'0'.repeat(64)],[['receipt','provider','identity','tailscaleNodeId'],'other-native-node'],
  [['plan','transport','attempts'],2],[['plan','transport','proxy'],true],[['plan','transport','durableQueue'],true],
  [['plan','gateways'],[{}]],[['receipt','gateways'],[{}]],[['receipt','provider','bootWitness','uptimeNs'],'1'],
  [['plan','bootWitness','uptimeNs'],'0'],[['plan','bootWitness','uptimeNs'],'1.5'],[['plan','localEnd','dispatches'],2],
 ]as [string[],unknown][])change(path,value);
 const future=JSON.parse(JSON.stringify(seed)) as {plan:{createdAt:string;control:{updatedAt:string}};receipt:unknown};
 future.plan.control.updatedAt=future.plan.createdAt.slice(0,23)+'999Z';cases.push(future);
 return cases;
}
