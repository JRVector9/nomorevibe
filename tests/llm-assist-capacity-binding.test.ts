import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { localModelBindingSchema, localModelJob, localModelLogicalKey, localModelRoute, localModelTargetSchema } from "@/lib/llm/local-model-capacity-contract";

const target = { kind: "assist" as const, purpose: "assist_review" as const, workId: randomUUID(), workRevision: 2,
  claimToken: randomUUID(), task: "uptime" as const, subjectId: 42, backendId: "gpu-qwen" };
it("장비·work ID·revision을 바꿔도 같은 제품 업무의 동시 실행 fence를 우회하지 않는다", () => {
  const m1 = { ...target, workId: randomUUID(), workRevision: 3, backendId: "m1-qwen" };
  expect(localModelLogicalKey(target)).toBe(localModelLogicalKey(m1));
  expect(localModelRoute(target)).not.toBe(localModelRoute(m1));
  expect(localModelJob(target)).toBe("product-llm-assist-review");
  expect(localModelTargetSchema.safeParse({ ...target, task: "arbitrary" }).success).toBe(false);
});
it("예약 backend와 업무 claim backend가 다르면 typed binding을 거부한다", () => {
  const hash = "a".repeat(64);
  const binding = { kind: "local_model_direct", version: 1, target, logicalWorkKey: localModelLogicalKey(target), routeId: localModelRoute(target),
    provider: "local-direct", model: "qwen-test", backendId: target.backendId, physicalGroup: "gpu3090", deploymentRevision: "test",
    inputHash: hash, sourceRevisionHash: hash, reviewPolicyHash: hash, promptVersion: "test", wireHash: hash, servingContractHash: hash,
    totalTokenBound: 32000, chargedTokens: 32000, job: { name: localModelJob(target), token: randomUUID(), requestedVersion: 1 } };
  expect(localModelBindingSchema.safeParse(binding).success).toBe(true);
  expect(localModelBindingSchema.safeParse({ ...binding, backendId: "m1-qwen" }).success).toBe(false);
});
