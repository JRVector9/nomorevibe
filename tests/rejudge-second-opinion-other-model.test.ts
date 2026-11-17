import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { setAiTaskModelsForTest } from "@/lib/llm/ai-task-models-snapshot";
import type { JobContext } from "@/lib/jobs/runner";

/** 실제 틱의 모델 선택·장부 경유·의견 기록을 본다. SQL 선택식은 전용 DB 통합 시험에서 검증한다. */
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  auditRows: [] as Row[], publishedRows: [] as Row[], inputs: new Map<string, { validUntil: Date; inputHash: string }>(),
  observation: null as unknown, reserved: [] as string[], asked: [] as string[], written: [] as string[],
  contended: new Set<string>(), refuse: new Map<string, unknown>(), queries: [] as SQL[], rejecting: "qwen3.8-flash-next", calls: [] as string[],
}));
const keyOf = (target: { kind: string; itemId?: number; secondReviewId?: number }) =>
  target.kind === "audit" ? `a:${target.itemId}` : `p:${target.secondReviewId}`;

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => {
  // 관측 읽기(readQwenAutoObservation)는 where 를 바로 기다리고, 공개분 입력(publishedInput)은 limit(1)로 그 행의 후보·문서를 읽는다
  const where = (condition: SQL) => ({
    then: (resolve: (rows: Row[]) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(state.observation ? [{ value: state.observation }] : []).then(resolve, reject),
    limit: async () => {
      const slug = new PgDialect().sqlToQuery(condition).params.find((value) => typeof value === "string" && value.startsWith("pub-"));
      return slug ? [{ candidate: { publishedSlug: slug, productUrl: "https://fixture.test" }, document: { productUrl: "https://fixture.test" } }] : [];
    },
  });
  const chain = { from: () => chain, innerJoin: () => chain, where };
  return { db: { select: () => chain, execute: async (query: SQL) => {
    state.queries.push(query);
    const text = new PgDialect().sqlToQuery(query).sql;
    if (!text.includes("product_audit_items")) return state.publishedRows;
    const params = new PgDialect().sqlToQuery(query).params;
    const model = state.rejecting !== "qwen3.8-flash-next" ? "qwen3.8-flash-next"
      : params.includes("deepseek-v4.1-flash-1017") ? "deepseek-v4.1-flash-1017" : null;
    return model ? state.auditRows.map(row => ({ ...row, opinion_model: model })) : [];
  } } };
});
vi.mock("@/lib/jobs/control", async (load) => ({ ...await load<typeof import("@/lib/jobs/control")>(),
  withJobLeaseWrite: async (_lease: unknown, write: (tx: unknown) => Promise<unknown>) => write({ insert: () => ({ values: (value: { value: unknown }) => ({
    onConflictDoUpdate: async () => { state.observation = structuredClone(value.value); } }) }) }) }));
vi.mock("@/lib/crawl/product-audit", () => ({ loadAuditInput: async (slug: string) => state.inputs.get(slug) ?? null }));
vi.mock("@/lib/crawl/qwen-endpoint-backoff", () => ({ qwenEndpointBackingOff: () => false, withQwenSecondarySlot: (run: () => unknown) => run(),
  noteQwenEndpointSuccess: async () => {}, noteQwenCallFailure: async () => ({ outage: false }), endpointBackoffActive: () => false,
  readQwenEndpointBackoff: async () => null }));
vi.mock("@/lib/crawl/qwen-direct-review", async (load) => ({ ...await load<typeof import("@/lib/crawl/qwen-direct-review")>(),
  qwenDirectConfig: () => ({ model: "qwen3.8-flash-next", baseUrl: "http://fixture.invalid/v1", apiKey: null }),
  reviewWithQwenDirect: async (input: { inputHash: string }, opts: { config?: { model: string } }) => {
    const model = opts.config?.model ?? "qwen3.8-flash-next"; state.calls.push(model);
    state.asked.push(input.inputHash);
    return { model, promptVersion: "2026-10-21.v2", latencyMs: 1,
      outcome: { decision: "needs_review", confidence: 0.6, reason: "사람이 본다", evidenceIds: ["product"] } };
  } }));
vi.mock("@/lib/llm/local-model-capacity", () => ({
  verifiedLocalModelContract: () => ({ backendId: "fixture", model: "deepseek-v4.1-flash-1017" }),
  withLocalModelCapacity: async (context: { target: { kind: string; itemId?: number; secondReviewId?: number }; input: { validUntil: Date } },
    run: (request: typeof fetch) => Promise<unknown>) => {
    const key = keyOf(context.target);
    state.reserved.push(key);
    // 진짜 자리 경합 — 장부가 자리를 주지 않았다(일시 거절)
    if (state.contended.has(key)) throw new ModelCapacityDeferredError("capacity");
    // 증명이 따로 거절하게 한 대상(이 PR 의 하위 오류)
    if (state.refuse.has(key)) throw state.refuse.get(key);
    // 운영 장부: 입력 기한이 지난 대상은 자리를 잡은 뒤 호출 직전 증명에서 거절되어 예약이 물린다
    if (context.input.validUntil.getTime() <= Date.now()) throw new ModelCapacityDeferredError("reservation_lost");
    return run(fetch);
  } }));
