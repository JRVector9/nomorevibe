import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prerenderToNodeStream } from "react-dom/static";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildChangeWatch, collectChanges, type ChangeWatchRow, type ChangeWatchSnapshot } from "@/lib/operations/change-watch";
import { WATCH_AUDIT, WATCH_CONTEXT, WATCH_LEDGER, WATCH_NOW } from "./fixtures/change-watch";

const mocks = vi.hoisted(() => ({ watch: vi.fn(), admin: vi.fn(), log: vi.fn(), facets: vi.fn() }));
vi.mock("@/lib/operations/change-watch", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/operations/change-watch")>(), readChangeWatch: mocks.watch,
}));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin, adminLocalLoginEnabled: () => false, localOperatorName: async () => null, OPERATOR_NAME_MAX: 40 }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/operations/admin-log", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/operations/admin-log")>(), adminLogFacets: mocks.facets,
}));
vi.mock("@/app/(operator)/admin/activity/query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/app/(operator)/admin/activity/query")>(), activityLog: mocks.log,
}));

import { ChangeWatch, ChangeWatchTable, homeRows } from "@/app/(operator)/admin/flow/ChangeWatch";
import AdminActivityPage from "@/app/(operator)/admin/activity/page";

const snapshot = (): ChangeWatchSnapshot => buildChangeWatch(collectChanges(WATCH_AUDIT, WATCH_CONTEXT), WATCH_LEDGER, WATCH_NOW);
async function prerender(node: ReactNode): Promise<string> {
  const { prelude } = await prerenderToNodeStream(node);
  let html = "";
  for await (const chunk of prelude) html += chunk;
  return html.replace(/<!-- -->/g, "");
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ login: "jr" });
  mocks.facets.mockResolvedValue({ actions: [], actors: [] });
  mocks.watch.mockResolvedValue(snapshot());
});

describe("홈 · 바꾼 것 지켜보기 표", () => {
  it("때 · 바꾼 것 · 전 → 후 · 판정 — 열 폭 고정, 대표 사례는 「다시 떨어짐」", () => {
    const html = renderToStaticMarkup(<ChangeWatchTable watch={snapshot()} now={new Date(WATCH_NOW)} />);
    const plain = text(html);
    expect(html).toContain("table-fixed");
    expect(plain).toMatch(/때 바꾼 것 전 → 후 판정/);
    expect(plain).toContain("1차 AI 검수 1순위를 supa로");
    expect(plain).toContain("시간당 17건 → 첫 1시간 86건 → 지금 3건");
    expect(plain).toContain("다시 떨어짐");
    expect(plain).toContain("모델 M1max 추가 · 키 바꿈");
    expect(plain).toContain("호출 0건 · 쓰는 단계 없음");
    expect(plain).toContain("아직 안 씀");
    expect(plain).toContain("접수 중단 → 다시 열림 (18분)");
    expect(plain).toContain("판정 못 함");
    expect(plain).toContain("잰 구간에 접수 중단 9분이 겹칩니다");
    // 상태는 점 + 짧은 말, 바꾼 때는 오늘이면 「07:10」 아래에 「2시간 전」(좁은 때 칸 — 시안 열 폭 100px)
    expect(html).toMatch(/data-state="failed"/);
    expect(plain).toContain("07:10 2시간 전");
    expect(html).toContain('<col class="w-[100px]"/><col/><col class="w-[34%]"/><col class="w-[112px]"/>');
    // 바꾼 것은 잘라 내지 않고 줄을 바꾼다
    expect(html).not.toMatch(/class="block truncate font-semibold"/);
    // 쓰기 수단이 없다
    expect(html).not.toMatch(/<form|<button/);
  });

  it("빈 상태와 못 읽은 상태를 가른다", () => {
    const empty = renderToStaticMarkup(<ChangeWatchTable watch={{ ...snapshot(), rows: [] }} now={new Date(WATCH_NOW)} />);
    expect(text(empty)).toContain("최근 24시간에 바꾼 것이 없습니다");
    const failed = renderToStaticMarkup(<ChangeWatchTable watch={null} now={new Date(WATCH_NOW)} />);
    expect(text(failed)).toContain("바꾼 것을 읽지 못했습니다");
    expect(text(failed)).not.toContain("바꾼 것이 없습니다");
  });

  it("줄이 많으면 나쁜 판정은 남기고 나머지는 기록으로 보낸다", () => {
    const base = snapshot().rows.find(row => row.key === "28853")!;
    const rows: ChangeWatchRow[] = [...Array.from({ length: 10 }, (_, index) => ({ ...base, key: String(index), verdict: "same" as const })),
      { ...base, key: "old-bad", verdict: "worse" as const }];
    const { shown, hidden } = homeRows(rows);
    expect(shown).toHaveLength(8);
    expect(shown.map(row => row.key)).toContain("old-bad");
    expect(hidden).toBe(3);
  });

  it("<ChangeWatch /> 한 줄로 끼우면 스스로 읽어 그린다", async () => {
    const plain = text(await prerender(<ChangeWatch />));
    expect(mocks.watch).toHaveBeenCalledWith(false);
    expect(plain).toContain("바꾼 것 지켜보기");
    expect(plain).toContain("1차 AI 검수 1순위를 supa로");
  });

  it("읽기에 실패해도 둘레를 깨뜨리지 않는다", async () => {
    mocks.watch.mockRejectedValue(new Error("db down"));
    expect(text(await prerender(<ChangeWatch fresh />))).toContain("바꾼 것을 읽지 못했습니다");
    expect(mocks.watch).toHaveBeenCalledWith(true);
  });
});

