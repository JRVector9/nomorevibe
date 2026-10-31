import { describe, expect, it } from "vitest";
import { planAssignmentImport, type AssignmentImportSettings } from "@/lib/llm/assignment-import";
import { modelAssignmentInputSchema, type ModelAssignmentRow } from "@/lib/llm/capacity-helpers";
import type { ModelCapacityPolicy } from "@/lib/llm/capacity";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { DEFAULT_MODEL_DEFINITIONS } from "@/lib/llm/model-registry";

/** PR 3b-B — 배정 표 가져오기 계획(순수). 운영과 같은 모양의 설정·정책·등록부(코드 기본 등록부)로 본다. */
const registry = { models: [...DEFAULT_MODEL_DEFINITIONS] };
const settings: AssignmentImportSettings = {
  firstReview: { provider: "abcllm", model: "[supa] Qwen3.8-27B-NVFP4" },
  firstReviewAdditional: [{ provider: "abcllm", model: "[MLX] gpt-oss-120b" }],
  secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, enabled: true,
    voters: [{ provider: "local-direct", model: "qwen3.8-flash-next" }, { provider: "claude-cli", model: "opus" }],
    fallbacks: [{ provider: "abcllm", model: "[MLX] gpt-oss-120b" }, { provider: "grok-cli", model: "grok-4.7" }] },
  stageModelPools: { "reason-translate": ["m1:translation", "supa:review"], "product-translate": ["m1:translation"], "crawl-tagline": ["mlx:tagline"],
    "human-review": ["m3:review"], "direct-review": ["gpu3090:review"], "product-intro-check": ["connect:sonnet"] },
};
const route = (routeId: string, provider: string, model: string, groupId: string, providerBudgetId = groupId) => ({ routeId, provider, model, providerBudgetId, groupId });
const policy: ModelCapacityPolicy = { version: 1, maxWaiting: 256, queueTtlMs: 60_000, reservationTtlMs: 30_000, routes: [
  route("crawl-agent-review", "abcllm", "[supa] Qwen3.8-27B-NVFP4", "supa"), route("crawl-agent-review", "abcllm", "[MLX] gpt-oss-120b", "mlx"),
  route("second-review", "local-direct", "qwen3.8-flash-next", "gpu3090", "gpu3090-review"), route("second-review", "claude-cli", "opus", "connect"),
  route("second-review", "abcllm", "[MLX] gpt-oss-120b", "mlx"),
  route("reason-translate", "abcllm", "[m1] mlx-community--gemma-4-26b-a4b-it-4bit", "m1"),
  route("product-translate", "abcllm", "[m1] mlx-community--gemma-4-26b-a4b-it-4bit", "m1"),
  route("crawl-tagline", "abcllm", "[MLX] qwen3.6-35b-heretic", "mlx"), route("product-intro-check", "claude-cli", "sonnet", "connect")] };
const summary = (plan: ReturnType<typeof planAssignmentImport>) => plan.entries.map(entry => [entry.action, entry.input.assignmentId, entry.input.stage,
  entry.input.deviceId, entry.input.registryKey, entry.input.transport, entry.input.rank, entry.input.vote, entry.input.mode]);

