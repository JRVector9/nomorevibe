import { contractReasoningReserve, directBudgetExceeded, directTextBudgetFailure, nativeTerminal, prepareAi1DirectCall, prepareAi1GatewayCall,
  prepareAi2GatewayCall, prepareCrawlTaglineGatewayCall, prepareProductTaglineKoGatewayCall, prepareProductTranslationGatewayCall,
  prepareReasonTranslationGatewayCall, prepareSearchVerifyGatewayCall, prepareTextProfileGatewayCall, prepareWebsearchQueryGatewayCall,
  reviewWithGateway, textWireFor, wireMaxTokens } from "@/lib/crawl/agent-review-gateway";
import type { ReviewInput } from "@/lib/crawl/agent-review-contract";
import type { AgentReviewResult } from "@/lib/crawl/agent-review";
import { OUTPUT_SCHEMA, parseCategories, promptFor, type ClassifyInput } from "@/lib/crawl/classify";
import { preparePublicationClassifyCall } from "@/lib/crawl/publication-classify-gateway";
import type { CategoryDefinitions } from "@/lib/crawl/settings-schema";
import { crawlTaglineGatewayWire, parseTagline, type TaglineEvidence } from "@/lib/crawl/tagline";
import { parseQueryTranslation, parseTranslations, productTaglineKoGatewayWire, productTranslationGatewayWire, reasonTranslationGatewayWire,
  websearchQueryGatewayWire, type ProductTaglineKoGatewayItem, type ProductTranslationGatewayItem, type WebsearchQueryGatewayInput } from "@/lib/crawl/translate";
import { checkKoreanTaglineOutput, parseKoreanTaglines } from "@/lib/domain/products/korean-tagline";
import { keywordText, parseProfileGatewayBody, profileGatewayWire, type ProfileEvidence } from "@/lib/domain/products/search-profile";
import { parseVerification, searchVerifyGatewayWire, type VerifyItem } from "@/lib/domain/products/search-verify";
import { checkProductTranslation, type ProductTranslationSource } from "@/lib/domain/products/translation-policy";
import { isTotalBoundDirectContract } from "@/lib/llm/direct-serving-contract";
import { ABCLLM_STRICT_TERMINAL_HEADER, ABCLLM_STRICT_TERMINAL_OPT_IN } from "@/lib/llm/gateway-serving-contract-config";
import { modelCallTimeoutMs, modelRouteTimeoutMs } from "@/lib/llm/model-registry";
import { SHAPE_COMPARE_LIMITS, truncateText, type CallUsage, type CompareRoute } from "./contract-shape-compare";

/**
 * 계약 모양 견줌(contract-shape-compare.ts)의 경로별 부분 — 그 경로 자신의 wire 함수·준비 함수·검사기를 그대로 쓴다. DB 를 읽지 않고, 네트워크는
 * 실제 준비 함수가 부르는 엔진 tokenizer(2차 requestBudget·tokenizer 묶음)와 text 경로의 보내기 전 tokenizer 확인(directTextBudgetFailure)뿐이다.
 *
 * - wire: text 경로는 준비 함수와 같은 textWireFor(계약, 장부 이름, 경로의 wire 함수). 심사 두 경로는 게이트웨이 raw 심사 wire(비공개 함수)를
 *   reviewWithGateway 가 보내는 본문으로 받고, 준비 함수와 같은 규칙(2차 requestBudget·새 모양의 context_strategy 빼기·maxOutputTokens)을 얹는다.
 *   카테고리 분류의 wire 함수는 비공개라 같은 바이트를 여기 적었다. 어느 쪽이든 보내기 전에 실제 준비 함수의 wireHash 와 견주고(preparedWireHash),
 *   다르면 보내지 않는다 — 그래서 여기 적은 규칙이 경로와 어긋나도 경로가 보내지 않는 바이트는 나가지 않는다.
 * - 검사: 경로의 전송 함수가 응답에 하는 것과 같은 순서 — HTTP 200 → nativeTerminal(엔진 직접) → 요청 상한(directBudgetExceeded, 2차는 그 함수의 규칙)
 *   → 경로의 출력 파서(와 잡이 항목마다 거는 검사기 — 한국어 소개·공개 번역).
 */
