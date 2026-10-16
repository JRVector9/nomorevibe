import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { websearchQueryMemberKeys, websearchQueryLogicalWorkKey, websearchQueryInputHash, websearchQueryInputSchema,
  websearchQueryDispatchBindingSchema, websearchQueryDispatchBindingHash, websearchQueryModelDispatchSchema,
  websearchQueryGatewayTerminalEvidenceSchema, type WebsearchQueryInput, type WebsearchQueryDispatchBinding } from "@/lib/llm/capacity";
import { websearchProcessOwner } from "@/lib/llm/websearch-process-owner";

const sha = "a".repeat(64), other = "b".repeat(64);
function input(): WebsearchQueryInput {
  return { model: "query-model", member: { cacheKey: sha, sourceLocale: "ko", queryHash: other, promptVersion: 2, glossaryVersion: 1,
    cache: { kind: "present", rowIdentityHash: other, attempts: 3 } } };
}
function binding(value = input()): WebsearchQueryDispatchBinding {
  return { ...value, kind: "websearch_query_gateway", version: 1, logicalWorkKey: websearchQueryLogicalWorkKey(value.member),
    inputHash: websearchQueryInputHash(value), provider: "abcllm", routeId: "search-query-translate", wireHash: sha, servingContractHash: other,
    totalTokenBound: 4096, chargedTokens: 4096, process: { instanceId: "m3-web-1", bootId: randomUUID(), release: "release-1" } };
}
function dispatch(value = binding()) {
  return websearchQueryModelDispatchSchema.parse({ requestId: randomUUID(), owner: { instanceId: value.process.instanceId, bootId: value.process.bootId },
    token: randomUUID(), epoch: 1, revision: 1, policyHash: sha, binding: value, bindingHash: websearchQueryDispatchBindingHash(value) });
}

