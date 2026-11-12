import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildTaskRankEditor } from "@/lib/operations/flow-rank-editor";
import { modelFixtureInput, modelFixtureRead } from "./fixtures/model-console";
import { modelDuplicateAssignments, modelRowsFor } from "@/app/(operator)/admin/models/console/model-console-view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/models/tasks/actions", () => ({ saveAiConnectionAction: vi.fn(), readAiConnectionModelsAction: vi.fn(), deleteAiConnectionAction: vi.fn(),
  hideAiConnectionModelAction: vi.fn(), clearUnreadAiTaskRanksAction: vi.fn(), saveAiTaskRanksAction: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/devices/actions", () => ({ saveDeviceRowAction: vi.fn(), saveCapacityDevice: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/tasks/execution-actions", () => ({ saveTaskExecutionAction: vi.fn() }));

import { ModelConsole, ModelDetail } from "@/app/(operator)/admin/models/console/ModelConsole";
import { ModelAttachForm } from "@/app/(operator)/admin/models/console/ModelAttachForm";

describe("unified model inventory", () => {
  it("orders real observations and keeps missing metrics last without changing the source rows", () => {
    const data = modelFixtureRead();
    const rows = [...data.view.rows];
    const missing = { ...rows[0], id: "missing", name: "missing", calls: null, utilization: null };
    expect(modelRowsFor([missing, ...rows], "calls", false, row => row.stageCount).at(-1)?.id).toBe("missing");
    expect(modelRowsFor(rows, "name", false, row => row.stageCount).map(row => row.name))
      .toEqual(rows.map(row => row.name).sort((a, b) => a.localeCompare(b, "ko")));
    expect(modelRowsFor(rows, "usage", true, row => row.stageCount).map(row => row.name)).toEqual(["M1max"]);
    expect(data.view.rows).toEqual(rows);
  });

  it("counts task slots with repeated active models and preserves unknown reads", () => {
    const input = modelFixtureInput();
    const rows = [
      { task: "crawl-tagline", slot: 1, rank: 1, connectionId: "one", model: "model", enabled: true, options: {} },
      { task: "crawl-tagline", slot: 1, rank: 2, connectionId: "two", model: "vendor/model", enabled: true, options: {} },
      { task: "crawl-tagline", slot: 1, rank: 3, connectionId: "one", model: "model", enabled: true, options: {} },
      { task: "product-translate", slot: 1, rank: 1, connectionId: "one", model: "model", enabled: true, options: {} },
      { task: "product-translate", slot: 1, rank: 2, connectionId: "one", model: "model", enabled: false, options: {} },
      { task: "korean-translation-direct", slot: 1, rank: 1, connectionId: "one", model: "model", enabled: true, options: {} },
      { task: "korean-translation-direct", slot: 1, rank: 2, connectionId: "one", model: "model", enabled: true, options: {} },
    ];
    const editor = buildTaskRankEditor(input.connections!, rows, () => "revision");
    expect(modelDuplicateAssignments(editor)).toBe(1);
    expect(modelDuplicateAssignments(null)).toBeNull();
  });

  it("uses unified actual settings for model association counts and detail task links", () => {
    const data = modelFixtureRead();
    const id = "conn-m3-deepseek";
    const html = renderToStaticMarkup(<ModelConsole data={data} selected={id} readOnly={false} duplicateCount={2}
      onTaskOpen={() => {}} onModelScope={() => {}} taskUses={{ [id]: [
        { key: "human-review#1", label: "사람 몫 위임 검수", place: "별도 적용 설정" },
        { key: "split-confirm#1", label: "2차 갈림 재확인", place: "별도 적용 설정" },
      ] }} />);
    expect(html).toContain("같은 모델 반복 2개");
    expect(html).toContain('aria-label="m3-deepseek의 쓰는 작업 보기">2</button>');
    expect(html).toContain("사람 몫 위임 검수");
    expect(html).toContain("별도 적용 설정");
    expect(html).toContain('id="model-settings-panel" role="tabpanel" aria-labelledby="model-settings-tab" hidden=""');
    expect(html).not.toContain('id="model-add"');
  });

  it("offers the shared task editor with model constraints and no second inline save flow", () => {
    const input = modelFixtureInput();
    const editor = buildTaskRankEditor(input.connections!, input.ranks!.map(row => ({ ...row, options: {} })), () => "revision");
    const html = renderToStaticMarkup(<ModelAttachForm connectionId="conn-m1max" editor={editor} devices={null} poolHelp={null}
      readOnly={false} onTaskOpen={() => {}} />);
    expect(html).toContain("작업에 붙이기");
    expect(html).toContain('value="product-tagline-ko#1"');
    expect(html).toContain(">자리 고르기 →</button>");
    expect(html).not.toContain("바뀌는 내용 확인");
    expect(html).not.toContain('name="attach-mode"');
    const disabled = renderToStaticMarkup(<ModelAttachForm connectionId="conn-m1max" editor={editor} devices={null} poolHelp={null}
      readOnly={true} onTaskOpen={() => {}} />);
    expect(disabled).toContain('disabled="">자리 고르기 →</button>');
  });

  it("does not label unavailable assignment reads as an unused model or zero repeats", () => {
    const data = modelFixtureRead({ ranks: null, pools: null });
    const html = renderToStaticMarkup(<ModelConsole data={data} selected={null} readOnly={false} />);
    expect(html).toContain("같은 모델 반복 —");
    expect(html).toContain("쓰는 작업 없는 모델 —");
    expect(html).not.toContain("쓰는 작업 없는 모델 9개");
  });

  it("keeps fallback links on the unified route when a shared editor callback is absent", () => {
    const data = modelFixtureRead();
    const html = renderToStaticMarkup(<ModelDetail row={data.view.rows[0]} device={null} secretBox={true} readOnly={false} now={data.view.checkedAt}
      uses={[{ key: "assist-review#1", label: "LLM 보강", place: "1순위", href: "/admin/models/tasks#execution-assist-review-1" }]} />);
    expect(html).toContain('href="/admin/models?task=assist-review%231#tasks"');
    expect(html).toContain('href="/admin/models#tasks"');
    expect(html).not.toContain('href="/admin/models/tasks');
    const unavailable = renderToStaticMarkup(<ModelAttachForm connectionId="missing" editor={null} devices={null} poolHelp={null} readOnly={false} />);
    expect(unavailable).toContain('href="/admin/models#tasks"');
    expect(unavailable).not.toContain('href="/admin/models/tasks');
  });
});
