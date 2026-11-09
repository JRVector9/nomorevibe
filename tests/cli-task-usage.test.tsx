import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), rows: vi.fn(), save: vi.fn(), revalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock("@/lib/operations/admin-ai-tasks-repository", () => ({ listAiTaskRows: mocks.rows, saveAiTaskRanks: mocks.save,
  aiTaskSlotRevision: (rows: readonly { rank: number; model: string; options: unknown }[]) =>
    (JSON.stringify(rows.map(row => [row.rank, row.model, row.options])).length.toString(16) + "0".repeat(64)).slice(0, 64) }));

import { saveCliTaskModelAction } from "@/app/(operator)/admin/models/devices/cli-actions";
import { CliTaskRows } from "@/app/(operator)/admin/models/devices/CliTaskRows";
import { reviewCliArgs } from "@/lib/crawl/agent-review";
import { cliArgs as codexClassifyArgs } from "@/lib/crawl/classify";
import { introCheckCliArgs } from "@/lib/domain/products/intro-check";
import { aiTaskReasoningEfforts } from "@/lib/llm/ai-task-reasoning";
import { AI_TASKS } from "@/lib/llm/ai-tasks";
import { claudeClassificationArgs } from "@/lib/operations/claude";
import type { AiConnectionView, AiCurrentSlot, AiTaskRankRow } from "@/lib/operations/admin-ai-tasks";
import { buildCliTaskUsages, CLAUDE_INTRO_CHECK_EFFORT, CLAUDE_REVIEW_DEFAULT_EFFORT, CLI_TASK_EDIT_STALE, cliTaskModelEdit, cliTaskModelEditFromForm,
  cliTaskUsagesByDevice, parseCliClassifierObservation, type CliTaskUsageInput } from "@/lib/operations/cli-task-usage";

const CLAUDE = "11111111-1111-4111-8111-111111111111", OPENCODE = "22222222-2222-4222-8222-222222222222";
const base = { baseUrl: null, host: null, hasKey: false, models: null, modelsReadAt: null, modelsError: null, capacitySlots: 2, contextTokens: null,
  enabled: true, version: 1, note: null, updatedBy: "t", updatedAt: "2026-11-09T00:00:00Z", cliVersion: "2.1.0" } as const;
const claude: AiConnectionView = { ...base, id: CLAUDE, label: "Claude CLI", kind: "cli", cliTool: "claude", cliModels: ["sonnet", "opus", "haiku"], deviceId: "anthropic-cli" };
const opencode: AiConnectionView = { ...base, id: OPENCODE, label: "M3 OpenCode", kind: "cli", cliTool: "opencode", cliModels: ["opencode/deepseek-v4.1-flash"], deviceId: "m3-opencode-host" };
const row = (task: string, slot: number, rank: number, model: string, options: Record<string, unknown> = {}, connectionId = CLAUDE): AiTaskRankRow =>
  ({ task, slot, rank, connectionId, model, options, enabled: true });
const revisionOf = (rows: readonly AiTaskRankRow[]) => (JSON.stringify(rows.map(entry => [entry.rank, entry.model, entry.options])).length.toString(16) + "0".repeat(64)).slice(0, 64);
const introCurrent: AiCurrentSlot = { task: "product-intro-check", slot: 1, source: "단계 풀", error: null, skip: null, notes: [],
  uses: [{ kind: "cli", baseUrl: null, cliTool: "claude", model: "sonnet", provider: "claude-cli", origin: "stageModelPools.product-intro-check[0]", deviceId: "anthropic-cli", keyFrom: null }] };
const input = (patch: Partial<CliTaskUsageInput> = {}): CliTaskUsageInput => ({
  connections: [claude, opencode],
  rows: [row("first-review", 1, 1, "sonnet", { reasoningEffort: "high" }), row("first-review", 1, 2, "opencode/deepseek-v4.1-flash", {}, OPENCODE),
    row("second-review", 2, 1, "opus"), row("product-intro-check", 1, 1, "sonnet")],
  revisionOf, executions: [], current: [introCurrent],
  classifier: { observedAt: "2026-11-09T00:00:00.000Z", fresh: true, models: [{ rank: 1, model: "gpt-6-astra", effort: "xhigh", provider: "codex-cli" },
    { rank: 2, model: "sonnet", effort: "high", provider: "claude-cli" }] },
  routes: [{ routeId: "crawl-publish-classify", provider: "codex-cli", model: "gpt-6-astra", groupId: "openai-cli" }],
  ...patch,
});

