import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { prepareAi1DirectCall, prepareAi2GatewayCall, prepareCrawlTaglineGatewayCall, prepareProductTaglineKoGatewayCall,
  prepareProductTranslationGatewayCall, prepareReasonTranslationGatewayCall, prepareSearchVerifyGatewayCall, prepareTextProfileGatewayCall,
  prepareWebsearchQueryGatewayCall, reviewWithReservedAi1Gateway, reviewWithReservedAi1ItemGateway, reviewWithReservedAi2Gateway,
  translateProductFieldsWithReservedGateway, translateQueryWithReservedGateway, translateTaglinesWithReservedGateway,
  translateWithReservedReasonGateway, verifyKeywordsWithReservedGateway, writeKeywordsWithReservedGateway, writeTaglineWithReservedGateway,
  type GatewayHttpRejected, type GatewayNotStarted } from "@/lib/crawl/agent-review-gateway";
import { preparePublicationClassifyCall, runPublicationClassifyCall } from "@/lib/crawl/publication-classify-gateway";
import { taglineHash } from "@/lib/crawl/tagline";
import { productTaglineKoSourceHash, textHash, type ProductTranslationGatewayItem } from "@/lib/crawl/translate";
import { profileHash } from "@/lib/domain/products/search-profile";
import { SEARCH_VERIFY_POLICY_HASH } from "@/lib/domain/products/search-verify";
import { productTranslationSourceHash } from "@/lib/domain/products/translation-policy";
import { claimItemLease, lockItemStage } from "@/lib/jobs/items/repository";
import { itemBindingHash, type Ai1ItemBinding, type Ai2ItemBinding } from "@/lib/jobs/items/types";
import { ai1DispatchBindingSchema, ai1ItemDispatchBindingSchema, ai2DispatchBindingSchema, crawlTaglineDispatchBindingSchema, crawlTaglineGenerationHash,
  crawlTaglineInputHash, crawlTaglineLogicalWorkKey, modelCapacityPolicyHash, productTaglineKoDispatchBindingSchema, productTaglineKoInputHash,
  productTaglineKoLogicalWorkKey, productTranslationDispatchBindingSchema, productTranslationInputHash, productTranslationLogicalWorkKey,
  publicationClassifyApiBindingSchema, publicationClassifyApiInputHash, publicationClassifyLogicalWorkKey, reasonTranslationDispatchBindingSchema,
  reasonTranslationInputHash, reasonTranslationLogicalWorkKey, searchVerifyDispatchBindingSchema, searchVerifyGenerationHash, searchVerifyInputHash,
  searchVerifyLogicalWorkKey, textProfileDispatchBindingSchema, textProfileInputHash, websearchQueryDispatchBindingSchema, websearchQueryInputHash,
  websearchQueryLogicalWorkKey, type CrawlTaglineInput, type ModelCapacityDispatch, type ModelCapacityPolicy, type ModelCapacityRequest,
  type ModelCapacityReservation, type ModelSlotResult, type ProductTaglineKoMember, type ProductTranslationMember, type PublicationClassifyApiInput,
  type ReasonTranslationMember, type SearchVerifyInput, type WebsearchQueryInput } from "@/lib/llm/capacity";
import { closeModelCapacityUnknownReview, finishAi1ItemModelCapacityDispatch, finishAi1ModelCapacityDispatch, finishAi2ItemModelCapacityDispatch,
  finishCrawlTaglineModelCapacityDispatch, finishProductTaglineKoModelCapacityDispatch, finishProductTranslationModelCapacityDispatch,
  finishPublicationApiDispatch, finishReasonTranslationModelCapacityDispatch, finishSearchVerifyModelCapacityDispatch,
  finishTextProfileModelCapacityDispatch, finishWebsearchQueryModelCapacityDispatch, lockAi1ModelCapacityDispatch, lockAi2ItemModelCapacityDispatch,
  lockCrawlTaglineModelCapacityDispatch, lockProductTaglineKoModelCapacityDispatch, lockProductTranslationModelCapacityDispatch, lockPublicationApiDispatch,
  lockReasonTranslationModelCapacityDispatch, lockSearchVerifyModelCapacityDispatch, lockTextProfileModelCapacityDispatch,
  lockWebsearchQueryModelCapacityDispatch, markModelDispatchIndeterminate, reconcileAi1GatewayTerminal, reconcileAi1ItemGatewayTerminal,
  reconcileAi2GatewayTerminal, reconcileCrawlTaglineGatewayTerminal, reconcileGatewayHttpRejected, reconcileGatewayNotStarted,
  reconcileProductTaglineKoGatewayTerminal, reconcileProductTranslationGatewayTerminal, reconcilePublicationApiTerminal,
  reconcileReasonTranslationGatewayTerminal, reconcileSearchVerifyGatewayTerminal, reconcileTextProfileGatewayTerminal,
  reconcileWebsearchQueryGatewayTerminal, requestAi1ModelSlot, requestAi2ItemModelSlot, requestCrawlTaglineModelSlot, requestProductTaglineKoModelSlot,
  requestProductTranslationModelSlot, requestPublicationApiSlot, requestReasonTranslationModelSlot, requestSearchVerifyModelSlot,
  requestTextProfileModelSlot, requestWebsearchQueryModelSlot } from "@/lib/llm/capacity-repository";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { releaseEvidencedDispatches } from "@/lib/operations/dr/reclaim";
import { abcllmContract, classifyPayload, contractRow, profileEvidence, queryInput, reasonTexts, reviewInput, taglineEvidence, taglineKoItems,
  TOTAL_BOUND_ROUTES, totalBoundContract, translationItems, verifyItem, type TotalBoundRoute } from "../total-bound-direct-fixture";
import { TEST_DATABASE_URL } from "./setup";

/**
 * 2026-11-21 abcllm 이름표 정리 1단계: 열 경로의 엔진 직접 총량 상한 계약(openai-chat-total-bound-v1, provider local-direct)을 실제 PostgreSQL 장부로
 * 돈다 — 줄 서기 → 예약 → dispatch(행·binding 모두 local-direct) → 그 경로의 실제 준비·전송 함수 → 정산. 끝나는 길마다 본다:
 * 엔진 완결 응답(terminal), 보내지 않음(gateway_not_started), HTTP 429(text 경로는 gateway_http_rejected, 심사·분류는 미확정), 미확정 뒤 로컬 종료
 * 근거 회수(local_call_ended), 미확정 뒤 운영자 검토(operator_review). 장부 guard(model_capacity_check_rules)가 어느 전이도 막지 않아야 한다.
 * 또 보낸 요청이 준비한 wire 바이트 그대로이고 엄격 terminal 헤더가 없음을 엔진 쪽에서 확인한다.
 * 계약은 실제 resolver 가 계약 스냅숏에서 읽는다(mock 없음). 자기 DB 를 새로 만든다. 운영 값이 아니다(loopback fixture).
 */
