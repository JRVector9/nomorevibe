import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

it("native host probes only its fixed OpenCode --version with an explicit environment that excludes service secrets", async () => {
  vi.stubEnv("OPENCODE_HOST_LOCAL", "1");
  vi.stubEnv("DATABASE_URL", "postgres://test-secret");
  vi.stubEnv("OPERATIONS_AGENT_SECRET", "test-only-rpc-secret");
  vi.stubEnv("OPENCODE_API_KEY", "test-only-cli-secret");
  vi.stubEnv("NODE_OPTIONS", "--require forbidden-preload");
  vi.stubEnv("PATH", "/test-host/bin");
  // Even a configured worker env contract must not cause another tool to be probed by this dedicated host.
  vi.stubEnv("CLI_SERVING_CONTRACTS", JSON.stringify([{ version: 1, protocol: "cli-process-v1", routeId: "product-audit", provider: "claude-cli",
    model: "sonnet", cliVersion: "other-cli", inputByteCap: 100, totalTokenBound: 200, costBoundUsdMicros: null, boundProvenance: "declared" }]));
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    queueMicrotask(() => { child.stdout.write("1.19.5\n"); child.emit("close", 0); });
    return child;
  });
  const contracts = await import("@/lib/llm/cli-serving-contract");
  expect(await contracts.probeCliServingContracts()).toEqual([{ index: null, routeId: null, provider: "opencode-cli", model: null,
    status: "ready", observedVersion: "1.19.5" }]);
  await contracts.probeCliServingContracts();
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  const [command, args, options] = mocks.spawn.mock.calls[0];
  expect(command).toBe("/opt/homebrew/bin/opencode");
  expect(args).toEqual(["--version"]);
  expect(options.env).toMatchObject({ NODE_ENV: "production", HOME: "/Users/jr", USER: "jr", LOGNAME: "jr", PATH: "/test-host/bin",
    NO_COLOR: "1", OPENCODE_DISABLE_AUTOUPDATE: "true" });
  for (const key of ["DATABASE_URL", "OPERATIONS_AGENT_SECRET", "OPENCODE_API_KEY", "NODE_OPTIONS", "CLI_SERVING_CONTRACTS"])
    expect(options.env).not.toHaveProperty(key);
});
