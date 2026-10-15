import { describe, expect, it } from "vitest";
import type postgres from "postgres";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { itemBindingHash, itemWorkKey, type Ai2ItemBinding, type ItemBinding } from "@/lib/jobs/items/types";
import { captureReplayItemState } from "@/lib/operations/pipeline-replay-item-capture";
import type { ReplayItemState } from "@/lib/operations/pipeline-replay-item-state";
import { ReplayReadinessProjectionSchema } from "@/lib/operations/pipeline-replay-readiness";
import { parseReplayArtifact, replayArtifactFromVerified } from "@/lib/operations/pipeline-replay-artifact";

const rawAt = "2026-10-16 08:59:59.999999+09:00", utc = "2026-10-15T23:59:59.999999Z";
const rawExpiredAt = "2001-02-03 13:05:06.123456+09:00", expiredAt = "2001-02-03T04:05:06.123456Z";
const boot = "11111111-1111-4111-8111-111111111111", token = "22222222-2222-4222-8222-222222222222";
const otherUuid = "33333333-3333-4333-8333-333333333333";
type ItemRow = ReplayItemState["tables"]["pipeline_item_leases"][number];
type StageRow = ReplayItemState["tables"]["pipeline_stage_modes"][number];

function secondBinding(id: number): Ai2ItemBinding {
  return { stage: "ai2", secondReviewId: id, candidateId: 41,
    source: { kind: "published", slug: "same-slug", productId: 51 },
    inputHash: "a".repeat(64), sourceRevisionHash: "b".repeat(64), policyHash: "c".repeat(64),
    promptVersion: "prompt-v1", rulesVersion: "rules-v1", reviewer: { provider: "abcllm", model: "second" },
    generationKey: "d".repeat(64), vote: id, fallbackForId: null };
}
function item(binding: ItemBinding): ItemRow {
  // Structural raw evidence only; none of these tokens are execution receipts.
  return { stage: binding.stage, work_key: itemWorkKey(binding), binding, binding_hash: itemBindingHash(binding),
    owner_instance_id: "foreign-worker", owner_boot_id: boot, token, stage_epoch: 1, item_epoch: 4,
    lease_until: rawAt, created_at: rawAt, updated_at: rawAt };
}
function payload(items?: ItemRow[]): ReplayItemState {
  const released = { ...item(secondBinding(2)), owner_instance_id: null, owner_boot_id: null,
    token: null, lease_until: null, item_epoch: 0 };
  return { kind: "pipeline-replay-item-state", version: 1, tables: {
    pipeline_stage_modes: [
      { stage: "fetch", mode: "legacy", draining_from: null, epoch: 4, writer_contract_version: 0, updated_at: rawAt },
      { stage: "ai2", mode: "draining", draining_from: "items", epoch: 7, writer_contract_version: 2, updated_at: rawAt },
      { stage: "ai1", mode: "items", draining_from: null, epoch: 3, writer_contract_version: 1, updated_at: rawAt },
    ],
    pipeline_item_leases: items ?? [
      item({ stage: "fetch", frontierId: 9, repo: "foreign/repository", claim: { attempts: 2, nextAttemptAt: "2026-10-16T00:00:00.123Z" } }),
      released,
      item({ stage: "ai1", candidateId: 2, inputHash: "a".repeat(64), sourceRevisionHash: "b".repeat(64),
        policyHash: "c".repeat(64), promptVersion: "p1", rulesVersion: "r1", reviewer: { provider: "abcllm", model: "first" } }),
      { ...item(secondBinding(10)), lease_until: rawExpiredAt },
    ],
  } };
}
function expected(input = payload()): ReplayItemState {
  const copy = structuredClone(input);
  // Independent fixture expectations: these two literal aliases denote the
  // stated UTC instants; arbitrary timestamp parsing belongs to the pure model.
  const at = (value: string) => value === rawAt ? utc : value === rawExpiredAt ? expiredAt : value;
  copy.tables.pipeline_stage_modes = ["ai1", "ai2", "fetch"].map(stage => {
    const row = copy.tables.pipeline_stage_modes.find(value => value.stage === stage)!;
    return { ...row, updated_at: at(row.updated_at) };
  });
  const rows = copy.tables.pipeline_item_leases;
  copy.tables.pipeline_item_leases = rows.map(row => [row.stage, row.work_key].join("/")).sort()
    .map(key => rows.find(row => [row.stage, row.work_key].join("/") === key)!)
    .map(row => ({ ...row, created_at: at(row.created_at), updated_at: at(row.updated_at),
      lease_until: row.lease_until === null ? null : at(row.lease_until) }));
  return copy;
}
function freeze(value: unknown): void {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
}
function sqlResult(result: unknown, error?: unknown) {
  const calls: Array<{ strings: string[]; raw: readonly string[]; parameters: unknown[] }> = [];
  const forbidden = () => { throw new Error("capture_must_use_only_the_owned_literal_statement"); };
  const tx = Object.assign(async (strings: TemplateStringsArray, ...parameters: unknown[]) => {
    calls.push({ strings: [...strings], raw: strings.raw, parameters });
    if (error !== undefined) throw error;
    return result;
  }, { unsafe: forbidden, begin: forbidden, savepoint: forbidden, reserve: forbidden, end: forbidden }) as unknown as postgres.TransactionSql;
  return { tx, calls };
}
const capture = (input: unknown) => captureReplayItemState(sqlResult([{ state: input }]).tx);
function secondRow(input: ReplayItemState): ItemRow { return input.tables.pipeline_item_leases.find(row => row.work_key === "ai2:10")!; }
function changeBinding(input: ReplayItemState, change: (value: Ai2ItemBinding) => void): void {
  const row = secondRow(input);
  if (row.binding.stage !== "ai2") throw new Error("invalid_test_binding");
  change(row.binding); row.work_key = itemWorkKey(row.binding); row.binding_hash = itemBindingHash(row.binding);
}

