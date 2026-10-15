import { open, writeFile } from "node:fs/promises";
import { parseCapacityArtifact, validateReplayPlan } from "../lib/operations/pipeline-capacity";
import { formatCapacityCliError } from "../lib/operations/pipeline-capacity-cli";
async function main() {
  const [templatePath, outputPath, ...extra] = process.argv.slice(2);
  if (!templatePath || !outputPath || extra.length) throw new Error("usage: export-pipeline-capacity TEMPLATE OUTPUT");
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("explicit_TEST_DATABASE_URL_required");
  const file = await open(templatePath, "r");
  let raw: unknown;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("artifact_size_limit");
    const bytes = await file.readFile();
    if (bytes.length > 64 * 1024 * 1024) throw new Error("artifact_size_limit");
    try { raw = JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error("invalid_artifact_json"); }
  } finally { await file.close(); }
  const template = parseCapacityArtifact(raw);
  validateReplayPlan(template.manifest, url);
  if (process.env.READ_DATABASE_URL) throw new Error("replica_database_rejected");
  process.env.DATABASE_URL = url;
  const { snapshotPipelineGenerations } = await import("../lib/operations/pipeline-capacity-repository");
  try {
    const snapshot = await snapshotPipelineGenerations([...new Set(template.manifest.inputs.map(row => row.candidateId))],
      template.manifest.fullReviewPolicyHash, template.manifest);
    const key = (row: { candidateId: number; inputHash: string; sourceRevisionHash: string }) =>
      JSON.stringify([row.candidateId, row.inputHash, row.sourceRevisionHash]);
    const frozenInputs = new Set(template.manifest.inputs.map(key));
    const generations = snapshot.generations.filter(row => frozenInputs.has(key(row)));
    const artifact = parseCapacityArtifact({ ...template, generations,
      source: { kind: "local-postgres", scope: "as_of_snapshot_only", runId: template.manifest.runId, exportedAt: snapshot.capturedAt,
        fullReviewPolicyHash: snapshot.fullReviewPolicyHash } });
    await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ exported: true, generations: artifact.generations.length, excludedHistoricalGenerations: snapshot.generations.length - generations.length, evidence: "as_of_snapshot_only" }));
  } finally {
    const client = (globalThis as typeof globalThis & { pgClient?: { end(options: { timeout: number }): Promise<void> } }).pgClient;
    await client?.end({ timeout: 5 });
  }
}
void main().catch(error => { console.error(formatCapacityCliError(error)); process.exitCode = 1; });
