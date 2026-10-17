import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import postgres from "postgres";
import { randomInt, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batchPolicyHash } from "@/lib/jobs/batches";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { httpOriginPolicyHash } from "@/lib/net/http-origin-policy";
import type { ControlResult, ControlSnapshot } from "@/lib/operations/pipeline-control";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const client = postgres(TEST_DATABASE_URL, { max: 2 });
const tag = randomUUID().slice(0, 8), operator = `pr06d-${tag}`, instance = `pr06d-${tag}`;
const audit = [`--operator=${operator}`, "--reason=pr06d integration"];
const CONTROLS = { pipeline_stage_modes: "stage", model_capacity_control: "id", http_origin_control: "id", job_batch_control: "id" } as const;
const ownLeases: [string, string][] = [];
let baseline: Record<string, unknown[]> | undefined;
let directory = "";

// CLI는 앱 DATABASE_URL·PG* 없이 전용 변수만으로 붙어야 한다. 호출 지점 model env는 route 행이 셸에 따라 바뀌지 않게 고정한다.
const MODEL_ENV = { ABCLLM_MODEL: "pr06d-model", ABCLLM_TAGLINE_MODEL: "pr06d-tagline", ABCLLM_PROFILE_MODEL: "pr06d-profile",
  SEARCH_VERIFY_MODEL: "pr06d-verify", INTRO_CHECK_MODEL: "pr06d-intro", CRAWL_REVIEW_MODEL: "pr06d-env-ai1" };
const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PG|DATABASE_URL$|READ_DATABASE_URL$)/.test(key))),
  ...MODEL_ENV, NODE_ENV: "test", PIPELINE_CONTROL_DATABASE_URL: TEST_DATABASE_URL };
const CLI = ["--import", "tsx", "scripts/ops/pipeline-control.ts"];
type CliRun = { status: number | null; stderr: string; out: (ControlResult & { snapshot: ControlSnapshot }) | null };
function cli(...args: string[]): CliRun {
  const run = spawnSync(process.execPath, [...CLI, ...args, "--json"], { encoding: "utf8", env, timeout: 60_000 });
  return { status: run.status, stderr: run.stderr, out: run.stdout.trim() ? JSON.parse(run.stdout) : null };
}

async function controlRows(): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const [table, key] of Object.entries(CONTROLS)) {
    result[table] = (await client.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY "${key}"`)).map(row => row.row);
  }
  return result;
}
const auditMax = async () => (await client`SELECT coalesce(max(id), 0)::int AS id FROM operations_audit`)[0].id as number;
const ownAudit = (after: number) => client`SELECT id, actor, actor_kind, ip, user_agent, action, target, detail, ok
  FROM operations_audit WHERE id > ${after} AND actor = ${operator} ORDER BY id`;
async function stage(name: "ai1" | "ai2") {
  const [row] = await client`SELECT mode, draining_from, epoch::int AS epoch, writer_contract_version AS contract FROM pipeline_stage_modes WHERE stage = ${name}`;
  return row as unknown as { mode: string; draining_from: string | null; epoch: number; contract: number };
}
async function control(table: "model_capacity_control" | "http_origin_control" | "job_batch_control") {
  const [row] = await client.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE id = 1`);
  return row.row as Record<string, unknown> & { mode: string; epoch: number; revision?: number; policy_hash: string | null };
}
function policyFile(name: string, value: unknown): string {
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}
async function waitFor(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 300; attempt++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error("pipeline_control_wait_timeout");
}

