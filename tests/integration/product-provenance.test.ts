import { asc, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  clickEvents,
  productAgents,
  productEvidenceAudit,
  productSkills,
  products,
  rankingEntries,
} from "@/lib/db/schema";
import {
  listProductProvenance,
  replaceProductProvenance,
} from "@/lib/domain/evidence/repository";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import { previewRanking, refreshRanking } from "@/lib/domain/ranking/refresh";
import { ensureSchema, resetTables } from "./setup";

const NOW = new Date("2026-08-19T03:00:00.000Z");

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.insert(products).values({
    slug: "provenance-product",
    url: "https://product.example",
    name: "Provenance Product",
    tagline: "Evidence",
    description: "Evidence product",
    category: "Dev",
    status: "verified",
    verifyToken: "verify-token",
    verifiedAt: new Date("2026-08-01T00:00:00.000Z"),
    editTokenHash: "a".repeat(64),
  });
  await db.insert(clickEvents).values({
    slug: "provenance-product",
    occurredAt: new Date("2026-08-19T02:00:00.000Z"),
  });
});

describe("product provenance persistence", () => {
  it("replaces normalized disclosures and returns evidence labels without sensitive bodies", async () => {
    await replaceProductProvenance({
      slug: "provenance-product",
      actor: "system:test",
      authority: "system",
      provenance: {
        agents: [{
          provider: " OpenAI ",
          client: "Codex",
          model: "GPT-5",
          roles: ["planning", "implementation"],
          evidenceLevel: "maker_reported",
        }],
        skills: [{
          namespace: " OpenAI_Tools ",
          name: " Review_Skill ",
          version: "1.0.0",
          hash: "b".repeat(64),
          evidenceLevel: "repository_evidenced",
        }],
      },
    });

    expect(await db.select().from(productAgents)).toHaveLength(1);
    expect(await db.select().from(productSkills)).toHaveLength(1);
    await expect(listProductProvenance("provenance-product")).resolves.toMatchObject({
      agents: [{
        provider: "OpenAI",
        roles: ["planning", "implementation"],
        evidenceLabel: "메이커 제공",
      }],
      skills: [{
        namespace: "openai-tools",
        name: "review-skill",
        evidenceLabel: "저장소 근거",
      }],
    });
    const [audit] = await db.select().from(productEvidenceAudit);
    expect(audit).toMatchObject({
      actor: "system:test",
      action: "system.provenance.replace",
      metadata: {
        agents: 1,
        skills: 1,
        authority: "system",
        evidenceLevels: ["maker_reported", "repository_evidenced"],
      },
    });

    await replaceProductProvenance({
      slug: "provenance-product",
      actor: "system:test",
      authority: "system",
      provenance: { agents: [], skills: [] },
    });
    expect(await db.select().from(productAgents)).toHaveLength(0);
    expect(await db.select().from(productSkills)).toHaveLength(0);
  });

  it("does not change ranking entries, preview output, or eligible products when rows are added or removed", async () => {
    await refreshRanking(NOW);
    const entriesBefore = await db.select().from(rankingEntries).orderBy(asc(rankingEntries.rank));
    const previewBefore = await previewRanking(DEFAULT_RANKING_POLICY, NOW);

    await replaceProductProvenance({
      slug: "provenance-product",
      actor: "system:test",
      authority: "system",
      provenance: {
        agents: [{
          provider: "OpenAI",
          roles: ["implementation", "review"],
          evidenceLevel: "maker_reported",
        }],
        skills: [{
          namespace: "openai",
          name: "review",
          commit: "c".repeat(64),
          evidenceLevel: "nomorevibe_recorded",
        }],
      },
    });
    await expect(refreshRanking(NOW)).resolves.toMatchObject({ entries: 1 });
    expect(await db.select().from(rankingEntries).orderBy(asc(rankingEntries.rank))).toEqual(entriesBefore);
    expect(await previewRanking(DEFAULT_RANKING_POLICY, NOW)).toEqual(previewBefore);
    expect(previewBefore.map((entry) => entry.slug)).toEqual(["provenance-product"]);

    await replaceProductProvenance({
      slug: "provenance-product",
      actor: "maker:test",
      provenance: { agents: [], skills: [] },
    });
    await expect(refreshRanking(NOW)).resolves.toMatchObject({ entries: 1 });
    expect(await db.select().from(rankingEntries).orderBy(asc(rankingEntries.rank))).toEqual(entriesBefore);
    expect(await previewRanking(DEFAULT_RANKING_POLICY, NOW)).toEqual(previewBefore);
  });

  it("serializes the two-table read with provenance replacement", async () => {
    await replaceProductProvenance({
      slug: "provenance-product",
      actor: "maker:test",
      provenance: {
        agents: [{
          provider: "OpenAI",
          roles: ["implementation"],
          evidenceLevel: "maker_reported",
        }],
        skills: [{
          namespace: "openai",
          name: "review",
          evidenceLevel: "maker_reported",
        }],
      },
    });
    let signalLockHeld!: () => void;
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => { signalLockHeld = resolve; });
    const lockReleased = new Promise<void>((resolve) => { releaseLock = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`
        select pg_advisory_xact_lock(hashtext('product-provenance:provenance-product'))
      `);
      signalLockHeld();
      await lockReleased;
    });
    await lockHeld;

    let settled = false;
    const listing = listProductProvenance("provenance-product").then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    const settledWhileReplacementLockHeld = settled;
    releaseLock();
    await holder;

    expect(settledWhileReplacementLockHeld).toBe(false);
    await expect(listing).resolves.toMatchObject({
      agents: [{ provider: "OpenAI" }],
      skills: [{ name: "review" }],
    });
  });
});
