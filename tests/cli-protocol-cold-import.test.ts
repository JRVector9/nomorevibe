import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const probe = `
  import assert from 'node:assert/strict';
  globalThis.fetch = () => { throw new Error('unexpected_import_time_network'); };
  await import(process.argv[1]);
  const loadedHost = await import('./lib/operations/cli-host-protocol.ts');
  const loadedTask = await import('./lib/operations/cli-task-protocol.ts');
  const host = loadedHost.default ?? loadedHost;
  const task = loadedTask.default ?? loadedTask;
  const handle = { bootId: '10000000-0000-4000-8000-000000000001',
    callId: '10000000-0000-4000-8000-000000000002', connectionId: '10000000-0000-4000-8000-000000000003' };
  assert.deepEqual(host.cliHostRequestSchema.parse({ version: 1, action: 'release', data: { handle } }),
    { version: 1, action: 'release', data: { handle } });
  assert.deepEqual(task.cliTaskRequestSchema.parse({ version: 1, action: 'taskRelease', data: { handle } }),
    { version: 1, action: 'taskRelease', data: { handle } });
  assert.equal(task.cliTaskNotStartedResponseSchema, host.cliHostNotStartedResponseSchema);
  for (const ending of [{ kind: 'settled', terminalEvidenceHash: 'b'.repeat(64) },
    { kind: 'indeterminate', reason: 'transport_unknown' }]) {
    const response = { handle, requestId: '10000000-0000-4000-8000-000000000004', bindingHash: 'a'.repeat(64), ...ending };
    assert.deepEqual(task.cliTaskNotStartedResponseSchema.parse(response), response);
    assert.equal(task.cliTaskNotStartedResponseSchema.safeParse({ ...response, invented: true }).success, false);
  }
  assert.equal(host.CLI_HOST_BODY_LIMIT, 384 * 1024);
  assert.equal(host.CLI_HOST_RPC_DOMAIN, 'nmv-cli-host-rpc-v1');
`;

it.each([
  "./lib/operations/cli-host-protocol.ts",
  "./lib/operations/cli-task-protocol.ts",
  "./lib/operations/cli-host-client.ts",
  "./app/api/admin/models/selected-probe/route.ts",
])("cold import of %s preserves both RPC schema families", entry => {
  // A fresh process prevents Vitest's mock graph or an earlier import from hiding initialization cycles.
  // The real modules are loaded, but no HTTP/model/DB operation is requested.
  const result = spawnSync(process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", probe, entry], {
      cwd: ROOT, timeout: 12_000, encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "postgres://cold:cold@127.0.0.1:1/cold", READ_DATABASE_URL: "",
        LOG_LEVEL: "error", NEXT_TELEMETRY_DISABLED: "1" },
    });
  expect(result.error).toBeUndefined();
  const problem = result.stderr.match(/(?:ReferenceError|Error):[^\n]*/)?.[0] ?? result.stderr.slice(0, 200);
  expect(result.status, `${entry}: ${problem}`).toBe(0);
}, 15_000);
