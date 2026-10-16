import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { reviewCliArgs } from "@/lib/crawl/agent-review";
import { itemBindingHash, type ItemBinding } from "@/lib/jobs/items/types";
import { claudeCliTokenBound, type CliServingContract } from "@/lib/llm/cli-serving-contract";
import { prepareCliCall, runReservedCliCall, settleCliNotStarted, readCliProcessTerminal, type CliCallInput,
  type PreparedCliCall } from "@/lib/llm/cli-process-runner";
import { modelCapacityPolicyHash, modelCapacityRequestIdentitySchema, introCheckLogicalWorkKey, introCheckInputHash, grokSessionLogicalWorkKey,
  grokSessionInputHash, type CliDispatchBinding, type CliModelDispatch, type IntroCheckMember, type ModelCapacityPolicy,
  type ModelCapacityRequestIdentity } from "@/lib/llm/capacity";
import { requestCliModelSlot, lockCliModelCapacityDispatch, finishCliModelCapacityDispatch, reconcileCliProcessTerminal,
  markModelDispatchIndeterminate, requestAi1ModelSlot, requestAi2ItemModelSlot, cancelReservedModelSlot, requestModelSlot, beginModelDispatch,
  type CliTarget } from "@/lib/llm/capacity-repository";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

/*
 * 실제 PostgreSQL + 실제 runner. 자식 프로세스는 tests/fixtures/fake-cli/fake.mjs(가짜 CLI)뿐이고 PATH 는 빈 디렉터리다 — 실제
 * claude/grok/codex·provider·운영 resolver 는 쓰지 않는다. CLI 계약은 이 파일의 fixture 만 연다.
 */
const fixture = vi.hoisted(() => ({ contracts: [] as CliServingContract[] }));
vi.mock("@/lib/llm/cli-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/cli-serving-contract")>(),
  resolveCliServingContract: (routeId: string, provider: string, model: string) =>
    fixture.contracts.find(value => value.routeId === routeId && value.provider === provider && value.model === model) ?? null,
}));

const prefix = `cli-ledger-${randomUUID().slice(0, 8)}`, sha = "a".repeat(64), other = "b".repeat(64);
const admin = postgres(TEST_DATABASE_URL, { max: 2, prepare: false, onnotice: () => {}, connection: { application_name: prefix } });
const ownerA = { instanceId: `${prefix}-a`, bootId: randomUUID() }, ownerB = { instanceId: `${prefix}-b`, bootId: randomUUID() };
const ROUTES = ["crawl-agent-review", "second-review", "product-audit", "product-intro-check", "grok-session-check"];
const claudeShape = { maxTurns: 2, inputByteCap: 200_000, overheadTokenBound: 20_000, outputTokensPerTurn: 2_000 };
const claude = (routeId: string): CliServingContract => ({ version: 1, protocol: "cli-process-v1", routeId, provider: "claude-cli", model: "sonnet",
  cliVersion: "fake 0.0.0", totalTokenBound: claudeCliTokenBound(claudeShape), costBoundUsdMicros: 150_000, boundProvenance: "derived", ...claudeShape });
const grok = (routeId: string): CliServingContract => ({ version: 1, protocol: "cli-process-v1", routeId, provider: "grok-cli", model: "grok-4",
  cliVersion: "fake 0.0.0", inputByteCap: 200_000, totalTokenBound: 300_000, costBoundUsdMicros: null, boundProvenance: "declared" });
const route = (routeId: string, provider: string, model: string, providerBudgetId: string) => ({ routeId, provider, model, providerBudgetId, groupId: "reviewers" });
// D8: provider budget 은 계정 단위. 한도 시험만 별도 계정(claude-limit)을 쓴다
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 16, providerLimits: { "claude-sub": 8, "grok-sub": 8, abcllm: 8, "claude-limit": 2 },
  groupLimits: { reviewers: 16 }, poolLimits: { reviewer: 16, text: 1 }, weights: { first: 2, second: 2, background: 1 }, maxWaiting: 32,
  queueTtlMs: 60_000, reservationTtlMs: 60_000, routes: [
    route("crawl-agent-review", "abcllm", "gw-model", "abcllm"), route("second-review", "abcllm", "gw-model", "abcllm"),
    ...["crawl-agent-review", "second-review", "product-audit", "product-intro-check"].map(id => route(id, "claude-cli", "sonnet", "claude-sub")),
    ...["crawl-agent-review", "second-review", "grok-session-check"].map(id => route(id, "grok-cli", "grok-4", "grok-sub")),
    ...["crawl-agent-review", "product-audit", "product-intro-check"].map(id => route(id, "claude-cli", "sonnet-limit", "claude-limit"))] };
