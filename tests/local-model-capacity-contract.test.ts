import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { localModelBindingHash, localModelBindingSchema, localModelDispatchSchema, localModelJob,
  localModelLogicalKey, localModelRoute, localModelTerminalEvidenceSchema, type LocalModelTarget } from "@/lib/llm/local-model-capacity-contract";

const h = "a".repeat(64);
const target: LocalModelTarget = { kind: "audit", purpose: "audit", itemId: 7, slug: "tool" };
const binding = () => localModelBindingSchema.parse({ kind: "local_model_direct", version: 1, target,
  logicalWorkKey: localModelLogicalKey(target), routeId: localModelRoute(target), provider: "local-direct", model: "qwen",
  backendId: "gpu", physicalGroup: "gpu", deploymentRevision: "pinned", inputHash: h, sourceRevisionHash: h,
  reviewPolicyHash: h, promptVersion: "v2", wireHash: h, servingContractHash: h, totalTokenBound: 1024, chargedTokens: 1024,
  job: { name: "product-audit", token: randomUUID(), requestedVersion: 1 } });
const dispatch = () => { const b = binding(); return { requestId: randomUUID(), owner: { instanceId: "worker", bootId: randomUUID() },
  token: randomUUID(), epoch: 1, revision: 1, policyHash: h, binding: b, bindingHash: localModelBindingHash(b) }; };

describe("직접 모델 호출의 대상과 장부 계약", () => {
  it("실제 도메인 종류별 고정 작업·경로를 산출하고 임의 scope를 받지 않는다", () => {
    expect(localModelLogicalKey(target)).toBe("direct:audit:7:audit");
    expect(localModelRoute(target)).toBe("local-audit");
    expect(localModelJob({ ...target, purpose: "screen" })).toBe("audit-screen-review");
    expect(() => localModelLogicalKey({ ...target, kind: "arbitrary" } as unknown as LocalModelTarget)).toThrow();
    expect(() => localModelBindingSchema.parse({ ...binding(), job: { ...binding().job, name: "other" } })).toThrow();
    expect(() => localModelBindingSchema.parse({ ...binding(), routeId: "bypass" })).toThrow();
  });
  it("원 binding 해시와 C를 묶고 다른 모델로 바꾼 handle을 거절한다", () => {
    const d = dispatch();
    expect(localModelDispatchSchema.parse(d).bindingHash).toBe(d.bindingHash);
    expect(() => localModelDispatchSchema.parse({ ...d, binding: { ...d.binding, model: "other" } })).toThrow();
    expect(() => localModelBindingSchema.parse({ ...binding(), chargedTokens: 1 })).toThrow();
  });
  it("확인되지 않은 usage는 null이며 합산·상한·출처가 맞지 않으면 거절한다", () => {
    const e = { kind: "local_model_terminal", version: 1, dispatch: dispatch(), responseHash: h,
      finishReason: "length", actualUsage: null, provenance: "unknown" };
    expect(localModelTerminalEvidenceSchema.parse(e).actualUsage).toBeNull();
    expect(() => localModelTerminalEvidenceSchema.parse({ ...e, provenance: "upstream_reported" })).toThrow();
    expect(() => localModelTerminalEvidenceSchema.parse({ ...e, actualUsage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
      provenance: "upstream_reported" })).toThrow();
  });
});