describe("fixed capture boundary", () => {
  it("executes one parameter-free literal statement with both whole-row aggregates and no subset or row locks", async () => {
    const boundary = sqlResult([{ state: payload() }]);
    await captureReplayItemState(boundary.tx);
    expect(boundary.calls).toHaveLength(1);
    const call = boundary.calls[0], statement = call.strings.join("?");
    expect(call.strings).toHaveLength(1); expect(call.raw).toEqual(call.strings); expect(call.parameters).toEqual([]);
    expect(statement.trim()).toMatch(/^SELECT\s/i);
    expect(statement).toContain("public.pipeline_stage_modes"); expect(statement).toContain("public.pipeline_item_leases");
    expect(statement.match(/jsonb_agg\s*\(\s*to_jsonb\s*\(\s*\w+\s*\)\s*\)/gi)).toHaveLength(2);
    expect(statement).not.toMatch(/\b(?:WHERE|LIMIT|DISTINCT|FILTER|FOR|LOCK|INSERT|UPDATE|DELETE|BEGIN|COMMIT)\b|pg_advisory|;/i);
  });

  it("returns exactly state and its full canonical hash, without snapshot authority or wall-time fields", async () => {
    const input = payload(), result = await capture(input), wanted = expected(input);
    expect(result).toEqual({ state: wanted, stateHash: reviewHash(wanted) });
    expect(Object.keys(result).sort()).toEqual(["state", "stateHash"]);
    expect(ReplayReadinessProjectionSchema.safeParse(result.state).success).toBe(false);
    expect(() => parseReplayArtifact(result.state)).toThrow("invalid_replay_artifact");
    expect(() => replayArtifactFromVerified(result)).toThrow("verified_replay_artifact_required");
  });

  it("retains all full columns of foreign, stale-generation, expired and released rows", async () => {
    const result = await capture(payload());
    expect(result.state).toEqual(expected());
    expect(result.state.tables.pipeline_stage_modes.map(row => Object.keys(row).sort()))
      .toEqual(Array.from({ length: 3 }, () => ["draining_from", "epoch", "mode", "stage", "updated_at", "writer_contract_version"]));
    expect(result.state.tables.pipeline_item_leases.map(row => Object.keys(row).sort()))
      .toEqual(Array.from({ length: 4 }, () => ["binding", "binding_hash", "created_at", "item_epoch", "lease_until",
        "owner_boot_id", "owner_instance_id", "stage", "stage_epoch", "token", "updated_at", "work_key"]));
    expect(secondRow(result.state)).toMatchObject({ owner_instance_id: "foreign-worker", stage_epoch: 1, lease_until: expiredAt });
    expect(result.state.tables.pipeline_item_leases.find(row => row.work_key === "ai2:2"))
      .toMatchObject({ owner_instance_id: null, owner_boot_id: null, token: null, lease_until: null, item_epoch: 0 });
  });

  it("does not cap or discard any of 137 raw item rows", async () => {
    const input = payload(Array.from({ length: 137 }, (_, index) => item(secondBinding(index + 1))).reverse());
    const result = await capture(input);
    expect(result.state.tables.pipeline_item_leases).toHaveLength(137);
    expect(result).toEqual({ state: expected(input), stateHash: reviewHash(expected(input)) });
  });

  it("captures empty items while preserving all three stages", async () => {
    const input = payload([]), wanted = expected(input);
    expect(await capture(input)).toEqual({ state: wanted, stateHash: reviewHash(wanted) });
  });

  it("normalizes order and exact offset spellings without losing one microsecond", async () => {
    const input = payload(), canonical = expected(input), permuted = structuredClone(canonical);
    permuted.tables.pipeline_stage_modes.reverse(); permuted.tables.pipeline_item_leases.reverse();
    const raw = await capture(input), other = await capture(permuted);
    expect(raw).toEqual(other); expect(raw.stateHash).toBe(reviewHash(canonical));
    const later = structuredClone(canonical); secondRow(later).lease_until = "2001-02-03T04:05:06.123457Z";
    expect((await capture(later)).stateHash).not.toBe(raw.stateHash);
  });

  it("returns independent nested copies on every call and never mutates frozen raw rows", async () => {
    const input = payload(), before = structuredClone(input); freeze(input);
    const first = await capture(input), second = await capture(input);
    expect(first).toEqual(second); expect(first.state).not.toBe(second.state);
    const binding = secondRow(first.state).binding;
    if (binding.stage !== "ai2" || binding.source.kind !== "published") throw new Error("invalid_test_binding");
    binding.source.productId = 99; binding.reviewer.model = "mutated-copy";
    first.state.tables.pipeline_stage_modes[0].epoch = 99;
    expect(input).toEqual(before); expect(second.state).toEqual(expected(before));
  });
});

