import { z } from 'zod';

export const AGENT_DETECTOR_VERSION = '2026-09-06.1';
export const agentObservationSchema = z.object({
  kind: z.enum(['instruction_file','client_config','model_config','commit_attribution','declared_usage']),
  client: z.string().max(80).nullable(),
  compatibleClients: z.array(z.string().max(80)).max(30),
  modelDeveloper: z.string().max(80).nullable(),
  declaredModelId: z.string().max(160).nullable(),
  gateway: z.string().max(80).nullable(),
  routing: z.enum(['fixed','auto','fallback','unknown']),
  role: z.string().max(80).nullable(),
  scope: z.string().max(1000),
  keyPath: z.string().max(300).nullable(),
  ruleId: z.string().max(120),
  sourcePath: z.string().max(1000).nullable(),
  commitSha: z.string().regex(/^[a-f0-9]{40,64}$/),
  blobSha: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  sourceUrl: z.string().max(2000).url().refine(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port && !url.search && !url.hash; } catch { return false; }
  }),
}).strict();
export type AgentObservation = z.infer<typeof agentObservationSchema>;
export type AgentScanState = 'pending' | 'complete' | 'partial' | 'failed';