export type SampleInput =
  | Readonly<{ kind: "review"; input: ReviewInput }>
  | Readonly<{ kind: "profile"; evidence: ProfileEvidence }>
  | Readonly<{ kind: "verify"; item: VerifyItem }>
  | Readonly<{ kind: "crawl-tagline"; evidence: TaglineEvidence }>
  | Readonly<{ kind: "reasons"; texts: readonly string[] }>
  | Readonly<{ kind: "product-translate"; items: readonly ProductTranslationGatewayItem[]; sources: readonly ProductTranslationSource[] }>
  | Readonly<{ kind: "tagline-ko"; items: readonly ProductTaglineKoGatewayItem[] }>
  | Readonly<{ kind: "query"; input: WebsearchQueryGatewayInput }>
  | Readonly<{ kind: "classify"; payload: Readonly<{ inputs: ClassifyInput[]; definitions: CategoryDefinitions }> }>;
export const ROUTE_SAMPLE_KIND: Readonly<Record<CompareRoute, SampleInput["kind"]>> = Object.freeze({
  "crawl-agent-review": "review", "second-review": "review", "product-search-profile": "profile", "product-search-verify": "verify",
  "crawl-tagline": "crawl-tagline", "reason-translate": "reasons", "product-translate": "product-translate", "product-tagline-ko": "tagline-ko",
  "search-query-translate": "query", "crawl-publish-classify": "classify" });
/** 경로 스키마로 검사한 계약(validateAdminServingContract·totalBoundContractFromAbcllm 의 결과) */
export type ParsedContract = Readonly<Record<string, unknown>> & { model: string };
type TextContract = Parameters<typeof textWireFor>[0];
const asText = (contract: ParsedContract) => contract as unknown as TextContract;
const field = (contract: ParsedContract, name: string): unknown => contract[name];
const totalBound = (contract: ParsedContract): boolean => isTotalBoundDirectContract({ protocol: field(contract, "protocol") });

function need<K extends SampleInput["kind"]>(route: CompareRoute, sample: SampleInput, kind: K): Extract<SampleInput, { kind: K }> {
  if (ROUTE_SAMPLE_KIND[route] !== kind || sample.kind !== kind) throw new Error(`shape_compare_sample_mismatch:${route}`);
  return sample as Extract<SampleInput, { kind: K }>;
}

// ── wire ──────────────────────────────────────────────────────────────────────────────────────────────

const CAPTURE_BASE = "http://shape-compare.invalid/v1";
/**
 * 게이트웨이 raw 심사 wire(정책 글·스키마·온도·thinking 끔 — agent-review-gateway 의 비공개 gatewayWire)를 그 바이트 그대로 받는다:
 * reviewWithGateway 에 받아 적기만 하는 request 를 주면 보내려던 본문이 나온다(보내지 않는다). 시험(openai-chat-total-bound-contract)과 같은 방법이다.
 */
async function reviewGatewayBytes(input: ReviewInput, engine: string): Promise<string> {
  const box: { body: string | null } = { body: null };
  const capture = (async (_url: unknown, init?: RequestInit) => {
    box.body = typeof init?.body === "string" ? init.body : null;
    throw new Error("shape_compare_captured");
  }) as unknown as typeof fetch;
  await reviewWithGateway(input, { model: engine, endpoint: { baseUrl: CAPTURE_BASE, apiKey: null }, request: capture });
  if (box.body === null) throw new Error("shape_compare_review_wire_unavailable");
  return box.body;
}
/**
 * 심사 두 경로의 wire — 준비 함수의 규칙: 엔진 이름은 engineModel(없으면 model). abcllm 2차의 requestBudget 은 max_tokens 를 그 값으로, 새 모양은
 * context_strategy 만 빼고(D-6) maxOutputTokens 가 있으면 max_tokens 를 그 값으로.
 */
