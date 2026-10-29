import { beforeEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
const mocks = vi.hoisted(() => ({ fence: vi.fn(), mode: vi.fn() }));
vi.mock("@/lib/operations/dr/epoch", () => ({ lockWriterFence: mocks.fence }));
vi.mock("@/lib/llm/capacity-repository", () => ({ setModelCapacityMode: mocks.mode, setModelCapacityPolicy: vi.fn() }));
vi.mock("@/lib/operations/admin-log", () => ({ adminAuditRow: async (_actor: string, entry: unknown) => entry }));
import { runPipelineControl } from "@/lib/operations/pipeline-control-repository";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";

const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { abcllm: 4 }, groupLimits: { gateway: 4 },
  poolLimits: { reviewer: 2, text: 2 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 16, queueTtlMs: 60000, reservationTtlMs: 30000,
  routes: [{ routeId: "second-review", provider: "abcllm", model: "m", providerBudgetId: "abcllm", groupId: "gateway" }] };
const makeSnapshot = () => ({ now: "2026-10-17T00:00:00.000Z", fence: { state: "active", writerEpoch: 1 },
  stages: ["ai1", "ai2"].map(stage => ({ stage, mode: "legacy", drainingFrom: null, epoch: 1, contract: 1, live: 0, unsettled: 0, legacyJobLive: false, consumers: 1 })),
  capacity: { mode: "open", epoch: 1, revision: 1, policy, policyHash: modelCapacityPolicyHash(policy), waiting: 0, reserved: 0, dispatched: 0, indeterminate: 0, oldGeneration: 0 },
  http: { mode: "disabled", epoch: 1, revision: 1, policy: null, policyHash: null, reserved: 0, dispatched: 0, indeterminate: 0 },
  batch: { mode: "legacy", drainingFrom: null, epoch: 1, contract: 0, policy: null, policyHash: null, liveJobs: 0, liveRoles: 0, liveItems: 0, liveSources: 0, liveAgentClaims: 0 },
  agentScan: { mode: "legacy", drainingFrom: null, epoch: 1, contract: 0, live: 0, unsettled: 0, legacyJobLive: false, consumers: 0, queue: [] },
  recentInstances: [], uptimeSplitMode: "legacy", reviewSettings: null, auditCampaign: null });
beforeEach(() => { vi.resetAllMocks(); });
it("ACK hook은 readonly snapshot에 쓰지 않고 정식 전환·감사와 같은 TX에만 쓴다", async () => {
  const state = makeSnapshot(), events: string[] = [], dialect = new PgDialect();
  mocks.fence.mockImplementation(async () => { events.push("fence"); return { state: "active" }; });
  mocks.mode.mockImplementation(async () => { state.capacity.mode = "draining"; events.push("transition"); });
  const database = { transaction: async (load: (tx: unknown) => Promise<unknown>) => {
    let readOnly = false;
    const tx = { select: () => ({ from: () => ({ where: () => ({ for: async () => { expect(readOnly).toBe(false); return []; } }) }) }), execute: async (query: SQL) => {
      const text = dialect.sqlToQuery(query).sql;
      if (text.startsWith("SET TRANSACTION")) { readOnly = true; events.push("readonly"); }
      if (text.includes("AS snapshot")) return [{ snapshot: structuredClone(state) }];
      return [];
    }, insert: () => {
      expect(readOnly).toBe(false); events.push("audit");
      return { values: () => ({ returning: async () => [{ id: 1 }] }) };
    } };
    return load(tx);
  } };
  const before = vi.fn(async () => { events.push("before"); }), after = vi.fn(async () => { events.push("ack"); });
  const result = await runPipelineControl(database as never, { name: "capacity mode", area: "capacity", execute: true, json: true,
    allowDeferredRoutes: false, allowStalledStage: false, options: { to: "draining", fromMode: "open", expectEpoch: 1, expectRevision: 1, operator: "admin", reason: "test" } }, undefined, null,
  { beforeApply: before, afterApply: after });
  expect(result.executed).toBe(true); expect(before).toHaveBeenCalledTimes(1); expect(after).toHaveBeenCalledTimes(1);
  expect(events).toEqual(["readonly", "fence", "before", "transition", "audit", "ack", "readonly"]);
});
