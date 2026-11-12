import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildModelUnifiedFixture } from "@/lib/operations/model-unified-fixture";
import preview from "@/lib/operations/model-unified-preview.json";
import { unifiedModelTaskUses } from "@/lib/operations/model-unified-view";
import { legacyTasksHref, unifiedTaskKey } from "@/app/(operator)/admin/models/unified/legacy-navigation";
import { modelsLegacyTabHref, resolveWorkspace, WORKSPACES } from "@/app/(operator)/admin/workspace-navigation";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), readOnly: vi.fn(), slot: vi.fn(),
  redirect: vi.fn((href: string) => { throw new Error(`redirect:${href}`); }) }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/operations/admin-workspace-preview", () => ({ adminWorkspaceReadOnly: mocks.readOnly }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/app/(operator)/admin/models/unified/slots", () => ({ UnifiedModelsSlot: mocks.slot }));

import ModelsPage from "@/app/(operator)/admin/models/page";
import TasksPage from "@/app/(operator)/admin/models/tasks/page";
import { LegacyTasksRedirect } from "@/app/(operator)/admin/models/unified/LegacyTasksRedirect";

beforeEach(() => { vi.clearAllMocks(); mocks.admin.mockResolvedValue({ login: "jr" }); mocks.readOnly.mockReturnValue(false); });
const props = (query: Record<string, string | string[] | undefined> = {}) => ({ searchParams: Promise.resolve(query) });

describe("통합 모델 화면 경로와 읽기 전용 고정 자료", () => {
  it("인증을 먼저 확인하고 운영 환경에서는 preview=fixture만으로 고정 자료를 켤 수 없다", async () => {
    const page = await ModelsPage(props({ preview: "fixture", model: "one" }));
    const slot = page.props.children[1].props.children;
    expect(slot.type).toBe(mocks.slot);
    expect(slot.props).toMatchObject({ fixture: false, readOnly: false, selected: "one" });
    mocks.readOnly.mockReturnValue(true);
    expect((await ModelsPage(props({ preview: "fixture", import: "plan" }))).props.children[1].props.children.props)
      .toMatchObject({ fixture: true, readOnly: true, importPlan: true });
    mocks.admin.mockResolvedValue(null);
    await expect(ModelsPage(props({ preview: "fixture" }))).rejects.toThrow("redirect:/admin/login");
    await expect(TasksPage(props())).rejects.toThrow("redirect:/admin/login");
    expect(mocks.slot).not.toHaveBeenCalled();
  });

  it("모델 제목은 목록의 실제 h1 하나만 사용하고 운영 페이지에만 여백 표시를 붙인다", async () => {
    const page = await ModelsPage(props());
    expect(page.props.className).toContain("models-unified-page");
    expect(page.props.children.filter((child: { type: string }) => child.type === "h1")).toHaveLength(0);
  });

  it("옛 작업 화면은 조회나 편집기를 그리지 않고 인증한 브라우저가 조각을 보존해 이동한다", async () => {
    const params = { import: "plan", mode: "first-review#1" };
    const page = await TasksPage(props(params));
    expect(page.type).toBe(LegacyTasksRedirect);
    expect(page.props.params).toEqual(params);
    const html = renderToStaticMarkup(page);
    expect(html).toContain('href="/admin/models?import=plan&amp;mode=first-review%231#import"');
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<table");
  });

  it("모델 메뉴는 모델과 고급 설정뿐이고 옛 작업 주소·탭은 모델을 켠다", () => {
    expect(WORKSPACES.find(menu => menu.id === "models")!.tabs.map(tab => [tab.label, tab.href]))
      .toEqual([["모델", "/admin/models"], ["고급 설정", "/admin/models/advanced"]]);
    expect(resolveWorkspace("/admin/models/tasks").tab).toBe("list");
    expect(resolveWorkspace("/admin/models", new URLSearchParams("tab=tasks")).tab).toBe("list");
    expect(modelsLegacyTabHref(new URLSearchParams("tab=tasks"))).toBe("/admin/models#tasks");
  });

  it("고정 자료는 승인 시안의 9모델·28작업과 숫자를 보존하며 운영 주소나 키가 없다", () => {
    const fixture = buildModelUnifiedFixture();
    expect(fixture.models.view.rows.map(row => [row.name, row.calls, row.active, row.utilization]))
      .toEqual(preview.model.toSorted((a, b) => b.usage - a.usage).map(row => [row.name, row.calls, row.active, row.usage / 100]));
    expect(fixture.assignments.rows.map(row => row.key)).toEqual(preview.task.map(row => row.key));
    expect(fixture.editor.lines).toHaveLength(28);
    for (const name of ["Claude CLI", "M1max"]) expect(fixture.models.view.rows.find(row => row.name === name))
      .toMatchObject({ utilization: 0, utilizationText: "0%", bar: 0 });
    expect(fixture.models.view.rows.find(row => row.name === "LG EXAONE")?.utilizationText).toBe("<1%");
    for (const row of fixture.models.view.rows) {
      const response = preview.model.find(source => source.name === row.name)!.response;
      expect(row.avgSeconds).toBe(response === "—" ? null : Number.parseFloat(response));
      expect(row.avgSeconds === null || Number.isFinite(row.avgSeconds)).toBe(true);
    }
    expect(fixture.lockReason).toContain("읽기 전용");
    for (const connection of fixture.editor.connections) expect(connection.baseUrl === null || new URL(connection.baseUrl).hostname.endsWith(".example")).toBe(true);
    expect(JSON.stringify(fixture)).not.toMatch(/apiKeyCiphertext|apiKeySecret|Bearer |tail02799e|nomorevibe\.com/);
  });

  it("모델 상세는 실제 적용 설정과 투표자 칸도 작업 표와 같은 선택으로 센다", () => {
    const fixture = buildModelUnifiedFixture();
    const uses = unifiedModelTaskUses(fixture.assignments);
    const human = fixture.assignments.rows.find(row => row.task === "human-review")!;
    expect(uses[human.choices[0].connectionId!]).toContainEqual(expect.objectContaining({ key: human.key, place: "별도 적용 설정" }));
    const pool = fixture.assignments.rows.find(row => row.task === "publish-classify")!;
    expect(uses[pool.choices[0].connectionId!]).toContainEqual(expect.objectContaining({ key: pool.key, place: "동시에 사용", paused: true }));
    const duplicate = fixture.assignments.rows.find(row => row.task === "crawl-tagline")!;
    expect(uses[duplicate.choices[0].connectionId!].filter(row => row.key === duplicate.key)).toHaveLength(1);
    expect(uses[duplicate.choices[0].connectionId!].find(row => row.key === duplicate.key)?.place).toBe("1순위·3순위");
  });

  it("조회가 키 자동 채움을 건너뛸 수 있고 통합 화면에 새 서버 액션은 없다", () => {
    const read = readFileSync("lib/operations/admin-ai-tasks-repository.ts", "utf8");
    expect(read).toContain("if (!options.readOnly) await maybeFillConnectionKeys()");
    const slot = readFileSync("app/(operator)/admin/models/unified/slots.tsx", "utf8");
    expect(slot).toContain("fixture && readOnly");
    expect(slot).toContain("isFixture ? buildModelUnifiedFixture() : await readModelUnified");
    expect(readFileSync("lib/operations/model-unified-read.ts", "utf8")).toContain("readAiTasksAdminView({ readOnly: true })");
  });
});

