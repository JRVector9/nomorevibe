import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { glossaryHints } from "@/lib/crawl/translate";
import { normalizeQuery, queryTranslationKey, resolveSearchQuery, warmQueryTranslation } from "@/lib/domain/products/search-translation";
import type { WebsearchQueryInput } from "@/lib/llm/capacity";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { pinTextRanks, textContract } from "./text-task-ranks-fixture";

// 공개 검색어 번역의 공통 슬롯 연결 — 장부·native·주 DB 경계는 가짜로 두고 호출 순서·횟수와 사용자에게 돌아가는 값만 본다.
const mocks = vi.hoisted(() => ({ legacyKo: vi.fn(), legacyZh: vi.fn(), cacheRead: vi.fn(), legacyWrite: vi.fn(), primary: vi.fn(),
  control: vi.fn(), pending: vi.fn(), slot: vi.fn(), cancel: vi.fn(), mark: vi.fn(), reconcile: vi.fn(),
  prepareCall: vi.fn(), native: vi.fn(), prepare: vi.fn(), record: vi.fn(), owner: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/crawl/translate", async load => ({ ...await load<typeof import("@/lib/crawl/translate")>(),
  translateQueryToEnglish: mocks.legacyKo, translateChineseQueryToEnglish: mocks.legacyZh }));
vi.mock("@/lib/crawl/translations", () => ({ recordTranslations: mocks.legacyWrite }));
vi.mock("@/lib/db", () => ({ db: { select: () => ({ from: () => ({ where: mocks.cacheRead }) }), execute: async () => [{ lexeme: "document" }] },
  onPrimary: mocks.primary }));
vi.mock("@/lib/llm/capacity-repository", () => ({ readModelCapacityCallerControl: mocks.control, findOwnPendingModelRequest: mocks.pending,
  requestWebsearchQueryModelSlot: mocks.slot, cancelReservedModelSlot: mocks.cancel, markModelDispatchIndeterminate: mocks.mark,
  reconcileWebsearchQueryGatewayTerminal: mocks.reconcile }));
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ prepareWebsearchQueryGatewayCall: mocks.prepareCall, translateQueryWithReservedGateway: mocks.native }));
vi.mock("@/lib/domain/products/search-query-capacity-repository", () => ({ prepareWebsearchQueryDispatch: mocks.prepare, recordWebsearchQueryResult: mocks.record }));
vi.mock("@/lib/llm/websearch-process-owner", () => ({ websearchProcessOwner: mocks.owner }));
vi.mock("@/lib/observability/logger", () => ({ logger: { info: mocks.log, warn: mocks.log } }));

// 모델은 「작업 ↔ 모델」 순위가 고른다(PR B) — 요청마다 순위를 열고(TextTaskRanks.open) 그 순위의 모델로 장부·계약·캐시를 적는다.
const SEARCH_QUERY_MODEL = "search-query-unit";
const query = "문서 정리", owner = { instanceId: "web-unit", bootId: randomUUID(), release: "unit-release" };
const open = { mode: "open", epoch: 1, revision: 1, policyHash: "a".repeat(64),
  policy: { routes: [{ routeId: "search-query-translate", provider: "abcllm", model: SEARCH_QUERY_MODEL, providerBudgetId: "a", groupId: "g" }] } };
function input(text = query): WebsearchQueryInput {
  return { model: SEARCH_QUERY_MODEL, member: { cacheKey: queryTranslationKey(text), sourceLocale: "ko", queryHash: "b".repeat(64),
    promptVersion: 2, glossaryVersion: glossaryHints(normalizeQuery(text)) ? 1 : null, cache: { kind: "absent" } } };
}
const dispatch = { requestId: randomUUID() }, expectation = Object.freeze({ kind: "websearch_query_write" });
function latch<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetAllMocks();
  // The route opens only on an engine connected directly (admin contract, transport direct); the gateway key was removed 2026-10-30.
  // 순위 하나와 그 연결을 가리키는 엔진 직접 계약 하나.
  setServingContractSnapshotForTest([textContract("search-query-translate", SEARCH_QUERY_MODEL)]);
  pinTextRanks({ "search-query-translate": SEARCH_QUERY_MODEL });
  mocks.primary.mockImplementation((load: () => Promise<unknown>) => load());
  mocks.cacheRead.mockResolvedValue([]); mocks.control.mockResolvedValue(open); mocks.owner.mockReturnValue(owner);
  mocks.prepareCall.mockReturnValue({ kind: "prepared", provider: "abcllm", model: SEARCH_QUERY_MODEL, wireHash: "c".repeat(64), servingContractHash: "d".repeat(64),
    totalTokenBound: 4096, queryHash: "b".repeat(64), sourceLocale: "ko" });
  mocks.prepare.mockImplementation(async (_target: unknown, options: { reserved?: unknown }) => options.reserved
    ? { kind: "ready", dispatch, expectation } : { kind: "ready", input: input() });
  mocks.pending.mockResolvedValue(null); mocks.slot.mockResolvedValue({ kind: "granted", reservation: { requestId: randomUUID() } });
  mocks.native.mockResolvedValue({ result: { ok: true, keywords: "document organizer" }, terminal: Object.freeze({ kind: "websearch_query_gateway_terminal" }) });
  mocks.reconcile.mockResolvedValue({ kind: "settled" }); mocks.mark.mockResolvedValue(true); mocks.record.mockResolvedValue({ kind: "stored" });
  mocks.legacyKo.mockResolvedValue({ ok: true, keywords: "legacy words" });
});
afterEach(() => { setServingContractSnapshotForTest(null); pinTextRanks(null); vi.unstubAllEnvs(); });

