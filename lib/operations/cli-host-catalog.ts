import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { cliHostCatalogSchema, type CliHostCatalog } from "./cli-host-protocol";
import { OPENCODE_HOST_COMMAND, opencodeReviewProfile, releaseOpencodeReviewProfile } from "@/lib/crawl/agent-review-opencode";
import { setCliHostObservedVersion } from "@/lib/llm/cli-serving-contract";
import { readOpenCodeCliCapabilities, readOpenCodeV2Models } from "@/lib/crawl/opencode-cli-capabilities";

const exec = promisify(execFile);
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const modelId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const variant = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Native v1.19.5 prints a model ID line followed by a pretty JSON object. Never forward its options, headers or provider keys. */
export function parseCliHostModelsVerbose(stdout: string): CliHostCatalog["models"] {
  if (Buffer.byteLength(stdout, "utf8") > MAX_CATALOG_BYTES) throw new Error("cli_host_catalog_too_large");
  const models: CliHostCatalog["models"] = [], seen = new Set<string>();
  let at = 0;
  while (at < stdout.length) {
    while (/\s/.test(stdout[at] ?? "") && at < stdout.length) at++;
    if (at === stdout.length) break;
    const line = stdout.indexOf("\n", at);
    if (line < 0) throw new Error("cli_host_catalog_invalid");
    const id = stdout.slice(at, line).trim();
    if (!modelId.test(id) || !id.includes("/") || seen.has(id) || models.length >= 512) throw new Error("cli_host_catalog_invalid");
    at = line + 1;
    while (/\s/.test(stdout[at] ?? "") && at < stdout.length) at++;
    if (stdout[at] !== "{") throw new Error("cli_host_catalog_invalid");
    const start = at;
    let depth = 0, quoted = false, escaped = false;
    for (; at < stdout.length; at++) {
      const char = stdout[at];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) { at++; break; }
    }
    if (depth !== 0 || quoted) throw new Error("cli_host_catalog_invalid");
    const entry: unknown = JSON.parse(stdout.slice(start, at));
    if (!object(entry) || `${entry.providerID}/${entry.id}` !== id || typeof entry.name !== "string"
      || !entry.name.trim() || entry.name.length > 240 || /[\p{Cc}]/u.test(entry.name)) throw new Error("cli_host_catalog_invalid");
    const variants = entry.variants === undefined ? [] : object(entry.variants) ? Object.keys(entry.variants).sort() : null;
    if (!variants || variants.length > 32 || variants.some(value => !variant.test(value))) throw new Error("cli_host_catalog_invalid");
    const limit = object(entry.limit) ? entry.limit.context : null;
    models.push({ id, label: entry.name, variants, maxModelLen: typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : null });
    seen.add(id);
  }
  if (!models.length) throw new Error("cli_host_catalog_empty");
  return models;
}

/** Metadata commands only: no run/probe, refresh, login or API-key export. Existing jr credentials remain in their original XDG data home. */
export async function readCliHostCatalog(bootId: string): Promise<CliHostCatalog> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nmv-cli-catalog-"));
  try {
    const profile = await opencodeReviewProfile(directory);
    const capabilities = await readOpenCodeCliCapabilities(OPENCODE_HOST_COMMAND, directory, profile.env);
    const models = capabilities.catalog === "verbose"
      ? parseCliHostModelsVerbose((await exec(capabilities.command,
          [...(capabilities.standalone ? ["--standalone"] : []), "models", "--verbose", ...(capabilities.pure ? ["--pure"] : [])],
          { cwd: directory, env: profile.env, timeout: 6_000, maxBuffer: MAX_CATALOG_BYTES, encoding: "utf8" })).stdout)
      : await readOpenCodeV2Models(capabilities, directory, profile.env);
    const catalog = cliHostCatalogSchema.parse({ version: 1, bootId, cliVersion: capabilities.version,
      observedAt: new Date().toISOString(), models });
    setCliHostObservedVersion(capabilities.version);
    return catalog;
  } finally {
    await releaseOpencodeReviewProfile(directory);
    await rm(directory, { recursive: true, force: true });
  }
}
