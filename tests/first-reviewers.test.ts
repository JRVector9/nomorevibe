import { DEFAULT_MODEL_DEFINITIONS } from "@/lib/llm/model-registry";
import { expect, it } from "vitest";
import { firstReviewers, firstReviewerKey, hasFirstReviewer, selectFirstReviewer, firstReviewDeferralIsLocal, firstReviewPoolPosition, firstReviewCandidates } from "@/lib/crawl/first-reviewers";
import { crawlSettingsSchema, DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { reviewPolicyHash } from "@/lib/crawl/agent-review-contract";
import { secondReviewPolicyHash } from "@/lib/crawl/second-review-ownership";
import { resolveModelSlots } from "@/lib/operations/stage-registry";

const primary = { provider: "abcllm" as const, model: "primary-review-model" };
const extra = { provider: "abcllm" as const, model: "extra-review-model" };
const settings = { ...DEFAULT_CRAWL_SETTINGS, firstReview: primary };
const expanded = { ...settings, firstReviewAdditional: [extra] };

it("adds bounded workers without replacing the primary or changing input/AI2 policy generations", () => {
  expect(firstReviewers(settings)).toEqual([primary]);
  expect(firstReviewers(expanded)).toEqual([primary, extra]);
  expect(firstReviewers({}, primary)).toEqual([primary]);
  expect(reviewPolicyHash(expanded)).toBe(reviewPolicyHash(settings));
  expect(secondReviewPolicyHash(expanded)).toBe(secondReviewPolicyHash(settings));
  expect(resolveModelSlots(expanded, {}).filter(slot => slot.stage === "first").map(slot => slot.model))
    .toEqual([primary.model, extra.model]);
  expect(resolveModelSlots(expanded, {}).find(slot => slot.stage === "audit")?.model).toBe(primary.model);
});

it("validates at most two extras and rejects aliases of the same underlying model", () => {
  expect(crawlSettingsSchema.safeParse(expanded).success).toBe(true);
  expect(crawlSettingsSchema.safeParse({ ...expanded, firstReviewAdditional: [extra, extra, extra] }).success).toBe(false);
  expect(crawlSettingsSchema.safeParse({ ...settings, firstReviewAdditional: [{ ...primary, model: "[supa] " + primary.model }] }).success).toBe(false);
  expect(crawlSettingsSchema.safeParse({ ...DEFAULT_CRAWL_SETTINGS, firstReviewAdditional: [extra] }).success).toBe(false);
});

it("picks the highest usable rank: firstReview first, then firstReviewAdditional in listed order (2026-11-01)", () => {
  const third = { provider: "grok-cli" as const, model: "grok-4.7" };
  // Every candidate goes to rank 1 while it is usable — no spreading across ranks.
  expect([1, 2, 3, 4].map(id => selectFirstReviewer([primary, extra, third], id))).toEqual([primary, primary, primary, primary]);
  // Rank 1 paused/blocked this tick → rank 2; ranks 1 and 2 → rank 3 (grok-cli last); all → null (the job skips and advances).
  const avoid = (...rows: { provider: string; model: string }[]) => ({ blocked: new Set(rows.map(firstReviewerKey)) });
  expect(selectFirstReviewer([primary, extra, third], 1, [], [], avoid(primary))).toEqual(extra);
  expect(selectFirstReviewer([primary, extra, third], 1, [], [], avoid(primary, extra))).toEqual(third);
  expect(selectFirstReviewer([primary, extra, third], 1, [], [], avoid(primary, extra, third))).toBeNull();
  // A settled retry is not pinned to its model: rank 1 takes it.
  expect(selectFirstReviewer([primary, extra], 1, [{ ...extra, state: "failed" }])).toEqual(primary);
  expect(hasFirstReviewer([primary, extra], extra)).toBe(true);
});

it("protects live intents of removed or unreadable models without reassignment", () => {
  // The chooser passes only live intents (unexpired reserved, dispatched within the call window, waiting on a pool model).
  expect(selectFirstReviewer([primary, extra], 1, [primary], [extra])).toEqual(extra);
  expect(selectFirstReviewer([primary], 1, [primary], [extra])).toBeNull();
  expect(selectFirstReviewer([primary, extra], 1, [], [{ provider: null, model: null }])).toBeNull();
  expect(selectFirstReviewer([primary, extra], 1, [], [primary, extra])).toBeNull();
  // A live intent or a live call stays on its model even when that model is blocked this tick.
  const avoid = { blocked: new Set([firstReviewerKey(extra)]) };
  expect(selectFirstReviewer([primary, extra], 2, [], [extra], avoid)).toEqual(extra);
  expect(selectFirstReviewer([primary, extra], 2, [{ ...extra, state: "running", live: true }], [], avoid)).toEqual(extra);
  // A dead running attempt (outside its call window) does not pin.
  expect(selectFirstReviewer([primary, extra], 2, [{ ...primary, state: "running", live: false }], [], { blocked: new Set([firstReviewerKey(primary)]) })).toEqual(extra);
});

it("claim-time re-check accepts the chosen rank and still refuses one a live intent or live call pins elsewhere", () => {
  // The claim re-check treats every pool model except the claimed one as "avoid".
  const others = (claimed: typeof primary) => ({ blocked: new Set([primary, extra].filter(row => row.model !== claimed.model).map(firstReviewerKey)) });
  expect(selectFirstReviewer([primary, extra], 2, [], [], others(primary))).toEqual(primary);
  expect(selectFirstReviewer([primary, extra], 2, [], [], others(extra))).toEqual(extra);
  expect(selectFirstReviewer([primary, extra], 2, [{ ...primary, state: "failed" }], [], others(extra))).toEqual(extra);
  // A live call or an active intent on `extra` cannot be claimed for `primary`.
  expect(selectFirstReviewer([primary, extra], 2, [{ ...extra, state: "running", live: true }], [], others(primary))).toEqual(extra);
  expect(selectFirstReviewer([primary, extra], 2, [], [extra], others(primary))).toEqual(extra);
});

it("keeps global draining/policy/owner refusals global while allowing another model past a local capacity wait", () => {
  for (const reason of ["draining", "disabled", "policy_changed", "owner_unavailable", "reservation_required"] as const)
    expect(firstReviewDeferralIsLocal(reason)).toBe(false);
  for (const reason of ["capacity", "queue_full", "unmapped", "provider_contract_unavailable", "device_unconfigured"] as const)
    expect(firstReviewDeferralIsLocal(reason)).toBe(true);
  // 2026-10-31 결정: withdrawn·reservation_lost 는 요청 하나의 일이라 모델을 멈추지 않는다(그 후보만 넘긴다) — 하나가 잘못되면 다음 작업도 안 되는 구조는 이유가 없다
  for (const reason of ["withdrawn", "reservation_lost", "dispatched", "work_busy", "ledger_mismatch"] as const)
    expect(firstReviewDeferralIsLocal(reason)).toBe(false);
});

it("accepts only bounded, lossless keyset timestamps and ignores malformed cursor metadata", () => {
  const position = { id: 12, reviewed: false, updatedAt: "2026-10-27 00:00:00.123456", ceiling: 20 };
  expect(firstReviewPoolPosition(position)).toEqual(position);
  expect(firstReviewPoolPosition({ ...position, id: 21 })).toBeNull();
  expect(firstReviewPoolPosition({ ...position, updatedAt: "invalid" })).toBeNull();
});


it("moves a retry of a removed or unreadable model to the current pool unless its call may still be in flight (2026-11-01)", () => {
  const avoid = { blocked: new Set([firstReviewerKey(primary)]) };
  const removed = { provider: "abcllm" as const, model: "removed-review-model" };
  // 빈 추가 풀([])은 primary 하나다 — 끝난 시도·주인이 죽은 running·상태 모름·식별 불가 모두 지금 풀로 간다
  for (const attempt of [{ ...removed, state: "failed" }, { ...removed, state: "superseded" }, { ...removed, state: "succeeded" },
    { ...removed, state: "running", live: false }, { ...removed, state: null }, removed, { provider: null, model: null, state: "failed" }]) {
    expect(selectFirstReviewer([primary], 2, [attempt])).toEqual(primary);
    // 1순위가 막혔으면 2순위
    expect(selectFirstReviewer([primary, extra], 2, [attempt], [], avoid)).toEqual(extra);
  }
  // 지금 보내진 중일 수 있는 시도(live)는 보호한다 — 같은 후보에 살아 있는 호출을 둘 만들지 않는다
  expect(selectFirstReviewer([primary], 2, [{ ...removed, state: "running", live: true }])).toBeNull();
  // 다른 모델의 살아 있는 의도는 시도보다 앞선다
  expect(selectFirstReviewer([primary], 2, [{ ...removed, state: "failed" }], [removed])).toBeNull();
});

it("configures candidate suggestions while preserving the stored pool and all retry assignment rules", () => {
  const defaults = firstReviewCandidates({});
  expect(defaults.map(row => row.model)).toEqual(["[supa] Qwen3.8-27B-NVFP4", "[MLX] gpt-oss-120b", "sonnet", "opus", "grok-4.7"]);
  const env = { MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS,
    candidates: { "first-review": ["connect:opus"] } }) };
  expect(firstReviewCandidates(env)).toEqual([{ provider: "claude-cli", model: "opus" }]);
  expect(firstReviewers(expanded)).toEqual([primary, extra]);
  expect(selectFirstReviewer([primary, extra], 1, [extra])).toEqual(primary);
});
