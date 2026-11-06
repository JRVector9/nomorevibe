import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ACTION_GROUPS, ACTION_LABELS } from "@/app/(operator)/admin/activity/labels";
import { RankSelects } from "@/app/(operator)/admin/models/RankSelects";
import * as modelAvailability from "@/app/(operator)/admin/models/use-model-availability";
import { ADMIN_MODEL_STAGES } from "@/lib/llm/admin-model-stages";
import { AI_TASKS, aiTask, aiTaskAccepts, aiTaskAliasIdentity, aiTaskSlots } from "@/lib/llm/ai-tasks";
import { ASSIGNMENT_STAGE_IDS } from "@/lib/llm/capacity-helpers";
import { CLI_DB_CONTRACT_ROUTES } from "@/lib/llm/cli-serving-contract";
import { GATEWAY_SERVING_CONTRACT_ROUTES } from "@/lib/llm/gateway-serving-contract-config";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { buildAiCurrentSlots } from "@/lib/operations/admin-ai-task-current";
import { rankOptionKey } from "@/lib/operations/admin-first-review-ranks";
import type { ModelEnv } from "@/lib/operations/pipeline-control";
import { JOB_NAMES } from "@/lib/jobs/catalog";
import {
  AI_RANK_SLOT_NAMES, AI_TASK_AUDIT_ACTIONS, aiConnectionBaseUrl, aiConnectionInputFromForm, aiImportPlanDigestInput, aiRankPendingText, aiRankReadiness, aiRanksReadiness,
  aiRankOptionBlocked, aiSameUnderlyingModel, aiTaskIssueMessage, aiTaskRankNotices, aiTaskRankOptions, aiTaskRanksInputFromForm, aiUnreadConnections, buildAiImportPlan,
  validateAiTaskRanks,
  type AiConnectionView, type AiCurrentSlot, type AiCurrentUse, type AiReadinessInput, type AiTaskRankRow,
} from "@/lib/operations/admin-ai-tasks";

