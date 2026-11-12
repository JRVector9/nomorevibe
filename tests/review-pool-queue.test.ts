import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 1차 검수 「동시에」 고르기 — 2026-11-12 「동시에」 전 단계 검토.
 * 예전: 장비가 그 순간 가득이면 고르기가 null 이라 후보가 「순위 밖 모델에 묶임」(reviewer_unassigned, 후보 탓으로 셈)으로 건너뛰어졌다 —
 * 5틱 잇달아 가득이면 30분 빠지고, 세 번이면 사람 몫(ai_review_skip_exhausted)으로 넘어갔다. 지금: 줄에 설 구성원을 고르고 claim 이 줄에 선다.
 */
const mocks = vi.hoisted(() => ({ choose: vi.fn() }));
vi.mock("@/lib/llm/ai-task-workload-selector", () => ({ chooseTaskWorkloadMember: mocks.choose }));
import { chooseReviewWorkloadMember, type ReviewRankResolution } from "@/lib/crawl/review-task-ranks";

afterEach(() => mocks.choose.mockReset());
const MEMBER = "0b0c0d0e-0000-4000-8000-00000000d0d0";
const resolution = {
  task: "first-review", slot: 1, routeId: "crawl-agent-review", status: "ok",
  execution: { task: "first-review", slot: 1, mode: "workload_pool", revision: 2, updatedAt: null, members: [{ memberId: MEMBER }] },
  candidates: [{ rank: {}, unusable: null, detail: null, poolMember: { memberId: MEMBER },
    binding: { routeId: "crawl-agent-review", provider: "abcllm", identity: "deepseek", engineModel: "deepseek", connectionId: "c", deviceId: "m3" } }],
} as unknown as ReviewRankResolution;

describe("1차 「동시에」 고르기", () => {
  it("빈 칸이 없어도 줄에 설 구성원을 고르게 한다(queueWhenFull) — claim 이 장부 줄에 선다", async () => {
    mocks.choose.mockResolvedValue({ provider: "abcllm", identity: "deepseek", memberId: MEMBER, poolSelection: { memberId: MEMBER } });
    expect(await chooseReviewWorkloadMember(resolution)).toMatchObject({ provider: "abcllm", model: "deepseek" });
    expect(mocks.choose.mock.calls[0][2]).toMatchObject({ queueWhenFull: true });
  });

  it("쉬는·막힌 구성원은 후보에서 빼고, 줄에 설 구성원도 없으면 null", async () => {
    mocks.choose.mockResolvedValue(null);
    expect(await chooseReviewWorkloadMember(resolution, new Set([JSON.stringify(["abcllm", "deepseek"])]))).toBeNull();
    expect(mocks.choose.mock.calls[0][1]).toEqual([]);
  });
});
