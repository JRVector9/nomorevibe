import { describe, expect, it } from "vitest";
import { judgeOwnerGone, OWNER_GONE_QUIET_MS, ownerGoneEvidenceSchema, summarizeBoot, type OwnerFact, type OwnerGoneInput } from "@/lib/operations/dr/owner-gone-contract";
import { parseOwnerGoneCliArgs } from "@/scripts/ops/model-owner-gone";

const OLD = "11111111-1111-4111-8111-111111111111", NEW = "22222222-2222-4222-8222-222222222222", PREV = "33333333-3333-4333-8333-333333333333";
const K1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", K2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DISPATCH = "2026-11-01T14:21:00.000Z", NOW = "2026-11-02T14:50:00.000Z";
const fact = (bootId: string, source: OwnerFact["source"], at: string, extra: Partial<OwnerFact> = {}): OwnerFact =>
  ({ bootId, source, at, live: false, detail: null, ...extra });
const ownerHistory: OwnerFact[] = [
  fact(OLD, "process_group_opened", "2026-11-01T10:00:00.000Z", { detail: { version: 1, kernelBootId: K1, pidNamespace: 4026532001 } }),
  fact(OLD, "process_group_event", "2026-11-01T14:20:59.000Z", { detail: { unexitedSpawns: 1 } }),
  fact(OLD, "ledger_activity", DISPATCH),
  fact(OLD, "role_lease", "2026-11-01T15:20:00.000Z", { detail: { role: "text" } }),
];
const successorHistory: OwnerFact[] = [
  fact(NEW, "process_group_opened", "2026-11-02T14:00:00.000Z", { detail: { version: 1, kernelBootId: K2, pidNamespace: 4026532001 } }),
  fact(NEW, "role_lease", "2026-11-02T14:49:50.000Z", { live: true, detail: { role: "text" } }),
  fact(NEW, "candidate_observation", "2026-11-02T14:49:55.000Z", { detail: { key: "candidate:text:m3-text" } }),
];
const input = (facts: OwnerFact[], overrides: Partial<OwnerGoneInput> = {}): OwnerGoneInput => ({ state: "dispatched", dispatchAt: DISPATCH,
  owner: { instanceId: "m3-text", bootId: OLD }, now: NOW, quietMs: OWNER_GONE_QUIET_MS.default, facts, ...overrides });

