import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { reviewCliArgs } from "@/lib/crawl/agent-review";
import { claudeCliTokenBound, type CliServingContract } from "@/lib/llm/cli-serving-contract";
import { prepareCliCall, readCliProcessTerminal, runReservedCliCall, settleCliNotStarted, type CliCallInput,
  type PreparedCliCall } from "@/lib/llm/cli-process-runner";
import { introCheckInputHash, introCheckLogicalWorkKey, modelCapacityPolicyHash, modelCapacityRequestIdentitySchema, type CliDispatchBinding,
  type CliModelDispatch, type IntroCheckMember, type ModelCapacityPolicy, type ModelCapacityRequestIdentity } from "@/lib/llm/capacity";
import { cancelReservedModelSlot, finishCliModelCapacityDispatch, lockCliModelCapacityDispatch, reconcileCliProcessTerminal, requestCliModelSlot,
  type CliTarget } from "@/lib/llm/capacity-repository";
import { opencodeTaskDispatchSql, opencodeTaskEventTerminalSql } from "@/lib/llm/opencode-task-binding-sql";
import { applied0168Rules, OPENCODE_TASK_FIX_TAG, OPENCODE_TASK_TAG } from "@/scripts/ops/generate-opencode-task-sql";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

/*
 * 0175(2026-11-11): OpenCode 발행분 감사(product_audit_cli)·소개 검수(intro_check_cli)가 실제 장부 길(requestCliModelSlot → lock → finishCliModelCapacityDispatch →
 * runner terminal → reconcileCliProcessTerminal)로 reserved → dispatched → settled 를 지나고 dispatch_settled 를 남기는지 실제 PostgreSQL(모든 마이그레이션)에서 본다.
 * 2026-11-09 부터 운영의 OpenCode 감사는 dispatched 로 가는 UPDATE 에서 23514(model_capacity_requests_dispatch_check)로 모두 거절됐다 — 0168 의 OpenCode 가지가
 * JSON 공급자 '"claude-cli"'::jsonb 를 그대로 두어서다. 같은 행을 0168 의 글(마이그레이션 파일)로 평가하면 거절되고 0175 의 글이면 받아들여짐도 여기서 본다.
 * 자식 프로세스는 tests/fixtures/fake-cli/fake.mjs(가짜 CLI)뿐이고 PATH 는 빈 디렉터리다 — 실제 opencode/claude·호스트·운영 resolver 는 쓰지 않는다.
 * OpenCode 의 운영 길은 M3 호스트(lib/operations/cli-task-runtime.ts)가 같은 runner·reconcileCliProcessTerminal 로 정산한다.
 */
const fixture = vi.hoisted(() => ({ contracts: [] as CliServingContract[] }));
vi.mock("@/lib/llm/cli-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/cli-serving-contract")>(),
  resolveCliServingContract: (routeId: string, provider: string, model: string) =>
    fixture.contracts.find(value => value.routeId === routeId && value.provider === provider && value.model === model) ?? null,
}));

type Provider = "opencode-cli" | "claude-cli";
type Row = Record<string, unknown> & { request_id: string; dispatch_binding: Record<string, unknown>; terminal_evidence: Record<string, unknown> | null };
const prefix = `oc-task-${randomUUID().slice(0, 8)}`, OPENCODE = "opencode-go/deepseek-v4.1-flash", CLAUDE = "sonnet";
const ROUTES = ["product-audit", "product-intro-check"] as const;
const admin = postgres(TEST_DATABASE_URL, { max: 2, prepare: false, onnotice: () => {}, connection: { application_name: prefix } });
const owner = { instanceId: `${prefix}-a`, bootId: randomUUID() };
const claudeShape = { maxTurns: 2, inputByteCap: 200_000, overheadTokenBound: 20_000, outputTokensPerTurn: 2_000 };
const contract = (routeId: string, provider: Provider): CliServingContract => provider === "claude-cli"
  ? { version: 1, protocol: "cli-process-v1", routeId, provider, model: CLAUDE, cliVersion: "fake 0.0.0", totalTokenBound: claudeCliTokenBound(claudeShape),
      costBoundUsdMicros: 150_000, boundProvenance: "derived", ...claudeShape }
  : { version: 1, protocol: "cli-process-v1", routeId, provider, model: OPENCODE, cliVersion: "fake 0.0.0", inputByteCap: 200_000, totalTokenBound: 200_000,
      costBoundUsdMicros: null, boundProvenance: "declared" };
