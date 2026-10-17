import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { TRANSLATE_MODEL, QUERY_PROMPT_VERSION, GLOSSARY_VERSION, glossaryHints } from "@/lib/crawl/translate";
import { modelCapacityPolicyHash, modelCapacityRequestIdentitySchema, websearchQueryInputHash, websearchQueryLogicalWorkKey,
  type ModelCapacityPolicy, type WebsearchQueryInput } from "@/lib/llm/capacity";
import type { WebsearchQueryServingContract } from "@/lib/llm/websearch-query-serving-contract";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// 실제 PostgreSQL + loopback 게이트웨이. 실제 provider·운영 resolver 는 쓰지 않는다 — 계약은 이 파일의 fixture 만 연다.
const fixture = vi.hoisted(() => ({ contract: null as WebsearchQueryServingContract | null,
  owner: null as null | { instanceId: string; bootId: string; release: string } }));
vi.mock("@/lib/llm/websearch-query-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/websearch-query-serving-contract")>(), resolveWebsearchQueryServingContract: () => fixture.contract,
}));
vi.mock("@/lib/llm/websearch-process-owner", () => ({ websearchProcessOwner: () => fixture.owner }));

const prefix = `wsq-${randomUUID().slice(0, 8)}`, busyRoute = `${prefix}-busy`, modelB = `${prefix}-model-b`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: prefix } });
const ownerA = { instanceId: `${prefix}-a`, bootId: randomUUID(), release: "ledger-fixture" };
const ownerB = { instanceId: `${prefix}-b`, bootId: randomUUID(), release: "ledger-fixture" };
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { account: 4 }, groupLimits: { engine: 4 },
  poolLimits: { reviewer: 4, text: 4 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [...[TRANSLATE_MODEL, modelB].map(model => ({ routeId: "search-query-translate", provider: "abcllm", model, providerBudgetId: "account", groupId: "engine" })),
    { routeId: busyRoute, provider: "fixture", model: modelB, providerBudgetId: "account", groupId: "engine" }] };
const cacheKeys = new Set<string>();
let http: Server, originalControl: Record<string, unknown>;
const bodies: string[] = [];
let reply: (response: ServerResponse) => void = response => response.end(JSON.stringify(envelope("merge pdf | merge pdf files")));
function envelope(content: string) {
  return { id: "wsq-local", object: "chat.completion", created: 1, model: "served-query",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 60, completion_tokens: 9, total_tokens: 69 }, usage_provenance: "upstream_reported" };
}
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

const { onReplica } = await import("@/lib/db");
const searchTranslation = await import("@/lib/domain/products/search-translation");
const { translateQueryWithModelCapacity } = await import("@/lib/domain/products/search-query-model-capacity");
const { prepareWebsearchQueryDispatch, recordWebsearchQueryResult } = await import("@/lib/domain/products/search-query-capacity-repository");
const ledger = await import("@/lib/llm/capacity-repository");
const gateway = await import("@/lib/crawl/agent-review-gateway");
const globalForDb = globalThis as unknown as { readDb?: unknown };
const flights = () => (globalThis as { noMoreVibeWebsearchQueryFlights?: Map<string, unknown> }).noMoreVibeWebsearchQueryFlights!;

