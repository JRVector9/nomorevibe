import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, operationsAudit, products,
  type CrawlCandidate, type CrawlDocument } from "@/lib/db/schema";
import { INSTALLABLE_MIN_STARS, PACKAGE_MIN_STARS } from "@/lib/domain/products/access";
import { requestJob } from "@/lib/jobs/control";
import { reviewHash, reviewPolicyHash } from "./agent-review-contract";
import { factsFromRepoMeta, judge, pageFactsFromDocument } from "./rules";
import { getSettings, mergeWithDefaults } from "./settings";
import { lockFrontierIdentity } from "./repository";
import { findRepositoryProduct, lockProductRepository } from "@/lib/domain/products/repository-identity";

type Entry = { repo: string; id: number; revision: string; stars: number; previousReason: string;
  previousState?: "rejected" | "needs_review" | "approved" };
/**
 * package — 배포 URL 없음으로 거절된 5~499 스타 저장소를 다시 받아 패키지 증거(SKILL.md 등)를 찾게 한다(2026-10-06).
 *   증거는 다시 받을 때만 생기므로 지금 원본으로 거르지 않는다. 증거가 없으면 판정이 같은 거절로 되돌린다.
 *   새 수집보다 뒤에 서게 우선순위를 낮춘다(새 수집 35~120).
 */
type Policy = "installable" | "star-auto" | "package";
const PACKAGE_RECONSIDER_PRIORITY = 30;
export type ReconsiderationPlan = { includeAdmin?: boolean; policy?: Policy;
  database?: string; policyHash: string; createdAt: string; entries: Entry[]; examined: number };
const revision = (candidate: CrawlCandidate, document: CrawlDocument) => reviewHash(JSON.parse(JSON.stringify({ candidate, document })));
async function databaseIdentity(): Promise<string> {
  const [row] = await db.execute<{ identity: string }>(sql`
    select md5(current_database() || coalesce(inet_server_addr()::text, 'local') || inet_server_port()::text) as identity
  `);
  return row.identity;
}

/** Read-only preview. Human rejections require explicit opt-in; bans and listed products stay excluded. */
export async function planReconsideration(limit = 1000, options: {
  includeAdmin?: boolean; policy?: Policy;
} = {}): Promise<ReconsiderationPlan> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw new Error("invalid_limit");
  const policy = options.policy ?? "installable";
  if (policy !== "installable" && options.includeAdmin) throw new Error("admin_rejections_are_protected");
  const settings = await getSettings();
  const stars = sql`(${crawlDocuments.repoMeta}->>'stargazers_count')::numeric`;
  const rows = await db.select({ candidate: crawlCandidates, document: crawlDocuments }).from(crawlCandidates)
    .innerJoin(crawlDocuments, eq(crawlCandidates.repo, crawlDocuments.repo))
    .where(and(policy === "star-auto"
      ? inArray(crawlCandidates.state, ["rejected", "needs_review", "approved"])
      : eq(crawlCandidates.state, "rejected"),
      options.includeAdmin ? sql`${crawlCandidates.decidedBy} in ('auto','admin')` : eq(crawlCandidates.decidedBy, "auto"),
      isNull(crawlCandidates.publishedSlug), sql`${crawlCandidates.reason} not in ('banned','already_listed')`,
      // The broad product OR lookup is too expensive across the full rejected queue. Apply
      // rechecks repository and URL identity under a lock before changing each row.
      policy === "star-auto" ? undefined : sql`not exists(select 1 from ${products} p where lower(rtrim(p.repo_url, '/')) = lower('https://github.com/' || ${crawlCandidates.repo}) or p.url = ${crawlDocuments.productUrl})`,
      policy === "package" ? and(eq(crawlCandidates.reason, "no_homepage"),
        sql`coalesce((${crawlDocuments.repoMeta}->>'fork')::boolean, false) = false and coalesce((${crawlDocuments.repoMeta}->>'archived')::boolean, false) = false`) : undefined,
      sql`case when jsonb_typeof(${crawlDocuments.repoMeta}->'stargazers_count') = 'number'
        then ${policy === "package"
          ? sql`${stars} >= ${PACKAGE_MIN_STARS} and ${stars} < ${INSTALLABLE_MIN_STARS}`
          : sql`${stars} >= ${policy === "star-auto" ? settings.judge.autoApproveMinStars : INSTALLABLE_MIN_STARS}`} else false end`))
    .orderBy(asc(crawlCandidates.id)).limit(limit);
  return { includeAdmin: options.includeAdmin === true, policy,
    database: policy === "star-auto" ? await databaseIdentity() : undefined, policyHash: reviewPolicyHash(settings),
    createdAt: new Date().toISOString(), examined: rows.length,
    entries: rows.filter(({ document }) => policy !== "installable" || judge(factsFromRepoMeta(document.repo, document.repoMeta),
      pageFactsFromDocument(document), settings).state !== "rejected")
      .map(({ candidate, document }) => ({ repo: candidate.repo, id: candidate.id, revision: revision(candidate, document),
        stars: Number(document.repoMeta.stargazers_count), previousReason: candidate.reason ?? "unknown",
        previousState: candidate.state as Entry["previousState"] })) };
}

