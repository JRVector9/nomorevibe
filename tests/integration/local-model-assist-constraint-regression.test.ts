import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hash = "a".repeat(64);
const requestChecks = ["model_capacity_requests_logical_check", "model_capacity_requests_dispatch_check", "model_capacity_requests_terminal_check"] as const;
const eventCheck = "model_capacity_events_terminal_check";
const checks = [...requestChecks, eventCheck];
const current = new Map<string, string>();
const historical = readFileSync("drizzle/0122_automated_action_audit.sql", "utf8");

beforeAll(async () => {
  ensureSchema();
  const rows = await admin<{ name: string; expression: string }[]>`SELECT conname AS name, pg_get_expr(conbin,conrelid) AS expression
    FROM pg_constraint WHERE conrelid IN ('model_capacity_requests'::regclass,'model_capacity_events'::regclass)
      AND conname = ANY(${checks}::text[])`;
  for (const row of rows) current.set(row.name, row.expression);
  expect([...current.keys()].sort()).toEqual([...checks].sort());
});
afterAll(async () => { await admin.end(); });

function fixture(task: string, purpose = "assist_review", job = "product-llm-assist-review") {
  const requestId = randomUUID(), token = randomUUID(), owner = { instanceId: "assist-constraint-fixture", bootId: randomUUID() };
  const target = { kind: "assist", purpose, workId: randomUUID(), workRevision: 1, claimToken: randomUUID(), task, subjectId: 41, backendId: "fixture-qwen" };
  // Deliberately bypass JS schema parsing: these tests exercise PostgreSQL's own fence.
  const binding = { kind: "local_model_direct", version: 1, target, logicalWorkKey: `direct:assist:41:${task}`,
    routeId: `local-assist-${task}-fixture-qwen`, provider: "local-direct", model: "fixture-qwen", backendId: target.backendId,
    physicalGroup: "fixture-hardware", deploymentRevision: "fixture-revision", inputHash: hash, sourceRevisionHash: hash,
    reviewPolicyHash: hash, promptVersion: "fixture-prompt", wireHash: hash, servingContractHash: hash,
    totalTokenBound: 8192, chargedTokens: 8192, job: { name: job, token: randomUUID(), requestedVersion: 1 } };
  const bindingHash = digest(binding);
  const dispatch = { requestId, owner, token, epoch: 1, revision: 1, policyHash: hash, binding, bindingHash };
  const terminal = { kind: "local_model_terminal", version: 1, dispatch, responseHash: hash, finishReason: "stop",
    actualUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, provenance: "upstream_reported" };
  const now = new Date().toISOString();
  const request = { request_id: requestId, work_key: `constraint:${requestId}`, owner_instance_id: owner.instanceId, owner_boot_id: owner.bootId,
    class: "background", pool: "reviewer", route_id: binding.routeId, provider: binding.provider, model: binding.model,
    provider_budget_id: binding.backendId, group_id: binding.physicalGroup, epoch: 1, revision: 1, policy_hash: hash, state: "settled",
    logical_work_key: binding.logicalWorkKey, logical_member_keys: null, dispatch_binding: binding, dispatch_binding_hash: bindingHash,
    dispatched_at: now, terminal_evidence: terminal, terminal_evidence_hash: digest(terminal), settled_at: now, token,
    reserved_until: now, queued_at: now, queue_until: now, updated_at: now };
  const event = { request_id: requestId, kind: "dispatch_settled", epoch: 1, revision: 1, policy_hash: hash,
    from_state: "dispatched", to_state: "settled", reason: null, evidence: terminal, created_at: now };
  return { request, event };
}

function previousExpression(name: string): string {
  const marker = `ADD CONSTRAINT ${name} CHECK (`;
  const statement = historical.split("--> statement-breakpoint").find(part => part.includes(marker));
  if (!statement) throw new Error(`historical_check_missing:${name}`);
  return statement.slice(statement.indexOf(marker) + marker.length, statement.lastIndexOf(");"));
}

