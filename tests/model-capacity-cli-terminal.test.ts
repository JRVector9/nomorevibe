import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { itemBindingHash, type ItemBinding } from "@/lib/jobs/items/types";
import { EMPTY_SHA256 } from "@/lib/llm/cli-serving-contract";
import { cliDispatchBindingSchema, cliDispatchBindingHash, cliModelDispatchSchema, cliModelTerminalEvidenceSchema,
  introCheckMemberKeys, introCheckLogicalWorkKey, introCheckInputHash, introCheckInputSchema, grokSessionLogicalWorkKey,
  grokSessionInputHash, modelCapacityPolicyHash, modelCapacityReservationSchema,
  type CliDispatchBinding, type IntroCheckMember, type ModelCapacityPolicy } from "@/lib/llm/capacity";

// 장부 모양·해시와 repository API 만 본다. 실제 PG 잠금·CHECK 는 tests/integration/model-capacity-cli-ledger.test.ts 가 본다.
const sha = "a".repeat(64), other = "b".repeat(64), C = 160_000;
const owner = { instanceId: "m3-reviewer-1", bootId: randomUUID() };
const transport = (provider: "claude-cli" | "grok-cli", model: string) => ({ protocol: "cli-process-v1", provider, model, argvHash: sha,
  inputHash: other, envPolicyHash: sha, cliContractHash: other, timeoutMs: 20_000, maxStdoutBytes: 65_536, maxStderrBytes: 16_384 }) as const;
const charge = (provider: "claude-cli" | "grok-cli", model: string) => ({ transport: transport(provider, model), totalTokenBound: C, chargedTokens: C });
const job = <N extends string>(name: N) => ({ name, token: randomUUID(), requestedVersion: 3 });
const review1 = { stage: "ai1", candidateId: 7, inputHash: sha, sourceRevisionHash: other, policyHash: sha, promptVersion: "p1",
  rulesVersion: "r1", reviewer: { provider: "claude-cli", model: "sonnet" } } as const;
const review2 = { stage: "ai2", secondReviewId: 11, candidateId: 7, source: { kind: "first_attempt", firstAttemptId: 5 }, inputHash: sha,
  sourceRevisionHash: other, policyHash: sha, promptVersion: "p1", rulesVersion: "r1", reviewer: { provider: "grok-cli", model: "grok-4" },
  generationKey: other, vote: 11, fallbackForId: null } as const;
const item = (workKey: string, review: ItemBinding) => ({ workKey, owner, token: randomUUID(), stageEpoch: 1, itemEpoch: 2, bindingHash: itemBindingHash(review) });
const members: IntroCheckMember[] = [
  { productId: 9, slug: "b-tool", sourceHash: sha, taglineSource: "ai_page", check: { kind: "absent" } },
  { productId: 10, slug: "a-tool", sourceHash: other, taglineSource: "maker", check: { kind: "present", rowIdentityHash: sha, attempts: 2 } }];
