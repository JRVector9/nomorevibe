import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ACTION_GROUPS, ACTION_LABELS } from "@/app/(operator)/admin/activity/labels";
import { RankSelects } from "@/app/(operator)/admin/models/RankSelects";
import { ADMIN_MODEL_STAGES } from "@/lib/llm/admin-model-stages";
import { AI_TASKS, aiTask, aiTaskAccepts, aiTaskSlots } from "@/lib/llm/ai-tasks";
import { ASSIGNMENT_STAGE_IDS } from "@/lib/llm/capacity-helpers";
import { GATEWAY_SERVING_CONTRACT_ROUTES } from "@/lib/llm/gateway-serving-contract-config";
import { JOB_NAMES } from "@/lib/jobs/catalog";
import {
  AI_RANK_SLOT_NAMES, AI_TASK_AUDIT_ACTIONS, aiConnectionBaseUrl, aiConnectionInputFromForm, aiImportPlanDigestInput, aiRankReadiness, aiTaskIssueMessage, aiTaskRankNotices,
  aiTaskRankOptions, aiTaskRanksInputFromForm, buildAiImportPlan, validateAiTaskRanks,
  type AiConnectionView, type AiCurrentSlot, type AiCurrentUse, type AiReadinessInput, type AiTaskRankRow,
} from "@/lib/operations/admin-ai-tasks";

const GPU = "11111111-1111-4111-8111-111111111111", SUPA = "22222222-2222-4222-8222-222222222222", CLAUDE = "33333333-3333-4333-8333-333333333333";
const GROK = "44444444-4444-4444-8444-444444444444", EMB = "55555555-5555-4555-8555-555555555555";
const connection = (patch: Partial<AiConnectionView> & Pick<AiConnectionView, "id" | "label" | "kind">): AiConnectionView => ({ baseUrl: null, host: null, hasKey: false,
  cliTool: null, cliModels: [], models: null, modelsReadAt: null, modelsError: null, deviceId: patch.label.toLowerCase(), capacitySlots: 2, contextTokens: null, enabled: true,
  version: 1, note: null, updatedBy: "t", updatedAt: "2026-11-02T00:00:00.000Z", ...patch });
const CONNECTIONS: AiConnectionView[] = [
  connection({ id: GPU, label: "gpu3090", kind: "api", baseUrl: "http://100.77.43.63:8090/v1", host: "100.77.43.63:8090", deviceId: "gpu3090-qwen",
    models: [{ id: "qwen3.8-flash-next", maxModelLen: 131072 }, { id: "qwen-vision", maxModelLen: null }] }),
  connection({ id: SUPA, label: "supa", kind: "api", baseUrl: "http://supa.test:8000/v1", host: "supa.test:8000", deviceId: "supa",
    models: [{ id: "Inferact/Qwen3.8-27B-NVFP4", maxModelLen: 65536 }, { id: "qwen3.8-flash-next", maxModelLen: 32768 }] }),
  connection({ id: CLAUDE, label: "Claude CLI", kind: "cli", cliTool: "claude", cliModels: ["sonnet", "opus"], deviceId: "anthropic-cli" }),
  connection({ id: GROK, label: "Grok CLI", kind: "cli", cliTool: "grok", cliModels: ["grok-4.7"], deviceId: "grok-cli" }),
  connection({ id: EMB, label: "검색 서버", kind: "api", baseUrl: "http://m3.test:18081/v1", host: "m3.test:18081", deviceId: "m3-search",
    models: [{ id: "bge-m3", maxModelLen: null }, { id: "bge-m3-q8", maxModelLen: null }] }),
];
const row = (task: string, slot: number, rank: number, connectionId: string, model: string): AiTaskRankRow => ({ task, slot, rank, connectionId, model, options: {}, enabled: true });
const pick = (provider: string, model: string) => ({ provider, model });
const form = (entries: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(entries)) data.set(key, value); return data; };

