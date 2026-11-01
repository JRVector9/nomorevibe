import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { operatorReviewDispatchSql, operatorReviewEventSql, operatorReviewTerminalSql } from "@/lib/llm/operator-review-sql";
import { localModelSplitJobsDispatchSql, localModelSplitJobsEventTerminalSql, localModelSplitJobsTerminalSql } from "@/lib/llm/local-model-capacity-sql";
import { gatewayLocalDirectDispatchSql, gatewayLocalDirectEventTerminalSql, gatewayLocalDirectLogicalSql, gatewayLocalDirectMembersSql,
  gatewayLocalDirectTerminalSql } from "@/lib/llm/gateway-local-direct-sql";
import { db } from "@/lib/db";
import { createReviewInput, reviewHash, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { gatewayNotStartedAllKindsEventTerminalSql, gatewayNotStartedAllKindsTerminalSql, gatewayNotStartedKindsSql, modelCapacityEvents,
  modelCapacityRequests, type CrawlCandidate, type CrawlDocument } from "@/lib/db/schema";
import { itemBindingHash, type Ai2ItemBinding, type ItemLease } from "@/lib/jobs/items/types";
import { claimItemLease, lockItemStage } from "@/lib/jobs/items/repository";
import { modelCapacityPolicyHash, productTranslationInputHash, productTranslationLogicalWorkKey, type Ai1DispatchBinding, type Ai1ModelDispatch,
  type Ai2DispatchBinding, type GatewayNotStartedEvidence, type ModelCapacityPolicy, type ModelCapacityRequest, type ModelCapacityReservation,
  type ModelSlotResult, type ProductTranslationDispatchBinding, type ProductTranslationMember } from "@/lib/llm/capacity";
import { cancelReservedModelSlot, finishAi1ModelCapacityDispatch, finishAi2ItemModelCapacityDispatch, finishProductTranslationModelCapacityDispatch,
  lockAi1ModelCapacityDispatch, lockAi2ItemModelCapacityDispatch, lockProductTranslationModelCapacityDispatch, markModelDispatchIndeterminate,
  reconcileGatewayNotStarted, requestAi1ModelSlot, requestAi2ItemModelSlot, requestLocalModelSlot,
  requestProductTranslationModelSlot } from "@/lib/llm/capacity-repository";
import { markUnsettledDispatch } from "@/lib/llm/capacity-unsettled";
import { publicationClassifyReleaseLogicalSql, releaseKindsDispatchSql } from "@/lib/llm/dispatch-release-kinds-sql";
import { localModelBindingHash, localModelJob, localModelLogicalKey, localModelRoute, type LocalModelBinding,
  type LocalModelTarget } from "@/lib/llm/local-model-capacity-contract";
import { prepareAi1GatewayCall, prepareAi2GatewayCall, readGatewayNotStarted, settleAi1GatewayNotStarted,
  type GatewayNotStarted, type PreparedAi2GatewayCall } from "@/lib/crawl/agent-review-gateway";
import { abandonAgentReviewModelCapacity, reviewAgentReviewModelCapacity } from "@/lib/crawl/agent-review-model-capacity";
import { abandonSecondReviewModelCapacity, reviewSecondReviewModelCapacity } from "@/lib/crawl/second-review-model-capacity";
import type { Ai1GatewayServingContract } from "@/lib/crawl/agent-review-serving-contract";
import type { Ai2GatewayServingContract } from "@/lib/crawl/second-review-serving-contract";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";
import { directContractRow } from "./direct-engine-fixtures";

/**
 * F2 결함 1·3 실제 DB driver(0102). fetch 를 부르지 않은 AI1·AI2 gateway dispatch 는 같은 owner handle 의 not_started 증인으로 settled 가 되고
 * 슬롯·후보/표 키가 풀린다. 전송 여부를 모르는 행(indeterminate)은 받지 않는다. 정산 실패는 commit_unknown 으로 표시된다.
 * 0149 부터 같은 증거가 text 경로(product-translate 로 대표)와 local-direct(local_model_direct) dispatch 도 정산한다 — 그 두 경우는 증인 발급이
 * 게이트웨이·local-direct 모듈의 몫이라 이 장부 driver 는 증인 객체를 그 dispatch 의 증거에 직접 묶는다(readGatewayNotStarted 만 덧씌움).
 * 모든 행·event·item lease·control·stage 는 끝나면 whole-DB 기준선으로 되돌린다(events 는 이 fixture 의 request 만 지운다).
 */
const serving = vi.hoisted(() => ({ ai1: null as Ai1GatewayServingContract | null, ai2: null as Ai2GatewayServingContract | null }));
const issued = vi.hoisted(() => ({ witnesses: new WeakMap<object, unknown>() }));
vi.mock("@/lib/crawl/agent-review-serving-contract", async original => ({
  ...await original<typeof import("@/lib/crawl/agent-review-serving-contract")>(), resolveAi1GatewayServingContract: () => serving.ai1,
}));
vi.mock("@/lib/crawl/second-review-serving-contract", async original => ({
  ...await original<typeof import("@/lib/crawl/second-review-serving-contract")>(), resolveAi2GatewayServingContract: () => serving.ai2,
}));
vi.mock("@/lib/crawl/agent-review-gateway", async original => {
  const actual = await original<typeof import("@/lib/crawl/agent-review-gateway")>();
  return { ...actual, readGatewayNotStarted: (value: unknown) =>
    (value && typeof value === "object" ? issued.witnesses.get(value) as GatewayNotStartedEvidence | undefined : undefined)
    ?? actual.readGatewayNotStarted(value) };
});
type Raw = Record<string, unknown>;
const root = fileURLToPath(new URL("../..", import.meta.url));
const tag = randomBytes(6).toString("hex"), prefix = `f2-not-started-${tag}`, owner = { instanceId: prefix, bootId: randomUUID() };
const stepName = `nomorevibe_test_f2_step_${tag}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: "f2-not-started-fixture" } });
const owned = new Map<string, ModelCapacityRequest>(), items = new Map<string, ItemLease>(), work = new Set<Promise<unknown>>();
const model = "Exact Model", localModel = "fixture-local";
let serial = Number.parseInt(randomUUID().slice(0, 7), 16), initial: Record<string, unknown> = {}, initialized = false;
let originalControl: Raw, originalStage: Raw, stepCreated = false;
let posts = 0, server: ReturnType<typeof createServer> | undefined, endpoint = "";
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { account: 4, "fixture-direct": 4 },
  groupLimits: { engine: 4, "same-hardware": 4 },
  poolLimits: { reviewer: 4, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12, queueTtlMs: 60_000,
  reservationTtlMs: 60_000, routes: [
    { routeId: "crawl-agent-review", provider: "abcllm", model, providerBudgetId: "account", groupId: "engine" },
    { routeId: "second-review", provider: "abcllm", model, providerBudgetId: "account", groupId: "engine" },
    { routeId: "product-translate", provider: "abcllm", model, providerBudgetId: "account", groupId: "engine" },
    { routeId: "local-audit", provider: "local-direct", model: localModel, providerBudgetId: "fixture-direct", groupId: "same-hardware" }] };
function tracked<T>(pending: Promise<T>): Promise<T> { work.add(pending); void pending.catch(() => {}); return pending; }
async function whole(tx: postgres.Sql | postgres.TransactionSql = admin) {
  const value: Record<string, unknown> = {};
  for (const { tablename } of await tx`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
    const [row] = await tx.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value
      FROM public."${String(tablename).replaceAll('"', '""')}" t`);
    value[tablename] = row.value;
  }
  return value;
}
async function cleanup() {
  if (!initialized) return;
  await Promise.allSettled([...work]); work.clear();
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const ids = [...owned.keys()];
    for (const row of await tx`SELECT * FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[]) FOR UPDATE`) {
      const value = owned.get(row.request_id)!;
      expect([row.work_key, row.owner_instance_id, row.owner_boot_id, row.route_id]).toEqual([value.workKey, value.owner.instanceId,
        value.owner.bootId, value.routeId]);
    }
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    const events = await tx`SELECT id::text,request_id FROM model_capacity_events WHERE request_id=ANY(${ids}::uuid[]) ORDER BY id`;
    if (events.length) {
      await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
      for (const event of events) expect(await tx`DELETE FROM model_capacity_events WHERE id=${event.id}::bigint
        AND request_id=${event.request_id}::uuid RETURNING id`).toHaveLength(1);
      await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    }
    await tx`DELETE FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[])`;
    for (const lease of items.values()) expect(await tx`DELETE FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${lease.workKey}
      AND binding_hash=${lease.bindingHash} RETURNING work_key`).toHaveLength(1);
    await tx`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,policy_hash=r.policy_hash,
      cursor=r.cursor,updated_at=r.updated_at FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalControl)}::text::jsonb) r
      WHERE c.id=r.id`;
    await tx`UPDATE pipeline_stage_modes s SET mode=r.mode,epoch=r.epoch,writer_contract_version=r.writer_contract_version,
      draining_from=r.draining_from,updated_at=r.updated_at
      FROM jsonb_populate_record(NULL::pipeline_stage_modes,${JSON.stringify(originalStage)}::text::jsonb) r WHERE s.stage=r.stage`;
    expect(await tx`SELECT tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass
      AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate') ORDER BY tgname`)
      .toEqual([{ tgenabled: "A" }, { tgenabled: "A" }]);
    expect(await whole(tx)).toEqual(initial);
  });
  owned.clear(); items.clear();
}
async function install() {
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(policy)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(policy)},cursor=0,updated_at=clock_timestamp() WHERE id=1`;
  await admin`UPDATE pipeline_stage_modes SET mode='items',writer_contract_version=1,draining_from=NULL,updated_at=clock_timestamp() WHERE stage='ai2'`;
}
function input(): ReviewInput {
  const now = new Date("2026-10-17T00:00:00.000Z");
  return createReviewInput({ repo: `${prefix}/app`, productUrl: "https://f2.example", judgedAt: now } as CrawlCandidate,
    { id: 1, repo: `${prefix}/app`, productUrl: "https://f2.example", repoMeta: { description: "A usable task tracker" },
      pageMeta: { title: "F2" }, pageStatus: 200, fetchedAt: now } as CrawlDocument, DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
}
function granted(result: ModelSlotResult): ModelCapacityReservation {
  expect(result.kind).toBe("granted"); if (result.kind !== "granted") throw new Error("actual_reservation_required");
  return result.reservation;
}
function identity(value: ModelCapacityRequest) { const result = { ...value }; Reflect.deleteProperty(result, "requestId"); return result; }
function remember(value: ModelCapacityRequest) { owned.set(value.requestId, structuredClone(value)); return value; }
async function ai1(value = input(), candidateId = ++serial, who = owner) {
  const call = prepareAi1GatewayCall(value, { model, timeoutMs: 2_000 });
  if (call.kind !== "prepared") throw new Error("actual_prepared_required");
  const requested = remember({ requestId: randomUUID(), workKey: `ai1:${candidateId}:${randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
    owner: { ...who }, class: "first", pool: "reviewer", routeId: "crawl-agent-review", provider: "abcllm", model });
  const handle = granted(await tracked(requestAi1ModelSlot(requested, candidateId)));
  // Ledger driver fixture: the binding commits to this actual preparation; the domain claim is the runtime driver's concern.
  const binding: Ai1DispatchBinding = { kind: "ai1_legacy_gateway", version: 1, logicalWorkKey: `ai1:${candidateId}`, candidateId,
    attemptId: ++serial, inputHash: value.inputHash, sourceRevisionHash: value.sourceRevisionHash, reviewPolicyHash: value.policyHash,
    promptVersion: value.snapshot.policy.promptVersion, rulesVersion: value.snapshot.policy.rulesVersion, provider: "abcllm", model,
    routeId: "crawl-agent-review", stageEpoch: 1, wireHash: call.wireHash, servingContractHash: call.servingContractHash,
    totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound, job: { name: "crawl-agent-review", token: randomUUID(), requestedVersion: 1 } };
  const dispatch = await tracked(db.transaction(async tx => {
    const lock = await lockAi1ModelCapacityDispatch(tx, { reservation: handle, identity: identity(requested), candidateId });
    if (!lock) throw new Error("actual_lock_required");
    return finishAi1ModelCapacityDispatch(tx, lock, binding);
  }));
  return { value, call, dispatch, requested, candidateId };
}
async function ai2(value = input()) {
  const call = await prepareAi2GatewayCall(value, { model, timeoutMs: 2_000 }) as PreparedAi2GatewayCall;
  if (call.kind !== "prepared") throw new Error("actual_prepared_required");
  const id = ++serial;
  const review: Ai2ItemBinding = { stage: "ai2", candidateId: id, secondReviewId: id, vote: id, fallbackForId: null,
    source: { kind: "first_attempt", firstAttemptId: id }, inputHash: value.inputHash, sourceRevisionHash: value.sourceRevisionHash,
    policyHash: value.policyHash, promptVersion: value.snapshot.policy.promptVersion, rulesVersion: value.snapshot.policy.rulesVersion,
    generationKey: "c".repeat(64), reviewer: { provider: "abcllm", model } };
  const logical = `ai2:${id}:${id}`;
  const requested = remember({ requestId: randomUUID(), workKey: `${logical}:${itemBindingHash(review)}`, owner: { ...owner },
    class: "second", pool: "reviewer", routeId: "second-review", provider: "abcllm", model });
  const handle = granted(await tracked(requestAi2ItemModelSlot(requested, { candidateId: id, vote: id })));
  const result = await tracked(db.transaction(async tx => {
    const lock = await lockAi2ItemModelCapacityDispatch(tx, { reservation: handle, identity: identity(requested), target: { candidateId: id, vote: id } });
    if (!lock) throw new Error("actual_lock_required");
    const stage = await lockItemStage(tx, "ai2"), lease = await claimItemLease(tx, stage, review, requested.owner, 90_000);
    if (!lease) throw new Error("actual_item_claim_required");
    const binding: Ai2DispatchBinding = { kind: "ai2_item_gateway", version: 1, logicalWorkKey: logical, review, rowIdentityHash: "d".repeat(64),
      failureCount: 0, inputPolicyHash: value.policyHash, item: { workKey: lease.workKey, owner: lease.owner, token: lease.token,
        stageEpoch: lease.stageEpoch, itemEpoch: lease.itemEpoch, bindingHash: lease.bindingHash }, routeId: "second-review", provider: "abcllm",
      model, wireHash: call.wireHash, servingContractHash: call.servingContractHash, totalTokenBound: call.totalTokenBound,
      chargedTokens: call.totalTokenBound };
    return { lease, dispatch: await finishAi2ItemModelCapacityDispatch(tx, lock, binding) };
  }));
  items.set(result.lease.workKey, result.lease);
  return { value, call, dispatch: result.dispatch, requested, logical, id };
}
function translationMembers(...ids: number[]): ProductTranslationMember[] {
  return ids.map(productId => ({ productId, slug: `f2-${productId}`, locale: "en", field: "tagline", sourceHash: "a".repeat(64),
    demand: { rowIdentityHash: "b".repeat(64), attempts: 0 } }));
}
function translationBinding(value: ModelCapacityRequest, batch: readonly ProductTranslationMember[]): ProductTranslationDispatchBinding {
  return { kind: "product_translation_gateway", version: 1, members: structuredClone(batch) as ProductTranslationMember[], model: value.model,
    logicalWorkKey: productTranslationLogicalWorkKey(batch), inputHash: productTranslationInputHash({ members: batch, model: value.model }),
    provider: "abcllm", routeId: "product-translate", wireHash: "c".repeat(64), servingContractHash: "d".repeat(64), totalTokenBound: 8192,
    chargedTokens: 8192, job: { name: "product-translate", token: randomUUID(), requestedVersion: 1 },
    role: { role: "text", instanceId: value.owner.instanceId, bootId: value.owner.bootId, release: "ledger-fixture", kind: "primary", epoch: 1,
      batch: { mode: "legacy" } } };
}
/** text 경로 대표: product-translate dispatched 행(실제 slot → lock → finish). 제품·수요 행은 이 장부 driver 의 관심이 아니다. */
async function translate(batch = translationMembers(++serial, ++serial), who = owner) {
  const requested = remember({ requestId: randomUUID(), owner: { ...who }, class: "background", pool: "text", routeId: "product-translate",
    provider: "abcllm", model, workKey: `${productTranslationLogicalWorkKey(batch)}:${productTranslationInputHash({ members: batch, model })}` });
  const handle = granted(await tracked(requestProductTranslationModelSlot(requested, batch)));
  const dispatch = await tracked(db.transaction(async tx => {
    const lock = await lockProductTranslationModelCapacityDispatch(tx, { reservation: handle, identity: identity(requested), members: batch });
    if (!lock) throw new Error("actual_lock_required");
    return finishProductTranslationModelCapacityDispatch(tx, lock, translationBinding(requested, batch));
  }));
  return { dispatch, requested, batch };
}
/** local-direct dispatched 행. dispatchLocalModelCapacity 의 도메인 증명(감사 행·role/job lease)은 실행 driver 의 몫이라 reserved 행을 이 binding 으로
 * 바로 dispatched 로 옮긴다 — 저장되는 binding 모양은 CHECK 가 그대로 검증한다. */
