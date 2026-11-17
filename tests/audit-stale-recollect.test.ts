import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import type { JobContext } from "@/lib/jobs/runner";
import type { RecollectDigest, RecollectFrontierView } from "@/lib/crawl/audit-stale-recollect";

/**
 * 입력 기한이 지난 감사 거절의 원본 다시 받기(2026-11-17, lib/crawl/audit-stale-recollect.ts) — 회귀 시험.
 *
 * 운영(11/17): 11/01 grok 감사(캠페인 6)의 열린 거절 538건은 원본이 8~9월에 수집돼 입력 기한(min(수집, 스캔) + 24시간)을 넘겼다.
 * 두 번째 의견이 매 틱 10건을 골라 전부 input_stale 로 끝내고, 한 시간 쉬었다 다시 골라도 원본을 다시 받는 곳이 없어 영원히 같았다(asked 0).
 *
 * 이 시험은 runStep 의 줄 처리(실제 코드)와 다시 받기 마무리의 가름(settleRecollectVerdict — 실제 코드)을 함께 돌린다. DB·모델·수집은 가짜다:
 * 가짜 수집은 requestAuditRecollect 가 부르면 원본을 다시 받을 차례로 적고, 시험이 '수집이 끝남'·'수집이 404'를 정한다.
 * 고르는 SQL 은 다시 받는 중·실패한 항목을 빼는지(auditRecollectBlocksSql)를 글자로 보고, 가짜 DB 가 같은 규칙으로 행을 거른다.
 */
type Row = Record<string, unknown>;
type Recollect = { state: "waiting" | "done" | "failed" | "dropped"; requests: number; requestedAt: number; before: RecollectDigest | null;
  failureCode?: string; failureDetail?: string; changedFields?: string[] };
