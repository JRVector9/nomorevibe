import { beforeEach, describe, expect, it, vi } from "vitest";

/** 감사 거절 적체(0116) — 메뉴 배지·오늘 할 일. 7일 넘게 기다린 것이 있을 때만, 주황으로 */
const mocks = vi.hoisted(() => ({ takedown: vi.fn(), intro: vi.fn(), actions: vi.fn(), human: vi.fn(), backlog: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/operations/shared-cache", async (original) => ({ ...await original<typeof import("@/lib/operations/shared-cache")>(),
  sharedStale: () => ({ get: (_key: string, load: () => Promise<unknown>) => load() }) }));
vi.mock("@/lib/cache/shared", () => ({ sharedStore: {} }));
vi.mock("@/lib/operations/shared-reads", () => ({ sharedHumanQueueOverview: mocks.human }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: async () => ({}) }));
vi.mock("@/lib/domain/products/intro-requests", () => ({ pendingIntroRequestCount: mocks.intro }));
vi.mock("@/lib/domain/products/takedown", () => ({ takedownSummary: mocks.takedown }));
vi.mock("@/app/(operator)/admin/status/attention", () => ({ actionBadgeCounts: mocks.actions }));
vi.mock("@/lib/crawl/audit-policy", () => ({ openBacklogStats: mocks.backlog, AUDIT_BACKLOG_OVERDUE_DAYS: 7 }));

import { auditBadge } from "@/app/(operator)/admin/AdminNav";
import { navBadges } from "@/app/(operator)/admin/badges";
import { sectionTone } from "@/app/(operator)/admin/inbox/inbox-model";
import { auditInboxNote } from "@/lib/operations/inbox";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.takedown.mockResolvedValue({ pending: 0, overdue: 0 });
  mocks.intro.mockResolvedValue(0);
  mocks.actions.mockResolvedValue({ critical: 0, hold: 0 });
  mocks.human.mockResolvedValue({ stages: { human: 0 } });
  mocks.backlog.mockResolvedValue({ open: 7_450, held: 2_490, overdue: 0, oldestWaitDays: 6 });
});

describe("감사 거절 적체 배지", () => {
  it("7일 넘게 기다린 것이 없으면 배지에 들지 않는다 — 열린 거절이 수천 건이어도", () => {
    expect(auditBadge(null, 0, { overdue: 0, oldestWaitDays: 6 })).toBeUndefined();
    expect(auditBadge(null, 0, null)).toBeUndefined();
  });

  it("있으면 그 수를 주황으로 — 요청·소개가 있으면 글자는 그 합계이고 적체는 title 에만(24시간 약속이 묻히지 않게)", () => {
    expect(auditBadge(null, 0, { overdue: 1_200, oldestWaitDays: 12 })).toEqual({ label: "1,200", tone: "warn",
      title: "감사 거절 7일 넘게 기다림 1,200건(가장 오래 12일)" });
    expect(auditBadge({ pending: 3, overdue: 0 }, 1, { overdue: 1_200, oldestWaitDays: 12 })).toEqual({ label: "4", tone: "warn",
      title: "내려달라는 요청 3건 · 소개 수정 요청 1건 · 감사 거절 7일 넘게 기다림 1,200건(가장 오래 12일)" });
    // 빨강은 24시간 넘은 요청뿐이다
    expect(auditBadge({ pending: 1, overdue: 1 }, 0, { overdue: 50, oldestWaitDays: 30 })?.tone).toBe("critical");
  });

  it("레이아웃 배지 — 적체를 세어 넣고, 못 세면 적체만 빼고 그린다", async () => {
    mocks.backlog.mockResolvedValue({ open: 7_450, held: 2_490, overdue: 6_100, oldestWaitDays: 8 });
    expect((await navBadges()).badges["/admin/audit"]).toEqual({ label: "6,100", tone: "warn", title: "감사 거절 7일 넘게 기다림 6,100건(가장 오래 8일)" });
    mocks.backlog.mockRejectedValue(new Error("db"));
    mocks.takedown.mockResolvedValue({ pending: 2, overdue: 0 });
    const set = await navBadges();
    expect(set.badges["/admin/audit"]).toEqual({ label: "2", tone: "warn", title: "내려달라는 요청 2건" });
    expect(set.unknown).not.toContain("/admin/audit");
  });
});

describe("오늘 할 일 — 감사 거절 칸", () => {
  it("7일 넘게 기다린 수와 가장 오래 기다린 날을 덧말에 — 색은 주황 그대로", () => {
    expect(auditInboxNote(2_490, { overdue: 6_100, oldestWaitDays: 8 })).toBe("7일 넘게 기다림 6,100건 · 가장 오래 8일 — 정책 처리로 닫기 · 보류 중(목록에서 빠짐) 2,490건");
    expect(auditInboxNote(0, { overdue: 0, oldestWaitDays: 3 })).toBeUndefined();
    expect(auditInboxNote(5, null)).toBe("보류 중(목록에서 빠짐) 5건");
    expect(sectionTone("audit", { count: 7_450, items: [], note: "x" })).toBe("warn");
  });
});
