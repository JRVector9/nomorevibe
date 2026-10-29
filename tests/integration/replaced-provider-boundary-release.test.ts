import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { modelCapacityPolicyHash, productTranslationMemberKeys, productTranslationLogicalWorkKey, productTranslationInputHash,
  productTranslationDispatchBindingHash, type ProductTranslationDispatchBinding, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { replacedProviderDigest as sha, replacedProviderPlanHash } from "@/lib/llm/replaced-provider-boundary-contract";
import { providerBoundaryCanonicalHash } from "@/lib/llm/provider-boundary-contract";
import { releaseReplacedProviderBoundaryRequest } from "@/lib/operations/dr/replaced-provider-boundary-release";
import { replacedProviderFixture } from "../fixtures/replaced-provider-boundary";
import { TEST_DATABASE_URL } from "./setup";

// Own disposable DB; production, business rows and provider endpoints are never touched.
const name = `nomorevibe_test_replaced_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 2, prepare: false, onnotice: () => {} });
const fx = replacedProviderFixture(), q = fx.plan.request, owner = q.owner, token = randomUUID(), runId = randomUUID(), h = sha("fixture");
let created = false;
const members = [{ productId: 17, slug: "fixture", locale: "en" as const, field: "tagline" as const, sourceHash: h,
  demand: { rowIdentityHash: h, attempts: 0 } }];
const binding: ProductTranslationDispatchBinding = { kind: "product_translation_gateway", version: 1, members,
  model: "[m1] qwen3.8-flash-next", logicalWorkKey: productTranslationLogicalWorkKey(members), inputHash: productTranslationInputHash({ members, model: "[m1] qwen3.8-flash-next" }),
  provider: "abcllm", routeId: "product-translate", wireHash: q.wireHash, servingContractHash: h, totalTokenBound: 40768, chargedTokens: 40768,
  job: { name: "product-translate", token: randomUUID(), requestedVersion: 1 },
  role: { role: "text", instanceId: owner.instanceId, bootId: owner.bootId, release: "a".repeat(40), kind: "primary", epoch: 1, batch: { mode: "legacy" } } };
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { "abcllm-m1": 1 }, groupLimits: { m1: 1 }, poolLimits: { text: 1, reviewer: 1 },
  weights: { first: 4, second: 2, background: 1 }, maxWaiting: 10, queueTtlMs: 120000, reservationTtlMs: 30000,
  routes: [{ routeId: "product-translate", provider: "abcllm", model: binding.model, providerBudgetId: "abcllm-m1", groupId: "m1" }] };
const input = () => ({ plan: fx.plan, receipt: fx.receipt, expectedPlanHash: replacedProviderPlanHash(fx.plan), operator: "fixture-operator", reference: fx.plan.reviewReference });
const rows = () => client`SELECT to_jsonb(r) v FROM model_capacity_requests r ORDER BY request_id`;
const counts = async () => ({ events: Number((await client`SELECT count(*) n FROM model_capacity_events`)[0].n), audit: Number((await client`SELECT count(*) n FROM operations_audit`)[0].n) });
beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrate(drizzle(client), { migrationsFolder: path.resolve("drizzle") });
  q.policyHash = fx.plan.control.policyHash = modelCapacityPolicyHash(policy); q.tokenHash = sha(token); q.bindingHash = productTranslationDispatchBindingHash(binding);
  const [f] = await client`SELECT lineage_id::text,writer_epoch::int FROM dr_writer_fence WHERE id=1`;
  fx.plan.writer = { lineageId: f.lineage_id, writerEpoch: f.writer_epoch };
  await client`UPDATE model_capacity_control SET mode='draining',epoch=1,revision=7,policy=${JSON.stringify(policy)}::jsonb,policy_hash=${q.policyHash},updated_at=${fx.plan.control.updatedAt} WHERE id=1`;
  await client`INSERT INTO model_capacity_requests(request_id,work_key,owner_instance_id,owner_boot_id,class,pool,route_id,provider,model,provider_budget_id,group_id,epoch,revision,policy_hash,state,logical_work_key,logical_member_keys,dispatch_binding,dispatch_binding_hash,dispatched_at,token,reserved_until,queue_until)
    VALUES(${q.requestId},${binding.logicalWorkKey+":"+binding.inputHash},${owner.instanceId},${owner.bootId},'background','text','product-translate','abcllm',${binding.model},'abcllm-m1','m1',1,7,${q.policyHash},'indeterminate',${binding.logicalWorkKey},${productTranslationMemberKeys(members)}::text[],${JSON.stringify(binding)}::jsonb,${q.bindingHash},${q.dispatchAt},${token},clock_timestamp(),clock_timestamp())`;
  const records = await client`INSERT INTO dr_process_group_events(owner_instance_id,owner_boot_id,kind,seq,run_id,pid,method,recorded_at) VALUES
    (${owner.instanceId},${owner.bootId},'owner_opened',0,NULL,NULL,NULL,clock_timestamp()-interval '3 hours'),
    (${owner.instanceId},${owner.bootId},'spawn_intent',1,${runId},NULL,NULL,clock_timestamp()-interval '2 hours'),
    (${owner.instanceId},${owner.bootId},'spawned',1,${runId},52,NULL,clock_timestamp()-interval '2 hours'),
    (${owner.instanceId},${owner.bootId},'group_exited',1,${runId},52,'pgid_esrch_after_sigkill',clock_timestamp()-interval '20 minutes') RETURNING id,kind`;
  const id = (kind: string) => Number(records.find(r => r.kind === kind)!.id);
  const local = { version: 1, kind: "gateway_local_end", requestId: q.requestId, owner, bindingHash: q.bindingHash, dispatches: 1, terminals: 1 };
  const [ended] = await client`INSERT INTO model_capacity_events(request_id,kind,from_state,to_state,epoch,revision,policy_hash,evidence,created_at)
    VALUES(${q.requestId},'dispatch_local_ended','indeterminate','indeterminate',1,7,${q.policyHash},${JSON.stringify(local)}::jsonb,clock_timestamp()-interval '59 minutes')
    RETURNING id,encode(sha256(convert_to(evidence::text,'UTF8')),'hex') hash`;
  Object.assign(fx.plan.originalOwner, { openedEventId: id("owner_opened"), groups: [{ seq: 1, pid: 52, runIdHash: sha(runId),
    spawnIntentEventId: id("spawn_intent"), spawnedEventId: id("spawned"), exitEventId: id("group_exited") }], localEndEventId: Number(ended.id), localEndEvidenceHash: ended.hash });
  const [row] = await client`SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') hash FROM model_capacity_requests r WHERE request_id=${q.requestId}`;
  q.rowHash = row.hash; fx.evidence.bindingHash = q.bindingHash; fx.receipt.planHash = replacedProviderPlanHash(fx.plan);
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
}, 120000);
afterAll(async () => {
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  await client.end({ timeout: 3 }); if (created) await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end({ timeout: 3 });
});
it("dry-run rolls back every row/event/audit", async () => {
  const before = await rows(), n = await counts();
  expect((await releaseReplacedProviderBoundaryRequest(input(), false)).kind).toBe("released");
  expect(await rows()).toEqual(before); expect(await counts()).toEqual(n);
});
it("SQL denies hash mismatch, missing boundaries, multi-request and success evidence", async () => {
  const good = { ...fx.evidence, evaluatedAt: new Date().toISOString() };
  expect((await client`SELECT nmv_replaced_provider_release_valid(${JSON.stringify(good)}::jsonb) valid`)[0].valid).toBe(true);
  for (const mutate of [
    (e: typeof good) => { e.receipt.relay.requestHash = h; },
    (e: typeof good) => { e.receipt.containers.pop(); },
    (e: typeof good) => { Object.assign(e.plan, { requestIds: [q.requestId] }); },
    (e: typeof good) => { Object.assign(e, { businessResult: true }); },
  ]) { const e = structuredClone(good); mutate(e); expect((await client`SELECT nmv_replaced_provider_release_valid(${JSON.stringify(e)}::jsonb) valid`)[0].valid).toBe(false); }
});
it("rejects row/C, control, writer and original termination evidence mismatches", async () => {
  const before = await rows(), n = await counts();
  for (const modify of [
    (p: typeof fx.plan) => { p.request.rowHash = h; },
    (p: typeof fx.plan) => { p.request.chargedTokens++; },
    (p: typeof fx.plan) => { p.control.revision++; },
    (p: typeof fx.plan) => { p.writer.writerEpoch++; },
    (p: typeof fx.plan) => { p.originalOwner.groups[0].exitEventId = p.originalOwner.openedEventId; },
  ]) {
    const value = structuredClone(input()); modify(value.plan); value.expectedPlanHash = value.receipt.planHash = replacedProviderPlanHash(value.plan);
    await expect(releaseReplacedProviderBoundaryRequest(value, true)).rejects.toThrow();
    expect(await rows()).toEqual(before); expect(await counts()).toEqual(n);
  }
});
it("apply withdraws exactly once, preserves business failure, unknown usage, binding/token/C and audits", async () => {
  const before = (await rows())[0].v, n = await counts();
  const result = await releaseReplacedProviderBoundaryRequest(input(), true);
  expect(result.kind).toBe("released"); expect("auditId" in result && result.auditId).toBeTruthy();
  const after = (await rows())[0].v;
  for (const key of Object.keys(before).filter(k => !["state", "terminal_evidence", "terminal_evidence_hash", "updated_at"].includes(k))) expect(after[key]).toEqual(before[key]);
  expect(after.state).toBe("withdrawn"); expect(after.settled_at).toBeNull(); expect(after.terminal_evidence.receipt.relay.state).toBe("indeterminate");
  expect(after.terminal_evidence_hash).toBe(providerBoundaryCanonicalHash(after.terminal_evidence));
  expect(await counts()).toEqual({ events: n.events + 1, audit: n.audit + 1 });
  expect((await releaseReplacedProviderBoundaryRequest(input(), true)).kind).toBe("already_released");
  expect(await counts()).toEqual({ events: n.events + 1, audit: n.audit + 1 });
  await expect(client`UPDATE model_capacity_requests SET dispatch_binding=jsonb_set(dispatch_binding,'{chargedTokens}','1'::jsonb) WHERE request_id=${q.requestId}`).rejects.toThrow();
  // Existing migration sources are used directly; no historical migration byte is rewritten.
  expect(readFileSync("drizzle/0137_cli_executor_indeterminate_removed_boundary_exit.sql", "utf8")).toContain("nmv_cli_executor_indeterminate_removed_transition_guard");
});