const name = `nomorevibe_test_total_bound_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {} });
let created = false, serial = 1000;
const MODEL = "fixture-model", SINGLE = "fixture-single", OLD_SHAPE = "fixture-abcllm", BUDGET = "account-direct", DEVICE = "device-direct", RESPONSE_MODEL = "served-fixture";
const owner = { instanceId: `total-bound-${randomUUID()}`, bootId: randomUUID() };
const operator = "total-bound-fixture", reference = "fixture: the loopback engine closes with the client";
const policy: ModelCapacityPolicy = { version: 1, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 60_000, groupLimits: { [DEVICE]: 8, "device-single": 1 },
  routes: [...TOTAL_BOUND_ROUTES.map(routeId => ({ routeId, provider: "local-direct", model: MODEL, providerBudgetId: BUDGET, groupId: DEVICE })),
    { routeId: "reason-translate", provider: "local-direct", model: SINGLE, providerBudgetId: BUDGET, groupId: "device-single" },
    // 견줌용: 지금 운영 모양(abcllm 계약·abcllm 장부 route)의 카테고리 분류 한 줄
    { routeId: "crawl-publish-classify", provider: "abcllm", model: OLD_SHAPE, providerBudgetId: BUDGET, groupId: DEVICE }] };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Loopback 엔진: /v1/chat/completions 는 완결 응답·429·500·무응답, /tokenize 는 vLLM 꼴(count·max_model_len·tokens). 받은 요청을 그대로 남긴다. */
const engine = { mode: "ok" as "ok" | "hang" | 429 | 500, content: "[]", tokens: 90,
  requests: [] as { path: string; headers: IncomingHttpHeaders; body: string }[] };
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", chunk => chunks.push(chunk as Buffer));
  request.on("end", () => {
    engine.requests.push({ path: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
    if (request.url === "/tokenize") { response.end(JSON.stringify({ count: engine.tokens, max_model_len: 65_536,
      tokens: Array.from({ length: engine.tokens }, (_, index) => index + 1) })); return; }
    if (engine.mode === "hang") return;
    if (engine.mode !== "ok") { response.statusCode = engine.mode; if (engine.mode === 429) response.setHeader("retry-after", "2"); response.end("{}"); return; }
    response.end(JSON.stringify({ id: "total-bound-response", object: "chat.completion", created: 1, model: RESPONSE_MODEL,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: engine.content } }],
      usage: { prompt_tokens: 90, completion_tokens: 20, total_tokens: 110 } }));
  });
});
let origin = "";
/** 열 경로의 새 모양 계약을 계약 스냅숏에 둔다(행의 transport 표시는 일부러 gateway — local-direct 계약은 그 표시와 무관하게 직접이다). */
function pinContracts(extra: Partial<Record<TotalBoundRoute, Record<string, unknown>>> = {}) {
  const endpoint = `${origin}/v1/chat/completions`;
  setServingContractSnapshotForTest([
    ...TOTAL_BOUND_ROUTES.map(routeId => contractRow(totalBoundContract(routeId, { model: MODEL, endpoint, responseModel: RESPONSE_MODEL, extra: extra[routeId] }), "gateway")),
    contractRow(totalBoundContract("reason-translate", { model: SINGLE, endpoint, responseModel: RESPONSE_MODEL }), "gateway"),
    contractRow(abcllmContract("crawl-publish-classify", { model: OLD_SHAPE, endpoint, responseModel: RESPONSE_MODEL }), "direct")]);
}

type Dispatched = ModelCapacityDispatch & { binding: { provider: string; routeId: string; chargedTokens: number }; bindingHash: string };
type Sent = { terminal: object | null; notStarted?: GatewayNotStarted; rejected?: GatewayHttpRejected };
type Started = { request: ModelCapacityRequest; wireHash: string; dispatch: Dispatched;
  send(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Sent>; settle(terminal: object): Promise<{ kind: "settled" | "already_settled" }> };
type StartOptions = { timeoutMs?: number; model?: string };
type Flow = { name: string; routeId: TotalBoundRoute; httpRejected: boolean; content: string; start(seed: number, options?: StartOptions): Promise<Started>;
  /**
   * false: 이 dispatch kind 는 로컬 종료 근거 회수(local_call_ended)를 장부 guard 가 받지 않는다. 카테고리 분류의 API kind(publication_classify_gateway, 0166)가
   * 그렇다 — provider 와 무관한 예전부터의 빈칸이다(아래 견줌 시험이 abcllm 계약에서도 같은 거절을 본다).
   */
  releasable?: false };

function granted(result: ModelSlotResult): ModelCapacityReservation {
  expect(result).toMatchObject({ kind: "granted" }); if (result.kind !== "granted") throw new Error("reservation_required");
  return result.reservation;
}
function identity(value: ModelCapacityRequest) { const result = { ...value }; Reflect.deleteProperty(result, "requestId"); return result; }
function prepared<T extends { kind: string }>(call: T): Extract<T, { kind: "prepared" }> {
  expect(call).toMatchObject({ kind: "prepared" }); if (call.kind !== "prepared") throw new Error("prepared_required");
  return call as Extract<T, { kind: "prepared" }>;
}
const base = (routeId: TotalBoundRoute, workKey: string, pool: "text" | "reviewer", cls: "first" | "second" | "background", model = MODEL): ModelCapacityRequest =>
  ({ requestId: randomUUID(), workKey, owner: { ...owner }, class: cls, pool, routeId, provider: "local-direct", model });
const textRole = () => ({ role: "text" as const, instanceId: owner.instanceId, bootId: owner.bootId, release: "total-bound-fixture", kind: "primary" as const,
  epoch: 1, batch: { mode: "legacy" as const } });
const job = <N extends string>(jobName: N) => ({ name: jobName, token: randomUUID(), requestedVersion: 1 });
const charge = (call: { wireHash: string; servingContractHash: string; totalTokenBound: number }) => ({ provider: "local-direct" as const, wireHash: call.wireHash,
  servingContractHash: call.servingContractHash, totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound });
const REVIEW_CONTENT = JSON.stringify({ decision: "needs_review", reason: "fixture answer", evidenceIds: [], confidence: 0.5 });

function translationFlow(flowName: string, locale: ProductTranslationGatewayItem["locale"]): Flow {
  return { name: flowName, routeId: "product-translate", httpRejected: true, content: JSON.stringify(["Toolkit helps organize documents", "Calendar plans releases"]),
    async start(seed, options = {}) {
      const items = translationItems(locale), timeoutMs = options.timeoutMs ?? 5_000;
      const call = prepared(prepareProductTranslationGatewayCall(items, { model: MODEL, timeoutMs, provider: "local-direct" }));
      const members: ProductTranslationMember[] = items.map((item, index) => { const productId = seed * 10 + index;
        return { productId, slug: `total-bound-${productId}`, locale: item.locale, field: item.field, sourceHash: productTranslationSourceHash({ id: productId, name: item.name,
          tagline: item.field === "tagline" ? item.text : "", description: item.field === "description" ? item.text : "" }, item.field),
        demand: { rowIdentityHash: sha(`demand-${productId}`), attempts: 0 } }; });
      const logical = productTranslationLogicalWorkKey(members), inputHash = productTranslationInputHash({ members, model: MODEL });
      const request = base("product-translate", `${logical}:${inputHash}`, "text", "background");
      const reservation = granted(await requestProductTranslationModelSlot(request, members));
      const dispatch = await db.transaction(async tx => {
        const lock = await lockProductTranslationModelCapacityDispatch(tx, { reservation, identity: identity(request), members });
        if (!lock) throw new Error("lock_required");
        return finishProductTranslationModelCapacityDispatch(tx, lock, productTranslationDispatchBindingSchema.parse({ kind: "product_translation_gateway", version: 1,
          members, model: MODEL, logicalWorkKey: logical, inputHash, routeId: "product-translate", ...charge(call), job: job("product-translate"), role: textRole() }));
      });
      return { request, wireHash: call.wireHash, dispatch, send: sendOptions => translateProductFieldsWithReservedGateway(items, dispatch, call, sendOptions),
        settle: terminal => reconcileProductTranslationGatewayTerminal(terminal as never) };
    } };
}

function classifyFlow(flowName: string, provider: "local-direct" | "abcllm", model: string): Flow {
  return { name: flowName, routeId: "crawl-publish-classify", httpRejected: false, releasable: false,
    content: JSON.stringify({ categories: [{ id: 0, category: "productivity" }] }),
    async start(seed, options = {}) {
      const payload = classifyPayload();
      const call = prepared(preparePublicationClassifyCall(payload, { model, provider, timeoutMs: options.timeoutMs ?? 5_000 }));
      const input: PublicationClassifyApiInput = { members: [{ candidateId: seed, repo: `total-bound/app-${seed}`, sourceHash: sha(`classify-${seed}`) }],
        provider, model, payloadHash: reviewHash(payload.inputs), definitionsHash: reviewHash(payload.definitions),
        configRevision: 1, memberId: randomUUID() };
      const logical = publicationClassifyLogicalWorkKey(input.members), inputHash = publicationClassifyApiInputHash(input);
      const request = { ...base("crawl-publish-classify", `${logical}:${inputHash}`, "reviewer", "background", model), provider };
      const reservation = granted(await requestPublicationApiSlot(request, input));
      const dispatch = await db.transaction(async tx => {
        const lock = await lockPublicationApiDispatch(tx, { reservation, identity: identity(request), input });
        if (!lock) throw new Error("lock_required");
        return finishPublicationApiDispatch(tx, lock, publicationClassifyApiBindingSchema.parse({ ...input, kind: "publication_classify_gateway", version: 1,
          logicalWorkKey: logical, inputHash, routeId: "crawl-publish-classify", publisherRole: { role: "publisher", instanceId: owner.instanceId,
            bootId: owner.bootId, release: "total-bound-fixture", epoch: 1, kind: "primary" }, job: job("crawl-publish"), wireHash: call.wireHash,
          servingContractHash: call.servingContractHash, totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound }));
      });
      // 분류 전송은 기한을 준비 때 굳힌다(전송 옵션의 timeoutMs 는 없다) — 호출자 신호와 canStart 만 받는다
      return { request, wireHash: call.wireHash, dispatch, send: sendOptions => runPublicationClassifyCall(payload, dispatch, call,
        { signal: sendOptions?.signal, canStart: () => true }), settle: terminal => reconcilePublicationApiTerminal(terminal as never) };
    } };
}

const FLOWS: Flow[] = [
  { name: "crawl-agent-review (legacy job dispatch)", routeId: "crawl-agent-review", httpRejected: false, content: REVIEW_CONTENT,
    async start(seed, options = {}) {
      const value = reviewInput(`total-bound-${seed}`), call = prepared(await prepareAi1DirectCall(value, { model: MODEL, timeoutMs: options.timeoutMs ?? 5_000 }));
      const request = base("crawl-agent-review", `ai1:${seed}:${sha(`ai1-${seed}`)}`, "reviewer", "first");
      const reservation = granted(await requestAi1ModelSlot(request, seed));
      const dispatch = await db.transaction(async tx => {
        const lock = await lockAi1ModelCapacityDispatch(tx, { reservation, identity: identity(request), candidateId: seed });
        if (!lock) throw new Error("lock_required");
        return finishAi1ModelCapacityDispatch(tx, lock, ai1DispatchBindingSchema.parse({ kind: "ai1_legacy_gateway", version: 1, logicalWorkKey: `ai1:${seed}`,
          candidateId: seed, attemptId: seed, inputHash: value.inputHash, sourceRevisionHash: value.sourceRevisionHash, reviewPolicyHash: value.policyHash,
          promptVersion: value.snapshot.policy.promptVersion, rulesVersion: value.snapshot.policy.rulesVersion, model: MODEL, routeId: "crawl-agent-review",
          stageEpoch: 1, ...charge(call), job: job("crawl-agent-review") }));
      });
      return { request, wireHash: call.wireHash, dispatch, send: sendOptions => reviewWithReservedAi1Gateway(value, dispatch, call, sendOptions),
        settle: terminal => reconcileAi1GatewayTerminal(terminal as never) };
    } },
  { name: "crawl-agent-review (item consumer dispatch)", routeId: "crawl-agent-review", httpRejected: false, content: REVIEW_CONTENT,
    async start(seed, options = {}) {
      const value = reviewInput(`total-bound-${seed}`), call = prepared(await prepareAi1DirectCall(value, { model: MODEL, timeoutMs: options.timeoutMs ?? 5_000 }));
      const review: Ai1ItemBinding = { stage: "ai1", candidateId: seed, inputHash: value.inputHash, sourceRevisionHash: value.sourceRevisionHash,
        policyHash: value.policyHash, promptVersion: value.snapshot.policy.promptVersion, rulesVersion: value.snapshot.policy.rulesVersion,
        reviewer: { provider: "local-direct", model: MODEL } };
      const request = base("crawl-agent-review", `ai1:${seed}:${itemBindingHash(review)}`, "reviewer", "first");
      const reservation = granted(await requestAi1ModelSlot(request, seed));
      const dispatch = await db.transaction(async tx => {
        const lock = await lockAi1ModelCapacityDispatch(tx, { reservation, identity: identity(request), candidateId: seed });
        if (!lock) throw new Error("lock_required");
        const stage = await lockItemStage(tx, "ai1"), lease = await claimItemLease(tx, stage, review, request.owner, 90_000);
        if (!lease) throw new Error("item_claim_required");
        return finishAi1ItemModelCapacityDispatch(tx, lock, ai1ItemDispatchBindingSchema.parse({ kind: "ai1_item_gateway", version: 1, logicalWorkKey: `ai1:${seed}`,
          attemptId: seed, review, item: { workKey: lease.workKey, owner: lease.owner, token: lease.token, stageEpoch: lease.stageEpoch, itemEpoch: lease.itemEpoch,
            bindingHash: lease.bindingHash }, routeId: "crawl-agent-review", model: MODEL, ...charge(call) }));
      });
      return { request, wireHash: call.wireHash, dispatch, send: sendOptions => reviewWithReservedAi1ItemGateway(value, dispatch, call, sendOptions),
        settle: terminal => reconcileAi1ItemGatewayTerminal(terminal as never) };
    } },
  { name: "second-review", routeId: "second-review", httpRejected: false, content: REVIEW_CONTENT,
    async start(seed, options = {}) {
      const value = reviewInput(`total-bound-${seed}`);
      const call = prepared(await prepareAi2GatewayCall(value, { model: MODEL, timeoutMs: options.timeoutMs ?? 5_000, provider: "local-direct" }));
      const review: Ai2ItemBinding = { stage: "ai2", candidateId: seed, secondReviewId: seed, vote: seed, fallbackForId: null,
        source: { kind: "first_attempt", firstAttemptId: seed }, inputHash: value.inputHash, sourceRevisionHash: value.sourceRevisionHash,
        policyHash: value.policyHash, promptVersion: value.snapshot.policy.promptVersion, rulesVersion: value.snapshot.policy.rulesVersion,
        generationKey: sha(`generation-${seed}`), reviewer: { provider: "local-direct", model: MODEL } };
      const logical = `ai2:${seed}:${seed}`, request = base("second-review", `${logical}:${itemBindingHash(review)}`, "reviewer", "second");
      const reservation = granted(await requestAi2ItemModelSlot(request, { candidateId: seed, vote: seed }));
      const dispatch = await db.transaction(async tx => {
        const lock = await lockAi2ItemModelCapacityDispatch(tx, { reservation, identity: identity(request), target: { candidateId: seed, vote: seed } });
        if (!lock) throw new Error("lock_required");
        const stage = await lockItemStage(tx, "ai2"), lease = await claimItemLease(tx, stage, review, request.owner, 90_000);
        if (!lease) throw new Error("item_claim_required");
        return finishAi2ItemModelCapacityDispatch(tx, lock, ai2DispatchBindingSchema.parse({ kind: "ai2_item_gateway", version: 1, logicalWorkKey: logical, review,
          rowIdentityHash: sha(`row-${seed}`), failureCount: 0, inputPolicyHash: value.policyHash, item: { workKey: lease.workKey, owner: lease.owner,
            token: lease.token, stageEpoch: lease.stageEpoch, itemEpoch: lease.itemEpoch, bindingHash: lease.bindingHash }, routeId: "second-review",
          model: MODEL, ...charge(call) }));
      });
      return { request, wireHash: call.wireHash, dispatch, send: sendOptions => reviewWithReservedAi2Gateway(value, dispatch, call, sendOptions),
        settle: terminal => reconcileAi2GatewayTerminal(terminal as never) };
    } },
  { name: "product-search-profile", routeId: "product-search-profile", httpRejected: true, content: '{"keywords_en":["budget app"],"keywords_ko":["가계부"]}',
    async start(seed, options = {}) {
      const evidence = profileEvidence(), call = prepared(prepareTextProfileGatewayCall(evidence, { model: MODEL, timeoutMs: options.timeoutMs ?? 5_000, provider: "local-direct" }));
      const fixed = { productId: seed, slug: `total-bound-${seed}`, evidenceHash: profileHash(evidence), profile: { kind: "absent" as const }, model: MODEL };
      const request = base("product-search-profile", `text:profile:${seed}:${textProfileInputHash(fixed)}`, "text", "background");
      const reservation = granted(await requestTextProfileModelSlot(request, seed));
      const dispatch = await db.transaction(async tx => {
        const lock = await lockTextProfileModelCapacityDispatch(tx, { reservation, identity: identity(request), productId: seed });
        if (!lock) throw new Error("lock_required");
        return finishTextProfileModelCapacityDispatch(tx, lock, textProfileDispatchBindingSchema.parse({ ...fixed, kind: "text_profile_gateway", version: 1,
          logicalWorkKey: `text:profile:${seed}`, inputHash: textProfileInputHash(fixed), routeId: "product-search-profile", ...charge(call),
          job: job("product-search-profile"), role: textRole() }));
      });
      return { request, wireHash: call.wireHash, dispatch, send: sendOptions => writeKeywordsWithReservedGateway(evidence, dispatch, call, sendOptions),
        settle: terminal => reconcileTextProfileGatewayTerminal(terminal as never) };
    } },
  { name: "product-search-verify", routeId: "product-search-verify", httpRejected: true, content: '{"unsupported":[]}',
    async start(seed, options = {}) {
      const item = verifyItem(), call = prepared(prepareSearchVerifyGatewayCall(item, { model: MODEL, timeoutMs: options.timeoutMs ?? 5_000, provider: "local-direct" }));
      const input: SearchVerifyInput = { member: { productId: seed, slug: `total-bound-${seed}`, evidenceHash: profileHash(item.evidence),
        profile: { rowIdentityHash: sha(`profile-${seed}`), sourceRevision: 1, verifyAttempts: 0 }, keywordsHash: sha(JSON.stringify(item.keywords)),
        keywordCount: item.keywords.length, mode: "full", policyHash: SEARCH_VERIFY_POLICY_HASH }, model: MODEL, execution: 0, step: { kind: "full" }, parent: null };
      const logical = searchVerifyLogicalWorkKey(input), inputHash = searchVerifyInputHash(input);
      const request = base("product-search-verify", `${logical}:${inputHash}`, "text", "background");
      const reservation = granted(await requestSearchVerifyModelSlot(request, input));
      const dispatch = await db.transaction(async tx => {
        const lock = await lockSearchVerifyModelCapacityDispatch(tx, { reservation, identity: identity(request), input });
        if (!lock) throw new Error("lock_required");
        return finishSearchVerifyModelCapacityDispatch(tx, lock, searchVerifyDispatchBindingSchema.parse({ ...input, kind: "search_verify_gateway", version: 1,
          generationHash: searchVerifyGenerationHash(input), logicalWorkKey: logical, inputHash, deadlineAt: Date.now() + 60_000,
          routeId: "product-search-verify", ...charge(call), job: job("product-search-verify"), role: textRole() }));
      });
      return { request, wireHash: call.wireHash, dispatch, send: sendOptions => verifyKeywordsWithReservedGateway(item, dispatch, call, sendOptions),
        settle: terminal => reconcileSearchVerifyGatewayTerminal(terminal as never) };
    } },
  { name: "reason-translate", routeId: "reason-translate", httpRejected: true, content: JSON.stringify(["작동하는 제품입니다", "제품이 아닌 튜토리얼입니다"]),
    async start(seed, options = {}) {
      const model = options.model ?? MODEL, texts = reasonTexts().map(text => `${text} (${seed})`);
      const call = prepared(prepareReasonTranslationGatewayCall(texts, { model, timeoutMs: options.timeoutMs ?? 5_000, provider: "local-direct" }));
      const members: ReasonTranslationMember[] = texts.map(text => ({ sourceHash: textHash(text), cache: { kind: "absent" } }));
      const logical = reasonTranslationLogicalWorkKey(members), inputHash = reasonTranslationInputHash({ members, model });
      const request = base("reason-translate", `${logical}:${inputHash}`, "text", "background", model);
      const reservation = granted(await requestReasonTranslationModelSlot(request, members));
      const dispatch = await db.transaction(async tx => {
        const lock = await lockReasonTranslationModelCapacityDispatch(tx, { reservation, identity: identity(request), members });
        if (!lock) throw new Error("lock_required");
        return finishReasonTranslationModelCapacityDispatch(tx, lock, reasonTranslationDispatchBindingSchema.parse({ kind: "reason_translation_gateway", version: 1,
          members, model, logicalWorkKey: logical, inputHash, routeId: "reason-translate", ...charge(call), job: job("reason-translate"), role: textRole() }));
      });
      return { request, wireHash: call.wireHash, dispatch, send: sendOptions => translateWithReservedReasonGateway(texts, dispatch, call, sendOptions),
        settle: terminal => reconcileReasonTranslationGatewayTerminal(terminal as never) };
    } },
  translationFlow("product-translate (en batch)", "en"),
  // 0184 가 일본어 묶음을 local-direct 가지에만 넣었다 — 새 계약은 0193(abcllm 쪽 일본어 가지)과 무관하게 일본어 묶음을 보낸다
  translationFlow("product-translate (ja batch)", "ja"),
  { name: "product-tagline-ko", routeId: "product-tagline-ko", httpRejected: true, content: JSON.stringify(["문서를 더 빨리 정리합니다", "소프트웨어 출시를 함께 계획합니다"]),
    async start(seed, options = {}) {
      const items = taglineKoItems();
      const call = prepared(prepareProductTaglineKoGatewayCall(items, { model: MODEL, timeoutMs: options.timeoutMs ?? 5_000, provider: "local-direct" }));
      const members: ProductTaglineKoMember[] = items.map((item, index) => ({ productId: seed * 10 + index, slug: `total-bound-${seed * 10 + index}`,
        sourceIdentityHash: sha(`identity-${seed}-${index}`), sourceHash: productTaglineKoSourceHash(item), cache: { kind: "absent" } }));
      const logical = productTaglineKoLogicalWorkKey(members), inputHash = productTaglineKoInputHash({ members, model: MODEL });
      const request = base("product-tagline-ko", `${logical}:${inputHash}`, "text", "background");
      const reservation = granted(await requestProductTaglineKoModelSlot(request, members));
      const dispatch = await db.transaction(async tx => {
        const lock = await lockProductTaglineKoModelCapacityDispatch(tx, { reservation, identity: identity(request), members });
        if (!lock) throw new Error("lock_required");
        return finishProductTaglineKoModelCapacityDispatch(tx, lock, productTaglineKoDispatchBindingSchema.parse({ kind: "product_tagline_ko_gateway", version: 1,
          members, model: MODEL, logicalWorkKey: logical, inputHash, routeId: "product-tagline-ko", ...charge(call), job: job("product-tagline-ko"), role: textRole() }));
      });
      return { request, wireHash: call.wireHash, dispatch, send: sendOptions => translateTaglinesWithReservedGateway(items, dispatch, call, sendOptions),
        settle: terminal => reconcileProductTaglineKoGatewayTerminal(terminal as never) };
    } },
  { name: "crawl-tagline", routeId: "crawl-tagline", httpRejected: true, content: "Track expenses and budgets in one place",
    async start(seed, options = {}) {
      const evidence = taglineEvidence();
      const call = prepared(prepareCrawlTaglineGatewayCall(evidence, { model: MODEL, timeoutMs: options.timeoutMs ?? 5_000, provider: "local-direct" }));
      const input: CrawlTaglineInput = { member: { candidateId: seed, repo: `total-bound/project-${seed}`, sourceHash: taglineHash(evidence),
        candidateRowIdentityHash: sha(`candidate-${seed}`), documentRowIdentityHash: sha(`document-${seed}`), cache: { kind: "absent" } },
        model: MODEL, askOrdinal: 1, parent: null };
      const logical = crawlTaglineLogicalWorkKey(input), inputHash = crawlTaglineInputHash(input);
      const request = base("crawl-tagline", `${logical}:${inputHash}`, "text", "background");
      const reservation = granted(await requestCrawlTaglineModelSlot(request, input));
      const dispatch = await db.transaction(async tx => {
        const lock = await lockCrawlTaglineModelCapacityDispatch(tx, { reservation, identity: identity(request), input });
        if (!lock) throw new Error("lock_required");
        return finishCrawlTaglineModelCapacityDispatch(tx, lock, crawlTaglineDispatchBindingSchema.parse({ ...input, kind: "crawl_tagline_gateway", version: 1,
          generationHash: crawlTaglineGenerationHash(input), logicalWorkKey: logical, inputHash, routeId: "crawl-tagline", ...charge(call),
          job: job("crawl-tagline"), role: textRole() }));
      });
      return { request, wireHash: call.wireHash, dispatch, send: sendOptions => writeTaglineWithReservedGateway(evidence, dispatch, call, sendOptions),
        settle: terminal => reconcileCrawlTaglineGatewayTerminal(terminal as never) };
    } },
  { name: "search-query-translate", routeId: "search-query-translate", httpRejected: true, content: "budget app | expense tracker",
    async start(seed, options = {}) {
      const query = { ...queryInput(), query: `가계부 앱 ${seed}` };
      const call = prepared(prepareWebsearchQueryGatewayCall(query, { model: MODEL, timeoutMs: options.timeoutMs ?? 5_000, provider: "local-direct" }));
      const input: WebsearchQueryInput = { member: { cacheKey: sha(`cache-${seed}`), sourceLocale: "ko", queryHash: sha(query.query), promptVersion: 1,
        glossaryVersion: null, cache: { kind: "absent" } }, model: MODEL };
      const logical = websearchQueryLogicalWorkKey(input.member), inputHash = websearchQueryInputHash(input);
      const request = base("search-query-translate", `${logical}:${inputHash}`, "text", "background");
      const reservation = granted(await requestWebsearchQueryModelSlot(request, input));
      const dispatch = await db.transaction(async tx => {
        const lock = await lockWebsearchQueryModelCapacityDispatch(tx, { reservation, identity: identity(request), input });
        if (!lock) throw new Error("lock_required");
        return finishWebsearchQueryModelCapacityDispatch(tx, lock, websearchQueryDispatchBindingSchema.parse({ ...input, kind: "websearch_query_gateway", version: 1,
          logicalWorkKey: logical, inputHash, routeId: "search-query-translate", ...charge(call),
          process: { instanceId: owner.instanceId, bootId: owner.bootId, release: "total-bound-fixture" } }));
      });
      return { request, wireHash: call.wireHash, dispatch, send: sendOptions => translateQueryWithReservedGateway(query, dispatch, call, sendOptions),
        settle: terminal => reconcileWebsearchQueryGatewayTerminal(terminal as never) };
    } },
  classifyFlow("crawl-publish-classify", "local-direct", MODEL),
];

const row = async (requestId: string) => (await client`SELECT to_jsonb(r) AS value FROM model_capacity_requests r WHERE request_id=${requestId}::uuid`)[0]?.value as
  Record<string, unknown> & { terminal_evidence: Record<string, unknown> | null; dispatch_binding: Record<string, unknown> | null };
const events = async (requestId: string) => (await client`SELECT kind FROM model_capacity_events WHERE request_id=${requestId}::uuid ORDER BY id`).map(event => event.kind as string);
const chats = () => engine.requests.filter(request => request.path === "/v1/chat/completions");
const aborted = () => { const controller = new AbortController(); controller.abort(); return controller.signal; };
/**
 * 카테고리 분류 API kind 의 로컬 종료 회수: 장부 guard 가 받지 않아(0166 가지는 종료 근거로 terminal·not_started·operator_review 만 연다) 회수 TX 가
 * 23514 로 되돌려지고 행은 미확정 그대로 남는다. 닫는 길은 운영자 검토다. provider 글자와 무관하다.
 */
async function expectReleaseRefused(started: Started, release: () => Promise<unknown>) {
  await expect(release()).rejects.toMatchObject({ cause: { code: "23514", constraint_name: "model_capacity_requests_dispatch_check" } });
  expect(await row(started.request.requestId)).toMatchObject({ state: "indeterminate", terminal_evidence: null });
  expect(await closeModelCapacityUnknownReview({ requestId: started.request.requestId, operator, note: "fixture release refused" })).toMatchObject({ kind: "reviewed" });
  expect(await events(started.request.requestId)).toEqual(["queued", "reserved", "dispatch_started", "dispatch_indeterminate", "dispatch_local_ended", "dispatch_reviewed"]);
}

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrate(drizzle(client), { migrationsFolder: path.join(path.resolve("."), "drizzle") });
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
  await client`UPDATE model_capacity_control SET mode='open', policy=${JSON.stringify(policy)}::jsonb, policy_hash=${modelCapacityPolicyHash(policy)},
    revision=revision+1, cursor=0, updated_at=clock_timestamp() WHERE id=1`;
  await client`UPDATE pipeline_stage_modes SET mode='items', writer_contract_version=1, draining_from=NULL, updated_at=clock_timestamp() WHERE stage IN ('ai1','ai2')`;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("local_address");
  origin = `http://127.0.0.1:${address.port}`;
}, 240_000);
afterEach(() => { engine.mode = "ok"; engine.tokens = 90; engine.requests.length = 0; vi.unstubAllEnvs(); setServingContractSnapshotForTest(null); });
afterAll(async () => {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  await client.end({ timeout: 3 }); if (created) await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end({ timeout: 3 });
});

