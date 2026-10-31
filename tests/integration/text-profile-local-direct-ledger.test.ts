import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { profileHash, type ProfileEvidence } from "@/lib/domain/products/search-profile";
import { prepareTextProfileGatewayCall, readGatewayNotStarted, readTextProfileGatewayTerminal, writeKeywordsWithReservedGateway,
  type PreparedTextProfileGatewayCall } from "@/lib/crawl/agent-review-gateway";
import type { TextProfileServingContract } from "@/lib/llm/text-profile-serving-contract";
import { DIRECT_OPENAI_CHAT_PROTOCOL, DIRECT_REQUEST_TOKEN_BOUND } from "@/lib/llm/direct-serving-contract";
import { modelCapacityPolicyHash, textProfileDispatchBindingSchema, textProfileInputHash, type ModelCapacityPolicy, type ModelCapacityRequest,
  type ModelCapacityReservation, type ModelSlotResult } from "@/lib/llm/capacity";
import { findOwnPendingTextProfileRequests, finishTextProfileModelCapacityDispatch, lockTextProfileModelCapacityDispatch, reconcileGatewayNotStarted,
  reconcileTextProfileGatewayTerminal, requestTextProfileModelSlot } from "@/lib/llm/capacity-repository";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

/**
 * PR 3b-E: text 경로(product-search-profile) 한 건의 local-direct 장부 왕복 — 예약 → 고정 identity dispatch(binding provider local-direct) →
 * 엔진 tokenizer 확인 → 엔진 완결 응답 = terminal 증거 → settled. DB CHECK 는 0157 이 붙인 text 7경로의 local-direct 분기 그대로다(새 마이그레이션 없음).
 * 요청 상한을 넘는 입력은 보내지 않고 gateway_not_started(0149, provider 무관)로 정산된다. 운영 값이 아니다(loopback fixture).
 */
const serving = vi.hoisted(() => ({ contract: null as TextProfileServingContract | null }));
vi.mock("@/lib/llm/text-profile-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/text-profile-serving-contract")>(),
  resolveTextProfileServingContract: (_model: string, provider = "abcllm") => serving.contract?.provider === provider ? serving.contract : null,
}));
type Raw = Record<string, unknown>;
const prefix = `text-local-direct-${randomUUID()}`, owner = { instanceId: prefix, bootId: randomUUID() };
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: "text-local-direct-fixture" } });
const owned = new Map<string, ModelCapacityRequest>(), work = new Set<Promise<unknown>>(), bodies = new Set<Promise<unknown>>(), hooks = new Set<Promise<unknown>>();
let initial: Record<string, unknown>, originalControl: Raw, setupWork: Promise<void> | undefined, cleaning: Promise<void> | undefined, initialized = false, serial = 7000;
const model = "fixture/engine-7b", backendId = "engine-local-7b", device = "engine-local";
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 2, providerLimits: { [backendId]: 2 }, groupLimits: { [device]: 2 },
  poolLimits: { reviewer: 2, text: 2 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "product-search-profile", provider: "local-direct", model, providerBudgetId: backendId, groupId: device }] };
