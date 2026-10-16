import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ai1DispatchBindingHash, ai1DispatchBindingSchema, ai1GatewayTerminalEvidenceSchema,
  ai1ModelDispatchSchema } from "@/lib/llm/capacity";

const hash = "a".repeat(64);
const binding = () => ({ kind: "ai1_legacy_gateway" as const, version: 1 as const, logicalWorkKey: "ai1:17",
  candidateId: 17, attemptId: 29, inputHash: hash, sourceRevisionHash: hash, reviewPolicyHash: hash,
  promptVersion: "2026-10-01", rulesVersion: "2026-10-01", provider: "abcllm" as const, model: "Exact Model",
  routeId: "crawl-agent-review" as const, stageEpoch: 1, wireHash: hash, servingContractHash: hash,
  totalTokenBound: 4096, chargedTokens: 4096,
  job: { name: "crawl-agent-review" as const, token: randomUUID(), requestedVersion: 0 } });
const dispatch = () => { const value = binding(); return { requestId: randomUUID(), owner: {
  instanceId: "reviewer:m3", bootId: randomUUID() }, token: randomUUID(), epoch: 1, revision: 1,
  policyHash: hash, binding: value, bindingHash: ai1DispatchBindingHash(value) }; };
const terminal = () => ({ version: 1 as const, kind: "ai1_gateway_terminal" as const, dispatch: dispatch(),
  finishReason: "stop" as const, responseHash: hash, actualUsage: null, provenance: "unknown" as const });

describe("fixed AI1 dispatch and terminal evidence shape (not authority)", () => {
  it("snapshots exact complete binding without normalizing reviewer identity", () => {
    const value = binding(), before = structuredClone(value), parsed = ai1DispatchBindingSchema.parse(value);
    value.job.token = randomUUID(); value.model = "Changed";
    expect(parsed).toEqual(before); expect(ai1ModelDispatchSchema.safeParse(dispatch()).success).toBe(true);
  });
  it("requires the candidate logical key and full conservative C charge", () => {
    for (const change of [{ logicalWorkKey: "ai1:18" }, { chargedTokens: 4095 }, { totalTokenBound: 0 },
      { attemptId: Number.MAX_SAFE_INTEGER + 1 }, { candidateId: 1.5 }, { model: " padded" },
      { routeId: "other" }, { provider: "other" }, { token: randomUUID() }])
      expect(ai1DispatchBindingSchema.safeParse({ ...binding(), ...change }).success).toBe(false);
  });
  it("hashes the same exact binding independently of object key order", () => {
    const value = binding(), reverse = Object.fromEntries(Object.entries(value).reverse());
    expect(ai1DispatchBindingHash(value)).toBe(ai1DispatchBindingHash(reverse as typeof value));
    expect(ai1DispatchBindingHash({ ...value, attemptId: value.attemptId + 1 })).not.toBe(ai1DispatchBindingHash(value));
  });
  it("rejects a changed dispatch binding under its old hash", () => {
    const value = dispatch(); value.binding.attemptId++;
    expect(ai1ModelDispatchSchema.safeParse(value).success).toBe(false);
  });
  it.each(["stop", "length", "tool_calls", "function_call", "content_filter"])("accepts protocol terminal %s with unknown usage", finishReason => {
    expect(ai1GatewayTerminalEvidenceSchema.parse({ ...terminal(), finishReason }).actualUsage).toBeNull();
  });
  it("requires exact real usage sum within C and matching provenance", () => {
    const value = terminal();
    expect(ai1GatewayTerminalEvidenceSchema.parse({ ...value, actualUsage: { inputTokens: 0, outputTokens: 3, totalTokens: 3 },
      provenance: "upstream_reported" }).actualUsage?.totalTokens).toBe(3);
    for (const change of [{ actualUsage: null, provenance: "upstream_reported" },
      { actualUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, provenance: "unknown" },
      ...[{ inputTokens: 1, outputTokens: 2, totalTokens: 4 }, { inputTokens: 4096, outputTokens: 1, totalTokens: 4097 },
        { inputTokens: -1, outputTokens: 3, totalTokens: 2 }, { inputTokens: 1, outputTokens: true, totalTokens: 2 },
        { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER + 1 }]
        .map(actualUsage => ({ actualUsage, provenance: "upstream_reported" }))])
      expect(ai1GatewayTerminalEvidenceSchema.safeParse({ ...value, ...change }).success).toBe(false);
  });
  it("rejects unknown terminal kinds, extra fields and incomplete evidence", () => {
    for (const change of [{ finishReason: "eof" }, { responseHash: "x" }, { authority: true }, { dispatch: null },
      { dispatch: { ...dispatch(), binding: { ...binding(), job: { name: "other", token: randomUUID(), requestedVersion: 1 } } } }])
      expect(ai1GatewayTerminalEvidenceSchema.safeParse({ ...terminal(), ...change }).success).toBe(false);
  });
});
