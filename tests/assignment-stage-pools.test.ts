import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelAssignmentRow } from "@/lib/llm/capacity-helpers";
import { setAssignmentTableEnabledForTest } from "@/lib/llm/assignment-flag";
import { setStageAssignmentsForTest } from "@/lib/llm/stage-assignment-snapshot";
import { tableStageSelections, withAdminStagePools, withStoredAdminStagePools } from "@/lib/llm/admin-model-pools";
import { configuredModel, configuredModelDefinition, readModelRegistry } from "@/lib/llm/model-registry";

/** PR 3b-B — 단계 풀(stageModelPools)과 등록부 기본값이 배정 표를 읽는 경로. 스위치가 꺼진 경로는 admin-models-pools·model-registry 시험이 본다. */
const stored = vi.hoisted(() => ({ pools: {} as Record<string, string[]> }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: async () => ({ stageModelPools: stored.pools }) }));
vi.mock("@/lib/db", () => ({ db: {}, onPrimary: (run: () => unknown) => run() }));

let seq = 0;
const row = (value: Partial<ModelAssignmentRow> & Pick<ModelAssignmentRow, "stage" | "registryKey" | "model">): ModelAssignmentRow => ({
  assignmentId: value.assignmentId ?? `row-${String(++seq).padStart(3, "0")}`, deviceId: "dev-a", transport: "gateway", rank: 1, role: "primary",
  vote: false, mode: "live", routeId: "route", provider: "abcllm", maxSlots: 1, evidenceKey: "e".repeat(64), version: 1, note: null,
  updatedBy: "fixture", createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z", ...value });
const mlx = row({ assignmentId: "reason:01", stage: "reason", registryKey: "mlx:text", model: "[MLX] gpt-oss-120b" });
const supa = row({ assignmentId: "reason:02", stage: "reason", registryKey: "supa:review", model: "[supa] Qwen3.8-27B-NVFP4" });
const m1 = row({ assignmentId: "reason:03", stage: "reason", registryKey: "m1:translation", model: "[m1] mlx-community--gemma-4-26b-a4b-it-4bit", rank: 2 });
const slot = (assignment: string, stage: string) => createHash("sha256").update(`${assignment}:${stage}`).digest().readUInt32BE(0);

afterEach(() => { setAssignmentTableEnabledForTest(null); setStageAssignmentsForTest(null); stored.pools = {}; vi.unstubAllEnvs(); seq = 0; });

describe("stage pools from the table", () => {
  it("picks deterministically from the rank-1 rows with the stored pool's hash slot, skipping unusable rows", () => {
    const registry = readModelRegistry();
    const rowsFor = (stage: string) => stage === "reason" ? [mlx, supa, m1] : null;
    for (const assignment of ["reason-translate:a", "reason-translate:b", "reason-translate:c", "reason-translate:d"]) {
      const picked = tableStageSelections(rowsFor, assignment, registry);
      expect(picked["reason-translate"]).toBe(["mlx:text", "supa:review"][slot(assignment, "reason-translate") % 2]);
      expect(Object.keys(picked)).toEqual(["reason-translate"]);
    }
    // a wire name that is not the registry request name, an unknown key and another adapter are not usable; rank 2 serves when rank 1 is gone
    const odd = [row({ stage: "reason", registryKey: "mlx:text", model: "gpt-oss-120b" }), row({ stage: "reason", registryKey: "none:missing", model: "x" }),
      row({ stage: "reason", registryKey: "connect:sonnet", model: "sonnet", provider: "claude-cli" }), m1];
    expect(tableStageSelections(stage => stage === "reason" ? odd : null, "reason-translate:a", registry)).toEqual({ "reason-translate": "m1:translation" });
    expect(tableStageSelections(stage => stage === "reason" ? odd.slice(0, 3) : null, "reason-translate:a", registry)).toEqual({});
  });

  it("replaces the stored pool only for a stage the table serves, and only with the flag on", async () => {
    stored.pools = { "reason-translate": ["m1:translation"], "product-tagline-ko": ["supa:review"] };
    setStageAssignmentsForTest([mlx]);
    const read = () => withStoredAdminStagePools("reason-translate:lease", async () => [configuredModel("reason-translate"), configuredModel("product-tagline-ko")]);
    expect(await read()).toEqual(["[m1] mlx-community--gemma-4-26b-a4b-it-4bit", "[supa] Qwen3.8-27B-NVFP4"]);
    setAssignmentTableEnabledForTest(true);
    expect(await read()).toEqual(["[MLX] gpt-oss-120b", "[supa] Qwen3.8-27B-NVFP4"]);
    // explicit pools (readiness checks) are never replaced by the table
    expect(withAdminStagePools({ "reason-translate": ["m1:translation"] }, "x", () => configuredModel("reason-translate")))
      .toBe("[m1] mlx-community--gemma-4-26b-a4b-it-4bit");
  });
});

describe("registry default order", () => {
  const tagline = row({ assignmentId: "tagline:01", stage: "tagline", registryKey: "supa:review", model: "[supa] Qwen3.8-27B-NVFP4" });
  it("makes a live table row the default ahead of *_KEY and the legacy env, only for the unscoped process env", () => {
    // crawl-tagline has no process env since 2026-10-31 (abcLLM cleanup: its *_MODEL / *_MODEL_KEY are not read) — its legacy order is the registry default;
    // the *_KEY precedence is checked below on reason-translate, which still has one.
    const legacy = configuredModel("crawl-tagline");
    expect(legacy).toBe("[MLX] qwen3.6-35b-heretic");
    setStageAssignmentsForTest([tagline]);
    expect(configuredModel("crawl-tagline")).toBe(legacy);                                   // flag off
    setAssignmentTableEnabledForTest(true);
    expect(configuredModel("crawl-tagline")).toBe("[supa] Qwen3.8-27B-NVFP4");
    expect(configuredModelDefinition("crawl-tagline").key).toBe("supa:review");
    expect(configuredModel("crawl-tagline", { ...process.env })).toBe(legacy);               // an explicit environment keeps its key
    // an admin stage-pool scope keeps its own selection
    expect(withAdminStagePools({ "crawl-tagline": ["mlx:tagline"] }, "x", () => configuredModel("crawl-tagline"))).toBe(legacy);
    // purposes without a stage mapping stay on the legacy order
    expect(configuredModel("search-query-translate")).toBe(configuredModel("search-query-translate", { ...process.env }));
    // a live row also beats an explicit *_KEY selector, again only for the unscoped process env
    vi.stubEnv("ABCLLM_MODEL_KEY", "m1:translation");
    expect(configuredModel("reason-translate", { ...process.env })).toBe("[m1] mlx-community--gemma-4-26b-a4b-it-4bit");
    setStageAssignmentsForTest([tagline, supa]);
    expect(configuredModel("reason-translate")).toBe("[supa] Qwen3.8-27B-NVFP4");
  });
  it("ignores a row whose wire name is not the registry request name", () => {
    setAssignmentTableEnabledForTest(true);
    setStageAssignmentsForTest([{ ...tagline, model: "Qwen3.8-27B-NVFP4", transport: "direct" }]);
    expect(configuredModel("crawl-tagline")).toBe(configuredModel("crawl-tagline", { ...process.env }));
  });
});
