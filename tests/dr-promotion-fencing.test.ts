import { describe, expect, it } from "vitest";
import { checkWriterBinding, oldDbFencedPayloadSchema, writerFenceSchema, type DbIdentity, type WriterFence } from "@/lib/operations/dr/epoch";
import { evaluateCallDrain, evaluateLocalCallEnded, evaluateProcessReclaim, providerDeadlinePayloadSchema,
  writerProcessStoppedPayloadSchema, type ProcessGroupEvent } from "@/lib/operations/dr/call-drain";
import { evaluatePromotion, parseEvidence, promotionPlanHash, promotionPlanSchema, type EvidenceRecord,
  type PromotionPlan, type PromotionRecord } from "@/lib/operations/dr/promotion";

const lineage = "6d7f0f53-4d39-4b9d-a5a6-3a4a8f0c1b11", promotionId = "0a6bd6a3-6c2a-4f6e-9a39-2d6f7b0e5c21";
const restored: DbIdentity = { systemIdentifier: "7000000000000000002", databaseOid: "16384", databaseName: "nomorevibe" };
const old: DbIdentity = { systemIdentifier: "7000000000000000001", databaseOid: "16384", databaseName: "nomorevibe" };
const at = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-10-17T00:00:00.000Z");

describe("writer fence binding", () => {
  const fence: WriterFence = { lineageId: lineage, writerEpoch: 4, state: "active", reason: null, fencedDb: null, promotionId: null };
  it("accepts only the same lineage, same epoch and an active site", () => {
    expect(checkWriterBinding(fence, { lineageId: lineage, writerEpoch: 4 })).toEqual({ ok: true });
    expect(checkWriterBinding(fence, { lineageId: promotionId, writerEpoch: 4 })).toEqual({ ok: false, reason: "lineage_mismatch" });
    expect(checkWriterBinding(fence, { lineageId: lineage, writerEpoch: 3 })).toEqual({ ok: false, reason: "epoch_stale" });
    expect(checkWriterBinding(fence, { lineageId: lineage, writerEpoch: 5 })).toEqual({ ok: false, reason: "epoch_ahead" });
    expect(checkWriterBinding({ ...fence, state: "fenced", reason: "operator_fence", fencedDb: old }, { lineageId: lineage, writerEpoch: 4 }))
      .toEqual({ ok: false, reason: "site_fenced" });
  });
  it("rejects inconsistent fence rows and a readback fenced on another database", () => {
    expect(writerFenceSchema.safeParse({ ...fence, reason: "operator_fence" }).success).toBe(false);
    expect(writerFenceSchema.safeParse({ ...fence, state: "fenced", reason: "promotion_sealed", fencedDb: restored }).success).toBe(false);
    expect(oldDbFencedPayloadSchema.safeParse({ version: 1, db: old, lineageId: lineage, writerEpoch: 4, state: "fenced",
      fencedDb: restored, observedAt: at(T0) }).success).toBe(false);
  });
});

