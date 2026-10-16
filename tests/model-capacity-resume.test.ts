import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { modelCapacityRequestIdentitySchema } from "@/lib/llm/capacity";

const identity = () => ({ workKey: "second-review:12", owner: { instanceId: "reviewer:m3", bootId: randomUUID() },
  class: "second", pool: "reviewer", routeId: "second-review", provider: "abcllm", model: "[MLX] Model-X" });

describe("pending model request lookup identity", () => {
  it("snapshots the exact identity without requiring or inventing a request ID", () => {
    const value = identity(), before = structuredClone(value);
    const checked = modelCapacityRequestIdentitySchema.parse(value);
    expect(checked).toEqual(before);
    expect(value).toEqual(before);
    expect(checked).not.toBe(value);
    expect(checked.owner).not.toBe(value.owner);
    value.owner.instanceId = "later-owner";
    value.model = "later-model";
    expect(checked).toEqual(before);
  });

  it.each(["first", "second"])("rejects the %s class in the text pool", kind => {
    expect(modelCapacityRequestIdentitySchema.safeParse({ ...identity(), class: kind, pool: "text" }).success).toBe(false);
  });

  it.each(["reviewer", "text"])("accepts background work in the %s pool", pool => {
    expect(modelCapacityRequestIdentitySchema.parse({ ...identity(), class: "background", pool }))
      .toMatchObject({ class: "background", pool });
  });

  it.each(["requestId", "token", "state", "epoch", "groupId"])("rejects caller supplied %s", key => {
    expect(modelCapacityRequestIdentitySchema.safeParse({ ...identity(), [key]: randomUUID() }).success).toBe(false);
  });

  it.each(["workKey", "routeId", "provider", "model"])("rejects invalid %s without normalization", key => {
    for (const value of ["", " leading", "trailing ", "line\nbreak", null, 1])
      expect(modelCapacityRequestIdentitySchema.safeParse({ ...identity(), [key]: value }).success).toBe(false);
  });

  it("preserves exact provider/model identity and strict nested owner fields", () => {
    expect(modelCapacityRequestIdentitySchema.parse(identity()).model).toBe("[MLX] Model-X");
    for (const owner of [{ ...identity().owner, token: randomUUID() }, { instanceId: "owner", bootId: "old-boot" },
      { instanceId: " padded", bootId: randomUUID() }])
      expect(modelCapacityRequestIdentitySchema.safeParse({ ...identity(), owner }).success).toBe(false);
    for (const bad of [{ ...identity(), class: "third" }, { ...identity(), pool: "worker" },
      { ...identity(), workKey: "w".repeat(161) }, { ...identity(), model: "m".repeat(201) }])
      expect(modelCapacityRequestIdentitySchema.safeParse(bad).success).toBe(false);
  });
});
