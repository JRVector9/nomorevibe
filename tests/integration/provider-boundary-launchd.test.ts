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
import { ai1DispatchBindingHash, modelCapacityPolicyHash, type Ai1DispatchBinding, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { providerBoundaryCanonicalHash, providerBoundaryPlanHash, providerBoundaryPlanSchema, providerBoundaryReceiptSchema } from "@/lib/llm/provider-boundary-contract";
import { releaseProviderBoundaryRequest } from "@/lib/operations/dr/provider-boundary-release";
import { launchdBoundaryFixture } from "../fixtures/provider-boundary-launchd";
import { TEST_DATABASE_URL } from "./setup";

// Synthetic AI1 ledger fixture. No actual provider observation, model call or production DB is used.
const root = fileURLToPath(new URL("../..", import.meta.url)), name = `nomorevibe_test_launchd_${randomUUID().replaceAll("-", "")}`;
const url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
const client = postgres(url.toString(), { max: 2, prepare: false, onnotice: () => {} });
const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8"));
const functions = ["nmv_boundary_identity_valid", "nmv_boundary_exit_valid", "nmv_provider_boundary_release_valid"];
const requestId = randomUUID(), token = randomUUID(), fx = launchdBoundaryFixture(), hash = "a".repeat(64);
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
  for (const identity of [plan.owner, ...plan.gateways, plan.provider]) identity.startedAt = iso(7200000);
  const birth = Date.parse(plan.provider.startedAt); plan.provider.startSec = String(Math.floor(birth / 1000)); plan.provider.startUsec = (birth % 1000) * 1000;
  const receipt = structuredClone(fx.receipt); receipt.owner.identity = plan.owner; receipt.owner.observedAt = iso(20000);
  receipt.gateways.forEach((g, i) => { g.identity = plan.gateways[i]; g.observedAt = iso(15000 - i * 1000); });
  receipt.provider.identity = plan.provider; receipt.provider.observedAt = iso(10000); receipt.planHash = providerBoundaryPlanHash(plan);
  return { plan, receipt };
}
let frozen: ReturnType<typeof fresh>, beforeRows: unknown[], beforeChecks: unknown[], beforeFunctions: { name: string; oid: string; source: string }[], created = false;
async function checks() { return client`SELECT conname,convalidated,pg_get_constraintdef(oid) definition FROM pg_constraint
  WHERE conrelid IN ('model_capacity_requests'::regclass,'model_capacity_events'::regclass) AND contype='c' ORDER BY conname`; }
async function rows() { return client`SELECT to_jsonb(r) value FROM model_capacity_requests r ORDER BY request_id`; }
const input = () => ({ ...frozen, expectedPlanHash: providerBoundaryPlanHash(frozen.plan), operator: "launchd-fixture", reference: "synthetic observed-boundary fixture" });
beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
  const partial = mkdtempSync(path.join(tmpdir(), "launchd-predecessor-"));
  try {
    mkdirSync(path.join(partial, "meta")); const entries = journal.entries.filter((e: { idx: number }) => e.idx < 128);
    for (const e of entries) copyFileSync(path.join(root, "drizzle", `${e.tag}.sql`), path.join(partial, `${e.tag}.sql`));
    writeFileSync(path.join(partial, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    await migrate(drizzle(client), { migrationsFolder: partial });
  } finally { rmSync(partial, { recursive: true, force: true }); }
  frozen = fresh(); beforeChecks = await checks();
  beforeFunctions = await client`SELECT proname name,oid::text oid,prosrc source FROM pg_proc WHERE proname=ANY(${functions}::text[]) ORDER BY proname`;
  await client`UPDATE model_capacity_control SET mode='draining',epoch=1,revision=2,policy=${JSON.stringify(policy)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(policy)},updated_at=${frozen.plan.control.updatedAt} WHERE id=1`;
  await client`INSERT INTO model_capacity_requests(request_id,work_key,owner_instance_id,owner_boot_id,class,pool,route_id,provider,model,
    provider_budget_id,group_id,epoch,revision,policy_hash,state,logical_work_key,dispatch_binding,dispatch_binding_hash,dispatched_at,token,reserved_until,queue_until)
    VALUES(${requestId},${`${binding.logicalWorkKey}:${hash}`},${frozen.plan.request.owner.instanceId},${frozen.plan.request.owner.bootId},'first','reviewer',
    'crawl-agent-review','abcllm','fixture-gptoss','fixture-m3','m3',1,2,${modelCapacityPolicyHash(policy)},'indeterminate',${binding.logicalWorkKey},
    ${JSON.stringify(binding)}::text::jsonb,${ai1DispatchBindingHash(binding)},${frozen.plan.request.dispatchAt},${token},clock_timestamp(),clock_timestamp())`;
  beforeRows = await rows(); await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") });
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
}, 120000);
afterAll(async () => { await client.end({ timeout: 5 }); if (created) await admin.unsafe(`DROP DATABASE ${name}`); await admin.end({ timeout: 5 }); });

