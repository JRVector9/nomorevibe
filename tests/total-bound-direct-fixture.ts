import { createReviewInput, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { prepareAi1DirectCall, prepareAi1GatewayCall, prepareAi2GatewayCall, prepareCrawlTaglineGatewayCall, prepareProductTaglineKoGatewayCall,
  prepareProductTranslationGatewayCall, prepareReasonTranslationGatewayCall, prepareSearchVerifyGatewayCall, prepareTextProfileGatewayCall,
  prepareWebsearchQueryGatewayCall } from "@/lib/crawl/agent-review-gateway";
import type { ClassifyInput } from "@/lib/crawl/classify";
import { preparePublicationClassifyCall } from "@/lib/crawl/publication-classify-gateway";
import { DEFAULT_CATEGORY_DEFINITIONS, DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { TaglineEvidence } from "@/lib/crawl/tagline";
import type { ProductTaglineKoGatewayItem, ProductTranslationGatewayItem, WebsearchQueryGatewayInput } from "@/lib/crawl/translate";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import type { ProfileEvidence } from "@/lib/domain/products/search-profile";
import type { VerifyItem } from "@/lib/domain/products/search-verify";
import { OPENAI_CHAT_TOTAL_BOUND_PROTOCOL } from "@/lib/llm/direct-serving-contract";
import type { GatewayServingRoute } from "@/lib/llm/gateway-serving-contract-config";
import type { StoredServingContract } from "@/lib/llm/serving-contract-store";

/**
 * 엔진 직접 총량 상한 계약(openai-chat-total-bound-v1, provider local-direct)의 시험 재료 — 열 경로의 계약 두 모양(지금의 abcllm 총량 상한 계약과
 * 새 모양)과, 각 경로의 실제 준비 함수에 넣는 고정 입력. 단위 시험(wire 동일성)과 통합 시험(실제 장부 왕복)이 같은 것을 쓴다. 운영 값이 아니다.
 */
export const TOTAL_BOUND_ROUTES = ["crawl-agent-review", "second-review", "product-search-profile", "crawl-tagline", "product-search-verify",
  "reason-translate", "product-translate", "product-tagline-ko", "search-query-translate", "crawl-publish-classify"] as const satisfies readonly GatewayServingRoute[];
export type TotalBoundRoute = (typeof TOTAL_BOUND_ROUTES)[number];
export const ABCLLM_PROTOCOLS: Readonly<Record<TotalBoundRoute, string>> = {
  "crawl-agent-review": "abcllm-raw-total-bound-v1", "second-review": "abcllm-raw-total-bound-v1", "product-search-profile": "abcllm-raw-total-bound-v1",
  "crawl-tagline": "abcllm-crawl-tagline-total-bound-v1", "product-search-verify": "abcllm-search-verify-total-bound-v1",
  "reason-translate": "abcllm-reason-total-bound-v1", "product-translate": "abcllm-product-translation-total-bound-v1",
  "product-tagline-ko": "abcllm-product-tagline-ko-total-bound-v1", "search-query-translate": "abcllm-websearch-query-total-bound-v1",
  "crawl-publish-classify": "abcllm-crawl-publish-classify-total-bound-v1" };
/** 번역 4경로 — abcllm 계약은 엄격 terminal opt-in 표시가 있어야 열리고 그 헤더를 보낸다. 새 모양에는 표시도 헤더도 없다. */
export const STRICT_TERMINAL_ROUTES: ReadonlySet<string> = new Set(["reason-translate", "product-translate", "product-tagline-ko", "search-query-translate"]);
export const FIXTURE_ENDPOINT = "http://engine.test:8000/v1/chat/completions";

type ContractOptions = Partial<{ model: string; endpoint: string; responseModel: string; deploymentRevision: string; totalTokenBound: number;
  extra: Record<string, unknown> }>;
const common = (routeId: TotalBoundRoute, options: ContractOptions) => ({ model: options.model ?? "fixture-model", responseModel: options.responseModel ?? "served-fixture",
  deploymentRevision: options.deploymentRevision ?? `fixture-${routeId}`, endpoint: options.endpoint ?? FIXTURE_ENDPOINT,
  totalTokenBound: options.totalTokenBound ?? 65_536 });
/** 지금 운영이 쓰는 모양 — abcllm 총량 상한 계약(번역 4경로는 엄격 terminal opt-in 포함). extra 로 engineModel·reasoningTokenReserve 등을 붙인다. */
export function abcllmContract(routeId: TotalBoundRoute, options: ContractOptions = {}): Record<string, unknown> {
  return { version: 1, protocol: ABCLLM_PROTOCOLS[routeId], routeId, provider: "abcllm", ...common(routeId, options),
    ...(STRICT_TERMINAL_ROUTES.has(routeId) ? { strictTerminalOptIn: "abcllm-strict-terminal-v1" } : {}), ...options.extra };
}
/** 새 모양 — 같은 주소·모델·상한의 엔진 직접 총량 상한 계약. */
export function totalBoundContract(routeId: TotalBoundRoute, options: ContractOptions = {}): Record<string, unknown> {
  return { version: 1, protocol: OPENAI_CHAT_TOTAL_BOUND_PROTOCOL, routeId, provider: "local-direct", ...common(routeId, options), ...options.extra };
}
/** 계약 스냅숏 행(관리 화면이 저장한 행 모양) — 키 없는 엔진 직접 연결. */
export function contractRow(contract: Record<string, unknown>, transport: "direct" | "gateway" = "direct"): StoredServingContract {
  return { routeId: contract.routeId as string, model: contract.model as string, contract, auth: "none", apiKey: null, transport };
}

export function reviewInput(seed = "total-bound"): ReviewInput {
  const now = new Date("2026-11-21T00:00:00.000Z");
  return createReviewInput({ repo: `${seed}/app`, productUrl: "https://total-bound.example", judgedAt: now } as CrawlCandidate,
    { id: 1, repo: `${seed}/app`, productUrl: "https://total-bound.example", repoMeta: { description: "A usable task tracker" },
      pageMeta: { title: "Total bound" }, pageStatus: 200, fetchedAt: now } as CrawlDocument, DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
}
export const profileEvidence = (): ProfileEvidence => ({ url: "https://ledger.example", name: "Ledger Demo", category: "finance", topics: "budget",
  tagline: "Track expenses <untrusted>", pageText: "", readme: "", evidenceLevel: "thin" });
export const verifyItem = (): VerifyItem => ({ evidence: profileEvidence(), keywords: ["budget app", "expense tracker"] });
export const reasonTexts = (): string[] => ["The page shows a working product with a signup form.", "The repository is a tutorial, not a product."];
export const translationItems = (locale: ProductTranslationGatewayItem["locale"] = "en"): ProductTranslationGatewayItem[] => [
  { name: "Toolkit", locale, field: "tagline", text: "Toolkit은 문서 정리를 돕는 도구입니다" },
  { name: "Calendar", locale, field: "description", text: "Calendar helps teams plan software releases." }];
export const taglineKoItems = (): ProductTaglineKoGatewayItem[] => [{ name: "Toolkit", tagline: "Organize documents faster" },
  { name: "Calendar", tagline: "Plan software releases together" }];
export const taglineEvidence = (): TaglineEvidence => ({ name: "Ledger Demo", url: "https://ledger.example", topics: ["budget"], language: "TypeScript",
  pageTitle: "Ledger Demo", pageText: "Track expenses and budgets in one place.", readme: "# Ledger Demo\nA budgeting app." });
export const queryInput = (): WebsearchQueryGatewayInput => ({ query: "가계부 앱", sourceLocale: "ko" });
export const classifyPayload = (): { inputs: ClassifyInput[]; definitions: typeof DEFAULT_CATEGORY_DEFINITIONS } => ({
  inputs: [{ repo: "total-bound/app", url: "https://total-bound.example", name: "Ledger Demo", tagline: "Track expenses", topics: ["budget"], language: "TypeScript" }],
  definitions: DEFAULT_CATEGORY_DEFINITIONS });

type PreparedLike = { kind: "prepared"; wireHash: string; servingContractHash: string; totalTokenBound: number; model: string }
  | { kind: "unsupported"; reason: string };
/**
 * 그 경로의 실제 준비 함수를 고정 입력으로 부른다(계약은 계약 스냅숏에서 읽힌다). 1차는 예전 그대로 provider 가 준비 함수를 가른다
 * (abcllm → prepareAi1GatewayCall, local-direct → prepareAi1DirectCall — agent-review-model-capacity 와 같다).
 */
export async function prepareRouteCall(routeId: TotalBoundRoute, model: string, provider: "abcllm" | "local-direct" | undefined,
  options: { locale?: ProductTranslationGatewayItem["locale"] } = {}): Promise<PreparedLike> {
  const text = { model, timeoutMs: 5_000, ...(provider ? { provider } : {}) };
  switch (routeId) {
    case "crawl-agent-review": return provider === "local-direct" ? prepareAi1DirectCall(reviewInput(), { model, timeoutMs: 5_000 })
      : prepareAi1GatewayCall(reviewInput(), { model, timeoutMs: 5_000 });
    case "second-review": return prepareAi2GatewayCall(reviewInput(), text);
    case "product-search-profile": return prepareTextProfileGatewayCall(profileEvidence(), text);
    case "product-search-verify": return prepareSearchVerifyGatewayCall(verifyItem(), text);
    case "reason-translate": return prepareReasonTranslationGatewayCall(reasonTexts(), text);
    case "product-translate": return prepareProductTranslationGatewayCall(translationItems(options.locale), text);
    case "product-tagline-ko": return prepareProductTaglineKoGatewayCall(taglineKoItems(), text);
    case "crawl-tagline": return prepareCrawlTaglineGatewayCall(taglineEvidence(), text);
    case "search-query-translate": return prepareWebsearchQueryGatewayCall(queryInput(), text);
    case "crawl-publish-classify": return preparePublicationClassifyCall(classifyPayload(), { model, timeoutMs: 5_000, provider: provider ?? "abcllm" });
  }
}
