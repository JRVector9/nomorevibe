import { createServer, type Server } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import type { CliHostRuntime } from "../lib/operations/cli-host-runtime";
import { CLI_HOST_RPC_DOMAIN, CLI_HOST_BODY_LIMIT, cliHostRequestSchema } from "../lib/operations/cli-host-protocol";

/** Separate domain from connect-agent; its existing bearer token grants no host-CLI access. */
export function cliHostToken(secret: string): string {
  return createHmac("sha256", secret).update(CLI_HOST_RPC_DOMAIN).digest("hex");
}
export function cliHostBind(value = "127.0.0.1"): string {
  const octets = value.split(".").map(Number);
  if (isIP(value) !== 4 || (value !== "127.0.0.1" && !(octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)))
    throw new Error("OPENCODE_HOST_BIND must be loopback or a Tailscale IPv4 address");
  return value;
}

export function createCliHostBridge(runtime: CliHostRuntime, secret: string): Server {
  if (secret.length < 32) throw new Error("OPENCODE_HOST_SECRET is required");
  const expected = Buffer.from(`Bearer ${cliHostToken(secret)}`);
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store");
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      res.writeHead(401); res.end('{"error":"unauthorized"}'); return;
    }
    if (req.method !== "POST" || req.url !== "/v1/rpc") { res.writeHead(404); res.end("{}"); return; }
    let size = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > CLI_HOST_BODY_LIMIT) { res.writeHead(413); res.end('{"error":"body_too_large"}'); return; }
        chunks.push(chunk);
      }
      const checked = cliHostRequestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!checked.success) { res.writeHead(400); res.end('{"error":"invalid_request"}'); return; }
      const request = checked.data;
      let result: unknown;
      switch (request.action) {
        case "catalog": result = await runtime.catalog(); break;
        case "prepare": result = await runtime.prepare(request.data); break;
        case "run": result = await runtime.run(request.data); break;
        case "notStarted": result = await runtime.notStarted(request.data); break;
        case "responseProbe": result = await runtime.responseProbe(request.data); break;
        case "release": result = await runtime.release(request.data.handle); break;
      }
      res.end(JSON.stringify(result));
    } catch {
      // Never send a child error, stdout, stderr, account details or DB error over this boundary.
      res.writeHead(503); res.end('{"error":"cli_host_unavailable"}');
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.maxConnections = 16;
  return server;
}

async function main(): Promise<void> {
  // Do not sudo, copy account data, or fall back to a worker-installed CLI.
  if (process.platform !== "darwin" || process.getuid?.() === 0 || userInfo().username !== "jr" || process.env.HOME !== "/Users/jr")
    throw new Error("The CLI bridge must run as the existing M3 jr account");
  const secret = process.env.OPENCODE_HOST_SECRET ?? "";
  if (secret.length < 32) throw new Error("OPENCODE_HOST_SECRET is required");
  if (!process.env.DATABASE_URL) throw new Error("CLI host service configuration is required");
  const bind = cliHostBind(process.env.OPENCODE_HOST_BIND);
  const rawPort = process.env.OPENCODE_HOST_PORT ?? "3031";
  if (!/^[0-9]{4,5}$/.test(rawPort) || Number(rawPort) < 1024 || Number(rawPort) > 65535) throw new Error("Invalid OPENCODE_HOST_PORT");
  process.env.OPENCODE_HOST_LOCAL = "1";
  const [{ CliHostRuntime }, { probeCliServingContracts }] = await Promise.all([
    import("../lib/operations/cli-host-runtime"), import("../lib/llm/cli-serving-contract"),
  ]);
  const runtime = new CliHostRuntime(), server = createCliHostBridge(runtime, secret);
  await probeCliServingContracts();
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
    if (closing) return;
    closing = true;
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    void Promise.all([runtime.close(), closed]).then(() => process.exit(0), () => process.exit(1));
  });
  if (!closing) server.listen(Number(rawPort), bind, () => {
    console.info(JSON.stringify({ event: "cli_host.ready", bootId: runtime.bootId, bind, port: Number(rawPort) }));
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { console.error("cli_host_start_failed"); process.exitCode = 1; });
}
