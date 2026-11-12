import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { aiTaskSlots, isAiLiveTask } from "@/lib/llm/ai-tasks";
import { aiTaskPoolFeatures } from "@/lib/llm/ai-task-execution-config";
import type { AiTaskExecutionAdminView } from "@/lib/operations/admin-ai-task-execution";
import { aiTaskRanksInputFromForm, type AiTaskRankRow } from "@/lib/operations/admin-ai-tasks";
import { buildTaskRankEditor, type FlowRankEditor } from "@/lib/operations/flow-rank-editor";
import { buildTaskAssignView, type TaskAssignInput, type TaskAssignRow } from "@/lib/operations/llm-task-assign-view";
import { attachSaveForms, savedAssignment } from "@/lib/operations/model-attach";
import { UNIFIED_MAIN_TASKS, unifiedTaskActualNote, unifiedTaskDuplicate, unifiedTaskEditTarget, unifiedTaskHomeHref, unifiedTaskInitialDraft, unifiedTaskLock,
  unifiedTaskNeedsAttention, unifiedTaskPoolOptions, unifiedTaskRows, unifiedTaskSwitchMode } from "@/lib/operations/model-unified-task-view";
import { poolMemberIssues } from "@/lib/operations/task-pool-form";
import { GPU, LLM_NOW, llmConnections, llmJobs, llmObservation, llmRankRows, MLX, OPENCODE } from "./fixtures/llm-ops";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/models/tasks/actions", () => ({ saveAiTaskRanksAction: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/tasks/execution-actions", () => ({ saveTaskExecutionAction: vi.fn() }));

import { UnifiedTaskSection } from "@/app/(operator)/admin/models/unified/tasks/UnifiedTaskSection";
import { UnifiedTaskEditor } from "@/app/(operator)/admin/models/unified/tasks/UnifiedTaskEditor";