function bindings() {
  const intro = { members, model: "sonnet" }, grok = { instanceId: owner.instanceId, model: "grok-4" };
  return {
    ai1Legacy: { kind: "ai1_legacy_cli", version: 1, logicalWorkKey: "ai1:7", candidateId: 7, attemptId: 41, inputHash: sha, sourceRevisionHash: other,
      reviewPolicyHash: sha, promptVersion: "p1", rulesVersion: "r1", provider: "claude-cli", model: "sonnet", routeId: "crawl-agent-review",
      stageEpoch: 1, ...charge("claude-cli", "sonnet"), job: job("crawl-agent-review") },
    ai1Item: { kind: "ai1_item_cli", version: 1, logicalWorkKey: "ai1:7", attemptId: 42, review: review1, item: item("ai1:7", review1),
      routeId: "crawl-agent-review", provider: "claude-cli", model: "sonnet", ...charge("claude-cli", "sonnet") },
    ai2Item: { kind: "ai2_item_cli", version: 1, logicalWorkKey: "ai2:7:11", review: review2, rowIdentityHash: sha, failureCount: 1,
      item: item("ai2:11", review2), inputPolicyHash: other, routeId: "second-review", provider: "grok-cli", model: "grok-4", ...charge("grok-cli", "grok-4") },
    audit: { kind: "product_audit_cli", version: 1, logicalWorkKey: "bg:audit:31", itemId: 31, campaignId: 2, productId: 501, slug: "merge-pdf",
      inputHash: sha, promptVersion: "p1", rulesVersion: "r1", attempts: 1, provider: "claude-cli", model: "sonnet", routeId: "product-audit",
      ...charge("claude-cli", "sonnet"), job: job("product-audit") },
    intro: { ...intro, kind: "intro_check_cli", version: 1, logicalWorkKey: introCheckLogicalWorkKey(members), inputHash: introCheckInputHash(intro),
      provider: "claude-cli", routeId: "product-intro-check", ...charge("claude-cli", "sonnet"), job: job("product-intro-check") },
    grok: { ...grok, kind: "grok_session_cli", version: 1, logicalWorkKey: grokSessionLogicalWorkKey(owner.instanceId), inputHash: grokSessionInputHash(grok),
      provider: "grok-cli", routeId: "grok-session-check", ...charge("grok-cli", "grok-4"), job: job("grok-session-check") },
  } as const satisfies Record<string, CliDispatchBinding>;
}
type Binding = CliDispatchBinding;
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { "claude-sub": 2, "grok-sub": 2 }, groupLimits: { cli: 4 },
  poolLimits: { reviewer: 4, text: 1 }, weights: { first: 2, second: 2, background: 1 }, maxWaiting: 8, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [["crawl-agent-review", "claude-cli", "sonnet"], ["second-review", "grok-cli", "grok-4"], ["product-audit", "claude-cli", "sonnet"],
    ["product-intro-check", "claude-cli", "sonnet"], ["grok-session-check", "grok-cli", "grok-4"]].map(([routeId, provider, model]) =>
    ({ routeId, provider, model, providerBudgetId: provider === "grok-cli" ? "grok-sub" : "claude-sub", groupId: "cli" })) };
function identityOf(value: Binding) {
  const workKey = value.kind === "ai1_legacy_cli" ? `ai1:7:${sha}` : value.kind === "ai1_item_cli" || value.kind === "ai2_item_cli"
    ? `${value.logicalWorkKey}:${value.item.bindingHash}` : `${value.logicalWorkKey}:${value.inputHash}`;
  const kind = value.kind.startsWith("ai1") ? "first" as const : value.kind === "ai2_item_cli" ? "second" as const : "background" as const;
  return { owner, workKey, class: kind, pool: "reviewer" as const, routeId: value.routeId, provider: value.provider, model: value.model };
}
function targetOf(value: Binding) {
  switch (value.kind) {
    case "ai1_legacy_cli": case "ai1_item_cli": return { kind: "ai1", candidateId: 7 } as const;
    case "ai2_item_cli": return { kind: "ai2", candidateId: 7, vote: 11 } as const;
    case "product_audit_cli": return { kind: "audit", itemId: 31 } as const;
    case "intro_check_cli": return { kind: "intro", members } as const;
    case "grok_session_cli": return { kind: "grok-session", instanceId: owner.instanceId } as const;
  }
}
const handle = () => modelCapacityReservationSchema.parse({ requestId: randomUUID(), owner, token: randomUUID(), epoch: 1, revision: 1,
  policyHash: modelCapacityPolicyHash(policy) });
function dispatchOf(value: Binding, base = handle()) {
  return cliModelDispatchSchema.parse({ ...base, binding: value, bindingHash: cliDispatchBindingHash(value) });
}
function processOf(dispatch: ReturnType<typeof dispatchOf>, change: Record<string, unknown> = {}) {
  return { version: 1, kind: "cli_process_terminal", requestId: dispatch.requestId, transport: dispatch.binding.transport,
    totalTokenBound: dispatch.binding.totalTokenBound, ending: "exited", exitCode: 0, signal: null, killReason: null, stdoutHash: sha,
    stderrHash: EMPTY_SHA256, stdoutBytes: 120, stderrBytes: 0, actualUsage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    provenance: "cli_reported", reportedCostUsdMicros: 2100, ...change };
}
const unstarted = (ending: "spawn_failed" | "not_started") => ({ ending, exitCode: null, signal: null, killReason: null, stdoutHash: EMPTY_SHA256,
  stderrHash: EMPTY_SHA256, stdoutBytes: 0, stderrBytes: 0, actualUsage: null, provenance: "unknown", reportedCostUsdMicros: null });

