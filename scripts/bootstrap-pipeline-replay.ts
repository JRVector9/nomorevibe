import { bootstrapReplayDatabase, formatReplayDatabaseError } from "../lib/operations/pipeline-replay-database";

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args[0] !== "--identity" || !args[1]
    || args.slice(2).some(arg => arg !== "--acknowledge-dedicated-cluster") || args.length > 3) {
    console.error("usage: bootstrap-pipeline-replay --identity PATH --acknowledge-dedicated-cluster"); process.exitCode = 1; return;
  }
  if (args[2] !== "--acknowledge-dedicated-cluster") {
    console.error("dedicated_replay_cluster_required"); process.exitCode = 1; return;
  }
  const url = process.env.TEST_DATABASE_URL;
  if (!url) { console.error("explicit_TEST_DATABASE_URL_required"); process.exitCode = 1; return; }
  const identity = await bootstrapReplayDatabase({ databaseUrl: url, identityPath: args[1], acknowledgeDedicatedCluster: true });
  console.log(JSON.stringify({ provisioned: true, identity }));
}
void main().catch(error => { console.error(formatReplayDatabaseError(error)); process.exitCode = 1; });
