import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { normalizeTypedLink } from '@/lib/domain/evidence/contracts';
import { AGENT_DETECTOR_VERSION, agentObservationSchema } from './types';
import { isDevelopmentPath } from './commit-changes';

export type AttributionAuditRow = {
  id:number; slug:string; repository_key:string|null; maker_builder:string|null;
  scan_id:number|null; scan_state:string|null; detector_version:string|null; head_sha:string|null;
  completed_ms:number|null; scan_error:string|null;
  relationship_state:string|null; source_state:string|null; source_success_ms:number|null;
  observations:unknown[];
};
/** Only the latest root scan and currently visible matching repository link enter the report. */
export async function loadAttributionAuditPage(executor:Pick<typeof db,'execute'>, afterId=0, limit=100) {
  if(!Number.isSafeInteger(afterId)||afterId<0||!Number.isSafeInteger(limit)||limit<1||limit>500) throw new Error('invalid audit page');
  const products = await executor.execute<{id:number;slug:string;repo_url:string|null;maker_builder:string|null}>(sql`
    SELECT id,slug,repo_url,
      CASE WHEN source <> 'crawler' OR claimed_at IS NOT NULL THEN nullif(btrim(builder),'') END maker_builder
    FROM products WHERE status IN ('seeded','verified') AND id>${afterId} ORDER BY id LIMIT ${limit}
  `);
  if(!products.length)return [];
  const identities=products.map(p=>({id:p.id,slug:p.slug,maker_builder:p.maker_builder,
    repository_key:p.repo_url?normalizeTypedLink('repository',p.repo_url)?.normalizedKey??null:null}));
  return executor.execute<AttributionAuditRow>(sql`
    SELECT p.id,p.slug,p.repository_key,p.maker_builder,
      scan.id scan_id,scan.state scan_state,scan.detector_version,scan.commit_sha head_sha,
      (extract(epoch from scan.completed_at)*1000)::double precision completed_ms,scan.last_error_code scan_error,
      source.normalized_facts->>'relationshipState' relationship_state,source.state source_state,
      (extract(epoch from source.last_success_at)*1000)::double precision source_success_ms,
      coalesce((SELECT jsonb_agg(o.facts ORDER BY o.id) FROM agent_repository_observations o
        WHERE o.scan_id=scan.id AND o.facts->>'kind'='commit_attribution'),'[]'::jsonb) observations
    FROM jsonb_to_recordset(${JSON.stringify(identities)}::jsonb)
      AS p(id integer,slug text,maker_builder text,repository_key text)
    LEFT JOIN LATERAL (SELECT s.* FROM product_evidence_sources s JOIN product_links l
      ON l.slug=s.slug AND l.kind=s.kind AND l.normalized_key=s.source_key AND l.visible
      WHERE s.slug=p.slug AND s.kind='repository' AND s.provider='github'
        AND lower(s.source_key) IN (p.repository_key,'github:'||p.repository_key)
      ORDER BY s.last_success_at DESC NULLS LAST,s.id DESC LIMIT 1) source ON true
    LEFT JOIN LATERAL (SELECT s.* FROM agent_repository_scans s WHERE s.repository_key=p.repository_key AND s.scope=''
      ORDER BY s.started_at DESC,s.id DESC LIMIT 1) scan ON true
    ORDER BY p.id
  `);
}

export function classifyAttributionAuditRow(row:AttributionAuditRow,now:Date) {
  const fresh=(ms:number|null)=>ms!==null&&Number.isFinite(ms)&&now.getTime()-ms>=0&&now.getTime()-ms<86400000;
  const scanState=!row.scan_id?'unscanned':row.detector_version!==AGENT_DETECTOR_VERSION?'outdated_detector'
    :row.scan_error?'failed':row.scan_state!=='complete'?'incomplete':!fresh(row.completed_ms)?'stale':'current';
  const related=row.source_state==='ok'&&fresh(row.source_success_ms)&&['site_link','bidirectional'].includes(row.relationship_state??'');
  const claims=row.observations.flatMap(raw=>{
    const parsed=agentObservationSchema.safeParse(raw);if(!parsed.success)return [];
    const o=parsed.data;if(o.kind!=='commit_attribution'||!o.client||o.scope!==''||!row.repository_key
      ||o.sourcePath!==null||o.blobSha!==null||o.sourceUrl!==`https://github.com/${row.repository_key}/commit/${o.commitSha}`)return [];
    const proof=o.commitEvidence;
    const reason=!proof?'legacy_without_change_evidence':proof.headSha!==row.head_sha?'head_mismatch'
      :proof.basis==='committer'||o.role==='committer'?'committer_only'
      :proof.changeKind!=='development'||!proof.changedPaths.some(isDevelopmentPath)?'no_development_change'
      :scanState!=='current'?scanState:!related?'relationship_unconfirmed':null;
    return [{client:o.client,basis:proof?.basis??'legacy',commitSha:o.commitSha,sourceUrl:o.sourceUrl,
      changedPaths:proof?.changedPaths??[],qualified:reason===null,reason,executionVerified:false as const}];
  });
  return {id:row.id,slug:row.slug,repositoryKey:row.repository_key,scanId:row.scan_id,scanState,
    relationshipConfirmed:related,makerReportedTool:row.maker_builder,claims,ignoredObservationCount:row.observations.length-claims.length,executionVerified:false as const};
}
export type AttributionAuditItem=ReturnType<typeof classifyAttributionAuditRow>;
export function createAttributionAuditSummary(){return {products:0,productsWithContributionClaims:0,
  scanStates:Object.create(null) as Record<string,number>,
  contributionTools:Object.create(null) as Record<string,number>,
  makerReportedTools:Object.create(null) as Record<string,number>};}
export function accumulateAttributionAudit(summary:ReturnType<typeof createAttributionAuditSummary>,item:AttributionAuditItem){
  summary.products++;summary.scanStates[item.scanState]=(summary.scanStates[item.scanState]??0)+1;
  const tools=new Set(item.claims.filter(c=>c.qualified).map(c=>c.client));
  if(tools.size)summary.productsWithContributionClaims++;
  for(const tool of tools)summary.contributionTools[tool]=(summary.contributionTools[tool]??0)+1;
  // Keep maker labels verbatim and separate from normalized observation client IDs.
  if(item.makerReportedTool)summary.makerReportedTools[item.makerReportedTool]=(summary.makerReportedTools[item.makerReportedTool]??0)+1;
}