function tracked<T>(pending: Promise<T>, set = work): Promise<T> { set.add(pending); void pending.catch(() => {}); return pending; }
const exercise = (load: () => Promise<void>) => () => tracked(Promise.resolve().then(load), bodies);
async function settle(set: Set<Promise<unknown>>, keepErrors = false) {
  const pending = [...set], results = await Promise.allSettled(pending);
  for (const promise of pending) set.delete(promise);
  const errors = results.flatMap(value => value.status === "rejected" ? [value.reason] : []);
  if (keepErrors && errors.length) throw new AggregateError(errors, "local_direct_fixture_work_failed");
}
async function steps(loads: readonly (() => Promise<unknown>)[]) {
  const errors: unknown[] = [];
  for (const load of loads) try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "local_direct_fixture_cleanup_failed", { cause: errors[0] });
}
async function whole(tx: postgres.Sql | postgres.TransactionSql = admin) {
  const result: Record<string, unknown> = {};
  for (const { tablename } of await tx`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
    const [row] = await tx.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value
      FROM public."${String(tablename).replaceAll('"', '""')}" t`);
    result[tablename] = row.value;
  }
  return result;
}
async function restoreControl(tx: postgres.TransactionSql) {
  await tx`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,
    policy_hash=r.policy_hash,cursor=r.cursor,updated_at=r.updated_at
    FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalControl)}::text::jsonb) r WHERE c.id=r.id`;
}
async function performCleanup() {
  if (!initialized) return;
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const ids = [...owned.keys()];
    for (const row of await tx`SELECT * FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[]) ORDER BY queue_ordinal FOR UPDATE`) {
      const expected = owned.get(row.request_id)!;
      expect([row.owner_instance_id, row.owner_boot_id, row.class, row.pool, row.route_id, row.provider, row.model])
        .toEqual([expected.owner.instanceId, expected.owner.bootId, expected.class, expected.pool, expected.routeId, expected.provider, expected.model]);
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
    await restoreControl(tx); expect(await whole(tx)).toEqual(initial);
  });
  owned.clear();
}
function cleanup() {
  if (cleaning) return cleaning;
  const pending = performCleanup(); cleaning = pending;
  const clear = () => { if (cleaning === pending) cleaning = undefined; };
  void pending.then(clear, clear); return pending;
}
async function install(value = policy) {
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(value)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(value)},cursor=0,updated_at=clock_timestamp() WHERE id=1`;
}
function evidence(): ProfileEvidence {
  return { url: "https://ledger.example", name: "Ledger Demo", category: "finance", topics: "budget",
    tagline: "Track expenses <untrusted>", pageText: "", readme: "", evidenceLevel: "thin" };
}
function input(productId: number, value: ProfileEvidence) {
  return { productId, slug: `local-direct-${productId}`, evidenceHash: profileHash(value), profile: { kind: "absent" as const }, model };
}
async function request(productId: number, value: ProfileEvidence): Promise<ModelCapacityRequest> {
  const fixed = input(productId, value);
  const checked = { requestId: randomUUID(), workKey: `text:profile:${productId}:${textProfileInputHash(fixed)}`, owner: { ...owner },
    class: "background", pool: "text", routeId: "product-search-profile", provider: "local-direct", model } as ModelCapacityRequest;
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE request_id=${checked.requestId}::uuid`).toEqual([]);
  owned.set(checked.requestId, structuredClone(checked)); return checked;
}
function granted(result: ModelSlotResult): ModelCapacityReservation {
  expect(result.kind).toBe("granted"); if (result.kind !== "granted") throw new Error("actual_reservation_required");
  return result.reservation;
}
function identity(value: ModelCapacityRequest) { const result = { ...value }; Reflect.deleteProperty(result, "requestId"); return result; }
function binding(productId: number, value: ProfileEvidence, call: PreparedTextProfileGatewayCall) {
  const fixed = input(productId, value);
  return textProfileDispatchBindingSchema.parse({ ...fixed, kind: "text_profile_gateway", version: 1, logicalWorkKey: `text:profile:${productId}`,
    inputHash: textProfileInputHash(fixed), provider: call.provider, routeId: "product-search-profile", wireHash: call.wireHash,
    servingContractHash: call.servingContractHash, totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound,
    job: { name: "product-search-profile", token: randomUUID(), requestedVersion: 1 },
    role: { role: "text", instanceId: owner.instanceId, bootId: owner.bootId, release: "local-direct-fixture", kind: "primary", epoch: 1, batch: { mode: "legacy" } } });
}
async function dispatch(value: ModelCapacityRequest, productId: number, evidenceValue: ProfileEvidence, call: PreparedTextProfileGatewayCall) {
  const handle = granted(await tracked(requestTextProfileModelSlot(value, productId)));
  return tracked(db.transaction(async tx => {
    const lock = await lockTextProfileModelCapacityDispatch(tx, { reservation: handle, identity: identity(value), productId });
    if (!lock) throw new Error("actual_lock_required");
    return finishTextProfileModelCapacityDispatch(tx, lock, binding(productId, evidenceValue, call));
  }));
}
async function row(id: string) { return (await admin`SELECT to_jsonb(r) AS value FROM model_capacity_requests r WHERE request_id=${id}::uuid`)[0]?.value as Raw; }
/** Loopback engine: /tokenize answers like vLLM (count, max_model_len, tokens); /v1/chat/completions answers an engine completion with usage. */
async function engine(run: (state: { paths: string[]; tokens: (count: number) => void }) => Promise<void>) {
  const paths: string[] = [], pending = new Set<Promise<void>>();
  let count = 90;
  const server = createServer((request, response: ServerResponse) => {
    const body = (async () => { for await (const chunk of request) { void chunk; }
      paths.push(request.url ?? "");
      if (request.url === "/tokenize") response.end(JSON.stringify({ count, max_model_len: 50_000, tokens: Array.from({ length: count }, (_, index) => index + 1) }));
      else response.end(JSON.stringify({ id: "engine-ledger-response", object: "chat.completion", created: 1, model: "local-llm",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"keywords_en":["budget app"],"keywords_ko":["가계부"]}' } }],
        usage: { prompt_tokens: 90, completion_tokens: 20, total_tokens: 110 } })); })();
    pending.add(body); void body.catch(() => {});
  });
  let primary: unknown;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("local_address");
    serving.contract = { version: 1, protocol: DIRECT_OPENAI_CHAT_PROTOCOL, routeId: "product-search-profile", provider: "local-direct", model,
      responseModel: "local-llm", deploymentRevision: "local-direct-ledger-fixture", endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
      tokenizerEndpoint: `http://127.0.0.1:${address.port}/tokenize`, backendId, physicalGroup: device, totalTokenBound: 50_000,
      requestTokenBound: DIRECT_REQUEST_TOKEN_BOUND, maxOutputTokens: 1024 };
    await run({ paths, tokens: next => { count = next; } });
  } catch (error) { primary = error; throw error; }
  finally {
    const errors: unknown[] = [];
    serving.contract = null; server.closeAllConnections();
    try { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } catch (error) { errors.push(error); }
    for (const result of await Promise.allSettled([...pending])) if (result.status === "rejected") errors.push(result.reason);
    if (errors.length) throw new AggregateError(primary === undefined ? errors : [primary, ...errors]);
  }
}