describe("call-drain barrier", () => {
  const stops = new Map([["m3-reviewer", { stoppedAtMs: T0, skewBoundMs: 500 }], ["mini-text", { stoppedAtMs: T0 + 2_000, skewBoundMs: 1_000 }]]);
  const base = { nowMs: T0, scopes: ["http", "model:abcllm"] as const, requiredInstances: ["m3-reviewer", "mini-text"],
    stops, deadlines: new Map(), independent: new Set<string>() };
  it("blocks every scope while any old writer lacks independent process-stop evidence", () => {
    const result = evaluateCallDrain({ ...base, requiredInstances: [...base.requiredInstances, "oracle-translation"] });
    expect(result.map(scope => [scope.scope, scope.status, scope.reason])).toEqual([
      ["http", "blocked", "writer_process_unfenced"], ["model:abcllm", "blocked", "writer_process_unfenced"]]);
    expect(evaluateCallDrain({ ...base, requiredInstances: [] }).every(scope => scope.reason === "writer_instances_undeclared")).toBe(true);
  });
  it("waits for the latest stop plus the largest skew on client-bound HTTP", () => {
    const notBefore = T0 + 2_000 + 1_000;
    expect(evaluateCallDrain({ ...base, nowMs: notBefore - 1 })[0]).toEqual({ scope: "http", status: "waiting", termination: "client_bound", notBefore: at(notBefore), reason: null });
    expect(evaluateCallDrain({ ...base, nowMs: notBefore })[0]).toEqual({ scope: "http", status: "drained", termination: "client_bound", notBefore: at(notBefore), reason: null });
  });
  it("never assumes a provider deadline: unknown blocks, independent budget opens, proven deadline waits", () => {
    expect(evaluateCallDrain({ ...base, nowMs: T0 + 3_600_000 })[1]).toEqual({ scope: "model:abcllm", status: "blocked", termination: "provider_bound", notBefore: null, reason: "provider_deadline_unknown" });
    expect(evaluateCallDrain({ ...base, independent: new Set(["model:abcllm"]) })[1].status).toBe("independent");
    const deadlines = new Map([["model:abcllm", providerDeadlinePayloadSchema.parse({ version: 1, scope: "model:abcllm", termination: "provider_bound", hardDeadlineMs: 120_000, reference: "gateway timeout config" })]]);
    const notBefore = T0 + 2_000 + 120_000 + 1_000;
    expect(evaluateCallDrain({ ...base, deadlines, nowMs: notBefore - 1 })[1]).toMatchObject({ status: "waiting", notBefore: at(notBefore) });
    expect(evaluateCallDrain({ ...base, deadlines, nowMs: notBefore })[1]).toMatchObject({ status: "drained", termination: "provider_bound" });
  });
  it("accepts only explicit, independent evidence shapes", () => {
    expect(providerDeadlinePayloadSchema.safeParse({ version: 1, scope: "http", termination: "client_bound", hardDeadlineMs: 5, reference: "x" }).success).toBe(false);
    expect(providerDeadlinePayloadSchema.safeParse({ version: 1, scope: "model:a", termination: "provider_bound", hardDeadlineMs: null, reference: "x" }).success).toBe(false);
    const stop = { version: 1, instanceId: "m3-reviewer", method: "control_plane_stopped", reference: "dokploy app idle", autoRestartDisabled: true, stoppedAt: at(T0), skewBoundMs: 500 };
    expect(writerProcessStoppedPayloadSchema.safeParse(stop).success).toBe(true);
    expect(writerProcessStoppedPayloadSchema.safeParse({ ...stop, method: "lease_expired" }).success).toBe(false);
    expect(writerProcessStoppedPayloadSchema.safeParse({ ...stop, autoRestartDisabled: false }).success).toBe(false);
  });
});

