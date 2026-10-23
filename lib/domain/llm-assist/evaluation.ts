import { z } from "zod";
import { localModelContractHash, localModelServingContractsSchema } from "@/lib/llm/local-model-serving-contract";
import { assistHash, assistInputHash, assistInputSchema, assistOutcomeSchema, validateAssistOutcome, type AssistTask } from "./contracts";
import { assistPromptHash } from "./prompts";

const expectedFindings: Readonly<Record<AssistTask, readonly string[]>> = {
  uptime: ["alive", "closed", "parked", "soft_404", "unclear"], repo: ["same_project", "unrelated", "unclear"],
  intro: ["keep", "rewrite_candidate", "human"],
  audit: ["alive", "closed", "parked", "soft_404", "unclear", "same_project", "unrelated", "keep", "rewrite_candidate", "human"],
  news: ["publish_translation_candidate", "collect_evidence", "human_review", "independent_review"],
};
const expectedFact = z.object({ pointer: z.string().regex(/^\/state\//), value: z.json() }).strict();
export const assistEvaluationDatasetSchema = z.object({
  version: z.literal(1), datasetId: z.string().min(1).max(120), split: z.enum(["development", "holdout"]),
  evidenceKind: z.enum(["synthetic", "snapshot"]),
  backends: localModelServingContractsSchema,
  cases: z.array(z.object({ id: z.string().min(1).max(120), input: assistInputSchema,
    expected: z.object({ finding: z.string().min(1), facts: z.array(expectedFact).max(64).default([]) }).strict() }).strict()).min(1).max(10_000),
}).strict().superRefine((dataset, context) => {
  const ids = new Set<string>();
  for (const [index, row] of dataset.cases.entries()) {
    if (ids.has(row.id)) context.addIssue({ code: "custom", message: "duplicate_case", path: ["cases", index] });
    ids.add(row.id);
    if (!expectedFindings[row.input.task].includes(row.expected.finding)) context.addIssue({
      code: "custom", message: "invalid_expected_finding", path: ["cases", index, "expected"],
    });
  }
});
const sha64 = z.string().regex(/^[a-f0-9]{64}$/);
export const assistEvaluationResponseSchema = z.object({ caseId: z.string().min(1), backendId: z.string().min(1),
  inputHash: sha64, promptHash: sha64, contractHash: sha64, responseModel: z.string().min(1),
  elapsedMs: z.number().finite().nonnegative(), output: z.unknown().refine(value => value !== undefined) }).strict();

function atPointer(value: unknown, pointer: string): unknown {
  let current = value;
  for (const segment of pointer.slice(1).split("/")) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** 저장된 입력·응답을 검사할 뿐 provider 호출·DB 변경·운영 준비 판정을 하지 않는다. */
export function evaluateAssistResponses(datasetValue: unknown, responsesValue: unknown[]) {
  const dataset = assistEvaluationDatasetSchema.parse(datasetValue);
  const responses = z.array(assistEvaluationResponseSchema).parse(responsesValue);
  const seen = new Set<string>();
  const rows = responses.map(record => {
    const key = JSON.stringify([record.caseId, record.backendId]);
    if (seen.has(key)) throw new Error("duplicate_evaluation_response");
    seen.add(key);
    const row = dataset.cases.find(row => row.id === record.caseId);
    const backend = dataset.backends.find(backend => backend.backendId === record.backendId);
    if (!row || !backend) throw new Error("unknown_evaluation_case_or_backend");
    const identityValid = record.inputHash === assistInputHash(row.input)
      && record.promptHash === assistPromptHash(row.input.task) && record.contractHash === localModelContractHash(backend)
      && record.responseModel === backend.responseModel;
    const structure = assistOutcomeSchema.safeParse(record.output);
    const validated = identityValid ? validateAssistOutcome(row.input, record.output) : { ok: false as const, error: "identity_mismatch" };
    let finding: string | null = null;
    if (validated.ok) {
      const outcome = validated.outcome;
      switch (outcome.task) {
        case "uptime": finding = outcome.state.page_state; break;
        case "repo": finding = outcome.state.relationship; break;
        case "intro": finding = outcome.state.treatment; break;
        case "audit": finding = outcome.state.independent_finding; break;
        case "news": finding = outcome.action.proposal; break;
      }
    }
    const factsMatch = validated.ok && row.expected.facts.every(fact =>
      JSON.stringify(atPointer(validated.outcome, fact.pointer)) === JSON.stringify(fact.value));
    return { caseId: row.id, backendId: backend.backendId, task: row.input.task, elapsedMs: record.elapsedMs,
      identityValid, schemaValid: structure.success, guardValid: validated.ok,
      error: validated.ok ? null : validated.error, expectedFinding: row.expected.finding, observedFinding: finding,
      factsMatch, match: validated.ok && finding === row.expected.finding && factsMatch,
      // 고정 사실 필드 일치도와 실제 요약 의미 정확도는 별개다.
      newsSemanticsUnscored: row.input.task === "news" };
  });
  const byBackend = Object.fromEntries(dataset.backends.map(backend => {
    const selected = rows.filter(row => row.backendId === backend.backendId);
    const elapsed = selected.map(row => row.elapsedMs).sort((a, b) => a - b);
    return [backend.backendId, { expected: dataset.cases.length, received: selected.length,
      missing: dataset.cases.filter(row => !seen.has(JSON.stringify([row.id, backend.backendId]))).map(row => row.id),
      schemaValid: selected.filter(row => row.schemaValid).length, guardValid: selected.filter(row => row.guardValid).length,
      matches: selected.filter(row => row.match).length,
      p50Ms: elapsed.length ? elapsed[Math.ceil(elapsed.length * .5) - 1] : null,
      p95Ms: elapsed.length ? elapsed[Math.ceil(elapsed.length * .95) - 1] : null }];
  }));
  return { version: 1, datasetId: dataset.datasetId, datasetHash: assistHash(dataset), split: dataset.split,
    evidenceKind: dataset.evidenceKind, source: "offline_provided_responses",
    productionAccuracyClaim: false, providerReadinessClaim: false, byBackend, rows };
}
