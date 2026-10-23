import { describe, expect, it, vi, beforeEach } from "vitest";
const runtime = vi.hoisted(() => ({ inTransaction: false, fetch: vi.fn(), lock: vi.fn(), facts: vi.fn(), protections: vi.fn(),
  load: vi.fn(), enqueue: vi.fn(), record: vi.fn(), tx: { execute: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: { transaction: async (run: (tx: typeof runtime.tx) => Promise<unknown>) => {
  runtime.inTransaction = true; try { return await run(runtime.tx); } finally { runtime.inTransaction = false; }
} } }));
vi.mock("@/lib/net/fetch", () => ({ fetchCapped: runtime.fetch }));
vi.mock("@/lib/domain/products/automated-action-audit-repository", async original => ({
  ...await original<typeof import("@/lib/domain/products/automated-action-audit-repository")>(),
  lockActionAuditCandidate: runtime.lock, readCurrentActionAuditFacts: runtime.facts,
  readActionAuditProtections: runtime.protections, loadAutomatedDecision: runtime.load,
  enqueueSemanticActionException: runtime.enqueue, recordActionAuditCompletion: runtime.record,
}));
import { actionAuditBackendEligible, collectActionAuditInput, completeActionAuditRuntime,
  enqueueSemanticExceptionForResult } from "@/lib/domain/llm-assist/audit-runtime";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { candidate, decision, alive, policy, seed } from "./fixtures/automated-action-audit";
import { ASSIST_SCHEMA_VERSION } from "@/lib/domain/llm-assist/contracts";

const config = { LLM_ACTION_AUDIT_POLICY: JSON.stringify(policy), LLM_ACTION_AUDIT_SEED: seed };
const transaction = () => runtime.tx as unknown as ProductTransaction;
beforeEach(() => {
  vi.clearAllMocks(); runtime.inTransaction = false;
  runtime.lock.mockResolvedValue(true);
  runtime.facts.mockResolvedValue({ task: "uptime", requestedUrl: "https://example.com" });
  runtime.protections.mockResolvedValue({ administratorReleased: false, makerProtected: false });
  runtime.tx.execute.mockResolvedValue([{ repoUrl: null }]);
  runtime.fetch.mockImplementation(async (url: string) => {
    expect(runtime.inTransaction).toBe(false);
    if (url !== "https://example.com") throw new Error("fixture_external_transport_forbidden");
    return { ok: true, status: 200, finalUrl: url, headers: new Headers(), body: Buffer.from("<p>The tool has an active plan.</p>") };
  });
});

describe("독립 감사 runtime", () => {
  it("장비명이나 alias를 새 기반 모델로 보지 않고 정확한 독립 family만 허용한다", () => {
    const c = candidate();
    expect(actionAuditBackendEligible(c, "deepseek-v4.1-flash-1017")).toBe(true);
    for (const family of ["qwen3.8-flash-next", "m1-qwen", "gpt-oss-120b", "deepseek"]) expect(actionAuditBackendEligible(c, family)).toBe(false);
    expect(actionAuditBackendEligible(candidate(decision({ modelFamily: null })), "deepseek-v4.1-flash-1017")).toBe(false);
    expect(actionAuditBackendEligible(candidate(decision({ modelFamily: "deepseek-v4.1-flash-1017" })), "qwen3.8-flash-next")).toBe(true);
  });
  it("DB 잠금을 놓고 현재 페이지를 수집하며 이전 결론·이유·모델을 입력에서 가린다", async () => {
    const c = { ...candidate(), selectedAt: new Date(Date.now() - 1000).toISOString() };
    const collected = await collectActionAuditInput(c);
    expect(collected.kind).toBe("ready");
    if (collected.kind !== "ready") throw new Error(collected.reason);
    const text = JSON.stringify(collected.input);
    expect(text).toContain("active plan");
    for (const hidden of [c.decision.resultId, c.decision.modelFamily!, c.decision.outcome.action.reason_ko, "confidence", "delist_candidate"])
      expect(text).not.toContain(hidden);
    expect(collected.input.sources.find(source => source.kind === "metadata")?.text).toBe(JSON.stringify({ task: "uptime", requestedUrl: "https://example.com" }));
    expect(runtime.fetch).toHaveBeenCalledTimes(1);
    expect(runtime.fetch.mock.calls[0][1]).toMatchObject({ maxBytes: 128_000, allowTruncatedBody: true });
  });
  it("수집 실패·차단·잘림은 빈 자료 DeepSeek 호출용 입력으로 승격하지 않는다", async () => {
    const c = { ...candidate(), selectedAt: new Date(Date.now() - 1000).toISOString() };
    for (const response of [{ ok: false, reason: "http", status: 429 }, { ok: false, reason: "timeout" },
      { ok: true, status: 200, finalUrl: c.product.url, headers: new Headers(), body: Buffer.from("Partial text"), truncated: true }]) {
      runtime.fetch.mockResolvedValue(response);
      expect(await collectActionAuditInput(c)).toEqual({ kind: "waiting_evidence", reason: "audit_current_evidence_required" });
    }
    runtime.lock.mockResolvedValue(false);
    runtime.fetch.mockClear();
    expect(await collectActionAuditInput(c)).toEqual({ kind: "obsolete", reason: "audit_source_changed" });
    expect(runtime.fetch).not.toHaveBeenCalled();
  });
  it("같은 family나 실제 settled 원장 없는 결과는 findings에 기록하지 않는다", async () => {
    const c = { ...candidate(), selectedAt: new Date(Date.now() - 1000).toISOString() };
    const collected = await collectActionAuditInput(c);
    if (collected.kind !== "ready") throw new Error("collection_failed");
    runtime.tx.execute.mockResolvedValue([]);
    const value = { candidate: c, workId: c.decision.workId, resultId: c.decision.resultId, input: collected.input,
      outcome: { schema_version: ASSIST_SCHEMA_VERSION }, auditorFamily: "qwen3.8-flash-next" };
    expect(await completeActionAuditRuntime(transaction(), value)).toBeNull();
    expect(await completeActionAuditRuntime(transaction(), { ...value, auditorFamily: "deepseek-v4.1-flash-1017" })).toBeNull();
    expect(runtime.record).not.toHaveBeenCalled();
  });
});

describe("충분한 기존 Qwen 의미 충돌만 예외 생산", () => {
  it("용량·전송·형식·근거 실패와 비활성 설정은 원 result를 읽거나 예산을 소모하지 않는다", async () => {
    for (const reason of ["capacity", "transport", "invalid_output", "missing_evidence"] as const)
      expect(await enqueueSemanticExceptionForResult(transaction(), "invalid-id", reason, config)).toBe("not_eligible");
    expect(await enqueueSemanticExceptionForResult(transaction(), "invalid-id", "semantic_conflict", {})).toBe("disabled");
    expect(runtime.load).not.toHaveBeenCalled(); expect(runtime.enqueue).not.toHaveBeenCalled();
  });
  it("같은 입력의 기존 반대 판단을 찾고 역순 재전달도 applied 원 결정으로 같은 주간 키를 쓴다", async () => {
    const first = decision({ applied: true }), second = decision({ outcome: alive, applied: false });
    runtime.load.mockImplementation(async (_tx, id: string) => id === first.resultId ? first : id === second.resultId ? second : null);
    runtime.tx.execute.mockImplementation(async () => [{ id: first.resultId }, { id: second.resultId }]);
    runtime.enqueue.mockResolvedValue("queued");
    expect(await enqueueSemanticExceptionForResult(transaction(), second.resultId, "semantic_conflict", config)).toBe("queued");
    expect(await enqueueSemanticExceptionForResult(transaction(), first.resultId, "semantic_conflict", config)).toBe("queued");
    for (const call of runtime.enqueue.mock.calls) expect(call[1]).toMatchObject({ firstResultId: first.resultId, secondResultId: second.resultId, reason: "semantic_conflict" });
  });
  it("같은 결론이나 다른 입력의 결과에는 새 DeepSeek 예외를 만들지 않는다", async () => {
    const first = decision(), other = decision();
    runtime.load.mockImplementation(async (_tx, id: string) => id === first.resultId ? first : other);
    runtime.tx.execute.mockResolvedValue([{ id: other.resultId }]);
    expect(await enqueueSemanticExceptionForResult(transaction(), first.resultId, "semantic_conflict", config)).toBe("not_eligible");
    expect(runtime.enqueue).not.toHaveBeenCalled();
  });
});
