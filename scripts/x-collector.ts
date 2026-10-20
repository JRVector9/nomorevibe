import { hostname } from "node:os";
import { basename, isAbsolute } from "node:path";
import { runXCollector, type XCollectorOptions } from "../lib/social/x-collector";

export function xCollectorConfig(args: string[], environment: Record<string, string | undefined>, host: string): XCollectorOptions {
  const invalid = () => { throw new Error("invalid_configuration"); };
  if (args.length > 1 || (args.length === 1 && !["--live", "--dry-run"].includes(args[0]))) invalid();
  for (const value of [environment.X_COLLECTION_LIVE, environment.X_USE_CASE_APPROVED])
    if (value !== undefined && !["0", "1"].includes(value)) invalid();
  const live = args[0] === "--live" || (!args.length && environment.X_COLLECTION_LIVE === "1");
  if (live && host !== "osaka-smoke") invalid();
  const stateDir = environment.X_STATE_DIR ?? "/var/lib/nomorevibe-x";
  if (!isAbsolute(stateDir) || stateDir === "/" || /[\u0000-\u001f\u007f]/.test(stateDir)) invalid();
  return { live, stateDir, useCaseApproved: environment.X_USE_CASE_APPROVED === "1", token: environment.X_BEARER_TOKEN };
}

async function main() {
  const result = await runXCollector(xCollectorConfig(process.argv.slice(2), process.env, hostname()));
  console.log(JSON.stringify(result));
  if (result.status === "stopped" || (result.status === "blocked" && result.reason !== "daily_limit")) process.exitCode = 1;
}

if (process.argv[1] && /^x-collector\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void main().catch(() => {
    console.error("X collector stopped: invalid_configuration_or_state");
    process.exitCode = 1;
  });
}