const GPU = "11111111-1111-4111-8111-111111111111", SUPA = "22222222-2222-4222-8222-222222222222", CLAUDE = "33333333-3333-4333-8333-333333333333";
const GROK = "44444444-4444-4444-8444-444444444444", EMB = "55555555-5555-4555-8555-555555555555";
const connection = (patch: Partial<AiConnectionView> & Pick<AiConnectionView, "id" | "label" | "kind">): AiConnectionView => ({ baseUrl: null, host: null, hasKey: false,
  cliTool: null, cliModels: [], models: null, modelsReadAt: null, modelsError: null, deviceId: patch.label.toLowerCase(), capacitySlots: 2, contextTokens: null, enabled: true,
  version: 1, note: null, updatedBy: "t", updatedAt: "2026-11-02T00:00:00.000Z", cliVersion: null, ...patch });
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
  it("받는 연결: 소개 검수는 Claude·OpenCode CLI, 임베딩은 API 만", () => {
    expect(aiTaskAccepts(aiTask("product-intro-check")!, { kind: "cli", cliTool: "claude" })).toBe(true);
    expect(aiTaskAccepts(aiTask("product-intro-check")!, { kind: "cli", cliTool: "opencode" })).toBe(true);
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
    expect(aiTaskIssueMessage(bad.issues[1])).toBe("입력을 확인하세요: CLI 도구(claude·codex·grok·opencode).");
    expect(aiTaskIssueMessage("ai_task_contract_probe_failed:crawl-tagline:engine_unreachable:http_401"))
      .toBe("crawl-tagline 경로의 엔진 직접 계약을 만들지 못했습니다: 엔진에 닿지 않습니다(http_401).");
  });
  it("CLI 폼의 CLI 버전(PR C1): 그대로 받고(앞뒤 공백만 뗀다) 비우면 없음, 80자를 넘거나 제어 문자면 막는다; API 연결은 늘 없음", () => {
    const cli = (cliVersion: string) => aiConnectionInputFromForm(form({ kind: "cli", label: "Claude CLI", cliTool: "claude", cliModels: "sonnet", cliVersion }));
    expect(cli(" 2.1.0 (Claude Code) ").input?.cliVersion).toBe("2.1.0 (Claude Code)");
    expect(cli("").input?.cliVersion).toBeNull();
    expect(cli("x".repeat(81)).issues).toEqual(["ai_connection_invalid:cliVersion"]);
    expect(cli("2.1.0\u0007").issues).toEqual(["ai_connection_invalid:cliVersion"]);
    expect(aiTaskIssueMessage("ai_connection_invalid:cliVersion")).toBe("입력을 확인하세요: CLI 버전(80자까지, `--version` 출력 그대로).");
    expect(aiConnectionInputFromForm(form({ kind: "api", label: "a", baseUrl: "http://a/v1", cliVersion: "2.1.0" })).input?.cliVersion).toBeNull();
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
    // 드롭다운은 서버(연결)마다 묶고 그 안에 모델 이름만 보인다(2026-11-02 화면 단순화) — 목록에 없는 저장 값도 그 서버 묶음에 「지금 목록에 없음」으로 남는다
    expect(options.map(option => [option.group, option.text])).toEqual([["gpu3090", "qwen3.8-flash-next"], ["gpu3090", "qwen-vision"],
      ["supa", "Inferact/Qwen3.8-27B-NVFP4"], ["supa", "qwen3.8-flash-next"], ["검색 서버", "bge-m3"], ["검색 서버", "bge-m3-q8"], ["Claude CLI", "sonnet"],
      ["Claude CLI", "opus"], ["Grok CLI", "grok-4.7"], ["supa", "old-model (목록에 없음)"]]);
    const gone = aiTaskRankOptions(aiTask("crawl-tagline")!, CONNECTIONS, [row("crawl-tagline", 1, 1, "66666666-6666-4666-8666-666666666666", "x")]);
    expect(gone.at(-1)).toMatchObject({ group: "지워진 연결", text: "x (목록에 없음)", saved: true });
  });
  it("드롭다운에서 흐리게 둘 선택지: 벡터 2·3순위는 1순위와 같은 모델만, 2차 투표자는 다른 칸의 모델(같은 가중치 포함)을 못 고른다; 지금 칸의 값은 늘 고를 수 있다", () => {
    const embedding = aiTask("product-embedding")!, second = aiTask("second-review")!, tagline = aiTask("crawl-tagline")!;
    const slots = [pick(EMB, "bge-m3"), null, null];
    expect(aiRankOptionBlocked(embedding, 1, 1, pick(EMB, "bge-m3-q8"), slots, [])).toBe(true);
    expect(aiRankOptionBlocked(embedding, 1, 1, pick(GPU, "bge-m3"), slots, [])).toBe(false);
    expect(aiRankOptionBlocked(embedding, 1, 0, pick(EMB, "bge-m3-q8"), slots, [])).toBe(false);
    const voters = [row("second-review", 2, 1, SUPA, "Inferact/Qwen3.8-27B-NVFP4")];
    expect(aiRankOptionBlocked(second, 1, 0, pick(GPU, "Qwen3.8-27B-NVFP4"), [null], voters)).toBe(true);
    expect(aiRankOptionBlocked(second, 2, 0, pick(SUPA, "Inferact/Qwen3.8-27B-NVFP4"), [pick(SUPA, "Inferact/Qwen3.8-27B-NVFP4")], voters)).toBe(false);
    expect(aiRankOptionBlocked(second, 1, 0, pick(GPU, "qwen3.8-flash-next"), [null], voters)).toBe(false);
    expect(aiRankOptionBlocked(tagline, 1, 1, pick(GPU, "anything"), [pick(SUPA, "qwen3.8-flash-next")], voters)).toBe(false);
  });
  it("모델 목록을 못 읽은 켜진 API 서버와 그 까닭(키 없음·마지막 오류)을 낸다 — CLI·꺼진 연결·목록이 있는 서버는 빼고", () => {
    expect(aiUnreadConnections(CONNECTIONS)).toEqual([]);
    const m3 = connection({ id: "77777777-7777-4777-8777-777777777777", label: "m3-mlx", kind: "api", baseUrl: "http://m3.test:8014/v1", modelsError: "http_401" });
    const fresh = connection({ id: "88888888-8888-4888-8888-888888888888", label: "새 서버", kind: "api", baseUrl: "http://new.test/v1", hasKey: true });
    const off = connection({ id: "99999999-9999-4999-8999-999999999999", label: "꺼짐", kind: "api", baseUrl: "http://off.test/v1", enabled: false });
    const empty = connection({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", label: "빈 서버", kind: "api", baseUrl: "http://empty.test/v1", hasKey: true, models: [] });
    expect(aiUnreadConnections([...CONNECTIONS, m3, fresh, off, empty])).toEqual([
      { id: m3.id, label: "m3-mlx", reason: "키 없음 · 거절됨(HTTP 401 — 키 확인)" }, { id: fresh.id, label: "새 서버", reason: "아직 못 읽음" },
      { id: empty.id, label: "빈 서버", reason: "모델 0개" }]);
  });
  it("빈 칸 뒤 순위·받지 않는 연결·목록에 없는 모델을 막고 같은 연결·모델의 반복 순위는 허용한다", () => {
    expect(validateAiTaskRanks("crawl-tagline", 1, [pick(GPU, "qwen3.8-flash-next"), pick(SUPA, "qwen3.8-flash-next"), null], context())).toEqual([]);
    expect(validateAiTaskRanks("crawl-tagline", 1, [pick(GPU, "qwen3.8-flash-next"), null, pick(SUPA, "qwen3.8-flash-next")], context()))
      .toEqual(["2순위를 비우고 그 뒤 순위만 고를 수 없습니다. 2순위부터 차례로 골라주세요."]);
    expect(validateAiTaskRanks("crawl-tagline", 1, [pick(GPU, "qwen3.8-flash-next"), pick(GPU, "qwen3.8-flash-next")], context()))
      .toEqual([]);
    expect(validateAiTaskRanks("crawl-tagline", 1, [pick(CLAUDE, "sonnet")], context())).toEqual(["1순위: 수집 소개 짓기은(는) Claude CLI를 받지 않습니다."]);
    expect(validateAiTaskRanks("product-intro-check", 1, [pick(GPU, "qwen3.8-flash-next")], context()))
      .toEqual(["1순위: 소개 검수은(는) API 주소 연결을 받지 않습니다(CLI Claude CLI·OpenCode CLI만)."]);
    expect(validateAiTaskRanks("crawl-tagline", 1, [pick(GPU, "gone")], context()))
      .toEqual(["1순위: 「gpu3090」의 모델 목록에 gone이(가) 없습니다. AI 연결에서 「다시 읽기」로 목록을 새로 읽으세요."]);
    // 저장된 값은 목록에서 빠져도 그대로 다시 저장할 수 있다
    expect(validateAiTaskRanks("crawl-tagline", 1, [pick(GPU, "gone")], context([row("crawl-tagline", 1, 1, GPU, "gone")]))).toEqual([]);
    expect(validateAiTaskRanks("second-review", 4, [], context())).toEqual(["2차 AI 검수에는 4번 칸이 없습니다."]);
  });
  it("벡터: 2·3순위도 같은 모델, 검색어 벡터는 제품 벡터와 같은 모델; 제품 벡터를 바꾸면 알린다", () => {
    expect(validateAiTaskRanks("product-embedding", 1, [pick(EMB, "bge-m3"), pick(EMB, "bge-m3-q8")], context()))
      .toEqual(["2순위: 제품 의미 검색 벡터은(는) 2·3순위도 1순위와 같은 모델(bge-m3)이어야 합니다."]);
    const rows = [row("product-embedding", 1, 1, EMB, "bge-m3")];
    expect(validateAiTaskRanks("search-embedding", 1, [pick(EMB, "bge-m3-q8")], context(rows)))
      .toEqual(["검색어 벡터은(는) 제품 의미 검색 벡터의 1순위 모델(bge-m3)과 같은 모델이어야 합니다."]);
    expect(validateAiTaskRanks("search-embedding", 1, [pick(EMB, "bge-m3")], context(rows))).toEqual([]);
    expect(aiTaskRankNotices("product-embedding", [pick(EMB, "bge-m3-q8")], [...rows, row("search-embedding", 1, 1, EMB, "bge-m3")]))
      .toEqual(["검색어 벡터의 1순위(bge-m3)가 이 모델과 다릅니다 — 검색어 벡터도 같은 모델로 바꿔야 합니다."]);
  });
  // PR C1: 칸마다 1순위를 쓸 수 없으면 그 칸의 2·3순위가 표를 낸다 — 같은 모델이 두 칸에 있으면(어느 순위든) 한 항목에 같은 모델이 두 표를 낼 수 있다
  const clashText = (rank: number, slot: number, otherRank: number, model: string) =>
    `${rank}순위: 투표자 ${slot}의 ${otherRank}순위와 같은 모델(${model})입니다. 한 모델은 한 투표자 칸에만 둘 수 있습니다 — 같은 모델이 한 항목에 두 표를 낼 수 없습니다.`;
  it("2차: 한 모델은 투표자 한 칸에만 — 다른 칸의 어느 순위와도 겹치면 막는다(대체 순위끼리도)", () => {
    const rows = [row("second-review", 1, 1, CLAUDE, "opus"), row("second-review", 1, 2, GPU, "qwen3.8-flash-next")];
    expect(validateAiTaskRanks("second-review", 2, [pick(CLAUDE, "opus")], context(rows))).toEqual([clashText(1, 1, 1, "opus")]);
    // 예전에는 대체 순위끼리 겹쳐도 됐다 — 이제는 다른 칸의 2순위와 같은 모델도 막는다(다른 서버의 같은 모델도)
    expect(validateAiTaskRanks("second-review", 2, [pick(GROK, "grok-4.7"), pick(GPU, "qwen3.8-flash-next")], context(rows)))
      .toEqual([clashText(2, 1, 2, "qwen3.8-flash-next")]);
    expect(validateAiTaskRanks("second-review", 2, [pick(GROK, "grok-4.7"), pick(SUPA, "qwen3.8-flash-next")], context(rows)))
      .toEqual([clashText(2, 1, 2, "qwen3.8-flash-next")]);
    expect(validateAiTaskRanks("second-review", 2, [pick(GROK, "grok-4.7"), pick(SUPA, "Inferact/Qwen3.8-27B-NVFP4")], context(rows))).toEqual([]);
    // 같은 칸 안에서 같은 모델을 다른 서버로 두는 것(1순위 대체)은 된다 — 그 칸의 저장된 행과도 겹침으로 보지 않는다
    expect(validateAiTaskRanks("second-review", 1, [pick(CLAUDE, "opus"), pick(GPU, "qwen3.8-flash-next"), pick(SUPA, "qwen3.8-flash-next")], context(rows))).toEqual([]);
    // 1차는 칸이 하나라 이 규칙이 없다
    expect(validateAiTaskRanks("first-review", 1, [pick(CLAUDE, "opus")], context([...rows, row("first-review", 1, 1, CLAUDE, "opus")]))).toEqual([]);
  });
  it("2차: 같은 모델은 장부 이름 꼬리(@<연결 8자>)·앞의 [자리 표시]·배포자 접두어·대소문자를 떼고 견준다", () => {
    const rows = [row("second-review", 1, 1, GPU, `qwen3.8-flash-next@${GPU.slice(0, 8)}`), row("second-review", 1, 2, SUPA, "[supa] Inferact/Qwen3.8-27B-NVFP4"),
      row("second-review", 3, 3, SUPA, "QWEN-VISION")];
    expect(validateAiTaskRanks("second-review", 2, [pick(SUPA, "qwen3.8-flash-next")], context(rows))).toEqual([clashText(1, 1, 1, "qwen3.8-flash-next")]);
    expect(validateAiTaskRanks("second-review", 2, [pick(CLAUDE, "sonnet"), pick(SUPA, "Inferact/Qwen3.8-27B-NVFP4")], context(rows)))
      .toEqual([clashText(2, 1, 2, "Inferact/Qwen3.8-27B-NVFP4")]);
    expect(validateAiTaskRanks("second-review", 2, [pick(CLAUDE, "sonnet"), pick(GROK, "grok-4.7"), pick(GPU, "qwen-vision")], context(rows)))
      .toEqual([clashText(3, 3, 3, "qwen-vision")]);
    expect(aiSameUnderlyingModel("[supa] Inferact/Qwen3.8-27B-NVFP4", "qwen3.8-27b-nvfp4")).toBe(true);
    expect(aiSameUnderlyingModel(`qwen3.8-flash-next@${SUPA.slice(0, 8)}`, " Qwen3.8-Flash-Next ")).toBe(true);
    expect(aiSameUnderlyingModel("qwen3.8-flash-next+vision-shot2", "qwen3.8-flash-next")).toBe(true);
    // 8자 hex 가 아닌 꼬리는 이름의 일부다; 빈 이름끼리는 같지 않다
    expect(aiSameUnderlyingModel("qwen3.8-flash-next@latest", "qwen3.8-flash-next")).toBe(false);
    expect(aiSameUnderlyingModel("qwen3.8-flash-next", "qwen3.8-27b-nvfp4")).toBe(false);
    expect(aiSameUnderlyingModel("[supa] ", "")).toBe(false);
  });
});

