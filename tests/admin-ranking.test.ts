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
} from "@/app/admin/ranking/RankingPolicyForm";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";

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
});