describe("judgeOwnerGone", () => {
  it("a successor boot of the same instance that started after the dispatch and is the instance's latest record proves the owner gone", () => {
    const verdict = judgeOwnerGone(input([...ownerHistory, ...successorHistory]));
    expect(verdict).toMatchObject({ status: "gone", basis: ["successor_boot"], ownerLastSeen: { at: "2026-11-01T15:20:00.000Z", source: "role_lease" } });
    if (verdict.status !== "gone") throw new Error("not_gone");
    expect(verdict.owner).toMatchObject({ kernelBootId: K1, unexitedSpawns: 1, liveHold: null, exitRecordedAt: null });
    expect(verdict.successor).toMatchObject({ bootId: NEW, kernelBootId: K2, roleLease: "text",
      firstStart: { at: "2026-11-02T14:00:00.000Z", source: "process_group_opened" }, lastSeen: { source: "candidate_observation" } });
  });

  it("refuses when the owner boot still holds an unexpired role or item lease", () => {
    const live = fact(OLD, "role_lease", "2026-11-01T15:20:00.000Z", { live: true, detail: { role: "text" } });
    expect(judgeOwnerGone(input([...ownerHistory.slice(0, 3), live, ...successorHistory]))).toMatchObject({ status: "refused", reason: "owner_holds_role_lease" });
    const item = fact(OLD, "item_lease", "2026-11-01T15:00:00.000Z", { live: true });
    expect(judgeOwnerGone(input([...ownerHistory, item, ...successorHistory]))).toMatchObject({ status: "refused", reason: "owner_holds_item_lease" });
  });

  it("refuses when the owner boot left any record inside the quiet window, even with a successor", () => {
    const recent = fact(OLD, "candidate_observation", "2026-11-02T14:45:00.000Z");
    expect(judgeOwnerGone(input([...ownerHistory, recent, ...successorHistory]))).toMatchObject({ status: "refused", reason: "owner_seen_recently",
      ownerLastSeen: { at: "2026-11-02T14:45:00.000Z" } });
    // 전송 자체가 생존 기록이다 — 막 보낸 행은 기록이 없어도 quiet 창 전에는 바꾸지 않는다.
    expect(judgeOwnerGone(input([], { dispatchAt: "2026-11-02T14:40:00.000Z" }))).toMatchObject({ status: "refused", reason: "owner_seen_recently" });
  });

  it("silence alone is not evidence: no other boot, or another boot that started before the dispatch, refuses", () => {
    expect(judgeOwnerGone(input(ownerHistory))).toMatchObject({ status: "refused", reason: "no_successor_boot" });
    const earlier = [fact(PREV, "process_group_opened", "2026-11-01T09:00:00.000Z"), fact(PREV, "candidate_observation", "2026-11-02T14:49:00.000Z")];
    expect(judgeOwnerGone(input([...ownerHistory, ...earlier]))).toMatchObject({ status: "refused", reason: "no_successor_boot" });
    // 시작 기록 없이 관측만 있는 boot 는 언제 시작했는지 모른다.
    expect(judgeOwnerGone(input([...ownerHistory, fact(NEW, "candidate_observation", "2026-11-02T14:49:00.000Z")])))
      .toMatchObject({ status: "refused", reason: "no_successor_boot" });
  });

  it("refuses when the owner boot's last record is newer than every successor record", () => {
    const quietSuccessor = [fact(NEW, "process_group_opened", "2026-11-01T14:30:00.000Z")];
    const ownerLater = fact(OLD, "role_lease", "2026-11-01T16:00:00.000Z", { detail: { role: "text" } });
    expect(judgeOwnerGone(input([...ownerHistory, ownerLater, ...quietSuccessor]))).toMatchObject({ status: "refused", reason: "owner_newer_than_successor",
      successor: { bootId: NEW } });
  });

  it("a role lease acquisition by another boot of the instance after the dispatch also counts as a successor start", () => {
    const acquired = [fact(NEW, "role_lease_acquired", "2026-11-02T14:01:00.000Z", { detail: { role: "text" } }),
      fact(NEW, "role_lease", "2026-11-02T14:49:00.000Z", { live: true, detail: { role: "text" } })];
    expect(judgeOwnerGone(input([...ownerHistory, ...acquired]))).toMatchObject({ status: "gone", basis: ["successor_boot"],
      successor: { firstStart: { source: "role_lease_acquired" }, roleLease: "text" } });
  });

  it("the owner's own exit record after the dispatch is positive evidence on its own", () => {
    const exit = fact(OLD, "worker_exit", "2026-11-01T15:25:00.000Z", { detail: { key: `worker-exit:text:${OLD}` } });
    expect(judgeOwnerGone(input([...ownerHistory, exit]))).toMatchObject({ status: "gone", basis: ["owner_exit_record"], successor: null,
      ownerLastSeen: { at: "2026-11-01T15:25:00.000Z", source: "worker_exit" } });
    expect(judgeOwnerGone(input([...ownerHistory, exit, ...successorHistory]))).toMatchObject({ status: "gone", basis: ["successor_boot", "owner_exit_record"] });
    const before = fact(OLD, "worker_exit", "2026-11-01T14:00:00.000Z");
    expect(judgeOwnerGone(input([...ownerHistory, before]))).toMatchObject({ status: "refused", reason: "no_successor_boot" });
  });

  it("does not judge rows that are not dispatched, without a dispatch time, with truncated facts or an invalid quiet window", () => {
    expect(judgeOwnerGone(input(successorHistory, { state: "indeterminate" }))).toEqual({ status: "not_dispatched", state: "indeterminate" });
    expect(judgeOwnerGone(input(successorHistory, { state: "settled" }))).toEqual({ status: "not_dispatched", state: "settled" });
    expect(judgeOwnerGone(input(successorHistory, { dispatchAt: null }))).toMatchObject({ status: "refused", reason: "dispatch_time_unknown" });
    expect(judgeOwnerGone(input([...ownerHistory, ...successorHistory], { truncated: true }))).toMatchObject({ status: "refused", reason: "owner_facts_truncated" });
    expect(judgeOwnerGone(input([...ownerHistory, ...successorHistory], { quietMs: 60_000 }))).toMatchObject({ status: "refused", reason: "quiet_window_invalid" });
  });

  it("summarizeBoot keeps the earliest start, latest record and the largest unexited count of one boot only", () => {
    expect(summarizeBoot(OLD, [...ownerHistory, ...successorHistory, fact(OLD, "process_group_opened", "2026-11-01T11:00:00.000Z")])).toEqual({
      bootId: OLD, firstStart: { at: "2026-11-01T10:00:00.000Z", source: "process_group_opened" },
      lastSeen: { at: "2026-11-01T15:20:00.000Z", source: "role_lease" }, liveHold: null, roleLease: null, exitRecordedAt: null, kernelBootId: K1, unexitedSpawns: 1 });
  });

  it("the evidence schema is strict", () => {
    const evidence = { version: 1, kind: "owner_gone", requestId: "578b94ac-1865-4ec5-8047-3471472c642b", owner: { instanceId: "m3-text", bootId: OLD },
      fromState: "dispatched", dispatchAt: DISPATCH, evaluatedAt: NOW, quietMs: OWNER_GONE_QUIET_MS.default, basis: ["successor_boot"],
      ownerLastSeen: { at: DISPATCH, source: "ledger_activity" }, ownerExitRecordedAt: null, ownerKernelBootId: K1, unexitedSpawns: 1,
      successor: { bootId: NEW, firstStart: { at: "2026-11-02T14:00:00.000Z", source: "process_group_opened" },
        lastSeen: { at: "2026-11-02T14:49:55.000Z", source: "candidate_observation" }, kernelBootId: K2, roleLease: "text" }, operator: "jr" };
    expect(ownerGoneEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(ownerGoneEvidenceSchema.safeParse({ ...evidence, extra: 1 }).success).toBe(false);
    expect(ownerGoneEvidenceSchema.safeParse({ ...evidence, basis: [] }).success).toBe(false);
    expect(ownerGoneEvidenceSchema.safeParse({ ...evidence, fromState: "indeterminate" }).success).toBe(false);
  });
});

describe("parseOwnerGoneCliArgs", () => {
  const A = "578b94ac-1865-4ec5-8047-3471472c642b", B = "aac34be2-2094-41a8-9a66-99c0c75e56b1";
  it("mark takes explicit request ids, an operator and defaults to dry-run with a 30 minute quiet window", () => {
    expect(parseOwnerGoneCliArgs(["mark", `--request=${A}`, `--request=${B}`, "--operator=jr", "--database-url-stdin"]))
      .toEqual({ command: "mark", apply: false, requestIds: [A, B], operator: "jr", quietMs: 30 * 60_000 });
    expect(parseOwnerGoneCliArgs(["mark", `--request=${A}`, "--operator=jr", "--quiet-minutes=60", "--apply", "--database-url-stdin"]))
      .toMatchObject({ apply: true, quietMs: 60 * 60_000 });
  });
  it("close-review needs a note", () => {
    expect(parseOwnerGoneCliArgs(["close-review", `--request=${A}`, "--operator=jr", "--note=소유 프로세스 부재 확인", "--database-url-stdin"]))
      .toEqual({ command: "close-review", apply: false, requestIds: [A], operator: "jr", note: "소유 프로세스 부재 확인" });
    expect(() => parseOwnerGoneCliArgs(["close-review", `--request=${A}`, "--operator=jr", "--database-url-stdin"])).toThrow("owner_gone_cli_missing_note");
  });
  it.each([
    [["mark", `--request=${A}`, "--operator=jr"], "owner_gone_cli_database_url_stdin_required"],
    [["mark", "--operator=jr", "--database-url-stdin"], "owner_gone_cli_missing_request"],
    [["mark", `--request=${A}`, "--database-url-stdin"], "owner_gone_cli_missing_operator"],
    [["mark", `--request=${A}`, `--request=${A}`, "--operator=jr", "--database-url-stdin"], "owner_gone_cli_duplicate_request"],
    [["mark", "--request=all", "--operator=jr", "--database-url-stdin"], "owner_gone_cli_invalid_request"],
    [["mark", `--request=${A}`, "--operator=jr", "--quiet-minutes=5", "--database-url-stdin"], "owner_gone_cli_invalid_quiet_minutes"],
    [["mark", `--request=${A}`, "--operator=jr", "--apply=yes", "--database-url-stdin"], "owner_gone_cli_invalid_option"],
    [["mark", `--request=${A}`, "--operator=jr", "--note=x", "--database-url-stdin"], "owner_gone_cli_unknown_option"],
    [["mark", `--request=${A}`, "--operator=jr", "--database-url=postgres://x", "--database-url-stdin"], "owner_gone_cli_unknown_option"],
    [["mark", `--request=${A}`, "--operator=jr", "--operator=other", "--database-url-stdin"], "owner_gone_cli_duplicate_option"],
    [["reclaim", "--database-url-stdin"], "owner_gone_cli_unknown_command"],
  ])("rejects %j", (args, code) => { expect(() => parseOwnerGoneCliArgs(args)).toThrow(code); });
  it("caps one run at 20 explicit ids", () => {
    const ids = Array.from({ length: 21 }, (_, i) => `--request=00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(() => parseOwnerGoneCliArgs(["mark", ...ids, "--operator=jr", "--database-url-stdin"])).toThrow("owner_gone_cli_invalid_request");
  });
});
