import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/status/job-control-actions", () => ({ controlJobAction: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/tasks/actions", () => ({ saveAiTaskRanksAction: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/tasks/execution-actions", () => ({ saveTaskExecutionAction: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/limits/actions", () => ({ saveRuntimeLimits: vi.fn() }));

import { StagePanel } from "@/app/(operator)/admin/flow/StagePanel";
import type { AiConnectionView, AiTaskRankRow } from "@/lib/operations/admin-ai-tasks";
import { buildChangeWatch, collectChanges } from "@/lib/operations/change-watch";
import { buildConsoleTasks } from "@/lib/operations/console-tasks";
import { buildFlowRankEditor } from "@/lib/operations/flow-rank-editor";
import { stagePanel } from "@/lib/operations/stage-panel-catalog";
import { buildStagePanel, previewContext, stageChanges, type StagePanelInput } from "@/lib/operations/stage-panel-model";
import { stageLimitScope } from "@/lib/operations/stage-panel-read";
import { consoleFixtureExecutions, consoleFixtureInputs, consoleFixtureJobStates, consoleFixtureLimits, consoleFixtureRuntime } from "./fixtures/console-home";
import { WATCH_AUDIT, WATCH_CONTEXT, WATCH_LEDGER, WATCH_NOW } from "./fixtures/change-watch";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const csrf = { token: "fixture-token", expiresAt: 9_999_999_999 };

/** 순위 편집기 — 흐름 서랍과 같은 builder 에 fixture 의 연결·순위·실행 설정을 넣는다(연결은 화면 DTO 모양만 채운다) */
function editor() {
  const inputs = consoleFixtureInputs();
  const connections = (inputs.connections ?? []).map(row => ({ id: row.id, label: row.label, kind: row.kind, baseUrl: null, host: null, hasKey: true,
    cliTool: row.cliTool, cliModels: row.kind === "cli" ? row.models : [], models: row.kind === "api" ? row.models.map(id => ({ id, maxModelLen: null })) : null,
    modelsReadAt: null, modelsError: null, deviceId: row.deviceId, capacitySlots: row.capacitySlots, contextTokens: null, enabled: row.enabled, version: 1, note: null,
    updatedBy: "jr", updatedAt: row.updatedAt, cliVersion: null, allowedTasks: row.allowedTasks })) as unknown as AiConnectionView[];
  const rows: AiTaskRankRow[] = (inputs.ranks ?? []).map(row => ({ ...row, options: {} }));
  return buildFlowRankEditor(connections, rows, () => "0".repeat(64), consoleFixtureExecutions());
}

function render(key: StagePanelInput["key"], options: { csrf?: typeof csrf | null; lockReason?: string | null; withEditor?: boolean } = {}) {
  const inputs = consoleFixtureInputs();
  const panel = buildStagePanel({ key, now: inputs.now, conveyor: inputs.conveyor as StagePanelInput["conveyor"], inputs, board: buildConsoleTasks(inputs),
    jobStates: consoleFixtureJobStates(), pauses: [], degraded: [], runtime: consoleFixtureRuntime(), executions: consoleFixtureExecutions() })!;
  const limits = consoleFixtureLimits();
  const scope = stageLimitScope(stagePanel(key)!, limits);
  const watch = buildChangeWatch(collectChanges(WATCH_AUDIT, WATCH_CONTEXT), WATCH_LEDGER, WATCH_NOW);
  return renderToStaticMarkup(<StagePanel panel={panel} editor={options.withEditor === false ? null : editor()} context={previewContext(inputs)} limits={limits}
    limitRows={scope.rows} limitImpact={scope.impact} changes={stageChanges(watch.rows, panel)} changesRead csrf={options.csrf === undefined ? csrf : options.csrf}
    jobVersions={{ "crawl-agent-review": 27001, "crawl-fetch": 3 }} readOnly={false} lockReason={options.lockReason ?? null} now={new Date(inputs.now)} />);
}

describe("stage panel — AI 1차 (fixture 2026-11-12 08:59 KST)", () => {
  const html = render("first");
  const plain = text(html);

  it("draws the five parts in the design's order", () => {
    const order = ['id="sp-title"', 'id="sp-why"', 'id="sp-jobs"', 'id="sp-models-title"', 'id="sp-limits-title"', 'id="sp-changes"'].map(id => html.indexOf(id));
    expect(order.every(index => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('<aside class="sp" aria-labelledby="sp-title" data-stage="first">');
    // 닫기는 주소에서 ?stage= 를 뺀다 — 새로고침·공유도 같은 패널
    expect(html).toMatch(/<a class="sp-close" aria-label="단계 패널 닫기" href="\/admin\/flow">/);
  });

  it("heads with the status, the numbers and the hourly line", () => {
    expect(plain).toContain("AI 1차 거의 멈춤");
    expect(plain).toContain("대기 857 가장 오래된 것 8시간 2분 최근 1시간 3 24시간 2,479");
    expect(html).toMatch(/<svg class="ch-spark sp-spark" data-tone="bad" viewBox="0 0 320 44"/);
  });

  it("writes only read facts under 「왜 이런가」", () => {
    expect(plain).toContain("워커 틱마다 후보 2건을 「이미 처리 중」으로 건너뛰고 끝납니다(건너뜀 사유 running).");
    expect(plain).toContain("1순위 supa-direct는 3칸 중 3칸을 쓰고 있고, 쓰는 쪽은 키워드 검수입니다.");
    expect(plain).toContain("2순위 gpu3090-qwen은 5칸이 모두 비어 있습니다.");
    expect(plain).toContain("추이 11-12 01시대에 시간당 139건에서 35건으로 떨어졌고, 06시대는 0건이었습니다. 원인 미확인.");
    expect(html).toContain('href="/admin/review?tab=all&amp;stage=ai">1차 대상 보기</a>');
  });

  it("offers the existing pause control for the stage's job", () => {
    expect(html).toMatch(/<summary class="button small">잠시 멈춤<\/summary><form[^>]*>.*멈춤 사유/);
    const readOnly = render("first", { csrf: null });
    expect(readOnly).not.toContain("잠시 멈춤");
    expect(readOnly).toContain('href="/admin/status?tab=jobs&amp;job=crawl-agent-review">작업 상세</a>');
  });

  it("shows the way (순위대로 · 동시에), the ranking with live slots and the idle models beside 「모델 붙이기」", () => {
    expect(html).toMatch(/<div class="sp-seg" role="group" aria-label="1차 AI 검수 방식"><button type="button" aria-pressed="true">순위대로<\/button><button type="button" aria-pressed="false">동시에<\/button>/);
    expect(plain).toContain("1순위 supa-direct Inferact/Qwen3.8-27B-NVFP4 지금 3/3칸 · 24시간 88건 · 3.8초");
    expect(plain).toContain("2순위 gpu3090-qwen qwen3.8-flash-next 지금 0/5칸 · 24시간 639건 · 3.2초");
    expect(plain).toContain("＋ 모델 붙이기·고치기 남는 모델 1개 · M1max(0% · 2칸)");
  });

  it("puts the limits with 24-hour measurements next to them and the existing editor scoped to this stage", () => {
    expect(plain).toContain("호출 상한 60초 상한에서 끊김 24시간 2,718건 중 74건 한 틱 110초 동시 호출 장비 한도가 정함");
    expect(html).toContain("<summary>한도 고치기</summary>");
    expect(html).toContain('id="row-first-review"');
    for (const other of ["row-product-translate", "row-reason-translate", "row-product-intro-check"]) expect(html).not.toContain(`id="${other}"`);
    // 화면 전체의 자동 틱 여유·AI 밖 작업 칸은 패널에 없다
    expect(html).not.toContain("「자동」 틱 시간 = 호출 상한 +");
    expect(html).not.toContain('id="budgets"');
  });

  it("lists only the changes that touched this stage", () => {
    expect(plain).toMatch(/최근 바뀐 것 11-12 07:10 1차 AI 검수 1순위를 supa로 · jr 시간당 17건 → 첫 1시간 86건 → 지금 3건 다시 떨어짐/);
    expect(plain).not.toContain("모델 M1max 추가");
  });
});

describe("stage panel — other cases", () => {
  it("gives a stage without models its jobs and settings, without model or limit parts", () => {
    const html = render("fetch");
    expect(html).not.toContain('id="sp-models"');
    expect(html).not.toContain('id="sp-limits"');
    expect(text(html)).toContain("작업 · 주기 · 마지막 성공 원본 수집 도는 중 · 주기 1분 · 마지막 성공 11-12 08:58");
    expect(text(html)).toContain("최근 24시간에 이 단계에 닿은 변경이 없습니다.");
  });

  it("does not offer edits when saving is locked or the ranking could not be read", () => {
    const locked = render("first", { lockReason: "읽기 전용 미리보기 — 여기서는 저장할 수 없습니다." });
    expect(locked).not.toContain("모델 붙이기");
    expect(text(locked)).toContain("읽기 전용 미리보기 — 여기서는 저장할 수 없습니다.");
    const unread = render("first", { withEditor: false });
    expect(text(unread)).toContain("순위를 읽지 못해 여기서 바꿀 수 없습니다.");
    expect(unread).toContain('href="/admin/models/tasks">작업 배정 →</a>');
  });

  it("keeps 소개 검수 locked like the flow drawer and shows a pooled stage as 「동시에」", () => {
    const intro = text(render("intro-check"));
    expect(intro).toContain("화면에서 바꿀 수 없습니다 — 소개 검수는 Claude CLI 전용 코드");
    expect(intro).toContain("사람이 멈춤 소개 검수 작업이 멈춰 있습니다 — 멈춘 기록(작업 로그)을 찾지 못했습니다.");
    const publish = render("publish");
    expect(publish).toMatch(/aria-pressed="false"[^>]*>기존 CLI 분류<\/button><button type="button" aria-pressed="true">동시에<\/button>/);
    expect(text(publish)).toContain("함께 m3-deepseek deepseek-v4.1-flash-1017 지금 2/3칸 · 24시간 85건 · 24.5초");
  });
});
