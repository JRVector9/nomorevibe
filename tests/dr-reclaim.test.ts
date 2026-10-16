import { beforeEach, expect, it, vi } from "vitest";
import { modelDispatchReleaseEvidenceSchema } from "@/lib/llm/capacity";
import type { ModelDispatchReleaseCandidate } from "@/lib/llm/capacity-repository";
import type { ProcessGroupEvent } from "@/lib/operations/dr/call-drain";
import type { EvidenceRecord, PromotionRecord } from "@/lib/operations/dr/promotion";

// reclaim.ts 의 판정만 본다: 장부 hook 이 넘긴 잠긴 행 사실 + 같은 TX 의 근거 → 회수 근거 또는 막힌 이유. 실제 DB 는 integration 이 본다.
const state = vi.hoisted(() => ({ ids: [] as string[], candidates: new Map<string, unknown>(), events: [] as unknown[], active: true,
  promoted: null as unknown, verdicts: [] as unknown[] }));
vi.mock("@/lib/llm/capacity-repository", () => ({
  releaseModelDispatchWithEvidence: async (_tx: unknown, id: string, verify: (candidate: unknown) => Promise<{ blocked?: string }>) => {
    const verdict = await verify(state.candidates.get(id)); state.verdicts.push(verdict);
    return "blocked" in verdict ? { kind: "blocked", reason: verdict.blocked } : { kind: "released", evidence: modelDispatchReleaseEvidenceSchema.parse(verdict) };
  },
}));
vi.mock("@/lib/operations/dr/repository", async original => ({ ...await original<typeof import("@/lib/operations/dr/repository")>(),
  drTransactionMaybeDry: async (_apply: boolean, load: (tx: unknown) => Promise<unknown>) => load({ execute: async () => state.ids.map(request_id => ({ request_id })) }),
  readProcessGroupEvents: async () => state.events, lockPromotedState: async () => state.promoted }));
vi.mock("@/lib/operations/dr/epoch", async original => ({ ...await original<typeof import("@/lib/operations/dr/epoch")>(),
  writerSiteActive: async () => state.active }));
import { releaseDrainedDispatches, releaseProcessExitedDispatches } from "@/lib/operations/dr/reclaim";

const T0 = Date.parse("2026-10-17T00:00:00.000Z"), at = (ms: number) => new Date(ms).toISOString();
const owner = { instanceId: "m3-reviewer", bootId: "0a6bd6a3-6c2a-4f6e-9a39-2d6f7b0e5c21" };
const runId = "6d7f0f53-4d39-4b9d-a5a6-3a4a8f0c1b11", promotionId = "3f0c8a52-91c4-4d1e-9a51-6b8f9d3c2e10";
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const candidate = (n: number, change: Partial<ModelDispatchReleaseCandidate> = {}): ModelDispatchReleaseCandidate => ({ requestId: id(n), owner, state: "dispatched",
  providerBudgetId: "acct", dispatchAt: at(T0 + 1_000), bindingHash: null, now: at(T0 + 10_000), oldGeneration: true, ...change });
const event = (kind: ProcessGroupEvent["kind"], seq: number, ms: number, pid: number | null = null): ProcessGroupEvent =>
  ({ kind, seq, runId: kind === "owner_opened" ? null : runId, pid, recordedAtMs: T0 + ms });
beforeEach(() => { state.ids = []; state.candidates.clear(); state.events = []; state.active = true; state.verdicts = []; });

it("process exit: refuses without a declared policy, dispatch time, or ESRCH for every possible group; never releases on a fenced site", async () => {
  const policies = new Map([["acct", { termination: "client_bound" as const, hardDeadlineMs: null, skewBoundMs: 1, reference: "local client" }]]);
  state.ids = [id(1), id(2), id(3)];
  state.candidates.set(id(1), candidate(1, { providerBudgetId: "unknown" }));
  state.candidates.set(id(2), candidate(2, { dispatchAt: null }));
  state.candidates.set(id(3), candidate(3));
  state.events = [event("owner_opened", 0, 0), event("spawn_intent", 1, 100), event("spawned", 1, 200, 4242)];
  expect(await releaseProcessExitedDispatches({ owner, policies, operator: "root" }, true)).toEqual({ rows: [
    { requestId: id(1), released: false, reason: "provider_deadline_unknown" }, { requestId: id(2), released: false, reason: "dispatch_time_unknown" },
    { requestId: id(3), released: false, reason: "spawn_not_exited:1" }] });
  state.active = false;
  await expect(releaseProcessExitedDispatches({ owner, policies, operator: "root" }, true)).rejects.toThrow("dr_writer_site_fenced");
});