describe("planAssignmentImport", () => {
  it("reproduces today's AI1 pool, AI2 voters/fallbacks and stage pools as live primary rows on the policy route's device", () => {
    const plan = planAssignmentImport(settings, policy, registry);
    expect(summary(plan)).toEqual([
      ["create", "ai1:01:supa-review", "ai1", "supa", "supa:review", "gateway", 1, false, "live"],
      ["create", "ai1:02:mlx-text", "ai1", "mlx", "mlx:text", "gateway", 1, false, "live"],
      ["create", "ai2:01:gpu3090-review", "ai2", "gpu3090", "gpu3090:review", "local-direct", 1, true, "live"],
      ["create", "ai2:02:connect-opus", "ai2", "connect", "connect:opus", "cli", 1, true, "live"],
      ["create", "ai2:01:mlx-text", "ai2", "mlx", "mlx:text", "gateway", 2, false, "live"],
      ["create", "ai2:02:connect-grok", "ai2", "connect", "connect:grok", "cli", 3, false, "off"],
      ["create", "human:01:m3-review", "human", "m3", "m3:review", "local-direct", 1, false, "off"],
      ["create", "reason:01:m1-translation", "reason", "m1", "m1:translation", "gateway", 1, false, "live"],
      ["create", "reason:02:supa-review", "reason", "supa", "supa:review", "gateway", 1, false, "off"],
      ["create", "translate:01:m1-translation", "translate", "m1", "m1:translation", "gateway", 1, false, "live"],
      ["create", "tagline:01:mlx-tagline", "tagline", "mlx", "mlx:tagline", "gateway", 1, false, "live"],
      ["create", "intro:01:connect-sonnet", "intro", "connect", "connect:sonnet", "cli", 1, false, "live"],
    ]);
    expect(plan.warnings.map(warning => [warning.source, warning.code])).toEqual([
      ["stageModelPools.direct-review", "stage_unmapped"],
      ["secondReview.fallbacks[1]", "route_missing"],
      ["stageModelPools.human-review[0]", "route_missing"],
      ["stageModelPools.reason-translate[1]", "route_missing"],
    ]);
    expect(plan.counts).toEqual({ create: 12, update: 0, unchanged: 0, skipped: 1 });
    // every input is a valid saveModelAssignment input (role primary, create = expectedVersion null)
    for (const entry of plan.entries) {
      expect(modelAssignmentInputSchema.safeParse(entry.input).success).toBe(true);
      expect(entry.input).toMatchObject({ role: "primary", expectedVersion: null, maxSlots: 1 });
    }
    expect(plan.entries[0].input.note).toBe("가져옴: firstReview");
  });

  it("diffs against the current table by (stage, device, wire model): unchanged, update with the changed fields, keeps the row id and version", () => {
    const existing = (value: Partial<ModelAssignmentRow>): ModelAssignmentRow => ({ assignmentId: "kept-id", stage: "ai1", deviceId: "supa",
      registryKey: "supa:review", transport: "gateway", rank: 1, role: "primary", vote: false, mode: "live", model: "[supa] Qwen3.8-27B-NVFP4",
      routeId: "crawl-agent-review", provider: "abcllm", maxSlots: 2, evidenceKey: "e".repeat(64), version: 7, note: "운영자 메모", updatedBy: "jr",
      createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z", ...value });
    const plan = planAssignmentImport(settings, policy, registry, { existing: [existing({}),
      existing({ assignmentId: "opus-row", stage: "ai2", deviceId: "connect", registryKey: "connect:opus", transport: "cli", model: "opus", rank: 2,
        mode: "off", version: 3 })] });
    const ai1 = plan.entries.find(entry => entry.input.registryKey === "supa:review" && entry.input.stage === "ai1")!;
    expect(ai1).toMatchObject({ action: "unchanged", changes: [], input: { assignmentId: "kept-id", expectedVersion: 7, maxSlots: 2, note: "운영자 메모" } });
    const opus = plan.entries.find(entry => entry.input.registryKey === "connect:opus")!;
    expect(opus).toMatchObject({ action: "update", changes: ["rank", "vote", "mode"], input: { assignmentId: "opus-row", expectedVersion: 3, rank: 1, vote: true, mode: "live" } });
    expect(plan.counts).toMatchObject({ create: 10, update: 1, unchanged: 1 });
  });

  it("warns instead of guessing: unknown models, duplicates, the env first reviewer and inputs the save would refuse", () => {
    const plan = planAssignmentImport({ firstReview: undefined, firstReviewAdditional: [{ provider: "abcllm", model: "[ghost] model" }],
      secondReview: { ...settings.secondReview, voters: [{ provider: "abcllm", model: "[MLX] gpt-oss-120b" }],
        fallbacks: [{ provider: "abcllm", model: "[mlx] GPT-OSS-120B" }] },
      stageModelPools: { "screen-review": ["supa:review"] } }, policy, registry, { firstReviewFallback: { provider: "claude-cli", model: "sonnet" } });
    expect(plan.warnings.map(warning => [warning.source, warning.code])).toEqual([
      ["firstReview", "first_review_from_env"],
      ["firstReviewAdditional[0]", "registry_unmatched"],
      ["secondReview.fallbacks[0]", "registry_unmatched"],
      ["stageModelPools.screen-review[0]", "transport_unsupported"],
      ["firstReview", "route_missing"],
    ]);
    expect(summary(plan)).toEqual([
      ["create", "ai1:01:connect-sonnet", "ai1", "connect", "connect:sonnet", "cli", 1, false, "off"],
      ["create", "ai2:01:mlx-text", "ai2", "mlx", "mlx:text", "gateway", 1, true, "live"],
    ]);
    // the same model twice for AI2 (canonical name) is one row
    const twice = planAssignmentImport({ ...settings, firstReviewAdditional: [], stageModelPools: {},
      secondReview: { ...settings.secondReview, voters: [{ provider: "abcllm", model: "[MLX] gpt-oss-120b" }], fallbacks: [{ provider: "abcllm", model: "[MLX] gpt-oss-120b" }] } },
    policy, registry);
    expect(twice.warnings.map(warning => [warning.source, warning.code])).toEqual([["secondReview.fallbacks[0]", "duplicate"]]);
    // no policy at all: every row is off on its registry equipment
    expect(planAssignmentImport(settings, null, registry).entries.every(entry => entry.input.mode === "off")).toBe(true);
  });
});
