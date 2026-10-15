import { describe, expect, it } from "vitest";
import { itemBindingHash, itemOwnerSchema, itemWorkKey, parseItemBinding, type ItemBinding } from "@/lib/jobs/items/types";

const hashes = { inputHash: "a".repeat(64), sourceRevisionHash: "b".repeat(64), policyHash: "c".repeat(64) };
const review = { ...hashes, promptVersion: "review-v1", rulesVersion: "rules-v1", reviewer: { provider: "abcllm", model: "review-model" } };
const fetchBinding = { stage: "fetch", frontierId: 12, repo: "owner/repo", claim: { attempts: 1, nextAttemptAt: "2026-10-15T12:00:00.000Z" } };
const firstBinding = { stage: "ai1", candidateId: 23, ...review };
const secondBinding = { stage: "ai2", secondReviewId: 34, candidateId: 23, source: { kind: "first_attempt", firstAttemptId: 45 },
  ...review, generationKey: "d".repeat(64), vote: 34, fallbackForId: null };

describe("pipeline item identity", () => {
  it("rejects malformed identities and caller fields rather than certifying arbitrary JSON", () => {
    for (const invalid of [
      { ...firstBinding, inputHash: "not-a-hash" }, { ...firstBinding, candidateId: 0 },
      { ...firstBinding, candidateId: Number.MAX_SAFE_INTEGER + 1 }, { ...firstBinding, candidateId: Infinity },
      { ...firstBinding, workKey: "ai1:someone-else" }, { ...firstBinding, reviewer: { ...review.reviewer, model: "" } },
      { ...fetchBinding, claim: { ...fetchBinding.claim, nextAttemptAt: "2026-10-15T12:00:00.000001Z" } },
      { ...fetchBinding, claim: { ...fetchBinding.claim, attempts: -1 } },
      { ...secondBinding, source: { kind: "published", slug: "published", firstAttemptId: 45 } },
      { ...secondBinding, vote: 999 },
    ]) expect(() => parseItemBinding(invalid), JSON.stringify(invalid)).toThrow();
  });

  it("derives one logical key across new claims, inputs and actual fallback rows", () => {
    const fetch = parseItemBinding(fetchBinding), first = parseItemBinding(firstBinding), second = parseItemBinding(secondBinding);
    expect(itemWorkKey(fetch)).toBe("fetch:12");
    expect(itemWorkKey(parseItemBinding({ ...fetchBinding, claim: { attempts: 2, nextAttemptAt: "2026-10-15T12:10:00.000Z" } }))).toBe(itemWorkKey(fetch));
    expect(itemWorkKey(first)).toBe("ai1:23");
    expect(itemWorkKey(parseItemBinding({ ...firstBinding, inputHash: "e".repeat(64) }))).toBe(itemWorkKey(first));
    expect(itemWorkKey(second)).toBe("ai2:34");
    const fallback = parseItemBinding({ ...secondBinding, secondReviewId: 35, vote: 34, fallbackForId: 34 });
    expect(itemWorkKey(fallback)).toBe("ai2:35");
  });

  it("hashes every binding field canonically without caller insertion order", () => {
    const binding = parseItemBinding(secondBinding);
    const reordered = Object.fromEntries(Object.entries(secondBinding).reverse());
    expect(itemBindingHash(parseItemBinding(reordered))).toBe(itemBindingHash(binding));
    expect(itemBindingHash(parseItemBinding({ ...secondBinding, sourceRevisionHash: "e".repeat(64) }))).not.toBe(itemBindingHash(binding));
    expect(itemBindingHash(parseItemBinding({ ...secondBinding, reviewer: { ...review.reviewer, model: "other" } }))).not.toBe(itemBindingHash(binding));
    expect(itemBindingHash(binding)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires the exact first or published source and the actual root vote", () => {
    const published = parseItemBinding({ ...secondBinding, source: { kind: "published", slug: "published-product" } });
    expect(published.stage === "ai2" && published.source.kind).toBe("published");
    for (const invalid of [
      { ...secondBinding, source: { kind: "first_attempt" } }, { ...secondBinding, source: { kind: "published", slug: "" } },
      { ...secondBinding, fallbackForId: 34 }, { ...secondBinding, fallbackForId: 33, vote: 34 },
      { ...secondBinding, source: { kind: "first_attempt", firstAttemptId: 45, slug: "also-published" } },
    ]) expect(() => parseItemBinding(invalid)).toThrow();
  });

  it("bounds owner identities and rejects incomplete or extra owner authority", () => {
    expect(itemOwnerSchema.parse({ instanceId: "worker-a", bootId: "00000000-0000-4000-8000-000000000001" })).toEqual({
      instanceId: "worker-a", bootId: "00000000-0000-4000-8000-000000000001",
    });
    for (const owner of [{ instanceId: "worker-a" }, { instanceId: "", bootId: "x" },
      { instanceId: "x".repeat(121), bootId: "00000000-0000-4000-8000-000000000001" },
      { instanceId: "worker-a", bootId: "00000000-0000-4000-8000-000000000001", roleEpoch: 1 },
    ]) expect(itemOwnerSchema.safeParse(owner).success).toBe(false);
  });

  it("retains stage-specific narrowing without treating a binding as domain approval", () => {
    const bindings: ItemBinding[] = [parseItemBinding(fetchBinding), parseItemBinding(firstBinding), parseItemBinding(secondBinding)];
    expect(bindings.map(binding => binding.stage)).toEqual(["fetch", "ai1", "ai2"]);
  });
});