async function reviewWire(route: CompareRoute, contract: ParsedContract, input: ReviewInput): Promise<string> {
  const engineModel = field(contract, "engineModel");
  const base = await reviewGatewayBytes(input, typeof engineModel === "string" && engineModel ? engineModel : contract.model);
  const budget = field(contract, "requestBudget") as { maxOutputTokens?: unknown } | undefined;
  if (totalBound(contract)) {
    const body = JSON.parse(base) as Record<string, unknown>;
    delete body.context_strategy;
    const cap = field(contract, "maxOutputTokens");
    if (typeof cap === "number") body.max_tokens = cap;
    return JSON.stringify(body);
  }
  if (route === "second-review" && budget && typeof budget.maxOutputTokens === "number") {
    const body = JSON.parse(base) as Record<string, unknown>;
    body.max_tokens = budget.maxOutputTokens;
    return JSON.stringify(body);
  }
  return base;
}
/** 카테고리 분류 wire(publication-classify-gateway 의 비공개 wire 와 같은 바이트 — 실제 준비의 wireHash 로 확인한다) */
function classifyWire(payload: Readonly<{ inputs: ClassifyInput[]; definitions: CategoryDefinitions }>, model: string): string {
  return JSON.stringify({ model, stream: false, temperature: 0, max_tokens: 2000,
    messages: [{ role: "user", content: promptFor(payload.inputs, payload.definitions) }],
    response_format: { type: "json_schema", json_schema: { name: "publication_categories", strict: true, schema: OUTPUT_SCHEMA } } });
}

/** 이 계약(abcllm 이든 새 모양이든)으로 그 경로가 보내는 본문 바이트 */
export async function variantWire(route: CompareRoute, contract: ParsedContract, sample: SampleInput): Promise<string> {
  const model = contract.model, text = asText(contract);
  switch (ROUTE_SAMPLE_KIND[route]) {
    case "review": return reviewWire(route, contract, need(route, sample, "review").input);
    case "profile": { const { evidence } = need(route, sample, "profile"); return textWireFor(text, model, engine => profileGatewayWire(evidence, engine)); }
    case "verify": { const { item } = need(route, sample, "verify"); return textWireFor(text, model, engine => searchVerifyGatewayWire(item, engine)); }
    case "crawl-tagline": { const { evidence } = need(route, sample, "crawl-tagline"); return textWireFor(text, model, engine => crawlTaglineGatewayWire(evidence, engine)); }
    case "reasons": {
      const { texts } = need(route, sample, "reasons"), reserve = contractReasoningReserve(contract);
      return textWireFor(text, model, engine => reasonTranslationGatewayWire(texts, engine, reserve));
    }
    case "product-translate": { const { items } = need(route, sample, "product-translate"); return textWireFor(text, model, engine => productTranslationGatewayWire(items, engine)); }
    case "tagline-ko": {
      const { items } = need(route, sample, "tagline-ko"), reserve = contractReasoningReserve(contract);
      return textWireFor(text, model, engine => productTaglineKoGatewayWire(items, engine, reserve));
    }
    case "query": { const { input } = need(route, sample, "query"); return textWireFor(text, model, engine => websearchQueryGatewayWire(input, engine)); }
    case "classify": { const { payload } = need(route, sample, "classify"); return textWireFor(text, model, engine => classifyWire(payload, engine)); }
  }
}

/** Content-Type·Authorization 밖의 헤더 — 번역 4경로의 abcllm 계약이 엄격 terminal 표시를 가지면 그 헤더(전송 함수의 strictTerminalHeaders 와 같은 규칙) */
export function variantHeaders(route: CompareRoute, contract: ParsedContract): Record<string, string> {
  const strict = ["reason-translate", "product-translate", "product-tagline-ko", "search-query-translate"].includes(route)
    && field(contract, "strictTerminalOptIn") === ABCLLM_STRICT_TERMINAL_OPT_IN;
  return strict ? { [ABCLLM_STRICT_TERMINAL_HEADER]: "1" } : {};
}