beforeAll(async () => {
  ensureSchema();
  baseline = await controlRows();
  directory = mkdtempSync(join(tmpdir(), "nomorevibe-pr06d-"));
  expect((await client`SELECT state FROM dr_writer_fence WHERE id = 1`)[0].state).toBe("active");
});
// 전환 시작점: legacy·disabled·계약 0. epoch·revision은 단조 증가 값이라 그대로 둔다.
beforeEach(async () => {
  await client.begin(async tx => {
    await tx`UPDATE pipeline_stage_modes SET mode = 'legacy', draining_from = NULL, writer_contract_version = 0 WHERE stage IN ('ai1', 'ai2')`;
    await tx`UPDATE model_capacity_control SET mode = 'disabled', policy = NULL, policy_hash = NULL, cursor = 0 WHERE id = 1`;
    await tx`UPDATE http_origin_control SET mode = 'disabled', policy = NULL, policy_hash = NULL WHERE id = 1`;
    await tx`UPDATE job_batch_control SET mode = 'legacy', draining_from = NULL, writer_contract_version = 0, policy = NULL, policy_hash = NULL WHERE id = 1`;
  });
});
afterAll(async () => {
  const errors: unknown[] = [];
  const step = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { errors.push(error); } };
  await step(async () => { for (const [name, key] of ownLeases) await client`DELETE FROM pipeline_item_leases WHERE stage = ${name} AND work_key = ${key}`; });
  await step(async () => {
    if (!baseline) return;
    const original = baseline;
    await client.begin(async tx => {
      for (const [table, key] of Object.entries(CONTROLS)) {
        const [metadata] = await tx`SELECT array_agg(column_name::text ORDER BY ordinal_position) AS names FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ${table} AND column_name <> ${key}`;
        const columns = (metadata.names as string[]).map(name => `"${name}"`);
        await tx.unsafe(`UPDATE ${table} t SET (${columns.join(",")}) = (${columns.map(name => `r.${name}`).join(",")})
          FROM jsonb_populate_recordset(NULL::${table}, $1::text::jsonb) r WHERE t."${key}" = r."${key}"`, [JSON.stringify(original[table])]);
      }
    });
    expect(await controlRows()).toEqual(original);
  });
  await step(async () => { if (directory) rmSync(directory, { recursive: true, force: true }); });
  await step(() => client.end({ timeout: 5 }));
  if (errors.length) throw new AggregateError(errors, "pr06d_cleanup");
});

it("dry-run prints the readback and plan while every control row and the audit log stay identical", async () => {
  const before = await controlRows(), auditBefore = await auditMax(), { epoch } = await stage("ai2");
  const contract = cli("stage", "contract", "--stage=ai2", "--expect-contract=0", `--expect-epoch=${epoch}`, ...audit);
  expect([contract.status, contract.stderr]).toEqual([0, ""]);
  expect(contract.out).toMatchObject({ command: "stage contract", dryRun: true, executed: false, blocked: false,
    plan: { target: "pipeline_stage_modes:ai2", change: "writer_contract 0 → 1", blocked: [] } });
  expect(contract.out?.before.stages).toContainEqual(expect.objectContaining({ stage: "ai2", mode: "legacy", contract: 0, epoch }));
  const drain = cli("stage", "drain", "--stage=ai2", "--from-mode=legacy", `--expect-epoch=${epoch}`, ...audit);
  expect(drain.status).toBe(3);
  expect(drain.out?.plan.blocked).toEqual(["stage_contract_required"]);
  const human = spawnSync(process.execPath, [...CLI, "stage", "contract", "--stage=ai2", "--expect-contract=0", `--expect-epoch=${epoch}`, ...audit],
    { encoding: "utf8", env, timeout: 60_000 });
  expect(human.status).toBe(0);
  expect(human.stdout).toContain("dry-run 허용 — DB 쓰기 없음");
  expect(human.stdout).toMatch(/stage\s+mode\s+from\s+epoch\s+contract/);
  expect(await controlRows()).toEqual(before);
  expect(await auditMax()).toBe(auditBefore);
}, 120_000);

