import { describe, expect, it } from "vitest";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { itemBindingHash, itemWorkKey, type Ai2ItemBinding, type ItemBinding, type ItemStage } from "@/lib/jobs/items/types";
import { ReplayItemStateSchema, ReplayItemStateChangeSchema, canonicalReplayItemState, replayItemStateHash,
  applyReplayItemStateChanges, replayItemStateExpiries } from "@/lib/operations/pipeline-replay-item-state";
import { ReplayReadinessProjectionSchema } from "@/lib/operations/pipeline-replay-readiness";
import { parseReplayArtifact, replayArtifactFromVerified } from "@/lib/operations/pipeline-replay-artifact";

// These are structural evidence fixtures, not leases or receipts granting authority.
const at = "2026-10-16T00:00:00.123Z";
const boot = "11111111-1111-4111-8111-111111111111";
const token = "22222222-2222-4222-8222-222222222222";
const otherUuid = "33333333-3333-4333-8333-333333333333";
type Row = Record<string, unknown>;

function ai2Binding(id = 1): Ai2ItemBinding {
  return { stage: "ai2", secondReviewId: id, candidateId: 21,
    source: { kind: "first_attempt", firstAttemptId: 31 }, inputHash: "a".repeat(64),
    sourceRevisionHash: "b".repeat(64), policyHash: "c".repeat(64), promptVersion: "prompt-1", rulesVersion: "rules-1",
    reviewer: { provider: "abcllm", model: "independent-reviewer" }, generationKey: "d".repeat(64),
    vote: id, fallbackForId: null };
}
function stageRow(stage: ItemStage): Row {
  return { stage, mode: "legacy", draining_from: null, epoch: 1, writer_contract_version: 0, updated_at: at };
}
function itemRow(binding: ItemBinding = ai2Binding()): Row {
  return { stage: binding.stage, work_key: itemWorkKey(binding), binding, binding_hash: itemBindingHash(binding),
    owner_instance_id: "foreign-owner", owner_boot_id: boot, token, stage_epoch: 1, item_epoch: 3,
    lease_until: "2026-10-16T00:01:30.123Z", created_at: at, updated_at: at };
}
function state(items = [itemRow()]) {
  return { kind: "pipeline-replay-item-state", version: 1,
    tables: { pipeline_stage_modes: [stageRow("fetch"), stageRow("ai1"), stageRow("ai2")], pipeline_item_leases: items } };
}
type StateInput = ReturnType<typeof state>;
function change(operation: "INSERT" | "UPDATE" | "DELETE", oldRow: Row | null, newRow: Row | null, ordinal = 1) {
  return { table_name: "pipeline_item_leases", operation, old_row: oldRow, new_row: newRow, ordinal };
}
function freeze(value: unknown): void {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
}
const asRow = (value: unknown): Row => value as Row;

