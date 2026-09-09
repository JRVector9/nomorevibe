import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  delete process.env.NEXT_DEPLOYMENT_ID;
  vi.resetModules();
});

describe("Next.js multi-instance configuration", () => {
  it("uses the shared deployment ID supplied for a release", async () => {
    process.env.NEXT_DEPLOYMENT_ID = "release-7c78110";

    const { default: config } = await import("../next.config");

    expect(config.deploymentId).toBe("release-7c78110");
  });

  it("does not invent a deployment ID for local builds", async () => {
    const { default: config } = await import("../next.config");

    expect(config.deploymentId).toBeUndefined();
  });
});
