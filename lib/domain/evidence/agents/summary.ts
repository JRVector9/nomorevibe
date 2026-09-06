import type { AgentObservation, AgentScanState } from './types';

export type AgentEvidenceSummary = {
  eligible: boolean;
  reason: 'ai_evidence_pending' | 'ai_evidence_insufficient' | 'ai_evidence_not_found'
    | 'repository_relationship_conflict' | 'ai_evidence_supported';
  executionVerified: false;
};
export type SummaryInput = {
  scanState: AgentScanState;
  relationship: 'same_product' | 'unknown' | 'conflict';
  /** Callers must filter these to the current product scope and original attribution. */
  observations: AgentObservation[];
};
export function summarizeAgentEvidence(input: SummaryInput): AgentEvidenceSummary {
  const result = (reason: AgentEvidenceSummary['reason']): AgentEvidenceSummary => ({
    eligible: reason === 'ai_evidence_supported', reason, executionVerified: false,
  });
  if (input.relationship === 'conflict') return result('repository_relationship_conflict');
  if (input.scanState !== 'complete') return result('ai_evidence_pending');
  if (input.relationship !== 'same_product') return result('ai_evidence_insufficient');
  // File presence (including empty or MCP-only config) does not prove development use.
  if (input.observations.some(o => o.client && (
    (o.kind === 'model_config' && o.declaredModelId !== null && o.routing !== 'unknown') ||
    o.kind === 'commit_attribution'
  ))) return result('ai_evidence_supported');
  return result(input.observations.length ? 'ai_evidence_insufficient' : 'ai_evidence_not_found');
}
