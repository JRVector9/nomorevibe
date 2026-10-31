import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MODEL_CAPACITY_POLICY_IGNORED_FIELDS, compatibleModelCapacityGeneration, modelCapacityPolicyHash, modelCapacityPolicySchema,
  parseModelCapacityPolicy, type ModelCapacityPolicy } from "@/lib/llm/capacity";

/**
 * PR 1b: 전역·공급자·그룹·풀 한도와 weights 는 선택 칸이 됐고 입장이 읽지 않는다. 저장된 정책 문서(rev12 모양)는 그대로 파싱되고 같은 hash 를
 * 내야 한다 — 그래야 배포 뒤 control 행의 policy_hash 검증(parsedControl)이 깨지지 않는다.
 */
const rev12Shaped = {
  version: 1 as const, globalLimit: 12, providerLimits: { supa: 4, "gpu3090-qwen": 4, "abcllm-m3-mlx": 2, "abcllm-m1-qwen": 2, "anthropic-cli": 2, "openai-cli": 2 },
  groupLimits: { supa: 4, "gpu3090-qwen": 4, "m3-mlx": 2, "m1-qwen": 2, "anthropic-cli": 2, "openai-cli": 2 },
  poolLimits: { reviewer: 10, text: 4 }, weights: { first: 4, second: 2, background: 1 }, maxWaiting: 256, queueTtlMs: 300_000, reservationTtlMs: 30_000,
  routes: [
    { routeId: "crawl-agent-review", provider: "abcllm", model: "[supa] qwen3", providerBudgetId: "supa", groupId: "supa" },
    { routeId: "product-search-verify", provider: "abcllm", model: "[supa] qwen3", providerBudgetId: "supa", groupId: "supa" },
    { routeId: "second-review", provider: "local-direct", model: "qwen3-30b", providerBudgetId: "gpu3090-qwen", groupId: "gpu3090-qwen" },
    { routeId: "local-human-deepseek", provider: "local-direct", model: "deepseek", providerBudgetId: "abcllm-m3-mlx", groupId: "m3-mlx" },
    { routeId: "product-translate", provider: "abcllm", model: "[m1] qwen", providerBudgetId: "abcllm-m1-qwen", groupId: "m1-qwen" },
    { routeId: "product-intro-check", provider: "claude-cli", model: "claude-sonnet", providerBudgetId: "anthropic-cli", groupId: "anthropic-cli" },
    { routeId: "crawl-publish-classify", provider: "codex-cli", model: "gpt-5", providerBudgetId: "openai-cli", groupId: "openai-cli" },
  ],
} satisfies ModelCapacityPolicy;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}
const sortedRoutes = (policy: ModelCapacityPolicy) => [...policy.routes].sort((a, b) =>
  a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.model < b.model ? -1 : a.model > b.model ? 1 : 0);
/** 배포 전 코드가 저장한 hash — 선택 칸이 모두 있는 문서의 정규 JSON SHA256(저장소 control 행의 policy_hash 와 같은 계산). */
const storedHash = (policy: ModelCapacityPolicy) =>
  createHash("sha256").update(JSON.stringify(canonical({ ...policy, routes: sortedRoutes(policy) }))).digest("hex");

