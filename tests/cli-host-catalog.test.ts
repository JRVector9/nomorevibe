import { createHmac, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { parseCliHostModelsVerbose } from "@/lib/operations/cli-host-catalog";
import { opencodeReviewConfig, opencodeReviewProfile, releaseOpencodeReviewProfile } from "@/lib/crawl/agent-review-opencode";
import { createCliHostBridge, cliHostBind, cliHostToken } from "@/scripts/cli-host-bridge";
import type { CliHostRuntime } from "@/lib/operations/cli-host-runtime";

afterEach(() => vi.unstubAllEnvs());
const model = { providerID: "opencode", id: "deepseek-v4.1-flash", name: "DeepSeek Flash", limit: { context: 1_000_000 },
  options: { secret: "must not leave host" }, headers: { authorization: "must not leave host" }, variants: { high: { opaque: true }, low: {} } };
const entry = (value: unknown = model, id = "opencode/deepseek-v4.1-flash") => `${id}\n${JSON.stringify(value, null, 2)}\n`;
it("projects only actual native model IDs, labels, variant names and context limits", () => {
  const result = parseCliHostModelsVerbose(entry());
  expect(result).toEqual([{ id: "opencode/deepseek-v4.1-flash", label: "DeepSeek Flash", variants: ["high", "low"], maxModelLen: 1_000_000, vision: false }]);
  expect(JSON.stringify(result)).not.toContain("secret");
  for (const invalid of [entry() + entry(), entry(model, "other/deepseek-v4.1-flash"), entry({ ...model, variants: { "--unsafe": {} } }),
    entry().slice(0, -5), "[]", ""]) expect(() => parseCliHostModelsVerbose(invalid)).toThrow();
});
it("isolates user config, keeps the existing auth data home, blocks native package bootstrap and restores only its own profile for cleanup", async () => {
  vi.stubEnv("HOME", "/Users/jr"); vi.stubEnv("XDG_DATA_HOME", "/Users/jr/.local/share");
  vi.stubEnv("DATABASE_URL", "never-forward"); vi.stubEnv("OPERATIONS_AGENT_SECRET", "never-forward");
  vi.stubEnv("OPENCODE_CONFIG_CONTENT", "never-forward"); vi.stubEnv("OPENCODE_API_KEY", "never-forward");
  const directory = await mkdtemp(path.join(os.tmpdir(), "nmv-host-profile-test-"));
  const unrelated = await mkdtemp(path.join(os.tmpdir(), "nmv-unowned-profile-test-"));
  const unrelatedConfig = path.join(unrelated, "config", "opencode");
  await mkdir(unrelatedConfig, { recursive: true }); await chmod(unrelatedConfig, 0o500);
  try {
    await releaseOpencodeReviewProfile(unrelated);
    expect((await stat(unrelatedConfig)).mode & 0o777).toBe(0o500);
    const profile = await opencodeReviewProfile(directory);
    expect(profile.command).toBe("/opt/homebrew/bin/opencode");
    expect(profile.env).toMatchObject({ HOME: "/Users/jr", XDG_DATA_HOME: "/Users/jr/.local/share", OPENCODE_PURE: "true",
      OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true" });
    expect(profile.env).not.toHaveProperty("DATABASE_URL"); expect(profile.env).not.toHaveProperty("OPERATIONS_AGENT_SECRET");
    expect(profile.env).not.toHaveProperty("OPENCODE_API_KEY");
    const configDir = path.join(profile.env.XDG_CONFIG_HOME, "opencode");
    expect((await stat(configDir)).mode & 0o777).toBe(0o500);
    expect(JSON.parse(await readFile(path.join(configDir, "opencode.json"), "utf8"))).toEqual(JSON.parse(opencodeReviewConfig()));
    expect(profile.env.OPENCODE_CONFIG_CONTENT).toBe(opencodeReviewConfig());
    await releaseOpencodeReviewProfile(directory);
    expect((await stat(configDir)).mode & 0o777).toBe(0o700);
  } finally {
    await releaseOpencodeReviewProfile(directory); await rm(directory, { recursive: true, force: true });
    await chmod(unrelatedConfig, 0o700); await rm(unrelated, { recursive: true, force: true });
  }
});
it("rejects another account instead of using or copying its credentials", async () => {
  vi.stubEnv("HOME", "/root");
  await expect(opencodeReviewProfile("/unused")).rejects.toThrow("cli_host_identity_mismatch");
});
it("authenticates the host bridge in a separate domain and rejects unrecognized RPC fields before native operations", async () => {
  const secret = "host-test-secret-".repeat(3), catalog = vi.fn().mockResolvedValue({ bootId: randomUUID() });
  const server = createCliHostBridge({ catalog } as unknown as CliHostRuntime, secret);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing_test_address");
  const request = (token: string, body: unknown, route = "/v1/rpc") => fetch(`http://127.0.0.1:${address.port}${route}`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const connectToken = createHmac("sha256", secret).update("nomorevibe-connect-agent-rpc-v1").digest("hex");
    expect((await request(connectToken, { version: 1, action: "catalog", data: {} })).status).toBe(401);
    expect(catalog).not.toHaveBeenCalled();
    expect((await request(cliHostToken(secret), { version: 1, action: "catalog", data: {} }, "/rpc")).status).toBe(404);
    expect(catalog).not.toHaveBeenCalled();
    expect((await request(cliHostToken(secret), { version: 1, action: "catalog", data: { command: "arbitrary" } })).status).toBe(400);
    expect(catalog).not.toHaveBeenCalled();
    expect((await request(cliHostToken(secret), { version: 1, action: "catalog", data: {} })).status).toBe(200);
    expect(catalog).toHaveBeenCalledOnce();
    expect(cliHostBind("100.92.77.66")).toBe("100.92.77.66");
    expect(() => cliHostBind("0.0.0.0")).toThrow(); expect(() => cliHostBind("8.8.8.8")).toThrow();
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
