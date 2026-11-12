import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { claimHumanBatchRun, claimHumanBatchUndo, insertHumanBatchGate, latestHumanBatchGates, markHumanBatchVerdict, readHumanBatchGate,
  recentHumanBatchRuns, saveHumanBatchResult, saveHumanBatchUndo } from "@/lib/crawl/human-batch-store";
import { ensureSchema } from "./setup";

/** 0181 human_batch_gates — 관문 줄의 조건부 쓰기(표본 안의 후보만, 실행·되돌리기 한 번)와 제약 */
const H = (c: string) => c.repeat(64);
const members = [11, 12, 13].map(id => ({ id, repo: `acme/r${id}`, inputHash: H("a"), sourceRevisionHash: H("b"), candidateRevisionHash: H("c") }));
const gate = (actor = "jr", key: "agreed_approve" | "repo_deleted" = "agreed_approve") =>
  insertHumanBatchGate({ key, actor, members, snapshotHash: H("e"), sampleIds: [11, 12], excluded: [] });

beforeAll(ensureSchema);
beforeEach(async () => { await db.execute(sql`TRUNCATE human_batch_gates RESTART IDENTITY`); });

describe("human_batch_gates", () => {
  it("표본 안의 후보만 판정하고, 고칠 수 있으며, 다른 운영자의 줄은 건드리지 않는다", async () => {
    const row = await gate();
    expect(row).toMatchObject({ batchKey: "agreed_approve", actor: "jr", sampleIds: [11, 12], excluded: [], verdicts: {}, executedAt: null });
    expect(await markHumanBatchVerdict({ id: row.id, actor: "jr", candidateId: 11, verdict: "wrong" })).toBe(true);
    expect(await markHumanBatchVerdict({ id: row.id, actor: "jr", candidateId: 11, verdict: "ok" })).toBe(true);
    expect(await markHumanBatchVerdict({ id: row.id, actor: "jr", candidateId: 13, verdict: "ok" })).toBe(false);
    expect(await markHumanBatchVerdict({ id: row.id, actor: "other", candidateId: 12, verdict: "ok" })).toBe(false);
    expect((await readHumanBatchGate(row.id))!.verdicts).toEqual({ 11: "ok" });
  });

  it("실행은 한 번만 잡고, 실행한 줄의 표본은 바꾸지 못한다", async () => {
    const row = await gate();
    expect(await claimHumanBatchRun({ id: row.id, actor: "other", decision: "approve" })).toBeNull();
    const claimed = await claimHumanBatchRun({ id: row.id, actor: "jr", decision: "approve" });
    expect(claimed).toMatchObject({ id: row.id, decision: "approve" });
    expect(claimed!.executedAt).toBeInstanceOf(Date);
    expect(await claimHumanBatchRun({ id: row.id, actor: "jr", decision: "approve" })).toBeNull();
    expect(await markHumanBatchVerdict({ id: row.id, actor: "jr", candidateId: 11, verdict: "ok" })).toBe(false);
  });

  it("결과가 남은 실행 줄만 한 번 되돌리기를 잡고, 기록은 최근 실행부터", async () => {
    const first = await gate();
    const second = await gate("jr", "repo_deleted");
    expect(await claimHumanBatchUndo({ id: first.id, actor: "jr" })).toBeNull();   // 실행 전
    await claimHumanBatchRun({ id: first.id, actor: "jr", decision: "approve" });
    expect(await claimHumanBatchUndo({ id: first.id, actor: "jr" })).toBeNull();   // 결과 전
    const result = { decision: "approve" as const, reason: "passed", note: "n", decided: [{ id: 11, repo: "acme/r11", attemptId: 5 }], failures: [], skipped: [],
      excludedNew: 0, excludedGone: 0 };
    await saveHumanBatchResult(first.id, result);
    await claimHumanBatchRun({ id: second.id, actor: "jr", decision: "reject" });
    const undo = await claimHumanBatchUndo({ id: first.id, actor: "jr2" });
    expect(undo).toMatchObject({ id: first.id, undoneBy: "jr2", result });
    expect(await claimHumanBatchUndo({ id: first.id, actor: "jr" })).toBeNull();
    await saveHumanBatchUndo(first.id, { restored: 1, failures: [] });
    expect((await readHumanBatchGate(first.id))!.undoResult).toEqual({ restored: 1, failures: [] });
    expect((await recentHumanBatchRuns()).map(row => row.id)).toEqual([second.id, first.id]);
    const latest = await latestHumanBatchGates("jr");
    expect(Object.keys(latest).sort()).toEqual(["agreed_approve", "repo_deleted"]);
  });

  it("묶음 이름·표본 수·결정 값은 제약이 막는다", async () => {
    await expect(db.execute(sql`INSERT INTO human_batch_gates (batch_key, actor, members, snapshot_hash, sample_ids)
      VALUES ('everything', 'jr', '[{"id":1}]', 'x', '{1}')`)).rejects.toThrow();
    await expect(db.execute(sql`INSERT INTO human_batch_gates (batch_key, actor, members, snapshot_hash, sample_ids)
      VALUES ('agreed_approve', 'jr', '[{"id":1}]', 'x', '{1,2,3,4,5,6}')`)).rejects.toThrow();
    await expect(db.execute(sql`INSERT INTO human_batch_gates (batch_key, actor, members, snapshot_hash, sample_ids, executed_at)
      VALUES ('agreed_approve', 'jr', '[{"id":1}]', 'x', '{1}', now())`)).rejects.toThrow();
  });
});
