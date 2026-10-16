import { createHash } from "node:crypto";
import { z } from "zod";
import { evidenceSettingsSchema } from "./settings";

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const SourceOwnerSchema = z.strictObject({ instanceId: identity, bootId: identity });
export type SourceOwner = z.infer<typeof SourceOwnerSchema>;
export const CanonicalSourceBindingSchema = z.strictObject({
  version: z.literal(1), productId: z.number().int().positive().max(2_147_483_647),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), kind: z.literal("documentation"), sourceKey: z.literal("canonical_site"),
  sourceUrl: z.url().max(1000), productUpdatedAt: z.string().regex(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?$/),
  policyHash: sha, sourceRevision: sha.nullable(), requestVersion: z.number().int().positive().max(2_147_483_647).nullable(),
});
export type CanonicalSourceBinding = z.infer<typeof CanonicalSourceBindingSchema>;
export const SourceJobSchema = z.strictObject({ name: z.enum(["product-evidence-refresh", "product-site-evidence-refresh"]), token: z.string().min(1).max(120), requestedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
export const CanonicalSourceLeaseSchema = z.strictObject({
  binding: CanonicalSourceBindingSchema, bindingHash: sha, owner: SourceOwnerSchema, token: z.uuid(),
  epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), controlEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  leaseUntil: z.date(), job: SourceJobSchema.nullable(),
});
export type CanonicalSourceLease = z.infer<typeof CanonicalSourceLeaseSchema>;
export const SOURCE_LANES = ["admin", "normal", "admin", "catchup"] as const;
export function canonicalSourcePolicyHash(settings: unknown): string {
  return createHash("sha256").update(JSON.stringify({ version: 1, parserVersion: 1, settings: evidenceSettingsSchema.parse(settings) })).digest("hex");
}
export function sourceRefreshKey(source: { kind: string; sourceKey: string; sourceUrl: string }): string {
  return createHash("sha256").update(JSON.stringify(["source", source.kind, source.sourceKey, source.sourceUrl])).digest("hex");
}
