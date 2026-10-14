import { open } from "node:fs/promises";
import { basename } from "node:path";
import { runXPilot, type XPilotOptions, type XPilotResult } from "@/lib/social/x-pilot";

const USAGE = "Usage: x-api-pilot.ts [--live --use-case-approved] [--fields-parameter tweet.fields|post.fields] [--query query] [--lookup-ids id,id] [--output private-file]";
export function parseXPilotArgs(args: string[]): XPilotOptions & { output?: string } {
  const options: XPilotOptions & { output?: string } = { live: false, useCaseApproved: false, fieldsParameter: "tweet.fields", lookupIds: [] };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(USAGE);
    seen.add(flag);
    if (flag === "--live") options.live = true;
    else if (flag === "--use-case-approved") options.useCaseApproved = true;
    else {
      if (!["--fields-parameter", "--query", "--lookup-ids", "--output"].includes(flag)) throw new Error(USAGE);
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(USAGE);
      if (flag === "--fields-parameter") {
        if (value !== "tweet.fields" && value !== "post.fields") throw new Error(USAGE);
        options.fieldsParameter = value;
      } else if (flag === "--query") options.query = value;
      else if (flag === "--lookup-ids") options.lookupIds = value.split(",");
      else options.output = value;
    }
  }
  return options;
}

/** Exclusive creation prevents replacing a credential file or an earlier private observation. */
export async function writeXPilotOutput(path: string, result: XPilotResult): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(result, null, 2)}\n`, "utf8"); }
  finally { await file.close(); }
}

async function main() {
  const options = parseXPilotArgs(process.argv.slice(2));
  const result = await runXPilot({ ...options, ...(options.live ? { token: process.env.X_BEARER_TOKEN } : {}) });
  if (options.output) await writeXPilotOutput(options.output, result);
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "stopped" || result.status === "skipped") process.exitCode = 1;
}
if (process.argv[1] && /^x-api-pilot\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void main().catch(error => {
    console.error(error instanceof Error && error.message === USAGE ? USAGE : "X pilot failed; no raw error or credentials were printed");
    process.exitCode = 1;
  });
}