/** 준비(심사)나 보내기 전 확인(text)이 엔진 tokenizer 를 부르는 계약인가 — 2차 abcllm 의 requestBudget, 새 모양의 tokenizer 묶음 */
export const variantNeedsTokenizer = (route: CompareRoute, contract: ParsedContract): boolean =>
  field(contract, "tokenizer") !== undefined || route === "second-review" && field(contract, "requestBudget") !== undefined;

/** 그 경로가 한 번 부르는 시간 — 심사는 review-gateway 의 모델 기한, text 는 경로 한도(없으면 120초) */
export function routeTimeoutMs(route: CompareRoute, model: string): number {
  if (route === "crawl-agent-review" || route === "second-review") return modelCallTimeoutMs("review-gateway", model);
  try { return modelRouteTimeoutMs(route); } catch { return 120_000; }
}

/**
 * 실제 준비 함수로 같은 입력을 준비해 그 wireHash 를 받는다(지금 계약 스냅숏 — 부르는 쪽이 견줄 계약을 고정해 둔다). provider 가 준비 함수를 고른다:
 * 1차는 abcllm → prepareAi1GatewayCall · local-direct → prepareAi1DirectCall(agent-review-model-capacity 와 같다), 나머지는 provider 를 넘긴다.
 * 준비가 닫으면 그 까닭. 장부·DB 를 건드리지 않는다(준비 호출은 한 번 쓰는 메모리 값이고 여기서는 쓰지 않는다).
 */
export async function preparedWireHash(route: CompareRoute, model: string, provider: "abcllm" | "local-direct", sample: SampleInput,
  timeoutMs: number): Promise<{ wireHash: string } | { refused: string }> {
  const text = { model, timeoutMs, provider };
  let call: { kind: "prepared"; wireHash: string } | { kind: "unsupported"; reason: string };
  switch (ROUTE_SAMPLE_KIND[route]) {
    case "review": {
      const { input } = need(route, sample, "review");
      call = route === "second-review" ? await prepareAi2GatewayCall(input, text)
        : provider === "local-direct" ? await prepareAi1DirectCall(input, { model, timeoutMs }) : prepareAi1GatewayCall(input, { model, timeoutMs });
      break;
    }
    case "profile": call = prepareTextProfileGatewayCall(need(route, sample, "profile").evidence, text); break;
    case "verify": call = prepareSearchVerifyGatewayCall(need(route, sample, "verify").item, text); break;
    case "crawl-tagline": call = prepareCrawlTaglineGatewayCall(need(route, sample, "crawl-tagline").evidence, text); break;
    case "reasons": call = prepareReasonTranslationGatewayCall(need(route, sample, "reasons").texts, text); break;
    case "product-translate": call = prepareProductTranslationGatewayCall(need(route, sample, "product-translate").items, text); break;
    case "tagline-ko": call = prepareProductTaglineKoGatewayCall(need(route, sample, "tagline-ko").items, text); break;
    case "query": call = prepareWebsearchQueryGatewayCall(need(route, sample, "query").input, text); break;
    case "classify": call = preparePublicationClassifyCall(need(route, sample, "classify").payload, text); break;
  }
  return call.kind === "prepared" ? { wireHash: call.wireHash } : { refused: call.reason };
}

/**
 * text 경로의 보내기 전 tokenizer 확인(전송 함수가 하는 directTextBudgetFailure 그대로 — 새 모양에 tokenizer 묶음이 있을 때만 부른다). 심사 두 경로는
 * 준비 함수가 이미 했다. 걸리면 그 까닭(input_too_large · tokenizer_unavailable), 아니면 null.
 */
