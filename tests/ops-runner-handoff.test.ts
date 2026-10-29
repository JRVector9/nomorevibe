import { beforeEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
const mocks = vi.hoisted(() => ({ fence: vi.fn(), values: vi.fn(), rows: { control: [] as unknown[], own: [] as unknown[], committed: [] as unknown[] }, queries: [] as string[] }));
const dialect = new PgDialect();
const tx = {
  execute: async (query: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(query); mocks.queries.push(text);
    if (text.includes("FROM model_capacity_control")) return mocks.rows.control;
    if (params.some(value => typeof value === "string" && value.endsWith(":draining"))) return mocks.rows.own;
    if (params.some(value => typeof value === "string" && value.endsWith(":handoff"))) return mocks.rows.committed;
    return [];
  },
  insert: () => ({ values: mocks.values }),
};
vi.mock("@/lib/db", () => ({ db: { transaction: (load: (t: unknown) => unknown) => load(tx) }, onPrimary: (load: () => unknown) => load() }));
vi.mock("@/lib/operations/admin-log", () => ({ adminAuditRow: async (actor: string, entry: object) => ({ actor, ...entry }) }));
vi.mock("@/lib/operations/dr/epoch", () => ({ writerSiteActive: mocks.fence }));
vi.mock("@/lib/operations/pipeline-control-repository", () => ({ runPipelineControl: vi.fn() }));
vi.mock("@/lib/operations/model-env", () => ({ currentModelEnv: vi.fn() }));
import { handOffOpsDrain, type CapacityPin } from "@/lib/operations/ops-runner/control";
import { initialOpsState } from "@/lib/operations/ops-runner/contract";

const state = { ...initialOpsState({ id: "ad2b84de-4ddf-4b2e-9dbd-605c64f7d728", action: "request-release", targetId: "65f8c399-ff4b-47bc-8f4d-6e4a682cf6a7",
  reason: "supa release then M1 + deploy in the same drain", confirmed: true }, "jr"), finalAdmission: "draining" as const };
const drained: CapacityPin = { mode: "draining", epoch: 1, revision: 8, policyHash: "p".repeat(64), updatedAt: "2026-10-29T12:00:00.123456Z" };
beforeEach(() => {
  vi.clearAllMocks(); mocks.queries.length = 0; mocks.fence.mockResolvedValue(true);
  mocks.rows = { control: [{ ...drained }], own: [{ detail: { after: { ...drained } } }], committed: [] };
});
it("자기가 커밋한 DRAIN 핀이 그대로일 때만 OPEN 없이 인계를 같은 TX에 감사 기록한다", async () => {
  expect(await handOffOpsDrain(state, drained)).toEqual({ ok: true });
  expect(mocks.queries.some(text => text.includes("FOR UPDATE"))).toBe(true);
  expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({ action: "ops-runner-control", target: `${state.id}:handoff`,
    detail: { after: drained, handoff: "draining", reason: state.reason } }));
  // No capacity transition: the control row is only read, never updated.
  expect(mocks.queries.some(text => /UPDATE\s+"?model_capacity_control/i.test(text))).toBe(false);
});
it("응답 유실 뒤 재실행은 같은 핀을 다시 확인만 하고 감사 행을 중복으로 쓰지 않는다", async () => {
  mocks.rows.committed = [{ id: 41 }];
  expect(await handOffOpsDrain(state, drained)).toEqual({ ok: true }); expect(mocks.values).not.toHaveBeenCalled();
});
it("다른 운영자가 만든 DRAIN이나 이 작업 뒤에 바뀐 control은 인계하지 않는다", async () => {
  mocks.rows.own = [];
  expect(await handOffOpsDrain(state, drained)).toEqual({ ok: false, code: "handoff_drain_not_owned" });
  mocks.rows.own = [{ detail: { after: { ...drained, revision: 7 } } }];
  expect(await handOffOpsDrain(state, drained)).toEqual({ ok: false, code: "handoff_drain_not_owned" });
  mocks.rows.own = [{ detail: { after: { ...drained } } }];
  mocks.rows.control = [{ ...drained, revision: 9 }];
  expect(await handOffOpsDrain(state, drained)).toEqual({ ok: false, code: "handoff_drain_changed" });
  mocks.rows.control = [{ ...drained, mode: "open" }];
  expect(await handOffOpsDrain(state, drained)).toEqual({ ok: false, code: "handoff_drain_changed" });
  expect(mocks.values).not.toHaveBeenCalled();
});
it("fenced DB에서는 인계 기록을 쓰지 않는다", async () => {
  mocks.fence.mockResolvedValue(false);
  await expect(handOffOpsDrain(state, drained)).rejects.toThrow("dr_writer_site_fenced"); expect(mocks.values).not.toHaveBeenCalled();
});