function target(query: string) {
  const cacheKey = searchTranslation.queryTranslationKey(query); cacheKeys.add(cacheKey);
  return { query, sourceLocale: "ko" as const, cacheKey, promptVersion: QUERY_PROMPT_VERSION,
    glossaryVersion: glossaryHints(searchTranslation.normalizeQuery(query)) ? GLOSSARY_VERSION : null };
}
async function rows(cacheKey: string) {
  return Array.from(await admin`SELECT to_jsonb(r) AS row FROM model_capacity_requests r
    WHERE logical_member_keys && ARRAY[${`websearch-query:${cacheKey}`}]::text[] ORDER BY queue_ordinal`).map(row => row.row);
}
async function events(requestId: string) {
  return Array.from(await admin`SELECT kind,reason FROM model_capacity_events WHERE request_id=${requestId}::uuid ORDER BY id`);
}
async function cache(cacheKey: string) {
  return (await admin`SELECT to_jsonb(t) AS row, retry_at > now() AS later FROM text_translations t WHERE source_hash=${cacheKey} AND target_lang='en'`)[0];
}
function identity(input: WebsearchQueryInput, owner = fixture.owner!) {
  return modelCapacityRequestIdentitySchema.parse({ owner: { instanceId: owner.instanceId, bootId: owner.bootId }, class: "background", pool: "text",
    routeId: "search-query-translate", provider: "abcllm", model: input.model, workKey: `${websearchQueryLogicalWorkKey(input.member)}:${websearchQueryInputHash(input)}` });
}
/** The coordinator's own steps up to a committed dispatch, used where a crash or race needs to be placed exactly. */
async function dispatched(query: string) {
  const goal = target(query), owner = fixture.owner!;
  const call = gateway.prepareWebsearchQueryGatewayCall({ sourceLocale: "ko", query }, { model: TRANSLATE_MODEL, timeoutMs: 2_000 });
  if (call.kind !== "prepared") throw new Error("fixture_contract_required");
  const initial = await prepareWebsearchQueryDispatch(goal, { owner, call });
  if (initial.kind !== "ready" || !("input" in initial)) throw new Error(`fixture_initial_${initial.kind}`);
  const id = identity(initial.input), slot = await ledger.requestWebsearchQueryModelSlot({ ...id, requestId: randomUUID() }, initial.input);
  if (slot.kind !== "granted") throw new Error(`fixture_slot_${slot.reason}`);
  return { goal, call, input: initial.input, identity: id, reservation: slot.reservation,
    reserve: () => prepareWebsearchQueryDispatch(goal, { owner, call, reserved: { reservation: slot.reservation, identity: id, input: initial.input } }) };
}
function expectationOf(value: Awaited<ReturnType<typeof prepareWebsearchQueryDispatch>>) {
  if (value.kind !== "ready" || !("expectation" in value)) throw new Error("fixture_expectation_required"); return value.expectation;
}
async function settledWithoutCache(query: string) {
  const state = await dispatched(query), prepared = await state.reserve();
  if (prepared.kind !== "ready" || !("dispatch" in prepared)) throw new Error("fixture_dispatch_required");
  const native = await gateway.translateQueryWithReservedGateway({ sourceLocale: "ko", query }, prepared.dispatch, state.call, { timeoutMs: 2_000 });
  expect(native.terminal).not.toBeNull(); await ledger.reconcileWebsearchQueryGatewayTerminal(native.terminal!);
  return { ...state, prepared, native };
}

beforeAll(async () => {
  ensureSchema();
  const journal = JSON.parse(readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  expect(journal.entries.map((entry: { tag: string }) => entry.tag)).toContain("0093_model_capacity_websearch_query_terminal");
  const [applied] = await admin`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  expect(applied.count).toBe(journal.entries.length);
  const indexes = await admin`SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='model_capacity_requests_websearch_query_snapshot_idx'`;
  expect(indexes).toHaveLength(1);
  expect(await admin`SELECT 1 FROM model_capacity_requests`).toHaveLength(0); expect(await admin`SELECT 1 FROM model_capacity_events`).toHaveLength(0);
  [{ row: originalControl }] = await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`;
  expect(originalControl).toMatchObject({ mode: "disabled", policy: null });
  http = createServer((request, response) => { let body = ""; request.on("data", part => { body += part; }); request.on("end", () => { bodies.push(body); reply(response); }); });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address(); if (!address || typeof address === "string") throw new Error("fixture_address");
  fixture.contract = { version: 1, protocol: "abcllm-websearch-query-total-bound-v1", routeId: "search-query-translate", provider: "abcllm", model: TRANSLATE_MODEL,
    responseModel: "served-query", endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, deploymentRevision: "local-only", totalTokenBound: 4096 };
  fixture.owner = ownerA; vi.stubEnv("ABCLLM_API_KEY", "local-test-only");
  process.env.READ_DATABASE_URL = `${TEST_DATABASE_URL}?default_transaction_read_only=on`; globalForDb.readDb = undefined;
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(policy)},
    cursor=0,updated_at=clock_timestamp() WHERE id=1`;
  console.info("websearch_query_ledger_migrations", { journal: journal.entries.length, applied: applied.count, indexes });
});
afterAll(async () => {
  try {
    await admin.begin(async tx => {
      await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
      const ids = (await tx`SELECT request_id FROM model_capacity_requests WHERE route_id IN ('search-query-translate',${busyRoute}) FOR UPDATE`).map(row => row.request_id);
      await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
      await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
      await tx`DELETE FROM model_capacity_events WHERE request_id=ANY(${ids}::uuid[])`;
      await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
      expect(Array.from(await tx`SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass
        AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate') ORDER BY tgname`))
        .toEqual([{ tgname: "model_capacity_events_no_change", tgenabled: "A" }, { tgname: "model_capacity_events_no_truncate", tgenabled: "A" }]);
      await tx`DELETE FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[])`;
      await tx`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,policy_hash=r.policy_hash,cursor=r.cursor,
        updated_at=r.updated_at FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalControl)}::text::jsonb) r WHERE c.id=r.id`;
      await tx`DELETE FROM text_translations WHERE target_lang='en' AND source_hash=ANY(${[...cacheKeys]})`;
      expect(await tx`SELECT 1 FROM model_capacity_requests`).toHaveLength(0); expect(await tx`SELECT 1 FROM model_capacity_events`).toHaveLength(0);
    });
  } finally {
    delete process.env.READ_DATABASE_URL; globalForDb.readDb = undefined; fixture.contract = null; vi.unstubAllEnvs();
    await new Promise<void>(resolve => http.close(() => resolve())); await admin.end();
  }
});

