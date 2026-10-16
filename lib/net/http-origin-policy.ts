import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Operator mapping is configuration, not physical-hardware attestation. */
export const HTTP_PHYSICAL_HOSTS = ['m3', 'mini', 'oracle-osaka-smoke'] as const;
const instance = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/);
export const httpOriginPolicySchema = z.object({
  version: z.literal(1), instanceHosts: z.record(instance, z.enum(HTTP_PHYSICAL_HOSTS)).refine(v => Object.keys(v).length > 0 && Object.keys(v).length <= 200),
}).strict();
export type HttpOriginPolicy = z.infer<typeof httpOriginPolicySchema>;
export function httpOriginPolicyHash(value: unknown): string {
  const policy = httpOriginPolicySchema.parse(value);
  return createHash('sha256').update(JSON.stringify({ version: 1,
    instanceHosts: Object.fromEntries(Object.entries(policy.instanceHosts).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)),
  })).digest('hex');
}
export class HttpOriginPermitError extends Error {
  readonly name = 'HttpOriginPermitError';
  constructor(readonly code: 'configuration'|'unavailable'|'waiting_aborted'|'authority_lost'|'replay_unsupported'|'custom_transport') { super(`http_origin_permit_${code}`); }
}
/** This check never imports/queries the DB on the default path. */
export function sharedHttpEnabled(): boolean {
  const flag = process.env.HTTP_ORIGIN_PERMITS;
  if (flag === undefined || flag === '0') return false;
  if (flag === '1') return true;
  throw new HttpOriginPermitError('configuration');
}