async function local(who = owner) {
  const target: LocalModelTarget = { kind: "audit", purpose: "audit", itemId: ++serial, slug: `${prefix}-audit` };
  const logical = localModelLogicalKey(target), routeId = localModelRoute(target);
  const binding: LocalModelBinding = { kind: "local_model_direct", version: 1, target, logicalWorkKey: logical, routeId, provider: "local-direct",
    model: localModel, backendId: "fixture-direct", physicalGroup: "same-hardware", deploymentRevision: "fixture-deployment",
    inputHash: "a".repeat(64), sourceRevisionHash: "b".repeat(64), reviewPolicyHash: "c".repeat(64), promptVersion: "fixture-prompt",
    wireHash: "d".repeat(64), servingContractHash: "e".repeat(64), totalTokenBound: 8192, chargedTokens: 8192,
    job: { name: localModelJob(target), token: randomUUID(), requestedVersion: 1 } };
  const requested = remember({ requestId: randomUUID(), workKey: `${logical}:${binding.inputHash}`, owner: { ...who }, class: "background",
    pool: "reviewer", routeId, provider: "local-direct", model: localModel });
  const handle = granted(await tracked(requestLocalModelSlot(requested, target)));
  const bindingHash = localModelBindingHash(binding);
  expect(await admin`UPDATE model_capacity_requests SET state='dispatched',dispatch_binding=${JSON.stringify(binding)}::text::jsonb,
    dispatch_binding_hash=${bindingHash},dispatched_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE request_id=${requested.requestId}::uuid AND state='reserved' AND token=${handle.token}::uuid RETURNING request_id`).toHaveLength(1);
  return { dispatch: { ...handle, binding, bindingHash }, requested, target };
}
/** 이 dispatch 의 not_started 증거를 가진 증인 객체(발급 모듈이 할 일을 장부 driver 가 대신 묶는다). 사본·JSON 은 여전히 권한이 아니다. */
function witness(dispatch: unknown): GatewayNotStarted {
  const token: GatewayNotStarted = Object.freeze({ kind: "gateway_not_started" });
  issued.witnesses.set(token, Object.freeze({ version: 1, kind: "gateway_not_started", dispatch: structuredClone(dispatch) }));
  return token;
}
const constraintFailure = (error: unknown) => { const failure = error as { code?: string; constraint_name?: string }; return `${failure.code}:${failure.constraint_name}`; };
async function settledEvent(requestId: string, fromState: string, evidence: unknown) {
  const [current] = await admin`SELECT epoch,revision,policy_hash FROM model_capacity_requests WHERE request_id=${requestId}::uuid`;
  return admin`INSERT INTO model_capacity_events (request_id,kind,epoch,revision,policy_hash,from_state,to_state,reason,evidence)
    VALUES (${requestId}::uuid,'dispatch_settled',${current.epoch},${current.revision},${current.policy_hash},${fromState},'settled',NULL,
    ${JSON.stringify(evidence)}::text::jsonb)`.then(() => "accepted", constraintFailure);
}
const row = async (id: string) => (await admin`SELECT to_jsonb(r) AS value FROM model_capacity_requests r WHERE request_id=${id}::uuid`)[0]?.value as Raw;
const events = async (id: string) => Array.from(await admin`SELECT kind,from_state,to_state,reason,evidence FROM model_capacity_events
  WHERE request_id=${id}::uuid ORDER BY id`);