describe("full payload hash sensitivity", () => {
  const changes: Array<[string, (value: ReplayItemState) => void]> = [
    ["stage identity", value => { [value.tables.pipeline_stage_modes[0].stage, value.tables.pipeline_stage_modes[2].stage]
      = [value.tables.pipeline_stage_modes[2].stage, value.tables.pipeline_stage_modes[0].stage]; }],
    ["mode", value => { value.tables.pipeline_stage_modes[2].mode = "legacy"; }],
    ["draining origin", value => { value.tables.pipeline_stage_modes[1].draining_from = "legacy"; }],
    ["stage epoch", value => { value.tables.pipeline_stage_modes[0].epoch++; }],
    ["writer contract", value => { value.tables.pipeline_stage_modes[0].writer_contract_version++; }],
    ["stage updatedAt", value => { value.tables.pipeline_stage_modes[0].updated_at = "2026-10-16T00:00:00.000Z"; }],
    ["owner instance", value => { secondRow(value).owner_instance_id = "another-worker"; }],
    ["owner boot", value => { secondRow(value).owner_boot_id = otherUuid; }],
    ["owner token", value => { secondRow(value).token = otherUuid; }],
    ["item stage epoch", value => { secondRow(value).stage_epoch = 2; }],
    ["item epoch", value => { secondRow(value).item_epoch++; }],
    ["item leaseUntil", value => { secondRow(value).lease_until = "2001-02-03T04:05:06.123457Z"; }],
    ["item createdAt", value => { secondRow(value).created_at = "2026-10-16T00:00:00.000Z"; }],
    ["item updatedAt", value => { secondRow(value).updated_at = "2026-10-16T00:00:00.000Z"; }],
    ["item stage", value => { const row = secondRow(value), binding: ItemBinding = {
      stage: "fetch", frontierId: 10, repo: "different/repository", claim: { attempts: 1, nextAttemptAt: "2026-10-16T00:00:00.000Z" } };
      Object.assign(row, { stage: binding.stage, work_key: itemWorkKey(binding), binding, binding_hash: itemBindingHash(binding) }); }],
    ["logical identity", value => changeBinding(value, binding => { binding.secondReviewId = 11; binding.vote = 11; })],
    ["candidate identity", value => changeBinding(value, binding => { binding.candidateId++; })],
    ["product generation", value => changeBinding(value, binding => { if (binding.source.kind === "published") binding.source.productId++; })],
    ["published slug", value => changeBinding(value, binding => { if (binding.source.kind === "published") binding.source.slug = "other-slug"; })],
    ["source kind and first attempt", value => changeBinding(value, binding => { binding.source = { kind: "first_attempt", firstAttemptId: 61 }; })],
    ["input hash", value => changeBinding(value, binding => { binding.inputHash = "e".repeat(64); })],
    ["source revision hash", value => changeBinding(value, binding => { binding.sourceRevisionHash = "e".repeat(64); })],
    ["policy hash", value => changeBinding(value, binding => { binding.policyHash = "e".repeat(64); })],
    ["prompt version", value => changeBinding(value, binding => { binding.promptVersion = "prompt-v2"; })],
    ["rules version", value => changeBinding(value, binding => { binding.rulesVersion = "rules-v2"; })],
    ["review provider", value => changeBinding(value, binding => { binding.reviewer.provider = "claude-cli"; })],
    ["review model", value => changeBinding(value, binding => { binding.reviewer.model = "second-v2"; })],
    ["generation key", value => changeBinding(value, binding => { binding.generationKey = "e".repeat(64); })],
    ["fallback root vote", value => changeBinding(value, binding => { binding.fallbackForId = 8; binding.vote = 8; })],
    ["fetch repository", value => { const row = value.tables.pipeline_item_leases[0];
      if (row.binding.stage === "fetch") row.binding.repo = "another/repository"; row.binding_hash = itemBindingHash(row.binding); }],
    ["fetch claim", value => { const row = value.tables.pipeline_item_leases[0];
      if (row.binding.stage === "fetch") row.binding.claim.attempts++; row.binding_hash = itemBindingHash(row.binding); }],
  ];
  it.each(changes)("binds %s and the complete resulting state", async (_label, change) => {
    const input = payload(), baseline = await capture(input); change(input);
    const result = await capture(input);
    expect(result.stateHash).not.toBe(baseline.stateHash);
    expect(result.stateHash).toBe(reviewHash(expected(input)));
  });
});

