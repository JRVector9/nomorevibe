import { z } from "zod";

export const evidenceSettingsSchema = z.object({
  githubFactsHours: z.number().int().min(6).max(168).default(24),
  releaseFeedHours: z.number().int().min(1).max(48).default(6),
  linkCheckHours: z.number().int().min(6).max(168).default(24),
  staleAfterIntervals: z.number().int().min(2).max(10).default(2),
  maxRetries: z.number().int().min(1).max(8).default(4),
  batchSize: z.number().int().min(1).max(100).default(20),
  starDigestAbsolute: z.number().int().min(5).max(10_000).default(25),
  starDigestPercent: z.number().min(1).max(100).default(10),
}).strict();

export type EvidenceSettings = z.infer<typeof evidenceSettingsSchema>;
export const DEFAULT_EVIDENCE_SETTINGS: EvidenceSettings = evidenceSettingsSchema.parse({});
