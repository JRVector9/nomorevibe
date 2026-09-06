import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, productLinks } from "@/lib/db/schema";
import * as repository from "@/lib/domain/products/repository";
import { replaceMakerLinks } from "@/lib/domain/evidence/repository";
import { syncRepositoryLink } from "@/lib/domain/evidence/repository-link-sync";
import { ensureSchema, resetTables } from "./setup";
vi.mock("server-only", () => ({}));
beforeAll(ensureSchema); beforeEach(resetTables);
const input = { slug: "link-sync", url: "https://link-sync.example", name: "Link Sync", tagline: "fixture", description: "fixture", category: "Dev" as const, verifyToken: "verify", editTokenHash: "edit", repoUrl: "https://github.com/Acme/App" };
it("inserts a normalized maker repository link with the product and preserves other links on edit", async () => {
 await repository.insert(input);
 const product = (await repository.findBySlug(input.slug))!;
 expect(await db.select().from(productLinks)).toMatchObject([{ normalizedKey: "acme/app", declarationSource: "maker", verificationState: "unobserved" }]);
 await repository.update(product.id, { repoUrl: "https://github.com/acme/new" });
 expect((await db.select().from(productLinks)).map(row => row.normalizedKey).sort()).toEqual(["acme/app", "acme/new"]);
});
it("creates discovered links for crawler inserts", async () => {
 await repository.insert({ ...input, source: "crawler", status: "seeded" });
 expect(await db.select().from(productLinks)).toMatchObject([{ declarationSource: "discovered" }]);
});
it("preserves hidden and deleted links and does not resurrect an ambiguous legacy maker repo", async () => {
 await repository.insert(input);
 const product = (await repository.findBySlug(input.slug))!;
 await db.update(productLinks).set({ visible: false }).where(eq(productLinks.slug, product.slug));
 expect(await syncRepositoryLink({ productId: product.id, slug: product.slug, repoUrl: input.repoUrl, declarationSource: "maker", mode: "backfill" })).toMatchObject({ action: "preserved_hidden" });
 await replaceMakerLinks({ slug: product.slug, productId: product.id, actor: "maker", links: [] });
 expect(await syncRepositoryLink({ productId: product.id, slug: product.slug, repoUrl: input.repoUrl, declarationSource: "maker", mode: "backfill" })).toMatchObject({ action: "preserved_hidden" });
 await db.insert(products).values({ ...input, slug: "legacy", url: "https://legacy.example" });
 const legacy = (await repository.findBySlug("legacy"))!;
 expect(await syncRepositoryLink({ productId: legacy.id, slug: legacy.slug, repoUrl: input.repoUrl, declarationSource: "maker", mode: "backfill" })).toMatchObject({ action: "review_required" });
});
it("rejects stale product generations", async () => {
 await repository.insert(input);
 await expect(syncRepositoryLink({ productId: -1, slug: input.slug, repoUrl: input.repoUrl, declarationSource: "maker", mode: "backfill" })).rejects.toThrow("product generation changed");
});
it("persists site repository evidence and preserves independently attached agent references", async () => {
 const { upsertObservedSource, siteObservedRepository, findObservedSource } = await import("@/lib/domain/evidence/repository");
 const { refreshSiteFingerprint } = await import("@/lib/domain/evidence/providers/site-fingerprint");
 await repository.insert(input);
 const product = (await repository.findBySlug(input.slug))!;
 await refreshSiteFingerprint({ slug: product.slug, productId: product.id, url: product.url }, { fetch: async () => ({ ok: true, status: 200, finalUrl: product.url, headers: new Headers(), body: Buffer.from('<a href="https://github.com/Acme/App">Source code</a>') }) });
 expect(await siteObservedRepository({slug:product.slug,repositoryKey:"acme/app"})).toBe(true);
 const identity = { slug:product.slug,kind:"repository",provider:"github",sourceKey:"acme/app",state:"ok" };
 await upsertObservedSource({...identity, normalizedFacts:{ type:"github_repository",stars:1,agentScanId:7,agentDetectorVersion:"test-version"}},undefined,product.id);
 await upsertObservedSource({...identity, normalizedFacts:{ type:"github_repository",stars:2}},undefined,product.id);
 expect((await findObservedSource({slug:product.slug,kind:"repository",sourceKey:"acme/app"}))?.normalizedFacts).toMatchObject({stars:2,agentScanId:7,agentDetectorVersion:"test-version"});
});
it("uses source freshness and relationship instead of a stale stored link verification badge", async () => {
 const { upsertObservedSource } = await import("@/lib/domain/evidence/repository");
 const { getProductDetail } = await import("@/lib/domain/products/detail-view");
 await repository.insert(input);
 const product = (await repository.findBySlug(input.slug))!;
 await upsertObservedSource({slug:product.slug,kind:"repository",provider:"github",sourceKey:"acme/app",state:"ok",lastSuccessAt:new Date(),normalizedFacts:{ type:"github_repository",stars:5,relationshipState:"repository_link" }},undefined,product.id);
 expect((await getProductDetail(product.slug))?.links[0]).toMatchObject({verificationState:"ok",evidenceLabel:"출처 응답 확인·관계 미확인"});
 await upsertObservedSource({slug:product.slug,kind:"repository",provider:"github",sourceKey:"acme/app",state:"ok",lastSuccessAt:new Date(),normalizedFacts:{ type:"github_repository",stars:5,relationshipState:"site_link" }},undefined,product.id);
 expect((await getProductDetail(product.slug))?.links[0].evidenceLabel).toBe("공식 출처에서 확인");
 await upsertObservedSource({slug:product.slug,kind:"repository",provider:"github",sourceKey:"acme/app",state:"ok",lastSuccessAt:new Date(Date.now()-30*86400000),normalizedFacts:{ type:"github_repository",stars:5,relationshipState:"site_link" }},undefined,product.id);
 expect((await getProductDetail(product.slug))?.links[0].evidenceLabel).not.toBe("공식 출처에서 확인");
});
it("does not backfill a repository snapshot after the current repository changes", async () => {
 const [product] = await db.insert(products).values({ ...input, source:"crawler",status:"seeded" }).returning();
 await repository.update(product.id, { repoUrl:"https://github.com/acme/new" });
 expect(await syncRepositoryLink({ productId:product.id,slug:product.slug,repoUrl:input.repoUrl,declarationSource:"discovered",mode:"backfill" })).toMatchObject({action:"review_required"});
 expect((await db.select().from(productLinks)).map(row => row.normalizedKey)).toEqual(["acme/new"]);
});
it("uses the current primary repository for facts and never falls back to an older repo when primary is hidden", async () => {
 const { upsertObservedSource } = await import("@/lib/domain/evidence/repository");
 const { getProductDetail } = await import("@/lib/domain/products/detail-view");
 await repository.insert(input);
 const product = (await repository.findBySlug(input.slug))!;
 await upsertObservedSource({slug:product.slug,kind:"repository",provider:"github",sourceKey:"acme/app",state:"ok",lastSuccessAt:new Date(),normalizedFacts:{type:"github_repository",stars:1}},undefined,product.id);
 await repository.update(product.id, {repoUrl:"https://github.com/acme/new"});
 await upsertObservedSource({slug:product.slug,kind:"repository",provider:"github",sourceKey:"acme/new",state:"ok",lastSuccessAt:new Date(),normalizedFacts:{type:"github_repository",stars:2}},undefined,product.id);
 expect((await getProductDetail(product.slug))?.repository?.facts).toMatchObject({repositoryKey:"acme/new",stars:2});
 await db.update(productLinks).set({visible:false}).where(eq(productLinks.normalizedKey,"acme/new"));
 expect((await getProductDetail(product.slug))?.repository).toBeNull();
});
