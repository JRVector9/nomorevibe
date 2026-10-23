import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { assistRolloutManifestSchema, verifyAssistRolloutManifest, type AssistRolloutManifest } from "@/lib/operations/llm-assist-readiness";
import { localModelContractHash, type LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import { modelCapacityPolicyHash } from "@/lib/llm/capacity";

const sha = "a".repeat(40), hash = "b".repeat(64), now = "2026-10-23T10:00:00Z";
const contract: LocalModelServingContract = { version: 1, protocol: "local-openai-chat-v1", backendId: "gpu-qwen", provider: "local-direct",
  physicalGroup: "gpu3090", endpoint: "http://100.64.0.1:8090/v1/chat/completions", model: "qwen3.8-flash-next", responseModel: "qwen3.8-flash-next",
  modelFamily: "qwen3.8-flash-next", deploymentRevision: "fixture-q4", contextWindowTokens: 32000, totalTokenBound: 32000,
  maxOutputTokens: 1024, maxInputBytes: 100000, capabilities: { vision: true, jsonSchema: true },
  thinking: { mode: "disabled", parameter: "chat_template_kwargs.enable_thinking" }, termination: { kind: "response_only" } };
const caseRow = { caseId: "closed-1", inputHash: hash, sourceHash: hash, promptHash: hash, schemaVersion: "test", policyVersion: "test" };

function fixture(): AssistRolloutManifest {
  const cHash = localModelContractHash(contract), routeId = "local-assist-uptime-gpu-qwen";
  const policy = { version: 1 as const, globalLimit: 1, providerLimits: { "gpu-qwen": 1 }, groupLimits: { gpu3090: 1 },
    poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 8,
    queueTtlMs: 60000, reservationTtlMs: 60000, routes: [{ routeId, provider: "local-direct", model: contract.model,
      providerBudgetId: contract.backendId, groupId: contract.physicalGroup }] };
  return assistRolloutManifestSchema.parse({ version: 1, integratedSha: sha, target: "gpu", asOf: now, maxEvidenceAgeMs: 900000,
    codeChecks: ["unit", "integration", "build", "typecheck", "lint", "required_ci"].map(kind => ({ kind, sha, result: "passed", artifactHash: hash })),
    contracts: [contract], verifiedContractHashes: { "gpu-qwen": cHash }, physicalLimits: { gpu3090: 1 }, policy,
    readbacks: [{ backendId: contract.backendId, integratedSha: sha, contractHash: cHash, artifactHash: hash, endpoint: contract.endpoint,
      model: contract.responseModel, deploymentRevision: contract.deploymentRevision, physicalGroup: contract.physicalGroup,
      contextWindowTokens: 32000, configuredConcurrency: 1, observedAt: now }],
    inventory: { integratedSha: sha, artifactHash: hash, observedAt: now, expectedCallerIds: ["assist-gpu"],
      callers: [{ callerId: "assist-gpu", routeId, provider: "local-direct", model: contract.model, backendId: contract.backendId,
        physicalGroup: contract.physicalGroup, transport: "local-direct", contractEvidenceHash: hash, nativeTerminalEvidenceHash: hash }],
      groups: [{ physicalGroup: contract.physicalGroup, configuredConcurrency: 1, artifactHash: hash, observedAt: now }],
      aliases: [{ callerId: "assist-gpu", endpoint: contract.endpoint, physicalGroup: contract.physicalGroup, artifactHash: hash }] },
    native: { integratedSha: sha, ledgerArtifactHash: hash, observedAt: now, unsettledRequestIds: [], canaries: [
      { requestId: randomUUID(), backendId: contract.backendId, integratedSha: sha, contractHash: cHash, responseModel: contract.responseModel,
        deploymentRevision: contract.deploymentRevision, requestHash: hash, responseHash: hash, terminalArtifactHash: hash,
        ledgerState: "settled", finishReason: "stop", actualTotalTokens: 123, observedAt: now }] },
    routing: { gpuBackendId: contract.backendId, m1BackendId: null, primaryBackendIds: [contract.backendId], independentPairs: [], deepseek: null },
    comparison: { datasetId: "human-holdout", datasetHash: hash, split: "holdout", evidenceKind: "snapshot", cases: [caseRow],
      labels: { kind: "human_independent", artifactHash: hash, caseIds: [caseRow.caseId] },
      runs: [{ backendId: contract.backendId, contractHash: cHash, responseArtifactHash: hash,
        cases: [{ ...caseRow, wireHash: hash, responseHash: hash, elapsedMs: 25 }] }], measuredArtifactHash: hash, acceptedCriteriaArtifactHash: hash },
    policyApproval: { integratedSha: sha, policyHash: modelCapacityPolicyHash(policy), datasetHash: hash, artifactHash: hash,
      actor: "fixture-reviewer", approvedAt: now, scope: "confirm" } });
}

function addM1(m: AssistRolloutManifest) {
  const m1 = { ...contract, backendId: "m1-qwen", physicalGroup: "m1", endpoint: "http://100.64.0.2:8792/v1/chat/completions", deploymentRevision: "fixture-m1-q4" };
  const cHash = localModelContractHash(m1), routeId = "local-assist-uptime-m1-qwen", requestId = randomUUID();
  m.target = "gpu_m1"; m.contracts.push(m1); m.verifiedContractHashes[m1.backendId] = cHash; m.physicalLimits.m1 = 1;
  m.policy!.globalLimit = 2; m.policy!.providerLimits[m1.backendId] = 1; m.policy!.groupLimits.m1 = 1;
  m.policy!.routes.push({ routeId, provider: "local-direct", model: m1.model, providerBudgetId: m1.backendId, groupId: "m1" });
  m.readbacks.push({ ...m.readbacks[0], backendId: m1.backendId, physicalGroup: "m1", endpoint: m1.endpoint, contractHash: cHash, deploymentRevision: m1.deploymentRevision });
  m.inventory!.expectedCallerIds.push("assist-m1");
  m.inventory!.callers.push({ ...m.inventory!.callers[0], callerId: "assist-m1", routeId, backendId: m1.backendId, physicalGroup: "m1" });
  m.inventory!.groups.push({ physicalGroup: "m1", configuredConcurrency: 1, artifactHash: hash, observedAt: now });
  m.inventory!.aliases.push({ callerId: "assist-m1", endpoint: m1.endpoint, physicalGroup: "m1", artifactHash: hash });
  m.native!.canaries.push({ ...m.native!.canaries[0], requestId, backendId: m1.backendId, contractHash: cHash, deploymentRevision: m1.deploymentRevision });
  m.routing!.m1BackendId = m1.backendId; m.routing!.primaryBackendIds.push(m1.backendId);
  m.m1Ingress = { backendId: m1.backendId, integratedSha: sha, relayRevision: sha, contractHash: cHash,
    workerAccessArtifactHash: hash, mixedWorkArtifactHash: hash, canaryRequestId: requestId, observedAt: now };
  m.comparison!.runs.push({ ...m.comparison!.runs[0], backendId: m1.backendId, contractHash: cHash });
  m.policyApproval!.policyHash = modelCapacityPolicyHash(m.policy!);
}

describe("오프라인 rollout 증거 일관성", () => {
  it("계약 shape·boolean·문서만으로 운영 준비나 쓰기 권한을 만들지 않는다", () => {
    expect(verifyAssistRolloutManifest({ version: 1, integratedSha: sha })).toMatchObject({ schemaValid: true, codeComplete: false,
      productionEligibleForReview: false, productionReady: false, automaticApplyAuthorized: false, mutations: false, deepseek: "off" });
    expect(verifyAssistRolloutManifest({ version: 1, integratedSha: sha, ready: true }).schemaValid).toBe(false);
    expect(verifyAssistRolloutManifest(fixture())).toMatchObject({ productionEligibleForReview: true, productionReady: false, automaticApplyAuthorized: false });
  });
  it("정확한 통합 SHA의 전체 검증과 필수 CI를 별도로 요구한다", () => {
    const m = fixture(); m.codeChecks[0].sha = "c".repeat(40);
    expect(verifyAssistRolloutManifest(m).blockers.code).toContain("exact_sha_check_missing:unit");
    m.codeChecks[0].sha = sha; m.codeChecks = m.codeChecks.filter(row => row.kind !== "required_ci");
    expect(verifyAssistRolloutManifest(m).codeComplete).toBe(false);
  });
  it("exact readback·한도·native 종료·활성 caller/alias를 모두 확인한다", () => {
    const mutate = [
      (m: AssistRolloutManifest) => { m.verifiedContractHashes = {}; },
      (m: AssistRolloutManifest) => { m.readbacks[0].contextWindowTokens--; },
      (m: AssistRolloutManifest) => { m.physicalLimits.gpu3090 = 2; },
      (m: AssistRolloutManifest) => { m.inventory!.expectedCallerIds.push("existing-search"); },
      (m: AssistRolloutManifest) => { m.inventory!.aliases[0].physicalGroup = "other-gpu"; },
      (m: AssistRolloutManifest) => { m.native!.unsettledRequestIds.push(randomUUID()); },
      (m: AssistRolloutManifest) => { m.native!.canaries[0].ledgerState = "indeterminate"; },
    ];
    for (const change of mutate) { const m = fixture(); change(m); expect(verifyAssistRolloutManifest(m).globalCapacityEvidenceComplete).toBe(false); }
  });
  it("gateway alias도 같은 물리 group 한도를 사용하며 미연결 text/search는 global open을 막는다", () => {
    const m = fixture(), caller = { ...m.inventory!.callers[0], callerId: "existing-search", transport: "gateway" as const,
      backendId: null, provider: "abcllm", routeId: "search", model: "gateway-alias" };
    m.inventory!.callers.push(caller); m.inventory!.expectedCallerIds.push(caller.callerId);
    m.inventory!.aliases.push({ callerId: caller.callerId, endpoint: "http://100.64.0.3:8000/v1/chat/completions", physicalGroup: "gpu3090", artifactHash: hash });
    expect(verifyAssistRolloutManifest(m).globalCapacityEvidenceComplete).toBe(false);
    m.policy!.routes.push({ routeId: caller.routeId, provider: caller.provider, model: caller.model, providerBudgetId: "gpu-qwen", groupId: "gpu3090" });
    m.policyApproval!.policyHash = modelCapacityPolicyHash(m.policy!);
    expect(verifyAssistRolloutManifest(m).globalCapacityEvidenceComplete).toBe(true);
    m.inventory!.groups = [];
    expect(verifyAssistRolloutManifest(m).productionEligibleForReview).toBe(false);
  });
  it("GPU 단계와 실제 M1 worker 접근·혼합 처리 근거를 구분한다", () => {
    const m = fixture(); addM1(m);
    expect(verifyAssistRolloutManifest(m)).toMatchObject({ gpuShadowEligible: true, gpuM1ShadowEligible: true, gpuM1ConfirmEligible: true });
    m.m1Ingress = null;
    expect(verifyAssistRolloutManifest(m)).toMatchObject({ gpuShadowEligible: true, gpuM1ShadowEligible: false, productionEligibleForReview: false });
  });
  it("아직 활성 caller가 아닌 계획상 M1의 누락은 GPU 전용 단계를 막지 않는다", () => {
    const m = fixture();
    const planned = { ...contract, backendId: "planned-m1", endpoint: "http://100.64.0.9:8792/v1/chat/completions", physicalGroup: "m1" };
    m.contracts.push(planned); m.routing!.m1BackendId = planned.backendId;
    expect(verifyAssistRolloutManifest(m)).toMatchObject({ gpuConfirmEligible: true, gpuM1ConfirmEligible: false });
  });
  it("선택한 추가 주 처리 backend의 실제 계약·caller·평가를 생략할 수 없다", () => {
    const unverified = fixture();
    unverified.contracts.push({ ...contract, backendId: "unverified-primary", physicalGroup: "extra",
      endpoint: "http://100.64.0.9:8792/v1/chat/completions" });
    unverified.routing!.primaryBackendIds.push("unverified-primary");
    const report = verifyAssistRolloutManifest(unverified);
    expect(report).toMatchObject({ globalCapacityEvidenceComplete: false, gpuConfirmEligible: false, productionEligibleForReview: false });
    expect(report.blockers.global).toContain("verified_contract_hash_missing:unverified-primary");
    expect(report.blockers.global).toContain("primary_caller_missing:unverified-primary");
    expect(report.blockers.evaluation).toContain("backend_comparison_incomplete");

    const missingCaller = fixture(); addM1(missingCaller);
    missingCaller.inventory!.expectedCallerIds = ["assist-gpu"];
    missingCaller.inventory!.callers = missingCaller.inventory!.callers.filter(row => row.backendId === "gpu-qwen");
    missingCaller.inventory!.aliases = missingCaller.inventory!.aliases.filter(row => row.callerId === "assist-gpu");
    expect(verifyAssistRolloutManifest(missingCaller).blockers.global).toContain("primary_caller_missing:m1-qwen");

    const missingComparison = fixture(); addM1(missingComparison);
    // 추가 primary는 명명된 M1 역할이 아니어도 평가 대상이다.
    missingComparison.target = "gpu"; missingComparison.routing!.m1BackendId = null;
    missingComparison.comparison!.runs = missingComparison.comparison!.runs.filter(row => row.backendId === "gpu-qwen");
    expect(verifyAssistRolloutManifest(missingComparison).gpuConfirmEligible).toBe(false);
  });
  it("M1을 실제 주 처리로 선택한 목록과 GPU 전용 target의 모순을 거부한다", () => {
    const m = fixture(); addM1(m); m.target = "gpu";
    expect(verifyAssistRolloutManifest(m).productionEligibleForReview).toBe(false);
    const duplicate = fixture(); duplicate.routing!.primaryBackendIds.push("gpu-qwen");
    expect(verifyAssistRolloutManifest(duplicate).productionEligibleForReview).toBe(false);
  });
  it("GPU backend를 M1 이름으로 재사용해 분산 도입 완료로 세지 않는다", () => {
    const m = fixture(); m.target = "gpu_m1"; m.routing!.m1BackendId = contract.backendId;
    m.m1Ingress = { backendId: contract.backendId, integratedSha: sha, relayRevision: sha, contractHash: localModelContractHash(contract),
      workerAccessArtifactHash: hash, mixedWorkArtifactHash: hash, canaryRequestId: m.native!.canaries[0].requestId, observedAt: now };
    expect(verifyAssistRolloutManifest(m).gpuM1ShadowEligible).toBe(false);
  });
  it("GPU와 M1 Qwen은 독립 감사 두 표가 아니며 GPTOSS를 새 주 처리로 인정하지 않는다", () => {
    const m = fixture(); addM1(m);
    m.routing!.independentPairs.push({ originalBackendId: "gpu-qwen", reviewerBackendId: "m1-qwen" });
    expect(verifyAssistRolloutManifest(m).blockers.global).toContain("independent_model_family_required");
    const other = fixture(); other.contracts[0].modelFamily = "gpt-oss-120b";
    expect(verifyAssistRolloutManifest(other).blockers.gpu).toContain("primary_qwen_required:gpu-qwen");
  });
  it("DeepSeek 예외·감사 한도와 표본률은 모두 명시해야 한다", () => {
    const m = fixture();
    expect(verifyAssistRolloutManifest(m).deepseek).toBe("off");
    expect(verifyAssistRolloutManifest({ ...m, routing: { ...m.routing, deepseek: { backendId: "deepseek" } } }).schemaValid).toBe(false);
  });
  it("비활성 예외 backend의 증거 부족은 GPU 주 처리 검토를 직렬화하지 않는다", () => {
    const m = fixture();
    m.contracts.push({ ...contract, backendId: "planned-deepseek", endpoint: "http://100.64.0.8:8000/v1/chat/completions",
      physicalGroup: "m3", model: "deepseek", responseModel: "deepseek", modelFamily: "deepseek-v4.1-flash-1017" });
    m.routing!.deepseek = { backendId: "planned-deepseek", maxExceptionCallsPerWeek: 1, maxAuditCallsPerWeek: 1, auditFraction: 0.01 };
    expect(verifyAssistRolloutManifest(m)).toMatchObject({ gpuConfirmEligible: true, deepseekEligibleForReview: false });
  });
  it("실근거 독립 라벨·동일 input/source/prompt/schema·모든 응답을 요구한다", () => {
    const mutate = [
      (m: AssistRolloutManifest) => { m.comparison!.evidenceKind = "synthetic"; },
      (m: AssistRolloutManifest) => { m.comparison!.labels.kind = "synthetic"; },
      (m: AssistRolloutManifest) => { m.comparison!.runs[0].cases[0].inputHash = "c".repeat(64); },
      (m: AssistRolloutManifest) => { m.comparison!.runs[0].cases[0].promptHash = "c".repeat(64); },
      (m: AssistRolloutManifest) => { m.comparison!.labels.caseIds.push("missing"); },
    ];
    for (const change of mutate) { const m = fixture(); change(m); expect(verifyAssistRolloutManifest(m).gpuConfirmEligible).toBe(false); }
  });
  it("과거 증거·다른 정책·shadow 승인으로 confirm 자격을 만들지 않는다", () => {
    const m = fixture(); m.readbacks[0].observedAt = "2026-10-22T10:00:00Z";
    expect(verifyAssistRolloutManifest(m).globalCapacityEvidenceComplete).toBe(false);
    const approval = fixture(); approval.policyApproval!.scope = "shadow";
    expect(verifyAssistRolloutManifest(approval).gpuConfirmEligible).toBe(false);
    approval.policyApproval!.scope = "confirm"; approval.policyApproval!.policyHash = "c".repeat(64);
    expect(verifyAssistRolloutManifest(approval).gpuConfirmEligible).toBe(false);
  });
  it("CLI는 입력이 없어도 닫힌 plan을 출력하고 apply·기존 산출물 덮어쓰기를 거부한다", () => {
    const root = mkdtempSync(path.join(tmpdir(), "assist-rollout-"));
    try {
      const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/verify-llm-assist-rollout.ts", ...args], { cwd: process.cwd(), encoding: "utf8" });
      const absent = run([]); expect(absent.status).toBe(1); expect(JSON.parse(absent.stdout).mutations).toBe(false);
      const schema = run(["--schema"]); expect(schema.status).toBe(0); expect(JSON.parse(schema.stdout).additionalProperties).toBe(false);
      const manifest = path.join(root, "manifest.json"), report = path.join(root, "report.json");
      writeFileSync(manifest, JSON.stringify(fixture()));
      expect(run(["--manifest", manifest, "--out", report]).status).toBe(0);
      expect(JSON.parse(readFileSync(report, "utf8")).automaticApplyAuthorized).toBe(false);
      expect(run(["--manifest", manifest, "--out", report]).status).toBe(2);
      expect(run(["--manifest", manifest, "--apply"]).status).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