describe("D11 process-group evidence", () => {
  const run = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const opened: ProcessGroupEvent = { kind: "owner_opened", seq: 0, runId: null, pid: null, recordedAtMs: T0 };
  const intent = (seq: number, ms: number): ProcessGroupEvent => ({ kind: "spawn_intent", seq, runId: run(seq), pid: null, recordedAtMs: ms });
  const spawned = (seq: number, ms: number, pid = 100 + seq): ProcessGroupEvent => ({ kind: "spawned", seq, runId: run(seq), pid, recordedAtMs: ms });
  const exited = (seq: number, ms: number, pid = 100 + seq, runId = run(seq)): ProcessGroupEvent => ({ kind: "group_exited", seq, runId, pid, recordedAtMs: ms });
  const first = [opened, intent(1, T0 + 10), spawned(1, T0 + 20), exited(1, T0 + 900)];
  it("ends a local call only when every child that could dispatch it has ESRCH exit evidence", () => {
    expect(evaluateLocalCallEnded(first, T0 + 500)).toEqual({ ended: true, lastExitAtMs: T0 + 900 });
    // child 2 was intended after the dispatch, so it cannot have issued it.
    expect(evaluateLocalCallEnded([...first, intent(2, T0 + 1_000), spawned(2, T0 + 1_010)], T0 + 500)).toEqual({ ended: true, lastExitAtMs: T0 + 900 });
    expect(evaluateLocalCallEnded([...first, intent(2, T0 + 400), spawned(2, T0 + 410)], T0 + 500)).toEqual({ ended: false, reason: "spawn_not_exited:2" });
  });
  it("fails closed on late owner records, gaps, missing spawn rows, mismatched exits and equal timestamps", () => {
    expect(evaluateLocalCallEnded([{ ...opened, recordedAtMs: T0 + 500 }, ...first.slice(1)], T0 + 500)).toEqual({ ended: false, reason: "owner_not_opened_before_dispatch" });
    expect(evaluateLocalCallEnded([...first, intent(3, T0 + 1_000)], T0 + 500)).toEqual({ ended: false, reason: "spawn_sequence_gap" });
    expect(evaluateLocalCallEnded([opened, intent(1, T0 + 10), exited(1, T0 + 900)], T0 + 500)).toEqual({ ended: false, reason: "spawned_record_missing:1" });
    expect(evaluateLocalCallEnded([opened, intent(1, T0 + 10), spawned(1, T0 + 20), exited(1, T0 + 900, 999)], T0 + 500)).toEqual({ ended: false, reason: "exit_mismatch:1" });
    expect(evaluateLocalCallEnded([opened, intent(1, T0 + 10), spawned(1, T0 + 20), exited(1, T0 + 900, 101, run(2))], T0 + 500)).toEqual({ ended: false, reason: "exit_mismatch:1" });
    expect(evaluateLocalCallEnded([opened], T0 + 500)).toEqual({ ended: false, reason: "no_spawn_before_dispatch" });
    expect(evaluateLocalCallEnded([...first, intent(2, T0 + 500)], T0 + 500)).toEqual({ ended: false, reason: "spawn_not_exited:2" });
  });
  it("adds a proven provider deadline before reclaiming provider-bound calls and never uses TTL", () => {
    expect(evaluateProcessReclaim(first, T0 + 500, { termination: "client_bound", hardDeadlineMs: null, skewBoundMs: 1 }, T0 + 901))
      .toEqual({ reclaimable: true, notBeforeMs: T0 + 901 });
    expect(evaluateProcessReclaim(first, T0 + 500, { termination: "client_bound", hardDeadlineMs: null, skewBoundMs: 1 }, T0 + 900))
      .toEqual({ reclaimable: false, reason: "waiting", notBeforeMs: T0 + 901 });
    expect(evaluateProcessReclaim(first, T0 + 500, { termination: "provider_bound", hardDeadlineMs: null, skewBoundMs: 1 }, T0 + 99_999_999))
      .toEqual({ reclaimable: false, reason: "provider_deadline_unknown", notBeforeMs: null });
    expect(evaluateProcessReclaim(first, T0 + 500, { termination: "provider_bound", hardDeadlineMs: 60_000, skewBoundMs: 100 }, T0 + 900 + 60_100))
      .toEqual({ reclaimable: true, notBeforeMs: T0 + 900 + 60_100 });
    expect(evaluateProcessReclaim([opened, intent(1, T0 + 10)], T0 + 500, { termination: "client_bound", hardDeadlineMs: null, skewBoundMs: 1 }, T0 + 99_999_999))
      .toEqual({ reclaimable: false, reason: "spawn_not_exited:1", notBeforeMs: null });
  });
});