describe("migration 0162", () => {
  it("0161 바로 뒤에 idx 162 · when 1794086401073 으로 붙고, 표 두 개만 만든다(기존 표를 바꾸지 않는다)", () => {
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
    const index = journal.entries.findIndex(entry => entry.tag === "0162_ai_task_model_ranks");
    expect(journal.entries[index]).toMatchObject({ idx: 162, when: 1794086401073, version: "7", breakpoints: true });
    expect(journal.entries[index - 1].tag).toBe("0161_text_local_direct_binding");
    const sql = readFileSync("drizzle/0162_ai_task_model_ranks.sql", "utf8");
    expect(sql.match(/^CREATE TABLE (\w+)/gm)).toEqual(["CREATE TABLE ai_connections", "CREATE TABLE ai_task_models"]);
    expect(sql).not.toMatch(/^(ALTER|DROP|UPDATE|DELETE|INSERT)\b/m);
  });
});

describe("작업 목록(lib/llm/ai-tasks.ts)", () => {
  it("id 는 하나뿐이고, 2차만 투표자 3칸이다 — 작업 × 칸은 29줄", () => {
    expect(new Set(AI_TASKS.map(task => task.id)).size).toBe(AI_TASKS.length);
    expect(AI_TASKS.filter(task => task.slots > 1).map(task => [task.id, task.slots, task.slotLabel])).toEqual([["second-review", 3, "투표자"]]);
    expect(aiTaskSlots()).toHaveLength(AI_TASKS.length + 2);
  });
  it("모델 이름·주소·환경변수 이름이 없다(작업은 기능이고, 무엇을 부를지는 표가 정한다)", () => {
    const source = readFileSync("lib/llm/ai-tasks.ts", "utf8");
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/\b[A-Z][A-Z0-9]*_(URL|MODEL|API_KEY|KEY|BACKENDS|CONTRACTS)\b/);
    // 모델 이름은 없다 — 오늘의 잡·route 이름(audit-qwen·local-human-deepseek 같은 열쇠)만 그 글자를 담는다
    for (const task of AI_TASKS) expect(`${task.label} ${task.description}`, task.id).not.toMatch(/qwen|deepseek|gemma|gpt-oss|sonnet|opus|grok-\d|bge-|spark|terra/i);
    expect(Object.keys(AI_TASKS[0])).not.toContain("model");
  });
  it("가리키는 잡·단계·경로 이름은 지금 코드에 있는 것이다", () => {
    for (const task of AI_TASKS) {
      for (const job of task.jobs) expect(JOB_NAMES, `${task.id} → ${job}`).toContain(job);
      if (task.adminStage) expect(ADMIN_MODEL_STAGES.map(stage => stage.id), task.id).toContain(task.adminStage);
      if (task.assignmentStage) expect(ASSIGNMENT_STAGE_IDS as readonly string[], task.id).toContain(task.assignmentStage);
      if (task.wiring === "engine-route" || task.wiring === "review-ai1" || task.wiring === "review-ai2")
        expect(GATEWAY_SERVING_CONTRACT_ROUTES as readonly string[], task.id).toContain(task.routeId);
      if (task.wiring === "local-direct") expect(task.routeId, task.id).toMatch(/^local-[a-z-]+$/);
      expect(task.api || task.cliTools.length > 0, task.id).toBe(true);
    }
    // 단계 풀이 있는 관리자 단계는 공통 기본 풀(direct-review)만 빼고 모두 작업이 있다
    expect(ADMIN_MODEL_STAGES.map(stage => stage.id).filter(id => !AI_TASKS.some(task => task.adminStage === id))).toEqual(["direct-review"]);
  });
  it("저장마다 남는 작업 로그 이름은 작업 로그 화면에 이름과 갈래(설정·연결)가 있다", () => {
    for (const action of AI_TASK_AUDIT_ACTIONS) {
      expect(ACTION_LABELS[action], action).toBeTruthy();
      expect(ACTION_GROUPS.settings.actions as readonly string[], action).toContain(action);
    }
  });
  it("받는 연결: 소개 검수는 Claude CLI 만, 임베딩은 API 만", () => {
    expect(aiTaskAccepts(aiTask("product-intro-check")!, { kind: "cli", cliTool: "claude" })).toBe(true);
    expect(aiTaskAccepts(aiTask("product-intro-check")!, { kind: "api", cliTool: null })).toBe(false);
    expect(aiTaskAccepts(aiTask("product-embedding")!, { kind: "cli", cliTool: "claude" })).toBe(false);
    expect(aiTaskAccepts(aiTask("publish-classify")!, { kind: "cli", cliTool: "grok" })).toBe(false);
  });
});

