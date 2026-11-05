import { createHash } from "node:crypto";

/** Same endpoint/engine aliases are one member; independent endpoints remain separate replicas. */
export function taskPoolEngineKey(connection: { kind: string; cliTool?: string | null; baseUrl: string | null; deviceId: string }, canonicalModel: string): string {
  return createHash("sha256").update(JSON.stringify([connection.kind, connection.cliTool ?? null,
    connection.baseUrl ?? connection.deviceId, canonicalModel])).digest("hex");
}
