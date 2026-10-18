import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { batchPolicyHash } from "@/lib/jobs/batches";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { deferredRoutes, formatControlResult, formatControlStatus, modelRouteContracts, parsePipelineControlArgs, pipelineControlDatabaseUrl,
  planPipelineControl, usedModelRoutes, type ControlSnapshot, type TransitionCommand } from "@/lib/operations/pipeline-control";
import { runPipelineControl } from "@/lib/operations/pipeline-control-repository";

const audit = ["--operator=jr", "--reason=pr06d unit"];
function transition(...args: string[]): TransitionCommand {
  const command = parsePipelineControlArgs([...args, ...audit]);
  if (command.name === "status") throw new Error("unexpected status");
  return command;
}
function snapshot(overrides: Partial<ControlSnapshot> = {}): ControlSnapshot {
  const stage = (name: "ai1" | "ai2") => ({ stage: name, mode: "legacy" as const, drainingFrom: null, epoch: 1, contract: 1,
    live: 0, unsettled: 0, legacyJobLive: false, consumers: 1 });
  return { now: "2026-10-17T00:00:00.000Z", fence: { state: "active", writerEpoch: 1 }, stages: [stage("ai1"), stage("ai2")],
    capacity: { mode: "disabled", epoch: 1, revision: 1, policy: null, policyHash: null, waiting: 0, reserved: 0, dispatched: 0, indeterminate: 0, oldGeneration: 0 },
    http: { mode: "disabled", epoch: 1, revision: 1, policy: null, policyHash: null, reserved: 0, dispatched: 0, indeterminate: 0 },
    batch: { mode: "legacy", drainingFrom: null, epoch: 1, contract: 0, policy: null, policyHash: null, liveJobs: 0, liveRoles: 0, liveItems: 0, liveSources: 0, liveAgentClaims: 0 },
    agentScan: { mode: "legacy", drainingFrom: null, epoch: 1, contract: 0, live: 0, unsettled: 0, legacyJobLive: false, consumers: 0, queue: [] },
    recentInstances: [], reviewSettings: null, auditCampaign: null, ...overrides };
}
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { abcllm: 4 }, groupLimits: { gateway: 4 },
  poolLimits: { reviewer: 2, text: 2 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 16, queueTtlMs: 60_000, reservationTtlMs: 30_000,
  routes: [{ routeId: "second-review", provider: "abcllm", model: "m", providerBudgetId: "abcllm", groupId: "gateway" }] };