describe("연결 입력", () => {
  it("주소는 origin/v1 로 고친다(경로 없음·/chat/completions·/models 허용, 계정·질의·다른 경로 거절)", () => {
    expect(aiConnectionBaseUrl("http://100.77.43.63:8090/v1/")).toBe("http://100.77.43.63:8090/v1");
    expect(aiConnectionBaseUrl(" https://Engine.Example:443/v1/chat/completions ")).toBe("https://engine.example/v1");
    expect(aiConnectionBaseUrl("http://m3.test:18081")).toBe("http://m3.test:18081/v1");
    expect(aiConnectionBaseUrl("http://m3.test:18081/v1/models")).toBe("http://m3.test:18081/v1");
    for (const bad of ["ftp://x/v1", "http://user:pw@x/v1", "http://x/v1?a=1", "http://x/api/v1", "not a url"]) expect(aiConnectionBaseUrl(bad), bad).toBeNull();
  });
  it("API 폼: 새 키는 set, 빈 키는 keep, 「키 지우기」는 clear; 장비 이름은 비우면 이름에서 만든다", () => {
    const parsed = aiConnectionInputFromForm(form({ kind: "api", label: "M3 gpt-oss", baseUrl: "http://100.92.77.66:8014", apiKey: "sk-test", capacitySlots: "2" }));
    expect(parsed.issues).toEqual([]);
    expect(parsed.input).toMatchObject({ id: null, kind: "api", baseUrl: "http://100.92.77.66:8014/v1", key: { mode: "set", value: "sk-test" }, deviceId: "m3-gpt-oss",
      capacitySlots: 2, enabled: true, cliModels: [] });
    expect(aiConnectionInputFromForm(form({ kind: "api", label: "a", baseUrl: "http://a/v1", id: GPU, expectedVersion: "3" })).input?.key).toEqual({ mode: "keep" });
    expect(aiConnectionInputFromForm(form({ kind: "api", label: "a", baseUrl: "http://a/v1", id: GPU, expectedVersion: "3", clearKey: "1" })).input?.key).toEqual({ mode: "clear" });
    expect(aiConnectionInputFromForm(form({ kind: "api", label: "a", baseUrl: "http://a/v1", enabled: "0" })).input?.enabled).toBe(false);
  });
  it("CLI 폼: 모델 이름은 띄어쓰기·쉼표로 나누고 키는 언제나 비운다; 틀린 칸은 코드 → 한국어", () => {
    expect(aiConnectionInputFromForm(form({ kind: "cli", label: "Claude CLI", cliTool: "claude", cliModels: "sonnet, opus sonnet" })).input)
      .toMatchObject({ kind: "cli", cliTool: "claude", cliModels: ["sonnet", "opus"], key: { mode: "clear" }, baseUrl: null });
    const bad = aiConnectionInputFromForm(form({ kind: "cli", label: "", cliTool: "gemini", cliModels: "bad model!" }));
    expect(bad.input).toBeNull();
    expect(bad.issues).toEqual(["ai_connection_invalid:label", "ai_connection_invalid:cliTool", "ai_connection_invalid:cliModels"]);
    expect(aiTaskIssueMessage(bad.issues[1])).toBe("입력을 확인하세요: CLI 도구(claude·codex·grok).");
    expect(aiTaskIssueMessage("ai_task_contract_probe_failed:crawl-tagline:engine_unreachable:http_401"))
      .toBe("crawl-tagline 경로의 엔진 직접 계약을 만들지 못했습니다: 엔진에 닿지 않습니다(http_401).");
  });
  it("순위 폼: 빈 칸 = 없음, 연결 id 는 uuid 여야 한다", () => {
    const revision = "a".repeat(64);
    expect(aiTaskRanksInputFromForm(form({ task: "crawl-tagline", slot: "1", revision, rank1Connection: GPU, rank1Model: "qwen3.8-flash-next" })).input)
      .toEqual({ task: "crawl-tagline", slot: 1, revision, ranks: [pick(GPU, "qwen3.8-flash-next"), null, null] });
    expect(aiTaskRanksInputFromForm(form({ task: "nope", slot: "1", revision, rank1Connection: "x", rank1Model: "m" })).issues)
      .toEqual(["ai_task_invalid:task", "ai_task_invalid:rank"]);
  });
});

