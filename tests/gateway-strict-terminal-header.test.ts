import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { productTaglineKoGatewayWire, productTaglineKoSourceHash, productTranslationGatewayWire, reasonTranslationGatewayWire,
  textHash, translateChineseQueryToEnglish, translateProductFields, translateQueryToEnglish, translateTaglinesToKorean, translateToKorean,
  websearchQueryGatewayWire } from "@/lib/crawl/translate";
import { productTranslationSourceHash } from "@/lib/domain/products/translation-policy";
import { productTaglineKoDispatchBindingHash, productTaglineKoInputHash, productTaglineKoLogicalWorkKey, productTaglineKoModelDispatchSchema,
  productTranslationDispatchBindingHash, productTranslationInputHash, productTranslationLogicalWorkKey, productTranslationModelDispatchSchema,
  reasonTranslationDispatchBindingHash, reasonTranslationInputHash, reasonTranslationLogicalWorkKey, reasonTranslationModelDispatchSchema,
  websearchQueryDispatchBindingHash, websearchQueryInputHash, websearchQueryLogicalWorkKey, websearchQueryModelDispatchSchema,
  type WebsearchQueryInput } from "@/lib/llm/capacity";
import { prepareProductTaglineKoGatewayCall, prepareProductTranslationGatewayCall, prepareReasonTranslationGatewayCall,
  prepareWebsearchQueryGatewayCall, translateProductFieldsWithReservedGateway, translateQueryWithReservedGateway,
  translateTaglinesWithReservedGateway, translateWithReservedReasonGateway, readReasonTranslationGatewayTerminal,
  readProductTranslationGatewayTerminal, readProductTaglineKoGatewayTerminal, readWebsearchQueryGatewayTerminal } from "@/lib/crawl/agent-review-gateway";
import { reasonTranslationServingContractHash } from "@/lib/llm/reason-translation-serving-contract";
import { productTranslationServingContractHash } from "@/lib/llm/product-translation-serving-contract";
import { productTaglineKoServingContractHash } from "@/lib/llm/product-tagline-ko-serving-contract";
import { websearchQueryServingContractHash } from "@/lib/llm/websearch-query-serving-contract";

const fixture = vi.hoisted(() => ({ contracts: {} as Record<string, unknown> }));
vi.mock("@/lib/llm/reason-translation-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/reason-translation-serving-contract")>(),
  resolveReasonTranslationServingContract: () => fixture.contracts["reason-translate"] ?? null }));
vi.mock("@/lib/llm/product-translation-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/product-translation-serving-contract")>(),
  resolveProductTranslationServingContract: () => fixture.contracts["product-translate"] ?? null }));
vi.mock("@/lib/llm/product-tagline-ko-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/product-tagline-ko-serving-contract")>(),
  resolveProductTaglineKoServingContract: () => fixture.contracts["product-tagline-ko"] ?? null }));
vi.mock("@/lib/llm/websearch-query-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/websearch-query-serving-contract")>(),
  resolveWebsearchQueryServingContract: () => fixture.contracts["search-query-translate"] ?? null }));
vi.mock("@/lib/llm/text-capacity-admission", () => ({ assertTextModelAdmission: vi.fn() }));

const model = "strict-header-model", HEADER = "x-abcllm-strict-terminal";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const role = () => ({ role: "text" as const, instanceId: "strict-header-unit", bootId: randomUUID(), release: "local-only",
  kind: "primary" as const, epoch: 1, batch: { mode: "legacy" as const } });
const envelope = (content: string, change: Record<string, unknown> = {}) => JSON.stringify({ id: "strict-local", object: "chat.completion",
  created: 1, model: "served-strict", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }, usage_provenance: "upstream_reported", ...change });
type Call = { kind: "prepared"; wireHash: string; servingContractHash: string; totalTokenBound: number; model: string };
type Kind = { route: string; protocol: string; content: string; wire: () => string; hash: (value: never) => string;
  prepare: () => { kind: string }; send: (call: Call) => Promise<{ result: unknown; terminal: unknown }>; read: (terminal: unknown) => unknown };
