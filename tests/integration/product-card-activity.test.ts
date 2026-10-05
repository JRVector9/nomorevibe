import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, productLinks, productEvidenceSources, productUpdates } from "@/lib/db/schema";
import { getPublicList, withProductHealth } from "@/lib/domain/products/view";
import { ensureSchema, resetTables } from "./setup";

const week = 7 * 24 * 60 * 60 * 1_000;
let now: Date;
beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  now = new Date();
  await db.insert(products).values({
    slug: "activity-product", name: "Activity Product", url: "https://activity.example",
    tagline: "A product", description: "A product", category: "Dev", status: "verified",
    repoUrl: "https://github.com/maker/product", verifyToken: "test", editTokenHash: "test",
    updatedAt: now,
  });
  await db.insert(productLinks).values({
    slug: "activity-product", kind: "repository", declarationSource: "maker",
    url: "https://github.com/maker/product", normalizedKey: "maker/product",
  });
});

function facts() {
  return {
    type: "github_repository", repositoryKey: "maker/product", public: true,
    pushedAt: new Date(now.getTime() - 60_000).toISOString(),
    pushActivity: { count: 0, since: new Date(now.getTime() - week).toISOString(), observedAt: now.toISOString() },
  };
}
async function saveFacts(normalizedFacts: Record<string, unknown>, sourceKey = "maker/product") {
  await db.insert(productEvidenceSources).values({
    slug: "activity-product", kind: "repository", provider: "github", sourceKey,
    state: "ok", normalizedFacts, observedAt: now, lastSuccessAt: now,
  });
}

describe("home activity from public observations", () => {
  it("uses the latest visible public update and preserves a complete zero-push observation in both list paths", async () => {
    const publishedAt = new Date(now.getTime() - 3 * 60 * 60 * 1_000);
    await db.insert(productUpdates).values([
      { slug: "activity-product", sourceKind: "maker", dedupeKey: "public", title: "Published", publishedAt, observedAt: now },
      { slug: "activity-product", sourceKind: "maker", dedupeKey: "hidden", title: "Hidden", publishedAt: now, observedAt: now, visible: false },
      { slug: "activity-product", sourceKind: "maker", dedupeKey: "deleted", title: "Deleted", publishedAt: now, observedAt: now, makerDeletedAt: now },
      { slug: "activity-product", sourceKind: "maker", dedupeKey: "future", title: "Future", publishedAt: new Date(now.getTime() + week), observedAt: now },
    ]);
    await saveFacts(facts());
    const [product] = await getPublicList(10);
    const expected = {
      updatedAt: publishedAt.toISOString(), pushedAt: facts().pushedAt, pushCount: 0, pushObservedAt: now.toISOString(),
    };
    expect(product.activity).toEqual(expected);
    const [ranked] = await withProductHealth([{ ...product, activity: undefined }]);
    expect(ranked.activity).toEqual(expected);
  });

  it("keeps admin edits and uncollected pushes out of the public facts", async () => {
    const [product] = await getPublicList(10);
    expect(product.activity).toEqual({ updatedAt: null, pushedAt: null, pushCount: null, pushObservedAt: null });
    await saveFacts({ ...facts(), pushActivity: null });
    expect((await getPublicList(10))[0].activity).toEqual({
      updatedAt: null, pushedAt: facts().pushedAt, pushCount: null, pushObservedAt: null,
    });
  });

  it("does not attribute hidden, private, disconnected, or replaced repositories to the card", async () => {
    await saveFacts(facts());
    await db.update(productLinks).set({ visible: false }).where(eq(productLinks.slug, "activity-product"));
    expect((await getPublicList(10))[0].activity?.pushedAt).toBeNull();
    await db.update(productLinks).set({ visible: true }).where(eq(productLinks.slug, "activity-product"));
    await db.update(productEvidenceSources).set({ normalizedFacts: { ...facts(), public: false } });
    expect((await getPublicList(10))[0].activity?.pushedAt).toBeNull();
    await db.update(productEvidenceSources).set({ normalizedFacts: facts(), state: "disconnected" });
    expect((await getPublicList(10))[0].activity?.pushedAt).toBeNull();
    await db.update(productEvidenceSources).set({ state: "ok" });
    await db.update(products).set({ repoUrl: "https://github.com/maker/replacement" });
    expect((await getPublicList(10))[0].activity?.pushedAt).toBeNull();
  });

  it("omits stale or malformed counts without losing a valid last push", async () => {
    await saveFacts(facts());
    for (const pushActivity of [
      { ...facts().pushActivity, count: -1 },
      { ...facts().pushActivity, count: 1.5 },
      { ...facts().pushActivity, since: now.toISOString() },
      { count: 9, since: new Date(now.getTime() - 2 * week).toISOString(), observedAt: new Date(now.getTime() - week).toISOString() },
    ]) {
      await db.update(productEvidenceSources).set({ normalizedFacts: { ...facts(), pushActivity } });
      const activity = (await getPublicList(10))[0].activity;
      expect(activity?.pushedAt).toBe(facts().pushedAt);
      expect(activity?.pushCount).toBeNull();
      expect(activity?.pushObservedAt).toBeNull();
    }
  });
});
