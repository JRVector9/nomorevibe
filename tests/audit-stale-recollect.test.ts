import { createHash, randomUUID } from "node:crypto";
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
  /** 감사 입력을 읽을 때의 선택(프로젝트 활동 묶음)·물을 때의 글 판 */
  loadOptions: [] as unknown[], promptVersions: [] as (string | undefined)[],
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
  loadAuditInput: async (slug: string, _settings: unknown, options?: unknown) => {
    state.loadOptions.push(options);
    const input = state.inputs.get(slug);
    return input ? { ...input, source: { documentFetchedAt: new Date().toISOString(), scanCompletedAt: null },
      snapshot: { product: { name: slug, description: "", pageText: "", readme: input.readme, url: "https://fixture.test" } } } : null;
  } }));
vi.mock("@/lib/crawl/qwen-endpoint-backoff", () => ({ qwenEndpointBackingOff: () => false, withQwenSecondarySlot: (run: () => unknown) => run(),
  noteQwenEndpointSuccess: async () => {}, noteQwenCallFailure: async () => ({ outage: false }), endpointBackoffActive: () => false,
  readQwenEndpointBackoff: async () => null }));
vi.mock("@/lib/crawl/qwen-direct-review", async (load) => ({ ...await load<typeof import("@/lib/crawl/qwen-direct-review")>(),
  qwenDirectConfig: () => ({ model: "qwen3.8-flash-next", baseUrl: "http://fixture.invalid/v1", apiKey: null }),
  reviewWithQwenDirect: async (input: { inputHash: string }, options?: { promptVersion?: string }) => {
    state.asked.push(input.inputHash);
    state.promptVersions.push(options?.promptVersion);
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
  state.loadOptions.length = 0; state.promptVersions.length = 0;
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
      .toMatchObject({ kind: "failed", code: "refetch_not_received_48h", detail: expect.stringContaining("스캔") });
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

// ─────────────────────────── 사람 추가 지시(2026-11-17): "기간 상관없이 다시 살펴보고 진행중인 프로젝트인지 보게" ───────────────────────────

const activityModule = await import("@/lib/crawl/audit-project-activity");
const { attachProjectActivity, projectActivityFrom, recollectChangeSummary } = activityModule;
const { auditRecollectLine, AUDIT_RECOLLECT_FAILURE_SHORT } = await import("@/lib/crawl/audit-recollect-view");
const contract = await import("@/lib/crawl/agent-review-contract");
const { auditSourceHash } = await import("@/lib/crawl/product-audit");
const { auditOpinionWanted, promptFor } = await import("@/lib/crawl/audit-second-opinion-auto");
const qwen = await vi.importActual<typeof import("@/lib/crawl/qwen-direct-review")>("@/lib/crawl/qwen-direct-review");
const DAY = 24 * HOUR;

/** 감사가 본 공개 제품의 수집 원본(맞춤 값만 바꾼다) */
function fixture(overrides: { fetchedAt?: Date; scanCompletedAt?: Date; pageStatus?: number | null; finalUrl?: string; pushedAt?: string;
  archived?: boolean } = {}) {
  const fetchedAt = overrides.fetchedAt ?? new Date(Date.now() - HOUR);
  const candidate = { id: 7, repo: "owner/app", productUrl: "https://app.example", state: "published", decidedBy: "auto", publishedSlug: "app",
    judgedAt: new Date("2026-08-29T00:00:00Z"), updatedAt: fetchedAt } as never;
  const document = { id: 9, repo: "owner/app", productUrl: "https://app.example", fetchedAt, pageStatus: overrides.pageStatus === undefined ? 200 : overrides.pageStatus,
    repoMeta: { description: "A useful service", topics: ["productivity"], stargazers_count: 12, archived: overrides.archived ?? false,
      pushed_at: overrides.pushedAt ?? "2026-09-02T10:00:00Z", created_at: "2025-01-01T00:00:00Z" },
    pageMeta: { title: "App", description: "A useful service", textSample: "Sign up and start using App today.", readmeSample: "App README",
      ...(overrides.finalUrl ? { finalUrl: overrides.finalUrl } : {}) } } as never;
  const scan = { id: 3, startedAt: fetchedAt, completedAt: overrides.scanCompletedAt ?? fetchedAt, state: "complete",
    detectorVersion: DEFAULT_CRAWL_SETTINGS.agentEvidence.detectorVersion, lastErrorCode: null, commitSha: "a".repeat(40) } as never;
  return { candidate, document, scan };
}
function auditInput(overrides: Parameters<typeof fixture>[0] = {}, now = new Date()) {
  const { candidate, document, scan } = fixture(overrides);
  return contract.createReviewInput(candidate, document, DEFAULT_CRAWL_SETTINGS, { scan, observations: [] }, now);
}

describe("1. 나이 기준 없음 — 근거가 오래됐다는 것만으로 사람 몫(failed)이 되지 않는다", () => {
  it("근거가 50일·400일·5년 묵었어도 실패로 쉬지 않고 다시 받게 하고, 받으면 묻는다", async () => {
    for (const [itemId, ageDays] of [[1, 50], [2, 400], [3, 5 * 365]] as const) {
      audit(itemId, new Date(Date.now() - ageDays * DAY + 24 * HOUR));
    }
    const first = await runQwenSecondOpinions(context(), settings(3));
    expect(first.audit).toMatchObject({ recollectRequested: 3, recollectRejected: 0, recollectFailed: 0 });
    expect([...state.recollects.values()].every((row) => row.state === "waiting")).toBe(true);
    for (const itemId of [1, 2, 3]) collected(itemId);
    const second = await runQwenSecondOpinions(context(), settings(3));
    expect(second.audit).toMatchObject({ recollectDone: 3, recollectFailed: 0, asked: 3 });
    expect(state.asked.sort()).toEqual(["a:1", "a:2", "a:3"]);
  });

  it("마무리의 가름은 근거 나이를 받지 않는다 — 시간은 다시 받기 요청부터만 잰다", () => {
    const base = { open: true, sourceFound: true, frontier: null, refetched: true };
    // 입력이 다시 새로워졌으면 요청 뒤 몇 시간이 지났든 끝남, 아직이면 48시간까지 기다림 — 근거가 몇 년 묵었는지는 입력에 없다
    expect(settleRecollectVerdict({ ...base, inputFresh: true, waitedMs: 47 * HOUR })).toEqual({ kind: "done" });
    expect(settleRecollectVerdict({ ...base, inputFresh: false, waitedMs: 47 * HOUR })).toEqual({ kind: "waiting" });
    expect(AUDIT_RECOLLECT_WAIT_MS).toBe(48 * HOUR);
  });

  it("사람 몫 사유는 모두 '다시 받지 못해서'다 — 나이·오래됨을 이름으로 가진 사유가 없고 시간 사유의 글은 나이 때문이 아님을 적는다", () => {
    const codes = Object.keys(recollect.AUDIT_RECOLLECT_FAILURE_LABELS).sort();
    expect(codes).toEqual(["input_error", "no_source", "refetch_expired_before_ask", "refetch_not_received_48h", "repo_deleted", "repo_empty",
      "repo_renamed", "source_refresh_failed"]);
    expect(codes.some((code) => /stale|age|old|timeout|repeated/.test(code))).toBe(false);
    expect(Object.keys(AUDIT_RECOLLECT_FAILURE_SHORT).sort()).toEqual(codes);
    for (const code of ["refetch_not_received_48h", "refetch_expired_before_ask"] as const) {
      expect(recollect.AUDIT_RECOLLECT_FAILURE_LABELS[code]).toContain("근거 나이 때문이 아닙니다");
    }
    expect(auditRecollectLine({ state: "failed", failureCode: "refetch_not_received_48h", summary: null, sourceChanged: null,
      requestedOn: "2026-11-17", settledOn: "2026-11-19" })).toEqual({ label: "다시 받지 못함", warn: true,
      text: "48시간 안에 못 받음 — 사람 몫(근거 나이 때문이 아니라 다시 받지 못해서)" });
  });

  it("두 번째 의견을 고르는 SQL 에 근거 나이 조건(수집·스캔 시각)이 없다", () => {
    const text = new PgDialect().sqlToQuery(auditOpinionWanted("all", { minConfidence: 0.9 }, "qwen3.8-flash-next", [])).sql;
    expect(text).not.toMatch(/fetched_at|completed_at|reviewed_at|interval/);
    const hold = new PgDialect().sqlToQuery(auditOpinionWanted("hold", { minConfidence: 0.9 }, "qwen3.8-flash-next", [])).sql;
    expect(hold).not.toMatch(/fetched_at|completed_at/);
  });
});

describe("2. 프로젝트 활동 근거 — 두 번째 의견 입력의 projectActivity", () => {
  it("이미 받은 값(저장소 메타·수집 응답·리다이렉트·연결 확인·릴리스)으로 묶음을 만든다 — 관측 시각은 싣지 않는다", () => {
    const { document } = fixture({ pageStatus: 200, finalUrl: "https://www.app.example/home", pushedAt: "2026-11-10T08:00:00Z", archived: true });
    const activity = projectActivityFrom({ document, release: { title: "v1.2.0", publishedAt: "2026-11-03T00:00:00Z" },
      health: { status: 200, failures: 0 } });
    expect(activity).toEqual({ archived: true, lastPushAt: "2026-11-10", latestRelease: { name: "v1.2.0", publishedAt: "2026-11-03" },
      site: { status: 200, finalUrl: "https://www.app.example/home", uptimeStatus: 200, uptimeDown: false } });
    // 연 주소와 같은 끝 주소는 리다이렉트가 아니다, 연속 3번 실패면 내려감, 기록이 없으면 null
    const same = projectActivityFrom({ document: fixture({ finalUrl: "https://APP.example/" }).document, release: null, health: { status: 0, failures: 3 } });
    expect(same.site).toEqual({ status: 200, finalUrl: null, uptimeStatus: 0, uptimeDown: true });
    expect(projectActivityFrom({ document: fixture({ pageStatus: null }).document, release: null, health: null }).site)
      .toEqual({ status: null, finalUrl: null, uptimeStatus: null, uptimeDown: null });
    expect(JSON.stringify(activity)).not.toMatch(/fetchedAt|checkedAt|observedAt/);
  });

  it("묶음은 product 밖에 실린다 — 원본 해시(auditSourceHash)는 그대로, 입력 해시는 같은 셈(reviewInputHash)으로 바뀐다", () => {
    const input = auditInput();
    const activity = projectActivityFrom({ document: fixture().document, release: null, health: { status: 200, failures: 0 } });
    const withActivity = attachProjectActivity(input, activity);
    expect(withActivity.snapshot.projectActivity).toEqual(activity);
    expect(withActivity.snapshot.product).toEqual(input.snapshot.product);
    expect(auditSourceHash(withActivity)).toBe(auditSourceHash(input));
    expect(withActivity.inputHash).not.toBe(input.inputHash);
    expect(withActivity.inputHash).toBe(contract.reviewInputHash(withActivity.snapshot, input.policyHash));
    // 묶음이 없는 입력(1차·2차·감사 본심사)의 해시는 예전 셈 그대로다
    expect(contract.reviewInputHash(input.snapshot, input.policyHash)).toBe(input.inputHash);
    expect(withActivity.validUntil).toEqual(input.validUntil);
    expect(withActivity.sourceRevisionHash).toBe(input.sourceRevisionHash);
    expect(input.snapshot).not.toHaveProperty("projectActivity");
  });

  it("두 번째 의견은 감사 거절의 입력을 활동 묶음과 함께 읽는다", async () => {
    audit(11, fresh());
    await runQwenSecondOpinions(context(), settings(1));
    expect(state.asked).toEqual(["a:11"]);
    expect(state.loadOptions).toContainEqual({ projectActivity: true });
  });
});

describe("3. 감사 때와 지금 차이 — 사람이 읽는 요약", () => {
  const before = projectActivityFrom({ document: fixture({ pageStatus: 404, pushedAt: "2026-09-02T00:00:00Z", archived: false }).document,
    release: null, health: { status: 404, failures: 5 } });
  const after = projectActivityFrom({ document: fixture({ pageStatus: 200, pushedAt: "2026-11-10T00:00:00Z", archived: true,
    finalUrl: "https://app.example/start" }).document, release: { title: "v2.0", publishedAt: "2026-11-03T00:00:00Z" }, health: { status: 200, failures: 0 } });

  it("사이트 응답·리다이렉트·마지막 push·보관·새 릴리스·바뀐 칸을 짧은 글로 적는다", () => {
    expect(recollectChangeSummary(before, after, ["pageText", "readme"])).toEqual([
      "사이트 404 → 200", "리다이렉트 → app.example/start", "마지막 push 9/02 → 11/10", "보관 아님 → 보관됨(archived)", "새 릴리스 v2.0 (2026/11/03)",
      "페이지 본문·README 바뀜"]);
    expect(recollectChangeSummary(before, before, [])).toEqual([]);
    // 해가 다르면 해를 붙인다, 닿지 않음은 0 대신 말로
    const old = projectActivityFrom({ document: fixture({ pageStatus: 0, pushedAt: "2024-03-05T00:00:00Z" }).document, release: null, health: null });
    expect(recollectChangeSummary(old, after, [])).toContain("마지막 push 2024/3/05 → 2026/11/10");
    expect(recollectChangeSummary(old, after, [])).toContain("사이트 닿지 않음 → 200");
    // 옛 줄(활동 없음)은 칸 이름만
    expect(recollectChangeSummary(null, after, ["name"])).toEqual(["이름 바뀜"]);
  });

  it("감사 화면 한 줄 — 끝남은 '감사 때 → 지금' 차이, 바뀐 것이 없으면 그렇게, 받는 중은 요청한 날, 사람이 정한 것은 없음", () => {
    const view = { failureCode: null, sourceChanged: true, requestedOn: "2026-11-17", settledOn: "2026-11-18" };
    expect(auditRecollectLine({ ...view, state: "done", summary: ["사이트 404 → 200", "마지막 push 9/02 → 11/10"] }))
      .toEqual({ label: "감사 때 → 지금", text: "사이트 404 → 200 · 마지막 push 9/02 → 11/10", warn: false });
    expect(auditRecollectLine({ ...view, state: "done", summary: [] })?.text).toBe("바뀐 것 없음(11/18 다시 받아 확인)");
    expect(auditRecollectLine({ ...view, state: "waiting", summary: null, settledOn: null })?.label).toBe("원본 다시 받는 중");
    expect(auditRecollectLine({ ...view, state: "dropped", summary: null })).toBeNull();
    expect(auditRecollectLine(null)).toBeNull();
  });
});

describe("4. 오래됨 편향 방지 — 감사 두 번째 의견 전용 글", () => {
  it("v2 덧붙임은 한 바이트도 그대로이고, 감사 전용 판은 그 뒤 메모 두 줄만 더한다(고정 sha)", () => {
    expect(createHash("sha256").update(qwen.QWEN_V2_ADDENDUM).digest("hex")).toBe(qwen.QWEN_V2_ADDENDUM_SHA256);
    expect(qwen.QWEN_V2_PROMPT_VERSION).toBe("2026-10-21.v2");
    expect(createHash("sha256").update(qwen.QWEN_V2_AUDIT_ADDENDUM).digest("hex")).toBe(qwen.QWEN_V2_AUDIT_ADDENDUM_SHA256);
    const returnLine = "Return one JSON object with decision, reason, evidenceIds, confidence.";
    expect(qwen.QWEN_V2_AUDIT_ADDENDUM).toBe(qwen.QWEN_V2_ADDENDUM.replace(returnLine, `${qwen.QWEN_AUDIT_RECHECK_NOTES}${returnLine}`));
    expect(qwen.QWEN_AUDIT_RECHECK_NOTES).toContain("Age is not a reason");
    expect(qwen.QWEN_AUDIT_RECHECK_NOTES).toContain("stays eligible even if development has stopped or the repository is archived");
    expect(qwen.QWEN_AUDIT_RECHECK_NOTES).toContain("cite it as product");
    // 감사 전용 판은 v2 자동 의견과 같은 출처·같은 기록 모델 이름이다 — 같은 (항목, 모델) 한 줄, 같은 답으로 닫기
    expect(qwen.qwenPromptConfig(qwen.QWEN_V2_AUDIT_PROMPT_VERSION)).toMatchObject({ source: qwen.QWEN_V2_AUTO_SOURCE, modelSuffix: "" });
    expect(qwen.AUDIT_OPINION_PROMPT_VERSIONS).toEqual([qwen.QWEN_V2_PROMPT_VERSION, qwen.QWEN_V2_AUDIT_PROMPT_VERSION]);
  });

  it("감사 거절만 감사 전용 판으로 묻고 공개분 2차는 v2 그대로다 — 이미 받은 v2 감사 의견은 끝난 것으로 센다", async () => {
    expect(promptFor({ kind: "audit" })).toBe(qwen.QWEN_V2_AUDIT_PROMPT_VERSION);
    expect(promptFor({ kind: "published" })).toBe(qwen.QWEN_V2_PROMPT_VERSION);
    audit(21, fresh());
    await runQwenSecondOpinions(context(), settings(1));
    expect(state.promptVersions).toEqual([qwen.QWEN_V2_AUDIT_PROMPT_VERSION]);
    const text = new PgDialect().sqlToQuery(auditOpinionWanted("all", { minConfidence: 0.9 }, "m", [])).sql;
    expect(text).toMatch(/o\.prompt_version in \(\$\d+, \$\d+\)/);
  });

  it("오래됨만 다른 같은 원본은 같은 판정 입력(입력 해시·보내는 글)과 같은 결과를 낸다", async () => {
    const now = new Date();
    // 같은 원본을 1시간 전·20시간 전에 받았고 스캔도 다른 때 끝났다(둘 다 24시간 안 — 물을 수 있다). 연결 확인도 다른 때 했다
    const recent = fixture({ fetchedAt: new Date(now.getTime() - HOUR), scanCompletedAt: new Date(now.getTime() - 2 * HOUR) });
    const older = fixture({ fetchedAt: new Date(now.getTime() - 20 * HOUR), scanCompletedAt: new Date(now.getTime() - 23 * HOUR) });
    const build = (source: typeof recent) => attachProjectActivity(
      contract.createReviewInput(source.candidate, source.document, DEFAULT_CRAWL_SETTINGS, { scan: source.scan, observations: [] }, now),
      projectActivityFrom({ document: source.document, release: { title: "v1", publishedAt: "2026-06-01T00:00:00Z" }, health: { status: 200, failures: 0 } }));
    const a = build(recent), b = build(older);
    expect(a.validUntil.getTime()).not.toBe(b.validUntil.getTime());
    expect(a.sourceRevisionHash).not.toBe(b.sourceRevisionHash);
    expect(b.snapshot).toEqual(a.snapshot);
    expect(b.inputHash).toBe(a.inputHash);
    // 실제 Qwen 직접 호출 길(reviewWithQwenDirect → reviewWithGateway)로 보내는 글을 잡는다 — 가짜 모델은 받은 글로만 정한다
    const wires: string[] = [];
    const model = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = String(init?.body);
      wires.push(body);
      const decision = createHash("sha256").update(body).digest()[0] % 2 ? "approve" : "reject";
      return new Response(JSON.stringify({ model: qwen.QWEN_DIRECT_DEFAULT_MODEL, choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        decision, reason: "지금 근거로 판단", evidenceIds: ["product"], confidence: 0.9 }) } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const ask = (input: typeof a) => qwen.reviewWithQwenDirect(input, { request: model, env: {}, promptVersion: qwen.QWEN_V2_AUDIT_PROMPT_VERSION });
    const [first, second] = [await ask(a), await ask(b)];
    expect(wires).toHaveLength(2);
    expect(wires[1]).toBe(wires[0]);
    expect(wires[0]).toContain("Age is not a reason");
    expect(wires[0]).toContain("projectActivity");
    expect(second.outcome).toEqual(first.outcome);
    // 의견 행에 적는 판정 입력 해시는 input.inputHash 다(writeAudit) — 위에서 같음을 봤다. review.inputHash 는 v2 밖의 판에서 원본 위치(source)까지
    // 묶은 캐시 열쇠라 받은 때가 다르면 다르다(판정 입력이 아니다)
    expect(second.promptVersion).toBe(qwen.QWEN_V2_AUDIT_PROMPT_VERSION);
  });
});