it("settles one native POST and writes the cache on primary even inside a read-only replica scope", async () => {
  const query = "회의록 요약 도구 복제본", key = target(query).cacheKey, before = bodies.length;
  const resolved = await onReplica(() => searchTranslation.resolveSearchQuery(query, { waitForTranslation: true }));
  expect(resolved.translated).toBe("merge pdf / merge pdf files"); expect(bodies.length - before).toBe(1);
  const [row] = await rows(key);
  expect(row).toMatchObject({ state: "settled", route_id: "search-query-translate", logical_work_key: `text:websearch-query:${key}`,
    owner_instance_id: ownerA.instanceId, owner_boot_id: ownerA.bootId, terminal_evidence: { outcome: { ok: true, keywords: "merge pdf | merge pdf files" } } });
  expect(JSON.stringify(row)).not.toContain(query);
  expect((await events(row.request_id as string)).map(event => event.kind)).toEqual(["queued", "reserved", "dispatch_started", "dispatch_settled"]);
  expect((await cache(key)).row).toMatchObject({ status: "done", translated: "merge pdf | merge pdf files", attempts: 1, model: TRANSLATE_MODEL, error_code: null });
  expect((await onReplica(() => searchTranslation.resolveSearchQuery(query, { waitForTranslation: true }))).translated).toBe("merge pdf / merge pdf files");
  expect(bodies.length - before).toBe(1); expect(await rows(key)).toHaveLength(1);
});

it("rechecks the primary cache missed by a lagging replica and does not POST", async () => {
  const goal = target("영수증 정리 앱 지연"), before = bodies.length;
  await admin`INSERT INTO text_translations (source_hash,target_lang,status,translated,model,attempts) VALUES (${goal.cacheKey},'en','done','receipt organizer','m',1)`;
  expect(await translateQueryWithModelCapacity(goal, 8_000)).toEqual({ kind: "cached", text: "receipt organizer" });
  expect(bodies.length).toBe(before); expect(await rows(goal.cacheKey)).toEqual([]);
});

