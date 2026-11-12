import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildModelUnifiedFixture } from "@/lib/operations/model-unified-fixture";
import { unavailableAdminModels } from "@/lib/operations/admin-models-observation";
const mocks = vi.hoisted(() => ({ models: vi.fn(), tasks: vi.fn(), executions: vi.fn(), observation: vi.fn(), jobs: vi.fn(),
  auditRunning: vi.fn(), rejects: vi.fn(), recheckOff: vi.fn(), assist: vi.fn(), concurrency: vi.fn(), help: vi.fn(), preview: vi.fn(), changes: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/operations/model-console-read", () => ({ readModelConsole: mocks.models }));
vi.mock("@/lib/operations/admin-ai-tasks-repository", () => ({ readAiTasksAdminView: mocks.tasks, previewAiTaskImport: mocks.preview, aiTaskSlotRevision: () => "a".repeat(64) }));
vi.mock("@/lib/operations/admin-ai-task-execution", () => ({ readAiTaskExecutionAdminViews: mocks.executions }));
vi.mock("@/lib/operations/admin-models-repository", () => ({ readAdminModelsObservation: mocks.observation }));
vi.mock("@/lib/operations/llm-ops-read", () => ({ readJobPauses: mocks.jobs, readAuditCampaignRunning: mocks.auditRunning,
  readRecheckRejectsOpen: mocks.rejects, readRecheckOff: mocks.recheckOff, readLlmChangeLog: mocks.changes }));
vi.mock("@/lib/operations/llm-assist-controls", () => ({ readAssistControls: mocks.assist, assistTasksOff: () => ({}) }));
vi.mock("@/lib/operations/admin-runtime-settings", () => ({ readSettingsControl: mocks.concurrency, JOB_CONCURRENCY_CONTROL: ["jobs"] }));
vi.mock("@/lib/operations/pool-help-read", () => ({ readPoolHelpContext: mocks.help }));
import { readModelUnified } from "@/lib/operations/model-unified-read";

beforeEach(() => {
  vi.clearAllMocks();
  const fixture = buildModelUnifiedFixture();
  mocks.models.mockResolvedValue(fixture.models); mocks.tasks.mockResolvedValue(fixture.tasks);
  mocks.executions.mockResolvedValue(fixture.editor.lines.flatMap(line => line.execution ? [line.execution] : []));
  mocks.observation.mockResolvedValue(unavailableAdminModels()); mocks.jobs.mockResolvedValue([]);
  mocks.auditRunning.mockResolvedValue(false); mocks.rejects.mockResolvedValue(false); mocks.recheckOff.mockResolvedValue(false);
  mocks.assist.mockResolvedValue(fixture.assist); mocks.concurrency.mockResolvedValue(fixture.concurrency);
  mocks.help.mockResolvedValue(fixture.poolHelp); mocks.preview.mockResolvedValue(null); mocks.changes.mockResolvedValue(fixture.changes);
});

describe("통합 모델 서버 조회", () => {
  it("실제 기존 조회를 합치며 키 자동 채움·가져오기를 렌더 중 실행하지 않는다", async () => {
    const data = await readModelUnified({ readOnly: false });
    expect(mocks.tasks).toHaveBeenCalledExactlyOnceWith({ readOnly: true });
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.changes).toHaveBeenCalledWith({ kind: null, failedOnly: false, before: null }, 3);
    expect(mocks.observation).toHaveBeenCalledWith({ throughput: false });
    expect(data.ranksReadable).toBe(true);
    expect(data.lockReason).toBeNull();
    expect(data.assignments.rows).toHaveLength(28);
  });
  it("실행 방식·장부·도움말 읽기 실패를 0이나 저장 가능 상태로 꾸미지 않는다", async () => {
    mocks.executions.mockRejectedValue(new Error("unavailable"));
    mocks.observation.mockRejectedValue(new Error("unavailable")); mocks.help.mockRejectedValue(new Error("unavailable"));
    const data = await readModelUnified({ readOnly: false });
    expect(data.lockReason).toContain("실행 방식을 읽지 못했습니다");
    expect(data.devices).toBeNull(); expect(data.poolHelp).toBeNull();
    expect(data.assignments.rows.find(row => row.task === "first-review")?.actual.settled).toBeNull();
  });
  it("순위 조회 실패와 읽기 전용은 기존 편집기를 잠그고 가져오기 계획은 명시한 요청에서만 읽는다", async () => {
    const fixture = buildModelUnifiedFixture();
    mocks.tasks.mockResolvedValue({ ...fixture.tasks, errors: { rows: "unavailable" } });
    const failed = await readModelUnified({ readOnly: false });
    expect(failed.ranksReadable).toBe(false); expect(failed.lockReason).toContain("확인할 때까지 저장할 수 없습니다");
    const preview = await readModelUnified({ readOnly: true, importPlan: true });
    expect(preview.lockReason).toContain("읽기 전용"); expect(mocks.preview).toHaveBeenCalledOnce();
  });
});
