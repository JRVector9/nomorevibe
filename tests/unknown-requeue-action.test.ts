import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 「다시 대기열」 서버 동작(requeueUnknownReviews) — 2026-11-09 LLM 운영 행의 「미확정 있음」이 그 연결(장비)·CLI 도구 범위로 같은 동작을 부른다.
 * 범위는 하나만 받고, 작업 로그는 늘 model-capacity-unknown-requeued 한 줄이며, 결과는 N건 다시 넣음 · M건 닫음 · K건 남음(까닭)으로 돌아간다.
 */
const mocks = vi.hoisted(() => ({ admin: vi.fn(), insert: vi.fn(), values: vi.fn(), audit: vi.fn(), requeue: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/db", () => ({ db: { insert: mocks.insert } }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ runWebWrite: (fn: () => unknown) => fn(), webWriteAction: (fn: unknown) => fn }));
vi.mock("@/lib/operations/admin-log", () => ({ adminAuditRow: mocks.audit }));
vi.mock("@/lib/llm/capacity-repository", () => ({ closeModelCapacityUnknownReview: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/operations/model-capacity-requeue", async original => ({ ...await original<object>(), requeueModelCapacityUnknowns: mocks.requeue }));

import { requeueUnknownReviews } from "@/app/(operator)/admin/models/unknown-review-actions";

const form = (values: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(values)) data.set(key, value); return data; };
const result = { closed: 3, leftRows: [{ requestId: "7e2c1a90-0000-4000-8000-000000000009", routeId: "local-human-deepseek", reason: "unsupported_route" }], groups: [
  { routeId: "reason-translate", requests: 2, requeued: 2, done: 0, skipped: 0, closed: 2, left: [], error: null },
  { routeId: "crawl-agent-review", requests: 1, requeued: 0, done: 1, skipped: 0, closed: 1, left: [], error: null },
  { routeId: "local-human-deepseek", requests: 1, requeued: 0, done: 0, skipped: 1, closed: 0, left: [{ reason: "unsupported_route", count: 1 }], error: null }] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ login: "jr" });
  mocks.insert.mockReturnValue({ values: mocks.values });
  mocks.values.mockResolvedValue(undefined);
  mocks.audit.mockImplementation(async (actor: string, row: object) => ({ actor, ...row }));
  mocks.requeue.mockResolvedValue(result);
});

describe("requeueUnknownReviews — 범위 하나 · 같은 작업 로그 · 결과 한 줄", () => {
  it("LLM 운영 연결 행(groupId)은 그 장비의 미확정만 넣고, 남은 행의 까닭을 결과와 작업 로그에 싣는다", async () => {
    const state = await requeueUnknownReviews(null, form({ groupId: "m1-gemma" }));
    expect(mocks.requeue).toHaveBeenCalledWith({ routeId: undefined, groupId: "m1-gemma", provider: undefined, operator: "jr", note: "운영자 다시 대기열에 넣기", limit: 500 });
    expect(state).toEqual({ ok: true, groups: 3, requests: 4, requeued: 2, done: 1, closed: 3, left: 1, reasons: [{ reason: "unsupported_route", count: 1 }] });
    expect(mocks.audit).toHaveBeenCalledWith("jr", expect.objectContaining({ action: "model-capacity-unknown-requeued", target: "device:m1-gemma", ok: true, error: null,
      detail: expect.objectContaining({ groupId: "m1-gemma", provider: null, routeId: null, requeued: 2, left: 1, leftRows: result.leftRows }) }));
    expect(mocks.values).toHaveBeenCalledTimes(1);
  });
  it("CLI 도구 행(provider)·단계(routeId)·전부를 가르고, 범위를 둘 넘기면 아무것도 하지 않는다", async () => {
    await requeueUnknownReviews(null, form({ provider: "codex-cli" }));
    expect(mocks.audit).toHaveBeenLastCalledWith("jr", expect.objectContaining({ target: "provider:codex-cli" }));
    await requeueUnknownReviews(null, form({}));
    expect(mocks.audit).toHaveBeenLastCalledWith("jr", expect.objectContaining({ target: "all-supported-routes" }));
    await requeueUnknownReviews(null, form({ routeId: "crawl-tagline" }));
    expect(mocks.requeue).toHaveBeenLastCalledWith(expect.objectContaining({ routeId: "crawl-tagline" }));
    mocks.requeue.mockClear(); mocks.values.mockClear();
    expect(await requeueUnknownReviews(null, form({ groupId: "m1", provider: "codex-cli" }))).toEqual({ ok: false, error: "단계·장비·도구 이름이 올바르지 않습니다." });
    expect(await requeueUnknownReviews(null, form({ groupId: "bad id;" }))).toMatchObject({ ok: false });
    expect(await requeueUnknownReviews(null, form({ routeId: "local-human-deepseek" }))).toEqual({ ok: false, error: "이 단계는 아직 다시 대기열에 넣기를 지원하지 않습니다." });
    expect(mocks.requeue).not.toHaveBeenCalled(); expect(mocks.values).not.toHaveBeenCalled();
  });
  it("관리자가 아니면 거절하고, 단계 처리 오류가 있으면 작업 로그를 실패로 남긴다", async () => {
    mocks.admin.mockResolvedValueOnce(null);
    expect(await requeueUnknownReviews(null, form({}))).toEqual({ ok: false, error: "관리자만 다시 대기열에 넣을 수 있습니다." });
    expect(mocks.requeue).not.toHaveBeenCalled();
    mocks.requeue.mockResolvedValueOnce({ ...result, groups: [{ ...result.groups[0], error: "deadlock detected" }] });
    await requeueUnknownReviews(null, form({}));
    expect(mocks.audit).toHaveBeenLastCalledWith("jr", expect.objectContaining({ ok: false, error: "some_routes_failed" }));
  });
});
