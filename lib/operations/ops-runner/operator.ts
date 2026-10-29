/** Privileged process only. This module must never be imported by web actions or maintenance workers. */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync, readFileSync, openSync, closeSync, fsyncSync, writeFileSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, parse } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { providerBoundaryPlanSchema, providerBoundaryReceiptSchema, providerBoundaryPlanHash, validateProviderBoundary,
  boundaryExitObservationSchema } from "@/lib/llm/provider-boundary-contract";
import { releaseProviderBoundaryRequest } from "../dr/provider-boundary-release";
import { readBoundaryReleaseFiles } from "@/scripts/ops/model-provider-boundary-release";
import { capacityPin, controlOpsAdmission, assertOpsQuiescent, readOpsRequest, type CapacityPin } from "./control";
import { saveModelOpsState } from "./repository";
import { type OpsState, type OpsStep, opsActionSchema } from "./contract";
import { runModelOpsRunner, type StepResult } from "./runner";

const sha = (raw: Buffer | string) => createHash("sha256").update(raw).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const operatorProfileSchema = z.object({ version: z.literal(1), jobId: z.uuid(), action: opsActionSchema, targetId: z.string(),
  requiresSudo: z.boolean(),
  // A private, reviewed Python adapter. No executable, host, shell text or evidence comes from the web queue.
  adapter: z.object({ path: z.string(), sha256: hash }).strict().optional(),
  artifactDirectory: z.string().optional(),
  affectedGroups: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/)).min(1).max(16).optional(),
  material: z.object({ path: z.string(), sha256: hash }).strict().optional(),
}).strict();
export type OperatorProfile = z.infer<typeof operatorProfileSchema>;
/** Reject symlinks and any path writable by another account. No chmod, sudo or permission repair. */
export function trustedOpsPath(path: string, directory = false) {
  if (!isAbsolute(path) || path.split("/").includes("..")) throw new Error("ops_runner_untrusted_path");
  let current = path;
  for (;;) {
    const info = lstatSync(current);
    if (info.isSymbolicLink() || ![0, process.getuid?.()].includes(info.uid) || (info.mode & 0o022)
      || (current === path && (directory ? !info.isDirectory() : !info.isFile()))) throw new Error("ops_runner_untrusted_path");
    if (current === parse(current).root) break;
    current = dirname(current);
  }
  return path;
}
function boundedJson(path: string) {
  trustedOpsPath(path);
  const raw = readFileSync(path); if (raw.length > 5 * 1024 * 1024) throw new Error("ops_runner_file_cap");
  return { raw, value: JSON.parse(raw.toString("utf8")) };
}
export function readOperatorProfile(path: string, state: OpsState) {
  const { raw, value } = boundedJson(path), profile = operatorProfileSchema.parse(value);
  if (profile.jobId !== state.id || profile.action !== state.action || profile.targetId !== state.targetId) throw new Error("ops_runner_profile_target_mismatch");
  if (profile.adapter && !profile.requiresSudo) {
    const source = boundedSource(profile.adapter.path);
    if (sha(source) !== profile.adapter.sha256) throw new Error("ops_runner_adapter_not_reviewed_or_requires_sudo");
  }
  if (profile.material && !profile.requiresSudo && sha(boundedJson(profile.material.path).raw) !== profile.material.sha256)
    throw new Error("ops_runner_material_changed");
  return { profile, hash: sha(raw) };
}
function boundedSource(path: string) {
  trustedOpsPath(path); const raw = readFileSync(path);
  if (raw.length > 1024 * 1024) throw new Error("ops_runner_source_cap");
  return raw;
}
const adapterResultSchema = z.object({ ok: z.boolean(), manual: z.boolean().optional(), code: z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/).optional(),
  configurationHash: hash.optional(), plan: z.unknown().optional(), receipt: z.unknown().optional(),
  exits: z.array(boundaryExitObservationSchema).max(16).optional(),
  releaseFiles: z.object({ plan: z.string(), planSha: hash, receipt: z.string() }).strict().optional(),
}).strict();
type AdapterResult = z.infer<typeof adapterResultSchema>;
export async function callOpsAdapter(profile: OperatorProfile, phase: string, state: OpsState, context: unknown): Promise<AdapterResult> {
  if (!profile.adapter || sha(boundedSource(profile.adapter.path)) !== profile.adapter.sha256) throw new Error("ops_runner_adapter_changed");
  return new Promise((resolve, reject) => {
    // No shell; small output; hard deadline; stdout/stderr never forwarded to logs/UI.
    const child = execFile("/usr/bin/python3", ["-I", profile.adapter!.path, phase],
      { timeout: 300_000, maxBuffer: 5 * 1024 * 1024, env: { NODE_ENV: process.env.NODE_ENV, PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" } }, (_error, stdout, stderr) => {
        try {
          const result = adapterResultSchema.parse(JSON.parse(stdout));
          if (stderr || (_error && (result.ok || _error.killed || _error.signal))) throw new Error("adapter_exit_unconfirmed");
          resolve(result);
        } catch { reject(new Error("ops_runner_adapter_outcome_unknown")); }
      });
    child.stdin?.end(JSON.stringify({ id: state.id, action: state.action, targetId: state.targetId, context, material: profile.material }));
  });
}
type Prepared = { request?: unknown; profileHash: string; original: CapacityPin; drained?: CapacityPin; configurationHash?: string; plan?: unknown; receipt?: unknown; releaseFiles?: AdapterResult["releaseFiles"] };
export async function runPreparedModelOps(state: OpsState, profilePath: string, stateDirectory: string, prepareOnly: boolean) {
  trustedOpsPath(stateDirectory, true);
  if ((lstatSync(stateDirectory).mode & 0o077) !== 0) throw new Error("ops_runner_private_directory_required");
  const reviewed = readOperatorProfile(profilePath, state), file = join(stateDirectory, `${state.id}.json`);
  let prepared: Prepared | undefined;
  try { prepared = boundedJson(file).value as Prepared; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (prepared && prepared.profileHash !== reviewed.hash) throw new Error("ops_runner_profile_changed");
  const persist = () => {
    const temporary = `${file}.${randomUUID()}.new`;
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(prepared)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    const directory = openSync(stateDirectory, "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
  };
  const adapter = (phase: string) => callOpsAdapter(reviewed.profile, phase, state, prepared);
  const manual = reviewed.profile.requiresSudo || /(?:^|[^a-z0-9])m1(?:[^a-z0-9]|$)|29877f65/i.test(state.targetId);
  const execute = async (step: OpsStep, reconcile = false): Promise<StepResult> => {
    if (manual) return { ok: false, manual: true, code: "human_on_device_sudo_stop_restore_required" };
    if (step === "prepare") {
      if (!prepared) { prepared = { profileHash: reviewed.hash, original: await capacityPin(),
        ...(state.action === "request-release" ? { request: await readOpsRequest(state.targetId) } : {}) }; persist(); }
      const expected = state.action === "admission-open" ? "draining" : "open";
      if (prepared.original.mode !== expected) return { ok: false, code: "original_admission_mode_not_expected" };
      if (!state.action.startsWith("admission-")) {
        const result = await adapter("prepare");
        if (result.manual) return { ok: false, manual: true, code: "human_on_device_sudo_stop_restore_required" };
        if (!result.ok || !result.configurationHash) return { ok: false, code: "prepare_identity_or_configuration_unproven" };
        const request = prepared.request as { groupId?: string } | undefined;
        if (request?.groupId && reviewed.profile.affectedGroups && !reviewed.profile.affectedGroups.includes(request.groupId))
          return { ok: false, code: "request_group_outside_reviewed_scope" };
        prepared.configurationHash = result.configurationHash; persist();
      }
      return { ok: true };
    }
    if (!prepared) throw new Error("ops_runner_not_prepared");
    if (step === "drain" || step === "open") {
      const result = await controlOpsAdmission(state, step === "drain" ? "draining" : "open",
        step === "drain" || state.action === "admission-open" ? prepared.original : prepared.drained!, reconcile);
      if (result.ok && step === "drain") { prepared.drained = await capacityPin(); persist(); }
      return result;
    }
    await assertOpsQuiescent(prepared.drained!, state.targetId, reviewed.profile.affectedGroups);
    if (step === "stop") {
      if (!prepared.plan && state.action === "request-release") {
        const proposed = await adapter("plan");
        const plan = providerBoundaryPlanSchema.parse(proposed.plan);
        if (!proposed.ok || plan.version !== 1 || !isDeepStrictEqual(plan.request, prepared.request)
          || !isDeepStrictEqual(plan.control, prepared.drained)) return { ok: false, code: "prepared_plan_rejected" };
        prepared.plan = plan; persist();
      }
      if (reconcile) return adapter("resume-stop");
      const result = await adapter("stop");
      // bootout can acknowledge before launchd disappearance is observable. Recheck read-only, never bootout twice.
      if (!result.ok && result.code === "exit_fact_missing_launchdUnloaded") return adapter("verify-stop");
      return result;
    }
    if (step === "verify-stop") {
      const result = await adapter("verify-stop");
      if (!result.ok) return { ok: false, code: "termination_evidence_missing" };
      if (state.action === "request-release") {
        const plan = providerBoundaryPlanSchema.parse(result.plan), receipt = providerBoundaryReceiptSchema.parse(result.receipt);
        if (plan.version !== 1 || !isDeepStrictEqual(plan, prepared.plan) || plan.request.requestId !== state.targetId || !isDeepStrictEqual(plan.control, prepared.drained)
          || !validateProviderBoundary(plan, receipt, new Date().toISOString()) || !result.releaseFiles) return { ok: false, code: "termination_evidence_rejected" };
        prepared.plan = plan; prepared.receipt = receipt; prepared.releaseFiles = result.releaseFiles; persist();
      } else if (!result.exits?.length) return { ok: false, code: "termination_evidence_missing" };
      return { ok: true };
    }
    if (step === "release") {
      if (!prepared.releaseFiles || !reviewed.profile.artifactDirectory) return { ok: false, code: "release_artifacts_missing" };
      const release = async () => {
        const files = prepared!.releaseFiles!;
        trustedOpsPath(files.plan); trustedOpsPath(files.receipt); trustedOpsPath(reviewed.profile.artifactDirectory!, true);
        const checked = readBoundaryReleaseFiles([`--plan=${files.plan}`, `--plan-sha=${files.planSha}`, `--receipt=${files.receipt}`,
          `--artifact-dir=${reviewed.profile.artifactDirectory}`, `--operator=${state.actor}`, `--reference=ops-runner:${state.id} ${state.reason}`, "--database-url-stdin"]);
        if (!isDeepStrictEqual(checked.plan, prepared!.plan) || !isDeepStrictEqual(checked.receipt, prepared!.receipt)) throw new Error("ops_runner_artifacts_changed");
        return releaseProviderBoundaryRequest({ ...checked, expectedPlanHash: providerBoundaryPlanHash(checked.plan) }, true);
      };
      try {
        const result = await release(); // Exact receipt retry first: finishes a lost commit acknowledgement without a second release.
        return { ok: result.kind === "released" || result.kind === "already_released" };
      } catch {
        // Only a primary read proving the SAME request is still indeterminate permits fresh READ-ONLY observations.
        if (!isDeepStrictEqual(await readOpsRequest(state.targetId), prepared.request)) return { ok: false, code: "request_changed_before_evidence_refresh" };
        const fresh = await adapter("refresh-evidence");
        const plan = providerBoundaryPlanSchema.parse(fresh.plan), receipt = providerBoundaryReceiptSchema.parse(fresh.receipt);
        const previous = providerBoundaryPlanSchema.parse(prepared.plan);
        if (!fresh.ok || !fresh.releaseFiles || !isDeepStrictEqual(plan, { ...previous, createdAt: plan.createdAt })
          || !validateProviderBoundary(plan, receipt, new Date().toISOString())) return { ok: false, code: "fresh_termination_evidence_rejected" };
        prepared.plan = plan; prepared.receipt = receipt; prepared.releaseFiles = fresh.releaseFiles; persist();
        const result = await release();
        return { ok: result.kind === "released" || result.kind === "already_released" };
      }
    }
    if (step === "restore") return adapter(reconcile ? "resume-restore" : "restore");
    const result = await adapter("verify-restored");
    return { ok: result.ok && result.configurationHash === prepared.configurationHash, code: "original_configuration_not_restored" };
  };
  const next = { ...state, profileHash: reviewed.hash };
  if (prepareOnly) {
    if (Object.keys(state.steps).some(step => step !== "prepare")) throw new Error("ops_runner_already_started");
    await saveModelOpsState({ ...next, status: "running", step: "prepare", code: null, steps: { ...state.steps, prepare: "running" } });
    let result: StepResult;
    try { result = await execute("prepare"); } catch { result = { ok: false, code: "prepare_failed_private_journal_required" }; }
    const preparedState: OpsState = { ...next, status: result.ok ? "queued" : result.manual ? "manual" : "blocked", step: "prepare",
      code: result.code ?? null, steps: { ...state.steps, prepare: result.ok ? "done" : result.manual ? "manual" : "blocked" } };
    await saveModelOpsState(preparedState); return preparedState;
  }
  if (!prepared || state.steps.prepare !== "done") throw new Error("ops_runner_prepare_required");
  return runModelOpsRunner({ state: next, driver: { save: saveModelOpsState, execute: step => execute(step), reconcile: step => execute(step, true) } });
}
