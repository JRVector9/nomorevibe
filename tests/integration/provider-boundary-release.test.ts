import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { ai2DispatchBindingHash, modelCapacityPolicyHash, type Ai2DispatchBinding, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { itemBindingHash, type Ai2ItemBinding } from "@/lib/jobs/items/types";
import { providerBoundaryCanonicalHash, providerBoundaryPlanHash, providerBoundaryPlanSchema, providerBoundaryReceiptSchema } from "@/lib/llm/provider-boundary-contract";
import { releaseProviderBoundaryRequest } from "@/lib/operations/dr/provider-boundary-release";
import { readCommittedRelayBoundaryProof } from '@/lib/operations/dr/provider-boundary-relay';
import { CAPACITY_MONITOR_DEFAULTS, readModelCapacityUnknowns } from '@/lib/operations/model-capacity-unknowns';
import { boundaryFixture } from "../fixtures/provider-boundary-release";
import { TEST_DATABASE_URL } from "./setup";

// Test-only metadata rows; no model endpoint, terminal issuance, production DB or process stop is used.
const root = fileURLToPath(new URL("../..", import.meta.url)), name = `nomorevibe_test_boundary_${randomUUID().replaceAll("-", "")}`;
const url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
const client = postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {} });
const journal = JSON.parse(readFileSync(path.join(root,"drizzle/meta/_journal.json"),"utf8"));
const names = ["model_capacity_requests_logical_check","model_capacity_requests_members_check","model_capacity_requests_dispatch_check","model_capacity_requests_terminal_check","model_capacity_events_kind_check"];
let prior: Record<string,string>, beforeRows: unknown[], created = false;
const fx = boundaryFixture(), token = randomUUID(), requestId = randomUUID();
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 3, providerLimits: { "abcllm-supa": 1 }, groupLimits: { supa: 1 },
  poolLimits: { reviewer: 2, text: 1 }, weights: { first: 4, second: 2, background: 1 }, maxWaiting: 20, queueTtlMs: 120_000, reservationTtlMs: 30_000,
  routes: [{ routeId: "second-review", provider: "abcllm", model: "Fixture Model", providerBudgetId: "abcllm-supa", groupId: "supa" }] };
const owner = fx.plan.request.owner, hash = "a".repeat(64);
const review: Ai2ItemBinding = { stage: "ai2", candidateId: 17, secondReviewId: 29, source: { kind: "first_attempt", firstAttemptId: 13 },
  inputHash: hash, sourceRevisionHash: hash, policyHash: hash, promptVersion: "p1", rulesVersion: "r1",
  reviewer: { provider: "abcllm", model: "Fixture Model" }, generationKey: hash, vote: 29, fallbackForId: null };
const binding: Ai2DispatchBinding = { kind: "ai2_item_gateway", version: 1, logicalWorkKey: "ai2:17:29", review, rowIdentityHash: hash,
  failureCount: 0, inputPolicyHash: hash, item: { workKey: "ai2:29", owner, token: randomUUID(), stageEpoch: 1, itemEpoch: 1, bindingHash: itemBindingHash(review) },
  routeId: "second-review", provider: "abcllm", model: "Fixture Model", wireHash: hash, servingContractHash: fx.plan.request.servingContractHash,
  totalTokenBound: 98304, chargedTokens: 98304 };
