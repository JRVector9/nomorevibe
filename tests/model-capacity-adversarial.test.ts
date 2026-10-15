import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  modelCapacityDispatchSchema, modelCapacityOwnerSchema, modelCapacityRequestSchema,
  modelCapacityReservationSchema, modelCapacityClassCycle, modelCapacityPolicyHash,
  parseModelCapacityPolicy, type ModelCapacityPolicy, type ModelCapacityRequest,
} from "@/lib/llm/capacity";

function policy(): ModelCapacityPolicy {
  return { version: 1, globalLimit: 4, providerLimits: { shared: 3, other: 2 },
    groupLimits: { primary: 2, alternate: 2 }, poolLimits: { reviewer: 3, text: 2 },
    weights: { first: 2, second: 1, background: 1 }, maxWaiting: 8,
    queueTtlMs: 2_000, reservationTtlMs: 200, routes: [
      { routeId: "primary", provider: "a", model: "Model-X", providerBudgetId: "shared", groupId: "primary" },
      { routeId: "alias", provider: "b", model: "Alias-X", providerBudgetId: "shared", groupId: "primary" },
      { routeId: "other", provider: "c", model: "Model-Y", providerBudgetId: "other", groupId: "alternate" },
    ] };
}
function changed(path: readonly string[], value: unknown): unknown {
  const copy = structuredClone(policy()) as unknown as Record<string, unknown>;
  let cursor = copy;
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
  cursor[path[path.length - 1]] = value;
  return copy;
}
const request = (): ModelCapacityRequest => ({ requestId: randomUUID(), workKey: "review:one:call:one",
  owner: { instanceId: "capacity-test", bootId: randomUUID() }, class: "first", pool: "reviewer",
  routeId: "primary", provider: "a", model: "Model-X" });