const state = vi.hoisted(() => ({
  auditRows: [] as Row[], inputs: new Map<string, { validUntil: Date; inputHash: string; readme: string }>(),
  observation: null as unknown, asked: [] as string[], written: [] as string[], queries: [] as SQL[],
  recollects: new Map<number, Recollect>(), frontiers: new Map<number, NonNullable<RecollectFrontierView>>(),
  requested: [] as number[], fetchQueue: [] as number[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => {
  const where = () => ({
    then: (resolve: (rows: Row[]) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(state.observation ? [{ value: state.observation }] : []).then(resolve, reject),
    limit: async () => [],
  });
  const chain = { from: () => chain, innerJoin: () => chain, where };
  return { db: { select: () => chain, execute: async (query: SQL) => {
    state.queries.push(query);
    const text = new PgDialect().sqlToQuery(query).sql;
    if (!text.includes("product_audit_items")) return [];
    // 고르는 SQL 의 다시 받기 규칙(auditRecollectBlocksSql) — 다시 받는 중·실패·열린 거절 아님은 고르지 않는다
    return state.auditRows.filter((row) => {
      const recollect = state.recollects.get(row.item_id as number);
      return !text.includes("product_audit_recollects") || !recollect || recollect.state === "done";
    });
  } } };
});
vi.mock("@/lib/jobs/control", async (load) => ({ ...await load<typeof import("@/lib/jobs/control")>(),
  withJobLeaseWrite: async (_lease: unknown, write: (tx: unknown) => Promise<unknown>) => write({ insert: () => ({ values: (value: { value: unknown }) => ({
    onConflictDoUpdate: async () => { state.observation = structuredClone(value.value); } }) }) }) }));
vi.mock("@/lib/crawl/product-audit", async (load) => ({ ...await load<typeof import("@/lib/crawl/product-audit")>(),
  loadAuditInput: async (slug: string) => {
    const input = state.inputs.get(slug);
    return input ? { ...input, source: { documentFetchedAt: new Date().toISOString(), scanCompletedAt: null },
      snapshot: { product: { name: slug, description: "", pageText: "", readme: input.readme, url: "https://fixture.test" } } } : null;
  } }));
vi.mock("@/lib/crawl/qwen-endpoint-backoff", () => ({ qwenEndpointBackingOff: () => false, withQwenSecondarySlot: (run: () => unknown) => run(),
  noteQwenEndpointSuccess: async () => {}, noteQwenCallFailure: async () => ({ outage: false }), endpointBackoffActive: () => false,
  readQwenEndpointBackoff: async () => null }));
vi.mock("@/lib/crawl/qwen-direct-review", async (load) => ({ ...await load<typeof import("@/lib/crawl/qwen-direct-review")>(),
  qwenDirectConfig: () => ({ model: "qwen3.8-flash-next", baseUrl: "http://fixture.invalid/v1", apiKey: null }),
  reviewWithQwenDirect: async (input: { inputHash: string }) => {
    state.asked.push(input.inputHash);
    return { model: "qwen3.8-flash-next", promptVersion: "2026-10-21.v2", latencyMs: 1,
      outcome: { decision: "approve", confidence: 0.95, reason: "다시 받은 원본으로 보면 쓸 수 있다", evidenceIds: ["product"] } };
  } }));
vi.mock("@/lib/llm/local-model-capacity", () => ({
  withLocalModelCapacity: async (context: { input: { validUntil: Date } }, run: (request: typeof fetch) => Promise<unknown>) => {
    // 운영 증명: 입력 기한이 지난 대상은 거절된다 — 이 시험의 대상은 입력이 새로울 때만 여기 온다
    if (context.input.validUntil.getTime() <= Date.now()) throw new Error("input_expired_reached_capacity");
    return run(fetch);
  } }));
vi.mock("@/lib/crawl/audit-second-opinion-import", () => ({ writeAuditSecondOpinions: async (_db: unknown, rows: { itemId: number }[]) => {
  state.written.push(`a:${rows[0].itemId}`);
  return { inserted: 1, updated: 0, released: 0, skipped: {}, autoClose: null };
} }));
vi.mock("@/lib/crawl/published-second-review", () => ({ applyPublishedAutoOpinion: async () => "noted" }));
/**
 * 수집·표 쓰기만 가짜다 — 마무리의 가름(settleRecollectVerdict)·근거 해시(recollectDigest·recollectChangedFields)는 실제 코드를 쓴다.
 * 가짜 settle 은 실제 settleAuditRecollects 처럼 waiting 줄마다 loadAuditInput 으로 입력을 다시 만들어 가른다.
 */
vi.mock("@/lib/crawl/audit-stale-recollect", async (load) => {
  const actual = await load<typeof import("@/lib/crawl/audit-stale-recollect")>();
  const { loadAuditInput } = await import("@/lib/crawl/product-audit");
  return { ...actual,
    requestAuditRecollect: async (_lease: unknown, target: { itemId: number }, stale: { snapshot: { product: never } } | null) => {
      const existing = state.recollects.get(target.itemId);
      if (existing && existing.state !== "done") return { result: "skipped", reason: existing.state };
      // 이미 수집이 404 로 끝나 있었다 — GitHub 를 다시 부르지 않고 바로 사람 몫
      const frontier = state.frontiers.get(target.itemId);
      const earlier = frontier ? actual.recollectFrontierFailure(frontier) : null;
      if (earlier) {
        state.recollects.set(target.itemId, { state: "failed", requests: 0, requestedAt: Date.now(), before: null, failureCode: earlier.code,
          failureDetail: earlier.detail });
        return { result: "failed", code: earlier.code };
      }
      state.requested.push(target.itemId);
      state.fetchQueue.push(target.itemId);
      state.recollects.set(target.itemId, { state: "waiting", requests: (existing?.requests ?? 0) + 1, requestedAt: Date.now(),
        before: stale ? actual.recollectDigest(stale.snapshot.product) : null });
      return { result: "requested" };
    },
    settleAuditRecollects: async (_lease: unknown, settings: CrawlSettings, freshMarginMs: number) => {
      const settled = { done: 0, changed: 0, failed: 0, dropped: 0, waiting: 0 };
      for (const [itemId, row] of state.recollects) {
        if (row.state !== "waiting") continue;
        const input = await loadAuditInput(`item-${itemId}`, settings);
        const verdict = actual.settleRecollectVerdict({ open: true, sourceFound: Boolean(input),
          inputFresh: Boolean(input && input.validUntil.getTime() - Date.now() >= freshMarginMs), frontier: state.frontiers.get(itemId) ?? null,
          waitedMs: Date.now() - row.requestedAt, refetched: !state.fetchQueue.includes(itemId) });
        if (verdict.kind === "waiting") { settled.waiting += 1; continue; }
        if (verdict.kind === "failed") {
          state.recollects.set(itemId, { ...row, state: "failed", failureCode: verdict.code, failureDetail: verdict.detail });
          settled.failed += 1;
        } else if (verdict.kind === "done") {
          const changedFields = actual.recollectChangedFields(row.before, actual.recollectDigest(input!.snapshot.product));
          state.recollects.set(itemId, { ...row, state: "done", changedFields });
          settled.done += 1;
          if (changedFields.length) settled.changed += 1;
        }
      }
      return settled;
    } };
});

const { runQwenSecondOpinions } = await import("@/lib/crawl/audit-second-opinion-auto");
const recollect = await import("@/lib/crawl/audit-stale-recollect");
const { AUDIT_RECOLLECT_MAX_WAITING, AUDIT_RECOLLECT_README_WAIT_MS, AUDIT_RECOLLECT_WAIT_MS, auditRecollectBlocksSql, auditRecollectScanDemand, recollectChangedFields,
  recollectDigest, settleRecollectVerdict } = recollect;

const HOUR = 3600_000;
const fresh = () => new Date(Date.now() + 12 * HOUR);
/** 11/01 grok 감사가 본 원본 — 8~9월 수집, 스캔 10월 */
const stale = () => new Date(Date.now() - 50 * 24 * HOUR);
function settings(recollectPerTick: number, perTick = 10): CrawlSettings {
  return { ...DEFAULT_CRAWL_SETTINGS, enabled: true, qwenAuto: { ...DEFAULT_CRAWL_SETTINGS.qwenAuto,
    auditSecondOpinion: { enabled: true, perTick, scope: "all", autoClose: false, recollectPerTick },
    publishedFilter: { enabled: false, perTick: 10 } } };
}
function context(): JobContext<null> {
  return { cursor: null, save: async () => {}, hasBudget: () => true, deadlineAt: Date.now() + 70_000, log: () => {},
    lease: { name: "audit-second-opinion", token: randomUUID(), requestedVersion: 1 } };
}
function audit(itemId: number, validUntil: Date, readme = "옛 README") {
  const slug = `item-${itemId}`;
  state.auditRows.push({ item_id: itemId, product_id: itemId + 1000, slug });
  state.inputs.set(slug, { validUntil, inputHash: `a:${itemId}`, readme });
}
/** 기존 수집 길이 원본·스캔을 다시 받았다(crawl-fetch → saveFetchedDocument, 스캔 claim) — 입력이 새로워진다 */
function collected(itemId: number, readme?: string) {
  const input = state.inputs.get(`item-${itemId}`)!;
  state.inputs.set(`item-${itemId}`, { ...input, validUntil: fresh(), readme: readme ?? input.readme });
  state.fetchQueue.splice(state.fetchQueue.indexOf(itemId), 1);
  state.frontiers.set(itemId, { state: "done", lastError: null, aliasOf: null, updatedAfterRequest: true });
}
const failures = () => (state.observation as { failures: Record<string, { code: string }> } | null)?.failures ?? {};
const selectSql = () => new PgDialect().sqlToQuery(state.queries.find((query) =>
  new PgDialect().sqlToQuery(query).sql.includes("product_audit_items"))!).sql;

beforeEach(() => {
  state.auditRows.length = 0; state.inputs.clear(); state.observation = null; state.asked.length = 0; state.written.length = 0;
  state.queries.length = 0; state.recollects.clear(); state.frontiers.clear(); state.requested.length = 0; state.fetchQueue.length = 0;
});

describe("input_stale → 원본 다시 받기 → 두 번째 의견", () => {
  it("기한 지난 감사 거절은 실패로 쉬지 않고 원본을 다시 받게 하며, 다시 받는 동안은 고르지 않는다", async () => {
    audit(78443, stale());
    const tally = await runQwenSecondOpinions(context(), settings(2));
    expect(state.requested).toEqual([78443]);
    expect(state.recollects.get(78443)).toMatchObject({ state: "waiting", requests: 1 });
    // 예전의 '한 시간 쉬기(input_stale)'로 남기지 않는다 — 실패로 반복하지 않는다
    expect(failures()["a:78443"]).toBeUndefined();
    expect(state.asked).toEqual([]);
    expect(tally.audit).toMatchObject({ asked: 0, recollectRequested: 1 });
    // 고르는 SQL 은 다시 받는 중·실패한 항목을 뺀다
    expect(selectSql()).toContain("product_audit_recollects");
    // 다음 틱 — 아직 다시 받는 중이라 고르지도, 다시 요청하지도 않는다
    state.queries.length = 0;
    const again = await runQwenSecondOpinions(context(), settings(2));
    expect(state.requested).toEqual([78443]);
    expect(again.audit).toMatchObject({ asked: 0, recollectRequested: 0 });
  });

  it("수집이 원본을 다시 받으면 다음 틱 앞머리에서 끝남으로 적고 같은 틱에 새 입력으로 두 번째 의견을 묻는다", async () => {
    audit(78443, stale(), "옛 README — 설치 안내만");
    await runQwenSecondOpinions(context(), settings(2));
    collected(78443, "새 README — 브라우저에서 바로 쓰는 앱");
    const tally = await runQwenSecondOpinions(context(), settings(2));
    expect(state.recollects.get(78443)).toMatchObject({ state: "done", changedFields: ["readme"] });
    expect(state.asked).toEqual(["a:78443"]);
    expect(state.written).toEqual(["a:78443"]);
    expect(tally.audit).toMatchObject({ asked: 1, recollectDone: 1, recollectChanged: 1 });
  });

  it("다시 받은 원본이 감사 때와 같으면 근거가 바뀌지 않은 것으로 적는다", async () => {
    audit(5, stale());
    await runQwenSecondOpinions(context(), settings(1));
    collected(5);
    const tally = await runQwenSecondOpinions(context(), settings(1));
    expect(state.recollects.get(5)).toMatchObject({ state: "done", changedFields: [] });
    expect(tally.audit).toMatchObject({ recollectDone: 1, recollectChanged: 0, asked: 1 });
  });
});

describe("다시 받기 실패 → 사람 몫", () => {
  it("요청 뒤 저장소가 404 로 끝나면 사유를 남겨 실패로 두고 다시 고르지도 다시 요청하지도 않는다", async () => {
    audit(9, stale());
    await runQwenSecondOpinions(context(), settings(1));
    state.frontiers.set(9, { state: "skipped", lastError: "github_not_found", aliasOf: null, updatedAfterRequest: true });
    const tally = await runQwenSecondOpinions(context(), settings(1));
    expect(state.recollects.get(9)).toMatchObject({ state: "failed", failureCode: "repo_deleted" });
    expect(state.recollects.get(9)!.failureDetail).toContain("404");
    expect(tally.audit).toMatchObject({ recollectFailed: 1, asked: 0 });
    for (let tick = 0; tick < 3; tick += 1) await runQwenSecondOpinions(context(), settings(1));
    expect(state.requested).toEqual([9]);
    expect(state.asked).toEqual([]);
  });

  it("이전 수집이 이미 실패로 끝나 있었으면 GitHub 를 다시 부르지 않고 바로 사람 몫으로 적는다", async () => {
    audit(10, stale());
    state.frontiers.set(10, { state: "failed", lastError: "GitHub 500", aliasOf: null, updatedAfterRequest: true });
    const tally = await runQwenSecondOpinions(context(), settings(1));
    expect(state.requested).toEqual([]);
    expect(state.recollects.get(10)).toMatchObject({ state: "failed", failureCode: "source_refresh_failed" });
    expect(tally.audit).toMatchObject({ recollectRejected: 1, recollectRequested: 0 });
  });
});

describe("틱당 상한", () => {
  it("한 틱에 recollectPerTick 건까지만 요청하고 나머지는 예전처럼 한 시간 쉰다(줄 머리를 막지 않는다)", async () => {
    for (const id of [1, 2, 3, 4, 5]) audit(id, stale());
    audit(6, fresh());
    const tally = await runQwenSecondOpinions(context(), settings(2));
    expect(state.requested).toEqual([1, 2]);
    expect(Object.keys(failures()).sort()).toEqual(["a:3", "a:4", "a:5"]);
    expect(failures()["a:3"]).toMatchObject({ code: "input_stale" });
    // 새로운 입력의 대상은 같은 틱에 묻는다
    expect(state.written).toEqual(["a:6"]);
    expect(tally.audit).toMatchObject({ recollectRequested: 2, asked: 1 });
  });

  it("다시 받는 중인 것이 AUDIT_RECOLLECT_MAX_WAITING 에 닿으면 틱당 상한이 남아도 새로 요청하지 않는다", async () => {
    for (let id = 100; id < 100 + AUDIT_RECOLLECT_MAX_WAITING - 1; id += 1) {
      state.recollects.set(id, { state: "waiting", requests: 1, requestedAt: Date.now(), before: null });
      state.inputs.set(`item-${id}`, { validUntil: stale(), inputHash: `a:${id}`, readme: "" });
      state.fetchQueue.push(id);
    }
    for (const id of [1, 2, 3]) audit(id, stale());
    const tally = await runQwenSecondOpinions(context(), settings(5));
    expect(state.requested).toEqual([1]);
    expect(tally.audit.recollectRequested).toBe(1);
  });

  it("recollectPerTick 0 이면 새로 요청하지 않는다(예전의 쉬기)", async () => {
    audit(1, stale());
    const tally = await runQwenSecondOpinions(context(), settings(0));
    expect(state.requested).toEqual([]);
    expect(failures()["a:1"]).toMatchObject({ code: "input_stale" });
    expect(tally).toMatchObject({ inputStale: 1, audit: { recollectRequested: 0 } });
  });
});

describe("마무리의 가름(settleRecollectVerdict)", () => {
  const base = { open: true, sourceFound: true, inputFresh: false, frontier: null, waitedMs: 1_000, refetched: false };
  it("차례: 열린 거절 아님 → 원본 없음 → 입력 새로워짐 → 수집 실패 → 시간 넘김 → 기다림", () => {
    expect(settleRecollectVerdict({ ...base, open: false, inputFresh: true })).toEqual({ kind: "dropped" });
    expect(settleRecollectVerdict({ ...base, sourceFound: false })).toMatchObject({ kind: "failed", code: "no_source" });
    expect(settleRecollectVerdict({ ...base, inputFresh: true,
      frontier: { state: "failed", lastError: "x", aliasOf: null, updatedAfterRequest: true } })).toEqual({ kind: "done" });
    expect(settleRecollectVerdict({ ...base, frontier: { state: "skipped", lastError: "github_empty_repository", aliasOf: null, updatedAfterRequest: true } }))
      .toMatchObject({ kind: "failed", code: "repo_empty" });
    expect(settleRecollectVerdict({ ...base, frontier: { state: "skipped", lastError: null, aliasOf: "owner/new-name", updatedAfterRequest: false } }))
      .toMatchObject({ kind: "failed", code: "repo_renamed" });
    // 요청 전의 실패(요청 뒤에 갱신되지 않은 수집 행)는 이번 다시 받기의 결과가 아니다
    expect(settleRecollectVerdict({ ...base, frontier: { state: "failed", lastError: "old", aliasOf: null, updatedAfterRequest: false } }))
      .toEqual({ kind: "waiting" });
    expect(settleRecollectVerdict({ ...base, waitedMs: AUDIT_RECOLLECT_WAIT_MS + 1, refetched: true }))
      .toMatchObject({ kind: "failed", code: "recollect_timeout", detail: expect.stringContaining("스캔") });
    expect(settleRecollectVerdict(base)).toEqual({ kind: "waiting" });
  });

  it("입력이 새로워져도 README 잡이 README 를 다시 받는 중이면 기다리고, 정한 시간을 넘기면 옮겨 둔 README 로 끝낸다", () => {
    expect(settleRecollectVerdict({ ...base, inputFresh: true, refetched: true, readmePending: true })).toEqual({ kind: "waiting" });
    expect(settleRecollectVerdict({ ...base, inputFresh: true, refetched: true, readmePending: true, waitedMs: AUDIT_RECOLLECT_README_WAIT_MS + 1 }))
      .toEqual({ kind: "done" });
    expect(settleRecollectVerdict({ ...base, inputFresh: true, refetched: true, readmePending: false })).toEqual({ kind: "done" });
  });
});

describe("근거 바뀜 기록(recollectDigest)", () => {
  it("칸마다의 해시로 바뀐 칸만 고른다 — 내용은 남기지 않는다", () => {
    const product = { repo: "o/r", name: "앱", description: "소개", pageText: "본문", url: "https://a.test", accessMode: "website",
      repositoryUrl: "https://github.com/o/r", topics: [], language: null, readme: "README", linksOwnGithub: false } as never;
    const before = recollectDigest(product);
    expect(Object.values(before).every((value) => /^[a-f0-9]{16}$/.test(value))).toBe(true);
    expect(recollectChangedFields(before, recollectDigest({ ...(product as object), pageText: "새 본문", readme: "새 README" } as never)))
      .toEqual(["pageText", "readme"]);
    expect(recollectChangedFields(before, recollectDigest(product))).toEqual([]);
    expect(recollectChangedFields(null, before)).toEqual([]);
  });
});

describe("수집 길 재사용 — 스캔 수요와 고르는 규칙", () => {
  it("스캔 줄 채우기의 수요는 다시 받는 중이고 마지막 스캔이 끝난 지 23시간 넘은 저장소다", () => {
    const text = new PgDialect().sqlToQuery(auditRecollectScanDemand()).sql;
    expect(text).toContain("product_audit_recollects");
    expect(text).toContain("recollect.state = 'waiting'");
    expect(text).toContain("latest.completed_at IS NOT NULL");
  });

  it("두 번째 의견은 끝남(done)이 아닌 다시 받기 줄이 있는 항목을 고르지 않는다", () => {
    const text = new PgDialect().sqlToQuery(auditRecollectBlocksSql()).sql;
    expect(text).toMatch(/not exists \(select 1 from "product_audit_recollects" recollect where recollect\.item_id = i\.id and recollect\.state <> 'done'\)/);
  });
});
