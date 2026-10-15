import { open } from "node:fs/promises";
import { compareCapacityRuns, reportCapacityRun, validateReplayPlan } from "../lib/operations/pipeline-capacity";
import { formatCapacityCliError } from "../lib/operations/pipeline-capacity-cli";

async function read(path: string) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("artifact_size_limit");
    const buffer = await file.readFile();
    if (buffer.byteLength > 64 * 1024 * 1024) throw new Error("artifact_size_limit");
    try { return JSON.parse(buffer.toString("utf8")) as unknown; }
    catch { throw new Error("invalid_artifact_json"); }
  } finally { await file.close(); }
}
async function main() {
  const [command, first, second, ...rest] = process.argv.slice(2);
  if (command === "replay") throw new Error("real_model_replay_unimplemented");
  if (rest.length || !first) throw new Error("usage: measure-pipeline-capacity report ARTIFACT | compare BASELINE CANDIDATE | replay-plan MANIFEST");
  let result: unknown;
  if (command === "report" && !second) result = reportCapacityRun(await read(first));
  else if (command === "compare" && second) result = compareCapacityRuns(await read(first), await read(second));
  else if (command === "replay-plan" && !second) {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("explicit_TEST_DATABASE_URL_required");
    result = validateReplayPlan(await read(first), url);
  } else throw new Error("invalid_command");
  console.log(JSON.stringify(result, null, 2));
}
void main().catch(error => { console.error(formatCapacityCliError(error)); process.exitCode = 1; });
