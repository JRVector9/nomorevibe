import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import * as http from "node:http";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

export type OpenCodeCliCapabilities = {
  command: string;
  version: string;
  pure: boolean;
  standalone: boolean;
  variantSyntax: "flag" | "suffix" | "none";
  catalog: "verbose" | "api";
  files?: boolean;
};

const MAX_HELP_BYTES = 256 * 1024;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const MAX_READY_BYTES = 64 * 1024;
const CAPABILITY_DEADLINE_MS = 10_000;
const MODEL_DEADLINE_MS = 12_000;
const MAX_CACHE_ENTRIES = 8;
const MAX_INFLIGHT_ENTRIES = 8;
const modelId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const variantId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

type ProjectedModel = { id: string; label: string; variants: string[]; maxModelLen: number | null; vision?: boolean };

const capabilityCache = new Map<string, OpenCodeCliCapabilities>();
const inflightCapabilities = new Map<string, Promise<OpenCodeCliCapabilities>>();

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`, "m").test(help);
}

function formatJsonSupported(help: string): boolean {
  const re = /--format\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(help)) !== null) {
    if (/\bjson\b/i.test(help.slice(match.index, match.index + 200))) return true;
  }
  return false;
}

function advertisesHashVariant(help: string): boolean {
  return /(?:provider\/model|model)#(?:variant|<variant>)/i.test(help)
    || /#variant\b/i.test(help)
    || /\bvariant\b[^\n]{0,80}#[A-Za-z0-9._-]+/i.test(help)
    || /#[A-Za-z0-9._-]+[^\n]{0,80}\bvariant\b/i.test(help);
}

function runMetadata(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env, timeout, maxBuffer: MAX_HELP_BYTES, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      const out = String(stdout ?? "");
      const err = String(stderr ?? "");
      if (error) {
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: string | number };
        if (failure.killed || failure.signal || failure.code === "ETIMEDOUT"
          || failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || (!out && !err)) {
          reject(new Error("opencode_cli_metadata_unavailable"));
          return;
        }
      }
      resolve({ stdout: out, stderr: err });
    });
  });
}

export async function readOpenCodeCliCapabilities(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<OpenCodeCliCapabilities> {
  if (!path.isAbsolute(command)) throw new Error("opencode_cli_command_untrusted");
  const real = await realpath(command).catch(() => { throw new Error("opencode_cli_command_unavailable"); });
  const info = await stat(real).catch(() => { throw new Error("opencode_cli_command_unavailable"); });
  if (!info.isFile()) throw new Error("opencode_cli_command_unavailable");
  const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const key = `${real}\0${identity}`;
  const cached = capabilityCache.get(key);
  if (cached) {
    boundedSet(capabilityCache, key, cached, MAX_CACHE_ENTRIES);
    return { ...cached };
  }
  const pending = inflightCapabilities.get(key);
  if (pending) return pending;
  for (const existingKey of capabilityCache.keys()) {
    if (existingKey.startsWith(`${real}\0`) && existingKey !== key) capabilityCache.delete(existingKey);
  }
  const task = (async (): Promise<OpenCodeCliCapabilities> => {
    const deadline = Date.now() + CAPABILITY_DEADLINE_MS;
    const timeout = Math.max(1, Math.min(5_000, deadline - Date.now()));
    const [versionDoc, runDoc, modelsDoc] = await Promise.all([
      runMetadata(real, ["--version"], cwd, env, timeout),
      runMetadata(real, ["run", "--help"], cwd, env, timeout),
      runMetadata(real, ["models", "--help"], cwd, env, timeout),
    ]);
    const version = versionDoc.stdout.trim();
    if (!version || version.length > 80 || /[\p{Cc}]/u.test(version)) {
      throw new Error("opencode_cli_version_invalid");
    }
    const runHelp = `${runDoc.stdout}\n${runDoc.stderr}`;
    const modelsHelp = `${modelsDoc.stdout}\n${modelsDoc.stderr}`;
    if (!hasFlag(runHelp, "--model") || !hasFlag(runHelp, "--agent") || !formatJsonSupported(runHelp)) {
      throw new Error("opencode_cli_unsupported");
    }
    const variantHelp = `${runHelp}\n${modelsHelp}`;
    let pure = hasFlag(runHelp, "--pure") || hasFlag(modelsHelp, "--pure");
    let variantSyntax: OpenCodeCliCapabilities["variantSyntax"] = "none";
    if (hasFlag(variantHelp, "--variant")) variantSyntax = "flag";
    else if (advertisesHashVariant(variantHelp)) variantSyntax = "suffix";
    let catalog: OpenCodeCliCapabilities["catalog"];
    let standalone = hasFlag(runHelp, "--standalone") || hasFlag(modelsHelp, "--standalone");
    if (hasFlag(modelsHelp, "--verbose")) {
      catalog = "verbose";
    } else {
      const serveDoc = await runMetadata(real, ["serve", "--help"], cwd, env, Math.max(1, Math.min(5_000, deadline - Date.now())));
      const serveHelp = `${serveDoc.stdout}\n${serveDoc.stderr}`;
      standalone = standalone && hasFlag(serveHelp, "--stdio") && hasFlag(serveHelp, "--port");
      if (!standalone) throw new Error("opencode_cli_unsupported");
      pure = pure || hasFlag(serveHelp, "--pure");
      catalog = "api";
    }
    return { command: real, version, pure, standalone, variantSyntax, catalog, files: hasFlag(runHelp, "--file") };
  })();
  boundedSet(inflightCapabilities, key, task, MAX_INFLIGHT_ENTRIES);
  try {
    const capabilities = await task;
    boundedSet(capabilityCache, key, capabilities, MAX_CACHE_ENTRIES);
    return { ...capabilities };
  } finally {
    inflightCapabilities.delete(key);
  }
}

function readReadiness(child: ChildProcessByStdio<Writable, Readable, null>, deadline: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let bytes = 0;
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onExit);
      action();
    };
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const value = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += value.length;
      if (bytes > MAX_READY_BYTES) {
        settle(() => reject(new Error("opencode_cli_catalog_invalid")));
        return;
      }
      buffer += value.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          settle(() => resolve(line));
          return;
        }
        newline = buffer.indexOf("\n");
      }
    };
    const onError = () => settle(() => reject(new Error("opencode_cli_metadata_unavailable")));
    const onExit = () => settle(() => reject(new Error("opencode_cli_metadata_unavailable")));
    const timer = setTimeout(() => settle(() => reject(new Error("opencode_cli_metadata_timeout"))), Math.max(1, deadline - Date.now()));
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}

function assertAlive(child: ChildProcessByStdio<Writable, Readable, null>): void {
  if (child.exitCode !== null || child.signalCode !== null || child.killed) {
    throw new Error("opencode_cli_metadata_unavailable");
  }
}

function parseOwnedUrl(line: string): URL {
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error("opencode_cli_catalog_invalid"); }
  if (!record(value) || typeof value.url !== "string" || value.url.length > 256) {
    throw new Error("opencode_cli_catalog_invalid");
  }
  let parsed: URL;
  try { parsed = new URL(value.url); } catch { throw new Error("opencode_cli_catalog_invalid"); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1"
    || parsed.username !== "" || parsed.password !== ""
    || (parsed.pathname !== "/" && parsed.pathname !== "")
    || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("opencode_cli_catalog_invalid");
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("opencode_cli_catalog_invalid");
  }
  return parsed;
}

function getModelPayload(base: URL, password: string, deadline: number, alive: () => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(new Error("opencode_cli_metadata_timeout"));
      return;
    }
    let settled = false;
    let request: http.ClientRequest | null = null;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (request) request.destroy();
      action();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("opencode_cli_metadata_timeout"))), remaining);
    try {
      const req = http.get({
        protocol: "http:",
        hostname: "127.0.0.1",
        port: Number(base.port),
        path: "/api/model",
        method: "GET",
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`,
          Accept: "application/json",
          "Accept-Encoding": "identity",
          "Cache-Control": "no-store",
        },
        agent: false,
      }, (response) => {
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          response.resume();
          finish(() => reject(new Error("opencode_cli_metadata_unavailable")));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const value = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          size += value.length;
          if (size > MAX_CATALOG_BYTES) {
            finish(() => reject(new Error("opencode_cli_catalog_too_large")));
            return;
          }
          chunks.push(value);
        });
        response.on("end", () => {
          if (settled) return;
          try { alive(); } catch {
            finish(() => reject(new Error("opencode_cli_metadata_unavailable")));
            return;
          }
          let payload: unknown;
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            finish(() => reject(new Error("opencode_cli_catalog_invalid")));
            return;
          }
          finish(() => resolve(payload));
        });
        response.on("error", () => finish(() => reject(new Error("opencode_cli_metadata_unavailable"))));
      });
      request = req;
      req.on("error", () => finish(() => reject(new Error("opencode_cli_metadata_unavailable"))));
    } catch {
      finish(() => reject(new Error("opencode_cli_metadata_unavailable")));
    }
  });
}