describe("strict standalone evidence", () => {
  it("preserves all three stages and a foreign, stale, expired and released row", () => {
    const expired = { ...itemRow(ai2Binding(2)), lease_until: "2001-01-01T00:00:00.000Z", stage_epoch: 1 };
    const released = { ...itemRow(ai2Binding(3)), owner_instance_id: null, owner_boot_id: null,
      token: null, lease_until: null, item_epoch: 0 };
    const input = state([itemRow(), expired, released]);
    input.tables.pipeline_stage_modes[2].epoch = 9;
    const result = canonicalReplayItemState(input);
    expect(result.tables.pipeline_stage_modes.map(row => row.stage)).toEqual(["ai1", "ai2", "fetch"]);
    expect(result.tables.pipeline_item_leases).toEqual([itemRow(), expired, released]);
    expect(result.tables.pipeline_stage_modes.find(row => row.stage === "ai2")?.epoch).toBe(9);
  });

  const malformed: Array<[string, (value: StateInput) => void]> = [
    ["unknown kind", value => { value.kind = "pipeline-replay-ledger"; }],
    ["unknown version", value => { value.version = 2; }],
    ["top-level authority flag", value => { Object.assign(value, { verified: true }); }],
    ["unknown table", value => { Object.assign(value.tables, { jobs: [] }); }],
    ["missing table", value => { Reflect.deleteProperty(value.tables, "pipeline_item_leases"); }],
    ["stage extra column", value => { value.tables.pipeline_stage_modes[0].authority = true; }],
    ["item extra column", value => { value.tables.pipeline_item_leases[0].authority = true; }],
    ["stage missing nullable column", value => { Reflect.deleteProperty(value.tables.pipeline_stage_modes[0], "draining_from"); }],
    ["item missing nullable column", value => { Reflect.deleteProperty(value.tables.pipeline_item_leases[0], "lease_until"); }],
    ["missing stage", value => { value.tables.pipeline_stage_modes.pop(); }],
    ["duplicate stage", value => { value.tables.pipeline_stage_modes.push(stageRow("ai1")); }],
    ["unknown stage", value => { value.tables.pipeline_stage_modes[0].stage = "publish"; }],
    ["draining without origin", value => { value.tables.pipeline_stage_modes[0].mode = "draining"; }],
    ["legacy with draining origin", value => { value.tables.pipeline_stage_modes[0].draining_from = "items"; }],
    ["draining origin cannot be draining", value => { Object.assign(value.tables.pipeline_stage_modes[0], { mode: "draining", draining_from: "draining" }); }],
    ["binding stage mismatch", value => { value.tables.pipeline_item_leases[0].stage = "ai1"; }],
    ["binding key mismatch", value => { value.tables.pipeline_item_leases[0].work_key = "ai2:99"; }],
    ["binding hash mismatch", value => { value.tables.pipeline_item_leases[0].binding_hash = "e".repeat(64); }],
    ["binding unknown field", value => { asRow(value.tables.pipeline_item_leases[0].binding).authority = true; }],
    ["active item without positive epoch", value => { value.tables.pipeline_item_leases[0].item_epoch = 0; }],
    ["malformed owner UUID", value => { value.tables.pipeline_item_leases[0].owner_boot_id = "not-a-uuid"; }],
    ["malformed token UUID", value => { value.tables.pipeline_item_leases[0].token = "not-a-uuid"; }],
    ["empty owner", value => { value.tables.pipeline_item_leases[0].owner_instance_id = " "; }],
  ];
  it.each(malformed)("rejects %s without stripping evidence", (_label, mutate) => {
    const input = state(); mutate(input);
    expect(ReplayItemStateSchema.safeParse(input).success).toBe(false);
    expect(() => canonicalReplayItemState(input)).toThrow();
  });

  it.each(["owner_instance_id", "owner_boot_id", "token", "lease_until"])("rejects partially null ownership: %s", field => {
    const input = state(); input.tables.pipeline_item_leases[0][field] = null;
    expect(() => canonicalReplayItemState(input)).toThrow();
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])("rejects invalid epoch/contract numbers: %s", invalid => {
    for (const field of ["epoch", "writer_contract_version"]) {
      const input = state(); input.tables.pipeline_stage_modes[0][field] = invalid;
      expect(() => canonicalReplayItemState(input), `stage ${field}`).toThrow();
    }
    for (const field of ["stage_epoch", "item_epoch"]) {
      const input = state(); input.tables.pipeline_item_leases[0][field] = invalid;
      expect(() => canonicalReplayItemState(input), `item ${field}`).toThrow();
    }
  });

  it("uses the SQL integer bound for writer contracts while allowing safe epoch bounds", () => {
    const input = state(); input.tables.pipeline_stage_modes[0].writer_contract_version = 2_147_483_647;
    input.tables.pipeline_stage_modes[0].epoch = Number.MAX_SAFE_INTEGER;
    input.tables.pipeline_item_leases[0].stage_epoch = Number.MAX_SAFE_INTEGER;
    input.tables.pipeline_item_leases[0].item_epoch = Number.MAX_SAFE_INTEGER;
    expect(canonicalReplayItemState(input).tables.pipeline_stage_modes.find(row => row.stage === "fetch")?.writer_contract_version)
      .toBe(2_147_483_647);
    input.tables.pipeline_stage_modes[0].writer_contract_version = 2_147_483_648;
    expect(() => canonicalReplayItemState(input)).toThrow();
  });

  it("rejects duplicate logical tuples even when their owner or binding differs", () => {
    const first = itemRow(), second = { ...itemRow(), token: otherUuid };
    expect(() => canonicalReplayItemState(state([first, second]))).toThrow();
  });

  it("keeps same numeric identities across stages and sorts string keys by code point", () => {
    const first: ItemBinding = { stage: "ai1", candidateId: 1, inputHash: "a".repeat(64), sourceRevisionHash: "b".repeat(64),
      policyHash: "c".repeat(64), promptVersion: "p", rulesVersion: "r", reviewer: { provider: "abcllm", model: "first" } };
    const fetch: ItemBinding = { stage: "fetch", frontierId: 1, repo: "scope/repository", claim: { attempts: 1, nextAttemptAt: at } };
    const result = canonicalReplayItemState(state([itemRow(fetch), itemRow(ai2Binding(2)), itemRow(first), itemRow(ai2Binding(10))]));
    expect(result.tables.pipeline_item_leases.map(row => [row.stage, row.work_key]))
      .toEqual([["ai1", "ai1:1"], ["ai2", "ai2:10"], ["ai2", "ai2:2"], ["fetch", "fetch:1"]]);
  });

  it("does not let standalone item state masquerade as readiness or a verified artifact", () => {
    const input = canonicalReplayItemState(state());
    expect(ReplayReadinessProjectionSchema.safeParse(input).success).toBe(false);
    expect(() => parseReplayArtifact(input)).toThrow("invalid_replay_artifact");
    expect(() => replayArtifactFromVerified(input)).toThrow("verified_replay_artifact_required");
  });
});

