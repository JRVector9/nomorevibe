import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const observation = vi.hoisted(() => ({ rows: [] as { value: Record<string, unknown> }[] }));
vi.mock("@/lib/db", () => ({ db: { select: () => ({ from: () => ({ where: async () => observation.rows }) }) } }));

import { readScreenObservation } from "@/lib/screen-review/job";
import { SCREEN_REVIEW_PROMPT_VERSION, SCREEN_REVIEW_SHOT2_PROMPT_VERSION } from "@/lib/screen-review/vision-review";

describe("화면 관측의 판별 캐시", () => {
  it("shot1의 성공·실패·입력 추적을 shot2 관측으로 재사용하지 않는다", async () => {
    observation.rows = [{ value: { model: "qwen3.8-flash-next+vision", promptVersion: SCREEN_REVIEW_PROMPT_VERSION,
      lastRunAt: "2026-10-22T00:00:00Z", lastSuccessAt: "2026-10-22T00:00:00Z", lastError: { code: "old" },
      failures: { "a:1": { code: "old", count: 3, at: "2026-10-22T00:00:00Z" } }, lastReview: { inputHash: "old" },
      health: { ok: true, version: "render1" } } }];
    const current = await readScreenObservation("qwen3.8-flash-next+vision-shot2", SCREEN_REVIEW_SHOT2_PROMPT_VERSION);
    expect(current).toMatchObject({ promptVersion: SCREEN_REVIEW_SHOT2_PROMPT_VERSION, lastRunAt: null, lastSuccessAt: null,
      lastError: null, failures: {}, health: { ok: true } });
    expect(current.lastReview).toBeUndefined();
  });
});
