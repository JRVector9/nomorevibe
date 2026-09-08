import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fakeCodex(name = "codex") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nomorevibe-codex-auth-"));
  directories.push(directory);
  const executable = path.join(directory, name);
  await writeFile(executable, '#!/bin/sh\nprintf "%s" "$*" > "$CAPTURE_ARGS"\ncat > "$CAPTURE_STDIN"\n');
  await chmod(executable, 0o755);
  return directory;
}

it("logs Codex in with an access token and removes the secret before starting the worker", async () => {
  const directory = await fakeCodex("custom-codex");
  const argsFile = path.join(directory, "args");
  const stdinFile = path.join(directory, "stdin");
  const result = spawnSync("sh", ["scripts/codex-auth.sh", process.execPath, "-e",
    'process.stdout.write(process.env.CODEX_ACCESS_TOKEN ? "leaked" : "clean")'], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      CODEX_CLI: path.join(directory, "custom-codex"),
      CODEX_ACCESS_TOKEN: "test-access-token",
      CAPTURE_ARGS: argsFile,
      CAPTURE_STDIN: stdinFile,
    },
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toBe("clean");
  expect(await readFile(argsFile, "utf8")).toBe("login --with-access-token");
  expect(await readFile(stdinFile, "utf8")).toBe("test-access-token");
});

it("tries an API key after an access-token login failure and still starts the worker", async () => {
  const directory = await fakeCodex();
  const argsFile = path.join(directory, "args");
  const stdinFile = path.join(directory, "stdin");
  await writeFile(path.join(directory, "codex"), `#!/bin/sh
printf '%s\n' "$*" >> "$CAPTURE_ARGS"
cat >> "$CAPTURE_STDIN"
printf '\n' >> "$CAPTURE_STDIN"
if [ "$*" = "login --with-access-token" ]; then exit 1; fi
`);
  const result = spawnSync("sh", ["scripts/codex-auth.sh", process.execPath, "-e", 'process.stdout.write("started")'], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      CODEX_ACCESS_TOKEN: "expired-access-token",
      OPENAI_API_KEY: "test-api-key",
      CAPTURE_ARGS: argsFile,
      CAPTURE_STDIN: stdinFile,
    },
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toBe("started");
  expect(await readFile(argsFile, "utf8")).toBe("login --with-access-token\nlogin --with-api-key\n");
  expect(await readFile(stdinFile, "utf8")).toBe("expired-access-token\ntest-api-key\n");
  expect(result.stderr).toContain("codex access-token authentication failed");
});