describe("timestamp meaning without millisecond truncation", () => {
  it.each([
    ["2026-10-16 09:00:00+09:00", "2026-10-16T00:00:00.000Z"],
    ["2026-10-16T00:00:00Z", "2026-10-16T00:00:00.000Z"],
    ["2026-10-16T00:00:00.1-00:00", "2026-10-16T00:00:00.100Z"],
    ["2026-10-16T00:00:00.123000+00:00", at],
    ["2026-10-16T00:00:00.1234Z", "2026-10-16T00:00:00.123400Z"],
    ["2026-10-16T00:00:00.000001Z", "2026-10-16T00:00:00.000001Z"],
    ["2026-01-01 00:15:00+00:30", "2025-12-31T23:45:00.000Z"],
    ["2024-02-29T23:59:59.999999Z", "2024-02-29T23:59:59.999999Z"],
    ["0099-03-01T00:00:00Z", "0099-03-01T00:00:00.000Z"],
  ])("normalizes %s to %s", (source, expected) => {
    const input = state(); input.tables.pipeline_item_leases[0].lease_until = source;
    expect(canonicalReplayItemState(input).tables.pipeline_item_leases[0].lease_until).toBe(expected);
    expect(replayItemStateExpiries(input)).toEqual([expected]);
  });

  it.each([
    "2026-02-29T00:00:00Z", "1900-02-29T00:00:00Z", "2026-04-31T00:00:00Z",
    "2026-00-01T00:00:00Z", "2026-01-00T00:00:00Z", "2026-10-16T24:00:00Z",
    "2026-10-16T00:60:00Z", "2026-10-16T00:00:60Z", "2026-10-16T00:00:00+24:00",
    "2026-10-16T00:00:00+09:60", "2026-10-16T00:00:00+0900", "2026-10-16T00:00:00",
    "2026-10-16", "2026-10-16T00:00:00.1234567Z", "2026-10-16T00:00:00.Z",
    "10000-01-01T00:00:00Z", " 2026-10-16T00:00:00Z", "2026-10-16T00:00:00Z ",
    new Date(at), null, Number.NaN,
  ])("rejects invalid or non-text timestamp %s", invalid => {
    const input = state(); input.tables.pipeline_stage_modes[0].updated_at = invalid;
    expect(() => canonicalReplayItemState(input)).toThrow();
  });

  it("hashes offset aliases equally and distinguishes an exact one-microsecond difference", () => {
    const utc = state(), offset = state(), later = state();
    utc.tables.pipeline_item_leases[0].lease_until = "2026-10-16T00:01:30.123456Z";
    offset.tables.pipeline_item_leases[0].lease_until = "2026-10-16 09:01:30.123456+09:00";
    later.tables.pipeline_item_leases[0].lease_until = "2026-10-16T00:01:30.123457Z";
    expect(replayItemStateHash(utc)).toBe(replayItemStateHash(offset));
    expect(replayItemStateHash(later)).not.toBe(replayItemStateHash(utc));
  });

  it("returns exact sorted unique expiries including old and foreign owners without adding a job tick", () => {
    const rows = [
      { ...itemRow(ai2Binding(1)), lease_until: "2026-10-16T00:00:00.000001Z" },
      { ...itemRow(ai2Binding(2)), lease_until: "2001-01-01T00:00:00Z", stage_epoch: 1 },
      { ...itemRow(ai2Binding(3)), lease_until: "2026-10-16 09:00:00.000001+09:00" },
      { ...itemRow(ai2Binding(4)), lease_until: "2026-10-16T00:00:00Z" },
      { ...itemRow(ai2Binding(5)), owner_instance_id: null, owner_boot_id: null, token: null, lease_until: null },
    ];
    expect(replayItemStateExpiries(state(rows))).toEqual([
      "2001-01-01T00:00:00.000Z", "2026-10-16T00:00:00.000Z", "2026-10-16T00:00:00.000001Z",
    ]);
  });
});

