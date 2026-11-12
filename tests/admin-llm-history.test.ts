import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_GROUPS } from "@/app/(operator)/admin/activity/labels";
import { buildRetryView, LLM_HISTORY_ACTIONS, LLM_HISTORY_KIND_IDS, LLM_HISTORY_KINDS, llmHistoryFilter, llmHistoryHref, llmHistoryKindOf, recentFailures,
  RECENT_AUDIT_ROWS } from "@/lib/operations/llm-ops-history";
import { LLM_RETRY_HREF, buildDashboardView } from "@/lib/operations/llm-ops-view";
import type { CapacityReviewItem } from "@/lib/operations/model-capacity-unknowns";
import { summarizeRequeue } from "@/lib/operations/model-capacity-requeue";
import { requeueSummaryText } from "@/lib/operations/model-capacity-requeue-text";
import { unavailableAdminModels } from "@/lib/operations/admin-models-observation";
import { LLM_NOW, llmConnections, llmConveyor, llmObservation } from "./fixtures/llm-ops";

const item = (n: number, over: Partial<CapacityReviewItem> = {}): CapacityReviewItem => ({ requestId: `7e2c1a90-0000-4000-8000-00000000000${n}`, routeId: "crawl-agent-review",
  provider: "local-direct", model: "qwen3.8-flash-next", groupId: "gpu3090-qwen", providerBudgetId: "gpu3090-qwen", workKey: `candidate:${n}`, logicalWorkKey: null,
  ownerInstanceId: "m3-reviewer", dispatchedAt: `2026-11-07T05:1${n}:00.000Z`, markedAt: null, reason: "client_timeout", oldPolicy: false, localEndRecorded: false, ...over });

describe("변경 기록 갈래 — 작업 로그 「LLM 운영」 묶음을 빠짐없이 한 번씩 나눈다", () => {
  it("네 갈래의 합이 ACTION_GROUPS.llm 과 같고 겹치지 않는다", () => {
    expect([...LLM_HISTORY_ACTIONS].sort()).toEqual([...ACTION_GROUPS.llm.actions].sort());
    expect(new Set(LLM_HISTORY_ACTIONS).size).toBe(LLM_HISTORY_ACTIONS.length);
    expect(LLM_HISTORY_KIND_IDS.map(kind => LLM_HISTORY_KINDS[kind].label)).toEqual(["연결", "한도", "순위", "조치"]);
    expect(llmHistoryKindOf("runtime-settings-save")).toBe("limit");
    expect(llmHistoryKindOf("ai-task-models-save")).toBe("rank");
    expect(llmHistoryKindOf("model-capacity-unknown-requeued")).toBe("action");
    expect(llmHistoryKindOf("ai-connection-save")).toBe("connection");
    expect(llmHistoryKindOf("job-pause")).toBeNull();
  });

  it("주소 거르기 — 모르는 갈래는 전체, id 범위 밖은 버린다, 주소는 #audit 로 간다", () => {
    expect(llmHistoryFilter({ kind: "limit", failed: "1", before: "25500" })).toEqual({ kind: "limit", failedOnly: true, before: 25500 });
    expect(llmHistoryFilter({ kind: "toString", failed: "0", before: "9999999999" })).toEqual({ kind: null, failedOnly: false, before: null });
    expect(llmHistoryFilter({})).toEqual({ kind: null, failedOnly: false, before: null });
    expect(llmHistoryHref()).toBe("/admin/models/history#audit");
    expect(llmHistoryHref({ kind: "rank", failedOnly: true, before: 7 })).toBe("/admin/models/history?kind=rank&failed=1&before=7#audit");
    expect(RECENT_AUDIT_ROWS).toBe(3);
  });
});