vi.mock("@/lib/crawl/audit-second-opinion-import", () => ({ writeAuditSecondOpinions: async (_db: unknown, rows: { itemId: number }[]) => {
  state.written.push(`a:${rows[0].itemId}`);
  return { inserted: 1, updated: 0, released: 0, skipped: {}, autoClose: null };
} }));
vi.mock("@/lib/crawl/published-second-review", () => ({ applyPublishedAutoOpinion: async (value: { id: number }) => {
  state.written.push(`p:${value.id}`);
  return "noted";
} }));
vi.mock("@/lib/crawl/agent-review-repository", () => ({ loadReviewInput: async (candidate: { publishedSlug: string }) =>
  state.inputs.get(candidate.publishedSlug) ?? null }));

const { runQwenSecondOpinions } = await import("@/lib/crawl/audit-second-opinion-auto");
const { rejudgeSecondOpinionModels } = await import("@/lib/crawl/rejudge-second-opinion-models");

function rank(model: string, rank: number) {
  return { task: "audit-second-opinion", slot: 1, rank, model, enabled: true, options: {},
    connection: { id: "00000000-0000-4000-8000-000000000001", label: "fixture", kind: "api" as const, baseUrl: "http://fixture.invalid/v1",
      cliTool: null, deviceId: "fixture", enabled: true, models: null, contextTokens: 32768, apiKey: null, keyUnreadable: false } };
}
const HOUR = 3600_000;
const fresh = () => new Date(Date.now() + 12 * HOUR);
function settings(steps: { audit?: boolean; published?: boolean }): CrawlSettings {
  return { ...DEFAULT_CRAWL_SETTINGS, enabled: true, qwenAuto: { ...DEFAULT_CRAWL_SETTINGS.qwenAuto,
    auditSecondOpinion: { ...DEFAULT_CRAWL_SETTINGS.qwenAuto.auditSecondOpinion, enabled: Boolean(steps.audit), perTick: 10, autoClose: false },
    publishedFilter: { enabled: Boolean(steps.published), perTick: 10 } } };
}
function context(): JobContext<null> {
  return { cursor: null, save: async () => {}, hasBudget: () => true, deadlineAt: Date.now() + 70_000, log: () => {},
    lease: { name: "audit-second-opinion", token: randomUUID(), requestedVersion: 1 } };
}
function audit(itemId: number, validUntil: Date) {
  const slug = `item-${itemId}`;
  state.auditRows.push({ item_id: itemId, product_id: itemId + 1000, slug });
  state.inputs.set(slug, { validUntil, inputHash: `a:${itemId}` });
}
beforeEach(() => {
  state.auditRows.length = 0; state.publishedRows.length = 0; state.inputs.clear(); state.observation = null;
  state.reserved.length = 0; state.asked.length = 0; state.written.length = 0; state.contended.clear(); state.refuse.clear();
  state.queries.length = 0; state.calls.length = 0; state.rejecting = "qwen3.8-flash-next";
  setAiTaskModelsForTest([rank("qwen3.8-flash-next", 1)]);
});

afterEach(() => setAiTaskModelsForTest(null));

describe("재판정 거절의 독립 두 번째 의견", () => {
  it("같은 모델을 제외하고 다음 다른 모델을 기존 용량 장부로 묻는다", async () => {
    setAiTaskModelsForTest([rank("qwen3.8-flash-next", 1), rank("deepseek-v4.1-flash-1017", 2)]);
    audit(1, fresh());
    const tally = await runQwenSecondOpinions(context(), settings({ audit: true }));
    expect(state.calls).toEqual(["deepseek-v4.1-flash-1017"]);
    expect(state.reserved).toEqual(["a:1"]);
    expect(state.written).toEqual(["a:1"]);
    expect(tally.audit.asked).toBe(1);
  });
  it("다른 모델이 없으면 사람 몫으로 남기고 호출·예약하지 않는다", async () => {
    audit(1, fresh());
    const tally = await runQwenSecondOpinions(context(), settings({ audit: true }));
    expect(state.calls).toEqual([]); expect(state.reserved).toEqual([]); expect(tally.audit.asked).toBe(0);
  });
  it("거절 모델이 다르면 기존 Qwen 동작을 유지한다", async () => {
    state.rejecting = "gpt-oss-120b";
    setAiTaskModelsForTest([rank("qwen3.8-flash-next", 1), rank("deepseek-v4.1-flash-1017", 2)]);
    audit(1, fresh());
    await runQwenSecondOpinions(context(), settings({ audit: true }));
    expect(state.calls).toEqual(["qwen3.8-flash-next"]); expect(state.reserved).toEqual(["a:1"]);
  });
});

describe("다른 모델 순위의 연결 계약", () => {
  it("OpenCode도 기존 로컬 계약·CLI revision과 인증을 유지한다", async () => {
    const next = rank("opencode-go/deepseek-v4.1-flash", 2);
    setAiTaskModelsForTest([{ ...next, options: { reasoningEffort: "high" }, connection: { ...next.connection,
      kind: "cli", cliTool: "opencode", apiKey: "fixture-only-secret-longer-than-32-chars" } }]);
    const [choice] = await rejudgeSecondOpinionModels("qwen3.8-flash-next");
    expect(choice.servingRevision).toBe("cli-engine-v1:00000000-0000-4000-8000-000000000001:high");
    expect(choice.config.baseUrl).toBe("http://fixture.invalid/v1");
    expect(choice.config.apiKey).toMatch(/^nmv-cli-engine\./);
  });
  it("같은 모델의 접두어·연결 별칭과 다른 작업의 순위를 제외한다", async () => {
    setAiTaskModelsForTest([rank("[gpu3090] qwen3.8-flash-next@abcdef12", 2),
      { ...rank("deepseek-v4.1-flash-1017", 3), task: "product-audit" }]);
    expect(await rejudgeSecondOpinionModels("qwen3.8-flash-next")).toEqual([]);
  });
});
