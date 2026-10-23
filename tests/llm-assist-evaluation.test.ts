import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSIST_SCHEMA_VERSION, assistInputHash, type AssistInput } from "@/lib/domain/llm-assist/contracts";
import { assistPromptHash } from "@/lib/domain/llm-assist/prompts";
import { evaluateAssistResponses } from "@/lib/domain/llm-assist/evaluation";
import { localModelContractHash, type LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";

const backend: LocalModelServingContract = { version: 1, protocol: "local-openai-chat-v1", backendId: "test-qwen", provider: "local-direct",
  physicalGroup: "test-device", endpoint: "http://127.0.0.1:8090/v1/chat/completions", model: "qwen3.8-flash-next",
  responseModel: "qwen3.8-flash-next", modelFamily: "qwen3.8-flash-next", deploymentRevision: "test-rev",
  contextWindowTokens: 50000, totalTokenBound: 50000, maxOutputTokens: 512, maxInputBytes: 65536,
  capabilities: { vision: false, jsonSchema: true }, thinking: { mode: "disabled", parameter: "enable_thinking" }, termination: { kind: "response_only" } };
const input: AssistInput = { schemaVersion: ASSIST_SCHEMA_VERSION, task: "uptime", subject: { type: "product", id: 1, revision: "raw.123456" },
  policyVersion: "policy", promptVersion: "2026-10-23.1", sources: [{ sourceId: "page", kind: "page" as const, url: "https://example.com",
    observedAt: "2026-10-23 00:00:00.123456", revision: "page-1", text: "Create workspace. Pricing. Sign in.", completeness: "complete" as const, httpStatus: 200 }],
  context: { requestedUrl: "https://example.com", finalUrl: "https://example.com", failureCount: 10, requiredFailures: 10, administratorReleased: false } };
const dataset = { version: 1, datasetId: "test-smoke", split: "holdout", evidenceKind: "synthetic", backends: [backend],
  cases: [{ id: "alive", input, expected: { finding: "alive", facts: [{ pointer: "/state/page_state", value: "alive" }] } }] };
const output = { schema_version: ASSIST_SCHEMA_VERSION, task: "uptime", state: { page_state: "alive", finding: "active_product" },
  evidence_quality: { status: "sufficient", limitations: ["none"] }, evidence: [{ source_id: "page", quote: "Create workspace", supports: ["/state/page_state"] }],
  action: { proposal: "retain", reason_ko: "실제 이용 기능이 있습니다.", missing_items: [] } };
const response = { caseId: "alive", backendId: backend.backendId, inputHash: assistInputHash(input), promptHash: assistPromptHash("uptime"),
  contractHash: localModelContractHash(backend), responseModel: backend.responseModel, elapsedMs: 200, output };

describe("offline assist evaluation", () => {
  it("scores actual supplied responses without labeling synthetic evidence as production accuracy", () => {
    const report = evaluateAssistResponses(dataset, [response]);
    expect(report.byBackend[backend.backendId]).toMatchObject({ received: 1, matches: 1, missing: [], p95Ms: 200 });
    expect(report.productionAccuracyClaim).toBe(false);
    expect(report.providerReadinessClaim).toBe(false);
  });
  it("keeps missing records and bad envelope identity out of the passing count", () => {
    expect(evaluateAssistResponses(dataset, []).byBackend[backend.backendId]).toMatchObject({ received: 0, matches: 0, missing: ["alive"] });
    for (const changed of [{ ...response, inputHash: "a".repeat(64) }, { ...response, promptHash: "b".repeat(64) },
      { ...response, contractHash: "c".repeat(64) }, { ...response, responseModel: "unverified-alias" }]) {
      expect(evaluateAssistResponses(dataset, [changed]).rows[0]).toMatchObject({ match: false, error: "identity_mismatch" });
    }
  });
  it("does not count duplicate attempts as independent cases or accept unknown subjects", () => {
    expect(() => evaluateAssistResponses(dataset, [response, response])).toThrow("duplicate_evaluation_response");
    expect(() => evaluateAssistResponses(dataset, [{ ...response, caseId: "other" }])).toThrow("unknown_evaluation_case_or_backend");
  });
  it("requires declared labels and separately checks frozen expected facts", () => {
    expect(() => evaluateAssistResponses({ ...dataset, cases: [{ ...dataset.cases[0], expected: { finding: "rewrite_candidate" } }] }, [response])).toThrow();
    const wrongFact = { ...dataset, cases: [{ ...dataset.cases[0], expected: { finding: "alive", facts: [{ pointer: "/state/page_state", value: "closed" }] } }] };
    expect(evaluateAssistResponses(wrongFact, [response]).rows[0]).toMatchObject({ guardValid: true, factsMatch: false, match: false });
  });
  it("runs the offline CLI from frozen files without provider or database configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "nmv-assist-offline-"));
    try {
      const datasetFile = join(directory, "dataset.json"), responsesFile = join(directory, "responses.jsonl"), outputFile = join(directory, "out.json");
      writeFileSync(datasetFile, JSON.stringify(dataset));
      writeFileSync(responsesFile, JSON.stringify(response) + "\n");
      execFileSync(process.execPath, ["--import", "tsx", "scripts/evaluate-llm-assist.ts", "--dataset", datasetFile,
        "--responses", responsesFile, "--out", outputFile], { cwd: process.cwd(), timeout: 15_000,
        env: { ...process.env, DATABASE_URL: "", LOCAL_MODEL_SERVING_CONTRACTS: "" } });
      const report = JSON.parse(readFileSync(outputFile, "utf8"));
      expect(report.byBackend[backend.backendId]).toMatchObject({ matches: 1, received: 1 });
      expect(report.source).toBe("offline_provided_responses");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