it("joins wait, zero-result fallback and warmup into one POST; another process is fenced without a TX held during HTTP", async () => {
  const query = "강아지 산책 기록", key = target(query).cacheKey, gate = latch(), arrived = latch(), before = bodies.length;
  reply = response => { arrived.resolve(); void gate.promise.then(() => response.end(JSON.stringify(envelope("dog walk log | dog walking log")))); };
  const runs = [searchTranslation.resolveSearchQuery(query, { waitForTranslation: true }),
    onReplica(() => searchTranslation.resolveSearchQuery(query, { waitForTranslation: true })), searchTranslation.warmQueryTranslation(query)];
  try {
    await arrived.promise;
    expect(await admin`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
      AND state LIKE 'idle in transaction%'`).toHaveLength(0);
    // 다른 프로세스: 자기 singleflight 표가 따로이고 주인도 다르다
    const hidden = flights().get(key); flights().delete(key); fixture.owner = ownerB;
    try {
      expect(await searchTranslation.resolveSearchQuery(query.replace(" ", "  "), { waitForTranslation: true })).toMatchObject({ translated: null, translationPending: true });
      const input: WebsearchQueryInput = { model: modelB, member: { cacheKey: key, sourceLocale: "ko", queryHash: "f".repeat(64), promptVersion: QUERY_PROMPT_VERSION,
        glossaryVersion: null, cache: { kind: "absent" } } };
      expect(await ledger.requestWebsearchQueryModelSlot({ ...identity(input, ownerB), requestId: randomUUID() }, input)).toEqual({ kind: "deferred", reason: "capacity" });
    } finally { fixture.owner = ownerA; flights().set(key, hidden); }
  } finally { gate.resolve(); }
  const [wait, fallback] = await Promise.all(runs) as [{ translated: string | null }, { translated: string | null }, void];
  expect(wait.translated).toBe("dog walk log / dog walking log"); expect(fallback.translated).toBe("dog walk log / dog walking log");
  expect(bodies.length - before).toBe(1); expect(await rows(key)).toHaveLength(1);
  reply = response => response.end(JSON.stringify(envelope("merge pdf | merge pdf files")));
});

it("reuses a settled outcome after a crash between settlement and cache write instead of a second POST", async () => {
  const query = "가족 일정 공유", key = target(query).cacheKey;
  await settledWithoutCache(query); const before = bodies.length;
  expect(await cache(key)).toBeUndefined();
  const input = (await rows(key))[0].dispatch_binding as unknown as WebsearchQueryInput;
  const snapshot = { model: input.model, member: input.member };
  fixture.owner = ownerB;
  try {
    expect(await ledger.requestWebsearchQueryModelSlot({ ...identity(snapshot, ownerB), requestId: randomUUID() }, snapshot)).toEqual({ kind: "deferred", reason: "capacity" });
    expect((await searchTranslation.resolveSearchQuery(query, { waitForTranslation: true })).translated).toBe("merge pdf / merge pdf files");
  } finally { fixture.owner = ownerA; }
  expect(bodies.length).toBe(before); expect(await rows(key)).toHaveLength(1);
  expect((await cache(key)).row).toMatchObject({ status: "done", translated: "merge pdf | merge pdf files", attempts: 1 });
});

it("never lets a stale writer overwrite a winner or a 1µs-changed failure row", async () => {
  const winner = await settledWithoutCache("중고 거래 알림");
  await admin`INSERT INTO text_translations (source_hash,target_lang,status,translated,model,attempts) VALUES (${winner.goal.cacheKey},'en','done','used market alerts','w',1)`;
  expect(await recordWebsearchQueryResult(expectationOf(winner.prepared), winner.native.result)).toEqual({ kind: "lost", cached: "used market alerts" });
  expect((await cache(winner.goal.cacheKey)).row).toMatchObject({ translated: "used market alerts", model: "w", attempts: 1 });

  const goal = target("반려식물 물주기");
  await admin`INSERT INTO text_translations (source_hash,target_lang,status,model,attempts,error_code,retry_at) VALUES (${goal.cacheKey},'en','failed','m',1,'network',now())`;
  const stale = await settledWithoutCache("반려식물 물주기");
  await admin`UPDATE text_translations SET updated_at=updated_at+interval '1 microsecond' WHERE source_hash=${goal.cacheKey} AND target_lang='en'`;
  const bumped = (await cache(goal.cacheKey)).row;
  expect(await recordWebsearchQueryResult(expectationOf(stale.prepared), stale.native.result)).toEqual({ kind: "lost", cached: null });
  expect((await cache(goal.cacheKey)).row).toEqual(bumped);
});

