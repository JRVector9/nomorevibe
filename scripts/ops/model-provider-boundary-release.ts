/** Privileged, manual, exact one-request release. No stop/restart, model call or terminal fabrication. */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDatabaseUrl } from "./dr/promotion";
import { providerBoundaryPlanSchema, providerBoundaryPlanHash, providerBoundaryReceiptSchema } from "@/lib/llm/provider-boundary-contract";
import { checkRelayBoundaryPending, reconcileRelayBoundary } from '../local-model-relay/boundary-reconcile';
import type { RelayBoundaryProof } from '../local-model-relay/boundary-reconcile';

const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function boundedFile(path: string) { if (statSync(path).size > 5 * 1024 * 1024) throw new Error("provider_boundary_file_too_large"); return readFileSync(path); }
export function readBoundaryReleaseFiles(args: readonly string[]) {
  const allowed = new Set(["plan", "plan-sha", "receipt", "artifact-dir", "operator", "reference"]), opts = new Map<string, string>();
  let apply = false, stdin = false;
  for (const arg of args) {
    if (arg === "--apply" && !apply) { apply = true; continue; }
    if (arg === "--database-url-stdin" && !stdin) { stdin = true; continue; }
    const m = /^--([a-z-]+)=([^\n]+)$/.exec(arg);
    if (!m || (!allowed.has(m[1]) && m[1] !== 'relay-state-dir') || opts.has(m[1])) throw new Error("provider_boundary_cli_option");
    opts.set(m[1], m[2]);
  }
  if (!stdin || [...allowed].some(k => !opts.has(k))) throw new Error("provider_boundary_cli_required");
  const bytes = boundedFile(opts.get("plan")!);
  if (sha(bytes) !== opts.get("plan-sha")) throw new Error("provider_boundary_plan_file_hash");
  const plan = providerBoundaryPlanSchema.parse(JSON.parse(bytes.toString("utf8")));
  const receipt = providerBoundaryReceiptSchema.parse(JSON.parse(boundedFile(opts.get("receipt")!).toString("utf8")));
  const hashes = [plan.beforeArtifactHash, (receipt.version === 2 || receipt.version === 4) ? receipt.currentIngressOwner.artifactHash : receipt.owner.artifactHash, ...receipt.gateways.map(g => g.artifactHash), receipt.provider.artifactHash];
  if (plan.version === 2 || plan.version === 4) hashes.push(plan.originalOwner.artifactHash);
  if ((plan.version === 3 && receipt.version === 3) || (plan.version === 4 && receipt.version === 4)) hashes.push(plan.provider.endpointProofHash,plan.provider.oldJournal.artifactHash,
    plan.provider.currentJournal.artifactHash,plan.bootWitness.artifactHash,receipt.provider.bootWitness.artifactHash,plan.transport.sourceArtifactHash);
  if (plan.provider.kind === "launchd") hashes.push(plan.provider.topologyProofSha256);
  for (const hash of hashes) if (sha(boundedFile(resolve(opts.get("artifact-dir")!, `${hash}.json`))) !== hash)
    throw new Error("provider_boundary_artifact_hash");
  return { apply, plan, receipt, expectedPlanHash: providerBoundaryPlanHash(plan), operator: opts.get("operator")!, reference: opts.get("reference")!,
    ...(opts.has('relay-state-dir') ? { relayStateDirectory: resolve(opts.get('relay-state-dir')!) } : {}) };
}
export async function runBoundaryRelease(input: ReturnType<typeof readBoundaryReleaseFiles>, deps: {
  release: (input: ReturnType<typeof readBoundaryReleaseFiles>, apply: boolean) => Promise<unknown>;
  readProof: (input: ReturnType<typeof readBoundaryReleaseFiles>) => Promise<RelayBoundaryProof>;
}) {
  if (input.relayStateDirectory) checkRelayBoundaryPending(input.relayStateDirectory, input.plan.request.requestId);
  const result = await deps.release(input, input.apply);
  // Commit is separate from local disk repair. An exact retry can finish repair after an interrupted/failed post-commit step.
  let relay: { kind: string; requestId?: string; reason?: string } | undefined = input.relayStateDirectory ? { kind: 'dry_run_unchanged' } : undefined;
  if (input.apply && input.relayStateDirectory) {
    try { relay = reconcileRelayBoundary(input.relayStateDirectory, await deps.readProof(input)); }
    catch (error) {
      const code = error instanceof Error && /^relay_recovery_[a-z_]+$/.test(error.message) ? error.message : 'relay_recovery_postcommit_failed';
      relay = { kind: 'blocked', reason: code };
    }
  }
  return { dryRun: !input.apply, result, relay };
}
export async function providerBoundaryReleaseMain(args: readonly string[]) {
  // Hashes bind the reviewed bytes. The operator must independently verify these are actual stop observations, not invented JSON.
  const input = readBoundaryReleaseFiles(args), chunks: Buffer[] = [];
  for await (const chunk of process.stdin) { chunks.push(Buffer.from(chunk)); if (Buffer.concat(chunks).length > 4096) throw new Error("dr_cli_invalid_database_url"); }
  if ((globalThis as { db?: unknown; pgClient?: unknown }).db || (globalThis as { pgClient?: unknown }).pgClient) throw new Error("dr_cli_database_already_open");
  process.env.DATABASE_URL = parseDatabaseUrl(Buffer.concat(chunks).toString("utf8")); delete process.env.READ_DATABASE_URL;
  try {
    const { releaseProviderBoundaryRequest } = await import("@/lib/operations/dr/provider-boundary-release");
    const outcome = await runBoundaryRelease(input, { release: releaseProviderBoundaryRequest,
      readProof: async value => (await import('@/lib/operations/dr/provider-boundary-relay')).readCommittedRelayBoundaryProof(value) });
    if (outcome.relay?.kind === 'blocked') process.exitCode = 1;
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
  } finally { await (globalThis as { pgClient?: { end: (o: { timeout: number }) => Promise<void> } }).pgClient?.end({ timeout: 5 }).catch(() => {}); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void providerBoundaryReleaseMain(process.argv.slice(2))
  .catch(() => { process.stderr.write('{"code":"provider_boundary_release_failed"}\n'); process.exitCode = 1; });
