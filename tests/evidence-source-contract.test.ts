import { expect, it } from "vitest";
import { canonicalSourcePolicyHash, SourceOwnerSchema, CanonicalSourceBindingSchema, sourceRefreshKey, SOURCE_LANES } from "@/lib/domain/evidence/source-contract";
import { DEFAULT_EVIDENCE_SETTINGS } from "@/lib/domain/evidence/settings";
it("normalizes only effective settings for a versioned policy and deterministic source key", () => {
  expect(canonicalSourcePolicyHash({})).toBe(canonicalSourcePolicyHash({ ...DEFAULT_EVIDENCE_SETTINGS }));
  expect(canonicalSourcePolicyHash({ linkCheckHours: 48 })).not.toBe(canonicalSourcePolicyHash({}));
  expect(sourceRefreshKey({ kind: "documentation", sourceKey: "canonical_site", sourceUrl: "https://one.example" })).toMatch(/^[a-f0-9]{64}$/);
  expect(SOURCE_LANES).toEqual(["admin", "normal", "admin", "catchup"]);
});
it("owner requires bounded instance and boot identity without caller authority flags", () => {
  expect(SourceOwnerSchema.parse({ instanceId: "m3-maintenance", bootId: "boot-1" })).toEqual({ instanceId: "m3-maintenance", bootId: "boot-1" });
  for (const input of [{ instanceId: "", bootId: "x" }, { instanceId: "x", bootId: "" }, { instanceId: "x", bootId: "b", ready: true }]) {
    expect(SourceOwnerSchema.safeParse(input).success).toBe(false);
  }
});
it("binding carries exact generation/source/policy and captured request identity", () => {
  const value = { version: 1, productId: 1, slug: "one", kind: "documentation", sourceKey: "canonical_site", sourceUrl: "https://one.example",
    productUpdatedAt: "2026-10-16 01:02:03.123456", policyHash: "a".repeat(64), sourceRevision: null, requestVersion: null };
  expect(CanonicalSourceBindingSchema.parse(value)).toEqual(value);
  for (const patch of [{ productId: 0 }, { kind: "repository" }, { sourceKey: "other" }, { policyHash: "x" }, { requestVersion: 0 }, { ready: true }]) {
    expect(CanonicalSourceBindingSchema.safeParse({ ...value, ...patch }).success).toBe(false);
  }
});