function projectModels(payload: unknown): ProjectedModel[] {
  if (!record(payload) || !Array.isArray(payload.data)) throw new Error("opencode_cli_catalog_invalid");
  const data = payload.data;
  if (data.length > 512) throw new Error("opencode_cli_catalog_invalid");
  const models: ProjectedModel[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    if (!record(entry) || typeof entry.providerID !== "string" || typeof entry.id !== "string" || typeof entry.name !== "string") {
      throw new Error("opencode_cli_catalog_invalid");
    }
    const id = `${entry.providerID}/${entry.id}`;
    if (!modelId.test(id) || !id.includes("/") || seen.has(id) || models.length >= 512) {
      throw new Error("opencode_cli_catalog_invalid");
    }
    if (!entry.name.trim() || entry.name.length > 240 || /[\p{Cc}]/u.test(entry.name)) {
      throw new Error("opencode_cli_catalog_invalid");
    }
    if (!Array.isArray(entry.variants) || entry.variants.length > 32) {
      throw new Error("opencode_cli_catalog_invalid");
    }
    const variants: string[] = [];
    for (const item of entry.variants) {
      if (!record(item) || typeof item.id !== "string" || !variantId.test(item.id) || variants.includes(item.id)) {
        throw new Error("opencode_cli_catalog_invalid");
      }
      variants.push(item.id);
    }
    variants.sort();
    const limit = record(entry.limit) ? entry.limit.context : null;
    const maxModelLen = typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : null;
    const capabilities = record(entry.capabilities) ? entry.capabilities : null;
    const input = capabilities && Array.isArray(capabilities.input) ? capabilities.input : null;
    const vision = !!input && input.includes("image");
    models.push({ id, label: entry.name, variants, maxModelLen, vision });
    seen.add(id);
  }
  if (!models.length) throw new Error("opencode_cli_catalog_empty");
  return models;
}