const aborted = () => { const controller = new AbortController(); controller.abort(); return controller.signal; };
function expectSettled(raw: Raw, dispatch: unknown) {
  const evidence = { version: 1, kind: "gateway_not_started", dispatch };
  expect(raw).toMatchObject({ state: "settled", terminal_evidence: evidence, terminal_evidence_hash: reviewHash(evidence) });
  expect(raw.settled_at).not.toBeNull();
  return evidence;
}
async function constraintDefs(sql: postgres.Sql, names: readonly string[]) {
  return Object.fromEntries(Array.from(await sql<{ name: string; def: string }[]>`SELECT conname AS name, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conname = ANY(${names as string[]}::text[])`).map(value => [value.name, value.def]));
}
const innerPredicate = (def: string) => { expect(def.startsWith("CHECK (")).toBe(true); return def.slice("CHECK (".length, -1); };
/** PostgreSQL's own parse→deparse fixed point of a CHECK predicate on the disposable step DB (its tables are empty, so ADD CONSTRAINT only parses).
 * Source text and a pg_get_constraintdef rebuild of the same predicate differ only until this point; no SQL is edited by hand to compare them. */
async function canonicalPredicate(sql: postgres.Sql, table: string, predicate: string) {
  let current = predicate;
  for (let round = 0; round < 4; round++) {
    await sql.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT f2_canonical CHECK (${current})`);
    try {
      const next = innerPredicate((await constraintDefs(sql, ["f2_canonical"])).f2_canonical);
      if (next === current) return next;
      current = next;
    } finally { await sql.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT f2_canonical`); }
  }
  throw new Error("f2_canonical_predicate_unstable");
}
const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
const LEFT = ["model_capacity_requests_terminal_check", "model_capacity_events_terminal_check"] as const;
const UNTOUCHED = ["model_capacity_requests_dispatch_check", "model_capacity_requests_logical_check", "model_capacity_requests_members_check",
  "model_capacity_events_kind_check", "model_capacity_events_reason_check", "model_capacity_requests_state_check"] as const;

beforeAll(async () => {
  ensureSchema();
  expect(journal.entries.map(entry => entry.tag)).toContain("0102_model_capacity_gateway_not_started");
  expect(journal.entries.map(entry => entry.tag)).toContain("0149_gateway_not_started_all_kinds");
  const [applied] = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  expect(applied.count).toBe(journal.entries.length);
  initial = await whole();
  if ((initial.model_capacity_requests as Raw[]).some(value => ["waiting", "reserved", "dispatched", "indeterminate"].includes(String(value.state))))
    throw new Error("f2_fixture_active_capacity");
  originalControl = (initial.model_capacity_control as Raw[])[0];
  originalStage = (initial.pipeline_stage_modes as Raw[]).find(value => value.stage === "ai2")!;
  if (!originalControl || !originalStage || (initial.pipeline_item_leases as Raw[]).some(value => value.stage === "ai2" && value.token !== null))
    throw new Error("f2_fixture_stage_busy");
  initialized = true;
  server = createServer((request, response) => { posts++; request.resume(); request.on("end", () => response.end("{}")); });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_address");
  endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
}, 120_000);
afterEach(async () => { await cleanup(); serving.ai1 = null; serving.ai2 = null; vi.unstubAllEnvs(); setServingContractSnapshotForTest(null); });
afterAll(async () => {
  const errors: unknown[] = [];
  for (const load of [cleanup, async () => { if (initialized) expect(await whole()).toEqual(initial); },
    async () => { if (stepCreated) await admin.unsafe(`DROP DATABASE IF EXISTS ${stepName} WITH (FORCE)`); },
    async () => { server?.closeAllConnections(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); },
    async () => { await (globalThis as { pgClient?: postgres.Sql }).pgClient?.end(); }, () => admin.end()])
    try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "f2_fixture_cleanup_failed");
}, 120_000);
function contracts() {
  // Engines connected directly (admin rows, no key) — the abcLLM gateway and its key were removed on 2026-10-30.
  setServingContractSnapshotForTest([directContractRow("crawl-agent-review", model), directContractRow("second-review", model)]);
  const base = { version: 1 as const, protocol: "abcllm-raw-total-bound-v1" as const, provider: "abcllm" as const, model, responseModel: "native-model",
    endpoint, deploymentRevision: "local-test-only", totalTokenBound: 8_000 };
  serving.ai1 = { ...base, routeId: "crawl-agent-review" }; serving.ai2 = { ...base, routeId: "second-review" };
}

