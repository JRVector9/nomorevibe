import { randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { modelCapacityPolicyHash, productTranslationMemberKeys, productTranslationLogicalWorkKey, productTranslationInputHash,
  productTranslationDispatchBindingHash, type ProductTranslationDispatchBinding, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { replacedPathDigest as sha, replacedPathPlanHash, replacedPathRequiredHops, type ReplacedPathPlan,
  type ReplacedPathReceipt } from "@/lib/llm/replaced-path-boundary-contract";
import { providerBoundaryCanonicalHash } from "@/lib/llm/provider-boundary-contract";
import { readReplacedPathPlan, releaseReplacedPathBoundaryRequest } from "@/lib/operations/dr/replaced-path-boundary-release";
import { TEST_DATABASE_URL } from "./setup";

// Own disposable DB; production, business rows and provider endpoints are never touched.
const name = `nomorevibe_test_replaced_path_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 2, prepare: false, onnotice: () => {} });
const owner = { instanceId: "m3-text", bootId: randomUUID() }, requestId = randomUUID(), token = randomUUID(), h = sha("fixture");
const dispatchAt = new Date(Date.now() - 3_600_000).toISOString(), reference = "synthetic path replacement";
let created = false, plan: ReplacedPathPlan, receipt: ReplacedPathReceipt;
const members = [{ productId: 17, slug: "fixture", locale: "en" as const, field: "tagline" as const, sourceHash: h, demand: { rowIdentityHash: h, attempts: 0 } }];
const model = "[m1] qwen3.8-flash-next";
const binding: ProductTranslationDispatchBinding = { kind: "product_translation_gateway", version: 1, members, model,
  logicalWorkKey: productTranslationLogicalWorkKey(members), inputHash: productTranslationInputHash({ members, model }),
  provider: "abcllm", routeId: "product-translate", wireHash: h, servingContractHash: h, totalTokenBound: 40768, chargedTokens: 40768,
  job: { name: "product-translate", token: randomUUID(), requestedVersion: 1 },
  role: { role: "text", instanceId: owner.instanceId, bootId: owner.bootId, release: "a".repeat(40), kind: "primary", epoch: 1, batch: { mode: "legacy" } } };
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { "abcllm-m1-qwen": 1 }, groupLimits: { "m1-qwen": 1 },
  poolLimits: { text: 1, reviewer: 1 }, weights: { first: 4, second: 2, background: 1 }, maxWaiting: 10, queueTtlMs: 120000, reservationTtlMs: 30000,
  routes: [{ routeId: "product-translate", provider: "abcllm", model, providerBudgetId: "abcllm-m1-qwen", groupId: "m1-qwen" }] };
const replacedReceipt = (p: ReplacedPathPlan): ReplacedPathReceipt => {
  const observed = new Date(Math.max(Date.now() - 1000, Date.parse(p.createdAt))).toISOString();
  const hops = (replacedPathRequiredHops(p.request.owner.instanceId, p.request.providerBudgetId) ?? []).map((hop, i) => ({ ...hop,
    incarnationId: `incarnation-${i}`, startedAt: new Date(Date.parse(dispatchAt) + 60_000 + i).toISOString(), observedAt: observed,
    singleInstance: true as const, artifactHash: sha(`artifact-${i}`) }));
  return { version: 1, kind: "replaced_path_boundary_receipt", planHash: replacedPathPlanHash(p), observedAt: observed, hops };
};
const input = () => ({ plan, receipt, expectedPlanHash: replacedPathPlanHash(plan), operator: "fixture-operator", reference });
const rows = () => client`SELECT to_jsonb(r) v FROM model_capacity_requests r ORDER BY request_id`;
const counts = async () => ({ events: Number((await client`SELECT count(*) n FROM model_capacity_events`)[0].n), audit: Number((await client`SELECT count(*) n FROM operations_audit`)[0].n) });
const sqlValid = async (e: unknown) => (await client`SELECT nmv_replaced_path_release_valid(${JSON.stringify(e)}::jsonb) valid`)[0].valid;
const evidenceFor = (p: ReplacedPathPlan, r: ReplacedPathReceipt) => ({ version: 1, kind: "replaced_path_boundary_exit", requestId: p.request.requestId,
  owner: p.request.owner, fromState: "indeterminate", dispatchAt: p.request.dispatchAt, bindingHash: p.request.bindingHash, notBefore: r.observedAt,
  evaluatedAt: new Date().toISOString(), operator: "fixture-operator", reference, plan: p, receipt: r });
beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrate(drizzle(client), { migrationsFolder: path.resolve("drizzle") });
  const policyHash = modelCapacityPolicyHash(policy);
  await client`UPDATE model_capacity_control SET mode='draining',epoch=1,revision=7,policy=${JSON.stringify(policy)}::jsonb,policy_hash=${policyHash},updated_at=clock_timestamp()-interval '1 minute' WHERE id=1`;
  await client`INSERT INTO model_capacity_requests(request_id,work_key,owner_instance_id,owner_boot_id,class,pool,route_id,provider,model,provider_budget_id,group_id,epoch,revision,policy_hash,state,logical_work_key,logical_member_keys,dispatch_binding,dispatch_binding_hash,dispatched_at,token,reserved_until,queue_until)
    VALUES(${requestId},${binding.logicalWorkKey+":"+binding.inputHash},${owner.instanceId},${owner.bootId},'background','text','product-translate','abcllm',${model},'abcllm-m1-qwen','m1-qwen',1,7,${policyHash},'indeterminate',${binding.logicalWorkKey},${productTranslationMemberKeys(members)}::text[],${JSON.stringify(binding)}::jsonb,${productTranslationDispatchBindingHash(binding)},${dispatchAt},${token},clock_timestamp(),clock_timestamp())`;
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
  plan = await readReplacedPathPlan({ requestId, reviewReference: reference });
  receipt = replacedReceipt(plan);
}, 120000);
afterAll(async () => {
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  await client.end({ timeout: 3 }); if (created) await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end({ timeout: 3 });
});
it("plans from the exact ledger row, DRAIN pin and writer", async () => {
  const [row] = await client`SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') hash FROM model_capacity_requests r WHERE request_id=${requestId}`;
  expect(plan.request).toMatchObject({ requestId, owner, tokenHash: sha(token), dispatchAt, providerBudgetId: "abcllm-m1-qwen", groupId: "m1-qwen",
    servingContractHash: h, rowHash: row.hash, routeId: "product-translate", provider: "abcllm", model });
  expect(plan.control.mode).toBe("draining");
  expect(await sqlValid(evidenceFor(plan, receipt))).toBe(true);
  const early = structuredClone(receipt), before = new Date(Date.parse(plan.createdAt) - 600_000).toISOString();
  for (const hop of early.hops) hop.observedAt = before;
  early.observedAt = before;
  expect(await sqlValid(evidenceFor(plan, early)), "a replacement read back before the plan stays valid").toBe(true);
});
it("SQL denies an unreplaced, missing, reordered or unregistered hop", async () => {
  for (const mutate of [
    (r: ReplacedPathReceipt) => { r.hops[4].startedAt = dispatchAt; },
    (r: ReplacedPathReceipt) => { r.hops.pop(); },
    (r: ReplacedPathReceipt) => { r.hops.reverse(); },
    (r: ReplacedPathReceipt) => { r.hops[1].service = "other"; },
    (r: ReplacedPathReceipt) => { r.hops[2].incarnationId = r.hops[1].incarnationId; r.hops[2].host = r.hops[1].host; },
    (r: ReplacedPathReceipt) => { Object.assign(r, { businessResult: true }); },
  ]) { const r = structuredClone(receipt); mutate(r); expect(await sqlValid(evidenceFor(plan, r))).toBe(false); }
  const foreign = structuredClone(plan); foreign.request.providerBudgetId = "abcllm-unknown";
  const r = replacedReceipt(foreign); expect(await sqlValid(evidenceFor(foreign, r))).toBe(false);
});
it("dry-run rolls back every row/event/audit", async () => {
  const before = await rows(), n = await counts();
  expect((await releaseReplacedPathBoundaryRequest(input(), false)).kind).toBe("released");
  expect(await rows()).toEqual(before); expect(await counts()).toEqual(n);
});
it("rejects row, control and writer mismatches without writing", async () => {
  const before = await rows(), n = await counts();
  for (const modify of [
    (p: ReplacedPathPlan) => { p.request.rowHash = h; },
    (p: ReplacedPathPlan) => { p.control.revision++; },
    (p: ReplacedPathPlan) => { p.writer.writerEpoch++; },
    (p: ReplacedPathPlan) => { p.request.servingContractHash = sha("other"); },
  ]) {
    const value = structuredClone(input()); modify(value.plan); value.expectedPlanHash = value.receipt.planHash = replacedPathPlanHash(value.plan);
    await expect(releaseReplacedPathBoundaryRequest(value, true)).rejects.toThrow();
    expect(await rows()).toEqual(before); expect(await counts()).toEqual(n);
  }
});
it("refuses to plan outside a DRAIN", async () => {
  await client`UPDATE model_capacity_control SET mode='open' WHERE id=1`;
  try { await expect(readReplacedPathPlan({ requestId, reviewReference: reference })).rejects.toThrow("replaced_path_requires_draining"); }
  finally { await client`UPDATE model_capacity_control SET mode='draining',updated_at=${plan.control.updatedAt}::timestamptz WHERE id=1`; }
});
it("apply withdraws exactly once, keeps binding/token/C and unknown usage, and audits", async () => {
  const before = (await rows())[0].v, n = await counts();
  const result = await releaseReplacedPathBoundaryRequest(input(), true);
  expect(result.kind).toBe("released"); expect("auditId" in result && result.auditId).toBeTruthy();
  const after = (await rows())[0].v;
  for (const key of Object.keys(before).filter(k => !["state", "terminal_evidence", "terminal_evidence_hash", "updated_at"].includes(k))) expect(after[key]).toEqual(before[key]);
  expect(after.state).toBe("withdrawn"); expect(after.settled_at).toBeNull();
  expect(after.terminal_evidence_hash).toBe(providerBoundaryCanonicalHash(after.terminal_evidence));
  expect(await counts()).toEqual({ events: n.events + 1, audit: n.audit + 1 });
  expect((await releaseReplacedPathBoundaryRequest(input(), true)).kind).toBe("already_released");
  expect(await counts()).toEqual({ events: n.events + 1, audit: n.audit + 1 });
  await expect(client`UPDATE model_capacity_requests SET dispatch_binding=jsonb_set(dispatch_binding,'{chargedTokens}','1'::jsonb) WHERE request_id=${requestId}`).rejects.toThrow();
});
