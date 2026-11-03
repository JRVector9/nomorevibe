import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import type { JobContext } from "@/lib/jobs/runner";

/**
 * 공개분 추가 검수(qwenAuto.publishedFilter)·감사 두 번째 의견(qwenAuto.auditSecondOpinion)의 줄 머리 막힘(2026-11-03 운영).
 * 입력 유효 기한(validUntil)이 지난 대상은 호출 직전 증명이 늘 거절한다 — 예전에는 그 거절(reservation_lost)이 틱을 멈추고 항목에 아무것도
 * 적지 않아 다음 틱에도 같은 대상이 맨 앞에 섰다(공개분 2차 행 149299 가 14시간에 866번 물림). 기한 지난 대상은 자리를 잡지 않고 넘기고,
 * 진짜 자리 경합(일시 거절)은 예전처럼 이 틱을 멈추는지 본다. DB·모델·장부는 가짜이고 runStep 의 줄 처리만 실제 코드로 돈다.
 *
 * withLocalModelCapacity 가짜는 운영 장부와 같게 군다: 입력 기한이 지난 대상은 자리를 잡은 뒤 증명에서 거절되어 ModelCapacityDeferredError
 * (reservation_lost)로 끝난다(main 의 실제 결과 — 이 PR 뒤 실제 코드는 그 하위 오류 LocalModelDomainRefusedError 를 던진다).
 */
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  auditRows: [] as Row[], publishedRows: [] as Row[], inputs: new Map<string, { validUntil: Date; inputHash: string }>(),
  observation: null as unknown, reserved: [] as string[], asked: [] as string[], written: [] as string[],
  contended: new Set<string>(), refuse: new Map<string, unknown>(), queries: [] as SQL[],
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
    return text.includes("product_audit_items") ? state.auditRows : state.publishedRows;
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
  reviewWithQwenDirect: async (input: { inputHash: string }) => {
    state.asked.push(input.inputHash);
    return { model: "qwen3.8-flash-next", promptVersion: "2026-10-21.v2", latencyMs: 1,
      outcome: { decision: "needs_review", confidence: 0.6, reason: "사람이 본다", evidenceIds: ["product"] } };
  } }));