it("execute moves AI2 legacy → draining → items through compare-and-set and logs one audit row per transition", async () => {
  const auditBefore = await auditMax(), { epoch } = await stage("ai2");
  const contract = cli("stage", "contract", "--stage=ai2", "--expect-contract=0", `--expect-epoch=${epoch}`, ...audit, "--execute");
  expect([contract.status, contract.stderr, contract.out?.executed]).toEqual([0, "", true]);
  expect(await stage("ai2")).toEqual({ mode: "legacy", draining_from: null, epoch, contract: 1 });
  const drain = cli("stage", "drain", "--stage=ai2", "--from-mode=legacy", `--expect-epoch=${epoch}`, ...audit, "--execute");
  expect([drain.status, drain.out?.executed]).toEqual([0, true]);
  expect(drain.out?.after?.stages).toContainEqual(expect.objectContaining({ stage: "ai2", mode: "draining", drainingFrom: "legacy", epoch }));
  const complete = cli("stage", "complete", "--stage=ai2", "--draining-from=legacy", "--to=items", `--expect-epoch=${epoch}`, ...audit,
    "--allow-stalled-stage", "--execute");
  expect([complete.status, complete.out?.executed]).toEqual([0, true]);
  expect(complete.out?.plan.warnings).toEqual(expect.arrayContaining(["consumer_heartbeat_missing:ai2", "items_consumer_defers:capacity_disabled:ai2"]));
  expect(await stage("ai2")).toEqual({ mode: "items", draining_from: null, epoch: epoch + 1, contract: 1 });
  const rows = await ownAudit(auditBefore);
  expect(rows.map(row => [row.id, row.action, row.target, row.actor_kind, row.ip, row.user_agent, row.ok])).toEqual([
    [contract.out?.auditId, "pipeline-control-stage-contract", "pipeline_stage_modes:ai2", null, null, null, true],
    [drain.out?.auditId, "pipeline-control-stage-drain", "pipeline_stage_modes:ai2", null, null, null, true],
    [complete.out?.auditId, "pipeline-control-stage-complete", "pipeline_stage_modes:ai2", null, null, null, true],
  ]);
  expect(rows[2].detail).toMatchObject({ reason: "pr06d integration", change: `draining(from legacy) → items, epoch ${epoch} → ${epoch + 1}`,
    before: { mode: "draining", drainingFrom: "legacy", epoch }, after: { mode: "items", epoch: epoch + 1 },
    expected: { stage: "ai2", drainingFrom: "legacy", to: "items", expectEpoch: epoch } });
}, 120_000);