describe("pipeline control arguments", () => {
  it("parses a transition with every expectation, audit field and flag", () => {
    expect(transition("stage", "drain", "--stage=ai2", "--from-mode=legacy", "--expect-epoch=3", "--execute", "--json")).toEqual({
      name: "stage drain", area: "stage", execute: true, json: true, allowDeferredRoutes: false, allowStalledStage: false,
      options: { stage: "ai2", fromMode: "legacy", expectEpoch: 3, operator: "jr", reason: "pr06d unit" } });
    expect(parsePipelineControlArgs(["status", "--json"])).toEqual({ name: "status", json: true });
    expect(parsePipelineControlArgs(["agent-scan", "status"])).toEqual({ name: "status", json: false, area: "agent-scan" });
    expect(transition("agent-scan", "complete", "--draining-from=legacy", "--to=items", "--expect-epoch=1")).toEqual({
      name: "agent-scan complete", area: "agent-scan", execute: false, json: false, allowDeferredRoutes: false, allowStalledStage: false,
      options: { drainingFrom: "legacy", to: "items", expectEpoch: 1, operator: "jr", reason: "pr06d unit" } });
    expect(transition("batch", "policy", "--file=p.json", "--expect-epoch=1", "--expect-policy-hash=none").options.expectPolicyHash).toBeNull();
  });

  it("defaults to dry-run and requires expected state, operator and reason", () => {
    expect(transition("capacity", "mode", "--to=draining", "--from-mode=disabled", "--expect-epoch=1", "--expect-revision=1").execute).toBe(false);
    expect(() => parsePipelineControlArgs(["stage", "drain", "--stage=ai2", "--from-mode=legacy", "--operator=jr", "--reason=x"]))
      .toThrow("pipeline_control_missing_expect_epoch");
    expect(() => parsePipelineControlArgs(["stage", "drain", "--stage=ai2", "--from-mode=legacy", "--expect-epoch=1", "--operator=jr"]))
      .toThrow("pipeline_control_missing_reason");
  });

  it.each([
    [["stage", "begin"], "pipeline_control_unknown_command"],
    [["stage", "drain", "--bogus=1"], "pipeline_control_unknown_option"],
    [["stage", "drain", "--stage=ai2", "--stage=ai1"], "pipeline_control_duplicate_option"],
    [["stage", "drain", "--execute=yes"], "pipeline_control_invalid_option"],
    [["stage", "drain", "--stage=fetch", "--from-mode=legacy", "--expect-epoch=1", ...audit], "pipeline_control_invalid_stage"],
    [["batch", "drain", "--from-mode=items", "--expect-epoch=1", ...audit], "pipeline_control_invalid_from_mode"],
    [["stage", "drain", "--stage=ai2", "--from-mode=legacy", "--expect-epoch=0", ...audit], "pipeline_control_invalid_expect_epoch"],
    [["http", "mode", "--to=open", "--from-mode=draining", "--expect-epoch=1", "--expect-revision=1", "--allow-deferred-routes", ...audit], "pipeline_control_unknown_option"],
    [["status", "--url=postgres://x@h:1/db"], "pipeline_control_url_argument_rejected"],
    [["agent-scan", "drain", "--from-mode=versioned", "--expect-epoch=1", ...audit], "pipeline_control_invalid_from_mode"],
    [["agent-scan", "drain", "--stage=ai1", "--from-mode=legacy", "--expect-epoch=1", ...audit], "pipeline_control_unknown_option"],
    [["agent-scan", "status", "--execute"], "pipeline_control_unknown_option"],
    [["stage", "contract", "--stage=ai1", "--expect-contract=0", "--expect-epoch=1", "--operator=jr", "--reason= padded"], "pipeline_control_invalid_reason"],
  ])("rejects %j", (args, code) => { expect(() => parsePipelineControlArgs(args)).toThrow(code); });

  it("takes the database only from its dedicated variable and refuses libpq overrides", () => {
    expect(() => pipelineControlDatabaseUrl({ DATABASE_URL: "postgres://a@b:1/c" })).toThrow("explicit_PIPELINE_CONTROL_DATABASE_URL_required");
    expect(() => pipelineControlDatabaseUrl({ PIPELINE_CONTROL_DATABASE_URL: "postgres://a@b:1/c", PGHOST: "x" })).toThrow("database_override_rejected");
    expect(pipelineControlDatabaseUrl({ PIPELINE_CONTROL_DATABASE_URL: "postgres://a@b:1/c" })).toBe("postgres://a@b:1/c");
  });
});

