import { z } from "zod";
import { assistHash } from "@/lib/domain/llm-assist/contracts";
import { localModelContractHash, localModelServingContractsSchema } from "@/lib/llm/local-model-serving-contract";
import { modelCapacityPolicyHash, modelCapacityPolicySchema } from "@/lib/llm/capacity";

const sha = z.string().regex(/^[a-f0-9]{64}$/), revision = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.string().min(1).max(200), positive = z.number().int().positive().safe();
const time = z.iso.datetime({ offset: true });
const checkKinds = ["unit", "integration", "build", "typecheck", "lint", "required_ci"] as const;
const comparisonCase = z.object({ caseId: id, inputHash: sha, sourceHash: sha, promptHash: sha,
  schemaVersion: id, policyVersion: id }).strict();

/** 증거를 수집·인증하지 않는다. 제공된 오프라인 readback/평가 산출물 간 일관성만 검사한다. */
export const assistRolloutManifestSchema = z.object({
  version: z.literal(1), integratedSha: revision, target: z.enum(["gpu", "gpu_m1"]).default("gpu"),
  asOf: time.nullable().default(null), maxEvidenceAgeMs: positive.nullable().default(null),
  codeChecks: z.array(z.object({ kind: z.enum(checkKinds), sha: revision,
    result: z.enum(["passed", "failed", "not_run"]), artifactHash: sha.nullable() }).strict()).max(6).default([]),
  contracts: localModelServingContractsSchema.default([]), verifiedContractHashes: z.record(id, sha).default({}),
  physicalLimits: z.record(id, positive).default({}), policy: modelCapacityPolicySchema.nullable().default(null),
  readbacks: z.array(z.object({ backendId: id, integratedSha: revision, contractHash: sha, artifactHash: sha,
    endpoint: z.url(), model: id, deploymentRevision: id, physicalGroup: id, contextWindowTokens: positive,
    configuredConcurrency: positive, observedAt: time }).strict()).max(32).default([]),
  inventory: z.object({ integratedSha: revision, artifactHash: sha, observedAt: time,
    expectedCallerIds: z.array(id).min(1).max(128),
    callers: z.array(z.object({ callerId: id, routeId: id, provider: id, model: id, backendId: id.nullable(),
      physicalGroup: id, transport: z.enum(["local-direct", "gateway", "cli"]),
      contractEvidenceHash: sha, nativeTerminalEvidenceHash: sha }).strict()).min(1).max(128),
    groups: z.array(z.object({ physicalGroup: id, configuredConcurrency: positive, artifactHash: sha, observedAt: time }).strict()).min(1).max(128),
    aliases: z.array(z.object({ callerId: id, endpoint: id, physicalGroup: id, artifactHash: sha }).strict()).min(1).max(128),
  }).strict().nullable().default(null),
  native: z.object({ integratedSha: revision, ledgerArtifactHash: sha, observedAt: time, unsettledRequestIds: z.array(z.uuid()).max(10_000),
    canaries: z.array(z.object({ requestId: z.uuid(), backendId: id, integratedSha: revision, contractHash: sha,
      responseModel: id, deploymentRevision: id, requestHash: sha, responseHash: sha, terminalArtifactHash: sha,
      ledgerState: z.enum(["settled", "dispatched", "indeterminate"]), finishReason: z.enum(["stop", "length", "tool_calls", "content_filter"]),
      actualTotalTokens: z.number().int().nonnegative().safe(), observedAt: time }).strict()).max(128),
  }).strict().nullable().default(null),
  routing: z.object({ gpuBackendId: id, m1BackendId: id.nullable(), primaryBackendIds: z.array(id).min(1).max(8),
    independentPairs: z.array(z.object({ originalBackendId: id, reviewerBackendId: id }).strict()).max(32),
    deepseek: z.object({ backendId: id, maxExceptionCallsPerWeek: positive, maxAuditCallsPerWeek: positive,
      auditFraction: z.number().min(0).max(1) }).strict().nullable(),
  }).strict().nullable().default(null),
  m1Ingress: z.object({ backendId: id, integratedSha: revision, relayRevision: revision, contractHash: sha,
    workerAccessArtifactHash: sha, mixedWorkArtifactHash: sha, canaryRequestId: z.uuid(), observedAt: time }).strict().nullable().default(null),
  comparison: z.object({ datasetId: id, datasetHash: sha, split: z.literal("holdout"), evidenceKind: z.enum(["synthetic", "snapshot"]),
    cases: z.array(comparisonCase).min(1).max(10_000),
    labels: z.object({ kind: z.enum(["synthetic", "human_independent"]), artifactHash: sha, caseIds: z.array(id).min(1).max(10_000) }).strict(),
    runs: z.array(z.object({ backendId: id, contractHash: sha, responseArtifactHash: sha,
      cases: z.array(comparisonCase.extend({ wireHash: sha, responseHash: sha, elapsedMs: z.number().finite().nonnegative() }).strict()).min(1).max(10_000),
    }).strict()).min(1).max(32),
    measuredArtifactHash: sha, acceptedCriteriaArtifactHash: sha,
  }).strict().nullable().default(null),
  policyApproval: z.object({ integratedSha: revision, policyHash: sha, datasetHash: sha, artifactHash: sha,
    actor: id, approvedAt: time, scope: z.enum(["shadow", "confirm"]) }).strict().nullable().default(null),
}).strict();
export type AssistRolloutManifest = z.infer<typeof assistRolloutManifestSchema>;