describe("whole canonical payload hash", () => {
  it("matches the whole independently ordered payload, not a selected identity allowlist", () => {
    const input = state(), expected = state();
    expected.tables.pipeline_stage_modes = [stageRow("ai1"), stageRow("ai2"), stageRow("fetch")];
    expect(replayItemStateHash(input)).toBe(reviewHash(expected));
    expect(replayItemStateHash(input)).not.toBe(reviewHash(expected.tables));
  });

  it.each([
    ["owner_instance_id", "another-owner"], ["owner_boot_id", otherUuid], ["token", otherUuid],
    ["stage_epoch", 2], ["item_epoch", 4], ["lease_until", "2026-10-16T00:01:30.123001Z"],
    ["created_at", "2026-10-16T00:00:00.123001Z"], ["updated_at", "2026-10-16T00:00:00.123001Z"],
  ])("includes item %s", (field, replacement) => {
    const input = state(), modified = state(); modified.tables.pipeline_item_leases[0][field] = replacement;
    expect(replayItemStateHash(modified)).not.toBe(replayItemStateHash(input));
  });

  it.each([
    ["mode", "items"], ["epoch", 2], ["writer_contract_version", 1], ["updated_at", "2026-10-16T00:00:00.123001Z"],
  ])("includes stage %s", (field, replacement) => {
    const input = state(), modified = state(); modified.tables.pipeline_stage_modes[0][field] = replacement;
    expect(replayItemStateHash(modified)).not.toBe(replayItemStateHash(input));
  });

  it("includes stage identity and draining origin", () => {
    const first = state(), swapped = state();
    first.tables.pipeline_stage_modes[0].updated_at = "2026-10-16T00:00:00.124Z";
    swapped.tables.pipeline_stage_modes[1].updated_at = "2026-10-16T00:00:00.124Z";
    expect(replayItemStateHash(first)).not.toBe(replayItemStateHash(swapped));
    const fromLegacy = state(), fromItems = state();
    Object.assign(fromLegacy.tables.pipeline_stage_modes[0], { mode: "draining", draining_from: "legacy" });
    Object.assign(fromItems.tables.pipeline_stage_modes[0], { mode: "draining", draining_from: "items" });
    expect(replayItemStateHash(fromLegacy)).not.toBe(replayItemStateHash(fromItems));
  });

  const bindingChanges: Array<[string, (binding: Ai2ItemBinding) => void]> = [
    ["logical work key", binding => { binding.secondReviewId = 2; binding.vote = 2; }],
    ["candidate", binding => { binding.candidateId = 22; }],
    ["first source", binding => { binding.source = { kind: "first_attempt", firstAttemptId: 32 }; }],
    ["published source generation", binding => { binding.source = { kind: "published", slug: "same-slug", productId: 41 }; }],
    ["input", binding => { binding.inputHash = "e".repeat(64); }],
    ["source revision", binding => { binding.sourceRevisionHash = "e".repeat(64); }],
    ["composite policy", binding => { binding.policyHash = "e".repeat(64); }],
    ["prompt", binding => { binding.promptVersion = "prompt-2"; }],
    ["rules", binding => { binding.rulesVersion = "rules-2"; }],
    ["provider", binding => { binding.reviewer.provider = "grok"; }],
    ["model", binding => { binding.reviewer.model = "another-model"; }],
    ["generation", binding => { binding.generationKey = "e".repeat(64); }],
    ["fallback root/vote", binding => { binding.vote = 9; binding.fallbackForId = 9; }],
  ];
  it.each(bindingChanges)("includes binding and its hash: %s", (_label, mutate) => {
    const binding = ai2Binding(); mutate(binding);
    expect(replayItemStateHash(state([itemRow(binding)]))).not.toBe(replayItemStateHash(state()));
  });

  it("distinguishes same-slug product generations and item stage identities", () => {
    const first = ai2Binding(), second = ai2Binding();
    first.source = { kind: "published", slug: "same-slug", productId: 41 };
    second.source = { kind: "published", slug: "same-slug", productId: 42 };
    expect(replayItemStateHash(state([itemRow(first)]))).not.toBe(replayItemStateHash(state([itemRow(second)])));
    const fetch: ItemBinding = { stage: "fetch", frontierId: 1, repo: "scope/repository", claim: { attempts: 1, nextAttemptAt: at } };
    expect(replayItemStateHash(state([itemRow(fetch)]))).not.toBe(replayItemStateHash(state()));
  });
});

