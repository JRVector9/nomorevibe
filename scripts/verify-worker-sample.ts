/** Bounded live-source acceptance on a dedicated local DB. Never points at an application DB. */
import { mkdir, writeFile } from "node:fs/promises";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, products } from "@/lib/db/schema";
import { saveSettings, changeReviewMode, getSettings } from "@/lib/crawl/settings";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { enqueue } from "@/lib/crawl/repository";
import { runJob } from "@/lib/jobs/runner";
import { JOBS } from "@/lib/jobs/registry";

const REPOSITORIES = [
  "TradingGoose/TradingGoose-Studio", "Zhangdroid/drever", "ryanportfolio/lab-demo", "motioneso/moss",
  "onlycastle/popdict", "malachuk-josh/rilla-dashboard-clone", "LEMing/softbox", "koshaji/openclaw",
  "SinhyeokKang/bugshot-2", "Orlando-Villanueva/delight",
];
const phase = process.argv[2];
async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!['localhost', '127.0.0.1', 'host.docker.internal'].includes(url.hostname)
    || url.pathname !== '/nomorevibe_workers_acceptance'
    || !['prepare', 'collect', 'judge', 'review', 'report'].includes(phase)
    || process.argv.length !== 3) {
    throw new Error("Use dedicated local nomorevibe_workers_acceptance DB and prepare|collect|judge|review|report");
  }
  const tick = async (name: string) => {
    const result = await runJob(name, JOBS[name]);
    console.log(JSON.stringify({ phase, job: name, ...result }));
    if (result.status === "failed") throw new Error(`Acceptance job failed: ${name}`);
  };
  if (phase === "prepare") {
    const rows = await db.execute<{ count: number }>(sql`select count(*)::int from crawl_frontier`);
    if (rows[0].count !== 0) throw new Error("Acceptance DB is already prepared; do not reset it");
    await saveSettings({ enabled: true,
      discover: { queries: DEFAULT_CRAWL_SETTINGS.discover.queries.map(query => ({ ...query, enabled: false })) },
      agentEvidence: { enabled: true, enforceEligibility: true },
    }, "acceptance:local");
    const mode = await changeReviewMode({ mode: "observe", expectedMode: "off", actor: "acceptance:local",
      reason: "Isolated ten public repository acceptance, no public publication" });
    if (!mode.ok) throw new Error(mode.issues.join("; "));
    await enqueue(REPOSITORIES.map(repo => ({ repo, signal: "bounded acceptance sample", builder: null })));
    console.log(JSON.stringify({ prepared: REPOSITORIES.length, mode: "observe" }));
  }
  if (phase === "collect") {
    // One invocation is bounded; a partial scan keeps its real retry deadline for a later invocation.
    for (let index = 0; index < 3; index++) await tick("crawl-fetch");
    await tick("crawl-judge");
    for (let index = 0; index < 6; index++) await tick("agent-evidence-refresh");
  }
  if (phase === "judge") await tick("crawl-judge");
  if (phase === "review") {
    if ((await getSettings()).reviewMode !== "observe") throw new Error("Live sample review requires observe mode");
    for (let index = 0; index < 10; index++) await tick("crawl-agent-review");
  }
  if (phase === "report") {
    const frontier = await db.select().from(crawlFrontier).where(inArray(crawlFrontier.repo, REPOSITORIES));
    const candidates = await db.select().from(crawlCandidates).where(inArray(crawlCandidates.repo, REPOSITORIES));
    const documents = await db.select().from(crawlDocuments).where(inArray(crawlDocuments.repo, REPOSITORIES));
    const attempts = candidates.length ? await db.select().from(crawlReviewAttempts)
      .where(inArray(crawlReviewAttempts.candidateId, candidates.map(candidate => candidate.id))) : [];
    const listed = await db.select({ slug: products.slug }).from(products).where(and(
      eq(products.source, "crawler"), inArray(products.repoUrl, REPOSITORIES.map(repo => `https://github.com/${repo}`)),
    ));
    const report = {
      at: new Date().toISOString(), mode: (await getSettings()).reviewMode,
      sampleSize: REPOSITORIES.length, published: listed.length,
      costUsd: attempts.reduce((total, attempt) => total + (attempt.costUsd ?? 0), 0),
      samples: REPOSITORIES.map(repo => {
        const candidate = candidates.find(row => row.repo === repo), document = documents.find(row => row.repo === repo);
        return { repo, frontier: frontier.find(row => row.repo === repo)?.state,
          fetchedAt: document?.fetchedAt, url: document?.productUrl, pageStatus: document?.pageStatus,
          candidateState: candidate?.state, ruleReason: candidate?.reason,
          reviews: attempts.filter(row => row.candidateId === candidate?.id).map(row => ({
            state: row.state, provider: row.provider, model: row.model, attemptNumber: row.attemptNumber,
            inputHash: row.inputHash, sourceRevisionHash: row.sourceRevisionHash,
            outcome: row.outcome, error: row.errorCode, evidenceCount: row.snapshot.evidence.length,
            evidenceSummary: row.snapshot.evidenceSummary,
          })),
        };
      }),
    };
    await mkdir('/tmp/nomorevibe-workers-acceptance', { recursive: true });
    await writeFile('/tmp/nomorevibe-workers-acceptance/live-sample.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : "Acceptance failed"); process.exitCode = 1; })
  .finally(async () => { await (globalThis as { pgClient?: { end: (options: { timeout: number }) => Promise<void> } }).pgClient?.end({ timeout: 5 }); });