it("refuses a stale expectation and a change committed while it waited for the row lock, writing nothing", async () => {
  await client`UPDATE pipeline_stage_modes SET mode = 'items', writer_contract_version = 1 WHERE stage = 'ai2'`;
  const { epoch } = await stage("ai2"), before = await controlRows(), auditBefore = await auditMax();
  const stale = cli("stage", "drain", "--stage=ai2", "--from-mode=items", `--expect-epoch=${epoch + 1}`, ...audit, "--execute");
  expect([stale.status, stale.out?.executed, stale.out?.plan.blocked]).toEqual([3, false, [`expect_epoch_mismatch:${epoch}`]]);
  expect(await controlRows()).toEqual(before);

  const child = spawn(process.execPath, [...CLI, "stage", "drain", "--stage=ai2", "--from-mode=items", `--expect-epoch=${epoch}`, ...audit, "--execute", "--json"],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise<number | null>(resolve => child.on("close", resolve));
  await client.begin(async tx => {
    await tx`SELECT stage FROM pipeline_stage_modes WHERE stage = 'ai2' FOR UPDATE`;
    // CLI의 읽기 전용 판정은 통과했고, 실행 TX가 이 행 잠금 뒤에서 기다리는 것을 확인한 다음에 바꾼다.
    await waitFor(async () => (await client`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE application_name = 'nomorevibe:pipeline-control' AND wait_event_type = 'Lock'`)[0].n === 1);
    await tx`UPDATE pipeline_stage_modes SET epoch = epoch + 1 WHERE stage = 'ai2'`;
  });
  expect([await exited, stderr]).toEqual([3, ""]);
  expect(JSON.parse(stdout)).toMatchObject({ executed: false, blocked: true, plan: { blocked: [`expect_epoch_mismatch:${epoch + 1}`] } });
  expect(await stage("ai2")).toEqual({ mode: "items", draining_from: null, epoch: epoch + 1, contract: 1 });
  expect(await auditMax()).toBe(auditBefore);
}, 120_000);

it("returns AI1 to legacy only through draining and only after live item leases end", async () => {
  await client`UPDATE pipeline_stage_modes SET mode = 'items', writer_contract_version = 1 WHERE stage = 'ai1'`;
  const { epoch } = await stage("ai1"), auditBefore = await auditMax();
  const direct = cli("stage", "complete", "--stage=ai1", "--draining-from=items", "--to=legacy", `--expect-epoch=${epoch}`, ...audit, "--execute");
  expect([direct.status, direct.out?.plan.blocked]).toEqual([3, ["expect_mode_mismatch:items", "expect_draining_from_mismatch:none"]]);
  expect(cli("stage", "drain", "--stage=ai1", "--from-mode=items", `--expect-epoch=${epoch}`, ...audit, "--execute").status).toBe(0);
  const candidate = 900_000_000 + randomInt(90_000_000), workKey = `ai1:${candidate}`;
  ownLeases.push(["ai1", workKey]);
  await client`INSERT INTO pipeline_item_leases (stage, work_key, binding, binding_hash, owner_instance_id, owner_boot_id, token, stage_epoch, item_epoch, lease_until)
    VALUES ('ai1', ${workKey}, ${JSON.stringify({ stage: "ai1", candidateId: candidate })}::text::jsonb, ${"a".repeat(64)}, ${instance},
      ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${epoch}, 1, clock_timestamp() + interval '5 minutes')`;
  const busy = cli("stage", "complete", "--stage=ai1", "--draining-from=items", "--to=legacy", `--expect-epoch=${epoch}`, ...audit, "--execute");
  expect([busy.status, busy.out?.plan.blocked]).toEqual([3, ["stage_not_drained:1"]]);
  expect(await stage("ai1")).toEqual({ mode: "draining", draining_from: "items", epoch, contract: 1 });
  await client`DELETE FROM pipeline_item_leases WHERE stage = 'ai1' AND work_key = ${workKey}`;
  const back = cli("stage", "complete", "--stage=ai1", "--draining-from=items", "--to=legacy", `--expect-epoch=${epoch}`, ...audit, "--execute");
  expect([back.status, back.out?.executed]).toEqual([0, true]);
  expect(await stage("ai1")).toEqual({ mode: "legacy", draining_from: null, epoch: epoch + 1, contract: 1 });
  expect((await ownAudit(auditBefore)).map(row => row.action)).toEqual(["pipeline-control-stage-drain", "pipeline-control-stage-complete"]);
}, 120_000);

it("refuses capacity open while routes would be deferred and opens only with --allow-deferred-routes", async () => {
  const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { abcllm: 4 }, groupLimits: { gateway: 4 },
    poolLimits: { reviewer: 2, text: 2 }, weights: { first: 2, second: 1, background: 1 }, maxWaiting: 32, queueTtlMs: 60_000, reservationTtlMs: 30_000,
    routes: [{ routeId: "second-review", provider: "abcllm", model: "pr06d-model", providerBudgetId: "abcllm", groupId: "gateway" },
      { routeId: "reason-translate", provider: "abcllm", model: "pr06d-model", providerBudgetId: "abcllm", groupId: "gateway" }] };
  const start = await control("model_capacity_control"), auditBefore = await auditMax();
  const expect0 = [`--expect-epoch=${start.epoch}`, `--expect-revision=${start.revision}`];
  const set = cli("capacity", "policy", `--file=${policyFile("capacity.json", policy)}`, "--from-mode=disabled", ...expect0, ...audit, "--execute");
  expect([set.status, set.stderr, set.out?.plan.policyHash]).toEqual([0, "", modelCapacityPolicyHash(policy)]);
  expect(await control("model_capacity_control")).toMatchObject({ mode: "disabled", revision: start.revision! + 1, policy_hash: modelCapacityPolicyHash(policy) });
  const expect1 = [`--expect-epoch=${start.epoch}`, `--expect-revision=${start.revision! + 1}`];
  expect(cli("capacity", "mode", "--to=open", "--from-mode=disabled", ...expect1, ...audit, "--execute").out?.plan.blocked[0]).toBe("capacity_transition_invalid");
  expect(cli("capacity", "mode", "--to=draining", "--from-mode=disabled", ...expect1, ...audit, "--execute").status).toBe(0);

  const auditDraining = await auditMax(), drainingRow = await control("model_capacity_control");
  const refused = cli("capacity", "mode", "--to=open", "--from-mode=draining", ...expect1, ...audit, "--execute");
  expect(refused.status).toBe(3);
  const routes = refused.out?.plan.routes ?? [];
  expect(routes).toContainEqual({ routeId: "second-review", provider: "abcllm", model: "pr06d-model", status: "unused" });
  expect(routes).toContainEqual({ routeId: "reason-translate", provider: "abcllm", model: "pr06d-model", status: "no_contract" });
  expect(routes).toContainEqual({ routeId: "product-intro-check", provider: "claude-cli", model: MODEL_ENV.INTRO_CHECK_MODEL, status: "unmapped" });
  expect(routes).toContainEqual({ routeId: "second-review", provider: "legacy-job", model: null, status: "stage_legacy" });
  const deferred = routes.filter(row => row.status !== "serving" && row.status !== "unused").length;
  expect(refused.out?.plan.blocked).toEqual([`deferred_routes:${deferred}`]);
  expect([await control("model_capacity_control"), await auditMax()]).toEqual([drainingRow, auditDraining]);

  const opened = cli("capacity", "mode", "--to=open", "--from-mode=draining", ...expect1, "--allow-deferred-routes", ...audit, "--execute");
  expect([opened.status, opened.out?.plan.warnings]).toEqual([0, [`deferred_routes:${deferred}`]]);
  expect((await control("model_capacity_control")).mode).toBe("open");
  expect(cli("capacity", "policy", `--file=${policyFile("capacity.json", policy)}`, "--from-mode=open", ...expect1, ...audit, "--execute").out?.plan.blocked)
    .toEqual(["capacity_policy_requires_closed", "policy_unchanged"]);
  expect(cli("capacity", "mode", "--to=draining", "--from-mode=open", ...expect1, ...audit, "--execute").status).toBe(0);
  expect(cli("capacity", "mode", "--to=disabled", "--from-mode=draining", ...expect1, ...audit, "--execute").status).toBe(0);
  expect(await control("model_capacity_control")).toMatchObject({ mode: "disabled", revision: start.revision! + 1, epoch: start.epoch });
  expect((await ownAudit(auditBefore)).map(row => row.action)).toEqual(["pipeline-control-capacity-policy", "pipeline-control-capacity-mode",
    "pipeline-control-capacity-mode", "pipeline-control-capacity-mode", "pipeline-control-capacity-mode"]);
}, 180_000);