describe("선택지와 검증", () => {
  const context = (rows: AiTaskRankRow[] = []) => ({ connections: CONNECTIONS, rows });
  it("선택지는 이 작업이 받는 켜진 연결의 실제 모델 — 「연결 · 모델」, API 먼저; 목록에 없는 저장 값은 남긴다", () => {
    const options = aiTaskRankOptions(aiTask("first-review")!, CONNECTIONS, [row("first-review", 1, 1, SUPA, "old-model")]);
    expect(options.map(option => option.label)).toEqual(["gpu3090 · qwen3.8-flash-next", "gpu3090 · qwen-vision", "supa · Inferact/Qwen3.8-27B-NVFP4",
      "supa · qwen3.8-flash-next", "검색 서버 · bge-m3", "검색 서버 · bge-m3-q8", "Claude CLI · sonnet", "Claude CLI · opus", "Grok CLI · grok-4.7",
      "supa · old-model (저장된 값 · 지금 목록에 없음)"]);
    expect(aiTaskRankOptions(aiTask("product-intro-check")!, CONNECTIONS, []).map(option => option.label)).toEqual(["Claude CLI · sonnet", "Claude CLI · opus"]);
  });
  it("빈 칸 뒤 순위·같은 연결·모델·받지 않는 연결·목록에 없는 모델을 막는다", () => {
    expect(validateAiTaskRanks("crawl-tagline", 1, [pick(GPU, "qwen3.8-flash-next"), pick(SUPA, "qwen3.8-flash-next"), null], context())).toEqual([]);
    expect(validateAiTaskRanks("crawl-tagline", 1, [pick(GPU, "qwen3.8-flash-next"), null, pick(SUPA, "qwen3.8-flash-next")], context()))
      .toEqual(["2순위를 비우고 그 뒤 순위만 고를 수 없습니다. 2순위부터 차례로 골라주세요."]);
    expect(validateAiTaskRanks("crawl-tagline", 1, [pick(GPU, "qwen3.8-flash-next"), pick(GPU, "qwen3.8-flash-next")], context()))
      .toEqual(["1순위와 2순위가 같은 연결·모델입니다(qwen3.8-flash-next). 한 연결의 한 모델은 한 순위에만 둘 수 있습니다."]);
    expect(validateAiTaskRanks("crawl-tagline", 1, [pick(CLAUDE, "sonnet")], context())).toEqual(["1순위: 수집 소개 짓기은(는) Claude CLI를 받지 않습니다."]);
    expect(validateAiTaskRanks("product-intro-check", 1, [pick(GPU, "qwen3.8-flash-next")], context()))
      .toEqual(["1순위: 소개 검수은(는) API 주소 연결을 받지 않습니다(CLI Claude CLI만)."]);
    expect(validateAiTaskRanks("crawl-tagline", 1, [pick(GPU, "gone")], context()))
      .toEqual(["1순위: 「gpu3090」의 모델 목록에 gone이(가) 없습니다. AI 연결에서 「다시 읽기」로 목록을 새로 읽으세요."]);
    // 저장된 값은 목록에서 빠져도 그대로 다시 저장할 수 있다
    expect(validateAiTaskRanks("crawl-tagline", 1, [pick(GPU, "gone")], context([row("crawl-tagline", 1, 1, GPU, "gone")]))).toEqual([]);
    expect(validateAiTaskRanks("second-review", 4, [], context())).toEqual(["2차 AI 검수에는 4번 칸이 없습니다."]);
  });
  it("벡터: 2·3순위도 같은 모델, 검색어 벡터는 제품 벡터와 같은 모델; 제품 벡터를 바꾸면 알린다", () => {
    expect(validateAiTaskRanks("product-embedding", 1, [pick(EMB, "bge-m3"), pick(EMB, "bge-m3-q8")], context()))
      .toEqual(["2순위: 제품 의미 검색 벡터은(는) 2·3순위도 1순위와 같은 모델(bge-m3)이어야 합니다. 다른 서버의 같은 모델만 대체로 둘 수 있습니다."]);
    const rows = [row("product-embedding", 1, 1, EMB, "bge-m3")];
    expect(validateAiTaskRanks("search-embedding", 1, [pick(EMB, "bge-m3-q8")], context(rows)))
      .toEqual(["검색어 벡터은(는) 제품 의미 검색 벡터의 1순위 모델(bge-m3)과 같은 모델이어야 합니다."]);
    expect(validateAiTaskRanks("search-embedding", 1, [pick(EMB, "bge-m3")], context(rows))).toEqual([]);
    expect(aiTaskRankNotices("product-embedding", [pick(EMB, "bge-m3-q8")], [...rows, row("search-embedding", 1, 1, EMB, "bge-m3")]))
      .toEqual(["검색어 벡터의 1순위(bge-m3)가 이 모델과 다릅니다 — 검색어 벡터도 같은 모델로 바꿔야 합니다."]);
  });
  it("2차: 투표자끼리 같은 1순위 모델은 안 된다(대체 순위는 겹쳐도 된다)", () => {
    const rows = [row("second-review", 1, 1, CLAUDE, "opus"), row("second-review", 1, 2, GPU, "qwen3.8-flash-next")];
    expect(validateAiTaskRanks("second-review", 2, [pick(CLAUDE, "opus")], context(rows)))
      .toEqual(["투표자 1의 1순위와 같은 모델(opus)입니다. 같은 모델이 두 표를 낼 수 없습니다."]);
    expect(validateAiTaskRanks("second-review", 2, [pick(GROK, "grok-4.7"), pick(GPU, "qwen3.8-flash-next")], context(rows))).toEqual([]);
  });
});