describe("저장 전 준비 확인(aiRankReadiness)", () => {
  const policyRoutes = [
    { routeId: "crawl-tagline", provider: "abcllm", model: "Inferact/Qwen3.8-27B-NVFP4", providerBudgetId: "abcllm-supa", groupId: "supa" },
    { routeId: "local-audit", provider: "local-direct", model: "qwen3.8-flash-next", providerBudgetId: "gpu3090-qwen", groupId: "gpu3090-qwen" },
    { routeId: "product-intro-check", provider: "claude-cli", model: "sonnet", providerBudgetId: "claude-cli", groupId: "anthropic-cli" },
  ];
  // engineRoutes·cliContractRoutes 는 저장이 읽는 모양 그대로(admin-ai-tasks-repository readReadinessInput — 2차 second-review 도 엔진 직접 계약을 만든다, PR C1)
  const input = (patch: Partial<AiReadinessInput> = {}): AiReadinessInput => ({ contracts: [], localContract: () => null,
    engineRoutes: ["crawl-agent-review", "crawl-tagline", "reason-translate", "second-review"], cliContractRoutes: [...CLI_DB_CONTRACT_ROUTES],
    policy: { mode: "open", routes: policyRoutes, groupLimits: { "gpu3090-qwen": 4 } },
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
  it("엔진 경로(PR B): 같은 경로·모델 계약이 다른 서버면 연결로 가른 장부 이름으로 따로 계약·경로를 만든다; 정책 route 가 다른 장비면 막는다", () => {
    const other = aiRankReadiness(aiTask("crawl-tagline")!, 2, gpu, "qwen3.8-flash-next", input({ contracts: [{ routeId: "crawl-tagline", model: "qwen3.8-flash-next",
      provider: "abcllm", endpoint: "http://supa.test:8000/v1/chat/completions", transport: "direct" }] }));
    const alias = aiTaskAliasIdentity("qwen3.8-flash-next", GPU)!;
    expect(other).toMatchObject({ blocking: [], identity: alias, createContract: { routeId: "crawl-tagline", identity: alias, engineModel: "qwen3.8-flash-next" },
      appendRoute: { routeId: "crawl-tagline", provider: "abcllm", model: alias, groupId: "gpu3090-qwen" } });
    expect(other.warnings).toEqual([expect.stringContaining(`같은 모델 이름의 계약이 다른 서버(supa.test:8000)에 있어 이 연결은 장부 이름 ${alias}(으)로`)]);
    // 그 별칭 계약이 이미 이 연결을 가리키면 그것을 쓴다(만들지 않는다)
    const own = aiRankReadiness(aiTask("crawl-tagline")!, 2, gpu, "qwen3.8-flash-next", input({ contracts: [
      { routeId: "crawl-tagline", model: "qwen3.8-flash-next", provider: "abcllm", endpoint: "http://supa.test:8000/v1/chat/completions", transport: "direct" },
      { routeId: "crawl-tagline", model: alias, provider: "abcllm", endpoint: "http://100.77.43.63:8090/v1/chat/completions", transport: "direct", engineModel: "qwen3.8-flash-next" }] }));
    expect(own).toMatchObject({ blocking: [], identity: alias, createContract: null });
    // 1차(심사 묶음)도 PR C1 부터 같은 묶기다 — 같은 모델 계약이 다른 서버면 막지 않고 연결로 가른 장부 이름으로 따로 만든다
    const review = aiRankReadiness(aiTask("first-review")!, 2, gpu, "qwen3.8-flash-next", input({ contracts: [{ routeId: "crawl-agent-review", model: "qwen3.8-flash-next",
      provider: "abcllm", endpoint: "http://supa.test:8000/v1/chat/completions", transport: "direct" }] }));
    expect(review).toMatchObject({ blocking: [], identity: alias, provider: "abcllm",
      createContract: { routeId: "crawl-agent-review", replacesGateway: false, identity: alias, engineModel: "qwen3.8-flash-next" },
      appendRoute: { routeId: "crawl-agent-review", provider: "abcllm", model: alias, groupId: "gpu3090-qwen" } });
    const routed = aiRankReadiness(aiTask("crawl-tagline")!, 1, gpu, "Inferact/Qwen3.8-27B-NVFP4", input());
    expect(routed.blocking).toEqual([expect.stringContaining("경로는 장비 supa에 있습니다. 연결의 장비 이름을 supa(으)로 바꾸거나")]);
  });
  it("엔진 경로(PR B): 한 줄의 두 순위가 계약 없는 같은 모델을 다른 연결로 고르면 1순위는 이름 그대로, 2순위는 연결로 가른 이름으로 만든다", () => {
    const supaConnection = { ...supa, baseUrl: "http://supa.test:8000/v1" };
    const ready = aiRanksReadiness(aiTask("crawl-tagline")!, [{ rank: 1, connection: gpu, model: "qwen3.8-flash-next" },
      { rank: 2, connection: supaConnection, model: "qwen3.8-flash-next" }], input());
    expect(ready.map(row => [row.identity, row.createContract?.identity, row.createContract?.engineModel])).toEqual([
      ["qwen3.8-flash-next", "qwen3.8-flash-next", null], [aiTaskAliasIdentity("qwen3.8-flash-next", SUPA), aiTaskAliasIdentity("qwen3.8-flash-next", SUPA), "qwen3.8-flash-next"]]);
  });
  it("2차(PR C1): 엔진 직접 계약이 없으면 second-review 계약(abcllm 형)을 만들 것으로 적는다; 게이트웨이 계약뿐이면 그것을 갈음한다", () => {
    const task = aiTask("second-review")!;
    const ready = aiRankReadiness(task, 1, gpu, "qwen3.8-flash-next", input());
    expect(ready).toMatchObject({ blocking: [], provider: "abcllm", identity: "qwen3.8-flash-next", createCliContract: null,
      createContract: { routeId: "second-review", replacesGateway: false, identity: "qwen3.8-flash-next", engineModel: null },
      appendRoute: { routeId: "second-review", provider: "abcllm", model: "qwen3.8-flash-next", providerBudgetId: "gpu3090-qwen", groupId: "gpu3090-qwen" },
      createDevice: { deviceId: "gpu3090-qwen", limitSlots: 4 } });
    const gateway = aiRankReadiness(task, 1, gpu, "qwen3.8-flash-next", input({ contracts: [{ routeId: "second-review", model: "qwen3.8-flash-next", provider: "abcllm",
      endpoint: null, transport: "gateway" }] }));
    expect(gateway.createContract).toEqual({ routeId: "second-review", replacesGateway: true, identity: "qwen3.8-flash-next", engineModel: null });
    // 이 연결을 가리키는 계약(엔진 직접·local-direct)이 있으면 그것을 쓴다 — 만들지 않는다
    const own = aiRankReadiness(task, 1, gpu, "qwen3.8-flash-next", input({ contracts: [{ routeId: "second-review", model: "qwen3.8-flash-next", provider: "local-direct",
      endpoint: "http://100.77.43.63:8090/v1/chat/completions", transport: "gateway" }] }));
    expect(own).toMatchObject({ createContract: null, provider: "local-direct", identity: "qwen3.8-flash-next" });
    // 2차를 엔진 경로로 받지 않는 입력이면(예전 모양) 만들 수 없어 막는다 — 저장이 읽는 입력은 second-review 를 넣는다
    expect(aiRankReadiness(task, 1, gpu, "qwen3.8-flash-next", input({ engineRoutes: ["crawl-agent-review"] })).blocking)
      .toEqual([expect.stringContaining("second-review 경로의 연결 계약이 없고 자동으로 만들 수 없습니다.")]);
  });
  it("2차(PR C1): 같은 모델 이름의 2차 계약이 다른 서버면 연결로 가른 장부 이름(<모델>@<연결 8자>)으로 따로 계약·경로를 만든다", () => {
    const task = aiTask("second-review")!, alias = aiTaskAliasIdentity("qwen3.8-flash-next", GPU)!;
    expect(alias).toBe(`qwen3.8-flash-next@${GPU.slice(0, 8)}`);
    const plain = { routeId: "second-review", model: "qwen3.8-flash-next", provider: "abcllm", endpoint: "http://supa.test:8000/v1/chat/completions", transport: "direct" };
    const ready = aiRankReadiness(task, 2, gpu, "qwen3.8-flash-next", input({ contracts: [plain] }));
    expect(ready).toMatchObject({ blocking: [], identity: alias, provider: "abcllm",
      createContract: { routeId: "second-review", replacesGateway: false, identity: alias, engineModel: "qwen3.8-flash-next" },
      appendRoute: { routeId: "second-review", provider: "abcllm", model: alias, groupId: "gpu3090-qwen" } });
    expect(ready.warnings).toEqual([expect.stringContaining(`같은 모델 이름의 계약이 다른 서버(supa.test:8000)에 있어 이 연결은 장부 이름 ${alias}(으)로`)]);
    expect(aiRankPendingText(ready)).toEqual(expect.arrayContaining([expect.stringContaining(
      `second-review 엔진 직접 계약이 없습니다 — 이 줄을 저장하면 엔진을 확인하고 만듭니다(같은 모델이 다른 서버에도 있어 장부 이름 ${alias})`)]));
    // 그 별칭 계약이 다른 서버를 가리키면 막는다(모델 연결 화면에서 고친다)
    const taken = aiRankReadiness(task, 2, gpu, "qwen3.8-flash-next", input({ contracts: [plain,
      { routeId: "second-review", model: alias, provider: "abcllm", endpoint: "http://other.test:9000/v1/chat/completions", transport: "direct", engineModel: "other" }] }));
    expect(taken.blocking).toEqual([expect.stringContaining(`second-review 경로의 ${alias} 계약이 다른 서버(other.test:9000)를 가리킵니다.`)]);
    expect(taken.createContract).toBeNull();
  });
  it("CLI 순위(PR C1): 1차·2차·Grok 로그인 유지는 연결의 CLI 버전이 있어야 하고, 그 버전으로 CLI 계약(cli:<도구>:<경로>)을 만든다", () => {
    const cliRow = (routeId: string, model: string, cliVersion: string) => ({ routeId: `cli:${routeId}`, model, provider: null, endpoint: null, transport: "gateway", cliVersion });
    // 버전이 없으면 막는다 — 계약을 만들 수 없다
    const missing = aiRankReadiness(aiTask("first-review")!, 1, claude, "sonnet", input());
    expect(missing.blocking).toEqual(["1순위 Claude CLI · sonnet: 연결에 CLI 버전이 없습니다. AI 연결에서 「CLI 버전」(워커의 `claude --version` 출력 그대로)을 적은 뒤 저장하세요."]);
    expect(missing).toMatchObject({ provider: "claude-cli", createCliContract: null });
    expect(missing.warnings).toEqual([]);
    // 버전이 있으면 그 버전으로 만든다 — 확인은 워커가 부를 때 한다(경고)
    const versioned = { ...claude, cliVersion: "2.1.0 (Claude Code)" };
    const ready = aiRankReadiness(aiTask("first-review")!, 1, versioned, "sonnet", input());
    expect(ready).toMatchObject({ blocking: [], provider: "claude-cli",
      createCliContract: { routeId: "crawl-agent-review", provider: "claude-cli", model: "sonnet", cliVersion: "2.1.0 (Claude Code)", replaces: null },
      appendRoute: { routeId: "crawl-agent-review", provider: "claude-cli", model: "sonnet", providerBudgetId: "claude-cli", groupId: "anthropic-cli" } });
    expect(ready.warnings).toEqual([expect.stringContaining("CLI 버전(2.1.0 (Claude Code))은 이 화면이 확인하지 못합니다")]);
    expect(aiRankPendingText(ready)[0]).toBe("1순위 sonnet: crawl-agent-review CLI 계약이 없습니다 — 이 줄을 저장하면 연결의 CLI 버전(2.1.0 (Claude Code))으로 만듭니다.");
    // 같은 버전의 계약 행이 이미 있으면 만들지 않는다; 버전이 다르면 그 버전을 바꾼다
    expect(aiRankReadiness(aiTask("first-review")!, 1, versioned, "sonnet", input({ contracts: [cliRow("claude-cli:crawl-agent-review", "sonnet", "2.1.0 (Claude Code)")] }))
      .createCliContract).toBeNull();
    const stale = aiRankReadiness(aiTask("first-review")!, 1, versioned, "sonnet", input({ contracts: [cliRow("claude-cli:crawl-agent-review", "sonnet", "2.0.9 (Claude Code)")] }));
    expect(stale.createCliContract).toEqual({ routeId: "crawl-agent-review", provider: "claude-cli", model: "sonnet", cliVersion: "2.1.0 (Claude Code)", replaces: "2.0.9 (Claude Code)" });
    expect(aiRankPendingText(stale)[0]).toContain("CLI 계약이 버전 2.0.9 (Claude Code)입니다 — 이 줄을 저장하면 연결의 CLI 버전(2.1.0 (Claude Code))으로 바꿉니다.");
    // 다른 도구·다른 경로·다른 모델의 계약 행은 이 순위의 것이 아니다
    expect(aiRankReadiness(aiTask("first-review")!, 1, versioned, "sonnet", input({ contracts: [cliRow("grok-cli:crawl-agent-review", "sonnet", "2.1.0 (Claude Code)"),
      cliRow("claude-cli:second-review", "sonnet", "2.1.0 (Claude Code)"), cliRow("claude-cli:crawl-agent-review", "opus", "2.1.0 (Claude Code)")] })).createCliContract)
      .toMatchObject({ routeId: "crawl-agent-review", replaces: null });
    // 2차·Grok 로그인 유지도 같은 규칙(경로마다 따로)
    const grok = { ...CONNECTIONS[3], cliVersion: "grok 0.9.1" };
    expect(aiRankReadiness(aiTask("second-review")!, 1, grok, "grok-4.7", input()).createCliContract)
      .toEqual({ routeId: "second-review", provider: "grok-cli", model: "grok-4.7", cliVersion: "grok 0.9.1", replaces: null });
    expect(aiRankReadiness(aiTask("grok-session-check")!, 1, grok, "grok-4.7", input()).createCliContract)
      .toEqual({ routeId: "grok-session-check", provider: "grok-cli", model: "grok-4.7", cliVersion: "grok 0.9.1", replaces: null });
    expect(aiRankReadiness(aiTask("second-review")!, 1, CONNECTIONS[3], "grok-4.7", input()).blocking)
      .toEqual([expect.stringContaining("연결에 CLI 버전이 없습니다. AI 연결에서 「CLI 버전」(워커의 `grok --version` 출력 그대로)")]);
    // CLI 계약을 DB 로 만들지 않는 경로(소개 검수)는 버전이 있어도 예전처럼 경고만
    const intro = aiRankReadiness(aiTask("product-intro-check")!, 1, versioned, "opus", input());
    expect(intro).toMatchObject({ blocking: [], createCliContract: null });
    expect(intro.warnings).toEqual([expect.stringContaining("CLI 계약(connect 에이전트 쪽)은 이 화면이 확인하지 못합니다")]);
  });
  it.each(["product-intro-check", "product-audit"])("%s OpenCode는 실제 DB 계약 준비를 요청한다", id => {
    const model = "opencode-go/deepseek-v4.1-flash";
    const opencode = { ...claude, label: "OpenCode", cliTool: "opencode" as const, cliVersion: "2.2.5", cliModels: [model], hasKey: true };
    const ready = aiRankReadiness(aiTask(id)!, 1, opencode, model, input());
    expect(ready.blocking).toEqual([]);
    expect(ready.createCliContract).toEqual({ routeId: id, provider: "opencode-cli", model, cliVersion: "2.2.5", replaces: null });
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

describe("지금 설정 → 가져오기 출처(buildAiCurrentSlots) — 1차·2차·Grok 은 옛 설정(PR C1)", () => {
  const MODEL_ENV = { translate: "", productTranslate: "", tagline: "", profile: "", verify: "", introCheck: "" } satisfies ModelEnv;
  const current = (settings: CrawlSettings) => buildAiCurrentSlots({ settings, modelEnv: MODEL_ENV, policy: null, agent: null, auditCampaign: null, tableOn: false, env: {} });
  const legacy: CrawlSettings = { ...DEFAULT_CRAWL_SETTINGS, firstReview: { provider: "claude-cli", model: "haiku" },
    firstReviewAdditional: [{ provider: "grok-cli", model: "grok-4.7-fast" }],
    secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, voters: [{ provider: "claude-cli", model: "opus" }, { provider: "grok-cli", model: "grok-4.7" }],
      fallbacks: [{ provider: "claude-cli", model: "sonnet" }, { provider: "claude-cli", model: "Opus" }] } };
  it("2차: 옛 대체 모델은 그것을 받을 수 있는 첫 칸에만 2·3순위로 넣고, 다음 칸에서는 빼며(알림), 투표자와 같은 대체는 옮기지 않는다", () => {
    const slots = current(legacy).filter(slot => slot.task === "second-review");
    expect(slots.map(slot => [slot.slot, slot.uses.map(use => `${use.provider}:${use.model}(${use.origin})`), slot.skip])).toEqual([
      [1, ["claude-cli:opus(secondReview.voters[0])", "claude-cli:sonnet(secondReview.fallbacks[0])"], null],
      [2, ["grok-cli:grok-4.7(secondReview.voters[1])"], null],
      [3, [], "투표자 3이(가) 없습니다."],
    ]);
    expect(slots.every(slot => slot.source === "옛 설정 secondReview(가져오기 출처)")).toBe(true);
    expect(slots[0].notes).toEqual(["2·3순위는 옛 2차 대체 목록입니다 — 순위로 옮기면 이 칸의 투표자가 쓸 수 없을 때만 이 칸의 표를 냅니다.",
      "대체 Opus은(는) 투표자와 같은 모델이라 옮기지 않습니다."]);
    expect(slots[1].notes).toEqual([
      "대체 sonnet은(는) 앞 투표자 칸의 2·3순위로만 옮깁니다 — 한 모델이 한 항목에 두 표를 내지 않게 이 칸에서는 뺍니다.",
      "대체 Opus은(는) 투표자와 같은 모델이라 옮기지 않습니다."]);
    // 가져오기 계획도 대체 모델을 칸 1 에만 둔다 — 저장 검증(한 모델은 한 칸)과 어긋나지 않는다
    const plan = buildAiImportPlan({ connections: [], rows: [], deviceSlots: new Map(), hostEquipment: new Map(), current: slots });
    expect(plan.slots.map(row => [row.task, row.slot, row.ranks.map(rank => `${rank.rank}:${rank.connectionKey}:${rank.model}`)])).toEqual([
      ["second-review", 1, ["1:cli:claude:opus", "2:cli:claude:sonnet"]], ["second-review", 2, ["1:cli:grok:grok-4.7"]]]);
  });
  it("1차·Grok 로그인 유지도 옛 설정에서 가져온다(1차 = firstReview → firstReviewAdditional, Grok = 옛 1·2차의 Grok 심사자)", () => {
    const slots = current(legacy);
    const by = (task: string) => slots.find(slot => slot.task === task)!;
    expect(by("first-review")).toMatchObject({ source: "옛 설정 firstReview · firstReviewAdditional(가져오기 출처)", skip: null });
    expect(by("first-review").uses.map(use => [use.provider, use.model, use.origin])).toEqual([["claude-cli", "haiku", "firstReview"],
      ["grok-cli", "grok-4.7-fast", "firstReviewAdditional[0]"]]);
    expect(by("grok-session-check").uses.map(use => [use.cliTool, use.model])).toEqual([["grok", "grok-4.7"]]);
    const empty = current({ ...DEFAULT_CRAWL_SETTINGS, firstReview: undefined, firstReviewAdditional: [],
      secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, voters: [{ provider: "claude-cli", model: "opus" }], fallbacks: [] } });
    expect(empty.find(slot => slot.task === "first-review")).toMatchObject({ uses: [], skip: "옛 설정에 1차 심사자가 없습니다." });
    expect(empty.find(slot => slot.task === "grok-session-check")).toMatchObject({ uses: [], skip: "옛 설정에 Grok 심사자가 없습니다." });
  });
});

describe("RankSelects — 작업 ↔ 모델 꼴(provider 칸 = 연결 id)", () => {
  it("검증·안내를 받아 그리고 제공자 이름을 덧붙이지 않는다; 고른 값은 rank<N>Connection·rank<N>Model 로 보낸다", () => {
    const options = aiTaskRankOptions(aiTask("crawl-tagline")!, CONNECTIONS, []);
    const html = renderToStaticMarkup(createElement(RankSelects<{ provider: string; model: string }>, { stage: { id: "crawl-tagline-1", label: "수집 소개 짓기", slots: 3 }, options,
      value: [pick(GPU, "qwen3.8-flash-next"), null, pick(SUPA, "qwen3.8-flash-next")], connections: CONNECTIONS, slotNames: AI_RANK_SLOT_NAMES, onChange: () => {}, showProvider: false,
      validate: slots => validateAiTaskRanks("crawl-tagline", 1, slots, { connections: CONNECTIONS, rows: [] }), note: createElement("p", null, "안내") }));
    // 연결·전송별로 묶고, 모델 이름 옆에 실시간 관측 상태를 표시한다.
    expect(html).toContain(`<optgroup label="gpu3090 · API"><option value="${GPU}/qwen3.8-flash-next" selected="">qwen3.8-flash-next · `);
    expect(html).toContain('<optgroup label="검색 서버 · API"><option value="55555555-5555-4555-8555-555555555555/bge-m3">bge-m3 · ');
    expect(html).not.toContain("gpu3090 · qwen3.8-flash-next");
    // 모델 이름이 같아도 연결·전송과 숨은 원래 모델 바인딩을 구분한다.
    expect(html.match(/data-rank-server="true">([^<]*)</g)).toEqual(['data-rank-server="true">gpu3090 · API<', 'data-rank-server="true">supa · API<']);
    expect(html).not.toContain("(abcllm)");
    expect(html).toContain(`name="rank1Connection" value="${GPU}"`);
    expect(html).toContain('name="rank3Model" value="qwen3.8-flash-next"');
    expect(html).toContain("2순위를 비우고 그 뒤 순위만 고를 수 없습니다.");
    expect(html).toContain("<p>안내</p>");
    expect(html).not.toContain("워커는 30초 주기로 설정을 다시 읽어");
    // 묶음이 없는 선택지(1차 AI 검수 꼴)는 예전처럼 한 줄 이름 그대로
    const flat = renderToStaticMarkup(createElement(RankSelects<{ provider: string; model: string }>, { stage: { id: "x-1", label: "x", slots: 1 },
      options: [{ provider: "supa", model: "m", label: "supa · m" }], value: [null], slotNames: AI_RANK_SLOT_NAMES, onChange: () => {}, validate: () => [] }));
    expect(flat).not.toContain("<optgroup");
    expect(flat).toContain(">supa · m (supa) · ");
  });
  it("compact 에서도 「N순위」 글을 보이고, blocked 는 모델 조건에 맞지 않는 선택지만 흐리게 둔다", () => {
    const options = aiTaskRankOptions(aiTask("product-embedding")!, CONNECTIONS, []);
    const html = renderToStaticMarkup(createElement(RankSelects<{ provider: string; model: string }>, { stage: { id: "product-embedding-1", label: "제품 의미 검색 벡터", slots: 3 },
      options, value: [pick(EMB, "bge-m3"), null, null], slotNames: AI_RANK_SLOT_NAMES, onChange: () => {}, showProvider: false, compact: true, note: null,
      validate: () => [], blocked: (option, index, slots) => aiRankOptionBlocked(aiTask("product-embedding")!, 1, index, option, slots, []) }));
    expect(html).toContain('<span class="block font-semibold" data-compact="true">1순위</span>');
    const second = html.slice(html.indexOf('name="product-embedding-1-rank-2"'), html.indexOf('name="product-embedding-1-rank-3"'));
    expect(second).toContain(`value="${EMB}/bge-m3-q8" disabled=""`);
    expect(second).toContain(`value="${GPU}/qwen3.8-flash-next" disabled=""`);
    // 1순위와 같은 연결·모델도 반복 선택할 수 있지만 다른 모델의 벡터 공간은 섞지 않는다.
    expect(second).toContain(`value="${EMB}/bge-m3">bge-m3 · `);
    expect(second).not.toContain(`value="${EMB}/bge-m3" disabled=""`);
    const first = html.slice(0, html.indexOf('name="product-embedding-1-rank-2"'));
    expect(first).not.toContain('disabled=""');
  });
  it("드롭다운 열쇠는 HTML 이 바꾸지 않는 글자만 쓴다 — 서버가 그린 <option value> 를 브라우저가 읽어도 rankOptionKey 와 같다(2026-11-02 NUL 사고)", () => {
    // 예전 열쇠(provider\u0000model)는 HTML 파서가 U+FFFD 로 바꿔 고른 값이 선택지와 맞지 않았고, 드롭다운이 「없음」으로 돌아가 저장 한 번에 순위가 비워졌다
    const tricky = [pick(GPU, "qwen3.8-flash-next"), pick("claude-cli", "sonnet"), pick(GPU, "mlx-community/gemma-4 26b"), pick(GPU, "a&b<c>\"d'e"), pick(GPU, "모델")];
    for (const row of tricky) expect(rankOptionKey(row)).toMatch(/^[A-Za-z0-9\-_.!~*'()%/]+$/);
    // 「/」를 품은 값도 서로 다른 짝이 같은 열쇠가 되지 않는다
    expect(rankOptionKey(pick("a/b", "c"))).not.toBe(rankOptionKey(pick("a", "b/c")));
    const options = [...aiTaskRankOptions(aiTask("crawl-tagline")!, CONNECTIONS, []), { provider: GPU, model: "mlx-community/gemma 4", label: "gpu3090 · x", group: "gpu3090", text: "x" }];
    const html = renderToStaticMarkup(createElement(RankSelects<{ provider: string; model: string }>, { stage: { id: "crawl-tagline-1", label: "수집 소개 짓기", slots: 3 }, options,
      value: [pick(GPU, "qwen3.8-flash-next"), null, null], slotNames: AI_RANK_SLOT_NAMES, onChange: () => {}, showProvider: false, validate: () => [], note: null }));
    const values = [...html.matchAll(/<option value="([^"]*)"/g)].map(match => match[1]);
    expect(values.filter(Boolean)).toEqual(expect.arrayContaining(options.map(option => rankOptionKey(option).replaceAll("'", "&#x27;"))));
    // 제어 글자(NUL 등)는 하나도 없다
    expect(values.some(value => /[\u0000-\u001f\u007f]/.test(value))).toBe(false);
  });
  it("「없음」이 아닌데 선택지에 없는 값이 오면 칸을 비우지 않는다 — 조용히 비운 채 저장되지 않게", () => {
    const options = aiTaskRankOptions(aiTask("crawl-tagline")!, CONNECTIONS, []);
    const changes: unknown[] = [];
    // This existing event-handler guard constructs the tree directly; only its new live-observation dependency is stubbed.
    const availability = vi.spyOn(modelAvailability, "useModelAvailability").mockReturnValue({ value: null, loading: false, failed: false });
    let tree: ReturnType<typeof RankSelects<{ provider: string; model: string }>>;
    try { tree = RankSelects<{ provider: string; model: string }>({ stage: { id: "crawl-tagline-1", label: "수집 소개 짓기", slots: 3 }, options,
      value: [pick(GPU, "qwen3.8-flash-next"), null, null], slotNames: AI_RANK_SLOT_NAMES, onChange: value => changes.push(value), showProvider: false, validate: () => [], note: null }); }
    finally { availability.mockRestore(); }
    const selects: { props: { name: string; onChange: (event: { target: { value: string } }) => void } }[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== "object" || !("props" in node)) return;
      const element = node as { type: unknown; props: { children?: unknown } };
      if (element.type === "select") selects.push(element as never);
      walk(element.props.children);
    };
    walk(tree);
    expect(selects).toHaveLength(3);
    // 브라우저가 바꾼 옛 열쇠 꼴(U+FFFD) — 찾지 못하므로 아무것도 바꾸지 않는다
    selects[0].props.onChange({ target: { value: `${GPU}\ufffdqwen3.8-flash-next` } });
    expect(changes).toEqual([]);
    // 맞는 열쇠는 그 값으로, 「없음」(빈 값)은 그 칸만 비운다
    selects[1].props.onChange({ target: { value: rankOptionKey(pick(SUPA, "qwen3.8-flash-next")) } });
    selects[0].props.onChange({ target: { value: "" } });
    expect(changes).toEqual([[pick(GPU, "qwen3.8-flash-next"), pick(SUPA, "qwen3.8-flash-next"), null], [null, null, null]]);
  });
});

describe("text 경로에 순위가 없을 때 가져오기 출처 = 켜진 엔진 직접 계약 하나(합친 배포 — A·B·C1 을 한 번에 올려도 가져오기가 비지 않게)", () => {
  const MODEL_ENV = { translate: "", productTranslate: "", tagline: "", profile: "", verify: "", introCheck: "" } satisfies ModelEnv;
  const current = () => buildAiCurrentSlots({ settings: DEFAULT_CRAWL_SETTINGS, modelEnv: MODEL_ENV, policy: null, agent: null, auditCampaign: null, tableOn: false, env: {} });
  it("계약이 하나면 그 계약(주소·저장 키)을 1순위로 옮기고, 둘 이상이거나 없으면 지어내지 않고 건너뛴다", async () => {
    const { setServingContractSnapshotForTest } = await import("@/lib/llm/serving-contract-store");
    const { setAiTaskModelsForTest } = await import("@/lib/llm/ai-task-models-snapshot");
    const direct = (routeId: string, model: string, endpoint: string, apiKey: string | null = null) =>
      ({ routeId, model, contract: { routeId, model, endpoint }, auth: apiKey ? "stored" as const : "none" as const, apiKey, transport: "direct" as const });
    setAiTaskModelsForTest([]);
    setServingContractSnapshotForTest([
      direct("reason-translate", "gpt-oss-120b", "http://m3.test:8014/v1/chat/completions", "k"),
      direct("crawl-tagline", "supa", "http://supa.test:8000/v1/chat/completions"),
      direct("product-search-verify", "supa", "http://supa.test:8000/v1/chat/completions"),
      direct("product-search-verify", "other", "http://other.test:8000/v1/chat/completions"),
    ]);
    try {
      const slots = current();
      const by = (task: string) => slots.find(slot => slot.task === task)!;
      expect(by("reason-translate").skip).toBeNull();
      expect(by("reason-translate").uses.map(use => [use.baseUrl, use.model, use.keyFrom])).toEqual([["http://m3.test:8014/v1", "gpt-oss-120b", { routeId: "reason-translate", model: "gpt-oss-120b" }]]);
      expect(by("crawl-tagline").uses.map(use => [use.baseUrl, use.model, use.keyFrom])).toEqual([["http://supa.test:8000/v1", "supa", null]]);
      expect(by("product-search-verify").uses).toEqual([]);
      expect(by("product-search-verify").skip).toContain("no_task_models");
      expect(by("product-translate").uses).toEqual([]);
    } finally {
      setServingContractSnapshotForTest(null);
      setAiTaskModelsForTest(null);
    }
  });
});
