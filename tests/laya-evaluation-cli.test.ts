import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { expect, it } from "vitest";

const fixture = { version: 1, samples: [{ id: "1", snapshot: {
  product: { repo: "acme/demo", name: "Demo", accessMode: "installable", description: "PRIVATE_SOURCE_MARKER",
    readme: "npm install demo", pageText: "" }, repoFacts: { stars: 900 },
}, first: { decision: "approve", durationMs: null }, secondDurationMs: null }] };
const run = (args: string[], env: Record<string, string> = {}) => new Promise<{code:number|null;output:string}>((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/evaluate-laya-speculation.ts", ...args], {
    env: { ...process.env, LAYA_URL: "", LAYA_API_KEY: "", ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", value => { output += value; });
  child.stderr.on("data", value => { output += value; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  child.on("error", reject);
  child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
});
async function files(work: (input: string, output: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "nmv-laya-test-"));
  try {
    const input = path.join(directory, "input.json"), output = path.join(directory, "result.json");
    await writeFile(input, JSON.stringify(fixture));
    await work(input, output);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

it("CLI defaults to dry-run and creates a private report without source text", async () => files(async (input, output) => {
  expect((await run(["--input", input, "--output", output])).code).toBe(0);
  const content = await readFile(output, "utf8");
  expect(JSON.parse(content)).toMatchObject({ mode: "dry_run", complete: true, measuredSpeedup: null });
  expect(content).not.toContain("PRIVATE_SOURCE_MARKER");
  expect((await stat(output)).mode & 0o777).toBe(0o600);
}));

it("CLI refuses to overwrite an existing file", async () => files(async (input, output) => {
  await writeFile(output, "keep me");
  expect((await run(["--input", input, "--output", output])).code).toBe(1);
  expect(await readFile(output, "utf8")).toBe("keep me");
}));

it("CLI live mode requires configuration without logging the input", async () => files(async (input, output) => {
  const result = await run(["--input", input, "--output", output, "--live"]);
  expect(result.code).toBe(1);
  expect(result.output).toContain("LAYA configuration required");
  expect(result.output).not.toContain("PRIVATE_SOURCE_MARKER");
  await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
}));

it("CLI uses the real HTTP client against a local API fixture", async () => files(async (input, output) => {
  const server = createServer((request, response) => {
    expect(request.url).toBe("/v1/systemone");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ answers: { software: { type: "choice", choice: "yes", probabilities: { yes: .96, no: .04 } } } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    const result = await run(["--input", input, "--output", output, "--live"], {
      LAYA_URL: `http://127.0.0.1:${address.port}`, LAYA_API_KEY: "local-test-key",
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ mode: "live", complete: true,
      productionEffect: "none", summary: { suggestedPrefetch: 1, overlapTimedSamples: 0 } });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}));