describe("저장 전 준비 확인(aiRankReadiness)", () => {
  const policyRoutes = [
    { routeId: "crawl-tagline", provider: "abcllm", model: "Inferact/Qwen3.8-27B-NVFP4", providerBudgetId: "abcllm-supa", groupId: "supa" },
    { routeId: "local-audit", provider: "local-direct", model: "qwen3.8-flash-next", providerBudgetId: "gpu3090-qwen", groupId: "gpu3090-qwen" },
    { routeId: "product-intro-check", provider: "claude-cli", model: "sonnet", providerBudgetId: "claude-cli", groupId: "anthropic-cli" },
  ];
  const input = (patch: Partial<AiReadinessInput> = {}): AiReadinessInput => ({ contracts: [], ai2Contract: () => null, localContract: () => null,
    engineRoutes: ["crawl-agent-review", "crawl-tagline", "reason-translate"], policy: { mode: "open", routes: policyRoutes, groupLimits: { "gpu3090-qwen": 4 } },
    devices: new Map([["supa", { enabled: true, limitSlots: 4 }], ["anthropic-cli", { enabled: true, limitSlots: 2 }]]), ...patch });
  const gpu = CONNECTIONS[0], supa = CONNECTIONS[1], claude = CONNECTIONS[2];
  it("엔진 경로: 계약·정책 route·장비가 없으면 만들 것으로 적는다(장비 칸 = 정책 groupLimits, 예산 = 같은 장비의 다른 route 이름)", () => {
    const ready = aiRankReadiness(aiTask("crawl-tagline")!, 1, gpu, "qwen3.8-flash-next", input());
    expect(ready).toMatchObject({ blocking: [], provider: "abcllm", createContract: { routeId: "crawl-tagline", replacesGateway: false },
      appendRoute: { routeId: "crawl-tagline", provider: "abcllm", model: "qwen3.8-flash-next", providerBudgetId: "gpu3090-qwen", groupId: "gpu3090-qwen" },
      createDevice: { deviceId: "gpu3090-qwen", limitSlots: 4 } });
    const supaReady = aiRankReadiness(aiTask("crawl-tagline")!, 1, supa, "Inferact/Qwen3.8-27B-NVFP4", input({ contracts: [{ routeId: "crawl-tagline",
      model: "Inferact/Qwen3.8-27B-NVFP4", provider: "abcllm", endpoint: "http://supa.test:8000/v1/chat/completions", transport: "direct" }] }));
    expect(supaReady).toMatchObject({ blocking: [], createContract: null, appendRoute: null, createDevice: null });
  });
  it("엔진 경로: 같은 경로·모델 계약이 다른 서버면, 정책 route 가 다른 장비면 막는다", () => {
    const other = aiRankReadiness(aiTask("crawl-tagline")!, 2, gpu, "qwen3.8-flash-next", input({ contracts: [{ routeId: "crawl-tagline", model: "qwen3.8-flash-next",
      provider: "abcllm", endpoint: "http://supa.test:8000/v1/chat/completions", transport: "direct" }] }));
    expect(other.blocking).toEqual([expect.stringContaining("2순위 gpu3090 · qwen3.8-flash-next: crawl-tagline 경로의 같은 모델 계약이 다른 서버(supa.test:8000)를 가리킵니다.")]);
    const routed = aiRankReadiness(aiTask("crawl-tagline")!, 1, gpu, "Inferact/Qwen3.8-27B-NVFP4", input());
    expect(routed.blocking).toEqual([expect.stringContaining("경로는 장비 supa에 있습니다. 연결의 장비 이름을 supa(으)로 바꾸거나")]);
  });
  it("로컬 직접 경로: 정책 route 와 로컬 계약이 있어야 한다(만들지 않는다)", () => {
    const task = aiTask("audit-review")!;
    expect(aiRankReadiness(task, 1, gpu, "qwen3.8-flash-next", input({ localContract: () => ({ model: "qwen3.8-flash-next", endpoint: "http://100.77.43.63:8090/v1/chat/completions" }) })))
      .toMatchObject({ blocking: [], appendRoute: null, createDevice: { deviceId: "gpu3090-qwen", limitSlots: 4 } });
    expect(aiRankReadiness(task, 1, gpu, "qwen3.8-flash-next", input()).blocking).toEqual(["1순위 gpu3090 · qwen3.8-flash-next: 로컬 직접 계약(gpu3090-qwen)이 없습니다."]);
    expect(aiRankReadiness(task, 1, gpu, "qwen-vision", input()).blocking).toEqual([expect.stringContaining("용량 정책에 local-audit / local-direct / qwen-vision 경로가 없습니다.")]);
  });
  it("CLI: 같은 경로의 다른 모델이 쓰는 예산을 따라 덧붙이고, CLI 계약은 경고로만", () => {
    const ready = aiRankReadiness(aiTask("product-intro-check")!, 1, claude, "opus", input());
    expect(ready).toMatchObject({ blocking: [], provider: "claude-cli", createDevice: null,
      appendRoute: { routeId: "product-intro-check", provider: "claude-cli", model: "opus", providerBudgetId: "claude-cli", groupId: "anthropic-cli" } });
    expect(ready.warnings).toEqual([expect.stringContaining("CLI 계약(connect 에이전트 쪽)은 이 화면이 확인하지 못합니다")]);
  });
  it("정책을 못 읽으면 막고, 꺼진 장비도 막는다; 벡터는 확인할 것이 없다", () => {
    expect(aiRankReadiness(aiTask("crawl-tagline")!, 1, supa, "Inferact/Qwen3.8-27B-NVFP4", input({ policy: null })).blocking)
      .toEqual([expect.stringContaining("용량 정책을 읽지 못해")]);
    expect(aiRankReadiness(aiTask("crawl-tagline")!, 1, supa, "Inferact/Qwen3.8-27B-NVFP4", input({ devices: new Map([["supa", { enabled: false, limitSlots: 4 }]]) })).blocking)
      .toEqual([expect.stringContaining("장비 supa가 꺼져 있습니다")]);
    expect(aiRankReadiness(aiTask("product-embedding")!, 1, CONNECTIONS[4], "bge-m3", input({ policy: null }))).toMatchObject({ blocking: [], warnings: [] });
  });
});