describe("capacity policy has a strict, explicit serving map", () => {
  it("parses without mutating the caller's nested policy", () => {
    const value = policy(), before = structuredClone(value);
    expect(parseModelCapacityPolicy(value)).toEqual(before);
    expect(value).toEqual(before);
  });

  const invalid: [string, readonly string[], unknown][] = [
    ["unknown root key", ["enabled"], true], ["unknown pool", ["poolLimits", "audit"], 1],
    ["unknown class", ["weights", "urgent"], 1], ["unknown route key", ["routes", "0", "apiKey"], "secret"],
    ["unsupported version", ["version"], 2], ["no routes", ["routes"], []],
    ["no provider limits", ["providerLimits"], {}], ["no group limits", ["groupLimits"], {}],
    ["missing budget reference", ["routes", "0", "providerBudgetId"], "absent"],
    ["missing group reference", ["routes", "0", "groupId"], "absent"],
    ["empty route", ["routes", "0", "routeId"], ""],
    ["oversize route", ["routes", "0", "routeId"], "r".repeat(121)],
    ["oversize provider", ["routes", "0", "provider"], "p".repeat(61)],
    ["oversize model", ["routes", "0", "model"], "m".repeat(201)],
  ];
  for (const path of [["globalLimit"], ["providerLimits", "shared"], ["groupLimits", "primary"], ["poolLimits", "reviewer"]]) {
    for (const value of [0, -1, 1.5, 257, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
      invalid.push([`${path.join(".")}=${String(value)}`, path, value]);
  }
  for (const key of ["first", "second", "background"]) for (const value of [0, -1, 1.5, 33])
    invalid.push([`weight ${key}=${value}`, ["weights", key], value]);
  for (const key of ["queueTtlMs", "reservationTtlMs"]) for (const value of [0, -1, 0.5, 3_600_001])
    invalid.push([`${key}=${value}`, [key], value]);
  for (const value of [0, -1, 1.5, 4_097]) invalid.push([`maxWaiting=${value}`, ["maxWaiting"], value]);
  it.each(invalid)("rejects %s", (_label, path, value) => {
    expect(() => parseModelCapacityPolicy(changed(path, value))).toThrow();
  });

  it("rejects duplicate exact route identities even when their assigned groups differ", () => {
    const value = policy();
    expect(() => parseModelCapacityPolicy({ ...value, routes: [...value.routes,
      { ...value.routes[0], groupId: "alternate" }] })).toThrow();
  });

  it("accepts exact provider/model aliases as separate explicit routes without inferring identity", () => {
    const value = policy();
    expect(parseModelCapacityPolicy(value).routes).toEqual(value.routes);
    expect(parseModelCapacityPolicy({ ...value, globalLimit: 256, maxWaiting: 4_096,
      queueTtlMs: 3_600_000, reservationTtlMs: 1 })).toMatchObject({ globalLimit: 256, reservationTtlMs: 1 });
  });
});

describe("capacity policy identity and finite fairness cycle", () => {
  it("has one SHA256 for reordered maps and routes without changing either input", () => {
    const left = policy(), right = { ...policy(), providerLimits: { other: 2, shared: 3 },
      groupLimits: { alternate: 2, primary: 2 }, routes: [...policy().routes].reverse() };
    const before = structuredClone({ left, right });
    const hash = modelCapacityPolicyHash(left);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(modelCapacityPolicyHash(right)).toBe(hash);
    expect({ left, right }).toEqual(before);
  });

  it.each([
    ["provider case", ["routes", "0", "provider"], "A"],
    ["model case", ["routes", "0", "model"], "model-x"],
    ["MLX label", ["routes", "0", "model"], "[MLX] Model-X"],
    ["budget assignment", ["routes", "0", "providerBudgetId"], "other"],
    ["group assignment", ["routes", "0", "groupId"], "alternate"],
    ["capacity", ["globalLimit"], 5], ["weight", ["weights", "background"], 2],
    ["reservation TTL", ["reservationTtlMs"], 201],
  ] as const)("preserves %s as policy identity", (_label, path, value) => {
    expect(modelCapacityPolicyHash(parseModelCapacityPolicy(changed(path, value)))).not.toBe(modelCapacityPolicyHash(policy()));
  });

  it("expands the fixed class order with exact nonzero shares", () => {
    const value = policy(), before = structuredClone(value);
    expect(modelCapacityClassCycle(value)).toEqual(["first", "first", "second", "background"]);
    expect(value).toEqual(before);
  });

  it("bounds the maximal expanded cycle at96 without losing background", () => {
    const value = { ...policy(), weights: { first: 32, second: 32, background: 32 } };
    const cycle = modelCapacityClassCycle(value);
    expect(cycle).toHaveLength(96);
    for (const name of ["first", "second", "background"]) expect(cycle.filter(item => item === name)).toHaveLength(32);
  });
});

describe("capacity request and handle parsing is not dispatch authority", () => {
  it("allows reviewer classes only in their pool and background in either pool", () => {
    const value = request();
    expect(modelCapacityRequestSchema.parse(value)).toEqual(value);
    for (const name of ["first", "second"]) expect(modelCapacityRequestSchema.safeParse({ ...value, class: name, pool: "text" }).success).toBe(false);
    for (const pool of ["reviewer", "text"]) expect(modelCapacityRequestSchema.safeParse({ ...value, class: "background", pool }).success).toBe(true);
  });

  it.each(["requestId", "workKey", "routeId", "provider", "model"])("rejects an empty %s", key => {
    expect(modelCapacityRequestSchema.safeParse({ ...request(), [key]: "" }).success).toBe(false);
  });

  it("rejects unknown request/owner fields and oversized identity components", () => {
    const value = request();
    for (const bad of [{ ...value, groupId: "primary" }, { ...value, token: randomUUID() },
      { ...value, owner: { ...value.owner, trusted: true } }, { ...value, workKey: "w".repeat(161) }])
      expect(modelCapacityRequestSchema.safeParse(bad).success).toBe(false);
    expect(modelCapacityOwnerSchema.safeParse({ instanceId: "i".repeat(121), bootId: randomUUID() }).success).toBe(false);
    expect(modelCapacityOwnerSchema.safeParse({ instanceId: "owner", bootId: "not-a-uuid" }).success).toBe(false);
  });

  it("validates handle structure while leaving ownership to actual DB CAS", () => {
    const value = { requestId: randomUUID(), owner: request().owner, token: randomUUID(),
      epoch: 1, revision: 1, policyHash: "a".repeat(64) };
    for (const schema of [modelCapacityReservationSchema, modelCapacityDispatchSchema]) {
      expect(schema.safeParse(value).success).toBe(true);
      for (const bad of [{ ...value, token: "bad" }, { ...value, epoch: 0 }, { ...value, revision: 1.5 },
        { ...value, policyHash: "z".repeat(64) }, { ...value, ended: true }]) expect(schema.safeParse(bad).success).toBe(false);
    }
    // These parsed objects are never passed as positive authority to repository tests.
  });
});
