import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { out: { type: "string" } }, strict: true, allowPositionals: false });
const outfile = path.resolve(values.out ?? path.join(root, "build", "cli-host", "cli-host-bridge.mjs"));
if (path.extname(outfile) !== ".mjs") throw new Error("--out must name an .mjs file");
await mkdir(path.dirname(outfile), { recursive: true });
const result = await build({
  absWorkingDir: root, entryPoints: ["scripts/cli-host-bridge.ts"], outfile,
  bundle: true, platform: "node", target: "node25", format: "esm", metafile: true,
  // Bundled CommonJS dependencies still use these Node globals. Keep import.meta for the entrypoint's main guard.
  banner: { js: `import { createRequire as __nmvCreateRequire } from "node:module";
import { fileURLToPath as __nmvFileURLToPath } from "node:url";
import { dirname as __nmvDirname } from "node:path";
const require = __nmvCreateRequire(import.meta.url);
const __filename = __nmvFileURLToPath(import.meta.url);
const __dirname = __nmvDirname(__filename);` },
});
// Redis ships two lazy optional peers; the host uses neither digest() nor OpenTelemetry.init().
// Preserve their original errors if those optional features are ever called; never install or shim them.
const optionalRedisPeers = new Map([["@node-rs/xxhash", "dynamic-import"], ["@opentelemetry/api", "require-call"]]);
for (const output of Object.values(result.metafile.outputs)) for (const entry of output.imports) {
  if (!entry.external || isBuiltin(entry.path)) continue;
  if (optionalRedisPeers.get(entry.path) === entry.kind) continue;
  throw new Error(`Host bundle requires an external package: ${entry.path}`);
}
await writeFile(`${outfile}.meta.json`, JSON.stringify(result.metafile, null, 2) + "\n");

// Import only. Block listening, network and child CLI calls before loading the artifact; no DB/auth environment is inherited.
const check = `import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const blocked = () => { throw new Error("bundle_import_has_runtime_side_effect"); };
net.Server.prototype.listen = blocked;
net.connect = net.createConnection = tls.connect = blocked;
http.request = http.get = https.request = https.get = blocked;
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[name] = blocked;
globalThis.fetch = blocked;
syncBuiltinESMExports();
const artifact = process.argv[1];
process.argv[1] = "__nmv_bundle_import_check__";
await import(artifact);
await new Promise(resolve => setImmediate(resolve));
if (process.exitCode) throw new Error("bundle_import_failed");`;
const verified = spawnSync(process.execPath, ["--input-type=module", "-e", check, pathToFileURL(outfile).href], {
  cwd: path.dirname(outfile), env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production" },
  encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024,
});
if (verified.error || verified.status !== 0) {
  if (verified.stderr) process.stderr.write(verified.stderr.slice(-4000));
  throw new Error(`CLI host bundle import failed (${verified.error?.code ?? verified.status ?? "signal"})`);
}
console.info(JSON.stringify({ artifact: outfile, metafile: `${outfile}.meta.json`, importOnly: "passed" }));
