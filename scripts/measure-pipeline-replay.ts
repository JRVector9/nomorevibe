import { open, writeFile } from "node:fs/promises";
import { formatCapacityCliError } from "../lib/operations/pipeline-capacity-cli";
import { openVerifiedReplayHandlerDatabase } from "../lib/operations/pipeline-replay-database";
import { loadVerifiedReplayArtifact, replayArtifactFromVerified, reportReplayArtifact, reportVerifiedReplayArtifact,
  type VerifiedReplayArtifact } from "../lib/operations/pipeline-replay-artifact";
import { compareReplayArtifacts, compareVerifiedReplayRuns } from "../lib/operations/pipeline-replay-compare";

const usage = "usage: measure-pipeline-replay report ARTIFACT | compare BASELINE CANDIDATE | verify IDENTITY RUN | export IDENTITY RUN OUTPUT | compare-db IDENTITY RUN IDENTITY RUN";
async function readArtifact(path: string): Promise<unknown> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("artifact_size_limit");
    const bytes = await file.readFile();
    if (bytes.byteLength > 64 * 1024 * 1024) throw new Error("artifact_size_limit");
    try { return JSON.parse(bytes.toString("utf8")) as unknown; }
    catch { throw new Error("invalid_artifact_json"); }
  } finally { await file.close(); }
}

async function withVerified<T>(identityPath: string, runId: string,
  load: (artifact: VerifiedReplayArtifact) => Promise<T>): Promise<T> {
  const database = await openVerifiedReplayHandlerDatabase(identityPath, {});
  try { return await load(await loadVerifiedReplayArtifact(database, runId)); }
  finally { await database.close(); }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  let result: unknown;
  if (command === "report" && args.length === 1) result = reportReplayArtifact(await readArtifact(args[0]));
  else if (command === "compare" && args.length === 2) {
    const [before, after] = await Promise.all(args.map(readArtifact));
    result = compareReplayArtifacts(before, after);
  } else if (command === "verify" && args.length === 2) {
    result = await withVerified(args[0], args[1], async artifact => reportVerifiedReplayArtifact(artifact));
  } else if (command === "export" && args.length === 3) {
    result = await withVerified(args[0], args[1], async artifact => {
      const value = replayArtifactFromVerified(artifact);
      await writeFile(args[2], `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return { exported: true, runId: value.run.runId, evidence: "sealed_replay_ledger", fileProvenance: "unverified_until_database_readback" };
    });
  } else if (command === "compare-db" && args.length === 4) {
    // Each identity is opened, checked and closed independently; files cannot
    // nominate a custom verifier or turn their own flags into authentication.
    result = await withVerified(args[0], args[1], async before =>
      withVerified(args[2], args[3], async after => compareVerifiedReplayRuns(before, after)));
  } else throw new Error(usage);
  console.log(JSON.stringify(result, null, 2));
}
void main().catch(error => { console.error(error instanceof Error && error.message === usage ? usage : formatCapacityCliError(error)); process.exitCode = 1; });