it("keeps the original leaf, cache writer and result exactly when disabled", async () => {
  mocks.control.mockResolvedValue({ ...open, mode: "disabled", policy: null });
  const result = await resolveSearchQuery(query, { waitForTranslation: true });
  expect(result).toMatchObject({ translated: "legacy words" }); expect(result.translationPending).toBeUndefined();
  expect(mocks.legacyKo.mock.calls).toEqual([[query, 8_000]]);
  expect(mocks.legacyWrite.mock.calls).toEqual([[[{ hash: queryTranslationKey(query), translated: "legacy words", error: undefined }], SEARCH_QUERY_MODEL, "en"]]);
  expect(mocks.primary).toHaveBeenCalledTimes(1);
  for (const ledger of [mocks.owner, mocks.prepareCall, mocks.prepare, mocks.slot, mocks.native, mocks.record]) expect(ledger).not.toHaveBeenCalled();
  expect(mocks.control).toHaveBeenCalledTimes(1);
});

// 예전: 직접 계약이 없으면 옛 leaf·캐시 기록으로 떨어졌다. PR B: 순위의 연결을 가리키는 계약이 없으면 그 순위를 쓸 수 없고, 쓸 순위가 없으면
// 기본값·옛 길로 부르지 않고 번역 없이 찾는다(검색은 원문으로 돈다). 순위가 아예 없을 때도 같다.
it.each([["missing direct contract", () => setServingContractSnapshotForTest([])], ["no task ranks", () => pinTextRanks([])]] as const)
  ("searches untranslated without the leaf, cache writer or ledger when %s", async (_name, change) => {
    // A leftover gateway key does not stand in for the direct contract.
    change(); vi.stubEnv("ABCLLM_API_KEY", "old-gateway-key");
    const result = await resolveSearchQuery(query, { waitForTranslation: true });
    expect(result).toMatchObject({ translated: null, queries: { texts: [query] } }); expect(result.translationPending).toBeUndefined();
    for (const side of [mocks.legacyKo, mocks.legacyWrite, mocks.primary, mocks.control, mocks.owner, mocks.prepareCall, mocks.prepare,
      mocks.slot, mocks.native, mocks.record]) expect(side).not.toHaveBeenCalled();
  });

it("disabled Chinese query keeps its own original leaf and failure cache", async () => {
  mocks.control.mockResolvedValue({ ...open, mode: "disabled", policy: null });
  mocks.legacyZh.mockResolvedValue({ ok: false, error: "network" });
  const result = await resolveSearchQuery("代码编辑器", { waitForTranslation: true });
  expect(result.translated).toBeNull(); expect(mocks.legacyZh.mock.calls).toEqual([["代码编辑器", "zh-Hans", 8_000]]);
  expect(mocks.legacyWrite.mock.calls).toEqual([[[{ hash: queryTranslationKey("代码编辑器"), translated: null, error: "network" }], SEARCH_QUERY_MODEL, "en"]]);
});