const route = (routeId: string, provider: Provider, budget: string) =>
  ({ routeId, provider, model: provider === "claude-cli" ? CLAUDE : OPENCODE, providerBudgetId: budget, groupId: "reviewers" });
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 16, providerLimits: { "opencode-host": 8, "claude-sub": 8 }, groupLimits: { reviewers: 16 },
  poolLimits: { reviewer: 16, text: 1 }, weights: { first: 2, second: 2, background: 1 }, maxWaiting: 32, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: ROUTES.flatMap(id => [route(id, "opencode-cli", "opencode-host"), route(id, "claude-cli", "claude-sub")]) };
let root = "", bin = "", empty = "", records = "", originalControl: Record<string, unknown>;

beforeAll(async () => {
  ensureSchema();
  const journal = JSON.parse(readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string }[] };
  expect(journal.entries.map(entry => entry.tag)).toContain(OPENCODE_TASK_FIX_TAG);
  const [applied] = await admin`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  expect(applied.count).toBe(journal.entries.length);
  // 허가는 전체 활성 행을 센다 — 앞선 파일이 남긴 활성 호출이 있으면 이 파일의 결과가 달라진다
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE state IN ('waiting','reserved','dispatched','indeterminate')`).toHaveLength(0);
  [{ row: originalControl }] = await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`;
  fixture.contracts = ROUTES.flatMap(id => [contract(id, "opencode-cli"), contract(id, "claude-cli")]);
  root = await mkdtemp(path.join(os.tmpdir(), "nmv-opencode-task-ledger-"));
  empty = path.join(root, "empty-path"); records = path.join(root, "records"); await mkdir(empty); await mkdir(records);
  const fake = path.resolve("tests/fixtures/fake-cli/fake.mjs");
  for (const value of [root, fake, process.execPath]) expect(value).not.toContain("'");
  bin = path.join(root, "fake-cli"); await writeFile(bin, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`); await chmod(bin, 0o755);
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(policy)},
    cursor=0,updated_at=clock_timestamp() WHERE id=1`;
});
afterAll(async () => {
  try {
    await admin.begin(async tx => {
      await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
      const ids = (await tx`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id LIKE ${`${prefix}-%`} FOR UPDATE`).map(row => row.request_id);
      await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
      await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
      await tx`DELETE FROM model_capacity_events WHERE request_id=ANY(${ids}::uuid[])`;
      await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
      expect(Array.from(await tx`SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass
        AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate') ORDER BY tgname`))
        .toEqual([{ tgname: "model_capacity_events_no_change", tgenabled: "A" }, { tgname: "model_capacity_events_no_truncate", tgenabled: "A" }]);
      await tx`DELETE FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[])`;
      await tx`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,policy_hash=r.policy_hash,cursor=r.cursor,
        updated_at=r.updated_at FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalControl)}::text::jsonb) r WHERE c.id=r.id`;
      expect(await tx`SELECT 1 FROM model_capacity_requests WHERE owner_instance_id LIKE ${`${prefix}-%`}`).toHaveLength(0);
    });
  } finally {
    fixture.contracts = []; await rm(root, { recursive: true, force: true }); await admin.end();
  }
});