describe("stored rev12-shaped policy keeps verifying", () => {
  it("parses the complete document unchanged and re-hashes to the hash the previous code stored", () => {
    const parsed = parseModelCapacityPolicy(rev12Shaped);
    expect(parsed).toEqual(rev12Shaped);
    expect(modelCapacityPolicyHash(parsed)).toBe(storedHash(rev12Shaped));
    expect(modelCapacityPolicyHash(JSON.parse(JSON.stringify(parsed)) as ModelCapacityPolicy)).toBe(storedHash(rev12Shaped));
  });
  it("names the ignored fields and accepts a document without any of them (new rev13 shape)", () => {
    expect([...MODEL_CAPACITY_POLICY_IGNORED_FIELDS]).toEqual(["globalLimit", "providerLimits", "groupLimits", "poolLimits", "weights"]);
    const bare = Object.fromEntries(Object.entries(rev12Shaped).filter(([key]) => !(MODEL_CAPACITY_POLICY_IGNORED_FIELDS as readonly string[]).includes(key)));
    const parsed = parseModelCapacityPolicy(bare);
    expect(parsed).toEqual(bare);
    for (const field of MODEL_CAPACITY_POLICY_IGNORED_FIELDS) expect(parsed).not.toHaveProperty(field);
    // 빠진 칸은 hash 를 바꾼다(운영자가 revision 변화를 본다) — 같은 문서는 같은 hash.
    expect(modelCapacityPolicyHash(parsed)).not.toBe(storedHash(rev12Shaped));
    expect(modelCapacityPolicyHash(parsed)).toBe(storedHash(parsed));
  });
  it("still validates present fields and references, and still refuses a route group missing from a present groupLimits map", () => {
    expect(modelCapacityPolicySchema.safeParse({ ...rev12Shaped, globalLimit: 0 }).success).toBe(false);
    expect(modelCapacityPolicySchema.safeParse({ ...rev12Shaped, poolLimits: { reviewer: 1 } }).success).toBe(false);
    expect(modelCapacityPolicySchema.safeParse({ ...rev12Shaped, weights: { first: 0, second: 1, background: 1 } }).success).toBe(false);
    expect(modelCapacityPolicySchema.safeParse({ ...rev12Shaped, groupLimits: { supa: 4 } }).success).toBe(false);
    expect(modelCapacityPolicySchema.safeParse({ ...rev12Shaped, providerLimits: { supa: 4 } }).success).toBe(false);
    // 맵이 없으면 참조 검사도 없다: 새 장비(omega)의 route 는 유효하다(장비 행은 관리자 화면에서 만든다).
    const { groupLimits, providerLimits, ...rest } = rev12Shaped; void groupLimits; void providerLimits;
    expect(modelCapacityPolicySchema.safeParse({ ...rest, routes: [...rest.routes, { routeId: "x", provider: "p", model: "m", providerBudgetId: "new-budget", groupId: "omega" }] }).success).toBe(true);
  });
});

describe("compatiblePredecessor after PR 1b", () => {
  const next = (patch: Partial<ModelCapacityPolicy>, previous: ModelCapacityPolicy = rev12Shaped): ModelCapacityPolicy =>
    ({ ...rev12Shaped, ...patch, compatiblePredecessor: { epoch: 3, revision: 12, policy: structuredClone({ ...previous, routes: [...previous.routes] }) } });
  const addedRoute = { routeId: "local-deepseek-confirm", provider: "local-direct", model: "deepseek", providerBudgetId: "abcllm-m3-mlx", groupId: "m3-mlx" };
  it("accepts an added route on an existing device and budget, and ignores changed or dropped limit maps", () => {
    const accepted = next({ routes: [...rev12Shaped.routes, addedRoute], globalLimit: 99, groupLimits: { ...rev12Shaped.groupLimits, supa: 1 } });
    const parsed = parseModelCapacityPolicy(accepted);
    expect(compatibleModelCapacityGeneration(parsed, { epoch: 3, revision: 12, policyHash: storedHash(rev12Shaped) }, { epoch: 3, revision: 13 })).toBe(true);
    const { globalLimit, providerLimits, groupLimits, poolLimits, weights, ...bare } = rev12Shaped;
    void globalLimit; void providerLimits; void groupLimits; void poolLimits; void weights;
    expect(modelCapacityPolicySchema.safeParse({ ...bare, routes: [...bare.routes, addedRoute],
      compatiblePredecessor: { epoch: 3, revision: 12, policy: structuredClone({ ...rev12Shaped, routes: [...rev12Shaped.routes] }) } }).success).toBe(true);
  });
  it("still rejects a changed or removed old route, a changed TTL/maxWaiting and a predecessor without additions", () => {
    expect(modelCapacityPolicySchema.safeParse(next({ routes: [...rev12Shaped.routes] })).success).toBe(false);
    expect(modelCapacityPolicySchema.safeParse(next({ routes: [...rev12Shaped.routes.slice(1), addedRoute] })).success).toBe(false);
    expect(modelCapacityPolicySchema.safeParse(next({ routes: [{ ...rev12Shaped.routes[0], groupId: "gpu3090-qwen" }, ...rev12Shaped.routes.slice(1), addedRoute] })).success).toBe(false);
    expect(modelCapacityPolicySchema.safeParse(next({ routes: [...rev12Shaped.routes, addedRoute], queueTtlMs: 1 })).success).toBe(false);
    expect(modelCapacityPolicySchema.safeParse(next({ routes: [...rev12Shaped.routes, addedRoute], maxWaiting: 1 })).success).toBe(false);
  });
});
