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

  it("tags cacheable public pages so Cloudflare can purge them by name", async () => {
    const { default: config } = await import("../next.config");
    const rules = await config.headers!();
    const tagOf = (source: string) => rules.find((rule) => rule.source === source)?.headers
      .find((header) => header.key === "Cache-Tag")?.value;

    expect(tagOf("/")).toBe("html,lists");
    expect(tagOf("/popular")).toBe("html,lists");
    expect(tagOf("/rankings/:key")).toBe("html,lists");
    expect(tagOf("/p/:slug")).toBe("html,p-:slug");
  });

  it("does not invent a deployment ID for local builds", async () => {
    const { default: config } = await import("../next.config");

    expect(config.deploymentId).toBeUndefined();
  });
});