export async function textPreflight(route: CompareRoute, contract: ParsedContract, wire: string, timeoutMs: number): Promise<string | null> {
  if (ROUTE_SAMPLE_KIND[route] === "review") return null;
  return directTextBudgetFailure(asText(contract), wire, { timeoutMs });
}

// ── 응답 검사 ─────────────────────────────────────────────────────────────────────────────────────────

export type Evaluation = Readonly<{ accepted: boolean; failure: string | null; decision: string | null; items: readonly string[];
  itemChecks: Readonly<{ passed: number; total: number }> | null; finishReason: string | null; usage: CallUsage | null }>;

const integer = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
/** 응답 봉투에서 끝난 까닭·사용량·첫 답의 글(검사와 무관하게 보고용) */
export function envelopeFacts(body: string): { finishReason: string | null; usage: CallUsage | null; content: string | null } {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return { finishReason: null, usage: null, content: null }; }
  const object = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const choices = Array.isArray(object.choices) ? object.choices : [];
  const choice = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : {};
  const message = choice.message && typeof choice.message === "object" ? choice.message as Record<string, unknown> : {};
  const usage = object.usage && typeof object.usage === "object" ? object.usage as Record<string, unknown> : null;
  const details = usage?.completion_tokens_details && typeof usage.completion_tokens_details === "object"
    ? usage.completion_tokens_details as Record<string, unknown> : {};
  return { finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    usage: usage ? Object.freeze({ input: integer(usage.prompt_tokens), output: integer(usage.completion_tokens), total: integer(usage.total_tokens),
      reasoning: integer(details.reasoning_tokens) }) : null,
    content: typeof message.content === "string" ? message.content : null };
}

/** 2차 전송 함수의 요청 상한 규칙(새 모양: tokenizer 묶음 + 보낸 max_tokens, abcllm: requestBudget), 나머지는 directBudgetExceeded */
function budgetExceeded(route: CompareRoute, contract: ParsedContract, wire: string, usage: { inputTokens: number; outputTokens: number } | null): boolean {
  if (route !== "second-review") return directBudgetExceeded(asText(contract), wireMaxTokens(wire), usage);
  const cap = wireMaxTokens(wire), tokenizer = field(contract, "tokenizer") as { requestTokenBound: number } | undefined;
  const budget = totalBound(contract) ? tokenizer && cap !== undefined ? { requestTokenBound: tokenizer.requestTokenBound, maxOutputTokens: cap } : undefined
    : field(contract, "requestBudget") as { requestTokenBound: number; maxOutputTokens: number } | undefined;
  return !!(budget && usage && (usage.inputTokens + budget.maxOutputTokens > budget.requestTokenBound || usage.outputTokens > budget.maxOutputTokens));
}

