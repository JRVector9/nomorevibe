import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, productEvidenceAudit, products } from "@/lib/db/schema";
import { SPAM_DETECTOR_VERSION } from "@/lib/crawl/spam-signals";
import { countProducts, setStatusWithAudit } from "@/lib/domain/products/repository";
import { MAX_AUTO_BANS_PER_DAY, RESCAN_BATCH, rescanPublishedSpam, type SpamRescanCursor } from "@/lib/jobs/products/spam-rescan";
import type { JobContext } from "@/lib/jobs/runner";
import { attentionCounts } from "@/lib/operations/dashboard";
import { ensureSchema, resetTables } from "./setup";

/**
 * 공개 제품 스팸 재검사(product-spam-rescan) — 이미 올라간 제품에 판정을 다시 태워 잡히면 내린다(2026-10-08 운영자 결정).
 */
beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await resetTables();
});

const context = (cursor: SpamRescanCursor | null = null): JobContext<SpamRescanCursor> =>
  ({ cursor, save: vi.fn(), hasBudget: () => true, log: vi.fn() });

type Source = {
  repoMeta: { name: string; owner: { login: string }; stargazers_count: number; has_issues: boolean };
  productUrl: string;
  pageMeta: Record<string, string>;
};
/** 프로드 /p/codex-deepseek 를 줄인 것 — 틀 제목·다운로드 미끼·남의 github.io 첫 화면·★1·이슈 꺼짐 */
const campaign = (owner: string, name: string): Source => ({
  repoMeta: { name, owner: { login: owner }, stargazers_count: 1, has_issues: false },
  productUrl: `https://${owner.toLowerCase()}.github.io`,
  pageMeta: { title: `🤖 ${name} - Run Codex on DeepSeek Models`, textSample: "Visit this link to download the application." },
});
const ordinary = (owner: string, name: string): Source => ({
  repoMeta: { name, owner: { login: owner }, stargazers_count: 120, has_issues: true },
  productUrl: `https://${name}.example.app`,
  pageMeta: { title: `${name} — a calm task list`, readmeSample: `# ${name}\n\nA calm task list built with Next.js.` },
});

let serial = 0;
async function published(document: Source, over: { product?: Partial<typeof products.$inferInsert>;
  decidedBy?: "auto" | "admin"; signals?: Record<string, unknown> } = {}) {
  const slug = `rescan-${++serial}`;
  const repo = `${document.repoMeta.owner.login}/${document.repoMeta.name}`;
  const [product] = await db.insert(products).values({
    slug, name: slug, url: document.productUrl, tagline: "A product", description: "description", category: "Dev",
    repoUrl: `https://github.com/${repo}`, status: "seeded", source: "crawler", verifyToken: `v-${slug}`, editTokenHash: "a".repeat(64),
    ...over.product,
  }).returning();
  await db.insert(crawlDocuments).values({ repo, productUrl: document.productUrl, pageStatus: 200,
    repoMeta: document.repoMeta, pageMeta: document.pageMeta });
  await db.insert(crawlCandidates).values({ repo, productUrl: document.productUrl, state: "published", reason: "passed",
    decidedBy: over.decidedBy ?? "auto", publishedSlug: slug, signals: over.signals ?? {} });
  return product;
}
const status = async (id: number) => (await db.select({ status: products.status }).from(products).where(eq(products.id, id)))[0].status;

/** 쪽을 채우는 평범한 공개 제품 — 후보 하나씩. 넣는 순서대로 제품 id 가 붙는다 */
async function filler(count: number) {
  const items = Array.from({ length: count }, () => {
    const n = ++serial;
    return { slug: `rescan-${n}`, repo: `maker${n}/app${n}`, document: ordinary(`maker${n}`, `app${n}`) };
  });
  for (let start = 0; start < items.length; start += 500) {
    const chunk = items.slice(start, start + 500);
    await db.insert(products).values(chunk.map(({ slug, repo, document }) => ({
      slug, name: slug, url: document.productUrl, tagline: "A product", description: "description", category: "Dev",
      repoUrl: `https://github.com/${repo}`, status: "seeded" as const, source: "crawler" as const, verifyToken: `v-${slug}`, editTokenHash: "a".repeat(64),
    })));
    await db.insert(crawlDocuments).values(chunk.map(({ repo, document }) => ({ repo, productUrl: document.productUrl, pageStatus: 200,
      repoMeta: document.repoMeta, pageMeta: document.pageMeta })));
    await db.insert(crawlCandidates).values(chunk.map(({ slug, repo, document }) => ({ repo, productUrl: document.productUrl,
      state: "published" as const, reason: "passed" as const, decidedBy: "auto", publishedSlug: slug, signals: {} })));
  }
}

