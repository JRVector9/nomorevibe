import { describe, expect, it } from 'vitest';
import { summarizeAgentEvidence } from '@/lib/domain/evidence/agents/summary';
import type { AgentObservation } from '@/lib/domain/evidence/agents/types';

const observation: AgentObservation = {
  kind: 'instruction_file', client: null, compatibleClients: ['codex', 'kimi'],
  modelDeveloper: null, declaredModelId: null, gateway: null, routing: 'unknown',
  role: null, scope: '', keyPath: null, ruleId: 'shared.agents.v1', sourcePath: 'AGENTS.md',
  commitSha: 'a'.repeat(40), blobSha: 'b'.repeat(40),
  sourceUrl: `https://github.com/acme/app/blob/${'a'.repeat(40)}/AGENTS.md`,
};
describe('agent evidence policy', () => {
  it('keeps shared and dedicated instructions below development use evidence', () => {
    for (const client of [null, 'claude-code']) {
      expect(summarizeAgentEvidence({scanState:'complete', relationship:'same_product', observations:[{...observation, client}]}))
        .toMatchObject({eligible:false, reason:'ai_evidence_insufficient', executionVerified:false});
    }
  });
  it('accepts a commit contribution claim without claiming execution', () => {
    expect(summarizeAgentEvidence({scanState:'complete', relationship:'same_product', observations:[{...observation, kind:'commit_attribution', client:'codex'}]}))
      .toMatchObject({eligible:true, reason:'ai_evidence_supported', executionVerified:false});
  });
  it.each(['fixed', 'auto', 'fallback', 'unknown'] as const)('never promotes model configuration (%s)', routing => {
    expect(summarizeAgentEvidence({scanState:'complete', relationship:'same_product', observations:[{...observation, kind:'model_config', client:'codex', declaredModelId:'gpt-5', routing}]}))
      .toMatchObject({eligible:false, reason:'ai_evidence_insufficient', executionVerified:false});
  });
  it('does not treat committing existing work as authorship', () => {
    expect(summarizeAgentEvidence({scanState:'complete', relationship:'same_product', observations:[{...observation, kind:'commit_attribution', client:'aider', role:'committer'}]}).eligible).toBe(false);
  });
  it.each(['pending', 'partial', 'failed'] as const)('does not complete a %s scan', scanState => {
    expect(summarizeAgentEvidence({scanState, relationship:'same_product', observations:[]})).toMatchObject({eligible:false, reason:'ai_evidence_pending'});
  });
  it('requires repository relationship and reports conflicts first', () => {
    expect(summarizeAgentEvidence({scanState:'pending', relationship:'conflict', observations:[]})).toMatchObject({reason:'repository_relationship_conflict'});
    expect(summarizeAgentEvidence({scanState:'complete', relationship:'unknown', observations:[]})).toMatchObject({reason:'ai_evidence_insufficient'});
    expect(summarizeAgentEvidence({scanState:'complete', relationship:'same_product', observations:[]})).toMatchObject({reason:'ai_evidence_not_found'});
  });
  it('does not promote empty/MCP-only config or unresolved inheritance', () => {
    for (const kind of ['client_config','model_config'] as const) {
      expect(summarizeAgentEvidence({scanState:'complete', relationship:'same_product', observations:[{...observation, kind, client:'grok-build'}]}).eligible).toBe(false);
    }
  });
});
