import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlReviewAttempts } from "@/lib/db/schema";
import { readHoldCounts, reviewHoldCountsQuery } from "@/lib/operations/review-hold-counts";
import { ensureSchema } from "./setup";

vi.mock("server-only", () => ({}));
beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(crawlReviewAttempts);
  await db.delete(crawlCandidates);
});
afterEach(async () => {
  await db.delete(crawlReviewAttempts);
  await db.delete(crawlCandidates);
});

async function candidate(repo: string, hours: number | null) {
  const [row] = await db.insert(crawlCandidates).values({ repo, state: "needs_review", reason: "ambiguous",
    judgedAt: hours === null ? null : new Date(Date.now() - hours * 3_600_000), updatedAt: new Date() }).returning();
  return row;
}
async function attempt(candidateId: number, hours: number, options: { provider?: string | null; kind?: string; state?: string; decision?: string; apply?: boolean } = {}) {
  const rows = await db.execute<{ id: number }>(sql`
    INSERT INTO crawl_review_attempts (candidate_id, kind, state, input_hash, policy_hash, source_revision_hash,
      snapshot, source, prompt_version, rules_version, provider, model, attempt_number, outcome, started_at, completed_at, valid_until)
    VALUES (${candidateId}, ${options.kind ?? 'automatic'}, ${options.state ?? 'succeeded'}, 'input', 'policy', 'source',
      '{}'::jsonb, '{}'::jsonb, 'prompt', 'rules', ${options.provider === undefined ? 'local-direct' : options.provider}, 'fixture', 1,
      ${JSON.stringify({ decision: options.decision ?? 'needs_review', reason: 'fixture', evidenceIds: [] })}::jsonb,
      now() - ${hours} * interval '1 hour', now() - ${hours} * interval '1 hour', now() + interval '1 day') RETURNING id`);
  if (options.apply !== false) await db.update(crawlCandidates).set({ signals: { agentReviewAttemptId: rows[0].id } }).where(eq(crawlCandidates.id, candidateId));
  return rows[0].id;
}

describe("hold count DB path (test DB 55435)", () => {
  it("does not count an old hold again when updated_at and the applied re-review are recent", async () => {
    const old = await candidate("hold-test/old", 72);
    await attempt(old.id, 48);
    await attempt(old.id, 1); // applied pointer moves, original hold remains old
    // Measure the original main query and the fix on the same old-hold fixture.
    const [legacy] = await db.execute<{ recent: number }>(sql`SELECT count(*)::int AS recent FROM crawl_candidates
      WHERE state = 'needs_review' AND updated_at > now() - interval '24 hours'`);
    expect(Number(legacy.recent)).toBe(1);
    const fixed = await readHoldCounts();
    expect(fixed.holds).toEqual([{ reason: "ai_first_ambiguous", count: 1, recent24h: 0 }]);
    if (process.env.REVIEW_HOLD_METRICS_PATH) writeFileSync(process.env.REVIEW_HOLD_METRICS_PATH,
      JSON.stringify({ fixture: "48h-old hold, applied re-review 1h ago", legacyRecent: Number(legacy.recent),
        fixedRecent: fixed.holds[0].recent24h }, null, 2));
  });

  it("counts recent first holds, splits actual AI from rules, and keeps rejected totals", async () => {
    const ai = await candidate("hold-test/ai", 72);
    await attempt(ai.id, 48, { state: "failed" });
    await attempt(ai.id, 36, { decision: "approve" });
    await attempt(ai.id, 2);
    await candidate("hold-test/rule", 3);
    const rules = await candidate("hold-test/provider-rules", 72);
    await attempt(rules.id, 4, { provider: "rules" }); // kind=automatic alone is not proof of AI
    await db.insert(crawlCandidates).values({ repo: "hold-test/reject", state: "rejected" });
    const counts = await readHoldCounts();
    expect(counts.holds.sort((a, b) => a.reason.localeCompare(b.reason))).toEqual([
      { reason: "ai_first_ambiguous", count: 1, recent24h: 1 }, { reason: "ambiguous", count: 2, recent24h: 2 },
    ]);
    expect(counts.rejected).toBe(1);
  });

  it("uses rule judgement time, ignores observe-only AI, and never invents missing dates", async () => {
    const old = await candidate("hold-test/rule-old", 48);
    await attempt(old.id, 1, { apply: false }); // observe-mode: never applied
    await candidate("hold-test/no-time", null);
    await candidate("hold-test/new", 2);
    expect((await readHoldCounts()).holds).toEqual([{ reason: "ambiguous", count: 3, recent24h: 1 }]);
  });

  it("ignores cross-candidate, malformed and out-of-range attempt pointers", async () => {
    const owner = await candidate("hold-test/owner", 48);
    const id = await attempt(owner.id, 2);
    for (const [index, pointer] of [id, "bad", "9999999999", "999999999999999999999999999"].entries()) {
      const row = await candidate(`hold-test/pointer-${index}`, 48);
      await db.update(crawlCandidates).set({ signals: { agentReviewAttemptId: pointer } }).where(eq(crawlCandidates.id, row.id));
    }
    expect((await readHoldCounts()).holds.sort((a, b) => a.reason.localeCompare(b.reason))).toEqual([
      { reason: "ai_first_ambiguous", count: 1, recent24h: 1 }, { reason: "ambiguous", count: 4, recent24h: 0 },
    ]);
  });

  it("can probe attempts and candidates through existing indexes", async () => {
    const row = await candidate("hold-test/plan", 48);
    await attempt(row.id, 2);
    // Enough unrelated history to check the planner's real default choice.
    await db.execute(sql`INSERT INTO crawl_candidates (repo, state)
      SELECT 'hold-plan/' || n, 'approved' FROM generate_series(1, 1000) n`);
    await db.execute(sql`INSERT INTO crawl_review_attempts (candidate_id, kind, state, input_hash, policy_hash, source_revision_hash,
      snapshot, source, prompt_version, rules_version, provider, model, attempt_number, outcome, completed_at, valid_until)
      SELECT c.id, 'automatic', 'succeeded', 'input', 'policy', 'source', '{}'::jsonb, '{}'::jsonb, 'prompt', 'rules',
        'local-direct', 'fixture', n, '{"decision":"approve"}'::jsonb, now(), now() + interval '1 day'
      FROM crawl_candidates c CROSS JOIN generate_series(1, 4) n WHERE c.repo LIKE 'hold-plan/%'`);
    await db.execute(sql`ANALYZE crawl_candidates`);
    await db.execute(sql`ANALYZE crawl_review_attempts`);
    const plans = await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${reviewHoldCountsQuery()}`);
    if (process.env.REVIEW_HOLD_PLAN_PATH) writeFileSync(process.env.REVIEW_HOLD_PLAN_PATH, JSON.stringify([...plans], null, 2));
    const plan = JSON.stringify([...plans]);
    expect(plan).toContain("crawl_candidates_state");
    expect(plan).toContain("crawl_review_attempts_pkey");
    expect(plan).toMatch(/crawl_review_(input|approval)_idx/);
    expect(plan).not.toContain('"Node Type":"Seq Scan"');
  });
});