describe("pipeline control plan", () => {
  it("blocks every mismatched expectation (compare-and-set) and a fenced site", () => {
    const plan = planPipelineControl(transition("stage", "drain", "--stage=ai2", "--from-mode=items", "--expect-epoch=2"),
      snapshot({ fence: { state: "fenced", writerEpoch: 1 } }));
    expect(plan.blocked).toEqual(["site_fenced", "expect_epoch_mismatch:1", "expect_mode_mismatch:legacy"]);
  });

  it("requires a drained stage and warns before items without a consumer heartbeat", () => {
    const stages = snapshot().stages.map(row => row.stage === "ai2"
      ? { ...row, mode: "draining" as const, drainingFrom: "legacy" as const, live: 2, consumers: 0, legacyJobLive: true } : row);
    const plan = planPipelineControl(transition("stage", "complete", "--stage=ai2", "--draining-from=legacy", "--to=items", "--expect-epoch=1",
      "--allow-stalled-stage"), snapshot({ stages }));
    expect(plan.blocked).toEqual(["stage_not_drained:2"]);
    expect(plan.warnings).toEqual(["consumer_heartbeat_missing:ai2", "items_consumer_defers:capacity_disabled:ai2", "legacy_job_in_flight:ai2"]);
    const open = snapshot({ stages, capacity: { ...snapshot().capacity, mode: "open", policy, policyHash: modelCapacityPolicyHash(policy) } });
    expect(planPipelineControl(transition("stage", "complete", "--stage=ai2", "--draining-from=legacy", "--to=items", "--expect-epoch=1",
      "--allow-stalled-stage"), open).warnings)
      .toContain("items_consumer_defers:route_not_serving:ai2");
    expect(plan.change).toBe("draining(from legacy) → items, epoch 1 → 2");
  });

  it("keeps the legacy return behind draining and the stage contract", () => {
    const items = snapshot().stages.map(row => ({ ...row, mode: "items" as const }));
    expect(planPipelineControl(transition("stage", "complete", "--stage=ai1", "--draining-from=items", "--to=legacy", "--expect-epoch=1"),
      snapshot({ stages: items })).blocked).toEqual(["expect_mode_mismatch:items", "expect_draining_from_mismatch:none"]);
    const noContract = snapshot().stages.map(row => ({ ...row, contract: 0 }));
    expect(planPipelineControl(transition("stage", "drain", "--stage=ai1", "--from-mode=legacy", "--expect-epoch=1"),
      snapshot({ stages: noContract })).blocked).toEqual(["stage_contract_required"]);
  });

  it("moves capacity only through draining and refuses open while any route would be deferred", () => {
    expect(planPipelineControl(transition("capacity", "mode", "--to=open", "--from-mode=disabled", "--expect-epoch=1", "--expect-revision=1"),
      snapshot()).blocked).toEqual(["capacity_transition_invalid", "capacity_policy_missing"]);
    const draining = snapshot({ capacity: { ...snapshot().capacity, mode: "draining", revision: 2, policy, policyHash: modelCapacityPolicyHash(policy) } });
    const refused = planPipelineControl(transition("capacity", "mode", "--to=open", "--from-mode=draining", "--expect-epoch=1", "--expect-revision=2"), draining);
    const rows = modelRouteContracts(policy, "legacy", usedModelRoutes(draining, null));
    expect(rows).toContainEqual({ routeId: "second-review", provider: "abcllm", model: "m", status: "unused" });
    expect(rows).toContainEqual({ routeId: "second-review", provider: "legacy-job", model: null, status: "stage_legacy" });
    expect(rows).toContainEqual({ routeId: "product-audit", provider: "abcllm", model: null, status: "unused" });
    expect(refused.blocked).toEqual([`deferred_routes:${deferredRoutes(rows).length}`]);
    expect(refused.routes).toEqual(rows);
    const allowed = planPipelineControl({ ...transition("capacity", "mode", "--to=open", "--from-mode=draining", "--expect-epoch=1", "--expect-revision=2"),
      allowDeferredRoutes: true }, draining);
    expect([allowed.blocked, allowed.warnings]).toEqual([[], [`deferred_routes:${deferredRoutes(rows).length}`]]);
  });

  it("changes a policy only while closed and refuses an unchanged or invalid policy", () => {
    const open = snapshot({ capacity: { ...snapshot().capacity, mode: "open", policy, policyHash: modelCapacityPolicyHash(policy) } });
    expect(planPipelineControl(transition("capacity", "policy", "--file=p", "--from-mode=open", "--expect-epoch=1", "--expect-revision=1"), open, policy).blocked)
      .toEqual(["capacity_policy_requires_closed", "policy_unchanged"]);
    expect(planPipelineControl(transition("capacity", "policy", "--file=p", "--from-mode=disabled", "--expect-epoch=1", "--expect-revision=1"), snapshot(),
      { ...policy, globalLimit: 0 }).blocked).toEqual(["policy_invalid:globalLimit"]);
    expect(planPipelineControl(transition("http", "policy", "--file=p", "--from-mode=disabled", "--expect-epoch=1", "--expect-revision=1"),
      snapshot({ recentInstances: ["m3-crawler", "mini-text"] }), { version: 1, instanceHosts: { "m3-crawler": "m3" } }).warnings).toEqual(["instance_unmapped:mini-text"]);
  });

  it("never enters a batch drain that could only end in versioned without a valid policy", () => {
    const contracted = snapshot({ batch: { ...snapshot().batch, contract: 1 } });
    expect(planPipelineControl(transition("batch", "drain", "--from-mode=legacy", "--expect-epoch=1"), contracted).blocked)
      .toEqual(["batch_policy_required_for_versioned"]);
    const batchPolicy = { version: 1 as const, release: "r1", instances: [{ instanceId: "m3-text", host: "m3" as const }] };
    const draining = snapshot({ batch: { ...contracted.batch, mode: "draining", drainingFrom: "legacy", policy: batchPolicy,
      policyHash: batchPolicyHash(batchPolicy), liveJobs: 1 } });
    expect(planPipelineControl(transition("batch", "complete", "--draining-from=legacy", "--to=legacy", "--expect-epoch=1"), draining).blocked)
      .toEqual(["batch_transition_invalid", "batch_not_drained:jobs=1,roles=0,items=0,sources=0,agent_claims=0"]);
    // 살아 있는 제작 근거 scan claim 도 전역 정지가 아니다(completeJobBatchTransition 과 같은 다섯 조건)
    const claimed = snapshot({ batch: { ...draining.batch, liveJobs: 0, liveAgentClaims: 2 } });
    expect(planPipelineControl(transition("batch", "complete", "--draining-from=legacy", "--to=versioned", "--expect-epoch=1"), claimed).blocked)
      .toEqual(["batch_not_drained:jobs=0,roles=0,items=0,sources=0,agent_claims=2"]);
  });

  it("moves the agent scan control only through a contract and draining, and completes only without a live claim", () => {
    const agent = (patch: Partial<ControlSnapshot["agentScan"]>) => snapshot({ agentScan: { ...snapshot().agentScan, ...patch } });
    const contract = planPipelineControl(transition("agent-scan", "contract", "--expect-contract=0", "--expect-epoch=1"), agent({}));
    expect([contract.target, contract.change, contract.blocked]).toEqual(["agent_scan_control", "writer_contract 0 → 1", []]);
    expect(planPipelineControl(transition("agent-scan", "contract", "--expect-contract=0", "--expect-epoch=2"), agent({ mode: "items", contract: 1 })).blocked)
      .toEqual(["expect_epoch_mismatch:1", "expect_contract_mismatch:1", "agent_scan_transition_invalid"]);
    expect(planPipelineControl(transition("agent-scan", "drain", "--from-mode=legacy", "--expect-epoch=1"), agent({})).blocked)
      .toEqual(["agent_scan_contract_required"]);
    const drain = planPipelineControl(transition("agent-scan", "drain", "--from-mode=legacy", "--expect-epoch=1"), agent({ contract: 1 }));
    expect([drain.blocked, drain.warnings, drain.change]).toEqual([[], ["consumer_heartbeat_missing:agent-scan", "agent_scan_paused_until_complete"],
      "legacy → draining (epoch 1 유지)"]);
    const draining = { mode: "draining" as const, drainingFrom: "legacy" as const, contract: 1 };
    const busy = planPipelineControl(transition("agent-scan", "complete", "--draining-from=legacy", "--to=items", "--expect-epoch=1"),
      agent({ ...draining, live: 2, unsettled: 3, legacyJobLive: true }));
    expect([busy.blocked, busy.warnings]).toEqual([["agent_scan_not_drained:2"],
      ["consumer_heartbeat_missing:agent-scan", "legacy_job_in_flight:agent-scan", "expired_unsettled_claims:3"]]);
    const ready = planPipelineControl(transition("agent-scan", "complete", "--draining-from=legacy", "--to=items", "--expect-epoch=1"),
      agent({ ...draining, consumers: 1 }));
    expect([ready.blocked, ready.warnings, ready.change]).toEqual([[], [], "draining(from legacy) → items, epoch 1 → 2"]);
    // 되돌리기도 draining 을 거친다 — items 에서 legacy 로 바로 갈 수 없다
    expect(planPipelineControl(transition("agent-scan", "complete", "--draining-from=items", "--to=legacy", "--expect-epoch=2"),
      agent({ mode: "items", epoch: 2, contract: 1 })).blocked).toEqual(["expect_mode_mismatch:items", "expect_draining_from_mismatch:none"]);
    expect(planPipelineControl(transition("agent-scan", "complete", "--draining-from=legacy", "--to=draining", "--expect-epoch=1"),
      agent(draining)).blocked).toEqual(["agent_scan_transition_invalid"]);
    // legacy 로 끝내면 writer contract 를 0 으로 내린다고 알린다 — 다시 items 로 가려면 contract 부터 다시 한다
    const back = planPipelineControl(transition("agent-scan", "complete", "--draining-from=items", "--to=legacy", "--expect-epoch=2"),
      agent({ mode: "draining", drainingFrom: "items", epoch: 2, contract: 1 }));
    expect([back.blocked, back.warnings, back.change]).toEqual([[], ["agent_scan_contract_reset"], "draining(from items) → legacy, epoch 2 → 3, writer_contract 1 → 0"]);
  });

  it("formats a readable status and result", () => {
    expect(formatControlStatus(snapshot())).toContain("[capacity routes]");
    const queue = [{ priority: 0, waiting: 1, oldestMinutes: 2.5 }, { priority: 6, waiting: 0, oldestMinutes: null }];
    const area = formatControlStatus(snapshot({ agentScan: { ...snapshot().agentScan, mode: "items", epoch: 2, contract: 1, live: 1, consumers: 2, queue } }), null, "agent-scan");
    expect(area).toContain("[agent-scan] mode=items from=- epoch=2 contract=1 live=1 unsettled=0 legacy_job=idle consumers=2");
    expect(area).toMatch(/priority\s+waiting\s+oldest_min\n0\s+1\s+2\.5\n6\s+0\s+-/);
    expect(area).not.toContain("[capacity routes]");
    const plan = planPipelineControl(transition("stage", "contract", "--stage=ai1", "--expect-contract=1", "--expect-epoch=1"), snapshot());
    expect(formatControlResult({ command: "stage contract", dryRun: true, executed: false, blocked: false, plan, before: snapshot() }))
      .toContain("dry-run 허용");
  });
});