describe("가져오기 계획(buildAiImportPlan)", () => {
  const use = (patch: Partial<AiCurrentUse> & Pick<AiCurrentUse, "model">): AiCurrentUse => ({ kind: "api", baseUrl: null, cliTool: null, provider: "abcllm",
    origin: "test", deviceId: null, keyFrom: null, ...patch });
  const slot = (task: string, uses: AiCurrentUse[], patch: Partial<AiCurrentSlot> = {}, index = 1): AiCurrentSlot =>
    ({ task, slot: index, uses, source: "test", error: null, skip: null, notes: [], ...patch });
  const base = { connections: [] as AiConnectionView[], rows: [] as AiTaskRankRow[], deviceSlots: new Map([["supa", 4], ["gpu3090-qwen", 4]]),
    hostEquipment: new Map([["100.77.43.63:8090", "gpu3090"]]) };
  it("엔진 주소마다 연결 하나(이름 = 장비 이름), CLI 는 도구마다 하나; 순서대로 1·2·3순위; 주소 모르는 순위는 건너뛴다", () => {
    const plan = buildAiImportPlan({ ...base, current: [
      slot("first-review", [use({ model: "Inferact/Qwen3.8-27B-NVFP4", baseUrl: "http://supa.test:8000/v1", deviceId: "supa", keyFrom: { routeId: "crawl-agent-review", model: "Inferact/Qwen3.8-27B-NVFP4" } }),
        use({ kind: "cli", cliTool: "claude", provider: "claude-cli", model: "sonnet" }), use({ model: "gpt-oss-120b", baseUrl: null, origin: "firstReviewAdditional[1]" })]),
      slot("audit-review", [use({ model: "qwen3.8-flash-next", provider: "local-direct", baseUrl: "http://100.77.43.63:8090/v1", keyEnv: "AUDIT_SECOND_OPINION_API_KEY" })]),
      slot("product-intro-check", [use({ kind: "cli", cliTool: "claude", provider: "claude-cli", model: "opus" })]),
      slot("korean-translation-direct", [], { skip: "지금 꺼져 있습니다." }),
    ] });
    expect(plan.connections.map(row => [row.action, row.label, row.kind, row.baseUrl, row.cliModels, row.deviceId, row.capacitySlots, row.keyFrom, row.keyEnv])).toEqual([
      ["create", "supa", "api", "http://supa.test:8000/v1", [], "supa", 4, { routeId: "crawl-agent-review", model: "Inferact/Qwen3.8-27B-NVFP4" }, null],
      ["create", "Claude CLI", "cli", null, ["sonnet", "opus"], "claude-cli", 1, null, null],
      ["create", "gpu3090", "api", "http://100.77.43.63:8090/v1", [], "gpu3090", 1, null, "AUDIT_SECOND_OPINION_API_KEY"],
    ]);
    expect(plan.slots.map(row => [row.task, row.action, row.ranks.map(rank => `${rank.rank}:${rank.connectionKey}:${rank.model}`)])).toEqual([
      ["first-review", "create", ["1:api:http://supa.test:8000/v1:Inferact/Qwen3.8-27B-NVFP4", "2:cli:claude:sonnet"]],
      ["audit-review", "create", ["1:api:http://100.77.43.63:8090/v1:qwen3.8-flash-next"]],
      ["product-intro-check", "create", ["1:cli:claude:opus"]],
    ]);
    expect(plan.warnings).toEqual(["1차 AI 검수: gpt-oss-120b(firstReviewAdditional[1])의 서버 주소를 몰라 옮기지 않습니다.",
      "한국어 소개 번역 · 직접 경로: 지금 꺼져 있습니다."]);
  });
  it("있는 연결은 다시 만들지 않고, 저장된 칸은 덮지 않는다(같으면 그대로, 다르면 다름)", () => {
    const current = [slot("crawl-tagline", [use({ model: "qwen3.8-flash-next", baseUrl: "http://100.77.43.63:8090/v1" })]),
      slot("reason-translate", [use({ model: "qwen3.8-flash-next", baseUrl: "http://100.77.43.63:8090/v1" })]),
      slot("product-intro-check", [use({ kind: "cli", cliTool: "claude", provider: "claude-cli", model: "haiku" })])];
    const plan = buildAiImportPlan({ ...base, connections: CONNECTIONS, current,
      rows: [row("crawl-tagline", 1, 1, GPU, "qwen3.8-flash-next"), row("reason-translate", 1, 1, SUPA, "qwen3.8-flash-next")] });
    expect(plan.connections.map(row => [row.action, row.label, row.cliModels])).toEqual([["existing", "gpu3090", []], ["update", "Claude CLI", ["sonnet", "opus", "haiku"]]]);
    expect(plan.slots.map(row => [row.task, row.action])).toEqual([["crawl-tagline", "unchanged"], ["reason-translate", "differs"], ["product-intro-check", "create"]]);
    expect(plan.warnings).toEqual(["심사 사유 번역: 이미 저장한 순위가 지금 설정과 달라 덮지 않습니다(작업 ↔ 모델 표에서 고치세요)."]);
  });
  it("서버가 이름을 정하는 작업(임베딩)은 방금 읽은 목록이 하나면 그 이름; 여럿이면 옮기지 않는다", () => {
    const current = [slot("product-embedding", [use({ model: "bge-m3-f16@daec91ff", provider: "llama-server", baseUrl: "http://m3.test:18081/v1", serverNamed: true })])];
    const one = buildAiImportPlan({ ...base, current, served: new Map([["http://m3.test:18081/v1", ["bge-m3"]]]) });
    expect(one.slots[0].ranks.map(rank => rank.model)).toEqual(["bge-m3"]);
    const many = buildAiImportPlan({ ...base, current, served: new Map([["http://m3.test:18081/v1", ["a", "b"]]]) });
    expect(many.slots[0]).toMatchObject({ action: "empty", ranks: [] });
    expect(many.warnings[0]).toContain("모델 목록에서 이름을 하나로 정하지 못해 옮기지 않습니다(목록 2개)");
    // 같은 계획은 같은 hash 입력이다
    expect(aiImportPlanDigestInput(one)).toBe(aiImportPlanDigestInput(buildAiImportPlan({ ...base, current, served: new Map([["http://m3.test:18081/v1", ["bge-m3"]]]) })));
  });
});

