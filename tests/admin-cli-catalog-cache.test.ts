import { afterEach, describe, expect, it, vi } from "vitest";
const host = vi.hoisted(() => vi.fn());
const resolveTarget = vi.hoisted(() => vi.fn());
vi.mock("@/lib/operations/cli-host-client", () => ({ readCliHostCatalog: host }));
vi.mock("@/lib/operations/cli-host-target", () => ({ readCliHostTarget: resolveTarget }));

afterEach(() => { vi.useRealTimers(); vi.resetModules(); host.mockReset(); resolveTarget.mockReset(); });
describe("admin existing-host catalog cache", () => {
  it("shares concurrent reads for60seconds, then reports host failure instead of stale models", async () => {
    vi.useFakeTimers();
    const started = Date.parse("2026-11-05T00:00:00.000Z");
    vi.setSystemTime(started);
    resolveTarget.mockResolvedValue({ connectionId: "11111111-1111-4111-8111-111111111111", baseUrl: "https://host.example/v1", apiKey: "a".repeat(32) });
    host.mockResolvedValue({ cliVersion: "1.19.5", observedAt: new Date(started).toISOString(),
      models: [{ id: "provider/registered-model", label: "Registered model", variants: ["low", "high"], maxModelLen: 131072 }] });
    const { readAdminCliCatalog } = await import("@/lib/operations/admin-cli-catalog");
    const [first, second] = await Promise.all([readAdminCliCatalog(), readAdminCliCatalog()]);
    expect(first).toBe(second);
    expect(host).toHaveBeenCalledTimes(1);
    vi.setSystemTime(started + 59_000);
    expect(await readAdminCliCatalog()).toBe(first);
    expect(host).toHaveBeenCalledTimes(1);
    host.mockRejectedValueOnce(new Error("host_down_during_cached_window"));
    await expect(readAdminCliCatalog({ fresh: true })).rejects.toThrow("host_down_during_cached_window");
    expect(host).toHaveBeenCalledTimes(2);
    vi.setSystemTime(started + 61_000);
    host.mockRejectedValue(new Error("cli_host_unavailable"));
    await expect(readAdminCliCatalog()).rejects.toThrow("cli_host_unavailable");
    expect(host).toHaveBeenCalledTimes(3);
  });
  it("keeps catalog caches separate across exact connection targets and RPC key changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-05T00:00:00.000Z"));
    const first = { connectionId: "11111111-1111-4111-8111-111111111111", baseUrl: "https://host.example/v1", apiKey: "a".repeat(32) };
    const second = { ...first, connectionId: "22222222-2222-4222-8222-222222222222" };
    host.mockResolvedValue({ cliVersion: "1.19.5", observedAt: new Date().toISOString(),
      models: [{ id: "provider/registered-model", label: "Registered model", variants: [], maxModelLen: null }] });
    const { readAdminCliCatalog } = await import("@/lib/operations/admin-cli-catalog");
    await readAdminCliCatalog({ target: first });
    await readAdminCliCatalog({ target: second });
    await readAdminCliCatalog({ target: first });
    expect(host).toHaveBeenCalledTimes(2);
    await readAdminCliCatalog({ target: { ...first, apiKey: "b".repeat(32) } });
    expect(host).toHaveBeenCalledTimes(3);
    expect(resolveTarget).not.toHaveBeenCalled();
  });
});