it("connects an immediately granted permit to one native POST, settlement first and then the guarded cache writer", async () => {
  const order: string[] = [];
  mocks.native.mockImplementation(async () => { order.push("post"); return { result: { ok: true, keywords: "document organizer" }, terminal: { kind: "t" } }; });
  mocks.reconcile.mockImplementation(async () => { order.push("settle"); return { kind: "settled" }; });
  mocks.record.mockImplementation(async () => { order.push("cache"); return { kind: "stored" }; });
  const result = await resolveSearchQuery(query, { waitForTranslation: true });
  expect(result.translated).toBe("document organizer"); expect(result.translationPending).toBeUndefined();
  expect(order).toEqual(["post", "settle", "cache"]);
  expect(mocks.native).toHaveBeenCalledTimes(1); expect(mocks.native.mock.calls[0][0]).toEqual({ sourceLocale: "ko", query });
  expect(mocks.native.mock.calls[0][3]).toEqual({ timeoutMs: 8_000 });
  expect(mocks.prepareCall.mock.calls).toEqual([[{ sourceLocale: "ko", query }, { model: SEARCH_QUERY_MODEL, timeoutMs: 8_000, provider: "abcllm" }]]);
  expect(mocks.slot).toHaveBeenCalledTimes(1);
  expect(mocks.slot.mock.calls[0][0]).toMatchObject({ owner: { instanceId: owner.instanceId, bootId: owner.bootId }, class: "background",
    pool: "text", routeId: "search-query-translate", provider: "abcllm", model: SEARCH_QUERY_MODEL });
  expect(mocks.record.mock.calls).toEqual([[expectation, { ok: true, keywords: "document organizer" }]]);
  expect(mocks.legacyKo).not.toHaveBeenCalled(); expect(mocks.legacyWrite).not.toHaveBeenCalled();
});

it.each(["capacity", "queue_full", "policy_changed", "draining"] as const)
  ("defers immediately on %s without polling, POST, failure cache or attempts", async reason => {
    if (reason === "draining") mocks.control.mockResolvedValue({ ...open, mode: "draining" });
    else mocks.slot.mockResolvedValue({ kind: "deferred", reason });
    const result = await resolveSearchQuery(query, { waitForTranslation: true });
    expect(result).toMatchObject({ translated: null, translationPending: true }); expect(result.queries).toMatchObject({ texts: [query] });
    expect(mocks.slot).toHaveBeenCalledTimes(reason === "draining" ? 0 : 1);
    for (const side of [mocks.native, mocks.record, mocks.legacyKo, mocks.legacyWrite, mocks.cancel]) expect(side).not.toHaveBeenCalled();
  });

// 그 모델만의 까닭(정책에 없음·전송 계약 닫힘)은 그 순위만 쉬게 하고 다음 순위로 넘긴다 — 순위가 하나뿐이면 쓸 순위가 없어 포화가 아니므로
// 기다림(pending) 없이 번역 없이 찾는다(PR B). 예전에는 둘 다 pending 이었다.
it("searches untranslated when the only rank is unmapped, with no slot, POST, failure cache or attempts", async () => {
  mocks.control.mockResolvedValue({ ...open, policy: { routes: [] } });
  const result = await resolveSearchQuery(query, { waitForTranslation: true });
  expect(result).toMatchObject({ translated: null }); expect(result.translationPending).toBeUndefined(); expect(result.queries).toMatchObject({ texts: [query] });
  for (const side of [mocks.slot, mocks.native, mocks.record, mocks.legacyKo, mocks.legacyWrite, mocks.cancel]) expect(side).not.toHaveBeenCalled();
});

it("keeps production resolver null as an unusable rank and a missing process identity as deferred with no ledger request", async () => {
  mocks.prepareCall.mockReturnValue({ kind: "unsupported", reason: "provider_contract_unavailable" });
  const unusable = await resolveSearchQuery(query, { waitForTranslation: true });
  expect(unusable).toMatchObject({ translated: null }); expect(unusable.translationPending).toBeUndefined();
  mocks.prepareCall.mockClear(); mocks.owner.mockReturnValue(null);
  expect(await resolveSearchQuery(query, { waitForTranslation: true })).toMatchObject({ translated: null, translationPending: true });
  expect(mocks.prepareCall).not.toHaveBeenCalled();
  for (const side of [mocks.prepare, mocks.slot, mocks.native, mocks.legacyKo, mocks.legacyWrite]) expect(side).not.toHaveBeenCalled();
});

it("warmup tries once and ends on deferred", async () => {
  mocks.slot.mockResolvedValue({ kind: "deferred", reason: "capacity" });
  await warmQueryTranslation(query);
  expect(mocks.slot).toHaveBeenCalledTimes(1); expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.legacyWrite).not.toHaveBeenCalled();
});