function fresh() {
  const now = Date.now(), iso = (ms: number) => new Date(now-ms).toISOString();
  const plan = structuredClone(fx.plan); plan.request = { ...plan.request, requestId, tokenHash: createHash("sha256").update(token).digest("hex"),
    policyHash: modelCapacityPolicyHash(policy), bindingHash: ai2DispatchBindingHash(binding), dispatchAt: iso(3_600_000) };
  plan.control.policyHash = plan.request.policyHash; plan.createdAt = iso(30_000);
  for (const p of [plan.owner,...plan.gateways,plan.provider]) p.startedAt=iso(7_200_000);
  const receipt = structuredClone(fx.receipt); receipt.owner.identity=plan.owner; receipt.owner.observedAt=iso(20_000);
  receipt.gateways.forEach((g,i)=>{g.identity=plan.gateways[i];g.observedAt=iso(15_000-i*1000);});
  receipt.provider.identity=plan.provider;receipt.provider.observedAt=iso(10_000);receipt.planHash=providerBoundaryPlanHash(plan);
  const parsedPlan=providerBoundaryPlanSchema.parse(plan),parsedReceipt=providerBoundaryReceiptSchema.parse(receipt);
  if(parsedPlan.version!==1||parsedReceipt.version!==1) throw new Error("expected_v1_fixture");
  return { plan: parsedPlan, receipt: parsedReceipt };
}
let frozen: ReturnType<typeof fresh>;
async function defs() { return Object.fromEntries((await client<{conname:string;def:string}[]>`SELECT conname,pg_get_constraintdef(oid) def FROM pg_constraint WHERE conname=ANY(${names}::text[])`).map(x=>[x.conname,x.def])); }
async function rows() { return client`SELECT to_jsonb(r) value FROM model_capacity_requests r ORDER BY request_id`; }
beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`); created=true;
  const partial=mkdtempSync(path.join(tmpdir(),"boundary-predecessor-"));
  try {
    mkdirSync(path.join(partial,"meta")); const entries=journal.entries.filter((e:{idx:number})=>e.idx<126);
    for(const e of entries) copyFileSync(path.join(root,"drizzle",`${e.tag}.sql`),path.join(partial,`${e.tag}.sql`));
    writeFileSync(path.join(partial,"meta/_journal.json"),JSON.stringify({...journal,entries}));
    await migrate(drizzle(client),{migrationsFolder:partial});
  } finally { rmSync(partial,{recursive:true,force:true}); }
  frozen=fresh(); prior=await defs();
  await client`UPDATE model_capacity_control SET mode='draining',epoch=1,revision=2,policy=${JSON.stringify(policy)}::jsonb,policy_hash=${modelCapacityPolicyHash(policy)},updated_at=${frozen.plan.control.updatedAt} WHERE id=1`;
  await client`INSERT INTO model_capacity_requests(request_id,work_key,owner_instance_id,owner_boot_id,class,pool,route_id,provider,model,provider_budget_id,group_id,epoch,revision,policy_hash,state,logical_work_key,dispatch_binding,dispatch_binding_hash,dispatched_at,token,reserved_until,queue_until)
    VALUES(${requestId},${`${binding.logicalWorkKey}:${binding.item.bindingHash}`},${owner.instanceId},${owner.bootId},'second','reviewer','second-review','abcllm','Fixture Model','abcllm-supa','supa',1,2,${modelCapacityPolicyHash(policy)},'indeterminate',${binding.logicalWorkKey},${JSON.stringify(binding)}::jsonb,${ai2DispatchBindingHash(binding)},${frozen.plan.request.dispatchAt},${token},clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 minute')`;
  await client`INSERT INTO model_capacity_requests(request_id,work_key,owner_instance_id,owner_boot_id,class,pool,route_id,provider,model,provider_budget_id,group_id,epoch,revision,policy_hash,state,queue_until)
    VALUES(${randomUUID()},'unrelated',${owner.instanceId},${owner.bootId},'second','reviewer','second-review','abcllm','Fixture Model','abcllm-supa','supa',1,2,${modelCapacityPolicyHash(policy)},'waiting',clock_timestamp()+interval '1 minute')`;
  beforeRows=await rows();
  await migrate(drizzle(client),{migrationsFolder:path.join(root,"drizzle")});
  const g=globalThis as {db?:unknown;pgClient?:unknown};g.db=drizzle(client,{schema});g.pgClient=client;
},120_000);
afterAll(async()=>{ await client.end({timeout:5}); if(created)await admin.unsafe(`DROP DATABASE ${name}`); await admin.end({timeout:5}); });

