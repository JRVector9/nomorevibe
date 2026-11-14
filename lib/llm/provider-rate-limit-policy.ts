import { z } from "zod";

/** Explicit recovery policy for a selected serving contract, not a claimed provider quota. */
export const providerRateLimitBackoffSchema = z.object({
  initialBackoffMs: z.number().int().min(30_000).max(3_600_000),
  maxBackoffMs: z.number().int().min(30_000).max(86_400_000),
}).strict().refine(value => value.maxBackoffMs >= value.initialBackoffMs, "provider_backoff_max_below_initial");
export type ProviderRateLimitBackoffPolicy = Readonly<z.infer<typeof providerRateLimitBackoffSchema>>;
export const DEFAULT_PROVIDER_RATE_LIMIT_BACKOFF: ProviderRateLimitBackoffPolicy = Object.freeze({
  initialBackoffMs: 30_000, maxBackoffMs: 30 * 60_000,
});
