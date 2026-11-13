import { expect, it } from "vitest";
import { judgeExitedCaller } from "@/lib/operations/dr/exited-caller-contract";
import type { ProcessGroupEvent } from "@/lib/operations/dr/call-drain";
import { parseOwnerGoneCliArgs } from "@/scripts/ops/model-owner-gone";

const events: ProcessGroupEvent[] = [
  { kind: "owner_opened", seq: 0, runId: null, pid: null, recordedAtMs: 1000 },
  { kind: "spawn_intent", seq: 1, runId: "a", pid: null, recordedAtMs: 2000 },
  { kind: "spawned", seq: 1, runId: "a", pid: 10, recordedAtMs: 2001 },
  { kind: "group_exited", seq: 1, runId: "a", pid: 10, recordedAtMs: 4000 },
  { kind: "spawn_intent", seq: 2, runId: "b", pid: null, recordedAtMs: 5000 },
  { kind: "spawned", seq: 2, runId: "b", pid: 11, recordedAtMs: 5001 },
];
const input = { bindingKind: "search_verify_gateway", bindingHash: "b".repeat(64),
  dispatchAt: new Date(3000).toISOString(), now: new Date(6000).toISOString(), events };

it("proves the dispatched caller exited even when a later child and the same supervisor remain alive", () => {
  expect(judgeExitedCaller(input)).toEqual({ ended: true, exitedAt: new Date(4000).toISOString() });
});
it("requires every possible child to have matching exit evidence", () => {
  expect(judgeExitedCaller({ ...input, events: events.filter(event => event.kind !== "group_exited") }))
    .toEqual({ ended: false, reason: "spawn_not_exited:1" });
  expect(judgeExitedCaller({ ...input, events: events.map(event => event.kind === "group_exited" ? { ...event, pid: 20 } : event) }))
    .toEqual({ ended: false, reason: "exit_mismatch:1" });
  expect(judgeExitedCaller({ ...input, events: events.filter(event => event.seq !== 1) }))
    .toEqual({ ended: false, reason: "spawn_sequence_gap" });
});
it("refuses unverified successor observations and a caller that began before dispatch but is still alive", () => {
  expect(judgeExitedCaller({ ...input, events: events.map(event => event.kind === "group_exited"
    ? { ...event, method: "pgid_esrch_by_successor" } : event) }).ended).toBe(false);
  expect(judgeExitedCaller({ ...input, dispatchAt: new Date(5500).toISOString() }))
    .toEqual({ ended: false, reason: "spawn_not_exited:2" });
});
it("refuses CLI, unknown or unbound calls, missing time, future exit and exits before dispatch", () => {
  for (const bindingKind of [null, "unknown", "review_cli"]) expect(judgeExitedCaller({ ...input, bindingKind }).ended).toBe(false);
  expect(judgeExitedCaller({ ...input, bindingHash: null }).ended).toBe(false);
  expect(judgeExitedCaller({ ...input, dispatchAt: null }).ended).toBe(false);
  expect(judgeExitedCaller({ ...input, now: new Date(3500).toISOString() }).ended).toBe(false);
  expect(judgeExitedCaller({ ...input, dispatchAt: new Date(4500).toISOString() }).ended).toBe(false);
});
it("exited-caller CLI defaults to dry-run with explicit IDs and no time-based bypass option", () => {
  const args = ["mark-exited-caller", "--request=69781c87-fc49-40d6-af75-db39343102a7", "--operator=jr", "--database-url-stdin"];
  expect(parseOwnerGoneCliArgs(args)).toMatchObject({ command: "mark-exited-caller", apply: false });
  expect(() => parseOwnerGoneCliArgs([...args, "--quiet-minutes=1"])).toThrow("owner_gone_cli_unknown_option");
  expect(() => parseOwnerGoneCliArgs(["mark-exited-caller", "--operator=jr", "--database-url-stdin"]))
    .toThrow("owner_gone_cli_missing_request");
});