describe("기록 · 그 뒤 칸", () => {
  const recent = new Date(Date.now() - 60 * 60_000);
  const row = (id: number, patch: Record<string, unknown>) => ({ id, actor: "jr", actorKind: "github", ip: "203.0.113.7", userAgent: "Mozilla/5.0",
    detail: {}, ok: true, error: null, createdAt: recent, ...patch });

  it("지켜보는 줄에는 판정과 바꾼 뒤 처리량, 설정 줄에는 되돌리는 곳", async () => {
    mocks.log.mockResolvedValue([
      row(28863, { action: "pipeline-control-capacity-mode", target: "model_capacity_control", detail: { after: { mode: "draining" } } }),
      row(28853, { action: "ai-task-models-save", target: "first-review#1" }),
      row(60, { action: "takedown-remove", target: "slug-60" }),
      row(50, { action: "settings-save", target: "crawl_settings", createdAt: new Date("2026-10-05T07:32:54Z") }),
    ]);
    const html = await prerender(await AdminActivityPage({ searchParams: Promise.resolve({}) }));
    const plain = text(html);
    expect(mocks.watch).toHaveBeenCalledTimes(1);
    expect(plain).toContain("그 뒤");
    expect(plain).toContain("첫 1시간 86건 → 지금 3건");
    expect(plain).toContain("다시 떨어짐");
    expect(html).toMatch(/href="\/admin\/models\/tasks"[^>]*>되돌리러 가기/);
    // 오래된 설정 줄도 되돌리는 곳은 잇는다(지켜보기는 읽지 않는다)
    expect(html).toMatch(/href="\/admin"[^>]*>되돌리러 가기/);
    expect(html.match(/되돌리러 가기/g)).toHaveLength(2);
    expect(html).toContain("min-w-[1048px]");
  });

  it("24시간 안의 지켜보는 줄이 없으면 지켜보기를 읽지 않는다", async () => {
    mocks.log.mockResolvedValue([row(50, { action: "settings-save", target: "crawl_settings", createdAt: new Date("2026-10-05T07:32:54Z") }),
      row(61, { action: "ai-task-models-save", target: "first-review#1", actor: "system:x", actorKind: "token" })]);
    await prerender(await AdminActivityPage({ searchParams: Promise.resolve({}) }));
    expect(mocks.watch).not.toHaveBeenCalled();
  });

  it("지켜보기를 못 읽어도 표는 그린다", async () => {
    mocks.watch.mockRejectedValue(new Error("db down"));
    mocks.log.mockResolvedValue([row(28853, { action: "ai-task-models-save", target: "first-review#1" })]);
    const plain = text(await prerender(await AdminActivityPage({ searchParams: Promise.resolve({}) })));
    expect(plain).toContain("작업 ↔ 모델 순위 저장");
    expect(plain).not.toContain("다시 떨어짐");
  });
});