it("0102: exact migration prefixes preserve earlier CHECKs; current constraints retain the legacy branches", async () => {
  await admin.unsafe(`CREATE DATABASE ${stepName}`); stepCreated = true;
  const url = new URL(TEST_DATABASE_URL); url.pathname = `/${stepName}`;
  const step = postgres(url.toString(), { max: 1, onnotice: () => {} });
  const partial = mkdtempSync(path.join(tmpdir(), "f2-0102-migrations-"));
  try {
    mkdirSync(path.join(partial, "meta"));
    const migrateThrough = async (index: number) => {
      const entries = journal.entries.filter(entry => entry.idx <= index);
      for (const entry of entries) copyFileSync(path.join(root, "drizzle", `${entry.tag}.sql`), path.join(partial, `${entry.tag}.sql`));
      writeFileSync(path.join(partial, "meta/_journal.json"), JSON.stringify({ ...JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"),
        "utf8")), entries }));
      await migrate(drizzle(step), { migrationsFolder: partial });
      const [applied] = await step<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
      expect(applied.count).toBe(entries.length);
    };
    expect(journal.entries.find(entry => entry.idx === 101)!.tag).toBe("0101_dr_process_group_successor_exit");
    await step.unsafe("set statement_timeout = 0");
    await migrateThrough(101);
    const before = await constraintDefs(step, [...LEFT, ...UNTOUCHED]);
    await migrateThrough(102);
    const after = await constraintDefs(step, [...LEFT, ...UNTOUCHED]);
    const inner = (def: string) => { expect(def.startsWith("CHECK (")).toBe(true); return def.slice("CHECK (".length, -1); };
    for (const name of LEFT) {
      const left = inner(before[name]), combined = inner(after[name]);
      expect(left).not.toContain("gateway_not_started");
      expect(combined.length).toBeGreaterThan(left.length);
      expect(combined.startsWith(`${left.slice(0, -1)} OR `)).toBe(true);
      expect(combined.slice(left.length - 1)).toContain("gateway_not_started");
    }
    for (const name of UNTOUCHED) expect(after[name]).toBe(before[name]);

    // Preserve the historical exact-prefix assertion through 0125. 0126 wraps the entire
    // predecessor (rather than flattening its OR), so compare that whole predicate separately.
    await migrateThrough(125);
    const priorBoundary = await constraintDefs(step, [...LEFT, ...UNTOUCHED]);
    for (const name of [...LEFT, ...UNTOUCHED.slice(0, 3)]) {
      const legacy = inner(after[name]), combined = inner(priorBoundary[name]);
      expect(combined.startsWith(`${legacy.slice(0, -1)} OR `), `${name}: current legacy prefix`).toBe(true);
    }
    await migrateThrough(126);
    const priorPendingCancellation = await constraintDefs(step, [...LEFT, ...UNTOUCHED]);
    // First prove the original historical boundary through 0131. 0132 intentionally
    // adds a separate AI2 provider branch to four of these CHECKs.
    await migrateThrough(131);
    const [applied] = await step<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    expect(applied.count).toBe(journal.entries.filter(entry => entry.idx <= 131).length);
    const current = await constraintDefs(step, [...LEFT, ...UNTOUCHED]);
    for (const name of [LEFT[0], ...UNTOUCHED.slice(0, 3)]) {
      const previous = inner(priorBoundary[name]);
      // Reparse the entire captured predecessor on this disposable DB. PostgreSQL can
      // flatten redundant OR/AND groups during this parse; compare its exact definition,
      // rather than deleting parentheses or any SQL predicate in the assertion.
      await step.unsafe(`ALTER TABLE model_capacity_requests ADD CONSTRAINT f2_boundary_expected CHECK ((${previous}) OR nmv_provider_boundary_request_valid(to_jsonb(model_capacity_requests)))`);
      try {
        const expected = await constraintDefs(step, ["f2_boundary_expected"]);
        expect(current[name], `${name}: entire 0125 predecessor`).toBe(expected.f2_boundary_expected);
      } finally { await step.unsafe("ALTER TABLE model_capacity_requests DROP CONSTRAINT f2_boundary_expected"); }
    }
    const eventKind = "model_capacity_events_kind_check";
    await step.unsafe(`ALTER TABLE model_capacity_events ADD CONSTRAINT f2_boundary_expected CHECK ((${inner(priorBoundary[eventKind])}) OR coalesce(kind='dispatch_released' AND from_state='indeterminate' AND to_state='withdrawn' AND reason IS NULL AND nmv_provider_boundary_release_valid(evidence) AND evidence->>'requestId'=request_id::text AND evidence->'plan'->'request'->'epoch'=to_jsonb(epoch) AND evidence->'plan'->'request'->'revision'=to_jsonb(revision) AND evidence->'plan'->'request'->>'policyHash'=policy_hash,false))`);
    try {
      const expected = await constraintDefs(step, ["f2_boundary_expected"]);
      expect(priorPendingCancellation[eventKind], `${eventKind}: entire 0125 predecessor`).toBe(expected.f2_boundary_expected);
    } finally { await step.unsafe("ALTER TABLE model_capacity_events DROP CONSTRAINT f2_boundary_expected"); }
    // 0127 also wraps its entire actual predecessor. Keep reason/evidence SQL NULL
    // and the exact waiting→withdrawn transition in this independently reparsed expectation.
    await step.unsafe(`ALTER TABLE model_capacity_events ADD CONSTRAINT f2_pending_expected CHECK ((${inner(priorPendingCancellation[eventKind])}) OR coalesce(kind='wait_cancelled' AND from_state='waiting' AND to_state='withdrawn' AND reason IS NULL AND evidence IS NULL,false))`);
    try {
      const expected = await constraintDefs(step, ["f2_pending_expected"]);
      expect(current[eventKind], `${eventKind}: entire 0126 predecessor`).toBe(expected.f2_pending_expected);
    } finally { await step.unsafe("ALTER TABLE model_capacity_events DROP CONSTRAINT f2_pending_expected"); }
    for (const name of [LEFT[1], ...UNTOUCHED.slice(3).filter(name => name !== eventKind)])
      expect(current[name], `${name}: current unchanged CHECK`).toBe(priorBoundary[name]);

    // Keep the historical 0131→0132 equality at its exact migration boundary.
    await migrateThrough(132);
    const afterAi2 = await constraintDefs(step, [...LEFT, ...UNTOUCHED]);
    const ai2Checks = [...LEFT, ...UNTOUCHED.slice(0, 2)];
    const ai2Migration = readFileSync(path.join(root, "drizzle", `${journal.entries.find(entry => entry.idx === 132)!.tag}.sql`), "utf8");
    for (const name of ai2Checks) {
      const statement = ai2Migration.split("--> statement-breakpoint").find(sql => sql.includes(`conname='${name}'`))!;
      const branch = /\$ai2_local\$([\s\S]*?)\$ai2_local\$/.exec(statement)?.[1];
      expect(branch, `${name}: additive AI2 branch`).toBeDefined();
      const table = name.startsWith("model_capacity_events_") ? "model_capacity_events" : "model_capacity_requests";
      // Preserve the whole real 0131 predicate and compare PostgreSQL's own parse
      // of exactly the additive branch, including both terminal and no-call paths.
      await step.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT f2_ai2_expected CHECK ((${inner(current[name])}) OR (${branch}))`);
      try {
        const expected = await constraintDefs(step, ["f2_ai2_expected"]);
        expect(afterAi2[name], `${name}: entire 0131 predecessor`).toBe(expected.f2_ai2_expected);
      } finally { await step.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT f2_ai2_expected`); }
    }
    for (const name of [...LEFT, ...UNTOUCHED].filter(name => !ai2Checks.includes(name)))
      expect(afterAi2[name], `${name}: 0132 unchanged CHECK`).toBe(current[name]);

    // 0133 leaves these CHECKs intact. 0134 adds only the strict CLI executor
    // branches; reparse the whole captured predecessor without normalizing SQL.
    await migrateThrough(134);
    const [latestApplied] = await step<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    expect(latestApplied.count).toBe(journal.entries.filter(entry => entry.idx <= 134).length);
    const latest = await constraintDefs(step, [...LEFT, ...UNTOUCHED]);
    const cliChecks: readonly string[] = [LEFT[0], ...UNTOUCHED.slice(0, 3), eventKind];
    for (const name of cliChecks) {
      const table = name === eventKind ? "model_capacity_events" : "model_capacity_requests";
      const branch = name === eventKind
        ? "coalesce(kind='dispatch_released' AND from_state='dispatched' AND to_state='withdrawn' AND reason IS NULL AND nmv_cli_executor_release_valid(evidence) AND evidence->>'requestId'=request_id::text AND evidence->'plan'->'request'->'epoch'=to_jsonb(epoch) AND evidence->'plan'->'request'->'revision'=to_jsonb(revision) AND evidence->'plan'->'request'->>'policyHash'=policy_hash,false)"
        : "nmv_cli_executor_request_valid(to_jsonb(model_capacity_requests))";
      await step.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT f2_cli_expected CHECK ((${inner(afterAi2[name])}) OR ${branch})`);
      try {
        const expected = await constraintDefs(step, ["f2_cli_expected"]);
        expect(latest[name], `${name}: entire 0132 predecessor plus strict 0134 branch`).toBe(expected.f2_cli_expected);
      } finally { await step.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT f2_cli_expected`); }
    }
    for (const name of [...LEFT, ...UNTOUCHED].filter(name => !cliChecks.includes(name)))
      expect(latest[name], `${name}: 0134 unchanged CHECK`).toBe(afterAi2[name]);
    // The whole compiled0134 predicate remains the left side of0135; reparse the exact new strict row-validator branch.
    await migrateThrough(135);
    const final = await constraintDefs(step, [...LEFT, ...UNTOUCHED]);
    for (const name of cliChecks) {
      const table = name === eventKind ? "model_capacity_events" : "model_capacity_requests";
      const branch = name === eventKind ? "nmv_cli_executor_removed_event_valid(to_jsonb(model_capacity_events))"
        : "nmv_cli_executor_removed_request_valid(to_jsonb(model_capacity_requests))";
      await step.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT f2_removed_expected CHECK ((${inner(latest[name])}) OR ${branch})`);
      try {
        const expected = await constraintDefs(step, ["f2_removed_expected"]);
        expect(final[name], `${name}: entire0134 predecessor plus strict0135 branch`).toBe(expected.f2_removed_expected);
      } finally { await step.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT f2_removed_expected`); }
    }
    for (const name of [...LEFT, ...UNTOUCHED].filter(name => !cliChecks.includes(name)))
      expect(final[name], `${name}: 0135 unchanged CHECK`).toBe(latest[name]);
    await migrateThrough(136);
    const unknown = await constraintDefs(step, [...LEFT, ...UNTOUCHED]);
    for (const name of cliChecks) {
      const table = name === eventKind ? "model_capacity_events" : "model_capacity_requests";
      const branch = name === eventKind ? "nmv_cli_executor_indeterminate_event_valid(to_jsonb(model_capacity_events))"
        : "nmv_cli_executor_indeterminate_request_valid(to_jsonb(model_capacity_requests))";
      await step.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT f2_unknown_expected CHECK ((${inner(final[name])}) OR ${branch})`);
      try {
        const expected = await constraintDefs(step, ["f2_unknown_expected"]);
        expect(unknown[name], `${name}: entire0135 predecessor plus strict0136 branch`).toBe(expected.f2_unknown_expected);
      } finally { await step.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT f2_unknown_expected`); }
    }
    for (const name of [...LEFT, ...UNTOUCHED].filter(name => !cliChecks.includes(name)))
      expect(unknown[name], `${name}: 0136 unchanged CHECK`).toBe(final[name]);
    await migrateThrough(137);
    const removedUnknown = await constraintDefs(step, [...LEFT, ...UNTOUCHED]);
    for (const name of cliChecks) {
      const table = name === eventKind ? "model_capacity_events" : "model_capacity_requests";
      const branch = name === eventKind ? "nmv_cli_executor_indeterminate_removed_event_valid(to_jsonb(model_capacity_events))"
        : "nmv_cli_executor_indeterminate_removed_request_valid(to_jsonb(model_capacity_requests))";
      await step.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT f2_removed_unknown_expected CHECK ((${inner(unknown[name])}) OR ${branch})`);
      try {
        const expected = await constraintDefs(step, ["f2_removed_unknown_expected"]);
        expect(removedUnknown[name], `${name}: entire0136 predecessor plus strict0137 branch`).toBe(expected.f2_removed_unknown_expected);
      } finally { await step.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT f2_removed_unknown_expected`); }
    }
    for (const name of [...LEFT, ...UNTOUCHED].filter(name => !cliChecks.includes(name)))
      expect(removedUnknown[name], `${name}: 0137 unchanged CHECK`).toBe(unknown[name]);
    // 0138~0142 leave these constraints unchanged; 0143 appends the strict replaced-provider branch and 0145 the replaced-path branch.
    // 0146~0148 leave them unchanged, so the 0148 boundary (every entry before 0149) still shows the 0145 shape.
    await migrateThrough(148);
    const replaced = await constraintDefs(step, [...LEFT, ...UNTOUCHED]);
    for (const name of cliChecks) {
      const table = name === eventKind ? "model_capacity_events" : "model_capacity_requests";
      const branch = name === eventKind ? "nmv_replaced_provider_event_valid(to_jsonb(model_capacity_events))"
        : "nmv_replaced_provider_request_valid(to_jsonb(model_capacity_requests))";
      const path = name === eventKind ? "nmv_replaced_path_event_valid(to_jsonb(model_capacity_events))"
        : "nmv_replaced_path_request_valid(to_jsonb(model_capacity_requests))";
      await step.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT f2_replaced_expected CHECK (((${inner(removedUnknown[name])}) OR ${branch}) OR ${path})`);
      try {
        const expected = await constraintDefs(step, ["f2_replaced_expected"]);
        expect(replaced[name], `${name}: entire0142 predicate plus strict0143 and 0145 branches`).toBe(expected.f2_replaced_expected);
      } finally { await step.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT f2_replaced_expected`); }
    }
    for (const name of [...LEFT, ...UNTOUCHED].filter(name => !cliChecks.includes(name)))
      expect(replaced[name], `${name}: 0143/0145 unchanged CHECK`).toBe(removedUnknown[name]);
    // 0149 rebuilds both terminal CHECKs from pg_get_constraintdef (the 0132 form): the entire live 0148 predicate is the left side and exactly
    // one gateway_not_started branch whose kind list covers every gateway dispatch kind is appended, so the live text is PostgreSQL's own
    // reparse of "(<0148 live predicate>) OR (<branch>)". The branch is the constant lib/db/operations-schema.ts composes with, never pasted SQL.
    expect(journal.entries.find(entry => entry.idx === 149)!.tag).toBe("0149_gateway_not_started_all_kinds");
    await migrateThrough(149);
    const widened = await constraintDefs(step, [...LEFT, ...UNTOUCHED]);
    const allKinds = readFileSync(path.join(root, "drizzle/0149_gateway_not_started_all_kinds.sql"), "utf8").split("--> statement-breakpoint");
    expect(gatewayNotStartedKindsSql).toBe("('ai1_legacy_gateway','ai1_item_gateway','ai2_item_gateway','text_profile_gateway','reason_translation_gateway',"
      + "'product_translation_gateway','product_tagline_ko_gateway','crawl_tagline_gateway','search_verify_gateway','websearch_query_gateway','local_model_direct')");
    for (const name of LEFT) {
      const events = name === "model_capacity_events_terminal_check", table = events ? "model_capacity_events" : "model_capacity_requests";
      const branch = events ? gatewayNotStartedAllKindsEventTerminalSql : gatewayNotStartedAllKindsTerminalSql;
      expect(branch).toContain(`'kind' IN ${gatewayNotStartedKindsSql}`); expect(branch).toContain("gateway_not_started");
      const statement = allKinds.find(sql => sql.includes(`conname='${name}'`))!;
      expect(statement, `${name}: rebuilt from the live predicate`).toContain("substring(pg_get_constraintdef(oid) FROM 7) INTO STRICT old_predicate");
      expect(statement).toContain(`ADD CONSTRAINT ${name} CHECK ((%s) OR (%s))`);
      expect(statement, `${name}: the appended branch is the schema constant`).toContain(`$ai2_local$${branch}$ai2_local$`);
      const check = getTableConfig(events ? modelCapacityEvents : modelCapacityRequests).checks.find(check => check.name === name)!;
      // 0157 appends the local-direct branches last (both terminal CHECKs), after 0155's split-jobs local_model_direct branch (both terminal
      // CHECKs) and 0151's operator_review branch (requests terminal CHECK); strip those tails newest first (each "(prev) OR (branch)" wrap)
      // before the 0149 checks.
      const localDirectTail = `) OR (${events ? gatewayLocalDirectEventTerminalSql : gatewayLocalDirectTerminalSql})`;
      const split = `) OR (coalesce((${events ? localModelSplitJobsEventTerminalSql : localModelSplitJobsTerminalSql}),false))`;
      let full = new PgDialect().sqlToQuery(check.value).sql;
      expect(full.startsWith("(") && full.endsWith(localDirectTail), `${name}: 0157 tail present`).toBe(true);
      full = full.slice(1, -localDirectTail.length);
      expect(full.endsWith(split), `${name}: 0155 tail present`).toBe(true);
      full = full.slice(1, -split.length);
      const tail = events ? null : `) OR (${operatorReviewTerminalSql})`;
      const suffix = `) OR (${branch})`;
      expect(tail === null || full.endsWith(tail), `${name}: 0151 tail present`).toBe(true);
      const expression = tail ? full.slice(1, -tail.length) : full;
      expect(expression.startsWith("(") && expression.endsWith(suffix), `${name}: Drizzle composes (previous) OR (branch)`).toBe(true);
      // Drizzle keeps composing from source text while the DB has rebuilt these CHECKs from deparsed text since 0126 (a BETWEEN becomes a
      // nested AND on the first parse and is flattened on the next). Both must meet at PostgreSQL's own parse→deparse fixed point.
      expect(await canonicalPredicate(step, table, expression.slice(1, -suffix.length)), `${name}: Drizzle predecessor is the live 0148 predicate`)
        .toBe(await canonicalPredicate(step, table, inner(replaced[name])));
      await step.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT f2_all_kinds_expected CHECK ((${inner(replaced[name])}) OR (${branch}))`);
      try {
        const expected = await constraintDefs(step, ["f2_all_kinds_expected"]);
        expect(widened[name], `${name}: entire 0148 predicate plus the 0149 all-kinds branch`).toBe(expected.f2_all_kinds_expected);
      } finally { await step.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT f2_all_kinds_expected`); }
      const widenedList = "'websearch_query_gateway'::text, 'local_model_direct'::text";
      expect(replaced[name]).not.toContain(widenedList); expect(widened[name]).toContain(widenedList);
    }
    for (const name of UNTOUCHED) expect(widened[name], `${name}: 0149 unchanged CHECK`).toBe(replaced[name]);
    // 0150 (topology) leaves every CHECK as 0149 left them; 0151 appends the operator_review branch to the requests dispatch/terminal
    // CHECKs and the events kind CHECK (one shared SQL function), again as (whole predecessor) OR (branch). 0152·0153 touch no CHECK here.
    expect(journal.entries.find(entry => entry.idx === 153)!.tag).toBe("0153_model_capacity_devices");
    await migrateThrough(153);
    const after0151 = await constraintDefs(step, [...LEFT, ...UNTOUCHED]);
    const reviewed: Record<string, string> = { model_capacity_requests_dispatch_check: operatorReviewDispatchSql,
      model_capacity_requests_terminal_check: operatorReviewTerminalSql, model_capacity_events_kind_check: operatorReviewEventSql };
    for (const name of [...LEFT, ...UNTOUCHED]) {
      const branch = reviewed[name];
      // 0151 also widens the reason list with client_timeout.
      if (name === "model_capacity_events_reason_check") { expect(after0151[name]).toContain("client_timeout"); continue; }
      if (!branch) { expect(after0151[name], `${name}: unchanged after 0151`).toBe(widened[name]); continue; }
      const table = name.startsWith("model_capacity_events_") ? "model_capacity_events" : "model_capacity_requests";
      await step.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT f2_review_expected CHECK ((${inner(widened[name])}) OR (${branch}))`);
      try { expect(after0151[name], `${name}: 0149 predicate plus the 0151 operator_review branch`).toBe((await constraintDefs(step, ["f2_review_expected"])).f2_review_expected); }
      finally { await step.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT f2_review_expected`); }
    }
    // 0155 (PR 3a-C, split composite jobs) appends the split-jobs local_model_direct branch — the same local_model_direct shape with the new
    // per-stage job names in binding.job.name — to the requests dispatch/terminal CHECKs and the events terminal CHECK, again as (whole predecessor) OR (branch).
    // The 0124 branch (old composite names) stays inside the predecessor, so rows dispatched before the split still pass.
    // 0156 (model assignments, PR 3b-A) adds tables only — these CHECKs stay as 0155 left them.
    expect(journal.entries.find(entry => entry.idx === 156)!.tag).toBe("0156_model_assignments");
    await migrateThrough(156);
    const after0155 = await constraintDefs(step, [...LEFT, ...UNTOUCHED]);
    const splitJobs: Record<string, string> = { model_capacity_requests_dispatch_check: localModelSplitJobsDispatchSql,
      model_capacity_requests_terminal_check: localModelSplitJobsTerminalSql, model_capacity_events_terminal_check: localModelSplitJobsEventTerminalSql };
    for (const name of [...LEFT, ...UNTOUCHED]) {
      const branch = splitJobs[name];
      if (!branch) { expect(after0155[name], `${name}: unchanged after 0155`).toBe(after0151[name]); continue; }
      expect(branch).toContain("'audit' THEN 'audit-qwen'"); expect(branch).toContain("'held_qwen' THEN 'held-qwen-retry'");
      expect(after0151[name]).toContain("product-audit"); expect(after0151[name]).not.toContain("audit-qwen"); expect(after0155[name]).toContain("audit-qwen");
      const table = name.startsWith("model_capacity_events_") ? "model_capacity_events" : "model_capacity_requests";
      await step.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT f2_split_expected CHECK ((${inner(after0151[name])}) OR (coalesce((${branch}),false)))`);
      try { expect(after0155[name], `${name}: 0151 predicate plus the 0155 split-jobs branch`).toBe((await constraintDefs(step, ["f2_split_expected"])).f2_split_expected); }
      finally { await step.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT f2_split_expected`); }
    }
    // 0157 (PR 3b-C transport unify) rebuilds the requests logical/members/dispatch/terminal CHECKs and the events terminal CHECK in the 0132
    // form: the whole live 0156 predecessor (0155's split branch included) plus the AI1/text abcllm branches with only the provider replaced
    // (the schema constants). Others stay.
    await migrateThrough(157);
    const after0157 = await constraintDefs(step, [...LEFT, ...UNTOUCHED]);
    const localDirect: Record<string, string> = { model_capacity_requests_logical_check: gatewayLocalDirectLogicalSql,
      model_capacity_requests_members_check: gatewayLocalDirectMembersSql, model_capacity_requests_dispatch_check: gatewayLocalDirectDispatchSql,
      model_capacity_requests_terminal_check: gatewayLocalDirectTerminalSql, model_capacity_events_terminal_check: gatewayLocalDirectEventTerminalSql };
    for (const name of [...LEFT, ...UNTOUCHED]) {
      const branch = localDirect[name];
      if (!branch) { expect(after0157[name], `${name}: unchanged by 0157`).toBe(after0155[name]); continue; }
      const localDirectCount = (def: string) => def.split("'local-direct'::text").length - 1;
      expect(localDirectCount(after0157[name]), `${name}: 0157 adds local-direct branches`).toBeGreaterThan(localDirectCount(after0155[name]));
      const table = name.startsWith("model_capacity_events_") ? "model_capacity_events" : "model_capacity_requests";
      await step.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT f2_local_direct_expected CHECK ((${inner(after0155[name])}) OR (${branch}))`);
      try { expect(after0157[name], `${name}: 0156 predicate plus the 0157 local-direct branches`).toBe((await constraintDefs(step, ["f2_local_direct_expected"])).f2_local_direct_expected); }
      finally { await step.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT f2_local_direct_expected`); }
    }
    // 0158 (release branch kinds, 2026-10-31) rebuilds the requests logical/members/dispatch CHECKs the same way: the whole live 0157 predecessor
    // plus the process_group_exit/dr_call_drain release branch for publication_classify_cli·local_model_direct (the schema constants).
    // Both terminal CHECKs and the events kind CHECK look at no binding kind for a release and stay as 0157 left them.
    await migrate(drizzle(step), { migrationsFolder: path.join(root, "drizzle") });
    const after0158 = await constraintDefs(step, [...LEFT, ...UNTOUCHED]);
    const releaseKinds: Record<string, string> = { model_capacity_requests_logical_check: publicationClassifyReleaseLogicalSql,
      model_capacity_requests_members_check: publicationClassifyReleaseLogicalSql, model_capacity_requests_dispatch_check: releaseKindsDispatchSql };
    for (const name of [...LEFT, ...UNTOUCHED]) {
      const branch = releaseKinds[name];
      if (!branch) { expect(after0158[name], `${name}: unchanged by 0158`).toBe(after0157[name]); continue; }
      expect(after0157[name]).not.toContain("'publication_classify_cli'::text, 'local_model_direct'::text");
      await step.unsafe(`ALTER TABLE model_capacity_requests ADD CONSTRAINT f2_release_kinds_expected CHECK ((${inner(after0157[name])}) OR (${branch}))`);
      try { expect(after0158[name], `${name}: 0157 predicate plus the 0158 release-kinds branch`).toBe((await constraintDefs(step, ["f2_release_kinds_expected"])).f2_release_kinds_expected); }
      finally { await step.unsafe(`ALTER TABLE model_capacity_requests DROP CONSTRAINT f2_release_kinds_expected`); }
    }
    expect(after0158.model_capacity_requests_dispatch_check).toContain("'publication_classify_cli'::text, 'local_model_direct'::text");
    expect((await step<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`)[0].count).toBe(journal.entries.length);
  } finally { rmSync(partial, { recursive: true, force: true }); await step.end({ timeout: 5 }); }
}, 600_000);

it("AI1: a pre-fetch abort through the real gateway settles the exact dispatch as not_started and frees the candidate key", async () => {
  await install(); contracts();
  const first = await ai1();
  const result = await tracked(reviewAgentReviewModelCapacity(first.value, first.dispatch, first.call, { signal: aborted() }));
  expect(result).toEqual({ ok: false, error: "cancelled" }); expect(posts).toBe(0);
  const evidence = expectSettled(await row(first.requested.requestId), first.dispatch);
  expect((await row(first.requested.requestId)).dispatch_binding).toEqual(first.dispatch.binding);
  expect(await events(first.requested.requestId)).toMatchObject([{ kind: "queued" }, { kind: "reserved" }, { kind: "dispatch_started" },
    { kind: "dispatch_settled", from_state: "dispatched", to_state: "settled", reason: null, evidence }]);
  // 같은 후보의 새 boot 요청이 장부 fence 에 막히지 않는다(indeterminate 였다면 capacity 로 미뤘다)
  const next = remember({ requestId: randomUUID(), workKey: `ai1:${first.candidateId}:${"b".repeat(64)}`,
    owner: { instanceId: `${prefix}-next`, bootId: randomUUID() }, class: "first", pool: "reviewer", routeId: "crawl-agent-review", provider: "abcllm", model });
  expect((await tracked(requestAi1ModelSlot(next, first.candidateId))).kind).toBe("granted");
});

it("AI1: abandon with the unused preparation settles once; without proof it stays indeterminate(local_abort) but no longer fences (2026-10-30)", async () => {
  await install(); contracts();
  const settled = await ai1();
  expect(await tracked(abandonAgentReviewModelCapacity(settled.dispatch, settled.call))).toBe(true);
  expectSettled(await row(settled.requested.requestId), settled.dispatch);
  const kept = await ai1();
  expect(await tracked(abandonAgentReviewModelCapacity(kept.dispatch))).toBe(true);
  expect(await row(kept.requested.requestId)).toMatchObject({ state: "indeterminate", terminal_evidence: null });
  expect((await events(kept.requested.requestId)).at(-1)).toMatchObject({ kind: "dispatch_indeterminate", reason: "local_abort" });
  const blocked = remember({ requestId: randomUUID(), workKey: `ai1:${kept.candidateId}:${"c".repeat(64)}`,
    owner: { instanceId: `${prefix}-blocked`, bootId: randomUUID() }, class: "first", pool: "reviewer", routeId: "crawl-agent-review", provider: "abcllm", model });
  // 2026-10-30: 미확인 행은 같은 후보 키의 다른 owner 를 막지 않는다 — 새 요청이 들어간다(미확인 행은 사람 검토용으로 남는다).
  expect(await tracked(requestAi1ModelSlot(blocked, kept.candidateId))).toMatchObject({ kind: "granted" });
  expect(posts).toBe(0);
});

it("refuses a witness for an already-indeterminate row and is idempotent for its own settled evidence", async () => {
  await install(); contracts();
  const unknown = await ai1(), witness = settleAi1GatewayNotStarted(unknown.call, unknown.dispatch);
  expect(readGatewayNotStarted(witness)?.dispatch).toEqual(unknown.dispatch);
  expect(await tracked(markModelDispatchIndeterminate(unknown.dispatch, "transport_unknown"))).toBe(true);
  const before = await row(unknown.requested.requestId);
  await expect(tracked(reconcileGatewayNotStarted(witness!))).rejects.toThrow("gateway_not_started_state_mismatch");
  expect(await row(unknown.requested.requestId)).toEqual(before);
  const fresh = await ai1(), proof = settleAi1GatewayNotStarted(fresh.call, fresh.dispatch)!;
  expect(await tracked(reconcileGatewayNotStarted(proof))).toEqual({ kind: "settled" });
  expect(await tracked(reconcileGatewayNotStarted(proof))).toEqual({ kind: "already_settled" });
  await expect(tracked(reconcileGatewayNotStarted(structuredClone(proof)))).rejects.toThrow("invalid_gateway_not_started");
  expect((await events(fresh.requested.requestId)).filter(value => value.kind === "dispatch_settled")).toHaveLength(1);
});

it("AI2: a pre-fetch abort and an abandon with the preparation settle the item dispatch and free the vote key", async () => {
  await install(); contracts();
  const vote = await ai2();
  const result = await tracked(reviewSecondReviewModelCapacity(vote.value, vote.dispatch, vote.call, { signal: aborted() }));
  expect(result).toEqual({ ok: false, error: "cancelled" });
  const evidence = expectSettled(await row(vote.requested.requestId), vote.dispatch);
  expect((await events(vote.requested.requestId)).at(-1)).toMatchObject({ kind: "dispatch_settled", from_state: "dispatched", evidence });
  const other = await ai2();
  expect(await tracked(abandonSecondReviewModelCapacity(other.dispatch, other.call))).toBe(true);
  expectSettled(await row(other.requested.requestId), other.dispatch);
  // 같은 표의 다음 요청(다른 boot)이 표 키 fence 에 막히지 않는다
  const next = remember({ requestId: randomUUID(), workKey: `${vote.logical}:${"e".repeat(64)}`, owner: { instanceId: `${prefix}-next`, bootId: randomUUID() },
    class: "second", pool: "reviewer", routeId: "second-review", provider: "abcllm", model });
  expect((await tracked(requestAi2ItemModelSlot(next, { candidateId: vote.id, vote: vote.id }))).kind).toBe("granted");
  expect(posts).toBe(0);
});

it("CHECKs reject a forged not_started row or event that is not the row's own dispatched handle", async () => {
  await install(); contracts();
  const value = await ai1(), proof = settleAi1GatewayNotStarted(value.call, value.dispatch)!;
  const forged = { version: 1, kind: "gateway_not_started", dispatch: { ...value.dispatch, token: randomUUID() } };
  const code = (error: unknown) => { const failure = error as { code?: string; constraint_name?: string }; return `${failure.code}:${failure.constraint_name}`; };
  expect(await admin`UPDATE model_capacity_requests SET state='settled',terminal_evidence=${JSON.stringify(forged)}::text::jsonb,
    terminal_evidence_hash=${"e".repeat(64)},settled_at=clock_timestamp() WHERE request_id=${value.requested.requestId}::uuid`
    .then(() => "accepted", code)).toBe("23514:model_capacity_requests_terminal_check");
  const [current] = await admin`SELECT epoch,revision,policy_hash FROM model_capacity_requests WHERE request_id=${value.requested.requestId}::uuid`;
  const event = (fromState: string, evidence: unknown) => admin`INSERT INTO model_capacity_events (request_id,kind,epoch,revision,policy_hash,from_state,to_state,reason,evidence)
    VALUES (${value.requested.requestId}::uuid,'dispatch_settled',${current.epoch},${current.revision},${current.policy_hash},${fromState},'settled',NULL,
    ${JSON.stringify(evidence)}::text::jsonb)`.then(() => "accepted", code);
  const genuine = readGatewayNotStarted(proof);
  expect(await event("indeterminate", genuine)).toBe("23514:model_capacity_events_terminal_check");
  expect(await event("dispatched", { ...genuine, dispatch: { ...value.dispatch, requestId: randomUUID() } })).toBe("23514:model_capacity_events_terminal_check");
  expect(await event("dispatched", { ...genuine, extra: true })).toBe("23514:model_capacity_events_terminal_check");
  expect(await row(value.requested.requestId)).toMatchObject({ state: "dispatched", terminal_evidence: null });
  expect(await tracked(reconcileGatewayNotStarted(proof))).toEqual({ kind: "settled" });
});

it("0149 text route: a product-translate dispatch settles as not_started, frees its member fence, and the CHECKs reject a forged row or event", async () => {
  await install();
  const first = await translate(), proof = witness(first.dispatch);
  const genuine = { version: 1, kind: "gateway_not_started", dispatch: first.dispatch };
  // only the row's own dispatched handle: a different token, a different request, an indeterminate origin or a non-gateway kind is refused
  const forged = { ...genuine, dispatch: { ...first.dispatch, token: randomUUID() } };
  expect(await admin`UPDATE model_capacity_requests SET state='settled',terminal_evidence=${JSON.stringify(forged)}::text::jsonb,
    terminal_evidence_hash=${"e".repeat(64)},settled_at=clock_timestamp() WHERE request_id=${first.requested.requestId}::uuid`
    .then(() => "accepted", constraintFailure)).toBe("23514:model_capacity_requests_terminal_check");
  expect(await settledEvent(first.requested.requestId, "indeterminate", genuine)).toBe("23514:model_capacity_events_terminal_check");
  expect(await settledEvent(first.requested.requestId, "dispatched", { ...genuine, dispatch: { ...first.dispatch, requestId: randomUUID() } }))
    .toBe("23514:model_capacity_events_terminal_check");
  expect(await settledEvent(first.requested.requestId, "dispatched", { ...genuine, dispatch: { ...first.dispatch,
    binding: { ...first.dispatch.binding, kind: "product_audit_cli" } } })).toBe("23514:model_capacity_events_terminal_check");
  expect(await row(first.requested.requestId)).toMatchObject({ state: "dispatched", terminal_evidence: null });
  // the real ledger path: the same evidence settles the row once and is idempotent; a structural copy of the witness is not a witness
  expect(await tracked(reconcileGatewayNotStarted(proof))).toEqual({ kind: "settled" });
  const evidence = expectSettled(await row(first.requested.requestId), first.dispatch);
  expect((await row(first.requested.requestId)).dispatch_binding).toEqual(first.dispatch.binding);
  expect(await events(first.requested.requestId)).toMatchObject([{ kind: "queued" }, { kind: "reserved" }, { kind: "dispatch_started" },
    { kind: "dispatch_settled", from_state: "dispatched", to_state: "settled", reason: null, evidence }]);
  expect(await tracked(reconcileGatewayNotStarted(proof))).toEqual({ kind: "already_settled" });
  await expect(tracked(reconcileGatewayNotStarted(structuredClone(proof)))).rejects.toThrow("invalid_gateway_not_started");
  // the member fence and the single text slot are free: the same members from another boot are granted
  const next = remember({ requestId: randomUUID(), workKey: first.requested.workKey, owner: { instanceId: `${prefix}-next`, bootId: randomUUID() },
    class: "background", pool: "text", routeId: "product-translate", provider: "abcllm", model });
  const nextHandle = granted(await tracked(requestProductTranslationModelSlot(next, first.batch)));
  expect(await tracked(cancelReservedModelSlot(nextHandle))).toBe(true);
  // a row that already recorded transport_unknown is refused as today, whatever its kind
  const unknown = await translate();
  expect(await tracked(markModelDispatchIndeterminate(unknown.dispatch, "transport_unknown"))).toBe(true);
  const before = await row(unknown.requested.requestId);
  await expect(tracked(reconcileGatewayNotStarted(witness(unknown.dispatch)))).rejects.toThrow("gateway_not_started_state_mismatch");
  expect(await row(unknown.requested.requestId)).toEqual(before);
  // a witness for one kind never settles a row of another kind with the same handle shape
  const wrong = witness({ ...first.dispatch, binding: { ...first.dispatch.binding, routeId: "reason-translate", job: { ...first.dispatch.binding.job, name: "reason-translate" } } });
  await expect(tracked(reconcileGatewayNotStarted(wrong))).rejects.toThrow();
  expect(posts).toBe(0);
});

it("0149 local-direct: a local_model_direct dispatch settles as not_started through the same ledger path and frees its logical fence", async () => {
  await install();
  const direct = await local(), proof = witness(direct.dispatch);
  const genuine = { version: 1, kind: "gateway_not_started", dispatch: direct.dispatch };
  const forged = { ...genuine, dispatch: { ...direct.dispatch, token: randomUUID() } };
  expect(await admin`UPDATE model_capacity_requests SET state='settled',terminal_evidence=${JSON.stringify(forged)}::text::jsonb,
    terminal_evidence_hash=${"e".repeat(64)},settled_at=clock_timestamp() WHERE request_id=${direct.requested.requestId}::uuid`
    .then(() => "accepted", constraintFailure)).toBe("23514:model_capacity_requests_terminal_check");
  expect(await settledEvent(direct.requested.requestId, "indeterminate", genuine)).toBe("23514:model_capacity_events_terminal_check");
  expect(await settledEvent(direct.requested.requestId, "dispatched", { ...genuine, extra: true })).toBe("23514:model_capacity_events_terminal_check");
  expect(await row(direct.requested.requestId)).toMatchObject({ state: "dispatched", terminal_evidence: null });
  expect(await tracked(reconcileGatewayNotStarted(proof))).toEqual({ kind: "settled" });
  const evidence = expectSettled(await row(direct.requested.requestId), direct.dispatch);
  expect((await events(direct.requested.requestId)).at(-1)).toMatchObject({ kind: "dispatch_settled", from_state: "dispatched", to_state: "settled",
    reason: null, evidence });
  expect(await tracked(reconcileGatewayNotStarted(proof))).toEqual({ kind: "already_settled" });
  // the logical fence of the same target is free for a new boot
  const next = remember({ requestId: randomUUID(), workKey: `${localModelLogicalKey(direct.target)}:${"f".repeat(64)}`,
    owner: { instanceId: `${prefix}-next`, bootId: randomUUID() }, class: "background", pool: "reviewer", routeId: localModelRoute(direct.target),
    provider: "local-direct", model: localModel });
  expect((await tracked(requestLocalModelSlot(next, direct.target))).kind).toBe("granted");
  expect(posts).toBe(0);
});

it("a failed settlement is marked commit_unknown on a dispatched row and never rewrites a settled one", async () => {
  await install(); contracts();
  const open = await ai1();
  await markUnsettledDispatch(open.dispatch as Ai1ModelDispatch);
  expect(await row(open.requested.requestId)).toMatchObject({ state: "indeterminate", terminal_evidence: null });
  expect((await events(open.requested.requestId)).at(-1)).toMatchObject({ kind: "dispatch_indeterminate", reason: "commit_unknown" });
  const done = await ai1();
  expect(await tracked(abandonAgentReviewModelCapacity(done.dispatch, done.call))).toBe(true);
  const before = await row(done.requested.requestId), history = await events(done.requested.requestId);
  await markUnsettledDispatch(done.dispatch as Ai1ModelDispatch);
  expect(await row(done.requested.requestId)).toEqual(before); expect(await events(done.requested.requestId)).toEqual(history);
});
