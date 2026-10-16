import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { searchVerifyMemberKeys, searchVerifyGenerationHash, searchVerifyLogicalWorkKey, searchVerifyInputHash, searchVerifyInputSchema,
  searchVerifyDispatchBindingSchema, searchVerifyDispatchBindingHash, searchVerifyModelDispatchSchema, searchVerifyGatewayTerminalEvidenceSchema,
  firstSearchVerifyStep, nextSearchVerifyStep, searchVerifyStepKeywords, modelCapacityPolicyHash,
  type SearchVerifyInput, type SearchVerifyMember, type SearchVerifyStep, type SearchVerifyOutcome, type ModelCapacityPolicy } from "@/lib/llm/capacity";

const sha = "a".repeat(64), other = "b".repeat(64);
const member = (mode: "full" | "chunk" = "chunk", keywordCount = 12): SearchVerifyMember => ({ productId: 41, slug: "academy", evidenceHash: sha,
  profile: { rowIdentityHash: other, sourceRevision: 2, verifyAttempts: 1 }, keywordsHash: sha, keywordCount, mode, policyHash: other });
const input = (step: SearchVerifyStep = { kind: "chunk", chunk: 0 }, value = member()): SearchVerifyInput => ({ member: value, model: "verify-model",
  execution: 0, step, parent: step.kind === "full" || step.kind === "chunk" && step.chunk === 0 ? null : { requestId: randomUUID(), bindingHash: sha, responseHash: other } });
function binding(value = input()) {
  return { ...value, kind: "search_verify_gateway" as const, version: 1 as const, generationHash: searchVerifyGenerationHash(value),
    logicalWorkKey: searchVerifyLogicalWorkKey(value), inputHash: searchVerifyInputHash(value), deadlineAt: 1_800_000_000_000,
    provider: "abcllm" as const, routeId: "product-search-verify" as const, wireHash: sha, servingContractHash: other, totalTokenBound: 8192, chargedTokens: 8192,
    job: { name: "product-search-verify" as const, token: randomUUID(), requestedVersion: 2 },
    role: { role: "text" as const, instanceId: "text-worker", bootId: randomUUID(), release: "release", kind: "primary" as const, epoch: 1, batch: { mode: "legacy" as const } } };
}
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 2, providerLimits: { account: 2 }, groupLimits: { engine: 2 },
  poolLimits: { reviewer: 1, text: 2 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 4, queueTtlMs: 60000, reservationTtlMs: 60000,
  routes: [{ routeId: "product-search-verify", provider: "abcllm", model: "verify-model", providerBudgetId: "account", groupId: "engine" }] };
function dispatch(value = binding()) {
  return searchVerifyModelDispatchSchema.parse({ requestId: randomUUID(), owner: { instanceId: value.role.instanceId, bootId: value.role.bootId },
    token: randomUUID(), epoch: 1, revision: 1, policyHash: modelCapacityPolicyHash(policy), binding: value, bindingHash: searchVerifyDispatchBindingHash(value) });
}
const ok = (removed: string[] = []): SearchVerifyOutcome => ({ ok: true, removed }), bad: SearchVerifyOutcome = { ok: false, error: "invalid_output" };
function walk(value: SearchVerifyMember, outcomes: (step: SearchVerifyStep) => SearchVerifyOutcome) {
  const steps: SearchVerifyStep[] = []; let step: SearchVerifyStep | "done" | "stop" = firstSearchVerifyStep(value.mode);
  while (typeof step !== "string") { steps.push(step); step = nextSearchVerifyStep(value, step, outcomes(step)); }
  return { steps, end: step };
}

