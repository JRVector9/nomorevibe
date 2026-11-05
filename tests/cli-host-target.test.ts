import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiTaskConnectionSnapshot } from "@/lib/llm/ai-task-models-snapshot";

const mocks = vi.hoisted(() => ({ rows: [] as unknown[], open: vi.fn() }));
vi.mock("@/lib/security/secret-box", () => ({ openSecret: mocks.open }));
vi.mock("@/lib/db", () => ({ onPrimary: (read: () => unknown) => read(), db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => mocks.rows }) }) }) } }));
import { cliHostTargetFromConnection, readCliHostTarget } from "@/lib/operations/cli-host-target";
import { cliHostRequest, cliHostToken } from "@/lib/operations/cli-host-client";
import { cliHostReleaseResponseSchema } from "@/lib/operations/cli-host-protocol";
import { aiTaskModelSnapshotRows } from "@/lib/llm/ai-task-models-snapshot";

const id = randomUUID(), key = "test-only-bridge-secret-32-characters", baseUrl = "http://100.92.77.66:3031/v1";
beforeEach(() => { mocks.rows = []; mocks.open.mockReturnValue(key); });
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("default catalog requires one unambiguous configured host and decrypts only that connection's existing AAD", async () => {
  await expect(readCliHostTarget()).rejects.toThrow("cli_host_target_unavailable");
  mocks.rows = [{ id, baseUrl, apiKeyCiphertext: "test-ciphertext" }, { id: randomUUID(), baseUrl, apiKeyCiphertext: "another-ciphertext" }];
  await expect(readCliHostTarget()).rejects.toThrow("cli_host_target_ambiguous");
  expect(mocks.open).not.toHaveBeenCalled();
  mocks.rows = [{ id, baseUrl, apiKeyCiphertext: "test-ciphertext" }];
  expect(await readCliHostTarget(id)).toEqual({ connectionId: id, baseUrl, apiKey: key });
  expect(mocks.open).toHaveBeenCalledWith("test-ciphertext", `ai_connections\n${id}`);
});
it("the selected OpenCode snapshot retains its endpoint and decrypted bridge key while other connection kinds cannot execute remotely", () => {
  const [row] = aiTaskModelSnapshotRows([{ task: "first-review", slot: 1, rank: 1, model: "opencode/deepseek-v4.1-flash", enabled: true, options: {},
    connection_id: id, label: "M3 OpenCode", kind: "cli", base_url: baseUrl, api_key_ciphertext: "test-ciphertext", cli_tool: "opencode",
    device_id: "m3", connection_enabled: true, models: null, connection_options: {} }]);
  expect(cliHostTargetFromConnection(row.connection)).toEqual({ connectionId: id, baseUrl, apiKey: key });
  for (const change of [{ cliTool: "claude" }, { kind: "api" }, { enabled: false }, { keyUnreadable: true }, { baseUrl: null }, { apiKey: null }])
    expect(() => cliHostTargetFromConnection({ ...row.connection, ...change } as AiTaskConnectionSnapshot)).toThrow("cli_host_target_unavailable");
});
it("client uses only the selected registered endpoint/key and sends no secret inside the RPC body", async () => {
  vi.stubEnv("OPENCODE_HOST_URL", "http://wrong-env-host:3031/v1");
  vi.stubEnv("OPERATIONS_AGENT_SECRET", "wrong-env-secret-32-test-characters");
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ released: true }), { status: 200 }));
  vi.stubGlobal("fetch", request);
  const handle = { bootId: randomUUID(), callId: randomUUID(), connectionId: id };
  await cliHostRequest({ connectionId: id, baseUrl, apiKey: key }, { version: 1, action: "release", data: { handle } }, cliHostReleaseResponseSchema);
  const [url, options] = request.mock.calls[0];
  expect(String(url)).toBe(`${baseUrl}/rpc`);
  expect(options.headers.authorization).toBe(`Bearer ${cliHostToken(key)}`);
  expect(options.body).not.toContain(key);
  expect(options.cache).toBe("no-store");
  expect(options.redirect).toBe("error");
});