let root = "", bin = "", empty = "", records = "", originalControl: Record<string, unknown>;

beforeAll(async () => {
  ensureSchema();
  const journal = JSON.parse(readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  expect(journal.entries.map((entry: { tag: string }) => entry.tag)).toContain("0094_model_capacity_cli_process_terminal");
  const [applied] = await admin`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  expect(applied.count).toBe(journal.entries.length);
  const indexes = await admin`SELECT indexname FROM pg_indexes WHERE schemaname='public'
    AND indexname IN ('model_capacity_requests_ai1_cli_item_claim_idx','model_capacity_requests_ai2_cli_claim_idx') ORDER BY indexname`;
  expect(indexes.map(row => row.indexname)).toEqual(["model_capacity_requests_ai1_cli_item_claim_idx", "model_capacity_requests_ai2_cli_claim_idx"]);
  expect(await admin`SELECT 1 FROM model_capacity_requests`).toHaveLength(0); expect(await admin`SELECT 1 FROM model_capacity_events`).toHaveLength(0);
  [{ row: originalControl }] = await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`;
  expect(originalControl).toMatchObject({ mode: "disabled", policy: null });
  fixture.contracts = [claude("crawl-agent-review"), claude("second-review"), claude("product-audit"), claude("product-intro-check"),
    grok("crawl-agent-review"), grok("second-review"), grok("grok-session-check")];
  root = await mkdtemp(path.join(os.tmpdir(), "nmv-cli-ledger-"));
  empty = path.join(root, "empty-path"); records = path.join(root, "records"); await mkdir(empty); await mkdir(records);
  const fake = path.resolve("tests/fixtures/fake-cli/fake.mjs");
  for (const value of [root, fake, process.execPath]) expect(value).not.toContain("'");
  bin = path.join(root, "fake-cli"); await writeFile(bin, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`); await chmod(bin, 0o755);
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(policy)},
    cursor=0,updated_at=clock_timestamp() WHERE id=1`;
  console.info("cli_ledger_migrations", { journal: journal.entries.length, applied: applied.count, indexes: indexes.length });
});
afterAll(async () => {
  try {
    await admin.begin(async tx => {
      await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
      const ids = (await tx`SELECT request_id FROM model_capacity_requests WHERE route_id=ANY(${ROUTES}) FOR UPDATE`).map(row => row.request_id);
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
      expect(await tx`SELECT 1 FROM model_capacity_requests`).toHaveLength(0); expect(await tx`SELECT 1 FROM model_capacity_events`).toHaveLength(0);
    });
  } finally {
    fixture.contracts = []; await rm(root, { recursive: true, force: true }); await admin.end();
  }
});

function call(routeId: string, provider: "claude-cli" | "grok-cli", mode: string, change: Partial<CliCallInput> = {}): PreparedCliCall {
  const isClaude = provider === "claude-cli", model = isClaude ? "sonnet" : "grok-4";
  const input: CliCallInput = { routeId, provider, model, command: bin,
    args: isClaude ? reviewCliArgs(model) : ["-p", "Reply with the single word OK.", "-m", model, "--output-format", "json"],
    stdin: isClaude ? `<untrusted_evidence_json>${randomUUID()}</untrusted_evidence_json>` : null, cwd: root,
    env: { PATH: empty, FAKE_CLI_MODE: mode, FAKE_CLI_RECORD: records, ...(isClaude ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "2000" } : {}) },
    boundEnvKeys: isClaude ? ["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] : [], timeoutMs: 5_000, maxStdoutBytes: 65_536, maxStderrBytes: 16_384, ...change };
  const prepared = prepareCliCall(input);
  if (prepared.kind !== "prepared") throw new Error("fixture_contract_required");
  return prepared;
}
const charge = (value: PreparedCliCall) => ({ transport: value.transport, totalTokenBound: value.totalTokenBound, chargedTokens: value.totalTokenBound });
const job = <N extends string>(name: N) => ({ name, token: randomUUID(), requestedVersion: 1 });
const hex = () => createHash("sha256").update(randomUUID()).digest("hex");
type Case = Readonly<{ identity: ModelCapacityRequestIdentity; target: CliTarget; binding: CliDispatchBinding; call: PreparedCliCall }>;
const identity = (value: Omit<ModelCapacityRequestIdentity, "pool">) => modelCapacityRequestIdentitySchema.parse({ ...value, pool: "reviewer" });
const reviewer = (value: PreparedCliCall) => ({ provider: value.transport.provider as "claude-cli" | "grok-cli", model: value.transport.model });
let attempts = 7000;
function ai1(candidateId: number, value: PreparedCliCall, owner = ownerA): Case {
  const { provider, model } = reviewer(value);
  return { call: value, target: { kind: "ai1", candidateId },
    identity: identity({ owner, workKey: `ai1:${candidateId}:${hex()}`, class: "first", routeId: "crawl-agent-review", provider, model }),
    binding: { kind: "ai1_legacy_cli", version: 1, logicalWorkKey: `ai1:${candidateId}`, candidateId, attemptId: ++attempts, inputHash: sha,
      sourceRevisionHash: other, reviewPolicyHash: sha, promptVersion: "p1", rulesVersion: "r1", provider, model, routeId: "crawl-agent-review",
      stageEpoch: 1, ...charge(value), job: job("crawl-agent-review") } };
}
function ai2(candidateId: number, secondReviewId: number, value: PreparedCliCall, owner = ownerA): Case {
  const { provider, model } = reviewer(value);
  const review: Extract<ItemBinding, { stage: "ai2" }> = { stage: "ai2", secondReviewId, candidateId, source: { kind: "first_attempt", firstAttemptId: 5 },
    inputHash: sha, sourceRevisionHash: other, policyHash: sha, promptVersion: "p1", rulesVersion: "r1", reviewer: { provider, model },
    generationKey: other, vote: secondReviewId, fallbackForId: null };
  const item = { workKey: `ai2:${secondReviewId}`, owner, token: randomUUID(), stageEpoch: 1, itemEpoch: 1, bindingHash: itemBindingHash(review) };
  const logical = `ai2:${candidateId}:${secondReviewId}`;
  return { call: value, target: { kind: "ai2", candidateId, vote: secondReviewId },
    identity: identity({ owner, workKey: `${logical}:${item.bindingHash}`, class: "second", routeId: "second-review", provider, model }),
    binding: { kind: "ai2_item_cli", version: 1, logicalWorkKey: logical, review, rowIdentityHash: sha, failureCount: 0, inputPolicyHash: other,
      item, routeId: "second-review", provider, model, ...charge(value) } };
}
function audit(itemId: number, value: PreparedCliCall, owner = ownerA, model = value.transport.model): Case {
  const inputHash = hex();
  return { call: value, target: { kind: "audit", itemId },
    identity: identity({ owner, workKey: `bg:audit:${itemId}:${inputHash}`, class: "background", routeId: "product-audit", provider: "claude-cli", model }),
    binding: { kind: "product_audit_cli", version: 1, logicalWorkKey: `bg:audit:${itemId}`, itemId, campaignId: 3, productId: itemId + 500, slug: `p-${itemId}`,
      inputHash, promptVersion: "p1", rulesVersion: "r1", attempts: 0, provider: "claude-cli", model, routeId: "product-audit",
      ...charge(value), job: job("product-audit") } };
}
function intro(productIds: number[], value: PreparedCliCall, owner = ownerA, model = value.transport.model): Case {
  const members: IntroCheckMember[] = productIds.map(productId => ({ productId, slug: `p-${productId}`, sourceHash: hex(), taglineSource: "ai_page",
    check: { kind: "absent" } }));
  const logical = introCheckLogicalWorkKey(members), inputHash = introCheckInputHash({ members, model });
  return { call: value, target: { kind: "intro", members },
    identity: identity({ owner, workKey: `${logical}:${inputHash}`, class: "background", routeId: "product-intro-check", provider: "claude-cli", model }),
    binding: { members, model, kind: "intro_check_cli", version: 1, logicalWorkKey: logical, inputHash, provider: "claude-cli", routeId: "product-intro-check",
      ...charge(value), job: job("product-intro-check") } };
}
function grokSession(value: PreparedCliCall, owner = ownerA): Case {
  const model = value.transport.model, logical = grokSessionLogicalWorkKey(owner.instanceId), inputHash = grokSessionInputHash({ instanceId: owner.instanceId, model });
  return { call: value, target: { kind: "grok-session", instanceId: owner.instanceId },
    identity: identity({ owner, workKey: `${logical}:${inputHash}`, class: "background", routeId: "grok-session-check", provider: "grok-cli", model }),
    binding: { instanceId: owner.instanceId, model, kind: "grok_session_cli", version: 1, logicalWorkKey: logical, inputHash, provider: "grok-cli",
      routeId: "grok-session-check", ...charge(value), job: job("grok-session-check") } };
}
async function granted(value: Case, requestId = randomUUID()) {
  const slot = await requestCliModelSlot({ ...value.identity, requestId }, value.target);
  if (slot.kind !== "granted") throw new Error(`fixture_slot_${slot.reason}`);
  return slot.reservation;
}
async function dispatched(value: Case): Promise<CliModelDispatch> {
  const reservation = await granted(value);
  return db.transaction(async tx => {
    const lock = await lockCliModelCapacityDispatch(tx, { reservation, identity: value.identity, target: value.target });
    if (!lock) throw new Error("fixture_lock_required");
    return finishCliModelCapacityDispatch(tx, lock, value.binding);
  });
}
const ref = (dispatch: CliModelDispatch) => ({ requestId: dispatch.requestId, transport: dispatch.binding.transport });
async function row(requestId: string) {
  return (await admin`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE request_id=${requestId}::uuid`)[0]?.row as postgres.Row | undefined;
}
async function events(requestId: string) {
  return Array.from(await admin`SELECT kind,reason FROM model_capacity_events WHERE request_id=${requestId}::uuid ORDER BY id`);
}
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** 되돌리는 INSERT — 실제 SQLSTATE 와 제약 이름만 본다 */
async function attempt(table: "model_capacity_requests" | "model_capacity_events", value: Record<string, unknown>, text = JSON.stringify(value)) {
  try {
    await admin.begin(async tx => {
      if (table === "model_capacity_requests") await tx`INSERT INTO model_capacity_requests SELECT (r).* FROM jsonb_populate_record(NULL::model_capacity_requests,
        ${text}::text::jsonb || jsonb_build_object('queue_ordinal',nextval('model_capacity_requests_queue_ordinal_seq'))) r`;
      else await tx`INSERT INTO model_capacity_events SELECT (r).* FROM jsonb_populate_record(NULL::model_capacity_events,
        ${text}::text::jsonb || jsonb_build_object('id',nextval('model_capacity_events_id_seq'))) r`;
      throw new Error("intentional_rollback");
    });
    return "committed";
  } catch (error) {
    const pg = error as { code?: string; constraint_name?: string; message?: string };
    return pg.message === "intentional_rollback" ? "inserted" : `${pg.code}:${pg.constraint_name}`;
  }
}

it("lets exactly one of two backends own an AI1 candidate across gateway and CLI transports while a control holder blocks both", async () => {
  const gateway = { requestId: randomUUID(), workKey: `ai1:4101:${hex()}`, owner: ownerB, class: "first" as const, pool: "reviewer" as const,
    routeId: "crawl-agent-review", provider: "abcllm", model: "gw-model" };
  const cli = ai1(4101, call("crawl-agent-review", "claude-cli", "ok"));
  const held = latch(), locked = latch();
  const holder = admin.begin(async tx => { await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`; locked.resolve(); await held.promise; });
  await locked.promise;
  const racing = Promise.all([requestAi1ModelSlot(gateway, 4101), requestCliModelSlot({ ...cli.identity, requestId: randomUUID() }, cli.target)]);
  let waiting = 0;
  try {
    for (let i = 0; i < 300 && waiting < 2; i++) {
      [{ waiting }] = await admin`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query LIKE '%model_capacity_control%' AND application_name<>${prefix}`;
      if (waiting < 2) await sleep(10);
    }
  } finally { held.resolve(); await holder; }
  expect(waiting).toBe(2);
  const results = await racing;
  expect(results.map(result => result.kind).sort()).toEqual(["deferred", "granted"]);
  expect(results.find(result => result.kind === "deferred")).toEqual({ kind: "deferred", reason: "capacity" });
  const [winnerRow, ...rest] = await admin`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE logical_work_key='ai1:4101' ORDER BY queue_ordinal`;
  expect(rest).toHaveLength(0); expect(winnerRow.row.state).toBe("reserved");
  // 장부 fence 를 건너뛴 직접 INSERT 도 DB 가 막는다: 한 논리 키에 활성 행은 transport 와 무관하게 하나다
  const swapped = winnerRow.row.provider === "abcllm" ? { provider: "claude-cli", model: "sonnet" } : { provider: "abcllm", model: "gw-model" };
  expect(await attempt("model_capacity_requests", { ...winnerRow.row, ...swapped, request_id: randomUUID(), owner_boot_id: randomUUID() }))
    .toBe("23505:model_capacity_requests_logical_active_idx");
  for (const result of results) if (result.kind === "granted") expect(await cancelReservedModelSlot(result.reservation)).toBe(true);
  // 반대 순서: CLI 가 먼저면 gateway 가 미뤄진다
  const first = await granted(cli);
  expect(await requestAi1ModelSlot({ ...gateway, requestId: randomUUID() }, 4101)).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await cancelReservedModelSlot(first)).toBe(true);
  // AI2 의 한 표도 transport 를 넘어 하나만 활성이다
  const vote = ai2(4102, 4202, call("second-review", "grok-cli", "ok"));
  const pair = await Promise.all([requestAi2ItemModelSlot({ requestId: randomUUID(), workKey: `ai2:4102:4202:${hex()}`, owner: ownerB, class: "second",
    pool: "reviewer", routeId: "second-review", provider: "abcllm", model: "gw-model" }, { candidateId: 4102, vote: 4202 }),
  requestCliModelSlot({ ...vote.identity, requestId: randomUUID() }, vote.target)]);
  expect(pair.map(result => result.kind).sort()).toEqual(["deferred", "granted"]);
  for (const result of pair) if (result.kind === "granted") expect(await cancelReservedModelSlot(result.reservation)).toBe(true);
});

it("settles every physical ending from the real runner terminal, frees the slot, and treats the same terminal as idempotent", async () => {
  const cases = [
    { ending: "exited", value: ai2(4301, 4401, call("second-review", "grok-cli", "ok")), skip: false },
    { ending: "killed", value: intro([4502, 4501], call("product-intro-check", "claude-cli", "hang", { timeoutMs: 300 })), skip: false },
    { ending: "spawn_failed", value: grokSession(call("grok-session-check", "grok-cli", "ok", { command: path.join(root, "missing-cli") })), skip: false },
    { ending: "not_started", value: ai1(4601, call("crawl-agent-review", "claude-cli", "ok")), skip: true },
    { ending: "exited", value: audit(4701, call("product-audit", "claude-cli", "ok")), skip: false },
  ] as const;
  for (const { ending, value, skip } of cases) {
    const dispatch = await dispatched(value);
    expect((await row(dispatch.requestId))).toMatchObject({ state: "dispatched", dispatch_binding_hash: dispatch.bindingHash });
    const outcome = skip ? { terminal: settleCliNotStarted(value.call, ref(dispatch)), indeterminate: null } : await runReservedCliCall(value.call, ref(dispatch));
    expect(outcome.indeterminate).toBeNull();
    expect(readCliProcessTerminal(outcome.terminal)?.ending).toBe(ending);
    expect(await reconcileCliProcessTerminal(outcome.terminal!)).toEqual({ kind: "settled" });
    expect(await reconcileCliProcessTerminal(outcome.terminal!)).toEqual({ kind: "already_settled" });
    const stored = (await row(dispatch.requestId))!;
    expect(stored).toMatchObject({ state: "settled", terminal_evidence: { kind: "cli_model_terminal",
      dispatch: { requestId: dispatch.requestId, bindingHash: dispatch.bindingHash }, process: { ending, requestId: dispatch.requestId } } });
    expect((await events(dispatch.requestId)).map(event => event.kind)).toEqual(["queued", "reserved", "dispatch_started", "dispatch_settled"]);
    // 정산된 호출은 점유를 놓는다 — 같은 대상의 새 요청(다른 boot)이 곧바로 자리를 얻는다
    const again = await requestCliModelSlot({ ...value.identity, owner: { ...value.identity.owner, bootId: randomUUID() }, requestId: randomUUID() }, value.target);
    expect(again.kind).toBe("granted");
    if (again.kind === "granted") expect(await cancelReservedModelSlot(again.reservation)).toBe(true);
  }
}, 30_000);

it("settles only a terminal whose request, transport and C equal the stored dispatch; JSON copies and forged rows have no authority", async () => {
  const value = audit(4801, call("product-audit", "claude-cli", "ok")), dispatch = await dispatched(value);
  // 다른 입력(stdin)으로 준비한 호출이 같은 requestId 로 낸 terminal: runner 는 자기 transport 로 내지만 장부의 dispatch 와 다르다
  const foreign = call("product-audit", "claude-cli", "ok");
  expect(foreign.transport.inputHash).not.toBe(dispatch.binding.transport.inputHash);
  const forged = settleCliNotStarted(foreign, { requestId: dispatch.requestId, transport: foreign.transport });
  await expect(reconcileCliProcessTerminal(forged!)).rejects.toThrow("cli_process_terminal_binding_mismatch");
  await expect(reconcileCliProcessTerminal(JSON.parse(JSON.stringify(forged)))).rejects.toThrow("invalid_cli_process_terminal");
  expect(await row(dispatch.requestId)).toMatchObject({ state: "dispatched", terminal_evidence: null });
  expect((await events(dispatch.requestId)).map(event => event.kind)).toEqual(["queued", "reserved", "dispatch_started"]);
  // runner 는 한 프로세스에서 requestId 하나에 terminal 하나만 낸다 — 위조 terminal 이 그 자리를 쓰면 원래 호출도 더는 못 낸다(점유 유지)
  expect(() => settleCliNotStarted(value.call, ref(dispatch))).toThrow("cli_call_mismatch");
  // 원래 호출의 terminal 만 정산하고, prepared 는 한 번만 쓴다(one-use)
  const own = audit(4802, call("product-audit", "claude-cli", "ok")), ownDispatch = await dispatched(own);
  const outcome = await runReservedCliCall(own.call, ref(ownDispatch));
  expect(await reconcileCliProcessTerminal(outcome.terminal!)).toEqual({ kind: "settled" });
  await expect(runReservedCliCall(own.call, ref(ownDispatch))).rejects.toThrow("cli_call_mismatch");
  const settled = (await row(ownDispatch.requestId))!, evidence = settled.terminal_evidence, copyId = randomUUID();
  // 저장소에 손으로 쓴 정산 JSON 도 요청·transport·C·종료 모양이 dispatch 와 다르면 DB 가 거절한다(같은 모양의 사본은 control 로 들어간다)
  const copy = { ...settled, request_id: copyId, terminal_evidence: { ...evidence, dispatch: { ...evidence.dispatch, requestId: copyId },
    process: { ...evidence.process, requestId: copyId } } };
  expect(await attempt("model_capacity_requests", copy)).toBe("inserted");
  for (const change of [{ transport: { ...evidence.process.transport, argvHash: other } }, { totalTokenBound: evidence.process.totalTokenBound + 1 },
    { requestId: dispatch.requestId }, { ending: "not_started" }, { ending: "killed", killReason: null }, { kind: "ai1_gateway_terminal" }])
    expect(await attempt("model_capacity_requests", { ...copy, terminal_evidence: { ...copy.terminal_evidence, process: { ...copy.terminal_evidence.process, ...change } } }))
      .toBe("23514:model_capacity_requests_terminal_check");
  expect(await attempt("model_capacity_events", { request_id: ownDispatch.requestId, kind: "dispatch_settled", epoch: settled.epoch, revision: settled.revision,
    policy_hash: settled.policy_hash, from_state: "dispatched", to_state: "settled", reason: null,
    evidence: { ...evidence, process: { ...evidence.process, transport: { ...evidence.process.transport, timeoutMs: 1 } } }, created_at: new Date().toISOString() }))
    .toBe("23514:model_capacity_events_terminal_check");
});

it("commits the dispatch CAS with its event and the settlement with its event atomically", async () => {
  const value = ai2(4901, 5001, call("second-review", "claude-cli", "ok")), reservation = await granted(value);
  await expect(db.transaction(async tx => {
    const lock = await lockCliModelCapacityDispatch(tx, { reservation, identity: value.identity, target: value.target });
    await finishCliModelCapacityDispatch(tx, lock!, value.binding);
    throw new Error("rollback_after_finish");
  })).rejects.toThrow("rollback_after_finish");
  expect(await row(reservation.requestId)).toMatchObject({ state: "reserved", dispatch_binding: null, dispatched_at: null });
  expect((await events(reservation.requestId)).map(event => event.kind)).toEqual(["queued", "reserved"]);
  const dispatch = await db.transaction(async tx => finishCliModelCapacityDispatch(tx,
    (await lockCliModelCapacityDispatch(tx, { reservation, identity: value.identity, target: value.target }))!, value.binding));
  const outcome = await runReservedCliCall(value.call, ref(dispatch));
  const fn = `pr05c3_fail_settle_${prefix.replaceAll("-", "_")}`;
  await admin.unsafe(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.kind='dispatch_settled' AND NEW.request_id='${dispatch.requestId}'::uuid THEN RAISE EXCEPTION 'pr05c3_injected_event_failure'; END IF; RETURN NEW; END $$`);
  try {
    await admin.unsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON model_capacity_events FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
    const failed = await reconcileCliProcessTerminal(outcome.terminal!).then(() => null, (error: Error & { cause?: Error }) => error);
    expect(String(failed?.cause?.message ?? failed?.message)).toContain("pr05c3_injected_event_failure");
    expect(await row(dispatch.requestId)).toMatchObject({ state: "dispatched", terminal_evidence: null, settled_at: null });
    expect((await events(dispatch.requestId)).map(event => event.kind)).toEqual(["queued", "reserved", "dispatch_started"]);
  } finally {
    await admin.unsafe(`DROP TRIGGER IF EXISTS ${fn} ON model_capacity_events`); await admin.unsafe(`DROP FUNCTION IF EXISTS public.${fn}()`);
  }
  expect(await reconcileCliProcessTerminal(outcome.terminal!)).toEqual({ kind: "settled" });
  expect((await events(dispatch.requestId)).map(event => event.kind)).toEqual(["queued", "reserved", "dispatch_started", "dispatch_settled"]);
});

it("keeps a process_exit call occupying its candidate with one event, fencing a new boot and the gateway transport", async () => {
  const value = ai1(5101, call("crawl-agent-review", "grok-cli", "grandchild-hold")), dispatch = await dispatched(value);
  const outcome = await runReservedCliCall(value.call, ref(dispatch));
  const grandchildren = await Promise.all((await readdir(records)).map(async name => JSON.parse(await readFile(path.join(records, name), "utf8")).grandchild as number | undefined));
  try {
    expect(outcome).toMatchObject({ terminal: null, indeterminate: "process_exit" });
    expect(await markModelDispatchIndeterminate(dispatch, outcome.indeterminate!)).toBe(true);
    expect(await markModelDispatchIndeterminate(dispatch, "process_exit")).toBe(true);
    expect(await events(dispatch.requestId)).toEqual([{ kind: "queued", reason: null }, { kind: "reserved", reason: null },
      { kind: "dispatch_started", reason: null }, { kind: "dispatch_indeterminate", reason: "process_exit" }]);
    expect(await row(dispatch.requestId)).toMatchObject({ state: "indeterminate", dispatch_binding_hash: dispatch.bindingHash, terminal_evidence: null });
    const reboot = ai1(5101, call("crawl-agent-review", "claude-cli", "ok"), { instanceId: ownerA.instanceId, bootId: randomUUID() });
    expect(await requestCliModelSlot({ ...reboot.identity, requestId: randomUUID() }, reboot.target)).toEqual({ kind: "deferred", reason: "capacity" });
    expect(await requestAi1ModelSlot({ requestId: randomUUID(), workKey: `ai1:5101:${hex()}`, owner: ownerB, class: "first", pool: "reviewer",
      routeId: "crawl-agent-review", provider: "abcllm", model: "gw-model" }, 5101)).toEqual({ kind: "deferred", reason: "capacity" });
    await expect(markModelDispatchIndeterminate({ ...dispatch, binding: { ...dispatch.binding, attemptId: 1 } } as never, "process_exit"))
      .rejects.toThrow();
  } finally {
    for (const pid of grandchildren) if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    for (const name of await readdir(records)) await rm(path.join(records, name));
  }
}, 20_000);

it("enforces the 0094 CLI branches: CLI-only kinds and terminals, sorted intro members, per-instance Grok key and cross-transport claims", async () => {
  const value = ai2(5201, 5301, call("second-review", "grok-cli", "ok")), dispatch = await dispatched(value);
  expect(await reconcileCliProcessTerminal((await runReservedCliCall(value.call, ref(dispatch))).terminal!)).toEqual({ kind: "settled" });
  const settled = (await row(dispatch.requestId))!;
  const active: postgres.Row = { ...settled, request_id: randomUUID(), state: "dispatched", terminal_evidence: null, terminal_evidence_hash: null, settled_at: null };
  const freshClaim = (base: postgres.Row) => ({ ...base, dispatch_binding: { ...base.dispatch_binding, item: { ...base.dispatch_binding.item, token: randomUUID() } } });
  // control: 같은 모양의 새 CLI 행은 들어간다
  expect(await attempt("model_capacity_requests", freshClaim(active))).toBe("inserted");
  // 같은 item claim 은 transport 를 넘어 두 번 dispatch 되지 않는다
  expect(await attempt("model_capacity_requests", active)).toBe("23505:model_capacity_requests_ai2_cli_claim_idx");
  for (const forged of [{ ...freshClaim(active), provider: "abcllm" }, { ...freshClaim(active), dispatch_binding: { ...freshClaim(active).dispatch_binding, kind: "ai2_item_gateway" } },
    { ...freshClaim(active), dispatch_binding: { ...freshClaim(active).dispatch_binding, provider: "codex-cli", transport: { ...active.dispatch_binding.transport, provider: "codex-cli" } } },
    { ...freshClaim(active), dispatch_binding: { ...freshClaim(active).dispatch_binding, chargedTokens: 1 } },
    { ...freshClaim(active), class: "first" }, { ...freshClaim(active), owner_boot_id: randomUUID() }])
    expect(await attempt("model_capacity_requests", forged)).toMatch(/^23514:model_capacity_requests_(logical|dispatch)_check$/);
  const text = JSON.stringify(freshClaim(active)).replace(`"failureCount":0`, `"failureCount":0.0`);
  expect(await attempt("model_capacity_requests", {}, text)).toBe("23514:model_capacity_requests_dispatch_check");
  // 소개 묶음: 구성원은 정렬·중복 없음, 논리 키는 그 sha 다
  const batch = intro([5401, 5402], call("product-intro-check", "claude-cli", "ok")), introDispatch = await dispatched(batch);
  const introRow = (await row(introDispatch.requestId))!, introCopy = { ...introRow, request_id: randomUUID(), owner_boot_id: randomUUID() };
  expect(introRow.logical_member_keys).toEqual(["intro:5401", "intro:5402"]);
  for (const keys of [["intro:5402", "intro:5401"], ["intro:5401", "intro:5401"], ["intro:5401"], ["intro:0", "intro:5402"]])
    expect(await attempt("model_capacity_requests", { ...introCopy, logical_member_keys: keys })).toMatch(/^23514:model_capacity_requests_(members|logical|dispatch)_check$/);
  // Grok 세션 키는 행 주인 인스턴스의 sha 다
  const session = grokSession(call("grok-session-check", "grok-cli", "ok"), ownerB), sessionDispatch = await dispatched(session);
  const sessionRow = (await row(sessionDispatch.requestId))!;
  expect(sessionRow.logical_work_key).toBe(`bg:grok-session:${createHash("sha256").update(ownerB.instanceId).digest("hex")}`);
  expect(await attempt("model_capacity_requests", { ...sessionRow, request_id: randomUUID(), owner_instance_id: ownerA.instanceId }))
    .toMatch(/^23514:model_capacity_requests_(logical|dispatch)_check$/);
  for (const [own, value] of [[introDispatch, batch], [sessionDispatch, session]] as const)
    expect(await reconcileCliProcessTerminal(settleCliNotStarted(value.call, ref(own))!)).toEqual({ kind: "settled" });
});

it("counts CLI rows in the shared account budget: AI1 + intro on one Claude account defer the audit until a slot is released", async () => {
  const limited = "sonnet-limit", any = call("crawl-agent-review", "claude-cli", "ok");
  const first = ai1(5501, any), mine = { ...first, identity: { ...first.identity, model: limited } };
  const batch = intro([5601], any, ownerA, limited), item = audit(5701, any, ownerA, limited), auditId = randomUUID();
  const a = await granted(mine), b = await granted(batch);
  expect(await requestCliModelSlot({ ...item.identity, requestId: auditId }, item.target)).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await row(auditId)).toMatchObject({ state: "waiting", provider_budget_id: "claude-limit", logical_work_key: "bg:audit:5701" });
  expect(await cancelReservedModelSlot(a)).toBe(true);
  const retried = await requestCliModelSlot({ ...item.identity, requestId: auditId }, item.target);
  expect(retried.kind).toBe("granted");
  for (const reservation of [b, retried.kind === "granted" ? retried.reservation : null]) if (reservation) expect(await cancelReservedModelSlot(reservation)).toBe(true);
});

// 마지막에 둔다: 주인 없는 옛 gateway 호출은 정리 전까지 AI1 의 모든 후보를 막는다(gateway 선례 그대로)
it("fences AI1 CLI behind an unbound legacy gateway call exactly like the gateway, but never the background CLI targets", async () => {
  const unbound = await requestModelSlot({ requestId: randomUUID(), workKey: `legacy:${hex()}`, owner: ownerB, class: "first", pool: "reviewer",
    routeId: "crawl-agent-review", provider: "abcllm", model: "gw-model" });
  if (unbound.kind !== "granted") throw new Error("fixture_unbound_slot");
  const started = await beginModelDispatch(unbound.reservation);
  expect(started.kind).toBe("dispatched");
  const first = ai1(5801, call("crawl-agent-review", "claude-cli", "ok"));
  expect(await requestCliModelSlot({ ...first.identity, requestId: randomUUID() }, first.target)).toEqual({ kind: "deferred", reason: "capacity" });
  for (const value of [audit(5901, call("product-audit", "claude-cli", "ok")), intro([5902], call("product-intro-check", "claude-cli", "ok")),
    grokSession(call("grok-session-check", "grok-cli", "ok"), ownerB)]) {
    const slot = await requestCliModelSlot({ ...value.identity, requestId: randomUUID() }, value.target);
    expect(slot.kind).toBe("granted");
    if (slot.kind === "granted") expect(await cancelReservedModelSlot(slot.reservation)).toBe(true);
  }
  if (started.kind === "dispatched") expect(await markModelDispatchIndeterminate(started.dispatch, "transport_unknown")).toBe(true);
});