describe.each(FLOWS.map(flow => [flow.name, flow] as const))("%s", (_name, flow) => {
  it("queues, reserves, dispatches as local-direct, sends the prepared bytes without the strict-terminal header and settles the engine's terminal", async () => {
    pinContracts(); engine.content = flow.content;
    const started = await flow.start(++serial);
    expect(await row(started.request.requestId)).toMatchObject({ state: "dispatched", route_id: flow.routeId, provider: "local-direct", model: MODEL,
      provider_budget_id: BUDGET, group_id: DEVICE, dispatch_binding: { provider: "local-direct", routeId: flow.routeId, chargedTokens: 65_536 },
      dispatch_binding_hash: started.dispatch.bindingHash });
    const sent = await started.send();
    expect(sent.terminal).not.toBeNull(); expect(sent.notStarted).toBeUndefined(); expect(sent.rejected).toBeUndefined();
    // 엔진이 받은 요청: 준비한 wire 바이트 그대로(= 같은 엔진의 abcllm 계약이 보내는 바이트 — 단위 시험이 두 wireHash 가 같음을 본다), tokenizer 호출 없음
    expect(engine.requests.map(request => request.path)).toEqual(["/v1/chat/completions"]);
    expect(sha(chats()[0].body)).toBe(started.wireHash);
    expect(chats()[0].headers["x-abcllm-strict-terminal"]).toBeUndefined(); expect(chats()[0].headers.authorization).toBeUndefined();
    expect(await started.settle(sent.terminal!)).toEqual({ kind: "settled" });
    expect(await started.settle(sent.terminal!)).toEqual({ kind: "already_settled" });
    expect(await row(started.request.requestId)).toMatchObject({ state: "settled", provider: "local-direct", terminal_evidence: { provenance: "upstream_reported",
      actualUsage: { inputTokens: 90, outputTokens: 20, totalTokens: 110 }, dispatch: { requestId: started.request.requestId, binding: { provider: "local-direct" } } } });
    expect(await events(started.request.requestId)).toEqual(["queued", "reserved", "dispatch_started", "dispatch_settled"]);
  });

  it("settles a call that never left as gateway_not_started", async () => {
    pinContracts();
    const started = await flow.start(++serial), sent = await started.send({ signal: aborted() });
    expect(sent.terminal).toBeNull(); expect(sent.notStarted).toBeDefined(); expect(engine.requests).toEqual([]);
    expect(await reconcileGatewayNotStarted(sent.notStarted!)).toEqual({ kind: "settled" });
    expect(await row(started.request.requestId)).toMatchObject({ state: "settled", terminal_evidence: { kind: "gateway_not_started",
      dispatch: { requestId: started.request.requestId, binding: { provider: "local-direct", chargedTokens: 65_536 } } } });
    expect(await events(started.request.requestId)).toEqual(["queued", "reserved", "dispatch_started", "dispatch_settled"]);
  });

  it(flow.httpRejected ? "settles an HTTP 429 as gateway_http_rejected" : "leaves an HTTP 429 indeterminate (this route issues no rejection witness) for operator review", async () => {
    pinContracts(); engine.mode = 429;
    const started = await flow.start(++serial), sent = await started.send();
    expect(sent.terminal).toBeNull(); expect(sent.notStarted).toBeUndefined(); expect(chats()).toHaveLength(1);
    if (flow.httpRejected) {
      expect(sent.rejected).toBeDefined();
      expect(await reconcileGatewayHttpRejected(sent.rejected!)).toEqual({ kind: "settled" });
      expect(await row(started.request.requestId)).toMatchObject({ state: "settled", terminal_evidence: { kind: "gateway_http_rejected", status: 429,
        retryAfterMs: 2_000, dispatch: { requestId: started.request.requestId, binding: { provider: "local-direct" } } } });
      expect(await events(started.request.requestId)).toEqual(["queued", "reserved", "dispatch_started", "dispatch_settled"]);
    } else {
      expect(sent.rejected).toBeUndefined();
      expect(await markModelDispatchIndeterminate(started.dispatch, "transport_unknown")).toBe(true);
      expect(await row(started.request.requestId)).toMatchObject({ state: "indeterminate", terminal_evidence: null });
      expect(await closeModelCapacityUnknownReview({ requestId: started.request.requestId, operator, note: "fixture 429" })).toMatchObject({ kind: "reviewed" });
      expect(await events(started.request.requestId)).toEqual(["queued", "reserved", "dispatch_started", "dispatch_indeterminate", "dispatch_reviewed"]);
    }
  });

  it("marks a timed-out call indeterminate, records its local end and releases it with local_call_ended evidence", async () => {
    pinContracts(); engine.mode = "hang"; vi.stubEnv("MODEL_CAPACITY_LOCAL_END", "1");
    const started = await flow.start(++serial, { timeoutMs: 300 }), sent = await started.send({ timeoutMs: 300 });
    expect(sent.terminal).toBeNull(); expect(sent.notStarted).toBeUndefined(); expect(sent.rejected).toBeUndefined(); expect(chats()).toHaveLength(1);
    expect(await markModelDispatchIndeterminate(started.dispatch, "client_timeout")).toBe(true);
    const before = await row(started.request.requestId);
    expect(before).toMatchObject({ state: "indeterminate", provider: "local-direct", terminal_evidence: null });
    expect(await events(started.request.requestId)).toEqual(["queued", "reserved", "dispatch_started", "dispatch_indeterminate", "dispatch_local_ended"]);
    const release = () => releaseEvidencedDispatches({ policies: new Map([[BUDGET, { termination: "client_bound" as const, hardDeadlineMs: null, skewBoundMs: 1, reference }]]),
      operator }, true);
    if (flow.releasable === false) {
      await expectReleaseRefused(started, release);
      return;
    }
    const released = await release();
    expect(released.rows.find(item => item.requestId === started.request.requestId)).toEqual({ requestId: started.request.requestId, released: true, reason: null });
    // 회수는 점유만 푼다: dispatch binding(C)은 그대로이고 정산·사용량 증거는 없다
    expect(await row(started.request.requestId)).toMatchObject({ state: "withdrawn", settled_at: null, dispatch_binding: before.dispatch_binding,
      terminal_evidence: { kind: "local_call_ended", requestId: started.request.requestId, fromState: "indeterminate", termination: "client_bound",
        localEnd: { dispatches: 1, terminals: 1 } } });
    expect(await events(started.request.requestId)).toEqual(["queued", "reserved", "dispatch_started", "dispatch_indeterminate", "dispatch_local_ended", "dispatch_released"]);
  });

  it("closes an indeterminate call (HTTP 500) by operator review", async () => {
    pinContracts(); engine.mode = 500;
    const started = await flow.start(++serial), sent = await started.send();
    expect(sent.terminal).toBeNull(); expect(sent.notStarted).toBeUndefined(); expect(sent.rejected).toBeUndefined(); expect(chats()).toHaveLength(1);
    expect(await markModelDispatchIndeterminate(started.dispatch, "transport_unknown")).toBe(true);
    expect(await closeModelCapacityUnknownReview({ requestId: started.request.requestId, operator, note: "fixture 500" })).toMatchObject({ kind: "reviewed",
      evidence: { kind: "operator_review", requestId: started.request.requestId, fromState: "indeterminate" } });
    expect(await row(started.request.requestId)).toMatchObject({ state: "withdrawn", provider: "local-direct", terminal_evidence: { kind: "operator_review", operator } });
    expect(await events(started.request.requestId)).toEqual(["queued", "reserved", "dispatch_started", "dispatch_indeterminate", "dispatch_reviewed"]);
  });
});

