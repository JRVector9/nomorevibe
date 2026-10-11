import { z } from "zod";
import { PublicAuthError } from "@/lib/domain/accounts/request-auth";
import type { GithubResult } from "@/lib/github/client";

export type GithubStarState = "starred" | "unstarred" | "unknown" | "needs_reconnect";
export type StarView = { state: GithubStarState; revision: number; repositoryId: number; pending: boolean; operationId?: string; retryAt?: number | null; uncertain?: boolean; failure?: { status: number; code: "star_rate_limited" | "star_write_rejected" } };
export class StarWriteFailure extends PublicAuthError {
  constructor(public readonly view: StarView) { super(view.failure!.status, view.failure!.code); }
}
export class StarProviderRateLimit extends PublicAuthError {
  constructor(public readonly retryAt: number | null) { super(429, "star_rate_limited"); }
}
export type StarWrite = { starred: boolean; operationId: string; expectedRevision: number };
const writeSchema = z.object({ starred: z.boolean(), operationId: z.uuid(), expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
export function parseStarWrite(value: unknown): StarWrite {
  const parsed = writeSchema.safeParse(value);
  if (!parsed.success) throw new PublicAuthError(400, "invalid_star_request");
  return parsed.data;
}
export function starStateFromRead(result: GithubResult<unknown>): GithubStarState {
  if (result.outcome === "confirmed_success" && result.status === 204) return "starred";
  if (result.outcome === "confirmed_rejection" && result.status === 404) return "unstarred";
  if (result.outcome === "confirmed_rejection" && result.status === 401) return "needs_reconnect";
  return "unknown";
}