describe("search-verify step order mirrors the legacy chunk algorithm", () => {
  it("uses one full call, or sequential 5/5/2 chunks, with exact sent keywords", () => {
    expect(walk(member("full", 16), () => ok())).toEqual({ steps: [{ kind: "full" }], end: "done" });
    expect(walk(member("full", 16), () => bad).end).toBe("stop");
    const words = Array.from({ length: 12 }, (_, index) => `k${index}`), chunked = walk(member(), () => ok());
    expect(chunked.steps.map(step => searchVerifyStepKeywords(words, step).length)).toEqual([5, 5, 2]);
    expect(searchVerifyStepKeywords(words, { kind: "single", chunk: 1, item: 3 })).toEqual(["k8"]);
    expect(searchVerifyStepKeywords(["b", "a", "b"], { kind: "full" })).toEqual(["b", "a", "b"]);
  });
  it("adds singletons only after an invalid multi-keyword chunk and stops at the first invalid singleton", () => {
    const repaired = walk(member(), step => step.kind === "chunk" && step.chunk === 0 ? bad : ok());
    expect(repaired.steps.map(step => step.kind)).toEqual(["chunk", "single", "single", "single", "single", "single", "chunk", "chunk"]);
    expect(walk(member(), step => step.kind === "chunk" ? bad : ok()).steps).toHaveLength(15);
    expect(walk(member(), step => step.kind === "single" && step.item === 1 ? bad : step.kind === "chunk" ? bad : ok()))
      .toEqual({ steps: [{ kind: "chunk", chunk: 0 }, { kind: "single", chunk: 0, item: 0 }, { kind: "single", chunk: 0, item: 1 }], end: "stop" });
    expect(walk(member("chunk", 6), step => step.kind === "chunk" && step.chunk === 1 ? bad : ok()).end).toBe("stop");
    expect(walk(member("chunk", 16), step => step.kind === "chunk" ? bad : ok()).steps).toHaveLength(19);
  });
});

describe("fixed shape, canonical identity and full-C binding", () => {
  it("keeps a fixed product target and separates generation, execution and step keys", () => {
    const first = input(), second = input({ kind: "chunk", chunk: 1 });
    expect(searchVerifyMemberKeys(first.member)).toEqual(["search-verify:41"]);
    expect(searchVerifyGenerationHash(second)).toBe(searchVerifyGenerationHash(first));
    expect(searchVerifyLogicalWorkKey(second)).not.toBe(searchVerifyLogicalWorkKey(first));
    expect(searchVerifyLogicalWorkKey({ ...first, execution: 1 })).not.toBe(searchVerifyLogicalWorkKey(first));
    expect(searchVerifyLogicalWorkKey({ ...second, parent: { ...second.parent!, responseHash: sha } })).toBe(searchVerifyLogicalWorkKey(second));
    expect(searchVerifyInputHash({ ...second, parent: { ...second.parent!, responseHash: sha } })).not.toBe(searchVerifyInputHash(second));
    expect(`${searchVerifyLogicalWorkKey(first)}:${searchVerifyInputHash(first)}`.length).toBeLessThanOrEqual(160);
    for (const changed of [{ ...first.member, profile: { ...first.member.profile, rowIdentityHash: sha } }, { ...first.member, keywordsHash: other },
      { ...first.member, mode: "full" as const }, { ...first.member, policyHash: sha }, { ...first.member, evidenceHash: other }])
      expect(searchVerifyGenerationHash({ member: changed, model: first.model })).not.toBe(searchVerifyGenerationHash(first));
    expect(searchVerifyGenerationHash({ ...first, model: "other" })).not.toBe(searchVerifyGenerationHash(first));
  });
  it("rejects parent/first-step contradictions, mode mismatch and out-of-range steps", () => {
    const value = input();
    for (const changed of [{ ...value, parent: { requestId: randomUUID(), bindingHash: sha, responseHash: other } },
      { ...value, step: { kind: "chunk", chunk: 1 }, parent: null }, { ...value, step: { kind: "full" } },
      { ...input({ kind: "full" }, member("full")), step: { kind: "chunk", chunk: 0 } },
      { ...input({ kind: "chunk", chunk: 1 }), step: { kind: "chunk", chunk: 3 } },
      { ...input({ kind: "chunk", chunk: 1 }), step: { kind: "single", chunk: 2, item: 2 } },
      { ...input({ kind: "chunk", chunk: 1 }, member("chunk", 11)), step: { kind: "single", chunk: 2, item: 0 } },
      { ...value, execution: -1 }, { ...value, member: { ...value.member, keywordCount: 0 } }])
      expect(searchVerifyInputSchema.safeParse(changed).success).toBe(false);
    expect(searchVerifyInputSchema.safeParse(input({ kind: "single", chunk: 2, item: 1 })).success).toBe(true);
  });
  it("binds the exact input, shared deadline and full C to a legacy or versioned text owner", () => {
    const value = binding();
    expect(searchVerifyDispatchBindingSchema.parse(value)).toEqual(value);
    expect(searchVerifyDispatchBindingSchema.safeParse({ ...value, role: { ...value.role, batch: { mode: "versioned", host: "m3", batchEpoch: 2 } } }).success).toBe(true);
    for (const changed of [{ ...value, generationHash: other }, { ...value, inputHash: other }, { ...value, chargedTokens: 1 },
      { ...value, deadlineAt: 0 }, { ...value, routeId: "crawl-tagline" }, { ...value, job: { ...value.job, name: "crawl-tagline" } },
      { ...value, role: { ...value.role, role: "translation" } }, { ...value, execution: 1 }])
      expect(searchVerifyDispatchBindingSchema.safeParse(changed).success).toBe(false);
    expect(() => searchVerifyModelDispatchSchema.parse({ ...dispatch(), bindingHash: sha })).toThrow();
    expect(() => searchVerifyModelDispatchSchema.parse({ ...dispatch(), owner: { instanceId: "other", bootId: value.role.bootId } })).toThrow();
  });
  it("bounds the stored parser outcome by the physical step and the usage by the bound", () => {
    const terminal = (outcome: unknown, step: SearchVerifyStep = { kind: "chunk", chunk: 0 }) => ({ version: 1, kind: "search_verify_gateway_terminal",
      dispatch: dispatch(binding(input(step))), finishReason: "stop", responseHash: sha, actualUsage: null, provenance: "unknown", outcome });
    expect(searchVerifyGatewayTerminalEvidenceSchema.safeParse(terminal(ok(["a", "b"]))).success).toBe(true);
    expect(searchVerifyGatewayTerminalEvidenceSchema.safeParse(terminal(bad)).success).toBe(true);
    expect(searchVerifyGatewayTerminalEvidenceSchema.safeParse(terminal(ok(["a", "b", "c", "d", "e", "f"]))).success).toBe(false);
    expect(searchVerifyGatewayTerminalEvidenceSchema.safeParse(terminal(ok(["a", "b"]), { kind: "single", chunk: 0, item: 1 })).success).toBe(false);
    expect(searchVerifyGatewayTerminalEvidenceSchema.safeParse(terminal(ok(["a", "a"]))).success).toBe(false);
    expect(searchVerifyGatewayTerminalEvidenceSchema.safeParse(terminal({ ok: false, error: "timeout" })).success).toBe(false);
    expect(searchVerifyGatewayTerminalEvidenceSchema.safeParse({ ...terminal(ok()), actualUsage: { inputTokens: 8192, outputTokens: 1, totalTokens: 8193 },
      provenance: "upstream_reported" }).success).toBe(false);
  });
});