describe("옛 작업 즐겨찾기", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  it.each([
    [{}, "", "/admin/models#tasks"],
    [{ tab: "tasks" }, "", "/admin/models#tasks"],
    [{ import: "plan" }, "", "/admin/models?import=plan#import"],
    [{ edit: id }, "", `/admin/models?model=${id}#model-detail`],
    [{ id }, "", `/admin/models?model=${id}#model-detail`],
    [{ id: "first-review#1" }, "", "/admin/models?task=first-review%231#execution-first-review-1"],
    [{}, "#execution-second-review-2", "/admin/models#execution-second-review-2"],
    [{}, "#mode-first-review-1", "/admin/models#mode-first-review-1"],
    [{}, "#concurrency", "/admin/models#concurrency"],
    [{}, "#modes", "/admin/models#tasks"],
    [{}, "#connections", "/admin/models#models"],
    [{ mode: "crawl-tagline" }, "", "/admin/models?mode=crawl-tagline#mode-crawl-tagline-1"],
  ])("%j %s → %s", (params, hash, href) => expect(legacyTasksHref(params, hash)).toBe(href));
  it("순위와 실행 방식의 같은 칸을 같은 편집기로 찾고 잘못된 조각은 무시한다", () => {
    const keys = ["first-review#1", "second-review#2"];
    expect(unifiedTaskKey("#execution-second-review-2", keys)).toBe("second-review#2");
    expect(unifiedTaskKey("#mode-first-review-1", keys)).toBe("first-review#1");
    expect(unifiedTaskKey("#mode-second-review-1", keys)).toBeNull();
    expect(unifiedTaskKey("#%zz", keys)).toBeNull();
  });
});
