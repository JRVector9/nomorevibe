import { createHash } from "node:crypto";
import { cliCatalogMetadata, type CliCatalogMetadata } from "@/lib/llm/cli-catalog-metadata";
import { readCliHostCatalog } from "./cli-host-client";
import { readCliHostTarget, type CliHostTarget } from "./cli-host-target";

const TTL_MS = 60_000;
const cached = new Map<string, { value: CliCatalogMetadata; until: number }>();
const pending = new Map<string, Promise<CliCatalogMetadata>>();

/** Successes only, one shared request per process. An expired catalog never masks a host failure. */
export async function readAdminCliCatalog(options: { fresh?: boolean; connectionId?: string; allowDisabled?: boolean; target?: CliHostTarget } = {}): Promise<CliCatalogMetadata> {
  const target = options.target ?? await readCliHostTarget(options.connectionId, { allowDisabled: options.allowDisabled });
  // Credentials distinguish cache entries but never leave memory or appear in a cache key, response or log.
  const key = createHash("sha256").update(JSON.stringify([target.connectionId, target.baseUrl, target.apiKey])).digest("hex");
  const hit = cached.get(key);
  if (!options.fresh && hit && hit.until > Date.now()) return hit.value;
  const active = pending.get(key);
  if (active) return active;
  const reading = (async () => {
    const catalog = await readCliHostCatalog(target);
    const value = cliCatalogMetadata({ cliVersion: catalog.cliVersion, observedAt: catalog.observedAt, models: catalog.models });
    if (!value) throw new Error("cli_host_catalog_invalid");
    if (cached.size >= 16) cached.delete(cached.keys().next().value!);
    cached.set(key, { value, until: Math.min(Date.now() + TTL_MS, Date.parse(value.observedAt) + TTL_MS) });
    return value;
  })().finally(() => { pending.delete(key); });
  pending.set(key, reading);
  return reading;
}