it("the full journal scans nonempty 0125 data without changing any previous row and preserves all five CHECK predicates",async()=>{
  expect((await client`SELECT count(*)::int n FROM drizzle.__drizzle_migrations`)[0].n).toBe(journal.entries.length);
  expect(await rows()).toEqual(beforeRows);
  const after=await defs();
  const normalize=(v:string)=>v.replace(/::text\[\]|::text|::character varying/g,"").replace(/[()\s]/g,"");
  for(const n of names)expect(normalize(after[n]).startsWith(normalize(prior[n]))).toBe(true);
  const [captured]=await client`SELECT prosrc FROM pg_proc WHERE proname='nmv_boundary_predecessor_binding_valid'`;
  for(const n of names.slice(0,3))expect(captured.prosrc.includes(prior[n].slice(6))).toBe(true);
  expect((await client`SELECT bool_and(convalidated) valid FROM pg_constraint WHERE conrelid IN ('model_capacity_requests'::regclass,'model_capacity_events'::regclass) AND contype='c'`)[0].valid).toBe(true);
});
it("SQL private PID namespace observation rejects JSON null in required fields",async()=>{
  const {cgroupPopulated:_populated,cgroupPids:_pids,...base}=fx.receipt.owner;
  void _populated; void _pids;
  const proof={...base,method:"private_pid_namespace_end",pidMode:"",initPid:1,initNamespace:base.identity.pidNamespace,selfNamespace:base.identity.pidNamespace,waitExitCode:137,containerStatus:"removed",running:false};
  expect((await client`SELECT nmv_boundary_exit_valid(${JSON.stringify(proof)}::jsonb) valid`)[0].valid).toBe(true);
  for(const key of Object.keys(proof))expect((await client`SELECT nmv_boundary_exit_valid(${JSON.stringify({...proof,[key]:null})}::jsonb) valid`)[0].valid).toBe(false);
});
it("SQL C ordering and TypeScript boundary hash agree with the independent Python ASCII fixture",async()=>{
  const [row]=await client`SELECT encode(sha256(convert_to(nmv_boundary_canonical(${JSON.stringify(fx.plan)}::jsonb),'UTF8')),'hex') hash`;
  expect(row.hash).toBe("d6984a8aeacca0da1b575aeecd047d1707cf36edcf12547abd607b1f7c9ca487");
  expect(row.hash).toBe(providerBoundaryPlanHash(fx.plan));
});
const input=()=>({...frozen,expectedPlanHash:providerBoundaryPlanHash(frozen.plan),operator:"boundary-fixture",reference:"test-only actual-boundary observation fixture"});
it("wrong owner/token/binding/budget/group/contract/control, missing layer, stale or reversed proof rejects without any write",async()=>{
  for(const mutate of [
    (x:ReturnType<typeof input>)=>{x.plan.request.owner.bootId=randomUUID();},
    (x:ReturnType<typeof input>)=>{x.plan.request.tokenHash="0".repeat(64);},
    (x:ReturnType<typeof input>)=>{x.plan.request.bindingHash="0".repeat(64);},
    (x:ReturnType<typeof input>)=>{x.plan.request.providerBudgetId="other";},
    (x:ReturnType<typeof input>)=>{x.plan.request.groupId="other";},
    (x:ReturnType<typeof input>)=>{x.plan.request.servingContractHash="0".repeat(64);},
    (x:ReturnType<typeof input>)=>{x.plan.control.revision++;},
    (x:ReturnType<typeof input>)=>{x.plan.control.updatedAt="2026-10-24T17:59:00.000001Z";},
    (x:ReturnType<typeof input>)=>{x.receipt.gateways.pop();},
    (x:ReturnType<typeof input>)=>{x.receipt.provider.observedAt=x.plan.createdAt;},
  ]){
    const changed=structuredClone(input());mutate(changed);changed.expectedPlanHash=providerBoundaryPlanHash(changed.plan);changed.receipt.planHash=changed.expectedPlanHash;
    await expect(releaseProviderBoundaryRequest(changed,true)).rejects.toThrow();expect(await rows()).toEqual(beforeRows);
  }
  await client`UPDATE model_capacity_control SET mode='open' WHERE id=1`;
  await expect(releaseProviderBoundaryRequest(input(),true)).rejects.toThrow();
  await client`UPDATE model_capacity_control SET mode='draining' WHERE id=1`;
  await client`UPDATE dr_writer_fence SET state='fenced',reason='operator_fence',fenced_db='{"systemIdentifier":"1","databaseOid":"1","databaseName":"fixture"}'::jsonb WHERE id=1`;
  await expect(releaseProviderBoundaryRequest(input(),true)).rejects.toThrow("dr_writer_site_fenced");
  await client`UPDATE dr_writer_fence SET state='active',reason=NULL,fenced_db=NULL WHERE id=1`;
  expect(await rows()).toEqual(beforeRows);
});
it("direct SQL rejects fabricated INSERT, malformed release, changed binding/charge, and non-draining transition",async()=>{
  const [clock]=await client`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at`;
  const evidence={version:1,kind:"provider_boundary_exit",requestId,owner,fromState:"indeterminate",dispatchAt:frozen.plan.request.dispatchAt,bindingHash:frozen.plan.request.bindingHash,
    notBefore:frozen.receipt.provider.observedAt,evaluatedAt:clock.at,operator:"fixture",reference:"fixture",...frozen};
  for(const change of [{plan:{...frozen.plan,request:{...frozen.plan.request,providerBudgetId:"other"}}},{receipt:{...frozen.receipt,gateways:[]}},{bindingHash:"0".repeat(64)}]){
    await expect(client`UPDATE model_capacity_requests SET state='withdrawn',terminal_evidence=${JSON.stringify({...evidence,...change})}::jsonb,terminal_evidence_hash=${hash} WHERE request_id=${requestId}`).rejects.toThrow();
  }
  await expect(client`UPDATE model_capacity_requests SET state='withdrawn',terminal_evidence=${JSON.stringify(evidence)}::jsonb,terminal_evidence_hash=${hash},dispatch_binding=jsonb_set(dispatch_binding,'{chargedTokens}','1') WHERE request_id=${requestId}`).rejects.toThrow();
  await client`UPDATE model_capacity_control SET mode='open' WHERE id=1`;
  await expect(client`UPDATE model_capacity_requests SET state='withdrawn',terminal_evidence=${JSON.stringify(evidence)}::jsonb,terminal_evidence_hash=${hash} WHERE request_id=${requestId}`).rejects.toThrow();
  await client`UPDATE model_capacity_control SET mode='draining' WHERE id=1`;
  await expect(client`INSERT INTO model_capacity_requests SELECT (jsonb_populate_record(NULL::model_capacity_requests,to_jsonb(r)||jsonb_build_object('request_id',${randomUUID()}::text,'queue_ordinal',99999,'work_key','fake','state','withdrawn','terminal_evidence',${JSON.stringify(evidence)}::jsonb,'terminal_evidence_hash',${hash}::text))).* FROM model_capacity_requests r WHERE request_id=${requestId}`).rejects.toThrow("provider_boundary_transition_invalid");
  expect(await rows()).toEqual(beforeRows);
});
it("direct SQL rejects a valid-looking evidence with an incorrect canonical evidence hash",async()=>{
  const [clock]=await client`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at`;
  const evidence={version:1,kind:"provider_boundary_exit",requestId,owner,fromState:"indeterminate",dispatchAt:frozen.plan.request.dispatchAt,bindingHash:frozen.plan.request.bindingHash,
    notBefore:frozen.receipt.provider.observedAt,evaluatedAt:clock.at,operator:"fixture",reference:"fixture",...frozen};
  await expect(client.begin(async tx=>tx`UPDATE model_capacity_requests SET state='withdrawn',terminal_evidence=${JSON.stringify(evidence)}::jsonb,terminal_evidence_hash=${"0".repeat(64)} WHERE request_id=${requestId}`)).rejects.toThrow();
  expect(await rows()).toEqual(beforeRows);
});
it("direct SQL cannot evade proof freshness by backdating evaluatedAt",async()=>{
  const copy=structuredClone(frozen), shift=(v:string)=>new Date(Date.parse(v)-10*60_000).toISOString();
  copy.plan.createdAt=shift(copy.plan.createdAt);copy.receipt.owner.observedAt=shift(copy.receipt.owner.observedAt);
  for(const g of copy.receipt.gateways)g.observedAt=shift(g.observedAt);copy.receipt.provider.observedAt=shift(copy.receipt.provider.observedAt);
  copy.receipt.planHash=providerBoundaryPlanHash(copy.plan);
  const evidence={version:1,kind:"provider_boundary_exit",requestId,owner,fromState:"indeterminate",dispatchAt:copy.plan.request.dispatchAt,bindingHash:copy.plan.request.bindingHash,
    notBefore:copy.receipt.provider.observedAt,evaluatedAt:new Date(Date.now()-10*60_000).toISOString(),operator:"fixture",reference:"fixture",...copy};
  expect((await client`SELECT nmv_provider_boundary_release_valid(${JSON.stringify(evidence)}::jsonb) valid`)[0].valid).toBe(true);
  await expect(client.begin(async tx=>tx`UPDATE model_capacity_requests SET state='withdrawn',terminal_evidence=${JSON.stringify(evidence)}::jsonb,terminal_evidence_hash=${providerBoundaryCanonicalHash(evidence)} WHERE request_id=${requestId}`)).rejects.toThrow();
});
it("operations audit failure rolls back both the exact request release and its append-only event",async()=>{
  await client`ALTER TABLE operations_audit ADD CONSTRAINT boundary_fixture_audit_reject CHECK(action<>'model-provider-boundary-release')`;
  try {await expect(releaseProviderBoundaryRequest(input(),true)).rejects.toThrow();}
  finally {await client`ALTER TABLE operations_audit DROP CONSTRAINT boundary_fixture_audit_reject`;}
  expect(await rows()).toEqual(beforeRows);expect(await client`SELECT id FROM model_capacity_events WHERE request_id=${requestId}`).toHaveLength(0);
});
it("dry-run rolls back; apply changes exact one row plus one matching release event and operations audit; replay never duplicates",async()=>{
  // 2026-10-31: an unknown-outcome row is a non-alarm human review item for the monitor/Oracle.
  expect(await readModelCapacityUnknowns()).toMatchObject({ status: 'review', count: 1, alarmReasons: [], requests: [expect.objectContaining({ requestId })] });
  expect(await readModelCapacityUnknowns({ ...CAPACITY_MONITOR_DEFAULTS, reviewMaxRows: 0 })).toMatchObject({ status: 'alarm', count: 1,
    stuckDispatched: 0, alarmReasons: ['review_backlog'] });
  await expect(readCommittedRelayBoundaryProof(input())).rejects.toThrow('relay_recovery_committed_release_missing');
  expect((await releaseProviderBoundaryRequest(input(),false)).kind).toBe("released");expect(await rows()).toEqual(beforeRows);
  await expect(readCommittedRelayBoundaryProof(input())).rejects.toThrow('relay_recovery_committed_release_missing');
  expect(await client`SELECT id FROM model_capacity_events WHERE request_id=${requestId}`).toHaveLength(0);
  const result=await releaseProviderBoundaryRequest(input(),true);expect(result.kind).toBe("released");
  const [row]=await client`SELECT * FROM model_capacity_requests WHERE request_id=${requestId}`;
  expect(row.state).toBe("withdrawn");expect(row.settled_at).toBeNull();expect(row.dispatch_binding).toEqual(binding);
  expect(row.dispatch_binding_hash).toBe(ai2DispatchBindingHash(binding));expect(row.logical_work_key).toBe(binding.logicalWorkKey);expect(row.logical_member_keys).toBeNull();
  const [event]=await client`SELECT * FROM model_capacity_events WHERE request_id=${requestId}`;expect(event.kind).toBe("dispatch_released");expect(event.evidence).toEqual(row.terminal_evidence);
  expect(row.terminal_evidence_hash).toBe(providerBoundaryCanonicalHash(row.terminal_evidence));
  expect(await readCommittedRelayBoundaryProof(input())).toEqual({ requestId, planHash: input().expectedPlanHash,
    bindingHash: ai2DispatchBindingHash(binding), wireHash: binding.wireHash, model: binding.model,
    releaseEvidenceHash: row.terminal_evidence_hash });
  expect(await readModelCapacityUnknowns()).toEqual({ status: 'ok', truncated: false, requests: [], count: 0, oldestAgeSeconds: null,
    stuckDispatched: 0, alarmReasons: [] });
  // Deployed e0ef monitoring/pending queries are unchanged: a withdrawn boundary has no inferred usage and is not pending.
  const [oldRead]=await client`SELECT state IN ('waiting','reserved','dispatched','indeterminate') pending,
    CASE WHEN state='settled' AND terminal_evidence->>'provenance'='upstream_reported' THEN terminal_evidence->'actualUsage' END usage
    FROM model_capacity_requests WHERE request_id=${requestId}`;
  expect(oldRead).toEqual({pending:false,usage:null});
  expect(await client`SELECT id FROM operations_audit WHERE action='model-provider-boundary-release' AND target=${requestId}`).toHaveLength(1);
  expect((await releaseProviderBoundaryRequest(input(),true)).kind).toBe("already_released");
  await expect(releaseProviderBoundaryRequest({...input(),reference:"different"},true)).rejects.toThrow("provider_boundary_request_conflict");
  await expect(client`UPDATE model_capacity_requests SET terminal_evidence=jsonb_set(terminal_evidence,'{reference}','"edited"') WHERE request_id=${requestId}`).rejects.toThrow();
  expect(await client`SELECT id FROM model_capacity_events WHERE request_id=${requestId}`).toHaveLength(1);
  expect((await rows()).filter((x:Record<string,unknown>)=>(x.value as Record<string,unknown>).request_id!==requestId))
    .toEqual(beforeRows.filter((x:unknown)=>(x as {value:{request_id:string}}).value.request_id!==requestId));
});
it("an existing provider-boundary release cannot be reversed through NULL, another kind, state or tuple changes",async()=>{
  await expect(client.begin(async tx=>tx`UPDATE model_capacity_requests SET state='indeterminate',terminal_evidence=NULL,terminal_evidence_hash=NULL WHERE request_id=${requestId}`)).rejects.toThrow();
  await expect(client.begin(async tx=>tx`UPDATE model_capacity_requests SET terminal_evidence=NULL,terminal_evidence_hash=NULL WHERE request_id=${requestId}`)).rejects.toThrow();
  expect((await client`SELECT state FROM model_capacity_requests WHERE request_id=${requestId}`)[0].state).toBe("withdrawn");
});