describe("fixed CLI ledger kinds", () => {
  it("binds every CLI kind to the runner transport, full C and a CLI provider, never abcllm or a gateway wire", () => {
    for (const value of Object.values(bindings())) {
      expect(cliDispatchBindingSchema.parse(value)).toEqual(value);
      const changed: unknown[] = [{ ...value, provider: "abcllm" }, { ...value, chargedTokens: C - 1 }, { ...value, wireHash: sha },
        { ...value, servingContractHash: sha }, { ...value, transport: { ...value.transport, provider: value.provider === "claude-cli" ? "grok-cli" : "claude-cli" } },
        { ...value, transport: { ...value.transport, model: "other-model" } }, { ...value, transport: { ...value.transport, protocol: "abcllm-v1" } },
        { ...value, transport: { ...value.transport, provider: "codex-cli" }, provider: "codex-cli" }, { ...value, version: 2 }];
      for (const forged of changed) expect(cliDispatchBindingSchema.safeParse(forged).success).toBe(false);
    }
    const { audit, intro, grok } = bindings();
    for (const forged of [{ ...audit, provider: "grok-cli", transport: transport("grok-cli", "sonnet") },
      { ...intro, provider: "grok-cli", transport: transport("grok-cli", "sonnet") }, { ...grok, provider: "claude-cli", transport: transport("claude-cli", "grok-4") }])
      expect(cliDispatchBindingSchema.safeParse(forged).success).toBe(false);
  });
  it("shares the gateway logical key so a transport switch never splits one AI1 candidate or AI2 vote", () => {
    const { ai1Legacy, ai1Item, ai2Item } = bindings();
    expect([ai1Legacy.logicalWorkKey, ai1Item.logicalWorkKey, ai2Item.logicalWorkKey]).toEqual(["ai1:7", "ai1:7", "ai2:7:11"]);
    for (const forged of [{ ...ai1Legacy, logicalWorkKey: "ai1:8" }, { ...ai1Item, logicalWorkKey: "ai1:8" }, { ...ai2Item, logicalWorkKey: "ai2:7:12" },
      { ...ai1Item, item: { ...ai1Item.item, bindingHash: sha } }, { ...ai2Item, item: { ...ai2Item.item, workKey: "ai2:12" } },
      { ...ai1Item, review: { ...review1, reviewer: { provider: "claude-cli", model: "opus" } } }, { ...ai1Legacy, job: { ...ai1Legacy.job, name: "second-review" } }])
      expect(cliDispatchBindingSchema.safeParse(forged).success).toBe(false);
  });
  it("fixes background targets: one audit item, sorted distinct intro members, one Grok session per instance", () => {
    expect(introCheckMemberKeys(members)).toEqual(["intro:10", "intro:9"]);
    expect(introCheckLogicalWorkKey(members)).toBe(`bg:intro:${createHash("sha256").update(JSON.stringify(["intro:10", "intro:9"])).digest("hex")}`);
    expect(introCheckLogicalWorkKey([...members].reverse())).toBe(introCheckLogicalWorkKey(members));
    const value = { members, model: "sonnet" }, hash = introCheckInputHash(value);
    expect(introCheckInputHash({ ...value, members: [...members].reverse() })).toBe(hash);
    for (const changed of [{ ...value, model: "opus" }, { ...value, members: [members[0], { ...members[1], check: { kind: "absent" as const } }] },
      { ...value, members: [{ ...members[0], sourceHash: other }, members[1]] }, { ...value, members: [members[0]] }])
      expect(introCheckInputHash(changed)).not.toBe(hash);
    for (const forged of [{ ...value, members: [members[0], members[0]] }, { ...value, members: [] },
      { ...value, members: Array.from({ length: 11 }, (_, index) => ({ ...members[0], productId: index + 1 })) },
      { ...value, members: [{ ...members[0], taglineSource: "unknown" }] }, { ...value, members: [{ ...members[0], check: { kind: "absent", attempts: 0 } }] }])
      expect(introCheckInputSchema.safeParse(forged).success).toBe(false);
    expect(grokSessionLogicalWorkKey("m3-reviewer-1")).toBe(`bg:grok-session:${createHash("sha256").update("m3-reviewer-1").digest("hex")}`);
    expect(grokSessionInputHash({ instanceId: "m3-reviewer-1", model: "grok-4" })).not.toBe(grokSessionInputHash({ instanceId: "m3-reviewer-1", model: "grok-5" }));
    const { audit, intro, grok } = bindings();
    for (const forged of [{ ...audit, logicalWorkKey: "bg:audit:32" }, { ...intro, members: [...members].reverse(), logicalWorkKey: `bg:intro:${sha}` },
      { ...intro, inputHash: sha }, { ...grok, logicalWorkKey: grokSessionLogicalWorkKey("mini-reviewer-1") }, { ...grok, inputHash: sha }])
      expect(cliDispatchBindingSchema.safeParse(forged).success).toBe(false);
  });
  it("binds the dispatch owner to item and Grok owners and checks the binding hash", () => {
    const { ai1Item, ai2Item, grok, audit } = bindings();
    for (const value of [ai1Item, ai2Item, grok]) {
      const owned = dispatchOf(value);
      expect(cliModelDispatchSchema.safeParse({ ...owned, owner: { ...owned.owner, bootId: randomUUID() } }).success).toBe(value.kind === "grok_session_cli");
      expect(cliModelDispatchSchema.safeParse({ ...owned, owner: { ...owned.owner, instanceId: "mini-reviewer-1" } }).success).toBe(false);
    }
    const owned = dispatchOf(audit);
    expect(cliModelDispatchSchema.safeParse({ ...owned, bindingHash: other }).success).toBe(false);
    expect(cliModelDispatchSchema.safeParse({ ...owned, owner: { instanceId: "mini-reviewer-1", bootId: randomUUID() } }).success).toBe(true);
  });
  it("accepts every physical ending only for the same request, transport and C", () => {
    const dispatch = dispatchOf(bindings().intro);
    for (const change of [{}, { ending: "killed", exitCode: null, signal: "SIGKILL", killReason: "timeout", actualUsage: null, provenance: "unknown",
      reportedCostUsdMicros: null }, unstarted("spawn_failed"), unstarted("not_started")])
      expect(cliModelTerminalEvidenceSchema.safeParse({ version: 1, kind: "cli_model_terminal", dispatch, process: processOf(dispatch, change) }).success).toBe(true);
    for (const change of [{ requestId: randomUUID() }, { transport: { ...dispatch.binding.transport, argvHash: other } }, { totalTokenBound: C + 1 },
      { actualUsage: { inputTokens: C, outputTokens: 1, totalTokens: C + 1 } }, { kind: "ai1_gateway_terminal" }, { ...unstarted("not_started"), stdoutBytes: 1 }])
      expect(cliModelTerminalEvidenceSchema.safeParse({ version: 1, kind: "cli_model_terminal", dispatch, process: processOf(dispatch, change) }).success).toBe(false);
    expect(cliModelTerminalEvidenceSchema.safeParse({ version: 1, kind: "ai1_gateway_terminal", dispatch, process: processOf(dispatch) }).success).toBe(false);
  });
});