it("sets the shared HTTP policy and moves its mode only through draining", async () => {
  const policy = { version: 1, instanceHosts: { [instance]: "m3" } }, start = await control("http_origin_control"), auditBefore = await auditMax();
  const expect0 = [`--expect-epoch=${start.epoch}`, `--expect-revision=${start.revision}`];
  expect(cli("http", "policy", `--file=${policyFile("http.json", policy)}`, "--from-mode=disabled", ...expect0, ...audit, "--execute").status).toBe(0);
  expect(await control("http_origin_control")).toMatchObject({ mode: "disabled", revision: start.revision! + 1, policy_hash: httpOriginPolicyHash(policy) });
  const expect1 = [`--expect-epoch=${start.epoch}`, `--expect-revision=${start.revision! + 1}`];
  expect(cli("http", "mode", "--to=open", "--from-mode=disabled", ...expect1, ...audit, "--execute").out?.plan.blocked).toEqual(["http_transition_invalid"]);
  for (const [from, to] of [["disabled", "draining"], ["draining", "open"], ["open", "draining"], ["draining", "disabled"]]) {
    const run = cli("http", "mode", `--to=${to}`, `--from-mode=${from}`, ...expect1, ...audit, "--execute");
    expect([run.status, run.stderr, (await control("http_origin_control")).mode]).toEqual([0, "", to]);
  }
  expect((await ownAudit(auditBefore)).map(row => row.action)).toEqual(["pipeline-control-http-policy", ...Array(4).fill("pipeline-control-http-mode")]);
}, 180_000);