it("process exit: binds the exits of every intent recorded up to dispatch, the proven deadline and this TX clock", async () => {
  const policies = new Map([["acct", { termination: "provider_bound" as const, hardDeadlineMs: 5_000, skewBoundMs: 500, reference: "gateway hard timeout" }]]);
  state.ids = [id(1)]; state.candidates.set(id(1), candidate(1, { now: at(T0 + 8_499) }));
  state.events = [event("owner_opened", 0, 0), event("spawn_intent", 1, 100), event("spawned", 1, 200, 4242), event("group_exited", 1, 3_000, 4242),
    // dispatch 뒤에 의도가 기록된 child 는 이 행을 보낼 수 없었다 — 근거 목록에 넣지 않는다.
    { ...event("spawn_intent", 2, 3_100), runId: owner.bootId }];
  expect((await releaseProcessExitedDispatches({ owner, policies, operator: "root" }, true)).rows).toEqual([{ requestId: id(1), released: false, reason: "waiting" }]);
  state.candidates.set(id(1), candidate(1, { now: at(T0 + 8_500) }));
  expect((await releaseProcessExitedDispatches({ owner, policies, operator: "root" }, true)).rows).toEqual([{ requestId: id(1), released: true, reason: null }]);
  expect(state.verdicts.at(-1)).toEqual({ version: 1, kind: "process_group_exit", requestId: id(1), owner, fromState: "dispatched", dispatchAt: at(T0 + 1_000),
    bindingHash: null, termination: "provider_bound", hardDeadlineMs: 5_000, skewBoundMs: 500, reference: "gateway hard timeout",
    exits: [{ seq: 1, runId, pid: 4242, exitedAt: at(T0 + 3_000) }], notBefore: at(T0 + 8_500), evaluatedAt: at(T0 + 8_500), operator: "root" });
});

it("call-drain: releases only old-generation rows whose budget scope is drained; independent or waiting scopes stay held", async () => {
  const old = { systemIdentifier: "7000000000000000001", databaseOid: "16384", databaseName: "nomorevibe" };
  const restored = { ...old, systemIdentifier: "7000000000000000002" };
  const promotion: PromotionRecord = { promotionId, planHash: "a".repeat(64), state: "promoted", dbIdentity: restored,
    plan: { version: 1, promotionId, lineageId: runId, fromEpoch: 4, knownActiveEpoch: 4, restoredDb: restored, oldDbs: [old], oldInstances: ["i1"],
      snapshotAt: at(T0), operator: "root" },
    sealSnapshot: { version: 1, sealedAt: at(T0), instances: ["i1"], modelBudgets: ["acct", "ind", "slow"], activeModelCalls: 4, activeHttpHops: 0,
      revoked: { roles: 0, jobs: 0, items: 0, sourceClaims: 0 }, modelControl: { epoch: 2, revision: 2, mode: "draining" }, httpControl: { epoch: 2, mode: "draining" } } };
  const evidence: EvidenceRecord[] = [
    { id: 1, kind: "writer_process_stopped", subject: "i1", operator: "root", payload: { version: 1, instanceId: "i1", method: "container_removed", reference: "stop",
      autoRestartDisabled: true, stoppedAt: at(T0), skewBoundMs: 1 } },
    { id: 2, kind: "provider_deadline", subject: "model:acct", operator: "root", payload: { version: 1, scope: "model:acct", termination: "provider_bound", hardDeadlineMs: 1_000, reference: "d" } },
    { id: 3, kind: "independent_budget", subject: "model:ind", operator: "root", payload: { version: 1, scope: "model:ind", replacementBudgetId: "new", reference: "r" } },
    { id: 4, kind: "provider_deadline", subject: "model:slow", operator: "root", payload: { version: 1, scope: "model:slow", termination: "provider_bound", hardDeadlineMs: 600_000, reference: "d" } }];
  state.promoted = { promotion, evidence, now: { iso: at(T0 + 5_000), ms: T0 + 5_000 } };
  state.ids = [id(1), id(2), id(3), id(4), id(5)];
  state.candidates.set(id(1), candidate(1, { now: at(T0 + 5_000) }));
  state.candidates.set(id(2), candidate(2, { providerBudgetId: "ind", now: at(T0 + 5_000) }));
  state.candidates.set(id(3), candidate(3, { providerBudgetId: "slow", now: at(T0 + 5_000) }));
  state.candidates.set(id(4), candidate(4, { providerBudgetId: "elsewhere", now: at(T0 + 5_000) }));
  state.candidates.set(id(5), candidate(5, { oldGeneration: false, now: at(T0 + 5_000) }));
  expect(await releaseDrainedDispatches({ promotionId, operator: "root" }, true)).toEqual({ rows: [
    { requestId: id(1), released: true, reason: null }, { requestId: id(2), released: false, reason: "drain_independent" },
    { requestId: id(3), released: false, reason: "drain_waiting" }, { requestId: id(4), released: false, reason: "drain_scope_missing" },
    { requestId: id(5), released: false, reason: "not_old_generation" }] });
  expect(state.verdicts[0]).toEqual({ version: 1, kind: "dr_call_drain", requestId: id(1), owner, fromState: "dispatched", dispatchAt: at(T0 + 1_000), bindingHash: null,
    promotionId, writerEpoch: 5, scope: "model:acct", notBefore: at(T0 + 1_001), evaluatedAt: at(T0 + 5_000), operator: "root" });
});