it("joins wait, zero-result fallback and warmup in one process into one POST sharing the owner's remaining time", async () => {
  const gate = latch<{ result: { ok: true; keywords: string }; terminal: object }>();
  mocks.native.mockReturnValue(gate.promise);
  const wait = resolveSearchQuery(query, { waitForTranslation: true }), fallback = resolveSearchQuery(query, { waitForTranslation: true });
  const warm = warmQueryTranslation(query);
  await vi.waitFor(() => expect(mocks.native).toHaveBeenCalledTimes(1));
  gate.resolve({ result: { ok: true, keywords: "document organizer" }, terminal: { kind: "t" } });
  expect((await wait).translated).toBe("document organizer"); expect((await fallback).translated).toBe("document organizer"); await warm;
  expect(mocks.native).toHaveBeenCalledTimes(1); expect(mocks.slot).toHaveBeenCalledTimes(1); expect(mocks.record).toHaveBeenCalledTimes(1);
  expect(mocks.prepareCall).toHaveBeenCalledTimes(1);
});

it("removes only its own flight after success, failure or deferral so a later search starts fresh", async () => {
  mocks.slot.mockResolvedValueOnce({ kind: "deferred", reason: "capacity" });
  expect((await resolveSearchQuery(query, { waitForTranslation: true })).translationPending).toBe(true);
  mocks.native.mockRejectedValueOnce(new Error("socket"));
  expect((await resolveSearchQuery(query, { waitForTranslation: true })).translated).toBeNull();
  expect(mocks.mark.mock.calls).toEqual([[dispatch, "transport_unknown"]]);
  expect((await resolveSearchQuery(query, { waitForTranslation: true })).translated).toBe("document organizer");
  expect(mocks.slot).toHaveBeenCalledTimes(3); expect(mocks.native).toHaveBeenCalledTimes(2);
});

it("uses the primary cache and a settled continuation without a slot or POST", async () => {
  mocks.prepare.mockResolvedValueOnce({ kind: "cached", text: "primary words" });
  expect((await resolveSearchQuery(query, { waitForTranslation: true })).translated).toBe("primary words");
  mocks.prepare.mockResolvedValueOnce({ kind: "continued", result: { ok: true, keywords: "settled words" }, cached: null });
  expect((await resolveSearchQuery(query, { waitForTranslation: true })).translated).toBe("settled words");
  for (const side of [mocks.slot, mocks.native, mocks.record, mocks.legacyKo, mocks.legacyWrite]) expect(side).not.toHaveBeenCalled();
});

it("an own unresolved dispatch defers instead of a second POST", async () => {
  mocks.pending.mockResolvedValue({ requestId: randomUUID(), state: "dispatched" });
  expect(await resolveSearchQuery(query, { waitForTranslation: true })).toMatchObject({ translated: null, translationPending: true });
  expect(mocks.slot).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
});

it("an ordinary physical failure keeps full C and records the original failure name once", async () => {
  mocks.native.mockResolvedValue({ result: { ok: false, error: "http_404" }, terminal: null });
  const result = await resolveSearchQuery(query, { waitForTranslation: true });
  expect(result.translated).toBeNull(); expect(result.translationPending).toBeUndefined();
  expect(mocks.reconcile).not.toHaveBeenCalled(); expect(mocks.mark.mock.calls).toEqual([[dispatch, "transport_unknown"]]);
  expect(mocks.record.mock.calls).toEqual([[expectation, { ok: false, error: "http_404" }]]);
});

it("a stale writer loses to the winner's done cache and never overwrites it", async () => {
  mocks.record.mockResolvedValue({ kind: "lost", cached: "winner words" });
  expect((await resolveSearchQuery(query, { waitForTranslation: true })).translated).toBe("winner words");
});

it("cancels only the reservation when reserved reentry changes and never POSTs", async () => {
  mocks.prepare.mockImplementation(async (_target: unknown, options: { reserved?: unknown }) => options.reserved
    ? { kind: "skipped" } : { kind: "ready", input: input() });
  expect(await resolveSearchQuery(query, { waitForTranslation: true })).toMatchObject({ translationPending: true });
  expect(mocks.cancel).toHaveBeenCalledTimes(1); expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.mark).not.toHaveBeenCalled();
  mocks.prepare.mockImplementation(async (_target: unknown, options: { reserved?: unknown }) => {
    if (options.reserved) throw new ModelCapacityDeferredError("reservation_lost"); return { kind: "ready", input: input() };
  });
  expect(await resolveSearchQuery(query, { waitForTranslation: true })).toMatchObject({ translationPending: true });
  expect(mocks.cancel).toHaveBeenCalledTimes(2); expect(mocks.native).not.toHaveBeenCalled();
});