describe("재실행 패널 — 단계(route)별 묶음", () => {
  it("모델·까닭·근거를 묶음 안에서 세고, 서버 지원 여부를 그대로 싣는다", () => {
    const view = buildRetryView({ items: [item(1), item(2, { model: "opencode-go/deepseek-v4.1-flash", reason: "transport_unknown", localEndRecorded: true }),
      item(3, { routeId: "human-deepseek-review", reason: null, oldPolicy: true })], truncated: true, error: null,
    groups: [{ routeId: "crawl-agent-review", count: 140 }, { routeId: "human-deepseek-review", count: 1 }] }, route => route === "crawl-agent-review");
    expect(view.total).toBe(141); expect(view.supportedTotal).toBe(140); expect(view.truncated).toBe(true);
    const [first, human] = view.groups;
    expect(first).toMatchObject({ routeId: "crawl-agent-review", label: "1차 AI 검수", count: 140, sampled: 2, supported: true, localEnded: 1, oldestAt: "2026-11-07T05:11:00.000Z" });
    expect(first.models.map(model => [model.label, model.count])).toEqual([["opencode-go/deepseek-v4.1-flash", 1], ["qwen3.8-flash-next", 1]]);
    expect(first.reasons.map(reason => reason.label)).toEqual(["시간 초과", "결과 모름"]);
    expect(human).toMatchObject({ supported: false, oldPolicy: 1 });
    expect(human.reasons[0].label).toBe("사유 기록 없음");
  });
  it("묶음 수를 못 읽었으면 목록에서 세고, 목록을 못 읽었으면 readable=false", () => {
    expect(buildRetryView({ items: [item(1), item(2)], truncated: false, error: null, groups: [] }, () => true).groups).toMatchObject([{ routeId: "crawl-agent-review", count: 2 }]);
    expect(buildRetryView({ items: [], truncated: false, error: "statement timeout", groups: [] }, () => true)).toMatchObject({ readable: false, total: 0, error: "statement timeout" });
  });
  // 2026-11-09: 행마다 「다시 대기열」을 누르면 어떻게 되는지(미리보기) — 남는 행은 까닭을 단다. 미리보기를 못 읽었으면 plan 은 null(지어내지 않는다)
  it("미리보기를 행마다 싣고 묶음에서 다시 넣음·끝나서 닫음·남음(까닭)을 센다", () => {
    const queue = { items: [item(1), item(2), item(3)], truncated: false, error: null, groups: [{ routeId: "crawl-agent-review", count: 3 }] };
    const preview = new Map([[item(1).requestId, { outcome: "requeued" as const, reason: "requeued" }], [item(2).requestId, { outcome: "done" as const, reason: "candidate_decided" }],
      [item(3).requestId, { outcome: "skipped" as const, reason: "key_unreadable" }]]);
    const view = buildRetryView(queue, () => true, preview);
    expect(view.items.map(row => row.plan)).toEqual([{ outcome: "requeued", reason: "requeued", text: "다시 넣음" },
      { outcome: "done", reason: "candidate_decided", text: "후보 판정이 이미 남(사람·거절·발행)" },
      { outcome: "skipped", reason: "key_unreadable", text: "작업 키를 읽지 못함 — 한 건씩 닫기" }]);
    expect(view.groups[0].plan).toEqual({ requeue: 1, close: 1, left: 1, reasons: [{ key: "key_unreadable", label: "작업 키를 읽지 못함 — 한 건씩 닫기", count: 1 }] });
    const unread = buildRetryView(queue, () => true, null);
    expect(unread.groups[0].plan).toBeNull(); expect(unread.items.every(row => row.plan === null)).toBe(true);
  });
});

describe("「다시 대기열」 결과 한 줄 — N건 다시 넣음 · M건 닫음 · K건 남음(까닭)", () => {
  it("단계별 결과를 모아 한 줄로 쓰고, 남은 행이 없으면 까닭을 붙이지 않는다", () => {
    const summary = summarizeRequeue({ closed: 5, leftRows: [], groups: [
      { routeId: "crawl-agent-review", requests: 4, requeued: 1, done: 3, skipped: 0, closed: 4, left: [], error: null },
      { routeId: "second-review", requests: 1, requeued: 1, done: 0, skipped: 0, closed: 1, left: [], error: null },
      { routeId: "local-human-deepseek", requests: 2, requeued: 0, done: 0, skipped: 2, closed: 0, left: [{ reason: "unsupported_route", count: 2 }], error: null },
      { routeId: "product-translate", requests: 1, requeued: 0, done: 0, skipped: 1, closed: 0, left: [{ reason: "close_failed", count: 1 }], error: null }] });
    expect(summary).toEqual({ requests: 8, requeued: 2, done: 3, closed: 5, left: 3,
      reasons: [{ reason: "unsupported_route", count: 2 }, { reason: "close_failed", count: 1 }] });
    expect(requeueSummaryText(summary)).toBe("2건 다시 넣음 · 5건 닫음 · 3건 남음(다시 대기열을 지원하지 않는 단계 — 근거를 보고 한 건씩 닫기 2 · "
      + "작업은 처리했으나 장부 행을 닫지 못함 — 다시 누르기 1)");
    expect(requeueSummaryText({ ...summary, left: 0, reasons: [] })).toBe("2건 다시 넣음 · 5건 닫음");
    expect(requeueSummaryText({ requests: 0, requeued: 0, done: 0, closed: 0, left: 0, reasons: [] })).toBe("다시 넣을 결과 미확정 행이 없습니다");
  });
});