beforeAll(() => {
  setupWork = (async () => {
    ensureSchema(); initial = await whole();
    if (!Array.isArray(initial.model_capacity_requests) || initial.model_capacity_requests.length)
      throw new Error("local_direct_fixture_requires_empty_requests");
    [originalControl] = initial.model_capacity_control as Raw[]; initialized = true;
  })(); return tracked(setupWork, hooks);
});
afterEach(() => tracked(steps([async () => { await setupWork; }, () => settle(bodies), () => settle(work), cleanup,
  async () => { serving.contract = null; vi.unstubAllEnvs(); }]), hooks));
afterAll(() => steps([async () => { await setupWork; }, () => settle(hooks, true), () => settle(bodies, true), () => settle(work), cleanup,
  async () => { if (initialized) expect(await whole()).toEqual(initial); },
  async () => { await (globalThis as { pgClient?: postgres.Sql }).pgClient?.end(); }, async () => { await admin.end(); }]));

it("records a local-direct text dispatch, settles the engine's own terminal and keeps the abcllm readback separate", exercise(async () => {
  await install(); vi.stubEnv("ABCLLM_API_KEY", "");
  await engine(async ({ paths }) => {
    const value = evidence(), productId = ++serial;
    const call = prepareTextProfileGatewayCall(value, { model, timeoutMs: 5_000, provider: "local-direct" });
    if (call.kind !== "prepared") throw new Error("prepared_required");
    expect(call.provider).toBe("local-direct");
    const checked = await request(productId, value);
    const handle = granted(await tracked(requestTextProfileModelSlot(checked, productId)));
    expect(await row(checked.requestId)).toMatchObject({ state: "reserved", provider: "local-direct", provider_budget_id: backendId, group_id: device,
      logical_work_key: `text:profile:${productId}` });
    // The own-queue readback is provider-bound: the local-direct identity sees the row, the abcllm default does not.
    expect(await tracked(findOwnPendingTextProfileRequests({ owner, model, provider: "local-direct" }))).toEqual([{ productId, workKey: checked.workKey }]);
    expect(await tracked(findOwnPendingTextProfileRequests({ owner, model }))).toEqual([]);
    const sent = await tracked(db.transaction(async tx => {
      const lock = await lockTextProfileModelCapacityDispatch(tx, { reservation: handle, identity: identity(checked), productId });
      if (!lock) throw new Error("actual_lock_required");
      return finishTextProfileModelCapacityDispatch(tx, lock, binding(productId, value, call));
    }));
    // 0157: the text_profile_gateway CHECK accepts provider local-direct with the unchanged binding shape.
    expect(await row(checked.requestId)).toMatchObject({ state: "dispatched", dispatch_binding: { provider: "local-direct", kind: "text_profile_gateway",
      routeId: "product-search-profile", totalTokenBound: 50_000, chargedTokens: 50_000 }, dispatch_binding_hash: sent.bindingHash });
    const native = await tracked(writeKeywordsWithReservedGateway(value, sent, call));
    expect(native.result).toEqual({ ok: true, en: ["budget app"], ko: ["가계부"] });
    expect(paths).toEqual(["/tokenize", "/v1/chat/completions"]);
    const proof = readTextProfileGatewayTerminal(native.terminal);
    expect(proof).toMatchObject({ provenance: "upstream_reported", actualUsage: { inputTokens: 90, outputTokens: 20, totalTokens: 110 },
      dispatch: { binding: { provider: "local-direct" } } });
    expect(await tracked(reconcileTextProfileGatewayTerminal(native.terminal!))).toEqual({ kind: "settled" });
    expect(await tracked(reconcileTextProfileGatewayTerminal(native.terminal!))).toEqual({ kind: "already_settled" });
    // 0157: the terminal evidence CHECK accepts the local-direct dispatch inside text_profile_gateway_terminal.
    expect(await row(checked.requestId)).toMatchObject({ state: "settled", token: sent.token, terminal_evidence: { kind: "text_profile_gateway_terminal",
      provenance: "upstream_reported", actualUsage: { totalTokens: 110 }, dispatch: { requestId: checked.requestId, binding: { provider: "local-direct" } } } });
    expect(await admin`SELECT kind FROM model_capacity_events WHERE request_id=${checked.requestId}::uuid ORDER BY id`)
      .toEqual([{ kind: "queued" }, { kind: "reserved" }, { kind: "dispatch_started" }, { kind: "dispatch_settled" }]);
  });
}));

