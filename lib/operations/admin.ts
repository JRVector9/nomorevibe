import { eq, sql, desc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { jobs, operationsObservations, operationsAudit, categoryDecisions } from '@/lib/db/schema';
import { JOB_NAMES } from '@/lib/jobs/catalog';
import { requestJob } from '@/lib/jobs/control';
export async function requestAdminJob(name:string,actor:string) {
  if(name==='heartbeat'||!JOB_NAMES.includes(name))throw new Error('실행 요청할 수 없는 작업입니다.');
  return db.transaction(async tx=>{
    await tx.insert(jobs).values({name}).onConflictDoNothing();
    const [job]=await tx.select().from(jobs).where(eq(jobs.name,name)).for('update');
    if(job.requestedVersion>job.processedVersion)return '이미 예약된 작업입니다.';
    if(job.lastRunAt && Date.now()-job.lastRunAt.getTime()<30_000)return '최근 실행된 작업입니다. 30초 후 다시 요청해주세요.';
    await requestJob(name,tx);
    await tx.insert(operationsAudit).values({actor,action:'request-job',target:name,detail:{}});
    return '실행 요청을 기록했습니다. 담당 워커가 순서대로 처리합니다.';
  });
}
export async function operationsData() {
  const start=Date.now();
  const observations=await db.select().from(operationsObservations);
  const dbLatencyMs=Date.now()-start;
  const [audit,held]=await Promise.all([
    db.select().from(operationsAudit).orderBy(desc(operationsAudit.createdAt)).limit(20),
    db.select({count:sql<number>`count(*)::int`}).from(categoryDecisions).where(sql`category is null and exists(select 1 from crawl_candidates c where c.repo=${categoryDecisions.repo} and c.state='approved')`),
  ]);
  return {fetchedAt:new Date().toISOString(),observations:observations.map(row=>({...row,observedAt:row.observedAt.toISOString()})),dbLatencyMs,audit:audit.map(row=>({...row,createdAt:row.createdAt.toISOString()})),held:held[0].count};
}