// Recording transaction: API 순서와 거절 지점만 본다. 물리 잠금·실제 terminal 은 실제 PG driver 가 본다.
const recording = vi.hoisted(() => ({ transaction: vi.fn(), replay: vi.fn(), terminal: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { transaction: recording.transaction }, onPrimary: (load: () => unknown) => load() }));
vi.mock("@/lib/db/replay-scope", () => ({ currentReplayDb: recording.replay }));
vi.mock("@/lib/llm/cli-process-runner", () => ({ readCliProcessTerminal: recording.terminal }));
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { modelCapacityControl, modelCapacityRequests } from "@/lib/db/schema";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { requestCliModelSlot, lockCliModelCapacityDispatch, finishCliModelCapacityDispatch, reconcileCliProcessTerminal,
  markModelDispatchIndeterminate, requestAi1ModelSlot } from "@/lib/llm/capacity-repository";
const control = () => ({ id: 1, mode: "open", epoch: 1, revision: 1, policy, policyHash: modelCapacityPolicyHash(policy), cursor: 0 });
function rowFixture(value: Binding) {
  const identity = identityOf(value), base = handle(), owned = dispatchOf(value, base);
  const evidence = cliModelTerminalEvidenceSchema.parse({ version: 1, kind: "cli_model_terminal", dispatch: owned, process: processOf(owned) });
  const row = { ...identity, ...base, ownerInstanceId: owner.instanceId, ownerBootId: owner.bootId, logicalWorkKey: value.logicalWorkKey,
    logicalMemberKeys: value.kind === "intro_check_cli" ? introCheckMemberKeys(value.members) : null, state: "reserved",
    providerBudgetId: value.provider === "grok-cli" ? "grok-sub" : "claude-sub", groupId: "cli", dispatchedAt: new Date(), settledAt: new Date(),
    dispatchBinding: value, dispatchBindingHash: owned.bindingHash, terminalEvidence: evidence, terminalEvidenceHash: reviewHash(evidence) };
  return { value, identity, base, owned, evidence, row };
}
function mockTx(rows: unknown[][], updates: unknown[][] = [], inserted: unknown[][] = []) {
  const trace: string[] = [], writes: Array<{ table: unknown; value: unknown }> = [], queries: unknown[] = [];
  const query = (values: unknown[]) => { const chain = {
    from: (table: unknown) => { trace.push(table === modelCapacityControl ? "control" : "request"); return chain; },
    where: (predicate: unknown) => { queries.push(predicate); return chain; }, for: (mode: string) => { trace.push(mode); return chain; },
    limit: () => chain, orderBy: () => chain,
    then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(values).then(resolve, reject),
  }; return chain; };
  const tx = { select: () => query(rows.shift() ?? []), execute: vi.fn(async () => [{ live: true }]),
    update: () => ({ set: (value: unknown) => { writes.push({ table: "update", value }); return { where: () => ({ returning: async () => updates.shift() ?? [] }) }; } }),
    insert: (table: unknown) => ({ values: (value: unknown) => { writes.push({ table, value }); const result = inserted.shift() ?? [];
      return { returning: async () => result, then: (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject) }; } }) };
  return { tx: tx as unknown as ProductTransaction, trace, writes, queries };
}
const run = (fixture: ReturnType<typeof mockTx>) => recording.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
async function sqlOf(predicate: unknown) {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  return new PgDialect().sqlToQuery(predicate as import("drizzle-orm").SQL);
}
beforeEach(() => { vi.clearAllMocks(); recording.replay.mockReturnValue(undefined); });