const revision = () => "a".repeat(64);
const editorOf = (rows: readonly AiTaskRankRow[] = llmRankRows, executions: readonly AiTaskExecutionAdminView[] = []) => buildTaskRankEditor(llmConnections, rows, revision, executions);
const lineOf = (editor: FlowRankEditor, key = "first-review#1") => editor.lines.find(line => line.key === key)!;
function viewOf(patch: Partial<TaskAssignInput> = {}) {
  const slots = aiTaskSlots().map(({ task, slot }) => ({ task, slot, label: task.slots > 1 ? `${task.label} · 투표자 ${slot}` : task.label,
    rows: llmRankRows.filter(row => row.task === task.id && row.slot === slot).sort((a, b) => a.rank - b.rank),
    options: [], current: null, sameAsCurrent: null, readiness: [], live: isAiLiveTask(task.id), runtime: null }));
  return buildTaskAssignView({ now: LLM_NOW, slots, connections: llmConnections, observation: llmObservation(), jobs: llmJobs, executions: [], ...patch });
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const selection = { filter: "all", group: "all", search: "", modelScope: null, showAll: false } as const;
const pooled = (task = "first-review"): AiTaskExecutionAdminView => ({ task, slot: 1, mode: "workload_pool", revision: 7, reserveRanks: true,
  updatedAt: LLM_NOW, members: [{ memberId: "11111111-0000-4000-8000-000000000001", position: 1, connectionId: OPENCODE, model: "deepseek/deepseek-v4.1-flash",
    canonicalModel: "deepseek-v4.1-flash", options: { reasoningEffort: "high" }, deviceId: "m3-opencode-host", engineKey: "opencode-engine", maxSlots: 3 }] });

describe("unified model task overview", () => {
  it("starts with the approved eight real task slots; filters/search/model scope inspect all slots", () => {
    const view = viewOf();
    expect(unifiedTaskRows(view.rows, selection).visible.map(row => row.key)).toEqual(UNIFIED_MAIN_TASKS);
    expect(unifiedTaskRows(view.rows, { ...selection, showAll: true }).visible).toHaveLength(view.rows.length);
    const voter = unifiedTaskRows(view.rows, { ...selection, search: "투표자 3" });
    expect(voter.visible.map(row => row.key)).toEqual(["second-review#3"]);
    expect(voter.hasFilter).toBe(true);
    const scoped = unifiedTaskRows(view.rows, { ...selection, modelScope: GPU });
    expect(scoped.visible.length).toBeGreaterThan(0);
    expect(scoped.visible.every(row => row.choices.some(choice => choice.connectionId === GPU))).toBe(true);
    const named = unifiedTaskRows(view.rows, { ...selection, search: "별칭으로 찾기", nameOf: () => "별칭으로 찾기" });
    expect(named.visible.length).toBeGreaterThan(0);
    expect(unifiedTaskRows(view.rows, { ...selection, group: "audit" }).visible.every(row => row.group === "audit")).toBe(true);
  });

  it("counts active repeated fallback attempts with connection identity, excluding archives and pools", () => {
    const row = viewOf().rows.find(row => row.key === "crawl-tagline#1")!;
    const choice = row.choices[0];
    const duplicate: TaskAssignRow = { ...row, mode: "fallback", choices: [choice, { ...choice, position: 2 }], status: { level: "ok", text: "정상", reason: null, detail: null } };
    expect(unifiedTaskDuplicate(duplicate)).toBe(true);
    expect(unifiedTaskNeedsAttention(duplicate)).toBe(true);
    expect(unifiedTaskDuplicate({ ...duplicate, choices: [choice, { ...choice, position: 2, connectionId: "different-connection" }] })).toBe(false);
    expect(unifiedTaskDuplicate({ ...duplicate, mode: "workload_pool" })).toBe(false);
    const archived: TaskAssignRow = { ...row, choices: [choice], archived: [choice, choice] };
    expect(unifiedTaskDuplicate(archived)).toBe(false);
    expect(unifiedTaskRows([duplicate, row], { ...selection, filter: "duplicate" }).visible).toEqual([duplicate]);
  });

  it("renders real one-hour totals, failures and mismatch reasons and keeps unreadable values unknown", () => {
    const view = viewOf();
    const html = renderToStaticMarkup(<UnifiedTaskSection view={view} editor={editorOf()} devices={null} lockReason={null} poolHelp={null} />);
    expect(html).toContain('id="tasks"');
    expect(html).toContain("전체 작업");
    expect(html).toContain(`전체 ${view.rows.length}개 펼치기`);
    const first = html.match(/<tr id="execution-first-review-1"[^]*?<\/tr>/)![0];
    expect(text(first)).toContain("86건");
    expect(text(first)).toContain("1시간 실패 2건 / 정산 179");
    expect(text(first)).toContain("93건");
    expect(text(first)).toContain("1순위가 아닌 모델이 52%를 처리");
    expect(first).toContain('aria-label="1차 AI 검수 배정 변경"');
    const unknown = { ...view, rows: [{ ...view.rows[0], actual: { ...view.rows[0].actual, calls: [], readable: false, settled: null, failed: null, empty: "확인 불가 · 장부를 읽지 못함" } }] };
    const unknownHtml = renderToStaticMarkup(<UnifiedTaskSection view={unknown} editor={editorOf()} devices={null} lockReason={null} poolHelp={null} />);
    expect(text(unknownHtml)).toContain("확인 불가 · 장부를 읽지 못함");
    expect(unknownHtml).not.toContain("0건");
  });

  it("keeps one distinct overview annotation and leaves shared-voter and repeated status detail in the drawer", () => {
    const row = viewOf().rows[0];
    expect(unifiedTaskActualNote({ ...row, actual: { ...row.actual, note: "변경 전 설정의 호출 포함", warnings: [], failed: 0 },
      status: { ...row.status, reason: "변경 전 설정의 호출 포함" } })).toBeNull();
    expect(unifiedTaskActualNote({ ...row, actual: { ...row.actual, note: "독립 메모", warnings: ["첫 경고", "둘째 경고"], failed: 2 },
      status: { ...row.status, reason: "다른 사유" } })).toBe("독립 메모");
    expect(unifiedTaskActualNote({ ...row, actual: { ...row.actual, note: null, warnings: [], failed: 2 },
      status: { ...row.status, reason: "실패 2건 포함" } })).toBeNull();
  });

  it("keeps non-LLM/search slots available when all rows are filtered, with actual settings as the action", () => {
    const view = viewOf();
    const html = renderToStaticMarkup(<UnifiedTaskSection view={view} editor={editorOf()} devices={null} lockReason={null} poolHelp={null}
      filter="all" modelScope={null} onFilterChange={() => undefined} />);
    expect(html).not.toContain("prototype");
    const searchRows = unifiedTaskRows(view.rows, { ...selection, group: "search" }).visible;
    expect(searchRows.some(row => row.task === "product-embedding")).toBe(true);
    const external = view.rows.find(row => row.task === "human-review")!;
    const scopedHtml = renderToStaticMarkup(<UnifiedTaskSection view={{ ...view, rows: [external] }} editor={editorOf()} devices={null} lockReason={null} poolHelp={null} filter="attention" />);
    // A non-live task remains a real settings link inside the shared drawer, never a dead rank form.
    expect(unifiedTaskEditTarget(lineOf(editorOf(), external.key))?.href).toBeTruthy();
    expect(scopedHtml).toContain("작업별 적용 현황");
  });
});

describe("shared unified task editor", () => {
  it("does not offer rank mutation for non-live or environment-locked tasks", () => {
    const editor = editorOf();
    for (const key of ["human-review#1", "product-embedding#1", "product-intro-check#1"]) {
      const line = lineOf(editor, key);
      const target = unifiedTaskEditTarget(line)!;
      const html = renderToStaticMarkup(<UnifiedTaskEditor taskKey={key} editor={editor} devices={null} lockReason={null} poolHelp={null} onClose={() => undefined} />);
      expect(html).toContain(target.href.replace(/&/g, "&amp;"));
      expect(html).not.toContain('aria-label="실행 방식"');
      expect(html).not.toContain("변경 내용 확인");
      expect(html).not.toContain('name="rank1Connection"');
      expect(unifiedTaskInitialDraft(editor, line, GPU).issue).toBeTruthy();
    }
  });

  it("replaces only the old pool navigation lock and retains unrelated locks/read-only state", () => {
    const editor = editorOf(llmRankRows, [pooled()]);
    const line = lineOf(editor);
    expect(line.lock).toContain("작업 분산 중");
    expect(unifiedTaskLock(line)).toBeNull();
    expect(unifiedTaskLock({ ...line, lock: "별도 운영 잠금" })).toBe("별도 운영 잠금");
    const html = renderToStaticMarkup(<UnifiedTaskEditor taskKey={line.key} editor={editor} devices={null} poolHelp={null} lockReason="읽기 전용 관측" onClose={() => undefined} />);
    expect(html).toContain("읽기 전용 관측");
    expect(html).toMatch(/disabled=""[^>]*>변경 내용 확인/);
    expect(html).toContain('max="8"');
    expect(html).toContain('aria-label="모델 1 동시 칸 수"');
    expect(html).toContain("보관된 순위를 예비로 사용");
    expect(html).toContain("추론 강도");
  });

  it("shares attachment drafts with model detail and preserves rank CAS, reasoning, member identity, caps and reserve in existing forms", () => {
    const editor = editorOf(llmRankRows, [pooled()]);
    const line = lineOf(editor);
    const attached = unifiedTaskInitialDraft(editor, line, GPU);
    expect(attached.issue).toBeNull();
    expect(attached.draft.members).toContainEqual(expect.objectContaining({ provider: GPU }));
    expect(attached.draft.members[0]?.reasoningEffort).toBe("high");
    const draft = { ...attached.draft, slots: ["3", "2", "", ""], reserve: true };
    const forms = attachSaveForms({ line, after: draft, features: aiTaskPoolFeatures(line.task, line.slot), saves: ["execution"] });
    expect(forms[0].form.get("expectedRevision")).toBe("7");
    expect(forms[0].form.get("reserveRanks")).toBe("1");
    expect(JSON.parse(String(forms[0].form.get("members")))[0]).toMatchObject({ memberId: pooled().members[0].memberId, reasoningEffort: "high", maxSlots: 3 });
    const fallback = { ...unifiedTaskSwitchMode(draft, "fallback", line), ranks: [{ provider: GPU, model: "qwen3.8-flash-next" }] };
    const switched = attachSaveForms({ line, after: fallback, features: aiTaskPoolFeatures(line.task, line.slot), saves: ["execution", "ranks"] });
    expect(switched.map(save => save.kind)).toEqual(["execution", "ranks"]);
    expect(switched[0].form.get("mode")).toBe("fallback");
    expect(switched[0].form.get("members")).toBe("[]");
    expect(switched[1].form.get("revision")).toBe(revision());
    const parsed = aiTaskRanksInputFromForm(switched[1].form);
    expect(parsed.issues).toEqual([]);
    expect(parsed.input).toMatchObject({ task: "first-review", slot: 1, revision: revision() });
    expect(parsed.input?.ranks[0]).toMatchObject({ provider: GPU, model: "qwen3.8-flash-next" });
  });

  it("does not silently replace a full pool or a saved missing model, and honors task-specific slot support", () => {
    const pool = pooled();
    const full: AiTaskExecutionAdminView = { ...pool, members: Array.from({ length: 4 }, (_, index) => ({ ...pool.members[0], memberId: `member-${index}`, position: index + 1 })) };
    const editor = editorOf(llmRankRows, [full]);
    const line = lineOf(editor);
    const attempt = unifiedTaskInitialDraft(editor, line, GPU);
    expect(attempt.issue).toContain("4개까지");
    expect(attempt.draft).toEqual(savedAssignment(line));
    const missing = { ...line, execution: { ...full, members: [{ ...pool.members[0], connectionId: "deleted", model: "stored-only" }] } };
    expect(unifiedTaskPoolOptions(editor, missing)).toContainEqual(expect.objectContaining({ provider: "deleted", model: "stored-only", saved: true }));
    const nonPool = lineOf(editor, "second-review#2");
    const initial = savedAssignment(nonPool);
    expect(unifiedTaskSwitchMode(initial, "workload_pool", nonPool)).toEqual(initial);
    expect(poolMemberIssues(attempt.draft.members, ["3", "", "", ""], editor.connections,
      { apiOnly: false, features: aiTaskPoolFeatures(line.task, line.slot) })).toContain("칸 수는 모든 모델에 적거나 모두 비워 주세요.");
    expect(unifiedTaskHomeHref("first-review")).toBe("/admin/flow?stage=first#sp-models");
    expect(unifiedTaskHomeHref("product-tagline-ko")).toBe("/admin/flow?stage=tagline-ko#sp-models");
    expect(lineOf(editorOf(), "crawl-tagline#1").options.some(option => option.provider === MLX)).toBe(true);
  });

  it("starts only a new reviewed pool draft at one slot per model, preserving saved automatic pools", () => {
    const editor = editorOf();
    const line = lineOf(editor);
    const before = savedAssignment(line);
    expect(unifiedTaskSwitchMode(before, "workload_pool", line).slots).toEqual(["1", "1", "", ""]);
    expect(before.slots).toEqual(["", "", "", ""]);
    const automatic = { ...before, mode: "workload_pool" as const, members: before.ranks, slots: ["", "", "", ""] };
    expect(unifiedTaskSwitchMode(automatic, "workload_pool", line).slots).toEqual(["", "", "", ""]);
  });
});
