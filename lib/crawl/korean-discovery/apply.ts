import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { getSettings } from '@/lib/crawl/settings';
import { enqueueDiscoveryBatch } from '@/lib/crawl/shared-discovery';
import { recordDiscoveryProgress } from '@/lib/crawl/discovery-progress';
import type { JobContext, JobOutcome } from '@/lib/jobs/runner';
import { assertJobLeaseAtWallTime } from '@/lib/jobs/control';
import { writerSiteActive } from '@/lib/operations/dr/epoch';
import { synchronizeKoreanQueries } from './repository';

export const ORACLE_KOREAN_SIGNAL = 'Oracle Korean';
/** Runs on the elected home crawler. Language is a routing fact, never AI authorship evidence. */
export async function applyKoreanDiscovery(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const settings = await getSettings();
  if (!settings.enabled) return { done: true };
  await synchronizeKoreanQueries(settings, ctx.lease);
  const [control] = await db.execute<{ enabled: boolean }>(sql`SELECT enabled FROM github_ko_discovery_control WHERE id=1`);
  if (!control?.enabled) return { done: true };
  const rows = await db.execute<{ repo: string; signal: string; priority: number; language: string }>(sql`
    SELECT repo,signal,priority,language FROM github_ko_discovery_staging
    WHERE state='pending' AND language IN ('yes','no') ORDER BY discovered_at,repo LIMIT 100`);
  if (!ctx.hasBudget()) return {done:false};
  const yes=rows.filter(row=>row.language==='yes');
  const outcome=yes.length ? await enqueueDiscoveryBatch(yes.map(row=>({repo:row.repo,signal:ORACLE_KOREAN_SIGNAL,priority:row.priority,builder:null})), settings.discover,ctx.lease)
    : {added:0,processed:0};
  const accepted=yes.slice(0,outcome.processed).map(row=>row.repo);
  const rejected=rows.filter(row=>row.language==='no').map(row=>row.repo);
  await db.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new Error('korean_apply_writer_fenced');
    if (ctx.lease) await assertJobLeaseAtWallTime(tx,ctx.lease);
    if (accepted.length) await tx.execute(sql`UPDATE github_ko_discovery_staging SET state='applied',updated_at=now()
      WHERE repo IN (${sql.join(accepted.map(repo=>sql`${repo}`),sql`,`)} ) AND state='pending' AND language='yes'`);
    if (rejected.length) await tx.execute(sql`UPDATE github_ko_discovery_staging SET state='excluded',updated_at=now()
      WHERE repo IN (${sql.join(rejected.map(repo=>sql`${repo}`),sql`,`)} ) AND state='pending' AND language='no'`);
  });
  const applied=outcome.added,excluded=rejected.length;
  await recordDiscoveryProgress({worker:process.env.SERVICE_INSTANCE_ID??'home-crawler',lane:'korean',signal:ORACLE_KOREAN_SIGNAL,
    counts:{discovered:applied,existing:outcome.processed-outcome.added}});
  ctx.log('crawl.korean_applied', { applied, excluded });
  return { done: false };
}