/** 심사 결과 파서 — reviewWithGateway 에 받은 본문을 돌려주는 request 를 주면 전송 함수의 마지막 단계(gatewayResult: 잘림·JSON·validateReviewOutcome)가 돈다 */
async function reviewParse(input: ReviewInput, body: string): Promise<AgentReviewResult> {
  const replay = (async () => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
  return reviewWithGateway(input, { model: "shape-compare-parse", endpoint: { baseUrl: CAPTURE_BASE, apiKey: null }, request: replay });
}

const clip = (text: string) => truncateText(text, SHAPE_COMPARE_LIMITS.recordChars);
/**
 * 받은 응답을 그 경로가 하는 대로 검사한다. 상태가 200 이 아니면 http_<상태>. 판정 경로는 decision, 글 경로는 items(항목마다, 잘라서)를 채운다.
 * 공개 번역·한국어 소개는 잡이 항목마다 거는 검사기도 돌려 itemChecks 에 센다(통과한 항목은 잡이 저장할 글, 아니면 원 출력).
 */
export async function evaluateResponse(route: CompareRoute, contract: ParsedContract, wire: string, sample: SampleInput,
  status: number, body: string): Promise<Evaluation> {
  const facts = envelopeFacts(body);
  const base = { finishReason: facts.finishReason, usage: facts.usage };
  const fail = (failure: string): Evaluation => Object.freeze({ ...base, accepted: false, failure, decision: null, items: Object.freeze([]), itemChecks: null });
  const pass = (value: { decision?: string | null; items: readonly string[]; itemChecks?: { passed: number; total: number } | null }): Evaluation =>
    Object.freeze({ ...base, accepted: true, failure: null, decision: value.decision ?? null, items: Object.freeze(value.items.map(clip)),
      itemChecks: value.itemChecks ? Object.freeze({ ...value.itemChecks }) : null });
  if (status !== 200) return fail(`http_${status}`);
  // 엔진 직접 계약(abcllm 의 transport direct · 새 모양)의 terminal 규칙 — 두 모양 모두 direct 로 검사한다(전송 함수의 directTransport 와 같다)
  const completed = nativeTerminal(body, contract as unknown as Parameters<typeof nativeTerminal>[1], true);
  if (!completed) return fail("invalid_native_terminal");
  if (budgetExceeded(route, contract, wire, completed.actualUsage)) return fail("request_token_bound_exceeded");
  const content = facts.content ?? "";
  switch (ROUTE_SAMPLE_KIND[route]) {
    case "review": {
      const result = await reviewParse(need(route, sample, "review").input, body);
      return result.ok ? pass({ decision: result.outcome.decision, items: [result.outcome.reason] })
        : fail(result.detail ? `${result.error}:${result.detail}` : result.error);
    }
    case "profile": {
      const result = parseProfileGatewayBody(body, need(route, sample, "profile").evidence.name);
      return result.ok ? pass({ items: [keywordText(result.en, result.ko) ?? ""] }) : fail(result.error);
    }
    case "verify": {
      try {
        const removed = parseVerification(need(route, sample, "verify").item.keywords, content);
        return pass({ decision: JSON.stringify([...removed].sort()), items: [removed.join(" · ")] });
      } catch { return fail("invalid_output"); }
    }
    case "crawl-tagline": {
      const result = parseTagline(content, need(route, sample, "crawl-tagline").evidence);
      return result.ok ? pass({ items: [result.tagline] }) : fail(result.error);
    }
    case "reasons": {
      const result = parseTranslations(content, [...need(route, sample, "reasons").texts]);
      return result.ok ? pass({ items: result.translations.map(item => item ?? "") }) : fail(result.error);
    }
    case "product-translate": {
      const { items, sources } = need(route, sample, "product-translate");
      const result = parseKoreanTaglines(content, items.length, items);
      if (!result.ok) return fail(result.error);
      const checks = result.outputs.map((output, index) => checkProductTranslation(output, sources[index], items[index].locale, items[index].field));
      return pass({ items: checks.map((check, index) => check.ok ? check.text : result.outputs[index]),
        itemChecks: { passed: checks.filter(check => check.ok).length, total: checks.length } });
    }
    case "tagline-ko": {
      const { items } = need(route, sample, "tagline-ko");
      const result = parseKoreanTaglines(content, items.length);
      if (!result.ok) return fail(result.error);
      const checks = result.outputs.map((output, index) => checkKoreanTaglineOutput(output, items[index]));
      return pass({ items: checks.map((check, index) => check.ok ? check.line : result.outputs[index]),
        itemChecks: { passed: checks.filter(check => check.ok).length, total: checks.length } });
    }
    case "query": {
      const keywords = parseQueryTranslation(content);
      return keywords ? pass({ items: [keywords] }) : fail("invalid_output");
    }
    case "classify": {
      const { payload } = need(route, sample, "classify");
      if (completed.finishReason !== "stop") return fail(`finish_${completed.finishReason}`);
      const parsed = parseCategories({ kind: "exit", code: 0, stdout: content, stderr: "" }, payload.inputs.length);
      return parsed ? pass({ decision: parsed.map(item => item.category).join(","), items: parsed.map(item => item.category) }) : fail("invalid_output");
    }
  }
}
