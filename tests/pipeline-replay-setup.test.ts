import { afterEach, expect, it, vi } from "vitest";
import { readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
const fixture = vi.hoisted(() => ({
  url: "postgres://fixture:fixture@127.0.0.1:55453/nomorevibe_test", close: vi.fn(), open: vi.fn(), read: vi.fn(), bootstrap: vi.fn(), driver: vi.fn(),
}));
vi.mock("@/tests/integration/setup", () => ({ TEST_DATABASE_URL: fixture.url }));
vi.mock("@/lib/operations/pipeline-replay-database", () => ({
  assertReplayDatabaseTarget: vi.fn(), readReplayDatabaseIdentity: fixture.read,
  openVerifiedReplayDatabase: fixture.open, bootstrapReplayDatabase: fixture.bootstrap,
}));
vi.mock("postgres", () => ({ default: fixture.driver }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
async function helper() { return import("@/tests/integration/replay-setup").catch(() => ({} as Record<string, unknown>)); }
it("reuses only an explicit identity and never bootstraps or cleans up its DB", async () => {
  vi.stubEnv("PIPELINE_REPLAY_IDENTITY_FILE", "/trusted/private/identity.json");
  fixture.read.mockResolvedValue({ databaseUrl: fixture.url }); fixture.open.mockResolvedValue({ close: fixture.close });
  const loaded = await helper(); expect(loaded.getReplayIdentityPath).toBeTypeOf("function");
  const prepare = loaded.getReplayIdentityPath as () => Promise<{ identityPath: string; release(): Promise<void> }>;
  const prepared = await prepare(); expect(prepared.identityPath).toBe("/trusted/private/identity.json");
  await prepared.release(); await prepared.release();
  expect(fixture.close).toHaveBeenCalledOnce(); expect(fixture.bootstrap).not.toHaveBeenCalled(); expect(fixture.driver).not.toHaveBeenCalled();
});
it("rejects an explicit identity for another local test DB endpoint", async () => {
  vi.stubEnv("PIPELINE_REPLAY_IDENTITY_FILE", "/trusted/private/identity.json");
  fixture.read.mockResolvedValue({ databaseUrl: fixture.url.replace("55453", "55435") });
  const loaded = await helper(); expect(loaded.getReplayIdentityPath).toBeTypeOf("function");
  const prepare = loaded.getReplayIdentityPath as () => Promise<unknown>;
  await expect(prepare()).rejects.toThrow("replay_test_database_mismatch");
  expect(fixture.open).not.toHaveBeenCalled(); expect(fixture.bootstrap).not.toHaveBeenCalled(); expect(fixture.driver).not.toHaveBeenCalled();
});
it("closes the fresh admin client when the initial ACL snapshot fails", async () => {
  vi.stubEnv("PIPELINE_REPLAY_IDENTITY_FILE", undefined);
  const end = vi.fn().mockResolvedValue(undefined);
  fixture.driver.mockReturnValue(Object.assign(vi.fn().mockRejectedValue(new Error("acl_snapshot_failed")), { end }));
  const loaded = await helper(); expect(loaded.getReplayIdentityPath).toBeTypeOf("function");
  const prepare = loaded.getReplayIdentityPath as () => Promise<unknown>;
  await expect(prepare()).rejects.toThrow("acl_snapshot_failed");
  expect(end).toHaveBeenCalledOnce();
});
it("closes the fresh admin client and preserves the identity when release verification fails", async () => {
  vi.stubEnv("PIPELINE_REPLAY_IDENTITY_FILE", undefined);
  const end = vi.fn().mockResolvedValue(undefined), begin = vi.fn();
  fixture.driver.mockReturnValue(Object.assign(vi.fn().mockResolvedValue([]), { end, begin }));
  fixture.bootstrap.mockResolvedValue({}); fixture.read.mockResolvedValue({ databaseUrl: fixture.url });
  fixture.open.mockRejectedValue(new Error("cleanup_identity_changed"));
  const loaded = await helper();
  const prepare = loaded.getReplayIdentityPath as () => Promise<{ identityPath: string; release(): Promise<void> }>;
  const prepared = await prepare();
  await writeFile(prepared.identityPath, "inspection_canary", { mode: 0o600 });
  try {
    await expect(prepared.release()).rejects.toThrow("cleanup_identity_changed");
    expect(end).toHaveBeenCalledOnce(); expect(begin).not.toHaveBeenCalled();
    expect(await readFile(prepared.identityPath, "utf8")).toBe("inspection_canary");
  } finally { await unlink(prepared.identityPath); await rmdir(dirname(prepared.identityPath)); }
});