describe("strict SQL result and original error boundaries", () => {
  it.each(Object.keys(payload().tables.pipeline_stage_modes[0]))("rejects missing stage SQL column %s", async column => {
    const value = payload(); Reflect.deleteProperty(value.tables.pipeline_stage_modes[0], column);
    await expect(capture(value)).rejects.toThrow();
  });
  it.each(Object.keys(payload().tables.pipeline_item_leases[0]))("rejects missing item SQL column %s", async column => {
    const value = payload(); Reflect.deleteProperty(value.tables.pipeline_item_leases[0], column);
    await expect(capture(value)).rejects.toThrow();
  });

  const malformed: Array<[string, (value: ReplayItemState) => void]> = [
    ["stage unknown column", value => { Object.assign(value.tables.pipeline_stage_modes[0], { future_column: true }); }],
    ["item unknown column", value => { Object.assign(secondRow(value), { future_column: true }); }],
    ["binding unknown field", value => { Object.assign(secondRow(value).binding, { authority: true }); }],
    ["top-level verified flag", value => { Object.assign(value, { verified: true }); }],
    ["unknown table", value => { Object.assign(value.tables, { jobs: [] }); }],
    ["incomplete stage universe", value => { value.tables.pipeline_stage_modes.pop(); }],
    ["duplicate stage", value => { value.tables.pipeline_stage_modes.push(structuredClone(value.tables.pipeline_stage_modes[0])); }],
    ["duplicate item tuple", value => { value.tables.pipeline_item_leases.push(structuredClone(secondRow(value))); }],
    ["binding identity mismatch", value => { secondRow(value).work_key = "ai2:999"; }],
    ["binding hash mismatch", value => { secondRow(value).binding_hash = "f".repeat(64); }],
    ["invalid source product generation", value => { const binding = secondRow(value).binding;
      if (binding.stage === "ai2" && binding.source.kind === "published") binding.source.productId = 0; }],
    ["unsafe item epoch", value => { secondRow(value).item_epoch = Number.MAX_SAFE_INTEGER + 1; }],
    ["unsafe stage epoch", value => { value.tables.pipeline_stage_modes[0].epoch = Number.MAX_SAFE_INTEGER + 1; }],
    ["invalid calendar", value => { secondRow(value).updated_at = "2026-02-29T00:00:00.000Z"; }],
    ["hydrated Date", value => { Object.assign(secondRow(value), { created_at: new Date(utc) }); }],
  ];
  it.each(malformed)("fails closed on %s", async (_label, change) => {
    const input = payload(); change(input); const boundary = sqlResult([{ state: input }]);
    await expect(captureReplayItemState(boundary.tx)).rejects.toThrow();
    expect(boundary.calls).toHaveLength(1);
  });

  it.each(["owner_instance_id", "owner_boot_id", "token", "lease_until"] as const)("rejects partial-null owner column %s", async column => {
    const input = payload(); secondRow(input)[column] = null;
    await expect(capture(input)).rejects.toThrow();
  });

  it.each([
    ["no rows", []], ["two rows", [{ state: payload() }, { state: payload() }]],
    ["null result", null], ["undefined result", undefined], ["primitive result", "not SQL rows"],
    ["missing state alias", [{}]], ["null state", [{ state: null }]], ["primitive state", [{ state: 1 }]],
    ["array-like object", { length: 1, 0: { state: payload() } }],
  ])("rejects invalid database result: %s", async (_label, result) => {
    const boundary = sqlResult(result);
    await expect(captureReplayItemState(boundary.tx)).rejects.toThrow();
    expect(boundary.calls).toHaveLength(1);
  });

  it.each([
    ["57014", "canceling statement due to user request"], ["42501", "permission denied for table pipeline_item_leases"],
    ["55P03", "canceling statement due to lock timeout"], ["08006", "connection failure"],
  ])("propagates original SQLSTATE %s error identity without retry/default", async (code, message) => {
    const original = Object.assign(new Error(message), { code }), boundary = sqlResult(undefined, original);
    await expect(captureReplayItemState(boundary.tx)).rejects.toBe(original);
    expect(boundary.calls).toHaveLength(1);
  });

  it("propagates the original rejected value even when the driver does not throw Error", async () => {
    const original = Object.freeze({ code: "57014", detail: "original driver rejection" });
    await expect(captureReplayItemState(sqlResult(undefined, original).tx)).rejects.toBe(original);
  });

  it("retains all six and twelve expected raw columns in the independent fixture", () => {
    const value = payload();
    expect(Object.keys(value.tables.pipeline_stage_modes[0])).toHaveLength(6);
    expect(Object.keys(value.tables.pipeline_item_leases[0])).toHaveLength(12);
    expect(value.tables.pipeline_stage_modes.every(row => row.updated_at === rawAt)).toBe(true);
    const first: StageRow = value.tables.pipeline_stage_modes[0]; expect(first.writer_contract_version).toBe(0);
  });
});