async function waitForExit(child: ChildProcessByStdio<Writable, Readable, null>, timeout: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener("exit", onDone);
      child.removeListener("close", onDone);
      resolve(value);
    };
    const onDone = () => finish(true);
    const timer = setTimeout(() => finish(false), timeout);
    child.once("exit", onDone);
    child.once("close", onDone);
  });
}

async function terminateOwned(child: ChildProcessByStdio<Writable, Readable, null>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    try { if (!child.stdin.destroyed) child.stdin.end(); } catch {}
  }
  if (await waitForExit(child, 1_500)) return;
  try { child.kill("SIGTERM"); } catch {}
  if (await waitForExit(child, 1_500)) return;
  try { child.kill("SIGKILL"); } catch {}
  await waitForExit(child, 1_000);
}

export async function readOpenCodeV2Models(cap: OpenCodeCliCapabilities, cwd: string, env: NodeJS.ProcessEnv): Promise<{ id: string; label: string; variants: string[]; maxModelLen: number | null; vision?: boolean }[]> {
  if (!cap.standalone) throw new Error("opencode_cli_unsupported");
  if (!path.isAbsolute(cap.command)) throw new Error("opencode_cli_command_untrusted");
  const deadline = Date.now() + MODEL_DEADLINE_MS;
  const password = randomBytes(32).toString("base64url");
  const childEnv: NodeJS.ProcessEnv = { ...env, OPENCODE_PASSWORD: password };
  delete childEnv.OPENCODE_DB;
  let child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  try {
    child = spawn(cap.command, ["serve", "--stdio", "--port", "0"], {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    }) as unknown as ChildProcessByStdio<Writable, Readable, null>;
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    const readyLine = await readReadiness(child, deadline);
    assertAlive(child);
    const started = child;
    const base = parseOwnedUrl(readyLine);
    const payload = await getModelPayload(base, password, deadline, () => assertAlive(started));
    assertAlive(child);
    return projectModels(payload);
  } finally {
    if (child) await terminateOwned(child);
  }
}