it("macOS의 엄격한 native identity/exit를 실제 PG validator가 허용한다", async () => {
  expect((await client`SELECT nmv_boundary_identity_valid(${JSON.stringify(frozen.plan.provider)}::text::jsonb) valid`)[0].valid).toBe(true);
  expect((await client`SELECT nmv_boundary_exit_valid(${JSON.stringify(frozen.receipt.provider)}::text::jsonb) valid`)[0].valid).toBe(true);
  const provider = structuredClone(frozen.receipt.provider);
  provider.identity.hostBootId = provider.observedHostBootId = "11111111-1111-1111-1111-111111111111";
  expect(providerBoundaryReceiptSchema.safeParse({ ...frozen.receipt, provider }).success).toBe(true);
  expect((await client`SELECT nmv_boundary_exit_valid(${JSON.stringify(provider)}::text::jsonb) valid`)[0].valid).toBe(true);
});
it("129 migration은 nonempty 원행/20 CHECK/public OID와 Linux 원형 prosrc를 그대로 보존한다", async () => {
  expect((await client`SELECT count(*)::int n FROM drizzle.__drizzle_migrations`)[0].n).toBe(journal.entries.length);
  expect(await rows()).toEqual(beforeRows); expect(await checks()).toEqual(beforeChecks); expect(beforeChecks).toHaveLength(20);
  for (const old of beforeFunctions) {
    const [current] = await client`SELECT oid::text oid FROM pg_proc WHERE proname=${old.name}`;
    const [legacy] = await client`SELECT prosrc source FROM pg_proc WHERE proname=${`${old.name}_linux_0126`}`;
    expect(current.oid).toBe(old.oid); expect(legacy.source).toBe(old.source);
  }
});
it("JSON null·필드누락·다른boot·cgroup위장·잘못된method·PID시각은 SQL/TS 모두 거절한다", async () => {
  for (const key of Object.keys(frozen.plan.provider)) {
    const identity = { ...frozen.plan.provider, [key]: null };
    expect(providerBoundaryPlanSchema.safeParse({ ...frozen.plan, provider: identity }).success).toBe(false);
    expect((await client`SELECT nmv_boundary_identity_valid(${JSON.stringify(identity)}::text::jsonb) valid`)[0].valid).toBe(false);
  }
  for (const change of [{ observedHostBootId: randomUUID() }, { processGroupESRCH: false }, { launchdUnloaded: null }, { ownedListeners: [100] },
    { method: "systemd_and_cgroup_empty", cgroupPopulated: false, cgroupPids: [] }, { method: "private_pid_namespace_end" }]) {
    const provider = { ...frozen.receipt.provider, ...change };
    expect(providerBoundaryReceiptSchema.safeParse({ ...frozen.receipt, provider }).success).toBe(false);
    expect((await client`SELECT nmv_boundary_exit_valid(${JSON.stringify(provider)}::text::jsonb) valid`)[0].valid).toBe(false);
  }
  for (const key of Object.keys(frozen.receipt.provider)) {
    const provider = { ...frozen.receipt.provider, [key]: null };
    expect(providerBoundaryReceiptSchema.safeParse({ ...frozen.receipt, provider }).success).toBe(false);
    expect((await client`SELECT nmv_boundary_exit_valid(${JSON.stringify(provider)}::text::jsonb) valid`)[0].valid).toBe(false);
  }
  const linuxWithMacMethod = { ...frozen.receipt.provider, identity: frozen.plan.owner };
  expect(providerBoundaryReceiptSchema.safeParse({ ...frozen.receipt, provider: linuxWithMacMethod }).success).toBe(false);
  expect((await client`SELECT nmv_boundary_exit_valid(${JSON.stringify(linuxWithMacMethod)}::text::jsonb) valid`)[0].valid).toBe(false);
  const changed = { ...frozen.plan.provider, startUsec: (frozen.plan.provider.startUsec + 1000) % 1000000 };
  expect((await client`SELECT nmv_boundary_identity_valid(${JSON.stringify(changed)}::text::jsonb) valid`)[0].valid).toBe(false);
});
it("macOS 경계도 exact CAS/현재 draining/원순서를 요구하고 direct INSERT를 승인하지 않는다", async () => {
  for (const mutate of [(x: ReturnType<typeof input>) => { x.plan.request.groupId = "other"; },
    (x: ReturnType<typeof input>) => { x.plan.request.bindingHash = "0".repeat(64); },
    (x: ReturnType<typeof input>) => { x.receipt.provider.observedAt = x.receipt.owner.observedAt; }]) {
    const changed = structuredClone(input()); mutate(changed); changed.expectedPlanHash = providerBoundaryPlanHash(changed.plan); changed.receipt.planHash = changed.expectedPlanHash;
    await expect(releaseProviderBoundaryRequest(changed, true)).rejects.toThrow(); expect(await rows()).toEqual(beforeRows);
  }
  await client`UPDATE model_capacity_control SET mode='open' WHERE id=1`;
  await expect(releaseProviderBoundaryRequest(input(), true)).rejects.toThrow();
  await client`UPDATE model_capacity_control SET mode='draining' WHERE id=1`;
  const [clock] = await client`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at`;
  const evidence = { version: 1, kind: "provider_boundary_exit", requestId, owner: frozen.plan.request.owner, fromState: "indeterminate",
    dispatchAt: frozen.plan.request.dispatchAt, bindingHash: frozen.plan.request.bindingHash, notBefore: frozen.receipt.provider.observedAt,
    evaluatedAt: clock.at, operator: "fixture", reference: "synthetic observation", ...frozen };
  expect((await client`SELECT nmv_provider_boundary_release_valid(${JSON.stringify(evidence)}::text::jsonb) valid`)[0].valid).toBe(true);
  await expect(client`UPDATE model_capacity_requests SET state='withdrawn',terminal_evidence=${JSON.stringify(evidence)}::text::jsonb,
    terminal_evidence_hash=${"0".repeat(64)} WHERE request_id=${requestId}`).rejects.toThrow();
  const fake = structuredClone(evidence), fakeId = randomUUID(); fake.requestId = fakeId; fake.plan.request.requestId = fakeId;
  fake.receipt.planHash = providerBoundaryPlanHash(fake.plan);
  await expect(client`INSERT INTO model_capacity_requests SELECT (jsonb_populate_record(NULL::model_capacity_requests,to_jsonb(r)||
    jsonb_build_object('request_id',${fakeId}::text,'queue_ordinal',99999,'work_key','fake','state','withdrawn',
    'terminal_evidence',${JSON.stringify(fake)}::text::jsonb,'terminal_evidence_hash',${providerBoundaryCanonicalHash(fake)}::text))).*
    FROM model_capacity_requests r WHERE request_id=${requestId}`).rejects.toThrow("provider_boundary_transition_invalid");
  expect(await rows()).toEqual(beforeRows);
});
it("same TX로 AI1 exact 한 행만 withdrawn/event/audit 처리하고 charge/binding·정산·업무결과를 조작하지 않는다", async () => {
  expect(await releaseProviderBoundaryRequest(input(), false)).toMatchObject({ kind: "released" }); expect(await rows()).toEqual(beforeRows);
  expect(await releaseProviderBoundaryRequest(input(), true)).toMatchObject({ kind: "released", requestId });
  const [row] = await client`SELECT * FROM model_capacity_requests WHERE request_id=${requestId}`;
  expect(row.state).toBe("withdrawn"); expect(row.settled_at).toBeNull(); expect(row.dispatch_binding).toEqual(binding); expect(row.dispatch_binding_hash).toBe(ai1DispatchBindingHash(binding));
  expect(row.terminal_evidence_hash).toBe(providerBoundaryCanonicalHash(row.terminal_evidence));
  expect(await client`SELECT kind,from_state,to_state FROM model_capacity_events WHERE request_id=${requestId}`)
    .toEqual([{ kind: "dispatch_released", from_state: "indeterminate", to_state: "withdrawn" }]);
  expect((await client`SELECT count(*)::int n FROM operations_audit WHERE target=${requestId} AND action='model-provider-boundary-release'`)[0].n).toBe(1);
  await expect(client`UPDATE model_capacity_requests SET state='indeterminate',terminal_evidence=NULL,terminal_evidence_hash=NULL WHERE request_id=${requestId}`).rejects.toThrow();
  expect(await releaseProviderBoundaryRequest(input(), true)).toMatchObject({ kind: "already_released" });
});
