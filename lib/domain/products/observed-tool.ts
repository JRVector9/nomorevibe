import { inArray, sql } from "drizzle-orm";
import { agentRepositoryObservations, agentRepositoryScans, crawlCandidates, products } from "@/lib/db/schema";
import { agentClientKeys } from "@/lib/domain/evidence/agents/view";

/** 홈 도구 집계와 같은 마지막 완료·부분 루트 조사만 본다 — 신고값과 지난 조사 흔적은 섞지 않는다 */
export function observedToolPredicate(tool: string) {
  return sql`exists (
    select 1 from ${crawlCandidates} c
    join lateral (
      select s.id from ${agentRepositoryScans} s
       where s.repository_key = lower(c.repo) and s.state in ('complete', 'partial') and s.scope = ''
       order by s.completed_at desc nulls last, s.id desc limit 1
    ) latest on true
    join ${agentRepositoryObservations} o on o.scan_id = latest.id
    where c.published_slug = ${products.slug} and ${inArray(sql<string>`o.facts->>'client'`, agentClientKeys(tool))}
  )`;
}
