import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, crawlCandidates, jobs } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { runJob } from "@/lib/jobs/runner";
import { refreshPublishedReadmes } from "@/lib/jobs/products/readme-refresh";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { ensureSchema, resetTables } from "./setup";

const sample = vi.hoisted(() => vi.fn());
vi.mock("@/lib/crawl/readme-refresh", () => ({ fetchPublicReadme: sample }));
beforeAll(ensureSchema);
beforeEach(async () => {
  await resetTables();
  await db.execute(sql`truncate crawl_candidates, crawl_documents, jobs restart identity cascade`);
  sample.mockReset();
});
const repo = "someone/published";
async function seed() {
  await db.insert(products).values({ slug: "published", name: "Published", url: "https://published.test",
    tagline: "Published", description: "Published", category: "Dev", status: "seeded", source: "crawler", verifyToken: "fixture", editTokenHash: "fixture" });
  await db.insert(crawlCandidates).values({ repo, state: "approved", publishedSlug: "published" });
  await crawl.putDocument({ repo, repoMeta: {}, pageMeta: { readmeSample: "Old README", readmeSampleVersion: null } });
}
describe("published README refresh after recrawl", () => {
  it("does not overwrite a newer document while the README request is running", async () => {
    await seed();
    sample.mockImplementationOnce(async () => {
      await crawl.putDocument({ repo, repoMeta: {}, pageMeta: { readmeSample: "Newer source", readmeSampleVersion: README_SAMPLE_VERSION } });
      return { ok: true, sample: "Old request result" };
    });
    await runJob("product-readme-refresh", refreshPublishedReadmes);
    expect((await crawl.getDocument(repo))?.pageMeta?.readmeSample).toBe("Newer source");
  });
  it("rolls back the README result when job ownership was lost", async () => {
    await seed();
    sample.mockImplementationOnce(async () => {
      await db.update(jobs).set({ leaseToken: "another-owner" }).where(eq(jobs.name, "product-readme-refresh"));
      return { ok: true, sample: "Unowned result" };
    });
    expect(await runJob("product-readme-refresh", refreshPublishedReadmes)).toMatchObject({ status: "failed" });
    expect((await crawl.getDocument(repo))?.pageMeta).toEqual({ readmeSample: "Old README", readmeSampleVersion: null });
  });
  it("fetches new README for a published product that never returns to candidate review", async () => {
    await seed(); sample.mockResolvedValue({ ok: true, sample: "New README" });
    expect(await runJob("product-readme-refresh", refreshPublishedReadmes)).toMatchObject({ status: "completed" });
    expect((await crawl.getDocument(repo))?.pageMeta).toMatchObject({ readmeSample: "New README", readmeSampleVersion: README_SAMPLE_VERSION });
  });
  it("preserves the last README on transient failure and respects retry backoff", async () => {
    await seed(); sample.mockResolvedValue({ ok: false, error: "temporary", retryAfter: null });
    await runJob("product-readme-refresh", refreshPublishedReadmes);
    expect((await crawl.getDocument(repo))?.pageMeta).toMatchObject({ readmeSample: "Old README", readmeSampleVersion: null, readmeRefreshAttempts: 1 });
    sample.mockClear(); await runJob("product-readme-refresh", refreshPublishedReadmes);
    expect(sample).not.toHaveBeenCalled();
  });
  it("clears confirmed absence and ignores ordinary cached or no-longer-public products", async () => {
    await seed(); sample.mockResolvedValue({ ok: true, sample: "" });
    await runJob("product-readme-refresh", refreshPublishedReadmes);
    expect((await crawl.getDocument(repo))?.pageMeta).toMatchObject({ readmeSample: "", readmeSampleVersion: README_SAMPLE_VERSION });
    sample.mockClear(); await runJob("product-readme-refresh", refreshPublishedReadmes);
    expect(sample).not.toHaveBeenCalled();
    await crawl.putDocument({ repo, repoMeta: {}, pageMeta: { readmeSample: "Old", readmeSampleVersion: null } });
    await db.update(products).set({ status: "banned" }).where(eq(products.slug, "published"));
    await runJob("product-readme-refresh", refreshPublishedReadmes);
    expect(sample).not.toHaveBeenCalled();
  });
});
