import { and, eq, isNotNull } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { aiConnections } from "@/lib/db/schema";
import { openSecret } from "@/lib/security/secret-box";
import { currentReplayDb } from "@/lib/db/replay-scope";
import type { AiTaskConnectionSnapshot } from "@/lib/llm/ai-task-models-snapshot";

/** Secrets stay in server/worker memory and must never enter protocol messages, logs or UI responses. */
export type CliHostTarget = Readonly<{ connectionId: string; baseUrl: string; apiKey: string }>;
export function validateCliHostTarget(value: CliHostTarget): CliHostTarget {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.connectionId)
    || typeof value.apiKey !== "string" || value.apiKey.length < 32 || value.apiKey.length > 4096) throw new Error("cli_host_target_unavailable");
  let endpoint: URL;
  try { endpoint = new URL(value.baseUrl); } catch { throw new Error("cli_host_invalid_url"); }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname.replace(/\/$/, "") !== "/v1") throw new Error("cli_host_invalid_url");
  return Object.freeze({ connectionId: value.connectionId, baseUrl: value.baseUrl.replace(/\/$/, ""), apiKey: value.apiKey });
}
/** Runtime execution uses the exact selected rank's connection snapshot, never a default host or an environment fallback. */
export function cliHostTargetFromConnection(connection: AiTaskConnectionSnapshot): CliHostTarget {
  if (connection.kind !== "cli" || connection.cliTool !== "opencode" || !connection.enabled || connection.keyUnreadable
    || !connection.baseUrl || !connection.apiKey) throw new Error("cli_host_target_unavailable");
  return validateCliHostTarget({ connectionId: connection.id, baseUrl: connection.baseUrl, apiKey: connection.apiKey });
}
/** Admin catalog lookup: absent an explicit id there must be exactly one configured, enabled OpenCode host connection. */
export async function readCliHostTarget(connectionId?: string, options: { allowDisabled?: boolean } = {}): Promise<CliHostTarget> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const rows = await onPrimary(() => db.select({ id: aiConnections.id, baseUrl: aiConnections.baseUrl, apiKeyCiphertext: aiConnections.apiKeyCiphertext })
    .from(aiConnections).where(and(eq(aiConnections.kind, "cli"), eq(aiConnections.cliTool, "opencode"),
      connectionId ? eq(aiConnections.id, connectionId) : undefined,
      !connectionId || !options.allowDisabled ? eq(aiConnections.enabled, true) : undefined,
      isNotNull(aiConnections.baseUrl), isNotNull(aiConnections.apiKeyCiphertext))).limit(2));
  if (rows.length !== 1) throw new Error(rows.length > 1 ? "cli_host_target_ambiguous" : "cli_host_target_unavailable");
  const row = rows[0], apiKey = row.apiKeyCiphertext ? openSecret(row.apiKeyCiphertext, `ai_connections\n${row.id}`) : null;
  if (!row.baseUrl || !apiKey) throw new Error("cli_host_target_unavailable");
  return validateCliHostTarget({ connectionId: row.id, baseUrl: row.baseUrl, apiKey });
}