describe("RankSelects — 작업 ↔ 모델 꼴(provider 칸 = 연결 id)", () => {
  it("검증·안내를 받아 그리고 제공자 이름을 덧붙이지 않는다; 고른 값은 rank<N>Connection·rank<N>Model 로 보낸다", () => {
    const options = aiTaskRankOptions(aiTask("crawl-tagline")!, CONNECTIONS, []);
    const html = renderToStaticMarkup(createElement(RankSelects<{ provider: string; model: string }>, { stage: { id: "crawl-tagline-1", label: "수집 소개 짓기", slots: 3 }, options,
      value: [pick(GPU, "qwen3.8-flash-next"), null, pick(SUPA, "qwen3.8-flash-next")], slotNames: AI_RANK_SLOT_NAMES, onChange: () => {}, showProvider: false,
      validate: slots => validateAiTaskRanks("crawl-tagline", 1, slots, { connections: CONNECTIONS, rows: [] }), note: createElement("p", null, "안내") }));
    expect(html).toContain(">gpu3090 · qwen3.8-flash-next</option>");
    expect(html).not.toContain("(abcllm)");
    expect(html).toContain(`name="rank1Connection" value="${GPU}"`);
    expect(html).toContain('name="rank3Model" value="qwen3.8-flash-next"');
    expect(html).toContain("2순위를 비우고 그 뒤 순위만 고를 수 없습니다.");
    expect(html).toContain("<p>안내</p>");
    expect(html).not.toContain("저장하면 다음 틱부터 적용됩니다");
  });
});
