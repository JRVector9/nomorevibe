import { createHmac } from "node:crypto";
import { z } from "zod";
import { assertLiveReviewAdapterAllowed } from "@/lib/crawl/review-fixture-transport";
import { setCliHostObservedVersion } from "@/lib/llm/cli-serving-contract";
import { CLI_HOST_RPC_DOMAIN, CLI_HOST_BODY_LIMIT, cliHostCatalogSchema, cliHostRequestSchema, type CliHostRequest } from "./cli-host-protocol";
import { validateCliHostTarget, type CliHostTarget } from "./cli-host-target";

export function cliHostToken(secret: string): string {
  return createHmac("sha256", secret).update(CLI_HOST_RPC_DOMAIN).digest("hex");
}
/** One HTTP attempt only. A network failure is never evidence that a CLI did not start. */
export async function cliHostRequest<T>(target: CliHostTarget, request: CliHostRequest, schema: z.ZodType<T>, timeoutMs = 8_000): Promise<T> {
  assertLiveReviewAdapterAllowed();
  const parsed = cliHostRequestSchema.parse(request);
  const pinned = validateCliHostTarget(target);
  const endpoint = new URL(pinned.baseUrl);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/rpc`;
  const body = JSON.stringify(parsed);
  if (Buffer.byteLength(body) > CLI_HOST_BODY_LIMIT) throw new Error("cli_host_request_too_large");
  const response = await fetch(endpoint, { method: "POST", cache: "no-store", redirect: "error",
    headers: { "content-type": "application/json", authorization: `Bearer ${cliHostToken(pinned.apiKey)}` }, body,
    signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error("cli_host_request_failed");
  const content = await response.text();
  if (Buffer.byteLength(content) > CLI_HOST_BODY_LIMIT) throw new Error("cli_host_response_too_large");
  return schema.parse(JSON.parse(content));
}
export async function readCliHostCatalog(target: CliHostTarget) {
  const catalog = await cliHostRequest(target, { version: 1, action: "catalog", data: {} }, cliHostCatalogSchema);
  const observed = Date.parse(catalog.observedAt);
  if (observed > Date.now() + 5_000 || Date.now() - observed > 60_000) throw new Error("cli_host_catalog_stale");
  setCliHostObservedVersion(catalog.cliVersion);
  return catalog;
}
