import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/app/(operator)/admin/models/tasks/actions", () => ({ saveAiConnectionAction: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/devices/actions", () => ({ saveCapacityDevice: vi.fn() }));
import { ConnectionForm } from "@/app/(operator)/admin/models/tasks/ConnectionForm";
import { aiConnectionTaskAllowed, aiTask, aiTaskAccepts } from "@/lib/llm/ai-tasks";
import { reasonTranslationServingContractSchema } from "@/lib/llm/reason-translation-serving-contract";
import { bindApiTaskRank, type AiTaskRank } from "@/lib/llm/ai-task-resolver";
import { uncountedTranslationFailure } from "@/lib/crawl/translations";
import { reasonTranslationGatewayWire } from "@/lib/crawl/translate";
import { engineRouteContract, probeEngineContract } from "@/lib/operations/admin-engine-connect";
import {
  aiConnectionInputFromForm, aiConnectionManualOnly, aiConnectionModelIds, aiConnectionModelsMissing, aiRankReadiness, aiTaskIssueMessage, aiTaskRankOptions,
  aiUnreadConnections, validateAiTaskRanks, type AiConnectionView, type AiReadinessInput,
} from "@/lib/operations/admin-ai-tasks";
import { llmKeyDaysLeft } from "@/lib/operations/llm-ops-view";

/**
 * LG EXAONE API 를 심사 사유 번역에만 붙이는 규칙(2026-11-10) — 목록(/models) 없는 서버의 모델 이름, 연결의 「쓸 수 있는 작업」, 추론 토큰 여유, 429 를 글 탓으로 세지 않기,
 * 키 만료 안내. 실제 EXAONE 은 부르지 않는다(키 없음) — 엔진은 가짜 fetch 다.
 */
const EXAONE = "66666666-6666-4666-8666-666666666666", GEMMA = "77777777-7777-4777-8777-777777777777";
const BASE = "https://api.exaone.ai/v1", MODEL = "k-exaone_v2.5";
const connection = (patch: Partial<AiConnectionView> & Pick<AiConnectionView, "id" | "label" | "kind">): AiConnectionView => ({ baseUrl: null, host: null, hasKey: false,
  cliTool: null, cliModels: [], models: null, modelsReadAt: null, modelsError: null, deviceId: patch.label.toLowerCase(), capacitySlots: 1, contextTokens: null, enabled: true,
  version: 1, note: null, updatedBy: "t", updatedAt: "2026-11-10T00:00:00.000Z", cliVersion: null, ...patch });
const exaone = connection({ id: EXAONE, label: "LG EXAONE", kind: "api", baseUrl: BASE, host: "api.exaone.ai", hasKey: true, deviceId: "exaone-api",
  models: null, modelsError: "http_404", contextTokens: 524_288, manualModels: [MODEL], allowedTasks: ["reason-translate"], reasoningTokenReserve: 4096 });
const gemma = connection({ id: GEMMA, label: "m1-gemma", kind: "api", baseUrl: "https://m1.test/v1", host: "m1.test", hasKey: true, deviceId: "m1-qwen",
  models: [{ id: "m1-gemma", maxModelLen: null }], contextTokens: 98_304 });
const form = (entries: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(entries)) data.set(key, value); return data; };

