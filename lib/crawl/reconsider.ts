import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, operationsAudit, products,
  type CrawlCandidate, type CrawlDocument } from "@/lib/db/schema";
import { INSTALLABLE_MIN_STARS } from "@/lib/domain/products/access";
import { requestJob } from "@/lib/jobs/control";
import { reviewHash, reviewPolicyHash } from "./agent-review-contract";
import { factsFromRepoMeta, judge, pageFactsFromDocument } from "./rules";
import { getSettings, mergeWithDefaults } from "./settings";

type Entry = { repo: string; id: number; revision: string; stars: number; previousReason: string };
export type ReconsiderationPlan = { includeAdmin?: boolean; policyHash: string; createdAt: string; entries: Entry[]; examined: number };
const revision = (candidate: CrawlCandidate, document: CrawlDocument) => reviewHash(JSON.parse(JSON.stringify({ candidate, document })));

/** Read-only preview. Human rejections require explicit opt-in; bans and listed products stay excluded. */
export async function planReconsideration(limit = 1000, options: { includeAdmin?: boolean } = {}): Promise<ReconsiderationPlan> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw new Error("invalid_limit");
  const settings = await getSettings();
  const rows = await db.select({ candidate: crawlCandidates, document: crawlDocuments }).from(crawlCandidates)
    .innerJoin(crawlDocuments, eq(crawlCandidates.repo, crawlDocuments.repo))
    .where(and(eq(crawlCandidates.state, "rejected"), options.includeAdmin ? sql`${crawlCandidates.decidedBy} in ('auto','admin')` : eq(crawlCandidates.decidedBy, "auto"),
      isNull(crawlCandidates.publishedSlug), sql`${crawlCandidates.reason} not in ('banned','already_listed')`,
      sql`not exists(select 1 from ${products} p where lower(rtrim(p.repo_url, '/')) = lower('https://github.com/' || ${crawlCandidates.repo}) or p.url = ${crawlDocuments.productUrl})`,
      sql`case when jsonb_typeof(${crawlDocuments.repoMeta}->'stargazers_count') = 'number'
        then (${crawlDocuments.repoMeta}->>'stargazers_count')::numeric >= ${INSTALLABLE_MIN_STARS} else false end`))
    .orderBy(asc(crawlCandidates.id)).limit(limit);
  return { includeAdmin: options.includeAdmin === true, policyHash: reviewPolicyHash(settings), createdAt: new Date().toISOString(), examined: rows.length,
    entries: rows.filter(({ document }) => judge(factsFromRepoMeta(document.repo, document.repoMeta),
      pageFactsFromDocument(document), settings).state !== "rejected")
      .map(({ candidate, document }) => ({ repo: candidate.repo, id: candidate.id, revision: revision(candidate, document),
        stars: Number(document.repoMeta.stargazers_count), previousReason: candidate.reason ?? "unknown" })) };
}

/** Apply exactly the reviewed snapshot. A new fetch must finish before any rule/model review. */
export async function applyReconsideration(plan: ReconsiderationPlan, actor: string) {
  if (!actor.trim() || actor.length > 120 || plan.entries.length > 2000) throw new Error("invalid_reconsideration");
  const queued: string[] = [], changed: string[] = [];
  for (const entry of plan.entries) {
    const applied = await db.transaction(async tx => {
      const [candidate] = await tx.select().from(crawlCandidates).where(eq(crawlCandidates.id, entry.id)).for("update");
      const [document] = await tx.select().from(crawlDocuments).where(eq(crawlDocuments.repo, entry.repo)).for("update");
      if (!candidate || !document || candidate.repo !== entry.repo || candidate.state !== "rejected"
        || (candidate.decidedBy !== "auto" && !(plan.includeAdmin === true && candidate.decidedBy === "admin")) || candidate.publishedSlug || revision(candidate, document) !== entry.revision) return false;
      const [saved] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id, 1)).for("share");
      if (reviewPolicyHash(mergeWithDefaults(saved?.values)) !== plan.policyHash) throw new Error("reconsideration_policy_changed");
      const [frontier] = await tx.select().from(crawlFrontier).where(eq(crawlFrontier.repo, entry.repo)).for("update");
      // Preserve active fetch leases and provider cooldowns.
      if (frontier && frontier.state !== "fetching") await tx.update(crawlFrontier).set({ state: "pending", attempts: 0,
        nextAttemptAt: frontier.lastError ? sql`greatest(now(), ${crawlFrontier.nextAttemptAt})` : sql`now()`, updatedAt: sql`now()` })
        .where(eq(crawlFrontier.id, frontier.id));
      else if (!frontier) await tx.insert(crawlFrontier).values({ repo: entry.repo, signal: "installable-policy-reconsideration", priority: 100 });
      await tx.update(crawlCandidates).set({ state: "new", reason: "source_changed", decidedBy: "auto", decidedAt: null, updatedAt: sql`now()`,
        signals: { ...candidate.signals, reconsiderAfter: document.fetchedAt.toISOString(), reconsiderPolicy: plan.policyHash },
      }).where(eq(crawlCandidates.id, entry.id));
      await tx.insert(operationsAudit).values({ actor, action: "reconsider-installable", target: entry.repo,
        detail: { previousDecidedBy: candidate.decidedBy, includeAdmin: plan.includeAdmin === true, previousState: candidate.state, previousReason: candidate.reason, revision: entry.revision, policyHash: plan.policyHash } });
      await requestJob("crawl-fetch", tx);
      return true;
    });
    (applied ? queued : changed).push(entry.repo);
  }
  return { queued, changed };
}