it("keeps an ordinary failure at full C with the original single-attempt failed cache and fences the next search", async () => {
  const query = "수면 패턴 분석", key = target(query).cacheKey, before = bodies.length;
  reply = response => { response.statusCode = 500; response.end("failure"); };
  try {
    const first = await searchTranslation.resolveSearchQuery(query, { waitForTranslation: true });
    expect(first.translated).toBeNull(); expect(first.translationPending).toBeUndefined();
  } finally { reply = response => response.end(JSON.stringify(envelope("merge pdf | merge pdf files"))); }
  const [row] = await rows(key);
  expect(row).toMatchObject({ state: "indeterminate", terminal_evidence: null });
  expect(await events(row.request_id as string)).toContainEqual({ kind: "dispatch_indeterminate", reason: "transport_unknown" });
  const failed = await cache(key);
  expect(failed.row).toMatchObject({ status: "failed", attempts: 1, error_code: "http_500" }); expect(failed.later).toBe(true);
  expect(await searchTranslation.resolveSearchQuery(query, { waitForTranslation: true })).toMatchObject({ translated: null, translationPending: true });
  expect(bodies.length - before).toBe(1); expect((await cache(key)).row).toEqual(failed.row);
});

it("never POSTs after reservation expiry or a changed cache snapshot; only reserved rows are cancelled", async () => {
  const before = bodies.length, expired = await dispatched("홈트 루틴 기록");
  await admin`UPDATE model_capacity_requests SET reserved_until=clock_timestamp()-interval '1 second' WHERE request_id=${expired.reservation.requestId}::uuid`;
  await expect(expired.reserve()).rejects.toMatchObject({ name: "ModelCapacityDeferredError", reason: "reservation_lost" });
  expect(await ledger.cancelReservedModelSlot(expired.reservation)).toBe(false);
  const changed = await dispatched("카페 메뉴 번역");
  await admin`INSERT INTO text_translations (source_hash,target_lang,status,model,attempts,error_code,retry_at) VALUES (${changed.goal.cacheKey},'en','failed','m',1,'network',now())`;
  expect(await changed.reserve()).toEqual({ kind: "skipped" });
  expect(await ledger.cancelReservedModelSlot(changed.reservation)).toBe(true);
  for (const state of [expired, changed]) {
    const [row] = await rows(state.goal.cacheKey); expect(row).toMatchObject({ state: "withdrawn", dispatch_binding: null });
  }
  expect(bodies.length).toBe(before);
});

it("enforces the 0093 branch: exact snapshot duplicates conflict, decimal counters and foreign shapes are rejected, old kinds still accepted", async () => {
  const key = target("회의록 요약 도구 복제본").cacheKey, [settled] = await rows(key);
  const copy = { ...settled, request_id: randomUUID(), state: "indeterminate", terminal_evidence: null, terminal_evidence_hash: null, settled_at: null };
  const insert = (value: Record<string, unknown>, text = JSON.stringify(value)) => admin.begin(async tx => {
    await tx`INSERT INTO model_capacity_requests SELECT (r).* FROM jsonb_populate_record(NULL::model_capacity_requests,
      ${text}::text::jsonb || jsonb_build_object('queue_ordinal',nextval('model_capacity_requests_queue_ordinal_seq'))) r`;
    throw new Error("intentional_rollback");
  });
  const code = async (load: Promise<unknown>) => { try { await load; return "inserted"; } catch (error) {
    const pg = error as { code?: string; constraint_name?: string; message?: string };
    return pg.message === "intentional_rollback" ? "inserted" : `${pg.code}:${pg.constraint_name}`; } };
  expect(await code(insert(copy))).toBe("23505:model_capacity_requests_websearch_query_snapshot_idx");
  const present = { ...copy, dispatch_binding: { ...(copy.dispatch_binding as Record<string, unknown>),
    member: { ...((copy.dispatch_binding as { member: Record<string, unknown> }).member), cache: { kind: "present", rowIdentityHash: "a".repeat(64), attempts: 1 } } } };
  expect(await code(insert(present, JSON.stringify(present).replace('"attempts":1}', '"attempts":1.0}')))).toBe("23514:model_capacity_requests_dispatch_check");
  for (const binding of [{ ...(copy.dispatch_binding as object), process: undefined, role: { role: "text" } },
    { ...(copy.dispatch_binding as object), routeId: "crawl-tagline" }, { ...(copy.dispatch_binding as object), chargedTokens: 1 }])
    expect(await code(insert({ ...copy, dispatch_binding: binding }))).toBe("23514:model_capacity_requests_dispatch_check");
  expect(await code(insert({ ...copy, logical_member_keys: [`websearch-query:${"0".repeat(64)}`] }))).toMatch(/^23514:model_capacity_requests_(members|logical|dispatch)_check$/);
  // 기존 kind(Korean tagline 등)의 실제 경로 회귀는 같은 DB 에서 tests/integration/model-capacity-crawl-tagline-ledger.test.ts 가 이어서 본다
  expect(await code(insert({ ...copy, request_id: randomUUID(), dispatch_binding: { ...(copy.dispatch_binding as object), version: 2 } })))
    .toBe("23514:model_capacity_requests_dispatch_check");
});