it("puts the fixed CLI target in the first waiting INSERT and rejects abcllm or foreign identities before SQL", async () => {
  for (const value of Object.values(bindings())) {
    const fixed = rowFixture(value), waiting = { ...fixed.row, state: "waiting" };
    const fixture = mockTx([[control()], [], [], [], [], [], [], [{ count: 0 }], [waiting]], [], [[waiting]]);
    vi.mocked(fixture.tx.execute).mockResolvedValue([] as never); run(fixture);
    expect(await requestCliModelSlot({ ...fixed.identity, requestId: fixed.base.requestId }, targetOf(value))).toEqual({ kind: "deferred", reason: "capacity" });
    expect(fixture.writes.find(write => write.table === modelCapacityRequests)?.value).toMatchObject({ state: "waiting",
      logicalWorkKey: value.logicalWorkKey, ...(value.kind === "intro_check_cli" ? { logicalMemberKeys: ["intro:10", "intro:9"] } : {}) });
  }
  recording.transaction.mockReset();
  const { ai1Legacy, ai2Item, grok, audit } = bindings();
  const forged: Array<[Record<string, unknown>, ReturnType<typeof targetOf> | Record<string, unknown>]> = [
    [{ ...identityOf(ai1Legacy), provider: "abcllm" }, targetOf(ai1Legacy)], [{ ...identityOf(ai1Legacy), class: "second" }, targetOf(ai1Legacy)],
    [{ ...identityOf(ai2Item), provider: "codex-cli" }, targetOf(ai2Item)], [identityOf(ai2Item), { kind: "ai2", candidateId: 7, vote: 0 }],
    [identityOf(ai2Item), { kind: "ai2", candidateId: 7, vote: 11, extra: 1 }], [{ ...identityOf(audit), pool: "text" }, targetOf(audit)],
    [{ ...identityOf(audit), provider: "abcllm" }, targetOf(audit)], [identityOf(grok), { kind: "grok-session", instanceId: "mini-reviewer-1" }],
    [{ ...identityOf(grok), workKey: `${grokSessionLogicalWorkKey("mini-reviewer-1")}:${sha}` }, { kind: "grok-session", instanceId: "mini-reviewer-1" }],
    [{ ...identityOf(grok), workKey: `${grok.logicalWorkKey}:short` }, targetOf(grok)], [identityOf(audit), { kind: "audit", itemId: 31.5 }]];
  for (const [identity, target] of forged)
    await expect(requestCliModelSlot({ ...identity, requestId: randomUUID() } as never, target as never)).rejects.toThrow("invalid_cli_capacity_identity");
  // 기존 gateway 입구는 CLI provider 를 받지 않는다 — CLI 는 이 입구로만 들어온다
  await expect(requestAi1ModelSlot({ ...identityOf(ai1Legacy), requestId: randomUUID() }, 7)).rejects.toThrow("invalid_ai1_capacity_identity");
  expect(recording.transaction).not.toHaveBeenCalled();
});
it("fences AI1/AI2 CLI behind the shared gateway key and background targets behind their own route only", async () => {
  for (const value of Object.values(bindings())) {
    const fixed = rowFixture(value), fixture = mockTx([[control()], [], [], [{ id: randomUUID() }]]); run(fixture);
    expect(await requestCliModelSlot({ ...fixed.identity, requestId: fixed.base.requestId }, targetOf(value))).toEqual({ kind: "deferred", reason: "capacity" });
    const query = await sqlOf(fixture.queries.at(-1));
    if (value.kind === "intro_check_cli") { expect(query.sql).toContain("logical_member_keys"); expect(query.params).toEqual(expect.arrayContaining(["intro:10", "intro:9"])); }
    else expect(query.params).toContain(value.logicalWorkKey);
    if (value.kind.startsWith("ai1")) expect(query.sql).toContain("'crawl-agent-review'");
    if (value.kind === "ai2_item_cli") expect(query.sql).toContain("'second-review'");
    if (["product_audit_cli", "grok_session_cli", "intro_check_cli"].includes(value.kind)) {
      expect(query.sql).not.toContain("abcllm"); expect(JSON.stringify(query.params)).toContain(value.routeId);
    }
    expect(fixture.writes).toEqual([]);
  }
});
it("locks control and the actual request before a same-TX one-use capability that only accepts the target's own kind", async () => {
  const all = bindings();
  for (const value of Object.values(all)) {
    const fixed = rowFixture(value), fixture = mockTx([[control()], [fixed.row], []], [[{ ...fixed.row, state: "dispatched" }]]);
    const lock = await lockCliModelCapacityDispatch(fixture.tx, { reservation: fixed.base, identity: fixed.identity, target: targetOf(value) });
    expect(lock).not.toBeNull(); expect(fixture.trace.slice(0, 4)).toEqual(["control", "update", "request", "update"]);
    await expect(finishCliModelCapacityDispatch({} as ProductTransaction, lock!, value)).rejects.toThrow("invalid_cli_capacity_dispatch_lock");
    await expect(finishCliModelCapacityDispatch(fixture.tx, { ...lock! }, value)).rejects.toThrow("invalid_cli_capacity_dispatch_lock");
    const foreign = value.kind.startsWith("ai1") ? all.audit : all.ai1Legacy;
    await expect(finishCliModelCapacityDispatch(fixture.tx, lock!, foreign)).rejects.toThrow("cli_capacity_dispatch_binding_mismatch");
    const dispatch = await finishCliModelCapacityDispatch(fixture.tx, lock!, value);
    expect(dispatch).toMatchObject({ requestId: fixed.base.requestId, binding: value, bindingHash: cliDispatchBindingHash(value) });
    expect(fixture.writes.find(write => write.table === "update")?.value).toMatchObject({ state: "dispatched", dispatchBinding: value });
    expect(fixture.writes.find(write => write.table !== "update")?.value).toMatchObject({ kind: "dispatch_started", evidence: { dispatch } });
    await expect(finishCliModelCapacityDispatch(fixture.tx, lock!, value)).rejects.toThrow("invalid_cli_capacity_dispatch_lock");
  }
  const { ai1Item, ai2Item } = bindings(), fixed = rowFixture(ai1Item), fixture = mockTx([[control()], [fixed.row], []]);
  const lock = await lockCliModelCapacityDispatch(fixture.tx, { reservation: fixed.base, identity: fixed.identity, target: targetOf(ai1Item) });
  await expect(finishCliModelCapacityDispatch(fixture.tx, lock!, { ...ai1Item, attemptId: 43, item: { ...ai1Item.item, owner: { ...owner, bootId: randomUUID() } } }))
    .rejects.toThrow("cli_capacity_dispatch_binding_mismatch");
  const second = rowFixture(ai2Item), held = mockTx([[control()], [second.row], [{ id: randomUUID() }]]);
  expect(await lockCliModelCapacityDispatch(held.tx, { reservation: second.base, identity: second.identity, target: targetOf(ai2Item) })).toBeNull();
});
it("settles only the runner's opaque terminal against the stored historical dispatch, for every physical ending", async () => {
  for (const change of [{}, { ending: "killed", exitCode: null, signal: "SIGKILL", killReason: "cancelled", actualUsage: null, provenance: "unknown",
    reportedCostUsdMicros: null }, unstarted("spawn_failed"), unstarted("not_started")]) {
    const fixed = rowFixture(bindings().ai2Item), process = processOf(fixed.owned, change);
    const evidence = cliModelTerminalEvidenceSchema.parse({ version: 1, kind: "cli_model_terminal", dispatch: fixed.owned, process });
    const fixture = mockTx([[{ id: 1 }], [{ ...fixed.row, state: "indeterminate" }]], [[{ ...fixed.row, state: "settled" }]]);
    recording.terminal.mockReturnValue(process); run(fixture);
    expect(await reconcileCliProcessTerminal({ kind: "cli_process_terminal" })).toEqual({ kind: "settled" });
    expect(fixture.writes[0].value).toMatchObject({ state: "settled", terminalEvidence: evidence, terminalEvidenceHash: reviewHash(evidence) });
    expect(fixture.writes[1].value).toMatchObject({ kind: "dispatch_settled", fromState: "indeterminate", toState: "settled", evidence });
    expect(fixture.trace.slice(0, 4)).toEqual(["control", "update", "request", "update"]);
  }
  const fixed = rowFixture(bindings().intro);
  for (const process of [processOf(fixed.owned, { transport: { ...fixed.owned.binding.transport, envPolicyHash: other } }),
    processOf(fixed.owned, { totalTokenBound: C + 1 }), processOf(fixed.owned, { transport: { ...fixed.owned.binding.transport, timeoutMs: 90_000 } })]) {
    const fixture = mockTx([[{ id: 1 }], [{ ...fixed.row, state: "dispatched" }]]); recording.terminal.mockReturnValue(process); run(fixture);
    await expect(reconcileCliProcessTerminal({ kind: "cli_process_terminal" })).rejects.toThrow("cli_process_terminal_binding_mismatch");
    expect(fixture.writes).toEqual([]);
  }
  for (const row of [undefined, { ...fixed.row, state: "dispatched", dispatchBinding: { ...fixed.value, model: "opus" } }, { ...fixed.row, state: "dispatched", dispatchedAt: null },
    { ...fixed.row, state: "dispatched", logicalMemberKeys: ["intro:9"] }, { ...fixed.row, state: "dispatched", workKey: `${fixed.value.logicalWorkKey}:${other}` },
    { ...fixed.row, state: "dispatched", class: "first" }]) {
    const fixture = mockTx([[{ id: 1 }], row ? [row] : []]); recording.terminal.mockReturnValue(processOf(fixed.owned)); run(fixture);
    await expect(reconcileCliProcessTerminal({ kind: "cli_process_terminal" })).rejects.toThrow("cli_process_terminal_binding_mismatch");
    expect(fixture.writes).toEqual([]);
  }
  const waiting = mockTx([[{ id: 1 }], [{ ...fixed.row, state: "withdrawn" }]]); recording.terminal.mockReturnValue(processOf(fixed.owned)); run(waiting);
  await expect(reconcileCliProcessTerminal({ kind: "cli_process_terminal" })).rejects.toThrow("cli_process_terminal_state_mismatch");
});
it("makes the same terminal idempotent and rejects a conflicting persisted terminal", async () => {
  const fixed = rowFixture(bindings().grok); recording.terminal.mockReturnValue(fixed.evidence.process);
  const fixture = mockTx([[{ id: 1 }], [{ ...fixed.row, state: "settled" }]]); run(fixture);
  expect(await reconcileCliProcessTerminal({ kind: "cli_process_terminal" })).toEqual({ kind: "already_settled" });
  expect(fixture.writes).toEqual([]);
  recording.terminal.mockReturnValue(processOf(fixed.owned, { stdoutHash: other }));
  const bad = mockTx([[{ id: 1 }], [{ ...fixed.row, state: "settled" }]]); run(bad);
  await expect(reconcileCliProcessTerminal({ kind: "cli_process_terminal" })).rejects.toThrow("cli_process_terminal_conflict");
  expect(bad.writes).toEqual([]);
});
it("keeps the original CLI binding when marking process_exit and rejects a substituted binding", async () => {
  const legacy = bindings().ai1Legacy, fixed = rowFixture(legacy);
  const fixture = mockTx([[control()], [], [{ ...fixed.row, state: "dispatched" }]], [[{ ...fixed.row, state: "indeterminate" }]]); run(fixture);
  await expect(markModelDispatchIndeterminate(fixed.owned, "process_exit")).resolves.toBe(true);
  expect(fixture.writes[1].value).toMatchObject({ kind: "dispatch_indeterminate", reason: "process_exit" });
  const other = dispatchOf({ ...legacy, attemptId: 99 }, fixed.base);
  const bad = mockTx([[control()], [], [{ ...fixed.row, state: "dispatched" }]]); run(bad);
  await expect(markModelDispatchIndeterminate(other, "process_exit")).rejects.toThrow("cli_capacity_dispatch_binding_mismatch");
  expect(bad.writes).toEqual([]);
});
it("rejects copied terminals and replay on every CLI entry before SQL", async () => {
  recording.terminal.mockReturnValue(null);
  await expect(reconcileCliProcessTerminal(JSON.parse(JSON.stringify({ kind: "cli_process_terminal" })))).rejects.toThrow("invalid_cli_process_terminal");
  expect(recording.transaction).not.toHaveBeenCalled();
  const fixed = rowFixture(bindings().audit); recording.replay.mockReturnValue({});
  await expect(requestCliModelSlot({ ...fixed.identity, requestId: fixed.base.requestId }, targetOf(fixed.value))).rejects.toThrow("model_capacity_replay_unsupported");
  await expect(lockCliModelCapacityDispatch({} as ProductTransaction, { reservation: fixed.base, identity: fixed.identity, target: targetOf(fixed.value) }))
    .rejects.toThrow("model_capacity_replay_unsupported");
  await expect(finishCliModelCapacityDispatch({} as ProductTransaction, {} as never, fixed.value)).rejects.toThrow("model_capacity_replay_unsupported");
  await expect(reconcileCliProcessTerminal({ kind: "cli_process_terminal" })).rejects.toThrow("model_capacity_replay_unsupported");
  expect(recording.transaction).not.toHaveBeenCalled();
});