it("installs a batch policy and contract, then runs legacy → versioned → legacy through draining", async () => {
  const policy = { version: 1 as const, release: "pr06d-test", instances: [{ instanceId: instance, host: "m3" as const }] };
  const start = await control("job_batch_control"), auditBefore = await auditMax(), epoch = start.epoch;
  expect(cli("batch", "drain", "--from-mode=legacy", `--expect-epoch=${epoch}`, ...audit, "--execute").out?.plan.blocked)
    .toEqual(["batch_contract_required", "batch_policy_required_for_versioned"]);
  const set = cli("batch", "policy", `--file=${policyFile("batch.json", policy)}`, `--expect-epoch=${epoch}`, "--expect-policy-hash=none", ...audit, "--execute");
  expect([set.status, set.stderr]).toEqual([0, ""]);
  expect(cli("batch", "contract", "--expect-contract=0", `--expect-epoch=${epoch}`, ...audit, "--execute").status).toBe(0);
  expect(await control("job_batch_control")).toMatchObject({ mode: "legacy", writer_contract_version: 1, policy_hash: batchPolicyHash(policy) });
  expect(cli("batch", "drain", "--from-mode=legacy", `--expect-epoch=${epoch}`, ...audit, "--execute").status).toBe(0);
  const versioned = cli("batch", "complete", "--draining-from=legacy", "--to=versioned", `--expect-epoch=${epoch}`, ...audit, "--execute");
  expect([versioned.status, versioned.out?.plan.blocked]).toEqual([0, []]);
  expect(await control("job_batch_control")).toMatchObject({ mode: "versioned", draining_from: null, epoch: epoch + 1 });
  expect(cli("batch", "drain", "--from-mode=versioned", `--expect-epoch=${epoch + 1}`, ...audit, "--execute").status).toBe(0);
  expect(cli("batch", "complete", "--draining-from=versioned", "--to=legacy", `--expect-epoch=${epoch + 1}`, ...audit, "--execute").status).toBe(0);
  expect(await control("job_batch_control")).toMatchObject({ mode: "legacy", draining_from: null, epoch: epoch + 2, writer_contract_version: 1 });
  expect((await ownAudit(auditBefore)).map(row => row.action)).toEqual(["pipeline-control-batch-policy", "pipeline-control-batch-contract",
    "pipeline-control-batch-drain", "pipeline-control-batch-complete", "pipeline-control-batch-drain", "pipeline-control-batch-complete"]);
}, 180_000);

it("reads status from the dedicated variable only and rejects URL arguments without echoing them", async () => {
  const status = cli("status");
  expect([status.status, status.stderr]).toEqual([0, ""]);
  expect(status.out?.snapshot).toMatchObject({ fence: { state: "active" }, batch: { mode: "legacy" }, capacity: { mode: "disabled" } });
  const url = cli("status", `--target=${TEST_DATABASE_URL}`);
  expect([url.status, url.stderr.trim(), url.out]).toEqual([1, JSON.stringify({ code: "pipeline_control_url_argument_rejected" }), null]);
  const missing = spawnSync(process.execPath, [...CLI, "status"], { encoding: "utf8", env: { ...env, PIPELINE_CONTROL_DATABASE_URL: "" }, timeout: 60_000 });
  expect([missing.status, missing.stderr.trim()]).toEqual([1, JSON.stringify({ code: "explicit_PIPELINE_CONTROL_DATABASE_URL_required" })]);
}, 120_000);