/** 운영 호스트가 쓰는 꼴의 호출 — OpenCode 는 `opencode run --model <모델>` 처럼 모델 하나를 싣고, Claude 는 감사 경로의 상한 플래그를 싣는다 */
function call(routeId: string, provider: Provider, mode: string, change: Partial<CliCallInput> = {}): PreparedCliCall {
  const isClaude = provider === "claude-cli", model = isClaude ? CLAUDE : OPENCODE;
  const input: CliCallInput = { routeId, provider, model, command: bin,
    args: isClaude ? reviewCliArgs(model) : ["run", "--model", model, "--format", "json"],
    stdin: `<untrusted_evidence_json>${randomUUID()}</untrusted_evidence_json>`, cwd: root,
    env: { PATH: empty, FAKE_CLI_MODE: mode, FAKE_CLI_RECORD: records, ...(isClaude ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "2000" } : {}) },
    boundEnvKeys: isClaude ? ["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] : [], timeoutMs: 5_000, maxStdoutBytes: 65_536, maxStderrBytes: 16_384, ...change };
  const prepared = prepareCliCall(input);
  if (prepared.kind !== "prepared") throw new Error(`fixture_contract_required:${provider}`);
  return prepared;
}
const charge = (value: PreparedCliCall) => ({ transport: value.transport, totalTokenBound: value.totalTokenBound, chargedTokens: value.totalTokenBound });
const job = <N extends string>(name: N) => ({ name, token: randomUUID(), requestedVersion: 1 });
const hex = () => createHash("sha256").update(randomUUID()).digest("hex");
type Case = Readonly<{ identity: ModelCapacityRequestIdentity; target: CliTarget; binding: CliDispatchBinding; call: PreparedCliCall }>;
const identity = (value: Omit<ModelCapacityRequestIdentity, "pool" | "owner">) => modelCapacityRequestIdentitySchema.parse({ ...value, owner, pool: "reviewer" });
function audit(itemId: number, provider: Provider, mode = "ok"): Case {
  const value = call("product-audit", provider, mode), model = value.transport.model, inputHash = hex();
  return { call: value, target: { kind: "audit", itemId },
    identity: identity({ workKey: `bg:audit:${itemId}:${inputHash}`, class: "background", routeId: "product-audit", provider, model }),
    binding: { kind: "product_audit_cli", version: 1, logicalWorkKey: `bg:audit:${itemId}`, itemId, campaignId: 3, productId: itemId + 500, slug: `p-${itemId}`,
      inputHash, promptVersion: "p1", rulesVersion: "r1", attempts: 0, provider, model, routeId: "product-audit", ...charge(value), job: job("product-audit") } };
}
function intro(productIds: number[], provider: Provider, mode = "ok"): Case {
  const value = call("product-intro-check", provider, mode), model = value.transport.model;
  const members: IntroCheckMember[] = productIds.map(productId => ({ productId, slug: `p-${productId}`, sourceHash: hex(), taglineSource: "ai_page",
    check: { kind: "absent" } }));
  const logical = introCheckLogicalWorkKey(members), inputHash = introCheckInputHash({ members, model });
  return { call: value, target: { kind: "intro", members },
    identity: identity({ workKey: `${logical}:${inputHash}`, class: "background", routeId: "product-intro-check", provider, model }),
    binding: { members, model, kind: "intro_check_cli", version: 1, logicalWorkKey: logical, inputHash, provider, routeId: "product-intro-check",
      ...charge(value), job: job("product-intro-check") } };
}
async function dispatched(value: Case): Promise<CliModelDispatch> {
  const slot = await requestCliModelSlot({ ...value.identity, requestId: randomUUID() }, value.target);
  if (slot.kind !== "granted") throw new Error(`fixture_slot_${slot.reason}`);
  return db.transaction(async tx => {
    const lock = await lockCliModelCapacityDispatch(tx, { reservation: slot.reservation, identity: value.identity, target: value.target });
    if (!lock) throw new Error("fixture_lock_required");
    return finishCliModelCapacityDispatch(tx, lock, value.binding);
  });
}
const ref = (dispatch: CliModelDispatch) => ({ requestId: dispatch.requestId, transport: dispatch.binding.transport });
async function row(requestId: string): Promise<Row> {
  return (await admin`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE request_id=${requestId}::uuid`)[0].row as Row;
}
async function events(requestId: string) {
  return Array.from(await admin`SELECT to_jsonb(e) AS row FROM model_capacity_events e WHERE request_id=${requestId}::uuid ORDER BY id`)
    .map(entry => entry.row as Record<string, unknown> & { kind: string; evidence: Record<string, unknown> | null });
}
/** 되돌리는 INSERT — 실제 SQLSTATE 와 제약 이름만 본다 */
async function attempt(table: "model_capacity_requests" | "model_capacity_events", value: Record<string, unknown>) {
  try {
    await admin.begin(async tx => {
      if (table === "model_capacity_requests") await tx`INSERT INTO model_capacity_requests SELECT (r).* FROM jsonb_populate_record(NULL::model_capacity_requests,
        ${JSON.stringify(value)}::text::jsonb || jsonb_build_object('queue_ordinal',nextval('model_capacity_requests_queue_ordinal_seq'))) r`;
      else await tx`INSERT INTO model_capacity_events SELECT (r).* FROM jsonb_populate_record(NULL::model_capacity_events,
        ${JSON.stringify(value)}::text::jsonb || jsonb_build_object('id',nextval('model_capacity_events_id_seq'))) r`;
      throw new Error("intentional_rollback");
    });
    return "committed";
  } catch (error) {
    const pg = error as { code?: string; constraint_name?: string; message?: string };
    return pg.message === "intentional_rollback" ? "inserted" : `${pg.code}:${pg.constraint_name}`;
  }
}

/** reserved → dispatched → settled(실제 runner terminal) 와 사건 넷, 그리고 공급자·transport·근거가 행의 binding 과 같은지 */
async function settles(value: Case, ending: "exited" | "not_started") {
  const dispatch = await dispatched(value);
  expect(await row(dispatch.requestId)).toMatchObject({ state: "dispatched", provider: value.identity.provider, dispatch_binding_hash: dispatch.bindingHash,
    dispatch_binding: { kind: value.binding.kind, provider: value.identity.provider, transport: { provider: value.identity.provider } } });
  const outcome = ending === "not_started" ? { terminal: settleCliNotStarted(value.call, ref(dispatch)), indeterminate: null }
    : await runReservedCliCall(value.call, ref(dispatch));
  expect(outcome.indeterminate).toBeNull();
  expect(readCliProcessTerminal(outcome.terminal)?.ending).toBe(ending);
  expect(await reconcileCliProcessTerminal(outcome.terminal!)).toEqual({ kind: "settled" });
  expect(await reconcileCliProcessTerminal(outcome.terminal!)).toEqual({ kind: "already_settled" });
  const stored = await row(dispatch.requestId);
  expect(stored).toMatchObject({ state: "settled", terminal_evidence: { kind: "cli_model_terminal",
    dispatch: { requestId: dispatch.requestId, bindingHash: dispatch.bindingHash, binding: { provider: value.identity.provider } },
    process: { ending, requestId: dispatch.requestId, transport: { provider: value.identity.provider } } } });
  const recorded = await events(dispatch.requestId);
  expect(recorded.map(event => event.kind)).toEqual(["queued", "reserved", "dispatch_started", "dispatch_settled"]);
  expect(recorded.at(-1)).toMatchObject({ from_state: "dispatched", to_state: "settled", evidence: stored.terminal_evidence });
  return { dispatch, stored, settledEvent: recorded.at(-1)! };
}

it("OpenCode product_audit_cli goes reserved → dispatched → settled and records dispatch_settled (exited and not_started)", async () => {
  await settles(audit(7101, "opencode-cli"), "exited");
  await settles(audit(7102, "opencode-cli"), "not_started");
}, 30_000);

it("OpenCode intro_check_cli goes reserved → dispatched → settled and records dispatch_settled (exited and not_started)", async () => {
  const { stored } = await settles(intro([7202, 7201], "opencode-cli"), "exited");
  expect(stored.logical_member_keys).toEqual(["intro:7201", "intro:7202"]);
  await settles(intro([7203], "opencode-cli"), "not_started");
}, 30_000);

it("Claude CLI audit and intro still pass the same path unchanged", async () => {
  await settles(audit(7301, "claude-cli"), "exited");
  await settles(intro([7302], "claude-cli"), "not_started");
}, 30_000);

it("still rejects malformed OpenCode bindings and evidence: provider, transport, route and shape must agree", async () => {
  const { stored, settledEvent } = await settles(audit(7401, "opencode-cli"), "not_started");
  const evidence = stored.terminal_evidence as { dispatch: Record<string, unknown>; process: Record<string, unknown> };
  const copyId = randomUUID();
  /** 정산된 행의 사본 — 활성 행이 아니라 논리 키 유일성에 걸리지 않는다. binding 을 바꾸면 terminal 근거의 binding 도 같이 바꾼다 */
  const copy = (binding: Record<string, unknown> = stored.dispatch_binding, over: Record<string, unknown> = {}) => ({ ...stored, request_id: copyId,
    terminal_evidence: { ...evidence, dispatch: { ...evidence.dispatch, requestId: copyId, binding }, process: { ...evidence.process, requestId: copyId } },
    dispatch_binding: binding, ...over });
  // control: 같은 모양의 사본은 들어간다
  expect(await attempt("model_capacity_requests", copy())).toBe("inserted");
  const binding = stored.dispatch_binding as Record<string, unknown> & { transport: Record<string, unknown> };
  for (const forged of [
    { ...binding, provider: "claude-cli" },
    { ...binding, provider: "claude-cli", transport: { ...binding.transport, provider: "claude-cli" } },
    { ...binding, transport: { ...binding.transport, provider: "claude-cli" } },
    { ...binding, transport: { ...binding.transport, provider: "codex-cli" } },
    { ...binding, model: "another/model" },
    { ...binding, routeId: "product-intro-check" },
    { ...binding, kind: "intro_check_cli" },
    { ...binding, chargedTokens: 1 },
    { ...binding, unexpected: true },
  ]) expect(await attempt("model_capacity_requests", copy(forged)), JSON.stringify(Object.keys(forged))).toBe("23514:model_capacity_requests_dispatch_check");
  // 행의 공급자가 binding 과 다르면(claude-cli 행에 OpenCode binding) 받아들이지 않는다
  expect(await attempt("model_capacity_requests", copy(binding, { provider: "claude-cli" }))).toMatch(/^23514:model_capacity_requests_(dispatch|logical)_check$/);
  // dispatch_settled 근거의 binding 공급자를 바꾸면 events terminal 이 거절한다
  const event = { ...settledEvent, id: undefined, created_at: new Date().toISOString() };
  for (const provider of ["claude-cli", "codex-cli"]) {
    const forgedEvidence = { ...evidence, dispatch: { ...evidence.dispatch, binding: { ...binding, provider } } };
    expect(await attempt("model_capacity_events", { ...event, evidence: forgedEvidence })).toBe("23514:model_capacity_events_terminal_check");
  }
});

it("the same OpenCode rows fail the applied 0168 predicates and pass the 0175 ones (Claude passes both)", async () => {
  const applied = applied0168Rules(readFileSync("drizzle/0168_opencode_task_cli.sql", "utf8"));
  const rules = await admin<{ table_name: string; constraint_name: string; ordinal: number; predicate: string; source: string }[]>`SELECT table_name,
    constraint_name, ordinal, predicate, source FROM model_capacity_check_rules WHERE constraint_name IN ('model_capacity_requests_dispatch_check',
    'model_capacity_events_terminal_check') ORDER BY constraint_name, ordinal`;
  const fixed = rules.filter(rule => rule.source === OPENCODE_TASK_FIX_TAG);
  expect(fixed.map(rule => [rule.constraint_name, rule.predicate])).toEqual([
    ["model_capacity_events_terminal_check", opencodeTaskEventTerminalSql], ["model_capacity_requests_dispatch_check", opencodeTaskDispatchSql]]);
  expect(rules.filter(rule => rule.source === OPENCODE_TASK_TAG)).toEqual([]);
  /** CHECK 의미(FALSE 만 거절, NULL 은 통과)로 한 제약의 모든 ordinal 을 OR — legacy 면 0175 행 자리에 0168 이 넣은 글을 둔다 */
  const verdict = async (name: string, value: Record<string, unknown>, legacy: boolean) => {
    const table = name.startsWith("model_capacity_events") ? "model_capacity_events" : "model_capacity_requests";
    const leaves = rules.filter(rule => rule.constraint_name === name)
      .map(rule => `(${legacy && rule.source === OPENCODE_TASK_FIX_TAG ? applied[name] : rule.predicate})`);
    const [{ ok }] = await admin.unsafe<{ ok: boolean }[]>(`SELECT coalesce((${leaves.join(" OR ")}),true) AS ok
      FROM jsonb_populate_record(NULL::${table}, $1::text::jsonb) AS ${table}`, [JSON.stringify(value)]);
    return ok;
  };
  for (const [value, provider] of [[audit(7501, "opencode-cli"), "opencode-cli"], [intro([7502], "opencode-cli"), "opencode-cli"],
    [audit(7503, "claude-cli"), "claude-cli"]] as const) {
    const { dispatch, stored, settledEvent } = await settles(value, "not_started");
    const live = { ...stored, state: "dispatched", terminal_evidence: null, terminal_evidence_hash: null, settled_at: null };
    expect(dispatch.binding.provider).toBe(provider);
    for (const sample of [live, stored]) {
      expect(await verdict("model_capacity_requests_dispatch_check", sample, false), `${provider} ${sample.state}: 0175`).toBe(true);
      expect(await verdict("model_capacity_requests_dispatch_check", sample, true), `${provider} ${sample.state}: 0168`).toBe(provider === "claude-cli");
    }
    expect(await verdict("model_capacity_events_terminal_check", settledEvent, false), `${provider} dispatch_settled: 0175`).toBe(true);
    expect(await verdict("model_capacity_events_terminal_check", settledEvent, true), `${provider} dispatch_settled: 0168`).toBe(provider === "claude-cli");
  }
}, 30_000);

it("a reservation released before dispatch still withdraws cleanly for OpenCode (no dispatch_started event)", async () => {
  const value = audit(7601, "opencode-cli");
  const slot = await requestCliModelSlot({ ...value.identity, requestId: randomUUID() }, value.target);
  if (slot.kind !== "granted") throw new Error("fixture_slot");
  expect(await cancelReservedModelSlot(slot.reservation)).toBe(true);
  expect((await row(slot.reservation.requestId)).state).toBe("withdrawn");
  expect((await events(slot.reservation.requestId)).map(event => event.kind)).not.toContain("dispatch_started");
});