describe("연결 폼(목록 없는 서버·쓸 수 있는 작업·추론 여유·키 유효 기간)", () => {
  it("밑줄이 든 엔진 이름을 받고, 쓸 수 있는 작업은 체크한 것만, 숫자 칸은 범위 안만", () => {
    const parsed = aiConnectionInputFromForm(form({ kind: "api", label: "LG EXAONE", baseUrl: `${BASE}/chat/completions`, manualModels: `${MODEL}, ${MODEL}`,
      contextTokens: "524288", reasoningTokenReserve: "4096", keyValidDays: "30", "allowedTask.reason-translate": "1", "allowedTask.product-translate": "0",
      capacitySlots: "1", deviceId: "exaone-api" }));
    expect(parsed.issues).toEqual([]);
    expect(parsed.input).toMatchObject({ baseUrl: BASE, manualModels: [MODEL], reasoningTokenReserve: 4096, keyValidDays: 30, allowedTasks: ["reason-translate"],
      capacitySlots: 1, contextTokens: 524_288 });
    // 비워 두면 예전 그대로(모든 작업, 여유 없음)
    expect(aiConnectionInputFromForm(form({ kind: "api", label: "엔진", baseUrl: "http://e.test/v1" })).input)
      .toMatchObject({ manualModels: [], allowedTasks: [], reasoningTokenReserve: null, keyValidDays: null, capacitySlots: 1 });
    expect(aiConnectionInputFromForm(form({ kind: "api", label: "x", baseUrl: BASE, manualModels: "bad model!", reasoningTokenReserve: "99999", keyValidDays: "0" })).issues)
      .toEqual(["ai_connection_invalid:manualModels", "ai_connection_invalid:reasoningTokenReserve", "ai_connection_invalid:keyValidDays"]);
    expect(aiTaskIssueMessage("ai_connection_invalid:manualModels")).toContain("목록 없는 서버의 모델 이름");
    // CLI 연결은 이 칸들을 읽지 않는다
    expect(aiConnectionInputFromForm(form({ kind: "cli", label: "Claude CLI", cliTool: "claude", cliModels: "sonnet", manualModels: MODEL, reasoningTokenReserve: "1" })).input)
      .toMatchObject({ manualModels: [], reasoningTokenReserve: null });
  });
  it("적은 모델은 서버 목록 뒤에 선택지로 오르고, 그런 연결은 「목록 못 읽음」으로 알리지 않는다", () => {
    expect(aiConnectionModelIds(exaone)).toEqual([MODEL]);
    expect(aiConnectionModelIds({ ...gemma, manualModels: ["m1-gemma", "extra"] })).toEqual(["m1-gemma", "extra"]);
    expect(aiConnectionManualOnly(exaone, MODEL)).toBe(true);
    expect(aiConnectionManualOnly({ ...exaone, models: [{ id: MODEL, maxModelLen: 1 }] }, MODEL)).toBe(false);
    expect(aiConnectionModelsMissing(exaone)).toBe(false);
    expect(aiConnectionModelsMissing({ ...exaone, manualModels: [] })).toBe(true);
    expect(aiUnreadConnections([exaone, gemma])).toEqual([]);
  });
});

describe("연결 폼 화면", () => {
  it("API 연결에 목록 없는 모델·추론 여유·키 유효 기간 칸과 「쓸 수 있는 작업」 체크(저장된 제한은 체크된 채 펼침)를 보인다", () => {
    const html = renderToStaticMarkup(createElement(ConnectionForm, { initial: { ...exaone, keySetAt: "2026-11-10T03:00:00.000Z", keyValidDays: 30 }, secretBox: true }));
    expect(html).toContain(`name="manualModels"`); expect(html).toContain(MODEL);
    expect(html).toContain(`name="reasoningTokenReserve"`); expect(html).toContain(`value="4096"`);
    expect(html).toContain(`name="keyValidDays"`); expect(html).toContain(`value="30"`);
    expect(html).toMatch(/<details[^>]*open=""[^>]*><summary[^>]*>쓸 수 있는 작업 — 1개로 제한됨/);
    expect(html).toContain(`name="allowedTask.reason-translate" checked=""`);
    expect(html).not.toContain(`name="allowedTask.product-translate" checked=""`);
    expect(html).toContain("지금 키를 넣은 날: 2026-11-10(KST)");
    // CLI 전용 작업(소개 검수·Grok 로그인 유지)은 API 연결의 체크 목록에 없다
    expect(html).not.toContain(`name="allowedTask.grok-session-check"`);
  });
});