/** 후보(별칭) 여럿이 가리키는 판정에 걸리는 공개 제품 — 후보는 적은 순서대로 넣는다(후보 id·저장소 이름 모두 그 순서) */
async function aliased(aliases: { owner: string; decidedBy?: "auto" | "admin"; signals?: Record<string, unknown> }[]) {
  const slug = `rescan-${++serial}`;
  const head = campaign(aliases[0].owner, slug);
  const [product] = await db.insert(products).values({
    slug, name: slug, url: head.productUrl, tagline: "A product", description: "description", category: "Dev",
    repoUrl: `https://github.com/${aliases[0].owner}/${slug}`, status: "seeded", source: "crawler", verifyToken: `v-${slug}`, editTokenHash: "a".repeat(64),
  }).returning();
  for (const alias of aliases) {
    const document = campaign(alias.owner, slug);
    const repo = `${alias.owner}/${slug}`;
    await db.insert(crawlDocuments).values({ repo, productUrl: document.productUrl, pageStatus: 200, repoMeta: document.repoMeta, pageMeta: document.pageMeta });
    await db.insert(crawlCandidates).values({ repo, productUrl: document.productUrl, state: "published", reason: "passed",
      decidedBy: alias.decidedBy ?? "auto", publishedSlug: slug, signals: alias.signals ?? {} });
  }
  return product;
}

/** 쉬기 시작할 때까지(한 바퀴) 틱을 잇는다 — 돈 틱 수 */
async function fullPass(): Promise<number> {
  let cursor: SpamRescanCursor | null = null, ticks = 0;
  do {
    cursor = (await rescanPublishedSpam(context(cursor))).cursor ?? null;
    ticks += 1;
  } while (cursor && cursor.idleUntil === null && ticks < 10);
  return ticks;
}

it("내리는 것은 판정에 걸린 공개 제품뿐이고, 감사에 재검사·사유·판정을 남긴다", async () => {
  const spam = await published(campaign("Promisedlandsubtraction2856", "codex-deepseek"));
  const fine = await published(ordinary("maker", "todo"));
  const outcome = await rescanPublishedSpam(context());

  expect(await status(spam.id)).toBe("banned");
  expect(await status(fine.id)).toBe("seeded");
  expect(await db.select().from(productEvidenceAudit)).toEqual([expect.objectContaining({
    slug: spam.slug, action: "admin.product.ban", actor: "spam-rescan", reason: "suspected_spam",
    metadata: expect.objectContaining({ status: "banned", detector: SPAM_DETECTOR_VERSION, confidence: "high" }),
  })]);
  // 한 바퀴를 마쳤으면 하루 쉰다
  expect(outcome.cursor).toMatchObject({ version: SPAM_DETECTOR_VERSION, afterId: 0, idleUntil: expect.any(Number) });
  expect(await countProducts({ statuses: ["banned"], spamBanned: true })).toBe(1);
});

it("사람이 승인한 것·스타 자동 승인·메이커 소유·차단을 해제한 것은 내리지 않는다", async () => {
  const approved = await published(campaign("Approvedowner12", "approved-app"), { decidedBy: "admin" });
  const starred = await published(campaign("Starredowner12", "starred-app"), { signals: { starAutoApproval: { stars: 900 } } });
  const claimed = await published(campaign("Claimedowner12", "claimed-app"), { product: { claimedAt: new Date() } });
  const kept = await published(campaign("Keptowner12", "kept-app"));
  // 운영자가 한 번 내렸다가 되살렸다 — "유지"라는 뜻이다
  await setStatusWithAudit({ id: kept.id, slug: kept.slug, status: "banned", action: "admin.product.ban" });
  await setStatusWithAudit({ id: kept.id, slug: kept.slug, status: "seeded", action: "admin.product.unban" });

  await rescanPublishedSpam(context());
  for (const product of [approved, starred, claimed, kept]) expect(await status(product.id)).toBe("seeded");
});