it("refuses AI2 → items in dry-run and --execute while its consumer would defer everything, allows it only with --allow-stalled-stage", async () => {
  await client`UPDATE pipeline_stage_modes SET mode = 'draining', draining_from = 'legacy', writer_contract_version = 1 WHERE stage = 'ai2'`;
  const { epoch } = await stage("ai2"), before = await controlRows(), auditBefore = await auditMax();
  const complete = ["stage", "complete", "--stage=ai2", "--draining-from=legacy", "--to=items", `--expect-epoch=${epoch}`, ...audit];
  const dry = cli(...complete);
  expect([dry.status, dry.stderr, dry.out?.dryRun, dry.out?.blocked, dry.out?.plan.blocked])
    .toEqual([3, "", true, true, ["items_consumer_defers:capacity_disabled:ai2"]]);
  const refused = cli(...complete, "--execute");
  expect([refused.status, refused.out?.executed, refused.out?.plan.blocked]).toEqual([3, false, ["items_consumer_defers:capacity_disabled:ai2"]]);
  expect([await controlRows(), await auditMax()]).toEqual([before, auditBefore]);

  const allowed = cli(...complete, "--allow-stalled-stage", "--execute");
  expect([allowed.status, allowed.stderr, allowed.out?.executed]).toEqual([0, "", true]);
  expect(allowed.out?.plan.warnings).toContain("items_consumer_defers:capacity_disabled:ai2");
  expect(await stage("ai2")).toEqual({ mode: "items", draining_from: null, epoch: epoch + 1, contract: 1 });
  expect((await ownAudit(auditBefore)).map(row => [row.action, (row.detail as { warnings: string[] }).warnings.includes("items_consumer_defers:capacity_disabled:ai2")]))
    .toEqual([["pipeline-control-stage-complete", true]]);

  // 되돌리는 쪽(items → draining → legacy)은 capacity가 닫혀 있어도 막지 않는다
  expect(cli("stage", "drain", "--stage=ai2", "--from-mode=items", `--expect-epoch=${epoch + 1}`, ...audit, "--execute").status).toBe(0);
  const back = cli("stage", "complete", "--stage=ai2", "--draining-from=items", "--to=legacy", `--expect-epoch=${epoch + 1}`, ...audit, "--execute");
  expect([back.status, back.out?.plan.blocked]).toEqual([0, []]);
  expect(await stage("ai2")).toEqual({ mode: "legacy", draining_from: null, epoch: epoch + 2, contract: 1 });
}, 180_000);