function sameTarget(query: string, owner: typeof ownerA, model = TRANSLATE_MODEL) {
  const goal = target(query.trim().replace(/\s+/g, " ")), input: WebsearchQueryInput = { model, member: { cacheKey: goal.cacheKey, sourceLocale: "ko",
    queryHash: searchTranslation.normalizeQuery(query) === query ? "1".repeat(64) : "2".repeat(64), promptVersion: QUERY_PROMPT_VERSION,
    glossaryVersion: goal.glossaryVersion, cache: { kind: "absent" } } };
  return { input, request: { ...identity(input, owner), requestId: randomUUID() } };
}
it("grants exactly one of two concurrent backends for one target and fences the other before any INSERT", async () => {
  const a = sameTarget("독서 기록 공유", ownerA), b = sameTarget("독서  기록 공유", ownerB, modelB);
  const results = await Promise.all([ledger.requestWebsearchQueryModelSlot(a.request, a.input), ledger.requestWebsearchQueryModelSlot(b.request, b.input)]);
  expect(results.map(result => result.kind).sort()).toEqual(["deferred", "granted"]);
  expect(results.find(result => result.kind === "deferred")).toEqual({ kind: "deferred", reason: "capacity" });
  const stored = await rows(a.input.member.cacheKey);
  expect(stored).toHaveLength(1); expect(stored[0]).toMatchObject({ state: "reserved", logical_member_keys: [`websearch-query:${a.input.member.cacheKey}`] });
  const winner = results.find(result => result.kind === "granted")!;
  if (winner.kind === "granted") expect(await ledger.cancelReservedModelSlot(winner.reservation)).toBe(true);
});
it("stores the fixed member on the first waiting INSERT and reuses the own pending id without a duplicate", async () => {
  // 앞 시험의 full C(indeterminate)가 자리를 계속 잡고 있다 — 남은 자리만 채운다
  const [{ active }] = await admin`SELECT count(*)::int AS active FROM model_capacity_requests WHERE state IN ('reserved','dispatched','indeterminate')`;
  expect(active).toBeGreaterThanOrEqual(1); expect(active).toBeLessThan(4);
  const busy = await Promise.all(Array.from({ length: 4 - active }, () => ledger.requestModelSlot({ requestId: randomUUID(), workKey: randomUUID(),
    owner: { instanceId: `${prefix}-busy`, bootId: randomUUID() }, class: "background", pool: "text", routeId: busyRoute, provider: "fixture", model: modelB })));
  try {
    expect(busy.every(result => result.kind === "granted")).toBe(true);
    const a = sameTarget("등산 코스 추천", ownerA);
    expect(await ledger.requestWebsearchQueryModelSlot(a.request, a.input)).toEqual({ kind: "deferred", reason: "capacity" });
    const [waiting] = await rows(a.input.member.cacheKey);
    expect(waiting).toMatchObject({ request_id: a.request.requestId, state: "waiting", logical_member_keys: [`websearch-query:${a.input.member.cacheKey}`],
      logical_work_key: `text:websearch-query:${a.input.member.cacheKey}` });
    const own = await ledger.findOwnPendingModelRequest(identity(a.input, ownerA));
    expect(own).toEqual({ requestId: a.request.requestId, state: "waiting" });
    expect(await ledger.requestWebsearchQueryModelSlot({ ...a.request, requestId: own!.requestId }, a.input)).toEqual({ kind: "deferred", reason: "capacity" });
    const b = sameTarget("등산  코스 추천", ownerB);
    expect(await ledger.requestWebsearchQueryModelSlot(b.request, b.input)).toEqual({ kind: "deferred", reason: "capacity" });
    expect(await rows(a.input.member.cacheKey)).toHaveLength(1);
  } finally {
    for (const result of busy) if (result.kind === "granted") await ledger.cancelReservedModelSlot(result.reservation);
  }
});
