/** Dedicated LOCAL test DB only. Does not touch existing rows; removes its own fixture. */
import { randomUUID } from 'node:crypto';
import { assertLocalTestDatabase } from './test-database';
async function main() {
const url=process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL required');
assertLocalTestDatabase(url);
const rows=Number(process.argv[2] ?? '1000000');
if (!Number.isInteger(rows) || rows<1 || rows>1_000_000) throw new Error('rows must be 1..1000000');
process.env.DATABASE_URL=url;
const {db}=await import('../lib/db');
const {sql}=await import('drizzle-orm');
const {readReviewBacklog}=await import('../lib/crawl/review-backlog');
const prefix=`bench-${randomUUID()}/`;
try {
  await db.execute(sql`insert into crawl_frontier(repo,signal,discovered_at)
    select ${prefix} || i::text,'discovery-benchmark',now()-interval '1 day' from generate_series(1,${rows}) i`);
  const observations=[];
  for (let i=0;i<5;i++) {
    const start=performance.now();const snapshot=await readReviewBacklog();
    observations.push({ms:Math.round(performance.now()-start),queued:snapshot.queuedRepositories,timedOut:Boolean(snapshot.timedOut)});
  }
  const ms=observations.map(v=>v.ms).sort((a,b)=>a-b);
  process.stdout.write(JSON.stringify({fixtureRows:rows,p50:ms[2],p95:ms[4],observations})+'\n');
  if (observations.some(v=>v.timedOut || v.queued<rows)) process.exitCode=1;
} finally {
  await db.execute(sql`delete from crawl_frontier where repo like ${prefix+'%'}`);
  // postgres pool is lazily idle-closed; do not terminate other callers' connections.
}

}
void main().catch(error=>{process.stderr.write((error instanceof Error ? error.message : 'benchmark_failed')+'\n');process.exitCode=1;});
