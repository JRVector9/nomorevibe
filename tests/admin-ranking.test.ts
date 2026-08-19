import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancelScheduledPolicy: vi.fn(),
  currentAdmin: vi.fn(),
  getRankingAdminState: vi.fn(),
  redirect: vi.fn(),
  revalidatePath: vi.fn(),
  schedulePolicy: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.currentAdmin }));
vi.mock("@/lib/domain/ranking/policies", () => ({
  cancelScheduledPolicy: mocks.cancelScheduledPolicy,
  schedulePolicy: mocks.schedulePolicy,
}));
vi.mock("@/lib/domain/ranking/view", () => ({
  getRankingAdminState: mocks.getRankingAdminState,
}));

import AdminRankingPage from "@/app/admin/ranking/page";
import {
  cancelRankingPolicy,
  saveRankingPolicy,
} from "@/app/admin/ranking/actions";
import {
  numberOrPrevious,
  percentList,
  policyForScoringMode,
  RankingPolicyForm,
} from "@/app/admin/ranking/RankingPolicyForm";
import {
  DEFAULT_RANKING_POLICY,
  UNIQUE_FIRST_RANKING_POLICY,
} from "@/lib/domain/ranking/policy";

describe("ranking administrator authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects a logged-out page before reading ranking state", async () => {
    mocks.currentAdmin.mockResolvedValue(null);
    mocks.redirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`);
    });

    await expect(AdminRankingPage()).rejects.toThrow("redirect:/admin/login");
    expect(mocks.getRankingAdminState).not.toHaveBeenCalled();
  });

  it("does not schedule or cancel policy when logged out", async () => {
    mocks.currentAdmin.mockResolvedValue(null);
    const form = new FormData();
    form.set("policy", JSON.stringify(DEFAULT_RANKING_POLICY));

    await expect(saveRankingPolicy(null, form)).resolves.toEqual({
      issues: ["권한이 없습니다. 다시 로그인해주세요."],
    });
    await cancelRankingPolicy();

    expect(mocks.schedulePolicy).not.toHaveBeenCalled();
    expect(mocks.cancelScheduledPolicy).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("does not read or mutate ranking data for any logged-out action", async () => {
    mocks.currentAdmin.mockResolvedValue(null);
    const form = new FormData();
    form.set("policy", JSON.stringify(UNIQUE_FIRST_RANKING_POLICY));

    await saveRankingPolicy(null, form);
    await cancelRankingPolicy();

    expect(mocks.getRankingAdminState).toHaveBeenCalledTimes(0);
    expect(mocks.schedulePolicy).toHaveBeenCalledTimes(0);
    expect(mocks.cancelScheduledPolicy).toHaveBeenCalledTimes(0);
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(0);
  });

  it("rejects malformed hidden JSON before scheduling", async () => {
    mocks.currentAdmin.mockResolvedValue({ login: "admin" });
    const form = new FormData();
    form.set("policy", "not-json");

    await expect(saveRankingPolicy(null, form)).resolves.toEqual({
      issues: ["설정 형식을 읽을 수 없습니다."],
    });
    expect(mocks.schedulePolicy).not.toHaveBeenCalled();
  });

  it("returns only safe action state after a successful schedule", async () => {
    mocks.currentAdmin.mockResolvedValue({ login: "admin" });
    mocks.schedulePolicy.mockResolvedValue({
      ok: true,
      revision: { id: 42, createdBy: "admin" },
      warnings: ["확인할 경고"],
    });
    const form = new FormData();
    form.set("policy", JSON.stringify(DEFAULT_RANKING_POLICY));

    const result = await saveRankingPolicy(null, form);

    expect(mocks.schedulePolicy).toHaveBeenCalledWith(DEFAULT_RANKING_POLICY, "admin");
    expect(result).toEqual({ ok: true, warnings: ["확인할 경고"] });
    expect(result).not.toHaveProperty("revision");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/admin/ranking");
  });
});

describe("ranking policy form parsing", () => {
  it("converts comma-separated percentages to basis points", () => {
    expect(percentList("35, 55.5, 100")).toEqual([3500, 5550, 10_000]);
  });

  it("keeps the previous number when an edit is not finite", () => {
    expect(numberOrPrevious("12", 7)).toBe(12);
    expect(numberOrPrevious("not-a-number", 7)).toBe(7);
    expect(numberOrPrevious("Infinity", 7)).toBe(7);
  });

  it("switches to the complete recommended unique policy without mutating legacy scoring", () => {
    const legacy = structuredClone(DEFAULT_RANKING_POLICY);

    const unique = policyForScoringMode(legacy, "unique_visitors");

    expect(unique.scoring).toEqual(UNIQUE_FIRST_RANKING_POLICY.scoring);
    expect(unique.trend.minimumPreviousUniqueVisitors)
      .toBe(UNIQUE_FIRST_RANKING_POLICY.trend.minimumPreviousUniqueVisitors);
    expect(legacy).toEqual(DEFAULT_RANKING_POLICY);
  });

  it("renders every unique scoring control with at least 13px text", () => {
    const html = renderToStaticMarkup(createElement(RankingPolicyForm, {
      initialPolicy: UNIQUE_FIRST_RANKING_POLICY,
    }));

    expect(html).toContain("랭킹 기준");
    expect(html).toContain("반복 방문 가중치(%)");
    expect(html).toContain("고유 유입자당 추가 방문 상한");
    expect(html).toContain("최소 고유 유입자");
    expect(html).toContain("이전 최소 고유 유입자");
    for (const file of [
      "app/admin/ranking/RankingPolicyForm.tsx",
      "components/Panel.tsx",
    ]) {
      expect(readFileSync(file, "utf8"))
        .not.toMatch(/text-\[(?:1[0-2](?:\.\d+)?|[0-9](?:\.\d+)?)px\]/);
    }
  });
});

describe("ranking transition preview", () => {
  it("shows readiness and both legacy and proposed unique ranks", async () => {
    mocks.currentAdmin.mockResolvedValue({ login: "admin" });
    mocks.getRankingAdminState.mockResolvedValue({
      active: {
        key: "2026-W34",
        cadence: "weekly",
        startsAt: new Date("2026-08-17T15:00:00.000Z"),
        endsAt: new Date("2026-08-24T15:00:00.000Z"),
        isTransition: false,
        effectiveLaunchWindowDays: 28,
        policy: DEFAULT_RANKING_POLICY,
        refreshedAt: new Date("2026-08-19T00:00:00.000Z"),
        state: "active",
      },
      activeMetrics: { eligibleProducts: 1, validClicks: 8 },
      scheduled: null,
      revisions: [],
      preview: [],
      currentPreview: [{ slug: "alpha", rank: 1, validClicks: 8, uniqueVisitors: 3 }],
      proposedUniquePreview: [{ slug: "alpha", rank: 2, validClicks: 8, uniqueVisitors: 3 }],
      collectionReadiness: {
        startedAt: new Date("2026-08-18T00:00:00.000Z"),
        readyAt: new Date("2026-08-25T00:00:00.000Z"),
        ready: false,
      },
    });

    const html = renderToStaticMarkup(await AdminRankingPage());

    expect(html).toContain("집계 중");
    expect(html).toContain("유효 방문 기준 순위");
    expect(html).toContain("고유 유입자 기준 순위");
    expect(html).toContain("다음 시즌");
    for (const file of [
      "app/admin/ranking/page.tsx",
      "app/admin/AdminNav.tsx",
    ]) {
      expect(readFileSync(file, "utf8"))
        .not.toMatch(/text-\[(?:1[0-2](?:\.\d+)?|[0-9](?:\.\d+)?)px\]/);
    }
  });

  it("keeps the top result from each comparison column when the leaderboard limit is one", async () => {
    mocks.currentAdmin.mockResolvedValue({ login: "admin" });
    const policy = {
      ...DEFAULT_RANKING_POLICY,
      leaderboard: { limit: 1 },
      cooldown: { enabled: false, tiers: [] },
    };
    mocks.getRankingAdminState.mockResolvedValue({
      active: {
        key: "2026-W34",
        cadence: "weekly",
        startsAt: new Date("2026-08-17T15:00:00.000Z"),
        endsAt: new Date("2026-08-24T15:00:00.000Z"),
        isTransition: false,
        effectiveLaunchWindowDays: 28,
        policy,
        refreshedAt: new Date("2026-08-19T00:00:00.000Z"),
        state: "active",
      },
      activeMetrics: { eligibleProducts: 2, validClicks: 10 },
      scheduled: null,
      revisions: [],
      preview: [],
      currentPreview: [
        { slug: "alpha", rank: 1, validClicks: 6, uniqueVisitors: 2 },
        { slug: "beta", rank: 2, validClicks: 4, uniqueVisitors: 3 },
      ],
      proposedUniquePreview: [
        { slug: "beta", rank: 1, validClicks: 4, uniqueVisitors: 3 },
        { slug: "alpha", rank: 2, validClicks: 6, uniqueVisitors: 2 },
      ],
      collectionReadiness: { startedAt: null, readyAt: null, ready: false },
    });

    const html = renderToStaticMarkup(await AdminRankingPage());

    expect(html).toContain(">alpha</td>");
    expect(html).toContain(">beta</td>");
    expect(html).toMatch(
      /alpha<\/td><td[^>]*>1<\/td><td[^>]*>6<\/td><td[^>]*>2<\/td><td[^>]*>2<\/td>/,
    );
    expect(html).toMatch(
      /beta<\/td><td[^>]*>2<\/td><td[^>]*>4<\/td><td[^>]*>1<\/td><td[^>]*>3<\/td>/,
    );
    expect(html).not.toContain(">—</td>");
  });
});