async function accepts(name: string, expression: string, value: ReturnType<typeof fixture>) {
  const table = name === eventCheck ? "model_capacity_events" : "model_capacity_requests";
  const row = name === eventCheck ? value.event : value.request;
  // Expression/table come only from immutable repository DDL or pg_constraint, never model/user input.
  const [result] = await admin.unsafe<{ accepted: boolean }[]>(
    `SELECT (${expression}) AS accepted FROM jsonb_populate_record(NULL::${table},$1::jsonb) AS fixture`, [JSON.stringify(row)]);
  return result.accepted;
}

async function insertAndRollback(value: ReturnType<typeof fixture>, includeEvent = false) {
  const rollback = new Error("constraint_fixture_rollback");
  try {
    await admin.begin(async tx => {
      await tx`INSERT INTO model_capacity_requests SELECT (r).* FROM jsonb_populate_record(NULL::model_capacity_requests,
        ${JSON.stringify(value.request)}::text::jsonb || jsonb_build_object('queue_ordinal',nextval('model_capacity_requests_queue_ordinal_seq'))) r`;
      if (includeEvent) await tx`INSERT INTO model_capacity_events SELECT (r).* FROM jsonb_populate_record(NULL::model_capacity_events,
        ${JSON.stringify(value.event)}::text::jsonb || jsonb_build_object('id',nextval('model_capacity_events_id_seq'))) r`;
      throw rollback;
    });
  } catch (error) {
    if (error === rollback) return "accepted";
    const pg = error as { code?: string; constraint_name?: string };
    return `${pg.code}:${pg.constraint_name}`;
  }
  throw new Error("constraint_fixture_unexpected_commit");
}

it.each(["decision_audit", "semantic_exception"])("%s cannot inherit the old general-consumer OR branch after task-function expansion", async task => {
  const value = fixture(task);
  // 0122 expanded nmv_local_assist_task_valid while retaining 0119/0121's broad OR branches.
  // Evaluate those frozen predicates with the current task function to preserve the actual regression.
  for (const name of checks) expect(await accepts(name, previousExpression(name), value), `historical:${name}`).toBe(true);
  expect(await accepts(requestChecks[0], current.get(requestChecks[0])!, value)).toBe(true);
  for (const name of [requestChecks[1], requestChecks[2], eventCheck]) {
    expect(await accepts(name, current.get(name)!, value), `current:${name}`).toBe(false);
  }
  expect(await insertAndRollback(value)).toBe("23514:model_capacity_requests_dispatch_check");
});

it.each(["decision_audit", "semantic_exception"])("%s accepts the dedicated audit job through actual settled request/event constraints", async task => {
  const value = fixture(task, "assist_review", "product-llm-assist-audit-review");
  for (const name of checks) expect(await accepts(name, current.get(name)!, value), name).toBe(true);
  expect(await insertAndRollback(value, true)).toBe("accepted");
});

it.each(["uptime", "repo_move", "decision_audit", "semantic_exception", "news"])("intro_correction cannot be attached to %s", async task => {
  const job = ["decision_audit", "semantic_exception"].includes(task) ? "product-llm-assist-audit-review" : "product-llm-assist-review";
  const value = fixture(task, "intro_correction", job);
  for (const name of [requestChecks[1], requestChecks[2], eventCheck]) {
    expect(await accepts(name, current.get(name)!, value), name).toBe(false);
  }
  expect(await insertAndRollback(value)).toBe("23514:model_capacity_requests_dispatch_check");
});

it("valid intro correction and ordinary assist tasks retain their general consumer binding", async () => {
  for (const task of ["uptime", "repo_move", "intro_recheck", "news"]) {
    const value = fixture(task, task === "intro_recheck" ? "intro_correction" : "assist_review");
    for (const name of checks) expect(await accepts(name, current.get(name)!, value), `${task}:${name}`).toBe(true);
    expect(await insertAndRollback(value, true)).toBe("accepted");
  }
});