vi.mock("@/lib/llm/local-model-capacity", () => ({
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

const { runQwenSecondOpinions, INPUT_STALE_RETRY_MS } = await import("@/lib/crawl/audit-second-opinion-auto") as
  typeof import("@/lib/crawl/audit-second-opinion-auto") & { INPUT_STALE_RETRY_MS?: number };

const HOUR = 3600_000;
const fresh = () => new Date(Date.now() + 12 * HOUR);
const stale = () => new Date(Date.now() - 7 * HOUR);
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
/** 공개분 2차 행 — 입력은 publishedInput 이 후보·문서를 읽어 만든다. 가짜 DB 는 그 읽기를 이 표로 돌려준다 */
function published(id: number, validUntil: Date) {
  state.publishedRows.push({ id, slug: `pub-${id}`, candidate_id: id + 5000 });
  state.inputs.set(`pub-${id}`, { validUntil, inputHash: `p:${id}` });
}
const failures = () => (state.observation as { failures: Record<string, { code: string; count: number; validUntil?: string }> } | null)?.failures ?? {};
/** 마지막 틱이 대상 표를 고를 때 뺀 id(skip) — 고르는 SQL 의 not in 목록 */
const skippedIds = () => {
  const query = new PgDialect().sqlToQuery(state.queries.at(-1)!);
  return query.sql.includes("not in") ? query.params.filter((value): value is number => typeof value === "number") : [];
};

beforeEach(() => {
  state.auditRows.length = 0; state.publishedRows.length = 0; state.inputs.clear(); state.observation = null;
  state.reserved.length = 0; state.asked.length = 0; state.written.length = 0; state.contended.clear(); state.refuse.clear();
  state.queries.length = 0;
});

describe("감사 두 번째 의견(local-second-opinion) — 입력 기한이 지난 대상", () => {
  it("맨 앞의 기한 지난 대상은 자리를 잡지 않고 넘기고 같은 틱에 뒤 대상을 묻는다", async () => {
    audit(78443, stale());
    audit(78444, fresh());
    audit(78445, fresh());
    const tally = await runQwenSecondOpinions(context(), settings({ audit: true }));
    expect(state.written).toEqual(["a:78444", "a:78445"]);
    // 기한 지난 대상은 장부에 자리를 잡지 않는다(withdrawn 줄을 만들지 않는다)
    expect(state.reserved).not.toContain("a:78443");
    expect(failures()["a:78443"]).toMatchObject({ code: "input_stale", count: 0 });
    expect(tally).toMatchObject({ inputStale: 1, failed: 0, audit: { asked: 2 } });
  });

  it("기한 지난 대상은 다음 틱에 고르지 않고(시도로 세지 않음) 쉬는 시간이 지나면 다시 본다", async () => {
    audit(78443, stale());
    audit(78444, fresh());
    await runQwenSecondOpinions(context(), settings({ audit: true }));
    expect(INPUT_STALE_RETRY_MS).toBeGreaterThan(0);
    await runQwenSecondOpinions(context(), settings({ audit: true }));
    expect(skippedIds()).toContain(78443);
    // 쉬는 시간이 지났다 — 다시 고른다(그 사이 원본이 다시 수집됐으면 묻는다)
    const entry = failures()["a:78443"];
    state.observation = { ...(state.observation as object), failures: { ...failures(),
      "a:78443": { ...entry, at: new Date(Date.now() - INPUT_STALE_RETRY_MS! - 1_000).toISOString() } } };
    state.inputs.set("item-78443", { validUntil: fresh(), inputHash: "a:78443" });
    await runQwenSecondOpinions(context(), settings({ audit: true }));
    expect(skippedIds()).not.toContain(78443);
    expect(state.written).toContain("a:78443");
  });

  it("진짜 자리 경합(일시 거절)은 예전처럼 이 틱을 멈추고 항목에 아무것도 적지 않는다", async () => {
    audit(1, fresh());
    audit(2, fresh());
    state.contended.add("a:1");
    const tally = await runQwenSecondOpinions(context(), settings({ audit: true }));
    expect(state.reserved).toEqual(["a:1"]);
    expect(state.written).toEqual([]);
    expect(failures()["a:1"]).toBeUndefined();
    expect(tally.failed).toBe(0);
    expect(tally.endpointError).toBeNull();
  });
});

describe("공개분 추가 검수(local-published-filter) — 입력 기한이 지난 대상", () => {
  it("2차 표 149299 의 입력 기한이 지났어도 뒤의 사람 확인 행을 같은 틱에 묻는다", async () => {
    published(146281, stale());
    published(149299, stale());
    published(150001, fresh());
    published(150002, fresh());
    const tally = await runQwenSecondOpinions(context(), settings({ published: true }));
    expect(state.written).toEqual(["p:150001", "p:150002"]);
    expect(state.reserved).toEqual(["p:150001", "p:150002"]);
    expect(failures()["p:149299"]).toMatchObject({ code: "input_stale", count: 0 });
    expect(tally).toMatchObject({ inputStale: 2, published: { asked: 2, noted: 2 } });
  });

  it("호출 직전 증명이 기한 지남으로 거절해도(기다리는 사이 지남) 그 항목만 넘기고 다음 대상으로 간다", async () => {
    const { LocalModelDomainRefusedError } = await import("@/lib/llm/local-model-domain-refusal");
    published(1, fresh());
    published(2, fresh());
    const validUntil = new Date(Date.now() - 1_000).toISOString();
    state.refuse.set("p:1", new LocalModelDomainRefusedError({ check: "input_expired", validUntil }));
    const tally = await runQwenSecondOpinions(context(), settings({ published: true }));
    expect(state.reserved).toEqual(["p:1", "p:2"]);
    expect(state.written).toEqual(["p:2"]);
    expect(failures()["p:1"]).toMatchObject({ code: "input_stale", validUntil });
    expect(tally.inputStale).toBe(1);
  });

  it("증명이 대상이 닫혔다고 거절하면 그 항목을 실패로 세고 넘기며, 단계가 꺼졌으면 멈춘다", async () => {
    const { LocalModelDomainRefusedError } = await import("@/lib/llm/local-model-domain-refusal");
    published(1, fresh());
    published(2, fresh());
    published(3, fresh());
    state.refuse.set("p:1", new LocalModelDomainRefusedError({ check: "target_not_open" }));
    state.refuse.set("p:3", new LocalModelDomainRefusedError({ check: "step_disabled" }));
    const tally = await runQwenSecondOpinions(context(), settings({ published: true }));
    expect(state.written).toEqual(["p:2"]);
    expect(failures()["p:1"]).toMatchObject({ code: "not_open", count: 1 });
    expect(failures()["p:3"]).toBeUndefined();
    expect(tally.failed).toBe(1);
  });
});