describe("CLI 어댑터가 추론 강도를 실제로 넘기는 곳(조사 고정)", () => {
  it("1차·2차 Claude CLI: 순위 강도가 --effort 로 나가고, 없으면 low", () => {
    const args = reviewCliArgs("opus", "medium");
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual(["--effort", "medium"]);
    expect(CLAUDE_REVIEW_DEFAULT_EFFORT).toBe("low");
    expect(aiTaskReasoningEfforts("first-review", "claude", "sonnet")).toEqual(["low", "medium", "high"]);
    expect(aiTaskReasoningEfforts("second-review", "claude", "opus")).toEqual(["low", "medium", "high"]);
    expect(aiTaskReasoningEfforts("first-review", "claude", "haiku")).toEqual([]);
  });
  it("소개 검수·connect 분류는 순위 강도를 읽지 않는다 — Claude 는 high 고정, Codex 는 connect 설정의 model_reasoning_effort", () => {
    const intro = introCheckCliArgs("sonnet");
    expect(intro[intro.indexOf("--effort") + 1]).toBe("high");
    expect(CLAUDE_INTRO_CHECK_EFFORT).toBe("high");
    const claudeClassify = claudeClassificationArgs("sonnet");
    expect(claudeClassify[claudeClassify.indexOf("--effort") + 1]).toBe("high");
    expect(codexClassifyArgs("gpt-6-astra", "xhigh")).toEqual(expect.arrayContaining(["-m", "gpt-6-astra", "-c", 'model_reasoning_effort="xhigh"']));
    // 순위 강도를 받는 곳이 없으니 고를 수도 없다
    for (const task of ["product-intro-check", "publish-classify"]) expect(aiTaskReasoningEfforts(task, "claude", "sonnet")).toEqual([]);
    for (const task of AI_TASKS) expect(aiTaskReasoningEfforts(task.id, "codex", "gpt-6-astra")).toEqual([]);
  });
});

describe("buildCliTaskUsages", () => {
  it("순위를 읽는 작업의 Claude 순위만 고칠 수 있고, 소개 검수·분류는 실제 출처를 읽기만 한다", () => {
    const { usages, unavailable } = buildCliTaskUsages(input());
    expect(unavailable).toEqual([]);
    expect(usages.map(usage => usage.key)).toEqual(["rank:first-review:1:1", "rank:second-review:2:1", "current:product-intro-check:1:0", "connect:1", "connect:2"]);
    const [first, second, intro, codex, claudeClassify] = usages;
    expect(first).toMatchObject({ deviceId: "anthropic-cli", cliTool: "claude", where: "1순위", model: "sonnet", effort: "high", defaultEffort: "low",
      models: ["sonnet", "opus", "haiku"], readOnly: null });
    expect(first.effortsByModel).toEqual({ sonnet: ["low", "medium", "high"], opus: ["low", "medium", "high"], haiku: [] });
    expect(first.edit?.revision).toBe(revisionOf([row("first-review", 1, 1, "sonnet", { reasoningEffort: "high" }), row("first-review", 1, 2, "opencode/deepseek-v4.1-flash", {}, OPENCODE)]));
    expect(second).toMatchObject({ taskLabel: "2차 AI 검수 · 투표자 2", where: "투표자 2 · 1순위", effort: null });
    expect(intro).toMatchObject({ source: "current", model: "sonnet", effort: "high", edit: null, deviceId: "anthropic-cli",
      readOnly: { href: "/admin/models/advanced#model-settings", reason: "추론 강도는 어댑터가 high로 고정합니다" } });
    expect(codex).toMatchObject({ cliTool: "codex", deviceId: "openai-cli", model: "gpt-6-astra", effort: "xhigh", where: "connect 우선", edit: null,
      readOnly: { href: "/admin/status?tab=ai" } });
    expect(codex.effortsByModel).toEqual({ "gpt-6-astra": ["high", "xhigh"] });
    expect(claudeClassify).toMatchObject({ cliTool: "claude", deviceId: "anthropic-cli", where: "connect 예비" });
    const { byDevice, unmapped } = cliTaskUsagesByDevice(usages);
    expect(Object.keys(byDevice)).toEqual(["anthropic-cli", "openai-cli"]);
    expect(byDevice["anthropic-cli"]).toHaveLength(4);
    expect(unmapped).toEqual([]);
  });
  it("작업 분산 칸·꺼진 연결의 순위는 읽기만, 분산 구성원은 따로 보이고 못 읽은 출처는 문장으로 남긴다", () => {
    const { usages, unavailable } = buildCliTaskUsages(input({
      connections: [{ ...claude, enabled: true }, opencode],
      rows: [row("first-review", 1, 1, "sonnet")],
      executions: [{ task: "first-review", slot: 1, mode: "workload_pool", members: [{ memberId: "m1", position: 1, connectionId: CLAUDE, model: "opus",
        options: { reasoningEffort: "medium" }, deviceId: "anthropic-cli" }] }],
      current: null, classifier: null }));
    expect(usages.map(usage => [usage.key, usage.edit, usage.readOnly?.reason])).toEqual([
      ["rank:first-review:1:1", null, "작업 분산을 쓰는 칸이라 이 순위는 실행에 쓰이지 않습니다"],
      ["pool:m1", null, "작업 분산 구성원입니다"]]);
    expect(usages[1]).toMatchObject({ effort: "medium", where: "작업 분산 1번" });
    expect(unavailable).toHaveLength(2);
    const off = buildCliTaskUsages(input({ connections: [{ ...claude, enabled: false }], rows: [row("first-review", 1, 1, "sonnet")], current: [], classifier: null }));
    expect(off.usages[0]).toMatchObject({ edit: null, readOnly: { reason: "연결이 꺼져 있습니다", href: "/admin/models/tasks#execution-first-review-1" } });
  });
  it("connect 관측에서 우선·예비 모델·강도만 읽는다", () => {
    const parsed = parseCliClassifierObservation("2026-11-09T00:00:00.000Z", { config: { primary: { model: "gpt-6-astra", effort: "xhigh" }, fallback: null },
      modelOptions: [{ model: "gpt-6-astra", provider: "codex-cli" }], accounts: { codex: { secret: "x" } } }, Date.parse("2026-11-09T00:01:00Z"));
    expect(parsed).toEqual({ observedAt: "2026-11-09T00:00:00.000Z", fresh: true, models: [{ rank: 1, model: "gpt-6-astra", effort: "xhigh", provider: "codex-cli" }] });
    expect(parseCliClassifierObservation("bad", {})).toBeNull();
  });
});

