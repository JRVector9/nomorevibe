import { sql, type SQL } from 'drizzle-orm';
import type { CollectCursor } from './collect';
import type { AgentScanState } from './types';

type UnavailableCommit = NonNullable<CollectCursor['unavailableCommits']>[number];
export type AgentScanCoverage = { limited?: boolean; unavailableCommits?: UnavailableCommit[] };
export type AgentCoverageInput = { coverage?: AgentScanCoverage | null; cursor?: CollectCursor | null };
export type AgentCoverageRevision = { limited: boolean; pending: boolean; unavailableCommits: UnavailableCommit[] };

/** Immutable completed history does not confirm unfinished or inaccessible later work. */
export function agentCoverageRevision(scan: AgentCoverageInput | null | undefined): AgentCoverageRevision | undefined {
  const limited = scan?.coverage?.limited === true || scan?.cursor?.coverageLimited === true;
  const pending = !!(scan?.cursor?.pendingTrees.length || scan?.cursor?.pendingBlobs.length || scan?.cursor?.pendingCommits?.length);
  return limited || pending ? { limited, pending,
    unavailableCommits: scan?.cursor?.unavailableCommits ?? scan?.coverage?.unavailableCommits ?? [] } : undefined;
}

export function effectiveAgentScanState(scan: AgentCoverageInput & { state: AgentScanState }): AgentScanState {
  return scan.state === 'complete' && agentCoverageRevision(scan) ? 'partial' : scan.state;
}

/** Same optional signature as the JS reader; clean historical inputs keep their hashes. */
export function agentCoverageRevisionSql(coverage: SQL, cursor: SQL): SQL {
  const limited = sql`(coalesce(${coverage}->'limited' = 'true'::jsonb, false)
    OR coalesce(${cursor}->'coverageLimited' = 'true'::jsonb, false))`;
  const pending = sql`(coalesce(jsonb_array_length(${cursor}->'pendingTrees'), 0) > 0
    OR coalesce(jsonb_array_length(${cursor}->'pendingBlobs'), 0) > 0
    OR coalesce(jsonb_array_length(${cursor}->'pendingCommits'), 0) > 0)`;
  return sql`CASE WHEN ${limited} OR ${pending} THEN jsonb_build_object('limited', ${limited}, 'pending', ${pending},
    'unavailableCommits', coalesce(${cursor}->'unavailableCommits', ${coverage}->'unavailableCommits', '[]'::jsonb))
    ELSE '{}'::jsonb END`;
}
