import { afterEach, expect, it } from "vitest";
import { controlSnapshotSchema, formatControlStatus, usedModelRoutes, type ControlSnapshot } from "@/lib/operations/pipeline-control";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { setAssignmentTableEnabledForTest } from "@/lib/llm/assignment-flag";
import { setStageAssignmentsForTest } from "@/lib/llm/stage-assignment-snapshot";
import type { ModelAssignmentRow } from "@/lib/llm/capacity-helpers";

/** PR 3b-B — pipeline-control 스냅숏의 선택 칸 assignments 와, 스위치가 켜졌을 때 route 목록이 배정 표를 따르는가. */
function snapshot(overrides: Partial<ControlSnapshot> = {}): ControlSnapshot {
  const stage = (name: "ai1" | "ai2") => ({ stage: name, mode: "legacy" as const, drainingFrom: null, epoch: 1, contract: 1,
    live: 0, unsettled: 0, legacyJobLive: false, consumers: 1 });
  return { now: "2026-10-17T00:00:00.000Z", fence: { state: "active", writerEpoch: 1 }, stages: [stage("ai1"), stage("ai2")],
    capacity: { mode: "disabled", epoch: 1, revision: 1, policy: null, policyHash: null, waiting: 0, reserved: 0, dispatched: 0, indeterminate: 0, oldGeneration: 0 },
    http: { mode: "disabled", epoch: 1, revision: 1, policy: null, policyHash: null, reserved: 0, dispatched: 0, indeterminate: 0 },
    batch: { mode: "legacy", drainingFrom: null, epoch: 1, contract: 0, policy: null, policyHash: null, liveJobs: 0, liveRoles: 0, liveItems: 0, liveSources: 0, liveAgentClaims: 0 },
    agentScan: { mode: "legacy", drainingFrom: null, epoch: 1, contract: 0, live: 0, unsettled: 0, legacyJobLive: false, consumers: 0, queue: [] },
    recentInstances: [], uptimeSplitMode: "legacy", reviewSettings: null, auditCampaign: null, ...overrides };
}
const row = (value: Partial<ModelAssignmentRow> & Pick<ModelAssignmentRow, "assignmentId" | "stage" | "model" | "provider">): ModelAssignmentRow => ({
  deviceId: "dev-a", registryKey: "supa:review", transport: "gateway", rank: 1, role: "primary", vote: false, mode: "live", routeId: "route", maxSlots: 1,
  evidenceKey: "e".repeat(64), version: 1, note: null, updatedBy: "fixture", createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z", ...value });
afterEach(() => { setAssignmentTableEnabledForTest(null); setStageAssignmentsForTest(null); });

it("keeps old snapshots valid and accepts the optional assignments field (strict inside)", () => {
  expect(controlSnapshotSchema.parse(snapshot())).not.toHaveProperty("assignments");
  const assignments = { enabled: true, stages: [{ stage: "ai1" as const, live: 2, tableReady: true, source: "table" as const },
    { stage: "ai2" as const, live: 1, tableReady: false, source: "legacy_empty_table" as const }] };
  expect(controlSnapshotSchema.parse(snapshot({ assignments })).assignments).toEqual(assignments);
  expect(controlSnapshotSchema.safeParse(snapshot({ assignments: { ...assignments, extra: 1 } as never })).success).toBe(false);
  expect(controlSnapshotSchema.safeParse(snapshot({ assignments: { enabled: true, stages: [{ stage: "nope", live: 0, tableReady: false, source: "legacy" }] } as never })).success)
    .toBe(false);
  // 3b-B 스냅숏(flagSource 없음)은 그대로 읽히고 줄에 출처가 없다
  const text = formatControlStatus(snapshot({ assignments }));
  expect(text).toContain("[assignments] 배정 표 읽기(이 프로세스)=on ai1=table(live 2) ai2=legacy_empty_table(live 1, 표로 못 고름)");
  expect(formatControlStatus(snapshot())).not.toContain("[assignments]");
  // 3b-E: 스위치의 출처 — runtime 토글(모든 역할 공통) · env 강제(이 프로세스만)
  for (const flagSource of ["runtime", "env", "unread"] as const) {
    const parsed = controlSnapshotSchema.parse(snapshot({ assignments: { ...assignments, flagSource } })).assignments;
    expect(parsed?.flagSource).toBe(flagSource);
    expect(formatControlStatus(snapshot({ assignments: { ...assignments, flagSource } }))).toContain(`[assignments] 배정 표 읽기(이 프로세스)=on(${flagSource}) ai1=table(live 2)`);
  }
  expect(controlSnapshotSchema.safeParse(snapshot({ assignments: { ...assignments, flagSource: "file" } as never })).success).toBe(false);
});

it("lists the table's first reviewers and AI2 voters/fallbacks as used routes when the flag is on", () => {
  const reviewSettings = { ...DEFAULT_CRAWL_SETTINGS, firstReview: { provider: "abcllm", model: "legacy-first" }, firstReviewAdditional: [],
    secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, voters: [{ provider: "claude-cli", model: "opus" }] } };
  setStageAssignmentsForTest([row({ assignmentId: "ai1:01", stage: "ai1", model: "[supa] Qwen", provider: "abcllm" }),
    row({ assignmentId: "ai2:01", stage: "ai2", model: "deep-1", provider: "local-direct", vote: true }),
    row({ assignmentId: "ai2:02", stage: "ai2", model: "[MLX] gpt", provider: "abcllm", rank: 2 })]);
  const routes = (routeId: string) => usedModelRoutes(snapshot({ reviewSettings }), null).filter(use => use.routeId === routeId).map(use => use.model);
  expect(routes("crawl-agent-review")).toEqual(["legacy-first"]);
  expect(routes("second-review")).toEqual(["opus"]);
  setAssignmentTableEnabledForTest(true);
  expect(routes("crawl-agent-review")).toEqual(["[supa] Qwen"]);
  expect(routes("second-review")).toEqual(["deep-1", "[MLX] gpt"]);
});