it(`쪽(${RESCAN_BATCH}) 경계에 걸린 제품도 별칭 후보를 모두 읽고 판정한다 — 승인한 별칭이 다음 쪽으로 밀려 내리는 일이 없다`, async () => {
  // 후보 줄로 쪽을 자르면 평범한 제품 999건 다음 제품은 후보 하나만 이 쪽에 들고, 나머지는 다음 쪽으로 밀린 채 커서가 그 제품을 지나간다.
  // 같은 제품 안의 줄 순서는 정해져 있지 않다 — 어느 순서든 한 경계에서는 승인한 별칭이 잘리도록 두 경계에 거꾸로 놓는다
  await filler(RESCAN_BATCH - 1);
  const approved = await aliased([{ owner: "Aaaowner11" }, { owner: "Zzzowner11", decidedBy: "admin" }]);
  await filler(RESCAN_BATCH - 1);
  const starred = await aliased([{ owner: "Aaaowner22", signals: { starAutoApproval: { stars: 900 } } }, { owner: "Zzzowner22" }]);
  // 대조 — 별칭 둘 다 사람 승인·별 자동 승인이 없으면 내린다
  const spam = await aliased([{ owner: "Aaaowner33" }, { owner: "Zzzowner33" }]);

  expect(await fullPass()).toBe(3);
  expect(await status(approved.id)).toBe("seeded");
  expect(await status(starred.id)).toBe("seeded");
  expect(await status(spam.id)).toBe("banned");
  expect(await db.select({ slug: productEvidenceAudit.slug }).from(productEvidenceAudit)).toEqual([{ slug: spam.slug }]);
});

it("판정 버전이 같으면 쉬는 동안 아무것도 보지 않고, 버전이 바뀌면 곧바로 처음부터 다시 본다", async () => {
  const spam = await published(campaign("Promisedlandsubtraction2856", "codex-deepseek"));
  const resting = { version: SPAM_DETECTOR_VERSION, afterId: 0, idleUntil: Date.now() + 60 * 60_000 };
  expect(await rescanPublishedSpam(context(resting))).toEqual({ done: true, cursor: resting });
  expect(await status(spam.id)).toBe("seeded");

  await rescanPublishedSpam(context({ ...resting, version: "2026-10-08.1" }));
  expect(await status(spam.id)).toBe("banned");
});

it(`하루 ${MAX_AUTO_BANS_PER_DAY}건을 넘게는 내리지 않는다 — 판정이 잘못 바뀌어 한꺼번에 내리는 일을 막는다`, async () => {
  // 지난 24시간에 이미 한도만큼 내렸다
  await db.insert(productEvidenceAudit).values(Array.from({ length: MAX_AUTO_BANS_PER_DAY }, (_, index) => ({
    slug: `earlier-${index}`, actor: "spam-rescan", action: "admin.product.ban", reason: "suspected_spam", metadata: { status: "banned" },
  })));
  const spam = await published(campaign("Promisedlandsubtraction2856", "codex-deepseek"));
  const ctx = context();
  await rescanPublishedSpam(ctx);
  expect(await status(spam.id)).toBe("seeded");
  expect(ctx.log).toHaveBeenCalledWith("spam_rescan.capped", expect.objectContaining({ slugs: [spam.slug] }));
  expect((await attentionCounts()).spamAutoBans).toEqual({ day: MAX_AUTO_BANS_PER_DAY, banned: 0 });

  // 하루가 지나면 다시 내린다(SQL 시계로 민다)
  await db.execute(sql`update product_evidence_audit set created_at = created_at - interval '25 hours'`);
  await rescanPublishedSpam(context());
  expect(await status(spam.id)).toBe("banned");
  expect((await attentionCounts()).spamAutoBans).toEqual({ day: 1, banned: 1 });
});