describe("atomic full OLD/NEW replay", () => {
  it("replays claim, heartbeat and release in ordinal order without retaining aliases", () => {
    const initial = state([]), claimed = itemRow(), renewed = { ...claimed, lease_until: "2026-10-16T00:02:00.123Z" };
    const released = { ...renewed, owner_instance_id: null, owner_boot_id: null, token: null, lease_until: null };
    const changes = [change("INSERT", null, claimed), change("UPDATE", claimed, renewed, 2), change("UPDATE", renewed, released, 3)];
    const original = structuredClone(initial), originalChanges = structuredClone(changes);
    freeze(initial); freeze(changes);
    const result = applyReplayItemStateChanges(initial, changes);
    expect(result.tables.pipeline_item_leases).toEqual([released]);
    expect(replayItemStateExpiries(result)).toEqual([]);
    expect(initial).toEqual(original); expect(changes).toEqual(originalChanges);
    const returnedBinding = result.tables.pipeline_item_leases[0].binding;
    if (returnedBinding.stage !== "ai2") throw new Error("unexpected_test_binding");
    returnedBinding.reviewer = { provider: "other", model: "other" };
    expect(changes).toEqual(originalChanges);
  });

  it("compares canonical OLD timestamps by their exact instant", () => {
    const old = itemRow(), equivalent = { ...old, updated_at: "2026-10-16 09:00:00.123000+09:00" };
    const result = applyReplayItemStateChanges(state([old]), [change("UPDATE", equivalent, { ...old, item_epoch: 4 })]);
    expect(result.tables.pipeline_item_leases[0].item_epoch).toBe(4);
  });

  it.each(["owner_instance_id", "owner_boot_id", "token", "stage_epoch", "item_epoch", "lease_until", "created_at", "updated_at"])
    ("rejects a stale full OLD %s even when the primary key matches", field => {
      const old = itemRow(), incorrect = { ...old };
      incorrect[field] = field === "owner_instance_id" ? "other-owner"
        : field === "owner_boot_id" || field === "token" ? otherUuid
          : field.endsWith("epoch") ? 9 : "2026-10-16T00:00:00.123001Z";
      for (const operation of ["UPDATE", "DELETE"] as const) {
        const input = state(), before = structuredClone(input);
        expect(() => applyReplayItemStateChanges(input, [change(operation, incorrect, operation === "UPDATE" ? old : null)])).toThrow();
        expect(input).toEqual(before);
      }
    });

  it("checks binding contents in OLD rather than accepting a valid different binding/hash pair", () => {
    const binding = ai2Binding(); binding.policyHash = "e".repeat(64);
    const input = state(), forgedOld = itemRow(binding);
    expect(() => applyReplayItemStateChanges(input, [change("DELETE", forgedOld, null)])).toThrow();
    expect(input).toEqual(state());
  });

  it("rejects moving either a stage or item key in an UPDATE", () => {
    const initial = state(), old = initial.tables.pipeline_stage_modes[0];
    expect(() => applyReplayItemStateChanges(initial, [{ table_name: "pipeline_stage_modes", operation: "UPDATE",
      old_row: old, new_row: { ...old, stage: "ai1" }, ordinal: 1 }])).toThrow();
    expect(() => applyReplayItemStateChanges(initial, [change("UPDATE", itemRow(), itemRow(ai2Binding(2)))])).toThrow();
  });

  it("requires the final three-stage universe even after otherwise valid changes", () => {
    const input = state(), before = structuredClone(input), old = input.tables.pipeline_stage_modes[0];
    expect(() => applyReplayItemStateChanges(input, [{ table_name: "pipeline_stage_modes", operation: "DELETE",
      old_row: old, new_row: null, ordinal: 1 }])).toThrow();
    expect(input).toEqual(before);
  });

  it("can replace a stage only through DELETE and INSERT with a valid final universe", () => {
    const input = state(), old = input.tables.pipeline_stage_modes[0], next = { ...old, mode: "items", epoch: 2 };
    const result = applyReplayItemStateChanges(input, [
      { table_name: "pipeline_stage_modes", operation: "DELETE", old_row: old, new_row: null, ordinal: 1 },
      { table_name: "pipeline_stage_modes", operation: "INSERT", old_row: null, new_row: next, ordinal: 2 },
    ]);
    expect(result.tables.pipeline_stage_modes.find(row => row.stage === "fetch")?.epoch).toBe(2);
  });

  it.each([[2], [1, 3], [2, 1], [1, 1], [0], [-1], [Number.MAX_SAFE_INTEGER + 1], [Number.NaN], [Number.POSITIVE_INFINITY]]
    .map(ordinals => ({ ordinals })))
    ("rejects non-contiguous positive ordinals $ordinals", ({ ordinals }) => {
      const input = state([]), before = structuredClone(input);
      const changes = ordinals.map((ordinal, index) => change("INSERT", null, itemRow(ai2Binding(index + 1)), ordinal));
      expect(() => applyReplayItemStateChanges(input, changes)).toThrow();
      expect(input).toEqual(before);
    });

  it.each([
    ["INSERT", itemRow(), itemRow()], ["INSERT", null, null],
    ["UPDATE", null, itemRow()], ["UPDATE", itemRow(), null],
    ["DELETE", null, null], ["DELETE", itemRow(), itemRow()],
  ])("rejects invalid %s OLD/NEW null combination", (operation, old, next) => {
    const value = { table_name: "pipeline_item_leases", operation, old_row: old, new_row: next, ordinal: 1 };
    expect(ReplayItemStateChangeSchema.safeParse(value).success).toBe(false);
    expect(() => applyReplayItemStateChanges(state(), [value])).toThrow();
  });

  it("rejects duplicate INSERT and missing UPDATE/DELETE keys", () => {
    expect(() => applyReplayItemStateChanges(state(), [change("INSERT", null, itemRow())])).toThrow();
    expect(() => applyReplayItemStateChanges(state([]), [change("UPDATE", itemRow(), itemRow())])).toThrow();
    expect(() => applyReplayItemStateChanges(state([]), [change("DELETE", itemRow(), null)])).toThrow();
  });

  it("rejects unknown table/operation/column and incomplete OLD rows", () => {
    const valid = change("UPDATE", itemRow(), itemRow());
    for (const invalid of [
      { ...valid, table_name: "jobs" }, { ...valid, operation: "UPSERT" }, { ...valid, trusted: true },
      { ...valid, old_row: { stage: "ai2", work_key: "ai2:1" } },
    ]) {
      expect(ReplayItemStateChangeSchema.safeParse(invalid).success).toBe(false);
      expect(() => applyReplayItemStateChanges(state(), [invalid])).toThrow();
    }
  });

  it("does not mutate caller inputs when a later change fails", () => {
    const input = state([]), first = itemRow(), second = itemRow(ai2Binding(2));
    const changes = [change("INSERT", null, first), change("UPDATE", second, second, 2)];
    const before = structuredClone({ input, changes });
    freeze(input); freeze(changes);
    expect(() => applyReplayItemStateChanges(input, changes)).toThrow();
    expect({ input, changes }).toEqual(before);
  });

  it("returns copies for canonicalization and empty replay without mutating the caller", () => {
    const input = state(), before = structuredClone(input); freeze(input);
    const canonical = canonicalReplayItemState(input), replayed = applyReplayItemStateChanges(input, []);
    const returnedBinding = canonical.tables.pipeline_item_leases[0].binding;
    if (returnedBinding.stage !== "ai2") throw new Error("unexpected_test_binding");
    returnedBinding.reviewer.model = "changed-in-output";
    replayed.tables.pipeline_item_leases[0].owner_instance_id = "changed-in-output";
    expect(input).toEqual(before);
  });
});