describe("queue, tokenizer block and old-provider requests", () => {
  const reason = FLOWS.find(flow => flow.name === "reason-translate")!, profile = FLOWS.find(flow => flow.name === "product-search-profile")!;

  it("a second request waits in the queue while the device is full and is reserved once the first call settles", async () => {
    pinContracts(); engine.content = reason.content;
    const first = await reason.start(++serial, { model: SINGLE });
    // 같은 장비(칸 1)의 둘째 요청은 줄에 선다 — 장부 행은 waiting, provider 는 local-direct
    const texts = [`A second reason waits (${++serial}).`], members: ReasonTranslationMember[] = texts.map(text => ({ sourceHash: textHash(text), cache: { kind: "absent" } }));
    const logical = reasonTranslationLogicalWorkKey(members), inputHash = reasonTranslationInputHash({ members, model: SINGLE });
    const waiting = base("reason-translate", `${logical}:${inputHash}`, "text", "background", SINGLE);
    expect(await requestReasonTranslationModelSlot(waiting, members)).toEqual({ kind: "deferred", reason: "capacity" });
    expect(await row(waiting.requestId)).toMatchObject({ state: "waiting", provider: "local-direct", group_id: "device-single" });
    const sent = await first.send();
    expect(await first.settle(sent.terminal!)).toEqual({ kind: "settled" });
    const reservation = granted(await requestReasonTranslationModelSlot(waiting, members));
    const call = prepared(prepareReasonTranslationGatewayCall(texts, { model: SINGLE, timeoutMs: 5_000, provider: "local-direct" }));
    const dispatch = await db.transaction(async tx => {
      const lock = await lockReasonTranslationModelCapacityDispatch(tx, { reservation, identity: identity(waiting), members });
      if (!lock) throw new Error("lock_required");
      return finishReasonTranslationModelCapacityDispatch(tx, lock, reasonTranslationDispatchBindingSchema.parse({ kind: "reason_translation_gateway", version: 1,
        members, model: SINGLE, logicalWorkKey: logical, inputHash, routeId: "reason-translate", ...charge(call), job: job("reason-translate"), role: textRole() }));
    });
    engine.content = JSON.stringify(["두 번째 사유"]);
    const second = await translateWithReservedReasonGateway(texts, dispatch, call);
    expect(await reconcileReasonTranslationGatewayTerminal(second.terminal!)).toEqual({ kind: "settled" });
    expect(await events(waiting.requestId)).toEqual(["queued", "reserved", "dispatch_started", "dispatch_settled"]);
  });

  it("with a tokenizer block the engine tokenizer is asked first; a request past the bound is never sent and settles as not started", async () => {
    pinContracts({ "product-search-profile": { tokenizer: { endpoint: `${origin}/tokenize`, requestTokenBound: 32_000 } } }); engine.content = profile.content;
    const within = await profile.start(++serial), sent = await within.send();
    expect(engine.requests.map(request => request.path)).toEqual(["/tokenize", "/v1/chat/completions"]);
    // tokenizer 에는 보낸 wire 의 messages·chat_template_kwargs 가 그대로 간다(wire 를 바꾸지 않는다)
    const wire = JSON.parse(chats()[0].body), asked = JSON.parse(engine.requests[0].body);
    expect(asked).toEqual({ model: MODEL, messages: wire.messages, add_generation_prompt: true, chat_template_kwargs: wire.chat_template_kwargs });
    expect(sha(chats()[0].body)).toBe(within.wireHash);
    expect(await within.settle(sent.terminal!)).toEqual({ kind: "settled" });
    engine.requests.length = 0; engine.tokens = 32_000;
    const over = await profile.start(++serial), refused = await over.send();
    expect(refused).toMatchObject({ result: { ok: false, error: "input_too_large" }, terminal: null });
    expect(engine.requests.map(request => request.path)).toEqual(["/tokenize"]);
    expect(await reconcileGatewayNotStarted(refused.notStarted!)).toEqual({ kind: "settled" });
    expect(await row(over.request.requestId)).toMatchObject({ state: "settled", terminal_evidence: { kind: "gateway_not_started" } });
  });

  it("the publication-classify release gap is the same under today's abcllm contract (not a provider difference)", async () => {
    pinContracts(); engine.mode = "hang"; vi.stubEnv("MODEL_CAPACITY_LOCAL_END", "1");
    const old = classifyFlow("crawl-publish-classify (abcllm contract)", "abcllm", OLD_SHAPE);
    const started = await old.start(++serial, { timeoutMs: 300 }), sent = await started.send();
    expect(sent.terminal).toBeNull(); expect(sent.notStarted).toBeUndefined();
    expect(await markModelDispatchIndeterminate(started.dispatch, "client_timeout")).toBe(true);
    expect(await row(started.request.requestId)).toMatchObject({ state: "indeterminate", provider: "abcllm", dispatch_binding: { provider: "abcllm" } });
    await expectReleaseRefused(started, () => releaseEvidencedDispatches({ policies: new Map([[BUDGET, { termination: "client_bound" as const, hardDeadlineMs: null,
      skewBoundMs: 1, reference }]]), operator }, true));
  });

  it("a request queued under the old provider is refused the new contract before anything is sent", async () => {
    pinContracts();
    // 계약을 새 모양으로 바꾼 뒤 abcllm 으로 준비하면 닫힌다(provider_contract_unavailable) — 옛 provider 요청은 보내지지 않는다
    expect(prepareReasonTranslationGatewayCall(reasonTexts(), { model: MODEL, timeoutMs: 5_000, provider: "abcllm" }))
      .toEqual({ kind: "unsupported", reason: "provider_contract_unavailable" });
    // 장부도 abcllm identity 를 이 정책(local-direct route 뿐)에서 받지 않는다 — 행이 생기지 않는다
    const texts = [`An old-provider reason (${++serial}).`], members: ReasonTranslationMember[] = texts.map(text => ({ sourceHash: textHash(text), cache: { kind: "absent" } }));
    const stale = { ...base("reason-translate", `${reasonTranslationLogicalWorkKey(members)}:${reasonTranslationInputHash({ members, model: MODEL })}`, "text", "background"),
      provider: "abcllm" };
    expect(await requestReasonTranslationModelSlot(stale, members)).toMatchObject({ kind: "deferred" });
    expect(await row(stale.requestId)).toBeUndefined();
    expect(engine.requests).toEqual([]);
  });
});