describe("0092 additive DDL", () => {
  const migration = readFileSync("drizzle/0092_model_capacity_search_verify_terminal.sql", "utf8");
  const previous = readFileSync("drizzle/0091_model_capacity_crawl_tagline_terminal.sql", "utf8");
  const checks = (text: string) => new Map([...text.matchAll(/ADD CONSTRAINT (\w+) CHECK \((.*)\);$/gm)].map(match => [match[1], match[2]]));
  it("keeps every 0091 predicate as the exact whole left alternative and adds one jsonb step index", () => {
    const before = checks(previous), after = checks(migration);
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [name, predicate] of after) expect(predicate.startsWith(`(${before.get(name)}) OR (coalesce(`)).toBe(true);
    expect(migration).toContain("CREATE UNIQUE INDEX model_capacity_requests_search_verify_step_idx ON model_capacity_requests ((dispatch_binding->>'generationHash'), (dispatch_binding->'execution'), (dispatch_binding->'step')) WHERE dispatch_binding->>'kind'='search_verify_gateway' AND state IN ('dispatched','indeterminate','settled');");
    expect(migration).not.toMatch(/\b(GRANT|REVOKE|CREATE TABLE|ADD COLUMN|CREATE FUNCTION|TRIGGER|UPDATE |DELETE |INSERT )/);
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")).entries.find((entry: { tag: string }) => entry.tag === "0092_model_capacity_search_verify_terminal");
    expect(journal).toEqual({ idx: 92, version: "7", when: 1794086400004, tag: "0092_model_capacity_search_verify_terminal", breakpoints: true });
  });
});