describe("최근 1시간 실패 · 대시보드 할 일", () => {
  it("실패가 있는 줄만 많은 순으로, 장부를 못 읽었으면 null", () => {
    const rows = recentFailures(llmObservation())!;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row.failed > 0)).toBe(true);
    expect(rows.map(row => row.failed)).toEqual([...rows.map(row => row.failed)].sort((a, b) => b - a));
    expect(recentFailures(unavailableAdminModels())).toBeNull();
  });
  it("미확정 할 일은 기록 › 재실행으로 잇고, 서버가 지원하는 단계에만 바로 누르는 단추를 둔다", () => {
    const input = { now: LLM_NOW, observation: llmObservation(), conveyor: llmConveyor(), jobs: [], connections: llmConnections };
    const todo = (view: ReturnType<typeof buildDashboardView>) => [...view.todos].find(entry => entry.id === "indeterminate");
    const supported = todo(buildDashboardView({ ...input, requeueSupported: () => true }));
    expect(supported).toMatchObject({ href: LLM_RETRY_HREF, action: "재실행 패널" });
    expect(supported?.retry?.[0]).toMatchObject({ count: 1 });
    expect(todo(buildDashboardView({ ...input, requeueSupported: () => false }))?.retry).toBeUndefined();
    expect(todo(buildDashboardView(input))?.retry).toBeUndefined();
  });
});

describe("하위 화면의 변경 기록은 최근 3건만, 나머지는 기록 한 표로", () => {
  const root = path.resolve(__dirname, "..");
  it.each([["devices", 'llmHistoryHref({ kind: "limit" })'], ["limits", 'llmHistoryHref({ kind: "limit" })'], ["helpers", 'llmHistoryHref({ kind: "limit" })'],
    ["assignments", 'llmHistoryHref({ kind: "rank" })']])("%s", (page, link) => {
    const source = readFileSync(path.join(root, `app/(operator)/admin/models/${page}/page.tsx`), "utf8");
    expect(source).toContain("view.audit.slice(0, RECENT_AUDIT_ROWS).map(");
    expect(source).not.toMatch(/view\.audit\.map\(/);
    expect(source).toContain(`href={${link}}`);
  });
  it("통합 모델의 최근 변경은 기존 기록 조회에서 세 건만 읽고 같은 전체 기록으로 잇는다", () => {
    const read = readFileSync(path.join(root, "lib/operations/model-unified-read.ts"), "utf8");
    const view = readFileSync(path.join(root, "app/(operator)/admin/models/unified/UnifiedOperations.tsx"), "utf8");
    expect(read).toContain('readLlmChangeLog({ kind: null, failedOnly: false, before: null }, 3)');
    expect(view).toContain("rows.slice(0, 3).map(");
    expect(view).toContain("href={llmHistoryHref()}");
    expect(view).not.toMatch(/changes\.rows\.map\([^]*?<tr/);
  });
  it("확인 못함 목록은 고급 영역에서 빠졌고 옛 #review 주소를 쓰는 곳이 없다", () => {
    const page = readFileSync(path.join(root, "app/(operator)/admin/models/page.tsx"), "utf8");
    expect(page).not.toContain("UnknownReviewSlot");
    for (const file of ["lib/operations/llm-ops-view.ts", "lib/operations/flow-response.ts", "app/(operator)/admin/models/ModelCallsPanel.tsx",
      "app/(operator)/admin/models/LiveModels.tsx", "app/(operator)/admin/models/SummaryTiles.tsx", "app/(operator)/admin/models/ModelStageTable.tsx"])
      expect(readFileSync(path.join(root, file), "utf8")).not.toMatch(/models(\?advanced=1)?#review|href="#review"|`#rv-/);
  });
});