const texts = ["Repository has no visible deployment evidence."];
const products = [{ name: "Toolkit", locale: "en" as const, field: "tagline" as const, text: "Toolkit은 문서 정리를 돕는 도구입니다" }];
const taglines = [{ name: "Toolkit", tagline: "Toolkit helps organize documents" }];
const query = { sourceLocale: "ko" as const, query: "헬스장 출석 체크" };
// 네 dispatch 는 모양 fixture 다 — 실제 장부 발급·정산은 각 ledger 테스트가 본다
function binding(call: Call, route: string) {
  return { model, routeId: route, provider: "abcllm" as const, wireHash: call.wireHash, servingContractHash: call.servingContractHash,
    totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound };
}
const job = (name: string) => ({ name, token: randomUUID(), requestedVersion: 1 });
function owned<T extends { role?: { instanceId: string; bootId: string }; process?: { instanceId: string; bootId: string } }>(value: T, hash: (value: never) => string) {
  const owner = value.role ?? value.process!;
  return { requestId: randomUUID(), owner: { instanceId: owner.instanceId, bootId: owner.bootId }, token: randomUUID(), epoch: 1, revision: 1,
    policyHash: "a".repeat(64), binding: value, bindingHash: hash(value as never) };
}
const KINDS: Kind[] = [
  { route: "reason-translate", protocol: "abcllm-reason-total-bound-v1", content: JSON.stringify(["저장소에 배포 근거가 없습니다"]),
    wire: () => reasonTranslationGatewayWire(texts, model), hash: reasonTranslationServingContractHash, read: readReasonTranslationGatewayTerminal,
    prepare: () => prepareReasonTranslationGatewayCall(texts, { model, timeoutMs: 1000 }),
    send: call => {
      const members = texts.map(text => ({ sourceHash: textHash(text), cache: { kind: "absent" as const } }));
      const value = { ...binding(call, "reason-translate"), job: job("reason-translate"), kind: "reason_translation_gateway", version: 1, members,
        inputHash: reasonTranslationInputHash({ members, model }), logicalWorkKey: reasonTranslationLogicalWorkKey(members), role: role() };
      return translateWithReservedReasonGateway(texts, reasonTranslationModelDispatchSchema.parse(owned(value, reasonTranslationDispatchBindingHash)), call as never);
    } },
  { route: "product-translate", protocol: "abcllm-product-translation-total-bound-v1", content: JSON.stringify(["Toolkit helps organize documents"]),
    wire: () => productTranslationGatewayWire(products, model), hash: productTranslationServingContractHash, read: readProductTranslationGatewayTerminal,
    prepare: () => prepareProductTranslationGatewayCall(products, { model, timeoutMs: 1000 }),
    send: call => {
      const members = products.map(item => ({ productId: 101, slug: "strict-product-101", locale: item.locale, field: item.field,
        sourceHash: productTranslationSourceHash({ id: 101, name: item.name, tagline: item.text, description: "" }, item.field),
        demand: { rowIdentityHash: "d".repeat(64), attempts: 0 } }));
      const value = { ...binding(call, "product-translate"), job: job("product-translate"), kind: "product_translation_gateway", version: 1, members,
        inputHash: productTranslationInputHash({ members, model }), logicalWorkKey: productTranslationLogicalWorkKey(members), role: role() };
      return translateProductFieldsWithReservedGateway(products, productTranslationModelDispatchSchema.parse(owned(value, productTranslationDispatchBindingHash)), call as never);
    } },
  { route: "product-tagline-ko", protocol: "abcllm-product-tagline-ko-total-bound-v1", content: JSON.stringify(["Toolkit으로 문서를 정리하는 도구"]),
    wire: () => productTaglineKoGatewayWire(taglines, model), hash: productTaglineKoServingContractHash, read: readProductTaglineKoGatewayTerminal,
    prepare: () => prepareProductTaglineKoGatewayCall(taglines, { model, timeoutMs: 1000 }),
    send: call => {
      const members = taglines.map(item => ({ productId: 101, slug: "strict-tagline-101", sourceIdentityHash: "c".repeat(64),
        sourceHash: productTaglineKoSourceHash(item), cache: { kind: "absent" as const } }));
      const value = { ...binding(call, "product-tagline-ko"), job: job("product-tagline-ko"), kind: "product_tagline_ko_gateway", version: 1, members,
        inputHash: productTaglineKoInputHash({ members, model }), logicalWorkKey: productTaglineKoLogicalWorkKey(members), role: role() };
      return translateTaglinesWithReservedGateway(taglines, productTaglineKoModelDispatchSchema.parse(owned(value, productTaglineKoDispatchBindingHash)), call as never);
    } },
  { route: "search-query-translate", protocol: "abcllm-websearch-query-total-bound-v1", content: "Gym attendance | gym attendance check-in app",
    wire: () => websearchQueryGatewayWire(query, model), hash: websearchQueryServingContractHash, read: readWebsearchQueryGatewayTerminal,
    prepare: () => prepareWebsearchQueryGatewayCall(query, { model, timeoutMs: 1000 }),
    send: call => {
      const input: WebsearchQueryInput = { model, member: { cacheKey: "e".repeat(64), sourceLocale: "ko", queryHash: textHash(query.query),
        promptVersion: 2, glossaryVersion: 1, cache: { kind: "absent" } } };
      const process = { instanceId: "strict-header-unit", bootId: randomUUID(), release: "local-only" };
      const value = { ...input, ...binding(call, "search-query-translate"), kind: "websearch_query_gateway", version: 1, logicalWorkKey: websearchQueryLogicalWorkKey(input.member),
        inputHash: websearchQueryInputHash(input), process };
      return translateQueryWithReservedGateway(query, websearchQueryModelDispatchSchema.parse(owned(value, websearchQueryDispatchBindingHash)), call as never);
    } },
];
async function server(run: (state: { requests: { headers: IncomingHttpHeaders; body: string }[]; endpoint: string;
  reply: (content: string, change?: Record<string, unknown>) => void }) => Promise<void>) {
  const requests: { headers: IncomingHttpHeaders; body: string }[] = [];
  let content = "", change: Record<string, unknown> = {};
  const http = createServer((request, response) => {
    void (async () => { let body = ""; for await (const part of request) body += part.toString();
      requests.push({ headers: request.headers, body }); response.end(envelope(content, change)); })();
  });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  const address = http.address(); if (!address || typeof address === "string") throw new Error("fixture_address");
  try { await run({ requests, endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, reply: (next, nextChange = {}) => { content = next; change = nextChange; } }); }
  finally { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
}
// 운영 값이 아니다 — 로컬 서버를 가리키는 fixture 계약이다
const contract = (kind: Kind, endpoint: string, change: Record<string, unknown> = {}) => ({ version: 1, protocol: kind.protocol,
  routeId: kind.route, provider: "abcllm", model, responseModel: "served-strict", deploymentRevision: "local-only", endpoint,
  totalTokenBound: 8192, ...change });
afterEach(() => { fixture.contracts = {}; vi.unstubAllEnvs(); });

it("adds the PR3 strict terminal header only for an opted-in translation contract, leaving body and hashes intact", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-test-only");
  for (const kind of KINDS) await server(async ({ requests, endpoint, reply }) => {
    reply(kind.content);
    // 계약이 없으면 준비 자체가 없어 요청도 헤더도 없다
    expect(kind.prepare()).toEqual({ kind: "unsupported", reason: "provider_contract_unavailable" });
    const plain = contract(kind, endpoint), strict = contract(kind, endpoint, { strictTerminalOptIn: "abcllm-strict-terminal-v1" });
    const calls: Call[] = [];
    for (const value of [plain, strict]) {
      fixture.contracts[kind.route] = value;
      const call = kind.prepare() as Call; expect(call.kind).toBe("prepared"); calls.push(call);
      expect(call.servingContractHash).toBe(kind.hash(value as never));
      expect((await kind.send(call)).terminal).not.toBeNull();
    }
    expect(requests).toHaveLength(2);
    expect(requests[0].headers[HEADER]).toBeUndefined();
    expect(requests[1].headers[HEADER]).toBe("1");
    // 헤더는 본문 밖이다 — 두 요청의 본문과 wireHash 는 원래 wire 그대로 같다
    expect(requests.map(request => request.body)).toEqual([kind.wire(), kind.wire()]);
    expect(calls.map(call => call.wireHash)).toEqual([sha(kind.wire()), sha(kind.wire())]);
    // 헤더는 servingContractHash 계산에 들지 않는다(위: 각 호출 hash == 그 계약의 hash). opt-in 은 계약 표시로만 hash 를 가른다
    expect(calls[1].servingContractHash).not.toBe(calls[0].servingContractHash);
  });
});