describe("쓸 수 있는 작업(비상업 API 를 심사 사유 번역에만)", () => {
  it("선택지·저장 검증이 같은 제한을 본다 — 공개 번역에는 오르지 않고 저장하면 까닭을 말한다", () => {
    const reason = aiTask("reason-translate")!, product = aiTask("product-translate")!;
    expect(aiConnectionTaskAllowed("reason-translate", exaone)).toBe(true);
    expect(aiTaskAccepts(product, exaone)).toBe(false);
    expect(aiTaskAccepts(product, gemma)).toBe(true);
    // 작업 id 가 없는 옛 호출(가져오기 계획)은 종류만 본다
    expect(aiTaskAccepts({ api: true, cliTools: [] }, exaone)).toBe(true);
    expect(aiTaskRankOptions(reason, [exaone, gemma], []).map(option => `${option.provider}:${option.model}`)).toEqual([`${EXAONE}:${MODEL}`, `${GEMMA}:m1-gemma`]);
    expect(aiTaskRankOptions(product, [exaone, gemma], []).map(option => option.model)).toEqual(["m1-gemma"]);
    expect(validateAiTaskRanks("reason-translate", 1, [{ provider: EXAONE, model: MODEL }], { connections: [exaone], rows: [] })).toEqual([]);
    const issues = validateAiTaskRanks("product-translate", 1, [{ provider: EXAONE, model: MODEL }], { connections: [exaone], rows: [] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("심사 사유 번역 작업에만 쓰도록 제한돼 있습니다");
  });
  it("실행 쪽 묶기도 제한된 연결의 다른 작업 순위를 쓰지 않는다(connection_task_not_allowed)", () => {
    const rank = (task: string): AiTaskRank => ({ task, slot: 1, rank: 1, model: MODEL, enabled: true, options: {},
      connection: { id: EXAONE, label: "LG EXAONE", kind: "api", baseUrl: BASE, cliTool: null, deviceId: "exaone-api", enabled: true, models: null,
        contextTokens: 524_288, apiKey: "local-test-only", keyUnreadable: false, allowedTasks: ["reason-translate"] } });
    expect(bindApiTaskRank("product-translate", rank("product-translate"), [])).toMatchObject({ binding: null, unusable: "connection_task_not_allowed" });
    // 허락된 작업은 그다음 규칙(계약 찾기)으로 간다
    expect(bindApiTaskRank("reason-translate", rank("reason-translate"), [])).toMatchObject({ binding: null, unusable: "no_direct_contract" });
  });
});

describe("저장 전 준비 확인 — 새 장비 1칸, 목록 없는 모델의 상한, 추론 여유", () => {
  const input = (patch: Partial<AiReadinessInput> = {}): AiReadinessInput => ({ contracts: [], localContract: () => null,
    engineRoutes: ["reason-translate", "product-translate", "crawl-tagline"],
    policy: { mode: "open", routes: [{ routeId: "reason-translate", provider: "abcllm", model: "m1-gemma", providerBudgetId: "abcllm-m1-qwen", groupId: "m1-qwen" }],
      groupLimits: { "m1-qwen": 2 } }, devices: new Map([["m1-qwen", { enabled: true, limitSlots: 2 }]]), ...patch });
  it("새 연결은 계약·정책 경로·장비 행(연결의 동시 실행 한도 1)을 만들 것으로 적는다", () => {
    const ready = aiRankReadiness(aiTask("reason-translate")!, 1, exaone, MODEL, input());
    expect(ready).toMatchObject({ blocking: [], warnings: [], identity: MODEL, provider: "abcllm",
      createContract: { routeId: "reason-translate", identity: MODEL, engineModel: null },
      appendRoute: { routeId: "reason-translate", provider: "abcllm", model: MODEL, providerBudgetId: "exaone-api", groupId: "exaone-api" },
      createDevice: { deviceId: "exaone-api", limitSlots: 1 } });
  });
  it("목록 없는 모델인데 컨텍스트 상한이 없으면 막고, 추론 여유는 사유 번역만 쓴다고 알린다", () => {
    expect(aiRankReadiness(aiTask("reason-translate")!, 1, { ...exaone, contextTokens: null }, MODEL, input()).blocking[0]).toContain("「컨텍스트 상한」을 적은 뒤");
    const other = aiRankReadiness(aiTask("crawl-tagline")!, 1, { ...exaone, allowedTasks: [] }, MODEL, input());
    expect(other.warnings[0]).toContain("추론 토큰 여유(4096)를 쓰지 않습니다");
    const stale = aiRankReadiness(aiTask("reason-translate")!, 1, exaone, MODEL, input({ contracts: [{ routeId: "reason-translate", model: MODEL, provider: "abcllm",
      endpoint: `${BASE}/chat/completions`, transport: "direct", reasoningTokenReserve: 2048 }] }));
    expect(stale).toMatchObject({ blocking: [], createContract: null });
    expect(stale.warnings[0]).toContain("계약의 추론 토큰 여유(2048)가 연결의 값(4096)과 다릅니다");
  });
});

describe("엔진 확인(목록 없이 1토큰 시험) · 계약 · wire", () => {
  const calls: string[] = [];
  const engine = (status = 200) => (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    if (String(input).endsWith("/models")) return new Response("not found", { status: 404 });
    // EXAONE 의 응답 꼴: 추론은 reasoning_content, 답은 content(앞에 빈 줄), usage 에 reasoning_tokens
    return status === 200 ? Response.json({ id: "x", object: "chat.completion", created: 1, model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: null, reasoning_content: "생각" }, finish_reason: "length" }],
      usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10, reasoning_tokens: 1 } }) : new Response("{}", { status });
  }) as typeof fetch;
  it("unlisted 는 GET /models 를 부르지 않고 운영자 상한으로 계약 상한을 정하며, 응답 모델은 1토큰 시험이 정한다", async () => {
    calls.length = 0;
    const probed = await probeEngineContract({ endpoint: `${BASE}/chat/completions`, engineModel: MODEL, apiKey: "local-test-only", maxModelLen: 524_288, unlisted: true }, engine());
    expect(probed).toEqual({ endpoint: `${BASE}/chat/completions`, requestModel: MODEL, responseModel: MODEL, totalTokenBound: 524_288, totalTokenBoundFrom: "operator" });
    expect(calls).toEqual([`POST ${BASE}/chat/completions`]);
    await expect(probeEngineContract({ endpoint: `${BASE}/chat/completions`, engineModel: MODEL, apiKey: null, unlisted: true }, engine())).rejects.toThrow("engine_max_len_unknown");
    await expect(probeEngineContract({ endpoint: `${BASE}/chat/completions`, engineModel: MODEL, apiKey: null, maxModelLen: 524_288, unlisted: true }, engine(429)))
      .rejects.toThrow("engine_probe_failed");
    // 목록이 있는 엔진(예전 길)은 그대로 목록을 먼저 본다
    calls.length = 0;
    await expect(probeEngineContract({ endpoint: `${BASE}/chat/completions`, engineModel: MODEL, apiKey: null, maxModelLen: 524_288 }, engine())).rejects.toThrow("engine_unreachable:http_404");
    expect(calls).toEqual([`GET ${BASE}/models`]);
  });
  it("추론 여유는 사유 번역 계약에만 실리고, 없는 계약의 모양은 예전 그대로다", () => {
    const reason = engineRouteContract("reason-translate", MODEL, MODEL, `${BASE}/chat/completions`, 524_288, "exaone-api", "operator", null, 4096);
    expect(reason).toMatchObject({ protocol: "abcllm-reason-total-bound-v1", model: MODEL, responseModel: MODEL, totalTokenBound: 524_288, reasoningTokenReserve: 4096,
      deploymentRevision: `direct-exaone-api-${MODEL}-C524288-operator-bound`, strictTerminalOptIn: "abcllm-strict-terminal-v1" });
    expect(reasonTranslationServingContractSchema.safeParse(reason).success).toBe(true);
    const plain = engineRouteContract("reason-translate", "m1-gemma", "served", "https://m1.test/v1/chat/completions", 98_304, "m1-qwen", "operator");
    expect(plain).not.toHaveProperty("reasoningTokenReserve");
    const product = engineRouteContract("product-translate", MODEL, MODEL, `${BASE}/chat/completions`, 524_288, "exaone-api", "operator", null, 4096);
    expect(product).not.toBeNull(); expect(product).not.toHaveProperty("reasoningTokenReserve");
    expect(reasonTranslationServingContractSchema.safeParse({ ...reason, reasoningTokenReserve: 0 }).success).toBe(false);
  });
  it("wire 의 max_tokens 는 답 몫(예전 식) + 추론 여유, 여유가 없으면 예전 wire 와 한 글자도 다르지 않다", () => {
    const texts = ["Repository has no visible deployment evidence."];
    const plain = JSON.parse(reasonTranslationGatewayWire(texts, MODEL)) as { max_tokens: number; reasoning_effort: string };
    expect(plain.max_tokens).toBe(400 + Math.ceil(texts[0].length * 1.2));
    expect(plain.reasoning_effort).toBe("low");
    expect(reasonTranslationGatewayWire(texts, MODEL, 0)).toBe(reasonTranslationGatewayWire(texts, MODEL));
    expect((JSON.parse(reasonTranslationGatewayWire(texts, MODEL, 4096)) as { max_tokens: number }).max_tokens).toBe(plain.max_tokens + 4096);
  });
});

describe("공급자 한도(429)·키 만료", () => {
  it("rate_limit·tokenizer_unavailable 은 글의 시도로 세지 않고, 그 밖의 실패는 센다", () => {
    expect(["rate_limit", "tokenizer_unavailable"].map(uncountedTranslationFailure)).toEqual([true, true]);
    expect(["timeout", "invalid_output", "http_500", null, undefined].map(uncountedTranslationFailure)).toEqual([false, false, false, false, false]);
  });
  it("키 유효 기간을 적은 연결만 남은 날을 센다", () => {
    const keyed = { hasKey: true, keySetAt: "2026-11-01T00:00:00.000Z", keyValidDays: 30 };
    expect(llmKeyDaysLeft(keyed, "2026-11-10T00:00:00.000Z")).toBe(21);
    expect(llmKeyDaysLeft(keyed, "2026-12-02T00:00:00.000Z")).toBe(-1);
    expect(llmKeyDaysLeft({ ...keyed, keyValidDays: null }, "2026-11-10T00:00:00.000Z")).toBeNull();
    expect(llmKeyDaysLeft({ ...keyed, hasKey: false }, "2026-11-10T00:00:00.000Z")).toBeNull();
  });
});
