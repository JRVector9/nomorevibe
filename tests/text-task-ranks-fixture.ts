import { setAiTaskModelsForTest, type AiTaskModelSnapshotRow } from "@/lib/llm/ai-task-models-snapshot";
import { runInTextTaskRank, type TextTaskRankBinding } from "@/lib/llm/ai-task-rank-scope";
import type { AiTextTaskId } from "@/lib/llm/ai-tasks";
import type { StoredServingContract } from "@/lib/llm/serving-contract-store";

/**
 * 시험용 「작업 ↔ 모델」 순위(PR B). 잡·깊은 코드는 순위만 읽는다 — 시험은 순위 스냅숏을 고정하고(pinTextRanks), 그 순위의 연결을 가리키는
 * 엔진 직접 계약 행(textContract)을 계약 스냅숏에 넣거나, 깊은 함수를 순위 범위 안에서 부른다(inTextRank).
 */
export const TEST_TEXT_BASE_URL = "http://engine.test:8000/v1";
export const TEST_CONNECTION_ID = "0b0c0d0e-0000-4000-8000-000000000001";

const PROTOCOLS: Readonly<Record<AiTextTaskId, string>> = {
  "crawl-tagline": "abcllm-crawl-tagline-total-bound-v1", "reason-translate": "abcllm-reason-total-bound-v1",
  "product-translate": "abcllm-product-translation-total-bound-v1", "product-tagline-ko": "abcllm-product-tagline-ko-total-bound-v1",
  "search-query-translate": "abcllm-websearch-query-total-bound-v1", "product-search-profile": "abcllm-raw-total-bound-v1",
  "product-search-verify": "abcllm-search-verify-total-bound-v1",
};
const STRICT: ReadonlySet<string> = new Set(["reason-translate", "product-translate", "product-tagline-ko", "search-query-translate"]);

export type TextRankOptions = Partial<{ rank: number; connectionId: string; label: string; baseUrl: string; apiKey: string | null; keyUnreadable: boolean;
  enabled: boolean; connectionEnabled: boolean; deviceId: string; slot: number }>;

/** 순위 한 줄(연결 포함). 기본: 1순위 · 시험 연결(TEST_TEXT_BASE_URL) · 키 없음 · 켜짐. */
export function textRankRow(task: string, model: string, options: TextRankOptions = {}): AiTaskModelSnapshotRow {
  const id = options.connectionId ?? TEST_CONNECTION_ID;
  return Object.freeze({ task, slot: options.slot ?? 1, rank: options.rank ?? 1, model, enabled: options.enabled ?? true, options: {},
    connection: Object.freeze({ id, label: options.label ?? "test-engine", kind: "api" as const, baseUrl: options.baseUrl ?? TEST_TEXT_BASE_URL, cliTool: null,
      deviceId: options.deviceId ?? "test-device", enabled: options.connectionEnabled ?? true, models: null, contextTokens: null,
      apiKey: options.apiKey ?? null, keyUnreadable: options.keyUnreadable ?? false }) });
}

/** 순위 스냅숏을 고정한다(null = 풀기). 작업 하나에 모델 하나면 { route: model }, 여럿이면 순위 차례 배열. */
export function pinTextRanks(ranks: Partial<Record<string, string | readonly string[]>> | readonly AiTaskModelSnapshotRow[] | null): void {
  if (ranks === null) { setAiTaskModelsForTest(null); return; }
  if (Array.isArray(ranks)) { setAiTaskModelsForTest(ranks as readonly AiTaskModelSnapshotRow[]); return; }
  setAiTaskModelsForTest(Object.entries(ranks as Record<string, string | readonly string[]>).flatMap(([task, value]) =>
    (typeof value === "string" ? [value] : value).map((model, index) => textRankRow(task, model, { rank: index + 1 }))));
}

/** 그 순위의 연결을 가리키는 엔진 직접 계약 행(abcllm 형, transport direct, 키 없음) — 계약 스냅숏(setServingContractSnapshotForTest)에 넣는다. */
export function textContract(routeId: AiTextTaskId, model: string, options: Partial<{ baseUrl: string; engineModel: string; responseModel: string;
  totalTokenBound: number; auth: StoredServingContract["auth"]; apiKey: string | null; transport: "direct" | "gateway" }> = {}): StoredServingContract {
  const base = options.baseUrl ?? TEST_TEXT_BASE_URL;
  const contract: Record<string, unknown> = { version: 1, protocol: PROTOCOLS[routeId], routeId, provider: "abcllm", model,
    responseModel: options.responseModel ?? options.engineModel ?? model, deploymentRevision: `direct-test-${model}`.slice(0, 200),
    endpoint: `${base}/chat/completions`, totalTokenBound: options.totalTokenBound ?? 32_768 };
  if (STRICT.has(routeId)) contract.strictTerminalOptIn = "abcllm-strict-terminal-v1";
  if (options.engineModel) contract.engineModel = options.engineModel;
  return { routeId, model, contract, auth: options.auth ?? "none", apiKey: options.apiKey ?? null, transport: options.transport ?? "direct" };
}

/** 깊은 함수를 순위 하나의 범위에서 부른다(잡이 TextTaskRanks.run 으로 여는 범위와 같다). */
export function textBinding(routeId: string, model: string, overrides: Partial<TextTaskRankBinding> = {}): TextTaskRankBinding {
  return Object.freeze({ routeId, rank: 1, connectionId: TEST_CONNECTION_ID, connectionLabel: "test-engine", identity: model, engineModel: model,
    provider: "abcllm" as const, bearer: null, deviceId: "test-device", ...overrides });
}
export function inTextRank<T>(routeId: string, model: string, run: () => T, overrides: Partial<TextTaskRankBinding> = {}): T {
  return runInTextTaskRank(textBinding(routeId, model, overrides), run);
}