describe("한 순위만 바꾼 같은 칸 저장 입력", () => {
  const rows = [row("first-review", 1, 1, "sonnet", { reasoningEffort: "high", custom: 1 }), row("first-review", 1, 2, "opus", { reasoningEffort: "low" })];
  const request = { task: "first-review", slot: 1, rank: 2, revision: revisionOf(rows), connectionId: CLAUDE, model: "sonnet", reasoningEffort: "medium" };
  it("나머지 순위는 저장된 그대로, 바꾼 순위만 새 모델·강도", () => {
    expect(cliTaskModelEdit(rows, request, revisionOf)).toEqual({ ok: true, changed: true, input: { task: "first-review", slot: 1, revision: request.revision,
      ranks: [{ provider: CLAUDE, model: "sonnet", reasoningEffort: "high" }, { provider: CLAUDE, model: "sonnet", reasoningEffort: "medium" }] } });
    const cleared = cliTaskModelEdit(rows, { ...request, model: "opus", reasoningEffort: "" }, revisionOf);
    expect(cleared).toMatchObject({ ok: true, changed: true });
    if (cleared.ok) expect(cleared.input.ranks[1]).toEqual({ provider: CLAUDE, model: "opus", reasoningEffort: "" });
    expect(cliTaskModelEdit(rows, { ...request, model: "opus", reasoningEffort: "low" }, revisionOf)).toMatchObject({ ok: true, changed: false });
  });
  it("판·연결이 다르거나, 꺼진 순위가 있거나, 순위를 읽지 않는 작업이면 거절한다", () => {
    expect(cliTaskModelEdit(rows, { ...request, revision: "f".repeat(64) }, revisionOf)).toEqual({ ok: false, issue: CLI_TASK_EDIT_STALE });
    expect(cliTaskModelEdit(rows, { ...request, connectionId: OPENCODE }, revisionOf)).toEqual({ ok: false, issue: CLI_TASK_EDIT_STALE });
    expect(cliTaskModelEdit(rows, { ...request, rank: 3 }, revisionOf)).toEqual({ ok: false, issue: CLI_TASK_EDIT_STALE });
    const disabled = [rows[0], { ...rows[1], enabled: false }];
    expect(cliTaskModelEdit(disabled, { ...request, revision: revisionOf(disabled) }, revisionOf)).toMatchObject({ ok: false, issue: expect.stringContaining("꺼진 순위") });
    const intro = [row("product-intro-check", 1, 1, "sonnet")];
    expect(cliTaskModelEdit(intro, { ...request, task: "product-intro-check", rank: 1, revision: revisionOf(intro) }, revisionOf))
      .toMatchObject({ ok: false, issue: expect.stringContaining("읽지 않아") });
  });
  it("폼 값의 모양을 확인한다", () => {
    const form = new FormData();
    for (const [key, value] of Object.entries({ ...request, slot: "1", rank: "2" })) form.set(key, String(value));
    expect(cliTaskModelEditFromForm(form)).toEqual(request);
    form.set("reasoningEffort", "");
    expect(cliTaskModelEditFromForm(form)?.reasoningEffort).toBe("");
    form.set("reasoningEffort", "HIGH;rm");
    expect(cliTaskModelEditFromForm(form)).toBeNull();
    form.set("reasoningEffort", "high"); form.set("rank", "4");
    expect(cliTaskModelEditFromForm(form)).toBeNull();
  });
});