describe("fixed websearch-query target and input identity", () => {
  it("keeps the active fence on the cache target only, independent of model, raw case, wire and cache snapshot", () => {
    const value = input(), keys = websearchQueryMemberKeys(value.member);
    expect(keys).toEqual([`websearch-query:${sha}`]); expect(websearchQueryLogicalWorkKey(value.member)).toBe(`text:websearch-query:${sha}`);
    for (const member of [{ ...value.member, queryHash: sha }, { ...value.member, cache: { kind: "absent" as const } }])
      expect(websearchQueryMemberKeys(member)).toEqual(keys);
    expect(`${websearchQueryLogicalWorkKey(value.member)}:${websearchQueryInputHash(value)}`).toHaveLength(150);
  });
  it("changes the input hash for raw query, cache snapshot, policy and model, canonical over key order", () => {
    const value = input(), hash = websearchQueryInputHash(value);
    for (const changed of [{ ...value, model: "other" }, { ...value, member: { ...value.member, queryHash: sha } },
      { ...value, member: { ...value.member, cache: { kind: "absent" as const } } }, { ...value, member: { ...value.member, promptVersion: 3 } },
      { ...value, member: { ...value.member, glossaryVersion: null } },
      { ...value, member: { ...value.member, cache: { kind: "present" as const, rowIdentityHash: other, attempts: 4 } } }])
      expect(websearchQueryInputHash(changed)).not.toBe(hash);
    const reverse = JSON.parse(JSON.stringify(value), (_key, child) => child && typeof child === "object" && !Array.isArray(child)
      ? Object.fromEntries(Object.entries(child).reverse()) : child);
    expect(websearchQueryInputHash(reverse)).toBe(hash);
  });
  it("rejects malformed targets, a Chinese glossary and extra fields", () => {
    const value = input();
    for (const changed of [{ ...value, member: { ...value.member, sourceLocale: "zh-Hans" } }, { ...value, member: { ...value.member, sourceLocale: "ja" } },
      { ...value, member: { ...value.member, cacheKey: "A".repeat(64) } }, { ...value, member: { ...value.member, promptVersion: 0 } },
      { ...value, member: { ...value.member, cache: { kind: "absent", attempts: 0 } } }, { ...value, extra: true }, { ...value, model: " padded" }])
      expect(websearchQueryInputSchema.safeParse(changed).success).toBe(false);
    expect(websearchQueryInputSchema.safeParse({ ...value, member: { ...value.member, sourceLocale: "zh-Hant", glossaryVersion: null } }).success).toBe(true);
  });
  it("binds the exact input, full C and actual process owner, never a role or job lease", () => {
    const value = binding();
    expect(websearchQueryDispatchBindingSchema.parse(value)).toEqual(value);
    for (const changed of [{ ...value, inputHash: other }, { ...value, logicalWorkKey: `text:websearch-query:${other}` }, { ...value, chargedTokens: 1 },
      { ...value, routeId: "crawl-tagline" }, { ...value, process: { ...value.process, bootId: "not-a-uuid" } },
      { ...value, role: { role: "text" } }, { ...value, job: { name: "search-query-translate" } }])
      expect(websearchQueryDispatchBindingSchema.safeParse(changed).success).toBe(false);
    const owned = dispatch(value);
    expect(websearchQueryModelDispatchSchema.safeParse({ ...owned, owner: { ...owned.owner, bootId: randomUUID() } }).success).toBe(false);
    expect(websearchQueryModelDispatchSchema.safeParse({ ...owned, bindingHash: other }).success).toBe(false);
  });
  it("stores only the bounded parser outcome with a consistent usage bound", () => {
    const base = { version: 1, kind: "websearch_query_gateway_terminal", dispatch: dispatch(), finishReason: "stop", responseHash: sha,
      actualUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, provenance: "upstream_reported", outcome: { ok: true, keywords: "merge pdf" } };
    expect(websearchQueryGatewayTerminalEvidenceSchema.safeParse(base).success).toBe(true);
    expect(websearchQueryGatewayTerminalEvidenceSchema.safeParse({ ...base, outcome: { ok: false, error: "invalid_output" } }).success).toBe(true);
    for (const changed of [{ ...base, outcome: { ok: false, error: "http_404" } }, { ...base, outcome: { ok: false, error: "network" } },
      { ...base, outcome: { ok: true, keywords: "" } }, { ...base, actualUsage: { inputTokens: 4096, outputTokens: 1, totalTokens: 4097 } },
      { ...base, actualUsage: null }, { ...base, kind: "crawl_tagline_gateway_terminal" }])
      expect(websearchQueryGatewayTerminalEvidenceSchema.safeParse(changed).success).toBe(false);
  });
});

describe("actual process owner", () => {
  it("uses the existing service instance identity and one boot per process, deferring when configuration is absent", async () => {
    const env = { SERVICE_INSTANCE_ID: "m3-web-1", RELEASE_TAG: "release-1" };
    const first = websearchProcessOwner(env), second = websearchProcessOwner({ ...env, RELEASE_TAG: "release-2" });
    expect(first).toMatchObject({ instanceId: "m3-web-1", release: "release-1" }); expect(second?.bootId).toBe(first?.bootId);
    expect(Object.isFrozen(first)).toBe(true);
    expect(websearchProcessOwner({ SERVICE_INSTANCE_ID: "m3-web-1", NEXT_DEPLOYMENT_ID: "deploy-1" })?.release).toBe("deploy-1");
    for (const missing of [{ RELEASE_TAG: "r" }, { SERVICE_INSTANCE_ID: "m3:web", RELEASE_TAG: "r" }, { SERVICE_INSTANCE_ID: "m3-web-1" },
      { SERVICE_INSTANCE_ID: "m3-web-1", RELEASE_TAG: "bad\nrelease" }])
      expect(websearchProcessOwner(missing)).toBeNull();
    vi.resetModules();
    const reloaded = await import("@/lib/llm/websearch-process-owner");
    expect(reloaded.websearchProcessOwner(env)?.bootId).toBe(first?.bootId);
  });
});