it("never sends a request the engine tokenizer counts past the bound and settles the local-direct dispatch as not started", exercise(async () => {
  await install(); vi.stubEnv("ABCLLM_API_KEY", "");
  await engine(async ({ paths, tokens }) => {
    tokens(DIRECT_REQUEST_TOKEN_BOUND);
    const value = evidence(), productId = ++serial;
    const call = prepareTextProfileGatewayCall(value, { model, timeoutMs: 5_000, provider: "local-direct" });
    if (call.kind !== "prepared") throw new Error("prepared_required");
    const checked = await request(productId, value), sent = await dispatch(checked, productId, value, call);
    const native = await tracked(writeKeywordsWithReservedGateway(value, sent, call));
    expect(native.result).toEqual({ ok: false, error: "input_too_large" });
    expect(native.terminal).toBeNull();
    expect(paths).toEqual(["/tokenize"]);
    expect(readGatewayNotStarted(native.notStarted)).toMatchObject({ kind: "gateway_not_started", dispatch: { requestId: checked.requestId } });
    expect(await tracked(reconcileGatewayNotStarted(native.notStarted!))).toEqual({ kind: "settled" });
    // 0149 gateway_not_started is provider-agnostic: the local-direct text dispatch settles with its full charge and no usage.
    expect(await row(checked.requestId)).toMatchObject({ state: "settled", terminal_evidence: { kind: "gateway_not_started",
      dispatch: { requestId: checked.requestId, binding: { provider: "local-direct", chargedTokens: 50_000 } } } });
    expect(await admin`SELECT kind FROM model_capacity_events WHERE request_id=${checked.requestId}::uuid ORDER BY id`)
      .toEqual([{ kind: "queued" }, { kind: "reserved" }, { kind: "dispatch_started" }, { kind: "dispatch_settled" }]);
  });
}));

it("an abcllm identity is still refused the local-direct route and a local-direct binding cannot ride an abcllm row", exercise(async () => {
  await install();
  const value = evidence(), productId = ++serial;
  // No abcllm route is mapped for this model: the slot request is deferred as unmapped, no row is written.
  const foreign = { ...await request(productId, value), provider: "abcllm" } as ModelCapacityRequest;
  owned.set(foreign.requestId, structuredClone(foreign));
  expect(await tracked(requestTextProfileModelSlot(foreign, productId))).toMatchObject({ kind: "deferred" });
  expect(await row(foreign.requestId)).toBeUndefined();
  // A provider outside the gateway pair is not a text identity at all.
  await expect(tracked(requestTextProfileModelSlot({ ...foreign, provider: "claude-cli" } as ModelCapacityRequest, productId)))
    .rejects.toThrow("invalid_text_profile_capacity_identity");
}));
