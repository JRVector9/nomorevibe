import { isDeepStrictEqual } from "node:util";

/**
 * Integration fixtures for engines connected directly (the abcLLM gateway was removed on 2026-10-30).
 */

/**
 * A direct admin serving contract row (engine connected directly, no key) for one route+model. Pinned with
 * setServingContractSnapshotForTest it opens that route (textRouteCallable) and gives an abcllm contract its bearer (none);
 * the contract body itself stays with the file's mocked resolver.
 */
export const directContractRow = (routeId: string, model: string) =>
  ({ routeId, model, contract: null, auth: "none" as const, apiKey: null, transport: "direct" as const });

/**
 * Test double for the transport of the removed abcLLM gateway leaves (writeTagline, writeKeywords, verifyKeywords,
 * translateTaglinesToKorean).
 *
 * The gateway was removed on 2026-10-30: the real leaves no longer send anything and end with no_key. The text jobs still take
 * that legacy branch while model capacity is disabled (the route itself needs a direct admin contract), and what the job
 * integration files check is the job's own handling of an answer: selection order, retry schedules, writer CAS, search copies.
 * Those files replace the leaf with this double. It first runs the real leaf — its own input checks still apply, and anything
 * other than the no_key end is returned as is — and only then posts the leaf's unchanged exported wire through the file's fetch
 * fixture, naming HTTP failures the way the removed leaves did. Nothing reaches a network.
 */
export async function askRemovedGatewayLeaf<T>(real: Promise<unknown>, request: typeof fetch, wire: string,
  read: (response: Response) => Promise<T>, options: { timeoutMs: number; signal?: AbortSignal }): Promise<T | { ok: false; error: string }> {
  const ended = await real;
  if (!isDeepStrictEqual(ended, { ok: false, error: "no_key" })) return ended as T;
  const deadline = AbortSignal.timeout(Math.max(1, options.timeoutMs));
  try {
    const response = await request("http://removed-gateway.invalid/v1/chat/completions", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: wire,
      signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline });
    if (!response.ok) return { ok: false, error: response.status === 404 ? "model_unavailable" : response.status === 429 ? "rate_limit" : `http_${response.status}` };
    return await read(response);
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network" };
  }
}

/** The first choice's message content of an OpenAI-shaped reply, as the removed leaves read it. */
export async function replyContent(response: Response): Promise<string> {
  const data = await response.json() as { choices?: { message?: { content?: string | null } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}