type Recorded = { text: string };
const dialect = new PgDialect();
/** 실제 drizzle 대신 기록만 하는 DB. select·insert·update 빌더는 없다 — 부르면 TypeError로 테스트가 깨진다. */
function fakeDatabase(snapshots: ControlSnapshot[]) {
  const queries: Recorded[] = [];
  let transactions = 0;
  const tx = {
    execute: async (query: SQL) => {
      const text = dialect.sqlToQuery(query).sql;
      queries.push({ text });
      if (text.includes("dr_writer_fence WHERE id = 1 FOR")) return [{ lineage_id: "00000000-0000-4000-8000-000000000001", writer_epoch: 1, state: "active",
        reason: null, fenced_db: null, promotion_id: null }];
      return text.includes("jsonb_build_object") ? [{ snapshot: snapshots.shift() }] : [];
    },
    select: () => ({ from: () => ({ where: () => ({ for: async () => [] }) }) }),
  };
  const database = { transaction: async <T>(load: (value: typeof tx) => Promise<T>) => { transactions++; return load(tx); } };
  return { database: database as unknown as Parameters<typeof runPipelineControl>[0], queries, transactions: () => transactions };
}

describe("pipeline control runner", () => {
  it("dry-run opens one read-only transaction and writes nothing", async () => {
    const fake = fakeDatabase([snapshot()]);
    const result = await runPipelineControl(fake.database, transition("stage", "drain", "--stage=ai2", "--from-mode=legacy", "--expect-epoch=1"));
    expect([result.dryRun, result.executed, result.blocked]).toEqual([true, false, false]);
    expect(fake.transactions()).toBe(1);
    expect(fake.queries.map(query => query.text.trim().split(/\s+/).slice(0, 2).join(" "))).toEqual(["SET TRANSACTION", "WITH c"]);
    expect(fake.queries[0].text).toContain("READ ONLY");
  });

  it("execute re-plans under the lock and writes nothing when the locked state moved", async () => {
    const moved = snapshot({ stages: snapshot().stages.map(row => row.stage === "ai2" ? { ...row, epoch: 2 } : row) });
    const fake = fakeDatabase([snapshot(), moved]);
    const result = await runPipelineControl(fake.database, transition("stage", "drain", "--stage=ai2", "--from-mode=legacy", "--expect-epoch=1", "--execute"));
    expect([result.executed, result.blocked, result.plan.blocked]).toEqual([false, true, ["expect_epoch_mismatch:2"]]);
    expect(result.before).toEqual(moved);
    expect(fake.queries.some(query => /\b(UPDATE|INSERT)\b/.test(query.text))).toBe(false);
  });
});
