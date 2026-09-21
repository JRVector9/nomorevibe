import { beforeAll, beforeEach, expect, it } from "vitest";
import { db } from "@/lib/db";
import { crawlCandidates, crawlPublicationChanges, crawlReviewAttempts, operationsAudit } from "@/lib/db/schema";
import { insert } from "@/lib/domain/products/repository";
import { ensureSchema, resetTables } from "./setup";
import { reconcileCrawlDuplicates } from "@/lib/crawl/duplicate-reconciliation";

beforeAll(ensureSchema);
beforeEach(async () => { await resetTables(); await db.delete(crawlCandidates); await db.delete(crawlPublicationChanges); });

it("previews and repairs missing duplicate references without creating records or publication events", async () => {
  await insert({ slug: "existing", url: "https://new.example", repoUrl: "https://github.com/Maker/Plugin",
    name: "Plugin", tagline: "Plugin", description: "Plugin", category: "Plugin", status: "seeded",
    verifyToken: "verify", editTokenHash: "x".repeat(64) });
  await db.insert(crawlCandidates).values([
    { repo: "maker/plugin", state: "rejected", reason: "already_listed", decidedBy: "auto", signals: { retained: "audit" } },
    { repo: "maker/unmatched", state: "rejected", reason: "already_listed", decidedBy: "auto" },
    { repo: "Maker/Plugin", state: "rejected", reason: "already_listed", decidedBy: "admin" },
  ]);
  const before = await db.select().from(crawlCandidates);
  expect(await reconcileCrawlDuplicates({ actor: "reconciliation-test" })).toMatchObject({ eligible: 1, updated: 0 });
  expect(await db.select().from(crawlCandidates)).toEqual(before);
  expect(await reconcileCrawlDuplicates({ actor: "reconciliation-test", apply: true })).toMatchObject({ eligible: 1, updated: 1 });
  const after = await db.select().from(crawlCandidates);
  expect(after).toHaveLength(3);
  expect(after.find(c => c.repo === "maker/plugin")).toMatchObject({ state: "rejected", reason: "already_listed",
    signals: { existingSlug: "existing", retained: "audit" } });
  expect(after.find(c => c.decidedBy === "admin")).toEqual(before.find(c => c.decidedBy === "admin"));
  expect(await db.select().from(crawlPublicationChanges)).toHaveLength(0);
  expect(await reconcileCrawlDuplicates({ actor: "reconciliation-test", apply: true })).toMatchObject({ eligible: 0, updated: 0 });
  const audit = await db.select().from(operationsAudit);
  expect(audit.filter(a => a.actor === "reconciliation-test")).toHaveLength(1);
});

it("repairs lost rule reasons only with both a rules attempt and a current matching product", async () => {
  await insert({ slug: "existing", url: "https://old.example", repoUrl: "https://github.com/maker/plugin",
    name: "Plugin", tagline: "Plugin", description: "Plugin", category: "Plugin", status: "seeded",
    verifyToken: "verify", editTokenHash: "x".repeat(64) });
  const { eq } = await import("drizzle-orm");
  for (const provider of ["rules", "abcllm"]) {
    const [candidate] = await db.insert(crawlCandidates).values({ repo: provider === "rules" ? "maker/plugin" : "Maker/Plugin",
      state: "rejected", reason: "not_a_product", decidedBy: "auto" }).returning();
    const [attempt] = await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: "automatic", state: "succeeded",
      inputHash: "x", sourceRevisionHash: "x", policyHash: "x", snapshot: {} as never, source: {} as never,
      promptVersion: "old", rulesVersion: "old", provider, model: "old", attemptNumber: 1,
      outcome: { decision: "reject", reason: "기존 등재 규칙에 해당합니다: already_listed", evidenceIds: ["product"] },
      validUntil: new Date() }).returning();
    await db.update(crawlCandidates).set({ signals: { agentReviewAttemptId: attempt.id } }).where(eq(crawlCandidates.id, candidate.id));
  }
  expect(await reconcileCrawlDuplicates({ actor: "reconciliation-test", apply: true })).toMatchObject({ eligible: 1, updated: 1 });
  expect(await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, "maker/plugin")))
    .toMatchObject([{ reason: "already_listed", signals: { existingSlug: "existing" } }]);
  expect(await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, "Maker/Plugin")))
    .toMatchObject([{ reason: "not_a_product" }]);
});
