import { createHash } from "node:crypto";
import { cliEngineRevision, type CliEngineSource } from "./cli-engine-config";

/** Ledger identity keeps distinct connections/variants separate while the wire retains the actual model ID. */
export function cliEngineModelIdentity(model: string, source: CliEngineSource): string {
  const revision = cliEngineRevision(source);
  if (!model || model.trim() !== model || model.length > 200 || /[\p{Cc}]/u.test(model)) throw new Error("invalid_cli_engine_model");
  const suffix = createHash("sha256").update(JSON.stringify([model, revision])).digest("hex").slice(0, 32);
  return `${model.slice(0, 120)}@cli-${suffix}`;
}