describe("promotion gates", () => {
  const plan: PromotionPlan = promotionPlanSchema.parse({ version: 1, promotionId, lineageId: lineage, fromEpoch: 4, knownActiveEpoch: 4,
    restoredDb: restored, oldDbs: [old], oldInstances: ["mini-text"], snapshotAt: at(T0 - 60_000), operator: "jr" });
  const promotion: PromotionRecord = { promotionId, plan, planHash: promotionPlanHash(plan), state: "sealed", dbIdentity: restored,
    sealSnapshot: { version: 1, sealedAt: at(T0 + 5_000), instances: ["m3-reviewer"], modelBudgets: ["abcllm"], activeModelCalls: 2, activeHttpHops: 1,
      revoked: { roles: 3, jobs: 2, items: 1, sourceClaims: 0 }, modelControl: { epoch: 2, revision: 2, mode: "draining" }, httpControl: { epoch: 2, mode: "draining" } } };
  const fence: WriterFence = { lineageId: lineage, writerEpoch: 4, state: "fenced", reason: "promotion_sealed", fencedDb: restored, promotionId };
  let id = 0;
  const record = (kind: EvidenceRecord["kind"], payload: unknown): EvidenceRecord => {
    const parsed = parseEvidence(kind, subjectOf(kind, payload), payload);
    return { id: ++id, kind, subject: parsed.subject, payload: parsed.payload, operator: "jr" };
  };
  const subjectOf = (kind: string, payload: unknown) => {
    const value = payload as Record<string, unknown>;
    if (kind === "old_db_fenced" || kind === "old_db_isolated") { const db = value.db as DbIdentity; return `db:${db.systemIdentifier}:${db.databaseOid}`; }
    if (kind === "writer_process_stopped") return String(value.instanceId);
    if (kind === "provider_deadline" || kind === "independent_budget") return String(value.scope);
    return "rpo-window";
  };
  const stop = (instanceId: string, ms: number) => record("writer_process_stopped", { version: 1, instanceId, method: "container_removed",
    reference: `docker rm ${instanceId}`, autoRestartDisabled: true, stoppedAt: at(ms), skewBoundMs: 1_000 });
  const complete = () => [
    record("old_db_fenced", { version: 1, db: old, lineageId: lineage, writerEpoch: 4, state: "fenced", fencedDb: old, observedAt: at(T0) }),
    stop("m3-reviewer", T0), stop("mini-text", T0 + 2_000),
    record("provider_deadline", { version: 1, scope: "model:abcllm", termination: "provider_bound", hardDeadlineMs: 120_000, reference: "gateway hard timeout" }),
    record("external_effects_reconciled", { version: 1, windowFrom: at(T0 - 60_000), windowTo: at(T0 + 2_000), method: "old_db_compared",
      reference: "publish/takedown diff", reviewed: 12, corrective: "none required" }),
  ];
  const ready = T0 + 2_000 + 120_000 + 1_000;
  it("validates the manual plan and fixed evidence subjects", () => {
    expect(promotionPlanSchema.safeParse({ ...plan, knownActiveEpoch: 5 }).success).toBe(false);
    expect(promotionPlanSchema.safeParse({ ...plan, oldDbs: [old, restored] }).success).toBe(false);
    expect(promotionPlanSchema.safeParse({ ...plan, oldDbs: [old, old] }).success).toBe(false);
    expect(() => parseEvidence("writer_process_stopped", "other", { version: 1, instanceId: "m3-reviewer", method: "container_removed",
      reference: "x", autoRestartDisabled: true, stoppedAt: at(T0), skewBoundMs: 1 })).toThrow("dr_evidence_subject_mismatch");
  });
  it("blocks promotion without independent fencing, drain and RPO reconciliation", () => {
    const result = evaluatePromotion({ promotion, fence, dbIdentity: restored, evidence: [], nowMs: ready });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(["old_db_unfenced:0", "writer_process_unfenced:m3-reviewer", "writer_process_unfenced:mini-text",
      "drain_blocked:http:writer_process_unfenced", "drain_blocked:model:abcllm:writer_process_unfenced", "external_effects_unreconciled"]);
  });
  it("is ready only after the proven deadline and skew pass on the restored database clock", () => {
    expect(evaluatePromotion({ promotion, fence, dbIdentity: restored, evidence: complete(), nowMs: ready - 1 }))
      .toMatchObject({ ready: false, blockers: ["drain_waiting:model:abcllm"] });
    const done = evaluatePromotion({ promotion, fence, dbIdentity: restored, evidence: complete(), nowMs: ready });
    expect(done).toMatchObject({ ready: true, blockers: [] });
    expect(done.drain.map(scope => [scope.scope, scope.status])).toEqual([["http", "drained"], ["model:abcllm", "drained"]]);
  });
  it("rejects a different database, a foreign seal, stale old-db evidence, uncovered windows and honours corrections", () => {
    expect(evaluatePromotion({ promotion, fence, dbIdentity: old, evidence: complete(), nowMs: ready }).blockers).toContain("promotion_not_sealed");
    expect(evaluatePromotion({ promotion, fence: { ...fence, promotionId: lineage }, dbIdentity: restored, evidence: complete(), nowMs: ready }).blockers).toContain("promotion_not_sealed");
    expect(evaluatePromotion({ promotion: { ...promotion, state: "promoted" }, fence, dbIdentity: restored, evidence: complete(), nowMs: ready }).blockers).toContain("promotion_not_sealed");
    // 정정은 기존 근거보다 뒤(id가 큼)에 기록되어야 유효하다.
    const base = complete();
    const stale = record("old_db_fenced", { version: 1, db: old, lineageId: lineage, writerEpoch: 3, state: "fenced", fencedDb: old, observedAt: at(T0) });
    expect(evaluatePromotion({ promotion, fence, dbIdentity: restored, evidence: [...base, stale], nowMs: ready }).blockers).toEqual(["old_db_unfenced:0"]);
    const isolated = record("old_db_isolated", { version: 1, db: old, method: "host_powered_off", reference: "OCI stopped", autoRestartDisabled: true, rejoinFenceRequired: true, observedAt: at(T0) });
    expect(evaluatePromotion({ promotion, fence, dbIdentity: restored, evidence: [...base.slice(1), isolated], nowMs: ready }).ready).toBe(true);
    const short = record("external_effects_reconciled", { version: 1, windowFrom: at(T0 - 60_000), windowTo: at(T0 + 1_999), method: "manual_review", reference: "x", reviewed: 0, corrective: "x" });
    expect(evaluatePromotion({ promotion, fence, dbIdentity: restored, evidence: [...base, short], nowMs: ready }).blockers).toEqual(["reconciliation_window_incomplete"]);
    const late = stop("mini-text", T0 + 3_000);
    expect(evaluatePromotion({ promotion, fence, dbIdentity: restored, evidence: [...base, late], nowMs: ready }).blockers)
      .toEqual(["drain_waiting:model:abcllm", "reconciliation_window_incomplete"]);
  });
});

