import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { setRuntimeSettingsForTest } from "@/lib/operations/runtime-settings-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiTaskSlots, isAiLiveTask } from "@/lib/llm/ai-tasks";
import type { AiTaskRankRow } from "@/lib/operations/admin-ai-tasks";
import type { AiTasksAdminView, AiTaskSlotView } from "@/lib/operations/admin-ai-tasks-repository";
import { unavailableAdminModels } from "@/lib/operations/admin-models-observation";
import { GPU, LLM_NOW, llmConnections, llmObservation, llmRankRows, llmRuntime, M1, MLX, SUPA } from "./fixtures/llm-ops";

const mocks = vi.hoisted(() => ({
  observation: vi.fn(), jobs: vi.fn(), view: vi.fn(), executions: vi.fn(), preview: vi.fn(),
  redirect: vi.fn((href: string) => { throw new Error(`NEXT_REDIRECT:${href}`); }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: async () => ({ login: "jr" }) }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock("@/lib/operations/admin-models-repository", () => ({ readAdminModelsObservation: mocks.observation }));
vi.mock("@/lib/jobs/runner", () => ({ listJobStates: mocks.jobs }));
vi.mock("@/lib/operations/admin-ai-tasks-repository", () => ({ readAiTasksAdminView: mocks.view, previewAiTaskImport: mocks.preview, aiTaskTargetLabel: (target: string) => target,
  aiTaskSlotRevision: (rows: readonly AiTaskRankRow[]) => (rows.map(row => row.model).join(",") || "empty").padEnd(64, "0").replace(/[^a-f0-9]/g, "a").slice(0, 64),
  listAiConnections: vi.fn(), listAiTaskRows: vi.fn(), readAiTaskRuntime: vi.fn() }));
vi.mock("@/lib/operations/admin-ai-task-execution", () => ({ readAiTaskExecutionAdminViews: mocks.executions }));
vi.mock("@/lib/llm/serving-contract-store", () => ({ ensureServingContracts: async () => undefined, servingContractSnapshot: () => ({ rows: [] }) }));
vi.mock("@/lib/security/secret-box", () => ({ secretBoxReady: () => true }));
vi.mock("@/lib/db", () => ({ db: { execute: vi.fn() }, onPrimary: (run: () => unknown) => run() }));
vi.mock("@/lib/operations/conveyor", () => ({ readConveyor: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/tasks/actions", () => ({ saveAiTaskRanksAction: vi.fn(), applyAiTaskImportAction: vi.fn(), saveAiConnectionAction: vi.fn(),
  readAiConnectionModelsAction: vi.fn(), deleteAiConnectionAction: vi.fn(), hideAiConnectionModelAction: vi.fn(), clearUnreadAiTaskRanksAction: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/tasks/execution-actions", () => ({ saveTaskExecutionAction: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/devices/actions", () => ({ saveCapacityDevice: vi.fn() }));

import { TaskAssignSlot } from "@/app/(operator)/admin/models/tasks/task-assign-slot";
import AiTasksPage from "@/app/(operator)/admin/models/tasks/page";
import { RankDrawer } from "@/app/(operator)/admin/flow/RankDrawer";
import { buildTaskRankEditor } from "@/lib/operations/flow-rank-editor";
import { taskAssignDeviceLimits, withTaskReadiness } from "@/lib/operations/llm-task-assign-view";

const far = new Date("2100-01-01T00:00:00.000Z");
function slots(rows: readonly AiTaskRankRow[] = llmRankRows): AiTaskSlotView[] {
  return aiTaskSlots().map(({ task, slot }) => {
    const own = rows.filter(row => row.task === task.id && row.slot === slot).sort((a, b) => a.rank - b.rank);
    return { task, slot, label: task.slots > 1 ? `${task.label} · 투표자 ${slot}` : task.label, revision: "a".repeat(64), rows: own,
      options: own.map(row => ({ provider: row.connectionId, model: row.model, label: row.model })), current: null, currentLabels: [], sameAsCurrent: null,
      readiness: own.map(row => ({ rank: row.rank, connectionId: row.connectionId, model: row.model, identity: row.model, blocking: [], warnings: [], createDevice: null,
        createContract: null, appendRoute: null, createCliContract: null, provider: null })) as AiTaskSlotView["readiness"],
      live: isAiLiveTask(task.id), runtime: llmRuntime[task.id] ?? null, savedAt: null };
  });
}
const adminView = (patch: Partial<AiTasksAdminView> = {}): AiTasksAdminView => ({ connections: llmConnections, rows: llmRankRows, slots: slots(), audit: [], errors: {},
  secretBox: true, policyMode: "enforce", keyConflicts: [], ...patch });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

afterEach(() => { vi.useRealTimers(); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LLM_NOW));
  mocks.observation.mockResolvedValue(llmObservation());
  mocks.jobs.mockResolvedValue([{ name: "product-search-verify", notBefore: far }, { name: "product-intro-check", notBefore: far }, { name: "crawl-agent-review", notBefore: null }]);
  mocks.view.mockResolvedValue(adminView());
  mocks.executions.mockResolvedValue([]);
  mocks.preview.mockResolvedValue(null);
});

describe("작업 배정(/admin/models/tasks) 표 그리기", () => {
  it("작업 × 칸 한 줄: 1·2·3순위 · 지금 실제(1시간) · 상태와 까닭 · 바꾸기 — 다른 화면이 거는 #execution-<작업>-<칸> 앵커 그대로", async () => {
    const html = renderToStaticMarkup(await TaskAssignSlot({ view: adminView(), executions: [], readOnly: false }));
    expect(mocks.observation).toHaveBeenCalledWith({ throughput: false });
    expect(html).toContain('data-llm-page="tasks"');
    expect(html).toMatch(/<th scope="col">1순위<\/th><th scope="col">2순위<\/th><th scope="col">3순위<\/th><th scope="col">지금 실제 \(1시간\)<\/th><th scope="col">상태<\/th>/);
    for (const { task, slot } of aiTaskSlots()) expect(html, `${task.id}#${slot}`).toContain(`id="execution-${task.id}-${slot}"`);
    const first = html.match(/<tr id="execution-first-review-1"[^]*?<\/tr>/)![0];
    expect(text(first)).toContain("1차 AI 검수 대체 실행");
    expect(first).toContain('<code class="tk-model">deepseek/deepseek-v4.1-flash</code>');
    expect(text(first)).toMatch(/1순위 deepseek\/deepseek-v4\.1-flash 86 실패 2/);
    expect(text(first)).toContain("2순위 qwen3.8-flash-next 93");
    expect(text(first)).toContain("설정과 다름 1순위가 아닌 모델이 52%를 처리");
    // 상태: 색 + 모양 + 글자, 까닭은 회색 한 줄
    expect(first).toContain('<span class="llm-level" data-level="warn"><span class="llm-level-shape" aria-hidden="true">▲</span>주의</span>');
    expect(first).toContain('<span class="tk-reason">1순위 건너뜀: 시간 초과 1회 · 1시간 실패 2건 / 정산 179</span>');
    expect(first).toContain('aria-label="1차 AI 검수 모델 바꾸기">바꾸기</button>');
    // 잡을 멈춘 작업 — 호출 없음의 까닭과 「의도적 중지」
    const verify = html.match(/<tr id="execution-product-search-verify-1"[^]*?<\/tr>/)![0];
    expect(text(verify)).toContain("호출 없음 (잡 일시중지)");
    expect(verify).toContain('data-level="idle"');
    expect(text(verify)).toContain("의도적 중지 잡 일시중지: product-search-verify");
    // 2차 투표자 2의 1순위가 0건
    expect(text(html.match(/<tr id="execution-second-review-2"[^]*?<\/tr>/)![0])).toContain("1순위 gpt-oss-120b 0건 — 다른 모델이 처리");
    // 머리: 상태 수와 범례(색만으로 가르지 않는다)
    expect(html).toContain('data-count="bad"');
    for (const label of ["정상", "느림·주의", "멈춤·실패", "의도적 중지·쉼", "확인 불가"]) expect(html).toContain(`</span>${label}</span>`);
    // 서랍은 처음에 닫혀 있다
    expect(html).not.toContain('class="fr"');
  });

  it("2026-11-09: 1시간 안에 바꾼 순위는 「설정과 다름」 대신 메모, 진행 중인 감사도 없고 변경 재판정도 꺼졌거나 Grok 연결이 없으면 「쓰지 않음」 — 못 읽으면 「순위 없음」 그대로", async () => {
    const { db } = await import("@/lib/db");
    // 진행 중인 감사 없음 · 재판정 거절 없음(두 읽기) · 변경 재판정 꺼짐(실시간 한도 askBatch 0)
    vi.mocked(db.execute).mockResolvedValueOnce([{ running: false }] as never).mockResolvedValueOnce([{ open: false }] as never);
    setRuntimeSettingsForTest({ version: 1, jobs: { "published-recheck": { askBatch: 0 } } });
    // 수집 소개 짓기의 1순위를 07:00Z 에 deepseek 로 바꿨다 — 장부 1시간의 gpt-oss 100건은 그 전 순위의 호출이다
    const rows = llmRankRows.map(row => row.task === "crawl-tagline" ? { ...row, model: "deepseek-v4.1-flash-1017" } : row);
    const saved = slots(rows).map(slot => slot.task.id === "crawl-tagline" ? { ...slot, savedAt: "2026-11-07T07:00:00.000Z" } : slot);
    const html = renderToStaticMarkup(await TaskAssignSlot({ view: adminView({ rows, slots: saved }), executions: [], readOnly: false }));
    expect(db.execute).toHaveBeenCalledTimes(2);
    const tagline = html.match(/<tr id="execution-crawl-tagline-1"[^]*?<\/tr>/)![0];
    expect(text(tagline)).toContain("순위를 20분 전에 바꿈 — 그 전 호출이 섞여 있어 17:00 이후 비교");
    expect(tagline).toContain('data-position="earlier"');
    expect(tagline).not.toContain("설정과 다름");
    const audit = html.match(/<tr id="execution-product-audit-1"[^]*?<\/tr>/)![0];
    expect(audit).toContain('data-level="idle"');
    expect(text(audit)).toContain("쓰지 않음 진행 중인 감사 없음 · 변경 재판정 꺼짐");
    expect(text(html.match(/<tr id="execution-grok-session-check-1"[^]*?<\/tr>/)![0])).toContain("쓰지 않음 Grok CLI 연결 없음");
    // 장부 밖 작업은 「정상」이 아니다(이 픽스처는 실제 적용 설정이 없어 그 까닭이 앞선다)
    const embedding = text(html.match(/<tr id="execution-product-embedding-1"[^]*?<\/tr>/)![0]);
    expect(embedding).toContain("장부 밖 작업 — 호출 수를 세지 않습니다");
    expect(embedding).not.toContain("정상");
    vi.mocked(db.execute).mockRejectedValueOnce(new Error("db down"));
    const unread = renderToStaticMarkup(await TaskAssignSlot({ view: adminView(), executions: [], readOnly: false }));
    expect(text(unread.match(/<tr id="execution-product-audit-1"[^]*?<\/tr>/)![0])).toContain("멈춤 순위 없음 — 이 작업은 돌지 않습니다");
    // 재판정이 켜져 있으면(기본 한도) 감사가 없어도 순위 없음은 멈춤이다 — 배포 뒤 순위를 저장하기 전
    setRuntimeSettingsForTest({ version: 1 });
    vi.mocked(db.execute).mockResolvedValueOnce([{ running: false }] as never).mockResolvedValueOnce([{ open: false }] as never);
    const on = renderToStaticMarkup(await TaskAssignSlot({ view: adminView(), executions: [], readOnly: false }));
    expect(text(on.match(/<tr id="execution-product-audit-1"[^]*?<\/tr>/)![0])).toContain("멈춤 순위 없음 — 이 작업은 돌지 않습니다");
    setRuntimeSettingsForTest(null);
  });

  it("2026-11-08: LLM 이 아닌 모델(벡터·재정렬) 작업은 표 아래 별도 섹션 — 앞 표에는 LLM 작업만", async () => {
    const html = renderToStaticMarkup(await TaskAssignSlot({ view: adminView(), executions: [], readOnly: false }));
    const [main, other] = html.split('<section class="tk-other" id="tasks-non-llm"');
    expect(other).toBeDefined();
    expect(other).toContain("LLM이 아닌 모델");
    for (const task of ["product-embedding", "search-embedding", "search-rerank"]) {
      expect(other, task).toContain(`id="execution-${task}-1"`);
      expect(main, task).not.toContain(`id="execution-${task}-1"`);
    }
    for (const task of ["first-review", "product-translate", "product-search-verify"]) expect(main, task).toContain(`id="execution-${task}-1"`);
    expect(text(main)).toMatch(/LLM 작업 \d+ LLM 아님 3/);
  });

  it("장부를 못 읽으면 숫자 대신 「확인 불가」, 실행 방식을 못 읽거나 읽기 전용이면 서랍 저장이 잠긴다고 알린다", async () => {
    mocks.observation.mockResolvedValue(unavailableAdminModels());
    const html = renderToStaticMarkup(await TaskAssignSlot({ view: adminView(), executions: null, readOnly: false }));
    expect(html).toContain("확인 불가 — 장부를 읽지 못했습니다");
    expect(html).not.toMatch(/<b class="llm-num">0<\/b>/);
    expect(html).toContain("실행 방식을 읽지 못했습니다 — 확인할 때까지 순위를 저장할 수 없습니다.");
    expect(html).toContain("실행 방식 미확인");
  });

  it("화면: #tasks 표 · 실행 방식 접힘(#modes, #mode-<작업>-<칸>) · #connections 는 LLM 운영으로 가는 짧은 안내 · #import · #audit 그대로", async () => {
    vi.doMock("@/app/(operator)/admin/models/tasks/task-assign-slot", () => ({ TaskAssignSlot: () => <p data-slot="task-assign">표</p> }));
    vi.resetModules();
    const { default: Page } = await import("@/app/(operator)/admin/models/tasks/page");
    mocks.executions.mockResolvedValue([{ task: "first-review", slot: 1, mode: "workload_pool", revision: 2, updatedAt: "2026-11-07T06:00:00.000Z",
      members: [{ memberId: "m1", position: 1, connectionId: GPU, model: "qwen3.8-flash-next", options: {} }] },
      { task: "crawl-tagline", slot: 1, mode: "fallback", revision: null, updatedAt: null, members: [] },
      { task: "human-review", slot: 1, mode: "fallback", revision: null, updatedAt: null, members: [] }]);
    mocks.view.mockResolvedValue(adminView({ keyConflicts: [], connections: llmConnections }));
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
    vi.doUnmock("@/app/(operator)/admin/models/tasks/task-assign-slot");
    for (const id of ["tasks", "modes", "connections", "import", "audit"]) expect(html, id).toContain(`id="${id}"`);
    expect(html).toContain('data-slot="task-assign"');
    // 실행 방식은 작업 분산을 받는 작업만(사람 몫 위임 검수는 아직 지원하지 않는다)
    expect(html).toContain('id="mode-first-review-1"');
    expect(html).toContain('id="mode-crawl-tagline-1"');
    expect(html).not.toContain('id="mode-human-review-1"');
    expect(html).toContain("분산 1개");
    // 연결 관리는 LLM 운영에서 — 이 화면에 연결 폼·「칸 수」가 없다
    expect(html).toContain('href="/admin/models/llm"');
    // 장비 칸을 작업마다 나누는 곳(칸 배분, step 3)
    expect(html).toContain('href="/admin/models/allocation">장비 칸을 작업별로 나누기(칸 배분) →</a>');
    expect(html).not.toContain('name="baseUrl"');
    expect(html).not.toContain("칸 수");
    expect(html).not.toContain('id="connection-form"');
    // 목록을 못 읽은 서버는 LLM 운영의 그 행으로 보낸다
    expect(html).toContain(`href="/admin/models/llm?edit=${M1}#conn-${M1}"`);
    // 최근 기록(#audit)은 그대로
    expect(html).toContain("LLM 운영 › 기록에서 전체 보기 →");
  });

  it("2026-11-11: LLM 보강 제어 접힘(#assist-controls)·없앤 작업의 옛 순위 기록(지우기)·보강 줄의 「보강 켜기·끄기 →」", async () => {
    vi.doMock("@/app/(operator)/admin/models/tasks/task-assign-slot", () => ({ TaskAssignSlot: () => <p data-slot="task-assign">표</p> }));
    vi.doMock("@/lib/operations/llm-assist-controls", () => ({ readAssistControls: async () => ({ error: null, controls: [
      { task: "uptime", mode: "confirm", confirmationRequired: true, dispatchEnabled: false, applyEnabled: false, revision: 7, updatedAt: null, label: "연결 확인",
        aiTask: "assist-review", aiTaskLabel: "LLM 보강", queue: { queued: 24055 } }] }) }));
    vi.doMock("@/app/(operator)/admin/models/tasks/assist-actions", () => ({ saveAssistControlAction: vi.fn() }));
    vi.resetModules();
    const { default: Page } = await import("@/app/(operator)/admin/models/tasks/page");
    mocks.view.mockResolvedValue(adminView({ rows: [...llmRankRows, { task: "korean-translation-direct", slot: 1, rank: 1, connectionId: GPU, model: "qwen3.8-flash-next",
      options: {}, enabled: true }] }));
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
    vi.doUnmock("@/app/(operator)/admin/models/tasks/task-assign-slot");
    vi.doUnmock("@/lib/operations/llm-assist-controls");
    vi.doUnmock("@/app/(operator)/admin/models/tasks/assist-actions");
    // 보강 제어: 일마다 단계·보내기·반영, 확인 필수는 끌 수 없다고 적는다, 대기 수
    const assist = html.match(/<details id="assist-controls"[^]*?<\/details>/)![0];
    expect(text(assist)).toContain("LLM 보강 제어");
    expect(text(assist)).toContain("연결 확인 uptime · LLM 보강");
    expect(text(assist)).toContain("대기 24,055");
    expect(text(assist)).toContain("확인 후 반영 · 보내기 꺼짐 · 반영 꺼짐");
    expect(text(assist)).toContain("확인 필수(끌 수 없음) — 옛 자동 내림이 보강 확인을 기다립니다");
    expect(assist).toContain('name="mode"');
    expect(assist).toContain('name="revision" value="7"');
    // 없앤 작업의 옛 순위 행 — LLM 운영 칩이 거는 앵커로, 지우기만
    expect(html).toContain('id="execution-korean-translation-direct-1"');
    expect(text(html)).toContain("한국어 소개 번역 · 직접 경로(없앤 작업) · 순위 1개");
    expect(html).toContain('aria-label="한국어 소개 번역 · 직접 경로(없앤 작업) 옛 순위 기록 1개 지우기"');
    // 보강 표 줄의 링크(표 자체)
    const table = renderToStaticMarkup(await TaskAssignSlot({ view: adminView(), executions: [], readOnly: false }));
    expect(table.match(/<tr id="execution-assist-review-1"[^]*?<\/tr>/)![0]).toContain('href="#assist-controls"');
    expect(table.match(/<tr id="execution-assist-audit-1"[^]*?<\/tr>/)![0]).toContain("보강 켜기·끄기 →");
    expect(table.match(/<tr id="execution-crawl-tagline-1"[^]*?<\/tr>/)![0]).not.toContain("#assist-controls");
  });

  it("옛 「연결 고치기」 주소(?edit=<연결>)는 LLM 운영의 그 행으로 넘긴다", async () => {
    await expect(AiTasksPage({ searchParams: Promise.resolve({ edit: MLX }) })).rejects.toThrow(`NEXT_REDIRECT:/admin/models/llm?edit=${MLX}#conn-${MLX}`);
    expect(mocks.view).not.toHaveBeenCalled();
  });

  it("예전 줄마다 펼치던 순위판은 없다 — 순위 저장은 운영 홈과 같은 서랍 하나", () => {
    const board = readFileSync("app/(operator)/admin/models/tasks/TaskAssignBoard.tsx", "utf8");
    expect(board).toContain('import { RankDrawer } from "../../flow/RankDrawer";');
    expect(board).not.toMatch(/import [^;]*(saveAiTaskRanksAction|useActionState)/);
    const page = readFileSync("app/(operator)/admin/models/tasks/page.tsx", "utf8");
    expect(page).not.toMatch(/TaskRanksBoard|ConnectionForm|RankSelects/);
  });
});

describe("작업 배정에서 여는 서랍(운영 홈과 같은 RankDrawer)", () => {
  const editorOf = () => withTaskReadiness(buildTaskRankEditor(llmConnections, llmRankRows, () => "a".repeat(64)), slots().map(slot => slot.task.id === "crawl-tagline"
    ? { ...slot, readiness: [{ ...slot.readiness[0], warnings: ["알림 하나"], createDevice: { deviceId: "m3-mlx", limitSlots: 1 } }] as AiTaskSlotView["readiness"] } : slot));

  it("고르기: 모델 옆 추론 강도, 저장된 순위의 알림, 빠진 것이 있으면 「바꾸지 않고 다시 저장」 — 작업 배정 안에서는 「전체 보기」 링크가 없다", () => {
    const editor = editorOf();
    const html = renderToStaticMarkup(<RankDrawer editor={editor} lines={editor.lines.filter(line => line.task === "crawl-tagline")} title="수집 소개 짓기" secondWaiting={null}
      onClose={() => {}} fullViewHref={null} devices={taskAssignDeviceLimits(llmObservation())} />);
    expect(html).toContain("1 모델·추론 강도 고르기");
    expect(html).toContain('aria-label="수집 소개 짓기 1순위"');
    expect(html).toContain('data-note="readiness"');
    expect(html).toContain("알림 하나");
    expect(html).toContain('data-resave="crawl-tagline#1"');
    // 2026-11-09: 서버 문장 속 장비 id 는 그 장비를 쓰는 연결 이름으로 보인다(이 픽스처의 m3-mlx 장비 연결은 「m3-mlx (2)」 하나)
    expect(html).toContain("장비 행 m3-mlx (2)이(가) 없습니다 — 저장하면 1칸으로 만듭니다.");
    expect(html).toContain("바꾸지 않고 다시 저장");
    expect(html).not.toContain("작업 배정에서 전체 보기");
    // 운영 홈에서 열면 링크가 있다
    const flow = renderToStaticMarkup(<RankDrawer editor={editor} lines={editor.lines.filter(line => line.task === "crawl-tagline")} title="프로필 준비" secondWaiting={null}
      onClose={() => {}} />);
    expect(flow).toContain('<a class="fr-link" href="/admin/models/tasks#tasks">작업 배정에서 전체 보기 →</a>');
  });

  it("확인: 바뀌는 작업(전→후)과 장비 한도·함께 쓰는 작업, 다시 저장은 「순위 그대로」로 보인다", () => {
    const editor = editorOf();
    const devices = taskAssignDeviceLimits(llmObservation());
    const changed = renderToStaticMarkup(<RankDrawer editor={editor} lines={editor.lines.filter(line => line.task === "crawl-tagline")} title="수집 소개 짓기" secondWaiting={null}
      onClose={() => {}} fullViewHref={null} devices={devices} initial={{ step: "confirm", drafts: { "crawl-tagline#1": [{ provider: GPU, model: "qwen3.8-flash-next" }] } }} />);
    expect(changed).toContain("1순위 m3-mlx (2) · gpt-oss-120b");
    expect(changed).toContain("1순위 gpu3090-qwen");
    expect(changed).not.toContain("1순위 gpu3090-qwen · qwen3.8-flash-next");
    expect(changed).toContain("장비 한도 · 함께 쓰는 작업");
    expect(text(changed)).toContain("gpu3090-qwen 2 / 5칸 사용 중 1차 AI 검수");
    const resave = renderToStaticMarkup(<RankDrawer editor={editor} lines={editor.lines.filter(line => line.task === "crawl-tagline")} title="수집 소개 짓기" secondWaiting={null}
      onClose={() => {}} fullViewHref={null} devices={devices} initial={{ step: "confirm", resave: ["crawl-tagline#1"] }} />);
    expect(resave).toContain("다시 저장(순위 그대로)");
    expect(resave).toMatch(/class="fr-btn fr-primary">저장<\/button>/);
  });

  it("2026-11-08: 서랍 모양 — 공용 dialog 규칙(가운데 680px·91dvh 카드)보다 앞서는 오른쪽 위 시트, 높이는 내용만큼, 관리자 틀 색으로 읽힌다", () => {
    const css = readFileSync("app/(operator)/admin/flow/rank-drawer.css", "utf8");
    const sheet = css.match(/:is\(\.admin-prototype, body\) dialog\.fr\{([^}]*)\}/)?.[1] ?? "";
    // .admin-prototype dialog·dialog:modal(0,1,1)보다 구체적이다 — 서랍이 카드로 가운데 뜨고 아래 절반이 비던 까닭
    for (const rule of ["inset:0 0 auto auto", "margin:0", "width:min(760px,100%)", "height:auto", "max-height:100dvh"]) expect(sheet, rule).toContain(rule);
    expect(sheet).not.toContain("100vw");
    expect(css).toMatch(/\.fr-in\{[^}]*max-height:calc\(100dvh - 1px\)/);
    expect(css).toMatch(/\.fr-body\{[^}]*min-height:0;overflow:auto/);
    // 3차 글자(--text-3·--color-fg-3)는 관리자 틀 안에서 --muted — 유틸리티(@theme inline)가 읽는 원래 이름도 함께
    const tokens = css.match(/\.admin-prototype \.fr\{([^}]*)\}/)?.[1] ?? "";
    for (const token of ["--color-fg-3:var(--muted)", "--text-3:var(--muted)", "--text-2:var(--muted)", "--color-bg-card:var(--surface)", "--bg-card:var(--surface)"]) expect(tokens, token).toContain(token);
  });

  it("저장할 수 없는 까닭이 있으면 서랍의 저장 단추를 잠그고 까닭을 보인다", () => {
    const editor = editorOf();
    const html = renderToStaticMarkup(<RankDrawer editor={editor} lines={editor.lines.filter(line => line.task === "crawl-tagline")} title="수집 소개 짓기" secondWaiting={null}
      onClose={() => {}} fullViewHref={null} lockReason="실행 방식을 읽지 못했습니다 — 확인할 때까지 순위를 저장할 수 없습니다."
      initial={{ step: "confirm", drafts: { "crawl-tagline#1": [{ provider: GPU, model: "qwen3.8-flash-next" }] } }} />);
    expect(html).toContain('<p class="fr-locked" role="alert">실행 방식을 읽지 못했습니다');
    expect(html).toMatch(/<button type="button" class="fr-btn fr-primary" disabled="">저장<\/button>/);
  });

  it("2차 투표자는 서버마다 묶인 선택지에서 다른 투표자의 모델을 흐리게 둔다(예전 순위판과 같은 규칙)", () => {
    const editor = editorOf();
    const html = renderToStaticMarkup(<RankDrawer editor={editor} lines={editor.lines.filter(line => line.task === "second-review")} title="2차 AI 검수" secondWaiting={null}
      onClose={() => {}} fullViewHref={null} />);
    expect(html.match(/aria-label="2차 AI 검수 · 투표자 [123] [123]순위"/g)).toHaveLength(9);
    // 투표자 2 칸에서는 투표자 1의 supa 를, 투표자 1 칸에서는 투표자 2의 gpt-oss 를 고를 수 없다(같은 모델 두 표 금지)
    // supa 의 두 이름은 한 모델(같은 root) — 사용자가 정한 이름 하나로 보인다(운영 콘솔 통합)
    expect(html).toContain(`<option value="${SUPA}/supa" disabled="">supa-direct — 상태 확인 중 · 이 투표자/모델 조건에서 선택 불가</option>`);
    expect(html).not.toContain("Inferact/Qwen3.8-27B-NVFP4 —");
    expect(html).toContain(`<option value="${MLX}/gpt-oss-120b" disabled="">gpt-oss-120b — 상태 확인 중 · 이 투표자/모델 조건에서 선택 불가</option>`);
    expect(html).toContain('<optgroup label="supa-direct · API">');
    // 작업 분산 칸의 링크는 작업 배정의 실행 방식 접힘으로
    const pooled = buildTaskRankEditor(llmConnections, llmRankRows, () => "a".repeat(64), [{ task: "first-review", slot: 1, mode: "workload_pool", revision: 2, updatedAt: null,
      members: [{ memberId: "m1", position: 1, connectionId: GPU, model: "qwen3.8-flash-next", options: {} }] } as never]);
    const pool = renderToStaticMarkup(<RankDrawer editor={pooled} lines={pooled.lines.filter(line => line.task === "first-review")} title="1차" secondWaiting={null} onClose={() => {}} />);
    expect(pool).toContain('href="/admin/models/tasks#mode-first-review-1"');
    expect(pooled.lines.find(line => line.task === "first-review")?.lock).toContain("「작업 배정」의 실행 방식에서");
  });
});