it("judges capacity open only on the (route, provider, model) combinations the stored review settings and model env use", async () => {
  const readSettings = async () => (await client`SELECT id, "values"::text AS "values", updated_by, updated_at::text AS updated_at
    FROM crawl_settings ORDER BY id`).map(row => ({ ...row }));
  const saved = await readSettings();
  const writeSettings = (values: unknown) => client`INSERT INTO crawl_settings (id, "values") VALUES (1, ${JSON.stringify(values)}::text::jsonb)
    ON CONFLICT (id) DO UPDATE SET "values" = excluded."values"`;
  const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { abcllm: 4, cli: 2 }, groupLimits: { gateway: 4, cli: 2 },
    poolLimits: { reviewer: 2, text: 2 }, weights: { first: 2, second: 1, background: 1 }, maxWaiting: 32, queueTtlMs: 60_000, reservationTtlMs: 30_000,
    routes: [{ routeId: "second-review", provider: "abcllm", model: "pr06d-ai2", providerBudgetId: "abcllm", groupId: "gateway" },
      { routeId: "reason-translate", provider: "abcllm", model: MODEL_ENV.ABCLLM_MODEL, providerBudgetId: "abcllm", groupId: "gateway" },
      { routeId: "second-review", provider: "grok-cli", model: "pr06d-grok", providerBudgetId: "cli", groupId: "cli" }] };
  try {
    await writeSettings({ firstReview: { provider: "abcllm", model: "pr06d-ai1" }, secondReview: { voters: [{ provider: "abcllm", model: "pr06d-ai2" }] } });
    const start = await control("model_capacity_control");
    const expect0 = [`--expect-epoch=${start.epoch}`, `--expect-revision=${start.revision}`];
    expect(cli("capacity", "policy", `--file=${policyFile("routes.json", policy)}`, "--from-mode=disabled", ...expect0, ...audit, "--execute").status).toBe(0);
    const expect1 = [`--expect-epoch=${start.epoch}`, `--expect-revision=${start.revision! + 1}`];
    expect(cli("capacity", "mode", "--to=draining", "--from-mode=disabled", ...expect1, ...audit, "--execute").status).toBe(0);
    const before = await controlRows(), auditBefore = await auditMax();

    const dry = cli("capacity", "mode", "--to=open", "--from-mode=draining", ...expect1, ...audit);
    const routes = dry.out?.plan.routes ?? [];
    const deferred = routes.filter(row => row.status !== "serving" && row.status !== "unused");
    // 실행 중인 감사가 있으면 그 행도 쓰는 조합이다(다른 파일이 남긴 감사에 기대지 않는다)
    expect(deferred.filter(row => row.routeId !== "product-audit")).toEqual([
      { routeId: "crawl-agent-review", provider: "abcllm", model: "pr06d-ai1", status: "unmapped" },
      { routeId: "second-review", provider: "abcllm", model: "pr06d-ai2", status: "no_contract" },
      { routeId: "product-search-profile", provider: "abcllm", model: MODEL_ENV.ABCLLM_PROFILE_MODEL, status: "unmapped" },
      { routeId: "product-search-verify", provider: "abcllm", model: MODEL_ENV.SEARCH_VERIFY_MODEL, status: "unmapped" },
      { routeId: "reason-translate", provider: "abcllm", model: MODEL_ENV.ABCLLM_MODEL, status: "no_contract" },
      { routeId: "product-translate", provider: "abcllm", model: MODEL_ENV.ABCLLM_MODEL, status: "unmapped" },
      { routeId: "product-tagline-ko", provider: "abcllm", model: MODEL_ENV.ABCLLM_MODEL, status: "unmapped" },
      { routeId: "search-query-translate", provider: "abcllm", model: MODEL_ENV.ABCLLM_MODEL, status: "unmapped" },
      { routeId: "crawl-tagline", provider: "abcllm", model: MODEL_ENV.ABCLLM_TAGLINE_MODEL, status: "unmapped" },
      { routeId: "product-intro-check", provider: "claude-cli", model: MODEL_ENV.INTRO_CHECK_MODEL, status: "unmapped" },
      { routeId: "second-review", provider: "legacy-job", model: null, status: "stage_legacy" },
    ]);
    expect(routes).toEqual(expect.arrayContaining([
      { routeId: "second-review", provider: "grok-cli", model: "pr06d-grok", status: "unused" },
      { routeId: "crawl-agent-review", provider: "grok-cli", model: null, status: "unused" },
      { routeId: "grok-session-check", provider: "grok-cli", model: null, status: "unused" },
    ]));
    expect([dry.status, dry.stderr, dry.out?.plan.blocked]).toEqual([3, "", [`deferred_routes:${deferred.length}`]]);

    // 설정을 읽을 수 없으면 심사 route는 미상이다 — 쓰는 조합을 모르므로 거절한다
    await writeSettings({ reviewConcurrency: 99 });
    const unreadable = cli("capacity", "mode", "--to=open", "--from-mode=draining", ...expect1, ...audit, "--execute");
    expect([unreadable.status, unreadable.out?.executed]).toEqual([3, false]);
    expect(unreadable.out?.plan.routes).toEqual(expect.arrayContaining([
      { routeId: "crawl-agent-review", provider: "unknown", model: null, status: "unknown" },
      { routeId: "second-review", provider: "unknown", model: null, status: "unknown" },
      { routeId: "second-review", provider: "abcllm", model: "pr06d-ai2", status: "unused" },
    ]));
    expect([await controlRows(), await auditMax()]).toEqual([before, auditBefore]);
  } finally {
    await client.begin(async tx => {
      await tx`DELETE FROM crawl_settings`;
      for (const row of saved) await tx`INSERT INTO crawl_settings (id, "values", updated_by, updated_at)
        VALUES (${row.id}, ${row.values}::jsonb, ${row.updated_by}, ${row.updated_at}::timestamp)`;
    });
  }
  expect(await readSettings()).toEqual(saved);
}, 180_000);