describe("operator CLI parsing", async () => {
  const { parseDatabaseUrl, parsePromotionCliArgs } = await import("../scripts/ops/dr/promotion");
  const plan = { version: 1, promotionId, lineageId: lineage, fromEpoch: 1, knownActiveEpoch: 1, restoredDb: restored, oldDbs: [old],
    oldInstances: [], snapshotAt: at(T0), operator: "jr" };
  it("requires the stdin URL flag, defaults writes to dry-run and rejects URL/unknown/duplicate options", () => {
    expect(() => parsePromotionCliArgs(["status", `--promotion=${promotionId}`])).toThrow("dr_cli_database_url_stdin_required");
    expect(() => parsePromotionCliArgs(["status", `--promotion=${promotionId}`, "--database-url=postgres://u@h:1/d", "--database-url-stdin"])).toThrow("dr_cli_unknown_option");
    expect(() => parsePromotionCliArgs(["promote", `--promotion=${promotionId}`, "--operator=jr", "--apply=yes", "--database-url-stdin"])).toThrow("dr_cli_invalid_option");
    expect(() => parsePromotionCliArgs(["promote", `--promotion=${promotionId}`, `--promotion=${promotionId}`, "--operator=jr", "--database-url-stdin"])).toThrow("dr_cli_duplicate_option");
    expect(() => parsePromotionCliArgs(["unfence", "--database-url-stdin"])).toThrow("dr_cli_unknown_command");
    expect(parsePromotionCliArgs(["promote", `--promotion=${promotionId}`, "--operator=jr", "--database-url-stdin"])).toEqual({ command: "promote", apply: false, promotionId, operator: "jr" });
    expect(parsePromotionCliArgs(["promote", `--promotion=${promotionId}`, "--operator=jr", "--apply", "--database-url-stdin"])).toMatchObject({ apply: true });
  });
  it("parses fixed identities, plans and reclaim policies strictly", () => {
    expect(parsePromotionCliArgs(["fence-old", `--expect-lineage=${lineage}`, "--expect-epoch=4", `--expect-db=${old.systemIdentifier}:${old.databaseOid}:${old.databaseName}`,
      "--operator=jr", "--database-url-stdin"])).toEqual({ command: "fence-old", apply: false, operator: "jr", lineageId: lineage, writerEpoch: 4, db: old });
    expect(parsePromotionCliArgs(["seal", "--plan=plan.json", "--database-url-stdin"], () => JSON.stringify(plan))).toMatchObject({ command: "seal", apply: false, plan });
    expect(() => parsePromotionCliArgs(["seal", "--plan=plan.json", "--database-url-stdin"], () => JSON.stringify({ ...plan, knownActiveEpoch: 2 }))).toThrow();
    expect(() => parsePromotionCliArgs(["seal", "--plan=plan.json", "--database-url-stdin"], () => "{")).toThrow("dr_cli_invalid_plan_file");
    const report = parsePromotionCliArgs(["process-reclaim-report", "--instance=m3-reviewer", `--boot=${promotionId}`, "--deadline=abc:llm:120000",
      "--client-bound=claude-cli", "--skew-ms=250", "--database-url-stdin"]);
    expect(report.command === "process-reclaim-report" && [...report.policies]).toEqual([
      ["abc:llm", { termination: "provider_bound", hardDeadlineMs: 120_000, skewBoundMs: 250 }],
      ["claude-cli", { termination: "client_bound", hardDeadlineMs: null, skewBoundMs: 250 }]]);
    expect(() => parsePromotionCliArgs(["process-reclaim-report", "--instance=i", `--boot=${promotionId}`, "--deadline=a:1", "--client-bound=a", "--database-url-stdin"])).toThrow("dr_cli_invalid_deadline");
    expect(() => parsePromotionCliArgs(["process-reclaim-report", "--instance=i", `--boot=${promotionId}`, "--deadline=nodeadline", "--database-url-stdin"])).toThrow("dr_cli_invalid_deadline");
  });
  it("accepts one explicit single-host database URL line only", () => {
    expect(parseDatabaseUrl("postgres://dr@127.0.0.1:5432/nomorevibe\n")).toBe("postgres://dr@127.0.0.1:5432/nomorevibe");
    expect(parseDatabaseUrl("postgresql://dr:pw@db.internal:6432/nomorevibe?sslmode=verify-full")).toBe("postgresql://dr:pw@db.internal:6432/nomorevibe?sslmode=verify-full");
    for (const bad of ["", "postgres://dr@h/nomorevibe", "postgres://dr@a:1,b:2/nomorevibe", "postgres://dr@h:1/nomorevibe?options=-c",
      "postgres://dr@h:1/nomorevibe?sslmode=allow", "postgres://h:1/nomorevibe", "mysql://dr@h:1/x", "postgres://dr@h:1/a b", "postgres://dr@h:1/x\nsecond"])
      expect(() => parseDatabaseUrl(bad)).toThrow("dr_cli_invalid_database_url");
  });
});