/** Apply exactly the reviewed snapshot. A new fetch must finish before any rule/model review. */
export async function applyReconsideration(plan: ReconsiderationPlan, actor: string) {
  if (!actor.trim() || actor.length > 120 || plan.entries.length > 2000) throw new Error("invalid_reconsideration");
  const policy = plan.policy ?? "installable";
  if (policy !== "installable" && plan.includeAdmin) throw new Error("admin_rejections_are_protected");
  if (policy === "star-auto" && (!/^[a-f0-9]{32}$/.test(plan.database ?? "")
    || plan.database !== await databaseIdentity())) throw new Error("reconsideration_database_changed");
  const queued: string[] = [], changed: string[] = [];
  for (const entry of plan.entries) {
    const applied = await db.transaction(async tx => {
      await lockProductRepository(tx, `https://github.com/${entry.repo}`);
      const [candidate] = await tx.select().from(crawlCandidates).where(eq(crawlCandidates.id, entry.id)).for("update");
      const [document] = await tx.select().from(crawlDocuments).where(eq(crawlDocuments.repo, entry.repo)).for("update");
      if (!candidate || !document || candidate.repo !== entry.repo || candidate.state !== (entry.previousState ?? "rejected")
        || (candidate.decidedBy !== "auto" && !(plan.includeAdmin === true && candidate.decidedBy === "admin")) || candidate.publishedSlug || revision(candidate, document) !== entry.revision) return false;
      const [saved] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id, 1)).for("share");
      if (reviewPolicyHash(mergeWithDefaults(saved?.values)) !== plan.policyHash) throw new Error("reconsideration_policy_changed");
      if (await findRepositoryProduct(entry.repo, document.productUrl, tx)) return false;
      await lockFrontierIdentity(tx, entry.repo);
      const frontiers = await tx.select().from(crawlFrontier).where(sql`lower(${crawlFrontier.repo}) = ${entry.repo.toLowerCase()}`).for("update");
      // Legacy aliases retain their history; never create or restart a second pipeline for them.
      if (frontiers.some(row => row.repo !== entry.repo)) return false;
      const [frontier] = frontiers;
      // Preserve active fetch leases and provider cooldowns.
      if (frontier && frontier.state !== "fetching") await tx.update(crawlFrontier).set({ state: "pending", attempts: 0,
        ...(policy === "package" ? { priority: PACKAGE_RECONSIDER_PRIORITY } : {}),
        nextAttemptAt: frontier.lastError ? sql`greatest(now(), ${crawlFrontier.nextAttemptAt})` : sql`now()`, updatedAt: sql`now()` })
        .where(eq(crawlFrontier.id, frontier.id));
      else if (!frontier) await tx.insert(crawlFrontier).values({ repo: entry.repo,
        signal: `${policy}-policy-reconsideration`, priority: policy === "package" ? PACKAGE_RECONSIDER_PRIORITY : 100 });
      await tx.update(crawlCandidates).set({ state: "new", reason: "source_changed", decidedBy: "auto", decidedAt: null, updatedAt: sql`now()`,
        signals: { ...candidate.signals, reconsiderAfter: document.fetchedAt.toISOString(), reconsiderPolicy: plan.policyHash },
      }).where(eq(crawlCandidates.id, entry.id));
      await tx.insert(operationsAudit).values({ actor,
        action: `reconsider-${policy}`, target: entry.repo,
        detail: { previousDecidedBy: candidate.decidedBy, includeAdmin: plan.includeAdmin === true,
          previousState: candidate.state, previousReason: candidate.reason, revision: entry.revision, policyHash: plan.policyHash } });
      await requestJob("crawl-fetch", tx);
      return true;
    });
    (applied ? queued : changed).push(entry.repo);
  }
  return { queued, changed };
}