it("accepts an opted-in translation terminal only with a PR3 usage_provenance, under the existing usage rule", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-test-only");
  const usage = { inputTokens: 80, outputTokens: 20, totalTokens: 100 }, unknown = { actualUsage: null, provenance: "unknown" };
  for (const kind of KINDS) await server(async ({ requests, endpoint, reply }) => {
    const ask = async (value: Record<string, unknown>, change: Record<string, unknown>) => {
      fixture.contracts[kind.route] = value; reply(kind.content, change);
      const call = kind.prepare() as Call; expect(call.kind).toBe("prepared");
      const outcome = await kind.send(call); return { outcome, proof: kind.read(outcome.terminal) };
    };
    const strict = contract(kind, endpoint, { strictTerminalOptIn: "abcllm-strict-terminal-v1" }), plain = contract(kind, endpoint);
    // PR3 엄격 응답이 아니면(키 없음·세 값 밖) terminal 이 아니다 — 기존 잘못된 native terminal 과 같이 invalid_output, 전체 C 유지
    for (const change of [{ usage_provenance: undefined }, { usage_provenance: null }, { usage_provenance: "" }, { usage_provenance: 1 },
      { usage_provenance: "UPSTREAM_REPORTED" }, { usage_provenance: "unknown" }, { usage_provenance: ["upstream_reported"] }]) {
      const { outcome, proof } = await ask(strict, change);
      expect(outcome).toEqual({ result: { ok: false, error: "invalid_output" }, terminal: null }); expect(proof).toBeNull();
    }
    // 세 값은 terminal 이다. 실제 usage 는 기존 규칙(upstream_reported·정수 셋·합 일치·C 이하)일 때만 쓰고 나머지는 unknown(전체 C)이다
    expect((await ask(strict, {})).proof).toMatchObject({ actualUsage: usage, provenance: "upstream_reported" });
    for (const usage_provenance of ["gateway_estimated", "missing_or_invalid"]) expect((await ask(strict, { usage_provenance })).proof).toMatchObject(unknown);
    expect((await ask(strict, { usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 99 } })).proof).toMatchObject(unknown);
    expect((await ask(strict, { usage: { prompt_tokens: 8000, completion_tokens: 193, total_tokens: 8193 } })).outcome.terminal).toBeNull();
    // opt-in 이 아닌 계약은 그대로다 — 키가 없어도 terminal(provenance unknown)이다
    expect((await ask(plain, { usage_provenance: undefined })).proof).toMatchObject(unknown);
    expect(requests.map(request => request.headers[HEADER])).toEqual([...Array(12).fill("1"), undefined]);
  });
});

it("never sends the strict terminal header from the legacy translation leaves", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-test-only");
  const seen: Record<string, string>[] = [];
  const request = (async (_url: unknown, init?: RequestInit) => { seen.push({ ...init?.headers as Record<string, string> });
    return new Response(envelope("[]")); }) as typeof fetch;
  await translateToKorean(texts, 1000, request);
  await translateProductFields(products, 1000, request);
  await translateTaglinesToKorean(taglines, 1000, request);
  await translateQueryToEnglish(query.query, 1000, request);
  await translateChineseQueryToEnglish("健身房签到", "zh-Hans", 1000, request);
  expect(seen).toHaveLength(5);
  for (const headers of seen) expect(Object.keys(headers)).toEqual(["Authorization", "Content-Type"]);
});
