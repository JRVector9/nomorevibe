import { Children, isValidElement, Suspense, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const read = vi.hoisted(() => ({
  admin: vi.fn(), conveyor: vi.fn(), sharedDesk: vi.fn(), away: vi.fn(), changes: vi.fn(), diagnostics: vi.fn(),
  jobs: vi.fn(), versions: vi.fn(), editor: vi.fn(), reactions: vi.fn(), home: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect: (href: string) => { throw new Error(`redirect:${href}`); } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ has: () => false }) }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: read.admin, authSecret: () => null }));
vi.mock("@/lib/jobs/runner", () => ({ listJobStates: read.jobs }));
vi.mock("@/lib/operations/admin-job-control", () => ({ adminJobControlVersions: read.versions }));
vi.mock("@/lib/operations/conveyor", () => ({ readConveyor: read.conveyor }));
// 사람 확인 · AI 보조 처리 현황 — 이 시험은 흐름 화면의 읽기 순서만 본다(DB 없이)
vi.mock("@/lib/operations/human-assist-progress", () => ({ HUMAN_ASSIST_TASKS: ["human-review", "split-confirm", "split-tiebreak", "held-review-retry"], readHumanAssistProgress: async () => null }));
vi.mock("@/lib/operations/human-delegate-summary", () => ({ readHumanDelegateSummary: async () => null }));
vi.mock("@/lib/operations/flow-rank-editor-read", () => ({ readFlowRankEditor: read.editor }));
vi.mock("@/lib/operations/admin-workspace-preview", () => ({ adminWorkspaceReadOnly: () => true }));
vi.mock("@/lib/domain/reactions/review", () => ({ heldReactionComments: read.reactions }));
vi.mock("@/app/(operator)/admin/flow/desk", () => ({ readOperatorDeskShared: read.sharedDesk,
  readOperatorAway: read.away, readOperatorChanges: read.changes, readOperatorDiagnostics: read.diagnostics }));
vi.mock("@/app/(operator)/admin/flow/FlowBoard", () => ({ FlowBoard: () => null }));
vi.mock("@/app/(operator)/admin/flow/PrototypeFlow", () => ({ PrototypeFlow: () => null,
  PrototypeFlowAway: () => null, PrototypeFlowChanges: () => null }));
// 운영 홈(할 일 + 흐름) — 읽기 하나로 모은다. 이 시험은 어느 탭이 무엇을 읽는지만 본다
vi.mock("@/lib/operations/console-home-read", () => ({ readConsoleHome: read.home }));
vi.mock("@/app/(operator)/admin/flow/ConsoleHome", () => ({ ConsoleHome: () => null }));

import Page from "@/app/(operator)/admin/flow/page";
import { ConsoleHome } from "@/app/(operator)/admin/flow/ConsoleHome";
import { PrototypeFlow, PrototypeFlowChanges } from "@/app/(operator)/admin/flow/PrototypeFlow";

const at = "2026-11-04T12:00:00.000Z";
const base = { measuredAt: at, alerts: null, decisions: null, changes: [], equipment: null, window: null };
type WorkspaceView = ReactElement<{ desk?: unknown; awayContent?: ReactElement }>;
type ServerSlot = ReactElement<Record<string, unknown>, (props: Record<string, unknown>) => Promise<WorkspaceView>>;
function workspace(page: ReactElement<{ children: ReactNode }>): ServerSlot {
  const boundary = Children.toArray(page.props.children).find(node => isValidElement(node) && node.type === Suspense);
  if (!isValidElement<{ children: ServerSlot }>(boundary)) throw new Error("Missing loading boundary");
  return boundary.props.children;
}
async function view(tab?: string, extra: Record<string, string> = {}) {
  const page = await Page({ searchParams: Promise.resolve({ tab, ...extra }) });
  const slot = workspace(page);
  return slot.type(slot.props);
}

beforeEach(() => {
  vi.resetAllMocks();
  read.admin.mockResolvedValue({ login: "fixture-operator", exp: 9_999_999_999 });
  read.conveyor.mockResolvedValue({ measuredAt: at });
  read.sharedDesk.mockResolvedValue(base);
  read.diagnostics.mockResolvedValue({ ...base, away: null });
  read.changes.mockResolvedValue({ ...base, away: null });
  read.away.mockResolvedValue(null);
  read.jobs.mockResolvedValue([]);
  read.versions.mockResolvedValue({});
  read.editor.mockResolvedValue(null);
  read.reactions.mockResolvedValue({ count: 0, items: [] });
  read.home.mockResolvedValue({ checkedAt: at, inputs: { now: at }, conveyor: null, jobControls: {} });
});

describe("flow loading isolation", () => {
  it("opens the operating home (tasks + flow) by default and reads only its own inputs", async () => {
    const result = await view();
    expect(result.type).toBe(ConsoleHome);
    expect(result.props).toMatchObject({ data: { checkedAt: at }, csrf: null });
    expect(read.home).toHaveBeenCalledWith(false);
    for (const work of [read.sharedDesk, read.away, read.changes, read.diagnostics, read.editor, read.reactions]) expect(work).not.toHaveBeenCalled();
    expect((await view("home")).type).toBe(ConsoleHome);
  });
  it("keeps the previous live board as the flow detail tab, old ?tab=flow included, and opens the asked stage", async () => {
    for (const tab of ["detail", "flow"]) expect((await view(tab)).type).toBe(PrototypeFlow);
    expect((await view("detail", { stage: "first" })).props).toMatchObject({ initialStage: "first" });
    expect(read.home).not.toHaveBeenCalled();
  });
  it("returns the live board while personal history is still pending", async () => {
    read.away.mockImplementation(() => new Promise(() => {}));
    const result = await view("flow");
    expect(result.type).toBe(PrototypeFlow);
    expect(result.props.desk).toEqual({ ...base, away: null });
    expect(result.props.awayContent?.type).toBe(Suspense);
    expect(read.away).toHaveBeenCalledWith("fixture-operator", at);
    expect(read.editor).toHaveBeenCalledTimes(1);
  });
  it("reads only the operator changes for the history tab", async () => {
    expect((await view("changes")).type).toBe(PrototypeFlowChanges);
    expect(read.changes).toHaveBeenCalledWith("fixture-operator");
    for (const work of [read.conveyor, read.sharedDesk, read.diagnostics, read.jobs, read.versions, read.editor, read.reactions]) {
      expect(work).not.toHaveBeenCalled();
    }
  });
  it("does not load the inbox, model editor or reaction list for basic diagnostics", async () => {
    expect((await view("diagnostics")).type).toBe(PrototypeFlow);
    expect(read.diagnostics).toHaveBeenCalledTimes(1);
    for (const work of [read.sharedDesk, read.away, read.changes, read.editor, read.reactions]) expect(work).not.toHaveBeenCalled();
    expect(read.jobs).toHaveBeenCalledTimes(1);
    expect(read.versions).toHaveBeenCalledTimes(1);
  });
  it("authenticates before starting any protected reader", async () => {
    read.admin.mockResolvedValue(null);
    await expect(view("flow")).rejects.toThrow("redirect:/admin/login");
    await expect(view()).rejects.toThrow("redirect:/admin/login");
    for (const work of [read.conveyor, read.sharedDesk, read.changes, read.jobs, read.editor, read.reactions, read.home]) expect(work).not.toHaveBeenCalled();
  });
});
