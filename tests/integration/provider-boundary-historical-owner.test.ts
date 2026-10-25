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
import { modelDispatchReleaseEvidenceSchema, ai1DispatchBindingHash, modelCapacityPolicyHash, type Ai1DispatchBinding, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { providerBoundaryCanonicalHash, providerBoundaryPlanHash, providerBoundaryPlanSchema, providerBoundaryReceiptSchema } from "@/lib/llm/provider-boundary-contract";
import { releaseModelDispatchWithEvidence } from "@/lib/llm/capacity-repository";
import { drTransaction } from "@/lib/operations/dr/repository";
import { originalBoundaryOwnerSchema } from "@/lib/llm/provider-boundary-contract";
import { releaseProviderBoundaryRequest } from "@/lib/operations/dr/provider-boundary-release";
import { historicalOwnerFixture } from "../fixtures/provider-boundary-historical-owner";
import { TEST_DATABASE_URL } from "./setup";

// Synthetic AI1 ledger fixture. No actual provider observation, model call or production DB is used.
const root = fileURLToPath(new URL("../..", import.meta.url)), name = `nomorevibe_test_historical_${randomUUID().replaceAll("-", "")}`;
const url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
const client = postgres(url.toString(), { max: 2, prepare: false, onnotice: () => {} });
const fullJournal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8"));
// This historical window ends at 0131; 0132 intentionally replaces four CHECKs.
const journal = { ...fullJournal, entries: fullJournal.entries.filter((entry: { idx: number }) => entry.idx < 132) };

const requestId = randomUUID(), token = randomUUID(), fx = historicalOwnerFixture(), hash = "a".repeat(64);
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { "fixture-m3": 1 }, groupLimits: { m3: 1 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 10, queueTtlMs: 120000, reservationTtlMs: 30000,
  routes: [{ routeId: "crawl-agent-review", provider: "abcllm", model: "fixture-gptoss", providerBudgetId: "fixture-m3", groupId: "m3" }] };
const binding: Ai1DispatchBinding = { kind: "ai1_legacy_gateway", version: 1, logicalWorkKey: "ai1:17", candidateId: 17, attemptId: 29,
  inputHash: hash, sourceRevisionHash: hash, reviewPolicyHash: hash, promptVersion: "p1", rulesVersion: "r1", provider: "abcllm", model: "fixture-gptoss",
  routeId: "crawl-agent-review", stageEpoch: 1, wireHash: hash, servingContractHash: hash, totalTokenBound: 131072, chargedTokens: 131072,
  job: { name: "crawl-agent-review", token: randomUUID(), requestedVersion: 0 } };
function fresh() {
  const now = Date.now(), iso = (ms: number) => new Date(now - ms).toISOString(), plan = structuredClone(fx.plan);
  plan.request = { ...plan.request, requestId, tokenHash: createHash("sha256").update(token).digest("hex"), bindingHash: ai1DispatchBindingHash(binding),
    dispatchAt: iso(3600000), policyHash: modelCapacityPolicyHash(policy), providerBudgetId: "fixture-m3", groupId: "m3", servingContractHash: hash };
  plan.control.policyHash = plan.request.policyHash; plan.createdAt = iso(30000);
  for (const identity of [plan.currentIngressOwner, ...plan.gateways, plan.provider]) identity.startedAt = iso(7200000);
  const birth = Date.parse(plan.provider.startedAt); plan.provider.startSec = String(Math.floor(birth / 1000)); plan.provider.startUsec = (birth % 1000) * 1000;
  const receipt = structuredClone(fx.receipt); plan.currentIngressOwner.startedAt = iso(900000); receipt.currentIngressOwner.identity = plan.currentIngressOwner; receipt.currentIngressOwner.observedAt = iso(20000);
  receipt.gateways.forEach((g, i) => { g.identity = plan.gateways[i]; g.observedAt = iso(15000 - i * 1000); });
  receipt.provider.identity = plan.provider; receipt.provider.observedAt = iso(10000); receipt.planHash = providerBoundaryPlanHash(plan);
  return { plan, receipt };
}
let frozen: ReturnType<typeof fresh>, beforeRows: unknown[], beforeChecks: unknown[], beforeFunctions: { name: string; oid: string; source: string; definition: string }[], created = false;
async function checks() { return client`SELECT conname,convalidated,pg_get_constraintdef(oid) definition FROM pg_constraint
  WHERE conrelid IN ('model_capacity_requests'::regclass,'model_capacity_events'::regclass) AND contype='c' ORDER BY conname`; }
async function catalog() { return client<{ name: string; oid: string; source: string; definition: string }[]>`SELECT proname name,oid::text oid,prosrc source,pg_get_functiondef(oid) definition FROM pg_proc
  WHERE pronamespace='public'::regnamespace AND (proname LIKE 'nmv_boundary_%' OR proname LIKE 'nmv_provider_boundary_%') ORDER BY proname`; }
async function saveCatalog(file: string, value: unknown) {
  const dir=process.env.BOUNDARY_CATALOG_OUTPUT_DIR; if (!dir) return;
  mkdirSync(dir,{recursive:true,mode:0o700}); writeFileSync(path.join(dir,file),JSON.stringify(value,null,2)+"\n",{mode:0o600});
}
async function rows() { return client`SELECT to_jsonb(r) value FROM model_capacity_requests r ORDER BY request_id`; }
const input = () => ({ ...frozen, expectedPlanHash: providerBoundaryPlanHash(frozen.plan), operator: "launchd-fixture", reference: "synthetic observed-boundary fixture" });
async function migrateThrough(limit: number) {
  const partial = mkdtempSync(path.join(tmpdir(), "launchd-predecessor-"));
  try {
    mkdirSync(path.join(partial, "meta")); const entries = journal.entries.filter((e: { idx: number }) => e.idx < limit);
    for (const e of entries) copyFileSync(path.join(root, "drizzle", `${e.tag}.sql`), path.join(partial, `${e.tag}.sql`));
    writeFileSync(path.join(partial, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    await migrate(drizzle(client), { migrationsFolder: partial });
  } finally { rmSync(partial, { recursive: true, force: true }); }
}
beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrateThrough(129);
  frozen = fresh(); beforeChecks = await checks();
  beforeFunctions = await catalog(); await saveCatalog("before-129.catalog.safe.json",{checks:beforeChecks,functions:beforeFunctions});
  await client`UPDATE model_capacity_control SET mode='draining',epoch=1,revision=2,policy=${JSON.stringify(policy)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(policy)},updated_at=${frozen.plan.control.updatedAt} WHERE id=1`;
  await client`INSERT INTO model_capacity_requests(request_id,work_key,owner_instance_id,owner_boot_id,class,pool,route_id,provider,model,
    provider_budget_id,group_id,epoch,revision,policy_hash,state,logical_work_key,dispatch_binding,dispatch_binding_hash,dispatched_at,token,reserved_until,queue_until)
    VALUES(${requestId},${`${binding.logicalWorkKey}:${hash}`},${frozen.plan.request.owner.instanceId},${frozen.plan.request.owner.bootId},'first','reviewer',
    'crawl-agent-review','abcllm','fixture-gptoss','fixture-m3','m3',1,2,${modelCapacityPolicyHash(policy)},'indeterminate',${binding.logicalWorkKey},
    ${JSON.stringify(binding)}::text::jsonb,${ai1DispatchBindingHash(binding)},${frozen.plan.request.dispatchAt},${token},clock_timestamp(),clock_timestamp())`;
  const owner=frozen.plan.request.owner, runId=randomUUID();
  const groupRows = await client`INSERT INTO dr_process_group_events(owner_instance_id,owner_boot_id,kind,seq,run_id,pid,method,recorded_at) VALUES
    (${owner.instanceId},${owner.bootId},'owner_opened',0,NULL,NULL,NULL,clock_timestamp()-interval '3 hours'),
    (${owner.instanceId},${owner.bootId},'spawn_intent',1,${runId},NULL,NULL,clock_timestamp()-interval '2 hours'),
    (${owner.instanceId},${owner.bootId},'spawned',1,${runId},41,NULL,clock_timestamp()-interval '2 hours'),
    (${owner.instanceId},${owner.bootId},'group_exited',1,${runId},41,'pgid_esrch_after_sigkill',clock_timestamp()-interval '30 minutes') RETURNING id,kind`;
  const id=(kind:string)=>Number(groupRows.find(x=>x.kind===kind)!.id);
  const localEvidence={version:1,kind:"gateway_local_end",requestId,owner,bindingHash:ai1DispatchBindingHash(binding),dispatches:1,terminals:1};
  const [local]=await client`INSERT INTO model_capacity_events(request_id,kind,from_state,to_state,epoch,revision,policy_hash,evidence,created_at)
    VALUES(${requestId},'dispatch_local_ended','indeterminate','indeterminate',1,2,${modelCapacityPolicyHash(policy)},${JSON.stringify(localEvidence)}::text::jsonb,clock_timestamp()-interval '59 minutes')
    RETURNING id,encode(sha256(convert_to(evidence::text,'UTF8')),'hex') hash`;
  Object.assign(frozen.plan.originalOwner,{openedEventId:id('owner_opened'),groups:[{seq:1,pid:41,runIdHash:createHash('sha256').update(runId).digest('hex'),spawnIntentEventId:id('spawn_intent'),spawnedEventId:id('spawned'),exitEventId:id('group_exited')}],localEndEventId:Number(local.id),localEndEvidenceHash:local.hash});
  frozen.receipt.originalOwnerProofHash=providerBoundaryCanonicalHash(frozen.plan.originalOwner);frozen.receipt.planHash=providerBoundaryPlanHash(frozen.plan);
  beforeRows = await rows();
  const priorEvidence=await evidence(); expect(await physical(priorEvidence)).toBe(false);
  await saveCatalog("predecessor-red.safe.json",{synthetic:true,priorJournalCount:129,v2PhysicalAccepted:false});
  await migrateThrough(132);
  await saveCatalog("after-130.catalog.safe.json",{checks:await checks(),functions:await catalog()});
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
}, 120000);
afterAll(async () => { await client.end({ timeout: 5 }); if (created) await admin.unsafe(`DROP DATABASE ${name}`); await admin.end({ timeout: 5 }); });

async function evidence(plan=frozen.plan, receipt=frozen.receipt) {
  const [clock]=await client`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at`;
  return {version:1,kind:"provider_boundary_exit",requestId,owner:plan.request.owner,fromState:"indeterminate",dispatchAt:plan.request.dispatchAt,
    bindingHash:plan.request.bindingHash,notBefore:receipt.provider.observedAt,evaluatedAt:clock.at,operator:"fixture",reference:"synthetic history",plan,receipt};
}
function rehash(value: ReturnType<typeof input>) {
  value.receipt.originalOwnerProofHash=providerBoundaryCanonicalHash(value.plan.originalOwner);
  value.expectedPlanHash=providerBoundaryPlanHash(value.plan); value.receipt.planHash=value.expectedPlanHash; return value;
}
async function physical(value: Awaited<ReturnType<typeof evidence>>) {
  return (await client`SELECT nmv_provider_boundary_release_valid(${JSON.stringify(value)}::text::jsonb) valid`)[0].valid;
}
async function records(plan: typeof frozen.plan) {
  return (await client`SELECT nmv_boundary_original_owner_records_valid(${JSON.stringify(plan)}::text::jsonb,to_jsonb(r)) valid
    FROM model_capacity_requests r WHERE request_id=${requestId}`)[0].valid;
}
it("v2는 현재 ingress가 dispatch 뒤 태어나도 strict physical 계약과 원 DB 사실을 함께 만족한다", async () => {
  expect(Date.parse(frozen.plan.currentIngressOwner.startedAt)).toBeGreaterThan(Date.parse(frozen.plan.request.dispatchAt));
  expect(await physical(await evidence())).toBe(true); expect(await records(frozen.plan)).toBe(true);
});
it("nonempty migration은 20 CHECK/전체 public OID와 기존 함수 본문을 보존하고 두 원형을 byte 그대로 보관한다", async () => {
  expect((await client`SELECT count(*)::int n FROM drizzle.__drizzle_migrations`)[0].n).toBe(journal.entries.length);
  expect(await rows()).toEqual(beforeRows); expect(await checks()).toEqual(beforeChecks); expect(beforeChecks).toHaveLength(20);
  const after=await catalog(); expect(beforeFunctions).toHaveLength(14); expect(after).toHaveLength(21);
  const archived=new Map([["nmv_provider_boundary_release_valid","nmv_provider_boundary_release_v1_0128"],
    ["nmv_provider_boundary_transition_guard","nmv_provider_boundary_transition_guard_v1_0128"]]);
  for (const old of beforeFunctions) {
    const current=after.find(x=>x.name===old.name)!; expect(current.oid).toBe(old.oid);
    if (archived.has(old.name)) expect(after.find(x=>x.name===archived.get(old.name))!.source).toBe(old.source);
    else expect(current).toEqual(old);
  }
  const oldTrigger=beforeFunctions.find(x=>x.name==="nmv_provider_boundary_transition_guard")!.source;
  expect(after.find(x=>x.name==="nmv_provider_boundary_transition_guard")!.source)
    .toBe(oldTrigger.replace("  RETURN NEW;\nEND", "  IF NEW.terminal_evidence->'plan'->'version'='2'::jsonb AND NOT nmv_boundary_original_owner_records_valid(NEW.terminal_evidence->'plan',to_jsonb(NEW)) THEN RAISE EXCEPTION 'provider_boundary_original_owner_records_mismatch'; END IF;\n  IF NEW.terminal_evidence->'plan'->'version'='3'::jsonb AND NOT nmv_boot_records_valid(NEW.terminal_evidence->'plan',to_jsonb(NEW)) THEN RAISE EXCEPTION 'provider_boot_boundary_records_mismatch'; END IF;\n  IF NEW.terminal_evidence->'plan'->'version'='4'::jsonb AND NOT nmv_boot_historical_records_valid(NEW.terminal_evidence->'plan',to_jsonb(NEW)) THEN RAISE EXCEPTION 'provider_boot_historical_records_mismatch'; END IF;\n  RETURN NEW;\nEND"));
});
it("새 originalOwner 필드의 null/누락/잘못된 UUID/중복·과대번호는 TS와 SQL에서 같이 거절한다", async () => {
  const proof=frozen.plan.originalOwner;
  const invalid: unknown[] = Object.keys(proof).flatMap(k=>[{...proof,[k]:null},Object.fromEntries(Object.entries(proof).filter(([key])=>key!==k))]);
  invalid.push({...proof,bootId:"11111111-1111-1111-1111-111111111111"},{...proof,bootId:"ABCDEFAB-1234-4234-8234-123456789ABC"},
    {...proof,groups:[]},{...proof,groups:[proof.groups[0],proof.groups[0]]},{...proof,extra:true});
  for(const k of Object.keys(proof.groups[0])) invalid.push({...proof,groups:[{...proof.groups[0],[k]:null}]});
  invalid.push({...proof,groups:[{...proof.groups[0],seq:2147483648}]},{...proof,openedEventId:9007199254740992});
  for(const candidate of invalid) {
    expect(originalBoundaryOwnerSchema.safeParse(candidate).success).toBe(false);
    expect((await client`SELECT nmv_boundary_original_owner_valid(${JSON.stringify(candidate)}::text::jsonb) valid`)[0].valid).toBe(false);
  }
});
it("v2에는 Linux provider 위장/다른 method/느슨한 birth 또는 receipt 순서를 허용하지 않는다", async () => {
  for(const change of [{provider:frozen.plan.currentIngressOwner},{gateways:[{...frozen.plan.gateways[0],startedAt:frozen.plan.currentIngressOwner.startedAt},frozen.plan.gateways[1]]}]) {
    const plan={...frozen.plan,...change}; expect(providerBoundaryPlanSchema.safeParse(plan).success).toBe(false);
    const receipt={...frozen.receipt,planHash:providerBoundaryCanonicalHash(plan)};
    expect(await physical(await evidence(plan as typeof frozen.plan,receipt))).toBe(false);
  }
  const receipt={...frozen.receipt,provider:{...frozen.receipt.provider,method:"systemd_and_cgroup_empty",cgroupPopulated:false,cgroupPids:[]}};
  expect(providerBoundaryReceiptSchema.safeParse(receipt).success).toBe(false);
  expect(await physical(await evidence(frozen.plan,receipt as typeof frozen.receipt))).toBe(false);
  const changed=structuredClone(input());changed.receipt.provider.observedAt=changed.receipt.currentIngressOwner.observedAt;
  await expect(releaseProviderBoundaryRequest(changed,true)).rejects.toThrow();expect(await rows()).toEqual(beforeRows);
});
it("forged event/run/localEnd/누락 group은 재해시해도 generic release callback과 직접 SQL 양쪽에서 거절한다", async () => {
  const changes=[
    (p:typeof frozen.plan)=>{p.originalOwner.openedEventId+=1000;},
    (p:typeof frozen.plan)=>{p.originalOwner.groups[0].spawnIntentEventId+=1000;},
    (p:typeof frozen.plan)=>{p.originalOwner.groups[0].spawnedEventId+=1000;},
    (p:typeof frozen.plan)=>{p.originalOwner.groups[0].exitEventId+=1000;},
    (p:typeof frozen.plan)=>{p.originalOwner.groups[0].runIdHash="0".repeat(64);},
    (p:typeof frozen.plan)=>{p.originalOwner.groups[0].pid+=1;},
    (p:typeof frozen.plan)=>{p.originalOwner.localEndEventId+=1000;},
    (p:typeof frozen.plan)=>{p.originalOwner.localEndEvidenceHash="0".repeat(64);},
    (p:typeof frozen.plan)=>{p.originalOwner.groups[0].seq=2;},
  ];
  for(const change of changes) {
    const changed=structuredClone(input());change(changed.plan);rehash(changed);
    const e=await evidence(changed.plan,changed.receipt);expect(await physical(e)).toBe(true);expect(await records(changed.plan)).toBe(false);
    await expect(drTransaction(tx=>releaseModelDispatchWithEvidence(tx,requestId,async c=>modelDispatchReleaseEvidenceSchema.parse({...e,evaluatedAt:c.now}))))
      .rejects.toThrow("provider_boundary_original_owner_records_mismatch");
    await expect(client`UPDATE model_capacity_requests SET state='withdrawn',terminal_evidence=${JSON.stringify(e)}::text::jsonb,
      terminal_evidence_hash=${providerBoundaryCanonicalHash(e)} WHERE request_id=${requestId}`).rejects.toThrow("provider_boundary_original_owner_records_mismatch");
  }
  expect(await rows()).toEqual(beforeRows);
});
it("같은 TX에서 새로 읽은 미포함 원 group은 direct SQL release도 막는다",async()=>{
  const e=await evidence(),o=frozen.plan.originalOwner,run=randomUUID();
  await expect(client.begin(async tx=>{
    await tx`INSERT INTO dr_process_group_events(owner_instance_id,owner_boot_id,kind,seq,run_id,recorded_at)
      VALUES(${o.instanceId},${o.bootId},'spawn_intent',2,${run},clock_timestamp()-interval '2 hours')`;
    expect((await tx`SELECT nmv_boundary_original_owner_records_valid(${JSON.stringify(frozen.plan)}::text::jsonb,to_jsonb(r)) valid
      FROM model_capacity_requests r WHERE request_id=${requestId}`)[0].valid).toBe(false);
    await tx`UPDATE model_capacity_requests SET state='withdrawn',terminal_evidence=${JSON.stringify(e)}::text::jsonb,
      terminal_evidence_hash=${providerBoundaryCanonicalHash(e)} WHERE request_id=${requestId}`;
  })).rejects.toThrow("provider_boundary_original_owner_records_mismatch");
  expect(await records(frozen.plan)).toBe(true);expect(await rows()).toEqual(beforeRows);
});
it("owner/control/binding/budget CAS와 direct INSERT 보호를 그대로 유지한다", async () => {
  for(const mutate of [(x:ReturnType<typeof input>)=>{x.plan.request.groupId="other";},
    (x:ReturnType<typeof input>)=>{x.plan.request.bindingHash="0".repeat(64);},
    (x:ReturnType<typeof input>)=>{x.plan.request.tokenHash="0".repeat(64);},
    (x:ReturnType<typeof input>)=>{x.plan.control.updatedAt="2026-10-24T17:59:00.001000Z";}]) {
    const changed=structuredClone(input());mutate(changed);rehash(changed);
    await expect(releaseProviderBoundaryRequest(changed,true)).rejects.toThrow();expect(await rows()).toEqual(beforeRows);
  }
  await client`UPDATE model_capacity_control SET mode='open' WHERE id=1`;
  await expect(releaseProviderBoundaryRequest(input(),true)).rejects.toThrow();
  await client`UPDATE model_capacity_control SET mode='draining' WHERE id=1`;
  const e=await evidence(),fakeId=randomUUID(); e.requestId=fakeId;e.plan=structuredClone(e.plan);e.plan.request.requestId=fakeId;e.receipt=structuredClone(e.receipt);e.receipt.planHash=providerBoundaryPlanHash(e.plan);
  await expect(client`INSERT INTO model_capacity_requests SELECT (jsonb_populate_record(NULL::model_capacity_requests,to_jsonb(r)||
    jsonb_build_object('request_id',${fakeId}::text,'queue_ordinal',99999,'work_key','fake','state','withdrawn',
    'terminal_evidence',${JSON.stringify(e)}::text::jsonb,'terminal_evidence_hash',${providerBoundaryCanonicalHash(e)}::text))).*
    FROM model_capacity_requests r WHERE request_id=${requestId}`).rejects.toThrow("provider_boundary_transition_invalid");
  expect(await rows()).toEqual(beforeRows);
});
it("exact 한 행만 withdrawn/event/audit로 끝내고 기존 binding/charge와 localEnd·그룹 기록을 그대로 둔다", async () => {
  const oldGroups=await client`SELECT to_jsonb(e) value FROM dr_process_group_events e ORDER BY id`;
  expect(await releaseProviderBoundaryRequest(input(),false)).toMatchObject({kind:"released"});expect(await rows()).toEqual(beforeRows);
  expect(await releaseProviderBoundaryRequest(input(),true)).toMatchObject({kind:"released",requestId});
  const [row]=await client`SELECT * FROM model_capacity_requests WHERE request_id=${requestId}`;
  expect(row.state).toBe("withdrawn");expect(row.settled_at).toBeNull();expect(row.dispatch_binding).toEqual(binding);expect(row.dispatch_binding_hash).toBe(ai1DispatchBindingHash(binding));
  expect(row.terminal_evidence_hash).toBe(providerBoundaryCanonicalHash(row.terminal_evidence));
  const original=structuredClone((beforeRows[0] as {value:Record<string,unknown>}).value), after=structuredClone((await rows())[0].value);
  for(const key of ["state","terminal_evidence","terminal_evidence_hash","updated_at"]) {delete original[key];delete after[key];}
  expect(after).toEqual(original);
  expect(await client`SELECT to_jsonb(e) value FROM dr_process_group_events e ORDER BY id`).toEqual(oldGroups);
  expect(await client`SELECT kind,from_state,to_state FROM model_capacity_events WHERE request_id=${requestId} ORDER BY id`)
    .toEqual([{kind:"dispatch_local_ended",from_state:"indeterminate",to_state:"indeterminate"},{kind:"dispatch_released",from_state:"indeterminate",to_state:"withdrawn"}]);
  expect((await client`SELECT count(*)::int n FROM operations_audit WHERE target=${requestId} AND action='model-provider-boundary-release'`)[0].n).toBe(1);
  await expect(client`UPDATE model_capacity_requests SET state='indeterminate',terminal_evidence=NULL,terminal_evidence_hash=NULL WHERE request_id=${requestId}`).rejects.toThrow("provider_boundary_terminal_immutable");
  expect(await releaseProviderBoundaryRequest(input(),true)).toMatchObject({kind:"already_released"});
});