describe("saveCliTaskModelAction", () => {
  afterEach(() => { for (const mock of Object.values(mocks)) mock.mockReset(); });
  const rows = [row("first-review", 1, 1, "sonnet", { reasoningEffort: "high" })];
  const form = (patch: Record<string, string> = {}) => {
    const data = new FormData();
    for (const [key, value] of Object.entries({ task: "first-review", slot: "1", rank: "1", revision: revisionOf(rows), connectionId: CLAUDE,
      model: "opus", reasoningEffort: "medium", ...patch })) data.set(key, value);
    return data;
  };
  it("작업 배정과 같은 saveAiTaskRanks 로 그 칸을 저장한다", async () => {
    mocks.admin.mockResolvedValue({ login: "jr" });
    mocks.rows.mockResolvedValue(rows);
    mocks.save.mockResolvedValue({ ok: true, revision: "r", warnings: [], created: { devices: [], contracts: [], routes: [] } });
    const state = await saveCliTaskModelAction(null, form());
    expect(mocks.save).toHaveBeenCalledWith({ task: "first-review", slot: 1, revision: revisionOf(rows), ranks: [{ provider: CLAUDE, model: "opus", reasoningEffort: "medium" }] }, "jr");
    expect(state).toMatchObject({ ok: true, message: expect.stringContaining("opus · 추론 강도 medium") });
    expect(mocks.revalidate).toHaveBeenCalledWith("/admin/models/devices");
  });
  it("관리자가 아니거나 판이 다르면 저장하지 않는다, 저장 거절 문장은 그대로 보인다", async () => {
    mocks.admin.mockResolvedValue(null);
    expect((await saveCliTaskModelAction(null, form()))?.issues).toHaveLength(1);
    mocks.admin.mockResolvedValue({ login: "jr" });
    mocks.rows.mockResolvedValue(rows);
    expect(await saveCliTaskModelAction(null, form({ revision: "e".repeat(64) }))).toEqual({ issues: [CLI_TASK_EDIT_STALE] });
    expect(mocks.save).not.toHaveBeenCalled();
    mocks.save.mockResolvedValue({ ok: false, issues: ["ai_task_revision_mismatch"] });
    expect((await saveCliTaskModelAction(null, form()))?.issues).toEqual(["그 사이 이 줄이 바뀌었습니다. 새로고침한 뒤 다시 저장하세요."]);
  });
});

describe("CliTaskRows", () => {
  it("작업 줄마다 child 행 — 모델·추론 강도 선택, 읽기 전용 줄은 값과 설정 위치", () => {
    const { usages } = buildCliTaskUsages(input());
    const html = renderToStaticMarkup(createElement("table", null, createElement("tbody", null, createElement(CliTaskRows, { usages: usages.slice(0, 3), columns: 7 }))));
    expect(html.match(/<tr class="child cli-task-row"/g)).toHaveLength(3);
    expect(html).toContain('colSpan="5"');
    expect(html).toContain('aria-label="1차 AI 검수 Claude CLI 모델"');
    expect(html).toContain('<option value="">기본(low)</option>');
    expect(html).toContain('<option value="high" selected="">high</option>');
    expect(html).toContain('name="revision"');
    // 읽기 전용(소개 검수): 선택 없이 값과 링크
    expect(html).toContain('href="/admin/models/advanced#model-settings"');
    expect(html.match(/<select/g)).toHaveLength(4);
  });
  it("모델이 강도를 받지 않으면 강도 선택을 끄고 까닭을 title 로 보인다", () => {
    const { usages } = buildCliTaskUsages(input({ rows: [row("first-review", 1, 1, "haiku")], current: [], classifier: null }));
    const html = renderToStaticMarkup(createElement(CliTaskRows, { usages }));
    expect(html).toMatch(/<select[^>]*name="reasoningEffort"[^>]*disabled=""[^>]*title="이 모델은 추론 강도를 받지 않습니다"/);
  });
});