const sameSet = (a: readonly string[], b: readonly string[]) => new Set(a).size === a.length
  && new Set(b).size === b.length && a.length === b.length && a.every(value => b.includes(value));

export function verifyAssistRolloutManifest(value: unknown) {
  const parsed = assistRolloutManifestSchema.safeParse(value);
  const blockers = { code: [] as string[], global: [] as string[], gpu: [] as string[], m1: [] as string[], deepseek: [] as string[], evaluation: [] as string[], approval: [] as string[] };
  const report = (schemaValid: boolean, manifestHash: string | null, codeComplete: boolean, globalCapacityEvidenceComplete: boolean,
    gpuShadowEligible: boolean, gpuM1ShadowEligible: boolean, gpuConfirmEligible: boolean, gpuM1ConfirmEligible: boolean, target = "gpu") => ({
    version: 1, mode: "plan", source: "offline_manifest_consistency", schemaValid, manifestHash, codeComplete, globalCapacityEvidenceComplete,
    gpuShadowEligible, gpuM1ShadowEligible, gpuConfirmEligible, gpuM1ConfirmEligible,
    productionEligibleForReview: target === "gpu_m1" ? gpuM1ConfirmEligible : gpuConfirmEligible,
    productionReady: false, automaticApplyAuthorized: false, mutations: false,
    deepseek: parsed.success && parsed.data.routing?.deepseek ? "explicit_bounded_configuration" : "off",
    deepseekEligibleForReview: Boolean(parsed.success && parsed.data.routing?.deepseek && codeComplete
      && globalCapacityEvidenceComplete && blockers.deepseek.length === 0),
    blockers: Object.fromEntries(Object.entries(blockers).map(([key, rows]) => [key, [...new Set(rows)]])),
    limitations: ["제공된 산출물의 진위·현재 운영 상태는 확인하지 않았습니다.", "이 보고서는 배포·전역 open·자동 적용의 승인이나 실행 권한이 아닙니다."],
  });
  if (!parsed.success) {
    blockers.global.push(...parsed.error.issues.map(issue => `invalid_manifest:${issue.path.join(".") || "root"}`));
    return report(false, null, false, false, false, false, false, false);
  }
  const m = parsed.data, contracts = new Map(m.contracts.map(contract => [contract.backendId, contract]));
  const fresh = (observedAt: string) => m.asOf !== null && m.maxEvidenceAgeMs !== null && Date.parse(observedAt) <= Date.parse(m.asOf)
    && Date.parse(m.asOf) - Date.parse(observedAt) <= m.maxEvidenceAgeMs;
  for (const kind of checkKinds) {
    const found = m.codeChecks.filter(check => check.kind === kind);
    if (found.length !== 1 || found[0].sha !== m.integratedSha || found[0].result !== "passed" || !found[0].artifactHash) blockers.code.push(`exact_sha_check_missing:${kind}`);
  }
  if (!m.asOf || !m.maxEvidenceAgeMs) blockers.global.push("evidence_freshness_policy_missing");
  if (!m.policy) blockers.global.push("capacity_policy_missing");
  if (!m.contracts.length) blockers.global.push("serving_contracts_missing");
  const backendEvidence = (backendId: string, bucket = blockers.global) => {
    const contract = contracts.get(backendId);
    if (!contract) { bucket.push(`contract_missing:${backendId}`); return; }
    const hash = localModelContractHash(contract), reads = m.readbacks.filter(row => row.backendId === backendId);
    const read = reads[0], physical = m.physicalLimits[contract.physicalGroup];
    if (m.verifiedContractHashes[backendId] !== hash) bucket.push(`verified_contract_hash_missing:${backendId}`);
    if (reads.length !== 1 || read.integratedSha !== m.integratedSha || read.contractHash !== hash || read.endpoint !== contract.endpoint
      || read.model !== contract.responseModel || read.deploymentRevision !== contract.deploymentRevision || read.physicalGroup !== contract.physicalGroup
      || read.contextWindowTokens !== contract.contextWindowTokens || !fresh(read.observedAt)) bucket.push(`readback_mismatch:${backendId}`);
    if (!physical || !read || physical > read.configuredConcurrency || !m.policy?.groupLimits[contract.physicalGroup]
      || m.policy.groupLimits[contract.physicalGroup] > physical || !m.policy.providerLimits[backendId]) bucket.push(`physical_limit_unverified:${backendId}`);
    const canary = m.native?.canaries.find(row => row.backendId === backendId && row.integratedSha === m.integratedSha && row.contractHash === hash
      && row.responseModel === contract.responseModel && row.deploymentRevision === contract.deploymentRevision && row.ledgerState === "settled"
      && row.finishReason === "stop" && row.actualTotalTokens <= contract.totalTokenBound && fresh(row.observedAt));
    if (!canary) bucket.push(`native_canary_missing:${backendId}`);
  };
  const routing = m.routing;
  const requiredBackends = new Set([routing?.gpuBackendId, ...(routing?.primaryBackendIds ?? []),
    ...(m.inventory?.callers.filter(caller => caller.transport === "local-direct").map(caller => caller.backendId) ?? []),
    ...(m.target === "gpu_m1" ? [routing?.m1BackendId] : []),
  ].filter((backend): backend is string => Boolean(backend)));
  for (const backend of requiredBackends) backendEvidence(backend);
  const inventory = m.inventory;
  if (!inventory || inventory.integratedSha !== m.integratedSha || !fresh(inventory.observedAt)) blockers.global.push("active_caller_inventory_missing");
  for (const backendId of routing?.primaryBackendIds ?? []) {
    if (!inventory?.callers.some(caller => caller.transport === "local-direct" && caller.backendId === backendId)) {
      blockers.global.push(`primary_caller_missing:${backendId}`);
    }
  }
  if (inventory) {
    if (!sameSet(inventory.expectedCallerIds, inventory.callers.map(caller => caller.callerId))) blockers.global.push("active_caller_inventory_incomplete");
    if (!sameSet(inventory.callers.map(row => row.callerId), inventory.aliases.map(row => row.callerId))) blockers.global.push("physical_alias_inventory_incomplete");
    for (const caller of inventory.callers) {
      const alias = inventory.aliases.find(row => row.callerId === caller.callerId);
      const route = m.policy?.routes.find(row => row.routeId === caller.routeId && row.provider === caller.provider && row.model === caller.model);
      if (!route || route.groupId !== caller.physicalGroup || alias?.physicalGroup !== caller.physicalGroup) blockers.global.push(`caller_route_unmapped:${caller.callerId}`);
      const groups = inventory.groups.filter(row => row.physicalGroup === caller.physicalGroup), group = groups[0];
      const limit = m.physicalLimits[caller.physicalGroup];
      if (groups.length !== 1 || !group || !fresh(group.observedAt) || !limit || limit > group.configuredConcurrency
        || !m.policy?.groupLimits[caller.physicalGroup] || m.policy.groupLimits[caller.physicalGroup] > limit) blockers.global.push(`caller_physical_limit_unverified:${caller.callerId}`);
      if (caller.transport === "local-direct") {
        const contract = caller.backendId ? contracts.get(caller.backendId) : null;
        if (!contract || caller.provider !== "local-direct" || caller.model !== contract.model || caller.physicalGroup !== contract.physicalGroup
          || route?.providerBudgetId !== contract.backendId || alias?.endpoint !== contract.endpoint) blockers.global.push(`local_caller_contract_mismatch:${caller.callerId}`);
      } else if (caller.transport === "gateway" && (!alias || !/^https?:\/\//.test(alias.endpoint))) blockers.global.push(`gateway_physical_alias_unverified:${caller.callerId}`);
    }
  }
  if (!m.native || m.native.integratedSha !== m.integratedSha || !fresh(m.native.observedAt)) blockers.global.push("native_ledger_readback_missing");
  if (m.native?.unsettledRequestIds.length) blockers.global.push("native_remote_end_unknown");
  if (m.native && new Set(m.native.canaries.map(row => row.requestId)).size !== m.native.canaries.length) blockers.global.push("duplicate_native_canary");
  if (!routing || !routing.primaryBackendIds.includes(routing.gpuBackendId)) blockers.gpu.push("gpu_routing_missing");
  if (routing && new Set(routing.primaryBackendIds).size !== routing.primaryBackendIds.length) blockers.gpu.push("duplicate_primary_backend");
  if (m.target === "gpu" && routing?.m1BackendId && routing.primaryBackendIds.includes(routing.m1BackendId)) {
    blockers.gpu.push("m1_primary_requires_gpu_m1_target");
  }
  for (const backendId of routing?.primaryBackendIds ?? []) if (contracts.get(backendId)?.modelFamily !== "qwen3.8-flash-next") blockers.gpu.push(`primary_qwen_required:${backendId}`);
  for (const pair of routing?.independentPairs ?? []) {
    const original = contracts.get(pair.originalBackendId), reviewer = contracts.get(pair.reviewerBackendId);
    if (!original || !reviewer || original.modelFamily === reviewer.modelFamily) blockers.global.push("independent_model_family_required");
  }
  if (routing?.deepseek) {
    const backend = contracts.get(routing.deepseek.backendId);
    backendEvidence(routing.deepseek.backendId, blockers.deepseek);
    if (backend?.modelFamily !== "deepseek-v4.1-flash-1017") blockers.deepseek.push("deepseek_backend_mismatch");
    if (!backend || !m.policy?.routes.some(route => route.provider === "local-direct" && route.model === backend.model
      && route.providerBudgetId === backend.backendId && route.groupId === backend.physicalGroup)) blockers.deepseek.push("deepseek_route_unmapped");
  }
  const gpu = routing ? contracts.get(routing.gpuBackendId) : null;
  const m1 = routing?.m1BackendId ? contracts.get(routing.m1BackendId) : null, ingress = m.m1Ingress;
  if (!m1 || m1.modelFamily !== "qwen3.8-flash-next" || !ingress || ingress.backendId !== m1.backendId
    || !gpu || gpu.backendId === m1.backendId || gpu.physicalGroup === m1.physicalGroup || gpu.endpoint === m1.endpoint
    || ingress.integratedSha !== m.integratedSha || ingress.relayRevision !== m.integratedSha || ingress.contractHash !== localModelContractHash(m1)
    || !fresh(ingress.observedAt) || m.physicalLimits[m1.physicalGroup] !== 1
    || !m.native?.canaries.some(row => row.requestId === ingress.canaryRequestId && row.backendId === m1.backendId && row.ledgerState === "settled"
      && row.contractHash === localModelContractHash(m1) && row.responseModel === m1.responseModel && fresh(row.observedAt))) blockers.m1.push("m1_private_worker_path_unverified");
  const comparison = m.comparison;
  if (!comparison || comparison.evidenceKind !== "snapshot" || comparison.labels.kind !== "human_independent") blockers.evaluation.push("independent_real_holdout_missing");
  if (comparison) {
    const caseIds = comparison.cases.map(row => row.caseId);
    if (!sameSet(caseIds, comparison.labels.caseIds)) blockers.evaluation.push("independent_labels_incomplete");
    const expectedBackends = [routing?.gpuBackendId, ...(routing?.primaryBackendIds ?? []),
      ...(m.target === "gpu_m1" ? [routing?.m1BackendId] : [])].filter((row): row is string => Boolean(row));
    if (!expectedBackends.every(backendId => comparison.runs.some(run => run.backendId === backendId))
      || new Set(comparison.runs.map(run => run.backendId)).size !== comparison.runs.length) blockers.evaluation.push("backend_comparison_incomplete");
    for (const run of comparison.runs) {
      const contract = contracts.get(run.backendId);
      if (!contract || run.contractHash !== localModelContractHash(contract) || !sameSet(caseIds, run.cases.map(row => row.caseId))) blockers.evaluation.push(`comparison_run_mismatch:${run.backendId}`);
      for (const row of run.cases) {
        const expected = comparison.cases.find(item => item.caseId === row.caseId);
        if (!expected || Object.entries(expected).some(([key, field]) => row[key as keyof typeof row] !== field)) blockers.evaluation.push(`comparison_input_changed:${run.backendId}:${row.caseId}`);
      }
    }
  }
  const approval = m.policyApproval;
  if (!approval || approval.scope !== "confirm" || approval.integratedSha !== m.integratedSha || !m.policy || !comparison
    || approval.policyHash !== modelCapacityPolicyHash(m.policy) || approval.datasetHash !== comparison.datasetHash
    || !fresh(approval.approvedAt)) blockers.approval.push("exact_policy_evaluation_approval_missing");
  const codeComplete = blockers.code.length === 0, globalComplete = blockers.global.length === 0;
  const gpuShadow = codeComplete && globalComplete && blockers.gpu.length === 0;
  const m1Shadow = gpuShadow && blockers.m1.length === 0;
  const confirmation = blockers.evaluation.length === 0 && blockers.approval.length === 0;
  return report(true, assistHash(m), codeComplete, globalComplete, gpuShadow, m1Shadow,
    gpuShadow && confirmation, m1Shadow && confirmation, m.target);
}
